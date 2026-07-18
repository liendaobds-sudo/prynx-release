import { describe, expect, it } from 'vitest';
import {
  FEATURE_CATALOG,
  FEATURE_GATING_ENABLED,
  FEATURE_MIN_PLAN,
  canUse,
  featureIdForFocus,
  hasFeatureAccess,
  normalizePlan,
} from './features';

describe('license feature catalog', () => {
  it('giữ gate tắt nếu bản build chưa chủ động bật', () => {
    expect(FEATURE_GATING_ENABLED).toBe(false);
    expect(canUse('impo.cnc', 'free')).toBe(true);
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
