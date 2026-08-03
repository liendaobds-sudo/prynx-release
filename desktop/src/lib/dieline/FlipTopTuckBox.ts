// ============================================================
// PRYNX-FTT-01 — Hộp nắp lật tự khóa, gài mặt trước
//
// Nguồn hình học: khuon-01.svg, fixture 200 × 200 × 60 mm.
// Tọa độ dựng trực tiếp bằng mm; không chép scale Illustrator 1,00969.
//
// Hệ Y từ mép trước đáy đi về phía nắp:
//
//              [MÉP TRƯỚC THẤP]                 -D/3 → 0
//   CÁNH TRÁI ┌──────── ĐÁY ────────┐ CÁNH PHẢI  0 → W-T
//   KHÓA SAU  │      VÁCH SAU       │ KHÓA SAU   W-T → W-T+D
//   HÔNG NẮP  │        NẮP          │ HÔNG NẮP   ... → ...+W
//   KHÓA TRƯỚC│  VÁCH TRƯỚC NẮP    │KHÓA TRƯỚC  ... → ...+D
//
// CUT ngoài là MỘT contour kín. Hai khe khóa cạnh, bốn relief cut và
// khe nhận mặt trước là bảy CUT hở có chủ đích theo SVG nguồn.
//
// Giới hạn nội suy từ một mẫu duy nhất:
// - Bề rộng khóa giữa dùng min(L/5, 2D/3), chưa phải tỷ lệ tiêu chuẩn đã chứng minh.
// - Bù 0,5/1 mm được biểu diễn bằng T và C theo ý nghĩa vật liệu/dung sai.
// - Bảy khe hở không phải lỗ diện tích trong khuôn 2D; ba khe cài được nới hẹp
//   thành holes chỉ dành cho solid 3D để người dùng nhìn thấy đường xẻ xuyên giấy.
// - Không gán mã FEFCO; PRYNX-FTT-01 là mã nội bộ của catalog.
// ============================================================

import { BoxParams, DielineModel, Panel, PathSegment, Point2D } from './types';
import {
    FTT_BASE_SIDE_LOCK_DEPTH_RATIO,
    FTT_BASE_SIDE_RADIUS_RATIO,
    FTT_BASE_SIDE_SHOULDER_RATIO,
    FTT_CENTER_LOCK_D_RATIO,
    FTT_CENTER_LOCK_L_RATIO,
    FTT_CENTER_SHOULDER_RATIO,
    FTT_CORNER_LOCK_FILLET_RATIO,
    FTT_CORNER_SLOT_RATIO,
    FTT_3D_SLIT_PREVIEW_WIDTH_MM,
    FTT_FRONT_LIP_DEPTH_RATIO,
    FTT_FRONT_LIP_RADIUS_RATIO,
    FTT_FRONT_LIP_TAPER_DEG,
    FTT_SLOT_INSET_RATIO,
    FTT_SLOT_LEAD_RATIO,
} from './constants';
import {
    arcToBezier,
    computeBoundingBox,
    filletBezier,
    line,
    pt,
    sampleBezier,
    snap,
} from './utils';

export interface FlipTopTuckDims {
    bodyLength: number;
    bottomWidth: number;
    frontLipDepth: number;
    cornerSlot: number;
    slotInset: number;
    slotLead: number;
    baseSideShoulder: number;
    baseSideLockDepth: number;
    baseSideRadius: number;
    cornerLockFillet: number;
    centerLockWidth: number;
    centerCapRadius: number;
}

/**
 * Kích thước dẫn xuất từ fixture 200×200×60 mm.
 * Guard chỉ thu chi tiết khóa khi kích thước biên quá ngắn; L/W/D thành phẩm
 * vẫn chỉnh độc lập và không bị buộc theo tỷ lệ của mẫu vuông.
 */
