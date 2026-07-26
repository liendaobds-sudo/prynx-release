import { describe, it, expect } from 'vitest';
import {
    polygonArea,
    signedArea,
    pointToSegmentDist,
    contourGap,
    polygonIntersectionArea,
    triangulate,
    expectedFlatArea,
} from './geometryHelpers';
import { arbBoxParams, GeneratorBoxType } from './arbitraries';
import { Point2D, PathSegment, DEFAULT_PARAMS, BoxParams } from './types';
import { validateParams } from './validateParams';
import fc from 'fast-check';

const P = (x: number, y: number): Point2D => ({ x, y });

// ─── polygonArea / signedArea ───────────────────────────────

describe('polygonArea', () => {
    it('computes area of a unit square', () => {
        const sq = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
        expect(polygonArea(sq)).toBeCloseTo(1, 9);
    });

    it('computes area of a 3x4 rectangle', () => {
        const rect = [P(0, 0), P(3, 0), P(3, 4), P(0, 4)];
        expect(polygonArea(rect)).toBeCloseTo(12, 9);
    });

    it('computes area of a right triangle', () => {
        const tri = [P(0, 0), P(4, 0), P(0, 3)];
        expect(polygonArea(tri)).toBeCloseTo(6, 9);
    });

    it('is orientation-independent (absolute value)', () => {
        const ccw = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)];
        const cw = [...ccw].reverse();
        expect(polygonArea(ccw)).toBeCloseTo(polygonArea(cw), 9);
    });

    it('ignores a duplicated closing point', () => {
        const closed = [P(0, 0), P(2, 0), P(2, 2), P(0, 2), P(0, 0)];
        expect(polygonArea(closed)).toBeCloseTo(4, 9);
    });

    it('returns 0 for degenerate (< 3 points)', () => {
        expect(polygonArea([P(0, 0), P(1, 1)])).toBe(0);
    });

    it('signedArea is positive for CCW, negative for CW', () => {
        const ccw = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
        expect(signedArea(ccw)).toBeGreaterThan(0);
        expect(signedArea([...ccw].reverse())).toBeLessThan(0);
    });
});

// ─── pointToSegmentDist ─────────────────────────────────────

describe('pointToSegmentDist', () => {
    it('measures perpendicular distance to segment interior', () => {
        expect(pointToSegmentDist(P(1, 2), P(0, 0), P(2, 0))).toBeCloseTo(2, 9);
    });

    it('clamps to endpoint a when projection is before the segment', () => {
        expect(pointToSegmentDist(P(-3, 0), P(0, 0), P(2, 0))).toBeCloseTo(3, 9);
    });

    it('clamps to endpoint b when projection is past the segment', () => {
        expect(pointToSegmentDist(P(5, 0), P(0, 0), P(2, 0))).toBeCloseTo(3, 9);
    });

    it('returns 0 when the point lies on the segment', () => {
        expect(pointToSegmentDist(P(1, 0), P(0, 0), P(2, 0))).toBeCloseTo(0, 9);
    });

    it('handles a degenerate segment (a == b)', () => {
        expect(pointToSegmentDist(P(3, 4), P(0, 0), P(0, 0))).toBeCloseTo(5, 9);
    });
});

// ─── contourGap (uses tracePerimeter) ───────────────────────

describe('contourGap', () => {
    it('is ~0 for a closed square contour', () => {
        const segs: PathSegment[] = [
            { points: [P(0, 0), P(10, 0)], tag: 'CUT', type: 'line' },
            { points: [P(10, 0), P(10, 10)], tag: 'CUT', type: 'line' },
            { points: [P(10, 10), P(0, 10)], tag: 'CUT', type: 'line' },
            { points: [P(0, 10), P(0, 0)], tag: 'CUT', type: 'line' },
        ];
        expect(contourGap(segs)).toBeLessThanOrEqual(0.001);
    });

    it('detects a gap when the contour does not close', () => {
        const gap = 5;
        const segs: PathSegment[] = [
            { points: [P(0, 0), P(10, 0)], tag: 'CUT', type: 'line' },
            { points: [P(10, 0), P(10, 10)], tag: 'CUT', type: 'line' },
            { points: [P(10, 10), P(0 + gap, 10)], tag: 'CUT', type: 'line' },
            // last vertex (gap,10) ... open back to start (0,0)
        ];
        expect(contourGap(segs)).toBeGreaterThan(0.001);
    });
});

// ─── polygonIntersectionArea ────────────────────────────────

