// src/lib/imposerEngine/SpreadPlacer.ts
// Xếp booklet spreads lên tờ kẽm offset theo SpreadFoldPattern.
// Thay thế OffsetRenderer.ts — chỉ xử lý bước 2 (step & repeat theo fold pattern).

import { PDFDocument, cmyk, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, translate, rotateDegrees, StandardFonts } from 'pdf-lib';
import { SpreadFoldPattern } from './FoldPatterns';
import { OffsetSettings } from './SettingsTypes';
import { drawRegistrationMarks, drawColorBar, drawPlateLabel, drawCenterMarks, drawCollationMark, drawStarTarget, drawSideIndicator, drawFolioMarks } from './MarksRenderer';
import { MM_TO_POINTS } from '../pdfImposer';

interface SpreadDetail {
    width: number;
    height: number;
}

const drawTrimMarks = (
    page: any, x: number, y: number, w: number, h: number,
    markLen: number, markOff: number, markThick: number,
    omitBottomVert: boolean = false, omitTopVert: boolean = false,
    omitLeftHoriz: boolean = false, omitRightHoriz: boolean = false
) => {
    const color = cmyk(1, 1, 1, 1); // Registration (in trên mọi kẽm), không dùng RGB
    const draw = (x1: number, y1: number, x2: number, y2: number) => {
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: markThick, color });
    };

    // Bottom Left
    if (!omitBottomVert) draw(x, y - markOff, x, y - markOff - markLen); // Bottom vert
    if (!omitLeftHoriz) draw(x - markOff, y, x - markOff - markLen, y); // Left horiz

    // Top Left
    if (!omitTopVert) draw(x, y + h + markOff, x, y + h + markOff + markLen); // Top vert
    if (!omitLeftHoriz) draw(x - markOff, y + h, x - markOff - markLen, y + h); // Left horiz

    // Bottom Right
    if (!omitBottomVert) draw(x + w, y - markOff, x + w, y - markOff - markLen); // Bottom vert
    if (!omitRightHoriz) draw(x + w + markOff, y, x + w + markOff + markLen, y); // Right horiz

    // Top Right
    if (!omitTopVert) draw(x + w, y + h + markOff, x + w, y + h + markOff + markLen); // Top vert
    if (!omitRightHoriz) draw(x + w + markOff, y + h, x + w + markOff + markLen, y + h); // Right horiz
};

const drawFoldMarks = (
    page: any, gridX: number, gridY: number,
    cols: number, rows: number, spreadW: number, spreadH: number,
    totalW: number, totalH: number, markLen: number, markOff: number, markThick: number,
    gapXPt: number, gapYPt: number, isEven: boolean
) => {
    const colorFold = cmyk(0, 1, 1, 0); // Đỏ (CMYK) cho dấu gấp
    const colorSlit = cmyk(1, 1, 1, 1); // Registration cho dấu xẻ/chia
    const draw = (x1: number, y1: number, x2: number, y2: number, color: any) => {
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: markThick, color });
    };

    // Helper: get spread position for (col, row) — must match cell placement logic
    const getCellPos = (c: number, r: number) => {
        let cx: number, cy: number;
        if (isEven) {
            const cellW = cols > 0 ? totalW / cols : totalW;
            const cellH = rows > 0 ? totalH / rows : totalH;
            cx = gridX + c * cellW + (cellW - spreadW) / 2;
            cy = gridY + (rows - 1 - r) * cellH + (cellH - spreadH) / 2;
        } else {
            cx = gridX + c * (spreadW + gapXPt);
            cy = gridY + (rows - 1 - r) * (spreadH + gapYPt);
        }
        return { cx, cy };
    };

    // 1. Vertical BLACK slit marks between spread columns (for cutting)
    for (let c = 1; c < cols; c++) {
        let fx = 0;
        if (isEven) {
            fx = gridX + c * (totalW / cols);
        } else {
            fx = gridX + c * spreadW + c * gapXPt - gapXPt / 2;
        }
        draw(fx, gridY + totalH + markOff, fx, gridY + totalH + markOff + markLen, colorSlit);
        draw(fx, gridY - markOff, fx, gridY - markOff - markLen, colorSlit);
    }

    // 2. Horizontal RED fold marks between rows (for cross-fold)
    for (let r = 1; r < rows; r++) {
        let fy: number;
        if (isEven) {
            fy = gridY + r * (totalH / rows);
        } else {
            fy = gridY + r * spreadH + r * gapYPt - gapYPt / 2;
        }
        
        for (let c = 0; c < cols; c++) {
            const { cx } = getCellPos(c, r);
            const colRightX = cx + spreadW;
            draw(cx - markOff, fy, cx - markOff - markLen, fy, colorFold);
            draw(colRightX + markOff, fy, colRightX + markOff + markLen, fy, colorFold);
        }
    }

    // 3. Vertical RED spine fold marks at the CENTER of each spread (booklet fold line)
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const { cx, cy } = getCellPos(c, r);
            const spineX = cx + spreadW / 2;
            // Draw at top and bottom of the spread
            draw(spineX, cy + spreadH + markOff, spineX, cy + spreadH + markOff + markLen, colorFold);
            draw(spineX, cy - markOff, spineX, cy - markOff - markLen, colorFold);
        }
    }
};

