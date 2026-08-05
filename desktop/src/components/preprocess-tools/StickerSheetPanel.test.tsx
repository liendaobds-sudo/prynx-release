// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import StickerSheetPanel from './StickerSheetPanel';
import { useStickerSheetStore } from './stickerSheetStore';


vi.mock('../../lib/stickerSheetApi', async importOriginal => {
    const actual = await importOriginal<typeof import('../../lib/stickerSheetApi')>();
    return { ...actual, warmupStickerSheet: vi.fn(async () => true) };
});

describe('StickerSheetPanel', () => {
    beforeEach(() => {
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...useStickerSheetStore.getState().getTab('new'),
                    mode: 'ai-sheet',
                    status: 'ready',
                    sourceFile: new File(['image'], 'sheet.png', { type: 'image/png' }),
                    manifest: {
                        session_id: 'a'.repeat(32), original_name: 'sheet.png',
                        original_width_px: 1200, original_height_px: 900,
                        analysis_width_px: 1200, analysis_height_px: 900,
                        preview_width_px: 1200, preview_height_px: 900,
                        dpi: null, model: 'birefnet-lite', model_seconds: 2,
                        postprocess_seconds: 0.2,
                        instances: [
                            { id: 1, x: 0, y: 0, width: 50, height: 50, area_px: 2000, confidence: 0.9, uncertain_ratio: 0.1 },
                            { id: 2, x: 60, y: 0, width: 50, height: 50, area_px: 2000, confidence: 0.5, uncertain_ratio: 0.5 },
                        ],
                        warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
                    },
                    previewUrl: 'blob:preview', labelsUrl: 'blob:labels', uncertaintyUrl: 'blob:uncertainty',
                    selectedInstanceId: 1,
                },
            },
        });
    });

    it('hiển thị số tem, chuyển công cụ và đi tới vùng mơ hồ nhất', () => {
        render(<StickerSheetPanel tabId="tab" />);
        expect(screen.getByText(/Đã nhận diện/).textContent).toContain('Đã nhận diện 2 tem');
        expect(screen.queryByText(/BiRefNet|OpenCV/i)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Giữ lại' }));
        expect(useStickerSheetStore.getState().getTab('tab').activeTool).toBe('restore');

        fireEvent.click(screen.getByRole('button', { name: 'Điểm cần kiểm tra tiếp theo' }));
        expect(useStickerSheetStore.getState().getTab('tab').selectedInstanceId).toBe(2);
    });

    it('hiện đúng kích thước pixel, không hiện cảnh báo DPI mâu thuẫn và khóa export chưa được nối', () => {
        render(<StickerSheetPanel tabId="tab" />);
        expect(screen.queryByText(/Ảnh không có DPI|300 DPI/)).toBeNull();
        expect(screen.queryByText('DPI X')).toBeNull();
        expect(screen.queryByText('DPI Y')).toBeNull();
        expect(screen.getByText(/Khổ toàn ảnh/).textContent).toContain('423.3 × 317.5 mm');
        expect(screen.getByText(/Ảnh gốc/).textContent).toContain('1200 × 900 px');
        expect(screen.getByText(/Không giảm độ phân giải/)).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('gọi export khi đã được nối từ wrapper', () => {
        const onExport = vi.fn();
        render(<StickerSheetPanel tabId="tab" onExport={onExport} />);
        fireEvent.click(screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }));
        expect(onExport).toHaveBeenCalledTimes(1);
    });
});
