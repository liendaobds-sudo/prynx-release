// ============================================================
// materialLibrary.physical.pbt.test.ts — Physical finish scalars
//
// Property tests: mọi kênh Physical sau resolvePhysicalScalars ∈ [0,1];
// spot-UV clearcoat map đúng ngưỡng mask.
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    FINISH_LIBRARY,
    getFinish,
    resolvePhysicalScalars,
    mapSpotUvClearcoat,
    mapSpotUvRoughness,
    SPOT_UV_GLOSS_CLEARCOAT,
    SPOT_UV_GLOSS_ROUGHNESS,
    envMapResolutionForTier,
    clampToneExposure,
    TONE_EXPOSURE_MIN,
    TONE_EXPOSURE_MAX,
    DEFAULT_TONE_EXPOSURE,
} from '../materialLibrary';
import type { FinishId } from '../types';

describe('materialLibrary — Physical finish scalars', () => {
    const finishIds = Object.keys(FINISH_LIBRARY) as FinishId[];

    it('resolvePhysicalScalars: mọi kênh ∈ [0,1] cho mọi finish', () => {
        fc.assert(
            fc.property(fc.constantFrom(...finishIds), (id) => {
                const s = resolvePhysicalScalars(getFinish(id));
                for (const key of [
                    'roughness',
                    'metalness',
                    'clearcoat',
                    'clearcoatRoughness',
                    'sheen',
                    'sheenRoughness',
                    'envMapIntensity',
                    'grainBumpScale',
                ] as const) {
                    expect(Number.isFinite(s[key])).toBe(true);
                    expect(s[key]).toBeGreaterThanOrEqual(0);
                    expect(s[key]).toBeLessThanOrEqual(1);
                }
                expect(typeof s.sheenColor).toBe('string');
                expect(s.sheenColor.length).toBeGreaterThan(0);
            }),
            { numRuns: 100 },
        );
    });

    it('gloss-lam có clearcoat cao hơn matte-lam', () => {
        const gloss = resolvePhysicalScalars(getFinish('gloss-lam'));
        const matte = resolvePhysicalScalars(getFinish('matte-lam'));
        expect(gloss.clearcoat).toBeGreaterThan(matte.clearcoat);
        expect(gloss.roughness).toBeLessThan(matte.roughness);
    });

    it('kraft có sheen > 0 và envMapIntensity < 1', () => {
        const k = resolvePhysicalScalars(getFinish('kraft'));
        expect(k.sheen).toBeGreaterThan(0);
        expect(k.envMapIntensity).toBeLessThan(1);
    });

    it('mapSpotUvClearcoat: mask > 0.5 → gloss clearcoat', () => {
        fc.assert(
            fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (mask) => {
                const base = 0.08;
                const v = mapSpotUvClearcoat(mask, base);
                if (mask > 0.5) expect(v).toBe(SPOT_UV_GLOSS_CLEARCOAT);
                else expect(v).toBe(base);
            }),
            { numRuns: 50 },
        );
    });

    it('mapSpotUvRoughness vẫn khớp gloss threshold', () => {
        expect(mapSpotUvRoughness(0.51, 0.7)).toBe(SPOT_UV_GLOSS_ROUGHNESS);
        expect(mapSpotUvRoughness(0.4, 0.7)).toBe(0.7);
    });

    it('envMapResolutionForTier: balanced 256, high 512', () => {
        expect(envMapResolutionForTier('balanced')).toBe(256);
        expect(envMapResolutionForTier('high')).toBe(512);
    });

    it('clampToneExposure giữ miền và fallback', () => {
        expect(clampToneExposure(undefined)).toBe(DEFAULT_TONE_EXPOSURE);
        expect(clampToneExposure(NaN)).toBe(DEFAULT_TONE_EXPOSURE);
        expect(clampToneExposure(0.1)).toBe(TONE_EXPOSURE_MIN);
        expect(clampToneExposure(9)).toBe(TONE_EXPOSURE_MAX);
        expect(clampToneExposure(1.1)).toBe(1.1);
    });
});
