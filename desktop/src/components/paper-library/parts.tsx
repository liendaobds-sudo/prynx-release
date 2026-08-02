// ============================================================
// Thư viện vật tư in — các mảnh UI dùng chung
//
// [PAPER-LIB UIUX 2026-07-30] Hai sửa lớn sau phản hồi đầu tiên:
//
// 1. Điều hướng đổi từ thanh thẻ ngang sang SIDEBAR bên trái: 4 mục
//    lớn theo 4 sheet của workbook, mục "Định lượng giấy" xổ ra 9 họ
//    giấy — click họ nào hiện bảng họ đó.
//
// 2. Sửa tương phản: bản đầu tôi dùng text-app-text-3 (#94a3b8) cho
//    gần hết chữ nhỏ — đo được 2,3:1 trên nền sáng, dưới chuẩn WCAG AA
//    (4,5:1) nên chữ xám lợt khó đọc. Nay chữ nhỏ và tiêu đề cột dùng
//    text-app-text-2 (7,6:1 sáng / 6,9:1 tối — đạt AA). text-app-text-3
//    chỉ còn cho chữ trang trí KHÔNG mang thông tin.
//
// Màu/bo góc dùng token cấp app (bg-app-*, text-app-*, border-app-line,
// rounded-app-*) + thang màu Tailwind cho màu phân họ giấy — không hex mới.
// ============================================================

import React from 'react';

/** Nhãn nhóm trong panel tra cứu */
export function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="text-[11px] font-semibold uppercase tracking-wide text-app-text-2 mb-1.5">
            {children}
        </div>
    );
}

/** Ô nhập số có nhãn */
export function NumberField({
    label,
    value,
    onChange,
    min,
    max,
    step = 1,
    suffix,
    id,
}: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
    id: string;
}) {
    return (
        <label className="block" htmlFor={id}>
            <SectionLabel>{label}</SectionLabel>
            <div className="flex items-center gap-1.5">
                <input
                    id={id}
                    type="number"
                    value={value}
                    min={min}
                    max={max}
                    step={step}
                    onChange={e => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) onChange(n);
                    }}
                    className="w-full px-2 py-1.5 text-sm font-medium rounded-app-sm bg-app-2 text-app-text-1
                               border border-app-line focus:border-app-accent focus:outline-none
                               focus:ring-1 focus:ring-app-accent"
                />
                {suffix && <span className="text-xs text-app-text-2 shrink-0">{suffix}</span>}
            </div>
        </label>
    );
}

