// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_STICKER_OUTPUT_SETTINGS,
    type StickerOutputSettings,
} from './stickerOutputSettings';
import StickerOutputSettingsPanel from './StickerOutputSettingsPanel';


interface HarnessProps {
    initial: StickerOutputSettings;
    onChange: (next: StickerOutputSettings) => void;
    disabled?: boolean;
    preserveNotice?: ReactNode;
}

function Harness({ initial, onChange, disabled, preserveNotice }: HarnessProps) {
    const [value, setValue] = useState(initial);
    return (
        <StickerOutputSettingsPanel
            value={value}
            disabled={disabled}
            preserveNotice={preserveNotice}
            onChange={next => {
                onChange(next);
                setValue(next);
            }}
        />
    );
}

function settings(overrides: Partial<StickerOutputSettings> = {}): StickerOutputSettings {
    return {
        ...DEFAULT_STICKER_OUTPUT_SETTINGS,
        solidBleedCmyk: [...DEFAULT_STICKER_OUTPUT_SETTINGS.solidBleedCmyk],
        ...overrides,
    };
}

describe('StickerOutputSettingsPanel', () => {
    it('điều khiển đủ thiết lập bế tem, chuẩn hóa giá trị và không sửa object đầu vào', () => {
        const initial = settings();
        const initialCmyk = initial.solidBleedCmyk;
        const onChange = vi.fn();
        render(<Harness initial={initial} onChange={onChange} />);

        const cutModeGroup = screen.getByRole('group', { name: 'Chế độ đường cắt' });
        fireEvent.click(within(cutModeGroup).getByRole('button', { name: /Theo hình gốc/ }));
        expect(within(cutModeGroup).getAllByRole('button')).toHaveLength(5);
        fireEvent.click(within(cutModeGroup).getByRole('button', { name: /Theo biên trong suốt PNG/ }));
        expect(onChange.mock.lastCall?.[0].cutMode).toBe('alpha');

        fireEvent.change(screen.getByRole('spinbutton', { name: 'Co giãn đường cắt (mm)' }), {
            target: { value: '99' },
        });
        expect(onChange.mock.lastCall?.[0].offsetMm).toBe(10);

        const roundButton = screen.getByRole('button', { name: /Bo tròn:/ });
        fireEvent.click(roundButton);
        expect(onChange.mock.lastCall?.[0].cornerStyle).toBe('round');
        expect(roundButton.getAttribute('aria-pressed')).toBe('true');

        const fillButton = screen.getByRole('button', { name: /Đặc ruột:/ });
        fireEvent.click(fillButton);
        expect(onChange.mock.lastCall?.[0].fillHoles).toBe(false);

        const cropButton = screen.getByRole('button', { name: 'Crop trang theo đường bế và phần bù xén' });
        fireEvent.click(cropButton);
        expect(onChange.mock.lastCall?.[0].cropToSticker).toBe(false);

        fireEvent.change(screen.getByRole('spinbutton', { name: 'Bù xén ngoài đường cắt (mm)' }), {
            target: { value: '-2' },
        });
        expect(onChange.mock.lastCall?.[0].bleedMm).toBe(0);

        const bleedColorGroup = screen.getByRole('group', { name: 'Màu bù xén' });
        fireEvent.click(within(bleedColorGroup).getByRole('button', { name: /Lấy theo màu viền tem/ }));
        expect(within(bleedColorGroup).getAllByRole('button')).toHaveLength(5);
        fireEvent.click(within(bleedColorGroup).getByRole('button', { name: /Đổ màu trơn/ }));
        expect(onChange.mock.lastCall?.[0].bleedColorType).toBe('solid');

        const cmykGroup = screen.getByRole('group', { name: 'Màu bù xén CMYK' });
        expect(within(cmykGroup).getAllByRole('spinbutton')).toHaveLength(4);
        fireEvent.change(within(cmykGroup).getByRole('spinbutton', { name: 'C (%)' }), {
            target: { value: '128' },
        });

        const emitted = onChange.mock.lastCall?.[0] as StickerOutputSettings;
        expect(emitted.solidBleedCmyk).toEqual([100, 0, 0, 0]);
        expect(emitted).not.toBe(initial);
        expect(emitted.solidBleedCmyk).not.toBe(initialCmyk);
        expect(initial).toEqual(settings());
        expect(screen.queryByText(/Bỏ nền trắng|Xén mép trắng|trang đầu/i)).toBeNull();
    });

    it('khóa thật mọi control, giữ aria rõ ràng và vẫn hiện thông báo bảo toàn', () => {
        const onChange = vi.fn();
        const { container } = render(
            <Harness
                initial={settings({
                    bleedColorType: 'solid',
                    solidBleedCmyk: [10, 20, 30, 40],
                })}
                onChange={onChange}
                disabled
                preserveNotice={<span>CutContour gốc sẽ được giữ nguyên khi không chỉnh hình học.</span>}
            />,
        );

        expect(screen.getByRole('note').textContent).toContain('CutContour gốc');
        expect(screen.getByRole('group', { name: 'Thiết lập đường bế tem' }).getAttribute('aria-disabled')).toBe('true');

        const controls = Array.from(container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'));
        expect(controls.length).toBeGreaterThan(0);
        controls.forEach(control => expect(control.matches(':disabled')).toBe(true));
        container.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
            expect(button.type).toBe('button');
        });

        const preserveCorner = screen.getByRole('button', { name: /Giữ nguyên:/ });
        expect(preserveCorner.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: /Đặc ruột:/ }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Crop trang theo đường bế và phần bù xén' }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(preserveCorner);
        fireEvent.change(screen.getByRole('spinbutton', { name: 'C (%)' }), { target: { value: '80' } });
        expect(onChange).not.toHaveBeenCalled();
    });
});
