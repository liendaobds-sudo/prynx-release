/**
 * RecipeRecordControl — Nút Ghi/Dừng quy trình + badge trạng thái + dialog lưu.
 *
 * Spec: .kiro/specs/recipe-record-playback (Task 8).
 * Tự chứa: đọc recorder store, lưu qua recipeStore. Không phụ thuộc ImpositionTab.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Circle, Square, ListVideo, X } from 'lucide-react';
import { useRecipeRecorder, recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import { createRecipe } from '../../lib/recipe/recipeTypes';
import { saveRecipe } from '../../lib/recipe/recipeStore';
import { toast } from '../ui/Toast';
import type { RecipeStep } from '../../lib/recipe/recipeTypes';
import { useTranslation } from 'react-i18next';

interface Props {
    /** Tab sở hữu nút ghi; recorder dùng ID này để cô lập các workspace đang cùng mount. */
    tabId: string;
    /** Mở panel "Quy trình đã lưu". */
    onOpenPanel: () => void;
    /** Số trang file đang mở (gợi ý lưu vào recipe). */
    sourcePageCount?: number;
    /** Khóa bắt đầu phiên mới khi tab đang phát recipe hoặc chạy luồng độc quyền khác. */
    disabled?: boolean;
}

export default function RecipeRecordControl({
    tabId,
    onOpenPanel,
    sourcePageCount,
    disabled = false,
}: Props) {
  const { t } = useTranslation();
    const isRecording = useRecipeRecorder(
        state => state.isRecording && state.ownerTabId === tabId,
    );
    const isRecordingElsewhere = useRecipeRecorder(
        state => state.isRecording && state.ownerTabId !== tabId,
    );
    const draftCount = useRecipeRecorder(
        state => state.ownerTabId === tabId ? state.draftSteps.length : 0,
    );
    const [saveDialog, setSaveDialog] = useState<{ steps: RecipeStep[] } | null>(null);

    const handleToggle = () => {
        if (!isRecording) {
            if (recipeRecorder.start(tabId)) {
                toast.info(t('recipe.recipeRecordControl:bat_dau_ghi_quy_trinh_hay_thuc_hien_cac'));
            }
            return;
        }
        const steps = recipeRecorder.stop(tabId);
        if (!steps || steps.length === 0) {
            toast.info(t('recipe.recipeRecordControl:chua_ghi_duoc_buoc_nao_da_huy_phien_ghi'));
            return;
        }
        setSaveDialog({ steps });
    };

    return (
        <>
            <div className="flex items-center gap-1">
                <button
                    onClick={handleToggle}
                    disabled={isRecordingElsewhere || disabled}
                    className={`h-7 px-2 flex items-center gap-1.5 rounded text-[11px] font-medium transition-colors ${
                        isRecording
                            ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400'
                            : 'hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-500 dark:text-zinc-400'
                    } ${isRecordingElsewhere || disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    title={isRecording
                        ? t('recipe.recipeRecordControl:dung_ghi_luu_quy_trinh_recipe')
                        : t('recipe.recipeRecordControl:ghi_quy_trinh_recipe_tu_dong_luu_chuoi')}
                    aria-label={isRecording ? t('recipe.recipeRecordControl:dung_ghi_quy_trinh') : t('recipe.recipeRecordControl:ghi_quy_trinh')}
                >
                    {isRecording ? (
                        <>
                            <Square className="w-3 h-3 fill-current" />
                            <span className="tb-label">{t('recipe.recipeRecordControl:dung_ghi')}</span>
                            <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] leading-none">
                                {draftCount}
                            </span>
                        </>
                    ) : (
                        <>
                            <Circle className="w-3 h-3 text-rose-500 fill-rose-500" />
                            <span className="tb-label">{t('recipe.recipeRecordControl:ghi_quy_trinh')}</span>
                        </>
                    )}
                </button>

                <button
                    onClick={onOpenPanel}
                    className="w-7 h-7 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 text-slate-500 hover:text-indigo-600 dark:text-zinc-400 dark:hover:text-indigo-400 rounded transition-colors"
                    title={t('recipe.recipeRecordControl:quy_trinh_da_luu')}
                    aria-label={t('recipe.recipeRecordControl:quy_trinh_da_luu')}
                >
                    <ListVideo className="w-4 h-4" />
                </button>
            </div>

            {saveDialog && createPortal(
                <SaveRecipeDialog
                    steps={saveDialog.steps}
                    sourcePageCount={sourcePageCount}
                    onClose={() => setSaveDialog(null)}
                />,
                document.body,
            )}
        </>
    );
}

// ─────────────────────────── Dialog lưu recipe ───────────────────────────

function SaveRecipeDialog({ steps, sourcePageCount, onClose }: {
    steps: RecipeStep[];
    sourcePageCount?: number;
    onClose: () => void;
}) {
  const { t } = useTranslation();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [saving, setSaving] = useState(false);
    // RECIPE (audit 2026-08-17 §STORE.10): Enter có thể kích hoạt handleSave nhiều lần
    // TRƯỚC khi state `saving` kịp cập nhật (nút disable không chặn phím Enter ở input).
    // Ref guard chặn double-invoke → không tạo hai recipe trùng nội dung, id khác nhau.
    const savingRef = useRef(false);

    const handleSave = async () => {
        if (savingRef.current) return;
        const trimmed = name.trim();
        if (!trimmed) { toast.error(t('recipe.recipeRecordControl:vui_long_nhap_ten_quy_trinh')); return; }
        savingRef.current = true;
        setSaving(true);
        try {
            const recipe = createRecipe(trimmed, steps, {
                description: description.trim(),
                hints: sourcePageCount ? { sourcePageCount } : undefined,
            });
            await saveRecipe(recipe);
            toast.success(t('recipe.recipe:da_luu_quy_trinh', { name: trimmed, count: steps.length }));
            onClose();
        } catch (e: any) {
            toast.error(t('recipe.recipe:luu_that_bai', { msg: e?.message || e }));
        } finally {
            setSaving(false);
            savingRef.current = false;
        }
    };

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="w-[440px] max-w-[92vw] bg-white dark:bg-zinc-900 rounded-xl shadow-2xl ring-1 ring-black/10 dark:ring-white/10 overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/10">
                    <h3 className="text-sm font-semibold text-slate-800 dark:text-zinc-100">{t('recipe.recipeRecordControl:luu_quy_trinh')}</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200" aria-label={t('recipe.recipeRecordControl:dong')}>
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-4 space-y-3">
                    <div>
                        <label className="block text-[11px] font-medium text-slate-500 dark:text-zinc-400 mb-1">{t('recipe.recipeRecordControl:ten_quy_trinh')}</label>
                        <input
                            autoFocus
                            value={name}
                            onChange={e => setName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                            placeholder={t('recipe.recipeRecordControl:vd_booklet_16_trang_doa_nen_chuyen_mau')}
                            className="w-full px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                        />
                    </div>
                    <div>
                        <label className="block text-[11px] font-medium text-slate-500 dark:text-zinc-400 mb-1">{t('recipe.recipeRecordControl:mo_ta_tuy_chon')}</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={2}
                            className="w-full px-2.5 py-1.5 text-[13px] rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
                        />
                    </div>

                    <div>
                        <div className="text-[11px] font-medium text-slate-500 dark:text-zinc-400 mb-1">
                            {steps.length} bước đã ghi
                        </div>
                        <ol className="max-h-44 overflow-y-auto scroller-thin space-y-1 text-[12px]">
                            {steps.map((s, i) => (
                                <li key={i} className="flex items-center gap-2 px-2 py-1 rounded bg-slate-50 dark:bg-zinc-800/60">
                                    <span className="text-slate-400 dark:text-zinc-500 tabular-nums">{i + 1}.</span>
                                    <span className="flex-1 text-slate-700 dark:text-zinc-200 truncate">{s.label}</span>
                                    {!s.recordable && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400">
                                            {t('recipe.recipeRecordControl:khong_phat_lai')}
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </div>
                </div>

                <div className="flex justify-end gap-2 px-4 py-3 border-t border-black/5 dark:border-white/10">
                    <button
                        onClick={onClose}
                        className="px-3 py-1.5 text-[12px] rounded-lg text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                        {t('recipe.recipeRecordControl:huy')}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-3 py-1.5 text-[12px] rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors disabled:opacity-60"
                    >
                        {saving ? t('recipe.recipeRecordControl:dang_luu') : t('recipe.recipeRecordControl:luu_quy_trinh')}
                    </button>
                </div>
            </div>
        </div>
    );
}
