import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SetVdpFields, VdpToolField } from '../../hooks/useVdpTool';

// ─── Icon căn chỉnh kiểu Illustrator ───
function AlignIcon({ type }: { type: string }) {
    const common = { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'currentColor' } as const;
    switch (type) {
        case 'left': return <svg {...common}><rect x="0.5" y="1" width="1.5" height="14" /><rect x="3" y="3" width="10" height="3" /><rect x="3" y="9" width="6" height="3" /></svg>;
        case 'hcenter': return <svg {...common}><rect x="7.25" y="1" width="1.5" height="14" /><rect x="2" y="3" width="12" height="3" /><rect x="4" y="9" width="8" height="3" /></svg>;
        case 'right': return <svg {...common}><rect x="14" y="1" width="1.5" height="14" /><rect x="3" y="3" width="10" height="3" /><rect x="7" y="9" width="6" height="3" /></svg>;
        case 'top': return <svg {...common}><rect x="1" y="0.5" width="14" height="1.5" /><rect x="3" y="3" width="3" height="10" /><rect x="9" y="3" width="3" height="6" /></svg>;
        case 'vmiddle': return <svg {...common}><rect x="1" y="7.25" width="14" height="1.5" /><rect x="3" y="2" width="3" height="12" /><rect x="9" y="4" width="3" height="8" /></svg>;
        case 'bottom': return <svg {...common}><rect x="1" y="14" width="14" height="1.5" /><rect x="3" y="3" width="3" height="10" /><rect x="9" y="7" width="3" height="6" /></svg>;
        case 'disth': return <svg {...common}><rect x="0.5" y="3" width="2.5" height="10" /><rect x="6.75" y="3" width="2.5" height="10" /><rect x="13" y="3" width="2.5" height="10" /></svg>;
        case 'distv': return <svg {...common}><rect x="3" y="0.5" width="10" height="2.5" /><rect x="3" y="6.75" width="10" height="2.5" /><rect x="3" y="13" width="10" height="2.5" /></svg>;
        default: return null;
    }
}

const BTN = "h-9 flex items-center justify-center text-slate-600 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md hover:border-teal-500 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-all";

type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom';

interface Props {
    vdpFields: VdpToolField[];
    setVdpFields?: SetVdpFields;
    selectedFieldIds: string[];
    pageDimMm?: { w: number; h: number } | null;
}

export function VdpAlignPanel({ setVdpFields, selectedFieldIds, pageDimMm }: Props) {
  const { t } = useTranslation();
    const [open, setOpen] = useState(true);
    if (!selectedFieldIds || selectedFieldIds.length < 1) return null;

    const single = selectedFieldIds.length === 1;
    const canPageAlign = single && !!pageDimMm;

    const alignFields = (mode: AlignMode) => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;
        setVdpFields(prev => {
            const sel = prev.filter(f => selectedFieldIds.includes(f.id));
            if (sel.length === 0) return prev;

            let minX: number, maxX: number, minY: number, maxY: number;
            if (sel.length === 1 && pageDimMm) {
                // Căn theo TRANG khi chỉ chọn 1 đối tượng
                minX = 0; maxX = pageDimMm.w; minY = 0; maxY = pageDimMm.h;
            } else {
                // Căn theo bounding box của nhóm
                minX = Math.min(...sel.map(f => f.x ?? 0));
                maxX = Math.max(...sel.map(f => (f.x ?? 0) + (f.width ?? 0)));
                minY = Math.min(...sel.map(f => f.y ?? 0));
                maxY = Math.max(...sel.map(f => (f.y ?? 0) + (f.height ?? 0)));
            }
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            return prev.map(f => {
                if (!selectedFieldIds.includes(f.id)) return f;
                switch (mode) {
                    case 'left': return { ...f, x: minX };
                    case 'right': return { ...f, x: maxX - (f.width ?? 0) };
                    case 'hcenter': return { ...f, x: cx - (f.width ?? 0) / 2 };
                    case 'top': return { ...f, y: minY };
                    case 'bottom': return { ...f, y: maxY - (f.height ?? 0) };
                    case 'vmiddle': return { ...f, y: cy - (f.height ?? 0) / 2 };
                    default: return f;
                }
            });
        });
    };

    const distributeFields = (axis: 'h' | 'v') => {
        if (!setVdpFields || selectedFieldIds.length < 3) return;
        setVdpFields(prev => {
            const sel = prev.filter(f => selectedFieldIds.includes(f.id));
            if (sel.length < 3) return prev;
            const key = axis === 'h' ? 'x' : 'y';
            sel.sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0));
            const min = sel[0]?.[key] ?? 0;
            const max = sel[sel.length - 1]?.[key] ?? 0;
            const gap = (max - min) / (sel.length - 1);
            const posMap = new Map(sel.map((f, i) => [f.id, min + gap * i]));
            return prev.map(f => posMap.has(f.id) ? { ...f, [key]: posMap.get(f.id)! } : f);
        });
    };

    const aligns: { m: AlignMode; t: string }[] = [
        { m: 'left', t: t('preprocess.vdpAlign:can_trai') },
        { m: 'hcenter', t: t('preprocess.vdpAlign:can_giua_ngang') },
        { m: 'right', t: t('preprocess.vdpAlign:can_phai') },
        { m: 'top', t: t('preprocess.vdpAlign:can_tren') },
        { m: 'vmiddle', t: t('preprocess.vdpAlign:can_giua_doc') },
        { m: 'bottom', t: t('preprocess.vdpAlign:can_duoi') },
    ];

    return (
        <div className="flex flex-col mb-3 pb-3 border-b border-slate-200 dark:border-white/10">
            <button onClick={() => setOpen(o => !o)} className="flex items-center justify-between w-full mb-2">
                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">
                    {t('preprocess.vdpAlign:can_chinh')} {single ? (canPageAlign ? t('preprocess.vdpAlign:theo_trang') : '') : t('preprocess.vdpAlign:n_doi_tuong', { n: selectedFieldIds.length })}
                </span>
                <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            {open && (
                <div className="flex flex-col gap-2.5">
                    {single && !canPageAlign && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('preprocess.vdpAlign:chon_them_doi_tuong_de_can_theo_nhom')}</span>
                    )}
                    <div>
                        <span className="text-[10px] font-medium text-slate-500 block mb-1">{canPageAlign ? t('preprocess.vdpAlign:can_theo_trang') : t('preprocess.vdpAlign:can_doi_tuong')}</span>
                        <div className="grid grid-cols-6 gap-1">
                            {aligns.map(b => (
                                <button key={b.m} title={b.t} disabled={single && !canPageAlign} onClick={() => alignFields(b.m)} className={`${BTN} disabled:opacity-40 disabled:cursor-not-allowed`}>
                                    <AlignIcon type={b.m} />
                                </button>
                            ))}
                        </div>
                    </div>
                    {selectedFieldIds.length >= 3 && (
                        <div>
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.vdpAlign:phan_bo_deu')}</span>
                            <div className="grid grid-cols-6 gap-1">
                                <button title={t('preprocess.vdpAlign:dan_deu_theo_chieu_ngang')} onClick={() => distributeFields('h')} className={BTN}>
                                    <AlignIcon type="disth" />
                                </button>
                                <button title={t('preprocess.vdpAlign:dan_deu_theo_chieu_doc')} onClick={() => distributeFields('v')} className={BTN}>
                                    <AlignIcon type="distv" />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
