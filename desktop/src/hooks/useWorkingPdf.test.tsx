// @vitest-environment jsdom

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { WorkspaceContext, createWorkspaceStore } from '../stores/useWorkspaceStore';
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
});
