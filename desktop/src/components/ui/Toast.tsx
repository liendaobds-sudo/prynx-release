import { useEffect, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (type: ToastType, message: string) => number;
  dismiss: (id: number) => void;
}

let _seq = 0;

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (type, message) => {
    const id = ++_seq;
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const AUTO_DISMISS_MS = 4000;

function emit(type: ToastType, message: string): number {
  return useToastStore.getState().push(type, message);
}

/**
 * Toast API dùng chung cho toàn app. Thay thế alert() native.
 *   toast.success('✅ Đã lưu...')
 *   toast.error('Lỗi: ...')
 *   toast.info('Vui lòng nhập ...')
 */
export const toast = {
  success: (message: string) => emit('success', message),
  error: (message: string) => emit('error', message),
  info: (message: string) => emit('info', message),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
};

const TYPE_STYLES: Record<ToastType, { bar: string; Icon: ComponentType<{ className?: string }>; iconColor: string }> = {
  success: { bar: 'border-l-4 border-emerald-500', Icon: Check, iconColor: 'text-emerald-500' },
  error: { bar: 'border-l-4 border-rose-500', Icon: AlertTriangle, iconColor: 'text-rose-500' },
  info: { bar: 'border-l-4 border-amber-500', Icon: Info, iconColor: 'text-amber-500' },
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    const t = setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [item.id, dismiss]);

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
      </span>
      <button
        onClick={() => dismiss(item.id)}
        className="shrink-0 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-200 transition-colors leading-none focus:outline-none"
        title="Đóng"
        aria-label="Đóng thông báo"
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
