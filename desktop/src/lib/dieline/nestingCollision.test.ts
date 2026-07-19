import { describe, expect, it } from 'vitest';
import { validatePlacementPositions } from './nestingCollision';
import { calculateNesting, computeDieOutline } from './nestingEngine';
import { generateDieline } from './engine';
import { DEFAULT_PARAMS } from './types';
import { DEFAULT_NESTING_CONFIG } from './nestingTypes';

describe('true-contour nesting safety', () => {
    it('rejects placements whose contours do not meet dieGap', () => {
        const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
        const checked = validatePlacementPositions(
            [{ x: 0, y: 0, rotation: 0 }, { x: 12, y: 0, rotation: 0 }, { x: 23, y: 0, rotation: 90 }],
            square,
            3,
            { left: 0, top: 0, right: 100, bottom: 100 },
        );
        expect(checked.positions).toEqual([
            { x: 0, y: 0, rotation: 0 },
            { x: 23, y: 0, rotation: 90 },
        ]);
        expect(checked.removed).toBe(1);
    });

    it('validates smart cup-sleeve output against the generated CUT silhouette', () => {
        const params = { ...DEFAULT_PARAMS, boxType: 'cup_sleeve' as const };
        const model = generateDieline(params);
        const config = {
            ...DEFAULT_NESTING_CONFIG,
            sheet: { width: 790, height: 1090 },
            nestingMode: 'smart' as const,
            sheetOrientation: 'landscape' as const,
            dieGap: 3,
        };
        const result = calculateNesting(model.boundingBox, config, model.params, model);
        const outline = computeDieOutline(model, model.boundingBox).map((point) => ({
            x: point.x - model.boundingBox.minX,
            y: point.y - model.boundingBox.minY,
        }));
        const checked = validatePlacementPositions(result.positions, outline, 3, {
            left: config.margin.left,
            top: config.margin.top,
            right: result.actualSheet.width - config.margin.right,
            bottom: result.actualSheet.height - Math.max(config.margin.bottom, config.gripperMargin),
        });
        expect(result.positions.length).toBeGreaterThan(0);
        expect(result.countPerSheet).toBe(result.positions.length);
        expect(checked.removed).toBe(0);
    });
});
