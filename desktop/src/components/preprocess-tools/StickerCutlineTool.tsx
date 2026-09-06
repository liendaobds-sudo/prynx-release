import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import { tv } from '../../i18n';
import { stickerSourceOwnerFromHistory } from '../stickerSheetTabSelector';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { saveBlob } from '../../lib/saveBlob';
import { toast } from '../ui/Toast';
import { registerStickerIncomingSource } from '../../lib/stickerIncomingSources';
import StickerSheetPanel from './StickerSheetPanel';
import StickerTool from './StickerTool';
import StickerObjectSelectionControl from './StickerObjectSelectionControl';
import {
    useStickerSheetStore,
    type PrepareStickerWorkspaceSource,
    type StickerWorkspaceSourceLease,
} from './stickerSheetStore';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import { makeUnifiedStickerRecipe } from '../../lib/recipe/unifiedStickerRecipe';
import { WorkspaceContext } from '../../stores/useWorkspaceStore';
import { ImposerSettingsContext } from '../imposition-tools/useImposerSettingsStore';


interface Props {
    tabId: string;
    pdfFile: File | null;
    sourceImageFile?: File | null;
    /** Số trang nguồn gốc để workspace AI bám đúng thumbnail sau reorder. */
    activeSourcePage?: number;
    /** Vị trí 1-based trong working PDF đã bake reorder/xóa/nhân bản. */
    activeWorkingPage?: number;
    pageOrder?: number[];
    isActive?: boolean;
    onOpenTool?: (tool: 'sticker_imposer' | 'cnc_imposer') => void;
    onFileFixed: (
        blob: Blob,
        name: string,
        path?: string,
        recipeTicket?: RecipeOperationTicket | null,
    ) => void | boolean | Promise<void | boolean>;
}

/**
 * UIUX (audit 2026-09-06 §CUSTOM.1): tự động và chọn PDF cùng session/form;
 * chỉ Xén vuông góc giữ adapter hình học riêng.
 */
const UNIFIED_STICKER_WORKSPACE = true;

