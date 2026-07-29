import { describe, expect, it } from 'vitest';

import {
    buildPagePlateOverlays,
    getVisiblePlateOverlaysForPage,
} from './outputPreviewOverlay';

describe('Output Preview — overlay theo từng trang', () => {
    it('giữ danh tính và kích thước pixel của trang nguồn', () => {
        const overlays = buildPagePlateOverlays(
            [{ name: 'Cyan', color: [0, 174, 239], dataUrl: 'data:image/png;base64,cyan' }],
            new Set(['Cyan']),
            null,
            { viewerPageNum: 4, sourcePageNum: 7, pixelWidth: 1200, pixelHeight: 600 },
        );

        expect(overlays).toEqual([expect.objectContaining({
            pageNum: 4,
            sourcePageNum: 7,
            pixelWidth: 1200,
            pixelHeight: 600,
            visible: true,
        })]);
    });

    it('không đưa ảnh trang này sang frame của trang khác', () => {
        const pageFour = buildPagePlateOverlays(
            [{ name: 'Black', color: [0, 0, 0], dataUrl: 'page-4' }],
            new Set(['Black']),
            null,
            { viewerPageNum: 4, sourcePageNum: 4, pixelWidth: 400, pixelHeight: 800 },
        );

        expect(getVisiblePlateOverlaysForPage(pageFour, 1)).toEqual([]);
        expect(getVisiblePlateOverlaysForPage(pageFour, 4)).toHaveLength(1);
    });

    it('chế độ xem riêng chỉ giữ đúng bản kẽm đã chọn', () => {
        const overlays = buildPagePlateOverlays(
            [
                { name: 'Cyan', color: [0, 174, 239], dataUrl: 'cyan' },
                { name: 'Black', color: [0, 0, 0], dataUrl: 'black' },
            ],
            new Set(['Cyan', 'Black']),
            'Black',
            { viewerPageNum: 2, sourcePageNum: 2, pixelWidth: 900, pixelHeight: 900 },
        );

        expect(getVisiblePlateOverlaysForPage(overlays, 2).map(plate => plate.name))
            .toEqual(['Black']);
    });
});
