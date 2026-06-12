import React, { useRef, useState } from 'react';
import { 
    ToolSectionLabel, ToolDivider, ToolCheckboxOption, 
    ToolNumberInput, ToolInfo 
} from './ToolUI';

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
                    { id: 'merge_files', label: 'Ghép nối tiếp' },
                    { id: 'interleave', label: 'Trộn xen kẽ' },
                    { id: 'insert_pages', label: 'Chèn trang' }
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
                        <ToolSectionLabel>Danh sách file cần ghép</ToolSectionLabel>
                        <div className="border border-slate-300 dark:border-white/10 rounded-lg p-2 min-h-[100px] flex flex-col gap-1 bg-white dark:bg-zinc-900/50">
                            {settings.filesToMerge.length === 0 ? (
                                <div className="flex-1 flex items-center justify-center text-[11px] text-slate-400">
                                    Chưa chọn file nào. Bấm nút bên dưới để thêm.
                                </div>
                            ) : (
                                settings.filesToMerge.map((f, i) => (
                                    <div key={i} className="flex items-center gap-2 bg-slate-50 dark:bg-zinc-800 p-1.5 rounded border border-slate-200 dark:border-white/5 group">
                                        <div className="flex flex-col gap-0">
                                            <button onClick={() => moveFile(i, 'up')} disabled={i === 0} className="text-slate-400 hover:text-blue-500 disabled:opacity-30 leading-none">▲</button>
                                            <button onClick={() => moveFile(i, 'down')} disabled={i === settings.filesToMerge.length - 1} className="text-slate-400 hover:text-blue-500 disabled:opacity-30 leading-none">▼</button>
                                        </div>
                                        <div className="flex-1 text-[11px] font-medium text-slate-700 dark:text-zinc-200 truncate" title={f.name}>
                                            {f.name}
                                        </div>
                                        <button onClick={() => removeFile(i)} className="text-red-400 hover:text-red-600 px-1 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                                    </div>
                                ))
                            )}
                        </div>
                        <input type="file" multiple accept=".pdf,image/png,image/jpeg,image/jpg" ref={fileInputRef} className="hidden" onChange={handleFilesAdded} />
                        <button onClick={() => fileInputRef.current?.click()} className="mt-1 w-full py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-200 dark:border-white/10 rounded-lg text-[11px] font-bold text-slate-600 dark:text-zinc-300 transition-colors">
                            + Thêm file PDF/Ảnh
                        </button>
                    </div>
                )}

                {/* 2. TRỘN XEN KẼ */}
                {settings.mode === 'interleave' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Nguồn Trang Lẻ (Odds from)</ToolSectionLabel>
                            <input type="file" accept=".pdf,image/png,image/jpeg,image/jpg" ref={oddInputRef} className="hidden" onChange={(e) => handleSingleFileSelect('oddFile', e)} />
                            <div className="flex items-center gap-2">
                                <button onClick={() => oddInputRef.current?.click()} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-slate-300 dark:border-white/10 rounded text-[11px] font-semibold text-slate-600 dark:text-zinc-300 whitespace-nowrap">Chọn File</button>
                                <span className="text-[11px] text-slate-600 dark:text-zinc-400 truncate flex-1">{settings.oddFile ? settings.oddFile.name : 'Chưa chọn file...'}</span>
                            </div>
                        </div>
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Nguồn Trang Chẵn (Evens from)</ToolSectionLabel>
                            <input type="file" accept=".pdf,image/png,image/jpeg,image/jpg" ref={evenInputRef} className="hidden" onChange={(e) => handleSingleFileSelect('evenFile', e)} />
                            <div className="flex items-center gap-2">
                                <button onClick={() => evenInputRef.current?.click()} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-slate-300 dark:border-white/10 rounded text-[11px] font-semibold text-slate-600 dark:text-zinc-300 whitespace-nowrap">Chọn File</button>
                                <span className="text-[11px] text-slate-600 dark:text-zinc-400 truncate flex-1">{settings.evenFile ? settings.evenFile.name : 'Chưa chọn file...'}</span>
                            </div>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 italic">
                            Hệ thống sẽ lấy lần lượt 1 trang từ nguồn Trang Lẻ, rồi 1 trang từ nguồn Trang Chẵn ghép lại thành 1 file duy nhất.
                        </div>
                    </div>
                )}

                {/* 3. CHÈN TRANG */}
                {settings.mode === 'insert_pages' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-4">
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Chèn từ File (Insert from)</ToolSectionLabel>
                            <input type="file" accept=".pdf,image/png,image/jpeg,image/jpg" ref={insertInputRef} className="hidden" onChange={(e) => handleSingleFileSelect('insertFile', e)} />
                            <div className="flex items-center gap-2">
                                <button onClick={() => insertInputRef.current?.click()} className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/40 border border-blue-200 dark:border-blue-800 rounded text-[11px] font-bold text-blue-600 dark:text-blue-400 whitespace-nowrap">Chọn File PDF/Ảnh</button>
                                <span className="text-[11px] text-slate-700 dark:text-zinc-300 font-medium truncate flex-1">{settings.insertFile ? settings.insertFile.name : 'Chưa chọn file...'}</span>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2 bg-slate-50 dark:bg-zinc-800/50 p-3 rounded-lg border border-slate-200 dark:border-white/5">
                            <ToolSectionLabel>Dải trang cần lấy</ToolSectionLabel>
                            <div className="flex flex-col gap-2 mt-1">
                                <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                    <input type="radio" checked={settings.insertWhat === 'entire'} onChange={() => onChange({ ...settings, insertWhat: 'entire' })} className="text-teal-500 focus:ring-teal-500" />
                                    Toàn bộ tài liệu (Entire document)
                                </label>
                                <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                    <input type="radio" checked={settings.insertWhat === 'range'} onChange={() => onChange({ ...settings, insertWhat: 'range' })} className="text-teal-500 focus:ring-teal-500" />
                                    Từ trang (From) 
                                    <input type="number" min={1} value={settings.insertRangeFrom} onChange={e => onChange({ ...settings, insertRangeFrom: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.insertWhat !== 'range'} />
                                    đến
                                    <input type="number" min={1} value={settings.insertRangeTo} onChange={e => onChange({ ...settings, insertRangeTo: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.insertWhat !== 'range'} />
                                </label>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <label className="flex items-center gap-2 text-[12px] font-bold text-slate-800 dark:text-zinc-200">
                                <input type="checkbox" checked={settings.useIntervals} onChange={e => onChange({ ...settings, useIntervals: e.target.checked })} className="w-4 h-4 rounded text-teal-500 focus:ring-teal-500" />
                                Insert at intervals (Chèn lặp lại chu kỳ)
                            </label>

                            {settings.useIntervals && (
                                <div className="ml-6 flex flex-col gap-3 mt-1 animate-in fade-in slide-in-from-left-2">
                                    <div className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                        Vị trí bắt đầu:
                                        <label className="flex items-center gap-1"><input type="radio" checked={settings.startInserting === 'before_first'} onChange={() => onChange({ ...settings, startInserting: 'before_first' })} /> Trước trang 1</label>
                                        <label className="flex items-center gap-1"><input type="radio" checked={settings.startInserting === 'after_page'} onChange={() => onChange({ ...settings, startInserting: 'after_page' })} /> Sau trang</label>
                                        <input type="number" min={1} value={settings.afterPageNum} onChange={e => onChange({ ...settings, afterPageNum: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.startInserting !== 'after_page'} />
                                    </div>
                                    
                                    <div className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                        Sau khi chèn, bỏ qua
                                        <input type="number" min={1} value={settings.skipPages} onChange={e => onChange({ ...settings, skipPages: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" />
                                        trang và lặp lại
                                    </div>

                                    <div className="flex flex-col gap-2 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 p-2 rounded">
                                        <div className="text-[10px] font-semibold text-slate-500 uppercase">Cách lặp lại (How to repeat)</div>
                                        <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                            <input type="radio" checked={settings.repeatMode === 'entire'} onChange={() => onChange({ ...settings, repeatMode: 'entire' })} />
                                            Chèn toàn bộ khối trang mỗi lần
                                        </label>
                                        <div className="flex flex-col gap-1">
                                            <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-zinc-300">
                                                <input type="radio" checked={settings.repeatMode === 'pages'} onChange={() => onChange({ ...settings, repeatMode: 'pages' })} />
                                                Chỉ chèn
                                                <input type="number" min={1} value={settings.insertPagesEachTime} onChange={e => onChange({ ...settings, insertPagesEachTime: parseInt(e.target.value)||1 })} className="w-12 h-6 px-1 border border-slate-300 rounded text-center" disabled={settings.repeatMode !== 'pages'} />
                                                trang mỗi lần, sau đó...
                                            </label>
                                            <div className="ml-6 flex flex-col gap-1">
                                                <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-400">
                                                    <input type="radio" checked={settings.whenFinished === 'start_again'} onChange={() => onChange({ ...settings, whenFinished: 'start_again' })} disabled={settings.repeatMode !== 'pages'} />
                                                    Khi chèn hết nguồn, quay lại đầu nguồn
                                                </label>
                                                <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-400">
                                                    <input type="radio" checked={settings.whenFinished === 'stop'} onChange={() => onChange({ ...settings, whenFinished: 'stop' })} disabled={settings.repeatMode !== 'pages'} />
                                                    Khi chèn hết nguồn thì dừng lại
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
                <><strong>Ghi chú:</strong> Tác vụ này sẽ tự động xử lý và tạo ra một file PDF mới chứa kết quả, giữ nguyên các file gốc không thay đổi.</>
            } />
        </div>
    );
}
