// src/lib/imposerEngine/NupGridSolver.ts

export interface NupCell {
    c: number;
    r: number;
    x: number;
    y: number;
    width: number;
    height: number;
    isRotated: boolean;
    isRotated180?: boolean;
    blockId: number;
}

export interface NupBlock {
    id: number;
    cols: number;
    rows: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
    isRotated: boolean;
    cells: NupCell[];
}

export interface NupLayoutResult {
    totalItems: number;
    overallWidth: number;
    overallHeight: number;
    blocks: NupBlock[];
    cells: NupCell[]; // Flattened list for sequence mapping
}

interface NupShapeParams {
    effective_body_w_ratio?: number;
    bigEndAxisFrac?: number;
    waistRatio?: number;
    bigEndFirst?: boolean;
    smallD?: number;
    bodyW?: number;
    asymmOffset?: number;
    smallAsymmOffset?: number;
    gapMultiplierH?: number;
    deltaW?: number;
    peakHeightRatio?: number;
    pentagonOrientation?: string;
    leftOH?: number;
    rightOH?: number;
    bbW?: number;
    isHorizontal?: boolean;
    overhangX?: number;
    overhangY?: number;
}

function calculateBasicGrid(
    usableW: number, usableH: number,
    itemW: number, itemH: number,
    gapX: number, gapY: number,
    isRotated: boolean, blockId: number,
    offsetX: number, offsetY: number
): NupBlock {
    const stepX = itemW + gapX;
    const stepY = itemH + gapY;

    let cols = 0;
    if (usableW + 0.01 >= itemW) {
        cols = Math.floor((usableW - itemW + 0.01) / stepX) + 1;
    }
    if (cols < 0) cols = 0;

    let rows = 0;
    if (usableH + 0.01 >= itemH) {
        rows = Math.floor((usableH - itemH + 0.01) / stepY) + 1;
    }
    if (rows < 0) rows = 0;

    // Safety check recalculation
    let blockW = cols * itemW + (cols > 1 ? (cols - 1) * gapX : 0);
    while (cols > 0 && blockW > usableW + 0.01) {
        cols--;
        blockW = cols * itemW + (cols > 1 ? (cols - 1) * gapX : 0);
    }

    let blockH = rows * itemH + (rows > 1 ? (rows - 1) * gapY : 0);
    while (rows > 0 && blockH > usableH + 0.01) {
        rows--;
        blockH = rows * itemH + (rows > 1 ? (rows - 1) * gapY : 0);
    }

    const cells: NupCell[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            cells.push({
                c, r,
                x: offsetX + c * stepX,
                y: offsetY + r * stepY,
                width: itemW,
                height: itemH,
                isRotated,
                blockId
            });
        }
    }

    return {
        id: blockId,
        cols, rows,
        startX: offsetX, startY: offsetY,
        width: blockW, height: blockH,
        isRotated,
        cells
    };
}

// Mimics the calculateFillStrategy from the Campuchia script

function calculateItemsBoundingBox(items: NupCell[]) {
    if (items.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of items) {
        minX = Math.min(minX, item.x);
        minY = Math.min(minY, item.y);
        maxX = Math.max(maxX, item.x + item.width);
        maxY = Math.max(maxY, item.y + item.height);
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// =====================================================================
// HEXAGON TILING (proper 3/4 ratio for hex shapes, NOT circle packing)
// =====================================================================

function calculateHexTilingRowStagger(
    usableW: number, usableH: number,
    itemW: number, itemH: number,
    gapX: number, gapY: number,
    blockId: number, offsetX: number, offsetY: number, isRotated: boolean
): NupBlock {
    const TOL = 0.001;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated, cells: [] };
    if (itemW <= TOL || itemH <= TOL) return emptyBlock;
    if (usableW < itemW - TOL || usableH < itemH - TOL) return emptyBlock;

    const rx = itemW / 2.0, ry = itemH / 2.0;
    const stepX = itemW + gapX;
    // For interlocking rows (pointy-topped hexagon), stepY is 0.75 * itemH.
    // The columns do not overlap in X, but rows overlap in Y bounding box.
    const stepY = 0.75 * itemH + gapY;
    if (stepY <= TOL) return emptyBlock;

    const items: NupCell[] = [];
    const maxRows = usableH >= itemH - TOL ? Math.floor((usableH - itemH + TOL) / stepY) + 1 : 0;

    for (let row = 0; row < maxRows; row++) {
        const cy = ry + row * stepY;
        if (cy + ry > usableH + TOL) break;
        const isOdd = row % 2 !== 0;
        const rowStartX = isOdd ? rx + stepX / 2.0 : rx;
        const firstRightEdge = rowStartX + rx;
        let numInRow = 0;
        if (firstRightEdge <= usableW + TOL) {
            numInRow = 1;
            if (stepX > TOL) {
                const rem = usableW - firstRightEdge;
                if (rem >= -TOL) numInRow += Math.floor((rem + TOL) / stepX);
            }
        }
        for (let col = 0; col < numInRow; col++) {
            const cx = rowStartX + col * stepX;
            if (cx + rx > usableW + TOL) break;
            items.push({ c: col, r: row, x: cx - rx, y: cy - ry, width: itemW, height: itemH, isRotated, blockId });
        }
    }

    if (items.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(items);
    // NORMALIZE TO ORIGIN (0,0) - Do NOT center to usableW/usableH!
    // The engine applies a global centering using overallWidth/Height.
    const oX = -bb.minX;
    const oY = -bb.minY;
    for (const it of items) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated, cells: items };
}

function calculateHexTilingColStagger(
    usableW: number, usableH: number,
    itemW: number, itemH: number,
    gapX: number, gapY: number,
    blockId: number, offsetX: number, offsetY: number, isRotated: boolean
): NupBlock {
    const TOL = 0.001;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated, cells: [] };
    if (itemW <= TOL || itemH <= TOL) return emptyBlock;
    if (usableW < itemW - TOL || usableH < itemH - TOL) return emptyBlock;

    const rx = itemW / 2.0, ry = itemH / 2.0;
    // For interlocking columns (flat-topped hexagon), stepX is 0.75 * itemW.
    // The rows do not overlap in Y, but columns overlap in X bounding box.
    const stepX = 0.75 * itemW + gapX;
    const stepY = itemH + gapY;
    if (stepX <= TOL) return emptyBlock;

    const items: NupCell[] = [];
    const maxCols = usableW >= itemW - TOL ? Math.floor((usableW - itemW + TOL) / stepX) + 1 : 0;

    for (let col = 0; col < maxCols; col++) {
        const cx = rx + col * stepX;
        if (cx + rx > usableW + TOL) break;
        const isOdd = col % 2 !== 0;
        const colStartY = isOdd ? ry + stepY / 2.0 : ry;
        const firstBottomEdge = colStartY + ry;
        let numInCol = 0;
        if (firstBottomEdge <= usableH + TOL) {
            numInCol = 1;
            if (stepY > TOL) {
                const rem = usableH - firstBottomEdge;
                if (rem >= -TOL) numInCol += Math.floor((rem + TOL) / stepY);
            }
        }
        for (let row = 0; row < numInCol; row++) {
            const cy = colStartY + row * stepY;
            if (cy + ry > usableH + TOL) break;
            items.push({ c: col, r: row, x: cx - rx, y: cy - ry, width: itemW, height: itemH, isRotated, blockId });
        }
    }

    if (items.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(items);
    // NORMALIZE TO ORIGIN (0,0) - Do NOT center to usableW/usableH!
    const oX = -bb.minX;
    const oY = -bb.minY;
    for (const it of items) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated, cells: items };
}

function findBestHexTilingLayout(
    usableW: number, usableH: number, origW: number, origH: number,
    gapX: number, gapY: number, hexOrientation: string = 'pointy-top'
): NupLayoutResult {
    // 4 strategies: row/col × original/rotated
    const h1 = calculateHexTilingRowStagger(usableW, usableH, origW, origH, gapX, gapY, 0, 0, 0, false);
    const h2 = calculateHexTilingRowStagger(usableW, usableH, origH, origW, gapY, gapX, 0, 0, 0, true);
    const h3 = calculateHexTilingColStagger(usableW, usableH, origW, origH, gapX, gapY, 0, 0, 0, false);
    const h4 = calculateHexTilingColStagger(usableW, usableH, origH, origW, gapY, gapX, 0, 0, 0, true);

    const candidates = hexOrientation === 'pointy-top' ? [h1, h4] : [h3, h2];
    let best = candidates[0];
    for (const c of candidates) {
        if (c.cells.length > best.cells.length) best = c;
    }
    return { totalItems: best.cells.length, overallWidth: best.width, overallHeight: best.height, blocks: [best], cells: best.cells };
}

