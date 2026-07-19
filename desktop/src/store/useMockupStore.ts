// ============================================================
// useMockupStore — Mockup 3D Realism (State Layer)
//
// Store Zustand RIÊNG cho lớp mockup 3D, TÁCH BIỆT hoàn toàn khỏi
// `useBoxStore` (đường dẫn sinh dieline). Store này chỉ giữ state
// trình bày/vật liệu/ảnh nghệ thuật của mockup và KHÔNG chạm vào
// `params`/`dieline`/`foldProgress` của `useBoxStore` lõi.
//
// Theo nguyên tắc cách ly (Yêu cầu 9): generator và `types.ts` giữ
// nguyên; tính năng mới bổ sung state ở store riêng, đọc dữ liệu
// dieline read-only ở lớp render.
//
// _Requirements: 4.4, 5.4, 7.4_
// ============================================================

import { create } from 'zustand';
import type {
    EdgeColor,
    FinishId,
    ExportScale,
    PlacementMode,
    ArtworkTransform,
} from '../lib/mockup3d/types';
import { DEFAULT_EDGE_COLOR } from '../lib/mockup3d/panelSolid';
import { DEFAULT_FINISH_ID } from '../lib/mockup3d/materialLibrary';
import { clampArtworkTransform } from '../lib/mockup3d/artworkMapping';

// ─── Hằng số preset & miền giá trị ──────────────────────────────────────────

/** Preset camera hợp lệ (đúng 4 preset — Yêu cầu 7.1). */
export type CameraPreset = 'front' | 'top' | 'isometric' | 'orthographic';

/** Id preset HDRI studio mặc định (≥3 preset do lớp render cung cấp — Yêu cầu 3.2). */
export const DEFAULT_HDRI_PRESET = 'studio-soft';

/** Id preset nền/sàn mặc định (≥2 preset — Yêu cầu 7.3). */
export const DEFAULT_BACKGROUND_PRESET = 'studio-white';

/** Miền hệ số tách exploded view (Yêu cầu 7.5). */
export const EXPLODED_FACTOR_MIN = 0.0;
export const EXPLODED_FACTOR_MAX = 5.0;

/** Miền độ cao dập nổi emboss, đơn vị mm (Yêu cầu 4.5). */
export const EMBOSS_HEIGHT_MIN_MM = 0.0;
export const EMBOSS_HEIGHT_MAX_MM = 5.0;

/** Trạng thái nạp tài nguyên HDRI (Yêu cầu 3.6). */
export type HdriStatus = 'loading' | 'ready' | 'failed';

/** Cấu hình ảnh nghệ thuật cho một mặt (ngoài/trong). */
export interface ArtworkFaceConfig {
    url: string | null;
    transform: ArtworkTransform;
}

/** Cấu hình ảnh nghệ thuật mặt trong (có cờ bật/tắt riêng). */
export interface ArtworkInnerConfig extends ArtworkFaceConfig {
    enabled: boolean;
}

/** Toàn bộ cấu hình ảnh nghệ thuật của mockup. */
export interface ArtworkConfig {
    outer: ArtworkFaceConfig;
    inner: ArtworkInnerConfig;
    mode: PlacementMode;
    showBleedSafe: boolean;
    spotUvMaskUrl: string | null;
    embossMaskUrl: string | null;
    embossHeightMm: number;
}

// ─── State Shape ────────────────────────────────────────────────────────────

export interface MockupState {
    // ═══ Vật liệu / cạnh ═══
    edgeColor: EdgeColor; // 'kraft' | 'white', mặc định 'kraft'
    finishId: FinishId; // mặc định 'kraft'

    // ═══ Môi trường / trình bày ═══
    hdriPreset: string; // id preset HDRI (≥3 preset)
    cameraPreset: CameraPreset;
    backgroundPreset: string; // ≥2 preset nền/sàn
    explodedFactor: number; // 0.0..5.0, 0 = lắp ráp
    showDimensions: boolean;
    /** Overlay CUT/CREASE phục vụ kiểm tra kỹ thuật; mặc định tắt ở mockup sạch. */
    showTechnicalLines: boolean;
    /** Lưới sàn tham chiếu; mặc định tắt để cảnh studio không giống chế độ debug. */
    showFloorGrid: boolean;

