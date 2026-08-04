import {
    FEATURE_CATALOG,
    canUse,
    type FeatureId,
    type LicensePlan,
} from '../license/features';
import type { Recipe, RecipeOpId, RecipeStep } from './recipeTypes';

/**
 * SEC (audit 2026-08-04 re-audit UI): mọi RecipeOpId phải có capability, kể cả
 * operation v1 chưa phát lại. Record buộc TypeScript báo lỗi khi thêm op mới.
 */
export const RECIPE_FEATURE_IDS = {
    booklet: 'impo.booklet',
    nup: 'impo.nup',
    sticker_imposer: 'impo.diecut',
    cnc_imposer: 'impo.cnc',
    shuffle: 'pdf.shuffle',
    resize: 'pdf.resize',
    trim_shift: 'pdf.trim_shift',
    split: 'pdf.split',
    merge: 'pdf.merge',
    sticker_dieline: 'prepress.cutline',
    convertcolors: 'prepress.convert_colors',
    hairlines: 'prepress.hairlines',
    trapping: 'prepress.trapping',
    pdfx: 'prepress.pdfx',
    ocr: 'prepress.preflight',
    optimize: 'pdf.optimize',
    spot_cmyk: 'prepress.convert_colors',
    watermark: 'pdf.watermark',
    stick_text_number: 'pdf.header_footer',
    bgremover: 'util.bgremover',
    upscale: 'util.upscale',
    datamerge: 'vdp.datamerge',
    numbering: 'vdp.numbering',
    cover_numbering: 'vdp.cover_numbering',
    object_edit: 'prepress.preflight',
    crop: 'pdf.crop',
    page_index_op: 'pdf.pages',
} as const satisfies Record<RecipeOpId, FeatureId>;

type AccessCheck = (
    featureId: FeatureId,
    plan: LicensePlan | string,
    features: readonly string[] | null,
) => boolean;

export function recipeStepAccessError(
    step: RecipeStep,
    plan: LicensePlan | string,
    features: readonly string[] | null,
    accessCheck: AccessCheck = canUse,
): string | null {
    const featureId = Object.prototype.hasOwnProperty.call(RECIPE_FEATURE_IDS, step.opId)
        ? RECIPE_FEATURE_IDS[step.opId]
        : null;
    if (!featureId) {
        return `Bước “${step.label || String(step.opId)}” chưa được phân loại quyền và đã bị chặn.`;
    }
    if (accessCheck(featureId, plan, features)) return null;
    return `Bước “${step.label}” cần quyền ${FEATURE_CATALOG[featureId].label} của PrynX Pro.`;
}

export function firstDeniedRecipeStep(
    recipe: Recipe,
    plan: LicensePlan | string,
    features: readonly string[] | null,
    accessCheck: AccessCheck = canUse,
): { index: number; step: RecipeStep; featureId: FeatureId | null; error: string } | null {
    for (let index = 0; index < recipe.steps.length; index++) {
        const step = recipe.steps[index];
        if (!step.recordable) continue;
        const error = recipeStepAccessError(step, plan, features, accessCheck);
        if (error) {
            const featureId = Object.prototype.hasOwnProperty.call(RECIPE_FEATURE_IDS, step.opId)
                ? RECIPE_FEATURE_IDS[step.opId]
                : null;
            return { index, step, featureId, error };
        }
    }
    return null;
}
