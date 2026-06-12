// ============================================================
// Túi Giấy SOS — Paper Bag (Side-Opening-Side)
// Loại túi giấy phổ biến nhất: cửa hàng, F&B, quà tặng.
//
// Layout trải phẳng — hỗ trợ glueSide + panelOrder:
//
//  glueSide='left', panelOrder='WLWL':
//    G | W | L | W | L
//
//  glueSide='right', panelOrder='WLWL':
//    W | L | W | L | G
//
//  panelOrder='LWLW' → đổi L↔W
//
// Gốc tọa độ (0,0) = góc dưới-trái đáy panel đầu tiên.
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
} from './utils';

import {
    GLUE_TAPER_RATIO,
    HANDLE_HOLE_RADIUS,
    HANDLE_HOLE_MARGIN,
} from './constants';

// ─── Helper: Vẽ hình tròn (polyline xấp xỉ) ────────────
function circleArcs(cx: number, cy: number, r: number, tag: 'CUT' | 'CREASE'): PathSegment[] {
    const segs: PathSegment[] = [];
    const N = 32;
    const pts: Point2D[] = [];
    for (let i = 0; i <= N; i++) {
        const angle = (2 * Math.PI * i) / N;
        pts.push(pt(snap(cx + r * Math.cos(angle)), snap(cy + r * Math.sin(angle))));
    }
    for (let i = 0; i < N; i++) {
        segs.push(line(pts[i], pts[i + 1], tag));
    }
    return segs;
}

// ─── Panel definition ────────────────────────────────────
interface PanelDef {
    type: 'glue' | 'side' | 'face';
    width: number;
    name: string;
    label: string;
}

/** Build panel sequence based on glueSide + panelOrder */
function buildSequence(
    glueSide: 'left' | 'right',
    panelOrder: 'WLWL' | 'LWLW',
    G: number, W: number, L: number
): PanelDef[] {
    const mainPanels: PanelDef[] = panelOrder === 'WLWL'
        ? [
            { type: 'side', width: W, name: 'side1', label: 'Hông 1' },
            { type: 'face', width: L, name: 'front', label: 'Mặt trước' },
            { type: 'side', width: W, name: 'side2', label: 'Hông 2' },
            { type: 'face', width: L, name: 'back', label: 'Mặt sau' },
        ]
        : [
            { type: 'face', width: L, name: 'front', label: 'Mặt trước' },
            { type: 'side', width: W, name: 'side1', label: 'Hông 1' },
            { type: 'face', width: L, name: 'back', label: 'Mặt sau' },
            { type: 'side', width: W, name: 'side2', label: 'Hông 2' },
        ];

    const glueDef: PanelDef = { type: 'glue', width: G, name: 'glue_flap', label: 'Mí dán' };

    return glueSide === 'left'
        ? [glueDef, ...mainPanels]
        : [...mainPanels, glueDef];
}

/**
 * Sinh bản vẽ khuôn bế Túi Giấy SOS từ thông số đầu vào.
 */
