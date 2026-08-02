// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfMocks = vi.hoisted(() => ({
    getDocument: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('react-pdf', () => ({
    pdfjs: {
        getDocument: pdfMocks.getDocument,
    },
}));

vi.mock('../../components/workspace/ViewerHelpers', () => ({
    thumbCacheRef: { current: new Map() },
    putThumbCache: vi.fn(),
}));

vi.mock('../../components/workspace/LivePageFrame', () => ({
    clearTileUrlCache: vi.fn(),
}));

import { PDF_LOAD_SLOW_NOTICE_MS, usePdfLoader } from './usePdfLoader';

function makeProps(file: File, pdfUrl: string) {
    return {
        file,
        pdfUrl,
        setNumPages: vi.fn(),
        setActivePage: vi.fn(),
        setZoom: vi.fn(),
        containerRef: { current: { clientWidth: 800 } } as React.RefObject<HTMLDivElement>,
    };
}

function makePdfDoc(numPages = 1) {
    return {
        numPages,
        getPage: vi.fn(async () => ({
            getViewport: () => ({ width: 595, height: 842 }),
        })),
    };
}

describe('usePdfLoader — trạng thái tải PDF trong bộ nhớ', () => {
    beforeEach(() => {
        pdfMocks.getDocument.mockReset();
        tauriMocks.invoke.mockReset();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        vi.restoreAllMocks();
    });

    it('đưa lỗi PDF.js ra UI thay vì giữ loading vô hạn', async () => {
        const destroy = vi.fn();
        pdfMocks.getDocument.mockReturnValue({
            promise: Promise.reject(new Error('Invalid PDF structure')),
            destroy,
        });
        const props = makeProps(new File(['bad'], 'Combined.pdf', { type: 'application/pdf' }), 'blob:bad');

        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(result.current.loadStatus).toBe('error'));
        expect(result.current.loadError?.message).toContain('Invalid PDF structure');
        expect(props.setNumPages).toHaveBeenCalledWith(0);
    });

    it('coi tài liệu zero-page là lỗi hợp đồng', async () => {
        pdfMocks.getDocument.mockReturnValue({
            promise: Promise.resolve(makePdfDoc(0)),
            destroy: vi.fn(),
        });
        const props = makeProps(new File(['empty'], 'empty.pdf', { type: 'application/pdf' }), 'blob:empty');

        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(result.current.loadStatus).toBe('error'));
        expect(result.current.loadError).toBeTruthy();
    });

    it('xóa lỗi cũ khi chuyển sang file hợp lệ', async () => {
        pdfMocks.getDocument
            .mockReturnValueOnce({
                promise: Promise.reject(new Error('first file failed')),
                destroy: vi.fn(),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(makePdfDoc(1)),
                destroy: vi.fn(),
            });
        const first = makeProps(new File(['bad'], 'bad.pdf', { type: 'application/pdf' }), 'blob:first');
        const second = makeProps(new File(['good'], 'good.pdf', { type: 'application/pdf' }), 'blob:second');

        const { result, rerender } = renderHook(
            ({ props }) => usePdfLoader(props),
            { initialProps: { props: first } },
        );
        await waitFor(() => expect(result.current.loadStatus).toBe('error'));

        rerender({ props: second });

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(result.current.loadError).toBeNull();
        expect(second.setNumPages).toHaveBeenCalledWith(1);
    });

    it('thử lại đúng lượt tải hiện tại sau khi PDF.js lỗi', async () => {
        pdfMocks.getDocument
            .mockReturnValueOnce({
                promise: Promise.reject(new Error('worker failed')),
                destroy: vi.fn(),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(makePdfDoc(1)),
                destroy: vi.fn(),
            });
        const props = makeProps(new File(['retry'], 'retry.pdf', { type: 'application/pdf' }), 'blob:retry');

        const { result } = renderHook(() => usePdfLoader(props));
        await waitFor(() => expect(result.current.loadStatus).toBe('error'));

        act(() => result.current.retryLoad());

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(result.current.loadError).toBeNull();
        expect(pdfMocks.getDocument).toHaveBeenCalledTimes(2);
    });

    it('đóng cache native khi đổi file và khi unmount tab', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        tauriMocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'get_pdf_metadata') {
                return {
                    numPages: 1,
                    widthPt: 595,
                    heightPt: 842,
                    allDims: { 1: { widthPt: 595, heightPt: 842 } },
                };
            }
            if (command === 'close_pdf_document') return true;
            throw new Error(`Unexpected command: ${command}`);
        });

        const firstPath = 'D:\\jobs\\first.pdf';
        const secondPath = 'D:\\jobs\\second.pdf';
        const firstFile = new File([], 'first.pdf', { type: 'application/pdf' });
        const secondFile = new File([], 'second.pdf', { type: 'application/pdf' });
        Object.defineProperty(firstFile, 'path', { value: firstPath });
        Object.defineProperty(secondFile, 'path', { value: secondPath });
        const first = makeProps(firstFile, 'localfile://first');
        const second = makeProps(secondFile, 'localfile://second');

        const { result, rerender, unmount } = renderHook(
            ({ props }) => usePdfLoader(props),
            { initialProps: { props: first } },
        );
        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));

        rerender({ props: second });
        await waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
            'close_pdf_document',
            { filePath: firstPath },
            undefined,
        ));
        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));

        unmount();
        await waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
            'close_pdf_document',
            { filePath: secondPath },
            undefined,
        ));
    });

    it('chỉ cảnh báo tải lâu, không tự hủy tác vụ', async () => {
        vi.useFakeTimers();
        let rejectLoad!: (error: Error) => void;
        const pendingLoad = new Promise((_, reject) => {
            rejectLoad = reject;
        });
        const destroy = vi.fn(() => {
            rejectLoad(new Error('Loading aborted'));
            return Promise.resolve();
        });
        pdfMocks.getDocument.mockReturnValue({
            promise: pendingLoad,
            destroy,
        });
        const props = makeProps(new File(['slow'], 'slow.pdf', { type: 'application/pdf' }), 'blob:slow');

        const { result } = renderHook(() => usePdfLoader(props));

        act(() => vi.advanceTimersByTime(PDF_LOAD_SLOW_NOTICE_MS));
        expect(result.current.loadStatus).toBe('slow');
        expect(destroy).not.toHaveBeenCalled();

        act(() => result.current.cancelLoad());
        expect(result.current.loadStatus).toBe('cancelled');
        expect(destroy).toHaveBeenCalled();
        await act(async () => Promise.resolve());
        expect(result.current.loadStatus).toBe('cancelled');
        expect(result.current.loadError).toBeNull();
    });
});
