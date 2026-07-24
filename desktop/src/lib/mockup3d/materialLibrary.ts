// ============================================================
// materialLibrary.ts — Mockup 3D Realism (Logic Layer)
//
// Hai trục độc lập:
//   - Substrate (chất liệu giấy): kraft | sbs-white
//   - Surface finish (gia công): none | matte/gloss lam | spot-UV | foil | emboss
//
// `composeAppearance(substrate, surface)` → PBR + baseColor cho render.
// Legacy `FINISH_LIBRARY` / `getFinish` vẫn có để test + preset cũ.
//
// _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
// ============================================================

import type { FinishId, Panel, SubstrateId, SurfaceFinishId } from './types';

// ─── Substrate (chất liệu giấy) ─────────────────────────────────────────────

export interface SubstrateSpec {
    id: SubstrateId;
    label: string;
    /** Albedo giấy khi chưa in / không có artwork. */
    baseColor: string;
    roughness: number;
    metalness: number;
    clearcoat: number;
    clearcoatRoughness: number;
    sheen: number;
    sheenColor: string;
    sheenRoughness: number;
    envMapIntensity: number;
    grainBumpScale: number;
}

export const DEFAULT_SUBSTRATE_ID: SubstrateId = 'kraft';

export const SUBSTRATE_LIBRARY: Record<SubstrateId, SubstrateSpec> = {
    kraft: {
        id: 'kraft',
        label: 'Giấy kraft',
        baseColor: '#c8a16a',
        roughness: 0.85,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 1.0,
        sheen: 0.28,
        sheenColor: '#c4a574',
        sheenRoughness: 0.75,
        envMapIntensity: 0.45,
        grainBumpScale: 0.04,
    },
    'sbs-white': {
        id: 'sbs-white',
        label: 'Giấy SBS trắng',
        baseColor: '#f3efe7',
        roughness: 0.55,
        metalness: 0.0,
        clearcoat: 0.05,
        clearcoatRoughness: 0.65,
        sheen: 0.08,
        sheenColor: '#ffffff',
        sheenRoughness: 0.8,
        envMapIntensity: 0.6,
        grainBumpScale: 0.015,
    },
};

// ─── Surface finish (gia công) ──────────────────────────────────────────────

export interface SurfaceFinishSpec {
    id: SurfaceFinishId;
    label: string;
    needsMask: boolean;
    /** Nếu set, ghi đè albedo outer (vd foil). */
    overrideBaseColor?: string;
    /** Ghi đè / trộn PBR lên substrate (undefined = giữ substrate). */
    roughness?: number;
    metalness?: number;
    clearcoat?: number;
    clearcoatRoughness?: number;
    sheen?: number;
    sheenColor?: string;
    sheenRoughness?: number;
    envMapIntensity?: number;
    /** Hệ số nhân grain substrate (0 = tắt grain khi đã cán/foil). */
    grainScale?: number;
}

export const DEFAULT_SURFACE_FINISH_ID: SurfaceFinishId = 'none';

