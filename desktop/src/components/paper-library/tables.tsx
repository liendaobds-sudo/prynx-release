// ============================================================
// Thư viện vật tư in — 3 bảng tra cứu (giấy, màng cán, may chỉ)
//
// [PAPER-LIB UIUX 2026-07-30] PaperStockTable nay nhận `family` từ
// sidebar: chọn một họ thì hiện đúng họ đó, chọn "tất cả" thì gom
// theo khối, mỗi khối có dải tiêu đề mang màu của họ (giống cách
// file Excel của xưởng mã màu từng bảng).
// ============================================================

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    FILM_NYLON_PROPERTIES,
    FILM_OPTICAL_PROPERTIES,
    FILM_PE_PROPERTIES,
    FILM_PERMEABILITY,
    FILM_PET_PROPERTIES,
    FILM_PP_PVC_PROPERTIES,
    LAMINATION_FILMS,
    PAPER_FAMILY_LABELS,
    PAPER_STOCKS,
    THREAD_SEWING_LIMITS,
    type PaperFamily,
    type PaperStock,
} from '../../lib/paperLibrary';
import { DataTable, EmptyRow, FamilyBand } from './parts';
import { FAMILY_TONES } from './familyColors';

/** Định dạng số theo ngôn ngữ: vi dùng dấu phẩy thập phân */
export function fmt(n: number, digits = 3, lang = 'vi'): string {
    const s = n.toFixed(digits);
    return lang.startsWith('vi') ? s.replace('.', ',') : s;
}

/**
 * Định dạng số giữ ĐỦ chữ số thập phân có nghĩa — không cắt cụt.
 *
 * Dùng cho kết quả tính toán (độ dày gáy sách, chồng giấy…) cần khớp
 * chính xác từng decimal với file Excel gốc.
 *
 * - `maxDigits`: số decimal tối đa để tránh tràn (mặc định 7, đủ cho
 *   mọi ô trong workbook — ô dài nhất là 7 decimal: 1.5136875)
 * - `minDigits`: số decimal tối thiểu giữ lại (mặc định 3, khớp cách
 *   Excel hiển thị cột độ dày gáy)
 * - Sau khi toFixed(maxDigits), bỏ trailing zero nhưng giữ ≥ minDigits
 *
 * Ví dụ: fmtFull(1.755, 3) → "1,755"
 *         fmtFull(1.75,  3) → "1,750"  (giữ đủ 3 decimal)
 *         fmtFull(1.5136875, 3) → "1,5136875" (giữ hết 7 decimal có nghĩa)
 */
export function fmtFull(n: number, minDigits = 3, lang = 'vi', maxDigits = 7): string {
    const raw = n.toFixed(maxDigits);
    // Bỏ trailing zero, nhưng giữ ít nhất minDigits sau dấu chấm
    const [intPart, decPart] = raw.split('.');
    const trimmed = decPart.replace(/0+$/, '');
    const dec = trimmed.padEnd(minDigits, '0');
    const s = `${intPart}.${dec}`;
    return lang.startsWith('vi') ? s.replace('.', ',') : s;
}

/** Thứ tự họ giấy hiển thị — khớp thứ tự cột trong workbook */
export const FAMILY_ORDER: PaperFamily[] = [
    'couche',
    'couche_matt',
    'duplex',
    'bristol',
    'ivory',
    'fort',
    'art',
    'kraft',
    'other',
];

/** Đếm số dòng từng họ — dùng cho số bên cạnh mục sidebar */
export const FAMILY_COUNTS: Record<PaperFamily, number> = FAMILY_ORDER.reduce(
    (acc, f) => {
        acc[f] = PAPER_STOCKS.filter(s => s.family === f).length;
        return acc;
    },
    {} as Record<PaperFamily, number>,
);

// ─────────────────────────────────────────────────────────────
// Bảng 1 — Định lượng giấy → độ dày một tờ
// ─────────────────────────────────────────────────────────────

