/**
 * Unit test cho ProductAdvisor.recommendInNhanh (Phase 1 — in nhanh).
 * Khoá các Correctness Properties trong design (product-first-imposition).
 */
import { describe, it, expect } from 'vitest';
import { recommendInNhanh, type ProductInput } from '../ProductAdvisor';

const base: ProductInput = {
    printMethod: 'in_nhanh',
    binding: 'saddle',
    finishedWidthMm: 105, finishedHeightMm: 148, // A6
    pageCount: 16,
    sheetWidthMm: 320, sheetHeightMm: 450,        // SRA3
    quantity: 100,
    bleedMm: 3,
};

// Bundle KHÔNG được chứa knob offset.
const OFFSET_KEYS = ['foldPattern', 'gripperMargin', 'interleave'];

describe('ProductAdvisor.recommendInNhanh', () => {
    it('saddle A6 trên SRA3 → có phương án, copiesPerSheet ≥ 1', () => {
        const r = recommendInNhanh(base);
        expect(r.errors).toHaveLength(0);
        expect(r.options.length).toBeGreaterThan(0);
        expect(r.options[0].copiesPerSheet).toBeGreaterThanOrEqual(1);
    });

    it('Property 2: khổ quá nhỏ → options rỗng + errors không rỗng', () => {
        const r = recommendInNhanh({ ...base, finishedWidthMm: 200, finishedHeightMm: 300, sheetWidthMm: 100, sheetHeightMm: 100 });
        expect(r.options).toHaveLength(0);
        expect(r.errors.length).toBeGreaterThan(0);
    });

    it('Property 1: mọi bundle là in_nhanh và KHÔNG chứa knob offset', () => {
        for (const bind of ['saddle', 'thread', 'perfect', 'cut_stacks', 'flush_mount'] as const) {
            const r = recommendInNhanh({ ...base, binding: bind });
            for (const opt of r.options) {
                expect(opt.settings.paperClassification).toBe('in_nhanh');
                for (const k of OFFSET_KEYS) {
                    expect(Object.prototype.hasOwnProperty.call(opt.settings, k)).toBe(false);
                }
            }
        }
    });

    it('Property 5: khổ lớn hơn (cùng tỉ lệ) → copiesPerSheet không giảm', () => {
        const small = recommendInNhanh({ ...base, sheetWidthMm: 320, sheetHeightMm: 450 });
        const big = recommendInNhanh({ ...base, sheetWidthMm: 640, sheetHeightMm: 900 });
        const cSmall = small.options[0].copiesPerSheet;
        const cBig = big.options[0].copiesPerSheet;
        expect(cBig).toBeGreaterThanOrEqual(cSmall);
    });

    it('multi_up xuất hiện khi 1 tờ chứa ≥ 2 cuốn; luôn có one_up đối chiếu', () => {
        // A7-ish nhỏ để chắc chắn nhiều cuốn/tờ
        const r = recommendInNhanh({ ...base, finishedWidthMm: 74, finishedHeightMm: 105 });
        const strategies = r.options.map(o => o.strategy);
        expect(strategies).toContain('one_up');
        if (r.options.find(o => o.strategy === 'multi_up')) {
            const mu = r.options.find(o => o.strategy === 'multi_up')!;
            expect(mu.settings.chainNup).toBe(true);
            expect(mu.settings.scaleMode).toBe('chain_nup');
            expect(mu.copiesPerSheet).toBeGreaterThanOrEqual(2);
        }
    });

    it('cut_stacks → strategy cut_stack + signatureMode cut_stacks', () => {
        const r = recommendInNhanh({ ...base, binding: 'cut_stacks' });
        expect(r.options.length).toBeGreaterThan(0);
        expect(r.options[0].strategy).toBe('cut_stack');
        expect(r.options[0].settings.signatureMode).toBe('cut_stacks');
    });

    it('perfect → signatureMode continuous', () => {
        const r = recommendInNhanh({ ...base, binding: 'perfect' });
        expect(r.options[0].settings.signatureMode).toBe('continuous');
    });

    it('Property fail-loud: pageCount lẻ (không bội 4) → warnings nêu chèn trang trắng', () => {
        const r = recommendInNhanh({ ...base, pageCount: 7 });
        expect(r.options[0].warnings.some(w => w.includes('trang trắng'))).toBe(true);
    });

    it('có quantity → totalSheets = tờ/cuốn × ceil(quantity / copiesPerSheet)', () => {
        const r = recommendInNhanh({ ...base, quantity: 100 });
        const o = r.options[0];
        expect(o.totalSheets).toBe(o.sheetsPerCopySet * Math.ceil(100 / o.copiesPerSheet));
    });
});
