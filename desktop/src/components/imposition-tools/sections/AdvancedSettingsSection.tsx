// @ts-nocheck
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { useShallow } from 'zustand/react/shallow';
import { SectionLabel, Divider, inputCls, Checkbox, RichSelect } from '../SharedUI';
import { DEFAULT_MATERIALS, LAMINATION_OPTIONS, PREDEFINED_SIZES, type ReportFieldKey } from '../types';
import { buildReportPreview } from '../../../lib/reportPreview';

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
        spawnNewTab: state.spawnNewTab, setSpawnNewTab: state.setSpawnNewTab,
        
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
                    <span className="font-bold text-[13px] text-slate-800 dark:text-white uppercase tracking-wide">Thiết lập Mở rộng</span>
                </div>
                <div className="flex items-center gap-2 text-slate-400">
                    <span className="text-xs font-medium">{isExpanded ? 'Đóng lại' : 'Mở rộng'}</span>
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
                        <CollapsibleGroup title="🔻 Bình 2 mặt (CNC)" defaultOpen>
                            <Checkbox
                                checked={s.duplexFlow === 'double'}
                                onChange={(v) => s.setDuplexFlow(v ? 'double' : 'normal')}
                                label="In 2 mặt (lật gương mặt sau)"
                            />
                            {s.duplexFlow === 'double' && sourceTotalPages > 0 && sourceTotalPages % 2 !== 0 && (
                                <div className="text-[11px] text-red-600 dark:text-red-400">
                                    ⚠️ File có {sourceTotalPages} trang (lẻ) — bình 2 mặt cần số trang CHẴN.
                                </div>
                            )}
                            {s.duplexFlow === 'double' && (
                                <>
                                    <div className="flex items-center gap-3">
                                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">CẠNH LẬT</label>
                                        <select
                                            value={s.cncFlipEdge}
                                            onChange={e => s.setCncFlipEdge(e.target.value)}
                                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                        >
                                            <option value="long">Cạnh dài (long-edge) — mặc định</option>
                                            <option value="short">Cạnh ngắn (short-edge)</option>
                                        </select>
                                    </div>
                                    <Checkbox
                                        checked={s.cncDuplexMarks}
                                        onChange={(v) => s.setCncDuplexMarks(v)}
                                        label="Dấu canh in 2 mặt (vẽ cả 2 mặt)"
                                    />
                                </>
                            )}
                        </CollapsibleGroup>
                        )}

                        {/* ══ NHÓM ① ĐỊNH VỊ & CẮT ══ */}
                        {stickerLike && (
                        <CollapsibleGroup title="🎯 Định vị & Cắt" defaultOpen>

                        {/* === BOONG ĐỊNH VỊ (Bế tem & CNC) === */}
                        {stickerLike && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">BOONG ĐỊNH VỊ</label>
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
                                        <option value="none">Không</option>
                                        <option value="corner">Boong Góc Vuông</option>
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
                                        <option value="custom">Tùy chỉnh...</option>
                                    </select>
                                    {s.pontType !== 'none' && (
                                        <button onClick={() => s.setShowPontModal(true)} className="hover:bg-slate-200 dark:hover:bg-zinc-700 rounded transition-colors text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 p-1" title="Tùy chỉnh Boong định vị...">
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* === ĐƯỜNG CẮT (chỉ Bế tem) === */}
                        {activeTool === 'sticker_imposer' && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">ĐƯỜNG CẮT</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <select
                                        value={s.cutType}
                                        onChange={e => s.setCutType(e.target.value)}
                                        className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    >
                                        <option value="default">Mặc định</option>
                                        <option value="one_dao">1 Dao (Dao LETA)</option>
                                    </select>
                                </div>
                            </div>
                        )}

                        {/* KC CỤM PHỤ — chỉ khi 1 Dao */}
                        {activeTool === 'sticker_imposer' && s.cutType === 'one_dao' && (
                            <div className="flex items-center gap-3 relative z-[20] pb-1">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]" title="Khoảng cách giữa cụm chính và cụm phụ (lấp đầy). Chỉ áp dụng khi Xếp tối ưu + Bế 1 Dao.">KC CỤM PHỤ</label>
                                <div className="flex flex-1 items-center gap-2 min-w-0">
                                    <div className="relative flex-1">
                                        <input type="number" step="0.5" min="0" value={s.fillBlockGap} onChange={e => s.setFillBlockGap(Number(e.target.value))}
                                            className="w-full h-8 px-2 pr-8 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium" />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        </CollapsibleGroup>
                        )}

                        {/* === NHÓM ② THÔNG TIN SẢN PHẨM (REPORT) === */}
                        {stickerLike && (
                        <CollapsibleGroup title="🏷️ Thông tin sản phẩm (Report)">

                        {/* === REPORT & XUẤT TỜ DUY NHẤT (sticker_imposer + cnc) === */}
                        {stickerLike && (
                            <div className="flex flex-col gap-3 pb-1">
                                <div className="flex items-center justify-between">
                                    <label className="text-[10px] text-slate-400 italic">Bật & tuỳ chỉnh khối thông tin in lên tờ</label>
                                    <div
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: "Report & Lệnh in",
                                            content: (
                                                <div className="space-y-4">
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        Bình Tem Bế xuất <strong>mỗi loại 1 tờ in duy nhất</strong> (không nhân bản hàng trăm trang giống nhau).
                                                        Số lượng bạn nhập được quy thành <strong>số tờ cần in</strong> và ghi vào khối thông tin (report) ngay trên tờ —
                                                        thợ in chỉ việc đặt máy in đúng số bản đó.
                                                    </p>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Khối report gồm gì?</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            Mã đơn hàng, tên nhãn, chất liệu, cán màng, SL/tờ, <strong>số tờ cần in</strong>, số lượng thực, kích thước…
                                                            Bạn bật/tắt từng trường ở mục “Trường hiển thị”, chọn vị trí (trên/dưới/trái/phải) và cỡ chữ.
                                                        </p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Chất liệu</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            Chọn từ danh sách có sẵn hoặc bấm ＋ để thêm chất liệu riêng của xưởng (lưu lại cho lần sau), 🗑 để xóa chất liệu tự thêm.
                                                        </p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Số tờ cần in tính thế nào?</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            Số tờ = <em>làm tròn lên</em> (Số lượng ÷ Số tem mỗi tờ). VD 1000 tem, 48 tem/tờ → 21 tờ (in dư an toàn).
                                                            Xem bảng chi tiết ở ô “SL mỗi loại”.
                                                        </p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Bỏ dấu tiếng Việt</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">
                                                            Bật khi máy/phần mềm cắt không đọc được chữ có dấu — report sẽ tự chuyển sang chữ không dấu.
                                                        </p>
                                                    </div>
                                                    <p className="text-amber-600 dark:text-amber-400 text-[12px]">
                                                        Việc đặt tên file & lưu ra thư mục được làm ở bước <strong>“Lưu file in”</strong> sau khi bình xong.
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
                                    label="Vẽ report lên tờ in"
                                />

                                {s.reportDisplay.enabled && (
                                    <div className="flex flex-col gap-3 p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg">
                                        {/* Mã đơn hàng + Tên nhãn */}
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">Mã đơn hàng</label>
                                                <input value={s.reportOrderCode} onChange={e => s.setReportOrderCode(e.target.value)} className={inputCls} style={{ paddingLeft: '9px' }} placeholder="VD: DH-001" />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">Tên nhãn</label>
                                                <input value={s.reportDisplay.labelNameText} onChange={e => s.setReportDisplay(prev => ({ ...prev, labelNameText: e.target.value }))} className={inputCls} style={{ paddingLeft: '9px' }} placeholder="VD: Tem sầu riêng" />
                                            </div>
                                        </div>

                                        {/* Chất liệu */}
                                        <div>
                                            <label className="text-[10px] text-slate-500 block mb-1 font-medium">Chất liệu</label>
                                            <div className="flex items-center gap-2">
                                                <select
                                                    value={s.reportMaterial}
                                                    onChange={e => s.setReportMaterial(e.target.value)}
                                                    className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500"
                                                >
                                                    <option value="">— Chọn chất liệu —</option>
                                                    {[...DEFAULT_MATERIALS, ...s.customMaterials].map((m: string) => (
                                                        <option key={m} value={m}>{m}</option>
                                                    ))}
                                                </select>
                                                <button
                                                    title="Thêm chất liệu mới"
                                                    onClick={() => setMatInput('')}
                                                    className="shrink-0 w-8 h-8 rounded border border-slate-300 dark:border-white/20 text-slate-500 hover:text-indigo-600 hover:border-indigo-400"
                                                >＋</button>
                                                <button
                                                    title="Xóa chất liệu tùy chỉnh đang chọn"
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
                                                        placeholder="Tên chất liệu mới..."
                                                        className={inputCls}
                                                        style={{ paddingLeft: '9px' }}
                                                    />
                                                    <button onClick={addMaterial} className="shrink-0 h-8 px-3 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-[12px] font-bold">Lưu</button>
                                                    <button onClick={() => setMatInput(null)} className="shrink-0 h-8 px-3 rounded border border-slate-300 dark:border-white/20 text-[12px]">Hủy</button>
                                                </div>
                                            )}
                                        </div>

                                        {/* Cán màng */}
                                        <div>
                                            <label className="text-[10px] text-slate-500 block mb-1 font-medium">Cán màng</label>
                                            <select value={s.reportLamination} onChange={e => s.setReportLamination(Number(e.target.value))}
                                                className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500">
                                                {LAMINATION_OPTIONS.map((o: string, i: number) => <option key={i} value={i}>{o}</option>)}
                                            </select>
                                        </div>

                                        {/* Trường hiển thị */}
                                        <div>
                                            <label className="text-[10px] text-slate-500 block mb-1 font-medium">Trường hiển thị trên report</label>
                                            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                                {REPORT_SHOW_KEYS.map(([flag, key]) => (
                                                    <Checkbox
                                                        key={flag}
                                                        checked={(s.reportDisplay as any)[flag]}
                                                        onChange={(v) => s.setReportDisplay(prev => ({ ...prev, [flag]: v }))}
                                                        label={REPORT_FIELD_LABELS[key]}
                                                    />
                                                ))}
                                            </div>
                                        </div>

                                        {/* Vị trí + cỡ chữ */}
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title="Report sẽ được in ở mép nào của tờ in: trên / dưới / trái / phải.">Vị trí in trên tờ</label>
                                                <select value={s.reportDisplay.position} onChange={e => s.setReportDisplay(prev => ({ ...prev, position: e.target.value }))}
                                                    className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500">
                                                    <option value="top">Mép trên</option>
                                                    <option value="bottom">Mép dưới</option>
                                                    <option value="left">Mép trái</option>
                                                    <option value="right">Mép phải</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium">Cỡ chữ (pt)</label>
                                                <input type="number" min={4} max={40} step={0.5} value={s.reportDisplay.fontSize}
                                                    onChange={e => s.setReportDisplay(prev => ({ ...prev, fontSize: Number(e.target.value) }))}
                                                    className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>

                                        {/* Canh giữa (mặc định BẬT) — tự căn giữa report theo mép đã chọn */}
                                        <Checkbox
                                            checked={s.reportDisplay.centered ?? true}
                                            onChange={(v) => s.setReportDisplay(prev => ({ ...prev, centered: v }))}
                                            label="Canh giữa theo mép (mặc định)"
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
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title="Khoảng cách theo phương NGANG tính từ mép trái tờ in (mm). Bị bỏ qua khi canh giữa ngang.">Cách lề X (mm)</label>
                                                <input type="number" min={0} step={0.5} disabled={xDisabled} value={s.reportDisplay.offsetX ?? 5}
                                                    onChange={e => s.setReportDisplay(prev => ({ ...prev, offsetX: Number(e.target.value) }))}
                                                    className={inputCls} style={{ paddingLeft: '9px', opacity: xDisabled ? 0.4 : 1 }} />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-slate-500 block mb-1 font-medium" title="Khoảng cách tính từ mép đã chọn (mm). Bị bỏ qua khi canh giữa dọc.">Cách lề Y (mm)</label>
                                                <input type="number" min={0} step={0.5} disabled={yDisabled} value={s.reportDisplay.offsetY ?? 5}
                                                    onChange={e => s.setReportDisplay(prev => ({ ...prev, offsetY: Number(e.target.value) }))}
                                                    className={inputCls} style={{ paddingLeft: '9px', opacity: yDisabled ? 0.4 : 1 }} />
                                            </div>
                                        </div>
                                            );
                                        })()}

                                        <Checkbox checked={s.reportDisplay.removeDiacritics}
                                            onChange={(v) => s.setReportDisplay(prev => ({ ...prev, removeDiacritics: v }))}
                                            label="Bỏ dấu tiếng Việt" />

                                        {/* Xem trước report NGAY tại đây (tick tới đâu thấy tới đó) */}
                                        {(() => {
                                            const sw = s.formsize === 'custom' ? s.customSheetWidth : (PREDEFINED_SIZES[s.formsize]?.w || s.customSheetWidth);
                                            const sh = s.formsize === 'custom' ? s.customSheetHeight : (PREDEFINED_SIZES[s.formsize]?.h || s.customSheetHeight);
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
                                                modeLabel: activeTool === 'cnc_imposer' ? 'Bình bế rớt (CNC)' : 'Bế tem',
                                            });
                                            const posLabel = { top: 'mép trên', bottom: 'mép dưới', left: 'mép trái', right: 'mép phải' }[s.reportDisplay.position] || 'mép trên';
                                            return (
                                                <div className="rounded-md border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 px-2.5 py-1.5 mt-1">
                                                    <div className="text-[10px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300 mb-0.5">📋 Xem trước — sẽ in ở {posLabel}</div>
                                                    <div className="text-[11px] text-slate-700 dark:text-zinc-200 leading-snug break-words">{previewStr || '(chưa có nội dung — hãy tick các trường ở trên)'}</div>
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
                        <CollapsibleGroup title="💾 Xuất & Lưu file" infoButton={
                                <div
                                    className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                    title="Giải thích cách lưu file"
                                    onClick={() => setInfoModal({
                                        title: "Tự động lưu file in",
                                        content: (
                                            <div className="space-y-4 text-[13px]">
                                                <p className="text-slate-600 dark:text-zinc-300">
                                                    Bật mục này để <b>sau khi bình xong, hệ thống tự tách từng tờ và ghi ra ổ cứng</b> vào thư mục bạn chọn (vẫn mở tab kết quả để xem lại).
                                                    Mỗi loại tem được tách thành file riêng (Bế tem: <b>file In</b> + <b>file Bế</b>; CNC: <b>Mặt trước / Mặt sau / Khuôn</b>).
                                                </p>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">Cách đặt tên file</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        • <b>Theo report</b>: dùng Mã đơn hàng + Tên nhãn + số tờ (lấy ở mục ② Thông tin sản phẩm). VD: <code>1 - DH-001 - Tem sầu riêng - 21 tờ.pdf</code><br/>
                                                        • <b>Đánh số</b>: 1.pdf, 2.pdf, 3.pdf…<br/>
                                                        • <b>Giữ tên gốc</b>: dùng tên file gốc.
                                                    </p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">Cách sắp xếp thư mục</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        • <b>Gom theo đơn hàng</b>: tạo 1 thư mục mang tên đơn, bên trong chia thư mục con. VD:
                                                    </p>
                                                    <pre className="text-[11px] bg-slate-100 dark:bg-zinc-800 rounded p-2 leading-snug">📁 DH-001/
   📁 In/    → các file in
   📁 Bế/    → các file khuôn bế</pre>
                                                    <p className="text-slate-600 dark:text-zinc-300">
                                                        • <b>Để chung một chỗ</b>: tất cả file nằm thẳng trong thư mục đã chọn, không tạo thư mục con.
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
                                    🖨️ Tự động lưu file in sau khi bình
                                </label>
                                {s.savePrint.autoSave && (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <button type="button"
                                                onClick={async () => {
                                                    try {
                                                        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
                                                        const dir = await openDialog({ directory: true, multiple: false, title: 'Chọn thư mục lưu file in' });
                                                        if (typeof dir === 'string') s.setSavePrint({ lastFolder: dir });
                                                    } catch (e) { /* ignore */ }
                                                }}
                                                className="px-2.5 h-7 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-medium shrink-0">Chọn thư mục…</button>
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-300 truncate flex-1" title={s.savePrint.lastFolder}>
                                                {s.savePrint.lastFolder || 'Chưa chọn thư mục'}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                            <span className="text-slate-500">Tên file:</span>
                                            {[
                                                ['report', 'Theo report', 'Mã ĐH - Tên nhãn - số tờ (lấy ở mục ② Thông tin sản phẩm)'],
                                                ['number', 'Đánh số', '1.pdf, 2.pdf, 3.pdf…'],
                                                ['original', 'Giữ tên gốc', 'Dùng tên file gốc'],
                                            ].map(([v, lbl, tip]) => (
                                                <label key={v} className="flex items-center gap-1 cursor-pointer" title={tip}>
                                                    <input type="radio" name="autoNameMode" checked={s.savePrint.nameMode === v}
                                                        onChange={() => s.setSavePrint({ nameMode: v as any })} />{lbl}
                                                </label>
                                            ))}
                                        </div>
                                        {s.savePrint.nameMode === 'report' && (
                                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 -mt-1">
                                                ↳ Tên file lấy <b>Mã đơn hàng + Tên nhãn</b> ở mục <b>② Thông tin sản phẩm</b>.
                                            </p>
                                        )}
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                                            <span className="text-slate-500">Sắp xếp:</span>
                                            <label className="flex items-center gap-1 cursor-pointer" title="Tạo một thư mục mang tên đơn hàng; bên trong chia thư mục con (In / Bế — hoặc Mặt trước / Mặt sau / Khuôn cho CNC).">
                                                <input type="radio" name="autoFolderMode" checked={s.savePrint.folderMode === 'per_order'}
                                                    onChange={() => s.setSavePrint({ folderMode: 'per_order' })} />Gom theo đơn hàng
                                            </label>
                                            <label className="flex items-center gap-1 cursor-pointer" title="Tất cả file nằm thẳng trong thư mục đã chọn, không tạo thư mục con.">
                                                <input type="radio" name="autoFolderMode" checked={s.savePrint.folderMode === 'flat'}
                                                    onChange={() => s.setSavePrint({ folderMode: 'flat' })} />Để chung một chỗ
                                            </label>
                                        </div>
                                        {!s.savePrint.lastFolder && (
                                            <p className="text-[10px] text-amber-600 dark:text-amber-400">Chọn thư mục để bật tự động lưu; nếu trống sẽ hỏi khi lưu thủ công.</p>
                                        )}
                                    </>
                                )}
                            </div>
                        </CollapsibleGroup>
                        )}

                        {/* 1. Grouping Strategy — CHỈ die-cut (Bế tem/CNC). Guillotine (Bình
                            bài xén) render lưới đều, KHÔNG dùng grouping → ẩn để tránh control
                            vô tác dụng / lệch preview-output. */}
                        {s.taskMode !== 'booklet' && stickerLike && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">CÁCH CHIA CỤM</label>
                                <div
                                    className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                    onClick={() => setInfoModal({
                                        title: "Cách chia cụm (Grouping)",
                                        content: (
                                            <div className="space-y-4">
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">Không</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">Dàn tem trực tiếp lấp đầy tờ in theo cách thông thường.</p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">Chia đều diện tích / Số lượng</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">Dùng cho in N-Up nhiều mẫu. Tự động chia tỉ lệ diện tích giấy in theo số lượng tem của mỗi mẫu.</p>
                                                </div>
                                                <div className="space-y-1">
                                                    <h4 className="font-bold text-slate-800 dark:text-white">Cụm nhân bản (Cluster Tile)</h4>
                                                    <p className="text-slate-600 dark:text-zinc-300">Chia mặt giấy thành các cụm không gian, sau đó nhân bản mẫu thiết kế lấp đầy cụm đó. Hữu ích cho in vé xe hoặc tem nhãn chia dải.</p>
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
                                <option value="none">Không chia cụm</option>
                                {s.taskMode !== 'step_repeat' && (
                                    <>
                                        <option value="maximize_area">Chia đều diện tích</option>
                                        <option value="strict_ratio">Chia đều số lượng</option>
                                    </>
                                )}
                                <option value="cluster_tile">Cụm nhân bản (Cluster Tile)</option>
                            </select>

                            {/* Cluster Tile Settings */}
                            {s.groupingStrategy === 'cluster_tile' && (
                                <div className="mt-2 flex flex-col gap-3 p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg">
                                    <div className="flex items-center gap-3">
                                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide shrink-0 w-[65px]">Định cỡ</label>
                                        <select
                                            value={s.clusterSizingMode}
                                            onChange={(e) => s.setClusterSizingMode(e.target.value as 'dims' | 'grid')}
                                            className="flex-1 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-[13px] font-medium focus:outline-none focus:border-indigo-500"
                                        >
                                            <option value="dims">Theo khổ W x H</option>
                                            <option value="split_cols">Chia theo Cột dọc</option>
                                            <option value="split_rows">Chia theo Hàng ngang</option>
                                        </select>
                                    </div>

                                    {s.clusterSizingMode === 'dims' ? (
                                        <div className="flex flex-col gap-2 border-b border-slate-200 dark:border-white/10 pb-3">
                                            <div className="flex items-center gap-3">
                                                <label className="text-[11px] text-slate-500 shrink-0 w-[65px]">Khổ chuẩn</label>
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
                                                    <option value="custom">Tùy chỉnh...</option>
                                                </select>
                                            </div>
                                            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                                                <div>
                                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Rộng cụm (mm)</label>
                                                    <input type="number" min={10} max={600} step={1} value={s.clusterTileW} onChange={(e) => s.setClusterTileW(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                                </div>
                                                <div>
                                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Cao cụm (mm)</label>
                                                    <input type="number" min={10} max={600} step={1} value={s.clusterTileH} onChange={(e) => s.setClusterTileH(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                                </div>
                                            </div>
                                        </div>
                                    ) : s.clusterSizingMode === 'split_cols' ? (
                                        <div className="grid grid-cols-1 gap-x-3 gap-y-3 border-b border-slate-200 dark:border-white/10 pb-3">
                                            <div>
                                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">Số cột dọc</label>
                                                <input type="number" min={1} max={20} step={1} value={s.clusterCols} onChange={(e) => s.setClusterCols(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>
                                    ) : s.clusterSizingMode === 'split_rows' ? (
                                        <div className="grid grid-cols-1 gap-x-3 gap-y-3 border-b border-slate-200 dark:border-white/10 pb-3">
                                            <div>
                                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">Số hàng ngang</label>
                                                <input type="number" min={1} max={20} step={1} value={s.clusterRows} onChange={(e) => s.setClusterRows(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                            </div>
                                        </div>
                                    ) : null}

                                    <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                                        <div>
                                            <label className="text-[11px] text-slate-500 block mb-1 font-medium">Khoảng hở dọc (mm)</label>
                                            <input type="number" min={0} max={50} step={0.5} value={s.tileGapX} onChange={(e) => s.setTileGapX(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                        </div>
                                        <div>
                                            <label className="text-[11px] text-slate-500 block mb-1 font-medium">Khoảng hở ngang (mm)</label>
                                            <input type="number" min={0} max={50} step={0.5} value={s.tileGapY} onChange={(e) => s.setTileGapY(Number(e.target.value))} className={inputCls} style={{ paddingLeft: '9px' }} />
                                        </div>
                                    </div>

                                    {stickerLike && (
                                        <div className="mt-1">
                                            <Checkbox checked={s.clusterNesting} onChange={s.setClusterNesting} label="Bình lồng sát trong cụm (Nesting)" />
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
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">CANH KHỐI SAU KHI XẾP</label>
                                    <div
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: "Canh khối (Alignment)",
                                            content: (
                                                <div className="space-y-4">
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Canh Giữa trung tâm (Mặc định)</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">Toàn bộ khối thiết kế sau khi dàn sẽ được canh giữa tờ giấy. Phù hợp với đại đa số ấn phẩm.</p>
                                                    </div>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Canh Góc / Cạnh</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">Đẩy toàn bộ khối thiết kế dồn về một góc hoặc một cạnh của tờ giấy in. Hữu ích khi bạn muốn chừa phần giấy thừa ra một bên để tận dụng in ghép cái khác, hoặc khi máy in bị lệch biên.</p>
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
                                    <option value="top-left">Canh Góc Trái - Trên</option>
                                    <option value="top-center">Canh Giữa - Trên</option>
                                    <option value="top-right">Canh Góc Phải - Trên</option>
                                    <option value="center-left">Canh Trái - Giữa</option>
                                    <option value="center">Canh Giữa trung tâm</option>
                                    <option value="center-right">Canh Phải - Giữa</option>
                                    <option value="bottom-left">Canh Góc Trái - Dưới</option>
                                    <option value="bottom-center">Canh Giữa - Dưới</option>
                                    <option value="bottom-right">Canh Góc Phải - Dưới</option>
                                </select>
                            </div>
                        )}

                        {/* 3. Trim Marks */}
                        {s.taskMode !== 'offset' && !stickerLike && (
                            <div className="relative z-[20]">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">DẤU XÉN (TRIM MARKS)</label>
                                        <div
                                            className="shrink-0 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                            onClick={() => setInfoModal({
                                                title: "Dấu xén (Trim Marks)",
                                                content: (
                                                    <div className="space-y-4">
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">Không vẽ dấu xén</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">Chỉ dàn trang, không vẽ thêm bất kỳ vạch cắt nào.</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">Xén 4 góc ngoài (Die-cut Bounds)</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">Chỉ vẽ 4 góc bo giới hạn toàn bộ khu vực dàn trang. Thường dùng khi bế viền (Tem nhãn) để máy bế nhận diện giới hạn tờ in mà không cần cắt rời từng con tem.</p>
                                                        </div>
                                                        <div className="space-y-1">
                                                            <h4 className="font-bold text-slate-800 dark:text-white">Xén thành phẩm (Guillotine)</h4>
                                                            <p className="text-slate-600 dark:text-zinc-300">Vẽ đầy đủ các vạch bo góc và vạch chia cắt giữa các sản phẩm (cả hàng dọc và ngang). Dùng khi dùng máy xén xén đứt rời thành phẩm (VD: Namecard, tờ rơi).</p>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                        </div>
                                    </div>
                                    <button onClick={() => s.setShowMarksModal(true)} className="hover:bg-slate-200 dark:hover:bg-zinc-700 rounded transition-colors text-slate-400 hover:text-indigo-600 p-0.5" title="Cài đặt dấu xén...">
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                    </button>
                                </div>
                                <select
                                    value={s.markType}
                                    onChange={e => s.setMarkType(e.target.value as any)}
                                    className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <option value="none">Không vẽ dấu xén</option>
                                    {s.taskMode !== 'booklet' && <option value="corners">Xén 4 Góc ngoài (Die-cut bounds)</option>}
                                    <option value="guillotine">Xén thành phẩm (Guillotine)</option>
                                </select>
                            </div>
                        )}

                        {/* 4. Guillotine Batching */}
                        {(s.taskMode === 'nup' || s.taskMode === 'step_repeat' || s.taskMode === 'sticker_imposer') && s.markType === 'guillotine' && !stickerLike && (
                            <div className="relative z-[10]">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0">CHIA CỌC XÉN (GUILLOTINE BATCHING)</label>
                                    <div
                                        className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-indigo-600 cursor-pointer transition-colors"
                                        onClick={() => setInfoModal({
                                            title: "Chia cọc xén (Guillotine Batching)",
                                            content: (
                                                <div className="space-y-4">
                                                    <p className="text-slate-600 dark:text-zinc-300">Tính năng nâng cao dành cho thợ vận hành máy xén. Giúp tự động tách toàn bộ lưới dàn trang thành các "cọc" (batch) riêng biệt, chừa sẵn rãnh dao (gutter) giữa các cọc để máy xén đưa dao chém một cách an toàn mà không phạm vào thiết kế.</p>
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-slate-800 dark:text-white">Chia theo Hàng / Cột</h4>
                                                        <p className="text-slate-600 dark:text-zinc-300">Cắt toàn bộ lưới giấy thành 2, 3, hoặc nhiều cọc theo chiều dọc hoặc ngang, giảm thiểu số lần chém mồi của máy cắt.</p>
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
                                        <option value="none">Không chia cọc</option>
                                        <option value="row">Chia theo Hàng (Ngang)</option>
                                        <option value="column">Chia theo Cột (Dọc)</option>
                                    </select>
                                    {s.clusterMode !== 'none' && (
                                        <div className="flex items-center gap-2">
                                            <input type="number" min="2" value={s.clusterCount} onChange={e => s.setClusterCount(Math.max(2, parseInt(e.target.value) || 2))} className="w-14 h-8 px-2 font-medium border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 text-center" title="Số Cọc (Batches)" />
                                            <button onClick={() => setShowClusterModal(true)} className="w-8 h-8 flex items-center justify-center border border-slate-300 dark:border-white/20 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors text-slate-500 hover:text-indigo-600" title="Cài đặt nâng cao">
                                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                            </button>
                                        </div>
                                    )}
                                </div>
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
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide block -mb-0.5" title="Sử dụng độ dày giấy để bù lẹm gáy (Creep compensation)">Dày giấy/Creep (mm)</label>
                                    <input
                                        type="number" step="0.01" value={s.paperThickness} onChange={e => s.setPaperThickness(Number(e.target.value))}
                                        className="w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                    />
                                </div>
                            )}
                            <div className="flex flex-col gap-2 h-full justify-end">
                                <div className="flex items-center justify-between -mb-0.5">
                                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">Lề xén Bleed</label>
                                    <button
                                        onClick={() => s.setShowBleedView(!s.showBleedView)}
                                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors ${s.showBleedView ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400' : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-400'}`}
                                        title={s.showBleedView ? "Tắt đường viền Xem trước Bleed" : "Bật đường viền Xem trước Bleed"}
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
                                <Checkbox checked={s.separateCutPage} onChange={s.setSeparateCutPage} label="Tách trang khuôn bế riêng" />
                            )}
                            <Checkbox checked={s.spawnNewTab} onChange={s.setSpawnNewTab} label="Mở kết quả sang Tab mới" />
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
                                Đã hiểu
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
                            <h3 className="text-lg font-bold text-slate-800 dark:text-white">Nâng cao: Chia cọc xén</h3>
                            <button onClick={() => setShowClusterModal(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 transition-colors">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 flex flex-col gap-4">
                            <div>
                                <label className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide block mb-1.5">KIỂU PHÂN BỔ CỌC (PATTERN)</label>
                                <RichSelect
                                    value={s.clusterDistribution}
                                    onChange={(v) => s.setClusterDistribution(v as any)}
                                    options={[
                                        { value: 'default', title: 'Mặc định (Chia đều)', desc: 'Trải đều các trang lên lưới rập cắt, rồi nhân bản lưới đó sang các cọc.' },
                                        { value: 'type', title: 'Thuần chủng (Theo loại)', desc: 'Tất cả vị trí trong 1 cọc chỉ chứa duy nhất 1 trang hoặc 1 loại file.' }
                                    ]}
                                />
                            </div>
                            <Divider />
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide block mb-1.5">KHOẢNG CÁCH TỪ</label>
                                    <select value={s.clusterGapMode} onChange={e => s.setClusterGapMode(e.target.value as any)} className="w-full h-9 px-2 border border-slate-300 dark:border-white/20 rounded-lg bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium appearance-auto">
                                        <option value="item">Mép tem con</option>
                                        <option value="mark">Dấu xén ngoài</option>
                                    </select>
                                </div>
                                <div className="hidden">
                                    {/* Khoảng cách hở moved to PaperSettingsUI */}
                                </div>
                            </div>
                            <div className="mt-2 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-200 dark:border-white/10">
                                <Checkbox checked={s.clusterBorder} onChange={s.setClusterBorder} label="Vẽ đường viền giới hạn quanh mỗi cọc (Cluster Border)" />
                            </div>
                        </div>
                        <div className="px-5 py-4 bg-slate-50 dark:bg-zinc-800/50 border-t border-slate-200 dark:border-white/10 flex justify-end">
                            <button onClick={() => setShowClusterModal(false)} className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors">
                                Xong
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
