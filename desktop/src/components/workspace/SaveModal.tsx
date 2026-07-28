// @ts-nocheck
import React, { useEffect } from 'react';
import { Button } from '../Button';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { useTranslation } from 'react-i18next';

interface SaveModalProps {
    handleSaveFile: (isSaveAs: boolean) => void;
    onSavePrint?: () => void;
}

export default function SaveModal({ handleSaveFile, onSavePrint }: SaveModalProps) {
  const { t } = useTranslation();
    const { showSaveAsModal, setShowSaveAsModal, file, setReportMsg } = useWorkspaceStore();
    const { batchOutput } = useImposerSettingsStore();

    useEffect(() => {
        if (!showSaveAsModal) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setShowSaveAsModal(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [showSaveAsModal, setShowSaveAsModal]);

    if (!showSaveAsModal) return null;

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            {/* UIUX (audit 2026-07-27 §A-03): hex nền cứng + viền đen/trắng mờ → token bg-app-1 / border-app-line */}
            <div role="dialog" aria-modal="true" aria-label={t('misc.save:luu_thanh_pdf')} className="bg-app-1 rounded shadow-2xl flex flex-col w-[800px] h-[580px] overflow-hidden border border-app-line animate-in zoom-in-95 duration-200">

                {/* HEADER */}
                {/* UIUX (audit 2026-07-27 §A-03): bg-white + hex dark cứng → bg-app-2, viền gray → border-app-line */}
                <div className="flex items-center justify-between px-6 py-4 bg-app-2 border-b border-app-line">
                    <h2 className="text-[22px] font-medium text-slate-800 dark:text-gray-100">{t('misc.save:luu_thanh_pdf')}</h2>
                    <button onClick={() => setShowSaveAsModal(false)} className="text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors focus:outline-none">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* BODY */}
                <div className="flex flex-1 overflow-hidden">
                    {/* LEFT MENU */}
                    {/* UIUX (audit 2026-07-27 §A-03): bg-white + hex dark cứng → bg-app-2, viền gray → border-app-line */}
                    <div className="w-[200px] bg-app-2 flex flex-col pt-4 border-r border-app-line">
                        <span className="text-[11px] font-bold tracking-wider text-gray-500 uppercase px-6 pb-2">{t('misc.save:noi_luu')}</span>
                        <div className="flex flex-col">
                            {/* UIUX (audit 2026-07-27 §A-02): cobalt hex cứng → token accent (giữ vai trò active: nền nhạt + viền trái) */}
                            <button className="px-6 py-2 text-left text-[14px] bg-app-accent-soft text-app-accent transition-colors focus:outline-none border-l-2 border-app-accent">
                                {t('misc.save:may_tinh_cua_ban')}
                            </button>
                            <button className="px-6 py-2 text-left text-[14px] text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors focus:outline-none border-l-2 border-transparent">
                                {t('misc.save:bo_nho_dam_may')}
                            </button>
                            <button className="px-6 py-2 text-left text-[14px] text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors focus:outline-none border-l-2 border-transparent">
                                {t('misc.save:them_vi_tri_luu')}
                            </button>
                        </div>
                    </div>

                    {/* RIGHT CONTENT */}
                    {/* UIUX (audit 2026-07-27 §A-03): hex nền cứng → bg-app-1 (vùng nội dung thấp hơn panel bg-app-2) */}
                    <div className="flex-1 flex flex-col bg-app-1 pb-6 pt-4 px-8 overflow-y-auto scroller-thin">


                        <span className="text-[16px] text-gray-700 dark:text-gray-200 mb-4">{t('misc.save:luu_vao_thu_muc_gan_day')}</span>

                        <div className="flex flex-col gap-2">
                            {batchOutput && file === (batchOutput.mergedBlob as any) ? (
                                <>
                                    <div className="text-[12px] text-orange-600 dark:text-orange-400 font-bold mb-1">{t('misc.save:xuat_nhieu_kho_kem_auto_catalog')}</div>

                                    {/* UIUX (audit 2026-07-27 §A-02) fix-verify: hover blue-50/blue-900 sót (tông cobalt cũ, nhảy hue) → hover:border-app-accent-hover, nền giữ nguyên */}
                                    <button
                                        onClick={() => { setShowSaveAsModal(false); handleSaveFile(false); }}
                                        className="flex gap-4 items-center p-3 border border-app-accent bg-app-accent-soft rounded focus:outline-none text-left hover:border-app-accent-hover transition-colors"
                                    >
                                        {/* UIUX (audit 2026-07-27 §A-02): stroke cobalt hex → currentColor + text-app-accent */}
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-app-accent" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                                        <div className="flex flex-col">
                                            {/* UIUX (audit 2026-07-27 §A-02): chữ cobalt hex → text-app-accent */}
                                            <span className="text-[15px] text-app-accent font-bold">{t('misc.save:luu_thanh_1_file_gop')}</span>
                                            <span className="text-[12px] text-gray-500 line-clamp-1">{t('misc.save:giu_nguyen_dinh_dang_gop_tam_kem', { n: batchOutput.docs.length })}</span>
                                        </div>
                                    </button>

                                    <button
                                        onClick={async () => {
                                            setShowSaveAsModal(false);
                                            batchOutput.docs.forEach((doc, idx) => {
                                                setTimeout(() => {
                                                    const url = URL.createObjectURL(doc.blob);
                                                    const a = document.createElement('link');
                                                    a.href = url;
                                                    (a as any).download = doc.filename;
                                                    a.click();
                                                    URL.revokeObjectURL(url);
                                                }, idx * 500);
                                            });
                                            setReportMsg(prev => prev + '\n\n' + t('misc.save:da_gui_lenh_tai_roi_nhieu_file'));
                                        }}
                                        className="flex gap-4 items-center p-3 border border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 rounded focus:outline-none text-left hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-colors mt-2"
                                    >
                                        {/* UIUX (audit 2026-07-27 §A-02): stroke emerald hex → currentColor + text-app-success */}
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-app-success" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                        <div className="flex flex-col">
                                            <span className="text-[15px] text-emerald-700 dark:text-emerald-400 font-bold">{t('misc.save:tai_roi_tung_kem_download_files', { n: batchOutput.docs.length })}</span>
                                            <span className="text-[12px] text-gray-500 line-clamp-1">{t('misc.save:trinh_duyet_se_tu_dong_xa_nhieu_file')}</span>
                                        </div>
                                    </button>
                                </>
                            ) : (
                                // UIUX (audit 2026-07-27 §A-02): viền/nền cobalt → border-app-accent + bg-app-accent-soft
                                <button
                                    onClick={() => { setShowSaveAsModal(false); handleSaveFile(false); }}
                                    className="flex gap-4 items-center p-3 border border-app-accent bg-app-accent-soft rounded focus:outline-none text-left"
                                >
                                    {/* UIUX (audit 2026-07-27 §A-02): stroke cobalt hex → currentColor + text-app-accent */}
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-app-accent" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2z" /></svg>
                                    <div className="flex flex-col">
                                        <span className="text-[15px] text-gray-800 dark:text-gray-100">Downloads</span>
                                        <span className="text-[12px] text-gray-500">C:\Users\Target\Downloads</span>
                                    </div>
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* FOOTER */}
                {/* UIUX (audit 2026-07-27 §A-03): bg-white + hex dark cứng → bg-app-2, viền gray → border-app-line */}
                <div className="flex items-center justify-end px-6 py-4 bg-app-2 border-t border-app-line shrink-0">

                    <div className="flex gap-3">
                        <button
                            onClick={() => setShowSaveAsModal(false)}
                            className="px-6 py-2 min-w-[90px] border border-gray-300 dark:border-gray-600 rounded-md text-[14px] font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus:outline-none"
                        >
                            {t('misc.save:huy_bo')}
                        </button>
                        {onSavePrint && (
                            <button
                                onClick={() => { setShowSaveAsModal(false); onSavePrint(); }}
                                className="px-6 py-2 border border-rose-400 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md text-[14px] font-medium transition-colors focus:outline-none flex items-center gap-1.5"
                                title={t('misc.save:luu_tach_tung_to_in_va_file_be_ra_thu')}
                            >
                                {t('misc.save:luu_file_in_tach_le')}
                            </button>
                        )}
                        {/* UIUX (audit 2026-07-27 §A-02): nút chính cobalt hex → bg-app-accent + hover token */}
                        <button
                            onClick={() => { setShowSaveAsModal(false); handleSaveFile(true); }}
                            className="px-6 py-2 bg-app-accent hover:bg-app-accent-hover text-white rounded-md text-[14px] font-medium transition-colors shadow-sm focus:outline-none flex items-center justify-center"
                        >
                            {t('misc.save:chon_thu_muc_khac')}
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
