// ============================================================
// Nesting Engine — Thuật toán bình bản lồng khuôn
//
// Grid mode:  Step & repeat đều (cellH = bboxH + gap)
// Smart mode: Lồng khuôn — giảm cellH per box type:
//   RTE:        KHÔNG xoay, xếp sát, cellH = bboxH - closureH - tuckH + gap
//   SLB:        Xoay 180° xen kẽ hàng, cellH = bboxH - closureH - tuckH + gap
//   Cup Sleeve: Xoay 180° xen kẽ CỘT, đầu nhỏ lồng khoảng trống đầu lớn
//   Gable:      Chỉ xếp lưới (không lồng được)
//
// Công thức: cellH = bboxH - (nắp + tai đút) + gap
//   nắp = closureH = W + T
//   tai đút = tuckH = TH
// ============================================================

import { NestingConfig, NestingResult, PlacedDieline, SuperTileInfo } from './nestingTypes';
import { BoxParams, DielineModel, Point2D } from './types';
import { snap } from './utils';
import { SNAP_TOLERANCE } from './sharedGeometry';
import { extractOuterSilhouette, OuterSilhouette } from './contourValidator';
import { validatePlacementPositions } from './nestingCollision';

interface BBox {
    width: number;
    height: number;
}

// ============================================================
// Polygon Offset (Workstream B) — Phép offset polygon thực
//
// Đẩy mỗi cạnh của outline ra ngoài theo pháp tuyến một lượng
// `offset = max(0, dieGap)` (Minkowski-style outward offset).
// Hàm thuần, xác định (snap theo quy ước snap của Nesting_Engine),
// chính xác cho đa giác lồi & hình chữ nhật; với outline lõm gây
// tự cắt → fail closed về phía bao phủ (bao trọn outline gốc).
//   Requirements: 5.2, 5.6, 5.7, 6.1, 6.4, 6.5, 6.6, 6.8
// ============================================================

/** Giới hạn miter (tỉ lệ) — góc 90° (rect) cho miter ratio ≈ 1.414 < 4 ⇒ không bị vát. */
const MITER_LIMIT = 4;
/** Ngưỡng coi hai cạnh là song song / diện tích suy biến. */
const PARALLEL_EPS = 1e-9;

/** Diện tích có dấu (shoelace) — dương/âm tùy hướng CW/CCW của hệ tọa độ. */
function polygonSignedArea(pts: Point2D[]): number {
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        acc += a.x * b.y - b.x * a.y;
    }
    return acc / 2;
}

/**
 * Làm sạch đa giác: bỏ điểm trùng liên tiếp (trong SNAP_TOLERANCE) và
 * điểm đóng vòng lặp trùng điểm đầu. KHÔNG biến đổi mảng đầu vào.
 */
function cleanPolygon(pts: Point2D[]): Point2D[] {
    const out: Point2D[] = [];
    for (const p of pts) {
        const prev = out[out.length - 1];
        if (prev && Math.abs(prev.x - p.x) < SNAP_TOLERANCE && Math.abs(prev.y - p.y) < SNAP_TOLERANCE) {
            continue;
        }
        out.push({ x: p.x, y: p.y });
    }
    // Bỏ điểm cuối nếu trùng điểm đầu (vòng đã đóng tường minh).
    while (out.length >= 2) {
        const first = out[0];
        const last = out[out.length - 1];
        if (Math.abs(first.x - last.x) < SNAP_TOLERANCE && Math.abs(first.y - last.y) < SNAP_TOLERANCE) {
            out.pop();
        } else {
            break;
        }
    }
    return out;
}

/** Giao điểm hai đường thẳng (điểm + hướng). Trả null nếu song song. */
function lineIntersect(
    p1: Point2D, d1: Point2D,
    p2: Point2D, d2: Point2D,
): Point2D | null {
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < PARALLEL_EPS) return null;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const t = (dx * d2.y - dy * d2.x) / denom;
    return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/** Hai đoạn thẳng [a,b] và [c,d] có cắt nhau thực sự (giao trong lòng, không tính chạm đầu mút). */
function segmentsProperlyIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
    const cross = (o: Point2D, p: Point2D, q: Point2D) =>
        (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 > PARALLEL_EPS && d2 < -PARALLEL_EPS) || (d1 < -PARALLEL_EPS && d2 > PARALLEL_EPS))
        && ((d3 > PARALLEL_EPS && d4 < -PARALLEL_EPS) || (d3 < -PARALLEL_EPS && d4 > PARALLEL_EPS));
}

/** Đa giác có tự cắt (hai cạnh không kề cắt nhau trong lòng) hay không. */
function isSelfIntersecting(pts: Point2D[]): boolean {
    const n = pts.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        for (let j = i + 1; j < n; j++) {
            // Bỏ qua cạnh kề (chung đỉnh) và cạnh nối vòng.
            if (j === i) continue;
            if ((i + 1) % n === j) continue;
            if ((j + 1) % n === i) continue;
            const c = pts[j];
            const d = pts[(j + 1) % n];
            if (segmentsProperlyIntersect(a, b, c, d)) return true;
        }
    }
    return false;
}

