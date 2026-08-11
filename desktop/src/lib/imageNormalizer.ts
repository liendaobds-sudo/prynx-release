import { invoke } from '@tauri-apps/api/core';
import type { PDFDocument, PDFImage, PDFPage } from 'pdf-lib';
import { isSupportedImageFileName } from './imageFileTypes';

export {
    imageFileExtension,
    isSupportedImageFileName,
    SUPPORTED_IMAGE_EXTENSIONS,
    type SupportedImageExtension,
} from './imageFileTypes';

/**
 * Normalizes an arbitrary image file (e.g. CMYK JPEG, TIFF) into standard RGB PNG bytes.
 * This ensures that pdf-lib and Chrome's createImageBitmap can decode it safely.
 * @param bytes The raw image bytes (ArrayBuffer or Uint8Array)
 * @returns A promise resolving to the standard PNG bytes
 */
export async function normalizeImageToPngBytes(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        // Fallback for non-Tauri environment (browser fallback)
        return new Uint8Array(bytes);
    }
    try {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        // Invoke Rust backend to decode the image safely
        const pngBytes: Uint8Array = await invoke('normalize_image_bytes', { bytes: u8 });
        return pngBytes;
    } catch (e) {
        console.error("Failed to normalize image via Rust backend, falling back to original", e);
        return new Uint8Array(bytes);
    }
}

function isJpgName(name: string): boolean {
    const n = (name || '').toLowerCase();
    return n.endsWith('.jpg') || n.endsWith('.jpeg');
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

function validateRgbIccProfile(profile: Uint8Array): Uint8Array {
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
    if (ascii(profile, 16, 4).trim().toUpperCase() !== 'RGB') {
        // pdf-lib giải PNG thành ba kênh RGB. Gắn Gray/LAB/CMYK lên ba kênh đó sẽ
        // tạo PDF sai contract; backend phải color-convert trước khi fallback này chạy.
        throw new Error('ICC của ảnh không phải RGB; cần backend chuyển màu trước khi tạo PDF.');
    }
    return profile.slice(0, declaredSize);
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

async function readPngRgbIccProfile(bytes: Uint8Array): Promise<Uint8Array | null> {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.byteLength < 8 || signature.some((value, index) => bytes[index] !== value)) return null;

    let offset = 8;
    let foundProfile: Uint8Array | null = null;
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
            foundProfile = validateRgbIccProfile(await inflateZlibBounded(compressed));
        }
        offset = dataEnd + 4;
        if (type === 'IEND') break;
    }
    return foundProfile;
}

function readJpegRgbIccProfile(bytes: Uint8Array): Uint8Array | null {
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
    return validateRgbIccProfile(profile);
}

async function readEmbeddedRgbIccProfile(bytes: Uint8Array): Promise<Uint8Array | null> {
    return await readPngRgbIccProfile(bytes) ?? readJpegRgbIccProfile(bytes);
}

async function attachRgbIccProfile(
    doc: PDFDocument,
    image: PDFImage,
    profile: Uint8Array | null,
): Promise<void> {
    if (!profile) return;
    const { PDFName, PDFRawStream } = await import('pdf-lib');
    const iccStream = doc.context.flateStream(profile, {
        N: 3,
        Alternate: 'DeviceRGB',
    });
    const iccRef = doc.context.register(iccStream);
    // Embed trước rồi thay ColorSpace trên XObject thật; không đụng private embedder
    // của pdf-lib và vẫn giữ nguyên SMask alpha do PngEmbedder tạo.
    await image.embed();
    const imageStream = doc.context.lookup(image.ref);
    if (!(imageStream instanceof PDFRawStream)) {
        throw new Error('Không tìm thấy XObject ảnh để gắn ICC profile.');
    }
    imageStream.dict.set(
        PDFName.of('ColorSpace'),
        doc.context.obj(['ICCBased', iccRef]),
    );
}

