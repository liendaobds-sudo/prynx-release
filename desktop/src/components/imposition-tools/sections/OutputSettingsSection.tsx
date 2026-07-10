// @ts-nocheck
/**
 * OutputSettingsSection — Marks, Bleed, Cluster, and Output settings.
 * 
 * Extracted from ImposerDashboard.tsx.
 * Renders: Trim marks, sticker marks (cut type, pont), cluster settings,
 *          bleed input, spawn new tab toggle.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { RichSelect, Checkbox, SectionLabel, Divider, inputCls } from '../SharedUI';
import type { PontConfig } from '../types';
import { useShallow } from 'zustand/react/shallow';

export default function OutputSettingsSection({ activeTool }: { activeTool: string }) {
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode,
        scaleMode: state.scaleMode,
        markType: state.markType, setMarkType: state.setMarkType,
        cutType: state.cutType, setCutType: state.setCutType,
        fillBlockGap: state.fillBlockGap, setFillBlockGap: state.setFillBlockGap,
        pontType: state.pontType, setPontType: state.setPontType,
        pontConfig: state.pontConfig, setPontConfig: state.setPontConfig,
        bleed: state.bleed, setBleed: state.setBleed,
        showBleedView: state.showBleedView, setShowBleedView: state.setShowBleedView,
        clusterMode: state.clusterMode, setClusterMode: state.setClusterMode,
        clusterCount: state.clusterCount, setClusterCount: state.setClusterCount,
        clusterGap: state.clusterGap, setClusterGap: state.setClusterGap,
        clusterGapMode: state.clusterGapMode, setClusterGapMode: state.setClusterGapMode,
        clusterDistribution: state.clusterDistribution, setClusterDistribution: state.setClusterDistribution,
        clusterBorder: state.clusterBorder, setClusterBorder: state.setClusterBorder,
        showMarksModal: state.showMarksModal, setShowMarksModal: state.setShowMarksModal,
        showPontModal: state.showPontModal, setShowPontModal: state.setShowPontModal,
        separateCutPage: state.separateCutPage, setSeparateCutPage: state.setSeparateCutPage,
        pontsOnCutFile: state.pontsOnCutFile, setPontsOnCutFile: state.setPontsOnCutFile,
    })));


    return (
        <div className="flex flex-col gap-5">


            {/* BOONG ĐỊNH VỊ đã chuyển sang THIẾT LẬP MỞ RỘNG cho gọn UI */}
            {activeTool === 'sticker_imposer' && (
                <>
                    {/* ĐƯỜNG CẮT — chỉ Bế tem (CNC cắt rời, ẩn 1 Dao) */}
                    <div className="flex items-center gap-3 relative z-[20]">
                        <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]">ĐƯỜNG CẮT</label>
                        <div className="flex flex-1 items-center gap-2 min-w-0">
                            <select
                                value={s.cutType}
                                onChange={e => s.setCutType(e.target.value as any)}
                                className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                            >
                                <option value="default">Mặc định</option>
                                <option value="one_dao">1 Dao (Dao LETA)</option>
                            </select>
                        </div>
                    </div>

                    {/* 3. KC CỤM PHỤ — chỉ hiện khi chọn 1 Dao */}
                    {s.cutType === 'one_dao' && (
                        <div className="flex items-center gap-3 relative z-[20]">
                            <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]" title="Khoảng cách giữa cụm chính và cụm phụ (lấp đầy).&#10;Chỉ áp dụng khi dùng Xếp tối ưu + Bế 1 Dao.&#10;Đặt > 0 để nét bế 1 Dao có chỗ lòi ra an toàn,&#10;không cắt vào tem của cụm khác.">KC CỤM PHỤ</label>
                            <div className="flex flex-1 items-center gap-2 min-w-0">
                                <div className="relative flex-1">
                                    <input type="number" step="0.5" min="0" value={s.fillBlockGap} onChange={e => s.setFillBlockGap(Number(e.target.value))}
                                        className="w-full h-8 px-2 pr-8 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium"
                                        title="Khoảng cách giữa cụm chính và cụm phụ (lấp đầy).&#10;Chỉ áp dụng khi dùng Xếp tối ưu + Bế 1 Dao.&#10;Đặt > 0 để nét bế 1 Dao có chỗ lòi ra an toàn,&#10;không cắt vào tem của cụm khác." />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none">mm</span>
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}


        </div>
    );
}
