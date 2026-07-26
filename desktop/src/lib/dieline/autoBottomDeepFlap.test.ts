/**
 * Bất biến hình học của tai đáy SÂU (deep bottom flap) — hộp đáy dán tự động.
 *
 * Vì sao cần test riêng: `computeDeepBottomKeyPoints` / `buildDeepBottomFreeEdge` KHÔNG
 * được phủ bởi bất kỳ test nào khác. `contourValidator.test.ts` và `geometry.test.ts`
 * chỉ kiểm biên dạng có KHÉP KÍN hay không (property test trên mọi loại hộp), còn
 * `bleedContours.test.ts` chỉ kiểm `bottom_main_front.outline.length > 8`. Cả ba đều
 * KHÔNG bắt được sai lệch VỊ TRÍ / QUY ƯỚC TRỤC của free-edge — đúng nhóm lỗi mà
 * audit-rules §6 xếp là đắt giá nhất (dữ liệu "khớp" nhưng hình bị lật/lệch).
 *
 * Các bất biến khoá ở đây, đối chiếu file mẫu SVG:
 *   1. A, B nằm TRÊN đường gấp (cùng y) — free-edge phải bắt đầu và kết thúc trên fold.
 *   2. M sâu hơn C (yM < yC) và lệch phải C — góc C không thẳng hàng với BC.
 *   3. [AUTO-BOTTOM FIX 2026-07-26] Góc trên fold là góc SẮC: mọi đoạn CUT chạm
 *      đường gấp đều là LINE (bo bezier tại A/B cũ bị ép endpoint mà không tính lại
 *      control points → free-edge "quăn"/loop, và points[]↔controlPoints[] phân kỳ
 *      sau retarget). Kèm bất biến chống hồi quy: KHÔNG bezier nào có
 *      points[0]/points[cuối] lệch controlPoints[0]/[3].
 *   4. CREASE xuất phát từ B và nghiêng 45°.
 *   5. Key point thô: A.y === B.y === yBase (0) sau khi pivot.
 *   6. [AUTO-BOTTOM FIX 2026-07-26] Mảnh chính được TÁCH thành thân
 *      (`bottom_main_*`, chuỗi CUT A→…→E + CREASE B→E) và tam giác dán
 *      (`bottom_tab_*`, chuỗi CUT E→…→B, con của thân, pivotEdge = nếp chéo
 *      [B,E], foldAngle 180, renderZShift âm) — khoá cấu trúc 3D gập nếp chéo.
 *
 * Nguồn gốc: harness debug `_debug_pts.test.ts` trong đợt phát triển đáy dán; audit
 * 2026-07-25 chuyển thành test hồi quy chính thức (bỏ console.log theo §9).
 * Cập nhật 2026-07-26 theo AUTO-BOTTOM FIX (tách panel tab + bỏ bo góc trên fold).
 */
import { describe, it, expect } from 'vitest';

import { generateAutoBottomBox } from './AutoBottomBox';
import { computeDeepBottomKeyPoints, autoBottomDims } from './autoBottomHelpers';
import type { BoxParams } from './types';

/** Tham số mẫu khớp golden master auto_bottom (L120 × W80 × D180). */
const PARAMS = {
    L: 120, W: 80, D: 180, T: 0.5, C: 0.5, G: 15, TH: 25,
    glueSide: 'left', boxType: 'auto_bottom', panelOrder: 'LWLW',
    HH: 0, HW: 0, HHL: 0, handleShape: 'oval', handleY: 'bottom',
    HFH: 0, SLW: 3, SLH: 85, TRW: 0, SLP: 0, gableStyle: 'flat',
    LTW: 15, LTH: 20, lockTab: true, DFH: 0, ABD: 0,
    BF: 0, HR: 0, HM: 0, HS: 0, handleHoles: true,
    cupD1: 70, cupD2: 80, cupH: 90, cupCoverage: 100,
    cupHeightType: 'slant', cupFlapPosition: 'right',
    envW: 220, envH: 110, envFH: 0, envSF: 0,
    envFlapShape: 'pointed', envStyle: 'wallet', envWindow: false,
    envWindowW: 90, envWindowH: 45, envWindowX: 15, envWindowY: 15,
    trayTongueW: 15, sleeveGlue: 15,
    pizzaVent: true, pizzaVentD: 0, pizzaFrontLock: true, pizzaCornerLock: true,
} as BoxParams;

