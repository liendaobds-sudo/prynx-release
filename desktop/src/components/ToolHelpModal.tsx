import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ToolHelp } from '../lib/toolHelp';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';

interface Props {
  help: ToolHelp;
  icon?: string;
  onClose: () => void;
}

/**
 * ToolHelpModal — Modal giới thiệu chi tiết một công cụ.
 * Dùng chung cho mọi tool; nội dung lấy từ lib/toolHelp.
 */
export default function ToolHelpModal({ help, icon, onClose }: Props) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 shadow-2xl animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-4 border-b border-slate-100 dark:border-white/10 sticky top-0 bg-white dark:bg-zinc-900 rounded-t-2xl">
          {icon && <div className="text-[28px] leading-none shrink-0">{icon}</div>}
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-bold text-slate-900 dark:text-white leading-tight">{tv(help.title)}</h2>
            <p className="text-[12px] text-slate-500 dark:text-zinc-400 mt-0.5 leading-snug">{tv(help.tagline)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t('misc.toolHelp:dong_esc')}
            className="shrink-0 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {help.sections.map((sec, i) => (
            <div key={i}>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-1.5">{tv(sec.heading)}</h3>
              <ul className="space-y-1.5">
                {sec.items.map((it, j) => (
                  <li key={j} className="flex gap-2 text-[12.5px] text-slate-700 dark:text-zinc-200 leading-snug">
                    <span className="text-indigo-400 shrink-0 mt-0.5">•</span>
                    <span>{tv(it)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {help.printNote && (
            <div className="flex gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-700/40">
              <span className="text-[14px] shrink-0">🖨️</span>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 mb-0.5">Offset / In nhanh</div>
                <p className="text-[12px] text-amber-800 dark:text-amber-200 leading-snug">{help.printNote}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