// =====================================================================
// CIRCLE/ELLIPSE STAGGER (sqrt(3) circle packing - for round shapes only)
// =====================================================================

function calculateStaggeredHexLayoutCore(
    usableW: number, usableH: number,
    itemW: number, itemL: number,
    gapH: number, gapV: number,
    blockId: number, offsetX: number, offsetY: number, isRotated: boolean
): NupBlock {
    const MY_SCRIPT_TOLERANCE = 0.001;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated, cells: [] };
    if (itemW <= MY_SCRIPT_TOLERANCE || itemL <= MY_SCRIPT_TOLERANCE) return emptyBlock;

    const rx = itemW / 2.0; const ry = itemL / 2.0;
    if (usableW < itemW - MY_SCRIPT_TOLERANCE || usableH < itemL - MY_SCRIPT_TOLERANCE) return emptyBlock;

    const step_x = itemW + gapH; const step_y = Math.sqrt(3) * (ry + gapV / 2.0);
    if (step_y <= MY_SCRIPT_TOLERANCE && Math.abs(ry + gapV / 2.0) > MY_SCRIPT_TOLERANCE) return emptyBlock;
    else if (step_y <= MY_SCRIPT_TOLERANCE) { if (usableH < itemL - MY_SCRIPT_TOLERANCE) return emptyBlock; }

    const items: NupCell[] = []; let maxRowsEstimate = 0;
    if (usableH >= itemL - MY_SCRIPT_TOLERANCE) {
        if (step_y > MY_SCRIPT_TOLERANCE) maxRowsEstimate = Math.floor((usableH - itemL + MY_SCRIPT_TOLERANCE) / step_y) + 1;
        else maxRowsEstimate = 1;
    }

    for (let row = 0; row < maxRowsEstimate; row++) {
        const current_center_y = ry + row * step_y;
        if (current_center_y - ry < -MY_SCRIPT_TOLERANCE || current_center_y + ry > usableH + MY_SCRIPT_TOLERANCE) break;
        const isOddRow = (row % 2 !== 0); let numItemsInRow = 0; let row_start_x_center = 0;
        if (isOddRow) {
            row_start_x_center = rx + (itemW / 2.0) + (gapH / 2.0);
            if (usableW >= (row_start_x_center - rx + itemW - MY_SCRIPT_TOLERANCE)) {
                numItemsInRow = 1;
                if (step_x > MY_SCRIPT_TOLERANCE) {
                    const remaining = usableW - (row_start_x_center - rx + itemW);
                    if (remaining >= -MY_SCRIPT_TOLERANCE) numItemsInRow += Math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_x);
                }
            }
        } else {
            row_start_x_center = rx;
            if (usableW >= itemW - MY_SCRIPT_TOLERANCE) {
                numItemsInRow = 1;
                if (step_x > MY_SCRIPT_TOLERANCE) {
                    const remaining = usableW - itemW;
                    if (remaining >= -MY_SCRIPT_TOLERANCE) numItemsInRow += Math.floor((remaining + MY_SCRIPT_TOLERANCE) / step_x);
                }
            }
        }
        if (numItemsInRow < 0) numItemsInRow = 0;
        for (let col = 0; col < numItemsInRow; col++) {
            const current_center_x = row_start_x_center + col * step_x;
            if (current_center_x - rx < -MY_SCRIPT_TOLERANCE || current_center_x + rx > usableW + MY_SCRIPT_TOLERANCE) { if (col === 0) break; continue; }
            items.push({ c: col, r: row, x: current_center_x - rx, y: current_center_y - ry, width: itemW, height: itemL, isRotated: isRotated, blockId: blockId });
        }
    }
    if (items.length === 0) return emptyBlock;

    const blockBB = calculateItemsBoundingBox(items);
    const centeringOffsetX = (usableW - blockBB.width) / 2.0 - blockBB.minX;
    const centeringOffsetY = (usableH - blockBB.height) / 2.0 - blockBB.minY;

    for (let j = 0; j < items.length; j++) {
        items[j].x += centeringOffsetX + offsetX;
        items[j].y += centeringOffsetY + offsetY;
    }

    return {
        id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY,
        width: blockBB.width, height: blockBB.height, isRotated, cells: items
    };
}


function calculateHammerColLayout(
    usableW: number, usableH: number,
    origW: number, origH: number,
    gapX: number, gapY: number,
    blockId: number, offsetX: number, offsetY: number,
    bigEndFirst: boolean = true,
    effectiveTailW: number = 0,
    safeAsymmBuffer: number = 0
): NupBlock {
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: 0, startY: 0, width: 0, height: 0, isRotated: false, cells: [] };
    const items: NupCell[] = [];

    if (origW < origH) return emptyBlock; // Horizontal hammer only
    if (usableW < origW || usableH < origH) return emptyBlock;

    const colPitch = (origW + effectiveTailW) / 2.0 + safeAsymmBuffer + gapX;
    const rowPitch = origH + gapY;

    let numCols = 0;
    if (usableW >= origW - 0.01) {
        numCols = Math.floor((usableW - origW + 0.01) / colPitch) + 1;
    }
    let numRows = 0;
    if (usableH >= origH - 0.01) {
        numRows = Math.floor((usableH - origH + 0.01) / rowPitch) + 1;
    }

    const halfW = origW / 2.0;
    const halfH = origH / 2.0;

    for (let col = 0; col < numCols; col++) {
        const cx = halfW + col * colPitch;
        if (cx + halfW > usableW + 0.01) continue;
        for (let row = 0; row < numRows; row++) {
            const cy = halfH + row * rowPitch;
            if (cy + halfH <= usableH + 0.01) {
                const isRotated180 = bigEndFirst ? (col % 2 !== 0) : (col % 2 === 0);
                items.push({ c: col, r: row, x: cx - halfW, y: cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: isRotated180, blockId });
            }
        }
    }

    if (items.length === 0) return emptyBlock;

    const blockBB = calculateItemsBoundingBox(items);
    const centeringOffsetX = (usableW - blockBB.width) / 2.0 - blockBB.minX;
    const centeringOffsetY = (usableH - blockBB.height) / 2.0 - blockBB.minY;

    for (let j = 0; j < items.length; j++) {
        items[j].x += centeringOffsetX + offsetX;
        items[j].y += centeringOffsetY + offsetY;
    }

    return {
        id: blockId, cols: numCols, rows: numRows, startX: offsetX, startY: offsetY,
        width: blockBB.width, height: blockBB.height, isRotated: false, cells: items
    };
}

function calculateHammerRowLayout(
    usableW: number, usableH: number,
    origW: number, origH: number,
    gapX: number, gapY: number,
    blockId: number, offsetX: number, offsetY: number,
    bigEndFirst: boolean = true,
    effectiveTailW: number = 0,
    safeAsymmBuffer: number = 0
): NupBlock {
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: 0, startY: 0, width: 0, height: 0, isRotated: false, cells: [] };
    const items: NupCell[] = [];

    if (origW >= origH) return emptyBlock; // Vertical hammer only
    if (usableW < origW || usableH < origH) return emptyBlock;

    const rowPitch = (origH + effectiveTailW) / 2.0 + safeAsymmBuffer + gapY;
    const colPitch = origW + gapX;

    let numRows = 0;
    if (usableH >= origH - 0.01) {
        numRows = Math.floor((usableH - origH + 0.01) / rowPitch) + 1;
    }
    let numCols = 0;
    if (usableW >= origW - 0.01) {
        numCols = Math.floor((usableW - origW + 0.01) / colPitch) + 1;
    }

    const halfW = origW / 2.0;
    const halfH = origH / 2.0;

    for (let row = 0; row < numRows; row++) {
        const cy = halfH + row * rowPitch;
        if (cy + halfH > usableH + 0.01) continue;
        for (let col = 0; col < numCols; col++) {
            const cx = halfW + col * colPitch;
            if (cx + halfW <= usableW + 0.01) {
                const isRotated180 = bigEndFirst ? (row % 2 !== 0) : (row % 2 === 0);
                items.push({ c: col, r: row, x: cx - halfW, y: cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: isRotated180, blockId });
            }
        }
    }

    if (items.length === 0) return emptyBlock;

    const blockBB = calculateItemsBoundingBox(items);
    const centeringOffsetX = (usableW - blockBB.width) / 2.0 - blockBB.minX;
    const centeringOffsetY = (usableH - blockBB.height) / 2.0 - blockBB.minY;

    for (let j = 0; j < items.length; j++) {
        items[j].x += centeringOffsetX + offsetX;
        items[j].y += centeringOffsetY + offsetY;
    }

    return {
        id: blockId, cols: numCols, rows: numRows, startX: offsetX, startY: offsetY,
        width: blockBB.width, height: blockBB.height, isRotated: false, cells: items
    };
}

