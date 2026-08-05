// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { analyzeStickerSheet, exportStickerSheet } from '../../lib/stickerSheetApi';
import StickerCutlineTool from './StickerCutlineTool';
import { useStickerSheetStore } from './stickerSheetStore';


vi.mock('./StickerTool', () => ({ default: () => <div>existing</div> }));
vi.mock('./StickerSheetPanel', () => ({
    default: ({ onExport }: { onExport?: () => void }) => (
        <button type="button" onClick={onExport}>ai-export</button>
    ),
}));
vi.mock('../../lib/stickerSheetApi', () => ({
    analyzeStickerSheet: vi.fn(),
    closeStickerSheetSession: vi.fn(async () => undefined),
    exportStickerSheet: vi.fn(),
}));

describe('StickerCutlineTool - dùng lại ảnh đang mở', () => {
    beforeEach(() => {
        useStickerSheetStore.setState({ tabs: {} });
        vi.clearAllMocks();
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:asset'),
        });
        vi.mocked(analyzeStickerSheet).mockResolvedValue({
            manifest: {
                session_id: 'a'.repeat(32), original_name: 'current.png',
                original_width_px: 100, original_height_px: 80,
                analysis_width_px: 100, analysis_height_px: 80,
                preview_width_px: 100, preview_height_px: 80,
                dpi: null, model: 'birefnet-lite', model_seconds: 1, postprocess_seconds: 0.1,
                instances: [{ id: 1, x: 0, y: 0, width: 100, height: 80, area_px: 8000, confidence: 1, uncertain_ratio: 0 }],
                warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
            },
            previewBlob: new Blob(), labelsBlob: new Blob(), uncertaintyBlob: new Blob(),
        });
    });

    it('đổi mode ở tab active tự phân tích ảnh nguồn hiện tại', async () => {
        const source = new File(['image'], 'current.png', { type: 'image/png' });
        render(
            <StickerCutlineTool
                tabId="active-tab"
                pdfFile={null}
                sourceImageFile={source}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        await waitFor(() => expect(analyzeStickerSheet).toHaveBeenCalledWith(
            source,
            expect.objectContaining({ model: 'birefnet-lite' }),
        ));
    });

    it('tab nền không tự phân tích ảnh', async () => {
        const source = new File(['image'], 'background.png', { type: 'image/png' });
        render(
            <StickerCutlineTool
                tabId="background-tab"
                pdfFile={null}
                sourceImageFile={source}
                isActive={false}
                onFileFixed={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        await Promise.resolve();
        expect(analyzeStickerSheet).not.toHaveBeenCalled();
    });

    it('tạo PDF xong mở kết quả trong viewer nhưng không chuyển sang Bình tem bế', async () => {
        const source = new File(['image'], 'current.png', { type: 'image/png' });
        const onFileFixed = vi.fn(async () => undefined);
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']),
            filename: 'tem_cutcontour.pdf',
            outputPath: 'D:\\results\\tem_cutcontour.pdf',
            stickerCount: 1,
        });
        render(
            <StickerCutlineTool
                tabId="active-tab"
                pdfFile={null}
                sourceImageFile={source}
                isActive
                onFileFixed={onFileFixed}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Ảnh AI nhiều tem' }));
        await waitFor(() => expect(analyzeStickerSheet).toHaveBeenCalled());
        fireEvent.click(screen.getByRole('button', { name: 'ai-export' }));

        await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(
            expect.any(Blob),
            'tem_cutcontour.pdf',
            'D:\\results\\tem_cutcontour.pdf',
        ));
        expect(useStickerSheetStore.getState().getTab('active-tab').mode).toBe('existing');
        expect(screen.getByText('existing')).toBeTruthy();
    });
});
