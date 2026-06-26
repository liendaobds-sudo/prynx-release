// ============================================================
// materialLibrary.pbr.pbt.test.ts — Mockup 3D Realism
//
// Property-based test (fast-check + vitest) cho miền PBR của finish.
//
// Feature: mockup-3d-realism, Property 8: Giá trị PBR của mọi finish
// nằm trong miền hợp lệ
//
// Validates: Requirements 4.2
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FINISH_LIBRARY, getFinish } from '../materialLibrary';
import type { FinishId } from '../types';

describe('materialLibrary — Property 8: miền PBR của finish', () => {
    // Tập tất cả id finish hợp lệ lấy trực tiếp từ thư viện.
    const finishIds = Object.keys(FINISH_LIBRARY) as FinishId[];

    it('getFinish(id) trả về roughness và metalness trong [0.0, 1.0] cho mọi finish', () => {
        fc.assert(
            fc.property(fc.constantFrom(...finishIds), (id) => {
                const spec = getFinish(id);

                // roughness ∈ [0.0, 1.0]
                expect(Number.isFinite(spec.roughness)).toBe(true);
                expect(spec.roughness).toBeGreaterThanOrEqual(0.0);
                expect(spec.roughness).toBeLessThanOrEqual(1.0);

                // metalness ∈ [0.0, 1.0]
                expect(Number.isFinite(spec.metalness)).toBe(true);
                expect(spec.metalness).toBeGreaterThanOrEqual(0.0);
                expect(spec.metalness).toBeLessThanOrEqual(1.0);
            }),
            { numRuns: 100 },
        );
    });
});
