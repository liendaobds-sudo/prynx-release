// @vitest-environment jsdom

import { useContext } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import {
    captureWorkspaceDocumentRevision, isWorkspaceDocumentRevisionCurrent,
    WorkspaceContext, type WorkspaceState,
} from '../stores/useWorkspaceStore';
import { materializeWorkingPdfRevision, type WorkingPdfRevisionSnapshot } from '../hooks/useWorkingPdf';
import type { PageOverlayRenderer } from './AcrobatViewer.helpers';
import type { StickerSheetWorkflowStatus } from './stickerSheetTabSelector';
import { useStickerSheetStore } from './preprocess-tools/stickerSheetStore';
import {
    detectStickerSource, inspectStickerSource, loadStickerSourcePreview, previewStickerCutline,
    type StickerSourceDetectionPayload, type StickerSourceInspectPayload,
} from '../lib/stickerSheetApi';

interface ViewerProps {
    pageOverlayRenderer?: PageOverlayRenderer;
    pageWorkflowStatuses?: Partial<Record<number, StickerSheetWorkflowStatus>>;
}
const mocks = vi.hoisted(() => ({
    workspace: null as StoreApi<WorkspaceState> | null,
    viewer: {} as ViewerProps,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('./imposition-tools/ImposerDashboard', () => ({ default: () => null }));
vi.mock('./OutputPreviewHost', () => ({ default: () => null }));
vi.mock('../lib/api', async original => ({
    ...await original<typeof import('../lib/api')>(),
    uploadPDF: vi.fn(async () => ({ id: 'background-upload' })),
    authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ layers: [] }) })),
}));
vi.mock('../lib/utils', async original => ({
    ...await original<typeof import('../lib/utils')>(), detectColorSpace: vi.fn(async () => null),
}));
vi.mock('../lib/viewerFirstFrame', () => ({
    primeViewerFirstFrame: vi.fn(async () => null), waitForViewerFirstFrameGrace: vi.fn(async () => null),
}));
vi.mock('../lib/stickerSheetApi', () => ({
    closeStickerSheetSession: vi.fn(async () => undefined), confirmStickerSource: vi.fn(async () => true),
    inspectStickerSource: vi.fn(), detectStickerSource: vi.fn(), loadStickerSourcePreview: vi.fn(),
    previewStickerCutline: vi.fn(),
}));
vi.mock('./preprocess-tools/StickerSheetWorkspace', () => ({
    default: () => <div data-testid="source-revision-overlay" />, StickerCutlineOverlay: () => null,
}));
vi.mock('./AcrobatViewer', () => ({
    default: function ViewerProbe(props: ViewerProps) {
        mocks.workspace = useContext(WorkspaceContext);
        mocks.viewer = props;
        return <div>{props.pageOverlayRenderer?.({
            originalPageNum: 2, viewerPagePosition: 1, pageInstanceId: 'page-2', isActivePage: true,
        })}</div>;
    },
}));
import ImpositionTab from './ImpositionTab';

const tabId = 'sticker-source-revision';
const sessionId = 'b'.repeat(32);
const detection: StickerSourceDetectionPayload = {
    manifest: {
        session_id: sessionId, stage: 'mask-review', original_name: 'sheet.pdf', source_kind: 'pdf',
        boundary_source: 'simple-bg', strategy_confidence: 0.98, needs_review: false, page_count: 3,
        source_page: 1, vector_geometry_ref: null, original_width_px: 300, original_height_px: 300,
        analysis_width_px: 300, analysis_height_px: 300, preview_width_px: 300, preview_height_px: 300,
        dpi: [300, 300], model: 'birefnet-lite', model_seconds: 0, postprocess_seconds: 0.1,
        mask_revision: 1, warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
        instances: Array.from({ length: 9 }, (_, index) => ({
            id: index + 1, x: index % 3 * 100, y: Math.floor(index / 3) * 100,
            width: 90, height: 90, area_px: 8100, confidence: 1, uncertain_ratio: 0,
        })),
    },
    previewBlob: new Blob(), labelsBlob: new Blob(), uncertaintyBlob: new Blob(),
};
const inspection: StickerSourceInspectPayload = {
    inspection: {
        session_id: sessionId, stage: 'inspected', original_name: 'sheet.pdf', source_kind: 'pdf',
        mime_type: 'application/pdf', boundary_source: 'simple-bg', strategy_confidence: 0.98,
        needs_review: false, page_count: 3, source_width_px: 300, source_height_px: 300,
        dpi: [300, 300], physical_width_mm: 25.4, physical_height_mm: 25.4,
        preview_width_px: 300, preview_height_px: 300, has_existing_cut: false, has_vector: false,
        has_raster: true, has_alpha: false, cut_contour_count: 0, warnings: [], preview_url: '/source-preview',
        pages: [1, 2, 3].map(page_number => ({ page_number, width_mm: 25.4, height_mm: 25.4,
            has_existing_cut: false, has_vector: false, has_raster: true, has_alpha: false, cut_contour_count: 0 })),
    },
    previewBlob: new Blob(),
};
async function mountSource(isActive = true) {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 3; index++) pdf.addPage([72 + index * 10, 72]);
    const bytes = Uint8Array.from(await pdf.save());
    const file = new File([bytes], 'sheet.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
    render(<ImpositionTab tabId={tabId} isActive={isActive} initialFeature="sticker" initialFile={file} />);
    await waitFor(() => expect(mocks.workspace?.getState().file).toBe(file));
    const workspace = mocks.workspace!;
    act(() => {
        workspace.getState().setViewerPageOrder([2, 1, 1]);
        workspace.getState().setViewerPageInstanceIds(['page-2', 'page-1-a', 'page-1-b']);
        workspace.getState().setViewerPageRotations([90, 0, 270]);
        const actions = useStickerSheetStore.getState();
        actions.initTab(tabId);
        actions.setMode(tabId, 'ai-sheet');
        actions.selectSource(tabId, file, 'workspace');
    });
    return { file, workspace };
}
async function startDetection(workspace: StoreApi<WorkspaceState>, materialize = true) {
    const revision = captureWorkspaceDocumentRevision(workspace.getState()) as WorkingPdfRevisionSnapshot;
    const file = materialize ? await materializeWorkingPdfRevision(revision) : revision.file;
    let complete: ((payload: StickerSourceDetectionPayload) => void) | undefined;
    vi.mocked(detectStickerSource).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    let pending!: Promise<void>;
    await act(async () => {
        pending = useStickerSheetStore.getState().detectStickers(tabId, 'auto', 1, async () => ({
            file, revision, isCurrent: () => isWorkspaceDocumentRevisionCurrent(revision, workspace.getState()),
        }));
    });
    if (!materialize) await waitFor(() => expect(detectStickerSource).toHaveBeenCalled());
    return { file, revision, finish: async () => { await act(async () => { complete?.(detection); await pending; }); } };
}

