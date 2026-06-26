import { describe, it, expect } from 'vitest';
import { validateParams } from './validateParams';
import { DEFAULT_PARAMS, BoxParams } from './types';

// Helper to create params with overrides
const make = (overrides: Partial<BoxParams> = {}): BoxParams => ({
    ...DEFAULT_PARAMS,
    ...overrides,
});

describe('validateParams', () => {
    // ─── Basic clamping ───────────────────────────────────

    it('returns default params unchanged', () => {
        const { params, warnings, wasClamped } = validateParams(DEFAULT_PARAMS);
        expect(wasClamped).toBe(false);
        expect(warnings).toHaveLength(0);
        expect(params.L).toBe(DEFAULT_PARAMS.L);
    });

    it('clamps L below minimum (30mm)', () => {
        const { params, wasClamped } = validateParams(make({ L: 10 }));
        expect(wasClamped).toBe(true);
        expect(params.L).toBe(30);
    });

    it('clamps L above maximum (600mm)', () => {
        const { params, wasClamped } = validateParams(make({ L: 1000 }));
        expect(wasClamped).toBe(true);
        expect(params.L).toBe(600);
    });

    it('clamps W below minimum (15mm)', () => {
        const { params, wasClamped } = validateParams(make({ W: 5 }));
        expect(wasClamped).toBe(true);
        expect(params.W).toBe(15);
    });

    it('clamps T below minimum (0.2mm)', () => {
        const { params, wasClamped } = validateParams(make({ T: 0.05 }));
        expect(wasClamped).toBe(true);
        expect(params.T).toBe(0.2);
    });

    // ─── Constraint: W ≤ L ────────────────────────────────

    it('reduces W when W > L (user edited L)', () => {
        const { params, warnings, wasClamped } = validateParams(
            make({ L: 80, W: 100 }),
            'L'
        );
        expect(wasClamped).toBe(true);
        expect(params.W).toBeLessThanOrEqual(params.L);
        expect(warnings.length).toBeGreaterThan(0);
    });

    it('increases L when W > L (user edited W)', () => {
        const { params, warnings, wasClamped } = validateParams(
            make({ L: 80, W: 100 }),
            'W'
        );
        expect(wasClamped).toBe(true);
        expect(params.L).toBeGreaterThanOrEqual(params.W);
        expect(warnings.length).toBeGreaterThan(0);
    });

    it('allows L === W', () => {
        const { params } = validateParams(make({ L: 100, W: 100 }));
        // Should not clamp when equal
        expect(params.L).toBe(100);
        expect(params.W).toBe(100);
    });

    // ─── Constraint: T < W/2 ──────────────────────────────

    it('clamps T when T >= W/2', () => {
        const { params, wasClamped } = validateParams(make({ W: 20, T: 12 }));
        expect(wasClamped).toBe(true);
        expect(params.T).toBeLessThan(params.W / 2);
    });

    // ─── Constraint: G ≤ 60% of W ────────────────────────

    it('clamps G when glue flap too wide', () => {
        const { params, wasClamped, warnings } = validateParams(
            make({ W: 30, G: 25 })
        );
        expect(wasClamped).toBe(true);
        expect(params.G).toBeLessThanOrEqual(params.W * 0.6);
        expect(warnings.some(w => w.includes('Mép keo'))).toBe(true);
    });

    // ─── Constraint: TH ≤ W ──────────────────────────────

    it('clamps TH when tuck height exceeds W', () => {
        const { params, wasClamped } = validateParams(
            make({ W: 40, TH: 60 })
        );
        expect(wasClamped).toBe(true);
        expect(params.TH).toBeLessThanOrEqual(params.W);
    });

    // ─── SLB snap-lock constraints ─────────────────────────

    it('validates snap-lock bottom params (SLB)', () => {
        const { params } = validateParams(
            make({ boxType: 'slb', L: 100, W: 60, T: 0.5, SLP: 2 })
        );
        expect(params.boxType).toBe('slb');
        // Should produce valid params
        expect(params.L).toBeGreaterThan(0);
        expect(params.W).toBeGreaterThan(0);
    });

    it('enforces SLB L ≈ W edge case', () => {
        const { params } = validateParams(
            make({ boxType: 'slb', L: 60, W: 60, T: 0.5, SLP: 1 })
        );
        // Should not crash, should produce valid output
        expect(params.L).toBeGreaterThanOrEqual(params.W);
    });

    // ─── Paper bag constraints ──────────────────────────────

    it('clamps BF to 85% of W for paper bag', () => {
        const { params, wasClamped } = validateParams(
            make({ boxType: 'paper_bag', W: 40, BF: 50 })
        );
        expect(wasClamped).toBe(true);
        expect(params.BF).toBeLessThanOrEqual(Math.floor(params.W * 0.85));
    });

    // ─── Cup sleeve constraints ──────────────────────────────

    it('enforces cupD2 > cupD1 + 5mm gap', () => {
        const { params, wasClamped } = validateParams(
            make({ boxType: 'cup_sleeve', cupD1: 80, cupD2: 80 })
        );
        expect(wasClamped).toBe(true);
        expect(params.cupD2 - params.cupD1).toBeGreaterThanOrEqual(5);
    });

    it('auto-swaps cupD1 and cupD2 when inverted', () => {
        const { params, wasClamped } = validateParams(
            make({ boxType: 'cup_sleeve', cupD1: 90, cupD2: 70 })
        );
        expect(wasClamped).toBe(true);
        // After swap, cupD1 should be smaller
        expect(params.cupD1).toBeLessThan(params.cupD2);
    });

    // ─── DFH (dust flap height) constraints ──────────────────

    it('clamps DFH when it exceeds min(L/2-1, W+T) for RTE', () => {
        const { params, wasClamped } = validateParams(
            make({ boxType: 'rte', L: 100, W: 60, T: 0.5, DFH: 200 })
        );
        expect(wasClamped).toBe(true);
        expect(params.DFH).toBeLessThanOrEqual(Math.min(params.L / 2 - 1, params.W + params.T));
    });

    // ─── Gable box constraints ───────────────────────────────

    it('clamps HW when handle width exceeds L-20 for gable box', () => {
        const { params, wasClamped } = validateParams(
            make({ boxType: 'gable', L: 80, HW: 100 })
        );
        expect(wasClamped).toBe(true);
        expect(params.HW).toBeLessThanOrEqual(Math.max(20, params.L - 20));
    });

    // ─── Pizza box constraints ───────────────────────────────

    it('allows W > L for pizza box (rectangular tray)', () => {
        const { params, wasClamped: _wasClamped, warnings } = validateParams(
            make({ boxType: 'pizza', L: 250, W: 350, D: 40 })
        );
        // Should NOT clamp W down to L
        expect(params.W).toBe(350);
        expect(params.L).toBe(250);
        // No W>L warning for pizza
        expect(warnings.some(w => w.includes('W') && w.includes('L'))).toBe(false);
    });

    it('enforces D > T for pizza box', () => {
        const { params, wasClamped } = validateParams(
            make({ boxType: 'pizza', D: 0.5, T: 0.5 })
        );
        expect(wasClamped).toBe(true);
        expect(params.D).toBeGreaterThan(params.T);
    });

    it('warns when pizza D is unusually large', () => {
        const { warnings } = validateParams(
            make({ boxType: 'pizza', L: 300, W: 300, D: 150 })
        );
        expect(warnings.some(w => w.includes('D='))).toBe(true);
    });
});
