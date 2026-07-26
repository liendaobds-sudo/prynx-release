// ============================================================
// Auto-Bottom Box — Hộp đáy dán tự động (Crash-Lock đã dán keo)
//
// THÂN + NẮP giống hệt Snap-Lock Bottom (hộp đáy gài):
//   nắp đậy có khe gài + lưỡi đút + 2 tai bụi + lưỡi khoá nắp (tuỳ chọn).
// KHÁC BIỆT DUY NHẤT là PHẦN ĐÁY:
//   - Đáy gài (SLB): 4 mảnh khoá cơ khí vào nhau, người đóng hộp phải gài tay.
//   - Đáy dán (AB):  4 mảnh dán keo sẵn theo 2 cặp chéo nhau, mỗi cặp gập
//                    quanh một đường cấn chéo 45°. Hộp giao ở dạng bẹp và
//                    tự bung thành đáy kín khi dựng lên.
//
// Thuật toán: Mọi tọa độ nội suy từ biến số (L, W, D, T, C, G, TH, ABD).
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
    snap,
    computeBoundingBox,
    bezierSegment,
} from './utils';

import { buildDustFlap, buildTuckFlap } from './sharedHelpers';
import { GLUE_TAPER_RATIO, SLIT_OFFSET_MM, SLIT_DEPTH_MM, SLIT_FILLET_R, KAPPA } from './constants';
import {
    autoBottomDims,
    buildDeepBottomFlap,
    buildWingBottomFlap,
    outlineFromCutChain,
    buildDeepBottomAnnotations,
    buildWingBottomAnnotations,
    computeDeepBottomKeyPoints,
    type DeepBottomKeyPoints,
} from './autoBottomHelpers';

/**
 * Sinh bản vẽ khuôn bế Hộp Đáy Dán từ thông số đầu vào.
 *
 * Layout trải phẳng (nhìn từ trên):
 *
 *                    [Tuck Top]
 *                  [Closure Top]
 *   [DustFL-T]    [DustFR-T]
 *
 *   Glue   Front  Right   Back    Left
 *   Flap    (L)    (W)     (L)     (W)
 *
 *          [Chính] [Tai]  [Chính] [Tai]     ← đáy dán, cấn chéo 45° tại góc dán
 *
 * Gốc tọa độ (0,0) = góc dưới-trái của panel ngoài cùng bên trái.
 */
