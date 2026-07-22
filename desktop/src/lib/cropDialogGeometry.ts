import type { CropRegionFrac } from './cropGeometry';
import { roundMm2 } from '../components/preprocess-tools/setPageBoxesUtils';

export interface BoxMm {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    width: number;
    height: number;
}

export type Frac = CropRegionFrac;

export interface RectMm {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Convert viewer fractions (top-left origin) into PDF millimetres (bottom-left origin). */
export function fracToRectMm(frac: Frac, pageBox: BoxMm): RectMm {
    const leftMm = frac.x0 * pageBox.width;
    const rightMm = (1 - frac.x1) * pageBox.width;
    const topMm = frac.y0 * pageBox.height;
    const bottomMm = (1 - frac.y1) * pageBox.height;
    return {
        x0: roundMm2(pageBox.x0 + leftMm),
        y0: roundMm2(pageBox.y0 + bottomMm),
        x1: roundMm2(pageBox.x1 - rightMm),
        y1: roundMm2(pageBox.y1 - topMm),
    };
}

/** Convert a PDF rectangle back to the viewer's top-left fractions. */
export function rectMmToFrac(rect: RectMm, pageBox: BoxMm): Frac {
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    return {
        x0: clamp((rect.x0 - pageBox.x0) / pageBox.width),
        y0: clamp((pageBox.y1 - rect.y1) / pageBox.height),
        x1: clamp((rect.x1 - pageBox.x0) / pageBox.width),
        y1: clamp((pageBox.y1 - rect.y0) / pageBox.height),
    };
}