/** Bao lồi (Andrew's monotone chain) — trả về theo thứ tự xác định, không lặp đỉnh cuối. */
function convexHull(pts: Point2D[]): Point2D[] {
    const sorted = [...pts].sort((p, q) => (p.x - q.x) || (p.y - q.y));
    if (sorted.length < 3) return sorted;
    const cross = (o: Point2D, a: Point2D, b: Point2D) =>
        (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Point2D[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }
    const upper: Point2D[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

/**
 * Miter offset: đẩy mỗi cạnh ra ngoài `offset` theo pháp tuyến ngoài, nối góc
 * bằng giao điểm cạnh đã dịch (miter); kẹp miter quá nhọn bằng cách vát (bevel).
 * `area` là diện tích có dấu của `pts` (để chọn hướng pháp tuyến ra ngoài).
 */
function miterOffset(pts: Point2D[], offset: number, area: number): Point2D[] {
    const n = pts.length;
    // Hướng pháp tuyến ngoài: với diện tích dương dùng (dy,-dx), âm thì đảo dấu.
    const s = area >= 0 ? 1 : -1;

    // Pháp tuyến ngoài đơn vị của cạnh i (từ pts[i] → pts[i+1]).
    const edgeNormal = (i: number): Point2D => {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: (s * dy) / len, y: (-s * dx) / len };
    };

    const out: Point2D[] = [];
    for (let i = 0; i < n; i++) {
        const prevEdge = (i - 1 + n) % n;          // cạnh tới đỉnh i
        const nextEdge = i;                         // cạnh rời đỉnh i
        const n1 = edgeNormal(prevEdge);
        const n2 = edgeNormal(nextEdge);
        const v = pts[i];

        const a = pts[prevEdge];
        const b = pts[i];
        const c = pts[(i + 1) % n];

        // Điểm trên hai cạnh đã dịch ra ngoài.
        const p1 = { x: b.x + offset * n1.x, y: b.y + offset * n1.y };
        const d1 = { x: b.x - a.x, y: b.y - a.y };
        const p2 = { x: b.x + offset * n2.x, y: b.y + offset * n2.y };
        const d2 = { x: c.x - b.x, y: c.y - b.y };

        const inter = lineIntersect(p1, d1, p2, d2);
        if (!inter) {
            // Hai cạnh song song (góc bẹt) → chỉ tịnh tiến đỉnh theo pháp tuyến.
            out.push({ x: v.x + offset * n1.x, y: v.y + offset * n1.y });
            continue;
        }

        const miterLen = Math.hypot(inter.x - v.x, inter.y - v.y);
        if (miterLen > offset * MITER_LIMIT) {
            // Kẹp miter: vát góc bằng hai điểm trên hai cạnh đã dịch.
            out.push({ x: b.x + offset * n1.x, y: b.y + offset * n1.y });
            out.push({ x: b.x + offset * n2.x, y: b.y + offset * n2.y });
        } else {
            out.push(inter);
        }
    }
    return out;
}

/**
 * Polygon_Offset — đẩy mỗi cạnh của `outline` ra ngoài theo pháp tuyến một
 * lượng `offset = max(0, offset)` (Minkowski-style outward offset). Hàm thuần.
 *
 *  - Kẹp âm: `offset < 0` → coi như 0, KHÔNG thu nhỏ outline (Req 5.7, 6.8).
 *  - Chuẩn hóa hướng bằng dấu shoelace để pháp tuyến hướng ra ngoài (Req 5.2).
 *  - Đẩy mỗi cạnh ra `offset`, nối góc lồi bằng giao điểm (miter có kẹp); với
 *    outline lõm gây tự cắt → tạo đa giác offset không tự cắt bao trọn outline
 *    gốc đã giãn `offset` (fail closed về phía bao phủ) (Req 5.6, 6.1).
 *  - Snap mọi tọa độ theo quy ước snap của Nesting_Engine để bit-identical
 *    (Req 6.3, 6.6); giữ đơn vị mm (Req 6.5).
 *  - Hình chữ nhật: mỗi cạnh ra đúng `offset`, mỗi chiều tăng `2×offset` (Req 6.4).
 */
export function offsetPolygon(outline: Point2D[], offset: number): Point2D[] {
    // Kẹp âm (Req 5.7, 6.8).
    const off = offset > 0 ? offset : 0;

    const clean = cleanPolygon(outline);

    // < 3 đỉnh phân biệt → không offset được; trả bản sao đã snap.
    if (clean.length < 3) {
        return clean.map(p => ({ x: snap(p.x), y: snap(p.y) }));
    }

    // offset = 0 → giữ nguyên outline (diện tích không đổi — Req 6.2); chỉ snap.
    if (off === 0) {
        return clean.map(p => ({ x: snap(p.x), y: snap(p.y) }));
    }

    const area = polygonSignedArea(clean);
    // Diện tích suy biến → không offset được.
    if (Math.abs(area) < PARALLEL_EPS) {
        return clean.map(p => ({ x: snap(p.x), y: snap(p.y) }));
    }

    // Miter offset (chính xác cho lồi & chữ nhật).
    let result = miterOffset(clean, off, area);

    // Bảo đảm offset ĐẨY RA NGOÀI (diện tích không giảm — Req 6.1, 6.2).
    // Nếu hướng pháp tuyến sai (do quy ước hệ tọa độ), đảo dấu rồi tính lại.
    if (Math.abs(polygonSignedArea(result)) + PARALLEL_EPS < Math.abs(area)) {
        result = miterOffset(clean, off, -area);
    }

    // Lõm gây tự cắt → fail closed: dùng miter offset của bao lồi (bao trọn,
    // không tự cắt) — ưu tiên bao phủ hơn tối ưu hình dạng (Req 5.6).
    if (isSelfIntersecting(result)) {
        const hull = convexHull(clean);
        result = miterOffset(hull, off, polygonSignedArea(hull));
    }

    // Snap xác định (Req 6.3, 6.6); đơn vị mm (Req 6.5).
    return result.map(p => ({ x: snap(p.x), y: snap(p.y) }));
}

// ============================================================
// Die_Outline (Workstream B) — Chọn nguồn biên ngoài của khuôn
//
// `computeDieOutline` tính đường biên ngoài thực (Die_Outline) của
// một khuôn làm đầu vào lồng khuôn: dùng Outer_Silhouette của khuôn
// khi "sẵn có", ngược lại / suy biến → đa giác chữ nhật suy ra từ
// `boundingBox`. Hàm thuần, chỉ-đọc model (Req 4.2).
//   Requirements: 5.1, 6.7
// ============================================================

/** Diện tích bao tối thiểu (mm²) để coi Outer_Silhouette không suy biến (Req 6.7). */
const DEGENERATE_AREA_EPS = 0.001;

/** Đếm số đỉnh phân biệt (gộp các điểm trùng trong SNAP_TOLERANCE). */
function countDistinctVertices(pts: Point2D[]): number {
    const distinct: Point2D[] = [];
    for (const p of pts) {
        const dup = distinct.some(
            (q) => Math.abs(q.x - p.x) <= SNAP_TOLERANCE && Math.abs(q.y - p.y) <= SNAP_TOLERANCE,
        );
        if (!dup) distinct.push(p);
    }
    return distinct.length;
}

/**
 * Outer_Silhouette "sẵn có" để dùng làm Die_Outline khi (Req 5.1, 6.7):
 *   - khép kín (gapMm ≤ SNAP_TOLERANCE),
 *   - ≥ 3 đỉnh phân biệt,
 *   - diện tích bao không suy biến (> 0,001 mm²).
 */
function isSilhouetteUsable(s: OuterSilhouette): boolean {
    return s.closed
        && s.area > DEGENERATE_AREA_EPS
        && countDistinctVertices(s.vertices) >= 3;
}

/**
 * Tính Die_Outline — đường biên ngoài thực của một khuôn dùng làm đầu vào
 * lồng khuôn. Hàm thuần, chỉ đọc model (KHÔNG mutate).
 *
 *  - Dùng Outer_Silhouette của khuôn khi "sẵn có" (≥ 3 đỉnh phân biệt, diện
 *    tích bao > 0,001 mm², khoảng hở đầu-cuối ≤ SNAP_TOLERANCE) — Req 5.1.
 *  - Ngược lại / suy biến (< 3 đỉnh phân biệt hoặc diện tích ≤ 0,001 mm²)
 *    → đa giác chữ nhật suy ra từ `bbox`: [(0,0),(w,0),(w,h),(0,h)] — Req 6.7.
 */
export function computeDieOutline(model: DielineModel | undefined, bbox: BBox): Point2D[] {
    const rect: Point2D[] = [
        { x: snap(0), y: snap(0) },
        { x: snap(bbox.width), y: snap(0) },
        { x: snap(bbox.width), y: snap(bbox.height) },
        { x: snap(0), y: snap(bbox.height) },
    ];

    if (!model || !Array.isArray(model.allPaths)) {
        return rect;
    }

    // Gom đoạn CUT/BLEED của khuôn (biên ngoài) — chỉ-đọc model.
    const cuts = model.allPaths.filter((p) => p.tag === 'CUT');
    const cutBleedSegs = cuts.length > 0
        ? cuts
        : model.allPaths.filter((p) => p.tag === 'BLEED');

    const silhouette = extractOuterSilhouette(cutBleedSegs);
    if (silhouette && isSilhouetteUsable(silhouette)) {
        return silhouette.vertices.map((p) => ({ x: snap(p.x), y: snap(p.y) }));
    }

    // Outer_Silhouette không sẵn có / suy biến → bbox-rect (Req 6.7).
    return rect;
}

// ============================================================
// Polygon Collision (Workstream B) — Va chạm theo polygon thay
// cho xấp xỉ Bounding_Box_Gap khi lồng khuôn (Req 5.3, 5.4, 5.5,
// 7.2, 7.3, 7.4, 7.5, 8.5).
//
// Quy trình: tính `outline` của khuôn MỘT lần (computeDieOutline),
// rồi với mỗi góc xoay thuộc {0°,90°,180°,270°} XOAY outline TRƯỚC,
// `offsetPolygon(rotated, dieGap)` SAU (cùng `offset = dieGap`) để
// được vùng keep-out. Khoảng hở giữa hai khuôn được suy ra trực tiếp
// từ va chạm keep-out↔outline-gốc: bước lưới tối thiểu sao cho keep-out
// của khuôn này CHỈ vừa chạm outline gốc khuôn kia (diện tích giao ≤ 0).
//
// Với Die_Outline là HÌNH CHỮ NHẬT, bước này đúng bằng `cạnh + dieGap`
// nên trùng khít hành vi Bounding_Box_Gap của Giai đoạn 1 (Req 8.1).
// `calculateNesting` không nhận `model` nên outline luôn là chữ nhật
// suy từ bbox — va chạm polygon trùng Bounding_Box_Gap, bảo toàn mọi
// kết quả lồng khuôn chữ nhật trong dung sai đã ghim.
// ============================================================

/** Tập góc xoay được hỗ trợ (Req 7.4, 7.5). */
const SUPPORTED_ANGLES = [0, 90, 180, 270] as const;

/**
 * Xoay outline quanh gốc tọa độ theo góc thuộc {0°,90°,180°,270°}.
 * Hàm thuần, snap xác định. Góc ngoài tập hỗ trợ được chuẩn hóa về 0°
 * (Req 7.5 — chỉ xét các góc thuộc tập được hỗ trợ).
 */
function rotateOutline(outline: Point2D[], angle: number): Point2D[] {
    const norm = (((angle % 360) + 360) % 360);
    const a = (SUPPORTED_ANGLES as readonly number[]).includes(norm) ? norm : 0;
    return outline.map((p) => {
        switch (a) {
            case 90: return { x: snap(-p.y), y: snap(p.x) };
            case 180: return { x: snap(-p.x), y: snap(-p.y) };
            case 270: return { x: snap(p.y), y: snap(-p.x) };
            default: return { x: snap(p.x), y: snap(p.y) };
        }
    });
}

/** Bao chữ nhật trục (AABB) của một dãy đỉnh. */
function outlineBounds(
    pts: Point2D[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Vùng keep-out của khuôn tại một góc xoay (Req 7.4, 7.5):
 * XOAY outline TRƯỚC rồi `offsetPolygon(rotated, gap)` SAU, cùng `offset = gap`.
 */
function computeKeepOut(outline: Point2D[], angle: number, gap: number): Point2D[] {
    return offsetPolygon(rotateOutline(outline, angle), gap);
}

/**
 * Bước lưới (cellW, cellH) suy từ va chạm polygon — thay cho xấp xỉ
 * `dieW + gap` / `dieH + gap` (Req 5.3, 5.4, 7.2). Bước theo trục là
 * khoảng dịch tối thiểu sao cho keep-out của khuôn này chỉ vừa chạm
 * outline gốc khuôn kia (diện tích giao ≤ 0): `bước = keepOut.max − orig.min`.
 *
 * Với Die_Outline chữ nhật → `dieW + gap` / `dieH + gap`, trùng khít
 * Bounding_Box_Gap Giai đoạn 1 (Req 8.1). Suy biến → fallback bbox-gap.
 */
function gridCellFromCollision(
    outline: Point2D[], angle: number, gap: number,
    dieW: number, dieH: number,
): { cellW: number; cellH: number } {
    const swap = angle === 90 || angle === 270;
    const footW = swap ? dieH : dieW;
    const footH = swap ? dieW : dieH;
    const fallback = { cellW: snap(footW + gap), cellH: snap(footH + gap) };

    const rotated = rotateOutline(outline, angle);
    const keepOut = computeKeepOut(outline, angle, gap);
    const ob = outlineBounds(rotated);
    const kb = outlineBounds(keepOut);
    if (!ob || !kb) return fallback;

    const cellW = snap(kb.maxX - ob.minX);
    const cellH = snap(kb.maxY - ob.minY);
    if (cellW <= 0 || cellH <= 0) return fallback;
    return { cellW, cellH };
}

type LayoutResult = {
    positions: PlacedDieline[];
    cols: number;
    rows: number;
    label: string;
    superTile: SuperTileInfo | null;
};

// ── Printable area ──────────────────────────────────────

function calcPrintableArea(
    sheetW: number, sheetH: number,
    margin: { top: number; right: number; bottom: number; left: number },
    gripperMargin: number,
): { areaW: number; areaH: number; offsetX: number; offsetY: number } {
    // Cắn nhíp nằm ở PHÍA DƯỚI tờ giấy (cạnh dẫn vào máy offset)
    const effectiveBottom = Math.max(margin.bottom, gripperMargin);
    return {
        areaW: sheetW - margin.left - margin.right,
        areaH: sheetH - margin.top - effectiveBottom,
        offsetX: margin.left,
        offsetY: margin.top,  // Dielines bắt đầu từ lề trên
    };
}

// ── Grid helpers ────────────────────────────────────────

function gridPositions(
    cols: number, rows: number,
    cellW: number, cellH: number,
    ox: number, oy: number,
    rotation: number,
): PlacedDieline[] {
    const positions: PlacedDieline[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            positions.push({
                x: ox + c * cellW,
                y: oy + r * cellH,
                rotation,
            });
        }
    }
    return positions;
}

// ── Grid layouts ────────────────────────────────────────

function calcGridNone(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    outline: Point2D[],
): LayoutResult {
    // Bước lưới suy từ va chạm polygon (keep-out↔outline-gốc) thay cho
    // xấp xỉ `dieW + gap`/`dieH + gap`. Chữ nhật → trùng Giai đoạn 1.
    const { cellW, cellH } = gridCellFromCollision(outline, 0, gap, dieW, dieH);
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW));
    const rows = Math.max(0, Math.floor((areaH + gap) / cellH));
    return {
        positions: gridPositions(cols, rows, cellW, cellH, ox, oy, 0),
        cols, rows, label: 'Grid 0°', superTile: null,
    };
}

function calcGrid90(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    outline: Point2D[],
): LayoutResult {
    // Chỉ trả về layout 90° — layout 0° đã có calcGridNone.
    // Keep-out tính SAU khi xoay outline 90° (Req 7.4); chữ nhật → dieH/dieW + gap.
    const { cellW: cellW90, cellH: cellH90 } = gridCellFromCollision(outline, 90, gap, dieW, dieH);
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW90));
    const rows = Math.max(0, Math.floor((areaH + gap) / cellH90));
    return {
        positions: gridPositions(cols, rows, cellW90, cellH90, ox, oy, 90),
        cols, rows, label: 'Grid 90°', superTile: null,
    };
}

