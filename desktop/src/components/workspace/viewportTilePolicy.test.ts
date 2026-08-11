import { describe, expect, it, vi } from 'vitest';

import {
    computeViewportTilePanGridSpecs,
    computeViewportTileCrossfadeMs,
    computeViewportTileSpec,
    createViewportTileRetirementScheduler,
    createRafCoalescer,
    mapRotatedViewportToPage,
    reduceViewportTileBuffer,
    sameViewportTileSpec,
    type ViewportTileBufferState,
    VIEWPORT_TILE_RUNWAY_PAD,
    viewportTileBufferItems,
    viewportTileBufferGroup,
    viewportTileCoversViewport,
    viewportTilePresentationItems,
} from './viewportTilePolicy';
import {
    accurateViewerRasterDpr,
    accurateViewerRequestScale,
} from '../../hooks/viewer/useTileRenderer';

describe('viewport tile — ánh xạ khung nhìn qua phép xoay CSS', () => {
    const rect = { left: 10, top: 20, right: 110, bottom: 220 };

    it.each([
        [0, { left: 10, top: 20, right: 110, bottom: 220 }],
        [90, { left: 20, top: 690, right: 220, bottom: 790 }],
        [180, { left: 490, top: 580, right: 590, bottom: 780 }],
        [270, { left: 380, top: 10, right: 580, bottom: 110 }],
        [-90, { left: 380, top: 10, right: 580, bottom: 110 }],
    ])('đưa góc %i° về đúng hệ trang chưa xoay', (rotation, expected) => {
        expect(mapRotatedViewportToPage(rect, 600, 800, rotation)).toEqual(expected);
    });

    it('ánh xạ toàn bộ bounding box xoay 90° về toàn bộ trang gốc', () => {
        expect(mapRotatedViewportToPage(
            { left: 0, top: 0, right: 800, bottom: 600 },
            600,
            800,
            90,
        )).toEqual({ left: 0, top: 0, right: 600, bottom: 800 });
    });
});

