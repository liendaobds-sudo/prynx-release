// src/lib/imposerEngine/MarksRenderer.ts
// Guillotine mode: draws full-length cut lines spanning the grid (matching Campuchia drawOneDaoCutLines).
// Corner mode: draws short tick marks at the 4 corners of the overall grid.
//
// Key geometry (from NupRenderer):
//   xPos = clusterBaseX + c * cellPitchX         ← trim-edge left of cell (c,r)
//   cellPitchX = trimWidth + gapX
//   The artwork is placed at (xPos - bleedPt, yPos - bleedPt) and has full page size (trim + 2*bleed).
//
// Guillotine cut lines:
//   - Horizontal lines at each unique Y trim-edge, spanning min-X to max-X of cells sharing that edge.
//   - Vertical   lines at each unique X trim-edge, spanning min-Y to max-Y of cells sharing that edge.
//   - At OUTER edges of the overall grid: lines extend by bleedPt (so the bleed area gets a cut line).
//   - At INNER edges (between cells):    lines run exactly between trim edges, NO bleed extension.

import { PDFPage, PDFFont, rgb, cmyk } from 'pdf-lib';
import { ProcessingSettings } from '../pdfImposer';
import { NupBlock } from './NupGridSolver';

const MM_TO_POINTS = 2.83465;
const MARK_COLOR = cmyk(1, 1, 1, 1); // Registration Color (prints on all plates)

function getMarkOptions(settings: ProcessingSettings) {
    const len = ((settings as any)?.markLength ?? 5.0) * MM_TO_POINTS;
    const off = ((settings as any)?.markOffset ?? 3.0) * MM_TO_POINTS;
    const thickness = ((settings as any)?.markThickness ?? 0.25) * MM_TO_POINTS;
    return { len, off, thickness };
}

function drawLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness: number) {
    page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness,
        color: MARK_COLOR
    });
}

function drawLineColor(page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness: number, color: any) {
    page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness,
        color
    });
}

/**
 * Draw N-Up marks.
 *
 * Guillotine mode mirrors the Campuchia drawOneDaoCutLines algorithm:
 *   1. Collect ALL unique x-edges and y-edges from the grid cells (trim boundaries).
 *   2. For each horizontal edge (y-value), draw a line spanning the full width of the grid.
 *      - If the line touches the OUTER left/right boundary → extend by bleedPt.
 *   3. For each vertical edge (x-value), draw a line spanning the full height of the grid.
 *      - If the line touches the OUTER top/bottom boundary → extend by bleedPt.
 *
 * This naturally handles:
 *   - gap > 0: produces 2 edges per gap boundary ("dao kép")
 *   - gap = 0: edges collapse to 1 ("dao đơn")
 *   - bleed: outer edges extend, inner edges don't
 */
