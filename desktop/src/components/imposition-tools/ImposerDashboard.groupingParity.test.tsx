// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ImposerDashboard from './ImposerDashboard';
import type GridPreview from './sections/GridPreview';
import {
    createImposerSettingsStore,
    ImposerSettingsContext,
} from './useImposerSettingsStore';
import type { ActiveToolType, NupSettings, TaskMode } from './types';

type PreviewProps = React.ComponentProps<typeof GridPreview>;

const mocks = vi.hoisted(() => ({
    preview: vi.fn(),
    autoRoute: vi.fn(),
    fetch: vi.fn(),
    upload: vi.fn(),
    tempDir: vi.fn(),
    pathJoin: vi.fn(),
    writeFile: vi.fn(),
    savedForms: [],
    t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key,
}));

const workspace = vi.hoisted(() => ({
    file: null as (File & { path?: string }) | null,
    isProcessing: false,
    error: null,
    viewerPageOrder: [1, 2],
    viewerPageInstanceIds: ['trang-1', 'trang-2'],
    viewerPageRotations: [0, 0],
    viewerNumPages: 2,
    viewerActivePage: 1,
    detectedShapeType: 'PENTAGON',
    detectedShapeParams: '{}',
    detectedShapesByPage: { 0: 'PENTAGON', 1: 'HEXAGON' } as Record<number, string>,
    detectedDimensionsByPage: { 0: { w: 100, h: 100 }, 1: { w: 100, h: 100 } },
    detectedShapeParamsByPage: { 0: {}, 1: {} },
    pdfUrl: null,
    selectionFileId: 'grouping-parity-pdf',
    hiddenOcgLayerIds: [],
    ocgVisibilityProvenance: { intent: 'default' },
    setHighlightedIssue: vi.fn(),
    setShowOutputPreview: vi.fn(),
    setDetectedShapeType: vi.fn(),
    setDetectedShapeParams: vi.fn(),
    setDetectedShapesByPage: vi.fn(),
    setDetectedDimensionsByPage: vi.fn(),
    setDetectedShapeParamsByPage: vi.fn(),
    setSelectionFileId: vi.fn(),
}));

vi.mock('../../stores/useWorkspaceStore', () => ({
    useWorkspaceStore: (selector: (state: typeof workspace) => unknown) => selector(workspace),
    workspaceOcgVisibilityFingerprint: () => 'default',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../../hooks/useToolActivationGuard', () => ({
    useWorkspaceToolActivationGuard: () => (_tool: string, activate: () => void) => activate(),
}));
vi.mock('../../lib/api', () => ({
    authenticatedFetch: (...args: unknown[]) => mocks.fetch(...args),
    getApiUrl: () => 'http://127.0.0.1:8321/api',
    uploadPDF: (...args: unknown[]) => mocks.upload(...args),
}));
vi.mock('@tauri-apps/api/path', () => ({ tempDir: mocks.tempDir, join: mocks.pathJoin }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: mocks.writeFile }));
vi.mock('../../lib/previewPerfLog', () => ({ previewPerfLog: vi.fn() }));
vi.mock('./trueShapeNestingRollout', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./trueShapeNestingRollout')>();
    return {
        ...actual,
        TRUE_SHAPE_NESTING_ENABLED: true,
        shouldUseTrueShapeNesting: (intent: Parameters<typeof actual.shouldUseTrueShapeNesting>[0]) => {
            const result = actual.shouldUseTrueShapeNesting(intent);
            mocks.autoRoute(intent, result);
            return result;
        },
    };
});
vi.mock('./usePaperPresets', () => ({
    usePaperPresets: () => ({
        savedForms: mocks.savedForms,
        handleSavePreset: vi.fn(),
        handleUpdatePreset: vi.fn(),
        handleDeletePreset: vi.fn(),
    }),
}));
vi.mock('./sections/GridPreview', () => ({
    default: (props: PreviewProps) => { mocks.preview(props); return null; },
}));
vi.mock('./sections/GridSettingsSection', () => ({ default: () => null }));
vi.mock('./sections/AdvancedSettingsSection', () => ({ default: () => null }));
vi.mock('./sections/BookletSettingsSection', () => ({ default: () => null }));
vi.mock('./sections/AutoCatalogSection', () => ({ default: () => null }));
vi.mock('./sections/PreprocessingRouter', () => ({ default: () => null }));
vi.mock('./PaperSettingsUI', () => ({ PaperSettingsDialog: () => null }));
vi.mock('./PaperSizeSelect', () => ({ default: () => null }));
vi.mock('./MarksSettingsDialog', () => ({ MarksSettingsDialog: () => null }));
vi.mock('./PontSettingsDialog', () => ({ PontSettingsDialog: () => null }));
vi.mock('./ToolMenuList', () => ({ default: () => null }));
vi.mock('./PresetSelector', () => ({ default: () => null }));
vi.mock('./ProductFirstPanel', () => ({ default: () => null }));
vi.mock('../flipbook/FlipbookDialog', () => ({ FlipbookDialog: () => null }));
vi.mock('../flipbook/SheetViewerDialog', () => ({ SheetViewerDialog: () => null }));
vi.mock('../preprocess-tools/MergeTool', () => ({ default: () => null }));

