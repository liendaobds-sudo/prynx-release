import { create } from 'zustand';

import {
    closeStickerSheetSession,
    confirmStickerSource,
    detectStickerSource,
    exportStickerSheet,
    inspectStickerSource,
    loadStickerSourcePreview,
    previewStickerCutline,
    refineStickerSource,
    type StickerDetectionStrategy,
    type StickerSheetExportPayload,
    type StickerSheetModel,
    type StickerShadowCleanup,
    type StickerCutlinePreview,
    type StickerSourceDetection,
    type StickerSourceInspection,
} from '../../lib/stickerSheetApi';
import { localFileUrl } from '../../lib/localFileTransport';
import { imageFilesToPdfFile } from '../../lib/imageNormalizer';
import { getFileArrayBuffer } from '../../lib/utils';
import {
    DEFAULT_STICKER_OUTPUT_SETTINGS,
    sanitizeStickerOutputSettings,
    type StickerOutputSettings,
} from './stickerOutputSettings';


export type StickerSourceMode = 'existing' | 'ai-sheet';
export type StickerProductType = 'sticker' | 'rectangle';
export type StickerMaskTool = 'erase' | 'restore' | 'merge';
export type StickerSheetStatus =
    | 'idle'
    | 'source-ready'
    | 'inspecting'
    | 'detecting'
    | 'mask-review'
    | 'confirming'
    | 'mask-ready'
    | 'exporting'
    | 'error';

/**
 * REVISION (audit 2026-08-25 §REV.05): nguồn workspace được khóa vào đúng
 * snapshot đã materialize. Store coi revision là opaque; resolver sở hữu phép
 * kiểm tra current để không kéo dependency Workspace vào store nghiệp vụ.
 */
export interface StickerWorkspaceSourceLease {
    file: File;
    revision: object;
    isCurrent: () => boolean;
}

export type PrepareStickerWorkspaceSource = () => Promise<StickerWorkspaceSourceLease>;

export interface NormalizedMaskPoint {
    x: number;
    y: number;
}

export interface StickerMaskStroke {
    kind: 'stroke';
    id: string;
    tool: 'erase' | 'restore';
    instanceId: number;
    radius: number;
    points: NormalizedMaskPoint[];
}

export interface StickerMergeEdit {
    kind: 'merge';
    id: string;
    sourceId: number;
    targetId: number;
}

export type StickerSheetEdit = StickerMaskStroke | StickerMergeEdit;

export interface StickerCutlineTuning {
    smoothness: number;
    fidelity: number;
    tension: number;
    minDetailAreaMm2: number;
    /** §CUTJAG.3 — thanh "Khử răng cưa" 0–100. */
    cutlineDenoise: number;
}

export interface StickerSheetPageState {
    status: StickerSheetStatus;
    isRefining: boolean;
    isCutlinePreviewing: boolean;
    manifest: StickerSourceDetection | null;
    previewUrl: string;
    labelsUrl: string;
    uncertaintyUrl: string;
    selectedInstanceId: number | null;
    edits: StickerSheetEdit[];
    redoEdits: StickerSheetEdit[];
    alphaThreshold: number;
    shadowCleanup: StickerShadowCleanup;
    cutlinePreview: StickerCutlinePreview | null;
    cutlineSmoothness: number;
    cutlineFidelity: number;
    curveTension: number;
    minDetailAreaMm2: number;
    cutlineDenoise: number;
    outputDpi: number;
    outputDpiY: number;
    preserveExistingCut: boolean;
    error: string;
}

export interface StickerSheetTabState {
    mode: StickerSourceMode;
    productType: StickerProductType;
    status: StickerSheetStatus;
    isExporting: boolean;
    isRefining: boolean;
    isCutlinePreviewing: boolean;
    sourceFile: File | null;
    sourceImageCount: number;
    sourceOrigin: 'workspace' | 'explicit';
    /** Snapshot immutable tạo ra đúng `sourceFile` của workspace. */
    sourceRevision: object | null;
    sourcePreviewUrl: string;
    sourcePreviewReady: boolean;
    inspection: StickerSourceInspection | null;
    activeSourcePage: number;
    pages: Record<number, StickerSheetPageState>;
    manifest: StickerSourceDetection | null;
    previewUrl: string;
    labelsUrl: string;
    uncertaintyUrl: string;
    selectedInstanceId: number | null;
    activeTool: StickerMaskTool;
    brushRadius: number;
    edits: StickerSheetEdit[];
    redoEdits: StickerSheetEdit[];
    model: StickerSheetModel;
    alphaThreshold: number;
    shadowCleanup: StickerShadowCleanup;
    cutlinePreview: StickerCutlinePreview | null;
    cutlineSmoothness: number;
    cutlineFidelity: number;
    curveTension: number;
    minDetailAreaMm2: number;
    cutlineDenoise: number;
    outputDpi: number;
    outputDpiY: number;
    outputSettings: StickerOutputSettings;
    preserveExistingCut: boolean;
    error: string;
}

interface StickerSheetStore {
    tabs: Record<string, StickerSheetTabState>;
    initTab: (tabId: string) => void;
    getTab: (tabId: string) => StickerSheetTabState;
    setMode: (tabId: string, mode: StickerSourceMode) => void;
    setProductType: (tabId: string, productType: StickerProductType) => void;
    setActiveTool: (tabId: string, tool: StickerMaskTool) => void;
    setBrushRadius: (tabId: string, radius: number) => void;
    setSelectedInstance: (tabId: string, instanceId: number | null) => void;
    setOutputDpi: (tabId: string, dpi: number, dpiY?: number) => void;
    setOutputSettings: (tabId: string, settings: Partial<StickerOutputSettings>) => void;
    setPreserveExistingCut: (tabId: string, preserve: boolean) => void;
    setActivePage: (tabId: string, pageNumber: number) => void;
    selectSource: (
        tabId: string,
        file: File,
        sourceOrigin?: 'workspace' | 'explicit',
        sourceImageCount?: number,
        sourceRevision?: object | null,
    ) => void;
    selectSources: (
        tabId: string,
        files: readonly File[],
        sourceOrigin?: 'workspace' | 'explicit',
    ) => Promise<void>;
    inspectSource: (tabId: string, workspaceLease?: StickerWorkspaceSourceLease | null) => Promise<boolean>;
    detectStickers: (
        tabId: string,
        strategy?: StickerDetectionStrategy,
        pageNumber?: number,
        prepareWorkspaceSource?: PrepareStickerWorkspaceSource,
    ) => Promise<void>;
    detectAllStickers: (
        tabId: string,
        strategy?: StickerDetectionStrategy,
        prepareWorkspaceSource?: PrepareStickerWorkspaceSource,
    ) => Promise<void>;
    setMaskTuning: (
        tabId: string,
        tuning: Partial<{ alphaThreshold: number; shadowCleanup: StickerShadowCleanup }>,
    ) => void;
    setCutlineTuning: (tabId: string, tuning: Partial<StickerCutlineTuning>) => void;
    confirmMask: (tabId: string, pageNumber?: number) => Promise<void>;
    exportFile: (
        tabId: string,
        outputFormat?: 'pdf' | 'png_zip',
        pageOrder?: number[],
        prepareWorkspaceSource?: PrepareStickerWorkspaceSource,
    ) => Promise<StickerSheetExportPayload | null>;
    invalidateWorkspaceSource: (tabId: string, message?: string) => void;
    finishExport: (tabId: string) => void;
    addStroke: (tabId: string, stroke: Omit<StickerMaskStroke, 'kind' | 'id'>) => void;
    mergeInstance: (tabId: string, sourceId: number, targetId: number) => void;
    undo: (tabId: string) => void;
    redo: (tabId: string) => void;
    resetAnalysis: (tabId: string) => void;
    disposeTab: (tabId: string) => void;
}

const REQUEST_CONTROLLERS = new Map<string, AbortController>();
const REQUEST_GENERATIONS = new Map<string, number>();
const REFINE_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();
const REFINE_RUNNING = new Set<string>();
const REFINE_DESIRED = new Map<string, {
    sessionId: string;
    alphaThreshold: number;
    shadowCleanup: StickerShadowCleanup;
    pageNumber: number;
}>();
const CUTLINE_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();
const CUTLINE_RUNNING = new Set<string>();
const CUTLINE_DESIRED = new Map<string, StickerCutlinePreviewRequest>();

function sameStickerOutputSettings(
    left: StickerOutputSettings,
    right: StickerOutputSettings,
): boolean {
    return (
        left.cutMode === right.cutMode
        && left.offsetMm === right.offsetMm
        && left.cornerStyle === right.cornerStyle
        && left.fillHoles === right.fillHoles
        && left.bleedMm === right.bleedMm
        && left.bleedColorType === right.bleedColorType
        && left.cropToSticker === right.cropToSticker
        && left.solidBleedCmyk.every((value, index) => value === right.solidBleedCmyk[index])
    );
}

function cutlineGeometryChanged(
    previous: StickerOutputSettings,
    next: StickerOutputSettings,
): boolean {
    if (
        previous.cutMode !== next.cutMode
        || previous.offsetMm !== next.offsetMm
        || previous.cornerStyle !== next.cornerStyle
        || previous.fillHoles !== next.fillHoles
    ) return true;

    // PERF (feedback 2026-08-11 §CUTLINE.NOREBUILD1): màu/crop không đi vào
    // endpoint CutContour; độ rộng tràn lề chỉ dời dao ở chế độ cắt theo tràn lề.
    return (
        (previous.cutMode === 'bleed' || next.cutMode === 'bleed')
        && previous.bleedMm !== next.bleedMm
    );
}

