// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { PontConfig } from './types';

export const DEFAULT_PONT_CONFIG: PontConfig = {
    shape: 'circle',
    size: 5.0,
    thickness: 0.5,
    isGraphtec: false,
    layerInfoName: 'SA info 0 0 0 17.01 2 -16777216 -16777216 1 1 0',
    layerName: 'Marks_Model_',
    groupName: 'MarkLine',
    itemName: 'MKLINE',
    marginTop: 7,
    marginBottom: 7,
    marginLeft: 7,
    marginRight: 7,
    guide1Enabled: false,
    guide1Pos: 'BL',
    guide1Length: 20,
    guide1Thickness: 0.5,
    guide1OffX: 0,
    guide1OffY: 0,
    guide2Enabled: false,
    guide2Pos: 'BR',
    guide2Length: 20,
    guide2Thickness: 0.5,
    guide2OffX: 0,
    guide2OffY: 0,
    disableCollision: false
};

interface Preset {
    name: string;
    config: PontConfig;
}

export const PontSettingsDialog = ({
    isOpen,
    onClose,
    config,
    onSave
}: {
    isOpen: boolean;
    onClose: () => void;
    config: PontConfig;
    onSave: (cfg: PontConfig) => void;
}) => {
    const [localCfg, setLocalCfg] = useState<PontConfig>(config);
    const [presetName, setPresetName] = useState('');
    const [presets, setPresets] = useState<Preset[]>([]);

    useEffect(() => {
        if (isOpen) {
            setLocalCfg(config);
            const savedPresets = localStorage.getItem('ps_pont_presets');
            if (savedPresets) {
                try {
                    setPresets(JSON.parse(savedPresets));
                } catch (e) {}
            }
        }
    }, [isOpen, config]);

    const savePreset = () => {
        if (!presetName.trim()) {
            alert('Vui lòng nhập tên mẫu trước khi lưu!');
            return;
        }
        const newPresets = [...presets.filter(p => p.name !== presetName.trim()), { name: presetName.trim(), config: localCfg }];
        setPresets(newPresets);
        localStorage.setItem('ps_pont_presets', JSON.stringify(newPresets));
        alert('Đã lưu mẫu cấu hình "' + presetName.trim() + '" thành công!');
    };

    const loadPreset = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const val = e.target.value;
        if (!val) return;
        const p = presets.find(x => x.name === val);
        if (p) {
            setLocalCfg(p.config);
            setPresetName(p.name);
        }
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isOpen && e.key === 'Escape') onClose();
        };
        if (isOpen) document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;
    
    const updateLocal = (key: keyof PontConfig, val: any) => {
        setLocalCfg((prev: PontConfig) => ({ ...prev, [key]: val }));
    };

    const getGuideLabelX = (pos: string) => pos.includes('L') ? 'Cách mép Trái (X)' : 'Cách mép Phải (X)';
    const getGuideLabelY = (pos: string) => pos.includes('T') ? 'Cách mép Trên (Y)' : 'Cách mép Dưới (Y)';

    const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-zinc-900/50 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all text-slate-900 dark:text-zinc-200 placeholder:text-slate-400 dark:placeholder:text-zinc-500";
    const selectCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/10 rounded bg-white dark:bg-zinc-900/50 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all cursor-pointer text-slate-900 dark:text-zinc-200";
    const labelCls = "block text-[11px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-1";
    const sectionCls = "p-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-zinc-800/30 space-y-4 shadow-sm";
    const sectionTitleCls = "text-sm font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2 mb-3";

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <div className="absolute inset-0 bg-slate-900/40 dark:bg-zinc-900/60 backdrop-blur-md transition-opacity duration-300" onClick={onClose} />
            
            <div className="relative bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl w-full max-w-3xl p-6 flex flex-col gap-5 animate-in fade-in zoom-in-95 duration-200">
                
                {/* Header */}
                <div className="flex items-start justify-between">
                    <div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                            Cấu hình Ốc Bế & Đường Dẫn
                        </h3>
                        <p className="text-[13px] text-slate-500 dark:text-zinc-400 mt-1">
                            Thiết lập toạ độ Boong cắt (Registration Marks) và thanh canh giấy.
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-all">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>

                {/* Preset Manager */}
                <div className="flex items-end gap-4 p-4 rounded-xl bg-indigo-50/50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20">
                    <div className="flex-1">
                        <label className={labelCls}>Lưu Mẫu Mới (Preset)</label>
                        <div className="flex gap-2">
                            <input 
                                type="text" 
                                placeholder="VD: Ốc Leta Nửa Chữ T..."
                                value={presetName}
                                onChange={e => setPresetName(e.target.value)}
                                className={inputCls}
                            />
                            <button
                                type="button"
                                onClick={savePreset}
                                className="h-8 px-4 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-bold transition-all shadow-sm active:scale-95 whitespace-nowrap"
                            >
                                Lưu Mẫu
                            </button>
                        </div>
                    </div>
                    {presets.length > 0 && (
                        <div className="flex-1">
                            <label className={labelCls}>Tải Mẫu Có Sẵn</label>
                            <select onChange={loadPreset} value={presets.some(p => p.name === presetName) ? presetName : ""} className={selectCls}>
                                <option value="">-- Chọn mẫu đã lưu --</option>
                                {presets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                            </select>
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Left Column */}
                    <div className="space-y-4">
                        
                        {/* 1. Cấu hình Ốc */}
                        <div className={sectionCls}>
                            <div className={sectionTitleCls}>
                                <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-sm">1</div>
                                Thông số Boong (Marks)
                            </div>
                            
                            <div className="grid grid-cols-2 gap-x-3 gap-y-4">
                                <div>
                                    <label className={labelCls}>Hình dạng</label>
                                    <select 
                                        value={localCfg.shape} 
                                        onChange={e => updateLocal('shape', e.target.value)}
                                        className={selectCls}
                                    >
                                        <option value="circle">Hình Tròn ⚪</option>
                                        <option value="l_inverted">L-Ngược (Mũi vào)</option>
                                        <option value="l_corner">Góc Vuông (L)</option>
                                    </select>
                                </div>
                                <div>
                                    <label className={labelCls}>Đường kính (mm)</label>
                                    <input type="number" step="0.1" value={localCfg.size} onChange={e => updateLocal('size', Number(e.target.value))} className={inputCls} />
                                </div>
                                
                                <div className="col-span-2 flex items-center gap-3 mt-1 mb-1">
                                    <label className="flex items-center gap-2 cursor-pointer group">
                                        <div className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${localCfg.isGraphtec ? 'bg-indigo-600' : 'border border-slate-300 dark:border-zinc-600 group-hover:border-indigo-400'}`}>
                                            {localCfg.isGraphtec && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                                        </div>
                                        <input type="checkbox" className="hidden" checked={localCfg.isGraphtec || false} onChange={e => updateLocal('isGraphtec', e.target.checked)} />
                                        <span className="font-bold text-xs text-slate-700 dark:text-zinc-200 uppercase tracking-wider">Boong Máy Graphtec</span>
                                    </label>
                                </div>

                                {localCfg.isGraphtec && (
                                    <div className="col-span-2">
                                        <label className={labelCls}>Graphtec Info Layer Name</label>
                                        <input type="text" value={localCfg.layerInfoName || 'SA info 0 0 0 17.01 2 -16777216 -16777216 1 1 0'} onChange={e => updateLocal('layerInfoName', e.target.value)} className={inputCls} />
                                    </div>
                                )}

                                <div>
                                    <label className={labelCls}>Tên Lớp (Layer Name)</label>
                                    <input type="text" value={localCfg.layerName ?? ''} onChange={e => updateLocal('layerName', e.target.value)} placeholder="Marks_Model_" className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>Tên Nhóm (Group Name)</label>
                                    <input type="text" value={localCfg.groupName} onChange={e => updateLocal('groupName', e.target.value)} className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>Tên Đối Tượng (Item Name)</label>
                                    <input type="text" value={localCfg.itemName} onChange={e => updateLocal('itemName', e.target.value)} className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>Độ dày nét (mm)</label>
                                    <input type="number" step="0.01" value={localCfg.thickness} onChange={e => updateLocal('thickness', Number(e.target.value))} className={inputCls} />
                                </div>
                            </div>
                        </div>

                        {/* 2. Khoảng cách mép giấy */}
                        <div className={sectionCls}>
                            <div className={sectionTitleCls}>
                                <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-sm">2</div>
                                Toạ độ canh lề (Margins)
                            </div>
                            <div className="grid grid-cols-4 gap-3">
                                <div>
                                    <label className="text-center block text-[11px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Lề Trên</label>
                                    <input type="number" step="1" value={localCfg.marginTop} onChange={e => updateLocal('marginTop', Number(e.target.value))} className={`${inputCls} text-center font-bold text-lg`} />
                                </div>
                                <div>
                                    <label className="text-center block text-[11px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Lề Dưới</label>
                                    <input type="number" step="1" value={localCfg.marginBottom} onChange={e => updateLocal('marginBottom', Number(e.target.value))} className={`${inputCls} text-center font-bold text-lg`} />
                                </div>
                                <div>
                                    <label className="text-center block text-[11px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Lề Trái</label>
                                    <input type="number" step="1" value={localCfg.marginLeft} onChange={e => updateLocal('marginLeft', Number(e.target.value))} className={`${inputCls} text-center font-bold text-lg`} />
                                </div>
                                <div>
                                    <label className="text-center block text-[11px] font-bold text-slate-500 dark:text-zinc-400 uppercase tracking-wider mb-2">Lề Phải</label>
                                    <input type="number" step="1" value={localCfg.marginRight} onChange={e => updateLocal('marginRight', Number(e.target.value))} className={`${inputCls} text-center font-bold text-lg`} />
                                </div>
                            </div>
                        </div>

                    </div>

                    {/* Right Column */}
                    <div className="space-y-4">
                        
                        {/* 3. Đường dẫn giấy */}
                        <div className={sectionCls}>
                            <div className={sectionTitleCls}>
                                <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-sm">3</div>
                                Thanh Canh Giấy (Paper Guides)
                            </div>
                            
                            {/* Guide 1 */}
                            <div className={`p-4 rounded-xl border-2 transition-all duration-300 ${localCfg.guide1Enabled ? 'border-indigo-500 bg-white dark:bg-zinc-800 shadow-md shadow-indigo-500/10' : 'border-slate-200 dark:border-white/5 bg-transparent'}`}>
                                <label className="flex items-center gap-3 cursor-pointer group w-max">
                                    <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${localCfg.guide1Enabled ? 'bg-indigo-600' : 'border border-slate-300 dark:border-zinc-600 group-hover:border-indigo-400'}`}>
                                        {localCfg.guide1Enabled && <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                                    </div>
                                    <input type="checkbox" className="hidden" checked={localCfg.guide1Enabled} onChange={e => updateLocal('guide1Enabled', e.target.checked)} />
                                    <span className="font-bold text-sm text-slate-700 dark:text-zinc-200">Kích hoạt Thanh dẫn 1</span>
                                </label>
                                
                                {localCfg.guide1Enabled && (
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-4 mt-4 pt-4 border-t border-slate-100 dark:border-white/5 animate-in fade-in slide-in-from-top-2">
                                        <div className="col-span-2">
                                            <label className={labelCls}>Góc neo (Anchor)</label>
                                            <select value={localCfg.guide1Pos} onChange={e => updateLocal('guide1Pos', e.target.value)} className={selectCls}>
                                                <option value="TL">Góc Trên - Trái (Top-Left)</option>
                                                <option value="TR">Góc Trên - Phải (Top-Right)</option>
                                                <option value="BL">Góc Dưới - Trái (Bottom-Left)</option>
                                                <option value="BR">Góc Dưới - Phải (Bottom-Right)</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className={labelCls}>Độ dài (mm)</label>
                                            <input type="number" step="1" value={localCfg.guide1Length} onChange={e => updateLocal('guide1Length', Number(e.target.value))} className={inputCls} />
                                        </div>
                                        <div>
                                            <label className={labelCls}>Độ đậm (mm)</label>
                                            <input type="number" step="0.1" value={localCfg.guide1Thickness} onChange={e => updateLocal('guide1Thickness', Number(e.target.value))} className={inputCls} />
                                        </div>
                                        <div>
                                            <label className={labelCls}>{getGuideLabelX(localCfg.guide1Pos)}</label>
                                            <input type="number" step="1" value={localCfg.guide1OffX} onChange={e => updateLocal('guide1OffX', Number(e.target.value))} className={inputCls} />
                                        </div>
                                        <div>
                                            <label className={labelCls}>{getGuideLabelY(localCfg.guide1Pos)}</label>
                                            <input type="number" step="1" value={localCfg.guide1OffY} onChange={e => updateLocal('guide1OffY', Number(e.target.value))} className={inputCls} />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Guide 2 */}
                            <div className={`p-4 rounded-xl border-2 transition-all duration-300 mt-3 ${localCfg.guide2Enabled ? 'border-indigo-500 bg-white dark:bg-zinc-800 shadow-md shadow-indigo-500/10' : 'border-slate-200 dark:border-white/5 bg-transparent'}`}>
                                <label className="flex items-center gap-3 cursor-pointer group w-max">
                                    <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${localCfg.guide2Enabled ? 'bg-indigo-600' : 'border border-slate-300 dark:border-zinc-600 group-hover:border-indigo-400'}`}>
                                        {localCfg.guide2Enabled && <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                                    </div>
                                    <input type="checkbox" className="hidden" checked={localCfg.guide2Enabled} onChange={e => updateLocal('guide2Enabled', e.target.checked)} />
                                    <span className="font-bold text-sm text-slate-700 dark:text-zinc-200">Kích hoạt Thanh dẫn 2</span>
                                </label>

                                {localCfg.guide2Enabled && (
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-4 mt-4 pt-4 border-t border-slate-100 dark:border-white/5 animate-in fade-in slide-in-from-top-2">
                                        <div className="col-span-2">
                                            <label className={labelCls}>Góc neo (Anchor)</label>
                                            <select value={localCfg.guide2Pos} onChange={e => updateLocal('guide2Pos', e.target.value)} className={selectCls}>
                                                <option value="TL">Góc Trên - Trái (Top-Left)</option>
                                                <option value="TR">Góc Trên - Phải (Top-Right)</option>
                                                <option value="BL">Góc Dưới - Trái (Bottom-Left)</option>
                                                <option value="BR">Góc Dưới - Phải (Bottom-Right)</option>
                                            </select>
                                        </div>
                                        <div className="col-span-2">
                                            <label className={labelCls}>Độ dài (mm)</label>
                                            <input type="number" step="1" value={localCfg.guide2Length} onChange={e => updateLocal('guide2Length', Number(e.target.value))} className={inputCls} />
                                        </div>
                                        <div>
                                            <label className={labelCls}>{getGuideLabelX(localCfg.guide2Pos)}</label>
                                            <input type="number" step="1" value={localCfg.guide2OffX} onChange={e => updateLocal('guide2OffX', Number(e.target.value))} className={inputCls} />
                                        </div>
                                        <div>
                                            <label className={labelCls}>{getGuideLabelY(localCfg.guide2Pos)}</label>
                                            <input type="number" step="1" value={localCfg.guide2OffY} onChange={e => updateLocal('guide2OffY', Number(e.target.value))} className={inputCls} />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                    </div>
                </div>

                {/* Footer Buttons */}
                <div className="flex items-center justify-between pt-4 mt-2 border-t border-slate-100 dark:border-white/10">
                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${localCfg.disableCollision ? 'bg-amber-500' : 'border border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                            {localCfg.disableCollision && <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                        </div>
                        <input type="checkbox" className="hidden" checked={localCfg.disableCollision} onChange={e => updateLocal('disableCollision', e.target.checked)} />
                        <span className="font-bold text-sm text-slate-600 dark:text-zinc-300">Vô hiệu hóa cảnh báo va chạm</span>
                    </label>

                    <div className="flex items-center gap-4">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-5 py-2 rounded-lg text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-700 font-bold transition-all"
                        >
                            Đóng
                        </button>

                        <button 
                            type="button"
                            onClick={(e) => { 
                                e.stopPropagation();
                                onSave(localCfg); 
                                requestAnimationFrame(() => onClose());
                            }}
                            className="px-6 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-md shadow-indigo-500/20 transition-all active:scale-95 text-sm"
                        >
                            Lưu Cấu Hình
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};
