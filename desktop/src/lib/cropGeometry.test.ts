import { describe, expect, it } from 'vitest';

import { adjustCropRegion, cropDragToFrac, cropFracToPixels } from './cropGeometry';

describe('cropGeometry', () => {
  it('keeps the selected PDF region stable when zoom changes', () => {
    const frac = cropDragToFrac(100, 80, 500, 480, 1000, 800);
    expect(frac).toEqual({ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.6 });

    expect(cropFracToPixels(frac!, 2000, 1600)).toEqual({
      x: 200,
      y: 160,
      w: 800,
      h: 800,
    });
  });

  it('clamps drags that leave the page', () => {
    expect(cropDragToFrac(-20, -10, 120, 90, 100, 80)).toEqual({
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
    });
  });

  it('ignores accidental tiny drags', () => {
    expect(cropDragToFrac(10, 10, 13, 14, 100, 100)).toBeNull();
  });

  it('moves an existing region without changing its size', () => {
    const actual = adjustCropRegion(
      { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 }, 'move', 0.2, -0.1,
    );
    expectRegionClose(actual, { x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.5 });
  });

  it('clamps a moved region at page boundaries', () => {
    const actual = adjustCropRegion(
      { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 }, 'move', 0.5, 0.5,
    );
    expectRegionClose(actual, { x0: 0.8, y0: 0.8, x1: 1, y1: 1 });
  });

  it('resizes from every edge and enforces a minimum size', () => {
    const original = { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 };
    expectRegionClose(adjustCropRegion(original, 'nw', 0.1, 0.15), {
      x0: 0.3, y0: 0.35, x1: 0.8, y1: 0.8,
    });
    expectRegionClose(adjustCropRegion(original, 'se', -0.75, -0.75, 0.1, 0.1), {
      x0: 0.2, y0: 0.2, x1: 0.3, y1: 0.3,
    });
  });
});
const expectRegionClose = (
  actual: { x0: number; y0: number; x1: number; y1: number },
  expected: { x0: number; y0: number; x1: number; y1: number },
) => {
  (['x0', 'y0', 'x1', 'y1'] as const).forEach((key) => {
    expect(actual[key]).toBeCloseTo(expected[key], 10);
  });
};

