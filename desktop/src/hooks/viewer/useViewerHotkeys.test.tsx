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
});
