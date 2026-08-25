// ============================================================
// Envelope — Bì thư (Wallet / Pocket)
//
// Hỗ trợ:
//   - Wallet (nắp dọc, cạnh dài) — phổ biến nhất
//   - Pocket (nắp ngang, cạnh ngắn) — gửi hồ sơ A4
//   - 3 dạng nắp: straight, pointed, rounded
//   - Cửa sổ trong suốt (window) tuỳ chọn
//
// Layout trải phẳng (wallet, nhìn từ trên):
//
//        ┌───────────────────────────┐
//        │         Seal Flap          │  FH
//        ├───────────────────────────┤  CREASE
//        │                           │
//   ┌────┤       BACK PANEL          ├────┐
//   │Side│          (W)              │Side│  SF
//   │ L  │         H                 │ R  │
//   └────┤                           ├────┘
//        ├───────────────────────────┤  CREASE
//        │      FRONT PANEL          │  H
//        │   (đáy dán bịt kín)       │
//        └───────────────────────────┘
//
//   Gốc (0,0) = góc dưới-trái Front Panel
//   Đáy bì thư dán bịt — KHÔNG có bottom flap
// ============================================================

import {
    BoxParams,
    DielineModel,
    Panel,
    PathSegment,
} from './types';

import {
    pt,
    line,
    snap,
    computeBoundingBox,
    bezierSegment,
    arcToBezier,
    filletBezier,
} from './utils';

// ── Auto-calc helpers ──────────────────────────────────────
function autoFlapH(envH: number): number {
    // Nắp dán = ~45% chiều cao bì thư (tiêu chuẩn phổ biến)
    return snap(Math.round(envH * 0.45));
}

function autoSideFlap(envH: number): number {
    // Tai hông = ~12mm (đủ dán, không quá rộng)
    return snap(Math.max(10, Math.min(15, envH * 0.12)));
}

// ── Custom fillet: CP arm = 0.55*d (không phụ thuộc góc) ──
// filletBezier bị overshoot ở góc tù vì kappa tỷ lệ tan(α/2).
// Tự tính bezier với CP arm cố định tỷ lệ tangent distance.
function smoothFillet(
    corner: ReturnType<typeof pt>,
    prev: ReturnType<typeof pt>,
    next: ReturnType<typeof pt>,
    radius: number,
) {
    const dx1 = prev.x - corner.x, dy1 = prev.y - corner.y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const dx2 = next.x - corner.x, dy2 = next.y - corner.y;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const dot = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (len1 * len2)));
    const alpha = Math.acos(dot);
    const halfTan = Math.tan(alpha / 2);
    // d = khoảng cách corner→tangent, clip ở nửa cạnh ngắn
    const d = Math.min(halfTan > 0 ? radius / halfTan : 0, len1 * 0.45, len2 * 0.45);
    if (d <= 0) return { seg: line(prev, next, 'CUT'), t1: prev, t2: next };
    const ux1 = dx1 / len1, uy1 = dy1 / len1;
    const ux2 = dx2 / len2, uy2 = dy2 / len2;
    const t1 = pt(snap(corner.x + ux1 * d), snap(corner.y + uy1 * d));
    const t2 = pt(snap(corner.x + ux2 * d), snap(corner.y + uy2 * d));
    // CP arm cố định = 0.55 * d (không phụ thuộc góc tù/nhọn)
    const arm = d * 0.55;
    const cp1 = pt(snap(t1.x - arm * ux1), snap(t1.y - arm * uy1));
    const cp2 = pt(snap(t2.x - arm * ux2), snap(t2.y - arm * uy2));
    return { seg: bezierSegment(t1, cp1, cp2, t2, 'CUT'), t1, t2 };
}

