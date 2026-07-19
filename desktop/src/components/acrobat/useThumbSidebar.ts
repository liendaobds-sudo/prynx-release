import { useState, useRef, useEffect, Dispatch, SetStateAction } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { genPageId } from '../../hooks/viewer/usePdfLoader';

interface UseThumbSidebarProps {
    pageOrder: number[];
    setPageOrder: Dispatch<SetStateAction<number[]>>;
    pageInstanceIds: string[];
    setPageInstanceIds: Dispatch<SetStateAction<string[]>>;
    setPageRotations: Dispatch<SetStateAction<Record<string, number>>>;
    selectedIndices: Set<number>;
    setSelectedIndices: Dispatch<SetStateAction<Set<number>>>;
    lastSelectedIndex: number | null;
    setLastSelectedIndex: Dispatch<SetStateAction<number | null>>;
    setActivePage: (page: number) => void;
    commitSnapshot: () => void;
    sidebarRef: React.RefObject<HTMLDivElement | null>;
    mainVirtuosoRef?: React.RefObject<any>;
    onNavigatePage: (index: number) => void;
    pdfUrl?: string;
}

export function useThumbSidebar({
    pageOrder, setPageOrder,
    pageInstanceIds, setPageInstanceIds, setPageRotations,
    selectedIndices, setSelectedIndices,
    lastSelectedIndex, setLastSelectedIndex,
    setActivePage, commitSnapshot,
    sidebarRef, onNavigatePage,
    pdfUrl
}: UseThumbSidebarProps) {
    const thumbWidth = useWorkspaceStore(state => state.viewerThumbWidth);
    const setThumbWidth = useWorkspaceStore(state => state.setViewerThumbWidth);
    const isThumbResizing = useRef(false);

    const [isResizing, setIsResizing] = useState(false);

    // DND Page Order State
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [hoverTargetIndex, setHoverTargetIndex] = useState<number | null>(null);
    const [dropPosition, setDropPosition] = useState<'before' | 'after'>('before');
    // Alt+kéo = nhân bản (giữ Alt lúc thả sẽ copy thay vì move). Cờ này chỉ phục vụ hiển thị.
    const [isCopyDrag, setIsCopyDrag] = useState(false);

    // Marquee Selection State
    const [marqueeStart, setMarqueeStart] = useState<{ x: number, y: number } | null>(null);
    const marqueeBoxRef = useRef<HTMLDivElement>(null);
    const [marqueeInitialSelection, setMarqueeInitialSelection] = useState<Set<number>>(new Set());
    // Bản sao mờ của trang bám theo con trỏ khi kéo (giống Acrobat). Tạo bằng DOM thuần,
    // gắn vào document.body để React KHÔNG re-render đè mất (style inline trong JSX sẽ bị
    // áp lại mỗi lần render, nên không dùng JSX cho phần tử này).
    const ghostElRef = useRef<HTMLDivElement | null>(null);

    const removeDragGhost = () => {
        if (ghostElRef.current) {
            ghostElRef.current.remove();
            ghostElRef.current = null;
        }
    };
    // Dọn ghost nếu component unmount giữa chừng.
    useEffect(() => removeDragGhost, []);

    // Marquee Logic Effect
    useEffect(() => {
        if (!marqueeStart) return;

        let scrollRAF: number | null = null;
        let edgeScrollSpeed = 0;
        let lastClientX = marqueeStart.x;
        let lastClientY = marqueeStart.y;
        let currentMarqueeStartY = marqueeStart.y;

        const processMarqueeLogic = (clientX: number, clientY: number) => {
            const rx = Math.min(marqueeStart.x, clientX);
            const ry = Math.min(currentMarqueeStartY, clientY);
            const rw = Math.abs(marqueeStart.x - clientX);
            const rh = Math.abs(currentMarqueeStartY - clientY);

            if (marqueeBoxRef.current) {
                marqueeBoxRef.current.style.left = `${rx}px`;
                marqueeBoxRef.current.style.top = `${ry}px`;
                marqueeBoxRef.current.style.width = `${rw}px`;
                marqueeBoxRef.current.style.height = `${rh}px`;
                marqueeBoxRef.current.style.display = 'block';
            }

            const newSel = new Set(marqueeInitialSelection);

            const thumbItems = document.querySelectorAll('.acro-thumb-item');
            thumbItems.forEach((el) => {
                const rect = el.getBoundingClientRect();
                const intersects = !(
                    rect.right < rx ||
                    rect.left > rx + rw ||
                    rect.bottom < ry ||
                    rect.top > ry + rh
                );

                if (intersects) {
                    const idxStr = el.getAttribute('data-thumb-index');
                    if (idxStr !== null) {
                        const idx = parseInt(idxStr, 10);
                        if (!isNaN(idx)) newSel.add(idx);
                    }
                }
            });

            setSelectedIndices(prev => {
                let changed = false;
                if (newSel.size !== prev.size) {
                    changed = true;
                } else {
                    for (const item of newSel) {
                        if (!prev.has(item)) {
                            changed = true;
                            break;
                        }
                    }
                }
                return changed ? newSel : prev;
            });
        };

        const updateScroll = () => {
            if (edgeScrollSpeed !== 0 && sidebarRef.current) {
                const scrollContainer = sidebarRef.current.querySelector('.acro-thumb-scroll');
                if (scrollContainer) {
                    // Chỉ dịch điểm bắt đầu theo LƯỢNG CUỘN THỰC TẾ. Nếu đã ở đáy/đỉnh
                    // (không cuộn thêm được), actualDelta = 0 nên điểm bắt đầu không trôi
                    // → tránh việc vùng quét lan ngược lên các trang phía trên.
                    const before = scrollContainer.scrollTop;
                    scrollContainer.scrollTop += edgeScrollSpeed;
                    const actualDelta = scrollContainer.scrollTop - before;
                    currentMarqueeStartY -= actualDelta;
                    processMarqueeLogic(lastClientX, lastClientY);
                }
                scrollRAF = requestAnimationFrame(updateScroll);
            } else {
                scrollRAF = null;
            }
        };

        const checkEdgeScroll = (clientY: number) => {
            if (!sidebarRef.current) return;
            const scrollContainer = sidebarRef.current.querySelector('.acro-thumb-scroll');
            if (!scrollContainer) return;
            
            const rect = scrollContainer.getBoundingClientRect();
            const threshold = 60; 
            
            if (clientY < rect.top + threshold) {
                const distance = rect.top + threshold - clientY;
                edgeScrollSpeed = -Math.min(25, Math.max(5, distance * 0.4));
            } else if (clientY > rect.bottom - threshold) {
                const distance = clientY - (rect.bottom - threshold);
                edgeScrollSpeed = Math.min(25, Math.max(5, distance * 0.4));
            } else {
                edgeScrollSpeed = 0;
            }

            if (edgeScrollSpeed !== 0 && !scrollRAF) {
                scrollRAF = requestAnimationFrame(updateScroll);
            }
        };

        const handleMouseMove = (e: MouseEvent) => {
            lastClientX = e.clientX;
            lastClientY = e.clientY;
            
            checkEdgeScroll(e.clientY);
            processMarqueeLogic(e.clientX, e.clientY);
        };

        const handleMouseUp = () => {
            edgeScrollSpeed = 0;
            if (scrollRAF) cancelAnimationFrame(scrollRAF);
            
            setMarqueeStart(null);
            if (marqueeBoxRef.current) {
                marqueeBoxRef.current.style.display = 'none';
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            edgeScrollSpeed = 0;
            if (scrollRAF) cancelAnimationFrame(scrollRAF);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [marqueeStart, marqueeInitialSelection, setSelectedIndices, sidebarRef]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!sidebarRef.current?.contains(document.activeElement)) return;
            if (e.ctrlKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                const newSel = new Set(pageOrder.map((_, i) => i));
                setSelectedIndices(newSel);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [pageOrder, setSelectedIndices, sidebarRef]);

    // Logic chọn trang dùng chung cho cả click chuột lẫn pointerup (vì pointer capture
    // có thể nuốt mất sự kiện click → phải tự xử lý chọn trong pointerup).
    const applyThumbSelection = (index: number, mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
        sidebarRef.current?.focus();
        // Đọc anchor từ ref (KHÔNG từ closure): applyThumbSelection chạy trong
        // handleThumbClick — hàm này tạo mới mỗi render nhưng MemoThumbItem giữ bản CŨ
        // nếu prop của item không đổi (anchor là state toàn cục, không map vào prop item)
        // → closure giữ lastSelectedIndex lệch. Ref luôn có giá trị mới nhất.
        const anchor = latestStateRef.current.lastSelectedIndex;
        if (mods.shiftKey && anchor !== null) {
            const start = Math.min(index, anchor);
            const end = Math.max(index, anchor);
            // Functional updater: KHÔNG đọc selectedIndices từ closure. MemoThumbItem có
            // comparator KHÔNG so handleThumbClick → item không đổi isSelected giữ handler
            // CŨ (đọc selectedIndices stale) → Ctrl/Shift-click bỏ chọn nhầm trang. Updater
            // luôn nhận state mới nhất từ React nên miễn nhiễm handler stale.
            setSelectedIndices(prev => {
                const newSel = new Set(prev);
                for (let i = start; i <= end; i++) newSel.add(i);
                return newSel;
            });
        } else if (mods.ctrlKey || mods.metaKey) {
            setSelectedIndices(prev => {
                const newSel = new Set(prev);
                if (newSel.has(index)) newSel.delete(index);
                else newSel.add(index);
                return newSel;
            });
            setLastSelectedIndex(index);
        } else {
            setSelectedIndices(new Set([index]));
            setLastSelectedIndex(index);
        }
        onNavigatePage(index);
    };

    const handleThumbClick = (e: React.MouseEvent, index: number) => {
        e.preventDefault();
        // Việc chọn trang thường đã được xử lý trong pointerup (do pointer capture nuốt click).
        // Cờ này được bật sau mỗi pointerup → bỏ qua click "thừa" để tránh xử lý hai lần.
        // Nếu vì lý do nào đó pointerup không xử lý (cờ = false) thì click này là fallback.
        if (justDraggedRef.current) {
            justDraggedRef.current = false;
            return;
        }
        applyThumbSelection(index, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
    };

    const handleThumbResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        isThumbResizing.current = true;
        setIsResizing(true);
        document.body.style.cursor = 'col-resize';

        const startX = e.clientX;
        const startWidth = thumbWidth;

        const sidebarEl = sidebarRef.current;

        const handleMouseMove = (me: MouseEvent) => {
            if (!isThumbResizing.current || !sidebarEl) return;
            // Min 160: cho phép thu gọn hơn trước (260) mà thumb vẫn scale fit (clamp ở ThumbSidebar).
            const newWidth = Math.max(160, Math.min(800, startWidth + (me.clientX - startX)));
            sidebarEl.style.width = `${newWidth}px`;
        };

        const handleMouseUp = (me: MouseEvent) => {
            isThumbResizing.current = false;
            setIsResizing(false);
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);

            const finalWidth = Math.max(160, Math.min(800, startWidth + (me.clientX - startX)));
            setThumbWidth(finalWidth);
            // Báo zoom hook clamp thumbBaseWidth theo panel mới (event tùy chọn)
            window.dispatchEvent(new CustomEvent('prynx-thumb-panel-resized', { detail: { width: finalWidth } }));
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    };

    useEffect(() => {
        const handleCrossHover = (e: any) => {
            const { targetPdfUrl, hoverIndex, dropPosition: pos } = e.detail;
            if (targetPdfUrl === pdfUrl) {
                setHoverTargetIndex(hoverIndex);
                setDropPosition(pos);
            } else if (targetPdfUrl === 'cleanup') {
                setHoverTargetIndex(null);
            }
        };
        window.addEventListener('prynx-cross-file-hover', handleCrossHover);
        return () => window.removeEventListener('prynx-cross-file-hover', handleCrossHover);
    }, [pdfUrl]);

    // ======= Pointer Events Drag and Drop =======

    // Track latest state to avoid stale closures during pointer events
    const latestStateRef = useRef({ pageOrder, selectedIndices, lastSelectedIndex, pageInstanceIds });
    latestStateRef.current = { pageOrder, selectedIndices, lastSelectedIndex, pageInstanceIds };

    // We use a ref to track state during the pointer drag to avoid stale closures
    const dragContextRef = useRef<{ draggedIndex: number | null, hoverIndex: number | null, dropPosition: 'before' | 'after' }>({ draggedIndex: null, hoverIndex: null, dropPosition: 'before' });
    // Theo dõi trạng thái phím Alt trong lúc kéo (tránh setState dư mỗi pointermove).
    const copyModeRef = useRef(false);
    // Sau một thao tác kéo THẬT (vượt ngưỡng), bỏ qua sự kiện click kế tiếp để không
    // reset lại lựa chọn vừa tạo bởi drag.
    const justDraggedRef = useRef(false);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
        // Only initiate drag on left mouse button
        if (e.button !== 0) return;

        justDraggedRef.current = false;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        const DRAG_THRESHOLD = 6; // px — phải kéo quá ngưỡng này mới thực sự bắt đầu drag.

        // Bắt pointer lên CHÍNH thumbnail (e.currentTarget) để mọi pointermove/up luôn được
        // giao về — kéo được từ bất kỳ điểm nào (kể cả trên ảnh có pointer-events:none) và
        // chặn native drag/selection. Capture trên chính phần tử cũng giúp click/dblclick
        // vẫn bắn đúng vào thumbnail. Listener đặt trên window nên dù thumbnail có re-render/
        // unmount giữa chừng (vd khi sắp xếp) thì pointerup vẫn chạy → không bị kẹt.
        const captureEl = e.currentTarget;
        try { captureEl.setPointerCapture(pointerId); } catch { /* noop */ }

        let dragStarted = false;
        let scrollRAF: number | null = null;
        let edgeScrollSpeed = 0;
        let lastClientX = e.clientX;
        let lastClientY = e.clientY;

        // Chỉ thực sự khởi động drag KHI người dùng đã kéo vượt ngưỡng. Trước đó, mọi
        // thao tác (kể cả Ctrl/Shift+click) chỉ là click chọn — do onClick xử lý.
        const beginDrag = (ev: PointerEvent) => {
            dragStarted = true;
            justDraggedRef.current = true;

            // Chỉ tự chọn item chưa được chọn khi KHÔNG giữ phím bổ trợ chọn (Ctrl/Shift/Meta).
            if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
                let currentSelection = new Set(latestStateRef.current.selectedIndices);
                if (!currentSelection.has(index)) {
                    currentSelection = new Set([index]);
                    setSelectedIndices(currentSelection);
                    setLastSelectedIndex(index);
                    setActivePage(index + 1);
                }
            }

            dragContextRef.current.draggedIndex = index;
            dragContextRef.current.hoverIndex = index;
            copyModeRef.current = ev.altKey;
            setDraggedIndex(index);
            setHoverTargetIndex(index);
            setIsCopyDrag(ev.altKey);

            // ── Dựng "bóng ma" trang đang kéo bám theo con trỏ (giống Acrobat) ──
            // Tạo bằng DOM thuần gắn vào body để không bị React re-render xoá mất.
            removeDragGhost();
            const sel = latestStateRef.current.selectedIndices;
            const count = sel.has(index) ? sel.size : 1;
            const srcEl = document.querySelector(`[data-thumb-index="${index}"] img`) as HTMLImageElement | null;

            const ghost = document.createElement('div');
            ghost.style.cssText = [
                'position:fixed', 'z-index:10000', 'pointer-events:none',
                'border-radius:3px', 'overflow:hidden', 'background:rgba(255,255,255,0.92)',
                'box-shadow:0 10px 28px rgba(0,0,0,0.35)',
                `border:2px solid ${ev.altKey ? '#22c55e' : '#3b82f6'}`,
                'opacity:0.78',
                `left:${ev.clientX + 14}px`, `top:${ev.clientY + 10}px`,
            ].join(';');

            let w = 110, h = 150;
            if (srcEl) {
                w = srcEl.offsetWidth || w;
                h = srcEl.offsetHeight || h;
                const maxW = 120;
                if (w > maxW) { h = h * (maxW / w); w = maxW; }
            }
            const gimg = document.createElement('img');
            gimg.style.cssText = `display:block;width:${Math.round(w)}px;height:${Math.round(h)}px;object-fit:contain;background:#fff`;
            if (srcEl && srcEl.src) gimg.src = srcEl.src;
            gimg.draggable = false;
            ghost.appendChild(gimg);

            if (count > 1) {
                const badge = document.createElement('span');
                badge.textContent = String(count);
                badge.style.cssText = [
                    'position:absolute', 'top:-8px', 'left:-8px', 'min-width:20px', 'height:20px',
                    'padding:0 5px', 'display:flex', 'align-items:center', 'justify-content:center',
                    'background:#2563eb', 'color:#fff', 'font-size:11px', 'font-weight:700',
                    'border-radius:9999px', 'box-shadow:0 1px 3px rgba(0,0,0,0.4)',
                ].join(';');
                ghost.appendChild(badge);
            }

            document.body.appendChild(ghost);
            ghostElRef.current = ghost;
        };

        const processHoverLogic = (clientX: number, clientY: number) => {
            // Find what element is currently under the pointer
            const overElement = document.elementFromPoint(clientX, clientY);

            // 1. Check for tab switching
            const tabEl = overElement?.closest('[data-tab-id]');
            if (tabEl) {
                const tabId = tabEl.getAttribute('data-tab-id');
                window.dispatchEvent(new CustomEvent('prynx-tab-hover', { detail: { tabId } }));
            } else {
                window.dispatchEvent(new CustomEvent('prynx-tab-hover-leave'));
            }

            const thumbEl = overElement?.closest('[data-thumb-index]');

            if (thumbEl) {
                const hoverIdxStr = thumbEl.getAttribute('data-thumb-index');
                if (hoverIdxStr) {
                    const hIdx = parseInt(hoverIdxStr, 10);
                    
                    const rect = thumbEl.getBoundingClientRect();
                    const midPoint = rect.left + rect.width / 2;
                    const newDropPos = clientX < midPoint ? 'before' : 'after';

                    if (dragContextRef.current.hoverIndex !== hIdx || dragContextRef.current.dropPosition !== newDropPos) {
                        dragContextRef.current.hoverIndex = hIdx;
                        dragContextRef.current.dropPosition = newDropPos;
                        setHoverTargetIndex(hIdx);
                        setDropPosition(newDropPos);

                        const hoverPdfUrl = thumbEl.closest('.acro-thumb-scroll')?.getAttribute('data-pdf-url');
                        if (hoverPdfUrl && hoverPdfUrl !== pdfUrl) {
                            window.dispatchEvent(new CustomEvent('prynx-cross-file-hover', {
                                detail: { targetPdfUrl: hoverPdfUrl, hoverIndex: hIdx, dropPosition: newDropPos }
                            }));
                        }
                    }
                }
            } else {
                const isOverSidebar = overElement?.closest('.acro-thumb-scroll');
                if (!isOverSidebar && dragContextRef.current.hoverIndex !== null) {
                    dragContextRef.current.hoverIndex = null;
                    setHoverTargetIndex(null);
                    window.dispatchEvent(new CustomEvent('prynx-cross-file-hover', {
                        detail: { targetPdfUrl: 'cleanup', hoverIndex: null, dropPosition: 'before' }
                    }));
                }
            }
        };

        const updateScroll = () => {
            if (edgeScrollSpeed !== 0 && sidebarRef.current) {
                const scrollContainer = sidebarRef.current.querySelector('.acro-thumb-scroll');
                if (scrollContainer) {
                    scrollContainer.scrollTop += edgeScrollSpeed;
                    processHoverLogic(lastClientX, lastClientY);
                }
                scrollRAF = requestAnimationFrame(updateScroll);
            } else {
                scrollRAF = null;
            }
        };

        const checkEdgeScroll = (clientY: number) => {
            if (!sidebarRef.current) return;
            const scrollContainer = sidebarRef.current.querySelector('.acro-thumb-scroll');
            if (!scrollContainer) return;
            
            const rect = scrollContainer.getBoundingClientRect();
            const threshold = 60; // Start scrolling when within 60px of the edge
            
            if (clientY < rect.top + threshold) {
                // Near top edge, scroll up
                const distance = rect.top + threshold - clientY;
                edgeScrollSpeed = -Math.min(25, Math.max(5, distance * 0.4));
            } else if (clientY > rect.bottom - threshold) {
                // Near bottom edge, scroll down
                const distance = clientY - (rect.bottom - threshold);
                edgeScrollSpeed = Math.min(25, Math.max(5, distance * 0.4));
            } else {
                edgeScrollSpeed = 0;
            }

            if (edgeScrollSpeed !== 0 && !scrollRAF) {
                scrollRAF = requestAnimationFrame(updateScroll);
            }
        };

        const onPointerMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            lastClientX = moveEvent.clientX;
            lastClientY = moveEvent.clientY;

            // Chưa vượt ngưỡng → chưa coi là drag, không làm gì cả.
            if (!dragStarted) {
                const dx = moveEvent.clientX - startX;
                const dy = moveEvent.clientY - startY;
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
                beginDrag(moveEvent);
            }

            if (moveEvent.altKey !== copyModeRef.current) {
                copyModeRef.current = moveEvent.altKey;
                setIsCopyDrag(moveEvent.altKey);
            }

            // Cập nhật vị trí + màu viền của "bóng ma" theo con trỏ.
            const ghost = ghostElRef.current;
            if (ghost) {
                ghost.style.left = `${moveEvent.clientX + 14}px`;
                ghost.style.top = `${moveEvent.clientY + 10}px`;
                ghost.style.borderColor = moveEvent.altKey ? '#22c55e' : '#3b82f6';
            }

            checkEdgeScroll(moveEvent.clientY);
            processHoverLogic(moveEvent.clientX, moveEvent.clientY);
        };

        const onPointerUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            edgeScrollSpeed = 0;
            if (scrollRAF) cancelAnimationFrame(scrollRAF);

            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            try { captureEl?.releasePointerCapture(pointerId); } catch { /* noop */ }

            // Ẩn "bóng ma" trang.
            removeDragGhost();

            // Không vượt ngưỡng → chỉ là click. Để onClick/onDoubleClick trên thumbnail xử lý
            // (capture trên chính thumbnail nên click/dblclick vẫn bắn đúng). Không drag.
            if (!dragStarted) {
                return;
            }

            window.dispatchEvent(new CustomEvent('prynx-cross-file-hover', {
                detail: { targetPdfUrl: 'cleanup', hoverIndex: null, dropPosition: 'before' }
            }));

            const overElement = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
            const dropSidebar = overElement?.closest('.acro-thumb-scroll');

            if (dropSidebar && sidebarRef.current && !sidebarRef.current.contains(dropSidebar)) {
                // Cross file drop!
                const targetPdfUrl = dropSidebar.getAttribute('data-pdf-url');
                const srcPdfUrl = sidebarRef.current.querySelector('.acro-thumb-scroll')?.getAttribute('data-pdf-url');

                if (targetPdfUrl && srcPdfUrl && targetPdfUrl !== srcPdfUrl) {
                    const { pageOrder: curOrder, selectedIndices: curSel } = latestStateRef.current;
                    const selArray = Array.from(curSel).sort((a, b) => a - b);
                    const selectedOriginalPages = selArray.map(idx => curOrder[idx]);

                    let targetDropIndex = dragContextRef.current.hoverIndex;
                    if (targetDropIndex !== null && dragContextRef.current.dropPosition === 'after') {
                        targetDropIndex++;
                    }

                    window.dispatchEvent(new CustomEvent('prynx-cross-file-drop', {
                        detail: {
                            sourcePdfUrl: srcPdfUrl,
                            sourcePageNums: selectedOriginalPages,
                            targetPdfUrl,
                            dropIndex: targetDropIndex
                        }
                    }));
                }
            }

            const dropIndex = dragContextRef.current.hoverIndex;
            const dropPos = dragContextRef.current.dropPosition;
            const draggedIdx = dragContextRef.current.draggedIndex;
            const isCopy = upEvent.altKey;

            // Clean up state
            dragContextRef.current.draggedIndex = null;
            dragContextRef.current.hoverIndex = null;
            copyModeRef.current = false;
            setDraggedIndex(null);
            setHoverTargetIndex(null);
            setIsCopyDrag(false);

            // Perform Drop Logic
            const { pageOrder: currentOrder, selectedIndices: currentSel } = latestStateRef.current;

            if (draggedIdx === null || dropIndex === null) {
                return;
            }
            // Move: bỏ qua khi thả vào chính nó / vào trang đang chọn (vô nghĩa).
            // Copy: cho phép thả ở bất kỳ đâu (kể cả ngay cạnh bản gốc) để nhân bản nhanh.
            if (!isCopy && (draggedIdx === dropIndex || currentSel.has(dropIndex))) {
                return;
            }

            const { pageInstanceIds: currentIds } = latestStateRef.current;
            const newOrder = [...currentOrder];
            const selArray = Array.from(currentSel).sort((a, b) => a - b);
            const selectedItems = selArray.map(idx => newOrder[idx]);
            const selectedIds = selArray.map(idx => currentIds[idx]);
            commitSnapshot();

            // Determine insertion point based on dropPosition
            const insertAtOriginal = dropPos === 'after' ? dropIndex + 1 : dropIndex;

            if (isCopy) {
                // ── ALT+KÉO = NHÂN BẢN ──
                // Giữ nguyên toàn bộ trang gốc, chèn bản sao của các trang đang chọn vào điểm thả.
                // Bản sao: id MỚI (xoay độc lập) nhưng KẾ THỪA góc hiện tại của trang nguồn.
                const dupIds = selectedIds.map(() => genPageId());
                setPageRotations(prev => {
                    const next = { ...prev };
                    selectedIds.forEach((srcId, i) => { if (srcId && prev[srcId]) next[dupIds[i]] = prev[srcId]; });
                    return next;
                });
                const copyOrder = [...currentOrder];
                copyOrder.splice(insertAtOriginal, 0, ...selectedItems);
                const copyIds = [...currentIds];
                copyIds.splice(insertAtOriginal, 0, ...dupIds);
                setPageOrder(copyOrder);
                setPageInstanceIds(copyIds);

                const newSelSet = new Set(Array.from({ length: selectedItems.length }, (_, i) => insertAtOriginal + i));
                setSelectedIndices(newSelSet);
                setLastSelectedIndex(insertAtOriginal);
                setActivePage(insertAtOriginal + 1);
                return;
            }

            // ── KÉO THƯỜNG = DI CHUYỂN ──
            const remainder = newOrder.filter((_, idx) => !currentSel.has(idx));
            const remainderIds = currentIds.filter((_, idx) => !currentSel.has(idx));

            let adjustedDropIndex = insertAtOriginal;
            for (const idx of selArray) {
                if (idx < insertAtOriginal) {
                    adjustedDropIndex--;
                }
            }

            remainder.splice(adjustedDropIndex, 0, ...selectedItems);
            remainderIds.splice(adjustedDropIndex, 0, ...selectedIds);

            setPageOrder(remainder);
            setPageInstanceIds(remainderIds);

            const newSelStart = adjustedDropIndex;
            const newSelSet = new Set(Array.from({ length: selectedItems.length }, (_, i) => newSelStart + i));
            setSelectedIndices(newSelSet);
            setLastSelectedIndex(newSelStart);
            setActivePage(newSelStart + 1);
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    };

    const handleMarqueeMouseDown = (e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        // Start marquee selection if clicking anywhere in the container EXCEPT on a thumbnail item
        if (!target.closest('.acro-thumb-item')) {
            e.preventDefault();
            sidebarRef.current?.focus();
            setMarqueeStart({ x: e.clientX, y: e.clientY });
            setMarqueeInitialSelection(e.ctrlKey || e.metaKey || e.shiftKey ? new Set(selectedIndices) : new Set());
            if (marqueeBoxRef.current) {
                marqueeBoxRef.current.style.left = `${e.clientX}px`;
                marqueeBoxRef.current.style.top = `${e.clientY}px`;
                marqueeBoxRef.current.style.width = '0px';
                marqueeBoxRef.current.style.height = '0px';
                marqueeBoxRef.current.style.display = 'block';
            }
        }
    };

    return {
        thumbWidth,
        isResizing,
        draggedIndex,
        hoverTargetIndex,
        dropPosition,
        isCopyDrag,
        marqueeBoxRef,
        handleThumbClick,
        handleThumbResizeStart,
        handlePointerDown,
        handleMarqueeMouseDown
    };
}