export function drawMarksNup(
    page: PDFPage,
    settings: ProcessingSettings,
    gridX: number,
    gridY: number,
    totalGridW: number,
    totalGridH: number,
    blocks: NupBlock[],
    gapX: number,
    gapY: number,
    isMergedItemMode?: boolean
) {
    if ((settings as any)?.markType === 'none') return;

    const { len, off, thickness } = getMarkOptions(settings);

    if ((settings as any)?.markType === 'corners') {
        drawCornerMarks(page, gridX, gridY, totalGridW, totalGridH, len, off, thickness);
        return;
    }

    // ===== GUILLOTINE MODE =====
    
    // Thu thập BBox của tất cả blocks để kiểm tra va chạm
    const blockBBoxes = blocks.map(b => ({
        minX: gridX + b.startX,
        maxX: gridX + b.startX + b.width,
        minY: gridY + totalGridH - (b.startY + b.height), // Y trong PDF đi từ dưới lên
        maxY: gridY + totalGridH - b.startY
    }));

    const isPointInOtherBlock = (x: number, y: number, currentBlockIndex: number) => {
        // Cộng thêm 0.1 mút dung sai để không bị chặn bởi chính mép của gap
        for (let i = 0; i < blockBBoxes.length; i++) {
            if (i === currentBlockIndex) continue;
            const bb = blockBBoxes[i];
            if (x > bb.minX + 0.1 && x < bb.maxX - 0.1 && y > bb.minY + 0.1 && y < bb.maxY - 0.1) {
                return true;
            }
        }
        return false;
    };

    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const itemW = b.cells.length > 0 ? b.cells[0].width : 0;
        const itemH = b.cells.length > 0 ? b.cells[0].height : 0;

        const pdfTopY = gridY + totalGridH - b.startY;
        const pdfBottomY = gridY + totalGridH - (b.startY + b.height);
        const pdfLeftX = gridX + b.startX;
        const pdfRightX = gridX + b.startX + b.width;

        const vCuts = new Set<number>();
        const hCuts = new Set<number>();
        const spineCutsV = new Set<number>(); // Fold marks at spine (red) for saddle stitch
        const spineCutsH = new Set<number>(); // Fold marks at spine (red) for saddle stitch
        for (const cell of b.cells) {
            vCuts.add(roundPt(cell.x));
            vCuts.add(roundPt(cell.x + cell.width));
            hCuts.add(roundPt(cell.y));
            hCuts.add(roundPt(cell.y + cell.height));

            if ((settings as any)?.isBookletSpread) {
                // For cut_stack, gapX acts as the internal spine gap between the two halves.
                const innerGapPt = ((settings as any)?.cutStack && (settings as any)?.gapX) ? (settings as any)?.gapX * 2.83465 : 0; // MM_TO_POINTS
                
                // Saddle stitch → fold mark (red tick). Cut stack → slit mark (added to main cuts).
                const isSaddleFold = !((settings as any)?.cutStack);
                
                // Determine the spine orientation based on 90/270 rotation (isRotated)
                // isRotated180 does not swap width and height, so spine remains vertical
                if (cell.isRotated) {
                    // Spine is horizontal
                    if (innerGapPt > 0) {
                        const cut1 = roundPt(cell.y + cell.height / 2 - innerGapPt / 2);
                        const cut2 = roundPt(cell.y + cell.height / 2 + innerGapPt / 2);
                        if (isSaddleFold) { spineCutsH.add(cut1); spineCutsH.add(cut2); }
                        else { hCuts.add(cut1); hCuts.add(cut2); }
                    } else {
                        const cut = roundPt(cell.y + cell.height / 2);
                        if (isSaddleFold) { spineCutsH.add(cut); }
                        else { hCuts.add(cut); }
                    }
                } else {
                    // Spine is vertical
                    if (innerGapPt > 0) {
                        const cut1 = roundPt(cell.x + cell.width / 2 - innerGapPt / 2);
                        const cut2 = roundPt(cell.x + cell.width / 2 + innerGapPt / 2);
                        if (isSaddleFold) { spineCutsV.add(cut1); spineCutsV.add(cut2); }
                        else { vCuts.add(cut1); vCuts.add(cut2); }
                    } else {
                        const cut = roundPt(cell.x + cell.width / 2);
                        if (isSaddleFold) { spineCutsV.add(cut); }
                        else { vCuts.add(cut); }
                    }
                }
            }
        }

        // Draw vertical marks (Top edge pointing UP, Bottom edge pointing DOWN)
        for (const cellX of Array.from(vCuts)) {
            const x = gridX + cellX;
            
            // Top edge pointing UP
            if (isMergedItemMode && Math.abs(pdfTopY - (gridY + totalGridH)) > 0.1) {
                // skip internal
            } else if (!isPointInOtherBlock(x, pdfTopY + off + len, i)) {
                drawLine(page, x, pdfTopY + off, x, pdfTopY + off + len, thickness);
            }
            // Bottom edge pointing DOWN
            if (isMergedItemMode && Math.abs(pdfBottomY - gridY) > 0.1) {
                // skip internal
            } else if (!isPointInOtherBlock(x, pdfBottomY - off - len, i)) {
                drawLine(page, x, pdfBottomY - off, x, pdfBottomY - off - len, thickness);
            }
        }

        // Draw horizontal marks (Left edge pointing LEFT, Right edge pointing RIGHT)
        for (const cellY of Array.from(hCuts)) {
            const pdfY = gridY + totalGridH - cellY;
            
            // Left edge pointing LEFT
            if (isMergedItemMode && Math.abs(pdfLeftX - gridX) > 0.1) {
                // skip internal
            } else if (!isPointInOtherBlock(pdfLeftX - off - len, pdfY, i)) {
                drawLine(page, pdfLeftX - off, pdfY, pdfLeftX - off - len, pdfY, thickness);
            }
            // Right edge pointing RIGHT
            if (isMergedItemMode && Math.abs(pdfRightX - (gridX + totalGridW)) > 0.1) {
                // skip internal
            } else if (!isPointInOtherBlock(pdfRightX + off + len, pdfY, i)) {
                drawLine(page, pdfRightX + off, pdfY, pdfRightX + off + len, pdfY, thickness);
            }
        }

        // --- Spine FOLD marks (red tick) for saddle stitch booklets ---
        const FOLD_COLOR = rgb(1, 0, 0); // Red — standard fold indicator
        for (const cellX of Array.from(spineCutsV)) {
            const x = gridX + cellX;
            // Top edge tick (pointing UP)
            if (!isPointInOtherBlock(x, pdfTopY + off + len, i)) {
                drawLineColor(page, x, pdfTopY + off, x, pdfTopY + off + len, thickness, FOLD_COLOR);
            }
            // Bottom edge tick (pointing DOWN)
            if (!isPointInOtherBlock(x, pdfBottomY - off - len, i)) {
                drawLineColor(page, x, pdfBottomY - off, x, pdfBottomY - off - len, thickness, FOLD_COLOR);
            }
        }
        for (const cellY of Array.from(spineCutsH)) {
            const pdfY = gridY + totalGridH - cellY;
            // Left edge tick (pointing LEFT)
            if (!isPointInOtherBlock(pdfLeftX - off - len, pdfY, i)) {
                drawLineColor(page, pdfLeftX - off, pdfY, pdfLeftX - off - len, pdfY, thickness, FOLD_COLOR);
            }
            // Right edge tick (pointing RIGHT)
            if (!isPointInOtherBlock(pdfRightX + off + len, pdfY, i)) {
                drawLineColor(page, pdfRightX + off, pdfY, pdfRightX + off + len, pdfY, thickness, FOLD_COLOR);
            }
        }
    }

    // --- Tính toán và vẽ dấu dập cắt đôi Giữa 2 Cụm (Split Marks) ---
    if (!isMergedItemMode) {
        const splitLinesHorizontal = new Set<number>();
        const splitLinesVertical = new Set<number>();

    for (let i = 0; i < blocks.length; i++) {
        for (let j = 0; j < blocks.length; j++) {
            if (i === j) continue;
            const bA = blocks[i];
            const bB = blocks[j];

            // Horizontal gap (bA is above bB, local Y goes down)
            const xOverlap = Math.max(bA.startX, bB.startX) < Math.min(bA.startX + bA.width, bB.startX + bB.width);
            if (xOverlap && bA.startY + bA.height < bB.startY - 0.01) {
                let isAdjacent = true;
                const gapTop = bA.startY + bA.height;
                const gapBottom = bB.startY;
                for (let k = 0; k < blocks.length; k++) {
                    if (k === i || k === j) continue;
                    const bK = blocks[k];
                    const xOverlapK = Math.max(bA.startX, bK.startX) < Math.min(bA.startX + bA.width, bK.startX + bK.width);
                    if (xOverlapK && bK.startY > gapTop - 0.1 && bK.startY + bK.height < gapBottom + 0.1) {
                        isAdjacent = false; break;
                    }
                }
                if (isAdjacent) {
                    const gapY = (bA.startY + bA.height + bB.startY) / 2;
                    splitLinesHorizontal.add(roundPt(gapY));
                }
            }

            // Vertical gap (bA is left of bB)
            const yOverlap = Math.max(bA.startY, bB.startY) < Math.min(bA.startY + bA.height, bB.startY + bB.height);
            if (yOverlap && bA.startX + bA.width < bB.startX - 0.01) {
                let isAdjacent = true;
                const gapLeft = bA.startX + bA.width;
                const gapRight = bB.startX;
                for (let k = 0; k < blocks.length; k++) {
                    if (k === i || k === j) continue;
                    const bK = blocks[k];
                    const yOverlapK = Math.max(bA.startY, bK.startY) < Math.min(bA.startY + bA.height, bK.startY + bK.height);
                    if (yOverlapK && bK.startX > gapLeft - 0.1 && bK.startX + bK.width < gapRight + 0.1) {
                        isAdjacent = false; break;
                    }
                }
                if (isAdjacent) {
                    const gapX = (bA.startX + bA.width + bB.startX) / 2;
                    splitLinesVertical.add(roundPt(gapX));
                }
            }
        }
    }

    // Draw Split Marks pointing outward on the global margins
    for (const splitY of Array.from(splitLinesHorizontal)) {
        const pdfY = gridY + totalGridH - splitY;
        // Left global margin
        drawLine(page, gridX - off, pdfY, gridX - off - len, pdfY, thickness);
        // Right global margin
        drawLine(page, gridX + totalGridW + off, pdfY, gridX + totalGridW + off + len, pdfY, thickness);
    }

        for (const splitX of Array.from(splitLinesVertical)) {
            const pdfX = gridX + splitX;
            // Top global margin
            const pdfTopY = gridY + totalGridH;
            drawLine(page, pdfX, pdfTopY + off, pdfX, pdfTopY + off + len, thickness);
            // Bottom global margin
            const pdfBottomY = gridY;
            drawLine(page, pdfX, pdfBottomY - off, pdfX, pdfBottomY - off - len, thickness);
        }
    }
}

