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

    it('loại bỏ triệt để PieceInfo (Illustrator Private Data) cho tài liệu nhiều trang để Illustrator không mở lại toàn bộ artboard cũ', async () => {
        const { extractPagesForExternalEdit } = await import('./designAppLauncher');
        const { PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.create();
        const p1 = doc.addPage([100, 100]);
        doc.addPage([100, 100]); // Trang 2 để tạo tài liệu nhiều trang (pageCount > 1)
        // Gắn giả lập PieceInfo vào trang giống như Adobe Illustrator làm
        const pieceInfo = doc.context.obj({
            Illustrator: doc.context.obj({
                Private: doc.context.obj({ NumBlock: 5 }),
            }),
        });
        p1.node.set(PDFName.of('PieceInfo'), pieceInfo);
        doc.catalog.set(PDFName.of('PieceInfo'), pieceInfo);
        const bytes = await doc.save();

        let savedBytes: Uint8Array | null = null;
        (window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }).__TAURI_INTERNALS__ = {
            invoke: vi.fn(async (cmd: string, args?: { path?: string; contents?: Uint8Array; paths?: string[] }) => {
                if (cmd === 'plugin:path|resolve_directory') return 'C:\\Temp';
                if (cmd === 'plugin:path|join' && args?.paths) return args.paths.join('\\');
                if (cmd === 'write_file_atomic' && args?.contents) {
                    savedBytes = args.contents;
                    return undefined;
                }
                return undefined;
            }),
        };

        const fakeFile = {
            name: 'multi_artboards.pdf',
            arrayBuffer: async () => bytes.buffer.slice(0),
        } as unknown as File;

        await extractPagesForExternalEdit(fakeFile, [0], 'multi_artboards.pdf');
        expect(savedBytes).not.toBeNull();
        const extractedDoc = await PDFDocument.load(savedBytes!);
        expect(extractedDoc.getPageCount()).toBe(1);
        expect(extractedDoc.getPage(0).node.has(PDFName.of('PieceInfo'))).toBe(false);
        expect(extractedDoc.catalog.has(PDFName.of('PieceInfo'))).toBe(false);
    });

    it('bảo tồn PieceInfo cho tài liệu đơn trang (pageCount === 1) để Illustrator giữ nguyên Live Text và layer gốc', async () => {
        const { extractPagesForExternalEdit } = await import('./designAppLauncher');
        const { PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.create();
        const p1 = doc.addPage([100, 100]); // Chỉ 1 trang
        const pieceInfo = doc.context.obj({
            Illustrator: doc.context.obj({
                Private: doc.context.obj({ NumBlock: 1 }),
            }),
        });
        p1.node.set(PDFName.of('PieceInfo'), pieceInfo);
        doc.catalog.set(PDFName.of('PieceInfo'), pieceInfo);
        const bytes = await doc.save();

        let savedBytes: Uint8Array | null = null;
        (window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }).__TAURI_INTERNALS__ = {
            invoke: vi.fn(async (cmd: string, args?: { path?: string; contents?: Uint8Array; paths?: string[] }) => {
                if (cmd === 'plugin:path|resolve_directory') return 'C:\\Temp';
                if (cmd === 'plugin:path|join' && args?.paths) return args.paths.join('\\');
                if (cmd === 'write_file_atomic' && args?.contents) {
                    savedBytes = args.contents;
                    return undefined;
                }
                return undefined;
            }),
        };

        const fakeFile = {
            name: 'single_artboard.pdf',
            arrayBuffer: async () => bytes.buffer.slice(0),
        } as unknown as File;

        await extractPagesForExternalEdit(fakeFile, [0], 'single_artboard.pdf');
        expect(savedBytes).not.toBeNull();
        const extractedDoc = await PDFDocument.load(savedBytes!);
        expect(extractedDoc.getPageCount()).toBe(1);
        expect(extractedDoc.getPage(0).node.has(PDFName.of('PieceInfo'))).toBe(true);
    });

    it('normalizePageBoxes chuẩn hoá toạ độ trang bị offset về gốc (0, 0) và tịnh tiến các Box', async () => {
        const { normalizePageBoxes } = await import('./designAppLauncher');
        const { PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.create();
        const p = doc.addPage();
        // Giả lập file tem bế có MediaBox offset x=50, y=80, w=300, h=400
        p.setMediaBox(50, 80, 300, 400);
        p.setTrimBox(60, 90, 280, 380);
        p.setBleedBox(55, 85, 290, 390);

        const pieceInfo = doc.context.obj({
            Illustrator: doc.context.obj({ Private: doc.context.obj({ NumBlock: 1 }) }),
        });
        p.node.set(PDFName.of('PieceInfo'), pieceInfo);

        const modified = normalizePageBoxes(p);
        expect(modified).toBe(true);

        // MediaBox phải về [0, 0, 300, 400]
        const mb = p.getMediaBox();
        expect(mb.x).toBe(0);
        expect(mb.y).toBe(0);
        expect(mb.width).toBe(300);
        expect(mb.height).toBe(400);

        // TrimBox phải được tịnh tiến tương ứng
        const tb = p.getTrimBox();
        expect(tb.x).toBe(10); // 60 - 50
        expect(tb.y).toBe(10); // 90 - 80
        expect(tb.width).toBe(280);
        expect(tb.height).toBe(380);

        // BleedBox phải được tịnh tiến tương ứng
        const bb = p.getBleedBox();
        expect(bb.x).toBe(5); // 55 - 50
        expect(bb.y).toBe(5); // 85 - 80

        // PieceInfo phải bị xóa
        expect(p.node.has(PDFName.of('PieceInfo'))).toBe(false);

        // Trang đã chuẩn nếu gọi lại thì trả về false
        const secondCall = normalizePageBoxes(p);
        expect(secondCall).toBe(false);
    });

    it('extractPagesForExternalEdit tự động chuẩn hoá toạ độ và xoá PieceInfo khi trang bị offset dù là tài liệu đơn trang', async () => {
        const { extractPagesForExternalEdit } = await import('./designAppLauncher');
        const { PDFName } = await import('pdf-lib');
        const doc = await PDFDocument.create();
        const p1 = doc.addPage();
        p1.setMediaBox(15.2, 28.4, 400, 300); // Lệch gốc toạ độ

        const pieceInfo = doc.context.obj({
            Illustrator: doc.context.obj({ Private: doc.context.obj({ NumBlock: 1 }) }),
        });
        p1.node.set(PDFName.of('PieceInfo'), pieceInfo);
        doc.catalog.set(PDFName.of('PieceInfo'), pieceInfo);
        const bytes = await doc.save();

        let savedBytes: Uint8Array | null = null;
        (window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }).__TAURI_INTERNALS__ = {
            invoke: vi.fn(async (cmd: string, args?: { path?: string; contents?: Uint8Array; paths?: string[] }) => {
                if (cmd === 'plugin:path|resolve_directory') return 'C:\\Temp';
                if (cmd === 'plugin:path|join' && args?.paths) return args.paths.join('\\');
                if (cmd === 'write_file_atomic' && args?.contents) {
                    savedBytes = args.contents;
                    return undefined;
                }
                return undefined;
            }),
        };

        const fakeFile = {
            name: 'sticker_offset.pdf',
            arrayBuffer: async () => bytes.buffer.slice(0),
        } as unknown as File;

        await extractPagesForExternalEdit(fakeFile, [0], 'sticker_offset.pdf');
        expect(savedBytes).not.toBeNull();
        const extractedDoc = await PDFDocument.load(savedBytes!);
        expect(extractedDoc.getPageCount()).toBe(1);

        const outPage = extractedDoc.getPage(0);
        const mb = outPage.getMediaBox();
        expect(mb.x).toBe(0);
        expect(mb.y).toBe(0);
        expect(mb.width).toBeCloseTo(400, 1);
        expect(mb.height).toBeCloseTo(300, 1);

        // PieceInfo phải bị xóa để Illustrator không nạp lại toạ độ offset cũ
        expect(outPage.node.has(PDFName.of('PieceInfo'))).toBe(false);
        expect(extractedDoc.catalog.has(PDFName.of('PieceInfo'))).toBe(false);
    });

    it('ensurePathBackedPdf tự động chuẩn hoá toạ độ file in-memory bị offset trước khi ghi file tạm', async () => {
        const { ensurePathBackedPdf } = await import('./designAppLauncher');
        const doc = await PDFDocument.create();
        const p = doc.addPage();
        p.setMediaBox(30, 45, 250, 180);
        const bytes = await doc.save();

        let savedBytes: Uint8Array | null = null;
        (window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }).__TAURI_INTERNALS__ = {
            invoke: vi.fn(async (cmd: string, args?: { path?: string; contents?: Uint8Array; paths?: string[] }) => {
                if (cmd === 'plugin:path|resolve_directory') return 'C:\\Temp';
                if (cmd === 'plugin:path|join' && args?.paths) return args.paths.join('\\');
                if (cmd === 'write_file_atomic' && args?.contents) {
                    savedBytes = args.contents;
                    return undefined;
                }
                return undefined;
            }),
        };

        const fakeFile = {
            name: 'in_memory_offset.pdf',
            arrayBuffer: async () => bytes.buffer.slice(0),
        } as unknown as File;

        const fullPath = await ensurePathBackedPdf(fakeFile, 'in_memory_offset.pdf');
        expect(fullPath).toContain('in_memory_offset');
        expect(savedBytes).not.toBeNull();

        const loaded = await PDFDocument.load(savedBytes!);
        const mb = loaded.getPage(0).getMediaBox();
        expect(mb.x).toBe(0);
        expect(mb.y).toBe(0);
        expect(mb.width).toBeCloseTo(250, 1);
        expect(mb.height).toBeCloseTo(180, 1);
    });
});
