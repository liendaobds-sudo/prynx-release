import { create } from 'zustand';
import { generateDielineRemote } from '../lib/dieline/api';
import { BoxParams, DEFAULT_PARAMS, DielineModel } from '../lib/dieline/types';
import { NestingConfig, NestingResult, DEFAULT_NESTING_CONFIG } from '../lib/dieline/nestingTypes';
import { normalizeNestingUpdates } from '../lib/dieline/runtimeValidation';
// [VARIANT 2026-07-29] Lớp biến thể khuôn bế — dữ liệu thuần, không hình học
import { BoxVariant, defaultVariantFor, getVariant } from '../lib/dieline/variants';

interface BoxStore {
    params: BoxParams;
    dieline: DielineModel | null;
    foldProgress: number;
    viewMode: '2d' | '3d' | 'split';
    isAnimating: boolean;
    clampVersion: number;
    nestingConfig: NestingConfig;
    nestingResult: NestingResult | null;
    sleeveNestingResult: NestingResult | null;
    mockupTextureUrl: string | null;
    isGenerating: boolean;
    isModelCurrent: boolean;
    generationError: string | null;

    /** [VARIANT 2026-07-29] Biến thể đang chọn trong thư viện khuôn.
     *  null = chưa/không có biến thể nào phủ boxType hiện tại ⇒ form không ẩn
     *  control nào (catalog đang được phủ dần theo lô). */
    variantId: string | null;
    /** [VARIANT 2026-07-29] Chế độ chuyên gia: mở khoá mọi tham số bị biến thể
     *  chốt. Đường lùi để không tính năng nào bị mất so với bản trước. */
    isAdvancedMode: boolean;

    setParam: (key: keyof BoxParams, value: BoxParams[keyof BoxParams]) => void;
    setParams: (updates: Partial<BoxParams>) => void;
    setVariant: (id: string) => void;
    setAdvancedMode: (v: boolean) => void;
    regenerate: (includeNesting?: boolean) => void;
    setFoldProgress: (value: number) => void;
    setViewMode: (mode: '2d' | '3d' | 'split') => void;
    setIsAnimating: (v: boolean) => void;
    setNestingConfig: (updates: Partial<NestingConfig>) => void;
    setMockupTextureUrl: (url: string | null) => void;
    isStanding: boolean;
    setIsStanding: (v: boolean) => void;
}

type StoreSet = (partial: Partial<BoxStore> | ((state: BoxStore) => Partial<BoxStore>)) => void;
type StoreGet = () => BoxStore;

let generationTimer: ReturnType<typeof setTimeout> | null = null;
let generationVersion = 0;
let activeController: AbortController | null = null;

interface GenerationOptions {
    changedKey?: keyof BoxParams;
    delayMs?: number;
    includeNesting?: boolean;
}

function scheduleGeneration(
    set: StoreSet,
    get: StoreGet,
    options: GenerationOptions = {},
): void {
    const { changedKey, delayMs = 70, includeNesting = false } = options;
    if (generationTimer) clearTimeout(generationTimer);
    activeController?.abort();
    const version = ++generationVersion;
    set({
        isGenerating: true,
        isModelCurrent: false,
        generationError: null,
        ...(!includeNesting ? { nestingResult: null, sleeveNestingResult: null } : {}),
    });

    generationTimer = setTimeout(async () => {
        generationTimer = null;
        const controller = new AbortController();
        activeController = controller;
        const snapshot = get();
        try {
            const result = await generateDielineRemote({
                params: snapshot.params,
                nestingConfig: snapshot.nestingConfig,
                changedKey,
                includeNesting,
            }, controller.signal);
            if (version !== generationVersion) return;
            const forceRerender = changedKey === 'boxType';
            set((state) => ({
                params: result.params,
                dieline: result.dieline,
                nestingResult: result.nestingResult,
                sleeveNestingResult: result.sleeveNestingResult,
                isGenerating: false,
                isModelCurrent: true,
                generationError: null,
                clampVersion: result.wasClamped || forceRerender
                    ? state.clampVersion + 1
                    : state.clampVersion,
                ...(forceRerender
                    ? { isStanding: !['pizza', 'tray', 'double_tray'].includes(result.params.boxType) }
                    : {}),
            }));
        } catch (error) {
            if (controller.signal.aborted || version !== generationVersion) return;
            set({
                isGenerating: false,
                isModelCurrent: false,
                generationError: error instanceof Error ? error.message : String(error),
            });
        } finally {
            if (activeController === controller) activeController = null;
        }
    }, delayMs);
}

