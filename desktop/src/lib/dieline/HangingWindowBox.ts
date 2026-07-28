// ============================================================
// Hanging Window Box — Hộp treo có cửa sổ
// (Hanging electronic product box with window)
//
// THÂN + ĐÁY + TAI BỤI + NẮP TRÊN giống hệt Reverse Tuck End (A20.20):
//   nắp gài so le — nắp trên ở mặt TRƯỚC, nắp dưới ở mặt SAU, 4 tai bụi.
// HAI KHÁC BIỆT:
//   1. TAI TREO EURO GẬP ĐÔI trên mặt SAU (thay vì mép cắt trơn):
//        mặt sau ─cấn─ lớp 1 (có lỗ euro) ─cấn─ lớp 2 (có lỗ euro)
//                ─cấn─ lưỡi khoá gài vào lòng hộp
//      Lớp 2 gập úp 180° lên lớp 1 ⇒ hai lỗ TRÙNG KHÍT thành tai treo
//      2 lớp giấy (treo không xé giấy). Lỗ đặt CÙNG khoảng cách tới nếp
//      gấp chung nên tự đối xứng gương — đây là bất biến sống còn.
//   2. CỬA SỔ bo góc trên mặt TRƯỚC (dán màng PVC/PET mặt trong).
//
// Tham số riêng chỉ 3 cái (WNW, WNH, HTH) — mọi số đo lỗ euro suy ra từ
// hằng HGB_* trong constants.ts để form thiết lập không bị rối.
//
// Số đo tham chiếu (mẫu "Hanging electronic product box with window
// dieline", L=80 W=30 D=140): cửa sổ 40×71 căn giữa mặt trước, một lớp
// tai treo 35mm, lỗ euro 28×6mm + gờ chống trượt 6×3mm.
//
// Layout trải phẳng (glueSide='left', panelOrder='LWLW'):
//
//                                      [Lưỡi khoá tai treo]
//                                      [Tai treo lớp 2 ⌷]
//                                      [Tai treo lớp 1 ⌷]
//     [Lưỡi gài trên]
//     [Nắp trên]      [TaiBụi]         [TaiBụi]
//    ┌──────┬─────────┬───────┬─────────┬───────┐
//    │ Keo  │ Trước ▭ │ Hông  │  Sau    │ Hông  │
//    │ (G)  │  (L)    │ (W)   │  (L)    │ (W)   │
//    └──────┴─────────┴───────┴─────────┴───────┘
//     [TaiBụi]         [TaiBụi]
//                      [Nắp dưới]
//                      [Lưỡi gài dưới]
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
    arcToBezier,
    filletBezier,
} from './utils';

import { buildDustFlap, buildTuckFlap } from './sharedHelpers';
import {
    GLUE_TAPER_RATIO, SLIT_OFFSET_MM, SLIT_DEPTH_MM, SLIT_FILLET_R, KAPPA,
    HGB_WINDOW_W_RATIO, HGB_WINDOW_H_RATIO, HGB_WINDOW_MARGIN_MM, HGB_WINDOW_R_MAX,
    HGB_TAB_H_RATIO, HGB_TAB_H_MIN, HGB_TAB_H_MAX,
    HGB_TAB_NECK_R_RATIO, HGB_TAB_NECK_R_MIN, HGB_TAB_NECK_R_MAX, HGB_TAB_NUB_R_T,
    HGB_SLOT_W_RATIO, HGB_SLOT_W_MIN, HGB_SLOT_W_MAX,
    HGB_SLOT_H_MM, HGB_SLOT_NIB_W_MM, HGB_SLOT_NIB_D_MM, HGB_SLOT_POS_RATIO,
} from './constants';

// ─── Kích thước dẫn xuất ─────────────────────────────────────

export interface HangingWindowDims {
    /** Cửa sổ mặt trước (mm) — đã kẹp theo lề an toàn */
    winW: number;
    winH: number;
    winR: number;
    /** Cửa sổ có dựng được không (hộp quá nhỏ thì bỏ) */
    hasWindow: boolean;
    /** Cao MỘT lớp tai treo (mm) */
    tabH: number;
    /** Cao lớp 2 = tabH + T (gập úp phải trùm qua mép hộp) */
    tab2H: number;
    /** [HANGING-WINDOW 2026-07-27] Cổ thu tại Nếp_Gấp_Chung (đo từ mẫu 100010):
     *  `neckR` = bán kính cung lượn thu cạnh bên vào, `nubR` = bán kính nút bo
     *  nhỏ nằm trên đường cấn (đầu/cuối nét cấn). */
    neckR: number;
    nubR: number;
    /** Lưỡi khoá tai treo: rộng × cao (mm).
     *  [HANGING-WINDOW 2026-07-27] `lipW` = L − 2T − C: thụt vào để đút được
     *  xuống lòng hộp; phần dôi hai bên mép trên lớp 2 thành vai cắt. */
    lipW: number;
    lipH: number;
    /** Lỗ treo euro (mm) */
    slotW: number;
    slotH: number;
    nibW: number;
    nibD: number;
    /** Tâm lỗ cách nếp gấp chung của 2 lớp (mm) — dùng CHUNG cho cả 2 lớp */
    slotPos: number;
    /** Lỗ euro có dựng được không (tai treo quá thấp thì bỏ) */
    hasSlot: boolean;
}

