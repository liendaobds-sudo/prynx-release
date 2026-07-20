import { describe, expect, it } from 'vitest';
import {
    batchCapacityDetectionReady,
    buildPageSizedShapeState,
    inheritedSingleMoldMaster,
    shapeDetectionSourceKey,
    projectPageRecordToViewer,
    projectShapeParamsToViewer,
    resolvePreviewItemDimension,
    usesPageSizedStickerShape,
} from './shapeDetectionPolicy';

describe('shapeDetectionPolicy', () => {
    it('chỉ bỏ nhận diện cho Bình tem bế + 1 dao + theo kích thước trang', () => {
        expect(usesPageSizedStickerShape('sticker_imposer', 'one_dao', 'page')).toBe(true);
        expect(usesPageSizedStickerShape('sticker_imposer', 'one_dao', 'die')).toBe(false);
        expect(usesPageSizedStickerShape('cnc_imposer', 'one_dao', 'page')).toBe(false);
    });

    it('tạo hình chữ nhật và giữ kích thước riêng của từng trang', () => {
        const state = buildPageSizedShapeState(
            [{ w: 100, h: 200 }, { w: 300, h: 400 }],
            { w: 50, h: 60 },
            3,
        );

        expect(state.shapes).toEqual({ 0: 'RECTANGLE', 1: 'RECTANGLE', 2: 'RECTANGLE' });
        expect(state.dimensions).toEqual({
            0: { w: 100, h: 200 },
            1: { w: 300, h: 400 },
            2: { w: 50, h: 60 },
        });
        expect(state.params).toEqual({ 0: {}, 1: {}, 2: {} });
    });

    it('desktop giữ cùng khóa khi pre-upload làm thay đổi fileId', () => {
        const file = { name: 'tem.pdf', size: 123, lastModified: 456 } as File;
        expect(shapeDetectionSourceKey(true, 'D:/tem.pdf', '', file)).toBe('path:D:/tem.pdf');
        expect(shapeDetectionSourceKey(true, 'D:/tem.pdf', 'new-id', file)).toBe('path:D:/tem.pdf');
        expect(shapeDetectionSourceKey(false, undefined, 'new-id', file)).toBe('file-id:new-id');
    });

    it('nhận đúng master ở giữa file từ inheritedFromPage', () => {
        expect(inheritedSingleMoldMaster({
            0: { inheritedFromPage: 1 },
            1: { diameter: 50 },
            2: { inheritedFromPage: 1 },
        }, 3)).toBe(1);
    });

    it('không gộp multi-mold cùng shape type khi không có inheritance', () => {
        expect(inheritedSingleMoldMaster({
            0: { radiusX: 15, radiusY: 15 },
            1: { radiusX: 30, radiusY: 30 },
        }, 2)).toBeNull();
    });

    it('từ chối metadata inheritance thiếu hoặc mâu thuẫn', () => {
        expect(inheritedSingleMoldMaster({
            0: { inheritedFromPage: 1 },
            1: {},
            2: {},
        }, 3)).toBeNull();
        expect(inheritedSingleMoldMaster({
            0: { inheritedFromPage: 1 },
            1: {},
            2: { inheritedFromPage: 0 },
        }, 3)).toBeNull();
    });

    it('waits for coherent sticker detection before batch capacity', () => {
        const complete = { 0: 'CIRCLE', 1: 'RECTANGLE', 2: 'CUSTOM' };
        expect(batchCapacityDetectionReady('sticker_imposer', false, 3, {}, false)).toBe(false);
        expect(batchCapacityDetectionReady('sticker_imposer', true, 3, complete, true)).toBe(false);
        expect(batchCapacityDetectionReady('sticker_imposer', false, 3, { 0: 'CIRCLE' }, true)).toBe(false);
        expect(batchCapacityDetectionReady('sticker_imposer', false, 3, complete, true)).toBe(true);
    });

    it('does not gate regular N-Up on shape detection', () => {
        expect(batchCapacityDetectionReady('nup', true, 4, undefined, false)).toBe(true);
    });

    it('projects source detection onto duplicated thumbnail positions', () => {
        expect(projectPageRecordToViewer(
            { 0: 'ELLIPSE', 1: 'CUSTOM' },
            [2, 1, 2],
        )).toEqual({ 0: 'CUSTOM', 1: 'ELLIPSE', 2: 'CUSTOM' });
    });

    it('remaps inherited mold master after thumbnail reorder', () => {
        expect(projectShapeParamsToViewer(
            { 0: { radius: 20 }, 1: { inheritedFromPage: 0 } },
            [2, 1, 2],
        )).toEqual({
            0: { inheritedFromPage: 1 },
            1: { radius: 20 },
            2: { inheritedFromPage: 1 },
        });
    });

    it('uses resized live page dimensions for guillotine instead of stale detection', () => {
        const detected = { 0: { w: 100, h: 100 }, 1: { w: 100, h: 100 } };
        const live = { 0: { w: 100, h: 100 }, 1: { w: 200, h: 300 } };

        expect(resolvePreviewItemDimension('nup', 1, detected, live, { w: 100, h: 100 }))
            .toEqual({ w: 200, h: 300 });
    });

    it('keeps detected die dimensions for sticker and CNC tools', () => {
        const detected = { 0: { w: 80, h: 90 } };
        const live = { 0: { w: 200, h: 300 } };

        expect(resolvePreviewItemDimension('sticker_imposer', 0, detected, live, null))
            .toEqual({ w: 80, h: 90 });
        expect(resolvePreviewItemDimension('cnc_imposer', 0, detected, live, null))
            .toEqual({ w: 80, h: 90 });
    });
});
