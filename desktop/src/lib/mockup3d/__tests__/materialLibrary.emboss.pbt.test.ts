// ============================================================
// Property test — materialLibrary.clampEmbossHeight
//
// Feature: mockup-3d-realism, Property 11: Giới hạn độ cao emboss
// **Validates: Requirements 4.5**
//
// For any giá trị độ cao emboss đầu vào, giá trị được áp dụng luôn
// thuộc [0.0, 5.0] mm (clamp về biên gần nhất):
//   - < 0.0 / NaN / undefined → 0.0,
//   - > 5.0 → 5.0,
//   - thuộc [0.0, 5.0] → giữ nguyên,
// và phép clamp là idempotent (clamp(clamp(x)) = clamp(x)).
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    clampEmbossHeight,
    EMBOSS_MIN_HEIGHT_MM,
    EMBOSS_MAX_HEIGHT_MM,
} from '../materialLibrary';

const NUM_RUNS = 100;

describe('clampEmbossHeight — Property 11: Giới hạn độ cao emboss', () => {
    it('đầu ra luôn thuộc [0.0, 5.0] với mọi đầu vào', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.double({ min: -1e6, max: 1e6 }), // gồm cả ±, biên
                    fc.constant(NaN),
                    fc.constant(undefined),
                ),
                (rawHeight) => {
                    const out = clampEmbossHeight(rawHeight as number | undefined);
                    expect(out).toBeGreaterThanOrEqual(EMBOSS_MIN_HEIGHT_MM);
                    expect(out).toBeLessThanOrEqual(EMBOSS_MAX_HEIGHT_MM);
                    expect(Number.isNaN(out)).toBe(false);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('< 0.0 → 0.0 (clamp biên dưới)', () => {
        fc.assert(
            fc.property(
                fc.double({ min: -1e6, max: -1e-9, noNaN: true })
                    .filter((h) => h < EMBOSS_MIN_HEIGHT_MM),
                (rawHeight) => {
                    expect(clampEmbossHeight(rawHeight)).toBe(EMBOSS_MIN_HEIGHT_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('NaN / undefined → 0.0 (mặc định an toàn)', () => {
        fc.assert(
            fc.property(
                fc.constantFrom<Array<number | undefined>>(NaN, undefined),
                (rawHeight) => {
                    expect(clampEmbossHeight(rawHeight)).toBe(EMBOSS_MIN_HEIGHT_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('> 5.0 → 5.0 (clamp biên trên)', () => {
        fc.assert(
            fc.property(
                fc.double({
                    min: Math.fround(EMBOSS_MAX_HEIGHT_MM + 1e-6),
                    max: 1e6,
                    noNaN: true,
                }).filter((h) => h > EMBOSS_MAX_HEIGHT_MM),
                (rawHeight) => {
                    expect(clampEmbossHeight(rawHeight)).toBe(EMBOSS_MAX_HEIGHT_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('thuộc [0.0, 5.0] → giữ nguyên', () => {
        fc.assert(
            fc.property(
                fc.double({
                    min: EMBOSS_MIN_HEIGHT_MM,
                    max: EMBOSS_MAX_HEIGHT_MM,
                    noNaN: true,
                }).filter((h) => h >= EMBOSS_MIN_HEIGHT_MM && h <= EMBOSS_MAX_HEIGHT_MM),
                (rawHeight) => {
                    expect(clampEmbossHeight(rawHeight)).toBe(rawHeight);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('idempotent: clamp(clamp(x)) = clamp(x)', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.double({ min: -1e6, max: 1e6 }),
                    fc.constant(NaN),
                    fc.constant(undefined),
                ),
                (rawHeight) => {
                    const once = clampEmbossHeight(rawHeight as number | undefined);
                    const twice = clampEmbossHeight(once);
                    expect(twice).toBe(once);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
