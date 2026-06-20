// ============================================================
// dieGap Doc Static Test — Sửa chú thích `dieGap` (Requirement 6.1–6.3)
//
// Xác minh nội dung JSDoc của thuộc tính `dieGap` trong
// nestingTypes.ts sau khi đã cập nhật ở task 9.1:
//   1. (6.1) KHÔNG còn cụm mô tả "offset polygon ra ngoài mỗi bên".
//   2. (6.2) CÓ mô tả `dieGap` là khoảng hở giữa bounding box của
//      hai khuôn liền kề.
//   3. (6.3) CÓ ghi chú offset polygon thực là known limitation,
//      dự kiến xử lý ở Giai đoạn 2.
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

describe('dieGap doc static test (Requirement 6.1–6.3)', () => {
    const src = readNestingTypesSource();

    it('(6.1) KHÔNG còn cụm mô tả "offset polygon ra ngoài mỗi bên"', () => {
        expect(src).not.toContain('offset polygon ra ngoài mỗi bên');
    });

    it('(6.2) mô tả dieGap là khoảng hở giữa bounding box của hai khuôn liền kề', () => {
        // Chú thích phải nêu cả "bounding box" lẫn khái niệm khoảng hở (gap)
        expect(src).toMatch(/bounding box/i);
        expect(src).toMatch(/khoảng hở/i);
        // Gắn ngữ cảnh hai khuôn liền kề
        expect(src).toMatch(/hai khuôn liền kề/i);
    });

    it('(6.3) ghi chú offset polygon thực là known limitation Giai đoạn 2', () => {
        expect(src).toMatch(/known limitation/i);
        expect(src).toMatch(/Giai đoạn 2/i);
        // Đề cập rõ "offset polygon thực" như giới hạn chưa hiện thực
        expect(src).toMatch(/offset polygon thực/i);
    });

    it('chú thích nằm ngay trước khai báo thuộc tính dieGap', () => {
        // Đảm bảo các cụm chú thích nói trên thuộc về thuộc tính dieGap
        // (khai báo `dieGap: number;` vẫn tồn tại).
        expect(src).toMatch(/dieGap:\s*number;/);
    });
});
