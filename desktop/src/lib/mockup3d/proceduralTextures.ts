// ============================================================
// proceduralTextures.ts — Mockup 3D (Logic / texture factory)
//
// Sinh map procedural phía client, 0 request mạng:
//   - Kraft / paper fiber grain (bump + optional roughness hint)
// Cache theo kích thước; deterministic với seed cố định.
// ============================================================

/** Seed mặc định cho grain (ổn định giữa các lần render / test). */
export const KRAFT_GRAIN_SEED = 0x4b524146; // 'KRAF'

export interface KraftGrainMaps {
    /** Kích thước cạnh (px). */
    size: number;
    /** Buffer RGBA raw (linear data, NoColorSpace khi gán bump). */
    rgba: Uint8ClampedArray;
    /** Hash FNV-1a 32-bit của buffer — test determinism. */
    hash: number;
}

/** Mulberry32 PRNG — deterministic, pure. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** FNV-1a 32-bit trên buffer. */
export function hashRgba(data: Uint8ClampedArray | Uint8Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
        h ^= data[i];
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * Sinh bump map sợi giấy kraft (value noise + sọc ngang/dọc nhẹ).
 * Pure: không DOM / three. Size clamp [64, 1024], power-of-two khuyến nghị.
 */
export function buildKraftGrainRgba(
    size: number = 256,
    seed: number = KRAFT_GRAIN_SEED,
): KraftGrainMaps {
    const s = Math.max(64, Math.min(1024, Math.floor(size) || 256));
    const rand = mulberry32(seed ^ s);
    const rgba = new Uint8ClampedArray(s * s * 4);

    // Value noise grid (16×16 cells) + bilinear sample
    const cells = 16;
    const grid: number[] = new Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rand();

    const sample = (u: number, v: number): number => {
        const x = u * cells;
        const y = v * cells;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const i00 = y0 * (cells + 1) + x0;
        const i10 = i00 + 1;
        const i01 = i00 + (cells + 1);
        const i11 = i01 + 1;
        const a = grid[i00] * (1 - fx) + grid[i10] * fx;
        const b = grid[i01] * (1 - fx) + grid[i11] * fx;
        return a * (1 - fy) + b * fy;
    };

    for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
            const u = x / s;
            const v = y / s;
            // Fiber: ngang mạnh hơn dọc (giấy kraft)
            const n1 = sample(u * 2.3, v * 0.85);
            const n2 = sample(u * 0.4 + 3.1, v * 3.7);
            const fiberH = Math.sin((y + n1 * 4) * 0.35) * 0.5 + 0.5;
            const fiberV = Math.sin((x + n2 * 3) * 0.12) * 0.5 + 0.5;
            const mottled = n1 * 0.55 + n2 * 0.25 + fiberH * 0.12 + fiberV * 0.08;
            const g = Math.max(0, Math.min(255, Math.round(mottled * 255)));
            const i = (y * s + x) * 4;
            rgba[i] = g;
            rgba[i + 1] = g;
            rgba[i + 2] = g;
            rgba[i + 3] = 255;
        }
    }

    return { size: s, rgba, hash: hashRgba(rgba) };
}

// ─── Canvas / THREE texture cache (lazy, browser only) ──────────────────────

type TextureLike = {
    colorSpace: unknown;
    wrapS: unknown;
    wrapT: unknown;
    needsUpdate: boolean;
    dispose: () => void;
};

const grainCache = new Map<string, { rgba: KraftGrainMaps; texture: TextureLike | null }>();

function cacheKey(size: number, seed: number): string {
    return `${size}|${seed}`;
}

/**
 * Lấy (hoặc tạo) CanvasTexture bump grain cho three.js.
 * Trả `null` nếu không có document/canvas (SSR / test thuần).
 * Texture được cache — KHÔNG dispose theo material panel.
 */
export function getKraftGrainBumpTexture(
    size: number = 256,
    seed: number = KRAFT_GRAIN_SEED,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    THREE_NS?: any,
): TextureLike | null {
    const key = cacheKey(size, seed);
    let entry = grainCache.get(key);
    if (!entry) {
        entry = { rgba: buildKraftGrainRgba(size, seed), texture: null };
        grainCache.set(key, entry);
    }
    if (entry.texture) return entry.texture;

    if (typeof document === 'undefined') return null;
    const THREE = THREE_NS;
    if (!THREE?.CanvasTexture && !THREE?.DataTexture) return null;

    const { size: s, rgba } = entry.rgba;
    let tex: TextureLike;

    if (THREE.DataTexture) {
        const data = new Uint8Array(rgba.buffer.slice(0));
        const dt = new THREE.DataTexture(data, s, s, THREE.RGBAFormat);
        dt.colorSpace = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace;
        dt.wrapS = THREE.RepeatWrapping;
        dt.wrapT = THREE.RepeatWrapping;
        dt.repeat?.set?.(2.5, 2.5);
        dt.needsUpdate = true;
        tex = dt;
    } else {
        const canvas = document.createElement('canvas');
        canvas.width = s;
        canvas.height = s;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const img = ctx.createImageData(s, s);
        img.data.set(rgba);
        ctx.putImageData(img, 0, 0);
        const ct = new THREE.CanvasTexture(canvas);
        ct.colorSpace = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace;
        ct.wrapS = THREE.RepeatWrapping;
        ct.wrapT = THREE.RepeatWrapping;
        ct.repeat?.set?.(2.5, 2.5);
        ct.needsUpdate = true;
        tex = ct;
    }

    entry.texture = tex;
    return tex;
}

/** Xóa cache (test / leave tool). Dispose texture GPU nếu có. */
export function clearKraftGrainCache(): void {
    for (const entry of grainCache.values()) {
        try {
            entry.texture?.dispose();
        } catch {
            /* ignore */
        }
    }
    grainCache.clear();
}
