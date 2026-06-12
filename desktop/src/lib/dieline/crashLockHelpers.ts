// ============================================================
// Crash-Lock Bottom Helpers
// Used by: SnapLockBottom, GableBox
//
// Extracted from SnapLockBottom.ts to eliminate duplication.
// ZERO logic changes — copy-paste verbatim.
// ============================================================

import { PathSegment } from './types';
import { pt, line, snap, bezierSegment } from './utils';
import {
    FEMALE_DEPTH_RATIO, SLOT_DEPTH_RATIO, FILLET_R_MIN, FILLET_R_MAX,
    FILLET_W_RATIO, KAPPA, DUST_STEP_H_RATIO, DUST_TAB_W,
    SLP_THRESHOLD_1, SLP_THRESHOLD_2,
} from './constants';

// ============================================================
// Crash-Lock Parameters (k·t rules with clamp)
// ============================================================
export interface CrashLockParams {
    c: number;        // clearance
    ear: number;      // ear/bridge width
    step_h: number;   // male step/shoulder height
    depth_m: number;  // male total depth
    depth_f: number;  // female total depth
    r: number;        // fillet radius
    t: number;        // paper thickness
}

export function crashLockParams(t: number): CrashLockParams {
    return {
        c: snap(clamp(0.6 * t, 0.2, 0.6)),
        ear: snap(clamp(8 * t, 2, 8)),
        step_h: snap(clamp(30 * t, 8, 25)),
        depth_m: snap(clamp(32 * t, 10, 28)),
        depth_f: snap(clamp(33 * t, 10, 30)),
        r: snap(Math.max(0.8, 2 * t)),
        t,
    };
}

export function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

// ============================================================
// Clamped mainH — depth giới hạn để 2 tai đối diện không đè nhau
// Dùng chung cho buildFemaleReceiver, buildMaleHook
// Khi L ≈ W → mainH giảm → đường chéo tai đáy phẳng hơn (< 45°)
//   và tai mặt chính dốc hơn (> 45°), tổng = 90° luôn.
// ============================================================
export function clampedMainH(L: number, W: number): number {
    const rawMainH = snap(SLOT_DEPTH_RATIO * W);
    const rawStepH = snap(DUST_STEP_H_RATIO * W);
    const rawTotal = rawMainH + rawStepH;
    const maxDepth = snap(L / 2 - 1);
    if (rawTotal > maxDepth && maxDepth > 0) {
        return snap(Math.max(5, rawMainH * maxDepth / rawTotal));
    }
    return rawMainH;
}

// ============================================================
// Compute Snap-Lock Pairs count
// ============================================================
export function computeSnapLockPairs(L: number, W: number, SLP: number): number {
    if (SLP >= 1 && SLP <= 3) return Math.round(SLP);
    // Auto: dựa vào chênh lệch L - W
    const diff = L - W;
    if (diff < SLP_THRESHOLD_1) return 1;
    if (diff < SLP_THRESHOLD_2) return 2;
    return 3;
}

// ============================================================
// Female Receiver (khe U) — 1 mảng liên tục với N khe U
//
//   QUY TẮC:
//     - 2 tai ngoài cố định = totalDepth = 3W/4 (45°)
//     - Phần giữa 2 tai: chia đều cho N slots + (N-1) inner ears
//       innerSpace = totalW - 2*outerEarW
//       slotW = innerEarW = (innerSpace - N*r) / (2N-1)
//
//  N=1:  OUTER_EAR | SLOT | OUTER_EAR
//  N=2:  OUTER_EAR | SLOT | innerEAR | SLOT | OUTER_EAR
// ============================================================

