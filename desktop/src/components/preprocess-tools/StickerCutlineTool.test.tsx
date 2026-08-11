// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    confirmStickerSource,
    detectStickerSource,
    exportStickerSheet,
    inspectStickerSource,
    previewStickerCutline,
    type StickerSourceDetectionPayload,
    type StickerSourceInspectPayload,
} from '../../lib/stickerSheetApi';
import StickerCutlineTool from './StickerCutlineTool';
import { useStickerSheetStore } from './stickerSheetStore';


vi.mock('./StickerTool', () => ({
    default: ({
        pdfFile,
        onProcessingChange,
    }: {
        pdfFile: File | null;
        onProcessingChange?: (processing: boolean) => void;
    }) => (
        <div>
            <div>direct-engine:{pdfFile?.name || 'none'}</div>
            <button type="button" onClick={() => onProcessingChange?.(true)}>start-direct</button>
            <button type="button" onClick={() => onProcessingChange?.(false)}>finish-direct</button>
        </div>
    ),
}));
vi.mock('../../lib/stickerSheetApi', () => ({
    closeStickerSheetSession: vi.fn(async () => undefined),
    confirmStickerSource: vi.fn(async () => true),
    detectStickerSource: vi.fn(),
    exportStickerSheet: vi.fn(),
    inspectStickerSource: vi.fn(),
    previewStickerCutline: vi.fn(),
}));

function inspection(): StickerSourceInspectPayload {
    return {
        inspection: {
            session_id: 'a'.repeat(32), stage: 'inspected', original_name: 'current.png',
            source_kind: 'raster', mime_type: 'image/png', boundary_source: 'alpha',
            strategy_confidence: 0.98, needs_review: false, page_count: 1,
            source_width_px: 100, source_height_px: 80, dpi: null,
            physical_width_mm: null, physical_height_mm: null,
            preview_width_px: 100, preview_height_px: 80,
            has_existing_cut: false, has_vector: false, has_raster: true, has_alpha: true,
            cut_contour_count: 0,
            pages: [{
                page_number: 1, width_mm: null, height_mm: null,
                has_existing_cut: false, has_vector: false, has_raster: true,
                has_alpha: true, cut_contour_count: 0,
            }],
            warnings: [], preview_url: '/source-preview',
        },
        previewBlob: new Blob(),
    };
}

function detection(needsReview = false): StickerSourceDetectionPayload {
    return {
        manifest: {
            session_id: 'a'.repeat(32), stage: 'mask-review', original_name: 'current.png',
            source_kind: 'raster', boundary_source: needsReview ? 'ai' : 'alpha',
            strategy_confidence: 0.98, needs_review: needsReview, page_count: 1,
            source_page: 1, vector_geometry_ref: null,
            original_width_px: 100, original_height_px: 80,
            analysis_width_px: 100, analysis_height_px: 80,
            preview_width_px: 100, preview_height_px: 80,
            dpi: null, model: 'birefnet-lite', model_seconds: 0, postprocess_seconds: 0.1,
            instances: [{
                id: 1, x: 0, y: 0, width: 100, height: 80,
                area_px: 8000, confidence: 1, uncertain_ratio: 0,
            }],
            warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
        },
        previewBlob: new Blob(), labelsBlob: new Blob(), uncertaintyBlob: new Blob(),
    };
}

