import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { reduceWheelNav, createWheelNavState, type WheelNavInput } from './wheelPageNav';
import { viewerTraceLog } from '../../lib/previewPerfLog';
import {
    capturePageViewportAnchor,
    capturePagePointViewportAnchor,
    centerHorizontalOverflow,
    restorePageViewportAnchor,
    restorePagePointViewportAnchor,
    type PageViewportAnchor,
    type PagePointViewportAnchor,
} from '../../lib/pageViewport';
import type { ViewerFitPageSize } from '../../lib/viewerPageIdentity';

// Padding hàng trang (AcrobatViewer): L/R 24+24, T/B 32+32, gap 12 giữa 2 trang.
// SAFETY: scrollbar-gutter both-edges + subpixel — zoom sát 100% khung → tràn 1–2px
// → CSS `safe center` rơi về start → dính góc trên-trái.
const FIT_PAD_X_SINGLE = 48; // 24+24
const FIT_PAD_Y = 64;        // 32+32
const FIT_GAP = 12;
const FIT_SAFETY = 12;

interface ViewerZoomTarget {
    mouseX: number;
    mouseY: number;
    clientX?: number;
    clientY?: number;
    ratio: number;
    pageId?: string;
    pageAnchor?: PagePointViewportAnchor;
}

function renderedZoomPage(scroller: HTMLElement, pageId: string): HTMLElement | null {
    const container = scroller.querySelector<HTMLElement>(`#${pageId}`);
    if (!container) return null;
    return (container.lastElementChild as HTMLElement | null) || container;
}

interface UseViewerZoomProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
    sidebarRef: React.RefObject<HTMLDivElement | null>;
    internalScrollRef: React.MutableRefObject<HTMLElement | null>;
    numPages: number;
    zoom: number;
    setZoom: (z: number) => void;
    fitMode: string;
    setFitMode: (m: string) => void;
    fitPageSizes: readonly ViewerFitPageSize[];
    pageDisplayMode: string;
    setPageDisplayMode: (m: string) => void;
    activePage: number;
    actualWidth100: number;
    navigatePage: (p: number) => void;
    toolMode: 'pointer' | 'hand' | 'dimension';
    hasRightPanelTool?: boolean;
}

