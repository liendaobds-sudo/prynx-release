/**
 * RecipePanel — Panel "Quy trình đã lưu": liệt kê, phát lại, sửa tên, xóa,
 * export/import recipe, VÀ chỉnh sửa từng bước (xem/sửa tham số, xóa, đổi thứ tự,
 * bật/tắt phát lại).
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 9) + mở rộng quản lý bước.
 */
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Play, Trash2, Download, Upload, Pencil, X, Check, ChevronRight, ChevronDown, ArrowUp, ArrowDown, Eye, EyeOff } from 'lucide-react';
import { loadRecipes, deleteRecipe, saveRecipe, exportRecipeAsFile, importRecipeFromFile } from '../../lib/recipe/recipeStore';
import { isPlayableOp } from '../../lib/recipe/recipeRunners';
import { opBaseLabel, summarizeParams, isRecordableOp } from '../../lib/recipe/recipeOps';
import type { Recipe, RecipeStep } from '../../lib/recipe/recipeTypes';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/confirmDialog';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface Props {
    open: boolean;
    onClose: () => void;
    /** Phát lại recipe (ImpositionTab nối với PlaybackRunner). */
    onPlay: (recipe: Recipe) => Promise<void> | void;
    /** Số trang file đang mở (gợi ý recipe phù hợp). */
    sourcePageCount?: number;
    /** Có file đang mở hay không (để bật/tắt nút Phát lại). */
    hasFile: boolean;
}

// Nhãn bước được tính lại từ params sau khi sửa (đồng bộ với buildRecipeStep).
function stepLabel(step: RecipeStep): string {
    const summary = summarizeParams(step.opId, step.params);
    return summary ? `${opBaseLabel(step.opId)} — ${summary}` : opBaseLabel(step.opId);
}

// Nhãn tiếng Việt cho các param key hay gặp (hiển thị thân thiện; key gốc vẫn giữ
// ở tooltip + logic sửa/phát lại). Key thiếu trong map → hiện nguyên tên gốc.
const PARAM_LABELS: Record<string, string> = {
    // Tạo đường cắt / bù xén tem
    productType: 'Loại sản phẩm', cutMode: 'Kiểu đường cắt', offsetMm: 'Dời mép (mm)',
    cornerStyle: 'Kiểu góc', fillHoles: 'Lấp lỗ thủng', bleedMm: 'Bù xén (mm)',
    removeWhiteBg: 'Bỏ nền trắng', trimWhiteEdge: 'Thiết lập cũ (đã vô hiệu)',
    bleedColorType: 'Kiểu màu bù xén', bleedColorHex: 'Màu bù xén', edgeBiteMm: 'Ăn mép (mm)',
    cutlineDenoise: 'Khử răng cưa (%)', curveTension: 'Độ bo cong (%)',
    // Bình bài
    sheetWidth: 'Rộng tờ in (mm)', sheetHeight: 'Cao tờ in (mm)', cols: 'Số cột', rows: 'Số hàng',
    bleed: 'Bù xén (mm)', gapX: 'Cách ngang (mm)', gapY: 'Cách dọc (mm)',
    marginTop: 'Lề trên (mm)', marginBottom: 'Lề dưới (mm)', marginLeft: 'Lề trái (mm)', marginRight: 'Lề phải (mm)',
    gridStrategy: 'Cách chia lưới', layoutType: 'Kiểu dàn trang', align: 'Căn chỉnh',
    targetQuantity: 'Số lượng cần in', imposerMode: 'Chế độ bình',
    // Prepress
    standard: 'Chuẩn PDF/X', conversions: 'Các phép chuyển màu', preset: 'Thiết lập sẵn',
    icc_profile: 'Hồ sơ màu ICC', rendering_intent: 'Ý đồ tái tạo màu', preserve_black: 'Giữ đen thuần',
    image_dpi: 'DPI ảnh', strip_metadata: 'Xóa metadata', grayscale: 'Chuyển đen trắng',
    spot_name: 'Tên màu spot',
    // Co giãn / xáo trộn / tách / ghép
    targetW: 'Rộng đích (mm)', targetH: 'Cao đích (mm)', scaleMode: 'Kiểu co giãn',
    mode: 'Chế độ', specialAction: 'Thao tác đặc biệt', presetId: 'Mã thiết lập',
};

