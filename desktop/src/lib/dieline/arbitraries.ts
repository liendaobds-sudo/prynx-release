// ============================================================
// arbitraries.ts — Generator dữ liệu test (fast-check)
//
// Cung cấp `arbBoxParams(boxType)` sinh `BoxParams` HỢP LỆ cho từng
// loại hộp. Mọi params sinh ra đều đi qua `validateParams` để đảm bảo
// nằm trong miền hợp lệ (clamp về giới hạn an toàn sản xuất).
//
// Phân phối của generator chủ động phủ các edge case:
//   - Giá trị biên min/max của từng kích thước
//   - L ≈ W (gần bằng và bằng nhau)
//   - Các tham số "auto-size = 0" (HW, HFH, DFH, BF, envFH, envSF, ...)
//
// Dùng bởi các property test hình học (geometry.test.ts) cho 8 generator.
// ============================================================

import fc from 'fast-check';
import { BoxParams, DEFAULT_PARAMS, Point2D } from './types';
import { validateParams } from './validateParams';
import { snap } from './utils';

/** Loại hộp được hỗ trợ bởi 8 generator. */
export type GeneratorBoxType = BoxParams['boxType'];

/**
 * Số nguyên trong [min, max] có thiên về giá trị biên (min/max) để
 * phủ edge case một cách chủ động.
 */
function arbBiasedInt(min: number, max: number): fc.Arbitrary<number> {
    return fc.oneof(
        { weight: 6, arbitrary: fc.integer({ min, max }) },
        { weight: 1, arbitrary: fc.constant(min) },
        { weight: 1, arbitrary: fc.constant(max) },
    );
}

/** Giá trị "auto-size": thường là 0 (tự động), thỉnh thoảng là số dương. */
function arbAutoSize(min: number, max: number): fc.Arbitrary<number> {
    return fc.oneof(
        { weight: 3, arbitrary: fc.constant(0) },
        { weight: 2, arbitrary: fc.integer({ min, max }) },
    );
}

/** Độ dày T trong [0.2, 3]. */
function arbT(): fc.Arbitrary<number> {
    return arbBiasedInt(2, 30).map(v => v / 10); // 0.2 .. 3.0
}

/**
 * Sinh cặp (L, W) hợp lệ, có phủ trường hợp L === W và L ≈ W.
 * `wMax` cho phép pizza/tray dùng W rộng độc lập.
 */
function arbLW(
    lMin: number,
    lMax: number,
    wMin: number,
    wMax: number,
    allowWGreaterThanL: boolean,
): fc.Arbitrary<{ L: number; W: number }> {
    return arbBiasedInt(lMin, lMax).chain(L => {
        const wHi = allowWGreaterThanL ? wMax : Math.min(wMax, Math.max(wMin, L));
        // Cận dưới cho nhánh "L ≈ W", kẹp an toàn vào [wMin, wHi] (tránh min > max)
        const nearLo = Math.min(wHi, Math.max(wMin, L - 4));
        const equalW = Math.min(wHi, Math.max(wMin, L));
        return fc.record({
            L: fc.constant(L),
            W: fc.oneof(
                { weight: 3, arbitrary: arbBiasedInt(wMin, wHi) },
                // L === W (kẹp về miền hợp lệ của W)
                { weight: 1, arbitrary: fc.constant(equalW) },
                // L ≈ W
                { weight: 1, arbitrary: fc.integer({ min: nearLo, max: wHi }) },
            ),
        });
    });
}

/** Gộp partial vào DEFAULT_PARAMS, đặt boxType, rồi đi qua validateParams. */
function buildValid(boxType: GeneratorBoxType, partial: Partial<BoxParams>): BoxParams {
    const raw: BoxParams = { ...DEFAULT_PARAMS, ...partial, boxType };
    return validateParams(raw).params;
}

/**
 * Sinh `BoxParams` hợp lệ cho một loại hộp cụ thể.
 *
 * @param boxType Một trong 10 loại: rte | slb | auto_bottom | gable |
 *                paper_bag | cup_sleeve | pizza | envelope | tray | double_tray
 * @returns fast-check Arbitrary<BoxParams> đã đi qua validateParams
 */
