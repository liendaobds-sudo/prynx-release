import { useCallback, useMemo, useEffect, useRef, useState, useContext } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TOOL_REGISTRY, TOOL_CATEGORIES, getToolsByCategory } from '../lib/toolRegistry';

import PDFUploader from './PDFUploader';
import AcrobatViewer from './AcrobatViewer';
import { useObjectEditHistory } from '../hooks/useObjectEditHistory';
import { imposePdf, imposeCatalogBatch, ImpositionMode, type ProcessingSettings, type CatalogBatchResult } from '../lib/pdfImposer';
import { planCatalog, verifyCatalogPlan, type PlanConfig, type PlateJob } from '../lib/imposerEngine/CatalogPlanner';
import { Button } from './Button';
import { Scissors, Settings, Star } from 'lucide-react';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import ImposerDashboard from './imposition-tools/ImposerDashboard';
import CutExportModal from './imposition-tools/cut-export/CutExportModal';
import { PREDEFINED_SIZES, resolveRightPanel, type BookletSettings, type NupSettings } from './imposition-tools/types';
import { ImposerSettingsContext, createImposerSettingsStore, useImposerSettingsStore } from './imposition-tools/useImposerSettingsStore';
import { generateBindingMap } from '../lib/imposerEngine/VirtualMap';
import { applyRule, executeShuffle, getPresetById, parseRule, reversePages, shuffleEvenOdd } from '../lib/preprocessEngine/ShuffleEngine';
import { resizePages } from '../lib/preprocessEngine/PageResizer';
import { splitPdf, parseRanges } from '../lib/preprocessEngine/PdfSplitter';
import { mergePdf } from '../lib/preprocessEngine/PdfMerger';
import { getApiUrl, uploadPDF, startVdpJobBackend, pollVdpJob, authenticatedFetch } from '../lib/api';
import { recipeRecorder } from '../lib/recipe/RecipeRecorder';
import { isOutputFile, isImposedOutputFile } from '../lib/constants';
import { writeSnapshot, deleteSnapshot } from '../lib/recovery';
import { getFileArrayBuffer, detectColorSpace } from '../lib/utils';
import { saveVdpTemplate, loadVdpTemplate } from '../lib/vdpTemplate';
import OutputPreviewTab, { type PlateOverlay } from './OutputPreviewTab';
import RecipeRecordControl from './recipe/RecipeRecordControl';
import RecipePanel from './recipe/RecipePanel';
import { toast } from './ui/Toast';
import type { Recipe } from '../lib/recipe/recipeTypes';
import DataMergeTool from './preprocess-tools/DataMergeTool';
import NumberingTool from './preprocess-tools/NumberingTool';
import CoverNumberingTool from './preprocess-tools/CoverNumberingTool';
import StickTextNumberTool from './preprocess-tools/StickTextNumberTool';
import SaveModal from './workspace/SaveModal';
import SavePrintFilesModal from './workspace/SavePrintFilesModal';
import EditLayersPanel from './workspace/SelectionLayersPanel';
import { useAppSettingsStore } from '../stores/appSettingsStore';

import { WorkspaceContext, createWorkspaceStore, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';
import { globalPdfObjectCache } from '../stores/pdfObjectCache';
import { BgRemoverPreview } from './preprocess-tools/BgRemoverTool';
import { UpscalePreview } from './preprocess-tools/UpscaleTool';

// Phase type is now defined in useWorkspaceStore

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
    initialRecovery?: import('../lib/recovery').RecoverySnapshot;
}

