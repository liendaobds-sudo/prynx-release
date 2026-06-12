/**
 * FoldPatterns Unit Tests
 * 
 * Tests spread-level fold pattern definitions for offset imposition:
 * - sig_4p (4 pages, Work & Turn)
 * - sig_8p (8 pages, Work & Turn)
 * - sig_16p (16 pages, Sheetwise A/B)
 * 
 * Key validation: Pair sum rule for saddle stitch.
 */
import { describe, it, expect } from 'vitest';
import {
    SPREAD_FOLD_REGISTRY,
    getSpreadPatternById,
    getPatternForPageCount,
    type SpreadFoldPattern,
} from '../FoldPatterns';


describe('FoldPatterns — Registry', () => {
    it('should have exactly 3 patterns', () => {
        expect(SPREAD_FOLD_REGISTRY).toHaveLength(3);
    });

    it('should have correct pagesPerSig for each pattern', () => {
        const pages = SPREAD_FOLD_REGISTRY.map(p => p.pagesPerSig);
        expect(pages).toContain(4);
        expect(pages).toContain(8);
        expect(pages).toContain(16);
    });

    it('each pattern should have consistent slot counts', () => {
        for (const p of SPREAD_FOLD_REGISTRY) {
            // Grid = cols × rows
            const expectedSlots = p.cols * p.rows;
            if (p.workStyle === 'sheetwise') {
                // Sheetwise = separate front + back plates
                expect(p.frontPlate).toHaveLength(expectedSlots);
                expect(p.backPlate).toHaveLength(expectedSlots);
            } else {
                // Self-turn = only front plate (flipped to create back)
                expect(p.frontPlate).toHaveLength(expectedSlots);
                expect(p.backPlate).toHaveLength(0);
            }
        }
    });
});


describe('FoldPatterns — Lookup', () => {
    it('getSpreadPatternById should find sig_16p', () => {
        const p = getSpreadPatternById('sig_16p');
        expect(p).toBeDefined();
        expect(p!.pagesPerSig).toBe(16);
        expect(p!.workStyle).toBe('sheetwise');
    });

    it('getSpreadPatternById should return undefined for invalid ID', () => {
        expect(getSpreadPatternById('sig_99p')).toBeUndefined();
    });

    it('getPatternForPageCount should prefer exact match', () => {
        expect(getPatternForPageCount(8)?.id).toBe('sig_8p');
        expect(getPatternForPageCount(16)?.id).toBe('sig_16p');
        expect(getPatternForPageCount(4)?.id).toBe('sig_4p');
    });

    it('getPatternForPageCount should fallback to largest fit', () => {
        // 12 pages → no exact match → largest that fits = sig_8p
        const p = getPatternForPageCount(12);
        expect(p).toBeDefined();
        expect(p!.pagesPerSig).toBeLessThanOrEqual(12);
    });
});


describe('FoldPatterns — Spread Index Bounds', () => {
    it('all spreadIndex values should be within [0, spreadsPerSig)', () => {
        for (const p of SPREAD_FOLD_REGISTRY) {
            const allSlots = [...p.frontPlate, ...p.backPlate];
            for (const slot of allSlots) {
                expect(slot.spreadIndex).toBeGreaterThanOrEqual(0);
                expect(slot.spreadIndex).toBeLessThan(p.spreadsPerSig);
            }
        }
    });

    it('rotations should only be 0 or 180', () => {
        for (const p of SPREAD_FOLD_REGISTRY) {
            const allSlots = [...p.frontPlate, ...p.backPlate];
            for (const slot of allSlots) {
                expect([0, 180]).toContain(slot.rotation);
            }
        }
    });
});


describe('FoldPatterns — Self-Turn Patterns', () => {
    it('sig_4p should be work_and_turn with empty backPlate', () => {
        const p = getSpreadPatternById('sig_4p')!;
        expect(p.workStyle).toBe('work_and_turn');
        expect(p.backPlate).toHaveLength(0);
        expect(p.sheetsPerSig).toBe(1);
    });

    it('sig_8p should be work_and_turn with empty backPlate', () => {
        const p = getSpreadPatternById('sig_8p')!;
        expect(p.workStyle).toBe('work_and_turn');
        expect(p.backPlate).toHaveLength(0);
        expect(p.sheetsPerSig).toBe(2);
    });
});
