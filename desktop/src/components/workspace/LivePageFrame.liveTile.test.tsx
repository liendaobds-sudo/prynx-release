// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    LiveTile,
    shouldEnableViewerViewportAccurateTile,
    shouldMountViewerViewportLayer,
    shouldRenderViewerAccurateBaseTile,
    shouldRenderViewerBaseTile,
    shouldKeepViewerAccurateBaseMounted,
    shouldRequestViewerAccurateBase,
    shouldUseViewerDirectFullPageSurface,
    viewerPanGridRenderPolicy,
    VIEWER_RASTER_IMAGE_RENDERING,
    viewerSurfaceSwapMs,
} from './LivePageFrame';
import { cacheTileUrl, clearTileUrlCache } from '../../lib/tileUrlCache';
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

afterEach(() => {
    cleanup();
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
        const getTileUrl = vi.fn((..._args: unknown[]) => new Promise<never>(() => {}));
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
        const getTileUrl = vi.fn((..._args: unknown[]) => new Promise<never>(() => {}));
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
        const cachedUrl = 'blob:http://localhost/adjacent-underlay';
        cacheTileUrl(
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate_1_0.75_0_0_0_0_0',
            { url: cachedUrl, byteLength: 64, cacheable: true },
            'D:\\jobs\\gradient.pdf|revision:r1|color:accurate',
        );
        const baseProps = makeProps({
            getTileUrl,
            accurateOnly: true,
            zoom: 0.75,
            renderPriority: 20,
        });
        const view = render(<LiveTile {...baseProps} />);

        await act(async () => { await Promise.resolve(); });
        const image = view.container.querySelector('img')!;
        fireEvent.load(image);
        const onRenderReady = vi.fn();
        view.rerender(<LiveTile {...baseProps} onRenderReady={onRenderReady} />);

        await waitFor(() => expect(onRenderReady).toHaveBeenCalledTimes(1));
        expect(getTileUrl).not.toHaveBeenCalled();
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
        const getTileUrl = vi.fn(() => new Promise<never>(() => {}));
        const onRenderReady = vi.fn();
        const baseProps = makeProps({
            getTileUrl,
            accurateOnly: true,
        });
        const view = render(
            <LiveTile {...baseProps}
                renderPriority={100}
                showLoadStatus={false}
            />,
        );
        await waitFor(() => expect(getTileUrl).toHaveBeenCalledTimes(1));

        view.rerender(
            <LiveTile {...baseProps}
                renderPriority={10}
                showLoadStatus={true}
                onRenderReady={onRenderReady}
            />,
        );
        await act(async () => {
            await Promise.resolve();
        });

        expect(getTileUrl).toHaveBeenCalledTimes(1);
        expect(onRenderReady).not.toHaveBeenCalled();
    });

    it('cold-open xin thẳng PPE target nét, không phát coarse 24 DPI', async () => {
        const getTileUrl = vi.fn(async (..._args: unknown[]) => ({
            url: `blob:http://localhost/accurate-${getTileUrl.mock.calls.length}`,
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
});
