/**
 * VirtualMap Unit Tests
 * 
 * Tests the binding map generation for all 4 binding modes:
 * - continuous (Perfect Bound / Keo gÃ¡y)
 * - saddle (Saddle Stitch / Báº¥m kim)
 * - thread (Thread Sewn / KhÃ¢u chá»‰)
 * - cut_stacks (Half-Split / Cáº¯t Ä‘Ã´i rÃ¡p xáº¥p)
 */
import { describe, it, expect } from 'vitest';
import { generateBindingMap, VirtualSheet } from '../VirtualMap';
import { solvePageTransform, solveGeometry, GeometricContext } from '../GeometricSolver';

// â”€â”€â”€ Helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  CONTINUOUS (Perfect Bound / Keo gÃ¡y)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe('VirtualMap — Continuous', () => {
    it('8 pages: một cuốn/tờ giữ thứ tự tuần tự, không tự nhân đôi', () => {
        const { sheets } = generateBindingMap(8, 'continuous');
        expect(sheets).toHaveLength(2);
        expect(flattenSheet(sheets[0])).toEqual([0, 1, 2, 3]);
        expect(flattenSheet(sheets[1])).toEqual([4, 5, 6, 7]);
    });

    it('một cuốn/tờ pad đến bội số 4', () => {
        const { sheets } = generateBindingMap(5, 'continuous');
        expect(sheets).toHaveLength(2);
        expect(sheets[1].back.right.srcIndex).toBeNull();
    });

    it('should handle exactly 4 pages', () => {
        const { sheets } = generateBindingMap(4, 'continuous');
        expect(sheets).toHaveLength(1);
        expect(flattenSheet(sheets[0])).toEqual([0, 1, 2, 3]);
    });

    it('một cuốn/tờ phủ đủ trang và không trùng', () => {
        const { sheets } = generateBindingMap(16, 'continuous');
        const indices = allSrcIndices(sheets);
        expect(indices).toHaveLength(16);
        expect(new Set(indices).size).toBe(16);
    });

    it('cut_stack ghép đúng nửa đầu và nửa sau của cuốn', () => {
        const { sheets } = generateBindingMap(8, 'continuous', 16, 'end', 'cut_stack');
        expect(sheets).toHaveLength(2);
        expect(flattenSheet(sheets[0])).toEqual([0, 4, 5, 1]);
    });
});


