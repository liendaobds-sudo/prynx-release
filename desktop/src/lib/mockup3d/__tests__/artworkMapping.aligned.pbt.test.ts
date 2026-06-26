// ============================================================
// Property test — artworkMapping.computePanelUV (aligned-to-dieline)
//
// Feature: mockup-3d-realism, Property 14: Canh ảnh theo dieline khớp vị trí mặt
// **Validates: Requirements 5.2**
//
// Với chế độ `aligned-to-dieline` và biến đổi đồng nhất (scale 100%,
// offset 0%), UV của một đỉnh trên mặt ngoài (`outer`) bằng đúng vị trí
// chuẩn hóa của đỉnh đó trong `globalBBox`:
//      u = (x - minX) / width
//      v = (y - minY) / height
// nên ảnh canh theo tọa độ dieline (ánh xạ tuyến tính, biên ảnh trùng
// biên vùng mặt). Hệ quả: hai panel ở vị trí khác nhau trong cùng một
// `globalBBox` nhận UV khác nhau tương ứng với vị trí của chúng — phép
// tịnh tiến (dx, dy) trong không gian dieline tương ứng dịch UV đúng
// (dx/width, dy/height).
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computePanelUV } from '../artworkMapping';
import type { ArtworkTransform, BBox, Panel, Point2D } from '../types';

const NUM_RUNS = 100;

/** Biến đổi đồng nhất: không phóng to/thu nhỏ, không dịch chuyển. */
const IDENTITY: ArtworkTransform = { scalePct: 100, offsetXPct: 0, offsetYPct: 0 };

/** Dựng một Panel tối thiểu chỉ với outline (computePanelUV ưu tiên outline). */
function makePanel(name: string, outline: Point2D[]): Panel {
    return {
        name,
        label: name,
        paths: [],
        outline,
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
    };
}

/** Dựng globalBBox khép kín từ min + kích thước (width/height > 0). */
function makeBBox(minX: number, minY: number, width: number, height: number): BBox {
    return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
}

/**
 * Generator: một globalBBox không suy biến cùng một panel có các đỉnh
 * nằm trong bbox. Trả về cả tham số bbox để kiểm chứng.
 */
const bboxWithPanelArb = fc
    .record({
        minX: fc.double({ min: -1000, max: 1000, noNaN: true }),
        minY: fc.double({ min: -1000, max: 1000, noNaN: true }),
        width: fc.double({ min: 1, max: 2000, noNaN: true }),
        height: fc.double({ min: 1, max: 2000, noNaN: true }),
        // Tỉ lệ [0,1] của từng đỉnh trong bbox → bảo đảm đỉnh nằm trong khung.
        fracs: fc.array(
            fc.record({
                fx: fc.double({ min: 0, max: 1, noNaN: true }),
                fy: fc.double({ min: 0, max: 1, noNaN: true }),
            }),
            { minLength: 1, maxLength: 12 },
        ),
    })
    .map(({ minX, minY, width, height, fracs }) => {
        const bbox = makeBBox(minX, minY, width, height);
        const outline: Point2D[] = fracs.map(({ fx, fy }) => ({
            x: minX + fx * width,
            y: minY + fy * height,
        }));
        return { bbox, outline };
    });

