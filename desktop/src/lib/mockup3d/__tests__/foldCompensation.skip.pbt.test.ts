// ============================================================
// Property test — foldCompensation.applyFoldCompensation (skip an toàn)
//
// Feature: mockup-3d-realism, Property 7: Panel thiếu hình học bị bỏ qua an toàn
// **Validates: Requirements 2.6**
//
// For any panel có quan hệ gập (parent / pivotEdge / foldAngle ≠ 0) nhưng
// THIẾU hoặc KHÔNG HỢP LỆ một trong các thuộc tính hình học
// (pivotEdge / parent / depth):
//   - `applyFoldCompensation` trả về `skipped = true`,
//   - kèm chuỗi `warning` xác định panel đó,
//   - và KHÔNG ném lỗi.
// Ngược lại, một panel gập đầy đủ hình học (pivotEdge hợp lệ + parent ≠ null
// + depth hợp lệ) trả về `skipped = false`.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as THREE from 'three';
import { applyFoldCompensation } from '../foldCompensation';
import type { Panel, Point2D } from '../types';

const NUM_RUNS = 200;

// ── Generators dùng chung ──────────────────────────────────

/** Điểm 2D có tọa độ hữu hạn. */
const finitePointArb = fc.record({
    x: fc.double({ min: -1000, max: 1000, noNaN: true }),
    y: fc.double({ min: -1000, max: 1000, noNaN: true }),
});

/** Cạnh bản lề HỢP LỆ: 2 điểm hữu hạn, không trùng nhau. */
const validPivotEdgeArb: fc.Arbitrary<[Point2D, Point2D]> = fc
    .record({
        p1: finitePointArb,
        dx: fc.double({ min: -200, max: 200, noNaN: true }),
        dy: fc.double({ min: -200, max: 200, noNaN: true }),
    })
    .filter(({ dx, dy }) => Math.hypot(dx, dy) > 1e-2)
    .map(({ p1, dx, dy }) => [p1, { x: p1.x + dx, y: p1.y + dy }] as [Point2D, Point2D]);

/** Cạnh bản lề KHÔNG HỢP LỆ: null, rỗng, trùng điểm, hoặc tọa độ không hữu hạn. */
const invalidPivotEdgeArb = fc.oneof(
    fc.constant(null),
    fc.constant([] as unknown as [Point2D, Point2D]),
    // Hai điểm trùng nhau → không có phương trục gập.
    finitePointArb.map((p) => [p, { x: p.x, y: p.y }] as [Point2D, Point2D]),
    // Tọa độ không hữu hạn.
    fc.constant([{ x: NaN, y: 0 }, { x: 1, y: 1 }] as [Point2D, Point2D]),
    fc.constant([{ x: 0, y: 0 }, { x: Infinity, y: 1 }] as [Point2D, Point2D]),
);

/** Tên panel không rỗng (để định danh trong cảnh báo). */
const panelNameArb = fc
    .string({ minLength: 1, maxLength: 12 })
    .map((s) => `panel_${s.replace(/\s/g, '_')}`);

/** Góc gập KHÁC 0 → đảm bảo panel "có quan hệ gập" (hasFoldRelation = true). */
const nonZeroFoldAngleArb = fc.oneof(
    fc.double({ min: 1, max: 360, noNaN: true }),
    fc.double({ min: -360, max: -1, noNaN: true }),
);

const foldDirectionArb: fc.Arbitrary<1 | -1> = fc.constantFrom(1, -1);
const foldProgressArb = fc.double({ min: 0, max: 1, noNaN: true });
const thicknessArb = fc.double({ min: 1e-3, max: 100, noNaN: true });
const maxDArb = fc.double({ min: 0, max: 50, noNaN: true });

/** Tạo panel cơ bản với các trường bắt buộc. */
function makePanel(overrides: Partial<Panel> & { name: string }): Panel {
    return {
        label: overrides.name,
        paths: [],
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
        ...overrides,
    };
}

// ── Property 7: panel thiếu hình học → skipped + warning, không ném ──

