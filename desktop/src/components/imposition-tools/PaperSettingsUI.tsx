import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../Button';

export interface SavedForm {
    id: string;
    name: string;
    w: number;
    h: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    marginMode?: 'labels_only' | 'include_marks';
    classification?: 'offset' | 'in_nhanh';
    gripperMargin?: number;
}

export function usePaperPresets(storageKey: string) {
    const [savedForms, setSavedForms] = useState<SavedForm[]>([]);

    useEffect(() => {
        try {
            const data = localStorage.getItem(storageKey);
            if (data) setSavedForms(JSON.parse(data));
        } catch (e) { }
    }, [storageKey]);

    const handleSavePreset = (name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh' = 'in_nhanh', gripperMargin: number = 0) => {
        const newPreset: SavedForm = {
            id: 'custom_' + Date.now(),
            name, w, h, marginTop: mT, marginBottom: mB, marginLeft: mL, marginRight: mR, marginMode: mode, classification, gripperMargin
        };
        const newList = [...savedForms, newPreset];
        setSavedForms(newList);
        localStorage.setItem(storageKey, JSON.stringify(newList));
        return newPreset.id;
    };

    const handleUpdatePreset = (id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh' = 'in_nhanh', gripperMargin: number = 0) => {
        const newList = savedForms.map(f => f.id === id ? { ...f, name, w, h, marginTop: mT, marginBottom: mB, marginLeft: mL, marginRight: mR, marginMode: mode, classification, gripperMargin } : f);
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
    onApply, savedForms, onSavePreset, onUpdatePreset, onDeletePreset, currentFormsize
}: {
    isOpen: boolean;
    onClose: () => void;
    width: number; height: number;
    marginTop: number; marginBottom: number; marginLeft: number; marginRight: number;
    marginMode: 'labels_only' | 'include_marks';
    classification: 'offset' | 'in_nhanh';
    gripperMargin: number;
    onApply: (w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripperMargin: number) => void;
    savedForms: SavedForm[];
    onSavePreset: (name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripperMargin: number) => void;
    onUpdatePreset: (id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripperMargin: number) => void;
    onDeletePreset: (id: string) => void;
    currentFormsize: string;
}) {
    const [presetName, setPresetName] = useState("");
    const [w, setW] = useState(width);
    const [h, setH] = useState(height);
    const [mT, setMT] = useState(marginTop);
    const [mB, setMB] = useState(marginBottom);
    const [mL, setML] = useState(marginLeft);
    const [mR, setMR] = useState(marginRight);
    const [mMode, setMMode] = useState(marginMode);
    const [classif, setClassif] = useState<'offset' | 'in_nhanh'>(classification || 'in_nhanh');
    const [gripper, setGripper] = useState(gripperMargin || 0);

    const isEditing = currentFormsize.startsWith('custom_');

    useEffect(() => {
        if (isOpen) { 
            setW(width); setH(height); setMT(marginTop); setMB(marginBottom); setML(marginLeft); setMR(marginRight); setMMode(marginMode); 
            setClassif(classification || 'in_nhanh'); setGripper(gripperMargin || 0);
            if (isEditing) {
                const f = savedForms.find(x => x.id === currentFormsize);
                if (f) {
                    setPresetName(f.name);
                    if (f.marginMode) setMMode(f.marginMode);
                    if (f.classification) setClassif(f.classification);
                    if (f.gripperMargin !== undefined) setGripper(f.gripperMargin);
                }
            } else {
                setPresetName("");
            }
        }
    }, [isOpen, width, height, marginTop, marginBottom, marginLeft, marginRight, marginMode, classification, gripperMargin, currentFormsize, savedForms, isEditing]);

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
                        {isEditing ? 'Cập nhật Khổ Giấy' : 'Tùy chỉnh Khổ Giấy'}
                    </h3>
                    <button onClick={onClose} className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>

                <div className="flex flex-col gap-5">
                    {/* Hàng 0: Phân loại in */}
                    <div className="flex gap-4 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-200 dark:border-white/10">
                        <div className="flex-1">
                            <label className={labelCls}>Mục đích In</label>
                            <div className="flex gap-3 mt-2">
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input type="radio" checked={classif === 'in_nhanh'} onChange={() => { setClassif('in_nhanh'); setGripper(0); }} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                    <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">In Nhanh Kỹ Thuật Số</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input type="radio" checked={classif === 'offset'} onChange={() => setClassif('offset')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                    <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">In Offset</span>
                                </label>
                            </div>
                        </div>
                    </div>

                    {/* Hàng 1: Tên khổ giấy */}
                    <div>
                        <label className={labelCls}>Tên Khổ Giấy {isEditing ? '' : '(Để trống nếu không muốn lưu Preset)'}</label>
                        <input 
                            type="text" 
                            value={presetName} onChange={e => setPresetName(e.target.value)} 
                            placeholder={isEditing ? "Nhập tên khổ giấy..." : "VD: Decal Đế Vàng 32x43..."}
                            className={inputCls}
                            autoFocus={!isEditing}
                        />
                    </div>

                    {/* Hàng 2: Kích thước */}
                    <div>
                        <h4 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 border-b border-slate-100 dark:border-zinc-700 pb-2 mb-3">Kích Thước Khổ Giấy (mm)</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">Chiều Rộng (W)</label>
                                <input type="number" step="0.5" value={w} onChange={e => setW(Number(e.target.value))} className={inputCls} />
                            </div>
                            <div>
                                <label className="text-[11px] text-slate-500 block mb-1 font-medium">Chiều Cao (H)</label>
                                <input type="number" step="0.5" value={h} onChange={e => setH(Number(e.target.value))} className={inputCls} />
                            </div>
                        </div>
                    </div>

                    {/* Hàng 3: Vùng lề */}
                    <div>
                        <h4 className="text-sm font-semibold text-slate-700 dark:text-zinc-300 border-b border-slate-100 dark:border-zinc-700 pb-2 mb-3">Vùng An Toàn / Vùng In (Lề mm)</h4>
                        {classif === 'offset' ? (
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Nhíp máy in (Gripper)</label>
                                    <input type="number" step="1" value={gripper} onChange={e => setGripper(Number(e.target.value))} className={inputCls} />
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Các lề còn lại (Top/Left/Right)</label>
                                    <input type="number" step="0.5" value={mT} onChange={e => {
                                        const v = Number(e.target.value);
                                        setMT(v); setML(v); setMR(v); setMB(v); // Store the same value across all margins as asked
                                    }} className={inputCls} />
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-4 gap-3">
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Trên (Top)</label>
                                    <input type="number" step="0.5" value={mT} onChange={e => setMT(Number(e.target.value))} className={inputCls} />
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Dưới (Bottom)</label>
                                    <input type="number" step="0.5" value={mB} onChange={e => setMB(Number(e.target.value))} className={inputCls} />
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Trái (Left)</label>
                                    <input type="number" step="0.5" value={mL} onChange={e => setML(Number(e.target.value))} className={inputCls} />
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Phải (Right)</label>
                                    <input type="number" step="0.5" value={mR} onChange={e => setMR(Number(e.target.value))} className={inputCls} />
                                </div>
                            </div>
                        )}
                    </div>



                    {/* Hàng 4: Tùy chọn margin mode */}
                    <div className="bg-slate-50 dark:bg-zinc-800/50 rounded-lg p-4 border border-slate-200 dark:border-white/10 mt-1">
                        <label className="text-[11px] font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wide block mb-3">Cách tính Lề (Margin Behavior)</label>
                        <div className="flex flex-col gap-2.5">
                            <label className="flex items-center gap-2 cursor-pointer group">
                                <input type="radio" checked={mMode === 'labels_only'} onChange={() => setMMode('labels_only')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">Lề chỉ bao vùng tem (Dấu xén sẽ bắn ra ngoài lề)</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer group">
                                <input type="radio" checked={mMode === 'include_marks'} onChange={() => setMMode('include_marks')} className="accent-indigo-600 w-4 h-4 cursor-pointer" />
                                <span className="text-[13px] text-slate-700 dark:text-zinc-300 font-medium group-hover:text-indigo-600 transition-colors">Lề bao gồm cả Dấu xén (Thu hẹp vùng xếp tem lại)</span>
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
                            Xóa Preset
                        </button>
                    )}
                    
                    {!isEditing && <div className="flex-1" />}
                    
                    <Button variant="secondary" onClick={onClose}>Hủy</Button>
                    <Button 
                        variant="primary" 
                        onClick={() => { 
                            if (isEditing) {
                                onUpdatePreset(currentFormsize, presetName, w, h, mT, mB, mL, mR, mMode, classif, gripper);
                            } else {
                                if (presetName.trim() !== '') {
                                    onSavePreset(presetName.trim(), w, h, mT, mB, mL, mR, mMode, classif, gripper);
                                } else {
                                    onApply(w, h, mT, mB, mL, mR, mMode, classif, gripper); // Just apply without saving preset
                                }
                            }
                            onClose(); 
                        }}
                    >
                        {isEditing ? 'Lưu' : (presetName.trim() ? 'Lưu Khổ Giấy Mới' : 'Áp dụng')}
                    </Button>
                </div>
            </div>
        </div>,
        document.body
    );
}

