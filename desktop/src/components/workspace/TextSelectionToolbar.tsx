import React, { useState } from 'react';
import { MessageSquare, Copy, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface TextSelectionToolbarProps {
    visible: boolean;
    x: number;
    y: number;
    selectedText: string;
    onCopy: () => void;
    onHighlight: () => void;
    onUnderline: () => void;
    onStrikethrough: () => void;
    onComment: (comment: string) => void;
    onClose: () => void;
}

export const TextSelectionToolbar: React.FC<TextSelectionToolbarProps> = ({
    visible,
    x,
    y,
    selectedText,
    onCopy,
    onHighlight,
    onUnderline,
    onStrikethrough,
    onComment,
    onClose,
}) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    if (!visible || !selectedText) return null;

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        onCopy();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div
            className="text-selection-toolbar absolute z-[60] flex flex-col items-center pointer-events-auto select-none"
            style={{
                left: `${x}px`,
                top: `${y}px`,
                transform: 'translate(-50%, -100%)',
                marginTop: '-8px',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            {/* Thanh công cụ chính kiểu Adobe Acrobat */}
            <div className="flex items-center gap-0.5 bg-zinc-900/95 dark:bg-black/90 text-white rounded-lg shadow-2xl border border-zinc-700/80 px-1 py-1 backdrop-blur-md animate-in fade-in zoom-in-95 duration-150">
                {/* 1. Comment / Ghi chú */}
                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        onComment('');
                    }}
                    className="p-1.5 rounded text-zinc-300 hover:text-amber-300 hover:bg-white/10 transition-colors"
                    title={t('settings:them_ghi_chu', 'Thêm ghi chú (Comment)')}
                >
                    <MessageSquare className="w-4 h-4" />
                </button>

                {/* 2. Highlight / Đánh dấu vàng */}
                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        onHighlight();
                    }}
                    className="p-1.5 rounded text-zinc-300 hover:text-yellow-300 hover:bg-white/10 transition-colors"
                    title={t('settings:danh_dau_highlight', 'Đánh dấu văn bản (Highlight)')}
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 11-6 6v3h3l6-6" />
                        <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
                    </svg>
                </button>

                {/* 3. Underline / Gạch chân */}
                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        onUnderline();
                    }}
                    className="p-1.5 rounded text-zinc-300 hover:text-blue-300 hover:bg-white/10 transition-colors"
                    title={t('settings:gach_chan', 'Gạch chân (Underline)')}
                >
                    <span className="font-serif font-bold text-sm leading-none underline decoration-2 underline-offset-2">
                        U
                    </span>
                </button>

                {/* 4. Strikethrough / Gạch xoá */}
                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        onStrikethrough();
                    }}
                    className="p-1.5 rounded text-zinc-300 hover:text-rose-300 hover:bg-white/10 transition-colors"
                    title={t('settings:gach_xoa', 'Gạch xoá (Strikethrough)')}
                >
                    <span className="font-serif font-bold text-sm leading-none line-through">
                        S
                    </span>
                </button>

                <div className="w-[1px] h-4 bg-zinc-700 mx-1" />

                {/* 5. Copy / Sao chép */}
                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    }}
                    onClick={handleCopy}
                    className="p-1.5 rounded text-zinc-300 hover:text-emerald-300 hover:bg-white/10 transition-colors flex items-center gap-1"
                    title={t('settings:sao_chep', 'Sao chép văn bản (Copy)')}
                >
                    {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>

                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                    }}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/10 transition-colors ml-0.5"
                    title={t('settings:dong', 'Đóng')}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
};
