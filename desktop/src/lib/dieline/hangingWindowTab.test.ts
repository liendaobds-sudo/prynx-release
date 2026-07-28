/**
 * [HANGING-WINDOW 2026-07-27]
 * Bất biến RIÊNG của Hộp treo có cửa sổ (`boxType = 'hanging_window'`).
 *
 * Vì sao cần tệp test riêng: các tầng test dùng chung (`contourValidator`,
 * `geometry`, `bleedContours`) chỉ kiểm biên dạng có KHÉP KÍN và toạ độ có hữu
 * hạn — chúng KHÔNG bắt được sai lệch VỊ TRÍ của hai Lỗ_Euro. Nếu hai lỗ lệch
 * nhau vài mm sau khi gập úp, mọi test kia vẫn xanh nhưng tai treo thật sẽ xé
 * giấy khi treo lên thanh ngang. Đó là bất biến sống còn của loại hộp này.
 *
 * Ba nhóm bất biến khoá ở đây (Property 3, 4, 5 của design):
 *   3. Phản chiếu tập điểm Lỗ_Euro của Lớp_2 qua Nếp_Gấp_Chung (y ↦ 2·yTabMid − y)
 *      trùng tập điểm Lỗ_Euro của Lớp_1, kể cả gờ chống trượt, trong 0,01 mm.
 *   4. Cửa_Sổ căn giữa mặt trước theo cả hai trục và cách mỗi cạnh mặt trước
 *      ≥ HGB_WINDOW_MARGIN_MM − 0,01 mm (chỗ dán màng PVC/PET).
 *   5. `hangingWindowDims` kẹp đúng miền hằng HGB_*, đơn điệu theo L và D,
 *      `tab2H ≡ tabH + T`, và `slotPos` luôn chừa ≥ 3mm giấy hai đầu.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';

import { applyFoldCompensation } from '../mockup3d/foldCompensation';

import { generateHangingWindowBox, hangingWindowDims } from './HangingWindowBox';
import { buildProductionDielinePdf } from './productionPDF';
import { validateParams } from './validateParams';
import { snap } from './utils';
import { BoxParams, DEFAULT_PARAMS, Point2D } from './types';
import {
    HGB_WINDOW_MARGIN_MM, HGB_WINDOW_R_MAX,
    HGB_TAB_H_MIN, HGB_TAB_H_MAX,
    HGB_SLOT_W_MIN, HGB_SLOT_W_MAX,
    HGB_SLOT_H_MM, HGB_SLOT_NIB_W_MM, HGB_SLOT_NIB_D_MM,
} from './constants';

/** Sai số cho phép của khuôn bế (mm) — cùng ngưỡng với audit-rules. */
const EPS = 0.01;

/** Gộp override vào DEFAULT_PARAMS rồi đưa qua validateParams (kẹp về miền hợp lệ). */
function makeParams(over: Partial<BoxParams>): BoxParams {
    return validateParams({ ...DEFAULT_PARAMS, boxType: 'hanging_window', ...over }).params;
}

/** Preset mẫu Dacdora — hộp treo hàng điện tử L80 × W30 × D140. */
const DACDORA = makeParams({ L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15 });

/**
 * Arbitrary tham số hợp lệ cho hộp treo (dải theo design: L 40–200, W 15–80,
 * D 60–300, T 0,3–2, C 0–2, G 8–25, TH 8–30). WNW/WNH/HTH phủ cả giá trị 0
 * (= tự động) lẫn giá trị người dùng tự nhập.
 */
