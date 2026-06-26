// ============================================================
// Gable Box — Hộp Quai Xách (Handle Carrier Box)
// Đáy crash-lock (giống SLB), nắp gable với lỗ quai xách.
//
// Thuật toán: Mọi tọa độ được nội suy từ biến số.
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
    arc,
} from './utils';

import { tracePerimeter } from './tracePerimeter';

import {
    computeSnapLockPairs,
    buildFemaleReceiver,
    buildMaleHook,
    buildBottomDustFlap,
} from './crashLockHelpers';
import { GLUE_TAPER_RATIO } from './constants';

/**
 * Sinh bản vẽ khuôn bế Gable Box từ thông số đầu vào.
 *
 * Layout trải phẳng (nhìn từ trên):
 *
 *                    [Gable Front]  ← chứa lỗ quai
 *   [SideFlap-TL]                  [SideFlap-TR]
 *  
 *   Glue   Left  Front  Right    Back  
 *   Flap   (W)    (L)    (W)     (L)   
 *  
 *   [DustBotL]  [FemaleRcv]  [DustBotR]  [MaleHook]
 *
 * Gốc tọa độ (0,0) = góc dưới-trái của panel ngoài cùng bên trái.
 */
export function generateGableBox(params: BoxParams): DielineModel {
    const { L, W, D, T, G, glueSide, panelOrder, HH, HW, HHL, handleShape, SLP } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // A. Tọa độ X các cột (giống SLB)
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

    // Semantic panel edges
    const isFrontFirst = panelOrder === 'LWLW';
    const [xFrontL, xFrontR] = isFrontFirst ? [x1, x2] : [x2, x3];
    const [xBackL, xBackR] = isFrontFirst ? [x3, x4] : [x4, x5];
    const [xSideAL, xSideAR] = isFrontFirst ? [x2, x3] : [x1, x2];
    const [xSideBL, xSideBR] = isFrontFirst ? [x4, x5] : [x3, x4];

    const pn = isFrontFirst
        ? ['front', 'right', 'back', 'left']
        : ['left', 'front', 'right', 'back'];

    const sideAIsLeft = !isFrontFirst;
    const sideBIsLeft = isFrontFirst;

    // Tọa độ Y thân hộp
    const yBot = 0;
    const yTop = snap(D);

    const h = snap(T / 2); // Mỗi bên giảm T/2

    // ============================================================
    // B. THÂN HỘP (giống SLB — Bottom edges đều là CREASE)
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
        name: 'glue_flap', label: 'Mép dán keo', paths: gluePaths,
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

    // Top edges: Front + Back đều CREASE (gable gập), SideA/B cũng CREASE (side flap)
    // Bottom edges: tất cả CREASE (crash-lock fold)

    // --- B2–B5. Body Columns ---
    const colTopTag: Array<'CUT' | 'CREASE'> = ['CREASE', 'CREASE', 'CREASE', 'CREASE'];

    // Column 0
    const x2YTop = yTop;
    const leftPaths: PathSegment[] = [
        line(pt(x2, yBot), pt(x2, x2YTop), 'CREASE'),
        line(pt(x2, yTop), pt(x1, yTop), colTopTag[0]),
    ];
    if (glueSide === 'right') {
        leftPaths.push(line(pt(x1, yTop), pt(x1, yBot), 'CUT'));
    }
    allPaths.push(...leftPaths);
    panels.push({
        name: pn[0], label: pn[0] === 'left' ? 'Hông trái' : 'Mặt trước',
        paths: leftPaths,
        outline: [pt(x1, yBot), pt(x2, yBot), pt(x2, x2YTop), pt(x1, x2YTop)],
        parent: pn[1],
        pivotEdge: [pt(x2, yBot), pt(x2, yTop)],
        foldAngle: 90, foldDirection: -1,
    });

    // Column 1 — ROOT
    const frontPaths: PathSegment[] = [
        line(pt(x3, yBot), pt(x3, yTop), 'CREASE'),
        line(pt(x2, yTop), pt(x3, yTop), colTopTag[1]),
    ];
    allPaths.push(...frontPaths);
    panels.push({
        name: pn[1], label: pn[1] === 'front' ? 'Mặt trước' : 'Hông phải',
        paths: frontPaths,
        outline: [pt(x2, yBot), pt(x3, yBot), pt(x3, yTop), pt(x2, yTop)],
        parent: null,
        pivotEdge: null, foldAngle: 0, foldDirection: -1,
    });

    // Column 2
    const rightPaths: PathSegment[] = [
        line(pt(x4, yBot), pt(x4, yTop), 'CREASE'),
        line(pt(x4, yTop), pt(x3, yTop), colTopTag[2]),
    ];
    allPaths.push(...rightPaths);
    panels.push({
        name: pn[2], label: pn[2] === 'right' ? 'Hông phải' : 'Mặt sau',
        paths: rightPaths,
        outline: [pt(x3, yBot), pt(x4, yBot), pt(x4, yTop), pt(x3, yTop)],
        parent: pn[1],
        pivotEdge: [pt(x3, yBot), pt(x3, yTop)],
        foldAngle: -90, foldDirection: -1,
    });

    // Column 3
    const backPaths: PathSegment[] = [
        line(pt(x5, yBot), pt(x5, yTop), glueSide === 'left' ? 'CUT' : 'CREASE'),
        line(pt(x5, yTop), pt(x4, yTop), colTopTag[3]),
    ];
    allPaths.push(...backPaths);
    panels.push({
        name: pn[3], label: pn[3] === 'back' ? 'Mặt sau' : 'Hông trái',
        paths: backPaths,
        outline: [pt(x4, yBot), pt(x5, yBot), pt(x5, yTop), pt(x4, yTop)],
        parent: pn[2],
        pivotEdge: [pt(x4, yBot), pt(x4, yTop)],
        foldAngle: -90, foldDirection: -1,
    });

    // --- Đường CREASE đáy liên tục (gộp 4 cột thành 1 đoạn) ---
    allPaths.push(line(pt(x1, yBot), pt(x5, yBot), 'CREASE'));

    // ============================================================
    // C. GABLE TOP — Nắp mái + quai xách
    //
    //  Cấu trúc (mỗi panel Front/Back):
    //
    //         E──────────────F           ← EF = 2/3 AB
    //        ╱│    Y───K    │╲
    //   O──P             Q──T
    //          M─────N        
    //   A─R────M───N────H─B   ← CREASE fold (AB)
    //                            
    //         Trapezoid ABCD   
    //                        
    //       D────────C        body panel top (CREASE)
    //
    //  1. ABCD: hình thang cân, h = W/2, AB = 5/6 L
    //  2. EFBA: hình thang cân trên AB, h = 0.9(W/2), EF = 2/3 AB
    //  3. OPRA, QTBH: hình chữ nhật 2 bên, h = 0.85h2, w = AB/9
    //  4. YKNM: lỗ quai xách, w = 2/5 AB, h = 1/2 h2
    // ============================================================

    // --- C1. Gable Panel Front (trên Front Panel, L wide) ---
    const h1 = snap(params.gableStyle === 'pitched' ? W / Math.sqrt(3) : W / 2);
    const gableFold = params.gableStyle === 'pitched' ? 60 : 90;
    const handleFold = params.gableStyle === 'pitched' ? -60 : -90;

    const gfResult = buildGablePanel(xFrontL, xFrontR, yTop, L, W, HW, HHL, handleShape, params.handleY, params.HFH, params.gableStyle, params.TRW, params.SLH);
    allPaths.push(...gfResult.paths);
    panels.push({
        name: 'gable_front_base', label: 'Mái trước (gốc)',
        paths: gfResult.basePaths, parent: 'front',
        pivotEdge: [pt(xFrontL, yTop), pt(xFrontR, yTop)],
        foldAngle: gableFold, foldDirection: -1,
        outline: gfResult.baseOutline,
        foldPhase: [0.6, 0.8],
    });
    panels.push({
        name: 'gable_front_handle', label: 'Tay cầm trước',
        paths: gfResult.handlePaths, parent: 'gable_front_base',
        pivotEdge: [pt(xFrontL, snap(yTop + h1)), pt(xFrontR, snap(yTop + h1))],
        foldAngle: handleFold, foldDirection: -1,
        holes: [tracePerimeter(gfResult.holes)],
        outline: gfResult.handleOutline,
        annotations: gfResult.annotations,
        foldPhase: [0.6, 0.8],
    });

    // --- C2. Gable Panel Back (trên Back Panel, L wide) ---
    const gbResult = buildGablePanel(xBackL, xBackR, yTop, L, W, HW, HHL, handleShape, params.handleY, params.HFH, params.gableStyle, params.TRW, params.SLH);
    allPaths.push(...gbResult.paths);
    panels.push({
        name: 'gable_back_base', label: 'Mái sau (gốc)',
        paths: gbResult.basePaths, parent: 'back',
        pivotEdge: [pt(xBackL, yTop), pt(xBackR, yTop)],
        foldAngle: gableFold, foldDirection: -1,
        outline: gbResult.baseOutline,
        foldPhase: [0.6, 0.8],
    });
    panels.push({
        name: 'gable_back_handle', label: 'Tay cầm sau',
        paths: gbResult.handlePaths, parent: 'gable_back_base',
        pivotEdge: [pt(xBackL, snap(yTop + h1)), pt(xBackR, snap(yTop + h1))],
        foldAngle: handleFold, foldDirection: -1,
        holes: [tracePerimeter(gbResult.holes)],
        outline: gbResult.handleOutline,
        annotations: gbResult.annotations,
        foldPhase: [0.6, 0.8],
    });

    // --- C3 & C4: Tính toán góc gập của side flap ---
    // Side flap phải nằm đè lên cạnh vát của mái chính (đoạn DA).
    // Điểm A (góc trên của mái chính) có X = panelW/12 (nếu pitched) hoặc 0 (nếu flat).
    // Side flap quay quanh trục Y, nên góc gập phi = atan(X_A / Z_height).
    const insetA = snap(params.gableStyle === 'pitched' ? (L - 5 / 6 * L) / 2 : 0);
    const Z_height = h1 * Math.cos(gableFold * Math.PI / 180); // Chiều cao thực tế Z
    // Kích thước ngàm — TÍNH GIỐNG HỆT buildGablePanel để mái phụ + rãnh LUÔN bám
    // theo ngàm khi đổi thông số: HFH (cao tay cầm), SLH (tỷ lệ rãnh), TRW (rộng ngàm), W, L.
    const gH2 = params.HFH > 0 ? snap(params.HFH) : snap(0.9 * h1);
    const gRectH = snap((params.SLH / 100) * gH2);
    const gTRW = snap(params.TRW > 0 ? params.TRW : L / 9);
    const gR = snap(Math.min(gTRW / 2, gRectH));
    let sideFlapFold = gableFold;
    if (Z_height > 0.001) {
        const Z_P = (h1 + gRectH) * Math.cos(gableFold * Math.PI / 180);
        const angleA = Math.atan2(insetA, Z_height) * 180 / Math.PI;
        const angleP = Math.atan2(gTRW, Z_P) * 180 / Math.PI;
        sideFlapFold = (angleA + angleP) / 2; // Average to minimize 3D clipping
    } else {
        // Mái bằng: mái phụ gập đúng theo HƯỚNG khóe ngàm A→P (Δx=TRW theo ngang,
        // Δy=rectH−r theo dọc) để chân rãnh ↔ A và đỉnh rãnh ↔ P.
        // Góc = atan(TRW / (rectH − r)); chiều dài rãnh = √(TRW² + (rectH−r)²) (trong buildSideTriFlap).
        sideFlapFold = Math.atan2(gTRW, Math.max(gRectH - gR, 0.001)) * 180 / Math.PI;
    }

    // --- C3. Side Flap trái (trên SideA Panel, W wide) — Tam giác ---
    const sfLResult = buildSideTriFlap(xSideAL, xSideAR, yTop, W, L, 1, params.HH, params.gableStyle, params.SLW, params.SLH, params.TRW, params.HFH);
    allPaths.push(...sfLResult.paths, ...sfLResult.holes);
    panels.push({
        name: 'side_flap_left', label: 'Tai mái trái',
        paths: sfLResult.paths,
        parent: isFrontFirst ? 'right' : 'left',
        pivotEdge: [pt(xSideAL, yTop), pt(xSideAR, yTop)],
        foldAngle: sideFlapFold, foldDirection: -1,
        holes: sfLResult.holes.length > 0 ? [tracePerimeter(sfLResult.holes)] : [],
        annotations: sfLResult.annotations,
        foldPhase: [0.8, 1.0],
    });

    // --- C4. Side Flap phải (trên SideB Panel, W wide) — Tam giác ---
    const sfRResult = buildSideTriFlap(xSideBL, xSideBR, yTop, W, L, 1, params.HH, params.gableStyle, params.SLW, params.SLH, params.TRW, params.HFH);
    allPaths.push(...sfRResult.paths, ...sfRResult.holes);
    panels.push({
        name: 'side_flap_right', label: 'Tai mái phải',
        paths: sfRResult.paths,
        parent: isFrontFirst ? 'left' : 'right',
        pivotEdge: [pt(xSideBL, yTop), pt(xSideBR, yTop)],
        foldAngle: sideFlapFold, foldDirection: -1,
        holes: sfRResult.holes.length > 0 ? [tracePerimeter(sfRResult.holes)] : [],
        annotations: sfRResult.annotations,
        foldPhase: [0.8, 1.0],
    });

    // ============================================================
    // D. CRASH-LOCK BOTTOM (giống SLB hoàn toàn)
    // ============================================================
    const pairCount = computeSnapLockPairs(L, W, SLP);

    // --- D1. Female Receiver ---
    const femalePaths = buildFemaleReceiver(snap(xFrontL + h), snap(xFrontR - h), yBot, L, W, T, pairCount);
    allPaths.push(...femalePaths);
    panels.push({
        name: 'u_flap', label: 'Đáy khe U', paths: femalePaths,
        parent: 'front', pivotEdge: [pt(xFrontL, yBot), pt(xFrontR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.75, 0.85],
    });

    // --- D2. Male Hook ---
    const malePaths = buildMaleHook(snap(xBackL + h), snap(xBackR - h), yBot, L, W, T, pairCount);
    allPaths.push(...malePaths);
    panels.push({
        name: 'locking_tab', label: 'Đáy lưỡi gài', paths: malePaths,
        parent: 'back', pivotEdge: [pt(xBackL, yBot), pt(xBackR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.85, 1.0],
    });

    // --- D3. Bottom Dust Flap trái ---
    const dustBotLPaths = buildBottomDustFlap(snap(xSideAL + h), snap(xSideAR - h), yBot, L, W, T, !sideAIsLeft);
    allPaths.push(...dustBotLPaths);
    panels.push({
        name: 'side_hook_left', label: 'Tai đáy trái', paths: dustBotLPaths,
        parent: isFrontFirst ? 'right' : 'left',
        pivotEdge: [pt(xSideAL, yBot), pt(xSideAR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.65, 0.75],
    });

    // --- D4. Bottom Dust Flap phải ---
    const dustBotRPaths = buildBottomDustFlap(snap(xSideBL + h), snap(xSideBR - h), yBot, L, W, T, !sideBIsLeft);
    allPaths.push(...dustBotRPaths);
    panels.push({
        name: 'side_hook_right', label: 'Tai đáy phải', paths: dustBotRPaths,
        parent: isFrontFirst ? 'left' : 'right',
        pivotEdge: [pt(xSideBL, yBot), pt(xSideBR, yBot)],
        foldAngle: -90, foldDirection: -1,
        foldPhase: [0.65, 0.75],
    });

    // ============================================================
    // D5. Nối liền cạnh flap đáy tại các junction x1–x5
    //
    // Approach: kéo dài cạnh đầu/cuối của mỗi flap đến giao điểm
    // (V-peak) rồi nối trực tiếp + bo nhọn.
    // ============================================================

    // --- lineIntersect helper ---
    const lineIntersect = (a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null => {
        const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
        const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) < 1e-10) return null;
        const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
        return pt(snap(a1.x + t * dx1), snap(a1.y + t * dy1));
    };

    // --- pointedFillet helper ---
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
            const sideACol = isFrontFirst ? 1 : 0;
            const isSlotA = col === sideACol;
            const dustPaths = isSlotA ? dustBotLPaths : dustBotRPaths;
            const mirrorFlag = isSlotA ? isFrontFirst : !isFrontFirst;
            if (!mirrorFlag) {
                bottomFlaps.push({
                    paths: dustPaths,
                    leftIdx: 0, leftIsStart: true,
                    rightIdx: dustPaths.length - 1, rightIsStart: false,
                });
            } else {
                bottomFlaps.push({
                    paths: dustPaths,
                    leftIdx: dustPaths.length - 1, leftIsStart: false,
                    rightIdx: 0, rightIsStart: true,
                });
            }
        }
    }

    // --- Junction x1: kéo dài flap[0] mép trái tới x1 ---
    {
        const f = bottomFlaps[0];
        const seg = f.paths[f.leftIdx];
        if (f.leftIsStart) seg.points[0] = pt(x1, seg.points[0].y);
        else seg.points[seg.points.length - 1] = pt(x1, seg.points[seg.points.length - 1].y);
    }

    // --- Junction x5: kéo dài flap[3] mép phải tới x5 ---
    {
        const f = bottomFlaps[3];
        const seg = f.paths[f.rightIdx];
        if (f.rightIsStart) seg.points[0] = pt(x5, seg.points[0].y);
        else seg.points[seg.points.length - 1] = pt(x5, seg.points[seg.points.length - 1].y);
    }

    // --- Junctions x2, x3, x4: V-peak với lineIntersect + pointedFillet ---
    const junctionXs = [x2, x3, x4];
    for (let j = 0; j < 3; j++) {
        const fL = bottomFlaps[j];
        const fR = bottomFlaps[j + 1];

        const segL = fL.paths[fL.rightIdx];
        const ptsL = segL.points;
        const jPtIdxL = fL.rightIsStart ? 0 : ptsL.length - 1;
        const prevIdxL = fL.rightIsStart ? 1 : ptsL.length - 2;

        const segR = fR.paths[fR.leftIdx];
        const ptsR = segR.points;
        const jPtIdxR = fR.leftIsStart ? 0 : ptsR.length - 1;
        const nextIdxR = fR.leftIsStart ? 1 : ptsR.length - 2;

        const meet = lineIntersect(
            ptsL[prevIdxL], ptsL[jPtIdxL],
            ptsR[jPtIdxR], ptsR[nextIdxR],
        );

        if (meet && meet.y > yBot) {
            ptsL[jPtIdxL] = meet;
            ptsR[jPtIdxR] = meet;

            const fillet = pointedFillet(meet, ptsL[prevIdxL], ptsR[nextIdxR], filletD);
            ptsL[jPtIdxL] = fillet.points[0];
            ptsR[jPtIdxR] = fillet.points[fillet.points.length - 1];
            // Splice fillet vào left flap path array
            const spliceIdx = fL.rightIsStart ? fL.rightIdx : fL.rightIdx + 1;
            fL.paths.splice(spliceIdx, 0, fillet);
            if (fL.leftIdx >= spliceIdx) fL.leftIdx++;
            allPaths.push(fillet);
        } else {
            const xJ = junctionXs[j];
            allPaths.push(line(pt(snap(xJ - h), yBot), pt(snap(xJ + h), yBot), 'CUT'));
        }
    }

    // --- Nối top: side flap ↔ gable panel tại giao điểm + bo nhọn ---
    const topFlaps = [
        { paths: sfLResult.paths, gableA: gfResult.paths, gableB: gbResult.paths },
        { paths: sfRResult.paths, gableA: gfResult.paths, gableB: gbResult.paths },
    ];

    for (const { paths: sfPaths, gableA, gableB } of topFlaps) {
        // Side flap: first seg = left edge, last seg = right edge
        for (const isLeft of [true, false]) {
            const sfSeg = isLeft ? sfPaths[0] : sfPaths[sfPaths.length - 1];
            const sfPt = isLeft ? sfSeg.points[0] : sfSeg.points[sfSeg.points.length - 1];

            // Tìm gable edge gần nhất
            for (const gable of [gableA, gableB]) {
                const candidates = [
                    { seg: gable[0], isStart: true },
                    { seg: gable[gable.length - 1], isStart: false },
                ];
                for (const c of candidates) {
                    const gPt = c.isStart ? c.seg.points[0] : c.seg.points[c.seg.points.length - 1];
                    const gap = Math.abs(gPt.x - sfPt.x) + Math.abs(gPt.y - sfPt.y);
                    if (gap < T * 3) {
                        const meet = lineIntersect(
                            sfSeg.points[0], sfSeg.points[1],
                            c.seg.points[0], c.seg.points[1],
                        );
                        if (meet && meet.y > yTop) {
                            // Kéo dài cả 2 cạnh
                            if (isLeft) sfSeg.points[0] = meet;
                            else sfSeg.points[sfSeg.points.length - 1] = meet;
                            if (c.isStart) c.seg.points[0] = meet;
                            else c.seg.points[c.seg.points.length - 1] = meet;

                            // Bo nhọn
                            const prev = isLeft ? sfSeg.points[1] : sfSeg.points[sfSeg.points.length - 2];
                            const next = c.isStart ? c.seg.points[1] : c.seg.points[c.seg.points.length - 2];
                            const fillet = pointedFillet(meet, prev, next, filletD);

                            if (isLeft) sfSeg.points[0] = fillet.points[0];
                            else sfSeg.points[sfSeg.points.length - 1] = fillet.points[0];
                            if (c.isStart) c.seg.points[0] = fillet.points[fillet.points.length - 1];
                            else c.seg.points[c.seg.points.length - 1] = fillet.points[fillet.points.length - 1];

                            // Splice fillet vào side flap
                            if (isLeft) sfPaths.splice(0, 0, fillet);
                            else sfPaths.push(fillet);
                            allPaths.push(fillet);
                        }
                    }
                }
            }
        }
    }

    // ============================================================
    // E. Bounding Box & Return
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Gable Box',
        standardCode: 'GABLE-CARRIER',
        description: 'Hộp quai xách — Bánh kem, Quà tặng',
        panels, allPaths, boundingBox: bb, params,
    };
}

