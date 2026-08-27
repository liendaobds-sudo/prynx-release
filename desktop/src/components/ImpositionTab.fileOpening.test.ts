import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    formatFileOpeningError,
    initialFileOpeningPhase,
} from '../lib/impositionOpeningState';
import {
    VIEWER_FIRST_FRAME_GRACE_MS,
    waitForViewerFirstFrameGrace,
} from '../lib/viewerFirstFrame';

describe('trạng thái mở tab kết quả bình bài', () => {
    it('hiện đang mở ngay khi tab được tạo cùng file kết quả', () => {
        const resultFile = new File(['pdf'], 'Imposed_test.pdf', {
            type: 'application/pdf',
        });

        expect(initialFileOpeningPhase(resultFile)).toBe('loading');
    });

    it('chỉ hiện uploader khi tab thật sự chưa có file', () => {
        expect(initialFileOpeningPhase(null)).toBe('idle');
    });

    it('giữ chi tiết ICC thay vì quy thành file ảnh hỏng', () => {
        const message = formatFileOpeningError(
            new Error('ICC của ảnh dùng hệ màu LAB chưa được hỗ trợ.'),
            'Không đọc được file ảnh',
        );

        expect(message).toContain('ICC của ảnh dùng hệ màu LAB');
        expect(message).toContain('Không đọc được file ảnh');
    });

    it('phân loại đúng lỗi hết bộ nhớ từ decoder native', () => {
        const message = formatFileOpeningError(
            new Error('Bộ giải mã ảnh thất bại: out of memory'),
            'Không đọc được file ảnh',
        );

        expect(message).toMatch(/bộ nhớ|memory/i);
    });

    it('giữ nguyên chi tiết khi decoder reject bằng chuỗi', () => {
        const rejection = 'Bộ giải mã desktop từ chối TIFF thử nghiệm';
        const message = formatFileOpeningError(rejection, 'Không đọc được file ảnh');

        expect(message).toContain(rejection);
        expect(message).toContain('Không đọc được file ảnh');
    });
});

describe('grace cho frame đầu Viewer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('trả false khi request vẫn pending hết grace', async () => {
        vi.useFakeTimers();
        const result = waitForViewerFirstFrameGrace(new Promise(() => undefined));

        await vi.advanceTimersByTimeAsync(VIEWER_FIRST_FRAME_GRACE_MS);

        await expect(result).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('trả true và dọn timer khi request xong trước deadline', async () => {
        vi.useFakeTimers();
        const result = waitForViewerFirstFrameGrace(Promise.resolve(null));

        await expect(result).resolves.toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('không hủy side effect của request hoàn tất muộn', async () => {
        vi.useFakeTimers();
        let finishRequest!: () => void;
        let cached = false;
        const request = new Promise<void>((resolve) => {
            finishRequest = resolve;
        }).then(() => {
            cached = true;
        });
        const result = waitForViewerFirstFrameGrace(request);

        await vi.advanceTimersByTimeAsync(VIEWER_FIRST_FRAME_GRACE_MS);
        await expect(result).resolves.toBe(false);

        finishRequest();
        await request;
        expect(cached).toBe(true);
    });
});
