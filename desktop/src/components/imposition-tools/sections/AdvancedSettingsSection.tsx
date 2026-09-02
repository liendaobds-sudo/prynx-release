import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { useShallow } from 'zustand/react/shallow';
import { Divider, inputCls, Checkbox } from '../SharedUI';
import { DEFAULT_MATERIALS, DEFAULT_REPORT_CONFIG, LAMINATION_OPTIONS, PREDEFINED_SIZES, type NupSettings, type PontConfig, type ReportDisplayConfig, type ReportFieldKey } from '../types';
import type { SavePrintConfig } from '../store/slices/cncSlice';
import { buildReportPreview } from '../../../lib/reportPreview';
import { impositionDimensionTrace } from '../../../lib/previewPerfLog';
import { useTranslation } from 'react-i18next';
import { tv } from '../../../i18n';
import BookReportSettings from './BookReportSettings';
import { resolveImpositionModes } from '../pageSheetPolicy';
import { resolveStickerCutControlPolicy } from '../shapeDetectionPolicy';
import { canUseCutBorder } from '../cutBorderPolicy';
import { formatSizeMm } from '../../../lib/measurementFormat';

const REPORT_FIELD_LABELS: Record<ReportFieldKey, string> = {
    orderCode: 'Mã đơn hàng', identifier: 'Mẫu/Trang', gangCount: 'Số mẫu ghép',
    labelName: 'Tên nhãn',
    material: 'Chất liệu', lamination: 'Cán màng', labelsPerSheet: 'SL/tờ',
    actualQty: 'SL thực', sheetCount: 'Số tờ cần in', dimensions: 'Kích thước',
    paperSize: 'Khổ giấy', cutFileRef: 'File bế', modeLabel: 'Chế độ',
};
type ReportShowFlag = keyof Pick<ReportDisplayConfig, 'showIdentifier' | 'showGangCount' | 'showLabelName' | 'showMaterial' | 'showLamination' | 'showLabelsPerSheet' | 'showActualQty' | 'showSheetCount' | 'showDimensions' | 'showPaperSize' | 'showModeLabel'>;
type PontPreset = { name: string; config?: PontConfig };
const REPORT_SHOW_KEYS: Array<[ReportShowFlag | '', ReportFieldKey]> = [
    ['', 'orderCode'], ['showIdentifier', 'identifier'], ['showGangCount', 'gangCount'], ['showLabelName', 'labelName'], ['showMaterial', 'material'],
    ['showLamination', 'lamination'], ['showLabelsPerSheet', 'labelsPerSheet'], ['showActualQty', 'actualQty'],
    ['showSheetCount', 'sheetCount'], ['showDimensions', 'dimensions'], ['showPaperSize', 'paperSize'],
    ['showModeLabel', 'modeLabel'],
];
const REPORT_SHOW_FLAG = Object.fromEntries(
    REPORT_SHOW_KEYS.map(([flag, key]) => [key, flag]),
) as Record<ReportFieldKey, ReportShowFlag | ''>;

function orderedReportControls(fieldOrder: ReportFieldKey[]): Array<[ReportShowFlag | '', ReportFieldKey]> {
    const available = new Set(REPORT_SHOW_KEYS.map(([, key]) => key));
    const ordered: ReportFieldKey[] = [];
    for (const key of fieldOrder || []) {
        if (available.delete(key)) ordered.push(key);
    }
    for (const [, key] of REPORT_SHOW_KEYS) {
        if (available.delete(key)) ordered.push(key);
    }
    return ordered.map(key => [REPORT_SHOW_FLAG[key], key]);
}

function moveReportField(fieldOrder: ReportFieldKey[], key: ReportFieldKey, direction: -1 | 1): ReportFieldKey[] {
    const fullOrder: ReportFieldKey[] = [];
    const seen = new Set<ReportFieldKey>();
    for (const field of fieldOrder || []) {
        if (!seen.has(field)) {
            seen.add(field);
            fullOrder.push(field);
        }
    }
    for (const field of DEFAULT_REPORT_CONFIG.fieldOrder) {
        if (!seen.has(field)) {
            seen.add(field);
            fullOrder.push(field);
        }
    }

    const visibleOrder = orderedReportControls(fullOrder).map(([, field]) => field);
    const fromVisible = visibleOrder.indexOf(key);
    const toVisible = fromVisible + direction;
    if (fromVisible < 0 || toVisible < 0 || toVisible >= visibleOrder.length) return fullOrder;

    const otherKey = visibleOrder[toVisible];
    const from = fullOrder.indexOf(key);
    const to = fullOrder.indexOf(otherKey);
    [fullOrder[from], fullOrder[to]] = [fullOrder[to], fullOrder[from]];
    return fullOrder;
}

