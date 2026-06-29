// Regression tests cho preprocessEngine (File Prep client-side, pdf-lib).
// Ground-truth: mỗi trang có width DUY NHẤT (100+i) → đọc lại width xác minh.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import {
  parseRule,
  serializeRule,
  applyRule,
  reversePages,
  shuffleEvenOdd,
  executeShuffle,
} from './ShuffleEngine';
import { parseRanges, splitPdf } from './PdfSplitter';
import { resizePages } from './PageResizer';
import { mergePdf } from './PdfMerger';

const MM_TO_POINTS = 2.83465;

async function makePdf(n: number, baseW = 100, h = 200): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([baseW + i, h]);
    // Vẽ 1 hình nhỏ để trang CÓ content stream (/Contents) — pdf-lib embedPages
    // (dùng trong resize) yêu cầu trang có Contents; PDF thật luôn có nội dung.
    p.drawRectangle({ x: 1, y: 1, width: 4, height: 4 });
  }
  return doc.save();
}

async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getWidth() * 100) / 100);
}

// ─── ShuffleEngine: parser ────────────────────────────────────────────────

describe('ShuffleEngine — parseRule', () => {
  it('parse số + cờ xoay + blank', () => {
    const r = parseRule('5 4 3 6 7* 2> 1< X');
    expect(r).toEqual([
      { pageIndex: 5, rotation: 0 },
      { pageIndex: 4, rotation: 0 },
      { pageIndex: 3, rotation: 0 },
      { pageIndex: 6, rotation: 0 },
      { pageIndex: 7, rotation: 180 },
      { pageIndex: 2, rotation: 90 },
      { pageIndex: 1, rotation: 270 },
      { pageIndex: 0, rotation: 0 }, // X → blank
    ]);
  });

  it('token không hợp lệ → blank', () => {
    const r = parseRule('abc 2');
    expect(r[0]).toEqual({ pageIndex: 0, rotation: 0 });
    expect(r[1]).toEqual({ pageIndex: 2, rotation: 0 });
  });

  it('serializeRule là nghịch đảo của parseRule', () => {
    const txt = '4 1 2 3*';
    expect(serializeRule(parseRule(txt))).toBe(txt);
  });
});

// ─── ShuffleEngine: applyRule ─────────────────────────────────────────────

describe('ShuffleEngine — applyRule', () => {
  it('normal: mỗi nhóm đảo độc lập theo rule', () => {
    // rule "2 1" groupSize 2 trên 4 trang → [1,0,3,2] (0-based srcPage)
    const m = applyRule(parseRule('2 1'), 4, 2, 'normal');
    expect(m.map((x) => x.srcPage)).toEqual([1, 0, 3, 2]);
  });

  it('normal: pad nhóm cuối bằng blank (srcPage -1)', () => {
    // 3 trang, groupSize 2, rule "1 2" → nhóm2 chỉ có trang idx2, slot còn lại blank
    const m = applyRule(parseRule('1 2'), 3, 2, 'normal');
    expect(m.map((x) => x.srcPage)).toEqual([0, 1, 2, -1]);
  });

  it('cut_stack_1side: 1 2 trên 8 trang', () => {
    // slotsPerSheet=2, totalSheets=4 → sheet s, slot k: src = s + (page-1)*4
    const m = applyRule(parseRule('1 2'), 8, 2, 'cut_stack_1side');
    expect(m.map((x) => x.srcPage)).toEqual([0, 4, 1, 5, 2, 6, 3, 7]);
  });
});

// ─── ShuffleEngine: special + executor ────────────────────────────────────

describe('ShuffleEngine — special shuffles', () => {
  it('reversePages', () => {
    expect(reversePages(4).map((x) => x.srcPage)).toEqual([3, 2, 1, 0]);
  });

  it('odd_first / even_first', () => {
    expect(shuffleEvenOdd(5, 'odd_first').map((x) => x.srcPage)).toEqual([0, 2, 4, 1, 3]);
    expect(shuffleEvenOdd(5, 'even_first').map((x) => x.srcPage)).toEqual([1, 3, 0, 2, 4]);
  });

  it('interleave / reverse_even', () => {
    expect(shuffleEvenOdd(4, 'interleave').map((x) => x.srcPage)).toEqual([0, 1, 2, 3]);
    expect(shuffleEvenOdd(4, 'reverse_even').map((x) => x.srcPage)).toEqual([0, 2, 3, 1]);
  });
});

