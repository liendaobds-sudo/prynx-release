import { invoke } from '@tauri-apps/api/core';
import type { PDFDocument, PDFImage, PDFPage } from 'pdf-lib';
import { isSupportedImageFileName } from './imageFileTypes';

export {
    imageFileExtension,
    isSupportedImageFileName,
    SUPPORTED_IMAGE_EXTENSIONS,
    type SupportedImageExtension,
} from './imageFileTypes';

type RasterFormat = 'jpeg' | 'png' | 'webp' | 'bmp' | 'tiff' | 'unknown';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngSignature(bytes: Uint8Array): boolean {
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function detectRasterFormat(bytes: Uint8Array): RasterFormat {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'jpeg';
    }
    if (bytes.length >= PNG_SIGNATURE.length && hasPngSignature(bytes)) return 'png';
    if (bytes.length >= 12
        && ascii(bytes, 0, 4) === 'RIFF'
        && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
    if (bytes.length >= 4 && (
        (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
        || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    )) return 'tiff';
    return 'unknown';
}

function shortErrorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.trim().slice(0, 240) || 'lỗi không xác định';
}

/**
 * Normalizes an arbitrary image file (e.g. CMYK JPEG, TIFF) into standard RGB PNG bytes.
 * This ensures that pdf-lib and Chrome's createImageBitmap can decode it safely.
 * @param bytes The raw image bytes (ArrayBuffer or Uint8Array)
 * @returns A promise resolving to the standard PNG bytes
 */
export async function normalizeImageToPngBytes(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof window === 'undefined'
        || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        throw new Error(
            'Định dạng ảnh này cần bộ giải mã của ứng dụng desktop; không thể âm thầm dùng bytes gốc.',
        );
    }
    try {
        const response = await invoke<Uint8Array | ArrayBuffer>('normalize_image_bytes', { bytes: u8 });
        const pngBytes = response instanceof Uint8Array ? response : new Uint8Array(response);
        if (!hasPngSignature(pngBytes)) {
            throw new Error('Bộ giải mã ảnh trả kết quả không phải PNG hợp lệ.');
        }
        return pngBytes;
    } catch (error) {
        // FILEIO (audit 2026-08-26 §IMG.B4): không trả bytes nguồn sai contract rồi
        // để embedPng che lỗi thật bằng “not a PNG”. Giữ stage + cause để UI chẩn đoán.
        throw new Error(`Bộ giải mã ảnh không xử lý được dữ liệu: ${shortErrorText(error)}`, {
            cause: error,
        });
    }
}

const MAX_EMBEDDED_ICC_BYTES = 16 * 1024 * 1024;

function readUint32BE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] * 0x1000000
        + bytes[offset + 1] * 0x10000
        + bytes[offset + 2] * 0x100
        + bytes[offset + 3];
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

type IccProfileDescriptor = {
    bytes: Uint8Array;
    components: 1 | 3 | 4;
    deviceColorSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK';
};

/**
 * Kiểm tra header ICC và giữ lại hệ màu để PDF không gắn nhầm số kênh.
 * JPEG CMYK là dữ liệu hợp lệ; profile CMYK phải đi cùng ICCBased /N 4.
 */
function validateIccProfile(profile: Uint8Array): IccProfileDescriptor {
    if (profile.byteLength < 128) {
        throw new Error('ICC trong ảnh bị thiếu header; không thể tạo PDF quản lý màu an toàn.');
    }
    const declaredSize = readUint32BE(profile, 0);
    if (declaredSize < 128 || declaredSize > profile.byteLength || declaredSize > MAX_EMBEDDED_ICC_BYTES) {
        throw new Error('Kích thước ICC trong ảnh không hợp lệ; đã dừng để tránh làm sai màu in.');
    }
    if (ascii(profile, 36, 4) !== 'acsp') {
        throw new Error('ICC trong ảnh không có chữ ký hợp lệ; đã dừng để tránh làm sai màu in.');
    }
    const colorSpace = ascii(profile, 16, 4).trim().toUpperCase();
    if (colorSpace === 'GRAY') {
        return { bytes: profile.slice(0, declaredSize), components: 1, deviceColorSpace: 'DeviceGray' };
    }
    if (colorSpace === 'RGB') {
        return { bytes: profile.slice(0, declaredSize), components: 3, deviceColorSpace: 'DeviceRGB' };
    }
    if (colorSpace === 'CMYK') {
        return { bytes: profile.slice(0, declaredSize), components: 4, deviceColorSpace: 'DeviceCMYK' };
    }
    // ICC LAB/XYZ và các profile khác không thể gắn lên XObject raster hiện tại
    // mà vẫn bảo toàn hợp đồng số kênh; dừng rõ ràng thay vì âm thầm đổi màu.
    throw new Error(`ICC của ảnh dùng hệ màu ${colorSpace || 'không rõ'} chưa được hỗ trợ.`);
}

