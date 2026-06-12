import { useState, useEffect } from 'react';
import { getQRBlob, DEFAULT_QR_STYLE } from '@/engine/barcode/qrEngine';
import { generateBarcodeDataURL } from '@/engine/barcode/barcodeEngine';

/**
 * VdpPreviewImage — Renders a live preview of a VDP field (QR code or barcode).
 * Generates a data URL asynchronously and displays it as an image.
 */
export const VdpPreviewImage = ({ field }: { field: any }) => {
    const [dataUrl, setDataUrl] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;
        const generate = async () => {
            try {
                if (field.type === 'qrcode') {
                    const blob = await getQRBlob({
                        data: "https://www.printsolutions.vn/",
                        size: 400,
                        errorCorrection: field.errorCorrection || 'M',
                        style: field.qrStyle || DEFAULT_QR_STYLE
                    }, 'png');
                    const url = await new Promise<string>((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.readAsDataURL(blob);
                    });
                    if (isMounted) setDataUrl(url);
                } else if (field.type === 'barcode') {
                    const barcodeType = field.barcodeType || 'code128';
                    // Sample data appropriate for each barcode type
                    const sampleData: Record<string, string> = {
                        code128: 'SAMPLE-12345',
                        ean13: '4006381333931',
                        upca: '012345678905',
                        ean8: '96385074',
                        code39: 'SAMPLE39',
                        itf14: '10012345000017',
                        codabar: 'A12345B',
                    };
                    const url = await generateBarcodeDataURL({
                        type: barcodeType,
                        data: sampleData[barcodeType] || 'SAMPLE-12345',
                        scale: 3,
                        height: field.barHeight || 12,
                        barColor: field.barColor || '#000000',
                        bgColor: field.bgColor || '#FFFFFF',
                        transparentBg: field.transparentBg || false,
                        showText: field.showText !== false,
                        quietZone: field.quietZone ?? 2,
                        rotation: field.rotation || 0,
                        fontSize: field.fontSize || 10,
                        textAlign: field.textAlign || 'center'
                    }, 'png');
                    if (isMounted) setDataUrl(url);
                }
            } catch (e) {
                console.error("Lỗi preview VDP:", e);
            }
        };
        generate();
        return () => { isMounted = false; };
    }, [field]);

    if (!dataUrl) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-slate-100 text-slate-400 text-[10px]">
                Đang tải...
            </div>
        );
    }

    // Barcode: backend kéo giãn lấp đầy khung (stretch) → preview cũng phải 'fill'
    // để khớp cả khung xanh lẫn file output. QR: scale đều + canh giữa → 'contain'.
    const fitClass = field.type === 'barcode' ? 'object-fill' : 'object-contain';
    return (
        <img src={dataUrl} alt="VDP Preview" className={`w-full h-full ${fitClass} pointer-events-none`} />
    );
};

/**
 * Global page render cache: stores blob URLs keyed by "pageNum_rotation_baseWidth".
 * Shared across all AcrobatViewer instances.
 */
export const pageBlobCache = new Map<string, string>();

/**
 * Thumbnail cache (low-res, for sidebar). Shared reference holder.
 */
export const thumbCacheRef = { current: new Map<string, string>() };

/**
 * Renders a PDF page to a blob URL via pdfjs.
 * Returns the blob URL and natural dimensions, or null on failure.
 */
export async function renderPageToBlob(
    pdf: any, 
    pageNum: number, 
    rotation: number, 
    targetWidth: number
): Promise<{ url: string; w: number; h: number } | null> {
    try {
        const page = await pdf.getPage(pageNum);
        const vp = page.getViewport({ scale: 1, rotation });
        const scale = targetWidth / vp.width;
        const scaledVp = page.getViewport({ scale, rotation });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(scaledVp.width);
        canvas.height = Math.round(scaledVp.height);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport: scaledVp }).promise;
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        canvas.width = 0; canvas.height = 0; // free memory
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        return { url, w: scaledVp.width, h: scaledVp.height };
    } catch { return null; }
}
