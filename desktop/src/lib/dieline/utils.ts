// ============================================================
// Geometry Utilities — Tolerance Snapping, Chamfer, Fillet
// ============================================================
import { Point2D, PathSegment, PathTag } from './types';

/**
 * Snap số thực về N chữ số thập phân.
 * CRITICAL: Ngăn lỗi Floating Point (0.1 + 0.2 = 0.30000...004)
 * Mặc định 3 chữ số → sai số tối đa 0.001mm (chính xác hơn máy CNC)
 */
export function snap(n: number, decimals = 3): number {
    const factor = Math.pow(10, decimals);
    return Math.round(n * factor) / factor;
}

/** Tạo Point2D đã snap */
export function pt(x: number, y: number): Point2D {
    return { x: snap(x), y: snap(y) };
}

/** Tạo đoạn thẳng (line) từ 2 điểm */
export function line(p1: Point2D, p2: Point2D, tag: PathTag = 'CUT'): PathSegment {
    return {
        points: [p1, p2],
        tag,
        type: 'line',
    };
}

/** Tạo polyline (nhiều đoạn thẳng nối tiếp) */
export function polyline(points: Point2D[], tag: PathTag = 'CUT'): PathSegment[] {
    const segments: PathSegment[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        segments.push(line(points[i], points[i + 1], tag));
    }
    return segments;
}

/** Tạo hình chữ nhật từ góc trái dưới, trả về các cạnh riêng lẻ */
export function rect(
    x: number,
    y: number,
    w: number,
    h: number,
    tags: { top?: PathTag; right?: PathTag; bottom?: PathTag; left?: PathTag } = {}
): PathSegment[] {
    const bl = pt(x, y);
    const br = pt(x + w, y);
    const tr = pt(x + w, y + h);
    const tl = pt(x, y + h);
    return [
        line(bl, br, tags.bottom || 'CUT'),  // bottom
        line(br, tr, tags.right || 'CUT'),    // right
        line(tr, tl, tags.top || 'CUT'),      // top
        line(tl, bl, tags.left || 'CUT'),     // left
    ];
}

/**
 * Sinh cung tròn (arc) nội suy bằng N điểm.
 * @param cx, cy - Tâm cung
 * @param r - Bán kính
 * @param startAngle - Góc bắt đầu (radian)
 * @param endAngle - Góc kết thúc (radian)
 * @param segments - Số đoạn nội suy (nhiều hơn = mượt hơn)
 */
export function arc(
    cx: number,
    cy: number,
    r: number,
    startAngle: number,
    endAngle: number,
    tag: PathTag = 'CUT',
    segments = 16
): PathSegment {
    const points: Point2D[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const angle = startAngle + (endAngle - startAngle) * t;
        points.push(pt(cx + r * Math.cos(angle), cy + r * Math.sin(angle)));
    }
    return { points, tag, type: 'arc' };
}

/**
 * Tạo đoạn Cubic Bezier thực (không sampling).
 * Lưu 4 control points gốc → render bằng SVG `C` / DXF SPLINE.
 * points[] chứa [P0, P3] để tính bounding box nhanh.
 */
export function bezierSegment(
    p0: Point2D, cp1: Point2D, cp2: Point2D, p3: Point2D,
    tag: PathTag = 'CUT'
): PathSegment {
    return {
        points: [p0, cp1, cp2, p3], // Tất cả control points cho bounding box chính xác
        tag,
        type: 'bezier',
        controlPoints: [p0, cp1, cp2, p3],
    };
}

/**
 * Nội suy Cubic Bezier thành N đoạn thẳng (dùng cho export PDF/DXF fallback).
 * P(t) = (1-t)³·P0 + 3(1-t)²t·CP1 + 3(1-t)t²·CP2 + t³·P3
 */
export function sampleBezier(
    p0: Point2D, cp1: Point2D, cp2: Point2D, p3: Point2D,
    segments: number = 32
): Point2D[] {
    const points: Point2D[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const u = 1 - t;
        const x = u * u * u * p0.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * p3.x;
        const y = u * u * u * p0.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * p3.y;
        points.push(pt(x, y));
    }
    return points;
}

/**
 * Arc → Cubic Bezier: xấp xỉ cung tròn bằng Bezier.
 * Dùng công thức: controlLength = (4/3) * R * sin(α/2) / (1 + cos(α/2))
 * Handles dùng (-sin, cos) với sweep direction.
 *
 * Extracted từ PizzaBox.arcToBezier & CupSleeve.getArcPoints
 * để dùng chung cho tất cả generators.
 *
 * @param cx, cy - Tâm cung
 * @param radius - Bán kính
 * @param startDeg - Góc bắt đầu (độ)
 * @param endDeg - Góc kết thúc (độ)
 * @param tag - Loại nét (CUT/CREASE/BLEED)
 */
