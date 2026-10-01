// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VdpRecordNavigatorBar } from './VdpRecordNavigatorBar';
import type { VdpLivePreviewState } from '../../stores/useWorkspaceStore';

// Mock i18next
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: string) => fallback || key,
    }),
}));

// Polyfill PointerEvent cho môi trường JSDOM
if (typeof window !== 'undefined' && !window.PointerEvent) {
    class MockPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, params: any = {}) {
            super(type, params);
            this.pointerId = params.pointerId ?? 0;
        }
    }
    window.PointerEvent = MockPointerEvent as any;
}
if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
}

describe('VdpRecordNavigatorBar', () => {
    const mockPreviewState: VdpLivePreviewState = {
        enabled: true,
        recordIndex: 2,
        totalRecords: 10,
        currentRecord: { Họ_và_tên: 'Nguyễn Văn A' },
        sourceTitle: 'danh_sach.xlsx',
        toolbarOffset: { x: 0, y: 0 },
    };

    it('không render khi vdpLivePreview rỗng hoặc totalRecords <= 0', () => {
        const { container: c1 } = render(
            <VdpRecordNavigatorBar vdpLivePreview={undefined} setVdpLivePreview={vi.fn()} />
        );
        expect(c1.firstChild).toBeNull();

        const { container: c2 } = render(
            <VdpRecordNavigatorBar
                vdpLivePreview={{ ...mockPreviewState, totalRecords: 0 }}
                setVdpLivePreview={vi.fn()}
            />
        );
        expect(c2.firstChild).toBeNull();
    });

    it('render đầy đủ các thành phần điều hướng và tên nguồn dữ liệu', () => {
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={mockPreviewState}
                setVdpLivePreview={vi.fn()}
            />
        );

        expect(screen.getByTestId('vdp-record-navigator-bar')).toBeTruthy();
        expect(screen.getByTestId('vdp-toolbar-grip')).toBeTruthy();
        expect(screen.getByTestId('vdp-toggle-preview-btn')).toBeTruthy();
        expect(screen.getByTestId('vdp-prev-record-btn')).toBeTruthy();
        expect(screen.getByTestId('vdp-next-record-btn')).toBeTruthy();
        const input = screen.getByTestId('vdp-record-index-input') as HTMLInputElement;
        expect(input.value).toBe('2');
        expect(screen.getByText('/ 10')).toBeTruthy();
        expect(screen.getByTestId('vdp-source-title').textContent).toContain('danh_sach.xlsx');
    });

    it('hỗ trợ cả class sáng (light) và tối (dark:*) để đi theo tone app', () => {
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={mockPreviewState}
                setVdpLivePreview={vi.fn()}
            />
        );

        const bar = screen.getByTestId('vdp-record-navigator-bar');
        expect(bar.className).toContain('bg-white/95');
        expect(bar.className).toContain('text-slate-800');
        expect(bar.className).toContain('border-slate-200/90');
        expect(bar.className).toContain('dark:bg-zinc-900/95');
        expect(bar.className).toContain('dark:text-zinc-100');
        expect(bar.className).toContain('dark:border-zinc-700/80');

        const prevBtn = screen.getByTestId('vdp-prev-record-btn');
        expect(prevBtn.className).toContain('bg-slate-100');
        expect(prevBtn.className).toContain('dark:bg-zinc-800');
        expect(prevBtn.className).toContain('dark:text-zinc-200');
    });

    it('bấm nút bật/tắt xem trước gọi setVdpLivePreview đảo trạng thái enabled', () => {
        const setVdp = vi.fn();
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={mockPreviewState}
                setVdpLivePreview={setVdp}
            />
        );

        fireEvent.click(screen.getByTestId('vdp-toggle-preview-btn'));
        expect(setVdp).toHaveBeenCalledTimes(1);
        const updater = setVdp.mock.calls[0][0];
        const nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.enabled).toBe(false);
    });

    it('bấm nút record trước và sau gọi setVdpLivePreview với chỉ số hợp lệ', () => {
        const setVdp = vi.fn();
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={mockPreviewState}
                setVdpLivePreview={setVdp}
            />
        );

        // Prev record: từ 2 -> 1
        fireEvent.click(screen.getByTestId('vdp-prev-record-btn'));
        expect(setVdp).toHaveBeenCalled();
        let updater = setVdp.mock.calls[0][0];
        let nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.recordIndex).toBe(1);

        // Next record: từ 2 -> 3
        fireEvent.click(screen.getByTestId('vdp-next-record-btn'));
        updater = setVdp.mock.calls[1][0];
        nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.recordIndex).toBe(3);
    });

    it('phát event đổi record kèm tabId để tab nền không nhận nhầm', () => {
        const eventSpy = vi.fn();
        window.addEventListener('vdp-preview-index-change', eventSpy);
        render(
            <VdpRecordNavigatorBar
                tabId="tab-a"
                vdpLivePreview={mockPreviewState}
                setVdpLivePreview={vi.fn()}
            />
        );

        fireEvent.click(screen.getByTestId('vdp-next-record-btn'));
        expect(eventSpy).toHaveBeenCalledTimes(1);
        expect((eventSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ index: 3, tabId: 'tab-a' });
        window.removeEventListener('vdp-preview-index-change', eventSpy);
    });

    it('hiện trạng thái rõ ràng khi record chưa có trong mẫu preview', () => {
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={{ ...mockPreviewState, recordIndex: 21, totalRecords: 25, currentRecord: null }}
                setVdpLivePreview={vi.fn()}
            />
        );
        expect(screen.getByTestId('vdp-record-preview-unavailable')).toBeTruthy();
    });

    it('nhập số vào ô record tự động clamp trong khoảng [1, totalRecords]', () => {
        const setVdp = vi.fn();
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={mockPreviewState}
                setVdpLivePreview={setVdp}
            />
        );

        const input = screen.getByTestId('vdp-record-index-input');
        fireEvent.change(input, { target: { value: '999' } });
        const updater = setVdp.mock.calls[0][0];
        const nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.recordIndex).toBe(10); // Capped at totalRecords
    });

    it('hỗ trợ kéo thả (drag) thanh điều hướng và cập nhật toolbarOffset', () => {
        const setVdp = vi.fn();
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={{ ...mockPreviewState, toolbarOffset: { x: 0, y: 0 } }}
                setVdpLivePreview={setVdp}
            />
        );

        const bar = screen.getByTestId('vdp-record-navigator-bar');
        // Mock setPointerCapture / releasePointerCapture for JSDOM
        bar.setPointerCapture = vi.fn();
        bar.releasePointerCapture = vi.fn();

        // Bắt đầu kéo
        fireEvent.pointerDown(bar, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
        expect(bar.setPointerCapture).toHaveBeenCalledWith(1);

        // Di chuyển pointer
        fireEvent.pointerMove(bar, { clientX: 150, clientY: 120, pointerId: 1 });

        // Kết thúc kéo
        fireEvent.pointerUp(bar, { clientX: 150, clientY: 120, pointerId: 1 });

        expect(setVdp).toHaveBeenCalled();
        const updater = setVdp.mock.calls[0][0];
        const nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.toolbarOffset).toEqual({ x: 50, y: 20 });
    });

    it('nhấp đúp vào tay nắm kéo để đặt lại vị trí về giữa { x: 0, y: 0 }', () => {
        const setVdp = vi.fn();
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={{ ...mockPreviewState, toolbarOffset: { x: 80, y: 40 } }}
                setVdpLivePreview={setVdp}
            />
        );

        const grip = screen.getByTestId('vdp-toolbar-grip');
        fireEvent.doubleClick(grip);

        expect(setVdp).toHaveBeenCalled();
        const updater = setVdp.mock.calls[0][0];
        const nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.toolbarOffset).toEqual({ x: 0, y: 0 });
    });

    it('nút reset vị trí hiển thị khi thanh bị kéo lệch và bấm vào sẽ trả về giữa', () => {
        const setVdp = vi.fn();
        render(
            <VdpRecordNavigatorBar
                vdpLivePreview={{ ...mockPreviewState, toolbarOffset: { x: 120, y: -30 } }}
                setVdpLivePreview={setVdp}
            />
        );

        const resetBtn = screen.getByTestId('vdp-reset-position-btn');
        expect(resetBtn).toBeTruthy();

        fireEvent.click(resetBtn);
        expect(setVdp).toHaveBeenCalled();
        const updater = setVdp.mock.calls[0][0];
        const nextState = typeof updater === 'function' ? updater(mockPreviewState) : updater;
        expect(nextState.toolbarOffset).toEqual({ x: 0, y: 0 });
    });
});