export const SURFACE_FINISH_LIBRARY: Record<SurfaceFinishId, SurfaceFinishSpec> = {
    none: {
        id: 'none',
        label: 'Không gia công',
        needsMask: false,
        grainScale: 1,
    },
    'matte-lam': {
        id: 'matte-lam',
        label: 'Cán màng mờ',
        needsMask: false,
        roughness: 0.7,
        metalness: 0.0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.55,
        sheen: 0,
        envMapIntensity: 0.55,
        grainScale: 0.25,
    },
    'gloss-lam': {
        id: 'gloss-lam',
        label: 'Cán màng bóng',
        needsMask: false,
        roughness: 0.12,
        metalness: 0.0,
        clearcoat: 0.85,
        clearcoatRoughness: 0.08,
        sheen: 0,
        envMapIntensity: 0.85,
        grainScale: 0,
    },
    'spot-uv': {
        id: 'spot-uv',
        label: 'Phủ UV định vị (spot-UV)',
        needsMask: true,
        // Nền matte; vùng mask → gloss (shader)
        roughness: 0.7,
        metalness: 0.0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.5,
        sheen: 0,
        envMapIntensity: 0.6,
        grainScale: 0.2,
    },
    'foil-metallic': {
        id: 'foil-metallic',
        label: 'Ép kim / metallic',
        needsMask: false,
        overrideBaseColor: '#d8d2c2',
        roughness: 0.25,
        metalness: 0.9,
        clearcoat: 0.5,
        clearcoatRoughness: 0.12,
        sheen: 0,
        envMapIntensity: 0.7,
        grainScale: 0,
    },
    emboss: {
        id: 'emboss',
        label: 'Dập nổi (emboss)',
        needsMask: true,
        roughness: 0.6,
        metalness: 0.0,
        clearcoat: 0.05,
        clearcoatRoughness: 0.7,
        sheen: 0.05,
        sheenColor: '#e8e0d0',
        sheenRoughness: 0.7,
        envMapIntensity: 0.5,
        grainScale: 0.5,
    },
};

// ─── Compose appearance ─────────────────────────────────────────────────────

export interface PhysicalFinishScalars {
    roughness: number;
    metalness: number;
    clearcoat: number;
    clearcoatRoughness: number;
    sheen: number;
    sheenColor: string;
    sheenRoughness: number;
    envMapIntensity: number;
    grainBumpScale: number;
}

/** Kết quả gộp substrate + surface cho render. */
export interface AppearanceSpec {
    substrateId: SubstrateId;
    surfaceFinishId: SurfaceFinishId;
    /** Nhãn ngắn cho badge UI. */
    label: string;
    baseColor: string;
    needsSpotUvMask: boolean;
    needsEmbossMask: boolean;
    phys: PhysicalFinishScalars;
}

