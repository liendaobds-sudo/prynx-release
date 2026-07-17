// @ts-nocheck
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { useShallow } from 'zustand/react/shallow';
import { SectionLabel, Divider, inputCls, Checkbox, RichSelect } from '../SharedUI';
import { DEFAULT_MATERIALS, LAMINATION_OPTIONS, PREDEFINED_SIZES, type ReportFieldKey } from '../types';
import { buildReportPreview } from '../../../lib/reportPreview';
import { useTranslation } from 'react-i18next';
import { tv } from '../../../i18n';

const REPORT_FIELD_LABELS: Record<string, string> = {
    orderCode: 'Mã đơn hàng', identifier: 'Mẫu/Trang', gangCount: 'Số mẫu ghép',
    labelName: 'Tên nhãn',
    material: 'Chất liệu', lamination: 'Cán màng', labelsPerSheet: 'SL/tờ',
    actualQty: 'SL thực', sheetCount: 'Số tờ cần in', dimensions: 'Kích thước',
    paperSize: 'Khổ giấy', cutFileRef: 'File bế', modeLabel: 'Chế độ',
};
const REPORT_SHOW_KEYS: Array<[string, ReportFieldKey]> = [
    ['showIdentifier', 'identifier'], ['showGangCount', 'gangCount'], ['showLabelName', 'labelName'], ['showMaterial', 'material'],
    ['showLamination', 'lamination'], ['showLabelsPerSheet', 'labelsPerSheet'], ['showActualQty', 'actualQty'],
    ['showSheetCount', 'sheetCount'], ['showDimensions', 'dimensions'], ['showPaperSize', 'paperSize'],
    ['showModeLabel', 'modeLabel'],
];

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
    return (
        <div className="rounded-lg border border-slate-200 dark:border-white/10 overflow-hidden bg-white dark:bg-zinc-900">
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-zinc-800/40">
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
                >
                    <svg className={`w-3.5 h-3.5 shrink-0 text-indigo-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                    <span className="text-[11px] font-extrabold uppercase tracking-wider text-indigo-600 dark:text-indigo-300 truncate">{title}</span>
                    <div className="flex-1 h-px bg-indigo-200 dark:bg-indigo-500/30" />
                </button>
                {infoButton}
            </div>
            <div className={`grid transition-[grid-template-rows] duration-200 ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                    <div className="p-3 flex flex-col gap-3">{children}</div>
                </div>
            </div>
        </div>
    );
}

