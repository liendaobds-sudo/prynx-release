import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createContext, useContext } from 'react';
import type { StoreApi } from 'zustand';
import type { OutputPreviewPageBoxes, PlateOverlay } from '../lib/outputPreviewOverlay';
import type { CropRegionFrac } from '../lib/cropGeometry';
import type { ProcessingSettings } from '../lib/pdfImposer';
import type { StickerCutlinePreview } from '../lib/stickerSheetApi';

// ═══════════════════════════════════════════════════════════
// useWorkspaceStore — Central state for ImpositionTab workspace
// Replaces 31 useState declarations in ImpositionTab.tsx
// ═══════════════════════════════════════════════════════════

type Phase = 'upload' | 'workspace';

export function workspaceFileIdentity(file: File | null | undefined): string {
    if (!file) return 'none';
    const localPath = (file as File & { path?: string }).path || '';
    return `${localPath}|${file.name}|${file.size}|${file.lastModified || 0}`;
}

export function workspaceDocumentIdentity(
    file: File | null | undefined,
    pageOrder: number[] | undefined,
    pageRotations: number[] | undefined,
): string {
    const order = pageOrder?.length ? pageOrder.join(',') : 'source';
    const rotations = pageRotations?.length
        ? pageRotations.map(value => ((value % 360) + 360) % 360).join(',')
        : 'source';
    return `${workspaceFileIdentity(file)}|order:${order}|rot:${rotations}`;
}

export type OutputPreviewRenderingIntent = 'perceptual' | 'relative' | 'saturation' | 'absolute';
export type OutputPreviewShowFilter =
    | 'all'
    | 'device-cmyk'
    | 'device-rgb'
    | 'device-gray'
    | 'spot'
    | 'text'
    | 'images'
    | 'line-art'
    | 'smooth-shades';
export type OutputPreviewMode = 'separations' | 'color-warnings';
export type OutputPreviewRgb = [number, number, number];

export function outputPreviewProofIdentity(
    filter: OutputPreviewShowFilter,
    simulatePaperColor: boolean,
    simulateBlackInk: boolean,
    pageBackgroundRgb: OutputPreviewRgb | null,
): string {
    const background = pageBackgroundRgb ? pageBackgroundRgb.join('-') : 'profile';
    return `show:${filter}|paper:${simulatePaperColor ? 1 : 0}|black:${simulateBlackInk ? 1 : 0}|background:${background}`;
}

export interface CropSelectionState {
    /** Stable viewer instance id, so duplicated source pages do not share hotkeys. */
    ownerId: string;
    /** One-indexed source page sent to the crop API. */
    pageNum: number;
    regions: CropRegionFrac[];
    selectedIndex: number;
}

export interface EditObjectSelectionContext {
    /** File id used by Edit PDF when the selection was captured. */
    fileId: string;
    /** Zero-based source page index. */
    pageIndex: number;
    /** Stable object ids from /edit/objects for that page. */
    objectIds: string[];
}

export interface FontInspectionCache {
    identity: string;
    report: unknown;
}

export interface ClassicCutlineViewerPreview {
    /** Chủ sở hữu giúp cleanup của component cũ không xóa preview mới. */
    ownerId: string;
    preview: StickerCutlinePreview;
    /** Vị trí 1-based trong working PDF, không phải số trang nguồn trước reorder. */
    viewerPage: number;
    /** ID ổn định để bản nhân đôi cùng trang nguồn không cùng nhận overlay. */
    pageInstanceId: string | null;
    /** Fence file + reorder + rotation; payload cũ không được lóe lại sau khi đổi nguồn. */
    documentIdentity: string;
    isUpdating: boolean;
}

export interface ViewerActivePagePhysical {
    /** Fence file + thứ tự + góc xoay; dữ liệu trang cũ không được dùng cho file mới. */
    documentIdentity: string;
    /** Vị trí 1-based trong working PDF đang hiển thị. */
    viewerPage: number;
    /** Số trang nguồn 1-based sau khi ánh xạ qua pageOrder. */
    sourcePage: number;
    /** ID ổn định để phân biệt các bản nhân đôi cùng một trang nguồn. */
    pageInstanceId: string | null;
    /** Góc xoay đã chuẩn hóa về [0, 360). */
    rotation: number;
    /** Khổ vật lý sau xoay, tính bằng point PDF. */
    widthPt: number;
    heightPt: number;
}

type CropSelectionUpdater = CropSelectionState | null | ((prev: CropSelectionState | null) => CropSelectionState | null);
const CROP_HISTORY_LIMIT = 64;

const cloneCropSelection = (selection: CropSelectionState | null): CropSelectionState | null => selection
    ? { ...selection, regions: selection.regions.map((region) => ({ ...region })) }
    : null;

export interface WorkspaceState {
    // ── File & Phase ──
    phase: Phase;
    file: File | null;
    imageBatchFiles: File[] | null;
    originalFileName: string;
    pdfUrl: string | null;
    fileSizeStr: string;

    // ── Processing ──
    isProcessing: boolean;
    processStatus: string;
    error: string;

