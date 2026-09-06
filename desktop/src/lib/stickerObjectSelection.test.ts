import { describe, expect, it } from 'vitest';

import {
    captureWorkspaceDocumentRevision,
    createWorkspaceStore,
    workspaceDocumentIdentity,
    type EditObjectSelectionContext,
    type WorkspaceState,
} from '../stores/useWorkspaceStore';
import { resolveStickerObjectSelection, stickerObjectSourceIdentity } from './stickerObjectSelection';

function selectedWorkspace(
    contextOverrides: Partial<EditObjectSelectionContext> = {},
    stateOverrides: Partial<WorkspaceState> = {},
) {
    const store = createWorkspaceStore();
    store.getState().setFile(new File(['pdf'], 'tem.pdf', { type: 'application/pdf', lastModified: 100 }));
    store.getState().setViewerPageOrder([2, 1]);
    store.getState().setViewerPageInstanceIds(['page-b', 'page-a']);
    store.getState().setViewerPageRotations([0, 90]);
    store.setState(stateOverrides);
    store.getState().setSelectionFileId('edit-current', stickerObjectSourceIdentity(store.getState().file));
    store.getState().setObjectSelectionContext({
        fileId: 'edit-current',
        pageIndex: 1,
        objectIds: ['image-3', 'path-8'],
        revision: captureWorkspaceDocumentRevision(store.getState()),
        viewerPage: 1,
        pageInstanceId: 'page-b',
        ...contextOverrides,
    });
    return store;
}