    // ═══ Ảnh nghệ thuật ═══
    artwork: ArtworkConfig;
    /** Bật chế độ kéo ảnh TRỰC TIẾP trên mặt 3D (tắt xoay quỹ đạo khi bật). */
    artworkEditMode: boolean;
    /** Lịch sử artwork để Hoàn tác (undo). Mới nhất ở cuối. */
    artworkPast: ArtworkConfig[];
    /** Ngăn xếp Làm lại (redo). */
    artworkFuture: ArtworkConfig[];

    // ═══ Xuất ═══
    exportScale: ExportScale; // mặc định 1
    /** Xuất PNG nền TRONG SUỐT (ẩn nền/sàn, alpha=0). */
    exportTransparent: boolean;

    // ═══ Cầu nối xuất cảnh (request → component trong Canvas) ═══
    // useSceneExport PHẢI chạy bên trong <Canvas> (dùng useThree). Các nút
    // xuất nằm ở panel DOM (ngoài Canvas) nên không thể gọi hook trực tiếp.
    // Thay vào đó, panel tăng một "nonce"; một component cầu nối bên trong
    // Canvas lắng nghe thay đổi nonce và thực thi xuất PNG/GLB (Yêu cầu 6.1, 6.6).
    exportPngNonce: number;
    exportGlbNonce: number;
    /** Nonce yêu cầu xuất BATCH nhiều góc camera (PNG). */
    exportBatchNonce: number;

    // Nonce yêu cầu canh lại góc nhìn (Fit/Reset). Panel DOM ngoài Canvas tăng
    // nonce; CameraRig (trong Canvas) lắng nghe để canh camera về preset hiện tại.
    cameraResetNonce: number;

    // ═══ Trạng thái runtime ═══
    hdriStatus: HdriStatus;
    webglSupported: boolean;
    /** Đã có cấu hình cảnh lưu trong localStorage hay chưa (bật nút Khôi phục). */
    scenePresetSaved: boolean;

    // ─── Actions ──────────────────────────────────────────────────────────
    setEdgeColor: (color: EdgeColor) => void;
    setFinishId: (id: FinishId) => void;
    setHdriPreset: (preset: string) => void;
    setCameraPreset: (preset: CameraPreset) => void;
    setBackgroundPreset: (preset: string) => void;
    setExplodedFactor: (factor: number) => void;
    setShowDimensions: (show: boolean) => void;
    setShowTechnicalLines: (show: boolean) => void;
    setShowFloorGrid: (show: boolean) => void;
    setExportScale: (scale: ExportScale) => void;
    setExportTransparent: (v: boolean) => void;
    setHdriStatus: (status: HdriStatus) => void;
    setWebglSupported: (supported: boolean) => void;

    // Yêu cầu xuất cảnh (cầu nối ra component trong Canvas)
    requestExportPng: () => void;
    requestExportGlb: () => void;
    /** Yêu cầu xuất nhiều góc camera (batch PNG). */
    requestExportBatch: () => void;
    /** Yêu cầu canh lại góc nhìn (Fit/Reset) về preset camera hiện tại. */
    requestCameraReset: () => void;

    // Hoàn tác / Làm lại cấu hình ảnh nghệ thuật.
    undoArtwork: () => void;
    redoArtwork: () => void;

    // Lưu / khôi phục cấu hình cảnh (finish, môi trường, transform ảnh) vào
    // localStorage. KHÔNG lưu URL ảnh (object URL không bền giữa các phiên).
    saveScenePreset: () => void;
    loadScenePreset: () => void;

