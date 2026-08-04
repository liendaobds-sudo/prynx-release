import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { createBlankPdfFile } from './createBlankPdf';

const PT_TO_MM = 25.4 / 72;

describe('createBlankPdfFile', () => {
    it('giữ số đo thật trong tên mặc định và hình học PDF', async () => {
        const file = await createBlankPdfFile({
            widthMm: 147.1,
            heightMm: 51.3,
            pageCount: 1,
        });

        expect(file.name).toBe('Untitled_147.1x51.3mm.pdf');

        const pdf = await PDFDocument.load(await file.arrayBuffer());
        const { width, height } = pdf.getPage(0).getSize();
        expect(width * PT_TO_MM).toBeCloseTo(147.1, 8);
        expect(height * PT_TO_MM).toBeCloseTo(51.3, 8);
    });
});
