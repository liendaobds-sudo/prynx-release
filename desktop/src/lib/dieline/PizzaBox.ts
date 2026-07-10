// ============================================================
// FEFCO 0426 — Pizza Box / Tray with Self-Locking Walls & Hinged Lid
// Hộp pizza — khay vách tự khóa, nắp bản lề.
//
// Layout DỌC (cuộn theo Y), gốc (0,0) = góc dưới-trái ĐÁY:
//
//     [DF‑LT]              [DF‑RT]
//    ──┼──────────────────────┼──
//      │      NẮP (LID)       │      L × W
//      │                      │
//    ──┼──────────────────────┼──  ← Crease (bản lề nắp)
//      │     VÁCH SAU (BACK)  │      L × D
//    ──┼──────────────────────┼──  ← Crease
// S   ┌┤                      ├┐   S
// I   ││    ĐÁY (BOTTOM)     ││   I
// D   ││      L × W           ││   D
// E   ││   + 4 SLOTS          ││   E
//     └┤                      ├┘
// L  ──┼──────────────────────┼──  ← Crease       R
// E    │  VÁCH TRƯỚC (FRONT)  │      L × D        I
// F    │                      │                    G
// T  ──┼──────────────────────┼──                  H
//      │     [DF‑LB]  [DF‑RB]│                    T
//
// Side walls cuộn sang trái/phải từ Bottom, giống mailer.
// Có tabs gài vào slots trên Bottom.
//
// Trục Y (dưới lên trên):
//   Front(−D → 0) | Bottom(0 → W) | Back(W → W+D) | Lid(W+D → W+D+W)
// Trục X:
//   SideL(−) | Main(0 → L) | SideR(+)
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
    filletBezier,
    computeBoundingBox,
    arcToBezier,
} from './utils';

import {
    PIZZA_SLOT_OFFSET_MM,
    PIZZA_SLOT_LENGTH_RATIO,
    PIZZA_FAN_FILLET_RATIO,
    PIZZA_FAN_FILLET_MAX,
    PIZZA_LID_FLAP_INSET_RATIO,
    PIZZA_DUST_SKEW_RATIO,
} from './constants';



function getOutlinePoints(paths: PathSegment[]): Point2D[] {
    const pts: Point2D[] = [];
    for (const p of paths.filter(x => x.tag === 'CUT')) {
        if (p.type === 'bezier' && p.controlPoints) {
            const [p0, cp1, cp2, p3] = p.controlPoints;
            const steps = 12;
            for (let i = 0; i < steps; i++) {
                const t = i / steps;
                const it = 1 - t;
                const x = it * it * it * p0.x + 3 * it * it * t * cp1.x + 3 * it * t * t * cp2.x + t * t * t * p3.x;
                const y = it * it * it * p0.y + 3 * it * it * t * cp1.y + 3 * it * t * t * cp2.y + t * t * t * p3.y;
                pts.push(pt(x, y));
            }
        } else {
            pts.push(p.points[0]);
        }
    }
    return pts;
}

/**
 * Sinh bản vẽ khuôn bế Pizza Box (FEFCO 0426).
 * Cấu trúc tham khảo Mailer Box: side walls cuộn + tabs/slots.
 */
