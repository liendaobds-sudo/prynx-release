import { useEffect, useRef } from 'react';
import { Redo2, RotateCcw, Undo2 } from 'lucide-react';

import { tv } from '../../i18n';
import { warmupStickerSheet } from '../../lib/stickerSheetApi';
import { useStickerSheetStore, type StickerMaskTool } from './stickerSheetStore';
import { ToolNumberInput, ToolSectionLabel } from './ToolUI';


interface Props {
    tabId: string;
    onExport?: () => void;
    onExportPng?: () => void;
    isExporting?: boolean;
}

const TOOL_OPTIONS: Array<{ id: StickerMaskTool; label: string; hint: string }> = [
    { id: 'erase', label: 'Xóa bóng', hint: 'Quét lên phần bóng hoặc nền còn thừa.' },
    { id: 'restore', label: 'Giữ lại', hint: 'Chọn tem rồi quét lên chi tiết bị mất.' },
    { id: 'merge', label: 'Gộp với tem', hint: 'Chọn chi tiết rời, sau đó chọn tem chính.' },
];

function nextUncertainInstance(
    instances: Array<{ id: number; uncertain_ratio: number }>,
    selectedId: number | null,
): number | null {
    if (instances.length === 0) return null;
    const ordered = [...instances].sort((a, b) => b.uncertain_ratio - a.uncertain_ratio);
    const current = ordered.findIndex(instance => instance.id === selectedId);
    return ordered[(current + 1 + ordered.length) % ordered.length]?.id || null;
}