async function inflateZlibBounded(compressed: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('Trình duyệt không hỗ trợ giải nén ICC; không thể âm thầm bỏ profile màu.');
    }
    const decompressor = new DecompressionStream('deflate');
    const writer = decompressor.writable.getWriter();
    const ownedInput = Uint8Array.from(compressed);
    const writing = writer.write(ownedInput as unknown as BufferSource).then(() => writer.close());
    const reader = decompressor.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_EMBEDDED_ICC_BYTES) {
            await reader.cancel();
            await writing.catch(() => undefined);
            throw new Error('ICC trong ảnh vượt giới hạn an toàn 16 MB.');
        }
        chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    await writing;
    return output;
}

async function readPngRgbIccProfile(bytes: Uint8Array): Promise<IccProfileDescriptor | null> {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.byteLength < 8 || signature.some((value, index) => bytes[index] !== value)) return null;

    let offset = 8;
    let foundProfile: IccProfileDescriptor | null = null;
    while (offset + 12 <= bytes.byteLength) {
        const length = readUint32BE(bytes, offset);
        const type = ascii(bytes, offset + 4, 4);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.byteLength) {
            throw new Error('PNG có chunk ICC bị cắt cụt; đã dừng để tránh làm sai màu in.');
        }
        if (type === 'iCCP') {
            if (foundProfile) throw new Error('PNG chứa nhiều hơn một ICC profile không hợp lệ.');
            let separator = dataStart;
            while (separator < dataEnd && bytes[separator] !== 0) separator++;
            if (separator === dataStart || separator >= dataEnd - 2 || separator - dataStart > 79) {
                throw new Error('PNG có iCCP header không hợp lệ.');
            }
            if (bytes[separator + 1] !== 0) {
                throw new Error('PNG dùng kiểu nén ICC không được hỗ trợ.');
            }
            const compressed = bytes.subarray(separator + 2, dataEnd);
            if (compressed.byteLength === 0 || compressed.byteLength > MAX_EMBEDDED_ICC_BYTES) {
                throw new Error('Dữ liệu ICC nén trong PNG không hợp lệ.');
            }
            foundProfile = validateIccProfile(await inflateZlibBounded(compressed));
            // pdf-lib luôn giải PNG thành XObject RGB; profile Gray/CMYK không thể
            // gắn lên ba kênh đó mà vẫn đúng màu.
            if (foundProfile.components !== 3) {
                throw new Error('ICC của PNG không phải RGB; đã dừng để tránh làm sai màu.');
            }
        }
        offset = dataEnd + 4;
        if (type === 'IEND') break;
    }
    return foundProfile;
}