/** Dropdown có nhãn */
export function SelectField<T extends string>({
    label,
    value,
    onChange,
    options,
    id,
}: {
    label: string;
    value: T;
    onChange: (v: T) => void;
    options: Array<{ value: T; label: string; disabled?: boolean }>;
    id: string;
}) {
    return (
        <label className="block" htmlFor={id}>
            <SectionLabel>{label}</SectionLabel>
            <select
                id={id}
                value={value}
                onChange={e => onChange(e.target.value as T)}
                className="w-full px-2 py-1.5 text-sm font-medium rounded-app-sm bg-app-2 text-app-text-1
                           border border-app-line focus:border-app-accent focus:outline-none
                           focus:ring-1 focus:ring-app-accent"
            >
                {options.map(o => (
                    <option key={o.value} value={o.value} disabled={o.disabled}>
                        {o.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

/** Một ô số liệu kết quả — nhấn mạnh con số, nhãn nhỏ bên trên */
export function ResultTile({
    label,
    value,
    unit,
    tone = 'normal',
    hint,
}: {
    label: string;
    value: string;
    unit?: string;
    tone?: 'normal' | 'warning' | 'accent';
    hint?: string;
}) {
    const toneCls =
        tone === 'warning'
            ? 'text-app-warning'
            : tone === 'accent'
                ? 'text-app-accent'
                : 'text-app-text-1';
    return (
        <div className="px-3 py-2.5 rounded-app-md bg-app-2 border border-app-line">
            <div className="text-[11px] font-medium text-app-text-2 mb-0.5">{label}</div>
            <div className={`text-lg font-bold leading-tight ${toneCls}`}>
                {value}
                {unit && <span className="text-xs font-medium text-app-text-2 ml-1">{unit}</span>}
            </div>
            {hint && <div className="text-[11px] text-app-text-2 mt-1 leading-snug">{hint}</div>}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Sidebar điều hướng
// ─────────────────────────────────────────────────────────────

/** Mục lớn ở sidebar — tương ứng một sheet của workbook */
export function NavItem({
    label,
    icon,
    count,
    active,
    onClick,
    /** Mục cha xổ được: truyền trạng thái mở để vẽ mũi chỉ */
    expandable,
    expanded,
    ariaControls,
}: {
    label: string;
    icon: string;
    count?: number;
    active: boolean;
    onClick: () => void;
    expandable?: boolean;
    expanded?: boolean;
    ariaControls?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            aria-expanded={expandable ? expanded : undefined}
            aria-controls={ariaControls}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-app-md text-left
                text-sm transition-colors
                ${active
                    ? 'bg-app-accent-soft text-app-accent font-semibold'
                    : 'text-app-text-1 font-medium hover:bg-app-3'}`}
        >
            {expandable && (
                <span
                    aria-hidden="true"
                    className={`text-[10px] text-app-text-2 transition-transform shrink-0
                        ${expanded ? 'rotate-90' : ''}`}
                >
                    ▶
                </span>
            )}
            <span aria-hidden="true" className="shrink-0">{icon}</span>
            <span className="flex-1 truncate">{label}</span>
            {count !== undefined && (
                <span className="text-[11px] font-medium text-app-text-2 tabular-nums shrink-0">
                    {count}
                </span>
            )}
        </button>
    );
}

/** Mục con ở sidebar — một họ giấy, có vệt màu nhận dạng */
export function NavSubItem({
    label,
    count,
    active,
    onClick,
    dotClass,
    barClass,
}: {
    label: string;
    count?: number;
    active: boolean;
    onClick: () => void;
    dotClass?: string;
    barClass?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            className={`w-full flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-app-sm text-left
                text-[13px] transition-colors relative
                ${active
                    ? 'bg-app-3 text-app-text-1 font-semibold'
                    : 'text-app-text-1 hover:bg-app-3'}`}
        >
            {/* Vệt màu bên trái: đậm khi đang chọn, mờ khi không */}
            <span
                aria-hidden="true"
                className={`w-1 h-4 rounded-full shrink-0 ${barClass ?? 'bg-app-line'}
                    ${active ? '' : 'opacity-40'}`}
            />
            <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass ?? 'bg-app-line'}`}
            />
            <span className="flex-1 truncate">{label}</span>
            {count !== undefined && (
                <span className="text-[11px] text-app-text-2 tabular-nums shrink-0">{count}</span>
            )}
        </button>
    );
}

// ─────────────────────────────────────────────────────────────
// Bảng dữ liệu
// ─────────────────────────────────────────────────────────────

/** Bảng dữ liệu — header dính khi cuộn, chữ đủ tương phản */
export function DataTable({
    columns,
    children,
    caption,
}: {
    columns: Array<{ key: string; label: string; align?: 'left' | 'right' }>;
    children: React.ReactNode;
    caption?: string;
}) {
    return (
        <table className="w-full text-sm border-collapse">
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead className="sticky top-0 bg-app-2 z-10">
                <tr>
                    {columns.map(c => (
                        <th
                            key={c.key}
                            scope="col"
                            className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wide
                                text-app-text-1 border-b-2 border-app-line
                                ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                        >
                            {c.label}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>{children}</tbody>
        </table>
    );
}

/** Dải tiêu đề khối họ giấy trong bảng — mang màu của họ đó */
export function FamilyBand({
    label,
    count,
    bandClass,
    bandTextClass,
    colSpan,
}: {
    label: string;
    count: number;
    bandClass: string;
    bandTextClass: string;
    colSpan: number;
}) {
    return (
        <tr>
            <th
                scope="colgroup"
                colSpan={colSpan}
                className={`px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider
                    ${bandClass} ${bandTextClass}`}
            >
                {label}
                <span className="ml-2 font-medium normal-case opacity-80">{count}</span>
            </th>
        </tr>
    );
}

/** Dòng trống khi lọc không ra kết quả */
export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
    return (
        <tr>
            <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-app-text-2">
                {message}
            </td>
        </tr>
    );
}
