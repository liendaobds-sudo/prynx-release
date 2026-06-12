// ============================================================
// FEFCO 0215 — Snap-Lock Bottom Box (Hộp đáy khoá 1-2-3)
// Đáy khóa hoa mai — KHÔNG dùng keo.
//
// Phần trên (closure + tuck + dust flaps) kế thừa từ RTE.
// Phần đáy: 4 mảng đáy khoá tự khóa (U-Flap, 2 Side Hooks, Locking Tab).
//
// Thuật toán: Mọi tọa độ nội suy từ biến số (L, W, D, T, C, G, TH).
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
    filletBezier,
} from './utils';

import { buildDustFlap, buildTuckFlap } from './sharedHelpers';
import { GLUE_TAPER_RATIO, SLIT_OFFSET_MM, SLIT_DEPTH_MM, SLIT_FILLET_R, KAPPA } from './constants';
import {
    computeSnapLockPairs,
    buildFemaleReceiver,
    buildMaleHook,
    buildBottomDustFlap,
} from './crashLockHelpers';

/**
 * Sinh bản vẽ khuôn bế Snap-Lock Bottom từ thông số đầu vào.
 *
 * Layout trải phẳng (nhìn từ trên):
 *
 *                    [Tuck Top]
 *                  [Closure Top]
 *   [DustFL-T]    [DustFR-T]
 *  
 *   Glue   Left  Front  Right    Back  
 *   Flap   (W)    (L)    (W)     (L)   
 *  
 *   [SideHookL]  [U-Flap]  [SideHookR]  [LockTab]
 *
 * Gốc tọa độ (0,0) = góc dưới-trái của panel ngoài cùng bên trái.
 */
