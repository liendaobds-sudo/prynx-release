// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NewDocumentModal from './NewDocumentModal';

afterEach(cleanup);

describe('NewDocumentModal', () => {
    it('giữ kích thước tùy chỉnh đến 0,1 mm có nghĩa trong tóm tắt', () => {
        render(<NewDocumentModal isOpen onClose={vi.fn()} onCreate={vi.fn()} />);

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
        const [widthInput, heightInput] = screen.getAllByRole('spinbutton');
        fireEvent.change(widthInput, { target: { value: '147.1' } });
        fireEvent.change(heightInput, { target: { value: '51.3' } });
        fireEvent.click(screen.getByRole('button', { name: 'Ngang' }));

        expect(screen.getByText('147.1 × 51.3 mm')).toBeTruthy();
    });
});
