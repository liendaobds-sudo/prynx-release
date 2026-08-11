import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from './useWorkspaceStore';
import type { OutputPreviewPageBoxes } from '../lib/outputPreviewOverlay';

const PAGE_BOXES: OutputPreviewPageBoxes = {
    viewerPageNum: 1,
    sourcePageNum: 1,
    cropbox: { x0: 0, y0: 0, x1: 100, y1: 50, width: 100, height: 50 },
    trimbox: { x0: 3, y0: 3, x1: 97, y1: 47, width: 94, height: 44 },
    bleedbox: { x0: 1, y0: 1, x1: 99, y1: 49, width: 98, height: 48 },
    artbox: { x0: 5, y0: 5, x1: 95, y1: 45, width: 90, height: 40 },
    has_trimbox: true,
    has_bleedbox: true,
    has_artbox: true,
    rotation: 0,
};

describe('Output Preview — Simulation state theo tab', () => {
    it('mỗi workspace giữ profile và intent độc lập', () => {
        const tabA = createWorkspaceStore();
        const tabB = createWorkspaceStore();

        tabA.getState().setOutputPreviewProfileId('swop');
        tabA.getState().setOutputPreviewRenderingIntent('perceptual');
        tabA.getState().setOutputPreviewWarningOpacity(0.6);

        expect(tabA.getState()).toMatchObject({
            outputPreviewProfileId: 'swop',
            outputPreviewRenderingIntent: 'perceptual',
            outputPreviewWarningOpacity: 0.6,
        });
        expect(tabB.getState()).toMatchObject({
            outputPreviewProfileId: 'fogra39',
            outputPreviewRenderingIntent: 'relative',
            outputPreviewWarningOpacity: 1,
        });
    });

    it('setter cùng giá trị giữ nguyên snapshot để không đánh thức Viewer', () => {
        const store = createWorkspaceStore();
        const before = store.getState();

        store.getState().setOutputPreviewProfileId('fogra39');
        store.getState().setOutputPreviewRenderingIntent('relative');
        store.getState().setOutputPreviewWarningOpacity(1);
        store.getState().setOutputPreviewOverprintDiagnosticActive(false);
        store.getState().setOutputPreviewActiveViewerPage(null);
        store.getState().setOutputPreviewPageBoxes(null);
        store.getState().setOutputPreviewShowPageBoxes(false);

        expect(store.getState()).toBe(before);
    });

    it('clamp opacity và tách trạng thái diff khỏi composite Overprint', () => {
        const store = createWorkspaceStore();
        store.getState().setOutputPreviewWarningOpacity(2);
        expect(store.getState().outputPreviewWarningOpacity).toBe(1);
        store.getState().setOutputPreviewWarningOpacity(-0.25);
        expect(store.getState().outputPreviewWarningOpacity).toBe(0);

        store.getState().setOutputPreviewOverprintDiagnosticActive(true);
        expect(store.getState().outputPreviewOverprintDiagnosticActive).toBe(true);
    });

    it('giữ PageBox và trạng thái hiển thị độc lập theo tab, dọn dữ liệu khi đóng', () => {
        const tabA = createWorkspaceStore();
        const tabB = createWorkspaceStore();

        tabA.getState().setShowOutputPreview(true);
        tabA.getState().setOutputPreviewActiveViewerPage(1);
        tabA.getState().setOutputPreviewPageBoxes(PAGE_BOXES);
        tabA.getState().setOutputPreviewShowPageBoxes(true);

        expect(tabA.getState().outputPreviewPageBoxes).toBe(PAGE_BOXES);
        expect(tabA.getState().outputPreviewActiveViewerPage).toBe(1);
        expect(tabA.getState().outputPreviewShowPageBoxes).toBe(true);
        expect(tabB.getState().outputPreviewPageBoxes).toBeNull();
        expect(tabB.getState().outputPreviewActiveViewerPage).toBeNull();
        expect(tabB.getState().outputPreviewShowPageBoxes).toBe(false);

        tabA.getState().closeOutputPreview();
        expect(tabA.getState().showOutputPreview).toBe(false);
        expect(tabA.getState().outputPreviewActiveViewerPage).toBeNull();
        expect(tabA.getState().outputPreviewPageBoxes).toBeNull();
        expect(tabA.getState().outputPreviewShowPageBoxes).toBe(true);
    });
});
