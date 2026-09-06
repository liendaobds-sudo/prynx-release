import { describe, expect, it } from 'vitest';
import {
    loadStickerRemoveWhiteBg,
    resolveStickerDetectionStrategy,
    saveStickerRemoveWhiteBg,
} from './stickerDetectionSettings';
import type { StickerOutputStorage } from './stickerOutputSettings';

function storageWith(entries: Record<string, string> = {}): StickerOutputStorage {
    const values = new Map(Object.entries(entries));
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe('thiết lập nền nhận diện tem', () => {
    it('giữ mặc định bật của StickerTool khi chưa có thiết lập', () => {
        expect(loadStickerRemoveWhiteBg(storageWith())).toBe(true);
        expect(loadStickerRemoveWhiteBg(null)).toBe(true);
    });

    it('khôi phục lựa chọn tắt từ bản cũ, kể cả khóa unified hỏng hoặc thiếu field', () => {
        for (const unified of ['null', '{}', '{"removeWhiteBg":"false"}', 'hỏng']) {
            expect(loadStickerRemoveWhiteBg(storageWith({
                ps_sticker_unified_detection_v2: unified,
                ps_sticker_removeWhiteBg: 'false',
            }))).toBe(false);
        }
    });

    it('khóa riêng ưu tiên lựa chọn mới mà không ghi đè khóa legacy', () => {
        const storage = storageWith({ ps_sticker_removeWhiteBg: 'true' });
        saveStickerRemoveWhiteBg(false, storage);
        expect(loadStickerRemoveWhiteBg(storage)).toBe(false);
        expect(storage.getItem('ps_sticker_removeWhiteBg')).toBe('true');
        saveStickerRemoveWhiteBg(true, storage);
        expect(loadStickerRemoveWhiteBg(storage)).toBe(true);
    });

    it('storage bị chặn dùng mặc định và không ném lỗi khi lưu', () => {
        const storage = {
            getItem: () => { throw new Error('chặn'); },
            setItem: () => { throw new Error('chặn'); },
        };
        expect(loadStickerRemoveWhiteBg(storage)).toBe(true);
        expect(() => saveStickerRemoveWhiteBg(false, storage)).not.toThrow();
    });

    it('tắt bỏ nền giữ khung trang, Alpha ưu tiên và bật lại phục hồi detector', () => {
        expect(resolveStickerDetectionStrategy('original', false, 'ai')).toBe('page-box');
        expect(resolveStickerDetectionStrategy('none', false)).toBe('page-box');
        expect(resolveStickerDetectionStrategy('alpha', false, 'page-box')).toBe('alpha');
        expect(resolveStickerDetectionStrategy('alpha', true, 'ai')).toBe('alpha');
        expect(resolveStickerDetectionStrategy('original', true, 'ai')).toBe('ai');
        expect(resolveStickerDetectionStrategy('original', true, 'page-box')).toBe('auto');
    });
});
