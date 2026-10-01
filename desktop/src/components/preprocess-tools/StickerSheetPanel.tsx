import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Redo2, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { tv } from '../../i18n';
import { StickerBleedColorControl, StickerThruCutControl } from './StickerOutputSettingsPanel';
import {
    useStickerSheetStore,
    resolveStickerSheetAutoSimplifyMm,
    type PrepareStickerWorkspaceSource,
    type StickerMaskTool,
} from './stickerSheetStore';
import { ToolCollapsibleSection, ToolNumberInput, ToolSectionLabel } from './ToolUI';


interface Props {
    tabId: string;
    onExport?: () => void | Promise<void>;
    onExportPng?: () => void | Promise<void>;
    isExporting?: boolean;
    pageOrder?: number[];
    prepareWorkspaceSource?: PrepareStickerWorkspaceSource;
}

const TOOL_OPTIONS: Array<{ id: StickerMaskTool; label: string; hint: string }> = [
    { id: 'erase', label: 'Xóa bóng', hint: 'Quét lên phần bóng hoặc nền còn thừa.' },
    { id: 'restore', label: 'Giữ lại', hint: 'Chọn tem rồi quét lên chi tiết bị mất.' },
    { id: 'merge', label: 'Gộp với tem', hint: 'Chọn chi tiết rời, sau đó chọn tem chính.' },
];

const CORNER_STYLES = [
    { id: 'preserve', label: '🎯 Giữ nguyên' },
    { id: 'round', label: '🟢 Góc tròn' },
    { id: 'miter', label: '🔺 Góc nhọn' },
] as const;

function cutlineRoundRadiusMm(roundness: number): number {
    // QUALITY (feedback 2026-08-19 §CUTROUND.7): phải khớp helper backend.
    return Math.max(0, Math.min(100, roundness)) / 100 * 3;
}

