// Test script: Compare hex layout output between TS and JSX logic
// Run: npx tsx src/lib/imposerEngine/__test_hex_parity.ts

// ============== JSX REFERENCE IMPLEMENTATION (pure port) ==============

function jsx_calculateItemsBoundingBox(items: any[]) {
    if (!items.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        // JSX uses 'ellipse' type → bbox = [cx-rx, cy-ry] to [cx+rx, cy+ry]
        const x1 = it.cx - it.rx;
        const y1 = it.cy - it.ry;
        const x2 = it.cx + it.rx;
        const y2 = it.cy + it.ry;
        if (x1 < minX) minX = x1;
        if (y1 < minY) minY = y1;
        if (x2 > maxX) maxX = x2;
        if (y2 > maxY) maxY = y2;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function jsx_calculateStaggeredHexLayoutCore(usableW: number, usableH: number, itemW: number, itemL: number, gapH: number, gapV: number) {
    const TOL = 0.001;
    if (itemW <= TOL || itemL <= TOL) return { totalItems: 0, items: [] as any[], widthUsed: 0, heightUsed: 0 };
    const rx = itemW / 2.0, ry = itemL / 2.0;
    if (usableW < itemW - TOL || usableH < itemL - TOL) return { totalItems: 0, items: [] as any[], widthUsed: 0, heightUsed: 0 };
    
    const step_x = itemW + gapH;
    const step_y = Math.sqrt(3) * (ry + gapV / 2.0);
    
    if (step_y <= TOL && Math.abs(ry + gapV / 2.0) > TOL) return { totalItems: 0, items: [] as any[], widthUsed: 0, heightUsed: 0 };
    
    const items: any[] = [];
    let maxRowsEstimate = 0;
    if (usableH >= itemL - TOL) {
        if (step_y > TOL) maxRowsEstimate = Math.floor((usableH - itemL + TOL) / step_y) + 1;
        else maxRowsEstimate = 1;
    }
    
    for (let row = 0; row < maxRowsEstimate; row++) {
        const cy = ry + row * step_y;
        if (cy - ry < -TOL || cy + ry > usableH + TOL) break;
        
        const isOddRow = (row % 2 !== 0);
        let numItems = 0;
        let rowStartX = 0;
        
        if (isOddRow) {
            rowStartX = rx + (itemW / 2.0) + (gapH / 2.0);
            if (usableW >= (rowStartX - rx + itemW - TOL)) {
                numItems = 1;
                if (step_x > TOL) {
                    const rem = usableW - (rowStartX - rx + itemW);
                    if (rem >= -TOL) numItems += Math.floor((rem + TOL) / step_x);
                }
            }
        } else {
            rowStartX = rx;
            if (usableW >= itemW - TOL) {
                numItems = 1;
                if (step_x > TOL) {
                    const rem = usableW - itemW;
                    if (rem >= -TOL) numItems += Math.floor((rem + TOL) / step_x);
                }
            }
        }
        if (numItems < 0) numItems = 0;
        
        for (let col = 0; col < numItems; col++) {
            const cx = rowStartX + col * step_x;
            if (cx - rx < -TOL || cx + rx > usableW + TOL) { if (col === 0) break; continue; }
            items.push({ cx, cy, rx, ry });
        }
    }
    
    if (!items.length) return { totalItems: 0, items: [] as any[], widthUsed: 0, heightUsed: 0 };
    
    const bb = jsx_calculateItemsBoundingBox(items);
    const offX = (usableW - bb.width) / 2.0 - bb.minX;
    const offY = (usableH - bb.height) / 2.0 - bb.minY;
    
    const centered = items.map(it => ({ cx: it.cx + offX, cy: it.cy + offY, rx: it.rx, ry: it.ry }));
    const finalBB = jsx_calculateItemsBoundingBox(centered);
    
    return { totalItems: centered.length, items: centered, widthUsed: finalBB.width, heightUsed: finalBB.height };
}

function jsx_calculateBestStaggeredHexLayout(usableW: number, usableH: number, itemW: number, itemL: number, gapH: number, gapV: number) {
    function transposeLayout(layout: any) {
        return {
            totalItems: layout.totalItems,
            items: layout.items.map((it: any) => ({ cx: it.cy, cy: it.cx, rx: it.ry, ry: it.rx })),
            widthUsed: layout.heightUsed,
            heightUsed: layout.widthUsed
        };
    }
    
    const rowOrig = jsx_calculateStaggeredHexLayoutCore(usableW, usableH, itemW, itemL, gapH, gapV);
    const rowRot = jsx_calculateStaggeredHexLayoutCore(usableW, usableH, itemL, itemW, gapV, gapH);
    const colOrigRaw = jsx_calculateStaggeredHexLayoutCore(usableH, usableW, itemL, itemW, gapV, gapH);
    const colOrig = transposeLayout(colOrigRaw);
    const colRotRaw = jsx_calculateStaggeredHexLayoutCore(usableH, usableW, itemW, itemL, gapH, gapV);
    const colRot = transposeLayout(colRotRaw);
    
    const candidates = [
        { result: rowOrig, isRotated: false, label: 'row_orig' },
        { result: rowRot, isRotated: true, label: 'row_rot' },
        { result: colOrig, isRotated: false, label: 'col_orig' },
        { result: colRot, isRotated: true, label: 'col_rot' }
    ];
    
    let bestIdx = 0;
    for (let c = 1; c < candidates.length; c++) {
        if (candidates[c].result.totalItems > candidates[bestIdx].result.totalItems) bestIdx = c;
    }
    
    return { ...candidates[bestIdx].result, bestLabel: candidates[bestIdx].label, isRotated: candidates[bestIdx].isRotated };
}

// ============== TS IMPLEMENTATION (current code port) ==============

function ts_calculateItemsBoundingBox(items: any[]) {
    if (!items.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of items) {
        if (it.x < minX) minX = it.x;
        if (it.y < minY) minY = it.y;
        if (it.x + it.width > maxX) maxX = it.x + it.width;
        if (it.y + it.height > maxY) maxY = it.y + it.height;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function ts_calculateStaggeredHexLayoutCore(usableW: number, usableH: number, itemW: number, itemL: number, gapH: number, gapV: number, isRotated: boolean) {
    const TOL = 0.001;
    if (itemW <= TOL || itemL <= TOL) return { cells: [] as any[], width: 0, height: 0, isRotated };
    const rx = itemW / 2.0, ry = itemL / 2.0;
    if (usableW < itemW - TOL || usableH < itemL - TOL) return { cells: [] as any[], width: 0, height: 0, isRotated };
    
    const step_x = itemW + gapH;
    const step_y = Math.sqrt(3) * (ry + gapV / 2.0);
    
    if (step_y <= TOL && Math.abs(ry + gapV / 2.0) > TOL) return { cells: [] as any[], width: 0, height: 0, isRotated };
    
    const items: any[] = [];
    let maxRowsEstimate = 0;
    if (usableH >= itemL - TOL) {
        if (step_y > TOL) maxRowsEstimate = Math.floor((usableH - itemL + TOL) / step_y) + 1;
        else maxRowsEstimate = 1;
    }
    
    for (let row = 0; row < maxRowsEstimate; row++) {
        const cy = ry + row * step_y;
        if (cy - ry < -TOL || cy + ry > usableH + TOL) break;
        
        const isOddRow = (row % 2 !== 0);
        let numItems = 0;
        let rowStartX = 0;
        
        if (isOddRow) {
            rowStartX = rx + (itemW / 2.0) + (gapH / 2.0);
            if (usableW >= (rowStartX - rx + itemW - TOL)) {
                numItems = 1;
                if (step_x > TOL) {
                    const rem = usableW - (rowStartX - rx + itemW);
                    if (rem >= -TOL) numItems += Math.floor((rem + TOL) / step_x);
                }
            }
        } else {
            rowStartX = rx;
            if (usableW >= itemW - TOL) {
                numItems = 1;
                if (step_x > TOL) {
                    const rem = usableW - itemW;
                    if (rem >= -TOL) numItems += Math.floor((rem + TOL) / step_x);
                }
            }
        }
        if (numItems < 0) numItems = 0;
        
        for (let col = 0; col < numItems; col++) {
            const cx = rowStartX + col * step_x;
            if (cx - rx < -TOL || cx + rx > usableW + TOL) { if (col === 0) break; continue; }
            items.push({ x: cx - rx, y: cy - ry, width: itemW, height: itemL, isRotated });
        }
    }
    
    if (!items.length) return { cells: [] as any[], width: 0, height: 0, isRotated };
    
    const bb = ts_calculateItemsBoundingBox(items);
    const offX = (usableW - bb.width) / 2.0 - bb.minX;
    const offY = (usableH - bb.height) / 2.0 - bb.minY;
    
    for (const it of items) { it.x += offX; it.y += offY; }
    
    return { cells: items, width: bb.width, height: bb.height, isRotated };
}

function ts_findBestHexagonalLayout(usableW: number, usableH: number, origW: number, origH: number, gapX: number, gapY: number) {
    const rowOrig = ts_calculateStaggeredHexLayoutCore(usableW, usableH, origW, origH, gapX, gapY, false);
    const rowRot = ts_calculateStaggeredHexLayoutCore(usableW, usableH, origH, origW, gapY, gapX, true);
    
    const colOrigRaw = ts_calculateStaggeredHexLayoutCore(usableH, usableW, origH, origW, gapY, gapX, false);
    const colRotRaw = ts_calculateStaggeredHexLayoutCore(usableH, usableW, origW, origH, gapX, gapY, true);
    
    const transposeBlock = (b: any) => {
        const cells = b.cells.map((c: any) => ({ ...c, x: c.y, y: c.x, width: c.height, height: c.width }));
        return { ...b, width: b.height, height: b.width, cells };
    };
    
    const colOrig = transposeBlock(colOrigRaw);
    const colRot = transposeBlock(colRotRaw);
    
    const candidates = [
        { block: rowOrig, label: 'row_orig' },
        { block: rowRot, label: 'row_rot' },
        { block: colOrig, label: 'col_orig' },
        { block: colRot, label: 'col_rot' }
    ];
    
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].block.cells.length > candidates[bestIdx].block.cells.length) bestIdx = i;
    }
    
    return { ...candidates[bestIdx].block, bestLabel: candidates[bestIdx].label };
}

// ============== RUN TESTS ==============

const testCases = [
    { usableW: 800, usableH: 500, itemW: 50, itemH: 50, gapX: 2, gapY: 2, name: "Square 50x50, 800x500 sheet" },
    { usableW: 800, usableH: 500, itemW: 60, itemH: 40, gapX: 2, gapY: 2, name: "Rect 60x40, 800x500 sheet" },
    { usableW: 310, usableH: 440, itemW: 30, itemH: 30, gapX: 1, gapY: 1, name: "Small circle 30x30, A3" },
    { usableW: 440, usableH: 310, itemW: 30, itemH: 30, gapX: 1, gapY: 1, name: "Small circle 30x30, A3 landscape" },
    { usableW: 600, usableH: 400, itemW: 45, itemH: 30, gapX: 3, gapY: 3, name: "Oval 45x30, 600x400 sheet" },
    { usableW: 400, usableH: 600, itemW: 45, itemH: 30, gapX: 3, gapY: 3, name: "Oval 45x30, 400x600 sheet (portrait)" },
    { usableW: 297, usableH: 210, itemW: 25, itemH: 25, gapX: 2, gapY: 2, name: "Circle 25mm, A4 landscape (mm)" },
    { usableW: 841.89, usableH: 595.28, itemW: 70.87, itemH: 70.87, gapX: 5.67, gapY: 5.67, name: "Circle 25mm in pts, A4 landscape" },
];

console.log("=" .repeat(80));
console.log("HEXAGONAL LAYOUT PARITY TEST: JSX vs TS");
console.log("=" .repeat(80));

let allPass = true;

for (const tc of testCases) {
    const jsx = jsx_calculateBestStaggeredHexLayout(tc.usableW, tc.usableH, tc.itemW, tc.itemH, tc.gapX, tc.gapY);
    const ts = ts_findBestHexagonalLayout(tc.usableW, tc.usableH, tc.itemW, tc.itemH, tc.gapX, tc.gapY);
    
    const match = jsx.totalItems === ts.cells.length;
    if (!match) allPass = false;
    
    console.log(`\n--- ${tc.name} ---`);
    console.log(`  JSX: ${jsx.totalItems} items, best=${jsx.bestLabel}, rotated=${jsx.isRotated}, widthUsed=${jsx.widthUsed.toFixed(3)}, heightUsed=${jsx.heightUsed.toFixed(3)}`);
    console.log(`  TS:  ${ts.cells.length} items, best=${ts.bestLabel}, widthUsed=${ts.width.toFixed(3)}, heightUsed=${ts.height.toFixed(3)}`);
    console.log(`  ${match ? '✅ PASS' : '❌ FAIL — COUNT MISMATCH!'}`);
    
    // Compare first few item positions
    if (jsx.totalItems > 0 && ts.cells.length > 0) {
        const jsxFirst = jsx.items[0];
        const tsFirst = ts.cells[0];
        const jsxX = jsxFirst.cx - jsxFirst.rx;
        const jsxY = jsxFirst.cy - jsxFirst.ry;
        const xDiff = Math.abs(jsxX - tsFirst.x);
        const yDiff = Math.abs(jsxY - tsFirst.y);
        console.log(`  First item: JSX(${jsxX.toFixed(3)}, ${jsxY.toFixed(3)}) vs TS(${tsFirst.x.toFixed(3)}, ${tsFirst.y.toFixed(3)}) — diff(${xDiff.toFixed(6)}, ${yDiff.toFixed(6)})`);
        if (xDiff > 0.01 || yDiff > 0.01) {
            console.log(`  ⚠️ POSITION MISMATCH`);
        }
    }
    
    // Show per-strategy counts
    const jsxRowOrig = jsx_calculateStaggeredHexLayoutCore(tc.usableW, tc.usableH, tc.itemW, tc.itemH, tc.gapX, tc.gapY);
    const jsxRowRot = jsx_calculateStaggeredHexLayoutCore(tc.usableW, tc.usableH, tc.itemH, tc.itemW, tc.gapY, tc.gapX);
    const jsxColOrigRaw = jsx_calculateStaggeredHexLayoutCore(tc.usableH, tc.usableW, tc.itemH, tc.itemW, tc.gapY, tc.gapX);
    const jsxColRotRaw = jsx_calculateStaggeredHexLayoutCore(tc.usableH, tc.usableW, tc.itemW, tc.itemH, tc.gapX, tc.gapY);
    
    const tsRowOrig = ts_calculateStaggeredHexLayoutCore(tc.usableW, tc.usableH, tc.itemW, tc.itemH, tc.gapX, tc.gapY, false);
    const tsRowRot = ts_calculateStaggeredHexLayoutCore(tc.usableW, tc.usableH, tc.itemH, tc.itemW, tc.gapY, tc.gapX, true);
    const tsColOrigRaw = ts_calculateStaggeredHexLayoutCore(tc.usableH, tc.usableW, tc.itemH, tc.itemW, tc.gapY, tc.gapX, false);
    const tsColRotRaw = ts_calculateStaggeredHexLayoutCore(tc.usableH, tc.usableW, tc.itemW, tc.itemH, tc.gapX, tc.gapY, true);
    
    console.log(`  Strategy breakdown:`);
    console.log(`    row_orig: JSX=${jsxRowOrig.totalItems}, TS=${tsRowOrig.cells.length}`);
    console.log(`    row_rot:  JSX=${jsxRowRot.totalItems},  TS=${tsRowRot.cells.length}`);
    console.log(`    col_orig: JSX=${jsxColOrigRaw.totalItems}, TS=${tsColOrigRaw.cells.length}`);
    console.log(`    col_rot:  JSX=${jsxColRotRaw.totalItems},  TS=${tsColRotRaw.cells.length}`);
}

console.log("\n" + "=" .repeat(80));
console.log(allPass ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED");
console.log("=" .repeat(80));