/**
 * Simple 4-corner marks (8 ticks total).
 * Marks are placed perfectly relative to Trim edges without bleeding out incorrectly.
 */
function drawCornerMarks(
    page: PDFPage,
    gridX: number,
    gridY: number,
    totalGridW: number,
    totalGridH: number,
    len: number,
    off: number,
    thickness: number
) {
    const TL_X = gridX,              TL_Y = gridY + totalGridH;
    const TR_X = gridX + totalGridW, TR_Y = gridY + totalGridH;
    const BL_X = gridX,              BL_Y = gridY;
    const BR_X = gridX + totalGridW, BR_Y = gridY;

    // Top Left
    drawLine(page, TL_X, TL_Y + off, TL_X, TL_Y + off + len, thickness);
    drawLine(page, TL_X - off, TL_Y, TL_X - off - len, TL_Y, thickness);
    // Top Right
    drawLine(page, TR_X, TR_Y + off, TR_X, TR_Y + off + len, thickness);
    drawLine(page, TR_X + off, TR_Y, TR_X + off + len, TR_Y, thickness);
    // Bottom Left
    drawLine(page, BL_X, BL_Y - off, BL_X, BL_Y - off - len, thickness);
    drawLine(page, BL_X - off, BL_Y, BL_X - off - len, BL_Y, thickness);
    // Bottom Right
    drawLine(page, BR_X, BR_Y - off, BR_X, BR_Y - off - len, thickness);
    drawLine(page, BR_X + off, BR_Y, BR_X + off + len, BR_Y, thickness);
}

