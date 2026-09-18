// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergeEditedPagesIntoDocument } from './designAppLauncher';

describe('designAppLauncher partial page edit and merge', () => {
    it('gộp đúng các trang đã sửa vào tài liệu gốc theo đúng vị trí', async () => {
        // Tạo tài liệu gốc 4 trang: P1, P2, P3, P4
        const origDoc = await PDFDocument.create();
        for (let i = 1; i <= 4; i++) {
            const page = origDoc.addPage([100, 100]);
            page.drawText(`Original Page ${i}`);
        }
        const origBytes = await origDoc.save();

        // Tạo tài liệu đã sửa gồm 2 trang: thay thế trang 2 (index 1) và trang 3 (index 2)
        const editedDoc = await PDFDocument.create();
        const ep1 = editedDoc.addPage([200, 200]); // kích thước mới
        ep1.drawText('Edited Page 2');
        const ep2 = editedDoc.addPage([300, 300]); // kích thước mới
        ep2.drawText('Edited Page 3');
        const editedBytes = await editedDoc.save();

        // Gộp trang đã sửa vào vị trí [1, 2]
        const mergedBytes = await mergeEditedPagesIntoDocument(origBytes, editedBytes, [1, 2]);

        // Đọc lại tài liệu sau khi gộp
        const resultDoc = await PDFDocument.load(mergedBytes);
        expect(resultDoc.getPageCount()).toBe(4);

        // Trang 1 và trang 4 vẫn giữ kích thước 100x100
        expect(resultDoc.getPage(0).getWidth()).toBe(100);
        expect(resultDoc.getPage(0).getHeight()).toBe(100);
        expect(resultDoc.getPage(3).getWidth()).toBe(100);
        expect(resultDoc.getPage(3).getHeight()).toBe(100);

        // Trang 2 và trang 3 nhận kích thước mới từ bản sửa
        expect(resultDoc.getPage(1).getWidth()).toBe(200);
        expect(resultDoc.getPage(1).getHeight()).toBe(200);
        expect(resultDoc.getPage(2).getWidth()).toBe(300);
        expect(resultDoc.getPage(2).getHeight()).toBe(300);
    });

    it('trích đúng các trang được chọn ra file tạm với extractPagesForExternalEdit', async () => {
        const { extractPagesForExternalEdit } = await import('./designAppLauncher');
        const doc = await PDFDocument.create();
        doc.addPage([100, 100]);
        doc.addPage([200, 200]);
        doc.addPage([300, 300]);
        const bytes = await doc.save();

        const fakeFile = {
            name: 'test.pdf',
            arrayBuffer: async () => bytes.buffer.slice(0),
        } as unknown as File;

        (window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }).__TAURI_INTERNALS__ = {
            invoke: vi.fn(async (cmd: string, args?: { paths?: string[] }) => {
                if (cmd === 'plugin:path|resolve_directory') return 'C:\\Temp';
                if (cmd === 'plugin:path|join' && args?.paths) return args.paths.join('\\');
                return undefined;
            }),
        };
        const { tempFilePath, pageIndices } = await extractPagesForExternalEdit(fakeFile, [1], 'test.pdf');
        expect(tempFilePath).toContain('prynx_test_p2_');
        expect(pageIndices).toEqual([1]);
    });
});
