// Modal chọn tỉ lệ in (Actual / Shrink / Fit) — dùng chung cho mọi tab in được.
// Trả về pickScaleMode(): Promise<PrintScaleMode|null> (null = user hủy) + phần
// JSX modal để tab render. Pattern promise-resolve giống scaleConfirmModal cũ.
import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { PrintScaleMode } from '../../lib/nativePrint';

export function usePrintScaleModal() {
    const { t } = useTranslation();
    const [resolver, setResolver] = useState<{ resolve: (v: PrintScaleMode | null) => void } | null>(null);

    const pickScaleMode = useCallback((): Promise<PrintScaleMode | null> => {
        return new Promise(resolve => setResolver({ resolve }));
    }, []);

    const close = useCallback((v: PrintScaleMode | null) => {
        resolver?.resolve(v);
        setResolver(null);
    }, [resolver]);

    const modal = resolver
        ? createPortal(
            <div
                className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200"
                onClick={() => close(null)}
                onKeyDown={e => { if (e.key === 'Escape') close(null); }}
                tabIndex={-1}
                ref={el => el?.focus()}
            >
                <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-200 dark:border-zinc-700" onClick={e => e.stopPropagation()}>
                    <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-700 flex items-center gap-2">
                        <span className="material-symbols-outlined text-indigo-600 dark:text-indigo-400">print</span>
                        <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                            {t('tabs.imposition:chon_ty_le_in')}
                        </h3>
                    </div>
                    <div className="px-6 py-4 flex flex-col gap-2">
                        {([
                            { key: 'actual' as const, icon: 'straighten', title: t('tabs.imposition:in_kich_thuoc_that'), desc: t('tabs.imposition:in_kich_thuoc_that_mo_ta') },
                            { key: 'shrink' as const, icon: 'fit_screen', title: t('tabs.imposition:in_thu_neu_qua_kho'), desc: t('tabs.imposition:in_thu_neu_qua_kho_mo_ta') },
                            { key: 'fit' as const, icon: 'zoom_out_map', title: t('tabs.imposition:in_vua_kho_giay'), desc: t('tabs.imposition:in_vua_kho_giay_mo_ta') },
                        ]).map(opt => (
                            <button
                                key={opt.key}
                                onClick={() => close(opt.key)}
                                className="flex items-start gap-3 text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-zinc-700 hover:border-indigo-500 dark:hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                            >
                                <span className="material-symbols-outlined text-slate-500 dark:text-slate-400 mt-0.5">{opt.icon}</span>
                                <span className="flex flex-col">
                                    <span className="font-medium text-slate-800 dark:text-white">{opt.title}</span>
                                    <span className="text-sm text-slate-500 dark:text-slate-400">{opt.desc}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                    <div className="px-6 py-4 bg-slate-50 dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-700 flex justify-end">
                        <button
                            onClick={() => close(null)}
                            className="px-4 py-2 rounded-lg font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                        >
                            {t('tabs.imposition:huy_bo_cancel')}
                        </button>
                    </div>
                </div>
            </div>,
            document.body,
        )
        : null;

    return { pickScaleMode, printScaleModal: modal };
}
