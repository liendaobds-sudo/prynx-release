// ============================================================
// Property test — foldCompensation.computeFoldThicknessOffset
//
// Feature: mockup-3d-realism, Property 4: Bù độ dày tỉ lệ theo độ dày và độc lập với tên panel
// **Validates: Requirements 2.1, 2.4**
//
// For any panel có quan hệ gập và độ dày trong miền hợp lệ, lượng bù do
// `computeFoldThicknessOffset` tính ra:
//   - tỉ lệ đơn điệu KHÔNG GIẢM theo độ dày (Yêu cầu 2.1),
//   - luôn nằm trong miền bù [0.01, 5.00] mm sau khi tỉ lệ (Yêu cầu 2.1),
//   - độc lập với tên panel — hàm không nhận tên làm đầu vào, nên biến thiên
//     dữ liệu không liên quan (ví dụ trường `name`) KHÔNG làm đổi đầu ra với
//     cùng depth/thickness/foldAngle (Yêu cầu 2.4).
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
    computeFoldThicknessOffset,
    MIN_FOLD_COMP_MM,
    MAX_FOLD_COMP_MM,
} from '../foldCompensation';

const NUM_RUNS = 200;

// Generator cho độ sâu cây gập (số tầng tích lũy, không âm).
const depthArb = fc.double({ min: 0, max: 50, noNaN: true });

// Generator cho góc gập mục tiêu (độ).
const foldAngleArb = fc.double({ min: -360, max: 360, noNaN: true });

// Generator cho độ dày vật liệu hợp lệ (mm), > 0.
const thicknessArb = fc.double({ min: 1e-6, max: 100, noNaN: true });

describe('computeFoldThicknessOffset — Property 4: Bù độ dày tỉ lệ & độc lập tên panel', () => {
    it('đơn điệu không giảm theo độ dày với cùng depth/foldAngle (Yêu cầu 2.1)', () => {
        fc.assert(
            fc.property(
                depthArb,
                foldAngleArb,
                thicknessArb,
                thicknessArb,
                (depth, foldAngleDeg, ta, tb) => {
                    const tLow = Math.min(ta, tb);
                    const tHigh = Math.max(ta, tb);
                    const offLow = computeFoldThicknessOffset({
                        depth,
                        thickness: tLow,
                        foldAngleDeg,
                    });
                    const offHigh = computeFoldThicknessOffset({
                        depth,
                        thickness: tHigh,
                        foldAngleDeg,
                    });
                    // Độ dày lớn hơn → lượng bù không nhỏ hơn (clamp bảo toàn đơn điệu).
                    expect(offHigh).toBeGreaterThanOrEqual(offLow);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('luôn nằm trong miền bù [0.01, 5.00] mm với mọi đầu vào (Yêu cầu 2.1)', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    depthArb,
                    fc.constant(NaN),
                    fc.constant(Number.POSITIVE_INFINITY),
                    fc.constant(-1),
                ),
                fc.oneof(
                    foldAngleArb,
                    fc.constant(NaN),
                    fc.constant(Number.POSITIVE_INFINITY),
                ),
                fc.oneof(
                    thicknessArb,
                    fc.constant(0),
                    fc.constant(-5),
                    fc.constant(NaN),
                    fc.constant(Number.POSITIVE_INFINITY),
                ),
                (depth, foldAngleDeg, thickness) => {
                    const off = computeFoldThicknessOffset({ depth, thickness, foldAngleDeg });
                    expect(Number.isFinite(off)).toBe(true);
                    expect(off).toBeGreaterThanOrEqual(MIN_FOLD_COMP_MM);
                    expect(off).toBeLessThanOrEqual(MAX_FOLD_COMP_MM);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('độc lập với tên panel / dữ liệu không liên quan (Yêu cầu 2.4)', () => {
        fc.assert(
            fc.property(
                depthArb,
                foldAngleArb,
                thicknessArb,
                fc.string(),
                fc.string(),
                (depth, foldAngleDeg, thickness, nameA, nameB) => {
                    // Kết quả tham chiếu chỉ từ hình học (depth/thickness/foldAngle).
                    const reference = computeFoldThicknessOffset({
                        depth,
                        thickness,
                        foldAngleDeg,
                    });

                    // Gắn thêm trường `name` (và dữ liệu không liên quan) vào args.
                    // Hàm không đọc các trường này nên đầu ra phải y hệt reference.
                    const argsWithName = {
                        depth,
                        thickness,
                        foldAngleDeg,
                        name: nameA,
                        parent: nameB,
                        unrelated: Math.random(),
                    } as { depth: number; thickness: number; foldAngleDeg: number };

                    const withNameA = computeFoldThicknessOffset(argsWithName);
                    const withNameB = computeFoldThicknessOffset({
                        depth,
                        thickness,
                        foldAngleDeg,
                        name: nameB,
                    } as { depth: number; thickness: number; foldAngleDeg: number });

                    expect(withNameA).toBe(reference);
                    expect(withNameB).toBe(reference);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
