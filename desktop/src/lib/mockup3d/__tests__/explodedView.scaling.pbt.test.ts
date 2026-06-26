// ============================================================
// Property test — explodedView.computeExplodedOffset
//
// Feature: mockup-3d-realism, Property 19: Exploded view tỉ lệ theo hệ số tách.
// **Validates: Requirements 7.5**
//
// Với một pháp tuyến KHÔNG suy biến (độ dài > 0) và khoảng cách cơ sở
// dương, độ dài của offset tách rời tỉ lệ TUYẾN TÍNH theo hệ số đã
// được clamp về miền [0.0, 5.0]:
//   - |offset(factor)| = clamp(factor) × spacing
//   - nhân đôi hệ số (khi cả hai vẫn trong [0,5]) → nhân đôi độ dài offset.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    computeExplodedOffset,
    clampExplodeFactor,
    MAX_EXPLODE_FACTOR,
    type Vec3,
} from '../explodedView';

const NUM_RUNS = 200;

function length(v: Vec3): number {
    return Math.hypot(v.x, v.y, v.z);
}

// Pháp tuyến KHÔNG suy biến: ít nhất một thành phần đủ lớn để độ dài > 0.
const nonDegenerateNormalArb: fc.Arbitrary<Vec3> = fc
    .record({
        x: fc.double({ min: -1000, max: 1000, noNaN: true }),
        y: fc.double({ min: -1000, max: 1000, noNaN: true }),
        z: fc.double({ min: -1000, max: 1000, noNaN: true }),
    })
    .filter((n) => Math.hypot(n.x, n.y, n.z) > 1e-3);

const spacingArb = fc.double({ min: 1e-3, max: 1000, noNaN: true }).filter((s) => s > 0);

describe('computeExplodedOffset — Property 19: Exploded view tỉ lệ theo hệ số tách', () => {
    it('độ dài offset = clamp(factor) × spacing cho pháp tuyến không suy biến (Yêu cầu 7.5)', () => {
        fc.assert(
            fc.property(
                nonDegenerateNormalArb,
                fc.double({ min: -2, max: 10, noNaN: true }),
                spacingArb,
                (normal, factor, spacing) => {
                    const offset = computeExplodedOffset(normal, factor, spacing);
                    const expectedLen = clampExplodeFactor(factor) * spacing;
                    const actualLen = length(offset);
                    // Sai số tương đối nhỏ do số dấu phẩy động.
                    expect(actualLen).toBeCloseTo(expectedLen, 6);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('nhân đôi hệ số (trong [0,5]) → nhân đôi độ dài offset', () => {
        fc.assert(
            fc.property(
                nonDegenerateNormalArb,
                // factor ∈ [0, 2.5] để 2*factor vẫn nằm trong [0, 5] (không bị clamp).
                fc.double({ min: 0, max: MAX_EXPLODE_FACTOR / 2, noNaN: true }),
                spacingArb,
                (normal, factor, spacing) => {
                    const single = computeExplodedOffset(normal, factor, spacing);
                    const doubled = computeExplodedOffset(normal, factor * 2, spacing);

                    const lenSingle = length(single);
                    const lenDoubled = length(doubled);

                    expect(lenDoubled).toBeCloseTo(2 * lenSingle, 6);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
