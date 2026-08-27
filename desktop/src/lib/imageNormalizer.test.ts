// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PDFDocument } from 'pdf-lib';
import {
    appendImagePageToPdfDoc,
    imageBytesToPdfDoc,
    imageFileToPdfIfNeeded,
    imageFilesToPdfFile,
    isSupportedImageFileName,
    SUPPORTED_IMAGE_EXTENSIONS,
} from './imageNormalizer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const PNG_2X3_NO_DPI = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8////fwYGBgYmEIHCAABiCgQCEYu24wAAAABJRU5ErkJggg==';
// PNG RGBA 2×3, pHYs 300 DPI và iCCP chứa profile sRGB thật (LittleCMS/Pillow).
const PNG_2X3_RGB_ICC_300_DPI = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAABdWlDQ1BJQ0MgUHJvZmlsZQAAeJx1kbtLw1AUxn+NimIrDnVQcehQxaGCKIijVNBFHWoFX0sa+xCaGJIUKa6Ci4PgILr4GvwPdBVcFQRBEUScHX0tUuK5RqiIveHm/Pju/Q4nX0CbKBqmWz8CpuU5qfFkbHZuPtb4TBNhNKJ06IZrT06Ppam5Pm4JqXrTp3rVvvfvCi9lXQNCTcJDhu14wjINE6uerXhTuM0o6EvCB8IJRwYUvlR6JuAnxfmA3xQ76dQoaKpnLP+LM7/YKDimcK9w3CyWjJ951JdEstbMtNRO2V24pBgnSYwMJZYp4tEn1ZLM/vf1f/umWBGPIW+bMo448hTEmxC1JF2zUnOiZ+UpUla5/83TzQ0OBN0jSWh49P3XbmjchsqW738e+n7lCOoe4Nyq+lckp+F30beqWnwfWtfh9KKqZXbgbAPa723d0b+lOtlaLgcvJ9AyB9FraF4Isvo55/gO0mvyi65gdw965H7r4hfisWf82PfVZwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAABVJREFUeJxjFNGw2cLAwMDABCJQGAAcKAEygQHOVQAAAABJRU5ErkJggg==';
// Chunk pHYs hợp lệ: 1181 pixel/mét ≈ 30 DPI, unit=1, kèm CRC.
const PHYS_30_DPI_HEX = '00000009704859730000049d0000049d017c346ba1';
// TIFF little-endian 2×3, RGB, X/YResolution=300 và ResolutionUnit=inch.
const TIFF_2X3_300_DPI = 'SUkqAAgAAAANAAABBAABAAAAAgAAAAEBBAABAAAAAwAAAAIBAwADAAAAqgAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAABEBBAABAAAAwAAAABUBAwABAAAAAwAAABYBBAABAAAAAwAAABcBBAABAAAAEgAAABoBBQABAAAAsAAAABsBBQABAAAAuAAAABwBAwABAAAAAQAAACgBAwABAAAAAgAAAAAAAAAIAAgACAAsAQAAAQAAACwBAAABAAAAFCg8FCg8FCg8FCg8FCg8FCg8';

function fromBase64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function fromHex(value: string): Uint8Array {
    return Uint8Array.from(value.match(/../g) || [], pair => Number.parseInt(pair, 16));
}

function insertPhysChunk(png: Uint8Array): Uint8Array {
    // PNG signature (8) + IHDR length/type/data/CRC (25) = byte 33, ngay trước IDAT.
    const ihdrEnd = 33;
    const phys = fromHex(PHYS_30_DPI_HEX);
    const output = new Uint8Array(png.byteLength + phys.byteLength);
    output.set(png.subarray(0, ihdrEnd));
    output.set(phys, ihdrEnd);
    output.set(png.subarray(ihdrEnd), ihdrEnd + phys.byteLength);
    return output;
}

function withJfifDpi(jpeg: Uint8Array, dpi: number): Uint8Array {
    const output = jpeg.slice();
    output[13] = 1;
    output[14] = dpi >>> 8;
    output[15] = dpi & 0xff;
    output[16] = dpi >>> 8;
    output[17] = dpi & 0xff;
    return output;
}