function roundPt(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/**
 * Registration crosshair marks (dấu thập chồng màu).
 * Drawn at 4 corners of the page, outside the trim area.
 * Used by press operators to align CMYK plates.
 */
export function drawRegistrationMarks(
    page: PDFPage,
    pageW: number,
    pageH: number,
    gridX: number,
    gridY: number,
    totalGridW: number,
    totalGridH: number,
    offsetPt?: number
) {
    const CROSS_SIZE = 3 * MM_TO_POINTS;   // radius of crosshair
    const CIRCLE_R  = 2 * MM_TO_POINTS;    // registration circle radius
    const OFF = offsetPt !== undefined ? offsetPt : 12 * MM_TO_POINTS;         // distance from grid edge
    const THICK = 0.3;

    // Registration marks at 4 grid corners. Bottom corners clamped above gripper zone.
    const bottomCornerY = Math.max(gridY - OFF, OFF); // Clamp above gripper
    const positions = [
        { x: gridX - OFF, y: gridY + totalGridH + OFF },           // Top Left
        { x: gridX + totalGridW + OFF, y: gridY + totalGridH + OFF }, // Top Right
        { x: gridX - OFF, y: bottomCornerY },                        // Bottom Left (above gripper)
        { x: gridX + totalGridW + OFF, y: bottomCornerY },           // Bottom Right (above gripper)
    ];

    for (const pos of positions) {
        let px = pos.x;
        let py = pos.y;

        // Giới hạn để dấu ốc không bị cắt mất khỏi mép giấy (cách mép ít nhất CROSS_SIZE + 2pt an toàn)
        if (px - CROSS_SIZE < 2) px = CROSS_SIZE + 2;
        if (px + CROSS_SIZE > pageW - 2) px = pageW - CROSS_SIZE - 2;
        if (py - CROSS_SIZE < 2) py = CROSS_SIZE + 2;
        if (py + CROSS_SIZE > pageH - 2) py = pageH - CROSS_SIZE - 2;

        // Crosshair lines
        drawLine(page, px - CROSS_SIZE, py, px + CROSS_SIZE, py, THICK);
        drawLine(page, px, py - CROSS_SIZE, px, py + CROSS_SIZE, THICK);

        // Circle (approximated with 8 short segments)
        const segments = 16;
        for (let i = 0; i < segments; i++) {
            const a1 = (i / segments) * Math.PI * 2;
            const a2 = ((i + 1) / segments) * Math.PI * 2;
            drawLine(page,
                px + Math.cos(a1) * CIRCLE_R, py + Math.sin(a1) * CIRCLE_R,
                px + Math.cos(a2) * CIRCLE_R, py + Math.sin(a2) * CIRCLE_R,
                THICK
            );
        }
    }
}

/**
 * Simplified CMYK color bar (thanh kiểm soát mực).
 * Drawn along the top edge of the page, in the gripper/waste area.
 * Each patch is a small rectangle of C, M, Y, or K.
 */
export function drawColorBar(
    page: PDFPage,
    pageW: number,
    pageH: number,
    gridX: number,
    gridY: number,
    totalGridW: number,
    totalGridH: number
) {
    const PATCH_W = 4 * MM_TO_POINTS;
    const PATCH_H = 3 * MM_TO_POINTS;
    const GAP = 0.5 * MM_TO_POINTS;     // Tight gap between patches
    const GROUP_GAP = 2 * MM_TO_POINTS;  // Gap between groups
    const MIN_GAP = 2 * MM_TO_POINTS;

    // Industry-standard color control strip (Ugra/FOGRA style)
    // Groups: Solids → Tints → Overprints → Gray balance → Paper white
    const colorStrip: { c: number; m: number; y: number; k: number; group: number }[] = [
        // Group 0: Solid 100% (kiểm tra mật độ mực)
        { c: 1, m: 0, y: 0, k: 0, group: 0 },     // Cyan 100%
        { c: 0, m: 1, y: 0, k: 0, group: 0 },     // Magenta 100%
        { c: 0, m: 0, y: 1, k: 0, group: 0 },     // Yellow 100%
        { c: 0, m: 0, y: 0, k: 1, group: 0 },     // Black 100%

        // Group 1: Tint 50% (đo dot gain — quan trọng nhất)
        { c: 0.5, m: 0, y: 0, k: 0, group: 1 },   // Cyan 50%
        { c: 0, m: 0.5, y: 0, k: 0, group: 1 },   // Magenta 50%
        { c: 0, m: 0, y: 0.5, k: 0, group: 1 },   // Yellow 50%
        { c: 0, m: 0, y: 0, k: 0.5, group: 1 },   // Black 50%

        // Group 2: Tint 25% & 75% (bổ sung đường cong dot gain)
        { c: 0.25, m: 0, y: 0, k: 0, group: 2 },  // Cyan 25%
        { c: 0.75, m: 0, y: 0, k: 0, group: 2 },  // Cyan 75%
        { c: 0, m: 0.25, y: 0, k: 0, group: 2 },  // Magenta 25%
        { c: 0, m: 0.75, y: 0, k: 0, group: 2 },  // Magenta 75%

        // Group 3: Overprints (kiểm tra trapping — bẫy mực)
        { c: 0, m: 1, y: 1, k: 0, group: 3 },     // Red (M+Y)
        { c: 1, m: 0, y: 1, k: 0, group: 3 },     // Green (C+Y)
        { c: 1, m: 1, y: 0, k: 0, group: 3 },     // Blue (C+M)
        { c: 1, m: 1, y: 1, k: 0, group: 3 },     // CMY overprint

        // Group 4: Gray balance + paper white
        { c: 0.5, m: 0.4, y: 0.4, k: 0, group: 4 }, // Gray balance (ISO 12647-2)
        { c: 0, m: 0, y: 0, k: 0, group: 4 },       // Paper white (tham chiếu)
    ];

    const spaceTop = pageH - (gridY + totalGridH);
    const spaceRight = pageW - (gridX + totalGridW);
    const spaceLeft = gridX;

    // Priority: top > right > left (NEVER bottom — that's the gripper/nhíp zone)
    let mode = 'none';
    if (spaceTop >= PATCH_H + MIN_GAP) mode = 'top';
    else if (spaceRight >= PATCH_H + MIN_GAP) mode = 'right';
    else if (spaceRight >= PATCH_W + MIN_GAP) mode = 'right';
    else if (spaceLeft >= PATCH_W + MIN_GAP) mode = 'left';

    if (mode === 'none') return;

    // Calculate total width/height with group gaps
    const totalPatches = colorStrip.length;
    const groups = new Set(colorStrip.map(p => p.group));
    const numGroupGaps = groups.size - 1;

    const isHorizontal = mode === 'top';
    const patchPitch = isHorizontal ? PATCH_W + GAP : PATCH_H + GAP;
    const totalLen = totalPatches * patchPitch - GAP + numGroupGaps * (GROUP_GAP - GAP);

    // Check if it fits; if not, skip group gaps
    const maxLen = isHorizontal ? totalGridW : totalGridH;
    const useGroupGaps = totalLen <= maxLen;
    const actualLen = useGroupGaps ? totalLen : totalPatches * patchPitch - GAP;

    // Centering offset
    const centerOff = (maxLen - Math.min(actualLen, maxLen)) / 2;

    let prevGroup = colorStrip[0].group;
    let offset = 0;

    for (let i = 0; i < totalPatches; i++) {
        const patch = colorStrip[i];

        // Add group gap when group changes
        if (i > 0 && patch.group !== prevGroup && useGroupGaps) {
            offset += GROUP_GAP - GAP;
        }
        prevGroup = patch.group;

        let px = 0, py = 0;
        if (mode === 'top') {
            px = gridX + centerOff + offset;
            py = gridY + totalGridH + (spaceTop - PATCH_H) / 2;
        } else if (mode === 'right') {
            px = gridX + totalGridW + (spaceRight - PATCH_W) / 2;
            py = gridY + centerOff + offset;
        } else if (mode === 'left') {
            px = (spaceLeft - PATCH_W) / 2;
            py = gridY + centerOff + offset;
        }

        offset += patchPitch;

        page.drawRectangle({
            x: px, y: py,
            width: PATCH_W, height: PATCH_H,
            color: cmyk(patch.c, patch.m, patch.y, patch.k),
        });
        page.drawRectangle({
            x: px, y: py,
            width: PATCH_W, height: PATCH_H,
            borderColor: cmyk(0, 0, 0, 1),
            borderWidth: 0.3,
            color: undefined as any,
        });
    }
}

// =========================================================================
//  PROFESSIONAL PRESS MARKS (Chuẩn công nghiệp offset)
//
//  1. drawPlateLabel()     — Nhãn thông tin kẽm (tên file, ngày, tay sách)
//  2. drawCenterMarks()    — Dấu dùi kẽm / canh giữa tờ giấy
//  3. drawCollationMark()  — Sống gáy cầu thang (kiểm tra thứ tự tay sách)
//  4. drawStarTarget()     — Bia đo chất lượng in (dot gain, slur, doubling)
//  5. drawSideIndicator()  — Chữ "A" hoặc "B" lớn phân biệt mặt trước/sau
//  6. drawFolioMarks()     — Số trang nhỏ ở rìa trim box
// =========================================================================

/**
 * 1. PLATE LABEL — Nhãn thông tin kẽm
 * 
 * In dòng chữ Helvetica ở mép nhíp (Gripper edge = bottom of PDF).
 * Nội dung: [Tên file] - [Ngày giờ] - [Kẽm X - Tay Y Mặt A/B] - [Process CMYK]
 * 
 * Đây là thông tin BẮT BUỘC để thợ in và thợ CTP nhận diện kẽm.
 */
export function drawPlateLabel(
    page: PDFPage,
    font: PDFFont,
    pageW: number,
    pageH: number,
    labelText: string,
    gripperPt: number,
) {
    const FONT_SIZE = 6;
    const LABEL_Y = pageH - Math.max(gripperPt / 2 + FONT_SIZE / 2, 4); // Top of page, in the margin area above grid
    const LABEL_X = 10 * MM_TO_POINTS; // Cách mép trái 10mm

    try {
        page.drawText(labelText, {
            x: LABEL_X,
            y: LABEL_Y,
            size: FONT_SIZE,
            font: font,
            color: cmyk(1, 1, 1, 1),
        });
    } catch { /* non-fatal: font embed issue */ }
}

/**
 * 2. CENTER MARKS — Dấu dùi kẽm / canh giữa
 * 
 * Vẽ dấu chữ thập ở chính giữa mép trên (Top Center),
 * mép trái (Left Center), và mép phải (Right Center).
 * 
 * KHÔNG vẽ ở mép dưới (Bottom) vì đó là vùng nhíp (gripper).
 * 
 * Thợ in dùng dấu này để đục lỗ (dùi kẽm) và gá kẽm
 * vào lu-lô máy in cho cân xứng 2 bên.
 */
export function drawCenterMarks(
    page: PDFPage,
    pageW: number,
    pageH: number,
) {
    const CROSS_ARM = 4 * MM_TO_POINTS;
    const EDGE_OFF = 5 * MM_TO_POINTS;
    const THICK = 0.4;

    const centerX = pageW / 2;

    // Top Center (mép đuôi — đối diện nhíp)
    const topY = pageH - EDGE_OFF;
    drawLine(page, centerX - CROSS_ARM, topY, centerX + CROSS_ARM, topY, THICK);
    drawLine(page, centerX, topY - CROSS_ARM, centerX, topY + CROSS_ARM, THICK);
    const CR = 1.5 * MM_TO_POINTS;
    const segs = 12;
    for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2;
        const a2 = ((i + 1) / segs) * Math.PI * 2;
        drawLine(page,
            centerX + Math.cos(a1) * CR, topY + Math.sin(a1) * CR,
            centerX + Math.cos(a2) * CR, topY + Math.sin(a2) * CR,
            0.3
        );
    }

    // Left Center + Right Center (cho canh ngang khi in 2 mặt)
    const leftX = EDGE_OFF;
    const rightX = pageW - EDGE_OFF;
    const midY = pageH / 2;
    drawLine(page, leftX - CROSS_ARM, midY, leftX + CROSS_ARM, midY, THICK);
    drawLine(page, leftX, midY - CROSS_ARM, leftX, midY + CROSS_ARM, THICK);
    drawLine(page, rightX - CROSS_ARM, midY, rightX + CROSS_ARM, midY, THICK);
    drawLine(page, rightX, midY - CROSS_ARM, rightX, midY + CROSS_ARM, THICK);
}

