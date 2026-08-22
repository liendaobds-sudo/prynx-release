import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * UIUX (audit 2026-08-22 §UX.MD.01): mọi hộp thoại PDF dùng chung vòng đời
 * focus/ESC để phím tắt của viewer không xuyên qua lớp đang mở.
 */
export function useDialogLifecycle(onClose: () => void, enabled = true) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!enabled) return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const restoreTarget = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');

        const focusInitial = () => {
            const first = getFocusable()[0];
            (first || dialog).focus();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = getFocusable();
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        dialog.addEventListener('keydown', handleKeyDown);
        focusInitial();
        return () => {
            dialog.removeEventListener('keydown', handleKeyDown);
            if (restoreTarget?.isConnected) restoreTarget.focus();
        };
    }, [enabled]);

    return dialogRef;
}

// ═══════ QUICK DELETE MODAL ═══════
export function QuickDeleteModal({ selectedCount, onConfirm, onClose }: { selectedCount: number; onConfirm: () => void; onClose: () => void }) {
  const { t } = useTranslation();
    const dialogRef = useDialogLifecycle(onClose);
    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 font-sans">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="prynx-quick-delete-title" data-prynx-modal="true" tabIndex={-1} className="bg-white dark:bg-[#1e1e1e] w-[380px] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                <div className="flex p-6">
                    <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0 text-red-600 dark:text-red-400 mr-4">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    </div>
                    <div>
                        <h3 id="prynx-quick-delete-title" className="font-semibold text-lg text-slate-800 dark:text-zinc-100 mb-1">{t('misc.acrobatModals:xoa_trang')}</h3>
                        <p className="text-sm text-slate-600 dark:text-zinc-400">
                            {t('misc.acrobatModals:ban_co_chac_chan_muon_xoa')} <span className="font-bold text-red-600 dark:text-red-400">{selectedCount}</span> {t('misc.acrobatModals:trang_khoi_tai_lieu_nay_khong_hanh_dong')}
                        </p>
                    </div>
                </div>
                <div className="flex bg-slate-50 dark:bg-[#151515] px-6 py-4 justify-end gap-3 border-t border-black/5 dark:border-white/5">
                    <button onClick={onClose} className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors focus:ring-2 focus:ring-slate-400 outline-none min-w-[90px]">{t('misc.acrobatModals:huy_bo')}</button>
                    <button onClick={onConfirm} className="px-6 h-[38px] flex items-center justify-center rounded font-medium text-[13px] bg-red-600 hover:bg-red-700 text-white shadow-sm min-w-[120px] transition-colors outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]">{t('misc.acrobatModals:dong_y_xoa')}</button>
                </div>
            </div>
        </div>
    );
}

