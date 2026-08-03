// ============================================================
// geometryHelpers.ts — Helper hình học thuần hàm cho kiểm thử
//
// Tập hợp các hàm hình học không phụ thuộc framework, dùng bởi
// bộ kiểm thử hình học (geometry.test.ts) cho 8 generator.
//
// Gồm:
//   - polygonArea            : diện tích đa giác (shoelace)
//   - polygonIntersectionArea: diện tích phần giao 2 đa giác (triangulation)
//   - pointToSegmentDist     : khoảng cách điểm tới đoạn thẳng
//   - contourGap             : khoảng hở đầu-cuối của biên cắt (dùng tracePerimeter)
//   - expectedFlatArea       : diện tích phẳng kỳ vọng theo params/box type
//
// Tất cả đều là hàm thuần (pure), không thay đổi đầu vào.
// ============================================================

import { Point2D, PathSegment, BoxParams } from './types';
import { tracePerimeter } from './tracePerimeter';
// [HANGING-WINDOW 2026-07-27] Kích thước phụ của hộp treo (tai treo, cửa sổ)
// được suy từ chính hàm của generator để mô hình diện tích không lệch hằng số.
import { hangingWindowDims } from './HangingWindowBox';

const EPS = 1e-12;

// ============================================================
// 1. polygonArea — Shoelace (Gauss area)
// ============================================================

/**
 * Diện tích (không dấu) của một đa giác đơn theo công thức shoelace.
 * Đa giác được mô tả bằng danh sách đỉnh theo thứ tự (CW hoặc CCW).
 * Tự động bỏ qua điểm đóng trùng lặp (điểm cuối == điểm đầu).
 *
 * @param points Danh sách đỉnh đa giác
 * @returns Diện tích ≥ 0 (mm²). Trả về 0 nếu < 3 đỉnh.
 */
export function polygonArea(points: Point2D[]): number {
    return Math.abs(signedArea(points));
}

/** Diện tích có dấu (dương nếu CCW, âm nếu CW). */
export function signedArea(points: Point2D[]): number {
    const pts = stripClosing(points);
    const n = pts.length;
    if (n < 3) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
}

// ============================================================
// 2. pointToSegmentDist — khoảng cách điểm tới đoạn thẳng
// ============================================================

/**
 * Khoảng cách Euclid ngắn nhất từ điểm `p` tới đoạn thẳng [a, b].
 * Khi a ≈ b (đoạn suy biến thành điểm) → khoảng cách tới điểm đó.
 */
export function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < EPS) {
        // Đoạn suy biến → khoảng cách tới điểm a
        return Math.hypot(p.x - a.x, p.y - a.y);
    }
    // Chiếu p lên đường thẳng, kẹp t vào [0, 1]
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
}

// ============================================================
// 3. contourGap — khoảng hở đầu-cuối của biên cắt
// ============================================================

/**
 * Khoảng hở (mm) giữa điểm đầu và điểm cuối của biên dạng cắt sau khi
 * nối thành chu vi. TÁI SỬ DỤNG `tracePerimeter` (không hiện thực thuật
 * toán nối chuỗi thứ hai) — phù hợp Requirement 1.6.
 *
 * @param cutSegments Các PathSegment của một Cut_Piece (CREASE sẽ được
 *                    tracePerimeter tự lọc bỏ).
 * @returns Khoảng cách Euclid giữa đầu và cuối chuỗi. `Infinity` nếu
 *          không nối được chuỗi hợp lệ (< 2 điểm).
 */
export function contourGap(cutSegments: PathSegment[]): number {
    const chain = tracePerimeter(cutSegments);
    if (chain.length < 2) return Infinity;
    const first = chain[0];
    const last = chain[chain.length - 1];
    return Math.hypot(first.x - last.x, first.y - last.y);
}

// ============================================================
// 4. polygonIntersectionArea — diện tích phần giao 2 đa giác
//
// Chiến lược (robust với đa giác lõm):
//   1. Tam giác hóa (ear clipping) mỗi đa giác thành các tam giác rời.
//   2. Diện tích giao = tổng diện tích giao của mọi cặp tam giác
//      (tam giác lồi → cắt Sutherland–Hodgman cho kết quả đúng).
// ============================================================

/**
 * Diện tích phần giao (mm²) giữa hai đa giác đơn `a` và `b`.
 * Hỗ trợ cả đa giác lồi lẫn lõm. Hai đa giác chỉ chạm biên chung
 * (không chồng lấn diện tích) → trả về xấp xỉ 0.
 */
export function polygonIntersectionArea(a: Point2D[], b: Point2D[]): number {
    const trisA = triangulate(a);
    const trisB = triangulate(b);
    if (trisA.length === 0 || trisB.length === 0) return 0;

    let total = 0;
    for (const ta of trisA) {
        for (const tb of trisB) {
            total += convexClipArea(ta, tb);
        }
    }
    return total;
}

