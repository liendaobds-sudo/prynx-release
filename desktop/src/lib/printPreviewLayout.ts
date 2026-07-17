/**
 * Layout helpers for print PREVIEW — mirrors desktop/src-tauri/.../print_layout.rs
 * so the UI sheet preview matches what Rust will print.
 */

export type PageSubset = 'all' | 'odd' | 'even';
export type LayoutMode = 'size' | 'multiple' | 'booklet' | 'poster';

export function collectPageNumbers(
  start: number,
  end: number,
  pageCount: number,
  subset: PageSubset,
  reverse: boolean,
): number[] {
  const lo = Math.max(1, Math.min(start, pageCount));
  const hi = Math.max(1, Math.min(end, pageCount));
  if (lo > hi || pageCount <= 0) return [];
  let pages: number[] = [];
  for (let p = lo; p <= hi; p++) {
    if (subset === 'all' || (subset === 'odd' && p % 2 === 1) || (subset === 'even' && p % 2 === 0)) {
      pages.push(p);
    }
  }
  if (reverse) pages = pages.reverse();
  return pages;
}

export function multipageGrid(pagesPerSheet: number): [number, number] {
  switch (pagesPerSheet) {
    case 1: return [1, 1];
    case 2: return [2, 1];
    case 4: return [2, 2];
    case 6: return [3, 2];
    case 9: return [3, 3];
    case 16: return [4, 4];
    default: {
      const n = Math.max(1, pagesPerSheet);
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      return [cols, rows];
    }
  }
}

function bookletPaddedLen(n: number): number {
  if (n <= 0) return 0;
  return Math.ceil(n / 4) * 4;
}

/** Booklet sides as (left, right); 0 = blank. Same order as Rust. */
export function bookletSheetSides(srcPages: number[]): [number, number][] {
  const n = bookletPaddedLen(srcPages.length);
  if (n === 0) return [];
  const slots = new Array<number>(n).fill(0);
  srcPages.forEach((p, i) => { slots[i] = p; });
  const sheets = n / 4;
  const sides: [number, number][] = [];
  for (let s = 0; s < sheets; s++) {
    const fl = slots[n - 1 - 2 * s];
    const fr = slots[2 * s];
    const bl = slots[2 * s + 1];
    const br = slots[n - 2 - 2 * s];
    sides.push([fl, fr], [bl, br]);
  }
  return sides;
}

export type PreviewCell = {
  /** 1-based page, 0 = blank */
  page: number;
  /** fraction of printable area 0..1 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** poster: which tile of the page */
  posterTile?: { col: number; row: number; cols: number; rows: number };
};

export type PreviewSheet = {
  cells: PreviewCell[];
  label?: string;
};

export function buildPreviewSheets(opts: {
  layoutMode: LayoutMode;
  pages: number[];
  pagesPerSheet: number;
  posterCols: number;
  posterRows: number;
}): PreviewSheet[] {
  const { layoutMode, pages, pagesPerSheet, posterCols, posterRows } = opts;
  if (pages.length === 0) return [];

  if (layoutMode === 'size') {
    return pages.map((p) => ({
      cells: [{ page: p, x: 0, y: 0, w: 1, h: 1 }],
    }));
  }

  if (layoutMode === 'multiple') {
    const pps = Math.max(1, pagesPerSheet);
    const [cols, rows] = multipageGrid(pps);
    const sheets: PreviewSheet[] = [];
    for (let i = 0; i < pages.length; i += pps) {
      const chunk = pages.slice(i, i + pps);
      const cells: PreviewCell[] = chunk.map((p, idx) => {
        const c = idx % cols;
        const r = Math.floor(idx / cols);
        return {
          page: p,
          x: c / cols,
          y: r / rows,
          w: 1 / cols,
          h: 1 / rows,
        };
      });
      sheets.push({ cells });
    }
    return sheets;
  }

  if (layoutMode === 'booklet') {
    return bookletSheetSides(pages).map(([left, right], i) => ({
      cells: [
        { page: left, x: 0, y: 0, w: 0.5, h: 1 },
        { page: right, x: 0.5, y: 0, w: 0.5, h: 1 },
      ],
      label: i % 2 === 0 ? 'front' : 'back',
    }));
  }

  // poster
  const cols = Math.max(1, posterCols);
  const rows = Math.max(1, posterRows);
  const sheets: PreviewSheet[] = [];
  for (const p of pages) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        sheets.push({
          cells: [{
            page: p,
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            posterTile: { col: c, row: r, cols, rows },
          }],
        });
      }
    }
  }
  return sheets;
}
