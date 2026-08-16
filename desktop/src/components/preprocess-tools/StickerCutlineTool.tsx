import { useEffect, useId, useRef, useState } from 'react';

import { tv } from '../../i18n';
import { stickerSourceOwnerFromHistory } from '../stickerSheetTabSelector';
import { saveBlob } from '../../lib/saveBlob';
import { toast } from '../ui/Toast';
import StickerSheetPanel from './StickerSheetPanel';
import StickerTool from './StickerTool';
import { useStickerSheetStore, type StickerSourceMode } from './stickerSheetStore';
import type { RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';


interface Props {
    tabId: string;
    pdfFile: File | null;
    sourceImageFile?: File | null;
    activeSourcePage?: number;
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

// UIUX (feedback 2026-08-15): gọi tên theo việc người dùng cần làm và giải thích
// ngay trên từng chế độ; không đưa thuật ngữ AI vào tên tab.
const MODES: Array<{ id: StickerSourceMode; label: string; description: string }> = [
    {
        id: 'existing',
        label: 'PDF/PNG đã có biên',
        description: 'Dùng khi file đã có biên tem rõ (mép trang, nền trong suốt hoặc đối tượng có thể chọn). Không cần file có sẵn CutContour; bạn vẫn bù xén và tạo đường cắt bằng giao diện cũ.',
    },
    {
        id: 'ai-sheet',
        label: 'Tách nhiều tem',
        description: 'Dùng khi một trang chứa nhiều tem nhưng chưa có biên riêng rõ ràng. Hệ thống sẽ tách thành từng tem riêng, hiển thị đường cắt màu tím để bạn kiểm tra và chỉnh sửa trước khi xuất.',
    },
];

export default function StickerCutlineTool({
    tabId,
    pdfFile,
    sourceImageFile,
    activeSourcePage = 1,
    pageOrder,
    isActive = true,
    onOpenTool,
    onFileFixed,
}: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const mode = tab?.mode || 'existing';
    const modeHelpId = useId();
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

    useEffect(() => actions.initTab(tabId), [actions, tabId]);

    useEffect(() => {
        if (!isActive || mode !== 'ai-sheet') return;
        // UIUX (audit 2026-08-09 §MP.6): trang AI bám số trang nguồn đang được
        // thumbnail chọn; đổi thumbnail không thay viewport hoặc trạng thái zoom/Hand.
        actions.setActivePage(tabId, activeSourcePage);
    }, [actions, activeSourcePage, isActive, mode, tabId]);

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

    const handleExport = async () => {
        const result = await actions.exportFile(tabId, 'pdf', pageOrder);
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
        const result = await actions.exportFile(tabId, 'png_zip', pageOrder);
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
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-zinc-700 dark:bg-zinc-800/60">
                {MODES.map(option => {
                    const tooltipId = `${modeHelpId}-${option.id}`;
                    return (
                        <div key={option.id} className="group/mode-help relative min-w-0">
                            <button
                                type="button"
                                disabled={workflowBusy}
                                aria-label={tv(option.label, 'preprocess.stickerSheet')}
                                aria-pressed={mode === option.id}
                                aria-describedby={tooltipId}
                                onClick={() => {
                                    if (workflowBusy || option.id === mode) return;
                                    exportedFilenameRef.current = null;
                                    setCompletedExport(null);
                                    actions.setMode(tabId, option.id);
                                }}
                                className={`min-h-11 w-full rounded-lg px-2 text-[10px] font-bold leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                    mode === option.id
                                        ? 'bg-white text-violet-700 shadow-sm dark:bg-zinc-900 dark:text-violet-300'
                                        : 'text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                                }`}
                            >
                                <span className="inline-flex items-center justify-center gap-1">
                                    {tv(option.label, 'preprocess.stickerSheet')}
                                    <span
                                        aria-hidden="true"
                                        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-current text-[9px] font-extrabold opacity-70"
                                    >
                                        ?
                                    </span>
                                </span>
                            </button>
                            <span
                                id={tooltipId}
                                role="tooltip"
                                className={`pointer-events-none invisible absolute top-full z-[120] mt-2 w-[260px] max-w-[calc(100vw-2rem)] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal text-white opacity-0 shadow-xl transition-all group-hover/mode-help:visible group-hover/mode-help:opacity-100 group-focus-within/mode-help:visible group-focus-within/mode-help:opacity-100 dark:bg-zinc-700 ${
                                    option.id === 'existing' ? 'left-0' : 'right-0'
                                }`}
                            >
                                {tv(option.description, 'preprocess.stickerSheet')}
                            </span>
                        </div>
                    );
                })}
            </div>

            {mode === 'existing' ? (
                <StickerTool
                    tabId={tabId}
                    pdfFile={pdfFile}
                    onFileFixed={onFileFixed}
                    onProcessingChange={setDirectProcessing}
                />
            ) : (
                <>
                    <StickerSheetPanel
                        tabId={tabId}
                        onExport={handleExport}
                        onExportPng={handleExportPng}
                        isExporting={tab?.isExporting === true}
                        pageOrder={pageOrder}
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
