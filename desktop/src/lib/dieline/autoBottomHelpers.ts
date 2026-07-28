// ============================================================
// Auto-Bottom Helpers — Đáy dán tự động
//
// Geometry bám mẫu đo từ:
//   Custom Dimensions Tuck End Boxes Double Tray Dieline 100010-01.svg
//
// Đoạn gấp đáy (y = yBase) gần góc dán:
//
//   ───●B════════════●W───  W = góc free-edge đáy ↔ tai (cột)
//      |  khe ~0.013W
//      | step 45°
//      ●C
//       ＼ CREASE 45° = đường nhấn (cũng là free-edge CUT ngoài tam giác dán)
//        ＼
//         ●E  (tầm hWing)
//
// B = free-edge đáy chạm đoạn gấp = ĐẦU đường nhấn
//     (KHÔNG phải W — không kéo free-edge đáy tới góc đáy↔tai)
//
// [AUTO-BOTTOM FIX 2026-07-26]
//   - Bỏ bo góc bezier tại A/B trên đoạn gấp (fillet cũ bị ép điểm đầu/cuối
//     mà không tính lại control points → free-edge "quăn"/vòng lặp, và sau
//     retarget ở AutoBottomBox làm points[] ↔ controlPoints[] phân kỳ).
//     Góc trên fold nay là góc SẮC như mẫu 100010-01; chỉ bo nhẹ các góc sâu.
//   - `computeDeepBottomKeyPoints` nhận `opts.glueEdgeGap` để cột góc dán
//     KHÉP QUA ĐƯỜNG MAY (WLWL, mép ngoài x5) dùng khe = 0 → CREASE 45°
//     chạm đúng đỉnh kệ E, không còn đuôi cấn lơ lửng.
//   - Thêm `buildDeepBottomFreeEdge` + `splitDeepBottomPaths`: tách chuỗi
//     free-edge tại đỉnh kệ E thành phần THÂN (A→…→E) và TAM GIÁC DÁN
//     (E→…→B) để AutoBottomBox dựng panel `bottom_tab_*` gập 180° quanh
//     nếp chéo [B,E] trong 3D.
//   - Bỏ import chết AB_GLUE_LEG_RATIO (glueLeg dẫn xuất = hWing − step).
// ============================================================

import { PathSegment, Point2D } from './types';
import { pt, line, snap, filletBezier } from './utils';
import {
    AB_DEEP_DEPTH_RATIO, AB_WING_DEPTH_RATIO,
    AB_STEP_RATIO, AB_EAR_WIDTH_RATIO, AB_EAR_INSET_RATIO,
    AB_SHELF_RATIO, AB_NOTCH_RATIO, AB_SHOULDER_RATIO, AB_BOT_INSET_RATIO,
    AB_WING_INNER_TAPER_RATIO, AB_WING_OUTER_TAPER_RATIO,
} from './constants';

/** Khe free-edge đáy vs góc cột (W) trên đoạn gấp — mẫu ≈ 0.0134W */
export const AB_FOLD_GAP_RATIO = 0.0134;

export interface AutoBottomDims {
    hDeep: number;
    hWing: number;
    glueLeg: number;
    step: number;
    earW: number;
    earInset: number;
    /**
     * @deprecated [AUTO-BOTTOM FIX 2026-07-27] KHÔNG còn quyết định hình free-edge.
     * Kệ ngang giờ suy ra từ vị trí nấc F/G (luôn ở giữa mặt dài L) —
     * xem `computeDeepBottomKeyPoints`. Giữ field cho tương thích.
     */
    shelfW: number;
    notchH: number;
    /**
     * @deprecated [AUTO-BOTTOM FIX 2026-07-27] KHÔNG còn quyết định hình free-edge.
     * Vế ngang của vai giờ = hDeep − hWing − nấc để vai H→G luôn đúng 45°.
     */
    shoulder: number;
    botInsetRatio: number;
    /** Khe B↔W trên đoạn gấp */
    foldGap: number;
    wingTaperIn: number;
    wingTaperOut: number;
}

