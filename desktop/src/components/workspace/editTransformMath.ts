import type { BBox, Matrix } from './editTypes';

export const PT_PER_MM = 72 / 25.4;
const EPSILON = 1e-7;

export interface EditObjectGeometry {
    id: string;
    drawIndex?: number;
    bbox: BBox;
    nativeBbox?: BBox;
}

export interface EditPageGeometry {
    widthPt: number;
    heightPt: number;
    cropX: number;
    cropY: number;
}

export interface PropertyValuesMm {
    xMm: number;
    yMm: number;
    widthMm: number;
    heightMm: number;
    rotateDeg?: number;
}

export function mmToPt(value: number): number {
    return value * PT_PER_MM;
}

export function ptToMm(value: number): number {
    return value / PT_PER_MM;
}

export function selectionBounds(objects: EditObjectGeometry[]): BBox | null {
    if (!objects.length) return null;
    return objects.reduce<BBox>((acc, obj) => [
        Math.min(acc[0], obj.bbox[0]),
        Math.min(acc[1], obj.bbox[1]),
        Math.max(acc[2], obj.bbox[2]),
        Math.max(acc[3], obj.bbox[3]),
    ], [...objects[0].bbox] as BBox);
}

export function canvasBboxToNative(bbox: BBox, page: EditPageGeometry): BBox {
    return [
        bbox[0] + page.cropX,
        page.heightPt - bbox[3] + page.cropY,
        bbox[2] + page.cropX,
        page.heightPt - bbox[1] + page.cropY,
    ];
}

/** Matrix multiplication for PDF row-vector affine matrices: point * left * right. */
export function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
    const [a, b, c, d, e, f] = left;
    const [g, h, i, j, k, l] = right;
    return [
        a * g + b * i,
        a * h + b * j,
        c * g + d * i,
        c * h + d * j,
        e * g + f * i + k,
        e * h + f * j + l,
    ];
}

export function isIdentityMatrix(matrix: Matrix, epsilon = EPSILON): boolean {
    const identity: Matrix = [1, 0, 0, 1, 0, 0];
    return matrix.every((value, index) => Math.abs(value - identity[index]) <= epsilon);
}

/**
 * Build one native PDF-space affine matrix from desired canvas-space X/Y/W/H.
 * Rotation is a delta in screen convention (clockwise positive).
 */
export function buildPropertyAffine(
    objects: EditObjectGeometry[],
    page: EditPageGeometry,
    values: PropertyValuesMm,
): Matrix | null {
    const canvasBounds = selectionBounds(objects);
    if (!canvasBounds) return null;

    const widthPt = mmToPt(values.widthMm);
    const heightPt = mmToPt(values.heightMm);
    const xPt = mmToPt(values.xMm);
    const yPt = mmToPt(values.yMm);
    if (![widthPt, heightPt, xPt, yPt].every(Number.isFinite) || widthPt <= 0 || heightPt <= 0) {
        return null;
    }

    const nativeBounds = canvasBboxToNative(canvasBounds, page);
    const oldWidth = nativeBounds[2] - nativeBounds[0];
    const oldHeight = nativeBounds[3] - nativeBounds[1];
    if (oldWidth <= EPSILON || oldHeight <= EPSILON) return null;

    const desiredCanvas: BBox = [xPt, yPt, xPt + widthPt, yPt + heightPt];
    const desiredNative = canvasBboxToNative(desiredCanvas, page);
    const sx = (desiredNative[2] - desiredNative[0]) / oldWidth;
    const sy = (desiredNative[3] - desiredNative[1]) / oldHeight;
    let result: Matrix = [
        sx, 0, 0, sy,
        desiredNative[0] - nativeBounds[0] * sx,
        desiredNative[1] - nativeBounds[1] * sy,
    ];

    const screenDegrees = Number(values.rotateDeg || 0);
    if (Number.isFinite(screenDegrees) && Math.abs(screenDegrees) > EPSILON) {
        const radians = -screenDegrees * Math.PI / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const cx = (desiredNative[0] + desiredNative[2]) / 2;
        const cy = (desiredNative[1] + desiredNative[3]) / 2;
        const rotation: Matrix = [
            cos, sin, -sin, cos,
            cx - cx * cos + cy * sin,
            cy - cx * sin - cy * cos,
        ];
        result = multiplyMatrices(result, rotation);
    }
    return result;
}

/**
 * Hit-test without creating one DOM node per PDF object. Prefer the smallest
 * containing object (easier to select a line over a filled shape), then top draw order.
 */
export function pickTopmostObjectAtPoint<T extends EditObjectGeometry>(
    objects: T[],
    xPt: number,
    yPt: number,
    excludedIds: readonly string[] = [],
): T | null {
    const excluded = new Set(excludedIds);
    const hits = objects.filter(obj =>
        !excluded.has(obj.id)
        && xPt >= obj.bbox[0] && xPt <= obj.bbox[2]
        && yPt >= obj.bbox[1] && yPt <= obj.bbox[3]
    );
    hits.sort((a, b) => {
        const areaA = Math.max(0, a.bbox[2] - a.bbox[0]) * Math.max(0, a.bbox[3] - a.bbox[1]);
        const areaB = Math.max(0, b.bbox[2] - b.bbox[0]) * Math.max(0, b.bbox[3] - b.bbox[1]);
        if (Math.abs(areaA - areaB) > EPSILON) return areaA - areaB;
        return (Number(b.drawIndex) || 0) - (Number(a.drawIndex) || 0);
    });
    return hits[0] || null;
}