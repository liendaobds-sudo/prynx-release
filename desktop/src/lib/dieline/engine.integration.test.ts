import { describe, expect, it } from 'vitest';
import { runDielineEngine } from './engine';
import { DEFAULT_PARAMS, DielineModel, Panel, PathSegment } from './types';
import { DEFAULT_NESTING_CONFIG, NestingResult } from './nestingTypes';
import { computeDieOutline } from './nestingEngine';
import { validatePlacementPositions } from './nestingCollision';

function partModel(model: DielineModel, predicate: (panel: Panel) => boolean): DielineModel {
    const panels = model.panels.filter(predicate);
    const allPaths = panels.flatMap((panel) => panel.paths);
    const points = allPaths.flatMap((segment: PathSegment) =>
        segment.type === 'bezier' && segment.controlPoints ? segment.controlPoints : segment.points);
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    return {
        ...model,
        panels,
        allPaths,
        boundingBox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    };
}

function expectRevalidates(model: DielineModel, result: NestingResult, dieGap: number): void {
    const checked = validatePlacementPositions(
        result.positions,
        computeDieOutline(model, model.boundingBox),
        dieGap,
        { left: 0, top: 0, right: result.actualSheet.width, bottom: result.actualSheet.height },
    );
    expect(checked.removed).toBe(0);
    expect(checked.positions).toHaveLength(result.positions.length);
}

describe('tray nesting safety', () => {
    const params = { ...DEFAULT_PARAMS, boxType: 'tray' as const, L: 120, W: 85, D: 25 };

    it.each(['split', 'combined'] as const)('revalidates tray and sleeve CUT silhouettes in %s mode', (mode) => {
        const response = runDielineEngine({
            params,
            nestingConfig: {
                ...structuredClone(DEFAULT_NESTING_CONFIG),
                sheet: { width: 900, height: 650 },
                sleeveSheet: { width: 700, height: 500 },
                margin: { top: 10, right: 10, bottom: 10, left: 10 },
                nestingMode: 'smart',
                trayNestingMode: mode,
            },
        });
        expect(response.nestingResult?.positions.length).toBeGreaterThan(0);
        expect(response.sleeveNestingResult?.positions.length).toBeGreaterThan(0);
        const tray = partModel(response.dieline, (panel) => !panel.name.startsWith('sleeve_'));
        const sleeve = partModel(response.dieline, (panel) => panel.name.startsWith('sleeve_'));
        expectRevalidates(tray, response.nestingResult!, 3);
        expectRevalidates(sleeve, response.sleeveNestingResult!, 3);
    });

    it('never lets grid gutter weaken the configured die gap', () => {
        const response = runDielineEngine({
            params: { ...DEFAULT_PARAMS, boxType: 'cup_sleeve' },
            nestingConfig: {
                ...structuredClone(DEFAULT_NESTING_CONFIG),
                nestingMode: 'grid',
                gutter: 0.5,
                dieGap: 4,
            },
        });
        expect(response.nestingResult?.cellSize.width).toBeGreaterThanOrEqual(response.dieline.boundingBox.width + 4);
    });
});
