/**
 * Zustand Store for Imposition Settings.
 *
 * Centralizes all 50+ useState declarations from ImposerDashboard into a
 * single reactive store, enabling any section/sub-component to read/write
 * settings without prop drilling.
 *
 * This store manages:
 *   - Paper settings (formsize, margins, classification)
 *   - Booklet settings (signatureMode, foliosize, creep, etc.)
 *   - N-Up / Step&Repeat settings (grid, cluster, align, etc.)
 *   - Marks & output settings (markType, bleed, etc.)
 *   - Auto Catalog state
 *   - Fold pattern & interleave settings
 *   - UI state (collapsed sections, modal visibility)
 */
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { createContext, useContext } from 'react';
import type { StoreApi } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CropMarksConfig } from './MarksSettingsDialog';
import { DEFAULT_MARKS_CONFIG } from './MarksSettingsDialog';
import { DEFAULT_PONT_CONFIG } from './PontSettingsDialog';
import type { PontConfig, TaskMode, ActiveToolType, NupSettings, ReportDisplayConfig } from './types';
import { PREDEFINED_SIZES, DEFAULT_REPORT_CONFIG } from './types';
import type { PlateJob } from '../../lib/imposerEngine/CatalogPlanner';


// ─── State Shape ────────────────────────────────────────────────────────────

export interface ImposerSettingsState {
    // ═══ Task Mode ═══
    taskMode: TaskMode;
    setTaskMode: (mode: TaskMode) => void;

    // ═══ Paper ═══
    formsize: string;
    setFormsize: (v: string) => void;
    customSheetWidth: number;
    setCustomSheetWidth: (v: number) => void;
    customSheetHeight: number;
    setCustomSheetHeight: (v: number) => void;
    gapX: number;
    setGapX: (v: number) => void;
    gapY: number;
    setGapY: (v: number) => void;
    spreadDistribution: 'clustered' | 'even';
    setSpreadDistribution: (v: 'clustered' | 'even') => void;
    marginMode: 'labels_only' | 'include_marks';
    setMarginMode: (v: 'labels_only' | 'include_marks') => void;
    marginTop: number;
    setMarginTop: (v: number) => void;
    marginBottom: number;
    setMarginBottom: (v: number) => void;
    marginLeft: number;
    setMarginLeft: (v: number) => void;
    marginRight: number;
    setMarginRight: (v: number) => void;
    paperClassification: 'offset' | 'in_nhanh';
    setPaperClassification: (v: 'offset' | 'in_nhanh') => void;
    gripperMargin: number;
    setGripperMargin: (v: number) => void;

    // ═══ Marks & Output ═══
    markType: 'none' | 'corners' | 'guillotine';
    setMarkType: (v: 'none' | 'corners' | 'guillotine') => void;
    cutType: 'default' | 'one_dao';
    setCutType: (v: 'default' | 'one_dao') => void;
    fillBlockGap: number;
    setFillBlockGap: (v: number) => void;
    pontType: 'none' | 'corner' | '5mm' | 'custom';
    setPontType: (v: 'none' | 'corner' | '5mm' | 'custom') => void;
    bleed: number;
    setBleed: (v: number) => void;
    showBleedView: boolean;
    setShowBleedView: (v: boolean) => void;
    spawnNewTab: boolean;
    setSpawnNewTab: (v: boolean) => void;
    marksConfig: CropMarksConfig;
    setMarksConfig: (v: CropMarksConfig) => void;
    pontConfig: PontConfig;
    setPontConfig: (v: PontConfig | ((prev: PontConfig) => PontConfig)) => void;
    separateCutPage: boolean;
    setSeparateCutPage: (v: boolean) => void;
    pontsOnCutFile: boolean;
    setPontsOnCutFile: (v: boolean) => void;