function applyBoxTypeDefaults(prev: BoxParams, value: BoxParams[keyof BoxParams]): BoxParams {
    const next = { ...prev, boxType: value as BoxParams['boxType'] };
    if (value === 'paper_bag') next.TH = 30;
    else if (prev.boxType === 'paper_bag') next.TH = DEFAULT_PARAMS.TH;

    if (value === 'cup_sleeve') {
        Object.assign(next, {
            SLP: DEFAULT_PARAMS.SLP, lockTab: DEFAULT_PARAMS.lockTab,
            LTW: DEFAULT_PARAMS.LTW, LTH: DEFAULT_PARAMS.LTH,
            HH: DEFAULT_PARAMS.HH, HW: DEFAULT_PARAMS.HW,
            HHL: DEFAULT_PARAMS.HHL, HFH: DEFAULT_PARAMS.HFH,
        });
    } else if (prev.boxType === 'cup_sleeve') {
        Object.assign(next, {
            cupD1: DEFAULT_PARAMS.cupD1, cupD2: DEFAULT_PARAMS.cupD2,
            cupH: DEFAULT_PARAMS.cupH, cupCoverage: DEFAULT_PARAMS.cupCoverage,
        });
    }
    if (value === 'pizza') {
        Object.assign(next, { L: 300, W: 300, D: 40, T: 1.5, C: 1, TH: 15 });
    } else if (prev.boxType === 'pizza') {
        Object.assign(next, {
            L: DEFAULT_PARAMS.L, W: DEFAULT_PARAMS.W, D: DEFAULT_PARAMS.D,
            T: DEFAULT_PARAMS.T, C: DEFAULT_PARAMS.C, TH: DEFAULT_PARAMS.TH,
        });
    }
    if (value === 'envelope') {
        Object.assign(next, {
            envW: DEFAULT_PARAMS.envW, envH: DEFAULT_PARAMS.envH,
            envFH: DEFAULT_PARAMS.envFH, envSF: DEFAULT_PARAMS.envSF,
        });
    }
    if (value === 'tray') {
        Object.assign(next, { L: 200, W: 150, D: 40, T: 1, G: 10, TH: 15, sleeveGlue: 15 });
    }
    if (value === 'double_tray') {
        // [DOUBLE-TRAY 2026-07-26] Mẫu chuẩn 100010-01: thân 361×261, thành 52,
        // bìa 1.5mm, khe lỏng 1mm → nắp tự động 375×275, thành 55.
        Object.assign(next, { L: 361, W: 261, D: 52, T: 1.5, C: 1, G: 5, TH: 15, lidD: 0, lidGap: 1 });
    } else if (prev.boxType === 'double_tray') {
        Object.assign(next, {
            L: DEFAULT_PARAMS.L, W: DEFAULT_PARAMS.W, D: DEFAULT_PARAMS.D,
            T: DEFAULT_PARAMS.T, C: DEFAULT_PARAMS.C, G: DEFAULT_PARAMS.G, TH: DEFAULT_PARAMS.TH,
        });
    }
    // [HANGING-WINDOW 2026-07-27] Preset_Dacdora — mẫu khuôn "hanging electronic
    // product box with window" (L80 × W30 × D140, giấy 0,5mm, mí keo 15, tai đút 15).
    if (value === 'hanging_window') {
        Object.assign(next, { L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15 });
    } else if (prev.boxType === 'hanging_window') {
        Object.assign(next, {
            L: DEFAULT_PARAMS.L, W: DEFAULT_PARAMS.W, D: DEFAULT_PARAMS.D,
            T: DEFAULT_PARAMS.T, C: DEFAULT_PARAMS.C, G: DEFAULT_PARAMS.G, TH: DEFAULT_PARAMS.TH,
        });
    }
    if (value === 'auto_bottom') {
        // Đáy dán cần L > W rõ rệt để 2 tai đáy không đè nhau khi hộp bẹp.
        Object.assign(next, { ABD: DEFAULT_PARAMS.ABD });
    } else if (prev.boxType === 'auto_bottom') {
        Object.assign(next, { ABD: DEFAULT_PARAMS.ABD });
    }
    // [UIUX 2026-07-27] Đáy gài (SLB) & đáy dán: mặc định KHÔNG bật lưỡi khoá nắp.
    // Đây là hai loại duy nhất hiện ô tích này (ParamPanel: isSLB || isAutoBottom);
    // đa số đơn hàng không cần lưỡi khoá, ai cần thì tự tích.
    if (value === 'slb' || value === 'auto_bottom') next.lockTab = false;
    return next;
}