    // Ảnh nghệ thuật — mặt ngoài / mặt trong độc lập (Yêu cầu 5.4)
    setOuterArtworkUrl: (url: string | null) => void;
    setOuterArtworkTransform: (transform: ArtworkTransform) => void;
    setInnerArtworkEnabled: (enabled: boolean) => void;
    setInnerArtworkUrl: (url: string | null) => void;
    setInnerArtworkTransform: (transform: ArtworkTransform) => void;
    setArtworkMode: (mode: PlacementMode) => void;
    setArtworkEditMode: (v: boolean) => void;
    setShowBleedSafe: (show: boolean) => void;
    setSpotUvMaskUrl: (url: string | null) => void;
    setEmbossMaskUrl: (url: string | null) => void;
    setEmbossHeightMm: (height: number) => void;
    resetMockup: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Giới hạn một số về đoạn [min, max]; đầu vào không hữu hạn → `fallback`. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/** Transform mặc định: scale 100%, offset 0%, xoay 0°. */
const DEFAULT_TRANSFORM: ArtworkTransform = { scalePct: 100, offsetXPct: 0, offsetYPct: 0, rotationDeg: 0, flipH: false, flipV: false };

/** Khóa localStorage cho cấu hình cảnh đã lưu. */
const SCENE_PRESET_KEY = 'prynx.mockup.scenePreset.v1';

/** Giới hạn số bước hoàn tác và cửa sổ gộp thao tác liên tiếp (ms). */
const HISTORY_LIMIT = 60;
const HISTORY_COALESCE_MS = 450;
/** Mốc thời gian thao tác gần nhất (gộp kéo slider thành 1 bước undo). */
let lastEditTs = 0;

function artworkUrls(config: ArtworkConfig): (string | null)[] {
    return [config.outer.url, config.inner.url, config.spotUvMaskUrl, config.embossMaskUrl];
}

function releaseArtworkResources(configs: ArtworkConfig[], keep: ArtworkConfig | null): void {
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    const retained = new Set(keep ? artworkUrls(keep).filter(Boolean) : []);
    const stale = new Set<string>();
    for (const config of configs) {
        for (const url of artworkUrls(config)) {
            if (url?.startsWith('blob:') && !retained.has(url)) stale.add(url);
        }
    }
    if (stale.size > 0) setTimeout(() => stale.forEach((url) => URL.revokeObjectURL(url)), 0);
}

/** URL blobs are session resources, not undo state. Replacing one clears URL
 * snapshots so undo can never resurrect a revoked object URL. */
function replaceArtworkResources(state: MockupState, artwork: ArtworkConfig): Partial<MockupState> {
    releaseArtworkResources(
        [state.artwork, ...state.artworkPast, ...state.artworkFuture],
        artwork,
    );
    lastEditTs = 0;
    return { artwork, artworkPast: [], artworkFuture: [] };
}

/** Đẩy snapshot artwork hiện tại vào lịch sử rồi áp artwork mới.
 *  `coalesce` = true → gộp với bước trước nếu xảy ra trong HISTORY_COALESCE_MS
 *  (tránh mỗi lần kéo slider tạo 1 bước undo). */
function withArtworkHistory(
    state: MockupState,
    nextArtwork: ArtworkConfig,
    coalesce = false,
): Partial<MockupState> {
    const now = Date.now();
    const merge = coalesce && now - lastEditTs < HISTORY_COALESCE_MS;
    lastEditTs = now;
    const artworkPast = merge
        ? state.artworkPast
        : [...state.artworkPast, state.artwork].slice(-HISTORY_LIMIT);
    return { artwork: nextArtwork, artworkPast, artworkFuture: [] };
}

/** Đọc xem đã có cấu hình cảnh lưu chưa (an toàn khi không có localStorage). */
function readScenePresetExists(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(SCENE_PRESET_KEY) != null;
    } catch {
        return false;
    }
}

/** State khởi tạo (cũng dùng cho `resetMockup`). */
function createInitialState(): Omit<
    MockupState,
    | 'setEdgeColor' | 'setFinishId' | 'setHdriPreset' | 'setCameraPreset'
    | 'setBackgroundPreset' | 'setExplodedFactor' | 'setShowDimensions'
    | 'setShowTechnicalLines' | 'setShowFloorGrid'
    | 'setExportScale' | 'setHdriStatus' | 'setWebglSupported'
    | 'setExportTransparent'
    | 'requestExportPng' | 'requestExportGlb'
    | 'requestExportBatch'
    | 'requestCameraReset'
    | 'undoArtwork' | 'redoArtwork'
    | 'saveScenePreset' | 'loadScenePreset'
    | 'setOuterArtworkUrl' | 'setOuterArtworkTransform' | 'setInnerArtworkEnabled'
    | 'setInnerArtworkUrl' | 'setInnerArtworkTransform' | 'setArtworkMode'
    | 'setArtworkMode'
    | 'setArtworkEditMode'
    | 'setShowBleedSafe' | 'setSpotUvMaskUrl' | 'setEmbossMaskUrl'
    | 'setEmbossHeightMm' | 'resetMockup'
