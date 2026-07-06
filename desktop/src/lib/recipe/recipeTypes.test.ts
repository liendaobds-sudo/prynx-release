import { describe, it, expect } from 'vitest';
import {
    createRecipe,
    serializeRecipe,
    deserializeRecipe,
    isRecipe,
    isRecipeStep,
    RECIPE_SCHEMA_VERSION,
    type RecipeStep,
    type Recipe,
} from './recipeTypes';

const sampleSteps: RecipeStep[] = [
    { opId: 'convertcolors', label: 'Chuyển màu RGB→CMYK', params: { conversions: ['rgb_to_cmyk'], preserve_black: true }, recordable: true },
    { opId: 'pdfx', label: 'Xuất PDF/X-1a', params: { standard: 'x1a' }, recordable: true },
    { opId: 'booklet', label: 'Bình sách SRA3', params: { sheetWidth: 320, sheetHeight: 450, signatureMode: 'saddle' }, recordable: true, viewerPageOrder: [1, 2, 3, 4], viewerPageRotations: [0, 90, 0, 0] },
    { opId: 'datamerge', label: 'Trộn dữ liệu (CSV)', params: {}, recordable: true, needsExternalInput: 'csv' },
    { opId: 'object_edit', label: 'Sửa object (phụ thuộc file)', params: { id: 'x' }, recordable: false },
];

describe('recipeTypes — createRecipe', () => {
    it('gán id/timestamps/schemaVersion + clone steps', () => {
        const r = createRecipe('Quy trình A', sampleSteps, { description: 'demo', hints: { sourcePageCount: 16 } });
        expect(r.id).toBeTruthy();
        expect(r.name).toBe('Quy trình A');
        expect(r.description).toBe('demo');
        expect(r.schemaVersion).toBe(RECIPE_SCHEMA_VERSION);
        expect(r.createdAt).toBe(r.updatedAt);
        expect(r.hints?.sourcePageCount).toBe(16);
        expect(r.steps).toHaveLength(sampleSteps.length);
        // clone sâu: sửa recipe không ảnh hưởng nguồn
        (r.steps[0].params as any).conversions.push('x');
        expect((sampleSteps[0].params as any).conversions).toEqual(['rgb_to_cmyk']);
    });
});

describe('recipeTypes — type guards', () => {
    it('isRecipeStep nhận diện đúng/sai', () => {
        expect(isRecipeStep(sampleSteps[0])).toBe(true);
        expect(isRecipeStep({})).toBe(false);
        expect(isRecipeStep({ opId: 'x', label: 'y', recordable: true })).toBe(false); // thiếu params
        expect(isRecipeStep({ opId: 'x', label: 'y', recordable: true, params: [] })).toBe(false); // params là mảng
        expect(isRecipeStep(null)).toBe(false);
    });

    it('isRecipe nhận diện đúng/sai', () => {
        const r = createRecipe('A', sampleSteps);
        expect(isRecipe(r)).toBe(true);
        expect(isRecipe({})).toBe(false);
        expect(isRecipe({ ...r, steps: [{ bad: 1 }] })).toBe(false);
        expect(isRecipe({ ...r, schemaVersion: '1' as any })).toBe(false);
    });
});

describe('recipeTypes — round-trip serialize/deserialize (Property 1)', () => {
    it('load(save(recipe)) giữ nguyên nội dung', () => {
        const r = createRecipe('Booklet 16 trang', sampleSteps, { hints: { sourcePageCount: 16 } });
        const restored = deserializeRecipe(serializeRecipe(r));
        expect(restored).toEqual(r);
        // thứ tự step giữ nguyên
        expect(restored.steps.map(s => s.opId)).toEqual(sampleSteps.map(s => s.opId));
    });

    it('giữ nguyên cờ recordable / needsExternalInput / viewer order+rotations', () => {
        const r = createRecipe('A', sampleSteps);
        const restored = deserializeRecipe(serializeRecipe(r));
        const booklet = restored.steps.find(s => s.opId === 'booklet')!;
        expect(booklet.viewerPageOrder).toEqual([1, 2, 3, 4]);
        expect(booklet.viewerPageRotations).toEqual([0, 90, 0, 0]);
        expect(restored.steps.find(s => s.opId === 'datamerge')!.needsExternalInput).toBe('csv');
        expect(restored.steps.find(s => s.opId === 'object_edit')!.recordable).toBe(false);
    });

    it('deserialize ném lỗi khi JSON sai hoặc cấu trúc sai', () => {
        expect(() => deserializeRecipe('{ not json')).toThrow();
        expect(() => deserializeRecipe('{"a":1}')).toThrow();
        expect(() => deserializeRecipe(JSON.stringify({ steps: 'x' }))).toThrow();
    });
});
