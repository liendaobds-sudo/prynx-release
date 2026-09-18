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

    it('kích hoạt onEditInApp và onOpenDieCutModal từ context menu', () => {
        const setContextMenu = vi.fn();
        const onEditInApp = vi.fn();
        const onOpenDieCutModal = vi.fn();
        const props = {
            contextMenu: { x: 20, y: 20, visible: true },
            selectedIndices: new Set([0]),
            currentPdfUrl: 'memory://source.pdf',
            setContextMenu,
            setIsInsertModalOpen: vi.fn(),
            setIsExtractModalOpen: vi.fn(),
            setExtractPagesStrForModal: vi.fn(),
            setIsDeleteModalOpen: vi.fn(),
            onOpenPageTools: vi.fn(),
            onQuickDuplicate: vi.fn(),
            onEditInApp,
            onOpenDieCutModal,
        };

        const { unmount } = render(<ViewerContextMenu {...props} />);

        // Nhấn nút Sửa bằng Adobe Illustrator (toàn bộ file khi không có numPages > 1)
        const aiButton = screen.getByRole('menuitem', { name: /Illustrator/i });
        fireEvent.click(aiButton);
        expect(onEditInApp).toHaveBeenCalledWith('illustrator', 'all');
        expect(setContextMenu).toHaveBeenCalledWith(null);

        // Kiểm tra CorelDRAW
        const cdrButton = screen.getByRole('menuitem', { name: /CorelDRAW/i });
        fireEvent.click(cdrButton);
        expect(onEditInApp).toHaveBeenCalledWith('corel', 'all');

        // Kiểm tra Xuất khuôn bế
        const cutButton = screen.getByRole('menuitem', { name: /khuôn bế/i });
        fireEvent.click(cutButton);
        expect(onOpenDieCutModal).toHaveBeenCalled();

        unmount();

        // Kiểm tra chế độ chọn riêng nhiều trang (ví dụ chọn trang 2, 3 trong file 4 trang)
        const partialProps = {
            ...props,
            numPages: 4,
            selectedIndices: new Set([1, 2]),
        };
        const { unmount: unmountPartial } = render(<ViewerContextMenu {...partialProps} />);
        const partialAiBtn = screen.getByRole('menuitem', { name: /các trang đã chọn.*Illustrator/i });
        fireEvent.click(partialAiBtn);
        expect(onEditInApp).toHaveBeenCalledWith('illustrator', 'selection');
        unmountPartial();
    });

    it('hiển thị đúng song ngữ (vi / en) cho các tùy chọn sửa Illustrator/CorelDRAW', async () => {
        const i18n = (await import('../../i18n')).default;
        await i18n.changeLanguage('en');
        try {
            const props = {
                contextMenu: { x: 20, y: 20, visible: true },
                selectedIndices: new Set([0]),
                numPages: 3,
                setContextMenu: vi.fn(),
                setIsInsertModalOpen: vi.fn(),
                setIsExtractModalOpen: vi.fn(),
                setExtractPagesStrForModal: vi.fn(),
                setIsDeleteModalOpen: vi.fn(),
                onOpenPageTools: vi.fn(),
                onQuickDuplicate: vi.fn(),
                onEditInApp: vi.fn(),
            };
            const { unmount } = render(<ViewerContextMenu {...props} />);
            expect(screen.getByRole('menuitem', { name: /Edit page 1 only in Illustrator/i })).toBeTruthy();
            expect(screen.getByRole('menuitem', { name: /Open entire file in Illustrator/i })).toBeTruthy();
            expect(screen.getByRole('menuitem', { name: /Edit page 1 only in CorelDRAW/i })).toBeTruthy();
            expect(screen.getByRole('menuitem', { name: /Open entire file in CorelDRAW/i })).toBeTruthy();
            unmount();
        } finally {
            await i18n.changeLanguage('vi');
        }
    });

    it('đóng context menu khi click ra ngoài vào backdrop hoặc nhấn Escape', () => {
        const setContextMenu = vi.fn();
        const props = {
            contextMenu: { x: 20, y: 20, visible: true },
            selectedIndices: new Set([0]),
            numPages: 1,
            setContextMenu,
            setIsInsertModalOpen: vi.fn(),
            setIsExtractModalOpen: vi.fn(),
            setExtractPagesStrForModal: vi.fn(),
            setIsDeleteModalOpen: vi.fn(),
            onOpenPageTools: vi.fn(),
            onQuickDuplicate: vi.fn(),
        };

        const { unmount } = render(<ViewerContextMenu {...props} />);
        const backdrop = screen.getByTestId('viewer-context-menu-backdrop');
        expect(backdrop).toBeTruthy();

        // 1. Click backdrop -> đóng menu
        fireEvent.pointerDown(backdrop);
        expect(setContextMenu).toHaveBeenCalledWith(null);

        // 2. Click backdrop bằng click thông thường
        setContextMenu.mockClear();
        fireEvent.click(backdrop);
        expect(setContextMenu).toHaveBeenCalledWith(null);

        // 3. Nhấn Escape toàn cục
        setContextMenu.mockClear();
        fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
        expect(setContextMenu).toHaveBeenCalledWith(null);

        unmount();
    });

    it('kiểm tra quyền Pro cho tính năng liên kết Illustrator / CorelDRAW', async () => {
        const { useAuthStore } = await import('../../stores/useAuthStore');
        vi.stubEnv('VITE_FEATURE_GATING_ENABLED', 'true');

        try {
            // 1. Gói Free: bị chặn khi click và hiển thị huy hiệu khoá
            useAuthStore.setState({ licensePlan: 'free', licenseFeatures: null });
            const onEditInAppFree = vi.fn();
            const onOpenDieCutModalFree = vi.fn();
            const setContextMenuFree = vi.fn();
            const props = {
                contextMenu: { x: 20, y: 20, visible: true },
                selectedIndices: new Set([0]),
                numPages: 1,
                setContextMenu: setContextMenuFree,
                setIsInsertModalOpen: vi.fn(),
                setIsExtractModalOpen: vi.fn(),
                setExtractPagesStrForModal: vi.fn(),
                setIsDeleteModalOpen: vi.fn(),
                onOpenPageTools: vi.fn(),
                onQuickDuplicate: vi.fn(),
                onEditInApp: onEditInAppFree,
                onOpenDieCutModal: onOpenDieCutModalFree,
            };

            const { unmount: unmountFree } = render(<ViewerContextMenu {...props} />);
            const aiButtonFree = screen.getByRole('menuitem', { name: /Illustrator/i });
            expect(screen.getAllByText(/🔒 PRO/i).length).toBeGreaterThanOrEqual(1);

            fireEvent.click(aiButtonFree);
            expect(onEditInAppFree).not.toHaveBeenCalled();
            expect(setContextMenuFree).toHaveBeenCalledWith(null);

            // Nút Xuất khuôn bế cũng bị chặn khi ở gói Free
            const cutButtonFree = screen.getByRole('menuitem', { name: /khuôn bế/i });
            fireEvent.click(cutButtonFree);
            expect(onOpenDieCutModalFree).not.toHaveBeenCalled();
            unmountFree();

            // 2. Gói Pro: được phép kích hoạt
            useAuthStore.setState({ licensePlan: 'pro', licenseFeatures: null });
            const onEditInAppPro = vi.fn();
            const onOpenDieCutModalPro = vi.fn();
            const setContextMenuPro = vi.fn();
            const { unmount: unmountPro } = render(
                <ViewerContextMenu
                    {...props}
                    onEditInApp={onEditInAppPro}
                    onOpenDieCutModal={onOpenDieCutModalPro}
                    setContextMenu={setContextMenuPro}
                />
            );
            expect(screen.getAllByText(/^PRO$/i).length).toBeGreaterThanOrEqual(1);

            const aiButtonPro = screen.getByRole('menuitem', { name: /Illustrator/i });
            fireEvent.click(aiButtonPro);
            expect(onEditInAppPro).toHaveBeenCalledWith('illustrator', 'all');
            expect(setContextMenuPro).toHaveBeenCalledWith(null);

            const cutButtonPro = screen.getByRole('menuitem', { name: /khuôn bế/i });
            fireEvent.click(cutButtonPro);
            expect(onOpenDieCutModalPro).toHaveBeenCalled();
            unmountPro();
        } finally {
            vi.unstubAllEnvs();
            useAuthStore.setState({ licensePlan: 'pro', licenseFeatures: null });
        }
    });
});
