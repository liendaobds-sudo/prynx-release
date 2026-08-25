import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { useThumbSidebar } from './useThumbSidebar';
import {
    createThumbnailRenderRequest,
    getThumbCache,
    subscribeThumbCache,
} from '../workspace/thumbnailCache';
import {
    ensurePdfJsThumbnail,
    getPdfJsThumbnailDocument,
} from '../../hooks/viewer/usePdfLoader';
import { nativeTileRenderScheduler } from '../../hooks/viewer/tileRenderScheduler';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { fitThumbnailPageSize, formatRotatedPageSizePx96 } from './dimensionMath';
import type { SessionPreview } from '../../hooks/useEditSession';
import {
    groupEditPreviewsBySourcePage,
    sameEditPreviewSequence,
    ThumbnailEditPreviewLayer,
} from './thumbnailEditPreview';
import { pageHeightPtFromDim, pageWidthPtFromDim } from '../workspace/editGeometry';
import type { ViewerContextMenuState } from './ViewerContextMenu';
import { stickerSheetWorkflowStatusAtViewerPosition } from '../stickerSheetTabSelector';

export type ThumbPageWorkflowStatus = 'pending' | 'processing' | 'review' | 'ready' | 'error';

const WORKFLOW_BADGE: Record<ThumbPageWorkflowStatus, {
    label: string;
    className: string;
    symbol: string;
}> = {
    pending: {
        label: 'Chưa nhận diện',
        className: 'bg-slate-500 text-white',
        symbol: '•',
    },
    processing: {
        label: 'Đang nhận diện',
        className: 'bg-violet-600 text-white',
        symbol: '',
    },
    review: {
        label: 'Cần xác nhận',
        className: 'bg-amber-500 text-white',
        symbol: '!',
    },
    ready: {
        label: 'Sẵn sàng',
        className: 'bg-emerald-600 text-white',
        symbol: '✓',
    },
    error: {
        label: 'Lỗi',
        className: 'bg-rose-600 text-white',
        symbol: '!',
    },
};

export function ThumbWorkflowBadge({
    status,
    pageLabel,
}: {
    status: ThumbPageWorkflowStatus;
    pageLabel: number;
}) {
    const badge = WORKFLOW_BADGE[status];
    const label = tv(badge.label);
    return (
        <span
            aria-label={`${tv('Trang')} ${pageLabel}: ${label}`}
            title={label}
            data-workflow-status={status}
            className={`absolute right-1 top-1 z-20 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-black leading-none shadow ${badge.className}`}
        >
            {status === 'processing' ? (
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/50 border-t-white" />
            ) : badge.symbol}
        </span>
    );
}

type ThumbFile = File & {
    path?: string;
    isBlank?: boolean;
    __editCommit?: boolean;
};

type ThumbDimension = { w: number; h: number; widthPt: number };

interface MemoThumbItemProps {
    index: number;
    originalPageNum: number;
    logicalPageLabel: number;
    isSelected: boolean;
    isActive: boolean;
    isDragged: boolean;
    showCopyBadge: boolean;
    showCopyDropBadge: boolean;
    hoverTargetState: string;
    rot: number;
    localDim?: ThumbDimension;
    thumbBaseWidth: number;
    pdfUrl: string | null;
    file: ThumbFile | null;
    thumbRev: string;
    pageCount: number;
    isLoadable: boolean;
    isViewerActive?: boolean;
    registerRef?: (element: HTMLElement | null, index: number) => void;
    handleThumbClick: (event: React.MouseEvent, index: number) => void;
    handlePointerDown: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
    onContextMenu: (event: React.MouseEvent, index: number, label: number) => void;
    workflowStatus?: ThumbPageWorkflowStatus;
    editPreviews?: readonly SessionPreview[];
};

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
    setContextMenu: React.Dispatch<React.SetStateAction<ViewerContextMenuState>>;
    setIsInsertModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExtractPagesStrForModal: React.Dispatch<React.SetStateAction<string>>;
    setIsExtractModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsDeleteModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
    navigatePage: (newPage: number, options?: { preserveSelection?: boolean }) => void;
    // Refs
    sidebarRef: React.RefObject<HTMLDivElement | null>;
    mainVirtuosoRef: React.RefObject<VirtuosoHandle | null>;
    internalScrollRef: React.MutableRefObject<HTMLElement | null>;
    // File info
    file: ThumbFile | null;
    pdfUrl: string | null;
    isViewerActive?: boolean;
    pageWorkflowStatuses?: Partial<Record<number, ThumbPageWorkflowStatus>>;
    /** Preview in-memory theo trang; thumbnail dùng lại, không render PDF thêm. */
    editSessionPreviews?: readonly SessionPreview[];
    onCrossFileCopy?: (sourcePdfUrl: string, sourcePageNum: number, targetIndex: number) => void;
}