/**
 * Tam giác hóa một đa giác đơn bằng thuật toán ear clipping.
 * Trả về danh sách tam giác (mỗi tam giác là 3 điểm). Đa giác đầu vào
 * được chuẩn hóa về CCW. Trả về [] nếu không hợp lệ (< 3 đỉnh).
 */
export function triangulate(points: Point2D[]): Point2D[][] {
    let verts = stripClosing(points).map(p => ({ x: p.x, y: p.y }));
    // Loại đỉnh trùng liên tiếp
    verts = dedupeConsecutive(verts);
    const n = verts.length;
    if (n < 3) return [];

    // Đảm bảo CCW
    if (signedArea(verts) < 0) verts.reverse();

    const indices: number[] = verts.map((_, i) => i);
    const triangles: Point2D[][] = [];

    let guard = 0;
    const maxIter = n * n + 10;
    while (indices.length > 3 && guard++ < maxIter) {
        let earFound = false;
        for (let i = 0; i < indices.length; i++) {
            const prev = indices[(i - 1 + indices.length) % indices.length];
            const curr = indices[i];
            const next = indices[(i + 1) % indices.length];
            const a = verts[prev];
            const b = verts[curr];
            const c = verts[next];

            // Đỉnh lồi? (CCW → cross > 0)
            if (cross(a, b, c) <= EPS) continue;

            // Không có đỉnh nào khác nằm trong tam giác abc?
            let containsOther = false;
            for (let j = 0; j < indices.length; j++) {
                const idx = indices[j];
                if (idx === prev || idx === curr || idx === next) continue;
                if (pointInTriangle(verts[idx], a, b, c)) {
                    containsOther = true;
                    break;
                }
            }
            if (containsOther) continue;

            // Là tai (ear) → cắt
            triangles.push([a, b, c]);
            indices.splice(i, 1);
            earFound = true;
            break;
        }
        if (!earFound) break; // đa giác suy biến / tự cắt — dừng an toàn
    }

    if (indices.length === 3) {
        triangles.push([verts[indices[0]], verts[indices[1]], verts[indices[2]]]);
    }
    return triangles;
}

// ============================================================
// 5. expectedFlatArea — diện tích phẳng kỳ vọng theo params
//
// LƯU Ý: Đây là MÔ HÌNH GIẢI TÍCH gần đúng cho diện tích vật liệu
// trải phẳng của từng loại hộp, dùng làm giá trị kỳ vọng cho
// Property 4 (task 10.6/10.4). Công thức nắm phần thân chính (body
// strip) chính xác và ước lượng phần tai/vạt. Test diện tích phẳng
// dùng sai số tương đối; ngưỡng có thể được hiệu chỉnh theo từng
// generator khi viết Property 4.
// ============================================================

/**
 * Diện tích phẳng kỳ vọng (mm²) của khuôn bế theo `params` và `boxType`.
 * Mô hình giải tích theo hình học chuẩn của từng loại hộp.
 */
