// ============================================================
// materialLibrary.uniformFinish.pbt.test.ts — Mockup 3D Realism
//
// Property-based test (fast-check + vitest) cho việc áp finish ĐỒNG NHẤT
// lên toàn bộ panel của hộp.
//
// Feature: mockup-3d-realism, Property 9: Finish áp dụng đồng nhất cho
// toàn bộ panel
//
// Validates: Requirements 4.4
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FINISH_LIBRARY, getFinish, applyFinishToAllPanels } from '../materialLibrary';
import type { FinishId, Panel } from '../types';

describe('materialLibrary — Property 9: finish đồng nhất toàn panel', () => {
    const finishIds = Object.keys(FINISH_LIBRARY) as FinishId[];

    // Generator panel tối thiểu (panel-shaped): chỉ cần đủ để đại diện một
    // phần tử trong mảng panel. `applyFinishToAllPanels` không phụ thuộc nội
    // dung panel (độc lập tên/hình học), nên đối tượng tối thiểu là đủ.
    const arbPanel = fc.record({
        name: fc.string(),
    }) as fc.Arbitrary<Panel>;

    it('trả về mảng cùng độ dài và mọi phần tử bằng getFinish(id) (đồng nhất)', () => {
        fc.assert(
            fc.property(
                fc.array(arbPanel, { maxLength: 30 }),
                fc.constantFrom(...finishIds),
                (panels, id) => {
                    const result = applyFinishToAllPanels(panels, id);
                    const expected = getFinish(id);

                    // Cùng độ dài với mảng panel đầu vào.
                    expect(result).toHaveLength(panels.length);

                    // Mọi phần tử là cùng một finish đã chọn (đồng nhất).
                    for (const spec of result) {
                        expect(spec).toBe(expected);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});
