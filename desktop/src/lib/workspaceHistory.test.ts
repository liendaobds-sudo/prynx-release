// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
    createWorkspaceHistoryEntry,
    normalizeWorkspaceHistoryPageRevision,
} from './workspaceHistory';

afterEach(() => {
    delete window.__TAURI_INTERNALS__;
});

describe('workspace history revision', () => {
    it('clone và đóng băng toàn bộ page revision tại thời điểm chụp', () => {
        const order = [3, 1, 1];
        const ids = ['page-a', 'page-b', 'page-c'];
        const rotations = [90, 0, 270];
        const entry = createWorkspaceHistoryEntry({
            file: new File(['pdf'], 'tai-lieu.pdf', { type: 'application/pdf' }),
            pageOrder: order,
            pageInstanceIds: ids,
            pageRotations: rotations,
            pageRevisionDirty: true,
        });

        order[0] = 99;
        ids[0] = 'changed';
        rotations[0] = 180;

        expect(entry.pageRevision).toEqual({
            pageOrder: [3, 1, 1],
            pageInstanceIds: ['page-a', 'page-b', 'page-c'],
            pageRotations: [90, 0, 270],
        });
        expect(entry.pageRevisionDirty).toBe(true);
        expect(Object.isFrozen(entry)).toBe(true);
        expect(Object.isFrozen(entry.pageRevision)).toBe(true);
        expect(Object.isFrozen(entry.pageRevision?.pageOrder)).toBe(true);
        expect(Object.isFrozen(entry.pageRevision?.pageInstanceIds)).toBe(true);
        expect(Object.isFrozen(entry.pageRevision?.pageRotations)).toBe(true);
    });

    it('sinh lại toàn bộ instance ID khi danh sách thiếu/lệch và giữ rotation theo vị trí', () => {
        let sequence = 0;
        const revision = normalizeWorkspaceHistoryPageRevision(
            [2, 2, 1],
            ['stale-id'],
            [-90, Number.NaN],
            () => `history-page-${++sequence}`,
        );

        expect(revision).toEqual({
            pageOrder: [2, 2, 1],
            pageInstanceIds: ['history-page-1', 'history-page-2', 'history-page-3'],
            pageRotations: [270, 0, 0],
        });
    });

    it('strip bytes của File có path nhưng vẫn giữ source owners và recipe marker typed', () => {
        window.__TAURI_INTERNALS__ = {};
        const file = new File([new Uint8Array(512)], 'working.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'path', { value: 'C:/temp/working.pdf' });
        const sourceImage = new File(['image'], 'source.png', { type: 'image/png' });
        const stickerSource = new File(['sheet'], 'sheet.pdf', { type: 'application/pdf' });

        const entry = createWorkspaceHistoryEntry({
            file,
            sourceImageFile: sourceImage,
            stickerSourceFile: stickerSource,
            recipeDraftLen: 4,
        });

        expect(entry.file).not.toBe(file);
        expect(entry.file.size).toBe(512);
        expect(entry.file.slice(0, 1).size).toBe(0);
        expect((entry.file as File & { path?: string }).path).toBe('C:/temp/working.pdf');
        expect(entry.sourceImageFile).toBe(sourceImage);
        expect(entry.stickerSourceFile).toBe(stickerSource);
        expect(entry.recipeDraftLen).toBe(4);
        expect(entry.pageRevisionDirty).toBe(false);
        expect(entry.pageRevision).toBeNull();
    });
});
