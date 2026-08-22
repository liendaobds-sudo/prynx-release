// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createThumbnailRenderRequest,
    getThumbCache,
    subscribeThumbCache,
    thumbCacheRef,
} from '../workspace/thumbnailCache';
import {
    ensurePdfJsThumbnail,
    getPdfJsThumbnailDocument,
    registerPdfJsThumbnailDocument,
} from '../../hooks/viewer/usePdfLoader';
import { isCrossFileThumbDrop } from './useThumbSidebar';

function makePdfPage() {
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    return {
        render,
        getViewport: ({ scale }: { scale: number }) => ({
            width: 595 * scale,
            height: 842 * scale,
        }),
    };
}

describe('pipeline thumbnail PDF.js', () => {
    afterEach(() => {
        thumbCacheRef.current.clear();
        vi.restoreAllMocks();
    });

    it.each([
        [1, 127, 160],
        [1.25, 159, 200],
        [1.5, 190, 239],
        [2, 253, 319],
    ])('dùng cùng key và pixel thật ở DPR %s', (dpr, pixelWidth, zoomMilli) => {
        const request = createThumbnailRenderRequest({
            revision: 'blob:55-pages',
            pageNum: 31,
            pageWidthPx96: 595 * 96 / 72,
            cssWidth: 110,
            devicePixelRatio: dpr,
        });

        expect(request).toMatchObject({ pixelWidth, zoomMilli });
        expect(request.cacheKey).toBe(`blob:55-pages_31_0_${zoomMilli}`);
    });

    it.each([31, 55])('render on-demand trực tiếp trang %s, không phụ thuộc warmup 30 trang', async pageNum => {
        const page = makePdfPage();
        const getPage = vi.fn(async () => page);
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
            .mockReturnValue(`data:image/jpeg;base64,page-${pageNum}`);
        const request = createThumbnailRenderRequest({
            revision: 'blob:55-pages',
            pageNum,
            pageWidthPx96: 595 * 96 / 72,
            cssWidth: 110,
            devicePixelRatio: 1.25,
        });
        const listener = vi.fn();
        const unsubscribe = subscribeThumbCache(request.cacheKey, listener);

        await ensurePdfJsThumbnail({ getPage }, pageNum, request);
        await ensurePdfJsThumbnail({ getPage }, pageNum, request);

        expect(getPage).toHaveBeenCalledTimes(1);
        expect(getPage).toHaveBeenCalledWith(pageNum);
        expect(page.render).toHaveBeenCalledTimes(1);
        expect(getThumbCache(request.cacheKey)).toBe(`data:image/jpeg;base64,page-${pageNum}`);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('đăng ký document theo đúng revision và không để cleanup cũ xóa document mới', () => {
        const first = { getPage: vi.fn() };
        const second = { getPage: vi.fn() };
        const releaseFirst = registerPdfJsThumbnailDocument('blob:revision', first as never);
        const releaseSecond = registerPdfJsThumbnailDocument('blob:revision', second as never);

        releaseFirst();
        expect(getPdfJsThumbnailDocument('blob:revision')).toBe(second);
        releaseSecond();
        expect(getPdfJsThumbnailDocument('blob:revision')).toBeUndefined();
    });

    it('phân biệt drop trong cùng sidebar với drop sang sidebar khác', () => {
        const source = document.createElement('div');
        const sourceChild = document.createElement('div');
        const target = document.createElement('div');
        source.appendChild(sourceChild);

        expect(isCrossFileThumbDrop(source, sourceChild)).toBe(false);
        expect(isCrossFileThumbDrop(source, target)).toBe(true);
        expect(isCrossFileThumbDrop(source, null)).toBe(false);
    });
});
