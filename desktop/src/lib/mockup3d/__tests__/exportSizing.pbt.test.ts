// ============================================================
// Property test — exportSizing.computeExportSize
//
// Feature: mockup-3d-realism, Property 18: Giới hạn kích thước xuất ảnh
// **Validates: Requirements 6.4**
//
// For any kích thước khung xem (viewW, viewH) và hệ số phóng đại
// scale ∈ {1, 2, 4}:
//   - khi viewW*scale ≤ 16384 VÀ viewH*scale ≤ 16384 → ok = true với
//     width = viewW*scale, height = viewH*scale (Yêu cầu 6.4),
//   - khi width hoặc height vượt 16384 → ok = false kèm `reason`,
//   - khi kích thước khung xem không hợp lệ (≤ 0, NaN, ±Infinity) →
//     ok = false kèm `reason`.
//
// Mỗi property chạy tối thiểu 100 iteration.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeExportSize, flipWebGlPixelRows, MAX_EXPORT_PIXELS, MAX_EXPORT_PX } from '../exportSizing';
import type { ExportScale } from '../types';

const NUM_RUNS = 200;

const scaleArb = fc.constantFrom<ExportScale>(1, 2, 4);

describe('computeExportSize — Property 18: Giới hạn kích thước xuất ảnh', () => {
    it('cả hai chiều ≤ 16384 sau khi nhân hệ số → ok = true, width/height đúng (Yêu cầu 6.4)', () => {
        fc.assert(
            fc.property(
                scaleArb,
                // tỉ lệ trong (0, 1] để bảo đảm dim*scale ≤ MAX_EXPORT_PX
                fc.double({ min: 1e-6, max: 1, noNaN: true }).filter((r) => r > 0 && r <= 1),
                fc.double({ min: 1e-6, max: 1, noNaN: true }).filter((r) => r > 0 && r <= 1),
                (scale, ratioW, ratioH) => {
                    const viewW = (MAX_EXPORT_PX / scale) * ratioW;
                    const viewH = (MAX_EXPORT_PX / scale) * ratioH;

                    // Tiền đề: hợp lệ và nằm trong giới hạn sau khi nhân hệ số.
                    fc.pre(viewW > 0 && viewH > 0);
                    fc.pre(viewW * scale <= MAX_EXPORT_PX && viewH * scale <= MAX_EXPORT_PX);
                    fc.pre(viewW * scale * viewH * scale <= MAX_EXPORT_PIXELS);

                    const result = computeExportSize(viewW, viewH, scale);
                    expect(result.ok).toBe(true);
                    expect(result.width).toBe(viewW * scale);
                    expect(result.height).toBe(viewH * scale);
                    expect(result.reason).toBeUndefined();
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('một trong hai chiều vượt 16384 → ok = false kèm reason', () => {
        fc.assert(
            fc.property(
                scaleArb,
                // ít nhất một chiều vượt giới hạn sau khi nhân hệ số
                fc.double({ min: 1e-3, max: 1e9, noNaN: true }).filter((d) => d > 0),
                fc.double({ min: 1e-3, max: 1e9, noNaN: true }).filter((d) => d > 0),
                fc.boolean(),
                (scale, baseDim, otherDim, exceedWidth) => {
                    // Buộc một chiều vượt giới hạn: chọn giá trị > MAX/scale.
                    const exceeding = MAX_EXPORT_PX / scale + baseDim;
                    const viewW = exceedWidth ? exceeding : otherDim;
                    const viewH = exceedWidth ? otherDim : exceeding;

                    const result = computeExportSize(viewW, viewH, scale);
                    const width = viewW * scale;
                    const height = viewH * scale;

                    // Tiền đề: thực sự có ít nhất một chiều vượt giới hạn.
                    fc.pre(width > MAX_EXPORT_PX || height > MAX_EXPORT_PX);

                    expect(result.ok).toBe(false);
                    expect(typeof result.reason).toBe('string');
                    expect((result.reason as string).length).toBeGreaterThan(0);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('kích thước khung xem không hợp lệ (≤ 0 / NaN / ±Infinity) → ok = false kèm reason', () => {
        const invalidDim = fc.oneof(
            fc.double({ min: -1e6, max: 0, noNaN: true }), // ≤ 0
            fc.constant(NaN),
            fc.constant(Number.POSITIVE_INFINITY),
            fc.constant(Number.NEGATIVE_INFINITY),
        );
        const validDim = fc.double({ min: 1e-3, max: 1000, noNaN: true }).filter((d) => d > 0);

        fc.assert(
            fc.property(
                scaleArb,
                // ít nhất một trong hai chiều không hợp lệ
                fc.oneof(
                    fc.tuple(invalidDim, validDim),
                    fc.tuple(validDim, invalidDim),
                    fc.tuple(invalidDim, invalidDim),
                ),
                (scale, [viewW, viewH]) => {
                    const result = computeExportSize(viewW, viewH, scale);
                    expect(result.ok).toBe(false);
                    expect(typeof result.reason).toBe('string');
                    expect((result.reason as string).length).toBeGreaterThan(0);
                },
            ),
            { numRuns: NUM_RUNS },
        );
    });

    it('rejects aggregate pixel counts and device-specific texture limits', () => {
        expect(computeExportSize(8000, 6000, 1).ok).toBe(false);
        expect(computeExportSize(5000, 100, 1, 4096).ok).toBe(false);
        expect(computeExportSize(1920, 1080, 4).ok).toBe(true);
    });

    it('preserves pixels while converting WebGL row order for Canvas', () => {
        const bottomRow = [1, 2, 3, 4, 5, 6, 7, 8];
        const topRow = [9, 10, 11, 12, 13, 14, 15, 16];
        const flipped = flipWebGlPixelRows(new Uint8Array([...bottomRow, ...topRow]), 2, 2);
        expect(Array.from(flipped)).toEqual([...topRow, ...bottomRow]);
    });
});
