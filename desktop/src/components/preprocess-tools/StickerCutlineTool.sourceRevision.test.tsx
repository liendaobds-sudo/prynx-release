// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    closeStickerSheetSession,
    detectStickerSource,
    inspectStickerSource,
    previewStickerCutline,
    type StickerSourceDetectionPayload,
    type StickerSourceInspectPayload,
} from '../../lib/stickerSheetApi';
import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import { useStickerSheetStore } from './stickerSheetStore';
import StickerCutlineTool from './StickerCutlineTool';

vi.mock('./StickerTool', () => ({ default: () => null }));

vi.mock('../../lib/stickerSheetApi', () => ({
    closeStickerSheetSession: vi.fn(async () => undefined),
    confirmStickerSource: vi.fn(async () => true),
    detectStickerSource: vi.fn(),
    exportStickerSheet: vi.fn(),
    inspectStickerSource: vi.fn(),
    previewStickerCutline: vi.fn(),
}));

const sessionId = 'c'.repeat(32);
const inspection: StickerSourceInspectPayload = {
    inspection: {
        session_id: sessionId, stage: 'inspected', original_name: 'sheet.pdf',
        source_kind: 'pdf', mime_type: 'application/pdf', boundary_source: 'simple-bg',
        strategy_confidence: 0.98, needs_review: false, page_count: 1,
        source_width_px: 300, source_height_px: 300, dpi: [300, 300],
        physical_width_mm: 25.4, physical_height_mm: 25.4,
        preview_width_px: 300, preview_height_px: 300,
        has_existing_cut: false, has_vector: false, has_raster: true, has_alpha: false,
        cut_contour_count: 0,
        pages: [{
            page_number: 1, width_mm: 25.4, height_mm: 25.4,
            has_existing_cut: false, has_vector: false, has_raster: true,
            has_alpha: false, cut_contour_count: 0,
        }],
        warnings: [], preview_url: '/source-preview',
    },
    previewBlob: new Blob(),
};
const detection: StickerSourceDetectionPayload = {
    manifest: {
        session_id: sessionId, stage: 'mask-review', original_name: 'sheet.pdf',
        source_kind: 'pdf', boundary_source: 'simple-bg', strategy_confidence: 0.98,
        needs_review: false, page_count: 1, source_page: 1, vector_geometry_ref: null,
        original_width_px: 300, original_height_px: 300,
        analysis_width_px: 300, analysis_height_px: 300,
        preview_width_px: 300, preview_height_px: 300, dpi: [300, 300],
        model: 'birefnet-lite', model_seconds: 0, postprocess_seconds: 0.1,
        mask_revision: 1,
        instances: Array.from({ length: 9 }, (_, index) => ({
            id: index + 1, x: index % 3 * 100, y: Math.floor(index / 3) * 100,
            width: 90, height: 90, area_px: 8100, confidence: 1, uncertain_ratio: 0,
        })),
        warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
    },
    previewBlob: new Blob(), labelsBlob: new Blob(), uncertaintyBlob: new Blob(),
};

