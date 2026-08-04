import { describe, it, expect } from 'vitest';
import {
    displaySizePt,
    pageSizeKeyMm,
    groupBySizeKey,
    roundMm,
    sizeKeyLabel,
    approximateSizeKeyFilenameToken,
} from './combineGroupBySize';

describe('combineGroupBySize', () => {
    it('roundMm 0.5mm', () => {
        expect(roundMm(50.24, 0.5)).toBe(50);
        expect(roundMm(50.3, 0.5)).toBe(50.5);
    });

    it('displaySizePt swap khi xoay 90/270', () => {
        expect(displaySizePt(200, 100, 0)).toEqual({ w: 200, h: 100 });
        expect(displaySizePt(200, 100, 90)).toEqual({ w: 100, h: 200 });
        expect(displaySizePt(200, 100, 270)).toEqual({ w: 100, h: 200 });
        expect(displaySizePt(200, 100, 180)).toEqual({ w: 200, h: 100 });
    });

    it('pageSizeKeyMm — 50×70mm (pt→mm)', () => {
        // 50mm ≈ 141.732 pt, 70mm ≈ 198.425 pt
        const key = pageSizeKeyMm(50 / 0.352777778, 70 / 0.352777778, 0, 0.5);
        expect(key).toBe('50x70');
        expect(sizeKeyLabel(key)).toBe('≈ 50x70 mm');
        expect(approximateSizeKeyFilenameToken(key)).toBe('approx_50x70mm');
    });

    it('xoay 90 đổi key (đúng kích thước hiển thị)', () => {
        const w = 50 / 0.352777778;
        const h = 70 / 0.352777778;
        expect(pageSizeKeyMm(w, h, 0)).toBe('50x70');
        expect(pageSizeKeyMm(w, h, 90)).toBe('70x50');
    });

    it('groupBySizeKey giữ thứ tự trong nhóm', () => {
        const items = [
            { id: 'a', sizeKey: '50x50' },
            { id: 'b', sizeKey: '60x40' },
            { id: 'c', sizeKey: '50x50' },
        ];
        const g = groupBySizeKey(items);
        expect([...g.keys()]).toEqual(['50x50', '60x40']);
        expect(g.get('50x50')!.map(x => x.id)).toEqual(['a', 'c']);
    });
});