export default function StickerCutlineTool({
    tabId,
    pdfFile,
    sourceImageFile,
    activeSourcePage = 1,
    activeWorkingPage = activeSourcePage,
    pageOrder,
    isActive = true,
    onOpenTool,
    onFileFixed,
}: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const workspaceStore = useContext(WorkspaceContext);
    const settingsStore = useContext(ImposerSettingsContext);
    const shellRef = useRef<HTMLDivElement | null>(null);
    const workingPdf = useWorkingPdf();
    const workspaceLeaseRef = useRef<StickerWorkspaceSourceLease | null>(null);
    const workspaceLeasePromiseRef = useRef<Promise<StickerWorkspaceSourceLease> | null>(null);
    const mode = tab?.mode || 'existing';
    const productType = tab?.productType || 'sticker';
    const [directProcessing, setDirectProcessing] = useState(false);
    const [selectingObjects, setSelectingObjects] = useState(false);
    const [completedExport, setCompletedExport] = useState<{
        filename: string;
        stickerCount: number;
    } | null>(null);
    const exportedFilenameRef = useRef<string | null>(null);
    const workflowBusy = (
        ['inspecting', 'detecting', 'confirming', 'exporting'].includes(tab?.status || '')
        || tab?.isRefining === true
        || directProcessing
    );
    const workingPageOrder = pageOrder?.map((_sourcePage, index) => index + 1);

    useEffect(() => {
        if (!isActive || selectingObjects || productType !== 'sticker' || workflowBusy) return undefined;
        return registerStickerIncomingSource(tabId, files => {
            void actions.selectSources(tabId, files, 'explicit');
            return true;
        });
    }, [actions, selectingObjects, isActive, productType, tabId, workflowBusy]);

    const prepareWorkspaceSource = useCallback<PrepareStickerWorkspaceSource>(async () => {
        const cached = workspaceLeaseRef.current;
        if (cached?.isCurrent()) return cached;
        const inFlight = workspaceLeasePromiseRef.current;
        if (inFlight) return inFlight;

        const pending: Promise<StickerWorkspaceSourceLease> = (async () => {
            // REVISION (audit 2026-08-25 §REV.05): chỉ chốt edit và materialize
            // Working PDF khi người dùng thật sự Nhận diện/Xuất, không chạy nền.
            await workingPdf.prepare();
            const revision = workingPdf.capture();
            if (!revision) {
                throw new Error('Không tìm thấy PDF đang hiển thị để nhận diện tem.');
            }
            const file = await workingPdf.materialize(revision);
            if (!workingPdf.isCurrent(revision)) {
                throw new Error('Tài liệu đã thay đổi trong lúc chuẩn bị. Hãy thử lại.');
            }
            const lease: StickerWorkspaceSourceLease = {
                file,
                revision,
                isCurrent: () => workingPdf.isCurrent(revision),
            };
            workspaceLeaseRef.current = lease;
            return lease;
        })().finally(() => {
            if (workspaceLeasePromiseRef.current === pending) {
                workspaceLeasePromiseRef.current = null;
            }
        });
        workspaceLeasePromiseRef.current = pending;
        return pending;
    }, [workingPdf]);

    useEffect(() => {
        actions.initTab(tabId);
        // UNIFIED (audit 2026-09-06 §UNIFIED.3): tem nhãn luôn vào workspace
        // chung; Xén vuông góc vẫn chọn adapter classic riêng bên dưới.
        if (UNIFIED_STICKER_WORKSPACE && isActive) {
            actions.enableUnified(tabId);
            const expectedMode = productType === 'rectangle' ? 'existing' : 'ai-sheet';
            if (mode !== expectedMode) actions.setMode(tabId, expectedMode);
        }
    }, [actions, isActive, mode, productType, tabId]);

    useEffect(() => {
        if (!isActive || mode !== 'ai-sheet') return;
        // REVISION (audit 2026-08-25 §REV.05): AI xử lý Working PDF đã bake
        // reorder/duplicate nên trang phải bám vị trí thumbnail, không bám source page.
        actions.setActivePage(tabId, activeWorkingPage);
    }, [actions, activeWorkingPage, isActive, mode, tabId]);

    useEffect(() => {
        if (!isActive || mode !== 'ai-sheet') return;
        const workspaceSource = pdfFile || sourceImageFile;
        if (!workspaceSource) return;
        // UIUX (feedback 2026-08-10): PDF vừa xuất là kết quả đang xem, không phải
        // nguồn AI mới. Chỉ bỏ chốt khi Viewer thực sự chuyển sang một file khác.
        const exportedFilename = exportedFilenameRef.current;
        if (exportedFilename && workspaceSource.name === exportedFilename) return;
        if (exportedFilename) {
            exportedFilenameRef.current = null;
            setCompletedExport(null);
        }
        const current = useStickerSheetStore.getState().getTab(tabId);
        if (current.sourceOrigin === 'explicit' && current.sourceFile) return;
        const historySourceOwner = stickerSourceOwnerFromHistory(pdfFile);
        if (
            current.sourceFile === workspaceSource
            || (historySourceOwner !== null && historySourceOwner === current.sourceFile)
        ) return;
        // UIUX (feedback 2026-08-09 §MP.THUMBNAIL): tài liệu trong Viewer là nguồn
        // duy nhất; đổi file/thumbnail không giữ lại một nguồn ảnh riêng trong panel.
        // Chỉ đồng bộ file, tuyệt đối không inspect/detect ngầm.
        actions.selectSource(
            tabId,
            workspaceSource,
            pdfFile ? 'workspace' : 'explicit',
        );
    }, [actions, isActive, mode, pdfFile, sourceImageFile, tabId]);

    useEffect(() => {
        if (!isActive || productType !== 'sticker' || mode !== 'ai-sheet') return;
        // UIUX (feedback 2026-09-06 §UNDO.DETECT): shell còn mounted sau khi bỏ
        // nhận diện; lịch sử nét sửa được ưu tiên trước lịch sử kết quả nhận diện.
        const handleHistoryShortcut = (event: KeyboardEvent) => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey
                || event.isComposing || event.keyCode === 229
                || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
            const key = event.key.toLowerCase();
            const undo = key === 'z' && !event.shiftKey;
            const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
            if (!undo && !redo) return;
            const workspace = workspaceStore?.getState();
            const runtimeTool = settingsStore?.getState().activeDashboardTool;
            if (selectingObjects || directProcessing || workspace?.isObjectEditMode || workspace?.isCropMode
                || (runtimeTool && runtimeTool !== 'sticker')) return;
            const owner = shellRef.current?.closest<HTMLElement>('[data-prynx-tab-id]')
                ?? Array.from(document.querySelectorAll<HTMLElement>('[data-prynx-tab-id]'))
                    .find(element => element.dataset.prynxTabId === tabId);
            if (shellRef.current?.closest('[hidden], .opacity-0')
                || target?.closest('[role="dialog"][aria-modal="true"]')
                || Array.from(owner?.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? [])
                    .some(dialog => !dialog.hidden && !dialog.closest('[hidden], .opacity-0')
                        && window.getComputedStyle(dialog).display !== 'none'
                        && window.getComputedStyle(dialog).visibility !== 'hidden')) return;
            const before = useStickerSheetStore.getState().tabs[tabId];
            if (!before || before.mode !== 'ai-sheet' || before.productType !== 'sticker') return;
            // Không áp kết quả cũ vào revision mới hoặc chiếm Undo của PDF vừa xuất.
            if (exportedFilenameRef.current && pdfFile?.name === exportedFilenameRef.current) return;
            if (before.sourceOrigin === 'workspace') {
                const lease = workspaceLeaseRef.current;
                if (!lease || !lease.isCurrent() || lease.file !== before.sourceFile
                    || lease.revision !== before.sourceRevision) return;
            }
            if (undo) actions.undo(tabId);
            else actions.redo(tabId);
            const after = useStickerSheetStore.getState().getTab(tabId);
            const edited = before.edits.length !== after.edits.length || before.redoEdits.length !== after.redoEdits.length;
            const changed = edited || (undo ? actions.undoDetection(tabId) : actions.redoDetection(tabId));
            if (!changed) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        window.addEventListener('keydown', handleHistoryShortcut, true);
        return () => window.removeEventListener('keydown', handleHistoryShortcut, true);
    }, [actions, directProcessing, isActive, mode, pdfFile, productType, selectingObjects, settingsStore, tabId, workspaceStore]);

    const handleExport = async () => {
        const recording = recipeRecorder.isRecordingFor(tabId);
        const params = makeUnifiedStickerRecipe(useStickerSheetStore.getState().getTab(tabId), workingPageOrder);
        if (recording && !params) {
            toast.error(tv('Vùng sửa tay hoặc thiết lập riêng từng trang không phát lại được. Dừng ghi quy trình rồi xuất.'));
            return;
        }
        const ticket = recording ? recipeRecorder.noteOperation('sticker_dieline', params!, undefined, tabId) : null;
        if (recording && !ticket) {
            toast.error(tv('Một thao tác khác đang chờ ghi quy trình. Hãy thử lại.'));
            return;
        }
        const result = await actions.exportFile(
            tabId,
            'pdf',
            workingPageOrder,
            prepareWorkspaceSource,
        );
        if (!result) { recipeRecorder.discardPending(ticket); return; }
        exportedFilenameRef.current = result.filename;
        try {
            const committed = await onFileFixed(result.blob, result.filename, result.outputPath, ticket);
            if (committed === false) {
                exportedFilenameRef.current = null;
                return;
            }
            setCompletedExport({
                filename: result.filename,
                stickerCount: result.stickerCount,
            });
            toast.success(`${tv('Kết quả')}: ${result.filename} · ${result.stickerCount} ${tv('tem')}`);
        } catch {
            exportedFilenameRef.current = null;
            toast.error(tv('Đã tạo PDF nhưng không đưa được vào tài liệu đang mở. Hãy thử lại.'));
        } finally {
            recipeRecorder.discardPending(ticket);
            actions.finishExport(tabId);
        }
    };

    const handleExportPng = async () => {
        const result = await actions.exportFile(
            tabId,
            'png_zip',
            workingPageOrder,
            prepareWorkspaceSource,
        );
        if (!result) return;
        try {
            const saved = await saveBlob(result.blob, result.filename, {
                title: tv('Lưu bộ PNG từng tem'),
                filterName: 'ZIP',
                extensions: ['zip'],
            });
            if (saved.kind === 'saved') {
                toast.success(`${tv('Đã lưu')} ${result.stickerCount} PNG`);
            }
        } catch {
            toast.error(tv('Không lưu được bộ PNG. Hãy thử lại.'));
        } finally {
            actions.finishExport(tabId);
        }
    };

    return (
        <div ref={shellRef} className="flex flex-col gap-4">
            {UNIFIED_STICKER_WORKSPACE && (
                <div
                    role="group"
                    aria-label={tv('Mục tiêu gia công', 'preprocess.stickerSheet')}
                    className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-zinc-700 dark:bg-zinc-800/60"
                >
                    {(['sticker', 'rectangle'] as const).map(productType => (
                        <button
                            key={productType}
                            type="button"
                            aria-pressed={(tab?.productType || 'sticker') === productType}
                            disabled={workflowBusy || selectingObjects}
                            onClick={() => {
                                actions.setProductType(tabId, productType);
                                actions.setMode(tabId, productType === 'sticker' ? 'ai-sheet' : 'existing');
                            }}
                            className={`min-h-10 rounded-lg px-2 text-[10px] font-bold ${
                                tab?.productType === productType
                                    ? 'bg-white text-violet-700 shadow-sm dark:bg-zinc-900 dark:text-violet-300'
                                    : 'text-slate-500 hover:text-slate-800 dark:text-zinc-400'
                            }`}
                        >
                            {productType === 'sticker'
                                ? tv('Bế tem nhãn', 'preprocess.sticker')
                                : tv('Xén vuông góc', 'preprocess.sticker')}
                        </button>
                    ))}
                </div>
            )}

            {productType === 'rectangle' ? (
                <StickerTool
                    tabId={tabId}
                    pdfFile={pdfFile}
                    onFileFixed={onFileFixed}
                    onProcessingChange={setDirectProcessing}
                    isActive={isActive}
                    pageNumber={activeWorkingPage}
                    productType={productType}
                    showProductTypeSelector={false}
                />
            ) : (
                <>
                    <StickerSheetPanel
                        tabId={tabId}
                        onExport={handleExport}
                        onExportPng={handleExportPng}
                        isExporting={tab?.isExporting === true}
                        pageOrder={workingPageOrder}
                        prepareWorkspaceSource={prepareWorkspaceSource}
                        interactionLocked={selectingObjects || directProcessing}
                        selectionControl={pdfFile && <StickerObjectSelectionControl tabId={tabId} workingPage={activeWorkingPage}
                            isActive={isActive} disabled={workflowBusy || tab?.isCutlinePreviewing === true}
                            prepareWorkspaceSource={prepareWorkspaceSource}
                            onSelectionActiveChange={setSelectingObjects} onProcessingChange={setDirectProcessing} />}
                        unified
                    />
                    {completedExport && (
                        <div
                            role="status"
                            className="animate-in fade-in slide-in-from-bottom-2 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm duration-300 dark:border-emerald-800/50 dark:bg-zinc-800"
                        >
                            <div className="mb-3 flex items-center gap-2">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                                    <span className="text-sm">✅</span>
                                </div>
                                <div className="min-w-0">
                                    <h3 className="text-[13px] font-bold text-emerald-700 dark:text-emerald-400">
                                        {tv('Đã tạo bù xén thành công!', 'preprocess.sticker')}
                                    </h3>
                                    <p className="text-[10px] leading-tight text-slate-500 dark:text-zinc-400">
                                        {tv('Bước tiếp theo: Chọn kiểu dàn trang (Imposition)', 'preprocess.sticker')}
                                    </p>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    disabled={workflowBusy || !onOpenTool}
                                    onClick={() => onOpenTool?.('sticker_imposer')}
                                    className="min-h-11 rounded-lg bg-violet-600 px-2 text-[10px] font-bold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {tv('Bình tem bế')}
                                </button>
                                <button
                                    type="button"
                                    disabled={workflowBusy || !onOpenTool}
                                    onClick={() => onOpenTool?.('cnc_imposer')}
                                    className="min-h-11 rounded-lg border border-violet-300 bg-white px-2 text-[10px] font-bold text-violet-700 shadow-sm transition-colors hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300"
                                >
                                    {tv('Bình bế rớt (CNC)')}
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
