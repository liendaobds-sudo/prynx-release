// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PDFDocument } from 'pdf-lib';
import {
    appendImagePageToPdfDoc,
    imageBytesToPdfDoc,
    imageFileToPdfIfNeeded,
    isSupportedImageFileName,
    SUPPORTED_IMAGE_EXTENSIONS,
} from './imageNormalizer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const PNG_2X3_NO_DPI = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8////fwYGBgYmEIHCAABiCgQCEYu24wAAAABJRU5ErkJggg==';
// Chunk pHYs hợp lệ: 1181 pixel/mét ≈ 30 DPI, unit=1, kèm CRC.
const PHYS_30_DPI_HEX = '00000009704859730000049d0000049d017c346ba1';

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
});
const JPG_2X3_NO_DPI = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';

const invokeMock = vi.mocked(invoke);
const tauriWindow = window as Window & { __TAURI_INTERNALS__?: Record<string, never> };

async function readPdfFile(file: File): Promise<PDFDocument> {
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
    return PDFDocument.load(bytes);
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
        invokeMock.mockRejectedValue(new Error('corrupt image'));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const corrupt = new Uint8Array([0x00, 0x01]);
        const source = new File([corrupt as unknown as BlobPart], 'hong.webp');

        await expect(imageFileToPdfIfNeeded(source, async () => corrupt)).rejects.toThrow();
    });
});
