// ============================================================
// Property test — foldCompensation.applyFoldCompensation
//
// Feature: mockup-3d-realism, Property 6: Áp bù bảo toàn thứ tự và quan hệ gập
// **Validates: Requirements 2.5**
//
// For any tập panel, sau khi `applyFoldCompensation` chạy, giá trị `foldPhase`
// và `depth` của mọi panel giữ nguyên không đổi so với trước khi áp bù. Hàm
// chỉ ĐỌC dữ liệu nên KHÔNG được mutate:
//   - các panel đầu vào (kể cả foldPhase/depth và mọi trường khác), và
//   - `depthMap` truyền vào.
//
// Cách kiểm: deep-clone toàn bộ đầu vào TRƯỚC khi gọi, gọi hàm, rồi assert
// deep-equality giữa đầu vào và bản clone sau lời gọi.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { applyFoldCompensation } from '../foldCompensation';
import type { Panel, Point2D } from '../types';

const NUM_RUNS = 200;

// ── Generators ──────────────────────────────────────────────

const coordArb = fc.double({ min: -500, max: 500, noNaN: true });
const pointArb: fc.Arbitrary<Point2D> = fc.record({ x: coordArb, y: coordArb });

/** Cạnh bản lề: 2 điểm phân biệt (đa số trường hợp), đôi khi null. */
const pivotEdgeArb: fc.Arbitrary<[Point2D, Point2D] | null> = fc.oneof(
    fc.tuple(pointArb, pointArb),
    fc.constant(null),
);

const foldPhaseArb: fc.Arbitrary<[number, number] | undefined> = fc.oneof(
    fc.tuple(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
    ),
    fc.constant(undefined),
);

/**
 * Sinh một cây panel: panel[0] là gốc (parent=null), các panel sau lấy panel
 * trước làm cha → tạo chuỗi gập thực sự để hàm chạy nhánh tích lũy ma trận.
 */
const panelTreeArb: fc.Arbitrary<Panel[]> = fc
    .array(
        fc.record({
            pivotEdge: pivotEdgeArb,
            foldAngle: fc.double({ min: -180, max: 180, noNaN: true }),
            foldDirection: fc.constantFrom<1 | -1>(1, -1),
            foldPhase: foldPhaseArb,
        }),
        { minLength: 1, maxLength: 6 },
    )
    .map((specs) =>
        specs.map((s, i) => {
            const panel: Panel = {
                name: `panel_${i}`,
                label: `Panel ${i}`,
                paths: [],
                parent: i === 0 ? null : `panel_${i - 1}`,
                pivotEdge: s.pivotEdge,
                foldAngle: s.foldAngle,
                foldDirection: s.foldDirection,
            };
            if (s.foldPhase !== undefined) panel.foldPhase = s.foldPhase;
            return panel;
        }),
    );

const foldProgressArb = fc.double({ min: 0, max: 1, noNaN: true });
const thicknessArb = fc.double({ min: 1e-6, max: 50, noNaN: true });

/** Deep clone giữ nguyên ngữ nghĩa giá trị (kể cả -0) để so sánh chính xác. */
const clonePanels = (panels: Panel[]): Panel[] =>
    panels.map((p) => structuredClone(p));
const cloneDepthMap = (m: Map<string, number>): Map<string, number> =>
    new Map(m);

describe('applyFoldCompensation — Property 6: Áp bù bảo toàn thứ tự và quan hệ gập', () => {
    it('không mutate panels (foldPhase/depth và mọi trường) sau khi áp bù (Yêu cầu 2.5)', () => {
        fc.assert(
            fc.property(
                panelTreeArb,
                foldProgressArb,
                thicknessArb,
                (panels, foldProgress, thickness) => {
                    // depthMap: gán depth = chỉ số panel trong chuỗi.
                    const depthMap = new Map<string, number>(
                        panels.map((p, i) => [p.name, i]),
                    );
                    const maxD = panels.length - 1;

                    const panelsBefore = clonePanels(panels);
                    const depthMapBefore = cloneDepthMap(depthMap);

                    // Áp bù cho TỪNG panel trong tập (mỗi panel một lần gọi).
                    for (const panel of panels) {
                        applyFoldCompensation(
                            panel,
                            panels,
                            foldProgress,
                            depthMap,
                            maxD,
                            thickness,
                        );
                    }

                    // foldPhase/depth và mọi trường khác giữ nguyên.
                    expect(panels).toEqual(panelsBefore);
                    // depthMap không bị thay đổi.
                    expect(depthMapBefore).toEqual(cloneDepthMap(depthMap));
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('giữ nguyên chính xác foldPhase và depth từng panel (Yêu cầu 2.5)', () => {
        fc.assert(
            fc.property(
                panelTreeArb,
                foldProgressArb,
                thicknessArb,
                (panels, foldProgress, thickness) => {
                    const depthMap = new Map<string, number>(
                        panels.map((p, i) => [p.name, i]),
                    );
                    const maxD = panels.length - 1;

                    const phasesBefore = panels.map((p) =>
                        p.foldPhase ? ([...p.foldPhase] as [number, number]) : undefined,
                    );
                    const depthsBefore = panels.map((p) => depthMap.get(p.name));

                    for (const panel of panels) {
                        applyFoldCompensation(
                            panel,
                            panels,
                            foldProgress,
                            depthMap,
                            maxD,
                            thickness,
                        );
                    }

                    panels.forEach((p, i) => {
                        expect(p.foldPhase).toEqual(phasesBefore[i]);
                        expect(depthMap.get(p.name)).toBe(depthsBefore[i]);
                    });
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
