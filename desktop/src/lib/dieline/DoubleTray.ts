// ============================================================
// Double Tray — Hộp Âm Dương (khay đáy + nắp chụp rời) [DOUBLE-TRAY 2026-07-26]
//
// Hai mảnh rời cùng topology "khay chữ nhật thành kép" (roll-over
// double wall), vẽ cạnh nhau trên một bản khuôn:
//   - Mảnh ĐÁY  (base_*): thân L × W, thành D.
//   - Mảnh NẮP  (lid_*):  thân (L + 8T + 2·lidGap) × (W + 8T + 2·lidGap),
//                         thành lidD (0 = tự động D + 2T — nắp trùm kín).
//
// Mỗi phía của thân có 4 dải cuộn vào trong:
//   thành ngoài (D) → dầm/gờ đỉnh (G) → thành trong (D − T) → mí gập (TH,
//   hai đầu vát chéo 45° đúng bằng TH).
// Kết cấu góc ĐÚNG MẪU: vạt góc dán (gắn vách trái/phải, bản lề thụt C
// vào thân + khe cắt max(2T, 2C)) + tai khóa (gắn thành trong trước/sau,
// chui vào khe thành kép bên) + notch U chống rách bán kính C tại 4 góc thân.
//
// Sơ đồ 1 mảnh (bố cục chữ thập, nhìn từ mặt trong):
//
//                 ┌─╲ mí gập TH (vát 45°) ╱─┐
//                 │      thành trong D−T     │   ← thụt C mỗi bên
//     [tai khóa]──┤        dầm G             ├──[tai khóa]
//        ┌─┐      │      thành ngoài D       │      ┌─┐
//   ┌────┤vạt góc├┼──────────────────────────┼┤vạt góc├────┐
//   │ mí │ dầm │ thành │    THÂN L × W       │ thành │ dầm │ mí │
//   └────┤vạt góc├┼──────────────────────────┼┤vạt góc├────┘
//        └─┘      │      thành ngoài D       │      └─┘
//     [tai khóa]──┤        dầm G             ├──[tai khóa]
//                 │      thành trong D−T     │
//                 └─╲ mí gập TH (vát 45°) ╱─┘
//
// Số đo rút từ mẫu chuẩn "Custom Dimensions Tuck End Boxes Double Tray
// Dieline 100010-01" (thân đáy 361×261, thành 52; nắp 375×275, thành 55;
// khớp tròn số tuyệt đối với T = 1.5, C = 1 — xem double_tray_dossier.md):
//   thành trong = D − T; dầm = G (mẫu 5); mí = TH (mẫu 15, vát 45° hết cỡ);
//   thành trong trước/sau thụt C mỗi bên; mí thụt G mỗi bên;
//   vạt góc: rộng (D − T − khe) × cao (D + C), bản lề thụt C, khe = max(2T, 2C);
//   tai khóa: rộng (D − 2T) × cao (D − T − C); notch U bán kính C;
//   thân nắp = thân đáy + 8T + 2·lidGap (mẫu +14); thành nắp = D + 2T (mẫu +3).
//
// LƯU Ý: mẫu SVG gốc vẽ SÓT 2 nét cấn (nếp mí trái khay đáy và nếp tai
// khóa trên-phải khay nắp) — engine sinh ĐỦ 24 nét cấn cho mỗi mảnh.
// ============================================================

import {
    BoxParams, DielineModel, Panel, PathSegment, Point2D,
} from './types';
import { pt, line, snap, computeBoundingBox } from './utils';
import {
    KAPPA,
    DT_INNER_WALL_DROP_T,
    DT_LID_BODY_DELTA_T,
    DT_LID_WALL_DELTA_T,
    DT_DUST_W_DROP_T,
    DT_DISPLAY_GAP,
    DT_LID_HOVER_MM,
} from './constants';

/** Kích thước thân một mảnh (lọt lòng, mm). */
interface PieceDims {
    L: number;
    W: number;
    D: number;
}

