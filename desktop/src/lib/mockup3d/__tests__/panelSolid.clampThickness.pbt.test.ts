// ============================================================
// Property test — panelSolid.clampThickness
//
// Feature: mockup-3d-realism, Property 2: Chuẩn hóa độ dày hiển thị
// **Validates: Requirements 1.4, 1.6, 1.7**
//
// For any giá trị độ dày đầu vào (kể cả 0, số âm, NaN, undefined, hoặc > 50),
// `clampThickness` trả về:
//   - 0.5 khi không hợp lệ / ≤ 0 / NaN / undefined (Yêu cầu 1.6),
//   - đúng 50 khi > 50 (Yêu cầu 1.7),
//   - chính giá trị đó khi thuộc (0, 50] (Yêu cầu 1.4),
// và đầu ra luôn nằm trong (0, 50].
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { clampThickness } from '../panelSolid';

const DEFAULT_THICKNESS_MM = 0.5;
const MAX_THICKNESS_MM = 50;
const NUM_RUNS = 100;

describe('clampThickness — Property 2: Chuẩn hóa độ dày hiển thị', () => {
    it('≤ 0 → 0.5 (Yêu cầu 1.6)', () => {
        fc.assert(
            fc.property(
                fc.double({ min: -1e6, max: 0, noNaN: true }),
                (rawT) => {
                    expect(clampThickness(rawT)).toBe(DEFAULT_THICKNESS_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('NaN / undefined → 0.5 (Yêu cầu 1.6)', () => {
        fc.assert(
            fc.property(
                fc.constantFrom<Array<number | undefined>>(NaN, undefined),
                (rawT) => {
                    expect(clampThickness(rawT)).toBe(DEFAULT_THICKNESS_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('> 50 → 50 (Yêu cầu 1.7)', () => {
        fc.assert(
            fc.property(
                fc.double({
                    min: Math.fround(MAX_THICKNESS_MM + 1e-6),
                    max: 1e6,
                    noNaN: true,
                }).filter((t) => t > MAX_THICKNESS_MM),
                (rawT) => {
                    expect(clampThickness(rawT)).toBe(MAX_THICKNESS_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('thuộc (0, 50] → giữ nguyên (Yêu cầu 1.4)', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 1e-9, max: MAX_THICKNESS_MM, noNaN: true })
                    .filter((t) => t > 0 && t <= MAX_THICKNESS_MM),
                (rawT) => {
                    expect(clampThickness(rawT)).toBe(rawT);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('đầu ra luôn nằm trong (0, 50] với mọi đầu vào', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.double({ min: -1e6, max: 1e6 }), // gồm cả NaN, ±, biên
                    fc.constant(NaN),
                    fc.constant(undefined),
                ),
                (rawT) => {
                    const out = clampThickness(rawT as number | undefined);
                    expect(out).toBeGreaterThan(0);
                    expect(out).toBeLessThanOrEqual(MAX_THICKNESS_MM);
                    expect(Number.isNaN(out)).toBe(false);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