    // ═══ Report & Xuất tờ duy nhất (spec: binh-tem-be-report) ═══
    exportUniqueSheets: boolean;
    setExportUniqueSheets: (v: boolean) => void;
    reportDisplay: ReportDisplayConfig;
    setReportDisplay: (v: ReportDisplayConfig | ((prev: ReportDisplayConfig) => ReportDisplayConfig)) => void;
    customMaterials: string[];
    setCustomMaterials: (v: string[]) => void;
    reportMaterial: string;
    setReportMaterial: (v: string) => void;
    reportLamination: number;
    setReportLamination: (v: number) => void;
    reportLaminationSides: number;
    setReportLaminationSides: (v: number) => void;
    reportOrderCode: string;
    setReportOrderCode: (v: string) => void;
    saveByReport: boolean;
    setSaveByReport: (v: boolean) => void;

    // ═══ Bình Bế Rớt (CNC) — spec: binh-be-rot-cnc (2 mặt suy từ duplexFlow/SỐ MẶT) ═══
    cncFlipEdge: 'long' | 'short';
    setCncFlipEdge: (v: 'long' | 'short') => void;
    cncDuplexMarks: boolean;
    setCncDuplexMarks: (v: boolean) => void;
    savePrint: {
        nameMode: 'report' | 'number' | 'original';
        folderMode: 'per_order' | 'flat';
        includeOrderCode: boolean;
        includeDate: boolean;
        lastFolder: string;
        autoSave: boolean;
    };
    setSavePrint: (v: Partial<ImposerSettingsState['savePrint']>) => void;

