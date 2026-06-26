// ============================================================
// Unit test — màu cạnh mặc định kraft (panelSolid)
//
// Kiểm tra ví dụ giá trị mặc định màu cạnh giấy khi không chỉ định:
//   - Hằng `DEFAULT_EDGE_COLOR` bằng 'kraft'.
//   - `normalizeEdgeColor(undefined)` trả về 'kraft' (mặc định khi
//     màu cạnh không được chỉ định).
//
// Đây là test ví dụ (example) nên dùng hậu tố `.test.ts`.
// _Requirements: 1.2_
// ============================================================

import { describe, it, expect } from 'vitest';
import { DEFAULT_EDGE_COLOR, normalizeEdgeColor } from '../panelSolid';

describe('panelSolid — màu cạnh mặc định kraft', () => {
    it('DEFAULT_EDGE_COLOR là kraft', () => {
        expect(DEFAULT_EDGE_COLOR).toBe('kraft');
    });

    it('normalizeEdgeColor(undefined) trả về kraft khi không chỉ định', () => {
        expect(normalizeEdgeColor(undefined)).toBe('kraft');
    });

    it('màu mặc định khi không chỉ định khớp với DEFAULT_EDGE_COLOR', () => {
        expect(normalizeEdgeColor(undefined)).toBe(DEFAULT_EDGE_COLOR);
    });
});
