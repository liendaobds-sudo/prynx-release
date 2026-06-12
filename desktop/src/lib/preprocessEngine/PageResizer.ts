// src/lib/preprocessEngine/PageResizer.ts
// =========================================================================
//  Đổi khổ trang PDF — resize, scale, center content on new page size
// =========================================================================

import { PDFDocument } from 'pdf-lib';

const MM_TO_POINTS = 2.83465;

export type ScaleMode = 'fit' | 'fill' | 'stretch' | 'center_no_scale';

export interface ResizeOptions {
    targetW: number;   // mm
    targetH: number;   // mm
    scaleMode: ScaleMode;
    applyTo: 'all' | 'even' | 'odd' | number[];  // 1-based page numbers
}

/**
 * Should this page be processed?
 */
function shouldProcess(pageIndex: number, applyTo: ResizeOptions['applyTo']): boolean {
    if (applyTo === 'all') return true;
    if (applyTo === 'even') return (pageIndex + 1) % 2 === 0;
    if (applyTo === 'odd') return (pageIndex + 1) % 2 === 1;
    return applyTo.includes(pageIndex + 1);
}

/**
 * Resize pages in a PDF to target dimensions.
 *
 * @param inputBytes - Raw PDF bytes
 * @param options    - Target size, scale mode, page selection
 * @returns New PDF bytes with resized pages
 */
export async function resizePages(
    inputBytes: Uint8Array | ArrayBuffer,
    options: ResizeOptions
): Promise<Uint8Array> {
    const srcPdf = await PDFDocument.load(inputBytes);
    const outputPdf = await PDFDocument.create();

    const targetWPt = options.targetW * MM_TO_POINTS;
    const targetHPt = options.targetH * MM_TO_POINTS;
    const pageCount = srcPdf.getPageCount();

    for (let i = 0; i < pageCount; i++) {
        const srcPage = srcPdf.getPage(i);
        const { width: srcW, height: srcH } = srcPage.getSize();

        if (!shouldProcess(i, options.applyTo)) {
            // Copy unchanged
            const [copied] = await outputPdf.copyPages(srcPdf, [i]);
            outputPdf.addPage(copied);
            continue;
        }

        // Create new page with target dimensions
        const newPage = outputPdf.addPage([targetWPt, targetHPt]);

        // Embed source page
        const [embedded] = await outputPdf.embedPages([srcPage]);

        // Calculate scale and position
        let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;

        switch (options.scaleMode) {
            case 'fit': {
                const scale = Math.min(targetWPt / srcW, targetHPt / srcH);
                scaleX = scaleY = scale;
                offsetX = (targetWPt - srcW * scale) / 2;
                offsetY = (targetHPt - srcH * scale) / 2;
                break;
            }
            case 'fill': {
                const scale = Math.max(targetWPt / srcW, targetHPt / srcH);
                scaleX = scaleY = scale;
                offsetX = (targetWPt - srcW * scale) / 2;
                offsetY = (targetHPt - srcH * scale) / 2;
                break;
            }
            case 'stretch': {
                scaleX = targetWPt / srcW;
                scaleY = targetHPt / srcH;
                break;
            }
            case 'center_no_scale': {
                offsetX = (targetWPt - srcW) / 2;
                offsetY = (targetHPt - srcH) / 2;
                break;
            }
        }

        newPage.drawPage(embedded, {
            x: offsetX,
            y: offsetY,
            width: srcW * scaleX,
            height: srcH * scaleY,
        });
    }

    return outputPdf.save();
}