export function flipTopTuckDims(params: BoxParams): FlipTopTuckDims {
    const { L, W, D, T, C } = params;
    const bodyLength = snap(L + 2 * T);
    const bottomWidth = snap(Math.max(2, W - T));
    const frontLipDepth = snap(D * FTT_FRONT_LIP_DEPTH_RATIO);
    const rawSideY = D * FTT_BASE_SIDE_SHOULDER_RATIO;
    const baseSideY = snap(Math.min(rawSideY, Math.max(1, bottomWidth / 3)));
    const roomForRadius = Math.max(0.5, (bottomWidth - 2 * baseSideY) / 4);
    const centerLockWidth = snap(Math.max(
        4,
        Math.min(
            L * FTT_CENTER_LOCK_L_RATIO,
            D * FTT_CENTER_LOCK_D_RATIO,
            Math.max(4, L - 4 * C),
        ),
    ));
    return {
        bodyLength,
        bottomWidth,
        frontLipDepth,
        cornerSlot: snap(D * FTT_CORNER_SLOT_RATIO),
        slotInset: snap(Math.min(D * FTT_SLOT_INSET_RATIO, Math.max(1, W * 0.4))),
        slotLead: snap(D * FTT_SLOT_LEAD_RATIO),
        baseSideShoulder: snap(baseSideY + T + C),
        baseSideLockDepth: snap(D * FTT_BASE_SIDE_LOCK_DEPTH_RATIO),
        baseSideRadius: snap(Math.min(D * FTT_BASE_SIDE_RADIUS_RATIO, roomForRadius)),
        cornerLockFillet: snap(D * FTT_CORNER_LOCK_FILLET_RATIO),
        centerLockWidth,
        centerCapRadius: snap(Math.max(0.5, centerLockWidth / 2 - 2 * T)),
    };
}

function segmentStart(segment: PathSegment): Point2D {
    return segment.controlPoints?.[0] ?? segment.points[0];
}

function segmentEnd(segment: PathSegment): Point2D {
    return segment.controlPoints?.[3] ?? segment.points[segment.points.length - 1];
}

function samePoint(a: Point2D, b: Point2D): boolean {
    return Math.abs(a.x - b.x) < 0.0005 && Math.abs(a.y - b.y) < 0.0005;
}

/** Lấy mẫu chuỗi CUT liên tục để outline 3D bám đúng Bezier của khuôn 2D. */
function samplePathChain(segments: readonly PathSegment[]): Point2D[] {
    const points: Point2D[] = [];
    const push = (point: Point2D) => {
        if (points.length === 0 || !samePoint(points[points.length - 1], point)) {
            points.push(point);
        }
    };
    for (const segment of segments) {
        const sampled = segment.type === 'bezier' && segment.controlPoints
            ? sampleBezier(...segment.controlPoints, 12)
            : [segmentStart(segment), segmentEnd(segment)];
        sampled.forEach(push);
    }
    return points;
}

/**
 * Nới một đường xẻ không diện tích thành vòng khoét hẹp chỉ dành cho solid 3D.
 * Khuôn 2D vẫn giữ đúng centerline CUT; vòng này chỉ giúp nhìn xuyên qua giấy.
 */
