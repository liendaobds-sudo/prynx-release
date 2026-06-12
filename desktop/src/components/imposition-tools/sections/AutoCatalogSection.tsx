// @ts-nocheck
/**
 * AutoCatalogSection — Auto Catalog Planner UI for Offset booklet.
 * 
 * Extracted from ImposerDashboard.tsx.
 * Handles: printing mode toggle (Digital/Offset), auto catalog toggle,
 * cover type, master sig override, remainder placement, optimizer preview.
 */
import React from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { Checkbox } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';

export default function AutoCatalogSection() {
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode,
        paperClassification: state.paperClassification, setPaperClassification: state.setPaperClassification,
        autoCatalog: state.autoCatalog, setAutoCatalog: state.setAutoCatalog,
        catalogHasCover: state.catalogHasCover, setCatalogHasCover: state.setCatalogHasCover,
        catalogMasterSigOverride: state.catalogMasterSigOverride, setCatalogMasterSigOverride: state.setCatalogMasterSigOverride,
        catalogRemainderPlacement: state.catalogRemainderPlacement, setCatalogRemainderPlacement: state.setCatalogRemainderPlacement,
        signatureMode: state.signatureMode,
        optimalData: state.optimalData,
        catalogPreview: state.catalogPreview,
    })));

    if (s.taskMode !== 'booklet') return null;

    return (
        <>
            {/* ═══ CHẾ ĐỘ IN (Digital / Offset Toggle) ═══ */}
            <div className="flex p-1 space-x-1 bg-slate-100 dark:bg-zinc-800/60 rounded-xl mb-6 ring-1 ring-slate-200/60 dark:ring-white/10 shadow-inner relative z-10">
                <button
                    onClick={() => {
                        s.setPaperClassification('in_nhanh');
                        s.setAutoCatalog(false);
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold rounded-lg transition-all duration-300 ${
                        s.paperClassification === 'in_nhanh' 
                            ? 'bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-sm ring-1 ring-slate-200 dark:ring-zinc-600' 
                            : 'text-slate-500 hover:text-slate-700 dark:text-zinc-400 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    ⚡ In Nhanh (Digital)
                </button>
                <button
                    onClick={() => {
                        s.setPaperClassification('offset');
                        s.setAutoCatalog(true);
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold rounded-lg transition-all duration-300 ${
                        s.paperClassification === 'offset' 
                            ? 'bg-white dark:bg-zinc-700 text-purple-600 dark:text-purple-400 shadow-sm ring-1 ring-slate-200 dark:ring-zinc-600' 
                            : 'text-slate-500 hover:text-slate-700 dark:text-zinc-400 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    🏭 In Offset
                </button>
            </div>

            {/* ═══ AUTO CATALOG (Offset only) ═══ */}
            {s.paperClassification === 'offset' && (
                <div className="flex flex-col gap-2 p-3 bg-purple-50 dark:bg-purple-900/10 border border-purple-200 dark:border-purple-800/30 rounded-lg relative z-[65] mb-4 transition-all duration-300">
                    <Checkbox 
                        checked={s.autoCatalog} 
                        onChange={s.setAutoCatalog} 
                        label="📋 Tự động chia kẽm (Auto Catalog)" 
                    />
                    {s.autoCatalog && (
                        <div className="mt-2 ml-6 space-y-3">
                            <div className="flex flex-col gap-1 mt-1">
                                <label className="text-[10px] font-bold text-slate-500 uppercase">Loại Bìa Catalog</label>
                                <select 
                                    value={s.catalogHasCover ? 'different' : 'same'}
                                    onChange={(e) => s.setCatalogHasCover(e.target.value === 'different')}
                                    className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-purple-500"
                                >
                                    <option value="different">Bìa Khác Chất Liệu (Bóc 4 trang bìa ra kẽm riêng)</option>
                                    <option value="same">Bìa Cùng Chất Liệu (Dàn chung với ruột cuốn)</option>
                                </select>
                            </div>
                            <div className="flex flex-col gap-1 mt-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase">Khóa Tay Sách (Ưu tiên)</label>
                                <select 
                                    value={s.catalogMasterSigOverride}
                                    onChange={(e) => s.setCatalogMasterSigOverride(e.target.value as any)}
                                    className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-purple-500"
                                >
                                    <option value="auto">Tự động tối ưu (Đề xuất)</option>
                                    <option value="16">Ép dùng Tay 16 Trang (Bình 8 con/mặt)</option>
                                    <option value="8">Ép dùng Tay 8 Trang (Bình 4 con/mặt)</option>
                                    <option value="4">Ép dùng Tay 4 Trang (Bình 2 con/mặt)</option>
                                </select>
                            </div>

                            {s.signatureMode === 'saddle' && (
                                <div className="flex flex-col gap-1 mt-2">
                                    <label className="text-[10px] font-bold text-slate-500 uppercase">Vị trí tay dư (Ghép lồng)</label>
                                    <select 
                                        value={s.catalogRemainderPlacement}
                                        onChange={(e) => s.setCatalogRemainderPlacement(e.target.value as any)}
                                        className="h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-purple-500"
                                    >
                                        <option value="outside">Tay bù bọc ngoài (Sát bìa nhựa)</option>
                                        <option value="inside">Tay bù nhét lõi (Sát kim lược)</option>
                                    </select>
                                </div>
                            )}

                            {/* Optimizer Preview */}
                            {s.optimalData && (
                                <div className="text-xs text-slate-600 dark:text-zinc-400">
                                    {s.optimalData.warnings.map((w: string, i: number) => (
                                        <div key={i} className="text-red-500 mb-1">{w}</div>
                                    ))}
                                    {s.optimalData.recommended ? (
                                        <div className="font-bold text-emerald-600 dark:text-emerald-400">
                                            ✓ Tay tối ưu: {s.optimalData.recommended.label} (Hiệu suất: {s.optimalData.recommended.sheetUtilization}%)
                                        </div>
                                    ) : (
                                        <div className="text-red-500 font-bold">❌ Không tìm thấy tay in phù hợp với khổ giấy này.</div>
                                    )}
                                </div>
                            )}

                            {s.catalogPreview && (
                                <pre className="text-[10px] text-slate-700 dark:text-zinc-300 bg-white dark:bg-black/20 border border-slate-200 dark:border-white/10 p-2 rounded whitespace-pre-wrap">
                                    {s.catalogPreview}
                                </pre>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
