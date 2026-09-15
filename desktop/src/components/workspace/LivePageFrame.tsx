import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useReducer } from 'react';
import { createPortal } from 'react-dom';
import { Page } from 'react-pdf';
import { localFileUrl } from '../../lib/localFileTransport';
import { authenticatedFetch, getApiUrl, getSystemFonts } from '../../lib/api';
import { adjustCropRegion, cropDragToFrac, cropFracToPixels, type CropAdjustMode, type CropRegionFrac } from '../../lib/cropGeometry';
import {
    getOutputPreviewOverlayOpacity,
    getVisiblePlateOverlaysForPage,
    usesPlateMultiplyBlend,
} from '../../lib/outputPreviewOverlay';
import { normalizePageHoverPosition } from '../../lib/outputPreviewSampling';
import {
    cacheTileUrl,
    getCachedTileUrl,
    hasCachedTileUrl,
    type TileUrlSource,
} from '../../lib/tileUrlCache';
import { useCropPointerDrawing } from '../../hooks/useCropPointerDrawing';
import type { VdpToolField } from '../../hooks/useVdpTool';
import { VdpPreviewImage } from './ViewerHelpers';
import OutputPreviewPageBoxLayer from './OutputPreviewPageBoxLayer';
import {
    FIRST_TILE_SLOW_MS,
    INITIAL_TILE_LOAD_STATE,
    isTileLoadCancellation,
    tileLoadReducer,
} from '../../hooks/viewer/tileRenderScheduler';
import { nativeRenderCoordinator } from '../../hooks/viewer/renderCoordinator';
import {
    accurateViewerRequestScale,
    accurateViewerRasterDpr,
    progressiveViewerColorStages,
    type ViewerColorStage,
} from '../../hooks/viewer/useTileRenderer';
import { globalPdfObjectCache, type CachedPdfObject } from '../../stores/pdfObjectCache';
import { useWorkspaceStore, type WorkspacePreflightIssue } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { useAppSettingsStore } from '../../stores/appSettingsStore'; // §R.9 (audit độ nét 2026-07-28)
import { useShallow } from 'zustand/react/shallow';
import type { ObjType, BBox, EditOp, ImageClipShape } from './editTypes';
import type { SessionOpOutcome } from '../../hooks/useEditSession';
import { FontSelector } from '../preprocess-tools/FontSelector';
import { Lock, Check, X, RotateCcw, RotateCw, AlertTriangle, ImageUp, Trash2, Type, Shapes, Square, Circle, Triangle, Diamond, Pentagon, Hexagon, Octagon, Star, Heart, Plus } from 'lucide-react';
import {
    pageWidthPtFromDim,
    pageHeightPtFromDim,
    editScale as calcEditScale,
    objectBboxNativeToCanvas,
    clipRectPdfToCanvas,
    addBboxCanvasToNative,
    moveDeltaCanvasToPdf,
    pickFontForName as pickFontForNameUtil,
} from './editGeometry';
import { shouldLoadEditObjectsForFrame } from '../acrobat/thumbnailEditPreview';
import { formatPageNumber, applyTokens, effectiveLR } from '../../lib/stampFormat';
import { useTranslation } from 'react-i18next';
import {
    EDIT_OBJECT_FOCUS_EVENT,
    findNearestVerticalScrollContainer,
    readEditObjectFocusRequest,
    scrollElementVerticallyIntoView,
} from './verticalScroll';
import { buildPropertyAffine, mmToPt, pickTopmostObjectAtPoint, ptToMm, selectionBounds } from './editTransformMath';
import { previewPerfLog, viewerTraceHash, viewerTraceLog } from '../../lib/previewPerfLog';
import {
    adoptViewerFirstFrame,
    peekViewerFirstFrame,
    releaseViewerFirstFrame,
    viewerFirstFrameMatchesTile,
    type ViewerFirstFrame,
} from '../../lib/viewerFirstFrame';
import {
    computeAccurateViewerBaseZoom,
    computeRenderZoomPure,
    computeViewerBackgroundZoom,
    isViewerFullPageWithinSurfaceBudget,
    RENDER_BUDGET_PX,
    shouldUseViewerViewportTiles,
    VIEWPORT_TILE_SETTLE_MS,
} from './renderZoomPolicy';
import {
    computeDevicePixelSnapOffset,
    computeViewportTilePanGridSpecs,
    computeViewportTileCrossfadeMs,
    computeViewportTileSeamSafePresentationRect,
    computeViewportTileSpec,
    createRafCoalescer,
    createViewportTileRetirementScheduler,
    mapRotatedViewportToPage,
    reduceViewportTileBuffer,
    splitViewportTilePanGridPhases,
    type ViewportTileBufferAction,
    type ViewportTileBufferState,
    type ViewportTilePanPrefetchTier,
    type ViewportRect,
    type ViewportTileSpec,
    VIEWPORT_TILE_CROSSFADE_MAX_MS,
    VIEWPORT_TILE_RUNWAY_PAD,
    viewportTileBufferGroup,
    viewportTileCoversViewport,
    viewportTileGridCoversViewport,
    viewportTilePanCellSize,
    viewportTilePanPhaseKey,
    viewportTilePresentationItems,
} from './viewportTilePolicy';

import {
    VIEWER_RASTER_IMAGE_RENDERING,
    viewerAccurateBaseScaleForRole,
    viewerPageRenderPriority,
    shouldCompositeViewerTile,
    shouldRenderViewerBaseTile,
    shouldRenderViewerAccurateBaseTile,
    shouldRenderViewerAccurateUnderlay,
    selectViewerAccurateBaseZoom,
    shouldEnableViewerAccurateLayer,
    shouldEnableViewerViewportAccurateTile,
    viewerPanGridRenderPolicy,
    shouldPresentViewerPanGrid,
    shouldUseViewerDisplayLayer,
    shouldUseViewerAccurateSimulation,
    shouldUseViewerDirectFullPageSurface,
    viewerSurfaceSwapMs,
    shouldShowOutputPreviewBitmap,
    isViewerTargetScaleReady,
    shouldKeepViewerAccurateBaseMounted,
    shouldRequestViewerAccurateBase,
    shouldRenderViewerBasePage,
    viewerBackgroundRenderOwnerId,
    shouldMountViewerViewportLayer,
    viewerRenderGroupKey,
    viewerTileFileKey,
} from './livePageFramePolicy';

// Mảng rỗng ỔN ĐỊNH — không tạo `[]` mới mỗi effect (tránh cascade setState).
const EMPTY_OBJECT_IDS: string[] = [];
// Offset lệch cố định (mm) cho mỗi lần dán — cộng dồn theo pasteCount.
const PASTE_OFFSET_MM = 3;

// ─── Edit PDF Object (task 10.1) ─────────────────────────────────────────────
// Object do GET /edit/objects trả về, SAU khi đã convert bbox PDF (bottom-left)
// → hệ canvas top-left (point), để dùng chung công thức `x * scale` với overlay
// Selection_Mode sẵn có. `bbox` ở đây luôn là [x0, y0_top, x1, y1_bottom] (top-left).
interface EditCanvasObj {
    id: string;
    drawIndex: number;
    type: ObjType;
    ocgIds?: number[];
    ocgNames?: string[];
    bbox: BBox; // top-left origin, đơn vị point
    nativeBbox?: BBox; // PDF user-space, bottom-left origin
    matrix?: number[];
    content?: string; // nội dung text gốc (type='text') để điền sẵn editor
    color?: number[]; // màu tô RGB 0..255 (type='text') để editor khớp màu gốc
    fontName?: string; // tên font gốc (BaseFont) để gợi ý/khớp font hệ thống
}

function isNonPaintingPointTextObject(obj: { type?: unknown; bbox?: unknown } | null | undefined): boolean {
    if (obj?.type !== 'text' || !Array.isArray(obj?.bbox) || obj.bbox.length !== 4) return false;
    return Math.abs(Number(obj.bbox[2]) - Number(obj.bbox[0])) <= 0.01
        && Math.abs(Number(obj.bbox[3]) - Number(obj.bbox[1])) <= 0.01;
}
// ─── Edit PDF Object — move/resize/rotate (task 10.2) ────────────────────────
// Hệ handle nw/ne/sw/se được TÁI DÙNG từ `vdpInteraction`, THÊM handle xoay.
type EditHandle = 'nw' | 'ne' | 'sw' | 'se';

// Trạng thái một thao tác transform đang diễn ra (kéo chuột). startBox là hộp bao
// hợp nhất (union) của các object được chọn TẠI THỜI ĐIỂM BẮT ĐẦU kéo, theo px
// canvas (gốc trên-trái). startX/startY là vị trí chuột (đã khử xoay) lúc bắt đầu.
interface EditInteraction {
    type: 'move' | 'resize' | 'rotate';
    handle?: EditHandle;
    startX: number;
    startY: number;
    startBox: { left: number; top: number; width: number; height: number };
}

// Transform TẠM (preview real-time) áp lên overlay bằng CSS — KHÔNG fetch/lưu mỗi
// frame (Yêu cầu 13.2). dx/dy theo px canvas; sx/sy là hệ số; rotateDeg theo hệ
// MÀN HÌNH (clockwise dương vì trục y canvas hướng xuống).
type EditLiveTransform =
    | { kind: 'move'; dx: number; dy: number }
    | { kind: 'resize'; sx: number; sy: number; anchor: EditHandle }
    | { kind: 'rotate'; rotateDeg: number };

// Handle người dùng kéo → góc NEO cố định (góc đối diện). Backend resize_objects
// nhận trực tiếp góc cố định này; nhãn nw/ne/sw/se ở đây là theo VỊ TRÍ NHÌN THẤY
// và trùng ngữ nghĩa với _anchor_point của backend ('n' = mép trên nhìn thấy).
const EDIT_OPPOSITE_ANCHOR: Record<EditHandle, EditHandle> = {
    nw: 'se', ne: 'sw', sw: 'ne', se: 'nw',
};

// Góc neo cố định → transform-origin CSS (để scale overlay quanh đúng góc cố định).
const EDIT_ANCHOR_ORIGIN: Record<EditHandle, string> = {
    nw: '0% 0%', ne: '100% 0%', sw: '0% 100%', se: '100% 100%',
};

// ─── Edit PDF Object — thêm object (task 10.3) ───────────────────────────────
// Id "ảo" dùng cho editor text inline khi ĐANG ĐẶT object text MỚI (chưa có id từ
// /edit/objects). TÁI DÙNG chung state editingTextId/editTextContent với editor
// text-object hiện có; sentinel này phân biệt nhánh "thêm mới" vs "sửa cụm có sẵn".
const EDIT_ADD_TEXT_ID = '__edit_add_text__';
// Kích thước/cỡ chữ mặc định (point) cho object MỚI tạo tại điểm bấm.
const EDIT_ADD_TEXT_SIZE_PT = 12;
const EDIT_ADD_TEXT_W_PT = 200;
const EDIT_ADD_IMAGE_SIZE_PT = 150;

// ═══ Edit Objects Cache (chế độ Chỉnh sửa đối tượng) ═══
// Cache danh sách EditCanvasObj theo khóa `${selectionFileId}:${pageIndex}` để
// bật/tắt chế độ KHÔNG phải fetch lại /edit/objects (hết "load lâu khi tắt/bật").
// Clear khi pdfUrl đổi (file mới / commit working-file mới) để không dùng dữ liệu cũ.
const _editObjectsCache = new Map<string, EditCanvasObj[]>();
// Gốc CropBox (bx0,by0) theo cùng khóa cache — để add-text/image quy đổi tọa độ
// canvas (cropbox-relative) ↦ PDF NATIVE đúng trên file có CropBox lệch gốc.
const _editCropOriginCache = new Map<string, [number, number]>();
// eslint-disable-next-line react-refresh/only-export-components
export function clearEditObjectsCache() {
    _editObjectsCache.clear();
    _editCropOriginCache.clear();
}

interface LoadableTileElement extends HTMLDivElement {
    _loadTile?: () => void;
}

interface TileLoadLabels {
    loading: string;
    slow: string;
    error: string;
    cancelled: string;
    retry: string;
    cancel: string;
}
interface TileRequestOptions {
    ownerId?: string;
    groupKey?: string;
    priority?: number;
    colorStage?: ViewerColorStage;
    forceAccurateColor?: boolean;
    /** Token cua mot lan hien thi, dung chung cho coarse/display/accurate. */
    generationKey?: string;
}

interface LiveTileProps {
    fileKey: string;
    pageNum: number;
    pageInstanceId?: string;
    zoom: number;
    coarseZoom?: number;
    rot: number;
    clipX?: number;
    clipY?: number;
    clipW?: number;
    clipH?: number;
    cssLeft?: number;
    cssTop?: number;
    cssW?: number;
    cssH?: number;
    eager?: boolean;
    getTileUrl?: (pageNum: number, rotation: number, zoom: number, clipX?: number, clipY?: number, clipW?: number, clipH?: number, options?: TileRequestOptions) => Promise<TileUrlSource>;
    onVisible: (element: HTMLElement, visible: boolean, eager?: boolean) => void;
    onRenderReady?: () => void;
    onTileReady?: (info: { scale: number }) => void;
    onTileUnmount?: () => void;
    renderOwnerId?: string;
    renderPriority?: number;
    renderEnabled?: boolean;
    showLoadStatus?: boolean;
    loadLabels?: TileLoadLabels;
    progressiveAccurate?: boolean;
    accurateOnly?: boolean;
    cancelAccurateGroup?: (groupKey: string) => void;
    presentationFadeMs?: number;
    seamlessGridPresentation?: boolean;
    initialSource?: TileUrlSource | null;
    preserveUnderlay?: boolean;
}

interface TileLayerProps {
    fileKey: string;
    displayFileKey: string;
    pageNum: number;
    pageInstanceId?: string;
    zoom: number;
    dpr: number;
    accurateDpiAnchor?: number;
    rotation: number;
    displayWidth: number;
    displayHeight: number;
    containerRef: React.RefObject<HTMLElement | null>;
    getTileUrl?: LiveTileProps['getTileUrl'];
    onVisible: LiveTileProps['onVisible'];
    onRenderReady?: () => void;
    onAccurateCommitted?: () => void;
    renderOwnerId?: string;
    accurateColor?: boolean;
    accurateCommitted?: boolean;
    waitForAccurateBase?: boolean;
    keepDisplayUntilAccurate?: boolean;
    renderEnabled?: boolean;
    cancelAccurateGroup?: (groupKey: string) => void;
    initialPpeFrame?: ViewerFirstFrame | null;
    stableUnderlayReady?: boolean;
}

interface TextChar {
    c: string;
}

interface TextLine {
    bbox: { x: number; y: number; w: number; h: number };
    chars?: TextChar[];
}

interface TextBlock {
    lines?: TextLine[];
}

type TextBlocksInput = TextBlock[] | { blocks?: TextBlock[] };

interface EditPreviewLayer {
    page: number;
    url: string;
    full?: boolean;
    clipRect?: BBox | null;
}

