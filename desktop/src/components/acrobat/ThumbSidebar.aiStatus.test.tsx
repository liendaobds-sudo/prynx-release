// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
    ThumbWorkflowBadge,
    type ThumbPageWorkflowStatus,
} from './ThumbSidebar';


describe('ThumbSidebar — trạng thái nhận diện AI theo trang nguồn', () => {
    it.each([
        ['pending', 'Chưa nhận diện'],
        ['processing', 'Đang nhận diện'],
        ['review', 'Cần xác nhận'],
        ['ready', 'Sẵn sàng'],
        ['error', 'Lỗi'],
    ] as Array<[ThumbPageWorkflowStatus, string]>)('%s: hiện nhãn tiếng Việt rõ ràng', (status, label) => {
        render(<ThumbWorkflowBadge status={status} pageLabel={3} />);

        const badge = screen.getByLabelText(`Trang 3: ${label}`);
        expect(badge.getAttribute('data-workflow-status')).toBe(status);
        expect(badge.getAttribute('title')).toBe(label);
    });

});
