import { describe, expect, it } from 'vitest';
import { createWorkspaceStore } from './useWorkspaceStore';

describe('Workspace menu ownership', () => {
    it('giữ mode và width độc lập giữa hai tab', () => {
        const tabA = createWorkspaceStore('full', 320);
        const tabB = createWorkspaceStore('icons', 500);

        tabA.getState().setRightToolMenuMode('icons');
        tabA.getState().setRightToolMenuFullWidth(740);

        expect(tabA.getState()).toMatchObject({
            rightToolMenuMode: 'icons',
            rightToolMenuFullWidth: 740,
        });
        expect(tabB.getState()).toMatchObject({
            rightToolMenuMode: 'icons',
            rightToolMenuFullWidth: 500,
        });
    });

    it('chuẩn hóa width runtime trong biên 280..800', () => {
        const store = createWorkspaceStore('full', 9999);
        expect(store.getState().rightToolMenuFullWidth).toBe(800);

        store.getState().setRightToolMenuFullWidth(12);
        expect(store.getState().rightToolMenuFullWidth).toBe(280);
    });

    it('giữ query và scroll theo tab khi catalog bị unmount/remount', () => {
        const store = createWorkspaceStore();
        store.getState().setToolMenuQuery('crop');
        store.getState().setToolMenuScrollTop(184);

        expect(store.getState()).toMatchObject({
            toolMenuQuery: 'crop',
            toolMenuScrollTop: 184,
        });
    });

    it('không cho Crop và Edit cùng bật ở store', () => {
        const store = createWorkspaceStore();
        store.getState().setIsObjectEditMode(true);
        expect(store.getState()).toMatchObject({ isObjectEditMode: true, isCropMode: false });

        store.getState().setIsCropMode(true);
        expect(store.getState()).toMatchObject({ isObjectEditMode: false, isCropMode: true });

        store.getState().setIsObjectEditMode(true);
        expect(store.getState()).toMatchObject({ isObjectEditMode: true, isCropMode: false });
    });
});