const arbHangingParams: fc.Arbitrary<BoxParams> = fc.record({
    L: fc.integer({ min: 40, max: 200 }),
    W: fc.integer({ min: 15, max: 80 }),
    D: fc.integer({ min: 60, max: 300 }),
    T: fc.integer({ min: 3, max: 20 }).map(v => v / 10),
    C: fc.integer({ min: 0, max: 20 }).map(v => v / 10),
    G: fc.integer({ min: 8, max: 25 }),
    TH: fc.integer({ min: 8, max: 30 }),
    hgbWindow: fc.boolean(),
    WNW: fc.oneof(fc.constant(0), fc.integer({ min: 10, max: 200 })),
    WNH: fc.oneof(fc.constant(0), fc.integer({ min: 10, max: 300 })),
    HTH: fc.oneof(fc.constant(0), fc.integer({ min: 8, max: 60 })),
    glueSide: fc.constantFrom('left', 'right') as fc.Arbitrary<BoxParams['glueSide']>,
    panelOrder: fc.constantFrom('LWLW', 'WLWL') as fc.Arbitrary<BoxParams['panelOrder']>,
}).map(r => makeParams(r));

/** Hai tập điểm trùng nhau (không phụ thuộc thứ tự) trong sai số `tol`. */
function assertSamePointSet(a: Point2D[], b: Point2D[], tol: number, what: string): void {
    expect(a.length, `${what}: số điểm phải bằng nhau`).toBe(b.length);
    const worst = (from: Point2D[], to: Point2D[]): number => {
        let maxDist = 0;
        for (const p of from) {
            let best = Infinity;
            for (const q of to) {
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (d < best) best = d;
            }
            if (best > maxDist) maxDist = best;
        }
        return maxDist;
    };
    expect(Math.max(worst(a, b), worst(b, a)), `${what}: khoảng lệch lớn nhất (mm)`).toBeLessThan(tol);
}

/** Hộp bao của một vòng điểm. */
function ringBounds(ring: Point2D[]) {
    const xs = ring.map(p => p.x);
    const ys = ring.map(p => p.y);
    return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
    };
}

// ============================================================
// Property 3 — Hai Lỗ_Euro trùng khít sau khi gập úp 180°
// ============================================================
describe('Property 3 — hai Lỗ_Euro trùng khít sau gập', () => {
    it('phản chiếu Lỗ_Euro lớp 2 qua Nếp_Gấp_Chung trùng Lỗ_Euro lớp 1 (preset Dacdora)', () => {
        const dims = hangingWindowDims(DACDORA);
        expect(dims.hasSlot, 'preset Dacdora phải dựng được lỗ euro').toBe(true);

        const model = generateHangingWindowBox(DACDORA);
        const tab1 = model.panels.find(p => p.name === 'hang_tab_1');
        const tab2 = model.panels.find(p => p.name === 'hang_tab_2');
        expect(tab1?.holes?.length, 'lớp 1 phải có đúng 1 lỗ euro').toBe(1);
        expect(tab2?.holes?.length, 'lớp 2 phải có đúng 1 lỗ euro').toBe(1);

        const yTabMid = snap(snap(DACDORA.D) + dims.tabH);
        const mirrored = tab2!.holes![0].map(p => ({ x: p.x, y: snap(2 * yTabMid - p.y) }));
        assertSamePointSet(tab1!.holes![0], mirrored, EPS, 'Lỗ_Euro lớp 1 ↔ lớp 2 (phản chiếu)');
    });

    it('**Validates: Requirements 2.4** — trùng khít với mọi tham số hợp lệ có hasSlot', () => {
        fc.assert(
            fc.property(arbHangingParams, (params) => {
                const dims = hangingWindowDims(params);
                fc.pre(dims.hasSlot);

                const model = generateHangingWindowBox(params);
                const tab1 = model.panels.find(p => p.name === 'hang_tab_1');
                const tab2 = model.panels.find(p => p.name === 'hang_tab_2');
                expect(tab1?.holes?.length).toBe(1);
                expect(tab2?.holes?.length).toBe(1);

                // Nếp_Gấp_Chung: y = D + tabH (gốc y = 0 ở đáy hộp)
                const yTabMid = snap(snap(params.D) + dims.tabH);
                const ring1 = tab1!.holes![0];
                const ring2 = tab2!.holes![0];

                // Tâm hai lỗ đối xứng qua Nếp_Gấp_Chung ⇒ cùng hoành độ tâm
                const b1 = ringBounds(ring1);
                const b2 = ringBounds(ring2);
                expect(Math.abs((b1.minX + b1.maxX) / 2 - (b2.minX + b2.maxX) / 2)).toBeLessThan(EPS);

                const mirrored = ring2.map(p => ({ x: p.x, y: snap(2 * yTabMid - p.y) }));
                assertSamePointSet(ring1, mirrored, EPS, 'Lỗ_Euro lớp 1 ↔ lớp 2 (phản chiếu)');
            }),
            { numRuns: 200 },
        );
    });
});

