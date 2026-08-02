// src/lib/preprocessEngine/PageResizer.ts
// =========================================================================
//  Đổi khổ trang PDF — resize, scale, center content on new page size
// =========================================================================

import { PDFDocument, rgb } from 'pdf-lib';

import { beginOptionalContentTransfer, finishOptionalContentTransfer } from '../pdfOptionalContent';

const MM_TO_POINTS = 2.83465;

export type ScaleMode = 'fit' | 'fill' | 'stretch' | 'center_no_scale';
export type BackgroundFillMode =
    | 'white'
    | 'mirror'
    | 'trajectory'
    | 'inpaint'
    | 'image'
    | 'solid';

export interface ResizeOptions {
    targetW: number;   // mm
    targetH: number;   // mm
    scaleMode: ScaleMode;
    applyTo: 'all' | 'even' | 'odd' | number[];  // 1-based page numbers
    // Màu nền vùng trống khi fit/center
    bgFillMode?: BackgroundFillMode;
    bgFillColor?: string;  // hex '#rrggbb'
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


function parseSolidColor(value: string | undefined): [number, number, number] {
    const match = /^#?([0-9a-f]{6})$/i.exec((value || "").trim());
    if (!match) return [1, 1, 1];
    const hex = match[1];
    return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number];
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

    // [OCG FIX 2026-07-28] Cả copyPages và embedPages đều không mang /OCProperties sang.
    // Trang đổi khổ nằm trong Form XObject nên OCG tụt vào /Resources của form — hàm dựng
    // lại catalog có lần theo XObject lồng nhau nên vẫn nhận ra.
    // srcPdf là bản load cục bộ trong hàm này nên không cần try/finally để dọn dấu.
    const ocTransfer = beginOptionalContentTransfer([srcPdf]);

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
        const hasGap = options.scaleMode === 'fit' || options.scaleMode === 'center_no_scale';
        if (hasGap && options.bgFillMode === 'solid') {
            const [fillR, fillG, fillB] = parseSolidColor(options.bgFillColor);
            // RESIZE (audit 2026-07-31 §B.2): vẽ trước khi kiểm tra /Contents để
            // trang trắng cũng nhận đúng màu nền đã chọn.
            newPage.drawRectangle({
                x: 0, y: 0,
                width: targetWPt, height: targetHPt,
                color: rgb(fillR, fillG, fillB),
            });
        }

        // Trang trắng (chèn thêm để đủ số trang) không có /Contents —
        // embedPages sẽ ném "Can't embed page with missing Contents".
        // Trang rỗng thì chẳng có gì để nhúng, cứ để trang khổ mới trống.
        if (!srcPage.node.Contents()) {
            continue;
        }

        // Embed source page.
        // Ưu tiên CropBox khi nhỏ hơn MediaBox (sau Crop UI: viewer đã cắt, MediaBox
        // có thể còn gốc nếu bản cũ chưa sync) → resize đúng vùng đã cắt, không co
        // cả trang gốc. Còn lại dùng MediaBox để GIỮ BLEED (nội dung ngoài CropBox).
        const mb: any = (srcPage as any).getMediaBox
            ? (srcPage as any).getMediaBox()
            : { x: 0, y: 0, width: srcW, height: srcH };
        let box = { left: mb.x as number, bottom: mb.y as number, right: mb.x + mb.width, top: mb.y + mb.height };
        let embedW = srcW;
        let embedH = srcH;
        try {
            const cb: any = (srcPage as any).getCropBox?.() ?? null;
            if (cb && cb.width > 1 && cb.height > 1) {
                const mediaArea = Math.max(1, srcW * srcH);
                const cropArea = cb.width * cb.height;
                if (cropArea < mediaArea * 0.99) {
                    box = { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height };
                    embedW = cb.width;
                    embedH = cb.height;
                }
            }
        } catch { /* no crop box */ }

        const [embedded] = await outputPdf.embedPages(
            [srcPage],
            [box],
        );

        // Calculate scale and position (theo khổ embed — MediaBox hoặc CropBox)
        let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;

        switch (options.scaleMode) {
            case 'fit': {
                const scale = Math.min(targetWPt / embedW, targetHPt / embedH);
                scaleX = scaleY = scale;
                offsetX = (targetWPt - embedW * scale) / 2;
                offsetY = (targetHPt - embedH * scale) / 2;
                break;
            }
            case 'fill': {
                const scale = Math.max(targetWPt / embedW, targetHPt / embedH);
                scaleX = scaleY = scale;
                offsetX = (targetWPt - embedW * scale) / 2;
                offsetY = (targetHPt - embedH * scale) / 2;
                break;
            }
            case 'stretch': {
                scaleX = targetWPt / embedW;
                scaleY = targetHPt / embedH;
                break;
            }
            case 'center_no_scale': {
                offsetX = (targetWPt - embedW) / 2;
                offsetY = (targetHPt - embedH) / 2;
                break;
            }
        }


        newPage.drawPage(embedded, {
            x: offsetX,
            y: offsetY,
            width: embedW * scaleX,
            height: embedH * scaleY,
        });
    }

    finishOptionalContentTransfer(ocTransfer, outputPdf);
    return outputPdf.save();
}