async function mountSource(rotation = 0) {
    const pdf = await PDFDocument.create();
    pdf.addPage([72, 72]);
    const bytes = Uint8Array.from(await pdf.save());
    const file = new File([bytes], 'sheet.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
    const workspace = createWorkspaceStore();
    workspace.setState({
        file, viewerPageOrder: [1], viewerPageInstanceIds: ['page-1'], viewerPageRotations: [rotation],
    });
    const view = render(
        <WorkspaceContext.Provider value={workspace}>
            <StickerCutlineTool tabId="revision-test" pdfFile={file} onFileFixed={vi.fn()} />
        </WorkspaceContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tách nhiều tem' }));
    return { file, workspace, setActive: (isActive: boolean) => view.rerender(
        <WorkspaceContext.Provider value={workspace}>
            <StickerCutlineTool tabId="revision-test" pdfFile={file} isActive={isActive} onFileFixed={vi.fn()} />
        </WorkspaceContext.Provider>,
    ), showFile: (nextFile: File) => view.rerender(
        <WorkspaceContext.Provider value={workspace}>
            <StickerCutlineTool tabId="revision-test" pdfFile={nextFile} onFileFixed={vi.fn()} />
        </WorkspaceContext.Provider>,
    ) };
}

describe('StickerCutlineTool — revision thật, response nhận diện đến chậm', () => {
    it.each([false, true])('rời tab rồi trở lại không thay Working PDF còn hợp lệ, nhận diện xong=%s', async finished => {
        let finishDetection!: (result: StickerSourceDetectionPayload) => void;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
        const { file, setActive } = await mountSource(90);
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
        await waitFor(() => expect(detectStickerSource).toHaveBeenCalledOnce());
        const detectedSource = useStickerSheetStore.getState().getTab('revision-test').sourceFile;
        expect(detectedSource).not.toBe(file);
        if (finished) {
            await act(async () => { finishDetection(detection); });
            await waitFor(() => expect(useStickerSheetStore.getState().getTab('revision-test').status).toBe('mask-ready'));
        }
        act(() => setActive(false));
        act(() => setActive(true));
        expect(useStickerSheetStore.getState().getTab('revision-test').sourceFile).toBe(detectedSource);
        if (!finished) await act(async () => { finishDetection(detection); });
        await waitFor(() => expect(useStickerSheetStore.getState().getTab('revision-test').status).toBe('mask-ready'));
        expect(useStickerSheetStore.getState().getTab('revision-test').manifest?.instances).toHaveLength(9);
        expect(closeStickerSheetSession).not.toHaveBeenCalled();
        expect(inspectStickerSource).toHaveBeenCalledOnce();
    });

    it('đổi File thật sau nhận diện bỏ nguồn cũ và không tự nhận diện lại', async () => {
        vi.mocked(detectStickerSource).mockResolvedValue(detection);
        const { file, workspace, showFile } = await mountSource();
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
        await waitFor(() => expect(useStickerSheetStore.getState().getTab('revision-test').status).toBe('mask-ready'));
        const replacement = new File(['next PDF'], file.name, { type: 'application/pdf' });
        act(() => { workspace.getState().setFile(replacement); showFile(replacement); });
        await waitFor(() => expect(useStickerSheetStore.getState().getTab('revision-test').sourceFile).toBe(replacement));
        expect(useStickerSheetStore.getState().getTab('revision-test')).toMatchObject({
            sourceRevision: null, manifest: null, status: 'source-ready',
        });
        expect(detectStickerSource).toHaveBeenCalledOnce();
        expect(inspectStickerSource).toHaveBeenCalledOnce();
    });

    beforeEach(() => {
        window.localStorage.clear();
        useStickerSheetStore.setState({ tabs: {} });
        vi.clearAllMocks();
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:asset') });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection);
        vi.mocked(previewStickerCutline).mockResolvedValue({
            page_number: 1, mask_revision: 1, preview_width_px: 300, preview_height_px: 300,
            paths: [{ instance_id: 1, d: 'M 0 0 L 90 0 L 90 90 Z', segment_count: 3 }],
            fingerprint: 'd'.repeat(64), segment_count: 3,
        });
    });
    afterEach(() => {
        cleanup();
        useStickerSheetStore.getState().disposeTab('revision-test');
    });

    it.each([{ hidden: [] }, { hidden: [17] }])('giữ 9 tem khi metadata layer mặc định $hidden đến sau khi bắt đầu nhận diện', async ({ hidden }) => {
        let finishDetection!: (result: StickerSourceDetectionPayload) => void;
        vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
        const { workspace, file } = await mountSource();
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
        await waitFor(() => expect(detectStickerSource).toHaveBeenCalledOnce());
        const sourceRevision = useStickerSheetStore.getState().getTab('revision-test').sourceRevision;

        // REVISION (feedback 2026-09-07 §SHEET.SOURCE1): cùng hai action của upload
        // nền + /preflight/layers trong ImpositionTab; không có thao tác sửa PDF.
        act(() => {
            workspace.getState().setSelectionFileId('background-upload');
            workspace.getState().seedOcgLayerState([], hidden, [], file, 0, 'background-upload');
        });
        await act(async () => { finishDetection(detection); });

        await waitFor(() => expect(useStickerSheetStore.getState().getTab('revision-test').status).toBe('mask-ready'));
        const tab = useStickerSheetStore.getState().getTab('revision-test');
        expect(tab.error).toBe('');
        expect(tab.manifest?.instances).toHaveLength(9);
        expect(tab.sourceRevision).toBe(sourceRevision);
        expect(tab.cutlinePreview?.fingerprint).toBe('d'.repeat(64));
        expect(inspectStickerSource).toHaveBeenCalledOnce();
        expect(closeStickerSheetSession).not.toHaveBeenCalled();
        expect(screen.queryByText('Tài liệu đã thay đổi. Hãy nhận diện lại.')).toBeNull();
    });

    it.each(['file', 'order', 'rotation', 'instance', 'edit', 'layers'] as const)(
        'vẫn loại kết quả cũ khi người dùng thay đổi %s trong lúc nhận diện', async (change) => {
            let finishDetection!: (result: StickerSourceDetectionPayload) => void;
            vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
            const { workspace, file } = await mountSource();
            fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
            await waitFor(() => expect(detectStickerSource).toHaveBeenCalledOnce());
            act(() => {
                const state = workspace.getState();
                if (change === 'file') state.setFile(new File(['changed'], file.name, { type: file.type }));
                if (change === 'order') state.setViewerPageOrder([1, 1]);
                if (change === 'rotation') state.setViewerPageRotations([90]);
                if (change === 'instance') state.setViewerPageInstanceIds(['replacement-instance']);
                if (change === 'edit') state.advanceEditGeneration();
                if (change === 'layers') state.setHiddenOcgLayerIds([]);
            });
            await act(async () => { finishDetection(detection); });
            const tab = useStickerSheetStore.getState().getTab('revision-test');
            expect(tab.manifest).toBeNull();
            expect(tab.error).toBe('Tài liệu đã thay đổi. Hãy nhận diện lại.');
            expect(previewStickerCutline).not.toHaveBeenCalled();
        },
    );

});