export function autoBottomDims(
    L: number, W: number, T: number, C: number, ABD: number,
): AutoBottomDims {
    const wingSpan = Math.max(4, W - T);

    const hWing = Math.max(3, Math.min(
        AB_WING_DEPTH_RATIO * W,
        Math.max(4, L / 2 - 2),
        wingSpan * 0.7,
    ));

    const deepMin = W / 2;
    const deepMax = Math.max(deepMin, W - T);
    const hDeep = Math.min(deepMax, Math.max(deepMin, ABD > 0 ? ABD : AB_DEEP_DEPTH_RATIO * W));

    // step + glueLeg = hWing ⇒ B→E đúng 45° (mẫu 0.091 + 0.405 ≈ 0.507)
    let step = Math.max(0.5, Math.min(AB_STEP_RATIO * W, hWing * 0.35));
    let glueLeg = Math.max(1, hWing - step);
    if (glueLeg > hDeep - 1) {
        glueLeg = Math.max(1, hDeep - 1);
        step = Math.max(0.5, hWing - glueLeg);
    }

    const foldGap = Math.max(0.4, Math.min(AB_FOLD_GAP_RATIO * W, step * 0.5, 3));

    const earInset = Math.max(0.3, Math.min(AB_EAR_INSET_RATIO * W, glueLeg * 0.15));
    const earW = Math.max(1.5, Math.min(
        AB_EAR_WIDTH_RATIO * W,
        Math.max(1.5, glueLeg * 0.3),
        hDeep * 0.2,
    ));

    const shelfW = Math.max(2, Math.min(AB_SHELF_RATIO * W, hWing * 1.2));
    const notchH = Math.max(0.4, Math.min(
        AB_NOTCH_RATIO * W,
        Math.max(0.3, hDeep - hWing - 0.5),
    ));
    const shoulder = Math.max(1, Math.min(
        AB_SHOULDER_RATIO * W,
        Math.max(1, hDeep - hWing - notchH),
    ));

    const maxTaperBudget = Math.max(0, wingSpan - Math.max(2, wingSpan * 0.25));
    let wingTaperIn = Math.min(AB_WING_INNER_TAPER_RATIO * W, maxTaperBudget * 0.4);
    let wingTaperOut = Math.min(AB_WING_OUTER_TAPER_RATIO * W, maxTaperBudget - wingTaperIn);
    if (wingTaperIn + wingTaperOut > maxTaperBudget && wingTaperIn + wingTaperOut > 0) {
        const scale = maxTaperBudget / (wingTaperIn + wingTaperOut);
        wingTaperIn *= scale;
        wingTaperOut *= scale;
    }
    wingTaperIn = Math.max(0.5, wingTaperIn - C * 0.25);

    return {
        hDeep: snap(hDeep),
        hWing: snap(hWing),
        glueLeg: snap(glueLeg),
        step: snap(step),
        earW: snap(earW),
        earInset: snap(earInset),
        shelfW: snap(shelfW),
        notchH: snap(notchH),
        shoulder: snap(shoulder),
        botInsetRatio: AB_BOT_INSET_RATIO,
        foldGap: snap(foldGap),
        wingTaperIn: snap(wingTaperIn),
        wingTaperOut: snap(wingTaperOut),
    };
}

/**
 * Đỉnh free-edge đáy chính — dùng chung path + chú thích DEV.
 *
 * Mẫu 100010-01 (đo SVG, free-edge = ĐƯỜNG THẲNG + bo nhẹ 1–2 góc sâu):
 *
 *   A ════════fold════════ B ···gap··· W
 *   |                      ／
 *   |                     C   step 45° (depth ≈ step)
 *   |                    ／
 *   |                   M     đỉnh tai outer (depth ≈ 1.71·step, sâu hơn C)
 *   |                   |
 *   I—H … G—F ──── E   EarR—EarL
 *
 * Outer CUT: A→I→H→G→F→E→EarL→EarR→M→C→B
 * CREASE: B→E (45°)
 */
