// @ts-nocheck
/**
 * AutoCatalogSection — Auto Catalog Planner UI for Offset booklet.
 * 
 * Extracted from ImposerDashboard.tsx.
 * Handles: printing mode toggle (Digital/Offset), auto catalog toggle,
 * cover type, master sig override, remainder placement, optimizer preview.
 */
import React from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { Checkbox } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';

export default function AutoCatalogSection() {
  const { t } = useTranslation();
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode,
        paperClassification: state.paperClassification, setPaperClassification: state.setPaperClassification,
        autoCatalog: state.autoCatalog, setAutoCatalog: state.setAutoCatalog,
        catalogHasCover: state.catalogHasCover, setCatalogHasCover: state.setCatalogHasCover,
        catalogMasterSigOverride: state.catalogMasterSigOverride, setCatalogMasterSigOverride: state.setCatalogMasterSigOverride,
        catalogRemainderPlacement: state.catalogRemainderPlacement, setCatalogRemainderPlacement: state.setCatalogRemainderPlacement,
        signatureMode: state.signatureMode,
        optimalData: state.optimalData,
        catalogPreview: state.catalogPreview,
    })));

    if (s.taskMode !== 'booklet') return null;

    return (
        <>
            {/* ═══ CHẾ ĐỘ IN (Digital / Offset Toggle) ═══ */}
            <div className="flex p-1 space-x-1 bg-slate-100 dark:bg-zinc-800/60 rounded-xl mb-6 ring-1 ring-slate-200/60 dark:ring-white/10 shadow-inner relative z-10">
                <button
                    onClick={() => {
                        s.setPaperClassification('in_nhanh');
                        s.setAutoCatalog(false);
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold rounded-lg transition-all duration-300 ${
                        s.paperClassification === 'in_nhanh' 
                            ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-sm ring-1 ring-slate-200 dark:ring-zinc-600' 
                            : 'text-slate-500 hover:text-slate-700 dark:text-zinc-400 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    {t('imposition.autoCatalog:in_nhanh_digital')}
                </button>
                <button
                    onClick={() => {
                        s.setPaperClassification('offset');
                        s.setAutoCatalog(true);
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold rounded-lg transition-all duration-300 ${
                        s.paperClassification === 'offset' 
                            ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm ring-1 ring-slate-200 dark:ring-zinc-600' 
                            : 'text-slate-500 hover:text-slate-700 dark:text-zinc-400 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    {t('imposition.autoCatalog:in_offset')}
                </button>
            </div>

            {/* ═══ AUTO CATALOG (Offset only) ═══ */}
            {s.paperClassification === 'offset' && (
                <div className="flex flex-col gap-2 p-3 bg-purple-50 dark:bg-purple-900/10 border border-purple-200 dark:border-purple-800/30 rounded-lg relative z-[65] mb-4 transition-all duration-300">
                    <Checkbox 
                        checked={s.autoCatalog} 
                        onChange={s.setAutoCatalog} 
                        label={t('imposition.autoCatalog:tu_dong_chia_kem_auto_catalog')} 
                    />
                    {s.autoCatalog && (
                        <div className="mt-2 ml-6 space-y-3">
                            <div className="flex flex-col gap-1 mt-1">
                                <label className="text-[10px] font-bold text-slate-500 uppercase">{t('imposition.autoCatalog:loai_bia_catalog')}</label>
                                <select 
                                    value={s.catalogHasCover ? 'different' : 'same'}
                                    onChange={(e) => s.setCatalogHasCover(e.target.value === 'different')}
                                    className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-purple-500"
                                >
                                    <option value="different">{t('imposition.autoCatalog:bia_khac_chat_lieu_boc_4_trang_bia_ra')}</option>
                                    <option value="same">{t('imposition.autoCatalog:bia_cung_chat_lieu_dan_chung_voi_ruot')}</option>
                                </select>
                            </div>
                            <div className="flex flex-col gap-1 mt-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase">{t('imposition.autoCatalog:khoa_tay_sach_uu_tien')}</label>
                                <select 
                                    value={s.catalogMasterSigOverride}
                                    onChange={(e) => s.setCatalogMasterSigOverride(e.target.value as any)}
                                    className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-purple-500"
                                >
                                    <option value="auto">{t('imposition.autoCatalog:tu_dong_toi_uu_de_xuat')}</option>
                                    <option value="16">{t('imposition.autoCatalog:ep_dung_tay_16_trang_binh_8_con_mat')}</option>
                                    <option value="8">{t('imposition.autoCatalog:ep_dung_tay_8_trang_binh_4_con_mat')}</option>
                                    <option value="4">{t('imposition.autoCatalog:ep_dung_tay_4_trang_binh_2_con_mat')}</option>
                                </select>
                            </div>

                            {s.signatureMode === 'saddle' && (
                                <div className="flex flex-col gap-1 mt-2">
                                    <label className="text-[10px] font-bold text-slate-500 uppercase">{t('imposition.autoCatalog:vi_tri_tay_du_ghep_long')}</label>
                                    <select 
                                        value={s.catalogRemainderPlacement}
                                        onChange={(e) => s.setCatalogRemainderPlacement(e.target.value as any)}
                                        className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-purple-500"
                                    >
                                        <option value="outside">{t('imposition.autoCatalog:tay_bu_boc_ngoai_sat_bia_nhua')}</option>
                                        <option value="inside">{t('imposition.autoCatalog:tay_bu_nhet_loi_sat_kim_luoc')}</option>
                                    </select>
                                </div>
                            )}

                            {/* Optimizer Preview */}
                            {s.optimalData && (
                                <div className="text-xs text-slate-600 dark:text-zinc-400">
                                    {s.optimalData.warnings.map((w: string, i: number) => (
                                        <div key={i} className="text-red-500 mb-1">{w}</div>
                                    ))}
                                    {s.optimalData.recommended ? (
                                        <div className="font-bold text-emerald-600 dark:text-emerald-400">
                                            {t('imposition.autoCatalog:tay_toi_uu_hieu_suat', { label: s.optimalData.recommended.label, pct: s.optimalData.recommended.sheetUtilization })}
                                        </div>
                                    ) : (
                                        <div className="text-red-500 font-bold">{t('imposition.autoCatalog:khong_tim_thay_tay_in_phu_hop_voi_kho')}</div>
                                    )}
                                </div>
                            )}

                            {s.catalogPreview && (
                                <pre className="text-[10px] text-slate-700 dark:text-zinc-300 bg-white dark:bg-black/20 border border-slate-200 dark:border-white/10 p-2 rounded whitespace-pre-wrap">
                                    {s.catalogPreview}
                                </pre>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