function lastPreview(): PreviewProps {
    const props = mocks.preview.mock.lastCall?.[0] as PreviewProps | undefined;
    if (!props) throw new Error('Dashboard chưa truyền props xuống preview');
    return props;
}

function batchBodies(): Array<{ grouping_strategy: string }> {
    return mocks.fetch.mock.calls
        .filter(([url]) => String(url).endsWith('/preview-layouts-batch'))
        .map(([, options]) => JSON.parse((options as RequestInit).body as string));
}

function batchRequests(): RequestInit[] {
    return mocks.fetch.mock.calls
        .filter(([url]) => String(url).endsWith('/preview-layouts-batch'))
        .map(([, options]) => options as RequestInit);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function batchResponse(capacities: Record<number, number>) {
    return { ok: true, json: async () => ({ success: true, capacities }) };
}

function holdBatchResponses() {
    const fallback = mocks.fetch.getMockImplementation()!;
    const pending: ReturnType<typeof deferred<ReturnType<typeof batchResponse>>>[] = [];
    mocks.fetch.mockImplementation((url: string, options?: RequestInit) => {
        if (!url.endsWith('/preview-layouts-batch')) return fallback(url, options);
        const response = deferred<ReturnType<typeof batchResponse>>();
        pending.push(response);
        return response.promise;
    });
    return pending;
}

async function settleDashboard() {
    // Chờ metadata/detect rồi mới chạy debounce batch 350 ms của Dashboard thật.
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}

function mountDashboard(
    activeTool: ActiveToolType,
    taskMode: TaskMode,
    groupingStrategy: NupSettings['groupingStrategy'] = 'maximize_area',
    markType: NupSettings['markType'] = 'guillotine',
    options: { isActive?: boolean; readWorkingFile?: () => Promise<File>; tabId?: string } = {},
) {
    const tabId = options.tabId ?? 'grouping-parity';
    const store = createImposerSettingsStore(`${tabId}-${activeTool}`);
    store.setState({
        activeDashboardTool: activeTool,
        taskMode,
        layoutType: taskMode === 'step_repeat' ? 'repeat' : 'sequential',
        groupingStrategy,
        markType,
        gridStrategy: 'optimal_auto',
        formsize: 'custom',
        customSheetWidth: 320,
        customSheetHeight: 430,
        pontType: 'none',
        targetQuantitiesByPage: { 0: 100, 1: 100 },
        toolProfiles: {
            [activeTool]: { taskMode: 'nup', groupingStrategy, layoutType: 'sequential' },
        },
    });
    const onStartNup = vi.fn<(settings: NupSettings) => void>();
    const readWorkingFile = vi.fn(options.readWorkingFile ?? (async () => workspace.file!));
    const dashboard = (isActive: boolean) => (
        <ImposerSettingsContext.Provider value={store}>
            <ImposerDashboard
                tabId={tabId}
                isActive={isActive}
                onStartBooklet={vi.fn()}
                onStartNup={onStartNup}
                getWorkingFile={readWorkingFile}
            />
        </ImposerSettingsContext.Provider>
    );
    const view = render(dashboard(options.isActive ?? true));
    return {
        store,
        onStartNup,
        readWorkingFile,
        setActive: (isActive: boolean) => view.rerender(dashboard(isActive)),
        unmount: view.unmount,
    };
}

function executeWithAppliedPreview() {
    const props = lastPreview();
    act(() => props.onDiagnosticEvent?.({
        traceId: props.diagnosticTraceId!,
        requestId: 'preview-grouping-parity',
        generation: 1,
        phase: 'applied',
        capacity: 32,
        forceLegacyGrid: false,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'preprocess.common:run' }));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    workspace.file = Object.assign(new File([], 'grouping-parity.pdf', { type: 'application/pdf' }), {
        path: 'D:\\pdfcompare\\test\\grouping-parity.pdf',
    });
    workspace.detectedShapesByPage = { 0: 'PENTAGON', 1: 'HEXAGON' };
    mocks.upload.mockResolvedValue({ id: 'working-batch-id' });
    mocks.tempDir.mockResolvedValue('D:\\Temp\\');
    mocks.pathJoin.mockImplementation(async (directory: string, filename: string) => directory + filename);
    mocks.writeFile.mockResolvedValue(undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ pages: [
            { width_pt: 100, height_pt: 100 },
            { width_pt: 100, height_pt: 100 },
        ] }),
    })));
    mocks.fetch.mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => url.endsWith('/detect-shape')
            ? {
                shapes: Object.values(workspace.detectedShapesByPage),
                dimensions: Object.values(workspace.detectedDimensionsByPage),
                shapeParams: [{}, {}],
                hasValidDie: true,
            }
            : { success: true, capacities: { 0: 32, 1: 30 } },
    }));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('PV26.1: grouping hiệu lực thống nhất preview, bảng sức chứa và export', () => {
    it.each(['sticker_imposer', 'cnc_imposer', 'nup'] as const)(
        '%s Bình trang bỏ grouping ẩn nhưng không ghi đè profile Dàn nhiều mẫu',
        async (tool) => {
            const { store, onStartNup } = mountDashboard(tool, 'step_repeat');
            const savedProfile = { ...store.getState().toolProfiles[tool] };
            await settleDashboard();

            expect(lastPreview().groupingStrategy).toBe('none');
            expect(batchBodies()).not.toHaveLength(0);
            expect(batchBodies().every((body) => body.grouping_strategy === 'none')).toBe(true);
            expect(mocks.autoRoute.mock.lastCall?.[0].groupingStrategy).toBe('none');
            executeWithAppliedPreview();
            expect(onStartNup).toHaveBeenCalledWith(expect.objectContaining({
                taskMode: 'step_repeat', layoutType: 'repeat', groupingStrategy: 'none',
            }));
            expect(store.getState().groupingStrategy).toBe('maximize_area');
            expect(store.getState().toolProfiles[tool]).toEqual(savedProfile);
        },
    );

    it.each(['sticker_imposer', 'cnc_imposer'] as const)(
        '%s Bình trang có CUSTOM vào nesting và không khởi động batch lưới trùng',
        async (tool) => {
            workspace.detectedShapesByPage = { 0: 'PENTAGON', 1: 'CUSTOM' };
            mountDashboard(tool, 'step_repeat');
            await settleDashboard();

            expect(mocks.autoRoute.mock.lastCall).toEqual([
                expect.objectContaining({ groupingStrategy: 'none', taskMode: 'step_repeat' }),
                true,
            ]);
            expect(lastPreview().groupingStrategy).toBe('none');
            expect(batchBodies()).toHaveLength(0);
        },
    );

    it.each([
        ['sticker_imposer', 'strict_ratio'],
        ['cnc_imposer', 'cluster_tile'],
        ['nup', 'free_gang'],
    ] as const)('%s Dàn nhiều mẫu giữ grouping %s', async (tool, grouping) => {
        const { store, onStartNup } = mountDashboard(tool, 'nup', grouping);
        await settleDashboard();

        expect(lastPreview().groupingStrategy).toBe(grouping);
        expect(batchBodies()).not.toHaveLength(0);
        expect(batchBodies().every((body) => body.grouping_strategy === grouping)).toBe(true);
        executeWithAppliedPreview();
        expect(onStartNup).toHaveBeenCalledWith(expect.objectContaining({ groupingStrategy: grouping }));
        expect(store.getState().groupingStrategy).toBe(grouping);
    });

    it('N-Up không mark xén tiếp tục bỏ grouping không áp dụng', async () => {
        const { store, onStartNup } = mountDashboard('nup', 'nup', 'strict_ratio', 'none');
        await settleDashboard();

        expect(lastPreview().groupingStrategy).toBe('none');
        expect(batchBodies()).not.toHaveLength(0);
        expect(batchBodies().every((body) => body.grouping_strategy === 'none')).toBe(true);
        executeWithAppliedPreview();
        expect(onStartNup).toHaveBeenCalledWith(expect.objectContaining({ groupingStrategy: 'none' }));
        expect(store.getState().groupingStrategy).toBe('strict_ratio');
    });

    it.each(['sticker_imposer', 'cnc_imposer'] as const)(
        '%s trở lại Dàn nhiều mẫu phục hồi grouping đã chọn',
        async (tool) => {
            const { store } = mountDashboard(tool, 'step_repeat', 'strict_ratio');
            await settleDashboard();
            expect(lastPreview().groupingStrategy).toBe('none');
            act(() => store.getState().setTaskMode('nup'));
            await settleDashboard();
            expect(lastPreview().groupingStrategy).toBe('strict_ratio');
            expect(store.getState().toolProfiles[tool].groupingStrategy).toBe('strict_ratio');
            expect(batchBodies().at(-1)?.grouping_strategy).toBe('strict_ratio');
        },
    );

    it('Bình trang không xóa sức chứa hoặc gọi lại batch khi chỉ đổi grouping ẩn', async () => {
        const { store } = mountDashboard('cnc_imposer', 'step_repeat');
        await settleDashboard();
        const epoch = store.getState().fetchEpoch;
        const capacities = store.getState().previewCapacities;
        const requestCount = batchBodies().length;

        act(() => store.getState().setGroupingStrategy('cluster_tile'));
        await settleDashboard();

        expect(lastPreview().groupingStrategy).toBe('none');
        expect(store.getState().fetchEpoch).toBe(epoch);
        expect(store.getState().previewCapacities).toEqual(capacities);
        expect(batchBodies()).toHaveLength(requestCount);
        expect(store.getState().groupingStrategy).toBe('cluster_tile');
    });
});