/**
 * [VARIANT 2026-07-29] Áp một biến thể lên bộ tham số hiện tại.
 *
 * Thứ tự BẮT BUỘC (hợp đồng ở Requirement 2.1):
 *   (a) mặc định theo boxType — tái dùng `applyBoxTypeDefaults`, KHÔNG viết lại
 *   (b) `preset` — số đo khởi đầu của biến thể
 *   (c) `lockedParams` — thuộc tính đã chốt, luôn thắng
 *
 * Bước (a) và (b) CHỈ chạy khi thật sự bước sang HỌ HỘP KHÁC. Đổi giữa hai biến
 * thể cùng `boxType` (vd hộp treo có/không cửa sổ) thì giữ nguyên số đo người
 * dùng đang gõ — xoá số đo họ vừa nhập chỉ vì bấm sang card bên cạnh là hành vi
 * gây khó chịu, trong khi `lockedParams` vẫn được áp đủ nên hình vẫn đúng biến thể.
 *
 * Lưu ý vì sao phải bỏ CẢ bước (a), không chỉ bước (b): `applyBoxTypeDefaults`
 * nhúng sẵn preset số đo của một số loại (pizza, tray, double_tray,
 * hanging_window) và áp VÔ ĐIỀU KIỆN khi `value` trùng loại đó — gọi nó với
 * boxType không đổi sẽ tự xoá số đo người dùng. Khi không đổi họ hộp thì cũng
 * chẳng có "mặc định theo boxType" nào cần áp.
 */
function applyVariant(prev: BoxParams, variant: BoxVariant): BoxParams {
    const enteringNewType = prev.boxType !== variant.boxType;
    if (!enteringNewType) return { ...prev, ...variant.lockedParams };
    return {
        ...applyBoxTypeDefaults(prev, variant.boxType),
        ...variant.preset,
        ...variant.lockedParams,
    };
}

export const useBoxStore = create<BoxStore>((set, get) => ({
    params: { ...DEFAULT_PARAMS },
    dieline: null,
    foldProgress: 1,
    viewMode: 'split',
    isAnimating: false,
    clampVersion: 0,
    nestingConfig: structuredClone(DEFAULT_NESTING_CONFIG),
    nestingResult: null,
    sleeveNestingResult: null,
    mockupTextureUrl: null,
    isStanding: !['pizza', 'tray', 'double_tray'].includes(DEFAULT_PARAMS.boxType),
    isGenerating: false,
    isModelCurrent: false,
    generationError: null,
    // [VARIANT 2026-07-29] Biến thể mặc định của boxType khởi tạo (null nếu
    // catalog chưa phủ loại đó — đang phủ dần theo lô).
    variantId: defaultVariantFor(DEFAULT_PARAMS.boxType)?.id ?? null,
    isAdvancedMode: false,

    setIsStanding: (v) => set({ isStanding: v }),
    setParam: (key, value) => {
        const prev = get().params;
        if (key === 'boxType') {
            // [VARIANT 2026-07-29] Đổi boxType phải đồng bộ biến thể, nếu không
            // state sẽ ở trạng thái boxType và variantId trỏ hai nơi khác nhau —
            // form sẽ ẩn/hiện control theo biến thể của LOẠI HỘP CŨ.
            const variant = defaultVariantFor(value as BoxParams['boxType']);
            set({
                params: variant ? applyVariant(prev, variant) : applyBoxTypeDefaults(prev, value),
                variantId: variant?.id ?? null,
            });
        } else {
            set({ params: { ...prev, [key]: value } });
        }
        scheduleGeneration(set, get, { changedKey: key });
    },
    setVariant: (id) => {
        const prev = get().params;
        // Req 2.5: id rác → rơi về biến thể mặc định của boxType hiện tại
        const variant = getVariant(id) ?? defaultVariantFor(prev.boxType);
        if (!variant) {
            // Catalog chưa phủ boxType này: giữ nguyên tham số, bỏ chọn biến thể
            // để form KHÔNG ẩn oan control nào. Không throw, không sinh lại.
            set({ variantId: null });
            return;
        }
        set({ variantId: variant.id, params: applyVariant(prev, variant) });
        // changedKey: 'boxType' để scheduleGeneration bật forceRerender ⇒ clampVersion
        // tăng ⇒ ô nhập remount lấy giá trị mới. BẮT BUỘC kể cả khi boxType KHÔNG
        // đổi (Req 2.2): hai biến thể cùng loại vẫn phải làm mới ô nhập.
        scheduleGeneration(set, get, { changedKey: 'boxType' });
    },
    setAdvancedMode: (v) => set({ isAdvancedMode: v }),
    setParams: (updates) => {
        set({ params: { ...get().params, ...updates } });
        scheduleGeneration(set, get);
    },
    regenerate: (includeNesting = false) => scheduleGeneration(set, get, { delayMs: 0, includeNesting }),
    setFoldProgress: (value) => set({ foldProgress: value }),
    setViewMode: (mode) => set({ viewMode: mode }),
    setIsAnimating: (v) => set({ isAnimating: v }),
    setNestingConfig: (updates) => {
        try {
            set({ nestingConfig: normalizeNestingUpdates(get().nestingConfig, updates) });
        } catch (error) {
            set({ generationError: error instanceof Error ? error.message : String(error), isModelCurrent: false });
            return;
        }
        scheduleGeneration(set, get, { includeNesting: true });
    },
    setMockupTextureUrl: (url) => set({ mockupTextureUrl: url }),
}));
