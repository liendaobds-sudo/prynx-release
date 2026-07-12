import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useThumbSidebar } from './useThumbSidebar';
import { thumbCacheRef } from '../workspace/ViewerHelpers';
import { useTranslation } from 'react-i18next';

interface ThumbSidebarProps {
    // Page state
    pageOrder: number[];
    setPageOrder: React.Dispatch<React.SetStateAction<number[]>>;
    pageInstanceIds: string[];
    setPageInstanceIds: React.Dispatch<React.SetStateAction<string[]>>;
    selectedIndices: Set<number>;
    setSelectedIndices: React.Dispatch<React.SetStateAction<Set<number>>>;
    lastSelectedIndex: number | null;
    setLastSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>;
    activePage: number;
    setActivePage: (p: number) => void;
    numPages: number;
    pageRotations: Record<string, number>;
    setPageRotations: React.Dispatch<React.SetStateAction<Record<string, number>>>;
    allPageDims: Record<number, { w: number; h: number; widthPt: number }>;
    // Thumbnail state
    thumbBaseWidth: number;
    isThumbMenuOpen: boolean;
    setIsThumbMenuOpen: (open: boolean) => void;
    // Actions
    commitSnapshot: () => void;
    handleQuickRotate: (degrees: number) => void;
    setActiveDashboardTool: (tool: string) => void;
    setIsSidebarOpen: (open: boolean) => void;
    setContextMenu: React.Dispatch<React.SetStateAction<any>>;
    setIsInsertModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExtractPagesStrForModal: React.Dispatch<React.SetStateAction<string>>;
    setIsExtractModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsDeleteModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    // Refs
    sidebarRef: React.RefObject<HTMLDivElement | null>;
    mainVirtuosoRef: React.RefObject<any>;
    internalScrollRef: React.MutableRefObject<HTMLElement | null>;
    // File info
    file: any;
    pdfUrl: string | null;
    onCrossFileCopy?: (sourcePdfUrl: string, sourcePageNum: number, targetIndex: number) => void;
}

