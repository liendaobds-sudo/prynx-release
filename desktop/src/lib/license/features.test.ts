import { describe, it, expect } from 'vitest';
import {
  FEATURE_GATING_ENABLED,
  FEATURE_MIN_PLAN,
  canUse,
  featureIdForFocus,
  normalizePlan,
} from './features';

describe('license features scaffold', () => {
  it('gate mặc định TẮT → canUse luôn true (không chặn tool hiện có)', () => {
    expect(FEATURE_GATING_ENABLED).toBe(false);
    expect(canUse('impo.diecut', 'free')).toBe(true);
    expect(canUse('pdf.encrypt', 'free')).toBe(true);
  });

  it('normalizePlan', () => {
    expect(normalizePlan('pro')).toBe('pro');
    expect(normalizePlan('FREE')).toBe('free');
    expect(normalizePlan(undefined)).toBe('free');
  });

  it('mọi FeatureId có min plan', () => {
    for (const id of Object.keys(FEATURE_MIN_PLAN)) {
      expect(['free', 'pro', 'dev']).toContain(FEATURE_MIN_PLAN[id as keyof typeof FEATURE_MIN_PLAN]);
    }
  });

  it('featureIdForFocus map utility + impo', () => {
    expect(featureIdForFocus('encrypt')).toBe('pdf.encrypt');
    expect(featureIdForFocus('sticker_imposer')).toBe('impo.diecut');
    expect(featureIdForFocus('unknown_xyz')).toBeNull();
  });
});
