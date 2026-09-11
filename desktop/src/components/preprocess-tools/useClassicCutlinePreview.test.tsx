// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useClassicCutlinePreview } from './useClassicCutlinePreview';
import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';


const apiMocks = vi.hoisted(() => ({
    inspectStickerSourceManifest: vi.fn(),
    detectStickerSourceManifest: vi.fn(),
    previewStickerCutline: vi.fn(),
    startStickerCutlinePreviewJob: vi.fn(),
    readStickerCutlinePreviewJob: vi.fn(),
    cancelStickerCutlinePreviewJob: vi.fn(),
    closeStickerSheetSession: vi.fn(),
}));

vi.mock('../../lib/stickerSheetApi', () => apiMocks);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const inspection = {
    session_id: '0123456789abcdef0123456789abcdef',
    stage: 'inspected',
    original_name: 'tem.pdf',
    source_kind: 'pdf',
    mime_type: 'application/pdf',
    boundary_source: 'vector',
    strategy_confidence: 0.96,
    needs_review: false,
    page_count: 1,
    source_width_px: 120,
    source_height_px: 80,
    dpi: [300, 300],
    physical_width_mm: 10,
    physical_height_mm: 8,
    preview_width_px: 120,
    preview_height_px: 80,
    has_existing_cut: false,
    has_vector: true,
    has_raster: false,
    has_alpha: false,
    cut_contour_count: 0,
    pages: [{
        page_number: 1,
        width_mm: 10,
        height_mm: 8,
        has_existing_cut: false,
        has_vector: true,
        has_raster: false,
        has_alpha: false,
        cut_contour_count: 0,
    }],
    warnings: [],
    preview_url: '/unused-preview.png',
};

const detection = {
    session_id: inspection.session_id,
    stage: 'mask-review',
    original_name: 'tem.pdf',
    source_kind: 'pdf',
    boundary_source: 'vector',
    strategy_confidence: 0.96,
    needs_review: false,
    page_count: 1,
    source_page: 1,
    original_width_px: 120,
    original_height_px: 80,
    analysis_width_px: 120,
    analysis_height_px: 80,
    preview_width_px: 120,
    preview_height_px: 80,
    dpi: [300, 300],
    model: 'birefnet-lite',
    model_seconds: 0,
    postprocess_seconds: 0,
    mask_revision: 1,
    refinement_available: false,
    alpha_threshold: 128,
    shadow_cleanup: 'auto',
    instances: [{
        id: 1, x: 10, y: 10, width: 100, height: 60,
        area_px: 6000, confidence: 0.96, uncertain_ratio: 0,
    }],
    warnings: [],
    vector_geometry_ref: null,
    preview_url: '/unused-preview.png',
    labels_url: '/unused-labels.png',
    uncertainty_url: '/unused-uncertainty.png',
};

const alphaInspection = {
    ...inspection,
    has_vector: false,
    has_raster: true,
    has_alpha: true,
    pages: inspection.pages.map(page => ({
        ...page, has_vector: false, has_raster: true, has_alpha: true,
    })),
};

const multipleAlphaDetection = {
    ...detection,
    boundary_source: 'alpha',
    instances: [detection.instances[0], { ...detection.instances[0], id: 2 }],
};

function preview(fingerprint: string, d = 'M 1 1 C 2 2 3 3 4 4 Z') {
    return {
        page_number: 1,
        mask_revision: 1,
        preview_width_px: 120,
        preview_height_px: 80,
        paths: [{ instance_id: 1, d, segment_count: 1 }],
        fingerprint,
        segment_count: 1,
    };
}

const file = new File(['pdf'], 'tem.pdf', { type: 'application/pdf' });
const resolveSourceFile = vi.fn(async () => file);
const TEST_DOCUMENT_IDENTITY = 'tem.pdf|order:1|rot:0';
let workspaceStore: ReturnType<typeof createWorkspaceStore>;

function WorkspaceWrapper({ children }: { children: ReactNode }) {
    return (
        <WorkspaceContext.Provider value={workspaceStore}>
            {children}
        </WorkspaceContext.Provider>
    );
}

function options(tension: number, documentIdentity = TEST_DOCUMENT_IDENTITY) {
    return {
        enabled: true,
        resolveSourceFile,
        documentIdentity,
        pageNumber: 1,
        pageInstanceId: 'instance-1',
        cutMode: 'original',
        cornerStyle: 'round',
        offsetMm: 0,
        bleedMm: 2,
        fillHoles: true,
        curveTension: tension,
        cutlineDenoise: 30,
        forceContour: false,
        removeWhiteBg: true,
    };
}

async function startFirstPreview(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(220);
    });
    await act(async () => {
        await vi.advanceTimersByTimeAsync(160);
    });
}

