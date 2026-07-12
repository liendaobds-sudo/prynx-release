import React from 'react';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolNumberInput } from './ToolUI';
import { useTranslation } from 'react-i18next';

export interface BgRemoverOptionsState {
    aiEngine: 'fast' | 'general' | 'hair';
    edgeShift: number;
    bgColor: 'transparent' | 'white' | 'black' | 'custom';
    customHex: string;
    autoCrop: boolean;
}

interface Props {
    options: BgRemoverOptionsState;
    onChange: (opts: BgRemoverOptionsState) => void;
}

export default function BgRemoverOptions({ options, onChange }: Props) {
  const { t } = useTranslation();
    const update = (key: keyof BgRemoverOptionsState, val: any) => {
        onChange({ ...options, [key]: val });
    };

    return (
        <div className="flex flex-col gap-4 mt-2">
            {/* AI Engine Selection */}
            <div>
                <ToolSectionLabel>{t('preprocess.bgRemoverOptions:mo_hinh_phan_tich')}</ToolSectionLabel>
                <div className="grid grid-cols-1 gap-1.5">
                    <ToolCardOption
                        label={t('preprocess.bgRemoverOptions:chat_luong_cao_khuyen_dung')}
                        desc={t('preprocess.bgRemoverOptions:vien_sac_net_bam_chi_tiet_tot_can_bang')}
                        selected={options.aiEngine === 'general'}
                        onClick={() => update('aiEngine', 'general')}
                    />
                    <ToolCardOption
                        label={t('preprocess.bgRemoverOptions:nhanh_xu_ly_hang_loat')}
                        desc={t('preprocess.bgRemoverOptions:tach_gan_nhu_tuc_thi_nhe_chat_luong_kha')}
                        selected={options.aiEngine === 'fast'}
                        onClick={() => update('aiEngine', 'fast')}
                    />
                    <ToolCardOption
                        label={t('preprocess.bgRemoverOptions:toi_da_long_toc_kinh')}
                        desc={t('preprocess.bgRemoverOptions:chat_luong_cao_nhat_cho_toc_roi_long')}
                        selected={options.aiEngine === 'hair'}
                        onClick={() => update('aiEngine', 'hair')}
                    />
                </div>
            </div>

            {/* Edge Shift */}
            <div>
                <div className="flex justify-between items-end mb-1">
                    <ToolSectionLabel>{t('preprocess.bgRemoverOptions:khu_vien_rac_edge_shift')}</ToolSectionLabel>
                </div>
                <div className="flex items-center gap-3">
                    <input 
                        type="range" 
                        min="-5" max="5" step="1"
                        value={options.edgeShift}
                        onChange={(e) => update('edgeShift', parseInt(e.target.value))}
                        className="flex-1 accent-teal-500"
                    />
                    <div className="w-12 text-center text-[12px] font-bold text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-800 rounded py-1 border border-slate-200 dark:border-zinc-700">
                        {options.edgeShift > 0 ? `+${options.edgeShift}` : options.edgeShift}px
                    </div>
                </div>
                <p className="text-[10px] text-slate-400 mt-1.5">
                    {t('preprocess.bgRemoverOptions:keo_am_de_an_lem_vao_trong_cat_bo_vien')}
                </p>
            </div>

            {/* Auto Crop */}
            <div>
                <ToolSectionLabel>{t('preprocess.bgRemoverOptions:tuy_chon_khung_anh')}</ToolSectionLabel>
                <ToolCheckboxOption
                    label={t('preprocess.bgRemoverOptions:tu_dong_cat_cup_auto_crop')}
                    desc={t('preprocess.bgRemoverOptions:phan_mem_tu_dong_xen_bo_tat_ca_cac')}
                    selected={options.autoCrop}
                    onClick={() => update('autoCrop', !options.autoCrop)}
                />
            </div>
        </div>
    );
}
