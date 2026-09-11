import { describe, expect, it } from 'vitest';

import {
    BLEED_COLOR_MODES_STICKER,
    CUT_MODES_RICH,
    DEFAULT_CROP_TO_STICKER,
    DEFAULT_AUTO_CUTLINE_SIMPLIFY_MM,
    buildStickerDielineFields,
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

describe('StickerTool — dung sai đơn giản hóa bổ sung', () => {
    const input = {
        productType: 'sticker' as const,
        cutMode: 'original',
        offsetMm: 0,
        cornerStyle: 'preserve',
        fillHoles: true,
        bleedMm: 0,
        removeWhiteBg: true,
        bleedColorType: 'image',
        bleedColorHex: '#FFFFFF',
        edgeBiteMm: 0,
        cutFirstPageOnly: false,
        cropToSticker: true,
    };

    it.each([
        [undefined, '0'],
        [null, '0'],
        [Number.NaN, '0'],
        [Number.POSITIVE_INFINITY, '0'],
        [true, '0'],
        [-0.01, '0'],
        [0, '0'],
        [0.02, '0.02'],
        ['0.035', '0.035'],
        [0.05, '0.05'],
        [0.1, '0.1'],
        [1, '0.1'],
    ])('chuẩn hóa %s thành %s mm, recipe cũ mặc định tắt', (value, expected) => {
        const request = { ...input, cutlineSimplifyMm: value };
        expect(buildStickerDielineFields(request).cutline_simplify_mm).toBe(expected);
    });

    it('giữ dung sai theo biên Alpha nhưng không truyền trạng thái ẩn vào Xén vuông/Không vẽ', () => {
        const request = { ...input, cutlineSimplifyMm: 0.04 };
        expect(buildStickerDielineFields({ ...request, cutMode: 'alpha' })
            .cutline_simplify_mm).toBe('0.04');
        expect(buildStickerDielineFields({ ...request, cutMode: 'none' })
            .cutline_simplify_mm).toBe('0');
        expect(buildStickerDielineFields({ ...request, productType: 'rectangle' })
            .cutline_simplify_mm).toBe('0');
    });

    it('tự động là opt-in riêng, không đổi scalar mặc định của recipe cũ', () => {
        expect(DEFAULT_AUTO_CUTLINE_SIMPLIFY_MM).toBe(0.1);
        expect(buildStickerDielineFields(input)).toMatchObject({ cutline_simplify_mm: '0' });
        expect(buildStickerDielineFields(input)).not.toHaveProperty('cutline_simplify_auto');
        expect(buildStickerDielineFields({ ...input, cutlineSimplifyAuto: false }))
            .not.toHaveProperty('cutline_simplify_auto');
        expect(buildStickerDielineFields({
            ...input, cutlineSimplifyAuto: false, cutlineSimplifyMm: 0,
        }).cutline_simplify_mm).toBe('0');
    });

    it('trang vector hiện tại vẫn gửi cờ tự động cho backend quyết định từng trang hỗn hợp', () => {
        expect(buildStickerDielineFields({
            ...input, cutlineSimplifyAuto: true, cutlineSimplifyMm: 0,
        })).toMatchObject({ cutline_simplify_mm: '0', cutline_simplify_auto: 'true' });
        expect(buildStickerDielineFields({
            ...input, cutlineSimplifyAuto: true, cutlineSimplifyMm: DEFAULT_AUTO_CUTLINE_SIMPLIFY_MM,
        })).toMatchObject({ cutline_simplify_mm: '0.1', cutline_simplify_auto: 'true' });
    });

    it.each([
        { productType: 'rectangle' as const, cutMode: 'original' },
        { productType: 'sticker' as const, cutMode: 'none' },
    ])('không gửi auto từ trạng thái ẩn: %s', hidden => {
        const fields = buildStickerDielineFields({
            ...input, ...hidden, cutlineSimplifyAuto: true, cutlineSimplifyMm: 0.1,
        });
        expect(fields.cutline_simplify_mm).toBe('0');
        expect(fields).not.toHaveProperty('cutline_simplify_auto');
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
