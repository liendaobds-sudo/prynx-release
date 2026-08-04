import { describe, expect, it } from 'vitest';

import { hasFeatureAccess } from '../license/features';
import { RECIPE_OP_META } from './recipeOps';
import { createRecipe, type RecipeStep } from './recipeTypes';
import { firstDeniedRecipeStep, RECIPE_FEATURE_IDS } from './recipeEntitlements';

const step = (opId: RecipeStep['opId']): RecipeStep => ({
    opId,
    label: opId,
    params: {},
    recordable: true,
});

describe('quyền phát lại Recipe', () => {
    it('phân loại đủ mọi RecipeOpId bằng FeatureId typed', () => {
        expect(Object.keys(RECIPE_FEATURE_IDS).sort()).toEqual(Object.keys(RECIPE_OP_META).sort());
        expect(RECIPE_FEATURE_IDS.crop).toBe('pdf.crop');
        expect(RECIPE_FEATURE_IDS.sticker_dieline).toBe('prepress.cutline');
    });

    it('kiểm toàn recipe trước khi chạy và chỉ chấp nhận custom grant đúng bước', () => {
        const recipe = createRecipe('Kiểm quyền', [step('optimize'), step('nup'), step('booklet')]);

        const denied = firstDeniedRecipeStep(recipe, 'free', ['impo.nup'], hasFeatureAccess);
        expect(denied?.index).toBe(2);
        expect(denied?.featureId).toBe('impo.booklet');
        expect(denied?.error).toContain('Bình sách');

        expect(firstDeniedRecipeStep(
            recipe,
            'free',
            ['impo.nup', 'impo.booklet'],
            hasFeatureAccess,
        )).toBeNull();
    });

    it('bỏ qua bước non-recordable vì PlaybackRunner không thực thi bước đó', () => {
        const blocked = step('bgremover');
        blocked.recordable = false;
        const recipe = createRecipe('Không chạy', [blocked]);
        expect(firstDeniedRecipeStep(recipe, 'free', null, hasFeatureAccess)).toBeNull();
    });

    it('recipe JSON có opId lạ bị chặn fail-closed thay vì làm vỡ UI', () => {
        const unknown = step('optimize');
        (unknown as { opId: string }).opId = 'op-khong-duoc-phan-loai';
        const recipe = createRecipe('Dữ liệu cũ', [unknown]);
        const denied = firstDeniedRecipeStep(recipe, 'pro', null, hasFeatureAccess);
        expect(denied?.featureId).toBeNull();
        expect(denied?.error).toContain('chưa được phân loại');
    });
});
