import { useState } from 'react';
import { SplitMode } from '../../lib/preprocessEngine/PdfSplitter';
import { 
    ToolSectionLabel, ToolDivider, ToolCheckboxOption, 
    ToolNumberInput, ToolInfo 
} from './ToolUI';
import { useTranslation } from 'react-i18next';

const inputCls = "w-full h-8 px-2.5 text-[12px] border border-slate-300 dark:border-white/20 rounded-md bg-white dark:bg-zinc-900 font-medium focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 transition-all";

export interface SplitSettings {
    mode: SplitMode;
    ranges: string;
    pagesPerFile: number;
    pageListStr: string;
}

interface Props {
    settings: SplitSettings;
    onChange: (settings: SplitSettings) => void;
}

export default function SplitTool({ settings, onChange }: Props) {
  const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">
            
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.split:1_che_do_tach')}</ToolSectionLabel>
                <div className="flex flex-col gap-2">
                    <ToolCheckboxOption 
                        selected={settings.mode === 'by_range'}
                        onClick={() => onChange({...settings, mode: 'by_range'})}
                        label={t('preprocess.split:tach_theo_dai_trang')}
                        desc={t('preprocess.split:tach_pdf_thanh_nhieu_file_tuy_chinh_dua')}
                    />
                    <ToolCheckboxOption 
                        selected={settings.mode === 'by_count'}
                        onClick={() => onChange({...settings, mode: 'by_count'})}
                        label={t('preprocess.split:chia_deu_so_luong_trang')}
                        desc={t('preprocess.split:chia_deu_pdf_thanh_cac_file_nho_co_cung')}
                    />
                    <ToolCheckboxOption 
                        selected={settings.mode === 'extract_pages'}
                        onClick={() => onChange({...settings, mode: 'extract_pages'})}
                        label={t('preprocess.split:trich_xuat_trang')}
                        desc={t('preprocess.split:trich_xuat_cac_trang_duoc_chi_dinh_ra')}
                    />
                </div>
            </div>

            <ToolDivider />

            <div className="flex flex-col gap-2 min-h-[90px]">
                {settings.mode === 'by_range' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolSectionLabel>{t('preprocess.split:cu_phap_dai_trang')}</ToolSectionLabel>
                        <input
                            type="text"
                            value={settings.ranges}
                            onChange={e => onChange({ ...settings, ranges: e.target.value })}
                            placeholder="VD: 1-4, 5-8, 10, 12-20"
                            className={inputCls}
                        />
                        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            {t('preprocess.split:moi_dai_phan_cach_boi_dau_phay_tuong')}<br/>
                            VD: "1-4, 5-8" → Tạo ra 2 file (file chứa tr1-tr4, file chứa tr5-tr8).
                        </div>
                    </div>
                )}

                {settings.mode === 'by_count' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolSectionLabel>{t('preprocess.split:so_trang_moi_file')}</ToolSectionLabel>
                        <ToolNumberInput 
                            label=""
                            value={settings.pagesPerFile}
                            onChange={val => onChange({ ...settings, pagesPerFile: val || 1 })}
                            step={1}
                        />
                        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            {t('preprocess.split:chia_tai_lieu_goc_thanh_nhieu_file_con')}
                        </div>
                    </div>
                )}

                {settings.mode === 'extract_pages' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolSectionLabel>{t('preprocess.split:trang_can_trich_xuat')}</ToolSectionLabel>
                        <input
                            type="text"
                            value={settings.pageListStr}
                            onChange={e => onChange({ ...settings, pageListStr: e.target.value })}
                            placeholder="VD: 1, 3, 5, 10"
                            className={inputCls}
                        />
                        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            {t('preprocess.split:nhap_cac_so_trang_rieng_biet_cach_nhau')}
                        </div>
                    </div>
                )}
            </div>
            
            <ToolInfo desc={
                <><strong>{t('preprocess.split:ghi_chu')}</strong> {t('preprocess.split:tac_vu_split_se_tao_ra_nhieu_file_pdf')}</>
            } />
        </div>
    );
}
