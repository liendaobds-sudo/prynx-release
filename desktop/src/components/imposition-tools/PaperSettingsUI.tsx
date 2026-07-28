import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../Button';
import { useTranslation } from 'react-i18next';
import {
    formUsages,
    primaryClassificationFromUsages,
    type PaperUsage,
    type SavedForm,
} from './paperUtils';
import { HIDE_OFFSET_BOOKLET } from '../../lib/featureFocus';

export type { PaperUsage, SavedForm };
export { formUsages };

export function usePaperPresets(storageKey: string) {
    const [savedForms, setSavedForms] = useState<SavedForm[]>([]);

    useEffect(() => {
        try {
            const data = localStorage.getItem(storageKey);
            if (data) setSavedForms(JSON.parse(data));
        } catch (e) { }
    }, [storageKey]);

    const handleSavePreset = (name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh' = 'in_nhanh', gripperMargin: number = 0, usages: PaperUsage[] = ['in_nhanh']) => {
        const newPreset: SavedForm = {
            id: 'custom_' + Date.now(),
            name, w, h, marginTop: mT, marginBottom: mB, marginLeft: mL, marginRight: mR, marginMode: mode, classification, usages, gripperMargin
        };
        const newList = [...savedForms, newPreset];
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
        return newPreset.id;
    };

    const handleUpdatePreset = (id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh' = 'in_nhanh', gripperMargin: number = 0, usages: PaperUsage[] = ['in_nhanh']) => {
        const newList = savedForms.map(f => f.id === id ? { ...f, name, w, h, marginTop: mT, marginBottom: mB, marginLeft: mL, marginRight: mR, marginMode: mode, classification, usages, gripperMargin } : f);
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
    };

    const handleDeletePreset = (id: string) => {
        const newList = savedForms.filter(f => f.id !== id);
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
    };

    return { savedForms, handleSavePreset, handleUpdatePreset, handleDeletePreset };
}

