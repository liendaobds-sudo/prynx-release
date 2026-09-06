import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Redo2, Undo2 } from 'lucide-react';

import { tv } from '../../i18n';
import StickerOutputSettingsPanel, { StickerBleedColorControl } from './StickerOutputSettingsPanel';
import type { StickerDetectionStrategy } from '../../lib/stickerSheetApi';
import {
    useStickerSheetStore,
    type PrepareStickerWorkspaceSource,
    type StickerMaskTool,
} from './stickerSheetStore';
import { ToolNumberInput, ToolSectionLabel } from './ToolUI';


interface Props {
    tabId: string;
    onExport?: () => void | Promise<void>;
    onExportPng?: () => void | Promise<void>;
    isExporting?: boolean;
    pageOrder?: number[];
    prepareWorkspaceSource?: PrepareStickerWorkspaceSource;
    unified?: boolean;
    interactionLocked?: boolean;
    selectionControl?: ReactNode;
}

const TOOL_OPTIONS: Array<{ id: StickerMaskTool; label: string; hint: string }> = [
    { id: 'erase', label: 'Xóa bóng', hint: 'Quét lên phần bóng hoặc nền còn thừa.' },
    { id: 'restore', label: 'Giữ lại', hint: 'Chọn tem rồi quét lên chi tiết bị mất.' },
    { id: 'merge', label: 'Gộp với tem', hint: 'Chọn chi tiết rời, sau đó chọn tem chính.' },
];

function cutlineRoundRadiusMm(roundness: number): number {
    // QUALITY (feedback 2026-08-19 §CUTROUND.7): phải khớp helper backend.
    return Math.max(0, Math.min(100, roundness)) / 100 * 3;
}

