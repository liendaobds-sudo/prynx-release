import { describe, expect, it } from 'vitest';

import {
    BINDING_AVAILABILITY,
    calcSpineThickness,
    MIN_SPINE_BY_BINDING,
    PAGES_PER_SHEET,
} from './spine';

/**
 * Số đối chiếu lấy TRỰC TIẾP từ ô Excel sheet 'Bảng tra độ dày gáy sách'
 * (tổng số trang ruột = 26, đúng giá trị ô AE4 khi bóc workbook).
 * Đây là test chống hồi quy: sửa công thức mà lệch số này = sai.
 */
describe('calcSpineThickness — khớp từng ô Excel (26 trang ruột)', () => {
    const P = 26;

    it('Couche 60.2 khâu chỉ = D11', () => {
        const r = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: P, binding: 'thread' });
        expect(r.spineMm).toBeCloseTo(0.70434, 10);
    });

    it('Couche 60.2 khâu chỉ + cán 1 mặt = E11', () => {
        const r = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: P, binding: 'thread', lamination: '1s' });
        expect(r.spineMm).toBeCloseTo(0.7923825, 10);
    });

    it('Couche 60.2 khâu chỉ + cán 2 mặt = F11', () => {
        const r = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: P, binding: 'thread', lamination: '2s' });
        expect(r.spineMm).toBeCloseTo(0.880425, 10);
    });

    it('Couche 60.2 keo nhiệt = G11', () => {
        const r = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: P, binding: 'hotmelt' });
        expect(r.spineMm).toBeCloseTo(0.62608, 10);
    });

    it('Couche 60.2 bồi liên kết = J11', () => {
        const r = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: P, binding: 'mounted' });
        expect(r.spineMm).toBeCloseTo(1.64346, 10);
    });

    it('Couche 350 khâu chỉ = D34', () => {
        const r = calcSpineThickness({ family: 'couche', gsm: 350, totalPages: P, binding: 'thread' });
        expect(r.spineMm).toBeCloseTo(4.095, 10);
    });

    it('Couche Matt 52.3 khâu chỉ = N11', () => {
        const r = calcSpineThickness({ family: 'couche_matt', gsm: 52.3, totalPages: P, binding: 'thread' });
        expect(r.spineMm).toBeCloseTo(0.61191, 10);
    });

    it('Duplex 230 bồi liên kết = U11', () => {
        const r = calcSpineThickness({ family: 'duplex', gsm: 230, totalPages: P, binding: 'mounted' });
        expect(r.spineMm).toBeCloseTo(6.279, 10);
    });

    it('Bristol 170 khâu chỉ = X11', () => {
        const r = calcSpineThickness({ family: 'bristol', gsm: 170, totalPages: P, binding: 'thread' });
        expect(r.spineMm).toBeCloseTo(1.989, 10);
    });

    it('Ivory 444 bồi liên kết = AE38', () => {
        const r = calcSpineThickness({ family: 'ivory', gsm: 444, totalPages: P, binding: 'mounted' });
        expect(r.spineMm).toBeCloseTo(12.1212, 10);
    });

    it('Fort 58 khâu chỉ = AH11 (giấy xốp → hệ số CỘNG)', () => {
        const r = calcSpineThickness({ family: 'fort', gsm: 58, totalPages: P, binding: 'thread' });
        expect(r.spineMm).toBeCloseTo(1.0556, 10);
    });

    it('Fort 58 keo nhiệt = AI11', () => {
        const r = calcSpineThickness({ family: 'fort', gsm: 58, totalPages: P, binding: 'hotmelt' });
        expect(r.spineMm).toBeCloseTo(0.9802, 10);
    });

    it('Fort 400 bồi liên kết = AJ35', () => {
        const r = calcSpineThickness({ family: 'fort', gsm: 400, totalPages: P, binding: 'mounted' });
        expect(r.spineMm).toBeCloseTo(17.16, 10);
    });

    it('Art EK 75 khâu chỉ = AM11', () => {
        const r = calcSpineThickness({ family: 'art', gsm: 75, totalPages: P, binding: 'thread' });
        expect(r.spineMm).toBeCloseTo(1.365, 10);
    });

    it('Kraft 440 bồi liên kết = AT38', () => {
        const r = calcSpineThickness({ family: 'kraft', gsm: 440, totalPages: P, binding: 'mounted' });
        expect(r.spineMm).toBeCloseTo(18.876, 10);
    });
});

