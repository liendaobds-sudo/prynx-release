import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { reduceWheelNav, createWheelNavState } from './wheelPageNav';

// Padding hàng trang (AcrobatViewer): L/R 24+24, T/B 32+32, gap 12 giữa 2 trang.
// SAFETY: scrollbar-gutter both-edges + subpixel — zoom sát 100% khung → tràn 1–2px
// → CSS `safe center` rơi về start → dính góc trên-trái.
const FIT_PAD_X_SINGLE = 48; // 24+24
const FIT_PAD_Y = 64;        // 32+32
const FIT_GAP = 12;
const FIT_SAFETY = 12;

interface UseViewerZoomProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
    sidebarRef: React.RefObject<HTMLDivElement | null>;
    internalScrollRef: React.MutableRefObject<HTMLElement | null>;
    numPages: number;
    zoom: number;
    setZoom: (z: number) => void;
    fitMode: string;
    setFitMode: (m: string) => void;
    pageDim: { w: number; h: number } | null;
    pageDisplayMode: string;
    setPageDisplayMode: (m: string) => void;
    activePage: number;
    actualWidth100: number;
    navigatePage: (p: number) => void;
    toolMode: 'pointer' | 'hand' | 'dimension';
}

export function useViewerZoom(props: UseViewerZoomProps) {
    const {
        containerRef, sidebarRef, internalScrollRef,
        numPages, zoom, setZoom, fitMode, setFitMode,
        pageDim, pageDisplayMode, setPageDisplayMode, activePage, actualWidth100,
        navigatePage, toolMode,
    } = props;

    const [mainWidth, setMainWidth] = useState(0);
    const [mainHeight, setMainHeight] = useState(0);
    const [isZoomReady, setIsZoomReady] = useState(false);
    const [thumbBaseWidth, setThumbBaseWidth] = useState(110);

    // Khi user kéo thu hẹp panel thumbnail → clamp base width để không cắt nửa phải.
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

    const zoomTargetRef = useRef<{ mouseX: number, mouseY: number, ratio: number } | null>(null);
    const isZoomingRef = useRef(false);
    const zoomTimeoutRef = useRef<any>(null);
    const pendingZoomRef = useRef<number | null>(null);
    // Trạng thái điều hướng trang bằng wheel (chuẩn hoá chuột + trackpad) — xem wheelPageNav.ts.
    const wheelNavStateRef = useRef(createWheelNavState());
    const lastZoomMouseRef = useRef<{ mouseX: number, mouseY: number } | null>(null);
    const zoomRafRef = useRef<number | null>(null);

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

    /** Zoom vừa chiều ngang: (viewport − padding − safety) / (pageWidth × số cột). */
    const calcFitWidthZoom = useCallback(() => {
        if (actualWidth100 <= 0) return 1;
        const numPagesWide = pageDisplayMode.includes('two') ? 2 : 1;
        const padX = FIT_PAD_X_SINGLE + FIT_GAP * (numPagesWide - 1) + FIT_SAFETY;
        const { w } = getScrollViewport();
        const available = Math.max(50, w - padX);
        return available / (actualWidth100 * numPagesWide);
    }, [actualWidth100, pageDisplayMode, getScrollViewport]);

    /** Zoom vừa trọn trang: min(fitW, fitH) theo tỉ lệ trang thật. */
    const calcFitPageZoom = useCallback(() => {
        if (actualWidth100 <= 0) return 1;
        const numPagesWide = pageDisplayMode.includes('two') ? 2 : 1;
        const padX = FIT_PAD_X_SINGLE + FIT_GAP * (numPagesWide - 1) + FIT_SAFETY;
        const padY = FIT_PAD_Y + FIT_SAFETY;
        const { w, h } = getScrollViewport();
        const availW = Math.max(50, w - padX);
        const availH = Math.max(50, h - padY);
        // Chiều cao trang @ zoom=1 (cùng hệ actualWidth100)
        const ratio = (pageDim && pageDim.w > 0 && pageDim.h > 0)
            ? (pageDim.h / pageDim.w)
            : 1.414;
        const pageH100 = actualWidth100 * ratio;
        const zoomW = availW / (actualWidth100 * numPagesWide);
        const zoomH = availH / pageH100;
        return Math.min(zoomW, zoomH);
    }, [actualWidth100, pageDim, pageDisplayMode, getScrollViewport]);

    const applyFitWidth = useCallback(() => {
        setZoom(calcFitWidthZoom());
        setFitMode('width');
    }, [calcFitWidthZoom, setZoom, setFitMode]);

    const applyFitPage = useCallback(() => {
        setZoom(calcFitPageZoom());
        setFitMode('page');
    }, [calcFitPageZoom, setZoom, setFitMode]);

    // ═══ Auto-zoom on fitMode / container resize ═══
    useEffect(() => {
        if (fitMode === 'width' && actualWidth100 > 0 && (mainWidth > 50 || internalScrollRef.current)) {
            setZoom(calcFitWidthZoom());
            setIsZoomReady(true);
        } else if ((fitMode === 'page' || fitMode === 'smart') && actualWidth100 > 0) {
            if (mainWidth < 50 && mainHeight < 50 && !internalScrollRef.current) return;
            let z = calcFitPageZoom();
            if (fitMode === 'smart') z = Math.min(1, z);
            setZoom(z);
            setIsZoomReady(true);
        } else if (actualWidth100 > 0 && fitMode === 'custom') {
            setIsZoomReady(true);
        }
    }, [mainWidth, mainHeight, fitMode, actualWidth100, pageDim, pageDisplayMode, calcFitWidthZoom, calcFitPageZoom]);

    // Sau fit: nếu vẫn tràn nhẹ → căn giữa (tránh dính góc trên-trái do `safe center`).
    // Nếu vừa khít → scroll 0 (không cần pan).
    useLayoutEffect(() => {
        if (fitMode !== 'width' && fitMode !== 'page' && fitMode !== 'smart') return;
        const el = internalScrollRef.current;
        if (!el) return;
        // Đợi layout áp dụng width trang sau setZoom
        const id = requestAnimationFrame(() => {
            const maxL = el.scrollWidth - el.clientWidth;
            const maxT = el.scrollHeight - el.clientHeight;
            el.scrollLeft = maxL > 1 ? maxL / 2 : 0;
            el.scrollTop = maxT > 1 ? maxT / 2 : 0;
        });
        return () => cancelAnimationFrame(id);
    }, [zoom, fitMode, internalScrollRef]);

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
    }, [numPages]);

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
                const delay = mainWidth === 0 ? 100 : 150;
                timeoutId = setTimeout(() => {
                    cancelAnimationFrame(frame);
                    frame = requestAnimationFrame(() => {
                        setMainWidth(w);
                        setMainHeight(h);
                        updateViewportRect();
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
    }, [numPages]);

    // ═══ Zoom anchor (giữ điểm focus sau khi zoom) ═══
    useLayoutEffect(() => {
        const el = internalScrollRef.current;
        if (!el) return;
        let focal = zoomTargetRef.current;
        if (!focal) {
            // Không có tâm con trỏ (nút +/- hoặc nhập %): neo về TÂM khung nhìn — chỉ khi đang
            // zoom thủ công (custom) và nội dung tràn (có gì để cuộn). Tránh phá fit-width/page.
            if (fitMode !== 'custom') return;
            const old = currentZoomRef.current; // zoom TRƯỚC (currentZoomRef cập nhật ở useEffect chạy SAU)
            if (old <= 0 || Math.abs(zoom - old) < 1e-4) return;
            const scrollable = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
            if (!scrollable) return;
            focal = { mouseX: el.clientWidth / 2, mouseY: el.clientHeight / 2, ratio: zoom / old };
        }
        const { mouseX, mouseY, ratio } = focal;
        el.scrollLeft = (el.scrollLeft + mouseX) * ratio - mouseX;
        el.scrollTop = (el.scrollTop + mouseY) * ratio - mouseY;
        zoomTargetRef.current = null;
        updateViewportRect();
    }, [zoom, fitMode]);

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

                        isZoomingRef.current = true;
                        // Tích luỹ zoom mục tiêu, gom 1 lần/khung-hình bằng rAF rồi ZOOM THẲNG +
                        // neo điểm dưới con trỏ (useLayoutEffect [zoom]). KHÔNG dùng CSS transform
                        // preview nữa — nó làm nội dung phình trong overflow:auto gây scrollbar
                        // nhấp nháy + giật khi commit. Cách này mượt như nút +/- mà vẫn bám con trỏ.
                        pendingZoomRef.current = (pendingZoomRef.current ?? currentZoomRef.current) * Math.exp(e.deltaY * -0.001);
                        pendingZoomRef.current = Math.max(0.01, Math.min(64, pendingZoomRef.current));
                        lastZoomMouseRef.current = { mouseX, mouseY };
                        setFitMode('custom');

                        if (zoomRafRef.current == null) {
                            zoomRafRef.current = requestAnimationFrame(() => {
                                zoomRafRef.current = null;
                                const target = pendingZoomRef.current;
                                const old = currentZoomRef.current;
                                if (target != null && Math.abs(target - old) > 1e-4) {
                                    const m = lastZoomMouseRef.current || { mouseX: 0, mouseY: 0 };
                                    zoomTargetRef.current = { mouseX: m.mouseX, mouseY: m.mouseY, ratio: target / old };
                                    setZoom(target);
                                }
                            });
                        }

                        if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
                        zoomTimeoutRef.current = setTimeout(() => {
                            isZoomingRef.current = false;
                            pendingZoomRef.current = null;
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

                    // Quyết định chuyển trang bằng reducer thuần (chuẩn hoá chuột + trackpad).
                    const { state, jump } = reduceWheelNav(wheelNavStateRef.current, {
                        deltaY: e.deltaY,
                        deltaMode: e.deltaMode,
                        atTop: isAtTop,
                        atBottom: isAtBottom,
                        timestamp: e.timeStamp,
                        viewportHeight: el.clientHeight,
                    });
                    wheelNavStateRef.current = state;

                    if (jump > 0) {
                        const step = pageDisplayMode === 'two_fit' ? 2 : 1;
                        const next = Math.min(numPages, activePage + step);
                        if (next !== activePage) navigatePage(next);
                    } else if (jump < 0) {
                        const step = pageDisplayMode === 'two_fit' ? 2 : 1;
                        let prev;
                        if (pageDisplayMode === 'two_fit') {
                            const logicalRowStart = (activePage - 1) % 2 === 0 ? activePage - 1 : activePage - 2;
                            prev = Math.max(1, logicalRowStart + 1 - step);
                        } else {
                            prev = Math.max(1, activePage - 1);
                        }
                        if (prev !== activePage) navigatePage(prev);
                    }
                }
            }
        };

        window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
        return () => {
            window.removeEventListener('wheel', handleWheel, { capture: true });
            if (zoomRafRef.current != null) { cancelAnimationFrame(zoomRafRef.current); zoomRafRef.current = null; }
        };
    }, [pageDisplayMode, activePage, numPages]);

    // ═══ Hand-tool drag (pan) ═══
    const isDragging = useRef(false);
    const dragStart = useRef({ x: 0, y: 0, sx: 0, sy: 0 });

    const handleDragStart = useCallback((e: React.MouseEvent) => {
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

        const handleDragEnd = () => {
            isDragging.current = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', handleDragMove);
            window.removeEventListener('mouseup', handleDragEnd);
        };

        window.addEventListener('mousemove', handleDragMove);
        window.addEventListener('mouseup', handleDragEnd);
    }, [toolMode]);

    // ═══ Viewport rect indicator (thumb minimap) ═══
    const updateViewportRect = useCallback(() => {
        const scrollEl = internalScrollRef.current;
        if (!scrollEl || !activePage) return;

        // Scope query trong instance này (ID bị trùng giữa các tab mounted).
        const pageContainer = scrollEl.querySelector(`#pdf-page-container-${activePage}`);
        const pageEl = pageContainer?.lastElementChild as HTMLElement;
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
    }, [activePage, zoom, internalScrollRef]);

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
    }, [updateViewportRect]);

    // Ref to hold active viewport drag cleanup
    const activeViewportDragCleanup = useRef<(() => void) | null>(null);

    // Handle viewport rect dragging
    useEffect(() => {
        const handleViewportDragStart = (e: any) => {
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
            const pageEl = pageContainer?.lastElementChild as HTMLElement;
            if (!el || !pageEl) return;

            const startX = typeof e.detail?.x === 'number' ? e.detail.x : 0;
            const startY = typeof e.detail?.y === 'number' ? e.detail.y : 0;
            const startScrollX = el.scrollLeft || 0;
            const startScrollY = el.scrollTop || 0;

            const indicatorEl = sidebarRef.current?.querySelector('#thumb-viewport-indicator') as HTMLElement | null;
            const thumbItem = indicatorEl?.closest('.acro-thumb-item') as HTMLElement;
            if (!thumbItem) return;

            const thumbImage = thumbItem.querySelector('img') || thumbItem.querySelector('.bg-white.flex.relative > div');
            if (!thumbImage) return;

            const pageRect = pageEl.getBoundingClientRect();
            const thumbRect = thumbImage.getBoundingClientRect();
            
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
    }, [activePage]);

    return {
        mainWidth, mainHeight, isZoomReady,
        thumbBaseWidth, setThumbBaseWidth,
        isZoomingRef,
        applyFitWidth, applyFitPage,
        handleDragStart,
        updateViewportRect,
    };
}
