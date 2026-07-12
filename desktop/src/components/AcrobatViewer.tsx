import { useState, useRef, useEffect, useCallback, useMemo, forwardRef } from 'react';
import { pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { Virtuoso } from 'react-virtuoso';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';
import { useImposerSettingsStore } from './imposition-tools/useImposerSettingsStore';
import { useAppSettingsStore } from '../stores/appSettingsStore';

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LivePageFrame, clearTileUrlCache } from './workspace/LivePageFrame';
import CropDialog from './workspace/CropDialog';
import ExportImageModal from './workspace/ExportImageModal';
import { uploadPDF, getApiUrl } from '../lib/api';
import { toast } from './ui/Toast';
import { QuickDeleteModal, ExtractPagesModal, InsertBlankPageModal, AcrobatToolbar, Ruler, GuideLayer, ThumbSidebar, ViewerContextMenu, type Guide } from './acrobat';

import { usePdfLoader, genPageId, genPageIds, flattenRotations } from '../hooks/viewer/usePdfLoader';
import { useTileRenderer } from '../hooks/viewer/useTileRenderer';
import { useViewerHotkeys } from '../hooks/viewer/useViewerHotkeys';
import { useObjectEditHistory } from '../hooks/useObjectEditHistory';
import { useViewerZoom } from '../hooks/viewer/useViewerZoom';
import { useVdpHistory } from '../hooks/useVdpHistory';
import type { UseEditSession } from '../hooks/useEditSession';
import { useTranslation } from 'react-i18next';

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
    onViewerDirtyChange?: (isDirty: boolean) => void;
    onExtractPages?: (indices: number[], deleteAfter: boolean) => void;
    onObjectDelete?: (objs: any[], pageNum: number) => void;
    fetchObjectsForPage?: (pageNum: number) => void;
    onEditCommit?: (outputUrl: string, outputFilename: string, outputFid?: string, outputPath?: string) => void | Promise<void>;
    onVdpBoxCreate?: (box: { x: number; y: number; width: number; height: number; pageNum: number, type?: string }) => void;
    rightPanel?: React.ReactNode;
    toolbarExtra?: React.ReactNode;
    /** PHIÊN chỉnh sửa trong bộ nhớ (spec `pdf-edit-session`) — sở hữu bởi ImpositionTab,
        chuyển tiếp xuống LivePageFrame để Apply_In_Memory + overlay clip (task 11.1). */
    editSession?: UseEditSession;
}