// ── Smart: Lồng khuôn per box type ─────────────────────

/**
 * RTE: KHÔNG xoay. Tất cả hàng 0°.
 * cellH = bboxH - closureH - tuckH + gap
 *
 * Vì closure+tuck chỉ chiếm Front/Back panel (L-wide),
 * còn dust flap chỉ chiếm Side panel (W-wide),
 * nên các hàng có thể xếp sát mà không chạm nhau.
 */
function calcRTEInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    closureH: number, tuckH: number, dustH: number, D: number,
): LayoutResult {
    const cellW = dieW + gap;
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW));

    // Overlap lý tưởng = closureH + tuckH
    // Nhưng phải đảm bảo tai bụi 2 hàng kề không chạm:
    // cellH ≥ D + 2*dustH + gap → overlap ≤ bboxH - D - 2*dustH
    const maxOverlap = snap(Math.max(0, dieH - D - 2 * dustH));
    const overlapY = snap(Math.min(closureH + tuckH, maxOverlap));
    const cellH = Math.max(gap + 1, dieH - overlapY + gap);

    // Hàng đầu cần full bboxH, các hàng sau cần cellH
    const rows = cellH > 0
        ? Math.max(0, 1 + Math.floor(Math.max(0, areaH - dieH) / cellH))
        : 0;

    const positions: PlacedDieline[] = [];
    for (let r = 0; r < rows; r++) {
        const y = oy + r * cellH;
        // Kiểm tra hàng cuối không vượt quá area
        if (y + dieH > oy + areaH + 0.1) break;
        for (let c = 0; c < cols; c++) {
            positions.push({
                x: ox + c * cellW,
                y,
                rotation: 0, // KHÔNG xoay
            });
        }
    }

    const superTile: SuperTileInfo = {
        tileWidth: dieW,
        tileHeight: snap(cellH),
        countPerTile: 1,
        strategy: `Xen kẽ khoảng trống (−${Math.round(overlapY)}mm/hàng)`,
        savedMm: snap(overlapY),
    };

    return {
        positions, cols,
        rows: Math.ceil(positions.length / Math.max(1, cols)),
        label: `Xen kẽ khoảng trống (−${Math.round(overlapY)}mm/hàng)`,
        superTile: positions.length > 0 ? superTile : null,
    };
}

