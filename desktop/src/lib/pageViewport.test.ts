// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { capturePageViewportAnchor, restorePageViewportAnchor } from './pageViewport';

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
});

describe('page viewport anchor', () => {
    it('restores the same relative page coordinate after page navigation', () => {
        const scroller = document.createElement('div');
        const sourcePage = document.createElement('div');
        const targetPage = document.createElement('div');
        Object.defineProperties(scroller, {
            clientWidth: { value: 400 },
            clientHeight: { value: 300 },
        });
        scroller.getBoundingClientRect = () => rect(100, 50, 400, 300);
        sourcePage.getBoundingClientRect = () => rect(-300, -250, 1000, 800);
        targetPage.getBoundingClientRect = () => rect(20, 10, 1200, 1000);
        scroller.scrollLeft = 0;
        scroller.scrollTop = 0;

        const anchor = capturePageViewportAnchor(scroller, sourcePage);
        expect(anchor).toEqual({ xRatio: 0.6, yRatio: 0.5625 });
        expect(restorePageViewportAnchor(scroller, targetPage, anchor!)).toBe(true);
        expect(scroller.scrollLeft).toBe(440);
        expect(scroller.scrollTop).toBe(372.5);
    });
});
