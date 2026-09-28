// Probe chẩn đoán audit, không phải test nghiệm thu: khóa hiện tượng đang lỗi.
// Chạy callback lấy trực tiếp từ AST source; chỉ mock HTTP/renderer ở biên I/O.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import ts from 'typescript';

const pdfMocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('../../../desktop/src/components/workspace/thumbnailCache', () => ({
    thumbCacheRef: { current: new Map() }, putThumbCache: vi.fn(),
}));
vi.mock('../../../desktop/src/lib/tileUrlCache', () => ({
    claimTileUrlCacheOwner: vi.fn(), clearTileUrlCache: vi.fn(), releaseTileUrlCacheOwner: vi.fn(),
}));
vi.mock('react-pdf', () => ({ pdfjs: { getDocument: pdfMocks.getDocument } }));

import { usePdfLoader } from '../../../desktop/src/hooks/viewer/usePdfLoader';
import { materializeWorkingPdfRevision } from '../../../desktop/src/hooks/useWorkingPdf';
import { captureWorkspaceDocumentRevision, createWorkspaceStore } from '../../../desktop/src/stores/useWorkspaceStore';

function sourceCallback(relativePath: string, name: string, scope: Record<string, unknown>) {
    const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../', relativePath), 'utf8');
    const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name
            && node.initializer && ts.isCallExpression(node.initializer)) {
            callback = node.initializer.arguments[0];
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!callback) throw new Error(`Không tìm thấy callback sống ${name}`);
    const js = ts.transpileModule(`const probe = ${callback.getText(ast)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return new Function(...Object.keys(scope), `${js}; return probe;`)(...Object.values(scope));
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
    });
}

async function pdfFile(name: string, sizes: Array<[number, number]>): Promise<File> {
    const doc = await PDFDocument.create();
    sizes.forEach(([w, h], index) => {
        const page = doc.addPage([w, h]);
        page.node.set(PDFName.of('AuditPage'), PDFString.of(`original-${index + 1}`));
    });
    return new File([Uint8Array.from(await doc.save()).buffer], name, { type: 'application/pdf' });
}

async function describePdf(file: File) {
    const doc = await PDFDocument.load(await readBlob(file));
    return doc.getPages().map(page => ({
        label: page.node.lookupMaybe(PDFName.of('AuditPage'), PDFString)?.decodeText(),
        width: page.getWidth(), height: page.getHeight(), rotate: page.getRotation().angle,
    }));
}

function commitCallback(store: ReturnType<typeof createWorkspaceStore>, output: Blob) {
    const state = store.getState();
    return sourceCallback('desktop/src/components/ImpositionTab.tsx', 'handleEditCommit', {
        file: state.file, pdfUrl: state.pdfUrl, selectionFileId: state.selectionFileId,
        window, File, URL, console,
        getApiUrl: () => 'http://audit.invalid/api',
        authenticatedFetch: vi.fn(async () => ({ ok: true, blob: async () => output })),
        objectEditRecordingRef: { current: null },
        recipeOwnerTabId: 'audit-white-border',
        recipeRecorder: { isRecordingFor: () => false, noteCommit: vi.fn(), discardPending: vi.fn() },
        editHistory: { pushSnapshot: vi.fn() },
        tagArtifactLeaseToken: vi.fn(), markGeneratedWorkspaceFile: (file: File) => file,
        t: (key: string) => key, errorMessage: String, onTitleChange: vi.fn(),
        setFile: state.setFile, setOriginalFileName: state.setOriginalFileName,
        setPdfUrl: state.setPdfUrl, setFileSizeStr: state.setFileSizeStr,
        setIsSaved: state.setIsSaved, setSelectionFileId: state.setSelectionFileId,
        setError: state.setError,
    });
}

describe('Audit xóa viền — đường commit và consumer thật', () => {
    beforeEach(() => {
        pdfMocks.getDocument.mockReset();
        // jsdom Blob chưa có arrayBuffer; browser thật có. Không dùng Response
        // của Node với Blob jsdom vì nó encode chuỗi "[object File]".
        Object.defineProperty(Blob.prototype, 'arrayBuffer', {
            configurable: true,
            value: function(this: Blob) { return readBlob(this); },
        });
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:audit-trimmed') });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('xác nhận output đổi khổ bị gắn edit-commit và loader giữ metadata khổ cũ', async () => {
        const original = await pdfFile('source.pdf', [[200, 100]]);
        const cropped = await pdfFile('trimmed.pdf', [[160, 60]]);
        const store = createWorkspaceStore();
        store.setState({ file: original, pdfUrl: 'blob:source' });
        pdfMocks.getDocument.mockReturnValue({
            promise: Promise.resolve({
                numPages: 1,
                getPage: async () => ({ getViewport: () => ({ width: 200, height: 100 }) }),
            }), destroy: vi.fn(),
        });
        const makeProps = () => ({
            file: store.getState().file!, pdfUrl: store.getState().pdfUrl!,
            setNumPages: vi.fn(), setActivePage: vi.fn(), setZoom: vi.fn(),
            containerRef: { current: { clientWidth: 800 } } as React.RefObject<HTMLDivElement>,
        });
        const { result, rerender, unmount } = renderHook(({ props }) => usePdfLoader(props), {
            initialProps: { props: makeProps() },
        });
        await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
        const beforeDims = { ...result.current.pageDim };
        await act(async () => { await commitCallback(store, cropped)('/preflight/download/trimmed.pdf', 'trimmed.pdf'); });
        rerender({ props: makeProps() });
        const actual = await describePdf(store.getState().file!);
        expect(actual[0]).toMatchObject({ width: 160, height: 60 });
        expect((store.getState().file as File & { __editCommit?: boolean }).__editCommit).toBe(true);
        expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
        expect(result.current.pageDim).toEqual(beforeDims);
        process.stdout.write(`AUDIT trim_metadata ${JSON.stringify({ artifact: actual[0], beforeDims, afterDims: result.current.pageDim, loads: pdfMocks.getDocument.mock.calls.length })}\n`);
        unmount();
    });

    it('xác nhận working PDF bị bake thứ tự/xoay lần hai khi consumer kế tiếp đọc', async () => {
        const original = await pdfFile('source.pdf', [[100, 50], [200, 60], [300, 70]]);
        const store = createWorkspaceStore();
        store.setState({ file: original, pdfUrl: 'blob:source', viewerPageOrder: [3, 1, 1], viewerPageRotations: [90, 0, 180] });
        const prepared = await materializeWorkingPdfRevision(captureWorkspaceDocumentRevision(store.getState()) as Parameters<typeof materializeWorkingPdfRevision>[0]);
        // HTTP boundary trả PDF đã bake giống hợp đồng auto-trim; không sửa cấu trúc trang.
        await commitCallback(store, prepared)('/preflight/download/trimmed.pdf', 'trimmed.pdf');
        const beforeSecondBake = await describePdf(store.getState().file!);
        const after = await materializeWorkingPdfRevision(captureWorkspaceDocumentRevision(store.getState()) as Parameters<typeof materializeWorkingPdfRevision>[0]);
        const afterSecondBake = await describePdf(after);
        expect(store.getState().viewerPageOrder).toEqual([3, 1, 1]);
        expect(store.getState().viewerPageRotations).toEqual([90, 0, 180]);
        expect(beforeSecondBake.map(page => page.label)).toEqual(['original-3', 'original-1', 'original-1']);
        expect(afterSecondBake.map(page => page.label)).toEqual(['original-1', 'original-3', 'original-3']);
        expect(afterSecondBake.map(page => page.rotate)).toEqual([270, 90, 270]);
        process.stdout.write(`AUDIT trim_double_bake ${JSON.stringify({ beforeSecondBake, afterSecondBake })}\n`);
    });

    it('xác nhận response cũ của auto-trim vẫn thay thế file mới trong cùng workspace', async () => {
        const original = await pdfFile('source.pdf', [[200, 100]]);
        const newer = await pdfFile('newer.pdf', [[500, 400]]);
        const trimmed = await pdfFile('trimmed.pdf', [[160, 60]]);
        const store = createWorkspaceStore();
        store.setState({ file: original, pdfUrl: 'blob:source' });
        const onEditCommit = commitCallback(store, trimmed);
        let resolveResponse!: (response: unknown) => void;
        const pendingResponse = new Promise(resolve => { resolveResponse = resolve; });
        const post = vi.fn(() => pendingResponse);
        const handleAutoTrim = sourceCallback('desktop/src/components/AcrobatViewer.tsx', 'handleAutoTrim', {
            file: original, setAutoTrimBusy: vi.fn(),
            toast: { info: vi.fn(), dismiss: vi.fn(), success: vi.fn(), error: vi.fn() },
            t: (key: string) => key, errorMessage: String,
            ensureCropFileId: async () => 'source-fid', autoTrimScope: 'all', activePage: 1,
            autoTrimMargin: 0, autoTrimSides: ['top', 'right', 'bottom', 'left'], numPages: 1,
            authenticatedFetch: post, getApiUrl: () => 'http://audit.invalid/api',
            onEditCommit, setIsAutoTrimOpen: vi.fn(),
        });
        const job = handleAutoTrim();
        await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
        store.getState().setFile(newer);
        store.getState().setPdfUrl('blob:newer');
        resolveResponse({ ok: true, json: async () => ({ success: true, output_filename: 'trimmed.pdf' }) });
        await job;
        expect(store.getState().file!.name).toBe('trimmed.pdf');
        expect((await describePdf(store.getState().file!))[0]).toMatchObject({ width: 160, height: 60 });
        process.stdout.write(`AUDIT trim_stale_publish ${JSON.stringify({ replacedName: newer.name, finalName: store.getState().file!.name })}\n`);
    });
});