/**
 * SLB: Lồng theo CẶP — 2 hàng lồng nhau, giữa các cặp cách gap.
 *
 * Mỗi cặp gồm:
 *   - Hàng A: 0° (hướng gốc)
 *   - Hàng B: 180° tại tâm + dịch phải |L−W|
 * Trong cặp: overlap = closureH + tuckH − lockTabH − gap
 * Giữa cặp: khoảng cách = gap
 */
function calcSLBInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    closureH: number, tuckH: number, _dustH: number, _D: number,
    lockTabH: number,
    L: number, W: number, G: number,
): LayoutResult {
    const cellW = dieW + gap;
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW));

    // Overlap trong cặp: nắp gài + tai đút − lưỡi khoá − khoảng cách
    const overlapY = snap(Math.max(0, closureH + tuckH - lockTabH - gap));

    // Hàng xoay dịch phải = W + G (chiều rộng hộp + mí dán)
    const shiftX = W + G;
    const colsShifted = Math.max(0, Math.floor((areaW + gap - shiftX) / cellW));

    // Pair geometry
    const pairH = 2 * dieH - overlapY;       // Chiều cao 1 cặp (2 hàng lồng)
    const pairStep = pairH + gap;              // Bước giữa các cặp

    const positions: PlacedDieline[] = [];
    let pairIdx = 0;

    while (true) {
        const pairStart = oy + pairIdx * pairStep;

        // Hàng A (180° + dịch phải)
        const yA = pairStart;
        if (yA + dieH > oy + areaH + 0.1) break;
        for (let c = 0; c < colsShifted; c++) {
            positions.push({ x: ox + shiftX + c * cellW, y: yA, rotation: 180 });
        }

        // Hàng B (0°) — đối đầu với hàng A
        const yB = pairStart + dieH - overlapY;
        if (yB + dieH > oy + areaH + 0.1) {
            break;
        }
        for (let c = 0; c < cols; c++) {
            positions.push({ x: ox + c * cellW, y: yB, rotation: 0 });
        }

        pairIdx++;
    }

    const totalRows = Math.ceil(positions.length / Math.max(1, cols));

    const superTile: SuperTileInfo = {
        tileWidth: dieW,
        tileHeight: snap(pairH),
        countPerTile: 2,
        strategy: `Lồng cặp 180° (−${Math.round(overlapY)}mm, dịch ${shiftX}mm${lockTabH > 0 ? `, khoá ${lockTabH}mm` : ''})`,
        savedMm: snap(overlapY),
    };

    return {
        positions, cols,
        rows: totalRows,
        label: `Lồng cặp 180° (−${Math.round(overlapY)}mm${lockTabH > 0 ? `, khoá` : ''})`,
        superTile: positions.length > 0 ? superTile : null,
    };
}