/** Hàm ánh xạ tọa độ dải: u dọc theo cạnh thân [0..A], v hướng RA NGOÀI thân. */
type SideMap = (u: number, v: number) => Point2D;

/** Cấu hình một phía của mảnh khay. */
interface SideCfg {
    key: 'front' | 'back' | 'left' | 'right';
    /** Nhãn tiếng Việt của phía. */
    vi: string;
    /** Chiều dài cạnh thân của phía này. */
    A: number;
    /** Ánh xạ (u, v) → tọa độ toàn cục. */
    map: SideMap;
    /** true = dải trái/phải (mang vạt góc); false = trước/sau (mang tai khóa). */
    isSide: boolean;
    /** foldDirection dùng chung cho các zone của dải (theo tiền lệ MatchboxTray). */
    fd: 1 | -1;
}

/** Bezier 1/4 cung tròn theo hệ (u, v) cục bộ của một phía, map ra toàn cục.
 *  t0/t3 là vector tiếp tuyến ĐƠN VỊ tại điểm đầu/cuối (hệ cục bộ). */
function qArcMapped(
    map: SideMap,
    p0uv: [number, number], p3uv: [number, number],
    t0uv: [number, number], t3uv: [number, number],
    R: number,
): PathSegment {
    const p0 = map(p0uv[0], p0uv[1]);
    const p3 = map(p3uv[0], p3uv[1]);
    // Map hướng tiếp tuyến qua phép affine của map (trừ gốc để khử offset).
    const o = map(0, 0);
    const d0g = map(t0uv[0], t0uv[1]);
    const d3g = map(t3uv[0], t3uv[1]);
    const t0 = { x: d0g.x - o.x, y: d0g.y - o.y };
    const t3 = { x: d3g.x - o.x, y: d3g.y - o.y };
    return {
        type: 'bezier',
        tag: 'CUT',
        points: [p0, p3],
        controlPoints: [
            p0,
            pt(p0.x + R * KAPPA * t0.x, p0.y + R * KAPPA * t0.y),
            pt(p3.x - R * KAPPA * t3.x, p3.y - R * KAPPA * t3.y),
            p3,
        ],
    };
}

/** Loại đỉnh trùng nhau liên tiếp trong outline (tránh polygon suy biến ở 3D). */
function dedupeOutline(points: Point2D[]): Point2D[] {
    const out: Point2D[] = [];
    for (const p of points) {
        const prev = out[out.length - 1];
        if (!prev || Math.abs(prev.x - p.x) > 0.005 || Math.abs(prev.y - p.y) > 0.005) {
            out.push(p);
        }
    }
    if (out.length > 1) {
        const a = out[0];
        const b = out[out.length - 1];
        if (Math.abs(a.x - b.x) <= 0.005 && Math.abs(a.y - b.y) <= 0.005) out.pop();
    }
    return out;
}

/**
 * Dựng MỘT mảnh khay thành kép (đáy hoặc nắp) tại offset (ox, oy).
 * Trả về paths + panels để ghép vào model chung (tiền lệ MatchboxSleeve).
 *
 * @param prefix  'base' (đáy) | 'lid' (nắp) — tiền tố tên panel
 * @param viName  nhãn phụ tiếng Việt ('đáy' | 'nắp')
 * @param dims    thân L × W, thành D của MẢNH này
 * @param params  BoxParams gốc (lấy T, C, G, TH dùng chung)
 */