export function generatePaperBag(params: BoxParams): DielineModel {
    const { L, W, D, G, glueSide, panelOrder } = params;

    // Resolved auto-params
    const bottomH = params.BF > 0 ? params.BF : snap(W * 0.85);
    const topFold = params.TH > 0 ? params.TH : 0;
    const HR = params.HR > 0 ? params.HR : HANDLE_HOLE_RADIUS;
    const HM = params.HM > 0 ? params.HM : HANDLE_HOLE_MARGIN;
    const HS = params.HS > 0 ? params.HS : snap(L * 0.35);
    const showHandleHoles = params.handleHoles;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // A. Build panel sequence & compute X coordinates
    // ============================================================
    const seq = buildSequence(glueSide, panelOrder, G, W, L);
    const xs: number[] = [0];
    for (const p of seq) {
        xs.push(snap(xs[xs.length - 1] + p.width));
    }
    const xTotal = xs[xs.length - 1]; // Mép phải ngoài cùng

    // Find panel indices by type
    const glueIdx = seq.findIndex(p => p.type === 'glue');
    const sideIndices = seq.map((p, i) => p.type === 'side' ? i : -1).filter(i => i >= 0);
    const faceIndices = seq.map((p, i) => p.type === 'face' ? i : -1).filter(i => i >= 0);

    // ============================================================
    // B. Tọa độ Y — 3 vùng: Đáy | Thân | Nắp
    // ============================================================
    const yBotFlap = 0;
    const yBody = snap(bottomH);
    const yTop = snap(bottomH + D);
    const yTopFold = snap(bottomH + D + topFold);

    // ============================================================
    // C. VẼ THÂN TÚI — từ panel sequence
    // ============================================================
    const glueVat = snap(G * GLUE_TAPER_RATIO);
    const glueIsLeft = glueSide === 'left';

    for (let i = 0; i < seq.length; i++) {
        const p = seq[i];
        const xL = xs[i];
        const xR = xs[i + 1];

        if (p.type === 'glue') {
            // --- Glue Flap — kéo dài toàn bộ từ đáy đến nắp ---
            const gluePaths: PathSegment[] = [];
            if (glueIsLeft) {
                // Glue bên trái: vát hướng trái
                gluePaths.push(line(pt(xL, yBotFlap + glueVat), pt(xL, yTopFold - glueVat), 'CUT'));
                gluePaths.push(line(pt(xL, yTopFold - glueVat), pt(xR, yTopFold), 'CUT'));
                gluePaths.push(line(pt(xR, yBotFlap), pt(xL, yBotFlap + glueVat), 'CUT'));
            } else {
                // Glue bên phải: vát hướng phải
                gluePaths.push(line(pt(xR, yBotFlap + glueVat), pt(xR, yTopFold - glueVat), 'CUT'));
                gluePaths.push(line(pt(xR, yTopFold - glueVat), pt(xL, yTopFold), 'CUT'));
                gluePaths.push(line(pt(xL, yBotFlap), pt(xR, yBotFlap + glueVat), 'CUT'));
            }
            allPaths.push(...gluePaths);
            // Crease biên glue ↔ panel kề
            allPaths.push(line(pt(glueIsLeft ? xR : xL, yBotFlap), pt(glueIsLeft ? xR : xL, yTopFold), 'CREASE'));
            // Crease ngang tại giao nắp/đáy với mí dán
            if (topFold > 0) {
                allPaths.push(line(pt(xL, yTop), pt(xR, yTop), 'CREASE'));    // Giao nắp - mí dán
            }
            allPaths.push(line(pt(xL, yBody), pt(xR, yBody), 'CREASE')); // Giao đáy - mí dán
            panels.push({
                name: p.name, label: p.label, paths: gluePaths,
                outline: glueIsLeft ? [
                    pt(xL, yBotFlap + glueVat), pt(xR, yBotFlap), pt(xR, topFold > 0 ? yTopFold : yTop), pt(xL, topFold > 0 ? yTopFold - glueVat : yTop - glueVat)
                ] : [
                    pt(xL, yBotFlap), pt(xR, yBotFlap + glueVat), pt(xR, topFold > 0 ? yTopFold - glueVat : yTop - glueVat), pt(xL, topFold > 0 ? yTopFold : yTop)
                ],
                parent: glueIsLeft ? seq[i + 1]?.name ?? null : seq[i - 1]?.name ?? null,
                pivotEdge: [pt(glueIsLeft ? xR : xL, yBotFlap), pt(glueIsLeft ? xR : xL, yTopFold)],
                foldAngle: glueIsLeft ? 90 : -90,
                foldDirection: glueIsLeft ? 1 : -1,
            });
        } else {
            // --- Side hoặc Face panel ---
            const isLastPanel = i === seq.length - 1;
            const isFirstNonGlue = (glueIsLeft && i === 1) || (!glueIsLeft && i === 0);

            const bodyPaths: PathSegment[] = [
                line(pt(xL, yBody), pt(xR, yBody), 'CREASE'),
                line(pt(xR, yBody), pt(xR, yTop), isLastPanel ? 'CUT' : 'CREASE'),
            ];
            // Chỉ vẽ CREASE tại yTop nếu có mí gập
            if (topFold > 0) {
                bodyPaths.push(line(pt(xR, yTop), pt(xL, yTop), 'CREASE'));
            }
            // Cạnh trái CUT nếu là panel đầu tiên (không có glue bên trái)
            if (isFirstNonGlue && !glueIsLeft) {
                bodyPaths.push(line(pt(xL, yBody), pt(xL, yTop), 'CUT'));
            }
            allPaths.push(...bodyPaths);

            // Determine parent & pivot
            let parent: string | null = null;
            let pivotEdge: [Point2D, Point2D] | null = null;
            let foldAngle = 0;
            let foldDir: 1 | -1 = 1;

            if (i === (glueIsLeft ? 2 : 1)) {
                // ROOT panel (2nd main panel = first face in WLWL)
                parent = null;
                pivotEdge = null;
            } else if (i < (glueIsLeft ? 2 : 1)) {
                parent = seq[i + 1]?.name ?? null;
                pivotEdge = [pt(xR, yBody), pt(xR, yTop)];
                foldAngle = 90;
                foldDir = 1;
            } else {
                parent = seq[i - 1]?.name ?? null;
                pivotEdge = [pt(xL, yBody), pt(xL, yTop)];
                foldAngle = -90;
                foldDir = -1;
            }

            panels.push({
                name: p.name, label: p.label, paths: bodyPaths,
                outline: [
                    pt(xL, yBotFlap), pt(xR, yBotFlap), pt(xR, topFold > 0 ? yTopFold : yTop), pt(xL, topFold > 0 ? yTopFold : yTop)
                ],
                parent, pivotEdge, foldAngle, foldDirection: foldDir,
            });
        }
    }

    // ============================================================
    // D. MÍ GẤP MIỆNG — custom hoặc 0 = ko gập
    // ============================================================
    const topLeft = glueIsLeft ? xs[1] : xs[0];
    const topRight = glueIsLeft ? xs[seq.length] : xs[seq.length - 1];

    if (topFold > 0) {
        // Có mí gập: crease tại yTop, HCN mí gập phía trên
        allPaths.push(line(pt(0, yTop), pt(xTotal, yTop), 'CREASE'));  // Đường gấp miệng
        allPaths.push(line(pt(topLeft, yTopFold), pt(topRight, yTopFold), 'CUT'));  // Cạnh trên
        if (glueIsLeft) {
            allPaths.push(line(pt(topRight, yTop), pt(topRight, yTopFold), 'CUT'));
        } else {
            allPaths.push(line(pt(topLeft, yTop), pt(topLeft, yTopFold), 'CUT'));
        }
        // Crease dọc kéo lên nắp
        for (let i = 1; i < seq.length; i++) {
            if (i === glueIdx || i === glueIdx + 1) continue;
            allPaths.push(line(pt(xs[i], yTop), pt(xs[i], yTopFold), 'CREASE'));
        }
    } else {
        // Ko gập (TH=0): yTop = cạnh trên CUT, ko có mí gập
        allPaths.push(line(pt(topLeft, yTop), pt(topRight, yTop), 'CUT'));  // Cạnh trên = CUT
    }

    // ============================================================
    // E. ĐÁY TÚI — HCN cao = 85% × W
    // ============================================================
    const botLeft = topLeft;
    const botRight = topRight;

    allPaths.push(line(pt(0, yBody), pt(xTotal, yBody), 'CREASE'));     // Đường gấp đáy
    allPaths.push(line(pt(botLeft, yBotFlap), pt(botRight, yBotFlap), 'CUT'));  // Cạnh dưới
    if (glueIsLeft) {
        allPaths.push(line(pt(botRight, yBody), pt(botRight, yBotFlap), 'CUT'));    // Cạnh phải (CUT vì ko có glue)
    } else {
        allPaths.push(line(pt(botLeft, yBody), pt(botLeft, yBotFlap), 'CUT'));      // Cạnh trái (CUT vì ko có glue)
    }

    // Crease dọc kéo xuống đáy
    for (let i = 1; i < seq.length; i++) {
        if (i === glueIdx || i === glueIdx + 1) continue;
        allPaths.push(line(pt(xs[i], yBody), pt(xs[i], yBotFlap), 'CREASE'));
    }

    // ============================================================
    // F. ĐƯỜNG NHẤN DỌC GIỮA HÔNG + ĐƯỜNG CHÉO 45°
    //
    // Đường chéo bắt đầu tại (mid, yBody + W/2) trên center crease,
    // ĐI QUA giao điểm mặt chính / hông tại yBody,
    // kết thúc tại yBotFlap hoặc mép ngoài mí dán (clamp).
    // ============================================================
    const halfW = snap(W / 2);
    const diagStartY = snap(yBody + halfW);

    for (const si of sideIndices) {
        const sxL = xs[si];
        const mid = snap(sxL + W / 2);

        // Đường nhấn dọc giữa hông (kéo từ nắp → đáy)
        allPaths.push(line(pt(mid, yTopFold), pt(mid, yBotFlap), 'CREASE'));

        // --- Đường chéo 45° bên trái ---
        // Từ (mid, diagStartY) → qua (sxL, yBody) → đến yBotFlap
        // Clamp tại x=0 (mép ngoài mí dán)
        const rawLeftX = snap(mid - (diagStartY - yBotFlap));
        const clampedLeftX = Math.max(0, rawLeftX);
        const clampedLeftY = snap(diagStartY - (mid - clampedLeftX));
        allPaths.push(line(pt(mid, diagStartY), pt(clampedLeftX, clampedLeftY), 'CREASE'));

        // --- Đường chéo 45° bên phải ---
        // Từ (mid, diagStartY) → qua (sxR, yBody) → đến yBotFlap
        // Clamp tại xTotal (mép ngoài cùng)
        const rawRightX = snap(mid + (diagStartY - yBotFlap));
        const clampedRightX = Math.min(xTotal, rawRightX);
        const clampedRightY = snap(diagStartY - (clampedRightX - mid));
        allPaths.push(line(pt(mid, diagStartY), pt(clampedRightX, clampedRightY), 'CREASE'));
    }

    // --- Đường nhấn ngang nối 2 điểm bắt đầu đường chéo ---
    // KHÔNG đi qua mặt chính nằm trực tiếp giữa 2 hông.
    // Đi hướng ngược lại → qua mặt chính chỉ giáp 1 hông.
    // Trên dieline phẳng = 2 đoạn: mid1→mép trái, mid2→mép phải.
    if (sideIndices.length === 2) {
        const mid1 = snap(xs[sideIndices[0]] + W / 2);
        const mid2 = snap(xs[sideIndices[1]] + W / 2);
        const [mLeft, mRight] = mid1 < mid2 ? [mid1, mid2] : [mid2, mid1];
        // Đoạn trái: từ mid gần mép trái → mép trái (x=0)
        allPaths.push(line(pt(mLeft, diagStartY), pt(0, diagStartY), 'CREASE'));
        // Đoạn phải: từ mid gần mép phải → mép phải (xTotal)
        allPaths.push(line(pt(mRight, diagStartY), pt(xTotal, diagStartY), 'CREASE'));
    }

    // --- Đường chéo mép ngoài — mặt chính ko giáp hông ---
    // Đi QUA giao điểm mặt-đáy, kéo lên vào thân (giống hông).
    // Nếu bên cạnh là mí dán → kéo tới mép ngoài mí dán.
    for (const fi of faceIndices) {
        const fxL = xs[fi];
        const fxR = xs[fi + 1];

        // Kiểm tra bên trái
        const leftNeighbor = fi > 0 ? seq[fi - 1] : null;
        if (!leftNeighbor || leftNeighbor.type !== 'side') {
            // Mép trái: giao điểm tại (fxL, yBody)
            // Mép ngoài mí dán nếu bên trái là glue
            const outerX = (leftNeighbor?.type === 'glue') ? xs[fi - 1] : fxL;
            // Kéo lên 45° vào thân: từ (outerX, yBody + (fxL - outerX))
            const upperY = snap(yBody + (fxL - outerX));
            // Kéo xuống 45° vào đáy: từ (fxL, yBody) đi xuống-phải
            const lowerX = snap(fxL + bottomH);
            allPaths.push(line(pt(outerX, upperY), pt(lowerX, yBotFlap), 'CREASE'));
        }

        // Kiểm tra bên phải
        const rightNeighbor = fi < seq.length - 1 ? seq[fi + 1] : null;
        if (!rightNeighbor || rightNeighbor.type !== 'side') {
            // Mép phải: giao điểm tại (fxR, yBody)
            const outerX = (rightNeighbor?.type === 'glue') ? xs[fi + 2] : fxR;
            // Kéo lên 45° vào thân: từ (outerX, yBody + (outerX - fxR))
            const upperY = snap(yBody + (outerX - fxR));
            // Kéo xuống 45° vào đáy: từ (fxR, yBody) đi xuống-trái
            const lowerX = snap(fxR - bottomH);
            allPaths.push(line(pt(outerX, upperY), pt(lowerX, yBotFlap), 'CREASE'));
        }
    }

    // ============================================================
    // G. LỖ XỎ DÂY QUAI (Handle Holes) — trên các mặt chính
    // ============================================================
    if (showHandleHoles) {
        const holeY = snap(yTop - HM);

        for (const fi of faceIndices) {
            const fxL = xs[fi];
            const faceCx = snap(fxL + L / 2);
            const holeL = circleArcs(snap(faceCx - HS / 2), holeY, HR, 'CUT');
            const holeR = circleArcs(snap(faceCx + HS / 2), holeY, HR, 'CUT');
            allPaths.push(...holeL, ...holeR);

            // --- Lỗ đối xứng trên mí gập miệng ---
            // Khi gập, lỗ trên mí gập phải trùng với lỗ trên thân.
            // Vị trí đối xứng qua yTop: mirrorY = yTop + HM
            // Chỉ vẽ nếu: topFold > 0 VÀ lỗ nằm trong mí gập (HM + HR <= topFold - 5)
            if (topFold > 0 && (HM + HR) <= (topFold - 5)) {
                const mirrorY = snap(yTop + HM);
                const mirrorL = circleArcs(snap(faceCx - HS / 2), mirrorY, HR, 'CUT');
                const mirrorR = circleArcs(snap(faceCx + HS / 2), mirrorY, HR, 'CUT');
                allPaths.push(...mirrorL, ...mirrorR);
            }
        }
    }

    // ============================================================
    // H. Tính Bounding Box & Trả về mô hình
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Paper Bag SOS',
        standardCode: 'SOS-STANDARD',
        description: 'Túi giấy SOS — Cửa hàng, F&B, Quà tặng',
        panels,
        allPaths,
        boundingBox: bb,
        params,
    };
}
