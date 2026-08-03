import { describe, expect, it } from 'vitest';

import {
    BLEED_COLOR_MODES_STICKER,
    CUT_MODES_RICH,
    DEFAULT_CROP_TO_STICKER,
    normalizeStickerBleedColorType,
    shouldCropStickerPage,
} from './stickerToolPolicy';


describe('StickerTool — màu bù xén Bế tem nhãn', () => {
    it('hiển thị trajectory và giữ nguyên lựa chọn khi chuyển sang Bế tem nhãn', () => {
        expect(BLEED_COLOR_MODES_STICKER.map(option => option.value)).toEqual([
            'image',
            'trajectory',
            'inpaint',
            'solid',
        ]);
        expect(normalizeStickerBleedColorType('trajectory', 'sticker')).toBe('trajectory');
    });

    it('vẫn fallback mirror vì engine contour chưa hỗ trợ lật gương', () => {
        expect(normalizeStickerBleedColorType('mirror', 'sticker')).toBe('image');
        expect(normalizeStickerBleedColorType('mirror', 'rectangle')).toBe('mirror');
    });
});

describe('StickerTool — nguồn đường cắt', () => {
    it('có chế độ bám theo Alpha của PNG đã được nhúng vào PDF', () => {
        expect(CUT_MODES_RICH.map(option => option.value)).toEqual([
            'original',
            'alpha',
            'bleed',
            'none',
        ]);
    });

    it('mặc định bật Crop trang theo tem', () => {
        expect(DEFAULT_CROP_TO_STICKER).toBe(true);
    });

    it('chỉ gửi crop cho Bế tem có đường cắt', () => {
        expect(shouldCropStickerPage('sticker', 'original', true)).toBe(true);
        expect(shouldCropStickerPage('sticker', 'none', true)).toBe(false);
        expect(shouldCropStickerPage('rectangle', 'original', true)).toBe(false);
    });
});
