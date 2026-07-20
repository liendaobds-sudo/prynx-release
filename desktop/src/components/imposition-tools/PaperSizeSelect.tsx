/**
 * Dropdown khổ giấy: nhóm ISO A (mặc định) có thể xổ/thu — mặc định thu gọn
 * để danh sách không dài rối. <select>/<optgroup> native không hỗ trợ collapse.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PREDEFINED_SIZES } from './types';
import {
    formUsages,
    showsPredefinedSheets,
    type PaperUsage,
    type SavedForm,
} from './paperUtils';

const PREDEFINED_ORDER = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const;

export interface PaperSizeSelectProps {
    value: string;
    onChange: (formsize: string) => void;
    paperContext: PaperUsage;
    savedForms: SavedForm[];
    className?: string;
}

function optionLabel(key: string, savedForms: SavedForm[], t: (k: string) => string): string {
    if (key === 'custom') {
        return t('imposition.imposerDashboard:tao_kho_giay_moi_custom');
    }
    const ps = PREDEFINED_SIZES[key];
    if (ps) return `${key} (${ps.w} x ${ps.h} mm)`;
    const f = savedForms.find((x) => x.id === key);
    if (f) return `${f.name} (${f.w}x${f.h}mm)`;
    return key;
}

export default function PaperSizeSelect({
    value,
    onChange,
    paperContext,
    savedForms,
    className = '',
}: PaperSizeSelectProps) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    // Mặc định thu gọn nhóm ISO A — user bấm mũi tên để xổ
    const [defaultsExpanded, setDefaultsExpanded] = useState(false);

    const showDefaults = showsPredefinedSheets(paperContext);
    const matchedForms = useMemo(
        () => savedForms.filter((f) => formUsages(f).includes(paperContext)),
        [savedForms, paperContext],
    );

    const savedLabel =
        paperContext === 'nup'
            ? t('imposition.imposerDashboard:kho_da_luu_binh_bai_xen')
            : paperContext === 'diecut'
              ? t('imposition.imposerDashboard:kho_da_luu_be_tem')
              : paperContext === 'offset'
                ? t('imposition.imposerDashboard:kho_da_luu_in_offset')
                : t('imposition.imposerDashboard:kho_da_luu_in_nhanh');

    const defaultsLabel = t('imposition.imposerDashboard:kho_mac_dinh_in_nhanh');
    const triggerText = optionLabel(value, savedForms, t);

    const pick = useCallback(
        (id: string) => {
            onChange(id);
            setOpen(false);
        },
        [onChange],
    );

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    // Đổi context (tool) → thu lại nhóm mặc định, tránh list dài bám theo
    useEffect(() => {
        setDefaultsExpanded(false);
        setOpen(false);
    }, [paperContext]);

    const itemCls = (active: boolean) =>
        `w-full text-left px-2.5 py-1.5 text-sm rounded-sm transition-colors ${
            active
                ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200 font-medium'
                : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10'
        }`;

    return (
        <div ref={rootRef} className={`relative flex-1 min-w-0 ${className}`}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className="w-full h-8 px-2 flex items-center gap-1 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium text-left"
            >
                <span className="flex-1 min-w-0 truncate">{triggerText}</span>
                <svg
                    className={`shrink-0 w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    aria-hidden
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {open && (
                <div
                    role="listbox"
                    className="absolute z-50 left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-md border border-slate-200 dark:border-white/15 bg-white dark:bg-zinc-900 shadow-lg py-1"
                >
                    {showDefaults && (
                        <div className="border-b border-slate-100 dark:border-white/10 pb-1 mb-1">
                            <button
                                type="button"
                                onClick={() => setDefaultsExpanded((v) => !v)}
                                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5"
                                aria-expanded={defaultsExpanded}
                            >
                                <svg
                                    className={`shrink-0 w-3 h-3 transition-transform ${defaultsExpanded ? 'rotate-90' : ''}`}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                    aria-hidden
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                </svg>
                                <span className="flex-1 text-left truncate">{defaultsLabel}</span>
                                <span className="text-[10px] font-semibold text-slate-400 normal-case tracking-normal">
                                    {PREDEFINED_ORDER.length}
                                </span>
                            </button>
                            {defaultsExpanded && (
                                <div className="px-1 pb-0.5">
                                    {PREDEFINED_ORDER.map((key) => {
                                        const ps = PREDEFINED_SIZES[key];
                                        if (!ps) return null;
                                        return (
                                            <button
                                                key={key}
                                                type="button"
                                                role="option"
                                                aria-selected={value === key}
                                                onClick={() => pick(key)}
                                                className={itemCls(value === key)}
                                            >
                                                {key} ({ps.w} x {ps.h} mm)
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}

                    {matchedForms.length > 0 && (
                        <div className="pb-1 mb-1 border-b border-slate-100 dark:border-white/10">
                            <div className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                {savedLabel}
                            </div>
                            <div className="px-1">
                                {matchedForms.map((f) => (
                                    <button
                                        key={f.id}
                                        type="button"
                                        role="option"
                                        aria-selected={value === f.id}
                                        onClick={() => pick(f.id)}
                                        className={itemCls(value === f.id)}
                                    >
                                        {f.name} ({f.w}x{f.h}mm)
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div>
                        <div className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            {t('imposition.imposerDashboard:khac')}
                        </div>
                        <div className="px-1 pb-0.5">
                            <button
                                type="button"
                                role="option"
                                aria-selected={value === 'custom'}
                                onClick={() => pick('custom')}
                                className={itemCls(value === 'custom')}
                            >
                                {t('imposition.imposerDashboard:tao_kho_giay_moi_custom')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
