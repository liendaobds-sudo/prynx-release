/**
 * Regression test — khoá hợp đồng phase-2 của serializeBookletPlan.
 * Bảo vệ các fix audit "bình sách" hướng B:
 *   F1 step_repeat, F2 fold_pattern, F4 cut-stack 180°, F5 gutter.
 * Nếu ai đó vô tình bỏ rơi chainNup/foldPattern (như lỗi cũ) → test này đỏ.
 */
import { describe, it, expect } from 'vitest';
import { generateBindingMap } from '../VirtualMap';
import { solveGeometry } from '../GeometricSolver';
import { serializeBookletPlan } from '../InstructionSerializer';

const MM = 2.83465;
const W = 105 * MM, H = 148 * MM; // A6
const PAGES = 16;
const details = Array.from({ length: PAGES }, () => ({ visualW: W, visualH: H, angle: 0 }));

function build(s: any) {
    const bMode = s.bindingMode || 'saddle';
    const map = generateBindingMap(PAGES, bMode, s.foliosize, 'end').sheets;
    const fp = s.foldPattern;
    const phase2 = !!s.chainNup || (!!fp && fp !== '');
    const pseudo = {
        formsize: (!(s.sheetWidth) || phase2) ? 'auto_100' : 'custom',
        customSheetWidth: s.sheetWidth || 0, customSheetHeight: s.sheetHeight || 0,
        bleed: s.bleed, signatureMode: bMode, spreadDistribution: s.spreadDistribution,
    } as any;
    const geo = solveGeometry(W, H, pseudo, {}, MM);
    return serializeBookletPlan(map, details, geo, (s.bleed || 0) * MM, 0,
        bMode === 'saddle' || bMode === 'thread', s.markType || 'none',
        s.interleave || 'normal', s, 'src.pdf', 'out', PAGES);
}

describe('serializeBookletPlan — phase-2 contract', () => {
    it('plain saddle → no phase2, 4 spread sheets for 16p', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3 });
        expect(p.phase2).toBeUndefined();
        expect(p.sheets).toHaveLength(4);
    });

    it('F1 chain_nup → step_repeat, một plate per spread surface, replicate đầy lưới', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 320, sheetHeight: 450, gripperMargin: 10 });
        expect(p.phase2?.mode).toBe('step_repeat');
        expect(p.sheets).toHaveLength(8);             // 4 sheets × (front+back)
        expect(p.phase2!.plates).toHaveLength(8);     // 1 plate / spread surface
        // mỗi plate nhân bản CÙNG 1 spread vào mọi cell (>=1, thường >1)
        for (const pl of p.phase2!.plates) {
            const idxs = new Set(pl.placements.map(q => q.spread_index));
            expect(idxs.size).toBe(1);
            expect(pl.placements.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('F2 fold_pattern sig_16p → 2 plates (A/B), có slot xoay 180°', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, foldPattern: 'sig_16p', sheetWidth: 700, sheetHeight: 500, gripperMargin: 10 });
        expect(p.phase2?.mode).toBe('fold_pattern');
        expect(p.phase2!.plates).toHaveLength(2);
        for (const pl of p.phase2!.plates) {
            expect(pl.placements).toHaveLength(4);    // 2×2 grid
            expect(pl.placements.some(q => q.rotation_deg === 180)).toBe(true);
            expect(pl.placements.some(q => q.rotation_deg === 0)).toBe(true);
        }
        // phủ đủ 8 spread không trùng
        const all = p.phase2!.plates.flatMap(pl => pl.placements.map(q => q.spread_index));
        expect(new Set(all).size).toBe(8);
    });

    it('F4 cut_stacks "Hút gáy" (clustered) → cọc phải xoay 180°', () => {
        const p = build({ bindingMode: 'cut_stacks', bleed: 3, spreadDistribution: 'clustered' });
        expect(p.phase2).toBeUndefined();
        const front = p.sheets[0].front.placements;
        // [left, right] — cọc phải (index 1) phải r180, trái r0
        expect(front[0].rotation_deg).toBe(0);
        expect(front[1].rotation_deg).toBe(180);
    });

    it('F4 cut_stacks "Trải đều" (even) → KHÔNG xoay', () => {
        const p = build({ bindingMode: 'cut_stacks', bleed: 3, spreadDistribution: 'even' });
        for (const pl of p.sheets[0].front.placements) expect(pl.rotation_deg).toBe(0);
    });

    it('F5 gutter (continuous) → trang trái dịch xa gáy so với gutter=0', () => {
        const g0 = build({ bindingMode: 'continuous', bleed: 3, gutterMargin: 0 });
        const g10 = build({ bindingMode: 'continuous', bleed: 3, gutterMargin: 10 });
        const left0 = g0.sheets[0].front.placements[0].x_pt;
        const left10 = g10.sheets[0].front.placements[0].x_pt;
        expect(left10).toBeLessThan(left0); // dịch sang trái (xa spine) đúng 10mm
        expect(left0 - left10).toBeCloseTo(10 * MM, 1);
    });
});

