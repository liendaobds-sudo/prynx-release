import { describe, expect, it } from 'vitest';
import {
    buildPropertyAffine,
    canvasBboxToNative,
    mmToPt,
    pickTopmostObjectAtPoint,
    ptToMm,
    selectionBounds,
} from './editTransformMath';

const page = { widthPt: 600, heightPt: 800, cropX: 50, cropY: 50 };

describe('edit transform properties', () => {
    it('converts millimetres and points without drift', () => {
        expect(ptToMm(mmToPt(123.456))).toBeCloseTo(123.456, 10);
    });

    it('builds one PDF-native affine matrix with CropBox offset', () => {
        const objects = [{ id: 'a', bbox: [10, 20, 110, 70] as [number, number, number, number] }];
        const matrix = buildPropertyAffine(objects, page, {
            xMm: ptToMm(20),
            yMm: ptToMm(30),
            widthMm: ptToMm(200),
            heightMm: ptToMm(100),
            rotateDeg: 0,
        });
        expect(matrix).not.toBeNull();
        expect(matrix![0]).toBeCloseTo(2);
        expect(matrix![3]).toBeCloseTo(2);
        expect(matrix![4]).toBeCloseTo(-50);
        expect(matrix![5]).toBeCloseTo(-840);

        const nativeOld = canvasBboxToNative(objects[0].bbox, page);
        const [a, b, c, d, e, f] = matrix!;
        const lowerLeft = [
            nativeOld[0] * a + nativeOld[1] * c + e,
            nativeOld[0] * b + nativeOld[1] * d + f,
        ];
        expect(lowerLeft[0]).toBeCloseTo(70);
        expect(lowerLeft[1]).toBeCloseTo(720);
    });

    it('gets selection union bounds', () => {
        expect(selectionBounds([
            { id: 'a', bbox: [10, 20, 30, 40] },
            { id: 'b', bbox: [0, 25, 50, 60] },
        ])).toEqual([0, 20, 50, 60]);
    });
});

describe('canvas hit testing without per-object DOM nodes', () => {
    const objects = [
        { id: 'fill', drawIndex: 10, bbox: [0, 0, 100, 100] as [number, number, number, number] },
        { id: 'line', drawIndex: 5, bbox: [40, 40, 60, 60] as [number, number, number, number] },
        { id: 'top', drawIndex: 20, bbox: [40, 40, 60, 60] as [number, number, number, number] },
    ];

    it('prefers the smallest hit, then the top draw order', () => {
        expect(pickTopmostObjectAtPoint(objects, 50, 50)?.id).toBe('top');
    });

    it('honours hidden and locked exclusions', () => {
        expect(pickTopmostObjectAtPoint(objects, 50, 50, ['top', 'line'])?.id).toBe('fill');
        expect(pickTopmostObjectAtPoint(objects, 200, 200)).toBeNull();
    });
});