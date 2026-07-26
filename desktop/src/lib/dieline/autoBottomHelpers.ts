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
// ============================================================

import { PathSegment, Point2D } from './types';
import { pt, line, snap, filletBezier } from './utils';
import {
    AB_DEEP_DEPTH_RATIO, AB_WING_DEPTH_RATIO, AB_GLUE_LEG_RATIO,
    AB_STEP_RATIO, AB_EAR_WIDTH_RATIO, AB_EAR_INSET_RATIO,
    AB_SHELF_RATIO, AB_NOTCH_RATIO, AB_SHOULDER_RATIO, AB_BOT_INSET_RATIO,
    AB_WING_INNER_TAPER_RATIO, AB_WING_OUTER_TAPER_RATIO,
} from './constants';

/**
 * Đẩy polyline free-edge với bo tròn tại mọi góc giữa (giống junction SLB).
 * points[0]…points[n-1] là các đỉnh; bo tại points[1]…points[n-2].
 */
function filletedPolyline(points: Point2D[], radius: number): PathSegment[] {
    if (points.length < 2) return [];
    if (points.length === 2) return [line(points[0], points[1], 'CUT')];

    const r = Math.max(0.3, radius);
    const paths: PathSegment[] = [];
    let prevAnchor = points[0];

    for (let i = 1; i < points.length - 1; i++) {
        const corner = points[i];
        const prev = points[i - 1];
        const next = points[i + 1];
        const fil = filletBezier(corner, prev, next, r, 'CUT');
        const t1 = fil.points[0];
        const t2 = fil.points[fil.points.length - 1];
        // Cạnh vào góc
        if (Math.hypot(prevAnchor.x - t1.x, prevAnchor.y - t1.y) > 0.05) {
            paths.push(line(prevAnchor, t1, 'CUT'));
        } else {
            // BUG ĐÃ VÁ (audit 2026-07-26): bản cũ chỉ BỎ QUA đoạn nối cực ngắn
            // (≤0.05mm) mà KHÔNG hàn hai đầu → để lại khe 0.05mm giữa hai fillet
            // liền kề, vượt SNAP_TOLERANCE (0.01mm) ⇒ biên ngoài phôi HỞ (khuôn cắt
            // không khép kín). Chỉ lộ ra khi hai góc free-edge gần nhau (vd ABD ≥ 28
            // với W=30 → mảnh đáy sâu, các đỉnh dồn lại). Bỏ đoạn thì phải HÀN.
            weldFilletStart(fil, prevAnchor);
        }
        paths.push(fil);
        prevAnchor = fil.points[fil.points.length - 1];
    }
    // Cạnh ra đỉnh cuối
    const last = points[points.length - 1];
    if (Math.hypot(prevAnchor.x - last.x, prevAnchor.y - last.y) > 0.05) {
        paths.push(line(prevAnchor, last, 'CUT'));
    } else if (paths.length > 0) {
        // Cùng lý do trên: kéo đầu cuối của segment cuối về đúng đỉnh cuối.
        weldFilletEnd(paths[paths.length - 1], last);
    }
    return paths;
}

/** Kéo ĐẦU của một segment (line/bezier) về đúng `target` — giữ chuỗi liền mạch. */
function weldFilletStart(seg: PathSegment, target: Point2D): void {
    const p = pt(target.x, target.y);
    seg.points[0] = p;
    if (seg.type === 'bezier' && seg.controlPoints && seg.controlPoints.length >= 4) {
        seg.controlPoints[0] = p;
    }
}

/** Kéo CUỐI của một segment (line/bezier) về đúng `target` — giữ chuỗi liền mạch. */
function weldFilletEnd(seg: PathSegment, target: Point2D): void {
    const p = pt(target.x, target.y);
    seg.points[seg.points.length - 1] = p;
    if (seg.type === 'bezier' && seg.controlPoints && seg.controlPoints.length >= 4) {
        seg.controlPoints[3] = p;
    }
}

/** Khe free-edge đáy vs góc cột (W) trên đoạn gấp — mẫu ≈ 0.0134W */
export const AB_FOLD_GAP_RATIO = 0.0134;

