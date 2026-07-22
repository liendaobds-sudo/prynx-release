export interface CropRegionFrac {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type CropAdjustMode = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface CropRegionPixels {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Convert a drag performed in the current viewer pixels to zoom-independent
 * fractions. Returning null keeps tiny accidental clicks out of the crop list.
 */
export function cropDragToFrac(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  displayWidth: number,
  displayHeight: number,
  minSizePx = 5,
): CropRegionFrac | null {
  if (displayWidth <= 0 || displayHeight <= 0) return null;

  const x1 = Math.min(startX, endX);
  const y1 = Math.min(startY, endY);
  const x2 = Math.max(startX, endX);
  const y2 = Math.max(startY, endY);
  if (x2 - x1 < minSizePx || y2 - y1 < minSizePx) return null;

  const frac = {
    x0: clamp01(x1 / displayWidth),
    y0: clamp01(y1 / displayHeight),
    x1: clamp01(x2 / displayWidth),
    y1: clamp01(y2 / displayHeight),
  };
  return frac.x1 > frac.x0 && frac.y1 > frac.y0 ? frac : null;
}

/** Convert normalized crop geometry back to the current zoom's pixels. */
export function cropFracToPixels(
  frac: CropRegionFrac,
  displayWidth: number,
  displayHeight: number,
): CropRegionPixels {
  return {
    x: frac.x0 * displayWidth,
    y: frac.y0 * displayHeight,
    w: (frac.x1 - frac.x0) * displayWidth,
    h: (frac.y1 - frac.y0) * displayHeight,
  };
}

/** Move or resize a normalized crop region while keeping it inside the page. */
export function adjustCropRegion(
  original: CropRegionFrac,
  mode: CropAdjustMode,
  deltaX: number,
  deltaY: number,
  minWidth = 0.005,
  minHeight = 0.005,
): CropRegionFrac {
  if (mode === 'move') {
    const width = original.x1 - original.x0;
    const height = original.y1 - original.y0;
    const x0 = Math.max(0, Math.min(1 - width, original.x0 + deltaX));
    const y0 = Math.max(0, Math.min(1 - height, original.y0 + deltaY));
    return { x0, y0, x1: x0 + width, y1: y0 + height };
  }

  let { x0, y0, x1, y1 } = original;
  if (mode.includes('w')) x0 = clamp01(original.x0 + deltaX);
  if (mode.includes('e')) x1 = clamp01(original.x1 + deltaX);
  if (mode.includes('n')) y0 = clamp01(original.y0 + deltaY);
  if (mode.includes('s')) y1 = clamp01(original.y1 + deltaY);

  if (x1 - x0 < minWidth) {
    if (mode.includes('w')) x0 = x1 - minWidth;
    else x1 = x0 + minWidth;
  }
  if (y1 - y0 < minHeight) {
    if (mode.includes('n')) y0 = y1 - minHeight;
    else y1 = y0 + minHeight;
  }

  return { x0: clamp01(x0), y0: clamp01(y0), x1: clamp01(x1), y1: clamp01(y1) };
}