export function arbBoxParams(boxType: GeneratorBoxType): fc.Arbitrary<BoxParams> {
    switch (boxType) {
        case 'rte':
        case 'slb':
        case 'auto_bottom':
        case 'gable': {
            return fc
                .record({
                    lw: arbLW(30, 600, 15, 400, false),
                    D: arbBiasedInt(10, 600),
                    T: arbT(),
                    G: arbBiasedInt(5, 30),
                    TH: arbBiasedInt(0, 80),
                    DFH: arbAutoSize(1, 60),
                    ABD: arbAutoSize(1, 300),
                    SLP: fc.integer({ min: 0, max: 5 }),
                    HW: arbAutoSize(0, 200),
                    HFH: arbAutoSize(0, 120),
                    panelOrder: fc.constantFrom('WLWL', 'LWLW') as fc.Arbitrary<BoxParams['panelOrder']>,
                    glueSide: fc.constantFrom('left', 'right') as fc.Arbitrary<BoxParams['glueSide']>,
                    gableStyle: fc.constantFrom('flat', 'pitched') as fc.Arbitrary<BoxParams['gableStyle']>,
                })
                .map(r =>
                    buildValid(boxType, {
                        L: r.lw.L,
                        W: r.lw.W,
                        D: r.D,
                        T: r.T,
                        G: r.G,
                        TH: r.TH,
                        DFH: r.DFH,
                        ABD: r.ABD,
                        SLP: r.SLP,
                        HW: r.HW,
                        HFH: r.HFH,
                        panelOrder: r.panelOrder,
                        glueSide: r.glueSide,
                        gableStyle: r.gableStyle,
                    }),
                );
        }

        case 'paper_bag': {
            return fc
                .record({
                    lw: arbLW(30, 600, 15, 400, false),
                    D: arbBiasedInt(10, 600),
                    T: arbT(),
                    G: arbBiasedInt(5, 30),
                    BF: arbAutoSize(1, 200),
                    HR: arbAutoSize(1, 10),
                    HM: arbAutoSize(1, 100),
                    HS: arbAutoSize(1, 200),
                    handleHoles: fc.boolean(),
                    panelOrder: fc.constantFrom('WLWL', 'LWLW') as fc.Arbitrary<BoxParams['panelOrder']>,
                    glueSide: fc.constantFrom('left', 'right') as fc.Arbitrary<BoxParams['glueSide']>,
                })
                .map(r =>
                    buildValid('paper_bag', {
                        L: r.lw.L,
                        W: r.lw.W,
                        D: r.D,
                        T: r.T,
                        G: r.G,
                        BF: r.BF,
                        HR: r.HR,
                        HM: r.HM,
                        HS: r.HS,
                        handleHoles: r.handleHoles,
                        panelOrder: r.panelOrder,
                        glueSide: r.glueSide,
                    }),
                );
        }

        case 'cup_sleeve': {
            return fc
                .record({
                    cupD1: arbBiasedInt(20, 200),
                    gap: arbBiasedInt(5, 60), // cupD2 = cupD1 + gap
                    cupH: arbBiasedInt(10, 300),
                    cupCoverage: arbBiasedInt(1, 100),
                    cupHeightType: fc.constantFrom('slant', 'vertical') as fc.Arbitrary<BoxParams['cupHeightType']>,
                    cupFlapPosition: fc.constantFrom('right', 'left', 'none') as fc.Arbitrary<BoxParams['cupFlapPosition']>,
                })
                .map(r =>
                    buildValid('cup_sleeve', {
                        cupD1: r.cupD1,
                        cupD2: r.cupD1 + r.gap,
                        cupH: r.cupH,
                        cupCoverage: r.cupCoverage,
                        cupHeightType: r.cupHeightType,
                        cupFlapPosition: r.cupFlapPosition,
                    }),
                );
        }

        case 'pizza': {
            // Pizza cho phép W > L (khay chữ nhật ngang); D thường thấp
            return fc
                .record({
                    lw: arbLW(100, 600, 80, 600, true),
                    D: arbBiasedInt(10, 80),
                    T: arbT(),
                })
                .map(r => buildValid('pizza', { L: r.lw.L, W: r.lw.W, D: r.D, T: r.T }));
        }

        case 'envelope': {
            return fc
                .record({
                    envW: arbBiasedInt(80, 500),
                    envH: arbBiasedInt(50, 400),
                    envFH: arbAutoSize(1, 200),
                    envSF: arbAutoSize(1, 100),
                    envFlapShape: fc.constantFrom('straight', 'pointed', 'rounded') as fc.Arbitrary<BoxParams['envFlapShape']>,
                    envStyle: fc.constantFrom('wallet', 'pocket') as fc.Arbitrary<BoxParams['envStyle']>,
                    envWindow: fc.boolean(),
                })
                .map(r =>
                    buildValid('envelope', {
                        envW: r.envW,
                        envH: r.envH,
                        envFH: r.envFH,
                        envSF: r.envSF,
                        envFlapShape: r.envFlapShape,
                        envStyle: r.envStyle,
                        envWindow: r.envWindow,
                    }),
                );
        }

        case 'tray': {
            // Tray (hộp diêm/khay) cho phép W > L
            return fc
                .record({
                    lw: arbLW(30, 600, 15, 400, true),
                    D: arbBiasedInt(10, 200),
                    T: arbT(),
                    G: arbBiasedInt(5, 30),
                    TH: arbBiasedInt(5, 80),
                    trayTongueW: arbBiasedInt(5, 40),
                    sleeveGlue: arbBiasedInt(5, 30),
                })
                .map(r =>
                    buildValid('tray', {
                        L: r.lw.L,
                        W: r.lw.W,
                        D: r.D,
                        T: r.T,
                        G: r.G,
                        TH: r.TH,
                        trayTongueW: r.trayTongueW,
                        sleeveGlue: r.sleeveGlue,
                    }),
                );
        }

        case 'double_tray': {
            // Hộp âm dương cho phép W > L; phủ lidD auto (0) & tùy chỉnh,
            // lidGap 0–5 (thiên về mặc định 1). [DOUBLE-TRAY 2026-07-26]
            return fc
                .record({
                    lw: arbLW(30, 600, 15, 400, true),
                    D: arbBiasedInt(10, 200),
                    T: arbT(),
                    C: arbT(),
                    G: arbBiasedInt(5, 30),
                    TH: arbBiasedInt(5, 40),
                    lidD: arbAutoSize(10, 200),
                    lidGap: fc.oneof(
                        { weight: 2, arbitrary: fc.constant(1) },
                        { weight: 1, arbitrary: fc.integer({ min: 0, max: 5 }) },
                    ),
                })
                .map(r =>
                    buildValid('double_tray', {
                        L: r.lw.L,
                        W: r.lw.W,
                        D: r.D,
                        T: r.T,
                        C: r.C,
                        G: r.G,
                        TH: r.TH,
                        lidD: r.lidD,
                        lidGap: r.lidGap,
                    }),
                );
        }

        case 'hanging_window': {
            // [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ — dải kích thước
            // thực tế của hàng điện tử treo kệ (mẫu Dacdora L80×W30×D140).
            // WNW/WNH/HTH phủ cả giá trị 0 (= tự động suy theo L/D) và
            // `hgbWindow` phủ cả hai nhánh bật/tắt cửa sổ.
            return fc
                .record({
                    lw: arbLW(40, 200, 15, 80, false),
                    D: arbBiasedInt(60, 300),
                    T: arbT(),
                    C: arbT(),
                    G: arbBiasedInt(8, 25),
                    TH: arbBiasedInt(8, 30),
                    WNW: arbAutoSize(10, 200),
                    WNH: arbAutoSize(10, 300),
                    HTH: arbAutoSize(8, 40),
                    hgbWindow: fc.boolean(),
                    panelOrder: fc.constantFrom('WLWL', 'LWLW') as fc.Arbitrary<BoxParams['panelOrder']>,
                    glueSide: fc.constantFrom('left', 'right') as fc.Arbitrary<BoxParams['glueSide']>,
                })
                .map(r =>
                    buildValid('hanging_window', {
                        L: r.lw.L,
                        W: r.lw.W,
                        D: r.D,
                        T: r.T,
                        C: r.C,
                        G: r.G,
                        TH: r.TH,
                        WNW: r.WNW,
                        WNH: r.WNH,
                        HTH: r.HTH,
                        hgbWindow: r.hgbWindow,
                        panelOrder: r.panelOrder,
                        glueSide: r.glueSide,
                    }),
                );
        }

        case 'flip_top_tuck': {
            // [FLIP-TOP-TUCK 2026-08-02 §FTT.5] L/W độc lập; D giữ trong miền
            // cánh khóa đáy còn đoạn đứng thật để property test không sinh khuôn
            // phi sản xuất rồi quy kết nhầm thành lỗi topology.
            return fc
                .record({
                    lw: arbLW(60, 500, 60, 400, true),
                    T: arbT(),
                    C: arbT(),
                })
                .chain(r => {
                    const dMax = Math.max(
                        10,
                        Math.min(200, Math.floor((r.lw.W - r.T) / 1.3)),
                    );
                    return arbBiasedInt(10, dMax).map(D =>
                        buildValid('flip_top_tuck', {
                            L: r.lw.L,
                            W: r.lw.W,
                            D,
                            T: r.T,
                            C: r.C,
                        }),
                    );
                });
        }

        default: {
            // Bảo đảm exhaustiveness ở compile-time
            const _exhaustive: never = boxType;
            throw new Error(`arbBoxParams: boxType không hỗ trợ: ${_exhaustive}`);
        }
    }
}

