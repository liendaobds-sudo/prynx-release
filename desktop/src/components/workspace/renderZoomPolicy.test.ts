import { describe, expect, it } from 'vitest';
import { shouldPrefetchViewerPage } from './renderZoomPolicy';

describe('shouldPrefetchViewerPage', () => {
    it('không prefetch khi viewer tab không active', () => {
        expect(shouldPrefetchViewerPage(false, 0, false, false)).toBe(false);
        expect(shouldPrefetchViewerPage(false, 1, true, true)).toBe(false);
    });

    it('chỉ prefetch khi page ở gần và tab đang active', () => {
        expect(shouldPrefetchViewerPage(true, 0, false, false)).toBe(true);
        expect(shouldPrefetchViewerPage(true, 1, true, false)).toBe(false);
        expect(shouldPrefetchViewerPage(true, 1, true, true)).toBe(true);
        expect(shouldPrefetchViewerPage(true, 2, false, false)).toBe(false);
    });
});
