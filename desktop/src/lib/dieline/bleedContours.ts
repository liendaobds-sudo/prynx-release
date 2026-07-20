import { featureCollection, polygon } from '@turf/helpers';
import union from '@turf/union';
import ClipperLib from 'clipper-lib';
import type { DielineModel, Panel, PathSegment, Point2D } from './types';
import { extractOuterSilhouette } from './contourValidator';
import { offsetPolygon } from './nestingEngine';
import { ptEq, segEndpoints } from './sharedGeometry';
import { tracePerimeter } from './tracePerimeter';

export const DEFAULT_DIELINE_BLEED_MM = 3;

function signedArea(points: readonly Point2D[]): number {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
}

function pointInPolygon(point: Point2D, polygon: readonly Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i];
        const b = polygon[j];
        const crosses = (a.y > point.y) !== (b.y > point.y)
            && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function connectedCutGroups(paths: readonly PathSegment[]): PathSegment[][] {
    const cuts = paths.filter((path) => path.tag === 'CUT');
    const parent = cuts.map((_, index) => index);
    const find = (index: number): number => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const unite = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    const endpoints = cuts.map(segEndpoints);
    for (let i = 0; i < cuts.length; i += 1) {
        for (let j = i + 1; j < cuts.length; j += 1) {
            const [a0, a1] = endpoints[i];
            const [b0, b1] = endpoints[j];
            if (ptEq(a0, b0) || ptEq(a0, b1) || ptEq(a1, b0) || ptEq(a1, b1)) {
                unite(i, j);
            }
        }
    }

    const grouped = new Map<number, PathSegment[]>();
    cuts.forEach((path, index) => {
        const root = find(index);
        const group = grouped.get(root);
        if (group) group.push(path);
        else grouped.set(root, [path]);
    });
    return [...grouped.values()];
}

/** Lấy biên ngoài của hợp các panel vật liệu; các cạnh gấp chung tự bị loại khỏi phép hợp. */
function exteriorRings(
    geometry: ReturnType<typeof polygon>['geometry'] | NonNullable<ReturnType<typeof union>>['geometry'],
): Point2D[][] {
    const coordinates = geometry.type === 'Polygon'
        ? [geometry.coordinates[0]]
        : geometry.coordinates.map((polygonCoordinates) => polygonCoordinates[0]);
    return coordinates
        .map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x, y })))
        .filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > 0.001);
}

