import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
  resolve: ((value: boolean) => void) | null;
  show: (options: ConfirmOptions) => Promise<boolean>;
  close: (value: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  resolve: null,
  show: (options) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options, resolve });
    }),
  close: (value) => {
    const { resolve } = get();
    if (resolve) resolve(value);
    set({ open: false, options: null, resolve: null });
  },
}));

/**
 * Hộp thoại xác nhận dùng chung. Thay thế confirm() native.
 * Trả về Promise<boolean>: true nếu xác nhận, false nếu hủy.
 *   if (!(await confirmDialog({ message: 'Xóa?', danger: true }))) return;
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().show(options);
}

/**
 * Mount 1 lần ở App root để confirmDialog() hoạt động ở mọi nơi.
 */
export function ConfirmDialogHost() {
  const { t } = useTranslation();
  const open = useConfirmStore((s) => s.open);
  const options = useConfirmStore((s) => s.options);
  const close = useConfirmStore((s) => s.close);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    // Focus nút xác nhận khi mở
    const t = setTimeout(() => confirmBtnRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(t);
    };
  }, [open, close]);

  if (!open || !options) return null;

  const danger = !!options.danger;

  return createPortal(
    <div
      className="fixed inset-0 z-confirm flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={() => close(false)}
    >
      <div
        className={`bg-white dark:bg-zinc-800 p-6 rounded-xl shadow-2xl max-w-sm w-full mx-4 border ${
          danger ? 'border-rose-500/30' : 'border-black/10 dark:border-white/10'
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {options.title && (
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">{options.title}</h3>
        )}
        <p className="text-sm text-slate-600 dark:text-zinc-300 mb-6 font-medium whitespace-pre-line break-words">
          {options.message}
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => close(false)}
            className="px-6 py-2.5 min-w-[100px] text-[15px] font-semibold rounded bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200 transition-colors focus:outline-none"
          >
            {options.cancelText || t('misc.confirmDialog:huy_bo')}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={() => close(true)}
            className={`px-6 py-2.5 min-w-[100px] text-[15px] font-bold rounded text-white transition-colors shadow-sm focus:outline-none ${
              danger ? 'bg-rose-500 hover:bg-rose-600' : 'bg-indigo-500 hover:bg-indigo-600'
            }`}
          >
            {options.confirmText || t('misc.confirmDialog:xac_nhan')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
