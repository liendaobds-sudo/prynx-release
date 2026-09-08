// @vitest-environment jsdom
// Hồi quy FILEIO (audit 2026-08-06 §2): trên "đường native", File kết quả chỉ là sentinel
// 11 byte 'native-path' kèm `.path` — savePrintFilesToFolder phải đọc bytes THẬT từ đĩa,
// không được đưa bytes sentinel cho pdf-lib ("No PDF header found").
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { savePrintFilesToFolder } from './savePrintFiles';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    mkdir: vi.fn(async () => undefined),
    exists: vi.fn(async () => false),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: mocks.mkdir, exists: mocks.exists }));

type TauriWindow = Window & { __TAURI_INTERNALS__?: Record<string, never> };
const tauriWindow = window as TauriWindow;

/** PDF thật 4 trang = 2 loại × (in + bế). */
async function makeRealPdf(): Promise<Uint8Array<ArrayBuffer>> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([595, 842]);
    const saved = await doc.save();
    return new Uint8Array(saved.slice()) as Uint8Array<ArrayBuffer>;
}

async function makeLayeredPdf(): Promise<Uint8Array<ArrayBuffer>> {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const cut = doc.addPage([595, 842]);
    const graph = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('GRAPH_INFO') }));
    const layer = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('PONT_LAYER') }));
    const group = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('PONT_GROUP') }));
    cut.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
        '/OC /MarkGroup BDC /Span /MarkItem BDC 0 0 0 1 k 10 10 20 20 re f EMC EMC',
    )));
    cut.node.set(PDFName.of('Resources'), doc.context.obj({
        Properties: {
            MarkGroup: group,
            MarkItem: { NM: PDFString.of('PONT_ITEM') },
        },
    }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [graph, layer, group],
        D: { BaseState: PDFName.of('ON'), ON: [graph, layer, group], OFF: [], Order: [graph, layer, [group]] },
    }));
    const saved = await doc.save();
    return new Uint8Array(saved.slice()) as Uint8Array<ArrayBuffer>;
}

describe('savePrintFilesToFolder — đường native (File sentinel + path)', () => {
    beforeEach(() => {
        tauriWindow.__TAURI_INTERNALS__ = {};
        mocks.invoke.mockReset();
        mocks.invoke.mockResolvedValue(undefined);
        mocks.mkdir.mockClear();
        mocks.exists.mockClear();
    });

    afterEach(() => {
        delete tauriWindow.__TAURI_INTERNALS__;
        vi.unstubAllGlobals();
    });

    it('đọc bytes từ đĩa qua .path thay vì bytes sentinel của File', async () => {
        const realBytes = await makeRealPdf();
        const fetchMock = vi.fn().mockResolvedValue(new Response(realBytes, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        // Y hệt processHandlers.ts: sentinel 11 byte + path trên đĩa.
        const sentinel = new File(['native-path'], 'Imposed_order.pdf', { type: 'application/pdf' });
        Object.defineProperty(sentinel, 'path', { value: 'D:\\jobs\\Imposed_order.pdf' });

        const { ok, total } = await savePrintFilesToFolder(sentinel, 'D:\\out', {
            nameMode: 'number',
            folderMode: 'flat',
            separateCut: true,
        } as never, { pagesPerType: 2, labelName: 'Tem' });

        expect(fetchMock).toHaveBeenCalled();
        expect(total).toBe(4);
        expect(ok).toBe(4);
        const written = mocks.invoke.mock.calls.filter(c => c[0] === 'write_file_atomic');
        expect(written).toHaveLength(4);
        // Mỗi file in ra phải là PDF hợp lệ, không phải rác sentinel.
        for (const call of written) {
            const bytes = call[1].contents as Uint8Array;
            await expect(PDFDocument.load(bytes)).resolves.toBeTruthy();
        }
    });

    it('vẫn dùng bytes của blob khi không có path (web / in-memory)', async () => {
        const realBytes = await makeRealPdf();
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const blob = new Blob([realBytes], { type: 'application/pdf' });
        // jsdom chưa có Blob.prototype.arrayBuffer (browser thật thì có) → vá cho test.
        Object.defineProperty(blob, 'arrayBuffer', {
            value: async () => realBytes.buffer,
        });
        const { ok } = await savePrintFilesToFolder(blob, 'D:\\out', {
            nameMode: 'number',
            folderMode: 'flat',
            separateCut: true,
        } as never, { pagesPerType: 2, labelName: 'Tem' });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(ok).toBe(4);
    });

    it('giữ cây layer rỗng Graphtec khi ghi riêng file CUT', async () => {
        const realBytes = await makeLayeredPdf();
        const blob = new Blob([realBytes], { type: 'application/pdf' });
        Object.defineProperty(blob, 'arrayBuffer', { value: async () => realBytes.buffer });

        const { ok, total } = await savePrintFilesToFolder(blob, 'D:\\out', {
            nameMode: 'number',
            folderMode: 'flat',
            separateCut: true,
            includeOrderCode: false,
            includeDate: false,
        }, {
            types: [{ label: 'Tem', sheetCount: 1 }],
            pagesPerType: 2,
        });

        expect({ ok, total }).toEqual({ ok: 2, total: 2 });
        const written = mocks.invoke.mock.calls.filter(c => c[0] === 'write_file_atomic');
        const cutBytes = (written[1]?.[1] as { contents: Uint8Array }).contents;
        const cut = await PDFDocument.load(cutBytes);
        const ocgs = cut.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict)
            ?.lookupMaybe(PDFName.of('OCGs'), PDFArray);
        const names = [] as string[];
        for (let i = 0; ocgs && i < ocgs.size(); i += 1) {
            const ref = ocgs.get(i);
            if (!(ref instanceof PDFRef)) continue;
            const name = cut.context.lookupMaybe(ref, PDFDict)
                ?.lookupMaybe(PDFName.of('Name'), PDFString)?.decodeText();
            if (name) names.push(name);
        }
        expect(names).toEqual(['GRAPH_INFO', 'PONT_LAYER', 'PONT_GROUP']);
    });
});