function defaultPageState(status: StickerSheetStatus = 'idle'): StickerSheetPageState {
    return {
        status,
        isRefining: false,
        isCutlinePreviewing: false,
        manifest: null,
        previewUrl: '',
        labelsUrl: '',
        uncertaintyUrl: '',
        selectedInstanceId: null,
        edits: [],
        redoEdits: [],
        alphaThreshold: 128,
        shadowCleanup: 'auto',
        cutlinePreview: null,
        cutlineSmoothness: 50,
        cutlineFidelity: 50,
        curveTension: 50,
        minDetailAreaMm2: 1,
        // §CUTJAG.3: 50 → sigma 1,25 px ở 300 DPI, đúng mức đã đo ở §CUTJAG.1
        // (biên mask AI: góc gấp trung bình 13–21° → 4,1–6,7°, IoU vẫn > 0,997).
        cutlineDenoise: 50,
        outputDpi: 72,
        outputDpiY: 72,
        preserveExistingCut: true,
        error: '',
    };
}

function defaultTabState(): StickerSheetTabState {
    return {
        mode: 'existing',
        productType: 'sticker',
        status: 'idle',
        isExporting: false,
        isRefining: false,
        isCutlinePreviewing: false,
        sourceFile: null,
        sourceImageCount: 0,
        sourceOrigin: 'workspace',
        sourceRevision: null,
        sourcePreviewUrl: '',
        sourcePreviewReady: false,
        inspection: null,
        activeSourcePage: 1,
        pages: {},
        manifest: null,
        previewUrl: '',
        labelsUrl: '',
        uncertaintyUrl: '',
        selectedInstanceId: null,
        activeTool: 'erase',
        brushRadius: 0.015,
        edits: [],
        redoEdits: [],
        model: 'birefnet-lite',
        alphaThreshold: 128,
        shadowCleanup: 'auto',
        cutlinePreview: null,
        cutlineSmoothness: 50,
        cutlineFidelity: 50,
        curveTension: 50,
        minDetailAreaMm2: 1,
        cutlineDenoise: 50,
        // SIZE (audit 2026-08-05 §AI2.SIZE1): ảnh không metadata DPI phải dùng
        // cùng quy ước 72 DPI của cửa mở ảnh, tránh thu nhỏ kết quả 4,1667 lần.
        outputDpi: 72,
        outputDpiY: 72,
        // UIUX (rollback 2026-08-09 §STICKER.AI1): tab AI trở lại bộ thiết lập
        // độc lập như giao diện cũ; không mang góc/crop/màu bù xén từ luồng PDF sang.
        outputSettings: sanitizeStickerOutputSettings({
            ...DEFAULT_STICKER_OUTPUT_SETTINGS,
            bleedMm: 2,
        }),
        preserveExistingCut: true,
        error: '',
    };
}

