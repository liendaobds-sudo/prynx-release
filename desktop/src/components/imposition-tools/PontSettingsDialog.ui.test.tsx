// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PontSettingsDialog } from './PontSettingsDialog';
import { DEFAULT_PONT_CONFIG } from './pontConfigDefaults';

describe('PontSettingsDialog UI Flow', () => {
    beforeEach(() => {
        window.localStorage.clear();
        // Giả lập sẵn 2 preset trong localStorage
        window.localStorage.setItem('ps_pont_presets', JSON.stringify([
            { name: 'Qpack', config: { ...DEFAULT_PONT_CONFIG, size: 4.5 } },
            { name: 'Ốc Leta', config: { ...DEFAULT_PONT_CONFIG, size: 6.0, shape: 'l_corner' } },
        ]));
    });

    it('tự động nhận diện và nạp đúng mẫu khi truyền currentPresetName', () => {
        render(
            <PontSettingsDialog
                isOpen={true}
                onClose={vi.fn()}
                config={DEFAULT_PONT_CONFIG}
                currentPresetName="Qpack"
                onSave={vi.fn()}
            />
        );

        // Dropdown chọn mẫu phải chọn sẵn Qpack
        const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
        expect(select.value).toBe('Qpack');

        // Ô tên mẫu hiển thị đúng Qpack
        const nameInput = screen.getByPlaceholderText(/nhập tên mẫu/i) as HTMLInputElement;
        expect(nameInput.value).toBe('Qpack');

        // Nút lưu dưới footer phải là "Lưu mẫu & Áp dụng"
        expect(screen.getByRole('button', { name: /lưu mẫu & áp dụng/i })).toBeDefined();
    });

    it('cho phép sửa thông số và Lưu & Áp dụng chỉ với 1 click', () => {
        const onSave = vi.fn();
        const onClose = vi.fn();

        render(
            <PontSettingsDialog
                isOpen={true}
                onClose={onClose}
                config={DEFAULT_PONT_CONFIG}
                currentPresetName="Qpack"
                onSave={onSave}
            />
        );

        // Bấm nút Lưu mẫu & Áp dụng ở Footer
        const saveBtn = screen.getByRole('button', { name: /lưu mẫu & áp dụng/i });
        fireEvent.click(saveBtn);

        // Phải gọi onSave với tên preset "Qpack" và gọi onClose đóng modal
        expect(onSave).toHaveBeenCalledWith(
            expect.objectContaining({ size: 4.5 }),
            'Qpack'
        );
        expect(onClose).toHaveBeenCalled();
    });

    it('hỗ trợ xóa preset đang chọn và cập nhật localStorage', () => {
        // Giả lập window.confirm trả về true
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(
            <PontSettingsDialog
                isOpen={true}
                onClose={vi.fn()}
                config={DEFAULT_PONT_CONFIG}
                currentPresetName="Qpack"
                onSave={vi.fn()}
            />
        );

        // Nút xóa mẫu
        const deleteBtn = screen.getByLabelText(/xóa mẫu này/i);
        fireEvent.click(deleteBtn);

        // LocalStorage phải mất Qpack, chỉ còn Ốc Leta
        const raw = window.localStorage.getItem('ps_pont_presets') || '[]';
        const updated = JSON.parse(raw);
        expect(updated).toHaveLength(1);
        expect(updated[0].name).toBe('Ốc Leta');
    });

    it('hỗ trợ tạo mẫu mới và lưu & áp dụng ngay', () => {
        const onSave = vi.fn();
        const onClose = vi.fn();

        render(
            <PontSettingsDialog
                isOpen={true}
                onClose={onClose}
                config={DEFAULT_PONT_CONFIG}
                onSave={onSave}
            />
        );

        // Bấm Tạo mẫu mới
        const createBtn = screen.getByRole('button', { name: /\+ tạo mẫu mới/i });
        fireEvent.click(createBtn);

        // Nhập tên mẫu mới
        const nameInput = screen.getByPlaceholderText(/nhập tên mẫu/i);
        fireEvent.change(nameInput, { target: { value: 'Boong Mimaki' } });

        // Bấm Lưu mẫu & Áp dụng
        const saveBtn = screen.getByRole('button', { name: /lưu mẫu & áp dụng/i });
        fireEvent.click(saveBtn);

        // Phải lưu vào localStorage
        const raw = window.localStorage.getItem('ps_pont_presets') || '[]';
        const updated = JSON.parse(raw);
        expect(updated.some((p: { name: string }) => p.name === 'Boong Mimaki')).toBe(true);

        // Phải gọi onSave và onClose
        expect(onSave).toHaveBeenCalledWith(expect.anything(), 'Boong Mimaki');
        expect(onClose).toHaveBeenCalled();
    });

    it('tự động nhận diện và đổ thông số khi tải file mẫu PDF/SVG', async () => {
        const inspectModule = await import('./pontTemplateApi');
        const spyInspect = vi.spyOn(inspectModule, 'inspectPontTemplate').mockResolvedValue({
            success: true,
            filename: 'Boong_Decal_5mm.pdf',
            suggestedName: 'Ốc tròn 5.0mm (Boong_Decal_5mm)',
            sheet: { widthMm: 330, heightMm: 483 },
            detected: {
                marksFound: 4,
                corners: ['TL', 'TR', 'BL', 'BR'],
                shape: 'circle',
                size: 5.0,
                thickness: 0.5,
                marginLeft: 15.0,
                marginRight: 15.0,
                marginTop: 15.0,
                marginBottom: 15.0,
            },
            config: {
                ...DEFAULT_PONT_CONFIG,
                shape: 'circle',
                size: 5.0,
                thickness: 0.5,
                marginLeft: 15.0,
                marginRight: 15.0,
                marginTop: 15.0,
                marginBottom: 15.0,
                guide1Enabled: true,
                guide1Pos: 'BL',
                guide1Length: 20.0,
            },
            message: 'Đã nhận diện thành công',
        });

        render(
            <PontSettingsDialog
                isOpen={true}
                onClose={vi.fn()}
                config={DEFAULT_PONT_CONFIG}
                onSave={vi.fn()}
            />
        );

        // Nút Nhập từ file mẫu
        const importBtn = screen.getByRole('button', { name: /nhập từ file mẫu/i });
        expect(importBtn).toBeDefined();

        // Tìm input file ẩn
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput).not.toBeNull();

        // Tạo dummy file và kích hoạt event change
        const dummyFile = new File(['%PDF-1.4 dummy'], 'Boong_Decal_5mm.pdf', { type: 'application/pdf' });
        fireEvent.change(fileInput, { target: { files: [dummyFile] } });

        expect(spyInspect).toHaveBeenCalledWith(dummyFile);

        // Đợi cập nhật UI: ô tên mẫu phải được điền suggestedName
        const nameInput = await screen.findByDisplayValue('Ốc tròn 5.0mm (Boong_Decal_5mm)') as HTMLInputElement;
        expect(nameInput).toBeDefined();

        spyInspect.mockRestore();
    });
});
