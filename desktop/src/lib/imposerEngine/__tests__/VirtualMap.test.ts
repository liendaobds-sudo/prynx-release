/**
 * VirtualMap Unit Tests
 * 
 * Tests the binding map generation for all 4 binding modes:
 * - continuous (Perfect Bound / Keo gáy)
 * - saddle (Saddle Stitch / Bấm kim)
 * - thread (Thread Sewn / Khâu chỉ)
 * - cut_stacks (Half-Split / Cắt đôi ráp xấp)
 */
import { describe, it, expect } from 'vitest';
import { generateBindingMap, VirtualSheet } from '../VirtualMap';
import { solvePageTransform, solveGeometry, GeometricContext } from '../GeometricSolver';

// ─── Helper ─────────────────────────────────────────────────────────────────

/** Flatten a sheet into the 4 logical page indices for easy assertion */
function flattenSheet(s: VirtualSheet): (number | null)[] {
    return [
        s.front.left.srcIndex,
        s.front.right.srcIndex,
        s.back.left.srcIndex,
        s.back.right.srcIndex,
    ];
}

/** Collect all non-null srcIndex values across all sheets */
function allSrcIndices(sheets: VirtualSheet[]): number[] {
    return sheets.flatMap(s => flattenSheet(s).filter((v): v is number => v !== null));
}