export default function AcrobatViewer({ isActive, onExtractPages, onObjectDelete, fetchObjectsForPage, onEditCommit, onVdpBoxCreate, rightPanel, toolbarExtra, onViewerDirtyChange, editSession }: Props) {
  const { t } = useTranslation();
    // ═══ Global Store ═══
    const {
        file, setFile, pdfUrl, setPdfUrl, bleedView, highlightedIssue,
        selectedObjectIds, setSelectedObjectIds, hiddenObjectIds, selectionFileId,
        isObjectEditMode, isCropMode,
        hiddenOcgLayerIds,
        separationPlates, vdpFields, selectedVdpFieldIds,
        setSelectedVdpFieldIds, setVdpFields, setIsSidebarOpen,
        setViewerPageOrder, setViewerPageRotations, setViewerDirty,
        error, setError,
        setIsProcessing, setProcessStatus,
        viewerZoom: zoom, setViewerZoom: setZoom,
        viewerFitMode: fitMode, setViewerFitMode: setFitMode,
        viewerToolMode: toolMode, setViewerToolMode: setToolMode,
        viewerPageDisplayMode: pageDisplayMode, setViewerPageDisplayMode: setPageDisplayMode,
        viewerActivePage: activePage, setViewerActivePage: setActivePage,
        viewerNumPages: numPages, setViewerNumPages: setNumPages,
        viewerThumbMenuOpen: isThumbMenuOpen, setViewerThumbMenuOpen: setIsThumbMenuOpen,
        setHoveredPdfPosition,
        detectedDimensionsByPage,
        softProofImageUrl, gamutWarningUrl,
        tacHeatmapUrl, overprintPreviewUrl,
        ocgPreviewUrl,
    } = useWorkspaceStore(useShallow(state => ({
        file: state.file, setFile: state.setFile, pdfUrl: state.pdfUrl, setPdfUrl: state.setPdfUrl, bleedView: state.bleedView, highlightedIssue: state.highlightedIssue,
        selectedObjectIds: state.selectedObjectIds,
        setSelectedObjectIds: state.setSelectedObjectIds, hiddenObjectIds: state.hiddenObjectIds, selectionFileId: state.selectionFileId,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        isObjectEditMode: state.isObjectEditMode,
        isCropMode: state.isCropMode,
        separationPlates: state.separationPlates,
        vdpFields: state.vdpFields, selectedVdpFieldIds: state.selectedVdpFieldIds, setSelectedVdpFieldIds: state.setSelectedVdpFieldIds,
        softProofImageUrl: state.softProofImageUrl, gamutWarningUrl: state.gamutWarningUrl, tacHeatmapUrl: state.tacHeatmapUrl, overprintPreviewUrl: state.overprintPreviewUrl,
        ocgPreviewUrl: state.ocgPreviewUrl,
        setVdpFields: state.setVdpFields, setIsSidebarOpen: state.setIsSidebarOpen,
        setViewerPageOrder: state.setViewerPageOrder, setViewerPageRotations: state.setViewerPageRotations, setViewerDirty: state.setViewerDirty,
        error: state.error, setError: state.setError,
        setIsProcessing: state.setIsProcessing, setProcessStatus: state.setProcessStatus,
        viewerZoom: state.viewerZoom, setViewerZoom: state.setViewerZoom,
        viewerFitMode: state.viewerFitMode, setViewerFitMode: state.setViewerFitMode,
        viewerToolMode: state.viewerToolMode, setViewerToolMode: state.setViewerToolMode,
        viewerPageDisplayMode: state.viewerPageDisplayMode, setViewerPageDisplayMode: state.setViewerPageDisplayMode,
        viewerActivePage: state.viewerActivePage, setViewerActivePage: state.setViewerActivePage,
        viewerNumPages: state.viewerNumPages, setViewerNumPages: state.setViewerNumPages,
        viewerThumbMenuOpen: state.viewerThumbMenuOpen, setViewerThumbMenuOpen: state.setViewerThumbMenuOpen,
        setHoveredPdfPosition: state.setHoveredPdfPosition,
        detectedDimensionsByPage: state.detectedDimensionsByPage
    })));

    const { activeDashboardTool, setActiveDashboardTool } = useImposerSettingsStore(useShallow(s => ({
        activeDashboardTool: s.activeDashboardTool,
        setActiveDashboardTool: s.setActiveDashboardTool,
    })));

    const isVdpMode = activeDashboardTool === 'datamerge' || activeDashboardTool === 'numbering' || activeDashboardTool === 'cover_numbering' || activeDashboardTool === 'stick_text_number';
    const { showRulers, toggleRulers, measurementUnit } = useAppSettingsStore();

    const highlightBoxes = highlightedIssue ? [highlightedIssue] : undefined;

    // ── Crop PDF: lấy/đảm bảo file_id + áp kết quả crop vào viewer ──
    const setSelectionFileId = useWorkspaceStore(s => s.setSelectionFileId);
    const setIsCropMode = useWorkspaceStore(s => s.setIsCropMode);
    const setIsObjectEditMode = useWorkspaceStore(s => s.setIsObjectEditMode);

    const ensureCropFileId = useCallback(async () => {
        if (selectionFileId) return selectionFileId;
        if (!file) throw new Error(t('misc.acrobatViewer:chua_co_file_de_cat_kho'));
        const res = await uploadPDF(file);
        setSelectionFileId(res.id);
        return res.id;
    }, [selectionFileId, file, setSelectionFileId]);

    const handleCropApplied = useCallback((blob: Blob) => {
        const newFile = new File([blob], (file?.name || 'cropped.pdf'), { type: 'application/pdf' });
        setFile(newFile);
        setPdfUrl(URL.createObjectURL(newFile));
        setSelectionFileId(''); // buộc re-upload cho thao tác sau (output không có fid)
        setIsCropMode(false);
    }, [file, setFile, setPdfUrl, setSelectionFileId, setIsCropMode]);
    const onVdpBoxSelect = (fieldIds: string[]) => {}; // Handled directly in LivePageFrame now
    const onVdpFieldsChange = setVdpFields;

    // ── Export ảnh (PNG/JPEG/TIFF) — tương tự Acrobat "Export To > Image" ──
    const [isExportImageOpen, setIsExportImageOpen] = useState(false);
    const [exportFileId, setExportFileId] = useState<string | undefined>(undefined);
    const [exportFilePath, setExportFilePath] = useState<string | undefined>(undefined);
    const openExportImage = useCallback(async () => {
        if (!file) { toast.info(t('misc.acrobatViewer:chua_co_file_de_xuat_anh')); return; }
        try {
            const p = (file as any)?.path;
            if (p) { setExportFilePath(p); setExportFileId(undefined); }
            else { const fid = await ensureCropFileId(); setExportFileId(fid); setExportFilePath(undefined); }
            setIsExportImageOpen(true);
        } catch (e) {
            toast.error('Không chuẩn bị được file để xuất ảnh: ' + ((e as any)?.message || e));
        }
    }, [file, ensureCropFileId]);

    // ═══ DOM Refs ═══
    const containerRef = useRef<HTMLDivElement>(null);
    const sidebarRef = useRef<HTMLDivElement>(null);
    const mainVirtuosoRef = useRef<any>(null);
    const internalScrollRef = useRef<HTMLElement | null>(null);
    const explicitNavRef = useRef(false);

    // Undo/Redo cho thao tác trên VDP fields (di chuyển, resize, xóa, tạo...).
    useVdpHistory({ vdpFields, setVdpFields, enabled: isVdpMode, containerRef });

    // ═══ Modal State ═══
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [isInsertModalOpen, setIsInsertModalOpen] = useState(false);
    const [isExtractModalOpen, setIsExtractModalOpen] = useState(false);
    const [extractPagesStrForModal, setExtractPagesStrForModal] = useState('');
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean } | null>(null);

    // ═══ Guide State ═══
    const [guides, setGuides] = useState<Guide[]>([]);
    const [guidesHistory, setGuidesHistory] = useState<Guide[][]>([]);
    const [draggingGuide, setDraggingGuide] = useState<Guide | null>(null);
    const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);

    // ═══ Text Content ═══
    const [nativeTextBlocks, setNativeTextBlocks] = useState<Record<number, any[]>>({});
    const [isZoomReadyLocal, setIsZoomReadyLocal] = useState(false);

    // ═══ Hook: PDF Loader ═══
    const loader = usePdfLoader({
        file, pdfUrl, setNumPages, setActivePage, setZoom, containerRef,
    });
    const {
        pdfRef, thumbPdfRef, pageDim, allPageDims, pageWidthPt, plateLabels,
        pageOrder, setPageOrder, pageInstanceIds, setPageInstanceIds,
        selectedIndices, setSelectedIndices, lastSelectedIndex, setLastSelectedIndex,
        pageRotations, setPageRotations, pastStack, setPastStack, futureStack, setFutureStack,
        updatePageDimForPage, generateThumb, loadError
    } = loader;

    // Helper: mọi thao tác đổi thứ tự trang PHẢI cập nhật pageOrder VÀ pageInstanceIds
    // cùng lúc (bất biến: 2 mảng luôn cùng độ dài). Rotation keyed theo instance-id nên
    // nếu 2 mảng lệch → gán góc nhầm trang. Gói qua đây để không quên đồng bộ ở handler nào.
    const applyOrderChange = useCallback((newOrder: number[], newIds: string[]) => {
        if (newOrder.length !== newIds.length) {
            console.error('[applyOrderChange] order/ids length mismatch', newOrder.length, newIds.length);
        }
        setPageOrder(newOrder);
        setPageInstanceIds(newIds);
    }, [setPageOrder, setPageInstanceIds]);

    // LƯU Ý: KHÔNG return sớm ở đây. Trước kia `if (loadError) return ...` đặt
    // TRƯỚC hàng loạt hook bên dưới (useTileRenderer, useViewerZoom, useEffect...),
    // nên khi loadError chuyển từ null→set giữa các lần render, số hook gọi bị lệch
    // → React error #300 ("rendered fewer hooks than expected") làm crash toàn app.
    // Việc kiểm tra loadError được dời xuống SAU TẤT CẢ hook (ngay trước RENDER).

    // ═══ Hook: Tile Renderer ═══
    const { getTileUrl, getTextBlocksForPage } = useTileRenderer({
        file, pdfRef, pdfUrl, zoom, activePage,
    });

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
    useEffect(() => {
        const es = editSessionRef.current;
        if (!es || !isObjectEditMode || !selectionFileId) return;
        void es.openSession(selectionFileId);
        return () => {
            // Thoát/đổi fid: commit gộp nếu có thay đổi (onCommit swap pdfUrl), rồi đóng.
            void (async () => {
                try { if (es.dirty) await es.commit(); } catch { /* giữ phiên nếu commit lỗi */ }
                await es.closeSession();
            })();
        };
    }, [isObjectEditMode, selectionFileId]);

    // ═══ Derived Values ═══
    const actualWidth100 = pageWidthPt * (96 / 72);

    // Lưu kích thước trang vào store để công cụ VDP căn chỉnh theo trang.
    // QUAN TRỌNG: field.x/y/width/height ở đơn vị "CSS-mm" (mm thật × 96/72), KHÔNG phải mm thật.
    // Dùng pageDim.w (px@96) × 25.4 / 72 để ra cùng đơn vị field → căn theo trang mới khớp.
    const setViewerPageDimMm = useWorkspaceStore(s => s.setViewerPageDimMm);
    useEffect(() => {
        if (pageDim && pageDim.w && pageDim.h) {
            setViewerPageDimMm({ w: pageDim.w * 25.4 / 72, h: pageDim.h * 25.4 / 72 });
        } else {
            setViewerPageDimMm(null);
        }
    }, [pageDim, setViewerPageDimMm]);

    // ═══ Quét chữ (chế độ XEM THƯỜNG) ═══
    // Nạp text CÓ TOẠ ĐỘ cho trang đang xem → dựng lớp <span> trong suốt (select-text)
    // đè lên ảnh trang để bôi đen + copy như Acrobat. CHỈ ở chế độ xem thường: KHÔNG
    // edit-object (chuột dùng chọn object), KHÔNG VDP, KHÔNG crop (chuột quét vùng).
    // File native (mở từ đĩa) → backend /pdf-text (point, top-left, sạch); non-native
    // → getTextBlocksForPage (pdf.js) sẵn có. Chỉ fetch 1 lần/trang (cache theo page).
    const canScanText = !isObjectEditMode && !isVdpMode && !isCropMode;
    useEffect(() => {
        if (!canScanText || !file || !activePage) return;
        if (nativeTextBlocks[activePage]) return; // đã có → khỏi fetch lại
        let cancelled = false;
        const nativePath = (file as any)?.path;
        (async () => {
            try {
                if (nativePath) {
                    const res = await fetch(`${getApiUrl()}/imposition/pdf-text`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: nativePath, page: activePage }),
                    });
                    if (!res.ok || cancelled) return;
                    const data = await res.json();
                    if (cancelled) return;
                    setNativeTextBlocks(prev => ({ ...prev, [activePage]: data.blocks || [] }));
                } else {
                    const blocks = await getTextBlocksForPage(activePage, nativeTextBlocks);
                    if (blocks && !cancelled) {
                        setNativeTextBlocks(prev => ({ ...prev, [activePage]: blocks }));
                    }
                }
            } catch { /* text không quét được (file scan/outline) → bỏ qua, không phải lỗi */ }
        })();
        return () => { cancelled = true; };
    }, [canScanText, file, activePage, nativeTextBlocks, getTextBlocksForPage]);

    // ═══ Page Navigation ═══
    const navigatePage = useCallback((newPage: number) => {
        if (numPages === 0) return;
        explicitNavRef.current = true;
        const index = Math.max(0, Math.min(numPages - 1, newPage - 1));
        setSelectedIndices(new Set([index]));
        setLastSelectedIndex(index);
        setActivePage(index + 1);
        if (mainVirtuosoRef.current) {
            mainVirtuosoRef.current.scrollToIndex({ index, behavior: 'auto', align: 'start' });
        } else if (internalScrollRef.current) {
            internalScrollRef.current.scrollTop = 0;
            internalScrollRef.current.scrollLeft = 0;
        }
    }, [numPages, setSelectedIndices, setLastSelectedIndex, setActivePage]);

    const prevAcroPage = () => {
        if (activePage > 1) {
            explicitNavRef.current = true;
            setActivePage(activePage - 1);
        }
    };
    const nextAcroPage = () => {
        if (activePage < pageOrder.length) {
            explicitNavRef.current = true;
            setActivePage(activePage + 1);
        }
    };

    // ═══ Hook: Object Edit Undo/Redo (Ctrl+Z hoàn tác move/delete/rotate...) ═══
    const objectEdit = useObjectEditHistory();

    // ═══ Hook: Viewer Hotkeys ═══
    const { commitSnapshot, undo, redo } = useViewerHotkeys({
        containerRef, sidebarRef,
        pageOrder, selectedIndices, lastSelectedIndex, pageRotations, activePage, numPages,
        setPageOrder, setSelectedIndices, setLastSelectedIndex, setPageRotations, setActivePage,
        pastStack, futureStack, setPastStack, setFutureStack,
        toolMode, setToolMode, isVdpMode, isThumbMenuOpen, isDeleteModalOpen,
        setIsDeleteModalOpen, setIsExtractModalOpen, setIsInsertModalOpen, setExtractPagesStrForModal, setContextMenu,
        setIsSidebarOpen,
        guides, setGuides, guidesHistory, setGuidesHistory, selectedGuideId, setSelectedGuideId, toggleRulers,
        navigatePage,
        mainVirtuosoRef, internalScrollRef,
        // Ctrl+Z/Y trong chế độ chỉnh sửa đối tượng → undo/redo qua EDIT-SESSION
        // (in-memory, per-op, render vùng clip → overlay tại chỗ, KHÔNG reload). Session
        // sở hữu op_log nên undo/redo chính xác từng op. `scale` = px thiết bị/point
        // (css px/point × dpr) để ảnh clip khôi phục đủ nét. editHistory cũ (snapshot
        // pdfUrl) KHÔNG còn dùng cho edit-object — session là đường DUY NHẤT.
        isObjectEditMode,
        onEditUndo: () => {
            if (!editSession) return;
            const cssScale = pageDim?.w ? (actualWidth100 * zoom) / (pageDim.w * 72 / 96) : 2;
            const dpr = window.devicePixelRatio || 1;
            void editSession.undo(Math.max(0.5, cssScale * dpr));
        },
        onEditRedo: () => {
            if (!editSession) return;
            const cssScale = pageDim?.w ? (actualWidth100 * zoom) / (pageDim.w * 72 / 96) : 2;
            const dpr = window.devicePixelRatio || 1;
            void editSession.redo(Math.max(0.5, cssScale * dpr));
        },
    });

    // ═══ Hook: Zoom & Gestures ═══
    const {
        mainWidth, mainHeight, isZoomReady,
        thumbBaseWidth, setThumbBaseWidth,
        isZoomingRef,
        applyFitWidth, applyFitPage,
        handleDragStart,
        updateViewportRect,
    } = useViewerZoom({
        containerRef, sidebarRef, internalScrollRef,
        numPages, zoom, setZoom, fitMode, setFitMode: setFitMode as (m: string) => void,
        pageDim, pageDisplayMode, setPageDisplayMode: setPageDisplayMode as (m: string) => void, activePage, actualWidth100,
        navigatePage, toolMode,
    });

    // ═══ Sync Effects ═══
    useEffect(() => { setViewerPageOrder?.(pageOrder); setNumPages(pageOrder.length); }, [pageOrder]);
    useEffect(() => { if (pageOrder.length > 0 && activePage > pageOrder.length) setActivePage(pageOrder.length); }, [pageOrder.length, activePage]);
    // Đẩy rotation ra store dạng number[] THEO VỊ TRÍ (out[i] = góc trang ở vị trí i).
    // Trong viewer rotation keyed theo instance-id (xoay độc lập bản nhân bản), nhưng ra
    // store/backend chỉ cần góc-theo-vị-trí (thứ tự mảng đã cố định). Backend impose + bake
    // đều lặp theo vị trí nên nhận trực tiếp. Xem flattenRotations (per-instance rotation).
    useEffect(() => { setViewerPageRotations?.(flattenRotations(pageInstanceIds, pageRotations)); }, [pageRotations, pageInstanceIds]);
    useEffect(() => { setViewerDirty(pastStack.length > 0); }, [pastStack.length, setViewerDirty]);
    useEffect(() => { if (isObjectEditMode || isVdpMode) setToolMode('pointer'); }, [isObjectEditMode, isVdpMode]);
    useEffect(() => { updatePageDimForPage(activePage, numPages); }, [pdfRef, activePage, numPages, updatePageDimForPage]);

    // Reset zoom state on new file
    useEffect(() => {
        // Edit-commit: giữ nguyên zoom/scroll (cùng cấu trúc trang) → không reset.
        if ((file as any)?.__editCommit) return;
        setIsZoomReadyLocal(false);
        if (internalScrollRef.current) internalScrollRef.current = null;
    }, [pdfUrl, file]);

    // ── Menu bar (kiểu Acrobat) → lệnh thao tác trên viewer. Mọi tab đều mounted nên
    //    CHỈ tab active mới xử lý (tránh mọi tab cùng phản ứng). App-level (New/Open/Save…)
    //    xử lý ở AppInner; ở đây chỉ nhận lệnh liên quan trực tiếp tới viewer trang hiện tại.
    useEffect(() => {
        if (!isActive) return;
        const handleMenuCommand = (e: Event) => {
            const cmd = (e as CustomEvent).detail?.cmd as string;
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
                case 'toggle-rulers': toggleRulers(); break;
                case 'toggle-object-edit': setIsObjectEditMode(v => !v); break;
                case 'crop': setIsCropMode(true); setIsObjectEditMode(false); setToolMode('pointer'); break;
                case 'delete-pages': setIsDeleteModalOpen(true); break;
                case 'undo': undo(); break;
                case 'redo': redo(); break;
            }
        };
        window.addEventListener('prynx-menu-command', handleMenuCommand);
        return () => window.removeEventListener('prynx-menu-command', handleMenuCommand);
    }, [isActive, setZoom, setFitMode, applyFitWidth, applyFitPage, setPageDisplayMode, navigatePage, pageOrder.length, activePage, toggleRulers, setIsObjectEditMode, setIsCropMode, setToolMode, undo, redo]);

    // Jump to highlighted issue or specific page
    useEffect(() => {
        if (!internalScrollRef.current) return;
        if (!explicitNavRef.current) return;
        explicitNavRef.current = false;
        
        if (internalScrollRef.current.dataset.isNavigating === 'true') return;
        // Scope query trong instance này (ID pdf-page-container-N bị trùng giữa các tab mounted).
        const pageEl = internalScrollRef.current.querySelector(`#pdf-page-container-${activePage}`) as HTMLElement | null;
        if (pageEl) {
            internalScrollRef.current.dataset.isNavigating = 'true';
            
            // Avoid scrollIntoView as it forcibly scrolls overflow-hidden ancestors causing layout shifts
            const parent = internalScrollRef.current;
            const parentRect = parent.getBoundingClientRect();
            const childRect = pageEl.getBoundingClientRect();
            parent.scrollTop += (childRect.top - parentRect.top);
            
            setTimeout(() => {
                if (internalScrollRef.current) delete internalScrollRef.current.dataset.isNavigating;
            }, 100);
        }
    }, [activePage]);

    useEffect(() => {
        if (highlightBoxes && highlightBoxes.length > 0) {
            const targetPage = highlightBoxes[0].page;
            if (targetPage && pageOrder.length > 0) {
                const index = pageOrder.findIndex(p => p === targetPage);
                if (index !== -1) {
                    setTimeout(() => {
                        mainVirtuosoRef.current?.scrollToIndex({ index, behavior: 'auto', align: 'center' });
                        setActivePage(index + 1);
                        setSelectedIndices(new Set([index]));
                        setLastSelectedIndex(index);
                    }, 100);
                }
            }
        }
    }, [highlightBoxes, pageOrder]);

    // Thumbnail pre-generation
    useEffect(() => {
        if (!thumbPdfRef && !(file as any)?.path) return;
        if (numPages === 0 || !isThumbMenuOpen) return;
        let cancelled = false;
        const maxThumbsToGen = Math.min(numPages, 30);
        const genSequential = async () => {
            for (let i = 0; i < maxThumbsToGen; i++) {
                if (cancelled) return;
                const pageNum = i + 1;
                // Warmup cache base CHƯA xoay (rot=0): rotation giờ theo instance-id, không
                // map vào bare pageNum. Thumbnail áp góc xoay qua CSS ở ThumbSidebar.
                await generateThumb(thumbPdfRef, pageNum, 0, 400);
                await new Promise(r => setTimeout(r, 10));
            }
        };
        genSequential();
        return () => { cancelled = true; };
    }, [thumbPdfRef, file, numPages, pageRotations, generateThumb, isThumbMenuOpen]);

    // PageTools event listener
    useEffect(() => {
        const handlePageToolsAction = (e: any) => {
            const { action, payload } = e.detail;
            if (action === 'duplicate') handlePageToolsDuplicate(payload.targetType, payload.range, payload.copies, payload.collate);
            else if (action === 'move') handlePageToolsMove(payload.startPage, payload.endPage, payload.targetType, payload.targetPage);
            else if (action === 'delete') handlePageToolsDelete(payload.targetType, payload.range, payload.filter);
            else if (action === 'rotate') handlePageToolsRotate(payload.targetType, payload.range, payload.filter, payload.degrees);
            else if (action === 'insert_blank') handlePageToolsInsertBlank(payload.location, payload.target, payload.targetPage, payload.count);
            else if (action === 'extract') handlePageToolsExtract(payload.range, payload.deleteAfter);
        };
        window.addEventListener('prynx-pagetools-action', handlePageToolsAction);
        return () => window.removeEventListener('prynx-pagetools-action', handlePageToolsAction);
    }, [pageOrder, selectedIndices, activePage]);

    // ═══ Page Tool Handlers ═══
    const handleQuickDeleteConfirm = () => {
        commitSnapshot();
        const keep = (_: any, idx: number) => !selectedIndices.has(idx);
        const newOrder = pageOrder.filter(keep);
        const newIds = pageInstanceIds.filter(keep);
        applyOrderChange(newOrder, newIds);
        setSelectedIndices(new Set(newOrder.length > 0 ? [0] : []));
        setLastSelectedIndex(newOrder.length > 0 ? 0 : null);
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
        let deleteIndices = new Set<number>();
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
        const keep = (_: any, idx: number) => !deleteIndices.has(idx);
        const afterDelete = pageOrder.filter(keep);
        applyOrderChange(afterDelete, pageInstanceIds.filter(keep));
        // Clamp: khi xóa HẾT trang, index 0 không tồn tại → selection rỗng + anchor null
        // (nếu để [0]/0 thì shift-click sau tính range từ anchor không hợp lệ).
        setSelectedIndices(new Set(afterDelete.length > 0 ? [0] : []));
        setLastSelectedIndex(afterDelete.length > 0 ? 0 : null);
    };

    const handlePageToolsRotate = (target: string, range: [number, number], filter: string, degrees: number) => {
        commitSnapshot();
        let rotateIndices = new Set<number>();
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

    const handleExtractPages = (extractPagesStr: string, extractDeleteAfter: boolean) => {
        commitSnapshot();
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
            onExtractPages(sorted.map(idx => pageOrder[idx]), extractDeleteAfter);
            if (extractDeleteAfter) {
                const keep = (_: any, idx: number) => !indicesToExtract.has(idx);
                applyOrderChange(pageOrder.filter(keep), pageInstanceIds.filter(keep));
                setSelectedIndices(new Set());
                setLastSelectedIndex(null);
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
        handleExtractPages(`${start}-${end}`, deleteAfter);
    };

    const handleCrossFileDrop = async (sourcePdfUrl: string, sourcePageNums: number[], insertDropIndex: number) => {
        if (!pdfUrl) return;
        try {
            commitSnapshot();
            setIsProcessing(true);
            setProcessStatus(t('misc.acrobatViewer:dang_sao_chep_trang'));

            const { PDFDocument } = await import('pdf-lib');
            const srcResp = await fetch(sourcePdfUrl);
            const srcDoc = await PDFDocument.load(await srcResp.arrayBuffer());
            
            const tgtResp = await fetch(pdfUrl);
            const tgtDoc = await PDFDocument.load(await tgtResp.arrayBuffer());
            
            const copiedPages = await tgtDoc.copyPages(srcDoc, sourcePageNums.map(n => n - 1));
            copiedPages.forEach(p => tgtDoc.addPage(p));
            
            const newBytes = await tgtDoc.save();
            const newFile = new File([newBytes as any], file?.name || 'Merged.pdf', { type: 'application/pdf' });
            
            const newOrder = [...pageOrder];
            // If we added multiple pages, their original page numbers will be sequentially added to the end
            const newOriginalNum = tgtDoc.getPageCount() - copiedPages.length;
            for (let i = 0; i < copiedPages.length; i++) {
                newOrder.splice(insertDropIndex + i, 0, newOriginalNum + i + 1);
            }
            (window as any).__prynx_cross_file_page_order = newOrder;

            setFile(newFile);
            setPdfUrl(URL.createObjectURL(newFile));
        } catch (e) {
            console.error("Cross-file copy failed", e);
        } finally {
            setIsProcessing(false);
        }
    };

    useEffect(() => {
        const handleCrossFileEvent = (e: any) => {
            const { sourcePdfUrl, sourcePageNums, targetPdfUrl, dropIndex } = e.detail;
            if (targetPdfUrl === pdfUrl) {
                const insertIdx = dropIndex !== null && dropIndex !== undefined ? dropIndex : pageOrder.length;
                handleCrossFileDrop(sourcePdfUrl, sourcePageNums, insertIdx);
            }
        };
        window.addEventListener('prynx-cross-file-drop', handleCrossFileEvent);
        return () => window.removeEventListener('prynx-cross-file-drop', handleCrossFileEvent);
    }, [pdfUrl, pageOrder]);

    // ═══ Guide handlers ═══
    const guidesRef = useRef<Guide[]>([]);
    useEffect(() => { guidesRef.current = guides; }, [guides]);
    // Giữ activePage cho handler (useCallback [] → tránh stale closure).
    const activePageRef = useRef(activePage);
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);

    // Đổi toạ độ chuột (client) → pos guide lưu theo MÉP TRANG thật (khớp GuideLayer/Ruler).
    // Fallback về hệ gốc-cuộn cũ nếu không tìm thấy trang active.
    const clientToGuidePos = useCallback((clientX: number, clientY: number, orientation: 'horizontal' | 'vertical') => {
        const anchorEl = document.getElementById(`pdf-page-container-${activePageRef.current}`);
        if (anchorEl) {
            const pr = anchorEl.getBoundingClientRect();
            return orientation === 'horizontal' ? clientY - pr.top : clientX - pr.left;
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

    const handleRulerMouseDown = useCallback((e: React.MouseEvent, orientation: 'horizontal' | 'vertical') => {
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
            let uClientPos = orientation === 'horizontal' ? upEvent.clientY - rect.top : upEvent.clientX - rect.left;
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
            let uClientPos = guide.type === 'horizontal' ? upEvent.clientY - rect.top : upEvent.clientX - rect.left;
            if (uClientPos < 0) { setDraggingGuide(null); setSelectedGuideId(null); return; }
            const finalPos = clientToGuidePos(upEvent.clientX, upEvent.clientY, guide.type);
            setGuides(prev => [...prev, { ...guide, pos: finalPos }]);
            setDraggingGuide(null);
        };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [clientToGuidePos]);

    // ═══ Scroll Sync ═══
    const syncing = useRef(false);
    const scrollTimeout = useRef<any | null>(null);

    const handleMainScroll = useCallback((e: any) => {
        if (syncing.current || pageDisplayMode.includes('_fit') || isZoomingRef.current) return;
        if ((mainVirtuosoRef.current as any)?.__thumbClickActive) return;
        if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
        scrollTimeout.current = setTimeout(() => {
            const src = e.target || e.currentTarget;
            if (src && numPages > 0) {
                const containerRect = src.getBoundingClientRect();
                const targetX = containerRect.left + containerRect.width / 2;
                const targetY = containerRect.top + containerRect.height / 3;
                let bestPage: number | null = null;
                let hitEl = document.elementFromPoint(targetX, targetY) as HTMLElement | null;
                while (hitEl && hitEl !== src) {
                    if (hitEl.id?.startsWith('pdf-page-container-')) { bestPage = parseInt(hitEl.id.replace('pdf-page-container-', '')); break; }
                    hitEl = hitEl.parentElement;
                }
                if (!bestPage) {
                    const scrollPercent = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
                    bestPage = Math.min(numPages, Math.max(1, Math.round(scrollPercent * numPages) + 1));
                }
                setActivePage(bestPage);
                setSelectedIndices(prev => {
                    if (prev.size <= 1 && pageOrder) {
                        const idx = pageOrder.indexOf(bestPage!);
                        // Đồng bộ anchor shift-select theo trang vừa active (cuộn/điều hướng
                        // main view). Nếu KHÔNG set, anchor kẹt ở giá trị cũ (khởi tạo 0) →
                        // shift-click sau đó tính range từ 0 → chọn nhầm cả các trang đầu.
                        if (idx >= 0) setLastSelectedIndex(idx);
                        return new Set([idx]);
                    }
                    return prev;
                });
            }
        }, 150);
    }, [numPages, pageDisplayMode, pageOrder, setSelectedIndices, setLastSelectedIndex]);

    // ═══ Render Rows Memoization ═══
    const visitedIndicesRef = useRef<Set<number>>(new Set());

    const scrollRowsMemo = useMemo(() => {
        if (!pageOrder || pageOrder.length === 0) return [];
        if (pageDisplayMode === 'single_scroll') return pageOrder.map((p, i) => ({ type: 'single', indices: [i], pages: [p] }));
        if (pageDisplayMode === 'two_scroll') {
            const rows = [];
            for (let i = 0; i < pageOrder.length; i += 2) {
                const row: any = { type: 'two', indices: [i], pages: [pageOrder[i]] };
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
                const row: any = { type: 'two', indices: [r], pages: [pageOrder[r]] };
                if (r + 1 < pageOrder.length) { row.indices.push(r + 1); row.pages.push(pageOrder[r + 1]); }
                return row;
            });
        }
        return [];
    }, [pageOrder, pageDisplayMode, activePage]);

    const renderRows = pageDisplayMode.includes('scroll') ? scrollRowsMemo : fitRowsMemo;

    const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);

    // ═══ Page Renderer ═══
    const renderPdfPage = useCallback((originalPageNum: number, flatIndex?: number) => {
        if (!originalPageNum) return null;
        const plateLabel = plateLabels[originalPageNum];
        // Rotation keyed theo INSTANCE-ID (mỗi vị trí 1 id riêng) → bản nhân bản / trang
        // trắng xoay ĐỘC LẬP. flatIndex = vị trí trong pageOrder → tra id. Fallback về 0
        // khi thiếu index (không nên xảy ra ở luồng render rows).
        const instId = flatIndex !== undefined ? pageInstanceIds[flatIndex] : undefined;
        const rot = instId ? (pageRotations[instId] || 0) : 0;
        const localDim = allPageDims[originalPageNum] || pageDim;
        const localWidth100 = localDim ? localDim.w : actualWidth100;

        // Show OCG preview overlay on active page when layers are hidden
        const showOcgOverlay = ocgPreviewUrl && originalPageNum === activePage;

        return (
            <div id={`pdf-page-container-${originalPageNum}`} className="flex flex-col items-center">
                {plateLabel && <div className="text-[11px] font-semibold text-yellow-400 mb-1 px-2 py-0.5 tracking-wide max-w-full truncate">{plateLabel}</div>}
                <div className="relative">
                    <LivePageFrame
                        originalPageNum={originalPageNum}
                        actualWidth100={localWidth100}
                        zoom={zoom}
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
                        textBlocks={nativeTextBlocks[originalPageNum]}
                        setHoveredPdfPosition={setHoveredPdfPosition}
                        isBlankDoc={!!(file as any)?.isBlank}
                        isImageFile={isImage}
                        detectedDimension={activeDashboardTool === 'sticker_imposer' && !file?.name.startsWith('Imposed_') ? detectedDimensionsByPage[originalPageNum - 1] : undefined}
                        editSession={editSession}
                        isActivePage={originalPageNum === activePage}
                    />
                    {showOcgOverlay && <OcgPreviewOverlay url={ocgPreviewUrl} />}
                </div>
            </div>
        );
    }, [pageRotations, pageInstanceIds, allPageDims, pageDim, actualWidth100, zoom, bleedView, highlightBoxes, isVdpMode, getTileUrl, nativeTextBlocks, plateLabels, activeDashboardTool, detectedDimensionsByPage, file, ocgPreviewUrl, activePage, editSession, isImage]);

    // Kiểm tra loadError SAU khi mọi hook đã được gọi (xem ghi chú ở đầu component).
    if (loadError) {
        return (
            <div className="flex flex-col items-center justify-center h-full w-full bg-red-50 text-red-600 gap-4 p-8 text-center">
                <svg className="w-16 h-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h2 className="text-2xl font-bold">{t('misc.acrobatViewer:loi_tai_pdf')}</h2>
                <p className="text-lg font-medium">{loadError.message}</p>
                <button 
                    onClick={() => window.location.reload()}
                    className="mt-4 px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 font-medium"
                >
                    {t('misc.acrobatViewer:tai_lai_trang')}
                </button>
            </div>
        );
    }

    // ═══ RENDER ═══
    return (
        <div className="flex flex-col h-full w-full bg-[#f3f4f6] dark:bg-[#323639] text-slate-800 dark:text-zinc-200 transition-colors overflow-hidden relative font-sans select-none">
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
                            onClick={openExportImage}
                            title={t('misc.acrobatViewer:xuat_anh_png_jpeg_tiff')}
                            aria-label={t('misc.acrobatViewer:xuat_anh')}
                            className="flex items-center gap-1.5 px-2.5 h-8 rounded text-[13px] font-medium text-slate-600 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                            <span className="tb-label">{t('misc.acrobatViewer:xuat_anh')}</span>
                        </button>
                    )}
                    {toolbarExtra}
                </>}
                onOpenRotateModalOrTools={(type) => {
                    if ((type as string) === 'rotate') { setActiveDashboardTool('pages'); setIsSidebarOpen(true); }
                    else if ((type as string) === 'delete') { setIsDeleteModalOpen(true); }
                    else { setActiveDashboardTool('pages'); setIsSidebarOpen(true); }
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
                            setActiveDashboardTool={setActiveDashboardTool} setIsSidebarOpen={setIsSidebarOpen}
                            setContextMenu={setContextMenu}
                            setIsInsertModalOpen={setIsInsertModalOpen}
                            setExtractPagesStrForModal={setExtractPagesStrForModal}
                            setIsExtractModalOpen={setIsExtractModalOpen}
                            setIsDeleteModalOpen={setIsDeleteModalOpen}
                            sidebarRef={sidebarRef} mainVirtuosoRef={mainVirtuosoRef} internalScrollRef={internalScrollRef}
                            file={file} pdfUrl={pdfUrl}
                        />
                    )}

                    {/* Loading Spinner — shown when PDF is loading metadata */}
                    {pdfUrl && numPages === 0 && !loadError && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-[#525659]">
                            <div className="w-10 h-10 border-[3px] border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" />
                            <p className="text-sm text-zinc-400 font-medium animate-pulse">{t('misc.acrobatViewer:dang_tai_file_pdf')}</p>
                        </div>
                    )}

                    {/* Main PDF Canvas */}
                    {numPages > 0 && (
                        <div className="flex-1 flex min-w-0 min-h-0 relative">
                            {showRulers && (
                                <>
                                    <Ruler orientation="vertical" scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>} zoom={zoom} unit={measurementUnit} onMouseDown={handleRulerMouseDown} pageAnchorId={`pdf-page-container-${activePage}`} />
                                    <Ruler orientation="horizontal" scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>} zoom={zoom} unit={measurementUnit} onMouseDown={handleRulerMouseDown} pageAnchorId={`pdf-page-container-${activePage}`} />
                                </>
                            )}
                            <div
                                className={`absolute bottom-0 right-0 overflow-hidden bg-[#525659] flex justify-center select-text ${toolMode === 'hand' ? 'panning-mode cursor-grab active:cursor-grabbing' : ''}`}
                                ref={containerRef}
                                onMouseDown={(e) => { setSelectedGuideId(null); handleDragStart(e); }}
                                style={{ left: showRulers ? 20 : 0, top: showRulers ? 20 : 0 }}
                            >
                                <GuideLayer scrollContainerRef={internalScrollRef as React.RefObject<HTMLElement>} guides={guides} draggingGuide={draggingGuide} selectedGuideId={selectedGuideId} onGuideMouseDown={handleGuideMouseDown} pageAnchorId={`pdf-page-container-${activePage}`} />

                                {pageDim && (
                                    <div className="absolute bottom-0 left-0 w-40 h-24 z-[50] group flex items-end p-6">
                                        <div style={{ padding: '8px 20px' }} className="bg-[#222]/95 backdrop-blur-sm text-[#e0e0e0] font-mono text-[14px] font-semibold rounded-lg border border-white/10 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none tracking-wider whitespace-nowrap">
                                            {(() => { const d = allPageDims[activePage] || pageDim; return `${Math.round(d.w * (25.4 / 96))} x ${Math.round(d.h * (25.4 / 96))} mm`; })()}
                                        </div>
                                    </div>
                                )}

                                {isZoomReady && (() => {
                                    if (pageDisplayMode.includes('_fit')) {
                                        return (
                                            <div className="flex-1 relative min-w-0 min-h-0">
                                                <div className="absolute inset-0 overflow-auto acro-scroll outline-none block" ref={(el) => { internalScrollRef.current = el; }}>
                                                    <div className="min-w-full min-h-full w-max h-max flex flex-col relative" style={{ alignItems: 'safe center', justifyContent: 'safe center' }}>
                                                        {renderRows.map((row) => {
                                                            const isActive = row.indices.includes(activePage - 1);
                                                            return (
                                                                <div key={row.indices.join('_')} className={`flex min-w-full ${toolMode === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-auto'}`}
                                                                    style={{ display: 'flex', alignItems: 'safe center', justifyContent: 'safe center', position: isActive ? 'relative' : 'absolute', opacity: isActive ? 1 : 0, pointerEvents: isActive ? 'auto' : 'none', visibility: isActive ? 'visible' : 'hidden', zIndex: isActive ? 10 : 0, paddingTop: 32, paddingBottom: 32, paddingLeft: 24, paddingRight: 24, gap: 12, width: 'max-content' }}>
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
                                                ref={mainVirtuosoRef} context={{ highlightBoxes }} totalCount={renderRows.length}
                                                increaseViewportBy={{ top: Math.max(1000, 2000 / zoom), bottom: Math.max(1000, 2000 / zoom) }}
                                                className="w-full h-full flex-1"
                                                components={{
                                                    Scroller: forwardRef((props, ref) => (
                                                        <div {...props} ref={ref as any} onScroll={(e) => { handleMainScroll(e); updateViewportRect(); if ('onScroll' in props && typeof props.onScroll === 'function') (props as any).onScroll(e); }} className="acro-scroll outline-none" style={{ height: '100%', width: '100%', ...props.style, overflowX: 'auto', overflowY: 'auto' }} />
                                                    )),
                                                    List: forwardRef((props, ref) => (
                                                        <div {...props} ref={ref as any} style={{ minHeight: '100%', ...props.style, minWidth: '100%', width: 'max-content' }} />
                                                    ))
                                                }}
                                                scrollerRef={(el) => { internalScrollRef.current = el && el instanceof HTMLElement ? el : null; }}
                                                itemContent={(index) => {
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
                                                }}
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

            {/* Modals */}
            {isDeleteModalOpen && <QuickDeleteModal selectedCount={selectedIndices.size} onConfirm={handleQuickDeleteConfirm} onClose={() => setIsDeleteModalOpen(false)} />}
            {isExtractModalOpen && <ExtractPagesModal pageCount={pageOrder.length} initialPagesStr={extractPagesStrForModal} onConfirm={handleExtractPages} onClose={() => setIsExtractModalOpen(false)} />}
            {isInsertModalOpen && <InsertBlankPageModal pageCount={pageOrder.length} onConfirm={handleInsertBlankPage} onClose={() => setIsInsertModalOpen(false)} />}

            {/* Crop PDF dialog (Set Page Boxes) */}
            <CropDialog ensureFileId={ensureCropFileId} onApplied={handleCropApplied} onClose={() => setIsCropMode(false)} />

            {/* Export ảnh (PNG/JPEG/TIFF) */}
            <ExportImageModal
                open={isExportImageOpen}
                onClose={() => setIsExportImageOpen(false)}
                fileId={exportFileId}
                filePath={exportFilePath}
                numPages={numPages}
                currentPage={activePage}
                baseName={file?.name?.replace(/\.[^.]+$/, '') || 'page'}
            />

            {/* Context Menu */}
            <ViewerContextMenu
                contextMenu={contextMenu} selectedIndices={selectedIndices} setContextMenu={setContextMenu}
                setIsInsertModalOpen={setIsInsertModalOpen} setIsExtractModalOpen={setIsExtractModalOpen}
                setExtractPagesStrForModal={setExtractPagesStrForModal} setIsDeleteModalOpen={setIsDeleteModalOpen}
                setActiveDashboardTool={setActiveDashboardTool} setIsSidebarOpen={setIsSidebarOpen}
                onQuickDuplicate={handleQuickDuplicate}
            />
        </div>
    );
}
