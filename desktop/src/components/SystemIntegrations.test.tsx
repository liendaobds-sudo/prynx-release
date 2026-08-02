// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
    invoke: vi.fn(),
    unlisten: vi.fn(),
    dialogOpen: vi.fn(),
    webviewUnlisten: vi.fn(),
    webviewHandler: undefined as ((event: { payload: { type: 'enter' | 'over' | 'drop' | 'leave' } }) => void) | undefined,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
        mocks.listeners.set(eventName, handler);
        return mocks.unlisten;
    }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.dialogOpen }));
vi.mock('@tauri-apps/api/webview', () => ({
    getCurrentWebview: () => ({
        onDragDropEvent: vi.fn(async (handler: NonNullable<typeof mocks.webviewHandler>) => {
            mocks.webviewHandler = handler;
            return mocks.webviewUnlisten;
        }),
    }),
}));

import SystemIntegrations from './SystemIntegrations';
import HomeTab from './HomeTab';
import { OFFICE_EXTENSIONS } from '../lib/officeFileTypes';
import { SUPPORTED_IMAGE_EXTENSIONS } from '../lib/imageFileTypes';
import { statRecentFile, useRecentFiles } from '../lib/useRecentFiles';
import {
    SYSTEM_FILE_STAT_DEADLINE_MS,
    statNativeSystemFile,
} from '../lib/nativeFileAccess';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const OFFICE_EXTENSION_ORACLE = [
    'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp',
] as const;
const IMAGE_EXTENSION_ORACLE = [
    'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff',
] as const;
describe('SystemIntegrations — mở file hệ thống', () => {
    beforeEach(() => {
        mocks.listeners.clear();
        mocks.invoke.mockReset();
        mocks.unlisten.mockReset();
        mocks.dialogOpen.mockReset();
        mocks.webviewUnlisten.mockReset();
        mocks.webviewHandler = undefined;
        useRecentFiles.setState({ files: [], missingPaths: [] });
        mocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'get_startup_args' || command === 'get_pending_system_files') return [];
            if (command === 'stat_system_file') return { status: 'available', size: 123 };
            return null;
        });
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('hiện overlay khi drag-enter và tắt khi drag-leave', async () => {
        render(<SystemIntegrations />);
        await waitFor(() => expect(mocks.listeners.has('tauri://drag-enter')).toBe(true));

        act(() => mocks.listeners.get('tauri://drag-enter')?.({
            payload: { paths: ['C:\\in\\tai-lieu.pdf'] },
        }));
        expect(screen.getByRole('status').textContent).toMatch(/tab mới/i);

        act(() => mocks.listeners.get('tauri://drag-leave')?.({ payload: null }));
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('chuyển native drag-drop PDF thành path-backed File bằng contract stat mới', async () => {
        const received = vi.fn();
        window.addEventListener('system-files-received', received);
        const view = render(<SystemIntegrations />);
        await waitFor(() => expect(mocks.listeners.has('tauri://drag-drop')).toBe(true));

        act(() => mocks.listeners.get('tauri://drag-drop')?.({
            payload: { paths: ['C:\\in\\mau-hop.pdf'] },
        }));

        await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
        const event = received.mock.calls[0][0] as CustomEvent;
        expect(event.detail.files).toHaveLength(1);
        expect(event.detail.files[0].name).toBe('mau-hop.pdf');
        expect(event.detail.files[0].size).toBe(123);
        expect((event.detail.files[0] as File & { path?: string }).path).toBe('C:\\in\\mau-hop.pdf');
        expect(mocks.invoke).toHaveBeenCalledWith('stat_system_file', { path: 'C:\\in\\mau-hop.pdf' });
        expect(mocks.invoke).not.toHaveBeenCalledWith('get_file_size', expect.anything());

        window.removeEventListener('system-files-received', received);
        view.unmount();
        expect(mocks.unlisten).toHaveBeenCalled();
    });

    it('khởi động probe nhiều path cùng lúc thay vì chờ tuần tự', async () => {
        const first = deferred<{ status: 'available'; size: number }>();
        const second = deferred<{ status: 'available'; size: number }>();
        mocks.invoke.mockImplementation((command: string, args?: { path?: string }) => {
            if (command === 'get_startup_args' || command === 'get_pending_system_files') {
                return Promise.resolve([]);
            }
            if (command === 'stat_system_file') {
                return args?.path?.endsWith('mot.pdf') ? first.promise : second.promise;
            }
            return Promise.resolve(null);
        });

        const received = vi.fn();
        window.addEventListener('system-files-received', received);
        const view = render(<SystemIntegrations />);
        await waitFor(() => expect(mocks.listeners.has('tauri://drag-drop')).toBe(true));

        act(() => mocks.listeners.get('tauri://drag-drop')?.({
            payload: { paths: ['D:\\viec\\mot.pdf', '\\\\server\\share\\hai.docx'] },
        }));

        await waitFor(() => {
            const probes = mocks.invoke.mock.calls.filter(([command]) => command === 'stat_system_file');
            expect(probes).toHaveLength(2);
        });
        expect(received).not.toHaveBeenCalled();

        first.resolve({ status: 'available', size: 10 });
        second.resolve({ status: 'available', size: 20 });
        await waitFor(() => expect(received).toHaveBeenCalledTimes(1));

        const event = received.mock.calls[0][0] as CustomEvent;
        expect(event.detail.files.map((file: File) => file.size)).toEqual([10, 20]);

        window.removeEventListener('system-files-received', received);
        view.unmount();
    });

    it('hết deadline metadata vẫn trả kết quả timeout size=0', async () => {
        vi.useFakeTimers();
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'stat_system_file') return new Promise(() => undefined);
            return Promise.resolve([]);
        });

        const resultPromise = statNativeSystemFile('\\\\server\\share\\cham.pdf');
        await vi.advanceTimersByTimeAsync(SYSTEM_FILE_STAT_DEADLINE_MS);

        await expect(resultPromise).resolves.toEqual({
            status: 'timeout',
            size: 0,
        });
    });

    it('giữ mã missing có cấu trúc và coi reject là inaccessible', async () => {
        mocks.invoke.mockResolvedValueOnce({ status: 'missing', size: 0 });
        await expect(statNativeSystemFile('D:\\viec\\da-xoa.pdf')).resolves.toEqual({
            status: 'missing',
            size: 0,
        });

        mocks.invoke.mockRejectedValueOnce(new Error('permission denied'));
        await expect(statNativeSystemFile('D:\\viec\\bi-chan.pdf')).resolves.toEqual({
            status: 'inaccessible',
            size: 0,
        });
    });

    it('không poll lượt kế tiếp khi processPaths của lượt hiện tại chưa xong', async () => {
        vi.useFakeTimers();
        const probe = deferred<{ status: 'available'; size: number }>();
        let pendingCalls = 0;
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'get_startup_args') return Promise.resolve([]);
            if (command === 'get_pending_system_files') {
                pendingCalls += 1;
                return Promise.resolve(pendingCalls === 1 ? ['D:\\viec\\cham.pdf'] : []);
            }
            if (command === 'stat_system_file') return probe.promise;
            return Promise.resolve(null);
        });

        const view = render(<SystemIntegrations />);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(pendingCalls).toBe(1);
        expect(mocks.invoke.mock.calls.filter(([command]) => command === 'stat_system_file')).toHaveLength(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(pendingCalls).toBe(1);

        probe.resolve({ status: 'available', size: 11 });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(pendingCalls).toBe(2);

        view.unmount();
    });
    it('Home DOM drop phát đúng một event cho toàn bộ định dạng được hỗ trợ', async () => {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        const received = vi.fn();
        const onOpenApp = vi.fn();
        window.addEventListener('system-files-received', received);
        const view = render(<HomeTab onOpenApp={onOpenApp} isActive />);

        const input = document.getElementById('home-generic-pdf-input');
        const dropzone = input?.parentElement;
        expect(dropzone).not.toBeNull();

        expect([...OFFICE_EXTENSIONS]).toEqual(OFFICE_EXTENSION_ORACLE);
        expect([...SUPPORTED_IMAGE_EXTENSIONS]).toEqual(IMAGE_EXTENSION_ORACLE);
        const supportedNames = [
            'mau.PDF',
            ...IMAGE_EXTENSION_ORACLE.map(extension => `anh.${extension.toUpperCase()}`),
            ...OFFICE_EXTENSION_ORACLE.map(extension => `tai-lieu.${extension.toUpperCase()}`),
        ];
        const files = [
            ...supportedNames.map(name => new File(['x'], name)),
            new File(['x'], 'khong-ho-tro.gif'),
            new File(['x'], 'ghi-chu.txt'),
        ];
        fireEvent.drop(dropzone as HTMLElement, { dataTransfer: { files } });

        await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
        const event = received.mock.calls[0][0] as CustomEvent;
        expect(event.detail.files.map((file: File) => file.name)).toEqual(supportedNames);
        expect(event.detail.action).toBe('');
        expect(onOpenApp).not.toHaveBeenCalled();

        window.removeEventListener('system-files-received', received);
        view.unmount();
    });

    it('Home picker native dùng probe chung và không gọi onOpenApp trực tiếp', async () => {
        const selectedPath = '\\\\server\\share\\Báo giá.docx';
        mocks.dialogOpen.mockResolvedValue(selectedPath);
        const received = vi.fn();
        const onOpenApp = vi.fn();
        window.addEventListener('system-files-received', received);
        const view = render(<HomeTab onOpenApp={onOpenApp} isActive />);

        const input = document.getElementById('home-generic-pdf-input');
        fireEvent.click(input?.parentElement as HTMLElement);

        await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
        expect(mocks.invoke).toHaveBeenCalledWith('stat_system_file', { path: selectedPath });
        const event = received.mock.calls[0][0] as CustomEvent;
        expect(event.detail.files[0].name).toBe('Báo giá.docx');
        expect((event.detail.files[0] as File & { path?: string }).path).toBe(selectedPath);        expect(mocks.dialogOpen).toHaveBeenCalledWith(expect.objectContaining({
            filters: expect.arrayContaining([
                expect.objectContaining({
                    extensions: ['pdf', ...IMAGE_EXTENSION_ORACLE, ...OFFICE_EXTENSION_ORACLE],
                }),
            ]),
        }));
        expect(onOpenApp).not.toHaveBeenCalled();

        window.removeEventListener('system-files-received', received);
        view.unmount();
    });

    it('Home ẩn không giữ listener hoặc highlight native drag', async () => {
        const onOpenApp = vi.fn();
        const view = render(<HomeTab onOpenApp={onOpenApp} isActive={false} />);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mocks.webviewHandler).toBeUndefined();

        view.rerender(<HomeTab onOpenApp={onOpenApp} isActive />);
        await waitFor(() => expect(mocks.webviewHandler).toBeDefined());
        const input = document.getElementById('home-generic-pdf-input');
        const dropzone = input?.parentElement as HTMLElement;

        act(() => mocks.webviewHandler?.({ payload: { type: 'enter' } }));
        expect(dropzone.className).toContain('border-app-accent');

        view.rerender(<HomeTab onOpenApp={onOpenApp} isActive={false} />);
        await waitFor(() => expect(mocks.webviewUnlisten).toHaveBeenCalled());
        expect(dropzone.className).not.toContain('border-app-accent');

        view.unmount();
    });

    it('Recent chỉ đánh dấu missing khi native xác nhận, không xóa nhầm NAS/offline', async () => {
        const path = 'D:\\viec\\quan-trong.pdf';
        const recent = {
            path,
            name: 'quan-trong.pdf',
            size: 99,
            timestamp: 1,
            isStarred: true,
        };
        useRecentFiles.setState({ files: [recent], missingPaths: [path] });

        mocks.invoke.mockResolvedValueOnce({ status: 'available', size: 456 });
        await expect(statRecentFile(path)).resolves.toEqual({ size: 456 });
        expect(useRecentFiles.getState().missingPaths).toEqual([]);

        mocks.invoke.mockResolvedValueOnce({ status: 'inaccessible', size: 0 });
        await expect(statRecentFile(path)).resolves.toEqual({ size: 0 });
        expect(useRecentFiles.getState().missingPaths).toEqual([]);
        expect(useRecentFiles.getState().files).toEqual([recent]);

        mocks.invoke.mockResolvedValueOnce({ status: 'missing', size: 0 });
        await expect(statRecentFile(path)).resolves.toBeNull();
        expect(useRecentFiles.getState().missingPaths).toEqual([path]);
    });

    it('Recent timeout tiếp tục mở size=0 và kết quả native muộn không đổi store', async () => {
        vi.useFakeTimers();
        const path = '\\\\server\\share\\cham.pdf';
        const lateProbe = deferred<{ status: 'missing'; size: number }>();
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'stat_system_file') return lateProbe.promise;
            return Promise.resolve([]);
        });

        const resultPromise = statRecentFile(path);
        await vi.advanceTimersByTimeAsync(SYSTEM_FILE_STAT_DEADLINE_MS);
        await expect(resultPromise).resolves.toEqual({ size: 0 });
        expect(useRecentFiles.getState().missingPaths).toEqual([]);

        lateProbe.resolve({ status: 'missing', size: 0 });
        await Promise.resolve();
        await Promise.resolve();
        expect(useRecentFiles.getState().missingPaths).toEqual([]);
    });

    it('giữ intent combine từ startup/native path tới event dispatcher', async () => {
        const received = vi.fn();
        window.addEventListener('system-files-received', received);
        const view = render(<SystemIntegrations />);
        await waitFor(() => expect(mocks.listeners.has('tauri://drag-drop')).toBe(true));

        act(() => mocks.listeners.get('tauri://drag-drop')?.({
            payload: {
                paths: [
                    '--prynx-action=combine',
                    'D:\\viec\\01-bia.pdf',
                    'D:\\viec\\02-ruot.pdf',
                ],
            },
        }));

        await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
        const event = received.mock.calls[0][0] as CustomEvent;
        expect(event.detail.action).toBe('combine');
        expect(event.detail.files.map((file: File) => file.name)).toEqual([
            '01-bia.pdf',
            '02-ruot.pdf',
        ]);

        window.removeEventListener('system-files-received', received);
        view.unmount();
    });

});
