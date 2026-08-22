import { describe, expect, it } from 'vitest';
import {
    resolveActiveViewerIndexAfterRemoval,
    resolveViewerFitPageSizes,
    resolveViewerPageIdentity,
    viewerRowIndexForPosition,
} from './viewerPageIdentity';

describe('viewerPageIdentity', () => {
    it('phân biệt vị trí Viewer, trang nguồn và trang Working PDF sau reorder', () => {
        expect(resolveViewerPageIdentity({
            viewerPosition: 1,
            pageOrder: [2, 1],
            pageInstanceIds: ['instance-b', 'instance-a'],
        })).toEqual({
            viewerPosition: 1,
            viewerIndex: 0,
            sourcePage: 2,
            sourceIndex: 1,
            instanceId: 'instance-b',
            materializedPage: 1,
        });
    });

    it('không biến trang trắng hoặc vị trí ngoài tài liệu thành trang nguồn', () => {
        expect(resolveViewerPageIdentity({
            viewerPosition: 1,
            pageOrder: [-1],
            pageInstanceIds: ['blank'],
        })).toMatchObject({ sourcePage: null, sourceIndex: null, materializedPage: 1 });
        expect(resolveViewerPageIdentity({
            viewerPosition: 3,
            pageOrder: [1, 2],
        })).toMatchObject({ sourcePage: null, instanceId: null, materializedPage: null });
    });

    it('tính Fit hai trang theo tổng chiều rộng, chiều cao thật và rotation từng instance', () => {
        const sizes = resolveViewerFitPageSizes({
            activeViewerPosition: 2,
            pageDisplayMode: 'two_fit',
            pageOrder: [2, 1],
            pageInstanceIds: ['wide', 'rotated'],
            pageRotations: { rotated: 90 },
            pageDims: {
                1: { w: 600, h: 900 },
                2: { w: 1200, h: 500 },
            },
            displayScale: 1.25,
        });

        expect(sizes).toEqual([
            { width: 1500, height: 625 },
            { width: 1125, height: 750 },
        ]);
    });

    it('giữ active theo instance khi xóa trang đứng trước hoặc xóa chính active', () => {
        expect(resolveActiveViewerIndexAfterRemoval(
            3,
            ['a', 'b', 'c', 'd'],
            ['a', 'c', 'd'],
        )).toBe(1);
        expect(resolveActiveViewerIndexAfterRemoval(
            2,
            ['a', 'b', 'c'],
            ['a', 'c'],
        )).toBe(1);
        expect(resolveActiveViewerIndexAfterRemoval(1, ['a'], [])).toBe(-1);
    });

    it('map đúng row khi điều hướng trong chế độ hiển thị hai trang', () => {
        expect(viewerRowIndexForPosition(0, 'two_scroll')).toBe(0);
        expect(viewerRowIndexForPosition(1, 'two_scroll')).toBe(0);
        expect(viewerRowIndexForPosition(2, 'two_scroll')).toBe(1);
        expect(viewerRowIndexForPosition(3, 'single_scroll')).toBe(3);
    });
});