function formatStageElapsed(milliseconds: number): string {
    const seconds = milliseconds / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

interface CutlineSliderProps {
    label: string;
    ariaLabel: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    valueLabel: string;
    lowLabel: string;
    highLabel: string;
    disabled: boolean;
    onChange: (value: number) => void;
}

function CutlineSlider({
    label,
    ariaLabel,
    value,
    min = 0,
    max = 100,
    step = 1,
    valueLabel,
    lowLabel,
    highLabel,
    disabled,
    onChange,
}: CutlineSliderProps) {
    return (
        <label className="block">
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-700 dark:text-zinc-200">
                <span>{tv(label, 'preprocess.stickerSheet')}</span>
                <span className="text-[10px] font-bold text-violet-700 dark:text-violet-300">
                    {valueLabel}
                </span>
            </div>
            <input
                type="range"
                aria-label={tv(ariaLabel, 'preprocess.stickerSheet')}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={event => onChange(Number(event.target.value))}
                disabled={disabled}
                className="w-full accent-violet-600"
            />
            <div className="mt-0.5 flex justify-between text-[9px] text-slate-500 dark:text-zinc-400">
                <span>{tv(lowLabel, 'preprocess.stickerSheet')}</span>
                <span>{tv(highLabel, 'preprocess.stickerSheet')}</span>
            </div>
        </label>
    );
}

export default function StickerSheetPanel({
    tabId,
    onExport,
    onExportPng,
    isExporting = false,
    pageOrder,
    prepareWorkspaceSource,
    unified = false,
    interactionLocked = false,
    selectionControl,
}: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const state = tab || useStickerSheetStore.getState().getTab(tabId);
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const strategy: StickerDetectionStrategy = state.detectionStrategy === 'page-box' ? 'auto' : state.detectionStrategy || 'auto';

    useEffect(() => {
        actions.initTab(tabId);
        if (unified) actions.enableUnified(tabId);
    }, [actions, tabId, unified]);

    const manifest = state.manifest;
    const sourcePreviewLoading = Boolean(state.inspection && !state.sourcePreviewReady);
    const hasMask = Boolean(manifest) && ['mask-review', 'confirming', 'mask-ready', 'exporting'].includes(state.status);
    const [settingsOpen, setSettingsOpen] = useState(unified || state.status === 'mask-review');
    const [maskToolsOpen, setMaskToolsOpen] = useState(false);
    const [refreshingBackground, setRefreshingBackground] = useState(false);
    const preserveOriginal = Boolean(manifest?.boundary_source === 'existing-cut' && state.preserveExistingCut);
    const canChangeBackground = state.outputSettings.cutMode !== 'alpha' && !preserveOriginal
        && manifest?.vector_geometry_ref?.kind !== 'pdf-object-selection';
    const busy = interactionLocked || refreshingBackground || state.isRefining
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
        && !state.whiteBackgroundStale
        && (unified ? !preserveOriginal : manifest.boundary_source !== 'existing-cut')
        && (state.status === 'mask-review' || unified && state.status === 'mask-ready'),
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
        .filter(pageNumber => !state.pages[pageNumber]?.whiteBackgroundStale
            && !(pageNumber === state.activeSourcePage && state.whiteBackgroundStale)
            && ['mask-review', 'confirming', 'mask-ready', 'exporting'].includes(pageStatus(pageNumber))).length;
    const pendingPageCount = [...new Set(exportOrder)]
        .filter(pageNumber => state.pages[pageNumber]?.whiteBackgroundStale
            || pageNumber === state.activeSourcePage && state.whiteBackgroundStale
            || ['idle', 'source-ready', 'error'].includes(pageStatus(pageNumber))).length;
    const allPagesExportable = exportablePageCount === exportPageCount;
    const canDetectActivePage = ['source-ready', 'error'].includes(state.status) || unified && hasMask;
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
        if (!unified) setSettingsOpen(state.status === 'mask-review');
    }, [state.status, unified]);
    const prepareCutline = async () => {
        if (busy) return;
        if (unified && state.edits.length && !window.confirm(tv('Thay vùng tem sẽ bỏ nét sửa trên trang này. Tiếp tục?'))) return;
        const pageNumber = state.activeSourcePage;
        // UIUX (audit 2026-08-15 §XEPTEM.1): auto thử CutContour/vector/Alpha/
        // nền đơn giản trước; AI chỉ là fallback khi các nhánh chắc chắn không đủ.
        await actions.detectStickers(
            tabId,
            unified ? strategy : 'auto',
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
            if (page?.whiteBackgroundStale) return;
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

    const refreshBackgroundMasks = async () => {
        const current = actions.getTab(tabId);
        const pages = Object.keys(current.pages).length ? current.pages : { [current.activeSourcePage]: current };
        const stale = Object.entries(pages).filter(([, page]) => page.manifest && page.whiteBackgroundStale);
        if (!stale.length) return;
        setRefreshingBackground(true);
        try {
            await Promise.all(stale.map(async ([number]) => {
                const pageNumber = Number(number);
                await actions.detectStickers(tabId, current.detectionStrategy || 'auto', pageNumber, prepareWorkspaceSource);
                const latest = actions.getTab(tabId);
                const page = latest.pages[pageNumber] || latest;
                if (!page.whiteBackgroundStale && page.status === 'mask-review' && !page.error
                    && page.manifest && !page.manifest.needs_review) {
                    await actions.confirmMask(tabId, pageNumber);
                }
            }));
        } finally {
            setRefreshingBackground(false);
        }
    };

    const confirmBackgroundChange = () => {
        const current = actions.getTab(tabId);
        const pages = Object.keys(current.pages).length ? Object.values(current.pages) : [current];
        const hasEdits = pages.some(page => page.manifest?.vector_geometry_ref?.kind !== 'pdf-object-selection'
            && !(page.preserveExistingCut && page.manifest?.boundary_source === 'existing-cut')
            && page.edits.length > 0);
        return !hasEdits || window.confirm(tv('Đổi xử lý nền sẽ bỏ nét sửa trên các trang. Tiếp tục?'));
    };

    const backgroundControl = unified && (
        <label className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border px-2 text-[11px] font-bold ${
            canChangeBackground && state.removeWhiteBg !== false
                ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                : 'border-slate-200 text-slate-600 dark:border-white/10 dark:text-zinc-400'
        } ${!canChangeBackground ? 'opacity-50' : ''}`}
            title={!canChangeBackground ? tv('Đang dùng biên có sẵn hoặc vùng tem chọn tay.') : undefined}>
            <input type="checkbox" checked={canChangeBackground && state.removeWhiteBg !== false}
                disabled={busy || isExporting || !canChangeBackground}
                onChange={event => {
                    if (!confirmBackgroundChange()) return;
                    if (actions.setRemoveWhiteBg(tabId, event.target.checked)) void refreshBackgroundMasks();
                }} className="accent-teal-600" />
            <span>{tv('Bỏ nền trắng', 'preprocess.sticker')}</span>
        </label>
    );

    return (
        <div className="flex flex-col gap-4">
            {/* UIUX (feedback 2026-09-06): workspace dùng tài liệu đang mở, không có bộ đổi file riêng. */}
            {!unified && <input
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
            />}

            {!unified && !state.sourceFile && (
                <div>
                    <ToolSectionLabel>{tv('Ảnh nhiều tem')}</ToolSectionLabel>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy}
                        className="w-full h-10 rounded-lg border border-dashed border-violet-400 bg-violet-50 text-[12px] font-bold text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-300"
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
                    {unified && ['inspecting', 'detecting'].includes(state.status) && (
                        <button type="button" className="mt-2 text-xs font-semibold underline"
                            onClick={() => actions.cancelDetection(tabId)}>{tv('Hủy nhận diện')}</button>
                    )}
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
                            disabled={busy}
                            onClick={() => { void prepareCutline(); }}
                            className="h-10 min-w-0 rounded-lg bg-violet-600 px-3 text-[11px] font-bold text-white shadow-sm hover:bg-violet-700"
                        >
                            {tv(state.detectionRetry ? 'Thử lại'
                                : unified && hasMask ? 'Nhận diện lại'
                                : unified && visibleSourcePageCount <= 1 ? 'Nhận diện tự động' : 'Nhận diện trang hiện tại')}
                        </button>
                    )}
                    {canDetectAllPages && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                void actions.detectAllStickers(
                                    tabId,
                                    unified ? strategy : 'auto',
                                    prepareWorkspaceSource,
                                );
                            }}
                            className="h-10 min-w-0 rounded-lg border border-violet-300 bg-white px-2 text-[11px] font-bold text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300"
                        >
                            {tv('Nhận diện tất cả trang')} ({pendingPageCount})
                        </button>
                    )}
                </div>
            )}

            {selectionControl}

            {unified && (
                <>
                    <details className="rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
                        <summary className="cursor-pointer text-xs font-semibold">{tv('Nhận diện nâng cao')}</summary>
                        <label className="mt-2 block text-xs">
                            {tv('Cách lấy biên tem')}
                            <select className="mt-1 h-9 w-full rounded border bg-white px-2 dark:bg-zinc-900"
                                aria-label={tv('Cách lấy biên tem')} value={state.outputSettings.cutMode === 'alpha' ? 'alpha' : strategy}
                                disabled={busy || state.removeWhiteBg === false || state.outputSettings.cutMode === 'alpha'}
                                onChange={event => actions.setDetectionStrategy(tabId, event.target.value as StickerDetectionStrategy)}>
                                <option value="auto">{tv('Tự động')}</option>
                                <option value="alpha">{tv('Dùng Alpha')}</option>
                                <option value="simple-bg">{tv('Dùng nền đơn giản')}</option>
                                <option value="ai">{tv('Dùng AI')}</option>
                            </select>
                        </label>
                    </details>
                    {preserveOriginal && (
                        <div role="note" className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                            {tv('Đang giữ đường cắt vector có sẵn. Thay thiết lập sẽ tạo lại đường cắt.')}
                            <button type="button" disabled={busy} className="mt-2 block font-bold underline"
                                onClick={() => actions.setPreserveExistingCut(tabId, false)}>{tv('Tạo lại đường cắt')}</button>
                        </div>
                    )}
                    {manifest?.source_kind === 'pdf' && !preserveOriginal && state.outputSettings.cropToSticker && (
                        <p role="note" className="text-[11px] text-slate-500">
                            {tv('Tách tem: nội dung PDF được xuất thành ảnh.')}
                        </p>
                    )}
                    <div className="rounded-xl border border-slate-200 p-3 dark:border-zinc-700">
                        <StickerOutputSettingsPanel value={state.outputSettings}
                            onChange={settings => {
                                const changesMaskMode = (settings.cutMode === 'alpha') !== (state.outputSettings.cutMode === 'alpha');
                                if (changesMaskMode && !confirmBackgroundChange()) return;
                                actions.setOutputSettings(tabId, settings);
                                if (changesMaskMode) void refreshBackgroundMasks();
                            }}
                            disabled={busy || isExporting} showCropControl={false} backgroundControl={backgroundControl} />
                    </div>
                </>
            )}

            {manifest && hasMask && (
                <>
                    {!unified && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
                        <div className="text-[13px] font-bold text-emerald-800 dark:text-emerald-300">
                            {tv('Đã nhận diện')} {manifest.instances.length} {tv('tem')}
                        </div>
                    </div>}
                    {unified && <button type="button" aria-expanded={maskToolsOpen}
                        disabled={busy || state.whiteBackgroundStale}
                        className="text-left text-xs font-semibold" onClick={() => {
                            setMaskToolsOpen(open => !open);
                            actions.setMaskEditingEnabled(tabId, !maskToolsOpen);
                        }}>
                        {tv('Tinh chỉnh đường cắt và sửa vùng tem')}
                    </button>}
                    {canTuneCutline && (!unified || maskToolsOpen) && (
                        <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-3 dark:border-violet-800 dark:bg-violet-950/20">
                            <ToolSectionLabel>{tv('Xem và chỉnh đường bế', 'preprocess.stickerSheet')}</ToolSectionLabel>
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
                                                className={`h-9 rounded-lg border text-[11px] font-bold transition-colors ${
                                                    state.shadowCleanup === value
                                                        ? 'border-violet-500 bg-white text-violet-700 shadow-sm dark:bg-zinc-900 dark:text-violet-300'
                                                        : 'border-violet-200 bg-violet-50 text-slate-600 dark:border-violet-900 dark:bg-violet-950/20 dark:text-zinc-300'
                                                }`}
                                            >
                                                {tv(label)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="space-y-3">
                                {/* §CUTJAG.3: mask của mô hình gần như nhị phân (đo được:
                                    chỉ 2,06% pixel trung gian) nên marching-squares chỉ
                                    trả về bậc thang pixel. Thanh này làm mượt mask TRƯỚC
                                    khi dựng đường bế — đứng đầu nhóm vì nó tác động lên
                                    đầu vào của ba thanh còn lại. */}
                                <CutlineSlider
                                    label="Khử răng cưa"
                                    ariaLabel="Mức khử răng cưa đường bế"
                                    value={state.cutlineDenoise}
                                    step={5}
                                    valueLabel={state.cutlineDenoise === 0
                                        ? tv('Tắt', 'preprocess.stickerSheet')
                                        : `${Math.round(state.cutlineDenoise)}%`}
                                    lowLabel="Giữ nguyên biên"
                                    highLabel="Mượt hơn"
                                    disabled={!canTuneCutline}
                                    onChange={cutlineDenoise => actions.setCutlineTuning(
                                        tabId,
                                        { cutlineDenoise },
                                    )}
                                />
                                <CutlineSlider
                                    label="Bám sát hình gốc"
                                    ariaLabel="Mức bám sát hình gốc"
                                    value={state.cutlineFidelity}
                                    valueLabel={`${Math.round(state.cutlineFidelity)}%`}
                                    lowLabel="Mượt hơn"
                                    highLabel="Bám sát"
                                    disabled={!canTuneCutline}
                                    onChange={fidelity => {
                                        // UIUX (audit 2026-08-10 §CUTROUND.3): cùng một
                                        // thao tác tạo fairing và dùng Join Round khi có Offset.
                                        actions.setOutputSettings(tabId, { cornerStyle: 'round' });
                                        actions.setCutlineTuning(tabId, {
                                            fidelity,
                                            smoothness: Math.max(50, 100 - fidelity),
                                        });
                                    }}
                                />
                                <CutlineSlider
                                    label="Độ bo cong"
                                    ariaLabel="Độ bo cong đường bế"
                                    value={state.curveTension}
                                    valueLabel={`${roundRadiusMm.toFixed(2)} mm`}
                                    lowLabel="Ít bo"
                                    highLabel="Bo tròn"
                                    disabled={!canTuneCutline}
                                    onChange={roundness => {
                                        actions.setOutputSettings(tabId, { cornerStyle: 'round' });
                                        actions.setCutlineTuning(tabId, { tension: roundness });
                                    }}
                                />
                                <CutlineSlider
                                    label="Lọc chi tiết rời"
                                    ariaLabel="Mức lọc chi tiết rời"
                                    value={state.minDetailAreaMm2}
                                    min={0}
                                    max={5}
                                    step={0.1}
                                    valueLabel={`${state.minDetailAreaMm2.toFixed(1)} mm²`}
                                    lowLabel="Giữ chi tiết nhỏ"
                                    highLabel="Lọc mạnh"
                                    disabled={!canTuneCutline}
                                    onChange={minDetailAreaMm2 => actions.setCutlineTuning(
                                        tabId,
                                        { minDetailAreaMm2 },
                                    )}
                                />
                            </div>

                            {state.isRefining ? (
                                <div className="mt-2 flex items-center text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                                    <span className="mr-1.5 h-3 w-3 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
                                    {tv('Đang khử bóng…', 'preprocess.stickerSheet')}
                                </div>
                            ) : state.isCutlinePreviewing ? (
                                <div className="mt-2 flex items-center text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                                    <span className="mr-1.5 h-3 w-3 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
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
                        {!unified && <button
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
                        </button>}

                        {(unified || settingsOpen) && (
                            <div
                                id={`sticker-settings-${tabId}`}
                                className="space-y-4 border-t border-slate-200 px-3 pb-3 pt-3 dark:border-zinc-700"
                            >
                                {(!unified || maskToolsOpen) && <div>
                                    <ToolSectionLabel>{tv('Sửa nhanh vùng tem')}</ToolSectionLabel>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {TOOL_OPTIONS.map(option => (
                                            <button
                                                key={option.id}
                                                type="button"
                                                title={tv(option.hint)}
                                                aria-pressed={state.activeTool === option.id}
                                                onClick={() => actions.setActiveTool(tabId, option.id)}
                                                disabled={busy || unified && preserveOriginal}
                                                className={`min-h-10 rounded-lg border px-1.5 text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
                                </div>}

                    {/* UIUX (feedback 2026-08-10 §AI.HISTORY1): chỉ bày lịch sử sau
                        khi người dùng đã sửa vùng tem; Ctrl+Z/Y vẫn hoạt động như cũ. */}
                    {(!unified || maskToolsOpen) && (state.activeTool !== 'merge' || hasEditHistory) && (
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
                                        className="min-w-0 flex-1 accent-violet-600"
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

                                {!unified && <div>
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
                                    {/* UIUX (feedback 2026-08-11 §AI.BLEED1): độ rộng và cách
                                        sinh màu tràn lề phải cùng hiển thị, không dùng mặc định ẩn. */}
                                    <StickerBleedColorControl
                                        value={state.outputSettings}
                                        onChange={next => actions.setOutputSettings(tabId, next)}
                                        disabled={busy || isExporting}
                                        className="mt-3"
                                    />
                                </div>}

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
                                                    ? 'border-violet-500 bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200'
                                                    : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
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
                                                    ? 'border-violet-500 bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200'
                                                    : 'border-slate-200 bg-white text-slate-600 hover:border-violet-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
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
                                            className="h-11 rounded-xl border border-violet-300 bg-white text-[11px] font-bold text-violet-700 shadow-sm hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300"
                                        >
                                            {tv('Lưu bộ PNG')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { void finalizeMaskAndExport(onExport); }}
                                            disabled={!onExport || busy || isExporting || !allPagesExportable}
                                            className="h-11 rounded-xl bg-violet-600 px-2 text-[11px] font-bold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
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
