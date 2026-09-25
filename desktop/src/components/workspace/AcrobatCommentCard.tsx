import React, { useState, useRef, useEffect } from 'react';
import { X, Trash2, CornerDownRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TextMarkup } from '../../stores/useTextMarkupStore';

export interface AcrobatCommentCardProps {
    markup: TextMarkup;
    x: number;
    y: number;
    containerWidth?: number;
    onSaveComment: (id: string, text: string) => void;
    onAddReply: (id: string, replyText: string) => void;
    onDeleteComment: (id: string) => void;
    onClose: () => void;
}

export const AcrobatCommentCard: React.FC<AcrobatCommentCardProps> = ({
    markup,
    x,
    y,
    containerWidth = 800,
    onSaveComment,
    onAddReply,
    onDeleteComment,
    onClose,
}) => {
    const { t } = useTranslation();
    const isComposingNew = !markup.comment;
    const [draftText, setDraftText] = useState(markup.comment || '');
    const [replyDraft, setReplyDraft] = useState('');
    const [showReplyInput, setShowReplyInput] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const replyInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isComposingNew && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [isComposingNew]);

    useEffect(() => {
        if (showReplyInput && replyInputRef.current) {
            replyInputRef.current.focus();
        }
    }, [showReplyInput]);

    // Định dạng thời gian như Adobe Acrobat (ví dụ: "8:57 PM")
    const formattedTime = new Date(markup.createdAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });

    const handleSaveNewComment = (e?: React.FormEvent) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (draftText.trim()) {
            onSaveComment(markup.id, draftText.trim());
        } else {
            // Nếu bỏ trống và bấm hủy/enter -> xóa markup trống
            onDeleteComment(markup.id);
        }
    };

    const handleReplySubmit = (e: React.FormEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (replyDraft.trim()) {
            onAddReply(markup.id, replyDraft.trim());
            setReplyDraft('');
            setShowReplyInput(false);
        }
    };

    // Tính toạ độ hiển thị thông minh để không tràn viền trang
    const cardWidth = 280;
    const cardLeft = x + 30 + cardWidth <= containerWidth
        ? x + 16
        : Math.max(10, x - cardWidth - 16);

    return (
        <div
            className="acrobat-comment-card absolute z-[70] pointer-events-auto select-none"
            style={{
                left: `${cardLeft}px`,
                top: `${y}px`,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className="w-[280px] bg-white dark:bg-zinc-900 border-2 border-[#f5c518] shadow-2xl rounded-sm p-3 flex flex-col animate-in fade-in zoom-in-95 duration-100">
                {/* Header: Author, Time, Actions, Close */}
                <div className="flex items-center justify-between pb-1">
                    <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="font-bold text-xs text-zinc-900 dark:text-zinc-100 truncate">
                            {markup.author || 'Khanh Pham'}
                        </span>
                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-normal shrink-0">
                            {formattedTime}
                        </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-2">
                        {!isComposingNew && (
                            <button
                                type="button"
                                onClick={() => setShowReplyInput((prev) => !prev)}
                                className="text-xs text-sky-600 hover:text-sky-700 dark:text-sky-400 font-medium cursor-pointer"
                            >
                                Reply
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => onDeleteComment(markup.id)}
                            className="text-zinc-400 hover:text-rose-500 transition-colors p-0.5"
                            title={t('settings:xoa_ghi_chu', 'Xóa ghi chú')}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors p-0.5"
                            title={t('settings:dong', 'Đóng')}
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>

                {/* Body: Nếu đang tạo mới -> textarea, nếu đã có -> text hiển thị */}
                {isComposingNew ? (
                    <form onSubmit={handleSaveNewComment} className="flex flex-col gap-2 mt-1">
                        <textarea
                            ref={textareaRef}
                            value={draftText}
                            onChange={(e) => setDraftText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSaveNewComment();
                                }
                            }}
                            placeholder={t('settings:nhap_ghi_chu_placeholder', 'Nhập ghi chú...')}
                            rows={3}
                            className="w-full bg-zinc-50 dark:bg-zinc-800 text-xs text-zinc-900 dark:text-zinc-100 rounded border border-zinc-200 dark:border-zinc-700 p-2 outline-none focus:border-amber-400 resize-none select-text"
                        />
                        <div className="flex justify-end gap-1.5">
                            <button
                                type="button"
                                onClick={() => onDeleteComment(markup.id)}
                                className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 rounded"
                            >
                                {t('settings:huy', 'Hủy')}
                            </button>
                            <button
                                type="submit"
                                disabled={!draftText.trim()}
                                className="px-3 py-1 text-xs font-semibold bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-zinc-950 rounded transition-colors"
                            >
                                {t('settings:luu_ghi_chu', 'Lưu')}
                            </button>
                        </div>
                    </form>
                ) : (
                    <div className="mt-1 text-xs text-zinc-800 dark:text-zinc-200 leading-relaxed select-text whitespace-pre-wrap">
                        {markup.comment}
                    </div>
                )}

                {/* Replies list */}
                {markup.replies && markup.replies.length > 0 && (
                    <div className="mt-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
                        {markup.replies.map((reply) => (
                            <div key={reply.id} className="text-xs bg-zinc-50 dark:bg-zinc-800/60 rounded p-1.5 select-text">
                                <div className="flex items-baseline justify-between text-[11px] text-zinc-500 mb-0.5">
                                    <span className="font-semibold text-zinc-800 dark:text-zinc-200">{reply.author}</span>
                                    <span>{new Date(reply.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                                </div>
                                <div className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{reply.text}</div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Footer: Reply input box kiểu Adobe Acrobat */}
                {!isComposingNew && (
                    <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-800/80">
                        {showReplyInput ? (
                            <form onSubmit={handleReplySubmit} className="flex flex-col gap-1.5">
                                <input
                                    ref={replyInputRef}
                                    type="text"
                                    value={replyDraft}
                                    onChange={(e) => setReplyDraft(e.target.value)}
                                    placeholder={t('settings:tra_loi_placeholder', 'Trả lời...')}
                                    className="w-full bg-zinc-50 dark:bg-zinc-800 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 outline-none focus:border-amber-400 select-text"
                                />
                                <div className="flex justify-end gap-1">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowReplyInput(false);
                                            setReplyDraft('');
                                        }}
                                        className="px-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 rounded"
                                    >
                                        {t('settings:huy', 'Hủy')}
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={!replyDraft.trim()}
                                        className="px-2.5 py-0.5 text-[11px] font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded transition-colors flex items-center gap-1"
                                    >
                                        <CornerDownRight className="w-3 h-3" />
                                        <span>Gửi</span>
                                    </button>
                                </div>
                            </form>
                        ) : (
                            <div
                                onClick={() => setShowReplyInput(true)}
                                className="w-full rounded border border-zinc-200 dark:border-zinc-700/80 bg-zinc-50/80 dark:bg-zinc-800/50 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-300 cursor-pointer transition-colors"
                            >
                                Reply or use @ to invite others
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