// ============================================================
// buildGablePanel — Phần nắp Gable Box
//
//         E──────────────F           ← EF = 2/3 AB
//        ╱│    Y───K    │╲
//   O──P             Q──T
//          M─────N        
//   A─R────H─B   AB CREASE fold
//                            
//         Trapezoid ABCD   
//                        
//       D────────C        body panel top (đã vẽ bởi body)
//
// 1. ABCD: hình thang cân, cao = W/2, AB = 5/6 × L
// 2. EFBA: hình thang cân trên AB, cao = 0.9 × W/2, EF = 2/3 × AB
// 3. OPRA: hcn trái, cao = 0.85 × h2, rộng = AB/9
// 4. QTBH: hcn phải (đối xứng OPRA)
// 5. YKNM: lỗ quai xách, rộng = 2/5 × AB, cao = 1/2 × h2
// ============================================================
function buildGablePanel(
    xLeft: number,   // D.x
    xRight: number,  // C.x
    yBase: number,   // D.y = C.y
    panelW: number,  // L
    sideW: number,   // W
    overrideHW: number = 0,   // HW — override rộng lỗ quai (0 = dùng tỷ lệ mặc định)
    overrideHHL: number = 0,  // HHL — override cao lỗ quai (0 = dùng tỷ lệ mặc định)
    holeShape: 'oval' | 'roundRect' = 'oval', // Dạng lỗ quai
    holeYMode: 'bottom' | 'center' = 'bottom', // Vị trí lỗ
    overrideHFH: number = 0,  // HFH — override cao phần tay cầm (0 = dùng tỷ lệ mặc định)
    gableStyle: 'flat' | 'pitched' = 'flat', // Kiểu mái
    overrideTRW: number = 0, // Bề rộng ngàm (0 = auto L/9)
    ratioSLH: number = 85 // Tỷ lệ chiều cao ngàm / rãnh so với tay cầm (%)
): { paths: PathSegment[], holes: PathSegment[], basePaths: PathSegment[], handlePaths: PathSegment[], baseOutline: Point2D[], handleOutline: Point2D[], annotations: any[] } {
    const paths: PathSegment[] = [];
    const holes: PathSegment[] = [];
    const basePaths: PathSegment[] = [];
    const handlePaths: PathSegment[] = [];
    const annotations: any[] = [];

    // === Step 1: Trapezoid ABCD (base width = L, top width = 5/6 L if pitched, L if flat) ===
    const h1 = snap(gableStyle === 'pitched' ? sideW / Math.sqrt(3) : sideW / 2);
    const AB_width = snap(gableStyle === 'pitched' ? 5 / 6 * panelW : panelW);
    const insetAB = snap((panelW - AB_width) / 2);

    const _D = pt(xLeft, yBase);
    const _C = pt(xRight, yBase);
    const _A = pt(snap(xLeft + insetAB), snap(yBase + h1));
    const _B = pt(snap(xRight - insetAB), snap(yBase + h1));

    // === Step 2: Rectangle AEFB (hẹp hơn, EF = 2/3 L, thụt vào trong từ A và B) ===
    const defaultH2 = snap(0.9 * h1);
    const h2 = snap(overrideHFH > 0 ? overrideHFH : defaultH2);
    const EF_width = snap(2 / 3 * panelW);
    const insetEF = snap((AB_width - EF_width) / 2);

    // --- Mái dốc 'pitched': bù góc gập để DA và EP SONG SONG với mái phụ sau khi gập ---
    // Tay cầm (chứa E, P) gập một góc KHÁC mái dốc DA. Nếu E, P nằm trên đường thẳng D–A
    // thì sau khi gập cạnh EP không song song mái phụ → P/E lòi ra trước (đâm xuyên).
    // Đo từ mô hình 3D đã gập: một điểm trên tay cầm cách đường gập A–B đoạn `dh` (theo y)
    // sẽ NẰM SONG SONG với mặt phẳng mái phụ (cùng độ sâu với A, tức nằm sau mái phụ) khi
    // đặt thụt vào trong với: inset = C · slopeInv · dh, C ≈ 1.75 (hằng định cho mọi cỡ hộp).
    const pitched = gableStyle === 'pitched';
    const slopeInv = h1 > 0 ? insetAB / h1 : 0;        // dx/dy dọc cạnh xiên D–A
    const PAR_C = 1.75;                                // hệ số bù song song (đo từ 3D)
    // Chặn trên inset để E,F không vượt quá (giữ EF_width ≥ 30% AB_width); với tham số
    // cực đoan (W rất nhỏ ⇒ slopeInv lớn, hoặc HFH lớn) công thức có thể bùng nổ, làm
    // E,F văng sang panel khác gây chồng lấn. Tham số thường KHÔNG chạm ngưỡng này.
    const maxParInset = snap(0.35 * AB_width);
    const parX = (baseX: number, dir: 1 | -1, dh: number) =>
        snap(baseX + dir * Math.min(PAR_C * slopeInv * dh, maxParInset));

    const _E = pt(pitched ? parX(_A.x, 1, h2) : snap(_A.x + insetEF), snap(_A.y + h2));
    const _F = pt(pitched ? parX(_B.x, -1, h2) : snap(_B.x - insetEF), snap(_A.y + h2));

    // === Step 3: Tab trái/phải — khóe ngàm nằm trên cạnh xiên khi pitched ===
    const rectH = snap((ratioSLH / 100) * h2);
    const rectW = snap(overrideTRW > 0 ? overrideTRW : panelW / 9);
    // Kẹp bán kính bo ≤ rectH để khóe ngàm (pArc2.y = A.y + rectH - r) không bao giờ
    // tụt xuống dưới chân ngàm A. Nếu không, với param cực đoan (rectW ≫ rectH) khóe
    // sẽ rơi xuống y < A.y và onLine() đẩy điểm văng ra ngoài, đè lên panel mép dán.
    const r = snap(Math.min(rectW / 2, rectH));

    // Khóe ngàm P, Q đặt theo công thức song song (parX) để pArc2/qArc1 song song mái phụ.
    const _O = pt(xLeft, snap(_A.y + rectH));   // Mũi ngàm trái (góc ngoài trên)
    const _P = pt(pitched ? parX(_A.x, 1, rectH - r) : snap(xLeft + rectW), snap(_A.y + rectH));

    // === Step 3b: Tab phải ===
    const _T = pt(xRight, snap(_B.y + rectH));  // Mũi ngàm phải (góc ngoài trên)
    const _Q = pt(pitched ? parX(_B.x, -1, rectH - r) : snap(xRight - rectW), snap(_B.y + rectH));

    // === Step 4: Handle hole YKNM ===
    const defaultHoleW = snap(2 / 5 * panelW);
    const defaultHoleH = snap(1 / 2 * h2);
    const holeW = snap(Math.min(overrideHW > 0 ? overrideHW : defaultHoleW, panelW - 20));
    const holeH = snap(Math.min(overrideHHL > 0 ? overrideHHL : defaultHoleH, h2 - 4));
    const holeCX = snap((_A.x + _B.x) / 2);

    // Tính toán tọa độ Y của lỗ
    let holeBottomY = _A.y;
    if (holeYMode === 'center') {
        const availableH = h2; // Chiều cao vùng chứa tay cầm
        holeBottomY = snap(_A.y + (availableH - holeH) / 2);
    }
    // Nếu 'bottom', mặc định là _A.y (sát đáy)

    const _M = pt(snap(holeCX - holeW / 2), holeBottomY);
    const _N = pt(snap(holeCX + holeW / 2), holeBottomY);
    const _Y = pt(_M.x, snap(holeBottomY + holeH));
    const _K = pt(_N.x, snap(holeBottomY + holeH));

    // ================================================================
    // CUT — Outer contour (tab thụt vào trong, bo tròn đầu tab)
    //   D → A → O    P → E → F → Q    T → B → C
    // ================================================================

    // Chú thích ĐẦY ĐỦ tên các điểm (hiển thị khi bật "Hiện chi tiết") —
    // dùng để tham chiếu chính xác khi chỉnh hình ngàm/mái.
    // LƯU Ý: đường cắt lưỡi ngàm bắt đầu NGAY TẠI A (và B) — `sA_oArc1 = A→O`.
    // Vì vậy CHÂN NGÀM chính là điểm A/B (không có điểm R/H riêng trên nét cắt).
    // --- Đáy mái (chân mái, cạnh gập xuống thân hộp) ---
    annotations.push({ point: _D, text: 'D — Đáy mái trái (chân mái)', anchor: 'end', baseline: 'hanging' });
    annotations.push({ point: _C, text: 'C — Đáy mái phải (chân mái)', anchor: 'start', baseline: 'hanging' });
    // --- Góc hình thang nắp = CHÂN NGÀM (đường cắt ngàm bắt đầu tại đây) ---
    annotations.push({ point: _A, text: 'A — Góc hình thang trái = Chân ngàm trái', anchor: 'start', baseline: 'bottom' });
    annotations.push({ point: _B, text: 'B — Góc hình thang phải = Chân ngàm phải', anchor: 'end', baseline: 'bottom' });
    // --- Ngàm khóa TRÁI/PHẢI: chú thích O,P,T,Q được đẩy SAU khi tính điểm cung
    //     (oArcTop, pArc2, qArc1, tArcTop) để trỏ ĐÚNG điểm trên nét cắt cong,
    //     không trỏ vào góc hộp-bao lý thuyết (_O/_P/_T/_Q) đang lơ lửng ngoài cung. ---
    // --- Đỉnh nắp (vai tay cầm, hai đầu cạnh trên ngang) ---
    annotations.push({ point: _E, text: 'E — Đỉnh nắp trái (vai tay cầm)', anchor: 'start', baseline: 'hanging' });
    annotations.push({ point: _F, text: 'F — Đỉnh nắp phải (vai tay cầm)', anchor: 'end', baseline: 'hanging' });
    // --- Lỗ quai xách (YKNM) ---
    annotations.push({ point: _M, text: 'M — Lỗ quai: mép dưới-trái', anchor: 'end', baseline: 'hanging' });
    annotations.push({ point: _N, text: 'N — Lỗ quai: mép dưới-phải', anchor: 'start', baseline: 'hanging' });
    annotations.push({ point: _Y, text: 'Y — Lỗ quai: mép trên-trái', anchor: 'end', baseline: 'bottom' });
    annotations.push({ point: _K, text: 'K — Lỗ quai: mép trên-phải', anchor: 'start', baseline: 'bottom' });


    const kappa = 4 * (Math.sqrt(2) - 1) / 3;
    const kLen = snap(r * kappa);

    // Tab trái arc (OP thụt vào, bo tại đỉnh)
    const oArc1 = pt(_O.x, snap(_O.y - r));                    // Start arc trên cạnh AO
    const oArcTop = pt(snap(_O.x + r), _O.y);                  // Đỉnh arc (trên)
    const pArcTop = pt(snap(_P.x - r), _P.y);                  // Đỉnh arc (trên)
    const pArc2 = pt(_P.x, snap(_P.y - r));                    // End arc trên cạnh PE

    // Tab phải arc (QT thụt vào, bo tại đỉnh)
    const qArc1 = pt(_Q.x, snap(_Q.y - r));                    // Start arc
    const qArcTop = pt(snap(_Q.x + r), _Q.y);                  // Đỉnh arc
    const tArcTop = pt(snap(_T.x - r), _T.y);                  // Đỉnh arc
    const tArc2 = pt(_T.x, snap(_T.y - r));                    // End arc

    // --- Chú thích ngàm trỏ ĐÚNG điểm trên nét cắt cong (không phải góc hộp-bao) ---
    // Đỉnh/mũi ngàm = điểm cao nhất của cung (oArcTop/tArcTop).
    // Khóe ngàm = nơi cung kết thúc và nét cắt đi lên đỉnh nắp (pArc2 / qArc1).
    annotations.push({ point: oArcTop, text: 'O — Đỉnh ngàm trái (mũi lưỡi)', anchor: 'middle', baseline: 'bottom' });
    annotations.push({ point: pArc2, text: 'P — Khóe ngàm trái (góc trong)', anchor: 'start', baseline: 'middle' });
    annotations.push({ point: tArcTop, text: 'T — Đỉnh ngàm phải (mũi lưỡi)', anchor: 'middle', baseline: 'bottom' });
    annotations.push({ point: qArc1, text: 'Q — Khóe ngàm phải (góc trong)', anchor: 'end', baseline: 'middle' });

    const sDA = line(_D, _A, 'CUT');
    const sA_oArc1 = line(_A, oArc1, 'CUT');
    const sArcO = bezierSegment(oArc1, pt(oArc1.x, snap(oArc1.y + kLen)), pt(snap(oArcTop.x - kLen), oArcTop.y), oArcTop, 'CUT');
    const sOT = line(oArcTop, pArcTop, 'CUT');
    const sArcP = bezierSegment(pArcTop, pt(snap(pArcTop.x + kLen), pArcTop.y), pt(pArc2.x, snap(pArc2.y + kLen)), pArc2, 'CUT');
    const sPE = line(pArc2, _E, 'CUT');
    const sEF = line(_E, _F, 'CUT');
    const sFQ = line(_F, qArc1, 'CUT');
    const sArcQ = bezierSegment(qArc1, pt(qArc1.x, snap(qArc1.y + kLen)), pt(snap(qArcTop.x - kLen), qArcTop.y), qArcTop, 'CUT');
    const sQT = line(qArcTop, tArcTop, 'CUT');
    const sArcT = bezierSegment(tArcTop, pt(snap(tArcTop.x + kLen), tArcTop.y), pt(tArc2.x, snap(tArc2.y + kLen)), tArc2, 'CUT');
    const sTB = line(tArc2, _B, 'CUT');
    const sBC = line(_B, _C, 'CUT');
    
    // Global paths for 2D layout
    paths.push(sDA, sA_oArc1, sArcO, sOT, sArcP, sPE, sEF, sFQ, sArcQ, sQT, sArcT, sTB, sBC);
    paths.push(line(_A, _B, 'CREASE'));  // AB — đường gập chính

    // 3D Panel paths
    // Base: ABCD
    basePaths.push(line(_C, _D, 'CREASE')); // hinge at bottom
    basePaths.push(sDA);
    basePaths.push(line(_A, _B, 'CREASE')); // top hinge
    basePaths.push(sBC);

    // Handle: AEFB + tabs
    handlePaths.push(line(_B, _A, 'CREASE')); // reverse hinge for top handle
    handlePaths.push(sA_oArc1, sArcO, sOT, sArcP, sPE, sEF, sFQ, sArcQ, sQT, sArcT, sTB);

    // Cần đảm bảo array điểm là Counter-Clockwise (hoặc ít nhất tương thích với 3D Shape)
    // basePaths của ta: C->D, D->A, A->B, B->C (Clockwise trên trục tọa độ màn hình)
    // Reverse để chuyển thành CCW: C->B->A->D->C
    const baseOutline = tracePerimeter(basePaths.map(p => ({ ...p, tag: 'CUT' as const })));
    baseOutline.reverse();
    
    const handleOutline = tracePerimeter(handlePaths.map(p => ({ ...p, tag: 'CUT' as const })));
    handleOutline.reverse();

    // ================================================================
    // CUT — Lỗ quai xách YKNM
    //   oval = bo tròn góc Y,K | roundRect = góc vuông
    // ================================================================
    if (holeShape === 'oval') {
        const rH = snap(Math.min(holeW * 0.3, holeH * 0.4));
        const kLenH = snap(rH * kappa);

        const y1 = pt(_Y.x, snap(_Y.y - rH));
        const y2 = pt(snap(_Y.x + rH), _Y.y);
        const k1 = pt(snap(_K.x - rH), _K.y);
        const k2 = pt(_K.x, snap(_K.y - rH));

        const s1 = line(_M, y1, 'CUT');
        const s2 = bezierSegment(y1,
            pt(y1.x, snap(y1.y + kLenH)),
            pt(snap(y2.x - kLenH), y2.y),
            y2, 'CUT');
        const s3 = line(y2, k1, 'CUT');
        const s4 = bezierSegment(k1,
            pt(snap(k1.x + kLenH), k1.y),
            pt(k2.x, snap(k2.y + kLenH)),
            k2, 'CUT');
        const s5 = line(k2, _N, 'CUT');
        const s6 = line(_N, _M, 'CUT');
        paths.push(s1, s2, s3, s4, s5, s6);
        holes.push(s1, s2, s3, s4, s5, s6);
    } else {
        // roundRect — Bo tròn 4 góc
        const r = snap(Math.min(holeW / 4, holeH / 4, 5));
        const kLenH = snap(r * kappa);

        const n1 = pt(snap(_N.x), snap(_N.y + r));
        const n2 = pt(snap(_N.x - r), snap(_N.y));
        const m1 = pt(snap(_M.x + r), snap(_M.y));
        const m2 = pt(snap(_M.x), snap(_M.y + r));
        const y1 = pt(snap(_Y.x), snap(_Y.y - r));
        const y2 = pt(snap(_Y.x + r), snap(_Y.y));
        const k1 = pt(snap(_K.x - r), snap(_K.y));
        const k2 = pt(snap(_K.x), snap(_K.y - r));

        const s1 = line(m2, y1, 'CUT'); // Left
        const s2 = bezierSegment(y1,
            pt(y1.x, snap(y1.y + kLenH)),
            pt(snap(y2.x - kLenH), y2.y),
            y2, 'CUT'); // TL Corner

        const s3 = line(y2, k1, 'CUT'); // Top
        const s4 = bezierSegment(k1,
            pt(snap(k1.x + kLenH), k1.y),
            pt(k2.x, snap(k2.y + kLenH)),
            k2, 'CUT'); // TR Corner

        const s5 = line(k2, n1, 'CUT'); // Right
        const s6 = bezierSegment(n1,
            pt(n1.x, snap(n1.y - kLenH)),
            pt(snap(n2.x + kLenH), n2.y),
            n2, 'CUT'); // BR Corner

        const s7 = line(n2, m1, 'CUT'); // Bottom
        const s8 = bezierSegment(m1,
            pt(snap(m1.x - kLenH), m1.y),
            pt(m2.x, snap(m2.y - kLenH)),
            m2, 'CUT'); // BL Corner
            
        paths.push(s1, s2, s3, s4, s5, s6, s7, s8);
        holes.push(s1, s2, s3, s4, s5, s6, s7, s8);
    }

    return { paths, holes, basePaths, handlePaths, baseOutline, handleOutline, annotations };
}

