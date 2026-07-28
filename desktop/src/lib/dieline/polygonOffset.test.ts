// ============================================================
// polygonOffset.test.ts
//
// Property-based tests cho phép offset polygon (Workstream B,
// spec dieline-hardening-phase2). File này hiện thực Property 5.
//   • Task 5.2 — Property 5: Đa giác offset bao trọn outline gốc
//     (Validates: Requirements 5.2, 5.6, 6.1)
//
// Mỗi property chạy fast-check với numRuns ≥ 100 và seed cố định
// (ghi nhận) để tái lập (Requirement 9.4).
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { offsetPolygon, computeDieOutline } from './nestingEngine';
import { SNAP_TOLERANCE } from './sharedGeometry';
import { arbSimplePolygon, arbConcavePolygon, arbRectangle } from './arbitraries';
import { snap } from './utils';
import { Point2D, PathSegment, PathTag, DielineModel, DEFAULT_PARAMS } from './types';

// ─── Seed cố định (ghi nhận) cho tái lập — Requirement 9.4 ───
const PROPERTY_5_SEED = 0x0ff5e7; // 1046503

// ─── Helpers hình học (độc lập với implementation) ──────────

/** Point-in-polygon bằng ray casting (đúng với mọi đa giác đơn, mọi chiều). */
function pointInPolygon(p: Point2D, poly: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        const intersect =
            yi > p.y !== yj > p.y &&
            p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/** Khoảng cách từ điểm p tới đoạn thẳng [a,b]. */
function distToSegment(p: Point2D, a: Point2D, b: Point2D): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Khoảng cách nhỏ nhất từ p tới biên đa giác poly. */
function distToBoundary(p: Point2D, poly: Point2D[]): number {
    let min = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const d = distToSegment(p, a, b);
        if (d < min) min = d;
    }
    return min;
}

/** Hai đoạn [a,b],[c,d] cắt nhau thực sự (giao trong lòng, không tính chạm đầu mút). */
function segmentsProperlyIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
    const EPS = 1e-9;
    const cross = (o: Point2D, p: Point2D, q: Point2D) =>
        (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return (
        ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
        ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
    );
}

/** Đa giác có tự cắt (cặp cạnh không kề cắt trong lòng) hay không. */
function isSelfIntersecting(pts: Point2D[]): boolean {
    const n = pts.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        for (let j = i + 1; j < n; j++) {
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

// ── Arbitraries ────────────────────────────────────────────

/** Die_Outline hợp lệ: đa giác đơn (lồi/lõm), ≥ 3 đỉnh phân biệt, diện tích > 0. */
const arbDieOutline: fc.Arbitrary<Point2D[]> = fc.oneof(
    arbSimplePolygon(),
    arbConcavePolygon(),
);

/** dieGap ≥ 0 (gồm 0 và các giá trị dương tới 50 mm). */
const arbDieGap: fc.Arbitrary<number> = fc.oneof(
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 4, arbitrary: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }) },
);

// ============================================================
// Task 5.2 — Property 5
// Feature: dieline-hardening-phase2, Property 5: Đa giác offset bao
// trọn outline gốc — for any Die_Outline hợp lệ (≥ 3 đỉnh phân biệt,
// diện tích > 0) và for any dieGap ≥ 0, mọi đỉnh của outline gốc nằm
// bên trong hoặc trên biên đa giác offsetPolygon(outline, dieGap), với
// sai lệch về phía ngoài biên ≤ SNAP_TOLERANCE (0,01 mm), và đa giác
// offset không tự cắt.
//
// Validates: Requirements 5.2, 5.6, 6.1
// ============================================================