const MemoThumbItem = React.memo((props: any) => {
    const {
        index, originalPageNum, logicalPageLabel,
        isSelected, isActive, isDragged, showCopyBadge, hoverTargetState,
        rot, localDim, thumbBaseWidth,
        pdfUrl, file, isLoadable, registerRef,
        handleThumbClick, handlePointerDown, onContextMenu
    } = props;
    const isBlankDoc = !!(file as any)?.isBlank;

    const exactRatio = localDim ? localDim.h / localDim.w : 1.414;
    const normRot = (((rot || 0) % 360) + 360) % 360;
    const isRotated = normRot % 180 !== 0;
    const imgW = thumbBaseWidth;
    const imgH = Math.round(thumbBaseWidth * exactRatio);
    // KHUNG + RUỘT xoay CÙNG NHAU như một khối (page wrapper). Slot ngoài dành đúng footprint
    // SAU xoay: 90/270 hoán rộng↔cao (khối imgW×imgH xoay 90° chiếm imgH×imgW). Nhờ vậy khung
    // luôn khớp hướng ruột, dải thumbnail xếp đúng, KHÔNG chừa dải trắng.
    const footprintW = isRotated ? imgH : imgW;
    const footprintH = isRotated ? imgW : imgH;

    let finalSrc = thumbCacheRef.current.get(`${pdfUrl}_${originalPageNum}_0_400`);
    const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);

    if (!finalSrc && isImage) {
        finalSrc = pdfUrl || undefined;
    } else if (!finalSrc && isLoadable && (window as any).__TAURI_INTERNALS__ && file?.path) {
        // Chỉ tạo URL tile:// khi thumbnail nằm trong tầm nhìn VÀ trang chính đã hiển thị xong.
        // Tránh hàng loạt request thumbnail tranh chấp pdfium handle với trang chính khi mới mở file.
        // Render theo bề rộng hiển thị thực tế (oversample 1.3×) để QR/mã vạch trên trang nhỏ
        // không bị vón thành mảng đen. render width(px) = localDim.w × zoom.
        const baseW = localDim?.w || 595;
        const optimalZoom = Math.max(0.1, Math.min(1.5, (thumbBaseWidth * 1.3) / baseW));
        finalSrc = `http://tile.localhost/${encodeURIComponent(file.path)}/${originalPageNum}/${optimalZoom}/0/0/0/0/0`;
    }

    const dimW = localDim ? (localDim.w * 25.4 / 72).toFixed(1) : 0;
    const dimH = localDim ? (localDim.h * 25.4 / 72).toFixed(1) : 0;
    const tooltipText = originalPageNum !== -1 ? `Trang ${logicalPageLabel}\nKích thước: ${dimW} x ${dimH} mm` : `Trang Trống`;

    // FIX release: protocol tile.localhost (img/new Image/fetch) đều KHÔNG hiển thị ở release.
    // Lấy bytes JPEG qua IPC invoke('render_pdf_page') (đáng tin, giống tách nền) → blob: → img.
    const thumbImgRef = useRef<HTMLImageElement>(null);
    useEffect(() => {
        const el = thumbImgRef.current;
        if (!el || !finalSrc) return;
        const isTileScheme = finalSrc.startsWith('http://tile.localhost')
            || finalSrc.startsWith('https://tile.localhost')
            || finalSrc.startsWith('tile://');
        if (!isTileScheme) { el.src = finalSrc; return; }
        let cancelled = false;
        let blobUrl: string | null = null;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const baseW = localDim?.w || 595;
                const optimalZoom = Math.max(0.1, Math.min(1.5, (thumbBaseWidth * 1.3) / baseW));
                const bytes: ArrayBuffer = await invoke('render_pdf_page', {
                    filePath: file.path, page: originalPageNum, zoom: optimalZoom, rotation: 0,
                    clipX: null, clipY: null, clipW: null, clipH: null,
                });
                if (cancelled) return;
                blobUrl = URL.createObjectURL(new Blob([bytes as any], { type: 'image/jpeg' }));
                if (thumbImgRef.current) thumbImgRef.current.src = blobUrl;
            } catch {
                /* thumbnail render thất bại — giữ placeholder, không chặn UI */
            }
        })();
        return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
    }, [finalSrc, file?.path, originalPageNum, thumbBaseWidth, localDim?.w]);

    return (
        <div
            ref={(el) => registerRef?.(el, index)}
            data-thumb-index={index}
            title={tooltipText}
            onContextMenu={(e) => onContextMenu(e, index, logicalPageLabel)}
            className={`acro-thumb-item flex flex-col items-center py-2 px-3 rounded-md cursor-pointer transition-colors relative touch-none
                ${isSelected ? 'bg-blue-500/10 dark:bg-blue-900/40' : 'hover:bg-black/5 dark:hover:bg-white/5'}
                ${isDragged ? 'opacity-30' : 'opacity-100'}
                ${hoverTargetState}
            `}
            onClick={(e) => handleThumbClick(e, index)}
            onDoubleClick={(e) => {
                e.preventDefault();
                handleThumbClick(e, index);
                window.dispatchEvent(new CustomEvent('prynx-zoom-fit-page'));
            }}
            onPointerDown={(e) => handlePointerDown(e, index)}
        >
            {showCopyBadge && (
                <div className="absolute top-1 right-1 z-20 flex items-center gap-0.5 bg-green-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full shadow pointer-events-none">
                    <span className="text-[11px] leading-none">＋</span> Sao chép
                </div>
            )}
            {/* SLOT ngoài = footprint SAU xoay (đã hoán rộng↔cao khi 90/270). Outline chọn bao
                quanh slot. Khung trắng + ảnh nằm trong 1 KHỐI xoay cùng nhau bên trong slot →
                khung luôn khớp hướng ruột, không còn "khung 1 hướng ruột 1 hướng". */}
            <div className={`
                relative flex items-center justify-center
                ${isSelected ? 'outline outline-3 outline-blue-500' : 'outline outline-1 outline-black/20 dark:outline-white/10'}
            `} style={{ width: footprintW, height: footprintH }}>
                {originalPageNum === -1 ? (
                    <div style={{
                        width: imgW, height: imgH, position: 'absolute', left: '50%', top: '50%',
                        transform: `translate(-50%, -50%) rotate(${normRot}deg)`, transformOrigin: 'center center',
                    }} className="bg-white border-2 border-dashed border-slate-300 flex items-center justify-center">
                        <span className="text-slate-300 text-xs font-semibold -rotate-45 block">TRANG TRỐNG</span>
                    </div>
                ) : (
                    <>
                        {/* Khối trang (giấy trắng + ảnh) — xoay như MỘT thể. Kích thước = trang gốc
                            imgW×imgH; xoay quanh tâm slot (translate -50% rồi rotate). Bounding box
                            sau xoay = footprint = slot → lấp khít, không dải trắng. */}
                        <div style={{
                            width: imgW, height: imgH, position: 'absolute', left: '50%', top: '50%',
                            transform: `translate(-50%, -50%) rotate(${normRot}deg)`, transformOrigin: 'center center',
                            overflow: 'hidden',
                        }} className="bg-white">
                            {finalSrc ? (
                                <img
                                    ref={thumbImgRef}
                                    alt={`Page ${originalPageNum}`}
                                    style={{ width: '100%', height: '100%', display: 'block', objectFit: 'fill' }}
                                    className="pointer-events-none bg-white"
                                    draggable={false}
                                />
                            ) : (
                                <div className={`w-full h-full flex items-center justify-center ${isBlankDoc ? 'bg-white' : 'bg-slate-100 dark:bg-zinc-800 animate-pulse'}`}>
                                    {!isBlankDoc && <div className="w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />}
                                </div>
                            )}
                        </div>
                        {isActive && (
                            <div className="absolute inset-0 overflow-hidden pointer-events-none z-10">
                                <div
                                    id="thumb-viewport-indicator"
                                    className="absolute border-[1.5px] border-blue-500 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] pointer-events-auto cursor-move"
                                    style={{ display: 'none' }}
                                    onDragStart={(e) => e.preventDefault()}
                                    onClick={(e) => e.stopPropagation()}
                                    onDoubleClick={(e) => e.stopPropagation()}
                                    onPointerDown={(e) => {
                                        e.stopPropagation();
                                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                        window.dispatchEvent(new CustomEvent('prynx-viewport-drag-start', { detail: { x: e.clientX, y: e.clientY, pointerId: e.pointerId } }));
                                    }}
                                />
                            </div>
                        )}
                    </>
                )}
            </div>
            <span className={`text-[11px] mt-3 font-mono tracking-widest ${isActive ? 'text-blue-600 dark:text-blue-400 font-extrabold' : 'text-slate-500 dark:text-zinc-400'}`}>
                {logicalPageLabel}
            </span>
        </div>
    );
}, (prev, next) => {
    return prev.index === next.index &&
        prev.originalPageNum === next.originalPageNum &&
        prev.isSelected === next.isSelected &&
        prev.isActive === next.isActive &&
        prev.isDragged === next.isDragged &&
        prev.showCopyBadge === next.showCopyBadge &&
        prev.hoverTargetState === next.hoverTargetState &&
        prev.rot === next.rot &&
        prev.thumbBaseWidth === next.thumbBaseWidth &&
        // localDim quyết định tỷ lệ ô (exactRatio) → PHẢI so, nếu không dims đến sau
        // lần render đầu bị memo chặn → ô kẹt tỷ lệ fallback 1.414 (A4 dọc) trong khi
        // trang thực có thể ngang → xoay lệch, chừa nền thừa quanh trang.
        prev.localDim?.w === next.localDim?.w &&
        prev.localDim?.h === next.localDim?.h &&
        prev.isLoadable === next.isLoadable &&
        prev.pdfUrl === next.pdfUrl;
});

