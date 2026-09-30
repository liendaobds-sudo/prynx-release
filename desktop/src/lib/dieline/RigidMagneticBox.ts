// ============================================================
// PRYNX-RMB-01 — Hộp Cứng Nam Châm Carton Lạnh (Rigid Magnetic Box)
//
// Kết cấu hộp cao cấp gồm 2 cụm chi tiết:
//   1. Khay lọt lòng (Inner Tray): Thân carton chữ thập, 4 góc phay
//      rãnh chữ V dựng đứng 90°, vách trước có lỗ âm nam châm/đĩa từ.
//   2. Bìa sách ngoài (Magnetic Book Cover): Gồm 4 tấm carton
//      [Tai nam châm ─ Nắp trên ─ Gáy ─ Đáy bìa] dán liền trên
//      giấy áo bồi ngoài, tai nam châm khoét lỗ âm đón nam châm.
//
// Bản vẽ 2D trải phẳng bố trí 2 cụm cạnh nhau:
//   - Trái: Khay lọt lòng (x: 0 → 2D+L, y: 0 → 2D+W)
//   - Phải: Bìa ngoài (x: coverOx → coverOx+BL, y: coverOy → coverOy+H)
//
// 3D: Khay đứng yên trên sàn; Bìa dán dưới đáy khay, gáy gập 90°
// dựng sau khay, nắp trên gập 90° đậy miệng khay, tai gài gập 90°
// chụp xuống vách trước hít nam châm (foldPhase 0.85 → 0.98).
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
    arcToBezier,
    computeBoundingBox,
} from './utils';

import {
    RMB_DEFAULT_LIP_MM,
    RMB_DEFAULT_TURN_IN_MM,
    RMB_SPINE_GAP_RATIO,
    RMB_SPINE_GAP_BASE_MM,
    RMB_MAGNET_DEFAULT_D_MM,
    RMB_MAGNET_DEFAULT_OFFSET_MM,
    RMB_AUTO_MAGNET_L_THRESHOLD,
    RMB_DISPLAY_GAP,
} from './constants';

/** Tạo vòng tròn khép kín từ 4 cung Bezier 90° */
function createCircleSegments(cx: number, cy: number, r: number, tag: 'CUT' | 'CREASE' = 'CUT'): PathSegment[] {
    return [
        arcToBezier(cx, cy, r, 0, 90, tag),
        arcToBezier(cx, cy, r, 90, 180, tag),
        arcToBezier(cx, cy, r, 180, 270, tag),
        arcToBezier(cx, cy, r, 270, 360, tag),
    ];
}

/** Chuyển các đoạn cung/bezier thành mảng điểm polygon xấp xỉ cho Panel.holes */
function circleToHolePolygon(cx: number, cy: number, r: number, steps = 16): Point2D[] {
    const points: Point2D[] = [];
    for (let i = 0; i < steps; i++) {
        const rad = (i / steps) * Math.PI * 2;
        points.push(pt(cx + r * Math.cos(rad), cy + r * Math.sin(rad)));
    }
    return points;
}

/**
 * Sinh mô hình khuôn bế Hộp Cứng Nam Châm Carton Lạnh
 */