describe('TEMPERF.2: batch sức chứa chỉ thuộc lượt còn hiệu lực của tab hiện tại', () => {
    it('tab nền không resolve nguồn hoặc phát batch sau debounce', async () => {
        const { readWorkingFile } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            isActive: false,
        });
        await settleDashboard();

        expect(readWorkingFile).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(0);
    });

    it('chuyển ra nền trước debounce thì không bắt đầu resolve nguồn', async () => {
        const { readWorkingFile, setActive } = mountDashboard('sticker_imposer', 'step_repeat');
        await act(async () => {});
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });

        setActive(false);
        await settleDashboard();

        expect(readWorkingFile).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(0);
    });

    it('nguồn resolve muộn sau khi ra nền không bị đọc bytes hoặc gửi batch', async () => {
        const working = deferred<File>();
        const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
        const bakedFile = Object.assign(new File([], 'working.pdf'), { arrayBuffer });
        const { readWorkingFile, setActive } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: () => working.promise,
        });
        await settleDashboard();
        expect(readWorkingFile).toHaveBeenCalledTimes(1);

        setActive(false);
        await act(async () => { working.resolve(bakedFile); });

        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(0);
    });

    it('ra nền hủy HTTP đang chạy và không nhận kết quả muộn dù transport bỏ qua abort', async () => {
        const pending = holdBatchResponses();
        const { store, setActive } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();
        expect(pending).toHaveLength(1);
        act(() => store.getState().setPreviewCapacities({ 0: 19 }));

        setActive(false);
        expect(batchRequests()[0].signal?.aborted).toBe(true);
        expect(store.getState().previewCapacities).toEqual({ 0: 19 });
        await act(async () => { pending[0].resolve(batchResponse({ 0: 999, 1: 999 })); });

        expect(store.getState().previewCapacities).toEqual({ 0: 19 });
    });

    it('JSON cũ hoàn tất sau khi quay lại tab không ghi đè hoặc hủy lượt mới', async () => {
        const oldJson = deferred<{ success: boolean; capacities: Record<number, number> }>();
        const fallback = mocks.fetch.getMockImplementation()!;
        const newResponse = deferred<ReturnType<typeof batchResponse>>();
        let batchCount = 0;
        mocks.fetch.mockImplementation((url: string, options?: RequestInit) => {
            if (!url.endsWith('/preview-layouts-batch')) return fallback(url, options);
            batchCount += 1;
            return batchCount === 1
                ? Promise.resolve({ ok: true, json: () => oldJson.promise })
                : newResponse.promise;
        });
        const { store, setActive } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();

        setActive(false);
        expect(batchRequests()[0].signal?.aborted).toBe(true);
        setActive(true);
        await settleDashboard();
        expect(batchRequests()).toHaveLength(2);
        await act(async () => { oldJson.resolve({ success: true, capacities: { 0: 999 } }); });
        expect(store.getState().previewCapacities).toEqual({});
        expect(batchRequests()[1].signal?.aborted).toBe(false);

        await act(async () => { newResponse.resolve(batchResponse({ 0: 41, 1: 37 })); });
        expect(store.getState().previewCapacities).toEqual({ 0: 41, 1: 37 });
    });

    it('đóng tab hủy HTTP và không publication sau unmount', async () => {
        const pending = holdBatchResponses();
        const { store, unmount } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();
        act(() => store.getState().setPreviewCapacities({ 0: 19 }));

        unmount();
        expect(batchRequests()[0].signal?.aborted).toBe(true);
        await act(async () => { pending[0].resolve(batchResponse({ 0: 999 })); });

        expect(store.getState().previewCapacities).toEqual({ 0: 19 });
    });

    it('đổi cấu hình hủy ngay lượt cũ; chỉ lượt mới được ghi capacity sau reset', async () => {
        const pending = holdBatchResponses();
        const { store } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();
        act(() => store.getState().setPreviewCapacities({ 0: 19 }));

        act(() => store.getState().setGapX(store.getState().gapX + 1));
        expect(batchRequests()[0].signal?.aborted).toBe(true);
        expect(store.getState().previewCapacities).toEqual({});
        await settleDashboard();
        expect(pending).toHaveLength(2);
        await act(async () => { pending[1].resolve(batchResponse({ 1: 37 })); });
        await act(async () => { pending[0].resolve(batchResponse({ 0: 999 })); });

        expect(store.getState().previewCapacities).toEqual({ 1: 37 });
    });

    it('giữ capacity khi đổi tab; quay lại chỉ chạy một batch và không xóa cache lúc chờ', async () => {
        const { store, setActive } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();
        expect(batchRequests()).toHaveLength(1);
        const cached = store.getState().previewCapacities;
        expect(cached).toEqual({ 0: 32, 1: 30 });

        setActive(false);
        await settleDashboard();
        expect(batchRequests()).toHaveLength(1);
        expect(store.getState().previewCapacities).toBe(cached);
        setActive(true);
        expect(store.getState().previewCapacities).toBe(cached);
        await settleDashboard();

        expect(batchRequests()).toHaveLength(2);
        expect(store.getState().previewCapacities).toEqual(cached);
    });

    it('giữ key single-preview mới ghi trong lúc batch đang chạy', async () => {
        const pending = holdBatchResponses();
        const { store } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();
        act(() => store.getState().setPreviewCapacities({ 0: 19 }));

        await act(async () => { pending[0].resolve(batchResponse({ 1: 37 })); });

        expect(store.getState().previewCapacities).toEqual({ 0: 19, 1: 37 });
    });

    it('merge đọc capacity mới nhất cả khi single-preview ghi trong cùng microtask', async () => {
        const pending = holdBatchResponses();
        const { store } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();

        await act(async () => {
            store.getState().setPreviewCapacities({ 0: 19 });
            pending[0].resolve(batchResponse({ 1: 37 }));
        });

        expect(store.getState().previewCapacities).toEqual({ 0: 19, 1: 37 });
    });

    it('bytes resolve muộn sau khi ra nền không ghi PDF tạm', async () => {
        const bytes = deferred<ArrayBuffer>();
        const arrayBuffer = vi.fn(() => bytes.promise);
        const working = Object.assign(new File([], 'working.pdf'), { arrayBuffer });
        const { setActive } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: async () => working,
        });
        await settleDashboard();
        expect(arrayBuffer).toHaveBeenCalledTimes(1);

        setActive(false);
        await act(async () => { bytes.resolve(new ArrayBuffer(0)); });

        expect(mocks.tempDir).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(0);
    });

    it('thư mục tạm resolve muộn sau khi ra nền không bắt đầu ghi PDF', async () => {
        const directory = deferred<string>();
        mocks.tempDir.mockReturnValue(directory.promise);
        const working = Object.assign(new File([], 'working.pdf'), {
            arrayBuffer: async () => new ArrayBuffer(0),
        });
        const { setActive } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: async () => working,
        });
        await settleDashboard();
        expect(mocks.tempDir).toHaveBeenCalledTimes(1);

        setActive(false);
        await act(async () => { directory.resolve('D:\\Temp\\'); });

        expect(mocks.pathJoin).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(0);
    });

    it('ghi PDF tạm hoàn tất sau khi ra nền không phát batch', async () => {
        const writing = deferred<void>();
        mocks.writeFile.mockReturnValue(writing.promise);
        const working = Object.assign(new File([], 'working.pdf'), {
            arrayBuffer: async () => new ArrayBuffer(0),
        });
        const { setActive } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: async () => working,
        });
        await settleDashboard();
        expect(mocks.writeFile).toHaveBeenCalledTimes(1);

        setActive(false);
        await act(async () => { writing.resolve(); });

        expect(batchRequests()).toHaveLength(0);
    });

    it('upload web dùng signal của lượt hiện tại và ra nền không phát batch sau upload', async () => {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
        const uploading = deferred<{ id: string }>();
        mocks.upload.mockReturnValue(uploading.promise);
        const working = Object.assign(new File([], 'working.pdf'), {
            arrayBuffer: async () => new ArrayBuffer(0),
        });
        const { setActive } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: async () => working,
        });
        await settleDashboard();
        expect(mocks.upload).toHaveBeenCalledTimes(1);
        const signal = mocks.upload.mock.calls[0][1].signal as AbortSignal;
        expect(signal.aborted).toBe(false);

        setActive(false);
        expect(signal.aborted).toBe(true);
        await act(async () => { uploading.resolve({ id: 'nguon-cu' }); });

        expect(batchRequests()).toHaveLength(0);
    });

    it('tab active vẫn ghi nguồn bake một lần và batch dùng đúng path đã ghi', async () => {
        const working = Object.assign(new File([], 'working.pdf'), {
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        });
        const { store } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: async () => working,
        });
        await settleDashboard();

        expect(mocks.writeFile).toHaveBeenCalledTimes(1);
        expect(mocks.upload).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(1);
        const path = mocks.writeFile.mock.calls[0][0] as string;
        expect(path).toMatch(/^D:\\Temp\\prynx_batchcap_\d+\.pdf$/);
        expect(JSON.parse(batchRequests()[0].body as string).path).toBe(path);
        expect(store.getState().previewCapacities).toEqual({ 0: 32, 1: 30 });
    });

    it('tab active trên web upload và batch dùng cùng signal, đúng file_id', async () => {
        Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
        const working = Object.assign(new File([], 'working.pdf'), {
            arrayBuffer: async () => new ArrayBuffer(0),
        });
        const { store } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: async () => working,
        });
        await settleDashboard();

        expect(mocks.upload).toHaveBeenCalledTimes(1);
        expect(batchRequests()).toHaveLength(1);
        expect(batchRequests()[0].signal).toBe(mocks.upload.mock.calls[0][1].signal);
        expect(JSON.parse(batchRequests()[0].body as string).file_id).toBe('working-batch-id');
        expect(store.getState().previewCapacities).toEqual({ 0: 32, 1: 30 });
    });

    it('tắt preview hủy batch; chuyển tab khi đang tắt không khởi động lại', async () => {
        const pending = holdBatchResponses();
        const { store, setActive } = mountDashboard('sticker_imposer', 'step_repeat');
        await settleDashboard();
        act(() => store.getState().setPreviewCapacities({ 0: 19 }));

        fireEvent.click(screen.getByLabelText('Bật xem trước bố cục'));
        expect(batchRequests()[0].signal?.aborted).toBe(true);
        await act(async () => { pending[0].resolve(batchResponse({ 0: 999 })); });
        setActive(false);
        await settleDashboard();
        setActive(true);
        await settleDashboard();

        expect(batchRequests()).toHaveLength(1);
        expect(store.getState().previewCapacities).toEqual({ 0: 19 });
        fireEvent.click(screen.getByLabelText('Bật xem trước bố cục'));
        await settleDashboard();
        expect(batchRequests()).toHaveLength(2);
        await act(async () => { pending[1].resolve(batchResponse({ 1: 37 })); });
        expect(store.getState().previewCapacities).toEqual({ 0: 19, 1: 37 });
    });

    it('hai tab cùng công cụ chỉ tab active chạy; cleanup tab nền không hủy tab còn lại', async () => {
        const pending = holdBatchResponses();
        const foreground = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            tabId: 'foreground',
        });
        const background = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            tabId: 'background', isActive: false,
        });
        await settleDashboard();

        expect(foreground.readWorkingFile).toHaveBeenCalledTimes(1);
        expect(background.readWorkingFile).not.toHaveBeenCalled();
        expect(batchRequests()).toHaveLength(1);
        background.unmount();
        expect(batchRequests()[0].signal?.aborted).toBe(false);
        await act(async () => { pending[0].resolve(batchResponse({ 0: 32, 1: 30 })); });

        expect(foreground.store.getState().previewCapacities).toEqual({ 0: 32, 1: 30 });
        expect(background.store.getState().previewCapacities).toEqual({});
    });

    it('đổi nguồn trong lúc resolve chỉ phát batch cho revision mới', async () => {
        const oldWorking = deferred<File>();
        let resolveCount = 0;
        const { setActive } = mountDashboard('sticker_imposer', 'step_repeat', 'none', 'none', {
            readWorkingFile: () => ++resolveCount === 1 ? oldWorking.promise : Promise.resolve(workspace.file!),
        });
        await settleDashboard();
        const oldFile = workspace.file!;
        workspace.file = Object.assign(new File([], 'revision-moi.pdf', { type: 'application/pdf' }), {
            path: 'D:\\pdfcompare\\test\\revision-moi.pdf',
        });
        setActive(true);
        await settleDashboard();
        await act(async () => { oldWorking.resolve(oldFile); });

        expect(batchRequests()).toHaveLength(1);
        expect(JSON.parse(batchRequests()[0].body as string).path).toBe(workspace.file.path);
    });
});