/**
 * Cup Sleeve: Lồng khuôn hình quạt — tự động chọn hướng tối ưu.
 *
 * Thử 2 phương án:
 *   A) primary 0° (overlap slant) + fill 90° vào phần dư
 *   B) primary 90° (grid thường) + fill 0° vào phần dư
 * Chọn phương án cho nhiều khuôn nhất.
 *
 *   ┌──────────────┬──────┐
 *   │   primary    │ fill │  ← dải dư bên phải
 *   │  cols × rows │strip │
 *   │              │      │
 *   ├──────────────┘      │
 *   │  fill bottom strip  │  ← dải dư phía dưới
 *   └─────────────────────┘
 */

/** Helper: xếp 1 hướng chính + lấp phần dư bằng hướng còn lại.
 *  0°: overlap dọc (hàng) → pCellH = slant+gap, pCellW = dieW+gap
 *  90°: overlap ngang (cột) → pCellW = slant+gap, pCellH = dieW+gap
 */
function calcCupSleeveOneOrientation(
    pW: number, pH: number,
    fW: number, fH: number,
    pCellW: number, pCellH: number,  // primary spacing (W=ngang, H=dọc)
    fCellW: number, fCellH: number,  // fill spacing
    gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    pRot: number, fRot: number,
): { positions: PlacedDieline[]; primaryCount: number; bonusCount: number } {
    const cols = Math.max(0, Math.floor((areaW + gap) / pCellW));
    const rows = pCellH > 0
        ? Math.max(0, 1 + Math.floor(Math.max(0, areaH - pH) / pCellH))
        : 0;

    const positions: PlacedDieline[] = [];
    let actualRows = 0;

    for (let r = 0; r < rows; r++) {
        const y = oy + r * pCellH;
        if (y + pH > oy + areaH + 0.1) break;
        actualRows++;
        for (let c = 0; c < cols; c++) {
            positions.push({ x: ox + c * pCellW, y, rotation: pRot });
        }
    }

    const primaryCount = positions.length;
    let bonusCount = 0;

    const baseGridWidth = cols > 0 ? cols * pW + (cols - 1) * gap : 0;
    const baseGridHeight = actualRows > 0 ? (actualRows - 1) * pCellH + pH : 0;

    // ── A: Dải dư bên PHẢI ──
    const rightGapAvailable = areaW - baseGridWidth - gap;
    if (rightGapAvailable >= fW) {
        const rightStartX = ox + baseGridWidth + gap;
        const fColsR = Math.max(0, Math.floor((rightGapAvailable + gap) / fCellW));
        const fRowsR = Math.max(0, Math.floor((baseGridHeight + gap) / fCellH));

        for (let r = 0; r < fRowsR; r++) {
            for (let c = 0; c < fColsR; c++) {
                const xf = rightStartX + c * fCellW;
                const yf = oy + r * fCellH;
                if (xf + fW > ox + areaW + 0.1) break;
                if (yf + fH > oy + areaH + 0.1) break;
                positions.push({ x: xf, y: yf, rotation: fRot });
                bonusCount++;
            }
        }
    }

    // ── B: Dải dư phía DƯỚI ──
    const bottomGapAvailable = areaH - baseGridHeight - gap;
    if (bottomGapAvailable >= fH) {
        const bottomStartY = oy + baseGridHeight + gap;
        const fColsB = Math.max(0, Math.floor((baseGridWidth + gap) / fCellW));
        const fRowsB = Math.max(0, Math.floor((bottomGapAvailable + gap) / fCellH));

        for (let r = 0; r < fRowsB; r++) {
            for (let c = 0; c < fColsB; c++) {
                const xf = ox + c * fCellW;
                const yf = bottomStartY + r * fCellH;
                if (xf + fW > ox + baseGridWidth + 0.1) break;
                if (yf + fH > oy + areaH + 0.1) break;
                positions.push({ x: xf, y: yf, rotation: fRot });
                bonusCount++;
            }
        }
    }

    return { positions, primaryCount, bonusCount };
}

function calcCupSleeveInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    params: BoxParams,
): LayoutResult {
    const d1 = params.cupD1 / 10;
    const d2 = params.cupD2 / 10;
    const h = params.cupH / 10;
    const heightType = params.cupHeightType;

    const baseHalf = (d2 - d1) / 2;
    const slantH = heightType === 'slant' ? h : Math.sqrt(h * h + baseHalf * baseHalf);
    const slantMm = slantH * 10;

    // ── Phương án A: primary 0° + fill 90° ──
    // 0° primary: overlap dọc → pCellW = dieW+gap (bình thường), pCellH = slant+gap (smart)
    // 90° fill: overlap ngang → fCellW = slant+gap (smart), fCellH = dieW+gap (bình thường)
    const smartCell = snap(slantMm + gap);
    const a = calcCupSleeveOneOrientation(
        dieW, dieH, dieH, dieW,
        snap(dieW + gap), smartCell,  // pCellW, pCellH
        smartCell, snap(dieW + gap),  // fCellW, fCellH
        gap, areaW, areaH, ox, oy, 0, 90,
    );

    // ── Phương án B: primary 90° + fill 0° ──
    // 90° primary: overlap ngang → pCellW = slant+gap (smart), pCellH = dieW+gap (bình thường)
    // 0° fill: overlap dọc → fCellW = dieW+gap (bình thường), fCellH = slant+gap (smart)
    const b = calcCupSleeveOneOrientation(
        dieH, dieW, dieW, dieH,
        smartCell, snap(dieW + gap),  // pCellW, pCellH
        snap(dieW + gap), smartCell,  // fCellW, fCellH
        gap, areaW, areaH, ox, oy, 90, 0,
    );

    // Chọn phương án nhiều khuôn hơn
    const best = a.positions.length >= b.positions.length ? a : b;
    const isPlanA = best === a;
    const bonusCount = best.bonusCount;
    const totalCount = best.positions.length;
    const effectiveOverlap = isPlanA ? snap(Math.max(0, dieH + gap - smartCell)) : 0;

    const label = bonusCount > 0
        ? `Tối ưu (${totalCount} khuôn, +${bonusCount} xoay ${isPlanA ? '90' : '0'}°)`
        : isPlanA
            ? `Lồng cung (−${Math.round(effectiveOverlap)}mm/hàng)`
            : `Grid 90°`;

    const superTile: SuperTileInfo = {
        tileWidth: isPlanA ? dieW : dieH,
        tileHeight: snap(smartCell),
        countPerTile: bonusCount > 0 ? 2 : 1,
        strategy: label,
        savedMm: snap(effectiveOverlap),
    };

    return {
        positions: best.positions,
        cols: isPlanA
            ? Math.max(0, Math.floor((areaW + gap) / (dieW + gap)))
            : Math.max(0, Math.floor((areaW + gap) / (dieH + gap))),
        rows: Math.ceil(totalCount / Math.max(1, Math.floor((areaW + gap) / ((isPlanA ? dieW : dieH) + gap)))),
        label,
        superTile: totalCount > 0 ? superTile : null,
    };
}