describe('Tách nhiều tem — source xử lý không thay File Viewer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(detectStickerSource).mockReset();
        mocks.workspace = null;
        mocks.viewer = {};
        useStickerSheetStore.setState({ tabs: {} });
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:sticker-asset') });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection);
        vi.mocked(loadStickerSourcePreview).mockResolvedValue(new Blob());
        vi.mocked(previewStickerCutline).mockResolvedValue({
            page_number: 1, mask_revision: 1, preview_width_px: 300, preview_height_px: 300,
            paths: [], fingerprint: 'c'.repeat(64), segment_count: 0,
        });
    });
    afterEach(() => { cleanup(); useStickerSheetStore.setState({ tabs: {} }); vi.unstubAllGlobals(); });

    it('giữ raw File trong khi chờ nhận diện trên PDF đã bake reorder/duplicate/rotation', async () => {
        const { file, workspace } = await mountSource();
        const job = await startDetection(workspace);
        try {
            expect(job.file).not.toBe(file);
            expect(workspace.getState().file).toBe(file);
            expect(isWorkspaceDocumentRevisionCurrent(job.revision, workspace.getState())).toBe(true);
        } finally { await job.finish(); }
        await waitFor(() => expect(useStickerSheetStore.getState().getTab(tabId).manifest?.instances).toHaveLength(9));
        expect(workspace.getState().viewerPageOrder).toEqual([2, 1, 1]);
        expect(useStickerSheetStore.getState().getTab(tabId).error).toBe('');
        expect(screen.queryByTestId('source-revision-overlay')).not.toBeNull();
        expect(mocks.viewer.pageWorkflowStatuses?.[1]).toBe('review');
    });

    it.each([[], [17]].map(hidden => ({ hidden })))(
        'metadata layer mặc định $hidden tải nền không làm mất kết quả đang nhận diện', async ({ hidden }) => {
            const { file, workspace } = await mountSource();
            const job = await startDetection(workspace);
            await act(async () => {
                workspace.getState().setSelectionFileId('metadata-owner');
                workspace.getState().seedOcgLayerState([], hidden, [], file, workspace.getState().editGeneration, 'metadata-owner');
            });
            await job.finish();
            await waitFor(() => expect(useStickerSheetStore.getState().getTab(tabId).manifest?.instances).toHaveLength(9));
            expect(isWorkspaceDocumentRevisionCurrent(job.revision, workspace.getState())).toBe(true);
            expect(workspace.getState().file).toBe(file);
            expect(useStickerSheetStore.getState().getTab(tabId).error).toBe('');
            expect(screen.queryByTestId('source-revision-overlay')).not.toBeNull();
        },
    );

    it.each(['edit', 'rotation', 'order', 'instance', 'file', 'layer'])(
        'không hiện overlay/badge revision cũ sau thay đổi %s thật', async (change) => {
            const { file, workspace } = await mountSource();
            const job = await startDetection(workspace, false);
            await job.finish();
            expect(mocks.viewer.pageOverlayRenderer).toBeDefined();
            act(() => {
                if (change === 'edit') workspace.getState().advanceEditGeneration();
                if (change === 'rotation') workspace.getState().setViewerPageRotations([0, 0, 270]);
                if (change === 'order') workspace.getState().setViewerPageOrder([1, 2, 1]);
                if (change === 'instance') workspace.getState().setViewerPageInstanceIds(['replaced', 'page-1-a', 'page-1-b']);
                if (change === 'file') workspace.getState().setFile(new File(['changed'], file.name));
                if (change === 'layer') workspace.getState().setHiddenOcgLayerIds([]);
            });
            expect(mocks.viewer.pageOverlayRenderer).toBeUndefined();
            expect(mocks.viewer.pageWorkflowStatuses).toBeUndefined();
            expect(screen.queryByTestId('source-revision-overlay')).toBeNull();
        },
    );

    it('nguồn explicit vẫn vào Viewer, tab nền không tự mở file đó', async () => {
        const { file, workspace } = await mountSource(false);
        const selected = new File(['selected PDF'], 'selected.pdf', { type: 'application/pdf' });
        await act(async () => useStickerSheetStore.getState().selectSource(tabId, selected, 'explicit'));
        expect(workspace.getState().file).toBe(file);
        cleanup();
        useStickerSheetStore.setState({ tabs: {} });
        const active = await mountSource();
        await act(async () => useStickerSheetStore.getState().selectSource(tabId, selected, 'explicit'));
        await waitFor(() => expect(active.workspace.getState().file).toBe(selected));
    });
});
