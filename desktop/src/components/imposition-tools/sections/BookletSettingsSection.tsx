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

export default function BookletSettingsSection() {
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
                <SectionLabel>KIỂU ĐÓNG SÁCH</SectionLabel>
                <RichSelect
                    value={s.signatureMode}
                    onChange={(v) => s.setSignatureMode(v as any)}
                    options={[
                        { value: 'saddle', title: 'Bấm kim giữa (Saddle stitched)', desc: 'Lồng toàn bộ trang thành 1 cuốn duy nhất. Bìa ngoài cùng chung tờ in.' },
                        { value: 'thread', title: 'Khâu chỉ / Chia tép (Thread sewn)', desc: 'Chia file thành nhiều tép nhỏ bằng nhau rồi xếp chồng. Thích hợp khâu chỉ dán gáy.' },
                        { value: 'cut_stacks', title: 'Cắt đôi ráp xấp (Half-Split)', desc: 'Cắt giữa tờ in làm đôi để ráp úp lên nhau thành thứ tự chuẩn (Vé xe, Voucher).' },
                        { value: 'continuous', title: 'Keo gáy / Lò xo (Perfect Bound)', desc: 'Các trang xếp nối tiếp liền mạch (1-2, 3-4). Dùng để cắt phay gáy đổ keo hoặc gáy xoắn.' },
                        ...(s.paperClassification === 'in_nhanh' ? [{ value: 'flush_mount', title: 'Dán đối lưng (Flush Mount)', desc: 'Sách mở phẳng 180 độ. In 1 mặt, mỗi tờ chứa 1 trang đôi liền mạch (1-2, 3-4...).' }] : [])
                    ]}
                />
                {s.signatureMode === 'thread' && !s.autoCatalog && (
                    <div className="mt-1 p-3 flex items-center gap-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40">
                        <label className="text-xs text-slate-600 dark:text-zinc-400">Số trang mỗi tép (Tay sách):</label>
                        <input
                            type="number" step="4" min="4" value={s.foliosize}
                            onChange={e => s.setFoliosize(Number(e.target.value))}
                            onBlur={e => {
                                // Tay sách bắt buộc là bội số của 4; tự làm tròn khi rời ô.
                                const raw = Number(e.target.value);
                                const snapped = Number.isFinite(raw) ? Math.max(4, Math.round(raw / 4) * 4) : 16;
                                if (snapped !== s.foliosize) s.setFoliosize(snapped);
                            }}
                            className="w-16 h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500"
                        />
                        <span className="text-[10px] text-slate-400">Bội số của 4</span>
                    </div>
                )}

                {/* Gutter + Cover — chỉ hiện cho in nhanh + keo gáy/khâu chỉ */}
                {s.paperClassification === 'in_nhanh' && (s.signatureMode === 'continuous' || s.signatureMode === 'thread') && (
                    <div className="mt-1 space-y-2">
                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40 space-y-2">
                            <div className="flex items-center gap-3">
                                <label className="text-xs text-slate-600 dark:text-zinc-400 whitespace-nowrap">Lề gáy (mm):</label>
                                <input
                                    type="number" step="0.5" min="0" value={s.gutterMargin} onChange={e => s.setGutterMargin(Number(e.target.value))}
                                    className="w-20 h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500"
                                />
                                <span className="text-[10px] text-slate-400">Bù phần bị keo/chỉ che</span>
                            </div>
                        </div>
                        <div className="p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40 space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox" checked={s.separateCover} onChange={e => s.setSeparateCover(e.target.checked)}
                                    className="rounded border-slate-300"
                                />
                                <span className="text-xs text-slate-600 dark:text-zinc-400">Tách bìa riêng</span>
                            </label>
                            {s.separateCover && (
                                <div className="flex items-center gap-2 ml-6">
                                    <label className="text-[11px] text-slate-500">Số trang bìa:</label>
                                    <select
                                        value={s.coverPageCount} onChange={e => s.setCoverPageCount(Number(e.target.value))}
                                        className="h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-xs focus:outline-none focus:border-indigo-500"
                                    >
                                        <option value={2}>2 (trước + sau)</option>
                                        <option value={4}>4 (trước, 01, N-1, sau)</option>
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
                        <SectionLabel>SỐ CUỐN TRÊN TỜ IN</SectionLabel>
                        <RichSelect
                            value={s.scaleMode}
                            onChange={(v) => s.setScaleMode(v as any)}
                            options={[
                                { value: '100', title: '1 cuốn / tờ (100%)', desc: 'Giữ nguyên kích thước trang. Không vừa khổ giấy → báo lỗi (không tự co).' },
                                { value: 'fit', title: '1 cuốn / tờ (bóp vừa khổ)', desc: 'Thu nội dung cho vừa khổ giấy đã chọn, canh giữa.' },
                                { value: 'chain_nup', title: 'Nhiều cuốn / tờ (Step & Repeat)', desc: 'Nhân bản nhiều cuốn giống hệt nhau lấp đầy tờ giấy lớn. Xén ra nhiều cuốn.' },
                                ...(s.paperClassification === 'in_nhanh' && s.signatureMode !== 'cut_stacks' ? [{ value: 'cut_stack', title: 'Ghép nửa cuốn (Cut & Stack)', desc: '2 nửa cuốn trên 1 tờ, xén đôi ráp lại thành 1 cuốn hoàn chỉnh.' }] : [])
                            ]}
                        />
                    </div>
                    <Divider />
                </>
            )}

            {/* ═══ FOLD PATTERN (Offset) ═══ */}
            {!s.autoCatalog && s.paperClassification === 'offset' && (
                <>
                    <div className="space-y-3 animate-in fade-in duration-200 relative z-[55]">
                        <SectionLabel>SƠ ĐỒ GẤP OFFSET (FOLD PATTERN)</SectionLabel>
                        <RichSelect
                            value={s.foldPattern}
                            onChange={(v) => s.setFoldPattern(v)}
                            options={[
                                { value: '', title: '2-Up Classic (Mặc định)', desc: 'Nhân bản booklet 2-up lên khổ lớn. Không dùng sơ đồ gấp offset.' },
                                ...(s.autoCatalog ? [{ value: 'auto', title: 'Tự động theo tay sách', desc: 'Tự chọn sơ đồ gấp phù hợp nhất cho từng tay sách (4p/8p/16p).' }] : []),
                                { value: 'sig_4p_1up', title: 'Tay 4 Trang (1 Bộ, khổ lớn)', desc: 'In 1 bộ tự trở lật nhíp (Work & Tumble). Dành cho sách khổ lớn in trên kẽm nhỏ.' },
                                { value: 'sig_4p_2up', title: 'Tay 4 Trang (Nhân bản 2-Up)', desc: 'Lưới 2×2 spreads (8 con/mặt). In 2 tay 4 trang trên 1 tờ kẽm.' },
                                { value: 'sig_8p', title: 'Tay 8 Trang (Tự trở)', desc: 'Lưới 2×2 spreads (8 con/mặt). Tự trở lật ngang, 1 tờ kẽm = 1 tay 8.' },
                                { value: 'sig_16p', title: 'Tay 16 Trang (In 2 mặt)', desc: 'Lưới 2×2 spreads (8 con/mặt). Tiêu chuẩn công nghiệp.' },
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
                {!s.autoCatalog && s.paperClassification === 'offset' && (
                    <div className="flex flex-col gap-2 relative z-[40]">
                        <label className="text-[11px] text-slate-500 font-medium block -mb-0.5">Thế phơi / Sắp trang</label>
                        <RichSelect
                            value={s.interleave}
                            onChange={(v) => s.setInterleave(v as any)}
                            options={[
                                { value: 'normal', title: 'Bình thường', desc: 'Trải đều Trước - Sau xen kẽ.' },
                                { value: 'all_fronts_first', title: 'Tách riêng', desc: 'Ra hết Mặt Trước, rồi đến Mặt Sau.' },
                                { value: 'reverse_backs', title: 'Trở Nhíp / Trở Ngang', desc: 'Mặt Trước bình thường, Mặt Sau lộn ngược theo thứ tự tờ.' },
                                { value: 'reverse_backs_180', title: 'Trở Đầu / Trở lật', desc: 'Giống Trở Nhíp nhưng cộng thêm xoay ngược 180° mặt sau.' }
                            ]}
                        />
                    </div>
                )}

                {/* Gap Settings */}
                {(s.scaleMode === 'chain_nup' || s.scaleMode === 'cut_stack' || s.signatureMode === 'cut_stacks' || s.signatureMode === 'continuous' || s.signatureMode === 'flush_mount') && (
                    <div className="flex flex-col gap-3 relative z-[20] mt-1 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-lg border border-slate-200 dark:border-white/10">
                        <div className="flex items-center justify-between">
                            <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wide">
                                {s.signatureMode === 'cut_stacks' ? 'CƠ CHẾ RÁP XẤP (CUT & STACK)' : 'KHOẢNG HỞ CỤM TRANG (GAP)'}
                            </label>
                            {s.signatureMode === 'cut_stacks' && (
                                <div className="group relative flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 dark:bg-zinc-700 text-slate-500 text-[10px] font-bold cursor-help">
                                    ?
                                    <div className="absolute bottom-full right-0 mb-2 w-64 p-2.5 bg-slate-800 text-white text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                                        <p className="mb-1 font-bold text-indigo-300">Cut & Stack (Cắt đôi ráp xấp):</p>
                                        <p className="opacity-90 leading-relaxed">
                                            Cơ chế mặc định <strong>Hút gáy & Xén úp</strong> sẽ tự động xoay 180° cọc bên phải để đảm bảo khi úp 2 cọc vào nhau, lề xén đối xứng hoàn hảo và dấu xén trùng khớp 100%. Không cần tự lật tay!
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
                                    { value: 'clustered', title: 'Hút gáy & Xén úp (Đối xứng 180°)', desc: 'Tự động xoay ngược cọc phải 180°. Giúp 2 nửa đối xứng lề khi chập vào.' },
                                    { value: 'even', title: 'Trải đều (Giữ nguyên chiều)', desc: 'Tản đều các trang trên mặt giấy, không xoay hướng. Thích hợp xén rời.' }
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
                                    Dàn đều 2 bên (chia đều, tạo khoảng hở lớn ở giữa) thay vì Hút sát gáy
                                </label>
                            </div>
                        )}

                        {s.spreadDistribution !== 'even' && (
                            <div className="grid grid-cols-2 gap-x-3 gap-y-3 pt-2 border-t border-slate-200 dark:border-white/10 mt-1">
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Khoảng cách Gáy (Gap X)</label>
                                    <input type="number" step="1" value={s.gapX} onChange={e => s.setGapX(Number(e.target.value))} className="w-full h-8 px-3 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors" />
                                </div>
                                <div>
                                    <label className="text-[11px] text-slate-500 block mb-1 font-medium">Hở Dọc (Gap Y)</label>
                                    <input type="number" step="1" value={s.gapY} onChange={e => s.setGapY(Number(e.target.value))} className="w-full h-8 px-3 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors" />
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}
