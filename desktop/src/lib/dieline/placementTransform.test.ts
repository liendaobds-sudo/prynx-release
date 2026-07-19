import { describe, expect, it } from 'vitest';
import { mapPointToPlacement, svgPlacementTransform } from './placementTransform';

const bounds = { minX: 10, minY: 20, maxX: 40, maxY: 70, width: 30, height: 50 };

describe('placement transform contract', () => {
    it.each([
        [0, { x: 100, y: 200 }, { x: 130, y: 250 }],
        [90, { x: 100, y: 200 }, { x: 150, y: 230 }],
        [180, { x: 100, y: 200 }, { x: 130, y: 250 }],
        [270, { x: 100, y: 200 }, { x: 150, y: 230 }],
    ])('maps source bounds to the expected rotated bounds at %i degrees', (rotation, expectedMin, expectedMax) => {
        const corners = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY },
        ].map((point) => mapPointToPlacement(point, { x: 100, y: 200, rotation }, bounds));
        expect(Math.min(...corners.map((point) => point.x))).toBe(expectedMin.x);
        expect(Math.min(...corners.map((point) => point.y))).toBe(expectedMin.y);
        expect(Math.max(...corners.map((point) => point.x))).toBe(expectedMax.x);
        expect(Math.max(...corners.map((point) => point.y))).toBe(expectedMax.y);
    });

    it('emits canonical SVG rotations rather than swapping 90 and 270', () => {
        expect(svgPlacementTransform({ x: 100, y: 200, rotation: 90 }, bounds)).toContain('rotate(90)');
        expect(svgPlacementTransform({ x: 100, y: 200, rotation: 270 }, bounds)).toContain('rotate(-90)');
    });
});
