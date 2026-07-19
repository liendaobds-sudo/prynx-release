import { describe, expect, it } from 'vitest';
import { assignComponentsToDeepestLayers } from './layerComponentTree';

const layers = [
    {
        id: 1,
        children: [
            { id: -10, children: [{ id: 2, children: [] }] },
        ],
    },
    { id: 3, children: [] },
];

describe('assignComponentsToDeepestLayers', () => {
    it('places inherited parent+child membership only under the deepest child', () => {
        const component = { id: 'vector-0', ocgIds: [1, 2] };
        const result = assignComponentsToDeepestLayers(layers, [component]);

        expect(result.byLayerId.get(1)).toBeUndefined();
        expect(result.byLayerId.get(2)).toEqual([component]);
        expect(result.unlayered).toEqual([]);
    });

    it('keeps memberships in unrelated OCGs instead of dropping one by depth', () => {
        const component = { id: 'vector-1', ocgIds: [1, 2, 3] };
        const result = assignComponentsToDeepestLayers(layers, [component]);

        expect(result.byLayerId.get(1)).toBeUndefined();
        expect(result.byLayerId.get(2)).toEqual([component]);
        expect(result.byLayerId.get(3)).toEqual([component]);
    });

    it('groups missing and non-displayed OCG memberships as unlayered', () => {
        const plain = { id: 'vector-2', ocgIds: [] };
        const orphan = { id: 'vector-3', ocgIds: [999] };
        const result = assignComponentsToDeepestLayers(layers, [plain, orphan]);

        expect(result.unlayered).toEqual([plain, orphan]);
    });
});