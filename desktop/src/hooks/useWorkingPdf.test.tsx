// @vitest-environment jsdom

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import {
    WorkspaceContext,
    captureWorkspaceDocumentRevision,
    createWorkspaceStore,
    isWorkspaceDocumentRevisionCurrent,
} from '../stores/useWorkspaceStore';
import { useWorkingPdf } from './useWorkingPdf';

async function sourcePdf(): Promise<File> {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 50]);
    pdf.addPage([200, 60]);
    pdf.addPage([300, 70]);
    const bytes = await pdf.save();
    const buffer = Uint8Array.from(bytes).buffer;
    const file = new File([buffer], 'source.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
        value: async () => buffer.slice(0),
    });
    return file;
}

interface LayeredSourcePdf {
    file: File;
    visibleId: number;
    hiddenId: number;
}

/** PDF có một OCG ON và một OCG OFF để khóa semantics untouched/explicit. */
async function layeredSourcePdf(): Promise<LayeredSourcePdf> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([120, 80]);
    const visibleRef = pdf.context.register(
        pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Artwork') }),
    );
    const hiddenRef = pdf.context.register(
        pdf.context.obj({
            Type: 'OCG',
            Name: PDFString.of('Ghi chu noi bo'),
            Usage: { View: { ViewState: PDFName.of('OFF') } },
        }),
    );
    page.node.set(
        PDFName.of('Contents'),
        pdf.context.register(pdf.context.stream(
            '/OC /Artwork BDC 0 0 10 10 re f EMC /OC /Note BDC 20 20 10 10 re f EMC',
        )),
    );
    page.node.set(PDFName.of('Resources'), pdf.context.obj({
        Properties: { Artwork: visibleRef, Note: hiddenRef },
    }));
    pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.obj({
        OCGs: [visibleRef, hiddenRef],
        D: {
            BaseState: PDFName.of('ON'),
            ON: [visibleRef],
            OFF: [hiddenRef],
            Locked: [hiddenRef],
            Order: [visibleRef, hiddenRef],
            AS: [{
                Event: PDFName.of('Print'),
                Category: [PDFName.of('Print')],
                OCGs: [hiddenRef],
            }],
        },
    }));
    pdf.catalog.set(PDFName.of('OutputIntents'), pdf.context.obj([{
        Type: PDFName.of('OutputIntent'),
        S: PDFName.of('GTS_PDFX'),
        OutputConditionIdentifier: PDFString.of('Coated FOGRA39'),
    }]));
    const bytes = await pdf.save();
    const buffer = Uint8Array.from(bytes).buffer;
    const file = new File([buffer], 'layered.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
        value: async () => buffer.slice(0),
    });
    return {
        file,
        visibleId: visibleRef.objectNumber,
        hiddenId: hiddenRef.objectNumber,
    };
}

function defaultOcgConfig(doc: PDFDocument): PDFDict | undefined {
    return doc.catalog
        .lookupMaybe(PDFName.of('OCProperties'), PDFDict)
        ?.lookupMaybe(PDFName.of('D'), PDFDict);
}

function ocgNamesInConfig(doc: PDFDocument, key: string): string[] {
    const arr = defaultOcgConfig(doc)?.lookupMaybe(PDFName.of(key), PDFArray);
    const names: string[] = [];
    for (let index = 0; arr && index < arr.size(); index += 1) {
        const name = arr
            .lookupMaybe(index, PDFDict)
            ?.lookupMaybe(PDFName.of('Name'), PDFString)
            ?.decodeText();
        if (name) names.push(name);
    }
    return names;
}

function ocgByName(doc: PDFDocument, expectedName: string): PDFDict | undefined {
    const ocgs = doc.catalog
        .lookupMaybe(PDFName.of('OCProperties'), PDFDict)
        ?.lookupMaybe(PDFName.of('OCGs'), PDFArray);
    for (let index = 0; ocgs && index < ocgs.size(); index += 1) {
        const ocg = ocgs.lookupMaybe(index, PDFDict);
        const name = ocg?.lookupMaybe(PDFName.of('Name'), PDFString)?.decodeText();
        if (name === expectedName) return ocg;
    }
    return undefined;
}

