// @ts-nocheck
/**
 * NupSettingsSection — N-Up / Step & Repeat settings UI.
 * 
 * Extracted from ImposerDashboard.tsx.
 * Renders: Layout type, duplex flow for N-Up and Step&Repeat modes.
 */
import React from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { RichSelect } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';

export default function NupSettingsSection({ activeTool }: { activeTool: string }) {
  const { t } = useTranslation();
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode, setTaskMode: state.setTaskMode,
        layoutType: state.layoutType, setLayoutType: state.setLayoutType,
        duplexFlow: state.duplexFlow, setDuplexFlow: state.setDuplexFlow,
    })));

    // N-Up mode
    if (s.taskMode === 'nup' || s.taskMode === 'sticker_imposer') {
        return (
            <div className="flex flex-col gap-5 animate-in fade-in duration-200 relative z-[60]">
                {/* Layout Type */}
                {activeTool !== 'sticker_imposer' && (
                    <div className="flex flex-col gap-2">
                        <label className="text-[11px] font-bold text-slate-600 tracking-wide block -mb-0.5">{t('imposition.nupSettings:cach_thuc_rap_thanh_pham')}</label>
                        <RichSelect
                            value={s.layoutType}
                            onChange={(v) => {
                                s.setLayoutType(v as any);
                                if (v === 'cut_stacks' && s.duplexFlow === 'double') {
                                    s.setDuplexFlow('normal');
                                }
                            }}
                            options={[
                                { value: 'sequential', title: t('imposition.nupSettings:xep_lan_luot'), desc: t('imposition.nupSettings:1_mat_trang_1_2_3_lien_tiep_theo_sl_2') },
                                { value: 'cut_stacks', title: t('imposition.nupSettings:xep_chong'), desc: t('imposition.nupSettings:xen_coc_roi_up_dung_thu_tu_trang_1_mat') },
                                { value: 'ratio_stack', title: t('imposition.nupSettings:chia_ty_le_xep_chong'), desc: t('imposition.nupSettings:nhieu_mau_cung_co_sl_khac_nhau_moi_to') }
                            ]}
                        />
                    </div>
                )}
                {/* Duplex */}
                {activeTool !== 'sticker_imposer' && (
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-3">
                            <label className="text-[11px] font-bold text-slate-600 tracking-wide shrink-0 w-[65px]">{t('imposition.nupSettings:so_mat')}</label>
                            <select
                                value={s.duplexFlow}
                                onChange={(e) => {
                                    const v = e.target.value as 'normal' | 'double';
                                    s.setDuplexFlow(v);
                                    // Guard đối xứng: chọn 2 Mặt khi đang «Xếp chồng» (cut_stacks
                                    // không hỗ trợ 2 mặt) → tự đổi cách ráp về «Xếp lần lượt».
                                    if (v === 'double' && s.layoutType === 'cut_stacks') {
                                        s.setLayoutType('sequential');
                                    }
                                }}
                                className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                            >
                                <option value="normal">{t('imposition.nupSettings:1_mat')}</option>
                                <option value="double">{t('imposition.nupSettings:2_mat')}</option>
                            </select>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // Step & Repeat mode
    if (s.taskMode === 'step_repeat') {
        return (
            <div className="flex flex-col gap-5 animate-in fade-in duration-200 relative z-[60]">
                {activeTool !== 'sticker_imposer' && (
                    <div className="flex items-center gap-3">
                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[65px]">{t('imposition.nupSettings:so_mat')}</label>
                        <select
                            value={s.duplexFlow} onChange={(e) => s.setDuplexFlow(e.target.value as 'normal' | 'double')}
                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                        >
                            <option value="normal">{t('imposition.nupSettings:1_mat')}</option>
                            <option value="double">{t('imposition.nupSettings:2_mat')}</option>
                        </select>
                    </div>
                )}
            </div>
        );
    }

    return null;
}
