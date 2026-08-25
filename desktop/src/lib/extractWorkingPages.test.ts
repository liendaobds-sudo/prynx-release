// @vitest-environment jsdom

import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
    extractWorkingPagePositions,
    isWorkingPageSelectionCurrent,
} from './extractWorkingPages';

async function workingPdf(): Promise<File> {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 200]);
    const rotated = pdf.addPage([300, 400]);
    rotated.setRotation(degrees(90));
    const bytes = await pdf.save();
    const buffer = Uint8Array.from(bytes).buffer;
    const file = new File([buffer], 'working.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer.slice(0) });
    return file;
}

describe('extractWorkingPagePositions', () => {
    it('từ chối selection cũ khi reorder hoặc duplicate đổi instance tại vị trí đã chọn', () => {
        const selectedPositions = [0, 2];
        const selectedInstances = ['page-a', 'page-c'];

        expect(isWorkingPageSelectionCurrent(
            selectedPositions,
            selectedInstances,
            ['page-a', 'page-b', 'page-c'],
        )).toBe(true);
        expect(isWorkingPageSelectionCurrent(
            selectedPositions,
            selectedInstances,
            ['page-c', 'page-b', 'page-a'],
        )).toBe(false);
        expect(isWorkingPageSelectionCurrent(
            selectedPositions,
            selectedInstances,
            ['page-a', 'page-b', 'page-c-copy'],
        )).toBe(false);
    });

    it('copy đúng vị trí/góc đã bake, không ánh xạ ngược về source page', async () => {
        const result = await extractWorkingPagePositions(await workingPdf(), [1, 0]);
        const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.readAsArrayBuffer(result);
        });
        const output = await PDFDocument.load(bytes);

        expect(result.name).toBe('Bi_Boc_Tach_working.pdf');
        expect(output.getPageCount()).toBe(2);
        expect(output.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
        expect(output.getPage(0).getRotation().angle).toBe(90);
        expect(output.getPage(1).getSize()).toEqual({ width: 100, height: 200 });
    });

    it('fail-closed khi vị trí đã stale', async () => {
        await expect(extractWorkingPagePositions(await workingPdf(), [2]))
            .rejects.toThrow('không còn tồn tại');
    });
});