// ============================================================
// Polygon arbitraries (Workstream B — Polygon Offset)
//
// Sinh `Die_Outline` dạng `Point2D[]` (đơn vị mm) cho các property
// test offset (Property 5–8, 12). Mọi đa giác sinh ra:
//   - có ≥ 3 đỉnh phân biệt và diện tích bao > 0,
//   - là đa giác ĐƠN (không tự cắt) — dùng dựng hình "sao quanh tâm"
//     (star-shaped): các đỉnh sắp theo góc tăng dần quanh một điểm
//     kernel nên vòng luôn đơn,
//   - tọa độ đã snap theo quy ước của module (0,001 mm).
//
// Dùng bởi polygonOffset.test.ts.
// ============================================================

/**
 * Đa giác hình sao (star-shaped) quanh tâm — LUÔN đơn (không tự cắt) vì
 * các đỉnh được đặt tại các góc tăng dần nghiêm ngặt quanh một điểm kernel.
 *
 * @param nMin/nMax  số đỉnh
 * @param rMin/rMax  bán kính từ tâm tới đỉnh (mm)
 */
function arbStarPolygon(
    nMin: number,
    nMax: number,
    rMin: number,
    rMax: number,
): fc.Arbitrary<Point2D[]> {
    return fc.integer({ min: nMin, max: nMax }).chain((n) => {
        const step = (2 * Math.PI) / n;
        return fc
            .record({
                cx: fc.integer({ min: -50, max: 50 }),
                cy: fc.integer({ min: -50, max: 50 }),
                // jitter ∈ (−0,4·step, 0,4·step) giữ thứ tự góc tăng dần nghiêm ngặt
                jitters: fc.array(fc.double({ min: -0.4, max: 0.4, noNaN: true }), {
                    minLength: n,
                    maxLength: n,
                }),
                radii: fc.array(fc.double({ min: rMin, max: rMax, noNaN: true }), {
                    minLength: n,
                    maxLength: n,
                }),
            })
            .map(({ cx, cy, jitters, radii }) => {
                const pts: Point2D[] = [];
                for (let i = 0; i < n; i++) {
                    const angle = i * step + jitters[i] * step;
                    const r = radii[i];
                    pts.push({ x: snap(cx + r * Math.cos(angle)), y: snap(cy + r * Math.sin(angle)) });
                }
                return pts;
            });
    });
}