function InlineHelpTooltip({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    const tooltipId = React.useId();
    return (
        <span className="group/inline-help relative inline-flex shrink-0">
            <button
                type="button"
                aria-label={label}
                aria-describedby={tooltipId}
                className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-[10px] font-bold leading-none text-slate-500 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:border-indigo-500/50 dark:hover:bg-indigo-500/10 dark:hover:text-indigo-300"
            >
                <span aria-hidden="true">?</span>
            </button>
            <span
                id={tooltipId}
                role="tooltip"
                className="pointer-events-none invisible absolute bottom-full right-0 z-[120] mb-2 w-[270px] max-w-[calc(100vw-2rem)] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-white opacity-0 shadow-xl transition-all group-hover/inline-help:visible group-hover/inline-help:opacity-100 group-focus-within/inline-help:visible group-focus-within/inline-help:opacity-100 dark:bg-zinc-700"
            >
                {children}
                <span className="absolute right-1 top-full -mt-1 h-2 w-2 rotate-45 bg-slate-800 dark:bg-zinc-700" />
            </span>
        </span>
    );
}

function SignedDieOffsetInput({
    id,
    value,
    onChange,
}: {
    id: string;
    value: number;
    onChange: (value: number) => void;
}) {
    // UIUX (audit 2026-08-14 §DIE-FALLBACK-04): giữ chuỗi nhập dở để dấu "-"
    // không bị Number('-') ép về 0 trước khi người dùng gõ phần số.
    const [text, setText] = useState(String(value));
    useEffect(() => {
        const parsed = Number(text.replace(',', '.'));
        if (!Number.isFinite(parsed) || parsed !== value) setText(String(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const commit = (raw: string) => {
        if (!/^-?\d*(?:[.,]\d*)?$/.test(raw)) return;
        setText(raw);
        if (raw === '' || raw === '-' || raw === '.' || raw === ',' || raw === '-.' || raw === '-,') return;
        const next = Number(raw.replace(',', '.'));
        if (Number.isFinite(next)) onChange(next);
    };

    const handleBlur = () => {
        const next = Number(text.replace(',', '.'));
        if (!Number.isFinite(next)) {
            setText(String(value));
            return;
        }
        setText(String(next));
        if (next !== value) onChange(next);
    };

    return (
        <input
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={event => commit(event.target.value)}
            onBlur={handleBlur}
            onFocus={event => event.currentTarget.select()}
            onKeyDown={event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                const parsed = Number(text.replace(',', '.'));
                const base = Number.isFinite(parsed) ? parsed : value;
                const next = base + (event.key === 'ArrowUp' ? 0.5 : -0.5);
                setText(String(next));
                onChange(next);
            }}
            className="w-full h-8 px-2 pr-8 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
        />
    );
}

// Nhóm con thu/xổ riêng trong "Thiết lập mở rộng" — mỗi nhóm tự quản trạng thái đóng/mở.
// infoButton render NGOÀI nút toggle nên bấm ⓘ không làm xổ/thu nhóm.
function CollapsibleGroup({
    title,
    defaultOpen = false,
    infoButton = null,
    children,
}: {
    title: string;
    defaultOpen?: boolean;
    infoButton?: React.ReactNode;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const contentId = React.useId();
    return (
        <div className="rounded-lg border border-slate-200/80 dark:border-white/10 overflow-hidden bg-slate-50/70 dark:bg-zinc-800/20">
            <div className="flex items-center gap-2 px-3 py-2">
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    aria-expanded={open}
                    aria-controls={contentId}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
                >
                    <svg className={`w-3.5 h-3.5 shrink-0 text-indigo-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                    <span className="text-[11px] font-extrabold uppercase tracking-wider text-indigo-600 dark:text-indigo-300 truncate">{title}</span>
                    <div className="flex-1 h-px bg-indigo-200 dark:bg-indigo-500/30" />
                </button>
                {infoButton}
            </div>
            <div
                id={contentId}
                aria-hidden={!open}
                className={`grid transition-[grid-template-rows] duration-200 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
            >
                <div className="overflow-hidden">
                    <div className="p-3 flex flex-col gap-3">{children}</div>
                </div>
            </div>
        </div>
    );
}

export default function AdvancedSettingsSection({
    activeTool,
    sourceTotalPages = 0,
    rectangleStickerInking = false,
    hasValidDie = null,
    detectedDimensionPt = null,
}: {
    activeTool: string;
    sourceTotalPages?: number;
    rectangleStickerInking?: boolean;
    hasValidDie?: boolean | null;
    detectedDimensionPt?: { w: number; h: number } | null;
}) {
  const { t } = useTranslation();
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode,
        impositionUnit: state.impositionUnit,
        scaleMode: state.scaleMode,
        // Bình 2 mặt (CNC) — Cạnh lật + Dấu canh in 2 mặt (chuyển vào đây cho gọn UI)
        duplexFlow: state.duplexFlow, setDuplexFlow: state.setDuplexFlow,
        // UIUX (audit 2026-08-01 §MG-AUTO): chỉ giữ cạnh lật; in dư do solver tự quyết.
        duplexFlipEdge: state.duplexFlipEdge, setDuplexFlipEdge: state.setDuplexFlipEdge,
        cncFlipEdge: state.cncFlipEdge, setCncFlipEdge: state.setCncFlipEdge,
        cncDuplexMarks: state.cncDuplexMarks, setCncDuplexMarks: state.setCncDuplexMarks,
        layoutType: state.layoutType, setLayoutType: state.setLayoutType,
        gridStrategy: state.gridStrategy, setGridStrategy: state.setGridStrategy,
        alternateRotation: state.alternateRotation, setAlternateRotation: state.setAlternateRotation,
        // Grouping Strategy
        groupingStrategy: state.groupingStrategy, setGroupingStrategy: state.setGroupingStrategy,
        clusterCombineMode: state.clusterCombineMode, setClusterCombineMode: state.setClusterCombineMode,
        clusterSizingMode: state.clusterSizingMode, setClusterSizingMode: state.setClusterSizingMode,
        clusterTileW: state.clusterTileW, setClusterTileW: state.setClusterTileW,
        clusterTileH: state.clusterTileH, setClusterTileH: state.setClusterTileH,
        clusterCols: state.clusterCols, setClusterCols: state.setClusterCols,
        clusterRows: state.clusterRows, setClusterRows: state.setClusterRows,
        tileGapX: state.tileGapX, setTileGapX: state.setTileGapX,
        tileGapY: state.tileGapY, setTileGapY: state.setTileGapY,
        clusterNesting: state.clusterNesting, setClusterNesting: state.setClusterNesting,
        // Alignment
        align: state.align, setAlign: state.setAlign,
        // Marks
        markType: state.markType, setMarkType: state.setMarkType,
        setShowMarksModal: state.setShowMarksModal,
        cutBorder: state.cutBorder, setCutBorder: state.setCutBorder,
        gapX: state.gapX, gapY: state.gapY,
        // Boong định vị (chuyển từ OutputSettingsSection vào đây cho gọn UI)
        pontType: state.pontType, setPontType: state.setPontType,
        pontConfig: state.pontConfig, setPontConfig: state.setPontConfig,
        setShowPontModal: state.setShowPontModal,
        // Đường cắt (Bế tem) — gom vào đây cho gọn UI
        cutType: state.cutType, setCutType: state.setCutType,
        dieSizeMode: state.dieSizeMode, setDieSizeMode: state.setDieSizeMode,
        dieOffsetMm: state.dieOffsetMm, setDieOffsetMm: state.setDieOffsetMm,
        fillBlockGap: state.fillBlockGap, setFillBlockGap: state.setFillBlockGap,
        // Lưu file in (tự động) — cài trước khi bình
        savePrint: state.savePrint, setSavePrint: state.setSavePrint,
        // Dữ liệu cho preview report inline
        previewCapacity: state.previewCapacity,
        targetQuantity: state.targetQuantity,
        targetQuantitiesByPage: state.targetQuantitiesByPage,
        sourcePageDim: state.sourcePageDim,
        formsize: state.formsize,
        customSheetWidth: state.customSheetWidth,
        customSheetHeight: state.customSheetHeight,
        // Guillotine Batching
        clusterMode: state.clusterMode, setClusterMode: state.setClusterMode,
        clusterCount: state.clusterCount, setClusterCount: state.setClusterCount,
        clusterDistribution: state.clusterDistribution, setClusterDistribution: state.setClusterDistribution,
        clusterGapMode: state.clusterGapMode, setClusterGapMode: state.setClusterGapMode,
        clusterGap: state.clusterGap, setClusterGap: state.setClusterGap,
        clusterBorder: state.clusterBorder, setClusterBorder: state.setClusterBorder,
        // Output toggles
        separateCutPage: state.separateCutPage, setSeparateCutPage: state.setSeparateCutPage,
        spawnNewTabByTool: state.spawnNewTabByTool, setSpawnNewTab: state.setSpawnNewTab,
        
        // Fine-Tuning (Bleed / Creep)
        signatureMode: state.signatureMode,
        paperThickness: state.paperThickness, setPaperThickness: state.setPaperThickness,
        bleed: state.bleed, setBleed: state.setBleed,
        showBleedView: state.showBleedView, setShowBleedView: state.setShowBleedView,
        // Report & xuất tờ duy nhất (spec: binh-tem-be-report)
        exportUniqueSheets: state.exportUniqueSheets, setExportUniqueSheets: state.setExportUniqueSheets,
        reportDisplay: state.reportDisplay, setReportDisplay: state.setReportDisplay,
        customMaterials: state.customMaterials, setCustomMaterials: state.setCustomMaterials,
        reportMaterial: state.reportMaterial, setReportMaterial: state.setReportMaterial,
        reportLamination: state.reportLamination, setReportLamination: state.setReportLamination,
        reportLaminationSides: state.reportLaminationSides, setReportLaminationSides: state.setReportLaminationSides,
        reportOrderCode: state.reportOrderCode, setReportOrderCode: state.setReportOrderCode,
        saveByReport: state.saveByReport, setSaveByReport: state.setSaveByReport,
    })));

    useEffect(() => {
        if (s.taskMode === 'step_repeat' && s.groupingStrategy !== 'none') {
            s.setGroupingStrategy('none');
        }
    }, [s, s.taskMode, s.groupingStrategy, s.setGroupingStrategy]);

    useEffect(() => {
        // Tương thích trạng thái thử nghiệm cũ: Inking từng bị gộp nhầm vào Cách xếp.
        // Chuyển một lần sang field độc lập rồi trả solver về lưới đơn giản như hành vi cũ.
        if (activeTool !== 'nup') return;
        if ((s.gridStrategy as string) === 'inking_rows') {
            s.setGridStrategy('simple_auto');
            s.setAlternateRotation('row');
        } else if ((s.gridStrategy as string) === 'inking_columns') {
            s.setGridStrategy('simple_auto');
            s.setAlternateRotation('column');
        }
    }, [s, activeTool, s.gridStrategy, s.setGridStrategy, s.setAlternateRotation]);

    const [isExpanded, setIsExpanded] = useState(false);
    const {
        pageSheetMode,
        stickerGeometryMode,
        dieGeometryMode,
        pontSettingsMode,
        stickerToolIdentity,
    } = resolveImpositionModes(activeTool, s.impositionUnit);
    // DIAG (feedback 2026-09-01 §DIM-DIE): ghi đúng dữ liệu WebView đang dùng
    // để phân biệt detector bị rỗng với report chọn nhầm hộp trang.
    const detectedWidthPt = detectedDimensionPt?.w;
    const detectedHeightPt = detectedDimensionPt?.h;
    const sourceWidthPt = s.sourcePageDim?.w;
    const sourceHeightPt = s.sourcePageDim?.h;
    useEffect(() => {
        const detectorIsValid = dieGeometryMode
            && Number.isFinite(detectedWidthPt)
            && Number(detectedWidthPt) > 0
            && Number.isFinite(detectedHeightPt)
            && Number(detectedHeightPt) > 0;
        const selectedWidthPt = detectorIsValid ? Number(detectedWidthPt) : sourceWidthPt;
        const selectedHeightPt = detectorIsValid ? Number(detectedHeightPt) : sourceHeightPt;
        void impositionDimensionTrace('report_preview_dimensions', {
            active_tool: activeTool,
            imposition_unit: s.impositionUnit,
            die_geometry_mode: dieGeometryMode,
            detector_w_pt: detectedWidthPt,
            detector_h_pt: detectedHeightPt,
            source_w_pt: sourceWidthPt,
            source_h_pt: sourceHeightPt,
            selected_source: detectorIsValid ? 'detector_trim' : 'source_page',
            selected_w_mm: selectedWidthPt == null ? undefined : selectedWidthPt * 0.352778,
            selected_h_mm: selectedHeightPt == null ? undefined : selectedHeightPt * 0.352778,
            show_dimensions: s.reportDisplay.showDimensions,
        });
    }, [
        activeTool,
        s.impositionUnit,
        s.reportDisplay.showDimensions,
        dieGeometryMode,
        detectedWidthPt,
        detectedHeightPt,
        sourceWidthPt,
        sourceHeightPt,
    ]);
    // Giữ tên biến cũ cho các gate hình học; identity sản phẩm được tách riêng.
    const stickerLike = dieGeometryMode;
    const stickerProductMode = stickerToolIdentity || activeTool === 'cnc_imposer';
    const labelReportCapable = stickerProductMode || activeTool === 'nup';
    const cutBorderCapable = canUseCutBorder({
        activeTool,
        taskMode: s.taskMode,
        pageSheetMode,
    });
    const cutBorderOverlapRisk = cutBorderCapable
        && s.cutBorder.enabled
        && s.cutBorder.position === 'bleed'
        && s.bleed > 0
        && (
            s.gapX < s.bleed * 2 + s.cutBorder.thickness
            || s.gapY < s.bleed * 2 + s.cutBorder.thickness
        );
    const [infoModal, setInfoModal] = useState<{ title: string, content: React.ReactNode } | null>(null);
    const [showClusterModal, setShowClusterModal] = useState(false);
    const [matInput, setMatInput] = useState<string | null>(null); // null = không thêm; '' = đang nhập
    const cutTypeInputId = React.useId();
    const dieSizeModeInputId = React.useId();
    const dieOffsetInputId = React.useId();
    const fillBlockGapInputId = React.useId();
    const orderedReportFields = orderedReportControls(s.reportDisplay.fieldOrder || []);
    const cutControlPolicy = resolveStickerCutControlPolicy(
        activeTool,
        hasValidDie,
        s.cutType,
        s.gridStrategy,
        s.dieSizeMode,
        s.fillBlockGap,
    );

    const addMaterial = () => {
        const name = (matInput || '').trim();
        if (name && !DEFAULT_MATERIALS.includes(name) && !s.customMaterials.includes(name)) {
            s.setCustomMaterials([...s.customMaterials, name]);
            s.setReportMaterial(name);
        }
        setMatInput(null);
    };

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setInfoModal(null);
                setShowClusterModal(false);
            }
        };
        if (infoModal || showClusterModal) {
            window.addEventListener('keydown', handleKeyDown);
        }
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [infoModal, showClusterModal]);

    // Render logic
    return (
        <div className="mb-4">
            {/* Header / Toggle */}
            <button 
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center justify-between px-1 py-2 border-b border-slate-200 dark:border-white/10 hover:bg-slate-100/70 dark:hover:bg-zinc-800/40 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                    <span className="font-bold text-[13px] text-slate-800 dark:text-white uppercase tracking-wide">{t('imposition.advancedSettings:thiet_lap_mo_rong')}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-400">
                    <span className="text-xs font-medium">{isExpanded ? t('imposition.advancedSettings:dong_lai') : t('imposition.advancedSettings:mo_rong')}</span>
                    <svg className={`w-4 h-4 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                </div>
            </button>

            {/* Expanded Content */}
            <div className={`grid transition-[grid-template-rows] duration-300 ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                    <div className="pt-3 flex flex-col gap-3">


                        {/* Inking là phép xoay artwork sau khi dựng lưới, không phải một Cách xếp. */}
                        {(
                            (activeTool === 'nup' && !pageSheetMode && s.taskMode !== 'booklet' && s.layoutType !== 'mixed_guillotine')
                            || (activeTool === 'sticker_imposer' && rectangleStickerInking)
                        ) && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:doi_dau_xen_ke_inking')}>
                            <div data-testid="alternate-rotation-settings" className="flex flex-col gap-2">
                                <div className="flex items-center gap-3">
                                    <label
                                        htmlFor="alternate-rotation"
                                        className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]"
                                    >
                                        {t('imposition.advancedSettings:kieu_xoay')}
                                    </label>
                                    <select
                                        id="alternate-rotation"
                                        aria-label={t('imposition.advancedSettings:xoay_doi_dau_xen_ke_inking')}
                                        value={s.alternateRotation}
                                        onChange={(e) => s.setAlternateRotation(e.target.value as 'none' | 'row' | 'column')}
                                        className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    >
                                        <option value="none">{t('imposition.advancedSettings:khong_xoay_xen_ke')}</option>
                                        <option value="row">{t('imposition.advancedSettings:doi_dau_theo_hang')}</option>
                                        <option value="column">{t('imposition.advancedSettings:doi_dau_theo_cot')}</option>
                                    </select>
                                </div>
                                <p className="text-[11px] leading-relaxed text-slate-500 dark:text-zinc-400">
                                    {t('imposition.advancedSettings:inking_giu_nguyen_cach_xep_mo_ta')}
                                </p>
                                {s.alternateRotation !== 'none' && (
                                    <p className="text-[11px] leading-relaxed text-indigo-600 dark:text-indigo-300">
                                        {s.alternateRotation === 'row'
                                            ? t('imposition.advancedSettings:inking_theo_hang_mo_ta')
                                            : t('imposition.advancedSettings:inking_theo_cot_mo_ta')}
                                    </p>
                                )}
                            </div>
                        </CollapsibleGroup>
                        )}


                        {/* ══ BÌNH 2 MẶT (CNC) — In 2 mặt + Cạnh lật + Dấu canh in 2 mặt ══ */}
                        {/* UIUX (audit 2026-08-01 §MG-AUTO): in dư do solver tự quyết;
                            Thiết lập mở rộng chỉ còn lựa chọn cần thiết cho mặt sau. */}
                        {activeTool === 'nup' && s.taskMode === 'nup' && s.layoutType === 'mixed_guillotine' && s.duplexFlow === 'double' && (
                        <CollapsibleGroup title={t('imposition.gridSettings:dan_nhieu_kich_thuoc')} defaultOpen>
                            <div className="flex items-center gap-3">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">
                                    {t('imposition.gridSettings:lat_mat_sau')}
                                </label>
                                <select
                                    value={s.duplexFlipEdge}
                                    onChange={(e) => s.setDuplexFlipEdge(e.target.value as 'long' | 'short')}
                                    className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                >
                                    <option value="long">{t('imposition.gridSettings:theo_canh_dai')}</option>
                                    <option value="short">{t('imposition.gridSettings:theo_canh_ngan')}</option>
                                </select>
                            </div>
                        </CollapsibleGroup>
                        )}
                        {activeTool === 'cnc_imposer' && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:binh_2_mat_cnc')} defaultOpen>
                            <Checkbox
                                checked={s.duplexFlow === 'double'}
                                onChange={(v) => s.setDuplexFlow(v ? 'double' : 'normal')}
                                label={t('imposition.advancedSettings:in_2_mat_lat_guong_mat_sau')}
                            />
                            {s.duplexFlow === 'double' && sourceTotalPages > 0 && sourceTotalPages % 2 !== 0 && (
                                <div className="text-[11px] text-red-600 dark:text-red-400">
                                    {t('imposition.advancedSettings:file_co_n_trang_le_binh_2_mat_can_so_trang_chan', { n: sourceTotalPages })}
                                </div>
                            )}
                            {s.duplexFlow === 'double' && (
                                <>
                                    <div className="flex items-center gap-3">
                                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:canh_lat')}</label>
                                        <select
                                            value={s.cncFlipEdge}
                                            onChange={e => s.setCncFlipEdge(e.target.value as 'long' | 'short')}
                                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                        >
                                            <option value="long">{t('imposition.advancedSettings:canh_dai_long_edge_mac_dinh')}</option>
                                            <option value="short">{t('imposition.advancedSettings:canh_ngan_short_edge')}</option>
                                        </select>
                                    </div>
                                    <Checkbox
                                        checked={s.cncDuplexMarks}
                                        onChange={(v) => s.setCncDuplexMarks(v)}
                                        label={t('imposition.advancedSettings:dau_canh_in_2_mat_ve_ca_2_mat')}
                                    />
                                </>
                            )}
                        </CollapsibleGroup>
                        )}

                        {/* ══ NHÓM ① ĐỊNH VỊ & CẮT ══ */}
                        {pontSettingsMode && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:dinh_vi_cat')} defaultOpen>

                        {/* === BOONG ĐỊNH VỊ (Bế tem & CNC) === */}
                        {pontSettingsMode && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:boong_dinh_vi')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <select
                                        value={s.pontType}
                                        onChange={e => {
                                            const val = e.target.value;
                                            s.setPontType(val as 'none' | 'corner' | '5mm' | 'custom');
                                            if (val === 'custom') {
                                                s.setShowPontModal(true);
                                            } else if (val === 'corner') {
                                                s.setPontConfig((prev) => ({ ...prev, shape: 'l_corner' }));
                                            } else if (val === '5mm') {
                                                s.setPontConfig((prev) => ({ ...prev, shape: 'circle', size: 5.0 }));
                                            } else if (val.startsWith('preset_')) {
                                                try {
                                                    const saved = localStorage.getItem('ps_pont_presets');
                                                    if (saved) {
                                                        const parsed: unknown = JSON.parse(saved);
                                                         const presets: PontPreset[] = Array.isArray(parsed)
                                                             ? parsed.filter((item): item is PontPreset => (
                                                                 typeof item === 'object' && item !== null &&
                                                                 'name' in item && typeof item.name === 'string'
                                                             ))
                                                             : [];
                                                        const p = presets.find((x) => 'preset_' + x.name === val);
                                                        if (p && p.config) s.setPontConfig(p.config);
                                                    }
                                                } catch {
                                                    // Preset lỗi định dạng: giữ lựa chọn hiện tại.
                                                }
                                            }
                                        }}
                                        className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    >
                                        <option value="none">{t('imposition.advancedSettings:khong')}</option>
                                        <option value="corner">{t('imposition.advancedSettings:boong_goc_vuong')}</option>
                                        <option value="5mm">Boong 5mm</option>
                                        {(() => {
                                            try {
                                                const raw = localStorage.getItem('ps_pont_presets');
                                                if (raw) {
                                                    const parsed: unknown = JSON.parse(raw);
                                                     const presets: PontPreset[] = Array.isArray(parsed)
                                                         ? parsed.filter((item): item is PontPreset => (
                                                             typeof item === 'object' && item !== null &&
                                                             'name' in item && typeof item.name === 'string'
                                                         ))
                                                         : [];
                                                    return presets.map((p) => (
                                                        <option key={p.name} value={'preset_' + p.name}>{p.name}</option>
                                                    ));
                                                }
                                            } catch {
                                                // Preset lỗi định dạng: không làm gián đoạn dialog.
                                            }
                                            return null;
                                        })()}
                                        <option value="custom">{t('imposition.advancedSettings:tuy_chinh')}</option>
                                    </select>
                                    {s.pontType !== 'none' && (
                                        <button onClick={() => s.setShowPontModal(true)} className="hover:bg-slate-200 dark:hover:bg-zinc-700 rounded transition-colors text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 p-1" title={t('imposition.advancedSettings:tuy_chinh_boong_dinh_vi')}>
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* === ĐƯỜNG CẮT (chỉ Bế tem) === */}
                        {stickerGeometryMode && (
                            <div className="flex flex-col gap-1 relative z-[20] pb-1">
                                <div className="flex items-center gap-3">
                                    <label htmlFor={cutTypeInputId} className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:duong_cat')}</label>
                                    <div className="flex flex-1 items-center gap-2 min-w-0">
                                        <select
                                            id={cutTypeInputId}
                                            value={s.cutType}
                                            onChange={e => s.setCutType(e.target.value as 'default' | 'one_dao')}
                                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                        >
                                            <option value="default">{t('imposition.advancedSettings:mac_dinh')}</option>
                                            <option value="one_dao">1 Dao (Dao LETA)</option>
                                        </select>
                                        <InlineHelpTooltip label={`${t('imposition.advancedSettings:giai_thich', 'Giải thích')} ${t('imposition.advancedSettings:duong_cat')}`}>
                                            {t('imposition.advancedSettings:dao_cat_reset_moi_phien', 'Dao cắt về mặc định mỗi phiên để an toàn — chọn lại nếu cần dao khác')}
                                        </InlineHelpTooltip>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* KIỂU KHUÔN — chỉ khi 1 Dao: theo khuôn có sẵn / theo kích thước trang */}
                        {stickerGeometryMode && cutControlPolicy.showDieSizeSelector && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label htmlFor={dieSizeModeInputId} className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:kieu_khuon')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <select
                                        id={dieSizeModeInputId}
                                        value={s.dieSizeMode}
                                        onChange={e => s.setDieSizeMode(e.target.value as 'die' | 'page')}
                                        className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    >
                                        <option value="die">{t('imposition.advancedSettings:kieu_khuon_die')}</option>
                                        <option value="page">{t('imposition.advancedSettings:kieu_khuon_page')}</option>
                                    </select>
                                    <button
                                        type="button"
                                        aria-label={t('imposition.advancedSettings:giai_thich', 'Giải thích')}
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: t('imposition.advancedSettings:kieu_khuon'),
                                            content: (
                                                <div className="space-y-4">
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:kieu_khuon_die')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:kieu_khuon_die_mo_ta')}</p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:kieu_khuon_page')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:kieu_khuon_page_mo_ta')}</p>
                                                    </div>
                                                    <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:kieu_khuon_offset_mo_ta')}</p>
                                                </div>
                                            )
                                        })}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    </button>
                                </div>
                            </div>
                        )}

                        {stickerGeometryMode && cutControlPolicy.showDieSizeStatus && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1" data-testid="die-size-status">
                                <span className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:kieu_khuon')}</span>
                                <div className="flex-1 min-w-0 rounded border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-zinc-800/50 px-2.5 py-2 text-[11px] leading-snug text-slate-600 dark:text-zinc-300">
                                    {cutControlPolicy.dieStatus === 'page_only'
                                        ? t('imposition.advancedSettings:kieu_khuon_tu_dong_theo_trang', 'Không có đường bế hợp lệ — tự dùng kích thước trang')
                                        : t('imposition.advancedSettings:dang_kiem_tra_khuon', 'Đang kiểm tra đường bế trong file…')}
                                </div>
                            </div>
                        )}

                        {/* CO/MỞ — chỉ cho hình học theo khung trang fallback */}
                        {stickerGeometryMode && cutControlPolicy.showDieOffset && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label htmlFor={dieOffsetInputId} className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:co_mo')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <div className="relative flex-1">
                                        <SignedDieOffsetInput
                                            id={dieOffsetInputId}
                                            value={s.dieOffsetMm}
                                            onChange={s.setDieOffsetMm}
                                        />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </div>
                                    <InlineHelpTooltip label={`${t('imposition.advancedSettings:giai_thich', 'Giải thích')} ${t('imposition.advancedSettings:co_mo')}`}>
                                        {t('imposition.advancedSettings:kieu_khuon_offset_mo_ta')}
                                    </InlineHelpTooltip>
                                </div>
                            </div>
                        )}

                        {/* KC KHỐI PHỤ phụ thuộc Xếp tối ưu, nên đặt sau nhóm chọn hình học khuôn. */}
                        {stickerGeometryMode && cutControlPolicy.showFillBlockGap && (
                            <div className="flex flex-col gap-1 relative z-[20] pb-1">
                                <div className="flex items-center gap-3">
                                    <label
                                        htmlFor={fillBlockGapInputId}
                                        className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]"
                                        title={t('imposition.advancedSettings:khoang_cach_giua_cum_chinh_va_cum_phu')}
                                    >
                                        {t('imposition.advancedSettings:kc_khoi_phu', 'KC KHỐI PHỤ')}
                                    </label>
                                    <div className="flex flex-1 items-center gap-2 min-w-0">
                                        <div className="relative flex-1">
                                            <input
                                                id={fillBlockGapInputId}
                                                type="number"
                                                step="0.5"
                                                min="0"
                                                value={s.fillBlockGap}
                                                onChange={e => s.setFillBlockGap(Math.max(0, Number(e.target.value) || 0))}
                                                className="w-full h-8 px-2 pr-8 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                            />
                                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="text-[10px] text-app-text-3 pl-[107px] leading-snug">
                                    {t('imposition.advancedSettings:kc_khoi_phu_tu_dong', '0 = tự dùng Hở tem; chỉ áp dụng cho khối phụ L-shape')}
                                </div>
                            </div>
                        )}

                        </CollapsibleGroup>
                        )}

                        {/* === NHÓM ② THÔNG TIN SẢN PHẨM (REPORT) === */}
                        {/* Book/magazine report is intentionally separate from the label report. */}
                        {activeTool === 'booklet' && (
                            <CollapsibleGroup
                                title={t('imposition.bookReport:title', { defaultValue: 'THÔNG TIN SÁCH / TẠP CHÍ (REPORT)' })}
                            >
                                <BookReportSettings sourceTotalPages={sourceTotalPages} />
                            </CollapsibleGroup>
                        )}


                        {labelReportCapable && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:thong_tin_san_pham_report')}>

                        {/* === REPORT & XUẤT TỜ DUY NHẤT (sticker_imposer + cnc + cắt xén) === */}
                        {labelReportCapable && (
                            <div className="flex flex-col gap-3 pb-1">
                                <div className="flex items-center justify-between">
                                    <label className="text-[10px] text-slate-400 italic">{t('imposition.advancedSettings:bat_tuy_chinh_khoi_thong_tin_in_len_to')}</label>
                                    {/* UIUX (audit 2026-07-27 §B-17): div onClick → button có aria-label + focus-visible */}
                                    <button
                                        type="button"
                                        aria-label={t('imposition.advancedSettings:giai_thich', 'Giải thích')}
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: t('imposition.advancedSettings:report_lenh_in'),
                                            content: (
                                                <div className="space-y-4">
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        {t('imposition.advancedSettings:binh_tem_be_xuat')} <strong>{t('imposition.advancedSettings:moi_loai_1_to_in_duy_nhat')}</strong> (không nhân bản hàng trăm trang giống nhau).
                                                        Số lượng bạn nhập được quy thành <strong>{t('imposition.advancedSettings:so_to_can_in_2')}</strong> và ghi vào khối thông tin (report) ngay trên tờ —
                                                        thợ in chỉ việc đặt máy in đúng số bản đó.
                                                    </p>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:khoi_report_gom_gi')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            {t('imposition.advancedSettings:ma_don_hang_ten_nhan_chat_lieu_can_mang')} <strong>{t('imposition.advancedSettings:so_to_can_in_2')}</strong>, số lượng thực, kích thước…
                                                            Bạn bật/tắt từng trường ở mục “Trường hiển thị”, chọn vị trí (trên/dưới/trái/phải) và cỡ chữ.
                                                        </p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:chat_lieu')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            {t('imposition.advancedSettings:chon_tu_danh_sach_co_san_hoac_bam_de')}
                                                        </p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:so_to_can_in_tinh_the_nao')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            {t('imposition.advancedSettings:so_to')} <em>{t('imposition.advancedSettings:lam_tron_len')}</em> (Số lượng ÷ Số tem mỗi tờ). VD 1000 tem, 48 tem/tờ → 21 tờ (in dư an toàn).
                                                            Xem bảng chi tiết ở ô “SL mỗi loại”.
                                                        </p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:bo_dau_tieng_viet')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            {t('imposition.advancedSettings:bat_khi_may_phan_mem_cat_khong_doc_duoc')}
                                                        </p>
                                                    </div>
                                                    <p className="text-amber-600 dark:text-amber-400 text-[12px]">
                                                        {t('imposition.advancedSettings:viec_dat_ten_file_luu_ra_thu_muc_duoc')} <strong>{t('imposition.advancedSettings:luu_file_in')}</strong> {t('imposition.advancedSettings:sau_khi_binh_xong')}
                                                    </p>
                                                </div>
                                            )
                                        })}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    </button>
                                </div>

                                <Checkbox
                                    checked={s.reportDisplay.enabled}
                                    onChange={(v) => s.setReportDisplay(prev => ({ ...prev, enabled: v }))}
                                    label={t('imposition.advancedSettings:ve_report_len_to_in')}
                                />

                                {s.reportDisplay.enabled && (
                                    <div className="flex flex-col gap-3 p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg">
                                        {/* Mã đơn hàng + Tên nhãn */}
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:ma_don_hang')}</label>
                                                <input value={s.reportOrderCode} onChange={e => s.setReportOrderCode(e.target.value)} className={inputCls} style={{ paddingLeft: '9px' }} placeholder="VD: DH-001" />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:ten_nhan')}</label>
                                                <input value={s.reportDisplay.labelNameText} onChange={e => s.setReportDisplay(prev => ({ ...prev, labelNameText: e.target.value }))} className={inputCls} style={{ paddingLeft: '9px' }} placeholder={t('imposition.advancedSettings:vd_tem_sau_rieng')} />
                                            </div>
                                        </div>

                                        {/* Chất liệu */}
                                        <div>
                                            <label className="text-[10px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:chat_lieu')}</label>
                                            <div className="flex items-center gap-2">
                                                <select
                                                    value={s.reportMaterial}
                                                    onChange={e => s.setReportMaterial(e.target.value)}
                                                    className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500"
                                                >
                                                    <option value="">{t('imposition.advancedSettings:chon_chat_lieu')}</option>
                                                    {[...DEFAULT_MATERIALS, ...s.customMaterials].map((m: string) => (
                                                        <option key={m} value={m}>{m}</option>
                                                    ))}
                                                </select>
                                                <button
                                                    title={t('imposition.advancedSettings:them_chat_lieu_moi')}
                                                    onClick={() => setMatInput('')}
                                                    className="shrink-0 w-8 h-8 rounded border border-slate-300 dark:border-white/20 text-slate-500 hover:text-indigo-600 hover:border-indigo-400"
                                                >＋</button>
                                                <button
                                                    title={t('imposition.advancedSettings:xoa_chat_lieu_tuy_chinh_dang_chon')}
                                                    disabled={!s.customMaterials.includes(s.reportMaterial)}
                                                    onClick={() => {
                                                        s.setCustomMaterials(s.customMaterials.filter((m: string) => m !== s.reportMaterial));
                                                        s.setReportMaterial('');
                                                    }}
                                                    className="shrink-0 w-8 h-8 rounded border border-slate-300 dark:border-white/20 text-slate-500 hover:text-rose-600 hover:border-rose-400 disabled:opacity-40 disabled:cursor-not-allowed"
                                                >🗑</button>
                                            </div>
                                            {matInput !== null && (
                                                <div className="flex items-center gap-2 mt-2">
                                                    <input
                                                        autoFocus
                                                        value={matInput}
                                                        onChange={e => setMatInput(e.target.value)}
                                                        onKeyDown={e => { if (e.key === 'Enter') addMaterial(); if (e.key === 'Escape') setMatInput(null); }}
                                                        placeholder={t('imposition.advancedSettings:ten_chat_lieu_moi')}
                                                        className={inputCls}
                                                        style={{ paddingLeft: '9px' }}
                                                    />
                                                    <button onClick={addMaterial} className="shrink-0 h-8 px-3 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-[12px] font-bold">{t('imposition.advancedSettings:luu')}</button>
                                                    <button onClick={() => setMatInput(null)} className="shrink-0 h-8 px-3 rounded border border-slate-300 dark:border-white/20 text-[12px]">{t('imposition.advancedSettings:huy')}</button>
                                                </div>
                                            )}
                                        </div>

                                        {/* Cán màng */}
                                        <div>
                                            <label className="text-[10px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:can_mang')}</label>
                                            <select value={s.reportLamination} onChange={e => s.setReportLamination(Number(e.target.value))}
                                                className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500">
                                                {LAMINATION_OPTIONS.map((o: string, i: number) => <option key={i} value={i}>{o}</option>)}
                                            </select>
                                        </div>

                                        {/* Trường hiển thị */}
                                        <div>
                                            <label className="text-[10px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:truong_hien_thi_tren_report')}</label>
                                            <div className="text-[10px] text-slate-400 mb-1.5">
                                                {t('imposition.advancedSettings:sap_xep')} ↑ / ↓
                                            </div>
                                            <div className="flex flex-col gap-1" data-testid="report-field-order">
                                                {orderedReportFields.map(([flag, key], index) => (
                                                    <div
                                                        key={key}
                                                        data-report-field={key}
                                                        className="flex items-center gap-1.5 min-h-7 rounded px-1.5 py-0.5 bg-white/70 dark:bg-zinc-900/50 border border-slate-200/80 dark:border-white/10"
                                                    >
                                                        <span className="w-4 text-[10px] text-slate-400 tabular-nums text-right shrink-0">{index + 1}</span>
                                                        <div className="min-w-0 flex-1">
                                                            {flag ? (
                                                                <Checkbox
                                                                    checked={flag ? s.reportDisplay[flag] !== false : true}
                                                                    onChange={(v) => s.setReportDisplay(prev => ({ ...prev, [flag]: v }))}
                                                                    label={tv(REPORT_FIELD_LABELS[key])}
                                                                />
                                                            ) : (
                                                                <div className="flex items-center gap-2">
                                                                    <span className="w-4 h-4 rounded border border-indigo-300 dark:border-indigo-500/50 bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-[10px] text-indigo-600 dark:text-indigo-300 shrink-0">•</span>
                                                                    <span className="text-sm">{tv(REPORT_FIELD_LABELS[key])}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <button
                                                            type="button"
                                                            disabled={index === 0}
                                                            aria-label={`${t('imposition.advancedSettings:sap_xep')} ${tv(REPORT_FIELD_LABELS[key])} ↑`}
                                                            title={`${t('imposition.advancedSettings:sap_xep')} ↑`}
                                                            onClick={() => s.setReportDisplay(prev => ({
                                                                ...prev,
                                                                fieldOrder: moveReportField(prev.fieldOrder, key, -1),
                                                            }))}
                                                            className="w-6 h-6 rounded border border-slate-200 dark:border-white/10 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed"
                                                        >↑</button>
                                                        <button
                                                            type="button"
                                                            disabled={index === orderedReportFields.length - 1}
                                                            aria-label={`${t('imposition.advancedSettings:sap_xep')} ${tv(REPORT_FIELD_LABELS[key])} ↓`}
                                                            title={`${t('imposition.advancedSettings:sap_xep')} ↓`}
                                                            onClick={() => s.setReportDisplay(prev => ({
                                                                ...prev,
                                                                fieldOrder: moveReportField(prev.fieldOrder, key, 1),
                                                            }))}
                                                            className="w-6 h-6 rounded border border-slate-200 dark:border-white/10 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed"
                                                        >↓</button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Vị trí + cỡ chữ */}
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title={t('imposition.advancedSettings:report_se_duoc_in_o_mep_nao_cua_to_in')}>{t('imposition.advancedSettings:vi_tri_in_tren_to')}</label>
                                                <select value={s.reportDisplay.position} onChange={e => s.setReportDisplay(prev => ({ ...prev, position: e.target.value as ReportDisplayConfig['position'] }))}
                                                    className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500">
                                                    <option value="top">{t('imposition.advancedSettings:mep_tren')}</option>
                                                    <option value="bottom">{t('imposition.advancedSettings:mep_duoi')}</option>
                                                    <option value="left">{t('imposition.advancedSettings:mep_trai')}</option>
                                                    <option value="right">{t('imposition.advancedSettings:mep_phai')}</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:co_chu_pt')}</label>
                                                <input type="number" min={4} max={40} step={0.5} value={s.reportDisplay.fontSize}
                                                    onChange={e => s.setReportDisplay(prev => ({ ...prev, fontSize: Number(e.target.value) }))}
                                                    className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>

                                        {/* Canh giữa (mặc định BẬT) — tự căn giữa report theo mép đã chọn */}
                                        <Checkbox
                                            checked={s.reportDisplay.centered ?? true}
                                            onChange={(v) => s.setReportDisplay(prev => ({ ...prev, centered: v }))}
                                            label={t('imposition.advancedSettings:canh_giua_theo_mep_mac_dinh')}
                                        />

                                        {/* Toạ độ report: cách mép đã chọn bao nhiêu mm (tham khảo script Illustrator) */}
                                        {(() => {
                                            const centered = s.reportDisplay.centered ?? true;
                                            const horiz = s.reportDisplay.position === 'top' || s.reportDisplay.position === 'bottom';
                                            const xDisabled = centered && horiz;   // canh giữa ngang → X không dùng
                                            const yDisabled = centered && !horiz;  // canh giữa dọc → Y không dùng
                                            return (
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title={t('imposition.advancedSettings:khoang_cach_theo_phuong_ngang_tinh_tu')}>{t('imposition.advancedSettings:cach_le_x_mm')}</label>
                                                <input type="number" min={0} step={0.5} disabled={xDisabled} value={s.reportDisplay.offsetX ?? 5}
                                                    onChange={e => s.setReportDisplay(prev => ({ ...prev, offsetX: Number(e.target.value) }))}
                                                    className={inputCls} style={{ paddingLeft: '9px', opacity: xDisabled ? 0.4 : 1 }} />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title={t('imposition.advancedSettings:khoang_cach_tinh_tu_mep_da_chon_mm_bi')}>{t('imposition.advancedSettings:cach_le_y_mm')}</label>
                                                <input type="number" min={0} step={0.5} disabled={yDisabled} value={s.reportDisplay.offsetY ?? 5}
                                                    onChange={e => s.setReportDisplay(prev => ({ ...prev, offsetY: Number(e.target.value) }))}
                                                    className={inputCls} style={{ paddingLeft: '9px', opacity: yDisabled ? 0.4 : 1 }} />
                                            </div>
                                        </div>
                                            );
                                        })()}

                                        <Checkbox checked={s.reportDisplay.removeDiacritics}
                                            onChange={(v) => s.setReportDisplay(prev => ({ ...prev, removeDiacritics: v }))}
                                            label={t('imposition.advancedSettings:bo_dau_tieng_viet')} />

                                        {/* Xem trước report NGAY tại đây (tick tới đâu thấy tới đó) */}
                                        {(() => {
                                            // custom / custom_* / auto_100 → mirror; predefined ISO A → bảng
                                            const _free = s.formsize === 'custom' || s.formsize === 'auto_100' || String(s.formsize).startsWith('custom_');
                                            const sw = _free ? s.customSheetWidth : (PREDEFINED_SIZES[s.formsize]?.w || s.customSheetWidth);
                                            const sh = _free ? s.customSheetHeight : (PREDEFINED_SIZES[s.formsize]?.h || s.customSheetHeight);
                                            const _pageSheetPageCount = Math.max(
                                                1,
                                                sourceTotalPages || 1,
                                            );
                                            const _pageSheetRequestedQty = pageSheetMode
                                                ? Array.from({ length: _pageSheetPageCount }, (_, pageIdx) => {
                                                    const raw = s.targetQuantitiesByPage?.[pageIdx]
                                                        ?? s.targetQuantity
                                                        ?? 0;
                                                    return Math.max(0, Number(raw) || 0);
                                                }).reduce((sum, qty) => sum + qty, 0)
                                                : s.targetQuantity;
                                            // Không nhét gap tấm vào identifier — field 「Mẫu/Trang」
                                            // để trống trừ khi user tự nhập (tên mẫu / nhãn).
                                            // DIM-DIE FIX (feedback 2026-09-01): report tem bế/CNC phải dùng
                                            // cùng trim detector (đơn vị pt) với DIM và solver. `sourcePageDim`
                                            // là hộp trang nên có thể rộng/cao hơn đường khuôn thật.
                                            const detectedReportDimension = dieGeometryMode
                                                && detectedDimensionPt
                                                && Number.isFinite(detectedDimensionPt.w)
                                                && detectedDimensionPt.w > 0
                                                && Number.isFinite(detectedDimensionPt.h)
                                                && detectedDimensionPt.h > 0
                                                ? detectedDimensionPt
                                                : null;
                                            const reportDimensionPt = detectedReportDimension || s.sourcePageDim;
                                            const reportTrimReductionMm = dieGeometryMode
                                                ? 0
                                                : 2 * (s.bleed || 0);
                                            const previewStr = buildReportPreview(s.reportDisplay, {
                                                orderCode: s.reportOrderCode,
                                                identifier: undefined,
                                                gangCount: pageSheetMode ? _pageSheetPageCount : undefined,
                                                labelName: s.reportDisplay.labelNameText,
                                                widthMm: reportDimensionPt
                                                    ? reportDimensionPt.w * 0.352778 - reportTrimReductionMm
                                                    : undefined,
                                                heightMm: reportDimensionPt
                                                    ? reportDimensionPt.h * 0.352778 - reportTrimReductionMm
                                                    : undefined,
                                                // UIUX (audit 2026-08-04 §DIM.5): preview report khớp khổ tờ thập phân thật.
                                                paperSize: `Khổ ${formatSizeMm(sw, sh)}`,
                                                itemsPerSheet: s.previewCapacity,
                                                requestedQty: _pageSheetRequestedQty,
                                                material: s.reportMaterial,
                                                laminationType: s.reportLamination,
                                                laminationSides: s.reportLaminationSides,
                                                modeLabel: pageSheetMode
                                                    ? t('imposition.advancedSettings:binh_nguyen_tam_decal')
                                                    : activeTool === 'cnc_imposer'
                                                      ? t('imposition.advancedSettings:binh_be_rot_cnc')
                                                      : activeTool === 'nup'
                                                        ? t('imposition.advancedSettings:cat_xen')
                                                        : t('imposition.advancedSettings:be_tem'),
                                            });
                                            const posLabel = { top: t('imposition.advancedSettings:mep_tren_2'), bottom: t('imposition.advancedSettings:mep_duoi_2'), left: t('imposition.advancedSettings:mep_trai_2'), right: t('imposition.advancedSettings:mep_phai_2') }[s.reportDisplay.position] || t('imposition.advancedSettings:mep_tren_2');
                                            return (
                                                <div className="rounded-md border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 px-2.5 py-1.5 mt-1">
                                                    <div className="text-[10px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300 mb-0.5">{t('imposition.advancedSettings:xem_truoc_se_in_o', { pos: posLabel })}</div>
                                                    <div className="text-[11px] text-slate-700 dark:text-zinc-200 leading-snug break-words">{previewStr || t('imposition.advancedSettings:chua_co_noi_dung_hay_tick_cac_truong_o')}</div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}
                            </div>
                        )}


                        </CollapsibleGroup>
                        )}

                        {/* ══ NHÓM ③ XUẤT & LƯU FILE ══ */}
                        {stickerProductMode && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:xuat_luu_file')} infoButton={
                                <div
                                    className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                    title={t('imposition.advancedSettings:giai_thich_cach_luu_file')}
                                    onClick={() => setInfoModal({
                                        title: t('imposition.advancedSettings:tu_dong_luu_file_in'),
                                        content: (
                                            <div className="space-y-4 text-[13px]">
                                                <p className="text-slate-600 dark:text-zinc-300">
                                                    {t('imposition.advancedSettings:bat_muc_nay_de')} <b>{t('imposition.advancedSettings:sau_khi_binh_xong_he_thong_tu_tach_tung')}</b> vào thư mục bạn chọn (vẫn mở tab kết quả để xem lại).
                                                    Mỗi loại tem được tách thành file riêng (Bế tem: <b>file In</b> + <b>{t('imposition.advancedSettings:file_be_2')}</b>; CNC: <b>{t('imposition.advancedSettings:mat_truoc_mat_sau_khuon')}</b>).
                                                </p>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:cach_dat_ten_file')}</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        • <b>Theo report</b>{t('imposition.advancedSettings:dung_ma_don_hang_ten_nhan_so_to_lay_o')} <code>{t('imposition.advancedSettings:1_dh_001_tem_sau_rieng_21_to_pdf')}</code><br/>
                                                        • <b>{t('imposition.advancedSettings:danh_so')}</b>: 1.pdf, 2.pdf, 3.pdf…<br/>
                                                        • <b>{t('imposition.advancedSettings:giu_ten_goc')}</b>{t('imposition.advancedSettings:dung_ten_file_goc')}
                                                    </p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:cach_sap_xep_thu_muc')}</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        • <b>{t('imposition.advancedSettings:gom_theo_don_hang')}</b>{t('imposition.advancedSettings:tao_1_thu_muc_mang_ten_don_ben_trong')}
                                                    </p>
                                                    <pre className="text-[11px] bg-slate-100 dark:bg-zinc-800 rounded p-2 leading-snug">📁 DH-001/
   📁 In/    → các file in
   📁 Bế/    → các file khuôn bế</pre>
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        • <b>{t('imposition.advancedSettings:de_chung_mot_cho')}</b>{t('imposition.advancedSettings:tat_ca_file_nam_thang_trong_thu_muc_da')}
                                                    </p>
                                                </div>
                                            </div>
                                        )
                                    })}
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                </div>
                        }>
                            <div className="rounded-md border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-500/10 p-2.5 flex flex-col gap-2">
                                <label className="flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-300 cursor-pointer">
                                    <input type="checkbox" checked={s.savePrint.autoSave}
                                        onChange={e => s.setSavePrint({ autoSave: e.target.checked })}
                                        className="accent-emerald-600 w-4 h-4" />
                                    {t('imposition.advancedSettings:tu_dong_luu_file_in_sau_khi_binh')}
                                </label>
                                {s.savePrint.autoSave && (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <button type="button"
                                                onClick={async () => {
                                                    try {
                                                        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
                                                        const dir = await openDialog({ directory: true, multiple: false, title: t('imposition.advancedSettings:chon_thu_muc_luu_file_in') });
                                                        if (typeof dir === 'string') s.setSavePrint({ lastFolder: dir });
                                                    } catch { /* ignore */ }
                                                }}
                                                className="px-2.5 h-7 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-medium shrink-0">{t('imposition.advancedSettings:chon_thu_muc')}</button>
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-300 truncate flex-1" title={s.savePrint.lastFolder}>
                                                {s.savePrint.lastFolder || t('imposition.advancedSettings:chua_chon_thu_muc')}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                            <span className="text-slate-500">{t('imposition.advancedSettings:ten_file')}</span>
                                            {[
                                                ['report', 'Theo report', t('imposition.advancedSettings:ma_dh_ten_nhan_so_to_lay_o_muc_thong')],
                                                ['number', t('imposition.advancedSettings:danh_so'), '1.pdf, 2.pdf, 3.pdf…'],
                                                ['original', t('imposition.advancedSettings:giu_ten_goc'), t('imposition.advancedSettings:dung_ten_file_goc_2')],
                                            ].map(([v, lbl, tip]) => (
                                                <label key={v} className="flex items-center gap-1 cursor-pointer" title={tip}>
                                                    <input type="radio" name="autoNameMode" checked={s.savePrint.nameMode === v}
                                                        onChange={() => s.setSavePrint({ nameMode: v as SavePrintConfig['nameMode'] })} />{lbl}
                                                </label>
                                            ))}
                                        </div>
                                        {s.savePrint.nameMode === 'report' && (
                                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 -mt-1">
                                                {t('imposition.advancedSettings:ten_file_lay')} <b>{t('imposition.advancedSettings:ma_don_hang_ten_nhan')}</b> {t('imposition.advancedSettings:o_muc')} <b>{t('imposition.advancedSettings:thong_tin_san_pham')}</b>.
                                            </p>
                                        )}
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                            <span className="text-slate-500">{t('imposition.advancedSettings:sap_xep')}</span>
                                            <label className="flex items-center gap-1 cursor-pointer" title={t('imposition.advancedSettings:tao_mot_thu_muc_mang_ten_don_hang_ben')}>
                                                <input type="radio" name="autoFolderMode" checked={s.savePrint.folderMode === 'per_order'}
                                                    onChange={() => s.setSavePrint({ folderMode: 'per_order' })} />{t('imposition.advancedSettings:gom_theo_don_hang')}
                                            </label>
                                            <label className="flex items-center gap-1 cursor-pointer" title={t('imposition.advancedSettings:tat_ca_file_nam_thang_trong_thu_muc_da_2')}>
                                                <input type="radio" name="autoFolderMode" checked={s.savePrint.folderMode === 'flat'}
                                                    onChange={() => s.setSavePrint({ folderMode: 'flat' })} />{t('imposition.advancedSettings:de_chung_mot_cho')}
                                            </label>
                                        </div>
                                        {!s.savePrint.lastFolder && (
                                            <p className="text-[10px] text-amber-600 dark:text-amber-400">{t('imposition.advancedSettings:chon_thu_muc_de_bat_tu_dong_luu_neu')}</p>
                                        )}
                                    </>
                                )}
                            </div>
                        </CollapsibleGroup>
                        )}

                        {/* 1. Grouping Strategy — die-cut (Bế tem/CNC) LẪN bình cắt xén
                            (guillotine: activeTool 'nup' + markType 'guillotine'). Chia cụm
                            zone hợp guillotine (vùng chữ nhật = nhát dao thẳng). Ẩn cho các
                            tổ hợp khác để tránh control vô tác dụng. */}
                        {s.taskMode !== 'booklet' && s.layoutType !== 'mixed_guillotine' && (stickerLike || pageSheetMode || (activeTool === 'nup' && s.markType === 'guillotine')) && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">{t('imposition.advancedSettings:cach_chia_cum')}</label>
                                {/* UIUX (audit 2026-07-27 §B-17): div onClick → button có aria-label + focus-visible */}
                                <button
                                    type="button"
                                    aria-label={t('imposition.advancedSettings:giai_thich', 'Giải thích')}
                                    className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                    onClick={() => setInfoModal({
                                        title: t('imposition.advancedSettings:cach_chia_cum_grouping'),
                                        content: (
                                            <div className="space-y-4">
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:khong')}</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:dan_tem_truc_tiep_lap_day_to_in_theo')}</p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:xep_tu_do')}</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:xep_tu_do_mo_ta')}</p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:chia_deu_dien_tich_so_luong')}</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:dung_cho_in_n_up_nhieu_mau_tu_dong_chia')}</p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:cum_nhan_ban_cluster_tile')}</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:chia_mat_giay_thanh_cac_cum_khong_gian')}</p>
                                                </div>
                                            </div>
                                        )
                                    })}
                                >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                </button>
                            </div>
                            <select
                                value={s.groupingStrategy}
                                onChange={(e) => s.setGroupingStrategy(e.target.value as NonNullable<NupSettings['groupingStrategy']>)}
                                className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                            >
                                <option value="none">{t('imposition.advancedSettings:khong_chia_cum')}</option>
                                {s.taskMode !== 'step_repeat' && (
                                    <>
                                        {/* PARITY (audit 2026-08-29 MAP-NEST-04): free gang và chia đều diện tích là hai intent khác nhau. */}
                                        <option value="free_gang">{t('imposition.advancedSettings:xep_tu_do')}</option>
                                        <option value="maximize_area">{t('imposition.advancedSettings:chia_deu_dien_tich')}</option>
                                        <option value="strict_ratio">{t('imposition.advancedSettings:chia_deu_so_luong')}</option>
                                        <option value="cluster_tile">{t('imposition.advancedSettings:cum_nhan_ban_cluster_tile')}</option>
                                    </>
                                )}
                            </select>

                            {/* Cluster Tile Settings */}
                            {s.taskMode !== 'step_repeat' && s.groupingStrategy === 'cluster_tile' && (
                                <div className="mt-2 flex flex-col gap-3 p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg">
                                    {/* Kiểu ghép cụm */}
                                    <div className="flex items-center gap-2">
                                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide shrink-0 w-[65px]">{t('imposition.advancedSettings:kieu_ghep')}</label>
                                        <select
                                            value={s.clusterCombineMode}
                                            onChange={(e) => s.setClusterCombineMode(e.target.value as 'replicate_mixed' | 'zone_per_type' | 'zone_ratio')}
                                            className="flex-1 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500"
                                        >
                                            <option value="replicate_mixed">{t('imposition.advancedSettings:cum_tron_nhan_ban')}</option>
                                            <option value="zone_per_type">{t('imposition.advancedSettings:moi_loai_mot_vung')}</option>
                                            <option value="zone_ratio">{t('imposition.advancedSettings:vung_theo_ty_le_sl')}</option>
                                        </select>
                                        <div
                                            className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                            onClick={() => setInfoModal({
                                                title: t('imposition.advancedSettings:kieu_ghep_cum'),
                                                content: (
                                                    <div className="space-y-4">
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:cum_tron_nhan_ban')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:kieu_ghep_replicate_mo_ta')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:moi_loai_mot_vung')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:kieu_ghep_zone_per_type_mo_ta')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:vung_theo_ty_le_sl')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:kieu_ghep_zone_ratio_mo_ta')}</p>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        </div>
                                    </div>

                                    {/* Số cột × số hàng vùng — cho kiểu 'mỗi loại một vùng' / 'theo tỉ lệ SL' */}
                                    {(s.clusterCombineMode === 'zone_per_type' || s.clusterCombineMode === 'zone_ratio') && (
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-b border-slate-200 dark:border-white/10 pb-3">
                                        <div>
                                            <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:so_cot_vung')}</label>
                                            <input type="number" min={1} max={20} step={1} value={s.clusterCols} onChange={(e) => s.setClusterCols(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                        </div>
                                        <div>
                                            <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:so_hang_vung')}</label>
                                            <input type="number" min={1} max={20} step={1} value={s.clusterRows} onChange={(e) => s.setClusterRows(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                        </div>
                                    </div>
                                    )}

                                    {/* Định cỡ cụm — chỉ cho kiểu 'cụm trộn nhân bản' (zone modes chia tự động) */}
                                    {s.clusterCombineMode === 'replicate_mixed' && (
                                    <div className="flex items-center gap-2">
                                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide shrink-0 w-[65px]">{t('imposition.advancedSettings:dinh_co')}</label>
                                        <select
                                            value={s.clusterSizingMode}
                                            onChange={(e) => s.setClusterSizingMode(e.target.value as 'dims' | 'split_cols' | 'split_rows')}
                                            className="flex-1 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500"
                                        >
                                            <option value="dims">{t('imposition.advancedSettings:theo_kho_w_x_h')}</option>
                                            <option value="split_cols">{t('imposition.advancedSettings:chia_theo_cot_doc')}</option>
                                            <option value="split_rows">{t('imposition.advancedSettings:chia_theo_hang_ngang')}</option>
                                        </select>
                                        <div
                                            className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                            onClick={() => setInfoModal({
                                                title: t('imposition.advancedSettings:dinh_co_cum'),
                                                content: (
                                                    <div className="space-y-4">
                                                        <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:dinh_co_cum_mo_ta')}</p>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:theo_kho_w_x_h')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:dinh_co_dims_mo_ta')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:chia_theo_cot_doc')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:dinh_co_split_cols_mo_ta')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:chia_theo_hang_ngang')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:dinh_co_split_rows_mo_ta')}</p>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        </div>
                                    </div>
                                    )}

                                    {s.clusterCombineMode === 'replicate_mixed' && s.clusterSizingMode === 'dims' ? (
                                        <div className="flex flex-col gap-2 border-b border-slate-200 dark:border-white/10 pb-3">
                                            <div className="flex items-center gap-3">
                                                <label className="text-[11px] text-slate-500 shrink-0 w-[65px]">{t('imposition.advancedSettings:kho_chuan')}</label>
                                                <select
                                                    value={`${s.clusterTileW}x${s.clusterTileH}`}
                                                    onChange={(e) => {
                                                        const [w, h] = e.target.value.split('x').map(Number);
                                                        if (!isNaN(w) && !isNaN(h)) { s.setClusterTileW(w); s.setClusterTileH(h); }
                                                    }}
                                                    className="flex-1 h-7 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[12px] focus:outline-none focus:border-indigo-500"
                                                >
                                                    <option value="74x105">A7 (74×105mm)</option>
                                                    <option value="105x148">A6 (105×148mm)</option>
                                                    <option value="148x210">A5 (148×210mm)</option>
                                                    <option value="210x297">A4 (210×297mm)</option>
                                                    <option value="custom">{t('imposition.advancedSettings:tuy_chinh')}</option>
                                                </select>
                                            </div>
                                            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                                                <div>
                                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:rong_cum_mm')}</label>
                                                    <input type="number" min={10} max={600} step={1} value={s.clusterTileW} onChange={(e) => s.setClusterTileW(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                                </div>
                                                <div>
                                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:cao_cum_mm')}</label>
                                                    <input type="number" min={10} max={600} step={1} value={s.clusterTileH} onChange={(e) => s.setClusterTileH(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                                </div>
                                            </div>
                                        </div>
                                    ) : s.clusterCombineMode === 'replicate_mixed' && s.clusterSizingMode === 'split_cols' ? (
                                        <div className="grid grid-cols-1 gap-x-3 gap-y-3 border-b border-slate-200 dark:border-white/10 pb-3">
                                            <div>
                                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:so_cot_doc')}</label>
                                                <input type="number" min={1} max={20} step={1} value={s.clusterCols} onChange={(e) => s.setClusterCols(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>
                                    ) : s.clusterCombineMode === 'replicate_mixed' && s.clusterSizingMode === 'split_rows' ? (
                                        <div className="grid grid-cols-1 gap-x-3 gap-y-3 border-b border-slate-200 dark:border-white/10 pb-3">
                                            <div>
                                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:so_hang_ngang')}</label>
                                                <input type="number" min={1} max={20} step={1} value={s.clusterRows} onChange={(e) => s.setClusterRows(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>
                                    ) : null}

                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">{t('imposition.advancedSettings:khoang_cach_giua_cac_cum')}</label>
                                            <div
                                                className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                                onClick={() => setInfoModal({
                                                    title: t('imposition.advancedSettings:khoang_cach_giua_cac_cum'),
                                                    content: (
                                                        <div className="space-y-4">
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:khoang_cach_cum_mo_ta')}</p>
                                                            <div className="space-y-1">
                                                                <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:khoang_ho_doc_mm')}</h4>
                                                                <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:khoang_ho_doc_mo_ta')}</p>
                                                            </div>
                                                            <div className="space-y-1">
                                                                <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:khoang_ho_ngang_mm')}</h4>
                                                                <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:khoang_ho_ngang_mo_ta')}</p>
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            >
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                                            <div>
                                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:khoang_ho_doc_mm')}</label>
                                                <input type="number" min={0} max={50} step={0.5} value={s.tileGapX} onChange={(e) => s.setTileGapX(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                            <div>
                                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.advancedSettings:khoang_ho_ngang_mm')}</label>
                                                <input type="number" min={0} max={50} step={0.5} value={s.tileGapY} onChange={(e) => s.setTileGapY(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>
                                    </div>

                                    {stickerLike && (
                                        <div className="mt-1 flex items-center gap-1">
                                            <Checkbox checked={s.clusterNesting} onChange={s.setClusterNesting} label={t('imposition.advancedSettings:binh_long_sat_trong_cum_nesting')} />
                                            <div
                                                className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                                onClick={() => setInfoModal({
                                                    title: t('imposition.advancedSettings:binh_long_sat_trong_cum_nesting'),
                                                    content: (
                                                        <div className="space-y-4">
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:nesting_mo_ta')}</p>
                                                        </div>
                                                    )
                                                })}
                                            >
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        )}

                        {/* 2. Alignment */}
                        {s.taskMode !== 'booklet' && !stickerLike && (
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">{t('imposition.advancedSettings:canh_khoi_sau_khi_xep')}</label>
                                    {/* UIUX (audit 2026-07-27 §B-17): div onClick → button có aria-label + focus-visible */}
                                    <button
                                        type="button"
                                        aria-label={t('imposition.advancedSettings:giai_thich', 'Giải thích')}
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: t('imposition.advancedSettings:canh_khoi_alignment'),
                                            content: (
                                                <div className="space-y-4">
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:canh_giua_trung_tam_mac_dinh')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:toan_bo_khoi_thiet_ke_sau_khi_dan_se')}</p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:canh_goc_canh')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:day_toan_bo_khoi_thiet_ke_don_ve_mot')}</p>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    </button>
                                </div>
                                <select
                                    value={s.align} onChange={(e) => s.setAlign(e.target.value as NupSettings['align'])}
                                    className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                >
                                    <option value="top-left">{t('imposition.advancedSettings:canh_goc_trai_tren')}</option>
                                    <option value="top-center">{t('imposition.advancedSettings:canh_giua_tren')}</option>
                                    <option value="top-right">{t('imposition.advancedSettings:canh_goc_phai_tren')}</option>
                                    <option value="center-left">{t('imposition.advancedSettings:canh_trai_giua')}</option>
                                    <option value="center">{t('imposition.advancedSettings:canh_giua_trung_tam')}</option>
                                    <option value="center-right">{t('imposition.advancedSettings:canh_phai_giua')}</option>
                                    <option value="bottom-left">{t('imposition.advancedSettings:canh_goc_trai_duoi')}</option>
                                    <option value="bottom-center">{t('imposition.advancedSettings:canh_giua_duoi')}</option>
                                    <option value="bottom-right">{t('imposition.advancedSettings:canh_goc_phai_duoi')}</option>
                                </select>
                            </div>
                        )}

                        {/* 3. Trim Marks */}
                        {s.taskMode !== 'offset' && !stickerLike && (
                            <div className="relative z-[20]">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{t('imposition.advancedSettings:dau_xen_trim_marks')}</label>
                                        <div
                                            className="shrink-0 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                            onClick={() => setInfoModal({
                                                title: t('imposition.advancedSettings:dau_xen_trim_marks_2'),
                                                content: (
                                                    <div className="space-y-4">
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:khong_ve_dau_xen')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:chi_dan_trang_khong_ve_them_bat_ky_vach')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:xen_4_goc_ngoai_die_cut_bounds')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:chi_ve_4_goc_bo_gioi_han_toan_bo_khu')}</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:xen_thanh_pham_guillotine')}</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:ve_day_du_cac_vach_bo_goc_va_vach_chia')}</p>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        </div>
                                    </div>
                                    {/* UIUX (audit 2026-07-27 §B-24): p-0.5 → p-1.5 (vùng bấm bánh răng lớn hơn) */}
                                    <button onClick={() => s.setShowMarksModal(true)} className="hover:bg-slate-200 dark:hover:bg-zinc-700 rounded transition-colors text-slate-400 hover:text-indigo-600 p-1.5" title={t('imposition.advancedSettings:cai_dat_dau_xen')}>
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                    </button>
                                </div>
                                <select
                                    value={s.markType}
                                    onChange={e => {
                                        const nextMark = e.target.value as NupSettings['markType'];
                                        s.setMarkType(nextMark);
                                        if (!stickerLike && nextMark !== 'guillotine') {
                                            s.setGroupingStrategy('none');
                                            s.setClusterMode('none');
                                        }
                                    }}
                                    className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <option value="none">{t('imposition.advancedSettings:khong_ve_dau_xen')}</option>
                                    {s.taskMode !== 'booklet' && <option value="corners">{t('imposition.advancedSettings:xen_4_goc_ngoai_die_cut_bounds_2')}</option>}
                                    <option value="guillotine">{t('imposition.advancedSettings:xen_thanh_pham_guillotine')}</option>
                                </select>
                            </div>
                        )}

                        {/* CUT-BORDER (audit 2026-08-04 §CB.5): đường hướng dẫn cắt
                            thủ công độc lập với dấu xén, chỉ thuộc N-Up guillotine. */}
                        {cutBorderCapable && (
                            <div
                                data-testid="cut-border-settings"
                                className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-zinc-800/20 p-3 space-y-2.5"
                            >
                                <Checkbox
                                    checked={s.cutBorder.enabled}
                                    onChange={(enabled) => s.setCutBorder({ enabled })}
                                    label={t('imposition.advancedSettings:duong_vien_cat')}
                                />
                                <p className="text-[11px] leading-snug text-slate-500 dark:text-zinc-400">
                                    {t('imposition.advancedSettings:duong_vien_cat_mo_ta')}
                                </p>
                                {s.cutBorder.enabled && (
                                    <div data-testid="cut-border-controls" className="grid grid-cols-2 gap-2 pt-1">
                                        <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300 space-y-1">
                                            <span>{t('imposition.advancedSettings:mau_vien')}</span>
                                            <div className="flex items-center gap-2 h-8">
                                                <input
                                                    type="color"
                                                    aria-label={t('imposition.advancedSettings:mau_vien')}
                                                    value={/^#[0-9a-f]{6}$/i.test(s.cutBorder.color) ? s.cutBorder.color : '#000000'}
                                                    onChange={(event) => s.setCutBorder({ color: event.target.value.toUpperCase() })}
                                                    className="w-10 h-8 p-0.5 rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 cursor-pointer"
                                                />
                                                <span className="text-[10px] font-mono text-slate-500">{s.cutBorder.color.toUpperCase()}</span>
                                            </div>
                                        </label>
                                        <label className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300 space-y-1">
                                            <span>{t('imposition.advancedSettings:do_day_vien_mm')}</span>
                                            <input
                                                type="number"
                                                min="0.1"
                                                max="2"
                                                step="0.1"
                                                aria-label={t('imposition.advancedSettings:do_day_vien_mm')}
                                                value={s.cutBorder.thickness}
                                                onChange={(event) => s.setCutBorder({ thickness: Number(event.target.value) })}
                                                className={inputCls}
                                            />
                                        </label>
                                        <label className="col-span-2 text-[11px] font-semibold text-slate-600 dark:text-zinc-300 space-y-1">
                                            <span>{t('imposition.advancedSettings:vi_tri_duong_vien')}</span>
                                            <select
                                                aria-label={t('imposition.advancedSettings:vi_tri_duong_vien')}
                                                value={s.cutBorder.position}
                                                onChange={(event) => s.setCutBorder({ position: event.target.value as 'trim' | 'bleed' })}
                                                className={`${inputCls} appearance-auto`}
                                            >
                                                <option value="trim">{t('imposition.advancedSettings:theo_thanh_pham_trim')}</option>
                                                <option value="bleed">{t('imposition.advancedSettings:theo_mep_tran_le_bleed')}</option>
                                            </select>
                                        </label>
                                        {s.cutBorder.position === 'bleed' && (
                                            <div className="col-span-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded px-2 py-1.5">
                                                {t('imposition.advancedSettings:cat_theo_bleed_lon_hon_thanh_pham', { bleed: s.bleed })}
                                            </div>
                                        )}
                                        {cutBorderOverlapRisk && (
                                            <div data-testid="cut-border-overlap-warning" className="col-span-2 text-[11px] leading-snug text-red-700 dark:text-red-400">
                                                {t('imposition.advancedSettings:khe_khong_du_vien_bleed_co_the_chong')}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 4. Chia cọc xén — CHỈ hiện khi tính năng THỰC SỰ áp dụng:
                            - Dàn nhiều loại (ratio_stack): mỗi cọc 1 loại, bề rộng theo tỷ lệ SL.
                            - Bình trang (step_repeat): chia cọc nhân bản cùng loại.
                            Ẩn với Xếp lần lượt / Xếp chồng (chia cọc chưa chạy đúng) → tránh
                            tổ hợp vô nghĩa "chọn cột/hàng mà không thấy gì". */}
                        {((s.taskMode === 'nup' && s.layoutType === 'ratio_stack') || s.taskMode === 'step_repeat') && s.markType === 'guillotine' && !stickerLike && !pageSheetMode && (
                            <div className="relative z-[10]">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">{t('imposition.advancedSettings:chia_coc_xen_title')}</label>
                                    <div
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: t('imposition.advancedSettings:chia_coc_xen_title'),
                                            content: (
                                                <div className="space-y-4">
                                                    <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:tu_dong_tach_to_in_thanh_cac_coc_rieng')}</p>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:chia_theo_hang_cot')}</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">{t('imposition.advancedSettings:cat_toan_bo_luoi_giay_thanh_2_3_hoac')}</p>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={s.clusterMode} onChange={e => s.setClusterMode(e.target.value as NupSettings['clusterMode'])}
                                        className="flex-1 min-w-0 h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto transition-colors"
                                    >
                                        <option value="none">{t('imposition.advancedSettings:khong_chia_coc')}</option>
                                        <option value="row">{t('imposition.advancedSettings:chia_theo_hang_ngang_2')}</option>
                                        <option value="column">{t('imposition.advancedSettings:chia_theo_cot_doc_2')}</option>
                                    </select>
                                    {s.clusterMode !== 'none' && (
                                        <div className="flex items-center gap-2">
                                            <input type="number" min="2" value={s.clusterCount} onChange={e => s.setClusterCount(Math.max(2, parseInt(e.target.value) || 2))} className="w-14 h-8 px-2 font-medium border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 text-center" title={t('imposition.advancedSettings:so_coc_label')} />
                                            <button onClick={() => setShowClusterModal(true)} className="w-8 h-8 flex items-center justify-center border border-slate-300 dark:border-white/20 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors text-slate-500 hover:text-indigo-600" title={t('imposition.advancedSettings:cai_dat_nang_cao')}>
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                            </button>
                                        </div>
                                    )}
                                </div>
                                {/* Dàn nhiều loại (ratio_stack) + chia cọc → mỗi loại 1 cọc riêng,
                                    BỀ RỘNG cọc theo tỷ lệ SL. Không có kiểu "chia cọc mà trộn loại"
                                    nên không có nút phân bổ; chỉ hiện dòng nhắc cho rõ. */}
                                {s.clusterMode !== 'none' && s.layoutType === 'ratio_stack' && (
                                    <div className="mt-1.5 text-[11px] text-slate-500 dark:text-zinc-400 leading-snug">
                                        {t('imposition.advancedSettings:moi_loai_nam_1_coc_rieng_coc_rong_hep')}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 5. Paper Thickness & Bleed — CHỈ cho booklet.
                            - N-up: ô BLEED đã có ở GridSettings.
                            - Bế tem (die-cut): kích thước lấy từ ĐƯỜNG KHUÔN BẾ trong file,
                              bleed UI không có tác dụng (decal bế bằng khuôn, không xén dao)
                              → ẩn để tránh hiểu nhầm. */}
                        {s.taskMode === 'booklet' && (
                        <div className={`grid ${s.taskMode === 'booklet' && (s.signatureMode === 'saddle' || s.signatureMode === 'thread') ? 'grid-cols-2' : 'grid-cols-1'} gap-3 relative z-[30]`}>
                            {s.taskMode === 'booklet' && (s.signatureMode === 'saddle' || s.signatureMode === 'thread') && (
                                <div className="flex flex-col gap-2 h-full justify-end">
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide block -mb-0.5" title={t('imposition.advancedSettings:su_dung_do_day_giay_de_bu_lem_gay_creep')}>{t('imposition.advancedSettings:day_giay_creep_mm')}</label>
                                    {/* UIUX (audit 2026-07-27 §B-02): thêm suffix mm */}
                                    <div className="relative">
                                        <input
                                            type="number" step="0.01" value={s.paperThickness} onChange={e => s.setPaperThickness(Number(e.target.value))}
                                            className="w-full h-8 px-2 pr-7 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                        />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none uppercase">mm</span>
                                    </div>
                                </div>
                            )}
                            <div className="flex flex-col gap-2 h-full justify-end">
                                <div className="flex items-center justify-between -mb-0.5">
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{t('imposition.advancedSettings:le_xen_bleed')}</label>
                                    <button
                                        onClick={() => s.setShowBleedView(!s.showBleedView)}
                                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors ${s.showBleedView ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400' : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-400'}`}
                                        title={s.showBleedView ? t('imposition.advancedSettings:tat_duong_vien_xem_truoc_bleed') : t('imposition.advancedSettings:bat_duong_vien_xem_truoc_bleed')}
                                    >
                                        {s.showBleedView ? (
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                        ) : (
                                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                                        )}
                                    </button>
                                </div>
                                {/* UIUX (audit 2026-07-27 §B-02): thêm suffix mm; §B-04: min 0 + clamp không âm */}
                                <div className="relative">
                                    <input
                                        type="number" step="0.1" min="0" value={s.bleed} onChange={e => s.setBleed(Math.max(0, Number(e.target.value) || 0))}
                                        className="w-full h-8 px-2 pr-7 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none uppercase">mm</span>
                                </div>
                            </div>
                        </div>
                        )}

                        {/* 6. Output Toggles */}
                        <Divider />
                        <div className="space-y-2">
                            {stickerGeometryMode && (
                                <Checkbox checked={s.separateCutPage} onChange={s.setSeparateCutPage} label={t('imposition.advancedSettings:tach_trang_khuon_be_rieng')} />
                            )}
                            <Checkbox checked={s.spawnNewTabByTool[activeTool] ?? true} onChange={(v) => s.setSpawnNewTab(activeTool, v)} label={t('imposition.advancedSettings:mo_ket_qua_sang_tab_moi')} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Modals Portals */}
            {infoModal && createPortal(
                <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setInfoModal(null)}>
                    <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-white/10">
                            <h3 className="text-lg font-bold text-slate-800 dark:text-white">{infoModal.title}</h3>
                            <button onClick={() => setInfoModal(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 transition-colors">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 text-sm">
                            {infoModal.content}
                        </div>
                        <div className="px-5 py-4 bg-slate-50 dark:bg-zinc-800/50 border-t border-slate-200 dark:border-white/10 flex justify-end">
                            <button onClick={() => setInfoModal(null)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors">
                                {t('imposition.advancedSettings:da_hieu')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* Cluster Batching Modal */}
            {showClusterModal && createPortal(
                <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowClusterModal(false)}>
                    <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-white/10">
                            <h3 className="text-lg font-bold text-slate-800 dark:text-white">{t('imposition.advancedSettings:nang_cao_chia_coc_xen')}</h3>
                            <button onClick={() => setShowClusterModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 transition-colors">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 flex flex-col gap-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide block mb-1.5">{t('imposition.advancedSettings:khoang_cach_tu')}</label>
                                    <select value={s.clusterGapMode} onChange={e => s.setClusterGapMode(e.target.value as NupSettings['clusterGapMode'])} className="w-full h-9 px-2 border border-slate-300 dark:border-white/20 rounded-lg bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto">
                                        <option value="item">{t('imposition.advancedSettings:mep_tem_con')}</option>
                                        <option value="mark">{t('imposition.advancedSettings:dau_xen_ngoai')}</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide block mb-1.5">{t('imposition.advancedSettings:khoang_cach_giua_2_cum_mm')}</label>
                                    <input
                                        type="number" min="0" step="0.5" value={s.clusterGap}
                                        onChange={e => s.setClusterGap(Math.max(0, parseFloat(e.target.value) || 0))}
                                        className="w-full h-9 px-2 border border-slate-300 dark:border-white/20 rounded-lg bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="px-5 py-4 bg-slate-50 dark:bg-zinc-800/50 border-t border-slate-200 dark:border-white/10 flex justify-end">
                            <button onClick={() => setShowClusterModal(false)} className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors">
                                {t('imposition.advancedSettings:xong')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
