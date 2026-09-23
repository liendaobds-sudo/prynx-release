// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveTile, shouldSettleAccurateTarget } from './LivePageFrame';
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

describe('LiveTile — cold-open màu chính xác', () => {
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
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        view.rerender(<LiveTile {...base} zoom={1} />);
        act(() => { observed?._loadTile?.(); });
        expect(getTileUrl).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(249); });
        expect(getTileUrl).not.toHaveBeenCalled();
        expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:prime-settle');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(getTileUrl).toHaveBeenCalledWith(1, 0, 1, 0, 0, 0, 0,
            expect.objectContaining({ colorStage: 'accurate' }));
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
});
