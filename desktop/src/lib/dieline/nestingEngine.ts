// ============================================================
// Nesting Engine — Thuật toán bình bản lồng khuôn
//
// Grid mode:  Step & repeat đều (cellH = bboxH + gap)
// Smart mode: Lồng khuôn — giảm cellH per box type:
//   RTE:        KHÔNG xoay, xếp sát, cellH = bboxH - closureH - tuckH + gap
//   SLB:        Xoay 180° xen kẽ hàng, cellH = bboxH - closureH - tuckH + gap
//   Cup Sleeve: Xoay 180° xen kẽ CỘT, đầu nhỏ lồng khoảng trống đầu lớn
//   Gable:      Chỉ xếp lưới (không lồng được)
//
// Công thức: cellH = bboxH - (nắp + tai đút) + gap
//   nắp = closureH = W + T
//   tai đút = tuckH = TH
// ============================================================

import { NestingConfig, NestingResult, PlacedDieline, SuperTileInfo } from './nestingTypes';
import { BoxParams } from './types';
import { snap } from './utils';

interface BBox {
    width: number;
    height: number;
}

type LayoutResult = {
    positions: PlacedDieline[];
    cols: number;
    rows: number;
    label: string;
    superTile: SuperTileInfo | null;
};

// ── Printable area ──────────────────────────────────────

function calcPrintableArea(
    sheetW: number, sheetH: number,
    margin: { top: number; right: number; bottom: number; left: number },
    gripperMargin: number,
): { areaW: number; areaH: number; offsetX: number; offsetY: number } {
    // Cắn nhíp nằm ở PHÍA DƯỚI tờ giấy (cạnh dẫn vào máy offset)
    const effectiveBottom = Math.max(margin.bottom, gripperMargin);
    return {
        areaW: sheetW - margin.left - margin.right,
        areaH: sheetH - margin.top - effectiveBottom,
        offsetX: margin.left,
        offsetY: margin.top,  // Dielines bắt đầu từ lề trên
    };
}

// ── Grid helpers ────────────────────────────────────────

function gridPositions(
    cols: number, rows: number,
    cellW: number, cellH: number,
    ox: number, oy: number,
    rotation: number,
): PlacedDieline[] {
    const positions: PlacedDieline[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            positions.push({
                x: ox + c * cellW,
                y: oy + r * cellH,
                rotation,
            });
        }
    }
    return positions;
}

// ── Grid layouts ────────────────────────────────────────

function calcGridNone(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
): LayoutResult {
    const cellW = dieW + gap;
    const cellH = dieH + gap;
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW));
    const rows = Math.max(0, Math.floor((areaH + gap) / cellH));
    return {
        positions: gridPositions(cols, rows, cellW, cellH, ox, oy, 0),
        cols, rows, label: 'Grid 0°', superTile: null,
    };
}

function calcGrid90(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
): LayoutResult {
    // Chỉ trả về layout 90° — layout 0° đã có calcGridNone
    const cellW90 = dieH + gap;
    const cellH90 = dieW + gap;
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW90));
    const rows = Math.max(0, Math.floor((areaH + gap) / cellH90));
    return {
        positions: gridPositions(cols, rows, cellW90, cellH90, ox, oy, 90),
        cols, rows, label: 'Grid 90°', superTile: null,
    };
}

// ── Smart: Lồng khuôn per box type ─────────────────────

/**
 * RTE: KHÔNG xoay. Tất cả hàng 0°.
 * cellH = bboxH - closureH - tuckH + gap
 *
 * Vì closure+tuck chỉ chiếm Front/Back panel (L-wide),
 * còn dust flap chỉ chiếm Side panel (W-wide),
 * nên các hàng có thể xếp sát mà không chạm nhau.
 */
function calcRTEInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    closureH: number, tuckH: number, dustH: number, D: number,
): LayoutResult {
    const cellW = dieW + gap;
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW));

    // Overlap lý tưởng = closureH + tuckH
    // Nhưng phải đảm bảo tai bụi 2 hàng kề không chạm:
    // cellH ≥ D + 2*dustH + gap → overlap ≤ bboxH - D - 2*dustH
    const maxOverlap = snap(Math.max(0, dieH - D - 2 * dustH));
    const overlapY = snap(Math.min(closureH + tuckH, maxOverlap));
    const cellH = Math.max(gap + 1, dieH - overlapY + gap);

    // Hàng đầu cần full bboxH, các hàng sau cần cellH
    const rows = cellH > 0
        ? Math.max(0, 1 + Math.floor(Math.max(0, areaH - dieH) / cellH))
        : 0;

    const positions: PlacedDieline[] = [];
    for (let r = 0; r < rows; r++) {
        const y = oy + r * cellH;
        // Kiểm tra hàng cuối không vượt quá area
        if (y + dieH > oy + areaH + 0.1) break;
        for (let c = 0; c < cols; c++) {
            positions.push({
                x: ox + c * cellW,
                y,
                rotation: 0, // KHÔNG xoay
            });
        }
    }

    const superTile: SuperTileInfo = {
        tileWidth: dieW,
        tileHeight: snap(cellH),
        countPerTile: 1,
        strategy: `Xen kẽ khoảng trống (−${Math.round(overlapY)}mm/hàng)`,
        savedMm: snap(overlapY),
    };

    return {
        positions, cols,
        rows: Math.ceil(positions.length / Math.max(1, cols)),
        label: `Xen kẽ khoảng trống (−${Math.round(overlapY)}mm/hàng)`,
        superTile: positions.length > 0 ? superTile : null,
    };
}

/**
 * SLB: Lồng theo CẶP — 2 hàng lồng nhau, giữa các cặp cách gap.
 *
 * Mỗi cặp gồm:
 *   - Hàng A: 0° (hướng gốc)
 *   - Hàng B: 180° tại tâm + dịch phải |L−W|
 * Trong cặp: overlap = closureH + tuckH − lockTabH − gap
 * Giữa cặp: khoảng cách = gap
 */
function calcSLBInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    closureH: number, tuckH: number, _dustH: number, _D: number,
    lockTabH: number,
    L: number, W: number, G: number,
): LayoutResult {
    const cellW = dieW + gap;
    const cols = Math.max(0, Math.floor((areaW + gap) / cellW));

    // Overlap trong cặp: nắp gài + tai đút − lưỡi khoá − khoảng cách
    const overlapY = snap(Math.max(0, closureH + tuckH - lockTabH - gap));

    // Hàng xoay dịch phải = W + G (chiều rộng hộp + mí dán)
    const shiftX = W + G;
    const colsShifted = Math.max(0, Math.floor((areaW + gap - shiftX) / cellW));

    // Pair geometry
    const pairH = 2 * dieH - overlapY;       // Chiều cao 1 cặp (2 hàng lồng)
    const pairStep = pairH + gap;              // Bước giữa các cặp

    const positions: PlacedDieline[] = [];
    let pairIdx = 0;

    while (true) {
        const pairStart = oy + pairIdx * pairStep;

        // Hàng A (180° + dịch phải)
        const yA = pairStart;
        if (yA + dieH > oy + areaH + 0.1) break;
        for (let c = 0; c < colsShifted; c++) {
            positions.push({ x: ox + shiftX + c * cellW, y: yA, rotation: 180 });
        }

        // Hàng B (0°) — đối đầu với hàng A
        const yB = pairStart + dieH - overlapY;
        if (yB + dieH > oy + areaH + 0.1) {
            break;
        }
        for (let c = 0; c < cols; c++) {
            positions.push({ x: ox + c * cellW, y: yB, rotation: 0 });
        }

        pairIdx++;
    }

    const totalRows = Math.ceil(positions.length / Math.max(1, cols));

    const superTile: SuperTileInfo = {
        tileWidth: dieW,
        tileHeight: snap(pairH),
        countPerTile: 2,
        strategy: `Lồng cặp 180° (−${Math.round(overlapY)}mm, dịch ${shiftX}mm${lockTabH > 0 ? `, khoá ${lockTabH}mm` : ''})`,
        savedMm: snap(overlapY),
    };

    return {
        positions, cols,
        rows: totalRows,
        label: `Lồng cặp 180° (−${Math.round(overlapY)}mm${lockTabH > 0 ? `, khoá` : ''})`,
        superTile: positions.length > 0 ? superTile : null,
    };
}

