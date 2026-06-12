/**
 * SheetOptimizer Unit Tests
 * 
 * Tests the smart sheet & signature optimizer:
 * - Master sig selection (16 > 8 > 4)
 * - Sheet fit validation (with rotation)
 * - Utilization calculation
 * - Warning generation
 * - Minimum sheet suggestion
 */
import { describe, it, expect } from 'vitest';
import { optimizeMasterSig, suggestMinimumSheet } from '../SheetOptimizer';
import type { PageDimensions, SheetDimensions, MarginConfig } from '../SheetOptimizer';

// MM_TO_POINTS = 72/25.4 ≈ 2.8346
const MM_TO_POINTS = 72 / 25.4;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create A5 page dimensions (in pt) */
const A5_PT: PageDimensions = { width: 148 * MM_TO_POINTS, height: 210 * MM_TO_POINTS };
/** Create A4 page dimensions (in pt) */
const A4_PT: PageDimensions = { width: 210 * MM_TO_POINTS, height: 297 * MM_TO_POINTS };
/** Create very large page (in pt) */
const HUGE_PT: PageDimensions = { width: 400 * MM_TO_POINTS, height: 500 * MM_TO_POINTS };

const SRA3_SHEET: SheetDimensions = { width: 320, height: 450 };
const SMALL_SHEET: SheetDimensions = { width: 200, height: 300 };

const defaultMargins: MarginConfig = {
    gripperMargin: 10,
    marginTop: 5,
    marginLeft: 5,
    marginRight: 5,
    bleed: 2,
};


// ═══════════════════════════════════════════════════════════════════════════
//  OPTIMIZE MASTER SIG
// ═══════════════════════════════════════════════════════════════════════════

describe('optimizeMasterSig', () => {
    it('should recommend best fitting sig for A5 pages on SRA3 sheet', () => {
        const result = optimizeMasterSig(A5_PT, SRA3_SHEET, defaultMargins);
        expect(result.recommended).not.toBeNull();
        // A5 spread (148×2+bleed = ~300mm wide) on SRA3 (320×450mm):
        // sig_16p needs 2×2 grid ≈ 600×424mm → doesn't fit 320mm width
        // sig_8p needs 1×2 grid ≈ 300×424mm → fits SRA3
        expect(result.recommended!.pagesPerSig).toBe(8);
        expect(result.recommended!.fits).toBe(true);
    });

    it('should have 3 options in allOptions', () => {
        const result = optimizeMasterSig(A5_PT, SRA3_SHEET, defaultMargins);
        expect(result.allOptions).toHaveLength(3);
    });

    it('should return utilization > 0 for fitting options', () => {
        const result = optimizeMasterSig(A5_PT, SRA3_SHEET, defaultMargins);
        for (const opt of result.validOptions) {
            expect(opt.sheetUtilization).toBeGreaterThan(0);
            expect(opt.sheetUtilization).toBeLessThanOrEqual(100);
        }
    });

    it('should return null recommended when no sig fits', () => {
        const result = optimizeMasterSig(HUGE_PT, SMALL_SHEET, defaultMargins);
        expect(result.recommended).toBeNull();
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should prefer largest pagesPerSig when multiple fit', () => {
        const result = optimizeMasterSig(A5_PT, SRA3_SHEET, defaultMargins);
        if (result.validOptions.length > 1) {
            expect(result.recommended!.pagesPerSig).toBe(
                Math.max(...result.validOptions.map(o => o.pagesPerSig))
            );
        }
    });

    it('should handle zero bleed gracefully', () => {
        const noBleedMargins: MarginConfig = { ...defaultMargins, bleed: 0 };
        const result = optimizeMasterSig(A5_PT, SRA3_SHEET, noBleedMargins);
        expect(result.recommended).not.toBeNull();
    });

    it('should report pageSizeMm correctly', () => {
        const result = optimizeMasterSig(A5_PT, SRA3_SHEET, defaultMargins);
        // A5 ≈ 148 × 210 mm
        expect(result.pageSizeMm.w).toBeCloseTo(148, 0);
        expect(result.pageSizeMm.h).toBeCloseTo(210, 0);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  SUGGEST MINIMUM SHEET
// ═══════════════════════════════════════════════════════════════════════════

describe('suggestMinimumSheet', () => {
    it('should suggest sheets for each sig size', () => {
        const result = suggestMinimumSheet(A5_PT, defaultMargins);
        expect(result.forSig16).not.toBeNull();
        expect(result.forSig8).toBeDefined();
        expect(result.forSig4).toBeDefined();
    });

    it('forSig16 should be larger than forSig8', () => {
        const result = suggestMinimumSheet(A5_PT, defaultMargins);
        if (result.forSig16) {
            const area16 = result.forSig16.width * result.forSig16.height;
            const area8 = result.forSig8.width * result.forSig8.height;
            expect(area16).toBeGreaterThan(area8);
        }
    });

    it('forSig4 should be smallest', () => {
        const result = suggestMinimumSheet(A5_PT, defaultMargins);
        const area4 = result.forSig4.width * result.forSig4.height;
        const area8 = result.forSig8.width * result.forSig8.height;
        expect(area4).toBeLessThanOrEqual(area8);
    });
});