// Box bbox của 1 spread theo rotation (90/270 hoán chiều).
function boxOf(rot: number, sw: number, sh: number) {
    return (rot % 180 !== 0) ? { w: sh, h: sw } : { w: sw, h: sh };
}
function allInBounds(plan: any): boolean {
    const { spread_w_pt: sw, spread_h_pt: sh, plates } = plan.phase2;
    return plates.every((pl: any) => pl.placements.every((p: any) => {
        const b = boxOf(p.rotation_deg, sw, sh);
        return p.x_pt >= -0.5 && p.y_pt >= -0.5 &&
            p.x_pt + b.w <= pl.width_pt + 0.5 && p.y_pt + b.h <= pl.height_pt + 0.5;
    }));
}
function noOverlap(plate: any, sw: number, sh: number): boolean {
    const boxes = plate.placements.map((p: any) => {
        const b = boxOf(p.rotation_deg, sw, sh);
        return { x: p.x_pt, y: p.y_pt, w: b.w, h: b.h };
    });
    for (let a = 0; a < boxes.length; a++)
        for (let c = a + 1; c < boxes.length; c++) {
            const A = boxes[a], B = boxes[c];
            const ix = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
            const iy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
            if (ix * iy > 1) return false;
        }
    return true;
}

describe('serializeBookletPlan — phase-2 grid rotation (90°) & cut_stack', () => {
    it('step_repeat khổ ngang → KHÔNG xoay (rot 0), trong khổ, không chồng', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 640, sheetHeight: 450, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        expect(p.phase2!.plates.every((pl: any) => pl.placements.every((q: any) => q.rotation_deg === 0))).toBe(true);
        expect(allInBounds(p)).toBe(true);
        expect(p.phase2!.plates.every((pl: any) => noOverlap(pl, p.phase2!.spread_w_pt, p.phase2!.spread_h_pt))).toBe(true);
    });

    it('step_repeat khổ dọc → XOAY 90° (mọi placement rot 90), vẫn trong khổ', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 320, sheetHeight: 450, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        expect(p.phase2!.plates.every((pl: any) => pl.placements.every((q: any) => q.rotation_deg === 90))).toBe(true);
        expect(allInBounds(p)).toBe(true);
        // khổ thật phải là khổ đặt (xoay chỉ ảnh hưởng nội dung, không đổi khổ tờ)
        expect(Math.round(p.phase2!.plates[0].width_pt)).toBe(Math.round(320 * MM));
    });

    it('fold_pattern khổ dọc → slot 0/180 cộng 90 thành 90/270', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, foldPattern: 'sig_16p', sheetWidth: 500, sheetHeight: 700, marginLeft: 10, marginRight: 10, marginTop: 10, gripperMargin: 10 });
        const rots = new Set<number>(p.phase2!.plates.flatMap((pl: any) => pl.placements.map((q: any) => q.rotation_deg)));
        expect(rots.has(90)).toBe(true);
        expect(rots.has(270)).toBe(true);
        expect(allInBounds(p)).toBe(true);
    });

    it('cut_stack → mặt A (surface chẵn) + mặt B (surface lẻ), phủ đủ, không chồng', () => {
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, cutStack: true, sheetWidth: 450, sheetHeight: 320, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        expect(p.phase2!.mode).toBe('cut_stack');
        const fronts = p.phase2!.plates.filter((_: any, i: number) => i % 2 === 0).flatMap((pl: any) => pl.placements.map((q: any) => q.spread_index));
        const backs = p.phase2!.plates.filter((_: any, i: number) => i % 2 === 1).flatMap((pl: any) => pl.placements.map((q: any) => q.spread_index));
        expect(fronts.every((s: number) => s % 2 === 0)).toBe(true); // mặt A = surface chẵn (front spread)
        expect(backs.every((s: number) => s % 2 === 1)).toBe(true);  // mặt B = surface lẻ (back spread)
        expect(new Set([...fronts, ...backs]).size).toBe(8);         // phủ đủ 8 surface
        expect(p.phase2!.plates.every((pl: any) => noOverlap(pl, p.phase2!.spread_w_pt, p.phase2!.spread_h_pt))).toBe(true);
    });

    it('REGRESSION: khổ NHỎ hơn spread → tấm in GIỮ đúng khổ chọn (không tự nới)', () => {
        // Bug "chọn 320 ra 422": spread A6 = 210mm rộng > khổ chọn 150mm.
        // Trước đây buildPhase2 tự nới tấm lên 210+lề. Giờ phải GIỮ 150 (xoay 90° để fit).
        const p = build({ bindingMode: 'saddle', bleed: 3, chainNup: true, sheetWidth: 150, sheetHeight: 400, marginLeft: 8, marginRight: 8, marginTop: 8, gripperMargin: 10 });
        expect(p.phase2?.mode).toBe('step_repeat');
        // Tấm in = đúng khổ giấy đã chọn (150×400), KHÔNG phình theo spread.
        for (const pl of p.phase2!.plates) {
            expect(Math.round(pl.width_pt)).toBe(Math.round(150 * MM));
            expect(Math.round(pl.height_pt)).toBe(Math.round(400 * MM));
        }
        expect(allInBounds(p)).toBe(true);
    });
});
