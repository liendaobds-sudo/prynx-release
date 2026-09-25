// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import { LiveTile, shouldSettleAccurateTarget, TileLayer } from './LivePageFrame';
import {
    shouldEnableViewerViewportAccurateTile,
    shouldMountViewerViewportLayer,
    shouldRenderViewerAccurateBaseTile,
    shouldRenderViewerBaseTile,
    shouldKeepViewerAccurateBaseMounted,
    shouldRequestViewerAccurateBase,
    shouldUseViewerDirectFullPageSurface,
    viewerPanGridRenderPolicy,
    viewerPageRenderPriority,
    VIEWER_RASTER_IMAGE_RENDERING,
    viewerSurfaceSwapMs,
} from './livePageFramePolicy';
import { cacheTileUrl, clearTileUrlCache, type TileUrlSource } from '../../lib/tileUrlCache';
import { CancelledTileRenderError } from '../../hooks/viewer/tileRenderScheduler';
import {
    VIEWER_DIRECT_FULL_PAGE_MAX_PIXELS,
} from './renderZoomPolicy';
import {
    viewerBootstrapUsesPpeForPageOne,
    viewerFirstFrameDpi,
    viewerFirstFrameMatchesTile,
    type ViewerFirstFrame,
} from '../../lib/viewerFirstFrame';

type GetTileUrl = (
    pageNum: number,
    rotation: number,
    zoomScale: number,
    clipX?: number,
    clipY?: number,
    clipW?: number,
    clipH?: number,
    requestOptions?: { colorStage?: string },
) => Promise<TileUrlSource>;

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearTileUrlCache();
    vi.restoreAllMocks();
});

describe('viewer first-frame pipeline policy', () => {
    it('pre-render trang 1 ở mode current khi detector yêu cầu PPE', () => {
        expect(viewerBootstrapUsesPpeForPageOne({
            viewerEngineMode: 'current',
            colorRisk: {
                highRisk: true,
                pages: [{ page: 1, accurateColorRecommended: true }],
            },
        })).toBe(true);
        expect(viewerBootstrapUsesPpeForPageOne({
            viewerEngineMode: 'current',
            colorRisk: {
                highRisk: true,
                pages: [{ page: 2, accurateColorRecommended: true }],
            },
        })).toBe(false);
        expect(viewerBootstrapUsesPpeForPageOne({
            viewerEngineMode: 'current',
            colorRisk: {
                highRisk: false,
                pages: [{ page: 1, accurateColorRecommended: true }],
            },
        })).toBe(false);
        expect(viewerBootstrapUsesPpeForPageOne({ viewerEngineMode: 'hybrid' })).toBe(true);
        expect(viewerBootstrapUsesPpeForPageOne({ viewerEngineMode: 'ppe-only' })).toBe(true);
    });

    it('chỉ settle target accurate khi đã có first-frame và params mới khác params đã tải', () => {
        expect(shouldSettleAccurateTarget({
            accurateOnly: true,
            adoptedInitialFrame: true,
            hasLoadedOnce: true,
            loadedParams: 'frame-56',
            currentParams: 'frame-92',
        })).toBe(true);
        expect(shouldSettleAccurateTarget({
            accurateOnly: true,
            adoptedInitialFrame: true,
            hasLoadedOnce: true,
            loadedParams: 'frame-92',
            currentParams: 'frame-92',
        })).toBe(false);
        expect(shouldSettleAccurateTarget({
            accurateOnly: false,
            adoptedInitialFrame: true,
            hasLoadedOnce: true,
            loadedParams: 'frame-56',
            currentParams: 'frame-92',
        })).toBe(false);
    });
});

function makeProps(overrides: Record<string, unknown> = {}) {
    return {
        fileKey: 'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        pageNum: 1,
        pageInstanceId: 'cold-open',
        zoom: 1,
        coarseZoom: undefined,
        rot: 0,
        clipX: 0,
        clipY: 0,
        clipW: 0,
        clipH: 0,
        cssLeft: 0,
        cssTop: 0,
        cssW: 640,
        cssH: 480,
        eager: true,
        onVisible: vi.fn(),
        ...overrides,
    };
}

// UIUX (audit 2026-09-24 §R24.07): node còn mounted chưa chứng minh ảnh đang hiện;
// kiểm các canvas có pixel cùng phủ một điểm, theo thứ tự chồng lớp DOM của TileLayer.
function visibleViewportCanvases(root: HTMLElement, x = 320, y = 240) {
    return Array.from(root.querySelectorAll<HTMLCanvasElement>('canvas[data-prynx-presented-tile]'))
        .filter(canvas => {
            if (canvas.style.display === 'none' || canvas.style.opacity === '0') return false;
            let parent: HTMLElement | null = canvas.parentElement;
            while (parent && parent !== root) {
                if (parent.style.display === 'none' || parent.style.opacity === '0') return false;
                parent = parent.parentElement;
            }
            const tile = canvas.closest<HTMLElement>('.tile-container');
            if (!tile) return false;
            const left = Number.parseFloat(tile.style.left) || 0;
            const top = Number.parseFloat(tile.style.top) || 0;
            return left <= x && left + Number.parseFloat(tile.style.width) >= x
                && top <= y && top + Number.parseFloat(tile.style.height) >= y;
        });
}

function presentedViewportTile(canvas: HTMLCanvasElement | undefined) {
    return canvas?.dataset.prynxPresentedTile
        ? JSON.parse(canvas.dataset.prynxPresentedTile) as { sourceToken: string; accurateOnly: boolean; zoom: number }
        : undefined;
}

function makeViewportHarness(overrides: Partial<ComponentProps<typeof TileLayer>> = {}) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
    const page = document.createElement('div');
    const pageBounds = vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480,
    } as DOMRect);
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.appendChild(page);
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480,
    } as DOMRect);
    const pending: Array<{
        resolve: (source: TileUrlSource) => void;
        reject: (error: unknown) => void;
        stage: string | undefined;
        zoom: number;
        priority: number;
        clipX: number;
        clipY: number;
    }> = [];
    const getTileUrl = vi.fn((...args: unknown[]) => new Promise<TileUrlSource>((resolve, reject) => {
        const options = args[7] as { colorStage?: string; priority: number };
        pending.push({
            resolve, reject, stage: options.colorStage, priority: options.priority, zoom: args[2] as number,
            clipX: args[3] as number, clipY: args[4] as number,
        });
    }));
    const source = (label: string, zoom: number): TileUrlSource => ({
        url: `pxrg:r24.07:${label}`, byteLength: 640 * 480 * zoom * zoom * 4,
        bitmap: { width: 640 * zoom, height: 480 * zoom, close: vi.fn() } as unknown as ImageBitmap,
    });
    const props: ComponentProps<typeof TileLayer> = {
        fileKey: 'r24.07|revision:r1|color:accurate', displayFileKey: 'r24.07|revision:r1|color:display',
        pageNum: 1, zoom: 3, dpr: 1, rotation: 0, displayWidth: 640, displayHeight: 480,
        containerRef: { current: page }, getTileUrl: getTileUrl as never, onVisible: vi.fn(),
        accurateColor: true, accurateCommitted: true, keepDisplayUntilAccurate: false,
        ...overrides,
    };
    return { props, pending, source, pageBounds, scroller };
}