export function generatePizzaBox(params: BoxParams): DielineModel {
    const { L, W, D, T, C } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ── Offset bù độ dày vật liệu (kỹ thuật in ấn) ──
    // Vách trước/sau hẹp hơn đáy 1T mỗi bên → L - 2T
    // Nắp chính hẹp hơn đáy 2T mỗi bên → L - 4T
    // Đáy + nắp phụ = L (full width)
    const frontBackInset = snap(T);       // 1T mỗi bên
    const lidInset = snap(2 * T);         // 2T mỗi bên
    const xFrontL = frontBackInset;       // x trái front/back
    const xFrontR = snap(L - frontBackInset); // x phải front/back
    const xLidL = lidInset;               // x trái lid
    const xLidR = snap(L - lidInset);     // x phải lid

    // ── THÔNG SỐ ĐỘNG (giống mailer) ──
    const T_fold = snap(2 * T);
    const X_outer = snap(2 * D + T);       // Chiều rộng side wall cuộn
    const X_tab = snap(X_outer + T + 1);    // Mép tab nhận slots

    const so = snap(D + PIZZA_SLOT_OFFSET_MM);   // Vị trí slot offset (cách mép Bottom)
    const sl = snap(W * PIZZA_SLOT_LENGTH_RATIO); // Chiều dài slot
    const slot_w = snap(T + 1);                   // Chiều rộng slot

    // ============================================================
    // 1. BOTTOM (ĐÁY) — ROOT, tọa độ (0,0) → (L, W)
    // ============================================================
    const bottomPaths: PathSegment[] = [
        line(pt(0, 0), pt(L, 0), 'CREASE'),         // cạnh dưới → Front
        line(pt(L, 0), pt(L, W), 'CREASE'),          // cạnh phải → Side R
        line(pt(L, W), pt(0, W), 'CREASE'),          // cạnh trên → Back
        line(pt(0, W), pt(0, 0), 'CREASE'),          // cạnh trái → Side L
    ];
    allPaths.push(...bottomPaths);
    panels.push({
        name: 'bottom', label: 'Đáy', paths: bottomPaths,
        parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1,
        outline: [pt(0, 0), pt(L, 0), pt(L, W), pt(0, W)],
    });

    // ── SLOTS trên Bottom (4 khe, dịch vào 2T từ mép X) ──
    const slotPositions = [
        { x: snap(2 * T), y: so },
        { x: snap(2 * T), y: snap(W - so - sl) },
        { x: snap(L - 2 * T - slot_w), y: so },
        { x: snap(L - 2 * T - slot_w), y: snap(W - so - sl) },
    ];
    // Lỗ khoét thật trên ĐÁY (để tab cuộn hông luồn xuyên qua khi render 3D).
    const slotHoles: Point2D[][] = slotPositions.map((s) => [
        pt(s.x, s.y),
        pt(snap(s.x + slot_w), s.y),
        pt(snap(s.x + slot_w), snap(s.y + sl)),
        pt(s.x, snap(s.y + sl)),
    ]);
    const bottomPanelRef = panels.find((p) => p.name === 'bottom');
    if (bottomPanelRef) bottomPanelRef.holes = slotHoles;
    for (const s of slotPositions) {
        const x0 = s.x, y0 = s.y;
        const x1 = snap(s.x + slot_w), y1 = snap(s.y + sl);
        const r = snap(Math.min(slot_w, sl) * 0.3); // bo góc 30% cạnh ngắn

        // 4 góc: BL, BR, TR, TL
        const corners = [
            { cx: x0, cy: y0, px: x0, py: y1, nx: x1, ny: y0 }, // BL: from left → bottom
            { cx: x1, cy: y0, px: x0, py: y0, nx: x1, ny: y1 }, // BR: from bottom → right
            { cx: x1, cy: y1, px: x1, py: y0, nx: x0, ny: y1 }, // TR: from right → top
            { cx: x0, cy: y1, px: x1, py: y1, nx: x0, ny: y0 }, // TL: from top → left
        ];
        for (const c of corners) {
            const f = filletBezier(
                pt(c.cx, c.cy), pt(c.px, c.py), pt(c.nx, c.ny), r, 'CUT'
            );
            allPaths.push(f);
            // Straight edge from this fillet end to next fillet start
            allPaths.push(line(
                f.points[f.points.length - 1],
                pt(c.nx, c.ny), // next corner (will be trimmed by its fillet)
                'CUT'
            ));
        }
        // Fix edges: trim each straight segment to end at the next fillet's start
        // Since we pushed arc,line pairs (8 segs), fix line endpoints
        const slotSegs = allPaths.slice(-8);
        for (let i = 0; i < 4; i++) {
            const lineIdx = i * 2 + 1;
            const nextArcIdx = ((i + 1) % 4) * 2;
            slotSegs[lineIdx].points[slotSegs[lineIdx].points.length - 1] =
                slotSegs[nextArcIdx].points[0];
        }
    }

    // ============================================================
    // 2. VÁCH TRƯỚC (FRONT) — L-2T, thu đều T mỗi bên
    // ============================================================
    const frontPaths: PathSegment[] = [
        line(pt(xFrontL, 0), pt(xFrontL, snap(-D)), 'CREASE'),     // trái — gập tai trước
        line(pt(xFrontL, snap(-D)), pt(xFrontR, snap(-D)), 'CUT'), // dưới
        line(pt(xFrontR, snap(-D)), pt(xFrontR, 0), 'CREASE'),     // phải — gập tai trước
    ];
    // Khe nhận lưỡi gài khóa nắp trước — khe chữ nhật (rộng = slot_w như khe đáy),
    // đặt sát mép đáy vách trước, đúng nơi lưỡi gài luồn vào.
    let frontLockSlotHole: Point2D[] | undefined;
    if (params.pizzaFrontLock) {
        const flLockW = snap(L / 5);            // dài khe = bề rộng lưỡi gài
        const flCx = snap(L / 2);
        const flHalfW = snap(flLockW / 2);
        const flYhi = snap(-0.05);              // mép trên khe (sát đáy vách, z≈0.05)
        const flYlo = snap(-0.05 - slot_w);     // rộng = slot_w (như khe đáy)
        const sx0 = snap(flCx - flHalfW), sx1 = snap(flCx + flHalfW);
        frontPaths.push(
            line(pt(sx0, flYlo), pt(sx1, flYlo), 'CUT'),
            line(pt(sx1, flYlo), pt(sx1, flYhi), 'CUT'),
            line(pt(sx1, flYhi), pt(sx0, flYhi), 'CUT'),
            line(pt(sx0, flYhi), pt(sx0, flYlo), 'CUT'),
        );
        frontLockSlotHole = [pt(sx0, flYlo), pt(sx1, flYlo), pt(sx1, flYhi), pt(sx0, flYhi)];
    }
    allPaths.push(...frontPaths);
    panels.push({
        name: 'front', label: 'Vách trước', paths: frontPaths,
        parent: 'bottom', pivotEdge: [pt(xFrontL, 0), pt(xFrontR, 0)],
        foldAngle: -90, foldDirection: 1,
        foldPhase: [0.05, 0.2],
        outline: [pt(xFrontL, 0), pt(xFrontR, 0), pt(xFrontR, snap(-D)), pt(xFrontL, snap(-D))],
        holes: frontLockSlotHole ? [frontLockSlotHole] : undefined,
    });

    // ============================================================
    // 3. VÁCH SAU (BACK) — L-2T, thu đều T mỗi bên
    // ============================================================
    const backPaths: PathSegment[] = [
        line(pt(xFrontL, W), pt(xFrontL, snap(W + D)), 'CREASE'),        // trái — gập tai sau
        line(pt(xFrontL, snap(W + D)), pt(xFrontR, snap(W + D)), 'CREASE'), // trên
        line(pt(xFrontR, snap(W + D)), pt(xFrontR, W), 'CREASE'),        // phải — gập tai sau
    ];
    allPaths.push(...backPaths);
    panels.push({
        name: 'back', label: 'Vách sau', paths: backPaths,
        parent: 'bottom', pivotEdge: [pt(xFrontL, W), pt(xFrontR, W)],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.05, 0.2],
        outline: [pt(xFrontL, W), pt(xFrontR, W), pt(xFrontR, snap(W + D)), pt(xFrontL, snap(W + D))],
    });

    // ============================================================
    // 4. NẮP (LID) — L-4T, thu đều 2T mỗi bên
    // ============================================================
    const yLidBot = snap(W + D);
    const yLidTop = snap(W + D + W);

    const lidPaths: PathSegment[] = [
        line(pt(xLidL, yLidBot), pt(xLidL, yLidTop), 'CREASE'),       // trái (tai nắp gập)
        line(pt(xLidL, yLidTop), pt(xLidR, yLidTop), 'CREASE'),       // trên (nắp phụ gập)
        line(pt(xLidR, yLidTop), pt(xLidR, yLidBot), 'CREASE'),       // phải (tai nắp gập)
    ];
    allPaths.push(...lidPaths);
    panels.push({
        name: 'lid', label: 'Nắp chính', paths: lidPaths,
        parent: 'back', pivotEdge: [pt(xLidL, yLidBot), pt(xLidR, yLidBot)],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.66, 0.8],
        outline: [pt(xLidL, yLidBot), pt(xLidR, yLidBot), pt(xLidR, yLidTop), pt(xLidL, yLidTop)],
    });

    // ── LỖ THÔNG HƠI trên nắp (đặc trưng hộp pizza — thoát hơi giữ bánh giòn) ──
    if (params.pizzaVent) {
        const ventR = snap((params.pizzaVentD > 0 ? params.pizzaVentD : 6) / 2);
        const ventCount = Math.max(2, Math.min(5, Math.round(L / 100)));
        const ventCY = snap((yLidBot + yLidTop) / 2);
        const usableW = xLidR - xLidL;
        const lidPanel = panels.find(p => p.name === 'lid');
        for (let i = 0; i < ventCount; i++) {
            const cx = snap(xLidL + usableW * (i + 1) / (ventCount + 1));
            const circ: PathSegment[] = [
                arcToBezier(cx, ventCY, ventR, 0, 90, 'CUT'),
                arcToBezier(cx, ventCY, ventR, 90, 180, 'CUT'),
                arcToBezier(cx, ventCY, ventR, 180, 270, 'CUT'),
                arcToBezier(cx, ventCY, ventR, 270, 360, 'CUT'),
            ];
            allPaths.push(...circ);
            if (lidPanel) {
                lidPanel.holes = lidPanel.holes || [];
                lidPanel.holes.push(getOutlinePoints(circ));
            }
        }
    }


    // ============================================================
    // 4b. NẮP PHỤ (SECONDARY LID) — Gắn trên nắp chính
    //     Khi gấp: úp xuống phía vách trước, 2 tai quạt gài khe hông
    // ============================================================
    let fanToLidR: PathSegment | undefined;
    let fanToLidL: PathSegment | undefined;
    let secTabRightPaths: PathSegment[] = [];
    let secTabLeftPaths: PathSegment[] = [];
    {
        const secH = D;                       // Chiều cao nắp phụ = D
        const ySecBot = yLidTop;              // Nối với top nắp chính (CREASE)
        const ySecTop = snap(yLidTop + secH); // Cạnh xa nhất
        const tabR = snap(D - T);             // Bán kính tai quạt

        // Bo tròn 2 góc TRÊN (xa nắp chính)

        // Hình thang: đáy rộng (nối quạt), đỉnh hẹp (xiên vào T mm mỗi bên)
        const taperX = snap(T);

        // 4 góc chính
        const yTabTop = snap(ySecBot + tabR);
        // Đáy (nối quạt): inset về mép trong xLidL/xLidR để biên nắp phụ trùng
        // bản lề tai quạt (tai quạt cắm vào trong, không úp mặt ngoài).
        const pBotL = pt(xLidL, yTabTop);
        const pBotR = pt(xLidR, yTabTop);
        // Đỉnh (hẹp hơn): xiên vào taperX
        const pTopL = pt(snap(taperX), ySecTop);
        const pTopR = pt(snap(L - taperX), ySecTop);

        const secPaths: PathSegment[] = [];

        // Cạnh trái xiên: pBotL → pTopL
        secPaths.push(line(pBotL, pTopL, 'CUT'));
        // Cạnh trên: nếu bật khóa nắp, đoạn giữa là CREASE (bản lề lưỡi gài).
        const lockW = snap(L / 5);
        const lockH = snap(Math.min(D * 0.5, 16));
        const tlx = snap(L / 2 - lockW / 2);
        const trx = snap(L / 2 + lockW / 2);
        if (params.pizzaFrontLock) {
            secPaths.push(line(pTopL, pt(tlx, ySecTop), 'CUT'));
            secPaths.push(line(pt(tlx, ySecTop), pt(trx, ySecTop), 'CREASE')); // bản lề lưỡi gài
            secPaths.push(line(pt(trx, ySecTop), pTopR, 'CUT'));
        } else {
            secPaths.push(line(pTopL, pTopR, 'CUT'));
        }
        // Cạnh phải xiên: pTopR → pBotR
        secPaths.push(line(pTopR, pBotR, 'CUT'));

        allPaths.push(...secPaths);
        panels.push({
            name: 'secondary_lid', label: 'Nắp phụ', paths: secPaths,
            parent: 'lid',
            pivotEdge: [pt(xLidL, ySecBot), pt(xLidR, ySecBot)],
            foldAngle: -90, foldDirection: -1,
            foldPhase: [0.88, 0.96],
            outline: [pt(xLidL, ySecBot), pt(xLidR, ySecBot), pt(xLidR, yTabTop), pt(snap(L - taperX), ySecTop), pt(snap(taperX), ySecTop), pt(xLidL, yTabTop)],
        });

        // ── LƯỠI GÀI (front lock tab) — panel con của nắp phụ ──
        // Gập luồn vào khe trên vách trước (chỉ khi bật pizzaFrontLock).
        if (params.pizzaFrontLock) {
            const tabPaths: PathSegment[] = [
                line(pt(tlx, ySecTop), pt(tlx, snap(ySecTop + lockH)), 'CUT'),
                line(pt(tlx, snap(ySecTop + lockH)), pt(trx, snap(ySecTop + lockH)), 'CUT'),
                line(pt(trx, snap(ySecTop + lockH)), pt(trx, ySecTop), 'CUT'),
            ];
            allPaths.push(...tabPaths);
            panels.push({
                name: 'front_lock_tab', label: 'Lưỡi gài', paths: tabPaths,
                parent: 'secondary_lid',
                pivotEdge: [pt(tlx, ySecTop), pt(trx, ySecTop)],
                // Gập CÙNG LÚC với 2 tai quạt (cùng là con nắp phụ, gập trước khi
                // nắp phụ đậy). Tư thế cuối: luồn vào khe vách trước.
                foldAngle: 90, foldDirection: 1,
                foldPhase: [0.8, 0.88],
                outline: [pt(tlx, ySecTop), pt(trx, ySecTop), pt(trx, snap(ySecTop + lockH)), pt(tlx, snap(ySecTop + lockH))],
            });
        }

        // --- 2 TAI QUẠT — bezier mượt (Cup Sleeve formula) ---
        // R = D - T; bo góc dưới = bezier fillet; góc trên = sắc
        const fR = snap(Math.min(tabR * PIZZA_FAN_FILLET_RATIO, PIZZA_FAN_FILLET_MAX));

        // arcToBezier đã extract ra utils.ts — dùng shared function

        function buildFanTabSegments(cx: number, cy: number, xDir: 1 | -1): PathSegment[] {
            const segs: PathSegment[] = [];

            // ── Hình học tiếp tuyến chính xác ──
            // Main arc: tâm O1=(cx,cy), bán kính R=tabR
            // Fillet arc: tâm O2, bán kính r=fR, tiếp xúc trong với main arc + tiếp tuyến đường y=cy
            // |O1-O2| = R-r (tiếp xúc trong)
            // O2.y = cy+r (tiếp tuyến đường ngang)
            // → O2.x = cx + xDir * sqrt((R-r)² - r²)
            const R = tabR, r = fR;
            const d = Math.sqrt((R - r) * (R - r) - r * r); // khoảng cách ngang chính xác
            const tangentAngleDeg = Math.atan2(r, d) * 180 / Math.PI; // góc giao tiếp tuyến

            // Cung chính: 90° → tangentAngleDeg (right) hoặc 90° → 180-tangentAngleDeg (left)
            const mainEndDeg = xDir === 1 ? tangentAngleDeg : (180 - tangentAngleDeg);
            const midDeg = (90 + mainEndDeg) / 2;

            // Bezier 1: 90° → midDeg (~45°)
            segs.push(arcToBezier(cx, cy, R, 90, midDeg, 'CUT'));
            // Bezier 2: midDeg → mainEndDeg (~45°)
            segs.push(arcToBezier(cx, cy, R, midDeg, mainEndDeg, 'CUT'));

            // ── Fillet bo góc dưới (tiếp xúc chính xác) ──
            const fCx = snap(cx + xDir * d);
            const fCy = snap(cy + r);
            // Góc bắt đầu fillet = cùng tangentAngle (nhìn từ fillet center)
            const fStartDeg = xDir === 1 ? tangentAngleDeg : (180 - tangentAngleDeg);
            // Góc kết thúc = -90° (điểm đáy, y=cy)
            const fEndDeg = xDir === 1 ? -90 : 270;
            segs.push(arcToBezier(fCx, fCy, r, fStartDeg, fEndDeg, 'CUT'));

            // Đường thẳng về pivot
            const filletEnd = pt(snap(fCx), cy); // đáy fillet = (fCx, cy)
            const pivot = pt(cx, cy);
            segs.push(line(filletEnd, pivot, 'CUT'));

            return segs;
        }

        // ── BÊN PHẢI ──
        {
            // Bản lề tai quạt đặt tại MÉP TRONG xLidR (trùng pivot nắp phụ) để khi
            // gập, tai quạt cắm vào trong lòng hộp/khe gờ hông — KHÔNG úp ra mặt
            // ngoài vách (mép ngoài x=L).
            const cx = xLidR, cy = ySecBot;
            const tabSegs = buildFanTabSegments(cx, cy, 1);

            allPaths.push(line(pt(cx, cy), pt(cx, snap(cy + tabR)), 'CREASE'));
            allPaths.push(...tabSegs);
            secTabRightPaths = tabSegs;
            fanToLidR = undefined; // bản lề đã trùng mép tai nắp, không cần đường nối
            panels.push({
                name: 'sec_tab_right', label: 'Tai quạt phải', paths: tabSegs,
                parent: 'secondary_lid',
                pivotEdge: [pt(cx, cy), pt(cx, snap(cy + tabR))],
                foldAngle: -90, foldDirection: 1,
                // Gập TRƯỚC khi nắp phụ gập xuống (nắp phụ ~[0.6,0.8]) để 2 tai
                // quạt luôn dính theo nắp phụ suốt animation.
                foldPhase: [0.8, 0.88],
                outline: [pt(cx, ySecBot), pt(cx, snap(ySecBot + tabR)), ...getOutlinePoints(tabSegs)],
            });
        }

        // ── BÊN TRÁI = mirror bên phải: x → L - x → tâm tại xLidL ──
        {
            const cx = xLidL, cy = ySecBot;
            const tabSegs = buildFanTabSegments(xLidR, ySecBot, 1).map(seg => ({
                ...seg,
                points: seg.points.map(p => pt(snap(L - p.x), p.y)),
                ...(seg.controlPoints ? {
                    controlPoints: seg.controlPoints.map(p => pt(snap(L - p.x), p.y)) as [Point2D, Point2D, Point2D, Point2D],
                } : {}),
            }));

            allPaths.push(line(pt(cx, cy), pt(cx, snap(cy + tabR)), 'CREASE'));
            allPaths.push(...tabSegs);
            secTabLeftPaths = tabSegs;
            fanToLidL = undefined; // bản lề đã trùng mép tai nắp, không cần đường nối
            panels.push({
                name: 'sec_tab_left', label: 'Tai quạt trái', paths: tabSegs,
                parent: 'secondary_lid',
                pivotEdge: [pt(cx, cy), pt(cx, snap(cy + tabR))],
                foldAngle: 90, foldDirection: 1,
                // Gập TRƯỚC khi nắp phụ gập xuống — xem sec_tab_right.
                foldPhase: [0.8, 0.88],
                outline: [pt(cx, ySecBot), pt(cx, snap(ySecBot + tabR)), ...getOutlinePoints(tabSegs)],
            });
        }
    }

    // ============================================================
    // 5. TẠO DANH SÁCH PANELS (CÁC MẶT PHẲNG 3D) — hình thang thẳng, đơn giản
    //    Mọc dọc Y từ Front, Back và Lid
    //
    //    NOTE: Pizza dùng hình thang đơn giản (không bezier bo góc)
    //    khác với shared buildDustFlap trong sharedHelpers.ts.
    //    Lý do: pizza dust flaps ngắn (D thường ≤ W/3), bo góc
    //    bezier không cần thiết và gây phức tạp hình học.
    // ============================================================

    function buildPizzaDustFlap(
        yBot: number, yTop: number,
        xBase: number, height: number,
        dir: 1 | -1,
        topConnectX?: number,  // Nếu set: cạnh trên đi thẳng tới X này (nối tai nắp)
    ): PathSegment[] {
        const paths: PathSegment[] = [];
        const h = yTop - yBot;
        const xTip = snap(xBase + dir * height);

        // Tỷ lệ xiên (dùng constant thay magic number)
        const sx = snap(h * PIZZA_DUST_SKEW_RATIO);

        // Điểm góc dưới (luôn xiên)
        const pBB = pt(xBase, yBot);
        const pMB = pt(snap(xBase + dir * sx), snap(yBot + sx));
        const pTB = pt(xTip, snap(yBot + 2 * sx));
        const pTT = pt(xTip, snap(yTop - 2 * sx));

        // CUT: dưới xiên
        paths.push(line(pBB, pMB, 'CUT'));
        paths.push(line(pMB, pTB, 'CUT'));
        // CUT: ngoài
        paths.push(line(pTB, pTT, 'CUT'));

        if (topConnectX !== undefined) {
            // Cạnh trên xiên cân đối (giống cạnh dưới: pBB→pMB→pTB)
            const pConnect = pt(topConnectX, yTop);
            const pMT = pt(snap(topConnectX + dir * sx), snap(yTop - sx));
            paths.push(line(pTT, pMT, 'CUT'));    // xiên trên - đoạn dài
            paths.push(line(pMT, pConnect, 'CUT')); // xiên trên - đoạn ngắn (≈ dust_back[0])
        } else {
            // Xiên cân đối cả 2 bên (tai trước)
            const pMT = pt(snap(xBase + dir * sx), snap(yTop - sx));
            const pBT = pt(xBase, yTop);
            paths.push(line(pTT, pMT, 'CUT'));
            paths.push(line(pMT, pBT, 'CUT'));
        }

        return paths;
    }

    // Dust flap Front-Left (mọc sang trái từ Front, tại xFrontL)
    const dfFL = buildPizzaDustFlap(snap(-D), 0, xFrontL, D, -1);
    // Pivot CREASE đã nằm trong frontPaths (trái), không cần thêm
    allPaths.push(...dfFL);
    panels.push({
        name: 'dust_front_left', label: 'Tai trước‑trái', paths: dfFL,
        parent: 'front', pivotEdge: [pt(xFrontL, snap(-D)), pt(xFrontL, 0)],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.2, 0.33],
        outline: [pt(xFrontL, 0), pt(xFrontL, snap(-D)), ...getOutlinePoints(dfFL)],
    });

    // Dust flap Front-Right (mọc sang phải từ Front, tại xFrontR)
    const dfFR = buildPizzaDustFlap(snap(-D), 0, xFrontR, D, 1);
    // Pivot CREASE đã nằm trong frontPaths (phải), không cần thêm
    allPaths.push(...dfFR);
    panels.push({
        name: 'dust_front_right', label: 'Tai trước‑phải', paths: dfFR,
        parent: 'front', pivotEdge: [pt(xFrontR, snap(-D)), pt(xFrontR, 0)],
        foldAngle: -90, foldDirection: 1,
        foldPhase: [0.2, 0.33],
        outline: [pt(xFrontR, 0), pt(xFrontR, snap(-D)), ...getOutlinePoints(dfFR)],
    });

    // Dust flap Back-Left (mọc sang trái từ Back, tại xFrontL)
    // topConnectX = xLidL — để cạnh trên nối thẳng với tai nắp trái
    const dfBL = buildPizzaDustFlap(W, snap(W + D), xFrontL, D, -1, xLidL);
    // Pivot CREASE đã nằm trong backPaths (trái), không cần thêm
    allPaths.push(...dfBL);
    panels.push({
        name: 'dust_back_left', label: 'Tai sau‑trái', paths: dfBL,
        parent: 'back', pivotEdge: [pt(xFrontL, W), pt(xFrontL, snap(W + D))],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.2, 0.33],
        outline: [pt(xFrontL, snap(W + D)), pt(xFrontL, W), ...getOutlinePoints(dfBL)],
    });

    // Dust flap Back-Right (mọc sang phải từ Back, tại xFrontR)
    // topConnectX = xLidR — để cạnh trên nối thẳng với tai nắp phải
    const dfBR = buildPizzaDustFlap(W, snap(W + D), xFrontR, D, 1, xLidR);
    // Pivot CREASE đã nằm trong backPaths (phải), không cần thêm
    allPaths.push(...dfBR);
    panels.push({
        name: 'dust_back_right', label: 'Tai sau‑phải', paths: dfBR,
        parent: 'back', pivotEdge: [pt(xFrontR, W), pt(xFrontR, snap(W + D))],
        foldAngle: -90, foldDirection: 1,
        foldPhase: [0.2, 0.33],
        outline: [pt(xFrontR, snap(W + D)), pt(xFrontR, W), ...getOutlinePoints(dfBR)],
    });

    // ── TAI NẮP (lid flaps) — bezier bo góc giống buildDustFlap ──
    let dfLL: PathSegment[] = [];
    let dfLR: PathSegment[] = [];
    {
        const inset = snap(D * PIZZA_LID_FLAP_INSET_RATIO); // Xiên ~20% depth
        const height = D;
        const boGoc = snap(Math.min(inset * 0.5, 5)); // Bán kính bo

        function buildOneSideLidFlap(dir: 1 | -1, xBase: number): PathSegment[] {
            const paths: PathSegment[] = [];
            const tx = (lx: number) => snap(xBase + dir * lx);

            // 4 điểm góc (local x: 0=base, height=tip)
            const pBot = pt(tx(0), yLidBot);
            const pTop = pt(tx(0), yLidTop);
            const cBot = pt(tx(height), snap(yLidBot + inset));  // corner bottom
            const cTop = pt(tx(height), snap(yLidTop - inset));  // corner top

            // Bo góc dưới: tại cBot (pBot → cBot → cTop)
            const fBot = filletBezier(cBot, pBot, cTop, boGoc, 'CUT');
            const tBot1 = fBot.points[0];
            const tBot2 = fBot.points[fBot.points.length - 1];

            // Bo góc trên: tại cTop (cBot → cTop → pTop)
            const fTop = filletBezier(cTop, cBot, pTop, boGoc, 'CUT');
            const tTop1 = fTop.points[0];
            const tTop2 = fTop.points[fTop.points.length - 1];

            // Vẽ: xiên dưới → bo → thẳng → bo → xiên trên (2 đoạn, giống dust_back)
            paths.push(line(pBot, tBot1, 'CUT'));    // 1. Xiên dưới
            paths.push(fBot);                         // 2. Bo góc dưới
            paths.push(line(tBot2, tTop1, 'CUT'));    // 3. Ngoài thẳng
            paths.push(fTop);                         // 4. Bo góc trên

            // 5+6. Xiên trên — chia 2 đoạn (tương tự dust_back[0]+[1])
            // pMTop = điểm gấp khúc xiên, tạo góc rộng hơn để bo tốt hơn
            const skewH = snap(height * PIZZA_DUST_SKEW_RATIO);
            const pMTop = pt(snap(pTop.x + dir * skewH), snap(pTop.y - skewH));
            paths.push(line(tTop2, pMTop, 'CUT'));   // 5. Xiên trên - đoạn dài
            paths.push(line(pMTop, pTop, 'CUT'));    // 6. Xiên trên - đoạn ngắn (≈ dust_back[0])

            return paths;
        }

        // Lid-Left (tại xLidL)
        dfLL = buildOneSideLidFlap(-1, xLidL);
        allPaths.push(line(pt(xLidL, yLidBot), pt(xLidL, yLidTop), 'CREASE'));
        allPaths.push(...dfLL);
        panels.push({
            name: 'dust_lid_left', label: 'Tai nắp‑trái', paths: dfLL,
            parent: 'lid', pivotEdge: [pt(xLidL, yLidBot), pt(xLidL, yLidTop)],
            foldAngle: 90, foldDirection: 1,
            // Gập TRƯỚC khi nắp chính đậy (lid auto-phase ~[0.4,0.6]) để tai luôn
            // dính sát theo nắp suốt animation (đúng thứ tự lắp: gập tai → đậy nắp).
            foldPhase: [0.55, 0.66],
            outline: [pt(xLidL, yLidTop), pt(xLidL, yLidBot), ...getOutlinePoints(dfLL)],
        });

        // Lid-Right (tại xLidR)
        dfLR = buildOneSideLidFlap(1, xLidR);
        allPaths.push(line(pt(xLidR, yLidBot), pt(xLidR, yLidTop), 'CREASE'));
        allPaths.push(...dfLR);
        panels.push({
            name: 'dust_lid_right', label: 'Tai nắp‑phải', paths: dfLR,
            parent: 'lid', pivotEdge: [pt(xLidR, yLidBot), pt(xLidR, yLidTop)],
            foldAngle: -90, foldDirection: 1,
            // Gập TRƯỚC khi nắp chính đậy — xem dust_lid_left.
            foldPhase: [0.55, 0.66],
            outline: [pt(xLidR, yLidTop), pt(xLidR, yLidBot), ...getOutlinePoints(dfLR)],
        });
    }

    // ============================================================
    // 6. VÁCH HÔNG CUỘN (SIDE WALLS) — mọc ngang từ Bottom
    //    Cùng kiểu dáng với mailer's buildSideWallHoriz
    //    nhưng xoay 90° (mọc theo X thay vì Y)
    // ============================================================
    // Tách vách hông thành 3 phần để gập đúng cấu tạo "cuộn" (2 đường nhấn X1, X2):
    //  - THÂN vách (body): gập lên 90° tại mép đáy → cao đúng D, sát nắp.
    //  - GỜ MÉP (rim): dải hẹp giữa X1↔X2, gập 90° tại X1 → tạo gờ mép trên.
    //  - MẶT TRONG (inner) + tab khóa: gập 90° tại X2 → thả xuống lòng hộp,
    //    đầu tab cắm về phía khe đáy. Cả 2 đường nhấn đều là nếp gập thật.
    function buildSideWallVert(isRight: boolean): {
        body: PathSegment[];
        rim: PathSegment[];
        inner: PathSegment[];
        bodyOutline: Point2D[];
        rimOutline: Point2D[];
        innerOutline: Point2D[];
        X1: number;
        X2: number;
    } {
        const dirX = isRight ? 1 : -1;
        const X0 = isRight ? L : 0;
        const xFoot = isRight ? xFrontR : xFrontL;

        const X1 = snap(X0 + dirX * D);                 // đỉnh vách (bản lề thân↔gờ mép)
        const X2 = snap(X0 + dirX * (D + T_fold));      // bản lề gờ mép↔mặt trong
        const X_base = snap(X0 + dirX * X_outer);
        const X_tab_ext = snap(X0 + dirX * X_tab);
        const barb = params.pizzaCornerLock ? snap(Math.min(2, sl * 0.25)) : 0;
        const Cw = snap(W - C);

        // ── THÂN VÁCH (rộng đúng D) ──
        const body: PathSegment[] = [
            line(pt(xFoot, 0), pt(X1, 0), 'CUT'),       // đáy
            line(pt(X1, 0), pt(X1, W), 'CREASE'),       // đỉnh vách = bản lề gờ mép
            line(pt(X1, W), pt(xFoot, W), 'CUT'),       // mép trên
        ];
        const bodyOutline: Point2D[] = [
            pt(X0, 0), pt(xFoot, 0), pt(X1, 0), pt(X1, W), pt(xFoot, W), pt(X0, W),
        ];

        // ── GỜ MÉP (dải X1↔X2) ──
        const rim: PathSegment[] = [
            line(pt(X1, 0), pt(X2, C), 'CUT'),          // vát góc dưới
            line(pt(X2, C), pt(X2, Cw), 'CREASE'),      // đường nhấn X2 = bản lề mặt trong
            line(pt(X2, Cw), pt(X1, W), 'CUT'),         // vát góc trên
        ];
        const rimOutline: Point2D[] = [
            pt(X1, 0), pt(X2, C), pt(X2, Cw), pt(X1, W),
        ];

        // ── MẶT TRONG + 2 TAB KHÓA (trace từ X2,C → X2,Cw) ──
        const inner: PathSegment[] = [
            line(pt(X2, C), pt(X_base, C), 'CUT'),
            line(pt(X_base, C), pt(X_base, so), 'CUT'),
            line(pt(X_base, so), pt(X_tab_ext, snap(so - barb)), 'CUT'),
            line(pt(X_tab_ext, snap(so - barb)), pt(X_tab_ext, snap(so + sl + barb)), 'CUT'),
            line(pt(X_tab_ext, snap(so + sl + barb)), pt(X_base, snap(so + sl)), 'CUT'),
            line(pt(X_base, snap(so + sl)), pt(X_base, snap(W - so - sl)), 'CUT'),
            line(pt(X_base, snap(W - so - sl)), pt(X_tab_ext, snap(W - so - sl - barb)), 'CUT'),
            line(pt(X_tab_ext, snap(W - so - sl - barb)), pt(X_tab_ext, snap(W - so + barb)), 'CUT'),
            line(pt(X_tab_ext, snap(W - so + barb)), pt(X_base, snap(W - so)), 'CUT'),
            line(pt(X_base, snap(W - so)), pt(X_base, Cw), 'CUT'),
            line(pt(X_base, Cw), pt(X2, Cw), 'CUT'),
        ];
        const innerOutline: Point2D[] = [
            pt(X2, C), pt(X_base, C), pt(X_base, so),
            pt(X_tab_ext, snap(so - barb)), pt(X_tab_ext, snap(so + sl + barb)),
            pt(X_base, snap(so + sl)), pt(X_base, snap(W - so - sl)),
            pt(X_tab_ext, snap(W - so - sl - barb)), pt(X_tab_ext, snap(W - so + barb)),
            pt(X_base, snap(W - so)), pt(X_base, Cw), pt(X2, Cw),
        ];

        return { body, rim, inner, bodyOutline, rimOutline, innerOutline, X1, X2 };
    }

    // Side Wall Left
    const swLeft = buildSideWallVert(false);
    allPaths.push(...swLeft.body, ...swLeft.rim, ...swLeft.inner);
    panels.push({
        name: 'side_left', label: 'Hông trái', paths: swLeft.body,
        parent: 'bottom', pivotEdge: [pt(0, 0), pt(0, W)],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.33, 0.42],
        outline: swLeft.bodyOutline,
    });
    panels.push({
        name: 'side_left_rim', label: 'Gờ hông trái', paths: swLeft.rim,
        parent: 'side_left', pivotEdge: [pt(swLeft.X1, 0), pt(swLeft.X1, W)],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.42, 0.48],
        outline: swLeft.rimOutline,
    });
    panels.push({
        name: 'side_left_roll', label: 'Cuộn hông trái', paths: swLeft.inner,
        parent: 'side_left_rim', pivotEdge: [pt(swLeft.X2, C), pt(swLeft.X2, snap(W - C))],
        foldAngle: 90, foldDirection: 1,
        foldPhase: [0.48, 0.55],
        outline: swLeft.innerOutline,
    });

    // Side Wall Right
    const swRight = buildSideWallVert(true);
    allPaths.push(...swRight.body, ...swRight.rim, ...swRight.inner);
    panels.push({
        name: 'side_right', label: 'Hông phải', paths: swRight.body,
        parent: 'bottom', pivotEdge: [pt(L, 0), pt(L, W)],
        foldAngle: -90, foldDirection: 1,
        foldPhase: [0.33, 0.42],
        outline: swRight.bodyOutline,
    });
    panels.push({
        name: 'side_right_rim', label: 'Gờ hông phải', paths: swRight.rim,
        parent: 'side_right', pivotEdge: [pt(swRight.X1, 0), pt(swRight.X1, W)],
        foldAngle: 90, foldDirection: -1,
        foldPhase: [0.42, 0.48],
        outline: swRight.rimOutline,
    });
    panels.push({
        name: 'side_right_roll', label: 'Cuộn hông phải', paths: swRight.inner,
        parent: 'side_right_rim', pivotEdge: [pt(swRight.X2, C), pt(swRight.X2, snap(W - C))],
        foldAngle: 90, foldDirection: -1,
        foldPhase: [0.48, 0.55],
        outline: swRight.innerOutline,
    });

    // ============================================================
    // 8. BO GÓC NHỎ tại các junction CUT giao nhau
    // ============================================================

    // --- helpers ---
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
        // pull=0.9 → đỉnh curve sát crease (corner nằm trên crease)
        const pull = 0.9;
        const cp1 = pt(snap(t1.x + (corner.x - t1.x) * pull), snap(t1.y + (corner.y - t1.y) * pull));
        const cp2 = pt(snap(t2.x + (corner.x - t2.x) * pull), snap(t2.y + (corner.y - t2.y) * pull));
        return {
            points: [t1, t2],
            tag: 'CUT',
            type: 'bezier',
            controlPoints: [t1, cp1, cp2, t2],
        };
    };

    // Kéo dài 2 cạnh ra đủ thấy, đỉnh vẫn sát crease nhờ pull=0.9
    const filletR = snap(Math.max(T * 3, 2));

    // --- Generic corner connector ---
    // Nối 2 CUT segments tại corner gần nhau, kéo dài edges + bo nhọn
    const connectCutCorner = (
        segA: PathSegment, aIsEnd: boolean, arrA: PathSegment[],
        segB: PathSegment, bIsEnd: boolean, arrB: PathSegment[],
        overrideR?: number,
    ) => {
        const pA = aIsEnd ? segA.points[segA.points.length - 1] : segA.points[0];
        const pB = bIsEnd ? segB.points[segB.points.length - 1] : segB.points[0];
        const gap = Math.abs(pA.x - pB.x) + Math.abs(pA.y - pB.y);
        if (gap > D * 2) return;

        const meet = lineIntersect(segA.points[0], segA.points[segA.points.length - 1],
            segB.points[0], segB.points[segB.points.length - 1]);
        if (!meet) return;

        // Kéo dài endpoints
        if (aIsEnd) segA.points[segA.points.length - 1] = meet;
        else segA.points[0] = meet;
        if (bIsEnd) segB.points[segB.points.length - 1] = meet;
        else segB.points[0] = meet;

        // Bo nhọn
        const prevPt = aIsEnd ? segA.points[segA.points.length - 2] || segA.points[0] : segA.points[1];
        const nextPt = bIsEnd ? segB.points[segB.points.length - 2] || segB.points[0] : segB.points[1];
        const fillet = pointedFillet(meet, prevPt, nextPt, overrideR ?? filletR);

        if (aIsEnd) segA.points[segA.points.length - 1] = fillet.points[0];
        else segA.points[0] = fillet.points[0];
        if (bIsEnd) segB.points[segB.points.length - 1] = fillet.points[fillet.points.length - 1];
        else segB.points[0] = fillet.points[fillet.points.length - 1];

        // Splice + push
        if (aIsEnd) { const idx = arrA.indexOf(segA); arrA.splice(idx + 1, 0, fillet); }
        else { const idx = arrA.indexOf(segA); arrA.splice(idx, 0, fillet); }
        allPaths.push(fillet);
    };

    // --- Dust Front-Left ↔ Side Wall Left tại (xFrontL, 0) ---
    // dfFL last seg endpoint ≈ (xFrontL, 0), swLeftPaths chân bottom ≈ (xFrontL, 0)
    connectCutCorner(dfFL[dfFL.length - 1], true, dfFL, swLeft.body[0], false, swLeft.body);
    // dfFL first seg endpoint ≈ (xFrontL, -D), swLeftPaths ... ko cần vì front edge là CREASE

    // --- Dust Front-Right ↔ Side Wall Right tại (xFrontR, 0) ---
    connectCutCorner(dfFR[dfFR.length - 1], true, dfFR, swRight.body[0], false, swRight.body);

    // --- Dust Front-Left bottom ↔ Front bottom-left ---
    // dfFL[0] start ≈ (xFrontL, -D), frontPaths bottom ≈ (xFrontL, -D)
    connectCutCorner(dfFL[0], false, dfFL, frontPaths[1], false, frontPaths);

    // --- Dust Front-Right bottom ↔ Front bottom-right ---
    connectCutCorner(dfFR[0], false, dfFR, frontPaths[1], true, frontPaths);

    // --- Dust Back ↔ Lid Flap: đỉnh bo phải giao với crease tai nắp ---
    // pointedFillet với pull cao → đỉnh curve hướng về corner (= điểm crease)
    {
        const lidD = snap(T); // Khoảng lùi nhỏ → đỉnh sát crease
        const lidPull = 0.9;  // Gần 1.0 → đỉnh curve chạm crease

        const makeLidFillet = (corner: Point2D, prev: Point2D, next: Point2D): PathSegment => {
            const dx1 = prev.x - corner.x, dy1 = prev.y - corner.y;
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const dx2 = next.x - corner.x, dy2 = next.y - corner.y;
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (len1 < 0.01 || len2 < 0.01) return line(prev, next, 'CUT');
            const dc = Math.min(lidD, len1 / 2, len2 / 2);
            const t1 = pt(snap(corner.x + (dx1 / len1) * dc), snap(corner.y + (dy1 / len1) * dc));
            const t2 = pt(snap(corner.x + (dx2 / len2) * dc), snap(corner.y + (dy2 / len2) * dc));
            const cp1 = pt(snap(t1.x + (corner.x - t1.x) * lidPull), snap(t1.y + (corner.y - t1.y) * lidPull));
            const cp2 = pt(snap(t2.x + (corner.x - t2.x) * lidPull), snap(t2.y + (corner.y - t2.y) * lidPull));
            return { points: [t1, t2], tag: 'CUT', type: 'bezier', controlPoints: [t1, cp1, cp2, t2] };
        };

        // LEFT: dfBL last → dfLL first
        const segA = dfBL[dfBL.length - 1];
        const segB = dfLL[0];
        const cornerL = lineIntersect(segA.points[0], segA.points[segA.points.length - 1],
            segB.points[0], segB.points[segB.points.length - 1]);
        if (cornerL) {
            segA.points[segA.points.length - 1] = cornerL;
            segB.points[0] = cornerL;
            const fL = makeLidFillet(cornerL, segA.points[segA.points.length - 2] || segA.points[0], segB.points[1]);
            segA.points[segA.points.length - 1] = fL.points[0];
            segB.points[0] = fL.points[fL.points.length - 1];
            dfBL.splice(dfBL.indexOf(segA) + 1, 0, fL);
            allPaths.push(fL);
        }

        // RIGHT: dfBR last → dfLR first
        const segC = dfBR[dfBR.length - 1];
        const segD = dfLR[0];
        const cornerR = lineIntersect(segC.points[0], segC.points[segC.points.length - 1],
            segD.points[0], segD.points[segD.points.length - 1]);
        if (cornerR) {
            segC.points[segC.points.length - 1] = cornerR;
            segD.points[0] = cornerR;
            const fR = makeLidFillet(cornerR, segC.points[segC.points.length - 2] || segC.points[0], segD.points[1]);
            segC.points[segC.points.length - 1] = fR.points[0];
            segD.points[0] = fR.points[fR.points.length - 1];
            dfBR.splice(dfBR.indexOf(segC) + 1, 0, fR);
            allPaths.push(fR);
        }
    }

    // --- Side Wall Left top ↔ Dust Back-Left bottom at (xFrontL, W) ---
    const deepR = snap(Math.max(T * 20, 15));
    connectCutCorner(swLeft.body[swLeft.body.length - 1], true, swLeft.body, dfBL[0], false, dfBL, deepR);

    // --- Side Wall Right top ↔ Dust Back-Right bottom at (xFrontR, W) ---
    connectCutCorner(swRight.body[swRight.body.length - 1], true, swRight.body, dfBR[0], false, dfBR, deepR);

    // --- fanToLid endpoint ↔ dust_lid[last] endpoint: bo góc hướng vào thân hộp ---
    // Dùng pointedFillet (curve hướng vào corner) thay vì filletBezier (curve ra ngoài)
    {
        const d = snap(Math.max(T * 20, 15)); // khoảng lùi tangent — rộng hơn → góc mở
        const pull = 0.92; // cao hơn → đỉnh curve ăn sâu vào thân hộp

        const applyInwardFillet = (bridge: PathSegment, lidSeg: PathSegment) => {
            // Corner là điểm chung của bridge end và lidSeg end
            const corner = bridge.points[bridge.points.length - 1];
            const prevDir = bridge.points[0]; // hướng từ corner về bridge start
            const nextDir = lidSeg.points[lidSeg.points.length - 2] || lidSeg.points[0];

            // Tính tangent points
            const dx1 = prevDir.x - corner.x, dy1 = prevDir.y - corner.y;
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const dx2 = nextDir.x - corner.x, dy2 = nextDir.y - corner.y;
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (len1 < 0.01 || len2 < 0.01) return;

            const dc = Math.min(d, len1 / 2, len2 / 2);
            const t1 = pt(snap(corner.x + (dx1 / len1) * dc), snap(corner.y + (dy1 / len1) * dc));
            const t2 = pt(snap(corner.x + (dx2 / len2) * dc), snap(corner.y + (dy2 / len2) * dc));
            const cp1 = pt(snap(t1.x + (corner.x - t1.x) * pull), snap(t1.y + (corner.y - t1.y) * pull));
            const cp2 = pt(snap(t2.x + (corner.x - t2.x) * pull), snap(t2.y + (corner.y - t2.y) * pull));
            const fillet: PathSegment = {
                points: [t1, t2], tag: 'CUT', type: 'bezier',
                controlPoints: [t1, cp1, cp2, t2],
            };
            bridge.points[bridge.points.length - 1] = t1;
            lidSeg.points[lidSeg.points.length - 1] = t2;
            allPaths.push(fillet);
        };

        // RIGHT
        if (fanToLidR && dfLR.length > 0) {
            applyInwardFillet(fanToLidR, dfLR[dfLR.length - 1]);
        }
        // LEFT
        if (fanToLidL && dfLL.length > 0) {
            applyInwardFillet(fanToLidL, dfLL[dfLL.length - 1]);
        }
    }

    // ============================================================
    // 9. Bounding Box & Return
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    // ── Print-side outward (mockup 3D) ─────────────────────────────
    // Quy ước render: ảnh in gán local +Z. Hộp pizza (root = bottom) gập
    // volume về phía +Z với foldDirection gốc → mặt in quay VÀO lòng.
    // Đảo foldDirection mọi panel (trừ cuộn hông *_roll — đã gập đúng
    // chiều gài slot) để +Z ra ngoài sau gập, khớp RTE/SLB/Gable.
    for (const p of panels) {
        if (p.name.endsWith('_roll')) continue;
        const d = p.foldDirection || 1;
        p.foldDirection = (d * -1) as 1 | -1;
    }

    return {
        name: 'Pizza Box',
        standardCode: 'FEFCO-0426',
        description: 'Hộp pizza — khay vách tự khóa, nắp bản lề (FEFCO 0426)',
        panels, allPaths, boundingBox: bb, params,
    };
}

