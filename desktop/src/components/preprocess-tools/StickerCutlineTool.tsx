import { useEffect, useRef } from 'react';

import { tv } from '../../i18n';
import { saveBlob } from '../../lib/saveBlob';
import { toast } from '../ui/Toast';
import StickerSheetPanel from './StickerSheetPanel';
import StickerTool from './StickerTool';
import { useStickerSheetStore, type StickerSourceMode } from './stickerSheetStore';


interface Props {
    tabId: string;
    pdfFile: File | null;
    sourceImageFile?: File | null;
    isActive?: boolean;
    onFileFixed: (blob: Blob, name: string, path?: string) => void | Promise<void>;
}

const MODES: Array<{ id: StickerSourceMode; label: string; description: string }> = [
    {
        id: 'existing',
        label: 'PDF/PNG đã có biên',
        description: 'Bù xén hoặc tạo đường cắt từ trang và kênh trong suốt hiện có.',
    },
    {
        id: 'ai-sheet',
        label: 'Ảnh AI nhiều tem',
        description: 'Tách từng tem, loại bóng mockup rồi tạo CutContour.',
    },
];

export default function StickerCutlineTool({ tabId, pdfFile, sourceImageFile, isActive = true, onFileFixed }: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const mode = tab?.mode || 'existing';
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;

    useEffect(() => actions.initTab(tabId), [actions, tabId]);

    useEffect(() => {
        if (!isActive || mode !== 'ai-sheet' || !sourceImageFile) return;
        const current = useStickerSheetStore.getState().getTab(tabId);
        if (current.status !== 'idle' || current.sourceFile) return;
        // NAV (audit 2026-08-05 §AI2.ROUTE1): chỉ auto-analyze đúng ảnh nguồn của
        // tab active; ảnh do người dùng đã chọn trong workspace luôn được ưu tiên.
        void actions.analyze(tabId, sourceImageFile);
    }, [actions, isActive, mode, sourceImageFile, tabId]);

    const handleExport = async () => {
        const result = await actions.exportFile(tabId, 'pdf');
        if (!result) return;
        await onFileFixed(result.blob, result.filename, result.outputPath);
        // NAV (audit 2026-08-05 §AI2.ROUTE3): commit xong phải bỏ lớp chỉnh mask để
        // PDF kết quả hiện ngay trong viewer. Đây chỉ là submode của cùng công cụ,
        // không điều hướng sang Bình tem bế; session AI vẫn còn để quay lại chỉnh tiếp.
        actions.setMode(tabId, 'existing');
        toast.success(`${tv('Kết quả')}: ${result.filename} · ${result.stickerCount} ${tv('tem')}`);
    };

    const handleExportPng = async () => {
        const result = await actions.exportFile(tabId, 'png_zip');
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
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-zinc-700 dark:bg-zinc-800/60">
                {MODES.map(option => (
                    <button
                        key={option.id}
                        type="button"
                        title={tv(option.description)}
                        aria-pressed={mode === option.id}
                        onClick={() => actions.setMode(tabId, option.id)}
                        className={`min-h-11 rounded-lg px-2 text-[10px] font-bold leading-tight transition-colors ${
                            mode === option.id
                                ? 'bg-white text-violet-700 shadow-sm dark:bg-zinc-900 dark:text-violet-300'
                                : 'text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                        }`}
                    >
                        {tv(option.label)}
                    </button>
                ))}
            </div>

            {mode === 'existing' ? (
                <StickerTool pdfFile={pdfFile} onFileFixed={onFileFixed} />
            ) : (
                <StickerSheetPanel
                    tabId={tabId}
                    onExport={() => { void handleExport(); }}
                    onExportPng={() => { void handleExportPng(); }}
                    isExporting={tab?.isExporting === true}
                />
            )}
        </div>
    );
}
