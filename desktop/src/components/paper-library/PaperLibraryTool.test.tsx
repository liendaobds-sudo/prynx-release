// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import PaperLibraryTool from './PaperLibraryTool';
import { PAPER_STOCKS, THREAD_SEWING_LIMITS } from '../../lib/paperLibrary';

afterEach(cleanup);

/**
 * Bấm một mục ở sidebar theo nhãn.
 * Giới hạn trong <nav> vì tên họ giấy còn xuất hiện ở dải màu trong bảng.
 */
function nav(name: RegExp) {
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name }));
}

describe('Sidebar điều hướng', () => {
    it('có 4 mục lớn theo 4 sheet của workbook', () => {
        render(<PaperLibraryTool isActive />);
        const sidebar = screen.getByRole('navigation');
        for (const label of [/Định lượng giấy/, /Độ dày gáy sách/, /Màng cán/, /May chỉ/]) {
            expect(within(sidebar).getByRole('button', { name: label })).toBeTruthy();
        }
    });

    it('mở ra là ở mục định lượng giấy, xem tất cả họ', () => {
        render(<PaperLibraryTool isActive />);
        // Mỗi họ giấy là 1 bảng riêng khi xem 'tất cả'
        expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
    });

    it('mục định lượng giấy xổ ra 9 họ giấy + mục tất cả', () => {
        render(<PaperLibraryTool isActive />);
        const list = document.getElementById('pl-family-list') as HTMLElement;
        expect(list).toBeTruthy();
        // 1 mục "Tất cả họ giấy" + 9 họ
        expect(within(list).getAllByRole('button')).toHaveLength(10);
        expect(within(list).getByRole('button', { name: /Tất cả họ giấy/ })).toBeTruthy();
        for (const f of ['Couche', 'Couche Matt', 'Duplex', 'Bristol', 'Ivory (Ngà)', 'Fort', 'Art', 'Kraft', 'Loại khác']) {
            expect(
                within(list).getAllByRole('button').some(b => b.textContent?.includes(f)),
                f,
            ).toBe(true);
        }
    });

    it('mục cha khai báo trạng thái xổ cho trình đọc màn hình', () => {
        render(<PaperLibraryTool isActive />);
        const parent = screen.getByRole('button', { name: /Định lượng giấy/ });
        expect(parent.getAttribute('aria-expanded')).toBe('true');
        fireEvent.click(parent);
        expect(parent.getAttribute('aria-expanded')).toBe('false');
    });

    it('đóng mục cha thì danh sách họ giấy biến mất, bảng vẫn còn', () => {
        render(<PaperLibraryTool isActive />);
        fireEvent.click(screen.getByRole('button', { name: /Định lượng giấy/ }));
        expect(screen.queryByRole('button', { name: /Tất cả họ giấy/ })).toBeNull();
        // View 'all' có nhiều bảng (mỗi họ 1 bảng)
        expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
    });

    it('mục đang xem được đánh dấu aria-current', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Màng cán/);
        expect(
            screen.getByRole('button', { name: /Màng cán/ }).getAttribute('aria-current'),
        ).toBe('page');
    });
});

describe('Chọn họ giấy ở sidebar', () => {
    it('click Bristol thì chỉ hiện 14 dòng Bristol', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Bristol/);
        // 2 bảng song song: gom tất cả data rows (trừ header) = 14
        const tables = screen.getAllByRole('table');
        const dataRows = tables.flatMap(t =>
            within(t).getAllByRole('row').slice(1),
        );
        expect(dataRows).toHaveLength(14);
        expect(screen.getByText('Bristol 170(2S)')).toBeTruthy();
        // Kiểm tra không có giấy Couche trong các bảng (bỏ qua dropdown)
        const tableContainer = tables[0].closest('div')!;
        expect(within(tableContainer).queryByText('Couche 300')).toBeNull();
    });

    it('click Couche Matt ra đúng 25 dòng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Couche Matt/);
        const tables = screen.getAllByRole('table');
        const dataRows = tables.flatMap(t =>
            within(t).getAllByRole('row').slice(1),
        );
        expect(dataRows).toHaveLength(25);
    });

    it('tiêu đề vùng nội dung đổi theo họ đang chọn', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Ivory/);
        expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/Ivory/);
    });

    it('quay lại Tất cả họ giấy thì đủ 208 dòng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Bristol/);
        nav(/Tất cả họ giấy/);
        // Mỗi họ là 1 bảng riêng — gom tất cả data rows
        const tables = screen.getAllByRole('table');
        const dataRows = tables.flatMap(t =>
            within(t).getAllByRole('row').slice(1),
        );
        expect(dataRows).toHaveLength(PAPER_STOCKS.length);
    });

    it('xem tất cả thì mỗi họ có accordion riêng', () => {
        render(<PaperLibraryTool isActive />);
        // Mỗi họ giấy chia 2 bảng (2 cột) — tổng >= 9 * 2 = 18
        // (một vài họ nhỏ có thể chỉ 1 bảng nếu <= 1 dòng)
        const tables = screen.getAllByRole('table');
        expect(tables.length).toBeGreaterThanOrEqual(9);
    });
});