    // ═══ Booklet ═══
    signatureMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    setSignatureMode: (v: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount') => void;
    foliosize: number;
    setFoliosize: (v: number) => void;
    paperThickness: number;
    setPaperThickness: (v: number) => void;
    gutterMargin: number;
    setGutterMargin: (v: number) => void;
    separateCover: boolean;
    setSeparateCover: (v: boolean) => void;
    coverPageCount: number;
    setCoverPageCount: (v: number) => void;
    blankPlacement: 'end' | 'center';
    setBlankPlacement: (v: 'end' | 'center') => void;
    scaleMode: '100' | 'fit' | 'chain_nup' | 'cut_stack';
    setScaleMode: (v: '100' | 'fit' | 'chain_nup' | 'cut_stack') => void;
    interleave: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180';
    setInterleave: (v: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180') => void;

    // ═══ N-Up / Step & Repeat ═══
    layoutType: 'repeat' | 'sequential' | 'cut_stacks';
    setLayoutType: (v: 'repeat' | 'sequential' | 'cut_stacks') => void;
    columns: number;
    setColumns: (v: number) => void;
    rows: number;
    setRows: (v: number) => void;
    gridStrategy: NupSettings['gridStrategy'];
    setGridStrategy: (v: NupSettings['gridStrategy']) => void;
    groupingStrategy: 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none';
    setGroupingStrategy: (v: 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none') => void;
    clusterTileW: number;
    setClusterTileW: (v: number) => void;
    clusterTileH: number;
    setClusterTileH: (v: number) => void;
    clusterSizingMode: 'dims' | 'split_cols' | 'split_rows';
    setClusterSizingMode: (v: 'dims' | 'split_cols' | 'split_rows') => void;
    clusterCols: number;
    setClusterCols: (v: number) => void;
    clusterRows: number;
    setClusterRows: (v: number) => void;
    tileGapX: number;
    setTileGapX: (v: number) => void;
    tileGapY: number;
    setTileGapY: (v: number) => void;
    clusterNesting: boolean;
    setClusterNesting: (v: boolean) => void;
    showGapSettings: boolean;
    setShowGapSettings: (v: boolean) => void;
    duplexFlow: 'normal' | 'double';
    setDuplexFlow: (v: 'normal' | 'double') => void;
    align: NupSettings['align'];
    setAlign: (v: NupSettings['align']) => void;
    clusterMode: 'none' | 'row' | 'column';
    setClusterMode: (v: 'none' | 'row' | 'column') => void;
    clusterCount: number;
    setClusterCount: (v: number) => void;
    clusterGap: number;
    setClusterGap: (v: number) => void;
    clusterGapMode: 'item' | 'mark';
    setClusterGapMode: (v: 'item' | 'mark') => void;
    clusterDistribution: 'default' | 'type';
    setClusterDistribution: (v: 'default' | 'type') => void;
    clusterBorder: boolean;
    setClusterBorder: (v: boolean) => void;
    targetQuantity: number;
    setTargetQuantity: (v: number) => void;
    targetQuantitiesByPage: Record<number, number>;
    setTargetQuantitiesByPage: (v: Record<number, number>) => void;
    previewCapacity: number;
    setPreviewCapacity: (v: number) => void;
    previewCapacities: Record<number, number>;
    setPreviewCapacities: (v: Record<number, number>) => void;
    mixedPlacedByPage: Record<number, number>;
    setMixedPlacedByPage: (v: Record<number, number>) => void;
    fetchEpoch: number;
    setFetchEpoch: (v: number | ((prev: number) => number)) => void;

    // ═══ Fold Pattern ═══
    foldPattern: string;
    setFoldPattern: (v: string) => void;

    // ═══ Auto Catalog ═══
    autoCatalog: boolean;
    setAutoCatalog: (v: boolean) => void;
    catalogHasCover: boolean;
    setCatalogHasCover: (v: boolean) => void;
    catalogMasterSigOverride: 'auto' | '16' | '8' | '4';
    setCatalogMasterSigOverride: (v: 'auto' | '16' | '8' | '4') => void;
    catalogRemainderPlacement: 'outside' | 'inside';
    setCatalogRemainderPlacement: (v: 'outside' | 'inside') => void;
    sourcePageDim: { w: number; h: number } | null;
    setSourcePageDim: (v: { w: number; h: number } | null) => void;
    sourcePageDims: { w: number; h: number }[];
    setSourcePageDims: (v: { w: number; h: number }[]) => void;
    optimalData: any;
    setOptimalData: (v: any) => void;
    catalogPreview: string;
    setCatalogPreview: (v: string) => void;
    catalogJobsState: PlateJob[] | null;
    setCatalogJobsState: (v: PlateJob[] | null) => void;

    // ═══ UI State ═══
    showSettings: boolean;
    setShowSettings: (v: boolean) => void;
    showMarksModal: boolean;
    setShowMarksModal: (v: boolean) => void;
    showPontModal: boolean;
    setShowPontModal: (v: boolean) => void;
    isPresetOpen: boolean;
    setIsPresetOpen: (v: boolean) => void;
    showFlipbook: boolean;
    setShowFlipbook: (v: boolean) => void;
    showSheetViewer: boolean;
    setShowSheetViewer: (v: boolean) => void;
    // ═══ Preprocessing ═══
    shuffleSettings: any;
    setShuffleSettings: (v: any) => void;
    resizeSettings: any;
    setResizeSettings: (v: any) => void;
    splitSettings: any;
    setSplitSettings: (v: any) => void;

    // ═══ Workspace / Imposition Orchestration State (migrated from useWorkspaceStore - P1-T03) ═══
    // activeDashboardTool: controls which tool/panel is active (booklet, nup, sticker_imposer, etc.)
    activeDashboardTool: string;
    setActiveDashboardTool: (tool: string) => void;
    // batchOutput for multi-sheet results (catalog etc.)
    batchOutput: { docs: { blob: Blob; filename: string; report?: string }[]; mergedBlob: Blob } | null;
    setBatchOutput: (output: { docs: { blob: Blob; filename: string; report?: string }[]; mergedBlob: Blob } | null) => void;
    // confirmBookletSettings for booklet confirmation modal
    confirmBookletSettings: { settings: any; spawnNewTab: boolean; report: string; totalPages: number; paddedPages: number } | null;
    setConfirmBookletSettings: (settings: { settings: any; spawnNewTab: boolean; report: string; totalPages: number; paddedPages: number } | null) => void;

    // ═══ Tool Profiles — chống rò rỉ state thuật toán giữa công cụ ═══
    toolProfiles: Record<string, Record<string, any>>;
    switchToolProfile: (prevTool: string, nextTool: string) => void;
}


// ─── Helpers ────────────────────────────────────────────────────────────────

function loadFromLocalStorage<T>(key: string, fallback: T): T {
    try {
        const saved = localStorage.getItem(key);
        return saved ? JSON.parse(saved) : fallback;
    } catch {
        return fallback;
    }
}


// ─── Store Definition ───────────────────────────────────────────────────────

// Các field "thuật toán" lưu RIÊNG theo từng công cụ (chống rò rỉ state giữa
// N-up / Bế tem / Booklet). Field "vật lý" (khổ giấy, lề, bù xén) KHÔNG nằm đây
// → vẫn dùng chung. (Task 15 / Req 5.1, 5.2, 5.4)
const ALGO_PROFILE_KEYS: string[] = [
    'layoutType', 'columns', 'rows', 'gridStrategy', 'groupingStrategy',
    'duplexFlow', 'align',
    'clusterMode', 'clusterCount', 'clusterGap', 'clusterGapMode',
    'clusterDistribution', 'clusterBorder',
    'clusterTileW', 'clusterTileH', 'clusterSizingMode', 'clusterCols', 'clusterRows',
    'tileGapX', 'tileGapY', 'clusterNesting',
    'cutType', 'fillBlockGap', 'pontType', 'pontConfig',
    'gapX', 'gapY', 'targetQuantity', 'targetQuantitiesByPage',
    'markType', 'scaleMode', 'signatureMode', 'foliosize', 'interleave',
    'separateCutPage', 'pontsOnCutFile',
    'cncFlipEdge', 'cncDuplexMarks',
];
const PROFILED_TOOLS = ['nup', 'sticker_imposer', 'cnc_imposer', 'booklet'];

export const createImposerSettingsStore = () => createStore<ImposerSettingsState>()(
    persist(
        (set, get) => ({
            // ═══ Task Mode ═══
            taskMode: 'nup' as TaskMode,
            setTaskMode: (mode) => {
                set({ taskMode: mode });
            },

            // ═══ Workspace / Imposition Orchestration (P1-T03 migration) ═══
            activeDashboardTool: 'none',
            setActiveDashboardTool: (tool) => set({ activeDashboardTool: tool }),
            batchOutput: null,
            setBatchOutput: (output) => set({ batchOutput: output }),
            confirmBookletSettings: null,
            setConfirmBookletSettings: (settings) => set({ confirmBookletSettings: settings }),

            // ═══ Paper ═══
            formsize: 'SRA3',
            setFormsize: (v) => set({ formsize: v }),
            customSheetWidth: 320,
            setCustomSheetWidth: (v) => set({ customSheetWidth: v }),
            customSheetHeight: 450,
            setCustomSheetHeight: (v) => set({ customSheetHeight: v }),
            gapX: 0,
            setGapX: (v) => set({ gapX: v }),
            gapY: 0,
            setGapY: (v) => set({ gapY: v }),
            spreadDistribution: 'clustered',
            setSpreadDistribution: (v) => set({ spreadDistribution: v }),
            marginMode: 'labels_only',
            setMarginMode: (v) => set({ marginMode: v }),
            marginTop: 5,
            setMarginTop: (v) => set({ marginTop: v }),
            marginBottom: 5,
            setMarginBottom: (v) => set({ marginBottom: v }),
            marginLeft: 0,
            setMarginLeft: (v) => set({ marginLeft: v }),
            marginRight: 0,
            setMarginRight: (v) => set({ marginRight: v }),
            paperClassification: 'in_nhanh',
            setPaperClassification: (v) => set({ paperClassification: v }),
            gripperMargin: 0,
            setGripperMargin: (v) => set({ gripperMargin: v }),

            // ═══ Marks & Output ═══
            markType: 'guillotine',
            setMarkType: (v) => set({ markType: v }),
            cutType: 'default',
            setCutType: (v) => set({ cutType: v }),
            fillBlockGap: 0,
            setFillBlockGap: (v) => set({ fillBlockGap: v }),
            pontType: 'none',
            setPontType: (v) => set({ pontType: v }),
            bleed: 2,
            setBleed: (v) => set({ bleed: v }),
            showBleedView: false,
            setShowBleedView: (v) => set({ showBleedView: v }),
            spawnNewTab: true,
            setSpawnNewTab: (v) => set({ spawnNewTab: v }),
            marksConfig: loadFromLocalStorage<CropMarksConfig>('ps_custom_marks_config', DEFAULT_MARKS_CONFIG),
            setMarksConfig: (v) => {
                localStorage.setItem('ps_custom_marks_config', JSON.stringify(v));
                set({ marksConfig: v });
            },
            pontConfig: DEFAULT_PONT_CONFIG,
            setPontConfig: (v) => {
                set((state) => {
                    const newConfig = typeof v === 'function' ? v(state.pontConfig) : v;
                    return { pontConfig: newConfig };
                });
            },
            separateCutPage: true,
            setSeparateCutPage: (v) => set({ separateCutPage: v }),
            pontsOnCutFile: true,
            setPontsOnCutFile: (v) => set({ pontsOnCutFile: v }),

            // ═══ Report & Xuất tờ duy nhất ═══
            exportUniqueSheets: true,
            setExportUniqueSheets: (v) => set({ exportUniqueSheets: v }),
            reportDisplay: DEFAULT_REPORT_CONFIG,
            setReportDisplay: (v) => set((state) => ({
                reportDisplay: typeof v === 'function' ? v(state.reportDisplay) : v,
            })),
            customMaterials: [],
            setCustomMaterials: (v) => set({ customMaterials: v }),
            reportMaterial: '',
            setReportMaterial: (v) => set({ reportMaterial: v }),
            reportLamination: 0,
            setReportLamination: (v) => set({ reportLamination: v }),
            reportLaminationSides: 1,
            setReportLaminationSides: (v) => set({ reportLaminationSides: v }),
            reportOrderCode: '',
            setReportOrderCode: (v) => set({ reportOrderCode: v }),
            saveByReport: false,
            setSaveByReport: (v) => set({ saveByReport: v }),

            // ═══ Bình Bế Rớt (CNC) ═══
            cncFlipEdge: 'long',
            setCncFlipEdge: (v) => set({ cncFlipEdge: v }),
            cncDuplexMarks: true,
            setCncDuplexMarks: (v) => set({ cncDuplexMarks: v }),
            savePrint: { nameMode: 'report', folderMode: 'per_order', includeOrderCode: true, includeDate: false, lastFolder: '', autoSave: false },
            setSavePrint: (v) => set((state) => ({ savePrint: { ...state.savePrint, ...v } })),

            // ═══ Booklet ═══
            signatureMode: 'saddle',
            setSignatureMode: (v) => set({ signatureMode: v }),
            foliosize: 16,
            setFoliosize: (v) => set({ foliosize: v }),
            paperThickness: 0,
            setPaperThickness: (v) => set({ paperThickness: v }),
            gutterMargin: 0,
            setGutterMargin: (v) => set({ gutterMargin: v }),
            separateCover: false,
            setSeparateCover: (v) => set({ separateCover: v }),
            coverPageCount: 4,
            setCoverPageCount: (v) => set({ coverPageCount: v }),
            blankPlacement: 'end',
            setBlankPlacement: (v) => set({ blankPlacement: v }),
            scaleMode: '100',
            setScaleMode: (v) => set({ scaleMode: v }),
            interleave: 'normal',
            setInterleave: (v) => set({ interleave: v }),

            // ═══ N-Up ═══
            layoutType: 'sequential',
            setLayoutType: (v) => set({ layoutType: v }),
            columns: 0,
            setColumns: (v) => set({ columns: v }),
            rows: 0,
            setRows: (v) => set({ rows: v }),
            gridStrategy: 'optimal_auto',
            setGridStrategy: (v) => set({ gridStrategy: v }),
            groupingStrategy: 'maximize_area',
            setGroupingStrategy: (v) => set({ groupingStrategy: v }),
            clusterTileW: 148,
            setClusterTileW: (v) => set({ clusterTileW: v }),
            clusterTileH: 210,
            setClusterTileH: (v) => set({ clusterTileH: v }),
            clusterSizingMode: 'dims',
            setClusterSizingMode: (v) => set({ clusterSizingMode: v }),
            clusterCols: 2,
            setClusterCols: (v) => set({ clusterCols: v }),
            clusterRows: 2,
            setClusterRows: (v) => set({ clusterRows: v }),
            tileGapX: 0,
            setTileGapX: (v) => set({ tileGapX: v }),
            tileGapY: 0,
            setTileGapY: (v) => set({ tileGapY: v }),
            clusterNesting: true,
            setClusterNesting: (v) => set({ clusterNesting: v }),
            showGapSettings: false,
            setShowGapSettings: (v) => set({ showGapSettings: v }),
            duplexFlow: 'normal',
            setDuplexFlow: (v) => set({ duplexFlow: v }),
            align: 'center',
            setAlign: (v) => set({ align: v }),
            clusterMode: 'none',
            setClusterMode: (v) => set({ clusterMode: v }),
            clusterCount: 2,
            setClusterCount: (v) => set({ clusterCount: v }),
            clusterGap: 10,
            setClusterGap: (v) => set({ clusterGap: v }),
            clusterGapMode: 'mark',
            setClusterGapMode: (v) => set({ clusterGapMode: v }),
            clusterDistribution: 'default',
            setClusterDistribution: (v) => set({ clusterDistribution: v }),
            clusterBorder: false,
            setClusterBorder: (v) => set({ clusterBorder: v }),
            targetQuantity: 0,
            setTargetQuantity: (v) => set({ targetQuantity: v }),
            targetQuantitiesByPage: {},
            setTargetQuantitiesByPage: (v) => set({ targetQuantitiesByPage: v }),
            previewCapacity: 0,
            setPreviewCapacity: (v) => set({ previewCapacity: v }),
            previewCapacities: {},
            setPreviewCapacities: (v) => set({ previewCapacities: v }),
            mixedPlacedByPage: {},
            setMixedPlacedByPage: (v) => set({ mixedPlacedByPage: v }),
            fetchEpoch: 0,
            setFetchEpoch: (v) => {
                set((state) => ({
                    fetchEpoch: typeof v === 'function' ? v(state.fetchEpoch) : v,
                }));
            },

            // ═══ Fold Pattern ═══
            foldPattern: '',
            setFoldPattern: (v) => set({ foldPattern: v }),

            // ═══ Auto Catalog ═══
            autoCatalog: false,
            setAutoCatalog: (v) => set({ autoCatalog: v }),
            catalogHasCover: true,
            setCatalogHasCover: (v) => set({ catalogHasCover: v }),
            catalogMasterSigOverride: 'auto',
            setCatalogMasterSigOverride: (v) => set({ catalogMasterSigOverride: v }),
            catalogRemainderPlacement: 'outside',
            setCatalogRemainderPlacement: (v) => set({ catalogRemainderPlacement: v }),
            sourcePageDim: null,
            setSourcePageDim: (v) => set({ sourcePageDim: v }),
            sourcePageDims: [],
            setSourcePageDims: (v) => set({ sourcePageDims: v }),
            optimalData: null,
            setOptimalData: (v) => set({ optimalData: v }),
            catalogPreview: '',
            setCatalogPreview: (v) => set({ catalogPreview: v }),
            catalogJobsState: null,
            setCatalogJobsState: (v) => set({ catalogJobsState: v }),

            // ═══ UI State ═══
            showSettings: false,
            setShowSettings: (v) => set({ showSettings: v }),
            showMarksModal: false,
            setShowMarksModal: (v) => set({ showMarksModal: v }),
            showPontModal: false,
            setShowPontModal: (v) => set({ showPontModal: v }),
            isPresetOpen: false,
            setIsPresetOpen: (v) => set({ isPresetOpen: v }),
            showFlipbook: false,
            setShowFlipbook: (v) => set({ showFlipbook: v }),
            showSheetViewer: false,
            setShowSheetViewer: (v) => set({ showSheetViewer: v }),
            // ═══ Preprocessing ═══
            shuffleSettings: { presetId: 'custom', rule: '', groupSize: 1, mode: 'normal' },
            setShuffleSettings: (v) => set({ shuffleSettings: v }),
            resizeSettings: { sizePresetId: 'A4', targetW: 210, targetH: 297, scaleMode: 'fit', applyTo: 'all', applyToStr: 'all' },
            setResizeSettings: (v) => set({ resizeSettings: v }),
            splitSettings: { mode: 'by_range', ranges: '', pagesPerFile: 1, pageListStr: '' },
            setSplitSettings: (v) => set({ splitSettings: v }),

            // ═══ Tool Profiles ═══
            toolProfiles: {},
            switchToolProfile: (prevTool, nextTool) => {
                if (!PROFILED_TOOLS.includes(prevTool) || !PROFILED_TOOLS.includes(nextTool) || prevTool === nextTool) return;
                set((state) => {
                    // Lưu field thuật toán hiện tại vào profile của tool CŨ
                    const snap: Record<string, any> = {};
                    for (const k of ALGO_PROFILE_KEYS) snap[k] = (state as any)[k];
                    const newProfiles = { ...state.toolProfiles, [prevTool]: snap };
                    // Nạp lại profile của tool MỚI (nếu đã có)
                    const updates: Record<string, any> = { toolProfiles: newProfiles };
                    const restored = newProfiles[nextTool];
                    if (restored) {
                        for (const k of ALGO_PROFILE_KEYS) {
                            if (restored[k] !== undefined) updates[k] = restored[k];
                        }
                    }
                    return updates as any;
                });
            },

            // ═══ Bulk Actions ═══ (đã xóa getSerializableState/applyParsedState — dead code, Task 20/Req 9.4)
        }),
        {
            name: 'ps_imposer_settings',
            version: 7,
            migrate: (persistedState: any, version: number) => {
                if (version < 2) {
                    // v1 → v2: add pontConfig to persisted state
                    persistedState = { ...persistedState, pontConfig: persistedState.pontConfig || DEFAULT_PONT_CONFIG };
                }
                if (version < 3) {
                    // v2 → v3: thêm toolProfiles (chống rò rỉ state giữa công cụ)
                    persistedState = { ...persistedState, toolProfiles: persistedState.toolProfiles || {} };
                }
                if (version < 4) {
                    // v3 → v4: thêm cấu hình report + xuất tờ duy nhất
                    persistedState = {
                        ...persistedState,
                        exportUniqueSheets: persistedState.exportUniqueSheets ?? true,
                        reportDisplay: persistedState.reportDisplay || DEFAULT_REPORT_CONFIG,
                        customMaterials: persistedState.customMaterials || [],
                    };
                }
                if (version < 5) {
                    // v4 → v5: thêm cấu hình lưu file in
                    persistedState = {
                        ...persistedState,
                        savePrint: persistedState.savePrint || { nameMode: 'report', folderMode: 'per_order', includeOrderCode: true, includeDate: false, lastFolder: '', autoSave: false },
                    };
                }
                if (version < 6) {
                    // v5 → v6: thêm cấu hình Bình Bế Rớt (CNC)
                    persistedState = {
                        ...persistedState,
                        cncFlipEdge: persistedState.cncFlipEdge || 'long',
                        cncDuplexMarks: persistedState.cncDuplexMarks ?? true,
                    };
                }
                if (version < 7) {
                    // v6 → v7: thêm showGangCount + gangCount vào reportDisplay
                    const rd = persistedState.reportDisplay || {};
                    if (rd.showGangCount === undefined) rd.showGangCount = true;
                    const fo = rd.fieldOrder || [];
                    if (!fo.includes('gangCount')) {
                        const idx = fo.indexOf('identifier');
                        if (idx >= 0) fo.splice(idx + 1, 0, 'gangCount');
                        else fo.push('gangCount');
                    }
                    rd.fieldOrder = fo;
                    persistedState = { ...persistedState, reportDisplay: rd };
                }
                return persistedState;
            },
            partialize: (state) => ({
                taskMode: state.taskMode,
                formsize: state.formsize, customSheetWidth: state.customSheetWidth, customSheetHeight: state.customSheetHeight,
                gapX: state.gapX, gapY: state.gapY, spreadDistribution: state.spreadDistribution,
                marginMode: state.marginMode, marginTop: state.marginTop, marginBottom: state.marginBottom,
                marginLeft: state.marginLeft, marginRight: state.marginRight,
                paperClassification: state.paperClassification, gripperMargin: state.gripperMargin,
                markType: state.markType, cutType: state.cutType, fillBlockGap: state.fillBlockGap, pontType: state.pontType,
                pontConfig: state.pontConfig,
                bleed: state.bleed, spawnNewTab: state.spawnNewTab,
                separateCutPage: state.separateCutPage, pontsOnCutFile: state.pontsOnCutFile,
                signatureMode: state.signatureMode, foliosize: state.foliosize,
                paperThickness: state.paperThickness, scaleMode: state.scaleMode, interleave: state.interleave,
                layoutType: state.layoutType, columns: state.columns, rows: state.rows,
                gridStrategy: state.gridStrategy, groupingStrategy: state.groupingStrategy,
                clusterTileW: state.clusterTileW, clusterTileH: state.clusterTileH,
                clusterSizingMode: state.clusterSizingMode, clusterCols: state.clusterCols, clusterRows: state.clusterRows,
                tileGapX: state.tileGapX, tileGapY: state.tileGapY, clusterNesting: state.clusterNesting,
                duplexFlow: state.duplexFlow, align: state.align,
                clusterMode: state.clusterMode, clusterCount: state.clusterCount, clusterGap: state.clusterGap,
                clusterGapMode: state.clusterGapMode, clusterDistribution: state.clusterDistribution,
                clusterBorder: state.clusterBorder,
                foldPattern: state.foldPattern,
                autoCatalog: state.autoCatalog, catalogHasCover: state.catalogHasCover,
                catalogMasterSigOverride: state.catalogMasterSigOverride, catalogRemainderPlacement: state.catalogRemainderPlacement,
                gutterMargin: state.gutterMargin, separateCover: state.separateCover, coverPageCount: state.coverPageCount,
                blankPlacement: state.blankPlacement,
                toolProfiles: state.toolProfiles,
                exportUniqueSheets: state.exportUniqueSheets, reportDisplay: state.reportDisplay,
                customMaterials: state.customMaterials, reportMaterial: state.reportMaterial,
                reportLamination: state.reportLamination, reportLaminationSides: state.reportLaminationSides,
                saveByReport: state.saveByReport,
                savePrint: state.savePrint,
                cncFlipEdge: state.cncFlipEdge,
                cncDuplexMarks: state.cncDuplexMarks,
            }),
            onRehydrateStorage: () => (state) => {
                // Silently rehydrate
            },
        }
    )
);

export const ImposerSettingsContext = createContext<StoreApi<ImposerSettingsState> | null>(null);

export function useImposerSettingsStore<T = ImposerSettingsState>(selector?: (state: ImposerSettingsState) => T): T {
    const store = useContext(ImposerSettingsContext);
    if (!store) throw new Error('Missing ImposerSettingsContext.Provider in the tree');
    return useStore(store, selector!) as T;
}