export type DeepBottomKeyPoints = {
    A: Point2D;
    I: Point2D;
    H: Point2D;
    G: Point2D;
    F: Point2D;
    E: Point2D;
    EarL: Point2D | null;
    EarR: Point2D | null;
    M: Point2D | null;
    C: Point2D;
    B: Point2D;
    /** Polyline free-edge A…B (thẳng) */
    verts: Point2D[];
    /** Bo nhẹ chỉ góc sâu (I/H/ear) — KHÔNG fillet mọi góc */
    filletR: number;
    yBase: number;
    /**
     * [AUTO-BOTTOM FIX 2026-07-27] Chiều sâu THỰC của mảnh đáy sau khi giữ vai
     * H→G đúng 45°. Bằng `dims.hDeep` ở hộp thường; nhỏ hơn khi hộp cực dẹt
     * (L ≪ W) buộc phải rút sâu để vai không dựng đứng.
     */
    hDeepEff: number;
    /** Bề rộng kệ ngang F→E (nét lõm) — 0 khi hộp gần vuông, kệ tiêu biến */
    shelfSpan: number;
    /** Bề rộng dải đáy sâu I→H (phần chồng chịu lực) */
    bandSpan: number;
};

export function computeDeepBottomKeyPoints(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
    opts?: {
        /** [AUTO-BOTTOM FIX 2026-07-26] Ghi đè khe B↔mép phải (mm).
         *  Cột góc dán khép QUA ĐƯỜNG MAY keo (WLWL, mép ngoài x5) truyền 0:
         *  B trùng góc blank, E = B − (hWing, hWing) trùng đúng đỉnh kệ. */
        glueEdgeGap?: number;
    },
): DeepBottomKeyPoints {
    const {
        hDeep, hWing, step, earW,
        notchH, botInsetRatio, foldGap,
    } = dims;
    const span = Math.max(1, xR - xL);

    const st = Math.min(step, span * 0.2, hWing * 0.4);
    const gl = Math.max(1, hWing - st);
    const gapBase = opts?.glueEdgeGap ?? foldGap;
    const gap = Math.max(0, Math.min(gapBase, span * 0.05, st * 0.5));

    // B trên fold, khe foldGap so với cột W = xR
    const xB = snap(xR - gap);
    // C = góc step 45° từ B
    const xC = snap(xB - st);
    const yC = snap(yBase - st);
    // E = đuôi CREASE / đầu kệ — 45° từ B, depth hWing
    const xE = snap(xB - st - gl); // = xB - hWing
    const yE = snap(yBase - hWing);
    const yW = yE;

    // ── [AUTO-BOTTOM FIX 2026-07-27] Phân bổ chiều ngang theo QUY TẮC HÌNH HỌC ──
    // Bản cũ cấp phát tuần tự từ phải sang trái: kệ F→E lấy đủ 0.5·W trước, vai
    // lấy 0.215·W, dải đáy I→H nhận phần CÒN LẠI. Mọi kích thước con đó tỉ lệ
    // theo W nhưng ngân sách ngang lại là L ⇒ hộp có L ≲ 1.26·W bị âm ngân sách,
    // clamp cũ dồn toàn bộ sai số vào H: dải đáy sập còn 1mm (lưỡi giấy bế không
    // được) và vai H→G mất góc 45° (đo được ~85°). Đo trên mẫu 100010-01 cho
    // thấy nấc F/G của mẫu nằm ĐÚNG giữa mặt dài, nên quy tắc đúng là:
    //   1. Nấc F/G LUÔN ở GIỮA mặt dài L theo trục dọc → xShelfL = xL + span/2.
    //      ⇒ kệ (nét lõm) F→E = span/2 − gap − hWing, TỰ CO khi L nhỏ dần; khi
    //        L ≈ W đường nhấn 45° chạm đúng tâm nên kệ tiêu biến, chỉ còn nấc dọc.
    //   2. Vai H→G giữ ĐÚNG 45°: Δx = Δy = hDeep − hWing − nấc.
    //   3. Dải đáy I→H (phần chồng chịu lực của đáy) KHÔNG bị hy sinh nữa. Chỉ
    //      hộp cực dẹt (L ≪ W) mới chạm sàn `bandMin`; khi đó GIẢM CHIỀU SÂU
    //      đáy để giữ vai 45°, thay vì dựng vai gần thẳng đứng như bản cũ.
    const xBotL = snap(xL + Math.min(botInsetRatio * span, Math.max(0.5, span * 0.02)));
    const nH = Math.min(notchH, Math.max(0, hDeep - hWing - 0.3));
    const yNotch = snap(yW - nH);

    // (1) Nấc ở giữa mặt dài; không bao giờ vượt quá đỉnh kệ E (hộp L ≤ W).
    let xShelfL = snap(Math.min(xL + span / 2, xE));
    const hasShelf = xE - xShelfL > 0.3;
    if (!hasShelf) xShelfL = xE;

    // (2)+(3) Vai 45°, trần theo ngân sách còn lại sau khi chừa dải đáy tối thiểu.
    const bandMin = Math.max(3, Math.min(8, span * 0.08));
    const shoulderRun = Math.min(
        Math.max(0, hDeep - hWing - nH),
        Math.max(0, xShelfL - xBotL - bandMin),
    );
    const xShoulder = snap(xShelfL - shoulderRun);
    // Chiều sâu HIỆU DỤNG của mảnh đáy = kệ + nấc + vế 45° của vai.
    const hDeepEff = snap(hWing + nH + shoulderRun);
    const yD = snap(yBase - hDeepEff);

    // Tai — mẫu: outer x ≈ B − gap (gần B), đáy yD, đỉnh M depth ≈ 1.71·step
    const earZone = Math.max(0, xB - xE);
    let xEarR = snap(xB - Math.min(Math.max(gap, st * 0.12), earZone * 0.12, 4));
    let xEarL = snap(xEarR - Math.min(earW, earZone * 0.4, Math.max(2, (xEarR - xE) * 0.45)));
    if (xEarL < xE + 0.5) xEarL = snap(xE + Math.min(1, Math.max(0.5, earZone * 0.1)));
    const hasEar = xEarR > xEarL + 0.5 && earZone >= 2.5 && hDeepEff > hWing + 1;

    // M sâu hơn C (mẫu), nông hơn đáy tai — trên dọc ear outer
    const depthM = Math.min(st * 1.71, hWing * 0.75, Math.max(st + 2.5, st * 1.5));
    let yM = snap(yBase - depthM);
    yM = snap(Math.min(yM, yC - Math.max(2, st * 0.5)));
    yM = snap(Math.max(yM, yD + Math.max(4, hDeepEff * 0.08)));

    // Bo NHẸ chỉ góc sâu (mẫu bo 1 góc ear ngoài) — không > ~1.2mm
    const filletR = snap(Math.min(1.2, Math.max(0.4, st * 0.15)));

    const A = pt(xL, yBase);
    const I = pt(xBotL, yD);
    const H = pt(xShoulder > xBotL + 0.2 ? xShoulder : xBotL, yD);
    const G = pt(xShelfL, yNotch);
    const F = pt(xShelfL, yW);
    const E = pt(xE, yW);
    const B = pt(xB, yBase);
    const C = pt(xC, yC);

    const verts: Point2D[] = [A, I];
    if (H.x > I.x + 0.2) verts.push(H);
    if (xShelfL > H.x + 0.15) {
        verts.push(G);
        // [AUTO-BOTTOM FIX 2026-07-27] Chỉ chèn F khi CÒN kệ ngang thật: hộp
        // gần vuông có kệ tiêu biến (xShelfL = xE) ⇒ F trùng E, chèn vào sẽ
        // sinh đoạn CUT dài 0mm.
        if (hasShelf && yNotch < yW - 0.15) verts.push(F);
    }
    verts.push(E);

    let EarL: Point2D | null = null;
    let EarR: Point2D | null = null;
    let M: Point2D | null = null;

    if (hasEar) {
        EarL = pt(xEarL, yD);
        EarR = pt(xEarR, yD);
        M = pt(xEarR, yM);
        verts.push(EarL, EarR, M, C, B);
    } else {
        verts.push(C, B);
    }

    return {
        A, I, H, G, F, E, EarL, EarR, M, C, B,
        verts, filletR, yBase,
        hDeepEff, shelfSpan: snap(hasShelf ? xE - xShelfL : 0),
        bandSpan: snap(Math.max(0, H.x - I.x)),
    };
}