function readJpegIccProfile(bytes: Uint8Array): IccProfileDescriptor | null {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const chunks = new Map<number, Uint8Array>();
    let expectedChunks = 0;
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
        if (bytes[offset] !== 0xff) break;
        const marker = bytes[offset + 1];
        offset += 2;
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.byteLength) break;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.byteLength) {
            throw new Error('JPEG có segment ICC bị cắt cụt.');
        }
        const dataStart = offset + 2;
        const dataEnd = offset + length;
        if (marker === 0xe2 && dataEnd - dataStart >= 14
            && ascii(bytes, dataStart, 12) === 'ICC_PROFILE\0') {
            const sequence = bytes[dataStart + 12];
            const count = bytes[dataStart + 13];
            if (sequence < 1 || count < 1 || sequence > count
                || (expectedChunks !== 0 && expectedChunks !== count)
                || chunks.has(sequence)) {
                throw new Error('JPEG có thứ tự segment ICC không hợp lệ.');
            }
            expectedChunks = count;
            chunks.set(sequence, bytes.slice(dataStart + 14, dataEnd));
        }
        offset = dataEnd;
    }
    if (expectedChunks === 0) return null;
    if (chunks.size !== expectedChunks) throw new Error('JPEG bị thiếu segment ICC.');
    const total = Array.from(chunks.values()).reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (total > MAX_EMBEDDED_ICC_BYTES) throw new Error('ICC trong JPEG vượt giới hạn an toàn 16 MB.');
    const profile = new Uint8Array(total);
    let profileOffset = 0;
    for (let sequence = 1; sequence <= expectedChunks; sequence++) {
        const chunk = chunks.get(sequence)!;
        profile.set(chunk, profileOffset);
        profileOffset += chunk.byteLength;
    }
    return validateIccProfile(profile);
}

async function readEmbeddedIccProfile(bytes: Uint8Array): Promise<IccProfileDescriptor | null> {
    return await readPngRgbIccProfile(bytes) ?? readJpegIccProfile(bytes);
}

async function attachIccProfile(
    doc: PDFDocument,
    image: PDFImage,
    profile: IccProfileDescriptor | null,
): Promise<void> {
    if (!profile) return;
    const { PDFName, PDFRawStream } = await import('pdf-lib');
    // Embed trước rồi thay ColorSpace trên XObject thật; không đụng private embedder
    // của pdf-lib và vẫn giữ nguyên SMask alpha do PngEmbedder tạo.
    await image.embed();
    const imageStream = doc.context.lookup(image.ref);
    if (!(imageStream instanceof PDFRawStream)) {
        throw new Error('Không tìm thấy XObject ảnh để gắn ICC profile.');
    }
    const imageColorSpace = imageStream.dict.lookupMaybe(PDFName.of('ColorSpace'), PDFName);
    if (!imageColorSpace || imageColorSpace.toString() !== `/${profile.deviceColorSpace}`) {
        throw new Error('ICC trong ảnh không khớp số kênh dữ liệu; đã dừng để tránh làm sai màu.');
    }
    const iccStream = doc.context.flateStream(profile.bytes, {
        N: profile.components,
        Alternate: profile.deviceColorSpace,
    });
    const iccRef = doc.context.register(iccStream);
    imageStream.dict.set(
        PDFName.of('ColorSpace'),
        doc.context.obj(['ICCBased', iccRef]),
    );
}

/**
 * Nhúng bytes ảnh (JPG/PNG) vào `doc` mà GIỮ NGUYÊN nén gốc: JPEG qua embedJpg (giữ
 * luồng DCT), PNG qua embedPng (giữ Flate). Đây là điểm mấu chốt tránh phình file —
 * đường cũ decode-lại-thành-PNG rồi embedPng biến JPEG (DCT lossy, gọn) thành bitmap
 * thô → phình 10-20 lần. Chỉ khi pdf-lib ném lỗi (biến thể không đọc được)
 * mới rơi về fallback normalize→RGB PNG qua Rust.
 */
export async function embedImagePreserveCompression(
    doc: PDFDocument,
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
): Promise<PDFImage> {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const sourceFormat = detectRasterFormat(buf);
    // COLOR (feedback 2026-08-26 §IMG.1): pdf-lib mặc định bỏ iCCP/APP2 ICC.
    // Giữ RGB ở /N 3 và JPEG CMYK ở /N 4 thay vì từ chối ảnh in hợp lệ.
    const sourceIcc = await readEmbeddedIccProfile(buf);
    if (sourceFormat === 'jpeg' || sourceFormat === 'png') {
        try {
            // FILEIO (audit 2026-08-26 §IMG.B6): codec theo magic bytes; tên file
            // chỉ là nhãn UX và không được làm JPEG CMYK hợp lệ rơi vào embedPng.
            const image = sourceFormat === 'jpeg'
                ? await doc.embedJpg(buf)
                : await doc.embedPng(buf);
            await attachIccProfile(doc, image, sourceIcc);
            return image;
        } catch (error) {
            if (sourceIcc) {
                throw new Error(
                    'Không thể bảo toàn ICC khi tạo PDF; kết quả ảnh vẫn được giữ để lưu riêng.',
                    { cause: error },
                );
            }
            console.warn('Nhúng ảnh gốc thất bại, dùng fallback normalize→PNG', fileName, error);
        }
    }
    const norm = await normalizeImageToPngBytes(buf);
    const normalizedIcc = await readEmbeddedIccProfile(norm);
    const image = await doc.embedPng(norm);
    await attachIccProfile(doc, image, normalizedIcc);
    return image;
}