// ── Seal Flap Shape Builders ──────────────────────────────
function buildSealFlap(
    xLeft: number, xRight: number,
    sealBaseY: number, flapH: number,
    shape: 'straight' | 'pointed' | 'rounded',
): PathSegment[] {
    const w = snap(xRight - xLeft);
    const yTop = snap(sealBaseY + flapH);
    const paths: PathSegment[] = [];

    switch (shape) {
        case 'straight': {
            // Cạnh xiên 10° chạy thẳng 1 mạch từ đáy lên đỉnh
            const sideInset = snap(flapH * Math.tan(10 * Math.PI / 180)); // Xiên 10° toàn bộ chiều cao
            const sideR = snap(Math.min(5, flapH * 0.2)); // Bo góc tại đỉnh

            const pL0 = pt(xLeft, sealBaseY);                             // đáy trái
            const pLtop = pt(snap(xLeft + sideInset), yTop);              // đỉnh trái
            const pRtop = pt(snap(xRight - sideInset), yTop);             // đỉnh phải
            const pR0 = pt(xRight, sealBaseY);                            // đáy phải

            // Bo góc tại đỉnh: xiên gặp ngang
            const fL = smoothFillet(pLtop, pL0, pRtop, sideR);
            const fR = smoothFillet(pRtop, pLtop, pR0, sideR);

            paths.push(
                line(pL0, fL.t1, 'CUT'),       // 1. Xiên trái → tangent
                fL.seg,                         // 2. Bo góc đỉnh trái
                line(fL.t2, fR.t1, 'CUT'),     // 3. Cạnh ngang trên
                fR.seg,                         // 4. Bo góc đỉnh phải
                line(fR.t2, pR0, 'CUT'),       // 5. Xiên phải
            );
            break;
        }
        case 'pointed': {
            const cx = snap((xLeft + xRight) / 2);
            const tipR = snap(Math.min(3, flapH * 0.08));
            const sideH = 28;  // Cạnh bên cao 28mm
            const sideInset = snap(sideH * Math.tan(10 * Math.PI / 180)); // Xiên vào 10°
            const sideR = 5; // Bo góc 5mm
            const pL0 = pt(xLeft, sealBaseY);
            const pL1 = pt(snap(xLeft + sideInset), snap(sealBaseY + sideH));  // corner trái
            const pL2 = pt(snap(cx - tipR), yTop);
            const pR2 = pt(snap(cx + tipR), yTop);
            const pR1 = pt(snap(xRight - sideInset), snap(sealBaseY + sideH)); // corner phải
            const pR0 = pt(xRight, sealBaseY);

            // smoothFillet đã được extract ra module-level function

            const fL = smoothFillet(pL1, pL0, pL2, sideR);
            const fR = smoothFillet(pR1, pR2, pR0, sideR);

            paths.push(
                line(pL0, fL.t1, 'CUT'),     // 1. Cạnh bên trái → tangent
                fL.seg,                        // 2. Bo góc trái
                line(fL.t2, pL2, 'CUT'),      // 3. Xiên trái → đỉnh
                bezierSegment(                 // 4. Bo đỉnh nhọn
                    pt(snap(cx - tipR), yTop),
                    pt(snap(cx - tipR * 0.3), snap(yTop + tipR * 0.2)),
                    pt(snap(cx + tipR * 0.3), snap(yTop + tipR * 0.2)),
                    pt(snap(cx + tipR), yTop),
                    'CUT',
                ),
                line(pR2, fR.t1, 'CUT'),      // 5. Đỉnh → tangent phải
                fR.seg,                        // 6. Bo góc phải
                line(fR.t2, pR0, 'CUT'),       // 7. Tangent → cạnh bên phải
            );
            break;
        }
        case 'rounded': {
            // Bán kính tính từ dây cung W và chiều cao flapH:
            // r = (W²/4 + flapH²) / (2·flapH)
            const halfW = w / 2;
            const r = snap((halfW * halfW + flapH * flapH) / (2 * flapH));
            const cx = snap((xLeft + xRight) / 2);
            const cy = snap(sealBaseY + flapH - r);  // tâm dưới đỉnh

            const halfAngle = Math.asin(Math.min(1, halfW / r));
            const startDeg = 90 - halfAngle * 180 / Math.PI;
            const endDeg = 90 + halfAngle * 180 / Math.PI;
            paths.push(
                arcToBezier(cx, cy, r, startDeg, endDeg, 'CUT'),
            );
            break;
        }
    }

    return paths;
}

// ── Side Flap ── sử dụng buildDustFlap giống SLB/RTE
// buildDustFlap sinh tai dán 7 điểm: xiên 45° + step + bo tròn
// Dùng trực tiếp cho 2 bên back panel

