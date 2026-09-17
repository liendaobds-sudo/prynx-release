import { useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState, useContext } from 'react';
import { createPortal } from 'react-dom';
import { localFileUrl } from '../lib/localFileTransport';
import { TOOL_REGISTRY, TOOL_CATEGORIES, findToolByUniqueKey, getToolsByCategory, getToolUniqueKey } from '../lib/toolRegistry';

import PDFUploader from './PDFUploader';
import AcrobatViewer, { type PageOverlayRenderContext } from './AcrobatViewer';
import type { ThumbnailCutlinePreviewItem } from './acrobat/thumbnailCutlinePreview';
import { useObjectEditHistory } from '../hooks/useObjectEditHistory';
import { useEditSession, type UseEditSession } from '../hooks/useEditSession';
import { useWorkingPdf } from '../hooks/useWorkingPdf';
import { ImpositionMode, type ProcessingSettings } from '../lib/pdfImposer';
import { Button } from './Button';
import { Printer, Scissors } from 'lucide-react';
import { PDFDocument, degrees } from 'pdf-lib';
import { imageFileToPdfIfNeeded, isSupportedImageFileName } from '../lib/imageNormalizer';
import {
    formatFileOpeningError,
    initialFileOpeningPhase,
    type FileOpeningPhase,
} from '../lib/impositionOpeningState';
import ImposerDashboard from './imposition-tools/ImposerDashboard';
import ToolMenuList from './imposition-tools/ToolMenuList';
import CutExportModal from './imposition-tools/cut-export/CutExportModal';
import OpenInDesignModal from './imposition-tools/OpenInDesignModal';
import { DEFAULT_CUT_BORDER_CONFIG, PREDEFINED_SIZES, isWorkspaceTool, resolveRightPanel, type BookletSettings, type NupSettings, type TaskMode } from './imposition-tools/types';
import { ImposerSettingsContext, createImposerSettingsStore, useImposerSettingsStore } from './imposition-tools/useImposerSettingsStore';
import { resolveEffectiveSeparateCut } from './imposition-tools/pageSheetPolicy';
import { canUseRectangleStickerInking } from './imposition-tools/shapeDetectionPolicy';
import { disposeImposerPersistScope } from './imposition-tools/store/persist';
import { generateBindingMap } from '../lib/imposerEngine/VirtualMap';
import { getApiUrl, uploadPDF, authenticatedFetch } from '../lib/api';
import { createRevisionScopedPdfUploadCache } from '../lib/revisionScopedPdfUpload';
import { recipeRecorder, type RecipeOperationTicket } from '../lib/recipe/RecipeRecorder';
import { shouldBlockUnrecordedCommit } from '../lib/recipe/unrecordedCommit';
import { isRestoredDocumentDirty } from '../lib/dirtySession';
import {
    createRecoveryHistoryEntry,
    deleteSnapshot,
    isRecoverySourceCurrent,
    readRecoverySourceFingerprint,
    writeSnapshot,
} from '../lib/recovery';
import { getFileArrayBuffer, detectColorSpace } from '../lib/utils';
import {
    ArtifactLeaseOwner,
    collectArtifactLeaseTokens,
    copyArtifactLeaseToken,
    tagArtifactLeaseToken,
} from '../lib/artifactLease';
import {
    createWorkspaceHistoryEntry,
    type WorkspaceHistoryEntry,
} from '../lib/workspaceHistory';
import {
    prepareDocumentWindowSource,
    type DocumentWindowTabApi,
    type DocumentWindowViewState,
} from '../lib/documentWindow';
import { pageIndicesToPageNumbers } from '../lib/printPageSelection';
import { beginOptionalContentTransfer, finishOptionalContentTransfer } from '../lib/pdfOptionalContent';
import {
    extractWorkingPagePositions,
    isWorkingPageSelectionCurrent,
} from '../lib/extractWorkingPages';
import { saveVdpTemplate, loadVdpTemplate } from '../lib/vdpTemplate';
import OutputPreviewHost from './OutputPreviewHost';
import RecipeRecordControl from './recipe/RecipeRecordControl';
import RecipePanel from './recipe/RecipePanel';
import { toast } from './ui/Toast';
// UIUX (audit 2026-07-27 §B-20 + §B-23): phím tắt dialog + dịch lỗi kỹ thuật
import DialogKeys from './ui/DialogKeys';
import {
    hasDocumentBoundPageState,
    isLinearRecipeMergeMode,
    isLinearRecipeSplitMode,
    type Recipe,
} from '../lib/recipe/recipeTypes';
import { sanitizeRecipeImpositionParams } from '../lib/recipe/recipeImpositionParams';
import { createPlaybackPublisher } from '../lib/recipe/playbackPublisher';
import { firstDeniedRecipeStep, recipeStepAccessError } from '../lib/recipe/recipeEntitlements';
import {
    createWorkingArtifactController,
    createWorkingArtifactProcessContext,
    resolveInitialWorkingArtifact,
} from '../lib/recipe/workingArtifact';
import type { ProcessOutcome } from '../lib/processHandlers';
import DataMergeTool from './preprocess-tools/DataMergeTool';
import NumberingTool from './preprocess-tools/NumberingTool';
import CoverNumberingTool from './preprocess-tools/CoverNumberingTool';
import StickTextNumberTool from './preprocess-tools/StickTextNumberTool';
import SaveModal from './workspace/SaveModal';
import SavePrintFilesModal from './workspace/SavePrintFilesModal';
import { usePrintDialog } from './shared/usePrintDialog';
import EditLayersPanel from './workspace/SelectionLayersPanel';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import {
    TOOL_MENU_ICON_WIDTH,
    TOOL_MENU_VIEWER_MIN_WIDTH,
    clampToolMenuDraftTotalWidth,
    maxFullToolMenuWidth,
   resolveToolMenuDrag,
    resolveEffectiveToolMenuLayout,
    resizeToolMenuPanel,
    resolveToolMenuDraftLayout,
   resolveWorkspaceToolMenuToggle,
    resolveWorkspaceToolPanelClose,
    type ToolMenuMode,
    type EffectiveToolMenuLayout,
} from '../lib/rightToolMenuLayout';
import {
    primeViewerFirstFrame,
    waitForViewerFirstFrameGrace,
} from '../lib/viewerFirstFrame';
import {
    isGeneratedWorkspaceFile,
    markGeneratedWorkspaceFile,
    statNativeSystemFile,
} from '../lib/nativeFileAccess';
import {
    createSavedWorkspaceRevision,
    executeWorkspaceSaveWrite,
    planWorkspacePdfSave,
    planWorkspaceSaveWrite,
    type WorkspaceSaveWriteOutcome,
} from '../lib/workspaceFileSave';
import type { VdpToolField } from '../hooks/useVdpTool';
import type { PlanConfig } from '../lib/imposerEngine/CatalogPlanner';
import type { ShuffleSettings } from './preprocess-tools/ShuffleTool';
import type { PageResizerSettings } from './preprocess-tools/pageResizerViewLogic';
import type { TrimShiftSettings } from './preprocess-tools/TrimShiftTool';
import type { SplitSettings } from './preprocess-tools/SplitTool';
import type { MergeSettings } from './preprocess-tools/MergeTool';

import {
    WorkspaceContext,
    captureWorkspaceDocumentRevision,
    createWorkspaceStore,
    isWorkspaceDocumentRevisionCurrent,
    useWorkspaceStore,
    workspaceDocumentIdentity,
    type WorkspaceDocumentRevisionToken,
} from '../stores/useWorkspaceStore';
import { clearTileUrlCacheForFile } from '../lib/tileUrlCache';
import { useShallow } from 'zustand/react/shallow';
import { globalPdfObjectCache } from '../stores/pdfObjectCache';
import { BgRemoverPreview } from './preprocess-tools/BgRemoverTool';
import {
    copyDocumentCleanupResultIdentity,
    DocumentCleanupDropReceiver,
    DocumentCleanupPreview,
    shouldShowDocumentCleanupOverlay,
} from './preprocess-tools/DocumentCleanupTool';
import { copyUpscaleResultIdentity, UpscalePreview } from './preprocess-tools/UpscaleTool';
import {
    createSourceImageRevisionOwner,
    isSourceImageRevisionCurrent,
    type SourceImageRevisionOwner,
} from '../lib/sourceImageRevision';
import StickerSheetWorkspace, {
    StickerCutlineOverlay,
} from './preprocess-tools/StickerSheetWorkspace';
import { useStickerSheetStore, type StickerSheetPageState } from './preprocess-tools/stickerSheetStore';
import type { StickerCutlinePreview } from '../lib/stickerSheetApi';
import {
    resolveStickerSourceSyncMarker,
    selectStickerSheetPageWorkflowStatuses,
    selectStickerSheetTabSummary,
    viewerShowsStickerSource,
} from './stickerSheetTabSelector';
import LogoRebuildWorkspace from './preprocess-tools/LogoRebuildWorkspace';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';
import { canToolRunWithoutPdf, LOGO_REBUILD_ENABLED, resolveDedicatedInitialTool } from './imposition-tools/sections/preprocessRouterTools';
import { buildSourceTabOptions, registerActiveTabFeature } from '../lib/tabNavigation';
import { useToolActivationGuard } from '../hooks/useToolActivationGuard';
import { canUse } from '../lib/license/features';
import { isEphemeralBackendPath } from '../lib/impositionPathPolicy';
import { useAuthStore } from '../stores/useAuthStore';
import FeatureAccessOverlay from './license/FeatureAccessOverlay';

// Phase type is now defined in useWorkspaceStore

// Giới hạn số bản Undo cho luồng commit chính (mỗi entry là 1 File PDF ĐẦY ĐỦ bytes
// trong RAM). Không cap → file 50MB × N commit = leak vài GB/tab (audit RAM 2026-07-06).
// Cắt entry CŨ NHẤT (đầu mảng) khi vượt ngưỡng; undo vẫn pop từ cuối như cũ.
const MAX_HISTORY = 12;

const FILE_OPEN_SLOW_MS = 8_000;

type WorkspaceFileLike = File & {
    path?: string;
    isGenerated?: boolean;
    isTempUploadPath?: boolean;
    __nativePathPending?: boolean;
    __pathMaterializationFailed?: boolean;
    __editCommit?: boolean;
};
type RuntimeWindow = Window & { __TAURI_INTERNALS__?: unknown };
class StaleWorkspaceDocumentRevisionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StaleWorkspaceDocumentRevisionError';
    }
}
type PdfObject = { type?: string; bbox?: unknown; xref?: number | string | null; [key: string]: unknown };
type PdfLayer = { id: number; visible?: boolean; locked?: boolean; children?: PdfLayer[]; [key: string]: unknown };
type BindingMode = 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
type RecipeSettingsView = ProcessingSettings & { imposerMode?: string; chainNup?: boolean; foldPattern?: string; bindingMode?: BindingMode; blankPlacement?: string };
type RecipeExternalInputStep = { externalInputCount?: number };

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = error.message;
        if (typeof message === 'string' && message) return message;
    }
    return String(error);
}

function asRecipeParams(value: object): Record<string, unknown> {
    return value as unknown as Record<string, unknown>;
}


/** Chỉ lớp SVG subscribe zoom; tránh render lại toàn bộ ImpositionTab khi cuộn. */
function ClassicCutlinePageOverlay({
    preview,
    isUpdating,
}: {
    preview: StickerCutlinePreview;
    isUpdating: boolean;
}) {
    const displayZoom = useWorkspaceStore(state => state.viewerZoom);
    return (
        <div
            data-testid="classic-cutline-page-overlay"
            aria-busy={isUpdating}
            className="pointer-events-none absolute inset-0 z-[35] overflow-visible"
        >
            <StickerCutlineOverlay
                preview={preview}
                selectedInstanceId={null}
                displayZoom={displayZoom}
            />
        </div>
    );
}

/** Đồng bộ đúng zoom Viewer cho đường bế của chế độ Ảnh AI nhiều tem. */
function ViewerStickerSheetWorkspace({
    tabId,
    isActive,
    editingEnabled,
    sourcePage,
}: {
    tabId: string;
    isActive: boolean;
    editingEnabled: boolean;
    sourcePage: number;
}) {
    const displayZoom = useWorkspaceStore(state => state.viewerZoom);
    return (
        <StickerSheetWorkspace
            tabId={tabId}
            isActive={isActive}
            embedded
            editingEnabled={editingEnabled}
            sourcePage={sourcePage}
            cutlineDisplayZoom={displayZoom}
        />
    );
}

/**
 * UIUX (feedback 2026-08-21 §CUTPREVIEW.MULTIPAGE1): trang nền chỉ cần ảnh và
 * đường bế; không dựng mask worker/canvas chỉnh sửa cho mọi trang đang mount.
 */
function ReadonlyViewerStickerSheetPageOverlay({
    pageState,
    sourcePage,
}: {
    pageState: StickerSheetPageState;
    sourcePage: number;
}) {
    const displayZoom = useWorkspaceStore(state => state.viewerZoom);
    const manifest = pageState.manifest;
    if (!manifest || !pageState.previewUrl) return null;
    const preview = pageState.cutlinePreview;
    const currentCutlinePreview = (
        preview
        && preview.mask_revision === (manifest.mask_revision ?? 1)
        && preview.preview_width_px === manifest.preview_width_px
        && preview.preview_height_px === manifest.preview_height_px
    ) ? preview : null;

    return (
        <div
            data-testid="sticker-sheet-page-overlay"
            data-source-page={sourcePage}
            data-preview-mode="readonly"
            aria-busy={pageState.isCutlinePreviewing}
            className="pointer-events-none absolute inset-0 z-[35] overflow-hidden bg-white"
        >
            <img
                src={pageState.previewUrl}
                alt={tv('Ảnh tem đã khử nền')}
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none"
            />
            {currentCutlinePreview ? (
                <StickerCutlineOverlay
                    preview={currentCutlinePreview}
                    selectedInstanceId={pageState.selectedInstanceId}
                    displayZoom={displayZoom}
                />
            ) : null}
        </div>
    );
}

/**
 * RECIPE (audit 2026-08-15 §REC.1): thao tác Hủy/lỗi không được để pending
 * note sống sang commit kế tiếp. Unexpected throw cũng phải dọn cùng hợp đồng.
 */
async function runRecordedProcess(
    ticket: RecipeOperationTicket | null,
    run: () => Promise<ProcessOutcome>,
): Promise<ProcessOutcome> {
    try {
        const outcome = await run();
        // Commit thành công đã tự tiêu thụ note. Nếu completed nhưng không commit
        // (vd split odd/even), dọn note còn sót để không ghép nhầm thao tác kế.
        recipeRecorder.discardPending(ticket);
        return outcome;
    } catch (error) {
        recipeRecorder.discardPending(ticket);
        throw error;
    }
}

interface Props {
    tabId?: string;
    isActive?: boolean;
    onDirtyChange?: (isDirty: boolean) => void;
    onTitleChange?: (title: string) => void;
    onSpawnTab?: (file: File, extraPayload?: Record<string, unknown>) => void;
    initialFile?: File;
    initialReport?: string;
    initialFeature?: string;
    lockedMode?: 'booklet' | 'nup' | 'sticker_imposer' | 'cnc_imposer';
    batchOutput?: { docs: { blob: Blob, filename: string, report?: string }[], mergedBlob: Blob };
    systemMergeFiles?: File[];
    /** Office → PDF source (path-stub File from Tauri open/drop). */
    officeSourceFile?: File | null;
    officeSourceFiles?: File[];
    initialRecovery?: import('../lib/recovery').RecoverySnapshot;
    onRequestHome?: () => void;
    documentWindow?: {
        saveAsOnly: boolean;
        disableRecovery: boolean;
        initialViewState?: DocumentWindowViewState;
        onInitialViewStateApplied?: () => void;
    };
    onDocumentWindowApiChange?: (tabId: string, api: DocumentWindowTabApi | null) => void;
}

export default function ImpositionTab(props: Props) {
    const initialLaunchTool = props.lockedMode || props.initialRecovery?.feature || props.initialFeature;
   const [store] = useState(() => createWorkspaceStore(
        useAppSettingsStore.getState().toolMenuMode,
       useAppSettingsStore.getState().toolMenuWidth,
       useAppSettingsStore.getState().toolConfigWidth,
   ));
    const imposerScope = props.tabId ? `tab:${props.tabId}` : undefined;
    const [imposerStore] = useState(() => {
        const nextStore = createImposerSettingsStore(imposerScope);
        if (initialLaunchTool) nextStore.getState().setActiveDashboardTool(initialLaunchTool);
        return nextStore;
    });
    const imposerStoreRef = useRef(imposerStore);
    useEffect(() => () => {
        if (imposerScope) disposeImposerPersistScope(imposerScope);
    }, [imposerScope]);

    return (
        <ImposerSettingsContext.Provider value={imposerStore}>
            <WorkspaceContext.Provider value={store}>
                <ImpositionTabInner {...props} imposerStoreRef={imposerStoreRef} />
            </WorkspaceContext.Provider>
        </ImposerSettingsContext.Provider>
    );
}