/**
 * Free-edge = polyline THẲNG + bo nhẹ có chọn lọc.
 *
 * [AUTO-BOTTOM FIX 2026-07-26] Viết lại:
 *  - KHÔNG bo góc tại A và B trên đoạn gấp nữa. Bản cũ ép điểm đầu/cuối của
 *    fillet về A/B mà GIỮ NGUYÊN control points tính cho tiếp điểm gốc →
 *    đường cong móc ngược ("quăn" tại A, vòng lặp đè lên đường nhấn tại B);
 *    và khi AutoBottomBox retarget endpoint chỉ ghi `points[]` (bỏ sót
 *    `controlPoints[]`) → hai mảng phân kỳ, canvas/export vẽ hở 0.25mm.
 *    Góc trên fold nay là góc SẮC đúng mẫu 100010-01.
 *  - Chỉ bo nhẹ các góc ở dải ĐÁY SÂU NHẤT (I/H/EarR) như trước.
 *  - Mọi đoạn chạm đoạn gấp đều là LINE → an toàn với mọi retarget về sau.
 */
function buildCleanFreeEdge(
    verts: Point2D[],
    radius: number,
): PathSegment[] {
    if (verts.length < 2) return [];
    if (verts.length === 2) return [line(verts[0], verts[1], 'CUT')];

    const B = verts[verts.length - 1];
    const r = Math.max(0.3, Math.min(radius, 1.2));

    // Chỉ bo góc ở ĐÁY SÂU NHẤT (gần yD). Không bo kệ E/F, step C, đỉnh M —
    // filletBezier ở đó overshoot → free-edge quăn (xem báo cáo user).
    const yDeep = Math.min(...verts.map((v) => v.y));
    const deepBand = yDeep + Math.max(1.5, r * 2); // chỉ dải ± bo quanh yD
    const canFillet = (i: number): boolean => {
        if (i <= 0 || i >= verts.length - 1) return false;
        const prev = verts[i - 1];
        const cur = verts[i];
        const next = verts[i + 1];
        if (cur.y > deepBand) return false;
        const len1 = Math.hypot(prev.x - cur.x, prev.y - cur.y);
        const len2 = Math.hypot(next.x - cur.x, next.y - cur.y);
        if (len1 < r * 3 || len2 < r * 3) return false;
        // Ưu tiên góc ~90° (dot gần 0)
        const ux1 = (prev.x - cur.x) / len1, uy1 = (prev.y - cur.y) / len1;
        const ux2 = (next.x - cur.x) / len2, uy2 = (next.y - cur.y) / len2;
        const dot = ux1 * ux2 + uy1 * uy2;
        if (Math.abs(dot) > 0.35) return false; // không bo góc nhọn/tù
        return true;
    };

    const paths: PathSegment[] = [];
    let cursor = verts[0];

    // --- Các góc giữa: line + fillet chọn lọc (A→…→B) ---
    for (let i = 1; i < verts.length - 1; i++) {
        const cur = verts[i];
        const next = verts[i + 1];

        if (canFillet(i)) {
            const prev = verts[i - 1];
            const fil = filletBezier(cur, prev, next, r, 'CUT');
            const t1 = fil.points[0];
            const t2 = fil.points[fil.points.length - 1];
            if (Math.hypot(cursor.x - t1.x, cursor.y - t1.y) > 0.05) {
                paths.push(line(cursor, t1, 'CUT'));
            }
            paths.push(fil);
            cursor = t2;
        } else {
            if (Math.hypot(cursor.x - cur.x, cursor.y - cur.y) > 0.05) {
                paths.push(line(cursor, cur, 'CUT'));
            }
            cursor = cur;
        }
    }

    // --- Đoạn cuối: LINE thẳng tới B (góc sắc trên đoạn gấp) ---
    if (Math.hypot(cursor.x - B.x, cursor.y - B.y) > 0.005) {
        paths.push(line(cursor, B, 'CUT'));
    }

    return paths;
}