// Cổng tải thumbnail: hoãn render thumbnail (qua tile://) cho đến khi trang chính
// đã hiển thị xong (sự kiện 'prynx-main-tile-ready'), hoặc fallback sau 700ms.
// Mục đích: trang chính được ưu tiên dùng pdfium handle trước, mở file nhanh hơn hẳn.
function useThumbLoadGate(pdfUrl: string | null, skipReset?: boolean) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        // Edit-commit: giữ cổng đang mở (không setReady(false)) → thumbnail không
        // "tải lại" cả dải; trang bị sửa tự cập nhật do MemoThumbItem re-render.
        if (skipReset) return;
        setReady(false);
        let opened = false;
        const open = () => { if (!opened) { opened = true; setReady(true); } };
        window.addEventListener('prynx-main-tile-ready', open);
        const t = setTimeout(open, 700);
        return () => {
            window.removeEventListener('prynx-main-tile-ready', open);
            clearTimeout(t);
        };
    }, [pdfUrl]);
    return ready;
}

export function ThumbSidebar(props: ThumbSidebarProps) {
  const { t } = useTranslation();
    const {
        pageOrder, setPageOrder,
        pageInstanceIds, setPageInstanceIds,
        selectedIndices, setSelectedIndices,
        lastSelectedIndex, setLastSelectedIndex,
        activePage, setActivePage, numPages, pageRotations, setPageRotations,
        allPageDims, thumbBaseWidth,
        isThumbMenuOpen, setIsThumbMenuOpen,
        commitSnapshot, handleQuickRotate,
        setActiveDashboardTool, setIsSidebarOpen,
        setContextMenu, sidebarRef, mainVirtuosoRef, internalScrollRef,
        file, pdfUrl, onCrossFileCopy,
        setIsDeleteModalOpen,
    } = props;

    const {
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
    } = useThumbSidebar({
        pageOrder, setPageOrder,
        pageInstanceIds, setPageInstanceIds, setPageRotations,
        selectedIndices, setSelectedIndices,
        lastSelectedIndex, setLastSelectedIndex,
        setActivePage, commitSnapshot,
        sidebarRef, mainVirtuosoRef,
        pdfUrl: pdfUrl || undefined,
        onNavigatePage: (index: number) => {
            setActivePage(index + 1);
            if (mainVirtuosoRef.current) {
                mainVirtuosoRef.current.scrollToIndex({ index, behavior: 'auto', align: 'start' });
            } else if (internalScrollRef.current) {
                internalScrollRef.current.scrollTop = 0;
                internalScrollRef.current.scrollLeft = 0;
            }
        }
    });

    // ═══ Lazy-load thumbnails ═══
    // Chỉ tải tile cho thumbnail đang nằm trong tầm nhìn (IntersectionObserver), kết hợp
    // cổng "trang chính hiển thị trước". Tránh việc mở file nhiều trang fire hàng loạt
    // request thumbnail làm nghẽn pdfium handle dùng chung với trang chính.
    const thumbsGateOpen = useThumbLoadGate(pdfUrl, (file as any)?.__editCommit === true);
    const [visibleThumbs, setVisibleThumbs] = useState<Set<number>>(new Set());
    const thumbObserverRef = useRef<IntersectionObserver | null>(null);

    useEffect(() => {
        if ((file as any)?.__editCommit) return;
        setVisibleThumbs(new Set());
    }, [pdfUrl]);

    useEffect(() => () => thumbObserverRef.current?.disconnect(), []);

    const registerThumbRef = useCallback((el: HTMLElement | null, index: number) => {
        if (!el) return;
        el.dataset.thumbIndex = String(index);
        if (!thumbObserverRef.current) {
            thumbObserverRef.current = new IntersectionObserver((entries) => {
                const adds: number[] = [];
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const idx = parseInt((entry.target as HTMLElement).dataset.thumbIndex || '-1', 10);
                        if (idx >= 0) adds.push(idx);
                        thumbObserverRef.current?.unobserve(entry.target);
                    }
                }
                if (adds.length) {
                    setVisibleThumbs(prev => {
                        const next = new Set(prev);
                        for (const i of adds) next.add(i);
                        return next;
                    });
                }
            }, { rootMargin: '300px' });
        }
        thumbObserverRef.current.observe(el);
    }, []);

    return (
        <div
            ref={sidebarRef}
            tabIndex={-1}
            className={`flex flex-col bg-slate-50 dark:bg-[#121212] transition-[width] relative border-r border-black/20 dark:border-white/5 z-50 shrink-0 focus:outline-none ${isResizing ? 'duration-0' : 'duration-300'}`}
            style={{ width: isThumbMenuOpen ? thumbWidth : 40 }}
        >
            {/* Border Toggle Button */}
            <button
                onClick={() => setIsThumbMenuOpen(!isThumbMenuOpen)}
                className="absolute top-1/2 -right-[14px] -translate-y-1/2 w-7 h-7 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-full flex items-center justify-center shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors z-[100] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400"
                title={isThumbMenuOpen ? t('misc.thumbSidebar:thu_gon_thumbnails') : t('misc.thumbSidebar:mo_rong_thumbnails')}
            >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    {isThumbMenuOpen ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    )}
                </svg>
            </button>

            {/* Header */}
            <div className="w-full h-10 shrink-0 flex items-center justify-between border-b border-black/10 dark:border-white/5 bg-slate-100 dark:bg-[#18181b] px-2 relative overflow-hidden">
                {isThumbMenuOpen ? (
                    <>
                        <div className="flex-1 min-w-0 flex items-center">
                            <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 pl-3 tracking-wider truncate">THUMBNAILS</span>
                        </div>
                        <div className="shrink-0 flex items-center justify-center gap-1 px-1">
                            <button
                                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${selectedIndices.size > 0 ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-zinc-200' : 'text-slate-300 dark:text-zinc-600 cursor-not-allowed'}`}
                                title={t('misc.thumbSidebar:xoay_trai_rotate_ccw')}
                                onClick={() => handleQuickRotate(270)}
                                disabled={selectedIndices.size === 0}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                            </button>
                            <button
                                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${selectedIndices.size > 0 ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-zinc-200' : 'text-slate-300 dark:text-zinc-600 cursor-not-allowed'}`}
                                title={t('misc.thumbSidebar:xoay_phai_rotate_cw')}
                                onClick={() => handleQuickRotate(90)}
                                disabled={selectedIndices.size === 0}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>
                            </button>
                            <div className="w-[1px] h-4 bg-slate-300 dark:bg-zinc-600 mx-0.5"></div>
                            <button
                                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${selectedIndices.size > 0 ? 'hover:bg-black/10 dark:hover:bg-white/10 text-red-600 dark:text-red-400' : 'text-slate-300 dark:text-zinc-600 cursor-not-allowed'}`}
                                title={t('misc.thumbSidebar:xoa_trang_delete')}
                                onClick={() => setIsDeleteModalOpen(true)}
                                disabled={selectedIndices.size === 0}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="w-full flex justify-center items-center">
                        <button
                            onClick={() => setIsThumbMenuOpen(true)}
                            className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-500 transition-colors"
                            title={t('misc.thumbSidebar:mo_thumbnails')}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                        </button>
                    </div>
                )}
            </div>

            {/* Thumbnail List */}
            {isThumbMenuOpen ? (
                <div
                    className="flex-1 min-h-0 w-full flex flex-col font-sans transition-colors relative select-none"
                    onClick={() => setContextMenu(null)}
                    onMouseDown={handleMarqueeMouseDown}
                >
                    <div
                        className="acro-thumb-scroll w-full h-full overflow-y-auto"
                        data-pdf-url={pdfUrl}
                    >
                        <div className="flex flex-wrap gap-4 justify-center px-2 py-4">
                            {pageOrder.slice(0, 1000).map((originalPageNum, index) => {
                                const logicalPageLabel = index + 1;
                                const isSelected = selectedIndices.has(index);
                                const isActive = activePage === logicalPageLabel;
                                const isDragged = draggedIndex !== null && isSelected;
                                const isHoverTarget = hoverTargetIndex === index && !isSelected;
                                const dropColor = isCopyDrag ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : 'border-blue-500 bg-blue-50 dark:bg-blue-900/20';
                                const hoverTargetState = isHoverTarget ? (dropPosition === 'after' ? `border-r-[3px] ${dropColor}` : `border-l-[3px] ${dropColor}`) : '';

                                return (
                                    <MemoThumbItem
                                        key={`thumb-${index}-${originalPageNum}`}
                                        index={index}
                                        originalPageNum={originalPageNum}
                                        logicalPageLabel={logicalPageLabel}
                                        isSelected={isSelected}
                                        isActive={isActive}
                                        isDragged={isDragged}
                                        showCopyBadge={isDragged && isCopyDrag}
                                        hoverTargetState={hoverTargetState}
                                        rot={pageInstanceIds[index] ? (pageRotations[pageInstanceIds[index]] || 0) : 0}
                                        localDim={allPageDims[originalPageNum]}
                                        thumbBaseWidth={thumbBaseWidth}
                                        pdfUrl={pdfUrl}
                                        file={file}
                                        isLoadable={thumbsGateOpen && visibleThumbs.has(index)}
                                        registerRef={registerThumbRef}
                                        handleThumbClick={handleThumbClick}
                                        handlePointerDown={handlePointerDown}
                                        onContextMenu={(e: React.MouseEvent, idx: number, label: number) => {
                                            e.preventDefault();
                                            if (!selectedIndices.has(idx)) {
                                                setSelectedIndices(new Set([idx]));
                                                setActivePage(label);
                                                setLastSelectedIndex(idx);
                                            }
                                            setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
                                        }}
                                    />
                                );
                            })}
                            {pageOrder.length > 1000 && (
                                <div className="w-full text-center py-6 px-4 text-slate-500 dark:text-zinc-400 text-xs italic bg-slate-100 dark:bg-zinc-800/50 rounded-lg mx-2 border border-dashed border-slate-300 dark:border-zinc-700">
                                    Đang ẩn {pageOrder.length - 1000} thumbnails còn lại để tránh treo máy.<br/>
                                    {t('misc.thumbSidebar:su_dung_o_nhap_so_trang_o_thanh_tren')}
                                </div>
                            )}
                        </div>
                    </div>
                    <div
                        className="absolute top-0 -right-2 w-2 h-full cursor-col-resize z-50 hover:bg-blue-500/30 transition-colors"
                        onMouseDown={handleThumbResizeStart}
                    />

                    {/* Marquee Overlay via Ref */}
                    <div
                        ref={marqueeBoxRef}
                        className="fixed bg-blue-500/20 border border-blue-500 z-[999] pointer-events-none"
                        style={{ display: 'none' }}
                    />
                </div>
            ) : (
                <div className="flex-1 w-full flex items-center justify-center overflow-hidden py-8 pointer-events-none select-none">
                    <span
                        className="text-slate-500 dark:text-zinc-400 font-semibold text-base tracking-[0.25em] whitespace-nowrap"
                        style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                    >
                        PrintSolutions.vn
                    </span>
                </div>
            )}
        </div>
    );
}
