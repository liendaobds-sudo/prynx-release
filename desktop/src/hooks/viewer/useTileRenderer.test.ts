// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    listen: vi.fn(() => Promise.resolve(vi.fn())),
    authenticatedFetch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: transportMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: transportMocks.listen }));

vi.mock('../../lib/api', () => ({
    authenticatedFetch: transportMocks.authenticatedFetch,
    getApiUrl: () => 'http://localhost:8321/api',
}));

import {
    ACCURATE_VIEWER_DPI_BUCKET,
    accurateViewerDpi,
    accurateViewerRequestScale,
    accurateViewerRasterDpr,
    isInteractiveViewportRender,
    parsePpeUnsupportedStatus,
    resolveViewerPageColorMode,
    progressiveViewerColorStages,
    shouldAutoDisableAccurateColor,
    shouldCancelAccurateRenderForViewport,
    shouldUseAccurateViewerRender,
    useTileRenderer,
    usesNativeAccurateWorker,
} from './useTileRenderer';
import { nativeRenderCoordinator, registerRenderDocumentIdentity, renderPipelineIdentity } from './renderCoordinator';
import type { TileUrlSource } from '../../lib/tileUrlCache';
import {
    computeAccurateViewerBaseZoom,
    computeRenderZoomPure,
    RENDER_BUDGET_PX,
} from '../../components/workspace/renderZoomPolicy';

