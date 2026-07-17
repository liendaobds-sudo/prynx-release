import { describe, it, expect } from 'vitest';
import {
  collectPageNumbers,
  multipageGrid,
  bookletSheetSides,
  buildPreviewSheets,
} from './printPreviewLayout';

describe('printPreviewLayout', () => {
  it('collects odd/even reverse', () => {
    expect(collectPageNumbers(1, 5, 5, 'odd', false)).toEqual([1, 3, 5]);
    expect(collectPageNumbers(1, 5, 5, 'even', true)).toEqual([4, 2]);
  });

  it('booklet 8 pages matches Rust order', () => {
    expect(bookletSheetSides([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([
      [8, 1], [2, 7], [6, 3], [4, 5],
    ]);
  });

  it('multiple 4-up builds one sheet of 4 cells', () => {
    const sheets = buildPreviewSheets({
      layoutMode: 'multiple',
      pages: [1, 2, 3, 4],
      pagesPerSheet: 4,
      posterCols: 2,
      posterRows: 2,
    });
    expect(sheets).toHaveLength(1);
    expect(sheets[0].cells).toHaveLength(4);
    expect(multipageGrid(4)).toEqual([2, 2]);
  });

  it('poster 2x2 yields 4 tiles per page', () => {
    const sheets = buildPreviewSheets({
      layoutMode: 'poster',
      pages: [1],
      pagesPerSheet: 2,
      posterCols: 2,
      posterRows: 2,
    });
    expect(sheets).toHaveLength(4);
    expect(sheets[0].cells[0].posterTile).toEqual({ col: 0, row: 0, cols: 2, rows: 2 });
  });
});