export function expectedFlatArea(params: BoxParams): number {
    const { L, W, D, T, G, TH } = params;

    switch (params.boxType) {
        case 'rte':
        case 'slb': {
            // Thân: mép keo (G) + 4 vách (L+W+L+W), cao D
            const bodyW = G + 2 * L + 2 * W;
            const body = bodyW * D;
            // Nắp gài trên (front) + đáy (back), mỗi cái ~ rộng L, cao (TH + T)
            const closures = 2 * (L * (TH + T));
            // 4 tai bụi ~ rộng W, cao TH (xấp xỉ hình thang ~ 0.5)
            const dust = 4 * (W * TH * 0.5);
            return body + closures + dust;
        }

        case 'hanging_window': {
            // [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ = thân RTE
            // (mép keo + 4 vách + nắp gài so le + 4 tai bụi) cộng cụm tai treo
            // euro HAI LỚP và lưỡi khoá trên mặt sau, TRỪ phần cửa sổ khoét ở
            // mặt trước (lỗ euro bỏ qua vì diện tích không đáng kể so với
            // ngưỡng của mô hình gần đúng này).
            const dims = hangingWindowDims(params);
            const bodyW = G + 2 * L + 2 * W;
            const body = bodyW * D;
            // Nắp đậy khẩu độ (W − T) + lưỡi gài cao TH, ở cả trên và dưới
            const closures = 2 * (L * (W - T + TH));
            // 4 tai bụi ~ rộng W, cao TH (xấp xỉ hình thang ~ 0.5) — như RTE
            const dust = 4 * (W * TH * 0.5);
            // Tai treo: lớp 1 cao tabH + lớp 2 cao tab2H, rộng gần bằng mặt sau
            const hangTabs = L * (dims.tabH + dims.tab2H);
            const hangLip = dims.lipW * dims.lipH;
            const window = dims.hasWindow ? dims.winW * dims.winH : 0;
            return body + closures + dust + hangTabs + hangLip - window;
        }

        case 'auto_bottom': {
            // Thân giống RTE/SLB
            const bodyW = G + 2 * L + 2 * W;
            const body = bodyW * D;
            // Nắp đậy trên (span W − T) + lưỡi gài (TH), chỉ trên mặt trước
            const closure = L * (W - T + TH);
            // 2 tai bụi trên ~ rộng W, cao TH (xấp xỉ hình thang ~ 0.5)
            const dust = 2 * (W * TH * 0.5);
            // Đáy dán (mẫu 100010-01): 2 mảnh chính L×0.76W + 2 tai hông
            // hình thang (bot/top ≈ 0.32 → hệ số diện tích ~0.66)
            const bottom = 2 * (L * 0.76 * W) + 2 * (W * 0.5 * W * 0.66);
            return body + closure + dust + bottom;
        }

        case 'gable': {
            // Thân tương tự RTE + đỉnh mái (gable) + tay cầm
            const bodyW = G + 2 * L + 2 * W;
            const body = bodyW * D;
            const gablePeaks = 2 * (L * W * 0.5);
            const sideFlaps = 2 * (W * W * 0.5);
            return body + gablePeaks + sideFlaps;
        }

        case 'paper_bag': {
            // Ống thân trải phẳng + mép keo, cộng phần gấp đáy
            const tubeW = G + 2 * L + 2 * W;
            const bottomFold = params.BF > 0 ? params.BF : W / 2 + 10;
            return tubeW * (D + bottomFold);
        }

        case 'cup_sleeve': {
            // Hình quạt khuyên (annular sector) xấp xỉ bằng hình thang:
            //   chiều cao trung bình × (cung trung bình của 2 đường kính)
            const { cupD1, cupD2, cupH, cupCoverage } = params;
            const r1 = cupD1 / 2;
            const r2 = cupD2 / 2;
            const coverage = (cupCoverage || 100) / 100;
            const arcInner = Math.PI * cupD1 * coverage;
            const arcOuter = Math.PI * cupD2 * coverage;
            const slant = Math.hypot(cupH, r2 - r1);
            return ((arcInner + arcOuter) / 2) * slant;
        }

        case 'pizza': {
            // FEFCO 0426: đáy (L×W) + 2 vách trước/sau (L×D) + 2 vách hông (W×D)
            // + nắp (L×W) + tai bụi
            const bottom = L * W;
            const walls = 2 * (L * D) + 2 * (W * D);
            const lid = L * W;
            const dust = 6 * (D * D * 0.5);
            return bottom + walls + lid + dust;
        }

        case 'envelope': {
            // Mặt trước (envW×envH) + nắp dán + 2 tai hông + nắp đáy
            const { envW, envH } = params;
            const FH = params.envFH > 0 ? params.envFH : envH * 0.7;
            const SF = params.envSF > 0 ? params.envSF : envW * 0.15;
            const front = envW * envH;
            const sealFlap = envW * FH;
            const sideFlaps = 2 * (SF * envH);
            const bottomFlap = envW * (envH * 0.5);
            return front + sealFlap + sideFlaps + bottomFlap;
        }

        case 'tray': {
            // Hộp diêm/khay: đáy (L×W) + 4 vách kép (mỗi vách ~ 2×D) + tai
            const bottom = L * W;
            const wallsLong = 2 * (L * 2 * D);
            const wallsShort = 2 * (W * 2 * D);
            const tabs = 4 * (TH * D);
            const sleeveGlue = params.sleeveGlue > 0 ? params.sleeveGlue : 15;
            const sleeve = (2 * L + 2 * D) * sleeveGlue;
            return bottom + wallsLong + wallsShort + tabs + sleeve;
        }

        case 'double_tray': {
            // Hộp âm dương: 2 mảnh khay thành kép (đáy + nắp). [DOUBLE-TRAY 2026-07-26]
            // Mỗi mảnh: thân + 4 dải (thành D + dầm G + thành trong D−T + mí TH)
            // + 4 vạt góc + 4 tai khóa; trừ gần đúng 8 tam giác vát 45° của mí.
            const { C, lidD, lidGap } = params;
            const piece = (bl: number, bw: number, bd: number): number => {
                const inner = bd - T;
                const stack = bd + G + inner + TH;
                const body = bl * bw;
                const strips = 2 * (bl + bw) * stack - 4 * TH * TH;
                const slit = Math.max(2 * T, 2 * C);
                const corners = 4 * Math.max(0, bd - T - slit) * (bd + C);
                const dust = 4 * Math.max(0, bd - 2 * T) * Math.max(0, inner - C);
                return body + strips + corners + dust;
            };
            const delta = 8 * T + 2 * lidGap;
            const lidDepth = lidD > 0 ? lidD : D + 2 * T;
            return piece(L, W, D) + piece(L + delta, W + delta, lidDepth);
        }

        case 'flip_top_tuck': {
            // [FLIP-TOP-TUCK 2026-08-02 §FTT.5] Mô hình gần đúng theo 13 panel:
            // đáy + mép trước thấp + vách sau + nắp + hai hông nắp +
            // vách trước nắp + hai cánh đáy + bốn tai khóa góc.
            const B = L + 2 * T;
            const BW = Math.max(2, W - T);
            const bottom = B * BW;
            const frontLip = B * D / 3;
            const backWall = B * D;
            const lid = L * W;
            const lidSides = 2 * W * D;
            const lidFront = B * D;
            const baseSides = 2 * BW * (D / 2 + T + params.C);
            const cornerLocks = 4 * D * D * 0.5;
            return bottom + frontLip + backWall + lid + lidSides
                + lidFront + baseSides + cornerLocks;
        }

        default:
            return NaN;
    }
}

