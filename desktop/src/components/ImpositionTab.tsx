import { useCallback, useMemo, useEffect, useRef, useState, useContext } from 'react';
import { createPortal } from 'react-dom';
import { localFileUrl } from '../lib/localFileTransport';
import { TOOL_REGISTRY, TOOL_CATEGORIES, findToolByUniqueKey, getToolsByCategory, getToolUniqueKey } from '../lib/toolRegistry';

import PDFUploader from './PDFUploader';
import AcrobatViewer from './AcrobatViewer';
import type { ThumbPageWorkflowStatus } from './acrobat/ThumbSidebar';
import { useObjectEditHistory } from '../hooks/useObjectEditHistory';
import { useEditSession } from '../hooks/useEditSession';
import { useWorkingPdf } from '../hooks/useWorkingPdf';
import { ImpositionMode, type ProcessingSettings } from '../lib/pdfImposer';
import { Button } from './Button';
import { Printer, Scissors, Settings, Star } from 'lucide-react';
import { PDFDocument, degrees } from 'pdf-lib';
import { imageFileToPdfIfNeeded, isSupportedImageFileName } from '../lib/imageNormalizer';
import ImposerDashboard from './imposition-tools/ImposerDashboard';
import CutExportModal from './imposition-tools/cut-export/CutExportModal';
import OpenInDesignModal from './imposition-tools/OpenInDesignModal';
import { DEFAULT_CUT_BORDER_CONFIG, PREDEFINED_SIZES, isWorkspaceTool, resolveRightPanel, type BookletSettings, type NupSettings } from './imposition-tools/types';
import { ImposerSettingsContext, createImposerSettingsStore, useImposerSettingsStore } from './imposition-tools/useImposerSettingsStore';
import { resolveEffectiveSeparateCut } from './imposition-tools/pageSheetPolicy';
import { canUseRectangleStickerInking } from './imposition-tools/shapeDetectionPolicy';
import { disposeImposerPersistScope } from './imposition-tools/store/persist';
import { generateBindingMap } from '../lib/imposerEngine/VirtualMap';
import { getApiUrl, uploadPDF, authenticatedFetch } from '../lib/api';
import { recipeRecorder } from '../lib/recipe/RecipeRecorder';
import { isOutputFile, isImposedOutputFile } from '../lib/constants';
import { writeSnapshot, deleteSnapshot } from '../lib/recovery';
import { getFileArrayBuffer, detectColorSpace, stripBytesIfOnDisk } from '../lib/utils';
import { pageIndicesToPageNumbers } from '../lib/printPageSelection';
import { beginOptionalContentTransfer, finishOptionalContentTransfer } from '../lib/pdfOptionalContent';
import { saveVdpTemplate, loadVdpTemplate } from '../lib/vdpTemplate';
import OutputPreviewHost from './OutputPreviewHost';
import RecipeRecordControl from './recipe/RecipeRecordControl';
import RecipePanel from './recipe/RecipePanel';
import { toast } from './ui/Toast';
// UIUX (audit 2026-07-27 §B-20 + §B-23): phím tắt dialog + dịch lỗi kỹ thuật
import DialogKeys from './ui/DialogKeys';
import type { Recipe } from '../lib/recipe/recipeTypes';
import { firstDeniedRecipeStep, recipeStepAccessError } from '../lib/recipe/recipeEntitlements';
import DataMergeTool from './preprocess-tools/DataMergeTool';
import NumberingTool from './preprocess-tools/NumberingTool';
import CoverNumberingTool from './preprocess-tools/CoverNumberingTool';
import StickTextNumberTool from './preprocess-tools/StickTextNumberTool';
import SaveModal from './workspace/SaveModal';
import SavePrintFilesModal from './workspace/SavePrintFilesModal';
import { usePrintDialog } from './shared/usePrintDialog';
import EditLayersPanel from './workspace/SelectionLayersPanel';
import { useAppSettingsStore } from '../stores/appSettingsStore';