function isPdfSourceFile(file: File | null): boolean {
    return Boolean(file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')));
}

function pageState(tab: StickerSheetTabState, pageNumber: number): StickerSheetPageState {
    const existing = tab.pages[pageNumber];
    if (existing) return existing;
    if (pageNumber === tab.activeSourcePage) {
        return {
            status: tab.status,
            isRefining: tab.isRefining,
            isCutlinePreviewing: tab.isCutlinePreviewing,
            manifest: tab.manifest,
            previewUrl: tab.previewUrl,
            labelsUrl: tab.labelsUrl,
            uncertaintyUrl: tab.uncertaintyUrl,
            selectedInstanceId: tab.selectedInstanceId,
            edits: tab.edits,
            redoEdits: tab.redoEdits,
            alphaThreshold: tab.alphaThreshold,
            shadowCleanup: tab.shadowCleanup,
            cutlinePreview: tab.cutlinePreview,
            cutlineSmoothness: tab.cutlineSmoothness,
            cutlineFidelity: tab.cutlineFidelity,
            curveTension: tab.curveTension,
            minDetailAreaMm2: tab.minDetailAreaMm2,
            cutlineDenoise: tab.cutlineDenoise,
            outputDpi: tab.outputDpi,
            outputDpiY: tab.outputDpiY,
            preserveExistingCut: tab.preserveExistingCut,
            error: tab.error,
        };
    }
    return defaultPageState(tab.sourceFile ? 'source-ready' : 'idle');
}

function mirrorActivePage(
    tab: StickerSheetTabState,
    pageNumber: number,
    page: StickerSheetPageState,
): StickerSheetTabState {
    return { ...tab, ...page, activeSourcePage: pageNumber };
}

function updatePage(
    tab: StickerSheetTabState,
    pageNumber: number,
    updater: (page: StickerSheetPageState) => StickerSheetPageState,
): StickerSheetTabState {
    const page = updater(pageState(tab, pageNumber));
    const updated = { ...tab, pages: { ...tab.pages, [pageNumber]: page } };
    return tab.activeSourcePage === pageNumber
        ? mirrorActivePage(updated, pageNumber, page)
        : updated;
}

function revokeUrl(url: string): void {
    if (
        url.startsWith('blob:')
        && typeof URL !== 'undefined'
        && typeof URL.revokeObjectURL === 'function'
    ) {
        URL.revokeObjectURL(url);
    }
}

function releaseAssets(tab: StickerSheetTabState): void {
    revokeUrl(tab.sourcePreviewUrl);
    const pages = Object.values(tab.pages);
    if (pages.length > 0) pages.forEach(revokeAnalysisAssets);
    else revokeAnalysisAssets(tab);
    const sessionId = tab.inspection?.session_id || tab.manifest?.session_id;
    if (sessionId) void closeStickerSheetSession(sessionId);
}

function revokeAnalysisAssets(
    state: Pick<StickerSheetPageState, 'previewUrl' | 'labelsUrl' | 'uncertaintyUrl'>,
): void {
    revokeUrl(state.previewUrl);
    revokeUrl(state.labelsUrl);
    revokeUrl(state.uncertaintyUrl);
}

function createSourcePreviewUrl(file: File): string {
    const nativePath = (file as File & { path?: string }).path;
    // FILEIO (audit 2026-08-08 §UNIFIED.NATIVE1): File từ Tauri chỉ mang
    // đường dẫn, phần Blob có thể rỗng. Dùng protocol localfile để preview
    // đúng bytes trên đĩa trước khi người dùng bấm Nhận diện tem.
    if (nativePath) return localFileUrl(nativePath);
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
    return URL.createObjectURL(file);
}

function workflowMutationLocked(tab: StickerSheetTabState): boolean {
    return tab.isExporting
        || (Object.keys(tab.pages).length === 0 && (
            tab.isRefining || tab.status === 'confirming' || tab.status === 'exporting'
        ))
        || Object.values(tab.pages).some(page => (
            page.isRefining || page.status === 'confirming' || page.status === 'exporting'
        ));
}

function makeEditId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function documentRequestKey(tabId: string): string {
    return `${tabId}:document`;
}

function pageRequestKey(tabId: string, pageNumber: number): string {
    return `${tabId}:page:${pageNumber}`;
}

function nextRequest(requestKey: string): { controller: AbortController; generation: number } {
    REQUEST_CONTROLLERS.get(requestKey)?.abort();
    const generation = (REQUEST_GENERATIONS.get(requestKey) || 0) + 1;
    const controller = new AbortController();
    REQUEST_GENERATIONS.set(requestKey, generation);
    REQUEST_CONTROLLERS.set(requestKey, controller);
    return { controller, generation };
}

function requestIsCurrent(
    requestKey: string,
    controller: AbortController,
    generation: number,
): boolean {
    return (
        !controller.signal.aborted
        && REQUEST_CONTROLLERS.get(requestKey) === controller
        && REQUEST_GENERATIONS.get(requestKey) === generation
    );
}

function cancelRequests(tabId: string): void {
    const prefix = `${tabId}:`;
    for (const [key, controller] of REQUEST_CONTROLLERS) {
        if (!key.startsWith(prefix)) continue;
        controller.abort();
        REQUEST_CONTROLLERS.delete(key);
        REQUEST_GENERATIONS.set(key, (REQUEST_GENERATIONS.get(key) || 0) + 1);
    }
    for (const [key, timer] of REFINE_TIMERS) {
        if (!key.startsWith(prefix)) continue;
        clearTimeout(timer);
        REFINE_TIMERS.delete(key);
        REFINE_DESIRED.delete(key);
    }
    for (const [key, timer] of CUTLINE_TIMERS) {
        if (!key.startsWith(prefix)) continue;
        clearTimeout(timer);
        CUTLINE_TIMERS.delete(key);
        CUTLINE_DESIRED.delete(key);
    }
}

function isRefineAssetSyncError(
    error: unknown,
): error is Error & { manifest: StickerSourceDetection } {
    return (
        error instanceof Error
        && error.name === 'StickerRefineAssetSyncError'
        && 'manifest' in error
    );
}

function workspaceLeaseMatches(
    tab: StickerSheetTabState,
    lease: StickerWorkspaceSourceLease | null | undefined,
): boolean {
    return tab.sourceOrigin !== 'workspace' || Boolean(
        lease
        && lease.isCurrent()
        && tab.sourceFile === lease.file
        && tab.sourceRevision === lease.revision,
    );
}

async function prepareActionSource(
    tabId: string,
    prepareWorkspaceSource: PrepareStickerWorkspaceSource | undefined,
    get: () => StickerSheetStore,
): Promise<{
    tab: StickerSheetTabState;
    workspaceLease: StickerWorkspaceSourceLease | null;
}> {
    let tab = get().tabs[tabId];
    if (!tab) throw new Error('Không tìm thấy phiên Tách nhiều tem.');
    if (tab.sourceOrigin !== 'workspace') return { tab, workspaceLease: null };
    if (!prepareWorkspaceSource) {
        throw new Error('Không chuẩn bị được revision PDF đang hiển thị. Hãy mở lại công cụ.');
    }

    const workspaceLease = await prepareWorkspaceSource();
    if (!workspaceLease.isCurrent()) {
        throw new Error('Tài liệu đã thay đổi trong lúc chuẩn bị. Hãy nhận diện lại.');
    }

    // Trong lúc await, người dùng có thể đã chọn một nguồn kéo thả độc lập.
    // Nguồn explicit là owner riêng và tuyệt đối không bị workspace ghi đè.
    tab = get().tabs[tabId];
    if (!tab) throw new Error('Phiên Tách nhiều tem đã đóng.');
    if (tab.sourceOrigin !== 'workspace') return { tab, workspaceLease: null };

    if (tab.sourceFile !== workspaceLease.file || tab.sourceRevision !== workspaceLease.revision) {
        get().selectSource(
            tabId,
            workspaceLease.file,
            'workspace',
            1,
            workspaceLease.revision,
        );
        tab = get().tabs[tabId];
    }
    if (!tab || !workspaceLeaseMatches(tab, workspaceLease)) {
        throw new Error('Revision nguồn đã đổi trước khi bắt đầu nhận diện. Hãy thử lại.');
    }
    return { tab, workspaceLease };
}

export const useStickerSheetStore = create<StickerSheetStore>((set, get) => ({
    tabs: {},

    initTab: (tabId) => {
        if (!get().tabs[tabId]) {
            set(state => ({ tabs: { ...state.tabs, [tabId]: defaultTabState() } }));
        }
    },
    getTab: (tabId) => get().tabs[tabId] || defaultTabState(),
    setMode: (tabId, mode) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        if (workflowMutationLocked(tab)) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...tab, mode } } };
    }),
    setProductType: (tabId, productType) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        if (workflowMutationLocked(tab)) return state;
        return { tabs: { ...state.tabs, [tabId]: { ...tab, productType } } };
    }),
    setActiveTool: (tabId, activeTool) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        return { tabs: { ...state.tabs, [tabId]: { ...tab, activeTool } } };
    }),
    setBrushRadius: (tabId, brushRadius) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        const normalized = Math.max(0.002, Math.min(0.08, brushRadius));
        return { tabs: { ...state.tabs, [tabId]: { ...tab, brushRadius: normalized } } };
    }),
    setSelectedInstance: (tabId, selectedInstanceId) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        return {
            tabs: {
                ...state.tabs,
                [tabId]: updatePage(tab, tab.activeSourcePage, page => ({
                    ...page, selectedInstanceId,
                })),
            },
        };
    }),
    setOutputDpi: (tabId, dpi, dpiY = dpi) => {
        let pageNumber = 1;
        let changed = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            if (workflowMutationLocked(tab)) return state;
            pageNumber = tab.activeSourcePage;
            changed = true;
            const outputDpi = Math.max(36, Math.min(2400, dpi));
            const outputDpiY = Math.max(36, Math.min(2400, dpiY));
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(tab, pageNumber, page => ({
                        ...page,
                        outputDpi,
                        outputDpiY,
                        cutlinePreview: null,
                    })),
                },
            };
        });
        if (changed) scheduleCurrentCutlinePreview(tabId, pageNumber);
    },
    setOutputSettings: (tabId, settings) => {
        let pageNumber = 1;
        let changed = false;
        let shouldRefreshPreview = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            if (workflowMutationLocked(tab)) return state;
            const outputSettings = sanitizeStickerOutputSettings({
                ...tab.outputSettings,
                ...settings,
            });
            if (sameStickerOutputSettings(tab.outputSettings, outputSettings)) return state;
            pageNumber = tab.activeSourcePage;
            changed = true;
            shouldRefreshPreview = cutlineGeometryChanged(tab.outputSettings, outputSettings);
            const pages = shouldRefreshPreview
                ? Object.fromEntries(Object.entries(tab.pages).map(([key, page]) => [
                    key,
                    {
                        ...page,
                        preserveExistingCut: false,
                        cutlinePreview: null,
                        isCutlinePreviewing: false,
                    },
                ])) as Record<number, StickerSheetPageState>
                : tab.pages;
            const updated = { ...tab, outputSettings, pages };
            const activePage = pageState(updated, updated.activeSourcePage);
            return {
                tabs: {
                    ...state.tabs,
                    // Thay thiết lập hình học là yêu cầu dựng lại có chủ đích ở mọi trang.
                    [tabId]: mirrorActivePage(
                        updated,
                        updated.activeSourcePage,
                        shouldRefreshPreview
                            ? { ...activePage, preserveExistingCut: false }
                            : activePage,
                    ),
                },
            };
        });
        if (changed && shouldRefreshPreview) scheduleCurrentCutlinePreview(tabId, pageNumber);
    },
    setPreserveExistingCut: (tabId, preserveExistingCut) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        if (workflowMutationLocked(tab)) return state;
        return {
            tabs: {
                ...state.tabs,
                [tabId]: updatePage(tab, tab.activeSourcePage, page => ({
                    ...page, preserveExistingCut,
                })),
            },
        };
    }),
    setActivePage: (tabId, pageNumber) => {
        let normalized = 1;
        let needsPreview = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            normalized = Math.max(1, Math.min(
                tab.inspection?.page_count || Math.max(1, pageNumber),
                Math.round(pageNumber),
            ));
            const page = pageState(tab, normalized);
            needsPreview = Boolean(page.manifest && !page.cutlinePreview);
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: mirrorActivePage(
                        { ...tab, pages: { ...tab.pages, [normalized]: page } },
                        normalized,
                        page,
                    ),
                },
            };
        });
        if (needsPreview) scheduleCurrentCutlinePreview(tabId, normalized, 0);
    },
    selectSource: (
        tabId,
        file,
        sourceOrigin = 'explicit',
        sourceImageCount = 1,
        sourceRevision = null,
    ) => {
        const previous = get().tabs[tabId] || defaultTabState();
        if (
            (
                previous.sourceFile === file
                && previous.sourceOrigin === sourceOrigin
                && previous.sourceRevision === sourceRevision
            )
            || workflowMutationLocked(previous)
        ) return;
        cancelRequests(tabId);
        releaseAssets(previous);
        const sourcePreviewUrl = createSourcePreviewUrl(file);
        const sourcePreviewReady = !isPdfSourceFile(file);
        // UIUX (audit 2026-08-08 §UNIFIED.1-2): chọn nguồn chỉ dựng preview gốc;
        // tuyệt đối chưa gọi model hoặc sinh mask trước thao tác Nhận diện tem.
        const page = defaultPageState('source-ready');
        const next = mirrorActivePage({
            ...previous,
            isExporting: false,
            sourceFile: file,
            sourceImageCount: Math.max(1, Math.round(sourceImageCount)),
            sourceOrigin,
            sourceRevision,
            sourcePreviewUrl,
            sourcePreviewReady,
            inspection: null,
            activeSourcePage: 1,
            pages: { 1: page },
        }, 1, page);
        set(state => ({ tabs: { ...state.tabs, [tabId]: next } }));
    },
    invalidateWorkspaceSource: (tabId, message = 'Tài liệu đã thay đổi. Hãy nhận diện lại.') => {
        const previous = get().tabs[tabId];
        if (!previous || previous.sourceOrigin !== 'workspace') return;
        cancelRequests(tabId);
        releaseAssets(previous);
        const sourceFile = previous.sourceFile;
        const page = defaultPageState(sourceFile ? 'source-ready' : 'idle');
        page.error = message;
        const base = defaultTabState();
        const next = mirrorActivePage({
            ...base,
            mode: previous.mode,
            productType: previous.productType,
            model: previous.model,
            outputSettings: previous.outputSettings,
            sourceFile,
            sourceImageCount: previous.sourceImageCount,
            sourceOrigin: 'workspace',
            sourceRevision: null,
            sourcePreviewUrl: sourceFile ? createSourcePreviewUrl(sourceFile) : '',
            sourcePreviewReady: sourceFile ? !isPdfSourceFile(sourceFile) : false,
            pages: sourceFile ? { 1: page } : {},
            error: message,
        }, 1, page);
        set(state => ({ tabs: { ...state.tabs, [tabId]: next } }));
    },
    selectSources: async (tabId, files, sourceOrigin = 'explicit') => {
        const sources = Array.from(files);
        if (sources.length === 0) return;
        const previous = get().tabs[tabId] || defaultTabState();
        if (workflowMutationLocked(previous)) return;
        if (sources.length === 1) {
            get().selectSource(tabId, sources[0], sourceOrigin, 1);
            return;
        }

        const requestKey = documentRequestKey(tabId);
        const { controller, generation } = nextRequest(requestKey);
        set(state => {
            const current = state.tabs[tabId] || defaultTabState();
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: { ...current, status: 'inspecting', isExporting: false, error: '' },
                },
            };
        });
        try {
            // UIUX (audit 2026-08-09 §MP.1): một PDF nhiều trang là nguồn duy nhất
            // cho Viewer/thumbnail; bước này chỉ ghép ảnh, chưa inspect hoặc chạy AI.
            const document = await imageFilesToPdfFile(sources, getFileArrayBuffer);
            if (!requestIsCurrent(requestKey, controller, generation)) return;
            get().selectSource(tabId, document, sourceOrigin, sources.length);
        } catch (error) {
            if (!requestIsCurrent(requestKey, controller, generation)) return;
            set(state => {
                const current = state.tabs[tabId];
                if (!current) return state;
                const currentPage = current.pages[current.activeSourcePage];
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            status: previous.sourceFile
                                ? (currentPage?.status || previous.status)
                                : 'error',
                            error: error instanceof Error
                                ? error.message
                                : 'Không tạo được tài liệu từ các ảnh đã chọn.',
                        },
                    },
                };
            });
        } finally {
            if (REQUEST_CONTROLLERS.get(requestKey) === controller) {
                REQUEST_CONTROLLERS.delete(requestKey);
            }
        }
    },
    inspectSource: async (tabId, workspaceLease = null) => {
        const previous = get().tabs[tabId];
        if (!previous?.sourceFile) return false;
        if (!workspaceLeaseMatches(previous, workspaceLease)) {
            get().invalidateWorkspaceSource(tabId);
            return false;
        }
        if (previous.inspection) return true;
        if (previous.status === 'inspecting') return false;
        const file = previous.sourceFile;
        const isPdfSource = isPdfSourceFile(file);
        let keepRequestAlive = false;
        const requestKey = documentRequestKey(tabId);
        const { controller, generation } = nextRequest(requestKey);
        set(state => ({
            tabs: {
                ...state.tabs,
                [tabId]: { ...previous, status: 'inspecting', isExporting: false, error: '' },
            },
        }));
        try {
            const payload = await inspectStickerSource(file, controller.signal, { preview: 'defer' });
            const current = get().tabs[tabId];
            if (
                !requestIsCurrent(requestKey, controller, generation)
                || !current
                || current.sourceFile !== file
            ) {
                void closeStickerSheetSession(payload.inspection.session_id);
                return false;
            }
            if (!workspaceLeaseMatches(current, workspaceLease)) {
                void closeStickerSheetSession(payload.inspection.session_id);
                get().invalidateWorkspaceSource(tabId);
                return false;
            }
            let inspectionPublished = false;
            set(state => {
                const latest = state.tabs[tabId];
                if (
                    !latest
                    || latest.sourceFile !== file
                    || !workspaceLeaseMatches(latest, workspaceLease)
                ) {
                    void closeStickerSheetSession(payload.inspection.session_id);
                    return state;
                }
                inspectionPublished = true;
                const pages: Record<number, StickerSheetPageState> = {};
                for (let pageNumber = 1; pageNumber <= payload.inspection.page_count; pageNumber += 1) {
                    const page = defaultPageState('source-ready');
                    if (pageNumber === 1) {
                        page.outputDpi = payload.inspection.dpi?.[0] || latest.outputDpi;
                        page.outputDpiY = payload.inspection.dpi?.[1]
                            || payload.inspection.dpi?.[0]
                            || latest.outputDpiY;
                    }
                    pages[pageNumber] = page;
                }
                const activeSourcePage = Math.min(
                    Math.max(1, latest.activeSourcePage),
                    payload.inspection.page_count,
                );
                const updated = {
                    ...latest,
                    sourcePreviewReady: !isPdfSource,
                    inspection: payload.inspection,
                    activeSourcePage,
                    pages,
                    status: 'source-ready' as const,
                };
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: mirrorActivePage(
                            updated,
                            activeSourcePage,
                            pages[activeSourcePage],
                        ),
                    },
                };
            });
            if (!inspectionPublished) {
                const latest = get().tabs[tabId];
                if (
                    requestIsCurrent(requestKey, controller, generation)
                    && latest?.sourceOrigin === 'workspace'
                ) {
                    get().invalidateWorkspaceSource(tabId);
                }
                return false;
            }
            if (!isPdfSource) return true;
            keepRequestAlive = true;
            void (async () => {
                try {
                    const previewBlob = await loadStickerSourcePreview(
                        payload.inspection.preview_url,
                        controller.signal,
                    );
                    const sourcePreviewUrl = URL.createObjectURL(previewBlob);
                    const currentAfter = get().tabs[tabId];
                    if (
                        !requestIsCurrent(requestKey, controller, generation)
                        || !currentAfter
                        || currentAfter.sourceFile !== file
                    ) {
                        revokeUrl(sourcePreviewUrl);
                        return;
                    }
                    if (!workspaceLeaseMatches(currentAfter, workspaceLease)) {
                        revokeUrl(sourcePreviewUrl);
                        get().invalidateWorkspaceSource(tabId);
                        return;
                    }
                    revokeUrl(currentAfter.sourcePreviewUrl);
                    set(state => {
                        const latest = state.tabs[tabId];
                        if (
                            !latest
                            || latest.sourceFile !== file
                            || !workspaceLeaseMatches(latest, workspaceLease)
                        ) {
                            revokeUrl(sourcePreviewUrl);
                            return state;
                        }
                        return {
                            tabs: {
                                ...state.tabs,
                                [tabId]: {
                                    ...latest,
                                    sourcePreviewUrl,
                                    sourcePreviewReady: true,
                                },
                            },
                        };
                    });
                } catch {
                    if (!requestIsCurrent(requestKey, controller, generation) || controller.signal.aborted) {
                        return;
                    }
                    const currentAfter = get().tabs[tabId];
                    if (currentAfter && !workspaceLeaseMatches(currentAfter, workspaceLease)) {
                        get().invalidateWorkspaceSource(tabId);
                        return;
                    }
                    set(state => {
                        const latest = state.tabs[tabId];
                        if (
                            !latest
                            || latest.sourceFile !== file
                            || !workspaceLeaseMatches(latest, workspaceLease)
                        ) return state;
                        revokeUrl(latest.sourcePreviewUrl);
                        return {
                            tabs: {
                                ...state.tabs,
                                [tabId]: {
                                    ...latest,
                                    sourcePreviewUrl: '',
                                    sourcePreviewReady: true,
                                },
                            },
                        };
                    });
                } finally {
                    if (REQUEST_CONTROLLERS.get(requestKey) === controller) {
                        REQUEST_CONTROLLERS.delete(requestKey);
                    }
                    keepRequestAlive = false;
                }
            })();
            return true;
        } catch (error) {
            if (!requestIsCurrent(requestKey, controller, generation)) return false;
            const latest = get().tabs[tabId];
            if (latest && !workspaceLeaseMatches(latest, workspaceLease)) {
                get().invalidateWorkspaceSource(tabId);
                return false;
            }
            set(state => {
                const current = state.tabs[tabId];
                if (
                    !current
                    || current.sourceFile !== file
                    || !workspaceLeaseMatches(current, workspaceLease)
                ) return state;
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            status: 'source-ready',
                            inspection: null,
                            error: error instanceof Error ? error.message : 'Không chuẩn bị được file tem.',
                        },
                    },
                };
            });
            return false;
        } finally {
            if (!keepRequestAlive && REQUEST_CONTROLLERS.get(requestKey) === controller) {
                REQUEST_CONTROLLERS.delete(requestKey);
            }
        }
    },
    detectStickers: async (
        tabId,
        strategy = 'auto',
        requestedPage,
        prepareWorkspaceSource,
    ) => {
        let previous: StickerSheetTabState;
        let workspaceLease: StickerWorkspaceSourceLease | null;
        try {
            const prepared = await prepareActionSource(tabId, prepareWorkspaceSource, get);
            previous = prepared.tab;
            workspaceLease = prepared.workspaceLease;
        } catch (error) {
            const current = get().tabs[tabId];
            if (current?.sourceOrigin === 'workspace') {
                get().invalidateWorkspaceSource(
                    tabId,
                    error instanceof Error ? error.message : 'Không chuẩn bị được PDF đang hiển thị.',
                );
            }
            return;
        }
        if (!previous?.sourceFile) return;
        if (!previous.inspection) {
            const inspected = await get().inspectSource(tabId, workspaceLease);
            if (!inspected) return;
            previous = get().tabs[tabId];
        }
        if (
            !previous?.inspection
            || !previous.sourceFile
            || !workspaceLeaseMatches(previous, workspaceLease)
        ) {
            if (previous?.sourceOrigin === 'workspace') get().invalidateWorkspaceSource(tabId);
            return;
        }
        const pageNumber = Math.max(1, Math.min(
            previous.inspection.page_count,
            Math.round(requestedPage ?? previous.activeSourcePage),
        ));
        const previousPage = pageState(previous, pageNumber);
        if (previousPage.status === 'detecting') return;
        const file = previous.sourceFile;
        const sessionId = previous.inspection.session_id;
        const requestKey = pageRequestKey(tabId, pageNumber);
        const { controller, generation } = nextRequest(requestKey);
        revokeAnalysisAssets(previousPage);
        set(state => {
            const current = state.tabs[tabId];
            if (
                !current
                || current.sourceFile !== file
                || !workspaceLeaseMatches(current, workspaceLease)
            ) return state;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, page => ({
                        ...page,
                        status: 'detecting',
                        isRefining: false,
                        isCutlinePreviewing: false,
                        manifest: null,
                        cutlinePreview: null,
                        previewUrl: '',
                        labelsUrl: '',
                        uncertaintyUrl: '',
                        selectedInstanceId: null,
                        edits: [],
                        redoEdits: [],
                        error: '',
                    })),
                },
            };
        });
        try {
            const payload = await detectStickerSource(sessionId, {
                strategy,
                model: previous.model,
                alphaThreshold: previousPage.alphaThreshold,
                pageNumber,
                signal: controller.signal,
            });
            const current = get().tabs[tabId];
            if (
                !requestIsCurrent(requestKey, controller, generation)
                || !current
                || current.sourceFile !== file
                || current.inspection?.session_id !== payload.manifest.session_id
            ) {
                if (
                    !current
                    || current.sourceFile !== file
                    || current.inspection?.session_id !== payload.manifest.session_id
                ) void closeStickerSheetSession(payload.manifest.session_id);
                return;
            }
            if (!workspaceLeaseMatches(current, workspaceLease)) {
                get().invalidateWorkspaceSource(tabId);
                return;
            }
            const previewUrl = URL.createObjectURL(payload.previewBlob);
            const labelsUrl = URL.createObjectURL(payload.labelsBlob);
            const uncertaintyUrl = URL.createObjectURL(payload.uncertaintyBlob);
            // UIUX (feedback 2026-08-16): mọi nguồn chưa có CutContour thật đều
            // phải dựng preview đường bế ngay sau nhận diện. Vector chuẩn có thể
            // đi exact-geometry; nguồn còn lại dùng fitter Bézier, không để viewer
            // rơi về biên mask pixel trong lúc người dùng chờ.
            const needsGeneratedCutline = payload.manifest.boundary_source !== 'existing-cut';
            set(state => {
                const latest = state.tabs[tabId];
                if (
                    !latest
                    || latest.sourceFile !== file
                    || latest.inspection?.session_id !== payload.manifest.session_id
                    || !workspaceLeaseMatches(latest, workspaceLease)
                ) {
                    revokeUrl(previewUrl);
                    revokeUrl(labelsUrl);
                    revokeUrl(uncertaintyUrl);
                    return state;
                }
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: updatePage(latest, pageNumber, page => ({
                            ...page,
                            status: 'mask-review',
                            manifest: payload.manifest,
                            previewUrl,
                            labelsUrl,
                            uncertaintyUrl,
                            selectedInstanceId: payload.manifest.instances[0]?.id || null,
                            outputDpi: payload.manifest.dpi?.[0] || page.outputDpi,
                            outputDpiY: payload.manifest.dpi?.[1]
                                || payload.manifest.dpi?.[0]
                                || page.outputDpiY,
                            alphaThreshold: payload.manifest.alpha_threshold ?? 128,
                            shadowCleanup: payload.manifest.shadow_cleanup ?? 'auto',
                            isRefining: false,
                             isCutlinePreviewing: needsGeneratedCutline,
                            cutlinePreview: null,
                            error: '',
                        })),
                    },
                };
            });
            if (needsGeneratedCutline) {
                scheduleCurrentCutlinePreview(tabId, pageNumber, 0);
            }
        } catch (error) {
            if (!requestIsCurrent(requestKey, controller, generation)) return;
            const latest = get().tabs[tabId];
            if (latest && !workspaceLeaseMatches(latest, workspaceLease)) {
                get().invalidateWorkspaceSource(tabId);
                return;
            }
            set(state => {
                const current = state.tabs[tabId];
                if (
                    !current
                    || current.sourceFile !== file
                    || current.inspection?.session_id !== sessionId
                    || !workspaceLeaseMatches(current, workspaceLease)
                ) return state;
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: updatePage(current, pageNumber, page => ({
                            ...page,
                            status: 'error',
                            isRefining: false,
                            isCutlinePreviewing: false,
                            manifest: null,
                            cutlinePreview: null,
                            error: error instanceof Error
                                ? error.message
                                : 'Không nhận diện được vùng tem.',
                        })),
                    },
                };
            });
        } finally {
            if (REQUEST_CONTROLLERS.get(requestKey) === controller) {
                REQUEST_CONTROLLERS.delete(requestKey);
            }
        }
    },
    detectAllStickers: async (tabId, strategy = 'auto', prepareWorkspaceSource) => {
        let tab: StickerSheetTabState;
        let workspaceLease: StickerWorkspaceSourceLease | null;
        try {
            const prepared = await prepareActionSource(tabId, prepareWorkspaceSource, get);
            tab = prepared.tab;
            workspaceLease = prepared.workspaceLease;
        } catch (error) {
            const current = get().tabs[tabId];
            if (current?.sourceOrigin === 'workspace') {
                get().invalidateWorkspaceSource(
                    tabId,
                    error instanceof Error ? error.message : 'Không chuẩn bị được PDF đang hiển thị.',
                );
            }
            return;
        }
        if (!tab?.sourceFile) return;
        if (!tab.inspection) {
            const inspected = await get().inspectSource(tabId, workspaceLease);
            if (!inspected) return;
            tab = get().tabs[tabId];
        }
        if (!tab?.inspection || !workspaceLeaseMatches(tab, workspaceLease)) {
            if (tab?.sourceOrigin === 'workspace') get().invalidateWorkspaceSource(tabId);
            return;
        }
        const pendingPages = Array.from(
            { length: tab.inspection.page_count },
            (_unused, index) => index + 1,
        ).filter(pageNumber => {
            const page = pageState(tab!, pageNumber);
            return !['detecting', 'mask-review', 'confirming', 'mask-ready', 'exporting']
                .includes(page.status);
        });
        const preparedLease = workspaceLease;
        const reuseWorkspaceSource = preparedLease
            ? async () => preparedLease
            : undefined;
        await Promise.all(pendingPages.map(pageNumber => (
            get().detectStickers(tabId, strategy, pageNumber, reuseWorkspaceSource)
        )));
    },
    setMaskTuning: (tabId, tuning) => {
        const tab = get().tabs[tabId];
        const pageNumber = tab?.activeSourcePage || 1;
        const activePage = tab ? pageState(tab, pageNumber) : null;
        if (
            !tab
            || !activePage?.manifest
            || activePage.status !== 'mask-review'
            || activePage.manifest.boundary_source !== 'ai'
            || activePage.manifest.refinement_available !== true
        ) return;
        const alphaThreshold = Math.max(
            128,
            Math.min(176, Math.round(tuning.alphaThreshold ?? activePage.alphaThreshold)),
        );
        const shadowCleanup = tuning.shadowCleanup ?? activePage.shadowCleanup;
        if (
            alphaThreshold === activePage.alphaThreshold
            && shadowCleanup === activePage.shadowCleanup
            && !activePage.isRefining
        ) return;

        set(state => {
            const current = state.tabs[tabId];
            const currentPage = current ? pageState(current, pageNumber) : null;
            if (
                !current
                || currentPage?.manifest?.session_id !== activePage.manifest?.session_id
            ) {
                return state;
            }
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, page => ({
                        ...page,
                        alphaThreshold,
                        shadowCleanup,
                        isRefining: true,
                        isCutlinePreviewing: true,
                        cutlinePreview: null,
                        error: '',
                    })),
                },
            };
        });
        scheduleMaskRefinement(tabId, pageNumber, {
            sessionId: activePage.manifest.session_id,
            alphaThreshold,
            shadowCleanup,
            pageNumber,
        });
    },
    setCutlineTuning: (tabId, tuning) => {
        const tab = get().tabs[tabId];
        if (!tab) return;
        const pageNumber = tab.activeSourcePage;
        const activePage = pageState(tab, pageNumber);
        if (!activePage.manifest || !['mask-review', 'mask-ready'].includes(activePage.status)) {
            return;
        }
        const cutlineSmoothness = Math.max(
            0,
            Math.min(100, Number(tuning.smoothness ?? activePage.cutlineSmoothness)),
        );
        const cutlineFidelity = Math.max(
            0,
            Math.min(100, Number(tuning.fidelity ?? activePage.cutlineFidelity)),
        );
        const curveTension = Math.max(
            0,
            Math.min(100, Number(tuning.tension ?? activePage.curveTension)),
        );
        const minDetailAreaMm2 = Math.max(
            0,
            Math.min(25, Number(
                tuning.minDetailAreaMm2 ?? activePage.minDetailAreaMm2,
            )),
        );
        const cutlineDenoise = Math.max(
            0,
            Math.min(100, Number(tuning.cutlineDenoise ?? activePage.cutlineDenoise)),
        );
        if (
            cutlineSmoothness === activePage.cutlineSmoothness
            && cutlineFidelity === activePage.cutlineFidelity
            && curveTension === activePage.curveTension
            && minDetailAreaMm2 === activePage.minDetailAreaMm2
            && cutlineDenoise === activePage.cutlineDenoise
        ) return;
        set(state => {
            const current = state.tabs[tabId];
            if (!current) return state;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, page => ({
                        ...page,
                        cutlineSmoothness,
                        cutlineFidelity,
                        curveTension,
                        minDetailAreaMm2,
                        cutlineDenoise,
                        isCutlinePreviewing: true,
                        error: '',
                    })),
                },
            };
        });
        // UIUX/PERF (audit 2026-08-10 §CUTLINE.LIVE4): tuning đã có hàng đợi
        // coalesce một request đang chạy. Gửi nhịp đầu ngay để đường bế chuyển động
        // trong lúc kéo, thay vì debounce mãi tới sau khi người dùng thả chuột.
        scheduleCurrentCutlinePreview(tabId, pageNumber, 0);
    },
    confirmMask: async (tabId, requestedPage) => {
        const previous = get().tabs[tabId];
        if (!previous) return;
        const pageNumber = requestedPage ?? previous.activeSourcePage;
        const previousPage = pageState(previous, pageNumber);
        if (
            !previousPage.manifest
            || previousPage.status !== 'mask-review'
            || previousPage.isRefining
        ) return;
        const sessionId = previousPage.manifest.session_id;
        const requestKey = pageRequestKey(tabId, pageNumber);
        const { controller, generation } = nextRequest(requestKey);
        set(state => {
            const current = state.tabs[tabId];
            if (!current) return state;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, page => ({
                        ...page, status: 'confirming', error: '',
                    })),
                },
            };
        });
        try {
            const confirmed = await confirmStickerSource(sessionId, {
                signal: controller.signal,
                pageNumber,
            });
            if (!confirmed) throw new Error('Backend chưa xác nhận vùng tem.');
            if (!requestIsCurrent(requestKey, controller, generation)) return;
            set(state => {
                const current = state.tabs[tabId];
                const currentPage = current ? pageState(current, pageNumber) : null;
                if (!current || currentPage?.manifest?.session_id !== sessionId) return state;
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: updatePage(current, pageNumber, page => ({
                            ...page, status: 'mask-ready', error: '',
                        })),
                    },
                };
            });
        } catch (error) {
            if (!requestIsCurrent(requestKey, controller, generation)) return;
            set(state => {
                const current = state.tabs[tabId];
                const currentPage = current ? pageState(current, pageNumber) : null;
                if (!current || currentPage?.manifest?.session_id !== sessionId) return state;
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: updatePage(current, pageNumber, page => ({
                            ...page,
                            status: 'mask-review',
                            error: error instanceof Error ? error.message : 'Không xác nhận được vùng tem.',
                        })),
                    },
                };
            });
        } finally {
            if (REQUEST_CONTROLLERS.get(requestKey) === controller) {
                REQUEST_CONTROLLERS.delete(requestKey);
            }
        }
    },
    exportFile: async (
        tabId,
        outputFormat = 'pdf',
        requestedOrder,
        prepareWorkspaceSource,
    ) => {
        const initial = get().tabs[tabId];
        if (!initial || initial.isExporting) return null;
        let tab: StickerSheetTabState;
        let workspaceLease: StickerWorkspaceSourceLease | null;
        if (initial.sourceOrigin === 'workspace') {
            try {
                const prepared = await prepareActionSource(tabId, prepareWorkspaceSource, get);
                tab = prepared.tab;
                workspaceLease = prepared.workspaceLease;
            } catch (error) {
                const current = get().tabs[tabId];
                if (current?.sourceOrigin === 'workspace') {
                    get().invalidateWorkspaceSource(
                        tabId,
                        error instanceof Error ? error.message : 'Không chuẩn bị được PDF đang hiển thị.',
                    );
                }
                return null;
            }
        } else {
            // Nguồn explicit không có bước materialize; giữ khóa export đồng bộ
            // trước await đầu tiên để click kế tiếp không chen sửa mask/reset nguồn.
            tab = initial;
            workspaceLease = null;
        }
        if (!tab || tab.isExporting) return null;
        if (!workspaceLeaseMatches(tab, workspaceLease)) {
            if (tab.sourceOrigin === 'workspace') get().invalidateWorkspaceSource(tabId);
            return null;
        }
        const defaultOrder = tab.inspection
            ? Array.from({ length: tab.inspection.page_count }, (_unused, index) => index + 1)
            : [tab.activeSourcePage];
        const pageOrder = (requestedOrder?.length ? requestedOrder : defaultOrder)
            .map(page => Math.round(page))
            .filter(page => page >= 1);
        const uniquePageNumbers = [...new Set(pageOrder)];
        const exportPages = uniquePageNumbers.map(pageNumber => ({
            pageNumber,
            state: pageState(tab, pageNumber),
        }));
        if (
            exportPages.length === 0
            || exportPages.some(item => (
                !item.state.manifest || item.state.status !== 'mask-ready'
            ))
        ) return null;
        const sessionId = tab.inspection?.session_id
            || exportPages[0].state.manifest?.session_id;
        if (!sessionId) return null;
        const file = tab.sourceFile;
        const requestKey = documentRequestKey(tabId);
        const { controller, generation } = nextRequest(requestKey);
        let exportStarted = false;
        set(state => {
            const current = state.tabs[tabId];
            if (
                !current
                || current.sourceFile !== file
                || current.inspection?.session_id !== sessionId
                || !workspaceLeaseMatches(current, workspaceLease)
            ) return state;
            exportStarted = true;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: { ...current, status: 'exporting', isExporting: true, error: '' },
                },
            };
        });
        if (!exportStarted) return null;
        let exportSucceeded = false;
        try {
            const canPreserveOriginal = exportPages.every(item => Boolean(
                item.state.preserveExistingCut
                && item.state.edits.length === 0
                && item.state.manifest?.boundary_source === 'existing-cut'
                && item.state.manifest.vector_geometry_ref?.preserve_original === true
            ));
            const settings = tab.outputSettings;
            const result = await exportStickerSheet(sessionId, {
                edits: tab.edits,
                pages: exportPages.map(item => ({
                    sourcePage: item.pageNumber,
                    expectedRevision: item.state.manifest?.mask_revision ?? 1,
                    edits: item.state.edits,
                    dpi: item.state.outputDpi,
                    dpiY: item.state.outputDpiY,
                    cutlineSmoothness: item.state.cutlineSmoothness,
                    cutlineFidelity: item.state.cutlineFidelity,
                    curveTension: item.state.curveTension,
                    minDetailAreaMm2: item.state.minDetailAreaMm2,
                })),
                pageOrder,
                dpi: exportPages[0].state.outputDpi,
                dpiY: exportPages[0].state.outputDpiY,
                offsetMm: canPreserveOriginal ? 0 : settings.offsetMm,
                bleedMm: canPreserveOriginal ? 0 : settings.bleedMm,
                cutMode: canPreserveOriginal ? 'original' : settings.cutMode,
                cornerStyle: canPreserveOriginal ? 'preserve' : settings.cornerStyle,
                fillHoles: settings.fillHoles,
                cropToSticker: canPreserveOriginal ? false : settings.cropToSticker,
                bleedColorType: settings.bleedColorType,
                solidBleedCmyk: settings.solidBleedCmyk,
                shapeMode: 'contour',
                drawCutContour: canPreserveOriginal || settings.cutMode !== 'none',
                preserveExistingCut: canPreserveOriginal,
                outputFormat,
                cutlineSmoothness: exportPages[0].state.cutlineSmoothness,
                cutlineFidelity: exportPages[0].state.cutlineFidelity,
                curveTension: exportPages[0].state.curveTension,
                minDetailAreaMm2: exportPages[0].state.minDetailAreaMm2,
                signal: controller.signal,
            });
            const current = get().tabs[tabId];
            if (
                !requestIsCurrent(requestKey, controller, generation)
                || !current
                || current.sourceFile !== file
                || current?.inspection?.session_id !== sessionId
            ) return null;
            if (!workspaceLeaseMatches(current, workspaceLease)) {
                get().invalidateWorkspaceSource(tabId);
                return null;
            }
            // UIUX (audit 2026-08-08 §UNIFIED.RACE2): giữ khóa `exporting` cho tới
            // khi caller commit/lưu xong artifact. HTTP 200 chưa có nghĩa workspace
            // đã nhận file; mở khóa sớm cho phép export/source mới vượt lên trước.
            exportSucceeded = true;
            return result;
        } catch (error) {
            if (!requestIsCurrent(requestKey, controller, generation)) return null;
            const latest = get().tabs[tabId];
            if (latest && !workspaceLeaseMatches(latest, workspaceLease)) {
                get().invalidateWorkspaceSource(tabId);
                return null;
            }
            set(state => {
                const current = state.tabs[tabId];
                if (
                    !current
                    || current.sourceFile !== file
                    || current.inspection?.session_id !== sessionId
                    || !workspaceLeaseMatches(current, workspaceLease)
                ) return state;
                const message = error instanceof Error ? error.message : 'Không tạo được file tem.';
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: updatePage(
                            { ...current, isExporting: false },
                            current.activeSourcePage,
                            page => ({ ...page, error: message }),
                        ),
                    },
                };
            });
            return null;
        } finally {
            if (!exportSucceeded && requestIsCurrent(requestKey, controller, generation)) {
                set(state => {
                    const current = state.tabs[tabId];
                    if (
                        !current
                        || current.sourceFile !== file
                        || current.inspection?.session_id !== sessionId
                        || !workspaceLeaseMatches(current, workspaceLease)
                    ) return state;
                    const activePage = pageState(current, current.activeSourcePage);
                    return {
                        tabs: {
                            ...state.tabs,
                            [tabId]: mirrorActivePage(
                                { ...current, isExporting: false },
                                current.activeSourcePage,
                                activePage,
                            ),
                        },
                    };
                });
            }
            if (REQUEST_CONTROLLERS.get(requestKey) === controller) {
                REQUEST_CONTROLLERS.delete(requestKey);
            }
        }
    },
    finishExport: (tabId) => set(state => {
        const current = state.tabs[tabId];
        if (!current || !current.isExporting) return state;
        const activePage = pageState(current, current.activeSourcePage);
        return {
            tabs: {
                ...state.tabs,
                [tabId]: mirrorActivePage(
                    { ...current, isExporting: false },
                    current.activeSourcePage,
                    activePage,
                ),
            },
        };
    }),
    addStroke: (tabId, stroke) => {
        let pageNumber = 1;
        let changed = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            // UIUX (audit 2026-08-08 §UNIFIED.RACE1): response xác nhận/xuất chỉ
            // hợp lệ với đúng snapshot mask đã gửi. Không cho edit chen giữa request.
            if (workflowMutationLocked(tab)) return state;
            pageNumber = tab.activeSourcePage;
            changed = true;
            const edit: StickerMaskStroke = { ...stroke, kind: 'stroke', id: makeEditId() };
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(tab, pageNumber, page => ({
                        ...page,
                        status: page.status === 'mask-ready' ? 'mask-review' : page.status,
                        edits: [...page.edits, edit],
                        redoEdits: [],
                        cutlinePreview: null,
                    })),
                },
            };
        });
        if (changed) scheduleCurrentCutlinePreview(tabId, pageNumber);
    },
    mergeInstance: (tabId, sourceId, targetId) => {
        if (sourceId === targetId) return;
        let changed = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            if (workflowMutationLocked(tab)) return state;
            const edit: StickerMergeEdit = {
                kind: 'merge', id: makeEditId(), sourceId, targetId,
            };
            changed = true;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(tab, tab.activeSourcePage, page => ({
                        ...page,
                        status: page.status === 'mask-ready' ? 'mask-review' : page.status,
                        edits: [...page.edits, edit],
                        redoEdits: [],
                        cutlinePreview: null,
                    })),
                },
            };
        });
        if (changed) {
            scheduleCurrentCutlinePreview(tabId, get().tabs[tabId]?.activeSourcePage || 1);
        }
    },
    undo: (tabId) => {
        let pageNumber = 1;
        let changed = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            if (workflowMutationLocked(tab)) return state;
            pageNumber = tab.activeSourcePage;
            const activePage = pageState(tab, pageNumber);
            const edit = activePage.edits[activePage.edits.length - 1];
            if (!edit) return state;
            changed = true;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(tab, pageNumber, page => ({
                        ...page,
                        status: page.status === 'mask-ready' ? 'mask-review' : page.status,
                        edits: page.edits.slice(0, -1),
                        redoEdits: [...page.redoEdits, edit],
                        cutlinePreview: null,
                    })),
                },
            };
        });
        if (changed) scheduleCurrentCutlinePreview(tabId, pageNumber);
    },
    redo: (tabId) => {
        let pageNumber = 1;
        let changed = false;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            if (workflowMutationLocked(tab)) return state;
            pageNumber = tab.activeSourcePage;
            const activePage = pageState(tab, pageNumber);
            const edit = activePage.redoEdits[activePage.redoEdits.length - 1];
            if (!edit) return state;
            changed = true;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(tab, pageNumber, page => ({
                        ...page,
                        status: page.status === 'mask-ready' ? 'mask-review' : page.status,
                        edits: [...page.edits, edit],
                        redoEdits: page.redoEdits.slice(0, -1),
                        cutlinePreview: null,
                    })),
                },
            };
        });
        if (changed) scheduleCurrentCutlinePreview(tabId, pageNumber);
    },
    resetAnalysis: (tabId) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        if (workflowMutationLocked(tab)) return state;
        cancelRequests(tabId);
        releaseAssets(tab);
        return {
            tabs: {
                ...state.tabs,
                [tabId]: {
                    ...defaultTabState(),
                    mode: tab.mode,
                    productType: tab.productType,
                },
            },
        };
    }),
    disposeTab: (tabId) => set(state => {
        const tab = state.tabs[tabId];
        cancelRequests(tabId);
        if (tab) releaseAssets(tab);
        const tabs = { ...state.tabs };
        delete tabs[tabId];
        return { tabs };
    }),
}));