function buildTrayPiece(
    prefix: 'base' | 'lid',
    viName: string,
    dims: PieceDims,
    params: BoxParams,
    ox: number,
    oy: number,
): { paths: PathSegment[]; panels: Panel[] } {
    const { T, C, G, TH } = params;
    const pL = dims.L;
    const pW = dims.W;
    const D = dims.D;

    // ── Kích thước dẫn xuất (đo từ mẫu 100010-01) ──
    const innerH = snap(D - DT_INNER_WALL_DROP_T * T);   // cao thành trong = D − T
    const beamTop = snap(D + G);                          // v đỉnh dầm
    const innerTop = snap(beamTop + innerH);              // v đỉnh thành trong
    const hemTop = snap(innerTop + TH);                   // v đỉnh mí gập
    const dustW = snap(D - DT_DUST_W_DROP_T * T);        // rộng tai khóa = D − 2T
    const slit = snap(Math.max(2 * T, 2 * C));            // khe cắt vạt góc ↔ vách = max(2T, 2C)
    const notchR = snap(C);                               // bán kính notch U chống rách

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ── 1. ĐÁY (thân) — 4 cạnh CREASE, panel gốc của mảnh ──
    const b00 = pt(ox, oy);
    const b10 = pt(ox + pL, oy);
    const b11 = pt(ox + pL, oy + pW);
    const b01 = pt(ox, oy + pW);
    const bottomPaths: PathSegment[] = [
        line(b00, b10, 'CREASE'),
        line(b10, b11, 'CREASE'),
        line(b11, b01, 'CREASE'),
        line(b01, b00, 'CREASE'),
    ];
    allPaths.push(...bottomPaths);
    panels.push({
        name: `${prefix}_bottom`,
        label: `Thân ${viName}`,
        paths: bottomPaths,
        outline: [b00, b10, b11, b01],
        parent: null,
        pivotEdge: null,
        foldAngle: 0,
        foldDirection: 1,
    });

    // ── 2. Bốn phía — ánh xạ (u dọc cạnh, v hướng ra ngoài) ──
    // foldDirection theo tiền lệ MatchboxTray: dải dọc (front/back) dùng dir,
    // dải ngang (left/right) đảo dấu để cả 4 vách cùng gập LÊN.
    const sides: SideCfg[] = [
        { key: 'front', vi: 'trước', A: pL, map: (u, v) => pt(ox + u, oy + pW + v), isSide: false, fd: 1 },
        { key: 'back', vi: 'sau', A: pL, map: (u, v) => pt(ox + u, oy - v), isSide: false, fd: -1 },
        { key: 'right', vi: 'phải', A: pW, map: (u, v) => pt(ox + pL + v, oy + u), isSide: true, fd: -1 },
        { key: 'left', vi: 'trái', A: pW, map: (u, v) => pt(ox - v, oy + u), isSide: true, fd: 1 },
    ];

    // Trình tự gập (fold phase) — vách dựng đồng loạt rồi cuộn theo lớp:
    //   1) 4 vách dựng 90° (0.20–0.40)
    //   2) vạt góc quấn quanh góc + mí trước/sau bẻ ngược (0.40–0.52)
    //   3) dầm + thành trong TRƯỚC/SAU cuộn vào (0.52–0.78)
    //   4) tai khóa gập quanh góc (0.78–0.86)
    //   5) mí bên bẻ ngược rồi dầm + thành trong BÊN cuộn, nuốt tai khóa (0.80–1.00)
    const phaseFB: Record<'wall' | 'beam' | 'inner' | 'hem', [number, number]> = {
        wall: [0.2, 0.4], hem: [0.4, 0.52], beam: [0.52, 0.64], inner: [0.64, 0.78],
    };
    const phaseLR: Record<'wall' | 'beam' | 'inner' | 'hem', [number, number]> = {
        wall: [0.2, 0.4], hem: [0.8, 0.86], beam: [0.86, 0.92], inner: [0.92, 1.0],
    };

    for (const s of sides) {
        const { A, map: m, key, vi } = s;
        const phases = s.isSide ? phaseLR : phaseFB;
        // Thụt ngang của thành trong: trước/sau = C (mẫu 1mm), trái/phải = G (mẫu 5mm).
        const innerInset = s.isSide ? G : C;

        // ── 2a. THÀNH NGOÀI (wall) — cao D, rộng full A ──
        const wallPaths: PathSegment[] = [];
        if (!s.isSide) {
            // Mép biên hai đầu (giáp khe vạt góc) — chỉ dải trước/sau có cạnh CUT đứng.
            wallPaths.push(line(m(0, 0), m(0, D), 'CUT'));
            wallPaths.push(line(m(A, 0), m(A, D), 'CUT'));
        }
        // Nếp thành ngoài → dầm (full A, theo mẫu: nét cấn chạy hết bề rộng thân).
        wallPaths.push(line(m(0, D), m(A, D), 'CREASE'));
        allPaths.push(...wallPaths);
        panels.push({
            name: `${prefix}_${key}_wall`,
            label: `Vách ${vi} (${viName})`,
            paths: wallPaths,
            outline: [m(0, 0), m(A, 0), m(A, D), m(0, D)],
            parent: `${prefix}_bottom`,
            pivotEdge: [m(0, 0), m(A, 0)],
            foldAngle: 90,
            foldDirection: s.fd,
            foldPhase: phases.wall,
        });

        // ── 2b. DẦM / GỜ ĐỈNH (beam) — rộng G, hai đầu vát 45° đúng G ──
        const beamPaths: PathSegment[] = [
            line(m(0, D), m(G, beamTop), 'CUT'),      // vát 45° đầu trái
            line(m(A, D), m(A - G, beamTop), 'CUT'),  // vát 45° đầu phải
            line(m(G, beamTop), m(A - G, beamTop), 'CREASE'), // nếp dầm → thành trong
        ];
        if (!s.isSide) {
            // Bậc chuyển 45°→C nối vát dầm với chân thành trong thụt C (mẫu: jog 4×1mm).
            beamPaths.push(line(m(G, beamTop), m(C, snap(beamTop + C)), 'CUT'));
            beamPaths.push(line(m(A - G, beamTop), m(A - C, snap(beamTop + C)), 'CUT'));
        }
        allPaths.push(...beamPaths);
        panels.push({
            name: `${prefix}_${key}_beam`,
            label: `Dầm ${vi} (${viName})`,
            paths: beamPaths,
            outline: [m(0, D), m(A, D), m(A - G, beamTop), m(G, beamTop)],
            parent: `${prefix}_${key}_wall`,
            pivotEdge: [m(0, D), m(A, D)],
            foldAngle: 90,
            foldDirection: s.fd,
            foldPhase: phases.beam,
        });

        // ── 2c. THÀNH TRONG (inner) — cao D − T, thụt innerInset mỗi bên ──
        const innerPaths: PathSegment[] = [];
        if (s.isSide) {
            // Trái/phải: cạnh đầu-cuối thành trong là CUT đứng (vát dầm đáp thẳng vào).
            innerPaths.push(line(m(G, beamTop), m(G, innerTop), 'CUT'));
            innerPaths.push(line(m(A - G, beamTop), m(A - G, innerTop), 'CUT'));
        } else {
            // Trước/sau: đoạn CUT ngắn nối đỉnh thành trong (thụt C) với chân mí (thụt G).
            innerPaths.push(line(m(C, innerTop), m(G, innerTop), 'CUT'));
            innerPaths.push(line(m(A - C, innerTop), m(A - G, innerTop), 'CUT'));
        }
        innerPaths.push(line(m(G, innerTop), m(A - G, innerTop), 'CREASE')); // nếp thành trong → mí
        allPaths.push(...innerPaths);
        panels.push({
            name: `${prefix}_${key}_inner`,
            label: `Thành trong ${vi} (${viName})`,
            paths: innerPaths,
            outline: [
                m(innerInset, beamTop), m(A - innerInset, beamTop),
                m(A - innerInset, innerTop), m(innerInset, innerTop),
            ],
            parent: `${prefix}_${key}_beam`,
            pivotEdge: [m(G, beamTop), m(A - G, beamTop)],
            foldAngle: 90,
            foldDirection: s.fd,
            foldPhase: phases.inner,
        });

        // ── 2d. MÍ GẬP (hem) — cao TH, hai đầu vát 45° đúng TH (mẫu: vát hết cỡ) ──
        const hemPaths: PathSegment[] = [
            line(m(G, innerTop), m(G + TH, hemTop), 'CUT'),
            line(m(A - G, innerTop), m(A - G - TH, hemTop), 'CUT'),
        ];
        if (A - 2 * G - 2 * TH > 0.01) {
            hemPaths.push(line(m(G + TH, hemTop), m(A - G - TH, hemTop), 'CUT'));
        }
        allPaths.push(...hemPaths);
        panels.push({
            name: `${prefix}_${key}_hem`,
            label: `Mí ${vi} (${viName})`,
            paths: hemPaths,
            outline: dedupeOutline([
                m(G, innerTop), m(A - G, innerTop),
                m(A - G - TH, hemTop), m(G + TH, hemTop),
            ]),
            parent: `${prefix}_${key}_inner`,
            pivotEdge: [m(G, innerTop), m(A - G, innerTop)],
            foldAngle: -90, // bẻ ngược ra ngoài trước, thành trong cuộn sẽ đưa mí nằm sát đáy
            foldDirection: s.fd,
            foldPhase: phases.hem,
        });

        if (!s.isSide) {
            // ── 2e. TAI KHÓA (dust) ×2 — gắn mép bên thành trong trước/sau,
            //        chui vào khe thành kép của dải bên khi gập. Mẫu: rộng D−2T,
            //        cao D−T−C (chừa C phía chân), bản lề = mép thành trong (thụt C).
            const vLo = snap(beamTop + C);
            const vHi = innerTop;
            const ends: Array<{ uh: number; sign: 1 | -1; tag: 'l' | 'r' }> = [
                { uh: C, sign: -1, tag: 'l' },
                { uh: snap(A - C), sign: 1, tag: 'r' },
            ];
            for (const e of ends) {
                const uOut = snap(e.uh + e.sign * dustW);
                const dustPaths: PathSegment[] = [
                    line(m(e.uh, vLo), m(uOut, vLo), 'CUT'),   // cạnh chân
                    line(m(uOut, vLo), m(uOut, vHi), 'CUT'),   // cạnh ngoài
                    line(m(uOut, vHi), m(e.uh, vHi), 'CUT'),   // cạnh đỉnh
                    line(m(e.uh, vLo), m(e.uh, vHi), 'CREASE'), // bản lề (nếp mẫu gốc vẽ sót — vẽ ĐỦ)
                ];
                allPaths.push(...dustPaths);
                panels.push({
                    name: `${prefix}_dust_${key === 'front' ? 'f' : 'b'}${e.tag}`,
                    label: `Tai khóa ${vi}-${e.tag === 'l' ? 'trái' : 'phải'} (${viName})`,
                    paths: dustPaths,
                    outline: [m(e.uh, vLo), m(uOut, vLo), m(uOut, vHi), m(e.uh, vHi)],
                    parent: `${prefix}_${key}_inner`,
                    pivotEdge: [m(e.uh, vLo), m(e.uh, vHi)],
                    foldAngle: 90,
                    // [3D-QA] Chiều gập quấn VÀO khe thành kép bên — cần soát mắt
                    // trên viewer 3D thật (cloud không render WebGL).
                    foldDirection: ((key === 'front' ? 1 : -1) * e.sign) as 1 | -1,
                    foldPhase: [0.78, 0.86],
                });
            }
        } else {
            // ── 2f. VẠT GÓC (corner) ×2 — gắn hai đầu vách trái/phải, bản lề
            //        thụt C vào thân, khe cắt `slit` với vách trước/sau,
            //        notch U chống rách bán kính C ngay góc thân (mẫu: 2×1mm).
            const ends: Array<{ u0: number; e: 1 | -1; cKey: 'f' | 'b'; cVi: string }> = [
                { u0: A, e: 1, cKey: 'f', cVi: 'trước' },
                { u0: 0, e: -1, cKey: 'b', cVi: 'sau' },
            ];
            for (const c of ends) {
                const { u0, e } = c;
                const uHinge = snap(u0 - e * C);           // đường bản lề (thụt C vào thân)
                const uTop = snap(u0 + e * D);             // đỉnh vạt (ngang đỉnh vách trước/sau)
                const vOuter = snap(D - T);                // mép ngoài vạt
                const diagRun = snap(slit - 2 * C);        // phần chéo 45° sau notch

                const cPaths: PathSegment[] = [];
                // Notch U chống rách: nửa đường tròn bán kính C từ đỉnh thân
                // (u0, 0) võng xuống (uHinge, C) rồi lên (u0, 2C) — 2 bezier 1/4 cung.
                cPaths.push(qArcMapped(m, [u0, 0], [u0 - e * notchR, notchR], [-e, 0], [0, 1], notchR));
                cPaths.push(qArcMapped(m, [u0 - e * notchR, notchR], [u0, 2 * notchR], [0, 1], [e, 0], notchR));
                // Chéo 45° dẫn từ notch ra mép khe cắt (bỏ qua nếu khe = 2C).
                if (diagRun > 0.01) {
                    cPaths.push(line(m(u0, 2 * notchR), m(snap(u0 + e * diagRun), slit), 'CUT'));
                }
                // Cạnh khe cắt (song song vách trước/sau, cách `slit`).
                cPaths.push(line(m(snap(u0 + e * diagRun), slit), m(uTop, slit), 'CUT'));
                // Đỉnh vạt (ngang mức đỉnh vách trước/sau).
                cPaths.push(line(m(uTop, slit), m(uTop, vOuter), 'CUT'));
                // Mép ngoài vạt.
                cPaths.push(line(m(uTop, vOuter), m(uHinge, vOuter), 'CUT'));
                // Bậc chéo nối mép vạt về góc đỉnh vách (mẫu: jog 1.5×1mm).
                cPaths.push(line(m(uHinge, vOuter), m(u0, D), 'CUT'));
                // Bản lề vạt góc (CREASE, từ đáy notch tới mép ngoài).
                cPaths.push(line(m(uHinge, notchR), m(uHinge, vOuter), 'CREASE'));
                allPaths.push(...cPaths);
                panels.push({
                    name: `${prefix}_corner_${c.cKey}${key === 'left' ? 'l' : 'r'}`,
                    label: `Vạt góc ${c.cVi}-${vi} (${viName})`,
                    paths: cPaths,
                    outline: dedupeOutline([
                        m(uHinge, notchR), m(u0, 2 * notchR),
                        m(snap(u0 + e * diagRun), slit), m(uTop, slit),
                        m(uTop, vOuter), m(uHinge, vOuter),
                    ]),
                    parent: `${prefix}_${key}_wall`,
                    pivotEdge: [m(uHinge, notchR), m(uHinge, vOuter)],
                    foldAngle: 90,
                    // [3D-QA] Quấn quanh góc áp MẶT TRONG vách trước/sau — soát mắt 3D.
                    foldDirection: (e * (key === 'right' ? 1 : -1)) as 1 | -1,
                    foldPhase: [0.4, 0.52],
                });
            }
        }
    }

    return { paths: allPaths, panels };
}

