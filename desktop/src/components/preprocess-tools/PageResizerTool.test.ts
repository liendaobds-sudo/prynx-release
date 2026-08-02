import { describe, expect, it } from 'vitest';

import { applyPageSizeMode, shouldShowBackgroundFill } from './PageResizerTool';


describe('PageResizerTool background-fill visibility', () => {
    it.each([true, false, undefined])(
        'shows gap background independently from legacy auto-trim=%s',
        (autoTrimBefore) => {
            expect(shouldShowBackgroundFill(autoTrimBefore, 'fit')).toBe(true);
            expect(shouldShowBackgroundFill(autoTrimBefore, 'center_no_scale')).toBe(true);
        },
    );

    it.each([true, false, undefined])(
        'hides background for fill/stretch with legacy auto-trim=%s',
        (autoTrimBefore) => {
            expect(shouldShowBackgroundFill(autoTrimBefore, 'fill')).toBe(false);
            expect(shouldShowBackgroundFill(autoTrimBefore, 'stretch')).toBe(false);
        },
    );

    it.each(['fixed_width', 'fixed_height'] as const)(
        'hides gap background when page size mode is %s',
        (pageSizeMode) => {
            expect(shouldShowBackgroundFill(undefined, 'fit', pageSizeMode)).toBe(false);
            expect(
                shouldShowBackgroundFill(undefined, 'center_no_scale', pageSizeMode),
            ).toBe(false);
        },
    );

    it('forces fit and custom preset while preserving entered dimensions', () => {
        const base = {
            sizePresetId: 'A4',
            targetW: 210,
            targetH: 297,
            pageSizeMode: 'fixed' as const,
            scaleMode: 'stretch' as const,
            applyTo: 'all' as const,
            applyToStr: 'all',
        };

        const locked = applyPageSizeMode(base, 'fixed_width');
        expect(locked).toMatchObject({
            pageSizeMode: 'fixed_width',
            sizePresetId: 'custom',
            scaleMode: 'fit',
            targetW: 210,
            targetH: 297,
        });
    });
});
