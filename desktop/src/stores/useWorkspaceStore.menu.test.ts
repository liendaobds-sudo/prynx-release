import { describe, expect, it } from 'vitest';
import { createWorkspaceStore } from './useWorkspaceStore';

describe('Workspace menu ownership', () => {
    it.each([
        { mode: 'icons' as const, menu: 640, config: 640 },
        { mode: 'full' as const, menu: 640, config: 390 },
        { mode: 'full' as const, menu: 320, config: 320 },
    ])('di trú chiều rộng thiết lập $mode từ preference cũ $menu', ({ mode, menu, config }) => {
        expect(createWorkspaceStore(mode, menu).getState()).toMatchObject({
            rightToolMenuFullWidth: menu, rightToolConfigWidth: config,
        });
    });

    it('hai chiều rộng độc lập trong từng tab và giữa các tab', () => {
        const tabA = createWorkspaceStore('full', 320, 680);
        const tabB = createWorkspaceStore('icons', 500, 450);
        tabA.getState().setRightToolConfigWidth(720);
        expect(tabA.getState()).toMatchObject({ rightToolMenuMode: 'full', rightToolMenuFullWidth: 320, rightToolConfigWidth: 720 });
        tabA.getState().setRightToolMenuFullWidth(600);
        tabA.getState().setRightToolMenuMode('icons');
        expect(tabA.getState()).toMatchObject({ rightToolMenuMode: 'icons', rightToolMenuFullWidth: 600, rightToolConfigWidth: 720 });
        expect(tabB.getState()).toMatchObject({ rightToolMenuMode: 'icons', rightToolMenuFullWidth: 500, rightToolConfigWidth: 450 });
    });

    it('không để NaN/Infinity vào kích thước runtime và không notify khi giá trị không đổi', () => {
        const store = createWorkspaceStore('icons', Number.NaN, Infinity);
        expect(store.getState()).toMatchObject({ rightToolMenuFullWidth: 390, rightToolConfigWidth: 390 });
        store.getState().setRightToolConfigWidth(555.6);
        store.getState().setRightToolMenuFullWidth(501.2);
        store.getState().setRightToolMenuFullWidth(Number.NaN);
        store.getState().setRightToolConfigWidth(-Infinity);
        expect(store.getState()).toMatchObject({ rightToolMenuFullWidth: 501, rightToolConfigWidth: 556 });
        let notifications = 0;
        const unsubscribe = store.subscribe(() => { notifications += 1; });
        store.getState().setRightToolConfigWidth(556);
        expect(notifications).toBe(0);
        unsubscribe();
        store.getState().setRightToolConfigWidth(5);
        expect(store.getState().rightToolConfigWidth).toBe(280);
        store.getState().setRightToolConfigWidth(9999);
        expect(store.getState().rightToolConfigWidth).toBe(800);
    });

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