function ImpositionTabInner({ tabId, isActive, onDirtyChange, onTitleChange, onSpawnTab, initialFile, initialReport, initialFeature, lockedMode, batchOutput: initialBatchOutput, systemMergeFiles, officeSourceFile, officeSourceFiles, initialRecovery, onRequestHome, documentWindow, onDocumentWindowApiChange, imposerStoreRef }: Props & { imposerStoreRef: React.MutableRefObject<ReturnType<typeof createImposerSettingsStore> | null> }) {
  const { t } = useTranslation();
    const store = useContext(WorkspaceContext);
    if (!store) throw new Error('Missing WorkspaceContext.Provider in the tree');
    const recipeOwnerTabId = tabId || 'workspace:default';
    const getCropWorkingFile = useWorkingPdf();
    //#region State & Hooks
    // ═══ All state from Zustand store ═══
    const {
        phase, setPhase, file, setFile, originalFileName, setOriginalFileName,
        pdfUrl, setPdfUrl, fileSizeStr, setFileSizeStr, setHighlightedIssue,
        isProcessing, setIsProcessing, processStatus, setProcessStatus, error, setError,
        history, setHistory, objectEditPast, objectEditFuture,
        isSaved, setIsSaved, showSaveAsModal, setShowSaveAsModal,
        reportMsg, setReportMsg, viewerDirty, setViewerDirty, viewerPageOrder, setViewerPageOrder,
        viewerPageInstanceIds, setViewerPageInstanceIds,
        viewerPageRotations, setViewerPageRotations, editGeneration, advanceEditGeneration, setBleedView,
        isDraggingSidebar, setIsDraggingSidebar, rightToolMenuFullWidth, setRightToolMenuFullWidth,
        rightToolConfigWidth, setRightToolConfigWidth,
        rightToolMenuMode: toolMenuMode, setRightToolMenuMode,
        pdfObjectsVersion, setPdfObjectsVersion,
        isObjectEditMode,
        currentEditObjects,
        setPdfOcgLayers,
        hiddenOcgLayerIds, ocgVisibilityProvenance, seedOcgLayerState,
        setHiddenObjectIds,
        setLockedObjectIds,
        setLockedOcgLayerIds,
        selectionFileId, setSelectionFileId, vdpFields, setVdpFields, isCropMode, setIsCropMode, commitCropSelection, setIsObjectEditMode, setViewerToolMode,
        selectedVdpFieldIds, setSelectedVdpFieldIds,
        showCloseConfirm, setShowCloseConfirm,
        viewerNumPages,
        viewerActivePage,
        viewerToolMode,
        classicCutlineViewerPreview,
        setDetectedShapeType, setDetectedShapeParams, 
        setDetectedShapesByPage, setDetectedDimensionsByPage, setDetectedShapeParamsByPage,
        detectedDimensionsByPage,
        setViewerFitMode, setViewerPageDisplayMode
    } = useWorkspaceStore(useShallow(state => ({
        phase: state.phase, setPhase: state.setPhase, file: state.file, setFile: state.setFile, originalFileName: state.originalFileName, setOriginalFileName: state.setOriginalFileName,
        pdfUrl: state.pdfUrl, setPdfUrl: state.setPdfUrl, fileSizeStr: state.fileSizeStr, setFileSizeStr: state.setFileSizeStr, setHighlightedIssue: state.setHighlightedIssue,
        isProcessing: state.isProcessing, setIsProcessing: state.setIsProcessing, processStatus: state.processStatus, setProcessStatus: state.setProcessStatus, error: state.error, setError: state.setError,
        history: state.history, setHistory: state.setHistory,
        objectEditPast: state.objectEditPast, objectEditFuture: state.objectEditFuture,
        isSaved: state.isSaved, setIsSaved: state.setIsSaved, showSaveAsModal: state.showSaveAsModal, setShowSaveAsModal: state.setShowSaveAsModal,
        reportMsg: state.reportMsg, setReportMsg: state.setReportMsg, viewerDirty: state.viewerDirty, setViewerDirty: state.setViewerDirty, viewerPageOrder: state.viewerPageOrder, setViewerPageOrder: state.setViewerPageOrder,
        viewerPageInstanceIds: state.viewerPageInstanceIds, setViewerPageInstanceIds: state.setViewerPageInstanceIds,
        viewerPageRotations: state.viewerPageRotations, setViewerPageRotations: state.setViewerPageRotations,
        editGeneration: state.editGeneration, advanceEditGeneration: state.advanceEditGeneration, setBleedView: state.setBleedView,
        isDraggingSidebar: state.isDraggingSidebar, setIsDraggingSidebar: state.setIsDraggingSidebar,
        rightToolMenuFullWidth: state.rightToolMenuFullWidth, setRightToolMenuFullWidth: state.setRightToolMenuFullWidth,
        rightToolConfigWidth: state.rightToolConfigWidth, setRightToolConfigWidth: state.setRightToolConfigWidth,
        rightToolMenuMode: state.rightToolMenuMode, setRightToolMenuMode: state.setRightToolMenuMode,
        pdfObjectsVersion: state.pdfObjectsVersion, setPdfObjectsVersion: state.setPdfObjectsVersion,
        isObjectEditMode: state.isObjectEditMode,
        currentEditObjects: state.currentEditObjects,
        setPdfOcgLayers: state.setPdfOcgLayers,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        ocgVisibilityProvenance: state.ocgVisibilityProvenance,
        seedOcgLayerState: state.seedOcgLayerState,
        setHiddenObjectIds: state.setHiddenObjectIds,
        setLockedObjectIds: state.setLockedObjectIds,
        setLockedOcgLayerIds: state.setLockedOcgLayerIds,
        selectionFileId: state.selectionFileId, setSelectionFileId: state.setSelectionFileId, vdpFields: state.vdpFields, setVdpFields: state.setVdpFields, isCropMode: state.isCropMode, setIsCropMode: state.setIsCropMode, commitCropSelection: state.commitCropSelection, setIsObjectEditMode: state.setIsObjectEditMode, setViewerToolMode: state.setViewerToolMode,
        selectedVdpFieldIds: state.selectedVdpFieldIds, setSelectedVdpFieldIds: state.setSelectedVdpFieldIds,
        showCloseConfirm: state.showCloseConfirm, setShowCloseConfirm: state.setShowCloseConfirm,
        viewerNumPages: state.viewerNumPages,
        viewerActivePage: state.viewerActivePage,
        viewerToolMode: state.viewerToolMode,
        classicCutlineViewerPreview: state.classicCutlineViewerPreview,
        setDetectedShapeType: state.setDetectedShapeType, setDetectedShapeParams: state.setDetectedShapeParams, 
        setDetectedShapesByPage: state.setDetectedShapesByPage, setDetectedDimensionsByPage: state.setDetectedDimensionsByPage, setDetectedShapeParamsByPage: state.setDetectedShapeParamsByPage,
        detectedDimensionsByPage: state.detectedDimensionsByPage,
        setViewerFitMode: state.setViewerFitMode, setViewerPageDisplayMode: state.setViewerPageDisplayMode
    })));

    const renderedDocumentRevision = useMemo(
        () => captureWorkspaceDocumentRevision({
            file,
            viewerPageOrder,
            viewerPageInstanceIds,
            viewerPageRotations,
            editGeneration,
            hiddenOcgLayerIds,
            ocgVisibilityProvenance,
        }),
        [
            file,
            viewerPageOrder,
            viewerPageInstanceIds,
            viewerPageRotations,
            editGeneration,
            hiddenOcgLayerIds,
            ocgVisibilityProvenance,
        ],
    );

    // P1-T03: Use dedicated store for these (migrated)
    // DÙNG SELECTOR + useShallow: chỉ re-render khi 6 field này đổi. Trước đây gọi
    // useImposerSettingsStore() KHÔNG selector → subscribe TOÀN BỘ store → ImpositionTab
    // (cây lớn nhất) re-render mỗi khi ImposerDashboard set sourcePageDim/optimalData/
    // catalogPreview/capacities/fetchEpoch... → re-render cả cây nhiều lần × jsxDEV nặng
    // = góp phần "đơ ~3-4s lúc mở" (đo được trong Performance profile).
    const {
        activeDashboardTool, setActiveDashboardTool, setIsPresetOpen,
        setBatchOutput,
        confirmBookletSettings, setConfirmBookletSettings,
        impositionUnit, separateCutPage,
    } = useImposerSettingsStore(useShallow(s => ({
        activeDashboardTool: s.activeDashboardTool, setActiveDashboardTool: s.setActiveDashboardTool, setIsPresetOpen: s.setIsPresetOpen,
        setBatchOutput: s.setBatchOutput,
        confirmBookletSettings: s.confirmBookletSettings, setConfirmBookletSettings: s.setConfirmBookletSettings,
        impositionUnit: s.impositionUnit,
        separateCutPage: s.separateCutPage,
    })));
    const effectiveSeparateCut = resolveEffectiveSeparateCut(
        activeDashboardTool,
        impositionUnit,
        separateCutPage,
    );

    const {
        favoriteTools,
        hiddenTools,
    } = useAppSettingsStore(useShallow(state => ({
        favoriteTools: state.favoriteTools,
        hiddenTools: state.hiddenTools,
    })));
   const sidebarWidth = rightToolMenuFullWidth;
    const workspaceRootRef = useRef<HTMLDivElement | null>(null);
    const [workspaceWidth, setWorkspaceWidth] = useState(() =>
        typeof window === 'undefined' ? 1400 : window.innerWidth,
    );
    useEffect(() => {
        const root = workspaceRootRef.current;
        if (!root) return;
        const updateWidth = () => {
            if (root.clientWidth > 0) setWorkspaceWidth(root.clientWidth);
        };
        updateWidth();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(updateWidth);
        observer.observe(root);
        return () => observer.disconnect();
    }, []);
    const setToolMenuLayout = useCallback((mode: ToolMenuMode, width?: number) => {
        setRightToolMenuMode(mode);
        if (typeof width === 'number') setRightToolMenuFullWidth(width);
        useAppSettingsStore.getState().setToolMenuLayout(mode, width);
    }, [setRightToolMenuFullWidth, setRightToolMenuMode]);
    const openWorkspaceSidebar = useCallback(() => {
        setRightToolMenuMode('full');
        useAppSettingsStore.getState().openWorkspaceSidebar();
    }, [setRightToolMenuMode]);
    const collapseWorkspaceSidebar = useCallback(() => {
        setRightToolMenuMode('icons');
        useAppSettingsStore.getState().collapseWorkspaceSidebar();
    }, [setRightToolMenuMode]);

    const hasActiveRightTool = activeDashboardTool !== 'none' || isObjectEditMode;
    const effectiveToolMenuLayout = resolveEffectiveToolMenuLayout({
        preferredMode: toolMenuMode,
        preferredFullWidth: sidebarWidth,
        preferredConfigWidth: rightToolConfigWidth,
        containerWidth: workspaceWidth,
        hasConfigPanel: hasActiveRightTool,
        viewerReservedWidth: TOOL_MENU_VIEWER_MIN_WIDTH,
    });
    const effectiveToolMenuMode = effectiveToolMenuLayout.mode;

    const licensePlan = useAuthStore(state => state.licensePlan);
    const licenseFeatures = useAuthStore(state => state.licenseFeatures);
    const requestToolActivation = useToolActivationGuard();
    const launchFeature = initialRecovery?.feature || initialFeature;
    const dedicatedInitialTool = resolveDedicatedInitialTool(launchFeature);
    const [logoSessionDirty, setLogoSessionDirty] = useState(false);
    const [logoWorkspaceOpened, setLogoWorkspaceOpened] = useState(
        () => activeDashboardTool === 'logo_rebuild' || dedicatedInitialTool === 'logo_rebuild',
    );
    const stickerSheetTabSummary = useStickerSheetStore(useShallow(
        state => selectStickerSheetTabSummary(state, tabId),
    ));
    const {
        stickerSheetMode,
        stickerSheetSourceFile,
        stickerSheetSourceOrigin,
        stickerSheetSourceRevision,
        stickerSheetActiveSourcePage,
        stickerSheetPages,
        stickerSheetBusy,
    } = stickerSheetTabSummary;
    const setStickerSheetMode = useStickerSheetStore(state => state.setMode);
    const disposeStickerSheetTab = useStickerSheetStore(state => state.disposeTab);
    const stickerSheetWorkingPageCount = Math.max(
        viewerPageOrder?.length || 0,
        viewerNumPages || 0,
    );
    const stickerSheetPageStatuses = useMemo(
        () => selectStickerSheetPageWorkflowStatuses(
            stickerSheetTabSummary,
            stickerSheetWorkingPageCount,
        ),
        [stickerSheetTabSummary, stickerSheetWorkingPageCount],
    );
    const previousDashboardToolRef = useRef<string | null>(null);
    const previousIsCropModeRef = useRef<boolean>(isCropMode);
    const suppressDedicatedToolRestoreRef = useRef(false);
    const syncedStickerSourceRef = useRef<File | null>(null);

    useEffect(() => () => {
        if (tabId) disposeStickerSheetTab(tabId);
    }, [disposeStickerSheetTab, tabId]);

    // SEC (audit 2026-08-04 re-audit UI): snapshot cũ có thể chứa OCR/tool đã
    // tắt và đi thẳng vào store, không qua click guard. Chỉ hai state nội bộ
    // `none`/`merge` được phép thiếu registry; còn lại trả về menu an toàn.
    useEffect(() => {
        if (
            activeDashboardTool !== 'none'
            && activeDashboardTool !== 'merge'
            && !findToolByUniqueKey(activeDashboardTool)
        ) {
            setActiveDashboardTool('none');
        }
    }, [activeDashboardTool, setActiveDashboardTool]);

    // NAV (fix 2026-07-29): bao trang thai cong cu THUC TE cua tung tab cho lop nhan file native.
    // payload.focusFeature chi mo ta luc mo tab va se cu khi user doi cong cu.
    useEffect(() => {
        if (!tabId) return;
        return registerActiveTabFeature(tabId, activeDashboardTool);
    }, [tabId, activeDashboardTool]);

    // REC (audit 2026-08-15 §REC.OWN): các tab đều được giữ mounted. Recorder phải biết
    // tab nào thực sự active để callback legacy không thể xóa pending của workspace khác.
    useEffect(() => {
        recipeRecorder.setTabActive(recipeOwnerTabId, isActive === true);
        return () => recipeRecorder.setTabActive(recipeOwnerTabId, false);
    }, [isActive, recipeOwnerTabId]);

    // Đóng tab sở hữu phải kết thúc draft; nếu không recorder singleton sẽ khóa nút Ghi
    // của mọi tab còn lại cho tới khi khởi động lại ứng dụng.
    useEffect(() => () => {
        recipeRecorder.cancel(recipeOwnerTabId);
    }, [recipeOwnerTabId]);

    useEffect(() => {
        // UIUX (audit 2026-08-09 §LR3.04): giữ component mounted sau lần mở đầu
        // để đổi công cụ không làm mất editor/history/SVG đang dựng trong cùng tab.
        if (activeDashboardTool === 'logo_rebuild') setLogoWorkspaceOpened(true);
    }, [activeDashboardTool]);



    const [showSavePrintModal, setShowSavePrintModal] = useState(false);
    const [scaleConfirmModal, setScaleConfirmModal] = useState<{ msg: string, resolve: (v: boolean) => void } | null>(null);
    // Hộp thoại in hợp nhất kiểu Acrobat (máy in / số bản / trang / tỉ lệ / orientation
    // + preview). openPrintDialog() trả Promise<boolean>; printDialog là JSX để render.
    const { openPrintDialog, printDialog } = usePrintDialog();
    // Gửi Máy Bế (spec: gui-may-be) — CODE GIỮ LẠI nhưng ẩn lối vào UI (kênh TCP/serial chưa
    // kiểm chứng end-to-end). Thay bằng "Mở bằng Illustrator/CorelDRAW" (showOpenInDesign).
    const [showCutExport, setShowCutExport] = useState(false);
    // Mở file khuôn bằng AI/Corel (nơi plugin máy bế đã cài) — thay chỗ nút "Gửi Máy Bế".
    const [showOpenInDesign, setShowOpenInDesign] = useState(false);
    const [showRecipePanel, setShowRecipePanel] = useState(false);
    const [isRecipePlaying, setIsRecipePlaying] = useState(false);
    const editSessionForToolRef = useRef<UseEditSession | null>(null);
    const [editBarrierPending, setEditBarrierPending] = useState(false);
    const ensureEditCommittedBeforeTool = useCallback(async (): Promise<void> => {
        // REVISION (audit 2026-08-25 §REV.01-02): commit() tự dùng chung Promise
        // đang bay và chỉ resolve sau khi onCommit đã publish Working File mới.
        await editSessionForToolRef.current?.commit();
    }, []);
    const runEditTransitionBarrier = useCallback(async (): Promise<boolean> => {
        setEditBarrierPending(true);
        try {
            await ensureEditCommittedBeforeTool();
            return true;
        } catch (error) {
            setError(errorMessage(error) || t(
                'tabs.imposition:loi_chot_chinh_sua_truoc_cong_cu',
                { defaultValue: 'Không thể chốt thay đổi Edit PDF. Hãy thử lại trước khi chạy công cụ khác.' },
            ));
            return false;
        } finally {
            setEditBarrierPending(false);
        }
    }, [ensureEditCommittedBeforeTool, setError, t]);
    // Keep the Crop mode, the toolbar button, and the right-hand tool panel in sync.
    // Selecting Crop from the panel enables drawing; C/toolbar toggles promote the
    // same mode into the panel without opening a separate modal.
    useLayoutEffect(() => {
        const prevTool = previousDashboardToolRef.current;
        const prevCrop = previousIsCropModeRef.current;
        previousDashboardToolRef.current = activeDashboardTool;
        previousIsCropModeRef.current = isCropMode;
        if (
            prevTool !== null
            && prevTool !== activeDashboardTool
            && activeDashboardTool !== 'none'
            && activeDashboardTool !== 'sticker'
            && isObjectEditMode
        ) {
            // Chuyển công cụ là điểm commit-on-exit của Edit PDF. Chặn panel ngay
            // trong lúc commit để người dùng không thể bấm Chạy trên backing file cũ.
            setIsObjectEditMode(false);
            // REVISION (audit 2026-08-25 §REV.01): session có thể đang có op bay
            // nhưng dirty chưa kịp đổi; luôn drain/commit khi phiên còn mở.
            if (editSessionForToolRef.current?.sessionId) {
                void runEditTransitionBarrier().then((committed) => {
                    if (!committed) setIsObjectEditMode(true);
                });
            }
        }
        if (prevTool === null) {
            if (activeDashboardTool === 'crop' && !isCropMode) {
                setIsCropMode(true);
                setIsObjectEditMode(false);
                setViewerToolMode('pointer');
            }
            return;
        }
        if (prevTool !== activeDashboardTool) {
            if (activeDashboardTool === 'crop') {
                if (!isCropMode) setIsCropMode(true);
                setIsObjectEditMode(false);
                setViewerToolMode('pointer');
            } else if (isCropMode) {
                setIsCropMode(false);
            }
            return;
        }
        // UIUX: Chỉ đồng bộ activeDashboardTool khi isCropMode THAY ĐỔI do tương tác ngoài (phím tắt C / nút toolbar Acrobat)
        if (prevCrop !== isCropMode) {
            if (isCropMode && activeDashboardTool !== 'crop') {
                setActiveDashboardTool('crop');
            } else if (!isCropMode && activeDashboardTool === 'crop') {
                setActiveDashboardTool('none');
            }
        }
    }, [activeDashboardTool, isCropMode, isObjectEditMode, runEditTransitionBarrier,
        setActiveDashboardTool, setIsCropMode, setIsObjectEditMode, setViewerToolMode]);
    // Lựa chọn vị trí trang trắng — chỉ hỏi trong dialog Xác nhận khi số trang lẻ tay.
    const [confirmBlankPlacement, setConfirmBlankPlacement] = useState<'end' | 'center'>('end');

    // Set initial report from props (once)
    useEffect(() => {
        if (initialReport && !reportMsg) setReportMsg(initialReport);
    }, [initialReport, reportMsg, setReportMsg]);

    // Tile cache là GLOBAL dùng chung mọi tab, key = `${pdfUrl}_...`. Gom mọi pdfUrl tab
    // này từng dùng, khi ĐÓNG tab (unmount) dọn hết tile của chúng → giải phóng bitmap
    // mà KHÔNG đụng tab khác (audit RAM 2026-07-06).
    const usedPdfUrlsRef = useRef<Set<string>>(new Set());
    useEffect(() => { if (pdfUrl) usedPdfUrlsRef.current.add(pdfUrl); }, [pdfUrl]);
    useEffect(() => {
        // LINT (audit 2026-08-24 LO140): chụp tập URL tại lúc đăng ký cleanup,
        // tránh dọn nhầm ref đã đổi sau khi component unmount.
        const usedPdfUrls = usedPdfUrlsRef.current;
        return () => {
            for (const u of usedPdfUrls) clearTileUrlCacheForFile(u);
            usedPdfUrls.clear();
        };
    }, []);

    const handleVdpBoxCreate = useCallback((box: { x: number; y: number; width: number; height: number; pageNum: number, type?: string, textContent?: string, name?: string }) => {
        const fieldId = `field_${Date.now()}`;
        setVdpFields(prev => {
            const newField: VdpToolField = {
                id: fieldId,
                name: box.name || `Truong_${prev.length + 1}`,
                type: box.type || 'text',
                position: { x: box.x, y: box.y }, // for pdfme
                x: box.x, // for AcrobatViewer
                y: box.y, // for AcrobatViewer
                width: box.width,
                height: box.height,
                pageNum: box.pageNum,
                alignment: 'center',
                fontSize: 13,
                characterSpacing: 0,
                lineHeight: 1,
                fontName: 'Roboto',
                fontColor: '#000000',
                backgroundColor: '',
                opacity: 1,
                ...(box.textContent ? { textContent: box.textContent } : {})
            };

            if (newField.type === 'qrcode') {
                newField.qrStyle = {
                    dotType: 'square',
                    dotColor: '#000000',
                    cornerSquareType: 'none',
                    cornerSquareColor: '#000000',
                    cornerDotType: 'none',
                    cornerDotColor: '#000000',
                    bgColor: '#FFFFFF',
                    transparentBg: false,
                    margin: 0,
                };
                newField.errorCorrection = 'M';
            } else if (newField.type === 'barcode') {
                newField.barcodeType = 'code128';
                newField.barColor = '#000000';
                newField.bgColor = '#FFFFFF';
                newField.showText = true;
                newField.quietZone = 2;
            }

            return [...prev, newField];
        });
        setSelectedVdpFieldIds([fieldId]);
    }, [setSelectedVdpFieldIds, setVdpFields]);

    // Handle ESC to close modals
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (scaleConfirmModal) {
                    scaleConfirmModal.resolve(false);
                    setScaleConfirmModal(null);
                }
                if (showCloseConfirm) {
                    setShowCloseConfirm(false);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [scaleConfirmModal, setShowCloseConfirm, showCloseConfirm]);

    // Pre-upload file silently in background for features that need file_id (Output Preview, Selection, etc.)
    // ĐÃ DEFER: chỉ cần khi dùng Selection/Output Preview, không cần lúc mở. Trì hoãn để
    // không tranh chấp tài nguyên (đọc file + gọi Python) với meta + render trang đầu.
    // ⚠️ ĐO ĐƯỢC: với file native LỚN, prepareFileForUpload → readFile(path) đọc CẢ FILE
    // qua Tauri IPC (chặn main thread ~6s với file 96MB) rồi POST 96MB lên Python → "treo"
    // ~6s sau khi mở (đã đo: render xong 1s nhưng paint mãi 6s sau). Vì pre-upload chỉ là
    // tối ưu latency cho tính năng dùng SAU, BỎ QUA với file lớn → để upload LAZY khi tính
    // năng cần (lúc đó mới chịu chi phí, không treo lúc mở).
    useEffect(() => {
        if (file && !selectionFileId && file.name.toLowerCase().endsWith('.pdf')) {
            const nativePath = (file as WorkspaceFileLike)?.path;
            if (nativePath) {
                const identity = workspaceDocumentIdentity(
                    file,
                    viewerPageOrder,
                    viewerPageRotations,
                );
                console.info('[PERF-MEASURE] Instant bind nativePath to selectionFileId (0ms):', nativePath);
                setSelectionFileId(nativePath, identity);
                return;
            }
            const sz = (file as WorkspaceFileLike)?.size || 0;
            // History/native stub có path nhưng chưa biết size: coi là file lớn
            // cho pre-upload. Tác vụ cần file_id sẽ đăng ký path khi người dùng mở nó.
            if ((file as WorkspaceFileLike).path && sz <= 0) return;
            // Bỏ pre-upload eager cho file > 20MB (sẽ upload on-demand khi mở Selection/Output Preview).
            if (sz > 20 * 1024 * 1024) return;
            const timer = setTimeout(() => {
                void (async () => {
                    // REVISION (audit 2026-08-25 §REV.10): upload đúng snapshot
                    // đang thấy và chỉ bind file_id nếu snapshot còn current.
                    const snapshot = getCropWorkingFile.capture();
                    if (!snapshot) return;
                    const workingFile = await getCropWorkingFile.materialize(snapshot);
                    if (!getCropWorkingFile.isCurrent(snapshot)) return;
                    const res = await uploadPDF(workingFile);
                    if (!getCropWorkingFile.isCurrent(snapshot)) return;
                    const identity = workspaceDocumentIdentity(
                        snapshot.file,
                        snapshot.viewerPageOrder,
                        snapshot.viewerPageRotations,
                    );
                    setSelectionFileId(res.id, identity);
                    if (res.pdf_metadata?.color_space) {
                        onTitleChange?.(`${snapshot.file.name} (${res.pdf_metadata.color_space})`);
                    }
                })().catch(() => { /* silent — tác vụ cần file_id sẽ retry */ });
            }, 2500);
            return () => clearTimeout(timer);
        }
    }, [file, getCropWorkingFile, onTitleChange, selectionFileId, setSelectionFileId]);
    // FILEIO (audit 2026-08-02 §TEST.1): chuyển ảnh có trạng thái hữu hạn. Watchdog chỉ
    // đổi thông tin UI, không hard-timeout ảnh lớn; generation fence từ chối mọi callback muộn.
    // [RESULT-TAB FLASH FIX 2026-08-18] Tab kết quả có file ngay từ lúc mount phải
    // hiện trạng thái đang mở. Nếu bắt đầu ở `idle`, uploader trống sẽ lóe lên trong
    // lúc primeViewerFirstFrame chuẩn bị viewer PDF, khiến người dùng tưởng mất file.
    const [fileOpeningPhase, setFileOpeningPhase] = useState<FileOpeningPhase>(
        () => initialFileOpeningPhase(initialFile),
    );
    // NAV (audit 2026-08-05 §AI2.ROUTE1): giữ ảnh trước bước normalize -> PDF để
    // chế độ Ảnh AI dùng lại đúng nguồn đang mở, không bắt người dùng chọn lần hai.
    const [sourceImageFile, setSourceImageFile] = useState<File | null>(() => (
        initialFile && isSupportedImageFileName(initialFile.name) ? initialFile : null
    ));
    const [sourceImageOwner, setSourceImageOwner] = useState<SourceImageRevisionOwner | null>(null);
    // REVISION (audit 2026-08-25 §REV.08): Undo và Recovery dùng chung pending
    // transaction; state đặt trước lifecycle mở file để entry chỉ được tạo một lần.
    const [pendingHistoryEntry, setPendingHistoryEntry] = useState<WorkspaceHistoryEntry | null>(null);
    const [restoredHistoryDirtyFile, setRestoredHistoryDirtyFile] = useState<File | null>(null);
    const sourceImageFileForRevision = sourceImageFile && isSourceImageRevisionCurrent(
        sourceImageOwner,
        renderedDocumentRevision,
    ) ? sourceImageFile : null;
    const stickerSheetSourceVisible = viewerShowsStickerSource(
        file,
        sourceImageFileForRevision,
        stickerSheetSourceFile,
        stickerSheetSourceOrigin === 'workspace' && stickerSheetSourceRevision
            ? isWorkspaceDocumentRevisionCurrent(
                stickerSheetSourceRevision as WorkspaceDocumentRevisionToken,
                store.getState(),
            ) : undefined,
    );
    const currentViewerDocumentIdentity = workspaceDocumentIdentity(
        file,
        viewerPageOrder,
        viewerPageRotations,
    );
    const classicCutlineOverlay = (
        isActive === true
        && activeDashboardTool === 'sticker'
        && stickerSheetMode === 'existing'
        && classicCutlineViewerPreview?.viewerPage === viewerActivePage
        && classicCutlineViewerPreview.documentIdentity === currentViewerDocumentIdentity
    ) ? classicCutlineViewerPreview : null;
    const thumbnailCutlinePreviews = useMemo<Partial<Record<number, ThumbnailCutlinePreviewItem>> | undefined>(() => {
        if (isActive !== true || activeDashboardTool !== 'sticker') return undefined;
        if (stickerSheetMode === 'ai-sheet' && stickerSheetSourceVisible) {
            const result: Partial<Record<number, ThumbnailCutlinePreviewItem>> = {};
            let hasAny = false;
            for (const [posStr, pageState] of Object.entries(stickerSheetPages)) {
                const pos = Number(posStr);
                if (pageState?.manifest && (pageState.cutlinePreview || pageState.previewUrl)) {
                    result[pos] = {
                        cutlinePreview: pageState.cutlinePreview,
                        previewUrl: pageState.previewUrl,
                    };
                    hasAny = true;
                }
            }
            return hasAny ? result : undefined;
        }
        if (stickerSheetMode === 'existing' && classicCutlineOverlay?.preview && classicCutlineOverlay.viewerPage) {
            return {
                [classicCutlineOverlay.viewerPage]: {
                    cutlinePreview: classicCutlineOverlay.preview,
                    previewUrl: null,
                },
            };
        }
        return undefined;
    }, [isActive, activeDashboardTool, stickerSheetMode, stickerSheetSourceVisible, stickerSheetPages, classicCutlineOverlay]);
    const renderStickerSheetPageOverlay = useCallback((context: PageOverlayRenderContext) => {
        const workingPosition = context.viewerPagePosition;
        const pageState = stickerSheetPages[workingPosition];
        if (!pageState?.manifest) return null;
        const editable = isActive === true && context.isActivePage;
        if (!editable) {
            return (
                <ReadonlyViewerStickerSheetPageOverlay
                    pageState={pageState}
                    sourcePage={workingPosition}
                />
            );
        }
        return (
            <ViewerStickerSheetWorkspace
                tabId={tabId || ''}
                isActive
                editingEnabled={viewerToolMode === 'pointer'}
                sourcePage={workingPosition}
            />
        );
    }, [isActive, stickerSheetPages, tabId, viewerToolMode]);
    const [initialOpenRetryToken, setInitialOpenRetryToken] = useState(0);
    const fileOpeningAttemptRef = useRef(0);
    const fileOpeningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const initialOpenRetryRef = useRef<(() => void) | null>(null);
    const pendingSelectedOpenRef = useRef<{ file: File; allFiles?: File[] } | null>(null);

    const clearFileOpeningTimer = useCallback(() => {
        if (fileOpeningTimerRef.current) clearTimeout(fileOpeningTimerRef.current);
        fileOpeningTimerRef.current = null;
    }, []);

    const beginFileOpeningAttempt = useCallback((showLoading = true) => {
        clearFileOpeningTimer();
        const attempt = ++fileOpeningAttemptRef.current;
        setError('');
        if (showLoading) {
            setFileOpeningPhase('loading');
            fileOpeningTimerRef.current = setTimeout(() => {
                if (fileOpeningAttemptRef.current === attempt) setFileOpeningPhase('slow');
            }, FILE_OPEN_SLOW_MS);
        } else {
            setFileOpeningPhase('idle');
        }
        return attempt;
    }, [clearFileOpeningTimer, setError]);

    const settleFileOpeningAttempt = useCallback((attempt: number, next: 'idle' | 'error') => {
        if (fileOpeningAttemptRef.current !== attempt) return false;
        clearFileOpeningTimer();
        setFileOpeningPhase(next);
        return true;
    }, [clearFileOpeningTimer]);

    const cancelFileOpening = useCallback(() => {
        fileOpeningAttemptRef.current += 1;
        clearFileOpeningTimer();
        setError('');
        setFileOpeningPhase('idle');
    }, [clearFileOpeningTimer, setError]);

    useEffect(() => () => {
        fileOpeningAttemptRef.current += 1;
        clearFileOpeningTimer();
    }, [clearFileOpeningTimer]);

    // Handle initial file passed from App.tsx (recent / picker / native drop / Open With).
    useEffect(() => {
        if (initialFile && !file) {
            let cancelled = false;
            pendingSelectedOpenRef.current = null;
            initialOpenRetryRef.current = () => setInitialOpenRetryToken(token => token + 1);
            const attempt = beginFileOpeningAttempt(true);
            (async () => {
                let openedFile = initialFile;
                setSourceImageFile(isSupportedImageFileName(initialFile.name) ? initialFile : null);
                syncedStickerSourceRef.current = initialFile;
                try {
                    openedFile = await imageFileToPdfIfNeeded(initialFile, getFileArrayBuffer);
                    setSourceImageOwner(isSupportedImageFileName(initialFile.name)
                        ? createSourceImageRevisionOwner(openedFile, store.getState().editGeneration)
                        : null);
                } catch (openError) {
                    console.error('[initialFile] convert ảnh → PDF lỗi:', openError);
                    if (!cancelled && fileOpeningAttemptRef.current === attempt) {
                        setError(formatFileOpeningError(
                            openError,
                            t('tabs.imposition:khong_doc_duoc_file_anh'),
                        ));
                        settleFileOpeningAttempt(attempt, 'error');
                    }
                    return;
                }
                if (cancelled || fileOpeningAttemptRef.current !== attempt) return;
                // PERF (audit 2026-08-26 §FILE.E2): chỉ chờ grace ngắn; PPE chậm
                // vẫn chạy nền và ghi cache thay vì khóa màn mở file vô hạn.
                await waitForViewerFirstFrameGrace(primeViewerFirstFrame(openedFile));
                if (cancelled || fileOpeningAttemptRef.current !== attempt) return;
                // Ảnh đã convert thành File PDF không còn path đĩa nên dùng blob URL.
                if (pdfUrl) URL.revokeObjectURL(pdfUrl);
                let objUrl = '';
                const nativePath = (openedFile as File & { path?: string }).path;
                const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
                let recoveryEntry: WorkspaceHistoryEntry | null = null;
                if (initialRecovery) {
                    const currentFingerprint = nativePath
                        ? await readRecoverySourceFingerprint(nativePath)
                        : null;
                    if (!isRecoverySourceCurrent(initialRecovery, currentFingerprint)) {
                        setError(t('tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly'));
                        settleFileOpeningAttempt(attempt, 'error');
                        return;
                    }
                    // Entry giữ đúng openedFile object; AcrobatViewer chỉ hydrate nó
                    // sau loader ready và tự sinh ID riêng khi snapshot v1 chưa có IDs.
                    recoveryEntry = createRecoveryHistoryEntry(initialRecovery, openedFile);
                }
                if (isTauri && !nativePath) {
                    // UIUX (audit 2026-08-04 §CROP.LOAD): file kết quả trong RAM sẽ được
                    // materialize sang đường dẫn tạm ngay sau khi mở. Báo trước cho viewer để
                    // không hiện lỗi PDF.js giả trong lúc chờ chuyển sang PDFium.
                    try {
                        Object.defineProperty(openedFile, '__nativePathPending', {
                            value: true,
                            configurable: true,
                        });
                    } catch { /* PDF.js vẫn là phương án dự phòng nếu không gắn được cờ. */ }
                }
                if (isTauri && nativePath) {
                    objUrl = localFileUrl(nativePath);
                } else {
                    objUrl = URL.createObjectURL(openedFile);
                }
                setFile(openedFile);
                if (recoveryEntry) {
                    setPendingHistoryEntry(recoveryEntry);
                    setRestoredHistoryDirtyFile(openedFile);
                    setIsSaved(false);
                }
                setOriginalFileName(openedFile.name);
                if (nativePath) {
                    const docId = workspaceDocumentIdentity(openedFile, undefined, undefined);
                    setSelectionFileId(nativePath, docId);
                } else {
                    setSelectionFileId('');
                }
                setFileSizeStr((openedFile.size / (1024 * 1024)).toFixed(2) + ' MB');
                setPdfUrl(objUrl);
                setPhase('workspace');
                settleFileOpeningAttempt(attempt, 'idle');
                console.info(`[PERF-MEASURE][INITIAL-FILE] Opened ${openedFile.name} ready in workspace`);
                onTitleChange?.(openedFile.name);

                // Chỉ cập nhật tiêu đề màu sau first tile để không tranh tài nguyên lúc mở.
                setTimeout(() => {
                    detectColorSpace(openedFile).then(cs => {
                        if (cs) onTitleChange?.(`${openedFile.name} (${cs})`);
                    });
                }, 2500);

                if (initialBatchOutput) setBatchOutput(initialBatchOutput);
            })();
            return () => {
                cancelled = true;
                if (fileOpeningAttemptRef.current === attempt) {
                    fileOpeningAttemptRef.current += 1;
                    clearFileOpeningTimer();
                }
            };
        }
        if (!initialFile) setFileOpeningPhase('idle');
        // Chỉ khởi động lại khi nguồn hoặc lệnh Thử lại đổi; callback UI đổi không được hủy conversion đang chạy.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialFile, initialBatchOutput, initialOpenRetryToken, beginFileOpeningAttempt, clearFileOpeningTimer, settleFileOpeningAttempt]);
    // Áp lockedMode = "đang ở công cụ nào". Tác vụ (Bình trang / Dàn nhiều mẫu) nhớ
    // RIÊNG theo từng công cụ trong toolProfiles — KHÔNG ghi đè taskMode bằng identity
    // công cụ (sticker_imposer/cnc_imposer). Trước đây ép taskMode = lockedMode → mỗi
    // lần mở file/tool lại về "Dàn nhiều mẫu".
    const applyLockedMode = useCallback((mode: string | undefined | null) => {
        if (!mode) return;
        const st = imposerStoreRef.current!.getState();
        // Booklet: taskMode chính là booklet
        if (mode === 'booklet') {
            st.setTaskMode('booklet');
            return;
        }
        // Cắt xén / tem bế / bế rớt: nạp taskMode đã nhớ của ĐÚNG công cụ đó
        if (mode === 'nup' || mode === 'sticker_imposer' || mode === 'cnc_imposer') {
            st.restoreTaskModeForTool(mode);
            return;
        }
        st.setTaskMode(mode as import('./imposition-tools/types').TaskMode);
    }, [imposerStoreRef]);

    // Gán công cụ khoá (từ Home: tem bế / bế rớt / cắt xén / booklet) — chỉ khi
    // lockedMode đổi, KHÔNG phụ thuộc file (tránh reset Tác vụ mỗi lần mở file mới).
    useEffect(() => {
        if (!lockedMode) return;
        setActiveDashboardTool(lockedMode);
        applyLockedMode(lockedMode);
    }, [applyLockedMode, lockedMode, setActiveDashboardTool]);

    const appliedLaunchFeatureRef = useRef<string | null>(null);
    // Công cụ mở từ Home hoặc snapshot khôi phục dùng cùng một hợp đồng panel phải.
    // Chỉ kích hoạt một lần duy nhất lúc khởi tạo tab — không ghi đè khi user đã chủ động chuyển công cụ hoặc khi switch tab.
    useEffect(() => {
        if (launchFeature && appliedLaunchFeatureRef.current !== launchFeature) {
            appliedLaunchFeatureRef.current = launchFeature;
            if (launchFeature === 'logo_rebuild' && !LOGO_REBUILD_ENABLED) {
                setActiveDashboardTool('none');
                return;
            }
            // Only auto-bypass upload for standalone tools
            if (dedicatedInitialTool) {
                setPhase('workspace');
            }
            setActiveDashboardTool(launchFeature);
            applyLockedMode(lockedMode);
            const names: Record<string, string> = {
                'bgremover': t('tabs.imposition:tach_nen_ai'),
                'document_cleanup': tv('Nắn thẻ – Làm trắng scan'),
                'upscale': t('tabs.imposition:phong_to_anh'),
                'logo_rebuild': tv('Vector hóa Logo'),
                'sticker': t('tabs.imposition:tao_vien_cat_be'),
                'split': t('tabs.imposition:tach_file'),
                'datamerge': t('tabs.imposition:tron_du_lieu_vdp'),
                'numbering': t('tabs.imposition:nhay_so_tu_dong'),
                'optimize': t('tabs.imposition:nen_toi_uu_pdf'),
                'shuffle': t('tabs.imposition:xao_tron_trang'),
                'resize': t('tabs.imposition:co_gian_trang')
            };
            if (names[launchFeature]) {
                onTitleChange?.(names[launchFeature]);
            }
        }
    }, [launchFeature, dedicatedInitialTool, lockedMode, onTitleChange, setActiveDashboardTool, setPhase, t, applyLockedMode]);

    // UIUX (fix 2026-07-28): tự phục hồi tab chuyên dụng khi state rơi về none ngoài ý muốn.
    // Nút X là hành động chủ động nên được phép đóng panel đúng một lần.
    useEffect(() => {
        if (!dedicatedInitialTool || activeDashboardTool !== 'none') return;
        if (suppressDedicatedToolRestoreRef.current) {
            suppressDedicatedToolRestoreRef.current = false;
            return;
        }
        setActiveDashboardTool(dedicatedInitialTool);
    }, [dedicatedInitialTool, activeDashboardTool, setActiveDashboardTool]);

    // Async physical path polyfill (non-blocking via HTTP)
    useEffect(() => {
        if (file && !(file as WorkspaceFileLike).path && !(file as WorkspaceFileLike).__pathMaterializationFailed && (window as RuntimeWindow).__TAURI_INTERNALS__) {
            let isCancelled = false;
            (async () => {
                try {
                    let tempPath = '';
                    try {
                        const { uploadFileForNup } = await import('../lib/api');
                        tempPath = await uploadFileForNup(file as File);
                    } catch (httpErr) {
                        console.warn("HTTP upload failed, falling back to IPC writeFile (may freeze UI)", httpErr);
                        const { tempDir, join } = await import('@tauri-apps/api/path');
                        const { writeFile } = await import('@tauri-apps/plugin-fs');
                        const objUrl = URL.createObjectURL(file);
                        let buffer: ArrayBuffer;
                        try {
                            const resp = await fetch(objUrl);
                            buffer = await resp.arrayBuffer();
                        } finally {
                            URL.revokeObjectURL(objUrl);
                        }
                        const tDir = await tempDir();
                        tempPath = await join(tDir, `prynx_input_${Date.now()}_${file.name}`);
                        await writeFile(tempPath, new Uint8Array(buffer));
                    }
                    
                    if (!isCancelled && tempPath) {
                        // LƯU Ý: path này CHỈ là file tạm backend (tên <uuid>.pdf) phục vụ
                        // render/detect — KHÔNG phải nơi lưu thật của người dùng. Đánh dấu
                        // `isTempUploadPath` để Ctrl+S KHÔNG ghi đè vào temp + đổi tên tab
                        // thành chuỗi uuid, mà mở hộp thoại chọn vị trí lưu (audit: file tách
                        // trang bị đổi tên thành hash sau khi Save).
                        // Không mutate File đang được PDF loader giữ: thay nguồn bằng một File mới
                        // để generation fence hủy sạch lượt chờ và chuyển thẳng sang PDFium.
                        const newFile = new File([file], file.name, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                        Object.defineProperty(newFile, 'path', { value: tempPath });
                        try { Object.defineProperty(newFile, 'isTempUploadPath', { value: true, configurable: true }); } catch { /* ignore */ }
                        if (isGeneratedWorkspaceFile(file)) {
                            markGeneratedWorkspaceFile(newFile);
                        }
                        setFile(newFile);
                        
                        // Now that we have a physical path, detectColorSpace can use the backend API
                        // which supports compressed PDFs and Object Streams
                        detectColorSpace(newFile).then(cs => {
                            if (cs) {
                                onTitleChange?.(`${newFile.name} (${cs})`);
                            }
                        });
                    }
                } catch (e) {
                    console.error("Path polyfill failed", e);
                    if (!isCancelled && (file as WorkspaceFileLike).__nativePathPending) {
                        // Cả upload HTTP lẫn ghi IPC đều thất bại: bỏ trạng thái chờ và cho
                        // usePdfLoader thử PDF.js thật sự. Cờ failed ngăn effect này lặp vô hạn.
                        const fallbackFile = new File([file], file.name, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                        try { Object.defineProperty(fallbackFile, '__pathMaterializationFailed', { value: true, configurable: true }); } catch { /* ignore */ }
                        if (isGeneratedWorkspaceFile(file)) {
                            markGeneratedWorkspaceFile(fallbackFile);
                        }
                        setFile(fallbackFile);
                    }
                }
            })();
            return () => { isCancelled = true; };
        }
    }, [file, onTitleChange, setFile]);

    const handleBleedUpdate = useCallback((show: boolean, mm: number) => {
        setBleedView((prev: { show: boolean; mm: number }) => (prev.show === show && prev.mm === mm) ? prev : { show, mm });
    }, [setBleedView]);

    useEffect(() => {
        if (!isActive) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (showSaveAsModal && e.key === 'Escape') setShowSaveAsModal(false);
        };
        if (showSaveAsModal) window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showSaveAsModal, isActive, setShowSaveAsModal]);


    // Routing panel-PHẢI: quyết định tường minh qua hàm thuần (test ở toolPanel.test.ts).
    const rightPanelKind = resolveRightPanel(activeDashboardTool, isObjectEditMode);

    // ─── Lưu / Tải MẪU bố cục VDP (dùng cho datamerge / numbering / cover) ───
    const isVdpPanel = rightPanelKind === 'datamerge' || rightPanelKind === 'numbering' || rightPanelKind === 'cover_numbering';
    const handleSaveVdpTemplate = () => saveVdpTemplate(vdpFields, file?.name, (m) => toast.info(m));
    const handleLoadVdpTemplate = async () => {
        const fields = await loadVdpTemplate((m) => toast.info(m));
        if (fields) {
            setVdpFields(fields);
            setSelectedVdpFieldIds([]);
        }
    };

    // Cờ "phiên edit-object còn thay đổi chưa ghi ra đĩa" — đồng bộ từ editSession.dirty
    // (khai báo phía dưới) qua effect. isDirty phải tính CẢ nó: với commit-on-exit, thao
    // tác edit chỉ nằm trong RAM session; nếu bỏ qua thì đóng tab/app KHÔNG cảnh báo →
    // mất thay đổi âm thầm. Khai báo state ở ĐÂY (trước isDirty) để tránh TDZ.
    const [editSessionDirty, setEditSessionDirty] = useState(false);

    const documentIsDirty = useMemo(() => {
        if (editSessionDirty) return true; // edit-object chưa commit → LUÔN dirty (kể cả isSaved)
        if (isSaved) return false;
        if (isRestoredDocumentDirty(file, restoredHistoryDirtyFile)) return true;
        if (history.length > 0) return true;
        if (viewerDirty) return true;

        if (isGeneratedWorkspaceFile(file)) return true;

        // viewerPageRotations là number[] THEO VỊ TRÍ, luôn đầy đủ độ dài (kể cả toàn 0).
        // Phải kiểm CÓ GÓC KHÁC 0 — KHÔNG dùng .length (bật oan cờ "đang sửa" → auto-save +
        // prompt lưu oan dù chưa xoay gì). Object.values chạy đúng cả trên array lẫn record cũ.
        if (viewerPageRotations && Object.values(viewerPageRotations).some((r: unknown) => ((((r as number) % 360) + 360) % 360) !== 0)) return true;
        if (vdpFields && vdpFields.length > 0) return true;
        return false;
    }, [isSaved, restoredHistoryDirtyFile, history.length, file, viewerPageRotations, vdpFields, viewerDirty, editSessionDirty]);
    const isDirty = logoSessionDirty || documentIsDirty;
    const toolInputBlockedByEdit = (
        activeDashboardTool !== 'none'
        && activeDashboardTool !== 'sticker'
        && (editBarrierPending || editSessionDirty)
    );

    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    useEffect(() => {
        // Save thành công là biên duy nhất được xóa cờ dirty phục hồi. pastStack rỗng
        // sau hydrate không được làm tab recovery tự nhận là đã lưu.
        if (isSaved && restoredHistoryDirtyFile) setRestoredHistoryDirtyFile(null);
    }, [isSaved, restoredHistoryDirtyFile]);

    // ── AUTOSAVE / CRASH RECOVERY (phương án A: metadata + path gốc) ──────────────
    // Khi tab đang-sửa VÀ file có đường dẫn trên đĩa → ghi snapshot (debounce 8s) ra
    // %APPDATA%\PrynX\recovery\. Crash/cúp điện → snapshot còn sót → App hỏi khôi phục
    // lúc mở lại. Hết dirty (đã lưu) → xóa snapshot. Snapshot chứa fingerprint +
    // revision trang/VDP; KHÔNG lưu bytes PDF hay edit-object chỉ nằm trong RAM.
    useEffect(() => {
        if (documentWindow?.disableRecovery) return;
        if (!tabId) return;
        const fpath = (file as WorkspaceFileLike)?.path as string | undefined;
        // Bỏ qua snapshot khi path là file phù du (uploads/results/temp): file này bị
        // dọn sau 26h → khôi phục sẽ trỏ vào path đã biến mất. Chờ tới khi lưu ra vị
        // trí thật (fpath ổn định) mới snapshot.
        if (
            !documentIsDirty
            || editSessionDirty
            || !fpath
            || isEphemeralBackendPath(fpath)
        ) {
            void deleteSnapshot(tabId);
            return;
        }
        let cancelled = false;
        const snapTimer = setTimeout(() => {
            void (async () => {
                const sourceFingerprint = await readRecoverySourceFingerprint(fpath);
                if (cancelled) return;
                if (!sourceFingerprint) {
                    await deleteSnapshot(tabId);
                    return;
                }
                await writeSnapshot({
                    v: 2,
                    tabId,
                    title: originalFileName || file?.name || t('tabs.imposition:tai_lieu'),
                    savedAt: new Date().toISOString(),
                    originalPath: fpath,
                    originalName: file?.name || originalFileName || 'document.pdf',
                    sourceFingerprint,
                    dirty: true,
                    pendingObjectEdits: false,
                    feature: activeDashboardTool !== 'none' ? activeDashboardTool : undefined,
                    lockedMode: lockedMode && activeDashboardTool === lockedMode ? lockedMode : undefined,
                    viewerPageOrder: viewerPageOrder || undefined,
                    viewerPageInstanceIds: viewerPageInstanceIds || undefined,
                    viewerPageRotations: viewerPageRotations || undefined,
                    vdpFields: (vdpFields && vdpFields.length) ? vdpFields : undefined,
                });
            })();
        }, 8000);
        return () => {
            cancelled = true;
            clearTimeout(snapTimer);
        };
    }, [tabId, documentIsDirty, editSessionDirty, file, originalFileName,
        viewerPageOrder, viewerPageInstanceIds, viewerPageRotations, vdpFields,
        activeDashboardTool, lockedMode, t, documentWindow?.disableRecovery]);

    // VDP không phụ thuộc loader; revision trang đi riêng qua pendingHistoryEntry.
    useEffect(() => {
        if (!initialRecovery) return;
        if (initialRecovery.vdpFields) setVdpFields(initialRecovery.vdpFields);
        setIsSaved(false);  // khôi phục = trạng thái ĐANG-SỬA
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Warn before closing the entire browser tab if there are unsaved changes
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [isDirty]);

    // Undo/Redo riêng cho chế độ chỉnh sửa đối tượng (Ctrl+Z + nút Undo).
    const editHistory = useObjectEditHistory();

    const artifactLeaseOwnerRef = useRef<ArtifactLeaseOwner | null>(null);
    const artifactLeaseDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const artifactLeaseTokens = useMemo(() => collectArtifactLeaseTokens([
        file,
        ...history.map(entry => entry.file),
        ...objectEditPast.map(entry => entry.file),
        ...objectEditFuture.map(entry => entry.file),
    ]), [file, history, objectEditPast, objectEditFuture]);
    const artifactLeaseTokensRef = useRef(artifactLeaseTokens);
    artifactLeaseTokensRef.current = artifactLeaseTokens;

    useEffect(() => {
        // tabId là identity bất biến của component. Cleanup được hoãn một macrotask:
        // React StrictMode setup→cleanup→setup sẽ hủy lượt dispose giả và tái dùng
        // owner đang claim, tránh khe release-trước-claim làm marker bị thu hồi.
        if (artifactLeaseDisposeTimerRef.current) {
            clearTimeout(artifactLeaseDisposeTimerRef.current);
            artifactLeaseDisposeTimerRef.current = null;
        }
        const owner = artifactLeaseOwnerRef.current
            ?? new ArtifactLeaseOwner(recipeOwnerTabId, {
                onLeaseLost: () => setError(t(
                    'tabs.imposition:artifact_lam_viec_da_het_han',
                    {
                        defaultValue: 'File làm việc tạm đã hết hạn. Hãy chạy lại công cụ để tạo kết quả mới trước khi tiếp tục.',
                    },
                )),
            });
        artifactLeaseOwnerRef.current = owner;
        void owner.sync(artifactLeaseTokensRef.current).catch(() => {
            // Owner tự retry; lỗi mạng tạm thời không được tạo unhandled rejection.
        });
        return () => {
            artifactLeaseDisposeTimerRef.current = setTimeout(() => {
                artifactLeaseDisposeTimerRef.current = null;
                if (artifactLeaseOwnerRef.current !== owner) return;
                artifactLeaseOwnerRef.current = null;
                void owner.dispose();
            }, 0);
        };
    }, [recipeOwnerTabId, setError, t]);

    useEffect(() => {
        const owner = artifactLeaseOwnerRef.current;
        if (!owner) return;
        void owner.sync(artifactLeaseTokens).catch(() => {
            // Owner tự retry với desired mới nhất.
        });
    }, [artifactLeaseTokens]);

    const commitWorkingFile = useCallback(async (
        newBlob: Blob,
        newName: string,
        existingPath?: string,
        recipeTicket?: RecipeOperationTicket | null,
        expectedDocumentRevision?: WorkspaceDocumentRevisionToken | null,
    ) => {
        // Chụp vé trước MỌI await. Chỉ caller đã noteOperation và giữ đúng ticket mới
        // được ghi Step; undefined/null đều là cấm ghi. Không suy đoán pending tại commit.
        const capturedRecipeTicket = recipeTicket ?? null;
        const assertRecipeCommitAllowed = () => {
            if (recipeRecorder.canCommitWorkingFile(recipeOwnerTabId, capturedRecipeTicket)) return;
            throw new Error(t('tabs.imposition:ket_qua_khong_thuoc_luot_ghi_hien_tai'));
        };
        const assertDocumentRevisionCurrent = () => {
            if (
                !expectedDocumentRevision
                || isWorkspaceDocumentRevisionCurrent(expectedDocumentRevision, store.getState())
            ) return;
            throw new StaleWorkspaceDocumentRevisionError(t(
                'tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly',
                {
                    defaultValue: 'Tài liệu đã thay đổi trong lúc xử lý. Kết quả cũ đã được bỏ qua; vui lòng chạy lại.',
                },
            ));
        };
        // RECIPE (audit 2026-08-15 §REC.RACE): chặn ngay callback không mang vé và
        // kết quả cũ về sau khi người dùng đã dừng/hủy phiên ghi.
        assertRecipeCommitAllowed();
        // REVISION (audit 2026-08-25 §REV.03): chặn trước mọi I/O tốn thời gian.
        assertDocumentRevisionCurrent();
        let committedBlob = newBlob;
        let committedName = newName;
        let committedPath = existingPath;
        let nextSourceImage: File | null = null;

        if (newBlob.type.startsWith('image/') || isSupportedImageFileName(newName)) {
            // UIUX (feedback 2026-08-10 §UP.WORKING.1): giữ ảnh AI làm nguồn thật
            // cho công cụ kế tiếp, đồng thời tạo PDF một trang cho viewer dùng chung.
            nextSourceImage = new File([newBlob], newName, {
                type: newBlob.type || 'application/octet-stream',
            });
            // UIUX (audit 2026-08-11 §UP.X.01): giữ token owner khi Blob Upscale
            // được bọc thành File để Undo riêng đối chiếu chính xác item đã commit.
            copyUpscaleResultIdentity(newBlob, nextSourceImage);
            copyDocumentCleanupResultIdentity(newBlob, nextSourceImage);
            const companionPdfPath = (
                (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
                && existingPath?.toLowerCase().endsWith('.pdf')
            ) ? existingPath : undefined;
            if (companionPdfPath) {
                // Backend đã bọc luồng PNG thành PDF bằng native, không decode lại
                // bitmap khổng lồ trên WebView. Blob ảnh vẫn được giữ làm nguồn AI.
                committedBlob = new Blob([], { type: 'application/pdf' });
                committedName = newName.replace(/\.(?:jpe?g|png|webp|bmp|tiff?)$/i, '.pdf');
                committedPath = companionPdfPath;
            } else {
                const sourceImagePath = existingPath?.toLowerCase().endsWith('.pdf')
                    ? undefined
                    : existingPath;
                if (sourceImagePath) {
                    Object.defineProperty(nextSourceImage, 'path', {
                        value: sourceImagePath,
                        configurable: true,
                    });
                }
                const normalizedPdf = await imageFileToPdfIfNeeded(nextSourceImage, getFileArrayBuffer);
                committedBlob = normalizedPdf;
                committedName = normalizedPdf.name;
                // Đường dẫn cũ là file ảnh, không được giao nhầm cho PDFium như PDF.
                committedPath = undefined;
            }
        }

        // Use newName to correctly reflect the current file's processing state
        const displayName = committedName;
        const newFile = new File([committedBlob], displayName, { type: 'application/pdf' });
        copyArtifactLeaseToken(newBlob, newFile);
        markGeneratedWorkspaceFile(newFile);
        
        try {
            if ((window as RuntimeWindow).__TAURI_INTERNALS__) {
                let tempPath = '';
                // VDP/job kết quả: backend đã ghi file thật ra đĩa và trả về đường dẫn
                // (newBlob lúc này chỉ là blob "dummy" để skip download). Dùng thẳng
                // path thật → tile native render đúng, KHÔNG ghi đè bằng blob rỗng.
                if (committedPath) {
                    tempPath = committedPath;
                    try {
                        const { stat } = await import('@tauri-apps/plugin-fs');
                        const info = await stat(committedPath);
                        Object.defineProperty(newFile, 'size', { value: Number((info as { size?: number }).size || 0) });
                    } catch {
                        // Native rendering only requires the path; size is display metadata.
                    }
                } else {
                    try {
                        const { uploadFileForNup } = await import('../lib/api');
                        tempPath = await uploadFileForNup(newFile);
                    } catch {
                        console.warn("HTTP upload failed for fix pdf, falling back to IPC");
                        const { tempDir, join } = await import('@tauri-apps/api/path');
                        const { writeFile } = await import('@tauri-apps/plugin-fs');
                        const buffer = await committedBlob.arrayBuffer();
                        const tDir = await tempDir();
                        tempPath = await join(tDir, `prynx_tmp_${Date.now()}_${newName}`);
                        await writeFile(tempPath, new Uint8Array(buffer));
                    }
                }
                
                if (tempPath) {
                    Object.defineProperty(newFile, 'path', { value: tempPath });
                }
            }
        } catch (e) {
            console.warn('Failed to write temp file for PDFium', e);
        }

        // Không có await từ lần kiểm tra cuối tới khi publish state: Dừng/Hủy không
        // thể chen giữa rồi để callback cũ thay working file của phiên mới.
        assertRecipeCommitAllowed();
        // REVISION (audit 2026-08-25 §REV.03): kiểm lại ngay sát publish; xoay,
        // xóa, reorder hoặc edit trong lúc ghi temp không được bị kết quả cũ ghi đè.
        assertDocumentRevisionCurrent();
        // RECIPE (audit 2026-08-17 §REC.5): số Step trong draft TRƯỚC khi commit này
        // ghi thêm Step. Gắn vào entry history để Undo (về đúng revision trước) rút lại
        // Step tương ứng — recipe lưu ra không còn chứa thao tác người dùng đã hoàn tác.
        const recipeDraftLenBefore = recipeRecorder.isRecordingFor(recipeOwnerTabId)
            ? recipeRecorder.draftSteps.length
            : null;
        if (file) {
            // Cắt bớt entry cũ nhất khi vượt ngưỡng → chặn leak RAM (audit 2026-07-06).
            setHistory(prev => {
                // Strip bytes khi file có path đĩa → entry undo chỉ giữ tên+path (đọc lại
                // qua getFileArrayBuffer khi cần), chặn leak RAM (audit 2026-07-06). File
                // không path → giữ nguyên bytes (fallback). handleUndo đã xử lý cả 2 nhánh.
                const next = [...prev, createWorkspaceHistoryEntry({
                    file,
                    pageOrder: viewerPageOrder,
                    pageInstanceIds: viewerPageInstanceIds,
                    pageRotations: viewerPageRotations,
                    pageRevisionDirty: viewerDirty,
                    sourceImageFile,
                    stickerSourceFile: stickerSheetSourceVisible ? stickerSheetSourceFile : null,
                    recipeDraftLen: recipeDraftLenBefore,
                })];
                return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
            });
        }
        // UIUX (feedback 2026-08-11 §AI.SPLIT1): PDF tạo xong phải ở lại Viewer.
        // Nếu marker về null, effect đồng bộ nguồn sẽ mở lại nguyên tấm ngay khi
        // khối export hạ xuống, làm kết quả 9 trang trở về 1/1.
        syncedStickerSourceRef.current = resolveStickerSourceSyncMarker(
            stickerSheetSourceFile,
            nextSourceImage,
            activeDashboardTool === 'sticker' && stickerSheetMode === 'ai-sheet',
        );
        setSourceImageFile(nextSourceImage);
        setSourceImageOwner(nextSourceImage
            ? createSourceImageRevisionOwner(newFile, store.getState().editGeneration)
            : null);
        setOriginalFileName(committedName);
        setFile(newFile);
        if (pdfUrl && !pdfUrl.startsWith('https://')) URL.revokeObjectURL(pdfUrl);
        setPdfUrl(URL.createObjectURL(committedBlob));
        setFileSizeStr((newFile.size / (1024 * 1024)).toFixed(2) + ' MB');
        setIsSaved(false);
        onTitleChange?.(displayName);

        // ─── Recipe record hook ───
        // Ghép thao tác đã "công bố" (noteOperation) với commit này thành 1 Step.
        // No-op khi không ghi. Extras (page order) đã chụp tại noteOperation.
        recipeRecorder.noteCommit(capturedRecipeTicket);

        detectColorSpace(newFile).then(cs => {
            if (cs) onTitleChange?.(`${displayName} (${cs})`);
        });

        // Cleanup visual edits because they are now baked into the file
        setViewerPageOrder(undefined);
        setViewerPageInstanceIds(undefined);
        setViewerPageRotations(undefined);
        setHighlightedIssue(null);
        setViewerDirty(false); // Clear any preflight highlights
        setSelectionFileId(''); // Reset fid � object edit re-uploads on demand
        setHiddenObjectIds([]);
        setLockedObjectIds([]);
    }, [
        activeDashboardTool,
        file,
        onTitleChange,
        pdfUrl,
        recipeOwnerTabId,
        setFile,
        setFileSizeStr,
        setHiddenObjectIds,
        setHighlightedIssue,
        setHistory,
        setIsSaved,
        setLockedObjectIds,
        setOriginalFileName,
        setPdfUrl,
        setSelectionFileId,
        setViewerDirty,
        setViewerPageOrder,
        setViewerPageInstanceIds,
        setViewerPageRotations,
        sourceImageFile,
        store,
        stickerSheetMode,
        stickerSheetSourceFile,
        stickerSheetSourceVisible,
        t,
        viewerDirty,
        viewerPageInstanceIds,
        viewerPageOrder,
        viewerPageRotations,
    ]);

    /**
     * RECIPE (audit 2026-08-16 §REC.4): cửa commit cho MỌI tool truyền qua
     * `onFileFixed`. Tool đã nối hợp đồng ghi thì đi kèm vé và chạy như cũ; tool
     * chưa nối mà tab đang ghi thì bị CHẶN kèm lý do, không được âm thầm không
     * làm gì rồi vẫn bật cờ thành công (những tool này gọi `onFileFixed` không
     * await nên exception của `commitWorkingFile` không tới được try/catch của họ).
     */
    const commitToolWorkingFile = useCallback(async (
        newBlob: Blob,
        newName: string,
        existingPath?: string,
        recipeTicket?: RecipeOperationTicket | null,
    ): Promise<boolean> => {
        // RECIPE (audit 2026-08-17 §REC.4R): trả kết quả để tool biết commit CÓ xảy ra
        // hay bị chặn. Trước đây trả Promise<void> đã resolve nên tool hiểu "bị chặn"
        // là "đã thành công" và vẫn bật cờ thành công. `false` = đã chặn, chưa commit.
        if (shouldBlockUnrecordedCommit(recipeOwnerTabId, recipeTicket)) {
            toast.info(t('tabs.imposition:thao_tac_chua_ghi_duoc_vao_quy_trinh'));
            return false;
        }
        try {
            await commitWorkingFile(
                newBlob,
                newName,
                existingPath,
                recipeTicket ?? null,
                renderedDocumentRevision,
            );
            return true;
        } catch (error) {
            if (error instanceof StaleWorkspaceDocumentRevisionError) {
                recipeRecorder.discardPending(recipeTicket);
                toast.info(error.message);
                return false;
            }
            throw error;
        }
    }, [commitWorkingFile, recipeOwnerTabId, renderedDocumentRevision, t]);
    const cropUploadCache = useMemo(() => createRevisionScopedPdfUploadCache({
        resolver: getCropWorkingFile,
        upload: uploadPDF,
        missingFileError: () => new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho')),
    }), [getCropWorkingFile, t]);
    const lastCropRevisionRef = useRef(renderedDocumentRevision);
    useEffect(() => {
        // REVISION: Chỉ invalidate khi revision trong workspace thực sự thay đổi khác với revision trước
        if (!isWorkspaceDocumentRevisionCurrent(lastCropRevisionRef.current, store.getState())) {
            lastCropRevisionRef.current = renderedDocumentRevision;
            cropUploadCache.invalidate();
        }
    }, [cropUploadCache, renderedDocumentRevision, store]);
    useEffect(() => () => cropUploadCache.dispose(), [cropUploadCache]);
    const ensureCropFileId = useCallback(
        (signal?: AbortSignal) => cropUploadCache.ensure(signal),
        [cropUploadCache],
    );
    const getPreparedWorkingFile = useCallback(async (): Promise<File> => {
        // REVISION (audit 2026-08-25 §REV.06): execution ảnh chờ Edit barrier,
        // materialize đúng snapshot rồi CAS trước khi raster/inference. Preview
        // vẫn dùng `getWorkingFile` legacy để không tự commit Edit trong nền.
        await getCropWorkingFile.prepare();
        const snapshot = getCropWorkingFile.capture();
        if (!snapshot) throw new Error('Không tìm thấy PDF làm việc hiện tại.');
        const workingFile = await getCropWorkingFile.materialize(snapshot);
        if (!getCropWorkingFile.isCurrent(snapshot)) {
            throw new StaleWorkspaceDocumentRevisionError(
                t('tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly'),
            );
        }
        return workingFile;
    }, [getCropWorkingFile, t]);

    const handleCropApplied = useCallback(async (blob: Blob, filename: string, openInNewTab: boolean) => {
        // RECIPE (audit 2026-08-16 §REC.4): Cắt khổ theo toạ độ không phát lại được.
        // Chặn TRƯỚC khi dọn selection để người dùng giữ nguyên vùng vừa vẽ.
        if (!openInNewTab && shouldBlockUnrecordedCommit(recipeOwnerTabId)) {
            toast.info(t('tabs.imposition:thao_tac_chua_ghi_duoc_vao_quy_trinh'));
            return;
        }
        if (openInNewTab && onSpawnTab) {
            const resultFile = new File([blob], filename, { type: 'application/pdf' });
            onSpawnTab(markGeneratedWorkspaceFile(resultFile));
        } else {
            await commitToolWorkingFile(blob, filename);
            setViewerPageInstanceIds(undefined);
        }

        commitCropSelection(null);
        setIsCropMode(false);
        setActiveDashboardTool('none');
    }, [onSpawnTab, commitToolWorkingFile, recipeOwnerTabId, t, setViewerPageInstanceIds, commitCropSelection, setIsCropMode, setActiveDashboardTool]);

    const handleCropClose = useCallback(() => {
        setIsCropMode(false);
        setActiveDashboardTool('none');
    }, [setIsCropMode, setActiveDashboardTool]);

    const closeActiveToolPanel = useCallback(() => {
        const next = resolveWorkspaceToolPanelClose(
            activeDashboardTool,
            toolMenuMode,
            isCropMode,
            isObjectEditMode,
        );
        if (dedicatedInitialTool) suppressDedicatedToolRestoreRef.current = true;
        if (next.closeCrop) {
            commitCropSelection(null);
            setIsCropMode(false);
        }
        if (next.closeObjectEdit) setIsObjectEditMode(false);
        setActiveDashboardTool(next.activeTool);
    }, [
        activeDashboardTool,
        commitCropSelection,
        dedicatedInitialTool,
        isCropMode,
        isObjectEditMode,
        setActiveDashboardTool,
        setIsCropMode,
        setIsObjectEditMode,
        toolMenuMode,
    ]);


    // --- OBJECT EDIT UPLOAD ---
    const uploadPromiseRef = useRef<Promise<{ id: string }> | null>(null);
    const pdfObjectsCacheRef = useRef<ReturnType<typeof globalPdfObjectCache.getAllObjects>>({});

    // Keep cache ref in sync
    useEffect(() => { pdfObjectsCacheRef.current = globalPdfObjectCache.getAllObjects(pdfUrl || ''); }, [pdfObjectsVersion, pdfUrl]);

    // ── Object Edit Mode CẦN selectionFileId (để gọi /edit/objects, /edit/text…) ──
    // Pre-upload có thể BỊ BỎ QUA (file > 20MB) hoặc chưa kịp/đã lỗi, và on-demand
    // upload cũ CHỈ chạy cho Selection Tool. Hệ quả: bật chế độ Chỉnh sửa đối tượng
    // với file lớn → fid rỗng → /edit/objects không chạy → không có đối tượng để
    // chọn/sửa. Effect này đảm bảo upload (tái dùng uploadPromiseRef tránh trùng)
    // và set selectionFileId ngay khi vào edit mode mà chưa có fid.
    useEffect(() => {
        if (!isObjectEditMode || !file || selectionFileId) return;
        if (!file.name.toLowerCase().endsWith('.pdf')) return;
        let cancelled = false;
        (async () => {
            try {
                if (!uploadPromiseRef.current) {
                    uploadPromiseRef.current = uploadPDF(file).finally(() => { uploadPromiseRef.current = null; });
                }
                const res = await uploadPromiseRef.current;
                if (!cancelled && res?.id) store!.getState().setSelectionFileId(res.id);
            } catch { /* sẽ thử lại khi bật lại edit mode */ }
        })();
        return () => { cancelled = true; };
    }, [isObjectEditMode, file, selectionFileId, store]);

    const fetchPdfObjectsForPage = useCallback(async (pageNum: number) => {
        const state = store!.getState();
        // Updated: support object edit mode with accurate /edit/objects (PDFium)
        // Old preflight objects deprecated for component display
        if (!file || !state.isObjectEditMode) return;
        if (pdfObjectsCacheRef.current[pageNum]) return; // Already fetched

        try {
            // Prefer edit fid if available (more accurate, session aware)
            let fid = state.selectionFileId || '';
            const useEdit = state.isObjectEditMode;

            if (!fid) {
                if (!uploadPromiseRef.current) {
                    uploadPromiseRef.current = uploadPDF(file).finally(() => {
                        uploadPromiseRef.current = null;
                    });
                }
                const result = await uploadPromiseRef.current;
                fid = result.id;
                store!.getState().setSelectionFileId(result.id);
            }

            // Use modern edit endpoint for better accuracy (replaces old pdfplumber preflight)
            const endpoint = useEdit 
                ? `${getApiUrl()}/edit/objects/${fid}/${pageNum - 1}` 
                : `${getApiUrl()}/preflight/objects/${fid}/${pageNum}`;

            const res = await authenticatedFetch(endpoint);
            if (!res.ok) throw new Error(t('tabs.imposition:khong_the_tai_danh_sach_objects'));

            const data = await res.json();
            const objects = data.objects || data; // edit returns {objects, pageBox}, preflight {objects}

            const currentPdfUrl = store!.getState().pdfUrl || '';
            globalPdfObjectCache.setPageObjects(currentPdfUrl, pageNum, Array.isArray(objects) ? objects : objects.objects || []);
            setPdfObjectsVersion(prev => prev + 1);


        } catch (err: unknown) {
            setError(errorMessage(err) || t('tabs.imposition:loi_tai_object_trang_n', { n: pageNum }));
        }
    }, [file, setError, setPdfObjectsVersion, store, t]);

    // Load OCG layers independently from the object cache. A previous PDF can leave
    // virtual layers in the store, so checking only pdfOcgLayers.length is not safe.
    useEffect(() => {
        let cancelled = false;
        const sourceFile = file;
        const sourceEditGeneration = editGeneration;

        const handleRefreshLayers = async (event?: Event) => {
            if (event && (event as CustomEvent).detail?.tabId !== tabId) return;
            const fid = selectionFileId;
            if (!fid || !sourceFile) {
                const current = store.getState();
                if (
                    current.file === sourceFile
                    && current.editGeneration === sourceEditGeneration
                    && current.selectionFileId === ''
                ) {
                    setPdfOcgLayers([]);
                    setLockedOcgLayerIds([]);
                }
                // Chưa đọc `/D` thì không được bịa baseline rỗng: explicit `[]`
                // phát sinh trước response vẫn phải được materialize.
                return;
            }
            try {
                const layerRes = await authenticatedFetch(`${getApiUrl()}/preflight/layers/${fid}?original_only=true`);
                if (!layerRes.ok) return;
                const layerData = await layerRes.json();
                if (cancelled) return;
                const layers = layerData.layers || [];
                const hidden: number[] = [];
                const locked: number[] = [];
                const walk = (items: PdfLayer[]) => items.forEach((layer: PdfLayer) => {
                    if (layer.visible === false) hidden.push(layer.id);
                    if (layer.locked === true) locked.push(layer.id);
                    if (Array.isArray(layer.children)) walk(layer.children);
                });
                walk(layers);
                // FIX/PARITY (audit 2026-08-29 §MAP-NEST-10): publish cây,
                // baseline `/D` và lock trong một transaction đã fence bằng cả
                // File + edit generation + backend file ID.
                seedOcgLayerState(
                    layers,
                    hidden,
                    locked,
                    sourceFile,
                    sourceEditGeneration,
                    fid,
                );
            } catch (e) {
                if (!cancelled) console.warn("Failed to refresh OCG layers", e);
            }
        };

        // Initial load for every new working file; do not wait for an edit action.
        void handleRefreshLayers();
        window.addEventListener('refresh-ocg-layers', handleRefreshLayers);
        return () => {
            cancelled = true;
            window.removeEventListener('refresh-ocg-layers', handleRefreshLayers);
        };
    }, [
        editGeneration,
        file,
        seedOcgLayerState,
        selectionFileId,
        setLockedOcgLayerIds,
        setPdfOcgLayers,
        tabId,
    ]);

    // Auto-update workspace template whenever a VDP text object is picked/cleaned
    useEffect(() => {
        const handleTemplateCleaned = async (event: Event) => {
            const detail = (event as CustomEvent)?.detail;
            if (!detail?.workingPdfUrl) return;
            try {
                const apiBase = getApiUrl().replace(/\/api\/?$/, '');
                const url = detail.workingPdfUrl.startsWith('http')
                    ? detail.workingPdfUrl
                    : `${apiBase}${detail.workingPdfUrl.startsWith('/') ? '' : '/'}${detail.workingPdfUrl}`;
                const res = await authenticatedFetch(url);
                if (!res.ok) return;
                const blob = await res.blob();
                const originalName = file?.name || 'template.pdf';
                const currentVdp = store.getState().vdpFields;
                const currentSelected = store.getState().selectedVdpFieldIds;
                await commitWorkingFile(blob, originalName, detail.workingPdfPath, null, null);
                // Preserve VDP fields & selected field on the clean template
                store.getState().setVdpFields(currentVdp);
                store.getState().setSelectedVdpFieldIds(currentSelected);
                const nextFileId = detail.workingPdfPath || detail.workingFid;
                if (nextFileId) {
                    store.getState().setSelectionFileId(nextFileId);
                }
            } catch (err) {
                console.warn('Failed to commit cleaned VDP template:', err);
            }
        };
        window.addEventListener('vdp-template-cleaned', handleTemplateCleaned);
        return () => {
            window.removeEventListener('vdp-template-cleaned', handleTemplateCleaned);
        };
    }, [commitWorkingFile, file]);


    const handleDeleteObjects = useCallback(async (objs: PdfObject[], pageNum: number) => {
        if (!selectionFileId) {
            setError(t('tabs.imposition:loi_khong_tim_thay_selectionfileid_co'));
            return;
        }
        if (objs.length === 0) {
            setError(t('tabs.imposition:loi_chua_co_object_nao_duoc_chon'));
            return;
        }
        // RECIPE (audit 2026-08-16 §REC.4): xóa đối tượng theo bbox/xref là thao tác
        // gắn với đúng file này. Chặn ngay đầu vào để không upload/xử lý vô ích.
        if (shouldBlockUnrecordedCommit(recipeOwnerTabId)) {
            setError(t('tabs.imposition:thao_tac_chua_ghi_duoc_vao_quy_trinh'));
            return;
        }

        // alert(`Bắt đầu xóa ${objs.length} object trên trang ${pageNum}...`);
        setIsProcessing(true);
        setProcessStatus(t('tabs.imposition:dang_xoa_doi_tuong'));
        setError('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/delete-object`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: selectionFileId,
                    page: pageNum,
                    objects: objs.map(obj => ({
                        type: obj.type,
                        bbox: obj.bbox,
                        xref: obj.xref
                    }))
                })
            });
            if (!res.ok) throw new Error(t('tabs.imposition:xoa_that_bai'));
            const data = await res.json();

            if (data.success && data.output_filename) {
                const pdfRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
                if (pdfRes.ok) {
                    const blob = await pdfRes.blob();
                    await commitToolWorkingFile(blob, data.output_filename);
                } else {
                    setError(t('tabs.imposition:loi_tai_file_moi'));
                }
            } else {
                setError(t('tabs.imposition:api_tra_ve_thanh_cong_nhung_thieu_du'));
            }
        } catch (err: unknown) {
            setError(errorMessage(err) || t('tabs.imposition:loi_xoa_doi_tuong'));
        } finally {
            setIsProcessing(false);
        }
    }, [selectionFileId, commitToolWorkingFile, recipeOwnerTabId, setError, setIsProcessing, setProcessStatus, t]);

    // ─── Edit PDF Object: ĐƯỜNG COMMIT NHẸ cho thao tác chỉnh sửa đối tượng ──────
    // Tối ưu TỐC ĐỘ: backend /edit/* đã tạo Working_File MỘT lần (pikepdf, color-safe)
    // + đăng ký vào DB → trả `output_fid` (id trỏ thẳng Working_File mới) cùng
    // `output_path` (đường dẫn tuyệt đối trên CÙNG MÁY — đây là desktop app).
    //
    // KHÁC commitWorkingFile (đường nặng cho các tool khác): KHÔNG tải-về-rồi-upload-lại
    // (uploadFileForNup/uploadPDF), KHÔNG re-upload (không reset selectionFileId=''),
    // KHÔNG detectColorSpace mỗi op. Chỉ:
    //   - đẩy file hiện tại vào history (Undo hoạt động — Yêu cầu 11.1–11.3),
    //   - trỏ file/pdfUrl sang Working_File mới (desktop: dùng output_path trực tiếp),
    //   - setSelectionFileId(output_fid) TRỰC TIẾP → op kế tiếp + effect /edit/objects
    //     dùng fid mới (cache key `${selectionFileId}:${page}` đổi ⇒ refetch đúng file).
    // RECIPE (audit 2026-08-17 §REC.11R): chụp PHIÊN GHI đang hoạt động tại thời
    // điểm BẮT ĐẦU sửa đối tượng (op đầu làm session dirty). Step chỉ được gán khi
    // phiên ghi lúc commit-on-exit vẫn đúng phiên này → không gán nhầm cho thao tác
    // xảy ra trước khi bật Ghi, cũng không thêm Step vào phiên đã Dừng giữa chừng.
    const objectEditRecordingRef = useRef<{ sessionId: number } | null>(null);

    const handleEditCommit = useCallback(async (
        outputUrl: string,
        outputFilename: string,
        outputFid?: string,
        outputPath?: string,
        artifactLease?: string,
    ) => {
        if (!outputUrl) return;
        const displayName = outputFilename || `Edited_${file?.name || 'document.pdf'}`;
        const isTauri = !!(window as RuntimeWindow).__TAURI_INTERNALS__;
        const prevPdfUrl = pdfUrl;

        // RECIPE (audit 2026-08-16 §REC.11 + 2026-08-17 §REC.11A/R): đường commit nhẹ
        // này thay working file mà KHÔNG qua commitWorkingFile. Sửa đối tượng theo toạ
        // độ không phát lại được nên ghi một Step recordable=false — NHƯNG chỉ khi phiên
        // ghi hiện tại ĐÚNG là phiên đã hoạt động lúc bắt đầu sửa. Không chặn commit vì
        // op đã nằm trong RAM phiên; chặn sẽ mất việc của người dùng.
        const editRecording = objectEditRecordingRef.current;
        const sameRecordingSession = !!editRecording
            && recipeRecorder.isRecordingFor(recipeOwnerTabId)
            && recipeRecorder.state.sessionId === editRecording.sessionId;
        let recipeTicket: RecipeOperationTicket | null = sameRecordingSession
            ? recipeRecorder.noteNonRecordable('object_edit', undefined, recipeOwnerTabId)
            : null;

        try {
            let newFile: File;
            let newPdfUrl: string;
            let sizeStr: string | null = null;

            if (isTauri && outputPath) {
                // DESKTOP: Working_File nằm trên cùng máy → dùng TRỰC TIẾP, không tải/upload.
                // File rỗng/nhẹ chỉ mang tên + path; PDFium render qua `path`, react-pdf qua pdfUrl.
                newFile = new File([], displayName, { type: 'application/pdf' });
                Object.defineProperty(newFile, 'path', { value: outputPath });
                newPdfUrl = localFileUrl(outputPath);
                // Kích thước file: stat cục bộ (rẻ); lỗi thì bỏ qua, giữ size cũ.
                try {
                    const { stat } = await import('@tauri-apps/plugin-fs');
                    const info = await stat(outputPath);
                    if (info?.size != null) sizeStr = (info.size / (1024 * 1024)).toFixed(2) + ' MB';
                } catch { /* giữ fileSizeStr hiện tại */ }
            } else {
                // WEB fallback: tải blob về rồi createObjectURL (chậm hơn — desktop là chính).
                const base = getApiUrl().replace(/\/api\/?$/, '');
                const fullUrl = outputUrl.startsWith('http') ? outputUrl : `${base}${outputUrl}`;
                const res = await authenticatedFetch(fullUrl);
                if (!res.ok) throw new Error(t('tabs.imposition:tai_working_file_moi_that_bai_http', { status: res.status }));
                const blob = await res.blob();
                newFile = new File([blob], displayName, { type: 'application/pdf' });
                newPdfUrl = URL.createObjectURL(blob);
                sizeStr = (blob.size / (1024 * 1024)).toFixed(2) + ' MB';
            }

            // Đánh dấu File này là "edit-commit": cấu trúc trang KHÔNG đổi (chỉ nội
            // dung backing file). Các effect tải PDF/zoom/thumbnail đọc cờ này để BỎ
            // QUA reset hủy diệt (numPages=0 → unmount, reset scroll/zoom/selection),
            // nhờ đó giao diện KHÔNG "reload" sau mỗi thao tác — chỉ tile + overlay đổi.
            try { Object.defineProperty(newFile, '__editCommit', { value: true, configurable: true }); } catch { /* noop */ }
            tagArtifactLeaseToken(newFile, artifactLease);
            markGeneratedWorkspaceFile(newFile);

            // RECIPE (audit 2026-08-17 §REC.11A): kiểm lại vé NGAY TRƯỚC khi publish.
            // stat/fetch ở trên có await; nếu người dùng Dừng/Hủy phiên ghi trong lúc
            // chờ, vé đã hết hiệu lực → không gán Step (nhưng vẫn cập nhật working file).
            if (recipeTicket && !recipeRecorder.canCommitWorkingFile(recipeOwnerTabId, recipeTicket)) {
                recipeRecorder.discardPending(recipeTicket);
                recipeTicket = null;
            }

            // REVISION (audit 2026-08-25 §REV.01): chỉ thêm Undo khi mọi I/O đã
            // thành công và ngay sát publish; retry sau lỗi không tạo snapshot rác.
            editHistory.pushSnapshot({ file, pdfUrl: prevPdfUrl, fid: selectionFileId });
            setFile(newFile);
            setOriginalFileName(displayName);
            setPdfUrl(newPdfUrl);
            if (sizeStr) setFileSizeStr(sizeStr);
            setIsSaved(false);
            onTitleChange?.(displayName);

            // Trỏ selectionFileId thẳng tới Working_File mới (KHÔNG '' để tránh re-upload).
            // → thao tác edit kế tiếp + effect /edit/objects dùng fid mới ngay.
            if (outputFid) setSelectionFileId(outputFid);

            // Dọn pdfUrl cũ (chỉ revoke nếu là blob — localfile/https là no-op không cần).
            if (prevPdfUrl && prevPdfUrl.startsWith('blob:') && prevPdfUrl !== newPdfUrl) {
                URL.revokeObjectURL(prevPdfUrl);
            }
            // Working file đã đổi xong → chốt Step "Sửa đối tượng" vào draft.
            recipeRecorder.noteCommit(recipeTicket);

            // LƯU Ý: KHÔNG reset viewerPageOrder/rotations (edit không đụng thứ tự trang)
            // và KHÔNG detectColorSpace (bỏ để giảm tải mỗi op) — khác commitWorkingFile.
        } catch (err: unknown) {
            // Không để note treo sang thao tác kế tiếp khi lượt commit này thất bại.
            recipeRecorder.discardPending(recipeTicket);
            setError(errorMessage(err) || t('tabs.imposition:loi_cap_nhat_sau_chinh_sua'));
            // REVISION (audit 2026-08-25 §REV.01): barrier phải biết publish thất
            // bại để giữ dirty/session và chặn công cụ kế tiếp đọc backing file cũ.
            throw err;
        }
    }, [file, pdfUrl, setFile, setOriginalFileName, setPdfUrl, setFileSizeStr,
        setIsSaved, onTitleChange, setSelectionFileId, setError, selectionFileId, editHistory,
        recipeOwnerTabId, t]);

    // Edit-session in-memory: áp op trong RAM backend + render vùng clip → dán overlay
    // tại chỗ (KHÔNG reload file mỗi op). Debounce-commit ngầm ~1.5s → onCommit đổi
    // pdfUrl sang tile thật MỘT lần (nền). Session lỗi/410 → BÁO LỖI, không fallback.
    const editSession = useEditSession({
        eventScopeId: tabId,
        // REVISION (audit 2026-08-25 §REV.03): mỗi op/undo/redo có generation
        // riêng; dirty=true không đủ vì thao tác thứ hai vẫn giữ cùng boolean.
        onEditRevisionStart: advanceEditGeneration,
        // RECIPE (audit 2026-08-17 §REC.11A): await để lifecycle commit-on-exit chờ
        // publish xong; recorder không bị Dừng/Hủy chen vào giữa lúc consumer đang chạy.
        onCommit: async (result) => {
            if (!result?.success || !result.output_url) {
                throw new Error(t(
                    'tabs.imposition:loi_cap_nhat_sau_chinh_sua',
                    { defaultValue: 'Không nhận được Working File sau khi chốt Edit PDF.' },
                ));
            }
            await handleEditCommit(
                result.output_url,
                result.output_filename || '',
                result.output_fid,
                result.output_path,
                result.artifact_lease,
            );
        },
        onSessionFailed: () => {
            setError(t('tabs.imposition:khong_mo_duoc_phien_chinh_sua_backend'));
        },
    });
    editSessionForToolRef.current = editSession;
    useEffect(() => {
        const barrier = ensureEditCommittedBeforeTool;
        store.getState().setDocumentPreparationBarrier(barrier);
        return () => {
            if (store.getState().documentPreparationBarrier === barrier) {
                store.getState().setDocumentPreparationBarrier(null);
            }
        };
    }, [ensureEditCommittedBeforeTool, store]);

    // UIUX/DATA (audit 2026-08-25 §NW.1): API này đọc trực tiếp store CỦA TAB.
    // App chỉ giữ facade ổn định theo tabId nên không thể vô tình nhân payload mở file cũ.
    const prepareDocumentWindowRef = useRef<() => Promise<import('../lib/documentWindow').PreparedDocumentWindow>>(
        async () => { throw new Error('Cửa sổ PDF chưa sẵn sàng.'); },
    );
    prepareDocumentWindowRef.current = async () => {
        if (!store) throw new Error('Không đọc được phiên tài liệu đang mở.');

        // Chụp viewport trước mọi await; commit edit có thể đổi backing file nhưng
        // không được làm cửa sổ mới nhảy sang trang/zoom khác.
        const beforeCommit = store.getState();
        if (!beforeCommit.file || beforeCommit.viewerNumPages <= 0) {
            throw new Error('Chưa có PDF để mở trong cửa sổ mới.');
        }
        const viewState: DocumentWindowViewState = {
            activePage: Math.max(1, beforeCommit.viewerActivePage),
            zoom: beforeCommit.viewerZoom,
            fitMode: beforeCommit.viewerFitMode,
            pageDisplayMode: beforeCommit.viewerPageDisplayMode,
        };

        if (editSession.dirty) {
            const result = await editSession.commit();
            if (!result?.success || !result.output_path) {
                throw new Error('Không thể hoàn tất phần chỉnh sửa đối tượng trước khi mở cửa sổ mới.');
            }
            const publishedPath = (store.getState().file as WorkspaceFileLike | null)?.path;
            const normalizePath = (value: string) => value.replaceAll('/', '\\').toLocaleLowerCase();
            if (!publishedPath || normalizePath(publishedPath) !== normalizePath(result.output_path)) {
                throw new Error('Bản PDF sau chỉnh sửa chưa được cập nhật vào phiên làm việc.');
            }
        }

        // Sau commit tuyệt đối không dùng closure `file`: callback onCommit đã publish
        // Working File mới vào store, còn closure có thể vẫn trỏ bản khách ban đầu.
        const freshFile = store.getState().file as File | null;
        if (!freshFile) throw new Error('Không đọc được PDF làm việc mới nhất.');
        const workingFile = await getCropWorkingFile(freshFile);
        if (!workingFile) throw new Error('Không thể tạo PDF theo thứ tự và góc xoay hiện tại.');

        return prepareDocumentWindowSource(
            workingFile,
            originalFileName || freshFile.name,
            viewState,
        );
    };

    useEffect(() => {
        if (!tabId || !onDocumentWindowApiChange) return;
        const api: DocumentWindowTabApi = {
            prepareNewWindow: () => prepareDocumentWindowRef.current(),
        };
        onDocumentWindowApiChange(tabId, api);
        return () => onDocumentWindowApiChange(tabId, null);
    }, [onDocumentWindowApiChange, tabId]);

    // Đồng bộ `editSession.dirty` (op edit-object chưa commit ra đĩa — commit-on-exit)
    // vào cờ `editSessionDirty` để `isDirty` (khai báo TRƯỚC editSession, không đọc trực
    // tiếp được) tính vào cảnh báo đóng tab/cửa sổ + snapshot recovery. Không có bước này,
    // sửa object rồi tắt sẽ MẤT thay đổi mà KHÔNG hỏi (thay đổi chỉ nằm trong RAM phiên).
    useEffect(() => {
        setEditSessionDirty(editSession.dirty);
        // RECIPE (audit 2026-08-17 §REC.11R): op đầu tiên làm session dirty = thời
        // điểm bắt đầu sửa. Chụp phiên ghi lúc này; khi hết dirty (đã commit/đóng) thì
        // xoá. handleEditCommit dùng snapshot này để gán Step đúng phiên.
        if (editSession.dirty) {
            if (!objectEditRecordingRef.current && recipeRecorder.isRecordingFor(recipeOwnerTabId)) {
                objectEditRecordingRef.current = { sessionId: recipeRecorder.state.sessionId };
            }
        } else {
            objectEditRecordingRef.current = null;
        }
    }, [editSession.dirty, recipeOwnerTabId]);

    // ----------------------------

    const documentUndoTransitionRef = useRef(false);

    useEffect(() => {
        // Cho phép bước Undo kế tiếp sau khi React đã áp xong file/history mới.
        if (!pendingHistoryEntry) documentUndoTransitionRef.current = false;
    }, [file, history.length, pdfUrl, pendingHistoryEntry]);

    const handleHistoryEntryHydrated = useCallback((entry: WorkspaceHistoryEntry) => {
        setPendingHistoryEntry(current => current === entry ? null : current);
        setRestoredHistoryDirtyFile(entry.pageRevisionDirty ? entry.file : null);
        setViewerDirty(entry.pageRevisionDirty);
        setSourceImageOwner(entry.sourceImageFile
            ? createSourceImageRevisionOwner(entry.file, store.getState().editGeneration)
            : null);
    }, [setViewerDirty, store]);

    const handleUndo = useCallback(() => {
        // PERF (feedback 2026-08-10 §UNDO.2): keydown có thể lặp trước lần
        // render kế tiếp. Không cho hai lượt nạp tài liệu chồng lên nhau.
        if (documentUndoTransitionRef.current || history.length === 0) return;

        const previousEntry = history[history.length - 1];
        const prevFile = previousEntry.file;
        let objUrl = '';
        if ((window as RuntimeWindow).__TAURI_INTERNALS__ && (prevFile as WorkspaceFileLike).path) {
            objUrl = localFileUrl((prevFile as WorkspaceFileLike).path ?? '');
        } else {
            objUrl = URL.createObjectURL(prevFile);
        }

        documentUndoTransitionRef.current = true;
        setHistory(prev => prev.slice(0, -1));

        // RECIPE (audit 2026-08-17 §REC.5): về lại revision này thì rút Step mà commit
        // sau nó đã ghi. Chỉ khi vẫn đang ghi ở tab này; recorder tự bỏ qua nếu lệch.
        const recipeDraftLen = previousEntry.recipeDraftLen;
        if (typeof recipeDraftLen === 'number') {
            recipeRecorder.rollbackDraftTo(recipeOwnerTabId, recipeDraftLen);
        }

        // Generic Undo đổi hẳn revision: vô hiệu mọi job/Edit cache của file đang
        // hiển thị, rồi chỉ hydrate page state sau khi loader của File cũ đã ready.
        advanceEditGeneration();
        store.getState().setObjectEditPast([]);
        store.getState().setObjectEditFuture([]);
        setSelectionFileId('');
        setPendingHistoryEntry(previousEntry);
        setRestoredHistoryDirtyFile(null);
        setFile(prevFile);
        setOriginalFileName(prevFile.name);
        setPdfUrl(objUrl);
        const restoredSource = previousEntry.sourceImageFile;
        const restoredStickerSource = previousEntry.stickerSourceFile;
        // Adapter tương thích cho selector AI hiện hữu; owner chuẩn vẫn nằm trong
        // WorkspaceHistoryEntry, không còn suy từ metadata ẩn trên File.
        if (restoredStickerSource) {
            Object.defineProperty(prevFile, '__prynxStickerSourceFile', {
                value: restoredStickerSource,
                configurable: true,
            });
        }
        syncedStickerSourceRef.current = restoredStickerSource ?? restoredSource;
        setSourceImageFile(restoredSource);
        // Chỉ mở owner sau callback hydrate; trước thời điểm đó ảnh shadow phải
        // fail-closed để tool không ăn ảnh gốc trong một frame trung gian.
        setSourceImageOwner(null);

        // URL cũ còn có thể đang được loader hiện tại dùng trong cùng tick.
        // Thu hồi sau khi state swap đã commit để tránh cắt ngang lượt render cũ.
        if (pdfUrl?.startsWith('blob:') && pdfUrl !== objUrl) {
            window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 0);
        }

        setFileSizeStr((prevFile.size / (1024 * 1024)).toFixed(2) + ' MB');
        onTitleChange?.(prevFile.name);

        // Không dò lại hệ màu trong Undo: viewer đang nạp cùng file từ path.
        // Dò song song từng có thể đọc toàn PDF và làm WebView đứng.

        setViewerPageOrder(undefined);
        setViewerPageInstanceIds(undefined);
        setViewerPageRotations(undefined);

        // Reset detection so it re-runs if needed
        setDetectedShapeType(null);
        setDetectedShapeParams(null);
        setDetectedShapesByPage({});
        setDetectedDimensionsByPage({});
        setDetectedShapeParamsByPage({});
    }, [history, pdfUrl, onTitleChange, setHistory, setFile, setOriginalFileName, setPdfUrl,
        setFileSizeStr, setViewerPageOrder, setViewerPageInstanceIds, setViewerPageRotations, setDetectedShapeType,
        setDetectedShapeParams, setDetectedShapesByPage, setDetectedDimensionsByPage,
        setDetectedShapeParamsByPage, recipeOwnerTabId, advanceEditGeneration, setSelectionFileId,
        store]);




    const sidebarDragRef = useRef<{
        startX: number;
        startTotalWidth: number;
        startFullWidth: number;
        startCatalogWidth: number;
        startLayout: EffectiveToolMenuLayout | null;
        target: 'outer' | 'catalog';
    }>({ startX: 0, startTotalWidth: 0, startFullWidth: 0, startCatalogWidth: 0, startLayout: null, target: 'outer' });
    const [sidebarDraftTotalWidth, setSidebarDraftTotalWidth] = useState<number | null>(null);
    const [sidebarDraftLayout, setSidebarDraftLayout] = useState<EffectiveToolMenuLayout | null>(null);
    const sidebarDraftLayoutRef = useRef<{ mode: ToolMenuMode; fullWidth: number } | null>(null);
    const sidebarDraftEffectiveLayoutRef = useRef<EffectiveToolMenuLayout | null>(null);
    const sidebarDraftFrameRef = useRef<number | null>(null);
    const sidebarDraftTotalWidthRef = useRef<number | null>(null);
    const sidebarDragPointerIdRef = useRef<number | null>(null);

    useEffect(() => {
        if (!isDraggingSidebar) return;
        const commitSidebarDrag = () => {
            if (sidebarDraftFrameRef.current !== null) {
                cancelAnimationFrame(sidebarDraftFrameRef.current);
                sidebarDraftFrameRef.current = null;
            }
            const layout = sidebarDraftLayoutRef.current;
            const panelLayout = sidebarDraftEffectiveLayoutRef.current;
            const hadConfigPanel = (sidebarDragRef.current.startLayout?.configWidth ?? 0) > 0;
            sidebarDraftLayoutRef.current = null;
            sidebarDraftEffectiveLayoutRef.current = null;
            sidebarDragPointerIdRef.current = null;
            setSidebarDraftTotalWidth(null);
            setSidebarDraftLayout(null);
            setIsDraggingSidebar(false);
            if (hadConfigPanel && panelLayout) {
                // UIUX (feedback 2026-09-07 §PANEL.WIDTH): chốt đúng cặp đang
                // nhìn thấy để panel bị giới hạn trước đó không bật rộng sau thả.
                // Mode chỉ do nút thu/mở quyết định, tay kéo không ghi lại nó.
                setRightToolConfigWidth(panelLayout.configWidth);
                useAppSettingsStore.getState().setToolConfigWidth(panelLayout.configWidth);
                if (panelLayout.mode === 'full') {
                    setRightToolMenuFullWidth(panelLayout.catalogWidth);
                    useAppSettingsStore.getState().setToolMenuWidth(panelLayout.catalogWidth);
                }
            } else if (layout) {
                setToolMenuLayout(layout.mode, layout.fullWidth);
            }
        };
        const handlePointerMove = (e: PointerEvent) => {
            if (sidebarDragPointerIdRef.current !== e.pointerId) return;
            const deltaX = sidebarDragRef.current.startX - e.clientX;
            const requestedTotalWidth = sidebarDragRef.current.startTotalWidth + deltaX;
            const hasActiveTool = hasActiveRightTool;
            const maximumTotalWidth = Math.max(
                TOOL_MENU_ICON_WIDTH,
                (workspaceRootRef.current?.clientWidth || window.innerWidth) - TOOL_MENU_VIEWER_MIN_WIDTH,
            );
            const maximumFullWidth = maxFullToolMenuWidth(
                workspaceRootRef.current?.clientWidth || window.innerWidth,
                hasActiveTool,
                TOOL_MENU_VIEWER_MIN_WIDTH,
            );
            let draftTotalWidth: number;
            let draftEffectiveLayout: EffectiveToolMenuLayout;
            const startLayout = sidebarDragRef.current.startLayout;
            if (startLayout && startLayout.configWidth > 0) {
                const target = sidebarDragRef.current.target === 'catalog' ? 'catalog' : 'config';
                const startWidth = target === 'catalog' ? startLayout.catalogWidth : startLayout.configWidth;
                draftEffectiveLayout = resizeToolMenuPanel(startLayout, target, startWidth + deltaX, maximumTotalWidth);
                draftTotalWidth = draftEffectiveLayout.totalWidth;
                sidebarDraftLayoutRef.current = null;
            } else {
                draftTotalWidth = clampToolMenuDraftTotalWidth(
                    requestedTotalWidth,
                    maximumTotalWidth,
                    hasActiveTool,
                );
                const nextLayout = resolveToolMenuDrag(
                    draftTotalWidth,
                    hasActiveTool,
                    sidebarDragRef.current.startFullWidth,
                    maximumFullWidth,
                );
                sidebarDraftLayoutRef.current = nextLayout;
                // Không có bảng thiết lập: giữ thao tác resize catalog cũ.
                draftEffectiveLayout = resolveToolMenuDraftLayout({
                    totalWidth: draftTotalWidth,
                    mode: nextLayout.mode,
                    hasConfigPanel: hasActiveRightTool,
                    maximumTotalWidth,
                    preferredWidth: sidebarDragRef.current.startFullWidth,
                });
            }
            sidebarDraftEffectiveLayoutRef.current = draftEffectiveLayout;
            // UIUX (audit 2026-08-25): trong gesture hai panel bám đúng raw width;
            // mode được chốt vào pointerup để preference không bị ghi giữa chừng.
            sidebarDraftTotalWidthRef.current = draftTotalWidth;
            if (sidebarDraftFrameRef.current === null) {
                sidebarDraftFrameRef.current = requestAnimationFrame(() => {
                    sidebarDraftFrameRef.current = null;
                    const pendingWidth = sidebarDraftTotalWidthRef.current;
                    const pendingLayout = sidebarDraftEffectiveLayoutRef.current;
                    if (pendingWidth !== null) {
                        setSidebarDraftTotalWidth(pendingWidth);
                    }
                    if (pendingLayout !== null) {
                        setSidebarDraftLayout(pendingLayout);
                    }
                });
            }
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', commitSidebarDrag);
        window.addEventListener('pointercancel', commitSidebarDrag);
        window.addEventListener('blur', commitSidebarDrag);

        // Change cursor while dragging anywhere
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', commitSidebarDrag);
            window.removeEventListener('pointercancel', commitSidebarDrag);
            window.removeEventListener('blur', commitSidebarDrag);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [
        activeDashboardTool,
        effectiveToolMenuMode,
        hasActiveRightTool,
        isDraggingSidebar,
        setIsDraggingSidebar,
        setRightToolConfigWidth,
        setRightToolMenuFullWidth,
        setToolMenuLayout,
        workspaceWidth,
    ]);

    const formatSize = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';

    const handleFileSelected = useCallback(async (selectedFile: File, allFiles?: File[]) => {
        // Ảnh → PDF ngay khi mở để mọi công cụ sau chỉ nhận hợp đồng PDF.
        pendingSelectedOpenRef.current = { file: selectedFile, allFiles };
        syncedStickerSourceRef.current = selectedFile;
        setSourceImageFile(isSupportedImageFileName(selectedFile.name) ? selectedFile : null);
        const tSelectStart = performance.now();
        console.info(`[PERF-MEASURE][FILE-OPEN] START: ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`);
        const attempt = beginFileOpeningAttempt(false);
        try {
            selectedFile = await imageFileToPdfIfNeeded(selectedFile, getFileArrayBuffer);
            setSourceImageOwner(isSupportedImageFileName(pendingSelectedOpenRef.current?.file.name || '')
                ? createSourceImageRevisionOwner(selectedFile, store.getState().editGeneration)
                : null);
        } catch (openError) {
            console.error('[handleFileSelected] convert ảnh → PDF lỗi:', openError);
            if (fileOpeningAttemptRef.current === attempt) {
                setError(formatFileOpeningError(
                    openError,
                    t('tabs.imposition:khong_doc_duoc_file_anh'),
                ));
                settleFileOpeningAttempt(attempt, 'error');
            }
            return;
        }
        if (fileOpeningAttemptRef.current !== attempt) return;
        // Đổi file dùng stale-while-revalidate nhưng chỉ nhường grace ngắn;
        // frame đến muộn vẫn được cache cho Viewer sau khi Workspace đã mở.
        const tBeforePrime = performance.now();
        await waitForViewerFirstFrameGrace(primeViewerFirstFrame(selectedFile));
        console.info(`[PERF-MEASURE][FILE-OPEN] primeViewerFirstFrame: ${Math.round(performance.now() - tBeforePrime)}ms`);
        if (fileOpeningAttemptRef.current !== attempt) return;
        setFile(selectedFile);
        setOriginalFileName(selectedFile.name);
        const selNativePath = (selectedFile as File & { path?: string }).path;
        if (selNativePath) {
            const docId = workspaceDocumentIdentity(selectedFile, undefined, undefined);
            console.info('[PERF-MEASURE] Instant bind nativePath to selectionFileId (0ms):', selNativePath);
            setSelectionFileId(selNativePath, docId);
        } else {
            setSelectionFileId('');
        }
        setFileSizeStr(formatSize(selectedFile.size));
        
        if (pdfUrl && !pdfUrl.startsWith('https://')) URL.revokeObjectURL(pdfUrl);
        let objUrl = '';
        const nativePath = (selectedFile as File & { path?: string }).path;
        const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        if (isTauri && nativePath) {
            // FILEIO (audit 2026-07-28 §FL.03): không phụ thuộc asset scope cố định.
            objUrl = localFileUrl(nativePath);
        } else {
            objUrl = URL.createObjectURL(selectedFile);
        }
        setPdfUrl(objUrl);
        setPhase('workspace');
        settleFileOpeningAttempt(attempt, 'idle');
        console.info(`[PERF-MEASURE][FILE-OPEN] TOTAL workspace ready: ${Math.round(performance.now() - tSelectStart)}ms`);
        
        setHistory([]);
        // Reset undo/redo edit-object khi đổi file (tránh khôi phục file cũ).
        store?.getState().setObjectEditPast([]);
        store?.getState().setObjectEditFuture([]);
        
        // Reset detected shapes so it forces a re-detection for the new file
        setDetectedShapeType(null);
        setDetectedShapeParams(null);
        setDetectedShapesByPage({});
        setDetectedDimensionsByPage({});
        setDetectedShapeParamsByPage({});
        
        // Reset zoom to smart fit (max 100%)
        setViewerFitMode('smart');
        setViewerPageDisplayMode('single_scroll');

        onTitleChange?.(selectedFile.name);
        detectColorSpace(selectedFile).then(cs => {
            if (cs) {
                onTitleChange?.(`${selectedFile.name} (${cs})`);
            }
        });

        if (allFiles && allFiles.length > 1 && onSpawnTab) {
            for (let i = 1; i < allFiles.length; i++) {
                onSpawnTab(allFiles[i], buildSourceTabOptions());
            }
        }
    }, [
        beginFileOpeningAttempt, onSpawnTab, onTitleChange, pdfUrl,
        setDetectedDimensionsByPage, setDetectedShapeParams, setDetectedShapeParamsByPage,
        setDetectedShapeType, setDetectedShapesByPage, setError, setFile, setFileSizeStr,
        setHistory, setOriginalFileName, setPdfUrl, setPhase, setSelectionFileId,
        setViewerFitMode, setViewerPageDisplayMode, settleFileOpeningAttempt, store, t,
    ]);
    const retryFileOpening = useCallback(() => {
        const pending = pendingSelectedOpenRef.current;
        if (pending) {
            void handleFileSelected(pending.file, pending.allFiles);
            return;
        }
        initialOpenRetryRef.current?.();
    }, [handleFileSelected]);

    useEffect(() => {
        if (
            !isActive
            || activeDashboardTool !== 'sticker'
            || stickerSheetMode !== 'ai-sheet'
            || stickerSheetSourceOrigin !== 'explicit'
        ) {
            return;
        }
        if (!stickerSheetSourceFile || fileOpeningPhase === 'loading' || stickerSheetBusy) return;
        if (syncedStickerSourceRef.current === stickerSheetSourceFile) return;
        syncedStickerSourceRef.current = stickerSheetSourceFile;
        // REVISION (audit 2026-09-07 §SHEET.SYNC): chỉ nguồn chọn riêng mới mở
        // vào Viewer. Mở ngược PDF đã bake reorder/rotation giữa nhận diện sẽ tự
        // thay File của workspace và khiến snapshot của chính job đó bị stale.
        void handleFileSelected(stickerSheetSourceFile);
    }, [
        activeDashboardTool,
        fileOpeningPhase,
        handleFileSelected,
        isActive,
        stickerSheetBusy,
        stickerSheetMode,
        stickerSheetSourceFile,
        stickerSheetSourceOrigin,
    ]);
    //#endregion

    //#region Processing Handlers
    // ═══ Processing handlers (extracted to lib/processHandlers.ts) ═══
    const [processCancelHandler, setProcessCancelHandler] = useState<(() => Promise<void>) | null>(null);

    // LINT (audit 2026-08-24 LO140): context được tạo trước helper bake; ref giữ
    // hàm bake mới nhất mà không đọc biến const trước khi khởi tạo.
    const applyAcrobatEditsRef = useRef<(sourceFile?: File | null) => Promise<Blob | null>>(
        async () => null,
    );

    const buildProcessContext = useCallback(async (recipeTicket: RecipeOperationTicket | null = null) => {
        await getCropWorkingFile.prepare();
        const workingRevision = getCropWorkingFile.capture();
        if (!workingRevision) {
            throw new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho'));
        }
        const getWorkingBytesLocal = async (): Promise<Uint8Array> => {
            // REVISION (audit 2026-08-25 §REV.03): materialize đúng snapshot lúc
            // bấm chạy; không đọc closure order/rotation đã trôi trong job dài.
            const workingFile = await getCropWorkingFile.materialize(workingRevision);
            return new Uint8Array(await getFileArrayBuffer(workingFile));
        };
        const getWorkingSourcePathLocal = async (): Promise<string | undefined> => {
            const sourcePath = (workingRevision.file as File & { path?: string }).path;
            if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ || !sourcePath) return undefined;

            const hasRotationEdits = !!(workingRevision.viewerPageRotations && Object.values(workingRevision.viewerPageRotations)
                .some((rotation) => (((rotation % 360) + 360) % 360) !== 0));
            const hasNonIdentityOrder = !!workingRevision.viewerPageOrder
                && workingRevision.viewerPageOrder.some((pageNumber, index) => pageNumber !== index + 1);
            const hasExplicitOcgVisibility = workingRevision
                .ocgVisibilityProvenance?.intent === 'explicit';
            if (
                viewerDirty
                || editSessionDirty
                || initialRecovery
                || hasRotationEdits
                || hasNonIdentityOrder
                || hasExplicitOcgVisibility
            ) {
                return undefined;
            }
            return sourcePath;
        };

        return {
            file: workingRevision.file,
            onSpawnTab,
            commitWorkingFile: (blob: Blob, name: string, path?: string) => (
                commitWorkingFile(blob, name, path, recipeTicket, workingRevision)
            ),
            // Bọc setError: khi một thao tác (đã noteOperation) BÁO LỖI (msg≠'') →
            // dọn pending note để KHÔNG bị ghép nhầm vào commit của thao tác sau.
            // UIUX (audit 2026-07-27 §B-23) fix-verify: KHÔNG formatError lần hai ở đây —
            // processHandlers đã format sẵn; format chồng từng cắt cụt 200 ký tự.
            setError: (msg: string) => {
                if (msg) recipeRecorder.discardPending(recipeTicket);
                setError(msg);
            },
            setIsProcessing, setProcessStatus, setReportMsg, setBatchOutput,
            setCancelHandler: (handler: (() => Promise<void>) | null) => {
                setProcessCancelHandler(() => handler);
            },
            viewerNumPages,
            getWorkingBytes: getWorkingBytesLocal,
            getWorkingSourcePath: getWorkingSourcePathLocal,
        };
    }, [commitWorkingFile, editSessionDirty, getCropWorkingFile, initialRecovery, onSpawnTab,
        setBatchOutput, setError, setIsProcessing, setProcessStatus, setReportMsg, t,
        viewerDirty, viewerNumPages]);

    const processEngine = useCallback(async (settings: ProcessingSettings, spawnNewTab: boolean) => {
        if (!file) return;

        // Inject custom confirmation callback
        settings.onConfirmScale = (msg: string) => {
            return new Promise<boolean>((resolve) => {
                setScaleConfirmModal({ msg, resolve });
            });
        };

        // Khi ĐANG GHI quy trình: ÉP commit vào working file (spawnNewTab=false) bất kể
        // cờ UI. Mặc định spawnNewTab=true nên nếu không ép, bình tem/booklet mở tab mới
        // → KHÔNG commit → KHÔNG được ghi vào recipe (bug: recipe chỉ có bước dieline).
        const recordingThisTab = recipeRecorder.isRecordingFor(recipeOwnerTabId);
        const effectiveSpawn = recordingThisTab ? false : spawnNewTab;
        let recipeTicket: RecipeOperationTicket | null = null;

        // ─── Recipe record hook ───
        // Chỉ ghi khi commit vào working file (spawnNewTab=false). onConfirmScale
        // là hàm → bị JSON.stringify loại khi clone params (an toàn để phát lại).
        if (!effectiveSpawn && recordingThisTab) {
            const opId = settings.impositionMode === ImpositionMode.Booklet
                ? 'booklet'
                : (settings as RecipeSettingsView).imposerMode === 'cnc'
                    ? 'cnc_imposer'
                    : (settings as RecipeSettingsView).imposerMode === 'diecut'
                        ? 'sticker_imposer'
                        : 'nup';
            const recordParams = sanitizeRecipeImpositionParams(opId, asRecipeParams(settings));
            // RECIPE (audit 2026-08-16 §PLAY.3R): thứ tự trang và góc xoay thuộc đúng
            // tài liệu này nên đã bị tước khỏi Step. Lượt chạy tay vẫn dùng chúng, vì
            // vậy phải nói rõ Step ghi ra sẽ không tái lập phần đó — im lặng ở đây từng
            // làm người dùng tưởng recipe đã mang theo tay sách đã sắp.
            if (hasDocumentBoundPageState(viewerPageOrder, viewerPageRotations)) {
                toast.info(t('tabs.imposition:quy_trinh_khong_luu_thu_tu_trang'));
            }
            recipeTicket = recipeRecorder.noteOperation(
                opId,
                recordParams,
                undefined,
                recipeOwnerTabId,
            );
            if (!recipeTicket) {
                toast.info(t('tabs.imposition:dang_xu_ly_file'));
                return;
            }
        }

        await runRecordedProcess(recipeTicket, async () => {
            const { runProcessEngine } = await import('../lib/processHandlers');
            return runProcessEngine(await buildProcessContext(recipeTicket), settings, effectiveSpawn);
        });
    }, [file, buildProcessContext, recipeOwnerTabId, t, viewerPageOrder, viewerPageRotations]);

    const handleStartCatalogPlan = useCallback(async (planConfig: PlanConfig, sheetSettings: Partial<ProcessingSettings> & { spawnNewTab?: boolean }) => {
        if (!file) return;
        // Catalog chưa có RecipeOpId/runner. Cho phép chạy lúc đang ghi sẽ thay working file
        // nhưng không tạo Step, khiến mọi bước sau phát lại trên sai nguồn.
        if (recipeRecorder.isRecordingFor(recipeOwnerTabId)) {
            toast.info(t('tabs.imposition:catalog_khong_ghi_quy_trinh'));
            return;
        }
        await runRecordedProcess(null, async () => {
            const { runCatalogPlan } = await import('../lib/processHandlers');
            return runCatalogPlan(await buildProcessContext(null), planConfig, sheetSettings);
        });
    }, [file, buildProcessContext, recipeOwnerTabId, t]);

    // Khi ĐANG GHI: ép spawnNewTab=false để thao tác commit vào working file (chuỗi
    // tuyến tính) VÀ được ghi vào recipe. Mặc định spawnNewTab=true → nếu không ép,
    // thao tác mở tab mới, hook record bị bỏ qua (bug: recipe thiếu bước).
    const handleStartShuffle = async (settings: ShuffleSettings & { spawnNewTab?: boolean }) => {
        if (!file) return;
        const recordingThisTab = recipeRecorder.isRecordingFor(recipeOwnerTabId);
        // RECIPE (audit 2026-08-16 §REC.2): "Tách chẵn/lẻ" luôn sinh HAI tài liệu và
        // handler bỏ qua spawnNewTab=false → không commit, Step mất im lặng. Chặn
        // tường minh như Tách nhiều file thay vì để recipe thiếu bước.
        if (recordingThisTab && settings?.presetId === 'special' && settings?.specialAction === 'split_odd_even') {
            toast.info(t('tabs.imposition:split_nhieu_file_khong_the_ghi_quy_trinh'));
            return;
        }
        const eff = recordingThisTab ? { ...settings, spawnNewTab: false } : settings;
        const recipeTicket = !eff.spawnNewTab && recordingThisTab
            ? recipeRecorder.noteOperation('shuffle', asRecipeParams(eff), undefined, recipeOwnerTabId)
            : null;
        if (recordingThisTab && !recipeTicket) {
            toast.info(t('tabs.imposition:dang_xu_ly_file'));
            return;
        }
        await runRecordedProcess(recipeTicket, async () => {
            const { runShuffle } = await import('../lib/processHandlers');
            return runShuffle(await buildProcessContext(recipeTicket), eff);
        });
    };

    const handleStartResize = async (settings: PageResizerSettings & { spawnNewTab?: boolean }) => {
        if (!file) return;
        const recordingThisTab = recipeRecorder.isRecordingFor(recipeOwnerTabId);
        const eff = recordingThisTab ? { ...settings, spawnNewTab: false } : settings;
        const recipeTicket = !eff.spawnNewTab && recordingThisTab
            ? recipeRecorder.noteOperation('resize', asRecipeParams(eff), undefined, recipeOwnerTabId)
            : null;
        if (recordingThisTab && !recipeTicket) {
            toast.info(t('tabs.imposition:dang_xu_ly_file'));
            return;
        }
        await runRecordedProcess(recipeTicket, async () => {
            const { runResize } = await import('../lib/processHandlers');
            return runResize(await buildProcessContext(recipeTicket), eff);
        });
    };

    const handleStartTrimShift = async (settings: TrimShiftSettings & { spawnNewTab?: boolean }) => {
        if (!file) return;
        const recordingThisTab = recipeRecorder.isRecordingFor(recipeOwnerTabId);
        const eff = recordingThisTab ? { ...settings, spawnNewTab: false } : settings;
        const recipeTicket = !eff.spawnNewTab && recordingThisTab
            ? recipeRecorder.noteOperation('trim_shift', asRecipeParams(eff), undefined, recipeOwnerTabId)
            : null;
        if (recordingThisTab && !recipeTicket) {
            toast.info(t('tabs.imposition:dang_xu_ly_file'));
            return;
        }
        await runRecordedProcess(recipeTicket, async () => {
            const { runTrimShift } = await import('../lib/processHandlers');
            return runTrimShift(await buildProcessContext(recipeTicket), eff);
        });
    };

    const handleStartSplit = useCallback(async (settings: SplitSettings & { spawnNewTab?: boolean }) => {
        if (!file) return;
        const recordingThisTab = recipeRecorder.isRecordingFor(recipeOwnerTabId);
        if (recordingThisTab && !isLinearRecipeSplitMode(settings.mode)) {
            // Recipe chỉ có một working PDF; bộ nhiều output phải được chạy ngoài phiên ghi.
            toast.info(t('tabs.imposition:split_nhieu_file_khong_the_ghi_quy_trinh', {
                defaultValue: 'Tách nhiều file không thể ghi vào quy trình tuyến tính. Hãy dừng ghi rồi chạy tác vụ này riêng.',
            }));
            return;
        }
        const eff = recordingThisTab ? { ...settings, spawnNewTab: false } : settings;
        const recipeTicket = !eff.spawnNewTab && recordingThisTab
            ? recipeRecorder.noteOperation('split', asRecipeParams(eff), undefined, recipeOwnerTabId)
            : null;
        if (recordingThisTab && !recipeTicket) {
            toast.info(t('tabs.imposition:dang_xu_ly_file'));
            return;
        }
        await runRecordedProcess(recipeTicket, async () => {
            const { runSplit } = await import('../lib/processHandlers');
            return runSplit(await buildProcessContext(recipeTicket), eff);
        });
    }, [file, buildProcessContext, recipeOwnerTabId, t]);

    const handleStartMerge = useCallback(async (settings: MergeSettings & { spawnNewTab?: boolean }) => {
        if (!file && settings.mode === 'insert_pages') return;
        const recordingThisTab = recipeRecorder.isRecordingFor(recipeOwnerTabId);
        // RECIPE (audit 2026-08-16 §PLAY.5): Trộn xen kẽ cần đủ hai nguồn, Chèn trang
        // cần file chèn + chỉ số trang tuyệt đối. Hợp đồng input ngoài v1 chỉ mang được
        // một file vô danh nên hai mode này không phát lại được → không ghi từ đầu.
        if (recordingThisTab && !isLinearRecipeMergeMode(settings?.mode)) {
            toast.info(t('tabs.imposition:thao_tac_chua_ghi_duoc_vao_quy_trinh'));
            return;
        }
        const eff = recordingThisTab ? { ...settings, spawnNewTab: false } : settings;
        let recipeTicket: RecipeOperationTicket | null = null;
        if (!eff.spawnNewTab && recordingThisTab) {
            // KHÔNG lưu blob file ngoài vào recipe (Property 7) — chỉ lưu cấu hình ghép.
            // `insertFile` cũng phải bị tước: JSON.stringify(File) = `{}` truthy sẽ lọt
            // qua guard của engine rồi vỡ khi đọc `.name`.
            const { filesToMerge, oddFile: _oddFile, evenFile: _evenFile, insertFile: _insertFile, ...mergeParams } = eff;
            void _oddFile;
            void _evenFile;
            void _insertFile;
            // RECIPE (audit 2026-08-17 §PLAY.5R): ghi ĐÚNG số file ngoài để phát lại hỏi
            // lại đủ N file theo thứ tự (Ghép nối tiếp A+B+C ghi trên A → cần 2 file).
            const externalInputCount = Array.isArray(filesToMerge)
                ? filesToMerge.filter((f: unknown) => f instanceof File).length
                : 0;
            recipeTicket = recipeRecorder.noteOperation(
                'merge',
                asRecipeParams(mergeParams),
                { externalInputCount },
                recipeOwnerTabId,
            );
            if (!recipeTicket) {
                toast.info(t('tabs.imposition:dang_xu_ly_file'));
                return;
            }
        }
        await runRecordedProcess(recipeTicket, async () => {
            const { runMerge } = await import('../lib/processHandlers');
            return runMerge(await buildProcessContext(recipeTicket), eff);
        });
    }, [file, buildProcessContext, recipeOwnerTabId, t]);

    // ─── Recipe playback (Task 9) ───
    // Chuỗi working file CỤC BỘ trong 1 lần phát. Path và bytes là hai revision
    // loại trừ nhau để bước sau không đọc lại path của file lúc bắt đầu.
    const playRecipe = useCallback(async (recipe: Recipe) => {
        if (!file) { toast.error(t('tabs.imposition:hay_mo_mot_file_pdf_truoc_khi_phat_lai')); return; }
        if (recipeRecorder.isRecordingFor(recipeOwnerTabId)) {
            // Không cho hai chuỗi cùng sửa một working artifact của cùng tab.
            toast.info(t('tabs.imposition:dang_ghi_khong_the_phat'));
            return;
        }
        const initialLicense = useAuthStore.getState();
        const denied = firstDeniedRecipeStep(
            recipe,
            initialLicense.licensePlan,
            initialLicense.licenseFeatures,
        );
        if (denied) {
            toast.info(denied.error);
            return;
        }
        setIsRecipePlaying(true);
        try {
        // REVISION (audit 2026-08-25 §REV.03): Recipe tự tạo nhiều revision nên
        // dùng con trỏ CAS riêng; mỗi publish hợp lệ sẽ tiến con trỏ sang file mới.
        let playbackExpectedRevision = captureWorkspaceDocumentRevision(store.getState());
        const assertPlaybackRevisionCurrent = () => {
            if (isWorkspaceDocumentRevisionCurrent(playbackExpectedRevision, store.getState())) return;
            throw new StaleWorkspaceDocumentRevisionError(t(
                'tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly',
                {
                    defaultValue: 'Tài liệu đã thay đổi trong lúc xử lý. Kết quả cũ đã được bỏ qua; vui lòng chạy lại.',
                },
            ));
        };
        // Playback là luồng ngoài recorder: mọi commit/error đều mang `null` để không thể
        // tiêu thụ pending thật của một phiên ghi đang tồn tại ở tab khác.
        const base = await buildProcessContext(null);
        const initialArtifact = await resolveInitialWorkingArtifact(base, file);

        // RECIPE (audit 2026-08-15 §PLAY.1-2): native output trả carrier rỗng
        // kèm path thật. Controller giữ đúng nguồn chân lý và chỉ đọc path vào
        // RAM khi runner kế tiếp thật sự cần bytes.
        const workingArtifact = createWorkingArtifactController(
            initialArtifact,
            {
                readPath: async (artifact) => {
                    const pathFile = new File([], artifact.name, { type: artifact.mimeType });
                    Object.defineProperty(pathFile, 'path', {
                        value: artifact.path,
                        configurable: true,
                    });
                    if (artifact.size !== undefined) {
                        Object.defineProperty(pathFile, 'size', {
                            value: artifact.size,
                            configurable: true,
                        });
                    }
                    return new Uint8Array(await getFileArrayBuffer(pathFile));
                },
                statPath: async (path) => {
                    // Command native có deadline và đọc được path backend ngoài
                    // capability plugin-fs; status không chắc chắn dùng sentinel an toàn.
                    const result = await statNativeSystemFile(path);
                    return result.status === 'available' ? result.size : undefined;
                },
            },
        );

        const { runRecipe } = await import('../lib/recipe/PlaybackRunner');
        const { RECIPE_RUNNERS } = await import('../lib/recipe/recipeRunners');

        const pickOneFile = (accept: string) => new Promise<File | null>((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = accept;
            input.onchange = () => resolve(input.files?.[0] ?? null);
            (input as HTMLInputElement & { oncancel?: (() => void) | null }).oncancel = () => resolve(null);
            input.click();
        });

        const requestExternalInput = async (step: unknown, kind: 'csv' | 'file') => {
            if (kind === 'csv') {
                const f = await pickOneFile('.csv,text/csv');
                if (!f) return null;
                return { csvFile: f, csvText: await f.text() };
            }
            // RECIPE (audit 2026-08-17 §PLAY.5R): hỏi ĐỦ số file đã ghi, TỪNG cái theo
            // thứ tự, để Ghép nối tiếp phát lại đúng A+B+C (không mất C). Recipe cũ
            // thiếu externalInputCount → coi như 1 file (giữ hành vi cũ).
            const count = Math.max(1, Number((step as RecipeExternalInputStep)?.externalInputCount) || 1);
            const files: File[] = [];
            for (let i = 0; i < count; i++) {
                // Native file picker không hiện label riêng → báo trước bằng toast để
                // người dùng biết đang chọn file thứ mấy (thứ tự quyết định kết quả ghép).
                if (count > 1) {
                    toast.info(t('tabs.imposition:chon_file_ghep_thu', { index: i + 1, total: count }));
                }
                const f = await pickOneFile('application/pdf,.pdf');
                // Huỷ giữa chừng = huỷ cả bước: không ghép thiếu file rồi báo hoàn tất.
                if (!f) return null;
                files.push(f);
            }
            return { files };
        };

        // RECIPE (audit 2026-08-17 §PLAY.13): đẩy ĐÚNG một entry history (revision
        // trước lượt phát) để Undo thu gọn cả lượt về đúng file ban đầu, thay vì N lần.
        assertPlaybackRevisionCurrent();
        if (file) {
            setHistory(prev => {
                const next = [...prev, createWorkspaceHistoryEntry({
                    file,
                    pageOrder: viewerPageOrder,
                    pageInstanceIds: viewerPageInstanceIds,
                    pageRotations: viewerPageRotations,
                    pageRevisionDirty: viewerDirty,
                    sourceImageFile,
                    stickerSourceFile: stickerSheetSourceVisible ? stickerSheetSourceFile : null,
                })];
                return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
            });
        }
        // Thứ tự/góc xoay trang đã được bake vào input lúc đọc working; reset để không
        // áp nhầm lên revision mới của lượt phát.
        setViewerPageOrder(undefined);
        setViewerPageInstanceIds(undefined);
        setViewerPageRotations(undefined);
        playbackExpectedRevision = captureWorkspaceDocumentRevision(store.getState());

        // RECIPE (audit 2026-08-17 §PLAY.14): publisher riêng cho lượt phát — chỉ giữ
        // một blob URL trung gian, không đẩy history mỗi bước (đã đẩy một entry ở trên).
        const playbackPublisher = createPlaybackPublisher({
            createObjectUrl: (b) => URL.createObjectURL(b),
            revokeObjectUrl: (u) => URL.revokeObjectURL(u),
            localFileUrl,
            onRevision: ({ file: revFile, url, name, path }) => {
                assertPlaybackRevisionCurrent();
                setOriginalFileName(name);
                setFile(revFile);
                setPdfUrl(url);
                if (!path) setFileSizeStr((revFile.size / (1024 * 1024)).toFixed(2) + ' MB');
                setIsSaved(false);
                onTitleChange?.(name);
                playbackExpectedRevision = captureWorkspaceDocumentRevision(store.getState());
            },
        });

        // RECIPE (audit 2026-08-17 §PLAY.12): gom LÝ DO bỏ qua để báo cụ thể, không
        // chỉ hiện con số. onWarn trước đây không được nối nên người dùng không biết vì
        // sao bước bị bỏ.
        const skipReasons = new Set<string>();
        const res = await runRecipe(recipe, {
            buildContext: () => createWorkingArtifactProcessContext(
                base,
                workingArtifact,
                playbackPublisher.publish,
            ),
            runners: RECIPE_RUNNERS,
            authorizeStep: (step) => {
                const currentLicense = useAuthStore.getState();
                return recipeStepAccessError(
                    step,
                    currentLicense.licensePlan,
                    currentLicense.licenseFeatures,
                );
            },
            requestExternalInput,
            onProgress: ({ index, total, step }) => setProcessStatus(t('tabs.imposition:phat_lai_progress_step', { cur: index + 1, total, step: step.label })),
            onWarn: (_step, reason) => {
                skipReasons.add(
                    reason === 'missing_input' ? t('tabs.imposition:skip_missing_input')
                        : reason === 'unsupported_op' ? t('tabs.imposition:skip_unsupported')
                            : t('tabs.imposition:skip_non_recordable'),
                );
            },
            // PREPRESS (audit 2026-08-20 §COLOR.25): warning từ backend phải hiện
            // ngay trong lượt phát lại; không coi artifact đã commit là "sạch"
            // chỉ vì runner trả completed.
            onStepWarning: ({ step, warnings, engine }) => {
                const detail = warnings.length
                    ? warnings.join('; ')
                    : `Engine: ${engine}`;
                toast.info(`Cảnh báo bước ${step.label}: ${detail}`);
            },
        });
        if (res.status === 'canceled') {
            toast.info(t('shell:err_canceled'));
        } else if (res.ok && res.completed === 0) {
            // §PLAY.12: KHÔNG báo "thành công" khi không chạy được bước nào.
            toast.info(t('tabs.imposition:phat_lai_khong_co_buoc', {
                reasons: [...skipReasons].join(', ') || t('tabs.imposition:skip_non_recordable'),
            }));
        } else if (res.ok) {
            toast.success(t('tabs.imposition:phat_lai_xong', { n: res.completed }) + (res.skipped ? t('tabs.imposition:bo_qua_n_suffix', { n: res.skipped }) : '') + '.');
        } else {
            toast.error(t('tabs.imposition:dung_o_buoc_n', { n: (res.failedStep?.index ?? 0) + 1, err: res.failedStep?.error || t('tabs.imposition:loi') }));
        }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('tabs.imposition:loi'));
        } finally {
            setProcessStatus('');
            setIsRecipePlaying(false);
        }
    }, [file, buildProcessContext, recipeOwnerTabId, t, onTitleChange,
        setHistory, setViewerPageOrder, setViewerPageInstanceIds, setViewerPageRotations,
        setOriginalFileName, setFile, setPdfUrl, setFileSizeStr, setIsSaved,
        setProcessStatus, sourceImageFile, stickerSheetSourceFile, stickerSheetSourceVisible,
        store, viewerDirty, viewerPageInstanceIds, viewerPageOrder, viewerPageRotations]);

    const handleStartBooklet = useCallback((config: BookletSettings) => {
        // NOTE: For 'auto_100', sheet dimension will be dynamically resolved inside the Engine during Phase 2.
        // Dashboard đã resolve press dims + formsize='custom' khi chạy; vẫn resolve an toàn nếu formsize named.
        const actualFormsize = config.scaleMode === '100' ? 'auto_100' : config.formsize;
        const isCustom = actualFormsize === 'custom' || actualFormsize === 'auto_100' || actualFormsize.startsWith('custom_');
        const sheetW = isCustom ? config.customSheetWidth : (PREDEFINED_SIZES[actualFormsize]?.w ?? config.customSheetWidth);
        const sheetH = isCustom ? config.customSheetHeight : (PREDEFINED_SIZES[actualFormsize]?.h ?? config.customSheetHeight);

        // Cách ly cứng hai pipeline: knob Offset có thể vẫn còn trong persisted store nhưng
        // tuyệt đối không được đi vào job In Nhanh chỉ vì UI đang ẩn nó.
        const isOffsetBooklet = config.paperClassification === 'offset';
        const effectiveFoldPattern = isOffsetBooklet ? config.foldPattern : undefined;
        const settings = {
            imposerMode: isOffsetBooklet ? 'offset' : 'guillotine',
            impositionMode: ImpositionMode.Booklet,
            paperClassification: config.paperClassification,
            bindingMode: config.signatureMode,
            foliosize: config.foliosize,
            paperThickness: config.paperThickness,
            bleed: config.bleed,
            sheetWidth: sheetW,
            sheetHeight: sheetH,
            chainNup: config.scaleMode === 'chain_nup' || config.scaleMode === 'cut_stack',
            cutStack: config.scaleMode === 'cut_stack',
            scaleMode: config.scaleMode,
            markType: config.markType,
            markOffset: config.markOffset,
            markLength: config.markLength,
            markThickness: config.markThickness,
            markStyle: config.markStyle,
            interleave: effectiveFoldPattern ? 'normal' : (isOffsetBooklet ? config.interleave : 'normal'),
            foldPattern: effectiveFoldPattern,
            gripperMargin: isOffsetBooklet ? config.gripperMargin : 0,
            marginTop: config.marginTop,
            marginBottom: config.marginBottom,
            marginLeft: config.marginLeft,
            marginRight: config.marginRight,
            marginMode: config.marginMode,
            gapX: config.gapX,
            gapY: config.gapY,
            spreadDistribution: config.spreadDistribution,
            gutterMargin: config.gutterMargin,
            separateCover: config.separateCover,
            coverPageCount: config.coverPageCount,
            blankPlacement: config.blankPlacement || 'end',
            bookReport: config.bookReport,
            pageOrder: viewerPageOrder,
            pageRotations: viewerPageRotations
        };

        // Calculate preview report
        const foldPattern = (settings as RecipeSettingsView).foldPattern;
        const effectiveFoliosize = (settings as RecipeSettingsView).chainNup && foldPattern?.startsWith('sig_')
            ? parseInt(foldPattern.split('_')[1] ?? '', 10)
            : config.foliosize;

        const totalPages = viewerPageOrder ? viewerPageOrder.length : 0;
        const requestedCoverPageCount = config.coverPageCount || 4;
        const separatedCoverPages = config.separateCover && totalPages >= requestedCoverPageCount + 4
            ? requestedCoverPageCount
            : 0;
        const imposedPageCount = totalPages - separatedCoverPages;
        const bodyMultiple = config.signatureMode === 'flush_mount' ? 2 : 4;
        const paddedBodyPages = Math.ceil(imposedPageCount / bodyMultiple) * bodyMultiple;
        const paddedPages = paddedBodyPages + separatedCoverPages;
        const mapResult = generateBindingMap(imposedPageCount, settings.bindingMode || 'saddle', effectiveFoliosize, settings.blankPlacement || 'end');

        // Check if page sizes are consistent
        let sizesConsistent = true;
        const dims = detectedDimensionsByPage; // Fixed bug here: it was reading sourcePageDims from ImposerSettingsStore which doesn't exist
        if (dims) {
            const dimValues = Object.values(dims) as { w: number, h: number }[];
            if (dimValues.length > 1) {
                const firstDim = dimValues[0];
                if (firstDim) {
                    for (let i = 1; i < dimValues.length; i++) {
                        const dim = dimValues[i];
                        if (dim && (Math.abs(dim.w - firstDim.w) > 2 || Math.abs(dim.h - firstDim.h) > 2)) {
                            sizesConsistent = false;
                            break;
                        }
                    }
                }
            }
        }

        const isPerfect = totalPages > 0 && totalPages === paddedPages && sizesConsistent;

        if (isPerfect) {
            // Bypass confirmation if everything is perfectly aligned
            processEngine(settings as ProcessingSettings, config.spawnNewTab);
        } else {
            setConfirmBlankPlacement(config.blankPlacement || 'end');
            setConfirmBookletSettings({
                settings,
                spawnNewTab: config.spawnNewTab,
                report: mapResult.report,
                totalPages,
                paddedPages
            });
        }
    }, [viewerPageOrder, viewerPageRotations, setConfirmBookletSettings, processEngine, detectedDimensionsByPage]);

    const handleStartNup = useCallback((config: NupSettings) => {
        // formsize named (A3…) hoặc custom / custom_* (dims đã press-resolve từ dashboard)
        const isCustom = config.formsize === 'custom' || config.formsize === 'auto_100' || String(config.formsize).startsWith('custom_');
        const sheetW = isCustom ? config.customSheetWidth : (PREDEFINED_SIZES[config.formsize]?.w ?? config.customSheetWidth);
        const sheetH = isCustom ? config.customSheetHeight : (PREDEFINED_SIZES[config.formsize]?.h ?? config.customSheetHeight);

        const cutBorder = config.cutBorder || DEFAULT_CUT_BORDER_CONFIG;
        const rectangleStickerInking = canUseRectangleStickerInking(
            config.cncMode ? 'cnc_imposer' : (config.isDieCutMode ? 'sticker_imposer' : 'nup'),
            config.pageSheetMode === true,
            config.cutType,
            config.detectedShapesByPage,
            viewerNumPages || Object.keys(config.detectedShapesByPage || {}).length,
        );
        const effectiveAlternateRotation = (
            (
                !config.isDieCutMode
                && !config.cncMode
                && !config.pageSheetMode
                && config.layoutType !== 'mixed_guillotine'
            ) || rectangleStickerInking
        ) && (
            config.alternateRotation === 'row' || config.alternateRotation === 'column'
        ) ? config.alternateRotation : 'none';
        const settings = {
            imposerMode: config.cncMode ? 'cnc' : (config.isDieCutMode ? 'diecut' : 'guillotine'),
            impositionMode: ImpositionMode.NUp,
            paperThickness: 0,
            bleed: config.bleed,
            sheetWidth: sheetW,
            sheetHeight: sheetH,
            taskMode: config.taskMode,
            layoutType: config.layoutType,
            cols: config.columns || 0,
            rows: config.rows || 0,
            gridStrategy: config.gridStrategy,
            alternateRotation: effectiveAlternateRotation,
            clusterMode: config.clusterMode,
            clusterCount: config.clusterCount,
            clusterGap: config.clusterGap,
            clusterGapMode: config.clusterGapMode,
            clusterDistribution: config.clusterDistribution,
            clusterBorder: config.clusterBorder,
            gapX: config.gapX,
            gapY: config.gapY,
            marginTop: config.marginTop,
            marginBottom: config.marginBottom,
            marginLeft: config.marginLeft,
            marginRight: config.marginRight,
            marginMode: config.marginMode,
            gripperMargin: config.gripperMargin || 0,
            duplexFlow: config.duplexFlow,
            duplexFlipEdge: config.duplexFlipEdge,
            align: config.align,
            mirrorAlign: config.mirrorAlign,
            markType: config.markType,
            markOffset: config.markOffset,
            markLength: config.markLength,
            markThickness: config.markThickness,
            markStyle: config.markStyle,
            cutBorderEnabled: cutBorder.enabled,
            cutBorderPosition: cutBorder.position,
            cutBorderColor: cutBorder.color,
            cutBorderThickness: cutBorder.thickness,
            pageOrder: viewerPageOrder,
            pageRotations: viewerPageRotations,
            isDieCutMode: config.isDieCutMode,
            pageSheetMode: config.pageSheetMode,
            cutType: config.cutType,
            fillBlockGap: config.fillBlockGap,
            dieSizeMode: config.dieSizeMode,
            dieOffsetMm: config.dieOffsetMm,
            pontType: config.pontType,
            pontConfig: config.pontConfig,
            shapeType: config.shapeType,
            shapeParams: config.shapeParams,
            detectedShapesByPage: config.detectedShapesByPage,
            detectedShapeParamsByPage: config.detectedShapeParamsByPage,
            targetQuantity: config.targetQuantity,
            targetQuantitiesByPage: config.targetQuantitiesByPage,
            groupingStrategy: config.groupingStrategy,
            clusterCombineMode: config.clusterCombineMode,
            clusterTileW: config.clusterTileW,
            clusterTileH: config.clusterTileH,
            clusterSizingMode: config.clusterSizingMode,
            clusterCols: config.clusterCols,
            clusterRows: config.clusterRows,
            tileGapX: config.tileGapX,
            tileGapY: config.tileGapY,
            clusterNesting: config.clusterNesting,
            separateCutPage: config.separateCutPage,
            pontsOnCutFile: config.pontsOnCutFile,
            hiddenOcgLayerIds: config.hiddenOcgLayerIds,
            splitGap: config.splitGap,
            diagnosticTraceId: config.diagnosticTraceId,
            diagnosticPreviewRequestId: config.diagnosticPreviewRequestId,
            diagnosticPendingRequestId: config.diagnosticPendingRequestId,
            diagnosticPreviewCapacity: config.diagnosticPreviewCapacity,
            diagnosticPreviewState: config.diagnosticPreviewState,
            forceLegacyGrid: config.forceLegacyGrid,
            // ═══ Bình Bế Rớt (CNC) ═══
            cncMode: config.cncMode,
            cncTwoSided: config.cncTwoSided,
            cncFlipEdge: config.cncFlipEdge,
            cncDuplexMarks: config.cncDuplexMarks,
            // CONTRACT (audit 2026-08-29 §MAP-NEST-11): job mới chỉ chuyển tiếp
            // cấu hình canonical; alias cũ không được tái phát xuống engine.
            savePrintConfig: config.savePrintConfig,
            // ═══ Report vẽ lên tờ (spec: binh-tem-be-report) — gồm cả CNC ═══
            reportDisplay: config.reportDisplay,
            reportMaterial: config.reportMaterial,
            reportLamination: config.reportLamination,
            reportLaminationSides: config.reportLaminationSides,
            reportOrderCode: config.reportOrderCode,
            exportUniqueSheets: config.exportUniqueSheets,
        };

        processEngine(settings as unknown as ProcessingSettings, config.spawnNewTab);
    }, [viewerPageOrder, viewerPageRotations, viewerNumPages, processEngine]);
    //#endregion

    //#region Core UI Handlers

    const forceReset = () => {
        // RECIPE (audit 2026-08-17 §REC.9): đóng/đổi file phải kết thúc phiên ghi. Nếu
        // không, recorder singleton giữ isRecording=true trong khi nút Dừng (chỉ hiện
        // khi có file) đã biến mất → khoá tính năng Ghi của MỌI tab tới khi restart app.
        recipeRecorder.cancel(recipeOwnerTabId);
        setBatchOutput(null);
        setFile(null);
        setPdfUrl(null);
        setPhase('upload');
        setHistory([]);
        store?.getState().setObjectEditPast([]);
        store?.getState().setObjectEditFuture([]);
        setError('');
        setIsSaved(false);
        setViewerPageOrder(undefined);
        setViewerPageRotations(undefined);
        setBleedView({ show: false, mm: 0 });
        setHighlightedIssue(null);
        setViewerDirty(false); // Clear any preflight highlights
        setSelectionFileId(''); // Reset fid � object edit re-uploads on demand
        setHiddenObjectIds([]);
        setLockedObjectIds([]);
        setShowCloseConfirm(false);
        setVdpFields([]); // Clear barcode/VDP fields
        setSelectedVdpFieldIds([]);
        
        // Clear shape detection cache
        setDetectedShapeType(null);
        setDetectedShapeParams(null);
        setDetectedShapesByPage({});
        setDetectedDimensionsByPage({});
        setDetectedShapeParamsByPage({});
        
        onTitleChange?.(t('tabs.imposition:khong_co_file'));
    };

    // Số trang file GỐC (disk) — khác viewerNumPages sau khi xóa trang.
    // Cache theo identity file; xóa đuôi 10→4 còn order [1,2,3,4] vẫn phải bake.
    const sourcePageCountCacheRef = useRef<{ key: string; count: number } | null>(null);
    // Max độ dài order đã thấy trên file hiện tại — xóa trang (kể cả đuôi) luôn < max.
    const maxViewerOrderLenRef = useRef(0);
    const isPrintingRef = useRef(false);
    useEffect(() => {
        sourcePageCountCacheRef.current = null;
        maxViewerOrderLenRef.current = 0;
    }, [file]);
    useEffect(() => {
        const len = viewerPageOrder?.length ?? 0;
        if (len > maxViewerOrderLenRef.current) maxViewerOrderLenRef.current = len;
    }, [viewerPageOrder]);

    const resolveSourcePageCount = useCallback(async (f: File): Promise<number> => {
        const fileLike = f as WorkspaceFileLike;
        const key = `${fileLike.path || f.name}|${f.size}|${f.lastModified || 0}`;
        if (sourcePageCountCacheRef.current?.key === key) {
            return sourcePageCountCacheRef.current.count;
        }
        const ab = await getFileArrayBuffer(f);
        const doc = await PDFDocument.load(ab, { ignoreEncryption: true });
        const count = doc.getPageCount();
        sourcePageCountCacheRef.current = { key, count };
        return count;
    }, []);

    /** order === [1..N] với N = số trang FILE GỐC (không phải viewerNumPages sau xóa). */
    const isViewerOrderIdentityForSource = useCallback(async (
        f: File,
        order: number[] | null | undefined,
    ): Promise<boolean> => {
        if (!order || order.length === 0) return true;
        // Đã từng thấy nhiều trang hơn → đã xóa (kể cả xóa đuôi còn [1..k]).
        if (maxViewerOrderLenRef.current > 0 && order.length < maxViewerOrderLenRef.current) {
            return false;
        }
        const srcCount = await resolveSourcePageCount(f);
        if (order.length !== srcCount) return false;
        return order.every((p, i) => p === i + 1);
    }, [resolveSourcePageCount]);

    const applyAcrobatEdits = useCallback(async (sourceFile: File | null = file) => {
        if (!sourceFile || !viewerPageOrder) return null;
        const rotations = viewerPageRotations || {};
        const arrayBuffer = await getFileArrayBuffer(sourceFile);
        const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const newDoc = await PDFDocument.create();

        // [OCG FIX 2026-07-28] copyPages KHÔNG mang theo /OCProperties ở catalog, trong khi
        // content stream vẫn giữ /OC … BDC → layer thợ đã ẩn trong Illustrator hiện lại hết
        // và lọt vào bản in. Đóng dấu OCG trước khi copy, dựng lại catalog sau khi copy.
        const ocTransfer = beginOptionalContentTransfer([srcDoc]);

        // rotations là number[] THEO VỊ TRÍ (per-instance rotation) — đọc theo index vòng
        // lặp, KHÔNG theo số trang pIdx. Fallback dữ liệu cũ Record<pageNum,deg>.
        const rotAt = (i: number, pIdx: number): number => {
            if (Array.isArray(rotations)) return rotations[i] || 0;
            return (rotations as Record<number, number>)[pIdx] || 0;
        };
        try {
            for (let i = 0; i < viewerPageOrder.length; i++) {
                const pIdx = viewerPageOrder[i];
                if (pIdx === -1) {
                    const firstPage = srcDoc.getPages()[0];
                    const defaultDim = firstPage ? { w: firstPage.getSize().width, h: firstPage.getSize().height } : { w: 595.28, h: 841.89 };
                    newDoc.addPage([defaultDim.w, defaultDim.h]);
                } else {
                    const [copiedPage] = await newDoc.copyPages(srcDoc, [pIdx - 1]);
                    const rot = rotAt(i, pIdx);
                    if (rot) {
                        const currentRot = copiedPage.getRotation().angle;
                        copiedPage.setRotation(degrees(currentRot + rot));
                    }
                    newDoc.addPage(copiedPage);
                }
            }
        } finally {
            // Chạy cả khi vòng copy lỗi giữa đường: bắt buộc xoá dấu tạm khỏi srcDoc.
            finishOptionalContentTransfer(ocTransfer, newDoc);
        }

        const pdfBytes = await newDoc.save();
        return new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    }, [file, viewerPageOrder, viewerPageRotations]);

    applyAcrobatEditsRef.current = applyAcrobatEdits;

    /**
     * Trả về File template để các tác vụ tiếp theo (VDP, đánh số...) xử lý.
     * Nếu người dùng đã sửa trang trong viewer (xóa/xoay/sắp xếp) thì "nướng"
     * các thay đổi đó vào file mới — tuân thủ quy tắc: tác vụ sau chỉ dùng KẾT QUẢ
     * đã chỉnh, không dùng file gốc. Nếu không có sửa đổi, giữ nguyên file gốc
     * (bảo toàn .path để backend nạp nhanh qua native path).
     */
    const getWorkingFile = async (): Promise<File> => {
        // FIX/PARITY (audit 2026-08-29 §MAP-NEST-10): preview và execution dùng
        // cùng resolver/revision. Explicit OCG (kể cả show-all `[]`) vì vậy nhận
        // đúng bytes đã sửa `/OCProperties /D`, không còn resolver bake riêng.
        const working = await getCropWorkingFile.resolveUnprepared();
        if (working) return working;
        throw new Error('Không thể tạo PDF làm việc từ revision hiện tại.');
    };

    /** @returns true nếu đã lưu thành công; false nếu huỷ dialog / lỗi. */
    const handleSaveFile = useCallback(async (isSaveAs: boolean = false): Promise<boolean> => {
        // DATA (audit 2026-08-25 §NW.2): snapshot child không bao giờ ghi đè file
        // khách hoặc snapshot app-owned, kể cả Ctrl+S/SaveModal truyền `false`.
        const effectiveSaveAs = isSaveAs || Boolean(documentWindow?.saveAsOnly);
        // Edit-session COMMIT-ON-SAVE: nếu đang sửa object và có thay đổi chưa ghi
        // (commit-on-exit chưa chạy vì vẫn ở edit mode), commit NGAY để `file`/pdfUrl
        // trỏ Working_File mới ĐÃ bake mọi op. onCommit → handleEditCommit set state
        // (bất đồng bộ), nhưng ta await commit xong nên lần lưu này thấy file mới ở
        // vòng render kế; để chắc chắn dùng luôn kết quả, đợi 1 tick sau setState.
        if (editSession.dirty) {
            try {
                await editSession.commit();
                // Nhường 1 microtask cho React flush setFile/setPdfUrl từ onCommit.
                await new Promise<void>(r => setTimeout(r, 0));
            } catch {
                setError(t('tabs.imposition:khong_luu_duoc_thay_doi_chinh_sua_vao'));
                return false;
            }
        }
        // Sau commit, `file` (biến closure) đã STALE — onCommit set store bất đồng bộ.
        // Đọc file MỚI NHẤT từ store để mọi quyết định lưu (path/tên/bytes) trỏ đúng
        // Working_File đã bake op. Non-edit: getState().file === file (không đổi).
        const curFile: File | null = (store?.getState().file as File | null) || file;
        if (!curFile) return false;
        let targetBlob: Blob = curFile;
        const targetName = curFile.name;
        let didBake = false;  // có bake edits/VDP vào blob mới hay không

        // path chỉ là file tạm backend (<uuid>.pdf) do polyfill gán để render → KHÔNG
        // được coi là đích lưu thật. Bắt buộc hỏi vị trí lưu (tránh ghi đè temp + đổi
        // tên tab thành chuỗi uuid). Phòng thủ 2 lớp: cờ isTempUploadPath HOẶC path nằm
        // trong thư mục phù du của backend (uploads/results/temp | <uuid>.pdf).
        const isTempUploadPath = !!(curFile as WorkspaceFileLike)?.isTempUploadPath
            || isEphemeralBackendPath((curFile as WorkspaceFileLike)?.path);

        // Chỉ bake khi có sửa đổi THẬT SỰ (xoay khác 0, hoặc thứ tự trang khác gốc /
        // có xoá/chèn). So với FILE GỐC page count — không dùng viewerNumPages (sau xóa
        // luôn = order.length → xóa đuôi bị bỏ sót). Nếu chỉ "lưu lại" không sửa → bỏ bake.
        const _hasRot = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: unknown) => ((((r as number) % 360) + 360) % 360) !== 0));
        const _hasReorder = !!viewerPageOrder && curFile
            ? !(await isViewerOrderIdentityForSource(curFile, viewerPageOrder))
            : false;

        // Nếu có visual edits (xoay/sắp trang) → bake vào blob để lưu.
        const savePlan = planWorkspacePdfSave(curFile, {
            forceSaveAs: effectiveSaveAs,
            isTransientPath: isTempUploadPath,
            hasRotationEdits: _hasRot,
            hasOrderEdits: _hasReorder,
        });

        // KHÔNG commitWorkingFile (tránh đổi tên "Edited_" + race set isSaved=false).
        if (savePlan.shouldBake) {
            setIsProcessing(true);
            setProcessStatus(t('tabs.imposition:dang_ap_dung_thay_doi_va_luu'));
            try {
                const editedBlob = await applyAcrobatEdits(curFile);
                if (editedBlob) {
                    targetBlob = editedBlob;
                    didBake = true;
                } else {
                    throw new Error('Không nhận được dữ liệu PDF sau khi áp dụng thay đổi trang.');
                }
            } catch (err: unknown) {
                setError(t('tabs.imposition:loi_khi_ap_dung_sua_doi') + errorMessage(err));
                return false;
            } finally {
                setIsProcessing(false);
                setProcessStatus('');
            }
        }

        // ─── KHÔNG nướng (bake) VDP khi Lưu ───
        // Lưu chỉ lưu tài liệu hiện tại; field VDP là lớp phủ ĐANG SOẠN → giữ nguyên
        // trên canvas để tiếp tục sửa / chạy merge. Muốn xuất bản có field thì dùng
        // nút "Chạy/Generate". (Trước đây Lưu chạy job VDP với data rỗng → lỗi
        // "Data array is empty" và xoá mất field sau khi lưu.)

        // Cập nhật in-memory sau khi lưu thành công: bake blob mới (giữ TÊN GỐC),
        // xoá visual edits/VDP đã bake, đánh dấu ĐÃ LƯU (không còn dirty).
        const _publishSavedRevision = (
            blob: Blob,
            name: string,
            path: string | null,
            pathRebaseOnly = false,
        ) => {
            const savedRevision = createSavedWorkspaceRevision(blob, name, {
                path: path ?? undefined,
                size: blob.size || curFile.size,
                pathRebaseOnly,
            });
            setFile(savedRevision);
            setOriginalFileName(name);
            if (pdfUrl?.startsWith('blob:')) URL.revokeObjectURL(pdfUrl);
            setPdfUrl(path ? localFileUrl(path) : URL.createObjectURL(blob));
            setFileSizeStr(((blob.size || curFile.size) / (1024 * 1024)).toFixed(2) + ' MB');
            setViewerPageOrder(undefined);
            setViewerPageInstanceIds(undefined);
            setViewerPageRotations(undefined);
            setViewerDirty(false);
            // KHÔNG xoá vdpFields/selection ở đây: giữ lớp phủ field VDP để người dùng
            // tiếp tục soạn/chạy merge sau khi lưu (tránh "lưu xong mất placeholder").
            setSelectionFileId('');
            setHiddenObjectIds([]);
            setLockedObjectIds([]);
        };

        try {
            if ((window as RuntimeWindow).__TAURI_INTERNALS__) {
                const { save } = await import('@tauri-apps/plugin-dialog');
                const { invoke } = await import('@tauri-apps/api/core');
                type SaveSelection = { path: string; grant: string | null };
                const isDocumentChild = documentWindow?.saveAsOnly === true;
                // SEC (audit 2026-09-04 §SEC.15): child không gọi plugin dialog trực
                // tiếp. Native chọn đích, kiểm lineage và trả capability one-shot gắn
                // đúng window label + canonical target; main giữ nguyên luồng cũ.
                const chooseSaveTarget = async (title: string): Promise<SaveSelection | null> => {
                    if (isDocumentChild) {
                        return invoke<SaveSelection | null>('request_document_save_grant', {
                            request: {
                                suggestedName: targetName,
                                title,
                            },
                        });
                    }
                    const selectedPath = await save({
                        filters: [{ name: 'PDF', extensions: ['pdf'] }],
                        defaultPath: targetName,
                        title,
                    });
                    return selectedPath ? { path: selectedPath, grant: null } : null;
                };
                // GHI NGUYÊN TỬ qua lệnh Rust (ghi temp cùng thư mục rồi rename = thay-thế
                // nguyên tử) → KHÔNG để file gốc dở-dang/hỏng nếu crash giữa lúc ghi đè
                // (audit an toàn dữ liệu). Bytes truyền dạng Uint8Array (Tauri v2 raw IPC).
                const atomicWrite = (p: string, data: Uint8Array, saveGrant: string | null) =>
                    invoke('write_file_atomic', saveGrant
                        ? { path: p, contents: data, saveGrant }
                        : { path: p, contents: data });
                
                const selection: SaveSelection | null = savePlan.overwritePath && !isDocumentChild
                    ? { path: savePlan.overwritePath, grant: null }
                    : await chooseSaveTarget('Save PDF File');

                if (selection) {
                    const { path, grant: saveGrant } = selection;
                    // FILEIO (audit 2026-08-26 §FILE.A4): mọi quyết định của bước ghi nằm
                    // trong MỘT hàm thuần `planWorkspaceSaveWrite`, thứ tự cố định: reuse
                    // source sạch → từ chối đích artifact tạm → copy đĩa→đĩa → ghi bytes.
                    // Trước đây reuse kiểm tại call site còn chặn artifact kiểm trong
                    // `performWrite`, tức thứ tự rải hai chỗ; chỉ cần một lần chèn nhánh sai
                    // vị trí là lệnh copy tự thay chính artifact tạm rồi báo thành công, và
                    // luồng lưu gắn identity "nguồn sạch" lên nó — provenance bị rửa trắng,
                    // vé thuê artifact bị tước, vòng dọn được phép xoá đúng file người dùng
                    // vừa tưởng là đã lưu.
                    const runSaveWrite = (destPath: string, grant: string | null) => executeWorkspaceSaveWrite(
                        planWorkspaceSaveWrite({
                            file: curFile,
                            destPath,
                            isTransientPath: isTempUploadPath,
                            didBake,
                        }),
                        {
                            // KHÔNG bake và bytes đã nằm trên đĩa (kết quả bình sách/VDP có
                            // thể hàng trăm MB) → COPY thẳng đĩa→đĩa qua Rust, không nạp bytes
                            // vào JS. Đường cũ đọc cả file vào Uint8Array rồi đẩy qua IPC cho
                            // write_file_atomic → "RangeError: Invalid array length" khi
                            // serialize khối khổng lồ (vd booklet 338MB).
                            copyOnDisk: async (source, dest) => {
                                await invoke('copy_file_atomic', grant
                                    ? { source, path: dest, saveGrant: grant }
                                    : { source, path: dest });
                            },
                            writeBytes: async (dest, bytes) => {
                                await atomicWrite(dest, bytes, grant);
                            },
                            // Cổng lười: chỉ nhánh ghi bytes mới gọi, nên nhánh từ chối không
                            // bao giờ nạp file lớn vào WebView chỉ để rồi bỏ đi.
                            readBytes: async () => new Uint8Array(await targetBlob.arrayBuffer()),
                        },
                    );
                    // Công bố revision đã lưu tại đích. Chỉ chạy cho `written` và `reused`.
                    const publishSavedAt = (blob: Blob, destPath: string, pathRebaseOnly: boolean) => {
                        const fileName = destPath.split(/[\\/]/).pop() || targetName;
                        _publishSavedRevision(blob, fileName, destPath, pathRebaseOnly);
                        setIsSaved(true);
                        onTitleChange?.(fileName);
                    };
                    // Từ chối đích artifact tạm là GIÁ TRỊ TRẢ VỀ, không phải throw. Nếu nó
                    // nổi thành exception thì lọt vào `catch` lỗi phạm vi ghi bên dưới, và
                    // chốt chặn chỉ còn dựa vào việc câu thông báo tình cờ không chứa
                    // `not allowed` — sửa câu chữ là mất chốt, người dùng lại được mở hộp
                    // thoại chọn vị trí như thể đây là lỗi quyền (Requirement 1.3).
                    const applySaveOutcome = (
                        outcome: WorkspaceSaveWriteOutcome,
                        destPath: string,
                    ): boolean => {
                        if (outcome.kind === 'rejected') {
                            // KHÔNG publish revision, KHÔNG đổi isSaved, KHÔNG đổi tiêu đề
                            // tab: working file giữ nguyên provenance và vé thuê artifact để
                            // vòng dọn không xoá file đang dùng (Requirement 1.4, 2.3, 2.4).
                            setError(t(outcome.messageKey));
                            return false;
                        }
                        if (outcome.kind === 'reused') {
                            // Đích chính là source sạch đang mở và không có gì để bake → đã là
                            // chính nó, chỉ rebase path. `reused` chỉ sinh ra khi `didBake` sai
                            // nên publish thẳng `curFile`, không đọc lại bytes qua IPC.
                            publishSavedAt(curFile, destPath, true);
                            return true;
                        }
                        publishSavedAt(targetBlob, destPath, !didBake);
                        return true;
                    };
                    try {
                        return applySaveOutcome(await runSaveWrite(path, saveGrant), path);
                    } catch (writeErr: unknown) {
                        // Lỗi phạm vi ghi vẫn từ Rust dưới dạng chuỗi: giữ NGUYÊN nhánh mở
                        // lại hộp thoại chọn vị trí (Requirement 1.5). Nhánh từ chối artifact
                        // không đi qua đây nên không thể kích hoạt hộp thoại này.
                        const writeErrorText = errorMessage(writeErr);
                        if (writeErrorText.includes('forbidden path') || writeErrorText.includes('not allowed')) {
                            const fallbackSelection = await chooseSaveTarget(
                                'Select save location (Original path restricted)',
                            );
                            if (fallbackSelection) {
                                // Lượt fallback cũng đi qua plan: đích chọn lại vẫn có thể
                                // trùng artifact tạm và vẫn phải bị chặn.
                                return applySaveOutcome(
                                    await runSaveWrite(fallbackSelection.path, fallbackSelection.grant),
                                    fallbackSelection.path,
                                );
                            }
                            return false; // user huỷ fallback
                        } else {
                            throw writeErr;
                        }
                    }
                }
                return false; // user huỷ hộp thoại lưu
            } else {
                // Browser Fallback
                const url = URL.createObjectURL(targetBlob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = targetName;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 100);

                _publishSavedRevision(targetBlob, targetName, null);
                setIsSaved(true);
                onTitleChange?.(targetName);
                return true;
            }
        } catch (e: unknown) {
            setError(t('tabs.imposition:khong_the_luu_file') + errorMessage(e));
            return false;
        }
    }, [editSession, store, file, viewerPageRotations, viewerPageOrder, isViewerOrderIdentityForSource, setError, t, setIsProcessing, setProcessStatus, applyAcrobatEdits, setFile, pdfUrl, setPdfUrl, setFileSizeStr, setViewerPageOrder, setViewerPageInstanceIds, setViewerPageRotations, setViewerDirty, setSelectionFileId, setHiddenObjectIds, setLockedObjectIds, setIsSaved, onTitleChange, setOriginalFileName, documentWindow?.saveAsOnly]);

    useEffect(() => {
        const handleTriggerSave = async (e: Event) => {
            const detail = (e as CustomEvent<{ tabId?: string; requestId?: string; saveAs?: boolean }>).detail;
            if (detail?.tabId !== tabId) return;
            // Workspace Logo sở hữu artifact SVG và Save dialog riêng. Nếu parent
            // tiếp tục xử lý, cùng requestId có thể nhận kết quả lưu PDF sai trước.
            if (
                activeDashboardTool === 'logo_rebuild'
                && logoWorkspaceOpened
                && (logoSessionDirty || !documentIsDirty)
            ) return;
            const requestId = detail?.requestId;
            const reply = (result: 'saved' | 'cancelled' | 'failed') => {
                if (!requestId) return;
                window.dispatchEvent(new CustomEvent('app-save-result', {
                    detail: { requestId, result, tabId },
                }));
            };
            // Menu Ctrl+S: chỉ tab đang xem. Luồng thoát app (có requestId) cho phép
            // lưu cả khi vừa setActive (tránh race isActive chưa kịp true).
            if (!isActive && !requestId) return;
            // UIUX (audit menu 2026-07-28 §MB.2b): chưa nạp file thì handleSaveFile
            // return false ở `if (!targetBlob)` — im lặng hoàn toàn. Bắt sớm ở đây và
            // nói rõ, tránh bấm Lưu / mở hộp Lưu thành rồi không đi đến đâu.
            if (!(store?.getState().file || file)) {
                toast.info(t('tabs.imposition:chua_co_file_de_luu', 'Chưa có file nào để lưu — mở hoặc kéo file PDF vào đã.'));
                reply('failed');
                return;
            }
            if (detail?.saveAs) {
                setShowSaveAsModal(true);
                // Save As modal không await → báo cancelled cho luồng thoát tuần tự
                // (user vẫn lưu được qua modal; thoát app dùng Lưu trực tiếp không saveAs).
                reply('cancelled');
                return;
            }
            if (!documentWindow?.saveAsOnly && !(isDirty || viewerDirty)) {
                // UIUX (audit menu 2026-07-28 §MB.2b): trước đây thoát êm, user bấm Lưu
                // mà không thấy gì nên tưởng menu chết. Nói rõ là KHÔNG có gì cần lưu.
                // Luồng thoát app (có requestId) vẫn im lặng — nó chỉ cần kết quả 'saved'.
                if (!requestId) toast.info(t('tabs.imposition:khong_co_thay_doi_nao_can_luu', 'File chưa có thay đổi nào cần lưu.'));
                reply('saved');
                return;
            }
            try {
                const ok = await handleSaveFile(Boolean(documentWindow?.saveAsOnly));
                reply(ok ? 'saved' : 'cancelled');
            } catch {
                reply('failed');
            }
        };
        window.addEventListener('app-trigger-save', handleTriggerSave);
        return () => window.removeEventListener('app-trigger-save', handleTriggerSave);
    }, [isActive, tabId, isDirty, viewerDirty, handleSaveFile, file, store, t, activeDashboardTool, logoWorkspaceOpened, logoSessionDirty, documentIsDirty, setShowSaveAsModal, documentWindow?.saveAsOnly]);

    // Ctrl+P → in PDF ĐANG XEM qua hộp thoại máy in Windows (lệnh Rust print_pdf).
    // KHÔNG dùng window.print() của WebView2 (chỉ in DOM giao diện). Resolve path
    // giống Ctrl+S: commit editSession nếu dirty → đọc file mới nhất từ store → nếu
    // có visual edits (xoay/sắp trang) thì bake ra blob rồi ghi file tạm để lấy path
    // thật cho PDFium; nếu chỉ có blob in-memory (không path đĩa) cũng ghi tạm.
    const handlePrintFile = useCallback(async () => {
        if (isPrintingRef.current) return;
        isPrintingRef.current = true;
        setError('');

        try {
            if (!(window as RuntimeWindow).__TAURI_INTERNALS__) {
                setError(t('tabs.imposition:in_chi_ho_tro_trong_ung_dung'));
                return;
            }

            if (editSession.dirty) {
                try {
                    await editSession.commit();
                    await new Promise<void>(r => setTimeout(r, 0));
                } catch {
                    setError(t('tabs.imposition:khong_luu_duoc_thay_doi_chinh_sua_vao'));
                    return;
                }
            }

            // Sau commit phải đọc lại file từ store; biến `file` trong closure có thể vẫn
            // là bản trước khi chỉnh sửa đối tượng được ghi vào PDF.
            const curFile: File | null = (store?.getState().file as File | null) || file;
            if (!curFile) return;

            const hasRotationEdits = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: unknown) => ((((r as number) % 360) + 360) % 360) !== 0));
            const hasOrderEdits = !!viewerPageOrder
                && !(await isViewerOrderIdentityForSource(curFile, viewerPageOrder));

            // Luôn áp dụng trạng thái xoay/thứ tự đang thấy, kể cả đây là file kết quả
            // đã sinh từ Bình trang/VDP. Cờ isGenerated chỉ liên quan cách lưu, không
            // được dùng để bỏ qua thay đổi của viewer khi in.
            let bakedBlob: Blob | null = null;
            if (hasRotationEdits || hasOrderEdits) {
                setIsProcessing(true);
                setProcessStatus(t('tabs.imposition:dang_chuan_bi_in'));
                try {
                    bakedBlob = await applyAcrobatEdits(curFile);
                } finally {
                    setIsProcessing(false);
                    setProcessStatus('');
                }
            }

            // Hộp thoại in hợp nhất lo hết: chọn tỉ lệ/máy in/orientation + preview, ghi
            // temp nếu là blob (bakedBlob) hoặc file không có path đĩa, in native + dọn temp.
            // Ưu tiên bake (bản đang thấy); nếu không thì curFile — resolvePrintableFilePath
            // tự dùng curFile.path (file mở từ đĩa) hoặc ghi temp (blob in-memory).
            const source: Blob | File = bakedBlob || curFile;
            const viewerState = store?.getState();
            const printPageCount = Math.max(1, viewerState?.viewerNumPages || viewerNumPages || 1);
            const initialPage = Math.max(1, Math.min(
                viewerState?.viewerActivePage || viewerActivePage || 1,
                printPageCount,
            ));
            const selectedPages = pageIndicesToPageNumbers(
                viewerState?.viewerSelectedPageIndices || [],
                printPageCount,
            );
            // UIUX (audit 2026-08-11 §PRINTRANGE.2): current/selection là snapshot
            // của đúng tab và trỏ vào vị trí trang của PDF sau bake (đều 1-based).
            await openPrintDialog({
                source,
                numPages: printPageCount,
                initialPage,
                selectedPages,
            });
        } catch (e: unknown) {
            setError(t('tabs.imposition:khong_the_in_file') + (errorMessage(e) || String(e)));
        } finally {
            isPrintingRef.current = false;
        }
    }, [setError, editSession, store, file, viewerPageRotations, viewerPageOrder, isViewerOrderIdentityForSource, viewerNumPages, viewerActivePage, openPrintDialog, t, setIsProcessing, setProcessStatus, applyAcrobatEdits]);

    useEffect(() => {
        const handleTriggerPrint = (e: Event) => {
            const detail = (e as CustomEvent<{ tabId?: string }>).detail;
            if (!isActive) return;
            if (detail?.tabId === tabId) {
                handlePrintFile();
            }
        };
        window.addEventListener('app-trigger-print', handleTriggerPrint);
        return () => window.removeEventListener('app-trigger-print', handleTriggerPrint);
    }, [isActive, tabId, handlePrintFile]);

    const handleExtractPages = async (viewerIndices: number[]): Promise<boolean> => {
        if (!store.getState().file || !onSpawnTab) return false;
        try {
            setIsProcessing(true);
            setProcessStatus(t('tabs.imposition:dang_boc_tach_file_pdf'));
            const selectionState = store.getState();
            const selectedInstanceIds = viewerIndices.map(
                index => selectionState.viewerPageInstanceIds?.[index] || '',
            );
            if (selectedInstanceIds.some(id => !id)) {
                throw new StaleWorkspaceDocumentRevisionError(
                    t('tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly'),
                );
            }
            // `prepare()` chờ mọi edit-object đang bay commit/publish. Chụp snapshot
            // SAU barrier rồi materialize đúng order/duplicate/rotation theo instance.
            await getCropWorkingFile.prepare();
            if (!isWorkingPageSelectionCurrent(
                viewerIndices,
                selectedInstanceIds,
                store.getState().viewerPageInstanceIds,
            )) {
                throw new StaleWorkspaceDocumentRevisionError(
                    t('tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly'),
                );
            }
            const snapshot = getCropWorkingFile.capture();
            if (!snapshot) throw new Error(t('tabs.imposition:loi_he_thong_khi_trich_xuat'));
            const workingFile = await getCropWorkingFile.materialize(snapshot);
            if (!getCropWorkingFile.isCurrent(snapshot)) {
                throw new StaleWorkspaceDocumentRevisionError(
                    t('tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly'),
                );
            }
            const extractedFile = await extractWorkingPagePositions(workingFile, viewerIndices);
            // CAS sát publication: job cũ không được mở tab kết quả từ revision
            // không còn hiển thị, và Viewer vì thế cũng không được xóa trang.
            if (!getCropWorkingFile.isCurrent(snapshot)) {
                throw new StaleWorkspaceDocumentRevisionError(
                    t('tabs.imposition:tai_lieu_da_thay_doi_trong_luc_xu_ly'),
                );
            }
            onSpawnTab(extractedFile);
            return true;
        } catch (e: unknown) {
            setError(errorMessage(e) || t('tabs.imposition:loi_he_thong_khi_trich_xuat'));
            return false;
        } finally {
            setIsProcessing(false);
            setProcessStatus('');
        }
    };


    // Derive tool info for upload phase
    const effectiveTool = initialFeature || lockedMode;
    const canSkipInitialUpload = !effectiveTool || canToolRunWithoutPdf(effectiveTool) || effectiveTool === 'sticker';
    const toolInfo = effectiveTool ? TOOL_REGISTRY.find(t => 
        t.defaultPayload?.focusFeature === effectiveTool || 
        t.defaultPayload?.lockedMode === effectiveTool || 
        t.id === effectiveTool
    ) : null;

    //#endregion

    // UIUX (audit 2026-08-22 §UX.MT.04): width hiệu dụng chỉ là derived layout;
    // không ghi đè preference khi viewport hẹp.
    const rightToolMenuWidth = effectiveToolMenuLayout.totalWidth;
    const displayedToolMenuLayout = sidebarDraftLayout === null
        ? effectiveToolMenuLayout
        : sidebarDraftLayout;
    const displayedIsSidebarOpen = displayedToolMenuLayout.mode === 'full';
    const effectiveRightToolMenuWidth = sidebarDraftLayout?.totalWidth
        ?? sidebarDraftTotalWidth
        ?? rightToolMenuWidth;
    const beginRightToolMenuDrag = (
        event: React.PointerEvent<HTMLDivElement>,
        target: 'outer' | 'catalog',
    ) => {
        event.preventDefault();
        sidebarDragPointerIdRef.current = event.pointerId;
        sidebarDraftLayoutRef.current = target === 'outer'
            ? { mode: effectiveToolMenuMode, fullWidth: sidebarWidth }
            : null;
        sidebarDraftEffectiveLayoutRef.current = null;
        sidebarDraftTotalWidthRef.current = null;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        sidebarDragRef.current = {
            startX: event.clientX,
            startTotalWidth: displayedToolMenuLayout.totalWidth,
            startFullWidth: sidebarWidth,
            startCatalogWidth: displayedToolMenuLayout.catalogWidth,
            startLayout: displayedToolMenuLayout,
            target,
        };
        setIsDraggingSidebar(true);
    };
    const activeToolDefinition = findToolByUniqueKey(activeDashboardTool);
    const activeToolLocked = !!activeToolDefinition
        && !canUse(activeToolDefinition.featureId, licensePlan, licenseFeatures);

    //#region Render
    return (
        <div ref={workspaceRootRef} className="relative w-full h-full flex flex-col bg-slate-50 dark:bg-[#1a1a1a]">
            {phase === 'upload' && fileOpeningPhase !== 'idle' && (
                <div className="flex-1 flex items-center justify-center px-6">
                    <div
                        className="inline-flex max-w-lg items-center gap-2.5 rounded-lg border border-slate-200/80 bg-white/80 px-3.5 py-2 text-sm shadow-sm backdrop-blur-sm dark:border-zinc-700/80 dark:bg-zinc-800/80 animate-fade-in"
                        role={fileOpeningPhase === 'error' ? 'alert' : 'status'}
                        aria-live="polite"
                    >
                        {fileOpeningPhase === 'error' ? (
                            <svg className="h-4 w-4 shrink-0 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v3m0 4h.01M10.3 3.7 2.2 18a2 2 0 0 0 1.8 3h16a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
                            </svg>
                        ) : (
                            <div className="h-4 w-4 shrink-0 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" aria-hidden="true" />
                        )}
                        <div className="min-w-0">
                            <p className="font-medium text-slate-600 dark:text-zinc-300">
                                {fileOpeningPhase === 'error'
                                    ? error || t('tabs.imposition:khong_doc_duoc_file_anh')
                                    : fileOpeningPhase === 'slow'
                                        ? t('tabs.imposition:mo_file_cham')
                                        : t('tabs.imposition:dang_mo_file')}
                            </p>
                            {(fileOpeningPhase === 'slow' || fileOpeningPhase === 'error') && (
                                <div className="mt-2 flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={retryFileOpening}
                                        className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
                                    >
                                        {t('tabs.imposition:thu_lai')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={cancelFileOpening}
                                        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700"
                                    >
                                        {t('tabs.imposition:huy_bo')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {phase === 'upload' && fileOpeningPhase === 'idle' && (
                <div className="flex-1 flex flex-col items-center justify-center py-12 px-6">
                    <div className="text-center mb-10 animate-fade-in">
                        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">
                            {toolInfo ? `🚀 ${toolInfo.title}` : t('tabs.imposition:cong_cu_binh_bai_xu_ly_ai')}
                        </h1>
                        <p className="text-slate-600 dark:text-zinc-400 transition-colors max-w-2xl mx-auto leading-relaxed">
                            {toolInfo ? toolInfo.longDescription : t('tabs.imposition:hoat_dong_offline_100_ho_tro_tinh_toan')}
                        </p>
                    </div>
                    <div className="max-w-xl w-full animate-slide-up">
                        <PDFUploader
                            label={toolInfo ? t('tabs.imposition:tai_file_len_de_tiep_tuc') : t('tabs.imposition:keo_tha_pdf_ban_thao_single_pages')}
                            sublabel={
                                toolInfo ?
                                t('tabs.imposition:ban_dang_mo_cong_cu_chon_file_pdf', { tool: toolInfo.title })
                                : t('tabs.imposition:catalog_tap_chi_sach_truyen_can_long')
                            }
                            onFileSelected={handleFileSelected}
                            isUploading={false}
                            uploadedName=""
                            accentColor="#10b981"
                        />
                        {canSkipInitialUpload && <button
                            onClick={() => {
                                if (effectiveTool === 'sticker' && tabId) setStickerSheetMode(tabId, 'ai-sheet');
                                setPhase('workspace');
                            }}
                            className="mt-6 w-full py-2.5 rounded-lg border-2 border-dashed border-slate-300 dark:border-zinc-700 bg-transparent text-slate-500 dark:text-zinc-400 font-medium hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-700 dark:hover:text-zinc-300 transition-all text-[13px]"
                        >
                            {effectiveTool === 'sticker'
                                ? tv('Tách tem từ ảnh AI')
                                : t('tabs.imposition:bo_qua_tai_file_vao_khong_gian_lam_viec')}
                        </button>}
                    </div>
                </div>
            )}

            {phase === 'workspace' && (
                <div className="flex-1 flex flex-row overflow-hidden relative animate-fade-in">
                    <RecipePanel
                        open={showRecipePanel}
                        onClose={() => setShowRecipePanel(false)}
                        onPlay={playRecipe}
                        sourcePageCount={viewerNumPages}
                        hasFile={!!file}
                    />
                    {confirmBookletSettings && createPortal(
                        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setConfirmBookletSettings(null)} onKeyDown={e => { if (e.key === 'Escape') setConfirmBookletSettings(null); }} tabIndex={-1} ref={el => el?.focus()}>
                            {/* UIUX (audit 2026-07-27 §B-20): Esc/Enter mức document — không phụ thuộc focus ref */}
                            <DialogKeys
                                onCancel={() => setConfirmBookletSettings(null)}
                                onConfirm={() => {
                                    const finalSettings = { ...(confirmBookletSettings.settings as unknown as RecipeSettingsView), blankPlacement: confirmBlankPlacement };
                                    processEngine(finalSettings as ProcessingSettings, confirmBookletSettings.spawnNewTab);
                                    setConfirmBookletSettings(null);
                                }}
                            />
                            <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}>
                                <div className="p-5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                                    <h2 className="text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                                        <span>🛑</span> {t('tabs.imposition:xac_nhan_binh_sach')}
                                    </h2>
                                </div>
                                <div className="p-6">
                                    <p className="text-slate-700 dark:text-zinc-300 mb-4 text-[15px]">
                                        {t('tabs.imposition:file_pdf_goc_gom')} <strong>{confirmBookletSettings.totalPages} {t('tabs.imposition:trang')}</strong>.
                                        {confirmBookletSettings.totalPages > 0 && confirmBookletSettings.totalPages !== confirmBookletSettings.paddedPages && (confirmBookletSettings.settings as unknown as RecipeSettingsView).bindingMode !== 'flush_mount' && (
                                            <span className="text-emerald-600 dark:text-emerald-400 font-medium ml-1">
                                                {t('tabs.imposition:can_them_n_trang_trang_lam_tron', { add: confirmBookletSettings.paddedPages - confirmBookletSettings.totalPages, total: confirmBookletSettings.paddedPages })}
                                            </span>
                                        )}
                                    </p>
                                    {confirmBookletSettings.totalPages > 0 && confirmBookletSettings.totalPages !== confirmBookletSettings.paddedPages && (confirmBookletSettings.settings as unknown as RecipeSettingsView).bindingMode !== 'flush_mount' && (
                                        <div className="mb-5">
                                            <label className="text-[12px] text-slate-500 font-medium block mb-2">
                                                {t('tabs.imposition:dat_n_trang_trang_o_dau', { n: confirmBookletSettings.paddedPages - confirmBookletSettings.totalPages })}
                                            </label>
                                            <div className="grid grid-cols-2 gap-2">
                                                {(([['end', t('tabs.imposition:cuoi_sach'), t('tabs.imposition:don_vao_cuoi_bia_sau_mac_dinh')], ['center', t('tabs.imposition:giua_sach'), t('tabs.imposition:nhet_vao_ruot_trong_cung_bia_trang_dau')]]) as const).map(([val, title, desc]) => (
                                                    <button key={val} type="button" onClick={() => setConfirmBlankPlacement(val)}
                                                        className={`text-left p-3 rounded-lg border-2 transition-colors ${confirmBlankPlacement === val ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'}`}>
                                                        <div className="text-[13px] font-bold text-slate-800 dark:text-white">{title}</div>
                                                        <div className="text-[11px] text-slate-500 dark:text-zinc-400 mt-0.5 leading-snug">{desc}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {confirmBookletSettings.report && (
                                        <div className="mb-5 text-[13px] text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 p-3 rounded-lg leading-relaxed">
                                            {confirmBookletSettings.report}
                                        </div>
                                    )}
                                    <p className="text-slate-600 dark:text-zinc-400 text-sm">
                                        {t('tabs.imposition:ban_co_chac_chan_muon_tien_hanh_binh')}
                                    </p>
                                </div>
                                <div className="p-4 bg-slate-50 dark:bg-zinc-900/50 flex justify-end gap-3 border-t border-slate-200 dark:border-white/10 mt-2">
                                    <Button variant="secondary" onClick={() => setConfirmBookletSettings(null)}>{t('tabs.imposition:huy_bo')}</Button>
                                    <Button variant="primary" onClick={() => {
                                        const finalSettings = { ...(confirmBookletSettings.settings as unknown as RecipeSettingsView), blankPlacement: confirmBlankPlacement };
                                        processEngine(finalSettings, confirmBookletSettings.spawnNewTab);
                                        setConfirmBookletSettings(null);
                                    }}>{t('tabs.imposition:dong_y_khoi_chay')}</Button>
                                </div>
                            </div>
                        </div>,
                        document.body
                    )}

                    {/* UIUX (audit 2026-07-27 §B-23): whitespace-pre-line để dòng "hướng khắc phục" của formatError xuống hàng */}
                    {error && (
                        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-200 px-4 py-3 rounded shadow-lg z-[130] flex items-center gap-3 whitespace-pre-line">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            {error}
                        </div>
                    )}



                    {/* Mở trang khuôn bằng Illustrator/CorelDRAW — nơi plugin máy bế đã cài sẵn */}
                    <OpenInDesignModal
                        open={showOpenInDesign}
                        onClose={() => setShowOpenInDesign(false)}
                        resultFilePath={(file as WorkspaceFileLike)?.path}
                        resultBlob={file}
                        separateCut={effectiveSeparateCut}
                        cncMode={activeDashboardTool === 'cnc_imposer'}
                        cncTwoSided={imposerStoreRef.current?.getState()?.duplexFlow === 'double'}
                        originalName={file?.name}
                        currentPage={viewerActivePage}
                    />

                    {/* Gửi Máy Bế — ĐÃ ẨN khỏi UI (kênh TCP/serial chưa kiểm chứng); giữ modal
                        trong cây để không mất code, nhưng không còn lối vào từ toolbar. */}
                    <CutExportModal
                        open={showCutExport}
                        onClose={() => setShowCutExport(false)}
                        sheetWmm={0}
                        sheetHmm={0}
                        paths={[]}
                        sourcePdfPath={(file as WorkspaceFileLike)?.path}
                        sourceName={file?.name}
                        defaultName={(originalFileName || 'cut').replace(/\.pdf$/i, '')}
                        currentPage={viewerActivePage}
                    />

                    {/* LEFT: Acrobat Workspace */}
                    <div className="flex-1 relative z-0">
                        {isProcessing && (
                            <div className="absolute inset-0 bg-[#525659]/70 backdrop-blur-sm z-[120] flex flex-col items-center justify-center text-white">
                                <div className="flex items-center gap-3">
                                    <div className="w-5 h-5 border-2 border-white/25 border-t-white/90 rounded-full animate-spin"></div>
                                    <span className="text-sm font-medium text-white/90">{processStatus}</span>
                                </div>
                                {processCancelHandler && (
                                    <button
                                        type="button"
                                        onClick={() => void processCancelHandler().catch((err) => setError(err?.message || String(err)))}
                                        className="mt-5 rounded-md border border-white/20 px-4 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10"
                                    >
                                        {t('tabs.imposition:huy_bo_cancel')}
                                    </button>
                                )}
                            </div>
                        )}

                        <OutputPreviewHost onFileFixed={commitToolWorkingFile} />

                        {activeDashboardTool === 'document_cleanup' && (
                            <DocumentCleanupDropReceiver
                                tabId={tabId || ''}
                                isActive={isActive === true}
                            />
                        )}

                        {activeDashboardTool === 'bgremover' && (
                            <div className="absolute top-0 left-0 bottom-0 z-40" style={{ right: effectiveRightToolMenuWidth }}>
                                <BgRemoverPreview tabId={tabId || ''} isActive={isActive === true} />
                            </div>
                        )}

                        {activeDashboardTool === 'document_cleanup' && shouldShowDocumentCleanupOverlay(!!file, !!sourceImageFileForRevision) && (
                            // UIUX (feedback 2026-08-21 §DOC.VIEW.01): toolbar Acrobat cao 48 px
                            // vẫn phải dùng được; bắt đầu workspace ngay dưới toolbar để các cụm
                            // Ảnh gốc/Kết quả và thu phóng không bị toolbar che mất.
                            <div className="absolute top-12 left-0 bottom-0 z-40" style={{ right: effectiveRightToolMenuWidth }}>
                                <DocumentCleanupPreview tabId={tabId || ''} isActive={isActive === true} />
                            </div>
                        )}

                        {activeDashboardTool === 'upscale' && (
                            <div className="absolute top-0 left-0 bottom-0 z-40" style={{ right: effectiveRightToolMenuWidth }}>
                                <UpscalePreview tabId={tabId || ''} isActive={isActive === true} />
                            </div>
                        )}

                        {LOGO_REBUILD_ENABLED && logoWorkspaceOpened && (
                            <div
                                data-testid="logo-rebuild-overlay"
                                aria-hidden={activeDashboardTool !== 'logo_rebuild'}
                                // UIUX (audit 2026-08-12 §LOGO.UI.01): viewer có toolbar z-70,
                                // ruler z-40 và nút sidebar z-100; workspace công cụ phải phủ
                                // toàn bộ viewer nhưng vẫn nằm dưới processing/error/modal.
                                className={`absolute inset-y-0 left-0 z-[110] ${activeDashboardTool === 'logo_rebuild' ? '' : 'hidden'}`}
                                style={{ right: effectiveRightToolMenuWidth }}
                            >
                                <LogoRebuildWorkspace
                                    tabId={tabId || ''}
                                    isActive={isActive === true && activeDashboardTool === 'logo_rebuild'}
                                    isLocked={activeToolLocked}
                                    hasOtherDirtyChanges={documentIsDirty}
                                    onDirtyChange={setLogoSessionDirty}
                                />
                            </div>
                        )}

                        {/* Empty State Overlay — ẩn khi tool không cần PDF sẵn (AI / office convert / util) */}
                        {!pdfUrl && !canToolRunWithoutPdf(activeDashboardTool) && !(activeDashboardTool === 'sticker' && stickerSheetMode === 'ai-sheet') && (
                            <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none" style={{ right: effectiveRightToolMenuWidth }}>
                                <div className="pointer-events-auto max-w-2xl w-full px-6">
                                    <div 
                                        className={`w-full relative bg-white dark:bg-zinc-900 rounded-[2rem] border-[3px] border-dashed border-indigo-200 dark:border-indigo-900/60 hover:border-indigo-500 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/20 transition-all cursor-pointer flex flex-col xl:flex-row items-center justify-center gap-6 xl:gap-10 shadow-lg hover:shadow-xl hover:shadow-indigo-500/10 group shrink-0 p-8 md:p-14`}
                                        onClick={() => document.getElementById('workspace-empty-upload')?.click()}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                                handleFileSelected(e.dataTransfer.files[0]);
                                            }
                                        }}
                                    >
                                        <input 
                                            id="workspace-empty-upload" 
                                            type="file" 
                                            accept="application/pdf,image/png,image/jpeg,image/jpg" 
                                            className="hidden" 
                                            onChange={(e) => {
                                                if (e.target.files && e.target.files[0]) {
                                                    handleFileSelected(e.target.files[0]);
                                                }
                                            }}
                                        />
                                        <div className={`shrink-0 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 rounded-3xl flex items-center justify-center group-hover:scale-110 group-hover:-rotate-3 transition-transform drop-shadow-sm w-24 h-24 md:w-28 md:h-28 text-6xl md:text-7xl`}>📁</div>
                                        <div className="text-center xl:text-left flex-1 min-w-0">
                                           <h2 className={`font-black text-slate-800 dark:text-white tracking-tight text-2xl md:text-3xl mb-2 md:mb-3`}>{t('tabs.imposition:mo_file_pdf')}</h2>
                                           <p className="text-slate-500 dark:text-zinc-400 font-medium text-[13px] md:text-[14px] leading-relaxed w-full">{t('tabs.imposition:click_chon_hoac_keo_tha_file_pdf_vao')}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Main workspace is always AcrobatViewer */}
                                <AcrobatViewer
                                    isActive={isActive}
                                    tabId={tabId}
                                    initialViewState={documentWindow?.initialViewState}
                                    onInitialViewStateApplied={documentWindow?.onInitialViewStateApplied}
                                    pageOverlay={classicCutlineOverlay ? (
                                        <ClassicCutlinePageOverlay
                                            preview={classicCutlineOverlay.preview}
                                            isUpdating={classicCutlineOverlay.isUpdating}
                                        />
                                    ) : undefined}
                                    pageOverlayRenderer={activeDashboardTool === 'sticker'
                                        && stickerSheetMode === 'ai-sheet'
                                        && stickerSheetSourceVisible
                                        ? renderStickerSheetPageOverlay
                                        : undefined}
                                    pageOverlayPage={stickerSheetActiveSourcePage}
                                    pageOverlayViewerPage={classicCutlineOverlay?.viewerPage}
                                    pageOverlayInstanceId={classicCutlineOverlay?.pageInstanceId}
                                    pageWorkflowStatuses={activeDashboardTool === 'sticker'
                                        && stickerSheetMode === 'ai-sheet'
                                        && stickerSheetSourceVisible
                                        ? stickerSheetPageStatuses
                                        : undefined}
                                    cutlinePreviews={thumbnailCutlinePreviews}
                                    pendingHistoryEntry={pendingHistoryEntry}
                                    onHistoryEntryHydrated={handleHistoryEntryHydrated}
                                    restoredHistoryDirty={restoredHistoryDirtyFile === file}
                                    onViewerDirtyChange={setViewerDirty}
                                    onExtractPages={handleExtractPages}
                                    onObjectDelete={handleDeleteObjects}
                                    fetchObjectsForPage={fetchPdfObjectsForPage}
                                    onEditCommit={handleEditCommit}
                                    onDocumentUndo={handleUndo}
                                    editSession={editSession}
                                    onVdpBoxCreate={handleVdpBoxCreate}
                                    toolbarExtra={file ? (
                                        <RecipeRecordControl
                                            tabId={recipeOwnerTabId}
                                            onOpenPanel={() => setShowRecipePanel(true)}
                                            sourcePageCount={viewerNumPages}
                                            disabled={isRecipePlaying}
                                        />
                                    ) : undefined}
                                    toolbarExtraRight={file ? (
                                        <div className="flex items-center gap-2">
                                            {/* In: luôn hiện khi có file (Ctrl+P / File→In vẫn dùng).
                                                Trước chỉ hiện với file Imposed_* → mở PDF thường tưởng mất nút. */}
                                            <button
                                                onClick={handlePrintFile}
                                                className="h-8 px-3 rounded bg-sky-600 hover:bg-sky-700 text-white text-[13px] font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                                                title={t('tabs.imposition:in_ctrl_p')}
                                            >
                                                <Printer className="w-4 h-4" /> {t('tabs.imposition:in')}
                                            </button>
                                            {/* Bế: luôn hiện khi có file (mở trang khuôn/file bằng Illustrator hoặc CorelDRAW).
                                                Trước chỉ hiện với file Imposed_* → lưu file ra đĩa rồi mở lại bị mất nút. */}
                                            <button
                                                onClick={() => setShowOpenInDesign(true)}
                                                className="h-8 px-3 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                                                title={t('tabs.imposition:mo_trang_khuon_bang_illustrator_corel')}
                                            >
                                                <Scissors className="w-4 h-4" /> {t('tabs.imposition:be')}
                                            </button>
                                        </div>
                                    ) : undefined}
                                    rightPanel={(
                                        <div
                                            style={{ width: `${effectiveRightToolMenuWidth}px` }}
                                            className="shrink-0 bg-[#f8fafc] dark:bg-zinc-900 shadow-[-10px_0_30px_rgba(0,0,0,0.05)] flex flex-row justify-end z-20 h-full relative border-l border-slate-200 dark:border-zinc-800"
                                        >
                                        {/* Có thiết lập: mép ngoài chỉ đổi thiết lập; không có thì đổi catalog. */}
                                        {/* UIUX (audit 2026-07-27 §B-25): vùng bắt chuột rộng gấp đôi (w-2.5), chỉ vẽ 1px ở giữa — nhìn không đổi */}
                                        <div
                                            data-testid="workspace-panel-resize"
                                            className="absolute left-0 top-0 bottom-0 w-2.5 -ml-[5px] cursor-col-resize touch-none hover:bg-blue-500/50 active:bg-blue-500 z-50 transition-colors"
                                            onPointerDown={(event) => beginRightToolMenuDrag(event, 'outer')}
                                        >
                                            <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-app-line pointer-events-none" />
                                        </div>
                                        {/* UIUX (audit 2026-08-29): divider ở mép catalog resize chính catalog;
                                            panel thiết lập đứng yên, Viewer nhận/trả phần chiều rộng thay đổi. */}
                                        {hasActiveRightTool && displayedIsSidebarOpen && (
                                            <div
                                                data-testid="workspace-catalog-resize"
                                                style={{ right: `${displayedToolMenuLayout.catalogWidth}px` }}
                                                role="separator"
                                                aria-orientation="vertical"
                                                className="group absolute top-0 bottom-0 z-50 w-2.5 translate-x-1/2 cursor-col-resize touch-none hover:bg-blue-500/10 active:bg-blue-500/20"
                                                onPointerDown={(event) => beginRightToolMenuDrag(event, 'catalog')}
                                            >
                                                <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-app-line transition-colors group-hover:bg-blue-500" />
                                            </div>
                                        )}
                                        
                                        {/* Main Config Panel */}
                                        {hasActiveRightTool && (
                                            <div
                                                className="flex flex-col overflow-hidden border-r border-slate-200 dark:border-zinc-800"
                                                style={{
                                                    flexBasis: `${displayedToolMenuLayout.configWidth}px`,
                                                    flexGrow: 0,
                                                    flexShrink: 0,
                                                }}
                                            >
                                                {/* Sidebar Header */}
                                                <div className="px-4 h-12 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-slate-100 dark:bg-[#1a1a1a] shrink-0 shadow-sm relative z-10">
                                                    <h2 className="text-[13px] font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5 uppercase tracking-wide">
                                                        {/* UIUX (audit 2026-08-22 §RM.DUAL-PANEL): catalog cạnh bên đã đảm nhiệm điều hướng;
                                                            header chỉ giữ thông tin file và các hành động của panel. */}
                                                        {(activeDashboardTool !== 'bgremover' && activeDashboardTool !== 'upscale' && (activeDashboardTool !== 'document_cleanup' || (!!file && !sourceImageFileForRevision))) && fileSizeStr && (
                                                            <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono normal-case tracking-normal border pl-1.5 pr-1.5 py-0.5 rounded-full border-black/5 dark:border-white/5">{fileSizeStr}</span>
                                                        )}
                                                    </h2>
                                                    <div className="flex items-center gap-1">
                                                        {isVdpPanel && (
                                                            <>
                                                                <button
                                                                    onClick={handleSaveVdpTemplate}
                                                                    disabled={!vdpFields || vdpFields.length === 0}
                                                                    className="w-7 h-7 flex items-center justify-center hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                                    title={t('tabs.imposition:luu_mau_bo_cuc_field_json')}
                                                                    aria-label={t('tabs.imposition:luu_mau_bo_cuc')}
                                                                >
                                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                                                                </button>
                                                                <button
                                                                    onClick={handleLoadVdpTemplate}
                                                                    className="w-7 h-7 flex items-center justify-center hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded transition-colors"
                                                                    title={t('tabs.imposition:tai_mau_bo_cuc_field_json')}
                                                                    aria-label={t('tabs.imposition:tai_mau_bo_cuc')}
                                                                >
                                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="4" x2="12" y2="16"/></svg>
                                                                </button>
                                                                <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700 mx-0.5" />
                                                            </>
                                                        )}
                                                        {(activeDashboardTool === 'booklet' || activeDashboardTool === 'nup' || activeDashboardTool === 'sticker_imposer') && (
                                                            <button
                                                                onClick={() => setIsPresetOpen(true)}
                                                                className="w-7 h-7 flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-500 rounded transition-colors"
                                                                title={t('tabs.imposition:tai_preset_san_pham')}
                                                                aria-label={t('tabs.imposition:tai_preset_san_pham')}
                                                            >
                                                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                                                            </button>
                                                        )}

                                                        {(isObjectEditMode ? (editSession.canUndo || editHistory.canUndo) : history.length > 0) && activeDashboardTool !== 'bgremover' && activeDashboardTool !== 'upscale' && (activeDashboardTool !== 'document_cleanup' || (!!file && !sourceImageFileForRevision)) && (
                                                            <button
                                                                onClick={() => { if (isObjectEditMode) { if (editSession.canUndo) void editSession.undo(); else editHistory.undo(); } else handleUndo(); }}
                                                                className="w-7 h-7 flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-500 rounded transition-colors"
                                                                title={t('tabs.imposition:hoan_tac_thao_tac_truoc_ctrl_z')}
                                                                aria-label={t('tabs.imposition:hoan_tac_thao_tac_truoc')}
                                                            >
                                                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                                            </button>
                                                        )}


                                                        <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700 mx-0.5" />

                                                        <button
                                                            onClick={closeActiveToolPanel}
                                                            className="w-7 h-7 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 rounded transition-colors"
                                                            title={t('tabs.imposition:dong_thiet_lap_cong_cu')}
                                                            aria-label={t('tabs.imposition:dong_thiet_lap_cong_cu')}
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                </div>

                                                <div
                                                    inert={toolInputBlockedByEdit}
                                                    aria-busy={toolInputBlockedByEdit}
                                                    className="p-4 overflow-y-auto flex-1 flex flex-col text-sm text-slate-800 dark:text-zinc-200 scroller-thin relative bg-[#f8fafc] dark:bg-zinc-900 border-t border-black/5 dark:border-white/5"
                                                >
                                                    {toolInputBlockedByEdit && (
                                                        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-white/80 px-4 text-center backdrop-blur-[1px] dark:bg-zinc-900/80">
                                                            <div className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200">
                                                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-orange-500" />
                                                                {t('tabs.imposition:dang_chot_chinh_sua_pdf', {
                                                                    defaultValue: 'Đang chốt thay đổi Edit PDF…',
                                                                })}
                                                            </div>
                                                        </div>
                                                    )}
                                                    {rightPanelKind === 'edit' ? (
                                                        <EditLayersPanel
                                                            tabId={tabId}
                                                            // Unified OCG + Components panel for Edit PDF upgrade
                                                            handleDeleteObjects={handleDeleteObjects}
                                                            editObjects={currentEditObjects || []}
                                                            isEditMode={isObjectEditMode}
                                                            editSession={editSession}
                                                        />
                                                    ) : rightPanelKind === 'datamerge' ? (
                                                        <DataMergeTool
                                                            pdfFile={file}
                                                            getWorkingFile={getWorkingFile}
                                                            vdpFields={vdpFields}
                                                            setVdpFields={setVdpFields}
                                                            selectedFieldIds={selectedVdpFieldIds}
                                                            onSelectField={(ids) => setSelectedVdpFieldIds(ids)}
                                                            isActive={isActive}
                                                            onApplyResult={async (blob: Blob, name: string, path?: string) => {
                                                                const recipeTicket = recipeRecorder.noteNonRecordable(
                                                                    'datamerge',
                                                                    undefined,
                                                                    recipeOwnerTabId,
                                                                );
                                                                if (recipeRecorder.isRecordingFor(recipeOwnerTabId) && !recipeTicket) {
                                                                    toast.info(t('tabs.imposition:dang_xu_ly_file'));
                                                                    return;
                                                                }
                                                                try {
                                                                    await commitWorkingFile(
                                                                        blob,
                                                                        name,
                                                                        path,
                                                                        recipeTicket,
                                                                        renderedDocumentRevision,
                                                                    );
                                                                } finally {
                                                                    recipeRecorder.discardPending(recipeTicket);
                                                                }
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                            }}
                                                            onSpawnTab={(blob: Blob, name: string, path?: string) => {
                                                                const newFile = new File([blob], name, { type: 'application/pdf' });
                                                                copyArtifactLeaseToken(blob, newFile);
                                                                if (path) {
                                                                    Object.defineProperty(newFile, 'path', { value: path });
                                                                }
                                                                markGeneratedWorkspaceFile(newFile);
                                                                if (onSpawnTab) {
                                                                    onSpawnTab(newFile);
                                                                }
                                                            }}
                                                        />
                                                    ) : rightPanelKind === 'numbering' ? (
                                                        <NumberingTool
                                                            pdfFile={file}
                                                            getWorkingFile={getWorkingFile}
                                                            vdpFields={vdpFields}
                                                            setVdpFields={setVdpFields}
                                                            selectedFieldIds={selectedVdpFieldIds}
                                                            onSelectField={(ids) => setSelectedVdpFieldIds(ids)}
                                                            isActive={isActive}
                                                            onApplyResult={async (blob: Blob, name: string, path?: string) => {
                                                                const recipeTicket = recipeRecorder.noteNonRecordable(
                                                                    'numbering',
                                                                    undefined,
                                                                    recipeOwnerTabId,
                                                                );
                                                                if (recipeRecorder.isRecordingFor(recipeOwnerTabId) && !recipeTicket) {
                                                                    toast.info(t('tabs.imposition:dang_xu_ly_file'));
                                                                    return;
                                                                }
                                                                try {
                                                                    await commitWorkingFile(
                                                                        blob,
                                                                        name,
                                                                        path,
                                                                        recipeTicket,
                                                                        renderedDocumentRevision,
                                                                    );
                                                                } finally {
                                                                    recipeRecorder.discardPending(recipeTicket);
                                                                }
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                            }}
                                                            onSpawnTab={(blob: Blob, name: string, path?: string) => {
                                                                const newFile = new File([blob], name, { type: 'application/pdf' });
                                                                copyArtifactLeaseToken(blob, newFile);
                                                                if (path) {
                                                                    Object.defineProperty(newFile, 'path', { value: path });
                                                                }
                                                                markGeneratedWorkspaceFile(newFile);
                                                                if (onSpawnTab) {
                                                                    onSpawnTab(newFile);
                                                                }
                                                            }}
                                                        />
                                                    ) : rightPanelKind === 'cover_numbering' ? (
                                                        <CoverNumberingTool
                                                            pdfFile={file}
                                                            getWorkingFile={getWorkingFile}
                                                            workingPageCount={viewerPageOrder?.length ?? viewerNumPages}
                                                            vdpFields={vdpFields}
                                                            setVdpFields={setVdpFields}
                                                            selectedFieldIds={selectedVdpFieldIds}
                                                            onSelectField={(ids) => setSelectedVdpFieldIds(ids)}
                                                            isActive={isActive}
                                                            onApplyResult={async (blob: Blob, name: string, path?: string) => {
                                                                const recipeTicket = recipeRecorder.noteNonRecordable(
                                                                    'cover_numbering',
                                                                    undefined,
                                                                    recipeOwnerTabId,
                                                                );
                                                                if (recipeRecorder.isRecordingFor(recipeOwnerTabId) && !recipeTicket) {
                                                                    toast.info(t('tabs.imposition:dang_xu_ly_file'));
                                                                    return;
                                                                }
                                                                try {
                                                                    await commitWorkingFile(
                                                                        blob,
                                                                        name,
                                                                        path,
                                                                        recipeTicket,
                                                                        renderedDocumentRevision,
                                                                    );
                                                                } finally {
                                                                    recipeRecorder.discardPending(recipeTicket);
                                                                }
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                            }}
                                                            onSpawnTab={(blob: Blob, name: string, path?: string) => {
                                                                const newFile = new File([blob], name, { type: 'application/pdf' });
                                                                copyArtifactLeaseToken(blob, newFile);
                                                                if (path) {
                                                                    Object.defineProperty(newFile, 'path', { value: path });
                                                                }
                                                                markGeneratedWorkspaceFile(newFile);
                                                                if (onSpawnTab) onSpawnTab(newFile);
                                                            }}
                                                        />
                                                    ) : rightPanelKind === 'stick_text_number' ? (
                                                        <StickTextNumberTool
                                                            pdfFile={file}
                                                            onFileFixed={(blob, name) => commitToolWorkingFile(blob, name)}
                                                        />
                                                    ) : (
                                                        <ImposerDashboard
                                                            tabId={tabId || ''}
                                                            isActive={isActive}
                                                            onStartBooklet={handleStartBooklet}
                                                            onStartNup={handleStartNup}
                                                            onStartShuffle={handleStartShuffle}
                                                            onStartResize={handleStartResize}
                                                            onStartTrimShift={handleStartTrimShift}
                                                            onStartSplit={handleStartSplit}
                                                            onStartMerge={handleStartMerge}
                                                            onStartCatalogPlan={handleStartCatalogPlan}
                                                            initialFeature={initialFeature}
                                                            lockedMode={lockedMode}
                                                            onBleedUpdate={handleBleedUpdate}
                                                            onFileFixed={commitToolWorkingFile}
                                                            systemMergeFiles={systemMergeFiles}
                                                            officeSourceFile={officeSourceFile}
                                                            officeSourceFiles={officeSourceFiles}
                                                            sourceImageFile={sourceImageFileForRevision}
                                                            sourceImageReferenceFile={sourceImageFile}
                                                            getWorkingFile={getWorkingFile}
                                                            getPreparedWorkingFile={getPreparedWorkingFile}
                                                            ensureCropFileId={ensureCropFileId}
                                                            onCropApplied={handleCropApplied}
                                                            onCropClose={handleCropClose}
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        
                                        {/* UIUX (audit 2026-08-22 §RM.DUAL-PANEL): full = thiết lập + catalog; icons = rail. */}
                                        {(
                                            <div
                                                className="relative h-full min-w-0 flex-1 overflow-hidden"
                                            >
                                                {/* UIUX (feedback 2026-08-27 §MENU.PARITY): đường biên của catalog do shell hoặc divider đảm nhiệm; không vẽ lặp border. */}
                                                <div
                                                    inert={!displayedIsSidebarOpen}
                                                    aria-hidden={!displayedIsSidebarOpen}
                                                    className={`absolute inset-y-0 right-0 z-10 flex flex-col overflow-hidden bg-slate-50 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none dark:bg-[#121212] ${displayedIsSidebarOpen ? 'pointer-events-auto translate-x-0 opacity-100' : 'pointer-events-none translate-x-1 opacity-0'}`}
                                                    style={{
                                                        width: `${displayedIsSidebarOpen
                                                            ? displayedToolMenuLayout.catalogWidth
                                                            : sidebarWidth}px`,
                                                    }}
                                                >
                                                        <div className="flex h-11 w-full shrink-0 items-center justify-end border-b border-slate-200 px-2 dark:border-zinc-800">
                                                            <button
                                                                type="button"
                                                                onClick={collapseWorkspaceSidebar}
                                                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-200 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
                                                                title={t('tabs.imposition:thu_gon_menu_2')}
                                                                aria-label={t('tabs.imposition:thu_gon_menu_2')}
                                                            >
                                                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                                                                </svg>
                                                            </button>
                                                        </div>
                                                        <ToolMenuList
                                                            setActiveTool={setActiveDashboardTool}
                                                            setTaskMode={(mode) => imposerStoreRef.current?.getState().setTaskMode(mode as TaskMode)}
                                                            onActiveToolChange={(tool) => {
                                                                if (tool === 'none') closeActiveToolPanel();
                                                                else setActiveDashboardTool(tool);
                                                            }}
                                                            activeTool={activeDashboardTool}
                                                        />
                                                </div>
                                                <div
                                                    inert={displayedIsSidebarOpen}
                                                    aria-hidden={displayedIsSidebarOpen}
                                                    className={`absolute inset-y-0 right-0 z-20 flex w-12 flex-col overflow-hidden border-l border-slate-200 bg-[#f8fafc] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none dark:border-zinc-800 dark:bg-zinc-900 ${displayedIsSidebarOpen ? 'pointer-events-none translate-x-1 opacity-0' : 'pointer-events-auto translate-x-0 opacity-100'}`}
                                                >
                                                        <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-black/5 dark:border-white/10">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    const next = resolveWorkspaceToolMenuToggle(displayedIsSidebarOpen);
                                                                    if (next.mode === 'full') openWorkspaceSidebar();
                                                                    else collapseWorkspaceSidebar();
                                                                }}
                                                                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-200 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-indigo-400"
                                                                title={t('tabs.imposition:mo_rong_menu')}
                                                                aria-label={t('tabs.imposition:mo_rong_menu')}
                                                            >
                                                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
                                                                </svg>
                                                            </button>
                                                        </div>

                                                        <div className="hide-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-0 overflow-x-hidden overflow-y-auto px-1 py-2">
                                                            {(() => {
                                                                const allDashboardTools = TOOL_CATEGORIES.flatMap(cat => getToolsByCategory(cat.id)).filter(tool => {
                                                                    const key = getToolUniqueKey(tool);
                                                                    return isWorkspaceTool(key) && key !== 'none';
                                                                });
                                                                const favTools = allDashboardTools.filter(tool => {
                                                                    const key = getToolUniqueKey(tool);
                                                                    return favoriteTools.includes(key) && !hiddenTools.includes(key);
                                                                });
                                                                if (favTools.length === 0) return null;

                                                                return (
                                                                    <div key="favorites" className="mb-1 flex w-full flex-col items-center">
                                                                        <div className="my-2 h-px w-5 rounded-full bg-amber-400/70" title={t('tabs.imposition:yeu_thich')} />
                                                                        <div className="flex w-full flex-col items-center gap-1.5">
                                                                            {favTools.map(tool => {
                                                                                const toolKey = getToolUniqueKey(tool);
                                                                                const isActive = activeDashboardTool === toolKey;
                                                                                return (
                                                                                    <button
                                                                                        key={`fav-${toolKey}`}
                                                                                        type="button"
                                                                                        onClick={() => {
                                                                                            if (activeDashboardTool === toolKey) {
                                                                                                closeActiveToolPanel();
                                                                                                return;
                                                                                            }
                                                                                            requestToolActivation(tool, () => {
                                                                                                setActiveDashboardTool(toolKey);
                                                                                            });
                                                                                        }}
                                                                                        className={`mx-auto flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-slate-700 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-app-accent dark:text-zinc-200 ${isActive ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' : 'hover:bg-slate-200 dark:hover:bg-zinc-800'}`}
                                                                                        title={tv(tool.title)}
                                                                                        aria-label={tv(tool.title)}
                                                                                        aria-pressed={isActive}
                                                                                    >
                                                                                        <span className="flex items-center justify-center text-[20px] leading-none">{tool.icon}</span>
                                                                                    </button>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}

                                                            {TOOL_CATEGORIES.map(cat => {
                                                                const catTools = getToolsByCategory(cat.id).filter(tool => {
                                                                    const toolKey = getToolUniqueKey(tool);
                                                                    if (!isWorkspaceTool(toolKey) || toolKey === 'none') return false;
                                                                    if (hiddenTools.includes(toolKey)) return false;
                                                                    if (favoriteTools.includes(toolKey)) return false;
                                                                    return true;
                                                                });
                                                                if (catTools.length === 0) return null;

                                                                return (
                                                                    <div key={cat.id} className="mb-1 flex w-full flex-col items-center">
                                                                        <div className="my-2 h-px w-5 rounded-full bg-slate-300 dark:bg-zinc-700" title={tv(cat.title)} />
                                                                        <div className="flex w-full flex-col items-center gap-1.5">
                                                                            {catTools.map(tool => {
                                                                                const toolKey = getToolUniqueKey(tool);
                                                                                const isActive = activeDashboardTool === toolKey;
                                                                                return (
                                                                                    <button
                                                                                        key={toolKey}
                                                                                        type="button"
                                                                                        onClick={() => {
                                                                                            if (activeDashboardTool === toolKey) {
                                                                                                closeActiveToolPanel();
                                                                                                return;
                                                                                            }
                                                                                            requestToolActivation(tool, () => {
                                                                                                setActiveDashboardTool(toolKey);
                                                                                            });
                                                                                        }}
                                                                                        className={`mx-auto flex h-9 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-slate-700 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-app-accent dark:text-zinc-200 ${isActive ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'hover:bg-slate-200 dark:hover:bg-zinc-800'}`}
                                                                                        title={tv(tool.title)}
                                                                                        aria-label={tv(tool.title)}
                                                                                        aria-pressed={isActive}
                                                                                    >
                                                                                        <span className="flex items-center justify-center text-[20px] leading-none">{tool.icon}</span>
                                                                                    </button>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            />
                    </div>
                </div>
            )}

            <SaveModal
                handleSaveFile={handleSaveFile}
                onSavePrint={() => setShowSavePrintModal(true)}
            />

            <SavePrintFilesModal
                open={showSavePrintModal}
                onClose={() => setShowSavePrintModal(false)}
                resultBlob={file}
                separateCut={effectiveSeparateCut}
                cncMode={activeDashboardTool === 'cnc_imposer'}
                cncTwoSided={imposerStoreRef.current?.getState()?.duplexFlow === 'double'}
                originalName={file?.name}
            />

            {/* Hộp thoại in hợp nhất kiểu Acrobat (máy in/tỉ lệ/orientation + preview). */}
            {printDialog}

            {scaleConfirmModal && createPortal(
                <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => { scaleConfirmModal.resolve(false); setScaleConfirmModal(null); }} onKeyDown={e => { if (e.key === 'Escape') { scaleConfirmModal.resolve(false); setScaleConfirmModal(null); } }} tabIndex={-1} ref={el => el?.focus()}>
                    {/* UIUX (audit 2026-07-27 §B-20): Esc/Enter mức document — không phụ thuộc focus ref */}
                    <DialogKeys
                        onCancel={() => { scaleConfirmModal.resolve(false); setScaleConfirmModal(null); }}
                        onConfirm={() => { scaleConfirmModal.resolve(true); setScaleConfirmModal(null); }}
                    />
                    <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-200 dark:border-zinc-700" onClick={e => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-700 flex justify-between items-center bg-amber-50 dark:bg-amber-500/10">
                            <h3 className="text-lg font-bold text-amber-600 dark:text-amber-500 flex items-center gap-2">
                                <span className="material-symbols-outlined">warning</span>
                                {t('tabs.imposition:canh_bao_kich_thuoc')}
                            </h3>
                        </div>
                        <div className="px-6 py-6 text-slate-600 dark:text-slate-300">
                            {scaleConfirmModal.msg}
                        </div>
                        <div className="px-6 py-4 bg-slate-50 dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-700 flex justify-end gap-3">
                            <button
                                onClick={() => {
                                    scaleConfirmModal.resolve(false);
                                    setScaleConfirmModal(null);
                                }}
                                className="px-4 py-2 rounded-lg font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                            >
                                {t('tabs.imposition:huy_bo_cancel')}
                            </button>
                            <button
                                onClick={() => {
                                    scaleConfirmModal.resolve(true);
                                    setScaleConfirmModal(null);
                                }}
                                className="px-4 py-2 rounded-lg font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                            >
                                {t('tabs.imposition:tiep_tuc_thu_nho')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Custom Close Confirm Modal */}
            {showCloseConfirm && createPortal(
                <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 font-sans" onClick={() => setShowCloseConfirm(false)} onKeyDown={e => { if (e.key === 'Escape') setShowCloseConfirm(false); }} tabIndex={-1} ref={el => el?.focus()}>
                    {/* UIUX (audit 2026-07-27 §B-20): Esc/Enter mức document — không phụ thuộc focus ref */}
                    <DialogKeys onCancel={() => setShowCloseConfirm(false)} onConfirm={forceReset} />
                    <div className="bg-white dark:bg-[#1e1e1e] w-[380px] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10" onClick={e => e.stopPropagation()}>
                        <div className="p-6">
                            <h3 className="text-[16px] font-semibold text-slate-800 dark:text-white mb-2">
                                {t('tabs.imposition:dong_file_chua_luu')}
                            </h3>
                            <p className="text-[14px] text-slate-600 dark:text-zinc-300 leading-relaxed">
                                {t('tabs.imposition:file_nay_da_bi_thay_doi_nhung_chua_duoc')}
                            </p>
                        </div>
                        <div className="bg-slate-50 dark:bg-black/20 p-4 border-t border-slate-100 dark:border-white/5 flex justify-end gap-3">
                            <button
                                onClick={() => setShowCloseConfirm(false)}
                                className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors outline-none min-w-[90px]"
                            >
                                {t('tabs.imposition:huy_bo')}
                            </button>
                            <button
                                onClick={forceReset}
                                className="px-6 h-[38px] flex items-center justify-center rounded font-medium text-[13px] bg-red-600 hover:bg-red-700 text-white shadow-sm min-w-[120px] transition-colors outline-none"
                            >
                                {t('tabs.imposition:dong_khong_luu')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
            {isActive !== false && activeToolLocked && activeToolDefinition && (
                <FeatureAccessOverlay featureId={activeToolDefinition.featureId} onLeave={onRequestHome} />
            )}
        </div>
    );
    //#endregion
}
