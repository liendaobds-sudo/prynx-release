import { PlacedDieline } from './nestingTypes';
import { Point2D } from './types';

export interface PlacementBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
}

function normalizedRotation(rotation: number): 0 | 90 | 180 | 270 {
    const value = ((rotation % 360) + 360) % 360;
    if (value === 90 || value === 180 || value === 270) return value;
    return 0;
}

/**
 * Map a source dieline point into a placement whose x/y is always the
 * top-left corner of the rotated source bounds. Coordinates are in the
 * application's SVG convention (x right, y down).
 */
export function mapPointToPlacement(
    point: Point2D,
    placement: PlacedDieline,
    bounds: PlacementBounds,
): Point2D {
    const rotation = normalizedRotation(placement.rotation);
    if (rotation === 90) {
        return {
            x: placement.x + bounds.maxY - point.y,
            y: placement.y + point.x - bounds.minX,
        };
    }
    if (rotation === 180) {
        return {
            x: placement.x + bounds.maxX - point.x,
            y: placement.y + bounds.maxY - point.y,
        };
    }
    if (rotation === 270) {
        return {
            x: placement.x + point.y - bounds.minY,
            y: placement.y + bounds.maxX - point.x,
        };
    }
    return {
        x: placement.x + point.x - bounds.minX,
        y: placement.y + point.y - bounds.minY,
    };
}

/** SVG transform equivalent to mapPointToPlacement(). */
export function svgPlacementTransform(
    placement: PlacedDieline,
    bounds: PlacementBounds,
): string {
    const rotation = normalizedRotation(placement.rotation);
    if (rotation === 90) {
        return `translate(${placement.x + bounds.maxY}, ${placement.y - bounds.minX}) rotate(90)`;
    }
    if (rotation === 180) {
        return `translate(${placement.x + bounds.maxX}, ${placement.y + bounds.maxY}) rotate(180)`;
    }
    if (rotation === 270) {
        return `translate(${placement.x - bounds.minY}, ${placement.y + bounds.maxX}) rotate(-90)`;
    }
    return `translate(${placement.x - bounds.minX}, ${placement.y - bounds.minY})`;
}