// ═══════════════════════════════════════════════════════════════════════════
//  SADDLE (Bấm kim giữa)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Saddle', () => {
    it('8 trang giữ đúng cặp trang ghim lồng', () => {
        const { sheets } = generateBindingMap(8, 'saddle');
        expect(sheets).toHaveLength(2);
        expect(flattenSheet(sheets[0])).toEqual([7, 0, 1, 6]);
        expect(flattenSheet(sheets[1])).toEqual([5, 2, 3, 4]);
    });

    it('28 trang giữ đúng một cuốn 7 tờ', () => {
        const { sheets } = generateBindingMap(28, 'saddle');
        expect(sheets.map(flattenSheet)).toEqual([
            [27, 0, 1, 26],
            [25, 2, 3, 24],
            [23, 4, 5, 22],
            [21, 6, 7, 20],
            [19, 8, 9, 18],
            [17, 10, 11, 16],
            [15, 12, 13, 14],
        ]);
    });

    it('phủ đủ mỗi trang đúng một lần', () => {
        const indices = allSrcIndices(generateBindingMap(16, 'saddle').sheets);
        expect(indices).toHaveLength(16);
        expect(new Set(indices).size).toBe(16);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THREAD (Khâu chỉ / Chia tép)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Thread', () => {
    it('32 trang chia thành hai tép 16 trang', () => {
        const { sheets } = generateBindingMap(32, 'thread', 16);
        expect(sheets).toHaveLength(8);
        expect(sheets.slice(0, 4).every(sheet => sheet.signatureIndex === 1)).toBe(true);
        expect(sheets.slice(4).every(sheet => sheet.signatureIndex === 2)).toBe(true);
    });

    it('áp cặp ghim lồng độc lập bên trong mỗi tép', () => {
        const { sheets } = generateBindingMap(32, 'thread', 16);
        for (const sheet of sheets) {
            const offset = ((sheet.signatureIndex || 1) - 1) * 16;
            expect(sheet.front.left.logicalIndex + sheet.front.right.logicalIndex).toBe(2 * offset + 17);
            expect(sheet.back.left.logicalIndex + sheet.back.right.logicalIndex).toBe(2 * offset + 17);
        }
    });

    it('phủ đủ mỗi trang đúng một lần', () => {
        const indices = allSrcIndices(generateBindingMap(48, 'thread', 16).sheets);
        expect(indices).toHaveLength(48);
        expect(new Set(indices).size).toBe(48);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CUT_STACKS (Cắt đôi ráp xấp)
// ═══════════════════════════════════════════════════════════════════════════

describe('VirtualMap — Cut Stacks', () => {
    it('8 trang ghép đúng hai nửa cạnh nhau', () => {
        const { sheets } = generateBindingMap(8, 'cut_stacks');
        expect(sheets).toHaveLength(2);
        expect(flattenSheet(sheets[0])).toEqual([0, 4, 1, 5]);
        expect(flattenSheet(sheets[1])).toEqual([2, 6, 3, 7]);
    });

    it('6 trang pad nhưng không làm mất hoặc lặp trang thật', () => {
        const indices = allSrcIndices(generateBindingMap(6, 'cut_stacks').sheets);
        expect(indices).toHaveLength(6);
        expect(new Set(indices).size).toBe(6);
    });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  FLUSH_MOUNT (DÃ¡n Ä‘á»‘i lÆ°ng â€” In 1 máº·t, má»Ÿ pháº³ng 180Â°)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe('VirtualMap â€” Flush Mount', () => {
    it('should produce front-only sheets (back is all null)', () => {
        const { sheets } = generateBindingMap(6, 'flush_mount');
        for (const s of sheets) {
            // Back side must be entirely null
            expect(s.back.left.srcIndex).toBeNull();
            expect(s.back.right.srcIndex).toBeNull();
        }
    });

    it('should pad to nearest even (not multiple of 4)', () => {
        // 5 pages â†’ padded to 6 â†’ 3 sheets
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


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  BLANK PLACEMENT (vá»‹ trÃ­ trang tráº¯ng khi sá»‘ trang láº»)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

describe('VirtualMap â€” Blank placement', () => {
    it("'end' (default) puts blanks on the outer/cover sheet for saddle", () => {
        // 6 real pages padded to 8. End-placement â†’ logical 7 & 8 (cover sheet) blank.
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


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  GEOMETRY â€” Creep & Gutter (GeometricSolver)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const baseCtx: GeometricContext = {
    finalSheetWidth: 1000, finalSheetHeight: 500, scaleFactor: 1,
    actualDrawnWidth: 400, actualDrawnHeight: 480, needsScaleDown: false,
    suggestedScaleFactor: 1, margins: { top: 0, bottom: 0, left: 0, right: 0 }, isRotated: false,
};

describe('GeometricSolver â€” Creep', () => {
    it('applies creep to content in EVEN distribution (regression: was ignored)', () => {
        const t0L = solvePageTransform(baseCtx, true, true, 0, 4, 0, 3, true, 0, false, 0, 'even');
        const t2L = solvePageTransform(baseCtx, true, true, 2, 4, 0, 3, true, 0, false, 0, 'even');
        // Inner sheet (index 2) left page shifts toward spine (rightward) by thicknessÃ—index = 6
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

describe('GeometricSolver â€” Gutter', () => {
    it('honors gutter for THREAD but NOT for saddle (regression: thread was dropped)', () => {
        const thread = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, true, 10, false, 0, 'clustered', false);
        const saddle = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, true, 10, false, 0, 'clustered', true);
        // Thread left page pushed away from spine (âˆ’10); saddle untouched â†’ diff = 10
        expect(saddle.rawX - thread.rawX).toBeCloseTo(10);
    });

    it('honors gutter for continuous (perfect bound)', () => {
        const cont = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, false, 10, false, 0, 'clustered', false);
        const none = solvePageTransform(baseCtx, true, true, 0, 4, 0, 0, false, 0, false, 0, 'clustered', false);
        expect(none.rawX - cont.rawX).toBeCloseTo(10);
    });
});

describe('GeometricSolver â€” Fit overflow detection', () => {
    it('flags needsScaleDown when the sheet is smaller than the spread', () => {
        const settings: Parameters<typeof solveGeometry>[2] = {
            paperClassification: 'offset', foliosize: 4, paperThickness: 0,
            formsize: 'custom', customSheetWidth: 100, customSheetHeight: 100,
            bleed: 0, signatureMode: 'saddle', spreadDistribution: 'clustered',
            marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, markType: 'none',
            interleave: 'normal', scaleMode: 'fit', spawnNewTab: false,
        };
        const g = solveGeometry(400, 480, settings, {}, 2.83465);
        expect(g.needsScaleDown).toBe(true);
        expect(g.suggestedScaleFactor).toBeLessThan(1);
    });
});

