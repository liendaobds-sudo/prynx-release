import { create } from 'zustand';

export interface TextMarkupRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TextMarkupReply {
    id: string;
    author: string;
    text: string;
    createdAt: number;
}

export interface TextMarkup {
    id: string;
    pageNum: number;
    type: 'highlight' | 'underline' | 'strikethrough' | 'comment';
    /** Toạ độ scale-independent theo điểm PDF (pt), giữ nguyên vị trí chính xác khi zoom */
    rectPt: TextMarkupRect;
    text: string;
    comment?: string;
    author?: string;
    replies?: TextMarkupReply[];
    createdAt: number;
}

export type HistoryAction = 
    | { action: 'add'; markup: TextMarkup }
    | { action: 'delete'; markup: TextMarkup }
    | { action: 'update'; prevMarkup: TextMarkup; newMarkup: TextMarkup };

interface TextMarkupState {
    markups: TextMarkup[];
    past: HistoryAction[];
    future: HistoryAction[];
    selectedMarkupId: string | null;
    activeCommentId: string | null;

    addMarkup: (markup: Omit<TextMarkup, 'id' | 'createdAt'>) => TextMarkup;
    deleteMarkup: (id: string) => boolean;
    updateCommentText: (id: string, text: string) => void;
    addReply: (markupId: string, replyText: string, author?: string) => void;
    setSelectedMarkupId: (id: string | null) => void;
    setActiveCommentId: (id: string | null) => void;
    undo: () => boolean;
    redo: () => boolean;
    canUndo: () => boolean;
    canRedo: () => boolean;
    clear: () => void;
}

export const useTextMarkupStore = create<TextMarkupState>()((set, get) => ({
    markups: [],
    past: [],
    future: [],
    selectedMarkupId: null,
    activeCommentId: null,

    addMarkup: (data) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const markup: TextMarkup = {
            ...data,
            id,
            author: data.author || 'Khanh Pham',
            createdAt: Date.now(),
        };

        set((state) => ({
            markups: [...state.markups, markup],
            past: [...state.past, { action: 'add', markup }],
            future: [],
            selectedMarkupId: id,
            activeCommentId: markup.type === 'comment' ? id : state.activeCommentId,
        }));

        return markup;
    },

    deleteMarkup: (id) => {
        const { markups } = get();
        const target = markups.find((m) => m.id === id);
        if (!target) return false;

        set((state) => ({
            markups: state.markups.filter((m) => m.id !== id),
            past: [...state.past, { action: 'delete', markup: target }],
            future: [],
            selectedMarkupId: state.selectedMarkupId === id ? null : state.selectedMarkupId,
            activeCommentId: state.activeCommentId === id ? null : state.activeCommentId,
        }));

        return true;
    },

    updateCommentText: (id, text) => {
        const { markups } = get();
        const target = markups.find((m) => m.id === id);
        if (!target) return;

        const updated: TextMarkup = { ...target, comment: text };
        set((state) => ({
            markups: state.markups.map((m) => (m.id === id ? updated : m)),
            past: [...state.past, { action: 'update', prevMarkup: target, newMarkup: updated }],
            future: [],
        }));
    },

    addReply: (markupId, replyText, author = 'Khanh Pham') => {
        if (!replyText.trim()) return;
        const { markups } = get();
        const target = markups.find((m) => m.id === markupId);
        if (!target) return;

        const newReply: TextMarkupReply = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            author,
            text: replyText.trim(),
            createdAt: Date.now(),
        };

        const updated: TextMarkup = {
            ...target,
            replies: [...(target.replies || []), newReply],
        };

        set((state) => ({
            markups: state.markups.map((m) => (m.id === markupId ? updated : m)),
            past: [...state.past, { action: 'update', prevMarkup: target, newMarkup: updated }],
            future: [],
        }));
    },

    setSelectedMarkupId: (id) => set({ selectedMarkupId: id }),
    setActiveCommentId: (id) => {
        const { activeCommentId, markups } = get();
        if (activeCommentId && activeCommentId !== id) {
            const cur = markups.find((m) => m.id === activeCommentId);
            if (cur && cur.type === 'comment' && !cur.comment?.trim()) {
                // Tự động dọn dẹp ghi chú nháp trống mà không làm bẩn lịch sử Undo
                set((state) => ({
                    markups: state.markups.filter((m) => m.id !== activeCommentId),
                    past: state.past.filter(
                        (a) => !(a.action === 'add' && a.markup.id === activeCommentId),
                    ),
                    selectedMarkupId: state.selectedMarkupId === activeCommentId ? null : state.selectedMarkupId,
                    activeCommentId: id,
                }));
                return;
            }
        }
        set({ activeCommentId: id });
    },

    undo: () => {
        const { past, markups, future } = get();
        if (past.length === 0) return false;

        const lastAction = past[past.length - 1];
        const newPast = past.slice(0, -1);

        if (lastAction.action === 'add') {
            // Hoàn tác việc thêm -> xoá markup này đi
            set({
                markups: markups.filter((m) => m.id !== lastAction.markup.id),
                past: newPast,
                future: [lastAction, ...future],
                selectedMarkupId: null,
                activeCommentId: null,
            });
            return true;
        }

        if (lastAction.action === 'delete') {
            // Hoàn tác việc xoá -> phục hồi lại markup này
            set({
                markups: [...markups, lastAction.markup],
                past: newPast,
                future: [lastAction, ...future],
                selectedMarkupId: lastAction.markup.id,
                activeCommentId: lastAction.markup.type === 'comment' ? lastAction.markup.id : null,
            });
            return true;
        }

        if (lastAction.action === 'update') {
            set({
                markups: markups.map((m) => (m.id === lastAction.prevMarkup.id ? lastAction.prevMarkup : m)),
                past: newPast,
                future: [lastAction, ...future],
            });
            return true;
        }

        return false;
    },

    redo: () => {
        const { future, markups, past } = get();
        if (future.length === 0) return false;

        const nextAction = future[0];
        const newFuture = future.slice(1);

        if (nextAction.action === 'add') {
            // Làm lại việc thêm -> đưa markup trở lại
            set({
                markups: [...markups, nextAction.markup],
                past: [...past, nextAction],
                future: newFuture,
                selectedMarkupId: nextAction.markup.id,
                activeCommentId: nextAction.markup.type === 'comment' ? nextAction.markup.id : null,
            });
            return true;
        }

        if (nextAction.action === 'delete') {
            // Làm lại việc xoá -> xoá markup đi
            set({
                markups: markups.filter((m) => m.id !== nextAction.markup.id),
                past: [...past, nextAction],
                future: newFuture,
                selectedMarkupId: null,
                activeCommentId: null,
            });
            return true;
        }

        if (nextAction.action === 'update') {
            set({
                markups: markups.map((m) => (m.id === nextAction.newMarkup.id ? nextAction.newMarkup : m)),
                past: [...past, nextAction],
                future: newFuture,
            });
            return true;
        }

        return false;
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    clear: () => set({ markups: [], past: [], future: [], selectedMarkupId: null, activeCommentId: null }),
}));
