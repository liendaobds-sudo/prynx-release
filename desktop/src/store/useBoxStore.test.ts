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

    // [UIUX 2026-07-27] Đáy gài & đáy dán là hai loại duy nhất hiện ô "Lưỡi khoá
    // nắp"; mặc định phải KHÔNG tích. Khoá ở đây để lần sau đổi DEFAULT_PARAMS
    // hay applyBoxTypeDefaults không âm thầm bật lại.
    it('đáy gài & đáy dán: mặc định không bật lưỡi khoá nắp', () => {
        for (const boxType of ['slb', 'auto_bottom'] as const) {
            useBoxStore.setState({ params: { ...DEFAULT_PARAMS, lockTab: true } });
            useBoxStore.getState().setParam('boxType', boxType);
            expect(useBoxStore.getState().params.boxType).toBe(boxType);
            expect(useBoxStore.getState().params.lockTab).toBe(false);
        }
        // Người dùng tự tích thì giữ nguyên lựa chọn của họ.
        useBoxStore.getState().setParam('lockTab', true);
        expect(useBoxStore.getState().params.lockTab).toBe(true);
    });

    // [HANGING-WINDOW 2026-07-27] Chọn "Hộp treo có cửa sổ" phải nạp Preset_Dacdora
    // (mẫu khuôn L80 × W30 × D140, giấy 0,5mm, mí keo 15, tai đút 15); đổi sang loại
    // hộp khác phải trả bộ số đo về mặc định chung, không giữ lại số đo hộp treo.
    it('hộp treo có cửa sổ: nạp Preset_Dacdora rồi trả về mặc định khi đổi loại', () => {
        useBoxStore.getState().setParam('boxType', 'hanging_window');
        expect(useBoxStore.getState().params).toMatchObject({
            boxType: 'hanging_window',
            L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15,
        });

        // Đổi sang hộp nắp gài thường: L/W/D/T/C/G/TH quay về DEFAULT_PARAMS.
        useBoxStore.getState().setParam('boxType', 'rte');
        expect(useBoxStore.getState().params).toMatchObject({
            boxType: 'rte',
            L: DEFAULT_PARAMS.L, W: DEFAULT_PARAMS.W, D: DEFAULT_PARAMS.D,
            T: DEFAULT_PARAMS.T, C: DEFAULT_PARAMS.C,
            G: DEFAULT_PARAMS.G, TH: DEFAULT_PARAMS.TH,
        });
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

    it('skips nesting for preview updates and requests it only when needed', async () => {
        generateDielineRemote.mockResolvedValue(response({ ...DEFAULT_PARAMS, L: 123 }, 'preview'));
        useBoxStore.getState().setParam('L', 123);
        await vi.advanceTimersByTimeAsync(70);

        expect(generateDielineRemote).toHaveBeenLastCalledWith(
            expect.objectContaining({ changedKey: 'L', includeNesting: false }),
            expect.any(AbortSignal),
        );

        generateDielineRemote.mockResolvedValue(response(DEFAULT_PARAMS, 'nesting'));
        useBoxStore.getState().regenerate(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(generateDielineRemote).toHaveBeenLastCalledWith(
            expect.objectContaining({ includeNesting: true }),
            expect.any(AbortSignal),
        );
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