> {
    return {
        edgeColor: DEFAULT_EDGE_COLOR,
        finishId: DEFAULT_FINISH_ID,
        hdriPreset: DEFAULT_HDRI_PRESET,
        cameraPreset: 'isometric',
        backgroundPreset: DEFAULT_BACKGROUND_PRESET,
        explodedFactor: EXPLODED_FACTOR_MIN,
        showDimensions: false,
        showTechnicalLines: false,
        showFloorGrid: false,
        artwork: {
            outer: { url: null, transform: { ...DEFAULT_TRANSFORM } },
            inner: { enabled: false, url: null, transform: { ...DEFAULT_TRANSFORM } },
            mode: 'aligned-to-dieline',
            showBleedSafe: false,
            spotUvMaskUrl: null,
            embossMaskUrl: null,
            embossHeightMm: EMBOSS_HEIGHT_MIN_MM,
        },
        artworkPast: [],
        artworkFuture: [],
        artworkEditMode: false,
        exportScale: 1,
        exportTransparent: false,
        exportPngNonce: 0,
        exportGlbNonce: 0,
        exportBatchNonce: 0,
        cameraResetNonce: 0,
        hdriStatus: 'loading',
        webglSupported: true,
        scenePresetSaved: readScenePresetExists(),
    };
}

// ─── Store Definition ─────────────────────────────────────────────────────

