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
    try {
        return isJpgName(fileName) ? await doc.embedJpg(buf) : await doc.embedPng(buf);
    } catch (e) {
        console.warn('Nhúng ảnh gốc thất bại, dùng fallback normalize→PNG', e);
        const norm = await normalizeImageToPngBytes(buf);
        return await doc.embedPng(norm);
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

type ImageFileBytesReader = (file: File) => Promise<ArrayBuffer | Uint8Array>;

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
