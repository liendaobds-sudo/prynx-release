import { PDFDocument, PDFName } from 'pdf-lib';

self.onmessage = async (e: MessageEvent) => {
    const { buf } = e.data;
    try {
        const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
        const labels: Record<number, string> = {};
        const pages = doc.getPages();
        
        for (let i = 0; i < pages.length; i++) {
            const infoUriObj = pages[i].node.get(PDFName.of('PlateInfoURI'));
            if (infoUriObj) {
                let rawStr = (infoUriObj as any).decodeText?.() || (infoUriObj as any).value || String(infoUriObj);
                rawStr = rawStr.replace(/^\(|\)$/g, '');
                try { labels[i + 1] = decodeURIComponent(rawStr); } catch (e) { }
            } else {
                const infoObj = pages[i].node.get(PDFName.of('PlateInfo'));
                if (infoObj) {
                    labels[i + 1] = (infoObj as any).decodeText?.() || (infoObj as any).value || String(infoObj);
                }
            }
        }
        
        self.postMessage({ success: true, labels });
    } catch (err: any) {
        self.postMessage({ success: false, error: err.message });
    }
};
