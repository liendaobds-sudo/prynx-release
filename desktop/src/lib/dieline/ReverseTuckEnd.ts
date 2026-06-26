// ============================================================
// ECMA A20.20 — Reverse Tuck End Box (Hộp nắp gài so le)
// Loại hộp dược phẩm, mỹ phẩm phổ biến nhất thế giới.
//
// Thuật toán: Mọi tọa độ được nội suy từ biến số (L, W, D, T, C, G, TH).
// KHÔNG sử dụng hardcode hay scale.
// ============================================================

import {
    BoxParams,
    DielineModel,
    Panel,
    PathSegment,
    Point2D,
} from './types';

import {
    pt,
    line,
    polyline,
    arc,
    snap,
    computeBoundingBox,
    bezierSegment,
    filletBezier,
} from './utils';

import { buildDustFlap, buildTuckFlap } from './sharedHelpers';
import { GLUE_TAPER_RATIO, SLIT_OFFSET_MM, SLIT_DEPTH_MM, SLIT_FILLET_R, KAPPA } from './constants';

/**
 * Sinh bản vẽ khuôn bế Reverse Tuck End từ thông số đầu vào.
 *
 * Layout trải phẳng (nhìn từ trên):
 *
 *                    [Tuck Top]
 *                  [Closure Top]
 *   [DustFL-T]    [DustFR-T]
 *  ┌──────┬────────┬──────┬────────┐
 *  │ Glue │  Left  │Front │ Right  │  Back  │
 *  │ Flap │  (W)   │ (L)  │  (W)   │  (L)   │
 *  └──────┴────────┴──────┴────────┘
 *   [DustFL-B]    [DustFR-B]
 *                  [Closure Bot]
 *                    [Tuck Bot]
 *
 * Gốc tọa độ (0,0) = góc dưới-trái của Glue Flap.
 */
