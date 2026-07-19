import { DielineModel, Panel, PathSegment } from './types';

function segmentPoints(segment: PathSegment) {
    return segment.type === 'bezier' && segment.controlPoints
        ? segment.controlPoints
        : segment.points;
}

function buildPart(model: DielineModel, predicate: (panel: Panel) => boolean): DielineModel | null {
    const panels = model.panels.filter(predicate);
    const allPaths = panels.flatMap((panel) => panel.paths);
    const points = allPaths.flatMap(segmentPoints);
    if (points.length === 0) return null;
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    return {
        ...model,
        panels,
        allPaths,
        boundingBox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
        nesting: undefined,
    };
}

/** Return manufacturing-independent tray and sleeve models from the combined editor model. */
export function splitTrayDieline(model: DielineModel): { tray: DielineModel; sleeve: DielineModel } | null {
    if (model.params.boxType !== 'tray') return null;
    const tray = buildPart(model, (panel) => !panel.name.startsWith('sleeve_'));
    const sleeve = buildPart(model, (panel) => panel.name.startsWith('sleeve_'));
    return tray && sleeve ? { tray, sleeve } : null;
}
