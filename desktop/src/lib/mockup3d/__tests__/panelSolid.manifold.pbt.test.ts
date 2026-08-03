// ============================================================
// Property test — panelSolid.buildPanelSolid (manifold / khép kín)
//
// Feature: mockup-3d-realism, Property 1: Panel solid khép kín dọc chu vi và mọi lỗ khoét
// **Validates: Requirements 1.1, 1.5**
//
// For any panel hợp lệ (outline ≥ 3 đỉnh, kèm danh sách lỗ khoét tùy ý) và
// độ dày dương, geometry do `buildPanelSolid` sinh ra phải khép kín (manifold):
// mỗi cạnh biên của mặt ngoài và mặt trong — bao gồm cả mép của từng lỗ khoét —
// đều được nối bằng tường cạnh, không tồn tại cạnh biên hở. Cụ thể: sau khi hàn
// (weld) các đỉnh trùng vị trí, MỌI cạnh không định hướng đều được chia sẻ bởi
// đúng 2 tam giác (cạnh biên hở chỉ thuộc 1 tam giác).
//
// Đồng thời kiểm: tồn tại mặt + tường cạnh (position attribute không rỗng) và
// bề dày (z-extent) khớp `clampThickness(thickness)` với sai số ≤ 0.01 mm.
//
// Mỗi property chạy ≥ 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as THREE from 'three';
import { arbBoxParams } from '../../dieline/arbitraries';
import { generateFlipTopTuckBox } from '../../dieline/FlipTopTuckBox';
import { DEFAULT_PARAMS } from '../../dieline/types';
import { buildPanelSolid, clampThickness } from '../panelSolid';
import type { Panel, Point2D } from '../types';

const NUM_RUNS = 100;
const MAX_THICKNESS_MM = 50;
// Dung sai hàn đỉnh (mm). Tọa độ panel ~O(100mm), depth ≤ 50mm; làm tròn 3 chữ số
// thập phân (0.001mm) đủ để hàn các đỉnh trùng vị trí mà không gộp nhầm đỉnh khác.
const WELD_DECIMALS = 3;

/** Tạo đa giác hình sao (radial, góc tăng dần) ⇒ luôn đơn (không tự cắt). */
function regularPolygon(
    cx: number,
    cy: number,
    radius: number,
    n: number,
    jitter: number[],
): Point2D[] {
    const pts: Point2D[] = [];
    for (let i = 0; i < n; i++) {
        const ang = (2 * Math.PI * i) / n;
        const r = radius * (1 + jitter[i % jitter.length]);
        pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
    }
    return pts;
}

/** Sinh một panel hợp lệ: outline đa giác đơn + 0..2 lỗ khoét nằm trong outline. */
const panelArb = fc
    .record({
        baseR: fc.double({ min: 40, max: 80, noNaN: true }),
        n: fc.integer({ min: 3, max: 10 }),
        jitter: fc.array(fc.double({ min: -0.05, max: 0.05, noNaN: true }), {
            minLength: 10,
            maxLength: 10,
        }),
        holeCount: fc.integer({ min: 0, max: 2 }),
        holeR: fc.double({ min: 3, max: 8, noNaN: true }),
        holeN: fc.integer({ min: 3, max: 6 }),
    })
    .map(({ baseR, n, jitter, holeCount, holeR, holeN }): Panel => {
        const outline = regularPolygon(0, 0, baseR, n, jitter);

        const holes: Point2D[][] = [];
        // Tâm lỗ tách xa nhau dọc trục x, bán kính nhỏ ⇒ nằm trong outline & không chồng nhau.
        const holeCenters: Array<[number, number]> = [
            [0, 0],
            // 0.25R keeps the largest generated holes strictly inside the
            // worst-case triangular outline and leaves a gap between two holes.
            [-baseR * 0.25, 0],
            [baseR * 0.25, 0],
        ];
        if (holeCount === 1) {
            holes.push(regularPolygon(0, 0, holeR, holeN, [0]));
        } else if (holeCount === 2) {
            holes.push(regularPolygon(holeCenters[1][0], holeCenters[1][1], holeR, holeN, [0]));
            holes.push(regularPolygon(holeCenters[2][0], holeCenters[2][1], holeR, holeN, [0]));
        }

        return {
            name: 'gen-panel',
            label: 'gen-panel',
            paths: [],
            outline,
            holes: holes.length > 0 ? holes : undefined,
            parent: null,
            pivotEdge: null,
            foldAngle: 0,
            foldDirection: 1,
        };
    });

interface ManifoldStats {
    triangleCount: number;
    boundaryEdges: number; // cạnh chỉ thuộc 1 tam giác (biên hở)
    nonManifoldEdges: number; // cạnh thuộc > 2 tam giác
    degenerateTriangles: number;
}

/** Hàn đỉnh theo vị trí rồi đếm số tam giác chia sẻ mỗi cạnh không định hướng. */
function analyzeManifold(geometry: THREE.BufferGeometry): ManifoldStats {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = geometry.getIndex();

    const factor = 10 ** WELD_DECIMALS;
    const keyToId = new Map<string, number>();
    const idOf = (vi: number): number => {
        const x = Math.round(pos.getX(vi) * factor) / factor;
        const y = Math.round(pos.getY(vi) * factor) / factor;
        const z = Math.round(pos.getZ(vi) * factor) / factor;
        const key = `${x},${y},${z}`;
        let id = keyToId.get(key);
        if (id === undefined) {
            id = keyToId.size;
            keyToId.set(key, id);
        }
        return id;
    };

    const triCount = index ? index.count / 3 : pos.count / 3;
    const edgeCount = new Map<string, number>();
    let degenerate = 0;

    for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        const a = idOf(i0);
        const b = idOf(i1);
        const c = idOf(i2);

        if (a === b || b === c || a === c) {
            degenerate++;
            continue; // bỏ tam giác suy biến khỏi phép đếm cạnh
        }

        for (const [u, v] of [
            [a, b],
            [b, c],
            [c, a],
        ]) {
            const key = u < v ? `${u}_${v}` : `${v}_${u}`;
            edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
        }
    }

    let boundary = 0;
    let nonManifold = 0;
    for (const count of edgeCount.values()) {
        if (count === 1) boundary++;
        else if (count > 2) nonManifold++;
    }

    return {
        triangleCount: triCount,
        boundaryEdges: boundary,
        nonManifoldEdges: nonManifold,
        degenerateTriangles: degenerate,
    };
}