function buildWindow(
    panelXLeft: number, panelYBot: number,
    winW: number, winH: number,
    winX: number, winY: number,
): PathSegment[] {
    const x1 = snap(panelXLeft + winX);
    const y1 = snap(panelYBot + winY);
    const x2 = snap(x1 + winW);
    const y2 = snap(y1 + winH);
    const r = snap(Math.min(3, winW * 0.05, winH * 0.05));

    // 4 góc bo — lấy tangent points thực từ filletBezier
    const fBR = filletBezier(pt(x2, y1), pt(snap(x2 - r), y1), pt(x2, snap(y1 + r)), r, 'CUT');
    const fTR = filletBezier(pt(x2, y2), pt(x2, snap(y2 - r)), pt(snap(x2 - r), y2), r, 'CUT');
    const fTL = filletBezier(pt(x1, y2), pt(snap(x1 + r), y2), pt(x1, snap(y2 - r)), r, 'CUT');
    const fBL = filletBezier(pt(x1, y1), pt(x1, snap(y1 + r)), pt(snap(x1 + r), y1), r, 'CUT');

    return [
        line(fBL.points[fBL.points.length - 1], fBR.points[0], 'CUT'),       // bottom
        fBR,
        line(fBR.points[fBR.points.length - 1], fTR.points[0], 'CUT'),       // right
        fTR,
        line(fTR.points[fTR.points.length - 1], fTL.points[0], 'CUT'),       // top
        fTL,
        line(fTL.points[fTL.points.length - 1], fBL.points[0], 'CUT'),       // left
        fBL,
    ];
}