describe('ShuffleEngine — executeShuffle', () => {
  it('reverse áp lên PDF thật', async () => {
    const src = await PDFDocument.load(await makePdf(4, 100));
    const out = await executeShuffle(src, reversePages(4));
    expect(await widths(out)).toEqual([103, 102, 101, 100]);
  });

  it('blank (srcPage -1) chèn trang trống bằng khổ trang đầu', async () => {
    const src = await PDFDocument.load(await makePdf(3, 100));
    const out = await executeShuffle(src, [
      { srcPage: 2, rotation: 0 },
      { srcPage: -1, rotation: 0 },
      { srcPage: 0, rotation: 0 },
    ]);
    // blank dùng khổ trang đầu (width 100)
    expect(await widths(out)).toEqual([102, 100, 100]);
  });
});

// ─── PdfSplitter ──────────────────────────────────────────────────────────

describe('PdfSplitter — parseRanges', () => {
  it('dải hỗn hợp', () => {
    expect(parseRanges('1-4, 7, 10-12', 20)).toEqual([[1, 4], [7, 7], [10, 12]]);
  });
  it('dải mở "10-" → tới maxPage', () => {
    expect(parseRanges('10-', 12)).toEqual([[10, 12]]);
  });
  it('clamp + bỏ phần không hợp lệ', () => {
    expect(parseRanges('3-99, 0, abc, 5', 10)).toEqual([[3, 10], [5, 5]]);
  });
});

describe('PdfSplitter — splitPdf', () => {
  it('by_range', async () => {
    const res = await splitPdf(await makePdf(8, 100), 'by_range', { ranges: '1-4, 5-8' }, 'b');
    const ws = await Promise.all(res.map((r) => widths(r.bytes)));
    expect(ws).toEqual([[100, 101, 102, 103], [104, 105, 106, 107]]);
  });

  it('by_count', async () => {
    const res = await splitPdf(await makePdf(8, 100), 'by_count', { pagesPerFile: 3 }, 'b');
    const ws = await Promise.all(res.map((r) => widths(r.bytes)));
    expect(ws).toEqual([[100, 101, 102], [103, 104, 105], [106, 107]]);
  });

  it('extract_pages', async () => {
    const res = await splitPdf(await makePdf(8, 100), 'extract_pages', { pageList: [1, 3, 5] }, 'b');
    expect(await widths(res[0].bytes)).toEqual([100, 102, 104]);
  });
});

// ─── PageResizer ──────────────────────────────────────────────────────────

describe('PageResizer — resizePages', () => {
  const target = Math.round(210 * MM_TO_POINTS * 100) / 100;

  it('all → đúng khổ A4, giữ số trang', async () => {
    const out = await resizePages(await makePdf(8, 100), {
      targetW: 210, targetH: 297, scaleMode: 'fit', applyTo: 'all',
    });
    const w = await widths(out);
    expect(w.length).toBe(8);
    expect(Math.abs(w[0] - target)).toBeLessThan(1);
  });

  it('odd → chỉ resize trang lẻ (idx chẵn)', async () => {
    const out = await resizePages(await makePdf(4, 100), {
      targetW: 210, targetH: 297, scaleMode: 'fit', applyTo: 'odd',
    });
    const w = await widths(out);
    expect(Math.abs(w[0] - target)).toBeLessThan(1); // trang 1 (lẻ) resize
    expect(Math.abs(w[1] - 101)).toBeLessThan(1);     // trang 2 (chẵn) giữ nguyên
    expect(Math.abs(w[2] - target)).toBeLessThan(1); // trang 3 (lẻ) resize
  });

  it('danh sách trang cụ thể [2,4]', async () => {
    const out = await resizePages(await makePdf(4, 100), {
      targetW: 210, targetH: 297, scaleMode: 'fit', applyTo: [2, 4],
    });
    const w = await widths(out);
    expect(Math.abs(w[0] - 100)).toBeLessThan(1);     // idx0 giữ
    expect(Math.abs(w[1] - target)).toBeLessThan(1); // idx1 (trang 2) resize
    expect(Math.abs(w[3] - target)).toBeLessThan(1); // idx3 (trang 4) resize
  });
});

// ─── PdfMerger (PDF-only, không chạm imageNormalizer) ──────────────────────

describe('PdfMerger — mergePdf', () => {
  it('merge_files: base + 1 file, giữ thứ tự', async () => {
    const base = await makePdf(2, 100); // 100,101
    const extra = new File([await makePdf(2, 200)], 'b.pdf', { type: 'application/pdf' });
    const out = await mergePdf(base, { mode: 'merge_files', filesToMerge: [extra] } as any);
    expect(await widths(out)).toEqual([100, 101, 200, 201]);
  });

  it('interleave: xen kẽ odd/even', async () => {
    const oddFile = new File([await makePdf(3, 100)], 'odd.pdf', { type: 'application/pdf' });
    const evenFile = new File([await makePdf(2, 200)], 'even.pdf', { type: 'application/pdf' });
    const out = await mergePdf(null, { mode: 'interleave', oddFile, evenFile } as any);
    expect(await widths(out)).toEqual([100, 200, 101, 201, 102]);
  });
});