function slitPreviewHole(centerline: readonly Point2D[], width: number): Point2D[] {
    if (centerline.length < 2 || !(width > 0)) return [];
    const half = width / 2;
    const normals: Point2D[] = [];
    for (let index = 0; index < centerline.length - 1; index += 1) {
        const a = centerline[index];
        const b = centerline[index + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        normals.push(length > 1e-9
            ? { x: -dy / length, y: dx / length }
            : { x: 0, y: 0 });
    }

    const offsetPoint = (index: number, side: 1 | -1): Point2D => {
        const point = centerline[index];
        let normal: Point2D;
        let scale = half;
        if (index === 0) {
            normal = normals[0];
        } else if (index === centerline.length - 1) {
            normal = normals[normals.length - 1];
        } else {
            const before = normals[index - 1];
            const after = normals[index];
            const sumX = before.x + after.x;
            const sumY = before.y + after.y;
            const sumLength = Math.hypot(sumX, sumY);
            normal = sumLength > 1e-9
                ? { x: sumX / sumLength, y: sumY / sumLength }
                : after;
            const projection = Math.abs(normal.x * after.x + normal.y * after.y);
            scale = projection > 0.25 ? Math.min(half / projection, width * 2) : half;
        }
        return pt(
            snap(point.x + normal.x * scale * side),
            snap(point.y + normal.y * scale * side),
        );
    };

    const left = centerline.map((_, index) => offsetPoint(index, 1));
    const right = centerline.map((_, index) => offsetPoint(index, -1)).reverse();
    return [...left, ...right];
}

/** Sinh bản vẽ khuôn bế PRYNX-FTT-01. */
export function generateFlipTopTuckBox(params: BoxParams): DielineModel {
    const { W, D, T, C } = params;
    const d = flipTopTuckDims(params);

    const B = d.bodyLength;
    const BW = d.bottomWidth;
    const Y0 = 0;
    const Y1 = BW;
    const Y2 = snap(BW + D);
    const Y3 = snap(Y2 + W);
    const Y4 = snap(Y3 + D);

    const lidX0 = snap(T);
    const lidX1 = snap(B - T);
    const centerX = snap(B / 2);

    const sideY0 = snap(Math.min(
        D * FTT_BASE_SIDE_SHOULDER_RATIO,
        Math.max(1, BW / 3),
    ));
    const sideY1 = snap(BW - sideY0);
    const sideStepL = snap(-d.baseSideShoulder - d.baseSideLockDepth + d.baseSideRadius);
    const sideOuterL = snap(sideStepL - d.baseSideRadius);
    const sideStepR = snap(B + d.baseSideShoulder + d.baseSideLockDepth - d.baseSideRadius);
    const sideOuterR = snap(sideStepR + d.baseSideRadius);

    const lockWidth = d.centerLockWidth;
    const stemLeft = snap(centerX - lockWidth / 2);
    const stemRight = snap(centerX + lockWidth / 2);
    const shoulderR = snap(Math.min(
        lockWidth * FTT_CENTER_SHOULDER_RATIO,
        Math.max(0.5, D / 8),
    ));
    const capR = d.centerCapRadius;
    const capY = snap(Y4 - capR - T);
    const capLeft = snap(centerX - capR);
    const capRight = snap(centerX + capR);
    const capReliefR = snap(Math.max(0, Math.min(
        T,
        (capLeft - stemLeft) / 2,
        (stemRight - capRight) / 2,
    )));

    // ── CUT ngoài: builder giữ endpoint liên tục dưới 0,001 mm. ──
    const outerCut: PathSegment[] = [];
    const start = pt(0, Y0);
    let cursor = start;
    const cutTo = (target: Point2D): void => {
        if (!samePoint(cursor, target)) outerCut.push(line(cursor, target, 'CUT'));
        cursor = target;
    };
    const cutCurve = (segment: PathSegment): void => {
        cutTo(segmentStart(segment));
        outerCut.push(segment);
        cursor = segmentEnd(segment);
    };
    let outerPanelStart = 0;
    const takeOuterPanelPaths = (): PathSegment[] => {
        const paths = outerCut.slice(outerPanelStart);
        outerPanelStart = outerCut.length;
        return paths;
    };

    // Mép trước thấp: cạnh nghiêng 10° + bo D/6 + cạnh đáy.
    const lipTaper = snap(d.frontLipDepth * Math.tan(
        FTT_FRONT_LIP_TAPER_DEG * Math.PI / 180,
    ));
    const lipBottomY = snap(-d.frontLipDepth);
    const lipLeftCorner = pt(lipTaper, lipBottomY);
    const lipRightCorner = pt(snap(B - lipTaper), lipBottomY);
    const lipR = snap(Math.min(
        D * FTT_FRONT_LIP_RADIUS_RATIO,
        Math.max(0.5, B / 8),
    ));
    const lipLeftFillet = filletBezier(
        lipLeftCorner,
        start,
        pt(centerX, lipBottomY),
        lipR,
        'CUT',
    );
    const lipRightFillet = filletBezier(
        lipRightCorner,
        pt(centerX, lipBottomY),
        pt(B, Y0),
        lipR,
        'CUT',
    );
    cutCurve(lipLeftFillet);
    cutTo(segmentStart(lipRightFillet));
    cutCurve(lipRightFillet);
    cutTo(pt(B, Y0));
    const lidFrontOuter = takeOuterPanelPaths();

    // Cánh đáy phải — vai chéo, hai bo tròn và cạnh khóa đứng.
    cutTo(pt(snap(B + d.baseSideShoulder), sideY0));
    cutTo(pt(sideStepR, sideY0));
    cutCurve(arcToBezier(
        sideStepR,
        snap(sideY0 + d.baseSideRadius),
        d.baseSideRadius,
        -90,
        0,
        'CUT',
    ));
    cutTo(pt(sideOuterR, snap(sideY1 - d.baseSideRadius)));
    cutCurve(arcToBezier(
        sideStepR,
        snap(sideY1 - d.baseSideRadius),
        d.baseSideRadius,
        0,
        90,
        'CUT',
    ));
    cutTo(pt(snap(B + d.baseSideShoulder), sideY1));
    cutTo(pt(B, Y1));
    const lidSideRightOuter = takeOuterPanelPaths();

    // Tai khóa sau phải.
    cutTo(pt(snap(B + D), Y1));
    const backRightFillet = filletBezier(
        pt(snap(B + D), snap(Y2 - D / 4)),
        pt(snap(B + D), Y1),
        pt(snap(B + D / 2), snap(Y2 - D / 2)),
        d.cornerLockFillet,
        'CUT',
    );
    cutCurve(backRightFillet);
    cutTo(pt(snap(B + D / 2), snap(Y2 - D / 2)));
    cutTo(pt(snap(lidX1 + d.cornerSlot), Y2));
    const backLockRightOuter = takeOuterPanelPaths();
    cutTo(pt(snap(lidX1 + D), Y2));

    // Hông nắp phải.
    cutTo(pt(snap(lidX1 + D), Y3));

    // Tai khóa trước phải.
    cutTo(pt(snap(lidX1 + d.cornerSlot), Y3));
    const baseSideRightOuter = takeOuterPanelPaths();
    cutTo(pt(snap(B + D / 2), snap(Y3 + D / 2)));
    const frontRightFillet = filletBezier(
        pt(snap(B + D), snap(Y3 + D / 4)),
        pt(snap(B + D / 2), snap(Y3 + D / 2)),
        pt(snap(B + D), Y4),
        d.cornerLockFillet,
        'CUT',
    );
    cutCurve(frontRightFillet);
    cutTo(pt(snap(B + D), Y4));
    cutTo(pt(B, Y4));
    const frontLockRightOuter = takeOuterPanelPaths();

    // Khóa giữa trên mép tự do của vách trước nắp.
    cutTo(pt(snap(stemRight + shoulderR), Y4));
    // [FLIP-TOP-TUCK FIX 2026-08-03 §FTT.7] Tâm bo phải nằm lệch vào góc
    // tiếp tuyến; đặt tâm ngay tại đỉnh sẽ khoét một cung lõm vào lưỡi khóa.
    cutCurve(arcToBezier(
        snap(stemRight + shoulderR),
        snap(Y4 - shoulderR),
        shoulderR,
        90,
        180,
        'CUT',
    ));
    cutTo(pt(stemRight, capY));
    if (capReliefR > 0.001) {
        const rightReliefCx = snap(stemRight - capReliefR);
        cutCurve(arcToBezier(rightReliefCx, capY, capReliefR, 0, -90, 'CUT'));
        cutCurve(arcToBezier(rightReliefCx, capY, capReliefR, -90, -180, 'CUT'));
    } else {
        cutTo(pt(capRight, capY));
    }
    cutCurve(arcToBezier(centerX, capY, capR, 0, 90, 'CUT'));
    cutCurve(arcToBezier(centerX, capY, capR, 90, 180, 'CUT'));
    if (capReliefR > 0.001) {
        const leftReliefCx = snap(stemLeft + capReliefR);
        cutCurve(arcToBezier(leftReliefCx, capY, capReliefR, 0, -90, 'CUT'));
        cutCurve(arcToBezier(leftReliefCx, capY, capReliefR, -90, -180, 'CUT'));
    } else {
        cutTo(pt(stemLeft, capY));
    }
    cutTo(pt(stemLeft, snap(Y4 - shoulderR)));
    cutCurve(arcToBezier(
        snap(stemLeft - shoulderR),
        snap(Y4 - shoulderR),
        shoulderR,
        0,
        90,
        'CUT',
    ));
    cutTo(pt(0, Y4));
    const frontWallOuter = takeOuterPanelPaths();
    cutTo(pt(snap(-D), Y4));

    // Tai khóa trước trái.
    const frontLeftFillet = filletBezier(
        pt(snap(-D), snap(Y3 + D / 4)),
        pt(snap(-D), Y4),
        pt(snap(-D / 2), snap(Y3 + D / 2)),
        d.cornerLockFillet,
        'CUT',
    );
    cutCurve(frontLeftFillet);
    cutTo(pt(snap(-D / 2), snap(Y3 + D / 2)));
    cutTo(pt(snap(lidX0 - d.cornerSlot), Y3));
    const frontLockLeftOuter = takeOuterPanelPaths();
    cutTo(pt(snap(lidX0 - D), Y3));

    // Hông nắp trái.
    cutTo(pt(snap(lidX0 - D), Y2));

    // Tai khóa sau trái.
    cutTo(pt(snap(lidX0 - d.cornerSlot), Y2));
    const baseSideLeftOuter = takeOuterPanelPaths();
    cutTo(pt(snap(-D / 2), snap(Y2 - D / 2)));
    const backLeftFillet = filletBezier(
        pt(snap(-D), snap(Y2 - D / 4)),
        pt(snap(-D / 2), snap(Y2 - D / 2)),
        pt(snap(-D), Y1),
        d.cornerLockFillet,
        'CUT',
    );
    cutCurve(backLeftFillet);
    cutTo(pt(snap(-D), Y1));
    cutTo(pt(0, Y1));
    const backLockLeftOuter = takeOuterPanelPaths();

    // Cánh đáy trái — phản chiếu cánh phải.
    cutTo(pt(snap(-d.baseSideShoulder), sideY1));
    cutTo(pt(sideStepL, sideY1));
    cutCurve(arcToBezier(
        sideStepL,
        snap(sideY1 - d.baseSideRadius),
        d.baseSideRadius,
        90,
        180,
        'CUT',
    ));
    cutTo(pt(sideOuterL, snap(sideY0 + d.baseSideRadius)));
    cutCurve(arcToBezier(
        sideStepL,
        snap(sideY0 + d.baseSideRadius),
        d.baseSideRadius,
        180,
        270,
        'CUT',
    ));
    cutTo(pt(snap(-d.baseSideShoulder), sideY0));
    cutTo(start);
    const lidSideLeftOuter = takeOuterPanelPaths();

    // ── Bảy CUT hở có chủ đích theo SVG nguồn. ──
    const slotDepth = snap(Math.max(0.5, D / 2 - (T + C)));
    const slotLead = snap(Math.min(d.slotLead, d.slotInset / 3));
    const slotLeftX = snap(lidX0 - slotDepth);
    const slotRightX = snap(lidX1 + slotDepth);
    const leftSlot: PathSegment[] = [
        line(
            pt(snap(slotLeftX + slotLead), snap(Y2 + d.slotInset - slotLead)),
            pt(slotLeftX, snap(Y2 + d.slotInset)),
            'CUT',
        ),
        line(
            pt(slotLeftX, snap(Y2 + d.slotInset)),
            pt(slotLeftX, snap(Y3 - d.slotInset)),
            'CUT',
        ),
        line(
            pt(slotLeftX, snap(Y3 - d.slotInset)),
            pt(snap(slotLeftX + slotLead), snap(Y3 - d.slotInset + slotLead)),
            'CUT',
        ),
    ];
    const rightSlot: PathSegment[] = [
        line(
            pt(snap(slotRightX - slotLead), snap(Y2 + d.slotInset - slotLead)),
            pt(slotRightX, snap(Y2 + d.slotInset)),
            'CUT',
        ),
        line(
            pt(slotRightX, snap(Y2 + d.slotInset)),
            pt(slotRightX, snap(Y3 - d.slotInset)),
            'CUT',
        ),
        line(
            pt(slotRightX, snap(Y3 - d.slotInset)),
            pt(snap(slotRightX - slotLead), snap(Y3 - d.slotInset + slotLead)),
            'CUT',
        ),
    ];

    const reliefBackLeft = line(
        pt(lidX0, Y2),
        pt(snap(lidX0 - d.cornerSlot), Y2),
        'CUT',
    );
    const reliefBackRight = line(
        pt(lidX1, Y2),
        pt(snap(lidX1 + d.cornerSlot), Y2),
        'CUT',
    );
    const reliefFrontLeft = line(
        pt(lidX0, Y3),
        pt(snap(lidX0 - d.cornerSlot), Y3),
        'CUT',
    );
    const reliefFrontRight = line(
        pt(lidX1, Y3),
        pt(snap(lidX1 + d.cornerSlot), Y3),
        'CUT',
    );

    const receiverLength = snap(2 * capR + 2 * C);
    const receiverLead = snap(T + C);
    const receiverY = snap(-D / 6);
    const receiverHalf = snap(receiverLength / 2);
    const frontReceiver: PathSegment[] = [
        line(
            pt(snap(centerX + receiverHalf + receiverLead), snap(receiverY - receiverLead)),
            pt(snap(centerX + receiverHalf), receiverY),
            'CUT',
        ),
        line(
            pt(snap(centerX + receiverHalf), receiverY),
            pt(snap(centerX - receiverHalf), receiverY),
            'CUT',
        ),
        line(
            pt(snap(centerX - receiverHalf), receiverY),
            pt(snap(centerX - receiverHalf - receiverLead), snap(receiverY - receiverLead)),
            'CUT',
        ),
    ];
    const internalCuts = [
        ...leftSlot,
        ...rightSlot,
        reliefBackLeft,
        reliefBackRight,
        reliefFrontLeft,
        reliefFrontRight,
        ...frontReceiver,
    ];

    // [FLIP-TOP-TUCK FIX 2026-08-03 §FTT.11] Ba đường xẻ cài là CUT hở
    // không có diện tích trong bản bế. Solid 3D cần vòng khoét rất hẹp để rãnh
    // vẫn xuyên giấy và nhìn thấy khi tắt lớp đường kỹ thuật.
    const leftSlotHole = slitPreviewHole(
        [segmentStart(leftSlot[1]), segmentEnd(leftSlot[1])],
        FTT_3D_SLIT_PREVIEW_WIDTH_MM,
    );
    const rightSlotHole = slitPreviewHole(
        [segmentStart(rightSlot[1]), segmentEnd(rightSlot[1])],
        FTT_3D_SLIT_PREVIEW_WIDTH_MM,
    );
    const frontReceiverHole = slitPreviewHole(
        [segmentStart(frontReceiver[1]), segmentEnd(frontReceiver[1])],
        FTT_3D_SLIT_PREVIEW_WIDTH_MM,
    );

    // Sáu mốc cấu tạo chính cho nút DEV “Chú thích điểm”. Giữ danh sách ngắn
    // để đọc được trên canvas nhưng vẫn phủ bản lề, khe hông và cặp khóa trước.
    const bottomAnnotations: NonNullable<Panel['annotations']> = [
        { point: pt(lidX0, Y2), text: 'A — Đầu nếp đáy–vách sau trái', anchor: 'end', baseline: 'hanging' },
        { point: pt(lidX1, Y2), text: 'B — Đầu nếp đáy–vách sau phải', anchor: 'start', baseline: 'hanging' },
    ];
    const leftSideAnnotations: NonNullable<Panel['annotations']> = [
        {
            point: pt(slotLeftX, snap(Y2 + d.slotInset)),
            text: 'C — Đầu khe khóa hông đáy trái (phía bản lề)',
            anchor: 'end',
            baseline: 'middle',
        },
    ];
    const rightSideAnnotations: NonNullable<Panel['annotations']> = [
        {
            point: pt(slotRightX, snap(Y2 + d.slotInset)),
            text: 'D — Đầu khe khóa hông đáy phải (phía bản lề)',
            anchor: 'start',
            baseline: 'middle',
        },
    ];
    const frontWallAnnotations: NonNullable<Panel['annotations']> = [
        {
            point: pt(centerX, snap(capY + capR)),
            text: 'E — Đỉnh lưỡi khóa mặt trước',
            anchor: 'middle',
            baseline: 'bottom',
        },
    ];
    const lidFrontAnnotations: NonNullable<Panel['annotations']> = [
        {
            point: pt(centerX, receiverY),
            text: 'F — Tâm khe nhận khóa trước',
            anchor: 'middle',
            baseline: 'bottom',
        },
    ];

    // ── 12 nếp gấp danh nghĩa; không nhập 1.988 dash Illustrator. ──
    const creaseLidFront = line(pt(0, Y0), pt(B, Y0), 'CREASE');
    const creaseLidSideLeft = line(pt(0, Y0), pt(0, Y1), 'CREASE');
    const creaseLidSideRight = line(pt(B, Y0), pt(B, Y1), 'CREASE');
    const creaseBackWall = line(pt(0, Y1), pt(B, Y1), 'CREASE');
    const creaseBackLockLeft = line(pt(0, Y1), pt(0, Y2), 'CREASE');
    const creaseBackLockRight = line(pt(B, Y1), pt(B, Y2), 'CREASE');
    const creaseBottom = line(pt(lidX0, Y2), pt(lidX1, Y2), 'CREASE');
    const creaseBaseSideLeft = line(pt(lidX0, Y2), pt(lidX0, Y3), 'CREASE');
    const creaseBaseSideRight = line(pt(lidX1, Y2), pt(lidX1, Y3), 'CREASE');
    const creaseFrontWall = line(pt(lidX0, Y3), pt(lidX1, Y3), 'CREASE');
    const creaseFrontLockLeft = line(pt(0, Y3), pt(0, Y4), 'CREASE');
    const creaseFrontLockRight = line(pt(B, Y3), pt(B, Y4), 'CREASE');
    const creases = [
        creaseLidFront,
        creaseLidSideLeft,
        creaseLidSideRight,
        creaseBackWall,
        creaseBackLockLeft,
        creaseBackLockRight,
        creaseBottom,
        creaseBaseSideLeft,
        creaseBaseSideRight,
        creaseFrontWall,
        creaseFrontLockLeft,
        creaseFrontLockRight,
    ];

    // [FLIP-TOP-TUCK FIX 2026-08-03 §FTT.9] Panel Y2→Y3 có ba vách cao D
    // mới là đáy thật. Panel Y0→Y1 có mép thấp và hai cánh bo là nắp.
    // Cây gập phải đi đáy → vách sau → nắp để nắp đóng ở cao độ D.
    const panels: Panel[] = [
        {
            name: 'bottom',
            label: 'Đáy',
            paths: [creaseBottom, creaseBaseSideLeft, creaseBaseSideRight, creaseFrontWall],
            annotations: bottomAnnotations,
            outline: [pt(lidX0, Y2), pt(lidX1, Y2), pt(lidX1, Y3), pt(lidX0, Y3)],
            parent: null,
            pivotEdge: null,
            foldAngle: 0,
            foldDirection: 1,
        },
        {
            name: 'base_side_left',
            label: 'Cánh đáy trái',
            paths: [
                creaseBaseSideLeft,
                ...baseSideLeftOuter,
                ...leftSlot,
                reliefBackLeft,
                reliefFrontLeft,
            ],
            annotations: leftSideAnnotations,
            holes: [leftSlotHole],
            outline: [
                ...samplePathChain(baseSideLeftOuter),
                pt(lidX0, Y2),
                pt(lidX0, Y3),
            ],
            parent: 'bottom',
            pivotEdge: [pt(lidX0, Y2), pt(lidX0, Y3)],
            foldAngle: 90,
            foldDirection: 1,
            foldPhase: [0.48, 0.60],
        },
        {
            name: 'base_side_right',
            label: 'Cánh đáy phải',
            paths: [
                creaseBaseSideRight,
                ...baseSideRightOuter,
                ...rightSlot,
                reliefBackRight,
                reliefFrontRight,
            ],
            annotations: rightSideAnnotations,
            holes: [rightSlotHole],
            outline: [
                ...samplePathChain(baseSideRightOuter),
                pt(lidX1, Y3),
                pt(lidX1, Y2),
            ],
            parent: 'bottom',
            pivotEdge: [pt(lidX1, Y2), pt(lidX1, Y3)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.48, 0.60],
        },
        {
            name: 'front_wall',
            label: 'Vách trước',
            paths: [
                creaseFrontWall,
                creaseFrontLockLeft,
                creaseFrontLockRight,
                ...frontWallOuter,
            ],
            annotations: frontWallAnnotations,
            outline: [
                pt(0, Y3),
                pt(B, Y3),
                ...samplePathChain(frontWallOuter),
            ],
            parent: 'bottom',
            pivotEdge: [pt(lidX0, Y3), pt(lidX1, Y3)],
            foldAngle: 90,
            foldDirection: 1,
            foldPhase: [0.62, 0.74],
        },
        {
            name: 'front_lock_left',
            label: 'Tai khóa trước-trái',
            paths: [creaseFrontLockLeft, ...frontLockLeftOuter, reliefFrontLeft],
            outline: [
                ...samplePathChain(frontLockLeftOuter),
                pt(0, Y3),
            ],
            parent: 'front_wall',
            pivotEdge: [pt(0, Y3), pt(0, Y4)],
            foldAngle: 90,
            foldDirection: 1,
            foldPhase: [0.36, 0.48],
        },
        {
            name: 'front_lock_right',
            label: 'Tai khóa trước-phải',
            paths: [creaseFrontLockRight, ...frontLockRightOuter, reliefFrontRight],
            outline: [
                ...samplePathChain(frontLockRightOuter),
                pt(B, Y3),
            ],
            parent: 'front_wall',
            pivotEdge: [pt(B, Y3), pt(B, Y4)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.36, 0.48],
        },
        {
            name: 'back_wall',
            label: 'Vách sau',
            paths: [creaseBackWall, creaseBackLockLeft, creaseBackLockRight, creaseBottom],
            outline: [pt(0, Y1), pt(B, Y1), pt(B, Y2), pt(0, Y2)],
            parent: 'bottom',
            pivotEdge: [pt(lidX0, Y2), pt(lidX1, Y2)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.22, 0.36],
        },
        {
            name: 'back_lock_left',
            label: 'Tai khóa sau-trái',
            paths: [creaseBackLockLeft, ...backLockLeftOuter, reliefBackLeft],
            outline: [
                ...samplePathChain(backLockLeftOuter),
                pt(0, Y2),
            ],
            parent: 'back_wall',
            pivotEdge: [pt(0, Y1), pt(0, Y2)],
            foldAngle: 90,
            foldDirection: 1,
            foldPhase: [0.36, 0.48],
        },
        {
            name: 'back_lock_right',
            label: 'Tai khóa sau-phải',
            paths: [creaseBackLockRight, ...backLockRightOuter, reliefBackRight],
            outline: [
                ...samplePathChain(backLockRightOuter),
                pt(B, Y2),
            ],
            parent: 'back_wall',
            pivotEdge: [pt(B, Y1), pt(B, Y2)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.36, 0.48],
        },
        {
            name: 'lid',
            label: 'Nắp',
            paths: [creaseBackWall, creaseLidSideLeft, creaseLidSideRight, creaseLidFront],
            outline: [pt(0, Y0), pt(B, Y0), pt(B, Y1), pt(0, Y1)],
            parent: 'back_wall',
            pivotEdge: [pt(0, Y1), pt(B, Y1)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.78, 0.95],
        },
        {
            name: 'lid_side_left',
            label: 'Cánh nắp trái',
            paths: [creaseLidSideLeft, ...lidSideLeftOuter],
            outline: samplePathChain(lidSideLeftOuter),
            parent: 'lid',
            pivotEdge: [pt(0, Y0), pt(0, Y1)],
            foldAngle: 90,
            foldDirection: 1,
            foldPhase: [0.08, 0.22],
        },
        {
            name: 'lid_side_right',
            label: 'Cánh nắp phải',
            paths: [creaseLidSideRight, ...lidSideRightOuter],
            outline: samplePathChain(lidSideRightOuter),
            parent: 'lid',
            pivotEdge: [pt(B, Y0), pt(B, Y1)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.08, 0.22],
        },
        {
            name: 'lid_front',
            label: 'Mép trước nắp',
            paths: [creaseLidFront, ...lidFrontOuter, ...frontReceiver],
            annotations: lidFrontAnnotations,
            holes: [frontReceiverHole],
            outline: samplePathChain(lidFrontOuter),
            parent: 'lid',
            pivotEdge: [pt(0, Y0), pt(B, Y0)],
            foldAngle: -90,
            foldDirection: 1,
            foldPhase: [0.08, 0.22],
        },
    ];

    const allPaths = [...outerCut, ...internalCuts, ...creases];
    const warnings: string[] = [];
    if (BW <= 1.25 * D) {
        warnings.push('Chiều rộng W đang ngắn so với chiều cao D; cánh khóa đáy đã được thu để không suy biến.');
    }
    if (D / 2 <= T + C) {
        warnings.push('Chiều cao D quá nhỏ so với độ dày và dung sai; khe khóa cạnh có thể khó gia công.');
    }
    if (capR <= C) {
        warnings.push('Lưỡi khóa giữa quá nhỏ so với dung sai; nên tăng L hoặc D.');
    }

    return {
        name: 'Flip-Top Tuck Box (Hộp nắp lật tự khóa)',
        standardCode: 'PRYNX-FTT-01',
        description: 'Hộp một mảnh, thành tự khóa, nắp lật liền thân và gài mặt trước',
        panels,
        allPaths,
        boundingBox: computeBoundingBox(allPaths),
        params,
        warnings,
    };
}
