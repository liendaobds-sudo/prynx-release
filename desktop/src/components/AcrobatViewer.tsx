import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, forwardRef, type ReactNode, type UIEventHandler } from 'react';
import { pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { Virtuoso, type Components, type ListProps, type ScrollerProps, type VirtuosoHandle } from 'react-virtuoso';
import {
    outputPreviewProofIdentity,
    useWorkspaceStore,
    workspaceDocumentIdentity,
} from '../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';
import { useImposerSettingsStore } from './imposition-tools/useImposerSettingsStore';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import { useActiveViewerStore } from '../stores/useActiveViewerStore'; // UIUX (audit menu 2026-07-28 §MB.5)

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LivePageFrame, clearEditObjectsCache } from './workspace/LivePageFrame';
import { shouldPrefetchViewerPage } from './workspace/renderZoomPolicy';
import ExportImageModal, { type ExportImageTab } from './workspace/ExportImageModal';
import { uploadPDF, getApiUrl, authenticatedFetch } from '../lib/api';
import { toast } from './ui/Toast';
import { QuickDeleteModal, ExtractPagesModal, InsertBlankPageModal, AcrobatToolbar, Ruler, GuideLayer, DimensionLayer, findDimensionCandidate, ThumbSidebar, ViewerContextMenu, type Guide, type DimensionMeasurement } from './acrobat';
import type { ThumbPageWorkflowStatus } from './acrobat/ThumbSidebar';
import type { ThumbnailCutlinePreviewItem } from './acrobat/thumbnailCutlinePreview';
import { editPreviewDocumentChanged } from './acrobat/thumbnailEditPreview';
import { StatusBar } from './acrobat/StatusBar'; // UIUX (audit 2026-07-27 §M-1+C-05)
import { CrossFileInsertModal, type CrossFileInsertPending } from './acrobat/CrossFileInsertModal';
import { formatPageSizeMm } from './acrobat/dimensionMath';

import { usePdfLoader, genPageId, genPageIds, flattenRotations } from '../hooks/viewer/usePdfLoader';
import {
    shouldAutoDisableAccurateColor,
    useTileRenderer,
} from '../hooks/viewer/useTileRenderer';
import { useViewerHotkeys } from '../hooks/viewer/useViewerHotkeys';
import { useObjectEditHistory } from '../hooks/useObjectEditHistory';
import { usePhysicalDisplayScale } from '../hooks/viewer/usePhysicalDisplayScale';
import { useViewerZoom } from '../hooks/viewer/useViewerZoom';
import { useVdpHistory } from '../hooks/useVdpHistory';
import { useWorkingPdf } from '../hooks/useWorkingPdf'; // EXPORT (audit 2026-07-30 §IMG-04)
import type { UseEditSession } from '../hooks/useEditSession';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';
import { createViewerVirtualizationContext, matchesPageOverlayTarget, renderPageOverlayForFrame, selectionAfterViewerScroll, shouldCenterVirtuosoList, shouldRemovePagesAfterExtract, type PageOverlayRenderer } from "./AcrobatViewer.helpers";
export type { PageOverlayRenderContext } from './AcrobatViewer.helpers';
import { capturePageViewportAnchor, restorePageViewportAnchor, type PageViewportAnchor } from '../lib/pageViewport';
import {
    resolveActiveViewerIndexAfterRemoval,
    resolveViewerFitPageSizes,
    resolveViewerPageIdentity,
    viewerRowIndexForPosition,
} from '../lib/viewerPageIdentity';
import type { DocumentWindowViewState } from '../lib/documentWindow';
import type { WorkspaceHistoryEntry } from '../lib/workspaceHistory';

const getRenderedPageElement = (scroller: HTMLElement, page: number): HTMLElement | null => {
    const container = scroller.querySelector<HTMLElement>(`#pdf-page-container-${page}`);
    if (!container) return null;
    return (container.lastElementChild as HTMLElement | null) || container;
};


type ViewerFile = File & {
    path?: string;
    isBlank?: boolean;
    __editCommit?: boolean;
};

type ViewerPdfObject = {
    type?: string;
    bbox?: unknown;
    xref?: number | string;
    [key: string]: unknown;
};

type NativeTextBlock = {
    type: 'text';
    bbox: { x: number; y: number; w: number; h: number };
    lines: Array<{
        bbox: { x: number; y: number; w: number; h: number };
        wmode: number;
        dir: { x: number; y: number };
        chars: Array<{
            c: string;
            origin: { x: number; y: number };
            quad: unknown[];
        }>;
    }>;
};

type ViewerVirtuosoHandle = VirtuosoHandle & {
    __thumbClickActive?: boolean;
};

type ViewerRow = {
    type: 'single' | 'two';
    indices: number[];
    pages: number[];
};

type PageToolsPayload = {
    targetType: 'current' | 'all' | 'range' | 'before_first' | 'after_last' | 'after_page';
    range: [number, number];
    copies: number;
    collate: boolean;
    startPage: number;
    endPage: number;
    targetPage: number;
    filter: string;
    degrees: number;
    location: 'after' | 'before';
    target: 'first' | 'last' | 'page';
    count: number;
    deleteAfter: boolean;
};

type PageToolsActionDetail = {
    tabId?: string;
    action?: string;
    payload?: PageToolsPayload;
};

type AutoTrimSide = 'top' | 'right' | 'bottom' | 'left';
const AUTO_TRIM_SIDES: readonly AutoTrimSide[] = ['top', 'right', 'bottom', 'left'];
const AUTO_TRIM_SIDE_LABEL: Record<AutoTrimSide, string> = {
    top: 'Trên',
    right: 'Phải',
    bottom: 'Dưới',
    left: 'Trái',
};

type CrossFileDropDetail = {
    sourcePdfUrl?: string;
    sourcePageNums?: number[];
    targetPdfUrl?: string;
    targetTabId?: string;
    dropIndex?: number | null;
    mode?: 'move' | 'copy';
    sourceIndices?: number[];
    fromMenu?: boolean;
};

type CrossFileSourceRemoveDetail = {
    sourcePdfUrl?: string;
    sourceIndices?: number[];
};

type CrossFilePageOrder = {
    pdfUrl: string;
    order: number[];
    focusIndex: number;
};

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error ?? '');
}
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// Overlay preview OCG: giữ ảnh ĐÃ LOAD cuối cùng, chỉ swap khi ảnh mới decode xong
// (preload ngầm qua state theo onLoad) → hết nháy trắng giữa các lần toggle layer
// (audit F7 perf 2026-07-07). Khi url về null (không ẩn gì) → ẩn overlay ngay.
const OcgPreviewOverlay = ({ url }: { url: string }) => {
    const [shownUrl, setShownUrl] = useState(url);
    return (
        <>
            <img
                src={shownUrl}
                alt="Layer preview"
                className="absolute inset-0 w-full h-full object-contain pointer-events-none z-30"
                style={{ imageRendering: 'auto' }}
            />
            {url !== shownUrl && (
                <img
                    src={url}
                    alt=""
                    aria-hidden
                    className="absolute w-px h-px opacity-0 pointer-events-none"
                    onLoad={() => setShownUrl(url)}
                />
            )}
        </>
    );
};

interface Props {
    /** Tab đang hiển thị? — chỉ tab active mới xử lý lệnh menu (tránh mọi tab mounted cùng phản ứng). */
    isActive?: boolean;
    /** ID tab App (để copy/move trang → chuyển sang tab đích). */
    tabId?: string;
    onViewerDirtyChange?: (isDirty: boolean) => void;
    onExtractPages?: (viewerIndices: number[], deleteAfter: boolean) => Promise<boolean>;
    onObjectDelete?: (objs: ViewerPdfObject[], pageNum: number) => void;
    fetchObjectsForPage?: (pageNum: number) => void;
    onEditCommit?: (outputUrl: string, outputFilename: string, outputFid?: string, outputPath?: string) => void | Promise<void>;
    /** Commit crop through the workspace history/save pipeline. */
    /** Hoàn tác kết quả xử lý PDF khi viewer không còn thao tác trang để hoàn tác. */
    onDocumentUndo?: () => void;
    onVdpBoxCreate?: (box: { x: number; y: number; width: number; height: number; pageNum: number, type?: string }) => void;
    rightPanel?: React.ReactNode;
    /** Nút phụ mép trái toolbar (sau Xuất ảnh), vd Ghi quy trình */
    toolbarExtra?: React.ReactNode;
    /** Nút phụ mép phải toolbar, vd Mở bằng AI/Corel */
    toolbarExtraRight?: React.ReactNode;
    /** Lớp nghiệp vụ bám đúng khung trang; không thay toolbar/zoom/pan của Viewer. */
    pageOverlay?: ReactNode;
    /** Số trang nguồn một-based nhận lớp phủ. */
    pageOverlayPage?: number;
    /** Vị trí một-based trong Viewer; dùng cho working PDF sau reorder/nhân bản. */
    pageOverlayViewerPage?: number;
    /** ID instance ổn định; ưu tiên hơn vị trí để không phủ nhầm bản nhân đôi. */
    pageOverlayInstanceId?: string | null;
    /** Dựng lớp phủ riêng cho từng khung trang đang được Viewer mount. */
    pageOverlayRenderer?: PageOverlayRenderer;
    /** Trạng thái nghiệp vụ theo số trang nguồn, hiển thị trên thumbnail. */
    pageWorkflowStatuses?: Partial<Record<number, ThumbPageWorkflowStatus>>;
    cutlinePreviews?: Partial<Record<number, ThumbnailCutlinePreviewItem>>;
    /** Revision Undo vừa hydrate vốn đã dirty trước tool; giữ cờ này sau khi xóa stack nội bộ. */
    restoredHistoryDirty?: boolean;
    /** PHIÊN chỉnh sửa trong bộ nhớ (spec `pdf-edit-session`) — sở hữu bởi ImpositionTab,
        chuyển tiếp xuống LivePageFrame để Apply_In_Memory + overlay clip (task 11.1). */
    editSession?: UseEditSession;
    /** Viewport của cửa sổ nguồn; chỉ áp một lần sau khi loader đã dựng pageOrder. */
    initialViewState?: DocumentWindowViewState;
    onInitialViewStateApplied?: () => void;
    /** Snapshot Undo generic; chỉ hydrate sau khi loader của đúng File đã sẵn sàng. */
    pendingHistoryEntry?: WorkspaceHistoryEntry | null;
    onHistoryEntryHydrated?: (entry: WorkspaceHistoryEntry) => void;
}


