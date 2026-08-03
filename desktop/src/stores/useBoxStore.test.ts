import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxParams, DEFAULT_PARAMS, DielineModel } from '../lib/dieline/types';
import { DEFAULT_NESTING_CONFIG } from '../lib/dieline/nestingTypes';
import { defaultVariantFor, getVariant } from '../lib/dieline/variants';

const { generateDielineRemote } = vi.hoisted(() => ({ generateDielineRemote: vi.fn() }));

vi.mock('../lib/dieline/api', () => ({ generateDielineRemote }));

import { useBoxStore } from '../stores/useBoxStore';

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
            // [VARIANT 2026-07-29]
            variantId: defaultVariantFor(DEFAULT_PARAMS.boxType)?.id ?? null,
            isAdvancedMode: false,
            clampVersion: 0,
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

    // ─── [VARIANT 2026-07-29] Lớp biến thể khuôn bế ───────────

    it('setVariant áp đúng thứ tự: mặc định boxType → preset → lockedParams', () => {
        useBoxStore.getState().setVariant('hgb_window');
        expect(useBoxStore.getState().variantId).toBe('hgb_window');
        expect(useBoxStore.getState().params).toMatchObject({
            boxType: 'hanging_window',
            // (b) preset của biến thể — Preset_Dacdora
            L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15,
            // (c) lockedParams
            hgbWindow: true,
        });
    });

    // lockedParams phải THẮNG cả applyBoxTypeDefaults: chọn boxType 'slb' vốn tắt
    // lockTab (UIUX 2026-07-27), nhưng biến thể "có lưỡi khoá nắp" chốt bật.
    it('lockedParams thắng mặc định của boxType', () => {
        useBoxStore.getState().setVariant('slb_lock');
        expect(useBoxStore.getState().params).toMatchObject({ boxType: 'slb', lockTab: true });

        useBoxStore.getState().setVariant('slb_plain');
        expect(useBoxStore.getState().params).toMatchObject({ boxType: 'slb', lockTab: false });
    });

    // Đổi giữa hai biến thể CÙNG boxType: chỉ đổi thuộc tính chốt, KHÔNG xoá số
    // đo người dùng vừa gõ (preset chỉ áp khi bước sang họ hộp khác).
    it('đổi biến thể cùng loại: giữ số đo người dùng, chỉ đổi thuộc tính chốt', () => {
        useBoxStore.getState().setVariant('hgb_window');
        useBoxStore.getState().setParam('L', 95);
        expect(useBoxStore.getState().params.L).toBe(95);

        useBoxStore.getState().setVariant('hgb_solid');
        expect(useBoxStore.getState().params).toMatchObject({
            boxType: 'hanging_window',
            L: 95,              // số đo người dùng còn nguyên
            hgbWindow: false,   // thuộc tính chốt đã đổi
        });
        expect(useBoxStore.getState().variantId).toBe('hgb_solid');
    });

    it('đổi túi có quai ↔ túi trơn đồng bộ cả lỗ quai và mí gập miệng', () => {
        useBoxStore.getState().setVariant('bag_holes');
        expect(useBoxStore.getState().params).toMatchObject({ handleHoles: true, TH: 30 });

        useBoxStore.getState().setVariant('bag_plain');
        expect(useBoxStore.getState().params).toMatchObject({ handleHoles: false, TH: 0 });

        useBoxStore.getState().setVariant('bag_holes');
        expect(useBoxStore.getState().params).toMatchObject({ handleHoles: true, TH: 30 });
    });

    // Req 2.2: hai biến thể cùng boxType vẫn phải làm mới ô nhập ⇒ clampVersion
    // phải tăng dù boxType không đổi (ô nhập dùng clampVersion trong key để remount).
    it('đổi biến thể cùng loại vẫn tăng clampVersion để ô nhập remount', async () => {
        useBoxStore.getState().setVariant('hgb_window');
        generateDielineRemote.mockResolvedValue(
            response({ ...DEFAULT_PARAMS, boxType: 'hanging_window' }, 'variant'),
        );
        await vi.advanceTimersByTimeAsync(70);
        const before = useBoxStore.getState().clampVersion;

        useBoxStore.getState().setVariant('hgb_solid');
        await vi.advanceTimersByTimeAsync(70);
        expect(useBoxStore.getState().clampVersion).toBeGreaterThan(before);
    });

    it('setVariant với id rác rơi về biến thể mặc định của boxType hiện tại', () => {
        useBoxStore.getState().setVariant('slb_lock');
        useBoxStore.getState().setVariant('khong_ton_tai');
        expect(useBoxStore.getState().variantId).toBe(defaultVariantFor('slb')!.id);
        expect(useBoxStore.getState().params.boxType).toBe('slb');
    });

    it('setParam(boxType) đồng bộ variantId — state không trỏ hai nơi khác nhau', () => {
        useBoxStore.getState().setParam('boxType', 'slb');
        const id = useBoxStore.getState().variantId;
        expect(id).toBe(defaultVariantFor('slb')!.id);
        expect(getVariant(id!)!.boxType).toBe('slb');
    });

    // Catalog phủ kín 11 loại hộp ⇒ chọn loại nào cũng có biến thể tương ứng,
    // và preset cũ trong applyBoxTypeDefaults vẫn được tôn trọng.
    it('mọi boxType đều nhận được biến thể tương ứng khi đổi loại', () => {
        const boxTypes: BoxParams['boxType'][] = [
            'rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve',
            'pizza', 'envelope', 'tray', 'double_tray', 'hanging_window',
            'flip_top_tuck',
        ];
        for (const boxType of boxTypes) {
            useBoxStore.getState().setParam('boxType', boxType);
            const id = useBoxStore.getState().variantId;
            expect(id, `boxType '${boxType}' không nhận được biến thể`).not.toBeNull();
            expect(getVariant(id!)!.boxType).toBe(boxType);
        }

        // Preset số đo cũ của hộp pizza vẫn nguyên (không bị lớp biến thể phá)
        useBoxStore.getState().setParam('boxType', 'rte');
        useBoxStore.getState().setParam('boxType', 'pizza');
        expect(useBoxStore.getState().params).toMatchObject({
            boxType: 'pizza', L: 300, W: 300, D: 40, T: 1.5, C: 1, TH: 15,
        });
    });

    // Nhánh phòng vệ: nếu catalog mất mục phủ boxType đang dùng thì variantId về
    // null để form KHÔNG ẩn oan control nào, và không throw.
    it('boxType không có biến thể nào: variantId về null, không throw', () => {
        useBoxStore.setState({
            params: { ...DEFAULT_PARAMS, boxType: 'loai_khong_ton_tai' as BoxParams['boxType'] },
        });
        expect(() => useBoxStore.getState().setVariant('rac')).not.toThrow();
        expect(useBoxStore.getState().variantId).toBeNull();
    });

    it('setAdvancedMode bật/tắt chế độ chuyên gia', () => {
        expect(useBoxStore.getState().isAdvancedMode).toBe(false);
        useBoxStore.getState().setAdvancedMode(true);
        expect(useBoxStore.getState().isAdvancedMode).toBe(true);
    });
    it('flip-top tuck nạp preset 200×200×60 và đặt panel gốc nằm ngang', async () => {
        const fttParams = {
            ...DEFAULT_PARAMS,
            boxType: 'flip_top_tuck' as const,
            L: 200,
            W: 200,
            D: 60,
            T: 0.5,
            C: 0.5,
        };
        generateDielineRemote.mockResolvedValue(response(fttParams, 'ftt'));
        useBoxStore.setState({ isStanding: true });

        useBoxStore.getState().setVariant('ftt_self_lock');
        expect(useBoxStore.getState().params).toMatchObject(fttParams);
        await vi.advanceTimersByTimeAsync(70);

        expect(useBoxStore.getState().isStanding).toBe(false);
        expect(useBoxStore.getState().dieline?.name).toBe('ftt');
    });

});
