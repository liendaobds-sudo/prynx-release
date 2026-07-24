import { describe, it, expect } from 'vitest';
import { sampleHeroTimeline, easeInOutCubic } from '../heroTimeline';

describe('heroTimeline', () => {
    it('easeInOutCubic clamps and mid = 0.5', () => {
        expect(easeInOutCubic(0)).toBe(0);
        expect(easeInOutCubic(1)).toBe(1);
        expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5);
        expect(easeInOutCubic(-1)).toBe(0);
        expect(easeInOutCubic(2)).toBe(1);
    });

    it('t=0 → fold gần 0, chưa done', () => {
        const p = sampleHeroTimeline(0, { cycleSec: 8 });
        expect(p.foldProgress).toBeLessThan(0.05);
        expect(p.done).toBe(false);
    });

    it('giữa fold → foldProgress tăng', () => {
        const a = sampleHeroTimeline(1.5, { cycleSec: 8 });
        const b = sampleHeroTimeline(3.0, { cycleSec: 8 });
        expect(b.foldProgress).toBeGreaterThan(a.foldProgress);
    });

    it('sau settle fold = 1', () => {
        const p = sampleHeroTimeline(5.0, { cycleSec: 8 });
        expect(p.foldProgress).toBeCloseTo(1, 5);
    });

    it('orbit segment có yaw ≠ 0', () => {
        const p = sampleHeroTimeline(6.5, { cycleSec: 8 });
        expect(Math.abs(p.orbitYawRad)).toBeGreaterThan(0.01);
        expect(p.segment === 'orbit' || p.segment === 'settle').toBe(true);
    });

    it('hết cycle → done, fold 1, yaw 0', () => {
        const p = sampleHeroTimeline(8.1, { cycleSec: 8 });
        expect(p.done).toBe(true);
        expect(p.foldProgress).toBe(1);
        expect(p.orbitYawRad).toBe(0);
    });

    it('reducedMotion: không orbit, fold one-shot', () => {
        const mid = sampleHeroTimeline(2, { cycleSec: 8, reducedMotion: true });
        expect(mid.orbitYawRad).toBe(0);
        const end = sampleHeroTimeline(9, { cycleSec: 8, reducedMotion: true });
        expect(end.done).toBe(true);
        expect(end.foldProgress).toBe(1);
        expect(end.orbitYawRad).toBe(0);
    });
});
