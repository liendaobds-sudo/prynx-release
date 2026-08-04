import { describe, expect, it } from 'vitest';

import { fracToDisplayRectMm, fracToRectMm, rectDisplaySizeMm, rectMmToFrac, resizeCropFrac, rotateCropFracForMaterializedPage, rotateDisplayBoxMm, restoreCropFracForViewer, type BoxMm, type Frac } from '../../lib/cropDialogGeometry';

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

    it.each([
        [0, { x0: 20, y0: 40, x1: 80, y1: 60 }],
        [90, { x0: 30, y0: 25, x1: 70, y1: 55 }],
        [180, { x0: 40, y0: 30, x1: 100, y1: 50 }],
        [270, { x0: 50, y0: 35, x1: 90, y1: 65 }],
    ] as const)('maps and round-trips viewer fractions for /Rotate=%i', (rotation, expected) => {
        const frac: Frac = { x0: 0.1, y0: 0.2, x1: 0.7, y1: 0.6 };
        const rect = fracToRectMm(frac, visibleCropBox, rotation);
        const restored = rectMmToFrac(rect, visibleCropBox, rotation);

        expect(rect).toEqual(expected);
        expect(restored.x0).toBeCloseTo(frac.x0, 10);
        expect(restored.y0).toBeCloseTo(frac.y0, 10);
        expect(restored.x1).toBeCloseTo(frac.x1, 10);
        expect(restored.y1).toBeCloseTo(frac.y1, 10);
    });

    it('maps the visible top half of a /Rotate=90 page to the raw left half', () => {
        const rawBox: BoxMm = { x0: 0, y0: 0, x1: 200, y1: 100, width: 200, height: 100 };
        const frac = { x0: 0, y0: 0, x1: 1, y1: 0.5 };

        expect(fracToRectMm(frac, rawBox, 90)).toEqual({
            x0: 0, y0: 0, x1: 100, y1: 100,
        });
        expect(fracToDisplayRectMm(frac, rawBox, 90)).toEqual({
            x0: 0, y0: 0, x1: 100, y1: 100,
        });
    });

    it('keeps exact size and alignment in the displayed orientation', () => {
        const resized = resizeCropFrac(
            { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 },
            visibleCropBox,
            20,
            40,
            'right',
            'bottom',
            90,
        );
        const rect = fracToRectMm(resized, visibleCropBox, 90);

        expect(resized).toEqual({ x0: 0.6, y0: 0.6, x1: 1, y1: 1 });
        expect(rectDisplaySizeMm(rect, 90)).toEqual({ width: 20, height: 40 });
    });

    it.each([0, 90, 180, 270])(
        'preserves the raw crop for every intrinsic rotation with viewer rotation %i',
        (viewerRotation) => {
            const sourceFrac: Frac = { x0: 0.1, y0: 0.2, x1: 0.7, y1: 0.6 };
            for (const intrinsicRotation of [0, 90, 180, 270]) {
                const expectedRaw = fracToRectMm(sourceFrac, visibleCropBox, intrinsicRotation);
                const materializedFrac = rotateCropFracForMaterializedPage(sourceFrac, viewerRotation);
                const actualRaw = fracToRectMm(
                    materializedFrac,
                    visibleCropBox,
                    intrinsicRotation + viewerRotation,
                );
                expect(actualRaw).toEqual(expectedRaw);
                const restored = restoreCropFracForViewer(materializedFrac, viewerRotation);
                expect(restored.x0).toBeCloseTo(sourceFrac.x0, 12);
                expect(restored.y0).toBeCloseTo(sourceFrac.y0, 12);
                expect(restored.x1).toBeCloseTo(sourceFrac.x1, 12);
                expect(restored.y1).toBeCloseTo(sourceFrac.y1, 12);
            }
        },
    );

    it('swaps the initial displayed page size when the viewer rotation is perpendicular', () => {
        expect(rotateDisplayBoxMm(visibleCropBox, 90)).toEqual({
            x0: 10,
            y0: 20,
            x1: 60,
            y1: 120,
            width: 50,
            height: 100,
        });
        expect(rotateDisplayBoxMm(visibleCropBox, 180)).toEqual(visibleCropBox);
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