describe('polygonIntersectionArea', () => {
    it('computes overlap of two overlapping squares', () => {
        const a = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)];
        const b = [P(1, 1), P(3, 1), P(3, 3), P(1, 3)];
        // overlap is unit square [1,2]x[1,2] = 1
        expect(polygonIntersectionArea(a, b)).toBeCloseTo(1, 6);
    });

    it('returns ~0 for edge-touching squares (no overlap)', () => {
        const a = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)];
        const b = [P(2, 0), P(4, 0), P(4, 2), P(2, 2)];
        expect(polygonIntersectionArea(a, b)).toBeLessThanOrEqual(0.01);
    });

    it('full overlap equals the smaller polygon area', () => {
        const big = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
        const small = [P(1, 1), P(2, 1), P(2, 2), P(1, 2)];
        expect(polygonIntersectionArea(big, small)).toBeCloseTo(1, 6);
    });

    it('handles a concave (L-shaped) polygon correctly', () => {
        // L-shape area = 3 (2x2 minus 1x1 corner)
        const lShape = [P(0, 0), P(2, 0), P(2, 1), P(1, 1), P(1, 2), P(0, 2)];
        expect(polygonArea(lShape)).toBeCloseTo(3, 9);
        // intersect with full covering square → equals L area
        const cover = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)];
        expect(polygonIntersectionArea(lShape, cover)).toBeCloseTo(3, 6);
    });

    it('returns 0 for disjoint polygons', () => {
        const a = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
        const b = [P(5, 5), P(6, 5), P(6, 6), P(5, 6)];
        expect(polygonIntersectionArea(a, b)).toBeCloseTo(0, 9);
    });
});

// ─── triangulate ────────────────────────────────────────────

describe('triangulate', () => {
    it('triangulates a square into triangles preserving total area', () => {
        const sq = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)];
        const tris = triangulate(sq);
        const total = tris.reduce((s, t) => s + polygonArea(t), 0);
        expect(total).toBeCloseTo(4, 9);
    });

    it('triangulates a concave polygon preserving total area', () => {
        const lShape = [P(0, 0), P(2, 0), P(2, 1), P(1, 1), P(1, 2), P(0, 2)];
        const tris = triangulate(lShape);
        const total = tris.reduce((s, t) => s + polygonArea(t), 0);
        expect(total).toBeCloseTo(3, 6);
    });
});

// ─── expectedFlatArea ───────────────────────────────────────

describe('expectedFlatArea', () => {
    const types: GeneratorBoxType[] = [
        'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
    ];

    it('returns a positive finite area for every box type', () => {
        for (const boxType of types) {
            const params = validateParams({ ...DEFAULT_PARAMS, boxType }).params;
            const area = expectedFlatArea(params);
            expect(Number.isFinite(area)).toBe(true);
            expect(area).toBeGreaterThan(0);
        }
    });

    it('scales monotonically with overall dimensions for box-style types', () => {
        const small = validateParams({ ...DEFAULT_PARAMS, boxType: 'rte', L: 50, W: 30, D: 80 }).params;
        const large = validateParams({ ...DEFAULT_PARAMS, boxType: 'rte', L: 200, W: 100, D: 300 }).params;
        expect(expectedFlatArea(large)).toBeGreaterThan(expectedFlatArea(small));
    });
});

// ─── arbBoxParams (fast-check generator) ────────────────────

describe('arbBoxParams', () => {
    const types: GeneratorBoxType[] = [
        'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
    ];

    for (const boxType of types) {
        it(`generates only valid (validateParams-stable) params for ${boxType}`, () => {
            fc.assert(
                fc.property(arbBoxParams(boxType), (params: BoxParams) => {
                    // boxType preserved
                    expect(params.boxType).toBe(boxType);
                    // Core dimensions within absolute limits (valid domain)
                    expect(params.L).toBeGreaterThanOrEqual(30);
                    expect(params.L).toBeLessThanOrEqual(600);
                    expect(params.W).toBeGreaterThanOrEqual(15);
                    expect(params.W).toBeLessThanOrEqual(400);
                    expect(params.T).toBeGreaterThanOrEqual(0.2);
                    expect(params.T).toBeLessThanOrEqual(3);
                    // W ≤ L for box types that enforce it
                    if (boxType !== 'pizza' && boxType !== 'tray') {
                        expect(params.W).toBeLessThanOrEqual(params.L);
                    }
                }),
                { numRuns: 60 },
            );
        });
    }
});
