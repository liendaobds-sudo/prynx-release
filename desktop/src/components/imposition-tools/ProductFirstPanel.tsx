/**
 * ProductFirstPanel — đề xuất bình theo SẢN PHẨM (Phase 1: chỉ IN NHANH).
 *
 * Người dùng chọn sản phẩm + khổ giấy (lọc in_nhanh) + số trang/khổ thành phẩm
 * (tự điền từ file) → hiện các phương án "1 tờ mấy con" + nút áp dụng vào store.
 * Giữ luồng "Nâng cao" hiện tại làm override (link onOpenAdvanced).
 */
import React, { useContext, useMemo, useState } from 'react';
import { ImposerSettingsContext } from './useImposerSettingsStore';
import { applyRecommendation } from './applyRecommendation';
import {
    recommendInNhanh,
    type InNhanhBinding,
    type RecommendationOption,
} from '../../lib/imposerEngine/ProductAdvisor';
import { PREDEFINED_SIZES } from './types';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface Props {
    /** Số trang nguồn (từ file). */
    pageCount?: number;
    /** Khổ thành phẩm (mm) — tự điền từ file, cho phép sửa. */
    finishedWidthMm?: number;
    finishedHeightMm?: number;
    /** Mở giao diện Nâng cao (power-user) sau khi áp dụng. */
    onOpenAdvanced?: () => void;
    /** Gọi sau khi áp dụng thành công (để parent đóng panel / chạy bình). */
    onApplied?: (option: RecommendationOption) => void;
}

const PRODUCTS: { value: InNhanhBinding; label: string; desc: string }[] = [
    { value: 'saddle', label: 'Bấm kim giữa', desc: 'Catalog / tạp chí lồng ghim' },
    { value: 'thread', label: 'Khâu chỉ (chia tép)', desc: 'Sách dày, khâu chỉ dán gáy' },
    { value: 'perfect', label: 'Keo gáy / Lò xo', desc: 'Trang tuần tự, cắt phay gáy' },
    { value: 'cut_stacks', label: 'Cắt-ráp-xấp', desc: 'Vé / voucher / sổ số nhảy' },
    { value: 'flush_mount', label: 'Dán đối lưng', desc: 'Sách mở phẳng 180°' },
];

