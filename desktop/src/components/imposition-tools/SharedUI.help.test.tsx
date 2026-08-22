// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ToolItem } from './SharedUI';

vi.mock('../ToolHelpModal', () => ({
    default: ({ help }: { help: { title: string; tagline: string } }) => (
        <div data-testid="tool-help-modal" role="dialog">
            <h2>{help.title}</h2>
            <p>{help.tagline}</p>
        </div>
    ),
}));

describe('SharedUI.ToolItem — giới thiệu công cụ', () => {
    it('mở modal ngay cả khi tool chỉ có mô tả ngắn, không hiện popover riêng', () => {
        render(
            <ToolItem
                icon="🪄"
                label="Công cụ thử"
                info="Mô tả ngắn của công cụ"
                helpKey="missing-help-entry"
                onClick={vi.fn()}
                hoverColor=""
            />,
        );

        const buttons = screen.getAllByRole('button');
        fireEvent.click(buttons[buttons.length - 1]);

        expect(screen.getByTestId('tool-help-modal')).toBeTruthy();
        expect(screen.getByText('Mô tả ngắn của công cụ')).toBeTruthy();
        expect(screen.getByTestId('tool-help-modal').querySelector('h2')?.textContent).toBe('Công cụ thử');
    });

    it('Enter/Space trên Help không kích hoạt primary tool', () => {
        const onClick = vi.fn();
        render(
            <ToolItem
                icon="🪄"
                label="Công cụ thử"
                info="Mô tả ngắn của công cụ"
                helpKey="missing-help-entry"
                onClick={onClick}
                hoverColor=""
            />,
        );

        const buttons = screen.getAllByRole('button');
        fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Enter' });
        expect(onClick).not.toHaveBeenCalled();
        fireEvent.keyDown(buttons[buttons.length - 1], { key: ' ' });
        expect(onClick).not.toHaveBeenCalled();
    });
});