describe('Tìm kiếm trong bảng giấy', () => {
    it('tìm theo tên giấy', () => {
        render(<PaperLibraryTool isActive />);
        fireEvent.change(screen.getByLabelText(/Tìm kiếm/), { target: { value: 'Couche 300' } });
        const table = screen.getByRole('table');
        expect(within(table).getByText('Couche 300')).toBeTruthy();
        expect(within(table).queryByText('Fort 120')).toBeNull();
    });

    it('tìm theo định lượng', () => {
        render(<PaperLibraryTool isActive />);
        fireEvent.change(screen.getByLabelText(/Tìm kiếm/), { target: { value: '444' } });
        expect(screen.getByText(/Ivory 444/)).toBeTruthy();
    });

    it('lọc không ra thì báo rõ', () => {
        render(<PaperLibraryTool isActive />);
        fireEvent.change(screen.getByLabelText(/Tìm kiếm/), { target: { value: 'zzz-khong-co' } });
        expect(screen.getByText(/Không có giấy nào khớp/)).toBeTruthy();
    });

    it('tìm kiếm áp trong họ đang chọn', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Bristol/);
        fireEvent.change(screen.getByLabelText(/Tìm kiếm/), { target: { value: 'Couche' } });
        expect(screen.getByText(/Không có giấy nào khớp/)).toBeTruthy();
    });

    it('độ dày hiện dấu phẩy thập phân theo tiếng Việt', () => {
        render(<PaperLibraryTool isActive />);
        fireEvent.change(screen.getByLabelText(/Tìm kiếm/), { target: { value: 'Couche 60.2' } });
        expect(screen.getByText('0,050')).toBeTruthy();
    });
});

describe('Mục độ dày gáy sách', () => {
    it('tính ra số gáy khớp công thức workbook', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        // Couche 100, 26 trang, khâu chỉ: (100/2)×26 = 1300; −10% = 1170; /1000 = 1,17mm
        expect(screen.getByText('1,170')).toBeTruthy();
    });

    it('đổi số trang thì gáy dày lên', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/Tổng số trang ruột/), { target: { value: '52' } });
        expect(screen.getByText('2,340')).toBeTruthy();
    });

    it('keo nhiệt — cảnh báo khi gáy mỏng hơn ngưỡng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        // Chuyển kiểu đóng sang Keo nhiệt (mặc định là Khâu chỉ)
        fireEvent.change(screen.getByLabelText(/Kiểu đóng/), { target: { value: 'hotmelt' } });
        expect(screen.getByText(/Gáy mỏng hơn 3 mm/)).toBeTruthy();
    });

    it('khâu chỉ — không cảnh báo dù gáy mỏng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        // Mặc định là khâu chỉ, 26 trang → gáy < 3mm nhưng khâu chỉ không có ngưỡng
        expect(screen.queryByText(/Gáy mỏng hơn/)).toBeNull();
    });

    it('cán màng 2 mặt dày gấp đôi phần bù của cán 1 mặt', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/Tổng số trang ruột/), { target: { value: '200' } });

        const lam = screen.getByLabelText(/Cán màng bìa/);
        fireEvent.change(lam, { target: { value: '1s' } });
        expect(screen.getByText('10,125')).toBeTruthy();

        fireEvent.change(lam, { target: { value: '2s' } });
        expect(screen.getByText('11,250')).toBeTruthy();
    });

    it('cảnh báo khi kiểu đóng không có trong bảng xưởng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/^Họ giấy$/), { target: { value: 'ivory' } });
        fireEvent.change(screen.getByLabelText(/Kiểu đóng/), { target: { value: 'thread' } });
        expect(screen.getByText(/Xưởng không dùng kiểu đóng này/)).toBeTruthy();
    });

    it('đổi họ giấy thì tự chọn kiểu đóng hợp lệ', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/^Họ giấy$/), { target: { value: 'ivory' } });
        expect((screen.getByLabelText(/Kiểu đóng/) as HTMLSelectElement).value).toBe('mounted');
        expect(screen.queryByText(/Xưởng không dùng kiểu đóng này/)).toBeNull();
    });

    it('cảnh báo họ giấy KHÁC không có số trong bảng xưởng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/^Họ giấy$/), { target: { value: 'other' } });
        expect(screen.getByText(/để trống toàn bộ họ giấy này/)).toBeTruthy();
    });

    it('hiện cả hai đường tính kèm giải thích vì sao lệch', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        expect(screen.getByText(/Tham khảo — tính từ độ dày đo thực/)).toBeTruthy();
        expect(screen.getByText(/độ dày 1 tờ.*bảng tra vật tư.*số tờ/)).toBeTruthy();
    });
});

