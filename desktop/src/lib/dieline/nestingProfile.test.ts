/**
 * [HANGING-WINDOW 2026-07-27]
 * Biên dạng khuôn theo cột (`nestingProfile`) + tác động lên lồng khuôn.
 *
 * VÌ SAO CẦN: `computeDieOutline` luôn rơi về bbox-rect (chuỗi CUT của khuôn thật
 * không bao giờ khép kín vì có rãnh xả / nét cụt / lỗ khoét), nên trước khi có
 * profile thì `validatePlacementPositions` so va chạm bằng HÌNH CHỮ NHẬT và loại
 * sạch mọi vị trí lồng — mọi chiến lược lồng khuôn mất tác dụng trong app mà
 * không test nào bắt được. Bộ test này khoá lại cả hai đầu:
 *   1. profile đọc được biên dạng thật (có cột hụt vật liệu so với chiều cao khuôn),
 *   2. layout lồng KHÔNG bị validator loại oan, và cũng KHÔNG được phép chồng khuôn.
 */
import { describe, it, expect } from 'vitest';

import { DEFAULT_PARAMS, type BoxParams } from './types';
import { DEFAULT_NESTING_CONFIG } from './nestingTypes';
import { validateParams } from './validateParams';
import { generateDieline } from './engine';
import { calculateNesting, computeDieOutline } from './nestingEngine';
import { validatePlacementPositions } from './nestingCollision';
import {
    computeCutProfile, fullRectProfile, minRowPitch, placementsTooClose,
} from './nestingProfile';

const GAP = 3;

function build(over: Partial<BoxParams>) {
    const params = validateParams({ ...DEFAULT_PARAMS, ...over } as BoxParams).params;
    const model = generateDieline(params);
    return { params, model, bb: model.boundingBox };
}

describe('nestingProfile — biên dạng thật theo cột', () => {
    it('đọc được biên dạng: có cột hụt vật liệu so với chiều cao khuôn', () => {
        const { model, bb } = build({ boxType: 'hanging_window', L: 80, W: 30, D: 140 });
        const p = computeCutProfile(model, bb.width, bb.height);

        expect(p.synthetic, 'có model ⇒ profile thật').toBe(false);
        expect(p.samples).toBeGreaterThan(16);
        // Cột nào cũng phải nằm trong khuôn.
        for (let i = 0; i < p.samples; i++) {
            if (p.empty[i]) continue;
            expect(p.yMin[i]).toBeGreaterThanOrEqual(-0.01);
            expect(p.yMax[i]).toBeLessThanOrEqual(bb.height + 0.01);
        }
        // Phải có cột mà vật liệu KHÔNG chiếm hết chiều cao — nếu không, profile
        // đang trả về hình chữ nhật đặc (đúng cái bug cũ).
        const minSpan = Math.min(...p.yMax.map((v, i) => (p.empty[i] ? Infinity : v - p.yMin[i])));
        expect(minSpan).toBeLessThan(bb.height - 1);
    });

    it('không có model ⇒ profile TỔNG HỢP, phải bị bỏ qua khi kiểm va chạm', () => {
        const p = fullRectProfile(100, 200);
        expect(p.synthetic).toBe(true);
        // Khuôn đặc: mọi bước hàng đều bằng dieH + gap (không lồng được gì).
        expect(minRowPitch(p, 0, 0, GAP)).toBeCloseTo(200 + GAP, 6);
        expect(minRowPitch(p, 0, 180, GAP)).toBeCloseTo(200 + GAP, 6);
    });

    it('minRowPitch không bao giờ vượt dieH + gap và bắt được chỗ lồng được', () => {
        const { model, bb } = build({ boxType: 'hanging_window', L: 80, W: 30, D: 140 });
        const p = computeCutProfile(model, bb.width, bb.height);
        for (const [a, b] of [[0, 0], [0, 180], [180, 0]] as const) {
            const pitch = minRowPitch(p, a, b, GAP);
            expect(pitch).toBeGreaterThan(0);
            expect(pitch).toBeLessThanOrEqual(bb.height + GAP + 1e-6);
        }
        // Xen kẽ 180° phải lồng được (tai treo lồng vào vùng trống khuôn kia).
        expect(minRowPitch(p, 0, 180, GAP)).toBeLessThan(bb.height + GAP - 1);
    });

    it('placementsTooClose: bắt chồng khuôn, tha cặp cách đúng khoảng hở', () => {
        const { model, bb } = build({ boxType: 'hanging_window', L: 80, W: 30, D: 140 });
        const p = computeCutProfile(model, bb.width, bb.height);

        const below = { x: 0, y: 0, rotation: 0 };
        // Hai khuôn trùng khít nhau ⇒ chắc chắn chồng.
        expect(placementsTooClose(below, { x: 0, y: 0, rotation: 0 }, p, GAP)).toBe(true);
        // Cách đúng dieH + gap theo trục dọc ⇒ không chồng.
        expect(placementsTooClose(below, { x: 0, y: bb.height + GAP, rotation: 0 }, p, GAP)).toBe(false);
        // Cạnh nhau theo trục ngang ⇒ không có cột chung, không chồng.
        expect(placementsTooClose(below, { x: bb.width + GAP, y: 0, rotation: 0 }, p, GAP)).toBe(false);
        // Bước hàng ĐÚNG bằng minRowPitch(0°,180°) ⇒ vừa đủ hở, không chồng.
        const pitch = minRowPitch(p, 0, 180, GAP);
        expect(placementsTooClose(below, { x: 0, y: pitch, rotation: 180 }, p, GAP)).toBe(false);
        // Ép sát thêm 1mm ⇒ phải báo chồng.
        expect(placementsTooClose(below, { x: 0, y: pitch - 1, rotation: 180 }, p, GAP)).toBe(true);
        // Khuôn xoay 90° ⇒ profile theo cột không kết luận được.
        expect(placementsTooClose(below, { x: 5, y: 5, rotation: 90 }, p, GAP)).toBeNull();
    });
});