describe('applyFoldCompensation — Property 7: Panel thiếu hình học bị bỏ qua an toàn', () => {
    it('panel có quan hệ gập nhưng thiếu/không hợp lệ hình học → skipped=true + warning, không ném (Yêu cầu 2.6)', () => {
        fc.assert(
            fc.property(
                panelNameArb,
                nonZeroFoldAngleArb,
                foldDirectionArb,
                foldProgressArb,
                thicknessArb,
                maxDArb,
                // Chọn tổ hợp tính hợp lệ của 3 thuộc tính, đảm bảo KHÔNG đủ cả 3.
                fc
                    .record({
                        pivotValid: fc.boolean(),
                        parentValid: fc.boolean(),
                        depthValid: fc.boolean(),
                    })
                    .filter(
                        ({ pivotValid, parentValid, depthValid }) =>
                            !(pivotValid && parentValid && depthValid),
                    ),
                validPivotEdgeArb,
                invalidPivotEdgeArb,
                fc.double({ min: 0, max: 50, noNaN: true }),
                (
                    name,
                    foldAngle,
                    foldDirection,
                    foldProgress,
                    thickness,
                    maxD,
                    flags,
                    validPivot,
                    invalidPivot,
                    depthVal,
                ) => {
                    const pivotEdge = flags.pivotValid ? validPivot : invalidPivot;
                    const parent = flags.parentValid ? 'root_parent' : null;

                    const panel = makePanel({
                        name,
                        parent,
                        pivotEdge,
                        foldAngle,
                        foldDirection,
                    });

                    const depthMap = new Map<string, number>();
                    if (flags.depthValid) {
                        depthMap.set(name, depthVal);
                    }

                    let result: ReturnType<typeof applyFoldCompensation> | undefined;
                    expect(() => {
                        result = applyFoldCompensation(
                            panel,
                            [panel],
                            foldProgress,
                            depthMap,
                            maxD,
                            thickness,
                        );
                    }).not.toThrow();

                    expect(result).toBeDefined();
                    // Thiếu hình học → bỏ qua bù an toàn.
                    expect(result!.skipped).toBe(true);
                    // Cảnh báo là chuỗi không rỗng và xác định đúng panel.
                    expect(typeof result!.warning).toBe('string');
                    expect(result!.warning!.length).toBeGreaterThan(0);
                    expect(result!.warning).toContain(name);
                    // Ma trận vẫn hợp lệ (vị trí gập cơ bản, không ném).
                    expect(result!.matrix).toBeInstanceOf(THREE.Matrix4);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('panel gập đầy đủ hình học (pivot hợp lệ + parent + depth) → skipped=false, không warning (Yêu cầu 2.6)', () => {
        fc.assert(
            fc.property(
                panelNameArb,
                nonZeroFoldAngleArb,
                foldDirectionArb,
                foldProgressArb,
                thicknessArb,
                maxDArb,
                validPivotEdgeArb,
                fc.double({ min: 0, max: 50, noNaN: true }),
                (
                    name,
                    foldAngle,
                    foldDirection,
                    foldProgress,
                    thickness,
                    maxD,
                    validPivot,
                    depthVal,
                ) => {
                    const panel = makePanel({
                        name,
                        parent: 'root_parent',
                        pivotEdge: validPivot,
                        foldAngle,
                        foldDirection,
                    });

                    const depthMap = new Map<string, number>([[name, depthVal]]);

                    let result: ReturnType<typeof applyFoldCompensation> | undefined;
                    expect(() => {
                        result = applyFoldCompensation(
                            panel,
                            [panel],
                            foldProgress,
                            depthMap,
                            maxD,
                            thickness,
                        );
                    }).not.toThrow();

                    expect(result).toBeDefined();
                    // Hình học đầy đủ → KHÔNG bỏ qua.
                    expect(result!.skipped).toBe(false);
                    expect(result!.warning).toBeUndefined();
                    expect(result!.matrix).toBeInstanceOf(THREE.Matrix4);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