export function generateSnapLockBottom(params: BoxParams): DielineModel {
    const { L, W, D, T, C, G, TH, glueSide, panelOrder, SLP, LTW, LTH } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // A. Tọa độ X các cột (giống RTE)
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

    // Semantic panel edges  map vai tr  tọa  x
    // Front (L wide): nắp trn + Female receiver (crash-lock)
    // Back (L wide):  Male hook (crash-lock)
    // SideA, SideB (W wide): tai bụi + dust flap y
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

    // --- SLB: Closure ch  trn (Front panel), y l crash-lock (tất cả CREASE) ---
    // Front: top yTop+T CREASE (closure fold), top free edge = N/A
    // Back:  top CUT (cạnh tự do, khng c nắp trn)
    // Side:  top CREASE (dust flap fold)
    // Bottom: tất cả ều CREASE (crash-lock fold)
    const yTopFront = snap(yTop + T);
    const colTopY = pn.map(r => r === 'front' ? yTopFront : yTop);
    const colTopTag: Array<'CUT' | 'CREASE'> = pn.map(r => r === 'back' ? 'CUT' : 'CREASE');
    // Bottom: all CREASE in SLB (crash-lock fold for all panels)

    // Vertical edge Y extents
    const x2YTop = snap(Math.max(colTopY[0], colTopY[1]));
    const x3YTop = snap(Math.max(colTopY[1], colTopY[2]));
    const x4YTop = snap(Math.max(colTopY[2], colTopY[3]));

    // ============================================================
    // B. THÂN HỘP (giống RTE, nhưng bottom edges đều là CREASE)
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
    
    // Đảm bảo 3D nhận diện đủ 4 cạnh
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

    // Đảm bảo 3D nhận diện đủ 4 cạnh
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
    // Mặt sau: tách CUT line trên qua locking tab (chỉ khi bật lockTab)
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

    // Đảm bảo 3D nhận diện đủ 4 cạnh
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
    // C. PHẦN TRÊN — Kế thừa từ RTE (Dust Flaps + Closure + Tuck)
    // ============================================================
    const autoDustH = snap(Math.min(L / 2 - 1, W - T)); // Công thức tự động
    const dustH = params.DFH > 0 ? snap(Math.min(params.DFH, L / 2 - 1)) : autoDustH; // DFH=0 → tự động
    const h = snap(T / 2);  // Mỗi bên giảm T/2 cho các flap

    // mirrorX: phụ thuộc vai trò vật lý (left/right), không phải vị trí layout
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

    // --- C2. Dust Flap trên-phải ---
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

    // --- C3. Closure Panel trên ---
    const closureH = snap(W - T);
    const closureTopY = snap(yTop + T);
    const tuckTopCreaseY = snap(yTop + W - T); // Span = W - T

    const sx1 = snap(SLIT_OFFSET_MM); // Vị trí rãnh gài từ mép
    const slitDropT = snap(SLIT_DEPTH_MM); // Chiều sâu khe gài
    const slitR = snap(SLIT_FILLET_R); // Bo góc nhẹ tại khe gài
    const slitK = snap(slitR * KAPPA);

    // Cạnh trái/phải lùi vào h = T/2 tránh giao nhau với dust flap
    const xCL = snap(xFrontL + h);  // Closure left edge
    const xCR = snap(xFrontR - h);  // Closure right edge

    // CREASE tại closureTopY trùng với body front top edge → chỉ giữ cho panel 3D
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

    // Bo nhọn: bezier với control points kéo về góc → đỉnh nhọn hướng thân hộp
    const pointedFillet = (
        corner: Point2D, prev: Point2D, next: Point2D, d: number
    ): PathSegment => {
        // Vector từ corner về prev và next
        const dx1 = prev.x - corner.x, dy1 = prev.y - corner.y;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        const dx2 = next.x - corner.x, dy2 = next.y - corner.y;
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (len1 < 0.01 || len2 < 0.01) return line(prev, next, 'CUT');
        // Tangent points: d distance from corner along each edge
        const dClamped = Math.min(d, len1 / 2, len2 / 2);
        const t1 = pt(snap(corner.x + (dx1 / len1) * dClamped), snap(corner.y + (dy1 / len1) * dClamped));
        const t2 = pt(snap(corner.x + (dx2 / len2) * dClamped), snap(corner.y + (dy2 / len2) * dClamped));
        // Control points kéo 70% về corner → đường cong nhọn hướng thân hộp
        const pull = 0.2;
        const cp1 = pt(snap(t1.x + (corner.x - t1.x) * pull), snap(t1.y + (corner.y - t1.y) * pull));
        const cp2 = pt(snap(t2.x + (corner.x - t2.x) * pull), snap(t2.y + (corner.y - t2.y) * pull));
        return bezierSegment(t1, cp1, cp2, t2, 'CUT');
    };

    const filletD = snap(Math.min(h, 2)); // Khoảng cách tangent nhỏ = T/2

    // --- Nối closure ↔ dust flap gần nhất (tự động cho WLWL / LWLW) ---
    const connectCorner = (
        closureEdge: PathSegment, isLeftEdge: boolean,
        dustA: PathSegment[], dustB: PathSegment[]
    ) => {
        // Điểm cuối của closure edge gần body
        const cPt = isLeftEdge ? closureEdge.points[0] : closureEdge.points[closureEdge.points.length - 1];
        // Thử nối với dust flap A hoặc B — chọn cái gần nhất
        const candidates = [
            { seg: dustA[dustA.length - 1], end: true, arr: dustA },  // dustA last (P6)
            { seg: dustB[dustB.length - 1], end: true, arr: dustB },  // dustB last (P6)
            { seg: dustA[0], end: false, arr: dustA },                 // dustA first (P0)
            { seg: dustB[0], end: false, arr: dustB },                 // dustB first (P0)
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
                    // Splice fillet vào dust flap array (sau seg cuối hoặc trước seg đầu)
                    const dustIdx = c.arr.indexOf(c.seg);
                    if (c.end) { c.arr.splice(dustIdx + 1, 0, fillet); }
                    else { c.arr.splice(dustIdx, 0, fillet); }
                    allPaths.push(fillet);
                    return;
                }
            }
        }
        // Fallback: bridge
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


    const tuckTopBase = snap(closureTopY + closureH);
    const tuckTopPaths: PathSegment[] = buildTuckFlap(
        xFrontL + tuckInset, tuckTopBase, tuckW, tuckH, tuckR, 1
    );
    // Add base crease to close the loop for 3D tracing
    tuckTopPaths.push(line(pt(xFrontL + tuckInset, tuckTopBase), pt(snap(xFrontL + tuckInset + tuckW), tuckTopBase), 'CREASE'));
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
        const lockTabK = snap(lockTabR * (4 * (Math.sqrt(2) - 1) / 3));
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
            line(pt(xLTR, yTop), pt(xLTL, yTop), 'CREASE') // Close loop for 3D tracing
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
        const lockSlitY = snap(tuckCreaseY + slitDropT - 1); // Hạ xuống 1mm
        const xFrontMid = snap((xFrontL + xFrontR) / 2);
        const xSlitL = snap(xFrontMid - lockSlitW / 2);
        const xSlitR = snap(xFrontMid + lockSlitW / 2);
        allPaths.push(line(pt(xSlitL, lockSlitY), pt(xSlitR, lockSlitY), 'CUT'));
        allPaths.push(line(pt(xSlitL, lockSlitY), pt(snap(xSlitL - 1), snap(lockSlitY - 2)), 'CUT'));
        allPaths.push(line(pt(xSlitR, lockSlitY), pt(snap(xSlitR + 1), snap(lockSlitY - 2)), 'CUT'));
    } // end lockTab

    // ============================================================
    // D. CRASH-LOCK BOTTOM (FEFCO 0427)
    //
    // Tất cả kch thưc = kt (Pacdora rule), clamp theo vật liu.
    //   c       = 0.6t   (clearance)
    //   ear     = 8t     (tai bridge)
    //   step_h  = 30t    (vai male)
    //   depth_m = 32t    (chiều su male)
    //   depth_f = 33t    (chiều su female, ni hơn male)
    //   r       = max(0.8, 2t)   (fillet)
    //
    // Topology:
    //   Front  Female receiver (khe U)
    //   Back   Male hook (lưỡi gi + vai)
    //   Left   Dust flap (relief vt)
    //   Right  Dust flap (relief vt, mirror)
    // ============================================================

    const pairCount = computeSnapLockPairs(L, W, SLP);

    // --- D1. Female Receiver (khe U) — gắn mặt Front (L wide) ---
    const femalePaths = buildFemaleReceiver(snap(xFrontL + h), snap(xFrontR - h), yBot, L, W, T, pairCount);
    allPaths.push(...femalePaths);
    panels.push({
        name: 'u_flap', label: 'Đáy khe U', paths: femalePaths,
        parent: 'front', pivotEdge: [pt(xFrontL, yBot), pt(xFrontR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.75, 0.85],
    });

    // --- D2. Male Hook (lưỡi gài) — gắn mặt Back (L wide) ---
    // Clearance 2T được trừ bên trong buildMaleHook (từ hookW), không phải từ call site
    const malePaths = buildMaleHook(snap(xBackL + h), snap(xBackR - h), yBot, L, W, T, pairCount);
    allPaths.push(...malePaths);
    panels.push({
        name: 'locking_tab', label: 'Đáy lưỡi gài', paths: malePaths,
        parent: 'back', pivotEdge: [pt(xBackL, yBot), pt(xBackR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.85, 1.0],
    });

    // --- D3. Dust Flap trái — gắn mặt SideA (W wide) ---
    const dustBotLPaths = buildBottomDustFlap(snap(xSideAL + h), snap(xSideAR - h), yBot, L, W, T, !sideAIsLeft);
    allPaths.push(...dustBotLPaths);
    panels.push({
        name: 'side_hook_left', label: 'Tai đáy trái', paths: dustBotLPaths,
        parent: isFrontFirst ? 'right' : 'left', pivotEdge: [pt(xSideAL, yBot), pt(xSideAR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.65, 0.75],
    });

    // --- D4. Dust Flap phải — gắn mặt SideB (W wide) ---
    const dustBotRPaths = buildBottomDustFlap(snap(xSideBL + h), snap(xSideBR - h), yBot, L, W, T, !sideBIsLeft);
    allPaths.push(...dustBotRPaths);
    panels.push({
        name: 'side_hook_right', label: 'Tai đáy phải', paths: dustBotRPaths,
        parent: isFrontFirst ? 'left' : 'right', pivotEdge: [pt(xSideBL, yBot), pt(xSideBR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.65, 0.75],
    });

    // ============================================================
    // D5. Nối liền cạnh flap đáy tại các junction x1–x5
    //
    // Approach: kéo dài cạnh đầu/cuối của mỗi flap đến giao điểm
    // (V-peak) rồi nối trực tiếp + bo nhọn. Giống cách connectCorner
    // đã làm cho dust-flap ↔ closure ở phần trên (C3b–c).
    // ============================================================

    // --- Map flaps theo thứ tự panel layout (slot 0–3) ---
    const bottomFlaps: Array<{
        paths: PathSegment[];
        leftIdx: number; leftIsStart: boolean;
        rightIdx: number; rightIsStart: boolean;
    }> = [];

    for (let col = 0; col < 4; col++) {
        const role = pn[col];
        if (role === 'front') {
            bottomFlaps.push({
                paths: femalePaths,
                leftIdx: 0, leftIsStart: true,
                rightIdx: femalePaths.length - 1, rightIsStart: false,
            });
        } else if (role === 'back') {
            bottomFlaps.push({
                paths: malePaths,
                leftIdx: 0, leftIsStart: true,
                rightIdx: malePaths.length - 1, rightIsStart: false,
            });
        } else {
            // Side panel → dust flap. Mirror flag xác định hướng outline.
            // SideA = col isFrontFirst?1:0, SideB = col isFrontFirst?3:2
            const sideACol = isFrontFirst ? 1 : 0;
            const isSlotA = col === sideACol;
            const dustPaths = isSlotA ? dustBotLPaths : dustBotRPaths;
            const mirrorFlag = isSlotA ? isFrontFirst : !isFrontFirst;
            if (!mirrorFlag) {
                // !mirror: outline A(left)→...→B(right). first=left, last=right.
                bottomFlaps.push({
                    paths: dustPaths,
                    leftIdx: 0, leftIsStart: true,
                    rightIdx: dustPaths.length - 1, rightIsStart: false,
                });
            } else {
                // mirror: outline F(right)→...→A2(left). first=right, last=left.
                bottomFlaps.push({
                    paths: dustPaths,
                    leftIdx: dustPaths.length - 1, leftIsStart: false,
                    rightIdx: 0, rightIsStart: true,
                });
            }
        }
    }

    const bridgeFilletD = snap(Math.min(h, 2));

    // --- Junction x1: kéo dài flap[0] mép trái tới x1 ---
    {
        const f = bottomFlaps[0];
        const seg = f.paths[f.leftIdx];
        if (f.leftIsStart) {
            seg.points[0] = pt(x1, seg.points[0].y);
        } else {
            seg.points[seg.points.length - 1] = pt(x1, seg.points[seg.points.length - 1].y);
        }
    }

    // --- Junction x5: kéo dài flap[3] mép phải tới x5 ---
    {
        const f = bottomFlaps[3];
        const seg = f.paths[f.rightIdx];
        if (f.rightIsStart) {
            seg.points[0] = pt(x5, seg.points[0].y);
        } else {
            seg.points[seg.points.length - 1] = pt(x5, seg.points[seg.points.length - 1].y);
        }
    }

    // --- Junctions x2, x3, x4: V-peak với lineIntersect + pointedFillet ---
    const junctionXs = [x2, x3, x4];
    for (let j = 0; j < 3; j++) {
        const fL = bottomFlaps[j];
        const fR = bottomFlaps[j + 1];

        // Edge trái = cạnh phải (rightEdge) của flap bên trái
        const segL = fL.paths[fL.rightIdx];
        const ptsL = segL.points;
        const jPtIdxL = fL.rightIsStart ? 0 : ptsL.length - 1;
        const prevIdxL = fL.rightIsStart ? 1 : ptsL.length - 2;

        // Edge phải = cạnh trái (leftEdge) của flap bên phải
        const segR = fR.paths[fR.leftIdx];
        const ptsR = segR.points;
        const jPtIdxR = fR.leftIsStart ? 0 : ptsR.length - 1;
        const nextIdxR = fR.leftIsStart ? 1 : ptsR.length - 2;

        // Tìm giao điểm 2 đường thẳng (kéo dài vô hạn)
        const meet = lineIntersect(
            ptsL[prevIdxL], ptsL[jPtIdxL],
            ptsR[jPtIdxR], ptsR[nextIdxR],
        );

        if (meet && meet.y > yBot) {
            // Kéo dài cả 2 cạnh tới giao điểm (V-peak)
            ptsL[jPtIdxL] = meet;
            ptsR[jPtIdxR] = meet;

            // Bo nhọn tại V-peak (dùng pointedFillet giống top section)
            const fillet = pointedFillet(meet, ptsL[prevIdxL], ptsR[nextIdxR], bridgeFilletD);
            ptsL[jPtIdxL] = fillet.points[0];
            ptsR[jPtIdxR] = fillet.points[fillet.points.length - 1];
            // Splice fillet vào left flap path array (liền mạch thực sự)
            const spliceIdx = fL.rightIsStart ? fL.rightIdx : fL.rightIdx + 1;
            fL.paths.splice(spliceIdx, 0, fillet);
            // Cập nhật indices nếu rightIdx < leftIdx (mirror case)
            if (fL.leftIdx >= spliceIdx) fL.leftIdx++;
            allPaths.push(fillet);
        } else {
            // Fallback: nối ngang
            const xJ = junctionXs[j];
            allPaths.push(line(pt(snap(xJ - h), yBot), pt(snap(xJ + h), yBot), 'CUT'));
        }
    }

    // ============================================================
    // E. Bounding Box & Return
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Snap-Lock Bottom',
        standardCode: 'FEFCO-0215',
        description: 'Hộp đáy khoá 1-2-3 — Chai rượu, Mỹ phẩm nặng',
        panels, allPaths, boundingBox: bb, params,
    };
}

