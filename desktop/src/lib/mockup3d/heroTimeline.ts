// ============================================================
// heroTimeline.ts — Mockup 3D hero fold presentation (pure)
//
// Timeline marketing: gập phẳng → hộp → hold → orbit nhẹ → (optional reverse).
// Không phụ thuộc three/R3F. Reduced-motion: orbit = 0, chỉ fold một chiều.
// ============================================================

/** Trạng thái timeline tại một thời điểm. */
export interface HeroTimelinePose {
    /** foldProgress ∈ [0, 1] */
    foldProgress: number;
    /** Góc orbit yaw (radian) quanh trục đứng hộp */
    orbitYawRad: number;
    /** true khi đã hết một chu kỳ demo */
    done: boolean;
    /** Phân đoạn hiện tại (debug / UI) */
    segment: 'fold' | 'settle' | 'orbit' | 'done';
}

export interface HeroTimelineOptions {
    /** Tổng thời lượng chu kỳ (giây). Mặc định 8s. */
    cycleSec?: number;
    /**
     * true → không orbit, fold 0→1 một lần rồi done (prefers-reduced-motion).
     * Mặc định false.
     */
    reducedMotion?: boolean;
    /** Biên độ orbit (radian). Mặc định ~18°. */
    orbitAmplitudeRad?: number;
}

const DEFAULT_CYCLE = 8.0;
const DEFAULT_ORBIT_AMP = (18 * Math.PI) / 180;

/** easeInOut cubic — khớp pattern fold/Sony. */
export function easeInOutCubic(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * Tính pose hero demo tại `elapsedSec` kể từ lúc bắt đầu.
 *
 * Phân đoạn (cycle mặc định 8s):
 *   0.0–0.15  hold flat (fold≈0)
 *   0.15–0.50 fold 0→1 (eased)
 *   0.50–0.60 settle hold
 *   0.60–0.95 slow orbit yaw (sin)
 *   0.95–1.00 hold → done
 *
 * Reduced motion: fold 0→1 trong 60% đầu, hold, done — không orbit.
 */
export function sampleHeroTimeline(
    elapsedSec: number,
    options: HeroTimelineOptions = {},
): HeroTimelinePose {
    const cycle = options.cycleSec ?? DEFAULT_CYCLE;
    const reduced = options.reducedMotion === true;
    const amp = options.orbitAmplitudeRad ?? DEFAULT_ORBIT_AMP;
    const t = Math.max(0, elapsedSec);

    if (reduced) {
        const foldDur = cycle * 0.55;
        if (t >= cycle) {
            return { foldProgress: 1, orbitYawRad: 0, done: true, segment: 'done' };
        }
        if (t < foldDur) {
            const u = easeInOutCubic(t / foldDur);
            return { foldProgress: u, orbitYawRad: 0, done: false, segment: 'fold' };
        }
        return { foldProgress: 1, orbitYawRad: 0, done: false, segment: 'settle' };
    }

    if (t >= cycle) {
        return { foldProgress: 1, orbitYawRad: 0, done: true, segment: 'done' };
    }

    const p = t / cycle; // 0..1 within cycle

    // fold: 0.12 → 0.48
    const foldU = easeInOutCubic(smoothstep(0.12, 0.48, p));
    // settle: 0.48 → 0.58 hold at 1
    // orbit: 0.58 → 0.95
    const orbitU = smoothstep(0.58, 0.95, p);
    // gentle half-turn feel (not full spin)
    const orbitYawRad = Math.sin(orbitU * Math.PI) * amp;

    let segment: HeroTimelinePose['segment'] = 'fold';
    if (p < 0.12) segment = 'fold';
    else if (p < 0.48) segment = 'fold';
    else if (p < 0.58) segment = 'settle';
    else if (p < 0.98) segment = 'orbit';
    else segment = 'done';

    return {
        foldProgress: foldU,
        orbitYawRad,
        done: false,
        segment: segment === 'done' && p < 0.98 ? 'orbit' : segment,
    };
}
