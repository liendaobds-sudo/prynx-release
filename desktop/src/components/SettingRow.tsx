import React from "react";

interface SettingRowProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  control: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  variant?: 'card' | 'flat';
  hideBorder?: boolean;
}

export function SettingRow({ title, description, control, children, className, variant = 'card', hideBorder = false }: SettingRowProps) {
  const baseStyle = variant === 'flat' ? { padding: '16px 0' } : {};
  const flatClass = hideBorder ? '' : 'border-b border-black/5 dark:border-white/5';
  const baseClass = variant === 'card' 
    ? `bg-white dark:bg-zinc-900 p-4 rounded-xl border border-slate-200 dark:border-white/10 shadow-sm transition-colors ${className || ''}` 
    : `${flatClass} transition-colors ${className || ''}`;

  return (
    <div style={baseStyle} className={baseClass}>
      <div className="flex items-start sm:items-center justify-between gap-6">
        <div className="flex-1 pr-6">
          <div className="text-slate-800 dark:text-zinc-200 text-[15px] font-semibold tracking-wide transition-colors">{title}</div>
          {description && (
            <div className="text-[13px] text-slate-500 dark:text-zinc-400 mt-1.5 leading-relaxed transition-colors">
              {description}
            </div>
          )}
        </div>
        <div className="flex-shrink-0">
          {control}
        </div>
      </div>
      {children && (
        <div className="mt-4 pt-4 border-t border-slate-200 dark:border-white/10 flex flex-col gap-4 transition-colors">
          {children}
        </div>
      )}
    </div>
  );
}
