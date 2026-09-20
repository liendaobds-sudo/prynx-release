// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriMocks.invoke,
}));

import { useLiveLinkWatcher } from './useLiveLinkWatcher';

describe('useLiveLinkWatcher', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        tauriMocks.invoke.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('không gọi onFileChanged khi khởi tạo lần đầu', async () => {
        tauriMocks.invoke.mockResolvedValue({
            status: 'available',
            size: 1000,
            modified_ms: 100,
        });
        const onFileChanged = vi.fn();

        renderHook(() => useLiveLinkWatcher({
            filePath: 'C:/docs/fileA.pdf',
            enabled: true,
            onFileChanged,
        }));

        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });

        expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('không gọi onFileChanged khi đổi filePath sang file khác có mtime khác', async () => {
        tauriMocks.invoke.mockImplementation(async (_cmd: string, args: { path: string }) => {
            if (args.path === 'C:/docs/fileA.pdf') {
                return { status: 'available', size: 1000, modified_ms: 100 };
            }
            if (args.path === 'C:/temp/vdp_clean_123.pdf') {
                return { status: 'available', size: 800, modified_ms: 200 };
            }
            return { status: 'missing', size: 0 };
        });

        const onFileChanged = vi.fn();

        const { rerender } = renderHook(
            ({ path }: { path: string }) => useLiveLinkWatcher({
                filePath: path,
                enabled: true,
                onFileChanged,
            }),
            { initialProps: { path: 'C:/docs/fileA.pdf' } }
        );

        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(onFileChanged).not.toHaveBeenCalled();

        // Chuyển sang file clean template VDP
        rerender({ path: 'C:/temp/vdp_clean_123.pdf' });

        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });

        // Không được kích hoạt giả mạo do khác mtime giữa 2 file khác nhau
        expect(onFileChanged).not.toHaveBeenCalled();
    });

    it('gọi onFileChanged khi chính file đang theo dõi bị sửa đổi (mtime tăng)', async () => {
        let currentMod = 100;
        tauriMocks.invoke.mockImplementation(async () => ({
            status: 'available',
            size: 1000,
            modified_ms: currentMod,
        }));

        const onFileChanged = vi.fn();

        renderHook(() => useLiveLinkWatcher({
            filePath: 'C:/docs/design.pdf',
            enabled: true,
            onFileChanged,
        }));

        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(onFileChanged).not.toHaveBeenCalled();

        // File được lưu lại bên Illustrator (mtime đổi)
        currentMod = 150;

        // Kích hoạt chu kỳ polling (1500ms)
        await act(async () => {
            vi.advanceTimersByTime(1500);
            await Promise.resolve();
        });

        // Chờ 150ms debounce
        act(() => {
            vi.advanceTimersByTime(200);
        });

        expect(onFileChanged).toHaveBeenCalledTimes(1);
    });

    it('không kiểm tra và không gọi callback khi enabled = false', async () => {
        tauriMocks.invoke.mockResolvedValue({
            status: 'available',
            size: 1000,
            modified_ms: 100,
        });
        const onFileChanged = vi.fn();

        renderHook(() => useLiveLinkWatcher({
            filePath: 'C:/docs/fileA.pdf',
            enabled: false,
            onFileChanged,
        }));

        await act(async () => {
            await Promise.resolve();
        });
        expect(tauriMocks.invoke).not.toHaveBeenCalled();
        expect(onFileChanged).not.toHaveBeenCalled();
    });
});
