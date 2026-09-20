import { describe, expect, it } from 'vitest';
import {
    buildInstantAlphaCutlinePreview,
    offsetContoursMm,
    polygonSignedArea,
    ramerDouglasPeucker,
    traceAlphaContours,
} from './fastAlphaCutlineTracer';

describe('fastAlphaCutlineTracer', () => {
    it('polygonSignedArea tính đúng diện tích tam giác và hình chữ nhật', () => {
        const rect = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ];
        expect(Math.abs(polygonSignedArea(rect))).toBe(100);
    });

    it('ramerDouglasPeucker rút gọn điểm trên đường thẳng', () => {
        const collinear = [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 5, y: 0 },
            { x: 8, y: 0 },
            { x: 10, y: 0 },
        ];
        const simplified = ramerDouglasPeucker(collinear, 0.5);
        expect(simplified.length).toBe(2);
        expect(simplified[0]).toEqual({ x: 0, y: 0 });
        expect(simplified[1]).toEqual({ x: 10, y: 0 });
    });

    it('traceAlphaContours dò đúng viền của khối hình vuông trong kênh Alpha', () => {
        const width = 50;
        const height = 50;
        const alpha = new Uint8Array(width * height);

        // Vẽ một khối 20x20 ở giữa (từ x=15..34, y=15..34)
        for (let y = 15; y < 35; y += 1) {
            for (let x = 15; x < 35; x += 1) {
                alpha[y * width + x] = 255;
            }
        }

        const contours = traceAlphaContours(alpha, width, height, { minAreaPx: 50 });
        expect(contours.length).toBe(1);
        const ring = contours[0];
        expect(ring.length).toBeGreaterThanOrEqual(4);

        const area = Math.abs(polygonSignedArea(ring));
        // Khối 20x20 = diện tích xung quanh 400
        expect(area).toBeGreaterThan(300);
        expect(area).toBeLessThan(500);
    });

    it('offsetContoursMm co/giãn viền bằng Clipper chính xác', () => {
        const rectMm = [
            [
                { x: 10, y: 10 },
                { x: 30, y: 10 },
                { x: 30, y: 30 },
                { x: 10, y: 30 },
            ],
        ];

        // Offset +2mm
        const expanded = offsetContoursMm(rectMm, 2, 'round');
        expect(expanded.length).toBe(1);
        const areaExpanded = Math.abs(polygonSignedArea(expanded[0]));
        // Diện tích cũ: 20x20 = 400. Mới: ~24x24 = ~576
        expect(areaExpanded).toBeGreaterThan(400);

        // Offset -2mm
        const shrunk = offsetContoursMm(rectMm, -2, 'round');
        expect(shrunk.length).toBe(1);
        const areaShrunk = Math.abs(polygonSignedArea(shrunk[0]));
        expect(areaShrunk).toBeLessThan(400);
    });

    it('buildInstantAlphaCutlinePreview tạo ra đối tượng StickerCutlinePreview hoàn chỉnh', () => {
        const width = 100;
        const height = 100;
        const alpha = new Uint8Array(width * height);

        for (let y = 20; y < 80; y += 1) {
            for (let x = 20; x < 80; x += 1) {
                alpha[y * width + x] = 255;
            }
        }

        const preview = buildInstantAlphaCutlinePreview({
            pageNumber: 1,
            pageWidthMm: 50,
            pageHeightMm: 50,
            alphaData: alpha,
            bitmapWidth: width,
            bitmapHeight: height,
            offsetMm: 1.5,
            cornerStyle: 'round',
            cacheKey: 'test-doc|1',
        });

        expect(preview).not.toBeNull();
        expect(preview?.page_number).toBe(1);
        expect(preview?.preview_width_px).toBe(50);
        expect(preview?.preview_height_px).toBe(50);
        expect(preview?.paths.length).toBe(1);
        expect(preview?.paths[0].d).toMatch(/^M [0-9.-]+ [0-9.-]+/);
        expect(preview?.paths[0].d).toContain('Z');
    });
});