/**
 * 3. COLLATION MARK (Sống gáy) — Dấu cầu thang kiểm tra thứ tự tay sách
 * 
 * Hình chữ nhật đen nhỏ (4×5mm) in ở vị trí gáy sách.
 * Mỗi tay sách, dấu này DỊCH XUỐNG một bậc (3mm).
 * 
 * Khi xếp chồng các tay sách, nhìn từ gáy sẽ thấy bậc thang:
 *   Tay 1:  ■
 *   Tay 2:    ■
 *   Tay 3:      ■
 *   Tay 4:        ■
 * 
 * Nếu tay nào bị lộn → bậc thang gãy → phát hiện ngay bằng mắt.
 */
export function drawCollationMark(
    page: PDFPage,
    pageW: number,
    pageH: number,
    sigIndex: number,
    totalSigs: number,
    gridX: number,
    gridY: number,
    totalGridH: number,
) {
    const MARK_W = 4 * MM_TO_POINTS;
    const MARK_H = 5 * MM_TO_POINTS;
    const STEP_DOWN = 3 * MM_TO_POINTS; // Mỗi tay lùi xuống 3mm

    // Vị trí X: Gáy sách = trung tâm tờ kẽm (fold line chính)
    const spineX = pageW / 2;
    const markX = spineX - MARK_W / 2;

    // Vị trí Y: Bắt đầu từ mép TRÊN grid (trên nhíp), mỗi tay lùi xuống 1 bậc
    const startY = gridY + totalGridH - MARK_H;
    const markY = startY - (sigIndex * STEP_DOWN);

    // Chỉ vẽ nếu còn trong phạm vi tờ giấy
    if (markY < 2 || markY + MARK_H > pageH - 2) return;

    page.drawRectangle({
        x: markX,
        y: markY,
        width: MARK_W,
        height: MARK_H,
        color: cmyk(1, 1, 1, 1),
    });
}