type StickerMaskTuningRequest = {
    sessionId: string;
    alphaThreshold: number;
    shadowCleanup: StickerShadowCleanup;
    pageNumber: number;
};

function armMaskRefinement(tabId: string, pageNumber: number, delayMs: number): void {
    const requestKey = pageRequestKey(tabId, pageNumber);
    if (REFINE_RUNNING.has(requestKey) || !REFINE_DESIRED.has(requestKey)) return;
    const previousTimer = REFINE_TIMERS.get(requestKey);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
        REFINE_TIMERS.delete(requestKey);
        void runMaskRefinement(tabId, pageNumber);
    }, delayMs);
    REFINE_TIMERS.set(requestKey, timer);
}

function scheduleMaskRefinement(
    tabId: string,
    pageNumber: number,
    request: StickerMaskTuningRequest,
): void {
    const requestKey = pageRequestKey(tabId, pageNumber);
    REFINE_DESIRED.set(requestKey, request);
    // UIUX (audit 2026-08-09 §AI-PREVIEW.1): debounce thao tác kéo, nhưng không
    // abort request đã vào backend vì thread hậu xử lý vẫn tiếp tục chạy.
    armMaskRefinement(tabId, pageNumber, 180);
}

async function runMaskRefinement(tabId: string, pageNumber: number): Promise<void> {
    const requestKey = pageRequestKey(tabId, pageNumber);
    if (REFINE_RUNNING.has(requestKey)) return;
    const requested = REFINE_DESIRED.get(requestKey);
    if (!requested) return;
    REFINE_DESIRED.delete(requestKey);

    const before = useStickerSheetStore.getState().tabs[tabId];
    const beforePage = before ? pageState(before, pageNumber) : null;
    if (
        !beforePage?.manifest
        || beforePage.status !== 'mask-review'
        || beforePage.manifest.session_id !== requested.sessionId
    ) return;
    const lifecycleGeneration = REQUEST_GENERATIONS.get(requestKey) || 0;
    REFINE_RUNNING.add(requestKey);
    try {
        const payload = await refineStickerSource(requested.sessionId, {
            alphaThreshold: requested.alphaThreshold,
            shadowCleanup: requested.shadowCleanup,
            baseRevision: beforePage.manifest.mask_revision ?? 1,
            pageNumber,
        });
        const current = useStickerSheetStore.getState().tabs[tabId];
        const currentPage = current ? pageState(current, pageNumber) : null;
        if (
            !current
            || currentPage?.status !== 'mask-review'
            || currentPage.manifest?.session_id !== requested.sessionId
            || (REQUEST_GENERATIONS.get(requestKey) || 0) !== lifecycleGeneration
        ) return;

        const queued = REFINE_DESIRED.get(requestKey);
        if (
            queued
            && queued.sessionId === requested.sessionId
            && queued.alphaThreshold === (payload.manifest.alpha_threshold ?? requested.alphaThreshold)
            && queued.shadowCleanup === (payload.manifest.shadow_cleanup ?? requested.shadowCleanup)
        ) {
            REFINE_DESIRED.delete(requestKey);
        }
        const previewUrl = URL.createObjectURL(payload.previewBlob);
        const labelsUrl = URL.createObjectURL(payload.labelsBlob);
        const uncertaintyUrl = URL.createObjectURL(payload.uncertaintyBlob);
        let assetsPublished = false;
        useStickerSheetStore.setState(state => {
            const latest = state.tabs[tabId];
            const latestPage = latest ? pageState(latest, pageNumber) : null;
            if (
                !latest
                || latestPage?.status !== 'mask-review'
                || latestPage.manifest?.session_id !== requested.sessionId
            ) {
                revokeUrl(previewUrl);
                revokeUrl(labelsUrl);
                revokeUrl(uncertaintyUrl);
                return state;
            }
            const stillQueued = REFINE_DESIRED.has(requestKey);
            const selectedInstanceId = payload.manifest.instances.some(
                instance => instance.id === latestPage.selectedInstanceId,
            )
                ? latestPage.selectedInstanceId
                : (payload.manifest.instances[0]?.id || null);
            assetsPublished = true;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(latest, pageNumber, page => ({
                        ...page,
                        manifest: payload.manifest,
                        previewUrl,
                        labelsUrl,
                        uncertaintyUrl,
                        selectedInstanceId,
                        alphaThreshold: stillQueued
                            ? page.alphaThreshold
                            : (payload.manifest.alpha_threshold ?? requested.alphaThreshold),
                        shadowCleanup: stillQueued
                            ? page.shadowCleanup
                            : (payload.manifest.shadow_cleanup ?? requested.shadowCleanup),
                        isRefining: stillQueued,
                        isCutlinePreviewing: true,
                        cutlinePreview: null,
                        edits: [],
                        redoEdits: [],
                        error: '',
                    })),
                },
            };
        });
        if (assetsPublished && currentPage) revokeAnalysisAssets(currentPage);
        if (assetsPublished && !REFINE_DESIRED.has(requestKey)) {
            scheduleCurrentCutlinePreview(tabId, pageNumber, 0);
        }
    } catch (error) {
        if (isRefineAssetSyncError(error)) {
            const current = useStickerSheetStore.getState().tabs[tabId];
            const currentPage = current ? pageState(current, pageNumber) : null;
            if (
                currentPage?.manifest?.session_id === requested.sessionId
                && (REQUEST_GENERATIONS.get(requestKey) || 0) === lifecycleGeneration
            ) {
                revokeAnalysisAssets(currentPage);
                useStickerSheetStore.setState(state => {
                    const latest = state.tabs[tabId];
                    const latestPage = latest ? pageState(latest, pageNumber) : null;
                    if (!latest || latestPage?.manifest?.session_id !== requested.sessionId) return state;
                    return {
                        tabs: {
                            ...state.tabs,
                            [tabId]: updatePage(latest, pageNumber, page => ({
                                ...page,
                                status: 'error',
                                isRefining: false,
                                isCutlinePreviewing: false,
                                manifest: null,
                                cutlinePreview: null,
                                previewUrl: '',
                                labelsUrl: '',
                                uncertaintyUrl: '',
                                selectedInstanceId: null,
                                edits: [],
                                redoEdits: [],
                                alphaThreshold: 128,
                                shadowCleanup: 'auto',
                                error: error.message,
                            })),
                        },
                    };
                });
            }
            return;
        }
        const queued = REFINE_DESIRED.has(requestKey);
        useStickerSheetStore.setState(state => {
            const current = state.tabs[tabId];
            const currentPage = current ? pageState(current, pageNumber) : null;
            if (
                !current
                || currentPage?.status !== 'mask-review'
                || currentPage.manifest?.session_id !== requested.sessionId
                || (REQUEST_GENERATIONS.get(requestKey) || 0) !== lifecycleGeneration
            ) return state;
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, page => ({
                        ...page,
                        alphaThreshold: queued
                            ? page.alphaThreshold
                            : (page.manifest?.alpha_threshold ?? 128),
                        shadowCleanup: queued
                            ? page.shadowCleanup
                            : (page.manifest?.shadow_cleanup ?? 'auto'),
                        isRefining: queued,
                        isCutlinePreviewing: queued,
                        error: queued
                            ? ''
                            : (error instanceof Error
                                ? error.message
                                : 'Không cập nhật được bản xem trước.'),
                    })),
                },
            };
        });
    } finally {
        REFINE_RUNNING.delete(requestKey);
        if (REFINE_DESIRED.has(requestKey)) armMaskRefinement(tabId, pageNumber, 0);
    }
}

