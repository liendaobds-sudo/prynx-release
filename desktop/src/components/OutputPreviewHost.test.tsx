// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createWorkspaceStore,
    useWorkspaceStore,
    WorkspaceContext,
    workspaceDocumentIdentity,
} from '../stores/useWorkspaceStore';
import OutputPreviewHost from './OutputPreviewHost';
import InkManagerTool from './preprocess-tools/InkManagerTool';

const uploadPDF = vi.fn();
const getWorkingFile = vi.fn();
const authenticatedFetch = vi.fn();

vi.mock('../lib/api', () => ({
    uploadPDF: (...args: unknown[]) => uploadPDF(...args),
    authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
    getApiUrl: () => 'http://localhost:8321/api',
}));

vi.mock('../hooks/useWorkingPdf', () => ({
    useWorkingPdf: () => getWorkingFile,
}));

vi.mock('./OutputPreviewTab', () => ({
    default: ({ fileId, totalPages, onClose }: {
        fileId: string;
        totalPages: number;
        onClose: () => void;
    }) => (
        <div data-testid="output-preview" data-file-id={fileId} data-total-pages={totalPages}>
            <button type="button" onClick={onClose}>Đóng</button>
        </div>
    ),
}));

describe('OutputPreviewHost', () => {
    beforeEach(() => {
        uploadPDF.mockReset();
        getWorkingFile.mockReset();
        authenticatedFetch.mockReset();
        getWorkingFile.mockImplementation((file: File) => Promise.resolve(file));
        authenticatedFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ inks: [] }),
        });
    });

    it('mở panel mà không render lại hoặc remount shell Viewer', () => {
        const store = createWorkspaceStore();
        store.setState({
            selectionFileId: 'file-123',
            viewerPageOrder: [1, 2, 3],
        });
        const shellCommitted = vi.fn();
        const viewerCommitted = vi.fn();
        const viewerMounted = vi.fn();

        function ViewerProbe() {
            useWorkspaceStore(state => state.separationPlates);
            useEffect(() => {
                viewerCommitted();
            });
            useEffect(() => {
                viewerMounted();
            }, []);
            return <div data-testid="viewer-probe" />;
        }

        function Shell() {
            useEffect(() => {
                shellCommitted();
            });
            return (
                <>
                    <ViewerProbe />
                    <OutputPreviewHost />
                </>
            );
        }

        render(
            <WorkspaceContext.Provider value={store}>
                <Shell />
            </WorkspaceContext.Provider>,
        );

        act(() => store.getState().setShowOutputPreview(true));

        expect(screen.getByTestId('output-preview').getAttribute('data-file-id')).toBe('file-123');
        expect(screen.getByTestId('output-preview').getAttribute('data-total-pages')).toBe('3');
        expect(shellCommitted).toHaveBeenCalledTimes(1);
        expect(viewerCommitted).toHaveBeenCalledTimes(1);
        expect(viewerMounted).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Đóng' }));
        expect(store.getState().showOutputPreview).toBe(false);
        expect(store.getState().separationPlates).toEqual([]);
        expect(shellCommitted).toHaveBeenCalledTimes(1);
        expect(viewerCommitted).toHaveBeenCalledTimes(1);
        expect(viewerMounted).toHaveBeenCalledTimes(1);
    });

    it('không phát update store khi cleanup lặp lại cùng trạng thái rỗng', () => {
        const store = createWorkspaceStore();
        let updates = 0;
        const unsubscribe = store.subscribe(() => {
            updates += 1;
        });

        store.getState().setShowOutputPreview(false);
        store.getState().setSeparationPlates([]);
        store.getState().setSoftProofImageUrl(null);
        store.getState().setGamutWarningUrl(null);
        store.getState().setSoftProofActive(false);
        store.getState().setTacHeatmapUrl(null);
        store.getState().setOverprintPreviewUrl(null);
        store.getState().closeOutputPreview();

        expect(updates).toBe(0);
        unsubscribe();
    });
    it('upload on-demand file native size=0 rồi mount Output Preview mà không cần reload', async () => {
        const store = createWorkspaceStore();
        const nativeFile = new File([], 'open-with.pdf', { type: 'application/pdf' });
        Object.defineProperty(nativeFile, 'path', { value: 'C:\\DuLieu\\open-with.pdf' });
        store.setState({
            file: nativeFile,
            showOutputPreview: true,
            selectionFileId: '',
            viewerPageOrder: [1, 2, 3, 4],
        });
        uploadPDF.mockResolvedValue({ id: 'native-file-123' });

        render(
            <WorkspaceContext.Provider value={store}>
                <OutputPreviewHost />
            </WorkspaceContext.Provider>,
        );

        expect(screen.queryByTestId('output-preview')).toBeNull();
        expect(document.querySelector('[data-output-preview-loading="true"]')).toBeTruthy();
        await waitFor(() => expect(uploadPDF).toHaveBeenCalledTimes(1));
        expect(uploadPDF.mock.calls[0][0]).toBe(nativeFile);
        expect(uploadPDF.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });
        await waitFor(() => expect(screen.getByTestId('output-preview').getAttribute('data-file-id')).toBe('native-file-123'));
        expect(screen.getByTestId('output-preview').getAttribute('data-total-pages')).toBe('4');
    });

    it('đóng panel trong lúc upload thì không nhận file_id muộn', async () => {
        const store = createWorkspaceStore();
        const nativeFile = new File([], 'open-with.pdf', { type: 'application/pdf' });
        Object.defineProperty(nativeFile, 'path', { value: 'C:\\DuLieu\\open-with.pdf' });
        let resolveUpload: ((value: { id: string }) => void) | undefined;
        uploadPDF.mockReturnValue(new Promise(resolve => { resolveUpload = resolve; }));
        store.setState({ file: nativeFile, showOutputPreview: true, selectionFileId: '' });

        render(
            <WorkspaceContext.Provider value={store}>
                <OutputPreviewHost />
            </WorkspaceContext.Provider>,
        );
        await waitFor(() => expect(uploadPDF).toHaveBeenCalledTimes(1));

        act(() => store.getState().closeOutputPreview());
        await act(async () => resolveUpload?.({ id: 'too-late' }));

        expect(store.getState().selectionFileId).toBe('');
        expect(screen.queryByTestId('output-preview')).toBeNull();
    });

    it('dùng lại file id cùng document identity, không đọc hay upload lại', () => {
        const store = createWorkspaceStore();
        const file = new File([new Uint8Array([1, 2, 3])], 'shared.pdf', {
            type: 'application/pdf',
            lastModified: 123,
        });
        store.getState().setFile(file);
        store.getState().setViewerPageOrder([1, 2]);
        store.getState().setViewerPageRotations([0, 0]);
        store.getState().setSelectionFileId('shared-file-id');
        store.getState().setShowOutputPreview(true);

        render(
            <WorkspaceContext.Provider value={store}>
                <OutputPreviewHost />
            </WorkspaceContext.Provider>,
        );

        expect(screen.getByTestId('output-preview').getAttribute('data-file-id'))
            .toBe('shared-file-id');
        expect(getWorkingFile).not.toHaveBeenCalled();
        expect(uploadPDF).not.toHaveBeenCalled();
    });

    it('identity đổi do xoay trang mới materialize rồi chia sẻ id mới', async () => {
        const store = createWorkspaceStore();
        const source = new File([new Uint8Array([1])], 'rotate.pdf', {
            type: 'application/pdf',
            lastModified: 456,
        });
        const materialized = new File([new Uint8Array([2])], 'rotate.pdf', {
            type: 'application/pdf',
            lastModified: 789,
        });
        store.getState().setFile(source);
        store.getState().setViewerPageOrder([1]);
        store.getState().setViewerPageRotations([0]);
        const oldIdentity = workspaceDocumentIdentity(source, [1], [0]);
        store.getState().setSelectionFileId('old-id', oldIdentity);
        store.getState().setViewerPageRotations([90]);
        store.getState().setShowOutputPreview(true);
        getWorkingFile.mockResolvedValue(materialized);
        uploadPDF.mockResolvedValue({ id: 'rotated-id' });

        render(
            <WorkspaceContext.Provider value={store}>
                <OutputPreviewHost />
            </WorkspaceContext.Provider>,
        );

        expect(document.querySelector('[data-output-preview-loading="true"]')).toBeTruthy();
        await waitFor(() => expect(getWorkingFile).toHaveBeenCalledWith(source));
        expect(uploadPDF).toHaveBeenCalledWith(
            materialized,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        await waitFor(() => expect(screen.getByTestId('output-preview').getAttribute('data-file-id'))
            .toBe('rotated-id'));
        expect(store.getState().selectionDocumentIdentity).toBe(
            workspaceDocumentIdentity(source, [1], [90]),
        );
    });

    it('Ink Manager dùng lại đúng id mà Output Preview/Viewer đã đăng ký', async () => {
        const store = createWorkspaceStore();
        const file = new File([new Uint8Array([1, 2])], 'inks.pdf', {
            type: 'application/pdf',
            lastModified: 222,
        });
        store.getState().setFile(file);
        store.getState().setViewerPageOrder([1]);
        store.getState().setViewerPageRotations([0]);
        store.getState().setSelectionFileId('shared-ink-id');

        render(
            <WorkspaceContext.Provider value={store}>
                <InkManagerTool pdfFile={file} />
            </WorkspaceContext.Provider>,
        );

        await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
            'http://localhost:8321/api/preflight/inks/shared-ink-id',
        ));
        expect(getWorkingFile).not.toHaveBeenCalled();
        expect(uploadPDF).not.toHaveBeenCalled();
    });
});