export interface AutoBottomDims {
    hDeep: number;
    hWing: number;
    glueLeg: number;
    step: number;
    earW: number;
    earInset: number;
    shelfW: number;
    notchH: number;
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
 * Đỉnh free-edge đáy chính (trước bo) — dùng chung path + chú thích DEV.
 *
 * Mẫu 100010-01 (outer free-edge đo từ SVG):
 *   A → I → H → G → F → E → EarL → EarR → M → C → B
 * A,B trên đoạn gấp (kéo lên giao fold, bo tròn góc);
 * ear vòng ngoài — M lệch phải BC (gần B hơn đường 45°) để góc C ≠ 180°;
 * C = góc step 45° (depth ≈ step); M = đỉnh tai (depth ≈ 1.71·step, sâu hơn C).
 *
 * Canvas y-up: yM < yC < yB (M sâu nhất trong {M,C,B}, nông dần lên B).
 * Trên file mẫu SVG y↓: C.y < M.y (đúng «C Y thấp hơn» theo toạ độ mẫu).
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
    /** Polyline free-edge A…B (chưa bo) */
    verts: Point2D[];
    filletR: number;
    yBase: number;
};

export function computeDeepBottomKeyPoints(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
): DeepBottomKeyPoints {
    const {
        hDeep, hWing, step, earW, earInset,
        shelfW, notchH, shoulder, botInsetRatio, foldGap,
    } = dims;
    const span = Math.max(1, xR - xL);

    const st = Math.min(step, span * 0.2, hWing * 0.4);
    const gl = Math.max(1, hWing - st); // giữ 45° B→E
    const gap = Math.min(foldGap, span * 0.05, st * 0.5);

    // B: free-edge chạm đoạn gấp (khe foldGap so với cột W = xR)
    const xB = snap(xR - gap);
    // C: góc step 45° từ B — sâu st
    const depthC = st;
    const xC = snap(xB - depthC);
    const yC = snap(yBase - depthC);
    // E: đuôi CREASE / đầu kệ — hWing, 45° từ B
    const xE = snap(xB - st - gl); // = xB - hWing
    const yE = snap(yBase - hWing);
    const yW = yE;
    const yD = snap(yBase - hDeep);

    // Tai khóa — mẫu: outer x ≈ B − 0.013·span (gần B hơn điểm BC tại cùng depth)
    const earZone = Math.max(0, xB - xE);
    // xFromB_ear ≈ gap (mẫu 5.54/414 ≈ 0.013) — giữ M lệch phải khỏi BC
    let xEarR = snap(xB - Math.min(Math.max(gap, st * 0.12), earZone * 0.12, 4));
    let xEarL = snap(xEarR - Math.min(earW, earZone * 0.4, Math.max(2, (xEarR - xE) * 0.45)));
    if (xEarL < xE + 0.5) xEarL = snap(xE + Math.min(1, Math.max(0.5, earZone * 0.1)));
    const hasEar = xEarR > xEarL + 0.5 && earZone >= 2.5 && hDeep > hWing + 1;

    // M sâu hơn C (mẫu depth_M/depth_C ≈ 1.71) — góc C rõ (đến từ dưới, ra lên B)
    const depthM = Math.min(st * 1.71, hWing * 0.75, Math.max(st + 2.5, st * 1.5));
    const yM = snap(yBase - depthM);

    // Kệ + vai + đáy trái
    const shelfMax = Math.max(0, xE - xL - span * 0.05);
    const shW = Math.min(shelfW, shelfMax);
    const xShelfL = snap(xE - shW);
    const nH = Math.min(notchH, Math.max(0.3, hDeep - hWing - 0.3));
    const yNotch = snap(yW - nH);
    const sh = Math.min(shoulder, Math.max(0.5, hDeep - hWing - nH));
    let xShoulder = snap(xShelfL - sh);
    const xBotL = snap(xL + Math.min(botInsetRatio * span, Math.max(0.5, span * 0.02)));
    if (xShoulder < xBotL + 0.5) {
        xShoulder = snap(xBotL + Math.min(1, Math.max(0, xShelfL - xBotL)));
    }

    const filletR = snap(Math.min(2.5, Math.max(0.8, st * 0.35, gl * 0.08)));

    const A = pt(xL, yBase);
    const I = pt(xBotL, yD);
    const H = pt(xShoulder > xBotL + 0.2 ? xShoulder : xBotL, yD);
    const G = pt(xShelfL, yNotch);
    const F = pt(xShelfL, yW);
    const E = pt(xE, yW);
    const B = pt(xB, yBase);
    const C = pt(xC, yC);

    // ── Free-edge mẫu 100010-01 ────────────────────────────────
    //
    //   A ════════fold════════ B ···gap··· W
    //   |                      ／  ← bo tròn A,B (giao free-edge × fold)
    //   |                     C     step 45° (nông hơn M)
    //   |                    ／
    //   |                   M       đỉnh tai (sâu hơn C — mẫu)
    //   |                   |
    //   I…H…G…F ──── E    EarR—EarL
    //
    // Outer free-edge: A→I→H→G→F→E→EarL→EarR→M→C→B
    // CREASE: B→E (45°)

    const verts: Point2D[] = [A, I];
    if (H.x > I.x + 0.2) verts.push(H);
    if (xShelfL > H.x + 0.15) {
        verts.push(G);
        if (yNotch < yW - 0.15) verts.push(F);
    }
    verts.push(E);

    let EarL: Point2D | null = null;
    let EarR: Point2D | null = null;
    let M: Point2D | null = null;

    if (hasEar) {
        EarL = pt(xEarL, yD);
        EarR = pt(xEarR, yD);
        // M sâu hơn C (yM < yC), nông hơn đáy tai
        let yMuse = snap(Math.min(yM, yC - Math.max(2.5, st * 0.55)));
        yMuse = snap(Math.max(yMuse, yD + Math.max(4, hDeep * 0.08)));
        M = pt(xEarR, yMuse);
        // C nông hơn M
        let Cuse = C;
        if (!(Cuse.y > M.y + 1.5)) {
            const yC2 = snap(Math.min(yBase - Math.max(1.5, st * 0.6), M.y + Math.max(2.5, st * 0.55)));
            const xC2 = snap(xB - (yBase - yC2));
            Cuse = pt(xC2, yC2);
        }
        verts.push(EarL, EarR, M, Cuse, B);
        return {
            A, I, H, G, F, E, EarL, EarR, M, C: Cuse, B,
            verts, filletR, yBase,
        };
    }

    verts.push(C, B);
    return {
        A, I, H, G, F, E, EarL, EarR, M, C, B,
        verts, filletR, yBase,
    };
}

