import React, { useState, useEffect } from 'react';

export const ToolSectionLabel = ({ children }: { children: React.ReactNode }) => (
    <label className="text-[13px] font-bold text-slate-800 dark:text-zinc-100 tracking-wide block mb-3 uppercase">{children}</label>
);

export const ToolDivider = () => (
    <div className="h-px bg-slate-200 dark:bg-white/10 w-full my-4" />
);

interface ToolCardOptionProps {
    selected: boolean;
    onClick: () => void;
    label: string;
    desc?: string;
    className?: string;
}

export const ToolCardOption = ({ selected, onClick, label, desc, className = '' }: ToolCardOptionProps) => (
    <button
        onClick={onClick}
        className={`text-left px-3 py-2.5 rounded-lg border text-[13px] transition-all flex flex-col items-start gap-0.5 ${className}
            ${selected
                ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300'
                : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300'}`}
    >
        <span className="truncate font-bold">{label}</span>
        {desc && <span className="text-[11px] text-slate-500 dark:text-zinc-400 leading-snug">{desc}</span>}
    </button>
);

interface ToolCheckboxOptionProps {
    selected: boolean;
    onClick: () => void;
    label: string;
    desc?: string;
}

export const ToolCheckboxOption = ({ selected, onClick, label, desc }: ToolCheckboxOptionProps) => (
    <button
        onClick={onClick}
        className={`w-full text-left px-3 py-2.5 rounded-lg border text-[13px] transition-all flex items-center gap-2
            ${selected
                ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300'
                : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-700 dark:text-zinc-300'}`}
    >
        <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${selected ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
            {selected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
        </div>
        <span className="flex-1 truncate">{label}</span>

        {desc && (
            <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                onClick={(e) => e.stopPropagation()}>
                ?
                <div className="absolute bottom-full mb-2 right-0 w-max max-w-[240px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[12px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words">
                    {desc}
                    <div className="absolute top-full right-3 w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1" />
                </div>
            </div>
        )}
    </button>
);

interface ToolNumberInputProps {
    label: string;
    value: number;
    onChange: (val: number) => void;
    suffix?: string;
    step?: number;
    min?: number;
    max?: number;
    className?: string;
}

export const ToolNumberInput = ({ label, value, onChange, suffix, step = 1, min, max, className = '' }: ToolNumberInputProps) => {
    const clamp = (v: number) => {
        let r = v;
        if (typeof min === 'number' && r < min) r = min;
        if (typeof max === 'number' && r > max) r = max;
        return r;
    };
    // Giữ chuỗi đang gõ trong state riêng để cho phép trạng thái nhập dở ("", "-", "1.")
    // mà KHÔNG nhảy về 0 (parseFloat("")||0 cũ ép về 0 ngay → không gõ được số âm/xoá
    // trắng). Chỉ propagate ra ngoài giá trị SỐ hợp lệ đã clamp. Khi `value` từ ngoài đổi
    // (vd clamp lúc restore vượt max), đồng bộ lại text nếu khác giá trị đang gõ.
    const [text, setText] = useState<string>(String(value));
    useEffect(() => {
        if (parseFloat(text) !== value) setText(String(value));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const commit = (raw: string) => {
        setText(raw);
        const n = parseFloat(raw);
        if (!isNaN(n)) onChange(clamp(n));
    };
    // Khi rời ô: nếu đang để trống/không hợp lệ → chốt về min (hoặc 0) để không kẹt rỗng.
    const handleBlur = () => {
        const n = parseFloat(text);
        if (isNaN(n)) {
            const fallback = typeof min === 'number' ? min : 0;
            setText(String(fallback));
            onChange(fallback);
        } else {
            const c = clamp(n);
            setText(String(c));
            if (c !== n) onChange(c);
        }
    };
    return (
    <div className={className}>
        <span className="text-[12.5px] font-semibold text-slate-600 dark:text-zinc-300 block mb-1">{label}</span>
        <div className="flex items-center gap-1.5">
            <input
                type="number" step={step} min={min} max={max} value={text}
                onChange={e => commit(e.target.value)}
                onBlur={handleBlur}
                className="flex-1 min-w-0 h-9 px-2.5 text-[14px] font-semibold text-center bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 transition-all"
            />
            {suffix && <span className="text-[12.5px] font-semibold text-slate-500 dark:text-zinc-400 shrink-0">{suffix}</span>}
        </div>
    </div>
    );
};

interface ToolWarningProps {
    title: string;
    desc: React.ReactNode;
}

export const ToolWarning = ({ title, desc }: ToolWarningProps) => (
    <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
        <div className="flex gap-2.5 items-start">
            <span className="text-sm mt-0.5">⚠️</span>
            <div className="flex-1">
                <h4 className="text-[11px] font-bold text-red-600 dark:text-red-400 leading-tight mb-1">{title}</h4>
                <p className="text-[10.5px] text-red-700/80 dark:text-red-300/80 leading-snug">
                    {desc}
                </p>
            </div>
        </div>
    </div>
);

interface ToolInfoProps {
    desc: React.ReactNode;
}

export const ToolInfo = ({ desc }: ToolInfoProps) => (
    <div className="text-[12.5px] bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 p-3 rounded border border-sky-100 dark:border-sky-800/50 mt-4 leading-relaxed">
        {desc}
    </div>
);