export function generateRigidMagneticBox(params: BoxParams): DielineModel {
    const { L, W, D, T } = params;

    const lip = params.rigidLip > 0 ? snap(params.rigidLip) : RMB_DEFAULT_LIP_MM;
    const turnIn = params.rigidTurnIn > 0 ? snap(params.rigidTurnIn) : RMB_DEFAULT_TURN_IN_MM;
    const flapH = params.rigidFlapH > 0
        ? snap(params.rigidFlapH)
        : snap(Math.min(50, Math.max(25, D * 0.6)));
    const magnetD = params.rigidMagnetD > 0 ? snap(params.rigidMagnetD) : RMB_MAGNET_DEFAULT_D_MM;
    const magnetR = snap(magnetD / 2);
    const magnetOffset = params.rigidMagnetOffset > 0
        ? snap(params.rigidMagnetOffset)
        : RMB_MAGNET_DEFAULT_OFFSET_MM;
    const magnetCount = params.rigidMagnetCount > 0
        ? params.rigidMagnetCount
        : (L >= RMB_AUTO_MAGNET_L_THRESHOLD ? 2 : 1);

    const spineGap = snap(T * RMB_SPINE_GAP_RATIO + RMB_SPINE_GAP_BASE_MM);

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ============================================================
    // PHẦN 1: KHAY LỌT LÒNG (INNER TRAY)
    // Tọa độ đặt: đáy khay tại [D, D] → [D+L, D+W]
    // ============================================================
    const xTrayL = snap(D);
    const xTrayR = snap(D + L);
    const yTrayBot = snap(D);
    const yTrayTop = snap(D + W);

    // 4 đường nếp phay rãnh chữ V quanh đáy khay (CREASE)
    const creaseTrayFront = line(pt(xTrayL, yTrayBot), pt(xTrayR, yTrayBot), 'CREASE');
    const creaseTrayRight = line(pt(xTrayR, yTrayBot), pt(xTrayR, yTrayTop), 'CREASE');
    const creaseTrayBack = line(pt(xTrayR, yTrayTop), pt(xTrayL, yTrayTop), 'CREASE');
    const creaseTrayLeft = line(pt(xTrayL, yTrayTop), pt(xTrayL, yTrayBot), 'CREASE');
    allPaths.push(creaseTrayFront, creaseTrayRight, creaseTrayBack, creaseTrayLeft);

    // Đáy khay (tray_bottom) — panel gốc của khay
    panels.push({
        name: 'tray_bottom',
        label: 'Đáy khay trong',
        paths: [creaseTrayFront, creaseTrayRight, creaseTrayBack, creaseTrayLeft],
        outline: [pt(xTrayL, yTrayBot), pt(xTrayR, yTrayBot), pt(xTrayR, yTrayTop), pt(xTrayL, yTrayTop)],
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
        annotations: [
            {
                point: pt((xTrayL + xTrayR) / 2, (yTrayBot + yTrayTop) / 2),
                text: `Khay trong: ${L} × ${W} × ${D} mm`,
                anchor: 'middle',
                baseline: 'middle',
            },
        ],
    });

    // Vách trước khay (tray_front): gập lên 90° quanh creaseTrayFront
    const cutTF1 = line(pt(xTrayL, yTrayBot), pt(xTrayL, 0), 'CUT');
    const cutTF2 = line(pt(xTrayL, 0), pt(xTrayR, 0), 'CUT');
    const cutTF3 = line(pt(xTrayR, 0), pt(xTrayR, yTrayBot), 'CUT');
    allPaths.push(cutTF1, cutTF2, cutTF3);

    // Lỗ khoét nam châm trên vách trước khay
    const tfMagnetCY = snap(yTrayBot - magnetOffset);
    const tfMagnetHoles: Point2D[][] = [];
    const tfMagnetCXs = magnetCount === 1
        ? [snap((xTrayL + xTrayR) / 2)]
        : [snap(xTrayL + L / 4), snap(xTrayR - L / 4)];

    for (const cx of tfMagnetCXs) {
        const circ = createCircleSegments(cx, tfMagnetCY, magnetR, 'CUT');
        allPaths.push(...circ);
        tfMagnetHoles.push(circleToHolePolygon(cx, tfMagnetCY, magnetR));
    }

    panels.push({
        name: 'tray_front',
        label: 'Vách trước khay',
        paths: [creaseTrayFront, cutTF3, cutTF2, cutTF1],
        outline: [pt(xTrayL, yTrayBot), pt(xTrayR, yTrayBot), pt(xTrayR, 0), pt(xTrayL, 0)],
        holes: tfMagnetHoles.length > 0 ? tfMagnetHoles : undefined,
        parent: 'tray_bottom',
        pivotEdge: [pt(xTrayL, yTrayBot), pt(xTrayR, yTrayBot)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.05, 0.35],
    });

    // Vách phải khay (tray_right): gập lên 90° quanh creaseTrayRight
    const cutTR1 = line(pt(xTrayR, yTrayBot), pt(snap(xTrayR + D), yTrayBot), 'CUT');
    const cutTR2 = line(pt(snap(xTrayR + D), yTrayBot), pt(snap(xTrayR + D), yTrayTop), 'CUT');
    const cutTR3 = line(pt(snap(xTrayR + D), yTrayTop), pt(xTrayR, yTrayTop), 'CUT');
    allPaths.push(cutTR1, cutTR2, cutTR3);

    panels.push({
        name: 'tray_right',
        label: 'Vách phải khay',
        paths: [creaseTrayRight, cutTR3, cutTR2, cutTR1],
        outline: [pt(xTrayR, yTrayBot), pt(snap(xTrayR + D), yTrayBot), pt(snap(xTrayR + D), yTrayTop), pt(xTrayR, yTrayTop)],
        parent: 'tray_bottom',
        pivotEdge: [pt(xTrayR, yTrayBot), pt(xTrayR, yTrayTop)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.05, 0.35],
    });

    // Vách sau khay (tray_back): gập lên 90° quanh creaseTrayBack
    const cutTB1 = line(pt(xTrayR, yTrayTop), pt(xTrayR, snap(yTrayTop + D)), 'CUT');
    const cutTB2 = line(pt(xTrayR, snap(yTrayTop + D)), pt(xTrayL, snap(yTrayTop + D)), 'CUT');
    const cutTB3 = line(pt(xTrayL, snap(yTrayTop + D)), pt(xTrayL, yTrayTop), 'CUT');
    allPaths.push(cutTB1, cutTB2, cutTB3);

    panels.push({
        name: 'tray_back',
        label: 'Vách sau khay',
        paths: [creaseTrayBack, cutTB3, cutTB2, cutTB1],
        outline: [pt(xTrayR, yTrayTop), pt(xTrayR, snap(yTrayTop + D)), pt(xTrayL, snap(yTrayTop + D)), pt(xTrayL, yTrayTop)],
        parent: 'tray_bottom',
        pivotEdge: [pt(xTrayR, yTrayTop), pt(xTrayL, yTrayTop)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.05, 0.35],
    });

    // Vách trái khay (tray_left): gập lên 90° quanh creaseTrayLeft
    const cutTL1 = line(pt(xTrayL, yTrayTop), pt(0, yTrayTop), 'CUT');
    const cutTL2 = line(pt(0, yTrayTop), pt(0, yTrayBot), 'CUT');
    const cutTL3 = line(pt(0, yTrayBot), pt(xTrayL, yTrayBot), 'CUT');
    allPaths.push(cutTL1, cutTL2, cutTL3);

    panels.push({
        name: 'tray_left',
        label: 'Vách trái khay',
        paths: [creaseTrayLeft, cutTL3, cutTL2, cutTL1],
        outline: [pt(xTrayL, yTrayTop), pt(0, yTrayTop), pt(0, yTrayBot), pt(xTrayL, yTrayBot)],
        parent: 'tray_bottom',
        pivotEdge: [pt(xTrayL, yTrayTop), pt(xTrayL, yTrayBot)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.05, 0.35],
    });

    // ============================================================
    // PHẦN 2: BÌA SÁCH NGOÀI (MAGNETIC BOOK COVER)
    // Chiều rộng bìa: BL = L + 2*lip
    // Chiều rộng các mặt nắp & đáy: BW = W + 2*lip
    // Chiều cao gáy sách: SH = D + 2*T + 1
    // ============================================================
    const coverBL = snap(L + 2 * lip);
    const coverBW = snap(W + 2 * lip);
    const spineH = snap(D + 2 * T + 1);

    const coverOx = snap(xTrayR + D + RMB_DISPLAY_GAP);
    const coverX0 = coverOx;
    const coverX1 = snap(coverOx + coverBL);

    // Bố trí dọc theo trục Y, căn giữa theo trục Y của khay:
    // Thứ tự từ dưới lên: [Tai nam châm (flap)] → [Nắp trên (top)] → [Gáy (spine)] → [Đáy bìa (bottom)]
    const totalCoverH = snap(flapH + coverBW + spineH + coverBW + 3 * spineGap);
    const trayMidY = snap((yTrayBot + yTrayTop) / 2);
    const coverY0 = snap(trayMidY - totalCoverH / 2);

    const yFlapBot = coverY0;
    const yFlapTop = snap(yFlapBot + flapH);
    const yTopBot = snap(yFlapTop + spineGap);
    const yTopTop = snap(yTopBot + coverBW);
    const ySpineBot = snap(yTopTop + spineGap);
    const ySpineTop = snap(ySpineBot + spineH);
    const yCoverBaseBot = snap(ySpineTop + spineGap);
    const yCoverBaseTop = snap(yCoverBaseBot + coverBW);

    // 1. Tai nam châm (cover_flap)
    const cutFlapBot = line(pt(coverX0, yFlapBot), pt(coverX1, yFlapBot), 'CUT');
    const cutFlapR = line(pt(coverX1, yFlapBot), pt(coverX1, yFlapTop), 'CUT');
    const creaseFlap = line(pt(coverX1, yFlapTop), pt(coverX0, yFlapTop), 'CREASE');
    const cutFlapL = line(pt(coverX0, yFlapTop), pt(coverX0, yFlapBot), 'CUT');
    allPaths.push(cutFlapBot, cutFlapR, creaseFlap, cutFlapL);

    // Lỗ khoét nam châm trên tai nắp bìa
    const flapMagnetCY = snap(yFlapBot + magnetOffset);
    const flapMagnetHoles: Point2D[][] = [];
    const flapMagnetCXs = magnetCount === 1
        ? [snap((coverX0 + coverX1) / 2)]
        : [snap(coverX0 + coverBL / 4), snap(coverX1 - coverBL / 4)];

    for (const cx of flapMagnetCXs) {
        const circ = createCircleSegments(cx, flapMagnetCY, magnetR, 'CUT');
        allPaths.push(...circ);
        flapMagnetHoles.push(circleToHolePolygon(cx, flapMagnetCY, magnetR));
    }

    panels.push({
        name: 'cover_flap',
        label: 'Tai gài nam châm',
        paths: [cutFlapBot, cutFlapR, creaseFlap, cutFlapL],
        outline: [pt(coverX0, yFlapBot), pt(coverX1, yFlapBot), pt(coverX1, yFlapTop), pt(coverX0, yFlapTop)],
        holes: flapMagnetHoles.length > 0 ? flapMagnetHoles : undefined,
        parent: 'cover_top',
        pivotEdge: [pt(coverX0, yTopBot), pt(coverX1, yTopBot)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.85, 0.98],
        annotations: [
            {
                point: pt((coverX0 + coverX1) / 2, (yFlapBot + yFlapTop) / 2),
                text: `Tai nam châm (${magnetCount} lỗ Ø${magnetD}mm)`,
                anchor: 'middle',
                baseline: 'middle',
            },
        ],
    });

    // 2. Nắp trên (cover_top)
    const cutTopR = line(pt(coverX1, yTopBot), pt(coverX1, yTopTop), 'CUT');
    const creaseTop = line(pt(coverX1, yTopTop), pt(coverX0, yTopTop), 'CREASE');
    const cutTopL = line(pt(coverX0, yTopTop), pt(coverX0, yTopBot), 'CUT');
    allPaths.push(cutTopR, creaseTop, cutTopL);

    panels.push({
        name: 'cover_top',
        label: 'Nắp trên bìa',
        paths: [creaseFlap, cutTopR, creaseTop, cutTopL],
        outline: [pt(coverX0, yTopBot), pt(coverX1, yTopBot), pt(coverX1, yTopTop), pt(coverX0, yTopTop)],
        parent: 'cover_spine',
        pivotEdge: [pt(coverX0, ySpineBot), pt(coverX1, ySpineBot)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.65, 0.88],
        annotations: [
            {
                point: pt((coverX0 + coverX1) / 2, (yTopBot + yTopTop) / 2),
                text: 'Nắp trên',
                anchor: 'middle',
                baseline: 'middle',
            },
        ],
    });

    // 3. Gáy sách (cover_spine)
    const cutSpineR = line(pt(coverX1, ySpineBot), pt(coverX1, ySpineTop), 'CUT');
    const creaseSpine = line(pt(coverX1, ySpineTop), pt(coverX0, ySpineTop), 'CREASE');
    const cutSpineL = line(pt(coverX0, ySpineTop), pt(coverX0, ySpineBot), 'CUT');
    allPaths.push(cutSpineR, creaseSpine, cutSpineL);

    panels.push({
        name: 'cover_spine',
        label: 'Gáy bìa',
        paths: [creaseTop, cutSpineR, creaseSpine, cutSpineL],
        outline: [pt(coverX0, ySpineBot), pt(coverX1, ySpineBot), pt(coverX1, ySpineTop), pt(coverX0, ySpineTop)],
        parent: 'cover_bottom',
        pivotEdge: [pt(coverX0, yCoverBaseBot), pt(coverX1, yCoverBaseBot)],
        foldAngle: 90,
        foldDirection: 1,
        foldPhase: [0.45, 0.70],
        annotations: [
            {
                point: pt((coverX0 + coverX1) / 2, (ySpineBot + ySpineTop) / 2),
                text: `Gáy: ${spineH} mm`,
                anchor: 'middle',
                baseline: 'middle',
            },
        ],
    });

    // 4. Đáy bìa ngoài (cover_bottom)
    const cutCoverBaseR = line(pt(coverX1, yCoverBaseBot), pt(coverX1, yCoverBaseTop), 'CUT');
    const cutCoverBaseTop = line(pt(coverX1, yCoverBaseTop), pt(coverX0, yCoverBaseTop), 'CUT');
    const cutCoverBaseL = line(pt(coverX0, yCoverBaseTop), pt(coverX0, yCoverBaseBot), 'CUT');
    allPaths.push(cutCoverBaseR, cutCoverBaseTop, cutCoverBaseL);

    panels.push({
        name: 'cover_bottom',
        label: 'Đáy bìa ngoài',
        paths: [creaseSpine, cutCoverBaseR, cutCoverBaseTop, cutCoverBaseL],
        outline: [pt(coverX0, yCoverBaseBot), pt(coverX1, yCoverBaseBot), pt(coverX1, yCoverBaseTop), pt(coverX0, yCoverBaseTop)],
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
        annotations: [
            {
                point: pt((coverX0 + coverX1) / 2, (yCoverBaseBot + yCoverBaseTop) / 2),
                text: 'Đáy bìa ngoài',
                anchor: 'middle',
                baseline: 'middle',
            },
        ],
    });

    // ============================================================
    // ĐƯỜNG MÔ PHỎNG GIẤY ÁO BỒI NGOÀI (WRAP BLEED CONTOUR)
    // Đường bao quanh bìa có mép bọc turn-in và 4 góc vát 45°
    // ============================================================
    const wrapX0 = snap(coverX0 - turnIn);
    const wrapX1 = snap(coverX1 + turnIn);
    const wrapY0 = snap(coverY0 - turnIn);
    const wrapY1 = snap(yCoverBaseTop + turnIn);
    const chamfer = snap(turnIn * 0.7);

    allPaths.push(
        line(pt(wrapX0 + chamfer, wrapY0), pt(wrapX1 - chamfer, wrapY0), 'BLEED'),
        line(pt(wrapX1 - chamfer, wrapY0), pt(wrapX1, wrapY0 + chamfer), 'BLEED'),
        line(pt(wrapX1, wrapY0 + chamfer), pt(wrapX1, wrapY1 - chamfer), 'BLEED'),
        line(pt(wrapX1, wrapY1 - chamfer), pt(wrapX1 - chamfer, wrapY1), 'BLEED'),
        line(pt(wrapX1 - chamfer, wrapY1), pt(wrapX0 + chamfer, wrapY1), 'BLEED'),
        line(pt(wrapX0 + chamfer, wrapY1), pt(wrapX0, wrapY1 - chamfer), 'BLEED'),
        line(pt(wrapX0, wrapY1 - chamfer), pt(wrapX0, wrapY0 + chamfer), 'BLEED'),
        line(pt(wrapX0, wrapY0 + chamfer), pt(wrapX0 + chamfer, wrapY0), 'BLEED'),
    );

    // ============================================================
    // POSE LẮP RÁP 3D (DIELINE NESTING)
    // Tịnh tiến toàn bộ bìa ngoài đặt khớp dưới đáy khay
    // ============================================================
    const trayCenter = { x: snap((xTrayL + xTrayR) / 2), y: snap((yTrayBot + yTrayTop) / 2) };
    const coverBaseCenter = { x: snap((coverX0 + coverX1) / 2), y: snap((yCoverBaseBot + yCoverBaseTop) / 2) };

    const nesting = {
        x: snap(trayCenter.x - coverBaseCenter.x),
        y: snap(trayCenter.y - coverBaseCenter.y),
        z: snap(-T),
        rotationDeg: { x: 0, y: 0, z: 0 },
        pivot: {
            x: coverBaseCenter.x,
            y: coverBaseCenter.y,
            z: 0,
        },
    };

    return {
        name: 'Hộp cứng nam châm carton lạnh',
        standardCode: 'RIGID-BOOK-MAG',
        description: 'Khay lọt lòng carton lạnh + Bìa gập dạng sách hít nam châm',
        panels,
        allPaths,
        boundingBox: computeBoundingBox(allPaths),
        params,
        nesting,
    };
}

/**
 * Tách dieline hộp cứng nam châm thành 2 model rời cho bình khuôn / xuất PDF:
 *   - tray: Khay trong carton lạnh (prefix `tray_`)
 *   - sleeve (cover): Bìa ngoài gắn nam châm (prefix `cover_`)
 */
export function splitRigidMagneticDieline(
    model: DielineModel,
): { tray: DielineModel; sleeve: DielineModel } | null {
    if (model.params.boxType !== 'rigid_magnetic') return null;
    const pick = (prefix: 'tray' | 'cover'): DielineModel | null => {
        const panels = model.panels.filter((p) => p.name.startsWith(`${prefix}_`));
        if (panels.length === 0) return null;
        const paths = panels.flatMap((p) => p.paths);
        return {
            ...model,
            panels,
            allPaths: paths,
            boundingBox: computeBoundingBox(paths),
            nesting: undefined,
        };
    };
    const tray = pick('tray');
    const sleeve = pick('cover');
    return tray && sleeve ? { tray, sleeve } : null;
}