/**
 * Pizza Box: Lồng 180° THEO CỘT — xoay xen kẽ, side wall lồng vào nhau.
 *
 * Pizza layout: body rộng L nằm giữa, 2 side wall mỗi bên rộng sideExt.
 * → dieW = L + 2*sideExt (sideExt ≈ 2D+T+1)
 *
 * Khi xoay 180°, side wall bên phải box A lồng vào side wall bên trái box B:
 *   Col 0 (0°):     [sideL | body L | sideR]
 *   Col 1 (180°):         [sideR' | body L | sideL']
 *                    ↑ overlap = sideExt
 *
 * Cột xoay dịch dọc (Y) = body height shift để tai bụi front/back lồng nhau.
 * Overlap ngang = sideExt (chiều rộng 1 cánh side wall)
 */
function calcPizzaInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    D: number,
): LayoutResult {
    // Tính side wall extension từ thông số hình học pizza
    // X_outer = 2D+T (đã snap ở PizzaBox.ts), X_tab = X_outer + T + 1
    // sideExt ≈ X_tab ≈ (2D + 2T + 1) — phần nhô ra mỗi bên so với body L
    // Thực tế: sideExt = (dieW - L) / 2, nhưng ta không có L ở đây.
    // Dùng estimate: sideExt ≈ dieW/2 − (dieW − 2*(2*D + 3)) / 2 = 2D+3
    // Đơn giản: overlapX = 2*D — khoảng lồng an toàn giữa side walls
    const overlapX = snap(Math.max(D, 5)); // = tai nắp depth

    // Chiều ngang mỗi cột
    const cellW = dieW + gap;                    // Bước cột bình thường (0°)
    const cellWShifted = cellW - overlapX;        // Bước cột lồng (180°)

    // Canh thẳng hàng — không dịch dọc
    const shiftY = 0;

    // Tính số cột: xen kẽ 0° và 180°
    // Mỗi cặp 2 cột: cellW + cellWShifted
    const pairW = cellW + cellWShifted;
    const maxPairs = pairW > 0 ? Math.floor((areaW + gap) / pairW) : 0;
    // Kiểm tra còn dư cho 1 cột nữa?
    const remainW = areaW + gap - maxPairs * pairW;
    const extraCol = remainW >= cellW ? 1 : 0;

    // Chiều dọc
    const cellH = dieH + gap;
    const rows = cellH > 0 ? Math.max(0, Math.floor((areaH + gap) / cellH)) : 0;
    const rowsShifted = cellH > 0
        ? Math.max(0, Math.floor((areaH + gap - shiftY) / cellH))
        : 0;

    const positions: PlacedDieline[] = [];

    // Xếp theo cặp cột
    for (let pair = 0; pair < maxPairs; pair++) {
        const baseX = pair * pairW;

        // Cột A (0°)
        for (let r = 0; r < rows; r++) {
            const y = oy + r * cellH;
            if (y + dieH > oy + areaH + 0.1) break;
            positions.push({ x: ox + baseX, y, rotation: 0 });
        }

        // Cột B (180°, dịch trái overlapX, dịch dọc shiftY)
        const xB = baseX + cellW - overlapX;
        for (let r = 0; r < rowsShifted; r++) {
            const y = oy + shiftY + r * cellH;
            if (y + dieH > oy + areaH + 0.1) break;
            positions.push({ x: ox + xB, y, rotation: 180 });
        }
    }

    // Cột dư cuối (nếu có) — 0°
    if (extraCol > 0) {
        const xExtra = maxPairs * pairW;
        for (let r = 0; r < rows; r++) {
            const y = oy + r * cellH;
            if (y + dieH > oy + areaH + 0.1) break;
            positions.push({ x: ox + xExtra, y, rotation: 0 });
        }
    }

    const totalCols = maxPairs * 2 + extraCol;
    const superTile: SuperTileInfo = {
        tileWidth: snap(pairW),
        tileHeight: dieH,
        countPerTile: 2,
        strategy: `Lồng pizza 180° (−${Math.round(overlapX)}mm/cột, side wall D=${D})`,
        savedMm: snap(overlapX),
    };

    return {
        positions,
        cols: totalCols,
        rows: Math.ceil(positions.length / Math.max(1, totalCols)),
        label: `Lồng pizza 180° (−${Math.round(overlapX)}mm/cột)`,
        superTile: positions.length > 0 ? superTile : null,
    };
}

// ── Envelope helpers (mirror auto-calc từ Envelope.ts) ──────
function envAutoFlapH(envH: number): number {
    return snap(Math.round(envH * 0.45));
}
function envAutoSideFlap(envH: number): number {
    return snap(Math.max(10, Math.min(15, envH * 0.12)));
}

/**
 * Envelope: Lồng khuôn bì thư — chiến lược phụ thuộc kiểu bì.
 *
 * ── Bì ngang (wallet) — lồng theo CỘT ──
 * Cột B (180°): dịch XUỐNG FH, dịch TRÁI (SF − gap)
 *   → overlapX = SF − gap (tai hông lồng vào nhau)
 *   → shiftY = FH (nắp dán lồng xuống)
 *
 * ── Bì dọc (pocket) — lồng theo HÀNG (3 hàng lặp lại) ──
 * Hàng 1 (0°): gốc
 * Hàng 2 (180°): dịch TRÁI ½SF, dịch LÊN (SF − gap)
 * Hàng 3 (0°): dịch LÊN hàng 2 thêm (FH − gap)
 */
function calcEnvelopeInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    params: BoxParams,
): LayoutResult {
    const isVertical = params.envStyle === 'pocket';

    // Tính FH, SF giống Envelope.ts
    const W = isVertical ? params.envH : params.envW;
    const H = isVertical ? params.envW : params.envH;
    const flapRef = isVertical ? W : H;
    const FH = params.envFH > 0
        ? snap(params.envFH)
        : (params.envFlapShape === 'straight' ? 30 : envAutoFlapH(flapRef));
    const SF = params.envSF > 0 ? snap(params.envSF) : envAutoSideFlap(flapRef);

    const positions: PlacedDieline[] = [];

    if (!isVertical) {
        // ═══════════════════════════════════════════════
        // BÌ NGANG (wallet) — lồng theo CỘT (đều)
        // ═══════════════════════════════════════════════
        // Mỗi cột kề nhau đều lồng (SF − gap), xoay xen kẽ 0°/180°.
        // Cột chẵn (0°): vị trí bình thường
        // Cột lẻ (180°): dịch xuống FH
        const overlapX = snap(Math.max(0, SF - gap));
        const shiftY = snap(FH);

        const colStep = dieW + gap - overlapX;       // bước đều giữa mọi cột kề
        const cellH = dieH + gap;

        // Tính tổng số cột vừa area
        // Cột đầu cần dieW, mỗi cột tiếp cần thêm colStep
        const totalCols = colStep > 0
            ? Math.max(0, 1 + Math.floor(Math.max(0, areaW - dieW) / colStep))
            : (dieW <= areaW ? 1 : 0);

        // Hàng cho cột 0° vs 180°
        const rowsNormal = cellH > 0 ? Math.max(0, Math.floor((areaH + gap) / cellH)) : 0;
        const rowsShifted = cellH > 0
            ? Math.max(0, Math.floor((areaH + gap - shiftY) / cellH))
            : 0;

        for (let col = 0; col < totalCols; col++) {
            const xCol = col * colStep;
            if (xCol + dieW > areaW + 0.1) break;

            const is180 = col % 2 === 1;  // cột lẻ xoay 180°
            const yShift = is180 ? shiftY : 0;
            const rows = is180 ? rowsShifted : rowsNormal;

            for (let r = 0; r < rows; r++) {
                const y = oy + yShift + r * cellH;
                if (y + dieH > oy + areaH + 0.1) break;
                positions.push({ x: ox + xCol, y, rotation: is180 ? 180 : 0 });
            }
        }

        const superTile: SuperTileInfo = {
            tileWidth: snap(colStep * 2),
            tileHeight: dieH,
            countPerTile: 2,
            strategy: `Lồng bì ngang 180° (−${Math.round(overlapX)}mm/cột, ↓${Math.round(shiftY)}mm)`,
            savedMm: snap(overlapX),
        };

        return {
            positions,
            cols: totalCols,
            rows: Math.ceil(positions.length / Math.max(1, totalCols)),
            label: `Lồng bì ngang (−${Math.round(overlapX)}mm/cột)`,
            superTile: positions.length > 0 ? superTile : null,
        };
    } else {
        // ═══════════════════════════════════════════════
        // BÌ DỌC (pocket) — lồng LIÊN TỤC xen kẽ 0°/180°
        // ═══════════════════════════════════════════════
        // Hàng chẵn (0°): vị trí bình thường
        // Hàng lẻ (180°): dịch trái 1.5×SF
        // Overlap xen kẽ:
        //   chẵn→lẻ: overlapA = SF − gap
        //   lẻ→chẵn: overlapB = FH − gap
        const overlapA = snap(Math.max(0, SF - gap));   // 0°→180°
        const overlapB = snap(Math.max(0, FH - gap));   // 180°→0°
        const shiftX = snap(SF * 1.5);                  // Hàng lẻ dịch trái

        // Bước 2 hàng liên tiếp (1 cặp chẵn+lẻ)
        const stepA = dieH - overlapA;   // khoảng cách hàng chẵn→lẻ
        const stepB = dieH - overlapB;   // khoảng cách hàng lẻ→chẵn tiếp
        const pairStep = stepA + stepB;  // chiều cao 1 cặp (dùng để lặp)

        const cellW = dieW + gap;
        const cols = Math.max(0, Math.floor((areaW + gap) / cellW));
        const colsShifted = Math.max(0, Math.floor((areaW + gap + shiftX) / cellW));

        let rowIdx = 0;
        let currentY = oy;
        while (true) {
            if (currentY + dieH > oy + areaH + 0.1) break;

            const is180 = rowIdx % 2 === 1;

            if (is180) {
                // Hàng lẻ: 180°, dịch trái shiftX
                for (let c = 0; c < colsShifted; c++) {
                    const xPos = ox - shiftX + c * cellW;
                    if (xPos + dieW > ox + areaW + shiftX + 0.1) break;
                    positions.push({ x: xPos, y: currentY, rotation: 180 });
                }
                currentY += stepB;  // tiến tới hàng chẵn tiếp theo
            } else {
                // Hàng chẵn: 0°, vị trí bình thường
                for (let c = 0; c < cols; c++) {
                    positions.push({ x: ox + c * cellW, y: currentY, rotation: 0 });
                }
                currentY += stepA;  // tiến tới hàng lẻ tiếp theo
            }

            rowIdx++;
        }

        const totalSaved = snap(overlapA + overlapB);
        const superTile: SuperTileInfo = {
            tileWidth: dieW,
            tileHeight: snap(pairStep),
            countPerTile: 2,
            strategy: `Lồng bì dọc liên tục (−${Math.round(overlapA)}+${Math.round(overlapB)}mm, ←${Math.round(shiftX)}mm)`,
            savedMm: totalSaved,
        };

        return {
            positions,
            cols,
            rows: Math.ceil(positions.length / Math.max(1, cols)),
            label: `Lồng bì dọc (−${Math.round(totalSaved)}mm/cặp)`,
            superTile: positions.length > 0 ? superTile : null,
        };
    }
}

/**
 * Smart nesting: chọn chiến lược theo boxType
 */
