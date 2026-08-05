// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import StickerSheetWorkspace from './StickerSheetWorkspace';
import { useStickerSheetStore } from './stickerSheetStore';


function fireCanvasPointer(
    canvas: HTMLCanvasElement,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    options: { pointerId: number; button?: number; clientX: number; clientY: number },
) {
    const event = new MouseEvent(type, {
        bubbles: true,
        button: options.button ?? 0,
        clientX: options.clientX,
        clientY: options.clientY,
    });
    Object.defineProperty(event, 'pointerId', { value: options.pointerId });
    fireEvent(canvas, event);
}


class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage(message: { type: string; requestId?: number }) {
        if (message.type === 'init') {
            this.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
        } else if (message.type === 'render') {
            this.onmessage?.({
                data: {
                    type: 'rendered', requestId: message.requestId, width: 100, height: 80,
                    overlay: new Uint8ClampedArray(100 * 80 * 4),
                },
            } as MessageEvent);
        }
    }
    terminate() {}
}

describe('StickerSheetWorkspace - tách thao tác view và sửa mask', () => {
    beforeEach(() => {
        vi.stubGlobal('Worker', FakeWorker);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
            configurable: true,
            value: vi.fn(() => ({
                drawImage: vi.fn(),
                getImageData: vi.fn(() => new ImageData(100, 80)),
                putImageData: vi.fn(),
            })),
        });
        Object.defineProperty(HTMLCanvasElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
        Object.defineProperty(HTMLCanvasElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
        Object.defineProperty(HTMLCanvasElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) });
        Object.defineProperty(HTMLCanvasElement.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80, x: 0, y: 0, toJSON: () => ({}) }),
        });
        class FakeImage {
            decoding = '';
            src = '';
            decode = vi.fn(async () => undefined);
        }
        vi.stubGlobal('Image', FakeImage);

        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...useStickerSheetStore.getState().getTab('new'),
                    mode: 'ai-sheet', status: 'ready',
                    sourceFile: new File(['image'], 'sheet.png', { type: 'image/png' }),
                    previewUrl: 'blob:preview', labelsUrl: 'blob:labels', uncertaintyUrl: 'blob:uncertainty',
                    selectedInstanceId: 1,
                    manifest: {
                        session_id: 'a'.repeat(32), original_name: 'sheet.png',
                        original_width_px: 100, original_height_px: 80,
                        analysis_width_px: 100, analysis_height_px: 80,
                        preview_width_px: 100, preview_height_px: 80,
                        dpi: null, model: 'birefnet-lite', model_seconds: 1, postprocess_seconds: 0.1,
                        instances: [{ id: 1, x: 5, y: 5, width: 80, height: 60, area_px: 4000, confidence: 0.9, uncertain_ratio: 0.1 }],
                        warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
                    },
                },
            },
        });
    });

    it('hand và Space pan không sinh stroke; edit mới được sửa mask', () => {
        render(<StickerSheetWorkspace tabId="tab" isActive />);
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireEvent.click(screen.getByRole('button', { name: 'Di chuyển' }));
        fireCanvasPointer(canvas, 'pointerdown', { pointerId: 1, clientX: 20, clientY: 20 });
        fireCanvasPointer(canvas, 'pointermove', { pointerId: 1, clientX: 40, clientY: 35 });
        fireCanvasPointer(canvas, 'pointerup', { pointerId: 1, clientX: 40, clientY: 35 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: 'Sửa vùng tem' }));
        const workspace = screen.getByTestId('sticker-sheet-workspace');
        fireEvent.keyDown(workspace, { code: 'Space', key: ' ' });
        fireCanvasPointer(canvas, 'pointerdown', { pointerId: 2, clientX: 30, clientY: 30 });
        fireCanvasPointer(canvas, 'pointerup', { pointerId: 2, clientX: 30, clientY: 30 });
        fireEvent.keyUp(workspace, { code: 'Space', key: ' ' });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);

        fireCanvasPointer(canvas, 'pointerdown', { pointerId: 3, clientX: 30, clientY: 30 });
        fireCanvasPointer(canvas, 'pointerup', { pointerId: 3, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
    });

    it('tab nền không nhận thao tác sửa mask', () => {
        render(<StickerSheetWorkspace tabId="tab" isActive={false} />);
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireCanvasPointer(canvas, 'pointerdown', { pointerId: 1, clientX: 30, clientY: 30 });
        fireCanvasPointer(canvas, 'pointerup', { pointerId: 1, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);
    });

    it('đăng ký cuộn chuột non-passive để pan và zoom không phát cảnh báo WebView', () => {
        const addEventListener = vi.spyOn(HTMLElement.prototype, 'addEventListener');
        render(<StickerSheetWorkspace tabId="tab" isActive />);
        expect(addEventListener).toHaveBeenCalledWith(
            'wheel',
            expect.any(Function),
            { passive: false },
        );
        addEventListener.mockRestore();
    });
});
