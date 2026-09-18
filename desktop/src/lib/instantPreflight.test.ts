import { describe, it, expect } from 'vitest';
import { PDFDocument, rgb, cmyk, degrees } from 'pdf-lib';
import { runInstantPreflight } from './instantPreflight';

describe('instantPreflight — Quét lỗi chế bản tức thì khi Ctrl + S', () => {
    it('Phát hiện tài liệu sạch (CMYK chuẩn, không hairline, không rich black)', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 300]);
        // Vẽ nét CMYK chuẩn dày 0.5pt (> 0.1pt)
        page.drawLine({
            start: { x: 10, y: 10 },
            end: { x: 100, y: 100 },
            thickness: 0.5,
            color: cmyk(0, 0, 0, 1), // 100% K thuần
        });

        const pdfBytes = await doc.save();
        const result = await runInstantPreflight(pdfBytes);

        expect(result.hasErrors).toBe(false);
        expect(result.summary.hairlineCount).toBe(0);
        expect(result.summary.richBlackCount).toBe(0);
        expect(result.summary.hasRgb).toBe(false);
    });

    it('Phát hiện nét mảnh Hairline (<= 0.1pt)', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 300]);
        // Vẽ nét mảnh 0.05pt
        page.drawLine({
            start: { x: 10, y: 10 },
            end: { x: 100, y: 100 },
            thickness: 0.05,
            color: cmyk(0, 0, 0, 1),
        });

        const pdfBytes = await doc.save();
        const result = await runInstantPreflight(pdfBytes);

        expect(result.summary.hairlineCount).toBeGreaterThanOrEqual(1);
        expect(result.summary.minHairlineWidthPt).toBeCloseTo(0.05, 2);
        const hairlineIssue = result.issues.find(i => i.type === 'hairline');
        expect(hairlineIssue).toBeDefined();
        expect(hairlineIssue?.severity).toBe('warning');
    });

    it('Phát hiện màu RGB được dùng trong vector', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 300]);
        // Vẽ hình chữ nhật màu RGB đỏ tươi
        page.drawRectangle({
            x: 20,
            y: 20,
            width: 50,
            height: 50,
            color: rgb(1, 0, 0),
        });

        const pdfBytes = await doc.save();
        const result = await runInstantPreflight(pdfBytes);

        expect(result.summary.hasRgb).toBe(true);
        const rgbIssue = result.issues.find(i => i.type === 'rgb_color');
        expect(rgbIssue).toBeDefined();
    });

    it('Phát hiện chữ Rich Black (đen phối 4 màu C+M+Y+K)', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 300]);
        // Vẽ chữ với màu phối CMYK Rich Black (C:40, M:30, Y:30, K:100)
        page.drawText('Product Title', {
            x: 50,
            y: 150,
            size: 14,
            color: cmyk(0.4, 0.3, 0.3, 1.0),
        });

        const pdfBytes = await doc.save();
        const result = await runInstantPreflight(pdfBytes);

        expect(result.summary.richBlackCount).toBeGreaterThanOrEqual(1);
        const rbIssue = result.issues.find(i => i.type === 'rich_black');
        expect(rbIssue).toBeDefined();
        expect(rbIssue?.title).toContain('Rich Black');
    });

    it('Phát hiện kênh màu pha Spot Color (ví dụ DieCut khuôn bế)', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 300]);
        const { PDFName } = await import('pdf-lib');
        const csDict = doc.context.obj({
            DieCut: [PDFName.of('Separation'), PDFName.of('DieCut'), PDFName.of('DeviceCMYK'), doc.context.obj({})],
        });
        page.node.set(PDFName.of('Resources'), doc.context.obj({ ColorSpace: csDict }));
        const pdfBytes = await doc.save();
        const result = await runInstantPreflight(pdfBytes);
        expect(result.summary.spotColors).toContain('DieCut');
    });

    it('Xử lý an toàn khi file PDF hỏng hoặc rỗng', async () => {
        const corruptBytes = new Uint8Array([1, 2, 3, 4, 5]);
        const result = await runInstantPreflight(corruptBytes);

        expect(result.hasErrors).toBe(true);
        expect(result.issues.length).toBeGreaterThan(0);
    });
});
