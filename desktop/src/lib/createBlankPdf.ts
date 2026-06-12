/**
 * createBlankPdf — Tạo một file PDF trắng theo kích thước mm để bắt đầu
 * thiết kế từ đầu (tương tự "New Document" của Illustrator).
 */
import { PDFDocument } from 'pdf-lib';

const MM_TO_PT = 72 / 25.4; // ≈ 2.83465

export interface BlankDocOptions {
    widthMm: number;
    heightMm: number;
    pageCount?: number;
    name?: string;
}

export async function createBlankPdfFile(opts: BlankDocOptions): Promise<File> {
    const { widthMm, heightMm, pageCount = 1, name } = opts;
    const wPt = Math.max(1, widthMm) * MM_TO_PT;
    const hPt = Math.max(1, heightMm) * MM_TO_PT;

    const doc = await PDFDocument.create();
    for (let i = 0; i < Math.max(1, pageCount); i++) {
        doc.addPage([wPt, hPt]);
    }
    const bytes = await doc.save();

    const fileName = name && name.trim()
        ? (name.trim().toLowerCase().endsWith('.pdf') ? name.trim() : `${name.trim()}.pdf`)
        : `Untitled_${Math.round(widthMm)}x${Math.round(heightMm)}mm.pdf`;

    const file = new File([bytes as any], fileName, { type: 'application/pdf' });

    // Đánh dấu là tài liệu trắng mới tạo → không thêm vào Recent Files,
    // và kèm kích thước/đếm trang để viewer dựng trang TỨC THÌ (không qua pdfjs/pdfium).
    try {
        Object.defineProperty(file, 'isBlank', { value: true });
        Object.defineProperty(file, 'blankWidthPt', { value: wPt });
        Object.defineProperty(file, 'blankHeightPt', { value: hPt });
        Object.defineProperty(file, 'blankPageCount', { value: Math.max(1, pageCount) });
    } catch { /* noop */ }

    return file;
}
