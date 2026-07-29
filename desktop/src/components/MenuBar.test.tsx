// @vitest-environment jsdom
// UIUX (audit menu 2026-07-28 §MB.7/§MB.9): chốt lại phần điều hướng bàn phím và
// vai trò ARIA của thanh menu. Trước đợt này submenu chỉ mở được bằng hover nên
// "Mở gần đây" và toàn bộ menu Công cụ không thể tới bằng bàn phím.
import { fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MenuBar, type MenuDef } from './MenuBar';

const makeMenus = (onOpenRecent = vi.fn(), onSave = vi.fn()): MenuDef[] => [
    {
        label: 'Tệp',
        items: [
            { label: 'Tài liệu mới', shortcut: 'Ctrl+N', onClick: vi.fn() },
            {
                label: 'Mở gần đây',
                submenu: [
                    { label: 'bia-hop.pdf', title: 'D:\\viec\\bia-hop.pdf', onClick: onOpenRecent },
                    { separator: true },
                    { label: 'Xóa danh sách gần đây', onClick: vi.fn() },
                ],
            },
            { separator: true },
            { label: 'Lưu', shortcut: 'Ctrl+S', onClick: onSave },
            { label: 'In…', disabled: true, onClick: vi.fn() },
        ],
    },
    {
        label: 'Xem',
        items: [
            { label: 'Xem một trang', checked: true, onClick: vi.fn() },
            { label: 'Xem hai trang', checked: false, onClick: vi.fn() },
        ],
    },
];

afterEach(() => vi.restoreAllMocks());

describe('MenuBar — vai trò ARIA', () => {
    it('khai báo menubar, menuitem có aria-haspopup/aria-expanded', () => {
        render(<MenuBar menus={makeMenus()} />);
        expect(screen.getByRole('menubar')).toBeTruthy();

        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        expect(fileBtn.getAttribute('aria-haspopup')).toBe('menu');
        expect(fileBtn.getAttribute('aria-expanded')).toBe('false');

        fireEvent.click(fileBtn);
        expect(fileBtn.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('menu', { name: 'Tệp' })).toBeTruthy();
    });

    it('mục bật/tắt dùng menuitemcheckbox + aria-checked đúng trạng thái', () => {
        render(<MenuBar menus={makeMenus()} />);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Xem' }));

        const single = screen.getByRole('menuitemcheckbox', { name: /Xem một trang/ });
        const two = screen.getByRole('menuitemcheckbox', { name: /Xem hai trang/ });
        expect(single.getAttribute('aria-checked')).toBe('true');
        expect(two.getAttribute('aria-checked')).toBe('false');
    });

    it('item có title riêng hiện đường dẫn đầy đủ (§MB.15)', () => {
        render(<MenuBar menus={makeMenus()} />);
        fireEvent.click(screen.getByRole('menuitem', { name: 'Tệp' }));
        fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Mở gần đây/ }).parentElement!);

        expect(screen.getByRole('menuitem', { name: 'bia-hop.pdf' }).getAttribute('title'))
            .toBe('D:\\viec\\bia-hop.pdf');
    });
});