describe('Viewer — định tuyến render màu chính xác', () => {
    beforeEach(() => {
        transportMocks.invoke.mockReset();
        transportMocks.authenticatedFetch.mockReset();
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page' || command === 'render_pdf_page') {
                return Promise.resolve(new Uint8Array([137, 80, 78, 71, 13, 10]).buffer);
            }
            return Promise.resolve(true);
        });
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => `blob:test-${Math.random()}`),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
    });

    it('scene giữ token nội dung khi tile-refined, đổi token khi tài liệu đổi', async () => {
        transportMocks.listen.mockClear();
        const { result, rerender, unmount } = renderHook(({ token }) => useTileRenderer({
            file: { path: 'D:\\scene-token.pdf', size: 1024, lastModified: 123 },
            pdfRef: null, pdfUrl: null, activePage: 1, renderDocumentToken: token,
        }), { initialProps: { token: 'content-v1' } });
        await waitFor(() => expect(transportMocks.listen).toHaveBeenCalled());
        const before = result.current.nativeSceneDocumentToken;
        const tileBefore = result.current.renderDocumentToken;
        const listener = (transportMocks.listen.mock.calls as unknown as Array<[string, (event: unknown) => void]>)[0][1];
        act(() => listener({ payload: { file_path: 'D:\\scene-token.pdf', page: 1, zoom: 2 } }));
        expect(result.current.nativeSceneDocumentToken).toBe(before);
        expect(result.current.renderDocumentToken).not.toBe(tileBefore);
        rerender({ token: 'content-v2' });
        expect(result.current.nativeSceneDocumentToken).not.toBe(before);
        unmount();
    });

    it('dùng accurate path cho cả nền và viewport thuộc danh sách detector', () => {
        expect(shouldUseAccurateViewerRender(true, [1, 4], 1, false, 'accurate')).toBe(true);
        expect(shouldUseAccurateViewerRender(true, [1, 4], 1, false, 'display')).toBe(false);
        expect(shouldUseAccurateViewerRender(true, [1, 4], 2, false, 'accurate')).toBe(false);
        expect(shouldUseAccurateViewerRender(true, [1, 4], 1, true, 'accurate')).toBe(true);
        expect(shouldUseAccurateViewerRender(false, [1, 4], 1, false, 'accurate')).toBe(false);
        expect(shouldUseAccurateViewerRender(false, [], 9, false, 'accurate', 'hybrid')).toBe(true);
        expect(shouldUseAccurateViewerRender(false, [], 9, true, 'accurate', 'ppe-only')).toBe(true);
    });

    it('đọc trạng thái unsupported có cấu trúc, không nhầm lỗi worker thường', () => {
        expect(parsePpeUnsupportedStatus(new Error(
            'PPE_NATIVE_UNSUPPORTED:{"reason":"image_codec","detail":"JPX"}',
        ))).toMatchObject({ reason: 'image_codec', detail: 'JPX' });
        expect(parsePpeUnsupportedStatus(new Error('PPE worker crash'))).toBeNull();
        expect(parsePpeUnsupportedStatus(new Error('PPE_NATIVE_UNSUPPORTED:{sai-json'))).toBeNull();
    });

    it.each(['current', 'hybrid'] as const)('V1 %s: ghi capability riêng rồi chỉ dựng PDFium bằng yêu cầu display mới', async viewerEngineMode => {
        const unsupported = new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"Group /K true"}');
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? Promise.reject(unsupported)
            : command === 'render_pdf_page'
                ? Promise.resolve(new Uint8Array([137, 80, 78, 71, 13, 10]).buffer)
                : Promise.resolve(true));
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: `D:/capability-${viewerEngineMode}.pdf` }, pdfRef: null, pdfUrl: null,
            activePage: 1, renderDocumentToken: 'revision-1', accurateColorEnabled: true,
            accurateColorPages: [1], viewerEngineMode,
        }));
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow('PPE_NATIVE_UNSUPPORTED'); });
        expect(result.current.getPpeUnsupportedStatus(1)).toEqual({ reason: 'knockout_transparency', detail: 'Group /K true', fallbackFontSha256: null });
        expect(result.current.getPpeUnsupportedStatus(2)).toBeNull();
        await expect(result.current.getTileUrl(1, 0, 1.25, 0, 0, 100, 100,
            { colorStage: 'accurate', forceAccurateColor: true })).rejects.toThrow('PPE_NATIVE_UNSUPPORTED');
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page')).toHaveLength(1);
        expect(transportMocks.invoke.mock.calls.some(([command]) => command === 'render_pdf_page')).toBe(false);
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        const display = await result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'display' });
        expect(display.proof).toMatchObject({ engine: 'pdfium', soundness: 'display-preview', page: 1,
            documentToken: 'revision-1', profileId: null, intent: null, proofIdentity: 'display' });
        expect(transportMocks.invoke).toHaveBeenCalledWith('render_pdf_page', expect.objectContaining({
            format: 'pxrg', requestContext: expect.objectContaining({ pipelineIdentity: renderPipelineIdentity('display') }),
        }));
        expect(result.current.getPpeUnsupportedStatus(1)?.reason).toBe('knockout_transparency');
        unmount();
    });

    it('V1: trang khác thành công không xóa capability của trang lỗi', async () => {
        transportMocks.invoke.mockImplementation((command: string, args: { page?: number }) => {
            if (command === 'render_ppe_page' && args.page === 1) return Promise.reject(new Error(
                'PPE_NATIVE_UNSUPPORTED:{"reason":"image_codec","detail":"JPX"}',
            ));
            if (command === 'render_ppe_page') return Promise.resolve(new Uint8Array([137, 80, 78, 71]).buffer);
            return Promise.resolve(true);
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:/capability-pages.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            accurateColorEnabled: true, accurateColorPages: [1, 2],
        }));
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow('PPE_NATIVE_UNSUPPORTED'); });
        await act(async () => { await result.current.getTileUrl(2, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' }); });
        expect(result.current.getPpeUnsupportedStatus(1)?.reason).toBe('image_codec');
        expect(result.current.getPpeUnsupportedStatus(2)).toBeNull();
        unmount();
    });

    it.each(['PPE worker OOM', 'Lỗi I/O', 'PPE_NATIVE_UNSUPPORTED:{"reason":"oom","detail":"OOM"}',
        'PPE_NATIVE_UNSUPPORTED:{sai-json'])(
        'V1: lỗi vận hành/không nhận diện không thành capability: %s', async message => {
            transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
                ? Promise.reject(new Error(message)) : Promise.resolve(true));
            const { result, unmount } = renderHook(() => useTileRenderer({
                file: { path: `D:/ordinary-error-${message.length}.pdf` }, pdfRef: null, pdfUrl: null,
                activePage: 1, viewerEngineMode: 'ppe-only',
            }));
            for (const zoom of [1, 1.25]) await act(async () => {
                await expect(result.current.getTileUrl(1, 0, zoom, undefined, undefined, undefined, undefined,
                    { colorStage: 'accurate' })).rejects.toThrow();
            });
            expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
            expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page')).toHaveLength(2);
            unmount();
        },
    );

    it('V1: revision/profile/proof mới không thừa kế capability, kể cả A → B → A', async () => {
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? Promise.reject(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"hidden_content","detail":"Nội dung ẩn"}'))
            : Promise.resolve(true));
        const initial = { token: 'rev-A', profile: 'fogra39', paper: false };
        const { result, rerender, unmount } = renderHook(({ token, profile, paper }) => useTileRenderer({
            file: { path: 'D:/capability-revision.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            renderDocumentToken: token, accurateColorEnabled: true, accurateColorPages: [1],
            accurateColorProfileId: profile, simulatePaperColor: paper,
        }), { initialProps: initial });
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow(); });
        const oldGetter = result.current.getPpeUnsupportedStatus;
        expect(oldGetter(1)).not.toBeNull();
        rerender({ ...initial, token: 'rev-B' });
        expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
        expect(oldGetter(1)).toBeNull();
        rerender(initial);
        expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 1.2, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow(); });
        rerender({ ...initial, profile: 'swop' });
        expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
        rerender(initial);
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 1.3, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow(); });
        rerender({ ...initial, paper: true });
        expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
        unmount();
    });

    it('V1: unsupported về muộn từ epoch cũ không đổi trạng thái file hiện tại', async () => {
        let rejectOld!: (error: Error) => void;
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? new Promise<ArrayBuffer>((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(true));
        const { result, rerender, unmount } = renderHook(({ token }) => useTileRenderer({
            file: { path: 'D:/capability-late.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            renderDocumentToken: token, accurateColorEnabled: true, accurateColorPages: [1],
        }), { initialProps: { token: 'A' } });
        const pending = result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' }).catch(error => error);
        rerender({ token: 'B' });
        rerender({ token: 'A' });
        await act(async () => {
            rejectOld(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"Cũ"}'));
            expect(await pending).toMatchObject({ name: 'CancelledTileRenderError' });
        });
        expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
        expect(result.current.accurateColorError).toBeNull();
        unmount();
    });

    it('V1: request đã hủy dù trả unsupported cũng không ghi capability', async () => {
        let rejectNative!: (error: Error) => void;
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? new Promise<ArrayBuffer>((_resolve, reject) => { rejectNative = reject; }) : Promise.resolve(true));
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:/capability-cancelled.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            accurateColorEnabled: true, accurateColorPages: [1],
        }));
        const pending = result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', groupKey: 'cancelled-capability' }).catch(error => error);
        act(() => result.current.cancelAccurateGroup('cancelled-capability'));
        await act(async () => {
            rejectNative(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"Đã hủy"}'));
            expect(await pending).toMatchObject({ name: 'CancelledTileRenderError' });
        });
        expect(result.current.getPpeUnsupportedStatus(1)).toBeNull();
        expect(result.current.accurateColorError).toBeNull();
        unmount();
    });

    it('V1: kết quả PPE nền về sau capability của viewport phải bị loại', async () => {
        const jobs: Array<{ resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void }> = [];
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? new Promise<ArrayBuffer>((resolve, reject) => { jobs.push({ resolve, reject }); }) : Promise.resolve(true));
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:/capability-sibling.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            accurateColorEnabled: true, accurateColorPages: [1],
        }));
        const base = result.current.getTileUrl(1, 0, .5, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', groupKey: 'base', priority: 10 }).catch(error => error);
        const detail = result.current.getTileUrl(1, 0, 2, 0, 0, 100, 100,
            { colorStage: 'accurate', groupKey: 'detail', priority: 0 }).catch(error => error);
        await waitFor(() => expect(jobs).toHaveLength(2));
        await act(async () => {
            jobs[1].reject(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"Group"}'));
            expect((await detail).message).toContain('PPE_NATIVE_UNSUPPORTED');
        });
        await act(async () => {
            jobs[0].resolve(new Uint8Array([137, 80, 78, 71]).buffer);
            expect(await base).toMatchObject({ name: 'CancelledTileRenderError' });
        });
        expect(result.current.getPpeUnsupportedStatus(1)?.reason).toBe('knockout_transparency');
        expect(result.current.accurateColorError).toContain('PPE_NATIVE_UNSUPPORTED');
        unmount();
    });

    it('V1: controller cùng group bị thay không làm cancel ngược group đang báo unsupported', async () => {
        const jobs: Array<{ resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void }> = [];
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? new Promise<ArrayBuffer>((resolve, reject) => { jobs.push({ resolve, reject }); }) : Promise.resolve(true));
        const cancellation = vi.spyOn(nativeRenderCoordinator, 'cancelGroup');
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:/capability-same-group.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            accurateColorEnabled: true, accurateColorPages: [1],
        }));
        const base = result.current.getTileUrl(1, 0, .5, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', groupKey: 'shared-group', priority: 10 }).catch(error => error);
        const detail = result.current.getTileUrl(1, 0, 2, 0, 0, 100, 100,
            { colorStage: 'accurate', groupKey: 'shared-group', priority: 0 }).catch(error => error);
        try {
            await waitFor(() => expect(jobs).toHaveLength(2));
            cancellation.mockClear();
            await act(async () => {
                jobs[0].reject(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"Group"}'));
                expect((await base).message).toContain('PPE_NATIVE_UNSUPPORTED');
            });
            expect(cancellation.mock.calls.some(([, group]) => group === 'shared-group')).toBe(false);
            await act(async () => {
                jobs[1].resolve(new Uint8Array([137, 80, 78, 71]).buffer);
                expect(await detail).toMatchObject({ name: 'CancelledTileRenderError' });
            });
            expect(result.current.getPpeUnsupportedStatus(1)?.reason).toBe('knockout_transparency');
        } finally {
            jobs[1]?.resolve(new Uint8Array([137, 80, 78, 71]).buffer);
            await detail;
            unmount();
            cancellation.mockRestore();
        }
    });

    it('V1: tile-refined không biến capability nội dung thành lượt PPE thử lại', async () => {
        transportMocks.listen.mockClear();
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? Promise.reject(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"unsupported_feature","detail":"Feature"}'))
            : Promise.resolve(true));
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:/capability-refinement.pdf' }, pdfRef: null, pdfUrl: null, activePage: 1,
            renderDocumentToken: 'content-v1', viewerEngineMode: 'ppe-only',
        }));
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow('PPE_NATIVE_UNSUPPORTED'); });
        await waitFor(() => expect(transportMocks.listen).toHaveBeenCalled());
        const listener = (transportMocks.listen.mock.calls as unknown as Array<[string, (event: unknown) => void]>)[0][1];
        act(() => listener({ payload: { file_path: 'D:/capability-refinement.pdf', page: 1, zoom: 2 } }));
        expect(result.current.getPpeUnsupportedStatus(1)?.reason).toBe('unsupported_feature');
        await act(async () => { await expect(result.current.getTileUrl(1, 0, 2, undefined, undefined, undefined, undefined,
            { colorStage: 'display', forceAccurateColor: true })).rejects.toThrow('PPE_NATIVE_UNSUPPORTED'); });
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page')).toHaveLength(1);
        expect(transportMocks.invoke.mock.calls.some(([command]) => command === 'render_pdf_page')).toBe(false);
        unmount();
    });

    it('V1: cùng file ở hai tab không chia sẻ trạng thái capability', async () => {
        transportMocks.invoke.mockImplementation((command: string) => command === 'render_ppe_page'
            ? Promise.reject(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"color_approximation","detail":"Màu"}'))
            : Promise.resolve(true));
        const properties = { file: { path: 'D:/same-file-two-tabs.pdf' }, pdfRef: null, pdfUrl: null,
            activePage: 1, renderDocumentToken: 'same-revision', viewerEngineMode: 'hybrid' as const };
        const first = renderHook(() => useTileRenderer({ ...properties, tabId: 'first-tab' }));
        const second = renderHook(() => useTileRenderer({ ...properties, tabId: 'second-tab' }));
        await act(async () => { await expect(first.result.current.getTileUrl(1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' })).rejects.toThrow(); });
        expect(first.result.current.getPpeUnsupportedStatus(1)).not.toBeNull();
        expect(second.result.current.getPpeUnsupportedStatus(1)).toBeNull();
        first.unmount(); second.unmount();
    });

    it('V1: policy chỉ cho trang thường chuyển sang display, không hạ yêu cầu proof', () => {
        const unsupported = { reason: 'knockout_transparency', detail: 'Group /K true' };
        const input = { requestedAccurate: true, strictProofRequired: false, viewerEngineMode: 'current' as const, unsupported };
        expect(resolveViewerPageColorMode(input)).toEqual({ accurateColorPage: false, compatibility: unsupported });
        expect(resolveViewerPageColorMode({ ...input, viewerEngineMode: 'hybrid' }).compatibility).toBe(unsupported);
        expect(resolveViewerPageColorMode({ ...input, strictProofRequired: true })).toEqual({ accurateColorPage: true, compatibility: null });
        expect(resolveViewerPageColorMode({ ...input, viewerEngineMode: 'ppe-only' })).toEqual({ accurateColorPage: true, compatibility: null });
        expect(resolveViewerPageColorMode({ ...input, requestedAccurate: false })).toEqual({ accurateColorPage: false, compatibility: null });
        expect(resolveViewerPageColorMode({ ...input, unsupported: { reason: 'oom', detail: 'OOM' } })).toEqual({ accurateColorPage: true, compatibility: null });
        expect(resolveViewerPageColorMode({ ...input, unsupported: null })).toEqual({ accurateColorPage: true, compatibility: null });
    });

    it('không tự đổi toàn trang sang PDFium khi PPE báo hình học xấp xỉ', () => {
        const geometry = new Error(
            'PPE_NATIVE_UNSUPPORTED:{"reason":"geometry_approximation","detail":"font không nhúng"}',
        );
        const color = new Error(
            'PPE_NATIVE_UNSUPPORTED:{"reason":"color_approximation","detail":"màu xấp xỉ"}',
        );

        expect(shouldAutoDisableAccurateColor(geometry, 'current')).toBe(false);
        expect(shouldAutoDisableAccurateColor(color, 'current')).toBe(false);
        expect(shouldAutoDisableAccurateColor(geometry, 'ppe-only')).toBe(false);
        expect(shouldAutoDisableAccurateColor(geometry, 'hybrid')).toBe(false);
    });

    it('không phát frame PDFium sai màu trước PPE trên trang rủi ro', () => {
        expect(progressiveViewerColorStages(false)).toEqual(['display']);
        expect(progressiveViewerColorStages(true)).toEqual(['accurate']);
    });

    it('chỉ dùng worker native cho đúng Simulation đã đóng gói', () => {
        expect(usesNativeAccurateWorker('fogra39', 'relative')).toBe(true);
        expect(usesNativeAccurateWorker('swop', 'relative')).toBe(false);
        expect(usesNativeAccurateWorker('fogra39', 'perceptual')).toBe(false);
        expect(usesNativeAccurateWorker('fogra39', 'relative', 'text')).toBe(false);
        expect(usesNativeAccurateWorker('fogra39', 'relative', 'all', true)).toBe(false);
        expect(usesNativeAccurateWorker('fogra39', 'relative', 'all', false, true)).toBe(false);
        expect(usesNativeAccurateWorker(
            'fogra39', 'relative', 'all', false, false, [245, 240, 235],
        )).toBe(false);
        expect(renderPipelineIdentity('accurate', 'fogra39', 'relative'))
            .toBe('ppe-fogra39-relative-view-knockout-png-v6-native-worker');
        expect(renderPipelineIdentity('accurate', 'swop', 'perceptual'))
            .toBe('ppe-swop-perceptual-view-knockout-png-v6-backend');
    });

    it('contract Output Preview chính xác đi backend và mang đủ tham số đổi pixel', async () => {
        transportMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        } as Response);
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\output-preview.pdf',
                name: 'output-preview.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://output-preview',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: false,
            accurateColorPages: [],
            accurateColorProfileId: 'fogra39',
            accurateColorIntent: 'relative',
            outputPreviewFilter: 'text',
            simulatePaperColor: true,
            simulateBlackInk: true,
            pageBackgroundRgb: [245, 240, 235],
        }));

        await result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', forceAccurateColor: true },
        );

        expect(transportMocks.invoke.mock.calls.some(([command]) => command === 'render_ppe_page'))
            .toBe(false);
        const post = transportMocks.authenticatedFetch.mock.calls.find(([url, init]) => (
            String(url).endsWith('/preflight/viewer-accurate')
            && (init as RequestInit).method === 'POST'
        ));
        expect(post).toBeTruthy();
        expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
            profile_id: 'fogra39',
            intent: 'relative',
            output_preview_filter: 'text',
            simulate_paper_color: true,
            simulate_black_ink: true,
            page_background_rgb: [245, 240, 235],
        });
        unmount();
    });

    it('SWOP đi thẳng backend và mang đúng profile/intent', async () => {
        transportMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        } as Response);
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\swop.pdf',
                name: 'swop.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://swop',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: false,
            accurateColorPages: [],
            accurateColorProfileId: 'swop',
            accurateColorIntent: 'perceptual',
        }));

        await result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', forceAccurateColor: true },
        );

        expect(transportMocks.invoke.mock.calls.some(([command]) => command === 'render_ppe_page'))
            .toBe(false);
        const post = transportMocks.authenticatedFetch.mock.calls.find(([url, init]) => (
            String(url).endsWith('/preflight/viewer-accurate')
            && (init as RequestInit).method === 'POST'
        ));
        expect(post).toBeTruthy();
        expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
            profile_id: 'swop',
            intent: 'perceptual',
        });
        unmount();
    });

    it('viewport giữ nền accurate cùng trang nhưng loại request cũ/trang khác', () => {
        expect(shouldCancelAccurateRenderForViewport(1, false, 1)).toBe(false);
        expect(shouldCancelAccurateRenderForViewport(1, true, 1)).toBe(true);
        expect(shouldCancelAccurateRenderForViewport(2, false, 1)).toBe(true);
    });

    it('phân biệt tile tương tác với tile dựng trước theo priority', () => {
        expect(isInteractiveViewportRender(true, 0)).toBe(true);
        expect(isInteractiveViewportRender(true, 99)).toBe(true);
        expect(isInteractiveViewportRender(true, 100)).toBe(false);
        expect(isInteractiveViewportRender(false, 0)).toBe(false);
    });

    it('đổi zoom PDFium sang DPI PPE cùng kích thước pixel', () => {
        expect(accurateViewerDpi(0.5)).toBe(48);
        expect(accurateViewerDpi(1)).toBe(96);
        expect(accurateViewerDpi(1.25)).toBe(120);
        expect(accurateViewerDpi(1.5)).toBe(144);
        expect(accurateViewerDpi(2)).toBe(192);
        expect(accurateViewerDpi(0.01)).toBe(24);
        expect(accurateViewerDpi(200)).toBe(9600);
    });

    it('dùng chung bucket cho các mức zoom gần nhau', () => {
        expect(accurateViewerDpi(1.01)).toBe(108);
        expect(accurateViewerDpi(1.12)).toBe(108);
        expect(accurateViewerDpi(1.126)).toBe(120);
    });

    it('chuẩn hoá request scale theo DPI bucket khi giảm zoom nhẹ', () => {
        const sharpAtHighZoom = accurateViewerRequestScale(2.10);
        const nearbyLowerZoom = accurateViewerRequestScale(2.04);

        expect(sharpAtHighZoom).toBe(2.125);
        expect(nearbyLowerZoom).toBe(sharpAtHighZoom);
        expect(accurateViewerDpi(sharpAtHighZoom)).toBe(204);
    });

    it('chỉ đổi request scale khi zoom vượt sang DPI bucket khác', () => {
        expect(accurateViewerRequestScale(2.001)).toBe(2.125);
        expect(accurateViewerRequestScale(2.126)).toBe(2.25);
    });

    it('bucket hợp lệ luôn đủ DPI và chỉ render dư dưới một nấc', () => {
        for (const zoomScale of [0.25, 0.51, 1.01, 1.124, 1.26, 2.03, 5.337, 24]) {
            const requestedDpi = 96 * zoomScale;
            const selectedDpi = accurateViewerDpi(zoomScale);
            expect(selectedDpi).toBeGreaterThanOrEqual(requestedDpi);
            expect(selectedDpi - requestedDpi).toBeLessThan(ACCURATE_VIEWER_DPI_BUCKET);
        }
    });

    it('đổi mật độ viewport CSS sang đúng lưới PPE', () => {
        expect(accurateViewerRasterDpr(2, 1)).toBeCloseTo(1);
        expect(accurateViewerRasterDpr(2, 2)).toBeCloseTo(2);
    });

    it('neo 100% PPE tại Raw DPI 92 để raster map 1:1', () => {
        const physicalScale = 92 / 96;
        expect(accurateViewerDpi(physicalScale, 92)).toBe(92);
        expect(accurateViewerRequestScale(physicalScale, 92)).toBeCloseTo(physicalScale, 8);
        expect(accurateViewerRasterDpr(physicalScale, 1, 92)).toBeCloseTo(1, 8);
        expect(computeAccurateViewerBaseZoom(
            physicalScale,
            physicalScale,
            1,
            physicalScale,
        )).toBeCloseTo(physicalScale, 8);
    });

    it('giữ nguyên sàn 24 DPI khi request viewport được chuẩn hoá lần hai', () => {
        // Trang Standee fit khoảng 10%: compositor tính clip ở 24 DPI. Nếu request
        // 24 DPI bị lượng tử lại thành 32 DPI trên màn 92 PPI, nội dung sẽ phóng 4/3
        // rồi bị khung tile cắt mất mép phải và phần dưới.
        const standeeFitZoom = 0.1;
        const requestScale = accurateViewerRequestScale(standeeFitZoom, 92);

        expect(requestScale).toBe(24 / 96);
        expect(accurateViewerDpi(requestScale, 92)).toBe(24);
    });

    it('giữ bucket 12 DPI quanh Raw DPI thay vì tạo cache miss theo từng wheel', () => {
        const targetScale = (92 * 1.25) / 96;
        expect(accurateViewerDpi(targetScale, 92)).toBe(116);
        expect(accurateViewerDpi(targetScale * 0.995, 92)).toBe(116);
    });

    it('đổi DPR vẫn đổi raster dù tỷ lệ CSS vật lý trùng nhau', () => {
        const physicalScale = 92 / 96;
        const dpr1 = computeRenderZoomPure(
            physicalScale,
            800,
            800,
            1000,
            RENDER_BUDGET_PX.high,
            physicalScale,
            1,
        );
        const dpr2 = computeRenderZoomPure(
            physicalScale,
            800,
            800,
            1000,
            RENDER_BUDGET_PX.high,
            physicalScale,
            2,
        );
        expect(dpr1).toBeCloseTo(physicalScale, 8);
        expect(dpr2).toBeCloseTo(physicalScale * 2, 8);
    });

    it('truyền Raw DPI vào request PPE native', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\physical-92.pdf',
                name: 'physical-92.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://physical-92',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
            accurateDpiAnchor: 92,
        }));

        await act(async () => {
            await result.current.getTileUrl(
                1, 0, 92 / 96, undefined, undefined, undefined, undefined,
                { colorStage: 'accurate' },
            );
        });
        const nativeCall = transportMocks.invoke.mock.calls.find(([command]) => (
            command === 'render_ppe_page'
        ));
        expect(nativeCall?.[1]).toEqual(expect.objectContaining({ dpi: 92 }));
        unmount();
    });

    it('không dựng trước PPE hai trang kề sau khi trang active hoàn tất', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 2,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1, 2, 3, 8],
        }));

        await act(async () => {
            await result.current.getTileUrl(
                2, 0, 1, undefined, undefined, undefined, undefined,
                { colorStage: 'accurate' },
            );
        });
        const nativeRenders = transportMocks.invoke.mock.calls.filter(([command]) => (
            command === 'render_ppe_page'
        ));
        expect(nativeRenders).toHaveLength(1);
        expect(nativeRenders[0][1]).toEqual(expect.objectContaining({ page: 2 }));
        expect(transportMocks.authenticatedFetch.mock.calls.some(([url]) => (
            String(url).includes('/preflight/viewer-accurate')
        ))).toBe(false);
        unmount();
    });

    it('gửi clip PPE native cùng session owner, generation và purpose tương tác', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        await act(async () => {
            await result.current.getTileUrl(
                1, 0, 2, 100, 200, 640, 480,
                {
                    colorStage: 'accurate',
                    groupKey: 'page:1:viewport',
                    generationKey: 'zoom-2',
                    priority: 0,
                },
            );
        });

        const nativeCall = transportMocks.invoke.mock.calls.find(([command]) => (
            command === 'render_ppe_page'
        ));
        expect(nativeCall).toBeTruthy();
        expect(nativeCall?.[1]).toMatchObject({
            page: 1,
            dpi: 192,
            clipX: 100,
            clipY: 200,
            clipW: 640,
            clipH: 480,
            sessionOwnerId: result.current.renderOwnerId,
            requestContext: {
                generation: 1,
                purpose: 'accurate',
                priority: 0,
                pipelineIdentity: 'ppe-fogra39-relative-view-knockout-png-v6-native-worker',
            },
        });
        expect(nativeCall?.[1].requestContext.ownerId).not.toContain('page:1:viewport');
        expect(nativeCall?.[1].requestContext.requestId).toBeTruthy();
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        unmount();
    });

    it('full-page và viewport native tách request owner nhưng dùng chung session owner', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        await result.current.getTileUrl(
            1, 0, 2, undefined, undefined, undefined, undefined,
            {
                colorStage: 'accurate',
                groupKey: 'page:1:page',
                ownerId: 'tab-a:accurate-base:page-1',
            },
        );
        await result.current.getTileUrl(
            1, 0, 2, 0, 0, 512, 512,
            {
                colorStage: 'accurate',
                groupKey: 'page:1:viewport',
                priority: 0,
                ownerId: 'tab-a',
            },
        );

        const nativeRenders = transportMocks.invoke.mock.calls.filter(([command]) => (
            command === 'render_ppe_page'
        ));
        expect(nativeRenders).toHaveLength(2);
        expect(nativeRenders.map(([, args]) => args.requestContext.ownerId)).toEqual([
            'tab-a:accurate-base:page-1',
            'tab-a',
        ]);
        expect(new Set(nativeRenders.map(([, args]) => args.sessionOwnerId))).toEqual(
            new Set([result.current.renderOwnerId]),
        );
        expect(nativeRenders.map(([, args]) => args.requestContext.generation)).toEqual([1, 1]);
        expect(nativeRenders.map(([, args]) => args.requestContext.priority)).toEqual([100, 0]);
        unmount();
        await waitFor(() => expect(
            transportMocks.invoke.mock.calls.some(([command, args]) => (
                command === 'release_ppe_session_owner'
                && args.sessionOwnerId === result.current.renderOwnerId
            )),
        ).toBe(true));
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
    });

    it('save-over cùng path đổi document token và owner epoch', () => {
        const { result, rerender, unmount } = renderHook(
            ({ token }) => useTileRenderer({
                file: {
                    path: 'D:\\jobs\\revision-owner.pdf',
                    name: 'revision-owner.pdf',
                    type: 'application/pdf',
                },
                pdfRef: null,
                pdfUrl: 'localfile://revision-owner',
                activePage: 1,
                isActive: true,
                renderDocumentToken: token,
            }),
            { initialProps: { token: '100:200:300' } },
        );
        const firstOwner = result.current.renderOwnerId;
        expect(result.current.renderDocumentToken).toBe('100:200:300');

        rerender({ token: '101:201:301' });
        expect(result.current.renderDocumentToken).toBe('101:201:301');
        expect(result.current.renderOwnerId).not.toBe(firstOwner);
        unmount();
    });

    it('giữ identity theo tab khi tab khác đăng ký revision mới cùng path', () => {
        const path = 'D:\\jobs\\same-path-two-tabs.pdf';
        const file = {
            path,
            name: 'same-path-two-tabs.pdf',
            type: 'application/pdf',
        };
        const { result, rerender, unmount } = renderHook(
            ({ activePage }) => useTileRenderer({
                file,
                pdfRef: null,
                pdfUrl: 'localfile://same-path-two-tabs-a',
                activePage,
                isActive: true,
                renderDocumentToken: '100:200:300',
            }),
            { initialProps: { activePage: 1 } },
        );

        registerRenderDocumentIdentity(path, '101:201:301');
        rerender({ activePage: 2 });

        expect(result.current.renderDocumentToken).toBe('100:200:300');
        unmount();
    });

    it('shadow opt-in chỉ dựng nền PPE một lần và không thay bitmap đang hiển thị', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\shadow.pdf',
                name: 'shadow.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://shadow',
            activePage: 1,
            isActive: true,
            viewerEngineMode: 'current',
            viewerShadowEnabled: true,
        }));

        const visible = await result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'display' },
        );
        expect(visible.url).toMatch(/^blob:test-/);
        await waitFor(() => expect(
            transportMocks.invoke.mock.calls.filter(([command]) => command === 'shadow_render_ppe_page'),
        ).toHaveLength(1));
        expect(transportMocks.invoke).toHaveBeenCalledWith(
            'shadow_render_ppe_page',
            expect.objectContaining({
                page: 1,
                dpi: 96,
                requestContext: expect.objectContaining({
                    purpose: 'background',
                    priority: 500,
                }),
            }),
        );

        await result.current.getTileUrl(
            1, 0, 1.25, undefined, undefined, undefined, undefined,
            { colorStage: 'display' },
        );
        await act(async () => new Promise(resolve => window.setTimeout(resolve, 0)));
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'shadow_render_ppe_page'))
            .toHaveLength(1);
        unmount();
    });

    it('chỉ fallback HTTP khi worker native chưa bắt đầu request', async () => {
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error(
                    'PPE_NATIVE_FALLBACK_BEFORE_START: worker-disabled',
                ));
            }
            return Promise.resolve(true);
        });
        transportMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        } as Response);
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\fallback.pdf',
                name: 'fallback.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://fallback',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        await result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        );

        expect(transportMocks.authenticatedFetch).toHaveBeenCalledTimes(1);
        expect(String(transportMocks.authenticatedFetch.mock.calls[0][0]))
            .toContain('/preflight/viewer-accurate');
        unmount();
        await waitFor(() => expect(
            transportMocks.authenticatedFetch.mock.calls.some(([url, init]) => (
                String(url).includes('/preflight/viewer-accurate/session?')
                && (init as RequestInit).method === 'DELETE'
            )),
        ).toBe(true));
    });

    it('V27: hybrid không đưa PDFium vào slot accurate khi PPE unsupported', async () => {
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error(
                    'PPE_NATIVE_UNSUPPORTED:{"reason":"image_codec","detail":"Trang dùng JPX"}',
                ));
            }
            if (command === 'render_pdf_page') {
                return Promise.resolve(new Uint8Array([137, 80, 78, 71, 13, 10]).buffer);
            }
            return Promise.resolve(true);
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\hybrid-jpx.pdf',
                name: 'hybrid-jpx.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://hybrid-jpx',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: false,
            accurateColorPages: [],
            viewerEngineMode: 'hybrid',
        }));

        await expect(result.current.getTileUrl(
            3, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        )).rejects.toThrow('PPE_NATIVE_UNSUPPORTED');
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page'))
            .toHaveLength(1);
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page'))
            .toHaveLength(0);
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        await waitFor(() => expect(result.current.accurateColorError).not.toBeNull());

        await expect(result.current.getTileUrl(
            3, 0, 1.25, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        )).rejects.toThrow('PPE_NATIVE_UNSUPPORTED');
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page'))
            .toHaveLength(1);
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page'))
            .toHaveLength(0);
        unmount();
    });

    it('V27/V1: current giữ accurate fail-closed và nhớ capability, không tự trả PDFium', async () => {
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error(
                    'PPE_NATIVE_UNSUPPORTED:{"reason":"unsupported_transparency","detail":"Trang dùng transparency PPE chưa dựng exact."}',
                ));
            }
            if (command === 'render_pdf_page') {
                return Promise.resolve(new Uint8Array([137, 80, 78, 71, 13, 10]).buffer);
            }
            return Promise.resolve(true);
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\current-transparency.pdf',
                name: 'current-transparency.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://current-transparency',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
            viewerEngineMode: 'current',
        }));

        await expect(result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        )).rejects.toThrow('PPE_NATIVE_UNSUPPORTED');
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page'))
            .toHaveLength(1);
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page'))
            .toHaveLength(0);
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        await waitFor(() => expect(result.current.accurateColorError).not.toBeNull());

        await expect(result.current.getTileUrl(
            1, 0, 1.25, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        )).rejects.toThrow('PPE_NATIVE_UNSUPPORTED');
        // Lần 2 vẫn thất bại với hợp đồng PPE, nhưng không dựng lại capability đã biết.
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page'))
            .toHaveLength(1);
        expect(transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page'))
            .toHaveLength(0);
        unmount();
    });

    it('R25.04.3: gửi viewport PPE trước khi nhường lượt cho công việc UI tiếp theo', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:\\jobs\\invoke-before-yield.pdf', name: 'invoke-before-yield.pdf', type: 'application/pdf' },
            pdfRef: null,
            pdfUrl: 'localfile://invoke-before-yield',
            activePage: 1,
            isActive: true,
            viewerEngineMode: 'ppe-only',
        }));
        const pending = result.current.getTileUrl(
            1, 0, 8, 5120, 3392, 1344, 768,
            { colorStage: 'accurate', priority: 0, groupKey: 'viewport-before-yield' },
        );
        // Không await ở đây: wheel/React có thể chiếm nhiều lượt ngay sau stack này.
        // Native cần được nhận việc trước, để raster chạy đồng thời với UI.
        const submitted = transportMocks.invoke.mock.calls.filter(([command]) => command === 'render_ppe_page');
        await act(async () => { await pending; });
        unmount();
        expect(submitted).toHaveLength(1);
        expect(submitted[0][1]).toMatchObject({
            page: 1, clipX: 5120, clipY: 3392, clipW: 1344, clipH: 768,
            requestContext: { priority: 0, purpose: 'accurate' },
        });
    });

    it('ppe-only fail-loud khi capability chưa được PPE hỗ trợ', async () => {
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error(
                    'PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"Knockout"}',
                ));
            }
            return Promise.resolve(new Uint8Array([137, 80, 78, 71]).buffer);
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\ppe-only.pdf',
                name: 'ppe-only.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://ppe-only',
            activePage: 1,
            isActive: true,
            viewerEngineMode: 'ppe-only',
        }));

        await expect(result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        )).rejects.toThrow('PPE_NATIVE_UNSUPPORTED');
        expect(transportMocks.invoke.mock.calls.some(([command]) => command === 'render_pdf_page'))
            .toBe(false);
        unmount();
    });

    it('fail-closed khi PPE native lỗi sau lúc request đã bắt đầu', async () => {
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error('PPE worker render thất bại sau khi nhận việc.'));
            }
            return Promise.resolve(true);
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\fail-closed.pdf',
                name: 'fail-closed.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://fail-closed',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: false,
            accurateColorPages: [],
            viewerEngineMode: 'hybrid',
        }));

        await act(async () => {
            await expect(result.current.getTileUrl(
                1, 0, 1, undefined, undefined, undefined, undefined,
                { colorStage: 'accurate' },
            )).rejects.toThrow('PPE worker render thất bại');
        });
        expect(transportMocks.authenticatedFetch.mock.calls.some(([url]) => (
            String(url).includes('/preflight/viewer-accurate')
        ))).toBe(false);
        await waitFor(() => expect(result.current.accurateColorError)
            .toContain('PPE worker render thất bại'));
        unmount();
    });

    it('cancel group hủy đúng request PPE native đang chạy mà không báo lỗi màu', async () => {
        let rejectNative!: (error: Error) => void;
        let nativeRequestId = '';
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
            configurable: true,
            value: {},
        });
        transportMocks.invoke.mockImplementation((
            command: string,
            args: { requestContext?: { requestId?: string }; requestId?: string },
        ) => {
            if (command === 'render_ppe_page') {
                nativeRequestId = args.requestContext?.requestId ?? '';
                return new Promise<ArrayBuffer>((_resolve, reject) => {
                    rejectNative = reject;
                });
            }
            if (command === 'cancel_pdf_render') {
                rejectNative(new Error('Render request đã bị hủy.'));
                return Promise.resolve(args.requestId === nativeRequestId);
            }
            return Promise.resolve(true);
        });

        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        const pending = result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', groupKey: 'page:1:page' },
        );
        await waitFor(() => expect(nativeRequestId).toBeTruthy());
        act(() => result.current.cancelAccurateGroup('page:1:page'));

        await expect(pending).rejects.toMatchObject({ name: 'CancelledTileRenderError' });
        await waitFor(() => expect(transportMocks.invoke).toHaveBeenCalledWith(
            'cancel_pdf_render',
            { requestId: nativeRequestId },
        ));
        expect(transportMocks.authenticatedFetch.mock.calls.some(([url]) => (
            String(url).includes('/preflight/viewer-accurate')
        ))).toBe(false);
        expect(result.current.accurateColorError).toBeNull();
        unmount();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('viewport không hủy nền accurate cùng trang đang dựng', async () => {
        const pending: Array<{
            requestId: string;
            resolve: (bytes: ArrayBuffer) => void;
        }> = [];
        transportMocks.invoke.mockImplementation((
            command: string,
            args: { requestContext?: { requestId?: string } },
        ) => {
            if (command !== 'render_ppe_page') return Promise.resolve(true);
            return new Promise<ArrayBuffer>(resolve => {
                pending.push({
                    requestId: args.requestContext?.requestId ?? '',
                    resolve,
                });
            });
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        const base = result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            {
                colorStage: 'accurate',
                groupKey: 'page:1:base',
                ownerId: 'tab-a:accurate-base:page-1',
            },
        );
        await waitFor(() => expect(pending).toHaveLength(1));

        const viewport = result.current.getTileUrl(
            1, 0, 2, 0, 0, 512, 512,
            {
                colorStage: 'accurate',
                groupKey: 'page:1:viewport',
                ownerId: 'tab-a',
                priority: 0,
            },
        );
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(transportMocks.invoke).not.toHaveBeenCalledWith(
            'cancel_pdf_render',
            { requestId: pending[0].requestId },
        );

        await act(async () => {
            for (const request of pending) {
                request.resolve(new Uint8Array([137, 80, 78, 71]).buffer);
            }
            await Promise.all([base, viewport]);
        });
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        unmount();
    });

    it('viewport PPE đang chạy vẫn cho nền full-page cùng trang nối tiếp', async () => {
        const pending: Array<(bytes: ArrayBuffer) => void> = [];
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command !== 'render_ppe_page') return Promise.resolve(true);
            return new Promise<ArrayBuffer>(resolve => pending.push(resolve));
        });
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\cmyk.pdf',
                name: 'cmyk.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        const viewport = result.current.getTileUrl(
            1, 0, 2, 0, 0, 512, 512,
            { colorStage: 'accurate', groupKey: 'page:1:viewport', priority: 0 },
        );
        await waitFor(() => expect(pending).toHaveLength(1));
        const background = result.current.getTileUrl(
            1, 0, 2, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate', groupKey: 'page:1:page', priority: 10 },
        );

        await waitFor(() => expect(pending).toHaveLength(2));
        await act(async () => {
            for (const resolve of pending) {
                resolve(new Uint8Array([137, 80, 78, 71]).buffer);
            }
            await Promise.all([viewport, background]);
        });
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        unmount();
    });

    it('PPE chạy nền không giữ hàng đợi PDFium của trang kế tiếp', async () => {
        let finishAccurate!: (bytes: ArrayBuffer) => void;
        transportMocks.invoke.mockImplementation((command: string) => {
            if (command === 'render_ppe_page') {
                return new Promise<ArrayBuffer>(resolve => {
                    finishAccurate = resolve;
                });
            }
            if (command === 'render_pdf_page') {
                return Promise.resolve(new Uint8Array([137, 80, 78, 71]).buffer);
            }
            return Promise.resolve(true);
        });

        const file = {
            path: 'D:\\jobs\\cmyk.pdf',
            name: 'cmyk.pdf',
            type: 'application/pdf',
        };
        const { result, unmount } = renderHook(() => useTileRenderer({
            file,
            pdfRef: null,
            pdfUrl: 'localfile://cmyk',
            activePage: 1,
            isActive: true,
            accurateColorEnabled: true,
            accurateColorPages: [1, 2],
        }));

        const accuratePromise = result.current.getTileUrl(
            1, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'accurate' },
        );
        await waitFor(() => expect(finishAccurate).toBeTypeOf('function'));

        // PPE vẫn đang pending, nhưng ảnh display của trang 2 phải đi qua PDFium ngay.
        const display = await result.current.getTileUrl(
            2, 0, 1, undefined, undefined, undefined, undefined,
            { colorStage: 'display' },
        );
        expect(display.url).toMatch(/^blob:test-/);
        expect(transportMocks.invoke).toHaveBeenCalledWith('render_pdf_page', expect.objectContaining({
            page: 2,
        }));

        await act(async () => {
            finishAccurate(new Uint8Array([137, 80, 78, 71, 13, 10]).buffer);
            await accuratePromise;
        });
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        unmount();
    });

    it('từ chối ngay lập tức khi pageNum vượt quá numPages của tài liệu', async () => {
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: {
                path: 'D:\\jobs\\single-page.pdf',
                name: 'single-page.pdf',
                type: 'application/pdf',
            },
            pdfRef: null,
            pdfUrl: 'localfile://single-page',
            activePage: 1,
            isActive: true,
            numPages: 1,
            accurateColorEnabled: true,
            accurateColorPages: [1],
        }));

        await expect(
            result.current.getTileUrl(
                2, 0, 1, undefined, undefined, undefined, undefined,
                { colorStage: 'accurate' },
            ),
        ).rejects.toMatchObject({ name: 'CancelledTileRenderError' });

        expect(transportMocks.invoke).not.toHaveBeenCalled();
        expect(transportMocks.authenticatedFetch).not.toHaveBeenCalled();
        unmount();
    });

    it('AUDIT §R24.05 / F3: lỗi createImageBitmap trên PXRG phải fallback raster thật, không cache GIF trắng', async () => {
        const bytes = new ArrayBuffer(16 + 2 * 2 * 4);
        new Uint8Array(bytes).set([0x50, 0x58, 0x52, 0x47]); // "PXRG"
        const header = new DataView(bytes);
        header.setUint32(4, 2, true); // width = 2
        header.setUint32(8, 2, true); // height = 2
        header.setUint32(12, 8, true); // stride = 8
        new Uint8Array(bytes, 16).fill(255);
        transportMocks.invoke.mockImplementation(async (command: string) => command === 'render_pdf_page' ? bytes : true);
        vi.stubGlobal('ImageData', class {});
        const decoder = vi.fn(async () => { throw new Error('decode allocation failed'); });
        vi.stubGlobal('createImageBitmap', decoder);
        const { result, unmount } = renderHook(() => useTileRenderer({
            file: { path: 'D:\\audit\\pxrg.pdf', name: 'pxrg.pdf', type: 'application/pdf' },
            pdfRef: null,
            pdfUrl: 'localfile://audit-pxrg',
            activePage: 1,
            isActive: true,
        }));
        let source: TileUrlSource | undefined;
        await act(async () => { source = await result.current.getTileUrl(1, 0, 1); });
        expect(decoder).toHaveBeenCalledTimes(1);
        expect(source?.cacheable).toBe(true);
        expect(source?.bitmap).toBeUndefined();
        expect(source?.url).toMatch(/^data:image\/bmp;base64,/);
        expect(source?.url).not.toMatch(/^data:image\/gif/);
        unmount();
    });
});
