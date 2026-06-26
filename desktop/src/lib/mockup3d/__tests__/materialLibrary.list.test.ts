// ============================================================
// materialLibrary.list.test.ts — Mockup 3D Realism
//
// Unit test (ví dụ) cho danh sách thư viện finish (Yêu cầu 4.1):
//   - `FINISH_LIBRARY` có tối thiểu 6 mục.
//   - Mỗi mục có `id` khớp với key của nó trong record.
//   - `getFinish(id)` trả về đúng spec cho từng id.
//   - Bao phủ 6 finish bắt buộc theo đặc tả: kraft, SBS trắng,
//     cán mờ, cán bóng, spot-UV, foil/metallic.
//
// Đây là test ví dụ (example) nên dùng hậu tố `.test.ts`.
// _Requirements: 4.1_
// ============================================================

import { describe, it, expect } from 'vitest';
import { FINISH_LIBRARY, getFinish } from '../materialLibrary';
import type { FinishId } from '../types';

describe('materialLibrary — danh sách finish (≥6 mục)', () => {
    const entries = Object.entries(FINISH_LIBRARY) as [FinishId, (typeof FINISH_LIBRARY)[FinishId]][];

    it('FINISH_LIBRARY có tối thiểu 6 mục', () => {
        expect(entries.length).toBeGreaterThanOrEqual(6);
    });

    it('mỗi mục có id khớp với key của nó trong record', () => {
        for (const [key, spec] of entries) {
            expect(spec.id).toBe(key);
        }
    });

    it('getFinish(id) trả về đúng spec cho từng id', () => {
        for (const [key, spec] of entries) {
            expect(getFinish(key)).toBe(spec);
            expect(getFinish(key).id).toBe(key);
        }
    });

    it('bao phủ tối thiểu 6 finish bắt buộc theo Yêu cầu 4.1', () => {
        const required: FinishId[] = [
            'kraft',
            'sbs-white',
            'matte-lam',
            'gloss-lam',
            'spot-uv',
            'foil-metallic',
        ];
        for (const id of required) {
            expect(FINISH_LIBRARY[id]).toBeDefined();
            expect(FINISH_LIBRARY[id].id).toBe(id);
        }
    });
});
