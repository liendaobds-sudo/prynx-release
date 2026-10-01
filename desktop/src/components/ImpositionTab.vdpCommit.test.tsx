// @vitest-environment jsdom
// Chạy handler và vòng render thật của ImpositionTab; chỉ thay I/O và vùng vẽ.
import { useContext } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { WorkspaceContext, type WorkspaceState } from '../stores/useWorkspaceStore';

const mocks = vi.hoisted(() => ({
    stores: new Map<string, StoreApi<WorkspaceState>>(),
    download: vi.fn(), stat: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: mocks.stat }));
vi.mock('./imposition-tools/ImposerDashboard', () => ({ default: () => null }));
vi.mock('./OutputPreviewHost', () => ({ default: () => null }));
vi.mock('../lib/api', async original => ({
    ...await original<typeof import('../lib/api')>(),
    uploadPDF: vi.fn(async () => ({ id: 'background-upload' })),
    authenticatedFetch: vi.fn(async (url: string) => {
        if (url.includes('/vdp/templates/')) return mocks.download(url);
        return { ok: true, json: async () => ({ layers: [] }) };
    }),
}));
vi.mock('../lib/utils', async original => ({
    ...await original<typeof import('../lib/utils')>(), detectColorSpace: vi.fn(async () => null),
}));
vi.mock('../lib/viewerFirstFrame', () => ({
    primeViewerFirstFrame: vi.fn(async () => null), waitForViewerFirstFrameGrace: vi.fn(async () => null),
}));
vi.mock('./AcrobatViewer', () => ({
    default: function ViewerProbe({ tabId }: { tabId: string }) {
        mocks.stores.set(tabId, useContext(WorkspaceContext)!);
        return null;
    },
}));
import ImpositionTab from './ImpositionTab';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
    });
}
async function pdfFile(name = 'template.pdf') {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    return new File([Uint8Array.from(await doc.save()).buffer], name, { type: 'application/pdf' });
}
async function mount(tabId = 'vdp-a') {
    const file = await pdfFile();
    const view = render(<ImpositionTab tabId={tabId} isActive initialFeature="pages" initialFile={file} />);
    await waitFor(() => expect(mocks.stores.get(tabId)?.getState().file).toBe(file));
    const store = mocks.stores.get(tabId)!;
    act(() => store.getState().setSelectionFileId(`source-${tabId}`));
    return { ...view, file, store, tabId };
}
const field = { id: 'picked', name: 'Name', type: 'text' as const, x: 10, y: 20, width: 30, height: 10, pageNum: 1 };
function dispatchCleaned(tabId: string, extra: Record<string, unknown> = {}) {
    window.dispatchEvent(new CustomEvent('vdp-template-cleaned', { detail: {
        tabId, pickId: 'pick-1', sourceFid: `source-${tabId}`,
        workingFid: 'cleaned-1', workingPdfUrl: '/api/vdp/templates/cleaned-1.pdf',
        ...extra,
    } }));
}

describe('VDP — commit phôi sạch qua vòng render thật', () => {
    beforeEach(() => {
        vi.clearAllMocks(); mocks.stores.clear(); mocks.download.mockReset(); mocks.stat.mockReset();
        Object.defineProperty(Blob.prototype, 'arrayBuffer', { configurable: true, value: function(this: Blob) { return readBlob(this); } });
        let sequence = 0;
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:vdp-${++sequence}`) });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });
    afterEach(() => {
        cleanup(); vi.unstubAllGlobals();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it.each(['web', 'tauri'] as const)('thêm field rồi render lại vẫn thay PDF gốc bằng phôi sạch (%s)', async runtime => {
        const { file, store, tabId } = await mount();
        const cleanPdf = await pdfFile('cleaned.pdf');
        const io = deferred<unknown>();
        const nativePath = 'D:\\results\\vdp_templates\\cleaned.pdf';
        if (runtime === 'tauri') {
            (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
            mocks.stat.mockReturnValue(io.promise);
        } else mocks.download.mockReturnValue(io.promise);

        // Đúng thứ tự picker: thêm field và phát event trong cùng một callback,
        // render lại trước khi đọc file sạch xong.
        await act(async () => {
            store.getState().setVdpFields([field]);
            store.getState().setSelectedVdpFieldIds([field.id]);
            dispatchCleaned(tabId, runtime === 'tauri' ? { workingPdfPath: nativePath } : {});
        });
        expect(store.getState().file).toBe(file);
        await act(async () => {
            io.resolve(runtime === 'tauri' ? { size: cleanPdf.size } : { ok: true, blob: async () => cleanPdf });
        });
        await waitFor(() => expect(store.getState().file).not.toBe(file));
        expect(store.getState().selectionFileId).toBe(runtime === 'tauri' ? nativePath : 'cleaned-1');
        expect(store.getState().vdpFields).toEqual([field]);
        expect(store.getState().selectedVdpFieldIds).toEqual([field.id]);
        expect(store.getState().objectEditPast).toHaveLength(1);
        if (runtime === 'web') expect(await readBlob(store.getState().file!)).toEqual(await readBlob(cleanPdf));
        else expect(store.getState().file).toHaveProperty('path', nativePath);
    });
});