// ============================================================
// Hàm phụ trợ nội bộ
// ============================================================

/** Bỏ điểm đóng trùng lặp (điểm cuối == điểm đầu trong dung sai). */
function stripClosing(points: Point2D[]): Point2D[] {
    if (points.length >= 2) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
            return points.slice(0, -1);
        }
    }
    return points;
}

/** Loại các đỉnh trùng nhau liên tiếp (kể cả vòng quanh). */
function dedupeConsecutive(pts: Point2D[]): Point2D[] {
    const out: Point2D[] = [];
    for (let i = 0; i < pts.length; i++) {
        const prev = out[out.length - 1];
        const cur = pts[i];
        if (!prev || Math.abs(prev.x - cur.x) > 1e-9 || Math.abs(prev.y - cur.y) > 1e-9) {
            out.push(cur);
        }
    }
    // Kiểm tra điểm đầu vs điểm cuối
    if (out.length >= 2) {
        const a = out[0];
        const b = out[out.length - 1];
        if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) out.pop();
    }
    return out;
}

/** Cross product (b-a) × (c-a). > 0 nếu rẽ trái (CCW). */
function cross(a: Point2D, b: Point2D, c: Point2D): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Điểm p có nằm trong (hoặc trên biên) tam giác abc không? */
function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
    // Nằm trong nếu không vừa âm vừa dương (cho phép trên biên)
    return !(hasNeg && hasPos);
}

/**
 * Diện tích phần giao của hai đa giác LỒI (dùng cho tam giác).
 * Cắt `subject` bằng từng cạnh của `clip` (Sutherland–Hodgman).
 */
function convexClipArea(subject: Point2D[], clip: Point2D[]): number {
    // Đảm bảo clip theo CCW để "bên trong" là phía trái mỗi cạnh
    let clipPoly = clip;
    if (signedArea(clipPoly) < 0) clipPoly = [...clipPoly].reverse();

    let output: Point2D[] = [...subject];
    const m = clipPoly.length;

    for (let i = 0; i < m; i++) {
        if (output.length === 0) break;
        const A = clipPoly[i];
        const B = clipPoly[(i + 1) % m];
        const input = output;
        output = [];
        for (let j = 0; j < input.length; j++) {
            const cur = input[j];
            const prev = input[(j - 1 + input.length) % input.length];
            const curInside = cross(A, B, cur) >= -EPS;
            const prevInside = cross(A, B, prev) >= -EPS;
            if (curInside) {
                if (!prevInside) {
                    const inter = lineIntersect(prev, cur, A, B);
                    if (inter) output.push(inter);
                }
                output.push(cur);
            } else if (prevInside) {
                const inter = lineIntersect(prev, cur, A, B);
                if (inter) output.push(inter);
            }
        }
    }

    return polygonArea(output);
}

/** Giao điểm của đoạn (p1,p2) với đường thẳng (a,b). */
function lineIntersect(p1: Point2D, p2: Point2D, a: Point2D, b: Point2D): Point2D | null {
    const r = { x: p2.x - p1.x, y: p2.y - p1.y };
    const s = { x: b.x - a.x, y: b.y - a.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < EPS) return null; // song song
    const t = ((a.x - p1.x) * s.y - (a.y - p1.y) * s.x) / denom;
    return { x: p1.x + t * r.x, y: p1.y + t * r.y };
}
