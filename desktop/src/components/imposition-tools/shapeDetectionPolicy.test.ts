import { describe, expect, it } from 'vitest';
import {
    buildPageSizedShapeState,
    shapeDetectionSourceKey,
    usesPageSizedStickerShape,
} from './shapeDetectionPolicy';

describe('shapeDetectionPolicy', () => {
    it('chỉ bỏ nhận diện cho Bình tem bế + 1 dao + theo kích thước trang', () => {
        expect(usesPageSizedStickerShape('sticker_imposer', 'one_dao', 'page')).toBe(true);
        expect(usesPageSizedStickerShape('sticker_imposer', 'one_dao', 'die')).toBe(false);
        expect(usesPageSizedStickerShape('cnc_imposer', 'one_dao', 'page')).toBe(false);
    });

    it('tạo hình chữ nhật và giữ kích thước riêng của từng trang', () => {
        const state = buildPageSizedShapeState(
            [{ w: 100, h: 200 }, { w: 300, h: 400 }],
            { w: 50, h: 60 },
            3,
        );

        expect(state.shapes).toEqual({ 0: 'RECTANGLE', 1: 'RECTANGLE', 2: 'RECTANGLE' });
        expect(state.dimensions).toEqual({
            0: { w: 100, h: 200 },
            1: { w: 300, h: 400 },
            2: { w: 50, h: 60 },
        });
        expect(state.params).toEqual({ 0: {}, 1: {}, 2: {} });
    });

    it('desktop giữ cùng khóa khi pre-upload làm thay đổi fileId', () => {
        const file = { name: 'tem.pdf', size: 123, lastModified: 456 } as File;
        expect(shapeDetectionSourceKey(true, 'D:/tem.pdf', '', file)).toBe('path:D:/tem.pdf');
        expect(shapeDetectionSourceKey(true, 'D:/tem.pdf', 'new-id', file)).toBe('path:D:/tem.pdf');
        expect(shapeDetectionSourceKey(false, undefined, 'new-id', file)).toBe('file-id:new-id');
    });
});
