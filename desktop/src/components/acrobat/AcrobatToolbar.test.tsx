// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    workspaceState: {
        viewerZoom: 1,
        setViewerZoom: vi.fn(),
        viewerFitMode: 'page',
        setViewerFitMode: vi.fn(),
        viewerToolMode: 'pointer',
        setViewerToolMode: vi.fn(),
        viewerPageDisplayMode: 'single_fit',
        setViewerPageDisplayMode: vi.fn(),
        viewerActivePage: 1,
        isObjectEditMode: false,
        setIsObjectEditMode: vi.fn(),
        isCropMode: false,
        setIsCropMode: vi.fn(),
    },
    appSettingsState: {
        showRulers: false,
        toggleRulers: vi.fn(),
    },
    imposerSettingsState: {
        activeDashboardTool: null,
    },
}));

const translations: Record<string, string> = {
    'misc.acrobatToolbar:chon_muc_thu_phong': 'Chọn mức thu phóng',
    'misc.acrobatToolbar:hien_thi_trang': 'Hiển thị trang',
    'misc.acrobatToolbar:hien_thi': 'Hiển thị',
    'misc.acrobatToolbar:bo_cuc_trang': 'Bố cục trang',
    'misc.acrobatToolbar:xem_mot_trang': 'Xem một trang',
    'misc.acrobatToolbar:cuon_trang_doc': 'Cuộn trang dọc',
    'misc.acrobatToolbar:xem_hai_trang': 'Xem hai trang',
    'misc.acrobatToolbar:cuon_hai_trang': 'Cuộn hai trang',
};

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: string) => fallback ?? translations[key] ?? key,
    }),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('../../stores/useWorkspaceStore', () => ({
    useWorkspaceStore: (selector: (state: typeof mocks.workspaceState) => unknown) =>
        selector(mocks.workspaceState),
}));
vi.mock('../../stores/appSettingsStore', () => ({
    useAppSettingsStore: (selector: (state: typeof mocks.appSettingsState) => unknown) =>
        selector(mocks.appSettingsState),
}));
vi.mock('../imposition-tools/useImposerSettingsStore', () => ({
    useImposerSettingsStore: (selector: (state: typeof mocks.imposerSettingsState) => unknown) =>
        selector(mocks.imposerSettingsState),
}));
vi.mock('../../lib/keyboardShortcuts', () => ({ getShortcutLabel: () => '' }));

import { AcrobatToolbar } from './AcrobatToolbar';

const renderToolbar = () => render(
    <div style={{ width: 640, overflow: 'hidden' }}>
        <AcrobatToolbar
            pageOrderLength={2}
            navigatePage={vi.fn()}
            applyFitWidth={vi.fn()}
            applyFitPage={vi.fn()}
            onOpenRotateModalOrTools={vi.fn()}
        />
    </div>,
);

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    cleanup();
});

describe('UIUX (audit 2026-08-25) popup toolbar không bị scrollport cắt', () => {
    it('mở menu Hiển thị trong portal và đổi được bố cục trang', () => {
        const { container } = renderToolbar();

        fireEvent.click(screen.getByRole('button', { name: 'Hiển thị trang' }));

        const menu = screen.getByRole('menu', { name: 'Bố cục trang' });
        const toolbarScroll = container.querySelector('[data-toolbar-scroll]');
        const toolbar = container.querySelector('[data-acrobat-toolbar]');
        expect(document.body.contains(menu)).toBe(true);
        expect(toolbarScroll?.contains(menu)).toBe(false);
        expect(toolbar?.contains(menu)).toBe(true);
        expect(screen.getByRole('button', { name: 'Hiển thị trang' }).getAttribute('aria-expanded')).toBe('true');

        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Xem hai trang' }));
        expect(mocks.workspaceState.setViewerPageDisplayMode).toHaveBeenCalledWith('two_fit');
        expect(screen.queryByRole('menu', { name: 'Bố cục trang' })).toBeNull();
    });

    it('đóng menu Hiển thị bằng Escape hoặc khi click ra ngoài', () => {
        renderToolbar();
        const displayButton = screen.getByRole('button', { name: 'Hiển thị trang' });
        const viewerEscapeHandler = vi.fn();
        document.addEventListener('keydown', viewerEscapeHandler);

        try {
            fireEvent.click(displayButton);
            fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
            expect(screen.queryByRole('menu', { name: 'Bố cục trang' })).toBeNull();
            expect(viewerEscapeHandler).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(displayButton);

            fireEvent.click(displayButton);
            fireEvent.click(screen.getByTestId('toolbar-dropdown-backdrop'));
            expect(screen.queryByRole('menu', { name: 'Bố cục trang' })).toBeNull();
        } finally {
            document.removeEventListener('keydown', viewerEscapeHandler);
        }
    });

    it('menu mức zoom dùng cùng portal và vẫn áp dụng được tỷ lệ', () => {
        const { container } = renderToolbar();

        fireEvent.click(screen.getByRole('button', { name: 'Chọn mức thu phóng' }));

        const menu = screen.getByRole('menu', { name: 'Chọn mức thu phóng' });
        const toolbarScroll = container.querySelector('[data-toolbar-scroll]');
        expect(toolbarScroll?.contains(menu)).toBe(false);

        fireEvent.click(within(menu).getByRole('menuitem', { name: '200%' }));
        expect(mocks.workspaceState.setViewerZoom).toHaveBeenCalledWith(2);
        expect(mocks.workspaceState.setViewerFitMode).toHaveBeenCalledWith('custom');
    });
});
