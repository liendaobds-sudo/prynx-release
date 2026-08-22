// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
    EDIT_OBJECT_FOCUS_EVENT,
    getVerticalScrollTop,
    readEditObjectFocusRequest,
    requestEditObjectFocus,
} from './verticalScroll';

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

describe('edit object focus requests', () => {
    it('accepts only the requested page', () => {
        const event = new CustomEvent(EDIT_OBJECT_FOCUS_EVENT, {
            detail: { objectId: 'vector-3', pageIndex: 1 },
        });
        expect(readEditObjectFocusRequest(event, 1)).toBe('vector-3');
        expect(readEditObjectFocusRequest(event, 0)).toBeNull();
    });

    it('dispatches focus only when the panel explicitly requests it', () => {
        const received: string[] = [];
        const listener = (event: Event) => {
            const objectId = readEditObjectFocusRequest(event, 2);
            if (objectId) received.push(objectId);
        };
        window.addEventListener(EDIT_OBJECT_FOCUS_EVENT, listener);
        requestEditObjectFocus('image-4', 2);
        window.removeEventListener(EDIT_OBJECT_FOCUS_EVENT, listener);
        expect(received).toEqual(['image-4']);
    });

    it('lọc focus theo tab và instance của bản trang', () => {
        const matching = new CustomEvent(EDIT_OBJECT_FOCUS_EVENT, {
            detail: { objectId: 'dup-1', pageIndex: 2, tabId: 'tab-a', pageInstanceId: 'instance-a' },
        });
        const wrongTab = new CustomEvent(EDIT_OBJECT_FOCUS_EVENT, {
            detail: { objectId: 'dup-2', pageIndex: 2, tabId: 'tab-b', pageInstanceId: 'instance-a' },
        });
        const wrongInstance = new CustomEvent(EDIT_OBJECT_FOCUS_EVENT, {
            detail: { objectId: 'dup-3', pageIndex: 2, tabId: 'tab-a', pageInstanceId: 'instance-b' },
        });

        expect(readEditObjectFocusRequest(matching, 2, { tabId: 'tab-a', pageInstanceId: 'instance-a' })).toBe('dup-1');
        expect(readEditObjectFocusRequest(wrongTab, 2, { tabId: 'tab-a', pageInstanceId: 'instance-a' })).toBeNull();
        expect(readEditObjectFocusRequest(wrongInstance, 2, { tabId: 'tab-a', pageInstanceId: 'instance-a' })).toBeNull();
    });
});