export function buildFemaleReceiver(
    xLeft: number, xRight: number, yBase: number,
    L: number, W: number, T: number, pairCount: number = 1,
): PathSegment[] {
    const paths: PathSegment[] = [];
    const totalW = xRight - xLeft;

    const totalDepth = snap(FEMALE_DEPTH_RATIO * W);
    const slotDepth = snap(SLOT_DEPTH_RATIO * W);
    const r = snap(Math.min(FILLET_R_MAX, Math.max(FILLET_R_MIN, W * FILLET_W_RATIO)));

    // Tai ngoài: trừ T để đảm bảo b + T = mainH_dust = slotDepth = c = d
    const earDepth = clampedMainH(L, W);
    const outerEarW = snap(Math.max(0, Math.min(slotDepth, earDepth) - T));
    // Phần giữa 2 tai ngoài
    const innerSpace = snap(totalW - 2 * outerEarW);
    // Chia đều: N slots + (N-1) inner ears, tất cả bằng nhau
    const N = pairCount;
    const unitW = snap(Math.max(0, (innerSpace - N * r) / (2 * N - 1)));
    const slotW = unitW;
    const innerEarW = unitW;

    const yDC = snap(yBase - totalDepth);
    const yNM = snap(yBase - slotDepth);

    // Taper: tai (ear) dài thêm 0.5mm hướng vào trong → fillet dịch theo
    // → cạnh slot xiên từ đáy hẹp lên miệng rộng → khóa chắc hơn
    const SLOT_TAPER = 3;


    const kLen = snap(r * KAPPA);

    // === Left edge (dọc xuống) ===
    paths.push(line(pt(xLeft, yBase), pt(xLeft, yDC), 'CUT'));

    let cursor = xLeft;

    // --- Tai ngoài trái (dài thêm SLOT_TAPER về phải) ---
    // Centering fix: dịch vùng slot sang phải r/2 để cân bằng tai trái và phải.
    // Left fillet ăn r vào tai trái, right fillet đẩy cursor thêm r sau slot.
    // Thêm r/2 → cả 2 tai đều có chiều rộng flat = outerEarW - r/2.
    const centeringOffset = snap(r / 2);
    const outerEarEnd = snap(cursor + outerEarW + centeringOffset);
    paths.push(line(pt(cursor, yDC), pt(snap(outerEarEnd - r + SLOT_TAPER), yDC), 'CUT'));
    cursor = outerEarEnd;

    for (let i = 0; i < pairCount; i++) {
        // --- Inner ear (từ slot thứ 2 trở đi, dài thêm 2×TAPER) ---
        if (i > 0) {
            const innerEnd = snap(cursor + innerEarW);
            paths.push(line(pt(cursor, yDC), pt(snap(innerEnd - r + SLOT_TAPER), yDC), 'CUT'));
            cursor = innerEnd;
        }

        // --- Bo tròn góc trái slot (dịch SLOT_TAPER vào trong) ---
        const earEnd = cursor;
        const earEndShifted = snap(earEnd + SLOT_TAPER);
        paths.push(bezierSegment(
            pt(snap(earEndShifted - r), yDC),
            pt(snap(earEndShifted - r + kLen), yDC),
            pt(earEndShifted, snap(yDC + r - kLen)),
            pt(earEndShifted, snap(yDC + r)),
            'CUT'
        ));

        // --- Cạnh trái slot (xiên vào trong: đáy earEndShifted → đỉnh earEnd) ---
        const slotEnd = snap(earEnd + slotW);
        paths.push(line(pt(earEndShifted, snap(yDC + r)), pt(earEnd, yNM), 'CUT'));

        // --- Đáy slot (ngang tại yNM, chiều rộng KHÔNG ĐỔI) ---
        paths.push(line(pt(earEnd, yNM), pt(slotEnd, yNM), 'CUT'));

        // --- Cạnh phải slot (xiên vào trong: đỉnh slotEnd → đáy slotEndShifted) ---
        const slotEndShifted = snap(slotEnd - SLOT_TAPER);
        paths.push(line(pt(slotEnd, yNM), pt(slotEndShifted, snap(yDC + r)), 'CUT'));

        // --- Bo tròn góc phải slot (dịch SLOT_TAPER vào trong) ---
        paths.push(bezierSegment(
            pt(slotEndShifted, snap(yDC + r)),
            pt(slotEndShifted, snap(yDC + r - kLen)),
            pt(snap(slotEndShifted + r - kLen), yDC),
            pt(snap(slotEndShifted + r), yDC),
            'CUT'
        ));

        cursor = snap(slotEndShifted + r);
    }

    // --- Tai ngoài phải ---
    paths.push(line(pt(cursor, yDC), pt(xRight, yDC), 'CUT'));

    // === Right edge (dọc lên) ===
    paths.push(line(pt(xRight, yDC), pt(xRight, yBase), 'CUT'));

    return paths;
}

// ============================================================
// Male Hook (lưỡi gài) — 1 mảng liên tục với N mấu gài
//
//   QUY TẮC:
//     - 2 tai ngoài cố định = sideH = W/2 (chéo 45°)
//     - Phần giữa 2 tai: chia đều cho N hooks + (N-1) inner ears
//       innerSpace = totalW - 2*outerEarW
//       hookW = innerEarW = innerSpace / (2N-1)
//
//  N=1:  DIAG45 | HOOK | DIAG45
//  N=2:  DIAG45 | HOOK | innerEAR | HOOK | DIAG45
// ============================================================

