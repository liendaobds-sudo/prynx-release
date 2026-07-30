// ============================================================
// Parity TS ↔ Rust cho lưới N-up — KIENTRUC (audit 2026-07-29 §B.1)
//
// Vì sao test này tồn tại: cùng một thuật toán lưới sống ở 4 nơi (Rust
// `imposition_core::grid` = nguồn chân lý, wrapper PyO3, fallback Python, và bản TS này).
// Đường XUẤT FILE đã hợp nhất về Rust (Task 11), nhưng bản TS vẫn được `ProductAdvisor`
// gọi để trả lời "1 tờ mấy con" cho người dùng — và chính docstring của
// `solveOptimalNupLayout` thừa nhận bản TS ĐÃ drift (thiếu nhánh 'ARROW' mà Rust có).
// Tư vấn lệch với tờ in thật là loại lỗi thợ chỉ phát hiện sau khi đã tin con số.
//
// Cơ chế: fixture JSON dùng chung với test Rust `imposition_core/tests/grid_parity.rs`.
// Hai bên cùng đối chiếu một file nên parity được bảo đảm bắc cầu, không cần toolchain
// Rust trong vitest.
//
// Phạm vi: chỉ `strategy = 'simple_auto'` — strategy duy nhất `ProductAdvisor` dùng và là
// phần chung chắc chắn của hai bản. Nhánh shape (`optimal_auto`) chỉ còn trên đường legacy
// phía TS; mở rộng parity sang đó là việc riêng, đừng lặng lẽ nới phạm vi test này.
//
// Khi test đỏ: KHÔNG sửa fixture để test xanh. Fixture do Rust sinh, tức là bản TS lệch.
// Sửa TS cho khớp, hoặc nếu ĐỔI thuật toán có chủ đích thì bless lại fixture ở phía Rust
// (`PRYNX_BLESS_PARITY=1`) rồi soi diff — cùng chính sách với golden master.
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveOptimalNupLayout } from './NupGridSolver';

interface ParityCase {
    name: string;
    usable_w: number;
    usable_h: number;
    orig_w: number;
    orig_h: number;
    gap_x: number;
    gap_y: number;
    expected: {
        total_items: number;
        cols: number;
        rows: number;
        is_rotated: boolean;
        overall_width: number;
        overall_height: number;
    };
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '../../../../imposition_core/tests/fixtures/grid_parity_simple_auto.json');

const round3 = (value: number) => Math.round(value * 1000) / 1000;

const cases: ParityCase[] = JSON.parse(readFileSync(FIXTURE, 'utf-8'));

describe('NupGridSolver simple_auto khớp imposition_core (Rust)', () => {
    it('fixture có case và đọc được', () => {
        expect(cases.length).toBeGreaterThan(5);
    });

    it.each(cases)('$name', (parityCase: ParityCase) => {
        const layout = solveOptimalNupLayout(
            parityCase.usable_w,
            parityCase.usable_h,
            parityCase.orig_w,
            parityCase.orig_h,
            parityCase.gap_x,
            parityCase.gap_y,
            'simple_auto',
            0,
            0,
        );

        const expected = parityCase.expected;

        // Số con/tờ là con số người dùng ĐỌC — lệch cái này là lệch nghiệp vụ.
        expect(
            layout.totalItems,
            `số con/tờ lệch: TS=${layout.totalItems} vs Rust=${expected.total_items}`,
        ).toBe(expected.total_items);

        // Khổ tổng của khối đã xếp — quyết định căn giữa trên tờ và vị trí dấu xén.
        expect(round3(layout.overallWidth)).toBeCloseTo(expected.overall_width, 3);
        expect(round3(layout.overallHeight)).toBeCloseTo(expected.overall_height, 3);
    });

    it('cùng số ô trong cells như totalItems (bất biến nội bộ của bản TS)', () => {
        for (const parityCase of cases) {
            const layout = solveOptimalNupLayout(
                parityCase.usable_w,
                parityCase.usable_h,
                parityCase.orig_w,
                parityCase.orig_h,
                parityCase.gap_x,
                parityCase.gap_y,
                'simple_auto',
                0,
                0,
            );
            expect(layout.cells.length, `case '${parityCase.name}'`).toBe(layout.totalItems);
        }
    });
});
