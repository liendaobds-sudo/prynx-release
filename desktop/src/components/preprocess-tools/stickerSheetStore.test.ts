import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    analyzeStickerSheet,
    closeStickerSheetSession,
    exportStickerSheet,
    type StickerSheetAnalysisPayload,
} from '../../lib/stickerSheetApi';
import { useStickerSheetStore } from './stickerSheetStore';


vi.mock('../../lib/stickerSheetApi', () => ({
    analyzeStickerSheet: vi.fn(),
    closeStickerSheetSession: vi.fn(async () => undefined),
    exportStickerSheet: vi.fn(),
}));

function payload(sessionId = 'a'.repeat(32)): StickerSheetAnalysisPayload {
    return {
        manifest: {
            session_id: sessionId,
            original_name: 'sheet.png',
            original_width_px: 120,
            original_height_px: 80,
            analysis_width_px: 120,
            analysis_height_px: 80,
            preview_width_px: 120,
            preview_height_px: 80,
            dpi: [300, 300],
            model: 'birefnet-lite',
            model_seconds: 1,
            postprocess_seconds: 0.1,
            instances: [
                { id: 1, x: 1, y: 2, width: 30, height: 20, area_px: 500, confidence: 0.9, uncertain_ratio: 0.1 },
            ],
            warnings: [],
            preview_url: '/preview',
            labels_url: '/labels',
            uncertainty_url: '/uncertainty',
        },
        previewBlob: new Blob(['preview']),
        labelsBlob: new Blob(['labels']),
        uncertaintyBlob: new Blob(['uncertainty']),
    };
}

function payloadWithoutDpi(): StickerSheetAnalysisPayload {
    const result = payload('b'.repeat(32));
    return { ...result, manifest: { ...result.manifest, dpi: null } };
}

describe('stickerSheetStore — state theo tab và vòng đời mask', () => {
    beforeEach(() => {
        useStickerSheetStore.setState({ tabs: {} });
        vi.clearAllMocks();
        let index = 0;
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => `blob:mask-${++index}`),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
    });

    it('phân tích ảnh và giữ kết quả độc lập cho đúng tab', async () => {
        vi.mocked(analyzeStickerSheet).mockResolvedValue(payload());
        const file = new File(['image'], 'sheet.png', { type: 'image/png' });

        await useStickerSheetStore.getState().analyze('tab-a', file);

        const tabA = useStickerSheetStore.getState().getTab('tab-a');
        const tabB = useStickerSheetStore.getState().getTab('tab-b');
        expect(tabA.status).toBe('ready');
        expect(tabA.mode).toBe('ai-sheet');
        expect(tabA.manifest?.instances).toHaveLength(1);
        expect(tabA.previewUrl).toBe('blob:mask-1');
        expect(tabA.selectedInstanceId).toBe(1);
        expect(tabA.outputDpi).toBe(300);
        expect(tabB.status).toBe('idle');
    });

    it('ảnh không DPI giữ cùng quy ước 72 DPI của cửa mở ảnh', async () => {
        vi.mocked(analyzeStickerSheet).mockResolvedValue(payloadWithoutDpi());
        await useStickerSheetStore.getState().analyze(
            'tab-no-dpi', new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        expect(useStickerSheetStore.getState().getTab('tab-no-dpi').outputDpi).toBe(72);
        expect(useStickerSheetStore.getState().getTab('tab-no-dpi').outputDpiY).toBe(72);
    });

    it('undo/redo giữ đúng thứ tự stroke và merge', () => {
        const store = useStickerSheetStore.getState();
        store.addStroke('tab', {
            tool: 'erase', instanceId: 1, radius: 0.02, points: [{ x: 0.2, y: 0.3 }],
        });
        store.mergeInstance('tab', 2, 1);
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(2);

        useStickerSheetStore.getState().undo('tab');
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(1);
        expect(useStickerSheetStore.getState().getTab('tab').redoEdits).toHaveLength(1);

        useStickerSheetStore.getState().redo('tab');
        expect(useStickerSheetStore.getState().getTab('tab').edits).toHaveLength(2);
        expect(useStickerSheetStore.getState().getTab('tab').redoEdits).toHaveLength(0);
    });

    it('reset thu hồi URL và đóng session backend', async () => {
        vi.mocked(analyzeStickerSheet).mockResolvedValue(payload());
        await useStickerSheetStore.getState().analyze(
            'tab', new File(['image'], 'sheet.png', { type: 'image/png' }),
        );

        useStickerSheetStore.getState().resetAnalysis('tab');

        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
        expect(closeStickerSheetSession).toHaveBeenCalledWith('a'.repeat(32));
        expect(useStickerSheetStore.getState().getTab('tab').status).toBe('idle');
    });

    it('không cho cọ vượt giới hạn chuẩn hóa', () => {
        useStickerSheetStore.getState().setBrushRadius('tab', 10);
        expect(useStickerSheetStore.getState().getTab('tab').brushRadius).toBe(0.08);
        useStickerSheetStore.getState().setBrushRadius('tab', -1);
        expect(useStickerSheetStore.getState().getTab('tab').brushRadius).toBe(0.002);
    });

    it('xuất PDF bằng đúng session, edit và kích thước đã chọn', async () => {
        vi.mocked(analyzeStickerSheet).mockResolvedValue(payload());
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']), filename: 'tem.pdf', outputPath: 'D:\\results\\tem.pdf', stickerCount: 1,
        });
        await useStickerSheetStore.getState().analyze(
            'tab', new File(['image'], 'sheet.png', { type: 'image/png' }),
        );
        useStickerSheetStore.getState().addStroke('tab', {
            tool: 'erase', instanceId: 1, radius: 0.01, points: [{ x: 0.1, y: 0.2 }],
        });
        useStickerSheetStore.getState().setOutputSettings('tab', { outputDpi: 600, outputDpiY: 600, offsetMm: -0.2, bleedMm: 3 });

        const result = await useStickerSheetStore.getState().exportFile('tab');

        expect(result?.filename).toBe('tem.pdf');
        expect(exportStickerSheet).toHaveBeenCalledWith(
            'a'.repeat(32),
            expect.objectContaining({ dpi: 600, dpiY: 600, offsetMm: -0.2, bleedMm: 3, outputFormat: 'pdf' }),
        );
        expect(useStickerSheetStore.getState().getTab('tab').isExporting).toBe(false);
    });
});
