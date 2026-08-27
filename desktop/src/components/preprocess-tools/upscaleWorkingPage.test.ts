// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getFileArrayBuffer: vi.fn(),
    getDocument: vi.fn(),
    getPage: vi.fn(),
    getViewport: vi.fn(),
    render: vi.fn(),
    cancel: vi.fn(),
    destroy: vi.fn(),
}));

vi.mock('../../lib/utils', () => ({
    getFileArrayBuffer: mocks.getFileArrayBuffer,
}));
vi.mock('pdfjs-dist', () => ({
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: mocks.getDocument,
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
    default: 'pdf.worker.js',
}));

import { rasterizeUpscaleWorkingPage } from './upscaleWorkingPage';
import { sourceImagePixelsPerPdfPoint } from '../../lib/imageNormalizer';

const JPG_2X3_NO_DPI = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z';

function jfifAfterApp2At300Dpi(): Uint8Array {
    const source = Uint8Array.from(atob(JPG_2X3_NO_DPI), char => char.charCodeAt(0));
    source[13] = 1;
    source.set([0x01, 0x2c, 0x01, 0x2c], 14);
    const app2 = Uint8Array.from([0xff, 0xe2, 0x00, 0x04, 0x49, 0x43]);
    const output = new Uint8Array(source.byteLength + app2.byteLength);
    output.set(source.subarray(0, 2));
    output.set(app2, 2);
    output.set(source.subarray(2), 2 + app2.byteLength);
    return output;
}

const originalGetContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext',
);

describe('rasterizeUpscaleWorkingPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getFileArrayBuffer.mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer);
        mocks.getViewport.mockImplementation(({ scale }: { scale: number }) => ({
            width: 80 * scale,
            height: 120 * scale,
        }));
        mocks.render.mockReturnValue({
            promise: Promise.resolve(),
            cancel: mocks.cancel,
        });
        mocks.getPage.mockResolvedValue({
            getViewport: mocks.getViewport,
            render: mocks.render,
        });
        mocks.destroy.mockResolvedValue(undefined);
        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 3,
                getPage: mocks.getPage,
            }),
            destroy: mocks.destroy,
        });
        const context2d = {} as CanvasRenderingContext2D;
        Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
            configurable: true,
            value: vi.fn((contextId: string) => contextId === '2d' ? context2d : null),
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
            callback(new Blob(['png'], { type: 'image/png' }));
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (originalGetContext) {
            Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext);
        } else {
            Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext');
        }
    });

    it('raster đúng vị trí Working page ở 72 DPI và giữ rotation nội tại của PDF', async () => {
        const workingFile = new File(['pdf'], 'tai-lieu-working.pdf', {
            type: 'application/pdf',
        });

        const result = await rasterizeUpscaleWorkingPage(workingFile, 99, undefined, 300 / 72);

        expect(mocks.getFileArrayBuffer).toHaveBeenCalledWith(workingFile);
        expect(mocks.getPage).toHaveBeenCalledWith(3);
        // Không truyền rotation=0 vì quick-rotate đã bake vào /Rotate.
        expect(mocks.getViewport).toHaveBeenCalledWith({ scale: 300 / 72 });
        expect(result).toMatchObject({
            name: 'tai-lieu-working_trang_3.png',
            type: 'image/png',
        });
        expect(mocks.destroy).toHaveBeenCalledTimes(1);
    });

    it('đọc JFIF 300 DPI thành đúng mật độ pixel/point, ảnh không metadata giữ scale 1', () => {
        const jpeg = new Uint8Array(20);
        jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], 0);
        jpeg[13] = 1;
        jpeg[14] = 0x01;
        jpeg[15] = 0x2c;
        jpeg[16] = 0x01;
        jpeg[17] = 0x2c;

        expect(sourceImagePixelsPerPdfPoint(jpeg, 'scan.jpg')).toBeCloseTo(300 / 72, 8);
        expect(sourceImagePixelsPerPdfPoint(new Uint8Array([1, 2, 3]), 'anh.png')).toBe(1);
    });

    it('đọc JFIF nằm sau APP2 để upscale không mất mật độ ảnh nguồn', () => {
        expect(sourceImagePixelsPerPdfPoint(jfifAfterApp2At300Dpi(), 'scan.jpg'))
            .toBeCloseTo(300 / 72, 8);
    });

    it('không đọc Working PDF nếu lượt chạy đã bị hủy', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(rasterizeUpscaleWorkingPage(
            new File(['pdf'], 'tai-lieu.pdf', { type: 'application/pdf' }),
            1,
            controller.signal,
        )).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.getFileArrayBuffer).not.toHaveBeenCalled();
        expect(mocks.getDocument).not.toHaveBeenCalled();
    });
});
