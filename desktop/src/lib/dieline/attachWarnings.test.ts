import { describe, it, expect } from 'vitest';
import { attachWarnings } from './attachWarnings';
import { DielineModel, DEFAULT_PARAMS } from './types';

/** Tạo một DielineModel tối thiểu để test attachWarnings */
function makeModel(warnings?: string[]): DielineModel {
    return {
        name: 'test',
        standardCode: 'TEST',
        description: '',
        panels: [],
        allPaths: [],
        boundingBox: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
        params: { ...DEFAULT_PARAMS },
        ...(warnings !== undefined ? { warnings } : {}),
    };
}

describe('attachWarnings', () => {
    it('sets an empty array when there are no warnings', () => {
        const model = makeModel();
        const result = attachWarnings(model, []);
        expect(Array.isArray(result.warnings)).toBe(true);
        expect(result.warnings).toEqual([]);
    });

    it('never leaves warnings undefined', () => {
        const model = makeModel();
        const result = attachWarnings(model, []);
        expect(result.warnings).not.toBeUndefined();
        expect(result.warnings).not.toBeNull();
    });

    it('includes all validation warnings', () => {
        const model = makeModel();
        const result = attachWarnings(model, ['A', 'B']);
        expect(result.warnings).toEqual(['A', 'B']);
    });

    it('merges generation warnings with validation warnings', () => {
        const model = makeModel(['gen-1']);
        const result = attachWarnings(model, ['val-1']);
        expect(result.warnings).toEqual(['val-1', 'gen-1']);
    });

    it('dedupes by exact string content', () => {
        const model = makeModel(['dup', 'gen-only']);
        const result = attachWarnings(model, ['dup', 'val-only']);
        expect(result.warnings).toEqual(['dup', 'val-only', 'gen-only']);
    });

    it('is deterministic for the same inputs', () => {
        const a = attachWarnings(makeModel(['x']), ['y', 'z']);
        const b = attachWarnings(makeModel(['x']), ['y', 'z']);
        expect(a.warnings).toEqual(b.warnings);
    });
});