export function PaperSettingsDialog({ 
    isOpen, onClose, 
    width, height, marginTop, marginBottom, marginLeft, marginRight, marginMode,
    classification, gripperMargin,
    onApply, savedForms, onSavePreset, onUpdatePreset, onDeletePreset, currentFormsize,
    /** Usages pre-tick khi tạo mới (theo tool: diecut/nup/…). */
    defaultUsages,
}: {
    isOpen: boolean;
    onClose: () => void;
    width: number; height: number;
    marginTop: number; marginBottom: number; marginLeft: number; marginRight: number;
    marginMode: 'labels_only' | 'include_marks';
    classification: 'offset' | 'in_nhanh';
    gripperMargin: number;
    onApply: (w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripperMargin: number, usages: PaperUsage[]) => void;
    savedForms: SavedForm[];
    onSavePreset: (name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripperMargin: number, usages: PaperUsage[]) => void;
    onUpdatePreset: (id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripperMargin: number, usages: PaperUsage[]) => void;
    onDeletePreset: (id: string) => void;
    currentFormsize: string;
    defaultUsages?: PaperUsage[];
}) {
  const { t } = useTranslation();
    const [presetName, setPresetName] = useState("");
    const [w, setW] = useState(width);
    const [h, setH] = useState(height);
    const [mT, setMT] = useState(marginTop);
    const [mB, setMB] = useState(marginBottom);
    const [mL, setML] = useState(marginLeft);
    const [mR, setMR] = useState(marginRight);
    const [mMode, setMMode] = useState(marginMode);
    const initialUsages = (): PaperUsage[] =>
        defaultUsages?.length
            ? [...defaultUsages]
            : (classification === 'offset' ? ['offset'] : ['in_nhanh']);
    const [usages, setUsages] = useState<PaperUsage[]>(initialUsages);
    const [gripper, setGripper] = useState(gripperMargin || 0);
    // UIUX (audit 2026-07-27 §B-04): lỗi inline đỏ khi W/H không hợp lệ lúc bấm Áp dụng/Lưu
    const [sizeError, setSizeError] = useState<string | null>(null);

    const primaryClassification = primaryClassificationFromUsages(usages);

    const toggleUsage = (u: PaperUsage) => {
        setUsages(prev => {
            const has = prev.includes(u);
            const next = has ? prev.filter(x => x !== u) : [...prev, u];
            if (u === 'offset' && has) setGripper(0);
            return next;
        });
    };

    const isEditing = currentFormsize.startsWith('custom_');

    useEffect(() => {
        if (isOpen) {
            setW(width); setH(height); setMT(marginTop); setMB(marginBottom); setML(marginLeft); setMR(marginRight); setMMode(marginMode);
            setGripper(gripperMargin || 0);
            setSizeError(null); // UIUX (audit 2026-07-27 §B-04)
            if (isEditing) {
                const f = savedForms.find(x => x.id === currentFormsize);
                if (f) {
                    setPresetName(f.name);
                    if (f.marginMode) setMMode(f.marginMode);
                    setUsages(formUsages(f));
                    if (f.gripperMargin !== undefined) setGripper(f.gripperMargin);
                } else {
                    setUsages(initialUsages());
                }
            } else {
                setPresetName("");
                // Tạo mới: tick theo tool context (diecut/nup/…), không luôn in_nhanh.
                setUsages(
                    defaultUsages?.length
                        ? [...defaultUsages]
                        : (classification === 'offset' ? ['offset'] : ['in_nhanh']),
                );
            }
        }
    }, [isOpen, width, height, marginTop, marginBottom, marginLeft, marginRight, marginMode, classification, gripperMargin, currentFormsize, savedForms, isEditing, defaultUsages]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isOpen && e.key === 'Escape') onClose();
        };
        if (isOpen) document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors";
    const labelCls = "block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5";

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
            <div className="relative bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-6 animate-in fade-in zoom-in-95 duration-200">
                
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                        {isEditing ? t('imposition.paperSettingsUI:cap_nhat_kho_giay') : t('imposition.paperSettingsUI:tuy_chinh_kho_giay')}
                    </h3>
                    <button onClick={onClose} className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>

                <div className="flex flex-col gap-5">
                    {/* Hàng 0: Mục đích sử dụng (đa lựa chọn) */}
                    <div className="flex gap-4 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-200 dark:border-white/10">
                        <div className="flex-1">
                            <label className={labelCls}>{t('imposition.paperSettingsUI:muc_dich_in_chon_nhieu')}</label>
                            <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2">
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input type="checkbox" checked={usages.includes('in_nhanh')} onChange={() => toggleUsage('in_nhanh')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                    <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">{t('imposition.paperSettingsUI:binh_sach_in_nhanh_digital')}</span>
                                </label>
                                {!HIDE_OFFSET_BOOKLET && (
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input type="checkbox" checked={usages.includes('offset')} onChange={() => toggleUsage('offset')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                    <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">{t('imposition.paperSettingsUI:binh_sach_in_offset')}</span>
                                </label>
                                )}
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input type="checkbox" checked={usages.includes('diecut')} onChange={() => toggleUsage('diecut')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                    <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">{t('imposition.paperSettingsUI:be_tem_die_cut')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input type="checkbox" checked={usages.includes('nup')} onChange={() => toggleUsage('nup')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                    <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">{t('imposition.paperSettingsUI:binh_bai_xen_n_up')}</span>
                                </label>
                            </div>
                            {usages.length === 0 && (
                                <p className="text-[11px] text-red-500 mt-2">{t('imposition.paperSettingsUI:chon_it_nhat_mot_muc_dich_in_de_luu')}</p>
                            )}
                        </div>
                    </div>

                    {/* Hàng 1: Tên khổ giấy */}
                    <div>
                        <label className={labelCls}>{t('imposition.paperSettingsUI:ten_kho_giay_label')} {isEditing ? '' : t('imposition.paperSettingsUI:de_trong_neu_khong_muon_luu_preset')}</label>
                        <input 
                            type="text" 
                            value={presetName} onChange={e => setPresetName(e.target.value)} 
                            placeholder={isEditing ? t('imposition.paperSettingsUI:nhap_ten_kho_giay') : t('imposition.paperSettingsUI:vd_decal_de_vang_32x43')}
                            className={inputCls}
                            autoFocus={!isEditing}
                        />
                    </div>

                    {/* Hàng 2: Kích thước */}
                    <div>
                        <h4 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 border-b border-slate-100 dark:border-zinc-700 pb-2 mb-3">{t('imposition.paperSettingsUI:kich_thuoc_kho_giay_mm')}</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:chieu_rong_w')}</label>
                                {/* UIUX (audit 2026-07-27 §B-02): suffix mm; §B-04: min 10 — khổ giấy 0 là vô nghĩa */}
                                <span className="relative block">
                                    <input type="number" step="0.5" min="10" value={w} onChange={e => { setW(Number(e.target.value)); setSizeError(null); }} className={inputCls + " pr-7"} />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                </span>
                            </div>
                            <div>
                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:chieu_cao_h')}</label>
                                {/* UIUX (audit 2026-07-27 §B-02): suffix mm; §B-04: min 10 — khổ giấy 0 là vô nghĩa */}
                                <span className="relative block">
                                    <input type="number" step="0.5" min="10" value={h} onChange={e => { setH(Number(e.target.value)); setSizeError(null); }} className={inputCls + " pr-7"} />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                </span>
                            </div>
                        </div>
                        {/* UIUX (audit 2026-07-27 §B-04): dòng đỏ inline khi Áp dụng với W/H không hợp lệ — không im lặng */}
                        {sizeError && (
                            <p className="text-[11px] text-red-600 dark:text-red-400 mt-2 leading-snug">{sizeError}</p>
                        )}
                    </div>

                    {/* Hàng 3: Vùng lề */}
                    <div>
                        <h4 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 border-b border-slate-100 dark:border-zinc-700 pb-2 mb-3">{t('imposition.paperSettingsUI:vung_an_toan_vung_in_le_mm')}</h4>
                        {usages.includes('offset') ? (
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:nhip_may_in_gripper')}</label>
                                    <input type="number" step="1" value={gripper} onChange={e => setGripper(Number(e.target.value))} className={inputCls} />
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:cac_le_con_lai_top_left_right')}</label>
                                    <input type="number" step="0.5" value={mT} onChange={e => {
                                        const v = Number(e.target.value);
                                        setMT(v); setML(v); setMR(v); setMB(v); // Store the same value across all margins as asked
                                    }} className={inputCls} />
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-4 gap-3">
                                {/* UIUX (audit 2026-07-27 §B-02): suffix mm cho 4 ô lề; §B-04: min 0 + clamp không âm */}
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:tren_top')}</label>
                                    <span className="relative block">
                                        <input type="number" step="0.5" min="0" value={mT} onChange={e => setMT(Math.max(0, Number(e.target.value) || 0))} className={inputCls + " pr-6"} />
                                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </span>
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:duoi_bottom')}</label>
                                    <span className="relative block">
                                        <input type="number" step="0.5" min="0" value={mB} onChange={e => setMB(Math.max(0, Number(e.target.value) || 0))} className={inputCls + " pr-6"} />
                                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </span>
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:trai_left')}</label>
                                    <span className="relative block">
                                        <input type="number" step="0.5" min="0" value={mL} onChange={e => setML(Math.max(0, Number(e.target.value) || 0))} className={inputCls + " pr-6"} />
                                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </span>
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.paperSettingsUI:phai_right')}</label>
                                    <span className="relative block">
                                        <input type="number" step="0.5" min="0" value={mR} onChange={e => setMR(Math.max(0, Number(e.target.value) || 0))} className={inputCls + " pr-6"} />
                                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>



                    {/* Hàng 4: Tùy chọn margin mode */}
                    <div className="bg-slate-50 dark:bg-zinc-800/50 rounded-lg p-4 border border-slate-200 dark:border-white/10 mt-1">
                        <label className="text-[11px] font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wide block mb-3">{t('imposition.paperSettingsUI:cach_tinh_le_margin_behavior')}</label>
                        <div className="flex flex-col gap-2.5">
                            <label className="flex items-center gap-2 cursor-pointer group">
                                <input type="radio" checked={mMode === 'labels_only'} onChange={() => setMMode('labels_only')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">{t('imposition.paperSettingsUI:le_chi_bao_vung_tem_dau_xen_se_ban_ra')}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer group">
                                <input type="radio" checked={mMode === 'include_marks'} onChange={() => setMMode('include_marks')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">{t('imposition.paperSettingsUI:le_bao_gom_ca_dau_xen_thu_hep_vung_xep')}</span>
                            </label>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-2 mt-4 pt-4 border-t border-slate-200 dark:border-white/10">
                    {isEditing && (
                        <button
                            onClick={() => onDeletePreset(currentFormsize)}
                            className="text-sm px-3 py-2 rounded text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors font-medium mr-auto"
                        >
                            {t('imposition.paperSettingsUI:xoa_preset')}
                        </button>
                    )}
                    
                    {!isEditing && <div className="flex-1" />}
                    
                    <Button variant="secondary" onClick={onClose}>{t('imposition.paperSettingsUI:huy')}</Button>
                    <Button 
                        variant="primary" 
                        disabled={usages.length === 0}
                        onClick={() => {
                            if (usages.length === 0) return;
                            // UIUX (audit 2026-07-27 §B-04): chặn Áp dụng/Lưu khi khổ giấy < 10mm — báo đỏ inline, không im lặng
                            if (!(Number(w) >= 10) || !(Number(h) >= 10)) {
                                setSizeError(t('imposition.paperSettingsUI:kho_giay_toi_thieu_10mm', 'Khổ giấy không hợp lệ — Chiều rộng và Chiều cao tối thiểu 10 mm.'));
                                return;
                            }
                            if (isEditing) {
                                onUpdatePreset(currentFormsize, presetName, w, h, mT, mB, mL, mR, mMode, primaryClassification, gripper, usages);
                            } else {
                                if (presetName.trim() !== '') {
                                    onSavePreset(presetName.trim(), w, h, mT, mB, mL, mR, mMode, primaryClassification, gripper, usages);
                                } else {
                                    onApply(w, h, mT, mB, mL, mR, mMode, primaryClassification, gripper, usages); // Just apply without saving preset
                                }
                            }
                            onClose(); 
                        }}
                    >
                        {isEditing ? t('imposition.paperSettingsUI:luu') : (presetName.trim() ? t('imposition.paperSettingsUI:luu_kho_giay_moi') : t('imposition.paperSettingsUI:ap_dung'))}
                    </Button>
                </div>
            </div>
        </div>,
        document.body
    );
}