/**
 * 4. STAR TARGET — Bia đo chất lượng in
 * 
 * Hình tròn nhỏ với các đường xuyên tâm (giống logo Mercedes).
 * Thợ in dùng kính lúp soi bia này để kiểm tra:
 *   - Dot gain (chấm tram nở)
 *   - Slur (chấm tram bị kéo dài)
 *   - Doubling (chấm tram bị in đôi)
 * 
 * Đặt ở 2 vị trí: Giữa-Trái và Giữa-Phải của tờ kẽm.
 */
export function drawStarTarget(
    page: PDFPage,
    pageW: number,
    pageH: number,
) {
    const R = 2.5 * MM_TO_POINTS;
    const SPOKES = 36;
    const THICK = 0.2;
    const OFF_FROM_EDGE = 15 * MM_TO_POINTS;
    // Place at 3/4 height (above center marks at 1/2 height) to avoid overlap
    const targetY = pageH * 3 / 4;

    const positions = [
        { x: OFF_FROM_EDGE, y: targetY },            // Upper-Left
        { x: pageW - OFF_FROM_EDGE, y: targetY },    // Upper-Right
    ];

    for (const pos of positions) {
        if (pos.x < 2 || pos.x > pageW - 2 || pos.y < 2 || pos.y > pageH - 2) continue;

        // Vẽ các tia xuyên tâm
        for (let i = 0; i < SPOKES; i++) {
            const angle = (i / SPOKES) * Math.PI * 2;
            drawLine(page,
                pos.x, pos.y,
                pos.x + Math.cos(angle) * R,
                pos.y + Math.sin(angle) * R,
                THICK
            );
        }

        // Vòng tròn ngoài
        const segs = 24;
        for (let i = 0; i < segs; i++) {
            const a1 = (i / segs) * Math.PI * 2;
            const a2 = ((i + 1) / segs) * Math.PI * 2;
            drawLine(page,
                pos.x + Math.cos(a1) * R, pos.y + Math.sin(a1) * R,
                pos.x + Math.cos(a2) * R, pos.y + Math.sin(a2) * R,
                0.3
            );
        }
    }
}

