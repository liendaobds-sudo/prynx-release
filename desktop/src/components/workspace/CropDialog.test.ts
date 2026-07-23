import { describe, expect, it } from 'vitest';

import { fracToRectMm, rectMmToFrac, resizeCropFrac, type BoxMm, type Frac } from '../../lib/cropDialogGeometry';

const visibleCropBox: BoxMm = {
    x0: 10,
    y0: 20,
    x1: 110,
    y1: 70,
    width: 100,
    height: 50,
};

describe('CropDialog geometry', () => {
    it('maps viewer fractions against a non-zero CropBox origin', () => {
        const frac: Frac = { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 };

        expect(fracToRectMm(frac, visibleCropBox)).toEqual({
            x0: 20,
            y0: 30,
            x1: 100,
            y1: 60,
        });
    });

    it('round-trips a detected rectangle back to the preview overlay', () => {
        const frac: Frac = { x0: 0.12, y0: 0.18, x1: 0.87, y1: 0.82 };
        const rect = fracToRectMm(frac, visibleCropBox);

        expect(rectMmToFrac(rect, visibleCropBox)).toEqual(frac);
    });

    it('clamps a server rectangle to the visible preview', () => {
        expect(rectMmToFrac({ x0: 0, y0: 10, x1: 120, y1: 80 }, visibleCropBox)).toEqual({
            x0: 0,
            y0: 0,
            x1: 1,
            y1: 1,
        });
    });
    it('aligns the exact crop size against the complete page', () => {
        expect(resizeCropFrac(
            { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 },
            visibleCropBox,
            40,
            20,
            'right',
            'bottom',
        )).toEqual({ x0: 0.6, y0: 0.6, x1: 1, y1: 1 });
    });
});