/** Kích thước thân nắp dẫn xuất từ đáy: + 8T + 2·lidGap mỗi trục (đo mẫu +14). */
export function lidDimsFor(params: BoxParams): PieceDims {
    const delta = snap(DT_LID_BODY_DELTA_T * params.T + 2 * params.lidGap);
    return {
        L: snap(params.L + delta),
        W: snap(params.W + delta),
        D: params.lidD > 0 ? snap(params.lidD) : snap(params.D + DT_LID_WALL_DELTA_T * params.T),
    };
}

/**
 * Sinh dieline hộp âm dương: mảnh ĐÁY quanh gốc + mảnh NẮP bên phải,
 * cách nhau DT_DISPLAY_GAP (tiền lệ MatchboxTray + Sleeve).
 */
export function generateDoubleTray(params: BoxParams): DielineModel {
    const { L, W, D, T, G, TH } = params;

    const baseDims: PieceDims = { L, W, D };
    const lidDims = lidDimsFor(params);

    // Bề vươn của các dải mỗi phía: thành + dầm + thành trong + mí.
    const extOf = (d: PieceDims) => snap(d.D + G + (d.D - DT_INNER_WALL_DROP_T * T) + TH);
    const baseExt = extOf(baseDims);
    const lidExt = extOf(lidDims);

    // Nắp đặt bên phải đáy, căn giữa theo trục Y của thân.
    const lidOx = snap(L + baseExt + DT_DISPLAY_GAP + lidExt);
    const lidOy = snap((W - lidDims.W) / 2);

    const base = buildTrayPiece('base', 'đáy', baseDims, params, 0, 0);
    const lid = buildTrayPiece('lid', 'nắp', lidDims, params, lidOx, lidOy);

    const allPaths = [...base.paths, ...lid.paths];
    const panels = [...base.panels, ...lid.panels];

    // [DOUBLE-TRAY FIX 2026-07-27 §DT3D-001] Pose CHỤP NẮP trong hệ phẳng-đã-gấp:
    // nắp nằm bên phải nên lật 180° quanh trục Y đi về phía khay, đồng thời tịnh tiến
    // tâm panel lid_bottom trùng tâm base_bottom. Pivot đặt đúng tâm root để toàn bộ cây
    // panel nắp quay như một vật rắn; không thay đổi tọa độ CUT/CREASE 2D.
    const nestingTargetZ = snap(D + T + DT_LID_HOVER_MM);
    // Nâng đủ cao để thành nắp quét qua thành khay khi lật úp ở pha cuối.
    const nestingLiftZ = snap(nestingTargetZ + lidDims.D + Math.max(4 * T, 10));
    const nesting = {
        x: snap(L / 2 - (lidOx + lidDims.L / 2)),
        y: snap(W / 2 - (lidOy + lidDims.W / 2)),
        z: nestingTargetZ,
        rotationDeg: { x: 0, y: 0, z: 0 },
        pivot: {
            x: snap(lidOx + lidDims.L / 2),
            y: snap(lidOy + lidDims.W / 2),
            z: 0,
        },
        // [DOUBLE-TRAY FIX 2026-07-27 §DT3D-004] Trình tự lắp thực tế:
        // lật 180° tại tâm → nhấc lên → đưa ngang về khay → hạ xuống, không xoay thêm.
        choreography: {
            preRotationDeg: { x: 0, y: -180, z: 0 },
            liftZ: nestingLiftZ,
            preRotateEnd: 0.18,
            liftEnd: 0.42,
            translateEnd: 0.70,
        },
    };

    return {
        name: 'Double Tray (Hộp Âm Dương)',
        standardCode: 'FEFCO-0330',
        description: 'Khay đáy + nắp chụp rời, thành kép',
        panels,
        allPaths,
        boundingBox: computeBoundingBox(allPaths),
        params,
        nesting,
    };
}

/**
 * Tách dieline hộp âm dương thành 2 model rời cho bình khuôn / xuất PDF
 * hai mảnh — CÙNG QUY ƯỚC với `splitTrayDieline` (trayParts.ts): giữ nguyên
 * name/params, bỏ `nesting`, bbox tính lại theo mảnh. Trả về theo khe cắm
 * tray/sleeve sẵn có: tray = mảnh ĐÁY (base_*), sleeve = mảnh NẮP (lid_*).
 */
export function splitDoubleTrayDieline(
    model: DielineModel,
): { tray: DielineModel; sleeve: DielineModel } | null {
    if (model.params.boxType !== 'double_tray') return null;
    const pick = (prefix: 'base' | 'lid'): DielineModel | null => {
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
    const tray = pick('base');
    const sleeve = pick('lid');
    return tray && sleeve ? { tray, sleeve } : null;
}
