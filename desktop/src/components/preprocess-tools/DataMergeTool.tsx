import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { startVdpDrag } from '../../utils/vdpDrag';
import Papa from 'papaparse';
import { startVdpJobBackend, pollVdpJob, cancelVdpJobBackend, readVdpDatasource, listVdpSheets, previewVdpRecord, validateVdp, downloadVdpErrorReport, type VdpFieldError, type VdpIssue, type VdpGating, type VdpProgressInfo } from '@/lib/api'; // UIUX (audit 2026-07-27 §D-07)
import { toast } from '../ui/Toast'; // UIUX (audit 2026-07-27 §D-04)
import { confirmDialog } from '../ui/confirmDialog'; // UIUX (audit 2026-07-27 §D-06)
import { ProgressBar } from '../ui/ProgressBar'; // UIUX (audit 2026-07-27 §D-07)
import { formatError, isCanceled } from '@/lib/errorMessages'; // UIUX (audit 2026-07-27 §D-15)
import { generateBarcodeDataURL } from '@/engine/barcode/barcodeEngine';
import { FontSelector } from './FontSelector';
import { ToolDivider, ToolNumberInput } from './ToolUI';
import { useVdpTool } from '@/hooks/useVdpTool';
import { VdpAlignPanel } from './VdpAlignPanel';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useTranslation } from 'react-i18next';
import { tv } from '@/i18n';