describe('StickerCutlineTool — quay lại luồng cũ, AI là tùy chọn', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useStickerSheetStore.setState({ tabs: {} });
        vi.clearAllMocks();
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:asset'),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection());
        vi.mocked(detectStickerSource).mockResolvedValue(detection());
        vi.mocked(previewStickerCutline).mockResolvedValue({
            page_number: 1,
            mask_revision: 1,
            preview_width_px: 100,
            preview_height_px: 80,
            paths: [{
                instance_id: 1,
                d: 'M 1 1 C 2 2 3 3 4 4 Z',
                segment_count: 1,
            }],
            fingerprint: 'b'.repeat(64),
            segment_count: 1,
        });
    });

    it('mặc định trở lại PDF/PNG trực tiếp và không tự nhận diện', async () => {
        const pdf = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="direct-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        expect((screen.getByRole('button', { name: 'PDF/PNG đã có biên' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
        expect((screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
        await waitFor(() => expect(screen.getByText('direct-engine:current.pdf')).toBeTruthy());
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
    });

    it('chỉ mở pipeline AI sau khi người dùng chọn Ảnh AI nhiều tem', async () => {
        const image = new File(['image'], 'current.png', { type: 'image/png' });
        const pdf = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="ai-tab"
                pdfFile={pdf}
                sourceImageFile={image}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(screen.getByText('direct-engine:current.pdf')).toBeTruthy());
        expect(inspectStickerSource).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        expect(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' })).toBeTruthy();
        expect(screen.queryByRole('group', { name: 'Thiết lập đường bế tem' })).toBeNull();
        expect(inspectStickerSource).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
        await waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(confirmStickerSource).toHaveBeenCalledTimes(1));
        expect(useStickerSheetStore.getState().getTab('ai-tab').status).toBe('mask-ready');
    });

    it('AI giữ trạng thái cần xem lại nhưng cho phép sửa trực tiếp trên Viewer', async () => {
        vi.mocked(detectStickerSource).mockResolvedValueOnce(detection(true));
        const image = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
        render(
            <StickerCutlineTool
                tabId="review-tab"
                pdfFile={null}
                sourceImageFile={image}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('review-tab').status,
        ).toBe('mask-review'));
        expect(confirmStickerSource).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Xác nhận vùng tem' })).toBeNull();
        expect(screen.getByText('Sửa nhanh vùng tem')).toBeTruthy();
    });

    it('tab nền không nhận file đang mở', async () => {
        const source = new File(['image'], 'background.png', { type: 'image/png' });
        useStickerSheetStore.getState().initTab('background-tab');
        useStickerSheetStore.getState().setMode('background-tab', 'ai-sheet');
        render(
            <StickerCutlineTool
                tabId="background-tab"
                pdfFile={null}
                sourceImageFile={source}
                isActive={false}
                onFileFixed={vi.fn()}
            />,
        );
        await Promise.resolve();
        expect(useStickerSheetStore.getState().getTab('background-tab').sourceFile).toBeNull();
        expect(inspectStickerSource).not.toHaveBeenCalled();
    });

    it('đổi thumbnail chỉ đổi trang AI đang thao tác và không tự nhận diện', async () => {
        const document = new File(['pdf'], '2_anh_nhieu_tem.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().initTab('page-tab');
        useStickerSheetStore.getState().setMode('page-tab', 'ai-sheet');
        useStickerSheetStore.getState().selectSource('page-tab', document, 'explicit', 2);

        render(
            <StickerCutlineTool
                tabId="page-tab"
                pdfFile={document}
                sourceImageFile={null}
                activeSourcePage={2}
                pageOrder={[1, 2]}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('page-tab').activeSourcePage,
        ).toBe(2));
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
    });

    it('hai nút nguồn dùng chung mode với workspace nhưng không tự nhận diện', async () => {
        const image = new File(['image'], 'source.png', { type: 'image/png' });
        const pdf = new File(['pdf'], 'source.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="switch-tab"
                pdfFile={pdf}
                sourceImageFile={image}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' })).toBeTruthy());
        expect(screen.queryByRole('button', { name: 'Chọn ảnh khác' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'source.png' })).toBeNull();
        expect(useStickerSheetStore.getState().getTab('switch-tab').mode).toBe('ai-sheet');
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'PDF/PNG đã có biên' }));
        await waitFor(() => expect(screen.getByText('direct-engine:source.pdf')).toBeTruthy());
        expect(useStickerSheetStore.getState().getTab('switch-tab').mode).toBe('existing');
    });

    it('đổi tài liệu Viewer thì nguồn AI bám tài liệu mới, không giữ file riêng trong panel', async () => {
        const oldSource = new File(['old'], 'old.png', { type: 'image/png' });
        const viewerDocument = new File(['pdf'], 'viewer.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().initTab('viewer-source-tab');
        useStickerSheetStore.getState().setMode('viewer-source-tab', 'ai-sheet');
        useStickerSheetStore.getState().selectSource('viewer-source-tab', oldSource, 'explicit');

        render(
            <StickerCutlineTool
                tabId="viewer-source-tab"
                pdfFile={viewerDocument}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('viewer-source-tab').sourceFile,
        ).toBe(viewerDocument));
        expect(useStickerSheetStore.getState().getTab('viewer-source-tab').sourceOrigin)
            .toBe('workspace');
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
    });

    it('khóa đổi luồng nguồn trong lúc công cụ trực tiếp đang chạy', async () => {
        const pdf = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="busy-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );
        await waitFor(() => expect(screen.getByText('direct-engine:current.pdf')).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: 'start-direct' }));
        const aiButton = screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }) as HTMLButtonElement;
        expect(aiButton.disabled).toBe(true);
        fireEvent.click(aiButton);
        expect(screen.getByText('direct-engine:current.pdf')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'finish-direct' }));
        fireEvent.click(aiButton);
        expect(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' })).toBeTruthy();
    });

    it('AI giữ nguyên luồng sau export và mở đúng hai công cụ bình tem', async () => {
        useStickerSheetStore.getState().initTab('export-tab');
        const source = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        const current = useStickerSheetStore.getState().getTab('export-tab');
        useStickerSheetStore.setState({
            tabs: {
                'export-tab': {
                    ...current,
                    status: 'mask-ready',
                    sourceFile: source,
                    inspection: inspection().inspection,
                    manifest: detection().manifest,
                },
            },
        });
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']),
            filename: 'tem.pdf',
            outputPath: 'D:\\results\\tem.pdf',
            stickerCount: 1,
        });
        let resolveCommit!: () => void;
        const onFileFixed = vi.fn(() => new Promise<void>(resolve => {
            resolveCommit = resolve;
        }));
        const onOpenTool = vi.fn();
        const pdf = source;

        const { rerender } = render(
            <StickerCutlineTool
                tabId="export-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                isActive
                onOpenTool={onOpenTool}
                onFileFixed={onFileFixed}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        const exportButton = screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement;
        await waitFor(() => expect(exportButton.disabled).toBe(false));
        fireEvent.click(exportButton);
        await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
        expect(useStickerSheetStore.getState().getTab('export-tab').status).toBe('exporting');
        expect((screen.getByRole('button', { name: 'PDF/PNG đã có biên' }) as HTMLButtonElement).disabled).toBe(true);

        const generatedPdf = new File(['generated'], 'tem.pdf', { type: 'application/pdf' });
        rerender(
            <StickerCutlineTool
                tabId="export-tab"
                pdfFile={generatedPdf}
                sourceImageFile={null}
                isActive
                onOpenTool={onOpenTool}
                onFileFixed={onFileFixed}
            />,
        );
        resolveCommit();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Bình tem bế' })).toBeTruthy());
        const finished = useStickerSheetStore.getState().getTab('export-tab');
        expect(finished.mode).toBe('ai-sheet');
        expect(finished.status).toBe('mask-ready');
        expect(finished.manifest).not.toBeNull();
        expect(finished.sourceFile).toBe(source);
        expect(screen.queryByText('direct-engine:tem.pdf')).toBeNull();
        expect(screen.getByText(/tem\.pdf/)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Bình tem bế' }));
        fireEvent.click(screen.getByRole('button', { name: 'Bình bế rớt (CNC)' }));
        expect(onOpenTool).toHaveBeenNthCalledWith(1, 'sticker_imposer');
        expect(onOpenTool).toHaveBeenNthCalledWith(2, 'cnc_imposer');
    });

    it('chuyển đúng thứ tự thumbnail hiện tại vào cả lệnh xuất PDF', async () => {
        useStickerSheetStore.getState().initTab('order-tab');
        const source = new File(['image'], 'current.png', { type: 'image/png' });
        const current = useStickerSheetStore.getState().getTab('order-tab');
        useStickerSheetStore.setState({
            tabs: {
                'order-tab': {
                    ...current,
                    mode: 'ai-sheet',
                    status: 'mask-ready',
                    sourceFile: source,
                    manifest: detection().manifest,
                },
            },
        });
        useStickerSheetStore.getState().setActivePage('order-tab', 1);
        const prepared = useStickerSheetStore.getState().getTab('order-tab');
        const pageOne = prepared.pages[1];
        if (!pageOne?.manifest) throw new Error('Thiếu fixture trang 1');
        useStickerSheetStore.setState({
            tabs: {
                'order-tab': {
                    ...prepared,
                    sourceImageCount: 2,
                    pages: {
                        1: pageOne,
                        2: {
                            ...pageOne,
                            manifest: {
                                ...pageOne.manifest,
                                page_count: 2,
                                source_page: 2,
                            },
                        },
                    },
                },
            },
        });
        const exportAction = vi.spyOn(
            useStickerSheetStore.getState(),
            'exportFile',
        ).mockResolvedValue(null);

        render(
            <StickerCutlineTool
                tabId="order-tab"
                pdfFile={null}
                sourceImageFile={null}
                activeSourcePage={1}
                pageOrder={[2, 1]}
                isActive
                onFileFixed={vi.fn()}
            />,
        );
        const exportButton = screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement;
        await waitFor(() => expect(exportButton.disabled).toBe(false));
        fireEvent.click(exportButton);

        await waitFor(() => expect(exportAction).toHaveBeenCalledWith('order-tab', 'pdf', [2, 1]));
        exportAction.mockRestore();
    });
});