/**
 * Cup Sleeve: Lồng khuôn hình quạt — tự động chọn hướng tối ưu.
 *
 * Thử 2 phương án:
 *   A) primary 0° (overlap slant) + fill 90° vào phần dư
 *   B) primary 90° (grid thường) + fill 0° vào phần dư
 * Chọn phương án cho nhiều khuôn nhất.
 *
 *   ┌──────────────┬──────┐
 *   │   primary    │ fill │  ← dải dư bên phải
 *   │  cols × rows │strip │
 *   │              │      │
 *   ├──────────────┘      │
 *   │  fill bottom strip  │  ← dải dư phía dưới
 *   └─────────────────────┘
 */

/** Helper: xếp 1 hướng chính + lấp phần dư bằng hướng còn lại.
 *  0°: overlap dọc (hàng) → pCellH = slant+gap, pCellW = dieW+gap
 *  90°: overlap ngang (cột) → pCellW = slant+gap, pCellH = dieW+gap
 */
function calcCupSleeveOneOrientation(
    pW: number, pH: number,
    fW: number, fH: number,
    pCellW: number, pCellH: number,  // primary spacing (W=ngang, H=dọc)
    fCellW: number, fCellH: number,  // fill spacing
    gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    pRot: number, fRot: number,
): { positions: PlacedDieline[]; primaryCount: number; bonusCount: number } {
    const cols = Math.max(0, Math.floor((areaW + gap) / pCellW));
    const rows = pCellH > 0
        ? Math.max(0, 1 + Math.floor(Math.max(0, areaH - pH) / pCellH))
        : 0;

    const positions: PlacedDieline[] = [];
    let actualRows = 0;

    for (let r = 0; r < rows; r++) {
        const y = oy + r * pCellH;
        if (y + pH > oy + areaH + 0.1) break;
        actualRows++;
        for (let c = 0; c < cols; c++) {
            positions.push({ x: ox + c * pCellW, y, rotation: pRot });
        }
    }

    const primaryCount = positions.length;
    let bonusCount = 0;

    const baseGridWidth = cols > 0 ? cols * pW + (cols - 1) * gap : 0;
    const baseGridHeight = actualRows > 0 ? (actualRows - 1) * pCellH + pH : 0;

    // ── A: Dải dư bên PHẢI ──
    const rightGapAvailable = areaW - baseGridWidth - gap;
    if (rightGapAvailable >= fW) {
        const rightStartX = ox + baseGridWidth + gap;
        const fColsR = Math.max(0, Math.floor((rightGapAvailable + gap) / fCellW));
        const fRowsR = Math.max(0, Math.floor((baseGridHeight + gap) / fCellH));

        for (let r = 0; r < fRowsR; r++) {
            for (let c = 0; c < fColsR; c++) {
                const xf = rightStartX + c * fCellW;
                const yf = oy + r * fCellH;
                if (xf + fW > ox + areaW + 0.1) break;
                if (yf + fH > oy + areaH + 0.1) break;
                positions.push({ x: xf, y: yf, rotation: fRot });
                bonusCount++;
            }
        }
    }

    // ── B: Dải dư phía DƯỚI ──
    const bottomGapAvailable = areaH - baseGridHeight - gap;
    if (bottomGapAvailable >= fH) {
        const bottomStartY = oy + baseGridHeight + gap;
        const fColsB = Math.max(0, Math.floor((baseGridWidth + gap) / fCellW));
        const fRowsB = Math.max(0, Math.floor((bottomGapAvailable + gap) / fCellH));

        for (let r = 0; r < fRowsB; r++) {
            for (let c = 0; c < fColsB; c++) {
                const xf = ox + c * fCellW;
                const yf = bottomStartY + r * fCellH;
                if (xf + fW > ox + baseGridWidth + 0.1) break;
                if (yf + fH > oy + areaH + 0.1) break;
                positions.push({ x: xf, y: yf, rotation: fRot });
                bonusCount++;
            }
        }
    }

    return { positions, primaryCount, bonusCount };
}

function calcCupSleeveInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    params: BoxParams,
): LayoutResult {
    const d1 = params.cupD1 / 10;
    const d2 = params.cupD2 / 10;
    const h = params.cupH / 10;
    const heightType = params.cupHeightType;

    const baseHalf = (d2 - d1) / 2;
    const slantH = heightType === 'slant' ? h : Math.sqrt(h * h + baseHalf * baseHalf);
    const slantMm = slantH * 10;

    // ── Phương án A: primary 0° + fill 90° ──
    // 0° primary: overlap dọc → pCellW = dieW+gap (bình thường), pCellH = slant+gap (smart)
    // 90° fill: overlap ngang → fCellW = slant+gap (smart), fCellH = dieW+gap (bình thường)
    const smartCell = snap(slantMm + gap);
    const a = calcCupSleeveOneOrientation(
        dieW, dieH, dieH, dieW,
        snap(dieW + gap), smartCell,  // pCellW, pCellH
        smartCell, snap(dieW + gap),  // fCellW, fCellH
        gap, areaW, areaH, ox, oy, 0, 90,
    );

    // ── Phương án B: primary 90° + fill 0° ──
    // 90° primary: overlap ngang → pCellW = slant+gap (smart), pCellH = dieW+gap (bình thường)
    // 0° fill: overlap dọc → fCellW = dieW+gap (bình thường), fCellH = slant+gap (smart)
    const b = calcCupSleeveOneOrientation(
        dieH, dieW, dieW, dieH,
        smartCell, snap(dieW + gap),  // pCellW, pCellH
        snap(dieW + gap), smartCell,  // fCellW, fCellH
        gap, areaW, areaH, ox, oy, 90, 0,
    );

    // Chọn phương án nhiều khuôn hơn
    const best = a.positions.length >= b.positions.length ? a : b;
    const isPlanA = best === a;
    const bonusCount = best.bonusCount;
    const totalCount = best.positions.length;
    const effectiveOverlap = isPlanA ? snap(Math.max(0, dieH + gap - smartCell)) : 0;

    const label = bonusCount > 0
        ? `Tối ưu (${totalCount} khuôn, +${bonusCount} xoay ${isPlanA ? '90' : '0'}°)`
        : isPlanA
            ? `Lồng cung (−${Math.round(effectiveOverlap)}mm/hàng)`
            : `Grid 90°`;

    const superTile: SuperTileInfo = {
        tileWidth: isPlanA ? dieW : dieH,
        tileHeight: snap(smartCell),
        countPerTile: bonusCount > 0 ? 2 : 1,
        strategy: label,
        savedMm: snap(effectiveOverlap),
    };

    return {
        positions: best.positions,
        cols: isPlanA
            ? Math.max(0, Math.floor((areaW + gap) / (dieW + gap)))
            : Math.max(0, Math.floor((areaW + gap) / (dieH + gap))),
        rows: Math.ceil(totalCount / Math.max(1, Math.floor((areaW + gap) / ((isPlanA ? dieW : dieH) + gap)))),
        label,
        superTile: totalCount > 0 ? superTile : null,
    };
}

/**
 * Pizza Box: Lồng 180° THEO CỘT — xoay xen kẽ, side wall lồng vào nhau.
 *
 * Pizza layout: body rộng L nằm giữa, 2 side wall mỗi bên rộng sideExt.
 * → dieW = L + 2*sideExt (sideExt ≈ 2D+T+1)
 *
 * Khi xoay 180°, side wall bên phải box A lồng vào side wall bên trái box B:
 *   Col 0 (0°):     [sideL | body L | sideR]
 *   Col 1 (180°):         [sideR' | body L | sideL']
 *                    ↑ overlap = sideExt
 *
 * Cột xoay dịch dọc (Y) = body height shift để tai bụi front/back lồng nhau.
 * Overlap ngang = sideExt (chiều rộng 1 cánh side wall)
 */
function calcPizzaInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    D: number,
): LayoutResult {
    // Tính side wall extension từ thông số hình học pizza
    // X_outer = 2D+T (đã snap ở PizzaBox.ts), X_tab = X_outer + T + 1
    // sideExt ≈ X_tab ≈ (2D + 2T + 1) — phần nhô ra mỗi bên so với body L
    // Thực tế: sideExt = (dieW - L) / 2, nhưng ta không có L ở đây.
    // Dùng estimate: sideExt ≈ dieW/2 − (dieW − 2*(2*D + 3)) / 2 = 2D+3
    // Đơn giản: overlapX = 2*D — khoảng lồng an toàn giữa side walls
    const overlapX = snap(Math.max(D, 5)); // = tai nắp depth

    // Chiều ngang mỗi cột
    const cellW = dieW + gap;                    // Bước cột bình thường (0°)
    const cellWShifted = cellW - overlapX;        // Bước cột lồng (180°)

    // Canh thẳng hàng — không dịch dọc
    const shiftY = 0;

    // Tính số cột: xen kẽ 0° và 180°
    // Mỗi cặp 2 cột: cellW + cellWShifted
    const pairW = cellW + cellWShifted;
    const maxPairs = pairW > 0 ? Math.floor((areaW + gap) / pairW) : 0;
    // Kiểm tra còn dư cho 1 cột nữa?
    const remainW = areaW + gap - maxPairs * pairW;
    const extraCol = remainW >= cellW ? 1 : 0;

    // Chiều dọc
    const cellH = dieH + gap;
    const rows = cellH > 0 ? Math.max(0, Math.floor((areaH + gap) / cellH)) : 0;
    const rowsShifted = cellH > 0
        ? Math.max(0, Math.floor((areaH + gap - shiftY) / cellH))
        : 0;

    const positions: PlacedDieline[] = [];

    // Xếp theo cặp cột
    for (let pair = 0; pair < maxPairs; pair++) {
        const baseX = pair * pairW;

        // Cột A (0°)
        for (let r = 0; r < rows; r++) {
            const y = oy + r * cellH;
            if (y + dieH > oy + areaH + 0.1) break;
            positions.push({ x: ox + baseX, y, rotation: 0 });
        }

        // Cột B (180°, dịch trái overlapX, dịch dọc shiftY)
        const xB = baseX + cellW - overlapX;
        for (let r = 0; r < rowsShifted; r++) {
            const y = oy + shiftY + r * cellH;
            if (y + dieH > oy + areaH + 0.1) break;
            positions.push({ x: ox + xB, y, rotation: 180 });
        }
    }

    // Cột dư cuối (nếu có) — 0°
    if (extraCol > 0) {
        const xExtra = maxPairs * pairW;
        for (let r = 0; r < rows; r++) {
            const y = oy + r * cellH;
            if (y + dieH > oy + areaH + 0.1) break;
            positions.push({ x: ox + xExtra, y, rotation: 0 });
        }
    }

    const totalCols = maxPairs * 2 + extraCol;
    const superTile: SuperTileInfo = {
        tileWidth: snap(pairW),
        tileHeight: dieH,
        countPerTile: 2,
        strategy: `Lồng pizza 180° (−${Math.round(overlapX)}mm/cột, side wall D=${D})`,
        savedMm: snap(overlapX),
    };

    return {
        positions,
        cols: totalCols,
        rows: Math.ceil(positions.length / Math.max(1, totalCols)),
        label: `Lồng pizza 180° (−${Math.round(overlapX)}mm/cột)`,
        superTile: positions.length > 0 ? superTile : null,
    };
}

// ── Envelope helpers (mirror auto-calc từ Envelope.ts) ──────
function envAutoFlapH(envH: number): number {
    return snap(Math.round(envH * 0.45));
}
function envAutoSideFlap(envH: number): number {
    return snap(Math.max(10, Math.min(15, envH * 0.12)));
}

/**
 * Envelope: Lồng khuôn bì thư — chiến lược phụ thuộc kiểu bì.
 *
 * ── Bì ngang (wallet) — lồng theo CỘT ──
 * Cột B (180°): dịch XUỐNG FH, dịch TRÁI (SF − gap)
 *   → overlapX = SF − gap (tai hông lồng vào nhau)
 *   → shiftY = FH (nắp dán lồng xuống)
 *
 * ── Bì dọc (pocket) — lồng theo HÀNG (3 hàng lặp lại) ──
 * Hàng 1 (0°): gốc
 * Hàng 2 (180°): dịch TRÁI ½SF, dịch LÊN (SF − gap)
 * Hàng 3 (0°): dịch LÊN hàng 2 thêm (FH − gap)
 */
