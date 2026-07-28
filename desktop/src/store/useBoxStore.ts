import { create } from 'zustand';
import { generateDielineRemote } from '../lib/dieline/api';
import { BoxParams, DEFAULT_PARAMS, DielineModel } from '../lib/dieline/types';
import { NestingConfig, NestingResult, DEFAULT_NESTING_CONFIG } from '../lib/dieline/nestingTypes';
import { normalizeNestingUpdates } from '../lib/dieline/runtimeValidation';

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

    setParam: (key: keyof BoxParams, value: BoxParams[keyof BoxParams]) => void;
    setParams: (updates: Partial<BoxParams>) => void;
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

    setIsStanding: (v) => set({ isStanding: v }),
    setParam: (key, value) => {
        const prev = get().params;
        const params = key === 'boxType'
            ? applyBoxTypeDefaults(prev, value)
            : { ...prev, [key]: value };
        set({ params });
        scheduleGeneration(set, get, { changedKey: key });
    },
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