const EMPTY_TILE_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
// Export ở mức component để regression test không cho hiện PDFium trong cold-open PPE.
export const LiveTile = React.memo(({ fileKey, pageNum, pageInstanceId, zoom, coarseZoom, rot, clipX, clipY, clipW, clipH, cssLeft, cssTop, cssW, cssH, eager, getTileUrl, onVisible, onRenderReady, onTileReady, onTileUnmount, renderOwnerId, renderPriority = 100, renderEnabled = true, showLoadStatus = false, loadLabels, progressiveAccurate = false, accurateOnly = false, cancelAccurateGroup, presentationFadeMs = 50, seamlessGridPresentation = false, initialSource, preserveUnderlay = false }: LiveTileProps) => {
    const tileRef = useRef<LoadableTileElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const loadAttemptRef = useRef(0);
    const mountedRef = useRef(true);
    const [loadState, dispatchLoadState] = useReducer(tileLoadReducer, INITIAL_TILE_LOAD_STATE);
    const [hasVisibleTile, setHasVisibleTile] = useState(false);
    const onTileReadyRef = useRef(onTileReady);
    onTileReadyRef.current = onTileReady;
    const onTileUnmountRef = useRef(onTileUnmount);
    onTileUnmountRef.current = onTileUnmount;
    const onRenderReadyRef = useRef(onRenderReady);
    onRenderReadyRef.current = onRenderReady;
    const previousOnRenderReadyRef = useRef(onRenderReady);
    const renderPriorityRef = useRef(renderPriority);
    renderPriorityRef.current = renderPriority;
    const showLoadStatusRef = useRef(showLoadStatus);
    showLoadStatusRef.current = showLoadStatus;
    useEffect(() => {
        const previous = previousOnRenderReadyRef.current;
        previousOnRenderReadyRef.current = onRenderReady;
        if (!previous && onRenderReady && hasVisibleTile) {
            // UIUX (feedback 2026-08-14 §VIEW.PAGE): frame prefetch đã decode khi còn
            // ở trang nền. Lúc nó thành active không có sự kiện load mới, nên báo ngay
            // rằng pixel thật đang hiện để mở tiếp cổng prefetch trang kế bên.
            onRenderReadyRef.current?.();
        }
    }, [hasVisibleTile, onRenderReady]);
    const labels = loadLabels as TileLoadLabels | undefined;
    const renderGroupKey = viewerRenderGroupKey(
        pageNum,
        pageInstanceId,
        Boolean(clipW && clipH),
    );
    const traceTileIdRef = useRef(
        viewerTraceHash(`${pageInstanceId || 'page'}:${pageNum}:${clipX}:${clipY}:${clipW}:${clipH}`),
    );
    const traceTileStateRef = useRef({
        enabled: Boolean(showLoadStatus || renderPriority < 100 || seamlessGridPresentation),
        pageNum,
        pageInstanceId: pageInstanceId || '',
        renderPriority,
        renderGroupKey,
    });
    traceTileStateRef.current = {
        enabled: Boolean(showLoadStatus || renderPriority < 100 || seamlessGridPresentation),
        pageNum,
        pageInstanceId: pageInstanceId || '',
        renderPriority,
        renderGroupKey,
    };
    const traceTileEvent = useCallback((event: string, extra: Record<string, unknown> = {}) => {
        const state = traceTileStateRef.current;
        if (!state.enabled) return;
        void viewerTraceLog(event, {
            tile_id: traceTileIdRef.current,
            page: state.pageNum,
            instance: viewerTraceHash(state.pageInstanceId),
            priority: state.renderPriority,
            group: viewerTraceHash(state.renderGroupKey),
            ...extra,
        });
    }, []);
    const readTileDomRect = useCallback((): Record<string, number> => {
        const rect = tileRef.current?.getBoundingClientRect();
        if (!rect) return {};
        return {
            dom_left: Math.round(rect.left * 100) / 100,
            dom_top: Math.round(rect.top * 100) / 100,
            dom_w: Math.round(rect.width * 100) / 100,
            dom_h: Math.round(rect.height * 100) / 100,
        };
    }, []);
    // NÉT (audit độ nét 2026-07-28 §R.4): ép ảnh vẽ ở ĐÚNG kích thước pixel gốc để tỉ lệ
    // scale = 1.0 (map 1:1 device pixel) — đó là điều kiện DUY NHẤT để chữ nét như Acrobat.
    //
    // VÌ SAO TRƯỚC ĐÂY MỜ: bitmap nền do Rust tạo rộng `(width_pt*render_scale) as i32`
    // (CẮT thập phân), còn khung CSS là `Math.ceil(displayWidth)` → lệch tới 1px. Với
    // width:100%/height:100% + objectFit:'fill', browser phải resample bilinear TOÀN trang
    // vì tỉ lệ ≠ 1 → chữ mềm ở MỌI mức zoom, không riêng zoom cao. (Tile sắc của TileLayer
    // vốn đã khớp 1:1 nên nó nét — đó là lý do "chờ xong thì nét".)
    //
    // CHỈ snap khi bitmap gần bằng khung (±2 device px) = trường hợp CHỦ ĐÍCH 1:1. Khi
    // renderZoom bị cap ở zoom cao, bitmap nhỏ hơn khung nhiều và PHẢI giãn ra để phủ kín
    // trang (nếu snap sẽ chừa mảng trống) → giữ nguyên 100%/100% như cũ.
    // Toạ độ overlay (thước, guide, DIM, edit object) neo theo KHUNG chứ không theo ảnh
    // nên đổi kích thước vẽ của <img> không xê dịch gì.
    // NÉT (audit độ nét 2026-07-28 §R.4) fix-verify: TRẢ VỀ GIÃN THEO KHUNG ngay khi khung
    // đổi kích thước. Bắt buộc phải có, vì px tuyệt đối do applyExactFit đặt sẽ "kẹt" lại
    // trong hai tình huống:
    //   1. Zoom đang chuyển: khung đã phình theo zoom mới nhưng tile mới chưa về → ảnh giữ
    //      px cũ → nội dung như bị bóp trong khung trắng rồi mới nhảy lại (bug user báo).
    //   2. Zoom cao: renderZoom bị chặn bởi capByBudget nên tham số tile KHÔNG đổi → không
    //      có lần load mới → onLoad không bao giờ chạy lại → kẹt vĩnh viễn.
    // Chạy ở useLayoutEffect (trước khi browser vẽ) nên không thấy nháy. Tile mới load xong
    // thì onLoad snap lại 1:1 như thiết kế.
    useLayoutEffect(() => {
        const el = imgRef.current;
        if (!el) return;
        el.style.width = '100%';
        el.style.height = '100%';
    }, [cssW, cssH, clipW, clipH, seamlessGridPresentation]);

    const applyExactFit = useCallback((imgEl: HTMLImageElement) => {
        if (seamlessGridPresentation) {
            // UIUX (feedback 2026-08-11 §PAN.SEAM): atlas nằm trên nội dung màu;
            // không co về naturalWidth vì phần thiếu sẽ lộ nền trắng giữa hai cell.
            imgEl.style.width = '100%';
            imgEl.style.height = '100%';
            return;
        }
        const bw = imgEl.naturalWidth;
        const bh = imgEl.naturalHeight;
        const boxW = (cssW || clipW) as number;
        const boxH = (cssH || clipH) as number;
        if (!bw || !bh || !boxW || !boxH) return;
        const dpr = window.devicePixelRatio || 1;
        const wantW = Math.round(boxW * dpr);
        const wantH = Math.round(boxH * dpr);
        if (Math.abs(bw - wantW) <= 2 && Math.abs(bh - wantH) <= 2) {
            imgEl.style.width = `${bw / dpr}px`;
            imgEl.style.height = `${bh / dpr}px`;
        } else {
            imgEl.style.width = '100%';
            imgEl.style.height = '100%';
        }
    }, [cssW, cssH, clipW, clipH, seamlessGridPresentation]);
    const loadedParamsRef = useRef('');
    const inFlightRequestRef = useRef<{ params: string; attempt: number } | null>(null);
    const preloadRef = useRef<HTMLImageElement|null>(null);
    const accurateDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cachedRenderReadyParamsRef = useRef<string | null>(null);
    const ownedBlobUrlsRef = useRef(new Set<string>());
    const hasLoadedOnce = useRef(false);
    const displayedScaleRef = useRef(0);
    const displayedColorRankRef = useRef(0);
    const displayedSurfaceRef = useRef('');
    const cancelledRetryRef = useRef({ params: '', count: 0 });
    const tileTimingRef = useRef<{ params: string; startedAt: number } | null>(null);
    
    const currentParams = `${fileKey}_${pageNum}_${zoom}_${rot}_${clipX}_${clipY}_${clipW}_${clipH}`;
    const surfaceParams = `${fileKey}_${pageNum}_${rot}_${clipX}_${clipY}_${clipW}_${clipH}`;
    const requestedColorRank = accurateOnly || progressiveAccurate ? 2 : 1;
    const initialCacheParamsRef = useRef({
        currentParams,
        zoom,
        requestedColorRank,
        surfaceParams,
    });

    // PERF (audit 2026-08-02 §LOAD.2): đây chỉ là watchdog THÔNG TIN cho first tile.
    // Không timeout invoke, không nhả slot và không mở thêm render PDFium song song.
    useEffect(() => {
        if (!showLoadStatus || loadState.phase !== 'loading') return;
        const attempt = loadState.attempt;
        const timer = setTimeout(() => {
            if (!mountedRef.current) return;
            dispatchLoadState({ type: 'slow', attempt });
            traceTileEvent('tile-slow', { attempt, zoom });
            void previewPerfLog('live-tile-load-slow', { page: pageNum, zoom });
        }, FIRST_TILE_SLOW_MS);
        return () => clearTimeout(timer);
    }, [loadState.attempt, loadState.phase, pageNum, showLoadStatus, traceTileEvent, zoom]);

    useEffect(() => {
        traceTileEvent('tile-mount', {
            render_enabled: renderEnabled,
            accurate_only: accurateOnly,
            progressive_accurate: progressiveAccurate,
            clip: Boolean(clipW && clipH),
            zoom,
            css_w: cssW,
            css_h: cssH,
            clip_x: clipX,
            clip_y: clipY,
            clip_w: clipW,
            clip_h: clipH,
            ...readTileDomRect(),
        });
        return () => {
            traceTileEvent('tile-unmount', {
                loaded: hasLoadedOnce.current,
                phase: loadState.phase,
                attempt: loadAttemptRef.current,
            });
        };
        // Lifecycle trace intentionally belongs to the component instance.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    
    // On mount: immediately restore cached image (no white flash!)
    useEffect(() => {
        const initial = initialCacheParamsRef.current;
        const cachedUrl = getCachedTileUrl(initial.currentParams);
        if (cachedUrl && imgRef.current) {
            loadedParamsRef.current = initial.currentParams;
            cachedRenderReadyParamsRef.current = initial.currentParams;
            imgRef.current.src = cachedUrl;
            hasLoadedOnce.current = true;
            displayedScaleRef.current = initial.zoom;
            displayedColorRankRef.current = initial.requestedColorRank;
            displayedSurfaceRef.current = initial.surfaceParams;
            setHasVisibleTile(true);
            // Show immediately if cached
            if (tileRef.current) tileRef.current.style.opacity = '1';
            // Trang chính đã hiển thị (từ cache) → mở cổng cho thumbnail tải.
            window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
        }
    }, []); // Only on mount

    useEffect(() => {
        const source = initialSource as ViewerFirstFrame | undefined;
        const imgEl = imgRef.current;
        if (!source || !imgEl || hasLoadedOnce.current) return;
        // PERF (audit 2026-08-14 §VIEW.FIRST.1): bitmap này đã render + decode trước
        // khi Workspace mount. Nhận thẳng làm target hiện tại, không phát lại PPE.
        loadedParamsRef.current = currentParams;
        cachedRenderReadyParamsRef.current = currentParams;
        displayedScaleRef.current = zoom;
        displayedColorRankRef.current = requestedColorRank;
        displayedSurfaceRef.current = surfaceParams;
        hasLoadedOnce.current = true;
        setHasVisibleTile(true);
        dispatchLoadState({ type: 'ready', attempt: loadAttemptRef.current });
        const keptInCache = source.cacheable !== false
            && cacheTileUrl(currentParams, source, fileKey);
        if (!keptInCache && source.url.startsWith('blob:')) {
            ownedBlobUrlsRef.current.add(source.url);
        }
        adoptViewerFirstFrame(source);
        imgEl.src = source.url;
        if (tileRef.current) tileRef.current.style.opacity = '1';
        window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
        traceTileEvent('tile-first-frame-adopted', {
            scale: zoom,
            natural_w: source.width,
            natural_h: source.height,
            bytes: source.byteLength,
            cached: keptInCache,
        });
    }, [currentParams, fileKey, initialSource, requestedColorRank, surfaceParams, traceTileEvent, zoom]);
    
    useEffect(() => {
        const el = tileRef.current;
        if (!el) {
            traceTileEvent('tile-effect-no-element');
            return;
        }
        traceTileEvent('tile-effect', {
            render_enabled: renderEnabled,
            zoom,
            clip_x: clipX,
            clip_y: clipY,
            clip_w: clipW,
            clip_h: clipH,
        });
        if (!renderEnabled) {
            if (accurateDelayRef.current !== null) {
                clearTimeout(accurateDelayRef.current);
                accurateDelayRef.current = null;
            }
            el._loadTile = undefined;
            inFlightRequestRef.current = null;
            loadedParamsRef.current = '';
            cachedRenderReadyParamsRef.current = null;
            const attempt = ++loadAttemptRef.current;
            dispatchLoadState({ type: 'replace', attempt, phase: 'idle' });
            if (renderOwnerId) {
                nativeRenderCoordinator.cancelGroup(renderOwnerId, renderGroupKey);
            }
            cancelAccurateGroup?.(renderGroupKey);
            traceTileEvent('tile-disabled', { reason: 'render-disabled', attempt });
            return;
        }

        if (loadedParamsRef.current === currentParams && hasLoadedOnce.current) {
            // Cache/bitmap hiện tại đã đúng generation; sự kiện load của chính ảnh đó
            // chịu trách nhiệm báo onTileReady, không phát callback hai lần.
            traceTileEvent('tile-skip-loaded', { attempt: loadAttemptRef.current });
            onRenderReadyRef.current?.();
            return;
        }

        const canKeepSharperSurface = hasLoadedOnce.current
            && displayedSurfaceRef.current === surfaceParams
            && displayedScaleRef.current + 0.001 >= zoom
            && displayedColorRankRef.current >= requestedColorRank;
        if (canKeepSharperSurface) {
            // UIUX (feedback 2026-08-11 §VIEW.SURFACE): scale thấp hơn không mang
            // thêm chi tiết. Giữ nguyên bitmap đã decode và chỉ co bằng compositor;
            // không phát PPE thấp DPI rồi tự hạ chất lượng surface đang đọc được.
            loadedParamsRef.current = currentParams;
            cachedRenderReadyParamsRef.current = null;
            dispatchLoadState({ type: 'ready', attempt: loadAttemptRef.current });
            traceTileEvent('tile-skip-sharper-surface', {
                scale: displayedScaleRef.current,
                requested_color_rank: requestedColorRank,
            });
            onTileReadyRef.current?.({ scale: displayedScaleRef.current });
            onRenderReadyRef.current?.();
            return;
        }

        // Trang prefetch đã có ảnh thì giữ nguyên; không hạ ảnh sharp cũ xuống coarse.
        // Khi nó thành active, priority đổi và luồng sharp tiếp tục trên ảnh đang hiển thị.
        if (renderPriorityRef.current >= 100 && hasLoadedOnce.current) {
            traceTileEvent('tile-skip-prefetch-loaded');
            return;
        }
        
        // Check cache before scheduling network load
        const cachedUrl = getCachedTileUrl(currentParams);
        if (cachedUrl && imgRef.current) {
            loadedParamsRef.current = currentParams;
            cachedRenderReadyParamsRef.current = currentParams;
            imgRef.current.src = cachedUrl;
            hasLoadedOnce.current = true;
            displayedScaleRef.current = zoom;
            displayedColorRankRef.current = requestedColorRank;
            displayedSurfaceRef.current = surfaceParams;
            setHasVisibleTile(true);
            if (tileRef.current) tileRef.current.style.opacity = '1';
            traceTileEvent('tile-cache-hit', { zoom, requested_color_rank: requestedColorRank });
            return;
        }
        
        let effectRequestAttempt: number | null = null;
        el._loadTile = () => {
            // PERF (audit 2026-08-14 §VIEW.LARGE.3): effect gọi ngay để không phụ thuộc paint,
            // rồi IntersectionObserver có thể gọi lại trước khi request đầu hoàn tất. Cùng params
            // đang bay phải dùng chính request đó; gọi lại sẽ tự hủy PPE generation 1 và dựng lại
            // toàn bộ atlas dù DPI/clip không đổi.
            if (inFlightRequestRef.current?.params === currentParams) {
                traceTileEvent('tile-skip-inflight', { attempt: inFlightRequestRef.current.attempt });
                return;
            }
            if (loadedParamsRef.current === currentParams && hasLoadedOnce.current) {
                traceTileEvent('tile-skip-loaded-request');
                return;
            }
            if (!getTileUrl) {
                traceTileEvent('tile-skip-no-url-builder');
                return;
            }
            const paramsAtRequest = currentParams;
            if (cancelledRetryRef.current.params !== paramsAtRequest) {
                cancelledRetryRef.current = { params: paramsAtRequest, count: 0 };
            }
            const attempt = ++loadAttemptRef.current;
            tileTimingRef.current = { params: paramsAtRequest, startedAt: performance.now() };
            effectRequestAttempt = attempt;
            inFlightRequestRef.current = { params: paramsAtRequest, attempt };
            const clearInFlightRequest = () => {
                if (inFlightRequestRef.current?.attempt === attempt) {
                    inFlightRequestRef.current = null;
                }
            };
            const requestIsCurrent = () => mountedRef.current
                && loadAttemptRef.current === attempt
                && inFlightRequestRef.current?.attempt === attempt
                && inFlightRequestRef.current.params === paramsAtRequest;
            cachedRenderReadyParamsRef.current = null;
            if (displayedSurfaceRef.current !== surfaceParams) {
                displayedScaleRef.current = 0;
                displayedColorRankRef.current = 0;
            }
            dispatchLoadState({ type: 'start', attempt });
            traceTileEvent('tile-request-start', {
                attempt,
                scale: zoom,
                color_stage: accurateOnly || progressiveAccurate ? 'accurate' : 'display',
                clip_x: clipX,
                clip_y: clipY,
                clip_w: clipW,
                clip_h: clipH,
            });
            if (showLoadStatusRef.current) void previewPerfLog('live-tile-load-start', { page: pageNum, zoom });
            
            // Cancel previous preload
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current.onerror = null;
                preloadRef.current = null;
            }

            // Tải tile ở 'scale'. onReady chạy ngay khi bytes thành blob URL, trước decode ảnh,
            // để sharp kịp vào scheduler trước coarse prefetch của trang kế bên.
            const loadAt = (
                scale: number,
                cache: boolean,
                onReady?: () => void,
                colorStage?: ViewerColorStage,
            ) => {
                const colorRank = colorStage === 'accurate' ? 2 : 1;
                traceTileEvent('tile-url-request', {
                    attempt,
                    scale,
                    color_stage: colorStage || 'display',
                    cache,
                    priority: renderPriorityRef.current,
                });
                const tileRequest = getTileUrl(pageNum, rot, scale, clipX, clipY, clipW, clipH, {
                    ownerId: renderOwnerId,
                    groupKey: renderGroupKey,
                    priority: renderPriorityRef.current,
                    colorStage,
                    forceAccurateColor: colorStage === 'accurate',
                    generationKey: paramsAtRequest,
                });
                tileRequest
                    .then((source: TileUrlSource) => {
                        const { url } = source;
                        traceTileEvent('tile-url-resolved', {
                            attempt,
                            scale,
                            color_stage: colorStage || 'display',
                            bytes: source.byteLength,
                            source_kind: url.startsWith('blob:') ? 'blob' : url.startsWith('data:') ? 'data' : 'other',
                        });
                        if (url.startsWith('blob:') && !url.includes('#keep')) {
                            ownedBlobUrlsRef.current.add(url);
                        }
                        if (!requestIsCurrent() || !nativeRenderCoordinator.isSourceCurrent(source)) {
                            traceTileEvent('tile-source-discarded', {
                                attempt,
                                scale,
                                request_current: requestIsCurrent(),
                                source_current: nativeRenderCoordinator.isSourceCurrent(source),
                            });
                            nativeRenderCoordinator.markDiscarded(source);
                            if (ownedBlobUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
                            return;
                        }
                        const preImg = new Image();
                        preloadRef.current = preImg;
                        traceTileEvent('tile-decode-start', { attempt, scale, color_stage: colorStage || 'display' });
                        preImg.onload = () => {
                            const keepsOrRaisesQuality = shouldCompositeViewerTile(
                                displayedColorRankRef.current,
                                displayedScaleRef.current,
                                colorStage,
                                scale,
                            );
                            const current = requestIsCurrent()
                                && keepsOrRaisesQuality
                                && nativeRenderCoordinator.isSourceCurrent(source);
                            nativeRenderCoordinator.markDecoded(source, {
                                width: preImg.naturalWidth,
                                height: preImg.naturalHeight,
                                current,
                            });
                            if (!current) {
                                traceTileEvent('tile-decode-discarded', {
                                    attempt,
                                    scale,
                                    request_current: requestIsCurrent(),
                                    quality_current: keepsOrRaisesQuality,
                                    source_current: nativeRenderCoordinator.isSourceCurrent(source),
                                });
                                if (ownedBlobUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
                                if (preloadRef.current === preImg) preloadRef.current = null;
                                return;
                            }
                            // Sharp có thể decode trước coarse vì được enqueue ngay khi coarse có URL.
                            // COLOR (audit 2026-08-08 §RENDER.3): PPE đã hiển thị không được
                            // PDFium cùng scale hoàn tất muộn ghi đè rồi đổi hue trở lại.
                            displayedScaleRef.current = scale;
                            displayedColorRankRef.current = colorRank;
                            displayedSurfaceRef.current = surfaceParams;
                            const imgEl = imgRef.current;
                            if (imgEl) {
                                const oldSrc = imgEl.src;
                                imgEl.src = url;
                                const keptInCache = cache && source.cacheable !== false
                                    && cacheTileUrl(paramsAtRequest, source, fileKey);
                                if (keptInCache) ownedBlobUrlsRef.current.delete(url);
                                if (oldSrc && oldSrc.startsWith('blob:') && oldSrc !== url && !oldSrc.includes('#keep')) {
                                    if (!hasCachedTileUrl(oldSrc)) URL.revokeObjectURL(oldSrc);
                                    ownedBlobUrlsRef.current.delete(oldSrc);
                                }
                            }
                            if (!onReady) {
                                // Chỉ stage cuối mới chứng minh target hiện tại đã hoàn tất.
                                // Coarse/intermediate có thể đã nhìn thấy nhưng vẫn phải giữ
                                // in-flight để stage nét tiếp tục và để effect mới không hiểu
                                // nhầm bitmap tạm là kết quả cuối. Giữ cờ tới sau decode để
                                // preImg.onload của stage cuối không bị đánh dấu stale sớm.
                                loadedParamsRef.current = paramsAtRequest;
                                clearInFlightRequest();
                            }
                            if (!hasLoadedOnce.current) {
                                hasLoadedOnce.current = true;
                                if (tileRef.current) tileRef.current.style.opacity = '1';
                                // Trang chính vừa hiển thị → mở cổng cho thumbnail tải
                                // (tránh thumbnail tranh chấp pdfium handle với trang chính).
                                window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
                            }
                            setHasVisibleTile(true);
                            cancelledRetryRef.current = { params: paramsAtRequest, count: 0 };
                            dispatchLoadState({ type: 'ready', attempt });
                            traceTileEvent('tile-commit', {
                                attempt,
                                scale,
                                color_stage: colorStage || 'display',
                                natural_w: preImg.naturalWidth,
                                natural_h: preImg.naturalHeight,
                                bytes: source.byteLength,
                                cacheable: source.cacheable !== false,
                                ...readTileDomRect(),
                            });
                            traceTileEvent('tile-first-pixel', {
                                attempt,
                                scale,
                                color_stage: colorStage || 'display',
                                native_to_decode_ms: tileTimingRef.current?.params === paramsAtRequest
                                    ? Math.round(performance.now() - tileTimingRef.current.startedAt)
                                    : null,
                            });
                            // PERF (audit 2026-08-08 §RENDER.1): chỉ mở metadata pha B
                            // sau khi bitmap trang active đã render + decode + hiện lên DOM.
                            onRenderReadyRef.current?.();
                            if (showLoadStatusRef.current) void previewPerfLog('live-tile-load-ready', { page: pageNum, zoom: scale });
                            if (preloadRef.current === preImg) preloadRef.current = null;
                        };
                        preImg.onerror = () => {
                            const current = requestIsCurrent()
                                && nativeRenderCoordinator.isSourceCurrent(source);
                            if (current) nativeRenderCoordinator.markDecodeFailed(source);
                            else nativeRenderCoordinator.markDiscarded(source);
                            if (preloadRef.current === preImg) preloadRef.current = null;
                            if (ownedBlobUrlsRef.current.delete(url)) URL.revokeObjectURL(url);
                            if (onReady) return; // sharp đã được nối ngay sau khi gán src
                            if (!current) return;
                            onRenderReadyRef.current?.();
                            loadedParamsRef.current = '';
                            clearInFlightRequest();
                            dispatchLoadState({ type: 'error', attempt });
                            traceTileEvent('tile-decode-error', { attempt, scale, color_stage: colorStage || 'display' });
                            if (showLoadStatusRef.current) void previewPerfLog('live-tile-load-error', { page: pageNum, stage: 'decode' });
                        };
                        nativeRenderCoordinator.markDecodeStarted(source);
                        preImg.src = url;
                        if (onReady) onReady();
                    })
                    .catch((error: unknown) => {
                        if (onReady) {
                            if (requestIsCurrent()) onReady();
                            return;
                        }
                        if (!requestIsCurrent()) return;
                        const cancelled = isTileLoadCancellation(error);
                        traceTileEvent('tile-url-error', {
                            attempt,
                            cancelled,
                            error: error instanceof Error ? error.name : typeof error,
                        });
                        if (
                            cancelled
                            && cancelledRetryRef.current.params === paramsAtRequest
                            && cancelledRetryRef.current.count < 1
                        ) {
                            // UIUX (feedback 2026-08-09 §RENDER.F4): latest-wins/viewport
                            // có quyền thay request nội bộ, nhưng đó không phải lỗi trang. Nối
                            // lại đúng một lần trước khi chuyển thành lỗi cuối, tránh bắt người
                            // dùng bấm "Thử lại" cho một cancellation kỹ thuật thoáng qua.
                            cancelledRetryRef.current.count += 1;
                            loadedParamsRef.current = '';
                            clearInFlightRequest();
                            queueMicrotask(() => {
                                if (!mountedRef.current || loadAttemptRef.current !== attempt) return;
                                tileRef.current?._loadTile?.();
                            });
                            return;
                        }
                        loadedParamsRef.current = '';
                        clearInFlightRequest();
                        if (!cancelled) onRenderReadyRef.current?.();
                        dispatchLoadState({ type: cancelled ? 'cancelled' : 'error', attempt });
                        traceTileEvent(cancelled ? 'tile-cancelled' : 'tile-error', { attempt });
                        if (showLoadStatusRef.current) {
                            const errorName = error instanceof Error ? error.name : typeof error;
                            void previewPerfLog('live-tile-load-error', { page: pageNum, error: errorName });
                        }
                    });
            };

            if (accurateOnly) {
                // COLOR/PERF (feedback 2026-08-09 §RENDER.F9): trang accurate xin
                // thẳng target đọc được; frame PPE 24 DPI từng làm cold-open mờ và
                // còn đẩy request nét xuống sau một lượt render không có giá trị.
                loadAt(zoom, true, undefined, 'accurate');
            } else if (progressiveAccurate) {
                // COLOR (feedback 2026-08-09 §RENDER.F1): detector đã xác nhận trang
                // rủi ro thì stage list chỉ chứa PPE. Không flash PDFium sai gradient/màu.
                const stages = progressiveViewerColorStages(true);
                const loadStage = (index: number) => {
                    const colorStage = stages[index];
                    const hasNext = index + 1 < stages.length;
                    loadAt(
                        zoom,
                        colorStage === 'accurate',
                        hasNext
                            ? () => {
                                if (accurateDelayRef.current !== null) {
                                    clearTimeout(accurateDelayRef.current);
                                }
                                accurateDelayRef.current = setTimeout(() => {
                                    accurateDelayRef.current = null;
                                    if (requestIsCurrent()) {
                                        loadStage(index + 1);
                                    }
                                }, VIEWPORT_TILE_SETTLE_MS);
                            }
                            : undefined,
                        colorStage,
                    );
                };
                loadStage(0);
            } else if (!hasLoadedOnce.current && typeof coarseZoom === 'number' && coarseZoom < zoom - 0.05) {
                // Pha 1: coarse (nhanh) hiện trước → Pha 2: sharp nối sau (tuần tự).
                loadAt(coarseZoom, false, () => {
                    if (requestIsCurrent()) loadAt(zoom, true);
                });
            } else {
                loadAt(zoom, true);
            }
        };
        onVisible(el, false, eager);
        // FIX màn-trắng-khi-occluded: IntersectionObserver CHỈ bắn khi trang được
        // paint; cửa sổ WebView2 bị coi là occluded thì không paint → observer không
        // bắn → tile không được xin → trắng tới ~7s tới khi bị ép paint (mở DevTools).
        // Gọi _loadTile() ĐỒNG BỘ ngay trong effect (không phụ thuộc observer/paint)
        // để tile luôn được nạp tức thì. Observer vẫn giữ làm dự phòng cho tile cuộn xa;
        // _loadTile có guard nên gọi 2 lần là vô hại.
        el._loadTile?.();
        return () => {
            if (accurateDelayRef.current !== null) {
                clearTimeout(accurateDelayRef.current);
                accurateDelayRef.current = null;
            }
            cancelAccurateGroup?.(renderGroupKey);
            if (effectRequestAttempt !== null
                && inFlightRequestRef.current?.attempt === effectRequestAttempt) {
                // UIUX (feedback 2026-08-14 §VIEW.LARGE.4): cleanup effect/StrictMode đã
                // hủy request thì phải nhả dấu in-flight. Effect kế tiếp có thể mang cùng params;
                // giữ dấu cũ sẽ chặn lần xin mới và để trang quay "Đang dựng hình…" vĩnh viễn.
                inFlightRequestRef.current = null;
                loadedParamsRef.current = '';
                loadAttemptRef.current += 1;
                traceTileEvent('tile-effect-cleanup-cancel', {
                    attempt: effectRequestAttempt,
                    next_attempt: loadAttemptRef.current,
                });
            } else {
                traceTileEvent('tile-effect-cleanup', {
                    request_attempt: effectRequestAttempt,
                    in_flight_attempt: inFlightRequestRef.current?.attempt ?? null,
                });
            }
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current.onerror = null;
                preloadRef.current = null;
            }
            el._loadTile = undefined;
            onVisible(el, true, eager);
        };
    }, [accurateOnly, cancelAccurateGroup, clipH, clipW, clipX, clipY, coarseZoom, currentParams, eager, fileKey, getTileUrl, onVisible, pageNum, progressiveAccurate, readTileDomRect, renderEnabled, renderGroupKey, renderOwnerId, requestedColorRank, rot, surfaceParams, traceTileEvent, zoom]);
    
    // Tile đã vào cache sống qua vòng mount của Virtuoso; tile coarse/quá budget
    // vẫn thuộc component và phải thu hồi khi unmount để không rò Blob URL.
    useEffect(() => {
        const ownedBlobUrls = ownedBlobUrlsRef.current;
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            traceTileEvent('tile-unmount-cleanup', {
                attempt: loadAttemptRef.current,
                loaded: hasLoadedOnce.current,
            });
            loadAttemptRef.current += 1;
            inFlightRequestRef.current = null;
            cachedRenderReadyParamsRef.current = null;
            if (accurateDelayRef.current !== null) {
                clearTimeout(accurateDelayRef.current);
                accurateDelayRef.current = null;
            }
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current.onerror = null;
                preloadRef.current = null;
            }
            if (renderOwnerId) nativeRenderCoordinator.cancelGroup(renderOwnerId, renderGroupKey);
            cancelAccurateGroup?.(renderGroupKey);
            for (const url of ownedBlobUrls) {
                if (!hasCachedTileUrl(url)) URL.revokeObjectURL(url);
            }
            ownedBlobUrls.clear();
        };
    }, [cancelAccurateGroup, renderGroupKey, renderOwnerId, traceTileEvent]);
    useEffect(() => () => {
        onTileUnmountRef.current?.();
    }, []);
    // Initialize empty pixel only once (but only if no cached image was restored)
    useEffect(() => {
        if (imgRef.current && !imgRef.current.src) {
            imgRef.current.src = EMPTY_TILE_PIXEL;
        }
    }, []);

    const handleDisplayedImageLoad = (imgEl: HTMLImageElement) => {
        applyExactFit(imgEl);
        if (!imgEl.src || imgEl.src === EMPTY_TILE_PIXEL) return;
        const cachedParamsAtLoad = cachedRenderReadyParamsRef.current;
        cachedRenderReadyParamsRef.current = null;
        hasLoadedOnce.current = true;
        setHasVisibleTile(true);
        dispatchLoadState({ type: 'ready', attempt: loadAttemptRef.current });
        traceTileEvent('tile-dom-image-ready', {
            attempt: loadAttemptRef.current,
            display_decode_ms: tileTimingRef.current?.params === loadedParamsRef.current
                ? Math.round(performance.now() - tileTimingRef.current.startedAt)
                : null,
            natural_w: imgEl.naturalWidth,
            natural_h: imgEl.naturalHeight,
        });
        onTileReadyRef.current?.({ scale: displayedScaleRef.current });
        // PERF (audit 2026-08-08 §RENDER.5): cache hit chỉ mở metadata pha B
        // sau khi trình duyệt đã load/decode đúng bitmap của generation hiện tại.
        if (cachedParamsAtLoad === loadedParamsRef.current) onRenderReadyRef.current?.();
    };

    const retryTile = () => {
        const attempt = ++loadAttemptRef.current;
        traceTileEvent('tile-retry', { attempt });
        if (accurateDelayRef.current !== null) {
            clearTimeout(accurateDelayRef.current);
            accurateDelayRef.current = null;
        }
        loadedParamsRef.current = '';
        inFlightRequestRef.current = null;
        cachedRenderReadyParamsRef.current = null;
        displayedScaleRef.current = 0;
        dispatchLoadState({ type: 'replace', attempt, phase: 'idle' });
        if (preloadRef.current) {
            preloadRef.current.onload = null;
            preloadRef.current.onerror = null;
            preloadRef.current = null;
        }
        if (renderOwnerId) nativeRenderCoordinator.cancelGroup(renderOwnerId, renderGroupKey);
        cancelAccurateGroup?.(renderGroupKey);
        queueMicrotask(() => tileRef.current?._loadTile?.());
    };

    const cancelTile = () => {
        const attempt = ++loadAttemptRef.current;
        traceTileEvent('tile-cancel-click', { attempt });
        if (accurateDelayRef.current !== null) {
            clearTimeout(accurateDelayRef.current);
            accurateDelayRef.current = null;
        }
        loadedParamsRef.current = '';
        inFlightRequestRef.current = null;
        cachedRenderReadyParamsRef.current = null;
        dispatchLoadState({ type: 'replace', attempt, phase: 'cancelled' });
        if (renderOwnerId) nativeRenderCoordinator.cancelGroup(renderOwnerId, renderGroupKey);
        cancelAccurateGroup?.(renderGroupKey);
        if (showLoadStatus) void previewPerfLog('live-tile-load-cancelled', { page: pageNum });
    };

    const showStatusOverlay = showLoadStatus
        && !preserveUnderlay
        && !hasVisibleTile
        && loadState.phase !== 'ready';
    const statusText = loadState.phase === 'slow'
        ? labels?.slow
        : loadState.phase === 'error'
            ? labels?.error
            : loadState.phase === 'cancelled'
                ? labels?.cancelled
                : labels?.loading;
    const showRetry = loadState.phase === 'slow' || loadState.phase === 'error' || loadState.phase === 'cancelled';
    
    return (
        // background:'white' cho khung: khi snap 1:1 (§R.4) bitmap có thể hụt ≤2px so với
        // khung do làm tròn → chừa sợi mảnh ở mép phải/dưới. Nền trắng làm nó vô hình trên
        // trang PDF (PDFium render với clear_color=WHITE), thay vì hở ra nền skeleton xám.
        <div ref={tileRef} style={{ position: 'absolute', left: cssLeft ?? clipX, top: cssTop ?? clipY, width: cssW || clipW, height: cssH || clipH, outline: 'none', opacity: showLoadStatus || hasVisibleTile || preserveUnderlay ? 1 : 0, transition: presentationFadeMs > 0 ? `opacity ${presentationFadeMs}ms cubic-bezier(0.16, 1, 0.3, 1)` : 'none', background: seamlessGridPresentation || (preserveUnderlay && !hasVisibleTile) ? 'transparent' : 'white' }} className="tile-container">
            {/* onLoad chạy cho MỌI đường vào (tải mới, khôi phục từ cache, pixel rỗng ban
                đầu) nên chỉ cần một chỗ để bảo đảm map 1:1 — xem applyExactFit. */}
            <img
                ref={imgRef}
                draggable={false}
                onLoad={(e) => handleDisplayedImageLoad(e.currentTarget)}
                style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'fill',
                    imageRendering: VIEWER_RASTER_IMAGE_RENDERING,
                    pointerEvents: 'none',
                    userSelect: 'none',
                    background: seamlessGridPresentation || preserveUnderlay ? 'transparent' : 'white',
                    opacity: hasVisibleTile ? 1 : 0,
                }}
            />
            {showStatusOverlay && (
                <div
                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-slate-50/95 px-6 text-center dark:bg-zinc-900/95"
                    role={loadState.phase === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                >
                    {loadState.phase === 'error' || loadState.phase === 'cancelled' ? (
                        <AlertTriangle className="h-8 w-8 text-amber-500" aria-hidden="true" />
                    ) : (
                        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-300 border-t-indigo-500" aria-hidden="true" />
                    )}
                    <span className="max-w-sm text-xs font-semibold text-slate-600 dark:text-zinc-300">{statusText}</span>
                    {showRetry && (
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => { event.stopPropagation(); retryTile(); }}
                                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
                            >
                                {labels?.retry}
                            </button>
                            {loadState.phase === 'slow' && (
                                <button
                                    type="button"
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => { event.stopPropagation(); cancelTile(); }}
                                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                                >
                                    {labels?.cancel}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});

// ═══ Viewport tile compositor (chỉ bật ở zoom cao — audit render 2026-07-06) ═══
// Ở zoom cao, single-tile bị cap (computeRenderZoom ≤24 + native max_dim=8000) → bitmap
// nhỏ hơn kích thước hiển thị → browser phóng CSS → mờ. TileLayer chồng LÊN nền single-tile:
// một tile tương tác phủ đúng viewport để nét sớm. Trang accurate đồng thời dựng atlas cell
// cố định ở lane nền; pan giữ identity cell cũ và chỉ bổ sung cell ở rìa. Trang display vẫn
// dùng một tile vì PDFium có handle tuần tự. Phép xoay CSS được inverse-map về hệ trang gốc.
//
// PPE worker mới có nhiều background lane theo RAM/phần cứng, nên các cell kế cận nhỏ có thể
// hoàn tất song song; cách này thay runway bitmap lớn 883–1.148 ms đã đo nhưng vẫn hụt vùng pan.
const TILE_SNAP = 64;   // snap nhỏ giữ cache pan mà không kéo thêm hàng trăm pixel mỗi cạnh
const TILE_MAX = 4000;  // trần set_fixed_size của native (an toàn OOM)
const PAN_PREFETCH_PRIORITY = 100;

function viewportPanPrefetchTier(): ViewportTilePanPrefetchTier {
    if (typeof document === 'undefined') return 'full';
    const root = document.documentElement;
    if (root.classList.contains('perf-low')) return 'low';
    if (root.classList.contains('perf-mid')) return 'mid';
    return 'full';
}

type BufferedViewportTileSpec = ViewportTileSpec & {
    bufferGroup: string;
    reuseGroup: string;
    renderScale: number;
    sourceDisplayWidth: number;
    sourceDisplayHeight: number;
    requiredViewport: ViewportRect;
};

type BufferedViewportPanGridPlan = {
    phaseKey: string;
    all: BufferedViewportTileSpec[];
    near: BufferedViewportTileSpec[];
    outer: BufferedViewportTileSpec[];
};

const TileLayer = React.memo(({ fileKey, displayFileKey, pageNum, pageInstanceId, zoom, dpr, accurateDpiAnchor = 96, rotation, displayWidth, displayHeight, containerRef, getTileUrl, onVisible, onRenderReady, onAccurateCommitted, renderOwnerId, accurateColor = false, accurateCommitted = false, waitForAccurateBase = false, keepDisplayUntilAccurate = false, renderEnabled = true, cancelAccurateGroup, initialPpeFrame, stableUnderlayReady = false }: TileLayerProps) => {
    const traceLayerIdRef = useRef(
        viewerTraceHash(`layer:${pageInstanceId || 'page'}:${pageNum}`),
    );
    const traceLayerLastPlanRef = useRef('');
    const traceLayerEvent = useCallback((event: string, extra: Record<string, unknown> = {}) => {
        if (!accurateColor) return;
        void viewerTraceLog(event, {
            layer_id: traceLayerIdRef.current,
            page: pageNum,
            instance: viewerTraceHash(pageInstanceId || ''),
            ...extra,
        });
    }, [accurateColor, pageInstanceId, pageNum]);
    const [tileBuffer, dispatchTileBuffer] = useReducer(
        (
            state: ViewportTileBufferState<BufferedViewportTileSpec>,
            action: ViewportTileBufferAction<BufferedViewportTileSpec>,
        ) => reduceViewportTileBuffer(state, action),
        { visible: null, target: null },
    );
    const [panGridPlan, setPanGridPlan] = useState<BufferedViewportPanGridPlan | null>(null);
    const [outerEnabledPhaseKey, setOuterEnabledPhaseKey] = useState<string | null>(null);
    const [presentedPanGridPhaseKey, setPresentedPanGridPhaseKey] = useState<string | null>(null);
    const readyPanGridKeysRef = useRef<Set<string>>(new Set());
    const readyPanGridBufferGroupRef = useRef<string | null>(null);
    const retirementScheduler = useMemo(
        () => createViewportTileRetirementScheduler(),
        [],
    );
    const prefersReducedMotion = useMemo(
        () => typeof window !== 'undefined'
            && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
        [],
    );
    useEffect(() => () => retirementScheduler.cancelAll(), [retirementScheduler]);
    useEffect(() => {
        retirementScheduler.cancelExcept(tileBuffer.target?.key ?? null);
    }, [retirementScheduler, tileBuffer.target?.key]);

    // DEBOUNCE zoom (audit tốc độ 2026-07-06): zoom liên tục từng sinh 278 render trung
    // gian. Core PPE đã hủy thật theo scanline, nên trailing 48ms đủ gom wheel mà không
    // để raster lỗi thời giữ lane native lâu.
    // displayWidth/Height cũng phải "đóng băng" theo settledZoom để clip/CSS khớp.
    const [settled, setSettled] = useState({ zoom, displayWidth, displayHeight });
    useEffect(() => {
        const id = setTimeout(
            () => setSettled({ zoom, displayWidth, displayHeight }),
            VIEWPORT_TILE_SETTLE_MS,
        );
        return () => clearTimeout(id);
    }, [zoom, displayWidth, displayHeight]);
    const sZoom = settled.zoom;
    const sDisplayW = settled.displayWidth;
    const sDisplayH = settled.displayHeight;
    const rasterDpr = accurateColor
        ? accurateViewerRasterDpr(sZoom, dpr, accurateDpiAnchor)
        : dpr;
    const liveRenderScale = sZoom * dpr;
    const renderScale = accurateColor
        ? accurateViewerRequestScale(liveRenderScale, accurateDpiAnchor)
        : liveRenderScale;
    const reuseGroup = `${fileKey}:${pageNum}:${accurateColor ? 'accurate' : 'display'}:${rotation || 0}`;
    // PERF (feedback 2026-08-09 §ZOOM.F2): cùng DPI bucket phải dùng cùng
    // generation/cache identity; raw zoom/display CSS không được ép PPE render lại.
    const bufferGroup = viewportTileBufferGroup(
        reuseGroup,
        renderScale,
        sDisplayW,
        sDisplayH,
        rasterDpr,
    );
    if (readyPanGridBufferGroupRef.current !== bufferGroup) {
        // PERF (audit 2026-08-11 §PAN.TURBO-A): ready chỉ có giá trị trong đúng
        // raster bucket; không để cell của zoom/profile cũ làm bỏ nhầm target mới.
        readyPanGridBufferGroupRef.current = bufferGroup;
        readyPanGridKeysRef.current.clear();
    }

    useEffect(() => {
        if (!renderEnabled) return;
        const pageEl = containerRef?.current as HTMLElement | null;
        if (!pageEl) return;
        // Tìm tổ tiên cuộn được (Virtuoso Scroller) để lấy khung nhìn thực.
        let scrollEl: HTMLElement | null = pageEl.parentElement;
        while (scrollEl) {
            const oy = getComputedStyle(scrollEl).overflowY;
            if (oy === 'auto' || oy === 'scroll') break;
            scrollEl = scrollEl.parentElement;
        }
        const compute = () => {
            const pageRect = pageEl.getBoundingClientRect();
            const vp = scrollEl ? scrollEl.getBoundingClientRect() : null;
            const vpLeft = vp ? vp.left : 0;
            const vpTop = vp ? vp.top : 0;
            const vpRight = vp ? vp.right : window.innerWidth;
            const vpBottom = vp ? vp.bottom : window.innerHeight;
            const left = Math.max(0, vpLeft - pageRect.left);
            const top = Math.max(0, vpTop - pageRect.top);
            const right = Math.min(pageRect.width, vpRight - pageRect.left);
            const bottom = Math.min(pageRect.height, vpBottom - pageRect.top);
            const rotatedViewport = { left, top, right, bottom };
            const baseSpec = right <= left || bottom <= top
                ? null
                : computeViewportTileSpec({
                    rotatedViewport,
                    pageWidth: sDisplayW,
                    pageHeight: sDisplayH,
                    rotation,
                    dpr: rasterDpr,
                    pad: VIEWPORT_TILE_RUNWAY_PAD,
                    snap: TILE_SNAP,
                    maxTile: TILE_MAX,
                });
            const requiredViewport = mapRotatedViewportToPage(
                rotatedViewport,
                sDisplayW,
                sDisplayH,
                rotation,
            );
            const toBufferedSpec = (spec: ViewportTileSpec): BufferedViewportTileSpec => ({
                ...spec,
                bufferGroup,
                reuseGroup,
                renderScale,
                sourceDisplayWidth: sDisplayW,
                sourceDisplayHeight: sDisplayH,
                requiredViewport,
                key: `${bufferGroup}:${spec.key}`,
            });
            // PERF/UIUX (feedback 2026-08-11 §PAN.F3): cell neo theo trang nên
            // cùng vùng nội dung giữ nguyên key qua pan. PPE background lane raster
            // các cell gần viewport trước; target chính pad 0 vẫn giữ first-sharp nhanh.
            const panPrefetchTier = viewportPanPrefetchTier();
            const nextPanGrid = accurateColor && baseSpec
                ? computeViewportTilePanGridSpecs({
                    rotatedViewport,
                    pageWidth: sDisplayW,
                    pageHeight: sDisplayH,
                    rotation,
                    dpr: rasterDpr,
                    cellSize: viewportTilePanCellSize(panPrefetchTier),
                    maxTile: TILE_MAX,
                    tier: panPrefetchTier,
                })
                    .map(toBufferedSpec)
                : [];
            const currentGridKeys = new Set(nextPanGrid.map(spec => spec.key));
            for (const readyKey of readyPanGridKeysRef.current) {
                if (!currentGridKeys.has(readyKey)) readyPanGridKeysRef.current.delete(readyKey);
            }
            const phases = splitViewportTilePanGridPhases(nextPanGrid, requiredViewport);
            const phaseKey = viewportTilePanPhaseKey(
                bufferGroup,
                baseSpec?.key ?? 'none',
                phases.near,
            );
            const atlasCoversViewport = phaseKey.length > 0
                && viewportTileGridCoversViewport(
                    nextPanGrid,
                    readyPanGridKeysRef.current,
                    requiredViewport,
                );
            const nextPanGridPlan = phaseKey.length > 0
                ? { phaseKey, all: nextPanGrid, near: phases.near, outer: phases.outer }
                : null;
            const tracePlanKey = [
                bufferGroup,
                baseSpec?.key || 'none',
                `${rotatedViewport.left},${rotatedViewport.top},${rotatedViewport.right},${rotatedViewport.bottom}`,
                nextPanGrid.length,
                phases.near.length,
                phases.outer.length,
                atlasCoversViewport,
            ].join('|');
            if (traceLayerLastPlanRef.current !== tracePlanKey) {
                traceLayerLastPlanRef.current = tracePlanKey;
                traceLayerEvent('viewport-plan', {
                    render_enabled: renderEnabled,
                    zoom: sZoom,
                    render_scale: renderScale,
                    raster_dpr: rasterDpr,
                    page_w: sDisplayW,
                    page_h: sDisplayH,
                    page_left: pageRect.left,
                    page_top: pageRect.top,
                    page_rect_w: pageRect.width,
                    page_rect_h: pageRect.height,
                    viewport_left: vp?.left ?? null,
                    viewport_top: vp?.top ?? null,
                    viewport_w: vp?.width ?? null,
                    viewport_h: vp?.height ?? null,
                    rotated_left: rotatedViewport.left,
                    rotated_top: rotatedViewport.top,
                    rotated_right: rotatedViewport.right,
                    rotated_bottom: rotatedViewport.bottom,
                    base_clip_x: baseSpec?.clipX ?? null,
                    base_clip_y: baseSpec?.clipY ?? null,
                    base_clip_w: baseSpec?.clipW ?? null,
                    base_clip_h: baseSpec?.clipH ?? null,
                    base_css_left: baseSpec?.cssLeft ?? null,
                    base_css_top: baseSpec?.cssTop ?? null,
                    base_css_w: baseSpec?.cssW ?? null,
                    base_css_h: baseSpec?.cssH ?? null,
                    pan_grid: nextPanGrid.length,
                    pan_near: phases.near.length,
                    pan_outer: phases.outer.length,
                    atlas_covers_viewport: atlasCoversViewport,
                    required_left: requiredViewport.left,
                    required_top: requiredViewport.top,
                    required_right: requiredViewport.right,
                    required_bottom: requiredViewport.bottom,
                });
            }
            setPanGridPlan(previous => (
                previous?.phaseKey === nextPanGridPlan?.phaseKey
                && previous?.all.length === nextPanGridPlan?.all.length
                && previous?.all.every((spec, index) => spec.key === nextPanGridPlan?.all[index]?.key)
                    ? previous
                    : nextPanGridPlan
            ));
            setOuterEnabledPhaseKey(previous => {
                if (atlasCoversViewport) return phaseKey;
                return previous === phaseKey ? previous : null;
            });
            setPresentedPanGridPhaseKey(previous => {
                if (atlasCoversViewport) return phaseKey;
                return previous === phaseKey ? previous : null;
            });

            const next = baseSpec ? toBufferedSpec(baseSpec) : null;
            // PERF (audit 2026-08-11 §PAN.TURBO-A): atlas đã decode và phủ kín
            // viewport thì không raster lại một bitmap nguyên khung trùng pixel.
            dispatchTileBuffer({
                type: 'target',
                item: atlasCoversViewport ? null : next,
            });
        };
        // PERF (audit 2026-08-08 §RENDER.7): scroll/resize chỉ đo layout tối đa một lần
        // mỗi frame; pan trong cùng ô snap giữ nguyên object state nên không rerender tile.
        const coalescer = createRafCoalescer(
            callback => window.requestAnimationFrame(callback),
            handle => window.cancelAnimationFrame(handle),
            compute,
        );
        // PERF (feedback 2026-08-09 §ZOOM.F2): lần đầu phải đo đồng bộ; WebView2
        // occluded có thể hoãn rAF và accurate active không còn full-page dự phòng.
        compute();
        const target: Window | HTMLElement = scrollEl || window;
        target.addEventListener('scroll', coalescer.schedule, { passive: true });
        window.addEventListener('resize', coalescer.schedule);
        return () => {
            target.removeEventListener('scroll', coalescer.schedule);
            window.removeEventListener('resize', coalescer.schedule);
            coalescer.cancel();
        };
    }, [accurateColor, bufferGroup, containerRef, rasterDpr, renderEnabled, rotation, sDisplayW, sDisplayH, sZoom, reuseGroup, renderScale, traceLayerEvent]);

    useEffect(() => {
        traceLayerEvent('viewport-layer-mount', {
            render_enabled: renderEnabled,
            zoom,
            dpr,
            display_w: displayWidth,
            display_h: displayHeight,
            rotation: rotation || 0,
        });
        return () => traceLayerEvent('viewport-layer-unmount', {
            visible_tiles: tileBuffer.visible ? 1 : 0,
            target_tiles: tileBuffer.target ? 1 : 0,
            pan_grid_tiles: panGridPlan?.all.length ?? 0,
        });
        // Lifecycle trace intentionally belongs to the layer instance.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const zoomSettling = zoom !== sZoom || displayWidth !== sDisplayW || displayHeight !== sDisplayH;
    const panGridPlanIsCurrent = Boolean(
        panGridPlan?.phaseKey.startsWith(`${bufferGroup}:target:`),
    );
    const panGridPhaseReady = Boolean(
        panGridPlan && outerEnabledPhaseKey === panGridPlan.phaseKey,
    );
    const panGridViewportCovered = Boolean(
        panGridPlan && presentedPanGridPhaseKey === panGridPlan.phaseKey,
    );
    const panGridPolicy = viewerPanGridRenderPolicy(
        accurateCommitted,
        Boolean(tileBuffer.visible),
        panGridPhaseReady,
    );
    const activePanGridTiles = panGridPlan && panGridPolicy.near
        ? [
            ...panGridPlan.near,
            ...(panGridPolicy.outer ? panGridPlan.outer : []),
        ]
        : [];
    const presentPanGrid = shouldPresentViewerPanGrid(
        panGridPlanIsCurrent,
        panGridViewportCovered,
        zoomSettling,
        Boolean(stableUnderlayReady),
    );

    useEffect(() => {
        traceLayerEvent('viewport-layer-state', {
            visible_key: tileBuffer.visible?.key ? viewerTraceHash(tileBuffer.visible.key) : null,
            target_key: tileBuffer.target?.key ? viewerTraceHash(tileBuffer.target.key) : null,
            buffered_tiles: tileBuffer.visible || tileBuffer.target ? 1 : 0,
            pan_grid_tiles: panGridPlan?.all.length ?? 0,
            active_pan_grid_tiles: activePanGridTiles.length,
            cold_open_grid_blocked: Boolean(panGridPlan) && !panGridPolicy.near,
            near_tiles: panGridPlan?.near.length ?? 0,
            outer_tiles: panGridPlan?.outer.length ?? 0,
            outer_enabled: panGridPolicy.outer,
            viewport_covered: panGridViewportCovered,
            presented: presentPanGrid,
            stable_underlay: Boolean(stableUnderlayReady),
        });
    }, [activePanGridTiles.length, panGridPlan, panGridPolicy.near, panGridPolicy.outer, panGridViewportCovered, presentPanGrid, stableUnderlayReady, tileBuffer.target, tileBuffer.visible, traceLayerEvent]);

    // Trong lúc zoom chuyển, tile giữ clip/render scale cũ nhưng rect được scale theo
    // khổ trang sống. Nhờ đó không có generation mới theo từng wheel/rAF và zoom-out
    // tiếp tục dùng bitmap mật độ cao đã decode thay vì rơi về nền mờ.
    const visibleCoversCurrentViewport = !tileBuffer.visible
        || !tileBuffer.target
        || tileBuffer.visible.key === tileBuffer.target.key
        || viewportTileCoversViewport(
            tileBuffer.visible,
            tileBuffer.target.requiredViewport,
            tileBuffer.target.sourceDisplayWidth,
            tileBuffer.target.sourceDisplayHeight,
            displayWidth,
            displayHeight,
        );
    const bufferedTiles = viewportTilePresentationItems(
        tileBuffer,
        bufferGroup,
        reuseGroup,
        zoomSettling || !renderEnabled,
        visibleCoversCurrentViewport,
        Boolean(stableUnderlayReady),
    );
    useEffect(() => {
        if (bufferedTiles.length === 0 && activePanGridTiles.length === 0) {
            traceLayerEvent('viewport-layer-empty', { render_enabled: renderEnabled });
        }
    }, [activePanGridTiles.length, bufferedTiles.length, renderEnabled, traceLayerEvent]);
    if (bufferedTiles.length === 0 && activePanGridTiles.length === 0) return null;
    const useDisplayLayer = shouldUseViewerDisplayLayer(
        accurateColor,
        accurateCommitted,
        keepDisplayUntilAccurate,
    );
    const accurateViewportCanStart = shouldEnableViewerViewportAccurateTile(
        accurateCommitted,
        waitForAccurateBase,
        false,
    );

    return (
        <>
            {bufferedTiles.map(tileSpec => {
                const scaleX = displayWidth / tileSpec.sourceDisplayWidth;
                const scaleY = displayHeight / tileSpec.sourceDisplayHeight;
                const isIncomingTarget = tileBuffer.target?.key === tileSpec.key
                    && tileBuffer.visible?.key !== tileSpec.key;
                const requestedCrossfadeMs = isIncomingTarget
                    ? computeViewportTileCrossfadeMs(
                        tileBuffer.visible?.renderScale,
                        tileSpec.renderScale,
                        prefersReducedMotion,
                    )
                    : 0;
                const crossfadeMs = viewerSurfaceSwapMs(
                    accurateColor,
                    requestedCrossfadeMs,
                );
                const hasPreviousTile = Boolean(
                    tileBuffer.visible && tileBuffer.visible.key !== tileSpec.key,
                );
                const retirePreviousTile = isIncomingTarget ? (fadeMs = crossfadeMs) => {
                    // UIUX (audit 2026-08-09 §ZOOM.8): target đã hiện nhưng tile cũ vẫn
                    // nằm dưới tới hết fade; callback DOM lặp chỉ tạo một timer.
                    retirementScheduler.schedule(
                        tileSpec.key,
                        hasPreviousTile ? fadeMs : 0,
                        key => dispatchTileBuffer({ type: 'ready', key }),
                    );
                } : undefined;
                const handleAccurateTileReady = () => {
                    onAccurateCommitted?.();
                    if (tileBuffer.target?.key === tileSpec.key && panGridPlan?.phaseKey) {
                        // PERF (audit 2026-08-11 §PAN.TURBO-A): chỉ khi frame
                        // viewport đã decode mới mở runway atlas của đúng pha hiện tại.
                        setOuterEnabledPhaseKey(panGridPlan.phaseKey);
                    }
                    // Frame PPE đầu tiên không có lớp display thay nó chốt target; các
                    // generation PPE sau mới fade trên bitmap PPE cũ.
                    retirePreviousTile?.(crossfadeMs);
                };
                const instanceKey = pageInstanceId || `page-${pageNum}`;
                const matchingFirstFrame = viewerFirstFrameMatchesTile(
                    initialPpeFrame as ViewerFirstFrame | null | undefined,
                    pageNum,
                    tileSpec.renderScale,
                    rotation || 0,
                    tileSpec.clipX,
                    tileSpec.clipY,
                    tileSpec.clipW,
                    tileSpec.clipH,
                ) ? initialPpeFrame : undefined;
                return (
                    <React.Fragment key={`vp_${tileSpec.key}`}>
                        {useDisplayLayer && (
                            <LiveTile
                                key="display"
                                fileKey={displayFileKey || fileKey}
                                pageNum={pageNum}
                                pageInstanceId={`${instanceKey}:viewport-display`}
                                zoom={tileSpec.renderScale}
                                rot={0}
                                clipX={tileSpec.clipX} clipY={tileSpec.clipY} clipW={tileSpec.clipW} clipH={tileSpec.clipH}
                                cssLeft={tileSpec.cssLeft * scaleX}
                                cssTop={tileSpec.cssTop * scaleY}
                                cssW={tileSpec.cssW * scaleX}
                                cssH={tileSpec.cssH * scaleY}
                                getTileUrl={getTileUrl}
                                onVisible={onVisible}
                                onRenderReady={accurateColor ? undefined : onRenderReady}
                                onTileReady={retirePreviousTile
                                    ? () => retirePreviousTile()
                                    : undefined}
                                presentationFadeMs={crossfadeMs}
                                renderOwnerId={renderOwnerId}
                                renderPriority={0}
                            />
                        )}
                        {accurateColor && (
                            <LiveTile
                                key="accurate"
                                fileKey={fileKey}
                                pageNum={pageNum}
                                pageInstanceId={`${instanceKey}:viewport-accurate`}
                                zoom={tileSpec.renderScale}
                                rot={0}
                                clipX={tileSpec.clipX} clipY={tileSpec.clipY} clipW={tileSpec.clipW} clipH={tileSpec.clipH}
                                cssLeft={tileSpec.cssLeft * scaleX}
                                cssTop={tileSpec.cssTop * scaleY}
                                cssW={tileSpec.cssW * scaleX}
                                cssH={tileSpec.cssH * scaleY}
                                getTileUrl={getTileUrl}
                                onVisible={onVisible}
                                onRenderReady={onRenderReady}
                                onTileReady={handleAccurateTileReady}
                                presentationFadeMs={crossfadeMs}
                                renderOwnerId={renderOwnerId}
                                renderPriority={0}
                                renderEnabled={shouldEnableViewerViewportAccurateTile(
                                    accurateCommitted,
                                    waitForAccurateBase,
                                    tileBuffer.visible?.key === tileSpec.key,
                                )}
                                initialSource={matchingFirstFrame}
                                preserveUnderlay={Boolean(initialPpeFrame)}
                                accurateOnly
                                cancelAccurateGroup={cancelAccurateGroup}
                            />
                        )}
                    </React.Fragment>
                );
            })}
            {activePanGridTiles.length > 0 && (
            <div
                data-prynx-viewport-atlas="true"
                data-prynx-viewport-atlas-ready={presentPanGrid ? 'true' : 'false'}
                style={{
                    position: 'absolute',
                    inset: 0,
                    opacity: presentPanGrid ? 1 : 0,
                    pointerEvents: 'none',
                }}
            >
            {activePanGridTiles.map((tileSpec, index) => {
                const scaleX = displayWidth / tileSpec.sourceDisplayWidth;
                const scaleY = displayHeight / tileSpec.sourceDisplayHeight;
                const presentationRect = computeViewportTileSeamSafePresentationRect(
                    tileSpec,
                    scaleX,
                    scaleY,
                    displayWidth,
                    displayHeight,
                    typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1),
                );
                const instanceKey = pageInstanceId || `page-${pageNum}`;
                const phase = index < (panGridPlan?.near.length ?? 0) ? 'near' : 'outer';
                return (
                    <LiveTile
                        key={`vp_pan_grid_${tileSpec.key}`}
                        fileKey={fileKey}
                        pageNum={pageNum}
                        pageInstanceId={`${instanceKey}:viewport-pan-grid:${tileSpec.clipX}:${tileSpec.clipY}`}
                        zoom={tileSpec.renderScale}
                        rot={0}
                        clipX={tileSpec.clipX}
                        clipY={tileSpec.clipY}
                        clipW={tileSpec.clipW}
                        clipH={tileSpec.clipH}
                        cssLeft={presentationRect.left}
                        cssTop={presentationRect.top}
                        cssW={presentationRect.width}
                        cssH={presentationRect.height}
                        getTileUrl={getTileUrl}
                        onVisible={onVisible}
                        onTileReady={() => {
                            readyPanGridKeysRef.current.add(tileSpec.key);
                            const activePlan = panGridPlan;
                            if (
                                activePlan
                                && activePlan.all.some(spec => spec.key === tileSpec.key)
                                && viewportTileGridCoversViewport(
                                    activePlan.all,
                                    readyPanGridKeysRef.current,
                                    tileSpec.requiredViewport,
                                )
                            ) {
                                // Tất cả cell vẫn decode độc lập, nhưng chỉ một lần cập nhật state
                                // này mới đưa nguyên atlas đã phủ kín vào compositor.
                                setPresentedPanGridPhaseKey(activePlan.phaseKey);
                            }
                            void previewPerfLog('viewport-pan-grid-ready', {
                                page: pageNum,
                                phase,
                                clipX: tileSpec.clipX,
                                clipY: tileSpec.clipY,
                                clipW: tileSpec.clipW,
                                clipH: tileSpec.clipH,
                            });
                        }}
                        onTileUnmount={() => readyPanGridKeysRef.current.delete(tileSpec.key)}
                        presentationFadeMs={0}
                        seamlessGridPresentation
                        renderOwnerId={renderOwnerId}
                        renderPriority={PAN_PREFETCH_PRIORITY + index}
                        renderEnabled={accurateColor && renderEnabled && accurateViewportCanStart}
                        accurateOnly
                        cancelAccurateGroup={cancelAccurateGroup}
                    />
                );
            })}
            </div>
            )}
        </>
    );
});

// ═══ VDP text preview với AUTO-FIT ═══
// Bóp cỡ chữ (xuống tối thiểu) để text vừa CHIỀU CAO khung, khớp với engine backend
// (ReportLab cũng bóp theo chiều cao). Khi autoFit === false thì giữ nguyên cỡ chữ.
interface VdpPreviewField extends VdpToolField {
    autoFit?: boolean;
}

const VdpAutoFitText = ({ field, scale, text }: { field: VdpPreviewField; scale: number; text: string }) => {
    const ref = useRef<HTMLSpanElement>(null);
    // Backend render fontSize ở pt THẬT, nhưng khung dùng đơn vị CSS (×96/72). Để preview
    // khớp output, cỡ chữ trên màn = fontSize(pt) × scale × (96/72). scale = displayWidth/pageDim.w.
    const fontPx = (field.fontSize || 10) * scale * (96 / 72);
    const [scaleX, setScaleX] = useState<number>(1);
    const align = (field.alignment || 'left') as 'left' | 'center' | 'right';

    useLayoutEffect(() => {
        // Cần đồng bộ ngay sau layout để preview chữ không lóe sai tỷ lệ.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (field.autoFit === false) { setScaleX(1); return; }
        const el = ref.current;
        if (!el) return;
        // "Tự bóp chữ vừa khung" = NÉN BỀ RỘNG (scaleX), GIỮ NGUYÊN cỡ chữ/chiều cao.
        // Đo bề rộng tự nhiên (scrollWidth khi whitespace:pre — không xuống dòng) so với
        // bề rộng khung (clientWidth). Nếu tràn ngang → nén ngang cho vừa. Chỉ ngắt dòng
        // ở '\n' người dùng gõ. Parity với backend (canvas scale(sx,1)).
        const natural = el.scrollWidth;
        const avail = el.clientWidth;
        const sx = natural > avail && natural > 0 ? Math.max(0.05, avail / natural) : 1;
        setScaleX(sx);
    }, [text, fontPx, field.width, field.height, field.autoFit, field.fontName, field.fontStyle, field.lineHeight, align]);

    // Nén từ mép TRÁI để khớp backend (canvas scale(sx,1) sau translate về mép trái
    // khung, map [0, bề_rộng_tự_nhiên] → [0, bề_ngang_khung]). Text-align vẫn xử lý
    // vị trí chữ trong khung khi KHÔNG nén (sx=1).
    return (
        <span
            className="overflow-hidden w-full h-full"
            style={{ display: 'flex', alignItems: 'center' }}
        >
            <span
                ref={ref}
                className="whitespace-pre"
                style={{
                    display: 'block',
                    width: '100%',
                    color: field.fontColor || '#1e293b',
                    fontSize: `${fontPx}px`,
                    fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit'),
                    fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                    fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                    lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                    // Backend (ReportLab Paragraph) chưa hỗ trợ tracking → preview cũng bỏ qua để khớp output.
                    letterSpacing: 0,
                    textAlign: align,
                    // NÉN NGANG khi chữ tràn; neo theo hướng căn lề để chữ không trôi khỏi khung.
                    transform: field.autoFit === false ? 'none' : `scaleX(${scaleX})`,
                    transformOrigin: 'left center',
                }}
            >
                {text}
            </span>
        </span>
    );
};

const VdpCurvedText = ({ field, scale, text }: { field: VdpPreviewField; scale: number; text: string }) => {
    const fontPx = (field.fontSize || 10) * scale * (96 / 72);
    const boxW = Math.max(1, ((field.width ?? 0) / 25.4 * 72) * scale);
    const boxH = Math.max(1, ((field.height ?? 0) / 25.4 * 72) * scale);
    const pathId = `curved-path-${field.id}`;

    // curveRadius in mm -> convert to display px
    const rawR = typeof field.curveRadius === 'number' && field.curveRadius > 0
        ? field.curveRadius
        : ((field.width || 50) * 0.75);
    const radiusPx = Math.max(10, (rawR / 25.4 * 72) * scale);
    const mode = field.curveMode || 'arc_bottom';
    const isTop = mode === 'arc_top';
    const orientation = field.curveOrientation || 'outward';

    const cx = boxW / 2;
    const halfChord = Math.min(boxW / 2 - 2, radiusPx * 0.98);
    const halfAngle = Math.asin(Math.max(0, Math.min(1, halfChord / Math.max(radiusPx, 1))));
    const sagittaChord = radiusPx * (1 - Math.cos(halfAngle));

    // Tính độ võng thực tế của chuỗi ký tự (thay vì toàn bộ dây cung khung)
    const trackingPx = field.curveTracking ? field.curveTracking * scale * (96 / 72) : 0;
    const approxCharWidth = fontPx * 0.55 + trackingPx;
    const textLen = Math.max(1, (text?.length || 1)) * approxCharWidth;
    const textAngle = textLen / Math.max(radiusPx, 1);
    const halfTextAngle = Math.min(Math.PI / 2, textAngle / 2);
    const textSagitta = radiusPx * (1 - Math.cos(halfTextAngle));

    let pathD = '';
    if (isTop) {
        // Căn giữa chính xác phong bì văn bản vào giữa khung boxH
        const baseY = orientation === 'inward'
            ? boxH / 2 - (textSagitta + fontPx) / 2 + sagittaChord
            : boxH / 2 - (textSagitta - fontPx) / 2 + sagittaChord;
        const x0 = cx - halfChord;
        const x1 = cx + halfChord;
        if (orientation === 'inward') {
            pathD = `M ${x1} ${baseY} A ${radiusPx} ${radiusPx} 0 0 0 ${x0} ${baseY}`;
        } else {
            pathD = `M ${x0} ${baseY} A ${radiusPx} ${radiusPx} 0 0 1 ${x1} ${baseY}`;
        }
    } else {
        // Căn giữa chính xác phong bì văn bản vào giữa khung boxH
        const baseY = orientation === 'inward'
            ? boxH / 2 + (textSagitta - fontPx) / 2 - sagittaChord
            : boxH / 2 + (textSagitta + fontPx) / 2 - sagittaChord;
        const x0 = cx - halfChord;
        const x1 = cx + halfChord;
        if (orientation === 'inward') {
            pathD = `M ${x1} ${baseY} A ${radiusPx} ${radiusPx} 0 0 1 ${x0} ${baseY}`;
        } else {
            pathD = `M ${x0} ${baseY} A ${radiusPx} ${radiusPx} 0 0 0 ${x1} ${baseY}`;
        }
    }

    const tracking = field.curveTracking ? `${field.curveTracking * scale * (96 / 72)}px` : 'normal';
    const fontFamily = field.fontName === 'Helvetica'
        ? 'Arial, sans-serif'
        : field.fontName === 'Times-Roman'
        ? '"Times New Roman", serif'
        : field.fontName === 'Courier'
        ? 'Courier, monospace'
        : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit');
    const fontWeight = field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal';
    const fontStyle = field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal';

    return (
        <svg
            className="w-full h-full overflow-visible pointer-events-none select-none"
            viewBox={`0 0 ${boxW} ${boxH}`}
        >
            <defs>
                <path id={pathId} d={pathD} fill="none" />
            </defs>
            <path
                d={pathD}
                fill="none"
                stroke="rgba(59, 130, 246, 0.35)"
                strokeDasharray="3 3"
                strokeWidth={1}
            />
            <text
                fill={field.fontColor || '#1e293b'}
                fontSize={`${fontPx}px`}
                fontFamily={fontFamily}
                fontWeight={fontWeight}
                fontStyle={fontStyle}
                letterSpacing={tracking}
            >
                <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                    {text}
                </textPath>
            </text>
        </svg>
    );
};

// Một DÒNG text vô hình để QUÉT + COPY (như Acrobat). Đặt span đúng vị trí bbox
// (point → px qua scale), fontSize theo CHIỀU CAO dòng, rồi NÉN NGANG (scaleX) cho
// bề rộng render KHỚP bề rộng thật của dòng trên trang. KHÔNG overflow:hidden/width
// cứng (bản cũ cắt mất chữ tràn + lệch). scaleX đo 1 lần qua offsetWidth (bỏ qua
// transform nên không lặp vô hạn). transformOrigin top-left để neo đúng mép trái-trên.
const SelectableTextLine = React.memo(function SelectableTextLine({ line, scale, gapPt }: { line: TextLine; scale: number; gapPt: number }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [scaleX, setScaleX] = useState(1);
    const text = line.chars?.map((c: TextChar) => c.c).join('') || '';
    const targetW = (line.bbox.w || 0) * scale;
    const h = (line.bbox.h || 0) * scale;
    // KẸP chiều cao khung click ≤ khe tới dòng kế → span KHÔNG chồng mép Y với dòng
    // dưới → kéo 1 dòng không chạm span dòng kề → hết nhảy selection. fontSize vẫn
    // theo h (glyph khớp cỡ chữ gốc); chỉ khung click (height) bị kẹp + overflow ẩn.
    const capH = Math.min(h, gapPt * scale);

    useLayoutEffect(() => {
        const el = ref.current;
        // Giá trị phụ thuộc phép đo DOM nên phải cập nhật trong layout effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!el || targetW <= 0) { setScaleX(1); return; }
        const natural = el.offsetWidth; // bề rộng tự nhiên (chưa tính transform)
        setScaleX(natural > 0 ? targetW / natural : 1);
    }, [text, h, targetW]);

    return (
        <span
            ref={ref}
            style={{
                position: 'absolute',
                left: line.bbox.x * scale,
                top: line.bbox.y * scale,
                // fontSize = CHIỀU CAO dòng, lineHeight = 1 (KHÔNG px riêng): line-box
                // đúng bằng fontSize nên KHÔNG có "half-leading" đẩy chữ xuống ~9% như
                // bản cũ (fontSize 0.82h < lineHeight h). Đây là cách pdf.js đặt glyph.
                fontSize: `${h}px`,
                lineHeight: 1,
                // Khung click kẹp ≤ khe dòng kế (capH), overflow ẩn phần thừa → span
                // không lấn dòng dưới (fix nhảy dòng 2026-07-07). block để height ăn.
                display: 'block',
                height: capH,
                overflow: 'hidden',
                color: 'transparent',
                whiteSpace: 'pre',
                transform: `scaleX(${scaleX})`,
                transformOrigin: 'left top',
            }}
        >
            {text}
        </span>
    );
});

const SelectableTextLayer = React.memo(function SelectableTextLayer({
    textBlocks,
    pageWidthPx,
    displayWidth,
}: {
    textBlocks: TextBlocksInput;
    pageWidthPx?: number;
    displayWidth: number;
}) {
    const allLines = React.useMemo(
        () => (Array.isArray(textBlocks) ? textBlocks : (textBlocks?.blocks || []))
            .flatMap((block: TextBlock) => block.lines || [])
            .filter((line: TextLine) => line?.bbox)
            .sort((a: TextLine, b: TextLine) => a.bbox.y - b.bbox.y),
        [textBlocks],
    );
    const pageWidthPt = pageWidthPx ? pageWidthPx * 72 / 96 : 595;
    const scale = displayWidth / pageWidthPt;

    return (
        <div className="absolute inset-0 z-[12] select-text cursor-text" style={{ pointerEvents: 'auto' }}>
            {allLines.map((line: TextLine, index: number) => {
                const next = allLines[index + 1];
                const gap = next ? (next.bbox.y - line.bbox.y) : Infinity;
                return <SelectableTextLine key={index} line={line} scale={scale} gapPt={gap} />;
            })}
        </div>
    );
});

// Props contract is supplied by AcrobatViewer; keep the broad bridge while the shared viewer contract is migrated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LivePageFrame = (props: any) => {
  const { t } = useTranslation();
    const tileLoadLabels = useMemo<TileLoadLabels>(() => ({
        loading: t('misc.livePageFrame:dang_dung_hinh', 'Đang dựng hình…'),
        slow: t('misc.livePageFrame:dung_hinh_cham', 'Đang dựng trang lâu hơn bình thường…'),
        error: t('misc.livePageFrame:khong_dung_duoc_trang', 'Không dựng được trang này.'),
        cancelled: t('misc.livePageFrame:da_huy_dung_hinh', 'Đã hủy dựng trang.'),
        retry: t('misc.livePageFrame:thu_lai', 'Thử lại'),
        cancel: t('misc.livePageFrame:huy', 'Hủy'),
    }), [t]);
    //#region Props & State
    const { originalPageNum, viewerPageNum, pageInstanceId, actualWidth100, zoom, physicalDisplayScale = 1, displayDevicePixelRatio = 1, accurateDpiAnchor = 96, rotation, bleedView, highlightBoxes, pageDim,
        getTileUrl, textBlocks, isVdpMode, onVdpBoxCreate, onVdpBoxSelect, onVdpFieldsChange,
        setHoveredPdfPosition, detectedDimension, isBlankDoc, onEditCommit, isActivePage,
        isImageFile: isImage, nativeFilePath, previewRevision,
        editSession, totalPages, tabId, isViewerActive, renderOwnerId, renderDocumentToken, prefetchPage,
        accurateColorPage: detectorRequiresAccurate,
        accurateColorProfileId,
        accurateColorIntent,
        accurateColorProofIdentity,
        cancelAccurateGroup,
        onFirstPageRenderReady,
    } = props;
    const [baseDisplayReadyKey, setBaseDisplayReadyKey] = useState<string | null>(null);
    const [accurateCommittedKey, setAccurateCommittedKey] = useState<string | null>(null);
    const [accurateBaseReadyKey, setAccurateBaseReadyKey] = useState<string | null>(null);
    const traceFrameIdRef = useRef(
        viewerTraceHash(`${tabId || 'tab'}:${pageInstanceId || 'page'}:${originalPageNum}`),
    );
    const traceFrameLastPolicyRef = useRef('');
    // Trang ĐANG xem (active) trong danh sách ảo (Virtuoso). Chỉ frame active mới
    // đẩy editObjects của mình lên store `currentEditObjects` → panel "Thành phần"
    // luôn khớp ĐÚNG trang người dùng đang chỉnh. Trước đây mọi frame đều ghi đè
    // currentEditObjects (frame chạy sau cùng thắng) nên panel có thể liệt kê object
    // của TRANG KHÁC → tắt mắt một thành phần lại nhắm id không có trên trang active
    // → /edit/preview-hide trả về trang nguyên vẹn → "không có gì thay đổi".
    // Chỉ giá trị true mới là active; undefined không được phép kích hoạt mọi frame ảo.
    const isActiveFrame = isActivePage === true;

    const {
        isObjectEditMode, setCurrentEditObjects, selectionFileId, hiddenObjectIds, setHiddenObjectIds, lockedObjectIds, hiddenOcgLayerIds, ocgVisibilityIntent,
        showOutputPreview,
        separationPlates, vdpFields, selectedVdpFieldIds,
        softProofImageUrl, gamutWarningUrl, tacHeatmapUrl, overprintPreviewUrl,
        outputPreviewWarningOpacity, outputPreviewOverprintDiagnosticActive,
        outputPreviewActiveViewerPage,
        outputPreviewPageBoxes, outputPreviewShowPageBoxes,
        pdfUrl, setSelectedVdpFieldIds, selectedObjectIds, setSelectedObjectIds,
        setObjectSelectionContext,
        isCropMode, cropSelection, setCropSelection, commitCropSelection,
        recordCropSelectionSnapshot, viewerToolMode, editAddMode, setEditAddMode,
        editClipboard, setEditClipboard
    } = useWorkspaceStore(useShallow(state => ({
        isObjectEditMode: state.isObjectEditMode,
        editAddMode: state.editAddMode,
        setEditAddMode: state.setEditAddMode,
        setCurrentEditObjects: state.setCurrentEditObjects,
        selectionFileId: state.selectionFileId,
        selectedObjectIds: state.selectedObjectIds,
        setSelectedObjectIds: state.setSelectedObjectIds,
        editClipboard: state.editClipboard,
        setEditClipboard: state.setEditClipboard,
        setObjectSelectionContext: state.setObjectSelectionContext,
        hiddenObjectIds: state.hiddenObjectIds,
        setHiddenObjectIds: state.setHiddenObjectIds,
        lockedObjectIds: state.lockedObjectIds,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        ocgVisibilityIntent: state.ocgVisibilityProvenance.intent,
        showOutputPreview: state.showOutputPreview,
        separationPlates: state.separationPlates,
        vdpFields: state.vdpFields,
        selectedVdpFieldIds: state.selectedVdpFieldIds,
        softProofImageUrl: state.softProofImageUrl,
        gamutWarningUrl: state.gamutWarningUrl,
        tacHeatmapUrl: state.tacHeatmapUrl,
        overprintPreviewUrl: state.overprintPreviewUrl,
        outputPreviewWarningOpacity: state.outputPreviewWarningOpacity,
        outputPreviewOverprintDiagnosticActive: state.outputPreviewOverprintDiagnosticActive,
        outputPreviewActiveViewerPage: state.outputPreviewActiveViewerPage,
        outputPreviewPageBoxes: state.outputPreviewPageBoxes,
        outputPreviewShowPageBoxes: state.outputPreviewShowPageBoxes,
        pdfUrl: state.pdfUrl,
        setSelectedVdpFieldIds: state.setSelectedVdpFieldIds,
        isCropMode: state.isCropMode,
        cropSelection: state.cropSelection,
        setCropSelection: state.setCropSelection,
        commitCropSelection: state.commitCropSelection,
        recordCropSelectionSnapshot: state.recordCropSelectionSnapshot,
        viewerToolMode: state.viewerToolMode,
    })));
    const accurateColorPage = shouldUseViewerAccurateSimulation(
        detectorRequiresAccurate === true,
        showOutputPreview === true,
    );
    const keepDisplayUntilAccurate = showOutputPreview === true
        && detectorRequiresAccurate !== true;
    const primedFirstFrame = peekViewerFirstFrame(nativeFilePath, renderDocumentToken);
    const initialPpeFrame = accurateColorPage
        && originalPageNum === 1
        && (rotation || 0) % 360 === 0
        && (accurateColorProfileId || 'fogra39').trim().toLocaleLowerCase() === 'fogra39'
        && (accurateColorIntent || 'relative').trim().toLocaleLowerCase() === 'relative'
        && accurateColorProofIdentity === primedFirstFrame?.proofIdentity
        ? primedFirstFrame
        : null;

    const previewFramePage = typeof viewerPageNum === 'number' ? viewerPageNum : originalPageNum;
    const viewerIsActive = isViewerActive !== false;
    const effectiveRenderOwnerId = renderOwnerId || `${tabId || 'viewer'}:${pdfUrl || nativeFilePath || 'memory'}`;
    const pageRenderPriority = viewerPageRenderPriority(
        viewerIsActive,
        isActiveFrame,
        prefetchPage === true,
    );
    // PERF (audit 2026-09-11 §PPEBX.C): active mức 10 dùng lane tương tác;
    // trang kế bên mức 100 dùng lane nền cùng atlas, không giữ mutex của active.
    const shouldRenderBasePage = shouldRenderViewerBasePage(
        viewerIsActive,
        isActiveFrame,
        prefetchPage === true,
    );

    const separationPreviewBelongsToFrame = separationPlates.some(
        plate => plate.pageNum === previewFramePage,
    );
    const visibleSeparationPlates = getVisiblePlateOverlaysForPage(
        separationPlates,
        previewFramePage,
    );
    const outputPreviewBitmapBelongsToFrame = shouldShowOutputPreviewBitmap(
        showOutputPreview,
        outputPreviewActiveViewerPage,
        previewFramePage,
    );

    const isCropPanMode = isCropMode && viewerToolMode === 'hand';
    const isCropInteractionEnabled = isCropMode && !isCropPanMode;
    
    const watermarkPreview = useWorkspaceStore(s => s.watermarkPreview);
        // Layer "xem trước nhanh" Python cũ ĐÃ BỎ (đo thật 2026-07-22: xếp hàng
        // nghẽn ~10s khi nhiều trang do parse lại cả file — CHẬM HƠN cả PDFium ~1s mà nó
        // định che chỗ trống cho). pdfium + prefetch trang lân cận + page LRU đã đủ nhanh.
    // Migrated to imposer store per P1-T03
    const activeDashboardTool = useImposerSettingsStore(s => s.activeDashboardTool);
    // PERF (audit độ nét 2026-07-28 §R.9): selector riêng một trường — không subscribe cả store.
    const previewQuality = useAppSettingsStore(s => s.previewQuality);
    const containerRef = useRef<HTMLDivElement>(null);
    const pageContentRef = useRef<HTMLDivElement>(null);
    const [pagePixelSnap, setPagePixelSnap] = useState({ x: 0, y: 0 });
    const pagePixelSnapRef = useRef(pagePixelSnap);
    const marqueeRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; active: boolean; lastHoverTime?: number }>({ startX: 0, startY: 0, active: false });
    
    const stickPreviewParams = useWorkspaceStore(s => s.stickPreviewParams);
    const viewerNumPages = useWorkspaceStore(s => s.viewerNumPages);

    // VDP Drag/Resize interaction state
    const [vdpInteraction, setVdpInteraction] = useState<{ type: 'move'|'resize', handle?: 'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w', fieldIds: string[], startX: number, startY: number, startFields: Record<string, {x: number, y: number, w: number, h: number, fontSize?: number}> } | null>(null);

    // Menu chuột phải cho khung VDP: xoay nhanh 90° trực tiếp trên khung (song song
    // với dropdown "Xoay (độ)" ở panel). x/y là toạ độ màn hình (fixed), fieldId là
    // field được nhấp phải. Đóng khi click ra ngoài / Escape / chọn xong.
    const [vdpCtxMenu, setVdpCtxMenu] = useState<{ x: number; y: number; fieldId: string } | null>(null);

    // ─── VDP drag/resize: áp dụng theo THỜI GIAN THỰC qua listener WINDOW ───────
    // Bắt sự kiện ở window (không phải div trang) → con trỏ ra ngoài khung vẫn theo
    // dõi (không "dừng giữa chừng"), thả chuột luôn kết thúc (không "dính chuột").
    // Gộp cập nhật store theo requestAnimationFrame để giảm giật.
    // (Đặt ở vùng hooks đầu component để KHÔNG bị các early-return phía dưới làm
    //  lệch số lượng hook giữa các lần render.)
    const vdpRafRef = useRef<number | null>(null);
    const vdpPendingRef = useRef<{ curX: number; curY: number } | null>(null);
    const vdpInteractionRef = useRef(vdpInteraction);
    useEffect(() => { vdpInteractionRef.current = vdpInteraction; }, [vdpInteraction]);

    const applyVdpDrag = (curX: number, curY: number) => {
        const interaction = vdpInteractionRef.current;
        if (!interaction || !onVdpFieldsChange || !pageDim) return;
        const dx = curX - interaction.startX;
        const dy = curY - interaction.startY;
        const scale = (actualWidth100 * zoom) / pageDim.w; // = displayWidth / pageDim.w
        const dxMM = (dx / scale) / 72 * 25.4;
        const dyMM = (dy / scale) / 72 * 25.4;

        // Biên trang theo cùng đơn vị "CSS-mm" với field (pageDim ở px@96).
        const pageWmm = pageDim.w * 25.4 / 72;
        const pageHmm = pageDim.h * 25.4 / 72;
        const clampPos = (v: number, size: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max - size)));

        onVdpFieldsChange((prev: VdpToolField[]) => prev.map((f: VdpToolField) => {
            if (!interaction.fieldIds.includes(f.id)) return f;
            const startData = interaction.startFields[f.id];
            if (!startData) return f;

            if (interaction.type === 'move') {
                // Giữ khung nằm trong trang để nội dung không bị MediaBox cắt.
                const x = clampPos(startData.x + dxMM, startData.w, pageWmm);
                const y = clampPos(startData.y + dyMM, startData.h, pageHmm);
                return { ...f, x, y };
            } else if (interaction.type === 'resize') {
                const handle = interaction.handle || 'se';
                let newX = startData.x, newY = startData.y;
                let newW = startData.w, newH = startData.h;
                if (handle.includes('e')) newW = startData.w + dxMM;
                if (handle.includes('w')) newW = startData.w - dxMM;
                if (handle.includes('s')) newH = startData.h + dyMM;
                if (handle.includes('n')) newH = startData.h - dyMM;
                newW = Math.max(5, newW);
                newH = Math.max(5, newH);
                if (f.type === 'qrcode') {
                    const size = Math.max(newW, newH);
                    newW = size;
                    newH = size;
                }
                if (handle.includes('w')) newX = startData.x + (startData.w - newW);
                if (handle.includes('n')) newY = startData.y + (startData.h - newH);
                // Không cho khung vượt biên trang (tránh QR/nội dung tràn rồi bị cắt).
                newX = Math.max(0, newX);
                newY = Math.max(0, newY);
                newW = Math.min(newW, pageWmm - newX);
                newH = Math.min(newH, pageHmm - newY);
                if (f.type === 'qrcode') { const s = Math.max(5, Math.min(newW, newH)); newW = s; newH = s; }
                else { newW = Math.max(5, newW); newH = Math.max(5, newH); }
                // Text + handle GÓC (nw/ne/sw/se): scale cỡ chữ theo khung như Illustrator,
                // thay vì chỉ đổi khung rồi để auto-fit bóp lúc tràn (chữ "kẹt" không co
                // theo khung nữa). Handle CẠNH (n/s/e/w) giữ cỡ chữ — chỉ đổi vùng chảy
                // chữ (giống nới rộng text box). QR/barcode/image không dính.
                if (f.type === 'text' && handle.length === 2 && startData.fontSize) {
                    const ratio = Math.min(newW / startData.w, newH / startData.h);
                    const scaledFs = Math.max(1, Math.round(startData.fontSize * ratio * 10) / 10);
                    return { ...f, x: newX, y: newY, width: newW, height: newH, fontSize: scaledFs };
                }
                return { ...f, x: newX, y: newY, width: newW, height: newH };
            }
            return f;
        }));
    };

    // Xoay field VDP về mức 0/90/180/270 (backend chỉ render 4 mức này). Khi
    // chuyển giữa dọc↔ngang (90/270 vs 0/180) thì hoán width↔height để footprint
    // khung khớp hướng — CÙNG quy ước với updateSelectedField bên DataMergeTool.
    const rotateVdpField = (fieldId: string, newRot: number) => {
        if (!onVdpFieldsChange) return;
        const nr = ((newRot % 360) + 360) % 360;
        onVdpFieldsChange((prev: VdpToolField[]) => prev.map((f: VdpToolField) => {
            if (f.id !== fieldId) return f;
            const oldRot = ((Number(f.rotation) || 0) % 360 + 360) % 360;
            const oldVert = oldRot === 90 || oldRot === 270;
            const newVert = nr === 90 || nr === 270;
            if (oldVert !== newVert) {
                return { ...f, rotation: nr, width: f.height, height: f.width };
            }
            return { ...f, rotation: nr };
        }));
    };

    useEffect(() => {
        if (!vdpInteraction) return;
        const flush = () => {
            vdpRafRef.current = null;
            const p = vdpPendingRef.current;
            if (p) applyVdpDrag(p.curX, p.curY);
        };
        const onMove = (e: PointerEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
            vdpPendingRef.current = { curX: coords.x, curY: coords.y };
            if (vdpRafRef.current == null) vdpRafRef.current = requestAnimationFrame(flush);
        };
        const onUp = () => {
            if (vdpRafRef.current != null) { cancelAnimationFrame(vdpRafRef.current); vdpRafRef.current = null; }
            const p = vdpPendingRef.current;
            if (p) applyVdpDrag(p.curX, p.curY);
            vdpPendingRef.current = null;
            setVdpInteraction(null);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            if (vdpRafRef.current != null) { cancelAnimationFrame(vdpRafRef.current); vdpRafRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vdpInteraction]);

    // Đóng menu chuột phải VDP bằng Esc. Click ra ngoài đóng qua BACKDROP (xem
    // phần render) — KHÔNG dùng window 'pointerdown' vì cú chuột phải mở menu có
    // thể tự đóng ngay (race giữa pointerdown mở và listener đóng).
    useEffect(() => {
        if (!vdpCtxMenu || isViewerActive === false) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setVdpCtxMenu(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [vdpCtxMenu, isViewerActive]);

    const [editingTextId, setEditingTextId] = useState<string | null>(null);

    // Crop PDF: lưu theo phần trăm trang, không lưu pixel. Nhờ vậy vùng đã quét
    // không lệch khi đổi zoom/fit. ownerId tách cả các bản nhân đôi cùng source page.
    const cropOwnerId = String(pageInstanceId || `page-${originalPageNum}`);
    const cropSels = useMemo(() => cropSelection?.ownerId === cropOwnerId ? cropSelection.regions : [], [cropSelection, cropOwnerId]);
    const selectedCropIdx = cropSelection?.ownerId === cropOwnerId
        ? cropSelection.selectedIndex
        : -1;
    const cropSelsRef = useRef<CropRegionFrac[]>(cropSels);
    cropSelsRef.current = cropSels;
    const cropAdjustRef = useRef<{
        index: number;
        mode: CropAdjustMode;
        startX: number;
        startY: number;
        original: CropRegionFrac;
        latest: CropRegionFrac;
        historyRecorded: boolean;
        pointerId: number;
        captureTarget: HTMLElement;
    } | null>(null);
    const [editTextContent, setEditTextContent] = useState<string>('');
    // Font người dùng chọn khi sửa/thêm text (đường dẫn file .ttf/.otf trên máy);
    // rỗng = giữ font gốc nếu được, ngược lại fallback DejaVuSans (hành vi cũ).
    const [editFontPath, setEditFontPath] = useState<string | undefined>(undefined);
    const [editFontName, setEditFontName] = useState<string>('');
    // Danh sách font hệ thống (nạp 1 lần) để TỰ KHỚP font gốc khi mở editor sửa text.
    const systemFontsRef = useRef<{ name: string; path: string }[]>([]);
    // Props text lấy LAZY khi mở editor (tránh trích cho mọi object lúc liệt kê).
    const [editTextColor, setEditTextColor] = useState<number[] | null>(null);
    const [editOrigContent, setEditOrigContent] = useState<string>('');
    const [editOrigFontName, setEditOrigFontName] = useState<string>('');
    const editOpenTokenRef = useRef(0); // chống race khi mở nhanh object khác
    // Thông báo tạm (vd. cảnh báo không giữ được font gốc → dùng font dự phòng).
    const [editNotice, setEditNotice] = useState<string | null>(null);
    useEffect(() => {
        getSystemFonts().then(f => { systemFontsRef.current = Array.isArray(f) ? f : []; }).catch(() => {});
    }, []);
    // Khớp tên font gốc (vd. 'Montserrat-Bold') với một font hệ thống (chuẩn hóa tên).
    const pickFontForName = (name?: string): { name: string; path: string } | null =>
        pickFontForNameUtil(name, systemFontsRef.current);
    // Nội dung trích KHÔNG đáng tin: chứa U+FFFD hoặc ký tự dải mũi tên/kỹ thuật
    // (U+2190–U+23FF) — dấu hiệu glyph→unicode sai (vd. dấu cách → '↔'). Khi đó
    // KHÔNG prefill (tránh ghi lại chữ rác gây thiếu glyph khi đổi font).
    const looksUnreliableText = (s: string): boolean => {
        for (const ch of s) {
            const o = ch.codePointAt(0) ?? 0;
            if (o === 0xFFFD) return true;                 // replacement char
            if (o >= 0x2190 && o <= 0x2BFF) return true;   // arrows, math, technical, box, geometric, misc symbols
            if (o >= 0xE000 && o <= 0xF8FF) return true;   // Private Use Area (font subset remap glyph→PUA)
            if (o >= 0xFFF0 && o <= 0xFFFF) return true;   // specials
            if (o < 0x20 && o !== 0x09 && o !== 0x0A && o !== 0x0D) return true; // control chars
        }
        return false;
    };
    // Thay MỖI ký tự rác (arrow/symbol/PUA/control) bằng DẤU CÁCH — giữ nguyên chữ
    // đọc được. Đa số lỗi là dấu cách giữa từ bị map sai (vd. '↔'), nên thay bằng
    // space cho ra text gần đúng để người dùng sửa nhanh (thay vì để trống).
    const sanitizeText = (s: string): string =>
        Array.from(s).map(c => {
            const o = c.codePointAt(0) ?? 0;
            const bad = o === 0xFFFD
                || (o >= 0x2190 && o <= 0x2BFF)
                || (o >= 0xE000 && o <= 0xF8FF)
                || (o >= 0xFFF0 && o <= 0xFFFF)
                || (o < 0x20 && o !== 0x09 && o !== 0x0A && o !== 0x0D);
            return bad ? ' ' : c;
        }).join('');
    // Mở editor sửa text cho object: mở NGAY (trống) rồi LAZY fetch props
    // (content/màu/font gốc) cho đúng object → điền sẵn + tự khớp font hệ thống.
    const openTextEditor = (o: EditCanvasObj) => {
        const token = ++editOpenTokenRef.current;
        setEditingTextId(o.id);
        setEditTextContent('');
        setEditOrigContent('');
        setEditTextColor(null);
        setEditOrigFontName('');
        setEditFontName('');
        setEditFontPath(undefined);
        if (!selectionFileId) return;
        const page = originalPageNum - 1;
        void (async () => {
            try {
                const res = await authenticatedFetch(`${getApiUrl()}/edit/text-props/${selectionFileId}/${page}/${o.drawIndex}`);
                if (!res.ok) return;
                const p = await res.json();
                if (editOpenTokenRef.current !== token) return; // đã mở object khác → bỏ
                const raw = typeof p.content === 'string' ? p.content : '';
                // Text trích ra có thể chứa ký tự RÁC do font mã hoá riêng (vd. dấu
                // cách → '↔'). Nhưng chữ thường VẪN ĐÚNG → THAY ký tự rác bằng dấu
                // cách rồi PREFILL (giữ phần đọc được) để người dùng sửa nhanh.
                const dirty = raw !== '' && looksUnreliableText(raw);
                const content = dirty ? sanitizeText(raw) : raw;
                setEditTextContent(content);
                setEditOrigContent(content);
                setEditTextColor(Array.isArray(p.color) ? p.color : null);
                setEditOrigFontName(typeof p.fontName === 'string' ? p.fontName : '');
                const m = pickFontForName(p.fontName);
                if (m && m.path) { setEditFontName(m.name); setEditFontPath(m.path); }
                else { setEditFontName(p.fontName || ''); setEditFontPath(undefined); }
            } catch { /* giữ editor trống nếu lỗi */ }
        })();
    };
    
    // Preview image state (driven by hiddenObjectIds prop from parent)
    const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);

    // Overlay xem-trước lấy TỪ HOOK `editSession.previews` (hook SỞ HỮU — nguồn sự
    // thật để hotkey undo/redo ở AcrobatViewer và overlay ở đây cùng thấy). Mỗi lớp
    // giữ clipRect ở POINT (Page_Box-relative, gốc dưới-trái); LivePageFrame quy đổi
    // sang px THEO ZOOM HIỆN TẠI lúc render (nên zoom xong overlay vẫn đúng vị trí) +
    // LỌC theo trang. Xem block render bên dưới.
    // Tăng sau mỗi applyOp để ép effect nạp lại /edit/objects (session-aware → trả
    // trạng thái Live_Document sau op) mà KHÔNG cần đổi selectionFileId → khung chọn
    // bám vị trí MỚI + danh sách object cập nhật cho add/delete, không chờ commit.
    const [editObjectsVersion, setEditObjectsVersion] = useState(0);

    // apply/undo/redo sống ở hook cấp Viewer, nên frame cần một tín hiệu chung để
    // bỏ cache và nạp lại danh sách Thành phần từ đúng Live_Document hiện tại.
    useEffect(() => {
        const refreshObjects = (event: Event) => {
            const detail = (event as CustomEvent)?.detail || {};
            if (detail.tabId !== tabId) return;
            if (!isObjectEditMode || !isActiveFrame || !selectionFileId) return;
            // Cache dùng chung mọi frame: một op ở trang chưa mount vẫn phải làm
            // lần điều hướng sau miss cache. Một frame active dọn là đủ, không để
            // toàn bộ overscan cùng clear một Map.
            clearEditObjectsCache();
            const changedPage = Number(detail.page);
            if (changedPage !== originalPageNum - 1) return;
            const requestedIds = Array.isArray(detail.targetIds) ? detail.targetIds.map(String) : [];
            if (detail.kind !== 'delete') {
                pendingReselectIdsRef.current = requestedIds.length ? requestedIds : [...selectedObjectIds];
            }
            setEditObjectsVersion(version => version + 1);
        };
        window.addEventListener('edit-session-objects-changed', refreshObjects);
        return () => window.removeEventListener('edit-session-objects-changed', refreshObjects);
    }, [isObjectEditMode, isActiveFrame, selectionFileId, originalPageNum, selectedObjectIds, tabId]);

    // ─── Edit PDF Object — Hit-test + overlay (task 10.1) ────────────────────
    // Nguồn dữ liệu object lấy từ GET /edit/objects (Geometry_Reader, PDFium read-only).
    // Tách biệt khỏi globalPdfObjectCache (luồng /preflight) vì khác hệ tọa độ + khác
    // id-space → tránh phá vỡ delete/hide preflight hiện có.
    const [editObjects, setEditObjects] = useState<EditCanvasObj[]>([]);

    // ─── Edit PDF Object — move/resize/rotate + overlay real-time (task 10.2) ─
    // editInteraction: thao tác kéo đang diễn ra. Transform tạm (xem trước real-time)
    // được áp lên ghost qua DOM ref (editGhostRef/editLiveTransformRef bên dưới),
    // KHÔNG dùng state để không re-render mỗi frame (Yêu cầu 13.2).
    const [editInteraction, setEditInteraction] = useState<EditInteraction | null>(null);
    const [editBusy, setEditBusy] = useState(false);
    // Ghost transform REAL-TIME bằng DOM ref — KHÔNG setState mỗi mousemove (tránh
    // re-render TOÀN BỘ LivePageFrame gây giật). editGhostRef trỏ div ghost dashed;
    // handleMouseMove cập nhật trực tiếp editGhostRef.current.style. editLiveTransformRef
    // lưu transform hiện tại để handleMouseUp đọc khi commit (thay cho state).
    const editGhostRef = useRef<HTMLDivElement>(null);
    const editLiveTransformRef = useRef<EditLiveTransform | null>(null);
    const editNudgeDeltaRef = useRef({ dx: 0, dy: 0 });
    const editNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Gốc CropBox (bx0,by0) point của TRANG hiện tại — dùng cho add-text/image.
    const editCropOriginRef = useRef<[number, number]>([0, 0]);
    // GIỮ ghost ở vị trí vừa thả tới khi overlay cập nhật vị trí MỚI (sau commit)
    // → bỏ hiện tượng khung chọn "giật về chỗ cũ rồi nhảy tới chỗ mới".
    const editGhostHoldRef = useRef<boolean>(false);
    const editGhostHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Giữ targetIds đã chọn qua vòng commit (setSelectionFileId xóa selection) →
    // sau khi /edit/objects refetch, re-select để khung bám chữ vừa kéo (tránh "mất chữ").
    const pendingReselectIdsRef = useRef<string[] | null>(null);
    // Ref cho listener window (tránh stale closure khi pointermove).
    const editInteractionRef = useRef(editInteraction);
    useEffect(() => { editInteractionRef.current = editInteraction; }, [editInteraction]);
    // Keep latest edit helper through a ref; avoid a pre-declaration TDZ.
    const sendEditAndPreviewRef = useRef<((op: EditOp) => Promise<boolean>) | null>(null);
    useEffect(() => { setShowImageFrameMenu(false); }, [selectedObjectIds, isObjectEditMode]);

    // Ẩn ghost + xóa transform tạm; dùng chung cho commit/refetch/timeout an toàn.
    const hideEditGhost = React.useCallback(() => {
        editGhostHoldRef.current = false;
        if (editGhostHideTimerRef.current) {
            clearTimeout(editGhostHideTimerRef.current);
            editGhostHideTimerRef.current = null;
        }
        if (editGhostRef.current) {
            editGhostRef.current.style.display = 'none';
            editGhostRef.current.style.transform = 'none';
        }
    }, []);

    // ─── Edit PDF Object — editor text inline + thêm object (task 10.3) ──────
    // editAddMode: chế độ "đặt object mới" (nay ở STORE dùng chung — nút điều khiển ở
    // panel phải, cú bấm kế tiếp lên BẤT KỲ trang nào sẽ đặt object tại đó). editAddDraft:
    // điểm bấm đã chốt theo hệ CANVAS top-left (point) — convert sang PDF bottom-left khi
    // gửi /edit/add. editFileInputRef: input file ẩn để chọn ảnh khi thêm image.
    const [editAddDraft, setEditAddDraft] = useState<{ xPt: number; yPt: number } | null>(null);
    const editFileInputRef = useRef<HTMLInputElement>(null);
    const editReplaceImageInputRef = useRef<HTMLInputElement>(null);
    const pendingReplaceImageIdRef = useRef<string | null>(null);
    const [showImageFrameMenu, setShowImageFrameMenu] = useState(false);

    const observerRef = useRef<IntersectionObserver | null>(null);

    const handleTileVisibility = React.useCallback((el: HTMLElement, isCleanup?: boolean) => {
        if (!observerRef.current) {
            observerRef.current = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const target = entry.target as LoadableTileElement;
                        if (target._loadTile) target._loadTile();
                        observerRef.current?.unobserve(target);
                    }
                });
            }, { rootMargin: '600px' });
        }
        if (isCleanup) {
            observerRef.current.unobserve(el);
        } else {
            observerRef.current.observe(el);
        }
    }, []);

    // Disconnect observer khi unmount → nhả toàn bộ node tile đang quan sát. Trước
    // đây observer chỉ unobserve per-tile, không disconnect → cộng dồn với việc tab
    // luôn mounted (App.tsx) khiến observer + node giữ tới khi đóng tab.
    useEffect(() => () => {
        observerRef.current?.disconnect();
        observerRef.current = null;
    }, []);

    // Scale render cho 1 tile phủ CẢ TRANG (chỉ 1 lần render/trang — pdfium xử lý cả
    // trang dù cắt ô, nên tiling chỉ làm chậm gấp N). Render ĐÚNG zoom×dpr (đủ nét cho
    // màn hình, ÍT pixel nhất → mở file nhanh). KHÔNG làm tròn scale lên nấc cao (từng
    // làm tròn lên gây render dư pixel → chậm trên màn HiDPI).
    // Cap bộ nhớ: cạnh dài bitmap ≤ 6000px (1 render). Dùng hàm thuần dùng chung với
    // prefetch (computeRenderZoomPure) → cùng giá trị → cache key tile khớp.
    // PERF (audit độ nét 2026-07-28 §R.9): ngân sách pixel theo cài đặt của người dùng.
    const renderBudgetPx = previewQuality === 'fast' ? RENDER_BUDGET_PX.fast : RENDER_BUDGET_PX.high;
    const computeRenderZoom = useCallback((z: number) => computeRenderZoomPure(
        z,
        actualWidth100,
        pageDim?.w,
        pageDim?.h,
        renderBudgetPx,
        physicalDisplayScale,
        displayDevicePixelRatio,
    ), [actualWidth100, pageDim?.w, pageDim?.h, renderBudgetPx, physicalDisplayScale, displayDevicePixelRatio]);
    const [renderZoom, setRenderZoom] = useState(() => computeRenderZoom(zoom));
    const renderedDisplayMetricsRef = useRef({
        scale: physicalDisplayScale,
        dpr: displayDevicePixelRatio,
    });

    // UIUX (audit 2026-08-11 §AS.2): đổi monitor/DPI phải đổi sàn raster ngay trong
    // layout commit; không chờ debounce zoom 250 ms rồi để lộ một frame bị nội suy.
    useLayoutEffect(() => {
        const previous = renderedDisplayMetricsRef.current;
        if (Math.abs(previous.scale - physicalDisplayScale) < 1e-6
            && Math.abs(previous.dpr - displayDevicePixelRatio) < 1e-6) return;
        renderedDisplayMetricsRef.current = {
            scale: physicalDisplayScale,
            dpr: displayDevicePixelRatio,
        };
        setRenderZoom(computeRenderZoom(zoom));
    }, [physicalDisplayScale, displayDevicePixelRatio, computeRenderZoom, zoom]);

    // Đổi cài đặt chất lượng phải áp NGAY (không chờ zoom kế tiếp) → renderBudgetPx trong deps.
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            setRenderZoom(computeRenderZoom(zoom));
        }, 250);
        return () => clearTimeout(timeoutId);
    }, [zoom, renderBudgetPx, physicalDisplayScale, displayDevicePixelRatio, computeRenderZoom]);

    // ─── Edit PDF Object: nạp danh sách object từ /edit/objects (task 10.1) ───
    // Khi vào Selection_Mode, gọi GET /edit/objects/{fid}/{pageIndex} (0-based) để lấy
    // ObjMeta (bbox hệ PDF bottom-left) rồi convert sang hệ canvas top-left bằng
    // chiều cao trang (pageDim.h, point) — dùng chung công thức `x * scale` với overlay.
    useEffect(() => {
        const shouldLoadObjects = shouldLoadEditObjectsForFrame({
            isObjectEditMode,
            isActiveFrame,
            originalPageNum,
            selectionFileId: selectionFileId || '',
            hasPageHeight: Boolean(pageDim?.h),
        });
        if (!shouldLoadObjects) {
            // QUAN TRỌNG (fix vòng lặp "Maximum update depth"): selectedObjectIds là STORE
            // dùng chung MỌI LivePageFrame. Set về `[]` MỚI mỗi lần effect chạy → đổi tham
            // chiếu → useShallow coi là thay đổi → re-render mọi frame → cascade vô hạn
            // (đặc biệt khi nhiều frame ảo Virtuoso + preview re-render liên tục, frame
            // không ở edit-mode liên tục chạy nhánh này). Dùng updater IDEMPOTENT: khi đã
            // rỗng thì giữ NGUYÊN tham chiếu → React/Zustand bail-out, không re-render thừa.
            setEditObjects(prev => (prev.length ? [] : prev));
            // PERF (feedback 2026-08-21 §EDIT.MULTIPAGE1): frame nền không được xóa
            // selection dùng chung của trang active.
            if (isActiveFrame) {
                setSelectedObjectIds(prev => (prev.length ? EMPTY_OBJECT_IDS : prev));
            }
            return;
        }
        const pageIndex = originalPageNum - 1; // /edit dùng chỉ số 0-based
        const cacheKey = `${selectionFileId}:${pageIndex}`;

        // Cache-hit → dùng ngay, KHÔNG fetch lại (bật/tắt chế độ không tải lại).
        // Sau transform, cache bị clear (pdfUrl/fid đổi) nên thường miss; nếu hit
        // vẫn tôn trọng pendingReselectIdsRef.
        const cached = _editObjectsCache.get(cacheKey);
        if (cached) {
            setEditObjects(prev => (prev === cached ? prev : cached));
            const pending = pendingReselectIdsRef.current;
            pendingReselectIdsRef.current = null;
            if (pending && pending.length) {
                const alive = pending.filter(id => cached.some(o => o.id === id));
                setSelectedObjectIds(alive.length ? alive : EMPTY_OBJECT_IDS);
            } else {
                setSelectedObjectIds(prev => (prev.length ? EMPTY_OBJECT_IDS : prev));
            }
            editCropOriginRef.current = _editCropOriginCache.get(cacheKey) || [0, 0];
            hideEditGhost();
            return;
        }

        let cancelled = false;
        // pageDim.h là px@96 (= point × 96/72). Bbox /edit/objects ở POINT. Quy đổi
        // chiều cao trang về POINT để lật trục y NHẤT QUÁN đơn vị (giữ bbox ở point).
        const pageHeightPt = pageDim.h * 72 / 96;
        (async () => {
            try {
                const res = await authenticatedFetch(`${getApiUrl()}/edit/objects/${selectionFileId}/${pageIndex}`);
                if (!res.ok) throw new Error(`/edit/objects HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                if (isActiveFrame && Array.isArray(data.hiddenObjectIds)) {
                    setHiddenObjectIds(data.hiddenObjectIds);
                }
                // CropBox offset: object bbox từ PDFium ở hệ user-space NATIVE. Trang
                // hiển thị (tile) render theo CropBox → cần TRỪ gốc CropBox (bx0,by0)
                // để overlay khớp ảnh. File thường có gốc (0,0) → no-op; file Illustrator
                // hay có CropBox/MediaBox lệch gốc → fix lệch tọa độ (rủi ro audit #1).
                const pb = Array.isArray(data.pageBox) && data.pageBox.length === 4 ? data.pageBox : null;
                const bx0 = pb ? Number(pb[0]) || 0 : 0;
                const by0 = pb ? Number(pb[1]) || 0 : 0;
                editCropOriginRef.current = [bx0, by0];
                const objs: EditCanvasObj[] = (data.objects || [])
                    .filter((o: CachedPdfObject) => !isNonPaintingPointTextObject(o))
                    .map((o: CachedPdfObject) => {
                    const cbbox = objectBboxNativeToCanvas(o.bbox as BBox, pageHeightPt, bx0, by0);
                    return {
                        id: o.id,
                        drawIndex: o.drawIndex,
                        type: o.type as ObjType,
                        ocgIds: Array.isArray(o.ocgIds) ? o.ocgIds.map(Number).filter(Number.isFinite) : [],
                        ocgNames: Array.isArray(o.ocgNames) ? o.ocgNames.map(String) : [],
                        bbox: cbbox,
                        matrix: o.matrix ?? undefined,
                        content: o.content ?? undefined,
                        color: Array.isArray(o.color) ? o.color : undefined,
                        fontName: o.fontName ?? undefined,
                    };
                });
                _editObjectsCache.set(cacheKey, objs); // Lưu cache cho lần bật/tắt sau.
                _editCropOriginCache.set(cacheKey, [bx0, by0]);
                setEditObjects(objs);
                // Sau move/transform: re-select đúng id (cùng text-0…) để khung bám
                // vị trí MỚI — nếu clear selection, chữ đã dịch dễ bị tưởng "mất".
                const pending = pendingReselectIdsRef.current;
                pendingReselectIdsRef.current = null;
                if (pending && pending.length) {
                    const alive = pending.filter(id => objs.some(o => o.id === id));
                    setSelectedObjectIds(alive.length ? alive : EMPTY_OBJECT_IDS);
                } else {
                    setSelectedObjectIds(prev => (prev.length ? EMPTY_OBJECT_IDS : prev));
                }
                hideEditGhost(); // Overlay đã ở vị trí mới → bỏ ghost giữ.
            } catch (err) {
                if (!cancelled) {
                    console.warn(t('misc.livePageFrame:edit_khong_tai_duoc_edit_objects'), err);
                    setEditObjects(prev => (prev.length ? [] : prev));
                    setSelectedObjectIds(prev => (prev.length ? EMPTY_OBJECT_IDS : prev));
                    const m = err instanceof Error ? err.message : String(err);
                    // 404 = fid/file không còn trên backend (thường sau khi RESTART
                    // server, file tải lên cũ đã mất) → hướng dẫn mở lại file.
                    if (/HTTP 404/.test(m)) {
                        setEditNotice(t('misc.livePageFrame:khong_tai_duoc_doi_tuong_file_nay_khong'));
                    } else {
                        setEditNotice(t('misc.livePageFrame:khong_tai_duoc_danh_sach_doi_tuong_de'));
                    }
                    setTimeout(() => setEditNotice(null), 8000);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [isObjectEditMode, originalPageNum, selectionFileId, pageDim?.h, editObjectsVersion, isActiveFrame, setHiddenObjectIds, setSelectedObjectIds, hideEditGhost, t]);

    // ─── Edit PDF Object: đồng bộ object của TRANG ACTIVE lên panel (fix tắt mắt) ─
    // Panel "Thành phần" đọc store `currentEditObjects`. Vì danh sách trang là ảo
    // (Virtuoso) nên có nhiều LivePageFrame cùng sống; CHỈ frame đang xem mới được
    // đẩy editObjects của mình lên store → panel liệt kê đúng object trang active,
    // nên khi tắt mắt một thành phần, id nhắm trúng trang active và /edit/preview-hide
    // thực sự ẩn object (overlay preview đắp lên trang). Bỏ chọn cũ của trang khác.
    useEffect(() => {
        if (!isObjectEditMode || !isActiveFrame || !setCurrentEditObjects) return;
        // Chỉ ghi store khi reference/nội dung đổi — tránh loop với panel Thành phần.
        // Chuẩn hóa bbox canvas của overlay về contract object cache của panel.
        // [LINT AUDIT 2026-08-24 LO140]
        const nextEditObjects: CachedPdfObject[] = editObjects.map((obj) => ({
            id: obj.id,
            type: obj.type,
            bbox: [...obj.bbox],
            drawIndex: obj.drawIndex,
            ocgIds: obj.ocgIds,
            ocgNames: obj.ocgNames,
            matrix: obj.matrix,
            content: obj.content,
            color: obj.color,
            fontName: obj.fontName,
            nativeBbox: obj.nativeBbox,
        }));
        setCurrentEditObjects((prev: CachedPdfObject[]) => {
            if (prev === nextEditObjects) return prev;
            if (
                Array.isArray(prev) && Array.isArray(nextEditObjects)
                && prev.length === nextEditObjects.length
                && prev.every((o: CachedPdfObject, i: number) => o === nextEditObjects[i] || o?.id === nextEditObjects[i]?.id)
            ) {
                return prev;
            }
            return nextEditObjects;
        });
    }, [isObjectEditMode, isActiveFrame, editObjects, setCurrentEditObjects]);

    // Persist the active-page selection for downstream tools. Edit mode clears
    // selectedObjectIds while closing, so this effect intentionally does nothing
    // after edit mode is off; the snapshot survives the mode transition.
    useEffect(() => {
        if (!isObjectEditMode || !isActiveFrame || !selectionFileId || originalPageNum < 1) return;
        const availableIds = new Set(editObjects.map((obj) => obj.id));
        const objectIds = selectedObjectIds.filter((id) => availableIds.has(id));
        setObjectSelectionContext(objectIds.length > 0 ? {
            fileId: selectionFileId,
            pageIndex: originalPageNum - 1,
            objectIds,
        } : null);
    }, [
        isObjectEditMode,
        isActiveFrame,
        selectionFileId,
        originalPageNum,
        editObjects,
        selectedObjectIds,
        setObjectSelectionContext,
    ]);

    // ─── Edit PDF Object: Ctrl+A chọn tất cả / Esc bỏ chọn / Delete xóa (task 10.1) ─
    // CHỈ frame ĐANG XEM (isActiveFrame) mới xử lý phím: listener gắn trên `window` nên
    // MỌI LivePageFrame còn mount (Virtuoso giữ nhiều frame sống) đều nghe. selectedObjectIds/
    // selectionFileId là store DÙNG CHUNG nhưng originalPageNum RIÊNG mỗi frame → nếu không
    // gate, bấm Delete khiến mọi frame gửi /edit/delete với cùng targetIds lên TRANG KHÁC
    // (nơi id không tồn tại) → backend trả 404 + toast lỗi, dù frame active đã xóa thành công.
    useEffect(() => {
        if (!isObjectEditMode || isVdpMode || !isActiveFrame || isViewerActive === false) return;
        const onKey = (e: KeyboardEvent) => {
            // Bỏ qua khi đang gõ trong input/textarea (vd. editor text inline).
            const t = e.target as HTMLElement | null;
            const dispatchEditOp = (op: EditOp) => sendEditAndPreviewRef.current?.(op) ?? Promise.resolve(false);
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                setSelectedObjectIds(editObjects.filter(o => !lockedObjectIds.includes(o.id)).map(o => o.id));
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
                // Copy: chỉ ghi nhớ {trang nguồn, id} vào clipboard store — KHÔNG gọi backend.
                if (selectedObjectIds.length === 0) return;
                e.preventDefault();
                setEditClipboard({ sourcePage: originalPageNum - 1, objectIds: [...selectedObjectIds], pasteCount: 0 });
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                // Paste: dựng op vào trang ĐANG active; offset lệch cộng dồn theo pasteCount.
                if (editBusy || !editClipboard || editClipboard.objectIds.length === 0) return;
                e.preventDefault();
                const bump = editClipboard.pasteCount + 1;
                const off = mmToPt(PASTE_OFFSET_MM * bump);
                const op: EditOp = {
                    page: originalPageNum - 1,
                    sourcePage: editClipboard.sourcePage,
                    kind: 'paste',
                    targetIds: [...editClipboard.objectIds],
                    delta: { dx: off, dy: -off },
                };
                void dispatchEditOp(op).then((success) => {
                    if (success) setEditClipboard({ ...editClipboard, pasteCount: bump });
                });
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
                // Duplicate nhanh: copy + paste tức thì trong CÙNG trang, lệch một offset.
                if (editBusy || selectedObjectIds.length === 0) return;
                e.preventDefault();
                const off = mmToPt(PASTE_OFFSET_MM);
                const op: EditOp = {
                    page: originalPageNum - 1,
                    sourcePage: originalPageNum - 1,
                    kind: 'paste',
                    targetIds: [...selectedObjectIds],
                    delta: { dx: off, dy: -off },
                };
                void dispatchEditOp(op);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // Xóa tập object đang chọn → POST /edit/delete → Working_File mới.
                if (editBusy || selectedObjectIds.length === 0) return;
                e.preventDefault();
                const op: EditOp = {
                    page: originalPageNum - 1,
                    kind: 'delete',
                    targetIds: [...selectedObjectIds],
                };
                const idsToClear = [...selectedObjectIds];
                void dispatchEditOp(op).then((success) => {
                    // Chỉ bỏ chọn khi backend đã xóa thật; op lỗi vẫn giữ selection để thử lại.
                    if (success) setSelectedObjectIds(prev => prev.filter(id => !idsToClear.includes(id)));
                });
            } else if (e.key === 'Escape') {
                setSelectedObjectIds(EMPTY_OBJECT_IDS);
                // task 10.3: thoát chế độ đặt object mới đang chờ (nếu có).
                setEditAddMode(null);
                setEditAddDraft(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isObjectEditMode, isVdpMode, isActiveFrame, editObjects, selectedObjectIds, editBusy, originalPageNum, selectionFileId, onEditCommit, lockedObjectIds, editClipboard, setEditClipboard, isViewerActive, setEditAddMode, setSelectedObjectIds]);

    // ─── Edit PDF Object: reset transform tạm + preview khi đổi lựa chọn (10.2) ─
    // Khi tập chọn thay đổi (hoặc bỏ chọn), bỏ transform tạm và ảnh preview cũ để
    // overlay không "dính" trạng thái của lần thao tác trước.
    useEffect(() => {
        editLiveTransformRef.current = null;
    }, [selectedObjectIds]);

    // ─── Edit PDF Object: dọn transform tạm khi Working_File MỚI render (task 12.1) ─
    // SAU commit, onEditCommit → commitWorkingFile đổi `pdfUrl` (Working_File mới đã
    // bake đúng thao tác vào nội dung trang). Transform là state cục bộ nên reset tại
    // frame; cache/selection/previews là state CHUNG và được Viewer cha dọn đúng một lần.
    useEffect(() => {
        editLiveTransformRef.current = null;
    }, [pdfUrl]);

    // LƯU Ý: KHÔNG return sớm cho originalPageNum === -1 ở đây. Trước kia khối này
    // đặt TRƯỚC nhiều hook bên dưới (useEffect 845/949/1100/1104...), nên khi một
    // frame đổi originalPageNum giữa -1 và số trang thật, số hook gọi bị lệch →
    // React error #300 crash. Đã dời xuống SAU TẤT CẢ hook (ngay trước Render).

    // Fetch preview image when hidden objects OR hidden OCG layers change
    useEffect(() => {
        if (!isActiveFrame) {
            setPreviewImageUrl(null);
            setIsPreviewLoading(false);
            return;
        }

        if (
            hiddenObjectIds.length === 0
            && hiddenOcgLayerIds.length === 0
            && ocgVisibilityIntent !== 'explicit'
        ) {
            setPreviewImageUrl(null);
            setIsPreviewLoading(false);
            return;
        }

        // Layer trong Edit PDF đã được render từ live session và hiển thị qua session preview.
        // Không gọi thêm preview-layers từ file nguồn vì sẽ tạo hai full-page render chồng nhau
        // (nhấp nháy/giật) và có thể phủ lên trạng thái layer mới.
        if (isObjectEditMode) {
            setPreviewImageUrl(null);
            setIsPreviewLoading(false);
            return;
        }

        if (!selectionFileId) return;

        let isMounted = true;
        const controller = new AbortController();
        setIsPreviewLoading(true);

        const fetchPreview = async () => {
            try {
                // Explicit `[]` vẫn phải render show-all vì tile nguồn giữ default-OFF.
                if (
                    (hiddenOcgLayerIds.length > 0 || ocgVisibilityIntent === 'explicit')
                    && !isObjectEditMode
                ) {
                    const res = await authenticatedFetch(`${getApiUrl()}/preflight/preview-layers`, {
                        method: 'POST',
                        signal: controller.signal,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            file_id: selectionFileId,
                            page: originalPageNum,
                            hidden_layer_ids: hiddenOcgLayerIds
                        })
                    });
                    if (!res.ok) throw new Error('Preview layer fetch failed');
                    const data = await res.json();
                    if (isMounted && data.success && data.preview_b64) {
                        setPreviewImageUrl(data.preview_b64);
                    }
                    return; // Skip the hidden object fetch if we did OCG
                }

                // ─── Edit mode: ẩn HÌNH THẬT của object qua render read-only ───
                // Gọi /edit/preview-hide (pikepdf xóa in-memory → PDFium render, KHÔNG
                // ghi file). Ảnh trả về là TRANG ĐÃ LOẠI object bị ẩn → đắp overlay
                // toàn trang khớp khung trang (objectFit:fill). hiddenObjectIds cùng
                // id-space với /edit/objects nên truyền thẳng làm targetIds.
                if (isObjectEditMode) {
                    const res = await authenticatedFetch(`${getApiUrl()}/edit/preview-hide`, {
                        method: 'POST',
                        signal: controller.signal,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fid: selectionFileId,
                            page: originalPageNum - 1, // /edit dùng chỉ số 0-based
                            targetIds: hiddenObjectIds,
                        })
                    });
                    if (!res.ok) throw new Error(`/edit/preview-hide HTTP ${res.status}`);
                    const data = await res.json();
                    if (isMounted && data.image) {
                        setPreviewImageUrl(data.image);
                    }
                    return;
                }

                // Fallback to hidden object preview (legacy, ngoài edit mode)
                const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);
                const objectsToHide = currentObjects.filter((o: CachedPdfObject) => hiddenObjectIds.includes(o.id));
                
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/preview-hide`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: selectionFileId,
                        page: originalPageNum,
                        objects: objectsToHide.map((obj: CachedPdfObject) => ({
                            type: obj.type,
                            bbox: obj.bbox,
                            xref: obj.xref
                        }))
                    })
                });

                if (!res.ok) throw new Error('Preview fetch failed');
                const data = await res.json();
                
                if (isMounted && data.success && data.preview_b64) {
                    setPreviewImageUrl(data.preview_b64);
                }
            } catch (err) {
                if (!(err instanceof DOMException && err.name === 'AbortError')) console.error("Failed to fetch hidden layer preview:", err);
                if (isMounted) setPreviewImageUrl(null);
            } finally {
                if (isMounted) setIsPreviewLoading(false);
            }
        };

        // Small debounce to avoid spamming if user clicks rapidly
        const timeoutId = setTimeout(() => {
            fetchPreview();
        }, 300);

        return () => {
            isMounted = false;
            controller.abort();
            clearTimeout(timeoutId);
        };
    }, [hiddenObjectIds, hiddenOcgLayerIds, ocgVisibilityIntent, selectionFileId, originalPageNum, isObjectEditMode, isActiveFrame, pdfUrl]);
    
    //#endregion

    //#region Drag & Interaction Events
    const displayWidth = actualWidth100 * zoom;
    // Native event listeners to bypass WebView2/React synthetic event limitations
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const handleDragEnter = (e: DragEvent) => {
            e.preventDefault();
            if (isVdpMode) {
                el.style.opacity = '0.8';
                e.dataTransfer!.dropEffect = 'copy';
            }
        };

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault(); // MANDATORY for drop
            if (isVdpMode) {
                e.dataTransfer!.dropEffect = 'copy';
            }
        };

        const handleDragLeave = () => {
            el.style.opacity = '1';
        };

        const handleDrop = (e: DragEvent) => {
            el.style.opacity = '1';
            if (!isVdpMode || isViewerActive === false) return;
            e.preventDefault();
            
            let vdpType = '';
            try {
                vdpType = e.dataTransfer!.getData('application/vdp-field');
            } catch {
                // DataTransfer có thể không chứa kiểu VDP hợp lệ.
            }
            if (!vdpType) {
                try {
                    const payload = JSON.parse(e.dataTransfer!.getData('text/plain'));
                    if (payload && payload.source === 'vdp') {
                        vdpType = payload.type;
                    }
                } catch {
                    // Payload text không phải JSON VDP; bỏ qua.
                }
            }
            
            if (vdpType && pageDim) {
                const rect = el.getBoundingClientRect();
                const curX = e.clientX - rect.left;
                const curY = e.clientY - rect.top;
                
                const pageWidthPt = pageDim.w;
                const scale = displayWidth / pageWidthPt;
                
                const boxX = (curX / scale) / 72 * 25.4;
                const boxY = (curY / scale) / 72 * 25.4;
                
                // default sizes — theo loại field để khung khớp mẫu ngay khi thả
                const isSquare = vdpType === 'qrcode' || vdpType === 'image';
                let wMM = isSquare ? 25 : 50;
                let hMM = vdpType === 'qrcode' || vdpType === 'image' ? 25 : (vdpType === 'barcode' ? 15 : 10);
                // Không cho placeholder vượt quá ~90% kích thước trang (quan trọng với trang nhỏ như 15x15mm)
                // pageDim.w là px@96; field dùng đơn vị "CSS-mm" (mm × 96/72) nên dùng × 25.4 / 72.
                const pageWmm = pageDim.w * 25.4 / 72;
                const pageHmm = pageDim.h * 25.4 / 72;
                const maxW = pageWmm * 0.9;
                const maxH = pageHmm * 0.9;
                if (isSquare) {
                    const s = Math.max(5, Math.min(wMM, maxW, maxH));
                    wMM = s; hMM = s;
                } else {
                    wMM = Math.max(5, Math.min(wMM, maxW));
                    hMM = Math.max(5, Math.min(hMM, maxH));
                }
                // Canh để khung nằm gọn trong trang
                const placeX = Math.max(0, Math.min(boxX, pageWmm - wMM));
                const placeY = Math.max(0, Math.min(boxY, pageHmm - hMM));
                const textContent = vdpType === 'text' ? `{Truong_${vdpFields.length + 1}}` : undefined;
                const fieldName = `Truong_${vdpFields.length + 1}`;
                
                onVdpBoxCreate?.({ 
                    x: placeX, y: placeY, width: wMM, height: hMM, 
                    pageNum: originalPageNum, type: vdpType,
                    textContent: textContent || undefined,
                    name: fieldName || undefined
                });
            }
        };

        const handleVdpDrop = (e: CustomEvent) => {
            if (!isVdpMode || isViewerActive === false) return;
            const targetEl = e.detail.target as HTMLElement;
            if (!el.contains(targetEl) && el !== targetEl) return;
            
            const vdpType = e.detail.type;
            if (vdpType && pageDim) {
                const rect = el.getBoundingClientRect();
                const curX = e.detail.clientX - rect.left;
                const curY = e.detail.clientY - rect.top;
                
                const pageWidthPt = pageDim.w;
                const scale = displayWidth / pageWidthPt;
                
                const boxX = (curX / scale) / 72 * 25.4;
                const boxY = (curY / scale) / 72 * 25.4;
                
                // default sizes — theo loại field để khung khớp mẫu ngay khi thả
                const isSquare = vdpType === 'qrcode' || vdpType === 'image';
                let wMM = isSquare ? 25 : 50;
                let hMM = vdpType === 'qrcode' || vdpType === 'image' ? 25 : (vdpType === 'barcode' ? 15 : 10);
                // Không cho placeholder vượt quá ~90% kích thước trang (quan trọng với trang nhỏ như 15x15mm)
                // pageDim.w là px@96; field dùng đơn vị "CSS-mm" (mm × 96/72) nên dùng × 25.4 / 72.
                const pageWmm = pageDim.w * 25.4 / 72;
                const pageHmm = pageDim.h * 25.4 / 72;
                const maxW = pageWmm * 0.9;
                const maxH = pageHmm * 0.9;
                if (isSquare) {
                    const s = Math.max(5, Math.min(wMM, maxW, maxH));
                    wMM = s; hMM = s;
                } else {
                    wMM = Math.max(5, Math.min(wMM, maxW));
                    hMM = Math.max(5, Math.min(hMM, maxH));
                }
                // Canh để khung nằm gọn trong trang
                const placeX = Math.max(0, Math.min(boxX, pageWmm - wMM));
                const placeY = Math.max(0, Math.min(boxY, pageHmm - hMM));
                const textContent = e.detail.textContent || (vdpType === 'text' ? `{Truong_${vdpFields.length + 1}}` : undefined);
                const fieldName = e.detail.name || `Truong_${vdpFields.length + 1}`;
                
                onVdpBoxCreate?.({ 
                    x: placeX, y: placeY, width: wMM, height: hMM, 
                    pageNum: originalPageNum, type: vdpType,
                    textContent: textContent || undefined,
                    name: fieldName || undefined
                });
            }
        };

        el.addEventListener('dragenter', handleDragEnter);
        el.addEventListener('dragover', handleDragOver);
        el.addEventListener('dragleave', handleDragLeave);
        el.addEventListener('drop', handleDrop);
        window.addEventListener('vdp-drop', handleVdpDrop as EventListener);

        return () => {
            el.removeEventListener('dragenter', handleDragEnter);
            el.removeEventListener('dragover', handleDragOver);
            el.removeEventListener('dragleave', handleDragLeave);
            el.removeEventListener('drop', handleDrop);
            window.removeEventListener('vdp-drop', handleVdpDrop as EventListener);
        };
    }, [isVdpMode, pageDim, displayWidth, onVdpBoxCreate, vdpFields.length, originalPageNum, isViewerActive]);

    const displayHeight = pageDim && pageDim.w ? displayWidth * (pageDim.h / pageDim.w) : displayWidth * 1.414;
    const cropPageBox = useMemo(() => pageDim?.w && pageDim?.h ? { x0: 0, y0: 0, x1: pageDim.w * 25.4 / 96, y1: pageDim.h * 25.4 / 96, width: pageDim.w * 25.4 / 96, height: pageDim.h * 25.4 / 96 } : undefined, [pageDim?.w, pageDim?.h]);
    const isRotated = (rotation || 0) % 180 !== 0;
    const outerWidth = isRotated ? displayHeight : displayWidth;
    const outerHeight = isRotated ? displayWidth : displayHeight;

    useEffect(() => {
        const frameEnabled = isActiveFrame || accurateColorPage || isViewerActive !== false;
        if (!frameEnabled || !pageDim?.w || !pageDim?.h) return;
        const dpr = Number.isFinite(displayDevicePixelRatio) && displayDevicePixelRatio > 0
            ? displayDevicePixelRatio
            : 1;
        const fullPageTargetRenderZoom = computeRenderZoom(zoom);
        const scrollViewport = containerRef.current?.closest('.acro-scroll') as HTMLElement | null;
        const viewportWidth = scrollViewport?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
        const viewportHeight = scrollViewport?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
        const directFullPageSurface = shouldUseViewerDirectFullPageSurface(
            accurateColorPage,
            fullPageTargetRenderZoom,
            zoom * dpr,
            outerWidth,
            outerHeight,
            viewportWidth,
            viewportHeight,
        );
        const fullPageWithinSurfaceBudget = Boolean(isImage)
            || isViewerFullPageWithinSurfaceBudget(
                outerWidth,
                outerHeight,
                fullPageTargetRenderZoom,
                zoom * dpr,
            );
        const forceViewport = !fullPageWithinSurfaceBudget
            || (accurateColorPage && !directFullPageSurface);
        const needsTiling = shouldUseViewerViewportTiles(
            viewerIsActive,
            isActiveFrame,
            isImage,
            renderZoom,
            zoom,
            dpr,
            accurateColorPage,
            forceViewport,
        );
        const renderBaseTile = shouldRenderViewerBaseTile(
            shouldRenderBasePage,
            accurateColorPage,
            needsTiling,
            isActiveFrame,
            fullPageWithinSurfaceBudget,
        );
        const bgZoom = computeViewerBackgroundZoom(renderZoom, dpr, isActiveFrame, needsTiling);
        const preferredAccurateBaseZoom = accurateViewerRequestScale(
            directFullPageSurface
                ? Math.min(renderZoom, fullPageTargetRenderZoom)
                : computeAccurateViewerBaseZoom(
                    renderZoom,
                    zoom,
                    dpr,
                    physicalDisplayScale * dpr,
            ),
            accurateDpiAnchor,
        );
        const screenAccurateBaseZoom = accurateViewerRequestScale(
            zoom * dpr,
            accurateDpiAnchor,
        );
        const roleAccurateBaseZoom = initialPpeFrame?.renderScale
            ?? viewerAccurateBaseScaleForRole(
                preferredAccurateBaseZoom,
                screenAccurateBaseZoom,
                isActiveFrame,
                prefetchPage === true,
                Boolean(accurateBaseReadyKey),
            );
        const selectedAccurateBaseZoom = selectViewerAccurateBaseZoom(
            roleAccurateBaseZoom,
            outerWidth,
            outerHeight,
            zoom * dpr,
        );
        const accurateBaseWithinSurfaceBudget = selectedAccurateBaseZoom !== null;
        const accurateBaseZoom = selectedAccurateBaseZoom ?? roleAccurateBaseZoom;
        const renderAccurateUnderlay = shouldRenderViewerAccurateUnderlay(
            shouldRenderBasePage,
            accurateColorPage,
            needsTiling,
            accurateBaseWithinSurfaceBudget,
        );
        const renderAccurateBaseTile = shouldRenderViewerAccurateBaseTile(
            shouldRenderBasePage,
            accurateColorPage,
            needsTiling,
            accurateBaseWithinSurfaceBudget,
        ) || renderAccurateUnderlay;
        const accuratePageCommitKey = `${viewerTraceHash(`${pdfUrl || nativeFilePath || 'memory'}:${originalPageNum}`)}:${originalPageNum}`;
        const accurateCommitted = accurateCommittedKey === accuratePageCommitKey;
        const accurateBaseIdentity = `${accuratePageCommitKey}:${accurateBaseZoom}`;
        const accurateBaseReady = accurateBaseReadyKey === accurateBaseIdentity;
        const keepAccurateBaseMounted = shouldKeepViewerAccurateBaseMounted(
            accurateColorPage,
            renderAccurateBaseTile,
            accurateCommitted,
            accurateBaseWithinSurfaceBudget,
        );
        const requestAccurateBase = shouldRequestViewerAccurateBase(
            renderAccurateBaseTile,
            accurateCommitted,
            accurateBaseReady,
            accurateBaseWithinSurfaceBudget,
        );
        const useDisplayBase = shouldUseViewerDisplayLayer(
            accurateColorPage,
            accurateCommitted,
            keepDisplayUntilAccurate,
        );
        const mountViewportLayer = shouldMountViewerViewportLayer(
            needsTiling,
            accurateColorPage,
            isActiveFrame,
            accurateCommitted,
            accurateBaseReady,
        );
        const policySignature = [
            traceFrameIdRef.current,
            originalPageNum,
            isActiveFrame,
            accurateColorPage,
            renderZoom,
            zoom,
            displayWidth,
            displayHeight,
            directFullPageSurface,
            fullPageWithinSurfaceBudget,
            accurateBaseWithinSurfaceBudget,
            renderAccurateUnderlay,
            needsTiling,
            renderBaseTile,
            renderAccurateBaseTile,
            bgZoom,
            accurateBaseZoom,
        ].join('|');
        if (traceFrameLastPolicyRef.current === policySignature) return;
        traceFrameLastPolicyRef.current = policySignature;
        void viewerTraceLog('frame-policy', {
            frame_id: traceFrameIdRef.current,
            page: originalPageNum,
            viewer_page: previewFramePage,
            active_frame: isActiveFrame,
            viewer_active: viewerIsActive,
            accurate_color: accurateColorPage,
            image: Boolean(isImage),
            render_enabled: Boolean(getTileUrl),
            zoom,
            render_zoom: renderZoom,
            target_render_zoom: fullPageTargetRenderZoom,
            dpr,
            physical_scale: physicalDisplayScale,
            page_w: pageDim.w,
            page_h: pageDim.h,
            display_w: displayWidth,
            display_h: displayHeight,
            outer_w: outerWidth,
            outer_h: outerHeight,
            viewport_w: viewportWidth,
            viewport_h: viewportHeight,
            direct_full_page: directFullPageSurface,
            full_page_budget: fullPageWithinSurfaceBudget,
            accurate_base_budget: accurateBaseWithinSurfaceBudget,
            force_viewport: forceViewport,
            needs_tiling: needsTiling,
            render_base_tile: renderBaseTile,
            render_accurate_base: renderAccurateBaseTile,
            render_accurate_underlay: renderAccurateUnderlay,
            use_display_base: useDisplayBase,
            keep_accurate_base_mounted: keepAccurateBaseMounted,
            request_accurate_base: requestAccurateBase,
            mount_viewport_layer: mountViewportLayer,
            background_zoom: bgZoom,
            accurate_base_zoom: accurateBaseZoom,
            display_base_ready: baseDisplayReadyKey === `${viewerTraceHash(`${pdfUrl || nativeFilePath || 'memory'}:${originalPageNum}`)}:${originalPageNum}:${bgZoom}`,
            accurate_committed: accurateCommitted,
            accurate_base_ready: accurateBaseReady,
        });
    }, [
        accurateBaseReadyKey,
        accurateColorPage,
        accurateCommittedKey,
        accurateDpiAnchor,
        baseDisplayReadyKey,
        computeRenderZoom,
        displayDevicePixelRatio,
        displayHeight,
        displayWidth,
        getTileUrl,
        initialPpeFrame,
        isActiveFrame,
        isImage,
        isViewerActive,
        keepDisplayUntilAccurate,
        nativeFilePath,
        outerHeight,
        outerWidth,
        pageDim,
        physicalDisplayScale,
        pdfUrl,
        prefetchPage,
        previewFramePage,
        renderZoom,
        shouldRenderBasePage,
        viewerIsActive,
        zoom,
        originalPageNum,
    ]);

    useEffect(() => {
        void viewerTraceLog('frame-render-branch', {
            frame_id: traceFrameIdRef.current,
            page: originalPageNum,
            original_page_valid: originalPageNum !== -1,
            blank_doc: Boolean(isBlankDoc),
            has_tile_url_builder: Boolean(getTileUrl),
            page_dim_valid: Boolean(pageDim?.w && pageDim?.h),
            active_frame: isActiveFrame,
            viewer_active: viewerIsActive,
        });
    }, [
        getTileUrl,
        isActiveFrame,
        isBlankDoc,
        originalPageNum,
        pageDim,
        viewerIsActive,
    ]);

    useEffect(() => {
        const frameId = traceFrameIdRef.current;
        void viewerTraceLog('frame-mount', {
            frame_id: frameId,
            page: originalPageNum,
            active_frame: isActiveFrame,
            page_instance: viewerTraceHash(pageInstanceId || ''),
        });
        return () => {
            void viewerTraceLog('frame-unmount', {
                frame_id: frameId,
                page: originalPageNum,
                active_frame: isActiveFrame,
            });
        };
        // Lifecycle trace intentionally belongs to the frame instance.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Crop PDF: Enter → dialog (mọi vùng); Esc → xóa hết; Delete/Backspace → xóa vùng cuối.
    // cropSelection toàn workspace chỉ có một ownerId nên luôn chỉ có một listener.
    useEffect(() => {
        if (!isCropMode || isViewerActive === false || cropSels.length === 0) return;
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest?.('[role="dialog"]')) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent('prynx-crop-open', {
                    detail: {
                        tabId, ownerId: cropOwnerId, pageNum: previewFramePage,
                        totalPages, pageBox: cropPageBox, viewerRotation: rotation || 0,
                        fracs: cropSels, frac: cropSels[0],
                    },
                }));
            } else if (e.key === 'Escape') {
                commitCropSelection(null);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                // Không xóa khi đang gõ trong input
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                e.preventDefault();
                commitCropSelection((prev) => {
                    if (!prev || prev.ownerId !== cropOwnerId) return prev;
                    const removeIdx = selectedCropIdx >= 0 ? selectedCropIdx : prev.regions.length - 1;
                    const regions = prev.regions.filter((_, index) => index !== removeIdx);
                    return regions.length > 0
                        ? { ...prev, regions, selectedIndex: Math.min(removeIdx, regions.length - 1) }
                        : null;
                });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isCropMode, cropSels, cropOwnerId, selectedCropIdx, commitCropSelection, previewFramePage, originalPageNum, totalPages, cropPageBox, rotation, tabId, isViewerActive]);

    // Crop panel -> page overlay: keep the selected frame visible and live.
    // ownerId prevents updates from reaching a duplicate instance of the same page.
    useEffect(() => {
        if (!isCropMode) return;
        const onPreviewChange = (event: Event) => {
            const detail = (event as CustomEvent<{
                tabId?: string;
                ownerId?: string;
                pageNum?: number;
                fracs?: CropRegionFrac[];
                selectedIndex?: number;
            }>).detail;
            if (!detail || detail.tabId !== tabId || detail.ownerId !== cropOwnerId || !Array.isArray(detail.fracs) || detail.fracs.length === 0) return;
            const regions = detail.fracs.map((frac) => ({ ...frac }));
            const selectedIndex = Math.max(0, Math.min(
                regions.length - 1,
                Number.isInteger(detail.selectedIndex) ? Number(detail.selectedIndex) : 0,
            ));
            setCropSelection((prev) => {
                if (!prev || prev.ownerId !== cropOwnerId) return prev;
                const unchanged = prev.regions.length === regions.length
                    && prev.regions.every((region, index) => {
                        const next = regions[index];
                        return region.x0 === next.x0 && region.y0 === next.y0
                            && region.x1 === next.x1 && region.y1 === next.y1;
                    });
                if (unchanged && prev.selectedIndex === selectedIndex) return prev;
                return { ...prev, regions, selectedIndex };
            });
        };
        window.addEventListener('prynx-crop-preview-change', onPreviewChange as EventListener);
        return () => window.removeEventListener('prynx-crop-preview-change', onPreviewChange as EventListener);
    }, [isCropMode, cropOwnerId, setCropSelection, tabId]);
    // Panel -> canvas uses an explicit focus request. Canvas clicks only update
    // selection and must never recenter the document viewport.
    useEffect(() => {
        if (!isObjectEditMode) return;
        const focusRequested = (event: Event) => {
            const objectId = readEditObjectFocusRequest(event, originalPageNum - 1, {
                tabId,
                pageInstanceId,
            });
            if (!objectId) return;
            const nodes = containerRef.current?.querySelectorAll<HTMLElement>('[data-obj-id]');
            const node = nodes ? Array.from(nodes).find(item => item.dataset.objId === objectId) : null;
            if (!node) return;
            const scrollContainer = findNearestVerticalScrollContainer(node);
            if (scrollContainer) {
                scrollElementVerticallyIntoView(node, scrollContainer, 'center');
            }
        };
        window.addEventListener(EDIT_OBJECT_FOCUS_EVENT, focusRequested);
        return () => window.removeEventListener(EDIT_OBJECT_FOCUS_EVENT, focusRequested);
    }, [isObjectEditMode, originalPageNum, pageInstanceId, tabId]);

    const renderWidth = actualWidth100 * renderZoom;

    useLayoutEffect(() => {
        const element = containerRef.current;
        if (!element || !isViewerActive || !isActiveFrame) {
            const zero = { x: 0, y: 0 };
            pagePixelSnapRef.current = zero;
            setPagePixelSnap(previous => (
                previous.x === 0 && previous.y === 0 ? previous : zero
            ));
            return;
        }

        let rafId: number | null = null;
        let scrollTimer: ReturnType<typeof setTimeout> | null = null;
        const applySnap = () => {
            rafId = null;
            const snapTarget = pageContentRef.current || element;
            const rect = snapTarget.getBoundingClientRect();
            const current = pagePixelSnapRef.current;
            const next = computeDevicePixelSnapOffset(
                rect.left,
                rect.top,
                displayDevicePixelRatio,
                current.x,
                current.y,
            );
            if (Math.abs(next.x - current.x) < 1e-4
                && Math.abs(next.y - current.y) < 1e-4) return;
            pagePixelSnapRef.current = next;
            setPagePixelSnap(next);
        };
        const scheduleSnap = () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(applySnap);
        };
        const handleScroll = () => {
            if (scrollTimer !== null) clearTimeout(scrollTimer);
            // UIUX (feedback 2026-08-11 §VIEW.SHARP): giống Acrobat, khi đang
            // cuộn cho phép dịch liên tục; dừng tay mới snap để tránh nhún nửa pixel.
            scrollTimer = setTimeout(scheduleSnap, VIEWPORT_TILE_SETTLE_MS);
        };

        applySnap();
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(scheduleSnap);
        resizeObserver?.observe(element);
        if (pageContentRef.current && pageContentRef.current !== element) {
            resizeObserver?.observe(pageContentRef.current);
        }
        let scrollContainer: HTMLElement | null = element.parentElement;
        while (scrollContainer) {
            const style = getComputedStyle(scrollContainer);
            const acceptsScroll = /^(auto|scroll|overlay)$/.test(style.overflowX)
                || /^(auto|scroll|overlay)$/.test(style.overflowY);
            const hasScrollableAxis = scrollContainer.scrollWidth > scrollContainer.clientWidth + 1
                || scrollContainer.scrollHeight > scrollContainer.clientHeight + 1;
            if (acceptsScroll && hasScrollableAxis) break;
            scrollContainer = scrollContainer.parentElement;
        }
        scrollContainer?.addEventListener('scroll', handleScroll, { passive: true });
        window.addEventListener('resize', scheduleSnap);
        return () => {
            resizeObserver?.disconnect();
            scrollContainer?.removeEventListener('scroll', handleScroll);
            window.removeEventListener('resize', scheduleSnap);
            if (rafId !== null) cancelAnimationFrame(rafId);
            if (scrollTimer !== null) clearTimeout(scrollTimer);
        };
    }, [displayDevicePixelRatio, isActiveFrame, isViewerActive, outerHeight, outerWidth, rotation]);

    const getUnrotatedCoords = React.useCallback((clientX: number, clientY: number, rect: DOMRect) => {
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const x = clientX - rect.left - cx;
        const y = clientY - rect.top - cy;
        
        const angle = -(rotation || 0) * Math.PI / 180;
        const unrotatedX = x * Math.cos(angle) - y * Math.sin(angle);
        const unrotatedY = x * Math.sin(angle) + y * Math.cos(angle);
        
        return { 
            x: unrotatedX + displayWidth / 2, 
            y: unrotatedY + displayHeight / 2 
        };
    }, [displayHeight, displayWidth, rotation]);

    // ─── Edit PDF Object (task 10.2): hộp bao hợp nhất của object đang chọn ───

    const cancelCropAdjustment = React.useCallback(() => {
        const adjustment = cropAdjustRef.current;
        cropAdjustRef.current = null;
        if (!adjustment) return;
        try {
            if (adjustment.captureTarget.hasPointerCapture?.(adjustment.pointerId)) {
                adjustment.captureTarget.releasePointerCapture(adjustment.pointerId);
            }
        } catch { /* capture may already be released */ }
    }, []);

    const notifyCropPanel = React.useCallback((regions: CropRegionFrac[], selectedIndex: number) => {
        window.dispatchEvent(new CustomEvent('prynx-crop-selection-change', {
            detail: {
                tabId,
                ownerId: cropOwnerId,
                pageNum: previewFramePage,
                fracs: regions.map((frac) => ({ ...frac })),
                selectedIndex,
            },
        }));
    }, [cropOwnerId, previewFramePage, tabId]);

    const cropDrawing = useCropPointerDrawing({
        enabled: isCropInteractionEnabled,
        containerRef,
        marqueeRef,
        displayWidth,
        displayHeight,
        getCoords: getUnrotatedCoords,
        onStart: () => {
            cancelCropAdjustment();
            dragRef.current.active = false;
        },
        onComplete: (frac) => {
            if (cropSels.length >= 64) return;
            const regions = [...cropSels, frac];
            commitCropSelection({
                ownerId: cropOwnerId,
                pageNum: previewFramePage,
                regions,
                selectedIndex: regions.length - 1,
            });
            window.dispatchEvent(new CustomEvent('prynx-crop-open', {
                detail: {
                    tabId, ownerId: cropOwnerId, totalPages, pageBox: cropPageBox,
                    pageNum: previewFramePage,
                    viewerRotation: rotation || 0,
                    fracs: regions,
                    frac: regions[0],
                },
            }));
        },
    });

    const beginCropAdjust = (event: React.PointerEvent, index: number, mode: CropAdjustMode) => {
        if (!isCropInteractionEnabled || !containerRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        cropDrawing.cancel();
        cancelCropAdjustment();
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(event.clientX, event.clientY, rect);
        const captureTarget = event.currentTarget as HTMLElement;
        try { captureTarget.setPointerCapture?.(event.pointerId); } catch { /* optional API */ }
        cropAdjustRef.current = {
            index,
            mode,
            startX: coords.x,
            startY: coords.y,
            original: cropSels[index],
            latest: cropSels[index],
            historyRecorded: false,
            pointerId: event.pointerId,
            captureTarget,
        };
        setCropSelection((prev) => prev?.ownerId === cropOwnerId
            ? { ...prev, selectedIndex: index }
            : prev);
        notifyCropPanel(cropSels, index);
    };

    useEffect(() => {
        if (!isCropInteractionEnabled) return;
        const onPointerMove = (event: PointerEvent) => {
            const adjustment = cropAdjustRef.current;
            const container = containerRef.current;
            if (!adjustment || !container || displayWidth <= 0 || displayHeight <= 0) return;
            if (event.pointerId !== adjustment.pointerId) return;
            event.preventDefault();
            const rect = container.getBoundingClientRect();
            const coords = getUnrotatedCoords(event.clientX, event.clientY, rect);
            const next = adjustCropRegion(
                adjustment.original,
                adjustment.mode,
                (coords.x - adjustment.startX) / displayWidth,
                (coords.y - adjustment.startY) / displayHeight,
                8 / displayWidth,
                8 / displayHeight,
            );
            adjustment.latest = next;
            const changedFromOriginal = next.x0 !== adjustment.original.x0
                || next.y0 !== adjustment.original.y0
                || next.x1 !== adjustment.original.x1
                || next.y1 !== adjustment.original.y1;
            if (!adjustment.historyRecorded) {
                if (!changedFromOriginal) return;
                adjustment.historyRecorded = true;
                recordCropSelectionSnapshot();
            }
            setCropSelection((prev) => {
                if (!prev || prev.ownerId !== cropOwnerId || !prev.regions[adjustment.index]) return prev;
                const regions = prev.regions.map((region, index) => index === adjustment.index ? next : region);
                return { ...prev, regions, selectedIndex: adjustment.index };
            });
        };
        const finishAdjustment = (event?: PointerEvent) => {
            const adjustment = cropAdjustRef.current;
            if (event && adjustment && event.pointerId !== adjustment.pointerId) return;
            if (adjustment && cropSelsRef.current[adjustment.index]) {
                const regions = cropSelsRef.current.map((region, index) => index === adjustment.index
                    ? adjustment.latest
                    : region);
                notifyCropPanel(regions, adjustment.index);
            }
            cancelCropAdjustment();
        };
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', finishAdjustment);
        window.addEventListener('pointercancel', finishAdjustment);
        window.addEventListener('blur', cancelCropAdjustment);
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', finishAdjustment);
            window.removeEventListener('pointercancel', finishAdjustment);
            window.removeEventListener('blur', cancelCropAdjustment);
            cancelCropAdjustment();
        };
    }, [isCropInteractionEnabled, cropOwnerId, displayWidth, displayHeight, rotation, setCropSelection, recordCropSelectionSnapshot, cancelCropAdjustment, getUnrotatedCoords, notifyCropPanel]);
    // Trả về hộp bao (union) theo px canvas (gốc trên-trái) của các object được
    // chọn, dùng cho overlay transform + neo handle. `scale` = px/point.
    const getEditSelectionBoxPx = (scale: number): { left: number; top: number; width: number; height: number } | null => {
        const sel = editObjects.filter(o => selectedObjectIds.includes(o.id));
        if (sel.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const o of sel) {
            const [x0, y0, x1, y1] = o.bbox; // đã ở hệ top-left (point)
            minX = Math.min(minX, x0); minY = Math.min(minY, y0);
            maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
        }
        return { left: minX * scale, top: minY * scale, width: (maxX - minX) * scale, height: (maxY - minY) * scale };
    };

    // Bắt đầu một thao tác transform (move/resize/rotate) cho object đang chọn.
    // Khử xoay tọa độ chuột để nhất quán với overlay; xóa preview cũ + transform tạm.
    const beginEditInteraction = (e: React.PointerEvent, type: EditInteraction['type'], handle?: EditHandle) => {
        // UIUX (audit 2026-07-27 §C-01) fix-verify: chỉ chuột trái bắt đầu move/resize/rotate
        // (PointerEvent cùng field button) — tránh xung đột middle-pan / context menu.
        if (e.button !== 0) return;
        if (!containerRef.current || !pageDim?.w) return;
        const rect = containerRef.current.getBoundingClientRect();
        // editScale = px màn / POINT (bbox edit ở point). = (displayWidth/px@96) × 96/72.
        const editScale = displayWidth / ((pageDim.w || 595) * 72 / 96);
        const startBox = getEditSelectionBoxPx(editScale);
        if (!startBox) return;
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        // Bắt đầu thao tác mới → hủy ghost-hold/timeout của lần commit trước (nếu có).
        editGhostHoldRef.current = false;
        if (editGhostHideTimerRef.current) {
            clearTimeout(editGhostHideTimerRef.current);
            editGhostHideTimerRef.current = null;
        }
        // Reset transform tạm + ghost về identity rồi hiện ghost (cập nhật style trực
        // tiếp qua window pointermove). KHÔNG setState mỗi frame.
        editLiveTransformRef.current = null;
        if (editGhostRef.current) {
            editGhostRef.current.style.transform = 'none';
            editGhostRef.current.style.transformOrigin = 'center center';
            editGhostRef.current.style.display = 'block';
        }
        setEditInteraction({ type, handle, startX: coords.x, startY: coords.y, startBox });
        // KHÔNG releasePointerCapture — listener window vẫn nhận pointermove/up dù
        // kéo ra ngoài khung (trước đây rời khung = hủy, dễ commit dở / ghost mất).
        e.preventDefault();
        e.stopPropagation();
    };

    // ─── Edit PDF Object: áp op qua EDIT-SESSION in-memory (đường DUY NHẤT) ────
    // Thay cho đường legacy (POST /edit/transform|text|add|delete → ghi file mới →
    // reload cả file). Session áp op trong RAM backend + render VÙNG CLIP → dán overlay
    // ĐÈ lên tile TẠI CHỖ (KHÔNG đổi pdfUrl, KHÔNG reload). Debounce-commit của hook tự
    // ghi đĩa ngầm ~1.5s → onCommit đổi pdfUrl sang tile thật MỘT lần (nền).
    //
    // Trả true nếu áp thành công. Session lỗi/410 → hook đã markFailed + báo lỗi (không
    // fallback). Lỗi op (409/422...) → ném để caller hiển thị thông báo phù hợp.
    const applyOpViaSession = React.useCallback(async (op: EditOp): Promise<SessionOpOutcome | null> => {
        if (!editSession) {
            setEditNotice(t('misc.livePageFrame:phien_chinh_sua_chua_san_sang_hay_mo'));
            setTimeout(() => setEditNotice(null), 6000);
            return null;
        }
        if (!pageDim?.w) return null;
        // Scale render clip: px THIẾT BỊ / point (css px/point × dpr) → ảnh clip đủ nét.
        const cssScale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w));
        const dpr = window.devicePixelRatio || 1;
        setEditBusy(true);
        try {
            const outcome = await editSession.applyOp(op, Math.max(0.5, cssScale * dpr));
            // null = phiên hỏng/410 (hook đã markFailed → onSessionFailed báo lỗi).
            if (!outcome || !outcome.success) return null;

            // KHÔNG lưu overlay ở đây: hook SỞ HỮU `previews` (dạng point) — overlay được
            // render từ `editSession.previews`, quy đổi sang px LÚC RENDER theo zoom hiện
            // tại + lọc theo trang (đúng cả khi zoom/cuộn giữa các op). Xem block overlay.

            // Refetch /edit/objects (session-aware → đọc Live_Document) để khung chọn bám
            // vị trí MỚI + danh sách cập nhật (add/delete). Cache clear để chắc chắn miss.
            // useEditSession phát edit-session-objects-changed để mọi frame đồng bộ một lần.
            return outcome;
        } finally {
            setEditBusy(false);
        }
    }, [displayWidth, editSession, pageDim?.w, setEditBusy, setEditNotice, t]);

    // Khi MOUSE UP: dựng EditOp từ transform tạm rồi áp qua edit-session (1 lần).
    // Đây là ĐIỂM DUY NHẤT gọi backend (KHÔNG gọi khi đang kéo — Yêu cầu 13.2).
    //
    // CHUYỂN TRỤC tọa độ (canvas top-left, y xuống ↔ PDF bottom-left, y lên):
    //  - move : move_objects mặc định coord_space='pdf', nên FE gửi delta ở hệ PDF:
    //           dx giữ nguyên, dy_pdf = -dy_canvas.
    //  - resize: anchor = góc đối diện handle kéo; nhãn nw/ne/sw/se theo VỊ TRÍ NHÌN
    //           THẤY trùng ngữ nghĩa _anchor_point backend ('n'=mép trên) nên gửi thẳng.
    //  - rotate: rotateDeg backend dương = NGƯỢC chiều kim đồng hồ (hệ PDF y lên);
    //           góc đo trên màn (y xuống) dương theo chiều kim đồng hồ → đảo dấu.
    const commitEditTransform = async (lt: EditLiveTransform | null) => {
        if (!lt || !selectionFileId || !pageDim?.w || selectedObjectIds.length === 0) {
            return;
        }
        const transformIds = selectedObjectIds.filter(id => !lockedObjectIds.includes(id));
        if (!transformIds.length) return;
        const scale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w)); // px canvas / POINT
        const page = originalPageNum - 1;       // /edit dùng 0-based
        let op: EditOp | null = null;

        if (lt.kind === 'move') {
            if (Math.abs(lt.dx) < 0.5 && Math.abs(lt.dy) < 0.5) { return; }
            // Guard: scale hỏng / zoom 0 → delta Infinity → chữ bay khỏi trang ("mất").
            if (!Number.isFinite(scale) || scale < 1e-6) {
                console.warn(t('misc.livePageFrame:edit_scale_khong_hop_le_bo_move'), scale);
                return;
            }
            const delta = moveDeltaCanvasToPdf(lt.dx, lt.dy, scale);
            if (!Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) {
                console.warn(t('misc.livePageFrame:edit_delta_khong_hop_le_bo_move'), delta);
                return;
            }
            // Chặn delta quá lớn (kéo nhầm / scale lệch) — tối đa 2× khổ trang.
            const pageW = pageWidthPtFromDim(pageDim.w);
            const pageH = pageHeightPtFromDim(pageDim.h);
            const maxD = Math.max(pageW, pageH) * 2;
            if (Math.abs(delta.dx) > maxD || Math.abs(delta.dy) > maxD) {
                console.warn(t('misc.livePageFrame:edit_delta_qua_lon_bo_move'), delta, { pageW, pageH });
                setEditNotice(t('misc.livePageFrame:do_dich_qua_lon_thu_keo_nhe_hon_hoac'));
                setTimeout(() => setEditNotice(null), 5000);
                hideEditGhost();
                return;
            }
            op = { page, kind: 'move', targetIds: transformIds, delta };
        } else {
            if (lt.kind === 'resize'
                && Math.abs(lt.sx - 1) < 0.002 && Math.abs(lt.sy - 1) < 0.002) return;
            if (lt.kind === 'rotate' && Math.abs(lt.rotateDeg) < 0.5) return;

            const targets = editObjects.filter(obj => transformIds.includes(obj.id));
            const bounds = selectionBounds(targets);
            if (!bounds) return;
            let [x0, y0, x1, y1] = bounds;
            if (lt.kind === 'resize') {
                const nextWidth = (x1 - x0) * lt.sx;
                const nextHeight = (y1 - y0) * lt.sy;
                if (lt.anchor.includes('e')) x0 = x1 - nextWidth;
                else x1 = x0 + nextWidth;
                if (lt.anchor.includes('s')) y0 = y1 - nextHeight;
                else y1 = y0 + nextHeight;
            }
            const [cropX, cropY] = editCropOriginRef.current;
            const matrix = buildPropertyAffine(targets, {
                widthPt: pageWidthPtFromDim(pageDim.w),
                heightPt: pageHeightPtFromDim(pageDim.h),
                cropX,
                cropY,
            }, {
                xMm: ptToMm(x0),
                yMm: ptToMm(y0),
                widthMm: ptToMm(x1 - x0),
                heightMm: ptToMm(y1 - y0),
                rotateDeg: lt.kind === 'rotate' ? lt.rotateDeg : 0,
            });
            if (!matrix) return;
            op = { page, kind: 'affine', targetIds: transformIds, affine: matrix };
        }

        // Giữ selection id qua vòng refetch objects (khung chọn bám vị trí MỚI).
        pendingReselectIdsRef.current = [...transformIds];
        try {
            const outcome = await applyOpViaSession(op);
            if (!outcome) {
                // null = phiên hỏng (hook đã báo lỗi) → bỏ ghost, không kẹt ở chỗ thả.
                hideEditGhost();
                return;
            }
            // Move: cập nhật bbox khung chọn NGAY (canvas point) để không "giật về
            // chỗ cũ" trong lúc chờ /edit/objects. Trước đây hide ghost ngay trong khi
            // editObjects còn bbox cũ → user tưởng kéo chưa ăn, phải kéo lần 2.
            // Resize/rotate: giữ ghost đến khi refetch xong (hideEditGhost trong effect).
            if (lt.kind === 'move') {
                const dxPt = lt.dx / scale;
                const dyPt = lt.dy / scale;
                if (Number.isFinite(dxPt) && Number.isFinite(dyPt)
                    && (Math.abs(dxPt) > 1e-9 || Math.abs(dyPt) > 1e-9)) {
                    const idSet = new Set(transformIds);
                    setEditObjects((prev) => prev.map((obj) => {
                        if (!idSet.has(obj.id)) return obj;
                        const [x0, y0, x1, y1] = obj.bbox;
                        return {
                            ...obj,
                            bbox: [x0 + dxPt, y0 + dyPt, x1 + dxPt, y1 + dyPt],
                        };
                    }));
                }
                hideEditGhost();
            }
        } catch (err: unknown) {
            console.warn(t('misc.livePageFrame:edit_transform_session_that_bai'), err);
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('409') || msg.includes('ánh xạ') || msg.includes('map')) {
                setEditNotice(t('misc.livePageFrame:doi_tuong_qua_phuc_tap_clip_xobject'));
            } else {
                setEditNotice(t('misc.livePageFrame:di_chuyen_that_bai', { msg: msg.slice(0, 120) }));
            }
            setTimeout(() => setEditNotice(null), 7000);
            hideEditGhost(); // Commit lỗi → bỏ ghost giữ (tránh kẹt ở vị trí thả).
        }
    };

    // ─── Edit PDF Object (task 10.3): gửi EditOp qua EDIT-SESSION ─────────────
    // Helper dùng chung cho editText/add/delete: áp op qua `applyOpViaSession`
    // (in-memory, render clip → overlay tại chỗ, KHÔNG reload file). Giữ cảnh báo
    // font-fallback (đọc từ `outcome.opResult.detail`) + map lỗi 409/422 sang thông
    // báo thân thiện. `endpoint` không còn dùng (session lo mọi kind) — giữ signature
    // để tối thiểu thay đổi caller.
    // Arrow-key nudge: preview is updated directly in the DOM. Repeated key events
    // are accumulated and committed as one edit operation after the key is released.
    useEffect(() => {
        if (!isObjectEditMode || isVdpMode || !isActiveFrame || isViewerActive === false) return;

        const flushNudge = async () => {
            const delta = editNudgeDeltaRef.current;
            editNudgeDeltaRef.current = { dx: 0, dy: 0 };
            editNudgeTimerRef.current = null;
            const targetIds = selectedObjectIds.filter(id => !lockedObjectIds.includes(id));
            if (!targetIds.length || (Math.abs(delta.dx) < 1e-9 && Math.abs(delta.dy) < 1e-9)) {
                hideEditGhost();
                return;
            }
            pendingReselectIdsRef.current = [...targetIds];
            editGhostHoldRef.current = true;
            try {
                await applyOpViaSession({
                    page: originalPageNum - 1,
                    kind: 'move',
                    targetIds,
                    delta,
                });
                // Đồng bộ khung chọn ngay (canvas point = PDF dx, đảo y).
                const idSet = new Set(targetIds);
                const dxPt = delta.dx;
                const dyPt = -delta.dy;
                setEditObjects((prev) => prev.map((obj) => {
                    if (!idSet.has(obj.id)) return obj;
                    const [x0, y0, x1, y1] = obj.bbox;
                    return {
                        ...obj,
                        bbox: [x0 + dxPt, y0 + dyPt, x1 + dxPt, y1 + dyPt],
                    };
                }));
            } catch (error) {
                console.warn('Edit nudge failed', error);
            } finally {
                hideEditGhost();
            }
        };

        const scheduleFlush = (delay: number) => {
            if (editNudgeTimerRef.current) clearTimeout(editNudgeTimerRef.current);
            editNudgeTimerRef.current = setTimeout(() => { void flushNudge(); }, delay);
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
            if (editBusy || !selectionFileId || !pageDim?.w || selectedObjectIds.length === 0) return;

            const step = mmToPt(0.1 * (event.shiftKey ? 10 : 1));
            const next = editNudgeDeltaRef.current;
            if (event.key === 'ArrowLeft') next.dx -= step;
            if (event.key === 'ArrowRight') next.dx += step;
            if (event.key === 'ArrowUp') next.dy += step;
            if (event.key === 'ArrowDown') next.dy -= step;
            event.preventDefault();

            const scale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w));
            const ghost = editGhostRef.current;
            if (ghost) {
                ghost.style.transformOrigin = 'center center';
                ghost.style.transform = 'translate(' + (next.dx * scale) + 'px, ' + (-next.dy * scale) + 'px)';
                ghost.style.display = 'block';
            }
            scheduleFlush(150);
        };

        const onKeyUp = (event: KeyboardEvent) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
                && (Math.abs(editNudgeDeltaRef.current.dx) > 0 || Math.abs(editNudgeDeltaRef.current.dy) > 0)) {
                scheduleFlush(45);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            if (editNudgeTimerRef.current) clearTimeout(editNudgeTimerRef.current);
            editNudgeTimerRef.current = null;
            editNudgeDeltaRef.current = { dx: 0, dy: 0 };
        };
    }, [
        isObjectEditMode, isVdpMode, isActiveFrame, selectedObjectIds, lockedObjectIds,
        editBusy, selectionFileId, pageDim?.w, displayWidth,
        originalPageNum, isViewerActive, hideEditGhost, applyOpViaSession,
    ]);
    const sendEditAndPreview = React.useCallback(async (op: EditOp): Promise<boolean> => {
        if (!selectionFileId) return false;
        try {
            const outcome = await applyOpViaSession(op);
            if (!outcome) return false; // phiên hỏng/410 — onSessionFailed đã báo lỗi.
            // Cảnh báo khi KHÔNG giữ được font gốc và người dùng CHƯA chọn font →
            // đã âm thầm dùng font dự phòng (DejaVuSans). detail = serialize op_result.
            const detail = outcome.opResult?.detail;
            const hasFallback = (value: unknown): boolean => typeof value === 'object' && value !== null && 'used_fallback' in value && Boolean((value as { used_fallback?: unknown }).used_fallback);
            const usedFallback = Array.isArray(detail) ? detail.some(hasFallback) : hasFallback(detail);
            if (usedFallback && !editFontPath) {
                setEditNotice(t('misc.livePageFrame:khong_giu_duoc_font_goc_da_dung_font_du'));
                setTimeout(() => setEditNotice(null), 6000);
            }
            return true;
        } catch (err) {
            console.warn(t('misc.livePageFrame:edit_thao_tac_that_bai'), err);
            const msg = err instanceof Error ? err.message : String(err);
            let friendly: string;
            if (/HTTP 422/.test(msg)) {
                // Thiếu glyph (font đã chọn không có ký tự cần) — thường do nội dung
                // gốc đọc không chuẩn hoặc font thiếu dấu tiếng Việt.
                friendly = t('misc.livePageFrame:khong_doi_duoc_font_thieu_glyph')
                    + t('misc.livePageFrame:hay_go_lai_dung_noi_dung_hoac_chon_font');
            } else if (/HTTP 409/.test(msg)) {
                friendly = t('misc.livePageFrame:khong_sua_duoc_khong_xac_dinh_duoc_doi');
            } else {
                friendly = t('misc.livePageFrame:thao_tac_chinh_sua_that_bai_thu_lai');
            }
            setEditNotice(friendly);
            setTimeout(() => setEditNotice(null), 7000);
            return false;
        }
    }, [applyOpViaSession, editFontPath, selectionFileId, t]);
    sendEditAndPreviewRef.current = sendEditAndPreview;

    // Sửa nội dung một cụm text CÓ SẴN (double-click → editor inline). editText KHÔNG
    // cần bbox: backend resolve vị trí/font/cỡ từ object mục tiêu qua Geometry_Reader.
    const commitEditObjectText = async (objId: string, content: string) => {
        if (!selectionFileId || !pageDim?.w || !content.trim()) return;
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'editText',
            targetIds: [objId],
            // font = đường dẫn file font người dùng chọn (nếu có) → backend nhúng font đó.
            text: { content, font: editFontPath },
        };
        await sendEditAndPreview(op);
    };

    // Thêm cụm text MỚI tại điểm bấm. CONVERT TỌA ĐỘ: draft.{xPt,yPt} ở hệ canvas
    // top-left (point); backend add_text dùng hệ PDF bottom-left → yPDF = pageH - yCanvas.
    // bbox = [x0, pageH - yBottomCanvas, x1, pageH - yTopCanvas].
    const commitAddTextObject = async (content: string, draft: { xPt: number; yPt: number }) => {
        if (!selectionFileId || !pageDim?.w || !pageDim?.h || !content.trim()) return;
        const pageH = pageDim.h * 72 / 96; // px@96 → POINT (draft.{xPt,yPt} đã ở point)
        const hPt = EDIT_ADD_TEXT_SIZE_PT * 1.6;
        const [bx0, by0] = editCropOriginRef.current; // gốc CropBox → quy về PDF NATIVE
        const bbox: BBox = addBboxCanvasToNative(draft.xPt, draft.yPt, EDIT_ADD_TEXT_W_PT, hPt, pageH, bx0, by0);
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'add',
            targetIds: [], text: { content, sizePt: EDIT_ADD_TEXT_SIZE_PT, bbox, font: editFontPath },
        };
        await sendEditAndPreview(op);
    };

    // Thêm ảnh MỚI tại điểm bấm (dataUrl base64). CONVERT TỌA ĐỘ giống add-text:
    // bbox vuông EDIT_ADD_IMAGE_SIZE_PT ở hệ PDF bottom-left (yPDF = pageH - yCanvas).
    const commitAddImageObject = async (dataUrl: string, draft: { xPt: number; yPt: number }) => {
        if (!selectionFileId || !pageDim?.w || !pageDim?.h || !dataUrl) return;
        const pageH = pageDim.h * 72 / 96; // px@96 → POINT (draft.{xPt,yPt} đã ở point)
        const sz = EDIT_ADD_IMAGE_SIZE_PT;
        const [bx0, by0] = editCropOriginRef.current; // gốc CropBox → quy về PDF NATIVE
        const bbox: BBox = addBboxCanvasToNative(draft.xPt, draft.yPt, sz, sz, pageH, bx0, by0);
        const op: EditOp = {
            page: originalPageNum - 1, kind: 'add',
            targetIds: [], image: { dataRef: dataUrl, bbox },
        };
        await sendEditAndPreview(op);
    };

    // Thay nội dung của một image XObject nhưng giữ nguyên q/cm/Q nên vị trí,
    // kích thước và góc của ảnh trên trang không đổi.
    const commitReplaceImageObject = async (objId: string, dataUrl: string) => {
        if (!selectionFileId || !dataUrl) return;
        pendingReselectIdsRef.current = [objId];
        const op: EditOp = {
            page: originalPageNum - 1,
            kind: 'replaceImage',
            targetIds: [objId],
            image: { dataRef: dataUrl },
        };
        await sendEditAndPreview(op);
    };

    const commitImageFrame = async (objId: string, shape: ImageClipShape) => {
        if (!selectionFileId) return;
        pendingReselectIdsRef.current = [objId];
        const success = await sendEditAndPreview({
            page: originalPageNum - 1,
            kind: 'clipImage',
            targetIds: [objId],
            clip: { shape, radius: 0.16 },
        });
        if (success) setShowImageFrameMenu(false);
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        // UIUX (audit 2026-07-27 §C-01) fix-verify: chỉ chuột trái — chuột giữa dành cho
        // middle-pan của AcrobatViewer, chuột phải cho context menu (tránh giành sự kiện).
        if (e.button !== 0) return;
        if ((!isObjectEditMode && !isVdpMode && !isCropMode) || !containerRef.current) return;
        if (isCropMode && cropSelection?.ownerId !== cropOwnerId) {
            setCropSelection({
                ownerId: cropOwnerId, pageNum: previewFramePage,
                regions: [], selectedIndex: -1,
            });
        }
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        dragRef.current = { startX: coords.x, startY: coords.y, active: true };
        // Multi-crop: bắt đầu quét vùng MỚI — giữ các vùng đã chốt (không xóa).
        if (marqueeRef.current) {
            marqueeRef.current.style.display = 'block';
            marqueeRef.current.style.left = `${coords.x}px`;
            marqueeRef.current.style.top = `${coords.y}px`;
            marqueeRef.current.style.width = '0px';
            marqueeRef.current.style.height = '0px';
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!containerRef.current) return;

        // ─── Edit PDF Object (task 10.2): KHI ĐANG KÉO object, listener WINDOW
        // (`onMove` trong useEffect) đã lo TRỌN việc cập nhật ghost (move/resize/
        // rotate) qua DOM ref — nó chỉ active đúng lúc editInteraction bật. Handler
        // React này nếu chạy tiếp sẽ (1) gọi getBoundingClientRect() LẦN NỮA (ép
        // layout thrash 2×/lần di chuột) và (2) bắn setHoveredPdfPosition vào store
        // mỗi 50ms (crosshair vô nghĩa khi kéo) → giật. Return sớm để hết trùng lặp.
        if (editInteraction) return;

        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const curX = coords.x;
        const curY = coords.y;

        // Dispatch hover event for OutputPreview (throttled to ~20fps to avoid React spam)
        if (setHoveredPdfPosition) {
            const now = Date.now();
            if (!dragRef.current.lastHoverTime || now - dragRef.current.lastHoverTime > 50) {
                dragRef.current.lastHoverTime = now;
                setHoveredPdfPosition({
                    pageNum: originalPageNum,
                    ...normalizePageHoverPosition(curX, curY, displayWidth, displayHeight),
                });
            }
        }

        if (vdpInteraction) {
            // VDP move/resize được xử lý qua listener WINDOW (xem useEffect bên dưới)
            // để không bị mất sự kiện khi con trỏ rời khung → mượt + không kẹt.
            return;
        }

        if (!dragRef.current.active || (!isObjectEditMode && !isCropMode)) return;
        const { startX, startY } = dragRef.current;
        // Direct DOM update — no React re-render
        if (marqueeRef.current) {
            marqueeRef.current.style.left = `${Math.min(startX, curX)}px`;
            marqueeRef.current.style.top = `${Math.min(startY, curY)}px`;
            marqueeRef.current.style.width = `${Math.abs(curX - startX)}px`;
            marqueeRef.current.style.height = `${Math.abs(curY - startY)}px`;
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        // UIUX (audit 2026-07-27 §C-01) fix-verify: chỉ chuột trái (khớp guard handleMouseDown).
        if (e.button !== 0) return;
        // Edit drag kết thúc ở window pointerup (useEffect) — không commit ở đây
        // để tránh double-commit khi vừa pointerup vừa mouseup.
        if (editInteraction) {
            return;
        }
        if (vdpInteraction) {
            setVdpInteraction(null);
            return;
        }
        if (!dragRef.current.active || (!isObjectEditMode && !isVdpMode && !isCropMode) || !containerRef.current) {
            dragRef.current.active = false;
            if (marqueeRef.current) marqueeRef.current.style.display = 'none';
            return;
        }
        
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const curX = coords.x;
        const curY = coords.y;
        const { startX, startY } = dragRef.current;
        
        dragRef.current.active = false;
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
        
        // ─── Crop PDF: chốt thêm 1 vùng (multi) — quét tiếp để thêm vùng ───
        if (isCropMode) {
            const frac = cropDragToFrac(startX, startY, curX, curY, displayWidth, displayHeight);
            if (!frac) return;
            setCropSelection((prev) => {
                const current = prev?.ownerId === cropOwnerId ? prev.regions : [];
                if (current.length >= 64) return prev;
                const regions = [...current, frac];
                return {
                    ownerId: cropOwnerId,
                    pageNum: previewFramePage,
                    regions,
                    selectedIndex: regions.length - 1,
                };
            });
            return;
        }

        // Calculate selection rectangle for object/VDP selection.
        const x1 = Math.min(startX, curX);
        const y1 = Math.min(startY, curY);
        const x2 = Math.max(startX, curX);
        const y2 = Math.max(startY, curY);
        
        // Tiny click = click on empty space => deselect all
        if (x2 - x1 < 5 && y2 - y1 < 5) {
            // Edit PDF Object: bấm vào vùng trống → bỏ chọn (việc chọn object do overlay
            // div xử lý ở onClick — ưu tiên bbox nhỏ nhất nhờ thứ tự xếp chồng DOM).
            if (isObjectEditMode) {
                // task 10.3: nếu đang ở chế độ "đặt object mới" → đặt tại điểm bấm.
                // CONVERT px canvas → point (hệ canvas top-left): pt = px / scale.
                if (editAddMode && !isVdpMode && pageDim?.w) {
                    // editScale = px màn / POINT → draft ra ĐÚNG point cho /edit/add.
                    const editScale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                    const draft = { xPt: curX / editScale, yPt: curY / editScale };
                    if (editAddMode === 'text') {
                        // Mở editor text inline tại điểm bấm → gõ nội dung → commit /edit/add.
                        setEditAddDraft(draft);
                        setEditTextContent('');
                        setEditingTextId(EDIT_ADD_TEXT_ID);
                    } else {
                        // Ảnh: chốt vị trí rồi mở file picker; onChange sẽ gửi /edit/add.
                        setEditAddDraft(draft);
                        editFileInputRef.current?.click();
                    }
                    setEditAddMode(null);
                    return;
                }
                const editScale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim?.w));
                const hit = pickTopmostObjectAtPoint(
                    editObjects,
                    curX / editScale,
                    curY / editScale,
                    [...lockedObjectIds, ...hiddenObjectIds],
                );
                if (!hit) {
                    setSelectedObjectIds(EMPTY_OBJECT_IDS);
                } else if (e.shiftKey) {
                    setSelectedObjectIds(prev => prev.includes(hit.id)
                        ? prev.filter(id => id !== hit.id)
                        : [...prev, hit.id]);
                } else {
                    setSelectedObjectIds([hit.id]);
                }
                return;
            }
            if (isVdpMode) {
                setSelectedVdpFieldIds([]);
                onVdpBoxSelect?.([]);
            }
            return;
        }

        // ─── Edit PDF Object: marquee chọn object từ /edit/objects (task 10.1) ───
        if (isObjectEditMode && !isVdpMode) {
            const pageWidthPt = pageDim?.w || 595;
            // bbox edit ở POINT → dùng editScale (px màn / point), KHÔNG dùng scale chung.
            const editScale = displayWidth / (pageWidthPt * 72 / 96);
            const picked = [...selectedObjectIds];
            editObjects.forEach((obj) => {
                if (lockedObjectIds.includes(obj.id)) return; // object bị khóa: bỏ qua marquee
                const [ox0, oy0, ox1, oy1] = obj.bbox;
                const left = ox0 * editScale, top = oy0 * editScale;
                const right = ox1 * editScale, bottom = oy1 * editScale;
                if (left < x2 && right > x1 && top < y2 && bottom > y1 && !picked.includes(obj.id)) {
                    picked.push(obj.id);
                }
            });
            setSelectedObjectIds(picked);
            return;
        }
    };

    const handleEditDoubleClick = (e: React.MouseEvent) => {
        if (!isObjectEditMode || isVdpMode || !containerRef.current || !pageDim?.w) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-edit-ui]')) return;
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const scale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w));
        const hit = pickTopmostObjectAtPoint(
            editObjects,
            coords.x / scale,
            coords.y / scale,
            [...lockedObjectIds, ...hiddenObjectIds],
        );
        if (hit?.type === 'text') {
            e.preventDefault();
            setSelectedObjectIds([hit.id]);
            openTextEditor(hit);
        }
    };
    // Edit drag: listener WINDOW (giống VDP) — kéo ra ngoài khung vẫn cập nhật ghost
    // và pointerup vẫn commit. Trước đây chỉ onMouseMove/Up trên container + mouseleave
    // HỦY → dễ mất thao tác / ghost biến mất giữa chừng.
    useEffect(() => {
        if (!editInteraction) return;
        const applyMoveVisual = (curX: number, curY: number) => {
            const inter = editInteractionRef.current;
            if (!inter) return;
            const dxPx = curX - inter.startX;
            const dyPx = curY - inter.startY;
            const box = inter.startBox;
            const ghost = editGhostRef.current;
            if (inter.type === 'move') {
                editLiveTransformRef.current = { kind: 'move', dx: dxPx, dy: dyPx };
                if (ghost) {
                    ghost.style.transformOrigin = 'center center';
                    ghost.style.transform = `translate(${dxPx}px, ${dyPx}px)`;
                    ghost.style.display = 'block';
                }
            } else if (inter.type === 'resize') {
                const handle = inter.handle || 'se';
                let newW = box.width, newH = box.height;
                if (handle.includes('e')) newW = box.width + dxPx;
                if (handle.includes('w')) newW = box.width - dxPx;
                if (handle.includes('s')) newH = box.height + dyPx;
                if (handle.includes('n')) newH = box.height - dyPx;
                newW = Math.max(2, newW);
                newH = Math.max(2, newH);
                const sx = newW / box.width;
                const sy = newH / box.height;
                const anchor = EDIT_OPPOSITE_ANCHOR[handle];
                editLiveTransformRef.current = { kind: 'resize', sx, sy, anchor };
                if (ghost) {
                    ghost.style.transformOrigin = EDIT_ANCHOR_ORIGIN[anchor];
                    ghost.style.transform = `scale(${sx}, ${sy})`;
                    ghost.style.display = 'block';
                }
            } else if (inter.type === 'rotate') {
                const cx = box.left + box.width / 2;
                const cy = box.top + box.height / 2;
                const initAng = Math.atan2(-1, 0);
                const curAng = Math.atan2(curY - cy, curX - cx);
                const deg = (curAng - initAng) * 180 / Math.PI;
                // Shift snap không có e ở đây — giữ góc thô; Shift xử lý ở mousemove cũ nếu cần.
                editLiveTransformRef.current = { kind: 'rotate', rotateDeg: deg };
                if (ghost) {
                    ghost.style.transformOrigin = 'center center';
                    ghost.style.transform = `rotate(${deg}deg)`;
                    ghost.style.display = 'block';
                }
            }
        };
        const onMove = (e: PointerEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
            applyMoveVisual(coords.x, coords.y);
        };
        const onUp = () => {
            const lt = editLiveTransformRef.current;
            setEditInteraction(null);
            if (lt) {
                editGhostHoldRef.current = true;
                if (editGhostHideTimerRef.current) clearTimeout(editGhostHideTimerRef.current);
                editGhostHideTimerRef.current = setTimeout(() => hideEditGhost(), 4000);
            } else {
                hideEditGhost();
            }
            editLiveTransformRef.current = null;
            void commitEditTransform(lt);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editInteraction]);

    const handleMouseLeave = () => {
        // UIUX (audit 2026-07-27 §C-03) fix-verify: chuột rời trang → xoá toạ độ X/Y trên
        // StatusBar (chỉ clear khi KHÔNG có tương tác kéo — kéo dùng listener window nên giữ).
        if (!dragRef.current.active && !editInteraction && !vdpInteraction) setHoveredPdfPosition?.(null);
        dragRef.current.active = false;
        // KHÔNG huỷ editInteraction / vdpInteraction khi rời khung: listener window
        // quản lý pointerup → kéo ra ngoài vẫn commit được (tránh "kéo chữ bị mất").
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
    };
    //#endregion

    // Trang trắng placeholder: kiểm tra SAU khi mọi hook đã chạy (xem ghi chú phía trên).
    if (originalPageNum === -1) {
        return (
            <div className="bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden">
                <div style={{ width: actualWidth100 * zoom, height: actualWidth100 * zoom * 1.414 }} className="bg-white flex items-center justify-center">
                    <span className="text-slate-200 text-3xl font-bold tracking-[0.5em] -rotate-45">DOCUMENT BLANK PAGE</span>
                </div>
            </div>
        );
    }

    //#region Render
    return (
        <>
        {/* Inject dynamic fonts for VDP */}
        {isVdpMode && window.__TAURI_INTERNALS__ && vdpFields?.map((field: VdpToolField, idx: number) =>
            field.fontFile && field.fontName ? (
                <style key={`vdp-font-${field.id || idx}`}>{`
                    @font-face {
                        font-family: "${field.fontName}_local";
                        src: url("${localFileUrl(field.fontFile)}");
                    }
                `}</style>
            ) : null
        )}
        <div className="relative shrink-0" style={{ width: outerWidth }}>
        <div 
            ref={containerRef}
            className={`bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden group/pdf-frame ${isCropPanMode ? 'cursor-grab active:cursor-grabbing touch-none select-none' : isCropMode ? 'cursor-crosshair touch-none select-none' : ''}`}
            style={{
                width: outerWidth,
                height: outerHeight,
                left: pagePixelSnap.x || undefined,
                top: pagePixelSnap.y || undefined,
            }}
            onPointerDown={isCropInteractionEnabled ? cropDrawing.onPointerDown : undefined}
            onPointerMove={isCropInteractionEnabled ? cropDrawing.onPointerMove : undefined}
            onPointerUp={isCropInteractionEnabled ? cropDrawing.onPointerUp : undefined}
            onPointerCancel={isCropInteractionEnabled ? cropDrawing.onPointerCancel : undefined}
            onLostPointerCapture={isCropInteractionEnabled ? cropDrawing.onLostPointerCapture : undefined}
            onMouseDown={isCropMode ? undefined : handleMouseDown}
            onMouseMove={isCropMode ? undefined : handleMouseMove}
            onMouseUp={isCropMode ? undefined : handleMouseUp}
            onDoubleClick={handleEditDoubleClick}
            onMouseLeave={isCropMode ? undefined : handleMouseLeave}
        >
            <div ref={pageContentRef} style={{
                position: 'absolute',
                width: displayWidth,
                height: displayHeight,
                left: '50%',
                top: '50%',
                transform: `translate(-50%, -50%) rotate(${rotation || 0}deg)`,
                transformOrigin: 'center center'
            }}>
            {isBlankDoc ? (
                /* Trang trắng mới tạo: kích thước đã biết, không cần render qua engine nào — hiện nền trắng tức thì */
                <div style={{ width: displayWidth, height: displayHeight, background: 'white' }} />
            ) : getTileUrl ? (() => {
                // Surface nền phủ cả trang ở renderZoom đã lượng tử hóa. Trang accurate
                // nằm trọn trong viewport đi thẳng mật độ đích; chỉ footprint tràn khung
                // mới dùng viewport tile để không raster phần ngoài màn hình.
                const S = renderZoom;
                // Với compatibility lane, hybrid gate cũ vẫn chỉ bật khi single-tile bị cap.
                // Với PPE, direct-full-page bên dưới chặn kiến trúc nền thấp DPI + tile phủ sau.
                // Chỉ áp cho PDF; viewportTilePolicy inverse-map đủ 0/90/180/270.
                // CHỈ trang ĐANG XEM (isActiveFrame): log profiling cho thấy mọi trang mounted
                // (Virtuoso giữ ~9 trang) đều render tile sắc dù người dùng chỉ nhìn 1 → 9× công
                // thừa xếp hàng tuần tự. Trang khác giữ nền single-tile là đủ (audit tốc độ).
                const dpr = Number.isFinite(displayDevicePixelRatio) && displayDevicePixelRatio > 0
                    ? displayDevicePixelRatio
                    : 1;
                const scrollViewport = containerRef.current?.closest('.acro-scroll') as HTMLElement | null;
                const fullPageTargetRenderZoom = computeRenderZoom(zoom);
                const directFullPageSurface = shouldUseViewerDirectFullPageSurface(
                    accurateColorPage,
                    fullPageTargetRenderZoom,
                    zoom * dpr,
                    outerWidth,
                    outerHeight,
                    scrollViewport?.clientWidth || window.innerWidth,
                    scrollViewport?.clientHeight || window.innerHeight,
                );
                const fullPageWithinSurfaceBudget = Boolean(isImage)
                    || isViewerFullPageWithinSurfaceBudget(
                        outerWidth,
                        outerHeight,
                        fullPageTargetRenderZoom,
                        zoom * dpr,
                    );
                // Trang accurate vẫn chuyển viewport khi không phù hợp để dựng
                // nguyên surface; mọi pipeline đều chuyển viewport khi bitmap
                // toàn trang vượt ngân sách giải mã của WebView.
                const forceViewport = !fullPageWithinSurfaceBudget
                    || (accurateColorPage && !directFullPageSurface);
                const needsTiling = shouldUseViewerViewportTiles(
                    viewerIsActive,
                    isActiveFrame,
                    isImage,
                    renderZoom,
                    zoom,
                    dpr,
                    accurateColorPage,
                    forceViewport,
                );
                const renderBaseTile = shouldRenderViewerBaseTile(
                    shouldRenderBasePage,
                    accurateColorPage,
                    needsTiling,
                    isActiveFrame,
                    fullPageWithinSurfaceBudget,
                );
                // PERF (audit độ nét 2026-07-28 §R.1): TRẦN zoom cho nền của trang KHÔNG
                // đang xem. Virtuoso giữ ~9 trang mounted và LiveTile gọi _loadTile() ĐỒNG BỘ
                // (cố tình bỏ qua IntersectionObserver để chống màn trắng khi WebView2 bị
                // occluded) → cả 9 trang đều xin render nền ở renderZoom hiện tại. Ở zoom cao
                // mỗi bản có cạnh dài tới 6000px, và MỌI render PDFium trong app đi tuần tự
                // sau RENDER_LOCK → tile sắc của vùng đang nhìn xếp hàng sau 8 bản không ai xem.
                //
                // Trang không active chỉ là ẢNH CHỜ lúc cuộn tới, 2×dpr là quá đủ. Khi trang
                // active đã có tile viewport đúng zoom×dpr, nền cũng chỉ cần chống trắng/chớp;
                // giữ bitmap nền 6000px lúc này vừa bị che vừa chặn scheduler PDFium tuần tự.
                // Cố tình KHÔNG chạm lối gọi _loadTile đồng bộ: đó là bản sửa lỗi màn trắng.
                //
                // PHẠM VI ẢNH HƯỞNG có giới hạn rõ: vì dùng Math.min, trần này chỉ CÓ tác dụng
                // khi renderZoom > 2×dpr, tức zoom > ~200%. Ở mức fit/100% mọi thứ y như trước.
                // Đánh đổi duy nhất: xem 2 trang cạnh nhau ở zoom >200% thì trang không active
                // nét bằng nửa cho tới khi cuộn sang (nó thành active và render lại đủ nét).
                const bgZoom = computeViewerBackgroundZoom(S, dpr, isActiveFrame, needsTiling);
                // COLOR (audit 2026-08-07 §GV.3): cache display/accurate và từng
                // Simulation phải có identity riêng trước khi quyết định stage underlay.
                const displayFileKey = viewerTileFileKey(
                    pdfUrl || nativeFilePath || 'unknown',
                    false,
                    renderDocumentToken,
                    previewRevision,
                );
                const accurateFileKey = viewerTileFileKey(
                    pdfUrl || nativeFilePath || 'unknown',
                    true,
                    renderDocumentToken,
                    previewRevision,
                    accurateColorProfileId,
                    accurateColorIntent,
                    accurateColorProofIdentity,
                );
                const accuratePageCommitKey = `${accurateFileKey}:${originalPageNum}`;
                const hasReadyUnderlayForPage = Boolean(initialPpeFrame)
                    || Boolean(accurateBaseReadyKey?.startsWith(`${accuratePageCommitKey}:`));
                const preferredAccurateBaseZoom = accurateViewerRequestScale(
                    directFullPageSurface
                        ? Math.min(S, fullPageTargetRenderZoom)
                        : computeAccurateViewerBaseZoom(
                            S,
                            zoom,
                            dpr,
                            physicalDisplayScale * dpr,
                    ),
                    accurateDpiAnchor,
                );
                const screenAccurateBaseZoom = accurateViewerRequestScale(
                    zoom * dpr,
                    accurateDpiAnchor,
                );
                const roleAccurateBaseZoom = initialPpeFrame?.renderScale
                    ?? viewerAccurateBaseScaleForRole(
                        preferredAccurateBaseZoom,
                        screenAccurateBaseZoom,
                        isActiveFrame,
                        prefetchPage === true,
                        hasReadyUnderlayForPage,
                    );
                const selectedAccurateBaseZoom = selectViewerAccurateBaseZoom(
                    roleAccurateBaseZoom,
                    outerWidth,
                    outerHeight,
                    zoom * dpr,
                );
                const accurateBaseWithinSurfaceBudget = selectedAccurateBaseZoom !== null;
                const accurateBaseZoom = selectedAccurateBaseZoom ?? roleAccurateBaseZoom;
                const renderAccurateUnderlay = shouldRenderViewerAccurateUnderlay(
                    shouldRenderBasePage,
                    accurateColorPage,
                    needsTiling,
                    accurateBaseWithinSurfaceBudget,
                );
                const renderAccurateBaseTile = shouldRenderViewerAccurateBaseTile(
                    shouldRenderBasePage,
                    accurateColorPage,
                    needsTiling,
                    accurateBaseWithinSurfaceBudget,
                ) || renderAccurateUnderlay;
                const displayBaseReadyKey = `${displayFileKey}:${originalPageNum}:${bgZoom}`;
                const displayBaseReady = baseDisplayReadyKey === displayBaseReadyKey;
                const accurateCommitted = accurateCommittedKey === accuratePageCommitKey;
                const accurateBaseIdentity = `${accuratePageCommitKey}:${accurateBaseZoom}`;
                const accurateBaseReady = accurateBaseReadyKey === accurateBaseIdentity;
                const hasStableAccurateUnderlay = hasReadyUnderlayForPage;
                const keepAccurateBaseMounted = shouldKeepViewerAccurateBaseMounted(
                    accurateColorPage,
                    renderAccurateBaseTile,
                    accurateCommitted,
                    accurateBaseWithinSurfaceBudget,
                );
                const requestAccurateBase = shouldRequestViewerAccurateBase(
                    renderAccurateBaseTile,
                    accurateCommitted,
                    accurateBaseReady,
                    accurateBaseWithinSurfaceBudget,
                );
                const useDisplayBase = shouldUseViewerDisplayLayer(
                    accurateColorPage,
                    accurateCommitted,
                    keepDisplayUntilAccurate,
                );
                const baseRenderOwnerId = viewerBackgroundRenderOwnerId(
                    effectiveRenderOwnerId,
                    pageInstanceId,
                    accurateColorPage,
                    isActiveFrame,
                );
                const matchingFullPageFirstFrame = viewerFirstFrameMatchesTile(
                    initialPpeFrame,
                    originalPageNum,
                    accurateBaseZoom,
                    0,
                    0,
                    0,
                    0,
                    0,
                ) ? initialPpeFrame : undefined;
                return (
                    <div style={{ width: displayWidth, height: displayHeight, position: 'relative' }}>
                        {/* Loading Skeleton */}
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/50 z-0">
                            <div className="flex flex-col items-center opacity-50">
                                <div className="w-8 h-8 border-4 border-slate-300 border-t-slate-500 rounded-full animate-spin mb-2" />
                                {/* UIUX (feedback 2026-07-29): trạng thái tải trang dùng chuỗi ngắn, dễ đọc */}
                                <span className="text-xs font-semibold text-slate-500 tracking-wider">{t('misc.livePageFrame:dang_dung_hinh', 'Loading...')}</span>
                            </div>
                        </div>
                        {initialPpeFrame && !accurateCommitted && (
                            <img
                                src={initialPpeFrame.url}
                                alt=""
                                aria-hidden="true"
                                data-prynx-initial-ppe-frame="true"
                                className="absolute inset-0 z-[9] h-full w-full select-none"
                                draggable={false}
                                style={{
                                    objectFit: 'fill',
                                    imageRendering: VIEWER_RASTER_IMAGE_RENDERING,
                                    pointerEvents: 'none',
                                }}
                            />
                        )}
                        {useDisplayBase && renderBaseTile && (
                            <div className="absolute inset-0 z-10">
                                <LiveTile
                                    // COLOR (feedback 2026-08-09 §RENDER.F8): compatibility lane
                                    // chỉ mount cho trang thường để cache PDFium cũ không thể lóe lại.
                                    fileKey={displayFileKey}
                                    key="full-display"
                                    pageNum={originalPageNum}
                                    pageInstanceId={`${pageInstanceId || `page-${originalPageNum}`}:display-base`}
                                    zoom={bgZoom}
                                    rot={0}
                                    clipX={0}
                                    clipY={0}
                                    clipW={0}
                                    clipH={0}
                                    cssW={Math.ceil(displayWidth)}
                                    cssH={Math.ceil(displayHeight)}
                                    getTileUrl={getTileUrl}
                                    onVisible={handleTileVisibility}
                                    onRenderReady={isActiveFrame ? onFirstPageRenderReady : undefined}
                                    onTileReady={() => setBaseDisplayReadyKey(displayBaseReadyKey)}
                                    renderOwnerId={effectiveRenderOwnerId}
                                    renderPriority={pageRenderPriority}
                                    renderEnabled={renderBaseTile}
                                    showLoadStatus={isActiveFrame && renderBaseTile}
                                    loadLabels={tileLoadLabels}
                                />
                            </div>
                        )}
                        {keepAccurateBaseMounted && (
                            <div className="absolute inset-0 z-[11]">
                                <LiveTile
                                    // UIUX (feedback 2026-08-14 §VIEW.SWAP): giữ một surface PPE
                                    // toàn trang làm underlay; viewport tile vẫn dựng đúng mật độ đích.
                                    fileKey={accurateFileKey}
                                    key="full-accurate"
                                    pageNum={originalPageNum}
                                    pageInstanceId={`${pageInstanceId || `page-${originalPageNum}`}:accurate-base`}
                                    zoom={accurateBaseZoom}
                                    rot={0}
                                    clipX={0}
                                    clipY={0}
                                    clipW={0}
                                    clipH={0}
                                    cssW={Math.ceil(displayWidth)}
                                    cssH={Math.ceil(displayHeight)}
                                    getTileUrl={getTileUrl}
                                    onVisible={handleTileVisibility}
                                    onRenderReady={isActiveFrame ? onFirstPageRenderReady : undefined}
                                    onTileReady={({ scale }: { scale: number }) => {
                                        setAccurateCommittedKey(accuratePageCommitKey);
                                        if (initialPpeFrame) releaseViewerFirstFrame(initialPpeFrame);
                                        if (isViewerTargetScaleReady(scale, accurateBaseZoom)) {
                                            setAccurateBaseReadyKey(accurateBaseIdentity);
                                        }
                                    }}
                                    presentationFadeMs={viewerSurfaceSwapMs(
                                        accurateColorPage,
                                        accurateCommitted ? VIEWPORT_TILE_CROSSFADE_MAX_MS : 0,
                                    )}
                                    renderOwnerId={baseRenderOwnerId}
                                    renderPriority={pageRenderPriority}
                                    renderEnabled={shouldEnableViewerAccurateLayer(
                                        requestAccurateBase,
                                        displayBaseReady,
                                        accurateCommitted,
                                    )}
                                    initialSource={matchingFullPageFirstFrame}
                                    preserveUnderlay={Boolean(initialPpeFrame)}
                                    showLoadStatus={isActiveFrame
                                        && requestAccurateBase
                                        && !needsTiling
                                        && !keepDisplayUntilAccurate}
                                    loadLabels={tileLoadLabels}
                                    accurateOnly
                                    cancelAccurateGroup={cancelAccurateGroup}
                                />
                            </div>
                        )}
                        {shouldMountViewerViewportLayer(
                            needsTiling,
                            accurateColorPage,
                            isActiveFrame,
                            accurateCommitted,
                            accurateBaseReady,
                        ) && (
                            <div className="absolute inset-0 z-[12]">
                                <TileLayer
                                    fileKey={accurateColorPage ? accurateFileKey : displayFileKey}
                                    displayFileKey={displayFileKey}
                                    pageNum={originalPageNum}
                                    pageInstanceId={pageInstanceId}
                                    zoom={zoom}
                                    dpr={dpr}
                                    accurateDpiAnchor={accurateDpiAnchor}
                                    rotation={rotation || 0}
                                    displayWidth={displayWidth}
                                    displayHeight={displayHeight}
                                    containerRef={containerRef}
                                    getTileUrl={getTileUrl}
                                    onVisible={handleTileVisibility}
                                    onRenderReady={isActiveFrame ? onFirstPageRenderReady : undefined}
                                    onAccurateCommitted={() => {
                                        setAccurateCommittedKey(accuratePageCommitKey);
                                        if (initialPpeFrame) releaseViewerFirstFrame(initialPpeFrame);
                                    }}
                                    renderOwnerId={effectiveRenderOwnerId}
                                    accurateColor={accurateColorPage}
                                    accurateCommitted={accurateCommitted}
                                    waitForAccurateBase={requestAccurateBase
                                        && !needsTiling
                                        && !accurateCommitted}
                                    keepDisplayUntilAccurate={keepDisplayUntilAccurate}
                                    renderEnabled={needsTiling}
                                    cancelAccurateGroup={cancelAccurateGroup}
                                    initialPpeFrame={initialPpeFrame}
                                    stableUnderlayReady={accurateColorPage
                                        ? hasStableAccurateUnderlay
                                        : displayBaseReady}
                                />
                            </div>
                        )}
                    </div>
                );
            })() : (
                <Page
                    className="gpu-zoom-page block max-w-none origin-top-left"
                    pageNumber={originalPageNum}
                    width={renderWidth}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                />
            )}

             {/* Keep the expensive text DOM mounted while Crop is active. The shield
                 below receives crop gestures, avoiding thousands of line unmounts and
                 layout measurements whenever the mode is toggled. */}
            {getTileUrl && textBlocks && !isObjectEditMode && !isVdpMode && (
                <SelectableTextLayer
                    textBlocks={textBlocks}
                    pageWidthPx={pageDim?.w}
                    displayWidth={displayWidth}
                />
            )}

             {/* Output Preview: Separation plate overlays rendered on the PDF page */}
             {separationPreviewBelongsToFrame && (
                 <div className="absolute inset-0 z-[14] bg-white pointer-events-none">
                     {visibleSeparationPlates.map(plate => (
                         <img 
                             key={plate.name}
                             src={plate.dataUrl}
                             alt={plate.name}
                             data-output-preview-composite={!usesPlateMultiplyBlend(plate) || undefined}
                             className={`absolute inset-0 h-full w-full ${
                                 usesPlateMultiplyBlend(plate) ? 'mix-blend-multiply' : ''
                             }`}
                             style={{ objectFit: 'fill' }}
                         />
                     ))}
                 </div>
             )}

             {/* ICC Soft-Proof Overlay — simulates print output */}
             {outputPreviewBitmapBelongsToFrame && softProofImageUrl && (
                 <img 
                     src={softProofImageUrl}
                     alt="Soft-Proof"
                     className="absolute inset-0 z-[16] pointer-events-none"
                     style={{
                         width: '100%',
                         height: '100%',
                         objectFit: 'fill',
                         opacity: getOutputPreviewOverlayOpacity(
                             'soft-proof',
                             outputPreviewWarningOpacity,
                             outputPreviewOverprintDiagnosticActive,
                         ),
                     }}
                 />
             )}

             {/* Gamut Warning Overlay — highlights out-of-gamut pixels */}
             {outputPreviewBitmapBelongsToFrame && gamutWarningUrl && (
                 <img 
                     src={gamutWarningUrl}
                     alt="Gamut Warning"
                     className="absolute inset-0 z-[17] pointer-events-none"
                     style={{
                         width: '100%',
                         height: '100%',
                         objectFit: 'fill',
                         opacity: getOutputPreviewOverlayOpacity(
                             'gamut-warning',
                             outputPreviewWarningOpacity,
                             outputPreviewOverprintDiagnosticActive,
                         ),
                     }}
                 />
             )}

             {/* TAC Heatmap Overlay — highlights areas exceeding total ink coverage threshold */}
             {outputPreviewBitmapBelongsToFrame && tacHeatmapUrl && (
                 <img 
                     src={tacHeatmapUrl}
                     alt="TAC Heatmap"
                     className="absolute inset-0 z-[18] pointer-events-none"
                     style={{
                         width: '100%',
                         height: '100%',
                         objectFit: 'fill',
                         opacity: getOutputPreviewOverlayOpacity(
                             'tac-heatmap',
                             outputPreviewWarningOpacity,
                             outputPreviewOverprintDiagnosticActive,
                         ),
                     }}
                 />
             )}

             {/* Overprint Preview Overlay — simulates overprint rendering */}
             {outputPreviewBitmapBelongsToFrame && overprintPreviewUrl && (
                 <img 
                     src={overprintPreviewUrl}
                     alt="Overprint Preview"
                     className="absolute inset-0 z-[19] pointer-events-none"
                     style={{
                         width: '100%',
                         height: '100%',
                         objectFit: 'fill',
                         opacity: getOutputPreviewOverlayOpacity(
                             'overprint',
                             outputPreviewWarningOpacity,
                             outputPreviewOverprintDiagnosticActive,
                         ),
                     }}
                 />
             )}
             
             {/* Output Preview: khung PageBox thật của trang, đã quy về hệ Viewer. */}
             <OutputPreviewPageBoxLayer
                 boxes={outputPreviewPageBoxes}
                 viewerPageNum={previewFramePage}
                 show={outputPreviewShowPageBoxes}
             />

             {/* Hidden Layers Preview Overlay — covers page exactly like Illustrator layer toggle */}
             {previewImageUrl && (
                 <img 
                     src={previewImageUrl} 
                     alt=""
                     className="absolute top-0 left-0 z-[17] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* Edit-session preview: dán ĐÈ ảnh vùng clip (hoặc cả trang nếu full) lên
                 tile TẠI CHỖ sau mỗi op — trước khi tile thật (pdfUrl mới) vào. full →
                 phủ cả trang (inset-0); ngược lại định vị theo clipRect (POINT) quy đổi
                 sang px THEO ZOOM HIỆN TẠI (clipRectPdfToCanvas) → overlay tự đúng khi zoom.
                 Nguồn = editSession.previews (hook sở hữu); LỌC theo trang (op.page 0-based
                 == originalPageNum-1) để frame ảo khác không vẽ nhầm overlay trang này.
                 z-[16] < overlay object (z-30) để khung chọn vẫn nổi trên preview. */}
             {isObjectEditMode && pageDim && (editSession?.previews || [])
                 .filter((sp: EditPreviewLayer) => sp.page === originalPageNum - 1)
                 .map((sp: EditPreviewLayer, i: number) => {
                     if (sp.full || !sp.clipRect) {
                         return (
                             <img key={i} src={sp.url} alt="" className="absolute z-[16] pointer-events-none"
                                 style={{ top: 0, left: 0, width: '100%', height: '100%', objectFit: 'fill' }} />
                         );
                     }
                     const cssScale = calcEditScale(displayWidth, pageWidthPtFromDim(pageDim.w));
                     const pageHeightPt = pageHeightPtFromDim(pageDim.h);
                     const [bx0, by0] = editCropOriginRef.current;
                     const r = clipRectPdfToCanvas(sp.clipRect as BBox, pageHeightPt, bx0, by0, cssScale);
                     return (
                         <img key={i} src={sp.url} alt="" className="absolute z-[16] pointer-events-none"
                             style={{ left: r[0], top: r[1], width: r[2] - r[0], height: r[3] - r[1], objectFit: 'fill' }} />
                     );
                 })}

             {(isPreviewLoading || editBusy) && (
                 <div className="absolute top-1.5 left-1.5 z-50 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded-sm backdrop-blur-md flex items-center gap-1.5">
                     <div className="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                     Preview...
                 </div>
             )}
             {bleedView?.show && (
                 <div
                     className="absolute inset-0 pointer-events-none z-[60]"
                     style={{
                         borderWidth: `${bleedView.mm * (96 / 25.4) * zoom}px`,
                         borderColor: 'rgba(239, 68, 68, 0.4)',
                         borderStyle: 'solid',
                         boxSizing: 'border-box'
                     }}
                 >
                     {/* UIUX (audit 2026-07-27 §C-06): nhãn cho biết viền đỏ là vùng bleed + giá trị mm.
                         Chỉ hiện khi zoom đủ lớn (viền dày ≥ ~5px) để không lấn trang lúc thu nhỏ.
                         Cùng RGB đỏ overlay, alpha đậm hơn cho chữ trắng 9px đọc được. */}
                     {bleedView.mm * (96 / 25.4) * zoom >= 5 && (
                         <span
                             className="absolute top-0 left-0 pointer-events-none text-[9px] leading-none text-white font-semibold px-1 py-0.5 rounded-br-sm"
                             style={{ background: 'rgba(239, 68, 68, 0.75)' }}
                         >
                             Bleed <span className="num">{bleedView.mm}</span> mm
                         </span>
                     )}
                 </div>
             )}
             
             {highlightBoxes && (highlightBoxes as WorkspacePreflightIssue[]).map((box: WorkspacePreflightIssue, idx: number) => {
                 if (!pageDim) return null;
                 
                 // If no bbox, it's a page-level issue (like Transparency or Overprint)
                 if (!box.bbox || box.bbox.length !== 4) {
                     return (
                         <div 
                            key={`page-${idx}`}
                            className="absolute inset-0 z-[70] border-[6px] border-amber-500 bg-amber-500/10 shadow-[inset_0_0_30px_rgba(245,158,11,0.5)] animate-pulse pointer-events-none"
                         />
                     );
                 }

                 // Helper to render a single box
                 const renderBox = (bbox: number[], boxIdx: string | number) => {
                     const [x0, y0, x1, y1] = bbox;
                     const pageWidthPt = pageDim.w;
                     const pageHeightPt = pageDim.h;
                     
                     const left = (x0 / pageWidthPt) * 100;
                     const top = (y0 / pageHeightPt) * 100;
                     const width = ((x1 - x0) / pageWidthPt) * 100;
                     const height = ((y1 - y0) / pageHeightPt) * 100;
                     
                     return (
                         <div 
                             key={`box-${idx}-${boxIdx}`}
                             className="absolute z-[70] border-2 border-red-500 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse pointer-events-none"
                             style={{
                                 left: `${left}%`,
                                 top: `${top}%`,
                                 width: `${width}%`,
                                 height: `${height}%`,
                             }}
                         />
                     );
                 };

                 // Render multiple boxes if available
                 if (box.bboxes && box.bboxes.length > 0) {
                     return box.bboxes.map((b: number[], bIdx: number) => renderBox(b, bIdx));
                 }
                 
                 // Fallback to single box
                 return renderBox(box.bbox, 'single');
             })}

             {/* ─── Edit PDF Object — Selection Overlay (task 10.1) ───────────────
                 Nguồn object: GET /edit/objects (PDFium read-only). Bbox đã convert sang
                 hệ canvas top-left (point) ở effect nạp dữ liệu. Sắp xếp diện tích LỚN→NHỎ
                 để object nhỏ nằm trên cùng → click ưu tiên bbox nhỏ nhất (Yêu cầu 2.1, 2.2).
                 Ctrl+A/Esc xử lý ở keydown effect; overlay vẽ viền quanh object được chọn (2.5). */}
             {isObjectEditMode && isActiveFrame && pageDim && (() => {
                 // scale = px màn / POINT (bbox edit + editAddDraft.{xPt,yPt} đều ở point).
                 const scale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                 return (
                     <>
                         {[...editObjects]
                            .filter(obj => !hiddenObjectIds.includes(obj.id)
                                && (selectedObjectIds.includes(obj.id) || editingTextId === obj.id))
                            .sort((a, b) => {
                             const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
                             const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
                             return areaB - areaA; // lớn nhất trước (dưới cùng), nhỏ nhất sau (trên cùng)
                         }).map((obj) => {
                             const [x0, y0, x1, y1] = obj.bbox;
                             const isSelected = selectedObjectIds.includes(obj.id);
                             const isLocked = lockedObjectIds.includes(obj.id);
                             // Bộ ba RGB (KHÔNG bọc 'rgb()') để dựng được CẢ màu đặc lẫn rgba()
                             // có alpha. Trước đây dùng `${typeColor}20` với typeColor='rgb(...)'
                             // → ra chuỗi 'rgb(...)20' KHÔNG hợp lệ → trình duyệt BỎ QUA nền + shadow,
                             // chỉ còn viền mảnh ở mép bbox (ảnh/vector lớn gần như vô hình + bị
                             // overflow-hidden cắt). Dùng rgba() hợp lệ + RING INSET (vẽ vào trong,
                             // không bị cắt) để MỌI loại object đều hiện highlight rõ.
                             const typeRgb = obj.type === 'text' ? '59,130,246' : obj.type === 'image' ? '168,85,247' : '234,179,8';
                             const typeColor = `rgb(${typeRgb})`;
                             return (
                                 <div
                                     key={obj.id}
                                     data-obj-id={obj.id}
                                     // HOVER thuần CSS (KHÔNG mutate .style → không bao giờ "kẹt style").
                                     // Màu theo loại object truyền qua biến CSS `--obj` (bộ ba RGB), rồi
                                     // class hover Tailwind arbitrary dựng viền + nền nhạt từ biến đó.
                                     // CHỈ áp hover khi KHÔNG chọn & KHÔNG khóa; khi rời chuột CSS tự gỡ.
                                     className={`absolute ${editingTextId === obj.id ? 'pointer-events-auto' : 'pointer-events-none'} transition-colors border border-transparent ${isLocked ? 'cursor-not-allowed' : 'cursor-pointer'} ${isSelected ? 'z-[33]' : 'z-30'} ${(!isSelected && !isLocked) ? 'hover:border-[rgb(var(--obj))] hover:bg-[rgba(var(--obj),0.06)]' : ''}`}
                                     style={{
                                         // Biến CSS cho hover (xem className). vd '59,130,246'.
                                         ['--obj' as string]: typeRgb,
                                         left: x0 * scale, top: y0 * scale,
                                         width: (x1 - x0) * scale, height: (y1 - y0) * scale,
                                         // Object bị KHÓA: CHỈ hiện icon ổ khóa — KHÔNG viền, KHÔNG nền.
                                         // Ép border='none' + backgroundColor='transparent' để chắc chắn
                                         // không còn viền/nền nào sót lại (hover đã do CSS, nhưng giữ ép
                                         // này cho rõ ràng trạng thái khóa).
                                         border: isLocked ? 'none' : undefined,
                                         backgroundColor: isLocked ? 'transparent' : undefined,
                                         // Object đang chọn (và KHÔNG khóa): một viền MẢNH (outline vẽ vào
                                         // trong, không đội kích thước). Báo chọn chính vẫn là HỘP TRANSFORM
                                         // xanh (z-40) + handle.
                                         outline: (isSelected && !isLocked) ? `1.5px solid ${typeColor}` : undefined,
                                         outlineOffset: (isSelected && !isLocked) ? '-1.5px' : undefined,
                                     } as React.CSSProperties}
                                     title={isLocked ? `🔒 ĐÃ KHÓA — ${obj.type.toUpperCase()}: ${obj.id}` : `${obj.type.toUpperCase()}: ${obj.id}`}
                                     onClick={(e) => {
                                         e.stopPropagation();
                                         if (isLocked) return; // object bị khóa: KHÔNG cho chọn
                                         if (e.shiftKey) {
                                             setSelectedObjectIds(prev => prev.includes(obj.id) ? prev.filter(id => id !== obj.id) : [...prev, obj.id]);
                                         } else {
                                             setSelectedObjectIds(prev => (prev.length === 1 && prev[0] === obj.id) ? [] : [obj.id]);
                                         }
                                     }}
                                     onDoubleClick={(e) => {
                                         // task 10.3: double-click object TEXT → mở editor inline.
                                         // Chỉ kích hoạt ở chế độ edit-object (KHÔNG VDP) để TÁI DÙNG
                                         // editingTextId/editTextContent mà không xung đột field VDP.
                                         if (isLocked) return; // object bị khóa: KHÔNG mở editor
                                         if (obj.type === 'text' && !isVdpMode) {
                                             e.stopPropagation();
                                             openTextEditor(obj);
                                         }
                                     }}
                                 >
                                     {/* Dấu hiệu khóa nhỏ ở góc trên-phải để người dùng biết object bị khóa. */}
                                     {isLocked && (
                                         <span
                                             className="absolute top-0 right-0 leading-none px-0.5 bg-slate-700/70 text-white rounded-bl pointer-events-none select-none"
                                             style={{ zIndex: 1 }}
                                         >
                                             <Lock className="w-2.5 h-2.5" />
                                         </span>
                                     )}
                                     {/* Editor text inline cho cụm text CÓ SẴN (8.5). Enter=commit,
                                         Shift+Enter=xuống dòng, Esc/blur rỗng=hủy. */}
                                     {editingTextId === obj.id && obj.type === 'text' && !isVdpMode && (
                                       <>
                                         {/* Thanh chọn FONT — gắn NGAY TRÊN ô editor (luôn thấy dù
                                             zoom/cuộn). Chọn font máy → nhúng đúng tiếng Việt + style. */}
                                         <div
                                             data-edit-ui="1"
                                             className="absolute left-0 z-[60] w-[260px] bg-white rounded shadow-lg border border-slate-300 p-1.5 cursor-default"
                                             style={{ bottom: 'calc(100% + 4px)' }}
                                             onMouseDown={(e) => e.stopPropagation()}
                                             onPointerDown={(e) => e.stopPropagation()}
                                             onClick={(e) => e.stopPropagation()}
                                             onDoubleClick={(e) => e.stopPropagation()}
                                         >
                                             <FontSelector
                                                 value={editFontName}
                                                 fontFile={editFontPath}
                                                 onChange={(name, file) => { setEditFontName(name); setEditFontPath(file); }}
                                             />
                                             <div className="flex items-center gap-1 mt-1">
                                                 <button type="button"
                                                     className="px-2 py-0.5 text-[11px] rounded bg-emerald-600 text-white font-semibold inline-flex items-center gap-1"
                                                     onClick={(e) => {
                                                         e.stopPropagation();
                                                         const c = editTextContent;
                                                         setEditingTextId(null);
                                                         if (c.trim()) void commitEditObjectText(obj.id, c);
                                                     }}
                                                 ><Check className="w-3 h-3" /> {t('misc.livePageFrame:ap_dung')}</button>
                                                 <button type="button"
                                                     className="px-2 py-0.5 text-[11px] rounded border border-slate-300 text-slate-600 inline-flex items-center gap-1"
                                                     onClick={(e) => { e.stopPropagation(); setEditingTextId(null); }}
                                                 ><X className="w-3 h-3" /> {t('misc.livePageFrame:huy')}</button>
                                                 {editFontPath && (
                                                     <button type="button" className="ml-auto text-[10px] text-slate-500 hover:text-rose-600 inline-flex items-center gap-1"
                                                         onClick={(e) => { e.stopPropagation(); setEditFontName(''); setEditFontPath(undefined); }}
                                                     ><RotateCcw className="w-3 h-3" /> {t('misc.livePageFrame:bo_font')}</button>
                                                 )}
                                             </div>
                                         </div>
                                         <textarea
                                             autoFocus
                                             value={editTextContent}
                                             placeholder={t('misc.livePageFrame:nhap_noi_dung')}
                                             onChange={(ev) => setEditTextContent(ev.target.value)}
                                             onBlur={(e) => {
                                                 // Nếu focus chuyển sang thanh FONT (data-edit-ui) thì KHÔNG đóng
                                                 // editor (cho phép chọn font). Chỉ đóng khi bấm ra ngoài hẳn.
                                                 const rt = e.relatedTarget as HTMLElement | null;
                                                 if (rt && rt.closest('[data-edit-ui]')) return;
                                                 const c = editTextContent;
                                                 setEditingTextId(null);
                                                 if (c.trim() && (c !== editOrigContent || !!editFontPath)) void commitEditObjectText(obj.id, c);
                                             }}
                                             onKeyDown={(ev) => {
                                                 if (ev.key === 'Enter' && !ev.shiftKey) {
                                                     ev.preventDefault();
                                                     (ev.currentTarget as HTMLTextAreaElement).blur();
                                                 } else if (ev.key === 'Escape') {
                                                     ev.preventDefault();
                                                     setEditTextContent('');
                                                     setEditingTextId(null);
                                                 }
                                             }}
                                             onClick={(ev) => ev.stopPropagation()}
                                             onMouseDown={(ev) => ev.stopPropagation()}
                                             onPointerDown={(ev) => ev.stopPropagation()}
                                             className="absolute left-0 top-0 z-[55] bg-white border border-emerald-500 outline-none px-1 py-0.5 resize overflow-auto shadow-lg whitespace-pre-wrap"
                                             style={{
                                                 // KHÔNG bó theo bbox (gây "hụt"/cắt chữ): cho khung rộng tối thiểu để
                                                 // thấy & gõ trọn nội dung; cao tự nới theo số dòng (tối thiểu bbox).
                                                 width: `${Math.max((x1 - x0) * scale, 260)}px`,
                                                 minHeight: `${Math.max((y1 - y0) * scale, 28)}px`,
                                                 height: 'auto',
                                                 color: editTextColor ? `rgb(${editTextColor[0]},${editTextColor[1]},${editTextColor[2]})` : '#111',
                                                 fontWeight: /bold|black|heavy|semibold/i.test(editOrigFontName) ? 700 : 'normal',
                                                 lineHeight: 1.2,
                                                 fontSize: `${Math.max(11, (y1 - y0) * scale * 0.7)}px`,
                                                 // Realtime preview: dùng font ĐÃ CHỌN (FontSelector inject @font-face
                                                 // "<name>_local"). Đổi font ở thanh FONT → editor đổi mặt chữ ngay.
                                                 fontFamily: editFontName
                                                     ? `"${editFontName}_local", "${editFontName}", sans-serif`
                                                     : undefined,
                                             }}
                                             rows={Math.max(1, editTextContent.split('\n').length)}
                                         />
                                       </>
                                     )}
                                 </div>
                             );
                         })}
                         {/* Editor text inline cho object MỚI (9.5): hiển thị tại điểm bấm đã
                             chốt (editAddDraft) khi đang ở nhánh thêm-text. */}
                         {editingTextId === EDIT_ADD_TEXT_ID && editAddDraft && !isVdpMode && (
                             <textarea
                                 autoFocus
                                 value={editTextContent}
                                 placeholder={t('misc.livePageFrame:nhap_text_moi')}
                                 onChange={(ev) => setEditTextContent(ev.target.value)}
                                 onBlur={() => {
                                     const c = editTextContent;
                                     const d = editAddDraft;
                                     setEditingTextId(null);
                                     setEditAddDraft(null);
                                     if (c.trim() && d) void commitAddTextObject(c, d);
                                 }}
                                 onKeyDown={(ev) => {
                                     if (ev.key === 'Enter' && !ev.shiftKey) {
                                         ev.preventDefault();
                                         (ev.currentTarget as HTMLTextAreaElement).blur();
                                     } else if (ev.key === 'Escape') {
                                         ev.preventDefault();
                                         setEditTextContent('');
                                         setEditAddDraft(null);
                                         setEditingTextId(null);
                                     }
                                 }}
                                 onClick={(ev) => ev.stopPropagation()}
                                 onMouseDown={(ev) => ev.stopPropagation()}
                                 onPointerDown={(ev) => ev.stopPropagation()}
                                 className="absolute z-[45] bg-white/95 border border-emerald-500 outline-none px-0.5 resize-none overflow-hidden"
                                 style={{
                                     left: editAddDraft.xPt * scale, top: editAddDraft.yPt * scale,
                                     width: EDIT_ADD_TEXT_W_PT * scale, height: EDIT_ADD_TEXT_SIZE_PT * 1.6 * scale,
                                     color: '#111', lineHeight: 1, fontSize: `${EDIT_ADD_TEXT_SIZE_PT * scale}px`,
                                 }}
                             />
                         )}
                     </>
                 );
             })()}

             {/* Edit PDF Object (task 10.3): dòng gợi ý khi đang ở chế độ đặt object.
                 Hai nút +Text/Ảnh ĐÃ CHUYỂN sang panel phải (SelectionLayersPanel) để
                 gọn canvas; đây chỉ còn nhắc "bấm lên trang để đặt". editAddMode nay ở
                 store dùng chung → cú bấm kế tiếp lên BẤT KỲ trang nào đặt object tại đó. */}
             {isObjectEditMode && !isVdpMode && editAddMode && (
                 <div className="absolute top-1 left-1 z-[60] pointer-events-none">
                     <span className="px-1.5 py-0.5 text-[11px] rounded bg-black/70 text-white">
                         {t('misc.livePageFrame:bam_len_trang_de_dat', { what: editAddMode === 'text' ? 'text' : t('misc.livePageFrame:anh') })}
                     </span>
                 </div>
             )}
             {editNotice && createPortal(
                 <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] max-w-md px-4 py-2 rounded-lg bg-amber-600 text-white text-[12px] font-medium shadow-2xl flex items-center gap-3">
                     <span className="flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> {editNotice}</span>
                     <button onClick={() => setEditNotice(null)} className="text-white/90 hover:text-white"><X className="w-4 h-4" /></button>
                 </div>,
                 document.body
             )}
             <input
                 ref={editFileInputRef}
                 type="file"
                 accept="image/*"
                 className="hidden"
                 onChange={(e) => {
                     const file = e.target.files?.[0];
                     const draft = editAddDraft;
                     e.target.value = ''; // reset để chọn lại cùng file vẫn kích hoạt
                     if (!file || !draft) { setEditAddDraft(null); return; }
                     const reader = new FileReader();
                     reader.onload = () => {
                         const dataUrl = typeof reader.result === 'string' ? reader.result : '';
                         setEditAddDraft(null);
                         if (dataUrl) void commitAddImageObject(dataUrl, draft);
                     };
                     reader.onerror = () => { setEditAddDraft(null); };
                     reader.readAsDataURL(file);
                 }}
             />
             <input
                 ref={editReplaceImageInputRef}
                 type="file"
                 accept="image/*"
                 className="hidden"
                 onChange={(e) => {
                     const file = e.target.files?.[0];
                     const objId = pendingReplaceImageIdRef.current;
                     e.target.value = ''; // cho phép chọn lại đúng file vừa chọn
                     if (!file || !objId) {
                         pendingReplaceImageIdRef.current = null;
                         return;
                     }
                     const reader = new FileReader();
                     reader.onload = () => {
                         const dataUrl = typeof reader.result === 'string' ? reader.result : '';
                         pendingReplaceImageIdRef.current = null;
                         if (dataUrl) void commitReplaceImageObject(objId, dataUrl);
                     };
                     reader.onerror = () => {
                         pendingReplaceImageIdRef.current = null;
                         setEditNotice(t('misc.livePageFrame:khong_doc_duoc_anh_thay_the'));
                         setTimeout(() => setEditNotice(null), 5000);
                     };
                     reader.readAsDataURL(file);
                 }}
             />

             {/* Edit PDF Object (10.2): hộp transform + handle nw/ne/sw/se (tái dùng
                 từ vdpInteraction) + handle XOAY. Ghost dashed cập nhật theo THỜI GIAN
                 THỰC bằng CSS transform qua editGhostRef trong handleMouseMove — KHÔNG
                 setState mỗi frame (Yêu cầu 13.2); chỉ mouseup mới gửi /edit/transform. */}
             {isObjectEditMode && pageDim && selectedObjectIds.length > 0 && !(editingTextId && editingTextId !== EDIT_ADD_TEXT_ID) && (() => {
                 // scale = px màn / POINT (getEditSelectionBoxPx nhận px/point).
                 const scale = displayWidth / ((pageDim.w || 595) * 72 / 96);
                 const box = getEditSelectionBoxPx(scale);
                 if (!box) return null;
                 const accent = 'rgb(16,185,129)';
                 const accentRgb = '16,185,129';
                 const selectedObject = selectedObjectIds.length === 1
                     ? editObjects.find(o => o.id === selectedObjectIds[0])
                     : undefined;
                 const toolbarWidth = selectedObject?.type === 'image' ? 190 : 154;
                 const toolbarLeft = Math.max(4, Math.min(box.left, displayWidth - toolbarWidth - 4));
                 const toolbarTop = box.top + box.height + 48 <= displayHeight
                     ? box.top + box.height + 8
                     : Math.max(4, box.top - 44);
                 const frameMenuBelow = toolbarTop + 176 <= displayHeight;
                 const frameMenuAlignRight = toolbarLeft + 308 > displayWidth;
                 const toolbarButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded text-slate-100 transition-colors hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40';
                 return (
                     <>
                         {/* Thanh công cụ ngữ cảnh kiểu Acrobat: xuất hiện sát selection,
                             thao tác trực tiếp bằng chuột và không chiếm chỗ trong panel phải. */}
                         <div
                             data-edit-ui="1"
                             className="absolute z-[55] inline-flex items-center gap-1 rounded-md bg-slate-900/95 p-1 shadow-xl ring-1 ring-black/20 backdrop-blur"
                             style={{ left: toolbarLeft, top: toolbarTop }}
                             onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                             onPointerDown={(e) => e.stopPropagation()}
                             onDoubleClick={(e) => e.stopPropagation()}
                         >
                             <button
                                 type="button"
                                 className={toolbarButtonClass}
                                 disabled={editBusy}
                                 title={t('misc.livePageFrame:xoay_90_nguoc_chieu_kim_dong_ho')}
                                 aria-label={t('misc.livePageFrame:xoay_90_nguoc_chieu_kim_dong_ho')}
                                 onClick={() => void commitEditTransform({ kind: 'rotate', rotateDeg: -90 })}
                             >
                                 <RotateCcw className="h-4 w-4" />
                             </button>
                             <button
                                 type="button"
                                 className={toolbarButtonClass}
                                 disabled={editBusy}
                                 title={t('misc.livePageFrame:xoay_90_theo_chieu_kim_dong_ho')}
                                 aria-label={t('misc.livePageFrame:xoay_90_theo_chieu_kim_dong_ho')}
                                 onClick={() => void commitEditTransform({ kind: 'rotate', rotateDeg: 90 })}
                             >
                                 <RotateCw className="h-4 w-4" />
                             </button>
                             {selectedObject?.type === 'text' && (
                                 <button
                                     type="button"
                                     className={toolbarButtonClass}
                                     disabled={editBusy}
                                     title={t('misc.livePageFrame:sua_chu')}
                                     aria-label={t('misc.livePageFrame:sua_chu')}
                                     onClick={() => openTextEditor(selectedObject)}
                                 >
                                     <Type className="h-4 w-4" />
                                 </button>
                             )}
                             {selectedObject?.type === 'image' && (
                                 <button
                                     type="button"
                                     className={`${toolbarButtonClass} ${showImageFrameMenu ? 'bg-white/15' : ''}`}
                                     disabled={editBusy}
                                     title={t('misc.livePageFrame:khung_anh')}
                                     aria-label={t('misc.livePageFrame:khung_anh')}
                                     aria-expanded={showImageFrameMenu}
                                     onClick={() => setShowImageFrameMenu(value => !value)}
                                 >
                                     <Shapes className="h-4 w-4" />
                                 </button>
                             )}
                             {selectedObject?.type === 'image' && (
                                 <button
                                     type="button"
                                     className={toolbarButtonClass}
                                     disabled={editBusy}
                                     title={t('misc.livePageFrame:thay_anh')}
                                     aria-label={t('misc.livePageFrame:thay_anh')}
                                     onClick={() => {
                                         pendingReplaceImageIdRef.current = selectedObject.id;
                                         editReplaceImageInputRef.current?.click();
                                     }}
                                 >
                                     <ImageUp className="h-4 w-4" />
                                 </button>
                             )}
                             <button
                                 type="button"
                                 className={`${toolbarButtonClass} hover:bg-red-500/80`}
                                 disabled={editBusy}
                                 title={t('misc.livePageFrame:xoa_doi_tuong')}
                                 aria-label={t('misc.livePageFrame:xoa_doi_tuong')}
                                 onClick={() => {
                                     const idsToDelete = selectedObjectIds.filter(id => !lockedObjectIds.includes(id));
                                     if (!idsToDelete.length) return;
                                     void sendEditAndPreview({
                                         page: originalPageNum - 1,
                                         kind: 'delete',
                                         targetIds: idsToDelete,
                                     }).then((success) => {
                                         if (success) setSelectedObjectIds(prev => prev.filter(id => !idsToDelete.includes(id)));
                                     });
                                 }}
                             >
                                 <Trash2 className="h-4 w-4" />
                             </button>
                             {selectedObject?.type === 'image' && showImageFrameMenu && (
                                 <div
                                     className={`absolute z-[60] grid w-[300px] grid-cols-5 gap-1 rounded-md bg-slate-900/95 p-2 shadow-2xl ring-1 ring-black/25 ${frameMenuBelow ? 'top-full mt-1' : 'bottom-full mb-1'} ${frameMenuAlignRight ? 'right-0' : 'left-0'}`}
                                     role="menu"
                                     aria-label={t('misc.livePageFrame:khung_anh')}
                                 >
                                     {[
                                         { shape: 'rectangle' as const, label: t('misc.livePageFrame:khung_chu_nhat'), icon: <Square className="h-4 w-4" /> },
                                         { shape: 'rounded' as const, label: t('misc.livePageFrame:khung_bo_goc'), icon: <span className="h-4 w-4 rounded-[5px] border border-current" /> },
                                         { shape: 'circle' as const, label: t('misc.livePageFrame:khung_tron'), icon: <Circle className="h-4 w-4" /> },
                                         { shape: 'ellipse' as const, label: t('misc.livePageFrame:khung_ellipse'), icon: <span className="h-3 w-5 rounded-[50%] border border-current" /> },
                                         { shape: 'triangle' as const, label: t('misc.livePageFrame:khung_tam_giac'), icon: <Triangle className="h-4 w-4" /> },
                                         { shape: 'diamond' as const, label: t('misc.livePageFrame:khung_kim_cuong'), icon: <Diamond className="h-4 w-4" /> },
                                         { shape: 'pentagon' as const, label: t('misc.livePageFrame:khung_ngu_giac'), icon: <Pentagon className="h-4 w-4" /> },
                                         { shape: 'hexagon' as const, label: t('misc.livePageFrame:khung_luc_giac'), icon: <Hexagon className="h-4 w-4" /> },
                                         { shape: 'octagon' as const, label: t('misc.livePageFrame:khung_bat_giac'), icon: <Octagon className="h-4 w-4" /> },
                                         { shape: 'star' as const, label: t('misc.livePageFrame:khung_ngoi_sao'), icon: <Star className="h-4 w-4" /> },
                                         { shape: 'heart' as const, label: t('misc.livePageFrame:khung_trai_tim'), icon: <Heart className="h-4 w-4" /> },
                                         { shape: 'cross' as const, label: t('misc.livePageFrame:khung_dau_cong'), icon: <Plus className="h-4 w-4" /> },
                                         { shape: 'none' as const, label: t('misc.livePageFrame:bo_khung_anh'), icon: <X className="h-4 w-4" /> },
                                     ].map(item => (
                                         <button
                                             key={item.shape}
                                             type="button"
                                             role="menuitem"
                                             disabled={editBusy}
                                             className="flex min-w-0 flex-col items-center gap-1 rounded px-1 py-1.5 text-slate-100 hover:bg-white/15 disabled:opacity-40"
                                             title={item.label}
                                             onClick={() => void commitImageFrame(selectedObject.id, item.shape)}
                                         >
                                             {item.icon}
                                             <span className="w-full truncate text-center text-[9px] leading-tight">{item.label}</span>
                                         </button>
                                     ))}
                                 </div>
                             )}
                         </div>
                         {/* Ghost: xem trước vị trí/kích thước/góc dự kiến (real-time).
                             LUÔN render khi có lựa chọn; handleMouseMove cập nhật trực tiếp
                             style.transform/transformOrigin/display qua editGhostRef (KHÔNG
                             phụ thuộc re-render). Base left/top/width/height TĨNH trong lúc
                             kéo (selection không đổi), lấy từ getEditSelectionBoxPx(scale). */}
                         <div
                             ref={editGhostRef}
                             className="absolute z-[39] pointer-events-none"
                             style={{
                                 left: box.left, top: box.top, width: box.width, height: box.height,
                                 transform: 'none', transformOrigin: 'center center', display: 'none',
                                 border: `2px dashed ${accent}`, backgroundColor: `rgba(${accentRgb},0.08)`,
                             }}
                         />
                         {/* Hộp transform — vùng trong = kéo MOVE. */}
                         <div
                             className="absolute z-40 pointer-events-auto cursor-move"
                             style={{
                                 left: box.left, top: box.top, width: box.width, height: box.height,
                                 border: `1.5px solid ${accent}`, backgroundColor: 'transparent',
                             }}
                             onMouseDown={(e) => e.stopPropagation()}
                             onPointerDown={(e) => { e.stopPropagation(); beginEditInteraction(e, 'move'); }}
                             onDoubleClick={(e) => {
                                 // Double-click trên hộp transform (object đang chọn) → mở
                                 // editor text inline nếu object đó là TEXT (hộp z-40 vốn
                                 // che object div z-30 nên double-click trực tiếp không tới).
                                 if (isVdpMode || selectedObjectIds.length !== 1) return;
                                 const sel = editObjects.find(o => o.id === selectedObjectIds[0]);
                                 if (sel && sel.type === 'text') {
                                     e.stopPropagation();
                                     openTextEditor(sel);
                                 }
                             }}
                         >
                             {/* Resize handles nw/ne/sw/se (tái dùng hệ handle VDP). */}
                             {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
                                 const posCls = handle === 'nw' ? '-left-1.5 -top-1.5 cursor-nw-resize'
                                     : handle === 'ne' ? '-right-1.5 -top-1.5 cursor-ne-resize'
                                     : handle === 'sw' ? '-left-1.5 -bottom-1.5 cursor-sw-resize'
                                     : '-right-1.5 -bottom-1.5 cursor-se-resize';
                                 return (
                                     <div
                                         key={handle}
                                         className={`absolute ${posCls} w-3 h-3 bg-white border-2 rounded-sm shadow-sm hover:scale-150 transition-transform z-[42]`}
                                         style={{ borderColor: accent }}
                                         onMouseDown={(e) => e.stopPropagation()}
                                         onPointerDown={(e) => { e.stopPropagation(); beginEditInteraction(e, 'resize', handle); }}
                                     />
                                 );
                             })}
                             {/* Đường nối tới handle xoay. */}
                             <div
                                 className="absolute left-1/2 -top-7 w-px h-7 -translate-x-1/2 pointer-events-none"
                                 style={{ backgroundColor: accent }}
                             />
                             {/* Handle XOAY — phía trên giữa bbox; tính góc từ tâm → con trỏ. */}
                             <div
                                 className="absolute left-1/2 -top-[2.1rem] w-3 h-3 -translate-x-1/2 bg-white border-2 rounded-full shadow-sm hover:scale-150 transition-transform z-[42] cursor-grab"
                                 style={{ borderColor: accent }}
                                 title="Xoay"
                                 onMouseDown={(e) => e.stopPropagation()}
                                 onPointerDown={(e) => { e.stopPropagation(); beginEditInteraction(e, 'rotate'); }}
                             />
                         </div>
                     </>
                 );
             })()}

             {/* Watermark Live Preview Overlay */}
             {activeDashboardTool === 'watermark' && watermarkPreview && pageDim && (() => {
                 const {
                     watermarkType, watermarkText, batesStart, batesPadding, watermarkImageUrl,
                     layerZIndex, color, fontSize, opacity, rotation, spacing, isRepeated,
                     scaleMode, imageScale, positionXMode, offsetX, positionYMode, offsetY,
                     targetType, rangeStart, rangeEnd, wmWidth = 100, wmHeight = 100
                 } = watermarkPreview;

                 // Check range
                 const pageIdx = originalPageNum - 1;
                 let shouldRender = true;
                 if (targetType === 'even' && (pageIdx + 1) % 2 !== 0) shouldRender = false;
                 if (targetType === 'odd' && (pageIdx + 1) % 2 !== 1) shouldRender = false;
                 if (targetType === 'range' && ((pageIdx + 1) < rangeStart || (pageIdx + 1) > rangeEnd)) shouldRender = false;
                 
                 if (!shouldRender) return null;

                 const dummyText = watermarkText
                    .replace(/\[PAGE\]/g, (pageIdx + 1).toString())
                    .replace(/\[TOTAL\]/g, '99')
                    .replace(/\[DATE\]/g, new Date().toLocaleDateString('vi-VN'))
                    .replace(/\[TIME\]/g, new Date().toLocaleTimeString('vi-VN'))
                    .replace(/\[BATES\]/g, (batesStart + pageIdx).toString().padStart(batesPadding, '0'));

                 // Need to scale physical units (mm, pt) to CSS pixels on screen
                 // Note: AcrobatViewer CSS is heavily zoomed. We rely on displayWidth and pageDim.w
                 // to scale appropriately. pageDim.w is in pixels at 96 DPI.
                 const pageWidthPt = pageDim.w;
                 const pageHeightPt = pageDim.h;
                 const scale = displayWidth / pageWidthPt;
                 
                 let finalScaleX = imageScale;
                 let finalScaleY = imageScale;

                 if (scaleMode === 'fit_page' && wmWidth > 0 && wmHeight > 0) {
                     const rad = rotation * Math.PI / 180;
                     const rotatedWmWidth = Math.abs(wmWidth * Math.cos(rad)) + Math.abs(wmHeight * Math.sin(rad));
                     const rotatedWmHeight = Math.abs(wmWidth * Math.sin(rad)) + Math.abs(wmHeight * Math.cos(rad));
                     const scaleX = pageWidthPt / rotatedWmWidth;
                     const scaleY = pageHeightPt / rotatedWmHeight;
                     finalScaleX = Math.min(scaleX, scaleY);
                     finalScaleY = finalScaleX;
                 } else if (scaleMode === 'stretch' && wmWidth > 0 && wmHeight > 0) {
                     const rad = rotation * Math.PI / 180;
                     const targetWidth = pageWidthPt * Math.abs(Math.cos(rad)) + pageHeightPt * Math.abs(Math.sin(rad));
                     const targetHeight = pageHeightPt * Math.abs(Math.cos(rad)) + pageWidthPt * Math.abs(Math.sin(rad));
                     finalScaleX = targetWidth / wmWidth;
                     finalScaleY = targetHeight / wmHeight;
                 }
                 
                 const scaledWmWidth = wmWidth * finalScaleX * scale;
                 const scaledWmHeight = wmHeight * finalScaleY * scale;
                 
                 const scaledFontSize = fontSize * scale;
                 const scaledSpacing = spacing * scale;
                 
                 // If repeating, we render a grid. If not, absolute position.
                 return (
                     <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: layerZIndex === 'top' ? 40 : 1 }}>
                         {isRepeated ? (
                             <div style={{
                                 position: 'absolute',
                                 width: '300%',
                                 height: '300%',
                                 left: '-100%',
                                 top: '-100%',
                                 display: 'flex',
                                 flexDirection: 'column',
                                 justifyContent: 'center',
                                 alignItems: 'center',
                                 gap: `${scaledSpacing / 2}px`,
                                 transform: `rotate(${rotation}deg)`,
                                 opacity: opacity,
                                 color: color,
                                 fontSize: `${scaledFontSize}px`,
                                 fontWeight: 'bold',
                             }}>
                                 {Array.from({ length: 15 }).map((_, rowIndex) => (
                                     <div key={rowIndex} style={{
                                         display: 'flex',
                                         gap: `${scaledSpacing}px`,
                                         marginLeft: rowIndex % 2 !== 0 ? `${(watermarkType === 'text' ? scaledFontSize : scaledWmWidth) + scaledSpacing / 2}px` : '0px',
                                         justifyContent: 'center'
                                     }}>
                                         {Array.from({ length: 15 }).map((_, colIndex) => {
                                             return watermarkType === 'image' ? (
                                                 watermarkImageUrl ? (
                                                    <img key={colIndex} src={watermarkImageUrl} alt="wm" style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, objectFit: scaleMode === 'stretch' ? 'fill' : 'contain', flexShrink: 0, maxWidth: 'none', maxHeight: 'none' }} />
                                                 ) : (
                                                    <div key={colIndex} style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, border: '2px dashed #94a3b8', background: 'rgba(241, 245, 249, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, maxWidth: 'none', maxHeight: 'none' }}>
                                                        <span className="text-slate-500 font-bold text-[10px]">{t('misc.livePageFrame:phoi_pdf')}</span>
                                                    </div>
                                                 )
                                             ) : (
                                                 <span key={colIndex} className="whitespace-nowrap" style={{ flexShrink: 0 }}>{watermarkType === 'text' ? dummyText : '[PDF File]'}</span>
                                             )
                                         })}
                                     </div>
                                 ))}
                             </div>
                         ) : (
                             <div style={{
                                 position: 'absolute',
                                 left: positionXMode === 'center' ? '50%' : positionXMode === 'left' ? `${(offsetX / 25.4 * 72) * scale}px` : 'auto',
                                 right: positionXMode === 'right' ? `${(offsetX / 25.4 * 72) * scale}px` : 'auto',
                                 top: positionYMode === 'center' ? '50%' : positionYMode === 'top' ? `${(offsetY / 25.4 * 72) * scale}px` : 'auto',
                                 bottom: positionYMode === 'bottom' ? `${(offsetY / 25.4 * 72) * scale}px` : 'auto',
                                 transform: `translate(${positionXMode === 'center' ? '-50%' : '0'}, ${positionYMode === 'center' ? '-50%' : '0'}) rotate(${rotation}deg)`,
                                 marginLeft: positionXMode === 'center' ? `${(offsetX / 25.4 * 72) * scale}px` : '0',
                                 marginTop: positionYMode === 'center' ? `${(offsetY / 25.4 * 72) * scale}px` : '0',
                                 opacity: opacity,
                                 color: color,
                                 fontSize: `${scaledFontSize}px`,
                                 fontWeight: 'bold',
                             }}>
                                 {watermarkType === 'image' ? (
                                     watermarkImageUrl ? (
                                        <img src={watermarkImageUrl} alt="wm" style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, objectFit: scaleMode === 'stretch' ? 'fill' : 'contain', maxWidth: 'none', maxHeight: 'none' }} />
                                     ) : (
                                        <div style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, border: '2px dashed #94a3b8', background: 'rgba(241, 245, 249, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: 'none', maxHeight: 'none' }}>
                                            <span className="text-slate-500 font-bold text-xs whitespace-nowrap">{t('misc.livePageFrame:phoi_pdf')}</span>
                                        </div>
                                     )
                                 ) : (
                                     <span className="whitespace-nowrap">{watermarkType === 'text' ? dummyText : '[PDF File]'}</span>
                                 )}
                             </div>
                         )}
                     </div>
                 );
             })()}

             {/* VDP Tool Overlay */}
             {vdpFields && vdpFields.length > 0 && pageDim && (() => {
                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 return vdpFields.filter((f: VdpToolField) => f.pageNum === originalPageNum).map((field: VdpToolField) => {
                     const x0 = ((field.x ?? 0) / 25.4 * 72) * scale;
                     const y0 = ((field.y ?? 0) / 25.4 * 72) * scale;
                     const w = ((field.width ?? 0) / 25.4 * 72) * scale;
                     const h = ((field.height ?? 0) / 25.4 * 72) * scale;
                     const safeSelectedIds = Array.isArray(selectedVdpFieldIds) ? selectedVdpFieldIds : [];
                     const isSelected = safeSelectedIds.includes(field.id);
                     const isInteracting = vdpInteraction && Array.isArray(vdpInteraction.fieldIds) && vdpInteraction.fieldIds.includes(field.id);
                     return (
                         <div
                             key={field.id}
                             className={`absolute group ${isSelected ? 'z-[60]' : 'z-[55] hover:z-[58]'} border-2 ${isSelected ? 'border-solid border-blue-500 bg-blue-500/10' : 'border-dashed border-transparent group-hover:border-slate-400'} ${isVdpMode ? (isInteracting ? 'pointer-events-auto' : 'pointer-events-auto cursor-move') : 'pointer-events-none'}`}
                             style={{
                                 left: x0, top: y0, width: w, height: h
                             }}
                             onDoubleClick={(e) => {
                                 if (field.type === 'text') {
                                     e.stopPropagation();
                                     setEditingTextId(field.id);
                                     setEditTextContent(field.textContent ?? `{${field.name}}`);
                                 }
                             }}
                             onMouseDown={(e) => e.stopPropagation()}
                             onContextMenu={(e) => {
                                 if (!isVdpMode || isViewerActive === false) return;
                                 e.preventDefault();
                                 e.stopPropagation();
                                 // Chọn field (nếu chưa) rồi mở menu xoay tại vị trí chuột.
                                 if (!safeSelectedIds.includes(field.id)) {
                                     const sel = [field.id];
                                     setSelectedVdpFieldIds(sel);
                                     onVdpBoxSelect?.(sel);
                                 }
                                 setVdpCtxMenu({ x: e.clientX, y: e.clientY, fieldId: field.id });
                             }}
                             onPointerDown={(e) => {
                                 if (editingTextId === field.id) return;
                                 // Nút phải: để onContextMenu xử lý (mở menu xoay), KHÔNG
                                 // khởi động move — nếu không sẽ vừa mở menu vừa kéo nhầm.
                                 // UIUX (audit 2026-07-27 §C-01) fix-verify: chuột giữa cũng bỏ
                                 // qua (dành cho middle-pan) → chỉ chuột trái bắt đầu move.
                                 if (e.button !== 0) return;
                                 e.stopPropagation();
                                 let newSelection = [...safeSelectedIds];
                                 
                                 // Handle Group Selection (if this field belongs to a group, select the whole group)
                                 const groupFields = field.groupId ? vdpFields.filter((f: VdpToolField) => f.groupId === field.groupId).map((f: VdpToolField) => f.id) : [field.id];
                                 
                                 if (e.shiftKey) {
                                     const allSelected = groupFields.every((id: string) => newSelection.includes(id));
                                     if (allSelected) {
                                         newSelection = newSelection.filter((id: string) => !groupFields.includes(id));
                                     } else {
                                         newSelection = [...new Set([...newSelection, ...groupFields])];
                                     }
                                 } else {
                                     if (!newSelection.includes(field.id)) {
                                         newSelection = groupFields;
                                     }
                                 }
                                 
                                 setSelectedVdpFieldIds(newSelection);
                                 onVdpBoxSelect?.(newSelection);
                                 if (!containerRef.current) return;
                                 const rect = containerRef.current.getBoundingClientRect();
                                 
                                 // Record start positions for ALL selected fields (or group fields if not in current selection)
                                 const fieldsToMove = newSelection.includes(field.id) ? newSelection : groupFields;
                                 
                                 if (e.altKey) {
                                     // DUPLICATE LOGIC
                                     const newGroupId = `group_${Date.now()}`;
                                     const hasMultiple = fieldsToMove.length > 1 || field.groupId;
                                     const newFieldsToMove: string[] = [];
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number, fontSize?: number}> = {};
                                     
                                     onVdpFieldsChange?.((prev: VdpToolField[]) => {
                                         const copies: VdpToolField[] = [];
                                         fieldsToMove.forEach((id: string) => {
                                             const f = prev.find((tf: VdpToolField) => tf.id === id);
                                             if (!f) return;
                                             
                                             const copyId = `field_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                                             newFieldsToMove.push(copyId);
                                             startFields[copyId] = { x: f.x ?? 0, y: f.y ?? 0, w: f.width ?? 0, h: f.height ?? 0, fontSize: f.fontSize };
                                             
                                             let newName = f.name;
                                             let newTextContent = f.textContent;
                                             
                                             if (newName) {
                                                 const match = newName.match(/^(.*?)(\d+)$/);
                                                 if (match) {
                                                     const prefix = match[1];
                                                     let maxNum = parseInt(match[2], 10);
                                                     [...prev, ...copies].forEach((pf: VdpToolField) => {
                                                         if (pf && pf.name && pf.name.startsWith(prefix)) {
                                                             const m = pf.name.match(/^(.*?)(\d+)$/);
                                                             if (m && m[1] === prefix) {
                                                                 maxNum = Math.max(maxNum, parseInt(m[2], 10));
                                                             }
                                                         }
                                                     });
                                                     newName = `${prefix}${maxNum + 1}`;
                                                     if (newTextContent === `{${f.name}}`) {
                                                         newTextContent = `{${newName}}`;
                                                     } else if (newTextContent && newTextContent.includes(`{${f.name}}`)) {
                                                         newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
                                                     }
                                                 } else {
                                                     let maxNum = 0;
                                                     [...prev, ...copies].forEach((pf: VdpToolField) => {
                                                         if (pf && pf.name && pf.name.startsWith(`${newName}_`)) {
                                                             const m = pf.name.match(/_(\d+)$/);
                                                             if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
                                                         }
                                                     });
                                                     newName = maxNum > 0 ? `${newName}_${maxNum + 1}` : `${newName}_copy`;
                                                     if (newTextContent === `{${f.name}}`) {
                                                         newTextContent = `{${newName}}`;
                                                     } else if (newTextContent && newTextContent.includes(`{${f.name}}`)) {
                                                         newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
                                                     }
                                                 }
                                             }

                                             copies.push({
                                                 ...f,
                                                 id: copyId,
                                                 groupId: hasMultiple ? newGroupId : undefined,
                                                 name: newName,
                                                 textContent: newTextContent
                                             });
                                         });
                                         
                                         // Schedule interaction start AFTER state updates
                                         setTimeout(() => {
                                             setSelectedVdpFieldIds(newFieldsToMove);
                                            onVdpBoxSelect?.(newFieldsToMove);
                                             setVdpInteraction({
                                                 type: 'move',
                                                 fieldIds: newFieldsToMove,
                                                 startX: e.clientX - rect.left,
                                                 startY: e.clientY - rect.top,
                                                 startFields
                                             });
                                         }, 0);
                                         
                                         return [...prev, ...copies];
                                     });
                                 } else {
                                     // STANDARD MOVE/RESIZE
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number, fontSize?: number}> = {};
                                     fieldsToMove.forEach((id: string) => {
                                         const f = vdpFields.find((tf: VdpToolField) => tf.id === id);
                                         if (f) {
                                             startFields[id] = { x: f.x ?? 0, y: f.y ?? 0, w: f.width ?? 0, h: f.height ?? 0, fontSize: f.fontSize };
                                         }
                                     });
                                     
                                     setVdpInteraction({
                                         type: 'move',
                                         fieldIds: fieldsToMove,
                                         startX: e.clientX - rect.left,
                                         startY: e.clientY - rect.top,
                                         startFields
                                     });
                                 }
                                 
                             }}
                         >
                             <div className={`absolute -top-6 left-0 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow whitespace-nowrap pointer-events-none transition-opacity z-[70] ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                 {(typeof field.fieldName === 'string' ? field.fieldName : field.name) || t('misc.livePageFrame:chua_dat_ten')} ({field.type})
                             </div>
                             
                             {/* Visual Placeholders — xoay nội dung quanh tâm box theo
                                 field.rotation để khớp backend render_one_record. Box (w,h)
                                 là footprint ĐÃ hoán cho 90/270; nội dung trước xoay có kích
                                 thước hoán NGƯỢC lại (rotContentW/H), rồi rotate() quanh tâm. */}
                             {(() => {
                             // Đang sửa text: KHÔNG xoay wrapper (textarea xoay 90° rất khó gõ);
                             // xoay lại ngay khi blur. Các loại field khác luôn xoay theo rotation.
                             const editingThis = editingTextId === field.id;
                             const rot = editingThis ? 0 : ((Number(field.rotation) || 0) % 360 + 360) % 360;
                             const isVert = rot === 90 || rot === 270;
                             const rotStyle: React.CSSProperties = rot === 0 ? {} : (isVert ? {
                                 // Nội dung trước xoay: hoán w/h so với box footprint, căn giữa.
                                 width: h, height: w, left: (w - h) / 2, top: (h - w) / 2,
                                 transform: `rotate(${rot}deg)`, transformOrigin: 'center center',
                             } : {
                                 transform: `rotate(${rot}deg)`, transformOrigin: 'center center',
                             });
                             const isCurved = field.type === 'text' && field.curveMode && field.curveMode !== 'none';
                             return (
                             <div
                                 className={`absolute flex items-center justify-center pointer-events-none ${isCurved ? 'overflow-visible' : 'overflow-hidden'} ${rot === 0 ? 'inset-0' : ''} ${(field.type === 'qrcode' || field.type === 'barcode') ? 'opacity-100' : 'mix-blend-multiply ' + (field.type === 'image' ? 'opacity-50' : 'opacity-80')} ${field.type === 'text' && !isCurved ? 'p-1' : ''}`}
                                 style={rotStyle}
                             >
                                 {(field.type === 'qrcode' || field.type === 'barcode') && (
                                     <VdpPreviewImage field={field as { type: 'qrcode' | 'barcode' }} />
                                 )}
                                 {field.type === 'image' && (
                                     <div 
                                         className="w-full h-full flex items-center justify-center bg-slate-300 dark:bg-zinc-700/80"
                                         style={{
                                             borderRadius: field.imageShape === 'circle' ? '50%' : field.imageShape === 'rounded' ? '16px' : '0',
                                             clipPath: field.imageShape === 'polygon' ? 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' : field.imageShape === 'star' ? 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' : 'none'
                                         }}
                                     >
                                         <svg className="w-full h-full max-w-[50%] max-h-[50%] text-slate-500 opacity-75" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                         </svg>
                                     </div>
                                 )}
                                 {field.type === 'text' && (
                                     editingTextId === field.id ? (
                                         <textarea
                                             autoFocus
                                             value={editTextContent}
                                             onChange={(e) => setEditTextContent(e.target.value)}
                                             onBlur={() => {
                                                 onVdpFieldsChange?.(vdpFields.map((f: VdpToolField) => f.id === field.id ? { ...f, textContent: editTextContent } : f));
                                                 setEditingTextId(null);
                                             }}
                                             onKeyDown={(e) => {
                                                 if (e.key === 'Enter') {
                                                     if (e.shiftKey) {
                                                         // Allow new line
                                                         return;
                                                     }
                                                     e.preventDefault();
                                                     e.currentTarget.blur();
                                                 }
                                             }}
                                             className="w-full h-full bg-transparent border-none outline-none px-1 resize-none overflow-hidden"
                                             style={{ 
                                                 color: field.fontColor || '#1e293b', 
                                                 fontSize: `${(field.fontSize || 10) * scale}px`,
                                                 fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontFile ? `"${field.fontName}_local", sans-serif` : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit')),
                                                 fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                                                 fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                                                 lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                                                 letterSpacing: field.characterSpacing ? `${field.characterSpacing}pt` : 0,
                                                 pointerEvents: 'auto' 
                                             }}
                                             onPointerDown={(e) => e.stopPropagation()}
                                         />
                                     ) : (
                                         field.curveMode && field.curveMode !== 'none' ? (
                                             <VdpCurvedText
                                                 field={field}
                                                 scale={scale}
                                                 text={field.textContent ?? `{${field.name}}`}
                                             />
                                         ) : (
                                             <VdpAutoFitText
                                                 field={field}
                                                 scale={scale}
                                                 text={field.textContent ?? `{${field.name}}`}
                                             />
                                         )
                                     )
                                 )}
                             </div>
                             );
                             })()}

                             {/* Resize Handles: 4 góc + 4 cạnh (giống Illustrator) */}
                             {isSelected && (() => {
                                 const isQr = field.type === 'qrcode';
                                 // QR khoá tỉ lệ vuông → chỉ cho kéo 4 góc. Còn lại đủ 8 điểm.
                                 const handles = isQr
                                     ? (['nw','ne','sw','se'] as const)
                                     : (['nw','n','ne','e','se','s','sw','w'] as const);
                                 const posMap: Record<string, string> = {
                                     nw: '-left-1.5 -top-1.5 cursor-nw-resize',
                                     n:  'left-1/2 -translate-x-1/2 -top-1.5 cursor-n-resize',
                                     ne: '-right-1.5 -top-1.5 cursor-ne-resize',
                                     e:  '-right-1.5 top-1/2 -translate-y-1/2 cursor-e-resize',
                                     se: '-right-1.5 -bottom-1.5 cursor-se-resize',
                                     s:  'left-1/2 -translate-x-1/2 -bottom-1.5 cursor-s-resize',
                                     sw: '-left-1.5 -bottom-1.5 cursor-sw-resize',
                                     w:  '-left-1.5 top-1/2 -translate-y-1/2 cursor-w-resize',
                                 };
                                 const isEdge = (h: string) => h.length === 1;
                                 return handles.map((handle) => (
                                     <div
                                         key={handle}
                                         className={`absolute ${posMap[handle]} w-3 h-3 bg-white border-2 border-blue-500 ${isEdge(handle) ? 'rounded-sm' : 'rounded-full'} shadow-sm hover:scale-150 transition-transform z-[65]`}
                                         onPointerDown={(e) => {
                                             // UIUX (audit 2026-07-27 §C-01) fix-verify: chỉ chuột trái resize.
                                             if (e.button !== 0) return;
                                             e.stopPropagation();
                                             if (!containerRef.current) return;
                                             const rect = containerRef.current.getBoundingClientRect();
                                             setVdpInteraction({
                                                 type: 'resize',
                                                 handle,
                                                 fieldIds: [field.id],
                                                 startX: e.clientX - rect.left,
                                                 startY: e.clientY - rect.top,
                                                 startFields: {
                                                     [field.id]: { x: field.x ?? 0, y: field.y ?? 0, w: field.width ?? 0, h: field.height ?? 0, fontSize: field.fontSize }
                                                 }
                                             });
                                         }}
                                     />
                                 ));
                             })()}
                         </div>
                     );
                 });
             })()}

             {/* Menu chuột phải cho khung VDP: xoay nhanh (dùng chung field.rotation
                 với dropdown "Xoay (độ)" bên panel). Backend chỉ render 0/90/180/270
                 nên chỉ cung cấp các mức đó + xoay tương đối 90° CW/CCW. */}
             {vdpCtxMenu && (() => {
                 const target = vdpFields.find((f: VdpToolField) => f.id === vdpCtxMenu.fieldId);
                 if (!target) return null;
                 const cur = ((Number(target.rotation) || 0) % 360 + 360) % 360;
                 const items: { label: string; rot: number; active?: boolean }[] = [
                     { label: t('misc.livePageFrame:xoay_90_theo_chieu_kim_dong_ho'), rot: (cur + 90) % 360 },
                     { label: t('misc.livePageFrame:xoay_90_nguoc_chieu_kim_dong_ho'), rot: (cur + 270) % 360 },
                 ];
                 const presets = [0, 90, 180, 270];
                 // Portal ra document.body: overlay VDP nằm trong div trang có CSS
                 // `transform` (rotate/scale trang) — position:fixed sẽ neo theo tổ
                 // tiên transform đó chứ KHÔNG phải viewport, khiến menu (định vị bằng
                 // clientX/clientY viewport) văng ra ngoài màn hình. Portal đưa menu ra
                 // body để fixed + toạ độ chuột hoạt động đúng.
                 return createPortal((
                     <>
                     {/* Backdrop bắt click NGOÀI menu để đóng — dùng backdrop thay vì
                         window pointerdown listener để tránh race: cú chuột phải MỞ menu
                         cũng phát pointerdown, listener window sẽ đóng ngay. Backdrop chỉ
                         tồn tại SAU khi menu đã render nên không dính cú mở. */}
                     <div className="fixed inset-0 z-context-menu" onPointerDown={() => setVdpCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setVdpCtxMenu(null); }} />
                     <div
                         className="fixed z-context-menu min-w-[210px] bg-white dark:bg-[#1e1e1e] border border-slate-200 dark:border-white/10 shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-xl flex flex-col gap-0.5"
                         style={{ left: Math.min(vdpCtxMenu.x, window.innerWidth - 220), top: Math.min(vdpCtxMenu.y, window.innerHeight - 260) }}
                         onPointerDown={(e) => e.stopPropagation()}
                         onClick={(e) => e.stopPropagation()}
                         onContextMenu={(e) => e.preventDefault()}
                     >
                         <div className="px-3 py-1 text-[11px] font-bold text-slate-400 uppercase tracking-wider">{t('misc.livePageFrame:xoay_khung')}</div>
                         {items.map((it) => (
                             <button
                                 key={it.label}
                                 onClick={() => { rotateVdpField(vdpCtxMenu.fieldId, it.rot); setVdpCtxMenu(null); }}
                                 className="w-full text-left px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
                             >
                                 {it.label}
                             </button>
                         ))}
                         <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2"></div>
                         <div className="grid grid-cols-4 gap-1 px-1">
                             {presets.map((p) => (
                                 <button
                                     key={p}
                                     onClick={() => { rotateVdpField(vdpCtxMenu.fieldId, p); setVdpCtxMenu(null); }}
                                     className={`px-2 py-1.5 text-[12px] font-semibold rounded-lg outline-none transition-colors ${cur === p ? 'bg-blue-500 text-white' : 'text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/5'}`}
                                 >
                                     {p}°
                                 </button>
                             ))}
                         </div>
                     </div>
                     </>
                 ), document.body);
             })()}



             {/* Preview Stick Text & Numbers Tool */}
             {stickPreviewParams && pageDim && (() => {
                 const { fields, margins, startNumber, increment, padLength, fontName, fontSize, fontColor, rotation, targetType, rangeStart, rangeEnd, numberStyle, mirrorMargins } = stickPreviewParams;
                 
                 // Check if page should be processed
                 let process = false;
                 if (targetType === 'all') process = true;
                 else if (targetType === 'even') process = originalPageNum % 2 === 0;
                 else if (targetType === 'odd') process = originalPageNum % 2 === 1;
                 else if (targetType === 'range') process = originalPageNum >= rangeStart && originalPageNum <= rangeEnd;
                 
                 if (!process) return null;

                 // Calculate number
                 let currentNumber = startNumber;
                 if (targetType === 'all') {
                     currentNumber += (originalPageNum - 1) * increment;
                 } else {
                     let processedCount = 0;
                     for (let i = 1; i < originalPageNum; i++) {
                         if (targetType === 'even' && i % 2 === 0) processedCount++;
                         else if (targetType === 'odd' && i % 2 === 1) processedCount++;
                         else if (targetType === 'range' && i >= rangeStart && i <= rangeEnd) processedCount++;
                     }
                     currentNumber += processedCount * increment;
                 }

                 const numStr = formatPageNumber(currentNumber, numberStyle || 'arabic', padLength);
                 const totalStr = String(viewerNumPages || 0);
                 const todayStr = new Date().toLocaleDateString('vi-VN');

                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 const MM_TO_PT = 2.83465;

                 // Lề gương 2 mặt: hoán đổi trái/phải ở trang chẵn (khớp output).
                 const effM = effectiveLR(margins?.left ?? 0, margins?.right ?? 0, originalPageNum, !!mirrorMargins);

                 const fieldList = [
                     { id: 'topLeft', content: fields?.topLeft, top: margins?.top, bottom: null, left: effM.left, right: null, align: 'flex-start', valalign: 'flex-start' },
                     { id: 'topCenter', content: fields?.topCenter, top: margins?.top, bottom: null, left: 0, right: 0, align: 'center', valalign: 'flex-start' },
                     { id: 'topRight', content: fields?.topRight, top: margins?.top, bottom: null, left: null, right: effM.right, align: 'flex-end', valalign: 'flex-start' },
                     { id: 'bottomLeft', content: fields?.bottomLeft, top: null, bottom: margins?.bottom, left: effM.left, right: null, align: 'flex-start', valalign: 'flex-end' },
                     { id: 'bottomCenter', content: fields?.bottomCenter, top: null, bottom: margins?.bottom, left: 0, right: 0, align: 'center', valalign: 'flex-end' },
                     { id: 'bottomRight', content: fields?.bottomRight, top: null, bottom: margins?.bottom, left: null, right: effM.right, align: 'flex-end', valalign: 'flex-end' }
                 ];

                 return fieldList.map(f => {
                     if (!f.content) return null;
                     const drawString = applyTokens(f.content, numStr, totalStr, todayStr);
                     if (!drawString) return null;

                     const posStyles: React.CSSProperties = { position: 'absolute' };
                     
                     if (f.left !== null && f.right !== null) {
                         posStyles.left = 0;
                         posStyles.width = '100%';
                     } else if (f.left !== null) {
                         posStyles.left = f.left * MM_TO_PT * scale;
                     } else if (f.right !== null) {
                         posStyles.right = f.right * MM_TO_PT * scale;
                     }

                     if (f.top !== null) posStyles.top = f.top * MM_TO_PT * scale;
                     if (f.bottom !== null) posStyles.bottom = f.bottom * MM_TO_PT * scale;

                     posStyles.justifyContent = f.align;
                     posStyles.alignItems = f.valalign;

                     return (
                         <div key={f.id} className="absolute inset-0 pointer-events-none z-[45] flex" style={posStyles}>
                             <div style={{
                                 color: fontColor,
                                 fontSize: `${fontSize * scale}px`,
                                 fontFamily: fontName === 'Times-Roman' ? '"Times New Roman", serif' : fontName === 'Courier' ? 'Courier, monospace' : '"Helvetica Neue", Helvetica, Arial, sans-serif',
                                 transform: `rotate(${rotation}deg)`,
                                 transformOrigin: 'center center',
                                 lineHeight: 1,
                                 whiteSpace: 'nowrap',
                                 textShadow: '0 0 2px rgba(255,255,255,0.8)'
                             }}>
                                 {drawString}
                             </div>
                         </div>
                     );
                 });
             })()}

             {isCropMode && (
                 <div className="absolute inset-0 z-[39]" aria-hidden="true" />
             )}
             {/* Marquee Drag Box — always in DOM, visibility controlled by ref */}
             {(isObjectEditMode || isCropMode) && (
                 <div 
                     ref={marqueeRef}
                     className="absolute border-2 border-blue-500 bg-blue-400/15 z-40 pointer-events-none"
                     style={{ display: 'none', willChange: 'transform, width, height', contain: 'layout paint' }}
                 />
             )}

             {/* Crop PDF — nhiều vùng đã quét (mỗi vùng → 1 trang sau khi áp dụng) */}
             {isCropMode && cropSels.map((frac, i) => {
                 const sel = cropFracToPixels(frac, displayWidth, displayHeight);
                 return (
                     <div
                         key={`crop-${i}`}
                         className={`absolute border-2 bg-orange-400/10 ${isCropPanMode ? 'pointer-events-none' : 'pointer-events-auto'} touch-none ${i === selectedCropIdx ? 'z-50 border-orange-600 ring-1 ring-white/80 cursor-move' : 'z-40 border-orange-500 cursor-pointer'}`}
                         style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
                         onMouseDown={(event) => event.stopPropagation()}
                         onPointerDown={isCropPanMode ? undefined : (event) => beginCropAdjust(event, i, 'move')}
                     >
                         <div className="absolute -top-5 left-0 pointer-events-none text-[10px] font-bold bg-orange-500 text-white px-1.5 py-0.5 rounded shadow">
                             {i + 1}
                         </div>
                         <button
                             type="button"
                             className={`absolute -top-5 right-0 h-5 w-5 rounded bg-red-600 text-white text-[11px] font-bold shadow hover:bg-red-700 ${isCropPanMode ? 'pointer-events-none' : 'pointer-events-auto'}`}
                             aria-label={t('misc.cropDialog:remove_region')}
                             title={t('misc.cropDialog:remove_region')}
                             onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                             onClick={(event) => {
                                 event.stopPropagation();
                                 commitCropSelection((prev) => {
                                     if (!prev || prev.ownerId !== cropOwnerId) return prev;
                                     const regions = prev.regions.filter((_, index) => index !== i);
                                     return regions.length > 0
                                         ? { ...prev, regions, selectedIndex: Math.min(i, regions.length - 1) }
                                         : null;
                                 });
                             }}
                         >×</button>
                         {i === selectedCropIdx && ([
                             ['nw', '0%', '0%', 'nwse-resize'],
                             ['n', '50%', '0%', 'ns-resize'],
                             ['ne', '100%', '0%', 'nesw-resize'],
                             ['e', '100%', '50%', 'ew-resize'],
                             ['se', '100%', '100%', 'nwse-resize'],
                             ['s', '50%', '100%', 'ns-resize'],
                             ['sw', '0%', '100%', 'nesw-resize'],
                             ['w', '0%', '50%', 'ew-resize'],
                         ] as const).map(([mode, left, top, cursor]) => (
                             <button
                                 key={mode}
                                 type="button"
                                 aria-label={`${t('misc.cropDialog:resize_region')} ${mode}`}
                                 className={`absolute h-3 w-3 rounded-full border-2 border-white bg-orange-600 shadow ${isCropPanMode ? 'pointer-events-none' : 'pointer-events-auto'}`}
                                 style={{ left, top, cursor, transform: 'translate(-50%, -50%)' }}
                                 onMouseDown={(event) => event.stopPropagation()}
                                 onPointerDown={isCropPanMode ? undefined : (event) => beginCropAdjust(event, i, mode)}
                             />
                         ))}
                         {i === cropSels.length - 1 && (
                         <div className="absolute -bottom-6 left-0 pointer-events-none text-[9px] font-semibold bg-slate-800/90 text-white px-1.5 py-0.5 rounded shadow whitespace-nowrap max-w-[220px]">
                             {t('misc.cropDialog:crop_keyboard_hint')}
                         </div>
                         )}
                     </div>
                 );
             })}
            </div>
        </div>

        {/* Dimension Overlay — positioned OUTSIDE the page frame */}
        {detectedDimension && (
            <>
                {/* Width Arrow (Below page) */}
                <div className="flex items-center justify-center gap-2 text-blue-500 mt-1.5 pointer-events-none">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                    </svg>
                    <span className="text-xs font-bold whitespace-nowrap bg-white/90 dark:bg-zinc-800/90 px-2 py-0.5 rounded-md shadow-sm border border-blue-200 dark:border-blue-800">
                        W: {(detectedDimension.w * 0.352778).toFixed(1)} mm
                    </span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                </div>
                {/* Height Arrow (Right of page — absolute positioned) */}
                <div className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 text-blue-500 pointer-events-none"
                     style={{ left: '100%', marginLeft: 8 }}>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                    <span className="text-xs font-bold whitespace-nowrap bg-white/90 dark:bg-zinc-800/90 px-2 py-0.5 rounded-md shadow-sm border border-blue-200 dark:border-blue-800"
                          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                        H: {(detectedDimension.h * 0.352778).toFixed(1)} mm
                    </span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                </div>
            </>
        )}
        </div>
        </>
    );
    //#endregion
};