/**
 * 5. SIDE INDICATOR — Chữ "A" hoặc "B" lớn phân biệt mặt trước/sau
 * 
 * In ký hiệu lớn ở góc mép nhíp (bottom-right) để thợ in
 * phân biệt nhanh mặt trước/sau khi xử lý kẽm tự trở.
 */
export function drawSideIndicator(
    page: PDFPage,
    font: PDFFont,
    pageW: number,
    pageH: number,
    side: 'front' | 'back' | 'self-turn',
    gripperPt: number,
) {
    if (side === 'self-turn') return; // Tự trở chỉ có 1 mặt, không cần chỉ thị

    const FONT_SIZE = 18;
    const label = side === 'front' ? 'A' : 'B';
    const x = pageW - 15 * MM_TO_POINTS; // Góc phải
    const y = pageH - Math.max(gripperPt / 2 + FONT_SIZE / 2, 4); // Top of page, next to plate label

    try {
        page.drawText(label, {
            x,
            y,
            size: FONT_SIZE,
            font: font,
            color: cmyk(1, 1, 1, 1),
        });
    } catch { /* non-fatal */ }
}

/**
 * 6. FOLIO MARKS — Số trang nhỏ ở rìa trim
 * 
 * In số trang nguồn (source page number) nhỏ xíu ở rìa
 * ngoài trim box của mỗi ô spread. Giúp kiểm tra nhanh 
 * thứ tự trang mà không cần mở file gốc.
 * 
 * Kích thước: 4pt, màu xám nhạt (để không bị nhầm với nội dung).
 */
