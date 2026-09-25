import { describe, it, expect, beforeEach } from 'vitest';
import { useTextMarkupStore } from './useTextMarkupStore';

describe('useTextMarkupStore', () => {
    beforeEach(() => {
        useTextMarkupStore.getState().clear();
    });

    it('bắt đầu với danh sách rỗng và không thể undo/redo', () => {
        const state = useTextMarkupStore.getState();
        expect(state.markups).toEqual([]);
        expect(state.canUndo()).toBe(false);
        expect(state.canRedo()).toBe(false);
    });

    it('thêm markup, hỗ trợ undo (Ctrl+Z) và redo (Ctrl+Y)', () => {
        const store = useTextMarkupStore.getState();
        const markup = store.addMarkup({
            pageNum: 1,
            type: 'highlight',
            rectPt: { x: 10, y: 20, width: 100, height: 15 },
            text: 'Test highlight',
        });

        expect(useTextMarkupStore.getState().markups.length).toBe(1);
        expect(useTextMarkupStore.getState().canUndo()).toBe(true);
        expect(useTextMarkupStore.getState().canRedo()).toBe(false);

        // Undo (Ctrl+Z)
        const undone = useTextMarkupStore.getState().undo();
        expect(undone).toBe(true);
        expect(useTextMarkupStore.getState().markups.length).toBe(0);
        expect(useTextMarkupStore.getState().canUndo()).toBe(false);
        expect(useTextMarkupStore.getState().canRedo()).toBe(true);

        // Redo (Ctrl+Y)
        const redone = useTextMarkupStore.getState().redo();
        expect(redone).toBe(true);
        expect(useTextMarkupStore.getState().markups.length).toBe(1);
        expect(useTextMarkupStore.getState().markups[0].id).toBe(markup.id);
        expect(useTextMarkupStore.getState().canUndo()).toBe(true);
        expect(useTextMarkupStore.getState().canRedo()).toBe(false);
    });

    it('xóa markup, hỗ trợ undo để phục hồi lại markup', () => {
        const store = useTextMarkupStore.getState();
        const m1 = store.addMarkup({
            pageNum: 1,
            type: 'comment',
            rectPt: { x: 5, y: 10, width: 50, height: 12 },
            text: 'Lỗi in',
            comment: 'Cần sửa màu',
        });

        expect(useTextMarkupStore.getState().markups.length).toBe(1);

        // Xóa markup
        const deleted = useTextMarkupStore.getState().deleteMarkup(m1.id);
        expect(deleted).toBe(true);
        expect(useTextMarkupStore.getState().markups.length).toBe(0);

        // Undo xóa -> phục hồi lại
        const undone = useTextMarkupStore.getState().undo();
        expect(undone).toBe(true);
        expect(useTextMarkupStore.getState().markups.length).toBe(1);
        expect(useTextMarkupStore.getState().markups[0].comment).toBe('Cần sửa màu');
    });

    it('tạo comment nháp rỗng rồi huỷ (setActiveCommentId null) -> tự động dọn dẹp không để lại rác trong Undo', () => {
        const store = useTextMarkupStore.getState();
        const draft = store.addMarkup({
            pageNum: 1,
            type: 'comment',
            rectPt: { x: 10, y: 10, width: 60, height: 14 },
            text: 'Text bôi đen',
            comment: '',
        });

        expect(useTextMarkupStore.getState().markups.length).toBe(1);
        expect(useTextMarkupStore.getState().activeCommentId).toBe(draft.id);

        // Huỷ bỏ khi click ra ngoài hoặc đóng card mà chưa lưu nội dung
        useTextMarkupStore.getState().setActiveCommentId(null);
        expect(useTextMarkupStore.getState().markups.length).toBe(0);
        expect(useTextMarkupStore.getState().canUndo()).toBe(false);
    });

    it('cập nhật nội dung comment và thêm reply phản hồi', () => {
        const store = useTextMarkupStore.getState();
        const m = store.addMarkup({
            pageNum: 1,
            type: 'comment',
            rectPt: { x: 10, y: 10, width: 60, height: 14 },
            text: 'Text bôi đen',
            comment: '',
        });

        // Người dùng nhập và lưu comment
        useTextMarkupStore.getState().updateCommentText(m.id, 'Chỗ này sai font');
        expect(useTextMarkupStore.getState().markups[0].comment).toBe('Chỗ này sai font');

        // Thêm reply
        useTextMarkupStore.getState().addReply(m.id, 'Đã sửa font sang Arial', 'Designer');
        const updated = useTextMarkupStore.getState().markups[0];
        expect(updated.replies?.length).toBe(1);
        expect(updated.replies?.[0].author).toBe('Designer');
        expect(updated.replies?.[0].text).toBe('Đã sửa font sang Arial');
    });
});
