import { describe, expect, it } from 'vitest';

import {
  accumulateTacTotals,
  buildPlateRgba,
  buildTacHeatmapRgba,
} from './outputPreviewPixels';


describe('output preview pixel parity', () => {
  it('dựng đúng RGBA của kẽm từ màu và alpha', () => {
    const totals = new Uint16Array(3);
    const rgba = buildPlateRgba(
      new Uint8ClampedArray([0, 128, 255]),
      [10, 20, 30],
      totals,
    );

    expect(Array.from(rgba)).toEqual([
      10, 20, 30, 0,
      10, 20, 30, 128,
      10, 20, 30, 255,
    ]);
    expect(Array.from(totals)).toEqual([0, 50, 100]);
  });

  it('cộng TAC theo đúng phép làm tròn của component cũ', () => {
    const totals = new Uint16Array(3);
    accumulateTacTotals(totals, new Uint8ClampedArray([0, 128, 255]));
    accumulateTacTotals(totals, new Uint8ClampedArray([255, 128, 0]));

    expect(Array.from(totals)).toEqual([100, 100, 100]);
  });

  it('giữ đúng gradient vàng sang đỏ và điều kiện lớn hơn ngưỡng', () => {
    const rgba = buildTacHeatmapRgba(new Uint16Array([80, 100, 180]), 80);

    expect(Array.from(rgba)).toEqual([
      0, 0, 0, 0,
      255, 204, 0, 140,
      255, 0, 0, 220,
    ]);
  });

  it('từ chối mảng alpha sai kích thước thay vì dựng ảnh lỗi', () => {
    expect(() => accumulateTacTotals(
      new Uint16Array(2),
      new Uint8ClampedArray(1),
    )).toThrow('không khớp');
  });
});
