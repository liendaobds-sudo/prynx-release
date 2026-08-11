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