export default function AdvancedSettingsSection({ activeTool, sourceTotalPages = 0 }: { activeTool: string; sourceTotalPages?: number }) {
  const { t } = useTranslation();
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode,
        scaleMode: state.scaleMode,
        // Bình 2 mặt (CNC) — Cạnh lật + Dấu canh in 2 mặt (chuyển vào đây cho gọn UI)
        duplexFlow: state.duplexFlow, setDuplexFlow: state.setDuplexFlow,
        cncFlipEdge: state.cncFlipEdge, setCncFlipEdge: state.setCncFlipEdge,
        cncDuplexMarks: state.cncDuplexMarks, setCncDuplexMarks: state.setCncDuplexMarks,
        layoutType: state.layoutType, setLayoutType: state.setLayoutType,
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

    const [isExpanded, setIsExpanded] = useState(false);
    // CNC dùng chung profile die-cut với Bế tem (report, nesting; ẩn dấu xén/guillotine/căn lề).
    const stickerLike = activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer';
    // Nhóm report (Thông tin sản phẩm) mở cho CẢ cắt xén (nup): backend + handler đã sẵn
    // sàng nhận reportDisplay cho guillotine, chỉ UI trước đây gate nhầm theo stickerLike.
    const reportCapable = stickerLike || activeTool === 'nup';
    const [infoModal, setInfoModal] = useState<{ title: string, content: React.ReactNode } | null>(null);
    const [showClusterModal, setShowClusterModal] = useState(false);
    const [matInput, setMatInput] = useState<string | null>(null); // null = không thêm; '' = đang nhập

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
        <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden mb-4 shadow-sm">
            {/* Header / Toggle */}
            <button 
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full flex items-center justify-between p-4 bg-slate-50 dark:bg-zinc-800/30 hover:bg-slate-100 dark:hover:bg-zinc-800/60 transition-colors"
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
                    <div className="p-4 flex flex-col gap-3 border-t border-slate-200 dark:border-white/10">


                        {/* ══ BÌNH 2 MẶT (CNC) — In 2 mặt + Cạnh lật + Dấu canh in 2 mặt ══ */}
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
                                            onChange={e => s.setCncFlipEdge(e.target.value)}
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
                        {stickerLike && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:dinh_vi_cat')} defaultOpen>

                        {/* === BOONG ĐỊNH VỊ (Bế tem & CNC) === */}
                        {stickerLike && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:boong_dinh_vi')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <select
                                        value={s.pontType}
                                        onChange={e => {
                                            const val = e.target.value;
                                            s.setPontType(val);
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
                                                        const presets = JSON.parse(saved);
                                                        const p = presets.find((x) => 'preset_' + x.name === val);
                                                        if (p && p.config) s.setPontConfig(p.config);
                                                    }
                                                } catch (e) {}
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
                                                    const presets = JSON.parse(raw);
                                                    return presets.map((p) => (
                                                        <option key={p.name} value={'preset_' + p.name}>{p.name}</option>
                                                    ));
                                                }
                                            } catch (e) {}
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
                        {activeTool === 'sticker_imposer' && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:duong_cat')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <select
                                        value={s.cutType}
                                        onChange={e => s.setCutType(e.target.value)}
                                        className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    >
                                        <option value="default">{t('imposition.advancedSettings:mac_dinh')}</option>
                                        <option value="one_dao">1 Dao (Dao LETA)</option>
                                    </select>
                                </div>
                            </div>
                        )}

                        {/* KC CỤM PHỤ — chỉ khi 1 Dao */}
                        {activeTool === 'sticker_imposer' && s.cutType === 'one_dao' && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]" title={t('imposition.advancedSettings:khoang_cach_giua_cum_chinh_va_cum_phu')}>{t('imposition.advancedSettings:kc_cum_phu')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <div className="relative flex-1">
                                        <input type="number" step="0.5" min="0" value={s.fillBlockGap} onChange={e => s.setFillBlockGap(Number(e.target.value))}
                                            className="w-full h-8 px-2 pr-8 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium" />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* KIỂU KHUÔN — chỉ khi 1 Dao: theo khuôn có sẵn / theo kích thước trang */}
                        {activeTool === 'sticker_imposer' && s.cutType === 'one_dao' && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:kieu_khuon')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <select
                                        value={s.dieSizeMode}
                                        onChange={e => s.setDieSizeMode(e.target.value as 'die' | 'page')}
                                        className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    >
                                        <option value="die">{t('imposition.advancedSettings:kieu_khuon_die')}</option>
                                        <option value="page">{t('imposition.advancedSettings:kieu_khuon_page')}</option>
                                    </select>
                                    <div
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
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* CO/MỞ — chỉ khi 1 Dao + theo kích thước trang */}
                        {activeTool === 'sticker_imposer' && s.cutType === 'one_dao' && s.dieSizeMode === 'page' && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">{t('imposition.advancedSettings:co_mo')}</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <div className="relative flex-1">
                                        <input type="number" step="0.5" value={s.dieOffsetMm} onChange={e => s.setDieOffsetMm(Number(e.target.value))}
                                            className="w-full h-8 px-2 pr-8 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium" />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        </CollapsibleGroup>
                        )}

                        {/* === NHÓM ② THÔNG TIN SẢN PHẨM (REPORT) === */}
                        {reportCapable && (
                        <CollapsibleGroup title={t('imposition.advancedSettings:thong_tin_san_pham_report')}>

                        {/* === REPORT & XUẤT TỜ DUY NHẤT (sticker_imposer + cnc + cắt xén) === */}
                        {reportCapable && (
                            <div className="flex flex-col gap-3 pb-1">
                                <div className="flex items-center justify-between">
                                    <label className="text-[10px] text-slate-400 italic">{t('imposition.advancedSettings:bat_tuy_chinh_khoi_thong_tin_in_len_to')}</label>
                                    <div
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
                                    </div>
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
                                            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                                {REPORT_SHOW_KEYS.map(([flag, key]) => (
                                                    <Checkbox
                                                        key={flag}
                                                        checked={(s.reportDisplay as any)[flag]}
                                                        onChange={(v) => s.setReportDisplay(prev => ({ ...prev, [flag]: v }))}
                                                        label={tv(REPORT_FIELD_LABELS[key])}
                                                    />
                                                ))}
                                            </div>
                                        </div>

                                        {/* Vị trí + cỡ chữ */}
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title={t('imposition.advancedSettings:report_se_duoc_in_o_mep_nao_cua_to_in')}>{t('imposition.advancedSettings:vi_tri_in_tren_to')}</label>
                                                <select value={s.reportDisplay.position} onChange={e => s.setReportDisplay(prev => ({ ...prev, position: e.target.value }))}
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
                                            const previewStr = buildReportPreview(s.reportDisplay, {
                                                orderCode: s.reportOrderCode,
                                                labelName: s.reportDisplay.labelNameText,
                                                widthMm: s.sourcePageDim ? s.sourcePageDim.w * 0.352778 - 2 * (s.bleed || 0) : undefined,
                                                heightMm: s.sourcePageDim ? s.sourcePageDim.h * 0.352778 - 2 * (s.bleed || 0) : undefined,
                                                paperSize: `Khổ ${Math.round(sw)}x${Math.round(sh)}mm`,
                                                itemsPerSheet: s.previewCapacity,
                                                requestedQty: s.targetQuantity,
                                                material: s.reportMaterial,
                                                laminationType: s.reportLamination,
                                                laminationSides: s.reportLaminationSides,
                                                modeLabel: activeTool === 'cnc_imposer' ? t('imposition.advancedSettings:binh_be_rot_cnc') : activeTool === 'nup' ? t('imposition.advancedSettings:cat_xen') : t('imposition.advancedSettings:be_tem'),
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
                        {stickerLike && (
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
                                                    } catch (e) { /* ignore */ }
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
                                                        onChange={() => s.setSavePrint({ nameMode: v as any })} />{lbl}
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
                        {s.taskMode !== 'booklet' && (stickerLike || (activeTool === 'nup' && s.markType === 'guillotine')) && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">{t('imposition.advancedSettings:cach_chia_cum')}</label>
                                <div
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
                                </div>
                            </div>
                            <select
                                value={s.groupingStrategy}
                                onChange={(e) => s.setGroupingStrategy(e.target.value as any)}
                                className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                            >
                                <option value="none">{t('imposition.advancedSettings:khong_chia_cum')}</option>
                                {s.taskMode !== 'step_repeat' && (
                                    <>
                                        <option value="maximize_area">{t('imposition.advancedSettings:chia_deu_dien_tich')}</option>
                                        <option value="strict_ratio">{t('imposition.advancedSettings:chia_deu_so_luong')}</option>
                                    </>
                                )}
                                <option value="cluster_tile">{t('imposition.advancedSettings:cum_nhan_ban_cluster_tile')}</option>
                            </select>

                            {/* Cluster Tile Settings */}
                            {s.groupingStrategy === 'cluster_tile' && (
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
                                    <div
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
                                    </div>
                                </div>
                                <select
                                    value={s.align} onChange={(e) => s.setAlign(e.target.value as any)}
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
                                    <button onClick={() => s.setShowMarksModal(true)} className="hover:bg-slate-200 dark:hover:bg-zinc-700 rounded transition-colors text-slate-400 hover:text-indigo-600 p-0.5" title={t('imposition.advancedSettings:cai_dat_dau_xen')}>
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                    </button>
                                </div>
                                <select
                                    value={s.markType}
                                    onChange={e => s.setMarkType(e.target.value as any)}
                                    className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <option value="none">{t('imposition.advancedSettings:khong_ve_dau_xen')}</option>
                                    {s.taskMode !== 'booklet' && <option value="corners">{t('imposition.advancedSettings:xen_4_goc_ngoai_die_cut_bounds_2')}</option>}
                                    <option value="guillotine">{t('imposition.advancedSettings:xen_thanh_pham_guillotine')}</option>
                                </select>
                            </div>
                        )}

                        {/* 4. Chia cọc xén — CHỈ hiện khi tính năng THỰC SỰ áp dụng:
                            - Dàn nhiều loại (ratio_stack): mỗi cọc 1 loại, bề rộng theo tỷ lệ SL.
                            - Bình trang (step_repeat): chia cọc nhân bản cùng loại.
                            Ẩn với Xếp lần lượt / Xếp chồng (chia cọc chưa chạy đúng) → tránh
                            tổ hợp vô nghĩa "chọn cột/hàng mà không thấy gì". */}
                        {((s.taskMode === 'nup' && s.layoutType === 'ratio_stack') || s.taskMode === 'step_repeat') && s.markType === 'guillotine' && !stickerLike && (
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
                                        value={s.clusterMode} onChange={e => s.setClusterMode(e.target.value as any)}
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
                                    <input
                                        type="number" step="0.01" value={s.paperThickness} onChange={e => s.setPaperThickness(Number(e.target.value))}
                                        className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    />
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
                                <input
                                    type="number" step="0.1" value={s.bleed} onChange={e => s.setBleed(Number(e.target.value))}
                                    className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                />
                            </div>
                        </div>
                        )}

                        {/* 6. Output Toggles */}
                        <Divider />
                        <div className="space-y-2">
                            {activeTool === 'sticker_imposer' && (
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
                                    <select value={s.clusterGapMode} onChange={e => s.setClusterGapMode(e.target.value as any)} className="w-full h-9 px-2 border border-slate-300 dark:border-white/20 rounded-lg bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto">
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