// ============================================================
// Property 4 — Cửa_Sổ căn giữa mặt trước và nằm trong lề an toàn
// ============================================================
describe('Property 4 — Cửa_Sổ căn giữa và trong lề an toàn', () => {
    it('**Validates: Requirements 1.5, 4.6** — căn giữa hai trục, cách mỗi cạnh ≥ HGB_WINDOW_MARGIN_MM', () => {
        fc.assert(
            fc.property(arbHangingParams, (params) => {
                const dims = hangingWindowDims(params);
                fc.pre(params.hgbWindow && dims.hasWindow);

                const model = generateHangingWindowBox(params);
                const front = model.panels.find(p => p.name === 'front');
                expect(front?.holes?.length, 'mặt trước phải có đúng 1 cửa sổ').toBe(1);

                // Bề rộng mặt trước lấy từ outline panel; chiều cao thân là [0, D]
                const fxs = front!.outline!.map(p => p.x);
                const xFrontL = Math.min(...fxs);
                const xFrontR = Math.max(...fxs);
                const yFrontB = 0;
                const yFrontT = snap(params.D);

                const b = ringBounds(front!.holes![0]);

                // Căn giữa theo cả hai trục
                expect(Math.abs((b.minX + b.maxX) / 2 - (xFrontL + xFrontR) / 2)).toBeLessThan(EPS);
                expect(Math.abs((b.minY + b.maxY) / 2 - (yFrontB + yFrontT) / 2)).toBeLessThan(EPS);

                // Lề an toàn bốn phía (chỗ dán màng PVC/PET)
                expect(b.minX - xFrontL).toBeGreaterThanOrEqual(HGB_WINDOW_MARGIN_MM - EPS);
                expect(xFrontR - b.maxX).toBeGreaterThanOrEqual(HGB_WINDOW_MARGIN_MM - EPS);
                expect(b.minY - yFrontB).toBeGreaterThanOrEqual(HGB_WINDOW_MARGIN_MM - EPS);
                expect(yFrontT - b.maxY).toBeGreaterThanOrEqual(HGB_WINDOW_MARGIN_MM - EPS);
            }),
            { numRuns: 200 },
        );
    });

    it('tắt công tắc ⇒ mặt trước không còn cửa sổ', () => {
        const model = generateHangingWindowBox(makeParams({ ...DACDORA, hgbWindow: false }));
        const front = model.panels.find(p => p.name === 'front');
        expect(front?.holes ?? []).toHaveLength(0);
    });
});

