// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceStore, WorkspaceContext } from '../stores/useWorkspaceStore';

const mocks = vi.hoisted(() => ({
    loader: {
        pdfRef: null, thumbPdfRef: null,
        pageDim: { w: 600, h: 600 },
        allPageDims: { 1: { w: 600, h: 600, widthPt: 450 } },
        pageWidthPt: 450, plateLabels: {}, pageOrder: [1], pageInstanceIds: ['page-1'],
        selectedIndices: new Set([0]), lastSelectedIndex: 0, pageRotations: {},
        pastStack: [], futureStack: [], colorRisk: null,
        viewerEngineMode: 'current', viewerShadowEnabled: false,
        renderDocumentToken: null, loadError: null, loadStatus: 'ready',
        setPageOrder: vi.fn(), setPageInstanceIds: vi.fn(), setSelectedIndices: vi.fn(),
        setLastSelectedIndex: vi.fn(), setPageRotations: vi.fn(), setPastStack: vi.fn(),
        setFutureStack: vi.fn(), updatePageDimForPage: vi.fn(), generateThumb: vi.fn(),
        retryLoad: vi.fn(), cancelLoad: vi.fn(), notifyFirstPageRenderReady: vi.fn(),
    },
    tiles: {
        getTileUrl: vi.fn(), getTextBlocksForPage: vi.fn(async () => []),
        renderOwnerId: 'zoom-test', renderDocumentToken: null,
        accurateColorError: null, cancelAccurateGroup: vi.fn(),
    },
    settings: { activeDashboardTool: 'sticker', setActiveDashboardTool: vi.fn() },
}));

