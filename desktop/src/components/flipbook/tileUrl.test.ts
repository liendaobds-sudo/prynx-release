import { describe, expect, it } from 'vitest';

import { buildTileUrl, trimmedAspectRatio } from './tileUrl';

describe('buildTileUrl', () => {
    it('mặc định đánh dấu trang đang xem là interactive', () => {
        const url = buildTileUrl({
            path: 'D:\\jobs\\Giấy mời.pdf',
            page: 2,
            scale: 1,
        });

        expect(url).toBe(
            'http://tile.localhost/D%3A%5Cjobs%5CGi%E1%BA%A5y%20m%E1%BB%9Di.pdf/2/1/0/0/0/0/0?purpose=interactive',
        );
    });

    it('giữ nguyên clip bleed khi gắn purpose background', () => {
        const url = buildTileUrl({
            path: 'D:\\jobs\\book.pdf',
            page: 3,
            scale: 1,
            pageWpt: 100,
            pageHpt: 200,
            bleedMm: 3,
            purpose: 'background',
        });

        expect(url).toBe(
            'http://tile.localhost/D%3A%5Cjobs%5Cbook.pdf/3/1/0/11/11/111/244?purpose=background',
        );
    });
});

describe('trimmedAspectRatio', () => {
    it('tính tỷ lệ theo khổ sau xén', () => {
        expect(trimmedAspectRatio(100, 200, 3)).toBeCloseTo(
            (100 - 2 * 3 * 2.83465) / (200 - 2 * 3 * 2.83465),
        );
    });
});