export default function ProductFirstPanel({
    pageCount, finishedWidthMm, finishedHeightMm, onOpenAdvanced, onApplied,
}: Props) {
  const { t } = useTranslation();
    const store = useContext(ImposerSettingsContext);

    const [binding, setBinding] = useState<InNhanhBinding>('saddle');
    const [sheetKey, setSheetKey] = useState<string>('A3');
    const [quantity, setQuantity] = useState<number>(100);
    const [finW, setFinW] = useState<number>(finishedWidthMm || 0);
    const [finH, setFinH] = useState<number>(finishedHeightMm || 0);
    const [pc, setPc] = useState<number>(pageCount || 0);
    const [foliosize, setFoliosize] = useState<number>(16);
    const [appliedId, setAppliedId] = useState<string | null>(null);

    // Chỉ khổ in nhanh (tách tuyệt đối khỏi offset).
    const sheetOptions = useMemo(
        () => Object.entries(PREDEFINED_SIZES).filter(([, v]) => v.classification === 'in_nhanh'),
        []
    );

    const result = useMemo(() => {
        const sheet = PREDEFINED_SIZES[sheetKey];
        if (!sheet) return { options: [], errors: [t('imposition.productFirst:hay_chon_kho_giay_in_nhanh')] };
        return recommendInNhanh({
            printMethod: 'in_nhanh',
            binding,
            finishedWidthMm: finW,
            finishedHeightMm: finH,
            pageCount: pc,
            sheetKey,
            sheetWidthMm: sheet.w,
            sheetHeightMm: sheet.h,
            quantity: quantity > 0 ? quantity : undefined,
            foliosize,
        });
    }, [binding, sheetKey, finW, finH, pc, quantity, foliosize, t]);

    const apply = (opt: RecommendationOption) => {
        if (!store) return;
        applyRecommendation(store, opt);
        setAppliedId(opt.id);
        onApplied?.(opt);
    };

    const numCls = 'w-24 h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm';

    return (
        <div className="flex flex-col gap-4 p-3 text-slate-800 dark:text-zinc-200">
            <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">{t('imposition.productFirst:san_pham_in_nhanh')}</div>
                <div className="grid grid-cols-1 gap-1.5">
                    {PRODUCTS.map(p => (
                        <button
                            key={p.value}
                            onClick={() => setBinding(p.value)}
                            className={`text-left px-3 py-2 rounded-lg border transition-colors ${binding === p.value
                                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10'
                                : 'border-slate-200 dark:border-white/10 hover:border-indigo-300'}`}
                        >
                            <div className="text-[13px] font-semibold">{tv(p.label)}</div>
                            <div className="text-[11px] text-slate-500">{tv(p.desc)}</div>
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                    {t('imposition.productFirst:kho_thanh_pham_mm')}
                    <span className="flex items-center gap-1">
                        <input type="number" className={numCls} value={finW || ''} onChange={e => setFinW(Number(e.target.value))} placeholder={t('imposition.productFirst:rong')} />
                        <span>×</span>
                        <input type="number" className={numCls} value={finH || ''} onChange={e => setFinH(Number(e.target.value))} placeholder={t('imposition.productFirst:cao')} />
                    </span>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                    {t('imposition.productFirst:so_trang')}
                    <input type="number" className={numCls} value={pc || ''} onChange={e => setPc(Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                    {t('imposition.productFirst:kho_giay_in_nhanh')}
                    <select className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm" value={sheetKey} onChange={e => setSheetKey(e.target.value)}>
                        {sheetOptions.map(([k, v]) => (
                            <option key={k} value={k}>{k} ({v.w}×{v.h})</option>
                        ))}
                    </select>
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                    {t('imposition.productFirst:so_luong_cuon')}
                    <input type="number" className={numCls} value={quantity || ''} onChange={e => setQuantity(Number(e.target.value))} />
                </label>
                {binding === 'thread' && (
                    <label className="flex flex-col gap-1 text-[11px] text-slate-500">
                        {t('imposition.productFirst:trang_tep_boi_4')}
                        <input type="number" step={4} min={4} className={numCls} value={foliosize}
                            onChange={e => setFoliosize(Math.max(4, Math.round(Number(e.target.value) / 4) * 4))} />
                    </label>
                )}
            </div>

            {/* Kết quả đề xuất */}
            <div className="flex flex-col gap-2">
                {result.errors.length > 0 && (
                    <div className="text-[12px] text-rose-600 bg-rose-50 dark:bg-rose-500/10 rounded-lg p-2.5 whitespace-pre-line">
                        {result.errors.join('\n')}
                    </div>
                )}
                {result.options.map(opt => (
                    <div key={opt.id} className="rounded-lg border border-slate-200 dark:border-white/10 p-3">
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-[13px] font-bold text-indigo-700 dark:text-indigo-400">
                                {opt.strategy === 'multi_up' ? `${opt.copiesPerSheet} cuốn / tờ` : opt.strategy === 'cut_stack' ? t('imposition.productFirst:cat_rap_xap') : t('imposition.productFirst:1_cuon_to')}
                            </div>
                            <div className="text-[11px] text-slate-400">hao ~{opt.wastePercent}%</div>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{opt.explanation}</div>
                        {opt.warnings.map((w, i) => (
                            <div key={i} className="text-[11px] text-amber-600 mt-1">⚠ {w}</div>
                        ))}
                        <button
                            onClick={() => apply(opt)}
                            className={`mt-2 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${appliedId === opt.id
                                ? 'bg-emerald-600 text-white'
                                : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}
                        >
                            {appliedId === opt.id ? t('imposition.productFirst:da_ap_dung') : t('imposition.productFirst:dung_thiet_lap_nay')}
                        </button>
                    </div>
                ))}
            </div>

            {onOpenAdvanced && (
                <button onClick={onOpenAdvanced} className="text-[12px] text-indigo-600 hover:underline self-start">
                    {t('imposition.productFirst:chinh_nang_cao')}
                </button>
            )}
        </div>
    );
}