function featureFromRing(raw: readonly Point2D[]) {
    const ring = raw.map((point) => [point.x, point.y]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    return polygon([ring]);
}

function sampleSegment(segment: PathSegment): Point2D[] {
    if (segment.type === 'bezier' && segment.controlPoints) {
        const [p0, cp1, cp2, p3] = segment.controlPoints;
        const controlLength = Math.hypot(cp1.x - p0.x, cp1.y - p0.y)
            + Math.hypot(cp2.x - cp1.x, cp2.y - cp1.y)
            + Math.hypot(p3.x - cp2.x, p3.y - cp2.y);
        const steps = Math.max(16, Math.min(96, Math.ceil(controlLength / 1.5)));
        const sampled: Point2D[] = [];
        for (let index = 0; index <= steps; index += 1) {
            const t = index / steps;
            const it = 1 - t;
            sampled.push({
                x: it ** 3 * p0.x + 3 * it ** 2 * t * cp1.x + 3 * it * t ** 2 * cp2.x + t ** 3 * p3.x,
                y: it ** 3 * p0.y + 3 * it ** 2 * t * cp1.y + 3 * it * t ** 2 * cp2.y + t ** 3 * p3.y,
            });
        }
        return sampled;
    }
    return segment.points.map((point) => ({ ...point }));
}

/** Preserve CUT curves while retaining virtual CREASE edges from Panel.outline. */
function detailedPanelRing(panel: Panel): Point2D[] {
    const outline = panel.outline && panel.outline.length >= 3
        ? panel.outline
        : tracePerimeter(panel.paths);
    if (outline.length < 3) return [];

    const ring: Point2D[] = [];
    for (let index = 0; index < outline.length; index += 1) {
        const a = outline[index];
        const b = outline[(index + 1) % outline.length];
        const matching = panel.paths.find((segment) => {
            const [start, end] = segEndpoints(segment);
            return (ptEq(start, a) && ptEq(end, b)) || (ptEq(start, b) && ptEq(end, a));
        });
        let edge = matching ? sampleSegment(matching) : [{ ...a }, { ...b }];
        if (matching) {
            const [start] = segEndpoints(matching);
            if (!ptEq(start, a)) edge = edge.reverse();
        }
        if (ring.length === 0) ring.push(edge[0]);
        for (const point of edge.slice(1)) {
            if (!ptEq(ring[ring.length - 1], point)) ring.push(point);
        }
    }
    if (ring.length > 1 && ptEq(ring[0], ring[ring.length - 1])) ring.pop();
    return ring;
}
function panelUnionOuterRings(model: DielineModel): Point2D[][] {
    const features = model.panels.flatMap((panel) => {
        const raw = detailedPanelRing(panel);

        if (raw.length < 3 || Math.abs(signedArea(raw)) <= 0.001) return [];
        try {
            return [featureFromRing(raw)];
        } catch {
            return [];
        }
    });
    if (features.length === 0) return [];

    try {
        const geometry = features.length === 1
            ? features[0].geometry
            : union(featureCollection(features))?.geometry;
        return geometry ? exteriorRings(geometry) : [];
    } catch {
        return [];
    }
}

/**
 * Build one virtual material region before taking its exterior bleed boundary.
 * Edge strips and round vertex caps form an exact no-stretch buffer without
 * offsetting or reconnecting individual CUT segments.
 */
type ClipperPoint = { X: number; Y: number };
const CLIPPER_SCALE = 1000;

function bufferMaterialRings(rings: readonly Point2D[][], offset: number): Point2D[][] {
    if (!(offset > 0)) return rings.map((ring) => ring.map((point) => ({ ...point })));
    const paths: ClipperPoint[][] = rings
        .filter((ring) => ring.length >= 3)
        .map((ring) => ring.map((point) => ({
            X: Math.round(point.x * CLIPPER_SCALE),
            Y: Math.round(point.y * CLIPPER_SCALE),
        })));
    if (paths.length === 0) return [];

    // Clipper requires identical orientation for exterior rings. ClipperOffset
    // handles concave corners, overlap union and self-intersection internally.
    for (const path of paths) {
        if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
    }
    const cleaned = ClipperLib.Clipper.CleanPolygons(paths, 0.002 * CLIPPER_SCALE) as ClipperPoint[][];
    const solution: ClipperPoint[][] = [];
    const offsetter = new ClipperLib.ClipperOffset(2, 0.05 * CLIPPER_SCALE);
    offsetter.AddPaths(cleaned, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    offsetter.Execute(solution, offset * CLIPPER_SCALE);

    return solution
        .map((path) => path.map((point) => ({
            x: point.X / CLIPPER_SCALE,
            y: point.Y / CLIPPER_SCALE,
        })))
        .filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > 0.001);
}
/**
 * Tạo đường bleed offset thật theo biên vật liệu ngoài cùng của khuôn.
 * Ưu tiên hợp hình học các panel để loại toàn bộ cạnh gấp/nội bộ. CUT chỉ là nguồn
 * dự phòng cho model nhập cũ không có panel. Không bao giờ giả mạo bằng bounding box.
 */
export function computeBleedContours(
    model: DielineModel,
    bleedMm: number = DEFAULT_DIELINE_BLEED_MM,
): Point2D[][] {
    const offset = Number.isFinite(bleedMm) ? Math.max(0, bleedMm) : DEFAULT_DIELINE_BLEED_MM;
    const panelRings = panelUnionOuterRings(model);
    if (panelRings.length > 0) {
        return bufferMaterialRings(panelRings, offset);
    }

    const candidates = connectedCutGroups(model.allPaths)
        .map((group) => extractOuterSilhouette(group))
        .filter((silhouette): silhouette is NonNullable<typeof silhouette> =>
            !!silhouette && silhouette.closed && silhouette.vertices.length >= 3 && silhouette.area > 0.001,
        )
        .map((silhouette) => ({
            vertices: silhouette.vertices,
            area: Math.abs(signedArea(silhouette.vertices)),
        }));

    return candidates
        .filter((candidate, index) => !candidates.some((other, otherIndex) =>
            index !== otherIndex
            && other.area > candidate.area
            && candidate.vertices.every((point) => pointInPolygon(point, other.vertices)),
        ))
        .map(({ vertices }) => offsetPolygon(vertices, offset))
        .filter((vertices) => vertices.length >= 3);
}
/**
 * Trả về bản sao model có các contour bleed vector khép kín trong `allPaths`.
 * Giữ nguyên boundingBox để không làm lệch tọa độ bình khuôn đã được solver tính;
 * các trang khuôn đơn đã có margin lớn hơn bleed mặc định.
 */
export function withBleedPaths(
    model: DielineModel,
    bleedMm: number = DEFAULT_DIELINE_BLEED_MM,
): DielineModel {
    const sourcePaths = model.allPaths.filter((path) => path.tag !== 'BLEED');
    const bleedPaths: PathSegment[] = computeBleedContours(
        { ...model, allPaths: sourcePaths },
        bleedMm,
    ).flatMap((ring) => ring.map((point, index) => ({
        type: 'line' as const,
        tag: 'BLEED' as const,
        points: [point, ring[(index + 1) % ring.length]],
    })));
    return { ...model, allPaths: [...sourcePaths, ...bleedPaths] };
}