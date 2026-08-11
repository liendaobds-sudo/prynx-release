import { describe, expect, it } from 'vitest';

import {
    buildColorManagedPlateCompositeOverlay,
    buildDisplayedPagePlateOverlays,
    buildPagePlateOverlays,
    getOutputPreviewOverlayOpacity,
    getVisibleOutputPreviewPageBoxOverlays,
    getVisiblePlateOverlaysForPage,
    usesPlateMultiplyBlend,
    type OutputPreviewPageBoxes,
} from './outputPreviewOverlay';

const PAGE_BOXES: OutputPreviewPageBoxes = {
    viewerPageNum: 2,
    sourcePageNum: 7,
    cropbox: { x0: 10, y0: 20, x1: 110, y1: 70, width: 100, height: 50 },
    trimbox: { x0: 20, y0: 30, x1: 90, y1: 60, width: 70, height: 30 },
    bleedbox: { x0: 15, y0: 25, x1: 100, y1: 65, width: 85, height: 40 },
    artbox: { x0: 25, y0: 35, x1: 80, y1: 55, width: 55, height: 20 },
    has_trimbox: true,
    has_bleedbox: true,
    has_artbox: false,
    rotation: 0,
};

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

    it('giữ nguyên bitmap Viewer khi tất cả bản kẽm đang bật', () => {
        const overlays = buildDisplayedPagePlateOverlays(
            [
                { name: 'Cyan', color: [0, 174, 239], dataUrl: 'cyan' },
                { name: 'Black', color: [0, 0, 0], dataUrl: 'black' },
            ],
            new Set(['Cyan', 'Black']),
            null,
            { viewerPageNum: 1, sourcePageNum: 1, pixelWidth: 1200, pixelHeight: 900 },
        );

        expect(overlays).toEqual([]);
    });

    it('vẫn giữ khung preview khi bỏ hết bản kẽm để hiện trang trắng', () => {
        const overlays = buildDisplayedPagePlateOverlays(
            [
                { name: 'Cyan', color: [0, 174, 239], dataUrl: 'cyan' },
                { name: 'Black', color: [0, 0, 0], dataUrl: 'black' },
            ],
            new Set(),
            null,
            { viewerPageNum: 2, sourcePageNum: 2, pixelWidth: 1200, pixelHeight: 900 },
        );

        expect(overlays).toHaveLength(2);
        expect(overlays.every(plate => plate.visible === false)).toBe(true);
    });

    it('chỉ dựng lớp phủ khi người dùng thay đổi tập bản kẽm', () => {
        const overlays = buildDisplayedPagePlateOverlays(
            [
                { name: 'Cyan', color: [0, 174, 239], dataUrl: 'cyan' },
                { name: 'Black', color: [0, 0, 0], dataUrl: 'black' },
            ],
            new Set(['Black']),
            null,
            { viewerPageNum: 3, sourcePageNum: 3, pixelWidth: 1200, pixelHeight: 900 },
        );

        expect(getVisiblePlateOverlaysForPage(overlays, 3).map(plate => plate.name))
            .toEqual(['Black']);
    });

    it('đánh dấu composite ICC để Viewer không multiply lần thứ hai', () => {
        const overlays = buildColorManagedPlateCompositeOverlay(
            'blob:subset-cmyk',
            { viewerPageNum: 3, sourcePageNum: 7, pixelWidth: 1559, pixelHeight: 1169 },
        );

        expect(overlays).toEqual([expect.objectContaining({
            dataUrl: 'blob:subset-cmyk',
            displayMode: 'color-managed-composite',
            visible: true,
            pageNum: 3,
            sourcePageNum: 7,
        })]);
        expect(getVisiblePlateOverlaysForPage(overlays, 2)).toEqual([]);
        expect(getVisiblePlateOverlaysForPage(overlays, 3)).toHaveLength(1);
        expect(usesPlateMultiplyBlend(overlays[0])).toBe(false);
        expect(usesPlateMultiplyBlend({ ...overlays[0], displayMode: 'plate-multiply' })).toBe(true);
    });

    it('chỉ áp dụng độ mờ cảnh báo cho Gamut, TAC và diff Overprint', () => {
        expect(getOutputPreviewOverlayOpacity('gamut-warning', 0.35, false)).toBe(0.35);
        expect(getOutputPreviewOverlayOpacity('tac-heatmap', 0.35, false)).toBe(0.35);
        expect(getOutputPreviewOverlayOpacity('overprint', 0.35, true)).toBe(0.35);
        expect(getOutputPreviewOverlayOpacity('overprint', 0.35, false)).toBe(1);
        expect(getOutputPreviewOverlayOpacity('soft-proof', 0.35, true)).toBe(1);
    });

    it('chặn opacity cảnh báo ngoài miền hợp lệ tại biên hiển thị', () => {
        expect(getOutputPreviewOverlayOpacity('gamut-warning', -1, false)).toBe(0);
        expect(getOutputPreviewOverlayOpacity('tac-heatmap', 2, false)).toBe(1);
        expect(getOutputPreviewOverlayOpacity('overprint', Number.NaN, true)).toBe(1);
    });

    it('chỉ dựng PageBox được khai báo thật và thuộc đúng trang Viewer', () => {
        expect(getVisibleOutputPreviewPageBoxOverlays(PAGE_BOXES, 1, true)).toEqual([]);
        expect(getVisibleOutputPreviewPageBoxOverlays(PAGE_BOXES, 2, false)).toEqual([]);
        expect(getVisibleOutputPreviewPageBoxOverlays(PAGE_BOXES, 2, true)).toEqual([
            {
                kind: 'bleedbox',
                rect: { x0: 0.05, y0: 0.1, x1: 0.9, y1: 0.9 },
            },
            {
                kind: 'trimbox',
                rect: { x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.8 },
            },
        ]);
    });

    it('đổi PageBox PDF dưới-trái sang trang đã xoay 90 độ', () => {
        const overlays = getVisibleOutputPreviewPageBoxOverlays(
            { ...PAGE_BOXES, rotation: 90 },
            2,
            true,
        );

        expect(overlays.find(overlay => overlay.kind === 'trimbox')?.rect).toEqual({
            x0: 0.2,
            y0: 0.1,
            x1: 0.8,
            y1: 0.8,
        });
    });

    it('kẹp box lớn vào CropBox nhìn thấy và loại hình học suy biến', () => {
        const overlays = getVisibleOutputPreviewPageBoxOverlays({
            ...PAGE_BOXES,
            has_artbox: true,
            artbox: { x0: 0, y0: 0, x1: 120, y1: 80, width: 120, height: 80 },
            trimbox: { x0: 20, y0: 30, x1: 20, y1: 60, width: 0, height: 30 },
        }, 2, true);

        expect(overlays.find(overlay => overlay.kind === 'artbox')?.rect).toEqual({
            x0: 0,
            y0: 0,
            x1: 1,
            y1: 1,
        });
        expect(overlays.some(overlay => overlay.kind === 'trimbox')).toBe(false);
    });
});