function calculateDumbbellColLayout(
    usableW: number, usableH: number,
    origW: number, origH: number,
    gapX: number, gapY: number,
    blockId: number, offsetX: number, offsetY: number,
    _bigEndAxisFrac: number = 0.65,
    _waistRatio: number = 0.7,
    bigEndFirst: boolean = true,
    smallD: number = 0,
    bodyW: number = 0,
    smallAsymm: number = 0
): NupBlock {
    // Giữ tham số legacy để không làm lệch thứ tự đối số của các caller hiện tại.
    void _waistRatio;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: 0, startY: 0, width: 0, height: 0, isRotated: false, cells: [] };
    const items: NupCell[] = [];

    if (origW < origH) return emptyBlock;
    if (usableW < origW || usableH < origH) return emptyBlock;

    const effectiveSmallD = smallD + 2 * smallAsymm;
    const pitchBigHeads = origH + gapY;

    let pitchHandles = gapY;
    if (smallD > 0 && bodyW > 0) {
        pitchHandles = effectiveSmallD + bodyW + gapY * 2.0;
    }

    // Restore collision logic
    const r = origH / 2.0;
    const hShift = _bigEndAxisFrac * origW + gapX;
    const smallLen = 0.15 * origW;

    let dx = 0;
    if (r < hShift) {
        dx = hShift - r;
    } else if (r > hShift + smallLen) {
        dx = r - (hShift + smallLen);
    }
    const yCircle = Math.sqrt(Math.max(0, r*r - dx*dx));
    const minRowPitchHead = 2 * yCircle + effectiveSmallD + gapY * 2.0;

    const rowPitch = Math.max(pitchBigHeads, pitchHandles, minRowPitchHead);
    const vShift = rowPitch / 2.0;

    const pairWidth = origW + hShift;

    const minDx = Math.sqrt(Math.max(0, Math.pow(origH + gapX, 2) - Math.pow(rowPitch / 2.0, 2)));
    const minPairPitchHead = minDx + hShift + origW - origH;
    const minPairPitchHandle = hShift + origW - origH + gapX;
    let minPairPitchSmallHeads = 0;
    if (vShift < effectiveSmallD + gapY) {
        minPairPitchSmallHeads = hShift + origW + gapX;
    }
    let pairPitch = pairWidth + gapX;
    const newPairPitch = Math.max(minPairPitchHead, minPairPitchHandle, minPairPitchSmallHeads);
    if (newPairPitch < pairPitch) pairPitch = newPairPitch;

    let numPairs = 0;
    if (usableW >= pairWidth - 0.01) {
        numPairs = Math.floor((usableW - pairWidth + 0.01) / pairPitch) + 1;
    }
    let numRowsA = 0;
    if (usableH >= origH - 0.01) {
        numRowsA = Math.floor((usableH - origH + 0.01) / rowPitch) + 1;
    }
    let numRowsB = 0;
    if (usableH >= origH + vShift - 0.01) {
        numRowsB = Math.floor((usableH - origH - vShift + 0.01) / rowPitch) + 1;
    }

    const halfW = origW / 2.0;
    const halfH = origH / 2.0;

    for (let p = 0; p < numPairs; p++) {
        const baseX = p * pairPitch;
        const colA_cx = baseX + halfW + hShift;
        for (let row = 0; row < numRowsA; row++) {
            const cy = halfH + row * rowPitch;
            if (colA_cx + halfW <= usableW + 0.01 && cy + halfH <= usableH + 0.01) {
                items.push({ c: p*2+1, r: row, x: colA_cx - halfW, y: cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: !bigEndFirst, blockId });
            }
        }
        const colB_cx = baseX + halfW;
        for (let row = 0; row < numRowsB; row++) {
            const cy = halfH + vShift + row * rowPitch;
            if (colB_cx + halfW <= usableW + 0.01 && cy + halfH <= usableH + 0.01) {
                items.push({ c: p*2, r: row, x: colB_cx - halfW, y: cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: bigEndFirst, blockId });
            }
        }
    }

    if (numPairs === 0 && usableW >= origW - 0.01) {
        for (let row = 0; row < numRowsA; row++) {
            const cy = halfH + row * rowPitch;
            if (cy + halfH <= usableH + 0.01) {
                items.push({ c: 0, r: row, x: 0, y: cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: !bigEndFirst, blockId });
            }
        }
    }

    if (items.length === 0) return emptyBlock;

    const blockBB = calculateItemsBoundingBox(items);
    const centeringOffsetX = (usableW - blockBB.width) / 2.0 - blockBB.minX;
    const centeringOffsetY = (usableH - blockBB.height) / 2.0 - blockBB.minY;

    for (let j = 0; j < items.length; j++) {
        items[j].x += centeringOffsetX + offsetX;
        items[j].y += centeringOffsetY + offsetY;
    }

    return {
        id: blockId, cols: numPairs * 2, rows: Math.max(numRowsA, numRowsB), startX: offsetX, startY: offsetY,
        width: blockBB.width, height: blockBB.height, isRotated: false, cells: items
    };
}


function calculateDumbbellRowLayout(
    usableW: number, usableH: number,
    origW: number, origH: number,
    gapX: number, gapY: number,
    blockId: number, offsetX: number, offsetY: number,
    _bigEndAxisFrac: number = 0.65,
    _waistRatio: number = 0.7,
    bigEndFirst: boolean = true,
    smallD: number = 0,
    bodyW: number = 0,
    smallAsymm: number = 0
): NupBlock {
    // Giữ tham số legacy để không làm lệch thứ tự đối số của các caller hiện tại.
    void _waistRatio;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: 0, startY: 0, width: 0, height: 0, isRotated: false, cells: [] };
    const items: NupCell[] = [];

    if (origW >= origH) return emptyBlock;
    if (usableW < origW || usableH < origH) return emptyBlock;

    const effectiveSmallD = smallD + 2 * smallAsymm;
    const colPitchBigHeads = origW + gapX;

    let colPitchHandles = gapX;
    if (smallD > 0 && bodyW > 0) {
        colPitchHandles = effectiveSmallD + bodyW + gapX * 2.0;
    }

    // Restore collision logic
    const r = origW / 2.0;
    const vShift = _bigEndAxisFrac * origH + gapY;
    const smallLen = 0.15 * origH; // approximation or pass smallHeadFrac

    let dy = 0;
    if (r < vShift) {
        dy = vShift - r;
    } else if (r > vShift + smallLen) {
        dy = r - (vShift + smallLen);
    }
    const xCircle = Math.sqrt(Math.max(0, r*r - dy*dy));
    const minColPitchHead = 2 * xCircle + effectiveSmallD + gapX * 2.0;

    const colPitch = Math.max(colPitchBigHeads, colPitchHandles, minColPitchHead);
    const hShift = colPitch / 2.0;

    const pairHeight = origH + vShift;

    const minDy = Math.sqrt(Math.max(0, Math.pow(origW + gapY, 2) - Math.pow(colPitch / 2.0, 2)));
    const minPairVPitchHead = minDy + vShift + origH - origW;
    const minPairVPitchHandle = vShift + origH - origW + gapY;
    let minPairVPitchSmallHeads = 0;
    if (hShift < effectiveSmallD + gapX) {
        minPairVPitchSmallHeads = vShift + origH + gapY;
    }
    let pairVPitch = pairHeight + gapY;
    const newPairVPitch = Math.max(minPairVPitchHead, minPairVPitchHandle, minPairVPitchSmallHeads);
    if (newPairVPitch < pairVPitch) pairVPitch = newPairVPitch;

    let numPairs = 0;
    if (usableH >= pairHeight - 0.01) {
        numPairs = Math.floor((usableH - pairHeight + 0.01) / pairVPitch) + 1;
    }
    let numColsA = 0;
    if (usableW >= origW - 0.01) {
        numColsA = Math.floor((usableW - origW + 0.01) / colPitch) + 1;
    }
    let numColsB = 0;
    if (usableW >= origW + hShift - 0.01) {
        numColsB = Math.floor((usableW - origW - hShift + 0.01) / colPitch) + 1;
    }

    const halfW = origW / 2.0;
    const halfH = origH / 2.0;

    for (let p = 0; p < numPairs; p++) {
        const baseY = p * pairVPitch;
        const rowA_cy = baseY + halfH + vShift;
        for (let col = 0; col < numColsA; col++) {
            const cx = halfW + col * colPitch;
            if (cx + halfW <= usableW + 0.01 && rowA_cy + halfH <= usableH + 0.01) {
                items.push({ c: col, r: p*2+1, x: cx - halfW, y: rowA_cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: !bigEndFirst, blockId });
            }
        }
        const rowB_cy = baseY + halfH;
        for (let col = 0; col < numColsB; col++) {
            const cx = halfW + hShift + col * colPitch;
            if (cx + halfW <= usableW + 0.01 && rowB_cy + halfH <= usableH + 0.01) {
                items.push({ c: col, r: p*2, x: cx - halfW, y: rowB_cy - halfH, width: origW, height: origH, isRotated: false, isRotated180: bigEndFirst, blockId });
            }
        }
    }

    if (numPairs === 0 && usableH >= origH - 0.01) {
        for (let col = 0; col < numColsA; col++) {
            const cx = halfW + col * colPitch;
            if (cx + halfW <= usableW + 0.01) {
                items.push({ c: col, r: 0, x: cx - halfW, y: 0, width: origW, height: origH, isRotated: false, isRotated180: !bigEndFirst, blockId });
            }
        }
    }

    if (items.length === 0) return emptyBlock;

    const blockBB = calculateItemsBoundingBox(items);
    const centeringOffsetX = (usableW - blockBB.width) / 2.0 - blockBB.minX;
    const centeringOffsetY = (usableH - blockBB.height) / 2.0 - blockBB.minY;

    for (let j = 0; j < items.length; j++) {
        items[j].x += centeringOffsetX + offsetX;
        items[j].y += centeringOffsetY + offsetY;
    }

    return {
        id: blockId, cols: Math.max(numColsA, numColsB), rows: numPairs * 2, startX: offsetX, startY: offsetY,
        width: blockBB.width, height: blockBB.height, isRotated: false, cells: items
    };
}