describe('MenuBar — điều hướng bàn phím', () => {
    it('ArrowDown mở menu và focus hàng đầu tiên', () => {
        render(<MenuBar menus={makeMenus()} />);
        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        fileBtn.focus();
        fireEvent.keyDown(fileBtn, { key: 'ArrowDown' });

        expect(fileBtn.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement?.textContent).toContain('Tài liệu mới');
    });

    it('ArrowDown bỏ qua separator và item disabled', () => {
        render(<MenuBar menus={makeMenus()} />);
        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        fileBtn.focus();
        fireEvent.keyDown(fileBtn, { key: 'ArrowDown' });

        const panel = screen.getByRole('menu', { name: 'Tệp' });
        fireEvent.keyDown(panel, { key: 'ArrowDown' }); // → Mở gần đây
        fireEvent.keyDown(panel, { key: 'ArrowDown' }); // → Lưu (bỏ separator)
        expect(document.activeElement?.textContent).toContain('Lưu');

        // "In…" disabled → vòng lại đầu danh sách, không bao giờ nhận focus.
        fireEvent.keyDown(panel, { key: 'ArrowDown' });
        expect(document.activeElement?.textContent).toContain('Tài liệu mới');
    });

    it('ArrowRight/ArrowLeft chuyển giữa các menu và giữ trạng thái mở', () => {
        render(<MenuBar menus={makeMenus()} />);
        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        fireEvent.click(fileBtn);
        fireEvent.keyDown(fileBtn, { key: 'ArrowRight' });

        expect(screen.getByRole('menuitem', { name: 'Xem' }).getAttribute('aria-expanded')).toBe('true');
        expect(fileBtn.getAttribute('aria-expanded')).toBe('false');
    });

    it('ArrowRight mở submenu và focus mục đầu — đường vào bằng bàn phím của Mở gần đây', async () => {
        const onOpenRecent = vi.fn();
        render(<MenuBar menus={makeMenus(onOpenRecent)} />);
        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        fileBtn.focus();
        fireEvent.keyDown(fileBtn, { key: 'ArrowDown' });

        const panel = screen.getByRole('menu', { name: 'Tệp' });
        fireEvent.keyDown(panel, { key: 'ArrowDown' }); // → Mở gần đây
        const recentRow = document.activeElement as HTMLElement;
        expect(recentRow.getAttribute('aria-haspopup')).toBe('menu');

        fireEvent.keyDown(recentRow, { key: 'ArrowRight' });
        expect(recentRow.getAttribute('aria-expanded')).toBe('true');
        await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
        expect(document.activeElement?.textContent).toContain('bia-hop.pdf');

        fireEvent.click(document.activeElement as HTMLElement);
        expect(onOpenRecent).toHaveBeenCalledTimes(1);
    });

    it('Escape trong menu đóng menu và trả focus về nút trên thanh', () => {
        render(<MenuBar menus={makeMenus()} />);
        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        fileBtn.focus();
        fireEvent.keyDown(fileBtn, { key: 'ArrowDown' });
        fireEvent.keyDown(screen.getByRole('menu', { name: 'Tệp' }), { key: 'Escape' });

        expect(fileBtn.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(fileBtn);
    });

    it('bấm item thường thì chạy onClick và đóng menu', () => {
        const onSave = vi.fn();
        render(<MenuBar menus={makeMenus(vi.fn(), onSave)} />);
        const fileBtn = screen.getByRole('menuitem', { name: 'Tệp' });
        fireEvent.click(fileBtn);
        fireEvent.click(screen.getByRole('menuitem', { name: /Lưu/ }));

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(fileBtn.getAttribute('aria-expanded')).toBe('false');
    });
});

describe('MenuBar — submenu không đóng khi chuột băng qua khe (§MB.9)', () => {
    it('rời hàng cha rồi vào lại trong 200ms thì submenu vẫn mở', () => {
        vi.useFakeTimers();
        try {
            render(<MenuBar menus={makeMenus()} />);
            fireEvent.click(screen.getByRole('menuitem', { name: 'Tệp' }));
            const wrapper = screen.getByRole('menuitem', { name: /Mở gần đây/ }).parentElement!;

            fireEvent.mouseEnter(wrapper);
            expect(screen.getByRole('menu', { name: 'Mở gần đây' })).toBeTruthy();

            fireEvent.mouseLeave(wrapper);
            act(() => { vi.advanceTimersByTime(120); });
            fireEvent.mouseEnter(wrapper); // chuột đã tới submenu trước khi hết hẹn
            act(() => { vi.advanceTimersByTime(400); });

            expect(screen.getByRole('menu', { name: 'Mở gần đây' })).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });
});
