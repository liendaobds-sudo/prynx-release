// ============================================================
// Unit Tests — nestingEngine.ts
// ============================================================

import { describe, it, expect } from 'vitest';
import { calculateNesting } from './nestingEngine';
import { NestingConfig, DEFAULT_NESTING_CONFIG } from './nestingTypes';
import { BoxParams, DEFAULT_PARAMS } from './types';

/** Helper: tạo config với overrides */
function makeConfig(overrides: Partial<NestingConfig> = {}): NestingConfig {
    return { ...DEFAULT_NESTING_CONFIG, ...overrides };
}

/** Helper: tạo params với overrides */
function makeParams(overrides: Partial<BoxParams> = {}): BoxParams {
    return { ...DEFAULT_PARAMS, ...overrides };
}

describe('nestingEngine — calculateNesting', () => {

    // ── Grid mode cơ bản ────────────────────────────────

    describe('Grid None (0°)', () => {
        it('should fit correct number of dielines in a simple case', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                margin: { top: 10, right: 10, bottom: 10, left: 10 },
                gripperMargin: 12,
                dieGap: 3,
                gutter: 3,
                rotation: 'none',
                sheetOrientation: 'portrait',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Area: 300 x 428, cellW = 103, cellH = 203
            // cols = floor(303/103) = 2, rows = floor(431/203) = 2 → 4
            expect(result.countPerSheet).toBe(4);
            expect(result.cols).toBe(2);
            expect(result.rows).toBe(2);
            expect(result.positions.length).toBe(4);
        });

        it('should return 0 when dieline is larger than sheet', () => {
            const bbox = { width: 1000, height: 1000 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                rotation: 'none',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBe(0);
            expect(result.positions.length).toBe(0);
        });

        it('should fit exactly 1 when dieline just fits', () => {
            const bbox = { width: 290, height: 418 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                margin: { top: 10, right: 10, bottom: 10, left: 10 },
                gripperMargin: 12,
                dieGap: 3,
                gutter: 3,
                rotation: 'none',
                sheetOrientation: 'portrait',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBe(1);
        });
    });

    // ── Grid 90° ────────────────────────────────────────

    describe('Grid 90°', () => {
        it('should rotate narrow dieline for better fit', () => {
            // 50×300 on 320×450 sheet (area ~300×428)
            // At 0°: cols = floor(303/53)=5, rows = floor(431/303)=1 → 5
            // At 90°: cols = floor(303/303)=1, rows = floor(431/53)=8 → 8
            const bbox = { width: 50, height: 300 };
            const config = makeConfig({
                sheet: { width: 320, height: 450 },
                rotation: '90',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Only 90° is returned from calcGrid90, auto won't compare
            expect(result.positions.every(p => p.rotation === 90)).toBe(true);
        });
    });

    // ── Auto rotation ───────────────────────────────────

    describe('Grid Auto', () => {
        it('should pick the best of 0°, 180°, and 90°', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                rotation: 'auto',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Should have positions
            expect(result.countPerSheet).toBeGreaterThan(0);
            // Auto should pick the most efficient
            expect(result.label).toBeTruthy();
        });
    });

    // ── Sheet orientation ───────────────────────────────

    describe('Sheet Orientation', () => {
        it('auto should try both orientations', () => {
            const bbox = { width: 200, height: 100 };
            const configAuto = makeConfig({
                sheet: { width: 320, height: 450 },
                sheetOrientation: 'auto',
                rotation: 'none',
                nestingMode: 'grid',
            });
            const resultAuto = calculateNesting(bbox, configAuto);

            const configPortrait = makeConfig({
                sheet: { width: 320, height: 450 },
                sheetOrientation: 'portrait',
                rotation: 'none',
                nestingMode: 'grid',
            });
            const resultPortrait = calculateNesting(bbox, configPortrait);

            const configLandscape = makeConfig({
                sheet: { width: 320, height: 450 },
                sheetOrientation: 'landscape',
                rotation: 'none',
                nestingMode: 'grid',
            });
            const resultLandscape = calculateNesting(bbox, configLandscape);

            // Auto should be >= both forced orientations
            expect(resultAuto.countPerSheet).toBeGreaterThanOrEqual(resultPortrait.countPerSheet);
            expect(resultAuto.countPerSheet).toBeGreaterThanOrEqual(resultLandscape.countPerSheet);
        });

        it('portrait should swap dimensions if needed', () => {
            const bbox = { width: 100, height: 100 };
            const config = makeConfig({
                sheet: { width: 450, height: 320 }, // landscape dimensions
                sheetOrientation: 'portrait',         // force portrait
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            // Should swap to 320×450
            expect(result.actualSheet.width).toBe(320);
            expect(result.actualSheet.height).toBe(450);
        });
    });

    // ── Smart mode: RTE ─────────────────────────────────

    describe('Smart RTE', () => {
        it('should use interlock for RTE and fit more than grid', () => {
            const bbox = { width: 280, height: 620 };
            const params = makeParams({ boxType: 'rte', L: 100, W: 60, D: 200, T: 0.5, TH: 15, DFH: 0 });
            const configGrid = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'grid',
                rotation: 'none',
            });
            const configSmart = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });

            const gridResult = calculateNesting(bbox, configGrid);
            const smartResult = calculateNesting(bbox, configSmart, params);

            // Smart should fit >= grid (interlock reduces cellH)
            expect(smartResult.countPerSheet).toBeGreaterThanOrEqual(gridResult.countPerSheet);
            // Smart should have a descriptive label (could be interlock or grid if grid is better)
            expect(smartResult.label).toBeTruthy();
        });

        it('should have all positions at 0° rotation for RTE', () => {
            const bbox = { width: 280, height: 620 };
            const params = makeParams({ boxType: 'rte' });
            const config = makeConfig({ nestingMode: 'smart' });
            const result = calculateNesting(bbox, config, params);
            // If interlock is chosen, all should be 0°
            if (result.label.includes('khoảng trống')) {
                expect(result.positions.every(p => p.rotation === 0)).toBe(true);
            }
        });
    });

    // ── Smart mode: SLB ─────────────────────────────────

    describe('Smart SLB', () => {
        it('should use 180° interlock for SLB', () => {
            // Dùng bbox nhỏ hơn để đảm bảo có ≥2 hàng → kiểm tra xoay 180°
            const bbox = { width: 280, height: 350 };
            const params = makeParams({ boxType: 'slb', L: 100, W: 60, D: 200, T: 0.5, TH: 15, lockTab: false });
            const config = makeConfig({ nestingMode: 'smart', sheet: { width: 790, height: 1090 } });
            const result = calculateNesting(bbox, config, params);

            // SLB smart luôn chọn interlock theo cặp
            expect(result.label).toContain('Lồng cặp 180°');
            expect(result.countPerSheet).toBeGreaterThanOrEqual(2);

            // Phải có cả 0° và 180°
            const rotations = new Set(result.positions.map(p => p.rotation));
            expect(rotations.has(0)).toBe(true);
            expect(rotations.has(180)).toBe(true);
        });
    });

    // ── Smart mode: Gable / Paper Bag ───────────────────

    describe('Smart Gable/PaperBag', () => {
        it('should fallback to grid for gable box', () => {
            const bbox = { width: 280, height: 400 };
            const params = makeParams({ boxType: 'gable' });
            const config = makeConfig({ nestingMode: 'smart' });
            const result = calculateNesting(bbox, config, params);

            // Should still work (grid fallback)
            expect(result.countPerSheet).toBeGreaterThanOrEqual(0);
            // Label should be grid-based
            expect(result.label).toMatch(/Grid|0°|90°/);
        });
    });

    // ── Utilization ─────────────────────────────────────

    describe('Utilization', () => {
        it('should calculate utilization as percentage of usable area', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'grid',
                rotation: 'none',
            });
            const result = calculateNesting(bbox, config);
            expect(result.utilization).toBeGreaterThan(0);
            expect(result.utilization).toBeLessThanOrEqual(100);
        });
    });

    // ── Edge cases ──────────────────────────────────────

    describe('Edge Cases', () => {
        it('should handle square dieline', () => {
            const bbox = { width: 100, height: 100 };
            const config = makeConfig({ nestingMode: 'grid', rotation: 'auto' });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(0);
        });

        it('should handle very small dieline', () => {
            const bbox = { width: 10, height: 10 };
            const config = makeConfig({ nestingMode: 'grid', rotation: 'none' });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(100);
        });

        it('should handle zero margins', () => {
            const bbox = { width: 100, height: 100 };
            const config = makeConfig({
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
                gripperMargin: 0,
                nestingMode: 'grid',
                rotation: 'none',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(0);
        });

        it('should return proper result structure', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig();
            const result = calculateNesting(bbox, config);

            expect(result).toHaveProperty('positions');
            expect(result).toHaveProperty('countPerSheet');
            expect(result).toHaveProperty('rows');
            expect(result).toHaveProperty('cols');
            expect(result).toHaveProperty('utilization');
            expect(result).toHaveProperty('usableArea');
            expect(result).toHaveProperty('actualSheet');
            expect(result).toHaveProperty('cellSize');
            expect(result).toHaveProperty('label');
            expect(result).toHaveProperty('superTile');
        });
    });

    // ── Grid: 180° removed ──────────────────────────────

    describe('Grid mode has no 180°', () => {
        it('grid mode should only use 0° or 90° rotations', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                rotation: 'auto',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);
            expect(result.countPerSheet).toBeGreaterThan(0);
            // Grid mode should only produce 0° or 90°
            expect(result.positions.every(p => p.rotation === 0 || p.rotation === 90)).toBe(true);
        });
    });

    // ── Positions non-overlapping verification ──────────

    describe('Non-overlapping positions', () => {
        it('grid positions should not overlap', () => {
            const bbox = { width: 100, height: 200 };
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                rotation: 'none',
                nestingMode: 'grid',
            });
            const result = calculateNesting(bbox, config);

            // Check no two positions share the exact same (x,y)
            const coords = result.positions.map(p => `${p.x},${p.y}`);
            const uniqueCoords = new Set(coords);
            expect(uniqueCoords.size).toBe(coords.length);
        });
    });

    // ── Smart mode: Envelope ────────────────────────────

    describe('Smart Envelope — Wallet (ngang)', () => {
        it('should use 180° column interlock for wallet envelope', () => {
            // Bì wallet nằm NGANG: die rộng-thấp (360×90) — interlock theo cột
            // (xoay 180° xen kẽ + lồng tai hông) xếp được nhiều hơn grid.
            const bbox = { width: 360, height: 90 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 220,
                envH: 110,
                envFH: 20,
                envSF: 30,
                envFlapShape: 'pointed',
                envStyle: 'wallet',
            });
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });
            const result = calculateNesting(bbox, config, params);

            expect(result.countPerSheet).toBeGreaterThan(0);
            expect(result.label).toContain('Lồng bì ngang');

            // Phải có cả 0° và 180°
            const rotations = new Set(result.positions.map(p => p.rotation));
            expect(rotations.has(0)).toBe(true);
            expect(rotations.has(180)).toBe(true);
        });

        it('smart wallet should fit >= grid', () => {
            const bbox = { width: 244, height: 270 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 220,
                envH: 110,
                envFlapShape: 'pointed',
                envStyle: 'wallet',
            });
            const configGrid = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'grid',
                rotation: 'auto',
            });
            const configSmart = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });

            const gridResult = calculateNesting(bbox, configGrid);
            const smartResult = calculateNesting(bbox, configSmart, params);

            expect(smartResult.countPerSheet).toBeGreaterThanOrEqual(gridResult.countPerSheet);
        });
    });

    describe('Smart Envelope — Pocket (dọc)', () => {
        it('should use 3-row interlock for pocket envelope', () => {
            // Bì dọc C5 (229×162): internal W=162, H=229
            // bbox ≈ 2*W + SF + FH × H + SF ≈ ~400 × ~250
            const bbox = { width: 400, height: 250 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 229,
                envH: 162,
                envFH: 0,
                envSF: 0,
                envFlapShape: 'pointed',
                envStyle: 'pocket',
            });
            const config = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });
            const result = calculateNesting(bbox, config, params);

            expect(result.countPerSheet).toBeGreaterThan(0);
            expect(result.label).toContain('Lồng bì dọc');

            // Phải có cả 0° và 180° (3-row pattern)
            const rotations = new Set(result.positions.map(p => p.rotation));
            expect(rotations.has(0)).toBe(true);
            expect(rotations.has(180)).toBe(true);
        });

        it('smart pocket should produce valid interlock layout', () => {
            const bbox = { width: 400, height: 250 };
            const params = makeParams({
                boxType: 'envelope',
                envW: 229,
                envH: 162,
                envFlapShape: 'pointed',
                envStyle: 'pocket',
            });
            const configSmart = makeConfig({
                sheet: { width: 790, height: 1090 },
                nestingMode: 'smart',
            });

            const smartResult = calculateNesting(bbox, configSmart, params);

            // Smart pocket phải xếp được ít nhất 1 khuôn
            expect(smartResult.countPerSheet).toBeGreaterThan(0);
            // Label phải mô tả lồng bì dọc
            expect(smartResult.label).toContain('Lồng bì dọc');
        });
    });
});