// =====================================================================
// HEXAGON LAYOUTS (Pointy-top + Flat-top honeycomb)
// =====================================================================



// =====================================================================
// TRIANGLE LAYOUTS (Diamond interlock up/down, horizontal left/right)
// =====================================================================

function calculateStaggeredDiamondLayout(
    usableW: number, usableH: number, itemW: number, itemL: number,
    gapH: number, gapV: number, gapMultiplierH: number, deltaW: number,
    blockId: number, offsetX: number, offsetY: number
): NupBlock {
    const TOL = 0.001;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated: false, cells: [] };
    if (itemW <= 0 || itemL <= 0) return emptyBlock;
    const effectiveGapH = gapH * gapMultiplierH;
    const hSpacing = itemW + effectiveGapH + deltaW * 2;
    const vSpacing = itemL + gapV;
    const halfTriGap = gapV / 2;
    const items: NupCell[] = [];
    const colsScan = Math.ceil(usableW / hSpacing) + 1;
    const rowsScan = Math.ceil(usableH / vSpacing) + 1;
    for (let row = 0; row < rowsScan; row++) {
        for (let col = 0; col < colsScan; col++) {
            let dcx = col * hSpacing;
            const dcy = row * vSpacing;
            if (row % 2 !== 0) dcx += hSpacing * 0.5;
            const halfW = itemW / 2, halfH = itemL / 2;
            // Up triangle
            const topY = dcy + halfH + halfTriGap;
            if (dcx - halfW >= -TOL && dcx + halfW <= usableW + TOL && topY - halfH >= -TOL && topY + halfH <= usableH + TOL) {
                items.push({ c: col, r: row * 2, x: dcx - halfW, y: topY - halfH, width: itemW, height: itemL, isRotated: false, blockId });
            }
            // Down triangle (rotated 180)
            const botY = dcy - halfH - halfTriGap;
            if (dcx - halfW >= -TOL && dcx + halfW <= usableW + TOL && botY - halfH >= -TOL && botY + halfH <= usableH + TOL) {
                items.push({ c: col, r: row * 2 + 1, x: dcx - halfW, y: botY - halfH, width: itemW, height: itemL, isRotated: false, isRotated180: true, blockId });
            }
        }
    }
    if (items.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(items);
    const oX = (usableW - bb.width) / 2 - bb.minX;
    const oY = (usableH - bb.height) / 2 - bb.minY;
    for (const it of items) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated: false, cells: items };
}

function calculateHorizontalDiamondLayout(
    usableW: number, usableH: number, itemW: number, itemL: number,
    gapH: number, gapV: number, gapMultiplierH: number, deltaW: number,
    blockId: number, offsetX: number, offsetY: number
): NupBlock {
    const TOL = 0.001;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated: false, cells: [] };
    if (itemW <= 0 || itemL <= 0) return emptyBlock;
    const effectiveGapH = gapH * gapMultiplierH;
    const diamondAndGapW = (itemW + deltaW * 2) * 2 + effectiveGapH;
    const rowH = itemL + gapV;
    let numRows = Math.floor((usableH + gapV) / rowH);
    if (usableH < itemL) numRows = 0;
    const items: NupCell[] = [];
    for (let r = 0; r < numRows; r++) {
        const yCtr = itemL / 2 + r * rowH;
        const isOdd = r % 2 !== 0;
        const startX = isOdd ? (itemW + effectiveGapH / 2) : 0;
        let curX = startX;
        while (curX + itemW * 2 + effectiveGapH <= usableW + TOL) {
            const leftCx = curX + itemW / 2;
            // Left triangle (no rotation)
            items.push({ c: items.length, r, x: leftCx - itemW / 2, y: yCtr - itemL / 2, width: itemW, height: itemL, isRotated: false, blockId });
            // Right triangle (rotated 180)
            const rightCx = leftCx + itemW;
            items.push({ c: items.length, r, x: rightCx - itemW / 2, y: yCtr - itemL / 2, width: itemW, height: itemL, isRotated: false, isRotated180: true, blockId });
            curX += diamondAndGapW;
        }
    }
    if (items.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(items);
    const oX = (usableW - bb.width) / 2 - bb.minX;
    const oY = (usableH - bb.height) / 2 - bb.minY;
    for (const it of items) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated: false, cells: items };
}

function findBestTriangleLayout(
    usableW: number, usableH: number, origW: number, origH: number,
    gapX: number, gapY: number, gapMultiplierH: number, deltaW: number
): NupLayoutResult {
    // 4 strategies: vertical/horizontal × original/rotated
    const vOrig = calculateStaggeredDiamondLayout(usableW, usableH, origW, origH, gapX, gapY, gapMultiplierH, deltaW, 0, 0, 0);
    const hOrig = calculateHorizontalDiamondLayout(usableW, usableH, origW, origH, gapX, gapY, gapMultiplierH, deltaW, 0, 0, 0);
    // Rotated: swap usable dims, swap item dims
    const vRot = calculateStaggeredDiamondLayout(usableH, usableW, origW, origH, gapY, gapX, gapMultiplierH, deltaW, 0, 0, 0);
    const hRot = calculateHorizontalDiamondLayout(usableH, usableW, origW, origH, gapY, gapX, gapMultiplierH, deltaW, 0, 0, 0);
    // Transpose rotated results (swap x↔y)
    const transposeBlock = (b: NupBlock): NupBlock => {
        const cells = b.cells.map(c => ({ ...c, x: c.y, y: c.x, width: c.height, height: c.width }));
        return { ...b, width: b.height, height: b.width, cells };
    };
    const vRotT = transposeBlock(vRot);
    const hRotT = transposeBlock(hRot);
    // Mark transposed cells as rotated
    for (const c of vRotT.cells) c.isRotated = true;
    for (const c of hRotT.cells) c.isRotated = true;

    const candidates = [vOrig, hOrig, vRotT, hRotT];
    let best = candidates[0];
    for (const c of candidates) { if (c.cells.length > best.cells.length) best = c; }
    // Also compare with simple grid (non-staggered)
    const gridOrig = calculateBasicGrid(usableW, usableH, origW, origH, gapX, gapY, false, 0, 0, 0);
    const gridRot = calculateBasicGrid(usableW, usableH, origH, origW, gapX, gapY, true, 0, 0, 0);
    if (gridOrig.cells.length > best.cells.length) best = gridOrig;
    if (gridRot.cells.length > best.cells.length) best = gridRot;
    return { totalItems: best.cells.length, overallWidth: best.width, overallHeight: best.height, blocks: [best], cells: best.cells };
}

// =====================================================================
// PENTAGON LAYOUT (staggered rows with peak interlock)
// =====================================================================

