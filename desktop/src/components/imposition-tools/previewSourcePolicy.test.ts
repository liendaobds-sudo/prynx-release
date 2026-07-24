import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  materializePreviewViewerPdf,
  parsePreviewViewerState,
  resolvePreviewCellType,
  resolvePreviewPageCount,
  shouldDeferPreviewLayout,
} from './previewSourcePolicy';

describe('previewSourcePolicy', () => {
  it('parses duplicate thumbnail order and per-instance rotations', () => {
    expect(parsePreviewViewerState(JSON.stringify({ o: [1, 1, 2], r: [0, 90, 0] }))).toEqual({
      order: [1, 1, 2],
      rotations: [0, 90, 0],
    });
  });

  it('uses the live viewer count when thumbnail order is temporarily stale', () => {
    const staleOrder = JSON.stringify({ o: Array.from({ length: 28 }, (_, i) => i + 1) });

    expect(resolvePreviewPageCount(staleOrder, 45)).toBe(45);
    expect(resolvePreviewPageCount(staleOrder, 20)).toBe(28);
  });

  it('labels guillotine step-repeat cells from the live selected thumbnail', () => {
    expect(resolvePreviewCellType(undefined, 3, 'step_repeat', false)).toBe(3);
    expect(resolvePreviewCellType(0, 3, 'step_repeat', false)).toBe(3);
    expect(resolvePreviewCellType(2, 3, 'nup', false)).toBe(2);
    expect(resolvePreviewCellType(2, 3, 'step_repeat', true)).toBe(2);
  });

  it('waits for shape detection only for shape-aware die nesting', () => {
    expect(shouldDeferPreviewLayout(true, true)).toBe(true);
    expect(shouldDeferPreviewLayout(true, false)).toBe(false);
    expect(shouldDeferPreviewLayout(false, true)).toBe(false);
  });

  it('materializes duplicated thumbnails as additional PDF pages', async () => {
    const source = await PDFDocument.create();
    source.addPage([100, 200]);
    source.addPage([300, 400]);

    const bytes = await materializePreviewViewerPdf(
      await source.save(),
      { order: [1, 1, 2, -1], rotations: [0, 90, 0, 0] },
    );
    const output = await PDFDocument.load(bytes);

    expect(output.getPageCount()).toBe(4);
    expect(output.getPage(0).getSize()).toEqual({ width: 100, height: 200 });
    expect(output.getPage(1).getRotation().angle).toBe(90);
    expect(output.getPage(2).getSize()).toEqual({ width: 300, height: 400 });
    expect(output.getPage(3).getSize()).toEqual({ width: 100, height: 200 });
  });
});
