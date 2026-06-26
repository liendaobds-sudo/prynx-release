// ============================================================
// materialLibrary.spotUv.pbt.test.ts — Mockup 3D Realism
//
// Property-based test (fast-check + vitest) cho ánh xạ mask spot-UV
// theo ngưỡng 50%.
//
// Feature: mockup-3d-realism, Property 10: Spot-UV ánh xạ mask theo
// ngưỡng 50%
//
// Validates: Requirements 4.3
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    isSpotUvPixelActive,
    mapSpotUvRoughness,
    SPOT_UV_MASK_THRESHOLD,
    SPOT_UV_GLOSS_ROUGHNESS,
} from '../materialLibrary';

describe('materialLibrary — Property 10: spot-UV ánh xạ mask theo ngưỡng 50%', () => {
    // maskValue > 0.5 → kích hoạt (vùng phủ UV, dùng độ nhám bóng).
    it('maskValue > 0.5 ⇒ active và mapSpotUvRoughness trả độ nhám bóng', () => {
        fc.assert(
            fc.property(
                // Sinh giá trị mask LỚN HƠN ngưỡng (loại trừ đúng biên 0.5).
                fc
                    .double({
                        min: SPOT_UV_MASK_THRESHOLD,
                        max: 1,
                        noNaN: true,
                        minExcluded: true,
                    }),
                // Độ nhám nền bất kỳ trong [0, 1].
                fc.double({ min: 0, max: 1, noNaN: true }),
                (maskValue, baseRoughness) => {
                    expect(isSpotUvPixelActive(maskValue)).toBe(true);
                    expect(mapSpotUvRoughness(maskValue, baseRoughness)).toBe(
                        SPOT_UV_GLOSS_ROUGHNESS,
                    );
                },
            ),
            { numRuns: 100 },
        );
    });

    // maskValue <= 0.5 → không kích hoạt (giữ nguyên độ nhám nền).
    it('maskValue <= 0.5 ⇒ inactive và mapSpotUvRoughness giữ nguyên độ nhám nền', () => {
        fc.assert(
            fc.property(
                // Sinh giá trị mask NHỎ HƠN HOẶC BẰNG ngưỡng (bao gồm biên 0.5).
                fc.double({
                    min: 0,
                    max: SPOT_UV_MASK_THRESHOLD,
                    noNaN: true,
                }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                (maskValue, baseRoughness) => {
                    expect(isSpotUvPixelActive(maskValue)).toBe(false);
                    expect(mapSpotUvRoughness(maskValue, baseRoughness)).toBe(baseRoughness);
                },
            ),
            { numRuns: 100 },
        );
    });

    // NaN → không kích hoạt (giữ bề mặt nền) để cảnh vẫn render an toàn.
    it('maskValue = NaN ⇒ inactive và mapSpotUvRoughness giữ nguyên độ nhám nền', () => {
        fc.assert(
            fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (baseRoughness) => {
                expect(isSpotUvPixelActive(Number.NaN)).toBe(false);
                expect(mapSpotUvRoughness(Number.NaN, baseRoughness)).toBe(baseRoughness);
            }),
            { numRuns: 100 },
        );
    });
});