export default function StickerSheetPanel({ tabId, onExport, onExportPng, isExporting = false }: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const state = tab || useStickerSheetStore.getState().getTab(tabId);
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        actions.initTab(tabId);
        const controller = new AbortController();
        void warmupStickerSheet('birefnet-lite', controller.signal);
        return () => controller.abort();
    }, [actions, tabId]);

    const manifest = state.manifest;
    const physicalWidthMm = manifest
        ? manifest.original_width_px / Math.max(1, state.outputDpi) * 25.4
        : 0;
    const physicalHeightMm = manifest
        ? manifest.original_height_px / Math.max(1, state.outputDpiY) * 25.4
        : 0;

    return (
        <div className="flex flex-col gap-4">
            <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                className="hidden"
                onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) void actions.analyze(tabId, file);
                    event.currentTarget.value = '';
                }}
            />

            <div>
                <ToolSectionLabel>{tv('Ảnh nhiều tem')}</ToolSectionLabel>
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={state.status === 'analyzing'}
                    className="w-full h-10 rounded-lg border border-dashed border-violet-400 bg-violet-50 text-[12px] font-bold text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-300"
                >
                    {state.sourceFile ? state.sourceFile.name : tv('Chọn ảnh JPG hoặc PNG')}
                </button>
            </div>

            {state.status === 'analyzing' && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-[12px] text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300">
                    <span className="inline-block mr-2 h-3 w-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                    {tv('Đang nhận diện từng tem và loại bóng…')}
                </div>
            )}

            {state.error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
                    {state.error}
                </div>
            )}

            {manifest && state.status === 'ready' && (
                <>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
                        <div className="text-[13px] font-bold text-emerald-800 dark:text-emerald-300">
                            {tv('Đã nhận diện')} {manifest.instances.length} {tv('tem')}
                        </div>
                    </div>

                    <div>
                        <ToolSectionLabel>{tv('Sửa nhanh vùng tem')}</ToolSectionLabel>
                        <div className="grid grid-cols-3 gap-1.5">
                            {TOOL_OPTIONS.map(option => (
                                <button
                                    key={option.id}
                                    type="button"
                                    title={tv(option.hint)}
                                    aria-pressed={state.activeTool === option.id}
                                    onClick={() => actions.setActiveTool(tabId, option.id)}
                                    className={`min-h-10 rounded-lg border px-1.5 text-[10px] font-bold transition-colors ${
                                        state.activeTool === option.id
                                            ? 'border-violet-500 bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200'
                                            : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                                    }`}
                                >
                                    {tv(option.label)}
                                </button>
                            ))}
                        </div>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400">
                            {tv(TOOL_OPTIONS.find(option => option.id === state.activeTool)?.hint || '')}
                        </p>
                    </div>

                    {state.activeTool !== 'merge' && (
                        <label className="flex items-center gap-3 text-[11px] text-slate-600 dark:text-zinc-300">
                            <span className="shrink-0 font-semibold">{tv('Cỡ cọ')}</span>
                            <input
                                type="range"
                                min={0.003}
                                max={0.05}
                                step={0.001}
                                value={state.brushRadius}
                                onChange={event => actions.setBrushRadius(tabId, Number(event.target.value))}
                                className="min-w-0 flex-1 accent-violet-600"
                            />
                        </label>
                    )}

                    <div className="flex gap-1.5">
                        <button
                            type="button"
                            onClick={() => actions.undo(tabId)}
                            disabled={state.edits.length === 0}
                            className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-slate-200 text-[11px] font-semibold disabled:opacity-40 dark:border-zinc-700"
                        >
                            <Undo2 className="h-3.5 w-3.5" /> {tv('Hoàn tác')}
                        </button>
                        <button
                            type="button"
                            onClick={() => actions.redo(tabId)}
                            disabled={state.redoEdits.length === 0}
                            className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-slate-200 text-[11px] font-semibold disabled:opacity-40 dark:border-zinc-700"
                        >
                            <Redo2 className="h-3.5 w-3.5" /> {tv('Làm lại')}
                        </button>
                    </div>

                    <button
                        type="button"
                        onClick={() => actions.setSelectedInstance(
                            tabId,
                            nextUncertainInstance(manifest.instances, state.selectedInstanceId),
                        )}
                        className="h-9 rounded-lg border border-amber-300 bg-amber-50 text-[11px] font-bold text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                    >
                        {tv('Điểm cần kiểm tra tiếp theo')}
                    </button>

                    <div>
                        <ToolSectionLabel>{tv('Kích thước và đường cắt')}</ToolSectionLabel>
                        <div className="grid grid-cols-2 gap-2">
                            <ToolNumberInput
                                label={tv('Offset')}
                                value={state.offsetMm}
                                onChange={value => actions.setOutputSettings(tabId, { offsetMm: value })}
                                min={-10}
                                max={10}
                                step={0.1}
                                suffix="mm"
                            />
                            <ToolNumberInput
                                label={tv('Tràn lề')}
                                value={state.bleedMm}
                                onChange={value => actions.setOutputSettings(tabId, { bleedMm: Math.max(0, value) })}
                                min={0}
                                max={10}
                                step={0.5}
                                suffix="mm"
                            />
                        </div>
                        <p className="mt-2 text-[10px] text-slate-500 dark:text-zinc-400">
                            {tv('Khổ toàn ảnh')}: {physicalWidthMm.toFixed(1)} × {physicalHeightMm.toFixed(1)} mm
                        </p>
                        <p className="mt-1 text-[10px] text-slate-500 dark:text-zinc-400">
                            {tv('Ảnh gốc')}: {manifest.original_width_px} × {manifest.original_height_px} px · {tv('Không giảm độ phân giải; PNG trong suốt dùng nén không mất dữ liệu.')}
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={onExportPng}
                            disabled={!onExportPng || isExporting}
                            className="h-11 rounded-xl border border-violet-300 bg-white text-[11px] font-bold text-violet-700 shadow-sm hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300"
                        >
                            {tv('Lưu bộ PNG')}
                        </button>
                        <button
                            type="button"
                            onClick={onExport}
                            disabled={!onExport || isExporting}
                            className="h-11 rounded-xl bg-violet-600 px-2 text-[11px] font-bold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {isExporting ? tv('Đang tạo file…') : tv('Tạo PDF có đường cắt')}
                        </button>
                    </div>

                    <button
                        type="button"
                        onClick={() => actions.resetAnalysis(tabId)}
                        className="flex h-9 items-center justify-center gap-1.5 rounded-lg text-[11px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                        <RotateCcw className="h-3.5 w-3.5" /> {tv('Chọn ảnh khác')}
                    </button>
                </>
            )}
        </div>
    );
}
