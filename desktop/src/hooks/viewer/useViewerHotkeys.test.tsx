// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import { fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import { useViewerHotkeys } from './useViewerHotkeys';

const makeProps = (overrides: Record<string, unknown> = {}) => ({
    containerRef: { current: document.createElement('div') },
    sidebarRef: { current: null },
    isActive: true,
    pageOrder: [1],
    pageInstanceIds: ['page-1'],
    selectedIndices: new Set([0]),
    lastSelectedIndex: 0,
    pageRotations: {},
    activePage: 1,
    numPages: 1,
    setPageOrder: vi.fn(),
    setSelectedIndices: vi.fn(),
    setLastSelectedIndex: vi.fn(),
    setPageRotations: vi.fn(),
    setActivePage: vi.fn(),
    pastStack: [],
    futureStack: [],
    setPastStack: vi.fn(),
    setFutureStack: vi.fn(),
    toolMode: 'pointer' as const,
    setToolMode: vi.fn(),
    isVdpMode: false,
    isThumbMenuOpen: false,
    isDeleteModalOpen: false,
    setIsDeleteModalOpen: vi.fn(),
    setIsExtractModalOpen: vi.fn(),
    setIsInsertModalOpen: vi.fn(),
    setExtractPagesStrForModal: vi.fn(),
    setContextMenu: vi.fn(),
    setIsSidebarOpen: vi.fn(),
    guides: [],
    setGuides: vi.fn(),
    guidesHistory: [],
    setGuidesHistory: vi.fn(),
    selectedGuideId: null,
    setSelectedGuideId: vi.fn(),
    toggleRulers: vi.fn(),
    navigatePage: vi.fn(),
    mainVirtuosoRef: { current: null },
    internalScrollRef: { current: null },
    ...overrides,
});

const makeWrapper = () => {
    const store = createWorkspaceStore();
    return ({ children }: PropsWithChildren) => (
        <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
    );
};

afterEach(() => {
    document.body.innerHTML = '';
});

