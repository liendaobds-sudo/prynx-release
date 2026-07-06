import { describe, it, expect } from 'vitest';
import {
    RECIPE_OP_META,
    isRecordableOp,
    externalInputFor,
    summarizeParams,
    buildRecipeStep,
    type RecipeOpGroup,
} from './recipeOps';
import { isRecipeStep, type RecipeOpId } from './recipeTypes';

const ALL_OP_IDS = Object.keys(RECIPE_OP_META) as RecipeOpId[];

describe('recipeOps — metadata hợp lệ & đầy đủ', () => {
    it('mọi op có group + recordable + needsExternalInput hợp lệ', () => {
        const groups: RecipeOpGroup[] = ['imposition', 'preprocess', 'merge', 'prepress', 'overlay', 'ai', 'vdp', 'edit'];
        for (const opId of ALL_OP_IDS) {
            const m = RECIPE_OP_META[opId];
            expect(typeof m.label).toBe('string');
            expect(m.label.length).toBeGreaterThan(0);
            expect(typeof m.recordable).toBe('boolean');
            expect([null, 'csv', 'file']).toContain(m.needsExternalInput);
            expect(groups).toContain(m.group);
        }
    });
});

describe('recipeOps — phân loại đúng (chặn lỗi merge/pageboxes-class)', () => {
    it('thao tác file/position-dependent + AI ảnh tương tác → recordable=false', () => {
        for (const opId of ['object_edit', 'crop', 'page_index_op', 'datamerge', 'numbering', 'cover_numbering', 'bgremover', 'upscale'] as const) {
            expect(isRecordableOp(opId)).toBe(false);
        }
    });

    it('bình bài (kể cả tem/cnc, dò lại hình lúc phát) + tạo đường cắt + prepress → recordable=true', () => {
        for (const opId of ['booklet', 'nup', 'sticker_imposer', 'cnc_imposer', 'sticker_dieline', 'convertcolors', 'hairlines', 'pdfx', 'optimize', 'watermark', 'stick_text_number'] as const) {
            expect(isRecordableOp(opId)).toBe(true);
        }
    });

    it('input ngoài: merge→file, datamerge→csv, còn lại→null', () => {
        expect(externalInputFor('merge')).toBe('file');
        expect(externalInputFor('datamerge')).toBe('csv');
        expect(externalInputFor('convertcolors')).toBe(null);
        expect(externalInputFor('booklet')).toBe(null);
    });
});

describe('recipeOps — summarizeParams', () => {
    it('tóm tắt bình bài theo khổ + grid', () => {
        expect(summarizeParams('booklet', { sheetWidth: 320, sheetHeight: 450 })).toContain('320×450mm');
        expect(summarizeParams('nup', { sheetWidth: 320, sheetHeight: 450, cols: 3, rows: 4 })).toContain('3×4');
    });
    it('convertcolors liệt kê conversions; pdfx hiện chuẩn', () => {
        expect(summarizeParams('convertcolors', { conversions: ['rgb_to_cmyk', 'spot_to_cmyk'] })).toBe('rgb_to_cmyk, spot_to_cmyk');
        expect(summarizeParams('pdfx', { standard: 'x1a' })).toBe('X1A');
    });
    it('op không có summary → chuỗi rỗng', () => {
        expect(summarizeParams('ocr', {})).toBe('');
    });
});

describe('recipeOps — buildRecipeStep', () => {
    it('dựng Step hợp lệ, gán recordable/external theo metadata, label kèm summary', () => {
        const step = buildRecipeStep('convertcolors', { conversions: ['rgb_to_cmyk'] });
        expect(isRecipeStep(step)).toBe(true);
        expect(step.opId).toBe('convertcolors');
        expect(step.recordable).toBe(true);
        expect(step.needsExternalInput).toBe(null);
        expect(step.label).toContain('Chuyển hệ màu');
        expect(step.label).toContain('rgb_to_cmyk');
    });

    it('deep-clone params (độc lập nguồn)', () => {
        const src = { conversions: ['rgb_to_cmyk'] };
        const step = buildRecipeStep('convertcolors', src);
        (step.params as any).conversions.push('x');
        expect(src.conversions).toEqual(['rgb_to_cmyk']);
    });

    it('gắn kèm viewerPageOrder/Rotations khi truyền extras', () => {
        const step = buildRecipeStep('booklet', { sheetWidth: 320, sheetHeight: 450 }, {
            viewerPageOrder: [1, 2, 3, 4], viewerPageRotations: [0, 90, 0, 0],
        });
        expect(step.viewerPageOrder).toEqual([1, 2, 3, 4]);
        expect(step.viewerPageRotations).toEqual([0, 90, 0, 0]);
    });

    it('op file-dependent → step.recordable=false', () => {
        const step = buildRecipeStep('object_edit', { id: 'x' });
        expect(step.recordable).toBe(false);
    });
});