function calculateAdvancedPentagonLayout(
    usableW: number, usableH: number, itemW: number, itemL: number,
    gapH: number, gapV: number, peakHeightRatio: number,
    startWithDown: boolean, pentagonOrientation: string,
    blockId: number, offsetX: number, offsetY: number
): NupBlock {
    const TOL = 0.001;
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated: false, cells: [] };
    if (itemW <= 0 || itemL <= 0) return emptyBlock;
    const hStep = itemW + gapH;

    const peakH = itemL * Math.max(0, Math.min(peakHeightRatio, 1));
    const baseH = itemL - peakH;

    const items: NupCell[] = [];
    let currentY = 0;
    let rowIdx = 0;

    while (currentY + itemL <= usableH + TOL) {
        // Is this row pointing 'down'?
        const isRowDown = startWithDown ? (rowIdx % 2 === 0) : (rowIdx % 2 !== 0);

        // original item points 'pentagonOrientation' ('up' or 'down')
        // isRotated180 is true if the row orientation differs from the original orientation
        const isRotated180 = (pentagonOrientation === 'down') ? !isRowDown : isRowDown;

        const isStag = (rowIdx % 2 !== 0); // Stagger odd rows
        const hOff = isStag ? hStep / 2 : 0;

        for (let c = 0; ; c++) {
            const cx = itemW / 2 + hOff + c * hStep;
            if (cx + itemW / 2 > usableW + TOL) break;
            items.push({
                c, r: rowIdx,
                x: cx - itemW / 2, y: currentY,
                width: itemW, height: itemL,
                isRotated: false, isRotated180, blockId
            });
        }

        // Vertical step logic:
        // If current row points DOWN, its peak is at the bottom. The next row points UP, its peak is at the top.
        // They interlock! Distance = baseH + gapV.
        // If current row points UP, its flat base is at the bottom. The next row points DOWN, its flat base is at the top.
        // They DO NOT interlock. Distance = itemL + gapV.
        const yStep = isRowDown ? (baseH + gapV) : (itemL + gapV);

        currentY += yStep;
        rowIdx++;
    }

    if (items.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(items);
    const oX = (usableW - bb.width) / 2 - bb.minX;
    const oY = (usableH - bb.height) / 2 - bb.minY;
    for (const it of items) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: rowIdx, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated: false, cells: items };
}

// =====================================================================
// TRAPEZOID LAYOUT (base-flip interlock)
// =====================================================================

function calculateInterlockingTrapezoidLayout(
    usableW: number, usableH: number, bbW: number, bbH: number,
    gapH: number, gapV: number, leftOH: number, rightOH: number,
    isHorizontalTrap: boolean, blockId: number, offsetX: number, offsetY: number
): NupBlock {
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated: false, cells: [] };
    if (bbW <= 0 || bbH <= 0) return emptyBlock;
    let bestItems: NupCell[] = [];
    for (let pass = 0; pass < 2; pass++) {
        const curW = pass === 0 ? bbW : bbH;
        const curH = pass === 0 ? bbH : bbW;
        const curGapH = pass === 0 ? gapH : gapV;
        const curGapV = pass === 0 ? gapV : gapH;
        const interlockX = pass === 0 ? isHorizontalTrap : !isHorizontalTrap;
        const curLeftOH = leftOH, curRightOH = rightOH;
        const halfW = curW / 2, halfH = curH / 2;
        const items: NupCell[] = [];
        if (interlockX) {
            const stepA = curW - curRightOH + curGapH;
            const stepB = curW - curLeftOH + curGapH;
            const stepY = curH + curGapV;
            let numRows = 1;
            if (stepY > 0) numRows = 1 + Math.floor((usableH - curH + 0.01) / stepY);
            for (let row = 0; row < numRows; row++) {
                const cy = halfH + row * stepY;
                if (cy + halfH > usableH + 0.01) break;
                let cx = halfW, col = 0;
                while (cx + halfW <= usableW + 0.01) {
                    const isFlip = col % 2 !== 0;
                    items.push({ c: col, r: row, x: cx - halfW, y: cy - halfH, width: curW, height: curH, isRotated: pass === 1, isRotated180: isFlip, blockId });
                    cx += (col % 2 === 0) ? stepA : stepB;
                    col++;
                }
            }
        } else {
            const stepA = curH - curRightOH + curGapV;
            const stepB = curH - curLeftOH + curGapV;
            const stepX = curW + curGapH;
            let numCols = 1;
            if (stepX > 0) numCols = 1 + Math.floor((usableW - curW + 0.01) / stepX);
            for (let col = 0; col < numCols; col++) {
                const cx = halfW + col * stepX;
                if (cx + halfW > usableW + 0.01) break;
                let cy = halfH, row = 0;
                while (cy + halfH <= usableH + 0.01) {
                    const isFlip = row % 2 !== 0;
                    items.push({ c: col, r: row, x: cx - halfW, y: cy - halfH, width: curW, height: curH, isRotated: pass === 1, isRotated180: isFlip, blockId });
                    cy += (row % 2 === 0) ? stepA : stepB;
                    row++;
                }
            }
        }
        if (items.length > bestItems.length) { bestItems = items; }
    }
    if (bestItems.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(bestItems);
    const oX = (usableW - bb.width) / 2 - bb.minX;
    const oY = (usableH - bb.height) / 2 - bb.minY;
    for (const it of bestItems) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated: false, cells: bestItems };
}

// =====================================================================
// PARALLELOGRAM LAYOUT (shift interlock)
// =====================================================================

function calculateInterlockingParallelogramLayoutFn(
    usableW: number, usableH: number, bbW: number, bbH: number,
    gapH: number, gapV: number, overhangX: number, overhangY: number,
    blockId: number, offsetX: number, offsetY: number
): NupBlock {
    const emptyBlock: NupBlock = { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: 0, height: 0, isRotated: false, cells: [] };
    if (bbW <= 0 || bbH <= 0) return emptyBlock;
    let bestItems: NupCell[] = [];
    // 4 passes: (orig/rot) × (interlock X / interlock Y)
    for (let pass = 0; pass < 4; pass++) {
        const isRot = pass >= 2;
        const interlockX = pass % 2 === 0;
        const curW = isRot ? bbH : bbW;
        const curH = isRot ? bbW : bbH;
        const curGapH = isRot ? gapV : gapH;
        const curGapV = isRot ? gapH : gapV;
        const curOHX = isRot ? overhangY : overhangX;
        const curOHY = isRot ? overhangX : overhangY;
        const halfW = curW / 2, halfH = curH / 2;
        const items: NupCell[] = [];
        if (interlockX && curOHX > 0.1) {
            const stepX = curW - curOHX + curGapH;
            const stepY = curH + curGapV;
            let nCols = 1; if (stepX > 0) nCols = 1 + Math.floor((usableW - curW + 0.01) / stepX);
            let nRows = 1; if (stepY > 0) nRows = 1 + Math.floor((usableH - curH + 0.01) / stepY);
            for (let row = 0; row < nRows; row++) {
                const cy = halfH + row * stepY;
                if (cy + halfH > usableH + 0.01) break;
                for (let col = 0; col < nCols; col++) {
                    const cx = halfW + col * stepX;
                    if (cx + halfW > usableW + 0.01) break;
                    items.push({ c: col, r: row, x: cx - halfW, y: cy - halfH, width: curW, height: curH, isRotated: isRot, isRotated180: col % 2 !== 0, blockId });
                }
            }
        } else if (!interlockX && curOHY > 0.1) {
            const stepX = curW + curGapH;
            const stepY = curH - curOHY + curGapV;
            let nCols = 1; if (stepX > 0) nCols = 1 + Math.floor((usableW - curW + 0.01) / stepX);
            let nRows = 1; if (stepY > 0) nRows = 1 + Math.floor((usableH - curH + 0.01) / stepY);
            for (let col = 0; col < nCols; col++) {
                const cx = halfW + col * stepX;
                if (cx + halfW > usableW + 0.01) break;
                for (let row = 0; row < nRows; row++) {
                    const cy = halfH + row * stepY;
                    if (cy + halfH > usableH + 0.01) break;
                    items.push({ c: col, r: row, x: cx - halfW, y: cy - halfH, width: curW, height: curH, isRotated: isRot, isRotated180: row % 2 !== 0, blockId });
                }
            }
        }
        if (items.length > bestItems.length) bestItems = items;
    }
    if (bestItems.length === 0) return emptyBlock;
    const bb = calculateItemsBoundingBox(bestItems);
    const oX = (usableW - bb.width) / 2 - bb.minX;
    const oY = (usableH - bb.height) / 2 - bb.minY;
    for (const it of bestItems) { it.x += oX + offsetX; it.y += oY + offsetY; }
    return { id: blockId, cols: 0, rows: 0, startX: offsetX, startY: offsetY, width: bb.width, height: bb.height, isRotated: false, cells: bestItems };
}