function clampNum(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

/**
 * Suy ra mọi kích thước phụ của hộp treo từ (L, W, D, T, C, TH) + 3 tham số
 * riêng. Mọi giá trị đều được kẹp để hộp nhỏ vẫn ra khuôn dùng được.
 */
export function hangingWindowDims(params: BoxParams): HangingWindowDims {
    const { L, W, D, T, C, TH } = params;

    // ── Cửa sổ: căn giữa mặt trước, chừa lề HGB_WINDOW_MARGIN_MM mỗi phía ──
    const maxWinW = L - 2 * HGB_WINDOW_MARGIN_MM;
    const maxWinH = D - 2 * HGB_WINDOW_MARGIN_MM;
    const winW = snap(Math.min(params.WNW > 0 ? params.WNW : HGB_WINDOW_W_RATIO * L, maxWinW));
    const winH = snap(Math.min(params.WNH > 0 ? params.WNH : HGB_WINDOW_H_RATIO * D, maxWinH));
    // [HANGING-WINDOW 2026-07-27] Cửa sổ chỉ dựng khi người dùng BẬT công tắc
    // và mặt trước còn đủ chỗ sau khi chừa lề an toàn (chỗ dán màng PVC/PET).
    const hasWindow = params.hgbWindow && winW >= 10 && winH >= 10;
    const winR = snap(Math.min(HGB_WINDOW_R_MAX, winW * 0.2, winH * 0.2));

    // ── Tai treo ──
    const tabH = snap(clampNum(
        params.HTH > 0 ? params.HTH : HGB_TAB_H_RATIO * D,
        HGB_TAB_H_MIN, HGB_TAB_H_MAX,
    ));
    const tab2H = snap(tabH + T);

    // [HANGING-WINDOW 2026-07-27] Cổ thu tại nếp gấp giữa hai lớp — số đo lấy từ
    // mẫu "…Dieline 100010.svg": cung lượn R = 20,72pt trên tai treo rộng 163,7pt
    // ⇒ 0,127 × bề rộng; nút bo r = 2,072pt = 2·T (T mẫu = 1,036pt).
    // Bề rộng tai treo = L − T (mỗi lớp thụt T/2 mỗi bên).
    const tabSpan = Math.max(1, L - T);
    const nubR = snap(clampNum(HGB_TAB_NUB_R_T * T, 0.3, Math.max(0.3, tabH * 0.15)));
    // Cung lượn phải nằm gọn trong CHIỀU CAO của lớp mỏng hơn (lớp 1 = tabH) và
    // vẫn chừa nét cấn ≥ 5mm ở giữa.
    const neckR = snap(Math.max(0.5, Math.min(
        clampNum(HGB_TAB_NECK_R_RATIO * tabSpan, HGB_TAB_NECK_R_MIN, HGB_TAB_NECK_R_MAX),
        Math.max(0.5, tabH - nubR - 1),
        Math.max(0.5, tabSpan / 2 - nubR - 2.5),
    )));

    // [HANGING-WINDOW 2026-07-27] Lưỡi khoá phải ĐÚT ĐƯỢC vào lòng hộp nên bắt
    // buộc chừa khe: mỗi bên trừ độ dày một vách (T) cộng dung sai (C/2). Đã thử
    // cho thẳng bằng mép tai treo (L − T) theo yêu cầu ban đầu nhưng khi đó lưỡi
    // rộng hơn lòng hộp thông thuỷ ⇒ gài bị kẹp/quằn giấy; giữ công thức chuẩn.
    const lipW = snap(Math.max(6, L - 2 * T - C));
    const lipH = snap(clampNum(TH > 0 ? TH : 12, 4, Math.max(4, W - T)));

    // ── Lỗ treo euro ──
    const slotW = snap(Math.min(
        clampNum(HGB_SLOT_W_RATIO * L, HGB_SLOT_W_MIN, HGB_SLOT_W_MAX),
        Math.max(0, L - 8),
    ));
    const slotH = snap(Math.min(HGB_SLOT_H_MM, tabH * 0.3));
    // [HANGING-WINDOW 2026-07-27] Gờ chống trượt là NỬA VÒNG TRÒN ⇒ chiều sâu
    // `nibD` KHÔNG còn là tham số độc lập mà bằng đúng bán kính nibW/2. Bề rộng
    // gờ vì thế bị kẹp thêm bởi 2·HGB_SLOT_NIB_D_MM để gờ không sâu quá mẫu.
    const nibW = snap(Math.min(HGB_SLOT_NIB_W_MM, slotW * 0.4, 2 * HGB_SLOT_NIB_D_MM));
    const nibD = snap(nibW / 2);
    // Tâm lỗ phải chừa ≥3mm giấy ở cả hai đầu (mép ngoài tai & nếp gấp)
    const posLo = slotH / 2 + nibD + 3;
    const posHi = tabH - slotH / 2 - 3;
    const slotPos = snap(clampNum(HGB_SLOT_POS_RATIO * tabH, posLo, posHi));
    const hasSlot = slotW >= 12 && slotH >= 3 && posHi > posLo;

    return {
        winW, winH, winR, hasWindow,
        tabH, tab2H, neckR, nubR, lipW, lipH,
        slotW, slotH, nibW, nibD, slotPos, hasSlot,
    };
}

// ─── Cửa sổ bo góc ───────────────────────────────────────────

/**
 * Cửa sổ hình chữ nhật bo 4 góc — chuỗi CUT KÍN (8 đoạn: 4 cạnh + 4 bo).
 * Tangent point lấy trực tiếp từ `filletBezier` nên points[] và
 * controlPoints[] luôn đồng bộ (bất biến 3 của prynx-dieline).
 */
export function buildRoundedWindow(
    xLeft: number, yBot: number, w: number, h: number, r: number,
): PathSegment[] {
    const x1 = snap(xLeft);
    const y1 = snap(yBot);
    const x2 = snap(x1 + w);
    const y2 = snap(y1 + h);
    const rr = snap(Math.min(r, w / 2, h / 2));

    const fBR = filletBezier(pt(x2, y1), pt(snap(x2 - rr), y1), pt(x2, snap(y1 + rr)), rr, 'CUT');
    const fTR = filletBezier(pt(x2, y2), pt(x2, snap(y2 - rr)), pt(snap(x2 - rr), y2), rr, 'CUT');
    const fTL = filletBezier(pt(x1, y2), pt(snap(x1 + rr), y2), pt(x1, snap(y2 - rr)), rr, 'CUT');
    const fBL = filletBezier(pt(x1, y1), pt(x1, snap(y1 + rr)), pt(snap(x1 + rr), y1), rr, 'CUT');

    return [
        line(fBL.points[fBL.points.length - 1], fBR.points[0], 'CUT'),
        fBR,
        line(fBR.points[fBR.points.length - 1], fTR.points[0], 'CUT'),
        fTR,
        line(fTR.points[fTR.points.length - 1], fTL.points[0], 'CUT'),
        fTL,
        line(fTL.points[fTL.points.length - 1], fBL.points[0], 'CUT'),
        fBL,
    ];
}

/**
 * [HANGING-WINDOW 2026-07-27]
 * Đổi một chuỗi CUT kín thành vòng điểm khép kín để ghi vào `Panel.holes`
 * (3D khoét lỗ thật). Đoạn bezier được chia nhỏ thành đoạn thẳng theo
 * `controlPoints` — bám đúng bất biến 3 (points ≡ controlPoints) nên vòng
 * điểm không lệch so với nét dao bế.
 */
function ringFromCutChain(paths: PathSegment[]): Point2D[] {
    const ring: Point2D[] = [];
    for (const seg of paths) {
        if (seg.tag !== 'CUT') continue;
        if (seg.type === 'bezier' && seg.controlPoints) {
            const [p0, c1, c2, p3] = seg.controlPoints;
            const STEPS = 12; // 12 đoạn/cung 90° — sai số cung < 0,01mm ở bán kính ≤ 6mm
            for (let i = 0; i < STEPS; i++) {
                const t = i / STEPS;
                const u = 1 - t;
                ring.push(pt(
                    u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
                    u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
                ));
            }
        } else {
            ring.push(seg.points[0]);
        }
    }
    return ring;
}

// ─── Lỗ treo euro ────────────────────────────────────────────



/**
 * Lỗ treo euro: khe ngang bo bán nguyệt hai đầu + gờ chống trượt ở giữa.
 *
 *        ╭──────────────────╮        ← khe rộng slotW, cao slotH
 *        ╰────┐        ┌────╯
 *              ╰──────╯              ← gờ (nib) = NỬA VÒNG TRÒN, rộng nibW
 *
 * [HANGING-WINDOW 2026-07-27] Gờ là nửa vòng tròn bán kính nibW/2 (đúng mẫu
 * khuôn thật), KHÔNG phải chữ nhật bo góc: móc treo tự trượt vào giữa và không
 * còn góc nào tập trung ứng suất.
 *
 * @param nibDir +1 = gờ nhô về phía +y, −1 = về phía −y.
 *   Hai lớp tai treo dùng nibDir ngược nhau và đặt đối xứng qua nếp gấp
 *   chung ⇒ sau khi gập úp 180° hai lỗ trùng khít.
 */
export function buildEuroSlot(
    cx: number, cy: number,
    slotW: number, slotH: number,
    nibW: number,
    nibDir: 1 | -1,
): PathSegment[] {
    const s = nibDir;
    const hw = slotW / 2;
    const r = slotH / 2;
    const lcx = snap(cx - hw + r); // tâm bo trái
    const rcx = snap(cx + hw - r); // tâm bo phải
    const yFlat = snap(cy - s * r); // cạnh phẳng (đối diện gờ)
    const yNib = snap(cy + s * r);  // cạnh có gờ
    const nx = snap(nibW / 2);

    // [HANGING-WINDOW 2026-07-27] Gờ chống trượt là NỬA VÒNG TRÒN (bán kính
    // rNib = nibW/2), không phải chữ nhật bo góc: mẫu khuôn thật cắt nửa cung
    // tròn nên móc treo tự trượt vào giữa và không có góc nào tập trung ứng suất.
    // Chiều sâu gờ = đúng bán kính ⇒ `nibD` do dims suy ra = nibW/2.
    const rNib = snap(nibW / 2);

    return [
        // Cạnh phẳng
        line(pt(lcx, yFlat), pt(rcx, yFlat), 'CUT'),
        // Bo bán nguyệt phải (2 cung 90° — 1 cung 180° bằng 1 bezier sai số lớn)
        arcToBezier(rcx, cy, r, -s * 90, 0, 'CUT'),
        arcToBezier(rcx, cy, r, 0, s * 90, 'CUT'),
        // Cạnh có gờ: mép phải → chân gờ phải
        line(pt(rcx, yNib), pt(snap(cx + nx), yNib), 'CUT'),
        // Nửa vòng tròn của gờ, phình về phía s (2 cung 90° cho tròn đúng)
        arcToBezier(cx, yNib, rNib, 0, s * 90, 'CUT'),
        arcToBezier(cx, yNib, rNib, s * 90, s * 180, 'CUT'),
        // Chân gờ trái → mép trái
        line(pt(snap(cx - nx), yNib), pt(lcx, yNib), 'CUT'),
        // Bo bán nguyệt trái
        arcToBezier(lcx, cy, r, s * 90, s * 180, 'CUT'),
        arcToBezier(lcx, cy, r, s * 180, s * 270, 'CUT'),
    ];
}

/**
 * Sinh bản vẽ khuôn bế Hộp treo có cửa sổ.
 *
 * Gốc tọa độ (0,0) = góc dưới-trái của Glue Flap.
 */
export function generateHangingWindowBox(params: BoxParams): DielineModel {
    const { L, W, D, T, C, G, TH, glueSide, panelOrder } = params;

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];
    const modelWarnings: string[] = [];
    const dims = hangingWindowDims(params);

    // ============================================================
    // A. Tọa độ X các cột — giống RTE
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

    const isFrontFirst = panelOrder === 'LWLW';
    const [xFrontL, xFrontR] = isFrontFirst ? [x1, x2] : [x2, x3];
    const [xBackL, xBackR] = isFrontFirst ? [x3, x4] : [x4, x5];
    const [xSideAL, xSideAR] = isFrontFirst ? [x2, x3] : [x1, x2];
    const [xSideBL, xSideBR] = isFrontFirst ? [x4, x5] : [x3, x4];

    const pn = isFrontFirst
        ? ['front', 'right', 'back', 'left']
        : ['left', 'front', 'right', 'back'];

    const yBot = 0;
    const yTop = snap(D);

    // Front: nắp trên (CREASE tại yTop+T). Back: TAI TREO (CREASE tại yTop —
    // khác RTE, nơi mép trên mặt sau là CUT trơn). Side: tai bụi (CREASE).
    const yTopFront = snap(yTop + T);
    const yBotBack = snap(yBot - T);
    const colTopY = pn.map(r => r === 'front' ? yTopFront : yTop);
    const colBotY = pn.map(r => r === 'back' ? yBotBack : yBot);
    const colTopTag: Array<'CUT' | 'CREASE'> = pn.map(() => 'CREASE');
    const colBotTag: Array<'CUT' | 'CREASE'> = pn.map(r => r === 'front' ? 'CUT' : 'CREASE');

    const x2YTop = snap(Math.max(colTopY[0], colTopY[1]));
    const x2YBot = snap(Math.min(colBotY[0], colBotY[1]));
    const x3YTop = snap(Math.max(colTopY[1], colTopY[2]));
    const x3YBot = snap(Math.min(colBotY[1], colBotY[2]));
    const x4YTop = snap(Math.max(colTopY[2], colTopY[3]));
    const x4YBot = snap(Math.min(colBotY[2], colBotY[3]));

    // ============================================================
    // B. THÂN HỘP — giống RTE
    // ============================================================
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
            pt(xGlueOuter, yBot + glueVat), pt(xGlueInner, yBot), pt(xGlueInner, yTop), pt(xGlueOuter, yTop - glueVat),
        ] : [
            pt(xGlueInner, yBot), pt(xGlueOuter, yBot + glueVat), pt(xGlueOuter, yTop - glueVat), pt(xGlueInner, yTop),
        ],
        parent: glueSide === 'left' ? pn[0] : pn[3],
        pivotEdge: [pt(xGlueInner, yBot), pt(xGlueInner, yTop)],
        foldAngle: glueSide === 'left' ? 92 : -92,
        foldDirection: -1,
    });

    const leftPaths: PathSegment[] = [
        line(pt(x1, colBotY[0]), pt(x2, colBotY[0]), colBotTag[0]),
        line(pt(x2, x2YBot), pt(x2, x2YTop), 'CREASE'),
        line(pt(x2, colTopY[0]), pt(x1, colTopY[0]), colTopTag[0]),
    ];
    if (glueSide === 'right') {
        leftPaths.push(line(pt(x1, colTopY[0]), pt(x1, colBotY[0]), 'CUT'));
    }
    allPaths.push(...leftPaths);
    panels.push({
        name: pn[0],
        label: pn[0] === 'left' ? 'Hông trái' : 'Mặt trước',
        paths: leftPaths,
        outline: [pt(x1, colBotY[0]), pt(x2, colBotY[0]), pt(x2, x2YTop), pt(x1, colTopY[0])],
        parent: pn[1],
        pivotEdge: [pt(x2, yBot), pt(x2, yTop)],
        foldAngle: 90,
        foldDirection: -1,
    });

    const frontPaths: PathSegment[] = [
        line(pt(x2, colBotY[1]), pt(x3, colBotY[1]), colBotTag[1]),
        line(pt(x3, x3YBot), pt(x3, x3YTop), 'CREASE'),
        line(pt(x2, colTopY[1]), pt(x3, colTopY[1]), colTopTag[1]),
    ];
    allPaths.push(...frontPaths);
    panels.push({
        name: pn[1],
        label: pn[1] === 'front' ? 'Mặt trước' : 'Hông phải',
        paths: frontPaths,
        outline: [pt(x2, colBotY[1]), pt(x3, colBotY[1]), pt(x3, x3YTop), pt(x2, colTopY[1])],
        parent: null, // ROOT
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: -1,
    });

    const rightPaths: PathSegment[] = [
        line(pt(x3, colBotY[2]), pt(x4, colBotY[2]), colBotTag[2]),
        line(pt(x4, x4YBot), pt(x4, x4YTop), 'CREASE'),
        line(pt(x4, colTopY[2]), pt(x3, colTopY[2]), colTopTag[2]),
    ];
    allPaths.push(...rightPaths);
    panels.push({
        name: pn[2],
        label: pn[2] === 'right' ? 'Hông phải' : 'Mặt sau',
        paths: rightPaths,
        outline: [pt(x3, colBotY[2]), pt(x4, colBotY[2]), pt(x4, x4YTop), pt(x3, colTopY[2])],
        parent: pn[1],
        pivotEdge: [pt(x3, yBot), pt(x3, yTop)],
        foldAngle: -90,
        foldDirection: -1,
    });

    const backPaths: PathSegment[] = [
        line(pt(x4, colBotY[3]), pt(x5, colBotY[3]), colBotTag[3]),
        line(pt(x5, yBot), pt(x5, yTop), glueSide === 'left' ? 'CUT' : 'CREASE'),
        line(pt(x5, colTopY[3]), pt(x4, colTopY[3]), colTopTag[3]),
    ];
    allPaths.push(...backPaths);
    panels.push({
        name: pn[3],
        label: pn[3] === 'back' ? 'Mặt sau' : 'Hông trái',
        paths: backPaths,
        outline: [pt(x4, colBotY[3]), pt(x5, colBotY[3]), pt(x5, yTop), pt(x4, colTopY[3])],
        parent: pn[2],
        pivotEdge: [pt(x4, yBot), pt(x4, yTop)],
        foldAngle: -90,
        foldDirection: -1,
    });

    // ============================================================
    // C. TAI CHỐNG BỤI — giống RTE
    // ============================================================
    const autoDustH = snap(Math.min(L / 2 - 1, W - T));
    const dustH = params.DFH > 0 ? snap(Math.min(params.DFH, L / 2 - 1)) : autoDustH;
    const h = snap(T / 2);

    const sideAIsLeft = !isFrontFirst;
    const sideBIsLeft = isFrontFirst;

    const dustTL = buildDustFlap(xSideAL, xSideAR, yTop, dustH, 1, sideAIsLeft);
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

    const dustTR = buildDustFlap(xSideBL, xSideBR, yTop, dustH, 1, sideBIsLeft);
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

    const dustBL = buildDustFlap(xSideAL, xSideAR, yBot, dustH, -1, !sideAIsLeft);
    allPaths.push(...dustBL);
    panels.push({
        name: 'dust_bot_left',
        label: 'Tai bụi dưới-trái',
        paths: dustBL,
        parent: isFrontFirst ? 'right' : 'left',
        pivotEdge: [pt(xSideAL, yBot), pt(xSideAR, yBot)],
        foldAngle: -90,
        foldDirection: -1,
        foldPhase: [0.1, 0.4],
    });

    const dustBR = buildDustFlap(xSideBL, xSideBR, yBot, dustH, -1, !sideBIsLeft);
    allPaths.push(...dustBR);
    panels.push({
        name: 'dust_bot_right',
        label: 'Tai bụi dưới-phải',
        paths: dustBR,
        parent: isFrontFirst ? 'left' : 'right',
        pivotEdge: [pt(xSideBL, yBot), pt(xSideBR, yBot)],
        foldAngle: -90,
        foldDirection: -1,
        foldPhase: [0.1, 0.4],
    });
    // ============================================================
    // D. CỬA SỔ MẶT TRƯỚC — [HANGING-WINDOW 2026-07-27]
    //    Cửa sổ bo góc, LUÔN căn giữa mặt trước theo cả hai trục
    //    (tâm = (xFrontL + xFrontR)/2 × D/2). hangingWindowDims() đã kẹp
    //    winW ≤ L − 2·HGB_WINDOW_MARGIN_MM và winH ≤ D − 2·HGB_WINDOW_MARGIN_MM
    //    nên lề an toàn để dán màng PVC/PET tự thoả — ở đây chỉ cần guard
    //    suy biến hasWindow (công tắc tắt hoặc mặt trước quá nhỏ).
    // ============================================================
    if (dims.hasWindow) {
        const cxWin = snap((xFrontL + xFrontR) / 2);
        const cyWin = snap(D / 2);
        const windowPaths = buildRoundedWindow(
            snap(cxWin - dims.winW / 2),
            snap(cyWin - dims.winH / 2),
            dims.winW, dims.winH, dims.winR,
        );
        allPaths.push(...windowPaths);

        // Ghi vòng kín vào holes của panel mặt trước → 3D khoét lỗ thật,
        // không chỉ vẽ nét cắt trên canvas.
        const frontPanel = panels.find(p => p.name === 'front');
        if (frontPanel) {
            frontPanel.holes = frontPanel.holes ?? [];
            frontPanel.holes.push(ringFromCutChain(windowPaths));
        }
    } else if (params.hgbWindow) {
        // Người dùng BẬT cửa sổ nhưng mặt trước không còn đủ chỗ sau khi
        // chừa lề an toàn ⇒ bỏ cửa sổ và báo để họ tăng L/D hoặc giảm WNW/WNH.
        modelWarnings.push(
            'Hộp treo: mặt trước quá nhỏ để mở cửa sổ (cần ≥ 10mm mỗi chiều sau khi chừa lề '
            + `${HGB_WINDOW_MARGIN_MM}mm) — đã bỏ cửa sổ.`,
        );
    }

    // ============================================================
    // E. NẮP ĐẬY + LƯỠI GÀI SO LE — [HANGING-WINDOW 2026-07-27]
    //    Sao nguyên hợp đồng hình học của ReverseTuckEnd.ts (§D nắp đậy,
    //    §E lưỡi gài): nắp trên gắn đỉnh mặt TRƯỚC, nắp dưới gắn đáy mặt SAU
    //    (nắp gài so le của ECMA A20.20). Chủ đích KHÔNG trích helper dùng
    //    chung với RTE trong đợt này (xem Design Decision 4) — bước
    //    connectCorner mutate endpoint theo thứ tự mảng, gộp chung sẽ đặt
    //    hộp RTE đang chạy production vào vùng rủi ro hồi quy.
    //    Khác RTE duy nhất ở foldPhase: hộp treo phải gập tai treo trước,
    //    nên nắp/lưỡi gài lùi về cuối hành trình (0,60 → 0,95).
    // ============================================================

    // Khe gài (slit lock) — số đo lấy từ hằng dùng chung với RTE
    const sx1 = snap(SLIT_OFFSET_MM);      // vị trí khe gài tính từ mép panel
    const slitDropT = snap(SLIT_DEPTH_MM); // chiều sâu khe gài
    const slitR = snap(SLIT_FILLET_R);     // bo nhẹ chỗ ngoặt của khe gài
    const slitK = snap(slitR * KAPPA);     // hệ số kappa cho bezier bo góc

    // --- E1. Nắp đậy trên (trên mặt trước) ---
    const closureTopY = snap(yTop + T);           // nếp gấp nắp ↔ mặt trước
    const tuckTopCreaseY = snap(yTop + W - T);    // khẩu độ nắp = W − T (bù mất giấy khi gấp)

    // Hai cạnh bên lùi vào h = T/2 để nắp không đè tai bụi khi gập
    const xCTL = snap(xFrontL + h);
    const xCTR = snap(xFrontR - h);

    // CREASE tại closureTopY trùng cạnh trên thân mặt trước → chỉ giữ cho panel 3D
    const closureTopCrease = line(pt(xCTL, closureTopY), pt(xCTR, closureTopY), 'CREASE');
    const closureTopPaths: PathSegment[] = [
        // Cạnh TRÁI: thụt T/2
        line(pt(xCTL, yTop), pt(xCTL, tuckTopCreaseY), 'CUT'),
        // Khe gài BÊN TRÁI — bo góc tại chỗ ngoặt để giấy không nứt
        line(pt(xCTL, tuckTopCreaseY), pt(snap(xFrontL + sx1 - slitR), tuckTopCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xFrontL + sx1 - slitR), tuckTopCreaseY),
            pt(snap(xFrontL + sx1 - slitR + slitK), tuckTopCreaseY),
            pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitK)),
            pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitR)),
            'CUT'),
        line(pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitR)), pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitDropT)), 'CUT'),
        // Nét lằn nhấn lưỡi gài — nằm giữa chiều sâu khe gài
        line(pt(snap(xFrontL + sx1), snap(tuckTopCreaseY - slitDropT / 2)), pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitDropT / 2)), 'CREASE'),
        // Khe gài BÊN PHẢI
        line(pt(xCTR, tuckTopCreaseY), pt(snap(xFrontR - sx1 + slitR), tuckTopCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xFrontR - sx1 + slitR), tuckTopCreaseY),
            pt(snap(xFrontR - sx1 + slitR - slitK), tuckTopCreaseY),
            pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitK)),
            pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitR)),
            'CUT'),
        line(pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitR)), pt(snap(xFrontR - sx1), snap(tuckTopCreaseY - slitDropT)), 'CUT'),
        // Cạnh PHẢI: thụt T/2
        line(pt(xCTR, tuckTopCreaseY), pt(xCTR, yTop), 'CUT'),
    ];
    allPaths.push(...closureTopPaths);
    panels.push({
        name: 'closure_top',
        label: 'Nắp đậy trên',
        paths: [closureTopCrease, ...closureTopPaths],
        outline: [pt(xCTL, yTop), pt(xCTR, yTop), pt(xCTR, tuckTopCreaseY), pt(xCTL, tuckTopCreaseY)],
        parent: 'front',
        pivotEdge: [pt(xCTL, closureTopY), pt(xCTR, closureTopY)],
        foldAngle: 90,
        foldDirection: -1,
        foldPhase: [0.6, 0.95],
    });

    // --- Nối liền tai bụi ↔ nắp đậy (sao từ ReverseTuckEnd.ts §D) ---
    // Giao điểm hai đường thẳng — dùng để kéo endpoint tai bụi và cạnh nắp
    // về đúng một điểm, tránh chuỗi CUT hở (bất biến 1 của prynx-dieline).
    const lineIntersect = (a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null => {
        const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
        const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) < 1e-10) return null;
        const t = ((b1.x - a1.x) * dy2 - (b1.y - a1.y) * dx2) / denom;
        return pt(snap(a1.x + t * dx1), snap(a1.y + t * dy1));
    };

    // Bo nhọn: bezier kéo control point về phía góc → đỉnh nhọn hướng thân hộp
    const pointedFillet = (
        corner: Point2D, prev: Point2D, next: Point2D, d: number,
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

    // Nối cạnh nắp với endpoint tai bụi gần nhất (tự động cho cả WLWL / LWLW).
    // Giữ nguyên cách mutate endpoint của RTE: sửa cả mảng tai bụi lẫn cạnh nắp
    // rồi splice đoạn bo vào đúng chỗ để chuỗi CUT liền mạch thực sự.
    const connectCorner = (
        closureEdge: PathSegment, isLeftEdge: boolean,
        dustA: PathSegment[], dustB: PathSegment[],
        bridgeP1: Point2D, bridgeP2: Point2D,
    ) => {
        const cPt = isLeftEdge ? closureEdge.points[0] : closureEdge.points[closureEdge.points.length - 1];
        const candidates = [
            { seg: dustA[dustA.length - 1], end: true, arr: dustA },
            { seg: dustB[dustB.length - 1], end: true, arr: dustB },
            { seg: dustA[0], end: false, arr: dustA },
            { seg: dustB[0], end: false, arr: dustB },
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
                    const dustIdx = c.arr.indexOf(c.seg);
                    if (c.end) { c.arr.splice(dustIdx + 1, 0, fillet); }
                    else { c.arr.splice(dustIdx, 0, fillet); }
                    allPaths.push(fillet);
                    return;
                }
            }
        }
        allPaths.push(line(bridgeP1, bridgeP2, 'CUT'));
    };

    // Hai góc của nắp trên
    connectCorner(closureTopPaths[0], true, dustTL, dustTR, pt(xFrontL, yTop), pt(xCTL, yTop));
    connectCorner(closureTopPaths[closureTopPaths.length - 1], false, dustTL, dustTR, pt(xCTR, yTop), pt(xFrontR, yTop));

    // --- E2. Nắp đậy dưới (dưới mặt sau) ---
    const closureBotY = snap(yBot - T);           // nếp gấp nắp ↔ mặt sau
    const tuckBotCreaseY = snap(yBot - W + T);    // khẩu độ nắp = W − T

    const xCBL = snap(xBackL + h);
    const xCBR = snap(xBackR - h);

    // CREASE tại closureBotY trùng cạnh dưới thân mặt sau → chỉ giữ cho panel 3D
    const closureBotCrease = line(pt(xCBL, closureBotY), pt(xCBR, closureBotY), 'CREASE');
    const closureBotPaths: PathSegment[] = [
        // Cạnh TRÁI: thụt T/2
        line(pt(xCBL, yBot), pt(xCBL, tuckBotCreaseY), 'CUT'),
        // Khe gài BÊN TRÁI
        line(pt(xCBL, tuckBotCreaseY), pt(snap(xBackL + sx1 - slitR), tuckBotCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xBackL + sx1 - slitR), tuckBotCreaseY),
            pt(snap(xBackL + sx1 - slitR + slitK), tuckBotCreaseY),
            pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitK)),
            pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitR)),
            'CUT'),
        line(pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitR)), pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitDropT)), 'CUT'),
        // Nét lằn nhấn lưỡi gài
        line(pt(snap(xBackL + sx1), snap(tuckBotCreaseY + slitDropT / 2)), pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitDropT / 2)), 'CREASE'),
        // Khe gài BÊN PHẢI
        line(pt(xCBR, tuckBotCreaseY), pt(snap(xBackR - sx1 + slitR), tuckBotCreaseY), 'CUT'),
        bezierSegment(
            pt(snap(xBackR - sx1 + slitR), tuckBotCreaseY),
            pt(snap(xBackR - sx1 + slitR - slitK), tuckBotCreaseY),
            pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitK)),
            pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitR)),
            'CUT'),
        line(pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitR)), pt(snap(xBackR - sx1), snap(tuckBotCreaseY + slitDropT)), 'CUT'),
        // Cạnh PHẢI: thụt T/2
        line(pt(xCBR, tuckBotCreaseY), pt(xCBR, yBot), 'CUT'),
    ];
    allPaths.push(...closureBotPaths);
    panels.push({
        name: 'closure_bot',
        label: 'Nắp đậy dưới',
        paths: [closureBotCrease, ...closureBotPaths],
        outline: [pt(xCBL, yBot), pt(xCBR, yBot), pt(xCBR, tuckBotCreaseY), pt(xCBL, tuckBotCreaseY)],
        parent: 'back',
        pivotEdge: [pt(xCBL, closureBotY), pt(xCBR, closureBotY)],
        foldAngle: -90,
        foldDirection: -1,
        foldPhase: [0.6, 0.95],
    });

    // Hai góc của nắp dưới
    connectCorner(closureBotPaths[0], true, dustBL, dustBR, pt(xBackL, yBot), pt(xCBL, yBot));
    connectCorner(closureBotPaths[closureBotPaths.length - 1], false, dustBL, dustBR, pt(xCBR, yBot), pt(xBackR, yBot));

    // --- E3. Lưỡi gài (tuck-in) — công thức sống còn của nắp gài ---
    //     Rộng = L − 2·T − C (bù hai bên hông + dung sai bế), cao = TH.
    //     Đáy lưỡi gài phải TRÙNG cạnh ngoài của nắp, lệch T là lưỡi hở khỏi nắp.
    const tuckW = snap(L - 2 * T - C);
    const tuckH = snap(TH);
    const tuckInset = snap((L - tuckW) / 2);
    const tuckR = snap(Math.min(3, tuckW * 0.05));

    // Lưỡi gài trên (nối tiếp nắp trên)
    const tuckTopBase = tuckTopCreaseY;
    const tuckTopPaths: PathSegment[] = buildTuckFlap(
        xFrontL + tuckInset, tuckTopBase, tuckW, tuckH, tuckR, 1,
    );
    allPaths.push(...tuckTopPaths);
    panels.push({
        name: 'tuck_top',
        label: 'Lưỡi gài trên',
        paths: tuckTopPaths,
        parent: 'closure_top',
        pivotEdge: [pt(xFrontL, tuckTopBase), pt(xFrontR, tuckTopBase)],
        foldAngle: 92,
        foldDirection: -1,
        foldPhase: [0.75, 0.95],
    });

    // Lưỡi gài dưới (nối tiếp nắp dưới) — ngược chiều
    const tuckBotBase = tuckBotCreaseY;
    const tuckBotPaths: PathSegment[] = buildTuckFlap(
        xBackL + tuckInset, tuckBotBase, tuckW, tuckH, tuckR, -1,
    );
    allPaths.push(...tuckBotPaths);
    panels.push({
        name: 'tuck_bot',
        label: 'Lưỡi gài dưới',
        paths: tuckBotPaths,
        parent: 'closure_bot',
        pivotEdge: [pt(xBackL, tuckBotBase), pt(xBackR, tuckBotBase)],
        foldAngle: -92,
        foldDirection: -1,
        foldPhase: [0.75, 0.95],
    });

    // ============================================================
    // F. TAI TREO EURO GẬP ĐÔI (trên mặt SAU) — [HANGING-WINDOW 2026-07-27]
    //    Chuỗi panel: back ─cấn─ lớp 1 ─cấn(Nếp_Gấp_Chung)─ lớp 2 ─cấn─ lưỡi khoá.
    //
    //    Toạ độ y (gốc y = 0 ở đáy hộp, tăng lên trên):
    //      yTabBase = D                  ← cấn mặt sau ↔ lớp 1 (đã vẽ ở khối B)
    //      yTabMid  = D + tabH           ← Nếp_Gấp_Chung
    //      yTabTop  = D + tabH + tab2H   ← cấn lớp 2 ↔ lưỡi khoá
    //
    //    Lớp 1 đồng phẳng mặt sau (foldAngle = 0) — nó tồn tại như panel riêng
    //    chỉ để MANG Lỗ_Euro trong `holes` và làm gốc gập thật cho lớp 2.
    //    Lớp 2 cao tab2H = tabH + T (bù mất giấy khi gập úp) và gập 180° quanh
    //    Nếp_Gấp_Chung, `renderZShift` âm để hai lớp giấy không đồng phẳng.
    // ============================================================
    const yTabBase = yTop;                          // cấn mặt sau ↔ lớp 1
    const yTabMid = snap(yTabBase + dims.tabH);      // Nếp_Gấp_Chung
    const yTabTop = snap(yTabMid + dims.tab2H);      // cấn lớp 2 ↔ lưỡi khoá

    // Hai lớp và lưỡi khoá đều thụt h = T/2 mỗi bên so với mặt sau (cùng quy
    // ước với nắp đậy) để khi gập không đè lên tai chống bụi.
    const xTabL = snap(xBackL + h);
    const xTabR = snap(xBackR - h);

    // BẤT BIẾN SỐNG CÒN: hai Lỗ_Euro cùng hoành độ tâm và CÙNG khoảng cách
    // slotPos tới Nếp_Gấp_Chung, `nibDir` ngược dấu. Sau khi lớp 2 gập úp 180°,
    // phép phản chiếu y ↦ 2·yTabMid − y biến lỗ lớp 2 thành lỗ lớp 1 (kể cả gờ
    // chống trượt) ⇒ hai lỗ trùng khít, treo không xé giấy.
    const cxSlot = snap((xBackL + xBackR) / 2);
    const cySlot1 = snap(yTabMid - dims.slotPos);
    const cySlot2 = snap(yTabMid + dims.slotPos);

    // ── CỔ THU tại Nếp_Gấp_Chung — đo từ mẫu "…Dieline 100010.svg" ──
    // Hai bên nếp cấn KHÔNG phải cạnh thẳng chạy suốt (bản trước) cũng không
    // phải rãnh cắt vuông (bản trước nữa). Mẫu thật: cạnh bên của mỗi lớp lượn
    // vào bằng CUNG TRÒN bán kính R (đo được 20,72pt ≈ 0,127 × bề rộng tai treo,
    // tiếp tuyến đứng ở trên/dưới và tiếp tuyến ngang tại cổ), rồi khép lại bằng
    // NÚT BO nhỏ bán kính 2·T nằm ĐÚNG trên đường cấn (mẫu: 2,072pt với T =
    // 1,036pt). Nét cấn chạy giữa hai ĐỈNH nút. Cổ thu cho hai lớp gập úp 180°
    // mà không căng góc; nút bo là điểm kết thúc nét cấn, chống nứt/xé mép.
    const neckR = dims.neckR;
    const nubR = dims.nubR;
    const yTanBot = snap(yTabMid - nubR - neckR); // tiếp tuyến đứng phía lớp 1
    const yTanTop = snap(yTabMid + nubR + neckR); // tiếp tuyến đứng phía lớp 2
    const xNeckL = snap(xTabL + neckR);           // tâm nút bo trái
    const xNeckR = snap(xTabR - neckR);           // tâm nút bo phải
    const xCreaseL = snap(xNeckL + nubR);         // đỉnh nút trái = đầu nét cấn
    const xCreaseR = snap(xNeckR - nubR);         // đỉnh nút phải = cuối nét cấn

    const slotPathsFor = (slot: { cy: number; nibDir: 1 | -1 } | null) => (slot
        ? buildEuroSlot(cxSlot, slot.cy, dims.slotW, dims.slotH, dims.nibW, slot.nibDir)
        : []);

    /** Vòng điểm outline từ chuỗi đoạn (đã theo đúng thứ tự) + điểm khép cuối. */
    const outlineFrom = (segs: PathSegment[], last: Point2D): Point2D[] => {
        const ring = ringFromCutChain(segs.map(s => (s.tag === 'CUT' ? s : { ...s, tag: 'CUT' as const })));
        ring.push(last);
        return ring;
    };

    if (!dims.hasSlot) {
        // Tai treo quá thấp (HTH nhỏ hoặc D nhỏ) ⇒ dựng tai treo TRƠN, không
        // khoét lỗ, để không sinh nét cắt phá mép hoặc chồm qua nếp gấp.
        modelWarnings.push(
            'Hộp treo: tai treo quá thấp để đặt lỗ treo — đã bỏ lỗ euro. '
            + 'Hãy tăng HTH hoặc chiều cao D.',
        );
    }

    // --- F1. Lớp 1 (đồng phẳng mặt sau, mang Lỗ_Euro thứ nhất) ---
    // Nét cấn mặt sau ↔ lớp 1: cạnh trên mặt sau đã vẽ ở khối B nên chỉ đưa vào
    // `paths` của panel (không push lại vào allPaths để khỏi nhân đôi nét cấn).
    const tabBaseCrease = line(pt(xTabL, yTabBase), pt(xTabR, yTabBase), 'CREASE');

    // Nét cấn giữa hai lớp chạy giữa hai ĐỈNH nút bo (không suốt bề rộng).
    const tabMidCrease = line(pt(xCreaseL, yTabMid), pt(xCreaseR, yTabMid), 'CREASE');

    // Chuỗi CUT nửa DƯỚI cổ thu (thuộc lớp 1), đi từ trái sang phải:
    //   cạnh bên trái ↑ → cung R lượn vào → 1/4 nút bo → [nét cấn] →
    //   1/4 nút bo phải → cung R lượn ra → cạnh bên phải ↓
    const edge1L = line(pt(xTabL, yTabBase), pt(xTabL, yTanBot), 'CUT');
    const arcBotL = arcToBezier(xNeckL, yTanBot, neckR, 180, 90, 'CUT');
    const nubBotL = arcToBezier(xNeckL, yTabMid, nubR, -90, 0, 'CUT');
    const nubBotR = arcToBezier(xNeckR, yTabMid, nubR, 180, 270, 'CUT');
    const arcBotR = arcToBezier(xNeckR, yTanBot, neckR, 90, 0, 'CUT');
    const edge1R = line(pt(xTabR, yTanBot), pt(xTabR, yTabBase), 'CUT');
    const layer1Cuts = [edge1L, arcBotL, nubBotL, nubBotR, arcBotR, edge1R];
    const slot1Paths = slotPathsFor(dims.hasSlot ? { cy: cySlot1, nibDir: 1 } : null);

    allPaths.push(...layer1Cuts, tabMidCrease, ...slot1Paths);
    panels.push({
        name: 'hang_tab_1',
        label: 'Tai treo lớp 1',
        paths: [tabBaseCrease, ...layer1Cuts, tabMidCrease, ...slot1Paths],
        outline: outlineFrom(
            [edge1L, arcBotL, nubBotL, line(pt(xCreaseL, yTabMid), pt(xCreaseR, yTabMid), 'CUT'),
                nubBotR, arcBotR, edge1R],
            pt(xTabR, yTabBase),
        ),
        holes: slot1Paths.length > 0 ? [ringFromCutChain(slot1Paths)] : undefined,
        parent: 'back',
        pivotEdge: [pt(xTabL, yTabBase), pt(xTabR, yTabBase)],
        foldAngle: 0, // chủ đích: tai treo nằm cùng mặt phẳng với mặt sau
        foldDirection: -1,
        foldPhase: [0.05, 0.2],
    });

    // Nối liền hai góc chân tai treo với tai chống bụi trên (cùng cách RTE nối
    // nắp đậy ↔ tai bụi) để chuỗi CUT không hở T/2 ở cạnh trên mặt sau.
    connectCorner(edge1L, true, dustTL, dustTR, pt(xBackL, yTabBase), pt(xTabL, yTabBase));
    connectCorner(edge1R, false, dustTL, dustTR, pt(xTabR, yTabBase), pt(xBackR, yTabBase));

    // --- F2. Lớp 2 (gập úp 180° lên lớp 1, mang Lỗ_Euro thứ hai) ---
    // Nửa TRÊN cổ thu (thuộc lớp 2) — phản chiếu nửa dưới qua Nếp_Gấp_Chung.
    const nubTopL = arcToBezier(xNeckL, yTabMid, nubR, 0, 90, 'CUT');
    const arcTopL = arcToBezier(xNeckL, yTanTop, neckR, 270, 180, 'CUT');
    const edge2L = line(pt(xTabL, yTanTop), pt(xTabL, yTabTop), 'CUT');
    const edge2R = line(pt(xTabR, yTabTop), pt(xTabR, yTanTop), 'CUT');
    const arcTopR = arcToBezier(xNeckR, yTanTop, neckR, 0, -90, 'CUT');
    const nubTopR = arcToBezier(xNeckR, yTabMid, nubR, 90, 180, 'CUT');
    const slot2Paths = slotPathsFor(dims.hasSlot ? { cy: cySlot2, nibDir: -1 } : null);
    // Lưỡi khoá hẹp hơn tai treo (chừa khe đút vào lòng hộp) ⇒ phần dôi ra hai
    // bên mép trên lớp 2 là nét CẮT (vai lưỡi khoá), chỉ đoạn giữa mới là nét cấn.
    const lipW = snap(Math.min(dims.lipW, xTabR - xTabL));
    const xLipL = snap(cxSlot - lipW / 2);
    const xLipR = snap(xLipL + lipW);
    const lipCrease = line(pt(xLipL, yTabTop), pt(xLipR, yTabTop), 'CREASE');
    const lipShoulders: PathSegment[] = [];
    if (xLipL - xTabL > 0.01) lipShoulders.push(line(pt(xTabL, yTabTop), pt(xLipL, yTabTop), 'CUT'));
    if (xTabR - xLipR > 0.01) lipShoulders.push(line(pt(xLipR, yTabTop), pt(xTabR, yTabTop), 'CUT'));
    const layer2Cuts = [nubTopL, arcTopL, edge2L, ...lipShoulders, edge2R, arcTopR, nubTopR];
    allPaths.push(nubTopL, arcTopL, edge2L, edge2R, arcTopR, nubTopR, lipCrease, ...lipShoulders, ...slot2Paths);
    panels.push({
        name: 'hang_tab_2',
        label: 'Tai treo lớp 2',
        paths: [tabMidCrease, ...layer2Cuts, lipCrease, ...slot2Paths],
        outline: outlineFrom(
            [nubTopL, arcTopL, edge2L, line(pt(xTabL, yTabTop), pt(xTabR, yTabTop), 'CUT'),
                edge2R, arcTopR, nubTopR],
            pt(xCreaseR, yTabMid),
        ),
        holes: slot2Paths.length > 0 ? [ringFromCutChain(slot2Paths)] : undefined,
        parent: 'hang_tab_1',
        // Pivot = ĐÚNG nét cấn giữa (chạy giữa hai đỉnh nút bo), không phải cả
        // bề rộng tai treo — pivot phải là biên chung hình học THẬT.
        pivotEdge: [pt(xCreaseL, yTabMid), pt(xCreaseR, yTabMid)],
        foldAngle: 180, // gập úp hẳn lên lớp 1
        foldDirection: -1,
        foldPhase: [0.2, 0.4],
        // Đẩy hẳn lớp 2 ra sau mặt tai treo một lượt giấy (+0,1mm chống
        // z-fighting) để hai lớp chồng nhau bằng hình học THẬT.
        renderZShift: -(T + 0.1),
    });

    // --- F3. Lưỡi khoá tai treo (ĐỒNG PHẲNG lớp 2, đâm thẳng xuống) ---
    const lipCornerR = snap(Math.min(3, lipW * 0.05));
    const lipPaths = buildTuckFlap(xLipL, yTabTop, lipW, dims.lipH, lipCornerR, 1);
    allPaths.push(...lipPaths);
    panels.push({
        name: 'hang_tab_lip',
        label: 'Lưỡi khoá tai treo',
        paths: lipPaths,
        outline: [
            pt(xLipL, yTabTop), pt(xLipR, yTabTop),
            pt(xLipR, snap(yTabTop + dims.lipH)), pt(xLipL, snap(yTabTop + dims.lipH)),
        ],
        parent: 'hang_tab_2',
        pivotEdge: [pt(xLipL, yTabTop), pt(xLipR, yTabTop)],
        // [HANGING-WINDOW 2026-07-27] foldAngle 0 — CHỦ ĐÍCH: lưỡi khoá KHÔNG gập
        // mà nối thẳng, ĐỒNG PHẲNG với lớp 2. Sau khi lớp 2 gập úp 180° thì lớp 2
        // dựng ngược xuống, nên lưỡi khoá theo đó "đâm thẳng xuống" vào lòng hộp,
        // ép vào mặt trong mặt sau — đúng cách tai treo euro thật hoạt động.
        // Bản trước để 90° nên trong 3D nó bật ngược ra ngoài vỏ hộp.
        foldAngle: 0,
        foldDirection: -1,
        foldPhase: [0.4, 0.55],
        // Không renderZShift: đồng phẳng lớp 2 nên đã nằm sẵn đúng lớp giấy của
        // lớp 2 (bản thân lớp 2 đã dịch −(T+0,1)).
    });

    // ============================================================
    // G. BOUNDING BOX + TRẢ VỀ MÔ HÌNH — [HANGING-WINDOW 2026-07-27]
    // ============================================================
    const bb = computeBoundingBox(allPaths);

    return {
        name: 'Hanging Window Box',
        standardCode: 'HANGING-WINDOW',
        description: 'Hộp treo có cửa sổ — hàng điện tử, phụ kiện, treo kệ siêu thị',
        panels,
        allPaths,
        boundingBox: bb,
        params,
        // Cảnh báo hình học suy biến; attachWarnings (engine.ts) sẽ hợp nhất
        // với cảnh báo của validateParams và khử trùng lặp.
        warnings: modelWarnings,
    };
}