export function generateAutoBottomBox(params: BoxParams): DielineModel {
    const { L, W, D, T, C, G, TH, glueSide, panelOrder, LTW, LTH } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // A. Tọa độ X các cột (giống RTE / SLB)
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
    const xGlueInner = glueSide === 'left' ? x1 : x5;
    const xGlueOuter = glueSide === 'left' ? 0 : snap(x5 + G);

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

    // Front: nắp đậy trên (CREASE tại yTop+T); Back: cạnh tự do (CUT);
    // Side: tai bụi (CREASE). Đáy: TẤT CẢ đều CREASE (4 mảnh đáy dán).
    const yTopFront = snap(yTop + T);
    const colTopY = pn.map(r => r === 'front' ? yTopFront : yTop);
    const colTopTag: Array<'CUT' | 'CREASE'> = pn.map(r => r === 'back' ? 'CUT' : 'CREASE');

    const x2YTop = snap(Math.max(colTopY[0], colTopY[1]));
    const x3YTop = snap(Math.max(colTopY[1], colTopY[2]));
    const x4YTop = snap(Math.max(colTopY[2], colTopY[3]));

    // ============================================================
    // B. THÂN HỘP
    // ============================================================

    // --- B1. Glue Flap ---
    const glueVat = snap(G * GLUE_TAPER_RATIO);
    const gluePaths: PathSegment[] = glueSide === 'left' ? [
        line(pt(xGlueOuter, yBot + glueVat), pt(xGlueInner, yBot), 'CUT'),
        line(pt(xGlueInner, yBot), pt(xGlueInner, yTop), 'CREASE'),
        line(pt(xGlueInner, yTop), pt(xGlueOuter, yTop - glueVat), 'CUT'),
        line(pt(xGlueOuter, yTop - glueVat), pt(xGlueOuter, yBot + glueVat), 'CUT'),
    ] : [
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
        line(pt(x2, yBot), pt(x2, x2YTop), 'CREASE'),
        line(pt(x2, colTopY[0]), pt(x1, colTopY[0]), colTopTag[0]),
    ];
    if (glueSide === 'right') {
        leftPaths.push(line(pt(x1, colTopY[0]), pt(x1, yBot), 'CUT'));
    }
    allPaths.push(...leftPaths);

    // Đảm bảo 3D nhận diện đủ 4 cạnh
    const leftPaths3D = [...leftPaths,
        line(pt(x1, yBot), pt(x2, yBot), 'CREASE'),
        line(pt(x1, yBot), pt(x1, colTopY[0]), 'CREASE'),
    ];

    panels.push({
        name: pn[0],
        label: pn[0] === 'left' ? 'Hông trái' : 'Mặt trước',
        paths: leftPaths3D,
        outline: [pt(x1, yBot), pt(x2, yBot), pt(x2, x2YTop), pt(x1, colTopY[0])],
        parent: pn[1],
        pivotEdge: [pt(x2, yBot), pt(x2, yTop)],
        foldAngle: 90,
        foldDirection: -1,
    });

    // --- B3. Column 1 (pn[1]) — ROOT panel ---
    const frontPaths: PathSegment[] = [
        line(pt(x3, yBot), pt(x3, x3YTop), 'CREASE'),
        line(pt(x2, colTopY[1]), pt(x3, colTopY[1]), colTopTag[1]),
    ];
    allPaths.push(...frontPaths);

    const frontPaths3D = [...frontPaths,
        line(pt(x2, yBot), pt(x3, yBot), 'CREASE'),
        line(pt(x2, yBot), pt(x2, x2YTop), 'CREASE'),
    ];

    panels.push({
        name: pn[1],
        label: pn[1] === 'front' ? 'Mặt trước' : 'Hông phải',
        paths: frontPaths3D,
        outline: [pt(x2, yBot), pt(x3, yBot), pt(x3, x3YTop), pt(x2, colTopY[1])],
        parent: null, // ROOT
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: -1,
    });

    // --- B4. Column 2 (pn[2]) ---
    const rightPaths: PathSegment[] = [
        line(pt(x4, yBot), pt(x4, x4YTop), 'CREASE'),
    ];
    if (pn[2] === 'back' && params.lockTab) {
        const xMid2 = snap((x3 + x4) / 2);
        rightPaths.push(line(pt(x4, colTopY[2]), pt(snap(xMid2 + LTW / 2), colTopY[2]), 'CUT'));
        rightPaths.push(line(pt(snap(xMid2 - LTW / 2), colTopY[2]), pt(x3, colTopY[2]), 'CUT'));
    } else {
        rightPaths.push(line(pt(x4, colTopY[2]), pt(x3, colTopY[2]), colTopTag[2]));
    }
    allPaths.push(...rightPaths);

    const rightPaths3D = [...rightPaths,
        line(pt(x3, yBot), pt(x4, yBot), 'CREASE'),
        line(pt(x3, yBot), pt(x3, x3YTop), 'CREASE'),
    ];

    panels.push({
        name: pn[2],
        label: pn[2] === 'right' ? 'Hông phải' : 'Mặt sau',
        paths: rightPaths3D,
        outline: [pt(x3, yBot), pt(x4, yBot), pt(x4, x4YTop), pt(x3, colTopY[2])],
        parent: pn[1],
        pivotEdge: [pt(x3, yBot), pt(x3, yTop)],
        foldAngle: -90,
        foldDirection: -1,
    });

    // --- B5. Column 3 (pn[3]) ---
    const backPaths: PathSegment[] = [
        line(pt(x5, yBot), pt(x5, colTopY[3]), glueSide === 'left' ? 'CUT' : 'CREASE'),
    ];
    if (pn[3] === 'back' && params.lockTab) {
        const xBackMidTmp = snap((x4 + x5) / 2);
        const xLTLTmp = snap(xBackMidTmp - LTW / 2);
        const xLTRTmp = snap(xBackMidTmp + LTW / 2);
        backPaths.push(line(pt(x5, colTopY[3]), pt(xLTRTmp, colTopY[3]), 'CUT'));
        backPaths.push(line(pt(xLTLTmp, colTopY[3]), pt(x4, colTopY[3]), 'CUT'));
    } else {
        backPaths.push(line(pt(x5, colTopY[3]), pt(x4, colTopY[3]), colTopTag[3]));
    }
    allPaths.push(...backPaths);

    const backPaths3D = [...backPaths,
        line(pt(x4, yBot), pt(x5, yBot), 'CREASE'),
        line(pt(x4, yBot), pt(x4, x4YTop), 'CREASE'),
    ];

    panels.push({
        name: pn[3],
        label: pn[3] === 'back' ? 'Mặt sau' : 'Hông trái',
        paths: backPaths3D,
        outline: [pt(x4, yBot), pt(x5, yBot), pt(x5, colTopY[3]), pt(x4, x4YTop)],
        parent: pn[2],
        pivotEdge: [pt(x4, yBot), pt(x4, yTop)],
        foldAngle: -90,
        foldDirection: -1,
    });

    // --- Đường CREASE đáy liên tục (gộp 4 cột thành 1 đoạn) ---
    allPaths.push(line(pt(x1, yBot), pt(x5, yBot), 'CREASE'));

    // ============================================================
    // C. PHẦN TRÊN — giống SLB (Dust Flaps + Closure + Tuck + Lock Tab)
    // ============================================================
    const autoDustH = snap(Math.min(L / 2 - 1, W - T));
    const dustH = params.DFH > 0 ? snap(Math.min(params.DFH, L / 2 - 1)) : autoDustH;
    const h = snap(T / 2);  // Mỗi bên giảm T/2 cho các flap

    const sideAIsLeft = !isFrontFirst;
    const sideBIsLeft = isFrontFirst;

    // --- C1. Dust Flap trên-trái (trên SideA Panel, W wide) ---
    const dustTL = buildDustFlap(xSideAL, xSideAR, yTop, dustH, 1, sideAIsLeft);
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

    // --- C2. Dust Flap trên-phải ---
    const dustTR = buildDustFlap(xSideBL, xSideBR, yTop, dustH, 1, sideBIsLeft);
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

    // --- C3. Closure Panel trên ---
    const closureTopY = snap(yTop + T);
    const tuckTopCreaseY = snap(yTop + W - T); // Span = W - T

    const sx1 = snap(SLIT_OFFSET_MM);
    const slitDropT = snap(SLIT_DEPTH_MM);
    const slitR = snap(SLIT_FILLET_R);
    const slitK = snap(slitR * KAPPA);

    const xCL = snap(xFrontL + h);
    const xCR = snap(xFrontR - h);

    const closureTopCrease = line(pt(xCL, closureTopY), pt(xCR, closureTopY), 'CREASE');
    const closureTopPaths: PathSegment[] = [
        line(pt(xCL, yTop), pt(xCL, tuckTopCreaseY), 'CUT'),
        // Rãnh giữ BÊN TRÁI — bo góc tại chỗ ngoặt
        line(pt(xCL, tuckTopCreaseY), pt(snap(xFrontL + sx1 - slitR), tuckTopCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xFrontL + sx1 - slitR), tuckTopCreaseY),
            pt(snap(xFrontL + sx1 - slitR + slitK), tuckTopCreaseY),
            pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitK)),
            pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitR)),
            'CUT'),
        line(pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitR)), pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitDropT)), 'CUT'),
        // Đường nhấn tai túi — nằm giữa khe giữ
        line(pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitDropT / 2)), pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitDropT / 2)), 'CREASE'),
        // Rãnh giữ BÊN PHẢI — bo góc tại chỗ ngoặt
        line(pt(xCR, tuckTopCreaseY), pt(snap(xFrontR - sx1 + slitR), tuckTopCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xFrontR - sx1 + slitR), tuckTopCreaseY),
            pt(snap(xFrontR - sx1 + slitR - slitK), tuckTopCreaseY),
            pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitK)),
            pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitR)),
            'CUT'),
        line(pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitR)), pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitDropT)), 'CUT'),
        line(pt(xCR, tuckTopCreaseY), pt(xCR, yTop), 'CUT'),
    ];
    allPaths.push(...closureTopPaths);
    panels.push({
        name: 'closure_top',
        label: 'Nắp đậy trên',
        paths: [closureTopCrease, ...closureTopPaths],
        outline: [
            pt(xCL, closureTopY),
            pt(xCR, closureTopY),
            pt(xCR, tuckTopCreaseY),
            pt(xCL, tuckTopCreaseY)
        ],
        parent: 'front',
        pivotEdge: [pt(xCL, closureTopY), pt(xCR, closureTopY)],
        foldAngle: 90,
        foldDirection: -1,
        foldPhase: [0.6, 1.0],
    });

    // --- C3b–c. Nối liền dust flap ↔ closure tại giao điểm + bo nhọn ---
    const lineIntersect = (a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null => {
        const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
        const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) < 1e-10) return null;
        const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
        return pt(snap(a1.x + t * dx1), snap(a1.y + t * dy1));
    };

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

    const connectCorner = (
        closureEdge: PathSegment, isLeftEdge: boolean,
        dustA: PathSegment[], dustB: PathSegment[]
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
                    const dustIdx = c.arr.indexOf(c.seg);
                    if (c.end) { c.arr.splice(dustIdx + 1, 0, fillet); }
                    else { c.arr.splice(dustIdx, 0, fillet); }
                    allPaths.push(fillet);
                    return;
                }
            }
        }
        if (isLeftEdge) allPaths.push(line(pt(xFrontL, yTop), pt(xCL, yTop), 'CUT'));
        else allPaths.push(line(pt(xCR, yTop), pt(xFrontR, yTop), 'CUT'));
    };

    connectCorner(closureTopPaths[0], true, dustTL, dustTR);
    connectCorner(closureTopPaths[closureTopPaths.length - 1], false, dustTL, dustTR);

    // --- C4. Tuck Flap trên ---
    const tuckW = snap(L - 2 * T - C);
    const tuckH = snap(TH);
    const tuckInset = snap((L - tuckW) / 2);
    const tuckR = snap(Math.min(3, tuckW * 0.05));

    const tuckTopBase = tuckTopCreaseY;
    const tuckTopPaths: PathSegment[] = buildTuckFlap(
        xFrontL + tuckInset, tuckTopBase, tuckW, tuckH, tuckR, 1
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

    // --- C5. Locking Tab trên mặt sau (chỉ khi bật lockTab) ---
    if (params.lockTab) {
        const lockTabW = snap(LTW);
        const lockTabH = snap(LTH);
        const lockTabR = snap(Math.min(2, lockTabW * 0.15));
        const lockTabK = snap(lockTabR * KAPPA);
        const xBackMid = snap((xBackL + xBackR) / 2);
        const xLTL = snap(xBackMid - lockTabW / 2);
        const xLTR = snap(xBackMid + lockTabW / 2);
        const yLTTop = snap(yTop + lockTabH);

        const lockTabPaths: PathSegment[] = [
            line(pt(xLTL, yTop), pt(xLTR, yTop), 'CREASE'),
            line(pt(xLTL, yTop), pt(xLTL, snap(yLTTop - lockTabR)), 'CUT'),
            bezierSegment(
                pt(xLTL, snap(yLTTop - lockTabR)),
                pt(xLTL, snap(yLTTop - lockTabR + lockTabK)),
                pt(snap(xLTL + lockTabR - lockTabK), yLTTop),
                pt(snap(xLTL + lockTabR), yLTTop),
                'CUT'),
            line(pt(snap(xLTL + lockTabR), yLTTop), pt(snap(xLTR - lockTabR), yLTTop), 'CUT'),
            bezierSegment(
                pt(snap(xLTR - lockTabR), yLTTop),
                pt(snap(xLTR - lockTabR + lockTabK), yLTTop),
                pt(xLTR, snap(yLTTop - lockTabR + lockTabK)),
                pt(xLTR, snap(yLTTop - lockTabR)),
                'CUT'),
            line(pt(xLTR, snap(yLTTop - lockTabR)), pt(xLTR, yTop), 'CUT'),
            line(pt(xLTR, yTop), pt(xLTL, yTop), 'CREASE')
        ];
        allPaths.push(...lockTabPaths);
        panels.push({
            name: 'lock_tab',
            label: 'Lưỡi khóa nắp',
            paths: lockTabPaths,
            parent: 'back',
            pivotEdge: [pt(xLTL, yTop), pt(xLTR, yTop)],
            foldAngle: 90,
            foldDirection: -1,
            foldPhase: [0.3, 0.6],
        });

        // --- C6. Xẻ rãnh trên đường nhấn tai túi cho lưỡi khóa chèn vào ---
        const lockSlitW = snap(lockTabW + 1);
        const tuckCreaseY = snap(tuckTopCreaseY - slitDropT / 2);
        const lockSlitY = snap(tuckCreaseY + slitDropT - 1);
        const xFrontMid = snap((xFrontL + xFrontR) / 2);
        const xSlitL = snap(xFrontMid - lockSlitW / 2);
        const xSlitR = snap(xFrontMid + lockSlitW / 2);
        allPaths.push(line(pt(xSlitL, lockSlitY), pt(xSlitR, lockSlitY), 'CUT'));
        allPaths.push(line(pt(xSlitL, lockSlitY), pt(snap(xSlitL - 1), snap(lockSlitY - 2)), 'CUT'));
        allPaths.push(line(pt(xSlitR, lockSlitY), pt(snap(xSlitR + 1), snap(lockSlitY - 2)), 'CUT'));
    } // end lockTab

    // ============================================================
    // D. ĐÁY DÁN TỰ ĐỘNG (Auto-Bottom / Crash-Lock đã dán keo)
    //
    // 4 mảnh đáy, dán keo theo 2 CẶP ở hai góc ĐỐI DIỆN:
    //     (front + right)  và  (back + left)
    // Vì layout luôn đi theo vòng front → right → back → left, mảnh đáy
    // CHÍNH (mặt trước/sau) luôn ở cột bên TRÁI góc dán, còn TAI dán
    // (hông) luôn ở cột bên PHẢI góc dán. Cặp (back, left) khép qua mối
    // dán hông nên nằm ở hai đầu bố cục — đúng như thực tế sau khi dán.
    //
    //   Mảnh chính : sâu hDeep ≈ 0.74W (≥ W/2) → 2 mảnh chồng ⇒ đáy kín
    //                + bước vát + cấn chéo 45° + kệ + tai khóa (male ear)
    //   Tai dán    : sâu hWing ≈ W/2, hình thang vát lệch (nhẹ phía dán)
    // ============================================================
    const abDims = autoBottomDims(L, W, T, C, params.ABD);
    const colX: Array<[number, number]> = [[x1, x2], [x2, x3], [x3, x4], [x4, x5]];

    // Inset h = T/2 giống SLB (female/male/dust) — D5 sẽ nối khe bằng V-peak.
    // Deep: paths[0]=mép trái CUT; paths[len-2]=bước vát→góc dán; paths[len-1]=CREASE.
    // Wing: paths[0]=mép góc dán; paths[len-1]=mép tự do.
    type BottomFlapRef = {
        paths: PathSegment[];
        leftIdx: number; leftIsStart: boolean;
        rightIdx: number; rightIsStart: boolean;
        /** Key points free-edge (deep only) — chú thích sau D5 */
        keyPoints?: DeepBottomKeyPoints;
    };
    const bottomFlaps: BottomFlapRef[] = [];

    for (let col = 0; col < 4; col++) {
        const role = pn[col];
        const [cxL, cxR] = colX[col];
        const xFL = snap(cxL + h);
        const xFR = snap(cxR - h);
        const pivotEdge: [Point2D, Point2D] = [pt(cxL, yBot), pt(cxR, yBot)];

        if (role === 'front' || role === 'back') {
            const keyPoints = computeDeepBottomKeyPoints(xFL, xFR, yBot, abDims);
            const flapPaths = buildDeepBottomFlap(xFL, xFR, yBot, abDims);
            allPaths.push(...flapPaths);
            bottomFlaps.push({
                paths: flapPaths,
                leftIdx: 0, leftIsStart: true,
                rightIdx: Math.max(0, flapPaths.length - 2), rightIsStart: false,
                keyPoints,
            });
            // outline gán SAU D5 (khớp CUT cuối + V-peak) — xem bên dưới
            panels.push({
                name: role === 'front' ? 'bottom_main_front' : 'bottom_main_back',
                label: role === 'front' ? 'Đáy dán mặt trước' : 'Đáy dán mặt sau',
                paths: flapPaths,
                parent: role,
                pivotEdge,
                foldAngle: -90,
                foldDirection: -1,
                foldPhase: [0.78, 0.95],
            });
        } else {
            const flapPaths = buildWingBottomFlap(xFL, xFR, yBot, abDims);
            allPaths.push(...flapPaths);
            bottomFlaps.push({
                paths: flapPaths,
                leftIdx: 0, leftIsStart: true,
                rightIdx: flapPaths.length - 1, rightIsStart: false,
            });
            panels.push({
                name: role === 'right' ? 'bottom_wing_right' : 'bottom_wing_left',
                label: role === 'right' ? 'Tai dán đáy phải' : 'Tai dán đáy trái',
                paths: flapPaths,
                parent: role,
                pivotEdge,
                foldAngle: -90,
                foldDirection: -1,
                foldPhase: [0.62, 0.78],
            });
        }
    }

    // ============================================================
    // D2. Nối flap đáy — bám mẫu 100010-01
    //
    //   đoạn gấp: ──●B════════●W──  W=góc cột đáy↔tai, B=điểm gấp đáy
    //               | khe foldGap
    //               ＼ CREASE 45° (đường nhấn) B→E
    //                ＼
    //                 ●E
    //
    // Free-edge đáy CHỈ tới B — không kéo tới W.
    // Đường gấp ngang thân (x1→x5) vẫn giữ (allPaths CREASE đáy).
    // ============================================================
    {
        const f = bottomFlaps[0];
        const seg = f.paths[f.leftIdx];
        if (f.leftIsStart) seg.points[0] = pt(x1, yBot);
        else seg.points[seg.points.length - 1] = pt(x1, yBot);
    }
    {
        const f = bottomFlaps[3];
        const seg = f.paths[f.rightIdx];
        if (f.rightIsStart) seg.points[0] = pt(x5, yBot);
        else seg.points[seg.points.length - 1] = pt(x5, yBot);
        // Deep mép phải ngoài cùng: B = x5, giữ CREASE 45° B→E
        const last = f.paths[f.paths.length - 1];
        if (last.tag === 'CREASE' && last.points.length >= 2) {
            const ptB = pt(x5, yBot);
            last.points[0] = ptB;
            last.points[1] = pt(snap(x5 - abDims.hWing), snap(yBot - abDims.hWing));
            if (f.keyPoints) {
                f.keyPoints = { ...f.keyPoints, B: ptB, E: last.points[1] };
            }
        }
    }

    const junctionXs = [x2, x3, x4];
    for (let j = 0; j < 3; j++) {
        const fL = bottomFlaps[j];
        const fR = bottomFlaps[j + 1];
        const xJ = junctionXs[j]; // W — góc free-edge đáy ↔ tai

        const segL = fL.paths[fL.rightIdx];
        const ptsL = segL.points;
        const jPtIdxL = fL.rightIsStart ? 0 : ptsL.length - 1;

        const segR = fR.paths[fR.leftIdx];
        const ptsR = segR.points;
        const jPtIdxR = fR.leftIsStart ? 0 : ptsR.length - 1;

        const creaseL = fL.paths[fL.paths.length - 1];
        const isDeepWingGlue = creaseL.tag === 'CREASE';

        if (isDeepWingGlue) {
            // Giữ E (đuôi CREASE = free-edge kệ); B = E + (hWing, hWing) trên fold = 45°
            const endE = creaseL.points.length >= 2
                ? creaseL.points[1]
                : pt(snap(xJ - abDims.foldGap - abDims.hWing), snap(yBot - abDims.hWing));

            let xB = snap(endE.x + abDims.hWing);
            const xW = xJ;
            // B luôn trái W (khe trên đoạn gấp, mẫu ~0.013W)
            if (xB > xW - abDims.foldGap) {
                xB = snap(xW - abDims.foldGap);
            }
            const ptB = pt(xB, yBot);
            const ptW = pt(xW, yBot);

            // Free-edge đáy → B (không tới W)
            ptsL[jPtIdxL] = ptB;
            // Free-edge tai → W
            ptsR[jPtIdxR] = ptW;

            // CREASE: B → E (đầu trên đoạn gấp, đuôi trên free-edge)
            if (creaseL.points.length >= 2) {
                creaseL.points[0] = ptB;
                creaseL.points[1] = pt(endE.x, endE.y);
            }
        } else {
            ptsL[jPtIdxL] = pt(xJ, yBot);
            ptsR[jPtIdxR] = pt(xJ, yBot);
        }
    }

    // Outline đáy = chuỗi CUT thật (sau D5) → bleed bám free-edge khuôn.
    // Kẹp y ≤ yBot: V-peak D5 có thể nhô nhẹ lên thân; nếu để nguyên sẽ chồng
    // outline panel thân (geometry overlap test + union bleed).
    for (const panel of panels) {
        if (!panel.name.startsWith('bottom_')) continue;
        const ring = outlineFromCutChain(panel.paths);
        if (ring.length < 3) continue;
        for (const p of ring) {
            if (p.y > yBot) p.y = yBot;
        }
        panel.outline = ring;
    }

    // Chú thích điểm (DEV: "Chú thích điểm") — key points hình học (sau D5 cập nhật B)
    {
        let deepIdx = 0;
        for (const panel of panels) {
            if (panel.name.startsWith('bottom_main_')) {
                // Map panel → matching deep bottomFlap keyPoints
                const flap = bottomFlaps.filter((_, i) => {
                    const role = pn[i];
                    return role === 'front' || role === 'back';
                })[deepIdx++];
                let kp = flap?.keyPoints ?? null;
                if (kp) {
                    const crease = panel.paths.find((s) => s.tag === 'CREASE');
                    if (crease?.points[0]) {
                        kp = { ...kp, B: pt(crease.points[0].x, crease.points[0].y) };
                    }
                    if (crease?.points[1]) {
                        kp = { ...kp, E: pt(crease.points[1].x, crease.points[1].y) };
                    }
                    // A có thể bị D5 kéo về x1
                    const firstCut = panel.paths.find((s) => s.tag === 'CUT');
                    if (firstCut?.points[0] && Math.abs(firstCut.points[0].y - yBot) < 0.2) {
                        kp = { ...kp, A: pt(firstCut.points[0].x, firstCut.points[0].y) };
                    }
                }
                panel.annotations = buildDeepBottomAnnotations(panel, kp);
            } else if (panel.name.startsWith('bottom_wing_')) {
                panel.annotations = buildWingBottomAnnotations(panel);
            }
        }
    }

    // ============================================================
    // E. Bounding Box & Return
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Auto-Bottom Box',
        standardCode: 'AUTO-BOTTOM',
        description: 'Hộp đáy dán tự động — Mỹ phẩm, Dược phẩm, Thực phẩm',
        panels, allPaths, boundingBox: bb, params,
    };
}