function calcEnvelopeInterlock(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    params: BoxParams,
): LayoutResult {
    const isVertical = params.envStyle === 'pocket';

    // Tính FH, SF giống Envelope.ts
    const W = isVertical ? params.envH : params.envW;
    const H = isVertical ? params.envW : params.envH;
    const flapRef = isVertical ? W : H;
    const FH = params.envFH > 0
        ? snap(params.envFH)
        : (params.envFlapShape === 'straight' ? 30 : envAutoFlapH(flapRef));
    const SF = params.envSF > 0 ? snap(params.envSF) : envAutoSideFlap(flapRef);

    const positions: PlacedDieline[] = [];

    if (!isVertical) {
        // ═══════════════════════════════════════════════
        // BÌ NGANG (wallet) — lồng theo CỘT (đều)
        // ═══════════════════════════════════════════════
        // Mỗi cột kề nhau đều lồng (SF − gap), xoay xen kẽ 0°/180°.
        // Cột chẵn (0°): vị trí bình thường
        // Cột lẻ (180°): dịch xuống FH
        const overlapX = snap(Math.max(0, SF - gap));
        const shiftY = snap(FH);

        const colStep = dieW + gap - overlapX;       // bước đều giữa mọi cột kề
        const cellH = dieH + gap;

        // Tính tổng số cột vừa area
        // Cột đầu cần dieW, mỗi cột tiếp cần thêm colStep
        const totalCols = colStep > 0
            ? Math.max(0, 1 + Math.floor(Math.max(0, areaW - dieW) / colStep))
            : (dieW <= areaW ? 1 : 0);

        // Hàng cho cột 0° vs 180°
        const rowsNormal = cellH > 0 ? Math.max(0, Math.floor((areaH + gap) / cellH)) : 0;
        const rowsShifted = cellH > 0
            ? Math.max(0, Math.floor((areaH + gap - shiftY) / cellH))
            : 0;

        for (let col = 0; col < totalCols; col++) {
            const xCol = col * colStep;
            if (xCol + dieW > areaW + 0.1) break;

            const is180 = col % 2 === 1;  // cột lẻ xoay 180°
            const yShift = is180 ? shiftY : 0;
            const rows = is180 ? rowsShifted : rowsNormal;

            for (let r = 0; r < rows; r++) {
                const y = oy + yShift + r * cellH;
                if (y + dieH > oy + areaH + 0.1) break;
                positions.push({ x: ox + xCol, y, rotation: is180 ? 180 : 0 });
            }
        }

        const superTile: SuperTileInfo = {
            tileWidth: snap(colStep * 2),
            tileHeight: dieH,
            countPerTile: 2,
            strategy: `Lồng bì ngang 180° (−${Math.round(overlapX)}mm/cột, ↓${Math.round(shiftY)}mm)`,
            savedMm: snap(overlapX),
        };

        return {
            positions,
            cols: totalCols,
            rows: Math.ceil(positions.length / Math.max(1, totalCols)),
            label: `Lồng bì ngang (−${Math.round(overlapX)}mm/cột)`,
            superTile: positions.length > 0 ? superTile : null,
        };
    } else {
        // ═══════════════════════════════════════════════
        // BÌ DỌC (pocket) — lồng LIÊN TỤC xen kẽ 0°/180°
        // ═══════════════════════════════════════════════
        // Hàng chẵn (0°): vị trí bình thường
        // Hàng lẻ (180°): dịch trái 1.5×SF
        // Overlap xen kẽ:
        //   chẵn→lẻ: overlapA = SF − gap
        //   lẻ→chẵn: overlapB = FH − gap
        const overlapA = snap(Math.max(0, SF - gap));   // 0°→180°
        const overlapB = snap(Math.max(0, FH - gap));   // 180°→0°
        const shiftX = snap(SF * 1.5);                  // Hàng lẻ dịch trái

        // Bước 2 hàng liên tiếp (1 cặp chẵn+lẻ)
        const stepA = dieH - overlapA;   // khoảng cách hàng chẵn→lẻ
        const stepB = dieH - overlapB;   // khoảng cách hàng lẻ→chẵn tiếp
        const pairStep = stepA + stepB;  // chiều cao 1 cặp (dùng để lặp)

        const cellW = dieW + gap;
        const cols = Math.max(0, Math.floor((areaW + gap) / cellW));
        const colsShifted = Math.max(0, Math.floor((areaW + gap + shiftX) / cellW));

        let rowIdx = 0;
        let currentY = oy;
        while (true) {
            if (currentY + dieH > oy + areaH + 0.1) break;

            const is180 = rowIdx % 2 === 1;

            if (is180) {
                // Hàng lẻ: 180°, dịch trái shiftX
                for (let c = 0; c < colsShifted; c++) {
                    const xPos = ox - shiftX + c * cellW;
                    if (xPos + dieW > ox + areaW + shiftX + 0.1) break;
                    positions.push({ x: xPos, y: currentY, rotation: 180 });
                }
                currentY += stepB;  // tiến tới hàng chẵn tiếp theo
            } else {
                // Hàng chẵn: 0°, vị trí bình thường
                for (let c = 0; c < cols; c++) {
                    positions.push({ x: ox + c * cellW, y: currentY, rotation: 0 });
                }
                currentY += stepA;  // tiến tới hàng lẻ tiếp theo
            }

            rowIdx++;
        }

        const totalSaved = snap(overlapA + overlapB);
        const superTile: SuperTileInfo = {
            tileWidth: dieW,
            tileHeight: snap(pairStep),
            countPerTile: 2,
            strategy: `Lồng bì dọc liên tục (−${Math.round(overlapA)}+${Math.round(overlapB)}mm, ←${Math.round(shiftX)}mm)`,
            savedMm: totalSaved,
        };

        return {
            positions,
            cols,
            rows: Math.ceil(positions.length / Math.max(1, cols)),
            label: `Lồng bì dọc (−${Math.round(totalSaved)}mm/cặp)`,
            superTile: positions.length > 0 ? superTile : null,
        };
    }
}