describe('useViewerHotkeys document undo fallback', () => {
    it('Ctrl+Z hoàn tác file đã xử lý khi không còn lịch sử thao tác trang', () => {
        const onDocumentUndo = vi.fn();
        renderHook(() => useViewerHotkeys(makeProps({ onDocumentUndo })), {
            wrapper: makeWrapper(),
        });

        fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true });

        expect(onDocumentUndo).toHaveBeenCalledTimes(1);
    });

    it('ưu tiên hoàn tác thao tác trang trước file đã xử lý', () => {
        const onDocumentUndo = vi.fn();
        const setPageOrder = vi.fn();
        renderHook(() => useViewerHotkeys(makeProps({
            pageOrder: [1, 2],
            pastStack: [{ order: [2, 1], selection: [1], lastSelected: 1, rotations: {} }],
            setPageOrder,
            onDocumentUndo,
        })), { wrapper: makeWrapper() });

        fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true });

        expect(setPageOrder).toHaveBeenCalledWith([2, 1]);
        expect(onDocumentUndo).not.toHaveBeenCalled();
    });

    it('không cướp Ctrl+Z của ô nhập liệu', () => {
        const onDocumentUndo = vi.fn();
        renderHook(() => useViewerHotkeys(makeProps({ onDocumentUndo })), {
            wrapper: makeWrapper(),
        });
        const input = document.createElement('input');
        document.body.appendChild(input);

        fireEvent.keyDown(input, { key: 'z', code: 'KeyZ', ctrlKey: true });

        expect(onDocumentUndo).not.toHaveBeenCalled();
    });

    it('toggles Crop with C and synchronizes the toolbar modes', () => {
        const store = createWorkspaceStore();
        store.getState().setViewerToolMode('dimension');
        store.getState().setIsObjectEditMode(true);
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps({ toolMode: 'dimension' })), { wrapper });

        fireEvent.keyDown(document, { key: 'c', code: 'KeyC' });
        expect(store.getState().isCropMode).toBe(true);
        expect(store.getState().isObjectEditMode).toBe(false);
        expect(store.getState().viewerToolMode).toBe('pointer');

        fireEvent.keyDown(document, { key: 'c', code: 'KeyC' });
        expect(store.getState().isCropMode).toBe(false);
    });

    it('does not toggle Crop for Ctrl+C or while typing', () => {
        const store = createWorkspaceStore();
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps()), { wrapper });

        fireEvent.keyDown(document, { key: 'c', code: 'KeyC', ctrlKey: true });
        expect(store.getState().isCropMode).toBe(false);

        const input = document.createElement('input');
        document.body.appendChild(input);
        fireEvent.keyDown(input, { key: 'c', code: 'KeyC' });
        expect(store.getState().isCropMode).toBe(false);
    });

    it('toggles DIM off with an immediate second D press', () => {
        const store = createWorkspaceStore();
        const toggleRulers = vi.fn();
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps({ toggleRulers })), { wrapper });

        fireEvent.keyDown(document, { key: 'd', code: 'KeyD' });
        expect(store.getState().viewerToolMode).toBe('dimension');

        fireEvent.keyDown(document, { key: 'd', code: 'KeyD' });
        expect(store.getState().viewerToolMode).toBe('pointer');
        expect(toggleRulers).toHaveBeenCalledTimes(1);
    });

    it('routes Ctrl+Z and Ctrl+Y to crop history before document history', () => {
        const store = createWorkspaceStore();
        const initial = {
            ownerId: 'page-1',
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

        const onDocumentUndo = vi.fn();
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps({ onDocumentUndo })), { wrapper });

        fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(store.getState().cropSelection).toEqual(initial);
        expect(onDocumentUndo).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'y', code: 'KeyY', ctrlKey: true });
        expect(store.getState().cropSelection).toEqual(moved);
        expect(onDocumentUndo).not.toHaveBeenCalled();
    });

    it('temporarily pans with Space during crop and restores crop without navigating', () => {
        const store = createWorkspaceStore();
        const selection = {
            ownerId: 'page-1',
            pageNum: 1,
            regions: [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }],
            selectedIndex: 0,
        };
        store.getState().setIsCropMode(true);
        store.getState().commitCropSelection(selection);
        const navigatePage = vi.fn();
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps({ navigatePage })), { wrapper });

        fireEvent.keyDown(document, { key: ' ', code: 'Space' });
        expect(store.getState().viewerToolMode).toBe('hand');
        expect(store.getState().cropSelection).toEqual(selection);

        fireEvent.keyUp(document, { key: ' ', code: 'Space' });
        expect(store.getState().viewerToolMode).toBe('pointer');
        expect(store.getState().cropSelection).toEqual(selection);
        expect(navigatePage).not.toHaveBeenCalled();
    });

    it('restores the crop tool if the window loses focus while Space is held', () => {
        const store = createWorkspaceStore();
        store.getState().setIsCropMode(true);
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps()), { wrapper });

        fireEvent.keyDown(document, { key: ' ', code: 'Space' });
        expect(store.getState().viewerToolMode).toBe('hand');
        fireEvent.blur(window);
        expect(store.getState().viewerToolMode).toBe('pointer');
    });

    it('switches permanent tools and Escape returns every mode to Pointer', () => {
        const store = createWorkspaceStore();
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        renderHook(() => useViewerHotkeys(makeProps()), { wrapper });

        fireEvent.keyDown(document, { key: 'h', code: 'KeyH' });
        expect(store.getState().viewerToolMode).toBe('hand');
        fireEvent.keyDown(document, { key: 'v', code: 'KeyV' });
        expect(store.getState().viewerToolMode).toBe('pointer');

        store.getState().setViewerToolMode('hand');
        store.getState().setIsCropMode(true);
        store.getState().setIsObjectEditMode(true);
        fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

        expect(store.getState().viewerToolMode).toBe('pointer');
        expect(store.getState().isCropMode).toBe(false);
        expect(store.getState().isObjectEditMode).toBe(false);
    });

    it('dispatches fit and zoom commands through the viewer command channel', () => {
        const commands: string[] = [];
        const onCommand = (event: Event) => commands.push((event as CustomEvent).detail.cmd);
        window.addEventListener('prynx-menu-command', onCommand);
        renderHook(() => useViewerHotkeys(makeProps()), { wrapper: makeWrapper() });

        fireEvent.keyDown(document, { key: '0', code: 'Digit0', ctrlKey: true });
        fireEvent.keyDown(document, { key: '1', code: 'Digit1', ctrlKey: true });
        fireEvent.keyDown(document, { key: '2', code: 'Digit2', ctrlKey: true });
        fireEvent.keyDown(document, { key: '+', code: 'Equal', shiftKey: true });
        fireEvent.keyDown(document, { key: '-', code: 'Minus' });
        window.removeEventListener('prynx-menu-command', onCommand);

        expect(commands).toEqual(['fit-page', 'zoom-100', 'fit-width', 'zoom-in', 'zoom-out']);
    });

    it('navigates with Page Up, Page Down, Home and End', () => {
        const navigatePage = vi.fn();
        renderHook(() => useViewerHotkeys(makeProps({
            pageOrder: [1, 2, 3],
            pageInstanceIds: ['page-1', 'page-2', 'page-3'],
            activePage: 2,
            numPages: 3,
            navigatePage,
        })), { wrapper: makeWrapper() });

        fireEvent.keyDown(document, { key: 'PageUp', code: 'PageUp' });
        fireEvent.keyDown(document, { key: 'PageDown', code: 'PageDown' });
        fireEvent.keyDown(document, { key: 'Home', code: 'Home' });
        fireEvent.keyDown(document, { key: 'End', code: 'End' });

        expect(navigatePage.mock.calls.map(([page]) => page)).toEqual([1, 3, 1, 3]);
    });

    it('rotates selected page instances right and left with undo snapshots', () => {
        const setPageRotations = vi.fn();
        const setPastStack = vi.fn();
        renderHook(() => useViewerHotkeys(makeProps({
            pageOrder: [1, 1],
            pageInstanceIds: ['instance-a', 'instance-b'],
            selectedIndices: new Set([0, 1]),
            pageRotations: { 'instance-a': 0, 'instance-b': 90 },
            setPageRotations,
            setPastStack,
        })), { wrapper: makeWrapper() });

        fireEvent.keyDown(document, { key: 'r', code: 'KeyR' });
        const rotateRight = setPageRotations.mock.calls[0][0];
        expect(rotateRight({ 'instance-a': 0, 'instance-b': 90 })).toEqual({
            'instance-a': 90,
            'instance-b': 180,
        });

        fireEvent.keyDown(document, { key: 'R', code: 'KeyR', shiftKey: true });
        const rotateLeft = setPageRotations.mock.calls[1][0];
        expect(rotateLeft({ 'instance-a': 0, 'instance-b': 90 })).toEqual({
            'instance-a': 270,
            'instance-b': 0,
        });
        expect(setPastStack).toHaveBeenCalledTimes(2);
    });

    it('selects and clears all page thumbnails with Ctrl+A variants', () => {
        const setSelectedIndices = vi.fn();
        const setLastSelectedIndex = vi.fn();
        renderHook(() => useViewerHotkeys(makeProps({
            pageOrder: [1, 2, 3],
            pageInstanceIds: ['page-1', 'page-2', 'page-3'],
            activePage: 2,
            setSelectedIndices,
            setLastSelectedIndex,
        })), { wrapper: makeWrapper() });

        fireEvent.keyDown(document, { key: 'a', code: 'KeyA', ctrlKey: true });
        expect(Array.from(setSelectedIndices.mock.calls[0][0])).toEqual([0, 1, 2]);
        expect(setLastSelectedIndex).toHaveBeenNthCalledWith(1, 1);

        fireEvent.keyDown(document, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
        expect(Array.from(setSelectedIndices.mock.calls[1][0])).toEqual([]);
        expect(setLastSelectedIndex).toHaveBeenNthCalledWith(2, null);
    });
});
