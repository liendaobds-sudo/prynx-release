import { describe, expect, it } from 'vitest';

import {
    computeStickerBleedGeometry,
    formatSignedMm,
} from './stickerBleedGeometry';

describe('sticker bleed geometry summary', () => {
    it('giữ 3 mm bù xén ngoài đường cắt khi giãn đường cắt +2 mm', () => {
        expect(computeStickerBleedGeometry('original', 2, 3)).toEqual({
            cutOffsetMm: 2,
            outerOffsetMm: 5,
            bleedOutsideCutMm: 3,
        });
    });

    it('giữ cùng độ rộng bleed khi co đường cắt vào trong', () => {
        expect(computeStickerBleedGeometry('original', -0.5, 3)).toEqual({
            cutOffsetMm: -0.5,
            outerOffsetMm: 2.5,
            bleedOutsideCutMm: 3,
        });
    });

    it('cho đường cắt trùng mép màu ở chế độ theo mép tràn lề', () => {
        expect(computeStickerBleedGeometry('bleed', 2, 3)).toEqual({
            cutOffsetMm: 5,
            outerOffsetMm: 5,
            bleedOutsideCutMm: 0,
        });
    });

    it('định dạng rõ dấu của khoảng cách so với mép hình gốc', () => {
        expect(formatSignedMm(2)).toBe('+2');
        expect(formatSignedMm(-0.5)).toBe('-0.5');
        expect(formatSignedMm(0)).toBe('0');
    });
});
