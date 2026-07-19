// ============================================================
// dieGap Doc Static Test — Cập nhật chú thích `dieGap` (Requirement 8.3)
//
// Xác minh nội dung JSDoc của thuộc tính `dieGap` trong
// nestingTypes.ts sau khi đã cập nhật ở task 9.1:
//   1. JSDoc `dieGap` MÔ TẢ Polygon_Offset thực — đẩy mỗi cạnh của
//      đường biên (outline) mỗi khuôn ra ngoài theo pháp tuyến một
//      lượng bằng `dieGap`.
//   2. KHÔNG còn cụm ghi chú "known limitation Giai đoạn 2" liên
//      quan đến offset polygon.
//
// Đây là EXAMPLE/static test: đọc nguồn tĩnh, không sinh hình học
// và không thay đổi hành vi runtime.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Đọc nguồn nestingTypes.ts một cách bền vững với thư mục làm việc:
 *   1. Resolve theo import.meta.url (file cạnh test).
 *   2. Dự phòng: các ứng viên theo process.cwd().
 */
function readNestingTypesSource(): string {
    const candidates: string[] = [];

    // (1) Sibling resolve theo vị trí file test
    try {
        candidates.push(fileURLToPath(new URL('./nestingTypes.ts', import.meta.url)));
    } catch {
        // bỏ qua nếu import.meta.url không resolve được
    }

    // (2) Dự phòng theo cwd
    candidates.push(resolve(process.cwd(), 'src/lib/dieline/nestingTypes.ts'));
    candidates.push(resolve(process.cwd(), 'desktop/src/lib/dieline/nestingTypes.ts'));

    for (const path of candidates) {
        if (existsSync(path)) {
            return readFileSync(path, 'utf-8');
        }
    }

    throw new Error(
        `Không tìm thấy nestingTypes.ts trong các ứng viên:\n${candidates.join('\n')}`,
    );
}

/**
 * Trích đoạn JSDoc nằm ngay trước khai báo thuộc tính `dieGap`.
 * Trả về chuỗi rỗng nếu không tìm được, để các assertion nội dung
 * thất bại một cách rõ ràng.
 */
function extractDieGapDoc(src: string): string {
    // Bắt khối /** ... */ ngay trước `dieGap`
    const match = src.match(/\/\*\*([\s\S]*?)\*\/\s*dieGap:\s*number;/);
    return match ? match[1] : '';
}

describe('dieGap doc static test (Requirement 8.3)', () => {
    const src = readNestingTypesSource();
    const dieGapDoc = extractDieGapDoc(src);

    it('khai báo thuộc tính dieGap vẫn tồn tại', () => {
        expect(src).toMatch(/dieGap:\s*number;/);
    });

    it('JSDoc dieGap mô tả khoảng hở tối thiểu trên CUT thật', () => {
        // Đoạn JSDoc phải gắn trực tiếp vào thuộc tính dieGap
        expect(dieGapDoc.length).toBeGreaterThan(0);
        // Hợp đồng mới: khoảng hở tối thiểu được kiểm tra trên CUT thật.
        expect(dieGapDoc).toMatch(/khoảng hở dao bế tối thiểu/i);
        expect(dieGapDoc).toMatch(/silhouette thực/i);
        expect(dieGapDoc).toMatch(/CUT/i);
    });

    it('KHÔNG còn ghi chú "known limitation Giai đoạn 2"', () => {
        expect(src).not.toMatch(/known limitation/i);
        expect(dieGapDoc).not.toMatch(/known limitation/i);
    });
});