describe('buildPanelSolid — Property 1: Panel solid khép kín dọc chu vi và mọi lỗ khoét', () => {
    it('dựng đủ 13 solid theo outline cong thật của flip-top tuck', () => {
        const model = generateFlipTopTuckBox({
            ...DEFAULT_PARAMS,
            boxType: 'flip_top_tuck',
            L: 200,
            W: 200,
            D: 60,
            T: 0.5,
            C: 0.5,
        });

        expect(model.panels).toHaveLength(13);
        for (const panel of model.panels) {
            const geometry = buildPanelSolid(panel, model.params.T);
            try {
                const stats = analyzeManifold(geometry);
                expect(stats.triangleCount, panel.name).toBeGreaterThan(0);
                expect(stats.boundaryEdges, panel.name).toBe(0);
                expect(stats.nonManifoldEdges, panel.name).toBe(0);
            } finally {
                geometry.dispose();
            }
        }
    });

    it('flip-top tuck khoét xuyên hai khe hông và khe nhận khóa trước', () => {
        const model = generateFlipTopTuckBox({
            ...DEFAULT_PARAMS,
            boxType: 'flip_top_tuck',
            L: 200,
            W: 200,
            D: 60,
            T: 0.5,
            C: 0.5,
        });
        const byName = new Map(model.panels.map((panel) => [panel.name, panel]));
        const slots = [
            { panel: byName.get('base_side_left')!, point: { x: -28.5, y: 359.5 } },
            { panel: byName.get('base_side_right')!, point: { x: 229.5, y: 359.5 } },
            { panel: byName.get('lid_front')!, point: { x: 100.5, y: -10 } },
        ];

        for (const { panel, point } of slots) {
            expect(panel.holes, panel.name).toHaveLength(1);
            const geometry = buildPanelSolid(panel, model.params.T);
            const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(geometry, material);
            const raycaster = new THREE.Raycaster(
                new THREE.Vector3(point.x, point.y, 10),
                new THREE.Vector3(0, 0, -1),
            );
            try {
                expect(raycaster.intersectObject(mesh), panel.name).toHaveLength(0);
            } finally {
                geometry.dispose();
                material.dispose();
            }
        }
    });

    it('ba khe cài flip-top tuck giữ solid khép kín trên miền tham số hợp lệ', () => {
        fc.assert(
            fc.property(arbBoxParams('flip_top_tuck'), (params) => {
                const model = generateFlipTopTuckBox(params);
                for (const name of ['base_side_left', 'base_side_right', 'lid_front']) {
                    const panel = model.panels.find((candidate) => candidate.name === name)!;
                    const hole = panel.holes?.[0];
                    expect(hole, name).toBeDefined();
                    const geometry = buildPanelSolid(panel, model.params.T);
                    try {
                        const stats = analyzeManifold(geometry);
                        const context = `${name} hole=${JSON.stringify(hole)}`;
                        expect(stats.boundaryEdges, context).toBe(0);
                        expect(stats.nonManifoldEdges, context).toBe(0);
                    } finally {
                        geometry.dispose();
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('không có cạnh biên hở: mọi cạnh được chia sẻ bởi đúng 2 tam giác', () => {
        fc.assert(
            fc.property(
                panelArb,
                fc.double({ min: 0.1, max: MAX_THICKNESS_MM, noNaN: true }),
                (panel, thickness) => {
                    const geo = buildPanelSolid(panel, thickness);
                    try {
                        const stats = analyzeManifold(geo);

                        // Có hình học thực sự (mặt + tường cạnh).
                        expect(stats.triangleCount).toBeGreaterThan(0);
                        // Khép kín: không cạnh biên hở, không cạnh phi-manifold.
                        expect(stats.boundaryEdges).toBe(0);
                        expect(stats.nonManifoldEdges).toBe(0);
                    } finally {
                        geo.dispose();
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('tồn tại mặt + tường cạnh (position không rỗng) và bề dày khớp clampThickness', () => {
        fc.assert(
            fc.property(
                panelArb,
                // Gồm cả giá trị ngoài miền để kiểm clamp (≤0/NaN/>50).
                fc.oneof(
                    fc.double({ min: 0.1, max: MAX_THICKNESS_MM, noNaN: true }),
                    fc.double({ min: -10, max: 0, noNaN: true }),
                    fc.double({ min: MAX_THICKNESS_MM, max: 500, noNaN: true }),
                    fc.constant(NaN),
                ),
                (panel, thickness) => {
                    const geo = buildPanelSolid(panel, thickness);
                    try {
                        const pos = geo.getAttribute('position') as THREE.BufferAttribute;
                        expect(pos).toBeDefined();
                        expect(pos.count).toBeGreaterThan(0);

                        geo.computeBoundingBox();
                        const bb = geo.boundingBox!;
                        const zExtent = bb.max.z - bb.min.z;
                        const expected = clampThickness(
                            Number.isNaN(thickness) ? NaN : thickness,
                        );
                        expect(Math.abs(zExtent - expected)).toBeLessThanOrEqual(0.01);
                    } finally {
                        geo.dispose();
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