/**
 * [AUTO-BOTTOM FIX 2026-07-26] Chuỗi free-edge CUT (A→…→B) từ key points —
 * KHÔNG kèm CREASE, để AutoBottomBox tự tách thân/tam giác dán rồi gắn
 * đường nhấn 45° vào panel thân.
 */
export function buildDeepBottomFreeEdge(kp: DeepBottomKeyPoints): PathSegment[] {
    return buildCleanFreeEdge(kp.verts, kp.filletR);
}

/**
 * [AUTO-BOTTOM FIX 2026-07-26] Tách chuỗi free-edge tại đỉnh kệ E:
 *  - `mainPaths` (A→…→E): phần THÂN mảnh đáy chính (trái đường nhấn 45°).
 *  - `tabPaths`  (E→…→B): TAM GIÁC DÁN (EarL/EarR/M/C) — phải đường nhấn,
 *    dựng panel `bottom_tab_*` gập 180° quanh nếp chéo [B,E].
 * E không bao giờ bị fillet (nằm ngoài dải bo đáy sâu) nên luôn là endpoint
 * chính xác của một đoạn. Nếu không tìm thấy E (suy biến) → `tabPaths` rỗng,
 * phía gọi giữ nguyên một panel duy nhất như hành vi cũ.
 */
export function splitDeepBottomPaths(
    freeEdge: PathSegment[],
    E: Point2D,
): { mainPaths: PathSegment[]; tabPaths: PathSegment[] } {
    let splitIdx = freeEdge.length;
    for (let i = 0; i < freeEdge.length; i++) {
        const seg = freeEdge[i];
        const end = seg.type === 'bezier' && seg.controlPoints
            ? seg.controlPoints[3]
            : seg.points[seg.points.length - 1];
        if (Math.hypot(end.x - E.x, end.y - E.y) < 0.01) {
            splitIdx = i + 1;
            break;
        }
    }
    return {
        mainPaths: freeEdge.slice(0, splitIdx),
        tabPaths: splitIdx < freeEdge.length ? freeEdge.slice(splitIdx) : [],
    };
}

