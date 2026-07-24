import { describe, it, expect } from 'vitest';
import {
    buildKraftGrainRgba,
    hashRgba,
    KRAFT_GRAIN_SEED,
    clearKraftGrainCache,
    getKraftGrainBumpTexture,
} from '../proceduralTextures';

describe('proceduralTextures — kraft grain', () => {
    it('deterministic: cùng size+seed → cùng hash', () => {
        const a = buildKraftGrainRgba(128, KRAFT_GRAIN_SEED);
        const b = buildKraftGrainRgba(128, KRAFT_GRAIN_SEED);
        expect(a.hash).toBe(b.hash);
        expect(a.size).toBe(128);
        expect(a.rgba.length).toBe(128 * 128 * 4);
        expect(hashRgba(a.rgba)).toBe(a.hash);
    });

    it('seed khác → hash khác', () => {
        const a = buildKraftGrainRgba(128, 1);
        const b = buildKraftGrainRgba(128, 2);
        expect(a.hash).not.toBe(b.hash);
    });

    it('size clamp tối thiểu 64', () => {
        expect(buildKraftGrainRgba(8).size).toBe(64);
    });

    it('không tạo texture khi thiếu THREE (SSR)', () => {
        clearKraftGrainCache();
        expect(getKraftGrainBumpTexture(64, KRAFT_GRAIN_SEED, undefined)).toBeNull();
        clearKraftGrainCache();
    });

    it('pixel trong miền 0–255 và alpha 255', () => {
        const { rgba } = buildKraftGrainRgba(64);
        for (let i = 0; i < rgba.length; i += 4) {
            expect(rgba[i]).toBeGreaterThanOrEqual(0);
            expect(rgba[i]).toBeLessThanOrEqual(255);
            expect(rgba[i + 3]).toBe(255);
        }
    });
});