// ============================================================
// Property 5 — Kẹp và đơn điệu của hangingWindowDims
// ============================================================
describe('Property 5 — kẹp và đơn điệu của hangingWindowDims', () => {
    it('**Validates: Requirements 2.2, 4.3, 4.4** — miền kẹp, tab2H = tabH + T, slotPos hợp lệ', () => {
        fc.assert(
            fc.property(arbHangingParams, (params) => {
                const d = hangingWindowDims(params);

                // (a) mọi giá trị nằm trong miền do hằng HGB_* quy định
                expect(d.tabH).toBeGreaterThanOrEqual(HGB_TAB_H_MIN - EPS);
                expect(d.tabH).toBeLessThanOrEqual(HGB_TAB_H_MAX + EPS);
                expect(d.winW).toBeLessThanOrEqual(params.L - 2 * HGB_WINDOW_MARGIN_MM + EPS);
                expect(d.winH).toBeLessThanOrEqual(params.D - 2 * HGB_WINDOW_MARGIN_MM + EPS);
                expect(d.winR).toBeLessThanOrEqual(HGB_WINDOW_R_MAX + EPS);
                expect(d.winR).toBeLessThanOrEqual(Math.min(d.winW, d.winH) / 2 + EPS);
                expect(d.slotW).toBeGreaterThanOrEqual(HGB_SLOT_W_MIN - EPS);
                expect(d.slotW).toBeLessThanOrEqual(HGB_SLOT_W_MAX + EPS);
                expect(d.slotW).toBeLessThanOrEqual(params.L - 8 + EPS);
                expect(d.slotH).toBeLessThanOrEqual(HGB_SLOT_H_MM + EPS);
                expect(d.nibW).toBeLessThanOrEqual(HGB_SLOT_NIB_W_MM + EPS);
                expect(d.nibD).toBeLessThanOrEqual(HGB_SLOT_NIB_D_MM + EPS);

                // (d) lớp 2 luôn cao hơn lớp 1 đúng một lượt giấy
                expect(Math.abs(d.tab2H - (d.tabH + params.T))).toBeLessThan(0.001 + 1e-9);

                // (e) tâm lỗ chừa ≥ 3mm giấy ở cả nếp gấp chung và mép ngoài tai
                if (d.hasSlot) {
                    expect(d.slotPos).toBeGreaterThanOrEqual(d.slotH / 2 + d.nibD + 3 - EPS);
                    expect(d.slotPos).toBeLessThanOrEqual(d.tabH - d.slotH / 2 - 3 + EPS);
                }
            }),
            { numRuns: 300 },
        );
    });

    it('**Validates: Requirements 4.3, 4.4** — tăng L thì winW/slotW không giảm; tăng D thì winH/tabH không giảm', () => {
        fc.assert(
            fc.property(
                arbHangingParams,
                fc.integer({ min: 1, max: 100 }),
                (params, delta) => {
                    const base = hangingWindowDims(params);

                    // (b) chỉ tăng L, giữ nguyên mọi tham số khác
                    const widerL = hangingWindowDims({ ...params, L: params.L + delta });
                    expect(widerL.winW).toBeGreaterThanOrEqual(base.winW - EPS);
                    expect(widerL.slotW).toBeGreaterThanOrEqual(base.slotW - EPS);

                    // (c) chỉ tăng D
                    const tallerD = hangingWindowDims({ ...params, D: params.D + delta });
                    expect(tallerD.winH).toBeGreaterThanOrEqual(base.winH - EPS);
                    expect(tallerD.tabH).toBeGreaterThanOrEqual(base.tabH - EPS);
                },
            ),
            { numRuns: 300 },
        );
    });

    it('preset Dacdora: tai treo 2 lớp và lỗ euro theo mẫu nhà cung cấp', () => {
        const d = hangingWindowDims(DACDORA);
        expect(d.hasWindow).toBe(true);
        expect(d.hasSlot).toBe(true);
        expect(d.tabH).toBeGreaterThanOrEqual(HGB_TAB_H_MIN);
        expect(d.tab2H).toBeCloseTo(d.tabH + DACDORA.T, 3);
        expect(d.slotH).toBeCloseTo(HGB_SLOT_H_MM, 3);
        expect(d.nibD).toBeCloseTo(HGB_SLOT_NIB_D_MM, 3);
    });
});