export function arcToBezier(
    cx: number, cy: number, radius: number,
    startDeg: number, endDeg: number, tag: PathTag = 'CUT',
): PathSegment {
    const startRad = startDeg * Math.PI / 180;
    const endRad = endDeg * Math.PI / 180;
    const sweep = endRad - startRad;

    const p0x = cx + radius * Math.cos(startRad);
    const p0y = cy + radius * Math.sin(startRad);
    const p3x = cx + radius * Math.cos(endRad);
    const p3y = cy + radius * Math.sin(endRad);

    const halfAngle = Math.abs(sweep) / 2;
    const cosH = Math.cos(halfAngle);
    const sinH = Math.sin(halfAngle);
    const cLen = (4 / 3) * radius * sinH / (1 + cosH);
    const dir = sweep > 0 ? 1 : -1;

    const cp1x = p0x - cLen * Math.sin(startRad) * dir;
    const cp1y = p0y + cLen * Math.cos(startRad) * dir;
    const cp2x = p3x + cLen * Math.sin(endRad) * dir;
    const cp2y = p3y - cLen * Math.cos(endRad) * dir;

    return bezierSegment(
        pt(snap(p0x), snap(p0y)),
        pt(snap(cp1x), snap(cp1y)),
        pt(snap(cp2x), snap(cp2y)),
        pt(snap(p3x), snap(p3y)),
        tag,
    );
}

/**
 * Chamfer (Vát góc): Thay thế góc nhọn bằng đường vát thẳng 45°.
 * Trả về 2 điểm thay thế cho điểm gốc.
 * @param corner - Điểm góc
 * @param prev - Điểm trước
 * @param next - Điểm sau
 * @param size - Kích thước vát (mm)
 */
export function chamferPoints(
    corner: Point2D,
    prev: Point2D,
    next: Point2D,
    size: number
): [Point2D, Point2D] {
    // Vector từ corner đến prev
    const dx1 = prev.x - corner.x;
    const dy1 = prev.y - corner.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

    // Vector từ corner đến next
    const dx2 = next.x - corner.x;
    const dy2 = next.y - corner.y;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

    // Điểm vát trên cạnh 1 và cạnh 2
    const p1 = pt(corner.x + (dx1 / len1) * size, corner.y + (dy1 / len1) * size);
    const p2 = pt(corner.x + (dx2 / len2) * size, corner.y + (dy2 / len2) * size);

    return [p1, p2];
}

/**
 * Fillet (Bo tròn góc): Thay thế góc nhọn bằng cung tròn.
 * @param corner - Điểm góc
 * @param prev - Điểm trước
 * @param next - Điểm sau
 * @param radius - Bán kính bo
 */
export function filletArc(
    corner: Point2D,
    prev: Point2D,
    next: Point2D,
    radius: number,
    tag: PathTag = 'CUT'
): PathSegment {
    // Hướng từ corner về prev và next
    const dx1 = prev.x - corner.x;
    const dy1 = prev.y - corner.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const ux1 = dx1 / len1;
    const uy1 = dy1 / len1;

    const dx2 = next.x - corner.x;
    const dy2 = next.y - corner.y;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const ux2 = dx2 / len2;
    const uy2 = dy2 / len2;

    // Điểm tiếp xúc
    const t1 = pt(corner.x + ux1 * radius, corner.y + uy1 * radius);
    const t2 = pt(corner.x + ux2 * radius, corner.y + uy2 * radius);

    // Tâm cung — dịch theo bisector
    const bx = ux1 + ux2;
    const by = uy1 + uy2;
    const blen = Math.sqrt(bx * bx + by * by);

    // Khoảng cách từ corner đến tâm cung
    const dotProd = Math.max(-1, Math.min(1, ux1 * ux2 + uy1 * uy2));
    const halfAngle = Math.acos(dotProd);

    // Guard: nếu 3 điểm gần thẳng hàng → không thể bo cung → trả về line
    if (halfAngle < 0.001 || Math.abs(halfAngle - Math.PI) < 0.001) {
        return { points: [prev, next], tag, type: 'line' };
    }

    const dist = radius / Math.sin(halfAngle / 2);

    const cx = corner.x + (bx / blen) * dist;
    const cy = corner.y + (by / blen) * dist;

    // Góc bắt đầu và kết thúc
    const startAngle = Math.atan2(t1.y - cy, t1.x - cx);
    let endAngle = Math.atan2(t2.y - cy, t2.x - cx);

    // Normalize: fillet luôn là cung NGẮN (< π).
    // Khi delta vượt ±π (VD: startAngle=170°, endAngle=-170°),
    // arc() sẽ đi vòng xa (~320°). Fix bằng cách ép delta về [-π, π].
    let delta = endAngle - startAngle;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    endAngle = startAngle + delta;

    return arc(cx, cy, radius, startAngle, endAngle, tag, 12);
}

