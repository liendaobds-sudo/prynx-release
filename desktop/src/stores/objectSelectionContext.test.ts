import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './useWorkspaceStore';

describe('workspace edit object selection context', () => {
    it('keeps the selection snapshot while Edit PDF closes', () => {
        const store = createWorkspaceStore();
        store.getState().setSelectionFileId('edit-v1');
        store.getState().setSelectedObjectIds(['vector-2', 'vector-4']);
        store.getState().setObjectSelectionContext({
            fileId: 'edit-v1',
            pageIndex: 0,
            objectIds: ['vector-2', 'vector-4'],
        });

        store.getState().setIsObjectEditMode(false);
        store.getState().setSelectedObjectIds([]);

        expect(store.getState().objectSelectionContext).toEqual({
            fileId: 'edit-v1',
            pageIndex: 0,
            objectIds: ['vector-2', 'vector-4'],
        });
    });

    it('moves the snapshot to the committed edit file revision', () => {
        const store = createWorkspaceStore();
        store.getState().setSelectionFileId('edit-v1');
        store.getState().setObjectSelectionContext({
            fileId: 'edit-v1',
            pageIndex: 2,
            objectIds: ['image-7'],
        });

        store.getState().setSelectionFileId('edit-v2');

        expect(store.getState().objectSelectionContext).toEqual({
            fileId: 'edit-v2',
            pageIndex: 2,
            objectIds: ['image-7'],
        });
        expect(store.getState().selectedObjectIds).toEqual([]);
    });

    it('clears a stale snapshot when the working PDF is replaced', () => {
        const store = createWorkspaceStore();
        store.getState().setSelectionFileId('edit-v1');
        store.getState().setObjectSelectionContext({
            fileId: 'edit-v1',
            pageIndex: 0,
            objectIds: ['vector-3'],
        });

        store.getState().setSelectionFileId('');

        expect(store.getState().objectSelectionContext).toBeNull();
    });
});