// ============================================================
// Requirement 10.5 — Đo kiểm PDF khuôn của Preset_Dacdora
// ------------------------------------------------------------
// Thay cho việc đo bằng thước trong app: dựng đúng blob PDF sản xuất mà nút
// "Xuất PDF khuôn" gọi, rồi đo lại từ chính toạ độ trong content stream
// (pt → mm) và đối chiếu tham số nhập trong sai số 0,1 mm.
// ============================================================
describe('Requirement 10.5 — kích thước PDF khuôn khớp tham số nhập (≤ 0,1 mm)', () => {
    /** Sai số nghiệm thu của phép đo trên bản PDF (mm). */
    const EPS_PDF = 0.1;
    const PT_PER_MM = 72 / 25.4;

    /** Bề rộng/chiều cao đo được của một panel theo outline (mm). */
    function panelSpan(model: ReturnType<typeof generateHangingWindowBox>, name: string) {
        const outline = model.panels.find(p => p.name === name)!.outline!;
        const b = ringBounds(outline);
        return { w: b.maxX - b.minX, h: b.maxY - b.minY, ...b };
    }

    it('panel thân: mặt trước = L, hông = W, chiều cao thân = D', () => {
        const model = generateHangingWindowBox(DACDORA);
        expect(panelSpan(model, 'front').w).toBeCloseTo(DACDORA.L, 1);
        expect(panelSpan(model, 'back').w).toBeCloseTo(DACDORA.L, 1);
        expect(panelSpan(model, 'right').w).toBeCloseTo(DACDORA.W, 1);
        expect(panelSpan(model, 'left').w).toBeCloseTo(DACDORA.W, 1);

        // Thân hộp trải phẳng: y ∈ [0, D] (mép trên mặt trước nhô thêm T cho nắp)
        const side = panelSpan(model, 'right');
        expect(Math.abs(side.h - DACDORA.D)).toBeLessThan(EPS_PDF);
        expect(Math.abs(side.minY)).toBeLessThan(EPS_PDF);

        // Khổ trải phẳng ngang = mí keo + 2·L + 2·W
        const expectFlatW = DACDORA.G + 2 * DACDORA.L + 2 * DACDORA.W;
        expect(Math.abs(model.boundingBox.width - expectFlatW)).toBeLessThan(EPS_PDF);
    });

    it('PDF sản xuất: khổ trang và nét CUT đo lại đúng bằng mm hình học', async () => {
        const model = generateHangingWindowBox(DACDORA);
        const pdfText = await buildProductionDielinePdf(model).text();

        // Khổ trang = hộp bao + lề 5mm mỗi phía (margin của buildProductionDielinePdf)
        const box = pdfText.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
        expect(box, 'PDF phải có MediaBox').not.toBeNull();
        const pageWmm = Number(box![1]) / PT_PER_MM;
        const pageHmm = Number(box![2]) / PT_PER_MM;
        expect(Math.abs(pageWmm - (model.boundingBox.width + 10))).toBeLessThan(EPS_PDF);
        expect(Math.abs(pageHmm - (model.boundingBox.height + 10))).toBeLessThan(EPS_PDF);

        // Đo lại từ chính toạ độ nét CUT trong content stream (pt → mm)
        const xs: number[] = [];
        const ys: number[] = [];
        for (const line of pdfText.split('\n')) {
            if (!line.startsWith('/CSCut CS')) continue;
            const tokens = line.split(' ');
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] !== 'm' && tokens[i] !== 'l') continue;
                const y = Number(tokens[i - 1]);
                const x = Number(tokens[i - 2]);
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    xs.push(x / PT_PER_MM);
                    ys.push(y / PT_PER_MM);
                }
            }
        }
        expect(xs.length, 'phải đọc được toạ độ nét CUT').toBeGreaterThan(50);

        // Nét CUT nằm gọn trong khổ trang, cách biên đúng lề 5mm
        expect(Math.abs(Math.min(...xs) - 5)).toBeLessThan(EPS_PDF);
        expect(Math.abs(Math.min(...ys) - 5)).toBeLessThan(EPS_PDF);
        expect(Math.abs(Math.max(...xs) - (5 + model.boundingBox.width))).toBeLessThan(EPS_PDF);
        expect(Math.abs(Math.max(...ys) - (5 + model.boundingBox.height))).toBeLessThan(EPS_PDF);
    });
});