/**
 * Chống hồi quy cho lỗi đã sửa: bản đầu gỡ cả SpineCalculator theo isActive,
 * nên thợ nhập số trang rồi sang tab khác là mất số.
 */
describe('Giữ tham số đã nhập ở mục gáy sách', () => {
    it('không mất số trang khi tab bị đẩy xuống nền rồi hiện lại', () => {
        const view = render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/Tổng số trang ruột/), { target: { value: '240' } });
        expect((screen.getByLabelText(/Tổng số trang ruột/) as HTMLInputElement).value).toBe('240');

        view.rerender(<PaperLibraryTool isActive={false} />);
        view.rerender(<PaperLibraryTool isActive />);

        expect((screen.getByLabelText(/Tổng số trang ruột/) as HTMLInputElement).value).toBe('240');
    });

    it('không mất số trang khi sang mục khác rồi quay lại', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/Tổng số trang ruột/), { target: { value: '240' } });

        nav(/Màng cán/);
        nav(/Độ dày gáy sách/);

        expect((screen.getByLabelText(/Tổng số trang ruột/) as HTMLInputElement).value).toBe('240');
    });

    it('giữ cả kiểu đóng và cán màng đã chọn', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Độ dày gáy sách/);
        fireEvent.change(screen.getByLabelText(/Kiểu đóng/), { target: { value: 'hotmelt' } });
        fireEvent.change(screen.getByLabelText(/Cán màng bìa/), { target: { value: '2s' } });

        nav(/May chỉ/);
        nav(/Độ dày gáy sách/);

        expect((screen.getByLabelText(/Kiểu đóng/) as HTMLSelectElement).value).toBe('hotmelt');
        expect((screen.getByLabelText(/Cán màng bìa/) as HTMLSelectElement).value).toBe('2s');
    });

    it('bảng chỉ-đọc VẪN gỡ khỏi cây khi tab ở nền (giữ mục tiêu tối ưu DOM)', () => {
        render(<PaperLibraryTool isActive={false} />);
        expect(screen.queryByRole('table')).toBeNull();
        // Sidebar vẫn còn để bấm được ngay khi tab hiện lại
        expect(screen.getByRole('navigation')).toBeTruthy();
    });
});

describe('Mục màng cán', () => {
    it('hiện 15 loại màng', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Màng cán/);
        // Bảng đầu tiên là bảng màng chính (15 loại), sau đó là các bảng tính chất phụ
        const tables = screen.getAllByRole('table');
        const rows = within(tables[0]).getAllByRole('row');
        expect(rows).toHaveLength(15 + 1);
    });

    it('đánh dấu 4 màng mạ kim loại', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Màng cán/);
        expect(screen.getAllByText(/mạ kim loại/)).toHaveLength(4);
    });

    it('hiện độ dày cả µm lẫn mm', () => {
        render(<PaperLibraryTool isActive />);
        nav(/Màng cán/);
        expect(screen.getByText('20–30')).toBeTruthy();
        expect(screen.getByText('0,020–0,030')).toBeTruthy();
    });
});

describe('Mục may chỉ', () => {
    it('hiện 8 mã giấy', () => {
        render(<PaperLibraryTool isActive />);
        nav(/May chỉ/);
        const rows = within(screen.getByRole('table')).getAllByRole('row');
        expect(rows).toHaveLength(THREAD_SEWING_LIMITS.length + 1);
    });

    it('chỗ workbook để trống thì ghi "chưa có số", không bịa số', () => {
        render(<PaperLibraryTool isActive />);
        nav(/May chỉ/);
        expect(screen.getAllByText(/chưa có số/)).toHaveLength(5);
    });

    it('nhắc giới hạn áp cho một tay sách', () => {
        render(<PaperLibraryTool isActive />);
        nav(/May chỉ/);
        expect(screen.getByText(/MỘT tay sách/)).toBeTruthy();
    });
});