    // ── History & Save ──
    history: File[];
    // Undo/Redo RIÊNG cho chế độ chỉnh sửa đối tượng (object edit). Mỗi entry lưu
    // {file, pdfUrl, fid} để khôi phục ĐẦY ĐỦ trạng thái edit (kể cả selectionFileId)
    // — khác `history` (chỉ File, dùng cho các tool khác qua nút Undo cam).
    objectEditPast: { file: File | null; pdfUrl: string | null; fid: string }[];
    objectEditFuture: { file: File | null; pdfUrl: string | null; fid: string }[];
    isSaved: boolean;
    showSaveAsModal: boolean;
    reportMsg: string | null;
    viewerDirty: boolean;
    showCloseConfirm: boolean;

    // ── Viewer ──
    viewerPageOrder: number[] | undefined;
    viewerPageInstanceIds: string[] | undefined;
    // number[] THEO VỊ TRÍ: viewerPageRotations[i] = góc trang ở vị trí i trong pageOrder
    // (KHÔNG phải keyed theo số trang gốc — đổi từ per-instance rotation 2026-07-06). Cho
    // phép mỗi bản nhân bản xoay độc lập. Consumer bake/impose lặp theo vị trí nên dùng [i].
    viewerPageRotations: number[] | undefined;
    highlightedIssue: any;
    bleedView: { show: boolean; mm: number };

    // ── Sidebar & Layout ──
    isSidebarOpen: boolean;
    sidebarWidth: number;
    isDraggingSidebar: boolean;

    // ── Output Preview ──
    showOutputPreview: boolean;
    separationPlates: PlateOverlay[];
    hoveredPdfPosition: { x: number; y: number; pageNum: number } | null;
    /** Nguồn Simulation duy nhất của Viewer, Separations và Soft-Proof trong tab này. */
    outputPreviewProfileId: string;
    outputPreviewRenderingIntent: OutputPreviewRenderingIntent;
    outputPreviewShowFilter: OutputPreviewShowFilter;
    outputPreviewMode: OutputPreviewMode;
    outputPreviewSimulatePaperColor: boolean;
    outputPreviewSimulateBlackInk: boolean;
    outputPreviewPageBackgroundRgb: OutputPreviewRgb | null;
    /** Độ mờ chung cho Gamut/TAC/diff Overprint; composite chính luôn 100%. */
    outputPreviewWarningOpacity: number;
    outputPreviewOverprintDiagnosticActive: boolean;
    outputPreviewActiveViewerPage: number | null;
    outputPreviewPageBoxes: OutputPreviewPageBoxes | null;
    outputPreviewShowPageBoxes: boolean;

    // ── Soft-Proof ──
    softProofImageUrl: string | null;
    gamutWarningUrl: string | null;
    softProofActive: boolean;

    // ── TAC Heatmap & Overprint Preview ──
    tacHeatmapUrl: string | null;
    overprintPreviewUrl: string | null;

    // ── Crop Mode (Crop PDF kiểu Acrobat: quét vùng → Enter → Set Page Boxes) ──
    isCropMode: boolean;
    cropSelection: CropSelectionState | null;
    cropPast: Array<CropSelectionState | null>;
    cropFuture: Array<CropSelectionState | null>;

    // ── Object Edit Mode (chế độ chỉnh sửa đối tượng) ──
    isObjectEditMode: boolean;
    // Current page components for layers-like panel in edit PDF (accurate from /edit/objects)
    currentEditObjects: any[];
    pdfObjectsVersion: number;
    selectedObjectIds: string[];
    hiddenObjectIds: string[];
    lockedObjectIds: string[];
    selectionFileId: string;
    /** Identity file + page order/rotation mà `selectionFileId` đại diện. */
    selectionDocumentIdentity: string;
    /** Báo cáo Chữ & Font gần nhất, scope theo WorkspaceContext/tab. */
    fontInspectionCache: FontInspectionCache | null;
    // Clipboard copy/paste cho edit PDF (lazy-reference: chỉ nhớ trang nguồn + id,
    // resolve lại lúc paste). pasteCount cộng dồn offset khi paste liên tiếp.
    editClipboard: { sourcePage: number; objectIds: string[]; pasteCount: number } | null;
    objectSelectionContext: EditObjectSelectionContext | null;
    // Chế độ "đặt object mới" (toolbar +Text/Ảnh). Nâng lên store để nút ở panel
    // phải điều khiển được: cú bấm kế tiếp lên BẤT KỲ trang nào sẽ đặt object tại đó.
    editAddMode: 'text' | 'image' | null;

    // ── OCG Layers ──
    pdfOcgLayers: any[];
    hiddenOcgLayerIds: number[];
    lockedOcgLayerIds: number[];
    expandedOcgLayerIds: number[];
    hiddenObjectKeys: string[];
    isLayerPanelOpen: boolean;
    ocgPreviewUrl: string | null;

    // ── VDP Tool ──
    vdpFields: any[];
    selectedVdpFieldIds: string[];

    // ── Preprocess ──
    detectedShapeType: string | null;
    detectedShapeParams: string | null;
    detectedShapesByPage: Record<number, string>;
    detectedDimensionsByPage: Record<number, { w: number, h: number }>;
    detectedShapeParamsByPage: Record<number, any>;
    /** SVG đường bế classic phủ trực tiếp lên Viewer của riêng workspace/tab này. */
    classicCutlineViewerPreview: ClassicCutlineViewerPreview | null;

