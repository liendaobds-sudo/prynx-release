// @vitest-environment jsdom

import React from 'react';
import ts from 'typescript';
import acrobatViewerSource from '../AcrobatViewer.tsx?raw';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbSidebar } from './ThumbSidebar';
import { nativeRenderCoordinator, renderPipelineIdentity } from '../../hooks/viewer/renderCoordinator';
import { CancelledTileRenderError, SupersededTileRenderError } from '../../hooks/viewer/tileRenderScheduler';
import type { ViewerFirstFrame } from '../../lib/viewerFirstFrame';
import type { TilePixelProof } from '../../lib/tileUrlCache';
import { createThumbnailRenderRequest, putThumbCache, thumbCacheRef } from '../workspace/thumbnailCache';

const probe = vi.hoisted(() => ({
    visibleIds: null as string[] | null,
    invoke: vi.fn(),
    cancelPhysical: vi.fn(),
    report: vi.fn(),
    observed: new Set<Element>(),
    firstFrame: null as ViewerFirstFrame | null,
    firstFrameListeners: new Set<() => void>(),
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
vi.mock('../../lib/viewerFirstFrame', () => ({
    peekViewerFirstFrame: (path: string | null, token: string | null) => (
        probe.firstFrame?.nativePath === path && probe.firstFrame?.documentToken === token
            ? probe.firstFrame : null
    ),
    subscribeViewerFirstFrame: (_path: string | null, listener: () => void) => {
        probe.firstFrameListeners.add(listener);
        return () => probe.firstFrameListeners.delete(listener);
    },
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
type RenderArgs = { dpi?: number; requestContext: { requestId: string; ownerId: string; groupKey: string; pipelineIdentity: string } };
let pending: Array<{ command: string; args: RenderArgs; resolve: (bytes: ArrayBuffer) => void; reject: (error: unknown) => void }>;
const unsupportedError = (reason = 'knockout_transparency') => new Error(
    `PPE_NATIVE_UNSUPPORTED:${JSON.stringify({ reason, detail: 'PPE chưa dựng exact.' })}`,
);

function queueNativeRender(command: string, args: RenderArgs): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => pending.push({ command, args, resolve, reject }));
}

function accurateSidebarProps(): Props {
    return { ...sidebarProps(), pageOrder: [3], pageInstanceIds: ['page-3'], accurateColorEnabled: true, allowCompatibilityPreview: true };
}

function matchingFirstFrame(): ViewerFirstFrame {
    return {
        nativePath: 'D:\\test.pdf', documentToken: '3:10:20', page: 1,
        dpi: 96, renderScale: 1, width: 816, height: 1056,
        profileId: 'fogra39', intent: 'relative',
        proofIdentity: 'show:all|paper:0|black:0|background:profile',
        url: 'blob:borrowed-first-frame', byteLength: 8,
        proof: {
            engine: 'ppe-native', soundness: 'color-verified', documentToken: '3:10:20', page: 1,
            profileId: 'fogra39', intent: 'relative',
            proofIdentity: 'show:all|paper:0|black:0|background:profile',
            pipelineIdentity: renderPipelineIdentity('accurate'),
        },
    };
}

function mainTileReady(): void {
    fireEvent(window, new Event('prynx-main-tile-ready'));
}

async function publishFirstFrame(frame: ViewerFirstFrame | null): Promise<void> {
    await act(async () => {
        probe.firstFrame = frame;
        for (const listener of probe.firstFrameListeners) listener();
    });
}

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
        probe.firstFrame = null;
        probe.firstFrameListeners.clear();
        thumbCacheRef.current.clear();
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
            return queueNativeRender(command, args);
        });
    });
    afterEach(async () => {
        cleanup();
        await finishRequests();
        thumbCacheRef.current.clear();
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
        const encoded = vi.spyOn(nativeRenderCoordinator, 'markEncoded');
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
                    pipelineIdentity: 'ppe-fogra39-relative-view-knockout-png-v6-native-worker',
                }),
            });
        });
        await finishRequests();
        await waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(1));
        expect(encoded).toHaveBeenCalledWith(expect.objectContaining({ proof: {
            engine: 'ppe-native', soundness: 'color-verified', documentToken: '3:10:20', page: 3,
            profileId: 'fogra39', intent: 'relative',
            proofIdentity: 'show:all|paper:0|black:0|background:profile',
            pipelineIdentity: renderPipelineIdentity('accurate'),
        } }));
    });

    it('capability PPE từ chối: tạo request display riêng, không gắn proof accurate cho pixel PDFium', async () => {
        const routing = vi.spyOn(nativeRenderCoordinator, 'renderPng');
        const encoded = vi.spyOn(nativeRenderCoordinator, 'markEncoded');
        probe.invoke.mockImplementation((command: string, args: RenderArgs) => {
            if (command === 'render_ppe_page') {
                return Promise.reject(new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency","detail":"PPE chưa dựng exact."}'));
            }
            if (command === 'render_pdf_page') {
                return queueNativeRender(command, args);
            }
            return Promise.resolve(true);
        });
        const props = {
            ...sidebarProps(),
            pageOrder: [3],
            pageInstanceIds: ['page-3'],
            accurateColorEnabled: true,
            allowCompatibilityPreview: true,
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
        expect(routing).toHaveBeenCalledTimes(2);
        const accurateArgs = probe.invoke.mock.calls.find(([command]) => command === 'render_ppe_page')![1];
        const displayArgs = probe.invoke.mock.calls.find(([command]) => command === 'render_pdf_page')![1];
        expect(displayArgs.requestContext.requestId).not.toBe(accurateArgs.requestContext.requestId);
        expect(routing.mock.calls[1][0]).toMatchObject({
            bypassScheduler: false,
            request: {
                priority: 500,
                color: { pipeline: 'display', profileId: null, intent: null },
                soundness: 'display-preview',
                pipelineIdentity: renderPipelineIdentity('display'),
            },
        });
        expect(encoded).toHaveBeenCalledWith(expect.objectContaining({ proof: {
            engine: 'pdfium', soundness: 'display-preview', documentToken: '3:10:20', page: 3,
            profileId: null, intent: null, proofIdentity: 'display',
            pipelineIdentity: renderPipelineIdentity('display'),
        } }));
        expect(probe.report).toHaveBeenCalledWith('result', expect.objectContaining({
            request_id: accurateArgs.requestContext.requestId, status: 'render-error',
        }));
        expect(probe.report).toHaveBeenCalledWith('result', expect.objectContaining({
            request_id: displayArgs.requestContext.requestId, status: 'ready',
        }));
    });

    it.each([
        ['lỗi chung', new Error('PPE capability missing')],
        ['hết RAM', new Error('PPE_MEMORY_BUDGET: vượt ngân sách RAM')],
        ['I/O', new Error('Không đọc được file PDF')],
        ['transport', new Error('IPC channel closed')],
        ['hủy', new CancelledTileRenderError()],
        ['bị thay thế', new SupersededTileRenderError()],
        ['AbortError', Object.assign(unsupportedError(), { name: 'AbortError' })],
        ['hủy mang prefix capability', Object.assign(unsupportedError(), { name: 'CancelledTileRenderError' })],
        ['JSON hỏng', new Error('PPE_NATIVE_UNSUPPORTED:{')],
        ['thiếu detail', new Error('PPE_NATIVE_UNSUPPORTED:{"reason":"knockout_transparency"}')],
        ['reason không biết', unsupportedError('memory_budget')],
        ['prefix nằm giữa lỗi', new Error(`Native lỗi: ${unsupportedError().message}`)],
    ])('%s không được fallback PDFium', async (_label, error) => {
        const view = render(<ThumbSidebar {...accurateSidebarProps()} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending[0].reject(error); });
        expect(probe.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page')).toHaveLength(0);
        expect(view.container.querySelector('img')).toBeNull();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it.each([
        'image_codec', 'knockout_transparency', 'unsupported_transparency', 'color_approximation',
        'geometry_approximation', 'hidden_content', 'unsupported_feature',
    ])('chỉ capability đã nhận biết %s được mở display request mới', async reason => {
        const view = render(<ThumbSidebar {...accurateSidebarProps()} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending[0].reject(unsupportedError(reason)); });
        await waitFor(() => expect(pending).toHaveLength(2));
        expect(pending.map(task => task.command)).toEqual(['render_ppe_page', 'render_pdf_page']);
        expect(pending[1].args.requestContext.requestId).not.toBe(pending[0].args.requestContext.requestId);
        await finishRequests();
        await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    });

    it.each([false, undefined])('strict/không cấp quyền (%s) giữ fail-closed dù capability hợp lệ', async allowCompatibilityPreview => {
        const view = render(<ThumbSidebar {...accurateSidebarProps()} allowCompatibilityPreview={allowCompatibilityPreview} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending[0].reject(unsupportedError()); });
        expect(probe.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page')).toHaveLength(0);
        expect(view.container.querySelector('img')).toBeNull();
        expect(view.container.querySelector('.acro-thumb-item button')).not.toBeNull();
    });

    it.each(['revision', 'profile', 'strict', 'background', 'unmount'] as const)(
        'PPE từ chối muộn sau %s không được mở fallback', async transition => {
            const props = accurateSidebarProps();
            const view = render(<ThumbSidebar {...props} />);
            mainTileReady();
            await waitFor(() => expect(pending).toHaveLength(1));
            if (transition === 'unmount') view.unmount();
            else view.rerender(<ThumbSidebar {...props}
                renderDocumentToken={transition === 'revision' ? '3:11:20' : props.renderDocumentToken}
                accurateColorProfileId={transition === 'profile' ? 'swop' : 'fogra39'}
                allowCompatibilityPreview={transition !== 'strict'}
                isViewerActive={transition !== 'background'}
            />);
            await act(async () => { pending[0].reject(unsupportedError()); });
            expect(probe.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page')).toHaveLength(0);
            expect(URL.createObjectURL).not.toHaveBeenCalled();
        },
    );

    it.each(['success', 'unsupported'] as const)('A→B→A: response %s của A đầu không được nhận vào A mới', async outcome => {
        const props = accurateSidebarProps();
        const routing = vi.spyOn(nativeRenderCoordinator, 'renderPng');
        const view = render(<ThumbSidebar {...props} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        view.rerender(<ThumbSidebar {...props} renderDocumentToken="3:11:20" />);
        await waitFor(() => expect(pending).toHaveLength(2));
        view.rerender(<ThumbSidebar {...props} />);
        await waitFor(() => expect(pending).toHaveLength(3));
        expect(routing.mock.calls[2][0].request.generationKey).not.toBe(routing.mock.calls[0][0].request.generationKey);
        await act(async () => {
            if (outcome === 'success') pending[0].resolve(new ArrayBuffer(8));
            else pending[0].reject(unsupportedError());
        });
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(probe.invoke.mock.calls.filter(([command]) => command === 'render_pdf_page')).toHaveLength(0);
        await act(async () => { pending[2].resolve(new ArrayBuffer(8)); });
        await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('A→B→A: URL A đã revoke không tái xuất hiện trong lúc chờ A mới', async () => {
        const props = accurateSidebarProps();
        const view = render(<ThumbSidebar {...props} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await finishRequests();
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1'));
        view.rerender(<ThumbSidebar {...props} renderDocumentToken="3:11:20" />);
        expect(view.container.querySelector('img')).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1');
        view.rerender(<ThumbSidebar {...props} />);
        expect(view.container.querySelector('img')).toBeNull();
        await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));
        await finishRequests();
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-2'));
    });

    it('bật strict xóa ảnh tương thích ngay, và không hạ cấp khi PPE tiếp tục từ chối', async () => {
        const props = accurateSidebarProps();
        const view = render(<ThumbSidebar {...props} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending[0].reject(unsupportedError()); });
        await waitFor(() => expect(pending).toHaveLength(2));
        await act(async () => { pending[1].resolve(new ArrayBuffer(8)); });
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1'));
        view.rerender(<ThumbSidebar {...props} allowCompatibilityPreview={false} />);
        expect(view.container.querySelector('img')).toBeNull();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb-1');
        await waitFor(() => expect(pending).toHaveLength(3));
        await act(async () => { pending[2].reject(unsupportedError()); });
        expect(pending.map(task => task.command)).toEqual(['render_ppe_page', 'render_pdf_page', 'render_ppe_page']);
        expect(view.container.querySelector('img')).toBeNull();
    });

    it('display fallback lỗi vẫn có nút thử lại và request mới có thể hồi phục', async () => {
        const view = render(<ThumbSidebar {...accurateSidebarProps()} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending[0].reject(unsupportedError()); });
        await waitFor(() => expect(pending).toHaveLength(2));
        await act(async () => { pending[1].reject(new Error('Worker đang khởi động lại')); });
        const retry = view.container.querySelector('.acro-thumb-item button');
        expect(retry).not.toBeNull();
        fireEvent.click(retry!);
        await waitFor(() => expect(pending).toHaveLength(3));
        expect(pending[2].args.requestContext.requestId).not.toBe(pending[0].args.requestContext.requestId);
        await act(async () => { pending[2].resolve(new ArrayBuffer(8)); });
        await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    });

    it('display đã encode nhưng chưa commit: đổi strict vẫn phải discard và revoke đúng một lần', async () => {
        const actualRender = nativeRenderCoordinator.renderPng.bind(nativeRenderCoordinator);
        let releaseSource!: () => void;
        const sourceBarrier = new Promise<void>(resolve => { releaseSource = resolve; });
        vi.spyOn(nativeRenderCoordinator, 'renderPng').mockImplementation(async options => {
            const source = await actualRender(options);
            if (source.proof?.engine === 'pdfium') await sourceBarrier;
            return source;
        });
        const props = accurateSidebarProps();
        const view = render(<ThumbSidebar {...props} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending[0].reject(unsupportedError()); });
        await waitFor(() => expect(pending).toHaveLength(2));
        await act(async () => { pending[1].resolve(new ArrayBuffer(8)); });
        await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
        view.rerender(<ThumbSidebar {...props} allowCompatibilityPreview={false} />);
        await act(async () => { releaseSource(); });
        expect(view.container.querySelector('img')).toBeNull();
        expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([['blob:thumb-1']]);
        await waitFor(() => expect(pending).toHaveLength(3));
        await act(async () => { pending[2].resolve(new ArrayBuffer(8)); });
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-2'));
    });

    it('chuẩn hóa FOGRA39/Relative và ghi raster DPI trùng tham số native thực', async () => {
        const routing = vi.spyOn(nativeRenderCoordinator, 'renderPng');
        render(<ThumbSidebar {...accurateSidebarProps()} accurateColorProfileId=" FOGRA39 " accurateColorIntent=" Relative " />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        expect(pending[0].command).toBe('render_ppe_page');
        expect(routing.mock.calls[0][0].request).toMatchObject({
            raster: { kind: 'dpi', dpi: pending[0].args.dpi, clip: null },
            color: { pipeline: 'accurate', profileId: 'fogra39', intent: 'relative' },
        });
    });

    it.each([['swop', 'relative'], ['fogra39', 'perceptual'], [' FOGRA39 ', ' SATURATION ']])(
        'native không giả proof cho hồ sơ %s / %s và không tự chuyển display', async (profile, intent) => {
            const view = render(<ThumbSidebar {...accurateSidebarProps()} accurateColorProfileId={profile} accurateColorIntent={intent} />);
            mainTileReady();
            await waitFor(() => expect(view.container.querySelector('.acro-thumb-item button')).not.toBeNull());
            expect(pending).toHaveLength(0);
            expect(URL.createObjectURL).not.toHaveBeenCalled();
        },
    );

    it('first-frame đúng proof được mượn, thumbnail không revoke URL của chủ khác', async () => {
        probe.firstFrame = matchingFirstFrame();
        const view = render(<ThumbSidebar {...accurateSidebarProps()} pageOrder={[1]} />);
        mainTileReady();
        expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:borrowed-first-frame');
        expect(pending).toHaveLength(0);
        view.unmount();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        expect(probe.firstFrameListeners.size).toBe(0);
    });

    it.each([
        ['nguồn PDFium', { engine: 'pdfium' }],
        ['nguồn PPE-http', { engine: 'ppe-http' }],
        ['soundness', { soundness: 'display-preview' }],
        ['token', { documentToken: '3:9:20' }],
        ['trang', { page: 2 }],
        ['hồ sơ', { profileId: 'swop' }],
        ['intent', { intent: 'perceptual' }],
        ['proof filter', { proofIdentity: 'show:cyan|paper:0|black:0|background:profile' }],
        ['pipeline', { pipelineIdentity: 'ppe-legacy' }],
    ] satisfies Array<[string, Partial<TilePixelProof>]>)('first-frame lệch %s không được chặn request PPE mới', async (_label, mismatch) => {
        const frame = matchingFirstFrame();
        frame.proof = { ...frame.proof!, ...mismatch };
        probe.firstFrame = frame;
        const view = render(<ThumbSidebar {...accurateSidebarProps()} pageOrder={[1]} />);
        mainTileReady();
        expect(view.container.querySelector('img')).toBeNull();
        await waitFor(() => expect(pending).toHaveLength(1));
        expect(pending[0].command).toBe('render_ppe_page');
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(frame.url);
    });

    it('first-frame thiếu proof không đủ bằng chứng dù metadata bên ngoài đúng', async () => {
        probe.firstFrame = { ...matchingFirstFrame(), proof: undefined };
        const view = render(<ThumbSidebar {...accurateSidebarProps()} pageOrder={[1]} />);
        mainTileReady();
        expect(view.container.querySelector('img')).toBeNull();
        await waitFor(() => expect(pending).toHaveLength(1));
    });

    it.each(['TTL', 'adopt', 'release'])('first-frame bị lấy khỏi kho (%s) sẽ render lại nhờ subscription', async () => {
        probe.firstFrame = matchingFirstFrame();
        const view = render(<ThumbSidebar {...accurateSidebarProps()} pageOrder={[1]} />);
        mainTileReady();
        expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:borrowed-first-frame');
        await publishFirstFrame(null);
        expect(view.container.querySelector('img')).toBeNull();
        await waitFor(() => expect(pending).toHaveLength(1));
        await finishRequests();
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1'));
        view.unmount();
        expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([['blob:thumb-1']]);
    });

    it('first-frame đến trong lúc PPE chạy sẽ hủy request riêng nhưng không nhận response muộn', async () => {
        const view = render(<ThumbSidebar {...accurateSidebarProps()} pageOrder={[1]} />);
        mainTileReady();
        await waitFor(() => expect(pending).toHaveLength(1));
        await publishFirstFrame(matchingFirstFrame());
        expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:borrowed-first-frame');
        await finishRequests();
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        await publishFirstFrame(null);
        await waitFor(() => expect(pending).toHaveLength(2));
        await finishRequests();
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1'));
    });

    it('cache URL PDF.js không proof không được thay thế native accurate thumbnail', async () => {
        const props = accurateSidebarProps();
        const key = createThumbnailRenderRequest({
            revision: `${props.pdfUrl}|${props.renderDocumentToken}`, pageNum: 3,
            cssWidth: props.thumbBaseWidth, devicePixelRatio: window.devicePixelRatio,
            profileId: 'fogra39', intent: 'relative',
        }).cacheKey;
        putThumbCache(key, 'data:image/jpeg;base64,dW50cnVzdGVk');
        const view = render(<ThumbSidebar {...props} />);
        mainTileReady();
        expect(view.container.querySelector('img')).toBeNull();
        await waitFor(() => expect(pending).toHaveLength(1));
        expect(pending[0].command).toBe('render_ppe_page');
        await finishRequests();
        await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb-1'));
    });

    it('AcrobatViewer truyền policy strict vào thumbnail cho Output Preview/CMYK tay/PPE-only', () => {
        const ast = ts.createSourceFile('AcrobatViewer.tsx', acrobatViewerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const expressions = new Map<string, string>();
        const visit = (node: ts.Node) => {
            if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'ThumbSidebar') {
                for (const prop of node.attributes.properties) {
                    if (ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer)
                        && prop.initializer.expression) expressions.set(prop.name.getText(ast), prop.initializer.expression.getText(ast));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(ast);
        const evaluate = (name: string, mode: string, accurate: boolean, strict: boolean): boolean => {
            expect(expressions.has(name)).toBe(true);
            return new Function('viewerEngineMode', 'accurateColorEnabled', 'strictViewerProofRequired',
                `return (${expressions.get(name)});`)(mode, accurate, strict) as boolean;
        };
        for (const mode of ['current', 'hybrid', 'ppe-only']) {
            for (const strict of [false, true]) {
                expect(evaluate('allowCompatibilityPreview', mode, false, strict)).toBe(!strict && mode !== 'ppe-only');
                expect(evaluate('accurateColorEnabled', mode, false, strict)).toBe(strict || mode !== 'current');
                expect(evaluate('accurateColorEnabled', mode, true, strict)).toBe(true);
            }
        }
    });
});
