// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchLocalFileBuffer } from '../../../lib/localFileTransport';
import { normalizeAndAddFiles } from './helpers';
import { createImageBatchStore } from './store';

vi.mock('../../../lib/localFileTransport', () => ({
    fetchLocalFileBuffer: vi.fn(),
}));

vi.mock('../../../i18n', () => ({
    tv: (text: string) => text,
}));

const mockedFetchLocalFileBuffer = vi.mocked(fetchLocalFileBuffer);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, reject, resolve };
}

function nativeFile(name = 'the.png', path = 'D:\\jobs\\the.png'): File {
    const file = new File([], name);
    Object.defineProperty(file, 'path', { value: path });
    return file;
}

describe('image batch native ingest', () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>();
    const revokeObjectURL = vi.fn();

    beforeEach(() => {
        mockedFetchLocalFileBuffer.mockReset();
        createObjectURL.mockReset();
        revokeObjectURL.mockReset();
        createObjectURL.mockImplementation(() => 'blob:source-preview');
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
        Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    });

    it('thêm thumbnail chờ ngay khi file native vẫn đang được đọc', async () => {
        const reading = deferred<ArrayBuffer>();
        mockedFetchLocalFileBuffer.mockReturnValue(reading.promise);
        const store = createImageBatchStore({ mode: 'test' });
        const input = nativeFile();

        const ingesting = normalizeAndAddFiles([input], 'tab', store);

        const [loading] = store.getState().getTab('tab').batchItems;
        expect(loading).toMatchObject({
            fileName: 'the.png',
            path: 'D:\\jobs\\the.png',
            status: 'processing',
            fileObj: undefined,
        });
        expect(loading.originalUrl).toMatch(/^data:image\/svg\+xml/);
        expect(createObjectURL).not.toHaveBeenCalled();

        reading.resolve(Uint8Array.from([1, 2, 3, 4]).buffer);
        await ingesting;

        const [ready] = store.getState().getTab('tab').batchItems;
        expect(ready).toMatchObject({ status: 'pending', error: undefined });
        expect(ready.fileObj).toBeInstanceOf(File);
        expect(ready.fileObj?.size).toBe(4);
        expect((ready.fileObj as File & { path?: string }).path).toBe('D:\\jobs\\the.png');
        expect(ready.originalUrl).toBe('blob:source-preview');
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(createObjectURL.mock.calls[0][0].size).toBe(4);
    });

    it('giữ item lỗi rõ ràng và không tạo blob URL từ File rỗng khi đọc thất bại', async () => {
        mockedFetchLocalFileBuffer.mockRejectedValue(new Error('HTTP 403'));
        const store = createImageBatchStore({ mode: 'test' });

        await normalizeAndAddFiles([nativeFile()], 'tab', store);

        const [failed] = store.getState().getTab('tab').batchItems;
        expect(failed.status).toBe('error');
        expect(failed.error).toContain('hãy kiểm tra file còn tồn tại');
        expect(failed.fileObj).toBeUndefined();
        expect(failed.originalUrl).toMatch(/^data:image\/svg\+xml/);
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(store.getState().getTab('tab').error).toContain('hãy kiểm tra file còn tồn tại');
    });

    it('giữ đường browser cũ: thêm File thật ở trạng thái chờ xử lý', async () => {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
        const store = createImageBatchStore({ mode: 'test' });
        const input = new File(['image'], 'browser.png', { type: 'image/png' });

        await normalizeAndAddFiles([input], 'tab', store);

        const [item] = store.getState().getTab('tab').batchItems;
        expect(item).toMatchObject({
            path: 'browser-file',
            fileName: 'browser.png',
            fileObj: input,
            originalUrl: 'blob:source-preview',
            status: 'pending',
        });
        expect(createObjectURL).toHaveBeenCalledWith(input);
        expect(mockedFetchLocalFileBuffer).not.toHaveBeenCalled();
    });

    it('không dựng lại tab đã đóng khi lượt đọc native hoàn tất muộn', async () => {
        const reading = deferred<ArrayBuffer>();
        mockedFetchLocalFileBuffer.mockReturnValue(reading.promise);
        const store = createImageBatchStore({ mode: 'test' });

        const ingesting = normalizeAndAddFiles([nativeFile()], 'closed-tab', store);
        expect(store.getState().tabs['closed-tab']?.batchItems).toHaveLength(1);
        store.getState().destroyTab('closed-tab');

        reading.resolve(Uint8Array.from([1, 2, 3]).buffer);
        await ingesting;

        expect(store.getState().tabs['closed-tab']).toBeUndefined();
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:source-preview');
    });
});