type StickerCutlinePreviewRequest = {
    sessionId: string;
    pageNumber: number;
    maskRevision: number;
    edits: StickerSheetEdit[];
    dpi: number;
    dpiY: number;
    offsetMm: number;
    bleedMm: number;
    cutMode: StickerOutputSettings['cutMode'];
    cornerStyle: StickerOutputSettings['cornerStyle'];
    fillHoles: boolean;
    cutlineSmoothness: number;
    cutlineFidelity: number;
    curveTension: number;
    minDetailAreaMm2: number;
    cutlineDenoise: number;
};

function cutlineRequestKey(tabId: string, pageNumber: number): string {
    return `${tabId}:cutline:${pageNumber}`;
}

function armCutlinePreview(tabId: string, pageNumber: number, delayMs: number): void {
    const key = cutlineRequestKey(tabId, pageNumber);
    if (CUTLINE_RUNNING.has(key) || !CUTLINE_DESIRED.has(key)) return;
    const previousTimer = CUTLINE_TIMERS.get(key);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
        CUTLINE_TIMERS.delete(key);
        void runCutlinePreview(tabId, pageNumber);
    }, delayMs);
    CUTLINE_TIMERS.set(key, timer);
}

function scheduleCurrentCutlinePreview(
    tabId: string,
    pageNumber: number,
    delayMs = 160,
): void {
    const tab = useStickerSheetStore.getState().tabs[tabId];
    const page = tab ? pageState(tab, pageNumber) : null;
    if (
        !tab
        || !page?.manifest
        || page.isRefining
        || !['mask-review', 'mask-ready'].includes(page.status)
    ) return;
    const request: StickerCutlinePreviewRequest = {
        sessionId: page.manifest.session_id,
        pageNumber,
        maskRevision: page.manifest.mask_revision ?? 1,
        edits: page.edits.map(edit => ({ ...edit })),
        dpi: page.outputDpi,
        dpiY: page.outputDpiY,
        offsetMm: tab.outputSettings.offsetMm,
        bleedMm: tab.outputSettings.bleedMm,
        cutMode: tab.outputSettings.cutMode,
        cornerStyle: tab.outputSettings.cornerStyle,
        fillHoles: tab.outputSettings.fillHoles,
        cutlineSmoothness: page.cutlineSmoothness,
        cutlineFidelity: page.cutlineFidelity,
        curveTension: page.curveTension,
        minDetailAreaMm2: page.minDetailAreaMm2,
        cutlineDenoise: page.cutlineDenoise,
    };
    const key = cutlineRequestKey(tabId, pageNumber);
    CUTLINE_DESIRED.set(key, request);
    useStickerSheetStore.setState(state => {
        const current = state.tabs[tabId];
        const currentPage = current ? pageState(current, pageNumber) : null;
        if (
            !current
            || currentPage?.manifest?.session_id !== request.sessionId
        ) return state;
        return {
            tabs: {
                ...state.tabs,
                [tabId]: updatePage(current, pageNumber, pageStateValue => ({
                    ...pageStateValue,
                    isCutlinePreviewing: true,
                })),
            },
        };
    });
    armCutlinePreview(tabId, pageNumber, delayMs);
}