describe('computePanelUV (aligned-to-dieline) — Property 14: Canh ảnh theo dieline khớp vị trí mặt', () => {
    it('UV mặt ngoài = vị trí chuẩn hóa của đỉnh trong globalBBox (Yêu cầu 5.2)', () => {
        fc.assert(
            fc.property(bboxWithPanelArb, ({ bbox, outline }) => {
                const panel = makePanel('face', outline);
                const uv = computePanelUV(panel, 'aligned-to-dieline', IDENTITY, bbox, 'outer');

                expect(uv.length).toBe(outline.length * 2);

                for (let i = 0; i < outline.length; i++) {
                    const expectedU = (outline[i].x - bbox.minX) / bbox.width;
                    const expectedV = (outline[i].y - bbox.minY) / bbox.height;
                    // UV lưu trong Float32Array ⇒ độ chính xác ~1e-7. Tolerance
                    // 1e-5 vẫn chặt hơn nhiều so với sai số ≤1px của Yêu cầu 5.2.
                    expect(uv[i * 2]).toBeCloseTo(expectedU, 5);
                    expect(uv[i * 2 + 1]).toBeCloseTo(expectedV, 5);
                    // UV nằm trong [0,1] vì đỉnh nằm trong bbox.
                    expect(uv[i * 2]).toBeGreaterThanOrEqual(-1e-5);
                    expect(uv[i * 2]).toBeLessThanOrEqual(1 + 1e-5);
                    expect(uv[i * 2 + 1]).toBeGreaterThanOrEqual(-1e-5);
                    expect(uv[i * 2 + 1]).toBeLessThanOrEqual(1 + 1e-5);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('hai panel ở vị trí khác nhau nhận UV khác nhau tương ứng vị trí (Yêu cầu 5.2)', () => {
        // Sinh một hình tương đối (các đỉnh trong [0,rw]x[0,rh]) rồi đặt ở hai
        // vị trí khác nhau trong cùng globalBBox. UV phải dịch đúng theo tịnh tiến.
        const arb = fc
            .record({
                minX: fc.double({ min: -500, max: 500, noNaN: true }),
                minY: fc.double({ min: -500, max: 500, noNaN: true }),
                width: fc.double({ min: 10, max: 2000, noNaN: true }),
                height: fc.double({ min: 10, max: 2000, noNaN: true }),
                // Kích thước hình con (tỉ lệ so với bbox) để còn chỗ tịnh tiến.
                rwFrac: fc.double({ min: 0, max: 0.4, noNaN: true }),
                rhFrac: fc.double({ min: 0, max: 0.4, noNaN: true }),
                shape: fc.array(
                    fc.record({
                        sx: fc.double({ min: 0, max: 1, noNaN: true }),
                        sy: fc.double({ min: 0, max: 1, noNaN: true }),
                    }),
                    { minLength: 1, maxLength: 8 },
                ),
                // Vị trí góc của panel A và B (tỉ lệ trong vùng còn lại).
                aFracX: fc.double({ min: 0, max: 1, noNaN: true }),
                aFracY: fc.double({ min: 0, max: 1, noNaN: true }),
                bFracX: fc.double({ min: 0, max: 1, noNaN: true }),
                bFracY: fc.double({ min: 0, max: 1, noNaN: true }),
            })
            .map((r) => {
                const bbox = makeBBox(r.minX, r.minY, r.width, r.height);
                const rw = r.rwFrac * r.width;
                const rh = r.rhFrac * r.height;
                const freeX = r.width - rw;
                const freeY = r.height - rh;
                const ax = r.minX + r.aFracX * freeX;
                const ay = r.minY + r.aFracY * freeY;
                const bx = r.minX + r.bFracX * freeX;
                const by = r.minY + r.bFracY * freeY;
                const rel = r.shape.map(({ sx, sy }) => ({ x: sx * rw, y: sy * rh }));
                const outlineA = rel.map((p) => ({ x: ax + p.x, y: ay + p.y }));
                const outlineB = rel.map((p) => ({ x: bx + p.x, y: by + p.y }));
                return { bbox, outlineA, outlineB, dx: bx - ax, dy: by - ay };
            });

        fc.assert(
            fc.property(arb, ({ bbox, outlineA, outlineB, dx, dy }) => {
                const uvA = computePanelUV(makePanel('a', outlineA), 'aligned-to-dieline', IDENTITY, bbox, 'outer');
                const uvB = computePanelUV(makePanel('b', outlineB), 'aligned-to-dieline', IDENTITY, bbox, 'outer');

                const expectedDU = dx / bbox.width;
                const expectedDV = dy / bbox.height;

                for (let i = 0; i < outlineA.length; i++) {
                    // Hiệu UV giữa hai panel chỉ phụ thuộc tịnh tiến vị trí.
                    // Tolerance 1e-5 phù hợp độ chính xác Float32Array.
                    expect(uvB[i * 2] - uvA[i * 2]).toBeCloseTo(expectedDU, 5);
                    expect(uvB[i * 2 + 1] - uvA[i * 2 + 1]).toBeCloseTo(expectedDV, 5);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
