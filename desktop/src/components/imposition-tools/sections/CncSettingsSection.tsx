/**
 * CncSettingsSection — cấu hình riêng cho công cụ Bình Bế Rớt (CNC).
 *
 * Hiển thị khi activeTool === 'cnc_imposer':
 *   - In 2 mặt (checkbox) + Cạnh lật (Cạnh dài / Cạnh ngắn) + xem trước ghép cặp.
 * Boong định vị (pont) chọn ở mục "BOONG ĐỊNH VỊ" — CNC chỉ in boong ở Mặt trước + Khuôn.
 * spec: binh-be-rot-cnc — Yêu cầu 2, 3.
 */
import { useState } from 'react';

type FlipEdge = 'long' | 'short';

interface Props {
    twoSided: boolean;
    setTwoSided: (v: boolean) => void;
    cncFlipEdge: FlipEdge;
    setCncFlipEdge: (v: FlipEdge) => void;
    cncDuplexMarks: boolean;
    setCncDuplexMarks: (v: boolean) => void;
    sourceTotalPages?: number;
}

export default function CncSettingsSection({
    twoSided, setTwoSided,
    cncFlipEdge, setCncFlipEdge,
    cncDuplexMarks, setCncDuplexMarks,
    sourceTotalPages = 0,
}: Props) {
    const [showInfo, setShowInfo] = useState(false);

    const oddWarning = twoSided && sourceTotalPages > 0 && sourceTotalPages % 2 !== 0;

    return (
        <div className="rounded-lg border border-orange-200 dark:border-orange-500/30 bg-orange-50/40 dark:bg-orange-500/5 p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-orange-700 dark:text-orange-300">
                    🔻 Bình 2 mặt (lật gương)
                </span>
                <button type="button" onClick={() => setShowInfo(v => !v)}
                    className="text-orange-500 hover:text-orange-700 text-sm" title="Hướng dẫn">ⓘ</button>
            </div>

            {showInfo && (
                <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300 bg-white/60 dark:bg-slate-800/40 rounded p-2">
                    Bật <b>In 2 mặt</b> để ghép cặp theo thứ tự trang (trang 1 = Mặt trước, trang 2 = Mặt sau…).
                    Mặt sau được <b>lật gương</b> để khi lật giấy in mặt 2 thì các ô bế chồng khít mặt 1.
                    Mỗi cặp xuất 3 trang: <b>Mặt trước → Mặt sau → Khuôn</b>. Boong định vị (mục
                    <b> BOONG ĐỊNH VỊ</b>) chỉ in ở <b>Mặt trước & Khuôn</b>, Mặt sau không có.
                </p>
            )}

            {/* In 2 mặt — nguồn duy nhất (điều khiển duplexFlow ngầm; số lượng ghép theo cặp) */}
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer">
                <input type="checkbox" checked={twoSided}
                    onChange={e => setTwoSided(e.target.checked)}
                    className="accent-orange-600 w-4 h-4" />
                In 2 mặt (lật gương mặt sau)
            </label>

            {/* Cạnh lật */}
            {twoSided && (
                <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-300 min-w-[64px]">Cạnh lật</span>
                    <select value={cncFlipEdge} onChange={e => setCncFlipEdge(e.target.value as FlipEdge)}
                        className="flex-1 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs">
                        <option value="long">Cạnh dài (long-edge) — mặc định</option>
                        <option value="short">Cạnh ngắn (short-edge)</option>
                    </select>
                </div>
            )}

            {/* Dấu canh in 2 mặt (KHÁC boong) — vẽ ở cả 2 mặt để canh chồng */}
            {twoSided && (
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer"
                    title="Dấu tròn + chữ thập ở 4 cạnh, vẽ ở CẢ Mặt trước và Mặt sau để canh chồng khi in lật giấy. Khác với boong định vị (dùng cho máy cắt).">
                    <input type="checkbox" checked={cncDuplexMarks}
                        onChange={e => setCncDuplexMarks(e.target.checked)}
                        className="accent-orange-600 w-4 h-4" />
                    Dấu canh in 2 mặt (vẽ cả 2 mặt)
                </label>
            )}

            {/* Cảnh báo trang lẻ (bỏ phần xem trước ghép cặp theo yêu cầu) */}
            {oddWarning && (
                <div className="text-[11px] text-red-600 dark:text-red-400">
                    ⚠️ File có {sourceTotalPages} trang (lẻ) — bình 2 mặt cần số trang CHẴN.
                </div>
            )}
        </div>
    );
}
