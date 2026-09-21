// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import DataMergeTool, { getFieldMappedColumns } from './DataMergeTool';
import { createWorkspaceStore, WorkspaceContext } from '@/stores/useWorkspaceStore';

function render(ui: React.ReactElement) {
    const store = createWorkspaceStore();
    return rtlRender(
        <WorkspaceContext.Provider value={store}>
            {ui}
        </WorkspaceContext.Provider>
    );
}

describe('DataMergeTool - getFieldMappedColumns', () => {
    const csvHeaders = ['Name C', 'Name BM', 'To Doi', 'Barcode_ID', 'Avatar_Img'];

    it('trả về rỗng khi csvHeaders rỗng', () => {
        const field = { name: 'Name C' };
        expect(getFieldMappedColumns(field, [])).toEqual([]);
    });

    it('khớp trực tiếp theo field.name', () => {
        const field1 = { name: 'Name C' };
        expect(getFieldMappedColumns(field1, csvHeaders)).toEqual(['Name C']);

        const field2 = { name: 'To Doi' };
        expect(getFieldMappedColumns(field2, csvHeaders)).toEqual(['To Doi']);
    });

    it('khớp field.name không phân biệt hoa thường và khoảng trắng thừa', () => {
        const field = { name: '  name c  ' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual(['Name C']);
    });

    it('trả về rỗng khi field.name chưa khớp với bất kỳ cột nào', () => {
        const field = { name: 'Truong_1', textContent: 'Chưa gắn cột' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual([]);
    });

    it('khớp placeholder trong textContent dạng {Ten_Cot}', () => {
        const field = { name: 'Khung 1', textContent: 'Xin chào {Name BM}!' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual(['Name BM']);
    });

    it('khớp placeholder có định dạng |upper, |lower hoặc chia tách [1|-]', () => {
        const field = { name: 'Khung 1', textContent: '{Name BM|upper}' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual(['Name BM']);

        const fieldWithSplit = { name: 'Khung 2', textContent: '{To Doi[1|-]|title}' };
        expect(getFieldMappedColumns(fieldWithSplit, csvHeaders)).toEqual(['To Doi']);
    });

    it('khớp placeholder dạng thẻ {{Ten_Cot}} từ auto-detect', () => {
        const field = { name: 'The_Auto', textContent: '{{Name C}}' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual(['Name C']);
    });

    it('khớp nhiều placeholder trong cùng một textContent', () => {
        const field = { name: 'Combo', textContent: 'Tổ: {To Doi} - Họ tên: {Name C}' };
        const mapped = getFieldMappedColumns(field, csvHeaders);
        expect(mapped).toContain('To Doi');
        expect(mapped).toContain('Name C');
        expect(mapped).toHaveLength(2);
    });

    it('khớp placeholder trong data của barcode / qrcode', () => {
        const field = { name: 'Mã Vạch', data: '{Barcode_ID}' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual(['Barcode_ID']);
    });

    it('khớp placeholder trong imagePath của ảnh biến đổi', () => {
        const field = { name: 'Ảnh', imagePath: 'D:\\photos\\{Avatar_Img}.jpg' };
        expect(getFieldMappedColumns(field, csvHeaders)).toEqual(['Avatar_Img']);
    });
});

describe('DataMergeTool - UI highlighting trường đã ghép', () => {
    const mockPdf = new File(['%PDF-1.4'], 'test.pdf', { type: 'application/pdf' });
    const initialFields = [
        { id: 'f1', name: 'Name C', type: 'text', x: 10, y: 10, width: 50, height: 20 },
        { id: 'f2', name: 'Chua_Ghep', type: 'text', x: 10, y: 40, width: 50, height: 20 },
    ];

    it('hiển thị danh sách trường với trạng thái ban đầu khi chưa nạp CSV', () => {
        render(
            <DataMergeTool
                pdfFile={mockPdf}
                vdpFields={initialFields}
                selectedFieldIds={[]}
                isActive={true}
            />
        );

        expect(screen.getByText('Danh sách trường')).toBeTruthy();
        expect(screen.getByText('Name C')).toBeTruthy();
        expect(screen.getByText('Chua_Ghep')).toBeTruthy();
    });

    it('highlight viền xanh và tick xanh khi trường khớp với cột dữ liệu nhập tay', () => {
        render(
            <DataMergeTool
                pdfFile={mockPdf}
                vdpFields={initialFields}
                selectedFieldIds={[]}
                isActive={true}
            />
        );

        // Chuyển sang tab Nhập tay bằng role button chính xác
        const manualBtn = screen.getByRole('button', { name: '✍️ Nhập tay' });
        fireEvent.click(manualBtn);

        // Đặt tên cột là "Name C"
        const colInput = screen.getByPlaceholderText('Noidung');
        fireEvent.change(colInput, { target: { value: 'Name C' } });

        // Nhập dữ liệu nhiều dòng
        const textArea = screen.getByPlaceholderText(/Mỗi dòng = 1 bản ghi/i);
        fireEvent.change(textArea, { target: { value: 'Nguyen Van A\nTran Van B' } });

        // Badge mục 3 cập nhật số trường đã ghép: "1/2 Đã ghép"
        expect(screen.getByText(/1\/2\s*đã ghép/i)).toBeTruthy();

        // Thẻ của Name C có tick "Đã ghép" và viền highlight emerald
        expect(screen.getAllByText('Đã ghép').length).toBeGreaterThan(0);
        const nameCard = screen.getAllByText('Name C').find(el => el.closest('.cursor-pointer'))?.closest('.cursor-pointer');
        expect(nameCard?.className).toContain('border-l-emerald-500');

        // Thẻ của Chua_Ghep không có viền xanh
        const chuaGhepCard = screen.getByText('Chua_Ghep').closest('.cursor-pointer');
        expect(chuaGhepCard?.className).not.toContain('border-l-emerald-500');
    });

    it('hiển thị badge trạng thái trong Mục 4 khi chọn trường đã ghép vs chưa ghép', () => {
        const store = createWorkspaceStore();
        const { rerender } = rtlRender(
            <WorkspaceContext.Provider value={store}>
                <DataMergeTool
                    pdfFile={mockPdf}
                    vdpFields={initialFields}
                    selectedFieldIds={['f1']}
                    isActive={true}
                />
            </WorkspaceContext.Provider>
        );

        // Bật mode nhập tay với cột Name C
        const manualBtn = screen.getByRole('button', { name: '✍️ Nhập tay' });
        fireEvent.click(manualBtn);
        const colInput = screen.getByPlaceholderText('Noidung');
        fireEvent.change(colInput, { target: { value: 'Name C' } });
        const textArea = screen.getByPlaceholderText(/Mỗi dòng = 1 bản ghi/i);
        fireEvent.change(textArea, { target: { value: 'A\nB' } });

        // Khi đang chọn field f1 (Name C) -> Section 4 hiển thị badge tên cột "Name C"
        expect(screen.getByText('Ghép cột dữ liệu')).toBeTruthy();
        expect(screen.getAllByText('Name C').length).toBeGreaterThan(0);

        // Đổi sang chọn field f2 (Chua_Ghep) -> Section 4 hiển thị badge "Chưa ghép"
        rerender(
            <WorkspaceContext.Provider value={store}>
                <DataMergeTool
                    pdfFile={mockPdf}
                    vdpFields={initialFields}
                    selectedFieldIds={['f2']}
                    isActive={true}
                />
            </WorkspaceContext.Provider>
        );
        expect(screen.getByText('Chưa ghép')).toBeTruthy();
    });
});
