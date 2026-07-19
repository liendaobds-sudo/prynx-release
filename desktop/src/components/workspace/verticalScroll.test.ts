import { describe, expect, it } from 'vitest';
import { getVerticalScrollTop } from './verticalScroll';

describe('getVerticalScrollTop', () => {
    const base = {
        containerTop: 100,
        containerHeight: 400,
        scrollTop: 250,
        elementHeight: 40,
    };

    it('does not move a visible element with nearest alignment', () => {
        expect(getVerticalScrollTop({ ...base, elementTop: 200 }, 'nearest')).toBe(250);
    });

    it('scrolls vertically up when the element is above the viewport', () => {
        expect(getVerticalScrollTop({ ...base, elementTop: 70 }, 'nearest')).toBe(220);
    });

    it('scrolls vertically down when the element is below the viewport', () => {
        expect(getVerticalScrollTop({ ...base, elementTop: 490 }, 'nearest')).toBe(280);
    });

    it('centers an element using vertical geometry only', () => {
        expect(getVerticalScrollTop({ ...base, elementTop: 490 }, 'center')).toBe(460);
    });
});