export default function AcrobatViewer({ isActive, tabId, onExtractPages, onObjectDelete, fetchObjectsForPage, onEditCommit, onDocumentUndo, onVdpBoxCreate, rightPanel, toolbarExtra, toolbarExtraRight, pageOverlay, pageOverlayPage = 1, pageOverlayViewerPage, pageOverlayInstanceId, pageOverlayRenderer, pageWorkflowStatuses, cutlinePreviews, restoredHistoryDirty = false, editSession, initialViewState, onInitialViewStateApplied, pendingHistoryEntry, onHistoryEntryHydrated }: Props) {
  const { t } = useTranslation();
    const {
        scale: physicalDisplayScale,
        rawDpi: physicalRawDpi,
        devicePixelRatio: physicalDisplayDpr,
    } = usePhysicalDisplayScale();
    // ═══ Global Store ═══
    const {
        file, setFile, pdfUrl, setPdfUrl, bleedView, highlightedIssue,
        setSelectedObjectIds, selectionFileId,
        isObjectEditMode, isCropMode, undoCropSelection, redoCropSelection,
        vdpFields, setVdpFields,
        setViewerPageOrder, setViewerPageInstanceIds, setViewerPageRotations, setViewerDirty,
        setViewerSelectedPageIndices,
        setIsProcessing, setProcessStatus,
        viewerZoom: zoom, setViewerZoom: setZoom,
        viewerFitMode: fitMode, setViewerFitMode: setFitMode,
        viewerToolMode: toolMode, setViewerToolMode: setToolMode,
        viewerPageDisplayMode: pageDisplayMode, setViewerPageDisplayMode: setPageDisplayMode,
        viewerActivePage: activePage, setViewerActivePage: setActivePage,
        viewerNumPages: numPages, setViewerNumPages: setNumPages,
        viewerThumbMenuOpen: isThumbMenuOpen, setViewerThumbMenuOpen: setIsThumbMenuOpen,
        setHoveredPdfPosition,
        setRightToolMenuMode,
        detectedDimensionsByPage,
        ocgPreviewUrl,
        outputPreviewProfileId: simulationProfileId,
        outputPreviewRenderingIntent: simulationIntent,
        showOutputPreview,
        outputPreviewShowFilter,
        outputPreviewSimulatePaperColor,
        outputPreviewSimulateBlackInk,
        outputPreviewPageBackgroundRgb,
    } = useWorkspaceStore(useShallow(state => ({
        file: state.file, setFile: state.setFile, pdfUrl: state.pdfUrl, setPdfUrl: state.setPdfUrl, bleedView: state.bleedView, highlightedIssue: state.highlightedIssue,
        setSelectedObjectIds: state.setSelectedObjectIds, selectionFileId: state.selectionFileId,
        isObjectEditMode: state.isObjectEditMode,
        isCropMode: state.isCropMode,
        undoCropSelection: state.undoCropSelection,
        redoCropSelection: state.redoCropSelection,
        vdpFields: state.vdpFields,
        // PERF (audit 2026-08-10 §OP.6): các overlay Preflight được LivePageFrame
        // tiêu thụ trực tiếp. Subscribe ở Viewer cha làm toàn bộ trang/toolbar render
        // lại dù component này không hề đọc các giá trị đó.
        ocgPreviewUrl: state.ocgPreviewUrl,
        setVdpFields: state.setVdpFields,
        setViewerPageOrder: state.setViewerPageOrder, setViewerPageInstanceIds: state.setViewerPageInstanceIds, setViewerPageRotations: state.setViewerPageRotations, setViewerDirty: state.setViewerDirty,
        setViewerSelectedPageIndices: state.setViewerSelectedPageIndices,
        setIsProcessing: state.setIsProcessing, setProcessStatus: state.setProcessStatus,
        viewerZoom: state.viewerZoom, setViewerZoom: state.setViewerZoom,
        viewerFitMode: state.viewerFitMode, setViewerFitMode: state.setViewerFitMode,
        viewerToolMode: state.viewerToolMode, setViewerToolMode: state.setViewerToolMode,
        viewerPageDisplayMode: state.viewerPageDisplayMode, setViewerPageDisplayMode: state.setViewerPageDisplayMode,
        viewerActivePage: state.viewerActivePage, setViewerActivePage: state.setViewerActivePage,
        viewerNumPages: state.viewerNumPages, setViewerNumPages: state.setViewerNumPages,
        viewerThumbMenuOpen: state.viewerThumbMenuOpen, setViewerThumbMenuOpen: state.setViewerThumbMenuOpen,
        setHoveredPdfPosition: state.setHoveredPdfPosition,
        setRightToolMenuMode: state.setRightToolMenuMode,
        detectedDimensionsByPage: state.detectedDimensionsByPage,
        outputPreviewProfileId: state.outputPreviewProfileId,
        outputPreviewRenderingIntent: state.outputPreviewRenderingIntent,
        showOutputPreview: state.showOutputPreview,
        outputPreviewShowFilter: state.outputPreviewShowFilter,
        outputPreviewSimulatePaperColor: state.outputPreviewSimulatePaperColor,
        outputPreviewSimulateBlackInk: state.outputPreviewSimulateBlackInk,
        outputPreviewPageBackgroundRgb: state.outputPreviewPageBackgroundRgb,
    })));

    // PREFLIGHT (audit 2026-08-10 §OP.8): lựa chọn Output Preview chỉ tác động
    // khi bảng đang mở. Đóng bảng trả Viewer về contract Page Display mặc định,
    // nhưng vẫn giữ lựa chọn trong store để lần mở sau không mất cấu hình.
    const viewerSimulationProfileId = showOutputPreview ? simulationProfileId : 'fogra39';
    const viewerSimulationIntent = showOutputPreview ? simulationIntent : 'relative';
    const viewerOutputPreviewFilter = showOutputPreview ? outputPreviewShowFilter : 'all';
    const viewerSimulatePaperColor = showOutputPreview && outputPreviewSimulatePaperColor;
    const viewerSimulateBlackInk = showOutputPreview && outputPreviewSimulateBlackInk;
    const viewerPageBackgroundRgb = showOutputPreview ? outputPreviewPageBackgroundRgb : null;
    const viewerOutputPreviewProofIdentity = outputPreviewProofIdentity(
        viewerOutputPreviewFilter,
        viewerSimulatePaperColor,
        viewerSimulateBlackInk,
        viewerPageBackgroundRgb,
    );

    const { activeDashboardTool, setActiveDashboardTool } = useImposerSettingsStore(useShallow(s => ({
        activeDashboardTool: s.activeDashboardTool,
        setActiveDashboardTool: s.setActiveDashboardTool,
    })));

    const isVdpMode = activeDashboardTool === 'datamerge' || activeDashboardTool === 'numbering' || activeDashboardTool === 'cover_numbering' || activeDashboardTool === 'stick_text_number';
    const showRulers = useAppSettingsStore(state => state.showRulers);
    const toggleRulers = useAppSettingsStore(state => state.toggleRulers);
    const measurementUnit = useAppSettingsStore(state => state.measurementUnit);
    const setMeasurementUnit = useAppSettingsStore(state => state.setMeasurementUnit);
    const persistOpenWorkspaceSidebar = useAppSettingsStore(state => state.openWorkspaceSidebar);
    const openWorkspaceSidebar = useCallback(() => {
        setRightToolMenuMode('full');
        persistOpenWorkspaceSidebar();
    }, [persistOpenWorkspaceSidebar, setRightToolMenuMode]);
    // UIUX (audit menu 2026-08-21 §MENU.2): mọi entry point "Trang" dùng chung
    // một transition để tool và panel phải không còn lệch trạng thái nhau.
    const openPageTools = useCallback(() => {
        setActiveDashboardTool('pages');
        openWorkspaceSidebar();
    }, [openWorkspaceSidebar, setActiveDashboardTool]);

    // UIUX (audit 2026-07-27 §C-04): xoay vòng đơn vị đo mm→cm→inch (chuột phải lên
    // thước / click đơn vị ở StatusBar). Toast nhỏ để user thấy đơn vị vừa đổi.
    const cycleMeasurementUnit = useCallback(() => {
        const order: Array<'mm' | 'cm' | 'inch'> = ['mm', 'cm', 'inch'];
        const next = order[(order.indexOf(measurementUnit) + 1) % order.length];
        setMeasurementUnit(next);
        toast.info(t('misc.acrobatViewer:thuoc_don_vi_doi', 'Thước: {{unit}}', { unit: next }));
    }, [measurementUnit, setMeasurementUnit, t]);

    const highlightBoxes = useMemo(() => highlightedIssue ? [highlightedIssue] : undefined, [highlightedIssue]);

    // ── Crop PDF: lấy/đảm bảo file_id + áp kết quả crop vào viewer ──
    const setSelectionFileId = useWorkspaceStore(s => s.setSelectionFileId);
    const setIsCropMode = useWorkspaceStore(s => s.setIsCropMode);
    const setIsObjectEditMode = useWorkspaceStore(s => s.setIsObjectEditMode);
    const getWorkingFile = useWorkingPdf();

    const ensureCropFileId = useCallback(async (signal?: AbortSignal) => {
        // LUÔN upload lại file ĐANG XEM (bytes hiện tại). Reuse selectionFileId cũ
        // dễ trỏ Working_File / edit session TRƯỚC ĐÓ → crop chạy trên file sai
        // (user thấy “cắt lệch / lún vào object” so với vùng quét trên màn).
        if (!file) throw new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho'));
        // PAGEBOX (audit 2026-08-04 §W1.PB5): Auto-trim và mọi consumer của
        // callback này phải dùng trang đã reorder/delete/duplicate/rotate.
        const workingFile = await getWorkingFile(file);
        if (!workingFile) throw new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho'));
        const res = await uploadPDF(workingFile, { signal });
        setSelectionFileId(res.id);
        return res.id;
    }, [file, getWorkingFile, setSelectionFileId, t]);

    const onVdpBoxSelect = () => {}; // Handled directly in LivePageFrame now
    const onVdpFieldsChange = setVdpFields;

    // ── Export ảnh (PNG/JPEG/TIFF) — tương tự Acrobat "Export To > Image" ──
    const [isExportImageOpen, setIsExportImageOpen] = useState(false);
    const [exportFileId, setExportFileId] = useState<string | undefined>(undefined);
    const [exportImageInitialTab, setExportImageInitialTab] = useState<ExportImageTab>('export');
    const [exportFilePath, setExportFilePath] = useState<string | undefined>(undefined);
    // EXPORT (audit 2026-07-30 §IMG-04): getWorkingFile ở trên bake
    // page-order/rotation/delete trước khi xuất.
    const openExportImage = useCallback(async (initialTab: ExportImageTab = 'export') => {
        if (!file) { toast.info(t('misc.acrobatViewer:chua_co_file_de_xuat_anh')); return; }
        try {
            const p = (file as ViewerFile)?.path;
            if (p) { setExportFilePath(p); setExportFileId(undefined); }
            else { const fid = await ensureCropFileId(); setExportFileId(fid); setExportFilePath(undefined); }
            setIsExportImageOpen(true);
            setExportImageInitialTab(initialTab);
        } catch (e) {
            toast.error('Không chuẩn bị được file để xuất ảnh: ' + errorMessage(e));
        }
    }, [file, ensureCropFileId, t]);

    // ── Khử viền dư (Auto-trim excess border) ──
    const [isAutoTrimOpen, setIsAutoTrimOpen] = useState(false);
    const [autoTrimBusy, setAutoTrimBusy] = useState(false);
    const [autoTrimMargin, setAutoTrimMargin] = useState(0);
    const [autoTrimScope, setAutoTrimScope] = useState<'all' | 'current'>('all');
    const [autoTrimSides, setAutoTrimSides] = useState<AutoTrimSide[]>([...AUTO_TRIM_SIDES]);
    const autoTrimPopRef = useRef<HTMLDivElement>(null);

    const toggleAutoTrimSide = useCallback((side: AutoTrimSide) => {
        setAutoTrimSides(previous => previous.includes(side)
            ? previous.filter(value => value !== side)
            : AUTO_TRIM_SIDES.filter(value => value === side || previous.includes(value)));
    }, []);

    // Đóng popover khi click ngoài
    useEffect(() => {
        if (!isAutoTrimOpen) return;
        const handler = (e: MouseEvent) => {
            if (autoTrimPopRef.current && !autoTrimPopRef.current.contains(e.target as Node)) setIsAutoTrimOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isAutoTrimOpen]);

    const handleAutoTrim = useCallback(async () => {
        if (!file) return;
        setAutoTrimBusy(true);
        const loadingId = toast.info(t('misc.acrobatViewer:dang_xu_ly_khu_vien'));
        try {
            const fid = await ensureCropFileId();
            const pages = autoTrimScope === 'current' ? [activePage] : undefined;
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/auto-trim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fid,
                    pages,
                    margin_mm: autoTrimMargin,
                    trim_sides: autoTrimSides,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
                throw new Error(err.detail || 'auto-trim failed');
            }
            const data = await res.json();
            // Truyền download URL server-side cho onEditCommit — nó tự fetch/tạo blob
            const downloadUrl = `${getApiUrl()}/preflight/download/${data.output_filename}`;
            if (onEditCommit) {
                await onEditCommit(downloadUrl, data.output_filename);
            }
            const count = pages ? pages.length : numPages;
            toast.dismiss(loadingId);
            toast.success(t('misc.acrobatViewer:khu_vien_thanh_cong', { count }));
            setIsAutoTrimOpen(false);
        } catch (e) {
            toast.dismiss(loadingId);
            toast.error(t('misc.acrobatViewer:khu_vien_that_bai', { msg: errorMessage(e) }));
        } finally {
            setAutoTrimBusy(false);
        }
    }, [file, ensureCropFileId, autoTrimScope, autoTrimMargin, autoTrimSides, activePage, numPages, onEditCommit, t]);

    // ═══ DOM Refs ═══
    const containerRef = useRef<HTMLDivElement>(null);
    const sidebarRef = useRef<HTMLDivElement>(null);
    const mainVirtuosoRef = useRef<ViewerVirtuosoHandle>(null);
    const internalScrollRef = useRef<HTMLElement | null>(null);
    const geometryActivePageRef = useRef(activePage);
    geometryActivePageRef.current = activePage;
    const pageGeometryAnchorRef = useRef<{ page: number; top: number; left: number } | null>(null);
    const explicitNavRef = useRef(false);
    const pendingPageViewportRef = useRef<{ page: number; anchor: PageViewportAnchor } | null>(null);

    // Undo/Redo cho thao tác trên VDP fields (di chuyển, resize, xóa, tạo...).
    useVdpHistory({ vdpFields, setVdpFields, enabled: isVdpMode, containerRef });

    // ═══ Modal State ═══
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [isInsertModalOpen, setIsInsertModalOpen] = useState(false);
    const [isExtractModalOpen, setIsExtractModalOpen] = useState(false);
    const [extractPagesStrForModal, setExtractPagesStrForModal] = useState('');
    const extractInFlightRef = useRef(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean } | null>(null);
    /** Copy/Move sang file khác — chờ chọn vị trí chèn (đầu/cuối/trước/sau trang N). */
    const [crossFileInsertPending, setCrossFileInsertPending] = useState<CrossFileInsertPending | null>(null);

    // ═══ Guide State ═══
    const [guides, setGuides] = useState<Guide[]>([]);
    const [guidesHistory, setGuidesHistory] = useState<Guide[][]>([]);
    const [draggingGuide, setDraggingGuide] = useState<Guide | null>(null);
    const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
    const [dimensions, setDimensions] = useState<DimensionMeasurement[]>([]);

    // ═══ Text Content ═══
    const [nativeTextCache, setNativeTextCache] = useState<{
        documentIdentity: string;
        blocksBySource: Record<number, NativeTextBlock[]>;
    }>({ documentIdentity: '', blocksBySource: {} });

    // ═══ Hook: PDF Loader ═══
    const loader = usePdfLoader({
        file, pdfUrl, setNumPages, setActivePage, setZoom, containerRef,
    });
    const {
        pdfRef, thumbPdfRef, pageDim, allPageDims, pageWidthPt, plateLabels,
        pageOrder, setPageOrder, pageInstanceIds, setPageInstanceIds,
        selectedIndices, setSelectedIndices, lastSelectedIndex, setLastSelectedIndex,
        pageRotations, setPageRotations, pastStack, setPastStack, futureStack, setFutureStack,
        updatePageDimForPage, generateThumb, loadError, loadStatus, retryLoad, cancelLoad,
        colorRisk, viewerEngineMode, viewerShadowEnabled,
        renderDocumentToken: loaderRenderDocumentToken,
        notifyFirstPageRenderReady,
    } = loader;

    // PERF (audit 2026-08-08 §RENDER.1): metadata pha B có thể đổi khổ các trang đứng
    // trước trang active. Giữ đúng điểm neo viewport qua commit hình học để không nhảy
    // scroll khi người dùng mở thẳng trang khác trang 1 hoặc đang đọc mixed-size PDF.
    useLayoutEffect(() => {
        const pending = pageGeometryAnchorRef.current;
        const scroller = internalScrollRef.current;
        if (pending && scroller) {
            const page = scroller.querySelector<HTMLElement>(`#pdf-page-container-${pending.page}`);
            if (page) {
                const pageRect = page.getBoundingClientRect();
                const scrollerRect = scroller.getBoundingClientRect();
                scroller.scrollTop += (pageRect.top - scrollerRect.top) - pending.top;
                scroller.scrollLeft += (pageRect.left - scrollerRect.left) - pending.left;
            }
        }
        pageGeometryAnchorRef.current = null;

        return () => {
            const currentScroller = internalScrollRef.current;
            const pageNumber = geometryActivePageRef.current;
            const page = currentScroller?.querySelector<HTMLElement>(`#pdf-page-container-${pageNumber}`);
            if (!currentScroller || !page) return;
            const pageRect = page.getBoundingClientRect();
            const scrollerRect = currentScroller.getBoundingClientRect();
            pageGeometryAnchorRef.current = {
                page: pageNumber,
                top: pageRect.top - scrollerRect.top,
                left: pageRect.left - scrollerRect.left,
            };
        };
    }, [allPageDims]);

    // COLOR (audit 2026-08-07 §GV.3): tự bật cho PDF rủi ro cao, nhưng cho phép
    // người dùng tắt/bật theo từng file. Không ghi global store để tab khác không bị ảnh hưởng.
    const accurateColorSourceKey = [pdfUrl || '', (file as ViewerFile)?.path || '', (file as ViewerFile)?.size || 0, (file as ViewerFile)?.lastModified || 0].join('|');
    const [accurateColorPreference, setAccurateColorPreference] = useState<{ sourceKey: string; enabled: boolean } | null>(null);
    const accurateColorPages = useMemo(
        () => colorRisk?.pages.filter(page => page.accurateColorRecommended).map(page => page.page) || [],
        [colorRisk],
    );
    const accurateColorEnabled = accurateColorPreference?.sourceKey === accurateColorSourceKey
        ? accurateColorPreference.enabled
        : colorRisk?.highRisk === true;
    const [accuratePrefetchGate, setAccuratePrefetchGate] = useState<{
        sourceKey: string;
        page: number;
    } | null>(null);
    const handleActivePageRenderReady = useCallback(() => {
        notifyFirstPageRenderReady();
        setAccuratePrefetchGate(previous => (
            previous?.sourceKey === accurateColorSourceKey && previous.page === activePage
                ? previous
                : { sourceKey: accurateColorSourceKey, page: activePage }
        ));
    }, [accurateColorSourceKey, activePage, notifyFirstPageRenderReady]);
    const accuratePrefetchReady = accuratePrefetchGate?.sourceKey === accurateColorSourceKey
        && accuratePrefetchGate.page === activePage;

    // Helper: mọi thao tác đổi thứ tự trang PHẢI cập nhật pageOrder VÀ pageInstanceIds
    // cùng lúc (bất biến: 2 mảng luôn cùng độ dài). Rotation keyed theo instance-id nên
    // nếu 2 mảng lệch → gán góc nhầm trang. Gói qua đây để không quên đồng bộ ở handler nào.
    const applyOrderChange = useCallback((
        newOrder: number[],
        newIds: string[],
        restoredRotations?: Record<string, number>,
    ) => {
        if (newOrder.length !== newIds.length) {
            console.error('[applyOrderChange] order/ids length mismatch', newOrder.length, newIds.length);
        }
        setPageOrder(newOrder);
        setPageInstanceIds(newIds);
        if (restoredRotations) setPageRotations(restoredRotations);
        // Đồng bộ NGAY sang store dùng chung của bộ bình. Trước đây chỉ dựa vào
        // useEffect(pageOrder) bên dưới nên khi nhân bản liên tiếp, preview có thể
        // chạy trong khe giữa hai render và vẫn lấy order cũ (vd 28 thay vì 45).
        // setPageOrder và store đều nhận cùng một immutable array nên thumbnail,
        // preview và file xuất luôn thấy cùng một phiên bản thứ tự trang.
        setViewerPageOrder(newOrder);
        setViewerPageInstanceIds(newIds);
        if (restoredRotations) {
            setViewerPageRotations(flattenRotations(newIds, restoredRotations));
        }
        setNumPages(newOrder.length);
    }, [
        setPageOrder,
        setPageInstanceIds,
        setPageRotations,
        setViewerPageOrder,
        setViewerPageInstanceIds,
        setViewerPageRotations,
        setNumPages,
    ]);

    // LƯU Ý: KHÔNG return sớm ở đây. Trước kia `if (loadError) return ...` đặt
    // TRƯỚC hàng loạt hook bên dưới (useTileRenderer, useViewerZoom, useEffect...),
    // nên khi loadError chuyển từ null→set giữa các lần render, số hook gọi bị lệch
    // → React error #300 ("rendered fewer hooks than expected") làm crash toàn app.
    // Việc kiểm tra loadError được dời xuống SAU TẤT CẢ hook (ngay trước RENDER).

    // ═══ Hook: Tile Renderer ═══
    const {
        getTileUrl,
        getTextBlocksForPage,
        renderOwnerId,
        renderDocumentToken,
        accurateColorError,
        cancelAccurateGroup,
    } = useTileRenderer({
        file, pdfRef, pdfUrl, activePage, tabId, isActive,
        accurateColorEnabled,
        accurateColorPages,
        accurateColorProfileId: viewerSimulationProfileId,
        accurateColorIntent: viewerSimulationIntent,
        outputPreviewFilter: viewerOutputPreviewFilter,
        simulatePaperColor: viewerSimulatePaperColor,
        simulateBlackInk: viewerSimulateBlackInk,
        pageBackgroundRgb: viewerPageBackgroundRgb,
        viewerEngineMode,
        viewerShadowEnabled,
        accurateDpiAnchor: physicalRawDpi,
        renderDocumentToken: loaderRenderDocumentToken,
    });

    useEffect(() => {
        if (
            !accurateColorEnabled
            || !shouldAutoDisableAccurateColor(accurateColorError, viewerEngineMode)
        ) return;
        // Giữ lỗi để nút CMYK! giải thích rằng đây là preview tương thích, không
        // gắn nhãn màu chính xác cho trang có font không nhúng.
        setAccurateColorPreference({ sourceKey: accurateColorSourceKey, enabled: false });
    }, [
        accurateColorEnabled,
        accurateColorError,
        accurateColorSourceKey,
        viewerEngineMode,
    ]);

    // ═══ Edit-session lifecycle (COMMIT-ON-EXIT) ═══
    // Mở phiên in-memory khi VÀO edit mode + có selectionFileId. Phiên SỐNG SUỐT phiên
    // sửa (mọi op áp trong RAM → overlay clip tại chỗ, KHÔNG ghi file/không reload).
    // Khi THOÁT edit mode (hoặc đổi fid / unmount): nếu dirty → COMMIT MỘT LẦN (gộp mọi
    // op thành 1 Working_File) → onCommit đổi pdfUrl sang tile thật (reload DUY NHẤT),
    // rồi ĐÓNG phiên. AcrobatViewer là single-instance nên đặt ở đây (LivePageFrame ảo).
    //
    // `editSession` là object literal MỚI mỗi render → KHÔNG đưa vào deps (sẽ reopen
    // liên tục, reset op_log, phá undo). Giữ qua ref; key effect theo primitive ổn định.
    const editSessionRef = useRef(editSession);
    editSessionRef.current = editSession;
    const editSessionLifecycleRef = useRef<Promise<void>>(Promise.resolve());
    useEffect(() => {
        let cancelled = false;
        const targetFid = selectionFileId;
        const commitAndCloseCurrent = async (): Promise<boolean> => {
            const current = editSessionRef.current;
            if (!current?.sessionId) return true;
            try {
                // REVISION (audit 2026-08-25 §REV.01-02): gọi commit cả khi
                // dirty=false vì op cuối có thể vẫn đang bay và chưa kịp set dirty.
                await current.commit();
            } catch {
                toast.error(t('tabs.imposition:khong_the_chot_edit_pdf', {
                    defaultValue: 'Không thể chốt thay đổi Edit PDF. Phiên chỉnh sửa được giữ lại để bạn thử lại.',
                }));
                return false;
            }
            await current.closeSession();
            return true;
        };

        // Tuần tự hóa đóng/mở: đổi Working File nhanh không được để cleanup phiên cũ
        // chạy chồng và đóng nhầm phiên mới vừa mở.
        editSessionLifecycleRef.current = editSessionLifecycleRef.current
            .catch(() => { /* cho phép chuỗi lifecycle tiếp tục sau lỗi trước đó */ })
            .then(async () => {
                const closed = await commitAndCloseCurrent();
                if (!closed) return;

                if (!cancelled && isObjectEditMode && targetFid) {
                    await editSessionRef.current?.openSession(targetFid);
                }
            });

        return () => {
            cancelled = true;
            editSessionLifecycleRef.current = editSessionLifecycleRef.current
                .catch(() => { /* vẫn phải dọn phiên khi bước trước lỗi */ })
                .then(commitAndCloseCurrent)
                .then(() => undefined);
        };
    }, [isObjectEditMode, selectionFileId, t]);

    // UIUX/PERF (feedback 2026-08-21 §EDIT.THUMB1): preview là state chung của
    // phiên, nên chỉ Viewer cha được dọn khi revision tài liệu THẬT SỰ đổi.
    // LivePageFrame là cây ảo; effect mount của trang mới tuyệt đối không được xóa
    // preview trang đã sửa trước đó khi người dùng cuộn.
    const editPreviewDocumentIdentity = `${pdfUrl || ''}|${selectionFileId || ''}`;
    const editPreviewDocumentIdentityRef = useRef(editPreviewDocumentIdentity);
    useEffect(() => {
        const previousIdentity = editPreviewDocumentIdentityRef.current;
        editPreviewDocumentIdentityRef.current = editPreviewDocumentIdentity;
        if (!editPreviewDocumentChanged(previousIdentity, editPreviewDocumentIdentity)) return;
        clearEditObjectsCache();
        editSessionRef.current?.clearPreviews();
        setSelectedObjectIds(current => current.length ? [] : current);
    }, [editPreviewDocumentIdentity, setSelectedObjectIds]);

    const getExportWorkingFile = useCallback(async (): Promise<File | null> => {
        let committedFile: File | undefined;
        const currentSession = editSessionRef.current;

        if (currentSession?.dirty) {
            // EXPORT (re-audit 2026-07-31 §RA-04): snapshot phải gồm cả object-op
            // đang nằm trong Live_Document; commit fail thì dừng, tuyệt đối không xuất file cũ.
            const result = await currentSession.commit();
            if (!result?.success) {
                throw new Error('Không thể chốt các chỉnh sửa đối tượng trước khi xuất ảnh.');
            }

            const outputName = result.output_filename || file?.name || 'document.pdf';
            if (result.output_path) {
                committedFile = new File([], outputName, { type: 'application/pdf' });
                Object.defineProperty(committedFile, 'path', { value: result.output_path });
            } else if (result.output_url) {
                const base = getApiUrl().replace(/\/api\/?$/, '');
                const url = result.output_url.startsWith('http')
                    ? result.output_url
                    : `${base}${result.output_url}`;
                const response = await authenticatedFetch(url);
                if (!response.ok) {
                    throw new Error(`Không tải được Working File vừa chốt (HTTP ${response.status}).`);
                }
                const blob = await response.blob();
                committedFile = new File([blob], outputName, { type: 'application/pdf' });
            } else {
                throw new Error('Backend không trả về Working File sau khi chốt chỉnh sửa.');
            }
        }

        // Truyền thẳng file vừa commit: callback này vẫn đang giữ closure của render cũ,
        // nên không dựa vào việc React/store đã kịp render lại hay chưa.
        return getWorkingFile(committedFile);
    }, [file, getWorkingFile]);

    // ═══ Derived Values ═══
    const actualWidth100 = pageWidthPt * (96 / 72);
    // UIUX (feedback 2026-08-11 §VIEW.ACTUAL-SIZE): `zoom` là số % user nhìn thấy;
    // chỉ zoom render/layout nhân hiệu chỉnh màn hình. pageDim vẫn px@96 để
    // DIM/VDP/edit và mọi hệ point/mm không bị đổi hợp đồng.
    const effectiveZoom = zoom * physicalDisplayScale;
    const calibratedActualWidth100 = actualWidth100 * physicalDisplayScale;
    const activePageIdentity = useMemo(() => resolveViewerPageIdentity({
        viewerPosition: activePage,
        pageOrder,
        pageInstanceIds,
    }), [activePage, pageOrder, pageInstanceIds]);
    const activePageDim = activePageIdentity.sourcePage == null
        ? pageDim
        : (allPageDims[activePageIdentity.sourcePage] || pageDim);
    const fitPageSizes = useMemo(() => resolveViewerFitPageSizes({
        activeViewerPosition: activePage,
        pageDisplayMode,
        pageOrder,
        pageInstanceIds,
        pageRotations,
        pageDims: allPageDims,
        fallbackDim: pageDim,
        displayScale: physicalDisplayScale,
    }), [
        activePage,
        pageDisplayMode,
        pageOrder,
        pageInstanceIds,
        pageRotations,
        allPageDims,
        pageDim,
        physicalDisplayScale,
    ]);
    const textDocumentIdentity = [
        pdfUrl || '',
        (file as ViewerFile)?.path || '',
        (file as ViewerFile)?.size || 0,
        (file as ViewerFile)?.lastModified || 0,
    ].join('|');
    const nativeTextBlocks = useMemo(
        () => nativeTextCache.documentIdentity === textDocumentIdentity
            ? nativeTextCache.blocksBySource
            : {},
        [nativeTextCache, textDocumentIdentity],
    );
    useEffect(() => {
        setNativeTextCache(current => current.documentIdentity === textDocumentIdentity
            ? current
            : { documentIdentity: textDocumentIdentity, blocksBySource: {} });
    }, [textDocumentIdentity]);

    // Lưu kích thước trang vào store để công cụ VDP căn chỉnh theo trang.
    // QUAN TRỌNG: field.x/y/width/height ở đơn vị "CSS-mm" (mm thật × 96/72), KHÔNG phải mm thật.
    // Dùng đúng khổ trang nguồn đang active sau reorder.
    const setViewerPageDimMm = useWorkspaceStore(s => s.setViewerPageDimMm);
    useEffect(() => {
        if (activePageDim && activePageDim.w && activePageDim.h) {
            setViewerPageDimMm({
                w: activePageDim.w * 25.4 / 72,
                h: activePageDim.h * 25.4 / 72,
            });
        } else {
            setViewerPageDimMm(null);
        }
    }, [activePageDim, setViewerPageDimMm]);

    // ═══ Quét chữ (chế độ XEM THƯỜNG) ═══
    // Nạp text CÓ TOẠ ĐỘ cho trang đang xem → dựng lớp <span> trong suốt (select-text)
    // đè lên ảnh trang để bôi đen + copy như Acrobat. CHỈ ở chế độ xem thường: KHÔNG
    // edit-object (chuột dùng chọn object), KHÔNG VDP, KHÔNG crop (chuột quét vùng).
    // File native (mở từ đĩa) → backend /pdf-text (point, top-left, sạch); non-native
    // → getTextBlocksForPage (pdf.js). Cache theo revision + trang nguồn, không theo
    // vị trí Viewer vì reorder/delete không thay đổi namespace của backend.
    const canScanText = !isObjectEditMode && !isVdpMode && !isCropMode;
    useEffect(() => {
        const sourcePage = activePageIdentity.sourcePage;
        if (!canScanText || !file || sourcePage == null) return;
        if (nativeTextBlocks[sourcePage]) return;
        let cancelled = false;
        const nativePath = (file as ViewerFile)?.path;
        const cacheBlocks = (blocks: NativeTextBlock[]) => {
            setNativeTextCache(previous => {
                const currentBlocks = previous.documentIdentity === textDocumentIdentity
                    ? previous.blocksBySource
                    : {};
                return {
                    documentIdentity: textDocumentIdentity,
                    blocksBySource: { ...currentBlocks, [sourcePage]: blocks },
                };
            });
        };
        (async () => {
            try {
                if (nativePath) {
                    const res = await fetch(`${getApiUrl()}/imposition/pdf-text`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: nativePath, page: sourcePage }),
                    });
                    if (!res.ok || cancelled) return;
                    const data = await res.json();
                    if (cancelled) return;
                    cacheBlocks(data.blocks || []);
                } else {
                    const blocks = await getTextBlocksForPage(sourcePage, nativeTextBlocks);
                    if (blocks && !cancelled) {
                        cacheBlocks(blocks as NativeTextBlock[]);
                    }
                }
            } catch { /* text không quét được (file scan/outline) → bỏ qua, không phải lỗi */ }
        })();
        return () => { cancelled = true; };
    }, [
        canScanText,
        file,
        activePageIdentity.sourcePage,
        nativeTextBlocks,
        getTextBlocksForPage,
        textDocumentIdentity,
    ]);

    // ═══ Page Navigation ═══
    const navigatePage = useCallback((newPage: number, options?: { preserveSelection?: boolean }) => {
        if (numPages === 0) return;
        const index = Math.max(0, Math.min(numPages - 1, newPage - 1));
        const targetPage = index + 1;
        if (targetPage === activePage) return;

        const scroller = internalScrollRef.current;
        const currentPage = scroller ? getRenderedPageElement(scroller, activePage) : null;
        pendingPageViewportRef.current = {
            page: targetPage,
            anchor: scroller && currentPage
                ? capturePageViewportAnchor(scroller, currentPage) || { xRatio: 0.5, yRatio: 0.5 }
                : { xRatio: 0.5, yRatio: 0.5 },
        };
        explicitNavRef.current = true;
        if (scroller) scroller.dataset.isNavigating = 'true';

        if (!options?.preserveSelection) {
            setSelectedIndices(new Set([index]));
            setLastSelectedIndex(index);
        }
        setActivePage(targetPage);
        if (mainVirtuosoRef.current) {
            const rowIndex = viewerRowIndexForPosition(index, pageDisplayMode);
            mainVirtuosoRef.current.scrollToIndex({ index: rowIndex, behavior: 'auto', align: 'start' });
        }
    }, [numPages, activePage, pageDisplayMode, setSelectedIndices, setLastSelectedIndex, setActivePage]);

    // ═══ Hook: Object Edit Undo/Redo (Ctrl+Z hoàn tác move/delete/rotate...) ═══
    const objectEdit = useObjectEditHistory();

    // ═══ Hook: Viewer Hotkeys ═══
    const { commitSnapshot, undo, redo } = useViewerHotkeys({
        containerRef, sidebarRef,
        // isActive: false khi tab nền — hotkey D/F7/Delete chỉ tab đang xem.
        // undefined (caller cũ) → coi như active + fallback DOM.
        isActive: isActive !== false,
        pageOrder, pageInstanceIds, selectedIndices, lastSelectedIndex, pageRotations, activePage, numPages,
        applyPageRevision: applyOrderChange,
        setSelectedIndices, setLastSelectedIndex, setPageRotations, setActivePage,
        pastStack, futureStack, setPastStack, setFutureStack,
        toolMode, setToolMode, isVdpMode, isThumbMenuOpen, isDeleteModalOpen,
        setIsDeleteModalOpen, setIsExtractModalOpen, setIsInsertModalOpen, setExtractPagesStrForModal, setContextMenu,
        guides, setGuides, guidesHistory, setGuidesHistory, selectedGuideId, setSelectedGuideId, toggleRulers,
        navigatePage,
        mainVirtuosoRef, internalScrollRef,
        // Ctrl+Z/Y trong chế độ chỉnh sửa đối tượng → undo/redo qua EDIT-SESSION
        // (in-memory, per-op, render vùng clip → overlay tại chỗ, KHÔNG reload). Session
        // sở hữu op_log nên undo/redo chính xác từng op. `scale` = px thiết bị/point
        // (css px/point × dpr) để ảnh clip khôi phục đủ nét. editHistory cũ (snapshot
        // pdfUrl) KHÔNG còn dùng cho edit-object — session là đường DUY NHẤT.
        isObjectEditMode,
        onDocumentUndo,
        onEditUndo: () => {
            if (!editSession?.canUndo) return objectEdit.undo();
            const cssScale = pageDim?.w ? (actualWidth100 * effectiveZoom) / (pageDim.w * 72 / 96) : 2;
            const dpr = window.devicePixelRatio || 1;
            void editSession.undo(Math.max(0.5, cssScale * dpr));
            return true;
        },
        onEditRedo: () => {
            if (!editSession?.canRedo) return objectEdit.redo();
            const cssScale = pageDim?.w ? (actualWidth100 * effectiveZoom) / (pageDim.w * 72 / 96) : 2;
            const dpr = window.devicePixelRatio || 1;
            void editSession.redo(Math.max(0.5, cssScale * dpr));
            return true;
        },
    });

    // ═══ Hook: Zoom & Gestures ═══
    const {
        isZoomReady,
        thumbBaseWidth,
        isZoomingRef,
        applyFitWidth, applyFitPage,
        handleDragStart,
        updateViewportRect,
    } = useViewerZoom({
        containerRef, sidebarRef, internalScrollRef,
        numPages, zoom, setZoom, fitMode, setFitMode: setFitMode as (m: string) => void,
        fitPageSizes,
        pageDisplayMode, setPageDisplayMode: setPageDisplayMode as (m: string) => void,
        activePage, actualWidth100: fitPageSizes[0]?.width || calibratedActualWidth100,
        navigatePage, toolMode,
    });

    // UIUX (audit 2026-08-25 §NW.4): usePdfLoader reset page/zoom khi đổi file,
    // nên seed cửa sổ con chỉ được áp sau trạng thái `ready` + pageOrder thật.
    const initialViewAppliedRef = useRef(false);
    const initialViewCompletedRef = useRef(false);
    const initialViewRafRef = useRef<number | null>(null);
    const initialViewTimerRef = useRef<number | null>(null);
    const pendingInitialViewScrollRef = useRef<{
        targetIndex: number;
        pageDisplayMode: DocumentWindowViewState['pageDisplayMode'];
    } | null>(null);
    const initialViewCallbackRef = useRef(onInitialViewStateApplied);
    initialViewCallbackRef.current = onInitialViewStateApplied;

    const completeInitialView = useCallback(() => {
        if (initialViewCompletedRef.current) return;
        initialViewCompletedRef.current = true;
        if (initialViewRafRef.current !== null) {
            cancelAnimationFrame(initialViewRafRef.current);
            initialViewRafRef.current = null;
        }
        if (initialViewTimerRef.current !== null) {
            window.clearTimeout(initialViewTimerRef.current);
            initialViewTimerRef.current = null;
        }
        initialViewCallbackRef.current?.();
    }, []);

    const applyPendingInitialViewScroll = useCallback((): boolean => {
        const pending = pendingInitialViewScrollRef.current;
        if (!pending) return true;
        // Layout fit lấy trang hiện tại trực tiếp từ activePage, không có row cần cuộn.
        if (!pending.pageDisplayMode.endsWith('_scroll')) {
            pendingInitialViewScrollRef.current = null;
            return true;
        }
        if (!isZoomReady || pageDisplayMode !== pending.pageDisplayMode) return false;
        const virtuoso = mainVirtuosoRef.current;
        if (!virtuoso) return false;
        virtuoso.scrollToIndex({
            index: viewerRowIndexForPosition(pending.targetIndex, pending.pageDisplayMode),
            behavior: 'auto',
            align: 'start',
        });
        pendingInitialViewScrollRef.current = null;
        return true;
    }, [isZoomReady, pageDisplayMode]);

    useEffect(() => {
        if (!initialViewState || initialViewAppliedRef.current) return;
        if (loadError || loadStatus === 'error' || loadStatus === 'cancelled') {
            initialViewAppliedRef.current = true;
            pendingInitialViewScrollRef.current = null;
            completeInitialView();
            return;
        }
        if (loadStatus !== 'ready' || pageOrder.length === 0) return;

        initialViewAppliedRef.current = true;
        const requestedPage = Number.isFinite(initialViewState.activePage)
            ? Math.trunc(initialViewState.activePage)
            : 1;
        const targetIndex = Math.max(0, Math.min(pageOrder.length - 1, requestedPage - 1));
        const targetPage = targetIndex + 1;
        pendingInitialViewScrollRef.current = {
            targetIndex,
            pageDisplayMode: initialViewState.pageDisplayMode,
        };
        setPageDisplayMode(initialViewState.pageDisplayMode);
        setFitMode(initialViewState.fitMode);
        setZoom(initialViewState.zoom);
        setSelectedIndices(new Set([targetIndex]));
        setLastSelectedIndex(targetIndex);
        setActivePage(targetPage);

        const finishInitialView = () => {
            applyPendingInitialViewScroll();
            completeInitialView();
        };
        // WebView native còn ẩn có thể ngừng rAF; timer phải được tạo song song để
        // callback luôn cho native hiện cửa sổ, rồi layout effect sẽ retry scroll.
        initialViewRafRef.current = requestAnimationFrame(finishInitialView);
        initialViewTimerRef.current = window.setTimeout(finishInitialView, 50);
    }, [
        applyPendingInitialViewScroll,
        completeInitialView,
        initialViewState,
        loadError,
        loadStatus,
        pageOrder.length,
        setActivePage,
        setFitMode,
        setLastSelectedIndex,
        setPageDisplayMode,
        setSelectedIndices,
        setZoom,
    ]);

    useEffect(() => () => {
        if (initialViewRafRef.current !== null) cancelAnimationFrame(initialViewRafRef.current);
        if (initialViewTimerRef.current !== null) window.clearTimeout(initialViewTimerRef.current);
        initialViewRafRef.current = null;
        initialViewTimerRef.current = null;
        pendingInitialViewScrollRef.current = null;
    }, []);
    // REVISION (audit 2026-08-25 §REV.08): lần render đầu còn mang `ready` của file cũ;
    // arm một nhịp để loader của đúng File có cơ hội reset/bootstrap trước khi hydrate.
    const hydratedHistoryEntryRef = useRef<WorkspaceHistoryEntry | null>(null);
    const [historyHydrationArm, setHistoryHydrationArm] = useState<WorkspaceHistoryEntry | null>(null);
    const historyHydrationPendingForCurrentFile = pendingHistoryEntry?.file === file
        && hydratedHistoryEntryRef.current !== pendingHistoryEntry;

    // ═══ Sync Effects ═══
    // Fallback cho các thay đổi pageOrder không đi qua applyOrderChange (nạp file,
    // undo/redo, copy liên file). Các handler trực tiếp đã đồng bộ ngay phía trên.
    useEffect(() => {
        if (historyHydrationPendingForCurrentFile) return;
        setViewerPageOrder(pageOrder); setNumPages(pageOrder.length);
    }, [historyHydrationPendingForCurrentFile, pageOrder, setViewerPageOrder, setNumPages]);
    useEffect(() => { if (pageOrder.length > 0 && activePage > pageOrder.length) setActivePage(pageOrder.length); }, [pageOrder.length, activePage, setActivePage]);
    useEffect(() => {
        if (historyHydrationPendingForCurrentFile) return;
        setViewerPageInstanceIds(pageInstanceIds);
    }, [historyHydrationPendingForCurrentFile, pageInstanceIds, setViewerPageInstanceIds]);
    useEffect(() => {
        // UIUX (audit 2026-08-11 §PRINTRANGE.2): snapshot theo store CỦA TAB để
        // Ctrl+P đọc đúng selection mà không làm shell global render lại khi cuộn.
        setViewerSelectedPageIndices(Array.from(selectedIndices).sort((a, b) => a - b));
    }, [selectedIndices, setViewerSelectedPageIndices]);
    // Đẩy rotation ra store dạng number[] THEO VỊ TRÍ (out[i] = góc trang ở vị trí i).
    // Trong viewer rotation keyed theo instance-id (xoay độc lập bản nhân bản), nhưng ra
    // store/backend chỉ cần góc-theo-vị-trí (thứ tự mảng đã cố định). Backend impose + bake
    // đều lặp theo vị trí nên nhận trực tiếp. Xem flattenRotations (per-instance rotation).
    useEffect(() => {
        if (historyHydrationPendingForCurrentFile) return;
        setViewerPageRotations?.(flattenRotations(pageInstanceIds, pageRotations));
    }, [historyHydrationPendingForCurrentFile, pageRotations, pageInstanceIds, setViewerPageRotations]);
    useEffect(() => {
        setViewerDirty(pastStack.length > 0 || restoredHistoryDirty);
    }, [pastStack.length, restoredHistoryDirty, setViewerDirty]);
    useEffect(() => {
        const pending = pendingHistoryEntry;
        if (!pending || pending.file !== file) {
            hydratedHistoryEntryRef.current = null;
            if (historyHydrationArm !== null) setHistoryHydrationArm(null);
            return;
        }
        if (hydratedHistoryEntryRef.current === pending) return;
        if (historyHydrationArm !== pending) {
            setHistoryHydrationArm(pending);
            return;
        }
        if (loadStatus !== 'ready' || pageOrder.length === 0) return;

        // IDs được snapshot theo instance; rotation phẳng phải dựng lại map bằng
        // chính IDs đó trước khi đi qua transaction E1a.
        const revision = pending.pageRevision;
        if (revision) {
            const restoredOrder = [...revision.pageOrder];
            const restoredIds = revision.pageInstanceIds.length === restoredOrder.length
                ? [...revision.pageInstanceIds]
                : genPageIds(restoredOrder.length);
            const restoredRotations = restoredIds.reduce<Record<string, number>>((result, id, index) => {
                result[id] = revision.pageRotations[index] ?? 0;
                return result;
            }, {});
            applyOrderChange(restoredOrder, restoredIds, restoredRotations);
            setSelectedIndices(new Set([0]));
            setLastSelectedIndex(0);
            setActivePage(1);
        }

        setPastStack([]);
        setFutureStack([]);
        hydratedHistoryEntryRef.current = pending;
        setHistoryHydrationArm(null);
        onHistoryEntryHydrated?.(pending);
    }, [
        applyOrderChange,
        file,
        historyHydrationArm,
        loadStatus,
        onHistoryEntryHydrated,
        pageOrder.length,
        pendingHistoryEntry,
        setActivePage,
        setFutureStack,
        setLastSelectedIndex,
        setPastStack,
        setSelectedIndices,
    ]);
    // Vào Object Edit / VDP → về pointer (tắt DIM nếu đang bật).
    // Bật DIM (phím D) luôn set isObjectEditMode=false trước nên effect không đè ngược.
    useEffect(() => {
        if (isObjectEditMode || isVdpMode) setToolMode('pointer');
    }, [isObjectEditMode, isVdpMode, setToolMode]);
    useEffect(() => {
        if (activePageIdentity.sourcePage != null) {
            updatePageDimForPage(activePageIdentity.sourcePage, numPages);
        }
    }, [pdfRef, activePageIdentity.sourcePage, numPages, updatePageDimForPage]);

    // Reset zoom state on new file
    useEffect(() => {
        // Edit-commit: giữ nguyên zoom/scroll (cùng cấu trúc trang) → không reset.
        if ((file as ViewerFile)?.__editCommit) return;
        if (internalScrollRef.current) internalScrollRef.current = null;
    }, [pdfUrl, file]);

    // ── Giải phóng bitmap trang khi tab ở NỀN lâu (audit RAM: app nặng dần theo số
    //    tab mở). Mọi tab luôn mounted (audit chốt KHÔNG unmount ImpositionTab vì
    //    state nằm trong store/useRef → unmount = mất việc chưa lưu). Thay vào đó:
    //    tab nền >20s thì NGỪNG render cây LivePageFrame → <img> tile (bitmap RGBA
    //    tới ~200MB/trang khổ lớn) bị gỡ khỏi DOM → trình duyệt GC. Tile blob (JPEG
    //    nhỏ) vẫn nằm trong LRU cache bounded (TILE_CACHE_MAX + revoke) nên khi quay
    //    lại tab, LiveTile phục hồi ảnh tức thì từ cache. pageOrder/rotation/mọi state
    //    nằm trong store → save/print vẫn đúng dù cây trang đã tạm gỡ.
    const [suspendViewer, setSuspendViewer] = useState(false);
    useEffect(() => {
        if (isActive) { setSuspendViewer(false); return; }
        const t = setTimeout(() => setSuspendViewer(true), 20000);
        return () => clearTimeout(t);
    }, [isActive]);

    // ── Menu bar (kiểu Acrobat) → lệnh thao tác trên viewer. Mọi tab đều mounted nên
    //    CHỈ tab active mới xử lý (tránh mọi tab cùng phản ứng). App-level (New/Open/Save…)
    //    xử lý ở AppInner; ở đây chỉ nhận lệnh liên quan trực tiếp tới viewer trang hiện tại.
    useEffect(() => {
        if (!isActive) return;
        const handleMenuCommand = (e: Event) => {
            const detail = (e as CustomEvent<{ cmd?: string; page?: number }>).detail;
            const cmd = detail?.cmd || '';
            switch (cmd) {
                case 'zoom-in': setZoom(z => Math.min(64, z * 1.25)); setFitMode('custom'); break;
                case 'zoom-out': setZoom(z => Math.max(0.01, z / 1.25)); setFitMode('custom'); break;
                case 'zoom-100': setZoom(1); setFitMode('custom'); break;
                case 'fit-width': applyFitWidth(); break;
                case 'fit-page': applyFitPage(); break;
                case 'layout-single-fit': setPageDisplayMode('single_fit'); break;
                case 'layout-single-scroll': setPageDisplayMode('single_scroll'); break;
                case 'layout-two-fit': setPageDisplayMode('two_fit'); break;
                case 'layout-two-scroll': setPageDisplayMode('two_scroll'); break;
                case 'first-page': navigatePage(1); break;
                case 'last-page': navigatePage(pageOrder.length); break;
                case 'prev-page': navigatePage(activePage - 1); break;
                case 'next-page': navigatePage(activePage + 1); break;
                case 'go-to-page': {
                    const page = Number(detail?.page);
                    if (Number.isFinite(page)) navigatePage(page);
                    break;
                }
                case 'toggle-rulers': toggleRulers(); break;
                case 'toggle-object-edit':
                    setIsObjectEditMode(v => {
                        const next = !v;
                        if (next) openWorkspaceSidebar();
                        return next;
                    });
                    break;
                case 'crop': {
                    const next = !isCropMode;
                    setIsCropMode(next);
                    if (next) {
                        setIsObjectEditMode(false); setToolMode('pointer');
                        openWorkspaceSidebar();
                    }
                    break;
                }
                case 'delete-pages': setIsDeleteModalOpen(true); break;
                case 'export-image': void openExportImage('export'); break;
                case 'export-for-screens': void openExportImage('screens'); break;
                case 'undo': if (isCropMode) undoCropSelection(); else undo(); break;
                case 'redo': if (isCropMode) redoCropSelection(); else redo(); break;
            }
        };
        window.addEventListener('prynx-menu-command', handleMenuCommand);
        return () => window.removeEventListener('prynx-menu-command', handleMenuCommand);
    }, [isActive, setZoom, setFitMode, applyFitWidth, applyFitPage, setPageDisplayMode, navigatePage, pageOrder.length, activePage, toggleRulers, setIsObjectEditMode, setIsCropMode, setToolMode, undo, redo, isCropMode, undoCropSelection, redoCropSelection, openExportImage, openWorkspaceSidebar]);

    // UIUX (audit menu 2026-07-28 §MB.5): phát trạng thái hiển thị lên store toàn cục
    // để menu Xem tick được mục đang chọn. Chỉ tab ĐANG XEM phát (tab nền vẫn mounted).
    useEffect(() => {
        if (!isActive) return;
        useActiveViewerStore.getState().publish({
            tabId: tabId ?? null,
            pageDisplayMode,
            fitMode,
            numPages: pageOrder.length,
        });
    }, [isActive, tabId, pageDisplayMode, fitMode, pageOrder.length]);

    // Điều hướng trang giữ nguyên điểm đang nhìn theo tỷ lệ trên trang.
    useEffect(() => {
        if (!explicitNavRef.current) return;
        explicitNavRef.current = false;
        const pending = pendingPageViewportRef.current;
        if (!pending || pending.page !== activePage) return;

        let frameId = 0;
        let releaseTimer = 0;
        let attempts = 0;
        const restore = () => {
            const scroller = internalScrollRef.current;
            const page = scroller ? getRenderedPageElement(scroller, activePage) : null;
            attempts += 1;
            if (!scroller || !page || !restorePageViewportAnchor(scroller, page, pending.anchor)) {
                if (attempts < 8) {
                    frameId = requestAnimationFrame(restore);
                } else if (scroller) {
                    delete scroller.dataset.isNavigating;
                }
                return;
            }

            pendingPageViewportRef.current = null;
            updateViewportRect();
            releaseTimer = window.setTimeout(() => {
                if (internalScrollRef.current) delete internalScrollRef.current.dataset.isNavigating;
            }, 100);
        };
        frameId = requestAnimationFrame(restore);
        return () => {
            cancelAnimationFrame(frameId);
            window.clearTimeout(releaseTimer);
        };
    }, [activePage, updateViewportRect]);

    useEffect(() => {
        const targetPage = highlightBoxes?.[0]?.page;
        if (!targetPage || pageOrder.length === 0) return;

        const index = pageOrder.findIndex(p => p === targetPage);
        if (index < 0) return;

        const timer = window.setTimeout(() => {
            // UIUX (audit 2026-08-22 §UX.VIEW.06): index là vị trí trang,
            // còn Virtuoso nhận vị trí row khi đang hiển thị hai trang.
            mainVirtuosoRef.current?.scrollToIndex({
                index: viewerRowIndexForPosition(index, pageDisplayMode),
                behavior: 'auto',
                align: 'center',
            });
            setActivePage(index + 1);
            setSelectedIndices(prev => {
                if (prev.size === 1 && prev.has(index)) return prev;
                return new Set([index]);
            });
            setLastSelectedIndex(prev => prev === index ? prev : index);
        }, 100);

        return () => window.clearTimeout(timer);
    }, [highlightBoxes, pageOrder, pageDisplayMode, setActivePage, setSelectedIndices, setLastSelectedIndex]);

    // Thumbnail pre-generation
    useEffect(() => {
        // UIUX (audit 2026-08-22 §UX.TH.05): warmup là tối ưu, chỉ tab đang xem
        // mới được phép tiêu tốn PDF.js; thumbnail ngoài viewport vẫn render
        // on-demand trong ThumbSidebar.
        if (isActive === false) return;
        if (!thumbPdfRef && !(file as ViewerFile)?.path) return;
        if (numPages === 0 || !isThumbMenuOpen) return;
        let cancelled = false;
        const maxThumbsToGen = Math.min(numPages, 30);
        const genSequential = async () => {
            for (let i = 0; i < maxThumbsToGen; i++) {
                if (cancelled) return;
                const pageNum = i + 1;
                // Warmup cache base CHƯA xoay (rot=0): rotation giờ theo instance-id, không
                // map vào bare pageNum. Thumbnail áp góc xoay qua CSS ở ThumbSidebar.
                // width = thumbBaseWidth để cache key khớp MemoThumbItem (không còn hardcode 400).
                await generateThumb(thumbPdfRef, pageNum, 0, thumbBaseWidth);
                await new Promise(r => setTimeout(r, 10));
            }
        };
        genSequential();
        return () => { cancelled = true; };
    }, [isActive, thumbPdfRef, file, numPages, pageRotations, generateThumb, isThumbMenuOpen, thumbBaseWidth]);

    const pageToolsHandlersRef = useRef<{
        duplicate: (target: 'current' | 'all' | 'range', range: [number, number], copies: number, collate: boolean) => void;
        move: (startPage: number, endPage: number, targetType: string, targetPage: number) => void;
        delete: (target: 'current' | 'range', range: [number, number], filter: string) => void;
        rotate: (target: string, range: [number, number], filter: string, degrees: number) => void;
        insertBlank: (location: 'after' | 'before', target: 'first' | 'last' | 'page', targetPage: number, count: number) => void;
        extract: (range: [number, number], deleteAfter: boolean) => void;
    } | null>(null);
    // PageTools event listener
    useEffect(() => {
        const handlePageToolsAction = (event: Event) => {
            const { tabId: targetTabId, action, payload } = (event as CustomEvent<PageToolsActionDetail>).detail ?? {};
            const handlers = pageToolsHandlersRef.current;
            if (!isActive || !tabId || targetTabId !== tabId || !payload || !handlers) return;
            if (action === 'duplicate') handlers.duplicate(payload.targetType as 'current' | 'all' | 'range', payload.range, payload.copies, payload.collate);
            else if (action === 'move') handlers.move(payload.startPage, payload.endPage, payload.targetType, payload.targetPage);
            else if (action === 'delete') handlers.delete(payload.targetType as 'current' | 'range', payload.range, payload.filter);
            else if (action === 'rotate') handlers.rotate(payload.targetType, payload.range, payload.filter, payload.degrees);
            else if (action === 'insert_blank') handlers.insertBlank(payload.location, payload.target, payload.targetPage, payload.count);
            else if (action === 'extract') handlers.extract(payload.range, payload.deleteAfter);
        };
        window.addEventListener('prynx-pagetools-action', handlePageToolsAction);
        return () => window.removeEventListener('prynx-pagetools-action', handlePageToolsAction);
    }, [pageOrder, selectedIndices, activePage, isActive, tabId]);

    // ═══ Page Tool Handlers ═══
    const handleQuickDeleteConfirm = () => {
        commitSnapshot();
        const keep = (_: unknown, idx: number) => !selectedIndices.has(idx);
        const newOrder = pageOrder.filter(keep);
        const newIds = pageInstanceIds.filter(keep);
        applyOrderChange(newOrder, newIds);
        const nextActiveIndex = resolveActiveViewerIndexAfterRemoval(activePage, pageInstanceIds, newIds);
        setActivePage(nextActiveIndex >= 0 ? nextActiveIndex + 1 : 1);
        setSelectedIndices(new Set(nextActiveIndex >= 0 ? [nextActiveIndex] : []));
        setLastSelectedIndex(nextActiveIndex >= 0 ? nextActiveIndex : null);
        setIsDeleteModalOpen(false);
    };

    const handleQuickRotate = (degrees: number) => {
        commitSnapshot();
        // Rotation keyed theo INSTANCE-ID (không phải số trang gốc) → mỗi bản nhân bản /
        // mỗi trang trắng xoay ĐỘC LẬP. Mỗi index = 1 instance duy nhất nên KHÔNG cần dedupe.
        const newRotations = { ...pageRotations };
        for (const idx of selectedIndices) {
            const id = pageInstanceIds[idx];
            if (!id) continue;
            newRotations[id] = ((newRotations[id] || 0) + degrees) % 360;
        }
        setPageRotations(newRotations);
    };

    // UIUX (audit menu 2026-07-28 §MB.6): các thao tác TRANG trước đây chỉ có phím tắt
    // (R / Shift+R / Ctrl+A / E) nên khách dùng chuột không biết là có. Đăng ký listener
    // RIÊNG, đặt SAU các handler thao tác trang: mảng deps của effect được đánh giá ngay
    // trong lúc render, nếu gộp vào effect menu ở trên (khai báo trước handler) sẽ chạm
    // TDZ của handleQuickRotate → ReferenceError.
    // Giữ giá trị/handler MỚI NHẤT trong ref: nếu đưa activePage, selectedIndices,
    // handleQuickRotate vào deps thì listener bị gỡ/gắn lại mỗi lần cuộn trang.
    const pageCmdRef = useRef({ selectedIndices, pageCount: pageOrder.length, activePage, quickRotate: handleQuickRotate });
    useEffect(() => {
        pageCmdRef.current = { selectedIndices, pageCount: pageOrder.length, activePage, quickRotate: handleQuickRotate };
    });
    useEffect(() => {
        if (!isActive) return;
        const handlePageMenuCommand = (e: Event) => {
            const detail = (e as CustomEvent<{ cmd?: string; page?: number }>).detail;
            const cmd = detail?.cmd || '';
            const { selectedIndices: sel, pageCount, activePage: page, quickRotate } = pageCmdRef.current;
            switch (cmd) {
                case 'rotate-right':
                case 'rotate-left': {
                    // Xoay áp cho các trang ĐANG CHỌN ở thanh thumbnail — giống phím R.
                    if (sel.size === 0) {
                        toast.info(t('misc.acrobatViewer:chon_trang_truoc_khi_xoay', 'Chọn trang ở thanh thumbnail trước rồi xoay (Ctrl+A = chọn tất cả)'));
                        return;
                    }
                    quickRotate(cmd === 'rotate-right' ? 90 : 270);
                    break;
                }
                case 'select-all-pages':
                    if (pageCount === 0) return;
                    setSelectedIndices(new Set(Array.from({ length: pageCount }, (_, i) => i)));
                    setLastSelectedIndex(Math.max(0, page - 1));
                    break;
                case 'clear-page-selection':
                    setSelectedIndices(new Set());
                    setLastSelectedIndex(null);
                    break;
                case 'extract-pages': {
                    if (pageCount === 0) return;
                    const sorted = Array.from(sel).sort((a, b) => a - b).map(i => i + 1);
                    setExtractPagesStrForModal(sorted.length > 0 ? sorted.join(', ') : String(page));
                    setIsExtractModalOpen(true);
                    break;
                }
            }
        };
        window.addEventListener('prynx-menu-command', handlePageMenuCommand);
        return () => window.removeEventListener('prynx-menu-command', handlePageMenuCommand);
    }, [isActive, setSelectedIndices, setLastSelectedIndex, setExtractPagesStrForModal, t]);

    const handlePageToolsDuplicate = (target: 'current' | 'all' | 'range', range: [number, number], copies: number, collate: boolean) => {
        commitSnapshot();
        let sourceIndices: number[] = [];
        if (target === 'current') { const i = activePage - 1; if (i >= 0 && i < pageOrder.length) sourceIndices.push(i); }
        else if (target === 'all') { sourceIndices = Array.from({ length: pageOrder.length }, (_, i) => i); }
        else { const s = Math.max(0, range[0] - 1); const e = Math.min(pageOrder.length - 1, range[1] - 1); for (let i = s; i <= e; i++) sourceIndices.push(i); }
        if (sourceIndices.length === 0) return;
        const newOrder = [...pageOrder];
        const newIds = [...pageInstanceIds];
        // Bản sao: id MỚI (xoay độc lập) nhưng KẾ THỪA góc hiện tại của trang nguồn.
        const newRot = { ...pageRotations };
        const makeDup = (srcIdx: number): { page: number; id: string } => {
            const id = genPageId();
            const srcId = pageInstanceIds[srcIdx];
            if (srcId && pageRotations[srcId]) newRot[id] = pageRotations[srcId];
            return { page: pageOrder[srcIdx], id };
        };
        if (collate) {
            const dups: { page: number; id: string }[] = [];
            for (let c = 0; c < copies; c++) for (const idx of sourceIndices) dups.push(makeDup(idx));
            const at = sourceIndices[sourceIndices.length - 1] + 1;
            newOrder.splice(at, 0, ...dups.map(d => d.page));
            newIds.splice(at, 0, ...dups.map(d => d.id));
        } else {
            for (let i = sourceIndices.length - 1; i >= 0; i--) {
                const idx = sourceIndices[i];
                const dups = Array.from({ length: copies }, () => makeDup(idx));
                newOrder.splice(idx + 1, 0, ...dups.map(d => d.page));
                newIds.splice(idx + 1, 0, ...dups.map(d => d.id));
            }
        }
        setPageRotations(newRot);
        applyOrderChange(newOrder, newIds);
        // pageOrder đổi độ dài/thứ tự → selectedIndices cũ trỏ SAI trang. Reset về rỗng
        // + anchor null để thao tác chọn kế tiếp bắt đầu sạch (tránh chọn/xoá nhầm trang).
        setSelectedIndices(new Set());
        setLastSelectedIndex(null);
    };

    // Nhân bản NHANH các trang đang chọn (menu chuột phải). Chèn bản sao ngay sau mỗi
    // trang gốc; bản sao có id MỚI + kế thừa góc xoay nguồn (per-instance rotation).
    const handleQuickDuplicate = () => {
        const sel = Array.from(selectedIndices).sort((a, b) => a - b);
        if (sel.length === 0) return;
        commitSnapshot();
        const newOrder = [...pageOrder];
        const newIds = [...pageInstanceIds];
        const newRot = { ...pageRotations };
        const makeDup = (srcIdx: number): { page: number; id: string } => {
            const id = genPageId();
            const srcId = pageInstanceIds[srcIdx];
            if (srcId && pageRotations[srcId]) newRot[id] = pageRotations[srcId];
            return { page: pageOrder[srcIdx], id };
        };
        // Chèn từ CUỐI về ĐẦU để index chèn không bị dịch bởi lần chèn trước.
        for (let i = sel.length - 1; i >= 0; i--) {
            const idx = sel[i];
            const dup = makeDup(idx);
            newOrder.splice(idx + 1, 0, dup.page);
            newIds.splice(idx + 1, 0, dup.id);
        }
        setPageRotations(newRot);
        applyOrderChange(newOrder, newIds);
        setSelectedIndices(new Set());
        setLastSelectedIndex(null);
        setContextMenu(null);
    };

    const handlePageToolsMove = (startPage: number, endPage: number, targetType: string, targetPage: number) => {
        commitSnapshot();
        const start = Math.max(0, startPage - 1);
        const end = Math.min(pageOrder.length - 1, endPage - 1);
        if (start > end) return;
        const indicesToMove = new Set<number>();
        for (let i = start; i <= end; i++) indicesToMove.add(i);
        let targetIndex = 0;
        if (targetType === 'before_first') targetIndex = 0;
        else if (targetType === 'after_last') targetIndex = pageOrder.length;
        else targetIndex = Math.max(0, Math.min(pageOrder.length, targetPage));
        const newOrder: number[] = [];
        const newIds: string[] = [];
        const movedPages: number[] = [];
        const movedIds: string[] = [];
        for (let i = 0; i < pageOrder.length; i++) { if (indicesToMove.has(i)) { movedPages.push(pageOrder[i]); movedIds.push(pageInstanceIds[i]); } }
        for (let i = 0; i <= pageOrder.length; i++) {
            if (i === targetIndex) { newOrder.push(...movedPages); newIds.push(...movedIds); }
            if (i < pageOrder.length && !indicesToMove.has(i)) { newOrder.push(pageOrder[i]); newIds.push(pageInstanceIds[i]); }
        }
        applyOrderChange(newOrder, newIds);
        // Thứ tự đổi → selection cũ trỏ sai trang. Reset sạch (xem handlePageToolsDuplicate).
        setSelectedIndices(new Set());
        setLastSelectedIndex(null);
    };

    const handlePageToolsDelete = (target: 'current' | 'range', range: [number, number], filter: string) => {
        commitSnapshot();
        const deleteIndices = new Set<number>();
        if (target === 'current') { deleteIndices.add(activePage - 1); }
        else {
            const s = Math.max(0, range[0] - 1); const e = Math.min(pageOrder.length - 1, range[1] - 1);
            for (let i = s; i <= e; i++) {
                const pn = i + 1;
                if (filter === 'odd' && pn % 2 === 0) continue;
                if (filter === 'even' && pn % 2 !== 0) continue;
                deleteIndices.add(i);
            }
        }
        const keep = (_: unknown, idx: number) => !deleteIndices.has(idx);
        const afterDelete = pageOrder.filter(keep);
        const afterIds = pageInstanceIds.filter(keep);
        applyOrderChange(afterDelete, afterIds);
        const nextActiveIndex = resolveActiveViewerIndexAfterRemoval(activePage, pageInstanceIds, afterIds);
        setActivePage(nextActiveIndex >= 0 ? nextActiveIndex + 1 : 1);
        setSelectedIndices(new Set(nextActiveIndex >= 0 ? [nextActiveIndex] : []));
        setLastSelectedIndex(nextActiveIndex >= 0 ? nextActiveIndex : null);
    };

    const handlePageToolsRotate = (target: string, range: [number, number], filter: string, degrees: number) => {
        commitSnapshot();
        const rotateIndices = new Set<number>();
        if (target === 'current') { rotateIndices.add(activePage - 1); }
        else if (target === 'all') { for (let i = 0; i < pageOrder.length; i++) { const pn = i + 1; if (filter === 'odd' && pn % 2 === 0) continue; if (filter === 'even' && pn % 2 !== 0) continue; rotateIndices.add(i); } }
        else { const s = Math.max(0, range[0] - 1); const e = Math.min(pageOrder.length - 1, range[1] - 1); for (let i = s; i <= e; i++) { const pn = i + 1; if (filter === 'odd' && pn % 2 === 0) continue; if (filter === 'even' && pn % 2 !== 0) continue; rotateIndices.add(i); } }
        const newRot = { ...pageRotations };
        // Rotation keyed theo INSTANCE-ID → mỗi index xoay độc lập, không cần dedupe.
        for (const idx of rotateIndices) {
            const id = pageInstanceIds[idx];
            if (!id) continue;
            newRot[id] = ((newRot[id] || 0) + degrees) % 360;
        }
        setPageRotations(newRot);
    };

    const handleInsertBlankPage = (insertLocation: 'after' | 'before', insertTarget: 'first' | 'last' | 'page', insertTargetPage: number) => {
        commitSnapshot();
        let ti = 0;
        if (insertTarget === 'first') ti = insertLocation === 'before' ? 0 : 1;
        else if (insertTarget === 'last') ti = insertLocation === 'before' ? pageOrder.length - 1 : pageOrder.length;
        else { const p = Math.max(1, Math.min(pageOrder.length, insertTargetPage)); ti = insertLocation === 'before' ? p - 1 : p; }
        const newOrder = [...pageOrder];
        const newIds = [...pageInstanceIds];
        newOrder.splice(ti, 0, -1);
        newIds.splice(ti, 0, genPageId());
        applyOrderChange(newOrder, newIds);
        // Chèn trang → index cũ dịch → selectedIndices trỏ sai trang. Reset về rỗng.
        setSelectedIndices(new Set());
        setLastSelectedIndex(null);
        setIsInsertModalOpen(false);
        setContextMenu(null);
    };

    const handleExtractPages = async (extractPagesStr: string, extractDeleteAfter: boolean) => {
        if (extractInFlightRef.current) return;
        const indicesToExtract = new Set<number>();
        const parts = extractPagesStr.split(',');
        for (const p of parts) {
            const trimmed = p.trim();
            if (trimmed.includes('-')) {
                const [s, e] = trimmed.split('-');
                const start = parseInt(s); const end = parseInt(e);
                if (!isNaN(start) && !isNaN(end)) { for (let i = Math.min(start, end); i <= Math.max(start, end); i++) { if (i >= 1 && i <= pageOrder.length) indicesToExtract.add(i - 1); } }
            } else { const val = parseInt(trimmed); if (!isNaN(val) && val >= 1 && val <= pageOrder.length) indicesToExtract.add(val - 1); }
        }
        if (indicesToExtract.size > 0 && onExtractPages) {
            const sorted = Array.from(indicesToExtract).sort((a, b) => a - b);
            extractInFlightRef.current = true;
            let extracted = false;
            try {
                // REVISION (audit 2026-08-25 §REV.07): parent nhận VỊ TRÍ Working
                // PDF. Chỉ ghi Undo/xóa trang sau khi artifact đã tạo và mở tab thành công.
                extracted = await onExtractPages(sorted, extractDeleteAfter);
            } catch (error) {
                toast.error(error instanceof Error ? error.message : t('misc.acrobatViewer:loi_trich_xuat'));
            } finally {
                extractInFlightRef.current = false;
            }
            if (shouldRemovePagesAfterExtract(extracted, extractDeleteAfter)) {
                commitSnapshot();
                const keep = (_: unknown, idx: number) => !indicesToExtract.has(idx);
                const afterOrder = pageOrder.filter(keep);
                const afterIds = pageInstanceIds.filter(keep);
                applyOrderChange(afterOrder, afterIds);
                const nextActiveIndex = resolveActiveViewerIndexAfterRemoval(activePage, pageInstanceIds, afterIds);
                setActivePage(nextActiveIndex >= 0 ? nextActiveIndex + 1 : 1);
                setSelectedIndices(new Set(nextActiveIndex >= 0 ? [nextActiveIndex] : []));
                setLastSelectedIndex(nextActiveIndex >= 0 ? nextActiveIndex : null);
            }
        }
        setIsExtractModalOpen(false);
        setContextMenu(null);
    };

    const handlePageToolsInsertBlank = (location: 'after' | 'before', target: 'first' | 'last' | 'page', targetPage: number, count: number) => {
        commitSnapshot();
        const n = Math.max(1, Math.min(999, count || 1));
        let ti = 0;
        if (target === 'first') ti = location === 'before' ? 0 : 1;
        else if (target === 'last') ti = location === 'before' ? pageOrder.length - 1 : pageOrder.length;
        else { const p = Math.max(1, Math.min(pageOrder.length, targetPage)); ti = location === 'before' ? p - 1 : p; }
        ti = Math.max(0, Math.min(pageOrder.length, ti));
        const newOrder = [...pageOrder];
        const newIds = [...pageInstanceIds];
        newOrder.splice(ti, 0, ...Array(n).fill(-1));
        newIds.splice(ti, 0, ...genPageIds(n));
        applyOrderChange(newOrder, newIds);
        // Chèn trang → index cũ dịch → selectedIndices trỏ sai trang. Reset về rỗng.
        setSelectedIndices(new Set());
        setLastSelectedIndex(null);
    };

    const handlePageToolsExtract = (range: [number, number], deleteAfter: boolean) => {
        const start = Math.min(range[0], range[1]);
        const end = Math.max(range[0], range[1]);
        void handleExtractPages(`${start}-${end}`, deleteAfter);
    };

    pageToolsHandlersRef.current = {
        duplicate: handlePageToolsDuplicate,
        move: handlePageToolsMove,
        delete: handlePageToolsDelete,
        rotate: handlePageToolsRotate,
        insertBlank: handlePageToolsInsertBlank,
        extract: handlePageToolsExtract,
    };
    // Copy/Move trang từ file khác vào file này (kéo-thả + menu chuột phải).
    // mode='move' → sau khi copy xong báo file nguồn xóa trang (event riêng).
    // notify=true chỉ khi gọi từ menu (kéo-thả giữ im lặng như cũ).
    const handleCrossFileDrop = async (
        sourcePdfUrl: string,
        sourcePageNums: number[],
        insertDropIndex: number,
        mode: 'copy' | 'move' = 'copy',
        sourceIndices?: number[],
        notify = false,
    ) => {
        if (!pdfUrl) return;
        try {
            commitSnapshot();
            setIsProcessing(true);
            setProcessStatus(
                mode === 'move'
                    ? t('misc.acrobatViewer:dang_di_chuyen_trang')
                    : t('misc.acrobatViewer:dang_sao_chep_trang'),
            );

            const { PDFDocument } = await import('pdf-lib');
            const srcResp = await fetch(sourcePdfUrl);
            const srcDoc = await PDFDocument.load(await srcResp.arrayBuffer());

            const tgtResp = await fetch(pdfUrl);
            const tgtDoc = await PDFDocument.load(await tgtResp.arrayBuffer());

            const copiedPages = await tgtDoc.copyPages(srcDoc, sourcePageNums.map(n => n - 1));
            copiedPages.forEach(p => tgtDoc.addPage(p));

            const newBytes = await tgtDoc.save();
            const newFile = new File([newBytes.buffer as ArrayBuffer], file?.name || 'Merged.pdf', { type: 'application/pdf' });
            // Đánh dấu in-memory — buộc Lưu trước khi thoát (file blob mới).
            try { Object.defineProperty(newFile, 'isInMemory', { value: true }); } catch { /* ignore */ }

            const newOrder = [...pageOrder];
            // Trang mới được addPage ở cuối → số trang gốc tuần tự từ (count - n + 1)
            const newOriginalNum = tgtDoc.getPageCount() - copiedPages.length;
            const firstNewVisualIdx = Math.max(0, Math.min(insertDropIndex, newOrder.length));
            for (let i = 0; i < copiedPages.length; i++) {
                newOrder.splice(insertDropIndex + i, 0, newOriginalNum + i + 1);
            }
            const newPdfUrl = URL.createObjectURL(newFile);
            // Scope theo URL đích — tránh tab khác nuốt order rồi xóa global.
            (window as Window & { __prynx_cross_file_page_order?: CrossFilePageOrder }).__prynx_cross_file_page_order = {
                pdfUrl: newPdfUrl,
                order: newOrder,
                focusIndex: firstNewVisualIdx,
            };

            setFile(newFile);
            setPdfUrl(newPdfUrl);
            setViewerDirty(true);

            // Move: báo file nguồn xóa các index đã chọn (chỉ sau khi copy thành công)
            if (mode === 'move' && sourceIndices && sourceIndices.length > 0) {
                window.dispatchEvent(new CustomEvent('prynx-cross-file-source-remove', {
                    detail: { sourcePdfUrl, sourceIndices },
                }));
            }

            if (notify) {
                const toastKey = mode === 'move'
                    ? 'misc.acrobatViewer:da_di_chuyen_trang_sang'
                    : 'misc.acrobatViewer:da_copy_trang_sang';
                toast.success(t(toastKey, {
                    count: copiedPages.length,
                    name: file?.name || 'PDF',
                }));
            }
        } catch (e) {
            console.error('Cross-file transfer failed', e);
            if (notify) toast.error(t('misc.acrobatViewer:khong_the_copy_sang_file'));
        } finally {
            setIsProcessing(false);
        }
    };

    // Menu chuột phải: copy/move → mở dialog chọn vị trí chèn (đầu/cuối/trước/sau trang N).
    const handleTransferToOtherFile = (
        targetPdfUrl: string,
        mode: 'copy' | 'move',
        targetTabId?: string,
        targetNumPages?: number,
        targetName?: string,
    ) => {
        if (!pdfUrl) return;
        const sel = Array.from(selectedIndices).sort((a, b) => a - b);
        if (sel.length === 0) return;

        // Trang trắng (pageOrder = -1) không có trong PDF gốc → bỏ qua.
        const pairs = sel
            .map(idx => ({ idx, pageNum: pageOrder[idx] }))
            .filter(p => p.pageNum > 0);
        if (pairs.length === 0) {
            toast.info(t('misc.acrobatViewer:khong_co_trang_hop_le'));
            setContextMenu(null);
            return;
        }

        setContextMenu(null);
        setCrossFileInsertPending({
            targetPdfUrl,
            targetTabId,
            targetName: targetName || 'PDF',
            targetNumPages: typeof targetNumPages === 'number' ? targetNumPages : 0,
            mode,
            sourcePageNums: pairs.map(p => p.pageNum),
            sourceIndices: pairs.map(p => p.idx),
        });
    };

    const confirmCrossFileInsert = (dropIndex: number) => {
        const p = crossFileInsertPending;
        if (!p || !pdfUrl) {
            setCrossFileInsertPending(null);
            return;
        }
        window.dispatchEvent(new CustomEvent('prynx-cross-file-drop', {
            detail: {
                sourcePdfUrl: pdfUrl,
                sourcePageNums: p.sourcePageNums,
                targetPdfUrl: p.targetPdfUrl,
                targetTabId: p.targetTabId,
                dropIndex, // 0 = đầu, n = cuối, k = trước trang k+1 / sau trang k
                mode: p.mode,
                sourceIndices: p.sourceIndices,
                fromMenu: true,
            },
        }));
        setCrossFileInsertPending(null);
    };

    const handleCrossFileDropRef = useRef(handleCrossFileDrop);
    handleCrossFileDropRef.current = handleCrossFileDrop;

    useEffect(() => {
        const handleCrossFileEvent = (event: Event) => {
            const { sourcePdfUrl, sourcePageNums, targetPdfUrl, targetTabId, dropIndex, mode, sourceIndices, fromMenu } = (event as CustomEvent<CrossFileDropDetail>).detail ?? {};
            if (targetPdfUrl === pdfUrl && sourcePdfUrl && sourcePageNums) {
                const insertIdx = dropIndex !== null && dropIndex !== undefined ? dropIndex : pageOrder.length;
                // Gắn tabId đích vào handler (để sau khi xong chuyển tab) — ưu tiên detail.
                const run = handleCrossFileDropRef.current(
                    sourcePdfUrl,
                    sourcePageNums,
                    insertIdx,
                    mode === 'move' ? 'move' : 'copy',
                    sourceIndices,
                    !!fromMenu,
                );
                // Sau copy xong: focus tab đích (targetTabId từ menu, hoặc tabId của viewer này).
                if (fromMenu) {
                    Promise.resolve(run).then(() => {
                        const focusId = targetTabId || tabId;
                        if (focusId) {
                            window.dispatchEvent(new CustomEvent('prynx-activate-tab', {
                                detail: { tabId: focusId, reason: 'cross-file-transfer' },
                            }));
                        }
                    }).catch(() => { /* toast đã báo lỗi */ });
                }
            }
        };
        window.addEventListener('prynx-cross-file-drop', handleCrossFileEvent);
        return () => window.removeEventListener('prynx-cross-file-drop', handleCrossFileEvent);
    }, [pdfUrl, pageOrder, tabId]);

    // Move sang file khác: file nguồn nhận event và xóa các trang đã chuyển.
    useEffect(() => {
        const handleSourceRemove = (event: Event) => {
            const { sourcePdfUrl, sourceIndices } = (event as CustomEvent<CrossFileSourceRemoveDetail>).detail ?? {};
            if (sourcePdfUrl !== pdfUrl) return;
            if (!Array.isArray(sourceIndices) || sourceIndices.length === 0) return;

            commitSnapshot();
            const toRemove = new Set<number>(sourceIndices);
            const keep = (_: unknown, idx: number) => !toRemove.has(idx);
            const after = pageOrder.filter(keep);
            const afterIds = pageInstanceIds.filter(keep);
            applyOrderChange(after, afterIds);
            const nextActiveIndex = resolveActiveViewerIndexAfterRemoval(activePage, pageInstanceIds, afterIds);
            setActivePage(nextActiveIndex >= 0 ? nextActiveIndex + 1 : 1);
            setSelectedIndices(new Set(nextActiveIndex >= 0 ? [nextActiveIndex] : []));
            setLastSelectedIndex(nextActiveIndex >= 0 ? nextActiveIndex : null);
        };
        window.addEventListener('prynx-cross-file-source-remove', handleSourceRemove);
        return () => window.removeEventListener('prynx-cross-file-source-remove', handleSourceRemove);
    }, [pdfUrl, pageOrder, pageInstanceIds, activePage, commitSnapshot, applyOrderChange, setActivePage, setLastSelectedIndex, setSelectedIndices]);

    // ═══ Guide handlers ═══
    const guidesRef = useRef<Guide[]>([]);
    useEffect(() => { guidesRef.current = guides; }, [guides]);
    // Giữ activePage cho handler (useCallback [] → tránh stale closure).
    const activePageRef = useRef(activePage);
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);

    // Đổi toạ độ chuột (client) → pos guide lưu theo MÉP TRANG thật (khớp GuideLayer/Ruler).
    // Fallback về hệ gốc-cuộn cũ nếu không tìm thấy trang active.
    const clientToGuidePos = useCallback((clientX: number, clientY: number, orientation: 'horizontal' | 'vertical') => {
        const anchorEl = internalScrollRef.current?.querySelector<HTMLElement>(`#pdf-page-container-${activePageRef.current}`) || null;
        if (anchorEl) {
            const pr = anchorEl.getBoundingClientRect();
            const size = orientation === 'horizontal' ? pr.height : pr.width;
            if (size <= 0) return 0;
            return orientation === 'horizontal' ? (clientY - pr.top) / size : (clientX - pr.left) / size;
        }
        // Fallback: hệ cũ (mép container + scroll)
        const scrollContainer = internalScrollRef.current;
        const viewerContainer = containerRef.current;
        if (!scrollContainer || !viewerContainer) return orientation === 'horizontal' ? clientY : clientX;
        const rect = viewerContainer.getBoundingClientRect();
        return orientation === 'horizontal'
            ? (clientY - rect.top) + scrollContainer.scrollTop
            : (clientX - rect.left) + scrollContainer.scrollLeft;
    }, []);

    const activePagePhysical = useMemo(() => {
        const sourcePage = pageOrder[activePage - 1] || activePage;
        const pageInstanceId = pageInstanceIds[activePage - 1] || null;
        const rawRotation = (pageInstanceId ? pageRotations[pageInstanceId] : 0) || 0;
        const rotation = ((rawRotation % 360) + 360) % 360;
        const dim = allPageDims[sourcePage] || pageDim;
        if (!dim) {
            return {
                viewerPage: activePage,
                sourcePage,
                pageInstanceId,
                rotation,
                widthPt: pageWidthPt || 0,
                heightPt: 0,
            };
        }
        const widthPt = dim.w * 72 / 96;
        const heightPt = dim.h * 72 / 96;
        const rotated = rotation === 90 || rotation === 270;
        return {
            viewerPage: activePage,
            sourcePage,
            pageInstanceId,
            rotation,
            widthPt: rotated ? heightPt : widthPt,
            heightPt: rotated ? widthPt : heightPt,
        };
    }, [activePage, pageOrder, allPageDims, pageDim, pageWidthPt, pageInstanceIds, pageRotations]);

    const setViewerActivePagePhysical = useWorkspaceStore(
        state => state.setViewerActivePagePhysical,
    );
    useEffect(() => {
        if (activePagePhysical.widthPt <= 0 || activePagePhysical.heightPt <= 0) {
            setViewerActivePagePhysical(null);
            return;
        }
        // PERF/QUALITY (feedback 2026-08-19 §CUTPREVIEW.INSTANT2): công cụ bế cần
        // khổ in thật của đúng instance trang đang xem. Không tái sử dụng CSS-mm của
        // VDP vì đơn vị đó lớn hơn mm vật lý 96/72 lần và không theo reorder/rotation.
        setViewerActivePagePhysical({
            documentIdentity: workspaceDocumentIdentity(
                file,
                pageOrder,
                flattenRotations(pageInstanceIds, pageRotations),
            ),
            ...activePagePhysical,
        });
    }, [
        activePagePhysical,
        file,
        pageInstanceIds,
        pageOrder,
        pageRotations,
        setViewerActivePagePhysical,
    ]);

    const lastDimHintAtRef = useRef(0);
    const dimHintToastIdRef = useRef<number | null>(null);

    useEffect(() => {
        if (toolMode === 'dimension' || dimHintToastIdRef.current === null) return;
        toast.dismiss(dimHintToastIdRef.current);
        dimHintToastIdRef.current = null;
    }, [toolMode]);

    const handleDimensionPlacement = useCallback((e: React.MouseEvent) => {
        // Chỉ chuột trái — tránh nhầm với context menu / nút khác.
        if (e.button !== 0) return;
        const anchor = internalScrollRef.current?.querySelector(`#pdf-page-container-${activePage}`) as HTMLElement | null;
        if (!anchor) return;
        const pr = anchor.getBoundingClientRect();

        // Ratio theo mép trang; CÓ THỂ <0 hoặc >1 — DIM được phép đặt ngoài trang
        // (hai guide vẫn khóa hai đầu đo; offsetRatio chỉ là vị trí vẽ nhãn).
        const xRatio = (e.clientX - pr.left) / pr.width;
        const yRatio = (e.clientY - pr.top) / pr.height;

        const candidate = findDimensionCandidate(guides, xRatio, yRatio, activePagePhysical.widthPt, activePagePhysical.heightPt);
        if (!candidate) {
            // Rate-limit: tránh spam toast mỗi cú click / nhầm với thao tác tắt tool.
            const now = Date.now();
            if (now - lastDimHintAtRef.current > 2500) {
                lastDimHintAtRef.current = now;
                if (dimHintToastIdRef.current !== null) {
                    toast.dismiss(dimHintToastIdRef.current);
                }
                dimHintToastIdRef.current = toast.info('Kéo hai guide cùng hướng từ thước, rồi bấm vào khoảng giữa chúng để đặt DIM.\n(Phím D hoặc Esc để tắt DIM)');
            }
            return;
        }
        const offsetRatio = candidate.orientation === 'horizontal' ? yRatio : xRatio;
        setDimensions(prev => {
            const existing = prev.find(d => d.page === activePage && d.orientation === candidate.orientation &&
                ((d.guideAId === candidate.guideAId && d.guideBId === candidate.guideBId) || (d.guideAId === candidate.guideBId && d.guideBId === candidate.guideAId)));
            if (existing) return prev.map(d => d.id === existing.id ? { ...d, offsetRatio } : d);
            return [...prev, { id: `dim-${Date.now()}`, page: activePage, ...candidate, offsetRatio }];
        });
        e.preventDefault();
        e.stopPropagation();
    }, [activePage, guides, activePagePhysical]);
    const handleRulerMouseDown = useCallback((e: React.MouseEvent, orientation: 'horizontal' | 'vertical') => {
        // UIUX (audit 2026-07-27 §C-04) fix-verify: chỉ chuột trái kéo guide — chuột phải
        // dành cho onCycleUnit (đổi đơn vị), nếu không lọc sẽ tạo guide "ma".
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const scrollContainer = internalScrollRef.current;
        const viewerContainer = containerRef.current;
        if (!scrollContainer || !viewerContainer) return;
        const rect = viewerContainer.getBoundingClientRect();
        const newGuideId = Date.now().toString();
        setDraggingGuide({ id: newGuideId, type: orientation, pos: clientToGuidePos(e.clientX, e.clientY, orientation) });
        setSelectedGuideId(newGuideId);
        const handleMouseMove = (moveEvent: MouseEvent) => {
            setDraggingGuide({ id: newGuideId, type: orientation, pos: clientToGuidePos(moveEvent.clientX, moveEvent.clientY, orientation) });
        };
        const handleMouseUp = (upEvent: MouseEvent) => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            const uClientPos = orientation === 'horizontal' ? upEvent.clientY - rect.top : upEvent.clientX - rect.left;
            if (uClientPos < 0) { setDraggingGuide(null); setSelectedGuideId(null); return; }
            const finalPos = clientToGuidePos(upEvent.clientX, upEvent.clientY, orientation);
            setGuidesHistory(prev => [...prev, guidesRef.current]);
            setGuides(prev => [...prev, { id: newGuideId, type: orientation, pos: finalPos }]);
            setDraggingGuide(null);
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [clientToGuidePos]);

    const handleGuideMouseDown = useCallback((e: React.MouseEvent, guide: Guide) => {
        e.preventDefault(); e.stopPropagation();
        const scrollContainer = internalScrollRef.current;
        const viewerContainer = containerRef.current;
        if (!scrollContainer || !viewerContainer) return;
        const rect = viewerContainer.getBoundingClientRect();
        setSelectedGuideId(guide.id);
        setGuidesHistory(prev => [...prev, guidesRef.current]);
        setGuides(prev => prev.filter(g => g.id !== guide.id));
        setDraggingGuide(guide);
        const handleMouseMove = (moveEvent: MouseEvent) => {
            setDraggingGuide({ ...guide, pos: clientToGuidePos(moveEvent.clientX, moveEvent.clientY, guide.type) });
        };
        const handleMouseUp = (upEvent: MouseEvent) => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            const uClientPos = guide.type === 'horizontal' ? upEvent.clientY - rect.top : upEvent.clientX - rect.left;
            if (uClientPos < 0) { setDraggingGuide(null); setSelectedGuideId(null); return; }
            const finalPos = clientToGuidePos(upEvent.clientX, upEvent.clientY, guide.type);
            setGuides(prev => [...prev, { ...guide, pos: finalPos }]);
            setDraggingGuide(null);
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [clientToGuidePos]);

    // UIUX (audit 2026-07-27 §C-01): chuột GIỮA = pan tạm thời (giữ-kéo) bất kể tool
    // đang chọn. Kéo scrollLeft/scrollTop của container cuộn qua listener window để
    // không mất sự kiện khi con trỏ rời viewer; cursor 'grabbing' toàn cục trong lúc kéo.
    // UIUX (audit 2026-07-27 §C-01) fix-verify: 1 hàm cleanup dùng chung, lưu vào ref —
    // mouseup rơi ngoài cửa sổ (Alt+Tab), window blur hay unmount đều gỡ listener + cursor.
    const middlePanCleanupRef = useRef<(() => void) | null>(null);
    useEffect(() => () => { middlePanCleanupRef.current?.(); }, []);
    const handleMiddlePanStart = useCallback((e: React.MouseEvent) => {
        const scroller = internalScrollRef.current;
        if (!scroller) return;
        e.preventDefault(); // chặn autoscroll mặc định của Chromium khi bấm chuột giữa
        middlePanCleanupRef.current?.(); // phòng phiên pan trước còn kẹt
        const startX = e.clientX, startY = e.clientY;
        const startLeft = scroller.scrollLeft, startTop = scroller.scrollTop;
        const styleEl = document.createElement('style');
        styleEl.textContent = '*{cursor:grabbing!important}';
        document.head.appendChild(styleEl);
        const cleanup = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', cleanup);
            styleEl.remove();
            middlePanCleanupRef.current = null;
        };
        const onMove = (me: MouseEvent) => {
            // Nhả chuột giữa NGOÀI cửa sổ → mousemove sau đó không còn bit 4 → dọn ngay.
            if (!(me.buttons & 4)) { cleanup(); return; }
            scroller.scrollLeft = startLeft - (me.clientX - startX);
            scroller.scrollTop = startTop - (me.clientY - startY);
        };
        const onUp = (ue: MouseEvent) => {
            if (ue.button !== 1) return; // chỉ kết thúc khi nhả đúng chuột giữa
            cleanup();
        };
        middlePanCleanupRef.current = cleanup;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('blur', cleanup);
    }, []);

    // ═══ Scroll Sync ═══
    const scrollTimeout = useRef<number | null>(null);
    const scrollSelectionRef = useRef(selectedIndices);
    scrollSelectionRef.current = selectedIndices;
    const scrollAnchorRef = useRef(lastSelectedIndex);
    scrollAnchorRef.current = lastSelectedIndex;

    const handleMainScroll = useCallback((e: Event) => {
        const scrollSource = e.currentTarget instanceof HTMLElement ? e.currentTarget : e.target instanceof HTMLElement ? e.target : null;
        if (!isActive || !scrollSource) return;
        if (scrollSource.dataset.isNavigating === 'true') return;
        if (pageDisplayMode.includes('_fit') || isZoomingRef.current) return;
        if (mainVirtuosoRef.current?.__thumbClickActive) return;
        if (scrollTimeout.current) window.clearTimeout(scrollTimeout.current);
        scrollTimeout.current = window.setTimeout(() => {
            scrollTimeout.current = null;
            const src = scrollSource;
            if (!src.isConnected || numPages <= 0) return;

            const containerRect = src.getBoundingClientRect();
            const targetX = containerRect.left + containerRect.width / 2;
            const targetY = containerRect.top + containerRect.height / 3;
            let bestPage: number | null = null;
            let hitEl = document.elementFromPoint(targetX, targetY) as HTMLElement | null;
            while (hitEl && hitEl !== src) {
                if (hitEl.id?.startsWith('pdf-page-container-')) {
                    bestPage = parseInt(hitEl.id.replace('pdf-page-container-', ''), 10);
                    break;
                }
                hitEl = hitEl.parentElement;
            }
            if (!bestPage) {
                const scrollPercent = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
                bestPage = Math.min(numPages, Math.max(1, Math.round(scrollPercent * numPages) + 1));
            }

            const idx = bestPage - 1;
            if (idx < 0 || idx >= pageOrder.length) return;

            if (activePageRef.current !== bestPage) {
                activePageRef.current = bestPage;
                setActivePage(bestPage);
            }

            const currentSelection = scrollSelectionRef.current;
            if (currentSelection.size <= 1) {
                const nextSelection = selectionAfterViewerScroll(currentSelection, bestPage, pageOrder.length);
                if (nextSelection !== currentSelection) {
                    scrollSelectionRef.current = nextSelection;
                    setSelectedIndices(nextSelection);
                }
                // Đồng bộ anchor shift-select theo VỊ TRÍ trang trong Viewer; pageOrder
                // chứa số trang nguồn nên không được dùng indexOf(bestPage).
                if (scrollAnchorRef.current !== idx) {
                    scrollAnchorRef.current = idx;
                    setLastSelectedIndex(idx);
                }
            }
        }, 150);
    }, [isActive, numPages, pageDisplayMode, pageOrder.length, setActivePage, setSelectedIndices, setLastSelectedIndex, isZoomingRef]);

    useEffect(() => () => {
        if (scrollTimeout.current) window.clearTimeout(scrollTimeout.current);
    }, []);

    // Virtuoso components PHẢI ổn định identity. Trước đây Scroller/List định nghĩa inline
    // bằng forwardRef trong JSX → mỗi render tạo component type MỚI → Virtuoso thay Scroller,
    // chạy lại mount-effect đo size → setState nội bộ → re-render → lặp vô hạn ("Maximum update
    // depth") khi đổi zoom/mode (parent re-render dồn). Memo hoá 1 lần; Scroller đọc handler mới
    // nhất qua ref nên không cần phụ thuộc identity của handleMainScroll/updateViewportRect.
    const scrollHandlersRef = useRef({ handleMainScroll, updateViewportRect });
    scrollHandlersRef.current = { handleMainScroll, updateViewportRect };
    const centerVirtuosoListRef = useRef(false);

    const virtuosoComponents = useMemo<Components<ViewerRow, unknown>>(() => ({
        Scroller: forwardRef<HTMLDivElement, ScrollerProps & { onScroll?: UIEventHandler<HTMLDivElement> }>((props, ref) => (
            <div {...props} ref={ref} onScroll={(e) => { scrollHandlersRef.current.handleMainScroll(e.nativeEvent); scrollHandlersRef.current.updateViewportRect(); props.onScroll?.(e); }} className="acro-scroll outline-none" style={{ height: '100%', width: '100%', ...props.style, overflowX: 'auto', overflowY: 'auto' }} />
        )),
        List: forwardRef<HTMLDivElement, ListProps>((props, ref) => {
            const centerSingleRow = centerVirtuosoListRef.current;
            return (
                <div
                    {...props}
                    ref={ref}
                    data-prynx-center-single-row={centerSingleRow ? 'true' : undefined}
                    style={{
                        minHeight: '100%',
                        ...props.style,
                        minWidth: '100%',
                        width: 'max-content',
                        ...(centerSingleRow
                            ? { display: 'flex', flexDirection: 'column', justifyContent: 'safe center' }
                            : {}),
                    }}
                />
            );
        }),
    }), []);
    // Virtuoso gắn listener + phát trạng thái scroll đồng bộ mỗi khi scrollerRef đổi
    // identity. Callback inline biến mọi parent render thành một lượt đo layout mới.
    const handleVirtuosoScrollerRef = useCallback((el: HTMLElement | Window | null) => {
        internalScrollRef.current = el instanceof HTMLElement ? el : null;
    }, []);


    // UIUX (audit 2026-08-23 §VIEWER.STALE.01): itemContent giữ identity qua ref
    // nên Virtuoso không tự gọi lại item đang mount khi một overlay/đầu vào trình bày
    // đổi. Revision này chỉ theo dõi dữ liệu hiển thị đổi theo sự kiện (không theo zoom
    // hoặc pan nóng), nhờ đó edit/OCG/Output Preview/reorder/text async xuất hiện ngay.
    const virtuosoPresentationRevision = useMemo(() => ({
        pageOrder,
        pageInstanceIds,
        pageRotations,
        pageDisplayMode,
        activePage,
        allPageDims,
        pageDim,
        actualWidth100,
        physicalDisplayScale,
        physicalDisplayDpr,
        physicalRawDpi,
        bleedView,
        ocgPreviewUrl,
        viewerSimulationProfileId,
        viewerSimulationIntent,
        viewerOutputPreviewProofIdentity,
        accurateColorEnabled,
        accurateColorPages,
        viewerEngineMode,
        nativeTextBlocks,
        plateLabels,
        detectedDimensionsByPage,
        editPreviews: editSession?.previews,
        pageOverlayPage,
        pageOverlayViewerPage,
        pageOverlayInstanceId,
        pdfUrl,
        isActive,
        isVdpMode,
        activeDashboardTool,
        renderOwnerId,
        renderDocumentToken,
        accuratePrefetchReady,
        toolMode,
    }), [
        pageOrder,
        pageInstanceIds,
        pageRotations,
        pageDisplayMode,
        activePage,
        allPageDims,
        pageDim,
        actualWidth100,
        physicalDisplayScale,
        physicalDisplayDpr,
        physicalRawDpi,
        bleedView,
        ocgPreviewUrl,
        viewerSimulationProfileId,
        viewerSimulationIntent,
        viewerOutputPreviewProofIdentity,
        accurateColorEnabled,
        accurateColorPages,
        viewerEngineMode,
        nativeTextBlocks,
        plateLabels,
        detectedDimensionsByPage,
        editSession?.previews,
        pageOverlayPage,
        pageOverlayViewerPage,
        pageOverlayInstanceId,
        pdfUrl,
        isActive,
        isVdpMode,
        activeDashboardTool,
        renderOwnerId,
        renderDocumentToken,
        accuratePrefetchReady,
        toolMode,
    ]);

    // Ổn định context khi không có thay đổi trình bày; khi revision đổi, Virtuoso
    // render lại các row đang mount mà không cần người dùng zoom/scroll để đánh thức.
    const virtuosoContext = useMemo(
        () => createViewerVirtualizationContext(
            highlightBoxes,
            pageOverlay,
            pageOverlayRenderer,
            virtuosoPresentationRevision,
        ),
        [highlightBoxes, pageOverlay, pageOverlayRenderer, virtuosoPresentationRevision],
    );
    const virtuosoOverscan = useMemo(() => {
        const margin = Math.max(1000, 2000 / zoom);
        return { top: margin, bottom: margin };
    }, [zoom]);

    // ═══ Render Rows Memoization ═══
    const visitedIndicesRef = useRef<Set<number>>(new Set());

    const scrollRowsMemo = useMemo(() => {
        if (!pageOrder || pageOrder.length === 0) return [];
        if (pageDisplayMode === 'single_scroll') return pageOrder.map((p, i): ViewerRow => ({ type: 'single', indices: [i], pages: [p] }));
        if (pageDisplayMode === 'two_scroll') {
            const rows: ViewerRow[] = [];
            for (let i = 0; i < pageOrder.length; i += 2) {
                const row: ViewerRow = { type: 'two', indices: [i], pages: [pageOrder[i]] };
                if (i + 1 < pageOrder.length) { row.indices.push(i + 1); row.pages.push(pageOrder[i + 1]); }
                rows.push(row);
            }
            return rows;
        }
        return [];
    }, [pageOrder, pageDisplayMode]);

    const fitRowsMemo = useMemo(() => {
        if (!pageOrder || pageOrder.length === 0) return [];
        if (pageDisplayMode === 'single_fit') {
            const idx = Math.max(0, Math.min(activePage - 1, pageOrder.length - 1));
            [idx - 1, idx, idx + 1].forEach(i => { if (i >= 0 && i < pageOrder.length) { visitedIndicesRef.current.delete(i); visitedIndicesRef.current.add(i); } });
            while (visitedIndicesRef.current.size > 15) { const oldest = visitedIndicesRef.current.values().next().value; if (oldest !== undefined) visitedIndicesRef.current.delete(oldest); else break; }
            return Array.from(visitedIndicesRef.current).sort((a, b) => a - b).map(i => ({ type: 'single', indices: [i], pages: [pageOrder[i]] }));
        }
        if (pageDisplayMode === 'two_fit') {
            const idx = Math.max(0, Math.min(activePage - 1, pageOrder.length - 1));
            const rowStart = idx % 2 === 0 ? idx : idx - 1;
            [rowStart - 2, rowStart, rowStart + 2].forEach(r => { if (r >= 0 && r < pageOrder.length) { visitedIndicesRef.current.delete(r); visitedIndicesRef.current.add(r); } });
            while (visitedIndicesRef.current.size > 15) { const oldest = visitedIndicesRef.current.values().next().value; if (oldest !== undefined) visitedIndicesRef.current.delete(oldest); else break; }
            return Array.from(visitedIndicesRef.current).filter(r => r % 2 === 0).sort((a, b) => a - b).map(r => {
                const row: ViewerRow = { type: 'two', indices: [r], pages: [pageOrder[r]] };
                if (r + 1 < pageOrder.length) { row.indices.push(r + 1); row.pages.push(pageOrder[r + 1]); }
                return row;
            });
        }
        return [];
    }, [pageOrder, pageDisplayMode, activePage]);

    const renderRows = pageDisplayMode.includes('scroll') ? scrollRowsMemo : fitRowsMemo;
    centerVirtuosoListRef.current = shouldCenterVirtuosoList(pageDisplayMode, renderRows.length);

    useLayoutEffect(() => {
        if (!isZoomReady || renderRows.length === 0) return;
        applyPendingInitialViewScroll();
    }, [applyPendingInitialViewScroll, isZoomReady, renderRows.length]);

    const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);

    // ═══ Page Renderer ═══
    const renderPdfPage = useCallback((originalPageNum: number, flatIndex?: number) => {
        if (!originalPageNum) return null;
        const plateLabel = plateLabels[originalPageNum];
        // Rotation keyed theo INSTANCE-ID (mỗi vị trí 1 id riêng) → bản nhân bản / trang
        // trắng xoay ĐỘC LẬP. flatIndex = vị trí trong pageOrder → tra id. Fallback về 0
        // khi thiếu index (không nên xảy ra ở luồng render rows).
        const instId = flatIndex !== undefined ? pageInstanceIds[flatIndex] : undefined;
        const viewerPagePosition = (flatIndex ?? (originalPageNum - 1)) + 1;
        const renderedPageInstanceId = instId || `page-${originalPageNum}-${flatIndex ?? 0}`;
        const rot = instId ? (pageRotations[instId] || 0) : 0;
        const localDim = allPageDims[originalPageNum] || pageDim;
        const localWidth100 = localDim ? localDim.w : actualWidth100;
        const accurateColorPage = viewerEngineMode !== 'current'
            || (accurateColorEnabled && accurateColorPages.includes(originalPageNum));
        const framePageOverlay = renderPageOverlayForFrame(pageOverlayRenderer, {
            originalPageNum,
            viewerPagePosition,
            pageInstanceId: renderedPageInstanceId,
            isActivePage: viewerPagePosition === activePage,
        });

        // Show OCG preview overlay on active page when layers are hidden
        const showOcgOverlay = ocgPreviewUrl && viewerPagePosition === activePage;

        return (
            <div id={`pdf-page-container-${(flatIndex ?? (originalPageNum - 1)) + 1}`} className="flex flex-col items-center">
                {plateLabel && <div className="text-[11px] font-semibold text-yellow-400 mb-1 px-2 py-0.5 tracking-wide max-w-full truncate">{plateLabel}</div>}
                <div className="relative">
                    <LivePageFrame
                        tabId={tabId}
                        isViewerActive={isActive}
                        originalPageNum={originalPageNum}
                        viewerPageNum={viewerPagePosition}
                        pageInstanceId={renderedPageInstanceId}
                        actualWidth100={localWidth100}
                        zoom={effectiveZoom}
                        physicalDisplayScale={physicalDisplayScale}
                        displayDevicePixelRatio={physicalDisplayDpr}
                        accurateDpiAnchor={physicalRawDpi ?? 96}
                        rotation={rot}
                        bleedView={bleedView}
                        pageDim={localDim}
                        highlightBoxes={highlightBoxes?.filter(h => Number(h.page) === Number(originalPageNum))}
                        isVdpMode={isVdpMode}
                        onObjectDelete={onObjectDelete}
                        fetchObjectsForPage={fetchObjectsForPage}
                        onEditCommit={onEditCommit}
                        onVdpBoxCreate={onVdpBoxCreate}
                        onVdpBoxSelect={onVdpBoxSelect}
                        onVdpFieldsChange={onVdpFieldsChange}
                        getTileUrl={getTileUrl}
                        renderOwnerId={renderOwnerId}
                        renderDocumentToken={renderDocumentToken}
                        cancelAccurateGroup={cancelAccurateGroup}
                        accurateColorPage={accurateColorPage}
                        accurateColorProfileId={viewerSimulationProfileId}
                        accurateColorIntent={viewerSimulationIntent}
                        accurateColorProofIdentity={viewerOutputPreviewProofIdentity}
                        onFirstPageRenderReady={handleActivePageRenderReady}
                        textBlocks={nativeTextBlocks[originalPageNum]}
                        setHoveredPdfPosition={setHoveredPdfPosition}
                        isBlankDoc={!!(file as ViewerFile)?.isBlank}
                        isImageFile={isImage}
                        nativeFilePath={(file as ViewerFile)?.path}
                        previewRevision={pdfUrl}
                        detectedDimension={activeDashboardTool === 'sticker_imposer' && !file?.name.startsWith('Imposed_') ? detectedDimensionsByPage[originalPageNum - 1] : undefined}
                        editSession={editSession} totalPages={numPages}
                        isActivePage={viewerPagePosition === activePage}
                        prefetchPage={shouldPrefetchViewerPage(isActive !== false, Math.abs(viewerPagePosition - activePage), accurateColorPage, accuratePrefetchReady)}
                    />
                    {pageOverlay && matchesPageOverlayTarget({
                        originalPageNum,
                        viewerPagePosition,
                        pageInstanceId: renderedPageInstanceId,
                        targetSourcePage: pageOverlayPage,
                        targetViewerPage: pageOverlayViewerPage,
                        targetInstanceId: pageOverlayInstanceId,
                    }) && pageOverlay}
                    {framePageOverlay}
                    {showOcgOverlay && <OcgPreviewOverlay url={ocgPreviewUrl} />}
                </div>
            </div>
        );
    }, [pageRotations, pageInstanceIds, allPageDims, pageDim, actualWidth100, effectiveZoom, physicalDisplayScale, physicalDisplayDpr, physicalRawDpi, bleedView, highlightBoxes, isVdpMode, getTileUrl, renderOwnerId, renderDocumentToken, cancelAccurateGroup, accurateColorEnabled, accurateColorPages, viewerSimulationProfileId, viewerSimulationIntent, viewerOutputPreviewProofIdentity, viewerEngineMode, handleActivePageRenderReady, accuratePrefetchReady, nativeTextBlocks, plateLabels, activeDashboardTool, detectedDimensionsByPage, file, ocgPreviewUrl, activePage, editSession, isImage, tabId, isActive, pageOverlay, pageOverlayPage, pageOverlayViewerPage, pageOverlayInstanceId, pageOverlayRenderer, fetchObjectsForPage, numPages, onEditCommit, onObjectDelete, onVdpBoxCreate, onVdpFieldsChange, pdfUrl, setHoveredPdfPosition]);

    const virtuosoItemContentRef = useRef<(index: number) => ReactNode>(() => null);
    virtuosoItemContentRef.current = (index: number) => {
        const row = renderRows[index];
        if (!row) return null;
        return (
            <div className={`flex items-center justify-center min-w-full ${toolMode === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-auto'}`}
                style={{ paddingTop: 32, paddingBottom: 32, paddingLeft: 24, paddingRight: 24, gap: 12, width: 'max-content' }}>
                <div className="flex items-center" style={{ gap: 12 }}>
                    {row.pages.map((p: number, pIdx: number) => <div key={row.indices[pIdx]}>{renderPdfPage(p, row.indices[pIdx])}</div>)}
                </div>
            </div>
        );
    };
    // Prop itemContent ổn định; nội dung mới nhất được đọc qua ref ở trên.
    const virtuosoItemContent = useCallback((index: number) => virtuosoItemContentRef.current(index), []);

    // Kiểm tra loadError SAU khi mọi hook đã được gọi (xem ghi chú ở đầu component).
    if (loadError) {
        return (
            <div className="flex flex-col items-center justify-center h-full w-full bg-red-50 text-red-600 gap-4 p-8 text-center">
                <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h2 className="text-2xl font-bold">{t('misc.acrobatViewer:loi_tai_pdf')}</h2>
                <p className="text-lg font-medium">{t('lib.processHandlers:loi_xu_ly_he_thong')}</p>
                <button 
                    onClick={retryLoad}
                    className="mt-4 px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 font-medium"
                >
                    {t('misc.errorBoundary:thu_lai')}
                </button>
            </div>
        );
    }

    if (loadStatus === 'cancelled') {
        return (
            <div className="flex flex-col items-center justify-center h-full w-full bg-[#525659] text-zinc-100 gap-4 p-8 text-center">
                <p className="text-lg font-medium">{t('shell:err_canceled')}</p>
                <button
                    onClick={retryLoad}
                    className="px-6 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-500 font-medium"
                >
                    {t('misc.errorBoundary:thu_lai')}
                </button>
            </div>
        );
    }

    // ═══ RENDER ═══
    return (
        <div
            className="flex flex-col h-full w-full bg-[#f3f4f6] dark:bg-[#323639] text-slate-800 dark:text-zinc-200 transition-colors overflow-hidden relative font-sans select-none"
            data-prynx-open-pdf={pdfUrl || undefined}
            data-file-name={file?.name || undefined}
            data-prynx-tab-id={tabId || undefined}
            data-prynx-num-pages={pageOrder.length > 0 ? String(pageOrder.length) : (numPages > 0 ? String(numPages) : undefined)}
        >
            <style>{`
                .acro-scroll::-webkit-scrollbar { width: 14px; height: 14px; }
                .acro-scroll::-webkit-scrollbar-track { background: transparent; }
                .acro-scroll::-webkit-scrollbar-thumb { background: #888888; border: 4px solid #525659; border-radius: 8px; }
                .acro-scroll::-webkit-scrollbar-thumb:hover { background: #aaaaaa; }
                /* Đặt trước chỗ cho scrollbar ở cả 2 cạnh → bật/tắt scrollbar không làm co vùng
                   nội dung, tránh hiện tượng "dueling scrollbars" gây nhảy/giật khi zoom. */
                .acro-scroll { scrollbar-gutter: stable both-edges; }
                .acro-thumb-scroll::-webkit-scrollbar { width: 12px; }
                .acro-thumb-scroll::-webkit-scrollbar-track { background: transparent; }
                .acro-thumb-scroll::-webkit-scrollbar-thumb { background: #cccccc; border: 3px solid #f8fafc; border-radius: 6px; }
                .dark .acro-thumb-scroll::-webkit-scrollbar-thumb { background: #555; border: 3px solid #1f2937; }
            `}</style>

            <AcrobatToolbar
                pageOrderLength={pageOrder.length}
                navigatePage={navigatePage}
                applyFitWidth={applyFitWidth}
                applyFitPage={applyFitPage}
                extraActions={<>
                    {file && (
                        <button
                            onClick={() => void openExportImage('export')}
                            title={t('misc.acrobatViewer:xuat_anh_png_jpeg_tiff')}
                            aria-label={t('misc.acrobatViewer:xuat_anh')}
                            className="flex items-center gap-1.5 px-2.5 h-8 rounded text-[13px] font-medium text-slate-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                            <span className="tb-label">{t('misc.acrobatViewer:xuat_anh')}</span>
                        </button>
                    )}
                    {/* Nút khử viền dư */}
                    {file && (
                        <div className="relative" ref={autoTrimPopRef}>
                            <button
                                onClick={() => setIsAutoTrimOpen(!isAutoTrimOpen)}
                                title={t('misc.acrobatViewer:khu_vien_trang_desc')}
                                aria-label={t('misc.acrobatViewer:khu_vien_trang')}
                                disabled={autoTrimBusy}
                                className={`flex items-center gap-1.5 px-2.5 h-8 rounded text-[13px] font-medium transition-colors ${
                                    isAutoTrimOpen
                                        ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300'
                                        : 'text-slate-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10'
                                } disabled:opacity-40`}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
                                <span className="tb-label">{t('misc.acrobatViewer:khu_vien_trang')}</span>
                            </button>
                            {isAutoTrimOpen && (
                                <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-slate-200 dark:border-white/15 p-3 w-56">
                                    {/* Phạm vi */}
                                    <div className="flex gap-2 mb-2">
                                        <button
                                            onClick={() => setAutoTrimScope('all')}
                                            className={`flex-1 text-xs py-1.5 rounded font-medium border transition-colors ${
                                                autoTrimScope === 'all'
                                                    ? 'bg-indigo-600 text-white border-indigo-600'
                                                    : 'bg-slate-50 dark:bg-zinc-700 border-slate-300 dark:border-white/15 text-slate-600 dark:text-zinc-300'
                                            }`}>
                                            {t('misc.acrobatViewer:tat_ca_trang')}
                                        </button>
                                        <button
                                            onClick={() => setAutoTrimScope('current')}
                                            className={`flex-1 text-xs py-1.5 rounded font-medium border transition-colors ${
                                                autoTrimScope === 'current'
                                                    ? 'bg-indigo-600 text-white border-indigo-600'
                                                    : 'bg-slate-50 dark:bg-zinc-700 border-slate-300 dark:border-white/15 text-slate-600 dark:text-zinc-300'
                                            }`}>
                                            {t('misc.acrobatViewer:trang_hien_tai')}
                                        </button>
                                    </div>
                                    <p className="mb-2 text-[10px] leading-4 text-slate-500 dark:text-zinc-400">
                                        {t(
                                            'misc.acrobatViewer:khu_vien_canh_bat_buoc_hint',
                                            'Cạnh đã chọn là bắt buộc. Nếu không dò được phần dư ở một cạnh, PrynX sẽ dừng và không đổi file.',
                                        )}
                                    </p>
                                    {/* UIUX (feedback 2026-08-26 §TRIM.SIDES): cạnh bật là
                                        điều kiện bắt buộc; backend không được âm thầm bỏ qua. */}
                                    <div
                                        role="group"
                                        aria-label={t('misc.acrobatViewer:khu_vien_trang_desc')}
                                        className="grid grid-cols-4 gap-1 mb-2"
                                    >
                                        {AUTO_TRIM_SIDES.map(side => {
                                            const selected = autoTrimSides.includes(side);
                                            return (
                                                <button
                                                    key={side}
                                                    type="button"
                                                    aria-pressed={selected}
                                                    onClick={() => toggleAutoTrimSide(side)}
                                                    className={`h-7 rounded border text-[10px] font-semibold transition-colors ${
                                                        selected
                                                            ? 'border-indigo-600 bg-indigo-600 text-white'
                                                            : 'border-slate-300 bg-slate-50 text-slate-500 dark:border-white/15 dark:bg-zinc-700 dark:text-zinc-300'
                                                    }`}
                                                >
                                                    {selected ? '✓ ' : ''}{tv(AUTO_TRIM_SIDE_LABEL[side])}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {/* Margin */}
                                    <label className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">{t('misc.acrobatViewer:le_bo_sung_mm')}</label>
                                    <input type="number" min={0} max={20} step={0.5} value={autoTrimMargin}
                                        onChange={e => setAutoTrimMargin(Math.min(20, Math.max(0, parseFloat(e.target.value) || 0)))}
                                        className="w-full h-7 px-2 mt-0.5 mb-2 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-700 text-sm" />
                                    {/* Nút áp dụng */}
                                    <button
                                        onClick={handleAutoTrim}
                                        disabled={autoTrimBusy || autoTrimSides.length === 0}
                                        className="w-full h-8 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold">
                                        {autoTrimBusy ? t('misc.acrobatViewer:dang_xu_ly_khu_vien') : t('misc.acrobatViewer:ap_dung')}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {toolbarExtra}
                </>}
                extraActionsRight={<>
                    {!!(file as ViewerFile)?.path && accurateColorPages.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setAccurateColorPreference({
                                sourceKey: accurateColorSourceKey,
                                enabled: !accurateColorEnabled,
                            })}
                            title={accurateColorError
                                ? accurateColorError
                                : t('tabs.outputPreview:gia_lap_may_rip_thuc_te_boc_chinh_xac')}
                            aria-label={t('tabs.outputPreview:gia_lap_may_rip_thuc_te_boc_chinh_xac')}
                            aria-pressed={accurateColorEnabled}
                            className={`h-8 px-2 rounded text-[11px] font-bold tracking-wide transition-colors ${
                                accurateColorError
                                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 ring-1 ring-amber-300 dark:ring-amber-700'
                                    : accurateColorEnabled
                                        ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300 ring-1 ring-cyan-300 dark:ring-cyan-700'
                                        : 'text-slate-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10'
                            }`}
                        >
                            CMYK{accurateColorError ? '!' : accurateColorEnabled ? '✓' : ''}
                        </button>
                    )}
                    {toolbarExtraRight}
                </>}
                onOpenRotateModalOrTools={(type) => {
                    if ((type as string) === 'rotate') { openPageTools(); }
                    else if ((type as string) === 'delete') { setIsDeleteModalOpen(true); }
                    else { openPageTools(); }
                }}
            />

            <div className="flex-1 flex overflow-hidden relative min-w-0 min-h-0">
                <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden relative">
                    {/* Thumbnail Sidebar */}
                    {numPages > 0 && !isImage && (
                        <ThumbSidebar
                            pageOrder={pageOrder} setPageOrder={setPageOrder}
                            pageInstanceIds={pageInstanceIds} setPageInstanceIds={setPageInstanceIds}
                            selectedIndices={selectedIndices} setSelectedIndices={setSelectedIndices}
                            lastSelectedIndex={lastSelectedIndex} setLastSelectedIndex={setLastSelectedIndex}
                            activePage={activePage} setActivePage={setActivePage}
                            numPages={numPages} pageRotations={pageRotations} setPageRotations={setPageRotations} allPageDims={allPageDims}
                            thumbBaseWidth={thumbBaseWidth}
                            isThumbMenuOpen={isThumbMenuOpen} setIsThumbMenuOpen={setIsThumbMenuOpen}
                            commitSnapshot={commitSnapshot} handleQuickRotate={handleQuickRotate}
                            setContextMenu={setContextMenu}
                            setIsInsertModalOpen={setIsInsertModalOpen}
                            setExtractPagesStrForModal={setExtractPagesStrForModal}
                            setIsExtractModalOpen={setIsExtractModalOpen}
                            setIsDeleteModalOpen={setIsDeleteModalOpen}
                            navigatePage={navigatePage}
                            sidebarRef={sidebarRef} mainVirtuosoRef={mainVirtuosoRef} internalScrollRef={internalScrollRef}
                             file={file} pdfUrl={pdfUrl} isViewerActive={isActive}
                             editSessionPreviews={editSession?.previews}
                             pageWorkflowStatuses={pageWorkflowStatuses}
                             cutlinePreviews={cutlinePreviews}
                        />
                    )}

                    {/* Loading Spinner — shown when PDF is loading metadata */}
                    {pdfUrl && numPages === 0 && !loadError && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-[#525659]">
                            <div className="w-10 h-10 border-[3px] border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" />
                            <p className="text-sm text-zinc-400 font-medium animate-pulse">{t('misc.acrobatViewer:dang_tai_file_pdf')}</p>
                            {loadStatus === 'slow' && (
                                <div className="flex flex-col items-center gap-3 text-center px-6">
                                    <p className="text-xs text-zinc-300">{t('lib.processHandlers:file_lon_co_the_mat_vai_phut')}</p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={retryLoad}
                                            className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500"
                                        >
                                            {t('misc.errorBoundary:thu_lai')}
                                        </button>
                                        <button
                                            onClick={cancelLoad}
                                            className="px-4 py-2 rounded-md bg-zinc-700 text-zinc-100 text-sm font-medium hover:bg-zinc-600"
                                        >
                                            {t('misc.acrobatViewer:huy')}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Main PDF Canvas */}
                    {numPages > 0 && (
                        <div className="flex-1 flex min-w-0 min-h-0 relative">
                            {showRulers && (
                                <>
                                    {/* UIUX (audit 2026-07-27 §C-04): onCycleUnit — chuột phải lên thước đổi đơn vị mm→cm→inch */}
                                    <Ruler orientation="vertical" scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>} zoom={effectiveZoom} unit={measurementUnit} onMouseDown={handleRulerMouseDown} pageAnchorId={`pdf-page-container-${activePage}`} onCycleUnit={cycleMeasurementUnit} isActive={isActive !== false} layoutReady={isZoomReady && !suspendViewer} />
                                    <Ruler orientation="horizontal" scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>} zoom={effectiveZoom} unit={measurementUnit} onMouseDown={handleRulerMouseDown} pageAnchorId={`pdf-page-container-${activePage}`} onCycleUnit={cycleMeasurementUnit} isActive={isActive !== false} layoutReady={isZoomReady && !suspendViewer} />
                                </>
                            )}
                            <div
                                className={`absolute bottom-0 right-0 overflow-hidden bg-[#525659] flex justify-center select-text ${toolMode === 'hand' ? 'panning-mode cursor-grab active:cursor-grabbing' : toolMode === 'dimension' ? 'cursor-crosshair' : ''}`}
                                ref={containerRef}
                                onMouseDown={(e) => {
                                    // UIUX (audit 2026-07-27 §C-01): chuột giữa → pan tạm thời.
                                    if (e.button === 1) { handleMiddlePanStart(e); return; }
                                    // Chỉ clear selection / place DIM khi chuột trái.
                                    if (e.button !== 0) return;
                                    setSelectedGuideId(null);
                                    if (toolMode === 'dimension') handleDimensionPlacement(e);
                                    else handleDragStart(e);
                                }}
                                style={{ left: showRulers ? 20 : 0, top: showRulers ? 20 : 0 }}
                            >
                                <GuideLayer scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>} guides={guides} draggingGuide={draggingGuide} selectedGuideId={selectedGuideId} onGuideMouseDown={handleGuideMouseDown} pageAnchorId={`pdf-page-container-${activePage}`} isActive={isActive !== false} />
                                <DimensionLayer
                                    pageAnchorId={`pdf-page-container-${activePage}`}
                                    scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>}
                                    guides={guides}
                                    dimensions={dimensions}
                                    activePage={activePage}
                                    pageWidthPt={activePagePhysical.widthPt}
                                    pageHeightPt={activePagePhysical.heightPt}
                                    unit={measurementUnit}
                                    isActive={isActive !== false}
                                    onRemove={(id) => setDimensions(prev => prev.filter(d => d.id !== id))}
                                />

                                {pageDim && (
                                    <div className="absolute bottom-0 left-0 w-40 h-24 z-[50] group flex items-end p-6">
                                        <div style={{ padding: '8px 20px' }} className="bg-[#222]/95 backdrop-blur-sm text-[#e0e0e0] font-mono text-[14px] font-semibold rounded-lg border border-white/10 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none tracking-wider whitespace-nowrap">
                                            {formatPageSizeMm(
                                                activePagePhysical.widthPt,
                                                activePagePhysical.heightPt,
                                            )}
                                        </div>
                                    </div>
                                )}

                                {isZoomReady && !suspendViewer && (() => {
                                    if (pageDisplayMode.includes('_fit')) {
                                        return (
                                            <div className="flex-1 relative min-w-0 min-h-0">
                                                <div className="absolute inset-0 overflow-auto acro-scroll outline-none block" ref={(el) => { internalScrollRef.current = el; }}>
                                                    <div className="min-w-full min-h-full w-max h-max flex flex-col relative" style={{ alignItems: 'safe center', justifyContent: 'safe center' }}>
                                                        {renderRows.map((row) => {
                                                            const isActive = row.indices.includes(activePage - 1);
                                                            return (
                                                                <div key={row.indices.join('_')} className={`flex min-w-full ${toolMode === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-auto'}`}
                                                                    style={{ display: 'flex', alignItems: 'safe center', justifyContent: 'safe center', position: isActive ? 'relative' : 'absolute', opacity: isActive ? 1 : 0, pointerEvents: isActive ? 'auto' : 'none', visibility: isActive ? 'visible' : 'hidden', zIndex: isActive ? 10 : 0, paddingTop: 32, paddingBottom: 32, paddingLeft: 24, paddingRight: 24, gap: 12, width: 'max-content',
                                                                        /* UIUX (audit 2026-07-27 §C-02) fix-verify: hàng ẨN kẹp 0×0 + overflow hidden —
                                                                           vẫn mounted (giữ ảnh đã decode) nhưng KHÔNG phình scrollWidth/Height của
                                                                           khung cuộn, hết cảnh trang active bị căn giữa lệch chui dưới thước. */
                                                                        ...(isActive ? {} : { left: 0, top: 0, maxWidth: 0, maxHeight: 0, overflow: 'hidden' }) }}>
                                                                    <div className="flex items-center" style={{ gap: 12 }}>
                                                                        {row.pages.map((p: number, idx: number) => <div key={row.indices[idx]}>{renderPdfPage(p, row.indices[idx])}</div>)}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }
                                    return (
                                        <div className="absolute inset-0">
                                            <Virtuoso
                                                ref={mainVirtuosoRef} context={virtuosoContext} totalCount={renderRows.length}
                                                increaseViewportBy={virtuosoOverscan}
                                                className="w-full h-full flex-1"
                                                components={virtuosoComponents}
                                                scrollerRef={handleVirtuosoScrollerRef}
                                                itemContent={virtuosoItemContent}
                                            />
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>
                    )}
                </div>
                {rightPanel}
            </div>

            {/* UIUX (audit 2026-07-27 §M-1+C-05): thanh trạng thái đáy viewer — Trang/Kích thước/Zoom/Đơn vị + toạ độ chuột */}
            {numPages > 0 && (
                <StatusBar
                    activePage={activePage}
                    totalPages={pageOrder.length || numPages}
                    zoom={zoom}
                    /* UIUX (audit 2026-07-27 §M-1) fix-verify: kích thước lấy từ activePagePhysical
                       (đã map qua pageOrder + hoán w/h khi xoay 90/270) — allPageDims key theo SỐ
                       TRANG GỐC nên tra bằng activePage sai khi đảo thứ tự trang. */
                    widthPt={activePagePhysical.widthPt}
                    heightPt={activePagePhysical.heightPt}
                    pageDim={pageDim}
                    allPageDims={allPageDims}
                />
            )}

            {/* Modals */}
            {isDeleteModalOpen && <QuickDeleteModal selectedCount={selectedIndices.size} onConfirm={handleQuickDeleteConfirm} onClose={() => setIsDeleteModalOpen(false)} />}
            {isExtractModalOpen && <ExtractPagesModal pageCount={pageOrder.length} initialPagesStr={extractPagesStrForModal} onConfirm={handleExtractPages} onClose={() => setIsExtractModalOpen(false)} />}
            {isInsertModalOpen && <InsertBlankPageModal pageCount={pageOrder.length} onConfirm={handleInsertBlankPage} onClose={() => setIsInsertModalOpen(false)} />}

            <CrossFileInsertModal
                pending={crossFileInsertPending}
                onConfirm={confirmCrossFileInsert}
                onCancel={() => setCrossFileInsertPending(null)}
            />

            {/* Crop PDF dialog (Set Page Boxes) */}

            {/* Export ảnh (PNG/JPEG/TIFF) */}
            <ExportImageModal
                open={isExportImageOpen}
                onClose={() => setIsExportImageOpen(false)}
                fileId={exportFileId}
                initialTab={exportImageInitialTab}
                filePath={exportFilePath}
                numPages={pageOrder.length || numPages}
                currentPage={activePage}
                baseName={file?.name?.replace(/\.[^.]+$/, '') || 'page'}
                getWorkingFile={getExportWorkingFile}
                pageWidthPt={activePagePhysical.widthPt}
                pageHeightPt={activePagePhysical.heightPt}
            />

            {/* Context Menu */}
            <ViewerContextMenu
                contextMenu={contextMenu} selectedIndices={selectedIndices} setContextMenu={setContextMenu}
                currentPdfUrl={pdfUrl}
                setIsInsertModalOpen={setIsInsertModalOpen} setIsExtractModalOpen={setIsExtractModalOpen}
                setExtractPagesStrForModal={setExtractPagesStrForModal} setIsDeleteModalOpen={setIsDeleteModalOpen}
                onOpenPageTools={openPageTools}
                onQuickDuplicate={handleQuickDuplicate}
                onTransferToOtherFile={handleTransferToOtherFile}
            />
        </div>
    );
}