/**
 * Free-edge: bo mọi góc giữa + bo A,B với tiếp tuyến fold (giống junction khác).
 * - A,B đúng trên fold
 * - Không để CUT dài trên fold (chỉ tiếp điểm fillet)
 * - Đoạn cuối = LINE → B (D5 retarget endpoint an toàn)
 */
function filletedFreeEdgeOnFold(
    verts: Point2D[],
    radius: number,
    yBase: number,
): PathSegment[] {
    if (verts.length < 2) return [];
    if (verts.length === 2) return [line(verts[0], verts[1], 'CUT')];

    const A = verts[0];
    const B = verts[verts.length - 1];
    const afterA = verts[1];
    const beforeB = verts[verts.length - 2];

    // Bo A,B riêng với tiếp tuyến fold — không chèn đoạn fold ảo vào polyline
    const foldA = pt(snap(A.x + Math.min(8, Math.abs(B.x - A.x) * 0.06)), yBase);
    const foldB = pt(snap(B.x - Math.min(8, Math.abs(B.x - A.x) * 0.06)), yBase);
    const filA = filletBezier(A, foldA, afterA, radius, 'CUT');
    const filB = filletBezier(B, beforeB, foldB, radius, 'CUT');

    // Tangent trên free-edge sau A / trước B
    const tA = filA.points[filA.points.length - 1]; // trên A→afterA
    const tB = filB.points[0]; // trên beforeB→B

    // Polyline giữa: tA → afterA → … → beforeB → tB (bỏ A,B — đã bo)
    const midVerts: Point2D[] = [tA];
    for (let i = 1; i < verts.length - 1; i++) midVerts.push(verts[i]);
    midVerts.push(tB);

    const mid = filletedPolyline(midVerts, radius);

    // Nối: filA + mid (skip first mid seg if trùng tA) + filB + line→B
    const paths: PathSegment[] = [filA];

    // filA bắt đầu trên fold (t1) — kéo endpoint đầu về đúng A
    if (filA.points.length >= 1) {
        filA.points[0] = pt(A.x, A.y);
        if (filA.type === 'bezier' && filA.controlPoints && filA.controlPoints.length >= 4) {
            filA.controlPoints[0] = pt(A.x, A.y);
        }
    }

    for (const seg of mid) {
        paths.push(seg);
    }

    // filB: chỉnh t2 về hướng B, rồi line tới B
    paths.push(filB);
    const filBEnd = filB.points[filB.points.length - 1];
    // filB kết thúc trên fold (t2) — không giữ đoạn fold; cắt tại tB rồi line to B
    // filB.points = [tB_on_beforeB, t2_on_fold]; ta chỉ cần phần cong tới gần B
    // Đơn giản: thay endpoint cuối filB bằng điểm gần B trên free-edge, line → B
    if (Math.hypot(filBEnd.x - B.x, filBEnd.y - B.y) > 0.05) {
        // Nếu filB kết thúc trên fold, chuyển endpoint về B dọc fold rất ngắn → bỏ, line từ tB
        if (Math.abs(filBEnd.y - yBase) < 0.15) {
            // Bo kết thúc trên fold: coi filB là bo góc, endpoint cuối = B
            filB.points[filB.points.length - 1] = pt(B.x, B.y);
            if (filB.type === 'bezier' && filB.controlPoints && filB.controlPoints.length >= 4) {
                filB.controlPoints[3] = pt(B.x, B.y);
            }
        } else {
            paths.push(line(filBEnd, B, 'CUT'));
        }
    } else {
        filB.points[filB.points.length - 1] = pt(B.x, B.y);
    }

    // Đảm bảo đoạn cuối là LINE (D5)
    const last = paths[paths.length - 1];
    if (last.type !== 'line') {
        const end = last.points[last.points.length - 1];
        if (Math.hypot(end.x - B.x, end.y - B.y) > 0.02) {
            paths.push(line(end, B, 'CUT'));
        } else {
            // D5 cần đoạn cuối là LINE, nhưng segment cong đã kết thúc ĐÚNG ở B.
            // Cắt ngắn segment cong về điểm `near` (2% về phía đầu của nó) rồi nối
            // LINE near→B.
            //
            // BUG ĐÃ VÁ (audit 2026-07-26): bản cũ chỉ `push(line(near, B))` mà KHÔNG
            // kéo endpoint của segment cong về `near`. Kết quả: `near` là một đầu cắt
            // LƠ LỬNG — lệch ~0.012mm (> SNAP_TOLERANCE 0.01) khỏi mọi đầu mút khác và
            // khỏi cả đường gập → biên ngoài phôi auto_bottom KHÔNG khép kín (khuôn cắt
            // hở tại góc dán). Property 4 (`contourValidator.test.ts`) bắt đúng lỗi này.
            const prev = last.points[0];
            // Lệch TUYỆT ĐỐI 0.05mm theo hướng B→prev (KHÔNG phải 2% chiều dài: với
            // segment dài ~75mm, 2% = 1.5mm ⇒ méo hình rõ rệt).
            const dx = prev.x - B.x;
            const dy = prev.y - B.y;
            const len = Math.hypot(dx, dy) || 1;
            const step = Math.min(0.05, len * 0.5);
            const near = pt(snap(B.x + (dx / len) * step), snap(B.y + (dy / len) * step));
            last.points[last.points.length - 1] = near;
            if (last.type === 'bezier' && last.controlPoints && last.controlPoints.length >= 4) {
                last.controlPoints[3] = near;
            }
            paths.push(line(near, B, 'CUT'));
        }
    } else {
        last.points[last.points.length - 1] = pt(B.x, B.y);
    }

    return paths;
}

/**
 * Mảnh đáy CHÍNH — góc dán mép phải.
 *
 * Free-edge CUT (mẫu 100010-01):
 *   A → I → H → G → F → E → (ear) → M → C → B
 * A,B trên đoạn gấp, bo tròn góc free-edge×fold.
 * B cách cột W một khe foldGap.
 *
 * CREASE 45°: B → E
 */
export function buildDeepBottomFlap(
    xL: number, xR: number, yBase: number, dims: AutoBottomDims,
): PathSegment[] {
    const kp = computeDeepBottomKeyPoints(xL, xR, yBase, dims);
    const paths = filletedFreeEdgeOnFold(kp.verts, kp.filletR, yBase);
    // CREASE 45° B → E
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
