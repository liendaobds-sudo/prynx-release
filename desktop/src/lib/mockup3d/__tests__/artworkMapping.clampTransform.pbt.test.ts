// ============================================================
// Property test — artworkMapping.clampArtworkTransform
//
// Feature: mockup-3d-realism, Property 17: Clamp tỉ lệ và vị trí ảnh nghệ thuật
// **Validates: Requirements 5.6, 5.7, 5.8**
//
// For any `ArtworkTransform` đầu vào (kể cả ngoài miền, NaN, undefined,
// hoặc ±Infinity), `clampArtworkTransform` trả về:
//   - `scalePct` luôn thuộc [10, 1000]   (Yêu cầu 5.6),
//   - `offsetXPct`/`offsetYPct` luôn thuộc [-100, +100]   (Yêu cầu 5.7),
//   - giá trị ngoài miền được kéo về biên gần nhất   (Yêu cầu 5.8),
//   - giá trị không hợp lệ (NaN/undefined/±Infinity) → mặc định an toàn
//     (scale 100%, offset 0%),
//   - idempotent: clamp(clamp(t)) === clamp(t).
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    clampArtworkTransform,
    SCALE_MIN_PCT,
    SCALE_MAX_PCT,
    OFFSET_MIN_PCT,
    OFFSET_MAX_PCT,
} from '../artworkMapping';
import type { ArtworkTransform } from '../types';

const NUM_RUNS = 100;
const DEFAULT_SCALE_PCT = 100;
const DEFAULT_OFFSET_PCT = 0;

/** Generator cho một số "bất kỳ" gồm cả hữu hạn rộng, biên, NaN, ±Infinity và undefined. */
const anyNumberArb: fc.Arbitrary<number | undefined> = fc.oneof(
    fc.double({ min: -1e6, max: 1e6 }), // gồm cả các giá trị hữu hạn + có thể NaN
    fc.constantFrom(NaN, Infinity, -Infinity),
    fc.constant<number | undefined>(undefined),
);

/** Generator `ArtworkTransform` với mỗi trường có thể không hợp lệ. */
const transformArb: fc.Arbitrary<ArtworkTransform> = fc.record({
    scalePct: anyNumberArb,
    offsetXPct: anyNumberArb,
    offsetYPct: anyNumberArb,
}) as fc.Arbitrary<ArtworkTransform>;

describe('clampArtworkTransform — Property 17: Clamp tỉ lệ và vị trí ảnh nghệ thuật', () => {
    it('scalePct luôn ∈ [10, 1000] với mọi đầu vào (Yêu cầu 5.6, 5.8)', () => {
        fc.assert(
            fc.property(transformArb, (t) => {
                const out = clampArtworkTransform(t);
                expect(Number.isFinite(out.scalePct)).toBe(true);
                expect(out.scalePct).toBeGreaterThanOrEqual(SCALE_MIN_PCT);
                expect(out.scalePct).toBeLessThanOrEqual(SCALE_MAX_PCT);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('offsetXPct/offsetYPct luôn ∈ [-100, +100] với mọi đầu vào (Yêu cầu 5.7, 5.8)', () => {
        fc.assert(
            fc.property(transformArb, (t) => {
                const out = clampArtworkTransform(t);
                expect(Number.isFinite(out.offsetXPct)).toBe(true);
                expect(Number.isFinite(out.offsetYPct)).toBe(true);
                expect(out.offsetXPct).toBeGreaterThanOrEqual(OFFSET_MIN_PCT);
                expect(out.offsetXPct).toBeLessThanOrEqual(OFFSET_MAX_PCT);
                expect(out.offsetYPct).toBeGreaterThanOrEqual(OFFSET_MIN_PCT);
                expect(out.offsetYPct).toBeLessThanOrEqual(OFFSET_MAX_PCT);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('idempotent: clamp(clamp(t)) === clamp(t) (Yêu cầu 5.8)', () => {
        fc.assert(
            fc.property(transformArb, (t) => {
                const once = clampArtworkTransform(t);
                const twice = clampArtworkTransform(once);
                expect(twice).toEqual(once);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('giá trị không hợp lệ (NaN/undefined/±Infinity) → mặc định an toàn', () => {
        fc.assert(
            fc.property(
                fc.constantFrom<number | undefined>(NaN, undefined, Infinity, -Infinity),
                fc.constantFrom<number | undefined>(NaN, undefined, Infinity, -Infinity),
                fc.constantFrom<number | undefined>(NaN, undefined, Infinity, -Infinity),
                (s, ox, oy) => {
                    const out = clampArtworkTransform({
                        scalePct: s as number,
                        offsetXPct: ox as number,
                        offsetYPct: oy as number,
                    });
                    expect(out.scalePct).toBe(DEFAULT_SCALE_PCT);
                    expect(out.offsetXPct).toBe(DEFAULT_OFFSET_PCT);
                    expect(out.offsetYPct).toBe(DEFAULT_OFFSET_PCT);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('giá trị ngoài miền được kéo về biên gần nhất (Yêu cầu 5.8)', () => {
        fc.assert(
            fc.property(
                fc.double({ min: SCALE_MAX_PCT + 1e-6, max: 1e6, noNaN: true }),
                fc.double({ min: -1e6, max: SCALE_MIN_PCT - 1e-6, noNaN: true }),
                fc.double({ min: OFFSET_MAX_PCT + 1e-6, max: 1e6, noNaN: true }),
                fc.double({ min: -1e6, max: OFFSET_MIN_PCT - 1e-6, noNaN: true }),
                (overScale, underScale, overOffset, underOffset) => {
                    const high = clampArtworkTransform({
                        scalePct: overScale,
                        offsetXPct: overOffset,
                        offsetYPct: overOffset,
                    });
                    expect(high.scalePct).toBe(SCALE_MAX_PCT);
                    expect(high.offsetXPct).toBe(OFFSET_MAX_PCT);
                    expect(high.offsetYPct).toBe(OFFSET_MAX_PCT);

                    const low = clampArtworkTransform({
                        scalePct: underScale,
                        offsetXPct: underOffset,
                        offsetYPct: underOffset,
                    });
                    expect(low.scalePct).toBe(SCALE_MIN_PCT);
                    expect(low.offsetXPct).toBe(OFFSET_MIN_PCT);
                    expect(low.offsetYPct).toBe(OFFSET_MIN_PCT);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('giá trị hợp lệ trong miền được giữ nguyên', () => {
        fc.assert(
            fc.property(
                fc.double({ min: SCALE_MIN_PCT, max: SCALE_MAX_PCT, noNaN: true }),
                fc.double({ min: OFFSET_MIN_PCT, max: OFFSET_MAX_PCT, noNaN: true }),
                fc.double({ min: OFFSET_MIN_PCT, max: OFFSET_MAX_PCT, noNaN: true }),
                (s, ox, oy) => {
                    const out = clampArtworkTransform({ scalePct: s, offsetXPct: ox, offsetYPct: oy });
                    expect(out.scalePct).toBe(s);
                    expect(out.offsetXPct).toBe(ox);
                    expect(out.offsetYPct).toBe(oy);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
