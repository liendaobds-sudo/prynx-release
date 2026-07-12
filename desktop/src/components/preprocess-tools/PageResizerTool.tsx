import { ResizeOptions } from '../../lib/preprocessEngine/PageResizer';
import { 
    ToolSectionLabel, ToolDivider, ToolCardOption, 
    ToolCheckboxOption, ToolNumberInput,
} from './ToolUI';
import { useTranslation } from 'react-i18next';

const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500";
const selectCls = "w-full h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm font-medium focus:outline-none focus:border-indigo-500";

const COMMON_SIZES = [
    { id: 'A4', name: 'A4', desc: '210 × 297 mm', w: 210, h: 297 },
    { id: 'A3', name: 'A3', desc: '297 × 420 mm', w: 297, h: 420 },
    { id: 'A5', name: 'A5', desc: '148 × 210 mm', w: 148, h: 210 },
    { id: 'SRA3', name: 'SRA3', desc: '320 × 450 mm', w: 320, h: 450 },
    { id: 'B2', name: 'B2', desc: '500 × 707 mm', w: 500, h: 707 },
    { id: 'B3', name: 'B3', desc: '353 × 500 mm', w: 353, h: 500 },
    { id: 'Letter', name: 'Letter', desc: '216 × 279 mm', w: 216, h: 279 },
    { id: 'custom', name: 'Tùy chỉnh', desc: 'Nhập W × H', w: 0, h: 0 },
];

export interface PageResizerSettings extends ResizeOptions {
    sizePresetId: string;
    applyToStr: string;
    // Giảm dữ liệu theo khổ mới (giống PDF Optimizer). undefined = tự động
    // (downsample 300 DPI khi thu nhỏ khổ), 0 = tắt (giữ nguyên chất lượng),
    // >0 = DPI cụ thể. resizeMode: 'auto' | 'vector' | 'raster'.
    targetDpi?: number;
    resizeMode?: string;
}

const DPI_PRESETS = [150, 300, 600];

interface Props {
    settings: PageResizerSettings;
    onChange: (settings: PageResizerSettings) => void;
}

