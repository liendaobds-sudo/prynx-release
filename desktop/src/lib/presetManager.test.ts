import { describe, expect, it } from 'vitest';
import { createPreset } from './presetManager';

describe('presetManager — Bình sách In nhanh', () => {
    it('giữ lề gáy và vị trí trang trắng trong preset', () => {
        const preset = createPreset('Sách keo gáy', '', {
            taskMode: 'booklet',
            paper: {
                formsize: 'custom',
                customSheetWidth: 320,
                customSheetHeight: 450,
                bleed: 3,
                gapX: 0,
                gapY: 0,
                marginTop: 5,
                marginBottom: 5,
                marginLeft: 5,
                marginRight: 5,
                marginMode: 'labels_only',
            },
            marks: { markType: 'guillotine' },
            booklet: {
                signatureMode: 'continuous',
                foliosize: 16,
                paperThickness: 0,
                gutterMargin: 7,
                blankPlacement: 'center',
                scaleMode: 'fit',
                interleave: 'normal',
            },
        });

        expect(preset.booklet?.gutterMargin).toBe(7);
        expect(preset.booklet?.blankPlacement).toBe('center');
    });
});