/**
 * Nhúng bytes ảnh (JPG/PNG) vào `doc` mà GIỮ NGUYÊN nén gốc: JPEG qua embedJpg (giữ
 * luồng DCT), PNG qua embedPng (giữ Flate). Đây là điểm mấu chốt tránh phình file —
 * đường cũ decode-lại-thành-PNG rồi embedPng biến JPEG (DCT lossy, gọn) thành bitmap
 * thô → phình 10-20 lần. Chỉ khi pdf-lib ném lỗi (CMYK JPEG / biến thể không đọc được)
 * mới rơi về fallback normalize→RGB PNG qua Rust.
 */
export async function embedImagePreserveCompression(
    doc: PDFDocument,
    bytes: ArrayBuffer | Uint8Array,
    fileName: string,
): Promise<PDFImage> {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // COLOR (audit 2026-08-11 §UP.X.06): pdf-lib mặc định bỏ iCCP/APP2 ICC và
    // ghi /DeviceRGB. Tách profile trước khi nhúng để fallback có /ICCBased /N 3.
    const sourceIcc = await readEmbeddedRgbIccProfile(buf);
    try {
        const image = isJpgName(fileName) ? await doc.embedJpg(buf) : await doc.embedPng(buf);
        await attachRgbIccProfile(doc, image, sourceIcc);
        return image;
    } catch (e) {
        if (sourceIcc) {
            throw new Error(
                'Không thể bảo toàn ICC khi tạo PDF; kết quả ảnh vẫn được giữ để lưu riêng.',
                { cause: e },
            );
        }
        console.warn('Nhúng ảnh gốc thất bại, dùng fallback normalize→PNG', e);
        const norm = await normalizeImageToPngBytes(buf);
        const normalizedIcc = await readEmbeddedRgbIccProfile(norm);
        const image = await doc.embedPng(norm);
        await attachRgbIccProfile(doc, image, normalizedIcc);
        return image;
    }
}

/**
 * Đọc DPI (điểm/inch) từ header ảnh. Trả null nếu không chắc chắn → caller mặc định 72
 * (px == pt, đúng bằng hành vi cũ) nên KHÔNG gây regression cho ảnh không mang DPI.
 * JPEG: đọc APP0/JFIF; PNG: đọc chunk pHYs. Bỏ qua EXIF (hiếm, dễ đọc sai → cứ trả null).
 */
function readImageDpi(bytes: Uint8Array, isJpg: boolean): { x: number; y: number } | null {
    try {
        return isJpg ? readJpegJfifDpi(bytes) : readPngPhysDpi(bytes);
    } catch {
        return null;
    }
}

function readJpegJfifDpi(b: Uint8Array): { x: number; y: number } | null {
    // SOI = FFD8, APP0 = FFE0 ngay sau, rồi "JFIF\0"
    if (b.length < 18 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    if (b[2] !== 0xff || b[3] !== 0xe0) return null;
    if (b[6] !== 0x4a || b[7] !== 0x46 || b[8] !== 0x49 || b[9] !== 0x46 || b[10] !== 0x00) return null;
    const units = b[13]; // 0 = không đơn vị (chỉ tỉ lệ), 1 = dpi, 2 = dpcm
    const xd = (b[14] << 8) | b[15];
    const yd = (b[16] << 8) | b[17];
    if (xd <= 0 || yd <= 0) return null;
    if (units === 1) return { x: xd, y: yd };
    if (units === 2) return { x: xd * 2.54, y: yd * 2.54 };
    return null; // units === 0: chỉ aspect ratio, không phải DPI thật
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
function imagePagePoints(img: PDFImage, bytes: Uint8Array, isJpg: boolean): [number, number] {
    const dpi = readImageDpi(bytes, isJpg);
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
    const [pw, ph] = imagePagePoints(img, buf, isJpgName(fileName));
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
    const [pw, ph] = imagePagePoints(img, buf, isJpgName(fileName));
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
}
