import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './useWorkspaceStore';


const preview = {
    page_number: 1,
    mask_revision: 1,
    preview_width_px: 120,
    preview_height_px: 80,
    paths: [{
        instance_id: 1,
        d: 'M 10 10 L 110 10 L 110 70 L 10 70 Z',
        segment_count: 4,
    }],
    fingerprint: 'a'.repeat(64),
    segment_count: 4,
};

describe('workspace — preview đường bế classic trên Viewer', () => {
    it('giữ preview riêng từng tab và chỉ owner được phép dọn', () => {
        const tabA = createWorkspaceStore();
        const tabB = createWorkspaceStore();
        tabA.getState().setClassicCutlineViewerPreview({
            ownerId: 'owner-a',
            preview,
            viewerPage: 1,
            pageInstanceId: 'instance-a',
            documentIdentity: 'doc-a',
            isUpdating: false,
        });

        tabA.getState().clearClassicCutlineViewerPreview('owner-cu');
        expect(tabA.getState().classicCutlineViewerPreview?.ownerId).toBe('owner-a');
        expect(tabB.getState().classicCutlineViewerPreview).toBeNull();

        tabA.getState().clearClassicCutlineViewerPreview('owner-a');
        expect(tabA.getState().classicCutlineViewerPreview).toBeNull();
    });

    it('xóa overlay ngay khi file hoặc cấu trúc trang thay đổi', () => {
        const store = createWorkspaceStore();
        const publish = () => store.getState().setClassicCutlineViewerPreview({
            ownerId: 'owner-a',
            preview,
            viewerPage: 1,
            pageInstanceId: 'instance-a',
            documentIdentity: 'doc-a',
            isUpdating: false,
        });

        publish();
        store.getState().setViewerPageOrder([2, 1]);
        expect(store.getState().classicCutlineViewerPreview).toBeNull();

        publish();
        store.getState().setViewerPageRotations([90, 0]);
        expect(store.getState().classicCutlineViewerPreview).toBeNull();

        publish();
        store.getState().setFile(new File(['pdf'], 'file-moi.pdf'));
        expect(store.getState().classicCutlineViewerPreview).toBeNull();
    });
});
