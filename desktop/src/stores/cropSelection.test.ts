import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './useWorkspaceStore';

describe('workspace crop selection', () => {
    it('stores one normalized owner and clears it when crop mode exits', () => {
        const store = createWorkspaceStore();
        store.getState().setIsCropMode(true);
        store.getState().setCropSelection({
            ownerId: 'instance-2',
            pageNum: 4,
            regions: [{ x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.9 }],
            selectedIndex: 0,
        });

        expect(store.getState().cropSelection?.ownerId).toBe('instance-2');
        store.getState().setIsCropMode(false);
        expect(store.getState().cropSelection).toBeNull();
    });

    it('undoes and redoes a completed crop adjustment as one step', () => {
        const store = createWorkspaceStore();
        const initial = {
            ownerId: 'instance-1',
            pageNum: 1,
            regions: [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }],
            selectedIndex: 0,
        };
        const moved = {
            ...initial,
            regions: [{ x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.6 }],
        };

        store.getState().setIsCropMode(true);
        store.getState().commitCropSelection(initial);
        store.getState().recordCropSelectionSnapshot();
        store.getState().setCropSelection(moved);

        store.getState().undoCropSelection();
        expect(store.getState().cropSelection).toEqual(initial);

        store.getState().redoCropSelection();
        expect(store.getState().cropSelection).toEqual(moved);
    });

    it('restores a deleted crop and clears crop history when the mode exits', () => {
        const store = createWorkspaceStore();
        const selection = {
            ownerId: 'instance-1',
            pageNum: 1,
            regions: [
                { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
                { x0: 0.5, y0: 0.5, x1: 0.9, y1: 0.9 },
            ],
            selectedIndex: 1,
        };

        store.getState().setIsCropMode(true);
        store.getState().commitCropSelection(selection);
        store.getState().commitCropSelection(null);
        expect(store.getState().cropSelection).toBeNull();

        store.getState().undoCropSelection();
        expect(store.getState().cropSelection).toEqual(selection);

        store.getState().setIsCropMode(false);
        expect(store.getState().cropPast).toEqual([]);
        expect(store.getState().cropFuture).toEqual([]);
    });
});