describe('Property 5 — Đa giác offset bao trọn outline gốc', () => {
    it('mọi đỉnh gốc nằm trong/trên biên offset (lệch ngoài ≤ SNAP_TOLERANCE) và offset không tự cắt', () => {
        // Dung sai chấp nhận sai số dấu phẩy động quanh ngưỡng snap 0,001 mm.
        const OUTWARD_TOL = SNAP_TOLERANCE + 1e-9;

        fc.assert(
            fc.property(arbDieOutline, arbDieGap, (outline, dieGap) => {
                const offset = offsetPolygon(outline, dieGap);

                // Đa giác offset phải đủ đỉnh để là một vùng kín hợp lệ.
                if (offset.length < 3) {
                    throw new Error(
                        `offsetPolygon trả về ${offset.length} đỉnh (< 3) cho outline=${JSON.stringify(
                            outline,
                        )} dieGap=${dieGap}`,
                    );
                }

                // (Req 5.6) Đa giác offset KHÔNG tự cắt.
                if (isSelfIntersecting(offset)) {
                    throw new Error(
                        `offsetPolygon tự cắt với outline=${JSON.stringify(outline)} dieGap=${dieGap} → ${JSON.stringify(
                            offset,
                        )}`,
                    );
                }

                // (Req 5.2, 6.1) Mọi đỉnh gốc nằm trong hoặc trên biên offset,
                // sai lệch về phía ngoài ≤ SNAP_TOLERANCE.
                for (const v of outline) {
                    const inside = pointInPolygon(v, offset);
                    if (inside) continue;
                    const dist = distToBoundary(v, offset);
                    if (dist > OUTWARD_TOL) {
                        throw new Error(
                            `Đỉnh gốc (${v.x},${v.y}) nằm ngoài offset ${dist.toFixed(4)} mm ` +
                                `> ${OUTWARD_TOL} mm; dieGap=${dieGap}, outline=${JSON.stringify(
                                    outline,
                                )}, offset=${JSON.stringify(offset)}`,
                        );
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_5_SEED },
        );
    });
});

// ─── Seed cố định (ghi nhận) cho Property 6 — Requirement 9.4 ───
const PROPERTY_6_SEED = 0x06a4ea; // 436970

/**
 * Diện tích đa giác bằng công thức shoelace (trị tuyệt đối), mm².
 * Tính độc lập với implementation của offsetPolygon (Req 6.2).
 */
function shoelaceArea(poly: Point2D[]): number {
    const n = poly.length;
    if (n < 3) return 0;
    let sum = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        sum += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    }
    return Math.abs(sum) / 2;
}

// ============================================================
// Task 5.3 — Property 6
// Feature: dieline-hardening-phase2, Property 6: Offset không làm giảm
// diện tích — for any Die_Outline hợp lệ và for any dieGap ≥ 0, diện
// tích của offsetPolygon(outline, dieGap) ≥ diện tích outline gốc; và
// khi dieGap = 0, hai diện tích bằng nhau trong dung sai 0,001 mm².
//
// Validates: Requirements 6.2
// ============================================================

describe('Property 6 — Offset không làm giảm diện tích', () => {
    it('diện tích offset ≥ diện tích gốc; dieGap=0 → bằng nhau trong 0,001 mm²', () => {
        // Dung sai bằng-nhau khi dieGap = 0 (Req 6.2).
        const EQUAL_TOL = 0.001;
        // Dung sai dấu phẩy động cho vế "không giảm" (Req 6.2).
        const MONOTONE_TOL = 1e-6;

        fc.assert(
            fc.property(arbDieOutline, arbDieGap, (outline, dieGap) => {
                const offset = offsetPolygon(outline, dieGap);

                const areaOrig = shoelaceArea(outline);
                const areaOffset = shoelaceArea(offset);

                // (Req 6.2) Diện tích offset không nhỏ hơn diện tích gốc.
                if (areaOffset < areaOrig - MONOTONE_TOL) {
                    throw new Error(
                        `Diện tích offset ${areaOffset.toFixed(4)} mm² < diện tích gốc ` +
                            `${areaOrig.toFixed(4)} mm²; dieGap=${dieGap}, ` +
                            `outline=${JSON.stringify(outline)}, offset=${JSON.stringify(offset)}`,
                    );
                }

                // (Req 6.2) dieGap = 0 → diện tích bảo toàn trong 0,001 mm².
                if (dieGap === 0) {
                    const diff = Math.abs(areaOffset - areaOrig);
                    if (diff > EQUAL_TOL) {
                        throw new Error(
                            `dieGap=0 nhưng diện tích lệch ${diff.toFixed(6)} mm² > ${EQUAL_TOL} mm²; ` +
                                `gốc=${areaOrig.toFixed(4)}, offset=${areaOffset.toFixed(4)}, ` +
                                `outline=${JSON.stringify(outline)}`,
                        );
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_6_SEED },
        );
    });
});

// ─── Seed cố định (ghi nhận) cho Property 7 — Requirement 9.4 ───
const PROPERTY_7_SEED = 0x07de70; // 515696

/**
 * dieGap bất kỳ (gồm âm, 0 và dương) — Property 7 đòi tính xác định cho
 * MỌI giá trị dieGap, kể cả nhánh kẹp âm (offset < 0 → 0).
 */
const arbDieGapAny: fc.Arbitrary<number> = fc.oneof(
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.double({ min: -50, max: -0.001, noNaN: true, noDefaultInfinity: true }) },
    { weight: 3, arbitrary: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }) },
);

// ============================================================
// Task 5.4 — Property 7
// Feature: dieline-hardening-phase2, Property 7: Offset là xác định và
// bit-identical — for any Die_Outline (cùng dãy đỉnh, cùng thứ tự) và
// for any dieGap, gọi offsetPolygon hai lần cho ra đa giác có cùng số
// đỉnh, cùng thứ tự đỉnh, và mỗi tọa độ tương ứng trùng khít (lệch 0 mm),
// nhờ snap theo SNAP_TOLERANCE.
//
// Validates: Requirements 6.3, 6.6
// ============================================================

describe('Property 7 — Offset là xác định và bit-identical', () => {
    it('hai lần gọi cùng số đỉnh, cùng thứ tự, lệch tọa độ 0 mm', () => {
        fc.assert(
            fc.property(arbDieOutline, arbDieGapAny, (outline, dieGap) => {
                const a = offsetPolygon(outline, dieGap);
                const b = offsetPolygon(outline, dieGap);

                // (Req 6.3) Cùng số đỉnh.
                if (a.length !== b.length) {
                    throw new Error(
                        `Số đỉnh khác nhau giữa hai lần gọi: ${a.length} ≠ ${b.length}; ` +
                            `dieGap=${dieGap}, outline=${JSON.stringify(outline)}`,
                    );
                }

                // (Req 6.3, 6.6) Cùng thứ tự, mỗi tọa độ trùng khít (lệch 0 mm).
                for (let i = 0; i < a.length; i++) {
                    if (a[i].x !== b[i].x || a[i].y !== b[i].y) {
                        throw new Error(
                            `Đỉnh ${i} lệch giữa hai lần gọi: (${a[i].x},${a[i].y}) ≠ ` +
                                `(${b[i].x},${b[i].y}); dieGap=${dieGap}, ` +
                                `outline=${JSON.stringify(outline)}`,
                        );
                    }
                }
            }),
            { numRuns: 100, seed: PROPERTY_7_SEED },
        );
    });
});

// ─── Seed cố định (ghi nhận) cho Property 8 — Requirement 9.4 ───
const PROPERTY_8_SEED = 0x08ec74; // 584820

/** Bounding box trục-song-song của một đa giác. */
function aabb(poly: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

// ============================================================
// Task 5.5 — Property 8
// Feature: dieline-hardening-phase2, Property 8: Offset hình chữ nhật giãn
// đúng dieGap mỗi cạnh — for any Die_Outline là hình chữ nhật và for any
// dieGap ≥ 0, offsetPolygon trả về một hình chữ nhật có mỗi cạnh dịch ra
// ngoài đúng dieGap (mỗi chiều tăng 2 × dieGap) trong dung sai 0,001 mm.
//
// Validates: Requirements 6.4
// ============================================================

describe('Property 8 — Offset hình chữ nhật giãn đúng dieGap mỗi cạnh', () => {
    it('mỗi cạnh ra đúng dieGap, mỗi chiều tăng 2×dieGap trong 0,001 mm', () => {
        // Dung sai 0,001 mm (Req 6.4). Mỗi tọa độ snap về 3 chữ số ⇒ sai số
        // tối đa 0,0005 mm; hiệu hai tọa độ tối đa 0,001 mm. Cộng guard FP.
        const RECT_TOL = 0.001 + 1e-9;

        fc.assert(
            fc.property(arbRectangle(), arbDieGap, (rect, dieGap) => {
                const offset = offsetPolygon(rect, dieGap);

                const orig = aabb(rect);
                const off = aabb(offset);

                // (Req 6.4) Mỗi cạnh dịch ra ngoài đúng dieGap.
                const checks: Array<[string, number, number]> = [
                    ['cạnh trái (minX)', off.minX, orig.minX - dieGap],
                    ['cạnh phải (maxX)', off.maxX, orig.maxX + dieGap],
                    ['cạnh dưới (minY)', off.minY, orig.minY - dieGap],
                    ['cạnh trên (maxY)', off.maxY, orig.maxY + dieGap],
                ];
                for (const [name, actual, expected] of checks) {
                    if (Math.abs(actual - expected) > RECT_TOL) {
                        throw new Error(
                            `${name} = ${actual} ≠ kỳ vọng ${expected} (lệch ` +
                                `${Math.abs(actual - expected).toFixed(6)} mm > ${RECT_TOL}); ` +
                                `dieGap=${dieGap}, rect=${JSON.stringify(rect)}, ` +
                                `offset=${JSON.stringify(offset)}`,
                        );
                    }
                }

                // (Req 6.4) Mỗi chiều tăng đúng 2 × dieGap.
                const origW = orig.maxX - orig.minX;
                const origH = orig.maxY - orig.minY;
                const offW = off.maxX - off.minX;
                const offH = off.maxY - off.minY;
                if (Math.abs(offW - origW - 2 * dieGap) > RECT_TOL) {
                    throw new Error(
                        `Chiều rộng tăng ${(offW - origW).toFixed(6)} mm ≠ 2×dieGap=` +
                            `${(2 * dieGap).toFixed(6)} mm; dieGap=${dieGap}, rect=${JSON.stringify(rect)}`,
                    );
                }
                if (Math.abs(offH - origH - 2 * dieGap) > RECT_TOL) {
                    throw new Error(
                        `Chiều cao tăng ${(offH - origH).toFixed(6)} mm ≠ 2×dieGap=` +
                            `${(2 * dieGap).toFixed(6)} mm; dieGap=${dieGap}, rect=${JSON.stringify(rect)}`,
                    );
                }
            }),
            { numRuns: 100, seed: PROPERTY_8_SEED },
        );
    });
});

// ============================================================
// Task 5.7 — Example test: computeDieOutline và kẹp âm
//
// Outer_Silhouette sẵn có → dùng nó; suy biến/không hợp lệ → bbox-rect;
// dieGap < 0 → kết quả bằng dieGap = 0 (không thu nhỏ).
//
// Validates: Requirements 5.1, 5.7, 6.7, 6.8
// ============================================================

/** Tạo một PathSegment line đơn giản từ hai điểm. */
function seg(a: Point2D, b: Point2D, tag: PathTag): PathSegment {
    return { points: [a, b], tag, type: 'line' };
}

/** Dựng một DielineModel tối thiểu với danh sách allPaths cho trước. */
function makeModel(allPaths: PathSegment[], bbox: { width: number; height: number }): DielineModel {
    return {
        name: 'test',
        standardCode: 'TEST',
        description: 'fake model for computeDieOutline test',
        panels: [],
        allPaths,
        boundingBox: {
            minX: 0,
            minY: 0,
            maxX: bbox.width,
            maxY: bbox.height,
            width: bbox.width,
            height: bbox.height,
        },
        params: { ...DEFAULT_PARAMS },
    };
}

describe('Task 5.7 — computeDieOutline và kẹp âm dieGap', () => {
    it('Outer_Silhouette sẵn có → dùng nó (không phải bbox-rect)', () => {
        // Một Cut_Piece hình chữ L 40×30 ghép từ 6 đoạn CUT khép kín. Chọn hình
        // L (không phải chữ nhật) để phân biệt rõ hai nguồn: bbox-rect luôn có
        // đúng 4 đỉnh, còn silhouette này có 6 đỉnh dù cùng bao 40×30.
        const pts = [
            { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 },
            { x: 15, y: 10 }, { x: 15, y: 30 }, { x: 0, y: 30 },
        ];
        const cutSegs = pts.map((p, i) => seg(p, pts[(i + 1) % pts.length], 'CUT'));
        // Bao khuôn TRÙNG bao silhouette — điều kiện `silhouetteCoversDie`.
        const bbox = { width: 40, height: 30 };
        const model = makeModel(cutSegs, bbox);

        const outline = computeDieOutline(model, bbox);

        // Phải dùng Outer_Silhouette (hình L, 6 đỉnh), KHÔNG phải bbox-rect.
        expect(outline.length).toBeGreaterThan(4);
        expect(outline).toEqual(
            expect.arrayContaining([{ x: 15, y: 10 }]),
        );
    });

    // [HANGING-WINDOW 2026-07-27] Test khoá: một vòng CUT khép kín NỘI BỘ (rãnh
    // xả / khe gài) không được nhận làm biên khuôn. Đo thực tế trước khi sửa:
    // khuôn pizza 468×736mm nhận về vòng 2,5×45mm ⇒ bước lưới ~11mm ⇒ engine
    // báo 784 khuôn/tờ (vật lý tối đa 2) kèm vị trí toạ độ âm.
    it('vòng CUT khép kín nội bộ (không phủ bao khuôn) → bbox-rect', () => {
        // Khe 2,5×45 nằm giữa khuôn 468×736, cộng vài nét CUT biên hở (không
        // khép được) đúng như khuôn thật.
        const slot = [
            { x: 200, y: 300 }, { x: 202.5, y: 300 },
            { x: 202.5, y: 345 }, { x: 200, y: 345 },
        ];
        const cutSegs = [
            ...slot.map((p, i) => seg(p, slot[(i + 1) % slot.length], 'CUT')),
            seg({ x: 0, y: 0 }, { x: 468, y: 0 }, 'CUT'),
            seg({ x: 0, y: 736 }, { x: 468, y: 736 }, 'CUT'),
        ];
        const bbox = { width: 468, height: 736 };
        const model = makeModel(cutSegs, bbox);

        expect(computeDieOutline(model, bbox)).toEqual([
            { x: 0, y: 0 },
            { x: 468, y: 0 },
            { x: 468, y: 736 },
            { x: 0, y: 736 },
        ]);
    });

    it('Cut_Piece suy biến (chỉ CREASE, không có CUT/BLEED) → bbox-rect', () => {
        // Chỉ có đoạn CREASE → không có biên ngoài → fallback bbox-rect.
        const creaseSegs = [
            seg({ x: 5, y: 5 }, { x: 35, y: 5 }, 'CREASE'),
            seg({ x: 35, y: 5 }, { x: 35, y: 25 }, 'CREASE'),
        ];
        const bbox = { width: 120, height: 90 };
        const model = makeModel(creaseSegs, bbox);

        const outline = computeDieOutline(model, bbox);

        // Mong đợi đúng bbox-rect [(0,0),(w,0),(w,h),(0,h)].
        expect(outline).toEqual([
            { x: 0, y: 0 },
            { x: 120, y: 0 },
            { x: 120, y: 90 },
            { x: 0, y: 90 },
        ]);
    });

    it('model undefined → bbox-rect', () => {
        const bbox = { width: 80, height: 60 };
        const outline = computeDieOutline(undefined, bbox);
        expect(outline).toEqual([
            { x: 0, y: 0 },
            { x: 80, y: 0 },
            { x: 80, y: 60 },
            { x: 0, y: 60 },
        ]);
    });

    it('dieGap < 0 → offsetPolygon kết quả bằng dieGap = 0 (không thu nhỏ)', () => {
        const rect: Point2D[] = [
            { x: snap(10), y: snap(10) },
            { x: snap(60), y: snap(10) },
            { x: snap(60), y: snap(40) },
            { x: snap(10), y: snap(40) },
        ];

        const zero = offsetPolygon(rect, 0);
        const negSmall = offsetPolygon(rect, -0.5);
        const negLarge = offsetPolygon(rect, -25);

        // (Req 5.7, 6.8) dieGap âm bị kẹp về 0 → kết quả trùng khít dieGap = 0,
        // và KHÔNG thu nhỏ outline gốc.
        expect(negSmall).toEqual(zero);
        expect(negLarge).toEqual(zero);
        // Không thu nhỏ: kết quả vẫn bao đúng outline gốc (cùng AABB).
        const o = aabb(rect);
        const n = aabb(negLarge);
        expect(n.minX).toBeCloseTo(o.minX, 3);
        expect(n.minY).toBeCloseTo(o.minY, 3);
        expect(n.maxX).toBeCloseTo(o.maxX, 3);
        expect(n.maxY).toBeCloseTo(o.maxY, 3);
    });
});