/**
 * Smart nesting: chọn chiến lược theo boxType
 */
function calcSmart(
    dieW: number, dieH: number, gap: number,
    areaW: number, areaH: number,
    ox: number, oy: number,
    params: BoxParams,
): LayoutResult {
    // Tính closureH + tuckH + dustH
    const closureH = snap(params.W + params.T);
    const tuckH = snap(params.TH);
    const autoDustH = snap(Math.min(params.L / 2 - 1, params.W + params.T));
    const dustH = params.DFH > 0 ? snap(Math.min(params.DFH, params.L / 2 - 1)) : autoDustH;
    const safeDustH = snap(Math.min(dustH, params.L / 2));

    // Grid baselines làm fallback
    const gridFallback = () => {
        const r0 = calcGridNone(dieW, dieH, gap, areaW, areaH, ox, oy);
        const r90 = calcGrid90(dieW, dieH, gap, areaW, areaH, ox, oy);
        return r0.positions.length >= r90.positions.length ? r0 : r90;
    };

    // Bất biến: smart KHÔNG ĐƯỢC kém grid. Nếu grid xếp được nhiều khuôn hơn
    // interlock (với hình học cụ thể này), dùng grid. Hòa → ưu tiên interlock
    // (giữ nhãn chiến lược lồng để người dùng thấy đã thử lồng).
    const chooseBest = (interlock: LayoutResult): LayoutResult => {
        const grid = gridFallback();
        return interlock.positions.length >= grid.positions.length ? interlock : grid;
    };

    if (params.boxType === 'rte') {
        // RTE: luôn dùng interlock (không xoay, overlap closureH + tuckH)
        const interlock = calcRTEInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, closureH, tuckH, safeDustH, params.D);
        return chooseBest(interlock);
    }

    if (params.boxType === 'slb') {
        // SLB: luôn dùng 180° interlock (xoay đầu đuôi để lồng crash-lock)
        const lockTabH = params.lockTab ? (params.LTH || 0) : 0;
        const interlock = calcSLBInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, closureH, tuckH, safeDustH, params.D, lockTabH, params.L, params.W, params.G);
        return chooseBest(interlock);
    }

    if (params.boxType === 'cup_sleeve') {
        // Cup Sleeve: lồng quạt 180° xen kẽ cột
        const interlock = calcCupSleeveInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, params);
        return chooseBest(interlock);
    }

    if (params.boxType === 'pizza') {
        // Pizza: lồng dọc — tai bụi front lồng vào nắp phụ/fan tab
        const interlock = calcPizzaInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, params.D);
        return chooseBest(interlock);
    }

    if (params.boxType === 'envelope') {
        // Envelope: lồng bì thư (ngang = cột, dọc = 3 hàng)
        const interlock = calcEnvelopeInterlock(dieW, dieH, gap, areaW, areaH, ox, oy, params);
        return chooseBest(interlock);
    }

    // Gable & Paper Bag: chỉ grid — không lồng được
    return gridFallback();
}

// ── Entry point ─────────────────────────────────────────

