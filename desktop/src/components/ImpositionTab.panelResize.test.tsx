// @vitest-environment jsdom

import { useContext, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { WorkspaceContext, type WorkspaceState } from '../stores/useWorkspaceStore';
import { useAppSettingsStore } from '../stores/appSettingsStore';
import { useStickerSheetStore } from './preprocess-tools/stickerSheetStore';

const mocks = vi.hoisted(() => ({ workspace: null as StoreApi<WorkspaceState> | null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('./imposition-tools/ImposerDashboard', () => ({ default: () => <div data-testid="resize-config-content" /> }));
vi.mock('./imposition-tools/ToolMenuList', () => ({
    default: ({ setActiveTool }: { setActiveTool: (tool: string) => void }) => (
        <div data-testid="resize-catalog-content">
            <button onClick={() => setActiveTool('sticker')}>Mở công cụ kiểm thử</button>
        </div>
    ),
}));
vi.mock('./OutputPreviewHost', () => ({ default: () => null }));
vi.mock('./AcrobatViewer', () => ({
    default: function ViewerProbe({ rightPanel }: { rightPanel?: ReactNode }) {
        mocks.workspace = useContext(WorkspaceContext);
        return <div data-testid="resize-viewer-probe">{rightPanel}</div>;
    },
}));
vi.mock('../lib/api', async original => ({
    ...await original<typeof import('../lib/api')>(),
    uploadPDF: vi.fn(async () => ({ id: 'resize-source' })),
    authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ layers: [] }) })),
}));
vi.mock('../lib/utils', async original => ({
    ...await original<typeof import('../lib/utils')>(), detectColorSpace: vi.fn(async () => null),
}));
vi.mock('../lib/viewerFirstFrame', () => ({
    primeViewerFirstFrame: vi.fn(async () => null), waitForViewerFirstFrameGrace: vi.fn(async () => null),
}));
import ImpositionTab from './ImpositionTab';

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const tabId = 'independent-panel-resize';

async function mountPanels(mode: 'full' | 'icons', active = true) {
    useAppSettingsStore.setState({
        toolMenuMode: mode, toolMenuWidth: 310, toolConfigWidth: 390,
        homeToolMenuWidth: 240, isWorkspaceSidebarOpen: mode === 'full', isToolMenuExpanded: false,
        favoriteTools: [], hiddenTools: [],
    });
    const file = new File(['%PDF source'], 'source.pdf', { type: 'application/pdf' });
    render(<ImpositionTab tabId={tabId} isActive initialFeature={active ? 'sticker' : undefined} initialFile={file} />);
    await waitFor(() => expect(mocks.workspace?.getState().file).toBe(file));
}

function widths() {
    const outer = screen.getByTestId('workspace-panel-resize').parentElement!;
    const configPane = screen.queryByTestId('resize-config-content')?.closest<HTMLElement>('[style*="flex-basis"]');
    const total = Number.parseFloat(outer.style.width);
    const config = configPane ? Number.parseFloat(configPane.style.flexBasis) : 0;
    return { total, config, catalog: total - config };
}

function pointer(target: HTMLElement | Window, type: string, clientX: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    fireEvent(target, event);
}

function flushFrame() {
    act(() => {
        const pending = Array.from(frames.values());
        frames.clear();
        pending.forEach(callback => callback(performance.now()));
    });
}

async function drag(handleId: string, delta: number) {
    const handle = screen.getByTestId(handleId);
    pointer(handle, 'pointerdown', 1000);
    pointer(window, 'pointermove', 1000 - delta);
    flushFrame();
    const whileDragging = widths();
    await act(async () => pointer(window, 'pointerup', 1000 - delta));
    expect(widths()).toEqual(whileDragging);
    return whileDragging;
}

