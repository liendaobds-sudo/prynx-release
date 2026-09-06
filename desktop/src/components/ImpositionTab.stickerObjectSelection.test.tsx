// @vitest-environment jsdom

import { useContext, useMemo } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';

import {
    captureWorkspaceDocumentRevision,
    isWorkspaceDocumentRevisionCurrent,
    WorkspaceContext,
    type WorkspaceState,
} from '../stores/useWorkspaceStore';
import type { WorkingPdfResolver, WorkingPdfRevisionSnapshot } from '../hooks/useWorkingPdf';
import { resolveStickerObjectSelection, stickerObjectSourceIdentity } from '../lib/stickerObjectSelection';
import { globalPdfObjectCache } from '../stores/pdfObjectCache';
import type { PageOverlayRenderer } from './AcrobatViewer.helpers';
import type { StickerSheetWorkflowStatus } from './stickerSheetTabSelector';

interface ViewerProps {
    isActive?: boolean;
    pageOverlayRenderer?: PageOverlayRenderer;
    pageWorkflowStatuses?: Partial<Record<number, StickerSheetWorkflowStatus>>;
    fetchObjectsForPage?: (sourcePage: number) => Promise<void>;
    onEditCommit?: (url: string, name: string, fileId?: string) => Promise<void>;
}

const mocks = vi.hoisted(() => ({
    workspace: null as StoreApi<WorkspaceState> | null,
    viewerProps: {} as ViewerProps,
    closeSession: vi.fn(async () => undefined),
    uploadPDF: vi.fn<(file: File) => Promise<{ id: string }>>(),
    materialize: vi.fn<(snapshot: WorkingPdfRevisionSnapshot) => Promise<File>>(),
    authenticatedFetch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('./imposition-tools/ImposerDashboard', () => ({ default: () => null }));
vi.mock('./OutputPreviewHost', () => ({ default: () => null }));
vi.mock('../lib/api', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/api')>(),
    uploadPDF: mocks.uploadPDF,
    authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../lib/utils', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/utils')>(),
    detectColorSpace: vi.fn(async () => null),
}));
vi.mock('../hooks/useWorkingPdf', () => ({
    useWorkingPdf: function useWorkingPdfProbe(): WorkingPdfResolver {
        const store = useContext(WorkspaceContext)!;
        return useMemo(() => {
            const resolve = async (file?: File | null) => file ?? store.getState().file;
            return Object.assign(resolve, {
                prepare: async () => undefined,
                resolveUnprepared: resolve,
                capture: () => {
                    const state = store.getState();
                    return state.file ? captureWorkspaceDocumentRevision(state) as WorkingPdfRevisionSnapshot : null;
                },
                materialize: mocks.materialize,
                isCurrent: (snapshot: WorkingPdfRevisionSnapshot) => isWorkspaceDocumentRevisionCurrent(snapshot, store.getState()),
            });
        }, [store]);
    },
}));
vi.mock('../lib/viewerFirstFrame', () => ({
    primeViewerFirstFrame: vi.fn(async () => null),
    waitForViewerFirstFrameGrace: vi.fn(async () => null),
}));
vi.mock('../lib/stickerSheetApi', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/stickerSheetApi')>(),
    closeStickerSheetSession: mocks.closeSession,
}));
vi.mock('./AcrobatViewer', () => ({
    default: function ViewerProbe(props: ViewerProps) {
        mocks.workspace = useContext(WorkspaceContext);
        mocks.viewerProps = props;
        return <div data-testid="viewer-source">
            {props.pageOverlayRenderer?.({
                originalPageNum: 1,
                viewerPagePosition: 1,
                pageInstanceId: 'page-1',
                isActivePage: true,
            })}
        </div>;
    },
}));

import ImpositionTab from './ImpositionTab';
import { useStickerSheetStore, type StickerSheetPageState } from './preprocess-tools/stickerSheetStore';

const TAB_ID = 'sticker-custom-overlay';

