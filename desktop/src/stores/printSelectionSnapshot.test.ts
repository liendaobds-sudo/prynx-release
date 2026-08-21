import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './useWorkspaceStore';

describe('workspace print selection snapshot', () => {
    it('giữ selection độc lập theo tab và sao chép mảng đầu vào', () => {
        const tabA = createWorkspaceStore();
        const tabB = createWorkspaceStore();
        const indices = [26, 27, 29, 30, 31, 32];

        tabA.getState().setViewerSelectedPageIndices(indices);
        indices.push(39);

        expect(tabA.getState().viewerSelectedPageIndices).toEqual([26, 27, 29, 30, 31, 32]);
        expect(tabB.getState().viewerSelectedPageIndices).toEqual([]);
    });
});

describe('workspace viewer state identity', () => {
    it('không phát state mới khi effect layout gửi lại cùng giá trị', () => {
        const store = createWorkspaceStore();
        let emissions = 0;
        const unsubscribe = store.subscribe(() => {
            emissions += 1;
        });

        const initialState = store.getState();
        initialState.setViewerZoom(1);
        initialState.setViewerZoom(prev => prev);
        initialState.setViewerActivePage(1);
        initialState.setViewerNumPages(0);
        initialState.setViewerSelectedPageIndices([]);

        expect(store.getState()).toBe(initialState);
        expect(emissions).toBe(0);

        store.getState().setViewerSelectedPageIndices([1]);
        expect(emissions).toBe(1);
        expect(store.getState().viewerSelectedPageIndices).toEqual([1]);

        store.getState().setViewerSelectedPageIndices([1]);
        expect(emissions).toBe(1);

        unsubscribe();
    });
});
