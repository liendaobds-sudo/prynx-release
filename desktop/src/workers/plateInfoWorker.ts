import { PDFDocument, PDFName } from 'pdf-lib';

interface PdfInfoObject {
    decodeText?: () => string;
    value?: unknown;
}

function readPdfInfo(value: unknown): string {
    if (!value || typeof value !== 'object') return String(value ?? '');
    const info = value as PdfInfoObject;
    const decoded = typeof info.decodeText === 'function' ? info.decodeText() : '';
    if (decoded) return decoded;
    if (info.value) return typeof info.value === 'string' ? info.value : String(info.value);
    return String(value);
}

self.onmessage = async (e: MessageEvent) => {
    const { buf } = e.data;
    try {
        const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
        const labels: Record<number, string> = {};
        const pages = doc.getPages();
        
        for (let i = 0; i < pages.length; i++) {
            const infoUriObj = pages[i].node.get(PDFName.of('PlateInfoURI'));
            if (infoUriObj) {
                let rawStr = readPdfInfo(infoUriObj);
                rawStr = rawStr.replace(/^\(|\)$/g, '');
                try {
                    labels[i + 1] = decodeURIComponent(rawStr);
                } catch {
                    // Chuỗi metadata lỗi mã hóa: bỏ qua nhãn trang và tiếp tục quét.
                }
            } else {
                const infoObj = pages[i].node.get(PDFName.of('PlateInfo'));
                if (infoObj) {
                    labels[i + 1] = readPdfInfo(infoObj);
                }
            }
        }
        
        self.postMessage({ success: true, labels });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ success: false, error: message });
    }
};