describe('lồng khuôn: không bị loại oan, cũng không được chồng', () => {
    const cases: Array<[string, Partial<BoxParams>]> = [
        ['hanging_window', { boxType: 'hanging_window', L: 80, W: 30, D: 140 }],
        ['rte', { boxType: 'rte', L: 80, W: 30, D: 140 }],
        ['slb', { boxType: 'slb', L: 120, W: 80, D: 180 }],
        ['auto_bottom', { boxType: 'auto_bottom', L: 120, W: 80, D: 180 }],
        ['envelope', { boxType: 'envelope' }],
    ];

    for (const [label, over] of cases) {
        it(`${label}: smart ≥ grid và không cặp nào chồng khuôn`, () => {
            const { params, model, bb } = build(over);
            const gridCfg = { ...structuredClone(DEFAULT_NESTING_CONFIG), nestingMode: 'grid' as const };
            const smartCfg = { ...structuredClone(DEFAULT_NESTING_CONFIG), nestingMode: 'smart' as const };
            const grid = calculateNesting(bb, gridCfg, params, model);
            const smart = calculateNesting(bb, smartCfg, params, model);

            // Bất biến sẵn có của engine: smart không được kém grid.
            expect(smart.countPerSheet).toBeGreaterThanOrEqual(grid.countPerSheet);

            // Không cặp nào chồng vật liệu (kiểm bằng biên dạng thật).
            const p = computeCutProfile(model, bb.width, bb.height);
            for (let i = 0; i < smart.positions.length; i++) {
                for (let j = i + 1; j < smart.positions.length; j++) {
                    const tooClose = placementsTooClose(
                        smart.positions[i], smart.positions[j], p, smartCfg.dieGap,
                    );
                    expect(tooClose === true, `${label}: cặp ${i}-${j} chồng khuôn`).toBe(false);
                }
            }
        });
    }

    it('validator dùng biên dạng thật KHÔNG loại vị trí nào của layout smart', () => {
        for (const [label, over] of cases) {
            const { params, model, bb } = build(over);
            const cfg = { ...structuredClone(DEFAULT_NESTING_CONFIG), nestingMode: 'smart' as const };
            const res = calculateNesting(bb, cfg, params, model);
            const outline = computeDieOutline(model, bb).map((q) => ({
                x: q.x - bb.minX, y: q.y - bb.minY,
            }));
            const profile = computeCutProfile(model, bb.width, bb.height);
            const printable = { left: -1e6, top: -1e6, right: 1e6, bottom: 1e6 };
            const checked = validatePlacementPositions(
                res.positions, outline, cfg.dieGap, printable, profile,
            );
            expect(checked.removed, `${label}: validator loại oan`).toBe(0);
        }
    });
});