    // ── Watermark Preview ──
    watermarkPreview: any | null;

    // ── AcrobatViewer Shared State ──
    viewerZoom: number;
    viewerFitMode: 'width' | 'page' | 'custom' | 'smart';
    viewerToolMode: 'pointer' | 'hand' | 'dimension';
    viewerPageDisplayMode: 'single_fit' | 'single_scroll' | 'two_fit' | 'two_scroll';
    viewerActivePage: number;
    viewerNumPages: number;
    /** Snapshot index thumbnail 0-based, chỉ đọc khi mở hộp In; không đưa lên shell global. */
    viewerSelectedPageIndices: number[];
    viewerThumbMenuOpen: boolean;
    viewerThumbWidth: number;
    viewerPageDimMm: { w: number; h: number } | null;
    /** Khổ in thật của đúng instance trang đang xem; tách khỏi CSS-mm dùng cho VDP. */
    viewerActivePagePhysical: ViewerActivePagePhysical | null;

    // ── Setters ──
    setPhase: (phase: Phase) => void;
    setFile: (file: File | null) => void;
    setImageBatchFiles: (files: File[] | null) => void;
    setOriginalFileName: (name: string) => void;
    setPdfUrl: (url: string | null) => void;
    setFileSizeStr: (size: string) => void;

    setIsProcessing: (val: boolean) => void;
    setProcessStatus: (status: string) => void;
    setError: (error: string) => void;

    setHistory: (updater: File[] | ((prev: File[]) => File[])) => void;
    setObjectEditPast: (updater: { file: File | null; pdfUrl: string | null; fid: string }[] | ((prev: { file: File | null; pdfUrl: string | null; fid: string }[]) => { file: File | null; pdfUrl: string | null; fid: string }[])) => void;
    setObjectEditFuture: (updater: { file: File | null; pdfUrl: string | null; fid: string }[] | ((prev: { file: File | null; pdfUrl: string | null; fid: string }[]) => { file: File | null; pdfUrl: string | null; fid: string }[])) => void;
    setIsSaved: (val: boolean) => void;
    setShowSaveAsModal: (val: boolean) => void;
    setReportMsg: (msg: string | null) => void;
    setViewerDirty: (val: boolean) => void;
    setShowCloseConfirm: (val: boolean) => void;

    setViewerPageOrder: (order: number[] | undefined) => void;
    setViewerPageInstanceIds: (ids: string[] | undefined) => void;
    setViewerPageRotations: (rotations: number[] | undefined) => void;
    setHighlightedIssue: (issue: any) => void;
    setBleedView: (updater: any) => void;

    setIsSidebarOpen: (val: boolean) => void;
    setSidebarWidth: (width: number) => void;
    setIsDraggingSidebar: (val: boolean) => void;

    setShowOutputPreview: (val: boolean) => void;
    closeOutputPreview: () => void;
    setSeparationPlates: (plates: PlateOverlay[]) => void;
    setHoveredPdfPosition: (pos: { x: number; y: number; pageNum: number } | null) => void;
    setOutputPreviewProfileId: (profileId: string) => void;
    setOutputPreviewRenderingIntent: (intent: OutputPreviewRenderingIntent) => void;
    setOutputPreviewShowFilter: (filter: OutputPreviewShowFilter) => void;
    setOutputPreviewMode: (mode: OutputPreviewMode) => void;
    setOutputPreviewSimulatePaperColor: (enabled: boolean) => void;
    setOutputPreviewSimulateBlackInk: (enabled: boolean) => void;
    setOutputPreviewPageBackgroundRgb: (rgb: OutputPreviewRgb | null) => void;
    setOutputPreviewWarningOpacity: (opacity: number) => void;
    setOutputPreviewOverprintDiagnosticActive: (active: boolean) => void;
    setOutputPreviewActiveViewerPage: (pageNum: number | null) => void;
    setOutputPreviewPageBoxes: (boxes: OutputPreviewPageBoxes | null) => void;
    setOutputPreviewShowPageBoxes: (show: boolean) => void;

    setSoftProofImageUrl: (url: string | null) => void;
    setGamutWarningUrl: (url: string | null) => void;
    setSoftProofActive: (val: boolean) => void;

    setTacHeatmapUrl: (url: string | null) => void;
    setOverprintPreviewUrl: (url: string | null) => void;

