import type { RecipeOpId } from './recipeTypes';

const DOCUMENT_BOUND_KEYS = new Set([
    'pageOrder',
    'pageRotations',
    'hiddenOcgLayerIds',
    'detectedDimensionsByPage',
    'autoSavePrint',
    'savePrintConfig',
    'diagnosticTraceId',
    'diagnosticPreviewRequestId',
    'diagnosticPendingRequestId',
    'diagnosticPreviewCapacity',
    'diagnosticPreviewState',
    'onConfirmScale',
]);

const STICKER_DOCUMENT_BOUND_KEYS = new Set([
    'detectedShapesByPage',
    'detectedShapeParamsByPage',
    'shapeType',
    'shapeParams',
    'targetQuantitiesByPage',
]);

/**
 * Chỉ giữ tham số có thể áp dụng lại cho tài liệu khác. Dữ liệu trang/hình/path
 * của đơn hiện tại phải được tính lại lúc phát, không được đóng băng trong Recipe.
 */
export function sanitizeRecipeImpositionParams(
    opId: RecipeOpId,
    settings: Record<string, unknown>,
): Record<string, unknown> {
    const isSticker = opId === 'sticker_imposer' || opId === 'cnc_imposer';
    return Object.fromEntries(
        Object.entries(settings).filter(([key]) => (
            !DOCUMENT_BOUND_KEYS.has(key)
            && (!isSticker || !STICKER_DOCUMENT_BOUND_KEYS.has(key))
        )),
    );
}