export function PaperStockTable({ family }: { family: PaperFamily | 'all' }) {
    const { t, i18n } = useTranslation();
    const [query, setQuery] = useState('');

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return PAPER_STOCKS.filter(s => {
            if (family !== 'all' && s.family !== family) return false;
            if (!q) return true;
            return s.name.toLowerCase().includes(q) || String(s.gsm).includes(q);
        });
    }, [family, query]);

    // Khi xem tất cả thì gom theo khối họ giấy; xem một họ thì để phẳng
    const blocks = useMemo(() => {
        if (family !== 'all') return null;
        return FAMILY_ORDER.map(f => ({
            family: f,
            items: rows.filter(s => s.family === f),
        })).filter(b => b.items.length > 0);
    }, [family, rows]);

    const columns = [
        { key: 'name', label: t('paperLibrary:ten_giay') },
        { key: 'gsm', label: t('paperLibrary:dinh_luong'), align: 'right' as const },
        { key: 'thick', label: t('paperLibrary:do_day_mm'), align: 'right' as const },
        { key: 'note', label: t('paperLibrary:ghi_chu') },
    ];

    const renderRow = (s: PaperStock) => (
        <tr key={s.id} className="border-b border-app-line-soft hover:bg-app-3 transition-colors">
            <td className="px-3 py-1.5 text-app-text-1 font-medium">{s.name}</td>
            <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{s.gsm}</td>
            <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums font-semibold">
                {fmt(s.thicknessMm, 3, i18n.language)}
            </td>
            <td className="px-3 py-1.5 text-app-text-2 text-xs">
                {[s.coating, s.origin, s.note].filter(Boolean).join(' · ')}
            </td>
        </tr>
    );

    // Chia danh sách thành 2 nửa khi xem một họ — bố trí 2 cột song song
    const half = Math.ceil(rows.length / 2);
    const leftRows = family !== 'all' ? rows.slice(0, half) : null;
    const rightRows = family !== 'all' ? rows.slice(half) : null;

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex flex-wrap items-end gap-3 px-3 py-2.5 border-b border-app-line">
                <label className="flex-1 min-w-48" htmlFor="pl-search">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-app-text-2 mb-1.5">
                        {t('paperLibrary:tim_kiem')}
                    </div>
                    <input
                        id="pl-search"
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('paperLibrary:tim_kiem_placeholder')}
                        className="w-full px-2 py-1.5 text-sm font-medium rounded-app-sm bg-app-2 text-app-text-1
                                   border border-app-line focus:border-app-accent focus:outline-none
                                   focus:ring-1 focus:ring-app-accent"
                    />
                </label>
                <div className="text-xs font-medium text-app-text-2 pb-1.5 tabular-nums">
                    {rows.length}
                    {family === 'all' && `/${PAPER_STOCKS.length}`}
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
                {rows.length === 0 ? (
                    <DataTable caption={t('paperLibrary:bang_dinh_luong_caption')} columns={columns}>
                        <EmptyRow colSpan={4} message={t('paperLibrary:khong_co_ket_qua')} />
                    </DataTable>
                ) : blocks ? (
                    /* Xem tất cả → mỗi họ giấy là một accordion xổ/thu */
                    <div className="p-3 space-y-2">
                        {blocks.map(b => (
                            <details
                                key={b.family}
                                open
                                className="rounded-app-md border border-app-line overflow-hidden group"
                            >
                                <summary
                                    className={`px-3 py-2 flex items-center gap-2 cursor-pointer select-none
                                        text-[12px] font-bold uppercase tracking-wider
                                        ${FAMILY_TONES[b.family].band} ${FAMILY_TONES[b.family].bandText}`}
                                >
                                    <span className="transition-transform group-open:rotate-90 text-[10px]">▶</span>
                                    {PAPER_FAMILY_LABELS[b.family]}
                                    <span className="font-medium normal-case opacity-80 ml-auto tabular-nums">
                                        {b.items.length}
                                    </span>
                                </summary>
                                {(() => {
                                    const h = Math.ceil(b.items.length / 2);
                                    const left = b.items.slice(0, h);
                                    const right = b.items.slice(h);
                                    return (
                                        <div className="grid grid-cols-1 lg:grid-cols-2 border-t border-app-line">
                                            <div className="lg:border-r lg:border-app-line">
                                                <DataTable caption={PAPER_FAMILY_LABELS[b.family]} columns={columns}>
                                                    {left.map(renderRow)}
                                                </DataTable>
                                            </div>
                                            {right.length > 0 && (
                                                <DataTable caption={PAPER_FAMILY_LABELS[b.family]} columns={columns}>
                                                    {right.map(renderRow)}
                                                </DataTable>
                                            )}
                                        </div>
                                    );
                                })()}
                            </details>
                        ))}
                    </div>
                ) : (
                    /* Xem một họ → 2 bảng song song trong card */
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3">
                        <div className="rounded-app-md border border-app-line overflow-hidden">
                            <DataTable caption={t('paperLibrary:bang_dinh_luong_caption')} columns={columns}>
                                {leftRows!.map(renderRow)}
                            </DataTable>
                        </div>
                        {rightRows!.length > 0 && (
                            <div className="rounded-app-md border border-app-line overflow-hidden">
                                <DataTable caption={t('paperLibrary:bang_dinh_luong_caption')} columns={columns}>
                                    {rightRows!.map(renderRow)}
                                </DataTable>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Bảng 2 — Màng cán
// ─────────────────────────────────────────────────────────────

export function FilmTable() {
    const { t, i18n } = useTranslation();

    return (
        <div className="flex-1 min-h-0 overflow-auto p-3">
            <div className="rounded-app-md border border-app-line overflow-hidden">
            <DataTable
                caption={t('paperLibrary:bang_mang_caption')}
                columns={[
                    { key: 'code', label: t('paperLibrary:ma_mang') },
                    { key: 'thick', label: t('paperLibrary:do_day_um'), align: 'right' },
                    { key: 'mm', label: t('paperLibrary:do_day_mm'), align: 'right' },
                    { key: 'corona', label: t('paperLibrary:corona') },
                    { key: 'seal', label: t('paperLibrary:han_nhiet') },
                    { key: 'note', label: t('paperLibrary:dac_diem') },
                ]}
            >
                {LAMINATION_FILMS.map(f => (
                    <tr
                        key={f.code}
                        className="border-b border-app-line-soft hover:bg-app-3 transition-colors align-top"
                    >
                        <td className="px-3 py-1.5 text-app-text-1 font-semibold whitespace-nowrap">
                            {f.code}
                            {f.metalized && (
                                <span className="ml-1.5 text-[10px] font-medium px-1 py-0.5 rounded-app-sm bg-app-accent-soft text-app-accent">
                                    {t('paperLibrary:ma_kim_loai')}
                                </span>
                            )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums whitespace-nowrap">
                            {f.thicknessRaw}
                        </td>
                        <td className="px-3 py-1.5 text-right text-app-text-2 tabular-nums text-xs whitespace-nowrap">
                            {fmt(f.thicknessMinUm / 1000, 3, i18n.language)}
                            {f.thicknessMaxUm !== f.thicknessMinUm &&
                                `–${fmt(f.thicknessMaxUm / 1000, 3, i18n.language)}`}
                        </td>
                        <td className="px-3 py-1.5 text-app-text-1 text-xs whitespace-nowrap">
                            {f.corona ?? '–'}
                        </td>
                        <td className="px-3 py-1.5 text-app-text-1 text-xs whitespace-nowrap">
                            {f.heatSeal ?? '–'}
                        </td>
                        <td className="px-3 py-1.5 text-app-text-2 text-xs max-w-md leading-snug">
                            {f.note}
                        </td>
                    </tr>
                ))}
            </DataTable>
            </div>

            {/* Bảng tính chất polymer — thu gọn, mở khi cần tra cứu */}
            <details className="mt-3 rounded-app-md border border-app-line bg-app-2">
                <summary className="px-3 py-2 text-xs font-semibold text-app-text-2 cursor-pointer select-none hover:text-app-text-1 transition-colors">
                    Tính chất polymer chi tiết (thấm khí, quang học, cơ nhiệt…)
                </summary>
                <div className="space-y-4 p-2">

                    {/* Thấm khí O₂ */}
                    <DataTable
                        caption="Khả năng thấm khí O₂, dầu mỡ, WVTR"
                        columns={[
                            { key: 'film', label: 'Màng' },
                            { key: 'um', label: 'Độ dày (µm)', align: 'right' },
                            { key: 'o2', label: 'Thấm O₂ (cm³/m²·24h)', align: 'right' },
                            { key: 'oil', label: 'Chống dầu mỡ' },
                            { key: 'wvtr', label: 'WVTR (g/m²/24h)', align: 'right' },
                        ]}
                    >
                        {FILM_PERMEABILITY.map((f, i) => (
                            <tr key={i} className="border-b border-app-line-soft hover:bg-app-3 transition-colors">
                                <td className="px-3 py-1.5 text-app-text-1 font-semibold">{f.film}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{f.thicknessUm}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{f.o2Permeability}</td>
                                <td className="px-3 py-1.5 text-app-text-1 text-xs">{f.oilResistance}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{f.wvtr}</td>
                            </tr>
                        ))}
                    </DataTable>

                    {/* Quang học */}
                    <DataTable
                        caption="Độ đục, độ bóng, độ trong"
                        columns={[
                            { key: 'film', label: 'Màng' },
                            { key: 'haze', label: 'Độ đục (%)', align: 'right' },
                            { key: 'gloss', label: 'Độ bóng', align: 'right' },
                            { key: 'clarity', label: 'Độ trong (%)', align: 'right' },
                        ]}
                    >
                        {FILM_OPTICAL_PROPERTIES.map(f => (
                            <tr key={f.film} className="border-b border-app-line-soft hover:bg-app-3 transition-colors">
                                <td className="px-3 py-1.5 text-app-text-1 font-semibold">{f.film}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{f.haze}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{f.gloss}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums">{f.clarity}</td>
                            </tr>
                        ))}
                    </DataTable>

                    {/* PE */}
                    <DataTable
                        caption="Tính chất điển hình — Màng PE"
                        columns={[
                            { key: 'prop', label: 'Tính chất' },
                            { key: 'ldpe', label: 'LDPE', align: 'right' },
                            { key: 'lldpe', label: 'LLDPE', align: 'right' },
                            { key: 'hdpe', label: 'HDPE', align: 'right' },
                        ]}
                    >
                        {FILM_PE_PROPERTIES.map(f => (
                            <tr key={f.property} className="border-b border-app-line-soft hover:bg-app-3 transition-colors align-top">
                                <td className="px-3 py-1.5 text-app-text-1 text-xs">{f.property}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.ldpe}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.lldpe}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.hdpe}</td>
                            </tr>
                        ))}
                    </DataTable>

                    {/* PP/BOPP/PVC */}
                    <DataTable
                        caption="Tính chất điển hình — PP, BOPP, PVC"
                        columns={[
                            { key: 'prop', label: 'Tính chất' },
                            { key: 'pp', label: 'PP', align: 'right' },
                            { key: 'bopp', label: 'BOPP', align: 'right' },
                            { key: 'pvc', label: 'PVC', align: 'right' },
                        ]}
                    >
                        {FILM_PP_PVC_PROPERTIES.map(f => (
                            <tr key={f.property} className="border-b border-app-line-soft hover:bg-app-3 transition-colors align-top">
                                <td className="px-3 py-1.5 text-app-text-1 text-xs">{f.property}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.pp}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.bopp}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.pvc}</td>
                            </tr>
                        ))}
                    </DataTable>

                    {/* PET */}
                    <DataTable
                        caption="Tính chất điển hình — Màng PET"
                        columns={[
                            { key: 'prop', label: 'Tính chất' },
                            { key: 'unori', label: 'PET không định hướng', align: 'right' },
                            { key: 'ori', label: 'PET định hướng', align: 'right' },
                        ]}
                    >
                        {FILM_PET_PROPERTIES.map(f => (
                            <tr key={f.property} className="border-b border-app-line-soft hover:bg-app-3 transition-colors align-top">
                                <td className="px-3 py-1.5 text-app-text-1 text-xs">{f.property}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.petUnoriented}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.petOriented}</td>
                            </tr>
                        ))}
                    </DataTable>

                    {/* Nylon */}
                    <DataTable
                        caption="Tính chất điển hình — Màng Nylon"
                        columns={[
                            { key: 'prop', label: 'Tính chất' },
                            { key: 'n6', label: 'Nylon-6', align: 'right' },
                            { key: 'n11', label: 'Nylon-11', align: 'right' },
                            { key: 'mxd6', label: 'Nylon MXD-6', align: 'right' },
                        ]}
                    >
                        {FILM_NYLON_PROPERTIES.map(f => (
                            <tr key={f.property} className="border-b border-app-line-soft hover:bg-app-3 transition-colors align-top">
                                <td className="px-3 py-1.5 text-app-text-1 text-xs">{f.property}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.nylon6}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.nylon11}</td>
                                <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums text-xs">{f.nylonMxd6}</td>
                            </tr>
                        ))}
                    </DataTable>

                </div>
            </details>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────