    setIsObjectEditMode: (updater: boolean | ((prev: boolean) => boolean)) => void;
    setIsCropMode: (updater: boolean | ((prev: boolean) => boolean)) => void;
    setCropSelection: (updater: CropSelectionUpdater) => void;
    commitCropSelection: (updater: CropSelectionUpdater) => void;
    recordCropSelectionSnapshot: () => void;
    undoCropSelection: () => void;
    redoCropSelection: () => void;
    setCurrentEditObjects: (updater: any[] | ((prev: any[]) => any[])) => void;
    setPdfObjectsVersion: (updater: number | ((prev: number) => number)) => void;
    setSelectedObjectIds: (updater: string[] | ((prev: string[]) => string[])) => void;
    setEditClipboard: (clip: { sourcePage: number; objectIds: string[]; pasteCount: number } | null) => void;
    setHiddenObjectIds: (updater: string[] | ((prev: string[]) => string[])) => void;
    setLockedObjectIds: (updater: string[] | ((prev: string[]) => string[])) => void;
    setSelectionFileId: (id: string, documentIdentity?: string) => void;
    setFontInspectionCache: (cache: FontInspectionCache | null) => void;
    setObjectSelectionContext: (context: EditObjectSelectionContext | null) => void;
    setEditAddMode: (updater: ('text' | 'image' | null) | ((prev: 'text' | 'image' | null) => 'text' | 'image' | null)) => void;

    setPdfOcgLayers: (layers: any[]) => void;
    setHiddenOcgLayerIds: (updater: number[] | ((prev: number[]) => number[])) => void;
    setLockedOcgLayerIds: (updater: number[] | ((prev: number[]) => number[])) => void;
    setExpandedOcgLayerIds: (updater: number[] | ((prev: number[]) => number[])) => void;
    setHiddenObjectKeys: (updater: string[] | ((prev: string[]) => string[])) => void;
    setIsLayerPanelOpen: (updater: boolean | ((prev: boolean) => boolean)) => void;
    setOcgPreviewUrl: (url: string | null) => void;

    setVdpFields: (updater: any[] | ((prev: any[]) => any[])) => void;
    setSelectedVdpFieldIds: (ids: string[]) => void;

    // ── Watermark Preview ──
    setWatermarkPreview: (settings: any | null) => void;

    setDetectedShapeType: (val: string | null) => void;
    setDetectedShapeParams: (val: string | null) => void;
    setDetectedShapesByPage: (updater: Record<number, string> | ((prev: Record<number, string>) => Record<number, string>)) => void;
    setDetectedDimensionsByPage: (updater: Record<number, { w: number, h: number }> | ((prev: Record<number, { w: number, h: number }>) => Record<number, { w: number, h: number }>)) => void;
    setDetectedShapeParamsByPage: (updater: Record<number, any> | ((prev: Record<number, any>) => Record<number, any>)) => void;
    setClassicCutlineViewerPreview: (value: ClassicCutlineViewerPreview) => void;
    clearClassicCutlineViewerPreview: (ownerId: string) => void;

    setViewerZoom: (updater: number | ((prev: number) => number)) => void;
    setViewerFitMode: (mode: 'width' | 'page' | 'custom' | 'smart') => void;
    setViewerToolMode: (mode: 'pointer' | 'hand' | 'dimension') => void;
    setViewerPageDisplayMode: (mode: 'single_fit' | 'single_scroll' | 'two_fit' | 'two_scroll') => void;
    setViewerActivePage: (page: number) => void;
    setViewerNumPages: (n: number) => void;
    setViewerSelectedPageIndices: (indices: number[]) => void;
    setViewerThumbMenuOpen: (v: boolean) => void;
    setViewerThumbWidth: (width: number) => void;
    setViewerPageDimMm: (dim: { w: number; h: number } | null) => void;
    setViewerActivePagePhysical: (value: ViewerActivePagePhysical | null) => void;

    stickPreviewParams: any | null;
    setStickPreviewParams: (params: any | null) => void;
}