describe('viewport tile — snap, pad và TILE_MAX', () => {
    it('không raster runway thừa khi đã có first-paint đủ nét ở dưới', () => {
        const input = {
            rotatedViewport: { left: 500, top: 600, right: 1460, bottom: 1140 },
            pageWidth: 3000,
            pageHeight: 3000,
            rotation: 0,
            dpr: 2,
            pad: VIEWPORT_TILE_RUNWAY_PAD,
            snap: 64,
            maxTile: 4000,
        };
        const current = computeViewportTileSpec(input);
        const withoutRunway = computeViewportTileSpec({ ...input, pad: 0 });
        const legacy = computeViewportTileSpec({ ...input, pad: 256, snap: 256 });

        expect(current).not.toBeNull();
        expect(withoutRunway).not.toBeNull();
        expect(legacy).not.toBeNull();
        const final = current!;
        // Tile cuối vẫn chứa trọn vùng nhìn thật ở hệ device pixel.
        expect(final.clipX).toBeLessThanOrEqual(500 * 2);
        expect(final.clipY).toBeLessThanOrEqual(600 * 2);
        expect(final.clipX + final.clipW).toBeGreaterThanOrEqual(1460 * 2);
        expect(final.clipY + final.clipH).toBeGreaterThanOrEqual(1140 * 2);
        expect(VIEWPORT_TILE_RUNWAY_PAD).toBe(0);
        // Snap chỉ được dư dưới một ô 64 px mỗi cạnh; không thêm raster dự phòng.
        expect((500 * 2) - final.clipX).toBeLessThan(64);
        expect((600 * 2) - final.clipY).toBeLessThan(64);
        expect((final.clipX + final.clipW) - (1460 * 2)).toBeLessThan(64);
        expect((final.clipY + final.clipH) - (1140 * 2)).toBeLessThan(64);
        expect(final.clipW * final.clipH).toBe(withoutRunway!.clipW * withoutRunway!.clipH);
        expect(final.clipW * final.clipH).toBeLessThan((legacy!.clipW * legacy!.clipH) * 0.5);
    });

    it('atlas nền phủ thêm một màn hình và giữ cell ổn định khi pan', () => {
        const rotatedViewport = { left: 1500, top: 1600, right: 2460, bottom: 2140 };
        const input = {
            rotatedViewport,
            pageWidth: 5000,
            pageHeight: 5000,
            rotation: 0,
            dpr: 2,
            cellSize: 768,
            maxTile: 4000,
        };
        const initial = computeViewportTilePanGridSpecs({
            ...input,
            tier: 'full',
        });
        const shifted = computeViewportTilePanGridSpecs({
            ...input,
            rotatedViewport: { left: 1700, top: 1750, right: 2660, bottom: 2290 },
            tier: 'full',
        });
        const initialKeys = new Set(initial.map(spec => spec.key));
        const reusedKeys = shifted.filter(spec => initialKeys.has(spec.key));
        const minX = Math.min(...initial.map(spec => spec.clipX));
        const minY = Math.min(...initial.map(spec => spec.clipY));
        const maxX = Math.max(...initial.map(spec => spec.clipX + spec.clipW));
        const maxY = Math.max(...initial.map(spec => spec.clipY + spec.clipH));

        expect(initial.length).toBeGreaterThan(1);
        expect(initial.every(spec => spec.clipW <= 768 && spec.clipH <= 768)).toBe(true);
        expect(minX).toBeLessThanOrEqual((rotatedViewport.left - 960) * input.dpr);
        expect(minY).toBeLessThanOrEqual((rotatedViewport.top - 540) * input.dpr);
        expect(maxX).toBeGreaterThanOrEqual((rotatedViewport.right + 960) * input.dpr);
        expect(maxY).toBeGreaterThanOrEqual((rotatedViewport.bottom + 540) * input.dpr);
        expect(reusedKeys.length).toBeGreaterThan(initial.length / 2);
    });

    it('máy ít RAM chỉ giảm vòng cell dựng trước, không đổi kích thước cell/DPI', () => {
        const input = {
            rotatedViewport: { left: 500, top: 600, right: 1460, bottom: 1140 },
            pageWidth: 3000,
            pageHeight: 3000,
            rotation: 0,
            dpr: 2,
            cellSize: 768,
            maxTile: 4000,
        };
        const low = computeViewportTilePanGridSpecs({ ...input, tier: 'low' });
        const mid = computeViewportTilePanGridSpecs({ ...input, tier: 'mid' });
        const full = computeViewportTilePanGridSpecs({ ...input, tier: 'full' });
        const unknown = computeViewportTilePanGridSpecs({ ...input, tier: undefined });

        expect(low.length).toBeLessThanOrEqual(mid.length);
        expect(mid.length).toBeLessThan(full.length);
        expect(unknown.map(spec => spec.key)).toEqual(full.map(spec => spec.key));
        expect([...low, ...mid, ...full].every(
            spec => spec.clipW <= 768 && spec.clipH <= 768,
        )).toBe(true);
    });

    it('cùng DPI bucket tạo cùng identity dù raw zoom và CSS size khác nhau', () => {
        const reuseGroup = 'file:page:accurate:rot0';
        const highZoom = 2.10;
        const nearbyLowerZoom = 2.04;
        const baseWidth = 1000;
        const baseHeight = 700;
        const high = viewportTileBufferGroup(
            reuseGroup,
            accurateViewerRequestScale(highZoom),
            baseWidth * highZoom,
            baseHeight * highZoom,
            accurateViewerRasterDpr(highZoom, 1),
        );
        const lower = viewportTileBufferGroup(
            reuseGroup,
            accurateViewerRequestScale(nearbyLowerZoom),
            baseWidth * nearbyLowerZoom,
            baseHeight * nearbyLowerZoom,
            accurateViewerRasterDpr(nearbyLowerZoom, 1),
        );

        expect(lower).toBe(high);
    });

    it('tạo clip device-pixel và vị trí CSS khớp 1:1', () => {
        const spec = computeViewportTileSpec({
            rotatedViewport: { left: 100, top: 200, right: 500, bottom: 700 },
            pageWidth: 600,
            pageHeight: 800,
            rotation: 0,
            dpr: 2,
            pad: 256,
            snap: 256,
            maxTile: 4000,
        });

        expect(spec).toEqual({
            clipX: 0,
            clipY: 0,
            clipW: 1200,
            clipH: 1600,
            cssLeft: 0,
            cssTop: 0,
            cssW: 600,
            cssH: 800,
            key: '0:0:1200:1600',
        });
    });

    it('giữ tile tối đa quanh tâm vùng nhìn và không vượt biên trang', () => {
        const spec = computeViewportTileSpec({
            rotatedViewport: { left: 2000, top: 2200, right: 3000, bottom: 3000 },
            pageWidth: 5000,
            pageHeight: 5000,
            rotation: 0,
            dpr: 1,
            pad: 256,
            snap: 256,
            maxTile: 1024,
        });

        expect(spec).not.toBeNull();
        expect(spec!.clipW).toBe(1024);
        expect(spec!.clipH).toBe(1024);
        expect(spec!.clipX).toBeGreaterThanOrEqual(0);
        expect(spec!.clipY).toBeGreaterThanOrEqual(0);
        expect(spec!.clipX + spec!.clipW).toBeLessThanOrEqual(5000);
        expect(spec!.clipY + spec!.clipH).toBeLessThanOrEqual(5000);
    });

    it('trang xoay 90° vẫn trả clip trong hệ trang gốc', () => {
        const spec = computeViewportTileSpec({
            rotatedViewport: { left: 0, top: 0, right: 300, bottom: 200 },
            pageWidth: 600,
            pageHeight: 800,
            rotation: 90,
            dpr: 1,
            pad: 0,
            snap: 1,
            maxTile: 4000,
        });

        expect(spec).toMatchObject({ clipX: 0, clipY: 500, clipW: 200, clipH: 300 });
    });

    it('DPI bucket phân số vẫn tạo clip nguyên và kẹp theo raster đã round', () => {
        const dpr = 4 / 3;
        const pageWidth = 595.3;
        const pageHeight = 841.7;
        const spec = computeViewportTileSpec({
            rotatedViewport: { left: 0, top: 0, right: pageWidth, bottom: pageHeight },
            pageWidth,
            pageHeight,
            rotation: 0,
            dpr,
            pad: 256,
            snap: 256,
            maxTile: 4000,
        });

        expect(spec).not.toBeNull();
        expect(Number.isInteger(spec!.clipX)).toBe(true);
        expect(Number.isInteger(spec!.clipY)).toBe(true);
        expect(Number.isInteger(spec!.clipW)).toBe(true);
        expect(Number.isInteger(spec!.clipH)).toBe(true);
        expect(spec!.clipX + spec!.clipW).toBeLessThanOrEqual(Math.round(pageWidth * dpr));
        expect(spec!.clipY + spec!.clipH).toBeLessThanOrEqual(Math.round(pageHeight * dpr));
    });

    it('chỉ coi tile đổi khi clip thật sự đổi', () => {
        const a = { clipX: 0, clipY: 0, clipW: 512, clipH: 512, cssLeft: 0, cssTop: 0, cssW: 512, cssH: 512, key: '0:0:512:512' };
        expect(sameViewportTileSpec(a, { ...a })).toBe(true);
        expect(sameViewportTileSpec(a, { ...a, clipX: 256, key: '256:0:512:512' })).toBe(false);
        expect(sameViewportTileSpec(null, null)).toBe(true);
    });
});

