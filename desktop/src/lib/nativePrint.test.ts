// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { printPdfDirect, printPdfPath } from './nativePrint';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke,
}));

describe('native print page-list contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
        mocks.invoke.mockResolvedValue(true);
    });

    afterEach(() => {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('chuyển danh sách rời rạc vào print_pdf_direct', async () => {
        const pages = [27, 28, 30, 31, 32, 33];
        await printPdfDirect({
            jobId: 'print-test',
            filePath: 'C:\\Temp\\input.pdf',
            printerName: 'Test Printer',
            fromPage: 27,
            toPage: 33,
            pages,
            scaleMode: 'shrink',
        });

        expect(mocks.invoke).toHaveBeenCalledWith('print_pdf_direct', expect.objectContaining({
            fromPage: 27,
            toPage: 33,
            pages,
        }));
    });

    it('giữ danh sách rời rạc khi dùng hộp thoại Windows', async () => {
        const pages = [27, 28, 30, 31, 32, 33];
        await printPdfPath({
            filePath: 'C:\\Temp\\input.pdf',
            fromPage: 27,
            toPage: 33,
            pages,
            scaleMode: 'shrink',
        });

        expect(mocks.invoke).toHaveBeenCalledWith('print_pdf', expect.objectContaining({ pages }));
    });
});
