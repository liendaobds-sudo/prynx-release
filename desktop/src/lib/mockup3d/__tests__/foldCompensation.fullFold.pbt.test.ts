// ============================================================
// Property test — foldCompensation.applyFoldCompensation (gập hoàn toàn)
//
// Feature: mockup-3d-realism, Property 5: Gập hoàn toàn cho khít không xuyên, không hở
// **Validates: Requirements 2.2, 2.3**
//
// For any cây panel hợp lệ, khi `foldProgress = 1` và đã áp bù độ dày, mọi cặp
// panel kề nhau có độ giao cắt thể tích ≤ 5% độ dày và khe hở giữa các mép kề
// nhau ≤ 5% độ dày. Ở lớp logic thuần, điều này được bảo đảm bởi lượng bù độ
// dày đã áp:
//   - LƯỢNG BÙ ≠ 0 (≥ 0.01 mm) → có dịch chuyển tách hai mặt nên panel KHÔNG
//     xuyên vào nhau (không interpenetration).
//   - LƯỢNG BÙ BỊ CHẶN (≤ 5.00 mm) → khe tách không quá lớn nên panel KHÔNG
//     hở khe.
// Đồng thời lượng bù THỰC SỰ ÁP trong ma trận kết quả phải đúng bằng giá trị
// `computeFoldThicknessOffset` (giữ hai mặt khít theo đúng độ dày vật liệu).
//
// Quan sát hình học: với panel con gập quanh cạnh bản lề, ma trận kết quả dịch
// trung điểm cạnh bản lề đi đúng |comp| (vì các phép xoay là đẳng cự). Do đó độ
// dịch chuyển của trung điểm = lượng bù đã áp.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as THREE from 'three';
import {
    applyFoldCompensation,
    computeFoldThicknessOffset,
    MIN_FOLD_COMP_MM,
    MAX_FOLD_COMP_MM,
    FOLD_COMP_VISUAL_MM,
} from '../foldCompensation';
import type { Panel, Point2D } from '../types';

const NUM_RUNS = 200;
const EPS = 1e-6;

// Generator cho một tọa độ hữu hạn (mm).
const coordArb = fc.double({ min: -500, max: 500, noNaN: true });

// Generator cho cạnh bản lề hợp lệ: 2 điểm hữu hạn KHÔNG trùng nhau.
const pivotEdgeArb: fc.Arbitrary<[Point2D, Point2D]> = fc
    .record({
        x: coordArb,
        y: coordArb,
        dx: fc.double({ min: -300, max: 300, noNaN: true }),
        dy: fc.double({ min: -300, max: 300, noNaN: true }),
    })
    .filter(({ dx, dy }) => Math.hypot(dx, dy) > 1) // đảm bảo hai điểm tách biệt rõ
    .map(({ x, y, dx, dy }) => [
        { x, y },
        { x: x + dx, y: y + dy },
    ]);

// Góc gập mục tiêu cho "gập hoàn toàn" — giá trị gập có ý nghĩa.
const foldAngleArb = fc.double({ min: 1, max: 270, noNaN: true });

// Độ dày vật liệu hợp lệ (mm), > 0.
const thicknessArb = fc.double({ min: 0.05, max: 80, noNaN: true });

/** Tạo cây panel tối giản: gốc (không gập) + con (gập quanh pivotEdge). */
function buildTree(
    pivotEdge: [Point2D, Point2D],
    foldAngle: number,
): { root: Panel; child: Panel; allPanels: Panel[]; depthMap: Map<string, number>; maxD: number } {
    const root: Panel = {
        name: 'root',
        label: 'Gốc',
        paths: [],
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
    };
    const child: Panel = {
        name: 'child',
        label: 'Con',
        paths: [],
        parent: 'root',
        pivotEdge,
        foldAngle,
        foldDirection: 1,
        // foldPhase [0,1] để tại foldProgress=1 góc gập hiệu dụng = foldAngle (tất định).
        foldPhase: [0, 1],
    };
    const depthMap = new Map<string, number>([
        ['root', 0],
        ['child', 1],
    ]);
    return { root, child, allPanels: [root, child], depthMap, maxD: 1 };
}

/** Mọi phần tử của Matrix4 đều hữu hạn. */
function isFiniteMatrix(m: THREE.Matrix4): boolean {
    return m.elements.every((e) => Number.isFinite(e));
}

