import { PlacedDieline } from './nestingTypes';
import { Point2D } from './types';
import { DIELINE_LIMITS } from './runtimeValidation';
import { mapPointToPlacement } from './placementTransform';

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function boundsOf(points: Point2D[]): Bounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
}

export function transformOutlineForPlacement(outline: Point2D[], pos: PlacedDieline): Point2D[] {
    const bounds = boundsOf(outline);
    return outline.map((point) => mapPointToPlacement(point, pos, {
        ...bounds,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
    }));
}

function pointSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (length2 <= 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
    const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
    return (Math.abs(o1) < 1e-8 || Math.abs(o2) < 1e-8 || o1 * o2 < 0)
        && (Math.abs(o3) < 1e-8 || Math.abs(o4) < 1e-8 || o3 * o4 < 0)
        && Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + 1e-8
        && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + 1e-8;
}

function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function polygonsTooClose(a: Point2D[], b: Point2D[], gap: number): boolean {
    if (a.length < 3 || b.length < 3) return true;
    if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
    let minDistance = Infinity;
    for (let ai = 0; ai < a.length; ai++) {
        const a1 = a[ai], a2 = a[(ai + 1) % a.length];
        for (let bi = 0; bi < b.length; bi++) {
            const b1 = b[bi], b2 = b[(bi + 1) % b.length];
            if (segmentsIntersect(a1, a2, b1, b2)) return true;
            minDistance = Math.min(minDistance,
                pointSegmentDistance(a1, b1, b2), pointSegmentDistance(a2, b1, b2),
                pointSegmentDistance(b1, a1, a2), pointSegmentDistance(b2, a1, a2));
            if (minDistance < gap - 0.01) return true;
        }
    }
    return minDistance < gap - 0.01;
}

/** Validate heuristic output against the true CUT contour using a spatial index. */
export function validatePlacementPositions(
    candidates: PlacedDieline[],
    outline: Point2D[],
    gap: number,
    printable: { left: number; top: number; right: number; bottom: number },
): { positions: PlacedDieline[]; removed: number } {
    const accepted: { pos: PlacedDieline; polygon: Point2D[]; bounds: Bounds }[] = [];
    const buckets = new Map<string, number[]>();
    const outlineBounds = boundsOf(outline);
    const cell = Math.max(1, Math.max(outlineBounds.maxX - outlineBounds.minX, outlineBounds.maxY - outlineBounds.minY) + gap);
    const keysFor = (bounds: Bounds): string[] => {
        const keys: string[] = [];
        const x0 = Math.floor((bounds.minX - gap) / cell), x1 = Math.floor((bounds.maxX + gap) / cell);
        const y0 = Math.floor((bounds.minY - gap) / cell), y1 = Math.floor((bounds.maxY + gap) / cell);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
        return keys;
    };

    for (const pos of candidates.slice(0, DIELINE_LIMITS.maxPlacements)) {
        const polygon = transformOutlineForPlacement(outline, pos);
        const bounds = boundsOf(polygon);
        if (bounds.minX < printable.left - 0.01 || bounds.minY < printable.top - 0.01
            || bounds.maxX > printable.right + 0.01 || bounds.maxY > printable.bottom + 0.01) continue;
        const keys = keysFor(bounds);
        const neighbors = new Set<number>();
        for (const key of keys) for (const index of buckets.get(key) || []) neighbors.add(index);
        let safe = true;
        for (const index of neighbors) {
            const other = accepted[index];
            if (bounds.maxX + gap < other.bounds.minX || other.bounds.maxX + gap < bounds.minX
                || bounds.maxY + gap < other.bounds.minY || other.bounds.maxY + gap < bounds.minY) continue;
            if (polygonsTooClose(polygon, other.polygon, gap)) { safe = false; break; }
        }
        if (!safe) continue;
        const index = accepted.length;
        accepted.push({ pos, polygon, bounds });
        for (const key of keys) {
            const entries = buckets.get(key) || [];
            entries.push(index);
            buckets.set(key, entries);
        }
    }
    return { positions: accepted.map((entry) => entry.pos), removed: candidates.length - accepted.length };
}