describe('viewport tile — gom sự kiện theo requestAnimationFrame', () => {
    it('nhiều scroll trong cùng frame chỉ đo layout một lần', () => {
        let pending: FrameRequestCallback | null = null;
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            pending = callback;
            return 7;
        });
        const cancelFrame = vi.fn();
        const measure = vi.fn();
        const coalescer = createRafCoalescer(requestFrame, cancelFrame, measure);

        coalescer.schedule();
        coalescer.schedule();
        coalescer.schedule();
        expect(requestFrame).toHaveBeenCalledTimes(1);
        expect(measure).not.toHaveBeenCalled();

        const frame = pending as FrameRequestCallback | null;
        if (!frame) throw new Error('frame chưa được lên lịch');
        frame(16);
        expect(measure).toHaveBeenCalledTimes(1);

        coalescer.schedule();
        expect(requestFrame).toHaveBeenCalledTimes(2);
        coalescer.cancel();
        expect(cancelFrame).toHaveBeenCalledWith(7);
    });
});

describe('viewport tile — double buffer khi pan', () => {
    const item = (key: string, bufferGroup = 'zoom:4', reuseGroup?: string) => ({
        key,
        bufferGroup,
        reuseGroup,
    });

    it('giữ A khi B/C đang tải và bỏ callback B đã lỗi thời', () => {
        let state = { visible: null, target: null } as {
            visible: ReturnType<typeof item> | null;
            target: ReturnType<typeof item> | null;
        };
        state = reduceViewportTileBuffer(state, { type: 'target', item: item('A') });
        state = reduceViewportTileBuffer(state, { type: 'ready', key: 'A' });
        state = reduceViewportTileBuffer(state, { type: 'target', item: item('B') });
        expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['A', 'B']);

        state = reduceViewportTileBuffer(state, { type: 'target', item: item('C') });
        expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['A', 'C']);
        const beforeStaleReady = state;
        state = reduceViewportTileBuffer(state, { type: 'ready', key: 'B' });
        expect(state).toBe(beforeStaleReady);

        state = reduceViewportTileBuffer(state, { type: 'ready', key: 'C' });
        expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['C']);
    });

    it('giữ tile sắc cũ khi zoom đổi nhưng vẫn là cùng trang/pipeline', () => {
        let state: {
            visible: ReturnType<typeof item> | null;
            target: ReturnType<typeof item> | null;
        } = {
            visible: item('A', 'zoom:4', 'file:page:accurate:rot0'),
            target: item('A', 'zoom:4', 'file:page:accurate:rot0'),
        };
        state = reduceViewportTileBuffer(state, {
            type: 'target',
            item: item('D', 'zoom:3.9', 'file:page:accurate:rot0'),
        });

        expect(state.visible?.key).toBe('A');
        expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['A', 'D']);
    });

    it('vẫn bỏ tile cũ khi đổi file, pipeline hoặc phép xoay', () => {
        let state: {
            visible: ReturnType<typeof item> | null;
            target: ReturnType<typeof item> | null;
        } = {
            visible: item('A', 'zoom:4', 'file:page:accurate:rot0'),
            target: item('A', 'zoom:4', 'file:page:accurate:rot0'),
        };
        state = reduceViewportTileBuffer(state, {
            type: 'target',
            item: item('D', 'zoom:3.9', 'file:page:accurate:rot90'),
        });

        expect(state.visible).toBeNull();
        expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['D']);
    });

    it('không ẩn tile đã nét trong lúc zoom đang settle hoặc chờ target mới', () => {
        const visible = item('A', 'zoom:4', 'file:page:accurate:rot0');
        const state = { visible, target: visible };

        expect(viewportTilePresentationItems(
            state,
            'zoom:3.9',
            'file:page:accurate:rot0',
            true,
        )).toEqual([visible]);
        expect(viewportTilePresentationItems(
            state,
            'zoom:3.9',
            'file:page:accurate:rot0',
            false,
        )).toEqual([visible]);
    });

    it('pan cùng mật độ vẫn giữ phần tile cũ đã nét khi target mới chưa sẵn sàng', () => {
        const reuseGroup = 'file:page:accurate:rot0';
        const visible = item('A', 'zoom:4', reuseGroup);
        const target = item('B', 'zoom:4', reuseGroup);

        expect(viewportTilePresentationItems(
            { visible, target },
            'zoom:4',
            reuseGroup,
            false,
            false,
        )).toEqual([visible, target]);
    });

    it('zoom-out thiếu coverage thì không trình bày tile cũ thành một đảo nét', () => {
        const reuseGroup = 'file:page:accurate:rot0';
        const visible = {
            ...item('A', 'zoom:4', reuseGroup),
            cssLeft: 280,
            cssTop: 180,
            cssW: 640,
            cssH: 440,
            sourceDisplayWidth: 1200,
            sourceDisplayHeight: 800,
        };
        const target = item('B', 'zoom:3.5', reuseGroup);
        const covers = viewportTileCoversViewport(
            visible,
            { left: 200, top: 125, right: 800, bottom: 542 },
            1000,
            666,
            1000,
            666,
        );

        expect(covers).toBe(false);
        expect(viewportTilePresentationItems(
            { visible, target },
            'zoom:3.5',
            reuseGroup,
            false,
            covers,
        )).toEqual([target]);
    });

    it('zoom-out nhỏ còn nằm trong runway thì tiếp tục giữ tile cũ', () => {
        const reuseGroup = 'file:page:accurate:rot0';
        const visible = {
            ...item('A', 'zoom:4', reuseGroup),
            cssLeft: 280,
            cssTop: 180,
            cssW: 640,
            cssH: 440,
            sourceDisplayWidth: 1200,
            sourceDisplayHeight: 800,
        };
        const target = item('B', 'zoom:3.9', reuseGroup);
        const covers = viewportTileCoversViewport(
            visible,
            { left: 240, top: 160, right: 760, bottom: 510 },
            1000,
            666,
            1000,
            666,
        );

        expect(covers).toBe(true);
        expect(viewportTilePresentationItems(
            { visible, target },
            'zoom:3.9',
            reuseGroup,
            false,
            covers,
        )).toEqual([visible, target]);
    });

    it('zoom-in vẫn giữ tile cũ khi viewport mới nằm trọn bên trong', () => {
        const reuseGroup = 'file:page:accurate:rot0';
        const visible = {
            ...item('A', 'zoom:4', reuseGroup),
            cssLeft: 280,
            cssTop: 180,
            cssW: 640,
            cssH: 440,
            sourceDisplayWidth: 1200,
            sourceDisplayHeight: 800,
        };
        const target = item('B', 'zoom:5', reuseGroup);
        const covers = viewportTileCoversViewport(
            visible,
            { left: 420, top: 280, right: 980, bottom: 650 },
            1400,
            933,
            1400,
            933,
        );

        expect(covers).toBe(true);
        expect(viewportTilePresentationItems(
            { visible, target },
            'zoom:5',
            reuseGroup,
            false,
            covers,
        )).toEqual([visible, target]);
    });
});

