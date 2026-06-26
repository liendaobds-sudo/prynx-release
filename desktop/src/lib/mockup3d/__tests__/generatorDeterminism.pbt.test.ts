// ============================================================
// Property test — Generator byte-identical / tất định
//
// Feature: mockup-3d-realism, Property 22: Generator giữ tính tất định
// và không hồi quy.
// **Validates: Requirements 9.1**
//
// For any bộ tham số `BoxParams` hợp lệ, đầu ra của mỗi generator phải
// GIỐNG HỆT khi sinh hai lần với cùng đầu vào:
//   - deeply-equal (toEqual) trên toàn bộ cấu trúc DielineModel, VÀ
//   - chuỗi JSON tuần tự hóa identical (char-for-char).
//
// Đây là điều kiện cần của ràng buộc "byte-identical" (Yêu cầu 9.1):
// generator phải thuần/tất định, không phụ thuộc trạng thái ẩn (random,
// thời gian, thứ tự duyệt Map/Set không ổn định, ...). Khung xem 3D mới
// KHÔNG được sửa generator; test này khoá tính tất định đó.
//
// Mỗi property chạy tối thiểu 100 iteration trên từng generator.
// ============================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { BoxParams, DielineModel } from '../../dieline/types';
import { arbBoxParams, GeneratorBoxType } from '../../dieline/arbitraries';
import {
    generateReverseTuckEnd,
    generateSnapLockBottom,
    generateGableBox,
    generatePaperBag,
    generateCupSleeve,
    generatePizzaBox,
    generateEnvelope,
    generateMatchboxTray,
} from '../../dieline';

const NUM_RUNS = 100;

/** 8 generator công khai ↔ boxType. Chạy riêng để counterexample chỉ rõ tên. */
const GENERATORS: { boxType: GeneratorBoxType; name: string; generate: (p: BoxParams) => DielineModel }[] = [
    { boxType: 'rte', name: 'generateReverseTuckEnd', generate: generateReverseTuckEnd },
    { boxType: 'slb', name: 'generateSnapLockBottom', generate: generateSnapLockBottom },
    { boxType: 'gable', name: 'generateGableBox', generate: generateGableBox },
    { boxType: 'paper_bag', name: 'generatePaperBag', generate: generatePaperBag },
    { boxType: 'cup_sleeve', name: 'generateCupSleeve', generate: generateCupSleeve },
    { boxType: 'pizza', name: 'generatePizzaBox', generate: generatePizzaBox },
    { boxType: 'envelope', name: 'generateEnvelope', generate: generateEnvelope },
    { boxType: 'tray', name: 'generateMatchboxTray', generate: generateMatchboxTray },
];

describe('Property 22: Generator tất định & byte-identical giữa các lần chạy (Req 9.1)', () => {
    for (const g of GENERATORS) {
        it(`${g.name}: sinh hai lần cùng params cho output deeply-equal`, () => {
            fc.assert(
                fc.property(arbBoxParams(g.boxType), (params: BoxParams) => {
                    const first = g.generate(params);
                    const second = g.generate(params);
                    expect(second).toEqual(first);
                }),
                { numRuns: NUM_RUNS },
            );
        });

        it(`${g.name}: JSON tuần tự hóa identical giữa hai lần chạy`, () => {
            fc.assert(
                fc.property(arbBoxParams(g.boxType), (params: BoxParams) => {
                    const first = JSON.stringify(g.generate(params));
                    const second = JSON.stringify(g.generate(params));
                    expect(second).toBe(first);
                }),
                { numRuns: NUM_RUNS },
            );
        });
    }
});