/**
 * Mảnh đáy CHÍNH — góc dán mép phải.
 *
 * Free-edge CUT (mẫu 100010-01): đường thẳng + bo nhẹ.
 * CREASE 45°: B → E
 */
export function buildDeepBottomFlap(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
): PathSegment[] {
    const kp = computeDeepBottomKeyPoints(xL, xR, yBase, dims);
    const paths = buildCleanFreeEdge(kp.verts, kp.filletR);
    paths.push(line(kp.B, kp.E, 'CREASE'));
    return paths;
}

/**
 * TAI đáy — góc dán mép trái (xL sau D5 = W góc cột).
 */
export function buildWingBottomFlap(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
): PathSegment[] {
    const { hWing, wingTaperIn, wingTaperOut } = dims;
    const yBot = snap(yBase - hWing);
    const span = Math.max(1, xR - xL);

    const tIn = Math.min(wingTaperIn, span * 0.4);
    const tOut = Math.min(wingTaperOut, Math.max(0, span - tIn - Math.max(2, span * 0.2)));
    const xBotL = snap(xL + tIn);
    const xBotR = snap(Math.max(xBotL + 1, xR - tOut));

    return [
        line(pt(xL, yBase), pt(xBotL, yBot), 'CUT'),
        line(pt(xBotL, yBot), pt(xBotR, yBot), 'CUT'),
        line(pt(xBotR, yBot), pt(xR, yBase), 'CUT'),
    ];
}