function createMinimalRgbIccProfile(): Uint8Array {
    const profile = new Uint8Array(128);
    profile.set([0, 0, 0, 128], 0);
    writeAscii(profile, 16, 'RGB ');
    writeAscii(profile, 36, 'acsp');
    return profile;
}

function createMinimalCmykIccProfile(): Uint8Array {
    const profile = new Uint8Array(128);
    profile.set([0, 0, 0, 128], 0);
    writeAscii(profile, 16, 'CMYK');
    writeAscii(profile, 36, 'acsp');
    return profile;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
}

/** Gắn profile thật vào các APP2 segment như JPEG Photoshop của ca runtime. */
function insertJpegIccProfile(jpeg: Uint8Array, profile: Uint8Array): Uint8Array {
    const signatureBytes = 14; // "ICC_PROFILE\0" + sequence + count
    const maxPartBytes = 65_535 - 2 - signatureBytes;
    const partCount = Math.ceil(profile.byteLength / maxPartBytes);
    if (partCount < 1 || partCount > 255) throw new Error('Fixture ICC vượt giới hạn JPEG APP2.');

    const segments: Uint8Array[] = [];
    for (let index = 0; index < partCount; index++) {
        const part = profile.subarray(index * maxPartBytes, (index + 1) * maxPartBytes);
        const segmentLength = 2 + signatureBytes + part.byteLength;
        const segment = new Uint8Array(2 + segmentLength);
        segment[0] = 0xff;
        segment[1] = 0xe2;
        segment[2] = segmentLength >>> 8;
        segment[3] = segmentLength & 0xff;
        writeAscii(segment, 4, 'ICC_PROFILE\0');
        segment[16] = index + 1;
        segment[17] = partCount;
        segment.set(part, 18);
        segments.push(segment);
    }

    const segmentBytes = segments.reduce((sum, segment) => sum + segment.byteLength, 0);
    const output = new Uint8Array(jpeg.byteLength + segmentBytes);
    output.set(jpeg.subarray(0, 2));
    let offset = 2;
    for (const segment of segments) {
        output.set(segment, offset);
        offset += segment.byteLength;
    }
    output.set(jpeg.subarray(2), offset);
    return output;
}
describe('imageBytesToPdfDoc — khổ vật lý theo DPI', () => {
    it('có thể nhúng thẳng ảnh vào PDF đích mà không cần copyPages', async () => {
        const document = await PDFDocument.create();
        const page = await appendImagePageToPdfDoc(document, fromBase64(PNG_2X3_NO_DPI), 'direct.png');

        expect(document.getPageCount()).toBe(1);
        expect(page.getWidth()).toBe(2);
        expect(page.getHeight()).toBe(3);
    });

    it('đọc pHYs unit ở byte thứ 9 và đổi PNG 30 DPI sang points', async () => {
        const png = insertPhysChunk(fromBase64(PNG_2X3_NO_DPI));
        const document = await imageBytesToPdfDoc(png, 'a4-sample.png');
        const page = document.getPage(0);
        const dpi = 1181 * 0.0254;

        expect(page.getWidth()).toBeCloseTo((2 / dpi) * 72, 5);
        expect(page.getHeight()).toBeCloseTo((3 / dpi) * 72, 5);
    });

    it('giữ fallback 72 DPI cho PNG không có pHYs', async () => {
        const document = await imageBytesToPdfDoc(fromBase64(PNG_2X3_NO_DPI), 'no-dpi.png');
        const page = document.getPage(0);

        expect(page.getWidth()).toBe(2);
        expect(page.getHeight()).toBe(3);
    });

    it('đọc JFIF 300 DPI khi APP2 ICC đứng trước APP0', async () => {
        const jpeg = insertJpegIccProfile(
            withJfifDpi(fromBase64(JPG_2X3_NO_DPI), 300),
            createMinimalRgbIccProfile(),
        );
        const document = await imageBytesToPdfDoc(jpeg, 'jfif-sau-app2.jpg');
        const page = document.getPage(0);

        expect(page.getWidth()).toBeCloseTo(0.48, 5);
        expect(page.getHeight()).toBeCloseTo(0.72, 5);
    });

    it('đọc TIFF little-endian 300 DPI để giữ đúng khổ vật lý', async () => {
        tauriWindow.__TAURI_INTERNALS__ = {};
        invokeMock.mockResolvedValue(fromBase64(PNG_2X3_NO_DPI));
        const document = await imageBytesToPdfDoc(
            fromBase64(TIFF_2X3_300_DPI),
            'scan.tiff',
        );
        const page = document.getPage(0);

        expect(page.getWidth()).toBeCloseTo(0.48, 5);
        expect(page.getHeight()).toBeCloseTo(0.72, 5);
    });

    it('giữ ICCBased N=3, alpha và khổ 300 DPI trong PDF fallback', async () => {
        const document = await imageBytesToPdfDoc(
            fromBase64(PNG_2X3_RGB_ICC_300_DPI),
            'upscaled-icc.png',
        );
        const pdfBytes = await document.save({ useObjectStreams: false });
        const serialized = new TextDecoder('latin1').decode(pdfBytes);
        const page = document.getPage(0);

        expect(serialized).toContain('/ICCBased');
        expect(serialized).toMatch(/\/N\s+3\b/);
        expect(serialized).toContain('/SMask');
        expect(page.getWidth()).toBeCloseTo((2 / 300) * 72, 3);
        expect(page.getHeight()).toBeCloseTo((3 / 300) * 72, 3);
        await expect(PDFDocument.load(pdfBytes)).resolves.toBeDefined();
    });
});
const JPG_2X3_NO_DPI = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';
// JPEG CMYK 2×3, bốn kênh, chưa có APP2 ICC.
const JPG_CMYK_2X3_NO_ICC = '/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/8AAFAgAAwACBEMRAE0RAFkRAEsRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAA4EQwBNAFkASwAAPwD9U6ZX5VV+lFf/2Q==';