export default function ImpositionTab(props: Props) {
    const storeRef = useRef<ReturnType<typeof createWorkspaceStore> | null>(null);
    const imposerStoreRef = useRef<ReturnType<typeof createImposerSettingsStore> | null>(null);
    if (!storeRef.current) {
        storeRef.current = createWorkspaceStore();
    }
    if (!imposerStoreRef.current) {
        imposerStoreRef.current = createImposerSettingsStore();
    }
    return (
        <ImposerSettingsContext.Provider value={imposerStoreRef.current}>
            <WorkspaceContext.Provider value={storeRef.current}>
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

function ImpositionTabInner({ tabId, isActive, onDirtyChange, onTitleChange, onSpawnTab, initialFile, initialReport, initialFeature, lockedMode, batchOutput: initialBatchOutput, systemMergeFiles, initialRecovery, imposerStoreRef }: Props & { imposerStoreRef: React.MutableRefObject<ReturnType<typeof createImposerSettingsStore> | null> }) {
    //#region State & Hooks
    // ═══ All state from Zustand store ═══
    const {
        phase, setPhase, file, setFile, originalFileName, setOriginalFileName,
        pdfUrl, setPdfUrl, fileSizeStr, setFileSizeStr, highlightedIssue, setHighlightedIssue,
        isProcessing, setIsProcessing, processStatus, setProcessStatus, error, setError,
        history, setHistory, isSaved, setIsSaved, showSaveAsModal, setShowSaveAsModal,
        reportMsg, setReportMsg, viewerDirty, setViewerDirty, viewerPageOrder, setViewerPageOrder,
        viewerPageRotations, setViewerPageRotations, bleedView, setBleedView,
        isDraggingSidebar, setIsDraggingSidebar,
        showOutputPreview, setShowOutputPreview, separationPlates, setSeparationPlates,
        pdfObjectsVersion, setPdfObjectsVersion,
        isObjectEditMode,
        currentEditObjects,
        pdfOcgLayers, setPdfOcgLayers,
        selectedObjectIds, setSelectedObjectIds, hiddenObjectIds, setHiddenObjectIds,
        setLockedObjectIds,
        hiddenOcgLayerIds, setHiddenOcgLayerIds,
        selectionFileId, setSelectionFileId, vdpFields, setVdpFields,
        selectedVdpFieldIds, setSelectedVdpFieldIds,
        showCloseConfirm, setShowCloseConfirm,
        viewerNumPages,
        viewerActivePage,
        setDetectedShapeType, setDetectedShapeParams, 
        setDetectedShapesByPage, setDetectedDimensionsByPage, setDetectedShapeParamsByPage,
        detectedDimensionsByPage,
        setViewerZoom, setViewerFitMode, setViewerPageDisplayMode
    } = useWorkspaceStore(useShallow(state => ({
        phase: state.phase, setPhase: state.setPhase, file: state.file, setFile: state.setFile, originalFileName: state.originalFileName, setOriginalFileName: state.setOriginalFileName,
        pdfUrl: state.pdfUrl, setPdfUrl: state.setPdfUrl, fileSizeStr: state.fileSizeStr, setFileSizeStr: state.setFileSizeStr, highlightedIssue: state.highlightedIssue, setHighlightedIssue: state.setHighlightedIssue,
        isProcessing: state.isProcessing, setIsProcessing: state.setIsProcessing, processStatus: state.processStatus, setProcessStatus: state.setProcessStatus, error: state.error, setError: state.setError,
        history: state.history, setHistory: state.setHistory, isSaved: state.isSaved, setIsSaved: state.setIsSaved, showSaveAsModal: state.showSaveAsModal, setShowSaveAsModal: state.setShowSaveAsModal,
        reportMsg: state.reportMsg, setReportMsg: state.setReportMsg, viewerDirty: state.viewerDirty, setViewerDirty: state.setViewerDirty, viewerPageOrder: state.viewerPageOrder, setViewerPageOrder: state.setViewerPageOrder,
        viewerPageRotations: state.viewerPageRotations, setViewerPageRotations: state.setViewerPageRotations, bleedView: state.bleedView, setBleedView: state.setBleedView,
        isDraggingSidebar: state.isDraggingSidebar, setIsDraggingSidebar: state.setIsDraggingSidebar,
        showOutputPreview: state.showOutputPreview, setShowOutputPreview: state.setShowOutputPreview, separationPlates: state.separationPlates, setSeparationPlates: state.setSeparationPlates,
        pdfObjectsVersion: state.pdfObjectsVersion, setPdfObjectsVersion: state.setPdfObjectsVersion,
        isObjectEditMode: state.isObjectEditMode,
        currentEditObjects: state.currentEditObjects,
        pdfOcgLayers: state.pdfOcgLayers, setPdfOcgLayers: state.setPdfOcgLayers,
        selectedObjectIds: state.selectedObjectIds, setSelectedObjectIds: state.setSelectedObjectIds, hiddenObjectIds: state.hiddenObjectIds, setHiddenObjectIds: state.setHiddenObjectIds,
        setLockedObjectIds: state.setLockedObjectIds,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds, setHiddenOcgLayerIds: state.setHiddenOcgLayerIds,
        selectionFileId: state.selectionFileId, setSelectionFileId: state.setSelectionFileId, vdpFields: state.vdpFields, setVdpFields: state.setVdpFields,
        selectedVdpFieldIds: state.selectedVdpFieldIds, setSelectedVdpFieldIds: state.setSelectedVdpFieldIds,
        showCloseConfirm: state.showCloseConfirm, setShowCloseConfirm: state.setShowCloseConfirm,
        viewerNumPages: state.viewerNumPages,
        viewerActivePage: state.viewerActivePage,
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
        activeDashboardTool, setActiveDashboardTool,
        batchOutput, setBatchOutput,
        confirmBookletSettings, setConfirmBookletSettings,
    } = useImposerSettingsStore(useShallow(s => ({
        activeDashboardTool: s.activeDashboardTool, setActiveDashboardTool: s.setActiveDashboardTool,
        batchOutput: s.batchOutput, setBatchOutput: s.setBatchOutput,
        confirmBookletSettings: s.confirmBookletSettings, setConfirmBookletSettings: s.setConfirmBookletSettings,
    })));

    const { isWorkspaceSidebarOpen: isSidebarOpen, favoriteTools, hiddenTools } = useAppSettingsStore();
    const setIsSidebarOpen = useAppSettingsStore(state => state.setWorkspaceSidebarOpen);
    const sidebarWidth = useAppSettingsStore(state => state.toolMenuWidth);
    const setSidebarWidth = useAppSettingsStore(state => state.setToolMenuWidth);

    const [isMiniToolbarExpanded, setIsMiniToolbarExpanded] = useState(false);
    const [showSavePrintModal, setShowSavePrintModal] = useState(false);
    const [scaleConfirmModal, setScaleConfirmModal] = useState<{ msg: string, resolve: (v: boolean) => void } | null>(null);
    // Gửi Máy Bế (spec: gui-may-be) — chỉ hiện trên toolbar khi file là OUTPUT đã bình.
    const [showCutExport, setShowCutExport] = useState(false);
    const [showRecipePanel, setShowRecipePanel] = useState(false);
    // Lựa chọn vị trí trang trắng — chỉ hỏi trong dialog Xác nhận khi số trang lẻ tay.
    const [confirmBlankPlacement, setConfirmBlankPlacement] = useState<'end' | 'center'>('end');

    // Set initial report from props (once)
    useEffect(() => {
        if (initialReport && !reportMsg) setReportMsg(initialReport);
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
    // Handle initial file passed from App.tsx (if spawned via multi-file drop)
    useEffect(() => {
        if (initialFile && !file) {
            if (pdfUrl) URL.revokeObjectURL(pdfUrl);
            let objUrl = '';
            if ((window as any).__TAURI_INTERNALS__ && (initialFile as any).path) {
                objUrl = convertFileSrc((initialFile as any).path);
            } else {
                objUrl = URL.createObjectURL(initialFile);
            }
            setFile(initialFile);
            setOriginalFileName(initialFile.name);
            setFileSizeStr((initialFile.size / (1024 * 1024)).toFixed(2) + ' MB');
            setPdfUrl(objUrl);
            setPhase('workspace');
            onTitleChange?.(initialFile.name);
            
            // Defer: chỉ cập nhật tiêu đề (RGB/CMYK), không cấp thiết khi mở → tránh
            // gọi Python tranh chấp với meta + render trang đầu.
            const _csTimer = setTimeout(() => {
                detectColorSpace(initialFile).then(cs => {
                    if (cs) {
                        onTitleChange?.(`${initialFile.name} (${cs})`);
                    }
                });
            }, 2500);

            if (initialBatchOutput) {
                setBatchOutput(initialBatchOutput);
            }
        }
    }, [initialFile, initialBatchOutput]);

    // Handle initial tool feature from Home screen
    useEffect(() => {
        if (initialFeature) {
            // Only auto-bypass upload for standalone tools
            if (initialFeature === 'bgremover' || initialFeature === 'upscale') {
                setPhase('workspace');
            }
            setActiveDashboardTool(initialFeature);
            if (lockedMode) {
                imposerStoreRef.current!.getState().setTaskMode(lockedMode);
            }
            if (!file) {
                const names: Record<string, string> = {
                    'bgremover': 'Tách Nền AI',
                    'upscale': 'Phóng To Ảnh',
                    'sticker': 'Tạo Viền Cắt Bế',
                    'split': 'Tách File',
                    'datamerge': 'Trộn Dữ Liệu VDP',
                    'numbering': 'Nhảy Số Tự Động',
                    'optimize': 'Nén / Tối ưu PDF',
                    'shuffle': 'Xáo trộn trang',
                    'resize': 'Co giãn trang'
                };
                if (names[initialFeature]) {
                    onTitleChange?.(names[initialFeature]);
                }
            }
        }
    }, [initialFeature, file]);

    // Async physical path polyfill (non-blocking via HTTP)
    useEffect(() => {
        if (file && !(file as any).path && (window as any).__TAURI_INTERNALS__) {
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
                        const resp = await fetch(objUrl);
                        const buffer = await resp.arrayBuffer();
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
                        Object.defineProperty(file, 'path', { value: tempPath });
                        try { Object.defineProperty(file, 'isTempUploadPath', { value: true, configurable: true }); } catch { /* ignore */ }
                        // Clone the file to trigger state update so LivePageFrame sees the path
                        const newFile = new File([file], file.name, { type: file.type });
                        Object.defineProperty(newFile, 'path', { value: tempPath });
                        try { Object.defineProperty(newFile, 'isTempUploadPath', { value: true, configurable: true }); } catch { /* ignore */ }
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

    const isDirty = useMemo(() => {
        if (isSaved) return false;
        if (history.length > 0) return true;
        if (viewerDirty) return true;

        if (file && isOutputFile(file.name)) return true;

        if (viewerPageRotations && Object.keys(viewerPageRotations).length > 0) return true;
        if (vdpFields && vdpFields.length > 0) return true;
        return false;
    }, [isSaved, history.length, file, viewerPageRotations, vdpFields, viewerDirty]);

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
        if (!isDirty || !fpath || isEphemeralBackendPath(fpath)) {
            void deleteSnapshot(tabId);
            return;
        }
        const t = setTimeout(() => {
            void writeSnapshot({
                v: 1,
                tabId,
                title: originalFileName || file?.name || 'Tài liệu',
                savedAt: new Date().toISOString(),
                originalPath: fpath,
                originalName: file?.name || originalFileName || 'document.pdf',
                feature: initialFeature,
                lockedMode,
                viewerPageOrder: viewerPageOrder || undefined,
                viewerPageRotations: viewerPageRotations || undefined,
                vdpFields: (vdpFields && vdpFields.length) ? vdpFields : undefined,
            });
        }, 8000);
        return () => clearTimeout(t);
    }, [tabId, isDirty, file, originalFileName, viewerPageOrder, viewerPageRotations, vdpFields, initialFeature, lockedMode]);

    // Áp KHÔI PHỤC một lần khi mở tab từ snapshot: dựng lại thao tác sửa trên file gốc.
    useEffect(() => {
        if (!initialRecovery) return;
        if (initialRecovery.viewerPageOrder) setViewerPageOrder(initialRecovery.viewerPageOrder);
        if (initialRecovery.viewerPageRotations) setViewerPageRotations(initialRecovery.viewerPageRotations);
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
        if (file) {
            setHistory(prev => [...prev, file]);
        }
        // Use newName to correctly reflect the current file's processing state
        const displayName = newName;
        setOriginalFileName(newName);
        
        let newFile = new File([newBlob as any], displayName, { type: 'application/pdf' });
        
        try {
            if ((window as any).__TAURI_INTERNALS__) {
                let tempPath = '';
                // VDP/job kết quả: backend đã ghi file thật ra đĩa và trả về đường dẫn
                // (newBlob lúc này chỉ là blob "dummy" để skip download). Dùng thẳng
                // path thật → tile native render đúng, KHÔNG ghi đè bằng blob rỗng.
                if (existingPath) {
                    tempPath = existingPath;
                } else {
                    try {
                        const { uploadFileForNup } = await import('../lib/api');
                        tempPath = await uploadFileForNup(newFile);
                    } catch (err) {
                        console.warn("HTTP upload failed for fix pdf, falling back to IPC");
                        const { tempDir, join } = (await import('@tauri-apps/api/path')) as any;
                        const { writeFile } = (await import('@tauri-apps/plugin-fs')) as any;
                        const buffer = await newBlob.arrayBuffer();
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
        setPdfUrl(URL.createObjectURL(newBlob));
        setFileSizeStr((newBlob.size / (1024 * 1024)).toFixed(2) + ' MB');
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
    }, [file, originalFileName, onTitleChange]);


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
            if (!res.ok) throw new Error('Không thể tải danh sách objects');

            const data = await res.json();
            const objects = data.objects || data; // edit returns {objects, pageBox}, preflight {objects}

            const currentPdfUrl = store!.getState().pdfUrl || '';
            globalPdfObjectCache.setPageObjects(currentPdfUrl, pageNum, Array.isArray(objects) ? objects : objects.objects || []);
            setPdfObjectsVersion(prev => prev + 1);

            // OCG layers (kept for now, though OCG support is limited)
            if (store!.getState().pdfOcgLayers.length === 0) {
                try {
                    const layerRes = await authenticatedFetch(`${getApiUrl()}/preflight/layers/${fid}`);
                    if (layerRes.ok) {
                        const layerData = await layerRes.json();
                        store!.getState().setPdfOcgLayers(layerData.layers || []);
                    }
                } catch (e) {
                    console.warn("Failed to fetch OCG layers", e);
                }
            }
        } catch (err: any) {
            setError(err.message || `Lỗi tải object trang ${pageNum}`);
        }
    }, [file, setError, setPdfObjectsVersion, store]);

    // Refresh OCG layers on demand (from Layer Panel actions)
    useEffect(() => {
        const handleRefreshLayers = async () => {
            const fid = selectionFileId;
            if (!fid) return;
            try {
                const layerRes = await authenticatedFetch(`${getApiUrl()}/preflight/layers/${fid}`);
                if (layerRes.ok) {
                    const layerData = await layerRes.json();
                    setPdfOcgLayers(layerData.layers || []);
                }
            } catch (e) {
                console.warn("Failed to refresh OCG layers", e);
            }
        };
        window.addEventListener('refresh-ocg-layers', handleRefreshLayers);
        return () => window.removeEventListener('refresh-ocg-layers', handleRefreshLayers);
    }, [selectionFileId, setPdfOcgLayers]);



    const handleDeleteObjects = useCallback(async (objs: any[], pageNum: number) => {
        if (!selectionFileId) {
            setError("Lỗi: Không tìm thấy selectionFileId! (Có thể file chưa tải xong)");
            return;
        }
        if (objs.length === 0) {
            setError("Lỗi: Chưa có object nào được chọn!");
            return;
        }

        // alert(`Bắt đầu xóa ${objs.length} object trên trang ${pageNum}...`);
        setIsProcessing(true);
        setProcessStatus('Đang xóa đối tượng...');
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
            if (!res.ok) throw new Error('Xóa thất bại');
            const data = await res.json();

            if (data.success && data.output_filename) {
                const pdfRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
                if (pdfRes.ok) {
                    const blob = await pdfRes.blob();
                    commitWorkingFile(blob, data.output_filename);
                } else {
                    setError('Lỗi tải file mới');
                }
            } else {
                setError('API trả về thành công nhưng thiếu dữ liệu');
            }
        } catch (err: any) {
            setError(err.message || 'Lỗi xóa đối tượng');
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
                newPdfUrl = convertFileSrc(outputPath);
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
                if (!res.ok) throw new Error(`Tải Working_File mới thất bại (HTTP ${res.status})`);
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

            // Dọn pdfUrl cũ (chỉ revoke nếu là blob — convertFileSrc/https là no-op không cần).
            if (prevPdfUrl && prevPdfUrl.startsWith('blob:') && prevPdfUrl !== newPdfUrl) {
                URL.revokeObjectURL(prevPdfUrl);
            }
            // LƯU Ý: KHÔNG reset viewerPageOrder/rotations (edit không đụng thứ tự trang)
            // và KHÔNG detectColorSpace (bỏ để giảm tải mỗi op) — khác commitWorkingFile.
        } catch (err: any) {
            setError(err?.message || 'Lỗi cập nhật sau chỉnh sửa');
        }
    }, [file, pdfUrl, setHistory, setFile, setOriginalFileName, setPdfUrl, setFileSizeStr,
        setIsSaved, onTitleChange, setSelectionFileId, setError, selectionFileId, editHistory]);

    // ----------------------------

    const handleUndo = useCallback(() => {
        if (history.length === 0) return;

        const prevFile = history[history.length - 1];
        setHistory(prev => prev.slice(0, -1));

        setFile(prevFile);
        
        if (pdfUrl && !pdfUrl.startsWith('https://')) URL.revokeObjectURL(pdfUrl);
        let objUrl = '';
        if ((window as any).__TAURI_INTERNALS__ && (prevFile as any).path) {
            objUrl = convertFileSrc((prevFile as any).path);
        } else {
            objUrl = URL.createObjectURL(prevFile);
        }
        setPdfUrl(objUrl);
        setFileSizeStr((prevFile.size / (1024 * 1024)).toFixed(2) + ' MB');
        onTitleChange?.(prevFile.name);
        
        detectColorSpace(prevFile).then(cs => {
            if (cs) onTitleChange?.(`${prevFile.name} (${cs})`);
        });

        setViewerPageOrder(undefined);
        setViewerPageRotations(undefined);

        // Reset detection so it re-runs if needed
        setDetectedShapeType(null);
        setDetectedShapeParams(null);
        setDetectedShapesByPage({});
        setDetectedDimensionsByPage({});
        setDetectedShapeParamsByPage({});
    }, [history, onTitleChange]);




    const sidebarDragRef = useRef({ startX: 0, startWidth: 0, lastWidth: 0 });

    useEffect(() => {
        if (!isDraggingSidebar) return;
        const handleMouseMove = (e: MouseEvent) => {
            const deltaX = sidebarDragRef.current.startX - e.clientX;
            const newWidth = sidebarDragRef.current.startWidth + deltaX;
            
            if (activeDashboardTool !== 'none') {
                if (newWidth >= 280) {
                    setIsSidebarOpen(true);
                    setSidebarWidth(Math.min(newWidth, 800));
                } else {
                    setIsSidebarOpen(false);
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
        setFile(selectedFile);
        setOriginalFileName(selectedFile.name);
        setSelectionFileId(''); // Reset — will be re-uploaded by the useEffect above
        setFileSizeStr(formatSize(selectedFile.size));
        
        if (pdfUrl && !pdfUrl.startsWith('https://')) URL.revokeObjectURL(pdfUrl);
        let objUrl = '';
        if ((window as any).__TAURI_INTERNALS__ && (selectedFile as any).path) {
            objUrl = convertFileSrc((selectedFile as any).path);
        } else {
            objUrl = URL.createObjectURL(selectedFile);
        }
        setPdfUrl(objUrl);
        setPhase('workspace');
        
        setError('');
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
    }, [onTitleChange, onSpawnTab]);
    //#endregion

    //#region Processing Handlers
    // ═══ Processing handlers (extracted to lib/processHandlers.ts) ═══
    const buildProcessContext = useCallback(() => {
        const getWorkingBytesLocal = async (): Promise<Uint8Array> => {
            if (viewerPageOrder) {
                const bakedBlob = await applyAcrobatEdits();
                if (bakedBlob) return new Uint8Array(await bakedBlob.arrayBuffer());
            }
            return new Uint8Array(await file!.arrayBuffer());
        };
        return {
            file: file!,
            onSpawnTab,
            commitWorkingFile,
            // Bọc setError: khi một thao tác (đã noteOperation) BÁO LỖI (msg≠'') →
            // dọn pending note để KHÔNG bị ghép nhầm vào commit của thao tác sau.
            setError: (msg: string) => { if (msg) recipeRecorder.discardPending(); setError(msg); },
            setIsProcessing, setProcessStatus, setReportMsg, setBatchOutput,
            viewerNumPages,
            getWorkingBytes: getWorkingBytesLocal,
        };
    }, [file, onSpawnTab, commitWorkingFile, viewerNumPages, viewerPageOrder, viewerPageRotations]);

    const processEngine = useCallback(async (settings: ProcessingSettings, spawnNewTab: boolean) => {
        if (!file) return;
        
        // Inject custom confirmation callback
        settings.onConfirmScale = (msg: string) => {
            return new Promise<boolean>((resolve) => {
                setScaleConfirmModal({ msg, resolve });
            });
        };

        // ─── Recipe record hook ───
        // Chỉ ghi khi commit vào working file (spawnNewTab=false). onConfirmScale
        // là hàm → bị JSON.stringify loại khi clone params (an toàn để phát lại).
        if (!spawnNewTab) {
            const opId = settings.impositionMode === ImpositionMode.Booklet
                ? 'booklet'
                : (settings as any).imposerMode === 'cnc'
                    ? 'cnc_imposer'
                    : (settings as any).imposerMode === 'diecut'
                        ? 'sticker_imposer'
                        : 'nup';
            let recordParams: any = settings;
            if (opId === 'sticker_imposer' || opId === 'cnc_imposer') {
                // KHÔNG lưu HÌNH per-file (detectedShapes*) / thứ tự trang / đếm theo trang:
                // phát lại sẽ DÒ LẠI hình trên file tem mới → đúng cho từng sản phẩm.
                const {
                    detectedShapesByPage, detectedShapeParamsByPage, detectedDimensionsByPage,
                    shapeType, shapeParams, targetQuantitiesByPage, pageOrder, pageRotations,
                    ...rest
                } = settings as any;
                recordParams = rest;
            }
            recipeRecorder.noteOperation(opId, recordParams);
        }

        const { runProcessEngine } = await import('../lib/processHandlers');
        await runProcessEngine(buildProcessContext(), settings, spawnNewTab);
    }, [file, buildProcessContext]);

    const handleStartCatalogPlan = useCallback(async (planConfig: any, sheetSettings: any) => {
        if (!file) return;
        const { runCatalogPlan } = await import('../lib/processHandlers');
        await runCatalogPlan(buildProcessContext(), planConfig, sheetSettings);
    }, [file, buildProcessContext]);

    const handleStartShuffle = async (settings: any) => {
        if (!file) return;
        if (!settings.spawnNewTab) recipeRecorder.noteOperation('shuffle', settings);
        const { runShuffle } = await import('../lib/processHandlers');
        await runShuffle(buildProcessContext(), settings);
    };

    const handleStartResize = async (settings: any) => {
        if (!file) return;
        if (!settings.spawnNewTab) recipeRecorder.noteOperation('resize', settings);
        const { runResize } = await import('../lib/processHandlers');
        await runResize(buildProcessContext(), settings);
    };

    const handleStartTrimShift = async (settings: any) => {
        if (!file) return;
        if (!settings.spawnNewTab) recipeRecorder.noteOperation('trim_shift', settings);
        const { runTrimShift } = await import('../lib/processHandlers');
        await runTrimShift(buildProcessContext(), settings);
    };

    const handleStartSplit = useCallback(async (settings: any) => {
        if (!file) return;
        if (!settings.spawnNewTab) recipeRecorder.noteOperation('split', settings);
        const { runSplit } = await import('../lib/processHandlers');
        await runSplit(buildProcessContext(), settings);
    }, [file, buildProcessContext]);

    const handleStartMerge = useCallback(async (settings: any) => {
        if (!file && settings.mode === 'insert_pages') return;
        if (!settings.spawnNewTab) {
            // KHÔNG lưu blob file ngoài vào recipe (Property 7) — chỉ lưu cấu hình ghép.
            const { filesToMerge, oddFile, evenFile, ...mergeParams } = settings;
            recipeRecorder.noteOperation('merge', mergeParams);
        }
        const { runMerge } = await import('../lib/processHandlers');
        await runMerge(buildProcessContext(), settings);
    }, [file, buildProcessContext]);

    // ─── Recipe playback (Task 9) ───
    // Chuỗi working file CỤC BỘ trong 1 lần phát: getWorkingBytes/commitWorkingFile
    // ghi đè để bước sau nhận output bước trước (tránh state `file` cũ trong closure).
    const playRecipe = useCallback(async (recipe: Recipe) => {
        if (!file) { toast.error('Hãy mở một file PDF trước khi phát lại.'); return; }
        const base = buildProcessContext();
        let currentBytes: Uint8Array;
        try { currentBytes = await base.getWorkingBytes(); }
        catch { currentBytes = new Uint8Array(await file.arrayBuffer()); }
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
            requestExternalInput,
            onProgress: ({ index, total, step }) => setProcessStatus(`Phát lại ${index + 1}/${total}: ${step.label}`),
        });
        setProcessStatus('');

        if (res.ok) {
            toast.success(`Phát lại xong: ${res.completed} bước${res.skipped ? `, bỏ qua ${res.skipped}` : ''}.`);
        } else {
            toast.error(`Dừng ở bước ${(res.failedStep?.index ?? 0) + 1}: ${res.failedStep?.error || 'lỗi'}`);
        }
    }, [file, buildProcessContext, commitWorkingFile]);

    const handleStartBooklet = useCallback((config: BookletSettings) => {
        // NOTE: For 'auto_100', sheet dimension will be dynamically resolved inside the Engine during Phase 2.
        const actualFormsize = config.scaleMode === '100' ? 'auto_100' : config.formsize;
        const isCustom = actualFormsize === 'custom' || actualFormsize.startsWith('custom_');
        const sheetW = isCustom ? config.customSheetWidth : (PREDEFINED_SIZES[actualFormsize]?.w || config.customSheetWidth);
        const sheetH = isCustom ? config.customSheetHeight : (PREDEFINED_SIZES[actualFormsize]?.h || config.customSheetHeight);

        const settings: any = {
            imposerMode: config.foldPattern ? 'offset' : 'guillotine',
            impositionMode: ImpositionMode.Booklet,
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
            interleave: config.interleave,
            foldPattern: config.foldPattern,
            gripperMargin: config.gripperMargin,
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
            pageOrder: viewerPageOrder,
            pageRotations: viewerPageRotations
        };

        // Calculate preview report
        const effectiveFoliosize = ((settings as any).chainNup && (settings as any).foldPattern && (settings as any).foldPattern.startsWith('sig_'))
            ? parseInt((settings as any).foldPattern.split('_')[1])
            : config.foliosize;

        const totalPages = viewerPageOrder ? viewerPageOrder.length : 0;
        const paddedPages = Math.ceil(totalPages / 4) * 4;
        const mapResult = generateBindingMap(totalPages, (settings as any).bindingMode || 'saddle', effectiveFoliosize, (settings as any).blankPlacement || 'end');

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
            setConfirmBlankPlacement('end');
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
        const isCustom = config.formsize === 'custom';
        const sheetW = isCustom ? config.customSheetWidth : (PREDEFINED_SIZES[config.formsize]?.w || config.customSheetWidth);
        const sheetH = isCustom ? config.customSheetHeight : (PREDEFINED_SIZES[config.formsize]?.h || config.customSheetHeight);

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
            align: config.align,
            mirrorAlign: config.mirrorAlign,
            markType: config.markType,
            markOffset: config.markOffset,
            markLength: config.markLength,
            markThickness: config.markThickness,
            markStyle: config.markStyle,
            pageOrder: viewerPageOrder,
            pageRotations: viewerPageRotations,
            isDieCutMode: config.isDieCutMode,
            cutType: config.cutType,
            fillBlockGap: config.fillBlockGap,
            pontType: config.pontType,
            pontConfig: config.pontConfig,
            shapeType: config.shapeType,
            shapeParams: config.shapeParams,
            detectedShapesByPage: config.detectedShapesByPage,
            detectedShapeParamsByPage: config.detectedShapeParamsByPage,
            targetQuantity: config.targetQuantity,
            targetQuantitiesByPage: config.targetQuantitiesByPage,
            groupingStrategy: config.groupingStrategy,
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
        
        onTitleChange?.('Không có file');
    };

    const handleReset = () => {
        if (isDirty || viewerDirty) {
            setShowCloseConfirm(true);
            return;
        }
        forceReset();
    };

    const applyAcrobatEdits = async () => {
        if (!file || !viewerPageOrder) return null;
        const rotations = viewerPageRotations || {};
        const arrayBuffer = await getFileArrayBuffer(file);
        const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const newDoc = await PDFDocument.create();

        for (const pIdx of viewerPageOrder) {
            if (pIdx === -1) {
                const firstPage = srcDoc.getPages()[0];
                const defaultDim = firstPage ? { w: firstPage.getSize().width, h: firstPage.getSize().height } : { w: 595.28, h: 841.89 };
                newDoc.addPage([defaultDim.w, defaultDim.h]);
            } else {
                const [copiedPage] = await newDoc.copyPages(srcDoc, [pIdx - 1]);
                const rot = rotations[pIdx];
                if (rot) {
                    const currentRot = copiedPage.getRotation().angle;
                    copiedPage.setRotation(degrees(currentRot + rot));
                }
                newDoc.addPage(copiedPage);
            }
        }

        const pdfBytes = await newDoc.save();
        return new Blob([pdfBytes as any], { type: 'application/pdf' });
    };

    /** Lấy bytes PDF đã áp dụng visual edits (xóa trang, xoay, sắp xếp lại) */
    const getWorkingBytes = async (): Promise<Uint8Array> => {
        if (viewerPageOrder) {
            const bakedBlob = await applyAcrobatEdits();
            if (bakedBlob) return new Uint8Array(await bakedBlob.arrayBuffer());
        }
        return new Uint8Array(await file!.arrayBuffer());
    };

    /**
     * Trả về File template để các tác vụ tiếp theo (VDP, đánh số...) xử lý.
     * Nếu người dùng đã sửa trang trong viewer (xóa/xoay/sắp xếp) thì "nướng"
     * các thay đổi đó vào file mới — tuân thủ quy tắc: tác vụ sau chỉ dùng KẾT QUẢ
     * đã chỉnh, không dùng file gốc. Nếu không có sửa đổi, giữ nguyên file gốc
     * (bảo toàn .path để backend nạp nhanh qua native path).
     */
    const getWorkingFile = async (): Promise<File> => {
        const hasOrderEdits = !!(viewerPageOrder && viewerPageOrder.length > 0);
        const hasRotEdits = !!(viewerPageRotations && Object.keys(viewerPageRotations).length > 0);
        if ((hasOrderEdits || hasRotEdits) && file) {
            const baked = await applyAcrobatEdits();
            if (baked) return new File([baked], file.name, { type: 'application/pdf' });
        }
        return file!;
    };

    const handleSaveFile = useCallback(async (isSaveAs: boolean = false) => {
        let targetBlob: Blob | null = file;
        let targetName = file ? file.name : 'Document.pdf';
        let didBake = false;  // có bake edits/VDP vào blob mới hay không

        if (!targetBlob) return;

        // File kết quả đã sinh sẵn (VDP/batch...) đã bake đủ — KHÔNG áp lại edits/VDP còn
        // sót trong store (tránh bị thêm tiền tố "Edited_"/"VDP_" sai khi chạy nhiều file).
        const isGeneratedResult = !!(file as any)?.isGenerated;
        // path chỉ là file tạm backend (<uuid>.pdf) do polyfill gán để render → KHÔNG
        // được coi là đích lưu thật. Bắt buộc hỏi vị trí lưu (tránh ghi đè temp + đổi
        // tên tab thành chuỗi uuid). Phòng thủ 2 lớp: cờ isTempUploadPath HOẶC path nằm
        // trong thư mục phù du của backend (uploads/results/temp | <uuid>.pdf).
        const isTempUploadPath = !!(file as any)?.isTempUploadPath
            || isEphemeralBackendPath((file as any)?.path);

        // Chỉ bake khi có sửa đổi THẬT SỰ (xoay khác 0, hoặc thứ tự trang khác gốc /
        // có xoá/chèn). Nếu chỉ "lưu lại" không sửa gì → bỏ qua bake (lưu tức thì).
        const _hasRot = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => ((((r as number) % 360) + 360) % 360) !== 0));
        const _isIdentityOrder = !!viewerPageOrder && !!viewerNumPages
            && viewerPageOrder.length === viewerNumPages
            && viewerPageOrder.every((p: number, i: number) => p === i + 1);
        const _hasReorder = !!viewerPageOrder && !_isIdentityOrder;

        // Nếu có visual edits (xoay/sắp trang) → bake vào blob để lưu.
        // KHÔNG commitWorkingFile (tránh đổi tên "Edited_" + race set isSaved=false).
        if (!isGeneratedResult && (_hasRot || _hasReorder)) {
            setIsProcessing(true);
            setProcessStatus('Đang áp dụng thay đổi và lưu...');
            try {
                const editedBlob = await applyAcrobatEdits();
                if (editedBlob) {
                    targetBlob = editedBlob;
                    didBake = true;
                }
            } catch (err: any) {
                setError('Lỗi khi áp dụng sửa đổi: ' + err.message);
                return;
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
                if (!isSaveAs && (file as any).path && !isGeneratedResult && !isTempUploadPath) {
                    path = (file as any).path; // Overwrite original
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
                    if (path === (file as any).path && !didBake) {
                        const fileName = path.split(/[\\/]/).pop() || targetName;
                        setIsSaved(true);
                        onTitleChange?.(fileName);
                        return;
                    }
                    // Bytes THẬT để ghi: nếu KHÔNG bake và file có path trên đĩa (kết quả VDP
                    // có blob in-memory chỉ là placeholder 5 byte, hoặc file mở từ OS có body
                    // rỗng) → đọc bytes thật từ đĩa qua lệnh Rust (không vướng fs scope).
                    // Ngược lại dùng blob đã bake (edits/VDP nhúng).
                    let writeData: Uint8Array;
                    if (!didBake && (file as any).path) {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const resp: any = await invoke('read_system_file', { path: (file as any).path });
                        writeData = resp instanceof Uint8Array ? resp : new Uint8Array(resp);
                    } else {
                        writeData = new Uint8Array(await targetBlob.arrayBuffer());
                    }
                    try {
                        await atomicWrite(path, writeData);
                        const fileName = path.split(/[\\/]/).pop() || targetName;
                        if (didBake) {
                            _bakeInMemory(targetBlob, fileName, path);
                        } else if (isTempUploadPath) {
                            // File tách/sinh trong bộ nhớ vừa được lưu ra vị trí THẬT:
                            // trỏ `file` sang path mới + bỏ cờ tạm để Ctrl+S sau ghi đè
                            // đúng file người dùng (không hỏi lại, không dùng path uuid).
                            const rebased = new File([targetBlob as any], fileName, { type: 'application/pdf' });
                            try { Object.defineProperty(rebased, 'path', { value: path }); } catch { /* ignore */ }
                            setFile(rebased);
                            setOriginalFileName(fileName);
                        }
                        setIsSaved(true);
                        onTitleChange?.(fileName);
                    } catch (writeErr: any) {
                        if (writeErr.toString().includes('forbidden path') || writeErr.toString().includes('not allowed')) {
                            const fallbackPath = await save({
                                filters: [{ name: 'PDF', extensions: ['pdf'] }],
                                defaultPath: targetName,
                                title: 'Select save location (Original path restricted)'
                            });
                            if (fallbackPath) {
                                await atomicWrite(fallbackPath, writeData);
                                const fileName = fallbackPath.split(/[\\/]/).pop() || targetName;
                                if (didBake) _bakeInMemory(targetBlob, fileName, fallbackPath);
                                setIsSaved(true);
                                onTitleChange?.(fileName);
                            }
                        } else {
                            throw writeErr;
                        }
                    }
                }
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
            }
        } catch (e: any) {
            setError('Không thể lưu file: ' + e);
        }
    }, [file, viewerPageOrder, viewerPageRotations, vdpFields, viewerNumPages, pdfUrl, onTitleChange]);

    useEffect(() => {
        const handleTriggerSave = (e: any) => {
            if (!isActive) return;
            if (e.detail.tabId === tabId) {
                if (e.detail.saveAs) {
                    setShowSaveAsModal(true);
                } else {
                    if (isDirty || viewerDirty) {
                        handleSaveFile(false);
                    }
                }
            }
        };
        window.addEventListener('app-trigger-save', handleTriggerSave);
        return () => window.removeEventListener('app-trigger-save', handleTriggerSave);
    }, [isActive, tabId, isDirty, viewerDirty, handleSaveFile]);

    const handleExtractPages = async (indices: number[], deleteAfter: boolean) => {
        if (!file || !onSpawnTab || !viewerPageOrder || !viewerPageRotations) return;
        try {
            setIsProcessing(true);
            setProcessStatus('Đang bóc tách file PDF...');
            const arrayBuffer = await getFileArrayBuffer(file);
            const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
            const newDoc = await PDFDocument.create();

            const firstPage = srcDoc.getPages()[0];
            const defaultDim = firstPage ? { w: firstPage.getSize().width, h: firstPage.getSize().height } : { w: 595.28, h: 841.89 }; // A4 fallback

            for (const pIdx of indices) {
                if (pIdx === -1) {
                    newDoc.addPage([defaultDim.w, defaultDim.h]);
                } else {
                    const [copiedPage] = await newDoc.copyPages(srcDoc, [pIdx - 1]);
                    const rot = viewerPageRotations[pIdx];
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
            setError(e.message || 'Lỗi hệ thống khi trích xuất.');
        } finally {
            setIsProcessing(false);
            setProcessStatus('');
        }
    };


    // Derive tool info for upload phase
    const effectiveTool = initialFeature || lockedMode;
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

    //#region Render
    return (
        <div className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#1a1a1a]">
            {phase === 'upload' && (
                <div className="flex-1 flex flex-col items-center justify-center py-12 px-6">
                    <div className="text-center mb-10 animate-fade-in">
                        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">
                            {toolInfo ? `🚀 ${toolInfo.title}` : '📐 Công cụ Bình Bài & Xử lý AI'}
                        </h1>
                        <p className="text-slate-600 dark:text-zinc-400 transition-colors max-w-2xl mx-auto leading-relaxed">
                            {toolInfo ? toolInfo.longDescription : 'Hoạt động offline 100%. Hỗ trợ tính toán Xẹp Giấy (Creep), bù lề xén (Bleed) cắt dọc gáy, và vẽ tự động vạch chuẩn cực kỳ chính xác. Đi kèm công cụ Tách nền AI và Tạo viền cắt bế tự động.'}
                        </p>
                    </div>
                    <div className="max-w-xl w-full animate-slide-up">
                        <PDFUploader
                            label={toolInfo ? "Tải file lên để tiếp tục" : "Kéo thả PDF Bản thảo (Single Pages)"}
                            sublabel={
                                toolInfo ? 
                                `Bạn đang mở công cụ: ${toolInfo.title}. Vui lòng chọn một file PDF để bắt đầu.`
                                : "Catalog, Tạp chí, Sách truyện cần lồng ghép trang in"
                            }
                            onFileSelected={handleFileSelected}
                            isUploading={false}
                            uploadedName=""
                            accentColor="#10b981"
                        />
                        <button 
                            onClick={() => setPhase('workspace')}
                            className="mt-6 w-full py-2.5 rounded-lg border-2 border-dashed border-slate-300 dark:border-zinc-700 bg-transparent text-slate-500 dark:text-zinc-400 font-medium hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-700 dark:hover:text-zinc-300 transition-all text-[13px]"
                        >
                            Bỏ qua tải file (Vào Không gian làm việc)
                        </button>
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
                            <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-slide-up" onClick={e => e.stopPropagation()}>
                                <div className="p-5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
                                    <h2 className="text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                                        <span>🛑</span> Xác nhận Bình Sách
                                    </h2>
                                </div>
                                <div className="p-6">
                                    <p className="text-slate-700 dark:text-zinc-300 mb-4 text-[15px]">
                                        File pdf gốc gồm <strong>{confirmBookletSettings.totalPages} trang</strong>.
                                        {confirmBookletSettings.totalPages > 0 && confirmBookletSettings.totalPages !== confirmBookletSettings.paddedPages && (confirmBookletSettings.settings as any).bindingMode !== 'flush_mount' && (
                                            <span className="text-emerald-600 dark:text-emerald-400 font-medium ml-1">
                                                (Cần thêm {confirmBookletSettings.paddedPages - confirmBookletSettings.totalPages} trang trắng để làm tròn thành {confirmBookletSettings.paddedPages} trang chẵn theo quy tắc gấp tay sách).
                                            </span>
                                        )}
                                    </p>
                                    {confirmBookletSettings.totalPages > 0 && confirmBookletSettings.totalPages !== confirmBookletSettings.paddedPages && (confirmBookletSettings.settings as any).bindingMode !== 'flush_mount' && (
                                        <div className="mb-5">
                                            <label className="text-[12px] text-slate-500 font-medium block mb-2">
                                                Đặt {confirmBookletSettings.paddedPages - confirmBookletSettings.totalPages} trang trắng ở đâu?
                                            </label>
                                            <div className="grid grid-cols-2 gap-2">
                                                {(([['end', 'Cuối sách', 'Dồn vào cuối / bìa sau (mặc định).'], ['center', 'Giữa sách', 'Nhét vào ruột trong cùng — bìa & trang đầu luôn có nội dung.']]) as const).map(([val, title, desc]) => (
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
                                        Bạn có chắc chắn muốn tiến hành bình trang với cấu hình này không?
                                    </p>
                                </div>
                                <div className="p-4 bg-slate-50 dark:bg-zinc-900/50 flex justify-end gap-3 border-t border-slate-200 dark:border-white/10 mt-2">
                                    <Button variant="secondary" onClick={() => setConfirmBookletSettings(null)}>Hủy bỏ</Button>
                                    <Button variant="primary" onClick={() => {
                                        const finalSettings = { ...(confirmBookletSettings.settings as any), blankPlacement: confirmBlankPlacement };
                                        processEngine(finalSettings, confirmBookletSettings.spawnNewTab);
                                        setConfirmBookletSettings(null);
                                    }}>Đồng ý & Khởi chạy</Button>
                                </div>
                            </div>
                        </div>,
                        document.body
                    )}

                    {error && (
                        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-200 px-4 py-3 rounded shadow-lg z-[100] flex items-center gap-3">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            {error}
                        </div>
                    )}



                    {/* Gửi Máy Bế — modal cấp tab, mở từ nút trên toolbar khi xem output đã bình */}
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
                            <div className="absolute inset-0 bg-[#525659]/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center text-white">
                                <div className="w-16 h-16 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-6"></div>
                                <h3 className="font-bold text-2xl tracking-widest uppercase mb-3">
                                    {/(bình|kẽm|thuật toán|catalog)/i.test(processStatus) ? 'ĐANG BÌNH TRANG' : 'ĐANG XỬ LÝ FILE'}
                                </h3>
                                <p className="text-emerald-200 mt-2 text-sm tracking-normal font-medium">{processStatus}</p>
                            </div>
                        )}

                        {showOutputPreview && selectionFileId && (
                            <OutputPreviewTab
                                fileId={selectionFileId}
                                initialPageNum={1}
                                totalPages={viewerPageOrder ? viewerPageOrder.length : 1}
                                onClose={() => { setShowOutputPreview(false); setSeparationPlates([]); }}
                                onPlatesChange={setSeparationPlates}
                                onFileFixed={(blob: Blob, name: string) => {
                                    window.dispatchEvent(new CustomEvent('preflight-fixed', { detail: { blob, name } }));
                                }}
                            />
                        )}

                        {activeDashboardTool === 'bgremover' && (
                            <div className="absolute top-0 left-0 bottom-0 z-40" style={{ right: isSidebarOpen ? (sidebarWidth + (isMiniToolbarExpanded ? 220 : 48)) : (isMiniToolbarExpanded ? 220 : 48) }}>
                                <BgRemoverPreview tabId={tabId || ''} />
                            </div>
                        )}

                        {activeDashboardTool === 'upscale' && (
                            <div className="absolute top-0 left-0 bottom-0 z-40" style={{ right: isSidebarOpen ? (sidebarWidth + (isMiniToolbarExpanded ? 220 : 48)) : (isMiniToolbarExpanded ? 220 : 48) }}>
                                <UpscalePreview tabId={tabId || ''} />
                            </div>
                        )}

                        {/* Empty State Overlay — hidden when bgremover/upscale active */}
                        {!pdfUrl && activeDashboardTool !== 'bgremover' && activeDashboardTool !== 'upscale' && (
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
                                           <h2 className={`font-black text-slate-800 dark:text-white tracking-tight text-2xl md:text-3xl mb-2 md:mb-3`}>Mở File PDF</h2>
                                           <p className="text-slate-500 dark:text-zinc-400 font-medium text-[13px] md:text-[14px] leading-relaxed w-full">Click chọn hoặc kéo thả File PDF vào vùng này để bắt đầu. Bạn đang ở Không gian làm việc.</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Main workspace is always AcrobatViewer */}
                                <AcrobatViewer
                                    onViewerDirtyChange={setViewerDirty}
                                    onExtractPages={handleExtractPages}
                                    onObjectDelete={handleDeleteObjects}
                                    fetchObjectsForPage={fetchPdfObjectsForPage}
                                    onEditCommit={handleEditCommit}
                                    onVdpBoxCreate={handleVdpBoxCreate}
                                    toolbarExtra={file ? (
                                        <div className="flex items-center gap-2">
                                            <RecipeRecordControl
                                                onOpenPanel={() => setShowRecipePanel(true)}
                                                sourcePageCount={viewerNumPages}
                                            />
                                            {isImposedOutputFile(file.name) && (
                                                <button
                                                    onClick={() => setShowCutExport(true)}
                                                    className="h-8 px-3 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                                                    title="Gửi dữ liệu cắt tới máy bế"
                                                >
                                                    <Scissors className="w-4 h-4" /> Gửi Máy Bế
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
                                        <div
                                            className="absolute left-0 top-0 bottom-0 w-1.5 -ml-[3px] cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 z-50 transition-colors"
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                const initialWidth = activeDashboardTool !== 'none' 
                                                    ? (isSidebarOpen ? sidebarWidth : (isMiniToolbarExpanded ? 220 : 48))
                                                    : sidebarWidth;
                                                sidebarDragRef.current = {
                                                    startX: e.clientX,
                                                    startWidth: initialWidth,
                                                    lastWidth: initialWidth
                                                };
                                                setIsDraggingSidebar(true);
                                            }}
                                        />
                                        
                                        {/* Main Config Panel */}
                                        {isSidebarOpen && (
                                            <div className="flex-1 flex flex-col overflow-hidden border-r border-slate-200 dark:border-zinc-800">
                                                {/* Sidebar Header */}
                                                <div className="px-4 h-12 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-slate-100 dark:bg-[#1a1a1a] shrink-0 shadow-sm relative z-10">
                                                    <h2 className="text-[13px] font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5 uppercase tracking-wide">
                                                        {(activeDashboardTool === 'bgremover' || activeDashboardTool === 'upscale') ? (
                                                            <button
                                                                onClick={() => setActiveDashboardTool('none')}
                                                                className="flex items-center gap-1.5 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors"
                                                                title="Quay lại danh sách công cụ"
                                                            >
                                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                                                                QUAY LẠI
                                                            </button>
                                                        ) : (
                                                            <>
                                                                <span>🛠️</span> THÔNG SỐ
                                                                {fileSizeStr && <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono normal-case tracking-normal ml-1 border pl-1.5 pr-1.5 py-0.5 rounded-full border-black/5 dark:border-white/5">{fileSizeStr}</span>}
                                                            </>
                                                        )}
                                                    </h2>
                                                    <div className="flex items-center gap-1">
                                                        {isVdpPanel && (
                                                            <>
                                                                <button
                                                                    onClick={handleSaveVdpTemplate}
                                                                    disabled={!vdpFields || vdpFields.length === 0}
                                                                    className="w-7 h-7 flex items-center justify-center hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                                    title="Lưu mẫu bố cục field (.json)"
                                                                    aria-label="Lưu mẫu bố cục"
                                                                >
                                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                                                                </button>
                                                                <button
                                                                    onClick={handleLoadVdpTemplate}
                                                                    className="w-7 h-7 flex items-center justify-center hover:bg-indigo-100 dark:hover:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded transition-colors"
                                                                    title="Tải mẫu bố cục field (.json)"
                                                                    aria-label="Tải mẫu bố cục"
                                                                >
                                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1"/><polyline points="8 12 12 16 16 12"/><line x1="12" y1="4" x2="12" y2="16"/></svg>
                                                                </button>
                                                                <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700 mx-0.5" />
                                                            </>
                                                        )}
                                                        {(activeDashboardTool === 'booklet' || activeDashboardTool === 'nup' || activeDashboardTool === 'sticker_imposer') && (
                                                            <button
                                                                onClick={() => window.dispatchEvent(new CustomEvent('open-preset-modal'))}
                                                                className="w-7 h-7 flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-500 rounded transition-colors"
                                                                title="Tải preset sản phẩm"
                                                                aria-label="Tải preset sản phẩm"
                                                            >
                                                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                                                            </button>
                                                        )}

                                                        {(isObjectEditMode ? editHistory.canUndo : history.length > 0) && activeDashboardTool !== 'bgremover' && activeDashboardTool !== 'upscale' && (
                                                            <button
                                                                onClick={() => { if (isObjectEditMode) editHistory.undo(); else handleUndo(); }}
                                                                className="w-7 h-7 flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-500 rounded transition-colors"
                                                                title="Hoàn tác thao tác trước (Ctrl+Z)"
                                                                aria-label="Hoàn tác thao tác trước"
                                                            >
                                                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                                            </button>
                                                        )}


                                                        <div className="w-px h-4 bg-slate-300 dark:bg-zinc-700 mx-0.5" />

                                                        <button
                                                            onClick={() => setIsSidebarOpen(false)}
                                                            className="w-7 h-7 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200 rounded transition-colors"
                                                            title="Thu gọn Menu"
                                                            aria-label="Thu gọn Menu"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                </div>

                                                <div className="p-4 overflow-y-auto flex-1 flex flex-col text-sm text-slate-800 dark:text-zinc-200 scroller-thin relative bg-[#f8fafc] dark:bg-zinc-900 border-t border-black/5 dark:border-white/5">
                                                    {rightPanelKind === 'edit' ? (
                                                        <EditLayersPanel
                                                            // Unified OCG + Components panel for Edit PDF upgrade
                                                            handleDeleteObjects={handleDeleteObjects}
                                                            fetchPdfObjectsForPage={fetchPdfObjectsForPage}
                                                            editObjects={currentEditObjects || []}
                                                            isEditMode={isObjectEditMode}
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
                                                            onApplyResult={(blob: Blob, name: string, path?: string) => {
                                                                recipeRecorder.noteNonRecordable('datamerge');
                                                                commitWorkingFile(blob, name, path);
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                                setActiveDashboardTool('none');
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
                                                            onApplyResult={(blob: Blob, name: string, path?: string) => {
                                                                recipeRecorder.noteNonRecordable('numbering');
                                                                commitWorkingFile(blob, name, path);
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                                setActiveDashboardTool('none');
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
                                                            onApplyResult={(blob: Blob, name: string, path?: string) => {
                                                                recipeRecorder.noteNonRecordable('cover_numbering');
                                                                commitWorkingFile(blob, name, path);
                                                                setVdpFields([]);
                                                                setSelectedVdpFieldIds([]);
                                                                setActiveDashboardTool('none');
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
                                                            getWorkingFile={getWorkingFile}
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
                                                    title={isMiniToolbarExpanded ? "Thu gọn menu" : "Mở rộng menu"}
                                                    aria-label={isMiniToolbarExpanded ? "Thu gọn menu" : "Mở rộng menu"}
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
                                                            title="Mở Bảng Cấu Hình"
                                                            aria-label="Mở Bảng Cấu Hình"
                                                        >
                                                            <span className="text-slate-500 dark:text-zinc-400"><Settings className="w-4 h-4" /></span>
                                                            {showMiniLabels && <span className="ml-2 text-[13px] font-bold text-slate-700 dark:text-zinc-300">Công cụ</span>}
                                                        </button>
                                                    </div>
                                                    
                                                    <div className="flex flex-col items-center py-2 gap-0 w-full px-1.5">
                                                        {(() => {
                                                            const allDashboardTools = TOOL_CATEGORIES.filter(cat => cat.id !== 'qc').flatMap(cat => getToolsByCategory(cat.id));
                                                            const favTools = allDashboardTools.filter(t => {
                                                                if (t.id === 'combine_pdf') return false;
                                                                const featureId = t.defaultPayload?.focusFeature || t.defaultPayload?.lockedMode || t.id;
                                                                return favoriteTools.includes(featureId) && !hiddenTools.includes(featureId);
                                                            });
                                                            
                                                            if (favTools.length === 0) return null;
                                                            
                                                            return (
                                                                <div key="favorites" className="w-full flex flex-col items-center mb-1">
                                                                    {showMiniLabels ? (
                                                                        <div className="w-full px-2 mt-2 mb-1.5 flex items-center gap-2">
                                                                            <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest flex items-center gap-1"><Star className="w-2.5 h-2.5" fill="currentColor" /> Yêu Thích</span>
                                                                            <div className="flex-1 h-px bg-amber-500 opacity-40" />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="w-6 h-[2px] bg-amber-500 opacity-40 my-2 rounded-full" title="Yêu Thích" />
                                                                    )}
                                                                    <div className="flex flex-col items-center gap-1.5 w-full">
                                                                        {favTools.map(tool => {
                                                                            const featureId = tool.defaultPayload?.focusFeature || tool.defaultPayload?.lockedMode || tool.id;
                                                                            const isActive = activeDashboardTool === featureId;
                                                                            return (
                                                                                <button
                                                                                    key={`fav-${featureId}`}
                                                                                    onClick={() => {
                                                                                        if (isActive && isSidebarOpen) {
                                                                                            setIsSidebarOpen(false);
                                                                                        } else {
                                                                                            setActiveDashboardTool(featureId);
                                                                                            if (tool.defaultPayload?.lockedMode) {
                                                                                                imposerStoreRef.current!.getState().setTaskMode(tool.defaultPayload.lockedMode);
                                                                                            }
                                                                                            if (sidebarWidth < 280) setSidebarWidth(390);
                                                                                            setIsSidebarOpen(true);
                                                                                        }
                                                                                    }}
                                                                                    className={`w-full h-9 rounded-lg flex items-center transition-colors shrink-0 outline-none
                                                                                        ${showMiniLabels ? 'justify-start px-2' : 'justify-center'}
                                                                                        ${isActive ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 shadow-sm border border-amber-300 dark:border-amber-700/50' : 'bg-amber-50/50 dark:bg-amber-900/20 text-slate-700 dark:text-zinc-300 border border-amber-200/50 dark:border-amber-700/30 hover:bg-amber-100/80 dark:hover:bg-amber-900/40 hover:text-amber-900 dark:hover:text-amber-100'}`
                                                                                    }
                                                                                    title={tool.title}
                                                                                >
                                                                                    <span className="text-lg shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
                                                                                    {showMiniLabels && <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tool.title}</span>}
                                                                                </button>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })()}
                                                        {TOOL_CATEGORIES.filter(cat => cat.id !== 'qc').map(cat => {
                                                            const catTools = getToolsByCategory(cat.id).filter(t => {
                                                                if (t.id === 'combine_pdf') return false;
                                                                const featureId = t.defaultPayload?.focusFeature || t.defaultPayload?.lockedMode || t.id;
                                                                if (hiddenTools.includes(featureId)) return false;
                                                                if (favoriteTools.includes(featureId)) return false;
                                                                return true;
                                                            });
                                                            if (catTools.length === 0) return null;
                                                            return (
                                                                <div key={cat.id} className="w-full flex flex-col items-center mb-1">
                                                                    {showMiniLabels ? (
                                                                        <div className="w-full px-2 mt-2 mb-1.5 flex items-center gap-2">
                                                                            <span className="text-[10px] font-bold text-indigo-800 dark:text-indigo-400 uppercase tracking-widest">{cat.title}</span>
                                                                            <div className="flex-1 h-px bg-indigo-800 dark:bg-indigo-400 opacity-40" />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="w-6 h-[2px] bg-indigo-800 dark:bg-indigo-400 opacity-40 my-2 rounded-full" title={cat.title} />
                                                                    )}
                                                                    <div className="flex flex-col items-center gap-1.5 w-full">
                                                                        {catTools.map(tool => {
                                                                            const featureId = tool.defaultPayload?.focusFeature || tool.defaultPayload?.lockedMode || tool.id;
                                                                            const isActive = activeDashboardTool === featureId;
                                                                            return (
                                                                                <button
                                                                                    key={featureId}
                                                                                    onClick={() => {
                                                                                        if (isActive && isSidebarOpen) {
                                                                                            setIsSidebarOpen(false);
                                                                                        } else {
                                                                                            setActiveDashboardTool(featureId);
                                                                                            if (tool.defaultPayload?.lockedMode) {
                                                                                                imposerStoreRef.current!.getState().setTaskMode(tool.defaultPayload.lockedMode);
                                                                                            }
                                                                                            if (sidebarWidth < 280) setSidebarWidth(390);
                                                                                            setIsSidebarOpen(true);
                                                                                        }
                                                                                    }}
                                                                                    className={`w-full h-9 rounded-lg flex items-center transition-colors shrink-0 outline-none
                                                                                        ${showMiniLabels ? 'justify-start px-2' : 'justify-center'}
                                                                                        ${isActive ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 shadow-sm border border-indigo-300 dark:border-indigo-700/50' : 'hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-transparent'}`
                                                                                    }
                                                                                    title={tool.title}
                                                                                >
                                                                                    <span className="text-lg shrink-0 flex items-center justify-center w-6">{tool.icon}</span>
                                                                                    {showMiniLabels && <span className="ml-2.5 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{tool.title}</span>}
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
                separateCut={!!imposerStoreRef.current?.getState()?.separateCutPage}
                cncMode={activeDashboardTool === 'cnc_imposer'}
                cncTwoSided={imposerStoreRef.current?.getState()?.duplexFlow === 'double'}
                originalName={file?.name}
            />

            {/* Custom Scale Confirm Modal */}
            {scaleConfirmModal && createPortal(
                <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => { scaleConfirmModal.resolve(false); setScaleConfirmModal(null); }} onKeyDown={e => { if (e.key === 'Escape') { scaleConfirmModal.resolve(false); setScaleConfirmModal(null); } }} tabIndex={-1} ref={el => el?.focus()}>
                    <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-200 dark:border-zinc-700" onClick={e => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-700 flex justify-between items-center bg-amber-50 dark:bg-amber-500/10">
                            <h3 className="text-lg font-bold text-amber-600 dark:text-amber-500 flex items-center gap-2">
                                <span className="material-symbols-outlined">warning</span>
                                Cảnh báo kích thước
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
                                Hủy bỏ (Cancel)
                            </button>
                            <button
                                onClick={() => {
                                    scaleConfirmModal.resolve(true);
                                    setScaleConfirmModal(null);
                                }}
                                className="px-4 py-2 rounded-lg font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                            >
                                Tiếp tục (Thu nhỏ)
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Custom Close Confirm Modal */}
            {showCloseConfirm && createPortal(
                <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 font-sans" onClick={() => setShowCloseConfirm(false)} onKeyDown={e => { if (e.key === 'Escape') setShowCloseConfirm(false); }} tabIndex={-1} ref={el => el?.focus()}>
                    <div className="bg-white dark:bg-[#1e1e1e] w-[380px] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10" onClick={e => e.stopPropagation()}>
                        <div className="p-6">
                            <h3 className="text-[16px] font-semibold text-slate-800 dark:text-white mb-2">
                                Đóng file chưa lưu?
                            </h3>
                            <p className="text-[14px] text-slate-600 dark:text-zinc-300 leading-relaxed">
                                File này đã bị thay đổi nhưng chưa được lưu. Bạn có chắc chắn muốn đóng và mất các thay đổi không?
                            </p>
                        </div>
                        <div className="bg-slate-50 dark:bg-black/20 p-4 border-t border-slate-100 dark:border-white/5 flex justify-end gap-3">
                            <button
                                onClick={() => setShowCloseConfirm(false)}
                                className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors outline-none min-w-[90px]"
                            >
                                Hủy bỏ
                            </button>
                            <button
                                onClick={forceReset}
                                className="px-6 h-[38px] flex items-center justify-center rounded font-medium text-[13px] bg-red-600 hover:bg-red-700 text-white shadow-sm min-w-[120px] transition-colors outline-none"
                            >
                                Đóng không lưu
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
    //#endregion
}
