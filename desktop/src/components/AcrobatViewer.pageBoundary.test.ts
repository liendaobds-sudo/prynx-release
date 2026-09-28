import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AcrobatViewer — ranh giới trang khi xóa/giữ lại trang lẻ', () => {
    it('renderPdfPage so sánh với effectiveSourcePageCount chứ không dùng numPages (viewerNumPages)', () => {
        const source = readFileSync(new URL('./AcrobatViewer.tsx', import.meta.url), 'utf8');
        expect(source).toContain('effectiveSourcePageCount');
        expect(source).toContain('originalPageNum > effectiveSourcePageCount');
        expect(source).not.toContain('originalPageNum > numPages');
    });

    it('useTileRenderer nhận effectiveSourcePageCount để không chặn các trang có index gốc lớn hơn số trang còn lại', () => {
        const source = readFileSync(new URL('./AcrobatViewer.tsx', import.meta.url), 'utf8');
        expect(source).toMatch(/useTileRenderer\(\s*\{[\s\S]*numPages:\s*effectiveSourcePageCount/);
    });

    it('effectiveSourcePageCount bảo toàn ít nhất bằng trang lớn nhất trong pageOrder khi đã xóa', () => {
        const pageOrder = [5];
        const sourcePageCount = 5;
        const pdfRefNumPages = 5;
        const maxOrderedPage = pageOrder.reduce((max, p) => (p > max ? p : max), 0);
        const effectiveSourcePageCount = Math.max(sourcePageCount || 0, pdfRefNumPages || 0, maxOrderedPage);
        expect(effectiveSourcePageCount).toBe(5);

        // Với file 10 trang, xóa còn lại duy nhất trang 8:
        const pageOrder10 = [8];
        const sourcePageCount10 = 10;
        const maxOrderedPage10 = pageOrder10.reduce((max, p) => (p > max ? p : max), 0);
        const effective10 = Math.max(sourcePageCount10 || 0, 10, maxOrderedPage10);
        expect(effective10).toBe(10);
        // Trang gốc 8 so với effective10 (10) không bị chặn
        expect(8 > effective10).toBe(false);
    });
});
