import { describe, expect, it } from 'vitest';

import { flipbookRenderPurpose, shouldPromoteFlipbookUrl } from './flipbookLoadPolicy';

describe('flipbookLoadPolicy', () => {
    it('chỉ hai trang của spread hiện tại là interactive', () => {
        expect(flipbookRenderPurpose(4, 4)).toBe('interactive');
        expect(flipbookRenderPurpose(5, 4)).toBe('interactive');
        expect(flipbookRenderPurpose(6, 4)).toBe('background');
        expect(flipbookRenderPurpose(3, 4)).toBe('background');
    });

    it('promote URL preload khi trang trở thành trang đang nhìn', () => {
        expect(shouldPromoteFlipbookUrl(
            'http://tile.localhost/file/1/1/0/0/0/0/0?purpose=background',
            'interactive',
        )).toBe(true);
        expect(shouldPromoteFlipbookUrl(
            'http://tile.localhost/file/1/1/0/0/0/0/0?purpose=interactive',
            'interactive',
        )).toBe(false);
        expect(shouldPromoteFlipbookUrl('', 'background')).toBe(false);
    });
});