import { WorkspaceContext, createWorkspaceStore, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { clearTileUrlCacheForFile } from './workspace/LivePageFrame';
import { useShallow } from 'zustand/react/shallow';
import { globalPdfObjectCache } from '../stores/pdfObjectCache';
import { BgRemoverPreview } from './preprocess-tools/BgRemoverTool';
import { copyUpscaleResultIdentity, UpscalePreview } from './preprocess-tools/UpscaleTool';
import StickerSheetWorkspace from './preprocess-tools/StickerSheetWorkspace';
import { useStickerSheetStore } from './preprocess-tools/stickerSheetStore';
import {
    resolveStickerSourceSyncMarker,
    selectStickerSheetTabSummary,
    stickerSourceOwnerFromHistory,
    viewerShowsStickerSource,
} from './stickerSheetTabSelector';
import LogoRebuildWorkspace from './preprocess-tools/LogoRebuildWorkspace';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';
import { canToolRunWithoutPdf, LOGO_REBUILD_ENABLED, resolveDedicatedInitialTool } from './imposition-tools/sections/preprocessRouterTools';
import { registerActiveTabFeature } from '../lib/tabNavigation';
import { useToolActivationGuard } from '../hooks/useToolActivationGuard';
import { canUse } from '../lib/license/features';
import { useAuthStore } from '../stores/useAuthStore';
import ProFeatureBadge from './license/ProFeatureBadge';
import FeatureAccessOverlay from './license/FeatureAccessOverlay';

// Phase type is now defined in useWorkspaceStore

// Giới hạn số bản Undo cho luồng commit chính (mỗi entry là 1 File PDF ĐẦY ĐỦ bytes
// trong RAM). Không cap → file 50MB × N commit = leak vài GB/tab (audit RAM 2026-07-06).
// Cắt entry CŨ NHẤT (đầu mảng) khi vượt ngưỡng; undo vẫn pop từ cuối như cũ.
const MAX_HISTORY = 12;

type FileOpeningPhase = 'idle' | 'loading' | 'slow' | 'error';
const FILE_OPEN_SLOW_MS = 8_000;

interface Props {
    tabId?: string;
    isActive?: boolean;
    onDirtyChange?: (isDirty: boolean) => void;
    onTitleChange?: (title: string) => void;
    onSpawnTab?: (file: File, extraPayload?: any) => void;
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
}

export default function ImpositionTab(props: Props) {
    const [store] = useState(createWorkspaceStore);
    const imposerScope = props.tabId ? `tab:${props.tabId}` : undefined;
    const [imposerStore] = useState(() => {
        const nextStore = createImposerSettingsStore(imposerScope);
        const launchTool = props.lockedMode || props.initialRecovery?.feature || props.initialFeature;
        if (launchTool) nextStore.getState().setActiveDashboardTool(launchTool);
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

/**
 * Path "phù du" của backend: file tạm nằm trong thư mục uploads/results/temp, hoặc
 * tên dạng <uuid>.pdf do `/api/vdp/upload` sinh. KHÔNG được coi là đích lưu thật:
 * tác vụ dọn rác backend (TTL 26h, cleanup_orphan_files) sẽ xóa các file này → nếu
 * Ctrl+S ghi đè vào đó thì người dùng MẤT dữ liệu sau khi file bị dọn. Dùng để buộc
 * hộp thoại "chọn nơi lưu" và để bỏ qua snapshot recovery trỏ vào path sắp biến mất.
 */
export function isEphemeralBackendPath(p?: string | null): boolean {
    if (!p) return false;
    const norm = p.replace(/\\/g, '/').toLowerCase();
    if (/\/(uploads|results|temp)\//.test(norm)) return true;
    if (/\/[0-9a-f]{32}\.pdf$/.test(norm)) return true;
    return false;
}

function ImpositionTabInner({ tabId, isActive, onDirtyChange, onTitleChange, onSpawnTab, initialFile, initialReport, initialFeature, lockedMode, batchOutput: initialBatchOutput, systemMergeFiles, officeSourceFile, officeSourceFiles, initialRecovery, onRequestHome, imposerStoreRef }: Props & { imposerStoreRef: React.MutableRefObject<ReturnType<typeof createImposerSettingsStore> | null> }) {
  const { t } = useTranslation();
    const getCropWorkingFile = useWorkingPdf();
    //#region State & Hooks
    // ═══ All state from Zustand store ═══
    const {
        phase, setPhase, file, setFile, originalFileName, setOriginalFileName,
        pdfUrl, setPdfUrl, fileSizeStr, setFileSizeStr, highlightedIssue, setHighlightedIssue,
        isProcessing, setIsProcessing, processStatus, setProcessStatus, error, setError,
        history, setHistory, isSaved, setIsSaved, showSaveAsModal, setShowSaveAsModal,
        reportMsg, setReportMsg, viewerDirty, setViewerDirty, viewerPageOrder, setViewerPageOrder, setViewerPageInstanceIds,
        viewerPageRotations, setViewerPageRotations, bleedView, setBleedView,
        isDraggingSidebar, setIsDraggingSidebar,
        pdfObjectsVersion, setPdfObjectsVersion,
        isObjectEditMode,
        currentEditObjects,
        pdfOcgLayers, setPdfOcgLayers,
        selectedObjectIds, setSelectedObjectIds, hiddenObjectIds, setHiddenObjectIds,
        setLockedObjectIds,
        hiddenOcgLayerIds, setHiddenOcgLayerIds, setLockedOcgLayerIds,
        selectionFileId, setSelectionFileId, vdpFields, setVdpFields, isCropMode, setIsCropMode, commitCropSelection, setIsObjectEditMode, setViewerToolMode,
        selectedVdpFieldIds, setSelectedVdpFieldIds,
        showCloseConfirm, setShowCloseConfirm,
        viewerNumPages,
        viewerActivePage,
        viewerToolMode,
        setDetectedShapeType, setDetectedShapeParams, 
        setDetectedShapesByPage, setDetectedDimensionsByPage, setDetectedShapeParamsByPage,
        detectedDimensionsByPage,
        setViewerZoom, setViewerFitMode, setViewerPageDisplayMode
    } = useWorkspaceStore(useShallow(state => ({
        phase: state.phase, setPhase: state.setPhase, file: state.file, setFile: state.setFile, originalFileName: state.originalFileName, setOriginalFileName: state.setOriginalFileName,
        pdfUrl: state.pdfUrl, setPdfUrl: state.setPdfUrl, fileSizeStr: state.fileSizeStr, setFileSizeStr: state.setFileSizeStr, highlightedIssue: state.highlightedIssue, setHighlightedIssue: state.setHighlightedIssue,
        isProcessing: state.isProcessing, setIsProcessing: state.setIsProcessing, processStatus: state.processStatus, setProcessStatus: state.setProcessStatus, error: state.error, setError: state.setError,
        history: state.history, setHistory: state.setHistory, isSaved: state.isSaved, setIsSaved: state.setIsSaved, showSaveAsModal: state.showSaveAsModal, setShowSaveAsModal: state.setShowSaveAsModal,
        reportMsg: state.reportMsg, setReportMsg: state.setReportMsg, viewerDirty: state.viewerDirty, setViewerDirty: state.setViewerDirty, viewerPageOrder: state.viewerPageOrder, setViewerPageOrder: state.setViewerPageOrder, setViewerPageInstanceIds: state.setViewerPageInstanceIds,
        viewerPageRotations: state.viewerPageRotations, setViewerPageRotations: state.setViewerPageRotations, bleedView: state.bleedView, setBleedView: state.setBleedView,
        isDraggingSidebar: state.isDraggingSidebar, setIsDraggingSidebar: state.setIsDraggingSidebar,
        pdfObjectsVersion: state.pdfObjectsVersion, setPdfObjectsVersion: state.setPdfObjectsVersion,
        isObjectEditMode: state.isObjectEditMode,
        currentEditObjects: state.currentEditObjects,
        pdfOcgLayers: state.pdfOcgLayers, setPdfOcgLayers: state.setPdfOcgLayers,
        selectedObjectIds: state.selectedObjectIds, setSelectedObjectIds: state.setSelectedObjectIds, hiddenObjectIds: state.hiddenObjectIds, setHiddenObjectIds: state.setHiddenObjectIds,
        setLockedObjectIds: state.setLockedObjectIds,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds, setHiddenOcgLayerIds: state.setHiddenOcgLayerIds, setLockedOcgLayerIds: state.setLockedOcgLayerIds,
        selectionFileId: state.selectionFileId, setSelectionFileId: state.setSelectionFileId, vdpFields: state.vdpFields, setVdpFields: state.setVdpFields, isCropMode: state.isCropMode, setIsCropMode: state.setIsCropMode, commitCropSelection: state.commitCropSelection, setIsObjectEditMode: state.setIsObjectEditMode, setViewerToolMode: state.setViewerToolMode,
        selectedVdpFieldIds: state.selectedVdpFieldIds, setSelectedVdpFieldIds: state.setSelectedVdpFieldIds,
        showCloseConfirm: state.showCloseConfirm, setShowCloseConfirm: state.setShowCloseConfirm,
        viewerNumPages: state.viewerNumPages,
        viewerActivePage: state.viewerActivePage,
        viewerToolMode: state.viewerToolMode,
        setDetectedShapeType: state.setDetectedShapeType, setDetectedShapeParams: state.setDetectedShapeParams, 
        setDetectedShapesByPage: state.setDetectedShapesByPage, setDetectedDimensionsByPage: state.setDetectedDimensionsByPage, setDetectedShapeParamsByPage: state.setDetectedShapeParamsByPage,
        detectedDimensionsByPage: state.detectedDimensionsByPage,
        setViewerZoom: state.setViewerZoom, setViewerFitMode: state.setViewerFitMode, setViewerPageDisplayMode: state.setViewerPageDisplayMode
    })));

    // P1-T03: Use dedicated store for these (migrated)
    // DÙNG SELECTOR + useShallow: chỉ re-render khi 6 field này đổi. Trước đây gọi
    // useImposerSettingsStore() KHÔNG selector → subscribe TOÀN BỘ store → ImpositionTab
    // (cây lớn nhất) re-render mỗi khi ImposerDashboard set sourcePageDim/optimalData/
    // catalogPreview/capacities/fetchEpoch... → re-render cả cây nhiều lần × jsxDEV nặng
    // = góp phần "đơ ~3-4s lúc mở" (đo được trong Performance profile).
    const {
        activeDashboardTool, setActiveDashboardTool, setIsPresetOpen,
        batchOutput, setBatchOutput,
        confirmBookletSettings, setConfirmBookletSettings,
        impositionUnit, separateCutPage,
    } = useImposerSettingsStore(useShallow(s => ({
        activeDashboardTool: s.activeDashboardTool, setActiveDashboardTool: s.setActiveDashboardTool, setIsPresetOpen: s.setIsPresetOpen,
        batchOutput: s.batchOutput, setBatchOutput: s.setBatchOutput,
        confirmBookletSettings: s.confirmBookletSettings, setConfirmBookletSettings: s.setConfirmBookletSettings,
        impositionUnit: s.impositionUnit,
        separateCutPage: s.separateCutPage,
    })));
    const effectiveSeparateCut = resolveEffectiveSeparateCut(
        activeDashboardTool,
        impositionUnit,
        separateCutPage,
    );

    const { isWorkspaceSidebarOpen: isSidebarOpen, favoriteTools, hiddenTools } = useAppSettingsStore();
    const licensePlan = useAuthStore(state => state.licensePlan);
    const licenseFeatures = useAuthStore(state => state.licenseFeatures);
    const requestToolActivation = useToolActivationGuard();
    const setIsSidebarOpen = useAppSettingsStore(state => state.setWorkspaceSidebarOpen);
    const sidebarWidth = useAppSettingsStore(state => state.toolMenuWidth);
    const setSidebarWidth = useAppSettingsStore(state => state.setToolMenuWidth);
    const dedicatedInitialTool = resolveDedicatedInitialTool(initialFeature);
    const [logoSessionDirty, setLogoSessionDirty] = useState(false);
    const [logoWorkspaceOpened, setLogoWorkspaceOpened] = useState(
        () => activeDashboardTool === 'logo_rebuild' || dedicatedInitialTool === 'logo_rebuild',
    );
    const {
        stickerSheetMode,
        stickerSheetSourceFile,
        stickerSheetActiveSourcePage,
        stickerSheetPages,
        stickerSheetPageCount,
        stickerSheetSourceImageCount,
        stickerSheetBusy,
    } = useStickerSheetStore(useShallow(
        state => selectStickerSheetTabSummary(state, tabId),
    ));
    const setStickerSheetMode = useStickerSheetStore(state => state.setMode);
    const disposeStickerSheetTab = useStickerSheetStore(state => state.disposeTab);
    const stickerSheetPageStatuses = useMemo<Partial<Record<number, ThumbPageWorkflowStatus>> | undefined>(() => {
        if (stickerSheetMode !== 'ai-sheet' || !stickerSheetSourceFile) return undefined;
        const count = Math.max(
            1,
            stickerSheetPageCount,
            stickerSheetSourceImageCount,
            viewerPageOrder?.length || 0,
            viewerNumPages || 0,
        );
        const statuses: Partial<Record<number, ThumbPageWorkflowStatus>> = {};
        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
            const page = stickerSheetPages[pageNumber];
            if (page?.status === 'error') statuses[pageNumber] = 'error';
            else if (
                page?.isRefining
                || ['inspecting', 'detecting', 'confirming', 'exporting'].includes(page?.status || '')
            ) statuses[pageNumber] = 'processing';
            else if (page?.status === 'mask-review') statuses[pageNumber] = 'review';
            else if (page?.status === 'mask-ready') statuses[pageNumber] = 'ready';
            else statuses[pageNumber] = 'pending';
        }
        return statuses;
    }, [
        stickerSheetMode,
        stickerSheetPageCount,
        stickerSheetPages,
        stickerSheetSourceFile,
        stickerSheetSourceImageCount,
        viewerNumPages,
        viewerPageOrder,
    ]);
    const previousDashboardToolRef = useRef<string | null>(null);
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

    useEffect(() => {
        // UIUX (audit 2026-08-09 §LR3.04): giữ component mounted sau lần mở đầu
        // để đổi công cụ không làm mất editor/history/SVG đang dựng trong cùng tab.
        if (activeDashboardTool === 'logo_rebuild') setLogoWorkspaceOpened(true);
    }, [activeDashboardTool]);



    const [isMiniToolbarExpanded, setIsMiniToolbarExpanded] = useState(false);
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
    // Keep the Crop mode, the toolbar button, and the right-hand tool panel in sync.
    // Selecting Crop from the panel enables drawing; C/toolbar toggles promote the
    // same mode into the panel without opening a separate modal.
    useEffect(() => {
        const previous = previousDashboardToolRef.current;
        previousDashboardToolRef.current = activeDashboardTool;
        if (previous === null) {
            if (activeDashboardTool === 'crop' && !isCropMode) {
                setIsCropMode(true);
                setIsObjectEditMode(false);
                setViewerToolMode('pointer');
            }
            return;
        }
        if (previous !== activeDashboardTool) {
            if (activeDashboardTool === 'crop') {
                setIsCropMode(true);
                setIsObjectEditMode(false);
                setViewerToolMode('pointer');
            } else if (isCropMode) {
                setIsCropMode(false);
            }
            return;
        }
        if (isCropMode && activeDashboardTool !== 'crop') {
            setActiveDashboardTool('crop');
            setIsSidebarOpen(true);
        } else if (!isCropMode && activeDashboardTool === 'crop') {
            setActiveDashboardTool('none');
        }
    }, [activeDashboardTool, isCropMode, setActiveDashboardTool, setIsCropMode, setIsObjectEditMode, setViewerToolMode, setIsSidebarOpen]);
    // Lựa chọn vị trí trang trắng — chỉ hỏi trong dialog Xác nhận khi số trang lẻ tay.
    const [confirmBlankPlacement, setConfirmBlankPlacement] = useState<'end' | 'center'>('end');

    // Set initial report from props (once)
    useEffect(() => {
        if (initialReport && !reportMsg) setReportMsg(initialReport);
    }, []);

    // Tile cache là GLOBAL dùng chung mọi tab, key = `${pdfUrl}_...`. Gom mọi pdfUrl tab
    // này từng dùng, khi ĐÓNG tab (unmount) dọn hết tile của chúng → giải phóng bitmap
    // mà KHÔNG đụng tab khác (audit RAM 2026-07-06).
    const usedPdfUrlsRef = useRef<Set<string>>(new Set());
    useEffect(() => { if (pdfUrl) usedPdfUrlsRef.current.add(pdfUrl); }, [pdfUrl]);
    useEffect(() => {
        return () => {
            for (const u of usedPdfUrlsRef.current) clearTileUrlCacheForFile(u);
            usedPdfUrlsRef.current.clear();
        };
    }, []);

    const handleVdpBoxCreate = useCallback((box: { x: number; y: number; width: number; height: number; pageNum: number, type?: string, textContent?: string, name?: string }) => {
        const fieldId = `field_${Date.now()}`;
        setVdpFields(prev => {
            const newField: any = {
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
    }, []);

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
    }, [scaleConfirmModal, showCloseConfirm]);

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
            const sz = (file as any)?.size || 0;
            // History/native stub có path nhưng chưa biết size: coi là file lớn
            // cho pre-upload. Tác vụ cần file_id sẽ đăng ký path khi người dùng mở nó.
            if ((file as any).path && sz <= 0) return;
            // Bỏ pre-upload eager cho file > 20MB (sẽ upload on-demand khi mở Selection/Output Preview).
            if (sz > 20 * 1024 * 1024) return;
            const timer = setTimeout(() => {
                uploadPDF(file).then(res => {
                    setSelectionFileId(res.id);
                    if (res.pdf_metadata && res.pdf_metadata.color_space) {
                        onTitleChange?.(`${file.name} (${res.pdf_metadata.color_space})`);
                    }
                }).catch(() => { /* silent — will retry when needed */ });
            }, 2500);
            return () => clearTimeout(timer);
        }
    }, [file]);
    // FILEIO (audit 2026-08-02 §TEST.1): chuyển ảnh có trạng thái hữu hạn. Watchdog chỉ
    // đổi thông tin UI, không hard-timeout ảnh lớn; generation fence từ chối mọi callback muộn.
    const [fileOpeningPhase, setFileOpeningPhase] = useState<FileOpeningPhase>(() => initialFile ? 'loading' : 'idle');
    // NAV (audit 2026-08-05 §AI2.ROUTE1): giữ ảnh trước bước normalize -> PDF để
    // chế độ Ảnh AI dùng lại đúng nguồn đang mở, không bắt người dùng chọn lần hai.
    const [sourceImageFile, setSourceImageFile] = useState<File | null>(() => (
        initialFile && isSupportedImageFileName(initialFile.name) ? initialFile : null
    ));
    const stickerSheetSourceVisible = viewerShowsStickerSource(
        file,
        sourceImageFile,
        stickerSheetSourceFile,
    );
    const [initialOpenRetryToken, setInitialOpenRetryToken] = useState(0);
    const fileOpeningAttemptRef = useRef(0);
    const fileOpeningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const initialOpenRetryRef = useRef<(() => void) | null>(null);
    const pendingSelectedOpenRef = useRef<{ file: File; allFiles?: File[] } | null>(null);

    const clearFileOpeningTimer = useCallback(() => {
        if (fileOpeningTimerRef.current) clearTimeout(fileOpeningTimerRef.current);
        fileOpeningTimerRef.current = null;
    }, []);

    const beginFileOpeningAttempt = useCallback(() => {
        clearFileOpeningTimer();
        const attempt = ++fileOpeningAttemptRef.current;
        setError('');
        setFileOpeningPhase('loading');
        fileOpeningTimerRef.current = setTimeout(() => {
            if (fileOpeningAttemptRef.current === attempt) setFileOpeningPhase('slow');
        }, FILE_OPEN_SLOW_MS);
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
            const attempt = beginFileOpeningAttempt();
            (async () => {
                let openedFile = initialFile;
                setSourceImageFile(isSupportedImageFileName(initialFile.name) ? initialFile : null);
                syncedStickerSourceRef.current = initialFile;
                try {
                    openedFile = await imageFileToPdfIfNeeded(initialFile, getFileArrayBuffer);
                } catch (openError) {
                    console.error('[initialFile] convert ảnh → PDF lỗi:', openError);
                    if (!cancelled && fileOpeningAttemptRef.current === attempt) {
                        setError(t('tabs.imposition:khong_doc_duoc_file_anh'));
                        settleFileOpeningAttempt(attempt, 'error');
                    }
                    return;
                }
                if (cancelled || fileOpeningAttemptRef.current !== attempt) return;
                // Ảnh đã convert thành File PDF không còn path đĩa nên dùng blob URL.
                if (pdfUrl) URL.revokeObjectURL(pdfUrl);
                let objUrl = '';
                const nativePath = (openedFile as File & { path?: string }).path;
                const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
                setOriginalFileName(openedFile.name);
                setFileSizeStr((openedFile.size / (1024 * 1024)).toFixed(2) + ' MB');
                setPdfUrl(objUrl);
                setPhase('workspace');
                settleFileOpeningAttempt(attempt, 'idle');
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
    const applyLockedMode = (mode: string | undefined | null) => {
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
        st.setTaskMode(mode as any);
    };

    // Gán công cụ khoá (từ Home: tem bế / bế rớt / cắt xén / booklet) — chỉ khi
    // lockedMode đổi, KHÔNG phụ thuộc file (tránh reset Tác vụ mỗi lần mở file mới).
    useEffect(() => {
        if (!lockedMode) return;
        setActiveDashboardTool(lockedMode);
        applyLockedMode(lockedMode);
    }, [lockedMode]);

    // Handle initial tool feature from Home screen (preprocess tools)
    useEffect(() => {
        if (initialFeature) {
            if (initialFeature === 'logo_rebuild' && !LOGO_REBUILD_ENABLED) {
                setActiveDashboardTool('none');
                return;
            }
            // Only auto-bypass upload for standalone tools
            if (dedicatedInitialTool) {
                setPhase('workspace');
            }
            setActiveDashboardTool(initialFeature);
            // Home/tool-registry opens a new tab with the requested tool. Ensure the
            // tool panel is visible even when the user previously collapsed it.
            // UIUX (fix 2026-07-28): các công cụ độc lập phải luôn mở lại bảng
            // thiết lập khi tạo tab mới, kể cả khi người dùng đã thu gọn panel ở tab trước.
            if (dedicatedInitialTool || initialFeature === 'crop') {
                if (sidebarWidth < 280) setSidebarWidth(390);
                setIsSidebarOpen(true);
            }
            applyLockedMode(lockedMode);
            const names: Record<string, string> = {
                'bgremover': t('tabs.imposition:tach_nen_ai'),
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
            if (names[initialFeature]) {
                onTitleChange?.(names[initialFeature]);
            }
        }
    }, [initialFeature, dedicatedInitialTool]);

    // UIUX (fix 2026-07-28): tab chuyên dụng không được rơi về workspace PDF trống
    // khi nút Quay lại chung đặt tool = none. Kết quả batch vẫn được giữ nguyên.
    useEffect(() => {
        if (!dedicatedInitialTool || activeDashboardTool !== 'none') return;
        setActiveDashboardTool(dedicatedInitialTool);
        if (sidebarWidth < 280) setSidebarWidth(390);
        setIsSidebarOpen(true);
    }, [dedicatedInitialTool, activeDashboardTool, setActiveDashboardTool, sidebarWidth, setSidebarWidth, setIsSidebarOpen]);

    // Async physical path polyfill (non-blocking via HTTP)
    useEffect(() => {
        if (file && !(file as any).path && !(file as any).__pathMaterializationFailed && (window as any).__TAURI_INTERNALS__) {
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
                        if ((file as any).isGenerated) {
                            try { Object.defineProperty(newFile, 'isGenerated', { value: true, configurable: true }); } catch { /* ignore */ }
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
                    if (!isCancelled && (file as any).__nativePathPending) {
                        // Cả upload HTTP lẫn ghi IPC đều thất bại: bỏ trạng thái chờ và cho
                        // usePdfLoader thử PDF.js thật sự. Cờ failed ngăn effect này lặp vô hạn.
                        const fallbackFile = new File([file], file.name, {
                            type: file.type,
                            lastModified: file.lastModified,
                        });
                        try { Object.defineProperty(fallbackFile, '__pathMaterializationFailed', { value: true, configurable: true }); } catch { /* ignore */ }
                        if ((file as any).isGenerated) {
                            try { Object.defineProperty(fallbackFile, 'isGenerated', { value: true, configurable: true }); } catch { /* ignore */ }
                        }
                        setFile(fallbackFile);
                    }
                }
            })();
            return () => { isCancelled = true; };
        }
    }, [file]);

    const handleBleedUpdate = useCallback((show: boolean, mm: number) => {
        setBleedView((prev: { show: boolean; mm: number }) => (prev.show === show && prev.mm === mm) ? prev : { show, mm });
    }, []);

    useEffect(() => {
        if (!isActive) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (showSaveAsModal && e.key === 'Escape') setShowSaveAsModal(false);
        };
        if (showSaveAsModal) window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showSaveAsModal, isActive]);


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
        if (history.length > 0) return true;
        if (viewerDirty) return true;

        if (file && isOutputFile(file.name)) return true;

        // viewerPageRotations là number[] THEO VỊ TRÍ, luôn đầy đủ độ dài (kể cả toàn 0).
        // Phải kiểm CÓ GÓC KHÁC 0 — KHÔNG dùng .length (bật oan cờ "đang sửa" → auto-save +
        // prompt lưu oan dù chưa xoay gì). Object.values chạy đúng cả trên array lẫn record cũ.
        if (viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => ((((r as number) % 360) + 360) % 360) !== 0)) return true;
        if (vdpFields && vdpFields.length > 0) return true;
        return false;
    }, [isSaved, history.length, file, viewerPageRotations, vdpFields, viewerDirty, editSessionDirty]);
    const isDirty = logoSessionDirty || documentIsDirty;

    useEffect(() => {
        onDirtyChange?.(isDirty);
    }, [isDirty, onDirtyChange]);

    // ── AUTOSAVE / CRASH RECOVERY (phương án A: metadata + path gốc) ──────────────
    // Khi tab đang-sửa VÀ file có đường dẫn trên đĩa → ghi snapshot (debounce 8s) ra
    // %APPDATA%\PrynX\recovery\. Crash/cúp điện → snapshot còn sót → App hỏi khôi phục
    // lúc mở lại. Hết dirty (đã lưu) → xóa snapshot. Snapshot CHỈ chứa thao tác sửa
    // (thứ tự/xoay trang + field VDP) + path gốc; KHÔNG lưu bytes PDF.
    useEffect(() => {
        if (!tabId) return;
        const fpath = (file as any)?.path as string | undefined;
        // Bỏ qua snapshot khi path là file phù du (uploads/results/temp): file này bị
        // dọn sau 26h → khôi phục sẽ trỏ vào path đã biến mất. Chờ tới khi lưu ra vị
        // trí thật (fpath ổn định) mới snapshot.
        if (!documentIsDirty || !fpath || isEphemeralBackendPath(fpath)) {
            void deleteSnapshot(tabId);
            return;
        }
        const snapTimer = setTimeout(() => {
            void writeSnapshot({
                v: 1,
                tabId,
                title: originalFileName || file?.name || t('tabs.imposition:tai_lieu'),
                savedAt: new Date().toISOString(),
                originalPath: fpath,
                originalName: file?.name || originalFileName || 'document.pdf',
                feature: activeDashboardTool !== 'none' ? activeDashboardTool : undefined,
                lockedMode: lockedMode && activeDashboardTool === lockedMode ? lockedMode : undefined,
                viewerPageOrder: viewerPageOrder || undefined,
                viewerPageRotations: viewerPageRotations || undefined,
                vdpFields: (vdpFields && vdpFields.length) ? vdpFields : undefined,
            });
        }, 8000);
        return () => clearTimeout(snapTimer);
    }, [tabId, documentIsDirty, file, originalFileName, viewerPageOrder, viewerPageRotations, vdpFields, activeDashboardTool, lockedMode]);

    // Áp KHÔI PHỤC một lần khi mở tab từ snapshot: dựng lại thao tác sửa trên file gốc.
    useEffect(() => {
        if (!initialRecovery) return;
        if (initialRecovery.viewerPageOrder) setViewerPageOrder(initialRecovery.viewerPageOrder);
        if (initialRecovery.viewerPageRotations) {
            const raw = initialRecovery.viewerPageRotations;
            // Migrate dạng CŨ Record<pageNum,deg> → number[] THEO VỊ TRÍ (out[i]=góc trang
            // ở vị trí i trong pageOrder). Snapshot mới đã là mảng → dùng thẳng.
            if (Array.isArray(raw)) {
                setViewerPageRotations(raw);
            } else {
                const order = initialRecovery.viewerPageOrder || [];
                setViewerPageRotations(order.map((pn: number) => (raw as Record<string, number>)[String(pn)] || 0));
            }
        }
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

    const commitWorkingFile = useCallback(async (newBlob: Blob, newName: string, existingPath?: string) => {
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

        if (file) {
            // Cắt bớt entry cũ nhất khi vượt ngưỡng → chặn leak RAM (audit 2026-07-06).
            setHistory(prev => {
                // Strip bytes khi file có path đĩa → entry undo chỉ giữ tên+path (đọc lại
                // qua getFileArrayBuffer khi cần), chặn leak RAM (audit 2026-07-06). File
                // không path → giữ nguyên bytes (fallback). handleUndo đã xử lý cả 2 nhánh.
                const historyFile = stripBytesIfOnDisk(file);
                // Undo phải khôi phục đồng thời PDF hiển thị và ảnh nguồn tương ứng;
                // nếu không, Bù xén vẫn có thể âm thầm nhận ảnh upscale mới.
                Object.defineProperty(historyFile, '__prynxSourceImageFile', {
                    value: sourceImageFile,
                    configurable: true,
                });
                if (stickerSheetSourceVisible && stickerSheetSourceFile) {
                    // PERF/UIUX (feedback 2026-08-11 §AI.UNDO1): PDF nguồn có thể
                    // được strip thành path-stub. Giữ owner để Undo không bị effect
                    // đồng bộ nguồn mở lại chính PDF đó lần thứ hai giữa lúc Viewer nạp.
                    Object.defineProperty(historyFile, '__prynxStickerSourceFile', {
                        value: stickerSheetSourceFile,
                        configurable: true,
                    });
                }
                const next = [...prev, historyFile];
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
        // Use newName to correctly reflect the current file's processing state
        const displayName = committedName;
        setOriginalFileName(committedName);
        
        const newFile = new File([committedBlob as any], displayName, { type: 'application/pdf' });
        
        try {
            if ((window as any).__TAURI_INTERNALS__) {
                let tempPath = '';
                // VDP/job kết quả: backend đã ghi file thật ra đĩa và trả về đường dẫn
                // (newBlob lúc này chỉ là blob "dummy" để skip download). Dùng thẳng
                // path thật → tile native render đúng, KHÔNG ghi đè bằng blob rỗng.
                if (committedPath) {
                    tempPath = committedPath;
                    try {
                        const { stat } = await import('@tauri-apps/plugin-fs');
                        const info = await stat(committedPath);
                        Object.defineProperty(newFile, 'size', { value: Number((info as any).size || 0) });
                    } catch {
                        // Native rendering only requires the path; size is display metadata.
                    }
                } else {
                    try {
                        const { uploadFileForNup } = await import('../lib/api');
                        tempPath = await uploadFileForNup(newFile);
                    } catch (err) {
                        console.warn("HTTP upload failed for fix pdf, falling back to IPC");
                        const { tempDir, join } = (await import('@tauri-apps/api/path')) as any;
                        const { writeFile } = (await import('@tauri-apps/plugin-fs')) as any;
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

        setFile(newFile);
        if (pdfUrl && !pdfUrl.startsWith('https://')) URL.revokeObjectURL(pdfUrl);
        setPdfUrl(URL.createObjectURL(committedBlob));
        setFileSizeStr((newFile.size / (1024 * 1024)).toFixed(2) + ' MB');
        setIsSaved(false);
        onTitleChange?.(displayName);

        // ─── Recipe record hook ───
        // Ghép thao tác đã "công bố" (noteOperation) với commit này thành 1 Step.
        // No-op khi không ghi. Extras (page order) đã chụp tại noteOperation.
        recipeRecorder.noteCommit();

        detectColorSpace(newFile).then(cs => {
            if (cs) onTitleChange?.(`${displayName} (${cs})`);
        });

        // Cleanup visual edits because they are now baked into the file
        setViewerPageOrder(undefined);
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
        sourceImageFile,
        stickerSheetMode,
        stickerSheetSourceFile,
        stickerSheetSourceVisible,
    ]);
    const ensureCropFileId = useCallback(async (signal?: AbortSignal) => {
        if (!file) throw new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho'));
        // PAGEBOX (audit 2026-08-04 §W1.PB5): Crop phải đọc đúng artifact người
        // dùng đang thấy sau reorder/delete/duplicate/rotate; hook này fail-closed.
        const workingFile = await getCropWorkingFile(file);
        if (!workingFile) throw new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho'));
        const res = await uploadPDF(workingFile, { signal });
        setSelectionFileId(res.id);
        return res.id;
    }, [file, getCropWorkingFile, setSelectionFileId, t]);

    const handleCropApplied = useCallback(async (blob: Blob, filename: string, openInNewTab: boolean) => {
        if (openInNewTab && onSpawnTab) {
            const resultFile = new File([blob], filename, { type: 'application/pdf' });
            Object.defineProperty(resultFile, 'isGenerated', { value: true });
            onSpawnTab(resultFile, { focusFeature: 'crop' });
        } else {
            await commitWorkingFile(blob, filename);
            setViewerPageInstanceIds(undefined);
        }

        commitCropSelection(null);
        setIsCropMode(true);
        setActiveDashboardTool('crop');
        if (sidebarWidth < 280) setSidebarWidth(390);
        setIsSidebarOpen(true);
    }, [onSpawnTab, commitWorkingFile, setViewerPageInstanceIds, commitCropSelection, setIsCropMode, setActiveDashboardTool, sidebarWidth, setSidebarWidth, setIsSidebarOpen]);

    const handleCropClose = useCallback(() => {
        setIsCropMode(false);
        setActiveDashboardTool('none');
    }, [setIsCropMode, setActiveDashboardTool]);


    // --- OBJECT EDIT UPLOAD ---
    const uploadPromiseRef = useRef<Promise<any> | null>(null);
    const pdfObjectsCacheRef = useRef<Record<number, any[]>>({});

    // Keep cache ref in sync
    useEffect(() => { pdfObjectsCacheRef.current = globalPdfObjectCache.getAllObjects(pdfUrl || ''); }, [pdfObjectsVersion, pdfUrl]);

    const store = useContext(WorkspaceContext);

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
    }, [isObjectEditMode, file, selectionFileId]);

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


        } catch (err: any) {
            setError(err.message || t('tabs.imposition:loi_tai_object_trang_n', { n: pageNum }));
        }
    }, [file, setError, setPdfObjectsVersion, store]);

    // Load OCG layers independently from the object cache. A previous PDF can leave
    // virtual layers in the store, so checking only pdfOcgLayers.length is not safe.
    useEffect(() => {
        let cancelled = false;

        const handleRefreshLayers = async (event?: Event) => {
            if (event && (event as CustomEvent).detail?.tabId !== tabId) return;
            const fid = selectionFileId;
            if (!fid) {
                setPdfOcgLayers([]);
                setHiddenOcgLayerIds([]);
                setLockedOcgLayerIds([]);
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
                const walk = (items: any[]) => items.forEach((layer: any) => {
                    if (layer.visible === false) hidden.push(layer.id);
                    if (layer.locked === true) locked.push(layer.id);
                    if (Array.isArray(layer.children)) walk(layer.children);
                });
                walk(layers);
                setPdfOcgLayers(layers);
                setHiddenOcgLayerIds(hidden);
                setLockedOcgLayerIds(locked);
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
    }, [selectionFileId, setPdfOcgLayers, setHiddenOcgLayerIds, setLockedOcgLayerIds, tabId]);


    const handleDeleteObjects = useCallback(async (objs: any[], pageNum: number) => {
        if (!selectionFileId) {
            setError(t('tabs.imposition:loi_khong_tim_thay_selectionfileid_co'));
            return;
        }
        if (objs.length === 0) {
            setError(t('tabs.imposition:loi_chua_co_object_nao_duoc_chon'));
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
                    commitWorkingFile(blob, data.output_filename);
                } else {
                    setError(t('tabs.imposition:loi_tai_file_moi'));
                }
            } else {
                setError(t('tabs.imposition:api_tra_ve_thanh_cong_nhung_thieu_du'));
            }
        } catch (err: any) {
            setError(err.message || t('tabs.imposition:loi_xoa_doi_tuong'));
        } finally {
            setIsProcessing(false);
        }
    }, [selectionFileId, commitWorkingFile]);

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
    const handleEditCommit = useCallback(async (
        outputUrl: string,
        outputFilename: string,
        outputFid?: string,
        outputPath?: string,
    ) => {
        if (!outputUrl) return;
        const displayName = outputFilename || `Edited_${file?.name || 'document.pdf'}`;
        const isTauri = !!(window as any).__TAURI_INTERNALS__;
        const prevPdfUrl = pdfUrl;

        try {
            // Lưu snapshot TRƯỚC thao tác vào undo-stack riêng của object-edit (gồm cả
            // selectionFileId) → Ctrl+Z / nút Undo khôi phục đúng (move/delete/rotate...).
            editHistory.pushSnapshot({ file, pdfUrl: prevPdfUrl, fid: selectionFileId });

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
                    const { stat } = (await import('@tauri-apps/plugin-fs')) as any;
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
                newFile = new File([blob as any], displayName, { type: 'application/pdf' });
                newPdfUrl = URL.createObjectURL(blob);
                sizeStr = (blob.size / (1024 * 1024)).toFixed(2) + ' MB';
            }

            // Đánh dấu File này là "edit-commit": cấu trúc trang KHÔNG đổi (chỉ nội
            // dung backing file). Các effect tải PDF/zoom/thumbnail đọc cờ này để BỎ
            // QUA reset hủy diệt (numPages=0 → unmount, reset scroll/zoom/selection),
            // nhờ đó giao diện KHÔNG "reload" sau mỗi thao tác — chỉ tile + overlay đổi.
            try { Object.defineProperty(newFile, '__editCommit', { value: true, configurable: true }); } catch { /* noop */ }

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
            // LƯU Ý: KHÔNG reset viewerPageOrder/rotations (edit không đụng thứ tự trang)
            // và KHÔNG detectColorSpace (bỏ để giảm tải mỗi op) — khác commitWorkingFile.
        } catch (err: any) {
            setError(err?.message || t('tabs.imposition:loi_cap_nhat_sau_chinh_sua'));
        }
    }, [file, pdfUrl, setHistory, setFile, setOriginalFileName, setPdfUrl, setFileSizeStr,
        setIsSaved, onTitleChange, setSelectionFileId, setError, selectionFileId, editHistory]);

    // Edit-session in-memory: áp op trong RAM backend + render vùng clip → dán overlay
    // tại chỗ (KHÔNG reload file mỗi op). Debounce-commit ngầm ~1.5s → onCommit đổi
    // pdfUrl sang tile thật MỘT lần (nền). Session lỗi/410 → BÁO LỖI, không fallback.
    const editSession = useEditSession({
        eventScopeId: tabId,
        onCommit: (result) => {
            if (result?.success && result.output_url) {
                void handleEditCommit(
                    result.output_url,
                    result.output_filename || '',
                    result.output_fid,
                    result.output_path,
                );
            }
        },
        onSessionFailed: () => {
            setError(t('tabs.imposition:khong_mo_duoc_phien_chinh_sua_backend'));
        },
    });

    // Đồng bộ `editSession.dirty` (op edit-object chưa commit ra đĩa — commit-on-exit)
    // vào cờ `editSessionDirty` để `isDirty` (khai báo TRƯỚC editSession, không đọc trực
    // tiếp được) tính vào cảnh báo đóng tab/cửa sổ + snapshot recovery. Không có bước này,
    // sửa object rồi tắt sẽ MẤT thay đổi mà KHÔNG hỏi (thay đổi chỉ nằm trong RAM phiên).
    useEffect(() => {
        setEditSessionDirty(editSession.dirty);
    }, [editSession.dirty]);

    // ----------------------------

    const documentUndoTransitionRef = useRef(false);

    useEffect(() => {
        // Cho phép bước Undo kế tiếp sau khi React đã áp xong file/history mới.
        documentUndoTransitionRef.current = false;
    }, [file, history.length, pdfUrl]);

    const handleUndo = useCallback(() => {
        // PERF (feedback 2026-08-10 §UNDO.2): keydown có thể lặp trước lần
        // render kế tiếp. Không cho hai lượt nạp tài liệu chồng lên nhau.
        if (documentUndoTransitionRef.current || history.length === 0) return;

        const prevFile = history[history.length - 1];
        let objUrl = '';
        if ((window as any).__TAURI_INTERNALS__ && (prevFile as any).path) {
            objUrl = localFileUrl((prevFile as any).path);
        } else {
            objUrl = URL.createObjectURL(prevFile);
        }

        documentUndoTransitionRef.current = true;
        setHistory(prev => prev.slice(0, -1));

        setFile(prevFile);
        setOriginalFileName(prevFile.name);
        setPdfUrl(objUrl);
        const restoredSource = (prevFile as File & { __prynxSourceImageFile?: File | null })
            .__prynxSourceImageFile ?? null;
        const restoredStickerSource = stickerSourceOwnerFromHistory(prevFile);
        syncedStickerSourceRef.current = restoredStickerSource ?? restoredSource;
        setSourceImageFile(restoredSource);

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
        setViewerPageRotations(undefined);

        // Reset detection so it re-runs if needed
        setDetectedShapeType(null);
        setDetectedShapeParams(null);
        setDetectedShapesByPage({});
        setDetectedDimensionsByPage({});
        setDetectedShapeParamsByPage({});
    }, [history, pdfUrl, onTitleChange, setHistory, setFile, setOriginalFileName, setPdfUrl,
        setFileSizeStr, setViewerPageOrder, setViewerPageRotations, setDetectedShapeType,
        setDetectedShapeParams, setDetectedShapesByPage, setDetectedDimensionsByPage,
        setDetectedShapeParamsByPage]);




    const sidebarDragRef = useRef({ startX: 0, startWidth: 0, lastWidth: 0, startOpen: false });

    useEffect(() => {
        if (!isDraggingSidebar) return;
        const handleMouseMove = (e: MouseEvent) => {
            const deltaX = sidebarDragRef.current.startX - e.clientX;
            const newWidth = sidebarDragRef.current.startWidth + deltaX;
            
            if (activeDashboardTool !== 'none') {
                // Panel ĐÃ mở khi bắt đầu kéo → kéo = resize panel (giữ hành vi cũ).
                // Panel ĐANG đóng khi bắt đầu kéo → kéo CHỈ toggle mini icon↔nhãn,
                // KHÔNG tự bung panel cấu hình (tránh "kéo rộng thì mở tool").
                if (sidebarDragRef.current.startOpen) {
                    if (newWidth >= 280) {
                        setIsSidebarOpen(true);
                        setSidebarWidth(Math.min(newWidth, 800));
                    } else {
                        setIsSidebarOpen(false);
                    }
                } else {
                    setIsMiniToolbarExpanded(newWidth >= 120);
                }
            } else {
                const clampedWidth = Math.min(Math.max(newWidth, 48), 800);
                setSidebarWidth(clampedWidth);
                
                if (clampedWidth >= 280) {
                    setIsSidebarOpen(true);
                } else if (clampedWidth >= 120) {
                    setIsSidebarOpen(false);
                    setIsMiniToolbarExpanded(true);
                } else {
                    setIsSidebarOpen(false);
                    setIsMiniToolbarExpanded(false);
                }
            }
        };
        const handleMouseUp = () => setIsDraggingSidebar(false);

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // Change cursor while dragging anywhere
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
    }, [isDraggingSidebar, setSidebarWidth, activeDashboardTool]);

    const formatSize = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';

    const handleFileSelected = useCallback(async (selectedFile: File, allFiles?: File[]) => {
        // Ảnh → PDF ngay khi mở để mọi công cụ sau chỉ nhận hợp đồng PDF.
        pendingSelectedOpenRef.current = { file: selectedFile, allFiles };
        syncedStickerSourceRef.current = selectedFile;
        setSourceImageFile(isSupportedImageFileName(selectedFile.name) ? selectedFile : null);
        const attempt = beginFileOpeningAttempt();
        try {
            selectedFile = await imageFileToPdfIfNeeded(selectedFile, getFileArrayBuffer);
        } catch (openError) {
            console.error('[handleFileSelected] convert ảnh → PDF lỗi:', openError);
            if (fileOpeningAttemptRef.current === attempt) {
                setError(t('tabs.imposition:khong_doc_duoc_file_anh'));
                settleFileOpeningAttempt(attempt, 'error');
            }
            return;
        }
        if (fileOpeningAttemptRef.current !== attempt) return;
        setFile(selectedFile);
        setOriginalFileName(selectedFile.name);
        setSelectionFileId(''); // Reset — will be re-uploaded by the useEffect above
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
                onSpawnTab(allFiles[i]);
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
        ) {
            return;
        }
        if (!stickerSheetSourceFile || fileOpeningPhase === 'loading' || stickerSheetBusy) return;
        if (syncedStickerSourceRef.current === stickerSheetSourceFile) return;
        syncedStickerSourceRef.current = stickerSheetSourceFile;
        // UIUX (feedback 2026-08-09 §AI.VIEW1): picker trong panel AI cũng phải
        // cập nhật tài liệu của AcrobatViewer; không dựng một viewport ảnh song song.
        void handleFileSelected(stickerSheetSourceFile);
    }, [
        activeDashboardTool,
        fileOpeningPhase,
        handleFileSelected,
        isActive,
        stickerSheetBusy,
        stickerSheetMode,
        stickerSheetSourceFile,
    ]);
    //#endregion

    //#region Processing Handlers
    // ═══ Processing handlers (extracted to lib/processHandlers.ts) ═══
    const [processCancelHandler, setProcessCancelHandler] = useState<(() => Promise<void>) | null>(null);

    const buildProcessContext = useCallback(() => {
        const getWorkingBytesLocal = async (): Promise<Uint8Array> => {
            if (viewerPageOrder) {
                const bakedBlob = await applyAcrobatEdits();
                if (bakedBlob) return new Uint8Array(await bakedBlob.arrayBuffer());
            }
            // getFileArrayBuffer đọc từ ĐĨA qua path khi file đã strip bytes (sau undo,
            // #2 audit RAM) — file!.arrayBuffer() sẽ trả 0 byte trên file rỗng+path.
            return new Uint8Array(await getFileArrayBuffer(file!));
        };
        const getWorkingSourcePathLocal = async (): Promise<string | undefined> => {
            const sourcePath = (file as File & { path?: string })?.path;
            if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ || !sourcePath) return undefined;

            const hasRotationEdits = !!(viewerPageRotations && Object.values(viewerPageRotations)
                .some((rotation) => (((rotation % 360) + 360) % 360) !== 0));
            const hasNonIdentityOrder = !!viewerPageOrder
                && viewerPageOrder.some((pageNumber, index) => pageNumber !== index + 1);
            if (viewerDirty || editSessionDirty || initialRecovery || hasRotationEdits || hasNonIdentityOrder) {
                return undefined;
            }
            return sourcePath;
        };

        return {
            file: file!,
            onSpawnTab,
            commitWorkingFile,
            // Bọc setError: khi một thao tác (đã noteOperation) BÁO LỖI (msg≠'') →
            // dọn pending note để KHÔNG bị ghép nhầm vào commit của thao tác sau.
            // UIUX (audit 2026-07-27 §B-23) fix-verify: KHÔNG formatError lần hai ở đây —
            // processHandlers đã format sẵn; format chồng từng cắt cụt 200 ký tự.
            setError: (msg: string) => { if (msg) recipeRecorder.discardPending(); setError(msg); },
            setIsProcessing, setProcessStatus, setReportMsg, setBatchOutput,
            setCancelHandler: (handler: (() => Promise<void>) | null) => {
                setProcessCancelHandler(() => handler);
            },
            viewerNumPages,
            getWorkingBytes: getWorkingBytesLocal,
            getWorkingSourcePath: getWorkingSourcePathLocal,
        };
    }, [file, onSpawnTab, commitWorkingFile, viewerNumPages, viewerPageOrder, viewerPageRotations, viewerDirty, editSessionDirty, initialRecovery]);

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
        const effectiveSpawn = recipeRecorder.isRecording ? false : spawnNewTab;

        // ─── Recipe record hook ───
        // Chỉ ghi khi commit vào working file (spawnNewTab=false). onConfirmScale
        // là hàm → bị JSON.stringify loại khi clone params (an toàn để phát lại).
        if (!effectiveSpawn) {
            const opId = settings.impositionMode === ImpositionMode.Booklet
                ? 'booklet'
                : (settings as any).imposerMode === 'cnc'
                    ? 'cnc_imposer'
                    : (settings as any).imposerMode === 'diecut'
                        ? 'sticker_imposer'
                        : 'nup';
            // Mã chẩn đoán chỉ sống trong lần chạy hiện tại; không lưu vào recipe rồi
            // phát lại một trace cũ cho tài liệu khác.
            const {
                diagnosticTraceId, diagnosticPreviewRequestId,
                diagnosticPendingRequestId, diagnosticPreviewCapacity,
                diagnosticPreviewState, ...recordableSettings
            } = settings as any;
            let recordParams: any = recordableSettings;
            if (opId === 'sticker_imposer' || opId === 'cnc_imposer') {
                // KHÔNG lưu HÌNH per-file (detectedShapes*) / thứ tự trang / đếm theo trang:
                // phát lại sẽ DÒ LẠI hình trên file tem mới → đúng cho từng sản phẩm.
                const {
                    detectedShapesByPage, detectedShapeParamsByPage, detectedDimensionsByPage,
                    shapeType, shapeParams, targetQuantitiesByPage, pageOrder, pageRotations,
                    ...rest
                } = recordableSettings;
                recordParams = rest;
            }
            recipeRecorder.noteOperation(opId, recordParams);
        }

        const { runProcessEngine } = await import('../lib/processHandlers');
        await runProcessEngine(buildProcessContext(), settings, effectiveSpawn);
    }, [file, buildProcessContext]);

    const handleStartCatalogPlan = useCallback(async (planConfig: any, sheetSettings: any) => {
        if (!file) return;
        const { runCatalogPlan } = await import('../lib/processHandlers');
        await runCatalogPlan(buildProcessContext(), planConfig, sheetSettings);
    }, [file, buildProcessContext]);

    // Khi ĐANG GHI: ép spawnNewTab=false để thao tác commit vào working file (chuỗi
    // tuyến tính) VÀ được ghi vào recipe. Mặc định spawnNewTab=true → nếu không ép,
    // thao tác mở tab mới, hook record bị bỏ qua (bug: recipe thiếu bước).
    const handleStartShuffle = async (settings: any) => {
        if (!file) return;
        const eff = recipeRecorder.isRecording ? { ...settings, spawnNewTab: false } : settings;
        if (!eff.spawnNewTab) recipeRecorder.noteOperation('shuffle', eff);
        const { runShuffle } = await import('../lib/processHandlers');
        await runShuffle(buildProcessContext(), eff);
    };

    const handleStartResize = async (settings: any) => {
        if (!file) return;
        const eff = recipeRecorder.isRecording ? { ...settings, spawnNewTab: false } : settings;
        if (!eff.spawnNewTab) recipeRecorder.noteOperation('resize', eff);
        const { runResize } = await import('../lib/processHandlers');
        await runResize(buildProcessContext(), eff);
    };

    const handleStartTrimShift = async (settings: any) => {
        if (!file) return;
        const eff = recipeRecorder.isRecording ? { ...settings, spawnNewTab: false } : settings;
        if (!eff.spawnNewTab) recipeRecorder.noteOperation('trim_shift', eff);
        const { runTrimShift } = await import('../lib/processHandlers');
        await runTrimShift(buildProcessContext(), eff);
    };

    const handleStartSplit = useCallback(async (settings: any) => {
        if (!file) return;
        const eff = recipeRecorder.isRecording ? { ...settings, spawnNewTab: false } : settings;
        if (!eff.spawnNewTab) recipeRecorder.noteOperation('split', eff);
        const { runSplit } = await import('../lib/processHandlers');
        await runSplit(buildProcessContext(), eff);
    }, [file, buildProcessContext]);

    const handleStartMerge = useCallback(async (settings: any) => {
        if (!file && settings.mode === 'insert_pages') return;
        const eff = recipeRecorder.isRecording ? { ...settings, spawnNewTab: false } : settings;
        if (!eff.spawnNewTab) {
            // KHÔNG lưu blob file ngoài vào recipe (Property 7) — chỉ lưu cấu hình ghép.
            const { filesToMerge, oddFile, evenFile, ...mergeParams } = eff;
            recipeRecorder.noteOperation('merge', mergeParams);
        }
        const { runMerge } = await import('../lib/processHandlers');
        await runMerge(buildProcessContext(), eff);
    }, [file, buildProcessContext]);

    // ─── Recipe playback (Task 9) ───
    // Chuỗi working file CỤC BỘ trong 1 lần phát: getWorkingBytes/commitWorkingFile
    // ghi đè để bước sau nhận output bước trước (tránh state `file` cũ trong closure).
    const playRecipe = useCallback(async (recipe: Recipe) => {
        if (!file) { toast.error(t('tabs.imposition:hay_mo_mot_file_pdf_truoc_khi_phat_lai')); return; }
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
        const base = buildProcessContext();
        let currentBytes: Uint8Array;
        try { currentBytes = await base.getWorkingBytes(); }
        catch { currentBytes = new Uint8Array(await getFileArrayBuffer(file)); }
        let currentName = file.name;

        const { runRecipe } = await import('../lib/recipe/PlaybackRunner');
        const { RECIPE_RUNNERS } = await import('../lib/recipe/recipeRunners');

        const requestExternalInput = (_step: any, kind: 'csv' | 'file') => new Promise<any>((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = kind === 'csv' ? '.csv,text/csv' : 'application/pdf,.pdf';
            input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) { resolve(null); return; }
                resolve(kind === 'csv' ? { csvFile: f, csvText: await f.text() } : { files: [f] });
            };
            (input as any).oncancel = () => resolve(null);
            input.click();
        });

        const res = await runRecipe(recipe, {
            buildContext: () => ({
                ...base,
                file: new File([currentBytes as any], currentName, { type: 'application/pdf' }),
                getWorkingBytes: async () => currentBytes,
                commitWorkingFile: async (blob: Blob, name: string) => {
                    currentBytes = new Uint8Array(await blob.arrayBuffer());
                    currentName = name;
                    await commitWorkingFile(blob, name);
                },
            }) as any,
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
        });
        setProcessStatus('');

        if (res.ok) {
            toast.success(t('tabs.imposition:phat_lai_xong', { n: res.completed }) + (res.skipped ? t('tabs.imposition:bo_qua_n_suffix', { n: res.skipped }) : '') + '.');
        } else {
            toast.error(t('tabs.imposition:dung_o_buoc_n', { n: (res.failedStep?.index ?? 0) + 1, err: res.failedStep?.error || t('tabs.imposition:loi') }));
        }
    }, [file, buildProcessContext, commitWorkingFile]);

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
        const settings: any = {
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
        const effectiveFoliosize = ((settings as any).chainNup && (settings as any).foldPattern && (settings as any).foldPattern.startsWith('sig_'))
            ? parseInt((settings as any).foldPattern.split('_')[1])
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
        const mapResult = generateBindingMap(imposedPageCount, (settings as any).bindingMode || 'saddle', effectiveFoliosize, (settings as any).blankPlacement || 'end');

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
            processEngine(settings, config.spawnNewTab);
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
        const settings: any = {
            imposerMode: config.cncMode ? 'cnc' : (config.isDieCutMode ? 'diecut' : 'guillotine'),
            impositionMode: ImpositionMode.NUp,
            paperThickness: 0,
            bleed: config.bleed,
            sheetWidth: sheetW,
            sheetHeight: sheetH,
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
            // ═══ Bình Bế Rớt (CNC) ═══
            cncMode: config.cncMode,
            cncTwoSided: config.cncTwoSided,
            cncFlipEdge: config.cncFlipEdge,
            cncDuplexMarks: config.cncDuplexMarks,
            // Tự động lưu file in
            autoSavePrint: config.autoSavePrint,
            savePrintConfig: config.savePrintConfig,
            // ═══ Report vẽ lên tờ (spec: binh-tem-be-report) — gồm cả CNC ═══
            reportDisplay: config.reportDisplay,
            reportMaterial: config.reportMaterial,
            reportLamination: config.reportLamination,
            reportLaminationSides: config.reportLaminationSides,
            reportOrderCode: config.reportOrderCode,
            exportUniqueSheets: config.exportUniqueSheets,
            saveByReport: config.saveByReport,
        };

        processEngine(settings, config.spawnNewTab);
    }, [viewerPageOrder, viewerPageRotations, processEngine]);
    //#endregion

    //#region Core UI Handlers

    const forceReset = () => {
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

    const handleReset = () => {
        if (isDirty || viewerDirty) {
            setShowCloseConfirm(true);
            return;
        }
        forceReset();
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

    const resolveSourcePageCount = async (f: File): Promise<number> => {
        const key = `${(f as any).path || f.name}|${f.size}|${(f as any).lastModified || 0}`;
        if (sourcePageCountCacheRef.current?.key === key) {
            return sourcePageCountCacheRef.current.count;
        }
        const ab = await getFileArrayBuffer(f);
        const doc = await PDFDocument.load(ab, { ignoreEncryption: true });
        const count = doc.getPageCount();
        sourcePageCountCacheRef.current = { key, count };
        return count;
    };

    /** order === [1..N] với N = số trang FILE GỐC (không phải viewerNumPages sau xóa). */
    const isViewerOrderIdentityForSource = async (
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
    };

    const applyAcrobatEdits = async (sourceFile: File | null = file) => {
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
        return new Blob([pdfBytes as any], { type: 'application/pdf' });
    };

    /** Lấy bytes PDF đã áp dụng visual edits (xóa trang, xoay, sắp xếp lại) */
    const getWorkingBytes = async (): Promise<Uint8Array> => {
        if (viewerPageOrder && file && !(await isViewerOrderIdentityForSource(file, viewerPageOrder))) {
            const bakedBlob = await applyAcrobatEdits();
            if (bakedBlob) return new Uint8Array(await bakedBlob.arrayBuffer());
            throw new Error('Không thể tạo PDF làm việc từ thứ tự trang hiện tại.');
        } else if (viewerPageOrder && file) {
            // Identity order nhưng có thể còn xoay — bake nếu có góc ≠ 0.
            const hasRot = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => ((((r as number) % 360) + 360) % 360) !== 0));
            if (hasRot) {
                const bakedBlob = await applyAcrobatEdits();
                if (bakedBlob) return new Uint8Array(await bakedBlob.arrayBuffer());
                throw new Error('Không thể tạo PDF làm việc từ góc xoay trang hiện tại.');
            }
        }
        // getFileArrayBuffer đọc từ path (protocol localfile) nếu file đã strip bytes sau undo,
        // fallback file.arrayBuffer() khi có bytes — tránh trả 0 byte (audit RAM #2).
        return new Uint8Array(await getFileArrayBuffer(file!));
    };

    /**
     * Trả về File template để các tác vụ tiếp theo (VDP, đánh số...) xử lý.
     * Nếu người dùng đã sửa trang trong viewer (xóa/xoay/sắp xếp) thì "nướng"
     * các thay đổi đó vào file mới — tuân thủ quy tắc: tác vụ sau chỉ dùng KẾT QUẢ
     * đã chỉnh, không dùng file gốc. Nếu không có sửa đổi, giữ nguyên file gốc
     * (bảo toàn .path để backend nạp nhanh qua native path).
     */
    const getWorkingFile = async (): Promise<File> => {
        // BUG cũ: so identity với viewerNumPages (luôn = order.length sau xóa) →
        // xóa đuôi 10→4 còn [1,2,3,4] bị coi "không sửa" → preview vẫn mở file 10 trang.
        // Đúng: identity chỉ khi order === [1..N] với N = số trang FILE GỐC trên disk.
        // viewerDirty: undo-stack sau xóa/sắp trang — failsafe khi đếm page gốc lỗi.
        let hasOrderEdits = !!viewerDirty;
        if (!hasOrderEdits && viewerPageOrder && file) {
            try {
                hasOrderEdits = !(await isViewerOrderIdentityForSource(file, viewerPageOrder));
            } catch (e) {
                // Không đọc được page count gốc → bake an toàn (tránh trả file 10 trang).
                console.warn('[getWorkingFile] source page count failed, force bake:', e);
                hasOrderEdits = true;
            }
        }
        // viewerPageRotations giờ là number[] THEO VỊ TRÍ, flattenRotations luôn tạo mảng
        // đầy đủ độ dài KỂ CẢ khi mọi góc = 0 → phải kiểm "có góc ≠ 0", không phải "có key"
        // (nếu dùng .length sẽ bật cờ sửa oan → bake file thừa).
        const hasRotEdits = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => ((((r as number) % 360) + 360) % 360) !== 0));
        if ((hasOrderEdits || hasRotEdits) && file) {
            try {
                const baked = await applyAcrobatEdits();
                if (baked) {
                    // KHÔNG gắn .path gốc — resolvePreviewSource ghi temp từ bytes bake.
                    return new File([baked], file.name, { type: 'application/pdf' });
                }
                throw new Error('Không nhận được dữ liệu PDF sau khi áp dụng thay đổi trang.');
            } catch (e) {
                // PREVIEW (audit 2026-08-04 §W2.PA2): fail-closed. File gốc có thể
                // chứa trang đã xóa hoặc thứ tự cũ; trả nó sẽ tạo preview sai âm thầm.
                console.error('[getWorkingFile] bake failed:', e);
                const failure = new Error(
                    'Không thể tạo PDF làm việc từ thứ tự hoặc góc xoay trang hiện tại.',
                );
                (failure as Error & { cause?: unknown }).cause = e;
                throw failure;
            }
        }
        return file!;
    };

    /** @returns true nếu đã lưu thành công; false nếu huỷ dialog / lỗi. */
    const handleSaveFile = useCallback(async (isSaveAs: boolean = false): Promise<boolean> => {
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
        let targetBlob: Blob | null = curFile;
        let targetName = curFile ? curFile.name : 'Document.pdf';
        let didBake = false;  // có bake edits/VDP vào blob mới hay không

        if (!targetBlob) return false;

        // File kết quả đã sinh sẵn (VDP/batch...) đã bake đủ — KHÔNG áp lại edits/VDP còn
        // sót trong store (tránh bị thêm tiền tố "Edited_"/"VDP_" sai khi chạy nhiều file).
        const isGeneratedResult = !!(curFile as any)?.isGenerated;
        // path chỉ là file tạm backend (<uuid>.pdf) do polyfill gán để render → KHÔNG
        // được coi là đích lưu thật. Bắt buộc hỏi vị trí lưu (tránh ghi đè temp + đổi
        // tên tab thành chuỗi uuid). Phòng thủ 2 lớp: cờ isTempUploadPath HOẶC path nằm
        // trong thư mục phù du của backend (uploads/results/temp | <uuid>.pdf).
        const isTempUploadPath = !!(curFile as any)?.isTempUploadPath
            || isEphemeralBackendPath((curFile as any)?.path);

        // Chỉ bake khi có sửa đổi THẬT SỰ (xoay khác 0, hoặc thứ tự trang khác gốc /
        // có xoá/chèn). So với FILE GỐC page count — không dùng viewerNumPages (sau xóa
        // luôn = order.length → xóa đuôi bị bỏ sót). Nếu chỉ "lưu lại" không sửa → bỏ bake.
        const _hasRot = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => ((((r as number) % 360) + 360) % 360) !== 0));
        const _hasReorder = !!viewerPageOrder && curFile
            ? !(await isViewerOrderIdentityForSource(curFile, viewerPageOrder))
            : false;

        // Nếu có visual edits (xoay/sắp trang) → bake vào blob để lưu.
        // KHÔNG commitWorkingFile (tránh đổi tên "Edited_" + race set isSaved=false).
        if (!isGeneratedResult && (_hasRot || _hasReorder)) {
            setIsProcessing(true);
            setProcessStatus(t('tabs.imposition:dang_ap_dung_thay_doi_va_luu'));
            try {
                const editedBlob = await applyAcrobatEdits(curFile);
                if (editedBlob) {
                    targetBlob = editedBlob;
                    didBake = true;
                }
            } catch (err: any) {
                setError(t('tabs.imposition:loi_khi_ap_dung_sua_doi') + err.message);
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
        const _bakeInMemory = (blob: Blob, name: string, path: string | null) => {
            const bf = new File([blob as any], name, { type: 'application/pdf' });
            if (path) {
                try { Object.defineProperty(bf, 'path', { value: path }); } catch { /* ignore */ }
            }
            setFile(bf);
            if (pdfUrl && !pdfUrl.startsWith('https://')) URL.revokeObjectURL(pdfUrl);
            setPdfUrl(URL.createObjectURL(blob));
            setFileSizeStr((blob.size / (1024 * 1024)).toFixed(2) + ' MB');
            setViewerPageOrder(undefined);
            setViewerPageRotations(undefined);
            setViewerDirty(false);
            // KHÔNG xoá vdpFields/selection ở đây: giữ lớp phủ field VDP để người dùng
            // tiếp tục soạn/chạy merge sau khi lưu (tránh "lưu xong mất placeholder").
            setSelectionFileId('');
            setHiddenObjectIds([]);
            setLockedObjectIds([]);
        };

        try {
            if ((window as any).__TAURI_INTERNALS__) {
                const { save } = await import('@tauri-apps/plugin-dialog');
                const { invoke } = await import('@tauri-apps/api/core');
                // GHI NGUYÊN TỬ qua lệnh Rust (ghi temp cùng thư mục rồi rename = thay-thế
                // nguyên tử) → KHÔNG để file gốc dở-dang/hỏng nếu crash giữa lúc ghi đè
                // (audit an toàn dữ liệu). Bytes truyền dạng Uint8Array (Tauri v2 raw IPC).
                const atomicWrite = (p: string, data: Uint8Array) =>
                    invoke('write_file_atomic', { path: p, contents: data });
                
                let path: string | null = null;
                // File kết quả sinh sẵn (VDP/batch) nằm ở thư mục tạm + blob in-memory chỉ
                // là placeholder → KHÔNG ghi đè vào temp, luôn hỏi vị trí lưu.
                if (!isSaveAs && (curFile as any)?.path && !isGeneratedResult && !isTempUploadPath) {
                    path = (curFile as any).path; // Overwrite original
                } else {
                    path = await save({
                        filters: [{ name: 'PDF', extensions: ['pdf'] }],
                        defaultPath: targetName,
                        title: 'Save PDF File'
                    });
                }

                if (path) {
                    // Lưu đè đúng file nguồn mà không có gì để bake → đã là chính nó,
                    // bỏ qua (đặt TRƯỚC khi đọc bytes để không đọc thừa file lớn qua IPC).
                    if (path === (curFile as any)?.path && !didBake) {
                        const fileName = path.split(/[\\/]/).pop() || targetName;
                        setIsSaved(true);
                        onTitleChange?.(fileName);
                        return true;
                    }
                    // Ghi ra path đích. Nếu KHÔNG bake và file đã nằm trên đĩa (kết quả
                    // bình sách/VDP là file lớn hàng trăm MB) → COPY thẳng đĩa→đĩa qua Rust,
                    // KHÔNG đọc bytes vào JS. Đường cũ đọc toàn bộ file vào Uint8Array rồi
                    // truyền qua IPC cho write_file_atomic → "RangeError: Invalid array length"
                    // khi serialize khối bytes khổng lồ (vd booklet 338MB). Ngược lại (đã bake
                    // edits/VDP, hoặc file chỉ có blob in-memory) → ghi bytes như cũ.
                    const sourceDiskPath: string | null =
                        (!didBake && (curFile as any)?.path) ? (curFile as any).path : null;
                    const performWrite = async (destPath: string) => {
                        if (sourceDiskPath) {
                            const { invoke } = await import('@tauri-apps/api/core');
                            await invoke('copy_file_atomic', { source: sourceDiskPath, path: destPath });
                        } else {
                            const ab = await targetBlob.arrayBuffer();
                            await atomicWrite(destPath, new Uint8Array(ab));
                        }
                    };
                    try {
                        await performWrite(path);
                        const fileName = path.split(/[\\/]/).pop() || targetName;
                        if (didBake) {
                            _bakeInMemory(targetBlob, fileName, path);
                        } else if (isTempUploadPath) {
                            // File tách/sinh trong bộ nhớ vừa được lưu ra vị trí THẬT:
                            // trỏ `file` sang path mới + bỏ cờ tạm để Ctrl+S sau ghi đè
                            // đúng file người dùng (không hỏi lại, không dùng path uuid).
                            const rebased = new File([targetBlob as any], fileName, { type: 'application/pdf' });
                            try { Object.defineProperty(rebased, 'path', { value: path }); } catch { /* ignore */ }
                            // Chỉ ĐỔI PATH (copy đĩa→đĩa), nội dung + pdfUrl KHÔNG đổi → cờ này
                            // cho usePdfLoader RETURN SỚM (như __editCommit): không setNumPages(0),
                            // không nạp lại 14 trang + thumbnail vô ích sau khi lưu.
                            try { Object.defineProperty(rebased, '__pathRebaseOnly', { value: true }); } catch { /* ignore */ }
                            setFile(rebased);
                            setOriginalFileName(fileName);
                        }
                        setIsSaved(true);
                        onTitleChange?.(fileName);
                        return true;
                    } catch (writeErr: any) {
                        if (writeErr.toString().includes('forbidden path') || writeErr.toString().includes('not allowed')) {
                            const fallbackPath = await save({
                                filters: [{ name: 'PDF', extensions: ['pdf'] }],
                                defaultPath: targetName,
                                title: 'Select save location (Original path restricted)'
                            });
                            if (fallbackPath) {
                                await performWrite(fallbackPath);
                                const fileName = fallbackPath.split(/[\\/]/).pop() || targetName;
                                if (didBake) _bakeInMemory(targetBlob, fileName, fallbackPath);
                                setIsSaved(true);
                                onTitleChange?.(fileName);
                                return true;
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

                if (didBake) _bakeInMemory(targetBlob, targetName, null);
                setIsSaved(true);
                onTitleChange?.(targetName);
                return true;
            }
        } catch (e: any) {
            setError(t('tabs.imposition:khong_the_luu_file') + e);
            return false;
        }
    }, [file, viewerPageOrder, viewerPageRotations, vdpFields, viewerNumPages, pdfUrl, onTitleChange, editSession, store, isObjectEditMode]);

    useEffect(() => {
        const handleTriggerSave = async (e: any) => {
            if (e.detail?.tabId !== tabId) return;
            // Workspace Logo sở hữu artifact SVG và Save dialog riêng. Nếu parent
            // tiếp tục xử lý, cùng requestId có thể nhận kết quả lưu PDF sai trước.
            if (
                activeDashboardTool === 'logo_rebuild'
                && logoWorkspaceOpened
                && (logoSessionDirty || !documentIsDirty)
            ) return;
            const requestId = e.detail?.requestId as string | undefined;
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
            if (e.detail.saveAs) {
                setShowSaveAsModal(true);
                // Save As modal không await → báo cancelled cho luồng thoát tuần tự
                // (user vẫn lưu được qua modal; thoát app dùng Lưu trực tiếp không saveAs).
                reply('cancelled');
                return;
            }
            if (!(isDirty || viewerDirty)) {
                // UIUX (audit menu 2026-07-28 §MB.2b): trước đây thoát êm, user bấm Lưu
                // mà không thấy gì nên tưởng menu chết. Nói rõ là KHÔNG có gì cần lưu.
                // Luồng thoát app (có requestId) vẫn im lặng — nó chỉ cần kết quả 'saved'.
                if (!requestId) toast.info(t('tabs.imposition:khong_co_thay_doi_nao_can_luu', 'File chưa có thay đổi nào cần lưu.'));
                reply('saved');
                return;
            }
            try {
                const ok = await handleSaveFile(false);
                reply(ok ? 'saved' : 'cancelled');
            } catch {
                reply('failed');
            }
        };
        window.addEventListener('app-trigger-save', handleTriggerSave);
        return () => window.removeEventListener('app-trigger-save', handleTriggerSave);
    }, [isActive, tabId, isDirty, viewerDirty, handleSaveFile, file, store, t, activeDashboardTool, logoWorkspaceOpened, logoSessionDirty, documentIsDirty]);

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
            if (!(window as any).__TAURI_INTERNALS__) {
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

            const hasRotationEdits = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => ((((r as number) % 360) + 360) % 360) !== 0));
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
        } catch (e: any) {
            setError(t('tabs.imposition:khong_the_in_file') + (e?.message || e));
        } finally {
            isPrintingRef.current = false;
        }
    }, [file, viewerPageRotations, viewerPageOrder, viewerNumPages, viewerActivePage, editSession, store, openPrintDialog, t]);

    useEffect(() => {
        const handleTriggerPrint = (e: any) => {
            if (!isActive) return;
            if (e.detail.tabId === tabId) {
                handlePrintFile();
            }
        };
        window.addEventListener('app-trigger-print', handleTriggerPrint);
        return () => window.removeEventListener('app-trigger-print', handleTriggerPrint);
    }, [isActive, tabId, handlePrintFile]);

    const handleExtractPages = async (indices: number[], deleteAfter: boolean) => {
        if (!file || !onSpawnTab || !viewerPageOrder || !viewerPageRotations) return;
        try {
            setIsProcessing(true);
            setProcessStatus(t('tabs.imposition:dang_boc_tach_file_pdf'));
            const arrayBuffer = await getFileArrayBuffer(file);
            const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
            const newDoc = await PDFDocument.create();

            const firstPage = srcDoc.getPages()[0];
            const defaultDim = firstPage ? { w: firstPage.getSize().width, h: firstPage.getSize().height } : { w: 595.28, h: 841.89 }; // A4 fallback

            // viewerPageRotations giờ là number[] THEO VỊ TRÍ. indices ở đây là SỐ TRANG
            // (do AcrobatViewer truyền pageOrder[pos]) → map số trang về vị trí đầu tiên
            // trong viewerPageOrder để tra góc. Fallback dữ liệu CŨ: nếu là Record<pageNum,deg>
            // thì tra thẳng theo số trang (per-instance rotation 2026-07-06).
            const rotsAny = viewerPageRotations as any;
            const rotIsArray = Array.isArray(rotsAny);
            for (const pIdx of indices) {
                if (pIdx === -1) {
                    newDoc.addPage([defaultDim.w, defaultDim.h]);
                } else {
                    const [copiedPage] = await newDoc.copyPages(srcDoc, [pIdx - 1]);
                    const rot = rotIsArray
                        ? (rotsAny[viewerPageOrder.indexOf(pIdx)] || 0)
                        : (rotsAny[pIdx] || 0);
                    if (rot) {
                        const currentRot = copiedPage.getRotation().angle;
                        copiedPage.setRotation(degrees(currentRot + rot));
                    }
                    newDoc.addPage(copiedPage);
                }
            }

            const pdfBytes = await newDoc.save();
            const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });
            const extractedFile = new File([blob], `Bi_Broc_Tach_${file.name}`, { type: 'application/pdf' });
            onSpawnTab(extractedFile);
        } catch (e: any) {
            setError(e.message || t('tabs.imposition:loi_he_thong_khi_trich_xuat'));
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

    // Quyết định hiển thị NHÃN CHỮ trong mini toolbar.
    // - Khi KHÔNG có công cụ đang chọn: cột là w-full (rộng = sidebarWidth) → hiện nhãn nếu đủ rộng (>=120px).
    // - Khi CÓ công cụ: giữ nguyên hành vi cũ theo isMiniToolbarExpanded (48px icon / 220px có nhãn).
    const showMiniLabels = activeDashboardTool === 'none' ? sidebarWidth >= 120 : isMiniToolbarExpanded;
    const activeToolDefinition = findToolByUniqueKey(activeDashboardTool);
    const activeToolLocked = !!activeToolDefinition
        && !canUse(activeToolDefinition.featureId, licensePlan, licenseFeatures);

    //#region Render
    return (
        <div className="relative w-full h-full flex flex-col bg-slate-50 dark:bg-[#1a1a1a]">
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
                                    const finalSettings = { ...(confirmBookletSettings.settings as any), blankPlacement: confirmBlankPlacement };
                                    processEngine(finalSettings, confirmBookletSettings.spawnNewTab);
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
                                        {confirmBookletSettings.totalPages > 0 && confirmBookletSettings.totalPages !== confirmBookletSettings.paddedPages && (confirmBookletSettings.settings as any).bindingMode !== 'flush_mount' && (
                                            <span className="text-emerald-600 dark:text-emerald-400 font-medium ml-1">
                                                {t('tabs.imposition:can_them_n_trang_trang_lam_tron', { add: confirmBookletSettings.paddedPages - confirmBookletSettings.totalPages, total: confirmBookletSettings.paddedPages })}
                                            </span>
                                        )}
                                    </p>
                                    {confirmBookletSettings.totalPages > 0 && confirmBookletSettings.totalPages !== confirmBookletSettings.paddedPages && (confirmBookletSettings.settings as any).bindingMode !== 'flush_mount' && (
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
                                        const finalSettings = { ...(confirmBookletSettings.settings as any), blankPlacement: confirmBlankPlacement };
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
                        resultFilePath={(file as any)?.path}
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
                        sourcePdfPath={(file as any)?.path}
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

                        <OutputPreviewHost onFileFixed={commitWorkingFile} />

                        {activeDashboardTool === 'bgremover' && (
                            <div className="absolute top-0 left-0 bottom-0 z-40" style={{ right: isSidebarOpen ? (sidebarWidth + (isMiniToolbarExpanded ? 220 : 48)) : (isMiniToolbarExpanded ? 220 : 48) }}>
                                <BgRemoverPreview tabId={tabId || ''} isActive={isActive === true} />
                            </div>
                        )}

                        {activeDashboardTool === 'upscale' && (
                            <div className="absolute top-0 left-0 bottom-0 z-40" style={{ right: isSidebarOpen ? (sidebarWidth + (isMiniToolbarExpanded ? 220 : 48)) : (isMiniToolbarExpanded ? 220 : 48) }}>
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
                                style={{ right: isSidebarOpen ? (sidebarWidth + (isMiniToolbarExpanded ? 220 : 48)) : (isMiniToolbarExpanded ? 220 : 48) }}
                            >
                                <LogoRebuildWorkspace
                                    tabId={tabId || ''}
                                    isActive={isActive === true && activeDashboardTool === 'logo_rebuild'}
                                    hasOtherDirtyChanges={documentIsDirty}
                                    onDirtyChange={setLogoSessionDirty}
                                />
                            </div>
                        )}

                        {/* Empty State Overlay — ẩn khi tool không cần PDF sẵn (AI / office convert / util) */}
                        {!pdfUrl && !canToolRunWithoutPdf(activeDashboardTool) && !(activeDashboardTool === 'sticker' && stickerSheetMode === 'ai-sheet') && (
                            <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none" style={{ right: isSidebarOpen ? sidebarWidth : 0 }}>
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
                                    pageOverlay={activeDashboardTool === 'sticker'
                                        && stickerSheetMode === 'ai-sheet'
                                        && stickerSheetSourceVisible ? (
                                        <StickerSheetWorkspace
                                            tabId={tabId || ''}
                                            isActive={isActive === true}
                                            embedded
                                            editingEnabled={viewerToolMode === 'pointer'}
                                            sourcePage={stickerSheetActiveSourcePage}
                                        />
                                    ) : undefined}
                                    pageOverlayPage={stickerSheetActiveSourcePage}
                                    pageWorkflowStatuses={activeDashboardTool === 'sticker'
                                        && stickerSheetMode === 'ai-sheet'
                                        && stickerSheetSourceVisible
                                        ? stickerSheetPageStatuses
                                        : undefined}
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
                                            onOpenPanel={() => setShowRecipePanel(true)}
                                            sourcePageCount={viewerNumPages}
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
                                            {isImposedOutputFile(file.name) && (
                                                <button
                                                    onClick={() => setShowOpenInDesign(true)}
                                                    className="h-8 px-3 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                                                    title={t('tabs.imposition:mo_trang_khuon_bang_illustrator_corel')}
                                                >
                                                    <Scissors className="w-4 h-4" /> {t('tabs.imposition:be')}
                                                </button>
                                            )}
                                        </div>
                                    ) : undefined}
                                    rightPanel={(
                                        <div
                                            style={{ 
                                                width: activeDashboardTool !== 'none' 
                                                    ? (isSidebarOpen ? `${sidebarWidth + (isMiniToolbarExpanded ? 220 : 48)}px` : (isMiniToolbarExpanded ? '220px' : '48px')) 
                                                    : `${sidebarWidth}px` 
                                            }}
                                            className={`shrink-0 bg-[#f8fafc] dark:bg-zinc-900 shadow-[-10px_0_30px_rgba(0,0,0,0.05)] flex flex-row justify-end z-20 h-full transition-all ${isDraggingSidebar ? 'duration-0' : 'duration-300'} relative border-l border-slate-200 dark:border-zinc-800`}
                                        >
                                        {/* Resizer Handle */}
                                        {/* UIUX (audit 2026-07-27 §B-25): vùng bắt chuột rộng gấp đôi (w-2.5), chỉ vẽ 1px ở giữa — nhìn không đổi */}
                                        <div
                                            className="absolute left-0 top-0 bottom-0 w-2.5 -ml-[5px] cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 z-50 transition-colors"
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                const initialWidth = activeDashboardTool !== 'none'
                                                    ? (isSidebarOpen ? sidebarWidth : (isMiniToolbarExpanded ? 220 : 48))
                                                    : sidebarWidth;
                                                sidebarDragRef.current = {
                                                    startX: e.clientX,
                                                    startWidth: initialWidth,
                                                    lastWidth: initialWidth,
                                                    startOpen: isSidebarOpen
                                                };
                                                setIsDraggingSidebar(true);
                                            }}
                                        >
                                            <div className="absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-app-line pointer-events-none" />
                                        </div>
                                        
                                        {/* Main Config Panel */}
                                        {isSidebarOpen && (
                                            <div className="flex-1 flex flex-col overflow-hidden border-r border-slate-200 dark:border-zinc-800">
                                                {/* Sidebar Header */}
                                                <div className="px-4 h-12 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-slate-100 dark:bg-[#1a1a1a] shrink-0 shadow-sm relative z-10">
                                                    <h2 className="text-[13px] font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5 uppercase tracking-wide">
                                                        {/* UIUX (fix 2026-07-28): tab chuyên dụng không hiện nút thoát nhầm về workspace PDF trống. */}
                                                        {activeDashboardTool !== 'none' && activeDashboardTool !== dedicatedInitialTool && (
                                                            <button
                                                                onClick={() => setActiveDashboardTool(dedicatedInitialTool || 'none')}
                                                                className="flex items-center gap-1.5 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
                                                                title={t('tabs.imposition:quay_lai_danh_sach_cong_cu')}
                                                            >
                                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                                                                {t('tabs.imposition:quay_lai')}
                                                            </button>
                                                        )}
                                                        {/* UIUX (audit 2026-07-27) feedback user: bỏ nhãn "🛠️ THÔNG SỐ" — rối,
                                                            nút ‹ Quay lại đã đủ định vị; giữ chip dung lượng file (thông tin thật) */}
                                                        {(activeDashboardTool !== 'bgremover' && activeDashboardTool !== 'upscale') && fileSizeStr && (
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

                                                        {(isObjectEditMode ? (editSession.canUndo || editHistory.canUndo) : history.length > 0) && activeDashboardTool !== 'bgremover' && activeDashboardTool !== 'upscale' && (
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
                                                            onClick={() => setIsSidebarOpen(false)}
                                                            className="w-7 h-7 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 rounded transition-colors"
                                                            title={t('tabs.imposition:thu_gon_menu')}
                                                            aria-label={t('tabs.imposition:thu_gon_menu')}
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                </div>

                                                <div className="p-4 overflow-y-auto flex-1 flex flex-col text-sm text-slate-800 dark:text-zinc-200 scroller-thin relative bg-[#f8fafc] dark:bg-zinc-900 border-t border-black/5 dark:border-white/5">
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
                                                            onBack={() => setActiveDashboardTool('none')}
                                                            onApplyResult={async (blob: Blob, name: string, path?: string) => {
                                                                recipeRecorder.noteNonRecordable('datamerge');
                                                                await commitWorkingFile(blob, name, path);
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                            }}
                                                            onSpawnTab={(blob: Blob, name: string, path?: string) => {
                                                                const newFile = new File([blob], name, { type: 'application/pdf' });
                                                                if (path) {
                                                                    Object.defineProperty(newFile, 'path', { value: path });
                                                                }
                                                                Object.defineProperty(newFile, 'isGenerated', { value: true });
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
                                                            onBack={() => setActiveDashboardTool('none')}
                                                            onApplyResult={async (blob: Blob, name: string, path?: string) => {
                                                                recipeRecorder.noteNonRecordable('numbering');
                                                                await commitWorkingFile(blob, name, path);
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                            }}
                                                            onSpawnTab={(blob: Blob, name: string, path?: string) => {
                                                                const newFile = new File([blob], name, { type: 'application/pdf' });
                                                                if (path) {
                                                                    Object.defineProperty(newFile, 'path', { value: path });
                                                                }
                                                                Object.defineProperty(newFile, 'isGenerated', { value: true });
                                                                if (onSpawnTab) {
                                                                    onSpawnTab(newFile);
                                                                }
                                                            }}
                                                        />
                                                    ) : rightPanelKind === 'cover_numbering' ? (
                                                        <CoverNumberingTool
                                                            pdfFile={file}
                                                            getWorkingFile={getWorkingFile}
                                                            vdpFields={vdpFields}
                                                            setVdpFields={setVdpFields}
                                                            selectedFieldIds={selectedVdpFieldIds}
                                                            onSelectField={(ids) => setSelectedVdpFieldIds(ids)}
                                                            isActive={isActive}
                                                            onBack={() => setActiveDashboardTool('none')}
                                                            onApplyResult={async (blob: Blob, name: string, path?: string) => {
                                                                recipeRecorder.noteNonRecordable('cover_numbering');
                                                                await commitWorkingFile(blob, name, path);
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                            }}
                                                            onSpawnTab={(blob: Blob, name: string, path?: string) => {
                                                                const newFile = new File([blob], name, { type: 'application/pdf' });
                                                                if (path) {
                                                                    Object.defineProperty(newFile, 'path', { value: path });
                                                                }
                                                                Object.defineProperty(newFile, 'isGenerated', { value: true });
                                                                if (onSpawnTab) onSpawnTab(newFile);
                                                            }}
                                                        />
                                                    ) : rightPanelKind === 'stick_text_number' ? (
                                                        <StickTextNumberTool
                                                            pdfFile={file}
                                                            onFileFixed={(blob, name) => {
                                                                commitWorkingFile(blob, name);
                                                            }}
                                                            onBack={() => setActiveDashboardTool('none')}
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
                                                            onFileFixed={commitWorkingFile}
                                                            systemMergeFiles={systemMergeFiles}
                                                            officeSourceFile={officeSourceFile}
                                                            officeSourceFiles={officeSourceFiles}
                                                            sourceImageFile={sourceImageFile}
                                                            getWorkingFile={getWorkingFile}
                                                            ensureCropFileId={ensureCropFileId}
                                                            onCropApplied={handleCropApplied}
                                                            onCropClose={handleCropClose}
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        
                                        {/* The Fixed Mini Toolbar (Visible when sidebar is collapsed OR when a tool is selected) */}
                                        {(!isSidebarOpen || activeDashboardTool !== 'none') && (
                                            <div className={`relative h-full shrink-0 transition-all ${isDraggingSidebar ? 'duration-0' : 'duration-300'} ${activeDashboardTool !== 'none' ? (isMiniToolbarExpanded ? 'w-[220px]' : 'w-[48px]') : 'w-full'}`}>
                                                <button
                                                    onClick={() => {
                                                        // KHÔNG có công cụ đang chọn: cột mini có độ rộng = sidebarWidth
                                                        // (không đổi theo isMiniToolbarExpanded) → toggle mini chỉ thêm/bớt
                                                        // nhãn, KHÔNG mở panel. Vì vậy mũi tên ở chế độ này MỞ THẲNG panel
                                                        // cấu hình (giống kéo resizer) thay vì toggle nhãn.
                                                        if (activeDashboardTool === 'none') {
                                                            if (sidebarWidth < 280) setSidebarWidth(390);
                                                            setIsSidebarOpen(true);
                                                        } else {
                                                            setIsMiniToolbarExpanded(!isMiniToolbarExpanded);
                                                        }
                                                    }}
                                                    className="absolute top-1/2 -left-[14px] -translate-y-1/2 w-7 h-7 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-full flex items-center justify-center shadow-sm hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors z-[100] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400"
                                                    title={isMiniToolbarExpanded ? t('tabs.imposition:thu_gon_menu_2') : t('tabs.imposition:mo_rong_menu')}
                                                    aria-label={isMiniToolbarExpanded ? t('tabs.imposition:thu_gon_menu_2') : t('tabs.imposition:mo_rong_menu')}
                                                >
                                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                        {isMiniToolbarExpanded ? (
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" /> // >>
                                                        ) : (
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M19 19l-7-7 7-7" /> // <<
                                                        )}
                                                    </svg>
                                                </button>

                                                <div className="w-full h-full flex flex-col items-center bg-[#f8fafc] dark:bg-zinc-900 z-10 overflow-y-auto scroller-none overflow-x-hidden border-l border-slate-200 dark:border-zinc-800">
                                                    <div className="w-full h-12 flex items-center border-b border-black/5 dark:border-white/10 shrink-0 px-2">
                                                        <button
                                                            onClick={() => {
                                                                if (sidebarWidth < 280) setSidebarWidth(390);
                                                                setIsSidebarOpen(true);
                                                            }}
                                                            className={`h-8 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 transition-colors rounded outline-none w-full ${showMiniLabels ? 'justify-start px-2' : ''}`}
                                                            title={t('tabs.imposition:mo_bang_cau_hinh')}
                                                            aria-label={t('tabs.imposition:mo_bang_cau_hinh')}
                                                        >
                                                            <span className="text-slate-500 dark:text-zinc-400"><Settings className="w-4 h-4" /></span>
                                                            {showMiniLabels && <span className="ml-2 text-[13px] font-bold text-slate-700 dark:text-zinc-300">{t('tabs.imposition:cong_cu')}</span>}
                                                        </button>
                                                    </div>
                                                    
                                                    <div className="flex flex-col items-center py-2 gap-0 w-full px-1.5">
                                                        {(() => {
                                                            const allDashboardTools = TOOL_CATEGORIES.flatMap(cat => getToolsByCategory(cat.id)).filter(tool => {
                                                                const key = getToolUniqueKey(tool);
                                                                return isWorkspaceTool(key) && key !== 'none';
                                                            });
                                                            const favTools = allDashboardTools.filter(t => {
                                                                const toolKey = getToolUniqueKey(t);
                                                                return favoriteTools.includes(toolKey) && !hiddenTools.includes(toolKey);
                                                            });
                                                            
                                                            if (favTools.length === 0) return null;
                                                            
                                                            return (
                                                                <div key="favorites" className="w-full flex flex-col items-center mb-1">
                                                                    {showMiniLabels ? (
                                                                        <div className="w-full px-2 mt-2 mb-1.5 flex items-center gap-2">
                                                                            <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest flex items-center gap-1"><Star className="w-2.5 h-2.5" fill="currentColor" /> {t('tabs.imposition:yeu_thich')}</span>
                                                                            <div className="flex-1 h-px bg-amber-500 opacity-40" />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="w-6 h-[2px] bg-amber-500 opacity-40 my-2 rounded-full" title={t('tabs.imposition:yeu_thich')} />
                                                                    )}
                                                                    <div className="flex flex-col items-center gap-1.5 w-full">
                                                                        {favTools.map(tool => {
                                                                            const toolKey = getToolUniqueKey(tool);
                                                                            const isActive = activeDashboardTool === toolKey;
                                                                            return (
                                                                                <button
                                                                                    key={`fav-${toolKey}`}
                                                                                    onClick={() => {
                                                                                        if (isActive && isSidebarOpen) {
                                                                                            setIsSidebarOpen(false);
                                                                                        } else {
                                                                                            // Chỉ đổi active tool — switchToolProfile (ImposerDashboard)
                                                                                            // sẽ lưu/nạp taskMode theo từng công cụ. Không gọi
                                                                                            // applyLockedMode ở đây (sẽ làm hỏng snapshot tool cũ).
                                                                                            requestToolActivation(tool, () => {
                                                                                                setActiveDashboardTool(toolKey);
                                                                                                if (sidebarWidth < 280) setSidebarWidth(390);
                                                                                                setIsSidebarOpen(true);
                                                                                            });
                                                                                        }
                                                                                    }}
                                                                                    className={`relative w-full h-9 rounded-lg flex items-center transition-colors shrink-0 outline-none
                                                                                        ${showMiniLabels ? 'justify-start px-2' : 'justify-center'}
                                                                                        ${isActive ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 shadow-sm border border-amber-300 dark:border-amber-700/50' : 'bg-amber-50/50 dark:bg-amber-900/20 text-slate-700 dark:text-zinc-300 border border-amber-200/50 dark:border-amber-700/30 hover:bg-amber-100/80 dark:hover:bg-amber-900/40 hover:text-amber-900 dark:hover:text-amber-100'}`
                                                                                    }
                                                                                    // UIUX (audit 2026-07-27 §B-14): báo trước click tool đang mở sẽ thu gọn panel
                                                                                    title={isActive && isSidebarOpen ? t('tabs.imposition:dang_mo_bam_de_thu_gon_panel', 'Đang mở — bấm để thu gọn panel') : tv(tool.title)}
                                                                                >
                                                                                    <span className="text-lg shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
                                                                                    {showMiniLabels && <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tv(tool.title)}</span>}
                                                                                    <ProFeatureBadge featureId={tool.featureId} className={showMiniLabels ? 'ml-auto' : 'absolute right-0 top-0 scale-75'} />
                                                                                </button>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })()}
                                                        {TOOL_CATEGORIES.map(cat => {
                                                            const catTools = getToolsByCategory(cat.id).filter(t => {
                                                                const toolKey = getToolUniqueKey(t);
                                                                if (!isWorkspaceTool(toolKey) || toolKey === 'none') return false;
                                                                if (hiddenTools.includes(toolKey)) return false;
                                                                if (favoriteTools.includes(toolKey)) return false;
                                                                return true;
                                                            });
                                                            if (catTools.length === 0) return null;
                                                            return (
                                                                <div key={cat.id} className="w-full flex flex-col items-center mb-1">
                                                                    {showMiniLabels ? (
                                                                        <div className="w-full px-2 mt-2 mb-1.5 flex items-center gap-2">
                                                                            <span className="text-[10px] font-bold text-indigo-800 dark:text-indigo-400 uppercase tracking-widest">{tv(cat.title)}</span>
                                                                            <div className="flex-1 h-px bg-indigo-800 dark:bg-indigo-400 opacity-40" />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="w-6 h-[2px] bg-indigo-800 dark:bg-indigo-400 opacity-40 my-2 rounded-full" title={tv(cat.title)} />
                                                                    )}
                                                                    <div className="flex flex-col items-center gap-1.5 w-full">
                                                                        {catTools.map(tool => {
                                                                            const toolKey = getToolUniqueKey(tool);
                                                                            const isActive = activeDashboardTool === toolKey;
                                                                            return (
                                                                                <button
                                                                                    key={toolKey}
                                                                                    onClick={() => {
                                                                                        if (isActive && isSidebarOpen) {
                                                                                            setIsSidebarOpen(false);
                                                                                        } else {
                                                                                            requestToolActivation(tool, () => {
                                                                                                setActiveDashboardTool(toolKey);
                                                                                                if (sidebarWidth < 280) setSidebarWidth(390);
                                                                                                setIsSidebarOpen(true);
                                                                                            });
                                                                                        }
                                                                                    }}
                                                                                    className={`relative w-full h-9 rounded-lg flex items-center transition-colors shrink-0 outline-none
                                                                                        ${showMiniLabels ? 'justify-start px-2' : 'justify-center'}
                                                                                        ${isActive ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 shadow-sm border border-indigo-300 dark:border-indigo-700/50' : 'hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-transparent'}`
                                                                                    }
                                                                                    // UIUX (audit 2026-07-27 §B-14): báo trước click tool đang mở sẽ thu gọn panel
                                                                                    title={isActive && isSidebarOpen ? t('tabs.imposition:dang_mo_bam_de_thu_gon_panel', 'Đang mở — bấm để thu gọn panel') : tv(tool.title)}
                                                                                >
                                                                                    <span className="text-lg shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
                                                                                    {showMiniLabels && <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tv(tool.title)}</span>}
                                                                                    <ProFeatureBadge featureId={tool.featureId} className={showMiniLabels ? 'ml-auto' : 'absolute right-0 top-0 scale-75'} />
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
