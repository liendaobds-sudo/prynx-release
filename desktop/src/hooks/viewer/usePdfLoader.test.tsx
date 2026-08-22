// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfMocks = vi.hoisted(() => ({
    getDocument: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const tileCacheMocks = vi.hoisted(() => ({
    claimOwner: vi.fn(),
    clear: vi.fn(),
    releaseOwner: vi.fn(),
}));

vi.mock('react-pdf', () => ({
    pdfjs: {
        getDocument: pdfMocks.getDocument,
    },
}));

vi.mock('../../components/workspace/thumbnailCache', () => ({
    thumbCacheRef: { current: new Map() },
    putThumbCache: vi.fn(),
}));

vi.mock('../../lib/tileUrlCache', () => ({
    claimTileUrlCacheOwner: tileCacheMocks.claimOwner,
    clearTileUrlCache: tileCacheMocks.clear,
    releaseTileUrlCacheOwner: tileCacheMocks.releaseOwner,
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

function makePdfDoc(
    numPages = 1,
    dimensions: (pageNum: number) => { width: number; height: number } = () => ({ width: 595, height: 842 }),
) {
    return {
        numPages,
        getPage: vi.fn(async (pageNum: number) => ({
            getViewport: () => dimensions(pageNum),
        })),
    };
}

describe('usePdfLoader — trạng thái tải PDF trong bộ nhớ', () => {
    beforeEach(() => {
        pdfMocks.getDocument.mockReset();
        tauriMocks.invoke.mockReset();
        tileCacheMocks.claimOwner.mockReset();
        tileCacheMocks.clear.mockReset();
        tileCacheMocks.releaseOwner.mockReset();
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
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

    it('giữ một owner cache ổn định theo tab và release đúng namespace khi đổi file/unmount', async () => {
        pdfMocks.getDocument
            .mockReturnValueOnce({ promise: Promise.resolve(makePdfDoc(1)), destroy: vi.fn() })
            .mockReturnValueOnce({ promise: Promise.resolve(makePdfDoc(1)), destroy: vi.fn() });
        const first = makeProps(new File(['a'], 'a.pdf', { type: 'application/pdf' }), 'blob:first');
        const second = makeProps(new File(['b'], 'b.pdf', { type: 'application/pdf' }), 'blob:second');
        const { result, rerender, unmount } = renderHook(
            ({ props }) => usePdfLoader(props),
            { initialProps: { props: first } },
        );

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(tileCacheMocks.claimOwner).toHaveBeenCalledTimes(1);
        const ownerId = tileCacheMocks.claimOwner.mock.calls[0][0];
        expect(ownerId).toMatch(/^pdf-loader:/);
        expect(tileCacheMocks.claimOwner).toHaveBeenCalledWith(ownerId, 'blob:first');

        rerender({ props: second });
        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(tileCacheMocks.releaseOwner).toHaveBeenCalledWith(ownerId);
        expect(tileCacheMocks.claimOwner).toHaveBeenCalledWith(ownerId, 'blob:second');
        expect(tileCacheMocks.clear).toHaveBeenCalledTimes(2);

        unmount();
        expect(tileCacheMocks.releaseOwner.mock.calls.filter(([value]) => value === ownerId)).toHaveLength(2);
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

    it('không hiện lỗi PDF.js giả khi file trong RAM đang chuyển sang đường dẫn native', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        tauriMocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'get_pdf_metadata') {
                return {
                    numPages: 2,
                    widthPt: 595,
                    heightPt: 842,
                    colorRisk: {
                        highRisk: true,
                        accurateColorRecommended: true,
                        hasOutputIntent: false,
                        riskyPages: [1],
                        pages: [],
                        reasonCodes: ['missing_output_intent', 'device_cmyk'],
                    },
                    renderEngine: {
                        libraryPath: 'D:\\PrynX\\pdfium.dll',
                        sizeBytes: 123,
                        modifiedMillis: 456,
                        appVersion: '1.0.0-rc.4',
                        tileCacheVersion: 'v7_userunit_lossless_png',
                    },
                    viewerEngineMode: 'hybrid',
                    viewerShadowEnabled: true,
                    allDims: {
                        1: { widthPt: 595, heightPt: 842 },
                        2: { widthPt: 595, heightPt: 842 },
                    },
                };
            }
            if (command === 'close_pdf_document') return true;
            throw new Error(`Unexpected command: ${command}`);
        });

        const memoryFile = new File(['crop-result'], 'multicrop.pdf', { type: 'application/pdf' });
        Object.defineProperty(memoryFile, '__nativePathPending', { value: true, configurable: true });
        const initial = makeProps(memoryFile, 'blob:multicrop');

        const { result, rerender } = renderHook(
            ({ props }) => usePdfLoader(props),
            { initialProps: { props: initial } },
        );

        expect(result.current.loadStatus).toBe('loading');
        expect(result.current.loadError).toBeNull();
        expect(pdfMocks.getDocument).not.toHaveBeenCalled();

        const nativeFile = new File([], 'multicrop.pdf', { type: 'application/pdf' });
        Object.defineProperty(nativeFile, 'path', { value: 'D:\\temp\\multicrop.pdf' });
        rerender({ props: makeProps(nativeFile, 'blob:multicrop') });

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(result.current.loadError).toBeNull();
        expect(result.current.colorRisk?.highRisk).toBe(true);
        expect(result.current.colorRisk?.riskyPages).toEqual([1]);
        expect(result.current.renderEngine?.libraryPath).toBe('D:\\PrynX\\pdfium.dll');
        expect(result.current.viewerEngineMode).toBe('hybrid');
        expect(result.current.viewerShadowEnabled).toBe(true);
        expect(pdfMocks.getDocument).not.toHaveBeenCalled();
    });

    it('dựng trang đầu với cảnh báo màu bootstrap trước khi metadata đầy đủ hoàn tất', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        let resolveFullMetadata!: (value: unknown) => void;
        const fullMetadata = new Promise(resolve => {
            resolveFullMetadata = resolve;
        });
        tauriMocks.invoke.mockImplementation((command: string) => {
            if (command === 'get_pdf_viewer_bootstrap') {
                return Promise.resolve({
                    numPages: 2,
                    widthPt: 595,
                    heightPt: 842,
                    fileIdentity: '18:100:90',
                    colorRisk: {
                        highRisk: true,
                        accurateColorRecommended: true,
                        hasOutputIntent: false,
                        riskyPages: [1],
                        pages: [{
                            page: 1,
                            highRisk: true,
                            accurateColorRecommended: true,
                            hasDeviceCmyk: true,
                            hasDeviceN: false,
                            hasSeparation: false,
                            hasTransparency: true,
                            hasSoftMask: false,
                            hasBlendMode: true,
                        }],
                        reasonCodes: ['missing_output_intent', 'device_cmyk'],
                    },
                    renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                });
            }
            if (command === 'get_pdf_metadata') return fullMetadata;
            if (command === 'close_pdf_document') return Promise.resolve(true);
            return Promise.reject(new Error(`Unexpected command: ${command}`));
        });

        const file = new File([], 'mixed-size.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'path', { value: 'D:\\jobs\\mixed-size.pdf' });
        const props = makeProps(file, 'localfile://mixed-size');
        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(result.current.renderDocumentToken).toBe('18:100:90');
        expect(props.setNumPages).toHaveBeenCalledWith(2);
        expect(result.current.allPageDims[2]).toEqual({
            w: 595 * (96 / 72),
            h: 842 * (96 / 72),
            widthPt: 595,
        });
        expect(result.current.colorRisk?.highRisk).toBe(true);
        expect(result.current.colorRisk?.riskyPages).toEqual([1]);
        expect(tauriMocks.invoke.mock.calls.some(([command]) => command === 'get_pdf_metadata')).toBe(false);
        const activePageCallsAfterBootstrap = props.setActivePage.mock.calls.length;
        const zoomCallsAfterBootstrap = props.setZoom.mock.calls.length;

        act(() => result.current.notifyFirstPageRenderReady());
        await waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
            'get_pdf_metadata',
            { filePath: 'D:\\jobs\\mixed-size.pdf', expectedIdentity: '18:100:90' },
            undefined,
        ));

        await act(async () => {
            resolveFullMetadata({
                numPages: 2,
                widthPt: 595,
                heightPt: 842,
                colorRisk: {
                    highRisk: true,
                    accurateColorRecommended: true,
                    hasOutputIntent: false,
                    riskyPages: [2],
                    pages: [],
                    reasonCodes: ['device_cmyk'],
                },
                fileIdentity: '18:100:90',
                renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                allDims: {
                    1: { widthPt: 595, heightPt: 842 },
                    2: { widthPt: 1200, heightPt: 600 },
                },
            });
        });

        await waitFor(() => expect(result.current.allPageDims[2]).toEqual({
            w: 1200 * (96 / 72),
            h: 600 * (96 / 72),
            widthPt: 1200,
        }));
        expect(result.current.colorRisk?.riskyPages).toEqual([2]);
        expect(props.setActivePage).toHaveBeenCalledTimes(activePageCallsAfterBootstrap);
        expect(props.setZoom).toHaveBeenCalledTimes(zoomCallsAfterBootstrap);
    });

    it('không mount trang khi bootstrap thiếu kết quả detector màu', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        let resolveFullMetadata!: (value: unknown) => void;
        const fullMetadata = new Promise(resolve => {
            resolveFullMetadata = resolve;
        });
        tauriMocks.invoke.mockImplementation((command: string) => {
            if (command === 'get_pdf_viewer_bootstrap') {
                return Promise.resolve({
                    numPages: 1,
                    widthPt: 595,
                    heightPt: 842,
                    fileIdentity: 'missing-risk:1',
                    renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                });
            }
            if (command === 'get_pdf_metadata') return fullMetadata;
            if (command === 'close_pdf_document') return Promise.resolve(true);
            return Promise.resolve(null);
        });
        const nativeFile = new File([], 'missing-risk.pdf', { type: 'application/pdf' });
        Object.defineProperty(nativeFile, 'path', { value: 'D:\\jobs\\missing-risk.pdf' });
        const props = makeProps(nativeFile, 'localfile://missing-risk');

        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
            'get_pdf_metadata',
            { filePath: 'D:\\jobs\\missing-risk.pdf', expectedIdentity: 'missing-risk:1' },
            undefined,
        ));
        expect(result.current.loadStatus).toBe('loading');
        expect(props.setNumPages).not.toHaveBeenCalledWith(1);

        await act(async () => {
            resolveFullMetadata({
                numPages: 1,
                widthPt: 595,
                heightPt: 842,
                fileIdentity: 'missing-risk:1',
                colorRisk: {
                    highRisk: false,
                    accurateColorRecommended: false,
                    hasOutputIntent: true,
                    riskyPages: [],
                    pages: [],
                    reasonCodes: [],
                },
                renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                allDims: { 1: { widthPt: 595, heightPt: 842 } },
            });
        });

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(props.setNumPages).toHaveBeenCalledWith(1);
        expect(result.current.colorRisk?.highRisk).toBe(false);
    });

    it('không cho metadata nền của file cũ ghi đè file đang xem', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        let resolveFirstFull!: (value: unknown) => void;
        const firstFull = new Promise(resolve => {
            resolveFirstFull = resolve;
        });
        tauriMocks.invoke.mockImplementation((command: string, args?: { filePath?: string }) => {
            const isFirst = args?.filePath?.endsWith('first.pdf');
            if (command === 'get_pdf_viewer_bootstrap') {
                return Promise.resolve({
                    numPages: 1,
                    widthPt: isFirst ? 500 : 700,
                    heightPt: 800,
                    fileIdentity: isFirst ? 'first:1' : 'second:1',
                    colorRisk: {
                        highRisk: false,
                        accurateColorRecommended: false,
                        hasOutputIntent: true,
                        riskyPages: [],
                        pages: [],
                        reasonCodes: [],
                    },
                    renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                });
            }
            if (command === 'get_pdf_metadata' && isFirst) return firstFull;
            if (command === 'get_pdf_metadata') {
                return Promise.resolve({
                    numPages: 1,
                    widthPt: 700,
                    heightPt: 800,
                    colorRisk: {
                        highRisk: false,
                        accurateColorRecommended: false,
                        hasOutputIntent: true,
                        riskyPages: [],
                        pages: [],
                        reasonCodes: [],
                    },
                    fileIdentity: 'second:1',
                    renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                    allDims: { 1: { widthPt: 700, heightPt: 800 } },
                });
            }
            if (command === 'close_pdf_document') return Promise.resolve(true);
            return Promise.reject(new Error(`Unexpected command: ${command}`));
        });

        const firstFile = new File([], 'first.pdf', { type: 'application/pdf' });
        const secondFile = new File([], 'second.pdf', { type: 'application/pdf' });
        Object.defineProperty(firstFile, 'path', { value: 'D:\\jobs\\first.pdf' });
        Object.defineProperty(secondFile, 'path', { value: 'D:\\jobs\\second.pdf' });
        const first = makeProps(firstFile, 'localfile://first');
        const second = makeProps(secondFile, 'localfile://second');
        const { result, rerender } = renderHook(
            ({ props }) => usePdfLoader(props),
            { initialProps: { props: first } },
        );

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        act(() => result.current.notifyFirstPageRenderReady());
        rerender({ props: second });
        await waitFor(() => expect(result.current.pageWidthPt).toBe(700));
        act(() => result.current.notifyFirstPageRenderReady());
        await waitFor(() => expect(result.current.colorRisk?.hasOutputIntent).toBe(true));

        await act(async () => {
            resolveFirstFull({
                numPages: 1,
                widthPt: 500,
                heightPt: 800,
                colorRisk: {
                    highRisk: true,
                    accurateColorRecommended: true,
                    hasOutputIntent: false,
                    riskyPages: [1],
                    pages: [],
                    reasonCodes: ['device_cmyk'],
                },
                fileIdentity: 'first:1',
                allDims: { 1: { widthPt: 500, heightPt: 800 } },
            });
            await Promise.resolve();
        });

        expect(result.current.pageWidthPt).toBe(700);
        expect(result.current.colorRisk?.hasOutputIntent).toBe(true);
        expect(result.current.colorRisk?.riskyPages).toEqual([]);
    });

    it('giữ nguyên Viewer pha nhanh nếu file cùng đường dẫn đổi identity giữa hai pha', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        tauriMocks.invoke.mockImplementation((command: string) => {
            if (command === 'get_pdf_viewer_bootstrap') {
                return Promise.resolve({
                    numPages: 3,
                    widthPt: 600,
                    heightPt: 900,
                    fileIdentity: 'old-file:1',
                    colorRisk: {
                        highRisk: false,
                        accurateColorRecommended: false,
                        hasOutputIntent: true,
                        riskyPages: [],
                        pages: [],
                        reasonCodes: [],
                    },
                    renderEngine: { libraryPath: 'D:\\PrynX\\pdfium.dll' },
                });
            }
            if (command === 'get_pdf_metadata') {
                return Promise.reject(new Error('File PDF đã thay đổi giữa hai pha.'));
            }
            if (command === 'close_pdf_document') return Promise.resolve(true);
            return Promise.reject(new Error(`Unexpected command: ${command}`));
        });

        const file = new File([], 'replaced.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'path', { value: 'D:\\jobs\\replaced.pdf' });
        const props = makeProps(file, 'localfile://replaced');
        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        act(() => result.current.notifyFirstPageRenderReady());
        await waitFor(() => expect(tauriMocks.invoke.mock.calls.some(
            ([command]) => command === 'get_pdf_metadata',
        )).toBe(true));
        await act(async () => Promise.resolve());

        expect(result.current.loadStatus).toBe('ready');
        expect(result.current.loadError).toBeNull();
        expect(result.current.colorRisk?.highRisk).toBe(false);
        expect(result.current.pageWidthPt).toBe(600);
        expect(result.current.allPageDims[3].widthPt).toBe(600);
    });

    it('dùng PDF.js dự phòng nếu việc tạo đường dẫn native thất bại', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        pdfMocks.getDocument.mockReturnValue({
            promise: Promise.resolve(makePdfDoc(2)),
            destroy: vi.fn(),
        });

        const pendingFile = new File(['crop-result'], 'multicrop.pdf', { type: 'application/pdf' });
        Object.defineProperty(pendingFile, '__nativePathPending', { value: true, configurable: true });
        const initial = makeProps(pendingFile, 'blob:multicrop');

        const { result, rerender } = renderHook(
            ({ props }) => usePdfLoader(props),
            { initialProps: { props: initial } },
        );
        expect(pdfMocks.getDocument).not.toHaveBeenCalled();

        const fallbackFile = new File(['crop-result'], 'multicrop.pdf', { type: 'application/pdf' });
        Object.defineProperty(fallbackFile, '__pathMaterializationFailed', { value: true, configurable: true });
        rerender({ props: makeProps(fallbackFile, 'blob:multicrop') });

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(result.current.loadError).toBeNull();
        expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    });

    it('hydrate đúng khổ từng trang PDF.js dài thay vì nhân bản khổ trang 1', async () => {
        pdfMocks.getDocument.mockReturnValue({
            promise: Promise.resolve(makePdfDoc(101, pageNum => pageNum === 101
                ? { width: 1200, height: 600 }
                : { width: 595, height: 842 })),
            destroy: vi.fn(),
        });
        const props = makeProps(
            new File(['long'], 'long-mixed.pdf', { type: 'application/pdf' }),
            'blob:long-mixed',
        );
        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        expect(result.current.allPageDims[1]).toEqual({
            w: 595 * (96 / 72),
            h: 842 * (96 / 72),
            widthPt: 595,
        });
        act(() => result.current.notifyFirstPageRenderReady());
        await waitFor(() => expect(result.current.allPageDims[101]).toEqual({
            w: 1200 * (96 / 72),
            h: 600 * (96 / 72),
            widthPt: 1200,
        }), { timeout: 5000 });
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
            { filePath: firstPath, ownerId: expect.stringMatching(/^pdf-loader:/) },
            undefined,
        ));
        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));

        unmount();
        await waitFor(() => expect(tauriMocks.invoke).toHaveBeenCalledWith(
            'close_pdf_document',
            { filePath: secondPath, ownerId: expect.stringMatching(/^pdf-loader:/) },
            undefined,
        ));
    });

    it('yêu cầu PageBox hiển thị khi Rust lỗi và phải dùng HTTP fallback', async () => {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: { invoke: tauriMocks.invoke },
        });
        tauriMocks.invoke.mockRejectedValue(new Error('PDFium metadata unavailable'));
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                page_count: 1,
                max_width_pt: 194,
                max_height_pt: 94,
                pages: [{ index: 0, width_pt: 194, height_pt: 94 }],
            }),
        });
        vi.stubGlobal('fetch', fetchMock);

        const filePath = 'D:\\jobs\\cropbox.pdf';
        const file = new File([], 'cropbox.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'path', { value: filePath });
        const props = makeProps(file, 'localfile://cropbox');

        const { result } = renderHook(() => usePdfLoader(props));

        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        const [, request] = fetchMock.mock.calls[0];
        expect(JSON.parse(request.body)).toEqual({
            path: filePath,
            page_box_policy: 'visible',
        });
        expect(result.current.pageDim).toEqual({
            w: 194 * (96 / 72),
            h: 94 * (96 / 72),
        });
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
