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
import { opBaseLabel, summarizeParams } from '../../lib/recipe/recipeOps';
import type { Recipe, RecipeStep } from '../../lib/recipe/recipeTypes';
import { toast } from '../ui/Toast';
import { confirmDialog } from '../ui/confirmDialog';

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

// ── Ô sửa 1 tham số (suy kiểu theo giá trị). Object/Array → JSON textarea. ──
function ParamField({ name, value, onChange }: { name: string; value: unknown; onChange: (v: unknown) => void }) {
    const [jsonText, setJsonText] = useState('');
    const [jsonErr, setJsonErr] = useState(false);

    if (typeof value === 'boolean') {
        return (
            <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-300">
                <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
                <span className="font-mono">{name}</span>
            </label>
        );
    }
    if (typeof value === 'number') {
        return (
            <label className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-slate-500 dark:text-zinc-400 w-28 truncate" title={name}>{name}</span>
                <input type="number" value={value}
                    onChange={e => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
                    className="flex-1 h-6 px-1.5 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 text-right" />
            </label>
        );
    }
    if (typeof value === 'string') {
        return (
            <label className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-slate-500 dark:text-zinc-400 w-28 truncate" title={name}>{name}</span>
                <input type="text" value={value} onChange={e => onChange(e.target.value)}
                    className="flex-1 h-6 px-1.5 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100" />
            </label>
        );
    }
    // Object / Array / null → JSON (buffer cục bộ, parse khi blur)
    const display = jsonText || JSON.stringify(value);
    return (
        <div className="flex items-start gap-2 text-[11px]">
            <span className="font-mono text-slate-500 dark:text-zinc-400 w-28 truncate pt-1" title={name}>{name}</span>
            <textarea
                value={display}
                onChange={e => { setJsonText(e.target.value); setJsonErr(false); }}
                onBlur={() => {
                    if (!jsonText) return;
                    try { onChange(JSON.parse(jsonText)); setJsonErr(false); setJsonText(''); }
                    catch { setJsonErr(true); }
                }}
                rows={2}
                className={`flex-1 px-1.5 py-1 rounded border bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 font-mono ${jsonErr ? 'border-rose-500' : 'border-slate-300 dark:border-zinc-600'}`}
                title={jsonErr ? 'JSON không hợp lệ — sửa lại' : 'JSON'} />
        </div>
    );
}

export default function RecipePanel({ open, onClose, onPlay, sourcePageCount, hasFile }: Props) {
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
        saveRecipe(updated).catch(() => toast.error('Lưu thay đổi thất bại.'));
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
    const toggleStep = (r: Recipe, i: number) =>
        updateSteps(r, r.steps.map((s, k) => k === i ? { ...s, recordable: !s.recordable } : s));
    const setParam = (r: Recipe, i: number, key: string, value: unknown) =>
        updateSteps(r, r.steps.map((s, k) => {
            if (k !== i) return s;
            const params = { ...s.params, [key]: value };
            const next: RecipeStep = { ...s, params };
            next.label = stepLabel(next);
            return next;
        }));

    const handlePlay = async (r: Recipe) => {
        if (!hasFile) { toast.error('Hãy mở một file PDF trước khi phát lại.'); return; }
        setPlayingId(r.id);
        try { await onPlay(r); }
        finally { setPlayingId(null); }
    };

    const handleDelete = async (r: Recipe) => {
        const ok = await confirmDialog({ message: `Xóa quy trình "${r.name}"?`, danger: true });
        if (!ok) return;
        await deleteRecipe(r.id);
        toast.success('Đã xóa quy trình.');
        refresh();
    };

    const handleRename = async (r: Recipe) => {
        const trimmed = editName.trim();
        if (!trimmed) { setEditingId(null); return; }
        await saveRecipe({ ...r, name: trimmed });
        setEditingId(null);
        refresh();
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const imported = await importRecipeFromFile(file);
        if (imported) { toast.success(`Đã nhập quy trình "${imported.name}".`); refresh(); }
        else toast.error('File quy trình không hợp lệ.');
    };

    return createPortal(
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="w-[600px] max-w-[94vw] max-h-[82vh] flex flex-col bg-white dark:bg-zinc-900 rounded-xl shadow-2xl ring-1 ring-black/10 dark:ring-white/10 overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/10">
                    <h3 className="text-sm font-semibold text-slate-800 dark:text-zinc-100">Quy trình đã lưu</h3>
                    <div className="flex items-center gap-1">
                        <label className="w-7 h-7 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500 dark:text-zinc-400 rounded cursor-pointer transition-colors" title="Nhập quy trình từ file">
                            <Upload className="w-4 h-4" />
                            <input type="file" accept="application/json,.json" className="hidden" onChange={handleImport} />
                        </label>
                        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 rounded transition-colors" aria-label="Đóng">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto scroller-thin p-3 space-y-2">
                    {loading ? (
                        <div className="text-center text-[12px] text-slate-400 py-8">Đang tải...</div>
                    ) : recipes.length === 0 ? (
                        <div className="text-center text-[12px] text-slate-400 dark:text-zinc-500 py-10">
                            Chưa có quy trình nào.<br />
                            Bấm <span className="text-rose-500 font-medium">Ghi quy trình</span> trên thanh công cụ để tạo.
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
                                                    <button onClick={() => handleRename(r)} className="w-6 h-6 flex items-center justify-center text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded" aria-label="Lưu tên">
                                                        <Check className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[13px] font-medium text-slate-800 dark:text-zinc-100 truncate">{r.name}</span>
                                                    {matchesPage && (
                                                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400" title="Khớp số trang file đang mở">
                                                            phù hợp
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
                                                title="Phát lại quy trình trên file đang mở"
                                            >
                                                <Play className="w-3 h-3 fill-current" />
                                                {playingId === r.id ? 'Đang chạy...' : 'Phát lại'}
                                            </button>
                                            <button onClick={() => { setEditingId(r.id); setEditName(r.name); }} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" title="Sửa tên" aria-label="Sửa tên">
                                                <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => exportRecipeAsFile(r)} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" title="Xuất file" aria-label="Xuất file">
                                                <Download className="w-3.5 h-3.5" />
                                            </button>
                                            <button onClick={() => handleDelete(r)} className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded transition-colors" title="Xóa" aria-label="Xóa">
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
                                                            title={isOpen ? 'Thu gọn' : 'Xem / sửa tham số'}
                                                        >
                                                            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                                        </button>
                                                        <span className="text-slate-300 dark:text-zinc-600 tabular-nums w-4 text-right">{i + 1}</span>
                                                        <span className={`flex-1 truncate ${s.recordable ? 'text-slate-600 dark:text-zinc-300' : 'text-slate-400 dark:text-zinc-500 line-through'}`}>
                                                            {s.label}
                                                        </span>
                                                        {!playable && <span className="shrink-0 text-[10px] text-amber-500">bỏ qua</span>}
                                                        <div className="flex items-center gap-0.5 shrink-0">
                                                            <button onClick={() => toggleStep(r, i)} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 rounded" title={s.recordable ? 'Tắt phát lại bước này' : 'Bật phát lại bước này'}>
                                                                {s.recordable ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                                            </button>
                                                            <button onClick={() => moveStep(r, i, -1)} disabled={i === 0} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 rounded disabled:opacity-30" title="Lên"><ArrowUp className="w-3 h-3" /></button>
                                                            <button onClick={() => moveStep(r, i, 1)} disabled={i === r.steps.length - 1} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-indigo-600 rounded disabled:opacity-30" title="Xuống"><ArrowDown className="w-3 h-3" /></button>
                                                            <button onClick={() => removeStep(r, i)} className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-rose-600 rounded" title="Xóa bước"><Trash2 className="w-3 h-3" /></button>
                                                        </div>
                                                    </div>
                                                    {isOpen && (
                                                        <div className="ml-6 mr-1 mb-1 mt-0.5 p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 space-y-1.5">
                                                            {paramKeys.length === 0 ? (
                                                                <div className="text-[11px] text-slate-400">Bước này không có tham số.</div>
                                                            ) : paramKeys.map(k => (
                                                                <ParamField key={k} name={k} value={(s.params as any)[k]}
                                                                    onChange={(v) => setParam(r, i, k, v)} />
                                                            ))}
                                                            <p className="text-[10px] text-slate-400 pt-1">Sửa tham số nâng cao — nhập sai có thể khiến bước phát lại lỗi.</p>
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
