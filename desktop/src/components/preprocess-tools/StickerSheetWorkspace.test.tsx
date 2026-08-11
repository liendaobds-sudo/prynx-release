// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { detectStickerSource, inspectStickerSource } from '../../lib/stickerSheetApi';
import StickerSheetWorkspace from './StickerSheetWorkspace';
import { useStickerSheetStore } from './stickerSheetStore';


vi.mock('../../lib/stickerSheetApi', async importOriginal => {
    const actual = await importOriginal<typeof import('../../lib/stickerSheetApi')>();
    return {
        ...actual,
        detectStickerSource: vi.fn(),
        inspectStickerSource: vi.fn(),
    };
});

function fireWorkspacePointer(
    element: HTMLElement,
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
    fireEvent(element, event);
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
        vi.clearAllMocks();
        vi.stubGlobal('Worker', FakeWorker);
        let frameId = 0;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = ++frameId;
            void Promise.resolve().then(() => callback(0));
            return id;
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
        Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
        Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
        Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) });
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
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:source-preview'),
        });

        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...useStickerSheetStore.getState().getTab('new'),
                    status: 'mask-review',
                    sourceFile: new File(['image'], 'sheet.png', { type: 'image/png' }),
                    previewUrl: 'blob:preview', labelsUrl: 'blob:labels', uncertaintyUrl: 'blob:uncertainty',
                    selectedInstanceId: 1,
                    manifest: {
                        session_id: 'a'.repeat(32), original_name: 'sheet.png',
                        stage: 'mask-review', source_kind: 'raster', boundary_source: 'alpha',
                        strategy_confidence: 0.98, needs_review: true, page_count: 1, source_page: 1,
                        vector_geometry_ref: null,
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
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 20, clientY: 20 });
        fireWorkspacePointer(canvas, 'pointermove', { pointerId: 1, clientX: 40, clientY: 35 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 1, clientX: 40, clientY: 35 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: 'Sửa vùng tem' }));
        const workspace = screen.getByTestId('sticker-sheet-workspace');
        fireEvent.keyDown(workspace, { code: 'Space', key: ' ' });
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 2, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 2, clientX: 30, clientY: 30 });
        fireEvent.keyUp(workspace, { code: 'Space', key: ' ' });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);

        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 3, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 3, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
    });

    it('Ctrl+Z hoàn tác nét cọ; Ctrl+Y và Ctrl+Shift+Z làm lại', () => {
        render(<StickerSheetWorkspace tabId="tab" isActive />);
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 21, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 21, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);

        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);
        expect(useStickerSheetStore.getState().getTab('tab').redoEdits).toHaveLength(1);

        fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
        expect(useStickerSheetStore.getState().getTab('tab').redoEdits).toHaveLength(0);

        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
        expect(useStickerSheetStore.getState().getTab('tab').redoEdits).toHaveLength(0);
    });

    it('phím tắt lịch sử hoạt động trong Viewer nhúng', () => {
        render(
            <StickerSheetWorkspace
                tabId="tab"
                isActive
                embedded
                editingEnabled
                sourcePage={1}
            />,
        );
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 22, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 22, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);

        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);
        expect(useStickerSheetStore.getState().getTab('tab').redoEdits).toHaveLength(1);
    });

    it('không giành Ctrl+Z khi đang nhập liệu', () => {
        render(
            <>
                <input aria-label="Ô nhập" />
                <textarea aria-label="Vùng nhập" />
                <select aria-label="Danh sách"><option>1</option></select>
                <div aria-label="Vùng soạn thảo" contentEditable />
                <StickerSheetWorkspace tabId="tab" isActive />
            </>,
        );
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 23, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 23, clientX: 30, clientY: 30 });

        for (const label of ['Ô nhập', 'Vùng nhập', 'Danh sách', 'Vùng soạn thảo']) {
            fireEvent.keyDown(screen.getByLabelText(label), { key: 'z', ctrlKey: true });
            expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
        }
    });

    it('tab nền không nhận phím tắt lịch sử', () => {
        const { rerender } = render(<StickerSheetWorkspace tabId="tab" isActive />);
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 24, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 24, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);

        rerender(<StickerSheetWorkspace tabId="tab" isActive={false} />);
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
    });

    it('hiển thị vòng tròn đúng đường kính cọ và cập nhật ngay khi đổi cỡ', async () => {
        render(<StickerSheetWorkspace tabId="tab" isActive />);
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        const cursor = screen.getByTestId('sticker-brush-cursor') as unknown as SVGGElement;
        const innerCircle = cursor.querySelectorAll('circle')[1];

        expect(cursor.getAttribute('opacity')).toBe('0');
        fireWorkspacePointer(canvas, 'pointermove', {
            pointerId: 11,
            clientX: 30,
            clientY: 30,
        });

        expect(cursor.getAttribute('transform')).toBe('translate(30 30)');
        expect(innerCircle?.getAttribute('r')).toBe('1.5');
        expect(innerCircle?.getAttribute('vector-effect')).toBe('non-scaling-stroke');
        expect(cursor.getAttribute('opacity')).toBe('1');

        act(() => useStickerSheetStore.getState().setBrushRadius('tab', 0.04));
        await waitFor(() => {
            expect(innerCircle?.getAttribute('r')).toBe('4');
        });

        fireEvent.click(screen.getByRole('button', { name: '+' }));
        await waitFor(() => {
            expect((cursor.closest('svg')?.parentElement as HTMLElement).style.transform)
                .toBe('scale(1.2)');
        });

        fireEvent.keyDown(screen.getByTestId('sticker-sheet-workspace'), {
            code: 'Space',
            key: ' ',
        });
        expect(cursor.getAttribute('opacity')).toBe('0');
    });

    it('tab nền không nhận thao tác sửa mask', () => {
        render(<StickerSheetWorkspace tabId="tab" isActive={false} />);
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        expect(canvas.className).not.toContain('cursor-none');
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 1, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);
    });

    it('vẽ Bézier CutContour bằng SVG và ẩn đường pixel thô của mask', () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    cutlinePreview: {
                        page_number: 1,
                        mask_revision: 1,
                        preview_width_px: 100,
                        preview_height_px: 80,
                        paths: [{
                            instance_id: 1,
                            d: 'M 5 5 C 15 5 20 10 25 20 Z',
                            segment_count: 1,
                        }],
                        fingerprint: 'c'.repeat(64),
                        segment_count: 1,
                    },
                },
            },
        });

        render(<StickerSheetWorkspace tabId="tab" isActive />);

        const svg = screen.getByTestId('sticker-cutline-preview');
        expect(svg.getAttribute('viewBox')).toBe('0 0 100 80');
        expect(svg.querySelector('path')?.getAttribute('d'))
            .toBe('M 5 5 C 15 5 20 10 25 20 Z');
        expect((document.querySelector('canvas') as HTMLCanvasElement).className)
            .toContain('opacity-0');
    });

    it('khóa cọ trên canvas trong lúc cập nhật preview AI', () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({
            tabs: { tab: { ...current, isRefining: true } },
        });
        render(<StickerSheetWorkspace tabId="tab" isActive />);
        const editButton = screen.getByRole('button', { name: 'Sửa vùng tem' });
        expect((editButton as HTMLButtonElement).disabled).toBe(true);

        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 1, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 1, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);
    });

    it('chế độ nhúng chỉ phủ kết quả AI lên trang, không dựng một Viewer thứ hai', () => {
        const { rerender } = render(
            <StickerSheetWorkspace
                tabId="tab"
                isActive
                embedded
                editingEnabled={false}
            />,
        );

        expect(screen.getByTestId('sticker-sheet-page-overlay')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Phóng to' })).toBeNull();
        expect(screen.queryByText('Di chuyển')).toBeNull();

        let canvas = document.querySelector('canvas') as HTMLCanvasElement;
        const brushCursor = screen.getByTestId('sticker-brush-cursor');
        expect(canvas.className).toContain('pointer-events-none');
        fireWorkspacePointer(canvas, 'pointermove', { pointerId: 8, clientX: 30, clientY: 30 });
        expect(brushCursor.getAttribute('opacity')).toBe('0');
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 8, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 8, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(0);

        rerender(
            <StickerSheetWorkspace
                tabId="tab"
                isActive
                embedded
                editingEnabled
            />,
        );
        canvas = document.querySelector('canvas') as HTMLCanvasElement;
        expect(canvas.className).toContain('pointer-events-auto');
        expect(canvas.className).toContain('cursor-none');
        fireWorkspacePointer(canvas, 'pointermove', { pointerId: 9, clientX: 30, clientY: 30 });
        expect(brushCursor.getAttribute('opacity')).toBe('1');
        fireWorkspacePointer(canvas, 'pointerdown', { pointerId: 9, clientX: 30, clientY: 30 });
        fireWorkspacePointer(canvas, 'pointerup', { pointerId: 9, clientX: 30, clientY: 30 });
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
    });

    it('chế độ nhúng không che Viewer trước khi có kết quả nhận diện', () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    status: 'source-ready',
                    manifest: null,
                    previewUrl: '',
                    labelsUrl: '',
                    uncertaintyUrl: '',
                },
            },
        });

        const { container } = render(
            <StickerSheetWorkspace
                tabId="tab"
                isActive
                embedded
                editingEnabled
            />,
        );

        expect(container.firstChild).toBeNull();
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

    it('đổi thumbnail thì đọc đúng mask và edit của trang nguồn tương ứng', async () => {
        useStickerSheetStore.getState().setActivePage('tab', 1);
        const seeded = useStickerSheetStore.getState().getTab('tab');
        const pageOne = seeded.pages[1];
        if (!pageOne?.manifest) throw new Error('Thiếu fixture trang 1');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...seeded,
                    inspection: {
                        session_id: 'a'.repeat(32), stage: 'inspected', original_name: 'batch.pdf',
                        source_kind: 'pdf', mime_type: 'application/pdf', boundary_source: 'ai',
                        strategy_confidence: 0.9, needs_review: true, page_count: 2,
                        source_width_px: 100, source_height_px: 80, dpi: null,
                        physical_width_mm: null, physical_height_mm: null,
                        preview_width_px: 100, preview_height_px: 80,
                        has_existing_cut: false, has_vector: false, has_raster: true,
                        has_alpha: false, cut_contour_count: 0,
                        pages: [1, 2].map(page_number => ({
                            page_number, width_mm: null, height_mm: null,
                            has_existing_cut: false, has_vector: false, has_raster: true,
                            has_alpha: false, cut_contour_count: 0,
                        })),
                        warnings: [], preview_url: '/source-preview',
                    },
                    pages: {
                        1: pageOne,
                        2: {
                            ...pageOne,
                            previewUrl: 'blob:preview-page-2',
                            labelsUrl: 'blob:labels-page-2',
                            uncertaintyUrl: 'blob:uncertainty-page-2',
                            selectedInstanceId: 2,
                            edits: [],
                            manifest: {
                                ...pageOne.manifest,
                                source_page: 2,
                                page_count: 2,
                                preview_url: '/preview?page=2',
                                labels_url: '/labels?page=2',
                                uncertainty_url: '/uncertainty?page=2',
                            },
                        },
                    },
                },
            },
        });

        render(
            <StickerSheetWorkspace
                tabId="tab"
                isActive
                embedded
                editingEnabled
                sourcePage={2}
            />,
        );

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab').activeSourcePage,
        ).toBe(2));
        expect((screen.getByAltText('Ảnh tem đã khử nền') as HTMLImageElement).src)
            .toContain('blob:preview-page-2');
        expect(useStickerSheetStore.getState().getTab('tab').selectedInstanceId).toBe(2);
    });

    it('chọn file ở workspace chỉ hiện preview gốc, không tự nhận diện', () => {
        useStickerSheetStore.setState({ tabs: {} });
        const { container } = render(<StickerSheetWorkspace tabId="source-tab" isActive />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['image'], 'source.png', { type: 'image/png' });

        fireEvent.change(input, { target: { files: [file] } });

        const state = useStickerSheetStore.getState().getTab('source-tab');
        expect(state.status).toBe('source-ready');
        expect(state.sourceFile).toBe(file);
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
        expect(screen.getByAltText('Ảnh gốc chưa nhận diện')).toBeTruthy();
        expect(screen.getByText('File gốc · chưa nhận diện')).toBeTruthy();
    });

    it('preview gốc cho phép thu phóng và kéo trước khi nhận diện', async () => {
        useStickerSheetStore.setState({ tabs: {} });
        const { container } = render(<StickerSheetWorkspace tabId="source-tab" isActive />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['image'], 'source.png', { type: 'image/png' });
        fireEvent.change(input, { target: { files: [file] } });

        fireEvent.click(screen.getByRole('button', { name: 'Phóng to' }));
        expect(screen.getByRole('button', { name: 'Đặt lại vùng xem' }).textContent).toBe('120%');

        const image = screen.getByAltText('Ảnh gốc chưa nhận diện');
        fireWorkspacePointer(image, 'pointerdown', { pointerId: 7, clientX: 20, clientY: 20 });
        fireWorkspacePointer(image, 'pointermove', { pointerId: 7, clientX: 45, clientY: 35 });
        fireWorkspacePointer(image, 'pointerup', { pointerId: 7, clientX: 45, clientY: 35 });

        const panLayer = screen.getByTestId('sticker-source-pan-layer');
        await waitFor(() => {
            expect(panLayer.style.transform).toContain('translate3d(25px, 15px, 0)');
        });
        expect(useStickerSheetStore.getState().getTab('source-tab').edits).toHaveLength(0);
    });

    it('thả file ở workspace cũng chỉ chọn nguồn', () => {
        useStickerSheetStore.setState({ tabs: {} });
        render(<StickerSheetWorkspace tabId="drop-tab" isActive />);
        const file = new File(['image'], 'dropped.jpg', { type: 'image/jpeg' });

        fireEvent.drop(screen.getByRole('button', { name: /Nhận diện và tạo đường cắt/ }), {
            dataTransfer: { files: [file] },
        });

        expect(useStickerSheetStore.getState().getTab('drop-tab').status).toBe('source-ready');
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
        expect(screen.getByAltText('Ảnh gốc chưa nhận diện')).toBeTruthy();
    });
});