export function generateReverseTuckEnd(params: BoxParams): DielineModel {
    const { L, W, D, T, C, G, TH, glueSide, panelOrder } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // A. Tọa độ X các cột (X-axis positions)
    //    panelOrder='WLWL': Glue | W(Hông) | L(Mặt) | W(Hông) | L(Lưng)
    //    panelOrder='LWLW': Glue | L(Mặt) | W(Hông) | L(Lưng) | W(Hông)
    // ============================================================
    const pw = panelOrder === 'LWLW' ? [L, W, L, W] : [W, L, W, L];
    const glueOffset = glueSide === 'left' ? G : 0;
    const x1 = snap(glueOffset);
    const x2 = snap(glueOffset + pw[0]);
    const x3 = snap(glueOffset + pw[0] + pw[1]);
    const x4 = snap(glueOffset + pw[0] + pw[1] + pw[2]);
    const x5 = snap(glueOffset + pw[0] + pw[1] + pw[2] + pw[3]);
    // Glue Flap positions
    const xGlueInner = glueSide === 'left' ? x1 : x5;
    const xGlueOuter = glueSide === 'left' ? 0 : snap(x5 + G);

    // Semantic panel edges — map vai trò → tọa độ x
    // Front (L wide): nắp trên gắn ở đây
    // Back (L wide):  nắp dưới gắn ở đây
    // SideA, SideB (W wide): tai bụi gắn ở đây
    const isFrontFirst = panelOrder === 'LWLW';
    const [xFrontL, xFrontR] = isFrontFirst ? [x1, x2] : [x2, x3];
    const [xBackL, xBackR] = isFrontFirst ? [x3, x4] : [x4, x5];
    const [xSideAL, xSideAR] = isFrontFirst ? [x2, x3] : [x1, x2];
    const [xSideBL, xSideBR] = isFrontFirst ? [x4, x5] : [x3, x4];

    // Tên panel theo vị trí layout (cho body panel names & 3D parent chain)
    const pn = isFrontFirst
        ? ['front', 'right', 'back', 'left']
        : ['left', 'front', 'right', 'back'];

    // Tọa độ Y thân hộp
    const yBot = 0;
    const yTop = snap(D);

    // --- Closure-related Y offsets, theo vai trò panel ---
    // Front: nắp trên gập tại yTop+T → top CREASE, bottom CUT (không có nắp dưới)
    // Back:  nắp dưới gập tại yBot-T → bottom CREASE, top CUT (không có nắp trên)
    // Side:  dust flap → top CREASE, bottom CREASE
    const yTopFront = snap(yTop + T);
    const yBotBack = snap(yBot - T);
    const colTopY = pn.map(r => r === 'front' ? yTopFront : yTop);
    const colBotY = pn.map(r => r === 'back' ? yBotBack : yBot);
    const colTopTag: Array<'CUT' | 'CREASE'> = pn.map(r => r === 'back' ? 'CUT' : 'CREASE');
    const colBotTag: Array<'CUT' | 'CREASE'> = pn.map(r => r === 'front' ? 'CUT' : 'CREASE');

    // Vertical edge Y extents (mỗi cạnh dọc nối 2 panel kề nhau, phải khớp cả 2)
    const x2YTop = snap(Math.max(colTopY[0], colTopY[1]));
    const x2YBot = snap(Math.min(colBotY[0], colBotY[1]));
    const x3YTop = snap(Math.max(colTopY[1], colTopY[2]));
    const x3YBot = snap(Math.min(colBotY[1], colBotY[2]));
    const x4YTop = snap(Math.max(colTopY[2], colTopY[3]));
    const x4YBot = snap(Math.min(colBotY[2], colBotY[3]));

    // ============================================================
    // B. THÂN HỘP (Body Strip) - 5 mảng dọc theo trục X
    // ============================================================

    // --- B1. Glue Flap (Mép dán keo) ---
    // Vát góc trên & dưới 45° để keo không tràn
    const glueVat = snap(G * GLUE_TAPER_RATIO); // Chiều vát = 60% chiều rộng glue flap
    const gluePaths: PathSegment[] = glueSide === 'left' ? [
        // LEFT: Glue ở bên trái, vát hướng ra trái
        line(pt(xGlueOuter, yBot + glueVat), pt(xGlueInner, yBot), 'CUT'),
        line(pt(xGlueInner, yBot), pt(xGlueInner, yTop), 'CREASE'),
        line(pt(xGlueInner, yTop), pt(xGlueOuter, yTop - glueVat), 'CUT'),
        line(pt(xGlueOuter, yTop - glueVat), pt(xGlueOuter, yBot + glueVat), 'CUT'),
    ] : [
        // RIGHT: Glue ở bên phải, vát hướng ra phải
        line(pt(xGlueInner, yBot), pt(xGlueOuter, yBot + glueVat), 'CUT'),
        line(pt(xGlueOuter, yBot + glueVat), pt(xGlueOuter, yTop - glueVat), 'CUT'),
        line(pt(xGlueOuter, yTop - glueVat), pt(xGlueInner, yTop), 'CUT'),
        line(pt(xGlueInner, yTop), pt(xGlueInner, yBot), 'CREASE'),
    ];
    allPaths.push(...gluePaths);
    panels.push({
        name: 'glue_flap',
        label: 'Mép dán keo',
        paths: gluePaths,
        outline: glueSide === 'left' ? [
            pt(xGlueOuter, yBot + glueVat), pt(xGlueInner, yBot), pt(xGlueInner, yTop), pt(xGlueOuter, yTop - glueVat)
        ] : [
            pt(xGlueInner, yBot), pt(xGlueOuter, yBot + glueVat), pt(xGlueOuter, yTop - glueVat), pt(xGlueInner, yTop)
        ],
        parent: glueSide === 'left' ? pn[0] : pn[3],
        pivotEdge: [pt(xGlueInner, yBot), pt(xGlueInner, yTop)],
        foldAngle: glueSide === 'left' ? 92 : -92,
        foldDirection: -1,
    });

    // --- B2. Column 0 (pn[0]) ---
    const leftPaths: PathSegment[] = [
        line(pt(x1, colBotY[0]), pt(x2, colBotY[0]), colBotTag[0]),
        line(pt(x2, x2YBot), pt(x2, x2YTop), 'CREASE'),
        line(pt(x2, colTopY[0]), pt(x1, colTopY[0]), colTopTag[0]),
    ];
    if (glueSide === 'right') {
        leftPaths.push(line(pt(x1, colTopY[0]), pt(x1, colBotY[0]), 'CUT'));
    }
    allPaths.push(...leftPaths);
    panels.push({
        name: pn[0],
        label: pn[0] === 'left' ? 'Hông trái' : 'Mặt trước',
        paths: leftPaths,
        outline: [pt(x1, colBotY[0]), pt(x2, colBotY[0]), pt(x2, x2YTop), pt(x1, colTopY[0])],
        parent: pn[1],
        pivotEdge: [pt(x2, yBot), pt(x2, yTop)],
        foldAngle: 90,
        foldDirection: -1,
    });

    // --- B3. Column 1 (pn[1]) — ROOT panel ---
    const frontPaths: PathSegment[] = [
        line(pt(x2, colBotY[1]), pt(x3, colBotY[1]), colBotTag[1]),
        line(pt(x3, x3YBot), pt(x3, x3YTop), 'CREASE'),
        line(pt(x2, colTopY[1]), pt(x3, colTopY[1]), colTopTag[1]),
    ];
    allPaths.push(...frontPaths);
    panels.push({
        name: pn[1],
        label: pn[1] === 'front' ? 'Mặt trước' : 'Hông phải',
        paths: frontPaths,
        outline: [pt(x2, colBotY[1]), pt(x3, colBotY[1]), pt(x3, x3YTop), pt(x2, colTopY[1])],
        parent: null, // ROOT
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: -1,
    });

    // --- B4. Column 2 (pn[2]) ---
    const rightPaths: PathSegment[] = [
        line(pt(x3, colBotY[2]), pt(x4, colBotY[2]), colBotTag[2]),
        line(pt(x4, x4YBot), pt(x4, x4YTop), 'CREASE'),
        line(pt(x4, colTopY[2]), pt(x3, colTopY[2]), colTopTag[2]),
    ];
    allPaths.push(...rightPaths);
    panels.push({
        name: pn[2],
        label: pn[2] === 'right' ? 'Hông phải' : 'Mặt sau',
        paths: rightPaths,
        outline: [pt(x3, colBotY[2]), pt(x4, colBotY[2]), pt(x4, x4YTop), pt(x3, colTopY[2])],
        parent: pn[1],
        pivotEdge: [pt(x3, yBot), pt(x3, yTop)],
        foldAngle: -90,
        foldDirection: -1,
    });

    // --- B5. Column 3 (pn[3]) ---
    const backPaths: PathSegment[] = [
        line(pt(x4, colBotY[3]), pt(x5, colBotY[3]), colBotTag[3]),
        line(pt(x5, yBot), pt(x5, yTop), glueSide === 'left' ? 'CUT' : 'CREASE'),
        line(pt(x5, colTopY[3]), pt(x4, colTopY[3]), colTopTag[3]),
    ];
    allPaths.push(...backPaths);
    panels.push({
        name: pn[3],
        label: pn[3] === 'back' ? 'Mặt sau' : 'Hông trái',
        paths: backPaths,
        outline: [pt(x4, colBotY[3]), pt(x5, colBotY[3]), pt(x5, yTop), pt(x4, colTopY[3])],
        parent: pn[2],
        pivotEdge: [pt(x4, yBot), pt(x4, yTop)],
        foldAngle: -90,
        foldDirection: -1,
    });

    // ============================================================
    // C. TAI CHỐNG BỤI (Dust Flaps) — Gắn ở 2 đầu trên/dưới hông
    //    Chiều cao = L/2 - 1mm (tránh 2 tai đè nhau)
    //    Hình dạng: Cong mượt (tham khảo Pacdora), KHÔNG phải hình thang
    // ============================================================
    const autoDustH = snap(Math.min(L / 2 - 1, W - T)); // Công thức tự động
    const dustH = params.DFH > 0 ? snap(Math.min(params.DFH, L / 2 - 1)) : autoDustH; // DFH=0 → tự động
    const h = snap(T / 2);  // Mỗi bên giảm T/2 cho các flap

    // mirrorX: phụ thuộc vào vai trò vật lý (left/right) của side panel, không phải vị trí layout
    // SideA là 'left' khi WLWL, 'right' khi LWLW
    const sideAIsLeft = !isFrontFirst;
    const sideBIsLeft = isFrontFirst;

    // --- C1. Dust Flap trên-trái (trên SideA Panel, W wide) ---
    const dustTL = buildDustFlap(xSideAL, xSideAR, yTop, dustH, 1, sideAIsLeft);
    // CREASE tại yTop đã được body column vẽ → không push thêm
    allPaths.push(...dustTL);
    panels.push({
        name: 'dust_top_left',
        label: 'Tai bụi trên-trái',
        paths: dustTL,
        parent: isFrontFirst ? 'right' : 'left',
        pivotEdge: [pt(xSideAL, yTop), pt(xSideAR, yTop)],
        foldAngle: 90,
        foldDirection: -1,
        foldPhase: [0.1, 0.4],
    });

    // --- C2. Dust Flap trên-phải (trên SideB Panel, W wide) ---
    const dustTR = buildDustFlap(xSideBL, xSideBR, yTop, dustH, 1, sideBIsLeft);
    // CREASE tại yTop đã được body column vẽ → không push thêm
    allPaths.push(...dustTR);
    panels.push({
        name: 'dust_top_right',
        label: 'Tai bụi trên-phải',
        paths: dustTR,
        parent: isFrontFirst ? 'left' : 'right',
        pivotEdge: [pt(xSideBL, yTop), pt(xSideBR, yTop)],
        foldAngle: 90,
        foldDirection: -1,
        foldPhase: [0.1, 0.4],
    });

    // --- C3. Dust Flap dưới-trái (dưới SideA Panel, W wide) ---
    const dustBL = buildDustFlap(xSideAL, xSideAR, yBot, dustH, -1, !sideAIsLeft);
    // CREASE tại yBot đã được body column vẽ → không push thêm
    allPaths.push(...dustBL);
    panels.push({
        name: 'dust_bot_left',
        label: 'Tai bụi dưới-trái',
        paths: dustBL,
        parent: isFrontFirst ? 'right' : 'left',
        pivotEdge: [pt(xSideAL, yBot), pt(xSideAR, yBot)],
        foldAngle: -90,
        foldDirection: -1,
        foldPhase: [0.1, 0.4],
    });

    // --- C4. Dust Flap dưới-phải (dưới SideB Panel, W wide) ---
    const dustBR = buildDustFlap(xSideBL, xSideBR, yBot, dustH, -1, !sideBIsLeft);
    // CREASE tại yBot đã được body column vẽ → không push thêm
    allPaths.push(...dustBR);
    panels.push({
        name: 'dust_bot_right',
        label: 'Tai bụi dưới-phải',
        paths: dustBR,
        parent: isFrontFirst ? 'left' : 'right',
        pivotEdge: [pt(xSideBL, yBot), pt(xSideBR, yBot)],
        foldAngle: -90,
        foldDirection: -1,
        foldPhase: [0.1, 0.4],
    });

    // ============================================================
    // D. NẮP ĐẬY (Closure Panels) — Gắn đỉnh Front & đáy Back
    //    Chiều cao = W - T (bù trừ fold loss)
    //    Rãnh gài (slit lock) ở 2 bên tay gấp
    // ============================================================
    const closureH = snap(W - T);

    // Kích thước rãnh gài (tham khảo script "6. Nô lệ hộp mềm.jsx")
    const sx1 = snap(SLIT_OFFSET_MM); // Vị trí rãnh gài từ mép
    const slitDropT = snap(SLIT_DEPTH_MM); // Chiều sâu khe gài
    const reliefR = snap(T); // Bán kính bo giảm lực tại góc nhọn

    // --- D1. Closure Panel trên (trên Front Panel) ---
    const closureTopY = snap(yTop + T);
    const tuckTopCreaseY = snap(yTop + W - T); // Span = W - T

    // Cạnh trái/phải lùi vào h = T/2 tránh giao nhau với dust flap
    const xCTL = snap(xFrontL + h);  // Closure Top Left edge
    const xCTR = snap(xFrontR - h);  // Closure Top Right edge

    const slitR = snap(SLIT_FILLET_R); // Bo góc nhẹ tại khe gài
    const slitK = snap(slitR * KAPPA); // kappa cho bezier

    // CREASE tại closureTopY trùng với body front top edge → chỉ giữ cho panel 3D
    const closureTopCrease = line(pt(xCTL, closureTopY), pt(xCTR, closureTopY), 'CREASE');
    const closureTopPaths: PathSegment[] = [
        // Cạnh TRÁI: offset T/2
        line(pt(xCTL, yTop), pt(xCTL, tuckTopCreaseY), 'CUT'),
        // Rãnh gài BÊN TRÁI — bo góc tại chỗ ngoặt
        line(pt(xCTL, tuckTopCreaseY), pt(snap(xFrontL + sx1 - slitR), tuckTopCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xFrontL + sx1 - slitR), tuckTopCreaseY),
            pt(snap(xFrontL + sx1 - slitR + slitK), tuckTopCreaseY),
            pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitK)),
            pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitR)),
            'CUT'),
        line(pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitR)), pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitDropT)), 'CUT'),
        // Đường nhấn tai đút — nằm giữa khe gài
        line(pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitDropT / 2)), pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitDropT / 2)), 'CREASE'),
        // Rãnh gài BÊN PHẢI — bo góc tại chỗ ngoặt
        line(pt(xCTR, tuckTopCreaseY), pt(snap(xFrontR - sx1 + slitR), tuckTopCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xFrontR - sx1 + slitR), tuckTopCreaseY),
            pt(snap(xFrontR - sx1 + slitR - slitK), tuckTopCreaseY),
            pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitK)),
            pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitR)),
            'CUT'),
        line(pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitR)), pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitDropT)), 'CUT'),
        // Cạnh PHẢI: offset T/2
        line(pt(xCTR, tuckTopCreaseY), pt(xCTR, yTop), 'CUT'),
    ];
    allPaths.push(...closureTopPaths);
    panels.push({
        name: 'closure_top',
        label: 'Nắp đậy trên',
        paths: [closureTopCrease, ...closureTopPaths],
        outline: [pt(xCTL, yTop), pt(xCTR, yTop), pt(xCTR, tuckTopCreaseY), pt(xCTL, tuckTopCreaseY)],
        parent: 'front',
        pivotEdge: [pt(xCTL, closureTopY), pt(xCTR, closureTopY)],
        foldAngle: 90,
        foldDirection: -1,
        foldPhase: [0.6, 1.0],
    });

    // --- Nối liền dust flap ↔ closure trên + bo nhọn ---
    const lineIntersect = (a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null => {
        const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
        const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) < 1e-10) return null;
        const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
        return pt(snap(a1.x + t * dx1), snap(a1.y + t * dy1));
    };

    // Bo nhọn: bezier với control points kéo về góc → đỉnh nhọn hướng thân hộp
    const pointedFillet = (
        corner: Point2D, prev: Point2D, next: Point2D, d: number
    ): PathSegment => {
        const dx1 = prev.x - corner.x, dy1 = prev.y - corner.y;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        const dx2 = next.x - corner.x, dy2 = next.y - corner.y;
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (len1 < 0.01 || len2 < 0.01) return line(prev, next, 'CUT');
        const dClamped = Math.min(d, len1 / 2, len2 / 2);
        const t1 = pt(snap(corner.x + (dx1 / len1) * dClamped), snap(corner.y + (dy1 / len1) * dClamped));
        const t2 = pt(snap(corner.x + (dx2 / len2) * dClamped), snap(corner.y + (dy2 / len2) * dClamped));
        const pull = 0.2;
        const cp1 = pt(snap(t1.x + (corner.x - t1.x) * pull), snap(t1.y + (corner.y - t1.y) * pull));
        const cp2 = pt(snap(t2.x + (corner.x - t2.x) * pull), snap(t2.y + (corner.y - t2.y) * pull));
        return bezierSegment(t1, cp1, cp2, t2, 'CUT');
    };

    const filletD = snap(Math.min(h, 2));

    // --- Nối closure ↔ dust flap gần nhất (tự động cho WLWL / LWLW) ---
    const connectCorner = (
        closureEdge: PathSegment, isLeftEdge: boolean,
        dustA: PathSegment[], dustB: PathSegment[],
        bridgeP1: Point2D, bridgeP2: Point2D
    ) => {
        const cPt = isLeftEdge ? closureEdge.points[0] : closureEdge.points[closureEdge.points.length - 1];
        const candidates = [
            { seg: dustA[dustA.length - 1], end: true, arr: dustA },
            { seg: dustB[dustB.length - 1], end: true, arr: dustB },
            { seg: dustA[0], end: false, arr: dustA },
            { seg: dustB[0], end: false, arr: dustB },
        ];
        for (const c of candidates) {
            const dPt = c.end ? c.seg.points[c.seg.points.length - 1] : c.seg.points[0];
            const gap = Math.abs(dPt.x - cPt.x) + Math.abs(dPt.y - cPt.y);
            if (gap < T * 3) {
                const meet = lineIntersect(c.seg.points[0], c.seg.points[1], closureEdge.points[0], closureEdge.points[1]);
                if (meet) {
                    if (c.end) { c.seg.points[c.seg.points.length - 1] = meet; }
                    else { c.seg.points[0] = meet; }
                    if (isLeftEdge) { closureEdge.points[0] = meet; }
                    else { closureEdge.points[closureEdge.points.length - 1] = meet; }
                    const prev = c.end ? c.seg.points[0] : c.seg.points[1];
                    const next = isLeftEdge ? closureEdge.points[1] : closureEdge.points[closureEdge.points.length - 2];
                    const fillet = pointedFillet(meet, prev, next, filletD);
                    if (c.end) { c.seg.points[c.seg.points.length - 1] = fillet.points[0]; }
                    else { c.seg.points[0] = fillet.points[0]; }
                    if (isLeftEdge) { closureEdge.points[0] = fillet.points[fillet.points.length - 1]; }
                    else { closureEdge.points[closureEdge.points.length - 1] = fillet.points[fillet.points.length - 1]; }
                    // Splice fillet vào dust flap array (liền mạch thực sự)
                    const dustIdx = c.arr.indexOf(c.seg);
                    if (c.end) { c.arr.splice(dustIdx + 1, 0, fillet); }
                    else { c.arr.splice(dustIdx, 0, fillet); }
                    allPaths.push(fillet);
                    return;
                }
            }
        }
        allPaths.push(line(bridgeP1, bridgeP2, 'CUT'));
    };

    // Closure top corners
    connectCorner(closureTopPaths[0], true, dustTL, dustTR, pt(xFrontL, yTop), pt(xCTL, yTop));
    connectCorner(closureTopPaths[closureTopPaths.length - 1], false, dustTL, dustTR, pt(xCTR, yTop), pt(xFrontR, yTop));

    // --- D2. Closure Panel dưới (dưới Back Panel) ---
    const closureBotY = snap(yBot - T);
    const tuckBotCreaseY = snap(yBot - W + T); // Span = W - T

    const xCBL = snap(xBackL + h);  // Closure Bot Left edge
    const xCBR = snap(xBackR - h);  // Closure Bot Right edge

    // CREASE tại closureBotY trùng với body back bottom edge → chỉ giữ cho panel 3D
    const closureBotCrease = line(pt(xCBL, closureBotY), pt(xCBR, closureBotY), 'CREASE');
    const closureBotPaths: PathSegment[] = [
        // Cạnh TRÁI: offset T/2
        line(pt(xCBL, yBot), pt(xCBL, tuckBotCreaseY), 'CUT'),
        // Rãnh gài BÊN TRÁI — bo góc tại chỗ ngoặt
        line(pt(xCBL, tuckBotCreaseY), pt(snap(xBackL + sx1 - slitR), tuckBotCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xBackL + sx1 - slitR), tuckBotCreaseY),
            pt(snap(xBackL + sx1 - slitR + slitK), tuckBotCreaseY),
            pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitK)),
            pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitR)),
            'CUT'),
        line(pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitR)), pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitDropT)), 'CUT'),
        // Đường nhấn tai đút — nằm giữa khe gài
        line(pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitDropT / 2)), pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitDropT / 2)), 'CREASE'),
        // Rãnh gài BÊN PHẢI — bo góc tại chỗ ngoặt
        line(pt(xCBR, tuckBotCreaseY), pt(snap(xBackR - sx1 + slitR), tuckBotCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xBackR - sx1 + slitR), tuckBotCreaseY),
            pt(snap(xBackR - sx1 + slitR - slitK), tuckBotCreaseY),
            pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitK)),
            pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitR)),
            'CUT'),
        line(pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitR)), pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitDropT)), 'CUT'),
        // Cạnh PHẢI: offset T/2
        line(pt(xCBR, tuckBotCreaseY), pt(xCBR, yBot), 'CUT'),
    ];
    allPaths.push(...closureBotPaths);
    panels.push({
        name: 'closure_bot',
        label: 'Nắp đậy dưới',
        paths: [closureBotCrease, ...closureBotPaths],
        outline: [pt(xCBL, yBot), pt(xCBR, yBot), pt(xCBR, tuckBotCreaseY), pt(xCBL, tuckBotCreaseY)],
        parent: 'back',
        pivotEdge: [pt(xCBL, closureBotY), pt(xCBR, closureBotY)],
        foldAngle: -90,
        foldDirection: -1,
        foldPhase: [0.6, 1.0],
    });

    // Closure bottom corners
    connectCorner(closureBotPaths[0], true, dustBL, dustBR, pt(xBackL, yBot), pt(xCBL, yBot));
    connectCorner(closureBotPaths[closureBotPaths.length - 1], false, dustBL, dustBR, pt(xCBR, yBot), pt(xBackR, yBot));

    // ============================================================
    // E. LƯỠI ĐÚT / TAI GÀI (Tuck-in Flaps)
    //    CÔNG THỨC SỐNG CÒN:
    //    Chiều rộng = L - 2*T - C (bù trừ 2 bên hông + dung sai)
    //    Chiều cao = TH
    //    Bo tròn 2 góc trên, xẻ rãnh ngàm 2 bên
    // ============================================================
    const tuckW = snap(L - 2 * T - C); // Chiều rộng lưỡi đút
    const tuckH = snap(TH);
    const tuckInset = snap((L - tuckW) / 2); // Khoảng thụt vào mỗi bên
    const tuckR = snap(Math.min(3, tuckW * 0.05)); // Bo tròn góc (max 3mm)


    // --- E1. Tuck Flap trên (nối tiếp Closure trên) ---
    // Đáy lưỡi đút phải TRÙNG cạnh trên của nắp (tuckTopCreaseY), không phải
    // closureTopY+closureH (lệch T → lưỡi đút nhảy lên, hở khỏi nắp).
    const tuckTopBase = tuckTopCreaseY;
    const tuckTopPaths: PathSegment[] = buildTuckFlap(
        xFrontL + tuckInset,    // xLeft
        tuckTopBase,            // yBase
        tuckW,                  // width
        tuckH,                  // height
        tuckR,                  // cornerRadius
        1                       // direction: 1 = lên trên
    );
    allPaths.push(...tuckTopPaths);
    panels.push({
        name: 'tuck_top',
        label: 'Lưỡi gài trên',
        paths: tuckTopPaths,
        parent: 'closure_top',
        pivotEdge: [pt(xFrontL, tuckTopBase), pt(xFrontR, tuckTopBase)],
        foldAngle: 92,
        foldDirection: -1,
        foldPhase: [0.3, 0.6],
    });

    // --- E2. Tuck Flap dưới (nối tiếp Closure dưới) — NGƯỢC CHIỀU ---
    // Đáy lưỡi đút trùng cạnh dưới của nắp (tuckBotCreaseY) — không hở.
    const tuckBotBase = tuckBotCreaseY;
    const tuckBotPaths: PathSegment[] = buildTuckFlap(
        xBackL + tuckInset,     // xLeft
        tuckBotBase,            // yBase
        tuckW,                  // width
        tuckH,                  // height
        tuckR,
        -1                      // direction: -1 = xuống dưới
    );
    allPaths.push(...tuckBotPaths);
    panels.push({
        name: 'tuck_bot',
        label: 'Lưỡi gài dưới',
        paths: tuckBotPaths,
        parent: 'closure_bot',
        pivotEdge: [pt(xBackL, tuckBotBase), pt(xBackR, tuckBotBase)],
        foldAngle: -92,
        foldDirection: -1,
        foldPhase: [0.3, 0.6],
    });

    // ============================================================
    // F. Tính Bounding Box & Trả về mô hình
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Reverse Tuck End',
        standardCode: 'ECMA-A20.20',
        description: 'Hộp nắp gài 2 đầu ngược chiều — Dược phẩm, Mỹ phẩm',
        panels,
        allPaths,
        boundingBox: bb,
        params,
    };
}


