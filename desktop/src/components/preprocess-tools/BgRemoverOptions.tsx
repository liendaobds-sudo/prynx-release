import React from 'react';
import { ToolSectionLabel, ToolCheckboxOption } from './ToolUI';
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
    disabled?: boolean;
}

export default function BgRemoverOptions({ options, onChange, disabled = false }: Props) {
  const { t } = useTranslation();
    const update = <K extends keyof BgRemoverOptionsState>(key: K, val: BgRemoverOptionsState[K]) => {
        onChange({ ...options, [key]: val });
    };
    const engineDescription = options.aiEngine === 'fast'
        ? t('preprocess.bgRemoverOptions:tach_gan_nhu_tuc_thi_nhe_chat_luong_kha')
        : options.aiEngine === 'hair'
            ? t('preprocess.bgRemoverOptions:chat_luong_cao_nhat_cho_toc_roi_long')
            : t('preprocess.bgRemoverOptions:vien_sac_net_bam_chi_tiet_tot_can_bang');

    return (
        <fieldset disabled={disabled} className={"flex flex-col gap-4 mt-2 " + (disabled ? "opacity-60" : "") }>
            {/* Engine Selection */}
            <div>
                <ToolSectionLabel>{t('preprocess.bgRemoverOptions:mo_hinh_phan_tich')}</ToolSectionLabel>
                <select
                    value={options.aiEngine}
                    onChange={(event) => update('aiEngine', event.target.value as BgRemoverOptionsState['aiEngine'])}
                    className="w-full h-10 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-lg px-3 text-[13px] font-semibold text-slate-800 dark:text-zinc-100"
                >
                    <option value="general">{t('preprocess.bgRemoverOptions:chat_luong_cao_khuyen_dung')}</option>
                    <option value="fast">{t('preprocess.bgRemoverOptions:nhanh_xu_ly_hang_loat')}</option>
                    <option value="hair">{t('preprocess.bgRemoverOptions:toi_da_long_toc_kinh')}</option>
                </select>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400">
                    {engineDescription}
                </p>
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

            {/* Màu nền */}
            <div>
                <ToolSectionLabel>{t('preprocess.bgRemoverOptions:mau_nen', { defaultValue: 'Màu nền đầu ra' })}</ToolSectionLabel>
                <select
                    value={options.bgColor}
                    onChange={(event) => update('bgColor', event.target.value as BgRemoverOptionsState['bgColor'])}
                    className="w-full h-10 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-lg px-3 text-[13px]"
                >
                    <option value="transparent">{t('preprocess.bgRemoverOptions:trong_suot', { defaultValue: 'Trong suốt' })}</option>
                    <option value="white">{t('preprocess.bgRemoverOptions:trang', { defaultValue: 'Trắng' })}</option>
                    <option value="black">{t('preprocess.bgRemoverOptions:den', { defaultValue: 'Đen' })}</option>
                    <option value="custom">{t('preprocess.bgRemoverOptions:tuy_chon', { defaultValue: 'Tùy chọn' })}</option>
                </select>
                {options.bgColor === 'custom' && (
                    <div className="mt-2 flex items-center gap-2">
                        <input
                            type="color"
                            value={options.customHex}
                            onChange={(event) => update('customHex', event.target.value.toUpperCase())}
                            className="w-12 h-9 rounded border border-slate-300 dark:border-white/20 bg-transparent"
                        />
                        <span className="text-[12px] font-mono text-slate-600 dark:text-zinc-300">{options.customHex}</span>
                    </div>
                )}
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
        </fieldset>
    );
}