// ============================================================
// Requirement 6.5 — Gập 3D headless (thay cho việc kéo foldProgress trong app)
// ------------------------------------------------------------
// Dùng đúng phép biến đổi mà Mockup3D dùng (`applyFoldCompensation`) để kiểm
// hai điều KHÔNG cần renderer: (1) mọi panel đều gập được, không panel nào bị
// bỏ qua vì thiếu pivotEdge/parent (panel "bay"); (2) sau khi gập xong, Lớp_2
// úp đúng lên Lớp_1 nên hai Lỗ_Euro chồng nhau trong mặt phẳng, chỉ lệch nhau
// theo trục z đúng một lượt giấy.
// ============================================================
describe('Requirement 6.5 — gập 3D: tai treo úp đúng lên lớp 1, không panel nào bay', () => {
    /** Bản đồ độ sâu cây gập (cùng cách Mockup3D dựng). */
    function depthOf(panels: ReturnType<typeof generateHangingWindowBox>['panels']) {
        const byName = new Map(panels.map(p => [p.name, p]));
        const depthMap = new Map<string, number>();
        const walk = (name: string): number => {
            const cached = depthMap.get(name);
            if (cached !== undefined) return cached;
            const panel = byName.get(name);
            const d = !panel || !panel.parent ? 0 : walk(panel.parent) + 1;
            depthMap.set(name, d);
            return d;
        };
        panels.forEach(p => walk(p.name));
        const maxD = Math.max(...depthMap.values());
        return { depthMap, maxD };
    }

    it('mọi panel gập được ở mọi mốc foldProgress (không skip, không cảnh báo)', () => {
        const model = generateHangingWindowBox(DACDORA);
        const { depthMap, maxD } = depthOf(model.panels);
        for (const progress of [0, 0.25, 0.5, 0.75, 0.95, 1]) {
            for (const panel of model.panels) {
                const fold = applyFoldCompensation(panel, model.panels, progress, depthMap, maxD, DACDORA.T);
                expect(fold.skipped, `${panel.name} @${progress}: ${fold.warning ?? ''}`).toBe(false);
                expect(fold.warning, `${panel.name} @${progress}`).toBeUndefined();
                expect(Number.isFinite(fold.matrix.elements.reduce((a, b) => a + b, 0)),
                    `${panel.name} @${progress}: ma trận gập phải hữu hạn`).toBe(true);
            }
        }
    });

    it('foldProgress = 1: hai Lỗ_Euro chồng nhau trong mặt phẳng, lệch z đúng lượt giấy', () => {
        const model = generateHangingWindowBox(DACDORA);
        const { depthMap, maxD } = depthOf(model.panels);
        const tab1 = model.panels.find(p => p.name === 'hang_tab_1')!;
        const tab2 = model.panels.find(p => p.name === 'hang_tab_2')!;

        const worldCentroid = (panel: typeof tab1, ring: Point2D[]) => {
            const fold = applyFoldCompensation(panel, model.panels, 1, depthMap, maxD, DACDORA.T);
            const sum = new THREE.Vector3();
            for (const q of ring) sum.add(new THREE.Vector3(q.x, q.y, 0).applyMatrix4(fold.matrix));
            return sum.multiplyScalar(1 / ring.length);
        };

        const c1 = worldCentroid(tab1, tab1.holes![0]);
        const c2 = worldCentroid(tab2, tab2.holes![0]);

        // Chồng khít trong mặt phẳng tai treo (lệch ngang < 1mm sau bù dày giấy)
        expect(Math.hypot(c1.x - c2.x, c1.y - c2.y)).toBeLessThan(1);
        // Tách lớp theo trục z: có khe giấy thật nhưng không quá 3 lượt giấy
        const dz = Math.abs(c1.z - c2.z);
        expect(dz).toBeGreaterThan(0.1);
        expect(dz).toBeLessThan(3 * DACDORA.T + 0.5);
    });
});