describe('viewport tile — coverage qua phép xoay', () => {
    it.each([0, 90, 180, 270])('phủ đủ bốn cạnh viewport ở góc %i°', rotation => {
        const pageWidth = 600;
        const pageHeight = 800;
        const outerWidth = rotation === 90 || rotation === 270 ? pageHeight : pageWidth;
        const outerHeight = rotation === 90 || rotation === 270 ? pageWidth : pageHeight;
        const rotatedViewport = {
            left: outerWidth * 0.2,
            top: outerHeight * 0.25,
            right: outerWidth * 0.8,
            bottom: outerHeight * 0.75,
        };
        const required = mapRotatedViewportToPage(
            rotatedViewport,
            pageWidth,
            pageHeight,
            rotation,
        );
        const spec = computeViewportTileSpec({
            rotatedViewport,
            pageWidth,
            pageHeight,
            rotation,
            dpr: 2,
            pad: VIEWPORT_TILE_RUNWAY_PAD,
            snap: 64,
            maxTile: 4000,
        });
        expect(spec).not.toBeNull();
        const tile = {
            ...spec!,
            sourceDisplayWidth: pageWidth,
            sourceDisplayHeight: pageHeight,
        };

        expect(viewportTileCoversViewport(
            tile,
            required,
            pageWidth,
            pageHeight,
            pageWidth,
            pageHeight,
        )).toBe(true);
        expect(viewportTileCoversViewport(
            { ...tile, cssW: required.right - tile.cssLeft - 2 },
            required,
            pageWidth,
            pageHeight,
            pageWidth,
            pageHeight,
        )).toBe(false);
    });
});