/**
 * @deprecated ORPHAN cho luồng tem/CNC. Từ "Imposition Engine Unification",
 * MỌI job N-up (tem bế / CNC / guillotine / nup) đi BACKEND qua /nup-start →
 * nguồn chân lý là `imposition_core` (Rust, parity-locked với Python
 * `sticker_imposer_pkg`). Xem processHandlers.runProcessEngine (nhánh
 * impositionMode === NUp) và ImpositionTab (sticker/cnc set impositionMode=NUp).
 *
 * Các nhánh shape-cụ-thể bên dưới (HAMMER/DUMBBELL/HEXAGON/TRIANGLE/PENTAGON/
 * CIRCLE_ELLIPSE/TRAPEZOID/PARALLELOGRAM dưới strategy 'optimal_auto') KHÔNG nằm
 * trên đường output của tem/CNC nữa — chỉ còn được gọi bởi `ProductAdvisor`
 * (dùng 'simple_auto' → bỏ qua các nhánh này) và đường legacy `imposePdf`.
 * KHÔNG mở rộng logic shape ở đây; sửa ở `imposition_core` (Rust) thay thế.
 * Lưu ý: thiếu nhánh 'ARROW' (Rust orchestrator gộp 'PENTAGON'|'ARROW') — minh
 * chứng cho việc bản TS đã drift; giữ lại chỉ để tương thích đường legacy.
 */
