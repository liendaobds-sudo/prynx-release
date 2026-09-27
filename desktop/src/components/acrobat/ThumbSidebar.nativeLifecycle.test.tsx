// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbSidebar } from './ThumbSidebar';
import { nativeRenderCoordinator } from '../../hooks/viewer/renderCoordinator';

const probe = vi.hoisted(() => ({
    visibleIds: null as string[] | null,
    invoke: vi.fn(),
    cancelPhysical: vi.fn(),
    report: vi.fn(),
    observed: new Set<Element>(),
}));

// Chỉ giả lập việc mount/unmount theo viewport; component, coordinator và scheduler chạy thật.
vi.mock('react-virtuoso', () => ({
    VirtuosoGrid: ({ totalCount, computeItemKey, itemContent }: {
        totalCount: number;
        computeItemKey: (index: number) => string;
        itemContent: (index: number) => React.ReactNode;
    }) => <div>{Array.from({ length: totalCount }, (_, index) => {
        const key = computeItemKey(index);
        return !probe.visibleIds || probe.visibleIds.includes(key)
            ? <React.Fragment key={key}>{itemContent(index)}</React.Fragment>
            : null;
    })}</div>,
}));
vi.mock('./useThumbSidebar', () => ({
    useThumbSidebar: () => ({
        thumbWidth: 256, livePanelWidth: null, isResizing: false,
        draggedIndex: null, hoverTargetIndex: null, dropPosition: null, isCopyDrag: false,
        marqueeBoxRef: { current: null }, handleThumbClick: vi.fn(),
        handleThumbResizeStart: vi.fn(), handlePointerDown: vi.fn(), handleMarqueeMouseDown: vi.fn(),
    }),
}));
vi.mock('../../hooks/viewer/usePdfLoader', () => ({
    ensurePdfJsThumbnail: vi.fn(), getPdfJsThumbnailDocument: vi.fn(),
}));
vi.mock('../../hooks/viewer/renderCoordinator', async importOriginal => {
    const actual = await importOriginal<typeof import('../../hooks/viewer/renderCoordinator')>();
    const { TileRenderScheduler } = await import('../../hooks/viewer/tileRenderScheduler');
    return {
        ...actual,
        nativeRenderCoordinator: new actual.RenderCoordinator({
            scheduler: new TileRenderScheduler<ArrayBuffer>(4, {
                isBackgrounded: () => false, subscribe: () => () => undefined,
            }),
            cancelPhysical: probe.cancelPhysical,
            report: probe.report,
        }),
    };
});

type Props = React.ComponentProps<typeof ThumbSidebar>;
type RenderArgs = { requestContext: { requestId: string; ownerId: string; groupKey: string } };
let pending: Array<{ args: RenderArgs; resolve: (bytes: ArrayBuffer) => void }>;

function sidebarProps(): Props {
    return {
        pageOrder: [7, 7], pageInstanceIds: ['copy-a', 'copy-b'],
        selectedIndices: new Set(), lastSelectedIndex: null, activePage: 1, numPages: 7,
        pageRotations: {}, allPageDims: { 7: { w: 816, h: 1056, widthPt: 612 } },
        thumbBaseWidth: 110, isThumbMenuOpen: true,
        file: Object.assign(new File(['pdf'], 'test.pdf', { type: 'application/pdf' }), { path: 'D:\\test.pdf' }),
        pdfUrl: 'localfile://test.pdf', renderDocumentToken: '3:10:20', isViewerActive: true,
        sidebarRef: React.createRef(), mainVirtuosoRef: React.createRef(), internalScrollRef: { current: null },
        setPageOrder: vi.fn(), setPageInstanceIds: vi.fn(), setSelectedIndices: vi.fn(),
        setLastSelectedIndex: vi.fn(), setActivePage: vi.fn(), setPageRotations: vi.fn(),
        setIsThumbMenuOpen: vi.fn(), commitSnapshot: vi.fn(), handleQuickRotate: vi.fn(),
        setContextMenu: vi.fn(), setIsInsertModalOpen: vi.fn(), setExtractPagesStrForModal: vi.fn(),
        setIsExtractModalOpen: vi.fn(), setIsDeleteModalOpen: vi.fn(), navigatePage: vi.fn(),
    };
}