function firstOutputConditionId(doc: PDFDocument): string | undefined {
    return doc.catalog
        .lookupMaybe(PDFName.of('OutputIntents'), PDFArray)
        ?.lookupMaybe(0, PDFDict)
        ?.lookupMaybe(PDFName.of('OutputConditionIdentifier'), PDFString)
        ?.decodeText();
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
    });
}

describe('useWorkingPdf', () => {
    it('materializes reorder, deletion, duplication and per-instance rotation', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        store.setState({
            file,
            viewerPageOrder: [3, 1, 1],
            viewerPageRotations: [90, 0, 180],
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        let working: File | null = null;
        await act(async () => {
            working = await result.current();
        });
        expect(working).not.toBeNull();
        expect(working).not.toBe(file);
        if (!working) throw new Error('Thiếu PDF làm việc trong test.');

        const output = await PDFDocument.load(await readBlob(working));
        expect(output.getPageCount()).toBe(3);
        expect(output.getPage(0).getSize()).toEqual({ width: 300, height: 70 });
        expect(output.getPage(0).getRotation().angle).toBe(90);
        expect(output.getPage(1).getSize()).toEqual({ width: 100, height: 50 });
        expect(output.getPage(1).getRotation().angle).toBe(0);
        expect(output.getPage(2).getSize()).toEqual({ width: 100, height: 50 });
        expect(output.getPage(2).getRotation().angle).toBe(180);
    });

    it('fails closed when the live order references a missing source page', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        store.setState({ file, viewerPageOrder: [4], viewerPageRotations: [0] });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        await expect(result.current()).rejects.toThrow();
    });

    it('đọc revision mới nhất tại lúc gọi dù consumer còn giữ resolver của render cũ', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });
        const resolverFromFirstRender = result.current;

        act(() => {
            store.getState().setViewerPageOrder([2, 1]);
            store.getState().setViewerPageInstanceIds(['page-2', 'page-1']);
            store.getState().setViewerPageRotations([90, 0]);
        });

        const working = await resolverFromFirstRender();
        if (!working) throw new Error('Thiếu PDF làm việc trong test.');
        const output = await PDFDocument.load(await readBlob(working));
        expect(output.getPageCount()).toBe(2);
        expect(output.getPage(0).getSize()).toEqual({ width: 200, height: 60 });
        expect(output.getPage(0).getRotation().angle).toBe(90);
    });

    it('rebase File truyền từ render cũ sau khi barrier publish Working File mới', async () => {
        const oldFile = await sourcePdf();
        const newFile = await sourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(oldFile);
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
        store.getState().setDocumentPreparationBarrier(() => barrier);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        const pending = result.current(oldFile);
        act(() => store.getState().setFile(newFile));
        releaseBarrier();

        await expect(pending).resolves.toBe(newFile);
    });

    it('fail-closed khi barrier chốt Edit PDF thất bại', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().setDocumentPreparationBarrier(async () => {
            throw new Error('publish edit thất bại');
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        await expect(result.current(file)).rejects.toThrow('publish edit thất bại');
    });

    it('preview unprepared không tự kích hoạt barrier Edit PDF', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        const barrier = vi.fn(async () => undefined);
        store.getState().setDocumentPreparationBarrier(barrier);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        await expect(result.current.resolveUnprepared()).resolves.toBe(file);
        expect(barrier).not.toHaveBeenCalled();
    });

    it('giữ nguyên source default-OFF khi OCG chưa được người dùng chạm', async () => {
        const { file, hiddenId } = await layeredSourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().seedOcgVisibilityDefaults(hiddenId ? [hiddenId] : [], file, 0);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        expect(store.getState().ocgVisibilityProvenance.intent).toBe('source-default');
        await expect(result.current.resolveUnprepared()).resolves.toBe(file);
        const source = await PDFDocument.load(await readBlob(file));
        expect(ocgNamesInConfig(source, 'OFF')).toEqual(['Ghi chu noi bo']);
    });

    it('materialize explicit show-all dù hidden IDs là mảng rỗng và giữ metadata OCG', async () => {
        const { file, hiddenId } = await layeredSourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().seedOcgVisibilityDefaults([hiddenId], file, 0);
        store.getState().setHiddenOcgLayerIds([]);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        expect(store.getState().ocgVisibilityProvenance.intent).toBe('explicit');
        const working = await result.current.resolveUnprepared();
        expect(working).not.toBe(file);
        if (!working) throw new Error('Thiếu PDF materialize trạng thái layer.');
        const output = await PDFDocument.load(await readBlob(working));
        expect(ocgNamesInConfig(output, 'OFF')).toEqual([]);
        expect(ocgNamesInConfig(output, 'ON')).toEqual(['Artwork', 'Ghi chu noi bo']);
        expect(ocgNamesInConfig(output, 'Locked')).toEqual(['Ghi chu noi bo']);
        expect(defaultOcgConfig(output)?.lookupMaybe(PDFName.of('Order'), PDFArray)?.size()).toBe(2);
        expect(defaultOcgConfig(output)?.lookupMaybe(PDFName.of('AS'), PDFArray)?.size()).toBe(1);
        expect(
            ocgByName(output, 'Ghi chu noi bo')
                ?.lookupMaybe(PDFName.of('Usage'), PDFDict)
                ?.lookupMaybe(PDFName.of('View'), PDFDict)
                ?.lookupMaybe(PDFName.of('ViewState'), PDFName)
                ?.asString(),
        ).toBe('/OFF');
        expect(firstOutputConditionId(output)).toBe('Coated FOGRA39');
    });

    it('giữ explicit khi giá trị trùng baseline và chỉ reset action mới về untouched', async () => {
        const { file, visibleId, hiddenId } = await layeredSourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().seedOcgVisibilityDefaults([hiddenId], file, 0);
        store.getState().setHiddenOcgLayerIds([hiddenId, visibleId, hiddenId]);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        const working = await result.current.resolveUnprepared();
        if (!working) throw new Error('Thiếu PDF materialize trạng thái layer.');
        const output = await PDFDocument.load(await readBlob(working));
        expect(ocgNamesInConfig(output, 'OFF')).toEqual(['Artwork', 'Ghi chu noi bo']);

        const explicitSnapshot = result.current.capture();
        if (!explicitSnapshot) throw new Error('Thiếu snapshot OCG explicit.');
        store.getState().setHiddenOcgLayerIds([hiddenId]);
        expect(result.current.isCurrent(explicitSnapshot)).toBe(false);
        expect(store.getState().ocgVisibilityProvenance.intent).toBe('explicit');
        const sameAsBaseline = await result.current.resolveUnprepared();
        expect(sameAsBaseline).not.toBe(file);

        store.getState().resetOcgVisibilityToSourceDefault();
        expect(store.getState().ocgVisibilityProvenance.intent).toBe('source-default');
        await expect(result.current.resolveUnprepared()).resolves.toBe(file);
    });

    it('baseline đến sau không được xóa explicit show-all đã chạm trước', async () => {
        const { file } = await layeredSourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().setSelectionFileId('fid-layered');
        store.getState().setHiddenOcgLayerIds([]);
        store.getState().seedOcgVisibilityDefaults([], file, 0, 'fid-layered');

        expect(store.getState().ocgVisibilityProvenance).toMatchObject({
            intent: 'explicit',
            baselineLoaded: true,
            sourceFileId: 'fid-layered',
        });
    });

    it('fail-closed khi /OCProperties sai kiểu nên không thể áp dụng override', async () => {
        const pdf = await PDFDocument.create();
        pdf.addPage([100, 100]);
        pdf.catalog.set(PDFName.of('OCProperties'), PDFName.of('Broken'));
        const bytes = await pdf.save();
        const buffer = Uint8Array.from(bytes).buffer;
        const file = new File([buffer], 'broken-ocg.pdf', { type: 'application/pdf' });
        Object.defineProperty(file, 'arrayBuffer', {
            value: async () => buffer.slice(0),
        });
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().setHiddenOcgLayerIds([]);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        await expect(result.current.resolveUnprepared()).rejects.toThrow('/OCProperties');
    });

    it.each([-1, 999_999])('fail-closed với mã OCG lạ/ảo %s', async (invalidId) => {
        const { file, hiddenId } = await layeredSourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().seedOcgVisibilityDefaults([hiddenId], file, 0);
        store.getState().setHiddenOcgLayerIds([invalidId]);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        await expect(result.current.resolveUnprepared()).rejects.toThrow(/OCG/);
    });

    it('token legacy thiếu OCG fail-closed ngay khi live intent là explicit', async () => {
        const { file, hiddenId } = await layeredSourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        store.getState().setSelectionFileId('fid-layered');
        store.getState().seedOcgVisibilityDefaults([hiddenId], file, 0, 'fid-layered');
        const legacyToken = {
            file,
            viewerPageOrder: undefined,
            viewerPageInstanceIds: undefined,
            viewerPageRotations: undefined,
            editGeneration: 0,
        };
        expect(isWorkspaceDocumentRevisionCurrent(legacyToken, store.getState())).toBe(true);

        store.getState().setHiddenOcgLayerIds([]);
        expect(isWorkspaceDocumentRevisionCurrent(legacyToken, store.getState())).toBe(false);
    });

    it('snapshot clone/freeze state và materialize đúng revision đã chụp', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        const order = [3, 1];
        const instanceIds = ['page-3', 'page-1'];
        const rotations = [180, 0];
        store.getState().setFile(file);
        store.getState().setViewerPageOrder(order);
        store.getState().setViewerPageInstanceIds(instanceIds);
        store.getState().setViewerPageRotations(rotations);
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>
        );
        const { result } = renderHook(() => useWorkingPdf(), { wrapper });

        const snapshot = result.current.capture();
        if (!snapshot) throw new Error('Thiếu snapshot PDF làm việc trong test.');
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.viewerPageOrder)).toBe(true);
        expect(result.current.isCurrent(snapshot)).toBe(true);

        order[0] = 1;
        instanceIds[0] = 'mutated';
        rotations[0] = 0;
        expect(snapshot.viewerPageOrder).toEqual([3, 1]);
        expect(snapshot.viewerPageInstanceIds).toEqual(['page-3', 'page-1']);
        expect(snapshot.viewerPageRotations).toEqual([180, 0]);

        const working = await result.current.materialize(snapshot);
        const output = await PDFDocument.load(await readBlob(working));
        expect(output.getPage(0).getSize()).toEqual({ width: 300, height: 70 });
        expect(output.getPage(0).getRotation().angle).toBe(180);
    });

    it('fence phân biệt File reference, instance, rotation, edit generation và undefined/[]', async () => {
        const file = await sourcePdf();
        const store = createWorkspaceStore();
        store.getState().setFile(file);
        const sourceToken = captureWorkspaceDocumentRevision(store.getState());
        expect(isWorkspaceDocumentRevisionCurrent(sourceToken, store.getState())).toBe(true);

        store.getState().setViewerPageOrder([]);
        expect(isWorkspaceDocumentRevisionCurrent(sourceToken, store.getState())).toBe(false);
        store.getState().setViewerPageOrder(undefined);

        const beforeInstance = captureWorkspaceDocumentRevision(store.getState());
        store.getState().setViewerPageInstanceIds(['instance-a']);
        expect(isWorkspaceDocumentRevisionCurrent(beforeInstance, store.getState())).toBe(false);
        store.getState().setViewerPageInstanceIds(undefined);

        const beforeRotation = captureWorkspaceDocumentRevision(store.getState());
        store.getState().setViewerPageRotations([90]);
        expect(isWorkspaceDocumentRevisionCurrent(beforeRotation, store.getState())).toBe(false);
        store.getState().setViewerPageRotations(undefined);

        const beforeEdit = captureWorkspaceDocumentRevision(store.getState());
        store.getState().advanceEditGeneration();
        expect(isWorkspaceDocumentRevisionCurrent(beforeEdit, store.getState())).toBe(false);

        const sameMetadataFile = new File([await readBlob(file)], file.name, {
            type: file.type,
            lastModified: file.lastModified,
        });
        const oldGeneration = store.getState().editGeneration;
        store.getState().setSelectionFileId('fid-old-source');
        store.getState().seedOcgVisibilityDefaults(
            [7],
            file,
            oldGeneration,
            'fid-old-source',
        );
        const beforeFileSwap = captureWorkspaceDocumentRevision(store.getState());
        store.getState().setFile(sameMetadataFile);
        expect(isWorkspaceDocumentRevisionCurrent(beforeFileSwap, store.getState())).toBe(false);
        expect(store.getState().selectionFileId).toBe('');
        expect(store.getState().ocgVisibilityProvenance.baselineLoaded).toBe(false);

        // Response cũ đến muộn không được gắn ID OCG lên File mới cùng metadata.
        store.getState().seedOcgVisibilityDefaults(
            [7],
            file,
            oldGeneration,
            'fid-old-source',
        );
        expect(store.getState().hiddenOcgLayerIds).toEqual([]);
    });
});