export function solveOptimalNupLayout(
    usableW: number, usableH: number,
    origW: number, origH: number,
    gapX: number, gapY: number,
    strategy: 'manual' | 'simple_auto' | 'optimal_auto' | 'staggered' | 'row_alt' | 'head_to_tail',
    manualCols: number, manualRows: number,
    splitGap: number = 14.17, // Mặc định 5mm (14.17 points) khoảng cách giữa cụm chính và phụ
    shapeType: string | null = null,
    shapeParams: string | null = null
): NupLayoutResult {
    // console.log(`[DEBUG solveOptimalNupLayout] strategy=${strategy}, shapeType=${shapeType}, origW=${origW}, origH=${origH}, usableW=${usableW}, usableH=${usableH}`);

    // AUTO OVERRIDE cho Búa/Tạ khi để chế độ optimal_auto
    if (strategy === 'optimal_auto') {
        let parsedParams: NupShapeParams = {};
        if (shapeParams) {
            try { parsedParams = JSON.parse(shapeParams) as NupShapeParams; } catch { /* Tham số shape tùy chọn không hợp lệ; dùng mặc định. */ }
        }

        if (shapeType === 'HAMMER' || shapeType === 'DUMBBELL') {
            const effectiveW = parsedParams.effective_body_w_ratio || parsedParams.bigEndAxisFrac || 0.65;
            const waistRatio = parsedParams.waistRatio || 0.7;
            const bigEndFirst = parsedParams.bigEndFirst ?? true;
            const smallD = parsedParams.smallD || 0;
            const bodyW = parsedParams.bodyW || 0;
            const smallAsymm = parsedParams.asymmOffset || parsedParams.smallAsymmOffset || 0;

            const evaluateUnifiedAsymmetric = (uW: number, uH: number, origW: number, origH: number, gapX: number, gapY: number, forceRotated: boolean, blockOffset: number, oX: number, oY: number): NupBlock => {
                const evalW = forceRotated ? origH : origW;
                const evalH = forceRotated ? origW : origH;
                const eGapX = forceRotated ? gapY : gapX;
                const eGapY = forceRotated ? gapX : gapY;

                let cands: NupBlock[] = [];
                if (shapeType === 'HAMMER') {
                    const hr = calculateHammerRowLayout(uW, uH, evalW, evalH, eGapX, eGapY, blockOffset, oX, oY, bigEndFirst, 0, 0);
                    const hc = calculateHammerColLayout(uW, uH, evalW, evalH, eGapX, eGapY, blockOffset, oX, oY, bigEndFirst, 0, 0);
                    cands = [hr, hc];
                } else {
                    const dr = calculateDumbbellRowLayout(uW, uH, evalW, evalH, eGapX, eGapY, blockOffset, oX, oY, effectiveW, waistRatio, bigEndFirst, smallD, bodyW, smallAsymm);
                    const dc = calculateDumbbellColLayout(uW, uH, evalW, evalH, eGapX, eGapY, blockOffset, oX, oY, effectiveW, waistRatio, bigEndFirst, smallD, bodyW, smallAsymm);
                    cands = [dr, dc];
                }

                let bestCand = cands[0];
                for (const cand of cands) {
                    if (cand.cells.length > bestCand.cells.length) bestCand = cand;
                }

                for (const item of bestCand.cells) {
                    item.isRotated = forceRotated;
                    if (forceRotated) {
                        item.width = origH;
                        item.height = origW;
                    }
                }
                return bestCand;
            };

            const bestMain = evaluateUnifiedAsymmetric(usableW, usableH, origW, origH, gapX, gapY, false, 0, 0, 0);
            const bestMainRot = evaluateUnifiedAsymmetric(usableW, usableH, origW, origH, gapX, gapY, true, 0, 0, 0);

            const bestPass = bestMain.cells.length >= bestMainRot.cells.length ? bestMain : bestMainRot;

            // L-shape fill logic
            const blocks: NupBlock[] = [bestPass];
            const spaceRightW = usableW - bestPass.width - gapX;
            const spaceBottomH = usableH - bestPass.height - gapY;

            const fillIsRotated = !bestPass.isRotated;
            const fillEvalW = fillIsRotated ? origH : origW;

            if (spaceRightW >= fillEvalW - 0.01) {
                const rightBlock = evaluateUnifiedAsymmetric(spaceRightW, usableH, origW, origH, gapX, gapY, fillIsRotated, 1, bestPass.width + gapX, 0);
                if (rightBlock.cells.length > 0) blocks.push(rightBlock);
            }

            if (spaceBottomH >= fillEvalW - 0.01) {
                const bottomBlock = evaluateUnifiedAsymmetric(usableW, spaceBottomH, origW, origH, gapX, gapY, fillIsRotated, blocks.length, 0, bestPass.height + gapY);
                if (bottomBlock.cells.length > 0) {
                    // Check for overlap with rightBlock
                    if (blocks.length > 1) {
                        bottomBlock.cells = bottomBlock.cells.filter(c => c.x + c.width <= bestPass.width + 0.01);
                    }
                    if (bottomBlock.cells.length > 0) blocks.push(bottomBlock);
                }
            }

            let totalItems = 0;
            const finalCells: NupCell[] = [];
            let maxW = 0, maxH = 0;
            for (const b of blocks) {
                totalItems += b.cells.length;
                finalCells.push(...b.cells);
                if (b.startX + b.width > maxW) maxW = b.startX + b.width;
                if (b.startY + b.height > maxH) maxH = b.startY + b.height;
            }

            // NORMALIZE TO ORIGIN (0,0) - Do NOT center to usableW/usableH!
            // The engine applies a global centering using overallWidth/Height.
            // Items are already generated starting at 0,0 (mainBlock at 0, fillBlocks offset from mainBlock).

            // console.log(`[DEBUG NupGridSolver ASYMMETRIC END] total: ${totalItems}`);
            return {
                totalItems,
                overallWidth: maxW,
                overallHeight: maxH,
                blocks: blocks,
                cells: finalCells
            };
        }

        // === HEXAGON: Proper hex tiling (3/4 ratio, NOT circle packing) ===
        if (shapeType === 'HEXAGON') {
            // console.log(`[DEBUG solveOptimalNupLayout HEXAGON] executing hex tiling 4-way evaluation (0.75 ratio)`);
            let hexOrientation = 'pointy-top';
            if (shapeParams) {
                try {
                    const parsed = JSON.parse(shapeParams);
                    if (parsed.hexOrientation) hexOrientation = parsed.hexOrientation;
                } catch { /* Tham số shape tùy chọn không hợp lệ; dùng mặc định. */ }
            }
            const hexResult = findBestHexTilingLayout(usableW, usableH, origW, origH, gapX, gapY, hexOrientation);
            if (hexResult.totalItems > 0) return hexResult;
        }

        // === TRIANGLE: Diamond interlock (4-way comparison) ===
        if (shapeType === 'TRIANGLE') {
            const gapMult = parsedParams.gapMultiplierH || 2.0;
            const dW = parsedParams.deltaW || 0;
            // console.log(`[DEBUG solveOptimalNupLayout TRIANGLE] gapMult=${gapMult}, deltaW=${dW}`);
            const triResult = findBestTriangleLayout(usableW, usableH, origW, origH, gapX, gapY, gapMult, dW);
            if (triResult.totalItems > 0) return triResult;
        }

        // === PENTAGON: Staggered row layout with peak interlock ===
        if (shapeType === 'PENTAGON') {
            const peakRatio = parsedParams.peakHeightRatio || 0.25;
            const orientation = parsedParams.pentagonOrientation || 'up';
            // console.log(`[DEBUG solveOptimalNupLayout PENTAGON] peakRatio=${peakRatio}, orientation=${orientation}`);

            // Try both starting orientations (Row 0 points Down vs Row 0 points Up)
            const p1 = calculateAdvancedPentagonLayout(usableW, usableH, origW, origH, gapX, gapY, peakRatio, true, orientation, 0, 0, 0);
            const p2 = calculateAdvancedPentagonLayout(usableW, usableH, origW, origH, gapX, gapY, peakRatio, false, orientation, 0, 0, 0);

            // Rotated 90 degrees (Build cols left to right)
            const transposeBlock = (b: NupBlock): NupBlock => {
                const cells = b.cells.map(c => ({ ...c, x: c.y, y: c.x, width: c.height, height: c.width }));
                return { ...b, width: b.height, height: b.width, cells };
            };
            const p3Raw = calculateAdvancedPentagonLayout(usableH, usableW, origW, origH, gapY, gapX, peakRatio, true, orientation, 0, 0, 0);
            const p4Raw = calculateAdvancedPentagonLayout(usableH, usableW, origW, origH, gapY, gapX, peakRatio, false, orientation, 0, 0, 0);

            const p3 = transposeBlock(p3Raw);
            const p4 = transposeBlock(p4Raw);
            for (const c of p3.cells) { c.isRotated = true; }
            for (const c of p4.cells) { c.isRotated = true; }

            const candidates = [p1, p2, p3, p4];
            let best = candidates[0];
            for (const c of candidates) {
                if (c.cells.length > best.cells.length) best = c;
            }
            if (best.cells.length > 0) {
                return { totalItems: best.cells.length, overallWidth: best.width, overallHeight: best.height, blocks: [best], cells: best.cells };
            }
        }

        // === CIRCLE_ELLIPSE: Auto-switch staggered hex vs grid ===
        if (shapeType === 'CIRCLE_ELLIPSE') {
            // console.log(`[DEBUG solveOptimalNupLayout CIRCLE_ELLIPSE] auto-stagger comparison`);
            const stag = calculateStaggeredHexLayoutCore(usableW, usableH, origW, origH, gapX, gapY, 0, 0, 0, false);
            const stagRot = calculateStaggeredHexLayoutCore(usableW, usableH, origH, origW, gapY, gapX, 0, 0, 0, true);
            for (const c of stagRot.cells) { c.isRotated = true; }
            const grid = calculateBasicGrid(usableW, usableH, origW, origH, gapX, gapY, false, 0, 0, 0);
            const gridRot = calculateBasicGrid(usableW, usableH, origH, origW, gapX, gapY, true, 0, 0, 0);
            const candidates = [stag, stagRot, grid, gridRot];
            let best = candidates[0];
            for (const c of candidates) { if (c.cells.length > best.cells.length) best = c; }
            if (best.cells.length > 0) {
                return { totalItems: best.cells.length, overallWidth: best.width, overallHeight: best.height, blocks: [best], cells: best.cells };
            }
        }

        // === TRAPEZOID: Base-flip interlock layout ===
        if (shapeType === 'TRAPEZOID') {
            const leftOH = (parsedParams.leftOH || 0) * (usableW > 0 ? origW / (parsedParams.bbW || origW) : 1);
            const rightOH = (parsedParams.rightOH || 0) * (usableW > 0 ? origW / (parsedParams.bbW || origW) : 1);
            const isHoriz = parsedParams.isHorizontal !== false;
            // console.log(`[DEBUG solveOptimalNupLayout TRAPEZOID] leftOH=${leftOH}, rightOH=${rightOH}, isHoriz=${isHoriz}`);
            const trapBlock = calculateInterlockingTrapezoidLayout(usableW, usableH, origW, origH, gapX, gapY, leftOH, rightOH, isHoriz, 0, 0, 0);
            // Compare with basic grid, pick best
            const gridBlock = calculateBasicGrid(usableW, usableH, origW, origH, gapX, gapY, false, 0, 0, 0);
            const gridRotBlock = calculateBasicGrid(usableW, usableH, origH, origW, gapX, gapY, true, 0, 0, 0);
            let best = trapBlock;
            if (gridBlock.cells.length > best.cells.length) best = gridBlock;
            if (gridRotBlock.cells.length > best.cells.length) best = gridRotBlock;
            if (best.cells.length > 0) {
                return { totalItems: best.cells.length, overallWidth: best.width, overallHeight: best.height, blocks: [best], cells: best.cells };
            }
        }

        // === PARALLELOGRAM: Shift interlock layout ===
        if (shapeType === 'PARALLELOGRAM') {
            const ohX = parsedParams.overhangX || 0;
            const ohY = parsedParams.overhangY || 0;
            // console.log(`[DEBUG solveOptimalNupLayout PARALLELOGRAM] ohX=${ohX}, ohY=${ohY}`);
            const paraBlock = calculateInterlockingParallelogramLayoutFn(usableW, usableH, origW, origH, gapX, gapY, ohX, ohY, 0, 0, 0);
            const gridBlock = calculateBasicGrid(usableW, usableH, origW, origH, gapX, gapY, false, 0, 0, 0);
            const gridRotBlock = calculateBasicGrid(usableW, usableH, origH, origW, gapX, gapY, true, 0, 0, 0);
            let best = paraBlock;
            if (gridBlock.cells.length > best.cells.length) best = gridBlock;
            if (gridRotBlock.cells.length > best.cells.length) best = gridRotBlock;
            if (best.cells.length > 0) {
                return { totalItems: best.cells.length, overallWidth: best.width, overallHeight: best.height, blocks: [best], cells: best.cells };
            }
        }
    }

    if (strategy === 'row_alt') {
        let parsedParams: NupShapeParams = {};
        if (shapeParams) {
            try { parsedParams = JSON.parse(shapeParams) as NupShapeParams; } catch { /* Tham số shape tùy chọn không hợp lệ; dùng mặc định. */ }
        }

        if (shapeType === 'DUMBBELL') {
            const effectiveW = parsedParams.effective_body_w_ratio || parsedParams.bigEndAxisFrac || 0.65;
            const waistRatio = parsedParams.waistRatio || 0.7;
            const bigEndFirst = parsedParams.bigEndFirst ?? true;
            const smallD = parsedParams.smallD || 0;
            const bodyW = parsedParams.bodyW || 0;
            const smallAsymm = parsedParams.asymmOffset || parsedParams.smallAsymmOffset || 0;
            const block = calculateDumbbellRowLayout(usableW, usableH, origW, origH, gapX, gapY, 0, 0, 0, effectiveW, waistRatio, bigEndFirst, smallD, bodyW, smallAsymm);
            return { totalItems: block.cells.length, overallWidth: block.width, overallHeight: block.height, blocks: [block], cells: block.cells };
        } else {
            const bigEndFirst = parsedParams.bigEndFirst ?? true;
            const block = calculateHammerRowLayout(usableW, usableH, origW, origH, gapX, gapY, 0, 0, 0, bigEndFirst);
            return { totalItems: block.cells.length, overallWidth: block.width, overallHeight: block.height, blocks: [block], cells: block.cells };
        }
    }

    if (strategy === 'optimal_auto') {
        if (shapeType === 'HAMMER' || shapeType === 'DUMBBELL') {
            strategy = 'head_to_tail';
        } else if (shapeType === 'HEXAGON') {
            strategy = 'staggered';
        }
    }

    if (strategy === 'head_to_tail') {
        let parsedParams: NupShapeParams = {};
        if (shapeParams) {
            try { parsedParams = JSON.parse(shapeParams) as NupShapeParams; } catch { /* Tham số shape tùy chọn không hợp lệ; dùng mặc định. */ }
        }

        if (shapeType === 'DUMBBELL') {
            const effectiveW = parsedParams.effective_body_w_ratio || parsedParams.bigEndAxisFrac || 0.65;
            const waistRatio = parsedParams.waistRatio || 0.7;
            const bigEndFirst = parsedParams.bigEndFirst ?? true;
            const smallD = parsedParams.smallD || 0;
            const bodyW = parsedParams.bodyW || 0;
            const smallAsymm = parsedParams.asymmOffset || parsedParams.smallAsymmOffset || 0;

            const tryPass = (w: number, h: number, gx: number, gy: number, isRot: boolean) => {
                const block = calculateDumbbellColLayout(usableW, usableH, w, h, gx, gy, 0, 0, 0, effectiveW, waistRatio, bigEndFirst, smallD, bodyW, smallAsymm);
                if (isRot) block.cells.forEach(c => c.isRotated = !c.isRotated); // Mark as rotated
                return { totalItems: block.cells.length, overallWidth: block.width, overallHeight: block.height, blocks: [block], cells: block.cells };
            };

            const p1 = tryPass(origW, origH, gapX, gapY, false);
            const p2 = tryPass(origH, origW, gapY, gapX, true);
            return p1.totalItems >= p2.totalItems ? p1 : p2;

        } else {
            const bigEndFirst = parsedParams.bigEndFirst ?? true;

            const tryPass = (w: number, h: number, gx: number, gy: number, isRot: boolean) => {
                const block = calculateHammerColLayout(usableW, usableH, w, h, gx, gy, 0, 0, 0, bigEndFirst);
                if (isRot) block.cells.forEach(c => c.isRotated = !c.isRotated); // Mark as rotated
                return { totalItems: block.cells.length, overallWidth: block.width, overallHeight: block.height, blocks: [block], cells: block.cells };
            };

            const p1 = tryPass(origW, origH, gapX, gapY, false);
            const p2 = tryPass(origH, origW, gapY, gapX, true);
            return p1.totalItems >= p2.totalItems ? p1 : p2;
        }
    }

    if (strategy === 'manual') {
        const blockW = manualCols * origW + (manualCols > 1 ? (manualCols - 1) * gapX : 0);
        const blockH = manualRows * origH + (manualRows > 1 ? (manualRows - 1) * gapY : 0);
        const block = calculateBasicGrid(blockW, blockH, origW, origH, gapX, gapY, false, 0, 0, 0);
        // Force manual cols/rows even if it exceeds
        block.cols = manualCols;
        block.rows = manualRows;
        block.width = blockW;
        block.height = blockH;

        const cells: NupCell[] = [];
        for (let r = 0; r < manualRows; r++) {
            for (let c = 0; c < manualCols; c++) {
                cells.push({
                    c, r,
                    x: c * (origW + gapX),
                    y: r * (origH + gapY),
                    width: origW,
                    height: origH,
                    isRotated: false,
                    blockId: 0
                });
            }
        }
        block.cells = cells;

        return {
            totalItems: manualCols * manualRows,
            overallWidth: blockW,
            overallHeight: blockH,
            blocks: [block],
            cells: block.cells
        };
    }


    if (strategy === 'staggered') {
        // If shape is explicitly HEXAGON, staggered strategy should use proper hex tiling
        if (shapeType === 'HEXAGON') {
            // console.log(`[DEBUG NupGridSolver] Using hex tiling for staggered strategy (shape=HEXAGON)`);
            let hexOrientation = 'pointy-top';
            if (shapeParams) {
                try {
                    const parsed = JSON.parse(shapeParams);
                    if (parsed.hexOrientation) hexOrientation = parsed.hexOrientation;
                } catch { /* Tham số shape tùy chọn không hợp lệ; dùng mặc định. */ }
            }
            return findBestHexTilingLayout(usableW, usableH, origW, origH, gapX, gapY, hexOrientation);
        }

        const rowOrig = calculateStaggeredHexLayoutCore(usableW, usableH, origW, origH, gapX, gapY, 0, 0, 0, false);
        const rowRot = calculateStaggeredHexLayoutCore(usableW, usableH, origH, origW, gapY, gapX, 0, 0, 0, true);

        const colOrigRaw = calculateStaggeredHexLayoutCore(usableH, usableW, origH, origW, gapY, gapX, 0, 0, 0, false);
        const colRotRaw = calculateStaggeredHexLayoutCore(usableH, usableW, origW, origH, gapX, gapY, 0, 0, 0, true);

        const transposeBlock = (b: NupBlock): NupBlock => {
            const cells = b.cells.map(c => ({ ...c, x: c.y, y: c.x, width: c.height, height: c.width }));
            return { ...b, width: b.height, height: b.width, cells };
        };

        const colOrig = transposeBlock(colOrigRaw);
        const colRot = transposeBlock(colRotRaw);

        const candidates = [rowOrig, rowRot, colOrig, colRot];
        let best = candidates[0];
        for (const c of candidates) {
            if (c.cells.length > best.cells.length) best = c;
        }

        return {
            totalItems: best.cells.length,
            overallWidth: best.width,
            overallHeight: best.height,
            blocks: [best],
            cells: best.cells
        };
    }

    if (strategy === 'simple_auto') {
        const p1 = calculateBasicGrid(usableW, usableH, origW, origH, gapX, gapY, false, 0, 0, 0);
        const p2 = calculateBasicGrid(usableW, usableH, origH, origW, gapX, gapY, true, 0, 0, 0);

        const best = (p1.cells.length >= p2.cells.length) ? p1 : p2;
        return {
            totalItems: best.cells.length,
            overallWidth: best.width,
            overallHeight: best.height,
            blocks: [best],
            cells: best.cells
        };
    }

    // optimal_auto logic!
    // Try both unrotated primary and rotated primary, see which gives best yield.
    const solveL_shape = (mainW: number, mainH: number, fillW: number, fillH: number, primaryRotated: boolean) => {
        let bestYield = 0;
        let bestConfig: NupBlock[] = [];
        let bestWidth = 0;
        let bestHeight = 0;

        const maxGrid = calculateBasicGrid(usableW, usableH, mainW, mainH, gapX, gapY, primaryRotated, 0, 0, 0);
        const maxCols = maxGrid.cols;
        const maxRows = maxGrid.rows;

        const MAX_REDUCE = 1;

        for (let reduceCols = 0; reduceCols <= Math.min(MAX_REDUCE, maxCols - 1); reduceCols++) {
            for (let reduceRows = 0; reduceRows <= Math.min(MAX_REDUCE, maxRows - 1); reduceRows++) {
                if (reduceCols > 0 && reduceRows > 0) continue; // Only reduce one dimension at a time

                const tryCols = Math.max(0, maxCols - reduceCols);
                const tryRows = Math.max(0, maxRows - reduceRows);
                if (tryCols === 0 || tryRows === 0) continue;

                const tryBlockW = tryCols * mainW + (tryCols > 1 ? (tryCols - 1) * gapX : 0);
                const tryBlockH = tryRows * mainH + (tryRows > 1 ? (tryRows - 1) * gapY : 0);

                const blocks: NupBlock[] = [];

                // MAIN BLOCK
                const mainBlock = calculateBasicGrid(tryBlockW, tryBlockH, mainW, mainH, gapX, gapY, primaryRotated, 0, 0, 0);
                blocks.push(mainBlock);

                let fillRCount = 0;
                let fillBCount = 0;

                // RIGHT FILL
                const rightX = tryBlockW + splitGap;
                const rightW = usableW - rightX;
                if (rightW > 0.01) {
                    const fillR = calculateBasicGrid(rightW, usableH, fillW, fillH, gapX, gapY, !primaryRotated, 1, rightX, 0);
                    if (fillR.cells.length > 0) {
                        blocks.push(fillR);
                        fillRCount = fillR.cells.length;
                    }
                }

                // BOTTOM FILL

                // If there's a Right Fill block, it might extend lower than the Main Block.
                // In Campuchia script, Bottom Region starts below the MAX of MainBlock & FillR
                const fillR_actualH = blocks.length > 1 ? blocks[1].height : tryBlockH;
                const overallH = Math.max(tryBlockH, fillR_actualH);
                const actualBottomY = overallH + splitGap;
                const actualBottomH = usableH - actualBottomY;
                const actualBottomW = usableW;

                if (actualBottomW > 0.01 && actualBottomH > 0.01) {
                    const fillB = calculateBasicGrid(actualBottomW, actualBottomH, fillW, fillH, gapX, gapY, !primaryRotated, blocks.length, 0, actualBottomY);
                    if (fillB.cells.length > 0) {
                        blocks.push(fillB);
                        fillBCount = fillB.cells.length;
                    }
                }

                const totalYield = mainBlock.cells.length + fillRCount + fillBCount;

                // Pick config if strictly better, or if equal and less reduction (purer grid)
                if (totalYield > bestYield) {
                    bestYield = totalYield;
                    bestConfig = blocks;

                    let maxRight = 0; let maxBottom = 0;
                    for(const b of blocks) {
                        maxRight = Math.max(maxRight, b.startX + b.width);
                        maxBottom = Math.max(maxBottom, b.startY + b.height);
                    }
                    bestWidth = maxRight;
                    bestHeight = maxBottom;
                }
            }
        }

        return {
            totalItems: bestYield,
            overallWidth: bestWidth,
            overallHeight: bestHeight,
            blocks: bestConfig
        };
    };

    const strategyOrig = solveL_shape(origW, origH, origH, origW, false);
    const strategyRot = solveL_shape(origH, origW, origW, origH, true);

    const bestStrategy = (strategyOrig.totalItems >= strategyRot.totalItems) ? strategyOrig : strategyRot;

    const offsetX = 0;
    const offsetY = 0;

    const finalCells: NupCell[] = [];
    for (const b of bestStrategy.blocks) {
        b.startX += offsetX;
        b.startY += offsetY;
        for (const c of b.cells) {
            c.x += offsetX;
            c.y += offsetY;
            finalCells.push(c);
        }
    }

    return {
        totalItems: bestStrategy.totalItems,
        overallWidth: bestStrategy.overallWidth,
        overallHeight: bestStrategy.overallHeight,
        blocks: bestStrategy.blocks,
        cells: finalCells
    };
}
