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

        // RESIZE (audit 2026-08-06 §G.2): mang TrimBox/BleedBox/ArtBox sang trang
        // mới, biến đổi theo ĐÚNG phép đặt nội dung ở trên — cùng công thức với
        // backend (_tx_box trong pdf_tools_engine.resize_pages). Trước đây đường
        // frontend bỏ hẳn các box này nên file ≤50MB MẤT định nghĩa bleed/trim
        // trong khi file >50MB (đi backend) thì giữ: cùng nút bấm, khác kết quả.
        // Chỉ đọc box KHAI BÁO THẬT trên trang nguồn (node.*), vì getTrimBox()
        // của pdf-lib tự suy ra CropBox/MediaBox khi box không tồn tại.
        const txBox = (raw: number[]): [number, number, number, number] => {
            // Điểm nguồn tính theo gốc vùng embed (box.left/box.bottom).
            const px0 = (raw[0] - box.left) * scaleX + offsetX;
            const py0 = (raw[1] - box.bottom) * scaleY + offsetY;
            const px1 = (raw[2] - box.left) * scaleX + offsetX;
            const py1 = (raw[3] - box.bottom) * scaleY + offsetY;
            const x0 = Math.max(0, Math.min(px0, px1));
            const x1 = Math.min(targetWPt, Math.max(px0, px1));
            const y0 = Math.max(0, Math.min(py0, py1));
            const y1 = Math.min(targetHPt, Math.max(py0, py1));
            return [x0, y0, x1, y1];
        };
        const auxBoxes: Array<['TrimBox' | 'BleedBox' | 'ArtBox', any]> = [
            ['TrimBox', (srcPage.node as any).TrimBox?.()],
            ['BleedBox', (srcPage.node as any).BleedBox?.()],
            ['ArtBox', (srcPage.node as any).ArtBox?.()],
        ];
        for (const [name, arr] of auxBoxes) {
            if (!arr) continue;
            try {
                const rect = arr.asRectangle();
                const raw = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
                if (raw.some(v => !Number.isFinite(v))) continue;
                const [x0, y0, x1, y1] = txBox(raw);
                if (!(x1 > x0 && y1 > y0)) continue;
                if (name === 'TrimBox') newPage.setTrimBox(x0, y0, x1 - x0, y1 - y0);
                else if (name === 'BleedBox') newPage.setBleedBox(x0, y0, x1 - x0, y1 - y0);
                else newPage.setArtBox(x0, y0, x1 - x0, y1 - y0);
            } catch { /* box hỏng định dạng — bỏ qua, không chặn resize */ }
        }
    }

    finishOptionalContentTransfer(ocTransfer, outputPdf);
    return outputPdf.save();
}
