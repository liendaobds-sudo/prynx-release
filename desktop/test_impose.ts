import { PDFDocument } from 'pdf-lib';
import { imposePdf } from './src/lib/pdfImposer';

(async () => {
    try {
        const doc = await PDFDocument.create();
        for (let i = 0; i < 8; i++) {
            const page = doc.addPage([595, 842]);
            page.drawText(`Page ${i + 1}`, { x: 100, y: 700, size: 50 });
        }
        const bytes = await doc.save();
        const file = new File([bytes], 'test.pdf', { type: 'application/pdf' });

        const settings = {
            impositionMode: 'booklet',
            bindingMode: 'saddle',
            foliosize: 8,
            chainNup: true,
            foldPattern: 'sig_8p',
            markType: 'none',
            pageOrder: [0, 1, 2, 3, 4, 5, 6, 7]
        };

        const result = await imposePdf(file, settings as any, (msg) => console.log(msg));
        console.log("Success! Blob size:", result.blob.size);
    } catch (e) {
        console.error("FAIL:", e);
    }
})();
