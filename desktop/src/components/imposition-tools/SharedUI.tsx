import React, { useState, useRef, useEffect } from 'react';
import { createFallbackToolHelp, getToolHelp } from '../../lib/toolHelp';
import ToolHelpModal from '../ToolHelpModal';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import type { FeatureId } from '../../lib/license/features';
import ProFeatureBadge from '../license/ProFeatureBadge';

// ==================== RichSelect (Custom Dropdown) ====================
export const RichSelect = ({ value, onChange, options, compact = false }: { value: string, onChange: (v: string) => void, options: {value: string, title: string, desc?: string}[], compact?: boolean }) => {
    useTranslation(); // subscribe → re-render khi đổi ngôn ngữ (tv() đọc i18n global)
    const [isOpen, setIsOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    // UIUX (audit 2026-07-27 §B-19): điều hướng bàn phím cho dropdown tự chế.
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [highlightIdx, setHighlightIdx] = useState(-1);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selected = options.find(o => o.value === value) || options[0];

    // UIUX (audit 2026-07-27 §B-19): mở → highlight mục đang chọn; Esc đóng + trả
    // focus nút; mũi tên di chuyển highlight; Enter chọn mục highlight.
    const openWithHighlight = (open: boolean) => {
        if (open) setHighlightIdx(Math.max(0, options.findIndex(o => o.value === value)));
        setIsOpen(open);
    };
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown') { e.preventDefault(); openWithHighlight(true); }
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            setIsOpen(false); triggerRef.current?.focus();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightIdx(i => Math.min(options.length - 1, i < 0 ? 0 : i + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightIdx(i => Math.max(0, i < 0 ? 0 : i - 1));
        } else if (e.key === 'Enter') {
            // UIUX (audit 2026-07-27 §B-19) fix-verify: focus đang ở NÚT option (Tab
            // tới) → để nút đó tự kích hoạt qua onClick, không cướp thành
            // options[highlightIdx] (chọn sai mục).
            const target = e.target as HTMLElement;
            if (target.tagName === 'BUTTON' && target !== triggerRef.current) return;
            e.preventDefault();
            const opt = options[highlightIdx];
            if (opt) onChange(opt.value);
            setIsOpen(false); triggerRef.current?.focus();
        }
    };

    return (
        <div className="relative" ref={wrapperRef} onKeyDown={handleKeyDown}>
            <button
                type="button"
                ref={triggerRef}
                onClick={() => openWithHighlight(!isOpen)}
                className={`w-full text-left border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500/20 ${compact ? 'px-2.5 h-8 rounded-md flex items-center' : 'p-3 rounded-lg'} ${isOpen ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-500/10' : 'border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 hover:border-slate-400 dark:hover:border-white/30'}`}
            >
                <div className={`flex justify-between items-center gap-2 ${compact ? 'w-full' : ''}`}>
                    <div className={`font-semibold text-slate-900 dark:text-white min-w-0 ${compact ? 'text-[12px]' : 'text-[13px]'}`}>{tv(selected.title)}</div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        {/* UIUX (2026-09-10 §COMPACT.DESC): desc chuyển từ inline sang tooltip ẩn, giảm visual noise */}
                        {!compact && selected.desc && (
                            // Tooltip icon là điều khiển trợ giúp, không phải một ghi chú
                            // độc lập; dùng img để không làm trùng role note của panel.
                            <span
                                role="img"
                                tabIndex={0}
                                aria-label={tv(selected.desc)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
                                className="group/desc relative flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 cursor-help"
                            >
                                ?
                                <span
                                    role="tooltip"
                                    className="pointer-events-none absolute bottom-full right-0 z-[120] mb-2 w-max max-w-[280px] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[11px] font-normal leading-relaxed text-white opacity-0 shadow-xl transition-all invisible group-hover/desc:visible group-hover/desc:opacity-100 group-focus-within/desc:visible group-focus-within/desc:opacity-100 dark:bg-zinc-700 whitespace-normal break-words"
                                >
                                    {tv(selected.desc)}
                                    <span aria-hidden="true" className="absolute top-full right-2 -mt-1 h-2 w-2 rotate-45 bg-slate-800 dark:bg-zinc-700" />
                                </span>
                            </span>
                        )}
                        <svg className={`shrink-0 w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </div>
                </div>
            </button>
            
            {isOpen && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 rounded-lg shadow-[0_4px_20px_-4px_rgba(0,0,0,0.1)] dark:shadow-[0_4px_20px_-4px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col">
                    {options.map((opt, idx) => (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => { onChange(opt.value); setIsOpen(false); }}
                            // UIUX (audit 2026-07-27 §B-19): mục đang highlight bằng bàn phím
                            data-highlight={idx === highlightIdx || undefined}
                            className={`group/opt text-left p-3 transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800 focus:outline-none border-b border-slate-100 dark:border-white/5 last:border-0 ${opt.value === value ? 'bg-indigo-50/50 dark:bg-indigo-500/10' : ''} ${idx === highlightIdx ? 'bg-app-accent-soft' : ''}`}
                        >
                            <div className="flex items-center gap-2">
                                <div className={`shrink-0 flex items-center justify-center w-3 h-3 rounded-full border ${opt.value === value ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300 dark:border-zinc-500 bg-white dark:bg-zinc-800'}`}>
                                    {opt.value === value && <div className="w-1 h-1 rounded-full bg-white" />}
                                </div>
                                <div className={`font-semibold text-[13px] ${opt.value === value ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-800 dark:text-zinc-200'}`}>{tv(opt.title)}</div>
                            </div>
                            {/* UIUX (2026-09-10 §COMPACT.DESC): desc ẩn, hover mới mở ra */}
                            {opt.desc && (
                                <div className="ml-5 max-h-0 overflow-hidden text-[11px] text-slate-500 leading-snug opacity-0 transition-all duration-150 ease-out group-hover/opt:max-h-16 group-hover/opt:opacity-100 group-hover/opt:mt-1">
                                    {tv(opt.desc)}
                                </div>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

// ==================== Checkbox ====================
export const Checkbox = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
    <label className="flex items-center gap-2 cursor-pointer">
        <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-indigo-500 border-indigo-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
            {checked && (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                </svg>
            )}
        </div>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="hidden" />
        <span className="text-sm">{label}</span>
    </label>
);

// ==================== Section Label ====================
export const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <label className="text-[11px] font-bold text-slate-600 tracking-wide">{children}</label>
);

// ==================== Divider ====================
export const Divider = () => <div className="h-px bg-slate-200 dark:bg-white/10 w-full" />;

// ==================== Number Input Class ====================
export const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500";

// ==================== Accordion ====================
export const Accordion = ({ title, initialOpen = false, children }: { title: string; initialOpen?: boolean; children: React.ReactNode }) => {
    const [open, setOpen] = useState(initialOpen);
    return (
        <div className="border border-slate-200 dark:border-white/10 rounded-lg overflow-hidden">
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold text-slate-600 tracking-wide hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors focus:outline-none"
            >
                <span>{title}</span>
                <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            {open && <div className="px-3 pb-3 space-y-1.5">{children}</div>}
        </div>
    );
};

// ==================== DisabledItem ====================
export const DisabledItem = ({ label }: { label: string }) => (
    <div className="text-[11px] text-slate-400 dark:text-zinc-500 py-1 pl-1 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-zinc-600 shrink-0" />
        {label} <span className="text-[9px] opacity-60">{tv('(sắp ra mắt)')}</span>
    </div>
);

// ==================== ToolItem ====================
export const ToolItem = ({ icon, label, desc, info, helpKey, featureId, onClick, hoverColor, active, isFavorite, onToggleFavorite, variant = 'default' }: { icon: React.ReactNode, label: string, desc?: string, info?: string, helpKey?: string, featureId?: FeatureId, onClick: () => void, hoverColor: string, active?: boolean, isFavorite?: boolean, onToggleFavorite?: () => void, variant?: 'default' | 'tool-catalog' }) => {
  const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const help = getToolHelp(helpKey);
    const modalHelp = help ?? ((info || desc) ? createFallbackToolHelp(label, info || desc) : undefined);
    const showHelpBtn = !!modalHelp;
    const isToolCatalog = variant === 'tool-catalog';
    return (
        <div className="relative">
            <div
                onClick={onClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if ((e.target as HTMLElement).closest('button')) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
                }}
                title={info || label}
                style={{ padding: '4px 6px' }}
                className={`flex items-center gap-2.5 w-full text-left rounded-lg transition-all group cursor-pointer border ${isToolCatalog ? 'hover:shadow-sm' : ''} ${active ? 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-400 dark:border-indigo-500/60 ring-1 ring-indigo-300/50' : isFavorite ? `bg-gradient-to-r from-amber-50/80 to-white dark:from-amber-900/20 dark:to-zinc-900 border-amber-200 dark:border-amber-800/50 shadow-sm ${hoverColor}` : `bg-white dark:bg-zinc-900 border-slate-200 dark:border-white/10 ${hoverColor}`}`}
            >
                <div className={`text-[22px] w-8 text-center group-hover:scale-110 transition-transform origin-center ${isToolCatalog ? 'drop-shadow-sm' : ''}`}>{icon}</div>
                <div className="flex-1 min-w-0">
                    <div className={`font-bold ${isToolCatalog ? 'text-[13.5px]' : 'text-[14px]'} leading-tight truncate ${active ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-800 dark:text-white'}`}>{label}</div>
                    {!info && desc && <div className="text-[12px] text-slate-500 line-clamp-1 mt-1 font-medium truncate">{desc}</div>}
                </div>
                {featureId && <ProFeatureBadge featureId={featureId} />}
                {onToggleFavorite && (
                    <button
                        type="button"
                       onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={isFavorite ? t('imposition.sharedUI:bo_khoi_yeu_thich') : t('imposition.sharedUI:them_vao_yeu_thich')}
                        className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors ${isFavorite ? 'text-amber-400' : 'text-slate-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-amber-400'}`}
                    >
                        <svg className="w-4 h-4" fill={isFavorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5a.56.56 0 011.04 0l2.12 4.3 4.75.69c.46.07.64.63.31.95l-3.44 3.35.81 4.73c.08.46-.4.81-.81.59L12 16.98l-4.25 2.23c-.41.22-.89-.13-.81-.59l.81-4.73-3.44-3.35a.56.56 0 01.31-.95l4.75-.69 2.12-4.3z" /></svg>
                    </button>
                )}
                {showHelpBtn && (
                    <button
                        type="button"
                       onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
                        onKeyDown={(e) => e.stopPropagation()}
                        title={t('imposition.sharedUI:gioi_thieu_cong_cu')}
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </button>
                )}
            </div>
            {/* UIUX (audit 2026-08-22 §HELP.MODAL): mọi nút ? mở chung ToolHelpModal. */}
            {open && modalHelp && (
                <ToolHelpModal help={modalHelp} icon={icon} onClose={() => setOpen(false)} />
            )}
        </div>
    );
};
