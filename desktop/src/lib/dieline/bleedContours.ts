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

/**
 * Chuỗi free-edge CUT của panel (bỏ CREASE). Chuỗi hở hai đầu trên đường
 * gấp → coi last→first là cạnh ảo dọc nếp gấp, tạo vùng giấy kín.
 * Đây là nguồn CHÍNH cho bleed: bám đúng đường khuôn vẽ, không phụ thuộc
 * `panel.outline` rút gọn / lỗi thời.
 */
function cutFreeEdgeRing(paths: readonly PathSegment[]): Point2D[] {
    const cuts = paths.filter((path) => path.tag === 'CUT');
    if (cuts.length === 0) return [];

    const ring: Point2D[] = [];
    const push = (point: Point2D) => {
        if (ring.length === 0) {
            ring.push({ x: point.x, y: point.y });
            return;
        }
        const last = ring[ring.length - 1];
        if (!ptEq(last, point)) ring.push({ x: point.x, y: point.y });
    };

    for (const segment of cuts) {
        for (const point of sampleSegment(segment)) push(point);
    }

    if (ring.length > 2 && ptEq(ring[0], ring[ring.length - 1])) ring.pop();
    return ring.length >= 3 ? ring : [];
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

/**
 * Vùng vật liệu của 1 panel cho bleed:
 * - Flap/đáy (nhiều CUT free-edge): dùng cutFreeEdgeRing → bám khuôn.
 * - Thân hộp (outline chữ nhật, CUT chỉ vài cạnh): giữ outline/detailed
 *   vì free-edge CUT không đủ chu vi.
 */
function materialRingForPanel(panel: Panel): Point2D[] {
    const cutRing = cutFreeEdgeRing(panel.paths);
    const cutArea = cutRing.length >= 3 ? Math.abs(signedArea(cutRing)) : 0;

    if (cutArea > 0.001) {
        const outline = panel.outline && panel.outline.length >= 3 ? panel.outline : null;
        if (outline) {
            const outlineArea = Math.abs(signedArea(outline));
            // CUT chỉ là vài cạnh thân → diện tích chuỗi free-edge << outline
            if (outlineArea > cutArea * 1.5) {
                return detailedPanelRing(panel);
            }
        }
        // Flap đáy / tai: free-edge CUT đủ để tạo vùng giấy
        return cutRing;
    }

    return detailedPanelRing(panel);
}

function panelUnionOuterRings(model: DielineModel): Point2D[][] {
    const features = model.panels.flatMap((panel) => {
        const raw = materialRingForPanel(panel);

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
 * Lấy contour CUT ngoài khép kín trực tiếp, giữ nguyên các cung Bezier đã sample.
 * Chỉ dùng khi generator cam kết có một contour CUT ngoài hoàn chỉnh; các CUT hở
 * nội bộ sẽ bị loại bởi phép chọn silhouette ngoài cùng.
 */
function closedCutOuterRings(model: DielineModel): Point2D[][] {
    const candidates = connectedCutGroups(model.allPaths)
        .map((group) => extractOuterSilhouette(group))
        .filter((silhouette): silhouette is NonNullable<typeof silhouette> =>
            !!silhouette && silhouette.closed && silhouette.vertices.length >= 3 && silhouette.area > 0.001,
        )
        .map((silhouette) => {
            const vertices = ptEq(
                silhouette.vertices[0],
                silhouette.vertices[silhouette.vertices.length - 1],
            )
                ? silhouette.vertices.slice(0, -1)
                : silhouette.vertices;
            return { vertices, area: Math.abs(signedArea(vertices)) };
        });

    return candidates
        .filter((candidate, index) => !candidates.some((other, otherIndex) =>
            index !== otherIndex
            && other.area > candidate.area
            && candidate.vertices.every((point) => pointInPolygon(point, other.vertices)),
        ))
        .map(({ vertices }) => vertices);
}

/**
 * Build one virtual material region before taking its exterior bleed boundary.
 * Edge strips and round vertex caps form an exact no-stretch buffer without
 * offsetting or reconnecting individual CUT segments.
 */
type ClipperPoint = { X: number; Y: number };
const CLIPPER_SCALE = 1000;

/**
 * Phình vùng giấy ra ngoài (solid buffer) — cùng approach các loại hộp khác.
 *
 * Dùng `etClosedPolygon` + `jtRound`: biên bleed LUÔN nằm ngoài giấy, không
 * tự cắt âm vào đỉnh nhọn (như miter parallel-curve từng làm trên auto_bottom).
 * Khe hẹp hơn 2×bleed sẽ được lấp tự nhiên (đúng vật lý tràn lề in).
 *
 * Biên nguồn phải bám free-edge CUT (materialRingForPanel) thì đáy mới đúng form.
 */
function bufferMaterialRings(rings: readonly Point2D[][], offset: number): Point2D[][] {
    if (!(offset > 0)) return rings.map((ring) => ring.map((point) => ({ ...point })));
    const paths: ClipperPoint[][] = rings
        .filter((ring) => ring.length >= 3)
        .map((ring) => ring.map((point) => ({
            X: Math.round(point.x * CLIPPER_SCALE),
            Y: Math.round(point.y * CLIPPER_SCALE),
        })));
    if (paths.length === 0) return [];

    // Clipper: orientation thống nhất, làm sạch, rồi phình khối đặc ra ngoài
    for (const path of paths) {
        if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
    }
    const cleaned = ClipperLib.Clipper.CleanPolygons(paths, 0.002 * CLIPPER_SCALE) as ClipperPoint[][];
    const solution: ClipperPoint[][] = [];
    // jtRound: bo góc lồi, không tạo gai miter âm vào trong đỉnh nhọn
    const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * CLIPPER_SCALE);
    offsetter.AddPaths(cleaned, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    offsetter.Execute(solution, offset * CLIPPER_SCALE);

    const expanded = solution
        .map((path) => path.map((point) => ({
            x: point.X / CLIPPER_SCALE,
            y: point.Y / CLIPPER_SCALE,
        })))
        .filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > 0.001);

    if (expanded.length <= 1) return expanded;

    // Gộp cut-piece gần nhau (bleed chồng) thành một biên ngoài
    try {
        const features = expanded.flatMap((ring) => {
            try {
                return [featureFromRing(ring)];
            } catch {
                return [];
            }
        });
        if (features.length === 0) return expanded;
        const geometry = features.length === 1
            ? features[0].geometry
            : union(featureCollection(features))?.geometry;
        if (geometry) {
            const merged = exteriorRings(geometry);
            if (merged.length > 0) return merged;
        }
    } catch { /* keep separate */ }
    return expanded;
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

    // [FLIP-TOP-TUCK FIX 2026-08-03 §FTT.8] Mẫu này có một contour CUT ngoài
    // khép kín chứa nhiều cung khóa. Outline panel phục vụ 3D chỉ là đa giác giản
    // lược, nên nếu hợp panel trước thì BLEED sẽ đi tắt và không bám đường bế thật.
    if (model.params?.boxType === 'flip_top_tuck') {
        const cutRings = closedCutOuterRings(model);
        if (cutRings.length > 0) return bufferMaterialRings(cutRings, offset);
    }

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