function unit(value: number | undefined, fallback: number): number {
    if (value === undefined || Number.isNaN(value)) return fallback;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export function getSubstrate(id: SubstrateId | string | undefined): SubstrateSpec {
    if (id && id in SUBSTRATE_LIBRARY) return SUBSTRATE_LIBRARY[id as SubstrateId];
    return SUBSTRATE_LIBRARY[DEFAULT_SUBSTRATE_ID];
}

/**
 * Màu mặt trong (giấy bồi) theo chất liệu — độc lập với gia công bề mặt.
 * SBS → trắng ngà; kraft → nâu kraft (không dùng edgeColor).
 */
export function substrateInnerFaceColor(substrateId: SubstrateId | string | undefined): string {
    const id = getSubstrate(substrateId).id;
    return id === 'sbs-white' ? '#ebe6dc' : '#a9784a';
}

/** Gợi ý màu cạnh giấy khớp substrate (SBS → trắng, kraft → kraft). */
export function substrateDefaultEdgeColor(substrateId: SubstrateId | string | undefined): 'kraft' | 'white' {
    return getSubstrate(substrateId).id === 'sbs-white' ? 'white' : 'kraft';
}

export function getSurfaceFinish(id: SurfaceFinishId | string | undefined): SurfaceFinishSpec {
    if (id && id in SURFACE_FINISH_LIBRARY) return SURFACE_FINISH_LIBRARY[id as SurfaceFinishId];
    return SURFACE_FINISH_LIBRARY[DEFAULT_SURFACE_FINISH_ID];
}

/**
 * Ghép chất liệu giấy + gia công → PBR/baseColor.
 * Surface ghi đè kênh có set; grain = substrate × surface.grainScale.
 */
export function composeAppearance(
    substrateId: SubstrateId | string | undefined,
    surfaceFinishId: SurfaceFinishId | string | undefined,
): AppearanceSpec {
    const sub = getSubstrate(substrateId);
    const surf = getSurfaceFinish(surfaceFinishId);
    const grainScale = surf.grainScale === undefined ? 1 : unit(surf.grainScale, 1);

    const phys: PhysicalFinishScalars = {
        roughness: unit(surf.roughness ?? sub.roughness, 0.5),
        metalness: unit(surf.metalness ?? sub.metalness, 0.0),
        clearcoat: unit(surf.clearcoat ?? sub.clearcoat, 0.0),
        clearcoatRoughness: unit(surf.clearcoatRoughness ?? sub.clearcoatRoughness, 1.0),
        sheen: unit(surf.sheen !== undefined ? surf.sheen : sub.sheen, 0.0),
        sheenColor: surf.sheenColor ?? sub.sheenColor,
        sheenRoughness: unit(surf.sheenRoughness ?? sub.sheenRoughness, 1.0),
        envMapIntensity: unit(surf.envMapIntensity ?? sub.envMapIntensity, 1.0),
        grainBumpScale: unit(sub.grainBumpScale * grainScale, 0.0),
    };

    const label =
        surf.id === 'none'
            ? sub.label
            : `${sub.label} · ${surf.label}`;

    return {
        substrateId: sub.id,
        surfaceFinishId: surf.id,
        label,
        baseColor: surf.overrideBaseColor ?? sub.baseColor,
        needsSpotUvMask: surf.id === 'spot-uv',
        needsEmbossMask: surf.id === 'emboss',
        phys,
    };
}

/**
 * Migrate legacy FinishId (1 trục) → substrate + surface.
 * kraft/sbs → giấy + none; finish khác → kraft + finish đó.
 */
export function migrateLegacyFinishId(id: string | undefined | null): {
    substrateId: SubstrateId;
    surfaceFinishId: SurfaceFinishId;
} {
    if (id === 'kraft' || id === 'sbs-white') {
        return { substrateId: id, surfaceFinishId: 'none' };
    }
    if (
        id === 'matte-lam'
        || id === 'gloss-lam'
        || id === 'spot-uv'
        || id === 'foil-metallic'
        || id === 'emboss'
    ) {
        return { substrateId: DEFAULT_SUBSTRATE_ID, surfaceFinishId: id };
    }
    return { substrateId: DEFAULT_SUBSTRATE_ID, surfaceFinishId: DEFAULT_SURFACE_FINISH_ID };
}

// ─── Legacy FinishSpec / FINISH_LIBRARY (test + preset cũ) ──────────────────

export interface FinishSpec {
    id: FinishId;
    label: string;
    roughness: number;
    metalness: number;
    needsMask: boolean;
    clearcoat?: number;
    clearcoatRoughness?: number;
    sheen?: number;
    sheenColor?: string;
    sheenRoughness?: number;
    envMapIntensity?: number;
    grainBumpScale?: number;
}

export const DEFAULT_FINISH_ID: FinishId = 'kraft';

/** Legacy 1-axis library — mỗi id map sang composeAppearance tương đương. */
export const FINISH_LIBRARY: Record<FinishId, FinishSpec> = (() => {
    const ids: FinishId[] = [
        'kraft', 'sbs-white', 'matte-lam', 'gloss-lam', 'spot-uv', 'foil-metallic', 'emboss',
    ];
    const out = {} as Record<FinishId, FinishSpec>;
    for (const id of ids) {
        const { substrateId, surfaceFinishId } = migrateLegacyFinishId(id);
        const a = composeAppearance(substrateId, surfaceFinishId);
        out[id] = {
            id,
            label: a.label,
            roughness: a.phys.roughness,
            metalness: a.phys.metalness,
            needsMask: a.needsSpotUvMask || a.needsEmbossMask,
            clearcoat: a.phys.clearcoat,
            clearcoatRoughness: a.phys.clearcoatRoughness,
            sheen: a.phys.sheen,
            sheenColor: a.phys.sheenColor,
            sheenRoughness: a.phys.sheenRoughness,
            envMapIntensity: a.phys.envMapIntensity,
            grainBumpScale: a.phys.grainBumpScale,
        };
    }
    return out;
})();

export function getFinish(id: FinishId): FinishSpec {
    return FINISH_LIBRARY[id] ?? FINISH_LIBRARY[DEFAULT_FINISH_ID];
}

export function resolvePhysicalScalars(spec: FinishSpec): PhysicalFinishScalars {
    return {
        roughness: unit(spec.roughness, 0.5),
        metalness: unit(spec.metalness, 0.0),
        clearcoat: unit(spec.clearcoat, 0.0),
        clearcoatRoughness: unit(spec.clearcoatRoughness, 1.0),
        sheen: unit(spec.sheen, 0.0),
        sheenColor: typeof spec.sheenColor === 'string' && spec.sheenColor.length > 0
            ? spec.sheenColor
            : '#ffffff',
        sheenRoughness: unit(spec.sheenRoughness, 1.0),
        envMapIntensity: unit(spec.envMapIntensity, 1.0),
        grainBumpScale: unit(spec.grainBumpScale, 0.0),
    };
}

export function applyFinishToAllPanels(panels: readonly Panel[], id: FinishId): FinishSpec[] {
    const spec = getFinish(id);
    return panels.map(() => spec);
}

// ─── Spot-UV / emboss helpers ───────────────────────────────────────────────

export const SPOT_UV_MASK_THRESHOLD = 0.5;
export const SPOT_UV_GLOSS_ROUGHNESS = 0.08;
export const SPOT_UV_GLOSS_CLEARCOAT = 0.9;
export const SPOT_UV_GLOSS_CLEARCOAT_ROUGHNESS = 0.06;

export function isSpotUvPixelActive(
    maskValue: number,
    threshold: number = SPOT_UV_MASK_THRESHOLD,
): boolean {
    if (Number.isNaN(maskValue)) return false;
    return maskValue > threshold;
}

export function mapSpotUvRoughness(
    maskValue: number,
    baseRoughness: number,
    glossRoughness: number = SPOT_UV_GLOSS_ROUGHNESS,
): number {
    return isSpotUvPixelActive(maskValue) ? glossRoughness : baseRoughness;
}

export function mapSpotUvClearcoat(
    maskValue: number,
    baseClearcoat: number,
    glossClearcoat: number = SPOT_UV_GLOSS_CLEARCOAT,
): number {
    return isSpotUvPixelActive(maskValue) ? glossClearcoat : baseClearcoat;
}

export const EMBOSS_MIN_HEIGHT_MM = 0.0;
export const EMBOSS_MAX_HEIGHT_MM = 5.0;

export function clampEmbossHeight(rawHeight: number | undefined): number {
    if (rawHeight === undefined || Number.isNaN(rawHeight) || rawHeight < EMBOSS_MIN_HEIGHT_MM) {
        return EMBOSS_MIN_HEIGHT_MM;
    }
    if (rawHeight > EMBOSS_MAX_HEIGHT_MM) return EMBOSS_MAX_HEIGHT_MM;
    return rawHeight;
}

// ─── Lookdev quality / exposure ─────────────────────────────────────────────

export type MockupQualityTier = 'balanced' | 'high';

export function envMapResolutionForTier(tier: MockupQualityTier): number {
    return tier === 'high' ? 512 : 256;
}

export const TONE_EXPOSURE_MIN = 0.7;
export const TONE_EXPOSURE_MAX = 1.4;
export const DEFAULT_TONE_EXPOSURE = 1.0;

export function clampToneExposure(raw: number | undefined): number {
    if (raw === undefined || Number.isNaN(raw)) return DEFAULT_TONE_EXPOSURE;
    if (raw < TONE_EXPOSURE_MIN) return TONE_EXPOSURE_MIN;
    if (raw > TONE_EXPOSURE_MAX) return TONE_EXPOSURE_MAX;
    return raw;
}