describe('applyFoldCompensation — Property 5: Gập hoàn toàn cho khít không xuyên, không hở', () => {
    it('lượng bù đã áp = computeFoldThicknessOffset, ≠0 và bị chặn [0.01,5] (Yêu cầu 2.2, 2.3)', () => {
        fc.assert(
            fc.property(pivotEdgeArb, foldAngleArb, thicknessArb, (pivotEdge, foldAngle, thickness) => {
                const { child, allPanels, depthMap, maxD } = buildTree(pivotEdge, foldAngle);

                const result = applyFoldCompensation(child, allPanels, 1, depthMap, maxD, thickness);

                // Panel hình học đầy đủ → không bị bỏ qua.
                expect(result.skipped).toBe(false);
                expect(result.warning).toBeUndefined();

                // Ma trận kết quả là Matrix4 hợp lệ, mọi phần tử hữu hạn.
                expect(result.matrix).toBeInstanceOf(THREE.Matrix4);
                expect(isFiniteMatrix(result.matrix)).toBe(true);

                // Lượng bù kỳ vọng (cùng đầu vào hình học: depth=1, foldAngle hiệu dụng = foldAngle).
                const expectedOffset = computeFoldThicknessOffset({
                    depth: 1,
                    thickness,
                    foldAngleDeg: foldAngle,
                });

                // Offset phải nằm trong miền bù hợp lệ và KHÔNG bằng 0 (không xuyên),
                // bị chặn trên bởi 5mm (không hở).
                expect(expectedOffset).toBeGreaterThanOrEqual(MIN_FOLD_COMP_MM);
                expect(expectedOffset).toBeLessThanOrEqual(MAX_FOLD_COMP_MM);
                expect(expectedOffset).toBeGreaterThan(0);

                // Lượng bù THỰC SỰ áp trong ma trận = độ dịch chuyển trung điểm cạnh bản lề
                // (các phép xoay là đẳng cự nên độ dịch = |comp đã áp|).
                // Mỗi panel ĐÃ được ép khối dày T (buildPanelSolid) nên lượng dịch áp vào
                // ma trận bị KẸP ở FOLD_COMP_VISUAL_MM để không nhấc đáy panel khỏi đường
                // gập (không hở khớp). Do đó: appliedComp = min(expectedOffset, cap).
                const [p1, p2] = pivotEdge;
                const mid = new THREE.Vector3((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, 0);
                const moved = mid.clone().applyMatrix4(result.matrix);
                const appliedComp = moved.distanceTo(mid);

                const expectedApplied = Math.min(expectedOffset, FOLD_COMP_VISUAL_MM);
                expect(Math.abs(appliedComp - expectedApplied)).toBeLessThanOrEqual(
                    EPS + 1e-9 * Math.abs(expectedApplied),
                );

                // Hệ quả: lượng bù đã áp ≠ 0 (không xuyên) và ≤ cap (không hở).
                expect(appliedComp).toBeGreaterThan(0);
                expect(appliedComp).toBeLessThanOrEqual(FOLD_COMP_VISUAL_MM + EPS);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('tái sử dụng Matrix4 scratch mà không đổi kết quả hình học', () => {
        const pivot: [Point2D, Point2D] = [{ x: 0, y: 0 }, { x: 120, y: 0 }];
        const { child, allPanels, depthMap, maxD } = buildTree(pivot, 90);
        const scratch = {
            result: new THREE.Matrix4(),
            step: new THREE.Matrix4(),
            temp: new THREE.Matrix4(),
        };

        const optimized = applyFoldCompensation(
            child, allPanels, 0.65, depthMap, maxD, 1.5, scratch,
        );
        const reference = applyFoldCompensation(
            child, allPanels, 0.65, depthMap, maxD, 1.5,
        );

        expect(optimized.matrix).toBe(scratch.result);
        optimized.matrix.elements.forEach((value, index) => {
            expect(value).toBeCloseTo(reference.matrix.elements[index], 12);
        });

        const reused = applyFoldCompensation(
            child, allPanels, 1, depthMap, maxD, 1.5, scratch,
        );
        expect(reused.matrix).toBe(scratch.result);
        expect(reused.matrix.elements.every(Number.isFinite)).toBe(true);
    });
});
