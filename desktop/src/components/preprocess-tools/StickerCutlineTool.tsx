import { useCallback, useEffect, useRef, useState } from 'react';

import { tv } from '../../i18n';
import { stickerSourceOwnerFromHistory } from '../stickerSheetTabSelector';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { saveBlob } from '../../lib/saveBlob';
import { toast } from '../ui/Toast';
import StickerSheetPanel from './StickerSheetPanel';
import StickerTool from './StickerTool';
import {
    useStickerSheetStore,
    type PrepareStickerWorkspaceSource,
    type StickerWorkspaceSourceLease,
} from './stickerSheetStore';
import type { RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';


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
    const [directProcessing, setDirectProcessing] = useState(false);
    const [completedExport, setCompletedExport] = useState<{
        filename: string;
        stickerCount: number;
    } | null>(null);
    const exportedFilenameRef = useRef<string | null>(null);
    const workflowBusy = (
        tab?.status === 'confirming'
        || tab?.status === 'exporting'
        || directProcessing
    );
    const workingPageOrder = pageOrder?.map((_sourcePage, index) => index + 1);
    const sourceFile = tab?.sourceFile || pdfFile || sourceImageFile || null;
    const sourceLabel = sourceFile?.name || 'Chưa chọn file';
    const outputIntent = mode === 'ai-sheet' && tab?.outputSettings.cropToSticker
        ? 'Tách từng tem'
        : 'Giữ nguyên tấm';

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

    useEffect(() => actions.initTab(tabId), [actions, tabId]);

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
        actions.selectSource(tabId, workspaceSource, 'workspace');
    }, [actions, isActive, mode, pdfFile, sourceImageFile, tabId]);

    const handleAutoDetect = useCallback(async () => {
        if (workflowBusy) return;
        exportedFilenameRef.current = null;
        setCompletedExport(null);
        actions.setMode(tabId, 'ai-sheet');

        // Ảnh rời không thuộc Working PDF vẫn đi qua adapter explicit; PDF trong
        // Viewer đi qua lease để giữ đúng revision hiện hành.
        const current = useStickerSheetStore.getState().getTab(tabId);
        const source = current.sourceFile || pdfFile || sourceImageFile;
        if (source && !current.sourceFile) {
            actions.selectSource(
                tabId,
                source,
                pdfFile ? 'workspace' : 'explicit',
                1,
            );
        }
        await actions.detectStickers(
            tabId,
            'auto',
            activeWorkingPage,
            pdfFile ? prepareWorkspaceSource : undefined,
        );
        const detected = useStickerSheetStore.getState().getTab(tabId);
        const detectedPage = detected.pages[detected.activeSourcePage]
            || detected;
        if (
            detectedPage.status === 'mask-review'
            && detectedPage.manifest
            && !detectedPage.manifest.needs_review
        ) {
            await actions.confirmMask(tabId, detected.activeSourcePage);
        }
    }, [
        actions,
        activeWorkingPage,
        pdfFile,
        prepareWorkspaceSource,
        sourceImageFile,
        tabId,
        workflowBusy,
    ]);

    const handleExport = async () => {
        const result = await actions.exportFile(
            tabId,
            'pdf',
            workingPageOrder,
            prepareWorkspaceSource,
        );
        if (!result) return;
        exportedFilenameRef.current = result.filename;
        try {
            // RECIPE (audit 2026-08-17 §REC.4S): "Tách nhiều tem" chưa nối vé nên khi
            // đang ghi quy trình commit bị chặn (trả false) — KHÔNG hiện thẻ/toast
            // hoàn tất vì tài liệu đang mở không đổi và Recipe không có Step.
            const committed = await onFileFixed(result.blob, result.filename, result.outputPath);
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
                    {mode === 'existing' && (
                        <button
                            type="button"
                            disabled={workflowBusy}
                            onClick={() => { void handleAutoDetect(); }}
                            className="mt-3 h-10 w-full rounded-lg bg-violet-600 px-3 text-[11px] font-bold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {tv('Nhận diện tự động', 'preprocess.stickerSheet')}
                        </button>
                    )}
                </div>
            )}

            {mode === 'existing' ? (
                <StickerTool
                    tabId={tabId}
                    pdfFile={pdfFile}
                    onFileFixed={onFileFixed}
                    onProcessingChange={setDirectProcessing}
                    isActive={isActive}
                    pageNumber={activeWorkingPage}
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