function deferred<T>() {
    let resolve!: (result: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

async function mountSource(file: File) {
    render(<ImpositionTab tabId={TAB_ID} isActive initialFeature="sticker" initialFile={file} />);
    await waitFor(() => expect(mocks.workspace?.getState().file).toBe(file));
    return mocks.workspace!;
}

function prepareSheet(file: File): StickerSheetPageState {
    const base = useStickerSheetStore.getState().getTab(TAB_ID);
    const page: StickerSheetPageState = {
        status: 'mask-ready',
        isRefining: false,
        isCutlinePreviewing: false,
        selectedInstanceId: 1,
        edits: [],
        redoEdits: [],
        alphaThreshold: base.alphaThreshold,
        shadowCleanup: base.shadowCleanup,
        cutlinePreview: {
            page_number: 1, mask_revision: 1, preview_width_px: 100, preview_height_px: 80,
            paths: [], fingerprint: 'preview-current', segment_count: 0,
        },
        cutlineSmoothness: base.cutlineSmoothness,
        cutlineFidelity: base.cutlineFidelity,
        curveTension: base.curveTension,
        minDetailAreaMm2: base.minDetailAreaMm2,
        cutlineDenoise: base.cutlineDenoise,
        outputDpi: base.outputDpi,
        outputDpiY: base.outputDpiY,
        preserveExistingCut: false,
        error: '',
        previewUrl: 'blob:recognized-stickers',
        labelsUrl: '',
        uncertaintyUrl: '',
        manifest: {
            session_id: 'a'.repeat(32), original_name: file.name,
            stage: 'mask-review', source_kind: 'raster', boundary_source: 'alpha',
            strategy_confidence: 0.98, needs_review: false, page_count: 1, source_page: 1,
            vector_geometry_ref: null,
            original_width_px: 100, original_height_px: 80,
            analysis_width_px: 100, analysis_height_px: 80,
            preview_width_px: 100, preview_height_px: 80,
            dpi: null, model: 'birefnet-lite', model_seconds: 1, postprocess_seconds: 0.1,
            instances: [{ id: 1, x: 5, y: 5, width: 80, height: 60, area_px: 4000, confidence: 0.9, uncertain_ratio: 0.1 }],
            warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
        },
    };
    useStickerSheetStore.setState({ tabs: {
        [TAB_ID]: {
            ...base, ...page, mode: 'ai-sheet', unifiedInitialized: true,
            sourceFile: file, sourceOrigin: 'workspace', maskEditingEnabled: false,
            pages: { 1: page },
        },
    } });
    return page;
}

describe('ImpositionTab — chọn đối tượng PDF trong workspace tem chung', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workspace = null;
        mocks.viewerProps = {};
        mocks.uploadPDF.mockReset().mockResolvedValue({ id: 'raw-source' });
        mocks.materialize.mockReset().mockImplementation(async snapshot => (
            new File(['%PDF materialized'], snapshot.file.name, { type: 'application/pdf' })
        ));
        mocks.authenticatedFetch.mockReset().mockResolvedValue({
            ok: true,
            json: async () => ({ layers: [], objects: [{ id: 'path-8', type: 'path', bbox: [0, 0, 10, 10] }] }),
            blob: async () => new Blob(['%PDF edited'], { type: 'application/pdf' }),
        });
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    afterEach(() => {
        cleanup();
        useStickerSheetStore.setState({ tabs: {} });
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('hiện PDF gốc khi chọn custom, rồi trả preview và giữ nguyên phiên nhận diện', async () => {
        const file = new File(['%PDF-1.7'], 'tem.pdf', { type: 'application/pdf' });
        const page = prepareSheet(file);
        render(<ImpositionTab tabId={TAB_ID} isActive initialFeature="sticker" initialFile={file} />);
        await waitFor(() => expect(mocks.workspace?.getState().file).toBe(file));
        expect(useStickerSheetStore.getState().getTab(TAB_ID).sourceFile).toBe(file);
        expect(mocks.viewerProps.pageWorkflowStatuses?.[1]).toBe('ready');
        await waitFor(() => expect(screen.queryByTestId('sticker-sheet-page-overlay')).not.toBeNull());
        expect(mocks.viewerProps.isActive).toBe(true);
        expect(mocks.viewerProps.pageWorkflowStatuses?.[1]).toBe('ready');

        act(() => {
            mocks.workspace!.getState().setSelectionFileId('edit-source', stickerObjectSourceIdentity(file));
            mocks.workspace!.getState().setIsObjectEditMode(true);
        });
        expect(screen.queryByTestId('sticker-sheet-page-overlay')).toBeNull();
        expect(mocks.viewerProps.pageOverlayRenderer).toBeUndefined();
        expect(mocks.viewerProps.pageWorkflowStatuses?.[1]).toBe('ready');
        expect(useStickerSheetStore.getState().getTab(TAB_ID).pages[1]).toBe(page);
        expect(mocks.closeSession).not.toHaveBeenCalled();

        act(() => mocks.workspace!.getState().setIsObjectEditMode(false));
        expect(screen.queryByTestId('sticker-sheet-page-overlay')).not.toBeNull();
        expect(useStickerSheetStore.getState().getTab(TAB_ID).pages[1]).toBe(page);
        expect(mocks.closeSession).not.toHaveBeenCalled();
    });

    it('dùng trang nguồn sau reorder/duplicate và không upload vòng lặp khi edit commit', async () => {
        const file = new File(['%PDF source'], 'tem.pdf', { type: 'application/pdf' });
        const workspace = await mountSource(file);
        act(() => {
            workspace.getState().setViewerPageOrder([2, 1, 1]);
            workspace.getState().setViewerPageInstanceIds(['source-2', 'source-1-a', 'source-1-b']);
            workspace.getState().setViewerPageRotations([90, 0, 270]);
            workspace.getState().setSelectionFileId('working-owner');
            workspace.getState().setShowOutputPreview(true);
            workspace.getState().setIsObjectEditMode(true);
        });
        await waitFor(() => expect(workspace.getState().selectionFileId).toBe('raw-source'));
        expect(mocks.uploadPDF).toHaveBeenCalledTimes(1);
        expect(mocks.uploadPDF).toHaveBeenCalledWith(file);
        expect(mocks.materialize).not.toHaveBeenCalled();
        expect(workspace.getState().selectionDocumentIdentity).toBe(stickerObjectSourceIdentity(file));
        expect(workspace.getState().showOutputPreview).toBe(false);

        await act(async () => mocks.viewerProps.fetchObjectsForPage?.(2));
        expect(mocks.authenticatedFetch).toHaveBeenCalledWith(expect.stringMatching(/\/edit\/objects\/raw-source\/1$/));
        act(() => workspace.getState().setObjectSelectionContext({
            fileId: 'raw-source', pageIndex: 1, objectIds: ['path-8'],
            revision: captureWorkspaceDocumentRevision(workspace.getState()),
            viewerPage: 1, pageInstanceId: 'source-2',
        }));
        expect(resolveStickerObjectSelection(workspace.getState(), 1)).toEqual(['path-8']);
        act(() => workspace.getState().setObjectSelectionContext({
            fileId: 'raw-source', pageIndex: 0, objectIds: ['path-9'],
            revision: captureWorkspaceDocumentRevision(workspace.getState()),
            viewerPage: 3, pageInstanceId: 'source-1-b',
        }));
        expect(resolveStickerObjectSelection(workspace.getState(), 3)).toEqual(['path-9']);
        expect(resolveStickerObjectSelection(workspace.getState(), 2)).toBeNull();

        await act(async () => mocks.viewerProps.onEditCommit?.('/edited.pdf', 'Edited_tem.pdf', 'committed-source'));
        expect(workspace.getState().file).not.toBe(file);
        expect(workspace.getState().selectionFileId).toBe('committed-source');
        expect(workspace.getState().selectionDocumentIdentity).toBe(stickerObjectSourceIdentity(workspace.getState().file));
        expect(resolveStickerObjectSelection(workspace.getState(), 3)).toBeNull();
        expect(mocks.uploadPDF).toHaveBeenCalledTimes(1);
    });

    it('working upload về muộn không chiếm owner sau khi đã vào và rời chọn custom', async () => {
        vi.useFakeTimers();
        const file = new File(['%PDF source'], 'tem.pdf', { type: 'application/pdf' });
        const delayedWorking = deferred<{ id: string }>();
        mocks.uploadPDF.mockImplementation(input => input === file
            ? Promise.resolve({ id: 'raw-source' }) : delayedWorking.promise);
        render(<ImpositionTab tabId={TAB_ID} isActive initialFeature="sticker" initialFile={file} />);
        await act(async () => vi.advanceTimersByTimeAsync(0));
        const workspace = mocks.workspace!;
        expect(workspace.getState().file).toBe(file);
        act(() => {
            workspace.getState().setViewerPageOrder([2, 1, 1]);
            workspace.getState().setViewerPageInstanceIds(['source-2', 'source-1-a', 'source-1-b']);
            workspace.getState().setViewerPageRotations([90, 0, 270]);
        });
        await act(async () => vi.advanceTimersByTimeAsync(2500));
        expect(mocks.materialize).toHaveBeenCalledTimes(1);
        expect(mocks.uploadPDF).toHaveBeenCalledTimes(1);
        expect(mocks.uploadPDF.mock.calls[0][0]).not.toBe(file);

        await act(async () => {
            workspace.getState().setIsObjectEditMode(true);
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(workspace.getState().selectionFileId).toBe('raw-source');
        expect(mocks.uploadPDF).toHaveBeenCalledTimes(2);
        act(() => workspace.getState().setIsObjectEditMode(false));
        await act(async () => delayedWorking.resolve({ id: 'late-working' }));
        expect(workspace.getState().selectionFileId).toBe('raw-source');
        expect(workspace.getState().selectionDocumentIdentity).toBe(stickerObjectSourceIdentity(file));
    });

    it('không dùng promise source cũ khi file bị thay trong lúc đang upload', async () => {
        const first = new File(['%PDF first'], 'tem.pdf', { type: 'application/pdf' });
        const second = new File(['%PDF second'], 'tem.pdf', { type: 'application/pdf' });
        const oldUpload = deferred<{ id: string }>();
        mocks.uploadPDF.mockImplementation(input => input === first
            ? oldUpload.promise : Promise.resolve({ id: 'second-source' }));
        const workspace = await mountSource(first);
        act(() => workspace.getState().setIsObjectEditMode(true));
        await waitFor(() => expect(mocks.uploadPDF).toHaveBeenCalledWith(first));
        act(() => workspace.getState().setFile(second));
        await waitFor(() => expect(workspace.getState().selectionFileId).toBe('second-source'));
        expect(mocks.uploadPDF).toHaveBeenCalledWith(second);
        await act(async () => oldUpload.resolve({ id: 'old-source' }));
        expect(workspace.getState().selectionFileId).toBe('second-source');
        expect(workspace.getState().selectionDocumentIdentity).toBe(stickerObjectSourceIdentity(second));
    });

    it.each(['file', 'generation', 'order', 'rotation', 'owner'] as const)(
        'không cache response object muộn sau khi %s thay đổi', async changed => {
            const file = new File(['%PDF source'], 'tem.pdf', { type: 'application/pdf' });
            const workspace = await mountSource(file);
            act(() => workspace.getState().setIsObjectEditMode(true));
            await waitFor(() => expect(workspace.getState().selectionFileId).toBe('raw-source'));
            const objectsJson = deferred<{ objects: Array<{ id: string; type: string; bbox: number[] }> }>();
            mocks.authenticatedFetch.mockImplementation(async (url: string) => ({
                ok: true,
                json: () => /\/edit\/objects\//.test(url)
                    ? objectsJson.promise : Promise.resolve({ layers: [] }),
            }));
            const publishObjects = vi.spyOn(globalPdfObjectCache, 'setPageObjects');
            let request: Promise<void> | undefined;
            await act(async () => {
                request = mocks.viewerProps.fetchObjectsForPage?.(1);
                await Promise.resolve();
            });
            expect(mocks.authenticatedFetch).toHaveBeenCalledWith(expect.stringMatching(/\/edit\/objects\/raw-source\/0$/));
            act(() => {
                if (changed === 'file') {
                    const replacement = new File(['%PDF next'], 'tem.pdf', { type: 'application/pdf' });
                    workspace.getState().setFile(replacement);
                    workspace.getState().setPdfUrl('blob:replacement');
                    workspace.getState().setSelectionFileId('next-source', stickerObjectSourceIdentity(replacement));
                } else if (changed === 'generation') workspace.getState().advanceEditGeneration();
                else if (changed === 'order') workspace.getState().setViewerPageOrder([2, 1]);
                else if (changed === 'rotation') workspace.getState().setViewerPageRotations([90]);
                else workspace.getState().setSelectionFileId('next-source', stickerObjectSourceIdentity(file));
            });
            await act(async () => {
                objectsJson.resolve({ objects: [{ id: 'stale-path', type: 'path', bbox: [0, 0, 5, 5] }] });
                await request;
            });
            expect(publishObjects).not.toHaveBeenCalled();
        },
    );
});