export function useViewerZoom(props: UseViewerZoomProps) {
    const {
        containerRef, sidebarRef, internalScrollRef,
        numPages, zoom, setZoom, fitMode, setFitMode,
        fitPageSizes, pageDisplayMode, activePage, actualWidth100,
        navigatePage, toolMode, hasRightPanelTool,
    } = props;

    const [mainWidth, setMainWidth] = useState(0);
    const [mainHeight, setMainHeight] = useState(0);
    const mainWidthRef = useRef(0);
    const [isZoomReady, setIsZoomReady] = useState(false);
    const [thumbBaseWidth, setThumbBaseWidth] = useState(110);

    // Khi user kéo thu hẹp panel thumbnail → clamp base width để không cắt nửa phải.
    useEffect(() => {
        mainWidthRef.current = mainWidth;
    }, [mainWidth]);

    useEffect(() => {
        const onPanelResize = (e: Event) => {
            const w = (e as CustomEvent).detail?.width as number | undefined;
            if (!w || w < 40) return;
            const maxByPanel = Math.max(50, Math.floor((w - 52) * 0.72));
            setThumbBaseWidth(prev => Math.min(prev, maxByPanel));
        };
        window.addEventListener('prynx-thumb-panel-resized', onPanelResize);
        return () => window.removeEventListener('prynx-thumb-panel-resized', onPanelResize);
    }, []);

    const currentZoomRef = useRef(zoom);
    useEffect(() => { currentZoomRef.current = zoom; }, [zoom]);

    const activePageRef = useRef(activePage);
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);
    const zoomTargetRef = useRef<ViewerZoomTarget | null>(null);
    const isZoomingRef = useRef(false);
    const zoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingZoomRef = useRef<number | null>(null);
    // Trạng thái điều hướng trang bằng wheel (chuẩn hoá chuột + trackpad) — xem wheelPageNav.ts.
    const wheelNavStateRef = useRef(createWheelNavState());
    const lastZoomMouseRef = useRef<Omit<ViewerZoomTarget, 'ratio'> | null>(null);
    const zoomRafRef = useRef<number | null>(null);
    // UIUX (feedback 2026-08-16 §VIEW.ZOOM-CENTER): điểm trên trang đang nằm ở TÂM khung
    // nhìn, cập nhật liên tục theo cuộn/zoom. Nút +/- và menu zoom không có toạ độ con trỏ
    // nên phải neo hình học theo tâm; công thức cũ theo gốc scroll kéo lệch về góc trên-trái
    // khi trang được canh giữa (flex items-center) — đúng lỗi người dùng gặp ở tem AI.
    const centerAnchorRef = useRef<{ pageId: string; anchor: PageViewportAnchor } | null>(null);

    // ═══ Fit Mode Helpers ═══
    const getScrollViewport = useCallback(() => {
        const scrollEl = internalScrollRef.current;
        if (scrollEl && scrollEl.clientWidth > 50 && scrollEl.clientHeight > 50) {
            return { w: scrollEl.clientWidth, h: scrollEl.clientHeight };
        }
        // Fallback: containerRef / mainWidth (trước khi scroller mount)
        const cw = mainWidth > 50 ? mainWidth : (containerRef.current?.clientWidth || 0);
        const ch = mainHeight > 50 ? mainHeight : (containerRef.current?.clientHeight || 0);
        return { w: cw, h: ch };
    }, [internalScrollRef, containerRef, mainWidth, mainHeight]);

    const getFitGeometry = useCallback(() => {
        const validSizes = fitPageSizes.filter(size => size.width > 0 && size.height > 0);
        if (validSizes.length > 0) {
            return {
                pages: validSizes.length,
                totalWidth: validSizes.reduce((sum, size) => sum + size.width, 0),
                maxHeight: Math.max(...validSizes.map(size => size.height)),
            };
        }
        return actualWidth100 > 0
            ? { pages: 1, totalWidth: actualWidth100, maxHeight: actualWidth100 * 1.414 }
            : null;
    }, [actualWidth100, fitPageSizes]);

    /** Zoom vừa chiều ngang theo tổng chiều rộng thật của active page/spread. */
    const calcFitWidthZoom = useCallback(() => {
        const geometry = getFitGeometry();
        if (!geometry) return 1;
        const padX = FIT_PAD_X_SINGLE + FIT_GAP * (geometry.pages - 1) + FIT_SAFETY;
        const { w } = getScrollViewport();
        const available = Math.max(50, w - padX);
        return available / geometry.totalWidth;
    }, [getFitGeometry, getScrollViewport]);

    /** Zoom vừa trọn spread: tổng width + max height của đúng các trang trong hàng. */
    const calcFitPageZoom = useCallback(() => {
        const geometry = getFitGeometry();
        if (!geometry) return 1;
        const padX = FIT_PAD_X_SINGLE + FIT_GAP * (geometry.pages - 1) + FIT_SAFETY;
        const padY = FIT_PAD_Y + FIT_SAFETY;
        const { w, h } = getScrollViewport();
        const availW = Math.max(50, w - padX);
        const availH = Math.max(50, h - padY);
        return Math.min(availW / geometry.totalWidth, availH / geometry.maxHeight);
    }, [getFitGeometry, getScrollViewport]);

    const applyFitWidth = useCallback(() => {
        const target = calcFitWidthZoom();
        setZoom(target);
        setFitMode('width');
    }, [calcFitWidthZoom, setZoom, setFitMode]);

    const applyFitPage = useCallback(() => {
        const target = calcFitPageZoom();
        setZoom(target);
        setFitMode('page');
    }, [calcFitPageZoom, setZoom, setFitMode]);

    // ═══ Auto-zoom on fitMode / container resize ═══
    /* eslint-disable react-hooks/set-state-in-effect -- state zoom/isReady đồng bộ layout viewport chủ đích. */
    useEffect(() => {
        const hasFitGeometry = getFitGeometry() !== null;
        if (fitMode === 'width' && hasFitGeometry && (mainWidth > 50 || internalScrollRef.current)) {
            setZoom(calcFitWidthZoom());
            setIsZoomReady(true);
        } else if ((fitMode === 'page' || fitMode === 'smart') && hasFitGeometry) {
            if (mainWidth < 50 && mainHeight < 50 && !internalScrollRef.current) return;
            let z = calcFitPageZoom();
            if (fitMode === 'smart') z = Math.min(1, z);
            setZoom(z);
            setIsZoomReady(true);
        } else if (hasFitGeometry && fitMode === 'custom') {
            setIsZoomReady(true);
            // UIUX: Đảm bảo khi đang mở bảng thiết lập công cụ bên phải, các bảng thiết lập
            // TUYỆT ĐỐI KHÔNG ĐƯỢC ĐÈ LÊN TRANG VIEW. Nếu zoom hiện tại khiến trang tràn/bị bảng che khuất:
            // Tự động thu nhỏ lại để vừa trọn khung nhìn (như mẫu).
            if (hasRightPanelTool) {
                const maxFit = calcFitPageZoom();
                if (currentZoomRef.current > maxFit + 0.005) {
                    setZoom(Math.min(1.0, maxFit));
                }
            }
        }
    }, [mainWidth, mainHeight, fitMode, getFitGeometry, calcFitWidthZoom, calcFitPageZoom, setZoom, internalScrollRef, hasRightPanelTool]);
    /* eslint-enable react-hooks/set-state-in-effect */

    // Sau fit: căn giữa THEO TRANG ĐANG XEM (anchor #pdf-page-container-N), không theo
    // tổng scrollWidth/Height. UIUX (audit 2026-07-27 §C-02) fix-verify: cách cũ
    // scrollLeft/Top = max/2 căn tâm của KHỐI NỘI DUNG TỔNG — ở chế độ xem-một-trang
    // các trang đã ghé thăm vẫn mounted (ẩn) phình scrollWidth → trang thật bị đẩy
    // lệch trái chui dưới thước/cột thumbnail; ở chế độ cuộn dọc max/2 còn nhảy tới
    // GIỮA tài liệu. Căn theo anchor thì đúng mọi chế độ; thiếu anchor → chỉ căn
    // ngang, tuyệt đối không đụng scrollTop.
    useLayoutEffect(() => {
        // Không phụ thuộc activePage: cuộn làm đổi trang active không được tự ghi scrollTop
        // rồi phát sinh vòng phản hồi scroll → activePage → scroll.
        if (fitMode !== 'width' && fitMode !== 'page' && fitMode !== 'smart') return;
        const el = internalScrollRef.current;
        if (!el) return;
        // Đợi layout áp dụng width trang sau setZoom
        const id = requestAnimationFrame(() => {
            const anchor = el.querySelector<HTMLElement>(`#pdf-page-container-${activePageRef.current}`);
            if (anchor) {
                const er = el.getBoundingClientRect();
                const ar = anchor.getBoundingClientRect();
                el.scrollLeft += (ar.left + ar.width / 2) - (er.left + er.width / 2);
                el.scrollTop += (ar.top + ar.height / 2) - (er.top + er.height / 2);
            } else {
                const maxL = el.scrollWidth - el.clientWidth;
                el.scrollLeft = maxL > 1 ? maxL / 2 : 0;
            }
        });
        return () => cancelAnimationFrame(id);
    }, [zoom, fitMode, internalScrollRef]);

    // UIUX (feedback 2026-08-21 §VIEW.TWO-PAGE): khi chuyển sang hai trang ở mức
    // zoom tùy chỉnh, hàng trang có thể rộng hơn viewport. `safe center` cố ý neo
    // hàng ở mép trái để phần đầu vẫn cuộn tới được; đặt scrollLeft vào giữa phần
    // dư để hai trang không bị dồn/cắt riêng bên phải. Chạy lại khi viewport đổi
    // (mở/đóng/kéo sidebar), nhưng không phụ thuộc zoom để khỏi phá neo con trỏ.
    useLayoutEffect(() => {
        if (!pageDisplayMode.startsWith('two_')) return;
        const el = internalScrollRef.current;
        if (!el) return;
        let secondFrame = 0;
        const firstFrame = requestAnimationFrame(() => {
            centerHorizontalOverflow(el);
            secondFrame = requestAnimationFrame(() => centerHorizontalOverflow(el));
        });
        return () => {
            cancelAnimationFrame(firstFrame);
            if (secondFrame) cancelAnimationFrame(secondFrame);
        };
    }, [pageDisplayMode, mainWidth, internalScrollRef]);

    // Callback được dùng bởi các effect khai báo trước hàm updateViewportRect bên dưới.
    // Ref giữ closure mới nhất mà không đổi thứ tự hook/listener.
    const updateViewportRectRef = useRef<() => void>(() => undefined);

    // ═══ Fallback measurement when numPages changes ═══
    useEffect(() => {
        if (numPages > 0) {
            const timer = setTimeout(() => {
                if (containerRef.current) {
                    const w = containerRef.current.clientWidth - 2;
                    const h = containerRef.current.clientHeight;
                    if (w > 50 && h > 50) {
                        setMainWidth(w);
                        setMainHeight(h);
                    }
                }
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [numPages, containerRef]);

    // ═══ ResizeObserver ═══
    useEffect(() => {
        if (!containerRef.current) return;
        let frame: number;
        let timeoutId: NodeJS.Timeout;
        const observer = new ResizeObserver((entries) => {
            if (entries[0] && entries[0].contentRect.width > 50) {
                clearTimeout(timeoutId);
                const w = entries[0].contentRect.width - 2;
                const h = entries[0].contentRect.height;
                const isSignificant = Math.abs(w - (mainWidthRef.current || 0)) > 20;
                const delay = mainWidthRef.current === 0 ? 50 : isSignificant ? 30 : 80;
                timeoutId = setTimeout(() => {
                    cancelAnimationFrame(frame);
                    frame = requestAnimationFrame(() => {
                        setMainWidth(w);
                        setMainHeight(h);
                        // Callback được gọi sau khi hook khởi tạo; giữ thứ tự để tránh tạo closure mới mỗi render.
                        updateViewportRectRef.current();
                    });
                }, delay);
            }
        });
        observer.observe(containerRef.current);
        return () => {
            clearTimeout(timeoutId);
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [numPages, containerRef]);

    // ═══ Zoom anchor (giữ điểm focus sau khi zoom) ═══
    // Ghi lại điểm trang ở TÂM khung nhìn (trước khi zoom kế tiếp). Dùng cho nút +/-,
    // menu và mọi zoom không có toạ độ con trỏ — neo hình học nên đúng cả khi trang
    // được canh giữa, thay vì công thức theo gốc scroll kéo về góc trên-trái.
    const trackCenterAnchor = useCallback(() => {
        const el = internalScrollRef.current;
        if (!el) return;
        const pageId = `pdf-page-container-${activePageRef.current}`;
        const page = renderedZoomPage(el, pageId);
        if (!page) return;
        const anchor = capturePageViewportAnchor(el, page);
        if (anchor) centerAnchorRef.current = { pageId, anchor };
    }, [internalScrollRef]);

    useLayoutEffect(() => {
        const el = internalScrollRef.current;
        if (!el) return;
        void viewerTraceLog('zoom-layout', {
            page: activePageRef.current, zoom, fit_mode: fitMode,
            viewport_w: el.clientWidth, viewport_h: el.clientHeight,
            scroll_x: el.scrollLeft, scroll_y: el.scrollTop,
        });
        let focal = zoomTargetRef.current;
        if (!focal) {
            // Không có tâm con trỏ (nút +/- hoặc nhập %): neo về TÂM khung nhìn — chỉ khi đang
            // zoom thủ công (custom) và nội dung tràn (có gì để cuộn). Tránh phá fit-width/page.
            if (fitMode !== 'custom') { trackCenterAnchor(); return; }
            const old = currentZoomRef.current; // zoom TRƯỚC (currentZoomRef cập nhật ở useEffect chạy SAU)
            if (old <= 0 || Math.abs(zoom - old) < 1e-4) { trackCenterAnchor(); return; }
            const scrollable = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
            if (!scrollable) { trackCenterAnchor(); return; }
            // Neo hình học theo điểm-tâm đã ghi TRƯỚC khi width trang đổi. Đúng cả với
            // layout canh giữa; công thức theo gốc scroll cũ lệch −(offset canh giữa).
            const centered = centerAnchorRef.current;
            const centerPage = centered ? renderedZoomPage(el, centered.pageId) : null;
            if (centered && centerPage && restorePageViewportAnchor(el, centerPage, centered.anchor)) {
                trackCenterAnchor();
                zoomTargetRef.current = null;
                updateViewportRectRef.current();
                return;
            }
            focal = { mouseX: el.clientWidth / 2, mouseY: el.clientHeight / 2, ratio: zoom / old };
        }
        // PERF/UIUX (feedback 2026-08-16 §VIEW.ZOOM-LATE): kích thước trang đổi TRỄ một
        // frame so với lúc effect [zoom] chạy (đo được: pageW vẫn = cũ khi ratio đã đổi).
        // Nếu chỉ neo một lần ở đây thì neo trên hình học CŨ → cuộn không đổi → trang co/nở
        // từ gốc trên-trái. `pageAnchor`/điểm-tâm là bất biến theo kích thước nên chạy lại
        // hàm neo ở frame kế (sau khi trang đã đổi kích thước) sẽ đặt đúng điểm dưới con trỏ.
        const snapshot = focal;
        const runAnchor = () => {
            const page = snapshot.pageId && snapshot.pageAnchor
                ? renderedZoomPage(el, snapshot.pageId)
                : null;
            const restoredFromPage = Boolean(
                page
                && snapshot.pageAnchor
                && restorePagePointViewportAnchor(el, page, snapshot.pageAnchor),
            );
            if (!restoredFromPage) {
                // Neo-theo-điểm thất bại → neo hình học theo điểm-tâm đã ghi; công thức theo
                // gốc scroll chỉ là phương án chót (sai với layout canh giữa).
                const centered = centerAnchorRef.current;
                const centerPage = centered ? renderedZoomPage(el, centered.pageId) : null;
                const centeredOk = Boolean(
                    centered && centerPage
                    && restorePageViewportAnchor(el, centerPage, centered.anchor),
                );
                if (!centeredOk) {
                    el.scrollLeft = (el.scrollLeft + snapshot.mouseX) * snapshot.ratio - snapshot.mouseX;
                    el.scrollTop = (el.scrollTop + snapshot.mouseY) * snapshot.ratio - snapshot.mouseY;
                }
            }
            updateViewportRectRef.current();
        };
        zoomTargetRef.current = null;
        runAnchor();
        // Neo lại sau khi layout trang mới đã áp dụng (một, rồi hai frame cho chắc), rồi
        // mới ghi lại điểm-tâm để lần zoom sau dùng đúng vị trí ĐÃ neo, không phải vị trí cũ.
        requestAnimationFrame(() => {
            runAnchor();
            requestAnimationFrame(() => {
                runAnchor();
                trackCenterAnchor();
            });
        });
    }, [zoom, fitMode, trackCenterAnchor, internalScrollRef]);

    // Cập nhật điểm-tâm khi người dùng cuộn/pan để lần zoom bằng nút/menu kế tiếp neo
    // đúng chỗ đang xem. Gom bằng rAF; bỏ qua trong lúc zoom tự điều chỉnh scroll.
    useEffect(() => {
        const el = internalScrollRef.current;
        if (!el) return;
        let raf: number | null = null;
        const onScroll = () => {
            if (isZoomingRef.current || raf !== null) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                if (!isZoomingRef.current) {
                    trackCenterAnchor();
                    void viewerTraceLog('viewport-pan', {
                        page: activePageRef.current, zoom: currentZoomRef.current,
                        scroll_x: el.scrollLeft, scroll_y: el.scrollTop,
                        viewport_w: el.clientWidth, viewport_h: el.clientHeight,
                    });
                }
            });
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        trackCenterAnchor();
        return () => {
            el.removeEventListener('scroll', onScroll);
            if (raf !== null) cancelAnimationFrame(raf);
        };
    }, [internalScrollRef, trackCenterAnchor, numPages, activePage]);

    // UIUX (audit 2026-09-25 §R25.GPU.32): DOM và HWND dùng chung trạng thái
    // điều hướng, sống trên Viewer để cooldown không mất khi đổi key trang native.
    const handlePageWheel = useCallback((input: WheelNavInput) => {
        if (!pageDisplayMode.includes('_fit') || numPages <= 0
            || !containerRef.current || containerRef.current.closest('.opacity-0')) return;
        const { state, jump } = reduceWheelNav(wheelNavStateRef.current, input);
        wheelNavStateRef.current = state;
        const step = pageDisplayMode === 'two_fit' ? 2 : 1;
        let target = activePage;
        if (jump > 0) target = Math.min(numPages, activePage + step);
        else if (jump < 0) {
            const rowStart = (activePage - 1) % 2 === 0 ? activePage - 1 : activePage - 2;
            target = pageDisplayMode === 'two_fit' ? Math.max(1, rowStart + 1 - step) : Math.max(1, activePage - 1);
        }
        if (target !== activePage) {
            void viewerTraceLog('wheel-page-navigation', { page_before: activePage, page_target: target,
                delta_y: input.deltaY, at_top: input.atTop, at_bottom: input.atBottom });
            navigatePage(target);
        }
    }, [activePage, numPages, pageDisplayMode, containerRef, navigatePage]);

    // ═══ Wheel handler (Ctrl+Wheel zoom + page-fit scroll-to-page) ═══
    useEffect(() => {
        if (!containerRef.current) return;
        const handleWheel = (e: WheelEvent) => {
            // Guard: bỏ qua nếu viewer này thuộc tab nền (đang bị ẩn bằng opacity-0).
            // Vì listener gắn vào window và mọi tab đều mounted, nếu không chặn thì
            // Ctrl+Wheel sẽ zoom luôn cả các tab khác.
            if (!containerRef.current || containerRef.current.closest('.opacity-0')) return;
            // Chỉ phản hồi khi con trỏ nằm trong viewer hoặc sidebar của tab này.
            const overContainer = containerRef.current.contains(e.target as Node);
            const overSidebar = sidebarRef.current?.contains(e.target as Node) ?? false;
            if (!overContainer && !overSidebar) return;

            // UIUX (audit 2026-09-26 GPU_DIAG): sự kiện này chỉ xuất hiện nếu
            // WebView nhận wheel. Đối chiếu với WndProc để tìm lớp nuốt input.
            const targetElement = e.target instanceof Element ? e.target : null;
            const nativeHost = targetElement?.closest<HTMLElement>('[data-native-diagnostic-id]');
            void viewerTraceLog('GPU_DIAG_FE_WHEEL', {
                page: activePageRef.current, tool: toolMode, zoom: currentZoomRef.current,
                ctrl: e.ctrlKey, shift: e.shiftKey, delta_x: e.deltaX, delta_y: e.deltaY,
                delta_mode: e.deltaMode, client_x: e.clientX, client_y: e.clientY,
                over_sidebar: overSidebar, default_prevented: e.defaultPrevented,
                target_tag: targetElement?.tagName, target_id: targetElement?.id,
                target_class: targetElement?.getAttribute('class'),
                instance: nativeHost?.dataset.nativeDiagnosticId,
                native_visible: nativeHost?.dataset.nativeVisible,
                fallback_hidden: targetElement?.closest<HTMLElement>('[data-native-fallback-hidden]')?.dataset.nativeFallbackHidden,
            });

            if (e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();

                if (sidebarRef.current && sidebarRef.current.contains(e.target as Node)) {
                    // Clamp theo bề rộng panel hiện tại — tránh thumb lớn hơn panel → cắt nửa phải.
                    const panelW = sidebarRef.current.clientWidth || 256;
                    const maxByPanel = Math.max(50, Math.floor((panelW - 52) * 0.72));
                    setThumbBaseWidth(w => {
                        const newW = w + e.deltaY * -0.1;
                        return Math.max(50, Math.min(400, maxByPanel, newW));
                    });
                } else {
                    if (internalScrollRef.current) {
                        const el = internalScrollRef.current;
                        const rect = el.getBoundingClientRect();
                        const mouseX = e.clientX - rect.left;
                        const mouseY = e.clientY - rect.top;
                        const eventElement = e.target instanceof Element ? e.target : null;
                        const hitPageContainer = eventElement?.closest<HTMLElement>(
                            '[id^="pdf-page-container-"]',
                        ) ?? null;
                        const pageContainer = hitPageContainer && el.contains(hitPageContainer)
                            ? hitPageContainer
                            : el.querySelector<HTMLElement>(
                                `#pdf-page-container-${activePageRef.current}`,
                            );
                        const pageElement = pageContainer
                            ? ((pageContainer.lastElementChild as HTMLElement | null) || pageContainer)
                            : null;
                        const pageAnchor = pageElement
                            ? capturePagePointViewportAnchor(
                                el,
                                pageElement,
                                e.clientX,
                                e.clientY,
                            )
                            : null;
                        isZoomingRef.current = true;
                        // Tích luỹ zoom mục tiêu, gom 1 lần/khung-hình bằng rAF rồi ZOOM THẲNG +
                        // neo điểm dưới con trỏ (useLayoutEffect [zoom]). KHÔNG dùng CSS transform
                        // preview nữa — nó làm nội dung phình trong overflow:auto gây scrollbar
                        // nhấp nháy + giật khi commit. Cách này mượt như nút +/- mà vẫn bám con trỏ.
                        pendingZoomRef.current = (pendingZoomRef.current ?? currentZoomRef.current) * Math.exp(e.deltaY * -0.001);
                        pendingZoomRef.current = Math.max(0.01, Math.min(64, pendingZoomRef.current));
                        // PERF (audit 2026-09-25 §R25.03): ghi tại handler thật, trước rAF/setZoom.
                        void viewerTraceLog('zoom-input', {
                            page: activePageRef.current, zoom_before: currentZoomRef.current,
                            zoom_target: pendingZoomRef.current, delta_y: e.deltaY, delta_mode: e.deltaMode,
                            event_time_ms: e.timeStamp,
                            input_delay_ms: e.timeStamp <= performance.now() ? performance.now() - e.timeStamp : undefined,
                            viewport_w: el.clientWidth, viewport_h: el.clientHeight,
                            cursor_x: mouseX, cursor_y: mouseY, rect_left: rect.left, rect_top: rect.top,
                            anchor_page: pageContainer?.id, page_anchor: pageAnchor,
                        });
                        lastZoomMouseRef.current = {
                            mouseX,
                            mouseY,
                            clientX: e.clientX,
                            clientY: e.clientY,
                            pageId: pageContainer?.id,
                            pageAnchor: pageAnchor ?? undefined,
                        };
                        setFitMode('custom');

                        if (zoomRafRef.current == null) {
                            zoomRafRef.current = requestAnimationFrame(() => {
                                zoomRafRef.current = null;
                                const target = pendingZoomRef.current;
                                const old = currentZoomRef.current;
                                if (target != null && Math.abs(target - old) > 1e-4) {
                                    const m = lastZoomMouseRef.current || { mouseX: 0, mouseY: 0 };
                                    zoomTargetRef.current = { ...m, ratio: target / old };
                                    void viewerTraceLog('zoom-dispatch', {
                                        page: activePageRef.current, zoom_before: old, zoom_target: target,
                                        cursor_x: m.mouseX, cursor_y: m.mouseY, anchor_page: m.pageId,
                                    });
                                    setZoom(target);
                                }
                            });
                        }

                        if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
                        zoomTimeoutRef.current = setTimeout(() => {
                            isZoomingRef.current = false;
                            pendingZoomRef.current = null;
                            void viewerTraceLog('zoom-idle', {
                                page: activePageRef.current, zoom: currentZoomRef.current,
                            });
                        }, 200);
                    }
                }
            } else if (pageDisplayMode.includes('_fit') && containerRef.current && containerRef.current.contains(e.target as Node)) {
                const el = internalScrollRef.current;
                if (el && numPages > 0) {
                    const isAtBottom = Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 10;
                    const isAtTop = el.scrollTop < 10;

                    // Chặn scroll-chaining/bounce của trình duyệt khi lăn vượt biên vùng cuộn.
                    const atBoundary = (e.deltaY > 0 && isAtBottom) || (e.deltaY < 0 && isAtTop);
                    if (atBoundary) e.preventDefault();

                    handlePageWheel({
                        deltaY: e.deltaY, deltaMode: e.deltaMode,
                        atTop: isAtTop, atBottom: isAtBottom,
                        timestamp: e.timeStamp, viewportHeight: el.clientHeight,
                    });
                }
            }
        };

        window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
        return () => {
            window.removeEventListener('wheel', handleWheel, { capture: true });
            if (zoomRafRef.current != null) { cancelAnimationFrame(zoomRafRef.current); zoomRafRef.current = null; }
        };
    }, [pageDisplayMode, activePage, numPages, containerRef, sidebarRef, internalScrollRef, setFitMode, setZoom, handlePageWheel, toolMode]);

    // ═══ Hand-tool drag (pan) ═══
    const isDragging = useRef(false);
    const dragStart = useRef({ x: 0, y: 0, sx: 0, sy: 0 });

    const handleDragStart = useCallback((e: React.MouseEvent) => {
        const targetElement = e.target instanceof Element ? e.target : null;
        const nativeHost = targetElement?.closest<HTMLElement>('[data-native-diagnostic-id]');
        void viewerTraceLog('GPU_DIAG_FE_DRAG', { action: 'down', page: activePageRef.current,
            tool: toolMode, client_x: e.clientX, client_y: e.clientY,
            accepted: toolMode === 'hand' && Boolean(internalScrollRef.current),
            instance: nativeHost?.dataset.nativeDiagnosticId, native_visible: nativeHost?.dataset.nativeVisible,
            scroll_x: internalScrollRef.current?.scrollLeft, scroll_y: internalScrollRef.current?.scrollTop });
        if (toolMode !== 'hand' || !internalScrollRef.current) return;
        e.preventDefault();
        isDragging.current = true;
        dragStart.current = {
            x: e.clientX,
            y: e.clientY,
            sx: internalScrollRef.current.scrollLeft,
            sy: internalScrollRef.current.scrollTop
        };

        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';

        const handleDragMove = (me: MouseEvent) => {
            if (!isDragging.current || !internalScrollRef.current) return;
            const dx = me.clientX - dragStart.current.x;
            const dy = me.clientY - dragStart.current.y;
            internalScrollRef.current.scrollLeft = dragStart.current.sx - dx;
            internalScrollRef.current.scrollTop = dragStart.current.sy - dy;
        };

        const handleDragEnd = (me: MouseEvent) => {
            void viewerTraceLog('GPU_DIAG_FE_DRAG', { action: 'up', page: activePageRef.current,
                tool: toolMode, dx: me.clientX - dragStart.current.x, dy: me.clientY - dragStart.current.y,
                scroll_before_x: dragStart.current.sx, scroll_before_y: dragStart.current.sy,
                scroll_after_x: internalScrollRef.current?.scrollLeft, scroll_after_y: internalScrollRef.current?.scrollTop });
            isDragging.current = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', handleDragMove);
            window.removeEventListener('mouseup', handleDragEnd);
        };

        window.addEventListener('mousemove', handleDragMove);
        window.addEventListener('mouseup', handleDragEnd);
    }, [toolMode, internalScrollRef]);

    // ═══ Viewport rect indicator (thumb minimap) ═══
    const updateViewportRect = useCallback(() => {
        const scrollEl = internalScrollRef.current;
        if (!scrollEl || !activePage) return;

        // Scope query trong instance này (ID bị trùng giữa các tab mounted).
        // page footprint = outer box (cùng hệ AABB với data-thumb-footprint trên thumb),
        // KHÔNG lấy khối CSS-rotate bên trong — tránh % lệch khi trang xoay 90°/270° (T3).
        const pageContainer = scrollEl.querySelector(`#pdf-page-container-${activePage}`);
        const pageWrap = pageContainer?.lastElementChild as HTMLElement | null;
        // LivePageFrame container (footprint outer) — class có `/` nên query bằng attribute.
        const pageEl = (pageWrap?.querySelector('[class*="group/pdf-frame"]') as HTMLElement | null)
            || (pageWrap?.firstElementChild as HTMLElement | null)
            || pageWrap;
        const indicatorEl = sidebarRef.current?.querySelector('#thumb-viewport-indicator') as HTMLElement | null;
        if (!pageEl || !indicatorEl) {
            if (indicatorEl) indicatorEl.style.display = 'none';
            return;
        }

        const scrollRect = scrollEl.getBoundingClientRect();
        const pageRect = pageEl.getBoundingClientRect();

        const visibleLeft = Math.max(0, scrollRect.left - pageRect.left);
        const visibleTop = Math.max(0, scrollRect.top - pageRect.top);
        const visibleRight = Math.min(pageRect.width, scrollRect.right - pageRect.left);
        const visibleBottom = Math.min(pageRect.height, scrollRect.bottom - pageRect.top);

        const w = visibleRight - visibleLeft;
        const h = visibleBottom - visibleTop;

        if (w <= 0 || h <= 0) {
            indicatorEl.style.display = 'none';
            return;
        }

        // Khi vùng nhìn phủ (gần như) trọn trang → không có gì để pan, ô minimap vô nghĩa.
        // Ẩn đi để overlay (pointer-events:auto + stopPropagation) KHÔNG chặn thao tác kéo-thả
        // sắp xếp trang trên thumbnail. Indicator chỉ hiện khi đang zoom (nhìn một phần trang).
        if (w >= pageRect.width * 0.995 && h >= pageRect.height * 0.995) {
            indicatorEl.style.display = 'none';
            return;
        }

        indicatorEl.style.display = 'block';
        indicatorEl.style.left = `${(visibleLeft / pageRect.width) * 100}%`;
        indicatorEl.style.top = `${(visibleTop / pageRect.height) * 100}%`;
        indicatorEl.style.width = `${(w / pageRect.width) * 100}%`;
        indicatorEl.style.height = `${(h / pageRect.height) * 100}%`;
        indicatorEl.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.35)';
    }, [activePage, internalScrollRef, sidebarRef]);



    useEffect(() => {
        updateViewportRectRef.current = updateViewportRect;
    }, [updateViewportRect]);

    // Attach scroll/resize listeners for viewport rect
    useEffect(() => {
        const el = internalScrollRef.current;
        if (el) {
            el.addEventListener('scroll', updateViewportRect, { passive: true });
            window.addEventListener('resize', updateViewportRect);
            requestAnimationFrame(() => updateViewportRect());
            return () => {
                el.removeEventListener('scroll', updateViewportRect);
                window.removeEventListener('resize', updateViewportRect);
            };
        }
    }, [updateViewportRect, internalScrollRef]);

    // Ref to hold active viewport drag cleanup
    const activeViewportDragCleanup = useRef<(() => void) | null>(null);

    // Handle viewport rect dragging
    useEffect(() => {
        const handleViewportDragStart = (e: Event) => {
            // Bỏ qua nếu viewer này thuộc tab nền (ID trùng giữa các tab mounted).
            if (!containerRef.current || containerRef.current.closest('.opacity-0')) return;
            // Clean up any existing drag first to prevent multiple listeners
            if (activeViewportDragCleanup.current) {
                activeViewportDragCleanup.current();
                activeViewportDragCleanup.current = null;
            }

            const el = internalScrollRef.current;
            // Scope query trong instance này (ID bị trùng giữa các tab mounted).
            const pageContainer = el?.querySelector(`#pdf-page-container-${activePage}`);
            const pageWrap = pageContainer?.lastElementChild as HTMLElement | null;
            const pageEl = (pageWrap?.querySelector('[class*="group/pdf-frame"]') as HTMLElement | null)
                || (pageWrap?.firstElementChild as HTMLElement | null)
                || pageWrap;
            if (!el || !pageEl) return;

            const detail = (e as CustomEvent<{ x?: unknown; y?: unknown }>).detail;
            const startX = typeof detail?.x === 'number' ? detail.x : 0;
            const startY = typeof detail?.y === 'number' ? detail.y : 0;
            const startScrollX = el.scrollLeft || 0;
            const startScrollY = el.scrollTop || 0;

            const indicatorEl = sidebarRef.current?.querySelector('#thumb-viewport-indicator') as HTMLElement | null;
            const thumbItem = indicatorEl?.closest('.acro-thumb-item') as HTMLElement;
            if (!thumbItem) return;

            // Scale theo footprint slot (AABB sau xoay), không theo <img> trong khối CSS-rotate (T3).
            const thumbFootprint = thumbItem.querySelector('[data-thumb-footprint]') as HTMLElement
                || thumbItem.querySelector('img')
                || thumbItem;
            if (!thumbFootprint) return;

            const pageRect = pageEl.getBoundingClientRect();
            const thumbRect = thumbFootprint.getBoundingClientRect();
            
            const scaleX = (pageRect.width || 1) / Math.max(1, thumbRect.width || 1);
            const scaleY = (pageRect.height || 1) / Math.max(1, thumbRect.height || 1);

            // console.log('[DragStart]');

            const handleDragMove = (me: PointerEvent) => {
                const dx = me.clientX - startX;
                const dy = me.clientY - startY;
                
                if (!isNaN(dx) && !isNaN(scaleX)) {
                    const newScrollLeft = startScrollX + (dx * scaleX);
                    el.scrollLeft = newScrollLeft;
                    // console.log('[DragMove]');
                }
                if (!isNaN(dy) && !isNaN(scaleY)) {
                    const newScrollTop = startScrollY + (dy * scaleY);
                    el.scrollTop = newScrollTop;
                }
            };

            const handleDragEnd = () => {
                window.removeEventListener('pointermove', handleDragMove);
                window.removeEventListener('pointerup', handleDragEnd);
                window.removeEventListener('pointercancel', handleDragEnd);
                activeViewportDragCleanup.current = null;
            };

            window.addEventListener('pointermove', handleDragMove);
            window.addEventListener('pointerup', handleDragEnd);
            window.addEventListener('pointercancel', handleDragEnd);
            
            activeViewportDragCleanup.current = handleDragEnd;
        };

        window.addEventListener('prynx-viewport-drag-start', handleViewportDragStart);
        return () => {
            window.removeEventListener('prynx-viewport-drag-start', handleViewportDragStart);
            if (activeViewportDragCleanup.current) {
                activeViewportDragCleanup.current();
            }
        };
    }, [activePage, containerRef, internalScrollRef, sidebarRef]);

    return {
        mainWidth, mainHeight, isZoomReady,
        thumbBaseWidth, setThumbBaseWidth,
        isZoomingRef,
        lastZoomMouseRef,
        applyFitWidth, applyFitPage,
        handleDragStart, handlePageWheel,
        updateViewportRect,
    };
}
