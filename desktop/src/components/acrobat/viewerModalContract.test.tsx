// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import { useViewerHotkeys } from '../../hooks/viewer/useViewerHotkeys';
import { QuickDeleteModal } from './AcrobatModals';
import { ViewerContextMenu } from './ViewerContextMenu';

const makeHotkeyProps = (containerRef: React.RefObject<HTMLDivElement>) => ({
    containerRef,
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
});

const makeWrapper = (store: ReturnType<typeof createWorkspaceStore>) => (
    { children }: PropsWithChildren,
) => <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>;

afterEach(() => {
    document.body.innerHTML = '';
});

describe('UIUX (audit 2026-08-22 §UX.MD.01) modal boundary', () => {
    it('chặn hotkey viewer khi dialog của đúng tab đang mở', () => {
        const owner = document.createElement('div');
        owner.dataset.prynxOpenPdf = 'memory://source.pdf';
        const canvas = document.createElement('div');
        owner.appendChild(canvas);
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        owner.appendChild(dialog);
        document.body.appendChild(owner);

        const store = createWorkspaceStore();
        const props = makeHotkeyProps({ current: canvas });
        const wrapper = makeWrapper(store);
        const setDelete = props.setIsDeleteModalOpen;
        renderHook(() => useViewerHotkeys(props), { wrapper });

        fireEvent.keyDown(document, { key: 'F7', code: 'F7' });
        fireEvent.keyDown(document, { key: 'c', code: 'KeyC' });
        fireEvent.keyDown(document, { key: 'd', code: 'KeyD' });
        fireEvent.keyDown(document, { key: 'Delete', code: 'Delete' });
        fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true });

        expect(store.getState().isObjectEditMode).toBe(false);
        expect(store.getState().isCropMode).toBe(false);
        expect(store.getState().viewerToolMode).toBe('pointer');
        expect(setDelete).not.toHaveBeenCalled();
    });

    it('modal có ARIA, bắt focus và tự xử lý Escape', () => {
        const onClose = vi.fn();
        render(<QuickDeleteModal selectedCount={1} onConfirm={vi.fn()} onClose={onClose} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('prynx-quick-delete-title');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /Hủy|Cancel/i }));

        fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('đóng context menu trước khi mở Insert/Extract', () => {
        const setContextMenu = vi.fn();
        const setInsert = vi.fn();
        const setExtract = vi.fn();
        const props = {
            contextMenu: { x: 20, y: 20, visible: true },
            selectedIndices: new Set([0]),
            currentPdfUrl: 'memory://source.pdf',
            setContextMenu,
            setIsInsertModalOpen: setInsert,
            setIsExtractModalOpen: setExtract,
            setExtractPagesStrForModal: vi.fn(),
            setIsDeleteModalOpen: vi.fn(),
            onOpenPageTools: vi.fn(),
            onQuickDuplicate: vi.fn(),
        };

        render(<ViewerContextMenu {...props} />);
        const items = screen.getAllByRole('menuitem');
        fireEvent.click(items[0]);
        expect(setContextMenu).toHaveBeenCalledWith(null);
        expect(setInsert).toHaveBeenCalledWith(true);
    });
});