export function buildMaleHook(
    xLeft: number, xRight: number, yBase: number,
    L: number, W: number, T: number, pairCount: number = 1,
): PathSegment[] {
    const paths: PathSegment[] = [];
    const totalW = xRight - xLeft;

    const sideH = snap(SLOT_DEPTH_RATIO * W);
    const centerH = snap(FEMALE_DEPTH_RATIO * W);
    const r = snap(Math.min(FILLET_R_MAX, Math.max(FILLET_R_MIN, W * FILLET_W_RATIO)));

    // Tai ngoài = clampedMainH: co lại khi L ≈ W → đường chéo dốc hơn (α_hook > 45°)
    const earDepth = clampedMainH(L, W);
    const outerEarW = snap(Math.min(sideH, earDepth));
    // Phần giữa 2 tai ngoài
    const innerSpace = snap(totalW - 2 * outerEarW);
    // Chia đều: N hooks + (N-1) inner ears
    const N = pairCount;
    const unitW = snap(Math.max(0, innerSpace / (2 * N - 1)));
    // Rule 5: hookW = female slotW − T (exactly 1 paper thickness clearance)
    // Compute female's slotW using same totalW (both L-wide panels)
    const femaleSlotDepth = snap(SLOT_DEPTH_RATIO * W);
    const femaleOuterEarW = snap(Math.max(0, Math.min(femaleSlotDepth, earDepth) - T));
    const femaleInnerSpace = snap(totalW - 2 * femaleOuterEarW);
    const femaleSlotW = snap(Math.max(0, (femaleInnerSpace - N * r) / (2 * N - 1)));
    const hookW = snap(Math.max(0, femaleSlotW - T));
    // Căn giữa hook trong unitW → đường chéo tai dài hơn, mirror đối xứng
    const hookPad = snap((unitW - hookW) / 2);
    const innerEarW = unitW;

    const yCH = snap(yBase - sideH);    // Mức vai (C, H)
    const yNM = snap(yBase - centerH);  // Mức đáy hook (N, M)

    const kLen = snap(r * KAPPA);

    let cursor = snap(xLeft + outerEarW);
    let prevHookRight = 0;

    for (let i = 0; i < pairCount; i++) {
        if (i > 0) {
            cursor = snap(cursor + innerEarW);
        }

        const unitStart = cursor;
        const hookLeft = snap(unitStart + hookPad);
        const hookRightX = snap(hookLeft + hookW);

        // --- Đường chéo / inner ear đến hook wall ---
        if (i === 0) {
            // Tai ngoài trái: chéo từ xLeft(yBase) → hookLeft(yCH) — mirror với tai phải
            paths.push(line(pt(xLeft, yBase), pt(hookLeft, yCH), 'CUT'));
        } else {
            // Inner ear: ngang từ hookRight trước → hookLeft hiện tại
            paths.push(line(pt(prevHookRight, yCH), pt(hookLeft, yCH), 'CUT'));
        }

        // --- Cạnh trái hook: vertical down ---
        paths.push(line(pt(hookLeft, yCH), pt(hookLeft, snap(yNM + r)), 'CUT'));

        // --- Bo tròn tại N ---
        paths.push(bezierSegment(
            pt(hookLeft, snap(yNM + r)),
            pt(hookLeft, snap(yNM + r - kLen)),
            pt(snap(hookLeft + r - kLen), yNM),
            pt(snap(hookLeft + r), yNM),
            'CUT'
        ));

        // --- Đáy hook: N → M (ngang tại yNM) ---
        paths.push(line(pt(snap(hookLeft + r), yNM), pt(snap(hookRightX - r), yNM), 'CUT'));

        // --- Bo tròn tại M ---
        paths.push(bezierSegment(
            pt(snap(hookRightX - r), yNM),
            pt(snap(hookRightX - r + kLen), yNM),
            pt(hookRightX, snap(yNM + r - kLen)),
            pt(hookRightX, snap(yNM + r)),
            'CUT'
        ));

        // --- Cạnh phải hook: M → H (vertical up) ---
        paths.push(line(pt(hookRightX, snap(yNM + r)), pt(hookRightX, yCH), 'CUT'));

        prevHookRight = hookRightX;
        cursor = snap(unitStart + unitW);
    }

    // --- Tai ngoài phải: chéo hookRightX(yCH) → xRight(yBase) — mirror với tai trái ---
    paths.push(line(pt(prevHookRight, yCH), pt(xRight, yBase), 'CUT'));


    return paths;
}

