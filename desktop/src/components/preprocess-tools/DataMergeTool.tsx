import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { startVdpDrag } from '../../utils/vdpDrag';
import Papa from 'papaparse';
import { startVdpJobBackend, getVdpJobStatus, downloadVdpJob, pollVdpJob, getSystemFonts, readVdpDatasource, listVdpSheets, previewVdpRecord, validateVdp, downloadVdpErrorReport, type VdpFieldError, type VdpIssue, type VdpGating } from '@/lib/api';
import { getQRBlob, DEFAULT_QR_STYLE } from '@/engine/barcode/qrEngine';
import { generateBarcodeDataURL } from '@/engine/barcode/barcodeEngine';
import { FontSelector } from './FontSelector';
import { ToolSectionLabel, ToolDivider, ToolNumberInput } from './ToolUI';
import { useVdpTool } from '@/hooks/useVdpTool';
import { sortFieldsGeometrically, buildMultiUpJobInput } from '@/lib/vdpUtils';
import { VdpAlignPanel } from './VdpAlignPanel';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

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

    const presets = [
        { c: 0, m: 0, y: 0, k: 100 }, // Black
        { c: 0, m: 0, y: 0, k: 0 },   // White
        { c: 100, m: 0, y: 0, k: 0 }, // Cyan
        { c: 0, m: 100, y: 0, k: 0 }, // Magenta
        { c: 0, m: 0, y: 100, k: 0 }, // Yellow
        { c: 0, m: 100, y: 100, k: 0 }, // Red
        { c: 100, m: 0, y: 100, k: 0 }, // Green
        { c: 100, m: 100, y: 0, k: 0 }, // Blue
        { c: 0, m: 50, y: 100, k: 0 }, // Orange
        { c: 0, m: 0, y: 0, k: 50 },  // Gray
    ];

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
                    <div className="text-[10px] font-bold text-slate-600 dark:text-zinc-400 mb-2 uppercase tracking-wider">Thông số CMYK</div>
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
function VdpLogicPanel({ field, csvHeaders, onChange }: {
    field: any;
    csvHeaders: string[];
    onChange: (changes: any) => void;
}) {
    const conditions: VdpFieldCondition[] = Array.isArray(field.conditions) ? field.conditions : [];
    const rules: VdpRule[] = Array.isArray(field.rules) ? field.rules : [];
    const defaultCol = csvHeaders[0] || '';
    const [showHelp, setShowHelp] = useState(false);

    // Đóng modal trợ giúp bằng phím ESC (chỉ gắn listener khi modal đang mở).
    useEffect(() => {
        if (!showHelp) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                setShowHelp(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showHelp]);

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
            {!csvHeaders.includes(selected) && <option value={selected}>{selected || '— chọn cột —'}</option>}
            {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
        </>
    );

    return (
        <div className="flex flex-col gap-4">
            {/* Nút trợ giúp: mở modal giải thích "khi nào dùng" bằng ví dụ đời thường */}
            <div className="flex items-start gap-2 text-[11px] text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 rounded p-2">
                <span className="flex-1">
                    Dùng khi <b>các bản in cần khác nhau theo dữ liệu</b> (vd: chỉ một số tem có dấu VIP, hoặc đổi ảnh/chữ theo cột).
                </span>
                <button
                    type="button"
                    onClick={() => setShowHelp(true)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-500/10 dark:hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-700 rounded font-medium transition-colors"
                    title="Khi nào dùng? Xem ví dụ"
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" /><path strokeLinecap="round" d="M12 16.5h.01" /></svg>
                    Khi nào dùng?
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
                            <span className="text-[14px] font-bold text-slate-800 dark:text-zinc-100">Logic điều kiện — khi nào dùng?</span>
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                                title="Đóng"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-4 space-y-4 text-[12px] text-slate-600 dark:text-zinc-300 leading-relaxed">
                            <p>
                                Bạn in <b>nhiều bản từ một bảng dữ liệu</b> (mỗi dòng = một tem/thẻ/vé).
                                Bình thường mọi bản giống khuôn, chỉ khác chữ điền vào. Phần này dùng khi
                                <b> một số bản cần khác nhau tuỳ dòng</b>.
                            </p>

                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">👁️ Điều kiện ẩn/hiện</div>
                                <div className="mb-1">Quyết định <b>có in chi tiết này hay không</b>.</div>
                                <div className="text-slate-500 dark:text-zinc-400">
                                    Ví dụ: vẽ sẵn dấu "VIP" lên thẻ → đặt <i>Hiện nếu</i> cột <code>Hạng</code> <i>Bằng</i> <code>VIP</code>.
                                    Chỉ khách VIP mới in dấu; khách khác bỏ trống.
                                </div>
                            </div>

                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">🔁 Bảng rule (đổi nội dung/ảnh)</div>
                                <div className="mb-1">Field <b>vẫn in</b>, nhưng <b>đổi chữ/ảnh theo dữ liệu</b>. Xét từ trên xuống, gặp dòng đúng đầu tiên thì lấy.</div>
                                <div className="text-slate-500 dark:text-zinc-400">
                                    Ví dụ ảnh: cột <code>Nước</code> <i>Bằng</i> <code>VN</code> → <code>co_vn.png</code>;
                                    <code>US</code> → <code>co_us.png</code>. Mỗi bản tự lấy đúng cờ.
                                    <br />
                                    Ví dụ chữ: cột <code>Điểm</code> <i>Chứa</i> ... → in "Vàng" / "Bạc".
                                </div>
                            </div>

                            <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                                <b>Phân biệt nhanh:</b> Ẩn/hiện = "có in không?" · Rule = "in cái gì vào?".
                                Không cần thì cứ để trống — field in bình thường.
                            </div>
                        </div>
                        <div className="px-4 py-3 border-t border-slate-200 dark:border-zinc-700 text-right">
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-[12px] px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded font-medium transition-colors"
                            >
                                Đã hiểu
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {csvHeaders.length === 0 && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-2 rounded">
                    Chưa nạp dữ liệu nguồn — hãy nạp CSV/Excel/Sheets để chọn cột.
                </div>
            )}

            {/* ── Điều kiện ẩn/hiện ── */}
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">Điều kiện ẩn/hiện</span>
                    <button
                        type="button"
                        onClick={addCondition}
                        className="text-[11px] px-2 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-500/10 dark:hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-700 rounded font-medium transition-colors"
                    >
                        + Thêm điều kiện
                    </button>
                </div>
                <span className="text-[10px] text-slate-500 dark:text-zinc-400 italic">
                    Nếu cột thoả điều kiện → hiện (show_if) hoặc ẩn (hide_if) field này.
                </span>
                <span className="text-[10px] text-teal-700 dark:text-teal-400">
                    Ví dụ: Hiện nếu <b>Hạng</b> Bằng <b>VIP</b> → chỉ khách VIP mới in field này.
                </span>
                {conditions.length === 0 ? (
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500">Chưa có điều kiện (field luôn hiện).</span>
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
                                        <option value="show_if">Hiện nếu</option>
                                        <option value="hide_if">Ẩn nếu</option>
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
                                        title="Xóa điều kiện"
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
                                        {VDP_OPERATORS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                                    </select>
                                    <input
                                        type="text"
                                        value={c.value}
                                        onChange={(e) => updateCondition(i, { value: e.target.value })}
                                        disabled={!operatorNeedsValue(c.operator)}
                                        placeholder={operatorNeedsValue(c.operator) ? 'Giá trị so sánh' : '(không cần giá trị)'}
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
                    <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">Bảng rule (đổi nội dung/ảnh)</span>
                    <button
                        type="button"
                        onClick={addRule}
                        className="text-[11px] px-2 py-1 bg-teal-50 hover:bg-teal-100 dark:bg-teal-500/10 dark:hover:bg-teal-500/20 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-700 rounded font-medium transition-colors"
                    >
                        + Thêm rule
                    </button>
                </div>
                <span className="text-[10px] text-slate-500 dark:text-zinc-400 italic">
                    Nếu cột thoả điều kiện → đặt nội dung/ảnh = kết quả. Áp rule khớp đầu tiên.
                </span>
                <span className="text-[10px] text-teal-700 dark:text-teal-400">
                    Ví dụ: <b>Nước</b> Bằng <b>VN</b> → kết quả <b>co_vn.png</b> (mỗi bản tự lấy đúng cờ).
                </span>
                {rules.length === 0 ? (
                    <span className="text-[11px] text-slate-400 dark:text-zinc-500">Chưa có rule.</span>
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
                                        title="Xóa rule"
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
                                        {VDP_OPERATORS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                                    </select>
                                    <input
                                        type="text"
                                        value={r.value}
                                        onChange={(e) => updateRule(i, { value: e.target.value })}
                                        disabled={!operatorNeedsValue(r.operator)}
                                        placeholder={operatorNeedsValue(r.operator) ? 'Giá trị so sánh' : '(không cần giá trị)'}
                                        className={inputClass + " flex-1 min-w-0 disabled:bg-slate-100 dark:disabled:bg-zinc-800 disabled:text-slate-400"}
                                    />
                                </div>
                                <input
                                    type="text"
                                    value={r.result}
                                    onChange={(e) => updateRule(i, { result: e.target.value })}
                                    placeholder="→ Kết quả (nội dung hoặc đường dẫn ảnh)"
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
  onBack?: () => void;
  onSpawnTab?: (blob: Blob, name: string, path?: string) => void;
  onApplyResult?: (blob: Blob, name: string, path?: string) => void;
  isActive?: boolean;
}
export default function DataMergeTool({
    pdfFile,
    getWorkingFile,
    vdpFields = [],
    setVdpFields,
    selectedFieldIds = [],
    onSelectField,
    onBack,
    onSpawnTab,
    onApplyResult,
    isActive = true
}: Props) {
    const [csvData, setCsvData] = useState<Record<string, string>[]>([]);
    const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
    const [dataMode, setDataMode] = useState<'csv' | 'manual' | 'xlsx' | 'gsheet'>('csv');
    const [manualText, setManualText] = useState('');
    const [manualColName, setManualColName] = useState('Noidung');
    const [statusMessage, setStatusMessage] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [systemFonts, setSystemFonts] = useState<{name: string, path: string}[]>([]);
    const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
    const [fontSearch, setFontSearch] = useState('');

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

    useEffect(() => {
        getSystemFonts().then(setSystemFonts).catch(console.error);
    }, []);

    // Hủy polling VDP khi component unmount để không poll vô hạn nền (#13).
    const pollAbortRef = useRef<AbortController | null>(null);
    useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

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

    const loadCsvIntoState = (file: File, hasHeader: boolean) => {
        setStatusMessage("Đang đọc file CSV...");
        parseCsv(file, hasHeader).then(({ headers, data, duplicated }) => {
            if (data.length > 0) {
                setCsvHeaders(headers);
                setCsvData(data);
                if (duplicated.length > 0) setStatusMessage(`Đã tải ${data.length} dòng. Lưu ý: cột trùng tên (${duplicated.join(', ')}) đã tự đổi tên.`);
                else setStatusMessage(`Đã tải ${data.length} dòng dữ liệu.`);
            } else {
                setCsvHeaders([]); setCsvData([]);
                setStatusMessage("File CSV rỗng hoặc lỗi định dạng.");
            }
        }).catch((err) => { console.error("CSV Parse Error:", err); setStatusMessage("Lỗi đọc file CSV."); });
    };

    const handleCsvFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []).filter(f => /\.csv$/i.test(f.name));
        e.currentTarget.value = '';
        if (!files.length) return;
        setBatchFiles(files);
        lastCsvFileRef.current = files[0];
        loadCsvIntoState(files[0], csvHasHeader);
        if (files.length > 1) {
            setStatusMessage(`Đã chọn ${files.length} file. Map trường với cột rồi bấm "Chạy ${files.length} file".`);
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
        setCsvHeaders(result.columns);
        setCsvData(result.preview_rows);
        setSourceRecordCount(result.record_count);
        if (result.record_count === 0) {
            setStatusMessage(`${label}: nguồn rỗng (0 bản ghi).`);
        } else {
            setStatusMessage(`${label}: ${result.record_count} bản ghi, ${result.columns.length} cột.`);
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
        setStatusMessage(`Đang đọc sheet "${sheet}"...`);
        try {
            const result = await readVdpDatasource({ kind: 'xlsx', file, sheet, hasHeader: csvHasHeader });
            applySourceResult(result, `Excel · ${sheet}`);
        } catch (err: any) {
            clearSourceState();
            setSourceError(err?.message || 'Không đọc được file Excel.');
            setStatusMessage('Lỗi đọc file Excel.');
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
        setStatusMessage('Đang đọc danh sách sheet...');
        try {
            const sheets = await listVdpSheets(file);
            setSheetList(sheets);
            const first = sheets[0] || '';
            setSelectedSheet(first);
            if (first) {
                await loadXlsxSheet(file, first);
            } else {
                setSourceLoading(false);
                setSourceError('File Excel không có sheet nào.');
                setStatusMessage('File Excel rỗng.');
            }
        } catch (err: any) {
            setSourceLoading(false);
            setXlsxFile(null);
            setSourceError(err?.message || 'Không đọc được file Excel.');
            setStatusMessage('Lỗi đọc file Excel.');
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
        if (!url) { setSourceError('Hãy dán link Google Sheets.'); return; }
        setSourceLoading(true);
        setSourceError('');
        setStatusMessage('Đang lấy dữ liệu Google Sheets...');
        try {
            const result = await readVdpDatasource({ kind: 'gsheet', url, hasHeader: csvHasHeader });
            applySourceResult(result, 'Google Sheets');
        } catch (err: any) {
            clearSourceState();
            setSourceError(err?.message || 'Không lấy được dữ liệu Google Sheets.');
            setStatusMessage('Lỗi lấy dữ liệu Google Sheets.');
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
            setStatusMessage('Nhập tay: chưa có nội dung (mỗi dòng = 1 bản ghi).');
            return;
        }
        setCsvHeaders([col]);
        setCsvData(lines.map(l => ({ [col]: l })));
        setStatusMessage(`Nhập tay: ${lines.length} bản ghi (cột "${col}").`);
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

    const {
        deleteSelectedField,
        handleGroupFields,
        handleUngroupFields
    } = useVdpTool(vdpFields, setVdpFields as any, selectedFieldIds, onSelectField, isActive);

    const selectedFieldId = selectedFieldIds[0];
    const selectedField = vdpFields.find(f => f.id === selectedFieldId);
    const viewerPageDimMm = useWorkspaceStore(s => s.viewerPageDimMm);
    const [isMultiUp, setIsMultiUp] = useState(false);
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
        if (!showQuickHelp) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setShowQuickHelp(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showQuickHelp]);
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



    // Xây dựng (fields, data) cho 1 job từ dữ liệu CSV — hỗ trợ chế độ Multi-up.
    const buildJobInput = (sourceData: Record<string, string>[]): { fields: any[]; data: Record<string, string>[] } => {
        if (!isMultiUp) return { fields: vdpFields, data: sourceData };
        return buildMultiUpJobInput(vdpFields, csvHeaders, sourceData);
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
        if (vdpFields.length === 0) { setStatusMessage("Chưa có trường dữ liệu (VDP Field) nào."); return; }
        if (!pdfFile) { setStatusMessage("Chưa có file PDF gốc."); return; }
        if (!onSpawnTab) { setStatusMessage("Không thể mở tab kết quả (thiếu onSpawnTab)."); return; }
        const files = Array.from(fileList).filter(f => /\.csv$/i.test(f.name));
        if (files.length === 0) { setStatusMessage("Không có file CSV hợp lệ."); return; }

        setIsGenerating(true);
        try {
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;
            let ok = 0;
            for (let i = 0; i < files.length; i++) {
                const csvFile = files[i];
                const tag = `(${i + 1}/${files.length}) ${csvFile.name}`;
                try {
                    setStatusMessage(`${tag}: đang đọc...`);
                    const data = (await parseCsv(csvFile, csvHasHeader)).data;
                    if (data.length === 0) { setStatusMessage(`${tag}: rỗng, bỏ qua.`); continue; }

                    // Gating validate cho từng file trước khi sinh (Req 5.8/5.9/5.10).
                    setStatusMessage(`${tag}: đang kiểm tra dữ liệu...`);
                    try {
                        const vres = await validateVdp({
                            fields: vdpFields,
                            rows: data,
                            columns: data.length ? Object.keys(data[0]) : [],
                            hasHeader: csvHasHeader,
                        });
                        if (vres.gating === 'block') {
                            const errCount = vres.issues.filter(i => i.severity === 'error').length;
                            setStatusMessage(`${tag}: có ${errCount} lỗi chặn — bỏ qua file này.`);
                            continue;
                        }
                        if (vres.gating === 'needs_confirmation') {
                            const warnCount = vres.issues.filter(i => i.severity === 'warning').length;
                            const ok = window.confirm(`${csvFile.name}: ${warnCount} cảnh báo (vd ảnh thiếu).\nVẫn tiếp tục sinh file này?`);
                            if (!ok) { setStatusMessage(`${tag}: đã bỏ qua do còn cảnh báo.`); continue; }
                        }
                    } catch (vErr: any) {
                        setStatusMessage(`${tag}: lỗi kiểm tra dữ liệu — ${vErr?.message || vErr}. Bỏ qua.`);
                        continue;
                    }

                    const { fields, data: jobData } = buildJobInput(data);
                    setStatusMessage(`${tag}: đang sinh ${data.length} bản ghi...`);
                    const jobId = await startVdpJobBackend(templateFile, fields, jobData);
                    pollAbortRef.current = new AbortController();
                    const result = await pollVdpJob(jobId, (m) => setStatusMessage(`${tag}: ${m}`), true, pollAbortRef.current.signal);
                    if (!result.blob) { setStatusMessage(`${tag}: lỗi không có kết quả.`); continue; }
                    const baseName = csvFile.name.replace(/\.[^/.]+$/, '') || `VDP_${i + 1}`;
                    onSpawnTab(result.blob, `${baseName}.pdf`, result.path ?? undefined);
                    ok++;
                    // Nhường UI một nhịp giữa các file
                    await new Promise(r => setTimeout(r, 50));
                } catch (err: any) {
                    if (err?.name === 'AbortError') return;
                    setStatusMessage(`${tag}: lỗi ${err.message}`);
                }
            }
            setStatusMessage(`Hoàn thành ${ok}/${files.length} file CSV.`);
        } catch (e: any) {
            if (e?.name === 'AbortError') return;
            setStatusMessage(`Lỗi xử lý hàng loạt: ${e.message}`);
        } finally {
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
            setPreviewMsg('Chưa có dữ liệu nguồn để xem trước.');
            return;
        }
        const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;
        if (!templateFile) {
            setPreviewMsg('Chưa có file PDF template để xem trước.');
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
            } else {
                params.rows = csvData;
                params.columns = csvHeaders;
            }

            const result = await previewVdpRecord(params);
            if (ac.signal.aborted) return;

            if (result.empty_source) {
                setPreviewImg(null);
                setPreviewErrors([]);
                setPreviewMsg(result.message || 'Nguồn dữ liệu rỗng (0 record).');
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
            setPreviewMsg(err?.message || 'Lỗi tạo bản xem trước.');
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
            setPreviewMsg('Nguồn dữ liệu rỗng (0 record) — không thể xem trước.');
            return;
        }
        let idx = target;
        let clampMsg = '';
        if (idx < 1) { idx = 1; clampMsg = 'Đã ở record đầu tiên.'; }
        else if (idx > previewTotal) { idx = previewTotal; clampMsg = 'Đã ở record cuối cùng.'; }
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
        if (vdpFields.length === 0) { setStatusMessage('Chưa có trường dữ liệu (VDP Field) nào.'); return; }
        setValidating(true);
        setStatusMessage('Đang kiểm tra dữ liệu...');
        try {
            const result = await runValidate();
            if (!result) return;
            const errCount = result.issues.filter(i => i.severity === 'error').length;
            const warnCount = result.issues.filter(i => i.severity === 'warning').length;
            if (result.gating === 'allow') setStatusMessage('Kiểm tra xong: không có lỗi, sẵn sàng sinh lô.');
            else if (result.gating === 'needs_confirmation') setStatusMessage(`Kiểm tra xong: ${warnCount} cảnh báo — cần xác nhận trước khi sinh lô.`);
            else setStatusMessage(`Kiểm tra xong: ${errCount} lỗi chặn — phải khắc phục trước khi sinh lô.`);
        } catch (err: any) {
            setStatusMessage(`Lỗi kiểm tra dữ liệu: ${err?.message || err}`);
        } finally {
            setValidating(false);
        }
    };

    // Gating trước khi sinh lô: chặn nếu có lỗi (Req 5.8), hỏi xác nhận nếu chỉ
    // cảnh báo (Req 5.9), cho chạy nếu sạch (Req 5.10). Trả true nếu được tiếp tục.
    const runPreGenerateValidation = async (): Promise<boolean> => {
        setValidating(true);
        setStatusMessage('Đang kiểm tra dữ liệu trước khi sinh lô...');
        try {
            const result = await runValidate();
            if (!result) return false;
            const errCount = result.issues.filter(i => i.severity === 'error').length;
            const warnCount = result.issues.filter(i => i.severity === 'warning').length;

            if (result.gating === 'block') {
                setStatusMessage(`Có ${errCount} lỗi chặn — không thể sinh lô. Mở mục "Kiểm tra trước khi chạy" để xem chi tiết.`);
                return false;
            }
            if (result.gating === 'needs_confirmation') {
                const ok = window.confirm(
                    `Phát hiện ${warnCount} cảnh báo (ví dụ: ảnh biến đổi thiếu file).\n\n` +
                    `Các record liên quan có thể bị thiếu nội dung. Bạn vẫn muốn tiếp tục sinh lô?`
                );
                if (!ok) {
                    setStatusMessage('Đã huỷ sinh lô do còn cảnh báo chưa xử lý.');
                    return false;
                }
                return true;
            }
            return true; // allow
        } catch (err: any) {
            setStatusMessage(`Lỗi kiểm tra dữ liệu: ${err?.message || err}`);
            return false;
        } finally {
            setValidating(false);
        }
    };

    // Xuất báo cáo lỗi CSV (Req 4.7, 4.8). Nếu đã validate → dùng issues hiện có;
    // nếu chưa → gửi fields + nguồn để backend tự tính (vẫn xuất CSV "không lỗi").
    const handleExportReport = async () => {
        setReportLoading(true);
        setStatusMessage('Đang tạo báo cáo lỗi CSV...');
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
            setStatusMessage('Đã xuất báo cáo lỗi CSV.');
        } catch (err: any) {
            setStatusMessage(`Lỗi xuất báo cáo lỗi: ${err?.message || err}`);
        } finally {
            setReportLoading(false);
        }
    };

    const handleGenerate = async () => {
        if (vdpFields.length === 0) {
            setStatusMessage("Chưa có trường dữ liệu (VDP Field) nào.");
            return;
        }
        if (!pdfFile) {
            setStatusMessage("Chưa có file PDF gốc.");
            return;
        }
        if (!csvData || csvData.length === 0) {
            setStatusMessage("Chưa có dữ liệu. Tải CSV hoặc chuyển sang 'Nhập tay' (mỗi dòng = 1 bản ghi).");
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

            const { fields: jobFields, data: jobData } = buildJobInput(fullData);
            const jobId = await startVdpJobBackend(templateFile, jobFields, jobData);

            // Poll
            pollAbortRef.current = new AbortController();
            const result = await pollVdpJob(jobId, setStatusMessage, true, pollAbortRef.current.signal);
            const blob = result.blob;
            const path = result.path;
            if (!blob) throw new Error('Không nhận được file kết quả từ máy chủ');

            const originalName = pdfFile.name.replace(/\.[^/.]+$/, "") || "Document";
            const outName = `VDP_${originalName}_${fullData.length || 1}records.pdf`;
            
            if (spawnNewTab && onSpawnTab) {
                setStatusMessage(`Đang mở file kết quả (${fullData.length} bản ghi)...`);
                // Small delay so the UI updates with the message before the heavy tab creation
                await new Promise(r => setTimeout(r, 100));
                onSpawnTab(blob, outName, path ?? undefined);
                setStatusMessage(`Hoàn thành! Đã tạo Tab PDF mới.`);
            } else if (onApplyResult) {
                setStatusMessage(`Đang mở file kết quả...`);
                await new Promise(r => setTimeout(r, 100));
                onApplyResult(blob, outName, path ?? undefined);
                setStatusMessage(`Hoàn thành! Đã đè dữ liệu lên file hiện tại.`);
            }
        } catch (error: any) {
            if (error?.name === 'AbortError') return;
            console.error("PDF Generation Error:", error);
            setStatusMessage(`Lỗi sinh file PDF: ${error.message}`);
        } finally {
            setIsGenerating(false);
        }
    };

    const [spawnNewTab, setSpawnNewTab] = useState(true);

    return (
        <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 p-4 gap-4 overflow-y-auto scroller-thin">
            {/* Header */}
            <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-zinc-700">
                <button 
                    onClick={onBack}
                    className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-md text-slate-500 transition-colors"
                    title="Quay lại"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                </button>
                <div className="flex-1 min-w-0 text-center pr-8">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span>🔤</span>
                        <span>TRỘN DỮ LIỆU VDP</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">Vẽ vùng dữ liệu trực tiếp trên PDF</p>
                </div>
            </div>

            {/* Data Section: CSV / Excel / Google Sheets / Nhập tay */}
            <VdpSection step="1" title="Dữ liệu (CSV / Excel / Sheets / Nhập tay)" defaultOpen>
                <div className="grid grid-cols-2 gap-1 mb-3 p-0.5 bg-slate-100 dark:bg-zinc-800 rounded-md">
                    <button
                        onClick={() => setDataMode('csv')}
                        className={`h-8 text-[12px] font-semibold rounded transition-colors ${dataMode === 'csv' ? 'bg-white dark:bg-zinc-700 text-blue-600 dark:text-blue-300 shadow-sm' : 'text-slate-500 dark:text-zinc-400 hover:text-slate-700'}`}
                    >📄 Tải CSV</button>
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
                    >✍️ Nhập tay</button>
                </div>

                {dataMode === 'manual' ? (
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 shrink-0">Tên cột:</span>
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
                            placeholder={'Mỗi dòng = 1 bản ghi.\nVí dụ:\nĐây là sản phẩm chính hãng của thương hiệu CCK\nMã 002\nMã 003'}
                            rows={5}
                            className="w-full p-2 text-[12px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-blue-500 resize-y leading-relaxed"
                        />
                        <p className="text-[10px] text-slate-400 leading-snug">
                            Mỗi dòng là 1 bản ghi: <b>1 dòng → 1 trang</b>, nhiều dòng → nhiều trang.
                            Field cần dùng thì gán vào cột <b>"{manualColName || 'Noidung'}"</b>.
                            (Muốn cùng 1 nội dung cố định trên mọi trang thì gõ thẳng nội dung vào ô text của field.)
                        </p>
                    </div>
                ) : dataMode === 'csv' ? (
                <>
                <label className="flex items-center justify-center w-full p-3 border-2 border-dashed border-blue-300 dark:border-blue-700/50 rounded-md cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                        <span className="text-sm font-medium">Tải file CSV (1 hoặc nhiều)</span>
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
            <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">Hàng đầu là tiêu đề cột</span>
        </label>
        <p className="text-[10px] text-slate-400 leading-snug -mt-1">Bỏ chọn nếu file không có dòng tiêu đề — cột sẽ tự đặt tên "Cột 1", "Cột 2"…</p>
        </>
        ) : dataMode === 'xlsx' ? (
        <>
            <label className="flex items-center justify-center w-full p-3 border-2 border-dashed border-emerald-300 dark:border-emerald-700/50 rounded-md cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    <span className="text-sm font-medium">{xlsxFile ? 'Đổi file Excel (.xlsx)' : 'Tải file Excel (.xlsx)'}</span>
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
                    <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Chọn sheet ({sheetList.length})</span>
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
                <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">Hàng đầu là tiêu đề cột</span>
            </label>
        </>
        ) : (
        <>
            <div className="flex flex-col gap-2">
                <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">Link Google Sheets (chia sẻ công khai)</span>
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
                    <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">Hàng đầu là tiêu đề cột</span>
                </label>
                <button
                    onClick={loadGsheet}
                    disabled={sourceLoading || !gsheetUrl.trim()}
                    className="self-start h-8 px-4 text-[12px] font-semibold bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {sourceLoading ? 'Đang tải…' : 'Lấy dữ liệu'}
                </button>
                <p className="text-[10px] text-slate-400 leading-snug">
                    Sheet phải được chia sẻ ở chế độ "Bất kỳ ai có đường liên kết". Dữ liệu được lấy qua đường export CSV của Google.
                </p>
            </div>
        </>
        )}

        {sourceLoading && (
            <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-zinc-400">
                <svg className="w-4 h-4 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Đang đọc nguồn dữ liệu…
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
                    <span>Số bản ghi:</span>
                    <span className="font-bold">{sourceRecordCount ?? csvData.length}</span>
                </div>
                )}
                <div className="flex items-center justify-between">
                    <span>Các cột ({csvHeaders.length}):</span>
                    {!csvHasHeader && <span className="text-[10px] text-amber-600 dark:text-amber-400">tên theo vị trí</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {csvHeaders.map(h => (
                        <span key={h} title={h} className="px-2 py-1 max-w-[140px] truncate bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-md text-[11px] font-medium">{h}</span>
                    ))}
                </div>
                {csvHasHeader && csvHeaders.some(h => h.length > 25) && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-snug">Tên cột trông như dữ liệu? File có thể KHÔNG có dòng tiêu đề — hãy bỏ chọn "Hàng đầu là tiêu đề cột" ở trên.</p>
                )}
            </div>
        )}

        {/* Khi chọn nhiều file: hiện danh sách + nút chạy hàng loạt (mỗi file → 1 tab) */}
        {batchFiles.length >= 2 && (
        <div className="mt-3 pt-3 border-t border-dashed border-slate-200 dark:border-zinc-700">
                <div className="mt-2 flex flex-col gap-2">
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400 leading-snug flex items-center justify-between gap-2">
                        <span>Đã chọn <b>{batchFiles.length}</b> file</span>
                        <button onClick={openBatchInfo} className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">Chi tiết</button>
                    </div>
                    <button
                        onClick={() => setBatchFiles([])}
                        disabled={isGenerating}
                        className="self-start h-8 px-3 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 border border-slate-300 dark:border-white/20 rounded-md hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
                    >
                        Bỏ chọn
                    </button>
                </div>
            <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">Cột lấy từ file đầu để map. Map xong bấm nút "Chạy {batchFiles.length} file" ở dưới — mỗi file ra 1 tab đặt tên theo tên file CSV.</p>
        </div>
        )}
            </VdpSection>

            {/* Drag and Drop Toolbar */}
            <VdpSection step="2" title="Kéo thả vào PDF" defaultOpen>
        <div className="grid grid-cols-2 gap-2">
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'text', 'Chữ (Text)')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Chữ (Text)</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'qrcode', 'Mã QR')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Mã QR</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'barcode', 'Mã vạch')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10H4zM4 14h16M4 18h16" strokeDasharray="2 2" /></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Mã vạch</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'image', 'Hình ảnh')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Hình ảnh</span>
            </div>
        </div>
            </VdpSection>

            {/* Field List */}
            <VdpSection step="3" title="Danh sách trường" badge={<span className="text-[11px] px-2 py-0.5 bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-full font-medium text-slate-600 dark:text-zinc-400">{vdpFields.length}</span>}>
        <div className="max-h-[250px] overflow-y-auto space-y-2 pr-1 scroller-thin">
            {vdpFields.length === 0 ? (
                <div className="text-center text-xs text-slate-400 py-4 flex flex-col items-center gap-3">
                    <span>Kéo (drag) một công cụ từ trên vào trang PDF để tạo trường.</span>
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
                                            placeholder="Tên trường (Khớp header CSV)..."
                                            autoFocus
                                        />
                                        <datalist id="csv-headers-list">
                                            {csvHeaders.map(h => <option key={h} value={h} />)}
                                        </datalist>
                                    </div>
                                ) : (
                                    <span className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate pr-2">{field.name || 'Chưa đặt tên'}</span>
                                )}
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <span className="text-[11px] px-1.5 py-0.5 bg-slate-100 dark:bg-zinc-700 rounded uppercase">{field.type}</span>
                                    {isSelected && (
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); deleteSelectedField(); }}
                                            className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                            title="Xóa trường này"
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
                <VdpSection step="4" title="Cài đặt trường" accent defaultOpen>
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1 p-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                            <span className="text-[12px] font-bold text-blue-700 dark:text-blue-400 block mb-1">Cột chính của ô này</span>
                            <select 
                                value={csvHeaders.includes(selectedField.name) ? selectedField.name : ""}
                                onChange={(e) => updateSelectedField({ name: e.target.value })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:border-blue-500 transition-all text-blue-900 dark:text-blue-100"
                            >
                                <option value="" disabled>-- Chọn cột dữ liệu để ghép --</option>
                                {csvHeaders.map(h => (
                                    <option key={h} value={h}>{h}</option>
                                ))}
                            </select>
                            <span className="text-[10px] text-blue-600/80 mt-1 italic">
                                Giá trị cột này sẽ được in vào ô (mỗi bản in lấy theo dòng của nó).
                                {selectedField.type === 'text' && <> Hoặc gõ thẳng {'{Tên Cột}'} vào vùng Nội dung bên dưới.</>}
                            </span>
                        </div>
                    
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">Loại công cụ</span>
                            <select 
                                value={selectedField.type}
                                onChange={(e) => updateSelectedField({ type: e.target.value })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                            >
                                <option value="text">Chữ (Text)</option>
                                <option value="qrcode">Mã QR (QRCode)</option>
                                <option value="barcode">Mã vạch (Barcode)</option>
                                <option value="image">Hình ảnh (Image)</option>
                            </select>
                        </div>
                        
                        {selectedField.type !== 'text' && (
                            <div className="grid grid-cols-2 gap-3 mt-1">
                                {/* Field lưu theo "mm phồng" (CSS px). Hiển thị/nhập theo mm THẬT
                                    (×0.75) để khớp kích thước trang & file xuất. */}
                                <ToolNumberInput 
                                    label="Rộng W"
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
                        )}
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
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">Xoay (độ)</span>
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
                                        Nội dung {selectedField.type === 'text' ? 'Text' : selectedField.type === 'qrcode' ? 'QR Code' : 'Mã vạch'} 
                                        <span className="text-slate-400 font-normal"> (gõ {'{Tên_Cột}'}, hoặc dùng "Chèn thêm cột vào câu" bên dưới)</span>
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
                                                title="Công cụ tạo nhanh placeholder {cột} để chèn vào câu (tuỳ chọn)"
                                            >
                                                <span>Chèn thêm cột vào câu (nâng cao)</span>
                                                <svg className={`w-3.5 h-3.5 transition-transform ${showQuickInsert ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setShowQuickHelp(true)}
                                                title="Xem hướng dẫn & ví dụ"
                                                className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-teal-600 dark:text-teal-300 bg-teal-50 dark:bg-teal-500/10 hover:bg-teal-100 dark:hover:bg-teal-500/20 border border-teal-200 dark:border-teal-700 transition-colors"
                                            >
                                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" /><path strokeLinecap="round" d="M12 16.5h.01" /></svg>
                                            </button>
                                        </div>
                                        {showQuickInsert && (
                                        <>
                                        <span className="text-[10px] text-slate-400 italic">Tạo nhanh {'{cột}'} (có thể tách phần &amp; định dạng) rồi bấm Chèn vào ô Nội dung.</span>
                                        <div className="grid grid-cols-2 gap-1.5">
                                            <select value={splitCol} onChange={e => setSplitCol(e.target.value)} title="Chọn cột dữ liệu muốn chèn placeholder vào câu" className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500">
                                                <option value="">— Chọn cột —</option>
                                                {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                            </select>
                                            <select value={splitMode} onChange={e => setSplitMode(e.target.value)} title="Lấy cả ô, hoặc tách theo dấu rồi lấy 1 phần. VD: '123-456' tách '-' lấy phần 1 → 123" className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500">
                                                <option value="whole">Cả cột (không tách)</option>
                                                <option value="ws">Tách: khoảng trắng</option>
                                                <option value="-">Tách: gạch ngang (-)</option>
                                                <option value=",">Tách: phẩy (,)</option>
                                                <option value=";">Tách: chấm phẩy (;)</option>
                                                <option value="/">Tách: gạch chéo (/)</option>
                                                <option value="custom">Tách: dấu khác…</option>
                                            </select>
                                        </div>
                                        {splitMode !== 'whole' && (
                                            <div className="grid grid-cols-2 gap-1.5">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[11px] text-slate-500 shrink-0">Phần</span>
                                                    <input type="number" min={1} value={splitPart} onChange={e => setSplitPart(Math.max(1, parseInt(e.target.value) || 1))} title="Lấy phần thứ mấy sau khi tách (1 = phần đầu tiên)" className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                                                </div>
                                                {splitMode === 'custom' && (
                                                    <input value={splitCustom} onChange={e => setSplitCustom(e.target.value)} placeholder="Nhập dấu phân cách" title="Ký tự dùng để tách ô (vd: | hoặc _)" className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                                                )}
                                            </div>
                                        )}
                                        {/* #8 Định dạng dữ liệu */}
                                        <div className="grid grid-cols-2 gap-1.5">
                                            <select value={splitFmt} onChange={e => { setSplitFmt(e.target.value); setSplitFmtArg(e.target.value === 'date' ? '%d/%m/%Y' : ''); }} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" title="Biến đổi giá trị trước khi in: VIẾT HOA, số 1,234, ngày, đệm số 0…">
                                                <option value="">Định dạng: Không</option>
                                                <option value="upper">CHỮ HOA</option>
                                                <option value="lower">chữ thường</option>
                                                <option value="title">Viết Hoa Đầu Từ</option>
                                                <option value="number">Số (1,234)</option>
                                                <option value="money">Tiền tệ</option>
                                                <option value="date">Ngày tháng</option>
                                                <option value="pad">Đệm số 0 (000123)</option>
                                            </select>
                                            {(splitFmt === 'number' || splitFmt === 'money' || splitFmt === 'pad' || splitFmt === 'date') && (
                                                <input
                                                    value={splitFmtArg}
                                                    onChange={e => setSplitFmtArg(e.target.value)}
                                                    placeholder={splitFmt === 'date' ? '%d/%m/%Y' : splitFmt === 'pad' ? 'Độ rộng (vd 6)' : 'Số lẻ (vd 0)'}
                                                    className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500"
                                                />
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between gap-2">
                                            <code className="text-[11px] text-teal-600 dark:text-teal-400 font-mono truncate" title="Cú pháp sẽ được chèn">{buildSplitToken() || '—'}</code>
                                            <button onClick={() => insertSplitToken(selectedField)} disabled={!splitCol} title="Chèn placeholder vừa tạo vào ô Nội dung ở trên" className="shrink-0 h-7 px-3 text-[11px] font-semibold bg-teal-500 text-white rounded-md hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Chèn</button>
                                        </div>
                                        </>
                                        )}
                                        {showQuickHelp && (
                                            <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={() => setShowQuickHelp(false)}>
                                                <div className="max-w-lg w-full max-h-[80vh] overflow-auto bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-slate-200 dark:border-zinc-700" onClick={(e) => e.stopPropagation()}>
                                                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700 sticky top-0 bg-white dark:bg-zinc-900">
                                                        <span className="text-[14px] font-bold text-slate-800 dark:text-zinc-100">Chèn thêm cột vào câu — hướng dẫn</span>
                                                        <button type="button" onClick={() => setShowQuickHelp(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors" title="Đóng">
                                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                    <div className="p-4 space-y-4 text-[12px] text-slate-600 dark:text-zinc-300 leading-relaxed">
                                                        <p>Công cụ này <b>tạo nhanh placeholder</b> <code>{'{cột}'}</code> rồi bỏ vào ô <b>Nội dung</b> — khỏi phải gõ cú pháp tay. Khi in, mỗi bản sẽ thay <code>{'{cột}'}</code> bằng giá trị dòng của nó.</p>
                                                        <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60 space-y-2">
                                                            <div><b>1. Chọn cột</b>: lấy dữ liệu từ cột nào.</div>
                                                            <div>
                                                                <b>2. Cả cột / Tách</b>: lấy nguyên ô, hoặc tách theo dấu rồi lấy phần thứ N.
                                                                <div className="text-slate-500 dark:text-zinc-400 mt-0.5">VD ô <code>123-456</code>, tách <code>-</code> lấy phần 1 → <b>123</b>.</div>
                                                            </div>
                                                            <div>
                                                                <b>3. Định dạng</b>: biến đổi giá trị trước khi in.
                                                                <div className="text-slate-500 dark:text-zinc-400 mt-0.5">VIẾT HOA · số <code>1,234</code> · ngày <code>dd/mm/yyyy</code> · đệm 0 <code>000123</code>.</div>
                                                            </div>
                                                            <div><b>4. Bấm "Chèn"</b>: ghép thành token (vd <code>{'{cao}'}</code>, <code>{'{cao[2|-]}'}</code>, <code>{'{cao|upper}'}</code>) và thêm vào ô Nội dung.</div>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 dark:text-zinc-400">
                                                            Mẹo: bạn có thể chèn nhiều cột vào một câu, vd <code>{'Mã: {SKU} - {Tên}'}</code>. Không cần công cụ này thì gõ tay <code>{'{Tên_Cột}'}</code> cũng được.
                                                        </div>
                                                    </div>
                                                    <div className="px-4 py-3 border-t border-slate-200 dark:border-zinc-700 text-right">
                                                        <button type="button" onClick={() => setShowQuickHelp(false)} className="text-[12px] px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded font-medium transition-colors">Đã hiểu</button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {selectedField.type === 'text' && (
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">Font chữ (Font Family)</span>
                                        <FontSelector 
                                            value={selectedField.fontName || 'Helvetica'}
                                            fontFile={selectedField.fontFile}
                                            onChange={(fontName, fontFile) => updateSelectedField({ fontName, fontFile })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">Nét font (Font Style)</span>
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
                                        label="Cỡ chữ"
                                        value={selectedField.fontSize || 13}
                                        onChange={(val) => updateSelectedField({ fontSize: val })}
                                        suffix="pt" step={1}
                                    />
                                    <ToolNumberInput 
                                        label="Dòng (Leading)"
                                        value={selectedField.lineHeight || 1}
                                        onChange={(val) => updateSelectedField({ lineHeight: val })}
                                        suffix="em" step={0.1}
                                    />
                                    <ToolNumberInput 
                                        label="Khoảng cách (Tracking)"
                                        value={selectedField.characterSpacing || 0}
                                        onChange={(val) => updateSelectedField({ characterSpacing: val })}
                                        suffix="pt" step={0.5}
                                    />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Căn lề</span>
                                        <div className="flex items-center gap-1.5">
                                            <select 
                                                value={selectedField.alignment || 'left'}
                                                onChange={(e) => updateSelectedField({ alignment: e.target.value })}
                                                className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                            >
                                                <option value="left">Trái</option>
                                                <option value="center">Giữa</option>
                                                <option value="right">Phải</option>
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
                                            Tự bóp chữ vừa khung
                                        </label>
                                        <button
                                            title="Thu chiều cao khung vừa khít nội dung text"
                                            onClick={fitHeightToText}
                                            className="h-8 px-2 text-[11px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md hover:border-teal-500 hover:text-teal-600 transition-all"
                                        >
                                            Thu khung theo chữ
                                        </button>
                                    </div>
                                    <div className="col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">Màu chữ</span>
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
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">Tuỳ chỉnh QR Code</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Kiểu chấm</span>
                                        <select 
                                            value={selectedField.qrStyle.dotType || 'square'}
                                            onChange={(e) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, dotType: e.target.value } })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="square">Vuông</option>
                                            <option value="rounded">Bo tròn</option>
                                            <option value="dots">Chấm tròn</option>
                                            <option value="classy">Classy</option>
                                            <option value="classy-rounded">Classy bo</option>
                                            <option value="extra-rounded">Siêu tròn</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Sửa lỗi (Mức)</span>
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
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu chấm</span>
                                        <CmykColorPicker
                                            value={selectedField.qrStyle.dotColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, dotColor: hex } })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu nền</span>
                                        <CmykColorPicker
                                            value={selectedField.qrStyle.bgColor || '#FFFFFF'}
                                            onChange={(hex) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, bgColor: hex } })}
                                            disabled={selectedField.qrStyle.transparentBg}
                                        />
                                    </div>
                                    <ToolNumberInput 
                                        label="Lề trắng (mm)"
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
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">Nền trong suốt (Transparent)</span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        )}

                        {selectedField.type === 'barcode' && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-zinc-700">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">Tuỳ chỉnh Mã Vạch</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Loại mã vạch</span>
                                        <select 
                                            value={selectedField.barcodeType || 'code128'}
                                            onChange={(e) => updateSelectedField({ barcodeType: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="code128">Code 128 (Đa năng, mọi ký tự)</option>
                                            <option value="ean13">EAN-13 (Bán lẻ, 13 số)</option>
                                            <option value="upca">UPC-A (Bán lẻ Mỹ, 12 số)</option>
                                            <option value="ean8">EAN-8 (Gọn, 8 số)</option>
                                            <option value="code39">Code 39 (Công nghiệp, A-Z + số)</option>
                                            <option value="itf14">ITF-14 (Thùng carton, 14 số)</option>
                                            <option value="codabar">Codabar (Y tế, thư viện)</option>
                                        </select>
                                    </div>
                                    <ToolNumberInput 
                                        label="Độ cao vạch"
                                        value={selectedField.barHeight || 12}
                                        onChange={(val) => updateSelectedField({ barHeight: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <ToolNumberInput 
                                        label="Lề trắng (mm)"
                                        value={selectedField.quietZone ?? 2}
                                        onChange={(val) => updateSelectedField({ quietZone: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu vạch</span>
                                        <CmykColorPicker
                                            value={selectedField.barColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ barColor: hex })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu nền</span>
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
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">Nền trong suốt (Transparent)</span>
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
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">Hiển thị số bên dưới mã</span>
                                        </label>
                                        
                                        {selectedField.showText !== false && (
                                            <div className="grid grid-cols-2 gap-3 mt-1">
                                                <ToolNumberInput 
                                                    label="Cỡ chữ"
                                                    value={selectedField.fontSize || 10}
                                                    onChange={(val) => updateSelectedField({ fontSize: val })}
                                                    suffix="pt" step={1}
                                                />
                                                <div>
                                                    <span className="text-[11px] font-medium text-slate-500 block mb-1">Căn chữ</span>
                                                    <div className="flex items-center gap-1.5">
                                                        <select 
                                                            value={selectedField.textAlign || 'center'}
                                                            onChange={(e) => updateSelectedField({ textAlign: e.target.value })}
                                                            className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                                        >
                                                            <option value="left">Trái</option>
                                                            <option value="center">Giữa</option>
                                                            <option value="right">Phải</option>
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
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">Tuỳ chỉnh Hình ảnh</span>
                                <div className="text-[10px] text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700 rounded p-2 leading-relaxed">
                                    <b>Tên trường</b> = cột CSV chứa <b>tên file</b> (vd <code>anh.png</code>) hoặc đường dẫn đầy đủ của ảnh từng bản ghi. Nếu chỉ là tên file, điền <b>Thư mục gốc</b> bên dưới.
                                </div>
                                <div className="flex flex-col gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Thư mục gốc ảnh (nếu cột chứa tên file)</span>
                                        <input
                                            value={selectedField.imageBaseDir || ''}
                                            onChange={(e) => updateSelectedField({ imageBaseDir: e.target.value })}
                                            placeholder="VD: D:\\anh_san_pham"
                                            className="w-full h-9 px-2 text-[12px] font-mono bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Ảnh mặc định (khi cột rỗng — không bắt buộc)</span>
                                        <input
                                            value={selectedField.imagePath || ''}
                                            onChange={(e) => updateSelectedField({ imagePath: e.target.value })}
                                            placeholder="VD: D:\\anh_san_pham\\default.png"
                                            className="w-full h-9 px-2 text-[12px] font-mono bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Hình dáng khung (Shape)</span>
                                        <select 
                                            value={selectedField.imageShape || 'rectangle'}
                                            onChange={(e) => updateSelectedField({ imageShape: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="rectangle">Hình chữ nhật / Vuông</option>
                                            <option value="rounded">Bo góc (Rounded Rectangle)</option>
                                            <option value="circle">Hình tròn / Oval</option>
                                            <option value="polygon">Đa giác (Polygon)</option>
                                            <option value="star">Hình ngôi sao (Star)</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Chế độ căn chỉnh (Fit)</span>
                                        <select 
                                            value={selectedField.imageFit || 'cover'}
                                            onChange={(e) => updateSelectedField({ imageFit: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="cover">Vừa khung, cắt phần thừa (Cover)</option>
                                            <option value="fill">Bóp méo vừa khít khung (Fill)</option>
                                            <option value="contain">Giữ tỷ lệ, thấy toàn bộ ảnh (Contain)</option>
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
                <VdpSection step="5" title="Logic điều kiện (ẩn/hiện · rule)" defaultOpen={false}>
                    <VdpLogicPanel
                        field={selectedField}
                        csvHeaders={csvHeaders}
                        onChange={updateSelectedField}
                    />
                </VdpSection>
            )}

            {/* Xem trước record + điều hướng + dấu lỗi (task 14.3, Req 4.2/4.3/4.5/4.6/4.9) */}
            <VdpSection step="6" title="Xem trước record" defaultOpen={false}>
                <div className="flex flex-col gap-3">
                    {/* Điều hướng record: Prev / ô chỉ số / Next + nút Xem */}
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => goToPreview(previewIndex - 1)}
                            disabled={previewLoading || previewTotal <= 0}
                            title="Record trước"
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
                            title="Record kế tiếp"
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
                            Xem
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
                                Bấm "Xem" để tạo bản xem trước record.
                            </div>
                        )}

                        {/* Chỉ báo đang xử lý — chỉ hiện khi vượt 2 giây (Req 4.3, 8.5) */}
                        {previewProcessing && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-[1px]">
                                <svg className="animate-spin h-6 w-6 text-teal-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                <span className="text-[11px] font-medium text-slate-600 dark:text-zinc-300">Đang xử lý xem trước…</span>
                            </div>
                        )}
                    </div>

                    {/* Liệt kê lỗi field của record đang xem (MISSING/ERR) */}
                    {previewErrors.length > 0 && (
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] font-bold text-red-600 dark:text-red-400">
                                {previewErrors.length} field lỗi ở record này:
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
            <VdpSection step="7" title="Kiểm tra trước khi chạy" defaultOpen={false}>
                <div className="flex flex-col gap-3">
                    <span className="text-[10px] text-slate-500 dark:text-zinc-400 italic leading-snug">
                        Kiểm tra placeholder, ảnh biến đổi và giá trị barcode trước khi sinh lô. Có lỗi → chặn; chỉ cảnh báo → cần xác nhận; sạch → cho chạy.
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
                                    Đang kiểm tra…
                                </>
                            ) : 'Kiểm tra (validate)'}
                        </button>
                        <button
                            type="button"
                            onClick={handleExportReport}
                            disabled={reportLoading}
                            className="flex-1 h-9 px-3 text-[12px] font-semibold text-slate-700 dark:text-zinc-200 border border-slate-300 dark:border-white/20 rounded-md hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                            title="Tải báo cáo các record có lỗi (MISSING/ERR) dạng CSV"
                        >
                            {reportLoading ? 'Đang tạo…' : 'Xuất báo cáo lỗi (CSV)'}
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
                            {validateGating === 'block' && '⛔ Có lỗi chặn — không thể sinh lô cho tới khi khắc phục.'}
                            {validateGating === 'needs_confirmation' && '⚠️ Chỉ có cảnh báo — cần xác nhận trước khi sinh lô.'}
                            {validateGating === 'allow' && '✅ Không có lỗi — sẵn sàng sinh lô.'}
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
                                    <span className="font-mono font-bold uppercase">[{iss.severity === 'error' ? 'LỖI' : 'CẢNH BÁO'}]</span>{' '}
                                    {iss.record_idx != null && <span className="font-semibold">dòng {iss.record_idx}</span>}
                                    {iss.field ? <span> · {iss.field}</span> : null}
                                    {iss.reason ? <span> — {iss.reason}</span> : null}
                                </div>
                            ))}
                        </div>
                    )}
                    {validateGating === 'allow' && validateIssues.length === 0 && (
                        <span className="text-[11px] text-slate-400 dark:text-zinc-500">Không có lỗi hay cảnh báo nào.</span>
                    )}
                </div>
            </VdpSection>

            {/* Action Buttons */}
            <div className="pt-2">
                {statusMessage && (
                    <div className="text-[11px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 p-2 rounded mb-3 text-center">
                        {statusMessage}
                    </div>
                )}
                
                <button
                    onClick={() => batchFiles.length >= 2 ? handleBatchGenerate(batchFiles) : handleGenerate()}
                    disabled={isGenerating || vdpFields.length === 0 || csvData.length === 0}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
                >
                    {isGenerating ? (
                        <>
                            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                            Đang xử lý...
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                            {batchFiles.length >= 2 ? `Chạy ${batchFiles.length} file` : 'Chạy dữ liệu (Run)'}
                        </>
                    )}
                </button>
                <div className="mt-2 flex items-center gap-2 px-1">
                    <input
                        type="checkbox"
                        id="spawnNewTabVdp"
                        checked={spawnNewTab}
                        onChange={(e) => setSpawnNewTab(e.target.checked)}
                        className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-600 cursor-pointer"
                    />
                    <label htmlFor="spawnNewTabVdp" className="text-[11px] text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                        Mở kết quả sang Tab mới (thay vì đè file hiện tại)
                    </label>
                </div>
            </div>

            {showBatchInfo && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowBatchInfo(false)} onKeyDown={e => { if (e.key === 'Escape') setShowBatchInfo(false); }} tabIndex={-1} ref={el => el?.focus()}>
                    <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-full max-w-md max-h-[40vh] flex flex-col border border-slate-200 dark:border-zinc-700" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700">
                            <h3 className="text-sm font-bold text-slate-800 dark:text-white">Danh sách file CSV ({batchFiles.length})</h3>
                            <button onClick={() => setShowBatchInfo(false)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-500">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 scroller-thin">
                            {batchInfoLoading ? (
                                <div className="flex items-center justify-center gap-2 py-8 text-slate-500 text-sm">
                                    <div className="w-5 h-5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                                    Đang đọc {batchFiles.length} file…
                                </div>
                            ) : (
                                <table className="w-full text-[12px]">
                                    <thead>
                                        <tr className="text-left text-slate-400 border-b border-slate-200 dark:border-zinc-700">
                                            <th className="py-1.5 px-2 font-semibold w-6">#</th>
                                            <th className="py-1.5 px-2 font-semibold">Tên file</th>
                                            <th className="py-1.5 px-2 font-semibold text-right">Bản ghi</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {batchInfo.map((it, i) => (
                                            <tr key={i} className="border-b border-slate-100 dark:border-zinc-700/50">
                                                <td className="py-1.5 px-2 text-slate-400">{i + 1}</td>
                                                <td className="py-1.5 px-2 text-slate-700 dark:text-zinc-200 break-all">{it.name}</td>
                                                <td className="py-1.5 px-2 text-right font-bold text-slate-800 dark:text-white">{it.records < 0 ? 'Lỗi' : it.records.toLocaleString('vi-VN')}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        {!batchInfoLoading && batchInfo.length > 0 && (
                            <div className="px-4 py-2.5 border-t border-slate-200 dark:border-zinc-700 flex items-center justify-between text-[12px]">
                                <span className="text-slate-500">Tổng cộng</span>
                                <span className="font-bold text-slate-800 dark:text-white">{batchInfo.reduce((s, it) => s + (it.records > 0 ? it.records : 0), 0).toLocaleString('vi-VN')} bản ghi</span>
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}