/**
 * Đọc DPI (điểm/inch) từ header ảnh. Trả null nếu không chắc chắn → caller mặc định 72
 * (px == pt, đúng bằng hành vi cũ) nên KHÔNG gây regression cho ảnh không mang DPI.
 * JPEG: đọc APP0/JFIF; PNG: đọc chunk pHYs. Bỏ qua EXIF (hiếm, dễ đọc sai → cứ trả null).
 */
function readImageDpi(bytes: Uint8Array): { x: number; y: number } | null {
    try {
        const format = detectRasterFormat(bytes);
        if (format === 'jpeg') return readJpegJfifDpi(bytes);
        if (format === 'png') return readPngPhysDpi(bytes);
        if (format === 'tiff') return readTiffDpi(bytes);
        return null;
    } catch {
        return null;
    }
}

/**
 * Mật độ pixel/point mà PDF normalize đã dùng cho ảnh nguồn. Raster Working PDF
 * theo scale này giữ nguyên số pixel đầu vào trước khi Upscale; ảnh không có DPI
 * vẫn đúng quy ước cũ 1 px = 1 pt.
 */
// `fileName` được giữ trong signature công khai để không phá caller/recipe cũ; DPI
// nay đọc theo magic bytes nên tên không còn là nguồn quyết định.
export function sourceImagePixelsPerPdfPoint(
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
): number {
    void fileName;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dpi = readImageDpi(data);
    if (!dpi) return 1;
    const density = Math.max(dpi.x, dpi.y) / 72;
    return Number.isFinite(density) && density > 0 ? density : 1;
}

function readJpegJfifDpi(b: Uint8Array): { x: number; y: number } | null {
    // FILEIO (audit 2026-08-26 §IMG.B2): APP2 ICC/EXIF được phép đứng trước APP0.
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let offset = 2;
    while (offset < b.length) {
        if (b[offset] !== 0xff) return null;
        while (offset < b.length && b[offset] === 0xff) offset += 1;
        if (offset >= b.length) return null;
        const marker = b[offset];
        offset += 1;
        if (marker === 0xda || marker === 0xd9) return null;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (marker === 0x00 || offset + 2 > b.length) return null;
        const length = (b[offset] << 8) | b[offset + 1];
        if (length < 2 || offset + length > b.length) return null;
        const dataStart = offset + 2;
        const dataLength = length - 2;
        if (marker === 0xe0 && dataLength >= 14 && ascii(b, dataStart, 5) === 'JFIF\0') {
            const units = b[dataStart + 7];
            const densityX = (b[dataStart + 8] << 8) | b[dataStart + 9];
            const densityY = (b[dataStart + 10] << 8) | b[dataStart + 11];
            if (densityX <= 0 || densityY <= 0) return null;
            if (units === 1) return { x: densityX, y: densityY };
            if (units === 2) return { x: densityX * 2.54, y: densityY * 2.54 };
            return null;
        }
        offset += length;
    }
    return null;
}

