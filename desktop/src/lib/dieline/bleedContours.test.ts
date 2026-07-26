import { describe, expect, it } from 'vitest';
import { computeBleedContours, withBleedPaths } from './bleedContours';
import { DEFAULT_PARAMS, type DielineModel, type PathSegment, type Point2D } from './types';
import { generateDieline } from './engine';

function rectangle(x: number, y: number, width: number, height: number): PathSegment[] {
    const points: Point2D[] = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
    ];
    return points.map((point, index) => ({
        type: 'line' as const,
        tag: 'CUT' as const,
        points: [point, points[(index + 1) % points.length]],
    }));
}

function model(paths: PathSegment[]): DielineModel {
    return {
        name: 'test',
        standardCode: 'TEST',
        description: '',
        panels: [],
        allPaths: paths,
        boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 80, width: 100, height: 80 },
        params: {} as DielineModel['params'],
    };
}

function bounds(points: Point2D[]) {
    return {
        minX: Math.min(...points.map((p) => p.x)),
        minY: Math.min(...points.map((p) => p.y)),
        maxX: Math.max(...points.map((p) => p.x)),
        maxY: Math.max(...points.map((p) => p.y)),
    };
}

describe('computeBleedContours', () => {
    it('offset đúng 3 mm ra ngoài contour CUT', () => {
        const contours = computeBleedContours(model(rectangle(10, 20, 40, 30)), 3);
        expect(contours).toHaveLength(1);
        expect(bounds(contours[0])).toEqual({ minX: 7, minY: 17, maxX: 53, maxY: 53 });
    });

    it('không tạo bleed quanh lỗ cắt nằm trong khuôn', () => {
        const paths = [...rectangle(0, 0, 100, 80), ...rectangle(30, 20, 20, 20)];
        const contours = computeBleedContours(model(paths), 3);
        expect(contours).toHaveLength(1);
        expect(bounds(contours[0])).toEqual({ minX: -3, minY: -3, maxX: 103, maxY: 83 });
    });

    it('giữ bleed riêng cho nhiều Cut Piece rời nhau', () => {
        const paths = [...rectangle(0, 0, 20, 20), ...rectangle(40, 0, 20, 20)];
        const contours = computeBleedContours(model(paths), 2);
        expect(contours).toHaveLength(2);
        expect(contours.map(bounds)).toEqual([
            { minX: -2, minY: -2, maxX: 22, maxY: 22 },
            { minX: 38, minY: -2, maxX: 62, maxY: 22 },
        ]);
    });

    it('merges overlapping bleed regions into one virtual exterior boundary', () => {
        const first = rectangle(0, 0, 20, 20);
        const second = rectangle(24, 0, 20, 20);
        const m = model([...first, ...second]);
        m.panels = [
            {
                name: 'a', label: 'A', paths: first, outline: [
                    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
                ], parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
            },
            {
                name: 'b', label: 'B', paths: second, outline: [
                    { x: 24, y: 0 }, { x: 44, y: 0 }, { x: 44, y: 20 }, { x: 24, y: 20 },
                ], parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
            },
        ];
        expect(computeBleedContours(m, 3)).toHaveLength(1);
    });
    it('preserves a curved CUT instead of joining only its endpoints', () => {
        const curvedTop: PathSegment = {
            type: 'bezier', tag: 'CUT',
            points: [{ x: 100, y: 50 }, { x: 0, y: 50 }],
            controlPoints: [
                { x: 100, y: 50 }, { x: 75, y: 80 },
                { x: 25, y: 80 }, { x: 0, y: 50 },
            ],
        };
        const paths: PathSegment[] = [
            { type: 'line', tag: 'CUT', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
            { type: 'line', tag: 'CUT', points: [{ x: 100, y: 0 }, { x: 100, y: 50 }] },
            curvedTop,
            { type: 'line', tag: 'CUT', points: [{ x: 0, y: 50 }, { x: 0, y: 0 }] },
        ];
        const m = model(paths);
        m.panels = [{
            name: 'curved', label: 'Curved', paths,
            outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
            parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
        }];
        const contour = computeBleedContours(m, 3)[0];
        expect(contour.length).toBeGreaterThan(20);
        expect(Math.max(...contour.map((point) => point.y))).toBeGreaterThan(74);
    });
    it('tạo contour hữu hạn cho mọi loại khuôn hiện có', () => {
        const boxTypes = ['rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray'] as const;
        for (const boxType of boxTypes) {
            const generated = generateDieline({ ...DEFAULT_PARAMS, boxType });
            const contours = computeBleedContours(generated, 3);
            expect(contours.length, boxType).toBeGreaterThan(0);
            if (boxType === 'rte') expect(contours[0].length).toBeGreaterThan(4);
            expect(contours.every((ring) => ring.length >= 3), boxType).toBe(true);
            expect(contours.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), boxType).toBe(true);
        }
    });

    it('bleed không âm vào trong vùng giấy (đỉnh nhọn / khe lõm)', () => {
        const boxTypes = ['rte', 'slb', 'auto_bottom'] as const;
        for (const boxType of boxTypes) {
            const generated = generateDieline({
                ...DEFAULT_PARAMS, boxType, L: 120, W: 80, D: 180,
            });
            const material = computeBleedContours(generated, 0)[0];
            const bleed = computeBleedContours(generated, 3)[0];
            expect(material?.length, boxType).toBeGreaterThan(3);
            expect(bleed?.length, boxType).toBeGreaterThan(3);

            const inside = (pt: Point2D, poly: Point2D[]) => {
                let odd = false;
                for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
                    const a = poly[i];
                    const b = poly[j];
                    const hit = (a.y > pt.y) !== (b.y > pt.y)
                        && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
                    if (hit) odd = !odd;
                }
                return odd;
            };
            // Không đỉnh bleed nào nằm hẳn trong material (trừ biên số)
            const negative = bleed.filter((pt) => inside(pt, material));
            expect(negative.length, `${boxType} negative bleed verts`).toBe(0);
        }
    });

    it('auto_bottom: bleed bám free-edge CUT đáy (~3mm), không theo outline rút gọn', () => {
        const generated = generateDieline({ ...DEFAULT_PARAMS, boxType: 'auto_bottom', L: 120, W: 80, D: 180 });
        const bottomPanels = generated.panels.filter((panel) => panel.name.startsWith('bottom_'));
        expect(bottomPanels.length).toBe(4);
        // Outline đáy phải chi tiết (nhiều hơn tứ giác rút gọn)
        for (const panel of bottomPanels) {
            expect(panel.outline && panel.outline.length, panel.name).toBeGreaterThanOrEqual(4);
        }
        const deep = bottomPanels.find((panel) => panel.name === 'bottom_main_front');
        expect(deep?.outline && deep.outline.length).toBeGreaterThan(8);

        const bleed = computeBleedContours(generated, 3);
        expect(bleed.length).toBeGreaterThan(0);
        expect(bleed[0].length).toBeGreaterThan(20);

        const freeEdgePts = bottomPanels
            .flatMap((panel) => panel.paths.filter((seg) => seg.tag === 'CUT'))
            .flatMap((seg) => seg.points)
            .filter((pt) => pt.y < -1);
        expect(freeEdgePts.length).toBeGreaterThan(10);

        const ring = bleed[0];
        const dists = freeEdgePts.map((pt) => {
            let min = Infinity;
            for (let i = 0; i < ring.length; i += 1) {
                const a = ring[i];
                const b = ring[(i + 1) % ring.length];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const len2 = dx * dx + dy * dy || 1;
                let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2;
                t = Math.max(0, Math.min(1, t));
                const d = Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
                if (d < min) min = d;
            }
            return min;
        });
        const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
        expect(Math.min(...dists)).toBeGreaterThan(1.5);
        expect(avg).toBeGreaterThan(2);
        expect(avg).toBeLessThan(6);
    });
    it('adds closed BLEED vector paths without mutating source or changing placement bbox', () => {
        const source = model(rectangle(10, 20, 40, 30));
        const exported = withBleedPaths(source, 3);
        const bleed = exported.allPaths.filter((path) => path.tag === 'BLEED');
        expect(source.allPaths.some((path) => path.tag === 'BLEED')).toBe(false);
        expect(bleed.length).toBeGreaterThanOrEqual(4);
        expect(bleed.every((path) => path.type === 'line' && path.points.length === 2)).toBe(true);
        expect(exported.boundingBox).toEqual(source.boundingBox);
        expect(bounds(bleed.flatMap((path) => path.points))).toEqual({ minX: 7, minY: 17, maxX: 53, maxY: 53 });
    });
    it('không giả bleed bằng bounding box khi CUT bị hở', () => {
        const open: PathSegment[] = [{
            type: 'line', tag: 'CUT', points: [{ x: 10, y: 10 }, { x: 30, y: 10 }],
        }];
        expect(computeBleedContours(model(open), 3)).toEqual([]);
    });
});