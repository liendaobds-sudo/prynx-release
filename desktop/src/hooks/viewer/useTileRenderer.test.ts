// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    authenticatedFetch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: transportMocks.invoke,
}));

vi.mock('../../lib/api', () => ({
    authenticatedFetch: transportMocks.authenticatedFetch,
    getApiUrl: () => 'http://localhost:8321/api',
}));

import {
    ACCURATE_VIEWER_DPI_BUCKET,
    adjacentAccuratePages,
    accurateViewerDpi,
    progressiveViewerColorStages,
    shouldUseAccurateViewerRender,
    useTileRenderer,
} from './useTileRenderer';

describe('Viewer — định tuyến render màu chính xác', () => {
    beforeEach(() => {
        transportMocks.invoke.mockReset();
        transportMocks.authenticatedFetch.mockReset();
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => `blob:test-${Math.random()}`),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
    });

    it('chỉ dùng accurate path cho full-page thuộc danh sách detector', () => {
        expect(shouldUseAccurateViewerRender(true, [1, 4], 1, false, 'accurate')).toBe(true);
        expect(shouldUseAccurateViewerRender(true, [1, 4], 1, false, 'display')).toBe(false);
        expect(shouldUseAccurateViewerRender(true, [1, 4], 2, false, 'accurate')).toBe(false);
        expect(shouldUseAccurateViewerRender(true, [1, 4], 1, true, 'accurate')).toBe(false);
        expect(shouldUseAccurateViewerRender(false, [1, 4], 1, false, 'accurate')).toBe(false);
    });

    it('luôn hiện display trước rồi mới thay bằng accurate', () => {
        expect(progressiveViewerColorStages(false)).toEqual(['display']);
        expect(progressiveViewerColorStages(true)).toEqual(['display', 'accurate']);
    });

    it('đổi zoom PDFium sang DPI PPE cùng kích thước pixel', () => {
        expect(accurateViewerDpi(0.5)).toBe(48);
        expect(accurateViewerDpi(1)).toBe(96);
        expect(accurateViewerDpi(1.25)).toBe(120);
        expect(accurateViewerDpi(1.5)).toBe(144);
        expect(accurateViewerDpi(2)).toBe(192);
        expect(accurateViewerDpi(0.01)).toBe(24);
        expect(accurateViewerDpi(200)).toBe(9600);
    });

    it('dùng chung bucket cho các mức zoom gần nhau', () => {
        expect(accurateViewerDpi(1.01)).toBe(108);
        expect(accurateViewerDpi(1.12)).toBe(108);
        expect(accurateViewerDpi(1.126)).toBe(120);
    });

    it('bucket hợp lệ luôn đủ DPI và chỉ render dư dưới một nấc', () => {
        for (const zoomScale of [0.25, 0.51, 1.01, 1.124, 1.26, 2.03, 5.337, 24]) {
            const requestedDpi = 96 * zoomScale;
            const selectedDpi = accurateViewerDpi(zoomScale);
            expect(selectedDpi).toBeGreaterThanOrEqual(requestedDpi);
            expect(selectedDpi - requestedDpi).toBeLessThan(ACCURATE_VIEWER_DPI_BUCKET);
        }
    });

    it('chỉ chọn hai trang màu chính xác liền kề để dựng nền', () => {
        expect(adjacentAccuratePages(3, [1, 2, 3, 4, 8])).toEqual([4, 2]);
        expect(adjacentAccuratePages(1, [1, 2, 8])).toEqual([2]);
        expect(adjacentAccuratePages(5, [1, 2, 8])).toEqual([]);
    });

    it('dựng nền hai trang liền kề sau khi trang active hoàn tất', async () => {
        transportMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10]).buffer,
        } as Response);

        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 2,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1, 2, 3, 8],
        }));

        await act(async () => {
            await result.current.getTileUrl(
                2, 0, 1, undefined, undefined, undefined, undefined,
                { colorStage: 'accurate' },
            );
        });
        await waitFor(() => expect(transportMocks.authenticatedFetch).toHaveBeenCalledTimes(3));

        const requestedPages = transportMocks.authenticatedFetch.mock.calls.map(([, init]) => (
            JSON.parse(String((init as RequestInit).body)).page
        ));
        expect(requestedPages).toEqual([2, 3, 1]);
        unmount();
    });

    it('PPE chạy nền không giữ hàng đợi PDFium của trang kế tiếp', async () => {
        transportMocks.invoke.mockResolvedValue(new Uint8Array([137, 80, 78, 71]).buffer);
        let finishAccurate!: (response: Response) => void;
        transportMocks.authenticatedFetch.mockReturnValue(new Promise<Response>(resolve => {
            finishAccurate = resolve;
        }));

        const file = {
            path: 'D:\\jobs\\cmyk.pdf',
            name: 'cmyk.pdf',
            type: 'application/pdf',
        };
        const { result, unmount } = renderHook(() => useTileRenderer({
            file,
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1, 2],
        }));

        const accuratePromise = result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        );
        await waitFor(() => expect(transportMocks.authenticatedFetch).toHaveBeenCalledTimes(1));

        // PPE vẫn đang pending, nhưng ảnh display của trang 2 phải đi qua PDFium ngay.
        const display = await result.current.getTileUrl(
            2, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'display' },
        );
        expect(display.url).toMatch(/^blob:test-/);
        expect(transportMocks.invoke).toHaveBeenCalledWith('render_pdf_page', expect.objectContaining({
            page: 2,
        }));

        await act(async () => {
            finishAccurate({
                ok: true,
                arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10]).buffer,
            } as Response);
            await accuratePromise;
        });
        unmount();
    });
});
