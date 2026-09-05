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
    uploadPDF: vi.fn(),
}));
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
) {
    const store = createImposerSettingsStore(`grouping-parity-${activeTool}`);
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
    const readWorkingFile = vi.fn(async () => workspace.file!);
    render(
        <ImposerSettingsContext.Provider value={store}>
            <ImposerDashboard
                tabId="grouping-parity"
                isActive
                onStartBooklet={vi.fn()}
                onStartNup={onStartNup}
                getWorkingFile={readWorkingFile}
            />
        </ImposerSettingsContext.Provider>,
    );
    return { store, onStartNup };
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
