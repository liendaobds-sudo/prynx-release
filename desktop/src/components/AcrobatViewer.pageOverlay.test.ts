// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { matchesPageOverlayTarget } from './AcrobatViewer';


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
