import { useState } from 'react';
import {
    ToolSectionLabel, ToolDivider, ToolCardOption,
    ToolCheckboxOption, ToolNumberInput, ToolInfo
} from './ToolUI';
import { useTranslation } from 'react-i18next';

const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500";

export type TrimUnit = 'mm' | 'cm' | 'pt' | 'inch';


const UNIT_OPTIONS: { id: TrimUnit; label: string }[] = [
    { id: 'mm', label: 'mm' },
    { id: 'cm', label: 'cm' },
    { id: 'pt', label: 'pt' },
    { id: 'inch', label: 'inch' },
];

export type ContentMode = 'original' | 'clip';

export type TrimSplitAxis = 'vertical' | 'horizontal';

export interface TrimSplitPieceMargins {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export interface TrimSplitSettings {
    enabled: boolean;
    axis: TrimSplitAxis;
    count: 2 | 3;
    pieces: TrimSplitPieceMargins[];
}

export interface TrimShiftSettings {
    unit: TrimUnit;
    sameAllEdges: boolean;
    trimTop: number;
    trimBottom: number;
    trimLeft: number;
    trimRight: number;
    shiftX: number;
    shiftY: number;
    bindingEnabled: boolean;
    bindingMm: number;
    bindingInward: boolean;
    creepEnabled: boolean;
    creepMm: number;
    creepAxis: 'x' | 'y';
    mirrorFill: boolean;
    contentMode: ContentMode;
    keepBleed: boolean;
    applyToStr: string;
    /** Chế độ tách trang ngay trong Trim & Shift để bình lại. */
    split: TrimSplitSettings;
}

interface Props {
    settings: TrimShiftSettings;
    onChange: (settings: TrimShiftSettings) => void;
}

export default function TrimShiftTool({ settings, onChange }: Props) {
  const { t } = useTranslation();

    const u = settings.unit || 'mm';
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const split = settings.split ?? {
        enabled: false,
        axis: 'vertical' as const,
        count: 2 as const,
        pieces: [],
    };
    const splitEnabled = split.enabled;
    const splitCount = split.count === 3 ? 3 : 2;
    const splitPieceValues = Array.isArray(split.pieces) ? split.pieces : [];
    const splitPieces = Array.from({ length: splitCount }, (_, index) => splitPieceValues[index] ?? ({
        top: 0, bottom: 0, left: 0, right: 0,
    }));

    const updateSplit = (patch: Partial<TrimSplitSettings>) => {
        onChange({
            ...settings,
            split: {
                ...split,
                ...patch,
                pieces: patch.pieces ?? splitPieces,
            },
        });
    };

    const setSplitPiece = (
        index: number,
        edge: keyof TrimSplitPieceMargins,
        value: number,
    ) => {
        const pieces = splitPieces.map((piece, pieceIndex) => (
            pieceIndex === index ? { ...piece, [edge]: Math.max(0, value) } : piece
        ));
        updateSplit({ pieces });
    };

    const splitPiecePosition = (index: number) => {
        if (split.axis === 'vertical') {
            if (index === 0) return t('preprocess.trimShift:ben_trai');
            if (index === splitCount - 1) return t('preprocess.trimShift:ben_phai');
        } else {
            if (index === 0) return t('preprocess.trimShift:ben_tren');
            if (index === splitCount - 1) return t('preprocess.trimShift:ben_duoi');
        }
        return t('preprocess.trimShift:ben_giua');
    };

    const handleApplyToChange = (val: string) => {
        onChange({ ...settings, applyToStr: val });
    };

    // Khi bật "đồng đều 4 cạnh": mọi ô trim dùng chung giá trị cạnh trên.
    const setEdge = (edge: 'trimTop' | 'trimBottom' | 'trimLeft' | 'trimRight', val: number) => {
        if (settings.sameAllEdges) {
            onChange({ ...settings, trimTop: val, trimBottom: val, trimLeft: val, trimRight: val });
        } else {
            onChange({ ...settings, [edge]: val });
        }
    };

    const toggleSameEdges = () => {
        const next = !settings.sameAllEdges;
        // Bật: đồng bộ cả 4 cạnh về giá trị cạnh trên để không nhảy giá trị bất ngờ.
        if (next) {
            onChange({ ...settings, sameAllEdges: true, trimBottom: settings.trimTop, trimLeft: settings.trimTop, trimRight: settings.trimTop });
        } else {
            onChange({ ...settings, sameAllEdges: false });
        }
    };

    // Đếm số tùy chọn nâng cao đang bật → hiện badge để người dùng biết có gì bên trong.
    const advancedActive =
        (settings.shiftX ? 1 : 0) + (settings.shiftY ? 1 : 0) +
        (settings.bindingEnabled ? 1 : 0) + (settings.creepEnabled ? 1 : 0) +
        (settings.mirrorFill ? 1 : 0) + (settings.contentMode === 'clip' ? 1 : 0) +
        (settings.keepBleed ? 1 : 0);

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">

            {/* Đơn vị */}
            <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">{t('preprocess.trimShift:don_vi')}</span>
                <div className="flex gap-1">
                    {UNIT_OPTIONS.map(opt => (
                        <button
                            key={opt.id}
                            onClick={() => onChange({ ...settings, unit: opt.id })}
                            className={`px-3 h-8 rounded text-[12.5px] font-semibold border transition-all
                                ${u === opt.id
                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                    : 'border-slate-200 dark:border-white/10 text-slate-500 hover:bg-slate-50 dark:hover:bg-zinc-800'}`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* UIUX (audit 2026-08-24 §TRIM.F1): hai workflow phải nằm trong
                cùng Trim & Shift để tách trang đã bình rồi bình lại. */}
            <div className="grid grid-cols-2 gap-2">
                <ToolCardOption
                    selected={!splitEnabled}
                    onClick={() => updateSplit({ enabled: false })}
                    label={t('preprocess.trimShift:che_do_chinh_le_doi')}
                    desc={t('preprocess.trimShift:che_do_chinh_le_doi_mo_ta')}
                />
                <ToolCardOption
                    selected={splitEnabled}
                    onClick={() => updateSplit({ enabled: true })}
                    label={t('preprocess.trimShift:che_do_tach_manh')}
                    desc={t('preprocess.trimShift:che_do_tach_manh_mo_ta')}
                />
            </div>

            {splitEnabled && (
                <div className="flex flex-col gap-3">
                    <ToolSectionLabel>{t('preprocess.trimShift:tao_manh_de_binh_lai')}</ToolSectionLabel>
                    <div className="grid grid-cols-2 gap-2">
                        <ToolCardOption
                            selected={split.axis === 'vertical'}
                            onClick={() => updateSplit({ axis: 'vertical' })}
                            label={t('preprocess.trimShift:cat_doc')}
                            desc={t('preprocess.trimShift:cat_doc_mo_ta')}
                        />
                        <ToolCardOption
                            selected={split.axis === 'horizontal'}
                            onClick={() => updateSplit({ axis: 'horizontal' })}
                            label={t('preprocess.trimShift:cat_ngang')}
                            desc={t('preprocess.trimShift:cat_ngang_mo_ta')}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <ToolCardOption selected={split.count === 2} onClick={() => updateSplit({ count: 2 })} label={t('preprocess.trimShift:hai_manh')} />
                        <ToolCardOption selected={split.count === 3} onClick={() => updateSplit({ count: 3 })} label={t('preprocess.trimShift:ba_manh')} />
                    </div>
                    <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 ml-1 leading-relaxed">
                        {t('preprocess.trimShift:le_trang_tung_manh_mo_ta')}
                    </div>
                    <div className="flex flex-col gap-3">
                        {splitPieces.map((piece, index) => (
                            <div key={index} className="p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                <div className="text-[12px] font-bold text-teal-700 dark:text-teal-300 mb-2">
                                    {t('preprocess.trimShift:manh_so_vi_tri', { number: index + 1, position: splitPiecePosition(index) })}
                                </div>
                                <div className="grid grid-cols-4 gap-2">
                                    <ToolNumberInput label={t('preprocess.trimShift:canh_tren')} value={piece.top} onChange={value => setSplitPiece(index, 'top', value)} step={0.1} min={0} />
                                    <ToolNumberInput label={t('preprocess.trimShift:canh_duoi')} value={piece.bottom} onChange={value => setSplitPiece(index, 'bottom', value)} step={0.1} min={0} />
                                    <ToolNumberInput label={t('preprocess.trimShift:canh_trai')} value={piece.left} onChange={value => setSplitPiece(index, 'left', value)} step={0.1} min={0} />
                                    <ToolNumberInput label={t('preprocess.trimShift:canh_phai')} value={piece.right} onChange={value => setSplitPiece(index, 'right', value)} step={0.1} min={0} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {!splitEnabled && (<>
            {/* ══ CƠ BẢN: Cắt xén / thêm lề từng cạnh ══ */}
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t('preprocess.trimShift:cat_xen_them_le_moi_canh')}</ToolSectionLabel>
                <ToolCheckboxOption
                    selected={settings.sameAllEdges}
                    onClick={toggleSameEdges}
                    label={t('preprocess.trimShift:dong_deu_ca_4_canh')}
                    desc={t('preprocess.trimShift:nhap_mot_lan_ap_cung_luong_cho_tren')}
                />
                <div className="grid grid-cols-2 gap-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                    <ToolNumberInput label={t('preprocess.trimShift:canh_tren')} value={settings.trimTop} onChange={val => setEdge('trimTop', val)} suffix={u} step={0.1} />
                    <ToolNumberInput label={t('preprocess.trimShift:canh_duoi')} value={settings.trimBottom} onChange={val => setEdge('trimBottom', val)} suffix={u} step={0.1} className={settings.sameAllEdges ? 'opacity-50 pointer-events-none' : ''} />
                    <ToolNumberInput label={t('preprocess.trimShift:canh_trai')} value={settings.trimLeft} onChange={val => setEdge('trimLeft', val)} suffix={u} step={0.1} className={settings.sameAllEdges ? 'opacity-50 pointer-events-none' : ''} />
                    <ToolNumberInput label={t('preprocess.trimShift:canh_phai')} value={settings.trimRight} onChange={val => setEdge('trimRight', val)} suffix={u} step={0.1} className={settings.sameAllEdges ? 'opacity-50 pointer-events-none' : ''} />
                </div>
                <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 mt-1 ml-1 leading-relaxed">{t('preprocess.trimShift:duong_them_khoang_trang_no_kho_am_cat')}</div>
            </div>

            <ToolDivider />
            </>)}

            {/* ══ Phạm vi trang nguồn: khi tách, chỉ các trang này được thay bằng mảnh mới ══ */}
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>{t(splitEnabled ? 'preprocess.trimShift:trang_nguon_can_tach' : 'preprocess.trimShift:ap_dung_cho')}</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-2">
                    <ToolCardOption selected={settings.applyToStr === 'all'} onClick={() => handleApplyToChange('all')} label={t(splitEnabled ? 'preprocess.trimShift:tat_ca_trang_nguon' : 'preprocess.trimShift:tat_ca_trang')} />
                    <ToolCardOption selected={settings.applyToStr === 'even'} onClick={() => handleApplyToChange('even')} label={t(splitEnabled ? 'preprocess.trimShift:trang_nguon_chan' : 'preprocess.trimShift:trang_chan')} />
                    <ToolCardOption selected={settings.applyToStr === 'odd'} onClick={() => handleApplyToChange('odd')} label={t(splitEnabled ? 'preprocess.trimShift:trang_nguon_le' : 'preprocess.trimShift:trang_le')} />
                    <ToolCardOption selected={!['all', 'even', 'odd'].includes(settings.applyToStr)} onClick={() => handleApplyToChange('custom')} label={t(splitEnabled ? 'preprocess.trimShift:chon_trang_nguon' : 'preprocess.trimShift:tuy_chinh')} />
                </div>

                {splitEnabled && (
                    <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 ml-1 leading-relaxed">
                        {t('preprocess.trimShift:trang_nguon_can_tach_mo_ta')}
                    </div>
                )}

                {!['all', 'even', 'odd'].includes(settings.applyToStr) && (
                    <div className="mt-3">
                        <input
                            type="text"
                            value={settings.applyToStr === 'custom' ? '' : settings.applyToStr}
                            onChange={e => handleApplyToChange(e.target.value)}
                            placeholder={splitEnabled ? t('preprocess.trimShift:vi_du_trang_nguon') : 'VD: 1, 3, 5-10'}
                            className={inputCls}
                        />
                        <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 mt-1.5 ml-1">{t('preprocess.trimShift:nhap_so_trang_cach_nhau_bang_dau_phay')}</div>
                    </div>
                )}
            </div>

            {!splitEnabled && (<>
                        {/* ══ NÂNG CAO (đóng sẵn) ══ */}
            <div className="border border-slate-200 dark:border-white/10 rounded-lg overflow-hidden">
                <button
                    onClick={() => setAdvancedOpen(v => !v)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
                >
                    <span className="flex items-center gap-2">
                        <span className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}>▸</span>
                        Tùy chọn nâng cao
                        {advancedActive > 0 && (
                            <span className="px-1.5 h-4 flex items-center rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300 text-[9.5px] font-bold">{advancedActive}</span>
                        )}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-normal">{t('preprocess.trimShift:doi_noi_dung_bu_gay_creep_bu_xen_noi')}</span>
                </button>

                {advancedOpen && (
                    <div className="p-3 flex flex-col gap-4 border-t border-slate-200 dark:border-white/10 bg-slate-50/40 dark:bg-zinc-900/40">

                        {/* Dời nội dung */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.trimShift:doi_noi_dung_shift')}</ToolSectionLabel>
                            <div className="grid grid-cols-2 gap-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                <ToolNumberInput label="Ngang (X)" value={settings.shiftX} onChange={val => onChange({ ...settings, shiftX: val })} suffix={u} step={0.1} />
                                <ToolNumberInput label={t('preprocess.trimShift:doc_y')} value={settings.shiftY} onChange={val => onChange({ ...settings, shiftY: val })} suffix={u} step={0.1} />
                            </div>
                            <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 mt-1 ml-1">{t('preprocess.trimShift:x_duong_dich_phai_y_duong_dich_len')}</div>
                        </div>

                        <ToolDivider />

                        {/* Bù lề gáy */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.trimShift:bu_le_gay_binding')}</ToolSectionLabel>
                            <ToolCheckboxOption
                                selected={settings.bindingEnabled}
                                onClick={() => onChange({ ...settings, bindingEnabled: !settings.bindingEnabled })}
                                label={t('preprocess.trimShift:doi_le_trong_ngoai_theo_trang_le_chan')}
                                desc={t('preprocess.trimShift:trang_le_va_chan_dich_nguoc_chieu_nhau')}
                            />
                            {settings.bindingEnabled && (
                                <div className="grid grid-cols-2 gap-3 mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                    <ToolNumberInput label={t('preprocess.trimShift:luong_bu')} value={settings.bindingMm} onChange={val => onChange({ ...settings, bindingMm: val })} suffix={u} step={0.1} min={0} />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.trimShift:huong')}</span>
                                        <div className="grid grid-cols-2 gap-1">
                                            <ToolCardOption selected={settings.bindingInward} onClick={() => onChange({ ...settings, bindingInward: true })} label={t('preprocess.trimShift:vao_gay')} />
                                            <ToolCardOption selected={!settings.bindingInward} onClick={() => onChange({ ...settings, bindingInward: false })} label={t('preprocess.trimShift:ra_ngoai')} />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <ToolDivider />

                        {/* Creep */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.trimShift:bu_gay_tang_dan_creep')}</ToolSectionLabel>
                            <ToolCheckboxOption
                                selected={settings.creepEnabled}
                                onClick={() => onChange({ ...settings, creepEnabled: !settings.creepEnabled })}
                                label={t('preprocess.trimShift:doi_noi_dung_tang_dan_theo_vi_tri_trang')}
                                desc={t('preprocess.trimShift:trang_dau_dich_0_tang_tuyen_tinh_toi')}
                            />
                            {settings.creepEnabled && (
                                <div className="grid grid-cols-2 gap-3 mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                    <ToolNumberInput label={t('preprocess.trimShift:luong_toi_da')} value={settings.creepMm} onChange={val => onChange({ ...settings, creepMm: val })} suffix={u} step={0.1} />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.trimShift:truc')}</span>
                                        <div className="grid grid-cols-2 gap-1">
                                            <ToolCardOption selected={settings.creepAxis === 'x'} onClick={() => onChange({ ...settings, creepAxis: 'x' })} label="Ngang" />
                                            <ToolCardOption selected={settings.creepAxis === 'y'} onClick={() => onChange({ ...settings, creepAxis: 'y' })} label={t('preprocess.trimShift:doc')} />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <ToolDivider />

                        {/* Bù xén phản chiếu */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.trimShift:bu_xen_phan_chieu_mirror_bleed')}</ToolSectionLabel>
                            <ToolCheckboxOption
                                selected={settings.mirrorFill}
                                onClick={() => onChange({ ...settings, mirrorFill: !settings.mirrorFill })}
                                label={t('preprocess.trimShift:lap_vung_le_moi_bang_noi_dung_lat_guong')}
                                desc={t('preprocess.trimShift:khi_them_le_gia_tri_duong_phan_trang')}
                            />
                        </div>

                        <ToolDivider />

                        {/* Nội dung ẩn khi nới khổ */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.trimShift:noi_dung_an_khi_noi_kho')}</ToolSectionLabel>
                            <div className="grid grid-cols-1 gap-2">
                                <ToolCheckboxOption
                                    selected={settings.contentMode === 'original'}
                                    onClick={() => onChange({ ...settings, contentMode: 'original' })}
                                    label={t('preprocess.trimShift:giu_nguyen_de_noi_dung_an_lo_ra')}
                                    desc={t('preprocess.trimShift:khi_noi_kho_phan_noi_dung_nam_ngoai')}
                                />
                                <ToolCheckboxOption
                                    selected={settings.contentMode === 'clip'}
                                    onClick={() => onChange({ ...settings, contentMode: 'clip' })}
                                    label={t('preprocess.trimShift:cat_sach_vung_moi_de_trang')}
                                    desc={t('preprocess.trimShift:cat_noi_dung_theo_vung_nhin_cu_phan_kho')}
                                />
                            </div>
                        </div>

                        <ToolDivider />

                        {/* Giữ lề bleed */}
                        <div className="flex flex-col gap-2">
                            <ToolCheckboxOption
                                selected={settings.keepBleed}
                                onClick={() => onChange({ ...settings, keepBleed: !settings.keepBleed })}
                                label={t('preprocess.trimShift:giu_nguyen_le_bleed_khi_cat')}
                                desc={t('preprocess.trimShift:khi_cat_noi_kho_trimbox_bleedbox_co')}
                            />
                        </div>
                    </div>
                )}
            </div>
            </>)}

            <ToolInfo desc={t(splitEnabled ? 'preprocess.trimShift:tach_info' : 'preprocess.trimShift:co_ban_chi_can_chon_luong_cat_them_le')} />
        </div>
    );
}
