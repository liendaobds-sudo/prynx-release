// @ts-nocheck
/**
 * NupSettingsSection — N-Up / Step & Repeat settings UI.
 * 
 * Extracted from ImposerDashboard.tsx.
 * Renders: Layout type, duplex flow for N-Up and Step&Repeat modes.
 */
import React from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { RichSelect } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';

export default function NupSettingsSection({ activeTool }: { activeTool: string }) {
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode, setTaskMode: state.setTaskMode,
        layoutType: state.layoutType, setLayoutType: state.setLayoutType,
        duplexFlow: state.duplexFlow, setDuplexFlow: state.setDuplexFlow,
    })));

    // N-Up mode
    if (s.taskMode === 'nup' || s.taskMode === 'sticker_imposer') {
        return (
            <div className="flex flex-col gap-5 animate-in fade-in duration-200 relative z-[60]">
                {/* Layout Type */}
                {activeTool !== 'sticker_imposer' && (
                    <div className="flex flex-col gap-2">
                        <label className="text-[11px] font-bold text-slate-600 tracking-wide block -mb-0.5">CÁCH THỨC RÁP THÀNH PHẨM</label>
                        <RichSelect
                            value={s.layoutType}
                            onChange={(v) => s.setLayoutType(v as any)}
                            options={[
                                { value: 'sequential', title: 'Xếp lần lượt', desc: 'Xếp lần lượt 1, 2, 3, 4... lên mặt giấy.' },
                                { value: 'cut_stacks', title: 'Xếp chồng', desc: 'Chế độ chia cọc. Sau khi máy xén chém xong, úp các cọc giấy lên nhau là tự động dồn đúng thứ tự.' }
                            ]}
                        />
                    </div>
                )}
                {/* Duplex */}
                {activeTool !== 'sticker_imposer' && (
                    <div className="flex items-center gap-3">
                        <label className="text-[11px] font-bold text-slate-600 tracking-wide shrink-0 w-[65px]">SỐ MẶT</label>
                        <select
                            value={s.duplexFlow} onChange={(e) => s.setDuplexFlow(e.target.value as 'normal' | 'double')}
                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-slate-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                        >
                            <option value="normal">1 Mặt</option>
                            <option value="double">2 Mặt</option>
                        </select>
                    </div>
                )}
            </div>
        );
    }

    // Step & Repeat mode
    if (s.taskMode === 'step_repeat') {
        return (
            <div className="flex flex-col gap-5 animate-in fade-in duration-200 relative z-[60]">
                {activeTool !== 'sticker_imposer' && (
                    <div className="flex items-center gap-3">
                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[65px]">SỐ MẶT</label>
                        <select
                            value={s.duplexFlow} onChange={(e) => s.setDuplexFlow(e.target.value as 'normal' | 'double')}
                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-slate-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                        >
                            <option value="normal">1 Mặt</option>
                            <option value="double">2 Mặt</option>
                        </select>
                    </div>
                )}
            </div>
        );
    }

    return null;
}