// ============================================================
// Side Flap — Tam giác cân, cao = h1+h2, base = W, bo góc đỉnh
// ============================================================
function buildSideTriFlap(
    xLeft: number, xRight: number,
    yBase: number, sideW: number, panelW: number, dir: 1 | -1,
    overrideH: number = 0, // 0 = auto (h1+h2), >0 = custom, clamp >= slotH+5
    gableStyle: 'flat' | 'pitched' = 'flat',
    slotW: number = 3,
    ratioSLH: number = 85,
    overrideTRW: number = 0,
    overrideHFH: number = 0  // HFH — cao tay cầm (bám theo buildGablePanel để rãnh khớp ngàm)
): { paths: PathSegment[], holes: PathSegment[], annotations: any[] } {

    const paths: PathSegment[] = [];
    const holes: PathSegment[] = [];
    const annotations: any[] = [];
    
    const h1 = snap(gableStyle === 'pitched' ? sideW / Math.sqrt(3) : sideW / 2);
    const h2 = snap(overrideHFH > 0 ? overrideHFH : 0.9 * h1);  // bám theo HFH như buildGablePanel
    const defaultH = snap(h1 + h2);

    const gableFold = gableStyle === 'pitched' ? 60 : 90;
    const insetA = snap(gableStyle === 'pitched' ? (panelW - 5 / 6 * panelW) / 2 : 0);
    const rectH = snap((ratioSLH / 100) * h2);

    const Z_height = h1 * Math.cos(gableFold * Math.PI / 180);

    // --- Vị trí rãnh khoá khớp với ngàm mái chính khi gập (đo từ mô hình 3D) ---
    // Khi đóng hộp, ngàm mái chính (A=chân ngàm, P=khóe) chiếu xuống đúng đường
    // tâm (xMid) của mái phụ. Chân ngàm A rơi cách đáy mái phụ một đoạn:
    //   slotOffset = √(insetA² + Z_height²)
    // và khóe P cách A một đoạn (chiều dài ngàm trên cạnh xiên):
    //   slotLen = (rectH - r)·√(1 + (insetA/h1)²)
    // ⇒ rãnh phải nằm trong [yBase+slotOffset, yBase+slotOffset+slotLen].
    const pitched = gableStyle === 'pitched';
    const slopeInv = h1 > 0 ? insetA / h1 : 0;
    const trw = snap(overrideTRW > 0 ? overrideTRW : panelW / 9);
    const rLock = snap(Math.min(trw / 2, rectH));
    const slotOffset = pitched ? snap(Math.sqrt(insetA * insetA + Z_height * Z_height)) : 0;
    // Pitched: chiều dài rãnh = khóe A→P dọc cạnh xiên. Flat: = khoảng cách khóe A→P
    // của ngàm = √(TRW² + (rectH−r)²) (kết hợp với góc gập atan(TRW/(rectH−r)) ở generateGableBox
    // → đỉnh rãnh trùng P, chân rãnh trùng A).
    const slotLen = pitched
        ? snap((rectH - rLock) * Math.sqrt(1 + slopeInv * slopeInv))
        : snap(Math.sqrt(trw * trw + (rectH - rLock) * (rectH - rLock)));

    // Mái phụ chỉ cần đủ cao để CHỨA trọn rãnh khóa (tới khóe P) + biên 15mm.
    // KHÔNG kéo cao tới đỉnh nắp E: vì cạnh nắp gấp khúc tại A (đoạn EP của tay
    // cầm gập lên theo mặt phẳng khác với mái dốc DA), nếu mái phụ cao tới E thì
    // đoạn EP sẽ đâm xuyên qua mái phụ.
    const minH = snap(slotOffset + slotLen + 15);
    // Pitched: phủ tới đỉnh dốc (h1+h2). Flat: chỉ cao bằng chiều cao khóa (minH) —
    // nếu dùng h1+h2 thì mái phụ cao vống lên quá ngàm (không khớp).
    const flapDefault = pitched ? defaultH : minH;
    const triH = snap(Math.max(overrideH > 0 ? overrideH : flapDefault, minH));
    const xMid = snap((xLeft + xRight) / 2);
    const yTip = snap(yBase + dir * triH);

    // Bo tròn đỉnh
    const halfBase = (xRight - xLeft) / 2;
    const sideLen = Math.sqrt(halfBase * halfBase + triH * triH);
    const tipR = snap(Math.min(panelW * 0.40, triH * 0.30));
    const kappa = 4 * (Math.sqrt(2) - 1) / 3;
    const kLenT = snap(tipR * kappa);

    const uLx = (xLeft - xMid) / sideLen;
    const uLy = (dir * (yBase - yTip)) / sideLen;
    const uRx = (xRight - xMid) / sideLen;
    const uRy = (dir * (yBase - yTip)) / sideLen;

    const tL = pt(snap(xMid + uLx * tipR), snap(yTip + uLy * tipR));
    const tR = pt(snap(xMid + uRx * tipR), snap(yTip + uRy * tipR));

    paths.push(line(pt(xLeft, yBase), tL, 'CUT'));
    paths.push(bezierSegment(tL,
        pt(snap(tL.x - uLx * kLenT), snap(tL.y - uLy * kLenT)),
        pt(snap(tR.x - uRx * kLenT), snap(tR.y - uRy * kLenT)),
        tR, 'CUT'));
    paths.push(line(tR, pt(xRight, yBase), 'CUT'));

    // === Rãnh gài (lock slot) — đặt khớp ngàm mái chính ===
    const slotR = snap(slotW / 2);
    const slotKLen = snap(slotR * kappa);

    // Chân rãnh cách đáy mái phụ slotOffset; rãnh dài slotLen (A→P).
    const sBaseY = snap(yBase + dir * slotOffset);
    const sL = pt(snap(xMid - slotW / 2), sBaseY);
    const sR = pt(snap(xMid + slotW / 2), sBaseY);
    const sTopY = snap(sBaseY + dir * slotLen);
    const sTopL = pt(sL.x, snap(sTopY - dir * slotR));
    const sTopR = pt(sR.x, snap(sTopY - dir * slotR));
    const sArcTop = pt(xMid, sTopY);

    // Vẽ rãnh hình chữ U bo đỉnh (khép kín đáy):
    const s1 = line(sL, sTopL, 'CUT');
    const s2 = bezierSegment(sTopL,
        pt(sTopL.x, snap(sTopL.y + dir * slotKLen)),
        pt(snap(sArcTop.x - slotKLen), sArcTop.y),
        sArcTop, 'CUT');
    const s3 = bezierSegment(sArcTop,
        pt(snap(sArcTop.x + slotKLen), sArcTop.y),
        pt(sTopR.x, snap(sTopR.y + dir * slotKLen)),
        sTopR, 'CUT');
    const s4 = line(sTopR, sR, 'CUT');
    const s5 = line(sR, sL, 'CUT'); // Khép đáy rãnh

    // Add to holes so 3D engine cuts it out
    holes.push(s1, s2, s3, s4, s5);

    annotations.push({ point: pt(xMid, sBaseY), text: 'Chân rãnh (= chân ngàm A)', anchor: 'middle', baseline: 'hanging' });
    annotations.push({ point: pt(xMid, sTopY), text: 'Đỉnh rãnh (= khóe ngàm P)', anchor: 'middle', baseline: 'bottom' });

    return { paths, holes, annotations };
}
