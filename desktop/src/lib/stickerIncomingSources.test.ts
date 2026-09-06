import { describe, it, expect, vi } from 'vitest';
import { deliverStickerIncomingSource, registerStickerIncomingSource } from './stickerIncomingSources';

describe('nguồn workspace tem theo tab', () => {
    it('đúng owner nhận; cleanup cũ không xóa đăng ký mới', () => {
        const old = vi.fn(() => true);
        const next = vi.fn(() => true);
        const closeOld = registerStickerIncomingSource('a', old);
        const closeNext = registerStickerIncomingSource('a', next);
        closeOld();
        const files = [new File(['pdf'], 'tem.pdf')];
        expect(deliverStickerIncomingSource('b', files)).toBe(false);
        expect(deliverStickerIncomingSource('a', files)).toBe(true);
        expect(next).toHaveBeenCalledWith(files);
        expect(old).not.toHaveBeenCalled();
        closeNext();
        expect(deliverStickerIncomingSource('a', files)).toBe(false);
    });
    it('không hút format không hỗ trợ hoặc batch rỗng', () => {
        const receive = vi.fn(() => true);
        const close = registerStickerIncomingSource('a', receive);
        expect(deliverStickerIncomingSource('a', [])).toBe(false);
        expect(deliverStickerIncomingSource('a', [new File(['word'], 'file.docx')])).toBe(false);
        expect(receive).not.toHaveBeenCalled();
        close();
    });
});