/**
 * Đa giác ĐƠN tổng quát (lồi hoặc lõm nhẹ), 3–10 đỉnh, bán kính 20–80 mm.
 * Star-shaped ⇒ luôn không tự cắt, diện tích > 0.
 */
export function arbSimplePolygon(): fc.Arbitrary<Point2D[]> {
    return arbStarPolygon(3, 10, 20, 80);
}

/**
 * Đa giác LÕM (non-convex) — hình "sao nhiều cánh": xen kẽ bán kính ngoài
 * lớn và bán kính trong nhỏ tạo ≥ 1 đỉnh lõm (reflex). Vẫn star-shaped quanh
 * tâm nên không tự cắt. `spikes` cánh ⇒ `2·spikes` đỉnh.
 */
export function arbConcavePolygon(): fc.Arbitrary<Point2D[]> {
    return fc.integer({ min: 2, max: 6 }).chain((spikes) => {
        const n = spikes * 2;
        const step = (2 * Math.PI) / n;
        return fc
            .record({
                cx: fc.integer({ min: -40, max: 40 }),
                cy: fc.integer({ min: -40, max: 40 }),
                outer: fc.double({ min: 50, max: 90, noNaN: true }),
                inner: fc.double({ min: 12, max: 30, noNaN: true }),
                jitters: fc.array(fc.double({ min: -0.3, max: 0.3, noNaN: true }), {
                    minLength: n,
                    maxLength: n,
                }),
            })
            .map(({ cx, cy, outer, inner, jitters }) => {
                const pts: Point2D[] = [];
                for (let i = 0; i < n; i++) {
                    const r = i % 2 === 0 ? outer : inner; // ngoài/trong xen kẽ ⇒ lõm
                    const angle = i * step + jitters[i] * step;
                    pts.push({ x: snap(cx + r * Math.cos(angle)), y: snap(cy + r * Math.sin(angle)) });
                }
                return pts;
            });
    });
}

/** Hình chữ nhật (CCW) với gốc và kích thước ngẫu nhiên (mm). */
export function arbRectangle(): fc.Arbitrary<Point2D[]> {
    return fc
        .record({
            x: fc.integer({ min: -50, max: 50 }),
            y: fc.integer({ min: -50, max: 50 }),
            w: fc.integer({ min: 5, max: 300 }),
            h: fc.integer({ min: 5, max: 300 }),
        })
        .map(({ x, y, w, h }) => [
            { x: snap(x), y: snap(y) },
            { x: snap(x + w), y: snap(y) },
            { x: snap(x + w), y: snap(y + h) },
            { x: snap(x), y: snap(y + h) },
        ]);
}