function readTiffDpi(b: Uint8Array): { x: number; y: number } | null {
    if (b.length < 8) return null;
    const littleEndian = b[0] === 0x49 && b[1] === 0x49;
    const bigEndian = b[0] === 0x4d && b[1] === 0x4d;
    if (!littleEndian && !bigEndian) return null;

    const read16 = (offset: number): number | null => {
        if (offset < 0 || offset + 2 > b.length) return null;
        return littleEndian
            ? b[offset] | (b[offset + 1] << 8)
            : (b[offset] << 8) | b[offset + 1];
    };
    const read32 = (offset: number): number | null => {
        if (offset < 0 || offset + 4 > b.length) return null;
        return littleEndian
            ? (b[offset] + b[offset + 1] * 0x100 + b[offset + 2] * 0x10000 + b[offset + 3] * 0x1000000) >>> 0
            : (b[offset] * 0x1000000 + b[offset + 1] * 0x10000 + b[offset + 2] * 0x100 + b[offset + 3]) >>> 0;
    };
    if (read16(2) !== 42) return null;
    const ifdOffset = read32(4);
    if (ifdOffset === null) return null;
    const entryCount = read16(ifdOffset);
    if (entryCount === null || entryCount > 4096) return null;

    let xResolution: number | null = null;
    let yResolution: number | null = null;
    let resolutionUnit = 2; // TIFF 6.0: thiếu tag ResolutionUnit mặc định là inch.
    for (let index = 0; index < entryCount; index++) {
        const entryOffset = ifdOffset + 2 + index * 12;
        const tag = read16(entryOffset);
        const type = read16(entryOffset + 2);
        const count = read32(entryOffset + 4);
        if (tag === null || type === null || count === null || entryOffset + 12 > b.length) return null;
        if ((tag === 282 || tag === 283) && type === 5 && count === 1) {
            const valueOffset = read32(entryOffset + 8);
            if (valueOffset === null) return null;
            const numerator = read32(valueOffset);
            const denominator = read32(valueOffset + 4);
            if (numerator === null || denominator === null || denominator === 0) return null;
            const value = numerator / denominator;
            if (!Number.isFinite(value) || value <= 0) return null;
            if (tag === 282) xResolution = value;
            else yResolution = value;
        } else if (tag === 296 && type === 3 && count === 1) {
            const unit = read16(entryOffset + 8);
            if (unit === null) return null;
            resolutionUnit = unit;
        }
    }
    if (xResolution === null || yResolution === null || resolutionUnit === 1) return null;
    if (resolutionUnit === 2) return { x: xResolution, y: yResolution };
    if (resolutionUnit === 3) return { x: xResolution * 2.54, y: yResolution * 2.54 };
    return null;
}

function readPngPhysDpi(b: Uint8Array): { x: number; y: number } | null {
    // PNG signature 8 byte, sau đó là các chunk: len(4 BE) + type(4) + data + crc(4)
    const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
    let off = 8;
    while (off + 8 <= b.length) {
        const len = b[off] * 0x1000000 + b[off + 1] * 0x10000 + b[off + 2] * 0x100 + b[off + 3];
        const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
        const data = off + 8;
        const chunkEnd = data + len;
        if (chunkEnd + 4 > b.length) return null;
        if (type === 'pHYs') {
            if (len !== 9) return null;
            const ppuX = b[data] * 0x1000000 + b[data + 1] * 0x10000 + b[data + 2] * 0x100 + b[data + 3];
            const ppuY = b[data + 4] * 0x1000000 + b[data + 5] * 0x10000 + b[data + 6] * 0x100 + b[data + 7];
            // PDF (audit 2026-08-01 §B.2): pHYs chỉ có 9 byte data; unit nằm ở byte 9.
            const unit = b[data + 8];
            if (unit === 1 && ppuX > 0 && ppuY > 0) {
                // pixel / mét → DPI (1 inch = 0.0254 m)
                return { x: ppuX * 0.0254, y: ppuY * 0.0254 };
            }
            return null;
        }
        if (type === 'IDAT' || type === 'IEND') return null; // pHYs (nếu có) luôn đứng trước IDAT
        off = chunkEnd + 4; // bỏ qua data + crc
    }
    return null;
}

/**
 * Khổ trang (points) cho 1 ảnh: quy đổi pixel → điểm theo DPI thật của ảnh. Không có DPI
 * → mặc định 72 (px == pt) giữ nguyên hành vi cũ. Nhờ vậy ảnh scan 300 DPI (2480px) ra
 * đúng khổ A4 (~595pt) thay vì trang khổng lồ 2480pt.
 */
function imagePagePoints(img: PDFImage, bytes: Uint8Array): [number, number] {
    const dpi = readImageDpi(bytes);
    const dpiX = dpi && dpi.x > 0 ? dpi.x : 72;
    const dpiY = dpi && dpi.y > 0 ? dpi.y : 72;
    return [(img.width / dpiX) * 72, (img.height / dpiY) * 72];
}