export async function placeSpreadsByFoldPattern(
    spreadPages: any[],         // Embedded booklet spread pages from temp PDF
    spreadDetails: SpreadDetail[],
    pattern: SpreadFoldPattern,
    sheetWPt: number,           // Press sheet width in points
    sheetHPt: number,           // Press sheet height in points
    outputPdf: PDFDocument,
    settings: OffsetSettings,
    setStatus: (msg: string) => void
): Promise<string> {
    const bleedPt = (settings.bleed || 0) * MM_TO_POINTS;
    const gripperPt = (settings.gripperMargin || 0) * MM_TO_POINTS;
    const marginTopPt = (settings.marginTop || 0) * MM_TO_POINTS;

    // Embed font MỘT LẦN DUY NHẤT cho toàn bộ các plate (không embed lại mỗi trang)
    const font = await outputPdf.embedFont(StandardFonts.Helvetica);
    const marginLeftPt = (settings.marginLeft || 0) * MM_TO_POINTS;
    const marginRightPt = (settings.marginRight || 0) * MM_TO_POINTS;

    const markLenPt = ((settings.markLength ?? 5) * MM_TO_POINTS);
    const markOffPt = ((settings.markOffset ?? 3) * MM_TO_POINTS);
    const markThickPt = ((settings.markThickness ?? 0.25) * MM_TO_POINTS);
    const showTrim = settings.markType !== 'none';

    // Spread cell size (= booklet spread size from temp PDF)
    const spreadW = spreadDetails[0]?.width || 0;
    const spreadH = spreadDetails[0]?.height || 0;
    if (!spreadW || !spreadH) return 'Error: No spread dimensions found.';

    const gapXPt = (settings.gapX || 0) * MM_TO_POINTS;
    const gapYPt = (settings.gapY || 0) * MM_TO_POINTS;

    const isEven = settings.spreadDistribution === 'even';

    const { cols, rows } = pattern;
    const actualGridW = cols * spreadW + (cols > 1 ? (cols - 1) * gapXPt : 0);
    const actualGridH = rows * spreadH + (rows > 1 ? (rows - 1) * gapYPt : 0);

    // Center grid on sheet
    const usableGridW = sheetWPt - marginLeftPt - marginRightPt;
    const usableGridH = sheetHPt - gripperPt - marginTopPt;

    // Auto-detect rotation: rotate grid 90° when grid and sheet aspect ratios mismatch.
    // This ensures optimal sheet utilization (e.g., portrait grid on landscape sheet).
    const gridRatio = actualGridW / actualGridH; // > 1 = landscape grid
    const sheetRatio = usableGridW / usableGridH; // > 1 = landscape sheet
    let isRotated = false;
    // Grid is portrait but sheet is landscape → rotate grid to landscape
    if (gridRatio < 1 && sheetRatio > 1.05) {
        isRotated = true;
    }
    // Grid is landscape but sheet is portrait → rotate grid to portrait
    else if (gridRatio > 1 && sheetRatio < 0.95) {
        isRotated = true;
    }

    const PT = 2.83465;
    // debug log removed

    // When rotated, the effective usable area is swapped for grid centering
    const effUsableW = isRotated ? usableGridH : usableGridW;
    const effUsableH = isRotated ? usableGridW : usableGridH;
    const totalGridW = isEven ? effUsableW : actualGridW;
    const totalGridH = isEven ? effUsableH : actualGridH;

    // Grid origin in the PRE-ROTATION coordinate space
    const gridOriginX_pre = (effUsableW - totalGridW) / 2;
    const gridOriginY_pre = (effUsableH - totalGridH) / 2;

    // Final grid origin in page coordinates (accounting for rotation)
    let gridOriginX: number;
    let gridOriginY: number;
    if (isRotated) {
        // After 90° CCW rotation around center, remap origins
        // Content coordinate system: rotate 90° CCW means (x,y) → (y, pageW - x)
        // We place grid in rotated space, then the pushOperators rotation handles the transform
        gridOriginX = gridOriginX_pre;
        gridOriginY = gridOriginY_pre;
    } else {
        gridOriginX = marginLeftPt + gridOriginX_pre;
        gridOriginY = gripperPt + gridOriginY_pre;
    }

    const trimW = spreadW - 2 * bleedPt;
    const trimH = spreadH - 2 * bleedPt;

    const spreadsPerSig = pattern.spreadsPerSig;
    const totalSigs = Math.ceil(spreadPages.length / spreadsPerSig);

    let plateCount = 0;
    // Self-turn: frontPlate only. Sheetwise: front + back
    const plateSides: ('front' | 'back')[] = pattern.backPlate.length > 0
        ? ['front', 'back']
        : ['front'];
    const totalPlates = totalSigs * plateSides.length;

    for (let sig = 0; sig < totalSigs; sig++) {
        const sigOffset = sig * spreadsPerSig;

        for (const plateSide of plateSides) {
            plateCount++;
            const slots = plateSide === 'front' ? pattern.frontPlate : pattern.backPlate;
            const sideLabel = plateSides.length === 1
                ? 'Tu Tro'
                : (plateSide === 'front' ? 'Mat A (Truoc)' : 'Mat B (Sau)');
            const wsLabel = pattern.workStyle === 'sheetwise' ? 'In 2 mat'
                : pattern.workStyle === 'work_and_turn' ? 'Tu tro lat ngang'
                : 'Tu tro lat nhip';
            setStatus(`Dang render kem: Tay ${sig + 1}/${totalSigs} - ${sideLabel} (${plateCount}/${totalPlates})`);

            // Page size = tờ kẽm gốc, KHÔNG mở rộng
            const outputPage = outputPdf.addPage([sheetWPt, sheetHPt]);

            // If grid needs rotation to match sheet orientation,
            // apply a 90° CCW rotation around center + shift so content fits.
            // All subsequent draw calls (spreads, marks, labels) will be in rotated space.
            if (isRotated) {
                // Save state so we can pop back to absolute coords for press marks
                outputPage.pushOperators(pushGraphicsState());
                // 90° CCW rotation: drawing(x,y) → page(y+mL, sheetH-x-mT)
                // Drawing X → page Y (inverted): marginTop at page top, gripper at page bottom
                // Drawing Y → page X: marginLeft at page left, marginRight at page right
                outputPage.pushOperators(
                    translate(0, sheetHPt),
                    rotateDegrees(-90),
                    translate(marginTopPt, marginLeftPt)
                );
            }

            for (const slot of slots) {
                const tempPageIdx = sigOffset + slot.spreadIndex;
                if (tempPageIdx >= spreadPages.length) continue;

                let cellX = 0, cellY = 0;
                
                if (isEven) {
                    const cellW = cols > 0 ? effUsableW / cols : effUsableW;
                    cellX = gridOriginX + slot.col * cellW + (cellW - spreadW) / 2;
                    const cellH = rows > 0 ? effUsableH / rows : effUsableH;
                    cellY = gridOriginY + (rows - 1 - slot.row) * cellH + (cellH - spreadH) / 2;
                } else {
                    cellX = gridOriginX + slot.col * (spreadW + gapXPt);
                    cellY = gridOriginY + (rows - 1 - slot.row) * (spreadH + gapYPt);
                }

                const pageToDraw = spreadPages[tempPageIdx];
                if (!pageToDraw) {
                    outputPage.drawRectangle({
                        x: cellX, y: cellY,
                        width: spreadW, height: spreadH,
                        color: cmyk(0, 0, 0, 0),
                    });
                    continue;
                }

                const trimX = cellX + bleedPt;
                const trimY = cellY + bleedPt;

                if (showTrim && isEven) {
                    // Even mode: each spread is separated and will be cut apart individually,
                    // so every spread needs complete trim marks on all 4 corners (no omission).
                    drawTrimMarks(outputPage, trimX, trimY, trimW, trimH, markLenPt, markOffPt, markThickPt, false, false, false, false);
                }

                outputPage.pushOperators(
                    pushGraphicsState(),
                    rectangle(cellX, cellY, spreadW, spreadH),
                    clip(),
                    endPath(),
                );

                if (slot.rotation === 180) {
                    const cx = cellX + spreadW / 2;
                    const cy = cellY + spreadH / 2;
                    outputPage.pushOperators(
                        translate(cx, cy),
                        rotateDegrees(180),
                        translate(-cx, -cy),
                    );
                }

                outputPage.drawPage(pageToDraw, {
                    x: cellX, y: cellY,
                    width: pageToDraw.width, height: pageToDraw.height,
                });

                outputPage.pushOperators(popGraphicsState());

                // 6. Folio Marks — số thứ tự spread ở rìa trim (vẽ SAU popGraphicsState để không bị clip)
                if (showTrim) {
                    // Hiển thị số thứ tự spread (1-based), không phải số trang nguồn
                    // vì ở giai đoạn này thông tin page mapping gốc đã bị mất
                    const spreadNum = tempPageIdx + 1;
                    drawFolioMarks(outputPage, font, cellX, cellY, spreadW, spreadH, bleedPt, [spreadNum]);
                }
            }

            // Marks (Fold and Trim per column)
            if (showTrim) {
                // Clustered (Hút sát gáy): các đường bên trong là GẤP/XẺ, chỉ cần dấu xén
                // ở 4 GÓC NGOÀI của cả khối tay sách. (Even mode đã vẽ dấu xén từng spread
                // trong vòng lặp ở trên.) Trước đây clustered KHÔNG vẽ bộ này → mất dấu xén.
                if (!isEven) {
                    drawTrimMarks(
                        outputPage,
                        gridOriginX + bleedPt, gridOriginY + bleedPt,
                        totalGridW - 2 * bleedPt, totalGridH - 2 * bleedPt,
                        markLenPt, markOffPt, markThickPt
                    );
                }
                // Draw Red Fold & Black Slit Marks
                drawFoldMarks(
                    outputPage, gridOriginX, gridOriginY,
                    cols, rows, spreadW, spreadH,
                    totalGridW, totalGridH,
                    markLenPt, markOffPt, markThickPt,
                    gapXPt, gapYPt, isEven
                );
            }

            // Pop rotation state BEFORE press marks — they use absolute page coordinates
            if (isRotated) {
                outputPage.pushOperators(popGraphicsState());
            }

            // Registration marks + color bar (drawn in absolute page space)
            // When rotated: drawing(x,y) → page(y+mL, sheetH-x-mT)
            const regGridX = isRotated ? marginLeftPt + gridOriginY_pre : gridOriginX;
            const regGridY = isRotated ? (sheetHPt - marginTopPt - gridOriginX_pre - totalGridW) : gridOriginY;
            const regGridW = isRotated ? totalGridH : totalGridW;
            const regGridH = isRotated ? totalGridW : totalGridH;
            drawRegistrationMarks(outputPage, sheetWPt, sheetHPt, regGridX, regGridY, regGridW, regGridH);

            // Color bar: one per PAGE-VISIBLE column
            // When rotated, drawing rows → page columns. When not rotated, drawing cols → page columns.
            const pageCols = isRotated ? rows : cols;

            for (let pc = 0; pc < pageCols; pc++) {
                let absX: number, absY: number, absW: number, absH: number;

                if (isRotated) {
                    // pc = drawing row index → page column
                    let rowY: number;
                    if (isEven) {
                        const cellH = rows > 0 ? effUsableH / rows : effUsableH;
                        rowY = gridOriginY + (rows - 1 - pc) * cellH + (cellH - spreadH) / 2;
                    } else {
                        rowY = gridOriginY + (rows - 1 - pc) * (spreadH + gapYPt);
                    }
                    // drawing(x,y) → page(y+mL, sheetH-x-mT)
                    absX = marginLeftPt + rowY;                              // page X = drawY + mL
                    absY = sheetHPt - marginTopPt - gridOriginX - totalGridW; // page Y = bottom (full draw X span)
                    absW = spreadH;                                           // page W = one row height
                    absH = totalGridW;                                        // page H = full draw width
                } else {
                    // pc = drawing col index → page column
                    let colX: number;
                    if (isEven) {
                        const cellW = cols > 0 ? effUsableW / cols : effUsableW;
                        colX = gridOriginX + pc * cellW + (cellW - spreadW) / 2;
                    } else {
                        colX = gridOriginX + pc * (spreadW + gapXPt);
                    }
                    absX = colX;
                    absY = gridOriginY;
                    absW = spreadW;
                    absH = totalGridH;
                }
                // debug log removed
                drawColorBar(outputPage, sheetWPt, sheetHPt, absX, absY, absW, absH);
            }

            // ─── PROFESSIONAL PRESS MARKS ───
            // Build plate label text
            const baseLabel = settings.isCover ? 'Bìa' : `${pattern.pagesPerSig} trang`;
            const plateInfoStr = plateSides.length > 1
                ? `Kẽm ${plateCount} - Tay ${sig + 1}${plateSide === 'front' ? 'A' : 'B'} (${plateSide === 'front' ? 'Trước' : 'Sau'}) - Bài A-B`
                : `Kẽm ${plateCount} - ${baseLabel} - Tự Trở`;
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
            const fullLabel = `${plateInfoStr}  |  ${wsLabel}  |  ${dateStr}  |  Process CMYK`;

            // 1. Nhãn kẽm (Plate Label) — in chữ ở mép nhíp
            drawPlateLabel(outputPage, font, sheetWPt, sheetHPt, fullLabel, gripperPt);

            // 2. Dấu dùi kẽm (Center Marks) — chữ thập ở 4 cạnh giữa tờ giấy
            drawCenterMarks(outputPage, sheetWPt, sheetHPt);

            // 3. Sống gáy (Collation Mark) — cầu thang kiểm tra thứ tự tay sách
            drawCollationMark(outputPage, sheetWPt, sheetHPt, sig, totalSigs, regGridX, regGridY, regGridH);

            // 4. Bia đo (Star Target) — kiểm tra dot gain, slur, doubling
            drawStarTarget(outputPage, sheetWPt, sheetHPt);

            // 5. Chỉ thị mặt A/B (Side Indicator)
            const sideType: 'front' | 'back' | 'self-turn' = plateSides.length === 1 ? 'self-turn' : plateSide;
            drawSideIndicator(outputPage, font, sheetWPt, sheetHPt, sideType, gripperPt);

            // Store plate info as page metadata for viewer overlay
            try {
                const { PDFName, PDFString } = await import('pdf-lib');
                outputPage.node.set(PDFName.of('PlateInfoURI'), PDFString.of(encodeURIComponent(plateInfoStr)));
            } catch { /* non-fatal */ }
        }
    }

    const plateLabel = plateSides.length === 1 ? 'self-turn' : 'A+B';
    return `Offset: ${totalSigs} sig x ${pattern.pagesPerSig}p. Grid ${cols}x${rows}. ${plateCount} plates (${plateLabel}).`;
}
