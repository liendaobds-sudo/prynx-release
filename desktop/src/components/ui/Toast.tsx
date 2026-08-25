import { useEffect, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, AlertTriangle, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ToastType = 'success' | 'error' | 'info';

/** UIUX (audit 2026-07-27 §D-11/M-3): toast có thể kèm 1 nút hành động (vd "Mở thư mục"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (type: ToastType, message: string, action?: ToastAction) => number;
  dismiss: (id: number) => void;
}

let _seq = 0;

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (type, message, action) => {
    const id = ++_seq;
    set((s) => ({ toasts: [...s.toasts, { id, type, message, action }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const AUTO_DISMISS_MS = 4000;
/* Toast có nút hành động cần thời gian để bấm — giữ lâu hơn toast thường */
const AUTO_DISMISS_ACTION_MS = 8000;

function emit(type: ToastType, message: string, action?: ToastAction): number {
  return useToastStore.getState().push(type, message, action);
}

/**
 * Toast API dùng chung cho toàn app. Thay thế alert() native.
 *   toast.success('✅ Đã lưu...')
 *   toast.error('Lỗi: ...')
 *   toast.info('Vui lòng nhập ...')
 *   toast.success('Đã lưu 5 file', { label: 'Mở thư mục', onClick: () => ... })
 */
// eslint-disable-next-line react-refresh/only-export-components -- LINT (audit 2026-08-23 §LINT.36): API và viewport phải dùng chung một Zustand store.
export const toast = {
  success: (message: string, action?: ToastAction) => emit('success', message, action),
  error: (message: string, action?: ToastAction) => emit('error', message, action),
  info: (message: string, action?: ToastAction) => emit('info', message, action),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};

const TYPE_STYLES: Record<ToastType, { bar: string; Icon: ComponentType<{ className?: string }>; iconColor: string }> = {
  success: { bar: 'border-l-4 border-emerald-500', Icon: Check, iconColor: 'text-emerald-500' },
  error: { bar: 'border-l-4 border-rose-500', Icon: AlertTriangle, iconColor: 'text-rose-500' },
  info: { bar: 'border-l-4 border-amber-500', Icon: Info, iconColor: 'text-amber-500' },
};

function ToastCard({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    const ms = item.action ? AUTO_DISMISS_ACTION_MS : AUTO_DISMISS_MS;
    const t = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(t);
  }, [item.id, item.action, dismiss]);

  const style = TYPE_STYLES[item.type];
  const Icon = style.Icon;

  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-start gap-3 w-80 max-w-[90vw] px-4 py-3 rounded-xl shadow-2xl bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-100 ring-1 ring-black/5 dark:ring-white/10 animate-fade-in ${style.bar}`}
    >
      <span className={`shrink-0 mt-0.5 ${style.iconColor}`}><Icon className="w-5 h-5" /></span>
      <span className="flex-1 text-[13px] font-medium leading-snug break-words whitespace-pre-line">
        {item.message}
        {item.action && (
          <button
            onClick={() => { item.action?.onClick(); dismiss(item.id); }}
            className="block mt-1.5 text-[12px] font-semibold text-app-accent hover:text-app-accent-hover underline underline-offset-2"
          >
            {item.action.label}
          </button>
        )}
      </span>
      <button
        onClick={() => dismiss(item.id)}
        className="shrink-0 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-200 transition-colors leading-none focus:outline-none"
        title={t('misc.toast:dong')}
        aria-label={t('misc.toast:dong_thong_bao')}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Mount 1 lần ở App root. Render toàn bộ toast qua portal ở góc dưới phải.
 */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);

  return createPortal(
    <div className="fixed bottom-4 right-4 z-toast flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>,
    document.body
  );
}
