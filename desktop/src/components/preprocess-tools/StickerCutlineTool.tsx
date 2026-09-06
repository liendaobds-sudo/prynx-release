import { useCallback, useEffect, useRef, useState } from 'react';

import { tv } from '../../i18n';
import { stickerSourceOwnerFromHistory } from '../stickerSheetTabSelector';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { saveBlob } from '../../lib/saveBlob';
import { toast } from '../ui/Toast';
import { registerStickerIncomingSource } from '../../lib/stickerIncomingSources';
import StickerSheetPanel from './StickerSheetPanel';
import StickerTool from './StickerTool';
import {
    useStickerSheetStore,
    type PrepareStickerWorkspaceSource,
    type StickerWorkspaceSourceLease,
} from './stickerSheetStore';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import { makeUnifiedStickerRecipe } from '../../lib/recipe/unifiedStickerRecipe';


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
 * UIUX (audit 2026-09-06 §UNIFIED.2): một vỏ workflow cho hai adapter cũ.
 * Không gộp writer/state ở lượt này; nút Nhận diện tự động chỉ chuyển sang
 * adapter session và giữ nguyên đường xuất hiện có của StickerSheetPanel.
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
    const workingPdf = useWorkingPdf();
    const workspaceLeaseRef = useRef<StickerWorkspaceSourceLease | null>(null);
    const workspaceLeasePromiseRef = useRef<Promise<StickerWorkspaceSourceLease> | null>(null);
    const mode = tab?.mode || 'existing';
    const productType = tab?.productType || 'sticker';
    const [classicAdvanced, setClassicAdvanced] = useState(false);
    const [directProcessing, setDirectProcessing] = useState(false);
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
    const sourceFile = tab?.sourceFile || pdfFile || sourceImageFile || null;
    const sourceLabel = sourceFile?.name || 'Chưa chọn file';
    const outputIntent = mode === 'ai-sheet' && tab?.outputSettings.cropToSticker
        ? 'Tách từng tem'
        : 'Giữ nguyên tấm';

    useEffect(() => {
        if (!isActive || classicAdvanced || productType !== 'sticker' || workflowBusy) return undefined;
        return registerStickerIncomingSource(tabId, files => {
            void actions.selectSources(tabId, files, 'explicit');
            return true;
        });
    }, [actions, classicAdvanced, isActive, productType, tabId, workflowBusy]);

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
            const expectedMode = productType === 'rectangle' || classicAdvanced ? 'existing' : 'ai-sheet';
            if (mode !== expectedMode) actions.setMode(tabId, expectedMode);
        }
    }, [actions, classicAdvanced, isActive, mode, productType, tabId]);

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
        <div className="flex flex-col gap-4">
            {UNIFIED_STICKER_WORKSPACE && (
                <div
                    aria-label={tv('Bù xén và tạo đường cắt', 'preprocess.stickerSheet')}
                    className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="text-[13px] font-bold text-slate-800 dark:text-zinc-100">
                                {tv('Bù xén và tạo đường cắt', 'preprocess.stickerSheet')}
                            </h2>
                            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400">
                                {tv('Một quy trình cho tem đã có biên và ảnh nhiều tem.', 'preprocess.stickerSheet')}
                            </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[9px] font-bold text-slate-600 dark:bg-zinc-800 dark:text-zinc-300">
                            {mode === 'ai-sheet' ? tv('Nhận diện tự động') : tv('Bù xén trực tiếp')}
                        </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                        <div className="min-w-0 rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-zinc-800/80">
                            <span className="block font-semibold text-slate-500 dark:text-zinc-400">{tv('Nguồn')}</span>
                            <span className="mt-0.5 block truncate font-bold text-slate-700 dark:text-zinc-200" title={sourceLabel}>
                                {sourceLabel}
                            </span>
                        </div>
                        <div className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-zinc-800/80">
                            <span className="block font-semibold text-slate-500 dark:text-zinc-400">{tv('Đầu ra')}</span>
                            <span className="mt-0.5 block font-bold text-slate-700 dark:text-zinc-200">{tv(outputIntent)}</span>
                        </div>
                    </div>
                </div>
            )}

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
                            disabled={workflowBusy}
                            onClick={() => {
                                actions.setProductType(tabId, productType);
                                setClassicAdvanced(false);
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

            {productType === 'sticker' && (
                <details className="text-xs text-slate-600 dark:text-zinc-300">
                    <summary className="cursor-pointer">{tv('Tùy chọn PDF nâng cao')}</summary>
                    <p className="my-2">{tv('Giữ công cụ chọn đối tượng, bù xén trực tiếp và quy trình cũ khi cần.')}</p>
                    <button type="button" disabled={workflowBusy} className="font-semibold underline"
                        onClick={() => setClassicAdvanced(current => !current)}>
                        {tv(classicAdvanced ? 'Quay lại workspace tem' : 'Xử lý đối tượng PDF trực tiếp')}
                    </button>
                </details>
            )}
            {productType === 'rectangle' || classicAdvanced ? (
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