// ═══════ ADVANCED DELETE MODAL ═══════
export function AdvancedDeleteModal({ numPages, onConfirm, onClose }: { numPages: number; onConfirm: (range: string, from: number, to: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
    const dialogRef = useDialogLifecycle(onClose);
    const [advDeleteRange, setAdvDeleteRange] = useState('selection');
    const [advDeleteFrom, setAdvDeleteFrom] = useState(1);
    const [advDeleteTo, setAdvDeleteTo] = useState(1);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="prynx-advanced-delete-title" data-prynx-modal="true" tabIndex={-1} className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                    <h3 id="prynx-advanced-delete-title" className="font-semibold text-base text-slate-800 dark:text-zinc-100 tracking-wide">{t('misc.acrobatModals:xoa_trang_delete_pages')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title={t('misc.acrobatModals:dong_esc')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <div className="p-6 flex flex-col gap-6 text-[14px]">
                    <div className="flex flex-col gap-3">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals:chon_luong_can_xoa')}</label>
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                             <label className="flex items-center gap-3 cursor-pointer group">
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${advDeleteRange === 'selection' ? 'border-red-500 bg-red-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-red-400'}`}>
                                    {advDeleteRange === 'selection' && <div className="w-2 h-2 bg-white rounded-full" />}
                                </div>
                                <input type="radio" name="delRange" checked={advDeleteRange === 'selection'} onChange={() => setAdvDeleteRange('selection')} className="hidden" />
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals:nhung_trang_dang_duoc_chon_selected')}</span>
                            </label>
                            <div className="flex items-center gap-3">
                                <label className="flex items-center gap-3 cursor-pointer group">
                                    <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${advDeleteRange === 'range' ? 'border-red-500 bg-red-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-red-400'}`}>
                                        {advDeleteRange === 'range' && <div className="w-2 h-2 bg-white rounded-full" />}
                                    </div>
                                    <input type="radio" name="delRange" checked={advDeleteRange === 'range'} onChange={() => setAdvDeleteRange('range')} className="hidden" />
                                    <span className="text-slate-700 dark:text-zinc-300 whitespace-nowrap">{t('misc.acrobatModals:theo_so_trang')}</span>
                                </label>
                                <div className={`flex items-center gap-2 flex-1 transition-opacity ${advDeleteRange === 'range' ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                    <input type="number" min="1" max={numPages} value={advDeleteFrom} onChange={e => {setAdvDeleteFrom(parseInt(e.target.value)); setAdvDeleteRange('range');}} className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-zinc-200 outline-none focus:border-red-500" />
                                    <span className="text-slate-400">-</span>
                                    <input type="number" min="1" max={numPages} value={advDeleteTo} onChange={e => {setAdvDeleteTo(parseInt(e.target.value)); setAdvDeleteRange('range');}} className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-zinc-200 outline-none focus:border-red-500" />
                                    <span className="text-slate-400 text-[13px] ml-auto">/ {numPages}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                    <button className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors focus:ring-2 focus:ring-slate-400 outline-none min-w-[90px]" onClick={onClose}>{t('misc.acrobatModals:huy_bo')}</button>
                    <button className="px-6 h-[38px] flex items-center justify-center rounded font-medium text-[13px] bg-red-600 hover:bg-red-700 text-white shadow-sm min-w-[120px] transition-colors outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]" onClick={() => onConfirm(advDeleteRange, advDeleteFrom, advDeleteTo)}>{t('misc.acrobatModals:dong_y_xoa_2')}</button>
                </div>
            </div>
        </div>
    );
}

// ═══════ EXTRACT PAGES MODAL ═══════
export function ExtractPagesModal({ pageCount, initialPagesStr, onConfirm, onClose }: { pageCount: number; initialPagesStr: string; onConfirm: (pagesStr: string, deleteAfter: boolean) => void; onClose: () => void }) {
  const { t } = useTranslation();
    const dialogRef = useDialogLifecycle(onClose);
    const [extractPagesStr, setExtractPagesStr] = useState(initialPagesStr);
    const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="prynx-extract-pages-title" data-prynx-modal="true" tabIndex={-1} className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                    <h3 id="prynx-extract-pages-title" className="font-semibold text-base text-slate-800 dark:text-zinc-100 tracking-wide">{t('misc.acrobatModals:trich_xuat_trang')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title={t('misc.acrobatModals:dong')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <div className="p-6 flex flex-col gap-6 text-[14px]">
                    <div className="flex flex-col gap-2">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals:trang_can_trich_xuat')}</label>
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                            <div className="flex items-center gap-3">
                                <input type="text" value={extractPagesStr} onChange={e => setExtractPagesStr(e.target.value)} placeholder="VD: 1, 3, 5-7" className="flex-1 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono" />
                                <span className="text-slate-500 dark:text-zinc-400 text-[13px] whitespace-nowrap">/ {pageCount} trang</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals:tuy_chon_bo_sung')}</label>
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${extractDeleteAfter ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                    {extractDeleteAfter && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                                </div>
                                <input type="checkbox" checked={extractDeleteAfter} onChange={e => setExtractDeleteAfter(e.target.checked)} className="hidden" />
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals:xoa_cac_trang_nay_khoi_file_goc_sau_khi')}</span>
                            </label>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                    <button className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors focus:ring-2 focus:ring-slate-400 outline-none min-w-[90px]" onClick={onClose}>{t('misc.acrobatModals:huy_bo')}</button>
                    <button className="px-6 h-[38px] flex items-center justify-center rounded font-medium text-[13px] bg-blue-600 hover:bg-blue-700 text-white shadow-sm min-w-[120px] transition-colors outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]" onClick={() => onConfirm(extractPagesStr, extractDeleteAfter)}>{t('misc.acrobatModals:trich_xuat')}</button>
                </div>
            </div>
        </div>
    );
}
