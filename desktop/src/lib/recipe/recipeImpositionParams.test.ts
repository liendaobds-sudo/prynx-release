import { describe, expect, it } from 'vitest';

import { sanitizeRecipeImpositionParams } from './recipeImpositionParams';

describe('sanitizeRecipeImpositionParams', () => {
    it('loại dữ liệu theo tài liệu và tác dụng phụ lưu file khỏi Booklet/N-Up', () => {
        const sanitized = sanitizeRecipeImpositionParams('booklet', {
            sheetWidth: 320,
            bookReport: { enabled: true, text: 'Lệnh in' },
            pageOrder: [4, 3, 2, 1],
            pageRotations: [0, 90, 0, 0],
            hiddenOcgLayerIds: [12],
            detectedDimensionsByPage: { 0: { w: 10, h: 20 } },
            autoSavePrint: true,
            savePrintConfig: { folder: 'D:\\don-cu', orderCode: 'OLD' },
            diagnosticTraceId: 'trace-old',
            onConfirmScale: () => true,
        });

        expect(sanitized).toEqual({
            sheetWidth: 320,
            bookReport: { enabled: true, text: 'Lệnh in' },
        });
    });

    it('loại hình và số lượng theo trang khỏi bình tem để playback dò lại', () => {
        const sanitized = sanitizeRecipeImpositionParams('sticker_imposer', {
            sheetWidth: 320,
            targetQuantity: 500,
            detectedShapesByPage: { 0: 'CIRCLE' },
            detectedShapeParamsByPage: { 0: { d: 20 } },
            shapeType: 'CIRCLE',
            shapeParams: '{"d":20}',
            targetQuantitiesByPage: { 0: 200, 1: 300 },
        });

        expect(sanitized).toEqual({ sheetWidth: 320, targetQuantity: 500 });
    });
});