// ═══════════════════════════════════════════════════════════════════════════
//  CONTINUOUS (Perfect Bound / Keo gáy)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Continuous', () => {
    it('should map 8 pages into 2 sheets in reading order', () => {
        const { sheets } = generateBindingMap(8, 'continuous');
        expect(sheets).toHaveLength(2);
        // Sheet 0: front=[p1,p2], back=[p3,p4]
        expect(flattenSheet(sheets[0])).toEqual([0, 1, 2, 3]);
        // Sheet 1: front=[p5,p6], back=[p7,p8]
        expect(flattenSheet(sheets[1])).toEqual([4, 5, 6, 7]);
    });

    it('should pad to nearest multiple of 4', () => {
        const { sheets } = generateBindingMap(5, 'continuous');
        // 5 pages → padded to 8 → 2 sheets
        expect(sheets).toHaveLength(2);
        // Last 3 pages are blank
        expect(sheets[1].back.right.srcIndex).toBeNull(); // page 8 = blank
    });

    it('should handle exactly 4 pages (minimum case)', () => {
        const { sheets } = generateBindingMap(4, 'continuous');
        expect(sheets).toHaveLength(1);
        expect(flattenSheet(sheets[0])).toEqual([0, 1, 2, 3]);
    });

    it('should cover all source pages without duplicates', () => {
        const { sheets } = generateBindingMap(16, 'continuous');
        const indices = allSrcIndices(sheets);
        // All 16 pages present, no duplicates
        expect(new Set(indices).size).toBe(16);
        expect(indices).toHaveLength(16);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  SADDLE (Bấm kim giữa)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Saddle', () => {
    it('should produce correct saddle pairing for 8 pages', () => {
        const { sheets } = generateBindingMap(8, 'saddle');
        expect(sheets).toHaveLength(2);
        // Saddle 8p: Sheet0 Front = [p8, p1], Back = [p2, p7]
        //            Sheet1 Front = [p6, p3], Back = [p4, p5]
        expect(flattenSheet(sheets[0])).toEqual([7, 0, 1, 6]); // 0-based
        expect(flattenSheet(sheets[1])).toEqual([5, 2, 3, 4]);
    });

    it('pair sum rule: left + right logical indices = N+1', () => {
        const N = 16;
        const { sheets } = generateBindingMap(N, 'saddle');
        for (const s of sheets) {
            // Front pair
            expect(s.front.left.logicalIndex + s.front.right.logicalIndex).toBe(N + 1);
            // Back pair
            expect(s.back.left.logicalIndex + s.back.right.logicalIndex).toBe(N + 1);
        }
    });

    it('should handle padding for saddle (non-multiple of 4)', () => {
        const { sheets } = generateBindingMap(6, 'saddle');
        // 6 → padded to 8 → 2 sheets
        expect(sheets).toHaveLength(2);
        // Pages 7 and 8 are blank (srcIndex null)
        const indices = allSrcIndices(sheets);
        expect(indices).toHaveLength(6); // only 6 real pages
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  THREAD (Khâu chỉ / Chia tép)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Thread', () => {
    it('should split 32 pages into 2 signatures of 16', () => {
        const { sheets } = generateBindingMap(32, 'thread', 16);
        expect(sheets).toHaveLength(8); // 32 / 4 = 8 sheets total
        // First 4 sheets belong to sig 1
        expect(sheets.slice(0, 4).every(s => s.signatureIndex === 1)).toBe(true);
        // Last 4 sheets belong to sig 2
        expect(sheets.slice(4, 8).every(s => s.signatureIndex === 2)).toBe(true);
    });

    it('should apply saddle pairing within each signature', () => {
        const { sheets } = generateBindingMap(16, 'thread', 16);
        const N = 16;
        for (const s of sheets) {
            // Within-sig saddle: front.left + front.right = N+1 (relative to sig offset)
            expect(s.front.left.logicalIndex + s.front.right.logicalIndex).toBe(N + 1);
            expect(s.back.left.logicalIndex + s.back.right.logicalIndex).toBe(N + 1);
        }
    });

    it('should merge trailing 4-page remainder into previous sig', () => {
        // 20 pages, foliosize=16: 16 + 4 remaining
        // But 4 is too thin → should merge into 20 pages = 1 sig of 20
        const { sheets, report } = generateBindingMap(20, 'thread', 16);
        expect(sheets).toHaveLength(5); // 20 padded = 20, 20/4 = 5 sheets
        expect(report).toContain('gộp');
    });

    it('should not merge if remainder > 4', () => {
        // 24 pages, foliosize=16: 16 + 8 → keep both
        const { sheets } = generateBindingMap(24, 'thread', 16);
        expect(sheets).toHaveLength(6); // 24/4 = 6 sheets
        // Sig 1 = 4 sheets (16p), Sig 2 = 2 sheets (8p)
        expect(sheets.filter(s => s.signatureIndex === 1)).toHaveLength(4);
        expect(sheets.filter(s => s.signatureIndex === 2)).toHaveLength(2);
    });

    it('should cover all source pages without duplicates', () => {
        const { sheets } = generateBindingMap(48, 'thread', 16);
        const indices = allSrcIndices(sheets);
        expect(new Set(indices).size).toBe(48);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  CUT_STACKS (Cắt đôi ráp xấp)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Cut Stacks', () => {
    it('should split 8 pages: each sheet has 2 halves side by side', () => {
        const { sheets } = generateBindingMap(8, 'cut_stacks');
        expect(sheets).toHaveLength(2);
        // Half = 4. Sheet 0: front=[p1, p5], back=[p2, p6]
        expect(sheets[0].front.left.srcIndex).toBe(0);  // p1
        expect(sheets[0].front.right.srcIndex).toBe(4);  // p5
        expect(sheets[0].back.left.srcIndex).toBe(1);   // p2
        expect(sheets[0].back.right.srcIndex).toBe(5);   // p6
    });

    it('should handle padding correctly for cut_stacks', () => {
        const { sheets } = generateBindingMap(6, 'cut_stacks');
        // 6 → padded to 8
        expect(sheets).toHaveLength(2);
        const indices = allSrcIndices(sheets);
        expect(indices).toHaveLength(6);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  FLUSH_MOUNT (Dán đối lưng — In 1 mặt, mở phẳng 180°)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Flush Mount', () => {
    it('should produce front-only sheets (back is all null)', () => {
        const { sheets } = generateBindingMap(6, 'flush_mount');
        for (const s of sheets) {
            // Back side must be entirely null
            expect(s.back.left.srcIndex).toBeNull();
            expect(s.back.right.srcIndex).toBeNull();
        }
    });

    it('should pad to nearest even (not multiple of 4)', () => {
        // 5 pages → padded to 6 → 3 sheets
        const { sheets } = generateBindingMap(5, 'flush_mount');
        expect(sheets).toHaveLength(3); // ceil(5/2)*2 = 6, 6/2 = 3
        // Last page on last sheet should be blank
        expect(sheets[2].front.right.srcIndex).toBeNull();
    });

    it('should map pages sequentially in pairs (1-2, 3-4, ...)', () => {
        const { sheets } = generateBindingMap(8, 'flush_mount');
        expect(sheets).toHaveLength(4);
        // Sheet 0: front = [p1, p2]
        expect(sheets[0].front.left.srcIndex).toBe(0);
        expect(sheets[0].front.right.srcIndex).toBe(1);
        // Sheet 1: front = [p3, p4]
        expect(sheets[1].front.left.srcIndex).toBe(2);
        expect(sheets[1].front.right.srcIndex).toBe(3);
        // Sheet 2: front = [p5, p6]
        expect(sheets[2].front.left.srcIndex).toBe(4);
        expect(sheets[2].front.right.srcIndex).toBe(5);
        // Sheet 3: front = [p7, p8]
        expect(sheets[3].front.left.srcIndex).toBe(6);
        expect(sheets[3].front.right.srcIndex).toBe(7);
    });

    it('should handle exactly 2 pages (minimum case)', () => {
        const { sheets } = generateBindingMap(2, 'flush_mount');
        expect(sheets).toHaveLength(1);
        expect(sheets[0].front.left.srcIndex).toBe(0);
        expect(sheets[0].front.right.srcIndex).toBe(1);
    });

    it('should cover all source pages without duplicates', () => {
        const { sheets } = generateBindingMap(10, 'flush_mount');
        const indices = allSrcIndices(sheets);
        expect(new Set(indices).size).toBe(10);
        expect(indices).toHaveLength(10);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  BLANK PLACEMENT (vị trí trang trắng khi số trang lẻ)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Blank placement', () => {
    it("'end' (default) puts blanks on the outer/cover sheet for saddle", () => {
        // 6 real pages padded to 8. End-placement → logical 7 & 8 (cover sheet) blank.
        const { sheets } = generateBindingMap(6, 'saddle', 16, 'end');
        expect(flattenSheet(sheets[0])).toEqual([null, 0, 1, null]); // cover sheet has blanks
        expect(flattenSheet(sheets[1])).toEqual([5, 2, 3, 4]);        // inner sheet full
    });

    it("'center' keeps cover full and pushes blanks to the innermost sheet", () => {
        const { sheets } = generateBindingMap(6, 'saddle', 16, 'center');
        expect(flattenSheet(sheets[0])).toEqual([5, 0, 1, 4]); // cover sheet fully printed
        expect(flattenSheet(sheets[1])).toEqual([3, 2, null, null]); // blanks land in the center
    });

    it("'center' still covers every source page exactly once", () => {
        const { sheets } = generateBindingMap(10, 'saddle', 16, 'center');
        const indices = allSrcIndices(sheets);
        expect(new Set(indices).size).toBe(10);
        expect(indices).toHaveLength(10);
    });

    it('default arg equals explicit end', () => {
        const a = generateBindingMap(7, 'saddle');
        const b = generateBindingMap(7, 'saddle', 16, 'end');
        expect(a.sheets.map(flattenSheet)).toEqual(b.sheets.map(flattenSheet));
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  GEOMETRY — Creep & Gutter (GeometricSolver)
// ═══════════════════════════════════════════════════════════════════════════

const baseCtx: GeometricContext = {
    finalSheetWidth: 1000, finalSheetHeight: 500, scaleFactor: 1,
    actualDrawnWidth: 400, actualDrawnHeight: 480, needsScaleDown: false,
    suggestedScaleFactor: 1, margins: { top: 0, bottom: 0, left: 0, right: 0 }, isRotated: false,
};

describe('GeometricSolver — Creep', () => {
    it('applies creep to content in EVEN distribution (regression: was ignored)', () => {
        const t0L = solvePageTransform(baseCtx, true, true, 0, 4, 0, 3, true, 0, false, 0, 'even');
        const t2L = solvePageTransform(baseCtx, true, true, 2, 4, 0, 3, true, 0, false, 0, 'even');
        // Inner sheet (index 2) left page shifts toward spine (rightward) by thickness×index = 6
        expect(t2L.rawX - t0L.rawX).toBeCloseTo(6);
        // Right page shifts leftward by 6
        const t0R = solvePageTransform(baseCtx, false, true, 0, 4, 0, 3, true, 0, false, 0, 'even');
        const t2R = solvePageTransform(baseCtx, false, true, 2, 4, 0, 3, true, 0, false, 0, 'even');
        expect(t2R.rawX - t0R.rawX).toBeCloseTo(-6);
        // Trim marks stay FIXED (creep moves content only)
        expect(t2L.trimBox.x).toBeCloseTo(t0L.trimBox.x);
    });

    it('matches legacy clustered creep formula', () => {
        const t0 = solvePageTransform(baseCtx, true, true, 0, 4, 0, 3, true, 0, false, 0, 'clustered');
        const t2 = solvePageTransform(baseCtx, true, true, 2, 4, 0, 3, true, 0, false, 0, 'clustered');
        expect(t2.rawX - t0.rawX).toBeCloseTo(6);
    });
});

describe('GeometricSolver — Gutter', () => {
    it('honors gutter for THREAD but NOT for saddle (regression: thread was dropped)', () => {
        const thread = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, true, 10, false, 0, 'clustered', false);
        const saddle = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, true, 10, false, 0, 'clustered', true);
        // Thread left page pushed away from spine (−10); saddle untouched → diff = 10
        expect(saddle.rawX - thread.rawX).toBeCloseTo(10);
    });

    it('honors gutter for continuous (perfect bound)', () => {
        const cont = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, false, 10, false, 0, 'clustered', false);
        const none = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, false, 0, false, 0, 'clustered', false);
        expect(none.rawX - cont.rawX).toBeCloseTo(10);
    });
});

describe('GeometricSolver — Fit overflow detection', () => {
    it('flags needsScaleDown when the sheet is smaller than the spread', () => {
        const settings: any = {
            formsize: 'custom', customSheetWidth: 100, customSheetHeight: 100,
            bleed: 0, signatureMode: 'saddle', spreadDistribution: 'clustered',
            marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, markType: 'none',
        };
        const g = solveGeometry(400, 480, settings, {}, 2.83465);
        expect(g.needsScaleDown).toBe(true);
        expect(g.suggestedScaleFactor).toBeLessThan(1);
    });
});