describe('LiveTile — cold-open màu chính xác', () => {
    it.each([[300, 20], [430, 20], [1000, 500]])(
        'R25.04.2: render %i ms vẫn tiến triển khi zoom mỗi %i ms', async (latency, inputGap) => {
            vi.useFakeTimers();
            const { props, source, pageBounds } = makeViewportHarness();
            let serial = 0;
            const active = new Map<string, { timer: ReturnType<typeof setTimeout>; reject: (error: unknown) => void }>();
            props.cancelAccurateGroup = group => {
                const pending = active.get(group);
                if (pending) {
                    clearTimeout(pending.timer);
                    active.delete(group);
                    pending.reject(new CancelledTileRenderError());
                }
            };
            props.getTileUrl = vi.fn<NonNullable<ComponentProps<typeof TileLayer>['getTileUrl']>>((_p, _r, scale, _x, _y, _w, _h, options) => {
                if (options?.priority !== 0) return new Promise<never>(() => {});
                const group = options.groupKey!;
                return new Promise<TileUrlSource>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        active.delete(group);
                        resolve(source(`IDLE-STREAM-${++serial}`, scale));
                    }, latency);
                    active.set(group, { timer, reject });
                });
            });
            const view = render(<TileLayer {...props} />);
            const presented = new Set<string>();
            for (let elapsed = 20; elapsed <= 6000; elapsed += 20) {
                await act(async () => { await vi.advanceTimersByTimeAsync(20); });
                const painted = presentedViewportTile(visibleViewportCanvases(view.container).at(-1));
                if (painted) presented.add(painted.sourceToken);
                if (elapsed % inputGap === 0) {
                    const zoom = 3 + elapsed / 2000;
                    const width = 640 * zoom / 3; const height = 480 * zoom / 3;
                    pageBounds.mockReturnValue({ left: 0, top: 0, right: width, bottom: height, width, height } as DOMRect);
                    view.rerender(<TileLayer {...props} zoom={zoom} displayWidth={width} displayHeight={height} />);
                }
            }
            expect(presented.size).toBeGreaterThanOrEqual(3);
            for (let step = 0; step < 120; step += 1) {
                await act(async () => { await vi.advanceTimersByTimeAsync(20); });
            }
            expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.zoom).toBe(6);
        },
    );

    it('R25.04.2: target cuối được gửi sau khi ổn định, không đợi ảnh cũ chưa xong', async () => {
        vi.useFakeTimers();
        const cancelAccurateGroup = vi.fn();
        const { props, pending, source } = makeViewportHarness({ cancelAccurateGroup });
        const view = render(<TileLayer {...props} />);
        await act(async () => pending.find(t => t.priority === 0)!.resolve(source('IDLE-A', 3)));
        view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        const old = pending.find(t => t.priority === 0 && t.zoom === 4)!;
        for (const zoom of [5, 6, 5]) {
            view.rerender(<TileLayer {...props} zoom={zoom}
                displayWidth={640 * zoom / 3} displayHeight={480 * zoom / 3} />);
            await act(async () => { await vi.advanceTimersByTimeAsync(60); });
        }
        expect(pending.filter(t => t.priority === 0).map(t => t.zoom)).toEqual([3, 4]);
        const cancelsBeforeIdle = cancelAccurateGroup.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(pending.filter(t => t.priority === 0).map(t => t.zoom)).toEqual([3, 4, 5]);
        expect(cancelAccurateGroup.mock.calls.length).toBeGreaterThan(cancelsBeforeIdle);
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('IDLE-A');
        const final = pending.find(t => t.priority === 0 && t.zoom === 5)!;
        await act(async () => final.resolve(source('IDLE-C', 5)));
        await act(async () => old.resolve(source('IDLE-B-LATE', 4)));
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('IDLE-C');
        expect(Array.from(view.container.querySelectorAll<HTMLCanvasElement>('canvas[data-prynx-presented-tile]'))
            .some(canvas => presentedViewportTile(canvas)?.sourceToken.includes('IDLE-B-LATE'))).toBe(false);
    });

    it.each(['full', 'mid', 'low'])(
        'R25.04.1: đổi zoom không phát lại atlas cũ giữa settled và target (%s)',
        async tier => {
            vi.useFakeTimers();
            const previousClass = document.documentElement.className;
            document.documentElement.className = tier === 'full' ? '' : `perf-${tier}`;
            try {
                const { props, pending, source, pageBounds } = makeViewportHarness({
                    displayWidth: 4096, displayHeight: 3072,
                });
                const view = render(<TileLayer {...props} />);
                await act(async () => pending.find(t => t.priority === 0)!.resolve(source('ATLAS-A', 3)));
                await act(async () => { await vi.advanceTimersByTimeAsync(20); });
                expect(pending.some(t => t.priority >= 100 && t.zoom === 3)).toBe(true);
                const beforeZoom = pending.length;
                pageBounds.mockReturnValue({ left: 0, top: 0, right: 4096 * 4 / 3,
                    bottom: 4096, width: 4096 * 4 / 3, height: 4096 } as DOMRect);
                view.rerender(<TileLayer {...props} zoom={4}
                    displayWidth={4096 * 4 / 3} displayHeight={4096} />);
                await act(async () => { await vi.advanceTimersByTimeAsync(20); });
                // Log thật: 48 cell ở zoom cũ được phát rồi tháo sau 6 ms.
                // Kiểm lời gọi ở mọi lần render, không chỉ DOM cuối đã đóng atlas.
                expect(pending.slice(beforeZoom).filter(t => t.priority >= 100)).toHaveLength(0);
                const newViewport = pending.slice(beforeZoom).find(t => t.priority === 0)!;
                expect(newViewport.zoom).toBe(4);
                const beforeReady = pending.length;
                await act(async () => newViewport.resolve(source('ATLAS-B', 4)));
                const newAtlas = pending.slice(beforeReady).filter(t => t.priority >= 100);
                expect(newAtlas.length).toBeGreaterThan(0);
                expect(newAtlas.every(t => t.zoom === 4)).toBe(true);
                expect(pending.every(t => t.stage === 'accurate')).toBe(true);
            } finally {
                document.documentElement.className = previousClass;
            }
        },
    );

    it.each([false, true])('R25.01: viewport giữ bitmap 1:1, phần dư khung phân số không có nền trắng (PPE=%s)', async accurateColor => {
        vi.useFakeTimers();
        const { props, pending } = makeViewportHarness({ accurateColor, accurateCommitted: accurateColor,
            displayWidth: 1280, displayHeight: 960 });
        const view = render(<TileLayer {...props} />);
        await act(async () => pending.find(t => t.priority === 0)!.resolve({
            url: `pxrg:r25-viewport-${accurateColor}`, byteLength: 640 * 512 * 4,
            bitmap: { width: 640, height: 512, close: vi.fn() } as unknown as ImageBitmap,
        }));
        const canvas = visibleViewportCanvases(view.container).at(-1)!;
        expect(canvas).toBeDefined();
        view.rerender(<TileLayer {...props} zoom={3.001}
            displayWidth={1280 * 3.001 / 3} displayHeight={960 * 3.001 / 3} />);
        // Pixel native giữ 1:1; phần dư khung phải lộ ảnh dưới thay vì nền trắng.
        expect(canvas.width).toBe(640);
        expect(canvas.style.width).toBe('640px');
        expect(canvas.style.height).toBe('512px');
        expect(canvas.style.background).toBe('transparent');
        expect(canvas.closest<HTMLElement>('.tile-container')!.style.background).toBe('transparent');
    });

    it('R25.01: không tích lũy viewport đã nghỉ hoặc dựng DPI dự đoán khi idle', async () => {
        vi.useFakeTimers();
        const { props, pending, source } = makeViewportHarness();
        const view = render(<TileLayer {...props} />);
        await act(async () => pending.find(t => t.priority === 0)!.resolve(source('MAIN-3', 3)));
        for (const zoom of [4, 5, 6, 5, 4, 3]) {
            view.rerender(<TileLayer {...props} zoom={zoom}
                displayWidth={640 * zoom / 3} displayHeight={480 * zoom / 3} />);
            await act(async () => { await vi.advanceTimersByTimeAsync(20); });
            const latest = pending.filter(t => t.priority === 0).at(-1)!;
            await act(async () => latest.resolve(source(`MAIN-${latest.zoom}`, latest.zoom)));
            const canvases = Array.from(view.container.querySelectorAll<HTMLCanvasElement>('canvas[data-prynx-presented-tile]'));
            expect(canvases.filter(c => presentedViewportTile(c)?.sourceToken.includes('MAIN-')).length).toBeLessThanOrEqual(2);
        }
        const before = pending.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(pending.length).toBe(before);
        expect(pending.every(t => [3, 4, 5, 6].includes(t.zoom))).toBe(true);
    });

    it('R24.09: sau sharpen đầu, zoom tiếp không chờ lại 96 ms của prime', async () => {
        vi.useFakeTimers();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
        const pending: Array<(source: TileUrlSource) => void> = [];
        const getTileUrl = vi.fn(() => new Promise<TileUrlSource>(resolve => pending.push(resolve)));
        const firstFrame: ViewerFirstFrame = {
            nativePath: 'D:\\jobs\\gradient.pdf', documentToken: 'revision-1',
            page: 1, dpi: 24, renderScale: 0.25, width: 640, height: 480,
            profileId: 'fogra39', intent: 'relative',
            proofIdentity: 'show:all|paper:0|black:0|background:profile',
            url: 'blob:r24.09-prime', byteLength: 64,
        };
        const base = makeProps({ accurateOnly: true, renderPriority: 10, initialSource: firstFrame, getTileUrl });
        const view = render(<LiveTile {...base} zoom={0.25} />);
        view.rerender(<LiveTile {...base} zoom={1} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(96); });
        expect(getTileUrl).toHaveBeenCalledTimes(1);
        await act(async () => pending[0]({
            url: 'pxrg:prime-sharpened', byteLength: 64,
            bitmap: { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap,
        }));
        view.rerender(<LiveTile {...base} zoom={1.25} />);
        expect(getTileUrl).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])('R24.08: PPE cập nhật khi zoom còn chạy (underlay=%s)', async stableUnderlayReady => {
        vi.useFakeTimers();
        const { props, source, pageBounds } = makeViewportHarness({ stableUnderlayReady });
        const requested: number[] = [];
        props.getTileUrl = vi.fn<NonNullable<ComponentProps<typeof TileLayer>['getTileUrl']>>((_page, _rotation, scale, _x, _y, _w, _h, options) => {
            if (options?.priority !== 0) return new Promise<never>(() => {});
            requested.push(scale);
            return new Promise<TileUrlSource>(resolve => setTimeout(() => resolve(source(`STREAM-${scale}`, scale)), 80));
        });
        const view = render(<TileLayer {...props} />);
        const presented = new Set<number>();
        for (let step = 1; step <= 16; step += 1) {
            await act(async () => { await vi.advanceTimersByTimeAsync(20); });
            const painted = presentedViewportTile(visibleViewportCanvases(view.container).at(-1));
            if (painted) presented.add(painted.zoom);
            const zoom = 3 + step / 4;
            const width = 640 * zoom / 3;
            const height = 480 * zoom / 3;
            pageBounds.mockReturnValue({ left: 0, top: 0, right: width, bottom: height, width, height } as DOMRect);
            view.rerender(<TileLayer {...props} zoom={zoom} displayWidth={width} displayHeight={height} />);
        }
        // Đây là phép đo lifecycle có latency cố định, không phải benchmark native.
        expect(presented.size).toBeGreaterThanOrEqual(3);
        expect(requested.length).toBeLessThan(16);
        for (let step = 0; step < 10; step += 1) {
            await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        }
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.zoom).toBe(7);
    });

    it.each(['render', 'cancel', 'decode', 'canvas'])('R24.08: terminal %s vẫn chuyển sang target mới nhất', async failure => {
        vi.useFakeTimers();
        const { props, pending, source } = makeViewportHarness();
        const view = render(<TileLayer {...props} />);
        await act(async () => pending.find(item => item.priority === 0)!.resolve(source('BEFORE-FAIL', 3)));
        view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        const failed = pending.find(item => item.zoom === 4 && item.priority === 0)!;
        view.rerender(<TileLayer {...props} zoom={5} displayWidth={640 * 5 / 3} displayHeight={800} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(pending.some(item => item.zoom === 5 && item.priority === 0)).toBe(false);
        if (failure === 'canvas') {
            vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
            await act(async () => failed.resolve(source('NO-CANVAS', 4)));
        } else if (failure === 'decode') {
            const images: HTMLImageElement[] = [];
            vi.stubGlobal('Image', class {
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() { images.push(this as unknown as HTMLImageElement); }
            });
            try {
                await act(async () => failed.resolve({ url: 'blob:r24.08-bad-image', byteLength: 64 }));
                await act(async () => images.at(-1)!.onerror?.(new Event('error')));
            } finally { vi.unstubAllGlobals(); }
        } else {
            const error = failure === 'cancel' ? new CancelledTileRenderError() : new Error('render thất bại');
            await act(async () => failed.reject(error));
            if (failure === 'cancel') {
                const retry = pending.filter(item => item.zoom === 4 && item.priority === 0).at(-1)!;
                if (retry !== failed) await act(async () => retry.reject(error));
            }
        }
        const final = pending.find(item => item.zoom === 5 && item.priority === 0);
        expect(final).toBeDefined();
        await act(async () => final!.resolve(source('AFTER-FAIL', 5)));
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.zoom).toBe(5);
    });

    it.each([
        { fileKey: 'doc-2|revision:r1|color:accurate' },
        { fileKey: 'r24.07|revision:r2|color:accurate' },
        { fileKey: 'r24.07|revision:r1|color:accurate|profile:swop' },
        { pageNum: 2 },
        { rotation: 90 },
    ])('R24.08: đổi nội dung %j hủy in-flight cũ dù còn queued', async identity => {
        vi.useFakeTimers();
        const cancelAccurateGroup = vi.fn();
        const { props, pending, source } = makeViewportHarness({ cancelAccurateGroup });
        const view = render(<TileLayer {...props} />);
        const old = pending.find(item => item.priority === 0)!;
        view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(pending.filter(item => item.priority === 0)).toHaveLength(1);
        view.rerender(<TileLayer {...props} {...identity} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        const current = pending.filter(item => item.priority === 0).at(-1)!;
        expect(current).not.toBe(old);
        expect(cancelAccurateGroup).toHaveBeenCalled();
        await act(async () => current.resolve(source('NEW-IDENTITY', 4)));
        await act(async () => old.resolve(source('OLD-IDENTITY', 3)));
        const painted = Array.from(view.container.querySelectorAll<HTMLCanvasElement>('canvas[data-prynx-presented-tile]'));
        expect(painted.some(canvas => presentedViewportTile(canvas)?.sourceToken.includes('OLD-IDENTITY'))).toBe(false);
        expect(painted.some(canvas => presentedViewportTile(canvas)?.sourceToken.includes('NEW-IDENTITY'))).toBe(true);
    });

    it('R24.08: zoom-out làm tile thiếu coverage chỉ ẩn presentation, không hủy request đang chạy', async () => {
        vi.useFakeTimers();
        const { props, pending, source, pageBounds } = makeViewportHarness({
            zoom: 6, displayWidth: 2560, displayHeight: 1920, stableUnderlayReady: true,
        });
        pageBounds.mockReturnValue({ left: -800, top: -600, right: 1760, bottom: 1320, width: 2560, height: 1920 } as DOMRect);
        const view = render(<TileLayer {...props} />);
        await act(async () => pending.find(item => item.priority === 0)!.resolve(source('OLD-COVERAGE', 6)));
        view.rerender(<TileLayer {...props} zoom={6.5} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        const inFlight = pending.find(item => item.zoom === 6.5 && item.priority === 0)!;
        pageBounds.mockReturnValue({ left: 0, top: 0, right: 1280, bottom: 960, width: 1280, height: 960 } as DOMRect);
        view.rerender(<TileLayer {...props} zoom={3} displayWidth={1280} displayHeight={960} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(visibleViewportCanvases(view.container, 1, 1)).toHaveLength(0);
        expect(pending.some(item => item.zoom === 3 && item.priority === 0)).toBe(false);
        await act(async () => inFlight.resolve(source('COVERAGE-B', 6.5)));
        const final = pending.find(item => item.zoom === 3 && item.priority === 0)!;
        expect(final).toBeDefined();
        await act(async () => final.resolve(source('FULL-COVERAGE', 3)));
        expect(presentedViewportTile(visibleViewportCanvases(view.container, 1, 1).at(-1))?.sourceToken).toContain('FULL-COVERAGE');
    });

    it('R24.08: tắt render hủy công việc và bật lại vẫn tới target cuối', async () => {
        vi.useFakeTimers();
        const cancelAccurateGroup = vi.fn();
        const { props, pending, source } = makeViewportHarness({ cancelAccurateGroup });
        const view = render(<TileLayer {...props} />);
        const old = pending.find(item => item.priority === 0)!;
        view.rerender(<TileLayer {...props} renderEnabled={false} zoom={4} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(cancelAccurateGroup).toHaveBeenCalled();
        await act(async () => old.resolve(source('DISABLED-OLD', 3)));
        expect(visibleViewportCanvases(view.container)).toHaveLength(0);
        expect(pending.filter(item => item.priority === 0)).toHaveLength(1);
        view.rerender(<TileLayer {...props} zoom={4} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        const current = pending.filter(item => item.priority === 0).at(-1)!;
        expect(current).not.toBe(old);
        await act(async () => current.resolve(source('ENABLED-CURRENT', current.zoom)));
        const last = pending.filter(item => item.priority === 0).at(-1)!;
        if (last !== current) await act(async () => last.resolve(source('ENABLED-FINAL', last.zoom)));
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.zoom).toBe(4);
    });

    it.each([10, 100])('callback metadata đổi không hủy request cùng pixel (priority %s)', async renderPriority => {
        let resolveRender!: (source: TileUrlSource) => void;
        const beforeMetadata = vi.fn(() => new Promise<TileUrlSource>(resolve => { resolveRender = resolve; }));
        const afterMetadata = vi.fn(() => new Promise<never>(() => {}));
        const cancelAccurateGroup = vi.fn();
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
        const base = makeProps({
            pageNum: 2, pageInstanceId: 'prefetch-2', accurateOnly: true,
            renderPriority, renderOwnerId: 'owner-same-document', cancelAccurateGroup,
        });
        const view = render(<LiveTile {...base} getTileUrl={beforeMetadata} />);
        await waitFor(() => expect(beforeMetadata).toHaveBeenCalledTimes(1));
        view.rerender(<LiveTile {...base} getTileUrl={afterMetadata} />);
        await act(async () => { await Promise.resolve(); });
        expect(cancelAccurateGroup).not.toHaveBeenCalled();
        expect(afterMetadata).not.toHaveBeenCalled();
        const bitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
        await act(async () => { resolveRender({ url: 'blob:metadata-stable', byteLength: 64, bitmap }); });
        await waitFor(() => expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0));
        // Zoom mới là thay đổi pixel thật và phải dùng callback mới nhất.
        view.rerender(<LiveTile {...base} renderPriority={10} zoom={2} getTileUrl={afterMetadata} />);
        await waitFor(() => expect(afterMetadata).toHaveBeenCalledTimes(1));
        expect(afterMetadata).toHaveBeenCalledWith(2, 0, 2, 0, 0, 0, 0,
            expect.objectContaining({ colorStage: 'accurate' }));
    });

    it.each(['revision:r2|color:accurate', 'revision:r1|color:accurate|profile:swop'])('đổi pixel identity %s vẫn loại response cũ', async nextIdentity => {
        let resolveOld!: (source: TileUrlSource) => void;
        let resolveNew!: (source: TileUrlSource) => void;
        const before = vi.fn(() => new Promise<TileUrlSource>(resolve => { resolveOld = resolve; }));
        const after = vi.fn(() => new Promise<TileUrlSource>(resolve => { resolveNew = resolve; }));
        const cancelAccurateGroup = vi.fn();
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
        const base = makeProps({ accurateOnly: true, renderPriority: 10, cancelAccurateGroup });
        const view = render(<LiveTile {...base} getTileUrl={before} />);
        await waitFor(() => expect(before).toHaveBeenCalledTimes(1));
        view.rerender(<LiveTile {...base} fileKey={`D:\\jobs\\gradient.pdf|${nextIdentity}`} getTileUrl={after} />);
        await waitFor(() => expect(after).toHaveBeenCalledTimes(1));
        expect(cancelAccurateGroup).toHaveBeenCalled();
        const oldBitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
        const newBitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
        await act(async () => { resolveOld({ url: 'blob:old-identity', byteLength: 64, bitmap: oldBitmap }); });
        expect(drawImage).not.toHaveBeenCalledWith(oldBitmap, 0, 0);
        await act(async () => { resolveNew({ url: 'blob:new-identity', byteLength: 64, bitmap: newBitmap }); });
        expect(drawImage).toHaveBeenCalledWith(newBitmap, 0, 0);
    });

    it('bỏ callback render phải hủy request đang chạy; gắn lại phải dùng callback mới', async () => {
        let resolveOld!: (source: TileUrlSource) => void;
        const before = vi.fn(() => new Promise<TileUrlSource>(resolve => { resolveOld = resolve; }));
        const after = vi.fn(() => new Promise<never>(() => {}));
        const cancelAccurateGroup = vi.fn();
        const base = makeProps({ accurateOnly: true, renderPriority: 10, cancelAccurateGroup });
        const view = render(<LiveTile {...base} getTileUrl={before} />);
        await waitFor(() => expect(before).toHaveBeenCalledTimes(1));
        view.rerender(<LiveTile {...base} getTileUrl={undefined} />);
        expect(cancelAccurateGroup).toHaveBeenCalled();
        await act(async () => { resolveOld({ url: 'blob:removed-builder', byteLength: 64 }); });
        expect(view.container.querySelector('img')?.getAttribute('src')).not.toBe('blob:removed-builder');
        view.rerender(<LiveTile {...base} getTileUrl={after} />);
        await waitFor(() => expect(after).toHaveBeenCalledTimes(1));
    });

    it('observer không được vượt cổng settle và phát DPI trung gian khi đã có prime', async () => {
        vi.useFakeTimers();
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        let observed: (HTMLElement & { _loadTile?: () => void }) | null = null;
        const onVisible = vi.fn((element: HTMLElement, cleanup?: boolean) => {
            if (cleanup) return;
            observed = element;
            observed._loadTile?.();
        });
        const base = makeProps({
            accurateOnly: true, getTileUrl, onVisible, zoom: 0.25, renderPriority: 10,
            initialSource: {
                nativePath: 'D:\\jobs\\gradient.pdf', documentToken: 'revision-1',
                page: 1, dpi: 24, renderScale: 0.25, width: 640, height: 480,
                profileId: 'fogra39', intent: 'relative',
                proofIdentity: 'show:all|paper:0|black:0|background:profile',
                url: 'blob:prime-settle', byteLength: 64,
            } satisfies ViewerFirstFrame,
        });
        const view = render(<LiveTile {...base} />);
        expect(getTileUrl).not.toHaveBeenCalled();
        view.rerender(<LiveTile {...base} zoom={0.75} />);
        expect(getTileUrl).not.toHaveBeenCalled();
        // Một nhịp settle viewport chưa đủ để phát target trung gian; target cuối
        // mới được phép đi qua sau cổng accurate 96 ms.
        await act(async () => { await vi.advanceTimersByTimeAsync(48); });
        view.rerender(<LiveTile {...base} zoom={1} />);
        act(() => { observed?._loadTile?.(); });
        expect(getTileUrl).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(95); });
        expect(getTileUrl).not.toHaveBeenCalled();
        expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:prime-settle');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(getTileUrl).toHaveBeenCalledWith(1, 0, 1, 0, 0, 0, 0,
            expect.objectContaining({ colorStage: 'accurate' }));
    });

    it('ZOOMSHARP.BUDGET: phát request accurate đầu tiên trong 120 ms sau khi zoom ổn định', async () => {
        vi.useFakeTimers();
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const firstFrame: ViewerFirstFrame = {
            nativePath: 'D:\\jobs\\gradient.pdf', documentToken: 'revision-1',
            page: 1, dpi: 24, renderScale: 0.25, width: 640, height: 480,
            profileId: 'fogra39', intent: 'relative',
            proofIdentity: 'show:all|paper:0|black:0|background:profile',
            url: 'blob:zoom-sharp-budget', byteLength: 64,
        };
        const base = makeProps({
            accurateOnly: true,
            getTileUrl,
            renderPriority: 10,
            zoom: 0.25,
            initialSource: firstFrame,
        });
        const view = render(<LiveTile {...base} />);
        expect(getTileUrl).not.toHaveBeenCalled();

        // Mô phỏng một lần wheel đã settle: frame prime vẫn hiện làm underlay,
        // nhưng target pixel mới phải được xếp hàng trong ngân sách phản hồi.
        view.rerender(<LiveTile {...base} zoom={1} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(95); });
        expect(getTileUrl).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(getTileUrl).toHaveBeenCalledWith(1, 0, 1, 0, 0, 0, 0,
            expect.objectContaining({ colorStage: 'accurate' }));
        view.unmount();
    });

    it('canvas chỉ công bố identity/zoom của bitmap đã vẽ, không lấy target đang chờ', async () => {
        const bitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_1_0_0_0_0_0',
            { url: 'blob:presented', byteLength: 100, bitmap },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const view = render(<LiveTile {...makeProps({ accurateOnly: true, getTileUrl })} />);
        const canvas = view.container.querySelector('canvas')!;
        await waitFor(() => expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0));
        const painted = canvas.dataset.prynxPresentedTile;
        expect(JSON.parse(painted!)).toMatchObject({
            sourceToken: 'blob:presented', page: 1, zoom: 1, accurateOnly: true, clip: null,
        });
        view.rerender(<LiveTile {...makeProps({ accurateOnly: true, getTileUrl, zoom: 2, cssW: 1280, cssH: 960 })} />);
        await act(async () => { await Promise.resolve(); });
        expect(canvas.dataset.prynxPresentedTile).toBe(painted);
    });

    it('Standee có frame tức thì 24 DPI trước khi Viewer dựng tile nét', () => {
        expect(viewerFirstFrameDpi(2267.72, 4960.63, 757, 629, 92)).toBe(24);
    });

    it('nhận frame PPE đã decode làm target ngay, không hiện chờ và không render lại', async () => {
        const getTileUrl = vi.fn();
        const onTileReady = vi.fn();
        const firstFrame: ViewerFirstFrame = {
            nativePath: 'D:\\jobs\\standee.pdf',
            documentToken: 'revision-1',
            page: 1,
            dpi: 24,
            renderScale: 0.25,
            width: 756,
            height: 1654,
            profileId: 'fogra39',
            intent: 'relative',
            proofIdentity: 'show:all|paper:0|black:0|background:profile',
            url: 'blob:http://localhost/ppe-first-frame',
            byteLength: 1024,
            cacheable: true,
        };
        expect(viewerFirstFrameMatchesTile(firstFrame, 1, 0.25, 0, 0, 0, 756, 1654))
            .toBe(true);

        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                onTileReady,
                zoom: 0.25,
                clipW: 756,
                clipH: 1654,
                cssW: 287,
                cssH: 629,
                accurateOnly: true,
                showLoadStatus: true,
                preserveUnderlay: true,
                initialSource: firstFrame,
                loadLabels: {
                    loading: 'Đang dựng hình…',
                    slow: 'Đang dựng trang lâu hơn bình thường…',
                    error: 'Không dựng được trang này.',
                    cancelled: 'Đã hủy dựng trang.',
                    retry: 'Thử lại',
                    cancel: 'Hủy',
                },
            })} />,
        );

        await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('ppe-first-frame'));
        expect(view.container.querySelector('img')?.style.imageRendering)
            .toBe(VIEWER_RASTER_IMAGE_RENDERING);
        expect(view.queryByText('Đang dựng hình…')).toBeNull();
        expect(getTileUrl).not.toHaveBeenCalled();
        fireEvent.load(view.container.querySelector('img')!);
        expect(onTileReady).toHaveBeenCalledWith({ scale: 0.25 });
    });

    it('toàn trang vừa khung xin thẳng PPE đúng mật độ màn hình thay vì nền 144 DPI', () => {
        expect(shouldUseViewerDirectFullPageSurface(
            true, 2.125, 2.1, 1112, 388, 1400, 800,
        )).toBe(true);
        expect(shouldUseViewerDirectFullPageSurface(
            true, 1.5, 2.1, 1112, 388, 1400, 800,
        )).toBe(false);
        expect(shouldUseViewerDirectFullPageSurface(
            true, 2.125, 2.1, 1800, 1200, 1400, 800,
        )).toBe(false);
        expect(shouldUseViewerDirectFullPageSurface(
            false, 2.125, 2.1, 1112, 388, 1400, 800,
        )).toBe(false);
    });

    it('Standee thật không đi surface full-page khi raster vượt ngân sách WebView', () => {
        const pageWidth = 3023 * 0.1;
        const pageHeight = 6614 * 0.1;
        const rasterScale = 0.958 / 0.1;
        expect(shouldUseViewerDirectFullPageSurface(
            true,
            0.958,
            0.1,
            pageWidth,
            pageHeight,
            1400,
            800,
        )).toBe(false);
        expect(pageWidth * pageHeight * rasterScale ** 2)
            .toBeGreaterThan(VIEWER_DIRECT_FULL_PAGE_MAX_PIXELS);
        expect(shouldRenderViewerBaseTile(true, false, true, true, false)).toBe(false);
        expect(shouldRenderViewerAccurateBaseTile(true, true, true, false)).toBe(false);
        expect(shouldKeepViewerAccurateBaseMounted(true, false, true, false)).toBe(false);
        expect(shouldRequestViewerAccurateBase(false, true, false, false)).toBe(false);
    });

    it('không dựng accurate base nền khi layout DPI chưa ổn định', () => {
        expect(shouldRenderViewerAccurateBaseTile(true, true, false, true, false)).toBe(false);
        expect(shouldRenderViewerAccurateBaseTile(true, true, false, true, true)).toBe(true);
    });

    it('giữ viewport nét tới khi surface toàn trang mới đã decode xong', () => {
        expect(shouldMountViewerViewportLayer(false, true, true, true, false)).toBe(true);
        expect(shouldMountViewerViewportLayer(false, true, true, true, true)).toBe(false);
        expect(shouldMountViewerViewportLayer(true, false, true, false, false)).toBe(true);
    });

    it('PPE thay surface nguyên tử sau decode, không hòa trộn mờ với nét', () => {
        expect(viewerSurfaceSwapMs(true, 160)).toBe(0);
        expect(viewerSurfaceSwapMs(false, 160)).toBe(160);
    });

    it('direct high-zoom tự phát viewport nếu không có base PPE nào đang chạy', () => {
        expect(shouldEnableViewerViewportAccurateTile(false, false, false)).toBe(true);
        expect(shouldEnableViewerViewportAccurateTile(false, true, false)).toBe(false);
        expect(shouldEnableViewerViewportAccurateTile(true, true, false)).toBe(true);
        expect(shouldEnableViewerViewportAccurateTile(false, true, true)).toBe(true);
    });

    it('cold-open chỉ phát target chính, chưa mount pan-grid trước first-frame', () => {
        expect(viewerPanGridRenderPolicy(false, false, false)).toEqual({
            near: false,
            outer: false,
        });
        expect(viewerPanGridRenderPolicy(false, false, true)).toEqual({
            near: true,
            outer: true,
        });
    });

    it('sau first-frame vẫn tải trước near-grid đầy đủ khi pan sang pha mới', () => {
        expect(viewerPanGridRenderPolicy(true, false, false)).toEqual({
            near: true,
            outer: false,
        });
        expect(viewerPanGridRenderPolicy(false, true, false)).toEqual({
            near: true,
            outer: false,
        });
    });

    it('giữ PDFium cho trang compatibility chưa được đánh dấu màu rủi ro', async () => {
        const getTileUrl = vi.fn<GetTileUrl>(() => new Promise<never>(() => {}));
        render(
            <LiveTile
                {...makeProps({ getTileUrl, showLoadStatus: true })}
            />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(getTileUrl).toHaveBeenCalledWith(
            1,
            0,
            1,
            0,
            0,
            0,
            0,
            expect.objectContaining({ colorStage: undefined }),
        );
    });

    it('chỉ yêu cầu PPE accurate khi trang rủi ro còn đang chờ', async () => {
        const getTileUrl = vi.fn<GetTileUrl>(() => new Promise<never>(() => {}));
        const view = render(
            <LiveTile
                {...makeProps({ getTileUrl, accurateOnly: true, showLoadStatus: true })}
            />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(getTileUrl).toHaveBeenCalledWith(
            1,
            0,
            1,
            0,
            0,
            0,
            0,
            expect.objectContaining({ colorStage: 'accurate' }),
        );
        const requestedStages = getTileUrl.mock.calls.map(call => (
            (call[7] as { colorStage?: string } | undefined)?.colorStage
        ));
        expect(requestedStages)
            .not.toContain('display');

        const image = view.container.querySelector('img');
        expect(image?.getAttribute('src')).toMatch(/^data:image\/gif/);
        expect(image?.src).not.toContain('pdfium');
        expect(image?.src).not.toContain('display');
    });

    it('IntersectionObserver không phát lại cùng request PPE đang bay', async () => {
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        let observed: HTMLElement | null = null;
        const onVisible = vi.fn((element: HTMLElement, isCleanup?: boolean) => {
            if (!isCleanup) observed = element;
        });
        render(
            <LiveTile
                {...makeProps({ getTileUrl, onVisible, accurateOnly: true })}
            />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(observed).not.toBeNull();
        act(() => {
            (observed as HTMLElement & { _loadTile?: () => void })._loadTile?.();
        });

        expect(getTileUrl).toHaveBeenCalledTimes(1);
    });

    it('phát lại cùng params khi effect đã hủy request cũ trước lúc có bitmap', async () => {
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const cancelAccurateGroup = vi.fn();
        const baseProps = makeProps({
            getTileUrl,
            accurateOnly: true,
            cancelAccurateGroup,
        });
        const view = render(
            <LiveTile {...baseProps} renderOwnerId="owner-trước" />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        view.rerender(
            <LiveTile {...baseProps} renderOwnerId="owner-sau" />,
        );

        await waitFor(() => expect(cancelAccurateGroup).toHaveBeenCalled());
        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(2));
        const calls = getTileUrl.mock.calls as unknown[][];
        expect(calls[0]?.[7]).toEqual(expect.objectContaining({
            ownerId: 'owner-trước',
        }));
        expect(calls[1]?.[7]).toEqual(expect.objectContaining({
            ownerId: 'owner-sau',
        }));
    });

    it('request lỗi nhả in-flight để cùng params được thử lại', async () => {
        const getTileUrl = vi.fn()
            .mockRejectedValueOnce(new Error('PPE worker lỗi'))
            .mockReturnValue(new Promise<never>(() => {}));
        let observed: HTMLElement | null = null;
        const onVisible = vi.fn((element: HTMLElement, isCleanup?: boolean) => {
            if (!isCleanup) observed = element;
        });
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                onVisible,
                accurateOnly: true,
                showLoadStatus: true,
                loadLabels: {
                    loading: 'Đang dựng hình…',
                    slow: 'Đang dựng trang lâu hơn bình thường…',
                    error: 'Không dựng được trang này.',
                    cancelled: 'Đã hủy dựng trang.',
                    retry: 'Thử lại',
                    cancel: 'Hủy',
                },
            })} />,
        );

        await waitFor(() => expect(view.getByText('Không dựng được trang này.')).toBeTruthy());
        expect(observed).not.toBeNull();
        act(() => {
            (observed as HTMLElement & { _loadTile?: () => void })._loadTile?.();
        });

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(2));
        expect(view.getByText('Đang dựng hình…')).toBeTruthy();
    });

    it('kết quả request cũ không được ghi đè bitmap sau khi effect đổi owner', async () => {
        const pending: Array<(source: { url: string; byteLength: number }) => void> = [];
        const getTileUrl = vi.fn(() => new Promise<{ url: string; byteLength: number }>((resolve) => {
            pending.push(resolve);
        }));
        const originalImage = globalThis.Image;
        class ImmediateImage {
            onload: null | (() => void) = null;
            onerror: null | (() => void) = null;
            naturalWidth = 640;
            naturalHeight = 480;
            private value = '';

            set src(value: string) {
                this.value = value;
                queueMicrotask(() => this.onload?.());
            }

            get src() {
                return this.value;
            }
        }
        vi.stubGlobal('Image', ImmediateImage);
        try {
            const baseProps = makeProps({
                getTileUrl,
                accurateOnly: true,
                cancelAccurateGroup: vi.fn(),
            });
            const view = render(
                <LiveTile {...baseProps} renderOwnerId="owner-cũ" />,
            );
            await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));

            view.rerender(
                <LiveTile {...baseProps} renderOwnerId="owner-mới" />,
            );
            await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(2));

            await act(async () => {
                pending[0]?.({ url: 'blob:http://localhost/request-cũ', byteLength: 64 });
                pending[1]?.({ url: 'blob:http://localhost/request-mới', byteLength: 64 });
                await Promise.resolve();
                await Promise.resolve();
            });

            const image = view.container.querySelector('img')!;
            expect(decodeURI(image.src)).toBe('blob:http://localhost/request-mới');
        } finally {
            vi.stubGlobal('Image', originalImage);
        }
    });

    it('dùng ngay bitmap PPE từ cache mà không gọi lại PDFium', async () => {
        const getTileUrl = vi.fn();
        const onTileReady = vi.fn();
        const cachedUrl = 'blob:http://localhost/accurate-cache';

        // Cache được tiêm qua module thật bằng key giống LiveTile tạo ra.
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_1_0_0_0_0_0',
            { url: cachedUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );

        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                onTileReady,
                presentationFadeMs: 140,
            })} />,
        );

        await act(async () => {
            await Promise.resolve();
        });
        const image = view.container.querySelector('img');
        const tile = view.container.querySelector('.tile-container') as HTMLElement | null;
        expect(getTileUrl).not.toHaveBeenCalled();
        expect(image?.src).toBe(cachedUrl);
        expect(tile?.style.transition).toContain('opacity 140ms');
        expect(tile?.style.filter).toBe('');
        fireEvent.load(image!);
        expect(onTileReady).toHaveBeenCalledTimes(1);
        expect(onTileReady).toHaveBeenCalledWith({ scale: 1 });
    });

    it('mở cổng trang kế tiếp ngay khi underlay prefetch đã hiện', async () => {
        const getTileUrl = vi.fn();
        const cancelAccurateGroup = vi.fn();
        const cachedUrl = 'blob:http://localhost/adjacent-underlay';
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_0.75_0_0_0_0_0',
            { url: cachedUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const baseProps = makeProps({
            getTileUrl,
            cancelAccurateGroup,
            accurateOnly: true,
            zoom: 0.75,
            renderPriority: viewerPageRenderPriority(true, false, true),
        });
        const view = render(<LiveTile {...baseProps} />);

        await act(async () => { await Promise.resolve(); });
        const image = view.container.querySelector('img')!;
        fireEvent.load(image);
        const onRenderReady = vi.fn();
        view.rerender(<LiveTile {...baseProps}
            renderPriority={viewerPageRenderPriority(true, true, false)}
            onRenderReady={onRenderReady}
        />);

        await waitFor(() => expect(onRenderReady).toHaveBeenCalledTimes(1));
        expect(getTileUrl).not.toHaveBeenCalled();
        expect(cancelAccurateGroup).not.toHaveBeenCalled();
        expect(image.src).toBe(cachedUrl);
    });

    it('atlas luôn phủ kín khung màu thay vì co ảnh và lộ nền trắng ở đường nối', async () => {
        vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
        const getTileUrl = vi.fn();
        const cachedUrl = 'blob:http://localhost/accurate-atlas-cache';
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_1_0_0_0_512_512',
            { url: cachedUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                clipW: 512,
                clipH: 512,
                cssW: 256.25,
                cssH: 256.25,
                seamlessGridPresentation: true,
            })} />,
        );

        await act(async () => {
            await Promise.resolve();
        });
        const image = view.container.querySelector('img')!;
        const tile = view.container.querySelector('.tile-container') as HTMLElement;
        Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 512 });
        Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 512 });
        fireEvent.load(image);

        expect(getTileUrl).not.toHaveBeenCalled();
        expect(image.style.width).toBe('100%');
        expect(image.style.height).toBe('100%');
        expect(image.style.background).toBe('transparent');
        expect(tile.style.background).toBe('transparent');
    });

    it('không hủy và dựng lại base đang chạy khi trang prefetch trở thành active', async () => {
        let resolveRender!: (source: TileUrlSource) => void;
        const getTileUrl = vi.fn(() => new Promise<TileUrlSource>(resolve => {
            resolveRender = resolve;
        }));
        const preloadImage = document.createElement('img');
        vi.spyOn(globalThis, 'Image').mockImplementation(function () { return preloadImage; });
        const cancelAccurateGroup = vi.fn();
        const onRenderReady = vi.fn();
        const baseProps = makeProps({
            getTileUrl,
            cancelAccurateGroup,
            renderOwnerId: 'viewer:prefetch:accurate-base:page-1',
            accurateOnly: true,
        });
        const view = render(
            <LiveTile {...baseProps}
                renderPriority={viewerPageRenderPriority(true, false, true)}
                showLoadStatus={false}
            />,
        );
        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(getTileUrl).toHaveBeenCalledWith(
            1, 0, 1, 0, 0, 0, 0,
            expect.objectContaining({
                priority: 100,
                ownerId: 'viewer:prefetch:accurate-base:page-1',
                colorStage: 'accurate',
            }),
        );

        view.rerender(
            <LiveTile {...baseProps}
                renderPriority={viewerPageRenderPriority(true, true, false)}
                showLoadStatus={true}
                onRenderReady={onRenderReady}
            />,
        );
        await act(async () => {
            await Promise.resolve();
        });

        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(cancelAccurateGroup).not.toHaveBeenCalled();
        expect(onRenderReady).not.toHaveBeenCalled();

        // PERF (audit 2026-09-11 §PPEBX.C): đổi lane của request tương lai không
        // được làm mất kết quả đang chạy hoặc tạo bitmap thứ hai cùng pixel.
        await act(async () => {
            resolveRender({ url: 'blob:http://localhost/promoted-prefetch', byteLength: 64 });
            await Promise.resolve();
        });
        fireEvent.load(preloadImage);
        await waitFor(() => expect(view.container.querySelector('img')?.src)
            .toBe('blob:http://localhost/promoted-prefetch'));
        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(cancelAccurateGroup).not.toHaveBeenCalled();
        expect(onRenderReady).toHaveBeenCalledTimes(1);
    });

    it('cold-open xin thẳng PPE target nét, không phát coarse 24 DPI', async () => {
        let requestCount = 0;
        const getTileUrl = vi.fn<GetTileUrl>(async () => ({
            url: `blob:http://localhost/accurate-${++requestCount}`,
            byteLength: 64,
            cacheable: true,
        }));
        render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                zoom: 1,
                coarseZoom: 0.25,
            })} />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        const calls = getTileUrl.mock.calls as unknown[][];
        expect(calls.map(call => call[2])).toEqual([1]);
        expect(calls.map(call => (
            call[7] as { colorStage?: string } | undefined
        )?.colorStage))
            .toEqual(['accurate']);
    });

    it('giữ bitmap PPE nét hơn khi zoom xuống thay vì render lại surface thấp DPI', async () => {
        const sharpUrl = 'blob:http://localhost/accurate-sharp-surface';
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_2.125_0_0_0_0_0',
            { url: sharpUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const onTileReady = vi.fn();
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                zoom: 2.125,
                onTileReady,
                renderPriority: 10,
            })} />,
        );

        await act(async () => {
            await Promise.resolve();
        });
        const image = view.container.querySelector('img')!;
        fireEvent.load(image);
        expect(image.src).toBe(sharpUrl);
        expect(onTileReady).toHaveBeenLastCalledWith({ scale: 2.125 });

        view.rerender(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                zoom: 1.5,
                onTileReady,
                renderPriority: 10,
            })} />,
        );
        await act(async () => {
            await Promise.resolve();
        });

        expect(getTileUrl).not.toHaveBeenCalled();
        expect(image.src).toBe(sharpUrl);
        expect(onTileReady).toHaveBeenLastCalledWith({ scale: 2.125 });
    });

    it('tự nối lại cancellation nội bộ thay vì hiện lỗi cuối cho người dùng', async () => {
        const getTileUrl = vi.fn()
            .mockRejectedValueOnce(new CancelledTileRenderError())
            .mockReturnValue(new Promise<never>(() => {}));
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                showLoadStatus: true,
                loadLabels: {
                    loading: 'Đang dựng hình…',
                    slow: 'Đang dựng trang lâu hơn bình thường…',
                    error: 'Không dựng được trang này.',
                    cancelled: 'Đã hủy dựng trang.',
                    retry: 'Thử lại',
                    cancel: 'Hủy',
                },
            })} />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(2));
        expect(view.queryByText('Đã hủy dựng trang.')).toBeNull();
        expect(view.queryByText('Thử lại')).toBeNull();
        expect(view.getByText('Đang dựng hình…')).toBeTruthy();
    });

    it('báo atlas bỏ mounted cell để ready coverage không giữ key ma', async () => {
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const onTileUnmount = vi.fn();
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                onTileUnmount,
            })} />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        view.unmount();
        expect(onTileUnmount).toHaveBeenCalledTimes(1);
    });

    it('ZOOMRACE20.01: khi zoom nhanh, canvas/img co giãn 100% theo khung mới, không kẹt kích thước px cũ gây cắt góc', async () => {
        const sharpUrl = 'blob:http://localhost/fast-zoom-test';
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_3_0_0_0_0_0',
            { url: sharpUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                zoom: 3,
                cssW: 960,
                cssH: 600,
            })} />,
        );

        await act(async () => {
            await Promise.resolve();
        });
        const image = view.container.querySelector('img')!;
        fireEvent.load(image);

        // Thu nhỏ nhanh về khung 320x200
        view.rerender(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                zoom: 1,
                cssW: 320,
                cssH: 200,
            })} />,
        );
        await act(async () => {
            await Promise.resolve();
        });

        // Không bị kẹt 960px trong khung 320px, phải là 100% để vừa khít khung
        expect(image.style.width).toBe('100%');
        expect(image.style.height).toBe('100%');
    });

    it('zoom-in giữ bitmap đang hiện khi target mới còn chờ, không phủ spinner lên surface cũ', async () => {
        const oldUrl = 'blob:http://localhost/zoom-underlay';
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_1_0_0_0_0_0',
            { url: oldUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const view = render(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                renderPriority: 10,
                showLoadStatus: true,
                loadLabels: {
                    loading: 'Đang dựng hình…',
                    slow: 'Đang dựng trang lâu hơn bình thường…',
                    error: 'Không dựng được trang này.',
                    cancelled: 'Đã hủy dựng trang.',
                    retry: 'Thử lại',
                    cancel: 'Hủy',
                },
            })} />,
        );

        await act(async () => { await Promise.resolve(); });
        const image = view.container.querySelector('img')!;
        fireEvent.load(image);
        expect(image.src).toBe(oldUrl);

        view.rerender(
            <LiveTile {...makeProps({
                getTileUrl,
                accurateOnly: true,
                renderPriority: 10,
                showLoadStatus: true,
                zoom: 2,
                cssW: 1280,
                cssH: 960,
                loadLabels: {
                    loading: 'Đang dựng hình…',
                    slow: 'Đang dựng trang lâu hơn bình thường…',
                    error: 'Không dựng được trang này.',
                    cancelled: 'Đã hủy dựng trang.',
                    retry: 'Thử lại',
                    cancel: 'Hủy',
                },
            })} />,
        );

        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        expect(image.src).toBe(oldUrl);
        expect(view.queryByText('Đang dựng hình…')).toBeNull();
    });

    it('giữ canvas đã decode khi ngừng dựng base sau khi zoom vượt ngân sách surface', async () => {
        let resolveRender!: (source: TileUrlSource) => void;
        const getTileUrl = vi.fn(() => new Promise<TileUrlSource>(resolve => {
            resolveRender = resolve;
        }));
        const bitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
        const base = makeProps({
            getTileUrl,
            accurateOnly: true,
            renderPriority: 10,
            showLoadStatus: true,
            loadLabels: {
                loading: 'Đang dựng hình…',
                slow: 'Đang dựng trang lâu hơn bình thường…',
                error: 'Không dựng được trang này.',
                cancelled: 'Đã hủy dựng trang.',
                retry: 'Thử lại',
                cancel: 'Hủy',
            },
        });
        const view = render(<LiveTile {...base} />);
        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));
        await act(async () => {
            resolveRender({ url: 'blob:http://localhost/disabled-base-underlay', byteLength: 64, bitmap });
        });
        await waitFor(() => expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0));
        const canvas = view.container.querySelector('canvas')!;
        const tile = view.container.querySelector('.tile-container') as HTMLElement;
        const presentedTile = canvas.dataset.prynxPresentedTile;

        // UIUX (audit 2026-09-23 §ZOOM.FLASH.1): ngừng xin base lớn không đồng
        // nghĩa rút bitmap đã decode; viewport mới vẫn cần underlay này để chống trắng.
        view.rerender(
            <LiveTile {...base} renderEnabled={false} zoom={2} cssW={1280} cssH={960} />,
        );
        await act(async () => { await Promise.resolve(); });

        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(view.container.querySelector('canvas')).toBe(canvas);
        expect(canvas.dataset.prynxPresentedTile).toBe(presentedTile);
        expect(canvas.width).toBe(640);
        expect(canvas.height).toBe(480);
        expect(canvas.style.width).toBe('100%');
        expect(canvas.style.height).toBe('100%');
        expect(canvas.style.display).toBe('block');
        expect(canvas.style.opacity).toBe('1');
        expect(tile.style.opacity).toBe('1');
        expect(view.queryByText('Đang dựng hình…')).toBeNull();
        expect(view.queryByRole('status')).toBeNull();
    });

    it('AUDIT §R24.01 / F1: zoom đảo chiều và huỷ decode giữa chừng giải phóng in-flight và tải mục tiêu cuối', async () => {
        const pending: Array<(source: TileUrlSource) => void> = [];
        const getTileUrl = vi.fn(() => new Promise<TileUrlSource>(resolve => pending.push(resolve)));
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
        const bitmapSource = (scale: number): TileUrlSource => ({
            url: `pxrg:audit:${scale}`,
            byteLength: 640 * 480 * scale * scale * 4,
            bitmap: { width: 640 * scale, height: 480 * scale, close: vi.fn() } as unknown as ImageBitmap,
        });

        const props = {
            fileKey: 'audit-file|revision:r1|color:display',
            pageNum: 1,
            pageInstanceId: 'audit',
            zoom: 1,
            rot: 0,
            clipX: 0,
            clipY: 0,
            clipW: 0,
            clipH: 0,
            cssW: 640,
            cssH: 480,
            eager: true,
            renderPriority: 10,
            onVisible: vi.fn(),
            getTileUrl,
        };
        const view = render(<LiveTile {...props} />);
        await act(async () => { pending[0](bitmapSource(1)); });

        // Zoom 1 -> 1.3
        view.rerender(<LiveTile {...props} zoom={1.3} cssW={832} cssH={624} />);
        expect(getTileUrl).toHaveBeenCalledTimes(2);

        // Zoom đảo chiều lùi về 1.2 trong lúc 1.3 đang bay
        view.rerender(<LiveTile {...props} zoom={1.2} cssW={768} cssH={576} />);
        expect(getTileUrl).toHaveBeenCalledTimes(2);

        // 1.3 về -> kích hoạt lượt kế tiếp cho 1.2
        await act(async () => { pending[1](bitmapSource(1.3)); });
        expect(getTileUrl).toHaveBeenCalledTimes(3);

        // 1.2 về nhưng thấp hơn 1.3 -> bị discard chất lượng
        await act(async () => { pending[2](bitmapSource(1.2)); });

        // Người dùng zoom tiếp lên 1.4 -> KHÔNG ĐƯỢC BỊ KẸT in-flight, phải gửi request 1.4
        view.rerender(<LiveTile {...props} zoom={1.4} cssW={896} cssH={672} />);
        await act(async () => { await Promise.resolve(); });
        expect(getTileUrl).toHaveBeenCalledTimes(4);
    });

    it('AUDIT §R24.01 / F1: zoom trong lúc decode PNG fallback phải tiếp tục dựng target mới', async () => {
        const images: Array<{ onload: null | (() => void); onerror: null | (() => void); src: string }> = [];
        class DeferredImage {
            onload: null | (() => void) = null;
            onerror: null | (() => void) = null;
            naturalWidth = 640;
            naturalHeight = 480;
            src = '';
            constructor() { images.push(this); }
        }
        vi.stubGlobal('Image', DeferredImage);
        const getTileUrl = vi.fn(async () => ({ url: 'blob:audit-png', byteLength: 64 }));
        const props = {
            fileKey: 'audit-file|revision:r1|color:display',
            pageNum: 1,
            pageInstanceId: 'audit-decode',
            zoom: 1,
            rot: 0,
            clipX: 0,
            clipY: 0,
            clipW: 0,
            clipH: 0,
            cssW: 640,
            cssH: 480,
            eager: true,
            renderPriority: 10,
            onVisible: vi.fn(),
            getTileUrl,
        };
        const view = render(<LiveTile {...props} />);
        await waitFor(() => expect(images).toHaveLength(1));
        expect(images[0].onload).not.toBeNull();
        view.rerender(<LiveTile {...props} zoom={2} />);
        await act(async () => { images[0].onload?.(); await Promise.resolve(); });
        expect(getTileUrl).toHaveBeenCalledTimes(2);
    });

    it('AUDIT §R24.04 / F2: preview chuyển sang Output Preview còn hiện tới khi PPE ready', async () => {
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
        const page = document.createElement('div');
        vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 } as DOMRect);
        const pending: Array<{ resolve: (source: TileUrlSource) => void; stage: string | undefined }> = [];
        const getTileUrl = vi.fn((...args: unknown[]) => new Promise<TileUrlSource>(resolve => {
            pending.push({ resolve, stage: (args[7] as { colorStage?: string } | undefined)?.colorStage });
        }));
        const bitmapSource = (scale: number): TileUrlSource => ({
            url: `pxrg:audit:${scale}`,
            byteLength: 640 * 480 * scale * scale * 4,
            bitmap: { width: 640 * scale, height: 480 * scale, close: vi.fn() } as unknown as ImageBitmap,
        });
        const view = render(<TileLayer
            fileKey="audit-accurate"
            displayFileKey="audit-display"
            pageNum={1}
            zoom={3}
            dpr={1}
            rotation={0}
            displayWidth={640}
            displayHeight={480}
            containerRef={{ current: page }}
            getTileUrl={getTileUrl as never}
            onVisible={vi.fn()}
            accurateColor
            accurateCommitted={false}
            keepDisplayUntilAccurate
        />);
        expect(pending.some(item => item.stage === undefined)).toBe(true);
        expect(pending.some(item => item.stage === 'accurate')).toBe(true);
        await act(async () => { pending.find(item => item.stage === undefined)!.resolve(bitmapSource(1)); });
        // Frame display đã được draw; PPE vẫn pending. Ít nhất một canvas có pixel phải còn được giữ.
        expect(Array.from(view.container.querySelectorAll('canvas')).some(canvas => canvas.width === 640 && canvas.height === 480)).toBe(true);
    });

    it.each([
        { stableUnderlayReady: false, keepDisplayUntilAccurate: false },
        { stableUnderlayReady: true, keepDisplayUntilAccurate: false },
        { stableUnderlayReady: false, keepDisplayUntilAccurate: true },
        { stableUnderlayReady: true, keepDisplayUntilAccurate: true },
    ])('R24.07: zoom giữ PPE trên cùng khi target đang tải (%j)', async options => {
        const { props, pending, source } = makeViewportHarness(options);
        const view = render(<TileLayer {...props} />);
        await act(async () => { pending.find(item => item.stage === 'accurate' && item.priority === 0)!.resolve(source('PPE-A', 3)); });
        const oldCanvas = visibleViewportCanvases(view.container).at(-1);
        expect(presentedViewportTile(oldCanvas)?.sourceToken).toContain('PPE-A');
        view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await waitFor(() => expect(pending.some(item => item.stage === 'accurate' && item.zoom === 4 && item.priority === 0)).toBe(true));
        // Nếu policy phát nhầm display, cho nó về trước để assertion bắt đúng flash đã audit.
        await act(async () => { pending.find(item => item.stage === undefined && item.zoom === 4)?.resolve(source('DISPLAY-B', 4)); });
        expect(visibleViewportCanvases(view.container).at(-1)).toBe(oldCanvas);
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.accurateOnly).toBe(true);
        expect(pending.every(item => item.stage === 'accurate')).toBe(true);
        await act(async () => { pending.find(item => item.stage === 'accurate' && item.zoom === 4 && item.priority === 0)!.resolve(source('PPE-B', 4)); });
        await waitFor(() => expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('PPE-B'));
        await waitFor(() => expect(view.container.contains(oldCanvas!)).toBe(false));
    });

    it('R24.07: cold-open trang PPE không dựng hoặc khôi phục bitmap display đã cache', async () => {
        const { props, pending, source } = makeViewportHarness({ accurateCommitted: false });
        cacheTileUrl(`${props.displayFileKey}_1_3_0_0_0_640_480`, source('DISPLAY-CACHED', 3), props.displayFileKey!);
        const view = render(<TileLayer {...props} />);
        expect(pending.length).toBeGreaterThan(0);
        expect(pending.every(item => item.stage === 'accurate')).toBe(true);
        expect(visibleViewportCanvases(view.container)).toHaveLength(0);
        await act(async () => { pending.find(item => item.stage === 'accurate' && item.priority === 0)!.resolve(source('PPE-FIRST', 3)); });
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))).toMatchObject({ accurateOnly: true });
    });

    it('R24.07: trang display-only vẫn thay viewport khi zoom mà không gọi PPE', async () => {
        const { props, pending, source } = makeViewportHarness({ accurateColor: false, accurateCommitted: false });
        const view = render(<TileLayer {...props} />);
        await act(async () => { pending.find(item => item.priority === 0)!.resolve(source('DISPLAY-A', 3)); });
        view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await waitFor(() => expect(pending.some(item => item.zoom === 4)).toBe(true));
        await act(async () => { pending.find(item => item.zoom === 4)!.resolve(source('DISPLAY-B', 4)); });
        await waitFor(() => expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('DISPLAY-B'));
        expect(pending.every(item => item.stage !== 'accurate')).toBe(true);
    });

    it('R24.07: sau khi Output Preview commit, zoom không bật lại display', async () => {
        const { props, pending, source } = makeViewportHarness({ accurateCommitted: false, keepDisplayUntilAccurate: true });
        const view = render(<TileLayer {...props} />);
        await act(async () => { pending.find(item => item.stage === undefined)!.resolve(source('DISPLAY-PREVIEW', 3)); });
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.accurateOnly).toBe(false);
        await act(async () => { pending.find(item => item.stage === 'accurate' && item.priority === 0)!.resolve(source('PPE-PREVIEW', 3)); });
        view.rerender(<TileLayer {...props} accurateCommitted />);
        const displayRequestsBeforeZoom = pending.filter(item => item.stage === undefined).length;
        view.rerender(<TileLayer {...props} accurateCommitted zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await waitFor(() => expect(pending.some(item => item.stage === 'accurate' && item.zoom === 4 && item.priority === 0)).toBe(true));
        expect(pending.filter(item => item.stage === undefined)).toHaveLength(displayRequestsBeforeZoom);
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('PPE-PREVIEW');
    });

    it('R24.07/R24.08: PPE B hoàn tất trước C, không bật lại display', async () => {
        const { props, pending, source } = makeViewportHarness();
        const view = render(<TileLayer {...props} />);
        await act(async () => { pending.find(item => item.stage === 'accurate' && item.priority === 0)!.resolve(source('PPE-A', 3)); });
        view.rerender(<TileLayer {...props} zoom={4} displayWidth={640 * 4 / 3} displayHeight={640} />);
        await waitFor(() => expect(pending.some(item => item.zoom === 4 && item.priority === 0 && item.stage === 'accurate')).toBe(true));
        const admitted = pending.find(item => item.zoom === 4 && item.priority === 0 && item.stage === 'accurate')!;
        view.rerender(<TileLayer {...props} zoom={5} displayWidth={640 * 5 / 3} displayHeight={800} />);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 32)); });
        expect(pending.some(item => item.zoom === 5 && item.priority === 0)).toBe(false);
        await act(async () => { admitted.resolve(source('PPE-B', 4)); });
        await waitFor(() => expect(pending.some(item => item.zoom === 5 && item.priority === 0 && item.stage === 'accurate')).toBe(true));
        expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('PPE-B');
        await act(async () => { pending.find(item => item.zoom === 5 && item.priority === 0 && item.stage === 'accurate')!.resolve(source('PPE-C', 5)); });
        await waitFor(() => expect(presentedViewportTile(visibleViewportCanvases(view.container).at(-1))?.sourceToken).toContain('PPE-C'));
        expect(pending.every(item => item.stage === 'accurate')).toBe(true);
    });

    it('R24.07: zoom-out thiếu coverage giữ PPE ở vùng giao nhau rồi PPE mới phủ mép còn thiếu', async () => {
        const { props, pending, source, pageBounds } = makeViewportHarness({
            zoom: 6, displayWidth: 2560, displayHeight: 1920,
        });
        pageBounds.mockReturnValue({ left: -800, top: -600, right: 1760, bottom: 1320, width: 2560, height: 1920 } as DOMRect);
        const view = render(<TileLayer {...props} />);
        await act(async () => { pending.find(item => item.priority === 0)!.resolve(source('PPE-ZOOM-IN', 6)); });
        const oldCanvas = view.container.querySelector<HTMLCanvasElement>('canvas[data-prynx-presented-tile]')!;
        pageBounds.mockReturnValue({ left: 0, top: 0, right: 1280, bottom: 960, width: 1280, height: 960 } as DOMRect);
        view.rerender(<TileLayer {...props} zoom={3} displayWidth={1280} displayHeight={960} />);
        await waitFor(() => expect(pending.some(item => item.zoom === 3 && item.priority === 0)).toBe(true));
        const oldTile = oldCanvas.closest<HTMLElement>('.tile-container')!;
        const overlapX = Number.parseFloat(oldTile.style.left) + 1;
        const overlapY = Number.parseFloat(oldTile.style.top) + 1;
        expect(overlapX).toBeGreaterThan(1);
        expect(overlapX).toBeLessThan(640);
        expect(overlapY).toBeLessThan(480);
        expect(visibleViewportCanvases(view.container, overlapX, overlapY).at(-1)).toBe(oldCanvas);
        // Chưa có underlay: không tuyên bố mép mới đã có pixel trước target; chỉ giữ phần giao nhau.
        expect(visibleViewportCanvases(view.container, 1, 1)).toHaveLength(0);
        expect(pending.every(item => item.stage === 'accurate')).toBe(true);
        await act(async () => { pending.find(item => item.zoom === 3 && item.priority === 0)!.resolve(source('PPE-ZOOM-OUT', 3)); });
        await waitFor(() => expect(presentedViewportTile(visibleViewportCanvases(view.container, 1, 1).at(-1))?.sourceToken).toContain('PPE-ZOOM-OUT'));
    });

    it('R24.07/R24.08: pan giữ PPE và bitmap B dùng đúng clip trước khi C hoàn tất', async () => {
        const { props, pending, source, pageBounds, scroller } = makeViewportHarness({ displayWidth: 2048, displayHeight: 1536 });
        const movePage = (left: number) => pageBounds.mockReturnValue({
            left, top: 0, right: left + 2048, bottom: 1536, width: 2048, height: 1536,
        } as DOMRect);
        movePage(0);
        const view = render(<TileLayer {...props} />);
        await act(async () => { pending.find(item => item.priority === 0)!.resolve(source('PPE-PAN-A', 3)); });
        movePage(-256);
        fireEvent.scroll(scroller);
        await waitFor(() => expect(pending.some(item => item.priority === 0 && item.clipX === 256)).toBe(true));
        const admitted = pending.find(item => item.priority === 0 && item.clipX === 256)!;
        expect(presentedViewportTile(visibleViewportCanvases(view.container, 320, 240).at(-1))?.sourceToken).toContain('PPE-PAN-A');
        movePage(-512);
        fireEvent.scroll(scroller);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 32)); });
        expect(pending.some(item => item.priority === 0 && item.clipX === 512)).toBe(false);
        await act(async () => { admitted.resolve(source('PPE-PAN-B', 3)); });
        await waitFor(() => expect(pending.some(item => item.priority === 0 && item.clipX === 512)).toBe(true));
        const canvasB = visibleViewportCanvases(view.container, 576, 240).at(-1)!;
        expect(presentedViewportTile(canvasB)?.sourceToken).toContain('PPE-PAN-B');
        expect(canvasB.closest<HTMLElement>('.tile-container')!.style.left).toBe('256px');
        await act(async () => { pending.find(item => item.priority === 0 && item.clipX === 512)!.resolve(source('PPE-PAN-C', 3)); });
        await waitFor(() => expect(presentedViewportTile(visibleViewportCanvases(view.container, 576, 240).at(-1))?.sourceToken).toContain('PPE-PAN-C'));
        expect(pending.every(item => item.stage === 'accurate')).toBe(true);
    });
});