describe('viewport tile — hòa trộn mờ → nét', () => {
    const item = (key: string, renderScale: number) => ({
        key,
        bufferGroup: `zoom:${renderScale}`,
        reuseGroup: 'file:page:accurate:rot0',
        renderScale,
    });

    it('điều chỉnh thời gian theo chênh lệch mật độ và tôn trọng reduced-motion', () => {
        expect(computeViewportTileCrossfadeMs(null, 4, false)).toBe(160);
        expect(computeViewportTileCrossfadeMs(4, 4, false)).toBe(80);
        expect(computeViewportTileCrossfadeMs(4, 8, false)).toBe(160);
        expect(computeViewportTileCrossfadeMs(4, 4.5, false)).toBeGreaterThan(80);
        expect(computeViewportTileCrossfadeMs(4, 4.5, false)).toBeLessThan(160);
        expect(computeViewportTileCrossfadeMs(4, 8, true)).toBe(0);
    });

    it('giữ tile cũ tới hết transition và callback lặp chỉ retire một lần', () => {
        vi.useFakeTimers();
        try {
            let state: ViewportTileBufferState<ReturnType<typeof item>> = {
                visible: item('A', 4),
                target: item('B', 8),
            };
            const retired = vi.fn((key: string) => {
                state = reduceViewportTileBuffer(state, { type: 'ready', key });
            });
            const scheduler = createViewportTileRetirementScheduler();

            scheduler.schedule('B', 120, retired);
            scheduler.schedule('B', 120, retired);
            expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['A', 'B']);

            vi.advanceTimersByTime(119);
            expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['A', 'B']);
            vi.advanceTimersByTime(1);

            expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['B']);
            expect(retired).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hủy retire của target cũ khi một mức zoom mới đến giữa transition', () => {
        vi.useFakeTimers();
        try {
            let state: ViewportTileBufferState<ReturnType<typeof item>> = {
                visible: item('A', 4),
                target: item('B', 6),
            };
            const retired = vi.fn((key: string) => {
                state = reduceViewportTileBuffer(state, { type: 'ready', key });
            });
            const scheduler = createViewportTileRetirementScheduler();
            scheduler.schedule('B', 120, retired);

            state = reduceViewportTileBuffer(state, { type: 'target', item: item('C', 8) });
            scheduler.cancelExcept('C');
            vi.advanceTimersByTime(120);

            expect(retired).not.toHaveBeenCalled();
            expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['A', 'C']);
            scheduler.schedule('C', 160, retired);
            vi.advanceTimersByTime(160);
            expect(viewportTileBufferItems(state).map(value => value.key)).toEqual(['C']);
        } finally {
            vi.useRealTimers();
        }
    });
});
