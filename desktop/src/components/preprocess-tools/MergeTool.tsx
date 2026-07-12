import React, { useRef, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { 
    ToolSectionLabel, ToolDivider, ToolCheckboxOption, 
    ToolNumberInput, ToolInfo 
} from './ToolUI';
import { useTranslation } from 'react-i18next';

const inputCls = "w-full h-8 px-2.5 text-[12px] border border-slate-300 dark:border-white/20 rounded-md bg-white dark:bg-zinc-900 font-medium focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 transition-all";

export type MergeMode = 'merge_files' | 'interleave' | 'insert_pages';

export interface MergeSettings {
    mode: MergeMode;
    spawnNewTab?: boolean;
    // merge_files
    filesToMerge: File[];
    
    // interleave
    oddFile: File | null;
    evenFile: File | null;
    
    // insert_pages
    insertFile: File | null;
    insertWhat: 'entire' | 'range';
    insertRangeFrom: number;
    insertRangeTo: number;
    
    useIntervals: boolean;
    startInserting: 'before_first' | 'after_page';
    afterPageNum: number;
    skipPages: number;
    repeatMode: 'entire' | 'pages';
    insertPagesEachTime: number;
    whenFinished: 'start_again' | 'stop';
}

export const defaultMergeSettings: MergeSettings = {
    mode: 'merge_files',
    filesToMerge: [],
    oddFile: null,
    evenFile: null,
    insertFile: null,
    insertWhat: 'entire',
    insertRangeFrom: 1,
    insertRangeTo: 1,
    useIntervals: false,
    startInserting: 'after_page',
    afterPageNum: 1,
    skipPages: 1,
    repeatMode: 'pages',
    insertPagesEachTime: 1,
    whenFinished: 'stop',
};

interface Props {
    settings: MergeSettings;
    onChange: (settings: MergeSettings) => void;
}

export default function MergeTool({ settings, onChange }: Props) {
  const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const oddInputRef = useRef<HTMLInputElement>(null);
    const evenInputRef = useRef<HTMLInputElement>(null);
    const insertInputRef = useRef<HTMLInputElement>(null);

    const handleFilesAdded = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const newFiles = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
            onChange({ ...settings, filesToMerge: [...settings.filesToMerge, ...newFiles] });
        }
    };

    const removeFile = (index: number) => {
        const newFiles = [...settings.filesToMerge];
        newFiles.splice(index, 1);
        onChange({ ...settings, filesToMerge: newFiles });
    };

    const moveFile = (index: number, direction: 'up' | 'down') => {
        if (direction === 'up' && index > 0) {
            const newFiles = [...settings.filesToMerge];
            const temp = newFiles[index - 1];
            newFiles[index - 1] = newFiles[index];
            newFiles[index] = temp;
            onChange({ ...settings, filesToMerge: newFiles });
        } else if (direction === 'down' && index < settings.filesToMerge.length - 1) {
            const newFiles = [...settings.filesToMerge];
            const temp = newFiles[index + 1];
            newFiles[index + 1] = newFiles[index];
            newFiles[index] = temp;
            onChange({ ...settings, filesToMerge: newFiles });
        }
    };

    const handleSingleFileSelect = (key: 'oddFile' | 'evenFile' | 'insertFile', e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            onChange({ ...settings, [key]: e.target.files[0] });
        }
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">
            
            {/* Tabs */}
            <div className="flex bg-slate-100 dark:bg-zinc-800/50 p-1 rounded-lg border border-slate-200 dark:border-white/5">
                {[
                    { id: 'merge_files', label: t('preprocess.merge:ghep_noi_tiep') },
                    { id: 'interleave', label: t('preprocess.merge:tron_xen_ke') },
                    { id: 'insert_pages', label: t('preprocess.merge:chen_trang') }
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => onChange({ ...settings, mode: tab.id as MergeMode })}
                        className={`flex-1 text-[11px] font-bold py-1.5 rounded-md transition-all ${
                            settings.mode === tab.id 
                            ? 'bg-white dark:bg-zinc-700 text-teal-600 dark:text-teal-400 shadow-sm' 
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300'
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            <div className="min-h-[140px]">
                {/* 1. GHÉP NỐI TIẾP */}
                {settings.mode === 'merge_files' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-2">
                        <ToolSectionLabel>{t('preprocess.merge:danh_sach_file_can_ghep')}</ToolSectionLabel>
                        <div className="border border-slate-300 dark:border-white/10 rounded-lg p-2 min-h-[100px] flex flex-col gap-1 bg-white dark:bg-zinc-900/50">
                            {settings.filesToMerge.length === 0 ? (
                                <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">
                                    {t('preprocess.merge:chua_chon_file_nao_bam_nut_ben_duoi_de')}
                                </div>
                            ) : (
                                settings.filesToMerge.map((f, i) => (
                                    <div key={i} className="flex items-center gap-2 bg-slate-50 dark:bg-zinc-800 p-1.5 rounded border border-slate-200 dark:border-white/5 group">
                                        <div className="flex flex-col gap-0">
                                            <button onClick={() => moveFile(i, 'up')} disabled={i === 0} className="text-slate-400 hover:text-blue-500 disabled:opacity-30 leading-none"><ChevronUp className="w-3.5 h-3.5" /></button>
                                            <button onClick={() => moveFile(i, 'down')} disabled={i === settings.filesToMerge.length - 1} className="text-slate-400 hover:text-blue-500 disabled:opacity-30 leading-none"><ChevronDown className="w-3.5 h-3.5" /></button>
                                        </div>
                                        <div className="flex-1 text-[11px] font-medium text-slate-700 dark:text-zinc-200 truncate" title={f.name}>
                                            {f.name}
                                        </div>
                                        <button onClick={() => removeFile(i)} className="text-red-400 hover:text-red-600 px-1 opacity-0 group-hover:opacity-100 transition-opacity" title={t('preprocess.merge:xoa')} aria-label={t('preprocess.merge:xoa_file')}><X className="w-3.5 h-3.5" /></button>
                                    </div>
                                ))
                            )}
                        </div>
                        <input type="file" multiple accept=".pdf,image/png,image/jpeg,image/jpg" ref={fileInputRef} className="hidden" onChange={handleFilesAdded} />
                        <button onClick={() => fileInputRef.current?.click()} className="mt-1 w-full py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-200 dark:border-white/10 rounded-lg text-[11px] font-bold text-slate-600 dark:text-zinc-300 transition-colors">
                            {t('preprocess.merge:them_file_pdf_anh')}
                        </button>
                    </div>
                )}

                {/* 2. TRỘN XEN KẼ */}
                {settings.mode === 'interleave' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.merge:nguon_trang_le_odds_from')}</ToolSectionLabel>
                            <input type="file" accept=".pdf,image/png,image/jpeg,image/jpg" ref={oddInputRef} className="hidden" onChange={(e) => handleSingleFileSelect('oddFile', e)} />
                            <div className="flex items-center gap-2">
                                <button onClick={() => oddInputRef.current?.click()} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-slate-300 dark:border-white/10 rounded text-[11px] font-semibold text-slate-600 dark:text-zinc-300 whitespace-nowrap">{t('preprocess.merge:chon_file')}</button>
                                <span className="text-[11px] text-slate-600 dark:text-zinc-400 truncate flex-1">{settings.oddFile ? settings.oddFile.name : t('preprocess.merge:chua_chon_file')}</span>
                            </div>
                        </div>
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.merge:nguon_trang_chan_evens_from')}</ToolSectionLabel>
                            <input type="file" accept=".pdf,image/png,image/jpeg,image/jpg" ref={evenInputRef} className="hidden" onChange={(e) => handleSingleFileSelect('evenFile', e)} />
                            <div className="flex items-center gap-2">
                                <button onClick={() => evenInputRef.current?.click()} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-slate-300 dark:border-white/10 rounded text-[11px] font-semibold text-slate-600 dark:text-zinc-300 whitespace-nowrap">{t('preprocess.merge:chon_file')}</button>
                                <span className="text-[11px] text-slate-600 dark:text-zinc-400 truncate flex-1">{settings.evenFile ? settings.evenFile.name : t('preprocess.merge:chua_chon_file')}</span>
                            </div>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 italic">
                            {t('preprocess.merge:he_thong_se_lay_lan_luot_1_trang_tu')}
                        </div>
                    </div>
                )}

                {/* 3. CHÈN TRANG */}
                {settings.mode === 'insert_pages' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.merge:chen_tu_file_insert_from')}</ToolSectionLabel>
                            <input type="file" accept=".pdf,image/png,image/jpeg,image/jpg" ref={insertInputRef} className="hidden" onChange={(e) => handleSingleFileSelect('insertFile', e)} />
                            <div className="flex items-center gap-2">
                                <button onClick={() => insertInputRef.current?.click()} className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/40 border border-blue-200 dark:border-blue-800 rounded text-[11px] font-bold text-blue-600 dark:text-blue-400 whitespace-nowrap">{t('preprocess.merge:chon_file_pdf_anh')}</button>
                                <span className="text-[11px] text-slate-700 dark:text-zinc-300 font-medium truncate flex-1">{settings.insertFile ? settings.insertFile.name : t('preprocess.merge:chua_chon_file')}</span>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2 bg-slate-50 dark:bg-zinc-800/50 p-3 rounded-lg border border-slate-200 dark:border-white/5">
                            <ToolSectionLabel>{t('preprocess.merge:dai_trang_can_lay')}</ToolSectionLabel>
                            <div className="flex flex-col gap-2 mt-1">
                                <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                    <input type="radio" checked={settings.insertWhat === 'entire'} onChange={() => onChange({ ...settings, insertWhat: 'entire' })} className="text-teal-500 focus:ring-teal-500" />
                                    {t('preprocess.merge:toan_bo_tai_lieu_entire_document')}
                                </label>
                                <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                    <input type="radio" checked={settings.insertWhat === 'range'} onChange={() => onChange({ ...settings, insertWhat: 'range' })} className="text-teal-500 focus:ring-teal-500" />
                                    {t('preprocess.merge:tu_trang_from')} 
                                    <input type="number" min={1} value={settings.insertRangeFrom} onChange={e => onChange({ ...settings, insertRangeFrom: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.insertWhat !== 'range'} />
                                    {t('preprocess.merge:den')}
                                    <input type="number" min={1} value={settings.insertRangeTo} onChange={e => onChange({ ...settings, insertRangeTo: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.insertWhat !== 'range'} />
                                </label>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <label className="flex items-center gap-2 text-[12px] font-bold text-slate-800 dark:text-zinc-200">
                                <input type="checkbox" checked={settings.useIntervals} onChange={e => onChange({ ...settings, useIntervals: e.target.checked })} className="w-4 h-4 rounded text-teal-500 focus:ring-teal-500" />
                                {t('preprocess.merge:insert_at_intervals_chen_lap_lai_chu_ky')}
                            </label>

                            {settings.useIntervals && (
                                <div className="ml-6 flex flex-col gap-3 mt-1 animate-in fade-in slide-in-from-left-2">
                                    <div className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                        {t('preprocess.merge:vi_tri_bat_dau')}
                                        <label className="flex items-center gap-1"><input type="radio" checked={settings.startInserting === 'before_first'} onChange={() => onChange({ ...settings, startInserting: 'before_first' })} /> {t('preprocess.merge:truoc_trang_1')}</label>
                                        <label className="flex items-center gap-1"><input type="radio" checked={settings.startInserting === 'after_page'} onChange={() => onChange({ ...settings, startInserting: 'after_page' })} /> Sau trang</label>
                                        <input type="number" min={1} value={settings.afterPageNum} onChange={e => onChange({ ...settings, afterPageNum: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.startInserting !== 'after_page'} />
                                    </div>
                                    
                                    <div className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                        {t('preprocess.merge:sau_khi_chen_bo_qua')}
                                        <input type="number" min={1} value={settings.skipPages} onChange={e => onChange({ ...settings, skipPages: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" />
                                        {t('preprocess.merge:trang_va_lap_lai')}
                                    </div>

                                    <div className="flex flex-col gap-2 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 p-2 rounded">
                                        <div className="text-[10px] font-semibold text-slate-500 uppercase">{t('preprocess.merge:cach_lap_lai_how_to_repeat')}</div>
                                        <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                            <input type="radio" checked={settings.repeatMode === 'entire'} onChange={() => onChange({ ...settings, repeatMode: 'entire' })} />
                                            {t('preprocess.merge:chen_toan_bo_khoi_trang_moi_lan')}
                                        </label>
                                        <div className="flex flex-col gap-1">
                                            <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                                <input type="radio" checked={settings.repeatMode === 'pages'} onChange={() => onChange({ ...settings, repeatMode: 'pages' })} />
                                                {t('preprocess.merge:chi_chen')}
                                                <input type="number" min={1} value={settings.insertPagesEachTime} onChange={e => onChange({ ...settings, insertPagesEachTime: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.repeatMode !== 'pages'} />
                                                {t('preprocess.merge:trang_moi_lan_sau_do')}
                                            </label>
                                            <div className="ml-6 flex flex-col gap-1">
                                                <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-400">
                                                    <input type="radio" checked={settings.whenFinished === 'start_again'} onChange={() => onChange({ ...settings, whenFinished: 'start_again' })} disabled={settings.repeatMode !== 'pages'} />
                                                    {t('preprocess.merge:khi_chen_het_nguon_quay_lai_dau_nguon')}
                                                </label>
                                                <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-400">
                                                    <input type="radio" checked={settings.whenFinished === 'stop'} onChange={() => onChange({ ...settings, whenFinished: 'stop' })} disabled={settings.repeatMode !== 'pages'} />
                                                    {t('preprocess.merge:khi_chen_het_nguon_thi_dung_lai')}
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
            
            <ToolInfo desc={
                <><strong>{t('preprocess.merge:ghi_chu')}</strong> {t('preprocess.merge:tac_vu_nay_se_tu_dong_xu_ly_va_tao_ra')}</>
            } />
        </div>
    );
}