async function finishRequests() {
    await act(async () => {
        for (const task of pending) task.resolve(new ArrayBuffer(8));
    });
}

describe('Thumbnail native — lifecycle thật qua coordinator', () => {
    beforeEach(() => {
        pending = [];
        probe.visibleIds = null;
        probe.invoke.mockReset();
        probe.cancelPhysical.mockClear();
        probe.report.mockClear();
        probe.observed.clear();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: probe.invoke });
        vi.stubGlobal('IntersectionObserver', class {
            observe(element: Element) { probe.observed.add(element); }
            unobserve(element: Element) { probe.observed.delete(element); }
            disconnect() { probe.observed.clear(); }
        });
        let blobId = 0;
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:thumb-${++blobId}`);
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        probe.invoke.mockImplementation((command: string, args: RenderArgs) => {
            if (command !== 'render_pdf_page' && command !== 'render_ppe_page') return Promise.resolve(true);
            return new Promise<ArrayBuffer>(resolve => pending.push({ args, resolve }));
        });
    });
    afterEach(async () => {
        cleanup();
        await finishRequests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('đổi thứ tự rồi cuộn bản sao ra/vào không hủy request của bản sao còn mounted', async () => {
        const props = sidebarProps();
        const routing = vi.spyOn(nativeRenderCoordinator, 'renderPng');
        const view = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => expect(pending).toHaveLength(2));
        const survivorId = pending[1].args.requestContext.requestId;

        const reordered = { ...props, pageInstanceIds: ['copy-b', 'copy-a'] };
        view.rerender(<ThumbSidebar {...reordered} />);
        expect(pending).toHaveLength(2); // Đổi vị trí không đổi pixel, không render thêm.
        probe.visibleIds = ['thumb-copy-b'];
        view.rerender(<ThumbSidebar {...reordered} />);
        probe.visibleIds = null;
        view.rerender(<ThumbSidebar {...reordered} />);
        await waitFor(() => expect(routing).toHaveBeenCalledTimes(3));
        // Cuộn bản sao vừa remount ra lần nữa; bản B vẫn nằm trong viewport.
        probe.visibleIds = ['thumb-copy-b'];
        view.rerender(<ThumbSidebar {...reordered} />);

        expect(probe.cancelPhysical).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: survivorId }));
        await finishRequests();
        await waitFor(() => expect(view.container.querySelectorAll('.acro-thumb-item img')).toHaveLength(1));
    });

    it('đóng sidebar dọn owner và không tạo Blob khi native trả kết quả muộn', async () => {
        const releaseOwner = vi.spyOn(nativeRenderCoordinator, 'cancelOwner');
        const view = render(<ThumbSidebar {...sidebarProps()} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => expect(pending).toHaveLength(2));
        const owner = pending[0].args.requestContext.ownerId;
        view.unmount();
        await finishRequests();
        expect(releaseOwner).toHaveBeenCalledWith(owner);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('đóng/mở panel nhả owner cũ; response muộn không được nhận là ảnh mới', async () => {
        const props = { ...sidebarProps(), pageOrder: [7], pageInstanceIds: ['a'] };
        const releaseOwner = vi.spyOn(nativeRenderCoordinator, 'cancelOwner');
        const view = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => expect(pending).toHaveLength(1));
        const firstRequest = pending[0].args.requestContext;
        view.rerender(<ThumbSidebar {...props} isThumbMenuOpen={false} />);
        expect(releaseOwner).toHaveBeenCalledWith(firstRequest.ownerId);
        view.rerender(<ThumbSidebar {...props} />);
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(pending[1].args.requestContext.groupKey).not.toBe(firstRequest.groupKey);
        await act(async () => { pending[0].resolve(new ArrayBuffer(8)); });
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        await finishRequests();
        await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(1));
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });

    it('đổi revision khi native đang chạy chỉ commit ảnh revision mới', async () => {
        const props = { ...sidebarProps(), pageOrder: [7], pageInstanceIds: ['a'] };
        const releaseOwner = vi.spyOn(nativeRenderCoordinator, 'cancelOwner');
        const view = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => expect(pending).toHaveLength(1));
        const previousOwner = pending[0].args.requestContext.ownerId;
        view.rerender(<ThumbSidebar {...props} renderDocumentToken="3:11:20" />);
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(releaseOwner).toHaveBeenCalledWith(previousOwner);
        expect(pending[1].args.requestContext.ownerId).not.toBe(previousOwner);
        await finishRequests();
        await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(1));
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('hai tab cùng file: đóng một tab không hủy request hoặc Blob của tab kia', async () => {
        const props = { ...sidebarProps(), pageOrder: [7], pageInstanceIds: ['a'] };
        const first = render(<ThumbSidebar {...props} />);
        const second = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(pending[0].args.requestContext.ownerId).not.toBe(pending[1].args.requestContext.ownerId);
        first.unmount();
        await finishRequests();
        await waitFor(() => expect(second.container.querySelectorAll('img')).toHaveLength(1));
        expect(probe.cancelPhysical).not.toHaveBeenCalledWith(expect.objectContaining({
            requestId: pending[1].args.requestContext.requestId,
        }));
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('cuộn item chưa giao với viewport ra ngoài phải bỏ tham chiếu DOM của observer', async () => {
        const props = sidebarProps();
        const view = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(probe.observed.size).toBeGreaterThan(0);
        probe.visibleIds = ['thumb-copy-b'];
        view.rerender(<ThumbSidebar {...props} />);
        expect([...probe.observed].filter(element => !element.isConnected)).toHaveLength(0);
    });

    it('khi accurateColorEnabled bật: gọi render_ppe_page với priority 500 và pipeline accurate', async () => {
        const props = {
            ...sidebarProps(),
            pageOrder: [3],
            pageInstanceIds: ['page-3'],
            accurateColorEnabled: true,
            accurateColorProfileId: 'fogra39',
            accurateColorIntent: 'relative',
        };
        const view = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => {
            const call = probe.invoke.mock.calls.find(([command]) => command === 'render_ppe_page');
            expect(call).toBeDefined();
            expect(call![1]).toMatchObject({
                filePath: 'D:\\test.pdf',
                page: 3,
                sessionOwnerId: expect.any(String),
                requestContext: expect.objectContaining({
                    priority: 500,
                    purpose: 'accurate',
                    pipelineIdentity: 'ppe-fogra39-relative-view-knockout-png-v5-native-worker',
                }),
            });
        });
        await finishRequests();
        await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(1));
    });

    it('khi render_ppe_page lỗi: tự động fallback về render_pdf_page', async () => {
        probe.invoke.mockImplementation((command: string, args: RenderArgs) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error('PPE capability missing'));
            }
            if (command === 'render_pdf_page') {
                return new Promise<ArrayBuffer>(resolve => pending.push({ args, resolve }));
            }
            return Promise.resolve(true);
        });
        const props = {
            ...sidebarProps(),
            pageOrder: [3],
            pageInstanceIds: ['page-3'],
            accurateColorEnabled: true,
        };
        const view = render(<ThumbSidebar {...props} />);
        fireEvent(window, new Event('prynx-main-tile-ready'));
        await waitFor(() => {
            const call = probe.invoke.mock.calls.find(([command]) => command === 'render_pdf_page');
            expect(call).toBeDefined();
            expect(call![1]).toMatchObject({
                filePath: 'D:\\test.pdf',
                page: 3,
            });
        });
        await finishRequests();
        await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(1));
    });
});