export const createWorkspaceStore = () => createStore<WorkspaceState>()((set) => ({
    // ── File & Phase ──
    phase: 'upload',
    file: null,
    imageBatchFiles: null,
    originalFileName: '',
    pdfUrl: null,
    fileSizeStr: '',

    isProcessing: false,
    processStatus: '',
    error: '',

    history: [],
    objectEditPast: [],
    objectEditFuture: [],
    isSaved: false,
    showSaveAsModal: false,
    reportMsg: null,
        viewerDirty: false,
        showCloseConfirm: false,

    viewerPageOrder: undefined,
    viewerPageInstanceIds: undefined,
    viewerPageRotations: undefined,
    highlightedIssue: null,
    bleedView: { show: false, mm: 0 },

    isSidebarOpen: true,
    sidebarWidth: 390,
    isDraggingSidebar: false,

    showOutputPreview: false,
    separationPlates: [],
    hoveredPdfPosition: null,
    outputPreviewProfileId: 'fogra39',
    outputPreviewRenderingIntent: 'relative',
    outputPreviewShowFilter: 'all',
    outputPreviewMode: 'separations',
    outputPreviewSimulatePaperColor: false,
    outputPreviewSimulateBlackInk: false,
    outputPreviewPageBackgroundRgb: null,
    outputPreviewWarningOpacity: 1,
    outputPreviewOverprintDiagnosticActive: false,
    outputPreviewActiveViewerPage: null,
    outputPreviewPageBoxes: null,
    outputPreviewShowPageBoxes: false,

    softProofImageUrl: null,
    gamutWarningUrl: null,
    softProofActive: false,

    tacHeatmapUrl: null,
    overprintPreviewUrl: null,

    isObjectEditMode: false,
    isCropMode: false,
    cropSelection: null,
    cropPast: [],
    cropFuture: [],
    currentEditObjects: [],
    pdfObjectsVersion: 0,
    selectedObjectIds: [],
    editClipboard: null,
    hiddenObjectIds: [],
    lockedObjectIds: [],
    selectionFileId: '',
    selectionDocumentIdentity: '',
    fontInspectionCache: null,
    objectSelectionContext: null,
    editAddMode: null,

    pdfOcgLayers: [],
    hiddenOcgLayerIds: [],
    lockedOcgLayerIds: [],
    expandedOcgLayerIds: [],
    hiddenObjectKeys: [],
    isLayerPanelOpen: false,
    ocgPreviewUrl: null,

    vdpFields: [],
    selectedVdpFieldIds: [],

    detectedShapeType: null,
    detectedShapeParams: null,
    detectedShapesByPage: {},
    detectedDimensionsByPage: {},
    detectedShapeParamsByPage: {},
    classicCutlineViewerPreview: null,

    watermarkPreview: null,
    stickPreviewParams: null,

    // ── AcrobatViewer Shared State ──
    viewerZoom: 1,
    viewerFitMode: 'smart',
    viewerToolMode: 'pointer',
    viewerPageDisplayMode: 'single_fit',
    viewerActivePage: 1,
    viewerNumPages: 0,
    viewerSelectedPageIndices: [],
    viewerThumbMenuOpen: false,
    viewerThumbWidth: 256,
    viewerPageDimMm: null,
    viewerActivePagePhysical: null,

    // ── Setters ──
    setPhase: (phase) => set({ phase }),
    setFile: (file) => set((state) => {
        const sameFile = workspaceFileIdentity(state.file) === workspaceFileIdentity(file);
        return {
            file,
            selectionFileId: sameFile ? state.selectionFileId : '',
            selectionDocumentIdentity: sameFile ? state.selectionDocumentIdentity : '',
            fontInspectionCache: sameFile ? state.fontInspectionCache : null,
            viewerSelectedPageIndices: sameFile ? state.viewerSelectedPageIndices : [],
            detectedShapeType: null,
            detectedShapeParams: null,
            detectedShapesByPage: {},
            detectedDimensionsByPage: {},
            detectedShapeParamsByPage: {},
            classicCutlineViewerPreview: null,
            viewerActivePagePhysical: null,
        };
    }),
    setImageBatchFiles: (imageBatchFiles) => set({ imageBatchFiles }),
    setOriginalFileName: (name) => set({ originalFileName: name }),
    setPdfUrl: (url) => set({ pdfUrl: url }),
    setFileSizeStr: (size) => set({ fileSizeStr: size }),

    setIsProcessing: (v) => set({ isProcessing: v }),
    setProcessStatus: (s) => set({ processStatus: s }),
    setError: (e) => set({ error: e }),

    setStickPreviewParams: (params) => set({ stickPreviewParams: params }),

    setHistory: (updater) => set((state) => ({
        history: typeof updater === 'function' ? updater(state.history) : updater,
    })),
    setObjectEditPast: (updater) => set((state) => ({
        objectEditPast: typeof updater === 'function' ? updater(state.objectEditPast) : updater,
    })),
    setObjectEditFuture: (updater) => set((state) => ({
        objectEditFuture: typeof updater === 'function' ? updater(state.objectEditFuture) : updater,
    })),
    setIsSaved: (v) => set({ isSaved: v }),
    setShowSaveAsModal: (v) => set({ showSaveAsModal: v }),
    setReportMsg: (msg) => set({ reportMsg: msg }),
    setViewerDirty: (v) => set({ viewerDirty: v }),
    setShowCloseConfirm: (v) => set({ showCloseConfirm: v }),

    setViewerPageOrder: (order) => set({
        viewerPageOrder: order,
        classicCutlineViewerPreview: null,
        viewerActivePagePhysical: null,
    }),
    setViewerPageInstanceIds: (ids) => set({
        viewerPageInstanceIds: ids,
        classicCutlineViewerPreview: null,
        viewerActivePagePhysical: null,
    }),
    setViewerPageRotations: (rotations) => set({
        viewerPageRotations: rotations,
        classicCutlineViewerPreview: null,
        viewerActivePagePhysical: null,
    }),
    setHighlightedIssue: (issue) => set({ highlightedIssue: issue }),
    setBleedView: (updater) => set((state) => ({
        bleedView: typeof updater === 'function' ? updater(state.bleedView) : updater,
    })),

    setIsSidebarOpen: (v) => set({ isSidebarOpen: v }),
    setSidebarWidth: (w) => set({ sidebarWidth: w }),
    setIsDraggingSidebar: (v) => set({ isDraggingSidebar: v }),

    // PERF (audit 2026-08-10 §OP.6): reset cùng giá trị không được đánh thức toàn
    // bộ LivePageFrame. OutputPreviewTab có nhiều nhánh cleanup cùng quy về [].
    setShowOutputPreview: (v) => set((state) => (
        state.showOutputPreview === v ? state : { showOutputPreview: v }
    )),
    closeOutputPreview: () => set((state) => {
        if (
            !state.showOutputPreview
            && state.separationPlates.length === 0
            && state.outputPreviewActiveViewerPage === null
            && state.outputPreviewPageBoxes === null
        ) return state;
        return {
            showOutputPreview: false,
            separationPlates: state.separationPlates.length === 0 ? state.separationPlates : [],
            outputPreviewActiveViewerPage: null,
            outputPreviewPageBoxes: null,
        };
    }),
    setSeparationPlates: (plates) => set((state) => {
        if (state.separationPlates === plates) return state;
        if (state.separationPlates.length === 0 && plates.length === 0) return state;
        return { separationPlates: plates };
    }),
    setHoveredPdfPosition: (pos) => set({ hoveredPdfPosition: pos }),
    // PREFLIGHT (audit 2026-08-10 §OP.8): mỗi ImpositionTab sở hữu một
    // WorkspaceContext riêng, vì vậy state này tự nhiên được scope theo tab.
    setOutputPreviewProfileId: (profileId) => set((state) => (
        state.outputPreviewProfileId === profileId ? state : { outputPreviewProfileId: profileId }
    )),
    setOutputPreviewRenderingIntent: (intent) => set((state) => (
        state.outputPreviewRenderingIntent === intent
            ? state
            : { outputPreviewRenderingIntent: intent }
    )),
    setOutputPreviewShowFilter: (filter) => set((state) => (
        state.outputPreviewShowFilter === filter ? state : { outputPreviewShowFilter: filter }
    )),
    setOutputPreviewMode: (mode) => set((state) => (
        state.outputPreviewMode === mode ? state : { outputPreviewMode: mode }
    )),
    setOutputPreviewSimulatePaperColor: (enabled) => set((state) => (
        state.outputPreviewSimulatePaperColor === enabled
            ? state
            : { outputPreviewSimulatePaperColor: enabled }
    )),
    setOutputPreviewSimulateBlackInk: (enabled) => set((state) => (
        state.outputPreviewSimulateBlackInk === enabled
            ? state
            : { outputPreviewSimulateBlackInk: enabled }
    )),
    setOutputPreviewPageBackgroundRgb: (rgb) => set((state) => {
        const normalized = rgb === null
            ? null
            : rgb.map(channel => Math.max(0, Math.min(255, Math.round(channel)))) as OutputPreviewRgb;
        const previous = state.outputPreviewPageBackgroundRgb;
        const unchanged = previous === normalized
            || (previous !== null && normalized !== null
                && previous.every((channel, index) => channel === normalized[index]));
        return unchanged ? state : { outputPreviewPageBackgroundRgb: normalized };
    }),
    // UIUX (audit 2026-08-10 §OP.E2): một opacity theo workspace/tab; clamp tại
    // biên store để mọi consumer warning nhận cùng giá trị an toàn.
    setOutputPreviewWarningOpacity: (opacity) => set((state) => {
        const normalized = Number.isFinite(opacity)
            ? Math.max(0, Math.min(1, opacity))
            : 1;
        return state.outputPreviewWarningOpacity === normalized
            ? state
            : { outputPreviewWarningOpacity: normalized };
    }),
    setOutputPreviewOverprintDiagnosticActive: (active) => set((state) => (
        state.outputPreviewOverprintDiagnosticActive === active
            ? state
            : { outputPreviewOverprintDiagnosticActive: active }
    )),
    // PREFLIGHT (audit 2026-08-10 §OP.12): bitmap Soft-Proof/warning cần danh
    // tính trang riêng; danh sách plate có chủ ý rỗng khi all-on nên không thể làm owner.
    setOutputPreviewActiveViewerPage: (pageNum) => set((state) => {
        const normalized = typeof pageNum === 'number'
            && Number.isInteger(pageNum)
            && pageNum > 0
            ? pageNum
            : null;
        return state.outputPreviewActiveViewerPage === normalized
            ? state
            : { outputPreviewActiveViewerPage: normalized };
    }),
    // PAGEBOX (audit 2026-08-10 §OP.E3): dữ liệu mang viewerPageNum để frame
    // ảo khác trang không thể dùng nhầm PageBox của response vừa về.
    setOutputPreviewPageBoxes: (boxes) => set((state) => (
        state.outputPreviewPageBoxes === boxes
            ? state
            : { outputPreviewPageBoxes: boxes }
    )),
    setOutputPreviewShowPageBoxes: (show) => set((state) => (
        state.outputPreviewShowPageBoxes === show
            ? state
            : { outputPreviewShowPageBoxes: show }
    )),

    setSoftProofImageUrl: (url) => set((state) => (
        state.softProofImageUrl === url ? state : { softProofImageUrl: url }
    )),
    setGamutWarningUrl: (url) => set((state) => (
        state.gamutWarningUrl === url ? state : { gamutWarningUrl: url }
    )),
    setSoftProofActive: (val) => set((state) => (
        state.softProofActive === val ? state : { softProofActive: val }
    )),

    setTacHeatmapUrl: (url) => set((state) => (
        state.tacHeatmapUrl === url ? state : { tacHeatmapUrl: url }
    )),
    setOverprintPreviewUrl: (url) => set((state) => (
        state.overprintPreviewUrl === url ? state : { overprintPreviewUrl: url }
    )),

    setIsObjectEditMode: (v) => set((state) => {
        const next = typeof v === 'function' ? v(state.isObjectEditMode) : v;
        return { isObjectEditMode: next };
    }),
    setIsCropMode: (v) => set((state) => {
        const next = typeof v === 'function' ? v(state.isCropMode) : v;
        if (next === state.isCropMode) return state;
        return next
            ? { isCropMode: true, cropPast: [], cropFuture: [] }
            : { isCropMode: false, cropSelection: null, cropPast: [], cropFuture: [] };
    }),
    setCropSelection: (updater) => set((state) => ({
        cropSelection: typeof updater === 'function' ? updater(state.cropSelection) : updater,
    })),
    recordCropSelectionSnapshot: () => set((state) => ({
        cropPast: [...state.cropPast, cloneCropSelection(state.cropSelection)].slice(-CROP_HISTORY_LIMIT),
        cropFuture: [],
    })),
    commitCropSelection: (updater) => set((state) => {
        const current = state.cropSelection;
        const next = typeof updater === 'function' ? updater(current) : updater;
        if (next === current) return state;
        const ownerChanged = current !== null && next !== null && current.ownerId !== next.ownerId;
        const previousHistory = ownerChanged ? [] : state.cropPast;
        return {
            cropSelection: cloneCropSelection(next),
            cropPast: [...previousHistory, ownerChanged ? null : cloneCropSelection(current)].slice(-CROP_HISTORY_LIMIT),
            cropFuture: [],
        };
    }),
    undoCropSelection: () => set((state) => {
        if (state.cropPast.length === 0) return state;
        const previous = state.cropPast[state.cropPast.length - 1];
        return {
            cropSelection: cloneCropSelection(previous),
            cropPast: state.cropPast.slice(0, -1),
            cropFuture: [...state.cropFuture, cloneCropSelection(state.cropSelection)].slice(-CROP_HISTORY_LIMIT),
        };
    }),
    redoCropSelection: () => set((state) => {
        if (state.cropFuture.length === 0) return state;
        const next = state.cropFuture[state.cropFuture.length - 1];
        return {
            cropSelection: cloneCropSelection(next),
            cropPast: [...state.cropPast, cloneCropSelection(state.cropSelection)].slice(-CROP_HISTORY_LIMIT),
            cropFuture: state.cropFuture.slice(0, -1),
        };
    }),
    setCurrentEditObjects: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.currentEditObjects) : updater;
        if (next === state.currentEditObjects) return state;
        return { currentEditObjects: next };
    }),
    setPdfObjectsVersion: (updater) => set((state) => ({
        pdfObjectsVersion: typeof updater === 'function' ? updater(state.pdfObjectsVersion) : updater,
    })),
    // Idempotent: cùng nội dung mảng → giữ NGUYÊN reference (tránh "Maximum update depth"
    // khi nhiều LivePageFrame gọi setSelectedObjectIds([]) mỗi effect).
    setSelectedObjectIds: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.selectedObjectIds) : updater;
        const prev = state.selectedObjectIds;
        if (prev === next) return state;
        if (
            Array.isArray(prev) && Array.isArray(next)
            && prev.length === next.length
            && prev.every((id, i) => id === next[i])
        ) {
            return state;
        }
        return { selectedObjectIds: next };
    }),
    setHiddenObjectIds: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.hiddenObjectIds) : updater;
        const prev = state.hiddenObjectIds;
        if (prev === next) return state;
        if (
            Array.isArray(prev) && Array.isArray(next)
            && prev.length === next.length
            && prev.every((id, i) => id === next[i])
        ) {
            return state;
        }
        return { hiddenObjectIds: next };
    }),
    setLockedObjectIds: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.lockedObjectIds) : updater;
        const prev = state.lockedObjectIds;
        if (prev === next) return state;
        if (
            Array.isArray(prev) && Array.isArray(next)
            && prev.length === next.length
            && prev.every((id, i) => id === next[i])
        ) {
            return state;
        }
        return { lockedObjectIds: next };
    }),
    setEditClipboard: (clip) => set({ editClipboard: clip }),
    setSelectionFileId: (id, documentIdentity) => set((state) => {
        const boundIdentity = id
            ? documentIdentity || workspaceDocumentIdentity(
                state.file,
                state.viewerPageOrder,
                state.viewerPageRotations,
            )
            : '';
        if (
            state.selectionFileId === id
            && state.selectionDocumentIdentity === boundIdentity
        ) return state;
        return {
            selectionFileId: id,
            selectionDocumentIdentity: boundIdentity,
            selectedObjectIds: [],
            hiddenObjectIds: [],
            lockedObjectIds: [],
            editClipboard: null,
            objectSelectionContext: id && state.objectSelectionContext
                ? { ...state.objectSelectionContext, fileId: id }
                : null,
        };
    }),
    setFontInspectionCache: (cache) => set({ fontInspectionCache: cache }),
    setObjectSelectionContext: (context) => set((state) => {
        const prev = state.objectSelectionContext;
        if (prev === context) return state;
        if (
            prev && context
            && prev.fileId === context.fileId
            && prev.pageIndex === context.pageIndex
            && prev.objectIds.length === context.objectIds.length
            && prev.objectIds.every((id, index) => id === context.objectIds[index])
        ) {
            return state;
        }
        return {
            objectSelectionContext: context
                ? { ...context, objectIds: [...context.objectIds] }
                : null,
        };
    }),
    setEditAddMode: (updater) => set((state) => ({
        editAddMode: typeof updater === 'function' ? updater(state.editAddMode) : updater,
    })),

    setPdfOcgLayers: (layers) => set((state) => (
        state.pdfOcgLayers === layers ? state : { pdfOcgLayers: layers }
    )),
    // Cùng idempotent array: LayerPanel / ImpositionTab hay clear `[]` trong effect.
    setHiddenOcgLayerIds: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.hiddenOcgLayerIds) : updater;
        const prev = state.hiddenOcgLayerIds;
        if (prev === next) return state;
        if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && prev.every((id, i) => id === next[i])) return state;
        return { hiddenOcgLayerIds: next };
    }),
    setLockedOcgLayerIds: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.lockedOcgLayerIds) : updater;
        const prev = state.lockedOcgLayerIds;
        if (prev === next) return state;
        if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && prev.every((id, i) => id === next[i])) return state;
        return { lockedOcgLayerIds: next };
    }),
    setExpandedOcgLayerIds: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.expandedOcgLayerIds) : updater;
        const prev = state.expandedOcgLayerIds;
        if (prev === next) return state;
        if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && prev.every((id, i) => id === next[i])) return state;
        return { expandedOcgLayerIds: next };
    }),
    setHiddenObjectKeys: (updater) => set((state) => {
        const next = typeof updater === 'function' ? updater(state.hiddenObjectKeys) : updater;
        const prev = state.hiddenObjectKeys;
        if (prev === next) return state;
        if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && prev.every((id, i) => id === next[i])) return state;
        return { hiddenObjectKeys: next };
    }),
    setIsLayerPanelOpen: (updater) => set((state) => ({
        isLayerPanelOpen: typeof updater === 'function' ? updater(state.isLayerPanelOpen) : updater,
    })),
    setOcgPreviewUrl: (url) => set((state) => (
        state.ocgPreviewUrl === url ? state : { ocgPreviewUrl: url }
    )),

    setVdpFields: (updater) => set((state) => ({
        vdpFields: typeof updater === 'function' ? updater(state.vdpFields) : updater,
    })),
    setSelectedVdpFieldIds: (ids) => set((state) => {
        const prev = state.selectedVdpFieldIds;
        if (prev === ids) return state;
        if (Array.isArray(prev) && Array.isArray(ids) && prev.length === ids.length && prev.every((id, i) => id === ids[i])) return state;
        return { selectedVdpFieldIds: ids };
    }),

    setWatermarkPreview: (settings) => set({ watermarkPreview: settings }),

    setDetectedShapeType: (v) => set({ detectedShapeType: v }),
    setDetectedShapeParams: (v) => set({ detectedShapeParams: v }),
    setDetectedShapesByPage: (updater) => set((state) => ({
        detectedShapesByPage: typeof updater === 'function' ? updater(state.detectedShapesByPage) : updater,
    })),
    setDetectedDimensionsByPage: (updater) => set((state) => ({
        detectedDimensionsByPage: typeof updater === 'function' ? updater(state.detectedDimensionsByPage) : updater,
    })),
    setDetectedShapeParamsByPage: (updater) => set((state) => ({
        detectedShapeParamsByPage: typeof updater === 'function' ? updater(state.detectedShapeParamsByPage) : updater,
    })),
    setClassicCutlineViewerPreview: (value) => set({ classicCutlineViewerPreview: value }),
    clearClassicCutlineViewerPreview: (ownerId) => set((state) => (
        state.classicCutlineViewerPreview?.ownerId === ownerId
            ? { classicCutlineViewerPreview: null }
            : state
    )),

    setViewerZoom: (updater) => set((state) => ({
        viewerZoom: typeof updater === 'function' ? updater(state.viewerZoom) : updater,
    })),
    setViewerFitMode: (mode) => set({ viewerFitMode: mode }),
    setViewerToolMode: (mode) => set({ viewerToolMode: mode }),
    setViewerPageDisplayMode: (mode) => set({ viewerPageDisplayMode: mode }),
    setViewerActivePage: (page) => set({ viewerActivePage: page }),
    setViewerNumPages: (n) => set({ viewerNumPages: n }),
    setViewerSelectedPageIndices: (indices) => set({ viewerSelectedPageIndices: [...indices] }),
    setViewerThumbMenuOpen: (v) => set({ viewerThumbMenuOpen: v }),
    setViewerThumbWidth: (w) => set({ viewerThumbWidth: w }),
    setViewerPageDimMm: (dim) => set({ viewerPageDimMm: dim }),
    setViewerActivePagePhysical: (value) => set({ viewerActivePagePhysical: value }),
}));

export const WorkspaceContext = createContext<StoreApi<WorkspaceState> | null>(null);

export function useWorkspaceStore<T = WorkspaceState>(selector?: (state: WorkspaceState) => T): T {
    const store = useContext(WorkspaceContext);
    if (!store) throw new Error('Missing WorkspaceContext.Provider in the tree');
    return useStore(store, selector!) as T;
}