/**
 * Fillet Bezier (Bo tròn góc bằng Cubic Bezier).
 * Trả về đường cong bezier thực — smooth hoàn hảo, tiếp tuyến với 2 cạnh.
 * Dùng công thức kappa: k = (4/3)·tan(θ/4)·r cho xấp xỉ cung tròn tối ưu.
 *
 * @param corner - Điểm góc
 * @param prev - Điểm trước (trên cạnh vào)
 * @param next - Điểm sau (trên cạnh ra)
 * @param radius - Bán kính bo
 * @returns PathSegment loại 'bezier' với controlPoints
 */
export function filletBezier(
    corner: Point2D,
    prev: Point2D,
    next: Point2D,
    radius: number,
    tag: PathTag = 'CUT'
): PathSegment {
    // Hướng từ corner về prev và next
    const dx1 = prev.x - corner.x;
    const dy1 = prev.y - corner.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const ux1 = dx1 / len1;
    const uy1 = dy1 / len1;

    const dx2 = next.x - corner.x;
    const dy2 = next.y - corner.y;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const ux2 = dx2 / len2;
    const uy2 = dy2 / len2;

    // Góc giữa 2 cạnh tại corner
    const dotProd = Math.max(-1, Math.min(1, ux1 * ux2 + uy1 * uy2));
    const alpha = Math.acos(dotProd); // góc giữa 2 vector

    // Guard: gần thẳng hàng → trả về line
    if (alpha < 0.001 || Math.abs(alpha - Math.PI) < 0.001) {
        return { points: [prev, next], tag, type: 'line' };
    }

    // Khoảng cách từ corner đến tangent point
    const halfTan = Math.tan(alpha / 2);
    const d = halfTan > 0 ? Math.min(radius / halfTan, len1 / 2, len2 / 2) : 0;

    if (d <= 0) {
        return { points: [prev, next], tag, type: 'line' };
    }

    // Tangent points (tiếp điểm trên 2 cạnh)
    const t1 = pt(snap(corner.x + ux1 * d), snap(corner.y + uy1 * d));
    const t2 = pt(snap(corner.x + ux2 * d), snap(corner.y + uy2 * d));

    // Kappa: chiều dài control point arm cho bezier xấp xỉ cung tròn
    const k = (4 / 3) * Math.tan(alpha / 4) * (halfTan > 0 ? d * halfTan : radius);

    // Control points: đẩy dọc theo hướng vào/ra corner
    // CP1: từ t1 đi về phía corner (ngược ux1)
    const cp1 = pt(snap(t1.x - k * ux1), snap(t1.y - k * uy1));
    // CP2: từ t2 đi về phía corner (ngược ux2)
    const cp2 = pt(snap(t2.x - k * ux2), snap(t2.y - k * uy2));

    return bezierSegment(t1, cp1, cp2, t2, tag);
}

/**
 * Tính bounding box từ danh sách PathSegment.
 */
export function computeBoundingBox(paths: PathSegment[]): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
} {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

    for (const seg of paths) {
        for (const p of seg.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }

    return {
        minX: snap(minX),
        minY: snap(minY),
        maxX: snap(maxX),
        maxY: snap(maxY),
        width: snap(maxX - minX),
        height: snap(maxY - minY),
    };
}

/**
 * Mirror (phản chiếu) một mảng paths qua trục X tại y = axisY
 */
export function mirrorY(paths: PathSegment[], axisY: number): PathSegment[] {
    return paths.map((seg) => ({
        ...seg,
        points: seg.points.map((p) => pt(p.x, 2 * axisY - p.y)),
        ...(seg.controlPoints ? {
            controlPoints: seg.controlPoints.map((p) => pt(p.x, 2 * axisY - p.y)) as [Point2D, Point2D, Point2D, Point2D]
        } : {}),
    }));
}

/**
 * Dịch chuyển (translate) tất cả paths
 */
export function translatePaths(paths: PathSegment[], dx: number, dy: number): PathSegment[] {
    return paths.map((seg) => ({
        ...seg,
        points: seg.points.map((p) => pt(p.x + dx, p.y + dy)),
        ...(seg.controlPoints ? {
            controlPoints: seg.controlPoints.map((p) => pt(p.x + dx, p.y + dy)) as [Point2D, Point2D, Point2D, Point2D]
        } : {}),
    }));
}
