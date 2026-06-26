// ============================================================
// Scaffold test — lib/mockup3d
//
// Xác nhận khung logic layer được thiết lập đúng: barrel export
// và các kiểu cục bộ biên dịch + dùng được. Đây là test ví dụ
// (không phải property test) nên dùng hậu tố `.test.ts`.
// _Requirements: 9.2_
// ============================================================

import { describe, it, expect } from 'vitest';
import * as mockup3d from '../index';
import type {
    BBox,
    EdgeColor,
    PlacementMode,
    ArtworkTransform,
    FinishId,
    ExportScale,
    // Re-export read-only từ generator hiện có (không sửa types gốc).
    Panel,
    DielineModel,
    BoxParams,
} from '../index';

describe('lib/mockup3d scaffold', () => {
    it('barrel export là một module hợp lệ', () => {
        expect(mockup3d).toBeTypeOf('object');
    });

    it('các kiểu cục bộ dùng được và đúng hình dạng', () => {
        const bbox: BBox = { minX: 0, minY: 0, maxX: 10, maxY: 20, width: 10, height: 20 };
        const edge: EdgeColor = 'kraft';
        const mode: PlacementMode = 'aligned-to-dieline';
        const transform: ArtworkTransform = { scalePct: 100, offsetXPct: 0, offsetYPct: 0 };
        const finish: FinishId = 'gloss-lam';
        const scale: ExportScale = 2;

        expect(bbox.width).toBe(10);
        expect(edge).toBe('kraft');
        expect(mode).toBe('aligned-to-dieline');
        expect(transform.scalePct).toBe(100);
        expect(finish).toBe('gloss-lam');
        expect(scale).toBe(2);
    });

    it('re-export kiểu lõi từ generator ở dạng read-only', () => {
        // Chỉ kiểm tra mức kiểu (compile-time). Gán biến kiểu để buộc
        // trình biên dịch xác nhận các kiểu re-export tồn tại và khớp.
        const panelName: Panel['name'] = 'front';
        const modelName: DielineModel['name'] = 'rte';
        const length: BoxParams['L'] = 100;

        expect(panelName).toBe('front');
        expect(modelName).toBe('rte');
        expect(length).toBe(100);
    });
});