const MemoThumbItem = React.memo<MemoThumbItemProps>((props) => {
    const {
        index, originalPageNum, logicalPageLabel,
        isSelected, isActive, isDragged, showCopyBadge, showCopyDropBadge, hoverTargetState,
        rot, localDim, thumbBaseWidth,
        pdfUrl, file, thumbRev, pageCount, isLoadable, isViewerActive, registerRef,
        handleThumbClick, handlePointerDown, onContextMenu, workflowStatus, editPreviews,
    } = props;
    const { t } = useTranslation();
    const isBlankDoc = file?.isBlank === true;

    const normRot = (((rot || 0) % 360) + 360) % 360;
    const isRotated = normRot % 180 !== 0;
    const { width: imgW, height: imgH } = fitThumbnailPageSize(
        localDim?.w,
        localDim?.h,
        thumbBaseWidth,
        normRot,
    );
    // KHUNG + RUỘT xoay CÙNG NHAU như một khối (page wrapper). Slot ngoài dành đúng footprint
    // SAU xoay: 90/270 hoán rộng↔cao (khối imgW×imgH xoay 90° chiếm imgH×imgW). Nhờ vậy khung
    // luôn khớp hướng ruột, dải thumbnail xếp đúng, KHÔNG chừa dải trắng.
    const footprintW = isRotated ? imgH : imgW;
    const footprintH = isRotated ? imgW : imgH;

    const revToken = thumbRev || pdfUrl || '';
    const thumbDpr = window.devicePixelRatio || 1;
    // Trang ngang xoay dọc cần bitmap nguồn rộng hơn thumbBaseWidth; nếu vẫn render
    // theo base rồi kéo CSS lên, thumbnail main sẽ mờ trong khi child đã bake thì nét.
    const renderCssWidth = Math.max(thumbBaseWidth, imgW);
    const thumbnailRequest = React.useMemo(() => createThumbnailRenderRequest({
        revision: revToken,
        pageNum: originalPageNum,
        pageWidthPx96: localDim?.w,
        cssWidth: renderCssWidth,
        devicePixelRatio: thumbDpr,
    }), [revToken, originalPageNum, localDim?.w, renderCssWidth, thumbDpr]);
    const { cacheKey, zoom: optimalZoom } = thumbnailRequest;
    const subscribeToCurrentThumbnail = useCallback(
        (listener: () => void) => subscribeThumbCache(cacheKey, listener),
        [cacheKey],
    );
    const readCurrentThumbnail = useCallback(() => getThumbCache(cacheKey), [cacheKey]);
    const readServerThumbnail = useCallback(() => undefined, []);
    const cachedSrc = useSyncExternalStore(
        subscribeToCurrentThumbnail,
        readCurrentThumbnail,
        readServerThumbnail,
    );
    const isImage = !!(file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i));
    const nativeRequestKey = `${cacheKey}_${pageCount}`;
    const [nativePreview, setNativePreview] = useState<{ key: string; url: string } | null>(null);
    const [nativeRenderErrorKey, setNativeRenderErrorKey] = useState<string | null>(null);
    const [nativeRetryNonce, setNativeRetryNonce] = useState(0);
    const thumbRenderOwnerId = `thumbnail:${useId()}`;
    const needsNativeRender = isViewerActive !== false && !cachedSrc && !isImage && isLoadable
        && '__TAURI_INTERNALS__' in window && !!file?.path && originalPageNum > 0;
    const needsPdfJsRender = isViewerActive !== false && !cachedSrc && !isImage && isLoadable
        && !file?.path && originalPageNum > 0 && !!revToken;

    const nativeRenderError = nativeRenderErrorKey === nativeRequestKey;

    let finalSrc: string | undefined = cachedSrc;
    if (!finalSrc && isImage) finalSrc = pdfUrl || undefined;
    if (!finalSrc && nativePreview?.key === nativeRequestKey) finalSrc = nativePreview.url;
    // UIUX (audit 2026-08-04 §DIM.6): tooltip dùng khổ hiển thị sau xoay, nên 90°/270°
    // phải hoán rộng–cao giống thumbnail và thanh trạng thái.
    const { widthMm: dimW, heightMm: dimH } = localDim
        ? formatRotatedPageSizePx96(localDim.w, localDim.h, normRot)
        : { widthMm: '0', heightMm: '0' };
    const tooltipText = originalPageNum !== -1 ? t('misc.thumbSidebar:trang_kich_thuoc_tooltip', { page: logicalPageLabel, w: dimW, h: dimH }) : t('misc.thumbSidebar:trang_trong');
    // Luôn contain: giữ tỉ lệ trang, không kéo giãn ảnh preview (tránh méo khi
    // tỉ lệ khung lệch nhẹ so với bitmap do làm tròn pixel, và không phóng đại mờ).
    const imgObjectFit: 'fill' | 'contain' = 'contain';

    useEffect(() => {
        if (!needsPdfJsRender) return;
        const pdfDocument = getPdfJsThumbnailDocument(revToken);
        if (!pdfDocument) return;
        // UIUX (audit 2026-08-22 §UX.TH.02): tile nhìn thấy tự yêu cầu đúng
        // originalPageNum; warmup 30 trang chỉ còn là tối ưu, không quyết định correctness.
        void ensurePdfJsThumbnail(pdfDocument, originalPageNum, thumbnailRequest)
            .catch(() => undefined);
    }, [needsPdfJsRender, revToken, originalPageNum, thumbnailRequest]);

    // Thumbnail dùng chung PDFium với trang chính. Đo thật 2026-07-22 cho thấy parser
    // phụ dựng lại toàn bộ file mỗi khối 6 trang → ~40s/khối trên
    // file đã bình. PDFium giữ doc mở sẵn + page LRU (render_tile_png) → trang đã xem ở
    // view chính được TÁI DÙNG, thumbnail gần như tức thì; zoom nhỏ nên bitmap bé + encode
    // rẻ. Nếu PDFium từ chối thì không dựng thumbnail bằng một parser ẩn khác, để giao
    // diện và trang chính luôn có cùng một nguồn render xác định.
    useEffect(() => {
        if (!needsNativeRender) return;
        let cancelled = false;
        let ownBlobUrl: string | null = null;
        const requestId = `thumb-${globalThis.crypto?.randomUUID?.()
            ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
        const groupKey = `thumbnail:${originalPageNum}`;
        (async () => {
            let src: string | null = null;
            try {
                // PERF (audit 2026-08-08 §RENDER.2): thumbnail đi lane nền riêng;
                // scheduler vẫn giữ một slot dự phòng để trang đang xem luôn tới được
                // interactive worker và có thể preempt nền trên máy ít RAM.
                const bytes = await nativeTileRenderScheduler.enqueue({
                    ownerId: thumbRenderOwnerId,
                    groupKey,
                    requestKey: `${thumbRenderOwnerId}|${file.path}|${originalPageNum}|${optimalZoom.toFixed(3)}`,
                    priority: 500,
                    run: async () => {
                        const { invoke } = await import('@tauri-apps/api/core');
                        return invoke<ArrayBuffer>('render_pdf_page', {
                            filePath: file.path, page: originalPageNum, zoom: optimalZoom, rotation: 0,
                            clipX: null, clipY: null, clipW: null, clipH: null,
                            requestContext: {
                                requestId,
                                ownerId: thumbRenderOwnerId,
                                groupKey,
                                generation: 1,
                                purpose: 'background',
                                priority: 500,
                                pipelineIdentity: 'pdfium-display-png-v1',
                            },
                        });
                    },
                });
                // COLOR (audit 2026-08-07 §GV.1): command native trả PNG lossless;
                // khai báo đúng MIME để thumbnail và trang chính cùng hợp đồng transport.
                ownBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
                src = ownBlobUrl;
            } catch {
                // UIUX (audit 2026-08-22 §UX.S.01): báo lỗi có thể thử lại thay vì
                // giữ spinner vô hạn khi PDFium/Tauri gặp lỗi tạm thời.
                if (!cancelled) setNativeRenderErrorKey(nativeRequestKey);
                src = null;
            }
            if (cancelled) {
                if (ownBlobUrl) URL.revokeObjectURL(ownBlobUrl);
                return;
            }
            if (src) setNativePreview({ key: nativeRequestKey, url: src });
        })();
        return () => {
            cancelled = true;
            nativeTileRenderScheduler.cancelOwner(thumbRenderOwnerId);
            void import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke('cancel_pdf_render', { requestId }))
                .catch(() => undefined);
            if (ownBlobUrl) URL.revokeObjectURL(ownBlobUrl);
        };
    }, [needsNativeRender, nativeRequestKey, nativeRetryNonce, file?.path, originalPageNum, pageCount, thumbRev, pdfUrl, optimalZoom, thumbRenderOwnerId]);
    return (
        <div
            ref={(el) => registerRef?.(el, index)}
            data-thumb-index={index}
            title={tooltipText}
            onContextMenu={(e) => onContextMenu(e, index, logicalPageLabel)}
            className={`acro-thumb-item flex flex-col items-center py-2 px-1.5 rounded-md cursor-pointer transition-colors relative touch-none max-w-full
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
                    <span className="text-[11px] leading-none">＋</span> {tv('Sao chép')}
                </div>
            )}
            {workflowStatus && (
                <ThumbWorkflowBadge status={workflowStatus} pageLabel={logicalPageLabel} />
            )}
            {/* UIUX (audit 2026-07-27 §C-11): badge tại CHỖ THẢ khi copy-drag — phân biệt
                sao chép/di chuyển không chỉ bằng màu viền drop (xanh lá vs xanh dương). */}
            {showCopyDropBadge && (
                <div className="absolute top-1 left-1 z-20 flex items-center gap-1 pointer-events-none">
                    <span className="w-3.5 h-3.5 rounded-full bg-green-500 text-white text-[10px] leading-none font-bold flex items-center justify-center shadow">＋</span>
                    <span className="text-[9px] font-bold text-green-700 dark:text-green-300 bg-white/85 dark:bg-zinc-900/85 px-1 py-0.5 rounded shadow">{tv('Sao chép')}</span>
                </div>
            )}
            {/* SLOT ngoài = footprint SAU xoay (đã hoán rộng↔cao khi 90/270). Outline chọn bao
                quanh slot. Khung trắng + ảnh nằm trong 1 KHỐI xoay cùng nhau bên trong slot →
                khung luôn khớp hướng ruột, không còn "khung 1 hướng ruột 1 hướng". */}
            <div
                data-thumb-footprint="1"
                data-thumb-rot={normRot}
                className={`
                relative flex items-center justify-center
                ${isSelected ? 'outline outline-3 outline-blue-500' : 'outline outline-1 outline-black/20 dark:outline-white/10'}
            `} style={{ width: footprintW, height: footprintH }}>
                {originalPageNum === -1 ? (
                    <div style={{
                        width: imgW, height: imgH, position: 'absolute', left: '50%', top: '50%',
                        transform: `translate(-50%, -50%) rotate(${normRot}deg)`, transformOrigin: 'center center',
                    }} className="bg-white border-2 border-dashed border-slate-300 flex items-center justify-center">
                        <span className="text-slate-300 text-xs font-semibold -rotate-45 block">{tv('TRANG TRỐNG')}</span>
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
                        }} className="bg-white" data-thumb-page="1">
                            {finalSrc ? (
                                <img
                                    src={finalSrc}
                                    alt={`Page ${originalPageNum}`}
                                    style={{ width: '100%', height: '100%', display: 'block', objectFit: imgObjectFit }}
                                    className="pointer-events-none bg-white"
                                    draggable={false}
                                />
                            ) : (
                                <div className={`w-full h-full flex items-center justify-center ${isBlankDoc ? 'bg-white' : 'bg-slate-100 dark:bg-zinc-800 animate-pulse'}`}>
                                    {!isBlankDoc && (nativeRenderError ? (
                                        <button
                                            type="button"
                                            className="rounded bg-white/80 px-1.5 py-1 text-[10px] font-semibold text-slate-600 shadow hover:bg-white dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-900"
                                            title={t('misc.errorBoundary:thu_lai')}
                                            aria-label={t('misc.errorBoundary:thu_lai')}
                                            onPointerDown={event => event.stopPropagation()}
                                            onClick={event => {
                                                event.stopPropagation();
                                                setNativeRenderErrorKey(null);
                                                setNativeRetryNonce(value => value + 1);
                                            }}
                                        >
                                            ↻
                                        </button>
                                    ) : (
                                        <div className="w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                                    ))}
                                </div>
                            )}
                            <ThumbnailEditPreviewLayer
                                previews={editPreviews}
                                pageWidthPt={pageWidthPtFromDim(localDim?.w)}
                                pageHeightPt={pageHeightPtFromDim(localDim?.h)}
                            />
                        </div>
                        {/* Indicator trên footprint (cùng hệ toạ độ AABB với main page outer box).
                            Không gắn trong khối CSS-rotate — % left/top map thẳng từ updateViewportRect. */}
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
        prev.showCopyDropBadge === next.showCopyDropBadge && // UIUX (audit 2026-07-27 §C-11)
        prev.hoverTargetState === next.hoverTargetState &&
        prev.rot === next.rot &&
        prev.thumbBaseWidth === next.thumbBaseWidth &&
        // localDim quyết định tỷ lệ ô (exactRatio) → PHẢI so, nếu không dims đến sau
        // lần render đầu bị memo chặn → ô kẹt tỷ lệ fallback 1.414 (A4 dọc) trong khi
        // trang thực có thể ngang → xoay lệch, chừa nền thừa quanh trang.
        prev.localDim?.w === next.localDim?.w &&
        prev.localDim?.h === next.localDim?.h &&
        prev.isLoadable === next.isLoadable &&
        prev.isViewerActive === next.isViewerActive &&
        prev.pdfUrl === next.pdfUrl &&
        prev.thumbRev === next.thumbRev &&
        prev.pageCount === next.pageCount &&
        prev.workflowStatus === next.workflowStatus &&
        sameEditPreviewSequence(prev.editPreviews, next.editPreviews);
});

// Cổng tải thumbnail: hoãn render thumbnail (qua cache ảnh phụ) cho đến khi trang chính
// đã hiển thị xong (sự kiện 'prynx-main-tile-ready'), hoặc fallback sau 700ms.
// Mục đích: trang chính được ưu tiên dùng pdfium handle trước, mở file nhanh hơn hẳn.
function useThumbLoadGate(pdfUrl: string | null, skipReset?: boolean) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        // Edit-commit: giữ cổng đang mở (không setReady(false)) → không unmount cả dải.
        // Nội dung từng thumb bust qua thumbRev (pdfUrl) trong MemoThumbItem useEffect.
        if (skipReset) return;
        // Đổi tài liệu phải đóng cổng thumbnail cũ trước khi tile mới sẵn sàng.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset theo nguồn PDF ngoại vi.
        setReady(false);
        let opened = false;
        const open = () => { if (!opened) { opened = true; setReady(true); } };
        window.addEventListener('prynx-main-tile-ready', open);
        const t = setTimeout(open, 700);
        return () => {
            window.removeEventListener('prynx-main-tile-ready', open);
            clearTimeout(t);
        };
    }, [pdfUrl, skipReset]);
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
        setContextMenu, sidebarRef, mainVirtuosoRef,
        file, pdfUrl, isViewerActive, pageWorkflowStatuses, editSessionPreviews,
        setIsDeleteModalOpen, navigatePage,
    } = props;

    const {
        thumbWidth,
        livePanelWidth,
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
            navigatePage(index + 1, { preserveSelection: true });
        }
    });

    // Panel width hiệu dụng: lúc kéo resize dùng live width (style.width), không chỉ store.
    const panelWidthForClamp = livePanelWidth ?? thumbWidth;

    // Khi thu hẹp panel / Ctrl+wheel phóng to thumb, clamp theo panel để không cắt
    // outline và thanh cuộn. Giữ mật độ 0.72 hiện tại để bản sửa parity không làm
    // toàn bộ thumbnail đang quen mắt phóng lớn đồng loạt.
    const THUMB_H_PAD = 52; // px-2 list + px-3 item + outline + scrollbar (~12)
    const maxFootprintW = Math.max(48, panelWidthForClamp - THUMB_H_PAD);
    const fittedThumbBase = Math.min(
        thumbBaseWidth,
        Math.floor(maxFootprintW * 0.72), // giữ mật độ thị giác hiện tại của sidebar
    );
    const displayThumbBase = Math.max(40, fittedThumbBase);

    // thumbRev: pdfUrl đổi sau mỗi edit-commit → force re-render IPC + revoke blob cũ.
    const thumbRev = pdfUrl || '';
    // PERF (feedback 2026-08-21 §EDIT.THUMB1): nhóm một lần theo trang nguồn.
    // MemoThumbItem chỉ so slice của chính trang đó nên edit trang 2 không làm hàng
    // trăm thumbnail khác render lại; đồng thời không phát thêm request PDFium.
    const editPreviewsBySourcePage = React.useMemo(
        () => groupEditPreviewsBySourcePage(editSessionPreviews),
        [editSessionPreviews],
    );

    // UIUX (audit 2026-07-27 §C-19): nút −/+ đổi cỡ thumbnail. Tái dùng ĐÚNG đường
    // Ctrl+wheel trong useViewerZoom (setThumbBaseWidth + clamp 50–400 theo bề rộng
    // panel) bằng cách phát WheelEvent tổng hợp trên sidebar — setter không được luồn
    // qua props và AcrobatViewer nằm ngoài phạm vi sửa. deltaY×-0.1 = Δwidth → ∓250 = ±25px.
    const nudgeThumbSize = useCallback((dir: 1 | -1) => {
        sidebarRef.current?.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, ctrlKey: true, deltaY: dir * -250,
        }));
    }, [sidebarRef]);

    // UIUX (audit 2026-07-27 §C-12): title động khi chưa chọn trang — nói rõ vì sao nút mờ.
    const noSelectionTitle = t('misc.thumbSidebar:chon_trang_truoc_hint', 'Chọn trang trước (click / Shift+click / Ctrl+A)');
    const hasSelection = selectedIndices.size > 0;

    // ═══ Lazy-load thumbnails ═══
    // Chỉ tải tile cho thumbnail đang nằm trong tầm nhìn (IntersectionObserver), kết hợp
    // cổng "trang chính hiển thị trước". Tránh việc mở file nhiều trang fire hàng loạt
    // request thumbnail làm nghẽn pdfium handle dùng chung với trang chính.
    const thumbsGateOpen = useThumbLoadGate(pdfUrl, file?.__editCommit === true);
    const [visibleThumbs, setVisibleThumbs] = useState<Set<number>>(new Set());
    const thumbObserverRef = useRef<IntersectionObserver | null>(null);

    useEffect(() => {
        if (file?.__editCommit) return;
        // Danh sách quan sát thuộc tài liệu cũ; xóa khi URL tài liệu đổi để IntersectionObserver đăng ký lại.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- đồng bộ cache quan sát với PDF ngoại vi.
        setVisibleThumbs(new Set());
    }, [file, pdfUrl]);

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
            style={{ width: isThumbMenuOpen ? (livePanelWidth ?? thumbWidth) : 40 }}
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
                            {/* UIUX (audit 2026-07-27 §C-19): nút −/+ đổi cỡ thumbnail (±25px, cùng clamp với Ctrl+wheel) */}
                            <button
                                className="w-6 h-7 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-zinc-200 transition-colors text-[14px] font-bold leading-none"
                                title={t('misc.thumbSidebar:thu_nho_thumbnail_hint', 'Thu nhỏ thumbnail (Ctrl+lăn chuột trên danh sách cũng đổi được)')}
                                onClick={() => nudgeThumbSize(-1)}
                            >−</button>
                            <button
                                className="w-6 h-7 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-zinc-200 transition-colors text-[14px] font-bold leading-none"
                                title={t('misc.thumbSidebar:phong_to_thumbnail_hint', 'Phóng to thumbnail (Ctrl+lăn chuột trên danh sách cũng đổi được)')}
                                onClick={() => nudgeThumbSize(1)}
                            >+</button>
                            <div className="w-[1px] h-4 bg-slate-300 dark:bg-zinc-600 mx-0.5"></div>
                            <button
                                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${hasSelection ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-zinc-200' : 'text-slate-300 dark:text-zinc-600 cursor-not-allowed'}`}
                                title={hasSelection ? t('misc.thumbSidebar:xoay_trai_rotate_ccw') : noSelectionTitle} /* UIUX (audit 2026-07-27 §C-12) */
                                onClick={() => handleQuickRotate(270)}
                                disabled={!hasSelection}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                            </button>
                            <button
                                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${hasSelection ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-zinc-200' : 'text-slate-300 dark:text-zinc-600 cursor-not-allowed'}`}
                                title={hasSelection ? t('misc.thumbSidebar:xoay_phai_rotate_cw') : noSelectionTitle} /* UIUX (audit 2026-07-27 §C-12) */
                                onClick={() => handleQuickRotate(90)}
                                disabled={!hasSelection}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg>
                            </button>
                            <div className="w-[1px] h-4 bg-slate-300 dark:bg-zinc-600 mx-0.5"></div>
                            <button
                                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${hasSelection ? 'hover:bg-black/10 dark:hover:bg-white/10 text-red-600 dark:text-red-400' : 'text-slate-300 dark:text-zinc-600 cursor-not-allowed'}`}
                                title={hasSelection ? t('misc.thumbSidebar:xoa_trang_delete') : noSelectionTitle} /* UIUX (audit 2026-07-27 §C-12) */
                                onClick={() => setIsDeleteModalOpen(true)}
                                disabled={!hasSelection}
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

            {/* UIUX (audit 2026-07-27 §C-12) fix-verify: hàng hint LUÔN chiếm chỗ trong flow,
                chỉ ẩn/hiện bằng visibility — chèn/gỡ theo hasSelection làm dải thumbnail nhảy
                ~24px giữa thao tác (phá double-click). */}
            {isThumbMenuOpen && pageOrder.length > 1 && (
                <div className={`shrink-0 w-full px-3 py-1 text-[10px] text-app-text-3 border-b border-black/5 dark:border-white/5 truncate ${hasSelection ? 'invisible' : ''}`}>
                    {t('misc.thumbSidebar:shift_ctrl_click_chon_nhieu', 'Shift/Ctrl+click để chọn nhiều')}
                </div>
            )}

            {/* Thumbnail List */}
            {isThumbMenuOpen ? (
                <div
                    className="flex-1 min-h-0 w-full flex flex-col font-sans transition-colors relative select-none"
                    onClick={() => setContextMenu(null)}
                    onMouseDown={handleMarqueeMouseDown}
                >
                    {/* UIUX (audit 2026-07-27 §C-16): trong lúc cổng 700ms chưa mở (ưu tiên render
                        trang chính trước), báo lý do thumbnail chưa hiện thay vì spinner trơ. */}
                    {!thumbsGateOpen && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                            <span className="text-[10px] text-app-text-3 text-center px-2">
                                {t('misc.thumbSidebar:dang_uu_tien_trang_chinh', 'Đang ưu tiên hiển thị trang chính...')}
                            </span>
                        </div>
                    )}
                    <div
                        className="acro-thumb-scroll w-full h-full overflow-y-auto overflow-x-hidden"
                        data-pdf-url={pdfUrl || undefined}
                        data-file-name={file?.name || undefined}
                    >
                        <div className="flex flex-wrap gap-4 justify-center px-2 py-4 w-full max-w-full box-border">
                            {/* PERF (audit 2026-08-22 §UX.TH.08): không cắt danh sách theo
                                cap 1000. IntersectionObserver + isLoadable mới là cổng
                                dựng ảnh; mọi trang vẫn tồn tại để Ctrl+A, tìm trang và
                                điều hướng không bị "chọn được nhưng không nhìn thấy". */}
                            {pageOrder.map((originalPageNum, index) => {
                                const logicalPageLabel = index + 1;
                                const isSelected = selectedIndices.has(index);
                                const isActive = activePage === logicalPageLabel;
                                const isDragged = draggedIndex !== null && isSelected;
                                const isHoverTarget = hoverTargetIndex === index && !isSelected;
                                const dropColor = isCopyDrag ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : 'border-blue-500 bg-blue-50 dark:bg-blue-900/20';
                                const hoverTargetState = isHoverTarget ? (dropPosition === 'after' ? `border-r-[3px] ${dropColor}` : `border-l-[3px] ${dropColor}`) : '';

                                return (
                                    <MemoThumbItem
                                        key={pageInstanceIds[index]
                                            ? `thumb-${pageInstanceIds[index]}`
                                            : `thumb-${index}-${originalPageNum}`}
                                        index={index}
                                        originalPageNum={originalPageNum}
                                        logicalPageLabel={logicalPageLabel}
                                        isSelected={isSelected}
                                        isActive={isActive}
                                        isDragged={isDragged}
                                        showCopyBadge={isDragged && isCopyDrag}
                                        showCopyDropBadge={isHoverTarget && isCopyDrag} // UIUX (audit 2026-07-27 §C-11)
                                        hoverTargetState={hoverTargetState}
                                        rot={pageInstanceIds[index] ? (pageRotations[pageInstanceIds[index]] || 0) : 0}
                                        localDim={allPageDims[originalPageNum]}
                                        thumbBaseWidth={displayThumbBase}
                                        pdfUrl={pdfUrl}
                                        thumbRev={thumbRev}
                                        pageCount={numPages}
                                        file={file}
                                        isLoadable={thumbsGateOpen && visibleThumbs.has(index)}
                                        isViewerActive={isViewerActive}
                                        workflowStatus={stickerSheetWorkflowStatusAtViewerPosition(pageWorkflowStatuses, index)}
                                        editPreviews={editPreviewsBySourcePage.get(originalPageNum)}
                                        registerRef={registerThumbRef}
                                        handleThumbClick={handleThumbClick}
                                        handlePointerDown={handlePointerDown}
                                        onContextMenu={(e: React.MouseEvent, idx: number, label: number) => {
                                            e.preventDefault();
                                            if (!selectedIndices.has(idx)) {
                                                setSelectedIndices(new Set([idx]));
                                                navigatePage(label, { preserveSelection: true });
                                                setLastSelectedIndex(idx);
                                            }
                                            setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
                                        }}
                                    />
                                );
                            })}
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