export function generateEnvelope(params: BoxParams): DielineModel {
    const {
        envW, envH, envFH: rawFH, envSF: rawSF,
        envFlapShape, envStyle, envWindow,
        envWindowW, envWindowH, envWindowX, envWindowY,
    } = params;

    const isVertical = envStyle === 'pocket';  // pocket = dọc
    // Dọc: swap W↔H → thân đứng (cao>rộng)
    const W = isVertical ? envH : envW;
    const H = isVertical ? envW : envH;

    // Auto-calc — nắp thẳng mặc định 30mm, nhọn/tròn mặc định 45% chiều cao/rộng
    const flapRef = isVertical ? W : H;  // Chiều mà nắp mở dọc theo
    const FH = rawFH > 0 ? snap(rawFH) : (envFlapShape === 'straight' ? 30 : autoFlapH(flapRef));
    const SF = rawSF > 0 ? snap(rawSF) : autoSideFlap(flapRef);

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    if (!isVertical) {
        // ═══════════════════════════════════════════════════════
        // NGANG (wallet) — layout dọc: Back(dưới) → Front(trên) → Seal(trên cùng)
        // ═══════════════════════════════════════════════════════
        const y0 = 0;
        const y1 = snap(H);
        const y2 = snap(H + H);
        const xLeft = 0;
        const xRight = snap(W);

        // ── A. BACK PANEL ──
        const backInsetX = 1;
        const backShortY = 5;
        const xBackL = snap(xLeft + backInsetX);
        const xBackR = snap(xRight - backInsetX);
        const yBackBot = snap(y0 + backShortY);
        const backR = snap(Math.min(3, backShortY * 0.5));
        const chamferDrop = snap(backInsetX * Math.tan(60 * Math.PI / 180));

        const cBL = pt(xBackL, yBackBot);
        const pBLprev = pt(xBackL, snap(y1 - chamferDrop));
        const pBLnext = pt(snap(xBackR - backR), yBackBot);
        const fBL = filletBezier(cBL, pBLprev, pBLnext, backR, 'CUT');
        const tBL1 = fBL.points[0];
        const tBL2 = fBL.points[fBL.points.length - 1];

        const cBR = pt(xBackR, yBackBot);
        const pBRprev = pt(snap(xBackL + backR), yBackBot);
        const pBRnext = pt(xBackR, snap(y1 - chamferDrop));
        const fBR = filletBezier(cBR, pBRprev, pBRnext, backR, 'CUT');
        const tBR1 = fBR.points[0];
        const tBR2 = fBR.points[fBR.points.length - 1];

        const backPaths: PathSegment[] = [
            line(pt(xLeft, y1), pt(xBackL, snap(y1 - chamferDrop)), 'CUT'),
            line(pt(xBackL, snap(y1 - chamferDrop)), tBL1, 'CUT'),
            fBL,
            line(tBL2, tBR1, 'CUT'),
            fBR,
            line(tBR2, pt(xBackR, snap(y1 - chamferDrop)), 'CUT'),
            line(pt(xBackR, snap(y1 - chamferDrop)), pt(xRight, y1), 'CUT'),
            line(pt(xRight, y1), pt(xLeft, y1), 'CREASE'),
        ];
        allPaths.push(...backPaths);
        panels.push({ name: 'back', label: 'Mặt sau', paths: backPaths, parent: 'front', pivotEdge: [pt(xLeft, y1), pt(xRight, y1)], foldAngle: 180, foldDirection: 1, foldPhase: [0.4, 0.7], stackZ: -3 });

        // ── Thumb-cut (khoét bán nguyệt bên trong mặt sau — nắp nhọn + nắp tròn) ──
        // Vị trí: đối xứng với đỉnh nắp khi gập xuống → y = FH
        if (envFlapShape === 'pointed' || envFlapShape === 'rounded') {
            const thumbR = 10;  // Bán kính 1cm → đường kính 2cm  // Bán kính 5mm
            const thumbCx = snap((xLeft + xRight) / 2);
            const thumbCy = snap(FH);  // Cách đáy back panel = FH
            const thumbPaths: PathSegment[] = [
                arcToBezier(thumbCx, thumbCy, thumbR, 180, 360, 'CUT'),  // Bán nguyệt mở lên (hướng crease)
            ];
            allPaths.push(...thumbPaths);
            panels.push({ name: 'thumb_cut', label: 'Khoét tay', paths: thumbPaths, parent: 'back', pivotEdge: null, foldAngle: 0, foldDirection: 1 });
        }

        // ── A2. WINDOW ──
        if (envWindow) {
            const winPaths = buildWindow(xLeft, y1, envWindowW, envWindowH, envWindowX, envWindowY);
            allPaths.push(...winPaths);
            panels.push({ name: 'window', label: 'Cửa sổ', paths: winPaths, parent: 'front', pivotEdge: null, foldAngle: 0, foldDirection: 1 });
        }

        // ── B. FRONT PANEL ──
        const frontPaths: PathSegment[] = [
            line(pt(xLeft, y1), pt(xRight, y1), 'CREASE'),
            line(pt(xRight, y1), pt(xRight, y2), 'CREASE'),
            line(pt(xRight, y2), pt(xLeft, y2), 'CREASE'),
            line(pt(xLeft, y2), pt(xLeft, y1), 'CREASE'),
        ];
        allPaths.push(...frontPaths);
        panels.push({ name: 'front', label: 'Mặt trước', paths: frontPaths, parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1 });

        // ── C. SIDE FLAPS ──
        const glueVat = snap(SF * 0.6);
        const xGlueL = snap(xLeft - SF);
        const xGlueR = snap(xRight + SF);

        const sideLeftPaths: PathSegment[] = [
            line(pt(xGlueL, snap(y1 + glueVat)), pt(xLeft, y1), 'CUT'),
            line(pt(xLeft, y1), pt(xLeft, y2), 'CREASE'),
            line(pt(xLeft, y2), pt(xGlueL, snap(y2 - glueVat)), 'CUT'),
            line(pt(xGlueL, snap(y2 - glueVat)), pt(xGlueL, snap(y1 + glueVat)), 'CUT'),
        ];
        allPaths.push(...sideLeftPaths);
        panels.push({ name: 'side_left', label: 'Tai hông trái', paths: sideLeftPaths, parent: 'front', pivotEdge: [pt(xLeft, y1), pt(xLeft, y2)], foldAngle: 180, foldDirection: -1, foldPhase: [0, 0.35], stackZ: -1 });

        const sideRightPaths: PathSegment[] = [
            line(pt(xRight, y1), pt(xGlueR, snap(y1 + glueVat)), 'CUT'),
            line(pt(xGlueR, snap(y1 + glueVat)), pt(xGlueR, snap(y2 - glueVat)), 'CUT'),
            line(pt(xGlueR, snap(y2 - glueVat)), pt(xRight, y2), 'CUT'),
            line(pt(xRight, y2), pt(xRight, y1), 'CREASE'),
        ];
        allPaths.push(...sideRightPaths);
        panels.push({ name: 'side_right', label: 'Tai hông phải', paths: sideRightPaths, parent: 'front', pivotEdge: [pt(xRight, y1), pt(xRight, y2)], foldAngle: 180, foldDirection: 1, foldPhase: [0, 0.35], stackZ: -1 });

        // ── D. SEAL FLAP ──
        const sealPaths = buildSealFlap(xLeft, xRight, y2, FH, envFlapShape);
        allPaths.push(...sealPaths);
        panels.push({ name: 'seal_flap', label: 'Nắp dán', paths: sealPaths, parent: 'front', pivotEdge: [pt(xLeft, y2), pt(xRight, y2)], foldAngle: 180, foldDirection: -1, foldPhase: [0.7, 1.0], stackZ: -5 });

    } else {
        // ═══════════════════════════════════════════════════════
        // DỌC (pocket) — Back(trái) | Front(phải), Seal(trên front), Tai(phải+dưới front)
        //
        //                   ┌──────────┐
        //                   │ Seal Flap│  FH (trên front)
        //                   ├──────────┤  CREASE
        //   ┌─────────┐ ┌──┤          ├──┐
        //   │  BACK   │─│──│  FRONT   │SF│  (tai phải)
        //   └─────────┘ └──┤          ├──┘
        //                   ├──────────┤  CREASE
        //                   │ SF bottom│  (tai dưới)
        //                   └──────────┘
        // ═══════════════════════════════════════════════════════
        const x0 = 0;
        const x1 = snap(W);      // crease Back|Front
        const x2 = snap(W + W);  // right edge of Front
        const y0 = 0;
        const y1 = snap(H);      // top edge

        // ── A. BACK PANEL (nhỏ hơn front — nằm bên trái) ──
        // Cạnh phải = crease → ngang bằng front
        // Cạnh trái: ngắn hơn 5mm
        // Cạnh trên + dưới: hẹp hơn 0.5mm mỗi bên → tổng 1mm
        const backInsetY = 0.5;   // 0.5mm mỗi bên trên/dưới = hẹp 1mm tổng
        const backShortX = 5;     // 5mm ngắn hơn về bên trái
        const xBackLeft = snap(x0 + backShortX);
        const yBackBot = snap(y0 + backInsetY);
        const yBackTop = snap(y1 - backInsetY);
        const backR = snap(Math.min(3, backShortX * 0.5));
        const chamferDrop = snap(backInsetY * Math.tan(60 * Math.PI / 180));

        // Bo góc trái-dưới: corner = (xBackLeft, yBackBot)
        const cBL = pt(xBackLeft, yBackBot);
        const pBLprev = pt(xBackLeft, snap(yBackTop - backR));  // left edge (lên)
        const pBLnext = pt(snap(xBackLeft + backR), yBackBot);  // bottom edge (phải)
        const fBLv = filletBezier(cBL, pBLprev, pBLnext, backR, 'CUT');
        const tBL1v = fBLv.points[0];
        const tBL2v = fBLv.points[fBLv.points.length - 1];

        // Bo góc trái-trên: corner = (xBackLeft, yBackTop)
        const cBT = pt(xBackLeft, yBackTop);
        const pBTprev = pt(snap(xBackLeft + backR), yBackTop);  // top edge (phải)
        const pBTnext = pt(xBackLeft, snap(yBackBot + backR));  // left edge (xuống)
        const fBTv = filletBezier(cBT, pBTprev, pBTnext, backR, 'CUT');
        const tBT1v = fBTv.points[0];
        const tBT2v = fBTv.points[fBTv.points.length - 1];

        const backPaths: PathSegment[] = [
            // Dưới: từ crease, vát 60° rồi ngang sang trái
            line(pt(x1, y0), pt(snap(x1 - chamferDrop), yBackBot), 'CUT'),
            line(pt(snap(x1 - chamferDrop), yBackBot), tBL2v, 'CUT'),
            // Bo góc dưới-trái
            fBLv,
            // Trái dọc
            line(tBL1v, tBT2v, 'CUT'),
            // Bo góc trên-trái
            fBTv,
            // Trên: ngang sang phải rồi vát 60° về crease
            line(tBT1v, pt(snap(x1 - chamferDrop), yBackTop), 'CUT'),
            line(pt(snap(x1 - chamferDrop), yBackTop), pt(x1, y1), 'CUT'),
            // Crease nối front (dọc)
            line(pt(x1, y1), pt(x1, y0), 'CREASE'),
        ];
        allPaths.push(...backPaths);
        panels.push({ name: 'back', label: 'Mặt sau', paths: backPaths, parent: 'front', pivotEdge: [pt(x1, y0), pt(x1, y1)], foldAngle: 180, foldDirection: -1, foldPhase: [0.4, 0.7], stackZ: -3 });

        // ── Thumb-cut (bên trong mặt sau — nắp nhọn + nắp tròn) ──
        // Nắp ở trên front → khi gập xuống, tip ở y = H - FH
        if (envFlapShape === 'pointed' || envFlapShape === 'rounded') {
            const thumbR = 10;  // Bán kính 1cm → đường kính 2cm
            const thumbCx = snap(W / 2);         // Giữa mặt sau theo X
            const thumbCy = snap(y1 - FH);       // y = H - FH (đỉnh nắp khi gập)
            const thumbPaths: PathSegment[] = [
                arcToBezier(thumbCx, thumbCy, thumbR, 0, 180, 'CUT'),  // Bán nguyệt cong lên trên
            ];
            allPaths.push(...thumbPaths);
            panels.push({ name: 'thumb_cut', label: 'Khoét tay', paths: thumbPaths, parent: 'back', pivotEdge: null, foldAngle: 0, foldDirection: 1 });
        }

        // ── A2. WINDOW (trên mặt trước) ──
        if (envWindow) {
            const winPaths = buildWindow(x1, y0, envWindowW, envWindowH, envWindowX, envWindowY);
            allPaths.push(...winPaths);
            panels.push({ name: 'window', label: 'Cửa sổ', paths: winPaths, parent: 'front', pivotEdge: null, foldAngle: 0, foldDirection: 1 });
        }

        // ── B. FRONT PANEL (bên phải) ──
        const frontPaths: PathSegment[] = [
            line(pt(x1, y0), pt(x1, y1), 'CREASE'),         // crease trái nối back
            line(pt(x1, y1), pt(x2, y1), 'CREASE'),         // crease trên nối seal
            line(pt(x2, y1), pt(x2, y0), 'CREASE'),         // crease phải nối tai phải
            line(pt(x2, y0), pt(x1, y0), 'CREASE'),         // crease dưới nối tai dưới
        ];
        allPaths.push(...frontPaths);
        panels.push({ name: 'front', label: 'Mặt trước', paths: frontPaths, parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1 });

        // ── C. SEAL FLAP (trên front — theo trục Y, dùng buildSealFlap) ──
        const sealPaths = buildSealFlap(x1, x2, y1, FH, envFlapShape);
        allPaths.push(...sealPaths);
        panels.push({ name: 'seal_flap', label: 'Nắp dán', paths: sealPaths, parent: 'front', pivotEdge: [pt(x1, y1), pt(x2, y1)], foldAngle: 180, foldDirection: -1, foldPhase: [0.7, 1.0], stackZ: -5 });

        // ── D. SIDE FLAP PHẢI (bên phải front) ──
        const glueVat = snap(SF * 0.6);
        const xGlueR = snap(x2 + SF);

        const sideRightPaths: PathSegment[] = [
            line(pt(x2, y0), pt(xGlueR, snap(y0 + glueVat)), 'CUT'),
            line(pt(xGlueR, snap(y0 + glueVat)), pt(xGlueR, snap(y1 - glueVat)), 'CUT'),
            line(pt(xGlueR, snap(y1 - glueVat)), pt(x2, y1), 'CUT'),
            line(pt(x2, y1), pt(x2, y0), 'CREASE'),
        ];
        allPaths.push(...sideRightPaths);
        panels.push({ name: 'side_right', label: 'Tai hông phải', paths: sideRightPaths, parent: 'front', pivotEdge: [pt(x2, y0), pt(x2, y1)], foldAngle: 180, foldDirection: 1, foldPhase: [0, 0.35], stackZ: -1 });

        // ── E. SIDE FLAP DƯỚI (dưới front) ──
        const yGlueBot = snap(y0 - SF);

        const sideBotPaths: PathSegment[] = [
            line(pt(snap(x2 - glueVat), yGlueBot), pt(x2, y0), 'CUT'),
            line(pt(x2, y0), pt(x1, y0), 'CREASE'),
            line(pt(x1, y0), pt(snap(x1 + glueVat), yGlueBot), 'CUT'),
            line(pt(snap(x1 + glueVat), yGlueBot), pt(snap(x2 - glueVat), yGlueBot), 'CUT'),
        ];
        allPaths.push(...sideBotPaths);
        panels.push({ name: 'side_left', label: 'Tai hông dưới', paths: sideBotPaths, parent: 'front', pivotEdge: [pt(x1, y0), pt(x2, y0)], foldAngle: 180, foldDirection: 1, foldPhase: [0, 0.35], stackZ: -1 });
    }

    // ── E. Bounding Box & Return ───────────────────────────
    const bb = computeBoundingBox(allPaths);
    const styleName = isVertical ? 'Dọc' : 'Ngang';

    return {
        name: `Bì thư ${styleName}`,
        standardCode: 'ENV',
        description: `Bì thư ${styleName} — ${envW}×${envH}mm`,
        panels,
        allPaths,
        boundingBox: bb,
        params,
    };
}