// ─── CMYK ↔ Hex Conversion Helpers ──────────────────────
function hexToCmyk(hex: string): { c: number; m: number; y: number; k: number } {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    const k = 1 - Math.max(r, g, b);
    if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
    return {
        c: Math.round(((1 - r - k) / (1 - k)) * 100),
        m: Math.round(((1 - g - k) / (1 - k)) * 100),
        y: Math.round(((1 - b - k) / (1 - k)) * 100),
        k: Math.round(k * 100),
    };
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
    const r = Math.round(255 * (1 - c / 100) * (1 - k / 100));
    const g = Math.round(255 * (1 - m / 100) * (1 - k / 100));
    const b = Math.round(255 * (1 - y / 100) * (1 - k / 100));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ─── CMYK Color Picker Component ────────────────────────
export function CmykColorPicker({ label, value, onChange, disabled }: { label?: string; value: string; onChange: (hex: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);
    const cmyk = hexToCmyk(value || '#000000');
    const inputClass = "w-full bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded p-1 text-xs text-center font-mono";

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        if (isOpen) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isOpen]);

    return (
        <div className="flex flex-col gap-1 relative" ref={popoverRef}>
            <label className="text-[10px] text-slate-600 dark:text-zinc-400 font-medium">{label}</label>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    disabled={disabled}
                    className="w-8 h-8 rounded border border-slate-300 shadow-sm shrink-0 cursor-pointer hover:scale-105 transition-transform"
                    style={{ backgroundColor: value || '#000000' }}
                    onClick={() => setIsOpen(!isOpen)}
                />
                <span className="text-[12px] font-mono text-slate-500 uppercase tracking-tight">
                    C{cmyk.c} M{cmyk.m} Y{cmyk.y} K{cmyk.k}
                </span>
            </div>
            
            {isOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 p-3 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-lg shadow-xl w-48 animate-fade-in origin-top-left">
                    <div className="text-[10px] font-bold text-slate-600 dark:text-zinc-400 mb-2 uppercase tracking-wider">{t('preprocess.dataMerge:thong_so_cmyk')}</div>
                    <div className="flex gap-1">
                        {(['c', 'm', 'y', 'k'] as const).map(ch => (
                            <div key={ch} className="flex flex-col items-center flex-1 min-w-0">
                                <input
                                    type="number" min={0} max={100}
                                    value={cmyk[ch]}
                                    onChange={(e) => {
                                        const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                                        const next = { ...cmyk, [ch]: v };
                                        onChange(cmykToHex(next.c, next.m, next.y, next.k));
                                    }}
                                    className={inputClass}
                                    disabled={disabled}
                                />
                                <span className="text-[8px] text-slate-400 font-bold uppercase mt-1">{ch}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Section thu/xổ (accordion) cho panel VDP ───
function VdpSection({ step, title, badge, defaultOpen = true, accent, children }: { step?: string; title: string; badge?: React.ReactNode; defaultOpen?: boolean; accent?: boolean; children: React.ReactNode }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className={`shrink-0 rounded-lg border overflow-hidden ${accent ? 'border-blue-300 dark:border-blue-700' : 'border-slate-200 dark:border-zinc-700'}`}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className={`w-full flex items-center justify-between px-3 py-2 transition-colors ${accent ? 'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30' : 'bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800'}`}
            >
                <span className="text-[13px] font-bold text-slate-700 dark:text-zinc-200 flex items-center gap-2">
                    {step && <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] text-white ${accent ? 'bg-blue-500' : 'bg-slate-400 dark:bg-zinc-600'}`}>{step}</span>}
                    {title}
                    {badge}
                </span>
                <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {open && <div className="p-3 space-y-3">{children}</div>}
        </div>
    );
}

// ─── Logic điều kiện (Req 2): ẩn/hiện field + bảng rule cho field ───
type VdpOperator = 'eq' | 'ne' | 'contains' | 'empty' | 'not_empty';

interface VdpFieldCondition {
    column: string;
    operator: VdpOperator;
    value: string;
    action: 'show_if' | 'hide_if';
}

interface VdpRule {
    column: string;
    operator: VdpOperator;
    value: string;
    result: string;
}

// Toán tử so sánh hỗ trợ (Req 2.9) — nhãn tiếng Việt.
const VDP_OPERATORS: { value: VdpOperator; label: string }[] = [
    { value: 'eq', label: 'Bằng' },
    { value: 'ne', label: 'Khác' },
    { value: 'contains', label: 'Chứa' },
    { value: 'empty', label: 'Rỗng' },
    { value: 'not_empty', label: 'Khác rỗng' },
];

// 'empty'/'not_empty' không cần ô giá trị so sánh.
const operatorNeedsValue = (op: VdpOperator) => op !== 'empty' && op !== 'not_empty';

// Panel cấu hình điều kiện ẩn/hiện (conditions) và bảng rule (rules) cho field
// đang chọn. Persist qua onChange → updateSelectedField để gửi kèm field tới backend.
function VdpLogicPanel({ field, csvHeaders, onChange, isActive }: {
    field: any;
    isActive: boolean;
    csvHeaders: string[];
    onChange: (changes: any) => void;
}) {
  const { t } = useTranslation();
    const conditions: VdpFieldCondition[] = Array.isArray(field.conditions) ? field.conditions : [];
    const rules: VdpRule[] = Array.isArray(field.rules) ? field.rules : [];
    const defaultCol = csvHeaders[0] || '';
    const [showHelp, setShowHelp] = useState(false);

    // Đóng modal trợ giúp bằng phím ESC (chỉ gắn listener khi modal đang mở).
    useEffect(() => {
        if (!showHelp || !isActive) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                setShowHelp(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showHelp, isActive]);

    const inputClass = "h-8 px-2 text-[12px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded focus:outline-none focus:border-teal-500 transition-all";
    const selectClass = inputClass + " font-medium";

    // ── Conditions (ẩn/hiện) ──
    const addCondition = () => onChange({ conditions: [...conditions, { column: defaultCol, operator: 'eq', value: '', action: 'show_if' } as VdpFieldCondition] });
    const updateCondition = (i: number, changes: Partial<VdpFieldCondition>) =>
        onChange({ conditions: conditions.map((c, idx) => idx === i ? { ...c, ...changes } : c) });
    const removeCondition = (i: number) =>
        onChange({ conditions: conditions.filter((_, idx) => idx !== i) });

    // ── Rules (bảng rule first-match) ──
    const addRule = () => onChange({ rules: [...rules, { column: defaultCol, operator: 'eq', value: '', result: '' } as VdpRule] });
    const updateRule = (i: number, changes: Partial<VdpRule>) =>
        onChange({ rules: rules.map((r, idx) => idx === i ? { ...r, ...changes } : r) });
    const removeRule = (i: number) =>
        onChange({ rules: rules.filter((_, idx) => idx !== i) });

    const columnOptions = (selected: string) => (
        <>
            {!csvHeaders.includes(selected) && <option value={selected}>{selected || t('preprocess.dataMerge:chon_cot')}</option>}
            {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
        </>
    );

    return (
        <div className="flex flex-col gap-4">
            {/* Nút trợ giúp: mở modal giải thích "khi nào dùng" bằng ví dụ đời thường */}
            <div className="flex items-start gap-2 text-[11px] text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 rounded p-2">
                <span className="flex-1">
                    {t('preprocess.dataMerge:dung_khi')} <b>{t('preprocess.dataMerge:cac_ban_in_can_khac_nhau_theo_du_lieu')}</b> {t('preprocess.dataMerge:vd_chi_mot_so_tem_co_dau_vip_hoac_doi')}
                </span>
                <button
                    type="button"
                    onClick={() => setShowHelp(true)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-500/10 dark:hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-700 rounded font-medium transition-colors"
                    title={t('preprocess.dataMerge:khi_nao_dung_xem_vi_du')}
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" /><path strokeLinecap="round" d="M12 16.5h.01" /></svg>
                    {t('preprocess.dataMerge:khi_nao_dung')}
                </button>
            </div>

            {showHelp && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
                    onClick={() => setShowHelp(false)}
                >
                    <div
                        className="max-w-lg w-full max-h-[80vh] overflow-auto bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-slate-200 dark:border-zinc-700"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700 sticky top-0 bg-white dark:bg-zinc-900">
                            <span className="text-[14px] font-bold text-slate-800 dark:text-zinc-100">{t('preprocess.dataMerge:logic_dieu_kien_khi_nao_dung')}</span>
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                                title={t('preprocess.dataMerge:dong')}
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-4 space-y-4 text-[12px] text-slate-600 dark:text-zinc-300 leading-relaxed">
                            <p>
                                {t('preprocess.dataMerge:ban_in')} <b>{t('preprocess.dataMerge:nhieu_ban_tu_mot_bang_du_lieu')}</b> {t('preprocess.dataMerge:moi_dong_mot_tem_binh_thuong_giong_khuon')}
                                <b> {t('preprocess.dataMerge:mot_so_ban_can_khac_nhau_tuy_dong')}</b>.
                            </p>

                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.dataMerge:dieu_kien_an_hien')}</div>
                                <div className="mb-1">{t('preprocess.dataMerge:quyet_dinh')} <b>{t('preprocess.dataMerge:co_in_chi_tiet_nay_hay_khong')}</b>.</div>
                                <div className="text-slate-500 dark:text-zinc-400">
                                    {t('preprocess.dataMerge:vi_du_ve_san_dau_vip')} <i>{t('preprocess.dataMerge:hien_neu')}</i> {t('preprocess.dataMerge:cot')} <code>{t('preprocess.dataMerge:hang')}</code> <i>{t('preprocess.dataMerge:bang')}</i> <code>VIP</code>.
                                    {t('preprocess.dataMerge:chi_khach_vip_moi_in_dau')}
                                </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.dataMerge:bang_rule_doi_noi_dung_anh')}</div>
                                <div className="mb-1">Field <b>{t('preprocess.dataMerge:van_in')}</b>{t('preprocess.dataMerge:nhung')} <b>{t('preprocess.dataMerge:doi_chu_anh_theo_du_lieu')}</b>{t('preprocess.dataMerge:xet_tu_tren_xuong_gap_dong_dung_dau')}</div>
                                <div className="text-slate-500 dark:text-zinc-400">
                                    {t('preprocess.dataMerge:vi_du_anh_cot')} <code>{t('preprocess.dataMerge:nuoc')}</code> <i>{t('preprocess.dataMerge:bang')}</i> <code>VN</code> → <code>co_vn.png</code>;
                                    <code>US</code> → <code>co_us.png</code>{t('preprocess.dataMerge:moi_ban_tu_lay_dung_co')}
                                    <br />
                                    {t('preprocess.dataMerge:vi_du_chu_cot')} <code>{t('preprocess.dataMerge:diem')}</code> <i>{t('preprocess.dataMerge:chua')}</i> {t('preprocess.dataMerge:in_vang_bac')}
                                </div>
                            </div>

                            <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                                <b>{t('preprocess.dataMerge:phan_biet_nhanh')}</b> {t('preprocess.dataMerge:an_hien_co_in_khong_rule_in_cai_gi')}
                            </div>
                        </div>
                        <div className="px-4 py-3 border-t border-slate-200 dark:border-zinc-700 text-right">
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-[12px] px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded font-medium transition-colors"
                            >
                                {t('preprocess.dataMerge:da_hieu')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {csvHeaders.length === 0 && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-2 rounded">
                    {t('preprocess.dataMerge:chua_nap_du_lieu_nguon_hay_nap_csv')}
                </div>
            )}

            {/* ── Điều kiện ẩn/hiện ── */}
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">{t('preprocess.dataMerge:dieu_kien_an_hien_2')}</span>
                    <button
                        type="button"
                        onClick={addCondition}
                        className="text-[11px] px-2 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-500/10 dark:hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-700 rounded font-medium transition-colors"
                    >
                        {t('preprocess.dataMerge:them_dieu_kien')}
                    </button>
                </div>
                <span className="text-[10px] text-slate-500 dark:text-zinc-400 italic">
                    {t('preprocess.dataMerge:neu_cot_thoa_dieu_kien_hien_show_if')}
                </span>
                <span className="text-[10px] text-teal-700 dark:text-teal-400">
                    {t('preprocess.dataMerge:vi_du_hien_neu')} <b>{t('preprocess.dataMerge:hang')}</b> {t('preprocess.dataMerge:bang')} <b>VIP</b> {t('preprocess.dataMerge:chi_khach_vip_moi_in_field_nay')}
                </span>
                {conditions.length === 0 ? (
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500">{t('preprocess.dataMerge:chua_co_dieu_kien_field_luon_hien')}</span>
                ) : (
                    <div className="flex flex-col gap-2">
                        {conditions.map((c, i) => (
                            <div key={i} className="flex flex-col gap-1.5 p-2 bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 rounded">
                                <div className="flex items-center gap-1.5">
                                    <select
                                        value={c.action}
                                        onChange={(e) => updateCondition(i, { action: e.target.value as VdpFieldCondition['action'] })}
                                        className={selectClass + " w-24 shrink-0"}
                                    >
                                        <option value="show_if">{t('preprocess.dataMerge:hien_neu')}</option>
                                        <option value="hide_if">{t('preprocess.dataMerge:an_neu')}</option>
                                    </select>
                                    <select
                                        value={c.column}
                                        onChange={(e) => updateCondition(i, { column: e.target.value })}
                                        className={selectClass + " flex-1 min-w-0"}
                                    >
                                        {columnOptions(c.column)}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => removeCondition(i)}
                                        className="shrink-0 text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                        title={t('preprocess.dataMerge:xoa_dieu_kien')}
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <select
                                        value={c.operator}
                                        onChange={(e) => updateCondition(i, { operator: e.target.value as VdpOperator })}
                                        className={selectClass + " w-28 shrink-0"}
                                    >
                                        {VDP_OPERATORS.map(op => <option key={op.value} value={op.value}>{tv(op.label)}</option>)}
                                    </select>
                                    <input
                                        type="text"
                                        value={c.value}
                                        onChange={(e) => updateCondition(i, { value: e.target.value })}
                                        disabled={!operatorNeedsValue(c.operator)}
                                        placeholder={operatorNeedsValue(c.operator) ? t('preprocess.dataMerge:gia_tri_so_sanh') : t('preprocess.dataMerge:khong_can_gia_tri')}
                                        className={inputClass + " flex-1 min-w-0 disabled:bg-slate-100 dark:disabled:bg-zinc-800 disabled:text-slate-400"}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <ToolDivider />

            {/* ── Bảng rule ── */}
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">{t('preprocess.dataMerge:bang_rule_doi_noi_dung_anh_2')}</span>
                    <button
                        type="button"
                        onClick={addRule}
                        className="text-[11px] px-2 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-500/10 dark:hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-700 rounded font-medium transition-colors"
                    >
                        {t('preprocess.dataMerge:them_rule')}
                    </button>
                </div>
                <span className="text-[10px] text-slate-500 dark:text-zinc-400 italic">
                    {t('preprocess.dataMerge:neu_cot_thoa_dieu_kien_dat_noi_dung_anh')}
                </span>
                <span className="text-[10px] text-teal-700 dark:text-teal-400">
                    {t('preprocess.dataMerge:vi_du')} <b>{t('preprocess.dataMerge:nuoc')}</b> {t('preprocess.dataMerge:bang')} <b>VN</b> {t('preprocess.dataMerge:ket_qua')} <b>co_vn.png</b> {t('preprocess.dataMerge:moi_ban_tu_lay_dung_co_2')}
                </span>
                {rules.length === 0 ? (
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500">{t('preprocess.dataMerge:chua_co_rule')}</span>
                ) : (
                    <div className="flex flex-col gap-2">
                        {rules.map((r, i) => (
                            <div key={i} className="flex flex-col gap-1.5 p-2 bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 rounded">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] font-bold text-slate-400 shrink-0 w-8">#{i + 1}</span>
                                    <select
                                        value={r.column}
                                        onChange={(e) => updateRule(i, { column: e.target.value })}
                                        className={selectClass + " flex-1 min-w-0"}
                                    >
                                        {columnOptions(r.column)}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => removeRule(i)}
                                        className="shrink-0 text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                        title={t('preprocess.dataMerge:xoa_rule')}
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <select
                                        value={r.operator}
                                        onChange={(e) => updateRule(i, { operator: e.target.value as VdpOperator })}
                                        className={selectClass + " w-28 shrink-0"}
                                    >
                                        {VDP_OPERATORS.map(op => <option key={op.value} value={op.value}>{tv(op.label)}</option>)}
                                    </select>
                                    <input
                                        type="text"
                                        value={r.value}
                                        onChange={(e) => updateRule(i, { value: e.target.value })}
                                        disabled={!operatorNeedsValue(r.operator)}
                                        placeholder={operatorNeedsValue(r.operator) ? t('preprocess.dataMerge:gia_tri_so_sanh') : t('preprocess.dataMerge:khong_can_gia_tri')}
                                        className={inputClass + " flex-1 min-w-0 disabled:bg-slate-100 dark:disabled:bg-zinc-800 disabled:text-slate-400"}
                                    />
                                </div>
                                <input
                                    type="text"
                                    value={r.result}
                                    onChange={(e) => updateRule(i, { result: e.target.value })}
                                    placeholder={t('preprocess.dataMerge:ket_qua_noi_dung_hoac_duong_dan_anh')}
                                    className={inputClass + " w-full"}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Icon căn chỉnh kiểu Illustrator ───
interface Props {
  pdfFile: File | null;
  getWorkingFile?: () => Promise<File>;
  vdpFields?: any[];
  setVdpFields?: React.Dispatch<React.SetStateAction<any[]>>;
  selectedFieldIds?: string[];
  onSelectField?: (ids: string[]) => void;
  onSpawnTab?: (blob: Blob, name: string, path?: string) => void;
  onApplyResult?: (blob: Blob, name: string, path?: string) => void | Promise<void>;
  isActive?: boolean;
}
export default function DataMergeTool({
    pdfFile,
    getWorkingFile,
    vdpFields = [],
    setVdpFields,
    selectedFieldIds = [],
    onSelectField,
    onSpawnTab,
    onApplyResult,
    isActive = true
}: Props) {
  const { t } = useTranslation();
    const [csvData, setCsvData] = useState<Record<string, string>[]>([]);
    const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
    const [dataMode, setDataMode] = useState<'csv' | 'manual' | 'xlsx' | 'gsheet'>('csv');
    const [manualText, setManualText] = useState('');
    const [manualColName, setManualColName] = useState('Noidung');
    const [statusMessage, setStatusMessage] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    // UIUX (audit 2026-07-27 §D-07): tiến độ job VDP ({processed,total}) cho ProgressBar
    const [progressInfo, setProgressInfo] = useState<VdpProgressInfo | null>(null);

    // ── Nguồn dữ liệu mở rộng (xlsx / Google Sheets) — task 14.1 ──
    // Số bản ghi THẬT do backend báo về (preview_rows chỉ là mẫu hiển thị).
    const [sourceRecordCount, setSourceRecordCount] = useState<number | null>(null);
    const [sourceError, setSourceError] = useState<string>('');     // thông báo lỗi tiếng Việt
    const [sourceLoading, setSourceLoading] = useState(false);
    const [xlsxFile, setXlsxFile] = useState<File | null>(null);    // file .xlsx đang chọn
    const [sheetList, setSheetList] = useState<string[]>([]);       // danh sách sheet của file
    const [selectedSheet, setSelectedSheet] = useState<string>(''); // sheet đang đọc
    const [gsheetUrl, setGsheetUrl] = useState<string>('');         // link Google Sheets

    // ── Xem trước record + điều hướng (task 14.3, Req 4.2/4.3/4.5/4.6/4.9/8.5) ──
    const [previewIndex, setPreviewIndex] = useState(1);            // chỉ số yêu cầu (1-based)
    const [previewImg, setPreviewImg] = useState<string | null>(null);   // data URL PNG
    const [previewDims, setPreviewDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
    const [previewErrors, setPreviewErrors] = useState<VdpFieldError[]>([]);
    const [previewRecordIndex, setPreviewRecordIndex] = useState(0);     // chỉ số đã render thực
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewProcessing, setPreviewProcessing] = useState(false);   // chỉ báo khi > 2s (Req 4.3)
    const [previewMsg, setPreviewMsg] = useState('');
    const previewAbortRef = useRef<AbortController | null>(null);
    // Huỷ request preview đang chờ khi unmount để không rò rỉ (giữ UI mượt).
    useEffect(() => () => { previewAbortRef.current?.abort(); }, []);

    // ── Gating validate + xuất báo cáo lỗi (task 14.4, Req 4.7/4.8/5.8/5.9/5.10) ──
    const [validateGating, setValidateGating] = useState<VdpGating | null>(null); // null = chưa kiểm tra
    const [validateIssues, setValidateIssues] = useState<VdpIssue[]>([]);
    const [validating, setValidating] = useState(false);
    const [reportLoading, setReportLoading] = useState(false);

    // Hủy polling VDP khi component unmount để không poll vô hạn nền (#13).
    const pollAbortRef = useRef<AbortController | null>(null);
    const activeVdpJobRef = useRef<string | null>(null);
    const [activeVdpJobId, setActiveVdpJobId] = useState<string | null>(null);
    useEffect(() => () => {
        pollAbortRef.current?.abort();
        const jobId = activeVdpJobRef.current;
        if (jobId) void cancelVdpJobBackend(jobId).catch(() => undefined);
    }, []);

    const cancelActiveVdp = async () => {
        const jobId = activeVdpJobRef.current;
        if (!jobId) return;
        await cancelVdpJobBackend(jobId);
        pollAbortRef.current?.abort();
        setStatusMessage(t('tabs.imposition:huy_bo_cancel'));
    };

    const openBatchInfo = async () => {
        setShowBatchInfo(true);
        if (batchInfo.length === batchFiles.length && batchInfo.length > 0) return;
        setBatchInfoLoading(true);
        try {
            const info: { name: string; records: number }[] = [];
            for (const f of batchFiles) {
                try {
                    const { data } = await parseCsv(f, csvHasHeader);
                    info.push({ name: f.name, records: data.length });
                } catch {
                    info.push({ name: f.name, records: -1 });
                }
            }
            setBatchInfo(info);
        } finally {
            setBatchInfoLoading(false);
        }
    };

    // UIUX (audit 2026-07-27 §D-04): sau khi thay nguồn dữ liệu, so tên cột cũ mà các
    // field đang map với headers MỚI — field mất cột nguồn thì báo để user map lại.
    const warnMissingMappedColumns = (newHeaders: string[]) => {
        const newSet = new Set(newHeaders);
        const oldSet = new Set(csvHeaders);
        const missing = [...new Set(
            vdpFields.map((f: any) => f?.name).filter((n: any) => n && oldSet.has(n) && !newSet.has(n))
        )] as string[];
        if (missing.length > 0) {
            toast.info(t('preprocess.dataMerge:nguon_moi_thieu_cot_can_map_lai', {
                defaultValue: 'Nguồn mới thiếu cột: {{cols}} — các ô này cần map lại',
                cols: missing.join(', '),
            }));
        }
    };

    const loadCsvIntoState = (file: File, hasHeader: boolean) => {
        setStatusMessage(t('preprocess.dataMerge:dang_doc_file_csv'));
        parseCsv(file, hasHeader).then(({ headers, data, duplicated }) => {
            if (data.length > 0) {
                warnMissingMappedColumns(headers); // UIUX (audit 2026-07-27 §D-04)
                setCsvHeaders(headers);
                setCsvData(data);
                if (duplicated.length > 0) setStatusMessage(t('preprocess.dataMerge:da_tai_n_dong_cot_trung_ten', { n: data.length, cols: duplicated.join(', ') }));
                else setStatusMessage(t('preprocess.dataMerge:da_tai_n_dong_du_lieu', { n: data.length }));
            } else {
                setCsvHeaders([]); setCsvData([]);
                setStatusMessage(t('preprocess.dataMerge:file_csv_rong_hoac_loi_dinh_dang'));
            }
        }).catch((err) => { console.error("CSV Parse Error:", err); setStatusMessage(t('preprocess.dataMerge:loi_doc_file_csv')); });
    };

    const handleCsvFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []).filter(f => /\.csv$/i.test(f.name));
        e.currentTarget.value = '';
        if (!files.length) return;
        setBatchFiles(files);
        lastCsvFileRef.current = files[0];
        loadCsvIntoState(files[0], csvHasHeader);
        if (files.length > 1) {
            setStatusMessage(t('preprocess.dataMerge:da_chon_n_file_map_truong', { n: files.length }));
        }
    };

    // ── Nguồn dữ liệu mở rộng (task 14.1): xlsx + Google Sheets ──
    // Đưa kết quả /vdp/datasource về state dùng chung (csvHeaders/csvData) để
    // các bước map field/preview phía sau hoạt động đồng nhất với đường CSV.
    const applySourceResult = (
        result: { columns: string[]; record_count: number; preview_rows: Record<string, string>[] },
        label: string,
    ) => {
        setSourceError('');
        setBatchFiles([]);            // nguồn xlsx/gsheet không dùng chạy hàng loạt CSV
        warnMissingMappedColumns(result.columns); // UIUX (audit 2026-07-27 §D-04)
        setCsvHeaders(result.columns);
        setCsvData(result.preview_rows);
        setSourceRecordCount(result.record_count);
        if (result.record_count === 0) {
            setStatusMessage(`${label}: ${t('preprocess.dataMerge:nguon_rong_0_ban_ghi')}`);
        } else {
            setStatusMessage(`${label}: ${t('preprocess.dataMerge:n_ban_ghi_m_cot', { n: result.record_count, m: result.columns.length })}`);
        }
    };

    const clearSourceState = () => {
        setCsvHeaders([]);
        setCsvData([]);
        setSourceRecordCount(null);
    };

    // Đọc dữ liệu một sheet của file .xlsx hiện chọn qua /vdp/datasource.
    const loadXlsxSheet = async (file: File, sheet: string) => {
        setSourceLoading(true);
        setSourceError('');
        setStatusMessage(t('preprocess.dataMerge:dang_doc_sheet_x', { x: sheet }));
        try {
            const result = await readVdpDatasource({ kind: 'xlsx', file, sheet, hasHeader: csvHasHeader });
            applySourceResult(result, `Excel · ${sheet}`);
        } catch (err: any) {
            clearSourceState();
            setSourceError(err?.message || t('preprocess.dataMerge:khong_doc_duoc_file_excel'));
            setStatusMessage(t('preprocess.dataMerge:loi_doc_file_excel'));
        } finally {
            setSourceLoading(false);
        }
    };

    // Chọn file .xlsx → liệt kê sheet → tự đọc sheet đầu tiên.
    const handleXlsxFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = Array.from(e.target.files || []).find(f => /\.xlsx$/i.test(f.name)) || null;
        e.currentTarget.value = '';
        if (!file) return;
        setXlsxFile(file);
        setSheetList([]);
        setSelectedSheet('');
        clearSourceState();
        setSourceLoading(true);
        setSourceError('');
        setStatusMessage(t('preprocess.dataMerge:dang_doc_danh_sach_sheet'));
        try {
            const sheets = await listVdpSheets(file);
            setSheetList(sheets);
            const first = sheets[0] || '';
            setSelectedSheet(first);
            if (first) {
                await loadXlsxSheet(file, first);
            } else {
                setSourceLoading(false);
                setSourceError(t('preprocess.dataMerge:file_excel_khong_co_sheet_nao'));
                setStatusMessage(t('preprocess.dataMerge:file_excel_rong'));
            }
        } catch (err: any) {
            setSourceLoading(false);
            setXlsxFile(null);
            setSourceError(err?.message || t('preprocess.dataMerge:khong_doc_duoc_file_excel'));
            setStatusMessage(t('preprocess.dataMerge:loi_doc_file_excel'));
        }
    };

    // Đổi sheet đang chọn → đọc lại dữ liệu sheet đó.
    const handleSheetChange = async (sheet: string) => {
        setSelectedSheet(sheet);
        if (xlsxFile && sheet) await loadXlsxSheet(xlsxFile, sheet);
    };

    // Nạp dữ liệu từ link Google Sheets công khai qua /vdp/datasource.
    const loadGsheet = async () => {
        const url = gsheetUrl.trim();
        if (!url) { setSourceError(t('preprocess.dataMerge:hay_dan_link_google_sheets')); return; }
        setSourceLoading(true);
        setSourceError('');
        setStatusMessage(t('preprocess.dataMerge:dang_lay_du_lieu_google_sheets'));
        try {
            const result = await readVdpDatasource({ kind: 'gsheet', url, hasHeader: csvHasHeader });
            applySourceResult(result, 'Google Sheets');
        } catch (err: any) {
            clearSourceState();
            setSourceError(err?.message || t('preprocess.dataMerge:khong_lay_duoc_du_lieu_google_sheets'));
            setStatusMessage(t('preprocess.dataMerge:loi_lay_du_lieu_google_sheets'));
        } finally {
            setSourceLoading(false);
        }
    };

    // Nhập tay: mỗi DÒNG = 1 bản ghi, gộp dưới một cột (mặc định "Noidung").
    // 1 dòng → 1 trang; nhiều dòng → nhiều trang. Field nào muốn dùng thì map vào cột này.
    const applyManualData = (text: string, colRaw: string) => {
        const col = ((colRaw || '').trim()) || 'Noidung';
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        setBatchFiles([]); // chế độ nhập tay không dùng chạy hàng loạt
        if (lines.length === 0) {
            setCsvHeaders([]); setCsvData([]);
            setStatusMessage(t('preprocess.dataMerge:nhap_tay_chua_co_noi_dung_moi_dong_1'));
            return;
        }
        setCsvHeaders([col]);
        setCsvData(lines.map(l => ({ [col]: l })));
        setStatusMessage(t('preprocess.dataMerge:nhap_tay_x_ban_ghi_cot_y', { x: lines.length, y: col }));
    };

    const updateSelectedField = (changes: any) => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;

        // Khi đổi góc xoay: hoán width↔height cho MỌI loại field khi chuyển
        // dọc↔ngang (90/270 ↔ 0/180). Backend render_one_record giả định
        // "frontend đã hoán w/h cho field dọc" và áp cho mọi type, nên phải
        // hoán ở đây cho cả text/image, không riêng barcode/qrcode.
        if (changes.rotation !== undefined) {
            const field = vdpFields.find(f => f.id === selectedFieldIds[0]);
            if (field) {
                const oldRot = field.rotation || 0;
                const newRot = changes.rotation;
                const oldIsVertical = (oldRot === 90 || oldRot === 270);
                const newIsVertical = (newRot === 90 || newRot === 270);
                if (oldIsVertical !== newIsVertical) {
                    // Swap width ↔ height
                    changes.width = field.height;
                    changes.height = field.width;
                }
            }
        }
        // When name (CSV column) changes on a text field, auto-update textContent
        // so the placeholder references the correct column
        if (changes.name !== undefined) {
            const field = vdpFields.find(f => f.id === selectedFieldIds[0]);
            if (field && field.type === 'text') {
                const oldName = field.name || '';
                const newName = changes.name;
                const currentText = field.textContent;
                if (currentText && currentText.includes(`{${oldName}}`)) {
                    // Replace old column reference with new one
                    changes.textContent = currentText.replace(`{${oldName}}`, `{${newName}}`);
                } else if (!currentText || currentText === `{${oldName}}`) {
                    // Default: set textContent to just the column reference
                    changes.textContent = `{${newName}}`;
                }
            }
        }

        setVdpFields(prev => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, ...changes } : f));
        
        // Auto-fit barcode frame using aspect ratio
        const barcodeTriggers = ['barcodeType', 'barHeight', 'quietZone', 'showText', 'fontSize', 'textAlign', 'data'];
        const isBarcodeUpdate = barcodeTriggers.some(key => changes[key] !== undefined);
        
        if (isBarcodeUpdate) {
            const field = vdpFields.find(f => f.id === selectedFieldIds[0]);
            if (field && field.type === 'barcode') {
                const updatedField = { ...field, ...changes };
                const sampleData: Record<string, string> = {
                    code128: 'SAMPLE-12345', ean13: '4006381333931', upca: '012345678905',
                    ean8: '96385074', code39: 'SAMPLE39', itf14: '10012345000017', codabar: 'A12345B',
                };
                const bt = updatedField.barcodeType || 'code128';
                generateBarcodeDataURL({
                    type: bt,
                    data: updatedField.data || sampleData[bt] || 'SAMPLE-12345',
                    height: updatedField.barHeight || 12,
                    showText: updatedField.showText !== false,
                    quietZone: updatedField.quietZone ?? 2,
                    fontSize: updatedField.fontSize,
                    textAlign: updatedField.textAlign,
                }).then(dataUrl => {
                    const img = new Image();
                    img.onload = () => {
                        const aspect = img.width / img.height;
                        const h = updatedField.height || 15;
                        const newWidth = Math.round(h * aspect * 10) / 10;
                        setVdpFields(prev => prev.map(f => f.id === selectedFieldIds[0] ? { ...f, width: newWidth } : f));
                    };
                    img.src = dataUrl;
                }).catch(() => {});
            }
        }
    };

    const { deleteSelectedField } = useVdpTool(vdpFields, setVdpFields as any, selectedFieldIds, onSelectField, isActive);

    const selectedFieldId = selectedFieldIds[0];
    const selectedField = vdpFields.find(f => f.id === selectedFieldId);
    const viewerPageDimMm = useWorkspaceStore(s => s.viewerPageDimMm);
    // Trình tách cột (chèn nhanh placeholder, không phải gõ cú pháp tay)
    const [splitCol, setSplitCol] = useState('');
    const [splitMode, setSplitMode] = useState('whole'); // whole | ws | - | , | ; | / | custom
    const [splitCustom, setSplitCustom] = useState('');
    const [splitPart, setSplitPart] = useState(1);
    // #8 Định dạng dữ liệu khi chèn placeholder
    const [splitFmt, setSplitFmt] = useState('');      // '' | upper | lower | title | number | money | date | pad
    const [splitFmtArg, setSplitFmtArg] = useState(''); // số chữ số thập phân / độ rộng / format ngày
    const [showQuickInsert, setShowQuickInsert] = useState(false); // thu gọn "Chèn thêm cột vào câu" (nâng cao)
    const [showQuickHelp, setShowQuickHelp] = useState(false);     // modal hướng dẫn "Chèn thêm cột vào câu"

    // Đóng modal hướng dẫn "Chèn thêm cột" bằng phím ESC.
    useEffect(() => {
        if (!showQuickHelp || !isActive) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setShowQuickHelp(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showQuickHelp, isActive]);
    const [csvHasHeader, setCsvHasHeader] = useState(true);
    const lastCsvFileRef = useRef<File | null>(null);
    const [batchFiles, setBatchFiles] = useState<File[]>([]);
    const [showBatchInfo, setShowBatchInfo] = useState(false);
    const [batchInfo, setBatchInfo] = useState<{ name: string; records: number }[]>([]);
    const [batchInfoLoading, setBatchInfoLoading] = useState(false);

    const buildSplitToken = (): string => {
        if (!splitCol) return '';
        // phần định dạng (#8): |func hoặc |func:arg
        const fmt = splitFmt ? (splitFmtArg.trim() ? `|${splitFmt}:${splitFmtArg.trim()}` : `|${splitFmt}`) : '';
        if (splitMode === 'whole') return `{${splitCol}${fmt}}`;
        if (splitMode === 'ws') return `{${splitCol}[${splitPart}]${fmt}}`;
        const d = splitMode === 'custom' ? splitCustom : splitMode;
        if (!d) return `{${splitCol}[${splitPart}]${fmt}}`;
        return `{${splitCol}[${splitPart}|${d}]${fmt}}`;
    };

    const insertSplitToken = (target: any) => {
        const tok = buildSplitToken();
        if (!tok || !target) return;
        const cur = target.textContent !== undefined ? target.textContent : '';
        const isDefault = cur === '' || cur === `{${target.name}}`;
        updateSelectedField({ textContent: isDefault ? tok : cur + tok });
    };

    // ─── Thu gọn chiều cao khung text vừa khít nội dung (ở cỡ chữ hiện tại) ───
    const fitHeightToText = () => {
        if (!setVdpFields || !selectedField || selectedField.type !== 'text') return;
        const f = selectedField;
        const text = (f.textContent !== undefined ? f.textContent : `{${f.name}}`) || '';
        const fontPt = f.fontSize || 13;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const weight = (f.fontStyle === 'bold' || f.fontStyle === 'bolditalic') ? 'bold ' : '';
        const italic = (f.fontStyle === 'italic' || f.fontStyle === 'bolditalic') ? 'italic ' : '';
        const family = f.fontName === 'Times-Roman' ? '"Times New Roman", serif' : f.fontName === 'Courier' ? 'Courier, monospace' : (f.fontName ? `"${f.fontName}", sans-serif` : 'Arial, sans-serif');
        ctx.font = `${italic}${weight}${fontPt}px ${family}`;
        const MM_TO_PT = 72 / 25.4;
        const boxWpt = f.width * MM_TO_PT;
        let totalLines = 0;
        for (const ln of text.split('\n')) {
            const words = ln.split(' ');
            let cur = '';
            let lines = 1;
            for (const w of words) {
                const test = cur ? cur + ' ' + w : w;
                if (ctx.measureText(test).width > boxWpt && cur) { lines++; cur = w; }
                else cur = test;
            }
            totalLines += Math.max(1, lines);
        }
        const heightPt = totalLines * fontPt * 1.2;
        const heightMm = Math.max(3, heightPt / MM_TO_PT);
        updateSelectedField({ height: Math.round(heightMm * 10) / 10 });
    };

    // Đọc 1 file CSV → { headers, data }. Hỗ trợ file KHÔNG có hàng tiêu đề:
    // khi đó tự đặt tên cột theo vị trí "Cột 1", "Cột 2"... để map theo cột.
    const parseCsv = (file: File, hasHeader: boolean): Promise<{ headers: string[]; data: Record<string, string>[]; duplicated: string[] }> =>
        new Promise((resolve, reject) => {
            const seen = new Set<string>();
            const dup = new Set<string>();
            Papa.parse(file, {
                header: hasHeader,
                skipEmptyLines: true,
                ...(hasHeader ? {
                    transformHeader: (h: string) => {
                        const name = (h ?? '').trim();
                        if (seen.has(name)) dup.add(name); else seen.add(name);
                        return name;
                    }
                } : {}),
                complete: (res: any) => {
                    if (hasHeader) {
                        const data = ((res.data as any[]) || []).filter(Boolean) as Record<string, string>[];
                        const headers = data.length ? Object.keys(data[0]) : (res.meta?.fields || []);
                        resolve({ headers, data, duplicated: Array.from(dup) });
                    } else {
                        const rows = ((res.data as any[]) || []).filter((r: any) => Array.isArray(r) && r.some((c: any) => c !== '' && c != null)) as string[][];
                        const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
                        const headers = Array.from({ length: colCount }, (_, i) => `Cột ${i + 1}`);
                        const data = rows.map(r => {
                            const o: Record<string, string> = {};
                            headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
                            return o;
                        });
                        resolve({ headers, data, duplicated: [] });
                    }
                },
                error: reject,
            });
        });

    // Chạy hàng loạt nhiều file CSV: mỗi file → 1 tab kết quả riêng, đặt tên theo tên file CSV.
    const handleBatchGenerate = async (fileList: File[] | FileList) => {
        if (vdpFields.length === 0) { setStatusMessage(t('preprocess.dataMerge:chua_co_truong_du_lieu_vdp_field_nao')); return; }
        if (!pdfFile) { setStatusMessage(t('preprocess.dataMerge:chua_co_file_pdf_goc')); return; }
        if (!onSpawnTab) { setStatusMessage(t('preprocess.dataMerge:khong_the_mo_tab_ket_qua_thieu')); return; }
        const files = Array.from(fileList).filter(f => /\.csv$/i.test(f.name));
        if (files.length === 0) { setStatusMessage(t('preprocess.dataMerge:khong_co_file_csv_hop_le')); return; }

        setIsGenerating(true);
        try {
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;

            // UIUX (audit 2026-07-27 §D-06): pass 1 — đọc + kiểm tra TẤT CẢ file trước,
            // gom các file có cảnh báo lại để hỏi MỘT lần thay vì window.confirm từng file.
            type BatchItem = { csvFile: File; tag: string; data: Record<string, string>[]; warn: boolean };
            const runnable: BatchItem[] = [];
            const warnLines: string[] = [];
            for (let i = 0; i < files.length; i++) {
                const csvFile = files[i];
                const tag = `(${i + 1}/${files.length}) ${csvFile.name}`;
                try {
                    setStatusMessage(`${tag}: ${t('preprocess.dataMerge:dang_doc')}`);
                    const data = (await parseCsv(csvFile, csvHasHeader)).data;
                    if (data.length === 0) { setStatusMessage(`${tag}: ${t('preprocess.dataMerge:rong_bo_qua')}`); continue; }

                    // Gating validate cho từng file trước khi sinh (Req 5.8/5.9/5.10).
                    setStatusMessage(`${tag}: ${t('preprocess.dataMerge:dang_kiem_tra_du_lieu_2')}`);
                    try {
                        const vres = await validateVdp({
                            fields: vdpFields,
                            rows: data,
                            columns: data.length ? Object.keys(data[0]) : [],
                            hasHeader: csvHasHeader,
                        });
                        if (vres.gating === 'block') {
                            const errCount = vres.issues.filter(i => i.severity === 'error').length;
                            setStatusMessage(`${tag}: ${t('preprocess.dataMerge:co_n_loi_chan_bo_qua_file', { n: errCount })}`);
                            continue;
                        }
                        const warn = vres.gating === 'needs_confirmation';
                        if (warn) {
                            const warnCount = vres.issues.filter(i => i.severity === 'warning').length;
                            warnLines.push(t('preprocess.dataMerge:dong_file_co_canh_bao', {
                                defaultValue: '• {{name}}: {{n}} cảnh báo',
                                name: csvFile.name, n: warnCount,
                            }));
                        }
                        runnable.push({ csvFile, tag, data, warn });
                    } catch (vErr: any) {
                        setStatusMessage(`${tag}: ${t('preprocess.dataMerge:loi_kiem_tra_du_lieu_bo_qua', { e: vErr?.message || vErr })}`);
                        continue;
                    }
                } catch (err: any) {
                    if (isCanceled(err)) return; // UIUX (audit 2026-07-27 §D-15)
                    setStatusMessage(`${tag}: ${t('preprocess.dataMerge:loi_x', { e: formatError(err) })}`); // UIUX (audit 2026-07-27 §D-15)
                }
            }

            // UIUX (audit 2026-07-27 §D-06): MỘT hộp thoại xác nhận chung cho mọi file có cảnh báo.
            let skipWarned = false;
            if (warnLines.length > 0) {
                const okWarn = await confirmDialog({
                    title: t('preprocess.dataMerge:du_lieu_co_canh_bao', 'Dữ liệu có cảnh báo'),
                    message: t('preprocess.dataMerge:cac_file_sau_co_canh_bao_vd_anh_thieu',
                        'Các file sau có cảnh báo (ví dụ ảnh thiếu) — record liên quan có thể bị thiếu nội dung:')
                        + '\n' + warnLines.join('\n'),
                    confirmText: t('preprocess.dataMerge:van_chay', 'Vẫn chạy'),
                    cancelText: t('preprocess.dataMerge:xem_lai', 'Xem lại'),
                    danger: true,
                });
                if (!okWarn) skipWarned = true;
            }

            let ok = 0;
            for (let ri = 0; ri < runnable.length; ri++) {
                const item = runnable[ri];
                if (item.warn && skipWarned) {
                    setStatusMessage(`${item.tag}: ${t('preprocess.dataMerge:da_bo_qua_do_con_canh_bao')}`);
                    continue;
                }
                try {
                    setStatusMessage(`${item.tag}: ${t('preprocess.dataMerge:dang_sinh_n_ban_ghi', { n: item.data.length })}`);
                    const jobId = await startVdpJobBackend(templateFile, vdpFields, item.data, 'vdp.datamerge', item.csvFile, csvHasHeader);
                    activeVdpJobRef.current = jobId;
                    setActiveVdpJobId(jobId);
                    pollAbortRef.current = new AbortController();
                    // UIUX (audit 2026-07-27 §D-07): lưu thêm {processed,total} cho ProgressBar
                    const result = await pollVdpJob(jobId, (m, info) => { setStatusMessage(`${item.tag}: ${m}`); setProgressInfo(info ?? null); }, true, pollAbortRef.current.signal);
                    if (!result.blob) { setStatusMessage(`${item.tag}: ${t('preprocess.dataMerge:loi_khong_co_ket_qua')}`); continue; }
                    const baseName = item.csvFile.name.replace(/\.[^/.]+$/, '') || `VDP_${ri + 1}`;
                    onSpawnTab(result.blob, `${baseName}.pdf`, result.path ?? undefined);
                    ok++;
                    // Nhường UI một nhịp giữa các file
                    await new Promise(r => setTimeout(r, 50));
                } catch (err: any) {
                    if (isCanceled(err)) return; // UIUX (audit 2026-07-27 §D-15)
                    setStatusMessage(`${item.tag}: ${formatError(err, t('preprocess.dataMerge:khong_chay_duoc_vdp', 'Không chạy được VDP'))}`); // UIUX (audit 2026-07-27 §D-15)
                }
            }
            setStatusMessage(t('preprocess.dataMerge:hoan_thanh_ok_tren_tong_file_csv', { ok, total: files.length }));
        } catch (e: any) {
            if (isCanceled(e)) return; // UIUX (audit 2026-07-27 §D-15)
            setStatusMessage(formatError(e, t('preprocess.dataMerge:khong_chay_duoc_vdp', 'Không chạy được VDP'))); // UIUX (audit 2026-07-27 §D-15)
        } finally {
            activeVdpJobRef.current = null;
            setActiveVdpJobId(null);
            setProgressInfo(null); // UIUX (audit 2026-07-27 §D-07)
            setIsGenerating(false);
        }
    };

    // ─── Xem trước một record (task 14.3) ───────────────────────────────────
    // Tổng số record để điều hướng/kẹp: xlsx/gsheet dùng số THẬT từ backend
    // (sourceRecordCount), còn csv/manual dùng số dòng đã nạp (csvData).
    const previewTotal = (dataMode === 'xlsx' || dataMode === 'gsheet')
        ? (sourceRecordCount ?? csvData.length)
        : csvData.length;

    // Gọi /vdp/preview bất đồng bộ cho record thứ `index` (1-based). Giữ UI phản
    // hồi (không block), huỷ request cũ khi điều hướng nhanh, và chỉ hiện chỉ báo
    // "đang xử lý" khi vượt 2 giây (Req 4.3, 8.5).
    const runPreview = async (index: number) => {
        if (!csvData || csvData.length === 0) {
            setPreviewImg(null);
            setPreviewErrors([]);
            setPreviewMsg(t('preprocess.dataMerge:chua_co_du_lieu_nguon_de_xem_truoc'));
            return;
        }
        const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;
        if (!templateFile) {
            setPreviewMsg(t('preprocess.dataMerge:chua_co_file_pdf_template_de_xem_truoc'));
            return;
        }

        // Huỷ request preview đang chờ (điều hướng nhanh không xếp hàng vô ích).
        previewAbortRef.current?.abort();
        const ac = new AbortController();
        previewAbortRef.current = ac;

        setPreviewLoading(true);
        // Chỉ báo xử lý chỉ xuất hiện nếu request kéo dài > 2 giây (Req 4.3).
        const slowTimer = setTimeout(() => {
            if (!ac.signal.aborted) setPreviewProcessing(true);
        }, 2000);

        try {
            const params: Parameters<typeof previewVdpRecord>[0] = {
                fields: vdpFields,
                requestedIndex: index,
                template: templateFile,
                hasHeader: csvHasHeader,
                signal: ac.signal,
            };
            // Nguồn dữ liệu: xlsx/gsheet đọc lại để phủ toàn bộ record; còn lại
            // gửi rows đã nạp sẵn (csv/manual nạp đủ dòng).
            if (dataMode === 'xlsx' && xlsxFile) {
                params.kind = 'xlsx';
                params.file = xlsxFile;
                if (selectedSheet) params.sheet = selectedSheet;
            } else if (dataMode === 'gsheet' && gsheetUrl.trim()) {
                params.kind = 'gsheet';
                params.url = gsheetUrl.trim();
            } else if (dataMode === 'csv' && lastCsvFileRef.current) {
                params.kind = 'csv';
                params.file = lastCsvFileRef.current;
            } else {
                params.rows = csvData;
                params.columns = csvHeaders;
            }

            const result = await previewVdpRecord(params);
            if (ac.signal.aborted) return;

            if (result.empty_source) {
                setPreviewImg(null);
                setPreviewErrors([]);
                setPreviewMsg(result.message || t('preprocess.dataMerge:nguon_du_lieu_rong_0_record'));
                return;
            }
            setPreviewImg(result.image_png_base64 ? `data:image/png;base64,${result.image_png_base64}` : null);
            setPreviewDims({ w: result.width, h: result.height });
            setPreviewErrors(result.field_errors || []);
            setPreviewRecordIndex(result.record_index);
            // Nếu backend kẹp chỉ số, đồng bộ ô nhập về chỉ số thực tế (Req 4.5).
            if (result.clamped) setPreviewIndex(result.record_index);
            setPreviewMsg(result.message || '');
        } catch (err: any) {
            if (err?.name === 'AbortError' || ac.signal.aborted) return;
            setPreviewMsg(err?.message || t('preprocess.dataMerge:loi_tao_ban_xem_truoc'));
        } finally {
            clearTimeout(slowTimer);
            if (!ac.signal.aborted) {
                setPreviewLoading(false);
                setPreviewProcessing(false);
            }
        }
    };

    // Điều hướng tới record `target` với kẹp ở hai biên + thông báo (Req 4.2, 4.5).
    const goToPreview = (target: number) => {
        if (previewTotal <= 0) {
            setPreviewImg(null);
            setPreviewErrors([]);
            setPreviewMsg(t('preprocess.dataMerge:nguon_du_lieu_rong_0_record_khong_the'));
            return;
        }
        let idx = target;
        let clampMsg = '';
        if (idx < 1) { idx = 1; clampMsg = t('preprocess.dataMerge:da_o_record_dau_tien'); }
        else if (idx > previewTotal) { idx = previewTotal; clampMsg = t('preprocess.dataMerge:da_o_record_cuoi_cung'); }
        setPreviewIndex(idx);
        if (clampMsg) setPreviewMsg(clampMsg);
        runPreview(idx);
    };

    // ─── Gating validate + xuất báo cáo lỗi (task 14.4) ─────────────────────
    // Dựng tham số nguồn dữ liệu cho validate/error-report giống runPreview:
    // xlsx/gsheet đọc lại để phủ toàn bộ record; csv/manual gửi rows đã nạp sẵn.
    const buildSourceParams = (): {
        kind?: 'csv' | 'xlsx' | 'gsheet';
        file?: File;
        url?: string;
        rows?: Record<string, string>[];
        columns?: string[];
    } => {
        if (dataMode === 'xlsx' && xlsxFile) {
            return { kind: 'xlsx', file: xlsxFile };
        }
        if (dataMode === 'gsheet' && gsheetUrl.trim()) {
            return { kind: 'gsheet', url: gsheetUrl.trim() };
        }
        return { rows: csvData, columns: csvHeaders };
    };

    // Lấy TOÀN BỘ record để sinh lô. Với xlsx/gsheet, csvData chỉ chứa 20 dòng
    // PREVIEW (từ /datasource) → phải đọc lại full source ở backend, nếu không
    // job chỉ sinh 20 trang (mất dữ liệu âm thầm). csv/manual đã nạp đủ dòng nên
    // trả thẳng csvData.
    const resolveFullSourceData = async (): Promise<Record<string, string>[]> => {
        if (dataMode === 'xlsx' && xlsxFile) {
            const result = await readVdpDatasource({
                kind: 'xlsx', file: xlsxFile,
                ...(selectedSheet ? { sheet: selectedSheet } : {}),
                hasHeader: csvHasHeader, includeAllRows: true,
            });
            return result.rows ?? result.preview_rows;
        }
        if (dataMode === 'gsheet' && gsheetUrl.trim()) {
            const result = await readVdpDatasource({
                kind: 'gsheet', url: gsheetUrl.trim(),
                hasHeader: csvHasHeader, includeAllRows: true,
            });
            return result.rows ?? result.preview_rows;
        }
        return csvData;
    };

    // Chạy validate qua backend, cập nhật gating + issues vào state. Trả kết quả
    // gating để caller (handleGenerate / nút kiểm tra) quyết định hành vi.
    const runValidate = async (): Promise<{ gating: VdpGating; issues: VdpIssue[] } | null> => {
        const src = buildSourceParams();
        const params: Parameters<typeof validateVdp>[0] = {
            fields: vdpFields,
            hasHeader: csvHasHeader,
            ...src,
        };
        // sheet đi kèm xlsx (buildSourceParams giữ kind/file; bổ sung sheet ở đây).
        if (src.kind === 'xlsx' && selectedSheet) params.sheet = selectedSheet;

        const result = await validateVdp(params);
        setValidateGating(result.gating);
        setValidateIssues(result.issues);
        return result;
    };

    // Nút "Kiểm tra (validate)" thủ công — hiển thị gating + danh sách issue.
    const handleManualValidate = async () => {
        if (vdpFields.length === 0) { setStatusMessage(t('preprocess.dataMerge:chua_co_truong_du_lieu_vdp_field_nao')); return; }
        setValidating(true);
        setStatusMessage(t('preprocess.dataMerge:dang_kiem_tra_du_lieu'));
        try {
            const result = await runValidate();
            if (!result) return;
            const errCount = result.issues.filter(i => i.severity === 'error').length;
            const warnCount = result.issues.filter(i => i.severity === 'warning').length;
            if (result.gating === 'allow') setStatusMessage(t('preprocess.dataMerge:kiem_tra_xong_khong_co_loi_san_sang'));
            else if (result.gating === 'needs_confirmation') setStatusMessage(t('preprocess.dataMerge:kiem_tra_xong_n_canh_bao_can_xac_nhan', { n: warnCount }));
            else setStatusMessage(t('preprocess.dataMerge:kiem_tra_xong_n_loi_chan_phai_khac_phuc', { n: errCount }));
        } catch (err: any) {
            setStatusMessage(t('preprocess.dataMerge:loi_kiem_tra_du_lieu_x', { x: err?.message || err }));
        } finally {
            setValidating(false);
        }
    };

    // Gating trước khi sinh lô: chặn nếu có lỗi (Req 5.8), hỏi xác nhận nếu chỉ
    // cảnh báo (Req 5.9), cho chạy nếu sạch (Req 5.10). Trả true nếu được tiếp tục.
    const runPreGenerateValidation = async (): Promise<boolean> => {
        setValidating(true);
        setStatusMessage(t('preprocess.dataMerge:dang_kiem_tra_du_lieu_truoc_khi_sinh_lo'));
        try {
            const result = await runValidate();
            if (!result) return false;
            const errCount = result.issues.filter(i => i.severity === 'error').length;
            const warnCount = result.issues.filter(i => i.severity === 'warning').length;

            if (result.gating === 'block') {
                setStatusMessage(t('preprocess.dataMerge:co_n_loi_chan_khong_the_sinh_lo', { n: errCount }));
                return false;
            }
            if (result.gating === 'needs_confirmation') {
                // UIUX (audit 2026-07-27 §D-06): confirmDialog trong app thay window.confirm
                const ok = await confirmDialog({
                    title: t('preprocess.dataMerge:du_lieu_co_canh_bao', 'Dữ liệu có cảnh báo'),
                    message: t('preprocess.dataMerge:phat_hien_n_canh_bao_vi_du_anh_thieu', { n: warnCount }) + '\n\n' +
                        t('preprocess.dataMerge:cac_record_lien_quan_co_the_bi_thieu'),
                    confirmText: t('preprocess.dataMerge:van_chay', 'Vẫn chạy'),
                    cancelText: t('preprocess.dataMerge:xem_lai', 'Xem lại'),
                    danger: true,
                });
                if (!ok) {
                    setStatusMessage(t('preprocess.dataMerge:da_huy_sinh_lo_do_con_canh_bao_chua_xu'));
                    return false;
                }
                return true;
            }
            return true; // allow
        } catch (err: any) {
            setStatusMessage(t('preprocess.dataMerge:loi_kiem_tra_du_lieu_x', { x: err?.message || err }));
            return false;
        } finally {
            setValidating(false);
        }
    };

    // Xuất báo cáo lỗi CSV (Req 4.7, 4.8). Nếu đã validate → dùng issues hiện có;
    // nếu chưa → gửi fields + nguồn để backend tự tính (vẫn xuất CSV "không lỗi").
    const handleExportReport = async () => {
        setReportLoading(true);
        setStatusMessage(t('preprocess.dataMerge:dang_tao_bao_cao_loi_csv'));
        try {
            if (validateGating !== null) {
                await downloadVdpErrorReport({ issues: validateIssues });
            } else {
                await downloadVdpErrorReport({
                    fields: vdpFields,
                    hasHeader: csvHasHeader,
                    ...buildSourceParams(),
                    ...(dataMode === 'xlsx' && selectedSheet ? { sheet: selectedSheet } : {}),
                });
            }
            setStatusMessage(t('preprocess.dataMerge:da_xuat_bao_cao_loi_csv'));
        } catch (err: any) {
            setStatusMessage(t('preprocess.dataMerge:loi_xuat_bao_cao_loi_x', { x: err?.message || err }));
        } finally {
            setReportLoading(false);
        }
    };

    const handleGenerate = async () => {
        if (vdpFields.length === 0) {
            setStatusMessage(t('preprocess.dataMerge:chua_co_truong_du_lieu_vdp_field_nao'));
            return;
        }
        if (!pdfFile) {
            setStatusMessage(t('preprocess.dataMerge:chua_co_file_pdf_goc'));
            return;
        }
        if (!csvData || csvData.length === 0) {
            setStatusMessage(t('preprocess.dataMerge:chua_co_du_lieu_tai_csv_hoac_chuyen'));
            return;
        }

        // Gating validate TRƯỚC khi sinh lô (Req 5.8/5.9/5.10): chặn nếu có lỗi,
        // hỏi xác nhận nếu chỉ có cảnh báo, cho chạy nếu sạch.
        const allowed = await runPreGenerateValidation();
        if (!allowed) return;

        setIsGenerating(true);
        try {
            // Tuân thủ kết quả cuối cùng: dùng file đã áp dụng sửa đổi trang
            // (xóa/xoay/sắp xếp) làm template, không dùng file gốc.
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;

            // Nguồn xlsx/gsheet: csvData chỉ là 20 dòng PREVIEW. Đọc lại TOÀN BỘ
            // record ở backend trước khi sinh lô, tránh xuất thiếu dữ liệu âm thầm.
            const fullData = await resolveFullSourceData();
            const transportFile = dataMode === 'csv' ? (lastCsvFileRef.current ?? undefined) : undefined;
            const jobId = await startVdpJobBackend(templateFile, vdpFields, fullData, 'vdp.datamerge', transportFile, csvHasHeader);
            activeVdpJobRef.current = jobId;
            setActiveVdpJobId(jobId);

            // Poll
            pollAbortRef.current = new AbortController();
            // UIUX (audit 2026-07-27 §D-07): lưu thêm {processed,total} vào state cho ProgressBar
            const result = await pollVdpJob(jobId, (m, info) => { setStatusMessage(m); setProgressInfo(info ?? null); }, true, pollAbortRef.current.signal);
            const blob = result.blob;
            const path = result.path;
            if (!blob) throw new Error(t('preprocess.dataMerge:khong_nhan_duoc_file_ket_qua_tu_may_chu'));

            const originalName = pdfFile.name.replace(/\.[^/.]+$/, "") || "Document";
            const outName = `VDP_${originalName}_${fullData.length || 1}records.pdf`;
            
            if (spawnNewTab && onSpawnTab) {
                setStatusMessage(t('preprocess.dataMerge:dang_mo_file_ket_qua_n_ban_ghi', { n: fullData.length }));
                // Small delay so the UI updates with the message before the heavy tab creation
                await new Promise(r => setTimeout(r, 100));
                onSpawnTab(blob, outName, path ?? undefined);
                setStatusMessage(t('preprocess.dataMerge:hoan_thanh_da_tao_tab_pdf_moi'));
            } else if (onApplyResult) {
                setStatusMessage(t('preprocess.dataMerge:dang_mo_file_ket_qua'));
                await new Promise(r => setTimeout(r, 100));
                await onApplyResult(blob, outName, path ?? undefined);
                setStatusMessage(t('preprocess.dataMerge:hoan_thanh_da_de_du_lieu_len_file_hien'));
            }
        } catch (error: any) {
            // UIUX (audit 2026-07-27 §D-15): hủy → báo nhẹ; lỗi khác → câu Việt + hướng khắc phục
            if (isCanceled(error)) { setStatusMessage(t('preprocess.dataMerge:da_huy', 'Đã hủy')); return; }
            console.error("PDF Generation Error:", error);
            setStatusMessage(formatError(error, t('preprocess.dataMerge:khong_chay_duoc_vdp', 'Không chạy được VDP'))); // UIUX (audit 2026-07-27 §D-15)
        } finally {
            activeVdpJobRef.current = null;
            setActiveVdpJobId(null);
            setProgressInfo(null); // UIUX (audit 2026-07-27 §D-07)
            setIsGenerating(false);
        }
    };

    const [spawnNewTab, setSpawnNewTab] = useState(true);

    return (
        <div className="flex w-full flex-col gap-4">
            {/* Header */}
            <div className="flex items-center gap-2 pt-2 pb-3 border-b border-slate-200 dark:border-zinc-700">
                <div className="flex-1 min-w-0 text-center">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span>🔤</span>
                        <span>{t('preprocess.dataMerge:tron_du_lieu_vdp')}</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">{t('preprocess.dataMerge:ve_vung_du_lieu_truc_tiep_tren_pdf')}</p>
                </div>
            </div>

            {/* Data Section: CSV / Excel / Google Sheets / Nhập tay */}
            <VdpSection step="1" title={t('preprocess.dataMerge:du_lieu_csv_excel_sheets_nhap_tay')} defaultOpen>
                <div className="grid grid-cols-2 gap-1 mb-3 p-0.5 bg-slate-100 dark:bg-zinc-800 rounded-md">
                    <button
                        onClick={() => setDataMode('csv')}
                        className={`h-8 text-[12px] font-semibold rounded transition-colors ${dataMode === 'csv' ? 'bg-white dark:bg-zinc-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700'}`}
                    >{t('preprocess.dataMerge:tai_csv')}</button>
                    <button
                        onClick={() => setDataMode('xlsx')}
                        className={`h-8 text-[12px] font-semibold rounded transition-colors ${dataMode === 'xlsx' ? 'bg-white dark:bg-zinc-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700'}`}
                    >📊 Excel</button>
                    <button
                        onClick={() => setDataMode('gsheet')}
                        className={`h-8 text-[12px] font-semibold rounded transition-colors ${dataMode === 'gsheet' ? 'bg-white dark:bg-zinc-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700'}`}
                    >🔗 Sheets</button>
                    <button
                        onClick={() => { setDataMode('manual'); applyManualData(manualText, manualColName); }}
                        className={`h-8 text-[12px] font-semibold rounded transition-colors ${dataMode === 'manual' ? 'bg-white dark:bg-zinc-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700'}`}
                    >{t('preprocess.dataMerge:nhap_tay')}</button>
                </div>

                {dataMode === 'manual' ? (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 shrink-0">{t('preprocess.dataMerge:ten_cot')}</span>
                            <input
                                value={manualColName}
                                onChange={(e) => { setManualColName(e.target.value); applyManualData(manualText, e.target.value); }}
                                placeholder="Noidung"
                                className="flex-1 h-7 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded focus:outline-none focus:border-blue-500"
                            />
                        </div>
                        <textarea
                            value={manualText}
                            onChange={(e) => { setManualText(e.target.value); applyManualData(e.target.value, manualColName); }}
                            placeholder={t('preprocess.dataMerge:placeholder_nhap_tay_moi_dong_1_ban_ghi')}
                            rows={5}
                            className="w-full p-2 text-[12px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-blue-500 resize-y leading-relaxed"
                        />
                        <p className="text-[10px] text-slate-400 leading-snug">
                            {t('preprocess.dataMerge:moi_dong_la_1_ban_ghi')} <b>{t('preprocess.dataMerge:1_dong_1_trang')}</b>{t('preprocess.dataMerge:nhieu_dong_nhieu_trang')}
                            {t('preprocess.dataMerge:field_can_dung_thi_gan_vao_cot')} <b>"{manualColName || 'Noidung'}"</b>.
                            {t('preprocess.dataMerge:muon_cung_1_noi_dung_co_dinh')}
                        </p>
                    </div>
                ) : dataMode === 'csv' ? (
                <>
                <label className="flex items-center justify-center w-full p-3 border-2 border-dashed border-blue-300 dark:border-blue-700/50 rounded-md cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                        <span className="text-sm font-medium">{t('preprocess.dataMerge:tai_file_csv_1_hoac_nhieu')}</span>
                    </div>
                    <input type="file" accept=".csv" multiple onChange={handleCsvFiles} className="hidden" />
                </label>

        <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
            <input
                type="checkbox"
                checked={csvHasHeader}
                onChange={(e) => {
                    const v = e.target.checked;
                    setCsvHasHeader(v);
                    if (lastCsvFileRef.current) loadCsvIntoState(lastCsvFileRef.current, v);
                }}
                className="w-4 h-4 accent-blue-500"
            />
            <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">{t('preprocess.dataMerge:hang_dau_la_tieu_de_cot')}</span>
        </label>
        <p className="text-[10px] text-slate-400 leading-snug -mt-1">{t('preprocess.dataMerge:bo_chon_neu_file_khong_co_dong_tieu_de')}</p>
        </>
        ) : dataMode === 'xlsx' ? (
        <>
            <label className="flex items-center justify-center w-full p-3 border-2 border-dashed border-emerald-300 dark:border-emerald-700/50 rounded-md cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    <span className="text-sm font-medium">{xlsxFile ? t('preprocess.dataMerge:doi_file_excel_xlsx') : t('preprocess.dataMerge:tai_file_excel_xlsx')}</span>
                </div>
                <input type="file" accept=".xlsx" onChange={handleXlsxFile} className="hidden" />
            </label>
            {xlsxFile && (
                <div className="mt-2 text-[12px] text-slate-600 dark:text-zinc-300 truncate" title={xlsxFile.name}>
                    📊 {xlsxFile.name}
                </div>
            )}
            {sheetList.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">{t('preprocess.dataMerge:chon_sheet_n', { n: sheetList.length })}</span>
                    <select
                        value={selectedSheet}
                        onChange={(e) => handleSheetChange(e.target.value)}
                        disabled={sourceLoading}
                        className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                    >
                        {sheetList.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
            )}
            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={csvHasHeader}
                    onChange={(e) => {
                        const v = e.target.checked;
                        setCsvHasHeader(v);
                        if (xlsxFile && selectedSheet) loadXlsxSheet(xlsxFile, selectedSheet);
                    }}
                    className="w-4 h-4 accent-emerald-500"
                />
                <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">{t('preprocess.dataMerge:hang_dau_la_tieu_de_cot')}</span>
            </label>
        </>
        ) : (
        <>
            <div className="flex flex-col gap-2">
                <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">{t('preprocess.dataMerge:link_google_sheets_chia_se_cong_khai')}</span>
                <input
                    type="url"
                    value={gsheetUrl}
                    onChange={(e) => setGsheetUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') loadGsheet(); }}
                    placeholder="https://docs.google.com/spreadsheets/d/.../edit"
                    className="w-full h-8 px-2 text-[12px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-blue-500"
                />
                <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={csvHasHeader}
                        onChange={(e) => setCsvHasHeader(e.target.checked)}
                        className="w-4 h-4 accent-blue-500"
                    />
                    <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">{t('preprocess.dataMerge:hang_dau_la_tieu_de_cot')}</span>
                </label>
                <button
                    onClick={loadGsheet}
                    disabled={sourceLoading || !gsheetUrl.trim()}
                    className="self-start h-8 px-4 text-[12px] font-semibold bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {sourceLoading ? t('preprocess.dataMerge:dang_tai') : t('preprocess.dataMerge:lay_du_lieu')}
                </button>
                <p className="text-[10px] text-slate-400 leading-snug">
                    {t('preprocess.dataMerge:sheet_phai_duoc_chia_se_cong_khai')}
                </p>
            </div>
        </>
        )}

        {sourceLoading && (
            <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-zinc-400">
                <svg className="w-4 h-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                {t('preprocess.dataMerge:dang_doc_nguon_du_lieu')}
            </div>
        )}

        {sourceError && (
            <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-[12px] text-red-700 dark:text-red-300 leading-snug">
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <span>{sourceError}</span>
            </div>
        )}

        {csvHeaders.length > 0 && (
            <div className="text-[13px] text-slate-600 dark:text-zinc-400 space-y-2">
                {batchFiles.length < 2 && (
                <div className="flex items-center justify-between">
                    <span>{t('preprocess.dataMerge:so_ban_ghi')}</span>
                    <span className="font-bold">{sourceRecordCount ?? csvData.length}</span>
                </div>
                )}
                <div className="flex items-center justify-between">
                    <span>{t('preprocess.dataMerge:cac_cot_n', { n: csvHeaders.length })}</span>
                    {!csvHasHeader && <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('preprocess.dataMerge:ten_theo_vi_tri')}</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {csvHeaders.map(h => (
                        <span key={h} title={h} className="px-2 py-1 max-w-[140px] truncate bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-md text-[11px] font-medium">{h}</span>
                    ))}
                </div>
                {csvHasHeader && csvHeaders.some(h => h.length > 25) && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-snug">{t('preprocess.dataMerge:ten_cot_trong_nhu_du_lieu_file_co_the')}</p>
                )}
            </div>
        )}

        {/* Khi chọn nhiều file: hiện danh sách + nút chạy hàng loạt (mỗi file → 1 tab) */}
        {batchFiles.length >= 2 && (
        <div className="mt-3 pt-3 border-t border-dashed border-slate-200 dark:border-zinc-700">
                <div className="mt-2 flex flex-col gap-2">
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400 leading-snug flex items-center justify-between gap-2">
                        <span>{t('preprocess.dataMerge:da_chon')} <b>{batchFiles.length}</b> file</span>
                        <button onClick={openBatchInfo} className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">{t('preprocess.dataMerge:chi_tiet')}</button>
                    </div>
                    <button
                        onClick={() => setBatchFiles([])}
                        disabled={isGenerating}
                        className="self-start h-8 px-3 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 border border-slate-300 dark:border-white/20 rounded-md hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
                    >
                        {t('preprocess.dataMerge:bo_chon')}
                    </button>
                </div>
            <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">{t('preprocess.dataMerge:cot_lay_tu_file_dau_de_map', { n: batchFiles.length })}</p>
        </div>
        )}
            </VdpSection>

            {/* Drag and Drop Toolbar */}
            <VdpSection step="2" title={t('preprocess.dataMerge:keo_tha_vao_pdf')} defaultOpen>
        <div className="grid grid-cols-2 gap-2">
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'text', t('preprocess.dataMerge:chu_text'))}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">{t('preprocess.dataMerge:chu_text')}</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'qrcode', t('preprocess.dataMerge:ma_qr'))}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">{t('preprocess.dataMerge:ma_qr')}</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'barcode', t('preprocess.dataMerge:ma_vach'))}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10H4zM4 14h16M4 18h16" strokeDasharray="2 2" /></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">{t('preprocess.dataMerge:ma_vach')}</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'image', t('preprocess.dataMerge:hinh_anh'))}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">{t('preprocess.dataMerge:hinh_anh')}</span>
            </div>
        </div>
            </VdpSection>

            {/* Field List */}
            <VdpSection step="3" title={t('preprocess.dataMerge:danh_sach_truong')} badge={<span className="text-[11px] px-2 py-0.5 bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-full font-medium text-slate-600 dark:text-zinc-400">{vdpFields.length}</span>}>
        <div className="max-h-[250px] overflow-y-auto space-y-2 pr-1 scroller-thin">
            {vdpFields.length === 0 ? (
                <div className="text-center text-xs text-slate-400 py-4 flex flex-col items-center gap-3">
                    <span>{t('preprocess.dataMerge:keo_drag_mot_cong_cu_tu_tren_vao_trang')}</span>
                </div>
            ) : (
                vdpFields.map(field => {
                    const isSelected = selectedFieldId === field.id;
                    return (
                        <div
                            key={field.id}
                            onClick={() => onSelectField?.([field.id])}
                            className={`w-full text-left p-2.5 rounded border transition-colors cursor-pointer ${isSelected ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/30 dark:border-blue-700' : 'bg-white border-slate-200 hover:bg-slate-100 dark:bg-zinc-800 dark:border-zinc-700 dark:hover:bg-zinc-700'}`}
                        >
                            <div className="flex items-center justify-between">
                                {isSelected ? (
                                    <div className="flex-1 mr-2 relative" onClick={e => e.stopPropagation()}>
                                        <input 
                                            list="csv-headers-list"
                                            value={field.name}
                                            onChange={(e) => {
                                                if (selectedFieldId === field.id) {
                                                    updateSelectedField({ name: e.target.value });
                                                }
                                            }}
                                            className="w-full h-8 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:border-teal-500 transition-all shadow-sm"
                                            placeholder={t('preprocess.dataMerge:ten_truong_khop_header_csv')}
                                            autoFocus
                                        />
                                        <datalist id="csv-headers-list">
                                            {csvHeaders.map(h => <option key={h} value={h} />)}
                                        </datalist>
                                    </div>
                                ) : (
                                    <span className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate pr-2">{field.name || t('preprocess.dataMerge:chua_dat_ten')}</span>
                                )}
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <span className="text-[11px] px-1.5 py-0.5 bg-slate-100 dark:bg-zinc-700 rounded uppercase">{field.type}</span>
                                    {isSelected && (
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); deleteSelectedField(); }}
                                            className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                            title={t('preprocess.dataMerge:xoa_truong_nay')}
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })
            )}
        </div>
            </VdpSection>

            {/* Field Settings Editor */}
            {selectedField && (
                <VdpSection step="4" title={t('preprocess.dataMerge:cai_dat_truong')} accent defaultOpen>
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1 p-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                            <span className="text-[12px] font-bold text-blue-700 dark:text-blue-400 block mb-1">{t('preprocess.dataMerge:cot_chinh_cua_o_nay')}</span>
                            <select 
                                value={csvHeaders.includes(selectedField.name) ? selectedField.name : ""}
                                onChange={(e) => updateSelectedField({ name: e.target.value })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:border-blue-500 transition-all text-blue-900 dark:text-blue-100"
                            >
                                <option value="" disabled>{t('preprocess.dataMerge:chon_cot_du_lieu_de_ghep')}</option>
                                {csvHeaders.map(h => (
                                    <option key={h} value={h}>{h}</option>
                                ))}
                            </select>
                            <span className="text-[10px] text-blue-600/80 mt-1 italic">
                                {t('preprocess.dataMerge:gia_tri_cot_nay_se_duoc_in_vao_o')}
                                {selectedField.type === 'text' && <> {t('preprocess.dataMerge:hoac_go_thang')} {t('preprocess.dataMerge:ten_cot_2')} {t('preprocess.dataMerge:vao_vung_noi_dung_ben_duoi')}</>}
                            </span>
                        </div>
                    
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:loai_cong_cu')}</span>
                            <select 
                                value={selectedField.type}
                                onChange={(e) => updateSelectedField({ type: e.target.value })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                            >
                                <option value="text">{t('preprocess.dataMerge:chu_text')}</option>
                                <option value="qrcode">{t('preprocess.dataMerge:ma_qr_qrcode')}</option>
                                <option value="barcode">{t('preprocess.dataMerge:ma_vach_barcode')}</option>
                                <option value="image">{t('preprocess.dataMerge:hinh_anh_image')}</option>
                            </select>
                        </div>
                        
                        {/* UIUX (audit 2026-07-27 §M-4/§D-01): X/Y + W/H cho MỌI loại field kể cả
                            text. Field lưu theo "mm phồng" (CSS px). Hiển thị/nhập theo mm THẬT
                            (×0.75) để khớp kích thước trang & file xuất. */}
                        <div className="grid grid-cols-2 gap-3 mt-1">
                            <ToolNumberInput
                                label={t('preprocess.dataMerge:vi_tri_x', 'Vị trí X')}
                                value={Math.round((selectedField.x || 0) * 0.75 * 100) / 100}
                                onChange={(val) => updateSelectedField({ x: val / 0.75 })}
                                suffix="mm" step={0.1}
                            />
                            <ToolNumberInput
                                label={t('preprocess.dataMerge:vi_tri_y', 'Vị trí Y')}
                                value={Math.round((selectedField.y || 0) * 0.75 * 100) / 100}
                                onChange={(val) => updateSelectedField({ y: val / 0.75 })}
                                suffix="mm" step={0.1}
                            />
                            <ToolNumberInput
                                label={t('preprocess.dataMerge:rong_w')}
                                value={Math.round((selectedField.width || 0) * 0.75 * 100) / 100}
                                onChange={(val) => updateSelectedField({ width: val / 0.75 })}
                                suffix="mm" step={0.1}
                            />
                            <ToolNumberInput
                                label="Cao H"
                                value={Math.round((selectedField.height || 0) * 0.75 * 100) / 100}
                                onChange={(val) => updateSelectedField({ height: val / 0.75 })}
                                suffix="mm" step={0.1}
                            />
                        </div>
                        {selectedFieldIds.length >= 1 && (
                            <VdpAlignPanel
                                vdpFields={vdpFields}
                                setVdpFields={setVdpFields}
                                selectedFieldIds={selectedFieldIds}
                                pageDimMm={viewerPageDimMm}
                            />
                        )}
                        {/* Xoay: áp cho MỌI loại field (text/qr/barcode/image). Backend
                            render_one_record xử lý field.rotation cho tất cả; trước đây
                            control này chỉ hiện trong khối barcode nên text/qr/ảnh không
                            xoay được. */}
                        <div className="flex flex-col gap-1 mt-1">
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:xoay_do')}</span>
                            <select
                                value={selectedField.rotation || 0}
                                onChange={(e) => updateSelectedField({ rotation: Number(e.target.value) })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                            >
                                <option value={0}>0°</option>
                                <option value={90}>90°</option>
                                <option value={180}>180°</option>
                                <option value={270}>270°</option>
                            </select>
                        </div>
                        {['text', 'qrcode', 'barcode'].includes(selectedField.type) && (
                            <div className="flex flex-col gap-3 mt-1">
                                <div className="flex flex-col gap-1">
                                    <span className="text-[10px] font-medium text-slate-500 block mb-1">
                                        {t('preprocess.dataMerge:noi_dung')} {selectedField.type === 'text' ? 'Text' : selectedField.type === 'qrcode' ? 'QR Code' : t('preprocess.dataMerge:ma_vach')} 
                                        <span className="text-slate-400 font-normal"> (gõ {t('preprocess.dataMerge:ten_cot_3')}, hoặc dùng "Chèn thêm cột vào câu" bên dưới)</span>
                                    </span>
                                    <input 
                                        type="text" 
                                        value={selectedField.textContent !== undefined ? selectedField.textContent : `{${selectedField.name}}`}
                                        onChange={(e) => updateSelectedField({ textContent: e.target.value })}
                                        placeholder={`Ví dụ: ${selectedField.type === 'qrcode' ? 'https://example.com/?id=' : 'Mã '}{${selectedField.name || 'Cột'}}`}
                                        className="w-full h-8 px-2.5 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                    />
                                </div>

                                {csvHeaders.length > 0 && (
                                    <div className="flex flex-col gap-1.5 p-2 rounded-md bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700">
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                onClick={() => setShowQuickInsert(v => !v)}
                                                className="flex items-center justify-between flex-1 text-[10px] font-bold text-slate-500 uppercase tracking-wide hover:text-teal-600 transition-colors"
                                                title={t('preprocess.dataMerge:cong_cu_tao_nhanh_placeholder_cot_de')}
                                            >
                                                <span>{t('preprocess.dataMerge:chen_them_cot_vao_cau_nang_cao')}</span>
                                                <svg className={`w-3.5 h-3.5 transition-transform ${showQuickInsert ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setShowQuickHelp(true)}
                                                title={t('preprocess.dataMerge:xem_huong_dan_vi_du')}
                                                className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-teal-600 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/10 hover:bg-teal-100 dark:hover:bg-teal-500/20 border border-teal-200 dark:border-teal-700 transition-colors"
                                            >
                                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" /><path strokeLinecap="round" d="M12 16.5h.01" /></svg>
                                            </button>
                                        </div>
                                        {showQuickInsert && (
                                        <>
                                        <span className="text-[10px] text-slate-400 italic">Tạo nhanh {t('preprocess.dataMerge:cot_3')} (có thể tách phần &amp; định dạng) rồi bấm Chèn vào ô Nội dung.</span>
                                        <div className="grid grid-cols-2 gap-1.5">
                                            <select value={splitCol} onChange={e => setSplitCol(e.target.value)} title={t('preprocess.dataMerge:chon_cot_du_lieu_muon_chen_placeholder')} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500">
                                                <option value="">{t('preprocess.dataMerge:chon_cot_2')}</option>
                                                {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                            </select>
                                            <select value={splitMode} onChange={e => setSplitMode(e.target.value)} title={t('preprocess.dataMerge:lay_ca_o_hoac_tach_theo_dau_roi_lay_1')} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500">
                                                <option value="whole">{t('preprocess.dataMerge:ca_cot_khong_tach')}</option>
                                                <option value="ws">{t('preprocess.dataMerge:tach_khoang_trang')}</option>
                                                <option value="-">{t('preprocess.dataMerge:tach_gach_ngang')}</option>
                                                <option value=",">{t('preprocess.dataMerge:tach_phay')}</option>
                                                <option value=";">{t('preprocess.dataMerge:tach_cham_phay')}</option>
                                                <option value="/">{t('preprocess.dataMerge:tach_gach_cheo')}</option>
                                                <option value="custom">{t('preprocess.dataMerge:tach_dau_khac')}</option>
                                            </select>
                                        </div>
                                        {splitMode !== 'whole' && (
                                            <div className="grid grid-cols-2 gap-1.5">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[11px] text-slate-500 shrink-0">{t('preprocess.dataMerge:phan')}</span>
                                                    <input type="number" min={1} value={splitPart} onChange={e => setSplitPart(Math.max(1, parseInt(e.target.value) || 1))} title={t('preprocess.dataMerge:lay_phan_thu_may_sau_khi_tach_1_phan')} className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                                                </div>
                                                {splitMode === 'custom' && (
                                                    <input value={splitCustom} onChange={e => setSplitCustom(e.target.value)} placeholder={t('preprocess.dataMerge:nhap_dau_phan_cach')} title={t('preprocess.dataMerge:ky_tu_dung_de_tach_o_vd_hoac')} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                                                )}
                                            </div>
                                        )}
                                        {/* #8 Định dạng dữ liệu */}
                                        <div className="grid grid-cols-2 gap-1.5">
                                            <select value={splitFmt} onChange={e => { setSplitFmt(e.target.value); setSplitFmtArg(e.target.value === 'date' ? '%d/%m/%Y' : ''); }} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" title={t('preprocess.dataMerge:bien_doi_gia_tri_truoc_khi_in_viet_hoa')}>
                                                <option value="">{t('preprocess.dataMerge:dinh_dang_khong')}</option>
                                                <option value="upper">{t('preprocess.dataMerge:chu_hoa')}</option>
                                                <option value="lower">{t('preprocess.dataMerge:chu_thuong')}</option>
                                                <option value="title">{t('preprocess.dataMerge:viet_hoa_dau_tu')}</option>
                                                <option value="number">{t('preprocess.dataMerge:so_1_234')}</option>
                                                <option value="money">{t('preprocess.dataMerge:tien_te')}</option>
                                                <option value="date">{t('preprocess.dataMerge:ngay_thang')}</option>
                                                <option value="pad">{t('preprocess.dataMerge:dem_so_0_000123')}</option>
                                            </select>
                                            {(splitFmt === 'number' || splitFmt === 'money' || splitFmt === 'pad' || splitFmt === 'date') && (
                                                <input
                                                    value={splitFmtArg}
                                                    onChange={e => setSplitFmtArg(e.target.value)}
                                                    placeholder={splitFmt === 'date' ? '%d/%m/%Y' : splitFmt === 'pad' ? t('preprocess.dataMerge:do_rong_vd_6') : t('preprocess.dataMerge:so_le_vd_0')}
                                                    className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500"
                                                />
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between gap-2">
                                            <code className="text-[11px] text-teal-600 dark:text-teal-400 font-mono truncate" title={t('preprocess.dataMerge:cu_phap_se_duoc_chen')}>{buildSplitToken() || '—'}</code>
                                            <button onClick={() => insertSplitToken(selectedField)} disabled={!splitCol} title={t('preprocess.dataMerge:chen_placeholder_vua_tao_vao_o_noi_dung')} className="shrink-0 h-7 px-3 text-[11px] font-semibold bg-teal-500 text-white rounded-md hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">{t('preprocess.dataMerge:chen')}</button>
                                        </div>
                                        </>
                                        )}
                                        {showQuickHelp && (
                                            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={() => setShowQuickHelp(false)}>
                                                <div className="max-w-lg w-full max-h-[80vh] overflow-auto bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-slate-200 dark:border-zinc-700" onClick={(e) => e.stopPropagation()}>
                                                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700 sticky top-0 bg-white dark:bg-zinc-900">
                                                        <span className="text-[14px] font-bold text-slate-800 dark:text-zinc-100">{t('preprocess.dataMerge:chen_them_cot_vao_cau_huong_dan')}</span>
                                                        <button type="button" onClick={() => setShowQuickHelp(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors" title={t('preprocess.dataMerge:dong')}>
                                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                    <div className="p-4 space-y-4 text-[12px] text-slate-600 dark:text-zinc-300 leading-relaxed">
                                                        <p>{t('preprocess.dataMerge:cong_cu_nay')} <b>{t('preprocess.dataMerge:tao_nhanh_placeholder')}</b> <code>{t('preprocess.dataMerge:cot_3')}</code> {t('preprocess.dataMerge:roi_bo_vao_o')} <b>{t('preprocess.dataMerge:noi_dung')}</b> {t('preprocess.dataMerge:khoi_phai_go_cu_phap_tay_khi_in_moi_ban')} <code>{t('preprocess.dataMerge:cot_3')}</code> {t('preprocess.dataMerge:bang_gia_tri_dong_cua_no')}</p>
                                                        <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60 space-y-2">
                                                            <div><b>{t('preprocess.dataMerge:1_chon_cot')}</b>{t('preprocess.dataMerge:lay_du_lieu_tu_cot_nao')}</div>
                                                            <div>
                                                                <b>{t('preprocess.dataMerge:2_ca_cot_tach')}</b>{t('preprocess.dataMerge:lay_nguyen_o_hoac_tach_theo_dau_roi_lay')}
                                                                <div className="text-slate-500 dark:text-zinc-400 mt-0.5">{t('preprocess.dataMerge:vd_o')} <code>123-456</code>{t('preprocess.dataMerge:tach')} <code>-</code> {t('preprocess.dataMerge:lay_phan_1')} <b>123</b>.</div>
                                                            </div>
                                                            <div>
                                                                <b>{t('preprocess.dataMerge:3_dinh_dang')}</b>{t('preprocess.dataMerge:bien_doi_gia_tri_truoc_khi_in')}
                                                                <div className="text-slate-500 dark:text-zinc-400 mt-0.5">{t('preprocess.dataMerge:viet_hoa_so')} <code>1,234</code> {t('preprocess.dataMerge:ngay')} <code>dd/mm/yyyy</code> {t('preprocess.dataMerge:dem_0')} <code>000123</code>.</div>
                                                            </div>
                                                            <div><b>{t('preprocess.dataMerge:b4_bam_chen')}</b>{t('preprocess.dataMerge:ghep_thanh_token_vd')} <code>{'{cao}'}</code>, <code>{'{cao[2|-]}'}</code>, <code>{'{cao|upper}'}</code>{t('preprocess.dataMerge:va_them_vao_o_noi_dung')}</div>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                                                            {t('preprocess.dataMerge:meo_ban_co_the_chen_nhieu_cot_vao_mot')} <code>{t('preprocess.dataMerge:ma_sku_ten')}</code>{t('preprocess.dataMerge:khong_can_cong_cu_nay_thi_go_tay')} <code>{t('preprocess.dataMerge:ten_cot_3')}</code> {t('preprocess.dataMerge:cung_duoc')}
                                                        </div>
                                                    </div>
                                                    <div className="px-4 py-3 border-t border-slate-200 dark:border-zinc-700 text-right">
                                                        <button type="button" onClick={() => setShowQuickHelp(false)} className="text-[12px] px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded font-medium transition-colors">{t('preprocess.dataMerge:da_hieu')}</button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {selectedField.type === 'text' && (
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:font_chu_font_family')}</span>
                                        <FontSelector 
                                            value={selectedField.fontName || 'Helvetica'}
                                            fontFile={selectedField.fontFile}
                                            onChange={(fontName, fontFile) => updateSelectedField({ fontName, fontFile })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:net_font_font_style')}</span>
                                        <select 
                                            value={selectedField.fontStyle || 'normal'}
                                            onChange={(e) => updateSelectedField({ fontStyle: e.target.value })}
                                            className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="normal">Regular</option>
                                            <option value="bold">Bold</option>
                                            <option value="italic">Italic</option>
                                            <option value="bolditalic">Bold Italic</option>
                                        </select>
                                    </div>
                                    
                                    <ToolNumberInput 
                                        label={t('preprocess.dataMerge:co_chu')}
                                        value={selectedField.fontSize || 13}
                                        onChange={(val) => updateSelectedField({ fontSize: val })}
                                        suffix="pt" step={1}
                                    />
                                    <ToolNumberInput 
                                        label={t('preprocess.dataMerge:dong_leading')}
                                        value={selectedField.lineHeight || 1}
                                        onChange={(val) => updateSelectedField({ lineHeight: val })}
                                        suffix="em" step={0.1}
                                    />
                                    <ToolNumberInput 
                                        label={t('preprocess.dataMerge:khoang_cach_tracking')}
                                        value={selectedField.characterSpacing || 0}
                                        onChange={(val) => updateSelectedField({ characterSpacing: val })}
                                        suffix="pt" step={0.5}
                                    />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:can_le')}</span>
                                        <div className="flex items-center gap-1.5">
                                            <select 
                                                value={selectedField.alignment || 'left'}
                                                onChange={(e) => updateSelectedField({ alignment: e.target.value })}
                                                className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                            >
                                                <option value="left">{t('preprocess.dataMerge:trai')}</option>
                                                <option value="center">{t('preprocess.dataMerge:giua')}</option>
                                                <option value="right">{t('preprocess.dataMerge:phai')}</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div className="col-span-2 flex items-center justify-between gap-2 py-1">
                                        <label className="flex items-center gap-2 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 cursor-pointer select-none">
                                            <input
                                                type="checkbox"
                                                checked={selectedField.autoFit !== false}
                                                onChange={(e) => updateSelectedField({ autoFit: e.target.checked })}
                                                className="w-4 h-4 accent-teal-500"
                                            />
                                            {t('preprocess.dataMerge:tu_bop_chu_vua_khung')}
                                        </label>
                                        <button
                                            title={t('preprocess.dataMerge:thu_chieu_cao_khung_vua_khit_noi_dung')}
                                            onClick={fitHeightToText}
                                            className="h-8 px-2 text-[11px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md hover:border-teal-500 hover:text-teal-600 transition-all"
                                        >
                                            {t('preprocess.dataMerge:thu_khung_theo_chu')}
                                        </button>
                                    </div>
                                    <div className="col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:mau_chu')}</span>
                                        <CmykColorPicker
                                            value={selectedField.fontColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ fontColor: hex })}
                                        />
                                    </div>
                                </div>
                                )}
                            </div>
                        )}

                        {selectedField.type === 'qrcode' && selectedField.qrStyle && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-white/10">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">{t('preprocess.dataMerge:tuy_chinh_qr_code')}</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:kieu_cham')}</span>
                                        <select 
                                            value={selectedField.qrStyle.dotType || 'square'}
                                            onChange={(e) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, dotType: e.target.value } })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="square">{t('preprocess.dataMerge:vuong')}</option>
                                            <option value="rounded">{t('preprocess.dataMerge:bo_tron')}</option>
                                            <option value="dots">{t('preprocess.dataMerge:cham_tron')}</option>
                                            <option value="classy">Classy</option>
                                            <option value="classy-rounded">Classy bo</option>
                                            <option value="extra-rounded">{t('preprocess.dataMerge:sieu_tron')}</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:sua_loi_muc')}</span>
                                        <select 
                                            value={selectedField.errorCorrection || 'M'}
                                            onChange={(e) => updateSelectedField({ errorCorrection: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="L">L (7%)</option>
                                            <option value="M">M (15%)</option>
                                            <option value="Q">Q (25%)</option>
                                            <option value="H">H (30%)</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:mau_cham')}</span>
                                        <CmykColorPicker
                                            value={selectedField.qrStyle.dotColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, dotColor: hex } })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:mau_nen')}</span>
                                        <CmykColorPicker
                                            value={selectedField.qrStyle.bgColor || '#FFFFFF'}
                                            onChange={(hex) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, bgColor: hex } })}
                                            disabled={selectedField.qrStyle.transparentBg}
                                        />
                                    </div>
                                    <ToolNumberInput 
                                        label={t('preprocess.dataMerge:le_trang_mm')}
                                        value={selectedField.quietZone ?? 2}
                                        onChange={(val) => updateSelectedField({ quietZone: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <div className="flex flex-col gap-1 col-span-2 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox"
                                                checked={selectedField.qrStyle.transparentBg || false}
                                                onChange={(e) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, transparentBg: e.target.checked } })}
                                                className="w-4 h-4 rounded border-slate-300 text-teal-500 focus:ring-teal-500"
                                            />
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">{t('preprocess.dataMerge:nen_trong_suot_transparent')}</span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        )}

                        {selectedField.type === 'barcode' && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-zinc-700">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">{t('preprocess.dataMerge:tuy_chinh_ma_vach')}</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:loai_ma_vach')}</span>
                                        <select 
                                            value={selectedField.barcodeType || 'code128'}
                                            onChange={(e) => updateSelectedField({ barcodeType: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="code128">{t('preprocess.dataMerge:code_128_da_nang_moi_ky_tu')}</option>
                                            <option value="ean13">{t('preprocess.dataMerge:ean_13_ban_le_13_so')}</option>
                                            <option value="upca">{t('preprocess.dataMerge:upc_a_ban_le_my_12_so')}</option>
                                            <option value="ean8">{t('preprocess.dataMerge:ean_8_gon_8_so')}</option>
                                            <option value="code39">{t('preprocess.dataMerge:code_39_cong_nghiep_a_z_so')}</option>
                                            <option value="itf14">{t('preprocess.dataMerge:itf_14_thung_carton_14_so')}</option>
                                            <option value="codabar">{t('preprocess.dataMerge:codabar_y_te_thu_vien')}</option>
                                        </select>
                                    </div>
                                    <ToolNumberInput 
                                        label={t('preprocess.dataMerge:do_cao_vach')}
                                        value={selectedField.barHeight || 12}
                                        onChange={(val) => updateSelectedField({ barHeight: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <ToolNumberInput 
                                        label={t('preprocess.dataMerge:le_trang_mm')}
                                        value={selectedField.quietZone ?? 2}
                                        onChange={(val) => updateSelectedField({ quietZone: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:mau_vach')}</span>
                                        <CmykColorPicker
                                            value={selectedField.barColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ barColor: hex })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:mau_nen')}</span>
                                        <CmykColorPicker
                                            value={selectedField.bgColor || '#FFFFFF'}
                                            onChange={(hex) => updateSelectedField({ bgColor: hex })}
                                            disabled={selectedField.transparentBg}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox"
                                                checked={selectedField.transparentBg || false}
                                                onChange={(e) => updateSelectedField({ transparentBg: e.target.checked })}
                                                className="w-4 h-4 rounded border-slate-300 text-teal-500 focus:ring-teal-500"
                                            />
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">{t('preprocess.dataMerge:nen_trong_suot_transparent')}</span>
                                        </label>
                                    </div>
                                    <div className="flex flex-col gap-2 col-span-2 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox"
                                                checked={selectedField.showText !== false}
                                                onChange={(e) => updateSelectedField({ showText: e.target.checked })}
                                                className="w-4 h-4 rounded border-slate-300 text-teal-500 focus:ring-teal-500"
                                            />
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">{t('preprocess.dataMerge:hien_thi_so_ben_duoi_ma')}</span>
                                        </label>
                                        
                                        {selectedField.showText !== false && (
                                            <div className="grid grid-cols-2 gap-3 mt-1">
                                                <ToolNumberInput 
                                                    label={t('preprocess.dataMerge:co_chu')}
                                                    value={selectedField.fontSize || 10}
                                                    onChange={(val) => updateSelectedField({ fontSize: val })}
                                                    suffix="pt" step={1}
                                                />
                                                <div>
                                                    <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:can_chu')}</span>
                                                    <div className="flex items-center gap-1.5">
                                                        <select 
                                                            value={selectedField.textAlign || 'center'}
                                                            onChange={(e) => updateSelectedField({ textAlign: e.target.value })}
                                                            className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                                        >
                                                            <option value="left">{t('preprocess.dataMerge:trai')}</option>
                                                            <option value="center">{t('preprocess.dataMerge:giua')}</option>
                                                            <option value="right">{t('preprocess.dataMerge:phai')}</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {selectedField.type === 'image' && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-zinc-700">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">{t('preprocess.dataMerge:tuy_chinh_hinh_anh')}</span>
                                <div className="text-[10px] text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700 rounded p-2 leading-relaxed">
                                    <b>{t('preprocess.dataMerge:ten_truong')}</b> {t('preprocess.dataMerge:cot_csv_chua')} <b>{t('preprocess.dataMerge:ten_file')}</b> (vd <code>anh.png</code>{t('preprocess.dataMerge:hoac_duong_dan_day_du_cua_anh_tung_ban')} <b>{t('preprocess.dataMerge:thu_muc_goc')}</b> {t('preprocess.dataMerge:ben_duoi')}
                                </div>
                                <div className="flex flex-col gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:thu_muc_goc_anh_neu_cot_chua_ten_file')}</span>
                                        <input
                                            value={selectedField.imageBaseDir || ''}
                                            onChange={(e) => updateSelectedField({ imageBaseDir: e.target.value })}
                                            placeholder="VD: D:\\anh_san_pham"
                                            className="w-full h-9 px-2 text-[12px] font-mono bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:anh_mac_dinh_khi_cot_rong_khong_bat')}</span>
                                        <input
                                            value={selectedField.imagePath || ''}
                                            onChange={(e) => updateSelectedField({ imagePath: e.target.value })}
                                            placeholder="VD: D:\\anh_san_pham\\default.png"
                                            className="w-full h-9 px-2 text-[12px] font-mono bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:hinh_dang_khung_shape')}</span>
                                        <select 
                                            value={selectedField.imageShape || 'rectangle'}
                                            onChange={(e) => updateSelectedField({ imageShape: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="rectangle">{t('preprocess.dataMerge:hinh_chu_nhat_vuong')}</option>
                                            <option value="rounded">{t('preprocess.dataMerge:bo_goc_rounded_rectangle')}</option>
                                            <option value="circle">{t('preprocess.dataMerge:hinh_tron_oval')}</option>
                                            <option value="polygon">{t('preprocess.dataMerge:da_giac_polygon')}</option>
                                            <option value="star">{t('preprocess.dataMerge:hinh_ngoi_sao_star')}</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.dataMerge:che_do_can_chinh_fit')}</span>
                                        <select 
                                            value={selectedField.imageFit || 'cover'}
                                            onChange={(e) => updateSelectedField({ imageFit: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="cover">{t('preprocess.dataMerge:vua_khung_cat_phan_thua_cover')}</option>
                                            <option value="fill">{t('preprocess.dataMerge:bop_meo_vua_khit_khung_fill')}</option>
                                            <option value="contain">{t('preprocess.dataMerge:giu_ty_le_thay_toan_bo_anh_contain')}</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </VdpSection>
            )}

            {/* Logic điều kiện: ẩn/hiện + bảng rule cho field (task 14.2, Req 2.1/2.2/2.5/2.6) */}
            {selectedField && (
                <VdpSection step="5" title={t('preprocess.dataMerge:logic_dieu_kien_an_hien_rule')} defaultOpen={false}>
                    <VdpLogicPanel
                        field={selectedField}
                        csvHeaders={csvHeaders}
                        isActive={isActive}
                        onChange={updateSelectedField}
                    />
                </VdpSection>
            )}

            {/* Xem trước record + điều hướng + dấu lỗi (task 14.3, Req 4.2/4.3/4.5/4.6/4.9) */}
            <VdpSection step="6" title={t('preprocess.dataMerge:xem_truoc_record')} defaultOpen={false}>
                <div className="flex flex-col gap-3">
                    {/* Điều hướng record: Prev / ô chỉ số / Next + nút Xem */}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => goToPreview(previewIndex - 1)}
                            disabled={previewLoading || previewTotal <= 0}
                            title={t('preprocess.dataMerge:record_truoc')}
                            className="shrink-0 h-8 w-8 flex items-center justify-center rounded border border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                        </button>
                        <div className="flex items-center gap-1 flex-1 min-w-0 justify-center">
                            <input
                                type="number"
                                min={1}
                                max={previewTotal || 1}
                                value={previewIndex}
                                onChange={(e) => setPreviewIndex(Math.max(1, Number(e.target.value) || 1))}
                                onKeyDown={(e) => { if (e.key === 'Enter') goToPreview(previewIndex); }}
                                className="h-8 w-16 px-2 text-[12px] text-center bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded focus:outline-none focus:border-teal-500 transition-all"
                            />
                            <span className="text-[12px] text-slate-500 dark:text-zinc-400 shrink-0">
                                / {previewTotal > 0 ? previewTotal.toLocaleString('vi-VN') : 0}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => goToPreview(previewIndex + 1)}
                            disabled={previewLoading || previewTotal <= 0}
                            title={t('preprocess.dataMerge:record_ke_tiep')}
                            className="shrink-0 h-8 w-8 flex items-center justify-center rounded border border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                        </button>
                        <button
                            type="button"
                            onClick={() => goToPreview(previewIndex)}
                            disabled={previewLoading || previewTotal <= 0}
                            className="shrink-0 h-8 px-3 text-[12px] font-semibold bg-teal-600 hover:bg-teal-700 disabled:bg-slate-400 disabled:cursor-not-allowed text-white rounded transition-colors"
                        >
                            {/* UIUX (audit 2026-07-27 §D-05) */}
                            {t('preprocess.dataMerge:nut_xem', 'Xem')}
                        </button>
                    </div>

                    {/* Thông báo (đã kẹp / nguồn rỗng / lỗi) */}
                    {previewMsg && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 px-2 py-1.5 rounded leading-snug">
                            {previewMsg}
                        </div>
                    )}

                    {/* Khung ảnh xem trước + overlay dấu lỗi */}
                    <div className="relative rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 overflow-hidden min-h-[120px] flex items-center justify-center">
                        {previewImg ? (
                            <div className="relative inline-block w-full">
                                <img
                                    src={previewImg}
                                    alt={`Xem trước record ${previewRecordIndex}`}
                                    className="block w-full h-auto select-none"
                                    draggable={false}
                                />
                                {/* Dấu hiệu lỗi field: rect theo pixel ảnh → quy về % để
                                    tự co giãn theo kích thước hiển thị (Req 4.6). */}
                                {previewDims.w > 0 && previewDims.h > 0 && previewErrors.map((er, i) => (
                                    <div
                                        key={i}
                                        title={`${er.kind}: ${er.field}${er.reason ? ' — ' + er.reason : ''}`}
                                        className="absolute border-2 border-red-500 bg-red-500/15 pointer-events-auto"
                                        style={{
                                            left: `${(er.rect.x / previewDims.w) * 100}%`,
                                            top: `${(er.rect.y / previewDims.h) * 100}%`,
                                            width: `${(er.rect.w / previewDims.w) * 100}%`,
                                            height: `${(er.rect.h / previewDims.h) * 100}%`,
                                        }}
                                    >
                                        <span className="absolute -top-4 left-0 text-[9px] font-bold text-white bg-red-500 px-1 rounded-sm whitespace-nowrap">
                                            {er.kind}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-[12px] text-slate-400 dark:text-zinc-500 py-8 px-3 text-center">
                                {/* UIUX (audit 2026-07-27 §D-05) */}
                                {t('preprocess.dataMerge:bam_xem_de_tao_ban_xem_truoc_record', 'Bấm "Xem" để tạo bản xem trước record.')}
                            </div>
                        )}

                        {/* Chỉ báo đang xử lý — chỉ hiện khi vượt 2 giây (Req 4.3, 8.5) */}
                        {previewProcessing && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-[1px]">
                                <svg className="animate-spin h-6 w-6 text-teal-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                <span className="text-[11px] font-medium text-slate-600 dark:text-zinc-300">{t('preprocess.dataMerge:dang_xu_ly_xem_truoc')}</span>
                            </div>
                        )}
                    </div>

                    {/* Liệt kê lỗi field của record đang xem (MISSING/ERR) */}
                    {previewErrors.length > 0 && (
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] font-bold text-red-600 dark:text-red-400">
                                {/* UIUX (audit 2026-07-27 §D-05) */}
                                {t('preprocess.dataMerge:n_field_loi_o_record_nay', { defaultValue: '{{n}} field lỗi ở record này:', n: previewErrors.length })}
                            </span>
                            {previewErrors.map((er, i) => (
                                <div key={i} className="text-[10px] text-slate-600 dark:text-zinc-400 leading-snug">
                                    <span className="font-mono font-bold text-red-500">[{er.kind}]</span>{' '}
                                    <span className="font-semibold">{er.field}</span>
                                    {er.reason ? <span> — {er.reason}</span> : null}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </VdpSection>

            {/* Kiểm tra trước khi chạy + xuất báo cáo lỗi CSV (task 14.4, Req 4.7/4.8/5.8/5.9/5.10) */}
            <VdpSection step="7" title={t('preprocess.dataMerge:kiem_tra_truoc_khi_chay')} defaultOpen={false}>
                <div className="flex flex-col gap-3">
                    <span className="text-[10px] text-slate-500 dark:text-zinc-400 italic leading-snug">
                        {t('preprocess.dataMerge:kiem_tra_placeholder_anh_bien_doi_va')}
                    </span>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleManualValidate}
                            disabled={validating || vdpFields.length === 0}
                            className="flex-1 h-9 px-3 text-[12px] font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:bg-slate-400 disabled:cursor-not-allowed rounded-md transition-colors flex items-center justify-center gap-1.5"
                        >
                            {validating ? (
                                <>
                                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                    {t('preprocess.dataMerge:dang_kiem_tra')}
                                </>
                            ) : t('preprocess.dataMerge:kiem_tra_validate')}
                        </button>
                        <button
                            type="button"
                            onClick={handleExportReport}
                            disabled={reportLoading}
                            className="flex-1 h-9 px-3 text-[12px] font-semibold text-slate-700 dark:text-zinc-200 border border-slate-300 dark:border-white/20 rounded-md hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                            title={t('preprocess.dataMerge:tai_bao_cao_cac_record_co_loi_missing')}
                        >
                            {reportLoading ? t('preprocess.dataMerge:dang_tao') : t('preprocess.dataMerge:xuat_bao_cao_loi_csv')}
                        </button>
                    </div>

                    {/* Trạng thái gating */}
                    {validateGating && (
                        <div className={`text-[12px] font-semibold rounded-md px-3 py-2 ${
                            validateGating === 'block'
                                ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
                                : validateGating === 'needs_confirmation'
                                    ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                                    : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                        }`}>
                            {validateGating === 'block' && t('preprocess.dataMerge:co_loi_chan_khong_the_sinh_lo_cho_toi')}
                            {validateGating === 'needs_confirmation' && t('preprocess.dataMerge:chi_co_canh_bao_can_xac_nhan_truoc_khi')}
                            {validateGating === 'allow' && t('preprocess.dataMerge:khong_co_loi_san_sang_sinh_lo')}
                        </div>
                    )}

                    {/* Danh sách issue */}
                    {validateIssues.length > 0 && (
                        <div className="flex flex-col gap-1 max-h-56 overflow-y-auto scroller-thin pr-1">
                            {validateIssues.map((iss, i) => (
                                <div
                                    key={i}
                                    className={`text-[10px] leading-snug rounded px-2 py-1 ${
                                        iss.severity === 'error'
                                            ? 'bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-300'
                                            : 'bg-amber-50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-300'
                                    }`}
                                >
                                    <span className="font-mono font-bold uppercase">[{iss.severity === 'error' ? t('preprocess.dataMerge:loi') : t('preprocess.dataMerge:canh_bao')}]</span>{' '}
                                    {iss.record_idx != null && <span className="font-semibold">dòng {iss.record_idx}</span>}
                                    {iss.field ? <span> · {iss.field}</span> : null}
                                    {iss.reason ? <span> — {iss.reason}</span> : null}
                                </div>
                            ))}
                        </div>
                    )}
                    {validateGating === 'allow' && validateIssues.length === 0 && (
                        <span className="text-[11px] text-slate-400 dark:text-zinc-500">{t('preprocess.dataMerge:khong_co_loi_hay_canh_bao_nao')}</span>
                    )}
                </div>
            </VdpSection>

            {/* Action Buttons */}
            <div className="border-t border-slate-200 pt-4 dark:border-zinc-700">
                {/* UIUX (audit 2026-07-27 §D-07): đang chạy job → ProgressBar % thật + nút Hủy */}
                {statusMessage && (
                    isGenerating ? (
                        <ProgressBar
                            message={statusMessage}
                            processed={progressInfo?.processed}
                            total={progressInfo?.total}
                            onCancel={activeVdpJobId ? () => void cancelActiveVdp().catch((err) => setStatusMessage(formatError(err))) : undefined}
                            className="mb-3"
                        />
                    ) : (
                        <div className="text-[11px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 p-2 rounded mb-3 text-center">
                            {statusMessage}
                        </div>
                    )
                )}
                
                <button
                    onClick={() => batchFiles.length >= 2 ? handleBatchGenerate(batchFiles) : handleGenerate()}
                    disabled={isGenerating || vdpFields.length === 0 || csvData.length === 0}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
                >
                    {isGenerating ? (
                        <>
                            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                            {t('preprocess.common:run')}…
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                            {t('preprocess.common:run')}
                        </>
                    )}
                </button>
                {isGenerating && activeVdpJobId && (
                    <button
                        type="button"
                        onClick={() => void cancelActiveVdp().catch((err) => setStatusMessage(err?.message || String(err)))}
                        className="mt-2 w-full rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-700"
                    >
                        {t('tabs.imposition:huy_bo_cancel')}
                    </button>
                )}
                <div className="mt-2 flex items-center gap-2 px-1">
                    <input
                        type="checkbox"
                        id="spawnNewTabVdp"
                        checked={spawnNewTab}
                        onChange={(e) => setSpawnNewTab(e.target.checked)}
                        className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-600 cursor-pointer"
                    />
                    <label htmlFor="spawnNewTabVdp" className="text-[11px] text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                        {t('preprocess.dataMerge:mo_ket_qua_sang_tab_moi_thay_vi_de_file')}
                    </label>
                </div>
            </div>

            {showBatchInfo && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowBatchInfo(false)} onKeyDown={e => { if (e.key === 'Escape') setShowBatchInfo(false); }} tabIndex={-1} ref={el => el?.focus()}>
                    <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-full max-w-md max-h-[40vh] flex flex-col border border-slate-200 dark:border-zinc-700" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700">
                            <h3 className="text-sm font-bold text-slate-800 dark:text-white">{t('preprocess.dataMerge:danh_sach_file_csv', { n: batchFiles.length })}</h3>
                            <button onClick={() => setShowBatchInfo(false)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-500">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 scroller-thin">
                            {batchInfoLoading ? (
                                <div className="flex items-center justify-center gap-2 py-8 text-slate-500 text-sm">
                                    <div className="w-5 h-5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                                    {t('preprocess.dataMerge:dang_doc_n_file', { n: batchFiles.length })}
                                </div>
                            ) : (
                                <table className="w-full text-[12px]">
                                    <thead>
                                        <tr className="text-left text-slate-400 border-b border-slate-200 dark:border-zinc-700">
                                            <th className="py-1.5 px-2 font-semibold w-6">#</th>
                                            <th className="py-1.5 px-2 font-semibold">{t('preprocess.dataMerge:ten_file_2')}</th>
                                            <th className="py-1.5 px-2 font-semibold text-right">{t('preprocess.dataMerge:ban_ghi')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {batchInfo.map((it, i) => (
                                            <tr key={i} className="border-b border-slate-100 dark:border-zinc-700/50">
                                                <td className="py-1.5 px-2 text-slate-400">{i + 1}</td>
                                                <td className="py-1.5 px-2 text-slate-700 dark:text-zinc-200 break-all">{it.name}</td>
                                                <td className="py-1.5 px-2 text-right font-bold text-slate-800 dark:text-white">{it.records < 0 ? t('preprocess.dataMerge:loi_2') : it.records.toLocaleString('vi-VN')}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        {!batchInfoLoading && batchInfo.length > 0 && (
                            <div className="px-4 py-2.5 border-t border-slate-200 dark:border-zinc-700 flex items-center justify-between text-[12px]">
                                <span className="text-slate-500">{t('preprocess.dataMerge:tong_cong')}</span>
                                <span className="font-bold text-slate-800 dark:text-white">{batchInfo.reduce((s, it) => s + (it.records > 0 ? it.records : 0), 0).toLocaleString('vi-VN')} {t('preprocess.dataMerge:ban_ghi_2')}</span>
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