describe('useClassicCutlinePreview — realtime nhẹ', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        resolveSourceFile.mockClear();
        workspaceStore = createWorkspaceStore();
        workspaceStore.getState().setViewerActivePagePhysical({
            documentIdentity: TEST_DOCUMENT_IDENTITY,
            viewerPage: 1,
            sourcePage: 1,
            pageInstanceId: 'instance-1',
            rotation: 0,
            widthPt: 595.275590551,
            heightPt: 841.88976378,
        });
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(inspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue(detection);
        apiMocks.closeStickerSheetSession.mockResolvedValue(undefined);
        apiMocks.cancelStickerCutlinePreviewJob.mockResolvedValue(true);
        // Giữ các test legacy tập trung vào payload/canonical: job hoàn tất
        // ngay khi preview cũ giả lập trả frame đã verifier.
        apiMocks.startStickerCutlinePreviewJob.mockImplementation(async (
            sessionId: string,
            generation: number,
            request: Parameters<typeof apiMocks.previewStickerCutline>[1],
        ) => ({
            job_id: `${generation}`.padStart(32, '0'),
            generation,
            page_number: request.pageNumber ?? 1,
            base_revision: request.baseRevision,
            target_simplify_mm: request.cutlineSimplifyMm ?? 0,
            status: 'ready',
            draft: null,
            result: await apiMocks.previewStickerCutline(sessionId, request),
            error: null,
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['alpha', 'simple-bg', 'ai'])(
        'AUTO chọn 0,10 ngay lượt fit đầu cho biên %s, không fit 0 rồi fit lại', async boundary => {
            apiMocks.inspectStickerSourceManifest.mockResolvedValue({
                ...alphaInspection, has_alpha: boundary === 'alpha',
                pages: alphaInspection.pages.map(page => ({ ...page, has_alpha: boundary === 'alpha' })),
            });
            apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, boundary_source: boundary });
            apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
            const hook = renderHook(() => useClassicCutlinePreview({
                ...options(50), autoSimplify: true,
            }), { wrapper: WorkspaceWrapper });

            expect(hook.result.current.effectiveSimplifyMm).toBe(0);
            await startFirstPreview();
            expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
            expect(apiMocks.previewStickerCutline.mock.calls[0][1].cutlineSimplifyMm).toBe(0.1);
            expect(hook.result.current.effectiveSimplifyMm).toBe(0.1);
            expect(hook.result.current.canonicalReference?.simplifyMm).toBe(0.1);
            await act(async () => { await vi.advanceTimersByTimeAsync(400); });
            expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
            hook.unmount();
        },
    );

    it.each([false, undefined])('AUTO=%s giữ lựa chọn 0 và tương thích caller cũ trên Alpha', async autoSimplify => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, boundary_source: 'alpha' });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), autoSimplify, cutlineSimplifyMm: 0,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        expect(apiMocks.previewStickerCutline.mock.calls[0][1].cutlineSimplifyMm).toBe(0);
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(hook.result.current.canonicalReference?.simplifyMm).toBe(0);
        hook.unmount();
    });

    it('AUTO nhiều mảng Alpha vẫn chỉ fit toàn trang một lần ở 0,10', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue(multipleAlphaDetection);
        apiMocks.previewStickerCutline.mockResolvedValue({ ...preview('a'.repeat(64)), classic_whole_page: true });
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), autoSimplify: true,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        expect(apiMocks.previewStickerCutline.mock.calls[0][1]).toMatchObject({
            classicWholePage: true, cutlineSimplifyMm: 0.1,
        });
        expect(hook.result.current.effectiveSimplifyMm).toBe(0.1);
        expect(hook.result.current.canonicalReference).toMatchObject({ wholePage: true, simplifyMm: 0.1 });
        hook.unmount();
    });

    it('AUTO chưa có bằng chứng trang không chứa CUT thì giữ 0', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...alphaInspection,
            pages: alphaInspection.pages.map(page => ({ ...page, has_existing_cut: undefined })),
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, boundary_source: 'alpha' });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), autoSimplify: true,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(apiMocks.previewStickerCutline.mock.calls[0][1].cutlineSimplifyMm).toBe(0);
        hook.unmount();
    });

    it('AUTO nhận diện lỗi không công bố dung sai 0,10 hay tự fit nguồn khác', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockRejectedValueOnce(new Error('Không đọc được Alpha'));
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), autoSimplify: true,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(hook.result.current.canonicalReference).toBeNull();
        expect(hook.result.current.error).toContain('Không đọc được Alpha');
        expect(apiMocks.previewStickerCutline).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('tắt AUTO về 0 giữ session, chờ đúng frame thủ công trước khi xuất', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, boundary_source: 'alpha' });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(({ automatic }: { automatic: boolean }) => useClassicCutlinePreview({
            ...options(50), autoSimplify: automatic, cutlineSimplifyMm: 0,
        }), { initialProps: { automatic: true }, wrapper: WorkspaceWrapper });
        await startFirstPreview();
        hook.rerender({ automatic: false });
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(hook.result.current.canonicalReference).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline.mock.calls[1][1].cutlineSimplifyMm).toBe(0);
        expect(hook.result.current.canonicalReference?.simplifyMm).toBe(0);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it.each([
        { boundary: 'vector', existing: false, cutMode: 'original' },
        { boundary: 'page-box', existing: false, cutMode: 'original' },
        { boundary: 'existing-cut', existing: true, cutMode: 'original' },
        { boundary: 'alpha', existing: true, cutMode: 'alpha' },
    ])('AUTO không áp vào biên $boundary khi trang có CUT=$existing', async sample => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...alphaInspection, has_existing_cut: sample.existing,
            pages: alphaInspection.pages.map(page => ({ ...page, has_existing_cut: sample.existing })),
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, boundary_source: sample.boundary });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), cutMode: sample.cutMode, autoSimplify: true,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        expect(apiMocks.previewStickerCutline.mock.calls[0][1].cutlineSimplifyMm).toBe(0);
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(hook.result.current.canonicalReference?.simplifyMm).toBe(0);
        hook.unmount();
    });

    it('AUTO không lấy quyền Alpha ở trang khác để áp lên trang vector đang xem', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...inspection, page_count: 2, has_alpha: true,
            pages: [inspection.pages[0], { ...alphaInspection.pages[0], page_number: 2 }],
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, page_count: 2 });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), autoSimplify: true,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.canSimplify).toBe(true);
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(apiMocks.previewStickerCutline.mock.calls[0][1].cutlineSimplifyMm).toBe(0);
        hook.unmount();
    });

    it('AUTO không dùng nguồn Alpha cũ trong lúc đang nhận diện file mới', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue({ ...detection, boundary_source: 'alpha' });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(({ identity }: { identity: string }) => useClassicCutlinePreview({
            ...options(50, identity), autoSimplify: true,
        }), { initialProps: { identity: TEST_DOCUMENT_IDENTITY }, wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.effectiveSimplifyMm).toBe(0.1);
        const next = deferred<typeof detection>();
        apiMocks.detectStickerSourceManifest.mockImplementationOnce(() => next.promise);
        hook.rerender({ identity: 'new.pdf' });
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(hook.result.current.canonicalReference).toBeNull();
        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        await act(async () => {
            next.resolve({ ...detection, boundary_source: 'vector' });
            await Promise.resolve();
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        expect(hook.result.current.effectiveSimplifyMm).toBe(0);
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline.mock.calls[1][1].cutlineSimplifyMm).toBe(0);
        hook.unmount();
    });

    it('hủy job cũ và chỉ công bố mức kéo cuối cùng', async () => {
        const first = deferred<ReturnType<typeof preview>>();
        apiMocks.previewStickerCutline
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce(preview('b'.repeat(64), 'M 2 2 C 3 3 4 4 5 5 Z'));
        const hook = renderHook(
            ({ tension }: { tension: number }) => useClassicCutlinePreview(options(tension)),
            { initialProps: { tension: 50 }, wrapper: WorkspaceWrapper },
        );

        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);

        act(() => {
            hook.rerender({ tension: 10 });
            hook.rerender({ tension: 30 });
            hook.rerender({ tension: 80 });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(160);
        });
        // Job mới được gửi ngay, không đợi fitter cũ nhả CPU; ba lần kéo vẫn
        // chỉ để lại request cuối sau debounce.
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline.mock.calls[1][1]).toMatchObject({
            curveTension: 80,
        });
        expect(apiMocks.cancelStickerCutlinePreviewJob).toHaveBeenCalledWith(
            inspection.session_id, 1,
        );

        await act(async () => {
            first.resolve(preview('a'.repeat(64), 'M 1 1 C 2 2 3 3 4 4 Z'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        expect(hook.result.current.preview?.fingerprint).toBe('b'.repeat(64));
        expect(hook.result.current.preview?.paths[0].d).toContain('M 2 2');
        expect(apiMocks.inspectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);

        hook.unmount();
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledWith(inspection.session_id);
    });

    it('hủy request và đóng session khi unmount', async () => {
        const pending = deferred<ReturnType<typeof preview>>();
        apiMocks.previewStickerCutline.mockImplementationOnce(() => pending.promise);
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), {
            wrapper: WorkspaceWrapper,
        });

        await startFirstPreview();
        const signal = apiMocks.previewStickerCutline.mock.calls[0][1].signal as AbortSignal;
        expect(signal.aborted).toBe(false);

        hook.unmount();
        expect(signal.aborted).toBe(true);
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledWith(inspection.session_id);
    });

    it('PDF Alpha nhiều mảng lấy preview toàn trang, giữ session tới khi đóng', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue(multipleAlphaDetection);
        apiMocks.previewStickerCutline.mockResolvedValue({ ...preview('a'.repeat(64)), classic_whole_page: true });
        const hook = renderHook(
            ({ simplify }: { simplify: number }) => useClassicCutlinePreview({
                ...options(50), cutlineSimplifyMm: simplify,
            }),
            { initialProps: { simplify: 0 }, wrapper: WorkspaceWrapper },
        );
        await startFirstPreview();
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledWith(
            inspection.session_id, expect.objectContaining({ strategy: 'alpha' }),
        );
        expect(hook.result.current).toMatchObject({
            canSimplify: true,
            canonicalReference: { wholePage: true, simplifyMm: 0 },
            isPreparing: false, isUpdating: false, error: '',
        });
        expect(hook.result.current.warning).toBe('');
        expect(apiMocks.closeStickerSheetSession).not.toHaveBeenCalled();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledWith(inspection.session_id,
            expect.objectContaining({ classicWholePage: true, pageNumber: 1 }));
        hook.rerender({ simplify: 0.1 });
        await act(async () => { await vi.advanceTimersByTimeAsync(160); });
        expect(hook.result.current.directSimplifyOnly).not.toBe(true);
        expect(hook.result.current.canonicalReference).toMatchObject({ wholePage: true, simplifyMm: .1 });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        hook.unmount();
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledTimes(1);
    });

    it.each(['file', 'page', 'instance', 'disabled'] as const)(
        'preview toàn trang được xóa ngay khi scope đổi: %s', async scope => {
            apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
            apiMocks.detectStickerSourceManifest.mockResolvedValue(multipleAlphaDetection);
            apiMocks.previewStickerCutline.mockResolvedValue({ ...preview('a'.repeat(64)), classic_whole_page: true });
            const initial = {
                identity: TEST_DOCUMENT_IDENTITY, page: 1, instance: 'instance-1', enabled: true,
            };
            const hook = renderHook(
                ({ identity, page, instance, enabled }: typeof initial) => useClassicCutlinePreview({
                    ...options(50, identity), pageNumber: page, pageInstanceId: instance, enabled,
                }),
                { initialProps: initial, wrapper: WorkspaceWrapper },
            );
            await startFirstPreview();
            expect(hook.result.current.canonicalReference?.wholePage).toBe(true);
            hook.rerender({
                identity: scope === 'file' ? 'new-file.pdf' : initial.identity,
                page: scope === 'page' ? 2 : initial.page,
                instance: scope === 'instance' ? 'instance-2' : initial.instance,
                enabled: scope !== 'disabled',
            });
            expect(hook.result.current.directSimplifyOnly).not.toBe(true);
            expect(hook.result.current.canSimplify).not.toBe(true);
            expect(hook.result.current.preview).toBeNull();
            expect(hook.result.current.canonicalReference).toBeNull();
            expect(hook.result.current.warning).toBe('');
            expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
            hook.unmount();
        },
    );

    it.each([
        { name: 'ảnh raster', sourceKind: 'raster', boundary: 'alpha', count: 2, existingCut: false },
        { name: 'vector', sourceKind: 'pdf', boundary: 'vector', count: 2, existingCut: false },
        { name: 'CutContour', sourceKind: 'pdf', boundary: 'existing-cut', count: 2, existingCut: true },
        { name: 'khung trang', sourceKind: 'pdf', boundary: 'page-box', count: 2, existingCut: false },
        { name: 'Alpha rỗng', sourceKind: 'pdf', boundary: 'alpha', count: 0, existingCut: false },
        { name: 'Alpha của trang có CutContour', sourceKind: 'pdf', boundary: 'alpha', count: 2, existingCut: true },
    ])('không mở Simplify trực tiếp cho nguồn không thuộc hợp đồng: $name', async sample => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...alphaInspection, source_kind: sample.sourceKind, has_existing_cut: sample.existingCut,
            pages: alphaInspection.pages.map(page => ({ ...page, has_existing_cut: sample.existingCut })),
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({
            ...detection, boundary_source: sample.boundary,
            instances: Array.from({ length: sample.count }, (_, index) => ({ ...detection.instances[0], id: index + 1 })),
        });
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.canSimplify).not.toBe(true);
        expect(hook.result.current.directSimplifyOnly).not.toBe(true);
        expect(hook.result.current.error).not.toBe('');
        expect(hook.result.current.preview).toBeNull();
        expect(hook.result.current.canonicalReference).toBeNull();
        expect(apiMocks.previewStickerCutline).not.toHaveBeenCalled();
        expect(apiMocks.closeStickerSheetSession).not.toHaveBeenCalled();
        hook.unmount();
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledWith(inspection.session_id);
    });

    it('cuộn tới trang 12 bỏ phản hồi preview toàn trang của trang 2 trả muộn', async () => {
        const late = deferred<ReturnType<typeof preview> & { classic_whole_page: boolean }>();
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({ ...alphaInspection, page_count: 13,
            pages: [2,12].map(page_number => ({ ...alphaInspection.pages[0], page_number })) });
        apiMocks.detectStickerSourceManifest.mockResolvedValue(multipleAlphaDetection);
        apiMocks.previewStickerCutline.mockImplementationOnce(() => late.promise)
            .mockResolvedValueOnce({ ...preview('c'.repeat(64)), page_number: 12, classic_whole_page: true });
        const hook = renderHook(({ page }: { page: number }) => useClassicCutlinePreview({
            ...options(50), pageNumber: page, pageInstanceId: `page-${page}`, cutlineSimplifyMm: .1,
        }), { initialProps: { page: 2 }, wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(apiMocks.previewStickerCutline.mock.calls[0][1]).toMatchObject({ pageNumber: 2, classicWholePage: true });
        hook.rerender({ page: 12 });
        await startFirstPreview();
        // Trang mới được start ngay, không bị hàng đợi của job trang 2 chặn.
        expect(hook.result.current.preview?.page_number).toBe(12);
        expect(hook.result.current.canonicalReference).toMatchObject({ pageNumber: 12 });
        await act(async () => {
            late.resolve({ ...preview('b'.repeat(64)), page_number: 2, classic_whole_page: true });
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(100);
        });
        expect(apiMocks.previewStickerCutline.mock.calls[1][1]).toMatchObject({ pageNumber: 12, classicWholePage: true, cutlineSimplifyMm: .1 });
        expect(hook.result.current.preview?.page_number).toBe(12);
        expect(hook.result.current.canonicalReference).toMatchObject({ pageNumber: 12, wholePage: true, simplifyMm: .1 });
        hook.unmount();
    });

    it('quay lại trang đã xem thì dùng lại manifest và CUT preview trong cache', async () => {
        const multiPageInspection = {
            ...inspection,
            page_count: 2,
            pages: [1, 2].map(pageNumber => ({
                ...inspection.pages[0],
                page_number: pageNumber,
            })),
        };
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(multiPageInspection);
        apiMocks.detectStickerSourceManifest.mockImplementation(async (_sessionId, options) => ({
            ...detection,
            page_count: 2,
            source_page: options?.pageNumber ?? 1,
        }));
        apiMocks.previewStickerCutline.mockImplementation(async (_sessionId, options) => ({
            ...preview(`${options?.pageNumber ?? 1}`.repeat(64)),
            page_number: options?.pageNumber ?? 1,
        }));

        const hook = renderHook(
            ({ page }: { page: number }) => useClassicCutlinePreview({
                ...options(50),
                pageNumber: page,
                pageInstanceId: `instance-${page}`,
            }),
            { initialProps: { page: 1 }, wrapper: WorkspaceWrapper },
        );

        await startFirstPreview();
        expect(hook.result.current.preview?.page_number).toBe(1);
        expect(apiMocks.inspectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);

        hook.rerender({ page: 2 });
        await startFirstPreview();
        expect(hook.result.current.preview?.page_number).toBe(2);
        expect(apiMocks.inspectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);

        hook.rerender({ page: 1 });
        await act(async () => { await Promise.resolve(); });
        expect(hook.result.current.preview?.page_number).toBe(1);
        expect(hook.result.current.canSimplify).toBe(true);
        expect(hook.result.current.isUpdating).toBe(false);
        expect(apiMocks.inspectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);

        hook.unmount();
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledTimes(1);
    });

    it('backend cũ trả mảng tách không được coi là preview toàn trang', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockResolvedValue(multipleAlphaDetection);
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.preview).toBeNull();
        expect(hook.result.current.canonicalReference).toBeNull();
        expect(hook.result.current.error).not.toBe('');
        hook.unmount();
    });

    it('lỗi nhận diện PDF Alpha không được biến thành quyền áp Simplify trực tiếp', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue(alphaInspection);
        apiMocks.detectStickerSourceManifest.mockRejectedValueOnce(new Error('Không đọc được Alpha'));
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(hook.result.current.error).toContain('Không đọc được Alpha');
        expect(hook.result.current.canSimplify).not.toBe(true);
        expect(hook.result.current.directSimplifyOnly).not.toBe(true);
        expect(apiMocks.previewStickerCutline).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('manifest Alpha nhiều mảng trả muộn không được bật áp trực tiếp trên file mới', async () => {
        const oldDetection = deferred<typeof multipleAlphaDetection>();
        const nextSession = '11111111111111111111111111111111';
        apiMocks.inspectStickerSourceManifest
            .mockResolvedValueOnce(alphaInspection)
            .mockResolvedValueOnce({ ...inspection, session_id: nextSession });
        apiMocks.detectStickerSourceManifest
            .mockImplementationOnce(() => oldDetection.promise)
            .mockResolvedValueOnce({ ...detection, session_id: nextSession });
        apiMocks.previewStickerCutline.mockResolvedValue(preview('b'.repeat(64)));
        const hook = renderHook(
            ({ identity }: { identity: string }) => useClassicCutlinePreview(options(50, identity)),
            { initialProps: { identity: TEST_DOCUMENT_IDENTITY }, wrapper: WorkspaceWrapper },
        );
        await startFirstPreview();
        expect(hook.result.current.isPreparing).toBe(true);
        hook.rerender({ identity: 'next-file.pdf' });
        await startFirstPreview();
        expect(hook.result.current.canonicalReference?.fingerprint).toBe('b'.repeat(64));
        await act(async () => {
            oldDetection.resolve(multipleAlphaDetection);
            await Promise.resolve();
        });
        expect(hook.result.current.directSimplifyOnly).not.toBe(true);
        expect(hook.result.current.warning).toBe('');
        expect(hook.result.current.error).toBe('');
        expect(hook.result.current.canonicalReference?.fingerprint).toBe('b'.repeat(64));
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('đơn giản hóa đổi đúng request, loại canonical cũ và chỉ nhận mức cuối cùng', async () => {
        const pending = deferred<ReturnType<typeof preview>>();
        const completed = {
            ...preview('c'.repeat(64)),
            quality: {
                simplification: {
                    before_segments: 80,
                    after_segments: 24,
                    maximum_error_bound_mm: 0.089,
                    changed: true,
                },
            },
        };
        const middle = deferred<ReturnType<typeof preview>>();
        const latest = deferred<typeof completed>();
        apiMocks.previewStickerCutline
            .mockResolvedValueOnce(preview('a'.repeat(64)))
            .mockImplementationOnce(() => pending.promise)
            .mockImplementationOnce(() => middle.promise)
            .mockImplementationOnce(() => latest.promise);
        const hook = renderHook(
            ({ simplify }: { simplify: number }) => useClassicCutlinePreview({
                ...options(50), cutlineSimplifyMm: simplify,
            }),
            { initialProps: { simplify: 0 }, wrapper: WorkspaceWrapper },
        );

        await startFirstPreview();
        expect(apiMocks.previewStickerCutline.mock.calls[0][1]).toMatchObject({
            cutlineSimplifyMm: 0,
        });
        expect(hook.result.current.canonicalReference).toMatchObject({
            fingerprint: 'a'.repeat(64), simplifyMm: 0,
        });

        hook.rerender({ simplify: 0.05 });
        expect(hook.result.current.canonicalReference).toBeNull();
        expect(hook.result.current.preview?.fingerprint).toBe('a'.repeat(64));
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        expect(apiMocks.previewStickerCutline.mock.calls[1][1]).toMatchObject({
            cutlineSimplifyMm: 0.05,
        });

        hook.rerender({ simplify: 0.08 });
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        hook.rerender({ simplify: 0.1 });
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(4);
        expect(apiMocks.previewStickerCutline.mock.calls[2][1]).toMatchObject({
            cutlineSimplifyMm: 0.08,
        });
        expect(apiMocks.previewStickerCutline.mock.calls[3][1]).toMatchObject({
            cutlineSimplifyMm: 0.1,
        });
        expect(hook.result.current.canonicalReference).toBeNull();
        await act(async () => {
            pending.resolve(preview('b'.repeat(64)));
            middle.resolve(preview('d'.repeat(64)));
            await Promise.resolve();
            await Promise.resolve();
        });
        // QUALITY (audit 2026-09-10 §FAIR.4): fit cũ trả chậm không được
        // bật lại quyền xuất trong lúc mức 0,10 mm còn chưa có vector thật.
        expect(hook.result.current.canonicalReference).toBeNull();
        expect(hook.result.current.isUpdating).toBe(true);
        expect(hook.result.current.preview?.fingerprint).toBe('a'.repeat(64));
        await act(async () => {
            latest.resolve(completed);
            await Promise.resolve();
        });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(4);
        expect(hook.result.current.canonicalReference).toMatchObject({
            fingerprint: 'c'.repeat(64), simplifyMm: 0.1,
        });
        expect(hook.result.current.preview?.quality?.simplification).toMatchObject({
            before_segments: 80, after_segments: 24, changed: true,
        });
        expect(apiMocks.inspectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it.each([
        [undefined, 0],
        [Number.NaN, 0],
        [Number.POSITIVE_INFINITY, 0],
        [-1, 0],
        [1, 0.1],
    ])('preview chuẩn hóa Simplify %s về %s mm', async (value, expected) => {
        apiMocks.previewStickerCutline.mockResolvedValue(preview('a'.repeat(64)));
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(50), cutlineSimplifyMm: value,
        }), { wrapper: WorkspaceWrapper });
        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledWith(
            inspection.session_id,
            expect.objectContaining({ cutlineSimplifyMm: expected }),
        );
        expect(hook.result.current.canonicalReference).toMatchObject({ simplifyMm: expected });
        hook.unmount();
    });

    it('Simplify lỗi vẫn giữ đường cũ để đối chiếu nhưng không giữ reference để xuất', async () => {
        apiMocks.previewStickerCutline
            .mockResolvedValueOnce(preview('a'.repeat(64)))
            .mockRejectedValueOnce(new Error('Không đơn giản hóa được đường bế.'));
        const hook = renderHook(
            ({ simplify }: { simplify: number }) => useClassicCutlinePreview({
                ...options(50), cutlineSimplifyMm: simplify,
            }),
            { initialProps: { simplify: 0 }, wrapper: WorkspaceWrapper },
        );
        await startFirstPreview();
        hook.rerender({ simplify: 0.02 });
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        expect(hook.result.current.error).toContain('Không đơn giản hóa');
        expect(hook.result.current.isUpdating).toBe(false);
        expect(hook.result.current.preview?.fingerprint).toBe('a'.repeat(64));
        expect(hook.result.current.canonicalReference).toBeNull();
        hook.unmount();
    });

    it('tiếp tục bơm frame mới sau khi nguồn đổi trong lúc frame cũ còn pending', async () => {
        const first = deferred<ReturnType<typeof preview>>();
        apiMocks.previewStickerCutline
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce(preview('b'.repeat(64), 'M 2 2 L 5 5 Z'));
        const hook = renderHook(
            ({ identity }: { identity: string }) => useClassicCutlinePreview(
                {
                    ...options(50, identity),
                    cutlineSimplifyMm: identity === TEST_DOCUMENT_IDENTITY ? 0.05 : 0,
                },
            ),
            {
                initialProps: { identity: TEST_DOCUMENT_IDENTITY },
                wrapper: WorkspaceWrapper,
            },
        );

        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        const oldSignal = apiMocks.previewStickerCutline.mock.calls[0][1].signal as AbortSignal;

        hook.rerender({ identity: 'tem.pdf|order:2|rot:0' });
        expect(hook.result.current.canonicalReference).toBeNull();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(380);
        });
        // Frame cũ chưa trả lời nên frame mới được xếp hàng, không chạy song song.
        expect(oldSignal.aborted).toBe(true);
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);

        await act(async () => {
            first.resolve(preview('a'.repeat(64), 'M 1 1 L 4 4 Z'));
            await Promise.resolve();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(80);
        });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline.mock.calls[1][1]).toMatchObject({
            cutlineSimplifyMm: 0,
        });
        expect(hook.result.current.preview?.fingerprint).toBe('b'.repeat(64));
        expect(hook.result.current.canonicalReference).toMatchObject({ simplifyMm: 0 });
        hook.unmount();
    });

    it('hủy lượt slider cũ, không cấp canonical từ frame stale và poll đến frame ready', async () => {
        const pending = deferred<{
            job_id: string;
            generation: number;
            page_number: number;
            base_revision: number;
            target_simplify_mm: number;
            status: 'simplifying';
            draft: null;
            result: null;
            error: null;
        }>();
        apiMocks.startStickerCutlinePreviewJob
            .mockImplementationOnce(async (_sessionId: string, generation: number, request: { baseRevision: number; pageNumber?: number; cutlineSimplifyMm?: number }) => ({
                job_id: '1'.repeat(32), generation,
                page_number: request.pageNumber ?? 1,
                base_revision: request.baseRevision,
                target_simplify_mm: request.cutlineSimplifyMm ?? 0,
                status: 'simplifying', draft: null, result: null, error: null,
            }))
            .mockImplementationOnce(async (_sessionId: string, generation: number, request: { baseRevision: number; pageNumber?: number; cutlineSimplifyMm?: number }) => ({
                job_id: '2'.repeat(32), generation,
                page_number: request.pageNumber ?? 1,
                base_revision: request.baseRevision,
                target_simplify_mm: request.cutlineSimplifyMm ?? 0,
                status: 'ready', draft: null,
                result: preview('c'.repeat(64)), error: null,
            }));
        apiMocks.readStickerCutlinePreviewJob.mockReturnValue(pending.promise);
        const hook = renderHook(
            ({ tension }: { tension: number }) => useClassicCutlinePreview(options(tension)),
            { initialProps: { tension: 50 }, wrapper: WorkspaceWrapper },
        );

        await startFirstPreview();
        expect(apiMocks.startStickerCutlinePreviewJob).toHaveBeenCalledTimes(1);
        expect(hook.result.current.canonicalReference).toBeNull();

        hook.rerender({ tension: 70 });
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        expect(apiMocks.cancelStickerCutlinePreviewJob).toHaveBeenCalledWith(
            inspection.session_id, 1,
        );
        expect(apiMocks.startStickerCutlinePreviewJob).toHaveBeenCalledTimes(2);
        expect(hook.result.current.canonicalReference).toMatchObject({
            fingerprint: 'c'.repeat(64),
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
            pending.resolve({
                job_id: '1'.repeat(32), generation: 1, page_number: 1,
                base_revision: 1, target_simplify_mm: 0, status: 'simplifying',
                draft: null, result: null, error: null,
            });
        });
        expect(hook.result.current.canonicalReference?.fingerprint).toBe('c'.repeat(64));
        hook.unmount();
    });

    it('Alpha ẩn thanh bo nên preview cũng giữ góc và tension tương thích 50', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...inspection,
            has_vector: false,
            has_alpha: true,
            pages: [{
                ...inspection.pages[0],
                has_vector: false,
                has_alpha: true,
            }],
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({
            ...detection,
            boundary_source: 'alpha',
        });
        apiMocks.previewStickerCutline.mockResolvedValue(
            preview('c'.repeat(64), 'M 3 3 C 4 4 5 5 6 6 Z'),
        );
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(95),
            cutMode: 'alpha',
        }), { wrapper: WorkspaceWrapper });

        await startFirstPreview();
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledWith(
            inspection.session_id,
            expect.objectContaining({
                cutMode: 'alpha',
                cornerStyle: 'preserve',
                curveTension: 50,
            }),
        );
        hook.unmount();
    });

    it('không bỏ nền trắng thì preview lấy khung trang, không tự bám silhouette vector', async () => {
        const hook = renderHook(() => useClassicCutlinePreview({
            ...options(0),
            removeWhiteBg: false,
        }), { wrapper: WorkspaceWrapper });

        // Khung trang dựng ngay trong frontend: không cần chờ timer hay mở session.
        expect(hook.result.current.preview?.preview_width_px).toBeCloseTo(210, 5);
        expect(hook.result.current.preview?.preview_height_px).toBeCloseTo(297, 5);
        expect(hook.result.current.preview?.paths[0].d).toMatch(/^M 0 0 L/);
        expect(apiMocks.inspectStickerSourceManifest).not.toHaveBeenCalled();
        expect(apiMocks.detectStickerSourceManifest).not.toHaveBeenCalled();
        expect(apiMocks.previewStickerCutline).not.toHaveBeenCalled();
        expect(resolveSourceFile).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('kéo độ bo của khung trang đổi hình ngay lập tức và không gọi backend', () => {
        const hook = renderHook(
            ({ tension }: { tension: number }) => useClassicCutlinePreview({
                ...options(tension),
                removeWhiteBg: false,
            }),
            { initialProps: { tension: 0 }, wrapper: WorkspaceWrapper },
        );
        const square = hook.result.current.preview;
        expect(square?.paths[0].d).not.toContain(' C ');

        hook.rerender({ tension: 100 });
        const rounded = hook.result.current.preview;
        // 100% phải là fillet vật lý 3 mm thật, không chỉ đổi fingerprint bằng
        // một cung dưới một pixel như contract cũ phụ thuộc DPI.
        expect(rounded?.paths[0].d).toMatch(/^M 3 0 L 207 0 C/);
        expect(rounded?.fingerprint).not.toBe(square?.fingerprint);
        expect(apiMocks.inspectStickerSourceManifest).not.toHaveBeenCalled();
        expect(apiMocks.previewStickerCutline).not.toHaveBeenCalled();
        hook.unmount();
    });

    it('đổi trạng thái bỏ nền phải dựng lại nguồn preview và thay vector bằng khung trang', async () => {
        apiMocks.previewStickerCutline.mockResolvedValue(
            preview('f'.repeat(64), 'M 0 0 C 40 0 80 0 120 0 Z'),
        );
        const hook = renderHook(
            ({ removeWhiteBg }: { removeWhiteBg: boolean }) => useClassicCutlinePreview({
                ...options(50),
                removeWhiteBg,
            }),
            { initialProps: { removeWhiteBg: true }, wrapper: WorkspaceWrapper },
        );

        await startFirstPreview();
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenLastCalledWith(
            inspection.session_id,
            expect.objectContaining({ strategy: 'vector' }),
        );

        hook.rerender({ removeWhiteBg: false });
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledWith(inspection.session_id);
        expect(hook.result.current.preview?.preview_width_px).toBeCloseTo(210, 5);
        expect(apiMocks.inspectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        hook.unmount();
    });

    it('không chạy AI preview cho PDF raster nhiều trang vì luồng xuất chưa parity', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...inspection,
            boundary_source: 'ai',
            page_count: 2,
            has_vector: false,
            has_raster: true,
            has_alpha: false,
            pages: [1, 2].map(pageNumber => ({
                ...inspection.pages[0],
                page_number: pageNumber,
                has_vector: false,
                has_raster: true,
                has_alpha: false,
            })),
        });
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), {
            wrapper: WorkspaceWrapper,
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(220);
        });

        expect(apiMocks.detectStickerSourceManifest).not.toHaveBeenCalled();
        expect(apiMocks.previewStickerCutline).not.toHaveBeenCalled();
        expect(apiMocks.closeStickerSheetSession).not.toHaveBeenCalled();
        expect(hook.result.current.error).not.toBe('');
        hook.unmount();
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledWith(inspection.session_id);
    });

    it('PDF raster một trang dùng auto để còn mask dự phòng khi AI thiếu RAM', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...inspection,
            boundary_source: 'ai',
            has_vector: false,
            has_raster: true,
            has_alpha: false,
            pages: [{
                ...inspection.pages[0],
                has_vector: false,
                has_raster: true,
                has_alpha: false,
            }],
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({
            ...detection,
            boundary_source: 'simple-bg',
        });
        apiMocks.previewStickerCutline.mockResolvedValue(
            preview('e'.repeat(64), 'M 8 8 L 112 8 L 112 72 L 8 72 Z'),
        );
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), {
            wrapper: WorkspaceWrapper,
        });

        await startFirstPreview();

        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledWith(
            inspection.session_id,
            expect.objectContaining({
                strategy: 'auto',
                pageNumber: 1,
                previewOnly: true,
            }),
        );
        expect(hook.result.current.preview).not.toBeNull();
        hook.unmount();
    });

    it('báo rõ khi preview phải dùng mask simple-bg thô đã tự tăng làm mượt', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...inspection,
            has_vector: false,
            has_raster: true,
            has_alpha: false,
            pages: [{
                ...inspection.pages[0],
                has_vector: false,
                has_raster: true,
                has_alpha: false,
            }],
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({
            ...detection,
            boundary_source: 'simple-bg',
            warnings: ['simple-bg-preview-denoise-fallback'],
        });
        apiMocks.previewStickerCutline.mockResolvedValue(
            preview('9'.repeat(64), 'M 8 8 L 112 8 L 112 72 L 8 72 Z'),
        );
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), {
            wrapper: WorkspaceWrapper,
        });

        await startFirstPreview();

        expect(hook.result.current.warning).toContain('tự tăng Khử răng cưa');
        expect(hook.result.current.preview).not.toBeNull();
        hook.unmount();
    });

    it('vẫn cho preview vector của PDF nhiều trang', async () => {
        apiMocks.inspectStickerSourceManifest.mockResolvedValue({
            ...inspection,
            page_count: 2,
            pages: [1, 2].map(pageNumber => ({
                ...inspection.pages[0],
                page_number: pageNumber,
            })),
        });
        apiMocks.detectStickerSourceManifest.mockResolvedValue({
            ...detection,
            page_count: 2,
        });
        apiMocks.previewStickerCutline.mockResolvedValue(
            preview('d'.repeat(64), 'M 4 4 C 5 5 6 6 7 7 Z'),
        );
        const hook = renderHook(() => useClassicCutlinePreview(options(50)), {
            wrapper: WorkspaceWrapper,
        });

        await startFirstPreview();

        expect(apiMocks.detectStickerSourceManifest).toHaveBeenCalledWith(
            inspection.session_id,
            expect.objectContaining({ strategy: 'vector', pageNumber: 1 }),
        );
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
        hook.unmount();
    });
});
