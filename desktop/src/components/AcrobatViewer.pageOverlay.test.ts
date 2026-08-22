// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
    matchesPageOverlayTarget,
    renderPageOverlayForFrame,
    selectionAfterViewerScroll,
    type PageOverlayRenderer,
} from './AcrobatViewer';


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

describe('AcrobatViewer — lớp phủ độc lập theo từng khung trang', () => {
    it('vẫn dựng preview trang 1 sau khi active chuyển sang trang 2', () => {
        const renderer: PageOverlayRenderer = vi.fn(context => (
            `preview-${context.originalPageNum}-${context.isActivePage ? 'editable' : 'readonly'}`
        ));
        const pageOne = {
            originalPageNum: 1,
            viewerPagePosition: 1,
            pageInstanceId: 'page-one',
            isActivePage: true,
        };
        const pageTwo = {
            originalPageNum: 2,
            viewerPagePosition: 2,
            pageInstanceId: 'page-two',
            isActivePage: false,
        };

        expect(renderPageOverlayForFrame(renderer, pageOne)).toBe('preview-1-editable');
        expect(renderPageOverlayForFrame(renderer, pageTwo)).toBe('preview-2-readonly');

        expect(renderPageOverlayForFrame(renderer, {
            ...pageOne,
            isActivePage: false,
        })).toBe('preview-1-readonly');
        expect(renderPageOverlayForFrame(renderer, {
            ...pageTwo,
            isActivePage: true,
        })).toBe('preview-2-editable');
        expect(renderer).toHaveBeenCalledTimes(4);
    });

    it('truyền riêng source page, vị trí và instance khi reorder hoặc nhân bản', () => {
        const renderer: PageOverlayRenderer = vi.fn(context => (
            `${context.viewerPagePosition}:${context.originalPageNum}:${context.pageInstanceId}`
        ));

        expect(renderPageOverlayForFrame(renderer, {
            originalPageNum: 2,
            viewerPagePosition: 1,
            pageInstanceId: 'source-2',
            isActivePage: true,
        })).toBe('1:2:source-2');
        expect(renderPageOverlayForFrame(renderer, {
            originalPageNum: 1,
            viewerPagePosition: 2,
            pageInstanceId: 'source-1-a',
            isActivePage: false,
        })).toBe('2:1:source-1-a');
        expect(renderPageOverlayForFrame(renderer, {
            originalPageNum: 1,
            viewerPagePosition: 3,
            pageInstanceId: 'source-1-b',
            isActivePage: false,
        })).toBe('3:1:source-1-b');
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