export function outlineFromCutChain(paths: PathSegment[]): Point2D[] {
    const cuts = paths.filter((p) => p.tag === 'CUT');
    if (cuts.length === 0) return [];

    const ring: Point2D[] = [];
    const push = (p: Point2D) => {
        if (ring.length === 0) {
            ring.push(pt(p.x, p.y));
            return;
        }
        const last = ring[ring.length - 1];
        if (Math.abs(last.x - p.x) > 1e-6 || Math.abs(last.y - p.y) > 1e-6) {
            ring.push(pt(p.x, p.y));
        }
    };

    for (const seg of cuts) {
        if (seg.type === 'bezier' && seg.controlPoints && seg.controlPoints.length >= 4) {
            const [p0, cp1, cp2, p3] = seg.controlPoints;
            const steps = 8;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const it = 1 - t;
                push({
                    x: it ** 3 * p0.x + 3 * it ** 2 * t * cp1.x + 3 * it * t ** 2 * cp2.x + t ** 3 * p3.x,
                    y: it ** 3 * p0.y + 3 * it ** 2 * t * cp1.y + 3 * it * t ** 2 * cp2.y + t ** 3 * p3.y,
                });
            }
        } else {
            for (const p of seg.points) push(p);
        }
    }

    if (ring.length > 2) {
        const a = ring[0];
        const b = ring[ring.length - 1];
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) ring.pop();
    }
    return ring.length >= 3 ? ring : [];
}

/** @deprecated */
export function deepBottomOutline(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
): Point2D[] {
    return outlineFromCutChain(buildDeepBottomFlap(xL, xR, yBase, dims));
}

/** @deprecated */
export function wingBottomOutline(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
): Point2D[] {
    return outlineFromCutChain(buildWingBottomFlap(xL, xR, yBase, dims));
}

// ─── Chú thích điểm (DEV) ─────────────────────────────────────

export type PointAnnotation = {
    point: Point2D;
    text: string;
    anchor?: 'start' | 'middle' | 'end';
    baseline?: 'hanging' | 'middle' | 'baseline' | 'bottom';
};

function uniqVerts(paths: PathSegment[], tag?: 'CUT' | 'CREASE'): Point2D[] {
    const segs = tag ? paths.filter((s) => s.tag === tag) : paths;
    const out: Point2D[] = [];
    const push = (p: Point2D) => {
        if (out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.08)) return;
        out.push(pt(p.x, p.y));
    };
    for (const s of segs) {
        for (const p of s.points) push(p);
        if (s.type === 'bezier' && s.controlPoints) {
            // chỉ đỉnh đầu/cuối bezier (đã có trong points)
        }
    }
    return out;
}

/**
 * Gán nhãn đỉnh free-edge + CREASE từ key points hình học (không dùng
 * chuỗi fillet — tránh nhãn A/I/H dính bezier fold).
 *
 * Có thể truyền kp từ lúc build; nếu thiếu sẽ suy từ CREASE + bbox CUT.
 */
