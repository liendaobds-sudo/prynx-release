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
        const jpeg = new Uint8Array(18);
        jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], 0);
        jpeg[13] = 1;
        jpeg[14] = 0x01;
        jpeg[15] = 0x2c;
        jpeg[16] = 0x01;
        jpeg[17] = 0x2c;

        expect(sourceImagePixelsPerPdfPoint(jpeg, 'scan.jpg')).toBeCloseTo(300 / 72, 8);
        expect(sourceImagePixelsPerPdfPoint(new Uint8Array([1, 2, 3]), 'anh.png')).toBe(1);
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
