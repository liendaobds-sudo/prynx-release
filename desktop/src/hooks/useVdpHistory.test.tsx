// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVdpHistory } from './useVdpHistory';

interface MockField {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

describe('useVdpHistory', () => {
    let mockContainer: HTMLDivElement;
    let parentDiv: HTMLDivElement;

    beforeEach(() => {
        vi.useFakeTimers();
        parentDiv = document.createElement('div');
        parentDiv.style.position = 'relative';
        document.body.appendChild(parentDiv);

        mockContainer = document.createElement('div');
        mockContainer.style.position = 'absolute';
        parentDiv.appendChild(mockContainer);

        // Giả lập offsetParent cho jsdom
        Object.defineProperty(mockContainer, 'offsetParent', {
            get: () => parentDiv,
            configurable: true,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        if (parentDiv.parentNode) {
            parentDiv.parentNode.removeChild(parentDiv);
        }
    });

    it('hoàn tác (Ctrl+Z) khi di chuyển trường VDP', () => {
        const initialFields: MockField[] = [{ id: 'f1', name: 'Field 1', x: 10, y: 10, width: 50, height: 20 }];
        let currentFields = initialFields;
        const setVdpFields = vi.fn((updater) => {
            if (typeof updater === 'function') {
                currentFields = updater(currentFields);
            } else {
                currentFields = updater;
            }
        });

        const { rerender } = renderHook(
            ({ fields }) => useVdpHistory({
                vdpFields: fields,
                setVdpFields,
                enabled: true,
                containerRef: { current: mockContainer },
            }),
            { initialProps: { fields: initialFields } }
        );

        // Người dùng kéo di chuyển trường sang x=50, y=50
        const movedFields: MockField[] = [{ id: 'f1', name: 'Field 1', x: 50, y: 50, width: 50, height: 20 }];
        currentFields = movedFields;
        rerender({ fields: movedFields });

        // Chờ thời gian coalesce (400ms)
        act(() => {
            vi.advanceTimersByTime(500);
        });

        // Người dùng bấm Ctrl+Z
        act(() => {
            const event = new KeyboardEvent('keydown', {
                key: 'z',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            });
            window.dispatchEvent(event);
        });

        // setVdpFields phải được gọi với trạng thái ban đầu
        expect(setVdpFields).toHaveBeenCalledWith(initialFields);
        expect(currentFields).toEqual(initialFields);
    });

    it('hoàn tác ngay cả khi bấm Ctrl+Z trước 400ms (flushBurst)', () => {
        const initialFields: MockField[] = [{ id: 'f1', name: 'Field 1', x: 10, y: 10, width: 50, height: 20 }];
        let currentFields = initialFields;
        const setVdpFields = vi.fn((updater) => {
            if (typeof updater === 'function') {
                currentFields = updater(currentFields);
            } else {
                currentFields = updater;
            }
        });

        const { rerender } = renderHook(
            ({ fields }) => useVdpHistory({
                vdpFields: fields,
                setVdpFields,
                enabled: true,
                containerRef: { current: mockContainer },
            }),
            { initialProps: { fields: initialFields } }
        );

        // Kéo di chuyển
        const movedFields: MockField[] = [{ id: 'f1', name: 'Field 1', x: 100, y: 100, width: 50, height: 20 }];
        currentFields = movedFields;
        rerender({ fields: movedFields });

        // Bấm Ctrl+Z ngay lập tức (chỉ 50ms sau khi kéo)
        act(() => {
            vi.advanceTimersByTime(50);
            const event = new KeyboardEvent('keydown', {
                key: 'z',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            });
            window.dispatchEvent(event);
        });

        expect(setVdpFields).toHaveBeenCalledWith(initialFields);
    });

    it('làm lại (Ctrl+Y và Ctrl+Shift+Z) sau khi hoàn tác', () => {
        const initialFields: MockField[] = [{ id: 'f1', name: 'Field 1', x: 10, y: 10, width: 50, height: 20 }];
        let currentFields = initialFields;
        const setVdpFields = vi.fn((updater) => {
            if (typeof updater === 'function') {
                currentFields = updater(currentFields);
            } else {
                currentFields = updater;
            }
        });

        const { rerender } = renderHook(
            ({ fields }) => useVdpHistory({
                vdpFields: fields,
                setVdpFields,
                enabled: true,
                containerRef: { current: mockContainer },
            }),
            { initialProps: { fields: initialFields } }
        );

        const movedFields: MockField[] = [{ id: 'f1', name: 'Field 1', x: 50, y: 50, width: 50, height: 20 }];
        currentFields = movedFields;
        rerender({ fields: movedFields });

        act(() => {
            vi.advanceTimersByTime(500);
        });

        // Ctrl+Z
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        });
        expect(currentFields).toEqual(initialFields);

        // Rerender lại với initialFields sau undo
        rerender({ fields: initialFields });

        // Ctrl+Y (Redo)
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
        });
        expect(setVdpFields).toHaveBeenLastCalledWith(movedFields);
    });
});