const invokeMock = vi.mocked(invoke);
const tauriWindow = window as Window & { __TAURI_INTERNALS__?: Record<string, never> };

async function readFileArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

async function readPdfFile(file: File): Promise<PDFDocument> {
    return PDFDocument.load(await readFileArrayBuffer(file));
}

afterEach(() => {
    delete tauriWindow.__TAURI_INTERNALS__;
    invokeMock.mockReset();
    vi.restoreAllMocks();
});

describe('imageFileToPdfIfNeeded — chuỗi ảnh → PDF cho viewer', () => {
    it.each([
        'scan.png', 'scan.JPG', 'scan.jpeg', 'scan.webp', 'scan.BMP', 'scan.tif', 'scan.TIFF',
    ])('nhận đúng định dạng ảnh toàn cục: %s', (name) => {
        expect(isSupportedImageFileName(name)).toBe(true);
    });

    it('giữ nguyên file không phải ảnh và không đọc bytes', async () => {
        const source = new File(['%PDF'], 'sample.pdf', { type: 'application/pdf' });
        const readBytes = vi.fn();

        await expect(imageFileToPdfIfNeeded(source, readBytes)).resolves.toBe(source);
        expect(readBytes).not.toHaveBeenCalled();
        expect(SUPPORTED_IMAGE_EXTENSIONS).toHaveLength(7);
    });

    it.each([
        ['png', PNG_2X3_NO_DPI, 'image/png'],
        ['jpg', JPG_2X3_NO_DPI, 'image/jpeg'],
        ['jpeg', JPG_2X3_NO_DPI, 'image/jpeg'],
    ] as const)('chuyển %s thành PDF một trang parse được', async (extension, fixture, mime) => {
        const bytes = fromBase64(fixture);
        const source = new File([bytes as unknown as BlobPart], `ảnh tiếng Việt.${extension}`, { type: mime });
        const output = await imageFileToPdfIfNeeded(source, async () => bytes);
        const document = await readPdfFile(output);

        expect(output.name).toBe('ảnh tiếng Việt.pdf');
        expect(output.type).toBe('application/pdf');
        expect(document.getPageCount()).toBe(1);
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('giữ JPEG CMYK path-backed cùng ICC ở ICCBased N=4', async () => {
        const profile = createMinimalCmykIccProfile();
        expect(new TextDecoder('ascii').decode(profile.subarray(16, 20))).toBe('CMYK');
        const sourceBytes = insertJpegIccProfile(fromBase64(JPG_CMYK_2X3_NO_ICC), profile);
        const source = new File([], 'mau-in-cmyk.jpg', { type: 'image/jpeg' });
        Object.defineProperty(source, 'path', { value: 'D:\\jobs\\mau-in-cmyk.jpg' });
        const readBytes = vi.fn(async (file: File) => {
            expect((file as File & { path?: string }).path).toBe('D:\\jobs\\mau-in-cmyk.jpg');
            return sourceBytes;
        });

        const output = await imageFileToPdfIfNeeded(source, readBytes);
        const pdfBytes = await readFileArrayBuffer(output);
        const serialized = new TextDecoder('latin1').decode(pdfBytes);

        expect(output.name).toBe('mau-in-cmyk.pdf');
        expect(readBytes).toHaveBeenCalledOnce();
        expect(readBytes).toHaveBeenCalledWith(source);
        expect(serialized).toContain('/ICCBased');
        expect(serialized).toMatch(/\/N\s+4\b/);
        expect(serialized).toContain('/Alternate /DeviceCMYK');
        expect(serialized).toContain('/DCTDecode');
        await expect(PDFDocument.load(pdfBytes)).resolves.toBeDefined();
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('nhận JPEG CMYK theo magic bytes dù tên file mang đuôi PNG', async () => {
        const profile = createMinimalCmykIccProfile();
        const sourceBytes = insertJpegIccProfile(fromBase64(JPG_CMYK_2X3_NO_ICC), profile);
        const source = new File([], 'mau-in-cmyk.png', { type: 'image/png' });

        const output = await imageFileToPdfIfNeeded(source, async () => sourceBytes);
        const pdfBytes = await readFileArrayBuffer(output);
        const serialized = new TextDecoder('latin1').decode(pdfBytes);

        expect(serialized).toContain('/DCTDecode');
        expect(serialized).toContain('/ICCBased');
        expect(serialized).toMatch(/\/N\s+4\b/);
        expect(serialized).toContain('/Alternate /DeviceCMYK');
        expect(serialized).toMatch(/\/Decode\s*\[\s*1\s+0\s+1\s+0\s+1\s+0\s+1\s+0\s*\]/);
        expect(invokeMock).not.toHaveBeenCalled();
        await expect(PDFDocument.load(pdfBytes)).resolves.toBeDefined();
    });
    it.each(['webp', 'bmp', 'tif', 'tiff'])('chuẩn hóa %s qua decoder native rồi tạo PDF parse được', async (extension) => {
        tauriWindow.__TAURI_INTERNALS__ = {};
        const normalizedPng = fromBase64(PNG_2X3_NO_DPI);
        invokeMock.mockResolvedValue(normalizedPng);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const sourceBytes = new Uint8Array([0x01, 0x02, 0x03]);
        const source = new File([sourceBytes as unknown as BlobPart], `sample.${extension}`);

        const output = await imageFileToPdfIfNeeded(source, async () => sourceBytes);
        const document = await readPdfFile(output);

        expect(output.name).toBe('sample.pdf');
        expect(document.getPageCount()).toBe(1);
        expect(invokeMock).toHaveBeenCalledWith('normalize_image_bytes', { bytes: sourceBytes });
    });

    it('ném lỗi terminal khi decoder native không đọc được ảnh hỏng', async () => {
        tauriWindow.__TAURI_INTERNALS__ = {};
        const decoderCause = new Error('RUST_DECODER_SENTINEL');
        invokeMock.mockRejectedValue(decoderCause);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const corrupt = new Uint8Array([0x00, 0x01]);
        const source = new File([corrupt as unknown as BlobPart], 'hong.webp');

        let thrown: unknown;
        try {
            await imageFileToPdfIfNeeded(source, async () => corrupt);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain('RUST_DECODER_SENTINEL');
        expect((thrown as Error).message).not.toContain('not a PNG file');
        expect((thrown as Error & { cause?: unknown }).cause).toBe(decoderCause);
    });

    it('chặn output native sai signature trước khi gọi embedPng', async () => {
        tauriWindow.__TAURI_INTERNALS__ = {};
        invokeMock.mockResolvedValue(new Uint8Array([0x01, 0x02, 0x03]));
        const webpHeader = Uint8Array.from([
            0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
            0x57, 0x45, 0x42, 0x50,
        ]);
        const source = new File([], 'native-output.webp', { type: 'image/webp' });

        await expect(imageFileToPdfIfNeeded(source, async () => webpHeader))
            .rejects.toThrow('không phải PNG hợp lệ');
    });

    it.each([
        {
            label: 'WebP',
            name: 'anh-ngoai-tauri.webp',
            bytes: Uint8Array.from([
                0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
                0x57, 0x45, 0x42, 0x50,
            ]),
        },
        {
            label: 'TIFF',
            name: 'scan-ngoai-tauri.tiff',
            bytes: fromBase64(TIFF_2X3_300_DPI),
        },
    ])('$label ngoài Tauri báo cần decoder desktop và không đưa bytes gốc vào embedPng', async ({
        name,
        bytes,
    }) => {
        delete tauriWindow.__TAURI_INTERNALS__;
        const embedPngSpy = vi.spyOn(PDFDocument.prototype, 'embedPng');
        const source = new File([], name);

        await expect(imageFileToPdfIfNeeded(source, async () => bytes))
            .rejects.toThrow('cần bộ giải mã của ứng dụng desktop');

        expect(embedPngSpy).not.toHaveBeenCalled();
        expect(invokeMock).not.toHaveBeenCalled();
    });
});

describe('imageFilesToPdfFile — nhiều ảnh dùng chung Viewer/thumbnail', () => {
    it('giữ đúng thứ tự ảnh, định dạng JPG/PNG và DPI riêng từng trang', async () => {
        const pngNoDpi = fromBase64(PNG_2X3_NO_DPI);
        const png30Dpi = insertPhysChunk(pngNoDpi);
        const jpgNoDpi = fromBase64(JPG_2X3_NO_DPI);
        const files = [
            new File([], 'trang-1.png', { type: 'image/png' }),
            new File([], 'trang-2.JPG', { type: 'image/jpeg' }),
            new File([], 'trang-3.png', { type: 'image/png' }),
        ];
        const bytesByName: Record<string, Uint8Array> = {
            'trang-1.png': pngNoDpi,
            'trang-2.JPG': jpgNoDpi,
            'trang-3.png': png30Dpi,
        };
        const readBytes = vi.fn(async (file: File) => bytesByName[file.name]);

        const output = await imageFilesToPdfFile(files, readBytes);
        const document = await readPdfFile(output);
        const dpi30 = 1181 * 0.0254;

        expect(output.name).toBe('3_anh_nhieu_tem.pdf');
        expect(output.type).toBe('application/pdf');
        expect(document.getPageCount()).toBe(3);
        expect(readBytes.mock.calls.map(([file]) => file.name)).toEqual([
            'trang-1.png', 'trang-2.JPG', 'trang-3.png',
        ]);
        expect(document.getPage(0).getSize()).toEqual({ width: 2, height: 3 });
        expect(document.getPage(1).getSize()).toEqual({ width: 2, height: 3 });
        expect(document.getPage(2).getWidth()).toBeCloseTo((2 / dpi30) * 72, 5);
        expect(document.getPage(2).getHeight()).toBeCloseTo((3 / dpi30) * 72, 5);
    });

    it('giữ fallback 72 DPI và từ chối đầu vào rỗng/không hỗ trợ', async () => {
        const png = fromBase64(PNG_2X3_NO_DPI);
        const output = await imageFilesToPdfFile(
            [new File([], 'khong-dpi.png', { type: 'image/png' })],
            async () => png,
        );
        const document = await readPdfFile(output);

        expect(output.name).toBe('khong-dpi.pdf');
        expect(document.getPage(0).getSize()).toEqual({ width: 2, height: 3 });
        await expect(imageFilesToPdfFile([])).rejects.toThrow('Chưa có ảnh');
        await expect(imageFilesToPdfFile([new File([], 'anh.gif')]))
            .rejects.toThrow('Định dạng ảnh chưa được hỗ trợ');
    });
});
