import { describe, expect, it } from 'vitest';
import { computeSpreadGrid } from '../../lib/imposerEngine/InstructionSerializer';
import { computeDigitalPreviewGrid } from './SheetViewerDialog';

const MM_TO_PT = 2.83465;

describe('SheetViewerDialog — parity lưới In nhanh', () => {
    it('dùng marginBottom để preview 1×1 đúng như kế hoạch xuất, thay vì 1×2', () => {
        const spreadWpt = 200 * MM_TO_PT;
        const spreadHpt = 100 * MM_TO_PT;

        const missingBottomMargin = computeSpreadGrid(
            spreadWpt, spreadHpt,
            220 * MM_TO_PT, 230 * MM_TO_PT,
            0, 0,
            5 * MM_TO_PT, 5 * MM_TO_PT, 10 * MM_TO_PT, 0,
        );
        const exportGrid = computeSpreadGrid(
            spreadWpt, spreadHpt,
            220 * MM_TO_PT, 230 * MM_TO_PT,
            0, 0,
            5 * MM_TO_PT, 5 * MM_TO_PT, 10 * MM_TO_PT, 0, 25 * MM_TO_PT,
        );
        const previewGrid = computeDigitalPreviewGrid({
            spreadWpt,
            spreadHpt,
            sheetWmm: 220,
            sheetHmm: 230,
            gapX: 0,
            gapY: 0,
            marginLeft: 5,
            marginRight: 5,
            marginTop: 10,
            marginBottom: 25,
            gripperMargin: 0,
        });

        expect({ cols: missingBottomMargin.cols, rows: missingBottomMargin.rows }).toEqual({ cols: 1, rows: 2 });
        expect({ cols: exportGrid.cols, rows: exportGrid.rows }).toEqual({ cols: 1, rows: 1 });
        expect({ cols: previewGrid.cols, rows: previewGrid.rows }).toEqual({ cols: 1, rows: 1 });
        expect(previewGrid.cellPos(0, 0)).toEqual(exportGrid.cellPos(0, 0));
    });
});
