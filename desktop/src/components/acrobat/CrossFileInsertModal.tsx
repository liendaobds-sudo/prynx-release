import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogLifecycle } from './AcrobatModals';

export type CrossFileInsertPos = 'start' | 'end' | 'before' | 'after';

export interface CrossFileInsertPending {
    targetPdfUrl: string;
    targetTabId?: string;
    targetName: string;
    targetNumPages: number;
    mode: 'copy' | 'move';
    sourcePageNums: number[];
    sourceIndices: number[];
}

interface Props {
    pending: CrossFileInsertPending | null;
    onConfirm: (dropIndex: number) => void;
    onCancel: () => void;
}

/**
 * Hỏi vị trí chèn khi copy/di chuyển trang sang file khác:
 * đầu file / cuối file / trước trang N / sau trang N.
 */
export function CrossFileInsertModal({ pending, onConfirm, onCancel }: Props) {
    const { t } = useTranslation();
    const dialogRef = useDialogLifecycle(onCancel, Boolean(pending));
    const [pos, setPos] = useState<CrossFileInsertPos>('end');
    const [pageNum, setPageNum] = useState(1);

    useEffect(() => {
        if (!pending) return;
        setPos('end');
        const n = Math.max(1, pending.targetNumPages || 1);
        setPageNum(Math.min(n, Math.max(1, pending.targetNumPages || 1)));
    }, [pending]);

    if (!pending) return null;

    const maxPage = Math.max(1, pending.targetNumPages || 1);
    const hasPages = pending.targetNumPages > 0;

    const resolveDropIndex = (): number => {
        const n = pending.targetNumPages || 0;
        if (n <= 0) return 0;
        const p = Math.max(1, Math.min(maxPage, pageNum || 1));
        switch (pos) {
            case 'start':
                return 0;
            case 'end':
                return n;
            case 'before':
                return p - 1; // trước trang p (1-based) → index p-1
            case 'after':
                return p; // sau trang p → index p
            default:
                return n;
        }
    };

    const title = pending.mode === 'move'
        ? t('misc.acrobatViewer:chen_di_chuyen_sang')
        : t('misc.acrobatViewer:chen_copy_sang');

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="prynx-cross-file-insert-title"
                data-prynx-modal="true"
                tabIndex={-1}
                className="bg-white dark:bg-zinc-800 p-5 rounded-xl shadow-2xl max-w-md w-full mx-4 border border-slate-200 dark:border-white/10"
                onClick={e => e.stopPropagation()}
            >
                <h3 id="prynx-cross-file-insert-title" className="text-base font-bold text-slate-900 dark:text-white mb-1">{title}</h3>
                <p className="text-[13px] text-slate-600 dark:text-zinc-300 mb-4">
                    <span className="font-semibold text-indigo-600 dark:text-indigo-400 break-all">{pending.targetName}</span>
                    {hasPages && (
                        <span className="text-slate-400 dark:text-zinc-500">
                            {' '}· {t('misc.acrobatViewer:so_trang_dich', { n: pending.targetNumPages })}
                        </span>
                    )}
                </p>

                <div className="flex flex-col gap-2 mb-5">
                    <label className="flex items-center gap-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 cursor-pointer">
                        <input type="radio" name="cf-pos" checked={pos === 'start'} onChange={() => setPos('start')} className="text-indigo-600" />
                        {t('misc.acrobatViewer:vi_tri_dau_file')}
                    </label>
                    <label className="flex items-center gap-2 text-[13px] font-medium text-slate-700 dark:text-zinc-200 cursor-pointer">
                        <input type="radio" name="cf-pos" checked={pos === 'end'} onChange={() => setPos('end')} className="text-indigo-600" />
                        {t('misc.acrobatViewer:vi_tri_cuoi_file')}
                    </label>
                    <label className={`flex items-center gap-2 text-[13px] font-medium cursor-pointer ${hasPages ? 'text-slate-700 dark:text-zinc-200' : 'text-slate-400'}`}>
                        <input type="radio" name="cf-pos" checked={pos === 'before'} onChange={() => setPos('before')} disabled={!hasPages} className="text-indigo-600" />
                        {t('misc.acrobatViewer:vi_tri_truoc_trang')}
                        <input
                            type="number"
                            min={1}
                            max={maxPage}
                            value={pageNum}
                            disabled={!hasPages || (pos !== 'before' && pos !== 'after')}
                            onChange={e => setPageNum(Number(e.target.value) || 1)}
                            onFocus={() => hasPages && setPos(pos === 'after' ? 'after' : 'before')}
                            className="w-16 h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm disabled:opacity-40"
                        />
                    </label>
                    <label className={`flex items-center gap-2 text-[13px] font-medium cursor-pointer ${hasPages ? 'text-slate-700 dark:text-zinc-200' : 'text-slate-400'}`}>
                        <input type="radio" name="cf-pos" checked={pos === 'after'} onChange={() => setPos('after')} disabled={!hasPages} className="text-indigo-600" />
                        {t('misc.acrobatViewer:vi_tri_sau_trang')}
                        <input
                            type="number"
                            min={1}
                            max={maxPage}
                            value={pageNum}
                            disabled={!hasPages || (pos !== 'before' && pos !== 'after')}
                            onChange={e => setPageNum(Number(e.target.value) || 1)}
                            onFocus={() => hasPages && setPos(pos === 'before' ? 'before' : 'after')}
                            className="w-16 h-7 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm disabled:opacity-40"
                        />
                    </label>
                </div>

                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 text-[13px] font-semibold rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200"
                    >
                        {t('misc.acrobatViewer:huy')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onConfirm(resolveDropIndex())}
                        className="px-4 py-2 text-[13px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white"
                    >
                        {pending.mode === 'move'
                            ? t('misc.acrobatViewer:xac_nhan_di_chuyen')
                            : t('misc.acrobatViewer:xac_nhan_copy')}
                    </button>
                </div>
            </div>
        </div>
    );
}
