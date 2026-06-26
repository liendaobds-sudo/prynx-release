// ============================================================
// Property test — artworkMapping.computePanelUV (faceSide 'outer')
//
// Feature: mockup-3d-realism, Property 15: Ảnh mặt ngoài giữ hướng đọc, không lật gương
// **Validates: Requirements 5.3**
//
// Với mặt ngoài (`outer`), bản render giữ đúng hướng đọc: KHÔNG lật gương
// trục ngang (U) và KHÔNG lật gương trục Y. Cụ thể, U là hàm đơn điệu
// không giảm theo hoành độ X của đỉnh trong cùng một panel: với hai đỉnh
// có x1 < x2 thì u1 <= u2.
//
// Ngoài ra, cấu hình mặt ngoài khác mặt trong cho các trường hợp không
// suy biến: mặt trong lật gương U nên tồn tại đỉnh có U khác mặt ngoài.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computePanelUV } from '../artworkMapping';
import type { ArtworkTransform, BBox, Panel, PlacementMode, Point2D } from '../types';

const NUM_RUNS = 200;

/** Generator một điểm 2D với tọa độ hữu hạn trong miền rộng. */
const pointArb: fc.Arbitrary<Point2D> = fc.record({
    x: fc.double({ min: -1000, max: 1000, noNaN: true }),
    y: fc.double({ min: -1000, max: 1000, noNaN: true }),
});

/** Panel với outline gồm ≥2 đỉnh (đủ để so sánh cặp đỉnh). */
const panelArb: fc.Arbitrary<Panel> = fc
    .array(pointArb, { minLength: 2, maxLength: 12 })
    .map(
        (outline) =>
            ({
                name: 'face',
                label: 'face',
                paths: [],
                outline,
            }) as unknown as Panel,
    );

/** Transform hợp lệ (sẽ được clamp nội bộ; ở đây giữ trong miền). */
const transformArb: fc.Arbitrary<ArtworkTransform> = fc.record({
    scalePct: fc.double({ min: 10, max: 1000, noNaN: true }),
    offsetXPct: fc.double({ min: -100, max: 100, noNaN: true }),
    offsetYPct: fc.double({ min: -100, max: 100, noNaN: true }),
});

/** Cả hai chế độ đặt ảnh đều phải giữ hướng đọc cho mặt ngoài. */
const modeArb: fc.Arbitrary<PlacementMode> = fc.constantFrom('per-face', 'aligned-to-dieline');

/** globalBBox bao toàn bộ điểm để chế độ aligned-to-dieline có khung tham chiếu hợp lệ. */
function bboxCovering(points: Point2D[]): BBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    // Mở rộng nhẹ để width/height > 0 ngay cả khi điểm trùng nhau.
    minX -= 1;
    minY -= 1;
    maxX += 1;
    maxY += 1;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

const EPS = 1e-9;

describe("computePanelUV — Property 15: Ảnh mặt ngoài giữ hướng đọc, không lật gương ('outer')", () => {
    it('U đơn điệu không giảm theo X cho mọi cặp đỉnh (không lật gương ngang, Yêu cầu 5.3)', () => {
        fc.assert(
            fc.property(panelArb, modeArb, transformArb, (panel, mode, transform) => {
                const outline = panel.outline!;
                const globalBBox = bboxCovering(outline);
                const uv = computePanelUV(panel, mode, transform, globalBBox, 'outer');

                // Với mọi cặp đỉnh: x1 < x2 ⇒ u1 <= u2 (cho phép sai số số học nhỏ).
                for (let i = 0; i < outline.length; i++) {
                    for (let j = 0; j < outline.length; j++) {
                        const xi = outline[i].x;
                        const xj = outline[j].x;
                        const ui = uv[i * 2];
                        const uj = uv[j * 2];
                        if (xi < xj) {
                            expect(ui).toBeLessThanOrEqual(uj + EPS);
                        }
                        // X bằng nhau ⇒ U bằng nhau (ánh xạ chỉ phụ thuộc X cho trục U).
                        if (xi === xj) {
                            expect(Math.abs(ui - uj)).toBeLessThanOrEqual(EPS);
                        }
                    }
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('mọi U hữu hạn (không sinh NaN/Infinity)', () => {
        fc.assert(
            fc.property(panelArb, modeArb, transformArb, (panel, mode, transform) => {
                const globalBBox = bboxCovering(panel.outline!);
                const uv = computePanelUV(panel, mode, transform, globalBBox, 'outer');
                for (let i = 0; i < panel.outline!.length; i++) {
                    expect(Number.isFinite(uv[i * 2])).toBe(true);
                    expect(Number.isFinite(uv[i * 2 + 1])).toBe(true);
                }
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('mặt ngoài khác mặt trong cho trường hợp không suy biến (mặt trong lật gương U, Yêu cầu 5.3/5.4)', () => {
        // Dùng chế độ per-face: khung tham chiếu là bbox riêng của panel nên
        // uBase trải đủ [0,1]; đỉnh biên có uBase=0/1 ⇒ chắc chắn khác mặt trong.
        // (Ở aligned-to-dieline, nếu globalBBox lớn hơn nhiều so với panel thì
        //  mọi uBase dồn quanh 0.5 và phép lật gương không tạo khác biệt đáng kể.)
        fc.assert(
            fc.property(panelArb, transformArb, (panel, transform) => {
                const outline = panel.outline!;
                const globalBBox = bboxCovering(outline);

                // Không suy biến: tồn tại ít nhất hai đỉnh có hoành độ X khác nhau.
                const xs = outline.map((p) => p.x);
                const hasDistinctX = Math.max(...xs) - Math.min(...xs) > EPS;
                fc.pre(hasDistinctX);

                const outer = computePanelUV(panel, 'per-face', transform, globalBBox, 'outer');
                const inner = computePanelUV(panel, 'per-face', transform, globalBBox, 'inner');

                // Phải tồn tại ít nhất một đỉnh có U mặt ngoài khác U mặt trong.
                let differs = false;
                for (let i = 0; i < outline.length; i++) {
                    if (Math.abs(outer[i * 2] - inner[i * 2]) > 1e-6) {
                        differs = true;
                        break;
                    }
                }
                expect(differs).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });
});