function paramLabel(name: string): string {
    return tv(PARAM_LABELS[name] || name);
}

// ── Ô sửa 1 tham số (suy kiểu theo giá trị). Object/Array → JSON textarea. ──
function ParamField({ name, value, onChange }: { name: string; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation();
    // RECIPE (audit 2026-08-17 §STORE.6): null = chưa gõ dở; '' phải giữ được để xóa
    // trắng (dùng ?? thay vì || để chuỗi rỗng không bị thay bằng giá trị cũ).
    const [jsonText, setJsonText] = useState<string | null>(null);
    const [jsonErr, setJsonErr] = useState(false);
    // RECIPE (audit 2026-08-17 §STORE.5): buffer chuỗi cho ô số để gõ được số âm/thập
    // phân và xóa trắng mà KHÔNG bị ép về 0 rồi lưu ngay mỗi phím. null = chưa gõ dở.
    const [numText, setNumText] = useState<string | null>(null);

    if (typeof value === 'boolean') {
        return (
            <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-300">
                <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
                <span title={name}>{paramLabel(name)}</span>
            </label>
        );
    }
    if (typeof value === 'number') {
        const display = numText ?? String(value);
        return (
            <label className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-slate-500 dark:text-zinc-400 w-28 truncate" title={name}>{paramLabel(name)}</span>
                <input
                    type="text"
                    inputMode="decimal"
                    value={display}
                    onChange={e => {
                        const raw = e.target.value;
                        setNumText(raw);
                        // Chỉ commit khi là số hữu hạn; '', '-', '0.', '-0.' KHÔNG ép 0.
                        const n = Number(raw);
                        if (raw.trim() !== '' && Number.isFinite(n)) onChange(n);
                    }}
                    onBlur={() => {
                        const n = Number(numText);
                        // Rời ô mà chuỗi rỗng/không hợp lệ → giữ nguyên giá trị cũ, không hóa 0.
                        if (numText !== null && numText.trim() !== '' && Number.isFinite(n)) {
                            onChange(n);
                        }
                        setNumText(null);
                    }}
                    className="flex-1 h-6 px-1.5 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 text-right" />
            </label>
        );
    }
    if (typeof value === 'string') {
        return (
            <label className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-slate-500 dark:text-zinc-400 w-28 truncate" title={name}>{paramLabel(name)}</span>
                <input type="text" value={value} onChange={e => onChange(e.target.value)}
                    className="flex-1 h-6 px-1.5 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100" />
            </label>
        );
    }
    // Object / Array / null → JSON (buffer cục bộ, parse khi blur)
    const display = jsonText ?? JSON.stringify(value);
    return (
        <div className="flex items-start gap-2 text-[11px]">
            <span className="font-mono text-slate-500 dark:text-zinc-400 w-28 truncate pt-1" title={name}>{paramLabel(name)}</span>
            <textarea
                value={display}
                onChange={e => { setJsonText(e.target.value); setJsonErr(false); }}
                onBlur={() => {
                    if (jsonText === null) return;
                    try { onChange(JSON.parse(jsonText)); setJsonErr(false); setJsonText(null); }
                    catch { setJsonErr(true); }
                }}
                rows={2}
                className={`flex-1 px-1.5 py-1 rounded border bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 font-mono ${jsonErr ? 'border-rose-500' : 'border-slate-300 dark:border-zinc-600'}`}
                title={jsonErr ? t('recipe.recipe:json_khong_hop_le_sua_lai') : 'JSON'} />
        </div>
    );
}

export default function RecipePanel({ open, onClose, onPlay, sourcePageCount, hasFile }: Props) {
  const { t } = useTranslation();
    const [recipes, setRecipes] = useState<Recipe[]>([]);
    const [loading, setLoading] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [playingId, setPlayingId] = useState<string | null>(null);
    // Bước đang mở chi tiết: khoá `${recipeId}:${index}`.
    const [expandedStep, setExpandedStep] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try { setRecipes(await loadRecipes()); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { if (open) refresh(); }, [open, refresh]);

    if (!open) return null;

    // Cập nhật steps của 1 recipe: optimistic local + lưu bền vững.
    const updateSteps = (r: Recipe, newSteps: RecipeStep[]) => {
        const updated: Recipe = { ...r, steps: newSteps, updatedAt: new Date().toISOString() };
        setRecipes(prev => prev.map(x => x.id === r.id ? updated : x));
        saveRecipe(updated).catch(() => toast.error(t('recipe.recipe:luu_thay_doi_that_bai')));
    };

    const moveStep = (r: Recipe, i: number, dir: -1 | 1) => {
        const j = i + dir;
        if (j < 0 || j >= r.steps.length) return;
        const s = [...r.steps];
        [s[i], s[j]] = [s[j], s[i]];
        updateSteps(r, s);
        setExpandedStep(null);
    };
    const removeStep = (r: Recipe, i: number) => {
        updateSteps(r, r.steps.filter((_, k) => k !== i));
        setExpandedStep(null);
    };
    const toggleStep = (r: Recipe, i: number) => {
        const step = r.steps[i];
        const next = !step.recordable;
        // RECIPE (audit 2026-08-17 §STORE.8): không cho BẬT phát lại cho op vốn phụ
        // thuộc file/vị trí — nếu về sau op đó có runner, Property 6 sẽ thủng và bước
        // chạy trên tài liệu khác. Chỉ cho tắt (recordable→false) là an toàn.
        if (next && !isRecordableOp(step.opId)) {
            toast.error(t('recipe.recipe:khong_bat_phat_lai_op_phu_thuoc'));
            return;
        }
        updateSteps(r, r.steps.map((s, k) => k === i ? { ...s, recordable: next } : s));
    };
    const setParam = (r: Recipe, i: number, key: string, value: unknown) =>
        updateSteps(r, r.steps.map((s, k) => {
            if (k !== i) return s;
            const params = { ...s.params, [key]: value };
            const next: RecipeStep = { ...s, params };
            next.label = stepLabel(next);
            return next;
        }));

    const handlePlay = async (r: Recipe) => {
        if (!hasFile) { toast.error(t('recipe.recipe:hay_mo_mot_file_pdf_truoc_khi_phat_lai')); return; }
        setPlayingId(r.id);
        try { await onPlay(r); }
        finally { setPlayingId(null); }
    };

    const handleDelete = async (r: Recipe) => {
        const ok = await confirmDialog({ message: `Xóa quy trình "${r.name}"?`, danger: true });
        if (!ok) return;
        // RECIPE (audit 2026-08-17 §STORE.1): deleteRecipe fail-loud → chỉ báo thành
        // công khi xóa thật sự xảy ra; lỗi thì báo đúng và vẫn refresh để phản ánh đĩa.
        try {
            await deleteRecipe(r.id);
            toast.success(t('recipe.recipe:da_xoa_quy_trinh'));
        } catch {
            toast.error(t('recipe.recipe:xoa_that_bai'));
        }
        refresh();
    };

    const handleRename = async (r: Recipe) => {
        const trimmed = editName.trim();
        if (!trimmed) { setEditingId(null); return; }
        // §STORE.2: saveRecipe fail-loud → báo lỗi nếu ghi đĩa thất bại thay vì im lặng.
        try {
            await saveRecipe({ ...r, name: trimmed });
        } catch {
            toast.error(t('recipe.recipe:luu_thay_doi_that_bai'));
        }
        setEditingId(null);
        refresh();
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        // RECIPE (audit 2026-08-17 §STORE.3/§STORE.4): hiện đúng nguyên nhân (schema
        // mới/opId lạ/quota) thay vì gộp mọi lỗi thành "file không hợp lệ".
        try {
            const imported = await importRecipeFromFile(file);
            toast.success(t('recipe.recipe:da_nhap_quy_trinh', { name: imported.name }));
            refresh();
        } catch (err) {
            toast.error(err instanceof Error && err.message
                ? err.message
                : t('recipe.recipe:file_quy_trinh_khong_hop_le'));
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="w-[600px] max-w-[94vw] max-h-[82vh] flex flex-col bg-white dark:bg-zinc-900 rounded-xl shadow-2xl ring-1 ring-black/10 dark:ring-white/10 overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/10">
                    <h3 className="text-sm font-semibold text-slate-800 dark:text-zinc-100">{t('recipe.recipe:quy_trinh_da_luu')}</h3>
                    <div className="flex items-center gap-1">
                        <label className="w-7 h-7 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500 dark:text-zinc-400 rounded cursor-pointer transition-colors" title={t('recipe.recipe:nhap_quy_trinh_tu_file')}>
                            <Upload className="w-4 h-4" />
                            <input type="file" accept="application/json,.json" className="hidden" onChange={handleImport} />
                        </label>
                        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 rounded transition-colors" aria-label={t('recipe.recipe:dong')}>
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto scroller-thin p-3 space-y-2">
                    {loading ? (
                        <div className="text-center text-[12px] text-slate-400 py-8">{t('recipe.recipe:dang_tai')}</div>
                    ) : recipes.length === 0 ? (
                        <div className="text-center text-[12px] text-slate-400 dark:text-zinc-500 py-10">
                            {t('recipe.recipe:chua_co_quy_trinh_nao')}<br />
                            {t('recipe.recipe:bam')} <span className="text-rose-500 font-medium">{t('recipe.recipe:ghi_quy_trinh')}</span> {t('recipe.recipe:tren_thanh_cong_cu_de_tao')}
                        </div>
                    ) : (
                        recipes.map(r => {
                            const playableCount = r.steps.filter(s => s.recordable && isPlayableOp(s.opId)).length;
                            const matchesPage = sourcePageCount != null && r.hints?.sourcePageCount === sourcePageCount;
                            return (
                                <div key={r.id} className="rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50/60 dark:bg-zinc-800/40 overflow-hidden">
                                    <div className="flex items-center gap-2 px-3 py-2">
                                        <div className="flex-1 min-w-0">
                                            {editingId === r.id ? (
                                                <div className="flex items-center gap-1">
                                                    <input
                                                        autoFocus
                                                        value={editName}
                                                        onChange={e => setEditName(e.target.value)}
                                                        onKeyDown={e => { if (e.key === 'Enter') handleRename(r); if (e.key === 'Escape') setEditingId(null); }}
                                                        className="flex-1 px-2 py-1 text-[13px] rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                                    />
                                                    <button onClick={() => handleRename(r)} className="w-6 h-6 flex items-center justify-center text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded" aria-label={t('recipe.recipe:luu_ten')}>
                                                        <Check className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[13px] font-medium text-slate-800 dark:text-zinc-100 truncate">{r.name}</span>
                                                    {matchesPage && (
                                                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400" title={t('recipe.recipe:khop_so_trang_file_dang_mo')}>
                                                            {t('recipe.recipe:phu_hop')}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                            <div className="text-[11px] text-slate-400 dark:text-zinc-500 mt-0.5">
                                                {r.steps.length} bước · {playableCount} phát lại được
                                                {r.hints?.sourcePageCount ? ` · ${r.hints.sourcePageCount} trang` : ''}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-0.5 shrink-0">
                                            <button
                                                onClick={() => handlePlay(r)}
                                                disabled={playingId !== null}
                                                className="h-7 px-2 flex items-center gap-1 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-medium transition-colors disabled:opacity-60"
                                                title={t('recipe.recipe:phat_lai_quy_trinh_tren_file_dang_mo')}
                                            >
                                                <Play className="w-3 h-3 fill-current" />
                                                {playingId === r.id ? t('recipe.recipe:dang_chay') : t('recipe.recipe:phat_lai')}
                                            </button>
                                            <button onClick={() => { setEditingId(r.id); setEditName(r.name); }} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" title={t('recipe.recipe:sua_ten')} aria-label={t('recipe.recipe:sua_ten')}>
                                                <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => exportRecipeAsFile(r)} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" title={t('recipe.recipe:xuat_file')} aria-label={t('recipe.recipe:xuat_file')}>
                                                <Download className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => handleDelete(r)} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded transition-colors" title={t('recipe.recipe:xoa')} aria-label={t('recipe.recipe:xoa')}>
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>

                                    <ol className="px-2 pb-2 space-y-0.5">
                                        {r.steps.map((s, i) => {
                                            const playable = s.recordable && isPlayableOp(s.opId);
                                            const key = `${r.id}:${i}`;
                                            const isOpen = expandedStep === key;
                                            const paramKeys = Object.keys(s.params || {});
                                            return (
                                                <li key={i} className="rounded border border-transparent hover:border-slate-200 dark:hover:border-zinc-700">
                                                    <div className="flex items-center gap-1.5 text-[11px] px-1 py-0.5">
                                                        <button
                                                            onClick={() => setExpandedStep(isOpen ? null : key)}
                                                            className="w-4 h-4 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
                                                            title={isOpen ? t('recipe.recipe:thu_gon') : t('recipe.recipe:xem_sua_tham_so')}
                                                        >
                                                            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                                        </button>
                                                        <span className="text-slate-300 dark:text-zinc-600 tabular-nums w-4 text-right">{i + 1}</span>
                                                        <span className={`flex-1 truncate ${s.recordable ? 'text-slate-600 dark:text-zinc-300' : 'text-slate-400 dark:text-zinc-500 line-through'}`}>
                                                            {s.label}
                                                        </span>
                                                        {!playable && <span className="shrink-0 text-[10px] text-amber-500">{t('recipe.recipe:bo_qua')}</span>}
                                                        <div className="flex items-center gap-0.5 shrink-0">
                                                            <button onClick={() => toggleStep(r, i)} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 rounded" title={s.recordable ? t('recipe.recipe:tat_phat_lai_buoc_nay') : t('recipe.recipe:bat_phat_lai_buoc_nay')}>
                                                                {s.recordable ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                                            </button>
                                                            <button onClick={() => moveStep(r, i, -1)} disabled={i === 0} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 rounded disabled:opacity-30" title={t('recipe.recipe:len')}><ArrowUp className="w-3 h-3" /></button>
                                                            <button onClick={() => moveStep(r, i, 1)} disabled={i === r.steps.length - 1} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 rounded disabled:opacity-30" title={t('recipe.recipe:xuong')}><ArrowDown className="w-3 h-3" /></button>
                                                            <button onClick={() => removeStep(r, i)} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-rose-600 rounded" title={t('recipe.recipe:xoa_buoc')}><Trash2 className="w-3 h-3" /></button>
                                                        </div>
                                                    </div>
                                                    {isOpen && (
                                                        <div className="ml-6 mr-1 mb-1 mt-0.5 p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 space-y-1.5">
                                                            {paramKeys.length === 0 ? (
                                                                <div className="text-[11px] text-slate-400">{t('recipe.recipe:buoc_nay_khong_co_tham_so')}</div>
                                                            ) : paramKeys.map(k => (
                                                                <ParamField key={k} name={k} value={(s.params as any)[k]}
                                                                    onChange={(v) => setParam(r, i, k, v)} />
                                                            ))}
                                                            <p className="text-[10px] text-slate-400 pt-1">{t('recipe.recipe:sua_tham_so_nang_cao_nhap_sai_co_the')}</p>
                                                        </div>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ol>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