export function calculateNesting(
    bbox: BBox,
    config: NestingConfig,
    params?: BoxParams,
): NestingResult {
    const { sheet, margin, gripperMargin, dieGap, rotation, sheetOrientation, nestingMode, gutter } = config;
    const gap = nestingMode === 'smart' ? dieGap : (gutter || dieGap);

    let sheetW = sheet.width;
    let sheetH = sheet.height;
    if (sheetOrientation === 'portrait' && sheetW > sheetH) {
        [sheetW, sheetH] = [sheetH, sheetW];
    } else if (sheetOrientation === 'landscape' && sheetH > sheetW) {
        [sheetW, sheetH] = [sheetH, sheetW];
    }

    const dieW = bbox.width;
    const dieH = bbox.height;

    const calcForSheet = (sw: number, sh: number) => {
        const { areaW, areaH, offsetX, offsetY } = calcPrintableArea(sw, sh, margin, gripperMargin);

        let best: LayoutResult;

        if (nestingMode === 'smart' && params) {
            best = calcSmart(dieW, dieH, gap, areaW, areaH, offsetX, offsetY, params);
        } else {
            if (rotation === 'none') {
                best = calcGridNone(dieW, dieH, gap, areaW, areaH, offsetX, offsetY);
            } else if (rotation === '90') {
                best = calcGrid90(dieW, dieH, gap, areaW, areaH, offsetX, offsetY);
            } else {
                // auto: so sánh 0° vs 90°
                const r0 = calcGridNone(dieW, dieH, gap, areaW, areaH, offsetX, offsetY);
                const r90 = calcGrid90(dieW, dieH, gap, areaW, areaH, offsetX, offsetY);
                best = r0.positions.length >= r90.positions.length ? r0 : r90;
            }
        }

        return { ...best, sheetW: sw, sheetH: sh, areaW, areaH };
    };

    let result;
    if (sheetOrientation === 'auto') {
        const portrait = calcForSheet(
            Math.min(sheet.width, sheet.height),
            Math.max(sheet.width, sheet.height)
        );
        const landscape = calcForSheet(
            Math.max(sheet.width, sheet.height),
            Math.min(sheet.width, sheet.height)
        );
        result = portrait.positions.length >= landscape.positions.length ? portrait : landscape;
    } else {
        result = calcForSheet(sheetW, sheetH);
    }

    const count = result.positions.length;
    const dieArea = dieW * dieH;
    const sheetArea = result.areaW * result.areaH;
    const utilization = sheetArea > 0 ? Math.round((count * dieArea / sheetArea) * 1000) / 10 : 0;

    // ── Căn giữa layout trong vùng in ──
    if (count > 0 && result.positions.length > 0) {
        // Tìm bounding box thực tế của layout
        let layoutMinX = Infinity, layoutMinY = Infinity;
        let layoutMaxX = -Infinity, layoutMaxY = -Infinity;
        for (const pos of result.positions) {
            const rot = pos.rotation;
            const pw = (rot === 90 || rot === 270) ? dieH : dieW;
            const ph = (rot === 90 || rot === 270) ? dieW : dieH;
            layoutMinX = Math.min(layoutMinX, pos.x);
            layoutMinY = Math.min(layoutMinY, pos.y);
            layoutMaxX = Math.max(layoutMaxX, pos.x + pw);
            layoutMaxY = Math.max(layoutMaxY, pos.y + ph);
        }

        const { areaW, areaH } = result;
        const printableLeft = margin.left;
        const printableTop = margin.top;

        const layoutW = layoutMaxX - layoutMinX;
        const layoutH = layoutMaxY - layoutMinY;
        const centerDx = printableLeft + (areaW - layoutW) / 2 - layoutMinX;
        const centerDy = printableTop + (areaH - layoutH) / 2 - layoutMinY;

        // Dịch tất cả positions
        for (const pos of result.positions) {
            pos.x += centerDx;
            pos.y += centerDy;
        }
    }

    return {
        positions: result.positions,
        countPerSheet: count,
        rows: result.rows,
        cols: result.cols,
        utilization,
        usableArea: { width: result.areaW, height: result.areaH },
        actualSheet: { width: result.sheetW, height: result.sheetH },
        cellSize: { width: dieW + gap, height: dieH + gap },
        label: result.label,
        superTile: result.superTile || null,
    };
}
