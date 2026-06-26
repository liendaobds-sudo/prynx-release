// ============================================================
// Property test — artworkMapping.computePanelUV (chế độ per-face)
//
// Feature: mockup-3d-realism, Property 13: Đặt ảnh per-face độc lập giữa các mặt
// **Validates: Requirements 5.1**
//
// Trong chế độ `per-face`, UV của một panel chỉ phụ thuộc vào bounding
// box RIÊNG của outline panel đó (cùng `transform` và `faceSide`), KHÔNG
// phụ thuộc vào `globalBBox` của toàn dieline. Vì vậy thay đổi tùy ý
// `globalBBox` không làm đổi kết quả UV của cùng một panel — mỗi mặt được
// ánh xạ độc lập với các mặt khác.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computePanelUV, type FaceSide } from '../artworkMapping';
import type { ArtworkTransform, BBox, Panel, Point2D } from '../types';

const NUM_RUNS = 100;

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
    };
}

/** Generator BBox bất kỳ (kể cả suy biến / lệch min-max). */
const bboxArb: fc.Arbitrary<BBox> = fc
    .record({ a: coordArb, b: coordArb, c: coordArb, d: coordArb })
    .map(({ a, b, c, d }) => {
        const minX = Math.min(a, b);
        const maxX = Math.max(a, b);
        const minY = Math.min(c, d);
        const maxY = Math.max(c, d);
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    });

/** Transform hợp lệ trong miền (computePanelUV vẫn clamp nội bộ). */
const transformArb: fc.Arbitrary<ArtworkTransform> = fc.record({
    scalePct: fc.double({ min: 10, max: 1000, noNaN: true }),
    offsetXPct: fc.double({ min: -100, max: 100, noNaN: true }),
    offsetYPct: fc.double({ min: -100, max: 100, noNaN: true }),
});

const faceSideArb: fc.Arbitrary<FaceSide> = fc.constantFrom<FaceSide>('outer', 'inner');

describe('computePanelUV (per-face) — Property 13: Đặt ảnh per-face độc lập giữa các mặt', () => {
    it('UV per-face không phụ thuộc globalBBox (Yêu cầu 5.1)', () => {
        fc.assert(
            fc.property(
                outlineArb,
                transformArb,
                faceSideArb,
                bboxArb,
                bboxArb,
                (outline, transform, faceSide, globalBBoxA, globalBBoxB) => {
                    const panel = makePanel(outline);

                    const uvA = computePanelUV(panel, 'per-face', transform, globalBBoxA, faceSide);
                    const uvB = computePanelUV(panel, 'per-face', transform, globalBBoxB, faceSide);

                    expect(uvA.length).toBe(outline.length * 2);
                    expect(uvB.length).toBe(uvA.length);
                    for (let i = 0; i < uvA.length; i++) {
                        // Phải bằng tuyệt đối: per-face hoàn toàn bỏ qua globalBBox.
                        expect(uvB[i]).toBe(uvA[i]);
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('thay đổi globalBBox tùy ý không đổi UV per-face (kiểm chéo nhiều globalBBox)', () => {
        fc.assert(
            fc.property(
                outlineArb,
                transformArb,
                faceSideArb,
                fc.array(bboxArb, { minLength: 2, maxLength: 5 }),
                (outline, transform, faceSide, globalBBoxes) => {
                    const panel = makePanel(outline);
                    const baseline = computePanelUV(
                        panel,
                        'per-face',
                        transform,
                        globalBBoxes[0],
                        faceSide,
                    );
                    for (const gbb of globalBBoxes) {
                        const uv = computePanelUV(panel, 'per-face', transform, gbb, faceSide);
                        expect(uv.length).toBe(baseline.length);
                        for (let i = 0; i < baseline.length; i++) {
                            expect(uv[i]).toBe(baseline[i]);
                        }
                    }
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });
});