export function drawFolioMarks(
    page: PDFPage,
    font: PDFFont,
    cellX: number,
    cellY: number,
    spreadW: number,
    spreadH: number,
    bleedPt: number,
    /** Mảng số trang nguồn trong spread này (ví dụ: [1, 16] cho spread đầu) */
    pageNumbers: number[],
) {
    const FONT_SIZE = 4;
    const OFF = 2 * MM_TO_POINTS; // Khoảng cách từ trim edge

    // Trim box bounds
    const trimX = cellX + bleedPt;
    const trimY = cellY + bleedPt;
    const trimW = spreadW - 2 * bleedPt;
    const trimH = spreadH - 2 * bleedPt;

    try {
        // Hiển thị số thứ tự spread ở giữa-dưới trim box
        if (pageNumbers.length > 0 && pageNumbers[0] > 0) {
            const text = `Sp.${pageNumbers[0]}`;
            const textW = font.widthOfTextAtSize(text, FONT_SIZE);
            page.drawText(text, {
                x: trimX + (trimW - textW) / 2, // Canh giữa
                y: trimY - FONT_SIZE - OFF,
                size: FONT_SIZE,
                font: font,
                color: cmyk(0, 0, 0, 0.5), // Xám nhạt
            });
        }
    } catch { /* non-fatal */ }
}