export function buildDeepBottomAnnotations(
    panel: { paths: PathSegment[] },
    kp?: DeepBottomKeyPoints | null,
): PointAnnotation[] {
    const crease = panel.paths.find((s) => s.tag === 'CREASE');
    const B = crease?.points[0];
    const E = crease?.points[1];

    type Item = {
        key: string;
        text: string;
        point: Point2D;
        anchor: PointAnnotation['anchor'];
        baseline: PointAnnotation['baseline'];
    };

    const items: Item[] = [];
    const add = (
        key: string,
        text: string,
        p: Point2D | null | undefined,
        anchor: PointAnnotation['anchor'] = 'middle',
        baseline: PointAnnotation['baseline'] = 'hanging',
    ) => {
        if (!p) return;
        if (items.some((it) => Math.hypot(it.point.x - p.x, it.point.y - p.y) < 0.12)) return;
        items.push({ key, text, point: pt(p.x, p.y), anchor, baseline });
    };

    if (kp) {
        add('A', 'A — Mép trái (đoạn gấp)', kp.A, 'end', 'hanging');
        add('I', 'I — Góc đáy trái', kp.I, 'end', 'hanging');
        add('H', 'H — Vai đáy (shoulder)', kp.H, 'end', 'hanging');
        add('G', 'G — Nấc / đầu kệ trái', kp.G, 'end', 'middle');
        add('F', 'F — Kệ (shelf) trái', kp.F, 'end', 'bottom');
        add('E', 'E — Đuôi đường nhấn / đầu kệ phải', kp.E, 'start', 'bottom');
        add('EarL', 'EarL — Tai khóa trái', kp.EarL, 'start', 'hanging');
        add('EarR', 'EarR — Tai khóa phải', kp.EarR, 'start', 'hanging');
        add('M', 'M — Đỉnh tai (nối ear)', kp.M, 'start', 'middle');
        add('C', 'C — Góc step 45°', kp.C, 'start', 'middle');
        add('B', 'B — Điểm gấp đáy (đầu đường nhấn 45°)', kp.B, 'end', 'hanging');
    } else {
        // Fallback: B/E từ CREASE + endpoints CUT
        if (B) add('B', 'B — Điểm gấp đáy (đầu đường nhấn 45°)', B, 'end', 'hanging');
        if (E) add('E', 'E — Đuôi đường nhấn / đầu kệ phải', E, 'start', 'bottom');
        const cuts = panel.paths.filter((s) => s.tag === 'CUT');
        if (cuts.length > 0) {
            const p0 = cuts[0].points[0];
            const pN = cuts[cuts.length - 1].points[cuts[cuts.length - 1].points.length - 1];
            add('A', 'A — Mép trái (đoạn gấp)', p0, 'end', 'hanging');
            if (!B) add('B', 'B — Điểm gấp đáy', pN, 'end', 'hanging');
        }
    }

    return items.map(({ point, text, anchor, baseline }) => ({ point, text, anchor, baseline }));
}

/** Mọi đỉnh free-edge của tai đáy (hình thang). */
export function buildWingBottomAnnotations(panel: {
    paths: PathSegment[];
}): PointAnnotation[] {
    const chain = uniqVerts(panel.paths, 'CUT');
    if (chain.length === 0) return [];

    // 4 đỉnh điển hình: W (góc dán/gấp), botL, botR, free fold
    const labels = [
        { text: 'W — Góc free-edge đáy ↔ tai (đoạn gấp)', anchor: 'start' as const, baseline: 'hanging' as const },
        { text: 'WbL — Đáy tai trái', anchor: 'start' as const, baseline: 'hanging' as const },
        { text: 'WbR — Đáy tai phải', anchor: 'end' as const, baseline: 'hanging' as const },
        { text: 'Wf — Mép tự do tai (đoạn gấp)', anchor: 'end' as const, baseline: 'hanging' as const },
    ];

    // Sắp: y cao (gần fold) trước theo x, rồi y thấp
    const sorted = [...chain].sort((a, b) => {
        const ya = Math.round(a.y * 10) / 10;
        const yb = Math.round(b.y * 10) / 10;
        if (Math.abs(ya - yb) > 0.5) return yb - ya; // fold (y≈0) trước
        return a.x - b.x;
    });

    // 2 điểm fold (y max) trái→phải = W, Wf; 2 điểm đáy trái→phải = WbL, WbR
    const byY = [...chain].sort((a, b) => b.y - a.y);
    const foldPts = byY.filter((p) => Math.abs(p.y - byY[0].y) < 1).sort((a, b) => a.x - b.x);
    const botPts = byY.filter((p) => Math.abs(p.y - byY[byY.length - 1].y) < 1).sort((a, b) => a.x - b.x);

    const anns: PointAnnotation[] = [];
    if (foldPts[0]) anns.push({ point: foldPts[0], ...labels[0] });
    if (botPts[0]) anns.push({ point: botPts[0], ...labels[1] });
    if (botPts[1] || botPts[0]) anns.push({ point: botPts[botPts.length - 1], ...labels[2] });
    if (foldPts[1] || foldPts[0]) anns.push({ point: foldPts[foldPts.length - 1], ...labels[3] });

    // Mọi đỉnh còn lại
    for (const p of chain) {
        if (anns.some((a) => Math.hypot(a.point.x - p.x, a.point.y - p.y) < 0.08)) continue;
        anns.push({ point: p, text: 'P — Free-edge tai', anchor: 'middle', baseline: 'hanging' });
    }
    return anns;
}
