import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, DielineModel } from '../lib/dieline/types';
import { DEFAULT_NESTING_CONFIG } from '../lib/dieline/nestingTypes';

const { generateDielineRemote } = vi.hoisted(() => ({ generateDielineRemote: vi.fn() }));

vi.mock('../lib/dieline/api', () => ({ generateDielineRemote }));

import { useBoxStore } from './useBoxStore';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function response(params = { ...DEFAULT_PARAMS }, marker = 'current') {
    return {
        params,
        dieline: { name: marker } as DielineModel,
        nestingResult: null,
        sleeveNestingResult: null,
        wasClamped: false,
    };
}

describe('useBoxStore generation consistency', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        generateDielineRemote.mockReset();
        useBoxStore.setState({
            params: { ...DEFAULT_PARAMS },
            dieline: null,
            nestingConfig: structuredClone(DEFAULT_NESTING_CONFIG),
            nestingResult: null,
            sleeveNestingResult: null,
            isGenerating: false,
            isModelCurrent: false,
            generationError: null,
        });
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('marks the existing model stale immediately while a new model is pending', () => {
        useBoxStore.setState({ dieline: { name: 'old' } as DielineModel, isModelCurrent: true });
        useBoxStore.getState().setParam('L', 123);
        expect(useBoxStore.getState()).toMatchObject({
            isGenerating: true,
            isModelCurrent: false,
            generationError: null,
        });
    });

    it('accepts only the latest response when requests finish out of order', async () => {
        const first = deferred<ReturnType<typeof response>>();
        const second = deferred<ReturnType<typeof response>>();
        generateDielineRemote
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);

        useBoxStore.getState().setParam('L', 111);
        await vi.advanceTimersByTimeAsync(70);
        useBoxStore.getState().setParam('W', 222);
        await vi.advanceTimersByTimeAsync(70);

        first.resolve(response({ ...DEFAULT_PARAMS, L: 111 }, 'stale'));
        await Promise.resolve();
        expect(useBoxStore.getState().dieline?.name).not.toBe('stale');

        second.resolve(response({ ...DEFAULT_PARAMS, L: 111, W: 222 }, 'latest'));
        await vi.advanceTimersByTimeAsync(0);
        expect(useBoxStore.getState()).toMatchObject({
            isGenerating: false,
            isModelCurrent: true,
            generationError: null,
        });
        expect(useBoxStore.getState().dieline?.name).toBe('latest');
        expect(useBoxStore.getState().params.W).toBe(222);
    });

    it('keeps export state stale when generation fails', async () => {
        generateDielineRemote.mockRejectedValueOnce(new Error('sidecar unavailable'));
        useBoxStore.getState().regenerate();
        await vi.advanceTimersByTimeAsync(0);
        expect(useBoxStore.getState()).toMatchObject({
            isGenerating: false,
            isModelCurrent: false,
            generationError: 'sidecar unavailable',
        });
    });
});
