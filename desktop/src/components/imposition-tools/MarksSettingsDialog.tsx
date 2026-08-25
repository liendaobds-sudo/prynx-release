import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../Button';
import { useTranslation } from 'react-i18next';
import { DEFAULT_MARKS_CONFIG, type CropMarksConfig } from './marksConfig';

export type { CropMarksConfig } from './marksConfig';

interface MarksSettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    config: CropMarksConfig;
    onSave: (cfg: CropMarksConfig) => void;
}

function MarksSettingsDialogContent({ isOpen, onClose, config, onSave }: MarksSettingsDialogProps) {
  const { t } = useTranslation();
    const [localCfg, setLocalCfg] = useState<CropMarksConfig>(config);


    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isOpen && e.key === 'Escape') onClose();
        };
        if (isOpen) document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors";

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
            <div className="relative bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-6 animate-in fade-in zoom-in-95 duration-200">
                
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                        {t('imposition.marksSettingsDialog:tuy_chinh_dau_xen')}
                    </h3>
                    <button onClick={onClose} className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>

                {/* Style */}
                <div className="space-y-3">
                    <h4 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 border-b border-slate-100 dark:border-zinc-700 pb-2">{t('imposition.marksSettingsDialog:kieu_dau_xen')}</h4>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { val: 1, label: t('imposition.marksSettingsDialog:tieu_chuan'), desc: t('imposition.marksSettingsDialog:net_don_o_goc_western') },
                            { val: 2, label: t('imposition.marksSettingsDialog:net_doi_nhat'), desc: 'Trim + Bleed (トンボ)' },
                        ].map(opt => (
                            <button
                                key={opt.val}
                                type="button"
                                onClick={() => setLocalCfg(c => ({ ...c, style: opt.val }))}
                                className={`flex flex-col items-start gap-0.5 px-3 py-2 rounded border text-left transition-colors ${
                                    localCfg.style === opt.val
                                        ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30'
                                        : 'border-slate-200 dark:border-white/15 hover:border-slate-300 dark:hover:border-white/30'
                                }`}
                            >
                                <span className="text-sm font-semibold text-slate-800 dark:text-zinc-200">{opt.label}</span>
                                <span className="text-[10px] text-slate-500">{opt.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Dimensions */}
                <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 border-b border-slate-100 dark:border-zinc-700 pb-2">{t('imposition.marksSettingsDialog:kich_thuoc_dau_xen_mm')}</h4>
                    <div className="grid grid-cols-3 gap-3">
                        <div>
                            <label className="text-[11px] text-slate-500 block mb-1">{t('imposition.marksSettingsDialog:khoang_cach_toi_tem')}</label>
                            <input type="number" step="0.1" value={localCfg.distance} onChange={e => setLocalCfg(c => ({...c, distance: Number(e.target.value)}))} className={inputCls} />
                        </div>
                        <div>
                            <label className="text-[11px] text-slate-500 block mb-1">{t('imposition.marksSettingsDialog:do_dai')}</label>
                            <input type="number" step="0.1" value={localCfg.length} onChange={e => setLocalCfg(c => ({...c, length: Number(e.target.value)}))} className={inputCls} />
                        </div>
                        <div>
                            <label className="text-[11px] text-slate-500 block mb-1">{t('imposition.marksSettingsDialog:do_day_net')}</label>
                            <input type="number" step="0.01" value={localCfg.thickness} onChange={e => setLocalCfg(c => ({...c, thickness: Number(e.target.value)}))} className={inputCls} />
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center gap-2 mt-2 pt-4 border-t border-slate-200 dark:border-white/10">
                    <button
                        type="button"
                        onClick={() => setLocalCfg(DEFAULT_MARKS_CONFIG)}
                        className="text-sm px-3 py-2 rounded text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors font-medium mr-auto"
                    >
                        {t('imposition.marksSettingsDialog:khoi_phuc_mac_dinh')}
                    </button>

                    <Button variant="secondary" onClick={onClose}>{t('imposition.marksSettingsDialog:huy')}</Button>
                    <Button 
                        variant="primary" 
                        onClick={() => { 
                            onSave(localCfg); 
                            onClose(); 
                        }}
                    >
                        {t('imposition.marksSettingsDialog:ap_dung')}
                    </Button>
                </div>
            </div>
        </div>,
        document.body
    );
};


export const MarksSettingsDialog = (props: MarksSettingsDialogProps) => {
    if (!props.isOpen) return null;
    return <MarksSettingsDialogContent key={JSON.stringify(props.config)} {...props} />;
};