describe('resolveStickerObjectSelection', () => {
    it('dùng đúng trang nguồn sau reorder và trả bản sao ID', () => {
        const store = selectedWorkspace();
        const ids = resolveStickerObjectSelection(store.getState(), 1);
        expect(ids).toEqual(['image-3', 'path-8']);
        expect(ids).not.toBe(store.getState().objectSelectionContext?.objectIds);
        ids?.push('path-99');
        expect(store.getState().objectSelectionContext?.objectIds).toEqual(['image-3', 'path-8']);
    });

    it('không nhận snapshot legacy thiếu revision hoặc định danh trang xem', () => {
        for (const overrides of [{ revision: undefined }, { viewerPage: undefined }, { pageInstanceId: undefined }]) {
            expect(resolveStickerObjectSelection(selectedWorkspace(overrides).getState(), 1)).toBeNull();
        }
    });

    it('không suy danh tính file từ tên, kích thước hoặc ngày sửa giống nhau', () => {
        const state = selectedWorkspace().getState();
        const replacement = new File(['pdf'], 'tem.pdf', { type: 'application/pdf', lastModified: 100 });
        expect(resolveStickerObjectSelection({ ...state, file: replacement }, 1)).toBeNull();
        expect(resolveStickerObjectSelection({ ...state, file: null }, 1)).toBeNull();
    });

    it('từ chối backend file ID hoặc binding tài liệu đã thay đổi', () => {
        const state = selectedWorkspace().getState();
        expect(resolveStickerObjectSelection({ ...state, selectionFileId: 'edit-other' }, 1)).toBeNull();
        expect(resolveStickerObjectSelection({ ...state, selectionFileId: '' }, 1)).toBeNull();
        expect(resolveStickerObjectSelection({ ...state, selectionDocumentIdentity: 'stale' }, 1)).toBeNull();
    });

    it('từ chối generation mới kể cả object ID vẫn cùng tên', () => {
        const state = selectedWorkspace().getState();
        expect(resolveStickerObjectSelection({ ...state, editGeneration: state.editGeneration + 1 }, 1)).toBeNull();
    });

    it('không nhận ID từ working PDF đã materialize dù snapshot và số trang khớp', () => {
        const state = selectedWorkspace().getState();
        expect(resolveStickerObjectSelection({
            ...state,
            selectionDocumentIdentity: workspaceDocumentIdentity(
                state.file, state.viewerPageOrder, state.viewerPageRotations,
            ),
        }, 1)).toBeNull();
    });

    it('từ chối reorder, rotation hoặc instance đã đổi sau khi chọn', () => {
        const state = selectedWorkspace().getState();
        expect(resolveStickerObjectSelection({ ...state, viewerPageOrder: [1, 2] }, 1)).toBeNull();
        expect(resolveStickerObjectSelection({ ...state, viewerPageRotations: [90, 90] }, 1)).toBeNull();
        expect(resolveStickerObjectSelection({ ...state, viewerPageInstanceIds: ['page-c', 'page-a'] }, 1)).toBeNull();
    });

    it('chỉ dùng lựa chọn cho đúng vị trí đang xử lý và đúng trang nguồn', () => {
        const state = selectedWorkspace().getState();
        for (const page of [0, -1, 1.5, Number.NaN, 2, 3]) {
            expect(resolveStickerObjectSelection(state, page)).toBeNull();
        }
        expect(resolveStickerObjectSelection(selectedWorkspace({ pageIndex: 0 }).getState(), 1)).toBeNull();
        expect(resolveStickerObjectSelection(selectedWorkspace({ objectIds: [] }).getState(), 1)).toBeNull();
    });

    it('không áp lựa chọn cho bản nhân đôi khác của cùng trang nguồn', () => {
        const store = selectedWorkspace({ pageIndex: 0 }, { viewerPageOrder: [1, 1] });
        expect(resolveStickerObjectSelection(store.getState(), 1)).toEqual(['image-3', 'path-8']);
        expect(resolveStickerObjectSelection(store.getState(), 2)).toBeNull();
        store.setState({
            objectSelectionContext: { ...store.getState().objectSelectionContext!, pageInstanceId: 'page-a' },
        });
        expect(resolveStickerObjectSelection(store.getState(), 1)).toBeNull();
    });

    it('từ chối trang nhân đôi chưa có instance nhưng hỗ trợ tài liệu nguồn đơn giản', () => {
        const unique = selectedWorkspace({ pageIndex: 0, pageInstanceId: null }, {
            viewerPageOrder: undefined,
            viewerPageInstanceIds: undefined,
            viewerPageRotations: undefined,
        });
        expect(resolveStickerObjectSelection(unique.getState(), 1)).toEqual(['image-3', 'path-8']);
        const duplicated = selectedWorkspace({ pageIndex: 0, pageInstanceId: null }, {
            viewerPageOrder: [1, 1],
            viewerPageInstanceIds: undefined,
        });
        expect(resolveStickerObjectSelection(duplicated.getState(), 1)).toBeNull();
    });

    it('không đọc snapshot nếu lựa chọn lớp đã thay đổi', () => {
        const state = selectedWorkspace().getState();
        expect(resolveStickerObjectSelection({ ...state, hiddenOcgLayerIds: [7] }, 1)).toBeNull();
    });

    it('store không đổi backend owner cho snapshot có fence', () => {
        const store = selectedWorkspace();
        store.getState().setSelectionFileId('edit-next');
        expect(store.getState().objectSelectionContext).toBeNull();
    });

    it('store từ chối request cũ và giữ metadata mới dù ID không đổi', () => {
        const store = selectedWorkspace();
        const old = store.getState().objectSelectionContext!;
        store.getState().advanceEditGeneration();
        store.getState().setObjectSelectionContext(null);
        store.getState().setObjectSelectionContext(old);
        expect(store.getState().objectSelectionContext).toBeNull();
        const current = { ...old, revision: captureWorkspaceDocumentRevision(store.getState()) };
        store.getState().setObjectSelectionContext(current);
        store.getState().setObjectSelectionContext({ ...current, pageInstanceId: 'other-page' });
        expect(store.getState().objectSelectionContext?.pageInstanceId).toBe('other-page');
        expect(resolveStickerObjectSelection(store.getState(), 1)).toBeNull();
    });
});
