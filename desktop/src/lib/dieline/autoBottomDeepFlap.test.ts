/**
 * Bất biến hình học của tai đáy SÂU (deep bottom flap) — hộp đáy dán tự động.
 *
 * Vì sao cần test riêng: `computeDeepBottomKeyPoints` / `buildDeepBottomFlap` KHÔNG
 * được phủ bởi bất kỳ test nào khác. `contourValidator.test.ts` và `geometry.test.ts`
 * chỉ kiểm biên dạng có KHÉP KÍN hay không (property test trên mọi loại hộp), còn
 * `bleedContours.test.ts` chỉ kiểm `bottom_main_front.outline.length > 8`. Cả ba đều
 * KHÔNG bắt được sai lệch VỊ TRÍ / QUY ƯỚC TRỤC của free-edge — đúng nhóm lỗi mà
 * audit-rules §6 xếp là đắt giá nhất (dữ liệu "khớp" nhưng hình bị lật/lệch).
 *
 * Các bất biến khoá ở đây, đối chiếu file mẫu SVG:
 *   1. A, B nằm TRÊN đường gấp (cùng y) — free-edge phải bắt đầu và kết thúc trên fold.
 *   2. M sâu hơn C (yM < yC) và lệch phải C — góc C không thẳng hàng với BC.
 *   3. Có bo tròn (bezier) tại đầu mút trên fold.
 *   4. CREASE xuất phát từ B và nghiêng 45°.
 *   5. Key point thô: A.y === B.y === yBase (0) sau khi pivot.
 *
 * Nguồn gốc: harness debug `_debug_pts.test.ts` trong đợt phát triển đáy dán; audit
 * 2026-07-25 chuyển thành test hồi quy chính thức (bỏ console.log theo §9).
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
    it('A/B trên fold, M sâu hơn và lệch phải C, có fillet, CREASE 45° từ B', () => {
        const model = generateAutoBottomBox(PARAMS);
        const deep = model.panels.find((panel) => panel.name === 'bottom_main_front');
        expect(deep, 'panel bottom_main_front phải tồn tại').toBeTruthy();

        const cuts = deep!.paths.filter((segment) => segment.tag === 'CUT');
        const crease = deep!.paths.find((segment) => segment.tag === 'CREASE');
        expect(cuts.length, 'phải có chuỗi CUT').toBeGreaterThan(0);
        expect(crease, 'phải có CREASE 45°').toBeTruthy();

        // Chú thích điểm mốc: khoá theo TÊN điểm (A/B/C/M) thay vì chỉ số mảng để
        // không vỡ khi thứ tự annotation đổi.
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

        // (1b) Free-edge bắt đầu tại A và kết thúc tại B.
        const first = cuts[0].points[0];
        const lastSegment = cuts[cuts.length - 1];
        const last = lastSegment.points[lastSegment.points.length - 1];
        expect(Math.abs(first.y - byKey.A.y)).toBeLessThan(0.25);
        expect(Math.abs(last.y - byKey.B.y)).toBeLessThan(0.25);

        // (3) Có bo tròn tại đầu mút trên fold.
        const hasFoldFillet = cuts.some((segment) =>
            segment.type === 'bezier'
            && segment.points.some((point) => Math.abs(point.y - byKey.B.y) < 0.2),
        );
        expect(hasFoldFillet, 'phải có bezier bo tròn sát fold').toBe(true);

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
});
