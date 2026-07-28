/**
 * BookletSettingsSection — Booklet-specific settings UI.
 * 
 * Extracted from ImposerDashboard.tsx.
 * Reads/writes all state from useImposerSettingsStore.
 * 
 * Renders:
 *   - Binding mode (Saddle / Thread / Cut&Stack / Perfect)
 *   - Folio size (for Thread mode)
 *   - Gutter + Cover separation (for Perfect/Thread, Digital only)
 *   - Scale mode (1 cuốn / nhiều cuốn / cut&stack)
 *   - Fold pattern (for Offset chain_nup)
 *   - Interleave mode (for Offset)
 *   - Paper thickness & Bleed
 *   - Gap settings
 */
import React from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { RichSelect, Checkbox, SectionLabel, Divider } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { HIDE_OFFSET_BOOKLET } from '../../../lib/featureFocus';
// UIUX (audit 2026-07-27 §B-06): toast báo khi tay sách bị làm tròn bội số 4
import { toast } from '../../ui/Toast';

export default function BookletSettingsSection() {
  const { t } = useTranslation();
    const s = useImposerSettingsStore(useShallow(state => ({
        taskMode: state.taskMode,
        signatureMode: state.signatureMode, setSignatureMode: state.setSignatureMode,
        foliosize: state.foliosize, setFoliosize: state.setFoliosize,
        gutterMargin: state.gutterMargin, setGutterMargin: state.setGutterMargin,
        separateCover: state.separateCover, setSeparateCover: state.setSeparateCover,
        coverPageCount: state.coverPageCount, setCoverPageCount: state.setCoverPageCount,
        scaleMode: state.scaleMode, setScaleMode: state.setScaleMode,
        interleave: state.interleave, setInterleave: state.setInterleave,
        gapX: state.gapX, setGapX: state.setGapX,
        gapY: state.gapY, setGapY: state.setGapY,
        spreadDistribution: state.spreadDistribution, setSpreadDistribution: state.setSpreadDistribution,
        foldPattern: state.foldPattern, setFoldPattern: state.setFoldPattern,
        paperClassification: state.paperClassification,
        autoCatalog: state.autoCatalog,
    })));

    if (s.taskMode !== 'booklet') return null;

    return (
        <>
            {/* ═══ KIỂU ĐÓNG SÁCH ═══ */}
            <div className="flex flex-col gap-2 relative z-[65] animate-in fade-in duration-200">
                <SectionLabel>{t('imposition.bookletSettings:kieu_dong_sach')}</SectionLabel>
                <RichSelect
                    value={s.signatureMode}
                    onChange={(v) => s.setSignatureMode(v as any)}
                    options={[
                        { value: 'saddle', title: t('imposition.bookletSettings:bam_kim_giua_saddle_stitched'), desc: t('imposition.bookletSettings:long_toan_bo_trang_thanh_1_cuon_duy') },
                        { value: 'thread', title: t('imposition.bookletSettings:khau_chi_chia_tep_thread_sewn'), desc: t('imposition.bookletSettings:chia_file_thanh_nhieu_tep_nho_bang_nhau') },
                        { value: 'cut_stacks', title: t('imposition.bookletSettings:cat_doi_rap_xap_half_split'), desc: t('imposition.bookletSettings:cat_giua_to_in_lam_doi_de_rap_up_len') },
                        { value: 'continuous', title: t('imposition.bookletSettings:keo_gay_lo_xo_perfect_bound'), desc: t('imposition.bookletSettings:cac_trang_xep_noi_tiep_lien_mach_1_2_3') },
                        ...(s.paperClassification === 'in_nhanh' ? [{ value: 'flush_mount', title: t('imposition.bookletSettings:dan_doi_lung_flush_mount'), desc: t('imposition.bookletSettings:sach_mo_phang_180_do_in_1_mat_moi_to') }] : [])
                    ]}
                />
                {s.signatureMode === 'thread' && !s.autoCatalog && (
                    <div className="mt-1 p-3 flex items-center gap-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40">
                        <label className="text-xs text-slate-600 dark:text-zinc-400">{t('imposition.bookletSettings:so_trang_moi_tep_tay_sach')}</label>
                        <input
                            type="number" step="4" min="4" value={s.foliosize}
                            onChange={e => s.setFoliosize(Number(e.target.value))}
                            onBlur={e => {
                                // Tay sách bắt buộc là bội số của 4; tự làm tròn khi rời ô.
                                const raw = Number(e.target.value);
                                const snapped = Number.isFinite(raw) ? Math.max(4, Math.round(raw / 4) * 4) : 16;
                                // UIUX (audit 2026-07-27 §B-06): báo rõ khi giá trị gõ bị làm tròn — không im lặng
                                if (snapped !== raw) toast.info(t('imposition.bookletSettings:tay_sach_boi_4_da_lam_tron', 'Tay sách phải là bội số của 4 — đã làm tròn thành {{n}}', { n: snapped }));
                                if (snapped !== s.foliosize) s.setFoliosize(snapped);
                            }}
                            // UIUX (audit 2026-07-27 §B-06): Enter → blur để kích hoạt snap ngay
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                            className="w-16 h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500"
                        />
                        <span className="text-[10px] text-slate-400">{t('imposition.bookletSettings:boi_so_cua_4')}</span>
                    </div>
                )}

                {/* Gutter + Cover — chỉ hiện cho in nhanh + keo gáy/khâu chỉ */}
                {s.paperClassification === 'in_nhanh' && (s.signatureMode === 'continuous' || s.signatureMode === 'thread') && (
                    <div className="mt-1 space-y-2">
                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40 space-y-2">
                            <div className="flex items-center gap-3">
                                <label className="text-xs text-slate-600 dark:text-zinc-400 whitespace-nowrap">{t('imposition.bookletSettings:le_gay_mm')}</label>
                                <input
                                    type="number" step="0.5" min="0" value={s.gutterMargin} onChange={e => s.setGutterMargin(Number(e.target.value))}
                                    className="w-20 h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500"
                                />
                                <span className="text-[10px] text-slate-400">{t('imposition.bookletSettings:bu_phan_bi_keo_chi_che')}</span>
                            </div>
                        </div>
                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40 space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox" checked={s.separateCover} onChange={e => s.setSeparateCover(e.target.checked)}
                                    className="rounded border-slate-300"
                                />
                                <span className="text-xs text-slate-600 dark:text-zinc-400">{t('imposition.bookletSettings:tach_bia_rieng')}</span>
                            </label>
                            {s.separateCover && (
                                <div className="flex items-center gap-2 ml-6">
                                    <label className="text-[11px] text-slate-500">{t('imposition.bookletSettings:so_trang_bia')}</label>
                                    <select
                                        value={s.coverPageCount} onChange={e => s.setCoverPageCount(Number(e.target.value))}
                                        className="h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-indigo-500"
                                    >
                                        <option value={2}>{t('imposition.bookletSettings:2_truoc_sau')}</option>
                                        <option value={4}>{t('imposition.bookletSettings:4_truoc_01_n_1_sau')}</option>
                                    </select>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
            <Divider />

            {/* ═══ SỐ CUỐN TRÊN TỜ IN ═══ */}
            {!s.autoCatalog && s.paperClassification !== 'offset' && (
                <>
                    <div className="space-y-2 pb-1 animate-in fade-in duration-200 relative z-[60]">
                        <SectionLabel>{t('imposition.bookletSettings:so_cuon_tren_to_in')}</SectionLabel>
                        <RichSelect
                            value={s.scaleMode}
                            onChange={(v) => s.setScaleMode(v as any)}
                            options={[
                                { value: '100', title: t('imposition.bookletSettings:1_cuon_to_100'), desc: t('imposition.bookletSettings:giu_nguyen_kich_thuoc_trang_khong_vua') },
                                { value: 'fit', title: t('imposition.bookletSettings:1_cuon_to_bop_vua_kho'), desc: t('imposition.bookletSettings:thu_noi_dung_cho_vua_kho_giay_da_chon') },
                                { value: 'chain_nup', title: t('imposition.bookletSettings:nhieu_cuon_to_step_repeat'), desc: t('imposition.bookletSettings:nhan_ban_nhieu_cuon_giong_het_nhau_lap') },
                                ...(s.paperClassification === 'in_nhanh' && s.signatureMode !== 'cut_stacks' ? [{ value: 'cut_stack', title: t('imposition.bookletSettings:ghep_nua_cuon_cut_stack'), desc: t('imposition.bookletSettings:2_nua_cuon_tren_1_to_xen_doi_rap_lai') }] : [])
                            ]}
                        />
                    </div>
                    <Divider />
                </>
            )}

            {/* ═══ FOLD PATTERN (Offset) ═══ */}
            {!HIDE_OFFSET_BOOKLET && !s.autoCatalog && s.paperClassification === 'offset' && (
                <>
                    <div className="space-y-3 animate-in fade-in duration-200 relative z-[55]">
                        <SectionLabel>{t('imposition.bookletSettings:so_do_gap_offset_fold_pattern')}</SectionLabel>
                        <RichSelect
                            value={s.foldPattern}
                            onChange={(v) => s.setFoldPattern(v)}
                            options={[
                                { value: '', title: t('imposition.bookletSettings:2_up_classic_mac_dinh'), desc: t('imposition.bookletSettings:nhan_ban_booklet_2_up_len_kho_lon_khong') },
                                ...(s.autoCatalog ? [{ value: 'auto', title: t('imposition.bookletSettings:tu_dong_theo_tay_sach'), desc: t('imposition.bookletSettings:tu_chon_so_do_gap_phu_hop_nhat_cho_tung') }] : []),
                                { value: 'sig_4p_1up', title: t('imposition.bookletSettings:tay_4_trang_1_bo_kho_lon'), desc: t('imposition.bookletSettings:in_1_bo_tu_tro_lat_nhip_work_tumble') },
                                { value: 'sig_4p_2up', title: t('imposition.bookletSettings:tay_4_trang_nhan_ban_2_up'), desc: t('imposition.bookletSettings:luoi_2_2_spreads_8_con_mat_in_2_tay_4') },
                                { value: 'sig_8p', title: t('imposition.bookletSettings:tay_8_trang_tu_tro'), desc: t('imposition.bookletSettings:luoi_2_2_spreads_8_con_mat_tu_tro_lat') },
                                { value: 'sig_16p', title: t('imposition.bookletSettings:tay_16_trang_in_2_mat'), desc: t('imposition.bookletSettings:luoi_2_2_spreads_8_con_mat_tieu_chuan') },
                            ]}
                        />
                    </div>
                    <Divider />
                </>
            )}

            {/* ═══ FINE-TUNING (Interleave, Bleed, Gap) ═══ */}
            <div className="flex flex-col gap-5 animate-in fade-in duration-200">
                {/* Độ dày giấy/Creep: KHÔNG đặt ở đây (tránh trùng). Ô gốc nằm trong
                    "THIẾT LẬP MỞ RỘNG" (AdvancedSettingsSection) cạnh Lề xén Bleed. */}

                {/* Vị trí trang trắng: KHÔNG hiện ở đây. Logic chạy ngầm; khi phát hiện
                    số trang không tròn tay (cần chèn trang trắng), dialog Xác nhận Bình
                    Sách sẽ hỏi người dùng chọn Cuối/Giữa. */}

                {/* Interleave */}
                {!HIDE_OFFSET_BOOKLET && !s.autoCatalog && s.paperClassification === 'offset' && !s.foldPattern && (
                    <div className="flex flex-col gap-2 relative z-[40]">
                        <label className="text-[11px] text-slate-500 font-medium block -mb-0.5">{t('imposition.bookletSettings:the_phoi_sap_trang')}</label>
                        <RichSelect
                            value={s.interleave}
                            onChange={(v) => s.setInterleave(v as any)}
                            options={[
                                { value: 'normal', title: t('imposition.bookletSettings:binh_thuong'), desc: t('imposition.bookletSettings:trai_deu_truoc_sau_xen_ke') },
                                { value: 'all_fronts_first', title: t('imposition.bookletSettings:tach_rieng'), desc: t('imposition.bookletSettings:ra_het_mat_truoc_roi_den_mat_sau') },
                                { value: 'reverse_backs', title: t('imposition.bookletSettings:tro_nhip_tro_ngang'), desc: t('imposition.bookletSettings:mat_truoc_binh_thuong_mat_sau_lon_nguoc') },
                                { value: 'reverse_backs_180', title: t('imposition.bookletSettings:tro_dau_tro_lat'), desc: t('imposition.bookletSettings:giong_tro_nhip_nhung_cong_them_xoay') }
                            ]}
                        />
                    </div>
                )}

                {/* Gap Settings */}
                {(s.scaleMode === 'chain_nup' || s.scaleMode === 'cut_stack' || s.signatureMode === 'cut_stacks' || s.signatureMode === 'continuous' || s.signatureMode === 'flush_mount') && (
                    <div className="flex flex-col gap-3 relative z-[20] mt-1 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-200 dark:border-white/10">
                        <div className="flex items-center justify-between">
                            <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide">
                                {s.signatureMode === 'cut_stacks' ? t('imposition.bookletSettings:co_che_rap_xap_cut_stack') : t('imposition.bookletSettings:khoang_ho_cum_trang_gap')}
                            </label>
                            {s.signatureMode === 'cut_stacks' && (
                                <div className="group relative flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-zinc-700 text-slate-500 text-[10px] font-bold cursor-help">
                                    ?
                                    <div className="absolute bottom-full right-0 mb-2 w-max max-w-[280px] px-3 py-2.5 bg-slate-800 text-white text-[12px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                                        <p className="mb-1 font-bold text-indigo-300">{t('imposition.bookletSettings:cut_stack_cat_doi_rap_xap')}</p>
                                        <p className="opacity-90 leading-relaxed">
                                            {t('imposition.bookletSettings:co_che_mac_dinh')} <strong>{t('imposition.bookletSettings:hut_gay_xen_up')}</strong> {t('imposition.bookletSettings:se_tu_dong_xoay_180_coc_ben_phai_de_dam')}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>

                        {s.signatureMode === 'cut_stacks' ? (
                            <RichSelect
                                value={s.spreadDistribution}
                                onChange={(v) => s.setSpreadDistribution(v as 'even' | 'clustered')}
                                options={[
                                    { value: 'clustered', title: t('imposition.bookletSettings:hut_gay_xen_up_doi_xung_180'), desc: t('imposition.bookletSettings:tu_dong_xoay_nguoc_coc_phai_180_giup_2') },
                                    { value: 'even', title: t('imposition.bookletSettings:trai_deu_giu_nguyen_chieu'), desc: t('imposition.bookletSettings:tan_deu_cac_trang_tren_mat_giay_khong') }
                                ]}
                            />
                        ) : (
                            <div className="flex items-center space-x-2">
                                <input type="checkbox" id="spreadDistribution"
                                    className="rounded border-zinc-300 dark:border-zinc-700 text-blue-600 bg-white dark:bg-zinc-900 focus:ring-blue-500"
                                    checked={s.spreadDistribution === 'even'}
                                    onChange={e => s.setSpreadDistribution(e.target.checked ? 'even' : 'clustered')}
                                />
                                <label htmlFor="spreadDistribution" className="text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
                                    {t('imposition.bookletSettings:dan_deu_2_ben_chia_deu_tao_khoang_ho')}
                                </label>
                            </div>
                        )}

                        {s.spreadDistribution !== 'even' && (
                            <div className="grid grid-cols-2 gap-x-3 gap-y-3 pt-2 border-t border-slate-200 dark:border-white/10 mt-1">
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.bookletSettings:khoang_cach_gay_gap_x')}</label>
                                    {/* UIUX (audit 2026-07-27 §B-02): thêm suffix mm; §B-04: min 0 + clamp không âm */}
                                    <span className="relative block">
                                        <input type="number" step="1" min="0" value={s.gapX} onChange={e => s.setGapX(Math.max(0, Number(e.target.value) || 0))} className="w-full h-8 px-3 pr-7 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors" />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none uppercase">mm</span>
                                    </span>
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">{t('imposition.bookletSettings:ho_doc_gap_y')}</label>
                                    {/* UIUX (audit 2026-07-27 §B-02): thêm suffix mm; §B-04: min 0 + clamp không âm */}
                                    <span className="relative block">
                                        <input type="number" step="1" min="0" value={s.gapY} onChange={e => s.setGapY(Math.max(0, Number(e.target.value) || 0))} className="w-full h-8 px-3 pr-7 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors" />
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 font-medium pointer-events-none uppercase">mm</span>
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}
