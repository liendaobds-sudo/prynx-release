import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ═══════ ROTATE PAGES MODAL ═══════
export function RotatePagesModal({ numPages, onConfirm, onClose }: {
    numPages: number;
    onConfirm: (direction: string, range: string, from: number, to: number, filter: string, orientation: string) => void;
    onClose: () => void;
}) {
  const { t } = useTranslation();
    const [rotateDirection, setRotateDirection] = useState('90');
    const [rotateRange, setRotateRange] = useState('selection');
    const [rotateFrom, setRotateFrom] = useState(1);
    const [rotateTo, setRotateTo] = useState(1);
    const [rotateFilter, setRotateFilter] = useState('all');
    const [rotateOrientation, setRotateOrientation] = useState('any');
    const [isRotating, setIsRotating] = useState(false);

    const handleConfirm = async () => {
        setIsRotating(true);
        await onConfirm(rotateDirection, rotateRange, rotateFrom, rotateTo, rotateFilter, rotateOrientation);
        setIsRotating(false);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
            <div className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                    <h3 className="font-semibold text-base text-slate-800 dark:text-zinc-100 tracking-wide">Xoay Trang</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title={t('misc.acrobatModals2:dong_esc')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <div className="p-6 flex flex-col gap-6 text-[14px]">
                    <div className="flex flex-col gap-2">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals2:huong_xoay')}</label>
                        <select value={rotateDirection} onChange={e => setRotateDirection(e.target.value)} className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all cursor-pointer">
                            <option value="90">{t('misc.acrobatModals2:90_do_thuan_chieu_kim_dong_ho')}</option>
                            <option value="-90">{t('misc.acrobatModals2:90_do_nguoc_chieu_kim_dong_ho')}</option>
                            <option value="180">{t('misc.acrobatModals2:180_do_nguoc_dau')}</option>
                        </select>
                    </div>
                    <div className="flex flex-col gap-3">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals2:pham_vi_trang')}</label>
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${rotateRange === 'all' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                    {rotateRange === 'all' && <div className="w-2 h-2 bg-white rounded-full" />}
                                </div>
                                <input type="radio" name="range" checked={rotateRange === 'all'} onChange={() => setRotateRange('all')} className="hidden" />
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals2:tat_ca_cac_trang')}</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${rotateRange === 'selection' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                    {rotateRange === 'selection' && <div className="w-2 h-2 bg-white rounded-full" />}
                                </div>
                                <input type="radio" name="range" checked={rotateRange === 'selection'} onChange={() => setRotateRange('selection')} className="hidden" />
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals2:trang_hien_tai')}</span>
                            </label>
                            <div className="flex items-center gap-3">
                                <label className="flex items-center gap-3 cursor-pointer group">
                                    <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${rotateRange === 'pages' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                        {rotateRange === 'pages' && <div className="w-2 h-2 bg-white rounded-full" />}
                                    </div>
                                    <input type="radio" name="range" checked={rotateRange === 'pages'} onChange={() => setRotateRange('pages')} className="hidden" />
                                    <span className="text-slate-700 dark:text-zinc-300 whitespace-nowrap">{t('misc.acrobatModals2:tuy_chinh')}</span>
                                </label>
                                <div className={`flex items-center gap-2 flex-1 transition-opacity ${rotateRange === 'pages' ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                    <input type="number" min="1" max={numPages} value={rotateFrom} onChange={e => {setRotateFrom(parseInt(e.target.value)); setRotateRange('pages');}} className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-zinc-200 outline-none focus:border-blue-500" />
                                    <span className="text-slate-400">-</span>
                                    <input type="number" min="1" max={numPages} value={rotateTo} onChange={e => {setRotateTo(parseInt(e.target.value)); setRotateRange('pages');}} className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-zinc-200 outline-none focus:border-blue-500" />
                                    <span className="text-slate-400 text-[13px] ml-auto">/ {numPages}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals2:bo_loc_nang_cao')}</label>
                        <div className="grid grid-cols-1 gap-3">
                            <select value={rotateFilter} onChange={e => setRotateFilter(e.target.value)} className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-[13px] cursor-pointer">
                                <option value="all">{t('misc.acrobatModals2:tat_ca_trang_chan_va_le')}</option>
                                <option value="even">{t('misc.acrobatModals2:chi_trang_chan_2_4_6')}</option>
                                <option value="odd">{t('misc.acrobatModals2:chi_trang_le_1_3_5')}</option>
                            </select>
                            <select value={rotateOrientation} onChange={e => setRotateOrientation(e.target.value)} className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-zinc-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-[13px] cursor-pointer">
                                <option value="any">{t('misc.acrobatModals2:trang_moi_huong_kich_thuoc_bat_ky')}</option>
                                <option value="portrait">{t('misc.acrobatModals2:chi_trang_doc_portrait')}</option>
                                <option value="landscape">{t('misc.acrobatModals2:chi_trang_ngang_landscape')}</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                    <button className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors focus:ring-2 focus:ring-slate-400 outline-none min-w-[90px]" onClick={onClose}>{t('misc.acrobatModals2:huy_bo')}</button>
                    <button className="px-6 py-2 rounded-lg font-medium text-[13px] bg-blue-600 hover:bg-blue-700 text-white shadow-sm flex items-center justify-center min-w-[100px] transition-colors outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e] disabled:opacity-70 disabled:cursor-not-allowed" onClick={handleConfirm} disabled={isRotating}>
                        {isRotating ? (
                            <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                        ) : t('misc.acrobatModals2:luu_thay_doi')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ═══════ INSERT BLANK PAGE MODAL ═══════
export function InsertBlankPageModal({ pageCount, onConfirm, onClose }: {
    pageCount: number;
    onConfirm: (location: 'after' | 'before', target: 'first' | 'last' | 'page', targetPage: number) => void;
    onClose: () => void;
}) {
  const { t } = useTranslation();
    const [insertLocation, setInsertLocation] = useState<'after' | 'before'>('after');
    const [insertTarget, setInsertTarget] = useState<'first' | 'last' | 'page'>('page');
    const [insertTargetPage, setInsertTargetPage] = useState(1);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
            <div className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                    <h3 className="font-semibold text-base text-slate-800 dark:text-zinc-100 tracking-wide">{t('misc.acrobatModals2:chen_trang_insert_pages')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title={t('misc.acrobatModals2:dong')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <div className="p-6 flex flex-col gap-6 text-[14px]">
                    <div className="flex flex-col gap-2">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals2:cau_hinh_chen')}</label>
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                            <div className="flex items-center justify-between">
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals2:the_loai')}</span>
                                <span className="text-slate-900 dark:text-zinc-100 font-semibold bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 px-3 py-1.5 rounded-lg">{t('misc.acrobatModals2:trang_trang_blank_page')}</span>
                            </div>
                            <div className="flex items-center justify-between mt-2">
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals2:vi_tri')}</span>
                                <select value={insertLocation} onChange={e => setInsertLocation(e.target.value as any)} className="w-[200px] bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-zinc-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all cursor-pointer">
                                    <option value="after">Sau (After)</option>
                                    <option value="before">{t('misc.acrobatModals2:truoc_before')}</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="text-slate-600 dark:text-zinc-300 font-medium">{t('misc.acrobatModals2:trang_dich_target_page')}</label>
                        <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${insertTarget === 'first' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                    {insertTarget === 'first' && <div className="w-2 h-2 bg-white rounded-full" />}
                                </div>
                                <input type="radio" name="insertTarget" checked={insertTarget === 'first'} onChange={() => setInsertTarget('first')} className="hidden" />
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals2:dau_tien_first')}</span>
                            </label>
                            <label className="flex items-center gap-3 cursor-pointer group">
                                <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${insertTarget === 'last' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                    {insertTarget === 'last' && <div className="w-2 h-2 bg-white rounded-full" />}
                                </div>
                                <input type="radio" name="insertTarget" checked={insertTarget === 'last'} onChange={() => setInsertTarget('last')} className="hidden" />
                                <span className="text-slate-700 dark:text-zinc-300">{t('misc.acrobatModals2:cuoi_cung_last')}</span>
                            </label>
                            <div className="flex items-center gap-3">
                                <label className="flex items-center gap-3 cursor-pointer group">
                                    <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${insertTarget === 'page' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-blue-400'}`}>
                                        {insertTarget === 'page' && <div className="w-2 h-2 bg-white rounded-full" />}
                                    </div>
                                    <input type="radio" name="insertTarget" checked={insertTarget === 'page'} onChange={() => setInsertTarget('page')} className="hidden" />
                                    <span className="text-slate-700 dark:text-zinc-300 whitespace-nowrap">{t('misc.acrobatModals2:trang_so')}</span>
                                </label>
                                <div className={`flex items-center gap-2 flex-1 transition-opacity ${insertTarget === 'page' ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                    <input type="number" min="1" max={pageCount} value={insertTargetPage} onChange={e => { setInsertTargetPage(parseInt(e.target.value)); setInsertTarget('page'); }} className="w-16 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-zinc-200 outline-none focus:border-blue-500" />
                                    <span className="text-slate-500 dark:text-zinc-400 text-[13px] ml-auto">/ {pageCount}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                    <button className="px-5 h-[38px] flex items-center justify-center rounded font-medium text-[13px] text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-white/10 border border-transparent hover:border-slate-200 dark:hover:border-white/10 transition-colors focus:ring-2 focus:ring-slate-400 outline-none min-w-[90px]" onClick={onClose}>{t('misc.acrobatModals2:huy_bo')}</button>
                    <button className="px-6 h-[38px] flex items-center justify-center rounded font-medium text-[13px] bg-blue-600 hover:bg-blue-700 text-white shadow-sm min-w-[120px] transition-colors outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]" onClick={() => onConfirm(insertLocation, insertTarget, insertTargetPage)}>{t('misc.acrobatModals2:luu_thay_doi')}</button>
                </div>
            </div>
        </div>
    );
}