describe('calcSpineThickness — hành vi', () => {
    it('giấy tráng phủ khâu chỉ MỎNG hơn số quy đổi thô (hệ số trừ)', () => {
        const raw = (100 / PAGES_PER_SHEET) * 100 / 1000; // 5mm
        const r = calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 100, binding: 'thread' });
        expect(r.spineMm).toBeLessThan(raw);
    });

    it('giấy xốp khâu chỉ DÀY hơn số quy đổi thô (hệ số cộng)', () => {
        const raw = (100 / PAGES_PER_SHEET) * 100 / 1000;
        const r = calcSpineThickness({ family: 'fort', gsm: 100, totalPages: 100, binding: 'thread' });
        expect(r.spineMm).toBeGreaterThan(raw);
    });

    it('keo nhiệt cho gáy mỏng hơn khâu chỉ ở giấy tráng phủ', () => {
        const args = { family: 'couche' as const, gsm: 100, totalPages: 200 };
        const thread = calcSpineThickness({ ...args, binding: 'thread' }).spineMm;
        const hotmelt = calcSpineThickness({ ...args, binding: 'hotmelt' }).spineMm;
        expect(hotmelt).toBeLessThan(thread);
    });

    it('cán 2 mặt dày gấp đôi phần bù của cán 1 mặt', () => {
        const args = { family: 'couche' as const, gsm: 100, totalPages: 200, binding: 'thread' as const };
        const bare = calcSpineThickness(args).spineMm;
        const s1 = calcSpineThickness({ ...args, lamination: '1s' }).spineMm;
        const s2 = calcSpineThickness({ ...args, lamination: '2s' }).spineMm;
        expect(s1 - bare).toBeCloseTo((s2 - bare) / 2, 12);
    });

    it('số trang tăng thì gáy dày lên tuyến tính', () => {
        const a = calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 100, binding: 'thread' }).spineMm;
        const b = calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 200, binding: 'thread' }).spineMm;
        expect(b).toBeCloseTo(a * 2, 12);
    });

    it('đếm số tờ = số trang / 2, làm tròn lên', () => {
        expect(calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 26, binding: 'thread' }).sheetCount).toBe(13);
        expect(calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 27, binding: 'thread' }).sheetCount).toBe(14);
    });

    it('khâu chỉ — không cảnh báo gáy mỏng (không có ngưỡng tối thiểu)', () => {
        const thin = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: 26, binding: 'thread' });
        expect(thin.thinWarning).toBeNull();
    });

    it('keo nhiệt — cảnh báo khi gáy < 3mm', () => {
        const thin = calcSpineThickness({ family: 'couche', gsm: 60.2, totalPages: 26, binding: 'hotmelt' });
        expect(thin.thinWarning).toEqual({ minMm: 3 });

        const thick = calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 200, binding: 'hotmelt' });
        expect(thick.thinWarning).toBeNull();
    });

    it('bồi liên kết — cảnh báo khi gáy < 8mm', () => {
        const thin = calcSpineThickness({ family: 'couche', gsm: 100, totalPages: 26, binding: 'mounted' });
        expect(thin.thinWarning).toEqual({ minMm: 8 });

        const thick = calcSpineThickness({ family: 'couche', gsm: 350, totalPages: 200, binding: 'mounted' });
        expect(thick.thinWarning).toBeNull();
    });
});

describe('BINDING_AVAILABILITY — phản ánh cột workbook để trống', () => {
    it('Duplex/Ivory/Kraft chỉ có bồi liên kết', () => {
        expect(BINDING_AVAILABILITY.duplex).toEqual(['mounted']);
        expect(BINDING_AVAILABILITY.ivory).toEqual(['mounted']);
        expect(BINDING_AVAILABILITY.kraft).toEqual(['mounted']);
    });

    it('Couche/Couche Matt/Bristol/Fort/Art có đủ 4 kiểu (gồm bấm ghim)', () => {
        for (const f of ['couche', 'couche_matt', 'bristol', 'fort', 'art'] as const) {
            expect(BINDING_AVAILABILITY[f]).toHaveLength(4);
        }
    });

    it('nhóm KHÁC workbook để trống hoàn toàn', () => {
        expect(BINDING_AVAILABILITY.other).toEqual([]);
    });
});
