// @vitest-environment jsdom
// WBR28.02–03: chạy callback của ImpositionTab thật, chỉ mock HTTP và bề mặt vẽ.
import { createElement, Fragment, useContext, useState, useRef, useCallback } from 'react';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { WorkspaceContext, captureWorkspaceDocumentRevision, type WorkspaceState } from '../stores/useWorkspaceStore';
import { materializeWorkingPdfRevision, type WorkingPdfRevisionSnapshot } from '../hooks/useWorkingPdf';
import type { AutoTrimOptions } from './AcrobatViewer';
import type { WorkspaceHistoryEntry } from '../lib/workspaceHistory';

interface ViewerProps {
    onAutoTrimApply?: (options: AutoTrimOptions) => Promise<boolean>;
    onEditCommit?: (url: string, name: string) => Promise<void>;
    onDocumentUndo?: () => void;
    pendingHistoryEntry?: WorkspaceHistoryEntry | null;
    onHistoryEntryHydrated?: (entry: WorkspaceHistoryEntry) => void;
}
const mocks = vi.hoisted(() => ({
    workspace: null as StoreApi<WorkspaceState> | null,
    viewer: {} as ViewerProps,
    post: vi.fn(), download: vi.fn(), nativeUpload: vi.fn(), pdfDocument: vi.fn(),
    uploaded: new Map<string, File>(), sequence: 0,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('react-pdf', () => ({ pdfjs: { getDocument: mocks.pdfDocument, GlobalWorkerOptions: { workerSrc: 'audit-worker' } } }));
vi.mock('./workspace/thumbnailCache', () => ({ thumbCacheRef: { current: new Map() }, putThumbCache: vi.fn() }));
vi.mock('../lib/tileUrlCache', () => ({ claimTileUrlCacheOwner: vi.fn(), clearTileUrlCache: vi.fn(), clearTileUrlCacheForFile: vi.fn(), releaseTileUrlCacheOwner: vi.fn() }));
vi.mock('./imposition-tools/ImposerDashboard', () => ({ default: () => null }));
vi.mock('./OutputPreviewHost', () => ({ default: () => null }));
vi.mock('../lib/api', async original => ({
    ...await original<typeof import('../lib/api')>(),
    uploadPDF: vi.fn(async (file: File) => {
        const id = `trim-upload-${++mocks.sequence}`;
        mocks.uploaded.set(id, file);
        return { id };
    }),
    uploadFileForNup: mocks.nativeUpload,
    authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/preflight/auto-trim')) return mocks.post(JSON.parse(String(init?.body)), init);
        if (url.includes('/preflight/download/')) return mocks.download(url, init);
        return { ok: true, json: async () => ({ layers: [] }) };
    }),
}));
vi.mock('../lib/utils', async original => ({
    ...await original<typeof import('../lib/utils')>(), detectColorSpace: vi.fn(async () => null),
}));
vi.mock('../lib/viewerFirstFrame', () => ({ primeViewerFirstFrame: vi.fn(async () => null), waitForViewerFirstFrameGrace: vi.fn(async () => null) }));
vi.mock('./AcrobatViewer', () => ({
    default: function ViewerProbe(props: ViewerProps) {
        mocks.workspace = useContext(WorkspaceContext);
        mocks.viewer = props;
        return null;
    },
}));
import ImpositionTab from './ImpositionTab';
import { flattenRotations, genPageIds, usePdfLoader } from '../hooks/viewer/usePdfLoader';
import { recipeRecorder } from '../lib/recipe/RecipeRecorder';
import { useStickerSheetStore } from './preprocess-tools/stickerSheetStore';

const TAB = 'white-border-commit';
const OPTIONS: AutoTrimOptions = { pages: undefined, marginMm: 0, trimSides: ['top', 'right', 'bottom', 'left'] };
const response = { ok: true, json: async () => ({ success: true, output_filename: 'trimmed.pdf' }) };
function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
    });
}
async function pdfFile(name = 'source.pdf', widths = [100, 200, 300]) {
    const doc = await PDFDocument.create();
    widths.forEach((width, index) => {
        doc.addPage([width, 100]).node.set(PDFName.of('AuditPage'), PDFString.of(`page-${index + 1}`));
    });
    return new File([Uint8Array.from(await doc.save()).buffer], name, { type: 'application/pdf' });
}
async function pages(file: File) {
    return (await PDFDocument.load(await readBlob(file))).getPages().map(page => ({
        name: page.node.lookupMaybe(PDFName.of('AuditPage'), PDFString)?.decodeText(),
        width: page.getWidth(), rotation: page.getRotation().angle,
    }));
}
async function mount(file?: File, tabId = TAB) {
    const source = file ?? await pdfFile();
    const view = render(<ImpositionTab tabId={tabId} isActive initialFeature="pages" initialFile={source} />);
    await waitFor(() => expect(mocks.workspace?.getState().file).toBe(source));
    expect(mocks.viewer.onAutoTrimApply).toBeTypeOf('function');
    return { ...view, file: source, store: mocks.workspace! };
}
async function start() {
    let job!: Promise<boolean>;
    await act(async () => { job = mocks.viewer.onAutoTrimApply!(OPTIONS); });
    return { job };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function viewerCallback<T>(name: string, scope: Record<string, unknown>): T {
    // Chạy chính callback production; phần vẽ/native vẫn nằm ngoài harness này.
    const source = readFileSync(path.resolve('src/components/AcrobatViewer.tsx'), 'utf8');
    const ast = ts.createSourceFile('AcrobatViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let node: ts.Node | undefined;
    const visit = (current: ts.Node): void => {
        if (ts.isVariableDeclaration(current) && current.name.getText(ast) === name && current.initializer && ts.isCallExpression(current.initializer)) node = current.initializer.arguments[0];
        if (name === 'hydrateHistory' && ts.isCallExpression(current) && current.expression.getText(ast) === 'useEffect'
            && current.arguments[0]?.getText(ast).includes('const pending = pendingHistoryEntry;')) node = current.arguments[0];
        ts.forEachChild(current, visit);
    };
    visit(ast); expect(node).toBeDefined();
    const js = ts.transpileModule(`const callback = ${node!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(scope), `${js}; return callback;`)(...Object.values(scope)) as T;
}

function createAutoTrimPopupHarness(
    onApply: (options: AutoTrimOptions) => Promise<boolean>,
): { Harness: React.ComponentType; source: string } {
    const source = readFileSync(path.resolve('src/components/AcrobatViewer.tsx'), 'utf8');
    const ast = ts.createSourceFile('AcrobatViewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const stateNames = new Set([
        'isAutoTrimOpen', 'autoTrimBusy', 'autoTrimMode', 'autoTrimMargin',
        'autoTrimScope', 'autoTrimSides', 'autoTrimPopRef', 'toggleAutoTrimSide',
        'handleAutoTrim',
    ]);
    let popup: ts.JsxElement | undefined;
    const declarations: ts.VariableStatement[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isVariableStatement(node)) {
            const matches = node.declarationList.declarations.some(declaration => {
                if (ts.isIdentifier(declaration.name)) return stateNames.has(declaration.name.text);
                return ts.isArrayBindingPattern(declaration.name)
                    && declaration.name.elements.some(element => (
                        ts.isBindingElement(element)
                        && ts.isIdentifier(element.name)
                        && stateNames.has(element.name.text)
                    ));
            });
            if (matches) declarations.push(node);
        }
        if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute => (
            ts.isJsxAttribute(attribute)
            && attribute.name.getText(ast) === 'ref'
            && attribute.initializer
            && ts.isJsxExpression(attribute.initializer)
            && attribute.initializer.expression?.getText(ast) === 'autoTrimPopRef'
        ))) {
            popup = node;
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(popup).toBeDefined();
    const labels: Record<string, string> = {
        'misc.acrobatViewer:khu_vien_trang': 'Xử lý viền',
        'misc.acrobatViewer:khu_vien_trang_desc': 'Mô tả viền',
        'misc.acrobatViewer:khu_vien_che_do': 'Cách xử lý viền',
        'misc.acrobatViewer:khu_vien_xoa': 'Xóa viền',
        'misc.acrobatViewer:khu_vien_phu_mau_bien': 'Phủ màu theo biên',
        'misc.acrobatViewer:khu_vien_phu_mau_hint': 'Giữ nguyên khổ trang và vị trí nội dung.',
        'misc.acrobatViewer:tat_ca_trang': 'Tất cả trang',
        'misc.acrobatViewer:trang_hien_tai': 'Trang hiện tại',
        'misc.acrobatViewer:khu_vien_canh_bat_buoc_hint': 'Cạnh bắt buộc',
        'misc.acrobatViewer:le_bo_sung_mm': 'Lề bổ sung (mm)',
        'misc.acrobatViewer:ap_dung': 'Áp dụng',
        'misc.acrobatViewer:dang_xu_ly_khu_vien': 'Đang xử lý viền...',
    };
    const scope = {
        React: { createElement, Fragment },
        createElement,
        useRef,
        useCallback,
        file: new File([], 'source.pdf'),
        onAutoTrimApply: onApply,
        autoTrimScope: 'all',
        activePage: 2,
        numPages: 3,
        t: (key: string) => labels[key] ?? key,
        tv: (value: string) => value,
        errorMessage: String,
        AUTO_TRIM_SIDES: ['top', 'right', 'bottom', 'left'],
        AUTO_TRIM_SIDE_LABEL: { top: 'Trên', right: 'Phải', bottom: 'Dưới', left: 'Trái' },
        toast: { info: vi.fn(() => 1), dismiss: vi.fn(), success: vi.fn(), error: vi.fn() },
    };
    const declarationText = declarations.map(statement => statement.getText(ast)).join('\n');
    const harnessSource = `function PopupHarness() {
        let stateCall = 0;
        const useState = (initial) => ReactUseState(stateCall++ === 0 ? true : initial);
        ${declarationText}
        return ${popup!.getText(ast)};
    }`;
    const js = ts.transpileModule(harnessSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'createElement' },
    }).outputText;
    const Harness = new Function(
        'ReactUseState',
        ...Object.keys(scope),
        `${js}; return PopupHarness;`,
    )(useState, ...Object.values(scope)) as React.ComponentType;
    return { Harness, source };
}

async function clickButton(text: string) {
    const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text);
    if (!button) throw new Error(`Không tìm thấy nút ${text}`);
    await act(async () => button.click());
    return button as HTMLButtonElement;
}
function hydrateViewerHistory(store: StoreApi<WorkspaceState>) {
    const state = store.getState();
    const scope = {
        pendingHistoryEntry: mocks.viewer.pendingHistoryEntry,
        file: state.file, hydratedHistoryEntryRef: { current: null },
        historyHydrationArm: null as WorkspaceHistoryEntry | null,
        setHistoryHydrationArm: (entry: WorkspaceHistoryEntry | null) => { scope.historyHydrationArm = entry; },
        loadStatus: 'ready', pageOrder: [1, 2, 3], genPageIds,
        applyOrderChange: viewerCallback('applyOrderChange', {
            setPageOrder: vi.fn(), setPageInstanceIds: vi.fn(), setPageRotations: vi.fn(),
            setViewerPageOrder: state.setViewerPageOrder, setViewerPageInstanceIds: state.setViewerPageInstanceIds,
            setViewerPageRotations: state.setViewerPageRotations, setNumPages: state.setViewerNumPages, flattenRotations,
        }),
        setSelectedIndices: vi.fn(), setLastSelectedIndex: vi.fn(), setActivePage: state.setViewerActivePage,
        setPastStack: vi.fn(), setFutureStack: vi.fn(), onHistoryEntryHydrated: mocks.viewer.onHistoryEntryHydrated,
    };
    // Loader-ready được mô phỏng; hai lượt arm/hydrate và transaction E1a là code thật.
    viewerCallback<() => void>('hydrateHistory', scope)();
    viewerCallback<() => void>('hydrateHistory', scope)();
}

describe('Khử viền — commit artifact đúng revision', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.workspace = null; mocks.viewer = {}; mocks.uploaded.clear(); mocks.sequence = 0;
        mocks.post.mockReset().mockResolvedValue(response);
        mocks.download.mockReset().mockResolvedValue({ ok: true, blob: async () => pdfFile('trimmed.pdf', [160]) });
        mocks.nativeUpload.mockReset(); mocks.pdfDocument.mockReset();
        recipeRecorder.cancel(recipeRecorder.ownerTabId ?? TAB);
        useStickerSheetStore.setState({ tabs: {} });
        Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: function(this: Blob) { return readBlob(this); } });
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:trim-${mocks.sequence}`) });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });
    afterEach(() => {
        cleanup(); recipeRecorder.cancel(recipeRecorder.ownerTabId ?? TAB); useStickerSheetStore.setState({ tabs: {} }); vi.unstubAllGlobals();
        delete window.__TAURI_INTERNALS__;
    });


    it('gửi mode trim mặc định để giữ tương thích request cũ', async () => {
        await mount();
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!(OPTIONS)).toBe(true));
        expect(mocks.post.mock.calls[0][0].mode).toBe('trim');
    });

    it('gửi fill và chỉ commit artifact khi backend xác nhận fill', async () => {
        const { store } = await mount();
        mocks.post.mockResolvedValue({
            ok: true, json: async () => ({ success: true, output_filename: 'filled.pdf', mode: 'fill' }),
        });
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!({
            ...OPTIONS, pages: [2], mode: 'fill',
        })).toBe(true));
        expect(mocks.post.mock.calls[0][0]).toMatchObject({ mode: 'fill', pages: [2], margin_mm: 0 });
        expect(store.getState().file?.name).toBe('filled.pdf');
        expect(store.getState().history).toHaveLength(1);
    });

    it.each([undefined, 'trim', null, 'unknown'])('không nhận fill khi backend trả mode=%s', async mode => {
        const { store, file } = await mount();
        mocks.post.mockResolvedValue({
            ok: true, json: async () => ({ success: true, output_filename: 'possibly-trimmed.pdf', mode }),
        });
        await act(async () => {
            await expect(mocks.viewer.onAutoTrimApply!({ ...OPTIONS, mode: 'fill' })).rejects.toThrow();
        });
        expect(mocks.download).not.toHaveBeenCalled();
        expect(store.getState().file).toBe(file);
        expect(store.getState().history).toHaveLength(0);
    });

    it('không nhận trim khi backend xác nhận mode fill trái yêu cầu', async () => {
        const { store, file } = await mount();
        mocks.post.mockResolvedValue({
            ok: true, json: async () => ({ success: true, output_filename: 'wrong-mode.pdf', mode: 'fill' }),
        });
        await act(async () => {
            await expect(mocks.viewer.onAutoTrimApply!(OPTIONS)).rejects.toThrow();
        });
        expect(mocks.download).not.toHaveBeenCalled();
        expect(store.getState().file).toBe(file);
        expect(store.getState().history).toHaveLength(0);
    });

    it('nhận trim có echo từ backend mới, vẫn gửi đúng lề', async () => {
        await mount();
        mocks.post.mockResolvedValue({
            ok: true, json: async () => ({ success: true, output_filename: 'trimmed.pdf', mode: 'trim' }),
        });
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!({
            ...OPTIONS, mode: 'trim', marginMm: 1.5,
        })).toBe(true));
        expect(mocks.post.mock.calls[0][0]).toMatchObject({ mode: 'trim', margin_mm: 1.5 });
    });

    it('nạp metadata khổ mới và không gắn cờ edit-commit khi xén trang', async () => {
        const { store } = await mount(await pdfFile('source.pdf', [200]));
        mocks.pdfDocument.mockImplementation(() => ({
            promise: Promise.resolve({ numPages: 1, getPage: async () => ({
                getViewport: () => ({ width: store.getState().file!.name === 'trimmed.pdf' ? 160 : 200, height: 100 }),
            }) }), destroy: vi.fn(),
        }));
        const props = () => ({ file: store.getState().file!, pdfUrl: store.getState().pdfUrl!,
            setNumPages: vi.fn(), setActivePage: vi.fn(), setZoom: vi.fn(),
            containerRef: { current: { clientWidth: 800 } } as React.RefObject<HTMLDivElement> });
        const loader = renderHook(({ value }) => usePdfLoader(value), { initialProps: { value: props() } });
        await waitFor(() => expect(loader.result.current.loadStatus).toBe('ready'));
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!(OPTIONS)).toBe(true));
        expect(store.getState().file).not.toHaveProperty('__editCommit');
        loader.rerender({ value: props() });
        await waitFor(() => expect(loader.result.current.pageDim?.w).toBeCloseTo(160 * 96 / 72));
        expect(mocks.pdfDocument).toHaveBeenCalledTimes(2);
        expect(store.getState().history).toHaveLength(1);
        loader.unmount();
    });

    it('bake reorder/duplicate/rotate đúng một lần và Undo giữ nguyên revision trước xén', async () => {
        const { store, file } = await mount();
        act(() => {
            store.getState().setViewerPageOrder([3, 1, 1]);
            store.getState().setViewerPageInstanceIds(['third', 'first-a', 'first-b']);
            store.getState().setViewerPageRotations([90, 0, 180]);
            store.getState().setViewerDirty(true);
        });
        mocks.post.mockImplementation(async body => {
            const prepared = mocks.uploaded.get(body.file_id)!;
            mocks.download.mockResolvedValue({ ok: true, blob: async () => prepared });
            return response;
        });
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!(OPTIONS)).toBe(true));
        expect(store.getState().viewerPageOrder).toBeUndefined();
        expect(store.getState().viewerPageRotations).toBeUndefined();
        const output = await materializeWorkingPdfRevision(captureWorkspaceDocumentRevision(store.getState()) as WorkingPdfRevisionSnapshot);
        expect(await pages(output)).toEqual([
            { name: 'page-3', width: 300, rotation: 90 }, { name: 'page-1', width: 100, rotation: 0 }, { name: 'page-1', width: 100, rotation: 180 },
        ]);
        expect(store.getState().history[0]).toMatchObject({ file, pageRevision: { pageOrder: [3, 1, 1], pageInstanceIds: ['third', 'first-a', 'first-b'], pageRotations: [90, 0, 180] }, pageRevisionDirty: true });
        await act(async () => { mocks.viewer.onDocumentUndo!(); });
        expect(store.getState().file).toBe(file);
        act(() => hydrateViewerHistory(store));
        expect(store.getState().viewerPageOrder).toEqual([3, 1, 1]);
        expect(store.getState().viewerPageInstanceIds).toEqual(['third', 'first-a', 'first-b']);
        expect(store.getState().viewerPageRotations).toEqual([90, 0, 180]);
        expect(store.getState().viewerDirty).toBe(true);
        const undone = await materializeWorkingPdfRevision(captureWorkspaceDocumentRevision(store.getState()) as WorkingPdfRevisionSnapshot);
        expect(await pages(undone)).toEqual(await pages(output));
    });

    it('Edit barrier publish trước prepare thì nguồn xén và Undo cùng trỏ revision mới', async () => {
        const { store } = await mount();
        const edited = await pdfFile('edited-before-trim.pdf', [240]);
        act(() => store.getState().setDocumentPreparationBarrier(async () => {
            store.getState().setFile(edited);
            store.getState().setPdfUrl('blob:edited');
            store.getState().setDocumentPreparationBarrier(null);
        }));
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!(OPTIONS)).toBe(true));
        expect(mocks.uploaded.get(mocks.post.mock.calls[0][0].file_id)).toBe(edited);
        expect(store.getState().history[0].file).toBe(edited);
        await act(async () => { mocks.viewer.onDocumentUndo!(); });
        expect(store.getState().file).toBe(edited);
    });

    it.each(['original', 'page-revision', 'edit-barrier'] as const)('Undo giữ owner nguồn ảnh/tem đúng revision: %s', async change => {
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8////fwYGBgYmEIHCAABiCgQCEYu24wAAAABJRU5ErkJggg=='), value => value.charCodeAt(0));
        const image = new File([png.buffer], 'source.png', { type: 'image/png' });
        render(<ImpositionTab tabId={TAB} isActive initialFeature="pages" initialFile={image} />);
        await waitFor(() => expect(mocks.workspace?.getState().file?.name).toBe('source.pdf'));
        const store = mocks.workspace!;
        act(() => {
            useStickerSheetStore.getState().initTab(TAB);
            useStickerSheetStore.getState().selectSource(TAB, image, 'explicit');
            if (change === 'page-revision') {
                store.getState().setViewerPageOrder([1, 1]);
                store.getState().setViewerPageInstanceIds(['image-a', 'image-b']);
                store.getState().setViewerPageRotations([90, 0]);
            }
        });
        if (change === 'edit-barrier') {
            const edited = await pdfFile('edited-image.pdf', [140]);
            act(() => store.getState().setDocumentPreparationBarrier(async () => {
                store.getState().advanceEditGeneration();
                store.getState().setFile(edited);
                store.getState().setPdfUrl('blob:edited-image');
                store.getState().setDocumentPreparationBarrier(null);
            }));
        }
        const pending = deferred<typeof response>(); mocks.post.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
        await act(async () => { pending.resolve(response); expect(await job).toBe(true); });
        const entry = store.getState().history[0];
        expect(entry.sourceImageFile).toBe(change === 'edit-barrier' ? null : image);
        expect(entry.stickerSourceFile).toBe(change === 'original' ? image : null);
        await act(async () => { mocks.viewer.onDocumentUndo!(); });
        expect(mocks.viewer.pendingHistoryEntry).toBe(entry);
        act(() => hydrateViewerHistory(store));
        expect(store.getState().file).toBe(entry.file);
    });

    it.each(['file', 'order', 'rotation', 'edit', 'ocg'] as const)('không publish response sau khi %s đổi', async change => {
        const { store, file } = await mount();
        const newerFile = new File(['newer'], 'newer.pdf');
        const pending = deferred<typeof response>(); mocks.post.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
        act(() => {
            if (change === 'file') store.getState().setFile(newerFile);
            if (change === 'order') store.getState().setViewerPageOrder([2, 1]);
            if (change === 'rotation') store.getState().setViewerPageRotations([90, 0, 0]);
            if (change === 'edit') store.getState().advanceEditGeneration();
            if (change === 'ocg') store.getState().setHiddenOcgLayerIds([]);
        });
        await act(async () => { pending.resolve(response); expect(await job).toBe(false); });
        expect(store.getState().file).toBe(change === 'file' ? newerFile : file);
        expect(store.getState().file!.name).not.toBe('trimmed.pdf');
        expect(store.getState().history).toHaveLength(0);
        expect(mocks.download).not.toHaveBeenCalled();
    });

    it('kiểm lại revision sau download', async () => {
        const { store, file } = await mount();
        const pending = deferred<{ ok: boolean; blob: () => Promise<File> }>();
        mocks.download.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
        act(() => store.getState().advanceEditGeneration());
        await act(async () => { pending.resolve({ ok: true, blob: async () => pdfFile() }); expect(await job).toBe(false); });
        expect(store.getState().file).toBe(file); expect(store.getState().history).toHaveLength(0);
    });

    it('kiểm lại revision sau khi đọc blob và chỉ nhận một request đang chạy', async () => {
        const { store, file } = await mount();
        const pending = deferred<File>(); const blob = vi.fn(() => pending.promise);
        mocks.download.mockResolvedValueOnce({ ok: true, blob });
        const { job } = await start();
        await waitFor(() => expect(blob).toHaveBeenCalledTimes(1));
        await act(async () => expect(await mocks.viewer.onAutoTrimApply!(OPTIONS)).toBe(false));
        expect(mocks.post).toHaveBeenCalledTimes(1);
        act(() => store.getState().setViewerPageInstanceIds(['new-instance']));
        await act(async () => { pending.resolve(await pdfFile()); expect(await job).toBe(false); });
        expect(store.getState().file).toBe(file); expect(store.getState().history).toHaveLength(0);
    });

    it('kết quả chỉ về tab sở hữu khi tab khác được mở trong lúc chờ', async () => {
        const source = await mount();
        const pending = deferred<typeof response>(); mocks.post.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
        source.rerender(<ImpositionTab tabId={TAB} isActive={false} initialFeature="pages" initialFile={source.file} />);
        const other = await mount(await pdfFile('another-tab.pdf'), 'other-document');
        await act(async () => { pending.resolve(response); expect(await job).toBe(true); });
        expect(source.store.getState().file!.name).toBe('trimmed.pdf');
        expect(other.store.getState().file).toBe(other.file);
        expect(other.store.getState().history).toHaveLength(0);
    });

    it.each(['same-tab', 'other-tab', 'starts-during-request'] as const)('không lọt ghi quy trình: %s', async recording => {
        const { store, file } = await mount();
        if (recording !== 'starts-during-request') act(() => { expect(recipeRecorder.start(recording === 'same-tab' ? TAB : 'another-tab')).toBe(true); });
        const pending = deferred<typeof response>();
        if (recording === 'starts-during-request') mocks.post.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        if (recording === 'starts-during-request') {
            await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
            act(() => { expect(recipeRecorder.start(TAB)).toBe(true); });
            pending.resolve(response);
        }
        await act(async () => expect(await job).toBe(recording === 'other-tab'));
        if (recording !== 'other-tab') expect(store.getState().file).toBe(file);
        expect(recipeRecorder.draftSteps).toHaveLength(0);
        if (recording === 'same-tab') expect(mocks.post).not.toHaveBeenCalled();
    });

    it('đóng tab khi đang chuẩn bị native path thì không publish hoặc thêm Undo', async () => {
        const { store, file, unmount } = await mount();
        Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: vi.fn() } });
        const pending = deferred<string>(); mocks.nativeUpload.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        await waitFor(() => expect(mocks.nativeUpload).toHaveBeenCalledTimes(1));
        unmount();
        await act(async () => { pending.resolve('D:\\temporary\\trimmed.pdf'); expect(await job).toBe(false); });
        expect(store.getState().file).toBe(file); expect(store.getState().history).toHaveLength(0);
    });

    it.each(['edit', 'recording'] as const)('kiểm lại %s sau native I/O', async change => {
        const { store, file } = await mount();
        Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: vi.fn() } });
        const pending = deferred<string>(); mocks.nativeUpload.mockReturnValueOnce(pending.promise);
        const { job } = await start();
        await waitFor(() => expect(mocks.nativeUpload).toHaveBeenCalledTimes(1));
        act(() => {
            if (change === 'edit') store.getState().advanceEditGeneration();
            else expect(recipeRecorder.start(TAB)).toBe(true);
        });
        await act(async () => { pending.resolve('D:\\temporary\\trimmed.pdf'); expect(await job).toBe(false); });
        expect(store.getState().file).toBe(file); expect(store.getState().history).toHaveLength(0);
    });

    it('download lỗi không đổi source và callback object-edit vẫn giữ flag riêng', async () => {
        const { store, file } = await mount();
        mocks.download.mockResolvedValueOnce({ ok: false, status: 500 });
        await act(async () => { await expect(mocks.viewer.onAutoTrimApply!(OPTIONS)).rejects.toThrow(); });
        expect(store.getState().file).toBe(file); expect(store.getState().history).toHaveLength(0);
        await act(async () => { await mocks.viewer.onEditCommit!('/preflight/download/edited.pdf', 'object-edited.pdf'); });
        expect(store.getState().file).toHaveProperty('__editCommit', true);
    });

    it.each(['post-error', 'invalid-result', 'empty-artifact'] as const)('không commit artifact lỗi: %s', async failure => {
        const { store, file } = await mount();
        if (failure === 'post-error') mocks.post.mockResolvedValueOnce({ ok: false, json: async () => ({ detail: 'Không thể xử lý PDF.' }) });
        if (failure === 'invalid-result') mocks.post.mockResolvedValueOnce({ ok: true, json: async () => ({ success: false }) });
        if (failure === 'empty-artifact') mocks.download.mockResolvedValueOnce({ ok: true, blob: async () => new Blob([]) });
        await act(async () => { await expect(mocks.viewer.onAutoTrimApply!(OPTIONS)).rejects.toThrow(); });
        expect(store.getState().file).toBe(file); expect(store.getState().history).toHaveLength(0);
        if (failure !== 'empty-artifact') expect(mocks.download).not.toHaveBeenCalled();
    });

    it.each([false, true])('toolbar chỉ báo thành công nếu callback thật sự commit: %s', async committed => {
        const toast = { info: vi.fn(), dismiss: vi.fn(), success: vi.fn(), error: vi.fn() };
        const scope = { file: new File([], 'source.pdf'), onAutoTrimApply: vi.fn(async () => committed), autoTrimBusy: false,
            autoTrimMode: 'trim',
            autoTrimScope: 'current', activePage: 2, numPages: 3, autoTrimSides: ['left'], autoTrimMargin: 1,
            setAutoTrimBusy: vi.fn(), setIsAutoTrimOpen: vi.fn(), toast, t: (key: string) => key, errorMessage: String };
        const callback = viewerCallback<() => Promise<void>>('handleAutoTrim', scope);
        await callback();
        expect(scope.onAutoTrimApply).toHaveBeenCalledWith({ pages: [2], marginMm: 1, trimSides: ['left'], mode: 'trim' });
        expect(toast.success).toHaveBeenCalledTimes(committed ? 1 : 0);
        expect(scope.setIsAutoTrimOpen).toHaveBeenCalledTimes(committed ? 1 : 0);
        expect(toast.dismiss).toHaveBeenCalledTimes(1);
    });

    it('popup DOM chọn phủ màu, ẩn lề và gửi margin 0', async () => {
        const payloads: AutoTrimOptions[] = [];
        const { Harness } = createAutoTrimPopupHarness(async options => {
            payloads.push(options);
            return false;
        });
        render(createElement(Harness));
        expect(document.querySelector('input[type="number"]')).not.toBeNull();
        await clickButton('Phủ màu theo biên');
        expect(document.querySelector('input[type="number"]')).toBeNull();
        expect(document.body.textContent).toContain('Giữ nguyên khổ trang và vị trí nội dung.');
        await clickButton('Áp dụng');
        expect(payloads).toEqual([{
            pages: undefined,
            marginMm: 0,
            trimSides: ['top', 'right', 'bottom', 'left'],
            mode: 'fill',
        }]);
    });

    it('popup DOM khóa toàn bộ điều khiển khi callback đang bận', async () => {
        const pending = deferred<boolean>();
        const { Harness } = createAutoTrimPopupHarness(() => pending.promise);
        render(createElement(Harness));
        await clickButton('Áp dụng');
        const fieldset = document.querySelector('fieldset');
        expect(fieldset).not.toBeNull();
        expect(fieldset).toHaveProperty('disabled', true);
        expect([...fieldset!.querySelectorAll('button, input')].every(control => control.matches(':disabled'))).toBe(true);
        pending.resolve(false);
        await waitFor(() => expect(fieldset).toHaveProperty('disabled', false));
    });
});