/**
 * Nhúng ảnh trực tiếp thành một trang trong tài liệu đích. Đường Combine dùng helper
 * này để tránh tạo PDF trung gian rồi `copyPages()` — bước copy đó chiếm phần lớn thời
 * gian với PNG lớn dù dữ liệu ảnh vẫn giữ nguyên nén.
 */
export async function appendImagePageToPdfDoc(
    doc: PDFDocument,
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
): Promise<PDFPage> {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const img = await embedImagePreserveCompression(doc, buf, fileName);
    const [pw, ph] = imagePagePoints(img, buf);
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    return page;
}

/**
 * Ảnh (JPG/PNG) → PDFDocument 1 trang (giữ nén gốc, khổ theo DPI). Dùng chung cho mọi
 * luồng cần chuyển ảnh sang PDF (mở file, ghép, chèn, đóng dấu…).
 */
export async function imageBytesToPdfDoc(
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
): Promise<PDFDocument> {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    await appendImagePageToPdfDoc(doc, bytes, fileName);
    return doc;
}

export type ImageFileBytesReader = (file: File) => Promise<ArrayBuffer | Uint8Array>;

/**
 * Ghép danh sách ảnh thành một PDF nhiều trang theo đúng thứ tự picker. Mỗi ảnh chỉ
 * được đọc và nhúng một lần; `readBytes` cho phép caller đọc cả File path-stub của
 * Tauri thay vì phụ thuộc vào `File.arrayBuffer()` rỗng.
 */
export async function imageFilesToPdfFile(
    files: readonly File[],
    readBytes: ImageFileBytesReader = source => source.arrayBuffer(),
): Promise<File> {
    if (files.length === 0) {
        throw new Error('Chưa có ảnh để tạo tài liệu nhiều trang.');
    }
    const unsupported = files.find(file => !isSupportedImageFileName(file.name));
    if (unsupported) {
        throw new Error(`Định dạng ảnh chưa được hỗ trợ: ${unsupported.name || 'không rõ tên'}.`);
    }

    const { PDFDocument } = await import('pdf-lib');
    const document = await PDFDocument.create();
    for (const file of files) {
        const bytes = await readBytes(file);
        await appendImagePageToPdfDoc(document, bytes, file.name || 'image');
    }

    const pdfBytes = await document.save();
    const outputName = files.length === 1
        ? (files[0].name || 'image').replace(/\.(?:jpe?g|png|webp|bmp|tiff?)$/i, '.pdf')
        : `${files.length}_anh_nhieu_tem.pdf`;
    return new File([pdfBytes as unknown as BlobPart], outputName, { type: 'application/pdf' });
}

/**
 * FILEIO (audit 2026-08-02 §TEST.1): chuẩn hóa mọi ảnh mà cửa mở file hỗ trợ thành
 * PDF một trang trước khi giao cho workspace. `readBytes` cho phép file path-stub của
 * Tauri đọc từ đĩa; file thường vẫn dùng `File.arrayBuffer()`.
 */
export async function imageFileToPdfIfNeeded(
    file: File,
    readBytes: ImageFileBytesReader = source => source.arrayBuffer(),
): Promise<File> {
    if (!isSupportedImageFileName(file.name)) return file;

    const bytes = await readBytes(file);
    const document = await imageBytesToPdfDoc(bytes, file.name || 'image');
    const pdfBytes = await document.save();
    const pdfName = (file.name || 'image').replace(/\.(?:jpe?g|png|webp|bmp|tiff?)$/i, '.pdf');
    return new File([pdfBytes as unknown as BlobPart], pdfName, { type: 'application/pdf' });
}

/**
 * Nhúng ảnh làm 1 trang mới ngay trong `doc` đang có sẵn (giữ nén gốc, khổ theo DPI).
 * Dùng khi muốn thêm trang ảnh vào tài liệu đích mà không tạo doc trung gian.
 */
export async function addImagePageToDoc(
    doc: PDFDocument,
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
): Promise<void> {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const img = await embedImagePreserveCompression(doc, buf, fileName);
    const [pw, ph] = imagePagePoints(img, buf);
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
}