// ============================================================
// Bottom Dust Flaps (Gài phụ)
//
//   A                         B   yBase (crease)
//   │                        ╱
//   │                   E──╱      yDC = yBase − (W/2 − T)
//   │                  ╭╯
//   G─────────────────M          yGF = yDC − 0.3W
//
//   A→G: dọc | G→M: ngang + bo tròn tại M | M→E: dọc | E→B: chéo
//   mirror=true → đối xứng cho bên phải
// ============================================================
export function buildBottomDustFlap(
    xLeft: number, xRight: number, yBase: number,
    L: number, W: number, T: number,
    mirror: boolean,
): PathSegment[] {
    const paths: PathSegment[] = [];
    const totalW = xRight - xLeft;

    // G ở đầu khe U, khoảng cách ngang B→G = outerEarW + r/2 (do centeringOffset)
    // BE = BG + T: tai bụi dài hơn 1 độ dày giấy → khớp chắc khi gài
    // mainH = outerEarW + r/2 + T = (earDepth − T + r/2) + T = earDepth + r/2
    const earDepth = clampedMainH(L, W);
    const r = snap(Math.min(FILLET_R_MAX, Math.max(FILLET_R_MIN, W * FILLET_W_RATIO)));
    const mainH = snap(Math.max(0, earDepth + r / 2));      // BE = BG + T
    const rawStepH = snap(DUST_STEP_H_RATIO * W);          // 0.3W
    const maxDepth = snap(L / 2);                           // AG ≤ L/2
    const stepH = snap(Math.max(0, Math.min(rawStepH, maxDepth - mainH)));

    // diagX = slotDepth = W/2 → G ở đầu khe U
    const diagX = snap(SLOT_DEPTH_RATIO * W);               // W/2
    const stepW = snap(Math.max(0, totalW - diagX));
    const tabW = snap(Math.min(DUST_TAB_W, mainH * 0.8));

    const yDC = snap(yBase - mainH);
    const yGF = snap(yDC - stepH);

    const kLen = snap(r * KAPPA);

    if (!mirror) {
        // --- TRÁI: outline A → G → M(bo) → E → B ---
        const xA = xLeft;
        const xB = xRight;
        const xE = snap(xLeft + stepW);
        const xM = snap(xE + tabW);

        // A → G (left edge, dọc xuống, inset T)
        paths.push(line(pt(xA, yBase), pt(xA, yGF), 'CUT'));

        // G → gần M (ngang, dừng trước fillet)
        paths.push(line(pt(xA, yGF), pt(snap(xM - r), yGF), 'CUT'));

        // Bo tròn tại M: horizontal(→) sang vertical(↑)
        paths.push(bezierSegment(
            pt(snap(xM - r), yGF),
            pt(snap(xM - r + kLen), yGF),
            pt(xM, snap(yGF + r - kLen)),
            pt(xM, snap(yGF + r)),
            'CUT'
        ));

        // M → E (xiên lên, tạo góc 45° bổ sung cho đường chéo E→B)
        paths.push(line(pt(xM, snap(yGF + r)), pt(xE, yDC), 'CUT'));

        // E → B (chéo)
        paths.push(line(pt(xE, yDC), pt(xB, yBase), 'CUT'));

    } else {
        // --- PHẢI (mirror): outline F → G → M(bo) → H → A ---
        const xF = xRight;
        const xA2 = xLeft;
        const xH = snap(xRight - stepW);
        const xM2 = snap(xH - tabW);

        // F → G (right edge, dọc xuống, inset T)
        paths.push(line(pt(xF, yBase), pt(xF, yGF), 'CUT'));

        // G → gần M (ngang trái, dừng trước fillet)
        paths.push(line(pt(xF, yGF), pt(snap(xM2 + r), yGF), 'CUT'));

        // Bo tròn tại M: horizontal(←) sang vertical(↑)
        paths.push(bezierSegment(
            pt(snap(xM2 + r), yGF),
            pt(snap(xM2 + r - kLen), yGF),
            pt(xM2, snap(yGF + r - kLen)),
            pt(xM2, snap(yGF + r)),
            'CUT'
        ));

        // M → H (xiên lên, tạo góc 45° bổ sung cho đường chéo H→A)
        paths.push(line(pt(xM2, snap(yGF + r)), pt(xH, yDC), 'CUT'));

        // H → A (chéo)
        paths.push(line(pt(xH, yDC), pt(xA2, yBase), 'CUT'));
    }

    return paths;
}
