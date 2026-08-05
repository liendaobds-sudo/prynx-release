import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppVisibilityStore } from './appVisibility';

afterEach(() => {
    vi.useRealTimers();
});

describe('AppVisibilityStore', () => {
    it('giữ nhịp polling bình thường khi ứng dụng đang hiển thị', async () => {
        vi.useFakeTimers();
        const visibility = new AppVisibilityStore(false, true);
        let resolved = false;
        const delay = visibility.waitForForegroundDelay(500).then(() => {
            resolved = true;
        });

        await vi.advanceTimersByTimeAsync(499);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await delay;
        expect(resolved).toBe(true);
    });

    it('không đánh thức polling khi app đang nền và tiếp tục ngay lúc foreground', async () => {
        vi.useFakeTimers();
        const visibility = new AppVisibilityStore(true, true);
        let resolved = false;
        const delay = visibility.waitForForegroundDelay(500).then(() => {
            resolved = true;
        });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(resolved).toBe(false);

        visibility.setDocumentHidden(false);
        await delay;
        expect(resolved).toBe(true);
    });

    it('hủy timer đang chờ nếu cửa sổ chuyển nền giữa một nhịp polling', async () => {
        vi.useFakeTimers();
        const visibility = new AppVisibilityStore(false, true);
        let resolved = false;
        const delay = visibility.waitForForegroundDelay(500).then(() => {
            resolved = true;
        });

        await vi.advanceTimersByTimeAsync(200);
        visibility.setWindowFocused(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(resolved).toBe(false);

        visibility.setWindowFocused(true);
        await delay;
        expect(resolved).toBe(true);
    });

    it('chỉ coi là foreground khi cả tài liệu hiển thị và cửa sổ có focus', () => {
        const visibility = new AppVisibilityStore(true, false);
        const changes: boolean[] = [];
        const unsubscribe = visibility.subscribe(backgrounded => changes.push(backgrounded));

        visibility.setDocumentHidden(false);
        visibility.setWindowFocused(true);
        visibility.setWindowFocused(true);
        visibility.setDocumentHidden(true);
        unsubscribe();
        visibility.setDocumentHidden(false);

        expect(changes).toEqual([false, true]);
    });
});
