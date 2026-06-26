// ============================================================
// maskValidation.pbt.test.ts — Mockup 3D Realism
//
// Property-based test (fast-check + vitest) cho xác thực mặt nạ.
//
// Feature: mockup-3d-realism, Property 12: Xác thực mặt nạ
//
// Validates: Requirements 4.6
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    validateMask,
    VALID_MASK_FORMATS,
    type MaskInfo,
    type SurfaceInfo,
} from '../maskValidation';

// Các định dạng hợp lệ (lấy trực tiếp từ tập định dạng của module).
const validFormats = Array.from(VALID_MASK_FORMATS);

// Generator kích thước dương hữu hạn hợp lệ.
const positiveDim = fc.integer({ min: 1, max: 16384 });

describe('validateMask — Property 12: Xác thực mặt nạ', () => {
    it('định dạng hợp lệ + kích thước khớp bề mặt → valid:true', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...validFormats),
                positiveDim,
                positiveDim,
                (format, width, height) => {
                    const mask: MaskInfo = { width, height, format };
                    const surface: SurfaceInfo = { width, height };
                    const result = validateMask(mask, surface);
                    expect(result.valid).toBe(true);
                    expect(result.reason).toBeUndefined();
                },
            ),
            { numRuns: 200 },
        );
    });

    it('định dạng hợp lệ nhưng kích thước lệch bề mặt → valid:false kèm reason', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...validFormats),
                positiveDim,
                positiveDim,
                positiveDim,
                positiveDim,
                (format, mw, mh, sw, sh) => {
                    // Chỉ giữ các tổ hợp thực sự lệch ít nhất một chiều.
                    fc.pre(mw !== sw || mh !== sh);
                    const mask: MaskInfo = { width: mw, height: mh, format };
                    const surface: SurfaceInfo = { width: sw, height: sh };
                    const result = validateMask(mask, surface);
                    expect(result.valid).toBe(false);
                    expect(typeof result.reason).toBe('string');
                    expect((result.reason ?? '').length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 200 },
        );
    });

    it('định dạng không hợp lệ → valid:false (bất kể kích thước)', () => {
        // Chuỗi tùy ý không thuộc tập định dạng hợp lệ.
        const invalidFormat = fc
            .string()
            .filter((s) => !VALID_MASK_FORMATS.has(s.trim().toLowerCase()));
        fc.assert(
            fc.property(
                invalidFormat,
                positiveDim,
                positiveDim,
                (format, width, height) => {
                    const mask: MaskInfo = { width, height, format };
                    const surface: SurfaceInfo = { width, height };
                    const result = validateMask(mask, surface);
                    expect(result.valid).toBe(false);
                    expect(typeof result.reason).toBe('string');
                },
            ),
            { numRuns: 200 },
        );
    });

    it('không bao giờ ném exception với đầu vào bất kỳ', () => {
        const anyNumber = fc.oneof(
            fc.integer(),
            fc.double(),
            fc.constant(Number.NaN),
            fc.constant(Number.POSITIVE_INFINITY),
            fc.constant(Number.NEGATIVE_INFINITY),
            fc.constant(0),
        );
        const maskArb = fc.oneof(
            fc.constant(null),
            fc.record({
                width: anyNumber,
                height: anyNumber,
                format: fc.string(),
            }),
        );
        const surfaceArb = fc.record({
            width: anyNumber,
            height: anyNumber,
        });
        fc.assert(
            fc.property(maskArb, surfaceArb, (mask, surface) => {
                const result = validateMask(
                    mask as MaskInfo | null,
                    surface as SurfaceInfo,
                );
                // Luôn trả về object có trường boolean `valid`.
                expect(typeof result.valid).toBe('boolean');
            }),
            { numRuns: 200 },
        );
    });
});
