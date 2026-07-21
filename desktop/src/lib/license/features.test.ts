import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_CATALOG,
  FEATURE_MIN_PLAN,
  featureIdForFocus,
  hasFeatureAccess,
  normalizePlan,
} from './features';

describe('license feature catalog', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('giữ gate tắt nếu bản build chưa chủ động bật', async () => {
    vi.stubEnv('VITE_FEATURE_GATING_ENABLED', '');
    vi.resetModules();
    const mod = await import('./features');
    expect(mod.FEATURE_GATING_ENABLED).toBe(false);
    expect(mod.canUse('impo.cnc', 'free')).toBe(true);
  });

  it('bật gate khi build chủ động set cờ', async () => {
    vi.stubEnv('VITE_FEATURE_GATING_ENABLED', 'true');
    vi.resetModules();
    const mod = await import('./features');
    expect(mod.FEATURE_GATING_ENABLED).toBe(true);
    expect(mod.canUse('impo.cnc', 'free')).toBe(false);
  });

  it('phân quyền Free/Pro đúng và cho phép cấp quyền riêng', () => {
    expect(hasFeatureAccess('pdf.merge', 'free')).toBe(true);
    expect(hasFeatureAccess('impo.cnc', 'free')).toBe(false);
    expect(hasFeatureAccess('impo.cnc', 'free', ['impo.cnc'])).toBe(true);
    expect(hasFeatureAccess('impo.cnc', 'pro')).toBe(true);
    expect(hasFeatureAccess('impo.cnc', 'dev')).toBe(true);
  });

  it('normalize plan và giữ tương thích tên gói cũ', () => {
    expect(normalizePlan('PROFESSIONAL')).toBe('pro');
    expect(normalizePlan('admin')).toBe('dev');
    expect(normalizePlan(undefined)).toBe('free');
  });

  it('mọi feature có plan và nhãn hiển thị', () => {
    expect(Object.keys(FEATURE_CATALOG).length).toBeGreaterThanOrEqual(30);
    for (const [id, item] of Object.entries(FEATURE_CATALOG)) {
      expect(['free', 'pro', 'dev']).toContain(FEATURE_MIN_PLAN[id as keyof typeof FEATURE_MIN_PLAN]);
      expect(item.label.trim().length).toBeGreaterThan(2);
    }
  });

  it('map đủ toàn bộ tool đang hiển thị', () => {
    const keys = [
      'shuffle', 'resize', 'trim_shift', 'split', 'pages', 'combine_pdf',
      'preflight', 'convertcolors', 'hairlines', 'trapping', 'sticker',
      'datamerge', 'numbering', 'cover_numbering', 'stick_text_number',
      'booklet', 'nup', 'sticker_imposer', 'cnc_imposer', 'dieline',
      'bgremover', 'watermark', 'optimize', 'encrypt', 'metadata',
      'office_convert', 'pdfx', 'upscale', 'compare_pdf', 'compare_text',
    ];
    for (const key of keys) expect(featureIdForFocus(key), key).not.toBeNull();
    expect(featureIdForFocus('unknown_xyz')).toBeNull();
  });
});