vi.mock('react-pdf', () => ({ pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock('../hooks/viewer/usePdfLoader', async importOriginal => ({
    ...await importOriginal<typeof import('../hooks/viewer/usePdfLoader')>(),
    usePdfLoader: () => mocks.loader,
}));
vi.mock('../hooks/viewer/useTileRenderer', () => ({
    useTileRenderer: () => mocks.tiles,
    shouldAutoDisableAccurateColor: () => false,
}));
vi.mock('../hooks/viewer/usePhysicalDisplayScale', () => ({
    usePhysicalDisplayScale: () => ({ scale: 1, rawDpi: 96, devicePixelRatio: 1 }),
}));
vi.mock('./imposition-tools/useImposerSettingsStore', () => ({
    useImposerSettingsStore: (selector: (state: typeof mocks.settings) => unknown) => selector(mocks.settings),
}));
vi.mock('./workspace/LivePageFrame', () => ({
    clearEditObjectsCache: vi.fn(),
    LivePageFrame: ({ zoom, actualWidth100 }: { zoom: number; actualWidth100: number }) => (
        <div data-testid="zoom-page" data-zoom={zoom} style={{ width: actualWidth100 * zoom, height: actualWidth100 * zoom }} />
    ),
}));
vi.mock('./acrobat', async () => ({
    ...await import('./acrobat/AcrobatToolbar'),
    QuickDeleteModal: () => null, ExtractPagesModal: () => null,
    InsertBlankPageModal: () => null, Ruler: () => null, GuideLayer: () => null,
    DimensionLayer: () => null, ThumbSidebar: () => null, ViewerContextMenu: () => null,
    findDimensionCandidate: vi.fn(),
}));
vi.mock('./acrobat/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('./acrobat/CrossFileInsertModal', () => ({ CrossFileInsertModal: () => null }));
vi.mock('./workspace/ExportImageModal', () => ({ default: () => null }));

import AcrobatViewer from './AcrobatViewer';

class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

describe('AcrobatViewer — zoom trên tài liệu bù xén', () => {
    let frames: Map<number, FrameRequestCallback>;
    let nextFrame: number;

    beforeEach(() => {
        vi.clearAllMocks();
        frames = new Map();
        nextFrame = 0;
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            const id = ++nextFrame;
            frames.set(id, callback);
            return id;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            left: 0, top: 0, width: 800, height: 800, right: 800, bottom: 800,
            x: 0, y: 0, toJSON: () => ({}),
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(),
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const flushFrame = () => act(() => {
        const pending = Array.from(frames.values());
        frames.clear();
        pending.forEach(callback => callback(16));
    });

    const makeViewer = (tabId = 'sticker-zoom', isActive = true) => {
        const store = createWorkspaceStore();
        store.setState({
            file: new File(['pdf'], 'Sticker_Dieline.pdf', { type: 'application/pdf' }),
            pdfUrl: 'blob:sticker-output', viewerNumPages: 1,
            viewerFitMode: 'custom', viewerZoom: 1, viewerPageDisplayMode: 'single_scroll',
        });
        const element = (
            <WorkspaceContext.Provider value={store}>
                <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 664 }}>
                    <AcrobatViewer isActive={isActive} tabId={tabId} />
                </VirtuosoMockContext.Provider>
            </WorkspaceContext.Provider>
        );
        return { store, element };
    };

    it.each([
        ['single_scroll', 1], ['single_scroll', 2], ['single_scroll', 3],
        ['two_scroll', 2], ['single_fit', 2], ['two_fit', 2],
    ] as const)('nút +/- đổi kích thước trang ngay trong %s từ mức zoom %s', async (pageMode, initialZoom) => {
        const { store, element } = makeViewer();
        store.setState({ viewerZoom: initialZoom, viewerPageDisplayMode: pageMode });
        render(element);
        const page = await screen.findByTestId('zoom-page');
        expect(page.style.width).toBe(`${600 * initialZoom}px`);

        fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
        expect(store.getState().viewerZoom).toBe(1.25 * initialZoom);
        expect(page.style.width).toBe(`${750 * initialZoom}px`);

        fireEvent.click(screen.getByRole('button', { name: 'Zoom Out' }));
        expect(store.getState().viewerZoom).toBe(initialZoom);
        expect(page.style.width).toBe(`${600 * initialZoom}px`);
    });

    it('Ctrl+wheel tiếp tục zoom sau lưu lại đường dẫn nhưng không thay nội dung PDF', async () => {
        const { store, element } = makeViewer();
        const view = render(element);
        await screen.findByTestId('zoom-page');
        const beforeScroller = view.container.querySelector('.acro-scroll');
        const saved = new File(['pdf'], 'Sticker_Dieline.pdf', { type: 'application/pdf' });
        Object.defineProperties(saved, {
            path: { value: 'D:\\output\\Sticker_Dieline.pdf' },
            __pathRebaseOnly: { value: true },
        });
        act(() => store.getState().setFile(saved));
        await waitFor(() => expect(view.container.querySelector('.acro-scroll')).toBe(beforeScroller));

        const event = new WheelEvent('wheel', {
            bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120, clientX: 400, clientY: 400,
        });
        act(() => screen.getByTestId('zoom-page').dispatchEvent(event));
        flushFrame();

        expect(event.defaultPrevented).toBe(true);
        expect(store.getState().viewerZoom).toBeCloseTo(Math.exp(0.12));
        expect(Number(screen.getByTestId('zoom-page').dataset.zoom)).toBeCloseTo(Math.exp(0.12));
    });

    it('lệnh zoom của menu chỉ thay đổi tab đang xem', async () => {
        const active = makeViewer('active', true);
        const background = makeViewer('background', false);
        render(<>{active.element}{background.element}</>);
        await screen.findAllByTestId('zoom-page');

        act(() => window.dispatchEvent(new CustomEvent('prynx-menu-command', { detail: { cmd: 'zoom-in' } })));

        expect(active.store.getState().viewerZoom).toBe(1.25);
        expect(background.store.getState().viewerZoom).toBe(1);
    });

    it('wheel chỉ đi tới canvas đang xem, không tới tab nền hoặc panel thiết lập', async () => {
        const active = makeViewer('active', true);
        const background = makeViewer('background', false);
        const view = render(<>
            {active.element}
            <div className="opacity-0">{background.element}</div>
            <div data-testid="settings-panel" />
        </>);
        await screen.findAllByTestId('zoom-page');
        const activePage = view.container.querySelector('[data-prynx-tab-id="active"] [data-testid="zoom-page"]')!;
        const backgroundPage = view.container.querySelector('[data-prynx-tab-id="background"] [data-testid="zoom-page"]')!;
        const wheel = (target: Element) => {
            const event = new WheelEvent('wheel', {
                bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120,
            });
            act(() => target.dispatchEvent(event));
            flushFrame();
            return event;
        };

        expect(wheel(backgroundPage).defaultPrevented).toBe(false);
        expect(wheel(screen.getByTestId('settings-panel')).defaultPrevented).toBe(false);
        expect(background.store.getState().viewerZoom).toBe(1);
        expect(active.store.getState().viewerZoom).toBe(1);

        expect(wheel(activePage).defaultPrevented).toBe(true);
        expect(active.store.getState().viewerZoom).toBeCloseTo(Math.exp(0.12));
        expect(background.store.getState().viewerZoom).toBe(1);
    });

    it('Ctrl+wheel trên overlay tem dùng zoom của Viewer, không tạo viewport thứ hai', async () => {
        const { store } = makeViewer();
        render(
            <WorkspaceContext.Provider value={store}>
                <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 664 }}>
                    <AcrobatViewer isActive tabId="sticker-overlay" pageOverlay={<canvas data-testid="sticker-mask" />} />
                </VirtuosoMockContext.Provider>
            </WorkspaceContext.Provider>,
        );
        await screen.findByTestId('zoom-page');
        const event = new WheelEvent('wheel', {
            bubbles: true, cancelable: true, ctrlKey: true, deltaY: -120,
        });
        act(() => screen.getByTestId('sticker-mask').dispatchEvent(event));
        flushFrame();

        expect(event.defaultPrevented).toBe(true);
        expect(store.getState().viewerZoom).toBeCloseTo(Math.exp(0.12));
        expect(Number(screen.getByTestId('zoom-page').dataset.zoom)).toBeCloseTo(Math.exp(0.12));
    });
});