export default function PageResizerTool({ settings, onChange }: Props) {
  const { t } = useTranslation();
    
    const handlePresetChange = (presetId: string) => {
        const preset = COMMON_SIZES.find(p => p.id === presetId);
        if (preset) {
            onChange({
                ...settings,
                sizePresetId: presetId,
                targetW: preset.id === 'custom' ? settings.targetW : preset.w,
                targetH: preset.id === 'custom' ? settings.targetH : preset.h
            });
        }
    };

    const handleApplyToChange = (val: string) => {
        let applyTo: ResizeOptions['applyTo'] = 'all';
        if (val === 'all' || val === 'even' || val === 'odd') {
            applyTo = val;
        } else {
            // parse custom pages on execution, keep as 'all' for now in type but we use applyToStr
            applyTo = 'all'; 
        }

        onChange({
            ...settings,
            applyToStr: val,
            applyTo
        });
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">
            
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.pageResizer:1_kich_thuoc_trang_dich')}</ToolSectionLabel>
                <select
                    value={settings.sizePresetId || 'A4'}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className={selectCls}
                >
                    {COMMON_SIZES.map(p => (
                        <option key={p.id} value={p.id}>
                            {p.id === 'custom' ? p.name : `${p.name} — ${p.desc}`}
                        </option>
                    ))}
                </select>
                
                {settings.sizePresetId === 'custom' && (
                    <div className="grid grid-cols-2 gap-3 mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolNumberInput 
                            label={t('preprocess.pageResizer:chieu_ngang')}
                            value={settings.targetW}
                            onChange={val => onChange({ ...settings, targetW: val })}
                            suffix="mm" step={0.1}
                        />
                        <ToolNumberInput 
                            label={t('preprocess.pageResizer:chieu_doc')}
                            value={settings.targetH}
                            onChange={val => onChange({ ...settings, targetH: val })}
                            suffix="mm" step={0.1}
                        />
                    </div>
                )}
            </div>

            <ToolDivider />

            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.pageResizer:2_kieu_ty_le')}</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-2">
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'fit'}
                        onClick={() => onChange({...settings, scaleMode: 'fit'})}
                        label={t('preprocess.pageResizer:thu_vua_khit')}
                        desc={t('preprocess.pageResizer:thu_phong_noi_dung_vua_khit_vao_kho')}
                    />
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'fill'}
                        onClick={() => onChange({...settings, scaleMode: 'fill'})}
                        label={t('preprocess.pageResizer:phong_lap_day')}
                        desc={t('preprocess.pageResizer:phong_to_noi_dung_lap_day_kho_moi_phan')}
                    />
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'stretch'}
                        onClick={() => onChange({...settings, scaleMode: 'stretch'})}
                        label={t('preprocess.pageResizer:ep_bop_meo')}
                        desc={t('preprocess.pageResizer:ep_noi_dung_vua_dung_kho_moi_nhung')}
                    />
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'center_no_scale'}
                        onClick={() => onChange({...settings, scaleMode: 'center_no_scale'})}
                        label={t('preprocess.pageResizer:giu_nguyen_o_giua')}
                        desc={t('preprocess.pageResizer:giu_nguyen_kich_thuoc_noi_dung_goc_chi')}
                    />
                </div>
            </div>

            <ToolDivider />

            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.pageResizer:3_ap_dung_cho')}</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-2">
                    <ToolCardOption selected={settings.applyToStr === 'all'} onClick={() => handleApplyToChange('all')} label={t('preprocess.pageResizer:tat_ca_trang')} />
                    <ToolCardOption selected={settings.applyToStr === 'even'} onClick={() => handleApplyToChange('even')} label={t('preprocess.pageResizer:trang_chan')} />
                    <ToolCardOption selected={settings.applyToStr === 'odd'} onClick={() => handleApplyToChange('odd')} label={t('preprocess.pageResizer:trang_le')} />
                    <ToolCardOption selected={!['all', 'even', 'odd'].includes(settings.applyToStr)} onClick={() => handleApplyToChange('custom')} label={t('preprocess.pageResizer:tuy_chinh')} />
                </div>

                {!['all', 'even', 'odd'].includes(settings.applyToStr) && (
                    <div className="mt-3">
                        <input
                            type="text"
                            value={settings.applyToStr === 'custom' ? '' : settings.applyToStr}
                            onChange={e => handleApplyToChange(e.target.value)}
                            placeholder="VD: 1, 3, 5-10"
                            className={inputCls}
                        />
                        <div className="text-[10px] text-slate-400 mt-1.5 ml-1">{t('preprocess.pageResizer:nhap_so_trang_cach_nhau_bang_dau_phay')}</div>
                    </div>
                )}
            </div>

            <ToolDivider />

            {/* 4. Giảm dung lượng theo khổ mới */}
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.pageResizer:4_giam_dung_luong_theo_kho_moi')}</ToolSectionLabel>
                {(() => {
                    const dpiChoice: 'auto' | 'off' | 'custom' =
                        settings.targetDpi === undefined ? 'auto'
                            : settings.targetDpi === 0 ? 'off' : 'custom';
                    const setChoice = (c: 'auto' | 'off' | 'custom') => {
                        if (c === 'auto') onChange({ ...settings, targetDpi: undefined });
                        else if (c === 'off') onChange({ ...settings, targetDpi: 0 });
                        else onChange({ ...settings, targetDpi: settings.targetDpi && settings.targetDpi > 0 ? settings.targetDpi : 300 });
                    };
                    const mode = settings.resizeMode || 'auto';
                    return (
                        <>
                            <div className="grid grid-cols-3 gap-2">
                                <ToolCardOption
                                    selected={dpiChoice === 'auto'}
                                    onClick={() => setChoice('auto')}
                                    label={t('preprocess.pageResizer:tu_dong')}
                                    desc={t('preprocess.pageResizer:giam_mau_300_dpi_khi_thu_nho_kho_khuyen')}
                                />
                                <ToolCardOption
                                    selected={dpiChoice === 'custom'}
                                    onClick={() => setChoice('custom')}
                                    label={t('preprocess.pageResizer:chon_dpi')}
                                    desc={t('preprocess.pageResizer:tu_dat_do_phan_giai_dich_cho_anh')}
                                />
                                <ToolCardOption
                                    selected={dpiChoice === 'off'}
                                    onClick={() => setChoice('off')}
                                    label={t('preprocess.pageResizer:giu_nguyen')}
                                    desc={t('preprocess.pageResizer:khong_giam_mau_chat_luong_toi_da_file')}
                                />
                            </div>

                            {dpiChoice === 'custom' && (
                                <div className="mt-2 flex items-center gap-2">
                                    {DPI_PRESETS.map(d => (
                                        <ToolCardOption
                                            key={d}
                                            selected={settings.targetDpi === d}
                                            onClick={() => onChange({ ...settings, targetDpi: d })}
                                            label={`${d}`}
                                            desc={d === 150 ? t('preprocess.pageResizer:xem_man_hinh') : d === 300 ? 'In offset' : t('preprocess.pageResizer:in_net_cao')}
                                        />
                                    ))}
                                    <div className="w-28">
                                        <ToolNumberInput
                                            label="DPI"
                                            value={settings.targetDpi ?? 300}
                                            onChange={val => onChange({ ...settings, targetDpi: Math.max(1, Math.round(val)) })}
                                            step={10}
                                        />
                                    </div>
                                </div>
                            )}

                            {dpiChoice !== 'off' && (
                                <div className="mt-3">
                                    <div className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 mb-1.5 ml-0.5">{t('preprocess.pageResizer:che_do_xu_ly')}</div>
                                    <div className="grid grid-cols-3 gap-2">
                                        <ToolCardOption
                                            selected={mode === 'auto'}
                                            onClick={() => onChange({ ...settings, resizeMode: 'auto' })}
                                            label={t('preprocess.pageResizer:tu_dong')}
                                            desc={t('preprocess.pageResizer:tu_chon_theo_noi_dung_trang')}
                                        />
                                        <ToolCardOption
                                            selected={mode === 'vector'}
                                            onClick={() => onChange({ ...settings, resizeMode: 'vector' })}
                                            label={t('preprocess.pageResizer:uu_tien_chat_luong')}
                                            desc={t('preprocess.pageResizer:giu_chu_vector_mau_cmyk_chi_giam_anh')}
                                        />
                                        <ToolCardOption
                                            selected={mode === 'raster'}
                                            onClick={() => onChange({ ...settings, resizeMode: 'raster' })}
                                            label={t('preprocess.pageResizer:nhanh_nhat')}
                                            desc={t('preprocess.pageResizer:dung_lai_theo_anh_mat_vector_ra_rgb')}
                                        />
                                    </div>
                                </div>
                            )}
                        </>
                    );
                })()}
            </div>

        </div>
    );
}