// Bảng 3 — Số tờ tối đa may chỉ
// ─────────────────────────────────────────────────────────────

export function ThreadSewingTable() {
    const { t } = useTranslation();

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex-1 min-h-0 overflow-auto p-3">
                <div className="rounded-app-md border border-app-line overflow-hidden">
                <DataTable
                    caption={t('paperLibrary:bang_may_chi_caption')}
                    columns={[
                        { key: 'code', label: t('paperLibrary:ma_giay') },
                        { key: 'paper', label: t('paperLibrary:ten_giay') },
                        { key: 'max', label: t('paperLibrary:so_to_toi_da'), align: 'right' },
                        { key: 'lam', label: t('paperLibrary:da_can_mang'), align: 'right' },
                    ]}
                >
                    {THREAD_SEWING_LIMITS.map(l => (
                        <tr
                            key={l.code}
                            className="border-b border-app-line-soft hover:bg-app-3 transition-colors"
                        >
                            <td className="px-3 py-1.5 text-app-text-1 font-semibold">{l.code}</td>
                            <td className="px-3 py-1.5 text-app-text-1">{l.paperName}</td>
                            <td className="px-3 py-1.5 text-right text-app-text-1 tabular-nums font-semibold">
                                {l.maxSheets}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                                {l.maxSheetsLaminated !== undefined ? (
                                    <span className="text-app-text-1 font-semibold">
                                        {l.maxSheetsLaminated}
                                    </span>
                                ) : (
                                    <span className="text-app-text-2 text-xs">
                                        {t('paperLibrary:chua_co_so')}
                                    </span>
                                )}
                            </td>
                        </tr>
                    ))}
                </DataTable>
                </div>
            </div>
            <p className="px-3 py-2 text-xs text-app-text-2 border-t border-app-line leading-snug">
                {t('paperLibrary:may_chi_ghi_chu')}
            </p>
        </div>
    );
}
