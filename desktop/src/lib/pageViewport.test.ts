// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
    capturePagePointViewportAnchor,
    capturePageViewportAnchor,
    restorePagePointViewportAnchor,
    restorePageViewportAnchor,
} from './pageViewport';

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

    it('keeps the page point under the mouse stable when a centered page grows', () => {
        const scroller = document.createElement('div');
        const page = document.createElement('div');
        scroller.getBoundingClientRect = () => rect(100, 50, 800, 600);
        page.getBoundingClientRect = () => rect(300, 150, 400, 800);
        scroller.scrollLeft = 0;
        scroller.scrollTop = 0;

        const anchor = capturePagePointViewportAnchor(scroller, page, 500, 300);
        expect(anchor).toEqual({
            viewportX: 400,
            viewportY: 250,
            pageXRatio: 0.5,
            pageYRatio: 0.1875,
        });

        // Sau zoom, flex centering/padding tạo một origin mới; không thể suy ra bằng
        // cách nhân scrollLeft/Top với ratio zoom.
        page.getBoundingClientRect = () => rect(124, 80, 800, 1600);
        expect(restorePagePointViewportAnchor(scroller, page, anchor!)).toBe(true);
        expect(scroller.scrollLeft).toBe(24);
        expect(scroller.scrollTop).toBe(80);
    });
});
