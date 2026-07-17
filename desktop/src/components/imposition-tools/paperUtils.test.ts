// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    formUsages,
    paperContextFromTool,
    primaryClassificationFromUsages,
    resolveSheetDimsMm,
    resolvePressSheetDimsMm,
    fallbackFormsizeForContext,
    showsPredefinedSheets,
    DEFAULT_FORMSIZE,
    PREDEFINED_SIZES,
} from './paperUtils';

describe('paperUtils', () => {
    it('PREDEFINED chỉ series A0–A7', () => {
        expect(Object.keys(PREDEFINED_SIZES).sort()).toEqual(
            ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].sort(),
        );
        expect(PREDEFINED_SIZES.SRA3).toBeUndefined();
        expect(PREDEFINED_SIZES.A3).toEqual({ w: 297, h: 420, classification: 'in_nhanh', gripperMargin: 0 });
        expect(DEFAULT_FORMSIZE).toBe('A3');
    });

    it('formUsages: multi + migrate classification', () => {
        expect(formUsages({ usages: ['diecut', 'nup'] })).toEqual(['diecut', 'nup']);
        expect(formUsages({ classification: 'offset' })).toEqual(['offset']);
        expect(formUsages({})).toEqual(['in_nhanh']);
    });

    it('paperContextFromTool', () => {
        expect(paperContextFromTool('sticker_imposer', 'offset')).toBe('diecut');
        expect(paperContextFromTool('cnc_imposer', 'in_nhanh')).toBe('diecut');
        expect(paperContextFromTool('nup', 'offset')).toBe('nup');
        expect(paperContextFromTool('booklet', 'offset')).toBe('offset');
        expect(paperContextFromTool('booklet', 'in_nhanh')).toBe('in_nhanh');
    });

    it('primaryClassificationFromUsages', () => {
        expect(primaryClassificationFromUsages(['diecut'])).toBe('in_nhanh');
        expect(primaryClassificationFromUsages(['offset', 'nup'])).toBe('offset');
    });

    it('resolvePressSheetDimsMm: chỉ booklet+offset mới swap ngang', () => {
        const d = { w: 297, h: 420 };
        expect(resolvePressSheetDimsMm(d, { activeTool: 'booklet', paperClassification: 'offset' }))
            .toEqual({ w: 420, h: 297 });
        expect(resolvePressSheetDimsMm(d, { activeTool: 'nup', paperClassification: 'offset' }))
            .toEqual(d);
        expect(resolvePressSheetDimsMm(d, { activeTool: 'sticker_imposer', paperClassification: 'offset' }))
            .toEqual(d);
        expect(resolvePressSheetDimsMm(d, { activeTool: 'booklet', paperClassification: 'in_nhanh' }))
            .toEqual(d);
    });

    it('resolveSheetDimsMm: predefined + custom_ + legacy fallback', () => {
        expect(resolveSheetDimsMm('A4', [], 0, 0)).toEqual({ w: 210, h: 297 });
        expect(resolveSheetDimsMm('custom_1', [{ id: 'custom_1', w: 330, h: 350 }], 1, 1))
            .toEqual({ w: 330, h: 350 });
        // legacy SRA3 → mirror
        expect(resolveSheetDimsMm('SRA3', [], 320, 450)).toEqual({ w: 320, h: 450 });
    });

    it('fallbackFormsizeForContext', () => {
        expect(fallbackFormsizeForContext('in_nhanh', [])).toBe('A3');
        expect(fallbackFormsizeForContext('diecut', [])).toBe('custom');
        expect(fallbackFormsizeForContext('diecut', [
            { id: 'custom_x', usages: ['diecut'] },
        ])).toBe('custom_x');
        expect(showsPredefinedSheets('offset')).toBe(false);
        expect(showsPredefinedSheets('nup')).toBe(true);
    });
});
