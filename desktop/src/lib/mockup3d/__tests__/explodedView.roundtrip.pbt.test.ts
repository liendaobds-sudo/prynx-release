// ============================================================
// Property test — explodedView round-trip (factor = 0 khôi phục lắp ráp)
//
// Feature: mockup-3d-realism, Property 20: Tách rồi gộp khôi phục vị trí lắp ráp (round-trip)
// **Validates: Requirements 7.6**
//
// Với mọi vị trí lắp ráp gốc (basePosition), pháp tuyến panel (normal) và
// khoảng cách cơ sở (spacing):
//   - `applyExplodedOffset(basePosition, normal, 0)` trả về ĐÚNG basePosition
//     về mặt giá trị (hệ số 0 → offset (0,0,0) → khôi phục vị trí lắp ráp).
//   - Với hệ số tách rời BẤT KỲ, sau khi tách rồi đặt hệ số về 0, vị trí
//     thu được lại trùng khớp với basePosition (round-trip an toàn).
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { applyExplodedOffset, computeExplodedOffset, type Vec3 } from '../explodedView';

const NUM_RUNS = 200;

// So sánh theo GIÁ TRỊ SỐ (numeric equality): coi -0 và +0 là bằng nhau.
// "Khôi phục vị trí lắp ráp" là tính chất trên giá trị số; phép cộng IEEE
// có thể đổi -0 thành +0 (vd: -0 + 0 = +0) nhưng hai giá trị này bằng nhau
// về số học (-0 === +0). Tránh Object.is của `toBe` vốn phân biệt dấu của 0.
function expectSameComponent(actual: number, expected: number): void {
    expect(actual === expected).toBe(true);
}

// Tọa độ hữu hạn trong miền cảnh (mm).
const coordArb = fc.double({ min: -1000, max: 1000, noNaN: true });

// Vector vị trí / pháp tuyến hữu hạn.
const vec3Arb: fc.Arbitrary<Vec3> = fc.record({
    x: coordArb,
    y: coordArb,
    z: coordArb,
});

// Khoảng cách cơ sở (mm) ứng với 1 đơn vị hệ số.
const spacingArb = fc.double({ min: 0, max: 100, noNaN: true });

// Hệ số tách rời thô bất kỳ (bao gồm ngoài miền & suy biến).
const factorArb = fc.oneof(
    fc.double({ min: -10, max: 10, noNaN: true }),
    fc.constant(0),
    fc.constant(5),
    fc.constant(NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
);

describe('explodedView — Property 20: Tách rồi gộp khôi phục vị trí lắp ráp (round-trip)', () => {
    it('factor = 0 trả về đúng basePosition (Yêu cầu 7.6)', () => {
        fc.assert(
            fc.property(vec3Arb, vec3Arb, spacingArb, (basePosition, normal, spacing) => {
                const result = applyExplodedOffset(basePosition, normal, 0, spacing);
                expectSameComponent(result.x, basePosition.x);
                expectSameComponent(result.y, basePosition.y);
                expectSameComponent(result.z, basePosition.z);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('tách với hệ số bất kỳ rồi gộp (factor=0) khôi phục vị trí lắp ráp (Yêu cầu 7.6)', () => {
        fc.assert(
            fc.property(
                vec3Arb,
                vec3Arb,
                factorArb,
                spacingArb,
                (basePosition, normal, factor, spacing) => {
                    // Bước tách: áp hệ số bất kỳ.
                    applyExplodedOffset(basePosition, normal, factor, spacing);
                    // Bước gộp: đặt hệ số về 0 → phải về đúng vị trí lắp ráp gốc.
                    const reassembled = applyExplodedOffset(basePosition, normal, 0, spacing);
                    expectSameComponent(reassembled.x, basePosition.x);
                    expectSameComponent(reassembled.y, basePosition.y);
                    expectSameComponent(reassembled.z, basePosition.z);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('computeExplodedOffset với hệ số 0 cho offset đúng (0,0,0) (Yêu cầu 7.6)', () => {
        fc.assert(
            fc.property(vec3Arb, spacingArb, (normal, spacing) => {
                const offset = computeExplodedOffset(normal, 0, spacing);
                expect(offset.x).toBe(0);
                expect(offset.y).toBe(0);
                expect(offset.z).toBe(0);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
