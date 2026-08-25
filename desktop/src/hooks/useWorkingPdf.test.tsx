// @vitest-environment jsdom

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
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
        const beforeFileSwap = captureWorkspaceDocumentRevision(store.getState());
        store.getState().setFile(sameMetadataFile);
        expect(isWorkspaceDocumentRevisionCurrent(beforeFileSwap, store.getState())).toBe(false);
    });
});
