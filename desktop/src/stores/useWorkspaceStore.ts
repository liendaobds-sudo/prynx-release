import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createContext, useContext } from 'react';
import type { StoreApi } from 'zustand';
import type { PlateOverlay } from '../components/OutputPreviewTab';
import type { ProcessingSettings } from '../lib/pdfImposer';

// ═══════════════════════════════════════════════════════════
// useWorkspaceStore — Central state for ImpositionTab workspace
// Replaces 31 useState declarations in ImpositionTab.tsx
// ═══════════════════════════════════════════════════════════

type Phase = 'upload' | 'workspace';

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
    viewerPageRotations: Record<number, number> | undefined;
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

    // ── Soft-Proof ──
    softProofImageUrl: string | null;
    gamutWarningUrl: string | null;
    softProofActive: boolean;

    // ── TAC Heatmap & Overprint Preview ──
    tacHeatmapUrl: string | null;
    overprintPreviewUrl: string | null;

    // ── Selection Tool ──
    isSelectionMode: boolean;
    // ── Object Edit Mode (chế độ chỉnh sửa đối tượng — độc lập Selection Tool) ──
    isObjectEditMode: boolean;
    pdfObjectsVersion: number;
    selectedObjectIds: string[];
    hiddenObjectIds: string[];
    selectionFileId: string;

    // ── OCG Layers ──
    pdfOcgLayers: any[];
    hiddenOcgLayerIds: number[];
    lockedOcgLayerIds: number[];
    expandedOcgLayerIds: number[];
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

    // ── Watermark Preview ──
    watermarkPreview: any | null;

    // ── AcrobatViewer Shared State ──
    viewerZoom: number;
    viewerFitMode: 'width' | 'page' | 'custom' | 'smart';
    viewerToolMode: 'pointer' | 'hand';
    viewerPageDisplayMode: 'single_fit' | 'single_scroll' | 'two_fit' | 'two_scroll';
    viewerActivePage: number;
    viewerNumPages: number;
    viewerThumbMenuOpen: boolean;
    viewerThumbWidth: number;
    viewerPageDimMm: { w: number; h: number } | null;

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
    setViewerPageRotations: (rotations: Record<number, number> | undefined) => void;
    setHighlightedIssue: (issue: any) => void;
    setBleedView: (updater: any) => void;

    setIsSidebarOpen: (val: boolean) => void;
    setSidebarWidth: (width: number) => void;
    setIsDraggingSidebar: (val: boolean) => void;

    setShowOutputPreview: (val: boolean) => void;
    setSeparationPlates: (plates: PlateOverlay[]) => void;
    setHoveredPdfPosition: (pos: { x: number; y: number; pageNum: number } | null) => void;

    setSoftProofImageUrl: (url: string | null) => void;
    setGamutWarningUrl: (url: string | null) => void;
    setSoftProofActive: (val: boolean) => void;

    setTacHeatmapUrl: (url: string | null) => void;
    setOverprintPreviewUrl: (url: string | null) => void;

    setIsSelectionMode: (updater: boolean | ((prev: boolean) => boolean)) => void;
    setIsObjectEditMode: (updater: boolean | ((prev: boolean) => boolean)) => void;
    setPdfObjectsVersion: (updater: number | ((prev: number) => number)) => void;
    setSelectedObjectIds: (updater: string[] | ((prev: string[]) => string[])) => void;
    setHiddenObjectIds: (updater: string[] | ((prev: string[]) => string[])) => void;
    setSelectionFileId: (id: string) => void;

    setPdfOcgLayers: (layers: any[]) => void;
    setHiddenOcgLayerIds: (updater: number[] | ((prev: number[]) => number[])) => void;
    setLockedOcgLayerIds: (updater: number[] | ((prev: number[]) => number[])) => void;
    setExpandedOcgLayerIds: (updater: number[] | ((prev: number[]) => number[])) => void;
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

    setViewerZoom: (updater: number | ((prev: number) => number)) => void;
    setViewerFitMode: (mode: 'width' | 'page' | 'custom' | 'smart') => void;
    setViewerToolMode: (mode: 'pointer' | 'hand') => void;
    setViewerPageDisplayMode: (mode: 'single_fit' | 'single_scroll' | 'two_fit' | 'two_scroll') => void;
    setViewerActivePage: (page: number) => void;
    setViewerNumPages: (n: number) => void;
    setViewerThumbMenuOpen: (v: boolean) => void;
    setViewerThumbWidth: (width: number) => void;
    setViewerPageDimMm: (dim: { w: number; h: number } | null) => void;

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
    viewerPageRotations: undefined,
    highlightedIssue: null,
    bleedView: { show: false, mm: 0 },

    isSidebarOpen: true,
    sidebarWidth: 390,
    isDraggingSidebar: false,

    showOutputPreview: false,
    separationPlates: [],
    hoveredPdfPosition: null,

    softProofImageUrl: null,
    gamutWarningUrl: null,
    softProofActive: false,

    tacHeatmapUrl: null,
    overprintPreviewUrl: null,

    isSelectionMode: false,
    isObjectEditMode: false,
    pdfObjectsVersion: 0,
    selectedObjectIds: [],
    hiddenObjectIds: [],
    selectionFileId: '',

    pdfOcgLayers: [],
    hiddenOcgLayerIds: [],
    lockedOcgLayerIds: [],
    expandedOcgLayerIds: [],
    isLayerPanelOpen: false,
    ocgPreviewUrl: null,

    vdpFields: [],
    selectedVdpFieldIds: [],

    detectedShapeType: null,
    detectedShapeParams: null,
    detectedShapesByPage: {},
    detectedDimensionsByPage: {},
    detectedShapeParamsByPage: {},

    watermarkPreview: null,
    stickPreviewParams: null,

    // ── AcrobatViewer Shared State ──
    viewerZoom: 1,
    viewerFitMode: 'smart',
    viewerToolMode: 'pointer',
    viewerPageDisplayMode: 'single_fit',
    viewerActivePage: 1,
    viewerNumPages: 0,
    viewerThumbMenuOpen: false,
    viewerThumbWidth: 256,
    viewerPageDimMm: null,

    // ── Setters ──
    setPhase: (phase) => set({ phase }),
    setFile: (file) => set({ 
        file,
        detectedShapeType: null,
        detectedShapeParams: null,
        detectedShapesByPage: {},
        detectedDimensionsByPage: {},
        detectedShapeParamsByPage: {}
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

    setViewerPageOrder: (order) => set({ viewerPageOrder: order }),
    setViewerPageRotations: (rotations) => set({ viewerPageRotations: rotations }),
    setHighlightedIssue: (issue) => set({ highlightedIssue: issue }),
    setBleedView: (updater) => set((state) => ({
        bleedView: typeof updater === 'function' ? updater(state.bleedView) : updater,
    })),

    setIsSidebarOpen: (v) => set({ isSidebarOpen: v }),
    setSidebarWidth: (w) => set({ sidebarWidth: w }),
    setIsDraggingSidebar: (v) => set({ isDraggingSidebar: v }),

    setShowOutputPreview: (v) => set({ showOutputPreview: v }),
    setSeparationPlates: (plates) => set({ separationPlates: plates }),
    setHoveredPdfPosition: (pos) => set({ hoveredPdfPosition: pos }),

    setSoftProofImageUrl: (url) => set({ softProofImageUrl: url }),
    setGamutWarningUrl: (url) => set({ gamutWarningUrl: url }),
    setSoftProofActive: (val) => set({ softProofActive: val }),

    setTacHeatmapUrl: (url) => set({ tacHeatmapUrl: url }),
    setOverprintPreviewUrl: (url) => set({ overprintPreviewUrl: url }),

    setIsSelectionMode: (v) => set((state) => {
        const next = typeof v === 'function' ? v(state.isSelectionMode) : v;
        // Loại trừ lẫn nhau: bật Selection Tool → tắt chế độ chỉnh sửa đối tượng.
        return next ? { isSelectionMode: true, isObjectEditMode: false } : { isSelectionMode: false };
    }),
    setIsObjectEditMode: (v) => set((state) => {
        const next = typeof v === 'function' ? v(state.isObjectEditMode) : v;
        // Loại trừ lẫn nhau: bật chế độ chỉnh sửa đối tượng → tắt Selection Tool.
        return next ? { isObjectEditMode: true, isSelectionMode: false } : { isObjectEditMode: false };
    }),
    setPdfObjectsVersion: (updater) => set((state) => ({
        pdfObjectsVersion: typeof updater === 'function' ? updater(state.pdfObjectsVersion) : updater,
    })),
    setSelectedObjectIds: (updater) => set((state) => ({
        selectedObjectIds: typeof updater === 'function' ? updater(state.selectedObjectIds) : updater,
    })),
    setHiddenObjectIds: (updater) => set((state) => ({
        hiddenObjectIds: typeof updater === 'function' ? updater(state.hiddenObjectIds) : updater,
    })),
    setSelectionFileId: (id) => set({ selectionFileId: id, selectedObjectIds: [], hiddenObjectIds: [] }),

    setPdfOcgLayers: (layers) => set({ pdfOcgLayers: layers }),
    setHiddenOcgLayerIds: (updater) => set((state) => ({
        hiddenOcgLayerIds: typeof updater === 'function' ? updater(state.hiddenOcgLayerIds) : updater,
    })),
    setLockedOcgLayerIds: (updater) => set((state) => ({
        lockedOcgLayerIds: typeof updater === 'function' ? updater(state.lockedOcgLayerIds) : updater,
    })),
    setExpandedOcgLayerIds: (updater) => set((state) => ({
        expandedOcgLayerIds: typeof updater === 'function' ? updater(state.expandedOcgLayerIds) : updater,
    })),
    setIsLayerPanelOpen: (updater) => set((state) => ({
        isLayerPanelOpen: typeof updater === 'function' ? updater(state.isLayerPanelOpen) : updater,
    })),
    setOcgPreviewUrl: (url) => set({ ocgPreviewUrl: url }),

    setVdpFields: (updater) => set((state) => ({
        vdpFields: typeof updater === 'function' ? updater(state.vdpFields) : updater,
    })),
    setSelectedVdpFieldIds: (ids) => set({ selectedVdpFieldIds: ids }),

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

    setViewerZoom: (updater) => set((state) => ({
        viewerZoom: typeof updater === 'function' ? updater(state.viewerZoom) : updater,
    })),
    setViewerFitMode: (mode) => set({ viewerFitMode: mode }),
    setViewerToolMode: (mode) => set({ viewerToolMode: mode }),
    setViewerPageDisplayMode: (mode) => set({ viewerPageDisplayMode: mode }),
    setViewerActivePage: (page) => set({ viewerActivePage: page }),
    setViewerNumPages: (n) => set({ viewerNumPages: n }),
    setViewerThumbMenuOpen: (v) => set({ viewerThumbMenuOpen: v }),
    setViewerThumbWidth: (w) => set({ viewerThumbWidth: w }),
    setViewerPageDimMm: (dim) => set({ viewerPageDimMm: dim }),
}));

export const WorkspaceContext = createContext<StoreApi<WorkspaceState> | null>(null);

export function useWorkspaceStore<T = WorkspaceState>(selector?: (state: WorkspaceState) => T): T {
    const store = useContext(WorkspaceContext);
    if (!store) throw new Error('Missing WorkspaceContext.Provider in the tree');
    return useStore(store, selector!) as T;
}