describe('deep bottom flap — bất biến hình học free-edge', () => {
    it('A/B trên fold, M sâu hơn và lệch phải C, góc fold sắc (line), CREASE 45° từ B', () => {
        const model = generateAutoBottomBox(PARAMS);
        const deep = model.panels.find((panel) => panel.name === 'bottom_main_front');
        expect(deep, 'panel bottom_main_front phải tồn tại').toBeTruthy();

        const cuts = deep!.paths.filter((segment) => segment.tag === 'CUT');
        const crease = deep!.paths.find((segment) => segment.tag === 'CREASE');
        expect(cuts.length, 'phải có chuỗi CUT').toBeGreaterThan(0);
        expect(crease, 'phải có CREASE 45°').toBeTruthy();

        // Chú thích điểm mốc: khoá theo TÊN điểm (A/B/C/M) thay vì chỉ số mảng để
        // không vỡ khi thứ tự annotation đổi. Panel thân giữ TRỌN bộ key points
        // (kể cả C/M nay thuộc tam giác dán) để mốc hình học luôn tra một chỗ.
        const byKey: Record<string, { x: number; y: number }> = {};
        for (const annotation of deep!.annotations || []) {
            byKey[annotation.text.split('—')[0].trim()] = annotation.point;
        }
        for (const key of ['A', 'B', 'C', 'M']) {
            expect(byKey[key], `thiếu điểm mốc ${key}`).toBeTruthy();
        }

        // (1) A, B cùng nằm trên đường gấp.
        expect(Math.abs(byKey.A.y - byKey.B.y)).toBeLessThan(0.2);

        // (2) M sâu hơn C và lệch về phía B — nếu quy ước trục bị lật, hai assert này vỡ.
        expect(byKey.M.y).toBeLessThan(byKey.C.y - 1.0);
        expect(byKey.M.x).toBeGreaterThan(byKey.C.x + 1.0);

        // (1b) [AUTO-BOTTOM FIX 2026-07-26] Chuỗi CUT của THÂN bắt đầu tại A và
        // kết thúc tại E (đỉnh kệ — điểm tách tam giác dán); B đóng vòng qua CREASE.
        const first = cuts[0].points[0];
        const lastSegment = cuts[cuts.length - 1];
        const last = lastSegment.points[lastSegment.points.length - 1];
        expect(Math.abs(first.x - byKey.A.x) + Math.abs(first.y - byKey.A.y)).toBeLessThan(0.25);
        const E = crease!.points[1];
        expect(Math.abs(last.x - E.x) + Math.abs(last.y - E.y)).toBeLessThan(0.25);

        // (3) [AUTO-BOTTOM FIX 2026-07-26] Góc trên fold SẮC: mọi đoạn CUT có
        // điểm chạm đường gấp (|y| < 0.2) phải là LINE — không còn bezier bo
        // cong tại A/B (nguồn lỗi "free-edge quăn" + phân kỳ points/controlPoints).
        const allBottomCuts = model.panels
            .filter((panel) => panel.name.startsWith('bottom_'))
            .flatMap((panel) => panel.paths.filter((segment) => segment.tag === 'CUT'));
        expect(allBottomCuts.length).toBeGreaterThan(0);
        for (const segment of allBottomCuts) {
            const touchesFold = segment.points.some((point) => Math.abs(point.y) < 0.2);
            if (touchesFold) {
                expect(segment.type, 'đoạn CUT chạm fold phải là line').toBe('line');
            }
        }
        // Bất biến chống hồi quy phân kỳ: với MỌI bezier trong model,
        // points[0]/points[cuối] phải trùng controlPoints[0]/[3].
        for (const panel of model.panels) {
            for (const segment of panel.paths) {
                if (segment.type === 'bezier' && segment.controlPoints) {
                    const p0 = segment.points[0];
                    const p3 = segment.points[segment.points.length - 1];
                    expect(Math.hypot(p0.x - segment.controlPoints[0].x, p0.y - segment.controlPoints[0].y))
                        .toBeLessThan(1e-6);
                    expect(Math.hypot(p3.x - segment.controlPoints[3].x, p3.y - segment.controlPoints[3].y))
                        .toBeLessThan(1e-6);
                }
            }
        }

        // (4) CREASE bắt đầu tại B và nghiêng 45° (|dx| ≈ |dy|).
        const [creaseStart, creaseEnd] = crease!.points;
        expect(
            Math.abs(creaseStart.x - byKey.B.x) + Math.abs(creaseStart.y - byKey.B.y),
        ).toBeLessThan(0.2);
        const dx = creaseStart.x - creaseEnd.x;
        const dy = creaseStart.y - creaseEnd.y;
        expect(Math.abs(Math.abs(dx) - Math.abs(dy))).toBeLessThan(1.5);
    });

    it('key point thô: A.y = B.y = yBase và M sâu hơn C', () => {
        const dims = autoBottomDims(PARAMS.L, PARAMS.W, PARAMS.T, PARAMS.C, PARAMS.ABD);
        const kp = computeDeepBottomKeyPoints(0, PARAMS.L, 0, dims);

        expect(kp.A.y).toBe(0);
        expect(kp.B.y).toBe(0);
        if (kp.M) expect(kp.M.y).toBeLessThan(kp.C.y);
    });

    it('[AUTO-BOTTOM FIX 2026-07-26] tam giác dán tách panel: CUT E→…→B, pivot = nếp chéo [B,E]', () => {
        const model = generateAutoBottomBox(PARAMS);
        for (const side of ['front', 'back'] as const) {
            const main = model.panels.find((panel) => panel.name === `bottom_main_${side}`);
            const tab = model.panels.find((panel) => panel.name === `bottom_tab_${side}`);
            expect(main, `bottom_main_${side} phải tồn tại`).toBeTruthy();
            expect(tab, `bottom_tab_${side} phải tồn tại`).toBeTruthy();

            // Tam giác dán là CON của thân — 3D gập 180° quanh nếp chéo,
            // renderZShift âm để nâng lên trên mặt tai hông khi đáy bung.
            expect(tab!.parent).toBe(`bottom_main_${side}`);
            expect(tab!.foldAngle).toBe(180);
            expect(tab!.foldDirection).toBe(-1);
            expect(tab!.renderZShift ?? 0, 'renderZShift phải âm').toBeLessThan(0);

            // pivotEdge = [B, E] trùng CREASE 45° của thân (biên chung 2 panel —
            // thỏa bất biến pivot-trên-biên-chung, Requirement 2.4 Phase 1).
            const crease = main!.paths.find((segment) => segment.tag === 'CREASE');
            expect(crease).toBeTruthy();
            const [B, E] = crease!.points;
            const [pivB, pivE] = tab!.pivotEdge!;
            expect(Math.hypot(pivB.x - B.x, pivB.y - B.y)).toBeLessThan(0.001);
            expect(Math.hypot(pivE.x - E.x, pivE.y - E.y)).toBeLessThan(0.001);
            // Nếp chéo đúng 45°.
            expect(Math.abs(Math.abs(pivB.x - pivE.x) - Math.abs(pivB.y - pivE.y))).toBeLessThan(0.01);

            // Chuỗi CUT của tam giác dán: bắt đầu tại E, kết thúc tại B (trên fold).
            const tabCuts = tab!.paths.filter((segment) => segment.tag === 'CUT');
            expect(tabCuts.length).toBeGreaterThan(0);
            const tabFirst = tabCuts[0].points[0];
            const tabLastSeg = tabCuts[tabCuts.length - 1];
            const tabLast = tabLastSeg.points[tabLastSeg.points.length - 1];
            expect(Math.hypot(tabFirst.x - E.x, tabFirst.y - E.y)).toBeLessThan(0.02);
            expect(Math.hypot(tabLast.x - B.x, tabLast.y - B.y)).toBeLessThan(0.02);
        }
    });
});
