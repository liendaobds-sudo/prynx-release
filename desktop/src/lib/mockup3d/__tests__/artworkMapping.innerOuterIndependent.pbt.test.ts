// ============================================================
// Property test — artworkMapping.computePanelUV (mặt trong vs mặt ngoài)
//
// Feature: mockup-3d-realism, Property 16: Cấu hình mặt trong và mặt ngoài độc lập
// **Validates: Requirements 5.4**
//
// `computePanelUV` tính UV độc lập cho mỗi mặt (`faceSide`):
//  - Mặt trong (`inner`) lật gương trục U (1 - uBase), nên với panel KHÔNG
//    suy biến (tồn tại đỉnh có hoành độ X khác nhau) tập UV của mặt ngoài
//    và mặt trong khác nhau.
//  - Việc tính UV cho một mặt với một `transform` không phụ thuộc và không
//    bị ảnh hưởng bởi cấu hình (transform/ảnh) của mặt còn lại: mỗi lời gọi
//    nhận đúng `transform` của nó và sinh kết quả độc lập (hàm thuần).
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computePanelUV, type FaceSide } from '../artworkMapping';
import type { ArtworkTransform, BBox, Panel, PlacementMode, Point2D } from '../types';

const NUM_RUNS = 200;
const EPS = 1e-6;

/** Tọa độ điểm hữu hạn trong miền rộng (mm). */
const coordArb: fc.Arbitrary<number> = fc.double({ min: -1000, max: 1000, noNaN: true });

/** Một điểm 2D. */
const pointArb: fc.Arbitrary<Point2D> = fc.record({ x: coordArb, y: coordArb });

/** Outline panel: ≥3 đỉnh để tạo một mặt có diện tích. */
const outlineArb: fc.Arbitrary<Point2D[]> = fc.array(pointArb, { minLength: 3, maxLength: 12 });

/** Tạo một Panel tối thiểu với outline cho trước. */
function makePanel(outline: Point2D[]): Panel {
    return {
        name: 'face',
        label: 'Mặt',
        paths: [],
        outline,
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
    } as unknown as Panel;
}

/** Transform hợp lệ trong miền (computePanelUV vẫn clamp nội bộ). */
const transformArb: fc.Arbitrary<ArtworkTransform> = fc.record({
    scalePct: fc.double({ min: 10, max: 1000, noNaN: true }),
    offsetXPct: fc.double({ min: -100, max: 100, noNaN: true }),
    offsetYPct: fc.double({ min: -100, max: 100, noNaN: true }),
});

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
    minX -= 1;
    minY -= 1;
    maxX += 1;
    maxY += 1;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

describe('computePanelUV (mặt trong/mặt ngoài) — Property 16: Cấu hình mặt trong và mặt ngoài độc lập', () => {
    it('mặt trong lật gương U ⇒ tập UV mặt ngoài khác mặt trong cho panel không suy biến (Yêu cầu 5.4)', () => {
        // Dùng chế độ per-face để uBase trải đủ [0,1]; đỉnh biên có uBase=0/1
        // nên phép lật gương (1-uBase) chắc chắn tạo khác biệt.
        fc.assert(
            fc.property(outlineArb, transformArb, (outline, transform) => {
                const panel = makePanel(outline);
                const globalBBox = bboxCovering(outline);

                // Không suy biến: tồn tại hai đỉnh có hoành độ X khác nhau.
                const xs = outline.map((p) => p.x);
                fc.pre(Math.max(...xs) - Math.min(...xs) > EPS);

                const outer = computePanelUV(panel, 'per-face', transform, globalBBox, 'outer');
                const inner = computePanelUV(panel, 'per-face', transform, globalBBox, 'inner');

                expect(inner.length).toBe(outer.length);

                let differs = false;
                for (let i = 0; i < outline.length; i++) {
                    if (Math.abs(outer[i * 2] - inner[i * 2]) > EPS) {
                        differs = true;
                        break;
                    }
                }
                expect(differs).toBe(true);
            }),
            { numRuns: NUM_RUNS },
        );
    });

    it('tính UV mặt trong không bị ảnh hưởng bởi transform của mặt ngoài (độc lập per-call, Yêu cầu 5.4)', () => {
        fc.assert(
            fc.property(
                outlineArb,
                modeArb,
                transformArb, // transform mặt trong
                transformArb, // transform mặt ngoài #1
                transformArb, // transform mặt ngoài #2
                (outline, mode, innerTransform, outerTransformA, outerTransformB) => {
                    const panel = makePanel(outline);
                    const globalBBox = bboxCovering(outline);

                    // Tính mặt trong với transform riêng của nó.
                    const innerBaseline = computePanelUV(
                        panel,
                        mode,
                        innerTransform,
                        globalBBox,
                        'inner' as FaceSide,
                    );

                    // Thực hiện các phép tính mặt ngoài với transform khác nhau
                    // (mô phỏng người dùng thay đổi cấu hình mặt ngoài).
                    computePanelUV(panel, mode, outerTransformA, globalBBox, 'outer');
                    computePanelUV(panel, mode, outerTransformB, globalBBox, 'outer');

                    // Tính lại mặt trong với chính transform của nó: phải giống hệt
                    // baseline — cấu hình mặt ngoài không hề ảnh hưởng mặt trong.
                    const innerAfter = computePanelUV(
                        panel,
                        mode,
                        innerTransform,
                        globalBBox,
                        'inner' as FaceSide,
                    );

                    expect(innerAfter.length).toBe(innerBaseline.length);
                    for (let i = 0; i < innerBaseline.length; i++) {
                        expect(innerAfter[i]).toBe(innerBaseline[i]);
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('đối xứng: tính UV mặt ngoài không bị ảnh hưởng bởi transform của mặt trong', () => {
        fc.assert(
            fc.property(
                outlineArb,
                modeArb,
                transformArb, // transform mặt ngoài
                transformArb, // transform mặt trong #1
                transformArb, // transform mặt trong #2
                (outline, mode, outerTransform, innerTransformA, innerTransformB) => {
                    const panel = makePanel(outline);
                    const globalBBox = bboxCovering(outline);

                    const outerBaseline = computePanelUV(
                        panel,
                        mode,
                        outerTransform,
                        globalBBox,
                        'outer' as FaceSide,
                    );

                    computePanelUV(panel, mode, innerTransformA, globalBBox, 'inner');
                    computePanelUV(panel, mode, innerTransformB, globalBBox, 'inner');

                    const outerAfter = computePanelUV(
                        panel,
                        mode,
                        outerTransform,
                        globalBBox,
                        'outer' as FaceSide,
                    );

                    expect(outerAfter.length).toBe(outerBaseline.length);
                    for (let i = 0; i < outerBaseline.length; i++) {
                        expect(outerAfter[i]).toBe(outerBaseline[i]);
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
