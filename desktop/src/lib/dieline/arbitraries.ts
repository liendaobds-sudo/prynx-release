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
import { BoxParams, DEFAULT_PARAMS } from './types';
import { validateParams } from './validateParams';

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
 * @param boxType Một trong 8 loại: rte | slb | gable | paper_bag |
 *                cup_sleeve | pizza | envelope | tray
 * @returns fast-check Arbitrary<BoxParams> đã đi qua validateParams
 */
export function arbBoxParams(boxType: GeneratorBoxType): fc.Arbitrary<BoxParams> {
    switch (boxType) {
        case 'rte':
        case 'slb':
        case 'gable': {
            return fc
                .record({
                    lw: arbLW(30, 600, 15, 400, false),
                    D: arbBiasedInt(10, 600),
                    T: arbT(),
                    G: arbBiasedInt(5, 30),
                    TH: arbBiasedInt(0, 80),
                    DFH: arbAutoSize(1, 60),
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

        default: {
            // Bảo đảm exhaustiveness ở compile-time
            const _exhaustive: never = boxType;
            throw new Error(`arbBoxParams: boxType không hỗ trợ: ${_exhaustive}`);
        }
    }
}
