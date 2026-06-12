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