function calcSmart(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    params: BoxParams,
    outline: Point2D[],
): LayoutResult {
    // Tính closureH + tuckH + dustH
    const closureH = snap(params.W + params.T);
    const tuckH = snap(params.TH);
    const autoDustH = snap(Math.min(params.L / 2 - 1, params.W + params.T));
    const dustH = params.DFH > 0 ? snap(Math.min(params.DFH, params.L / 2 - 1)) : autoDustH;
    const safeDustH = snap(Math.min(dustH, params.L / 2));

    // Grid baselines làm fallback
    const gridFallback = () => {
        const r0 = calcGridNone(dieW, dieH, gap, areaW, areaH, ox, oy, outline);
        const r90 = calcGrid90(dieW, dieH, gap, areaW, areaH, ox, oy, outline);
        return r0.positions.length >= r90.positions.length ? r0 : r90;
    };

    // Bất biến: smart KHÔNG ĐƯỢC kém grid. Nếu grid xếp được nhiều khuôn hơn
    // interlock (với hình học cụ thể này), dùng grid. Hòa → ưu tiên interlock
    // (giữ nhãn chiến lược lồng để người dùng thấy đã thử lồng).
    const chooseBest = (interlock: LayoutResult): LayoutResult => {
        const grid = gridFallback();
        return interlock.positions.length >= grid.positions.length ? interlock : grid;
    };

    if (params.boxType === 'rte') {
        // RTE: luôn dùng interlock (không xoay, overlap closureH + tuckH)
        const interlock = calcRTEInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, closureH, tuckH, safeDustH, params.D);
        return chooseBest(interlock);
    }

    if (params.boxType === 'slb') {
        // SLB: luôn dùng 180° interlock (xoay đầu đuôi để lồng crash-lock)
        const lockTabH = params.lockTab ? (params.LTH || 0) : 0;
        const interlock = calcSLBInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, closureH, tuckH, safeDustH, params.D, lockTabH, params.L, params.W, params.G);
        return chooseBest(interlock);
    }

    if (params.boxType === 'cup_sleeve') {
        // Cup Sleeve: lồng quạt 180° xen kẽ cột
        const interlock = calcCupSleeveInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, params);
        return chooseBest(interlock);
    }

    if (params.boxType === 'pizza') {
        // Pizza: lồng dọc — tai bụi front lồng vào nắp phụ/fan tab
        const interlock = calcPizzaInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, params.D);
        return chooseBest(interlock);
    }

    if (params.boxType === 'envelope') {
        // Envelope: lồng bì thư (ngang = cột, dọc = 3 hàng)
        const interlock = calcEnvelopeInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, params);
        return chooseBest(interlock);
    }

    // Gable & Paper Bag: chỉ grid — không lồng được
    return gridFallback();
}

// ── Entry point ─────────────────────────────────────────

export function calculateNesting(
    bbox: BBox,
    config: NestingConfig,
    params?: BoxParams,
    model: DielineModel | undefined = undefined,
): NestingResult {
    const { sheet, margin, gripperMargin, dieGap, rotation, sheetOrientation, nestingMode, gutter } = config;
    const gap = nestingMode === 'smart' ? dieGap : Math.max(gutter, dieGap);

    let sheetW = sheet.width;
    let sheetH = sheet.height;
    if (sheetOrientation === 'portrait' && sheetW > sheetH) {
        [sheetW, sheetH] = [sheetH, sheetW];
    } else if (sheetOrientation === 'landscape' && sheetH > sheetW) {
        [sheetW, sheetH] = [sheetH, sheetW];
    }

    const dieW = bbox.width;
    const dieH = bbox.height;

    const rawOutline = computeDieOutline(model, { width: dieW, height: dieH });
    const outline = rawOutline.map((p) => ({ x: p.x - (model?.boundingBox.minX || 0), y: p.y - (model?.boundingBox.minY || 0) }));

    const calcForSheet = (sw: number, sh: number) => {
        const { areaW, areaH, offsetX, offsetY } = calcPrintableArea(sw, sh, margin, gripperMargin);

        let best: LayoutResult;

        if (nestingMode === 'smart' && params) {
            best = calcSmart(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, params, outline);
        } else {
            if (rotation === 'none') {
                best = calcGridNone(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, outline);
            } else if (rotation === '90') {
                best = calcGrid90(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, outline);
            } else {
                // auto: so sánh 0° vs 90°
                const r0 = calcGridNone(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, outline);
                const r90 = calcGrid90(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, outline);
                best = r0.positions.length >= r90.positions.length ? r0 : r90;
            }
        }

        if (!model) return { ...best, sheetW: sw, sheetH: sh, areaW, areaH };
        const printable = { left: offsetX, top: offsetY, right: offsetX + areaW, bottom: offsetY + areaH };
        const checkLayout = (layout: LayoutResult): LayoutResult => {
            const checked = validatePlacementPositions(layout.positions, outline, gap, printable);
            return {
                ...layout,
                positions: checked.positions,
                label: checked.removed > 0 ? `${layout.label} · loại ${checked.removed} vị trí va chạm` : layout.label,
            };
        };
        let validated = checkLayout(best);
        if (nestingMode === 'smart') {
            const grid0 = checkLayout(calcGridNone(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, outline));
            const grid90 = checkLayout(calcGrid90(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, outline));
            const grid = grid0.positions.length >= grid90.positions.length ? grid0 : grid90;
            if (grid.positions.length > validated.positions.length) validated = grid;
        }
        return { ...validated, sheetW: sw, sheetH: sh, areaW, areaH };
    };

    let result;
    if (sheetOrientation === 'auto') {
        const portrait = calcForSheet(
            Math.min(sheet.width, sheet.height),
            Math.max(sheet.width, sheet.height)
        );
        const landscape = calcForSheet(
            Math.max(sheet.width, sheet.height),
            Math.min(sheet.width, sheet.height)
        );
        result = portrait.positions.length >= landscape.positions.length ? portrait : landscape;
    } else {
        result = calcForSheet(sheetW, sheetH);
    }

    const count = result.positions.length;
    const dieArea = dieW * dieH;
    const sheetArea = result.areaW * result.areaH;
    const utilization = sheetArea > 0 ? Math.round((count * dieArea / sheetArea) * 1000) / 10 : 0;

    // ── Căn giữa layout trong vùng in ──
    if (count > 0 && result.positions.length > 0) {
        // Tìm bounding box thực tế của layout
        let layoutMinX = Infinity, layoutMinY = Infinity;
        let layoutMaxX = -Infinity, layoutMaxY = -Infinity;
        for (const pos of result.positions) {
            const rot = pos.rotation;
            const pw = (rot === 90 || rot === 270) ? dieH : dieW;
            const ph = (rot === 90 || rot === 270) ? dieW : dieH;
            layoutMinX = Math.min(layoutMinX, pos.x);
            layoutMinY = Math.min(layoutMinY, pos.y);
            layoutMaxX = Math.max(layoutMaxX, pos.x + pw);
            layoutMaxY = Math.max(layoutMaxY, pos.y + ph);
        }

        const { areaW, areaH } = result;
        const printableLeft = margin.left;
        const printableTop = margin.top;

        const layoutW = layoutMaxX - layoutMinX;
        const layoutH = layoutMaxY - layoutMinY;
        const centerDx = printableLeft + (areaW - layoutW) / 2 - layoutMinX;
        const centerDy = printableTop + (areaH - layoutH) / 2 - layoutMinY;

        // Dịch tất cả positions
        for (const pos of result.positions) {
            pos.x += centerDx;
            pos.y += centerDy;
        }
    }

    return {
        positions: result.positions,
        countPerSheet: count,
        rows: result.rows,
        cols: result.cols,
        utilization,
        usableArea: { width: result.areaW, height: result.areaH },
        actualSheet: { width: result.sheetW, height: result.sheetH },
        cellSize: { width: dieW + gap, height: dieH + gap },
        label: result.label,
        superTile: result.superTile || null,
    };
}
