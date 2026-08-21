// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { matchesPageOverlayTarget, selectionAfterViewerScroll } from './AcrobatViewer';


describe('AcrobatViewer — nhắm lớp phủ theo trang Viewer', () => {
    it('không phủ cả hai bản nhân đôi có cùng số trang nguồn', () => {
        const common = {
            originalPageNum: 3,
            pageInstanceId: 'instance-a',
            targetSourcePage: 3,
            targetViewerPage: 1,
        };

        expect(matchesPageOverlayTarget({
            ...common,
            viewerPagePosition: 1,
        })).toBe(true);
        expect(matchesPageOverlayTarget({
            ...common,
            viewerPagePosition: 3,
        })).toBe(false);
    });

    it('ưu tiên instance ổn định hơn vị trí khi trang bị reorder', () => {
        expect(matchesPageOverlayTarget({
            originalPageNum: 3,
            viewerPagePosition: 2,
            pageInstanceId: 'instance-target',
            targetSourcePage: 1,
            targetViewerPage: 1,
            targetInstanceId: 'instance-target',
        })).toBe(true);
        expect(matchesPageOverlayTarget({
            originalPageNum: 3,
            viewerPagePosition: 1,
            pageInstanceId: 'instance-other',
            targetSourcePage: 3,
            targetViewerPage: 1,
            targetInstanceId: 'instance-target',
        })).toBe(false);
    });

    it('giữ tương thích target theo trang nguồn cho overlay cũ', () => {
        expect(matchesPageOverlayTarget({
            originalPageNum: 2,
            viewerPagePosition: 4,
            pageInstanceId: 'instance-4',
            targetSourcePage: 2,
        })).toBe(true);
    });
});

describe('AcrobatViewer — đồng bộ trang khi cuộn', () => {
    it('giữ nguyên identity khi cuộn vẫn nằm trên cùng trang', () => {
        const current = new Set([1]);

        expect(selectionAfterViewerScroll(current, 2, 2)).toBe(current);
    });

    it('chọn theo vị trí Viewer thay vì tìm số trang nguồn trong pageOrder', () => {
        const current = new Set([0]);

        const next = selectionAfterViewerScroll(current, 2, 2);

        expect(next).not.toBe(current);
        expect([...next]).toEqual([1]);
    });

    it('không sinh selection -1 và không phá multi-selection', () => {
        const single = new Set([0]);
        const multiple = new Set([0, 1]);

        expect(selectionAfterViewerScroll(single, 0, 2)).toBe(single);
        expect(selectionAfterViewerScroll(single, 3, 2)).toBe(single);
        expect(selectionAfterViewerScroll(multiple, 2, 2)).toBe(multiple);
    });
});