function formatStageElapsed(milliseconds: number): string {
    const seconds = milliseconds / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export default function StickerSheetPanel({
    tabId,
    onExport,
    onExportPng,
    isExporting = false,
    pageOrder,
    prepareWorkspaceSource,
}: Props) {
    const { t } = useTranslation();
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const state = tab || useStickerSheetStore.getState().getTab(tabId);
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        actions.initTab(tabId);
    }, [actions, tabId]);

    const manifest = state.manifest;
    const sourcePreviewLoading = Boolean(state.inspection && !state.sourcePreviewReady);
    const hasMask = Boolean(manifest) && ['mask-review', 'confirming', 'mask-ready', 'exporting'].includes(state.status);
    const autoSimplifyMm = resolveStickerSheetAutoSimplifyMm(manifest, state.outputSettings.cutMode);
    const simplifyPending = state.isRefining || state.isCutlinePreviewing;
    const preview = state.cutlinePreview;
    // UIUX/QUALITY (audit 2026-09-28 §SHEET.AUTO): chỉ dùng tổng đã được
    // backend chốt cho đúng trang/revision. Số đo frame trước không phải
    // kết quả mới khi đang đổi thông số, sửa mask hoặc request bị lỗi.
    const previewSimplification = !simplifyPending && !state.error && manifest && preview
        && manifest.source_page === state.activeSourcePage
        && preview.page_number === state.activeSourcePage
        && preview.mask_revision === (manifest.mask_revision ?? 1)
        && preview.preview_width_px === manifest.preview_width_px
        && preview.preview_height_px === manifest.preview_height_px
        ? preview.quality?.simplification : null;
    const simplification = previewSimplification
        && Number.isInteger(previewSimplification.before_segments)
        && Number.isInteger(previewSimplification.after_segments)
        && previewSimplification.before_segments > 0
        && previewSimplification.after_segments > 0
        && previewSimplification.after_segments <= previewSimplification.before_segments
        && Number.isFinite(previewSimplification.maximum_error_bound_mm)
        && previewSimplification.maximum_error_bound_mm >= 0
        ? previewSimplification : null;
    const [settingsOpen, setSettingsOpen] = useState(state.status === 'mask-review');
    const [cutFirstPageOnly, setCutFirstPageOnly] = useState(false);
    const busy = state.isRefining
        || state.isCutlinePreviewing
        || ['inspecting', 'detecting', 'confirming', 'exporting'].includes(state.status);
    const hasEditHistory = state.edits.length > 0 || state.redoEdits.length > 0;
    const canRefinePreview = Boolean(
        manifest
        && manifest.boundary_source === 'ai'
        && manifest.refinement_available === true
        && state.status === 'mask-review',
    );
    // UIUX (feedback 2026-08-16): ba thanh này chỉnh Bézier đầu ra chung, không
    // phụ thuộc nguồn mask là AI hay vector; chỉ Khử bóng mới cần dữ liệu AI.
    const canTuneCutline = Boolean(
        manifest
        && manifest.boundary_source !== 'existing-cut'
        && state.status === 'mask-review',
    );
    const roundRadiusMm = cutlineRoundRadiusMm(state.curveTension);
    const pageCount = Math.max(
        1,
        state.inspection?.page_count || state.sourceImageCount || 1,
    );
    const pageStatus = (pageNumber: number) => (
        state.pages[pageNumber]?.status
        || (pageNumber === state.activeSourcePage ? state.status : 'source-ready')
    );
    const sourcePages = Array.from(
        { length: pageCount },
        (_unused, index) => index + 1,
    );
    const exportOrder = pageOrder?.length
        ? pageOrder.filter(pageNumber => pageNumber >= 1)
        : sourcePages;
    const exportPageCount = Math.max(1, exportOrder.length);
    const exportablePageCount = exportOrder
        .filter(pageNumber => ['mask-review', 'confirming', 'mask-ready', 'exporting']
            .includes(pageStatus(pageNumber))).length;
    const pendingPageCount = [...new Set(exportOrder)]
        .filter(pageNumber => ['idle', 'source-ready', 'error'].includes(pageStatus(pageNumber))).length;
    const allPagesExportable = exportablePageCount === exportPageCount;
    const canDetectActivePage = ['source-ready', 'error'].includes(state.status);
    // UIUX (feedback 2026-08-21 §CUTPREVIEW.MULTIPAGE1): PDF từ Viewer đã biết
    // pageOrder trước khi inspect; dùng danh sách đó để không ép quét từng trang.
    const visibleSourcePageCount = new Set(exportOrder).size;
    const canDetectAllPages = visibleSourcePageCount > 1 && pendingPageCount > 0;
    const stageLabel = state.status === 'inspecting'
        ? tv('Đang chuẩn bị preview gốc')
        : sourcePreviewLoading
            ? state.status === 'detecting'
                ? tv('Đang nhận diện từng tem · preview gốc đang tải nền')
                : tv('Đang tải preview gốc')
            : state.status === 'detecting'
                ? tv('Đang nhận diện từng tem và loại bóng')
                : state.status === 'confirming'
                    ? tv('Đang chuẩn bị vùng cắt')
                    : state.status === 'exporting'
                        ? tv('Đang xuất file')
                        : '';
    const [stageElapsedMs, setStageElapsedMs] = useState(0);
    useEffect(() => {
        if (!stageLabel) {
            setStageElapsedMs(0);
            return undefined;
        }
        const startedAt = Date.now();
        const tick = () => setStageElapsedMs(Date.now() - startedAt);
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [sourcePreviewLoading, stageLabel, state.inspection?.session_id, state.status]);

    useEffect(() => {
        // UIUX (feedback 2026-08-12 §AI.COMPACT1): sau khi xác nhận hoặc đang xuất,
        // thu cả thiết lập lẫn thao tác xuất; người dùng có thể xổ ra để xem lại.
        setSettingsOpen(state.status === 'mask-review');
    }, [state.status]);
    const prepareCutline = async () => {
        const pageNumber = state.activeSourcePage;
        // UIUX (audit 2026-08-15 §XEPTEM.1): auto thử CutContour/vector/Alpha/
        // nền đơn giản trước; AI chỉ là fallback khi các nhánh chắc chắn không đủ.
        await actions.detectStickers(
            tabId,
            'auto',
            pageNumber,
            prepareWorkspaceSource,
        );
        const detected = useStickerSheetStore.getState().getTab(tabId);
        const detectedPage = detected.pages[pageNumber]
            || (detected.activeSourcePage === pageNumber ? detected : null);
        if (
            detectedPage?.status === 'mask-review'
            && detectedPage.manifest
            && !detectedPage.manifest.needs_review
        ) {
            // UIUX (audit 2026-08-08 §UNIFIED.RECOVERY1): CutContour thật và Alpha sạch
            // đã có biên xác định; không bắt người dùng đi qua một bước "nhận diện" giả tạo.
            await actions.confirmMask(tabId, pageNumber);
        }
    };
    const finalizeMaskAndExport = async (callback?: () => void | Promise<void>) => {
        if (!callback) return;
        const pageNumbers = [...new Set(exportOrder)];
        for (const pageNumber of pageNumbers) {
            const latest = useStickerSheetStore.getState().getTab(tabId);
            const page = latest.pages[pageNumber]
                || (latest.activeSourcePage === pageNumber ? latest : null);
            if (page?.status === 'mask-review') {
                await actions.confirmMask(tabId, pageNumber);
            }
        }
        const latest = useStickerSheetStore.getState().getTab(tabId);
        const allConfirmed = pageNumbers.every(pageNumber => {
            const page = latest.pages[pageNumber]
                || (latest.activeSourcePage === pageNumber ? latest : null);
            return page?.status === 'mask-ready';
        });
        if (allConfirmed) await callback();
    };

    return (
        <div className="flex flex-col gap-4">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                className="hidden"
                onChange={event => {
                    const files = Array.from(event.target.files || []);
                    if (files.length > 0) void actions.selectSources(tabId, files);
                    event.currentTarget.value = '';
                }}
            />

            {!state.sourceFile && (
                <div>
                    <ToolSectionLabel>{tv('Ảnh nhiều tem')}</ToolSectionLabel>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy}
                        className="w-full h-10 rounded-lg border border-dashed border-teal-500/40 bg-teal-50/50 text-[12px] font-bold text-teal-700 hover:bg-teal-50 disabled:opacity-50 dark:border-teal-700/50 dark:bg-teal-950/20 dark:text-teal-300"
                    >
                        {tv('Chọn một hoặc nhiều ảnh')}
                    </button>
                </div>
            )}

            {stageLabel && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-[12px] text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300">
                    <div className="flex items-start gap-2">
                        <span className="mt-0.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                        <div className="min-w-0">
                            <div className="font-semibold">{stageLabel}</div>
                            <div className="text-[10px] text-indigo-600/90 dark:text-indigo-300/90">
                                {tv('Đã chờ')} {formatStageElapsed(stageElapsedMs)}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {state.error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
                    {state.error}
                </div>
            )}

            {state.sourceFile && (canDetectActivePage || canDetectAllPages) && (
                <div className={`grid gap-2 ${canDetectActivePage && canDetectAllPages ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {canDetectActivePage && (
                        <button
                            type="button"
                            onClick={() => { void prepareCutline(); }}
                            className="h-10 min-w-0 rounded-lg bg-indigo-600 px-3 text-[11px] font-bold text-white shadow-sm hover:bg-indigo-700"
                        >
                            {tv('Nhận diện trang hiện tại')}
                        </button>
                    )}
                    {canDetectAllPages && (
                        <button
                            type="button"
                            onClick={() => {
                                void actions.detectAllStickers(
                                    tabId,
                                    'auto',
                                    prepareWorkspaceSource,
                                );
                            }}
                            className="h-10 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-[11px] font-bold text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                        >
                            {tv('Nhận diện tất cả trang')} ({pendingPageCount})
                        </button>
                    )}
                </div>
            )}

            {manifest && hasMask && (
                <>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
                        <div className="text-[13px] font-bold text-emerald-800 dark:text-emerald-300">
                            {tv('Đã nhận diện')} {manifest.instances.length} {tv('tem')}
                        </div>
                    </div>

                    {autoSimplifyMm > 0 && (
                        <div data-testid="sticker-sheet-cutline-quality" role="status"
                            className="rounded-lg bg-teal-500/10 px-3 py-2 text-[10px] text-slate-600 dark:text-zinc-400">
                            <div className="mb-1 flex items-center justify-between gap-2 font-semibold">
                                <span>{t('preprocess.sticker:simplify_label')}</span>
                                <span className="text-teal-700 dark:text-teal-300">
                                    {t('preprocess.sticker:simplify_auto')}
                                </span>
                            </div>
                            <div>{simplifyPending
                                ? t('preprocess.sticker:simplify_pending')
                                : simplification
                                    ? t('preprocess.sticker:simplify_stats', {
                                        before: simplification.before_segments,
                                        after: simplification.after_segments,
                                        error: (Math.ceil(simplification.maximum_error_bound_mm * 1000) / 1000).toFixed(3),
                                    })
                                    : t('preprocess.sticker:simplify_unavailable')}</div>
                            {simplification?.changed === false && (
                                <div>{t('preprocess.sticker:simplify_unchanged')}</div>
                            )}
                        </div>
                    )}

                    {canTuneCutline && (
                        <div className="rounded-xl border border-slate-200 bg-white/70 p-3 dark:border-zinc-700 dark:bg-zinc-900/40">
                            <ToolSectionLabel>{tv('Xem và chỉnh đường bế', 'preprocess.stickerSheet')}</ToolSectionLabel>

                            {/* UIUX (audit 2026-09-28): Co/giãn viền và Kiểu góc theo chuẩn giao diện PDF/PNG có biên (StickerTool) */}
                            <div className="space-y-2 mb-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-[12.5px] font-semibold text-slate-600 dark:text-zinc-300">
                                        {tv('Co / giãn viền')}
                                    </span>
                                    {state.outputSettings.offsetMm !== 0 && (
                                        <div className="flex items-center gap-1.5 text-[11px]">
                                            <span className={`font-semibold ${
                                                state.outputSettings.offsetMm < 0
                                                    ? 'text-amber-600 dark:text-amber-400'
                                                    : 'text-teal-600 dark:text-teal-400'
                                            }`}>
                                                {state.outputSettings.offsetMm > 0
                                                    ? `+${state.outputSettings.offsetMm.toFixed(1)} mm (${tv('nới ra')})`
                                                    : `${state.outputSettings.offsetMm.toFixed(1)} mm (${tv('thu vào')})`}
                                            </span>
                                            <button
                                                type="button"
                                                title={tv('Đặt lại về 0 mm (chuẩn mép tem)')}
                                                onClick={() => actions.setOutputSettings(tabId, { offsetMm: 0 }, 0)}
                                                className="text-[10px] font-bold text-teal-600 hover:text-teal-800 dark:text-teal-400 underline"
                                            >
                                                {tv('Đặt lại')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="flex gap-2 items-end">
                                    <ToolNumberInput
                                        label={tv('Co / giãn viền')}
                                        hideLabel
                                        ariaLabel={tv('Co / giãn viền')}
                                        value={state.outputSettings.offsetMm}
                                        onChange={val => actions.setOutputSettings(tabId, { offsetMm: val }, 0)}
                                        suffix="mm"
                                        step={0.5}
                                        min={-10}
                                        max={10}
                                        className="w-[90px] shrink-0"
                                    />
                                    <label
                                        className={`flex-1 h-[36px] rounded-lg border px-3 flex items-center gap-2 cursor-pointer select-none transition-all ${
                                            cutFirstPageOnly
                                                ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50 text-slate-700 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 dark:text-zinc-300'
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={cutFirstPageOnly}
                                            onChange={(event) => setCutFirstPageOnly(event.target.checked)}
                                            className="peer sr-only"
                                        />
                                        <span
                                            aria-hidden="true"
                                            className={`h-[18px] w-[18px] shrink-0 rounded border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-zinc-900 ${
                                                cutFirstPageOnly
                                                    ? 'border-teal-600 bg-teal-600 text-white'
                                                    : 'border-slate-400 bg-white dark:border-zinc-500 dark:bg-zinc-950'
                                            }`}
                                        >
                                            {cutFirstPageOnly && (
                                                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <path d="M3 8.25 6.5 11.5 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                                                </svg>
                                            )}
                                        </span>
                                        <span className="min-w-0 flex-1 text-[11px] font-bold leading-tight">
                                            {t('preprocess.sticker:tao_duong_cat_cho_trang_dau_2')}
                                        </span>
                                        <span
                                            role="note"
                                            tabIndex={0}
                                            aria-label={t('preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon')}
                                            onClick={(event) => event.preventDefault()}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                }
                                            }}
                                            className="relative group/help ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current/25 bg-black/5 text-[10px] font-bold leading-none text-current/70 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 cursor-help"
                                        >
                                            ?
                                            <span
                                                role="tooltip"
                                                className="pointer-events-none absolute bottom-full right-0 z-[100] mb-2 w-max max-w-[280px] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[12px] font-normal leading-relaxed text-white opacity-0 shadow-xl transition-all invisible group-hover/help:visible group-hover/help:opacity-100 group-focus-within/help:visible group-focus-within/help:opacity-100 dark:bg-zinc-700 whitespace-normal break-words"
                                            >
                                                {t('preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon')}
                                                <span
                                                    aria-hidden="true"
                                                    className="absolute top-full right-2 -mt-1 h-2 w-2 rotate-45 bg-slate-800 dark:bg-zinc-700"
                                                />
                                            </span>
                                        </span>
                                    </label>
                                </div>

                                <div className="flex gap-1.5 pt-1">
                                    {CORNER_STYLES.map(option => (
                                        <button
                                            key={option.id}
                                            type="button"
                                            onClick={() => {
                                                const nextStyle = option.id;
                                                if (state.outputSettings.cornerStyle !== nextStyle) {
                                                    actions.setOutputSettings(tabId, { cornerStyle: nextStyle }, 0);
                                                }
                                                if (nextStyle === 'preserve') {
                                                    actions.setCutlineTuning(tabId, { tension: 0 });
                                                } else if (nextStyle === 'round' && state.curveTension === 0) {
                                                    actions.setCutlineTuning(tabId, { tension: 50 });
                                                }
                                            }}
                                            aria-pressed={state.outputSettings.cornerStyle === option.id}
                                            className={`flex-1 h-[32px] rounded border text-[12px] transition-all flex items-center justify-center font-bold ${
                                                state.outputSettings.cornerStyle === option.id
                                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                    : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                            }`}
                                        >
                                            {tv(option.label)}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {canRefinePreview && (
                                <div className="mb-3">
                                    <div className="mb-1.5 text-[11px] font-semibold text-slate-700 dark:text-zinc-200">
                                        {tv('Khử bóng')}
                                    </div>
                                    <div className="grid grid-cols-2 gap-1.5">
                                        {([
                                            ['off', 'Giữ nguyên'],
                                            ['auto', 'Tự động'],
                                        ] as const).map(([value, label]) => (
                                            <button
                                                key={value}
                                                type="button"
                                                aria-pressed={state.shadowCleanup === value}
                                                onClick={() => actions.setMaskTuning(tabId, { shadowCleanup: value })}
                                                className={`h-8 rounded-lg border text-[11px] font-bold transition-colors ${
                                                    state.shadowCleanup === value
                                                        ? 'border-teal-500 bg-teal-500/10 text-teal-700 shadow-sm dark:bg-zinc-900 dark:text-teal-300'
                                                        : 'border-slate-200 bg-white text-slate-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                                                }`}
                                            >
                                                {tv(label)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <ToolCollapsibleSection
                                title={t('preprocess.sticker:cutline_tuning_title')}
                                storageKey="sticker_sheet_tinh_chinh"
                                defaultOpen={true}
                            >
                                <section
                                    data-testid="sticker-cutline-tuning"
                                    className="pt-1"
                                >
                                    <div className="divide-y divide-slate-200/80 dark:divide-zinc-700/60">
                                        <div className="py-2.5 first:pt-0">
                                            <div className="mb-1.5 flex items-center justify-between gap-2">
                                                <label htmlFor="sticker-curve-tension" className="text-xs font-bold text-slate-700 dark:text-zinc-300">
                                                    {t('preprocess.stickerSheet:cutline_tension')}
                                                </label>
                                                <span className="shrink-0 text-xs font-bold tabular-nums text-teal-600 dark:text-teal-400">
                                                    {roundRadiusMm.toFixed(2)} mm
                                                </span>
                                            </div>
                                            <input
                                                id="sticker-curve-tension"
                                                type="range"
                                                aria-label={tv('Độ bo cong đường bế', 'preprocess.stickerSheet')}
                                                min={0}
                                                max={100}
                                                step={5}
                                                value={state.curveTension}
                                                disabled={!canTuneCutline}
                                                onChange={(event) => {
                                                    const roundness = Number(event.target.value);
                                                    if (state.outputSettings.cornerStyle !== 'round' && roundness > 0) {
                                                        actions.setOutputSettings(tabId, { cornerStyle: 'round' });
                                                    }
                                                    actions.setCutlineTuning(tabId, { tension: roundness });
                                                }}
                                                className="block w-full accent-teal-600 dark:accent-teal-400 disabled:opacity-50"
                                            />
                                        </div>

                                        <div className="py-2.5 first:pt-0">
                                            <div className="mb-1.5 flex items-center justify-between gap-2">
                                                <label htmlFor="sticker-cutline-denoise" className="text-xs font-bold text-slate-700 dark:text-zinc-300">
                                                    {t('preprocess.sticker:khu_rang_cua')}
                                                </label>
                                                <span className="shrink-0 text-xs font-bold tabular-nums text-teal-600 dark:text-teal-400">
                                                    {state.cutlineDenoise === 0
                                                        ? t('preprocess.sticker:khu_rang_cua_tat')
                                                        : `${Math.round(state.cutlineDenoise)}%`}
                                                </span>
                                            </div>
                                            <input
                                                id="sticker-cutline-denoise"
                                                type="range"
                                                aria-label={tv('Mức khử răng cưa đường bế', 'preprocess.stickerSheet')}
                                                min={0}
                                                max={100}
                                                step={5}
                                                value={state.cutlineDenoise}
                                                disabled={!canTuneCutline}
                                                onChange={(event) => actions.setCutlineTuning(
                                                    tabId,
                                                    { cutlineDenoise: Number(event.target.value) },
                                                )}
                                                className="block w-full accent-teal-600 dark:accent-teal-400 disabled:opacity-50"
                                            />
                                        </div>

                                        <div className="py-2.5 first:pt-0">
                                            <div className="mb-1.5 flex items-center justify-between gap-2">
                                                <label htmlFor="sticker-cutline-fidelity" className="text-xs font-bold text-slate-700 dark:text-zinc-300">
                                                    {tv('Bám sát hình gốc', 'preprocess.stickerSheet')}
                                                </label>
                                                <span className="shrink-0 text-xs font-bold tabular-nums text-teal-600 dark:text-teal-400">
                                                    {Math.round(state.cutlineFidelity)}%
                                                </span>
                                            </div>
                                            <input
                                                id="sticker-cutline-fidelity"
                                                type="range"
                                                aria-label={tv('Mức bám sát hình gốc', 'preprocess.stickerSheet')}
                                                min={0}
                                                max={100}
                                                step={1}
                                                value={state.cutlineFidelity}
                                                disabled={!canTuneCutline}
                                                onChange={(event) => {
                                                    const fidelity = Number(event.target.value);
                                                    if (state.outputSettings.cornerStyle !== 'round') {
                                                        actions.setOutputSettings(tabId, { cornerStyle: 'round' });
                                                    }
                                                    actions.setCutlineTuning(tabId, {
                                                        fidelity,
                                                        smoothness: Math.max(50, 100 - fidelity),
                                                    });
                                                }}
                                                className="block w-full accent-teal-600 dark:accent-teal-400 disabled:opacity-50"
                                            />
                                        </div>

                                        <div className="py-2.5 first:pt-0">
                                            <div className="mb-1.5 flex items-center justify-between gap-2">
                                                <label htmlFor="sticker-min-detail-area" className="text-xs font-bold text-slate-700 dark:text-zinc-300">
                                                    {tv('Lọc chi tiết rời', 'preprocess.stickerSheet')}
                                                </label>
                                                <span className="shrink-0 text-xs font-bold tabular-nums text-teal-600 dark:text-teal-400">
                                                    {state.minDetailAreaMm2.toFixed(1)} mm²
                                                </span>
                                            </div>
                                            <input
                                                id="sticker-min-detail-area"
                                                type="range"
                                                aria-label={tv('Mức lọc chi tiết rời', 'preprocess.stickerSheet')}
                                                min={0}
                                                max={5}
                                                step={0.1}
                                                value={state.minDetailAreaMm2}
                                                disabled={!canTuneCutline}
                                                onChange={(event) => actions.setCutlineTuning(
                                                    tabId,
                                                    { minDetailAreaMm2: Number(event.target.value) },
                                                )}
                                                className="block w-full accent-teal-600 dark:accent-teal-400 disabled:opacity-50"
                                            />
                                        </div>
                                    </div>
                                </section>
                            </ToolCollapsibleSection>

                            {state.isRefining ? (
                                <div className="mt-2 flex items-center text-[10px] font-semibold text-teal-700 dark:text-teal-300">
                                    <span className="mr-1.5 h-3 w-3 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
                                    {tv('Đang khử bóng…', 'preprocess.stickerSheet')}
                                </div>
                            ) : state.isCutlinePreviewing ? (
                                <div className="mt-2 flex items-center text-[10px] font-semibold text-teal-700 dark:text-teal-300">
                                    <span className="mr-1.5 h-3 w-3 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
                                    {tv('Đang cập nhật đường bế…', 'preprocess.stickerSheet')}
                                </div>
                            ) : (
                                <div className="mt-2 text-[10px] font-medium text-slate-500 dark:text-zinc-400">
                                    {tv('Đường màu tím là đường bế sẽ xuất.', 'preprocess.stickerSheet')}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="rounded-xl border border-slate-200 bg-white/70 dark:border-zinc-700 dark:bg-zinc-900/40">
                        <button
                            type="button"
                            aria-expanded={settingsOpen}
                            aria-controls={`sticker-settings-${tabId}`}
                            onClick={() => setSettingsOpen(open => !open)}
                            className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left"
                        >
                            <span className="text-[13px] font-bold uppercase tracking-wide text-slate-800 dark:text-zinc-100">
                                {tv('Thiết lập bù xén', 'preprocess.stickerSheet')}
                            </span>
                            <span className="flex items-center gap-2 text-[10px] font-semibold text-slate-500 dark:text-zinc-400">
                                {settingsOpen
                                    ? tv('Thu gọn', 'preprocess.stickerSheet')
                                    : tv('Xem lại / chỉnh sửa', 'preprocess.stickerSheet')}
                                <ChevronDown
                                    aria-hidden="true"
                                    className={`h-4 w-4 transition-transform duration-200 ${settingsOpen ? 'rotate-180' : ''}`}
                                />
                            </span>
                        </button>

                        {settingsOpen && (
                            <div
                                id={`sticker-settings-${tabId}`}
                                className="space-y-4 border-t border-slate-200 px-3 pb-3 pt-3 dark:border-zinc-700"
                            >
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
                                                disabled={busy}
                                                className={`min-h-10 rounded-lg border px-1.5 text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                                    state.activeTool === option.id
                                                        ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                        : 'border-slate-200 bg-white text-slate-600 hover:border-teal-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
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

                    {/* UIUX (feedback 2026-08-10 §AI.HISTORY1): chỉ bày lịch sử sau
                        khi người dùng đã sửa vùng tem; Ctrl+Z/Y vẫn hoạt động như cũ. */}
                    {(state.activeTool !== 'merge' || hasEditHistory) && (
                        <div className="flex items-center gap-2">
                            {state.activeTool !== 'merge' && (
                                <label className="flex min-w-0 flex-1 items-center gap-3 text-[11px] text-slate-600 dark:text-zinc-300">
                                    <span className="shrink-0 font-semibold">{tv('Cỡ cọ')}</span>
                                    <input
                                        type="range"
                                        min={0.003}
                                        max={0.05}
                                        step={0.001}
                                        value={state.brushRadius}
                                        onChange={event => actions.setBrushRadius(tabId, Number(event.target.value))}
                                        disabled={busy}
                                        className="min-w-0 flex-1 accent-teal-600 dark:accent-teal-400"
                                    />
                                </label>
                            )}

                            {hasEditHistory && (
                                <div
                                    role="group"
                                    aria-label={tv('Hoàn tác') + ' / ' + tv('Làm lại')}
                                    className="ml-auto flex shrink-0 gap-1"
                                >
                                    <button
                                        type="button"
                                        aria-label={tv('Hoàn tác')}
                                        title={tv('Hoàn tác') + ' (Ctrl+Z)'}
                                        onClick={() => actions.undo(tabId)}
                                        disabled={busy || state.edits.length === 0}
                                        className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                    >
                                        <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={tv('Làm lại')}
                                        title={tv('Làm lại') + ' (Ctrl+Y)'}
                                        onClick={() => actions.redo(tabId)}
                                        disabled={busy || state.redoEdits.length === 0}
                                        className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                    >
                                        <Redo2 aria-hidden="true" className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                                <div>
                                    <ToolSectionLabel>{tv('Kích thước và đường cắt')}</ToolSectionLabel>
                                    <div className="grid grid-cols-2 gap-2">
                                        <ToolNumberInput
                                            label={tv('Offset')}
                                            value={state.outputSettings.offsetMm}
                                            onChange={value => actions.setOutputSettings(tabId, { offsetMm: value })}
                                            min={-10}
                                            max={10}
                                            step={0.1}
                                            suffix="mm"
                                        />
                                        <ToolNumberInput
                                            label={tv('Tràn lề')}
                                            value={state.outputSettings.bleedMm}
                                            onChange={value => actions.setOutputSettings(tabId, { bleedMm: Math.max(0, value) })}
                                            min={0}
                                            max={10}
                                            step={0.5}
                                            suffix="mm"
                                        />
                                    </div>
                                    {/* UIUX (feedback 2026-09-07 §AI.BLEED0): không có tràn lề
                                        thì không có vùng tô màu; giữ lựa chọn khi tăng lại độ rộng. */}
                                    {state.outputSettings.bleedMm > 0 && <StickerBleedColorControl
                                        value={state.outputSettings}
                                        onChange={next => actions.setOutputSettings(tabId, next)}
                                        disabled={busy || isExporting}
                                        className="mt-3"
                                    />}
                                    <StickerThruCutControl
                                        value={state.outputSettings}
                                        onChange={next => actions.setOutputSettings(tabId, next)}
                                        disabled={busy || isExporting}
                                        className="mt-3"
                                    />
                                </div>

                                <div>
                                    <ToolSectionLabel>{tv('Cách tạo PDF')}</ToolSectionLabel>
                                    <div
                                        role="group"
                                        aria-label={tv('Cách tạo PDF')}
                                        className="grid grid-cols-2 gap-2"
                                    >
                                        <button
                                            type="button"
                                            aria-label={tv('Giữ nguyên tấm')}
                                            aria-pressed={!state.outputSettings.cropToSticker}
                                            onClick={() => actions.setOutputSettings(tabId, { cropToSticker: false })}
                                            disabled={busy || isExporting}
                                            className={`min-h-14 rounded-xl border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                                !state.outputSettings.cropToSticker
                                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300 font-semibold'
                                                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                                            }`}
                                        >
                                            <span className="block text-[11px] font-bold">{tv('Giữ nguyên tấm')}</span>
                                            <span className="mt-0.5 block text-[9px] font-medium opacity-75">{tv('Một trang, giữ vị trí và đường cắt từng tem')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={tv('Tách từng tem')}
                                            aria-pressed={state.outputSettings.cropToSticker}
                                            onClick={() => actions.setOutputSettings(tabId, { cropToSticker: true })}
                                            disabled={busy || isExporting}
                                            className={`min-h-14 rounded-xl border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                                state.outputSettings.cropToSticker
                                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300 font-semibold'
                                                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                                            }`}
                                        >
                                            <span className="block text-[11px] font-bold">{tv('Tách từng tem')}</span>
                                            <span className="mt-0.5 block text-[9px] font-medium opacity-75">{tv('Mỗi tem là một trang PDF riêng')}</span>
                                        </button>
                                    </div>
                                </div>

                                <div className="border-t border-slate-200 pt-4 dark:border-zinc-700">
                                    <ToolSectionLabel>{tv('Kết quả')}</ToolSectionLabel>
                                    <div className="grid grid-cols-2 gap-2">
                                        <button
                                            type="button"
                                            onClick={() => { void finalizeMaskAndExport(onExportPng); }}
                                            disabled={!onExportPng || busy || isExporting || !allPagesExportable}
                                            className="h-11 rounded-xl border border-slate-300 bg-white text-[11px] font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                                        >
                                            {tv('Lưu bộ PNG')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { void finalizeMaskAndExport(onExport); }}
                                            disabled={!onExport || busy || isExporting || !allPagesExportable}
                                            className="h-11 rounded-xl bg-indigo-600 px-2 text-[11px] font-bold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {isExporting ? tv('Đang tạo file…') : tv('Tạo PDF có đường cắt')}
                                        </button>
                                    </div>
                                    {!allPagesExportable && (
                                        <p className="mt-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                                            {exportPageCount - exportablePageCount} {tv('trang còn cần nhận diện trước khi xuất.')}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                </>
            )}
        </div>
    );
}
