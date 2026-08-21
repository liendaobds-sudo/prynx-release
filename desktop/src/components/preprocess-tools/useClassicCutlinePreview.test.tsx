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

function preview(fingerprint: string, d: string) {
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

function options(tension: number) {
    return {
        enabled: true,
        resolveSourceFile,
        documentIdentity: TEST_DOCUMENT_IDENTITY,
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
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('serialize một request và chỉ công bố mức kéo cuối cùng', async () => {
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
        // Request đầu vẫn chạy; ba lần kéo chỉ để lại một desired request.
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);

        await act(async () => {
            first.resolve(preview('a'.repeat(64), 'M 1 1 C 2 2 3 3 4 4 Z'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(apiMocks.previewStickerCutline).toHaveBeenCalledTimes(2);
        expect(apiMocks.previewStickerCutline.mock.calls[1][1]).toMatchObject({
            curveTension: 80,
        });
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
        expect(apiMocks.closeStickerSheetSession).toHaveBeenCalledWith(inspection.session_id);
        expect(hook.result.current.error).not.toBe('');
        hook.unmount();
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