describe('ImpositionTab — kéo panel độc lập với menu công cụ', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.workspace = null;
        frames.clear();
        frameId = 0;
        vi.stubGlobal('innerWidth', 1800);
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            frames.set(++frameId, callback);
            return frameId;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
        // Đợi hydrate xong trước seed để không dùng state giữa hai lượt tải settings.
        await useAppSettingsStore.persist.rehydrate();
    });
    afterEach(() => {
        cleanup();
        useStickerSheetStore.setState({ tabs: {} });
        frames.clear();
        vi.unstubAllGlobals();
    });

    it('icons: kéo thiết lập +200 giữ rail 48, catalog 310 và lưu config 590', async () => {
        await mountPanels('icons');
        expect(widths()).toEqual({ total: 438, config: 390, catalog: 48 });
        expect(await drag('workspace-panel-resize', 200)).toEqual({ total: 638, config: 590, catalog: 48 });
        expect(mocks.workspace!.getState()).toMatchObject({
            rightToolMenuMode: 'icons', rightToolMenuFullWidth: 310, rightToolConfigWidth: 590,
        });
        expect(useAppSettingsStore.getState()).toMatchObject({
            toolMenuMode: 'icons', toolMenuWidth: 310, toolConfigWidth: 590, homeToolMenuWidth: 240,
        });
    });

    it('full: kéo thiết lập +100 giữ menu 310, pointerup không chia lại hai cột', async () => {
        await mountPanels('full');
        expect(widths()).toEqual({ total: 700, config: 390, catalog: 310 });
        expect(await drag('workspace-panel-resize', 100)).toEqual({ total: 800, config: 490, catalog: 310 });
        expect(useAppSettingsStore.getState()).toMatchObject({
            toolMenuMode: 'full', toolMenuWidth: 310, toolConfigWidth: 490, homeToolMenuWidth: 240,
        });
    });

    it('divider: kéo menu +60 chỉ tăng catalog 370, không đổi config 390', async () => {
        await mountPanels('full');
        expect(await drag('workspace-catalog-resize', 60)).toEqual({ total: 760, config: 390, catalog: 370 });
        expect(mocks.workspace!.getState()).toMatchObject({ rightToolConfigWidth: 390, rightToolMenuFullWidth: 370 });
        expect(useAppSettingsStore.getState()).toMatchObject({ toolConfigWidth: 390, toolMenuWidth: 370, homeToolMenuWidth: 240 });
    });

    it('mũi tên mở/thu menu giữ chiều rộng thiết lập vừa kéo', async () => {
        await mountPanels('icons');
        await drag('workspace-panel-resize', 200);
        fireEvent.click(screen.getByRole('button', { name: 'Mở rộng menu' }));
        expect(widths()).toEqual({ total: 900, config: 590, catalog: 310 });
        fireEvent.click(screen.getByRole('button', { name: 'Thu gọn menu' }));
        expect(widths()).toEqual({ total: 638, config: 590, catalog: 48 });
        expect(useAppSettingsStore.getState()).toMatchObject({ toolConfigWidth: 590, toolMenuWidth: 310, homeToolMenuWidth: 240 });
    });

    it('đóng rồi mở lại công cụ giữ riêng cả hai chiều rộng', async () => {
        await mountPanels('full');
        await drag('workspace-panel-resize', 100);
        await drag('workspace-catalog-resize', 60);
        fireEvent.click(screen.getByRole('button', { name: 'Đóng thiết lập công cụ' }));
        expect(widths()).toEqual({ total: 370, config: 0, catalog: 370 });
        fireEvent.click(screen.getByRole('button', { name: 'Mở công cụ kiểm thử' }));
        expect(widths()).toEqual({ total: 860, config: 490, catalog: 370 });
        expect(useAppSettingsStore.getState()).toMatchObject({ toolConfigWidth: 490, toolMenuWidth: 370, homeToolMenuWidth: 240 });
    });

    it('không mở công cụ: mép ngoài vẫn kéo menu và không sửa config/Home đã nhớ', async () => {
        await mountPanels('full', false);
        expect(widths()).toEqual({ total: 310, config: 0, catalog: 310 });
        expect(await drag('workspace-panel-resize', 120)).toEqual({ total: 430, config: 0, catalog: 430 });
        expect(useAppSettingsStore.getState()).toMatchObject({ toolConfigWidth: 390, toolMenuWidth: 430, homeToolMenuWidth: 240 });
    });

    it.each([
        { mode: 'full' as const, viewport: 1220, config: 590, catalog: 310, total: 900 },
        { mode: 'icons' as const, viewport: 770, config: 402, catalog: 48, total: 450 },
    ])('kéo quá chỗ trống ở $mode chỉ kẹp thiết lập, không đổi cột còn lại hoặc mode', async ({ mode, viewport, config, catalog, total }) => {
        vi.stubGlobal('innerWidth', viewport);
        await mountPanels(mode);
        expect(await drag('workspace-panel-resize', 500)).toEqual({ total, config, catalog });
        expect(useAppSettingsStore.getState()).toMatchObject({
            toolMenuMode: mode, toolMenuWidth: 310, toolConfigWidth: config, homeToolMenuWidth: 240,
        });
        expect(total).toBe(viewport - 320);
    });
});