async function runCutlinePreview(tabId: string, pageNumber: number): Promise<void> {
    const key = cutlineRequestKey(tabId, pageNumber);
    if (CUTLINE_RUNNING.has(key)) return;
    const requested = CUTLINE_DESIRED.get(key);
    if (!requested) return;
    CUTLINE_DESIRED.delete(key);
    const before = useStickerSheetStore.getState().tabs[tabId];
    const beforePage = before ? pageState(before, pageNumber) : null;
    if (
        !beforePage?.manifest
        || beforePage.manifest.session_id !== requested.sessionId
        || (beforePage.manifest.mask_revision ?? 1) !== requested.maskRevision
    ) return;
    CUTLINE_RUNNING.add(key);
    try {
        const payload = await previewStickerCutline(requested.sessionId, {
            baseRevision: requested.maskRevision,
            pageNumber,
            edits: requested.edits,
            dpi: requested.dpi,
            dpiY: requested.dpiY,
            offsetMm: requested.offsetMm,
            bleedMm: requested.bleedMm,
            cutMode: requested.cutMode,
            cornerStyle: requested.cornerStyle,
            fillHoles: requested.fillHoles,
            cutlineSmoothness: requested.cutlineSmoothness,
            cutlineFidelity: requested.cutlineFidelity,
            curveTension: requested.curveTension,
            minDetailAreaMm2: requested.minDetailAreaMm2,
            cutlineDenoise: requested.cutlineDenoise,
        });
        const queued = CUTLINE_DESIRED.has(key);
        useStickerSheetStore.setState(state => {
            const current = state.tabs[tabId];
            const currentPage = current ? pageState(current, pageNumber) : null;
            if (
                !current
                || currentPage?.manifest?.session_id !== requested.sessionId
                || (currentPage.manifest.mask_revision ?? 1) !== payload.mask_revision
                || currentPage.isRefining
            ) return state;
            if (
                current.isExporting
                || ['confirming', 'exporting'].includes(current.status)
            ) {
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            pages: {
                                ...current.pages,
                                [pageNumber]: {
                                    ...currentPage,
                                    cutlinePreview: payload,
                                    isCutlinePreviewing: queued,
                                },
                            },
                        },
                    },
                };
            }
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, pageStateValue => ({
                        ...pageStateValue,
                        // UIUX/PERF (audit 2026-08-10 §CUTLINE.LIVE5): request của
                        // mỗi trang chạy nối tiếp nên payload này không thể vượt
                        // mặt kết quả mới hơn. Công bố nó như một frame trung gian,
                        // rồi hàng đợi tiếp tục tới đúng giá trị slider mới nhất.
                        cutlinePreview: payload,
                        isCutlinePreviewing: queued,
                        error: queued ? pageStateValue.error : '',
                    })),
                },
            };
        });
    } catch (error) {
        const queued = CUTLINE_DESIRED.has(key);
        useStickerSheetStore.setState(state => {
            const current = state.tabs[tabId];
            const currentPage = current ? pageState(current, pageNumber) : null;
            if (
                !current
                || currentPage?.manifest?.session_id !== requested.sessionId
            ) return state;
            if (
                current.isExporting
                || ['confirming', 'exporting'].includes(current.status)
            ) {
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            pages: {
                                ...current.pages,
                                [pageNumber]: {
                                    ...currentPage,
                                    isCutlinePreviewing: queued,
                                },
                            },
                        },
                    },
                };
            }
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: updatePage(current, pageNumber, pageStateValue => ({
                        ...pageStateValue,
                        isCutlinePreviewing: queued,
                        error: queued
                            ? pageStateValue.error
                            : (error instanceof Error
                                ? error.message
                                : 'Không cập nhật được đường bế xem trước.'),
                    })),
                },
            };
        });
    } finally {
        CUTLINE_RUNNING.delete(key);
        if (CUTLINE_DESIRED.has(key)) armCutlinePreview(tabId, pageNumber, 0);
    }
}