export const useMockupStore = create<MockupState>((set) => ({
    ...createInitialState(),

    setEdgeColor: (color) => set({ edgeColor: color }),
    setFinishId: (id) => set({ finishId: id }),
    setHdriPreset: (preset) => set({ hdriPreset: preset }),
    setCameraPreset: (preset) => set({ cameraPreset: preset }),
    setBackgroundPreset: (preset) => set({ backgroundPreset: preset }),
    setExplodedFactor: (factor) =>
        set({ explodedFactor: clampNumber(factor, EXPLODED_FACTOR_MIN, EXPLODED_FACTOR_MAX, EXPLODED_FACTOR_MIN) }),
    setShowDimensions: (show) => set({ showDimensions: show }),
    setShowTechnicalLines: (show) => set({ showTechnicalLines: show }),
    setShowFloorGrid: (show) => set({ showFloorGrid: show }),
    setExportScale: (scale) => set({ exportScale: scale }),
    setExportTransparent: (v) => set({ exportTransparent: v }),
    setHdriStatus: (status) => set({ hdriStatus: status }),
    setWebglSupported: (supported) => set({ webglSupported: supported }),

    // Bump nonce để component cầu nối trong Canvas thực thi xuất (Yêu cầu 6.1, 6.6).
    requestExportPng: () => set((state) => ({ exportPngNonce: state.exportPngNonce + 1 })),
    requestExportGlb: () => set((state) => ({ exportGlbNonce: state.exportGlbNonce + 1 })),
    requestExportBatch: () => set((state) => ({ exportBatchNonce: state.exportBatchNonce + 1 })),
    requestCameraReset: () => set((state) => ({ cameraResetNonce: state.cameraResetNonce + 1 })),

    // ── Hoàn tác / Làm lại artwork ──
    undoArtwork: () =>
        set((state) => {
            if (state.artworkPast.length === 0) return {};
            const prev = state.artworkPast[state.artworkPast.length - 1];
            lastEditTs = 0; // tách bước kế tiếp khỏi gộp
            return {
                artwork: prev,
                artworkPast: state.artworkPast.slice(0, -1),
                artworkFuture: [state.artwork, ...state.artworkFuture].slice(0, HISTORY_LIMIT),
            };
        }),
    redoArtwork: () =>
        set((state) => {
            if (state.artworkFuture.length === 0) return {};
            const next = state.artworkFuture[0];
            lastEditTs = 0;
            return {
                artwork: next,
                artworkPast: [...state.artworkPast, state.artwork].slice(-HISTORY_LIMIT),
                artworkFuture: state.artworkFuture.slice(1),
            };
        }),

    // ── Lưu / khôi phục cấu hình cảnh (localStorage, KHÔNG gồm URL ảnh) ──
    saveScenePreset: () =>
        set((state) => {
            try {
                const data = {
                    finishId: state.finishId,
                    edgeColor: state.edgeColor,
                    hdriPreset: state.hdriPreset,
                    cameraPreset: state.cameraPreset,
                    backgroundPreset: state.backgroundPreset,
                    explodedFactor: state.explodedFactor,
                    showDimensions: state.showDimensions,
                    showTechnicalLines: state.showTechnicalLines,
                    showFloorGrid: state.showFloorGrid,
                    exportScale: state.exportScale,
                    exportTransparent: state.exportTransparent,
                    artwork: {
                        mode: state.artwork.mode,
                        showBleedSafe: state.artwork.showBleedSafe,
                        embossHeightMm: state.artwork.embossHeightMm,
                        outerTransform: state.artwork.outer.transform,
                        innerEnabled: state.artwork.inner.enabled,
                        innerTransform: state.artwork.inner.transform,
                    },
                };
                localStorage.setItem(SCENE_PRESET_KEY, JSON.stringify(data));
                return { scenePresetSaved: true };
            } catch {
                return {};
            }
        }),
    loadScenePreset: () =>
        set((state) => {
            try {
                const raw = localStorage.getItem(SCENE_PRESET_KEY);
                if (!raw) return {};
                const d = JSON.parse(raw);
                const a = d.artwork ?? {};
                return {
                    finishId: d.finishId ?? state.finishId,
                    edgeColor: d.edgeColor ?? state.edgeColor,
                    hdriPreset: d.hdriPreset ?? state.hdriPreset,
                    cameraPreset: d.cameraPreset ?? state.cameraPreset,
                    backgroundPreset: d.backgroundPreset ?? state.backgroundPreset,
                    explodedFactor: clampNumber(d.explodedFactor, EXPLODED_FACTOR_MIN, EXPLODED_FACTOR_MAX, state.explodedFactor),
                    showDimensions: !!d.showDimensions,
                    showTechnicalLines: !!d.showTechnicalLines,
                    showFloorGrid: !!d.showFloorGrid,
                    exportScale: (d.exportScale === 2 || d.exportScale === 4 ? d.exportScale : 1) as ExportScale,
                    exportTransparent: !!d.exportTransparent,
                    // Giữ URL ảnh hiện tại, chỉ khôi phục transform/cờ.
                    artwork: {
                        ...state.artwork,
                        mode: a.mode ?? state.artwork.mode,
                        showBleedSafe: !!a.showBleedSafe,
                        embossHeightMm: clampNumber(a.embossHeightMm, EMBOSS_HEIGHT_MIN_MM, EMBOSS_HEIGHT_MAX_MM, state.artwork.embossHeightMm),
                        outer: { ...state.artwork.outer, transform: clampArtworkTransform(a.outerTransform ?? state.artwork.outer.transform) },
                        inner: {
                            ...state.artwork.inner,
                            enabled: !!a.innerEnabled,
                            transform: clampArtworkTransform(a.innerTransform ?? state.artwork.inner.transform),
                        },
                    },
                    artworkPast: [],
                    artworkFuture: [],
                };
            } catch {
                return {};
            }
        }),

    // ── Ảnh nghệ thuật: mặt ngoài và mặt trong cập nhật độc lập (Yêu cầu 5.4) ──
    setOuterArtworkUrl: (url) =>
        set((state) => replaceArtworkResources(state, { ...state.artwork, outer: { ...state.artwork.outer, url } })),
    setOuterArtworkTransform: (transform) =>
        set((state) => withArtworkHistory(
            state,
            { ...state.artwork, outer: { ...state.artwork.outer, transform: clampArtworkTransform(transform) } },
            true,
        )),
    setInnerArtworkEnabled: (enabled) =>
        set((state) => withArtworkHistory(state, { ...state.artwork, inner: { ...state.artwork.inner, enabled } })),
    setInnerArtworkUrl: (url) =>
        set((state) => replaceArtworkResources(state, { ...state.artwork, inner: { ...state.artwork.inner, url } })),
    setInnerArtworkTransform: (transform) =>
        set((state) => withArtworkHistory(
            state,
            { ...state.artwork, inner: { ...state.artwork.inner, transform: clampArtworkTransform(transform) } },
            true,
        )),
    setArtworkMode: (mode) => set((state) => withArtworkHistory(state, { ...state.artwork, mode })),
    setArtworkEditMode: (v) => set({ artworkEditMode: v }),
    setShowBleedSafe: (show) => set((state) => withArtworkHistory(state, { ...state.artwork, showBleedSafe: show })),
    setSpotUvMaskUrl: (url) => set((state) => replaceArtworkResources(state, { ...state.artwork, spotUvMaskUrl: url })),
    setEmbossMaskUrl: (url) => set((state) => replaceArtworkResources(state, { ...state.artwork, embossMaskUrl: url })),
    setEmbossHeightMm: (height) =>
        set((state) => withArtworkHistory(
            state,
            {
                ...state.artwork,
                embossHeightMm: clampNumber(height, EMBOSS_HEIGHT_MIN_MM, EMBOSS_HEIGHT_MAX_MM, EMBOSS_HEIGHT_MIN_MM),
            },
            true,
        )),

    resetMockup: () => set((state) => {
        releaseArtworkResources([state.artwork, ...state.artworkPast, ...state.artworkFuture], null);
        lastEditTs = 0;
        return createInitialState();
    }),
}));
