import { describe, expect, it } from 'vitest';

import {
    BLEED_COLOR_MODES_STICKER,
    CUT_MODES_RICH,
    DEFAULT_CROP_TO_STICKER,
    DEFAULT_AUTO_CUTLINE_SIMPLIFY_MM,
    buildStickerDielineFields,
    normalizeStickerBleedColorType,
    shouldCropStickerPage,
    cmykToHex,
    hexToCmyk,
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

describe('StickerTool — Bế 2 dao (KissCut + ThruCut)', () => {
    const baseInput = {
        productType: 'sticker' as const,
        cutMode: 'original',
        offsetMm: 0,
        cornerStyle: 'preserve',
        fillHoles: true,
        bleedMm: 2,
        removeWhiteBg: true,
        bleedColorType: 'image',
        bleedColorHex: '#FFFFFF',
        edgeBiteMm: 0,
        cutFirstPageOnly: false,
        cropToSticker: true,
    };

    it('không đính kèm trường thrucut khi tùy chọn tắt', () => {
        const fields = buildStickerDielineFields({ ...baseInput, thrucutEnabled: false });
        expect(fields).not.toHaveProperty('thrucut_enabled');
        expect(fields).not.toHaveProperty('thrucut_shape');
        expect(fields).not.toHaveProperty('thrucut_margin_mm');
        expect(fields).not.toHaveProperty('thrucut_radius_mm');
        expect(fields).not.toHaveProperty('thrucut_spot_name');
    });

    it('đính kèm đầy đủ tham số khi bật Bế 2 dao', () => {
        const fields = buildStickerDielineFields({
            ...baseInput,
            thrucutEnabled: true,
            thrucutShape: 'rounded_rect',
            thrucutMarginMm: 3.5,
            thrucutRadiusMm: 2.0,
            thrucutSpotName: 'ThruCut',
        });
        expect(fields.thrucut_enabled).toBe('true');
        expect(fields.thrucut_shape).toBe('rounded_rect');
        expect(fields.thrucut_margin_mm).toBe('3.5');
        expect(fields.thrucut_radius_mm).toBe('2');
        expect(fields.thrucut_spot_name).toBe('ThruCut');
        expect(fields.thrucut_color_hex).toBe('#00FFFF');
    });

    it('nhận mã màu hex tùy chọn cho kênh bế đứt', () => {
        const fields = buildStickerDielineFields({
            ...baseInput,
            thrucutEnabled: true,
            thrucutColorHex: '#22C55E',
        });
        expect(fields.thrucut_enabled).toBe('true');
        expect(fields.thrucut_color_hex).toBe('#22C55E');
    });

    it('tự động kẹp giới hạn và fallback giá trị mặc định hợp lệ', () => {
        const fields = buildStickerDielineFields({
            ...baseInput,
            thrucutEnabled: true,
            thrucutMarginMm: 999,
            thrucutRadiusMm: -5,
            thrucutSpotName: '  DieCut  ',
        });
        expect(fields.thrucut_enabled).toBe('true');
        expect(fields.thrucut_shape).toBe('rounded_rect');
        expect(fields.thrucut_margin_mm).toBe('30');
        expect(fields.thrucut_radius_mm).toBe('0');
        expect(fields.thrucut_spot_name).toBe('DieCut');
    });

    it('không xuất thrucut khi ở chế độ Xén vuông hoặc Không vẽ đường cắt', () => {
        const rectFields = buildStickerDielineFields({
            ...baseInput,
            productType: 'rectangle',
            thrucutEnabled: true,
        });
        expect(rectFields).not.toHaveProperty('thrucut_enabled');

        const noCutFields = buildStickerDielineFields({
            ...baseInput,
            cutMode: 'none',
            thrucutEnabled: true,
        });
        expect(noCutFields).not.toHaveProperty('thrucut_enabled');
    });

    it('chuyển đổi hai chiều CMYK và Hex chính xác cho in ấn', () => {
        // Cyan 100%
        expect(cmykToHex(100, 0, 0, 0)).toBe('#00ffff');
        expect(hexToCmyk('#00ffff')).toEqual({ c: 100, m: 0, y: 0, k: 0 });

        // Magenta 100%
        expect(cmykToHex(0, 100, 0, 0)).toBe('#ff00ff');
        expect(hexToCmyk('#ff00ff')).toEqual({ c: 0, m: 100, y: 0, k: 0 });

        // Yellow 100%
        expect(cmykToHex(0, 0, 100, 0)).toBe('#ffff00');
        expect(hexToCmyk('#ffff00')).toEqual({ c: 0, m: 0, y: 100, k: 0 });

        // Black 100%
        expect(cmykToHex(0, 0, 0, 100)).toBe('#000000');
        expect(hexToCmyk('#000000')).toEqual({ c: 0, m: 0, y: 0, k: 100 });

        // Xanh lá (C100 Y100)
        expect(cmykToHex(100, 0, 100, 0)).toBe('#00ff00');
        expect(hexToCmyk('#00ff00')).toEqual({ c: 100, m: 0, y: 100, k: 0 });
    });
});
