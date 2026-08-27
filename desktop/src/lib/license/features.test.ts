import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_CATALOG,
  FEATURE_MIN_PLAN,
  hasFeatureAccess,
  normalizePlan,
} from './features';
import { TOOL_REGISTRY, findToolByUniqueKey, getToolUniqueKey } from '../toolRegistry';

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
    expect(hasFeatureAccess('prepress.paper_library', 'free')).toBe(false);
    expect(hasFeatureAccess('prepress.paper_library', 'pro')).toBe(true);
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

  it('sinh coverage trực tiếp từ registry, không dùng danh sách key viết tay', () => {
    const enabledTools = TOOL_REGISTRY.filter((tool) => tool.isEnabled);
    expect(enabledTools.length).toBeGreaterThan(30);
    for (const tool of enabledTools) {
      const key = getToolUniqueKey(tool);
      expect(findToolByUniqueKey(key), key).toBe(tool);
      expect(FEATURE_CATALOG[tool.featureId], `${key} thiếu capability`).toBeDefined();
    }
  });

  it('Bình lồng ghép tự do là quyền Pro RIÊNG', () => {
    // Quyền mới phải tồn tại và là Pro.
    expect(FEATURE_CATALOG['impo.mixed_nesting'].minPlan).toBe('pro');
    expect(FEATURE_MIN_PLAN['impo.mixed_nesting']).toBe('pro');
    expect(hasFeatureAccess('impo.mixed_nesting', 'free')).toBe(false);
    expect(hasFeatureAccess('impo.mixed_nesting', 'pro')).toBe(true);
    expect(hasFeatureAccess('impo.mixed_nesting', 'dev')).toBe(true);

    // Cấp quyền riêng đúng ID thì mở; cấp quyền của tool khác thì KHÔNG mở.
    expect(hasFeatureAccess('impo.mixed_nesting', 'free', ['impo.mixed_nesting'])).toBe(true);
    expect(hasFeatureAccess('impo.mixed_nesting', 'free', ['impo.diecut'])).toBe(false);
    expect(hasFeatureAccess('impo.mixed_nesting', 'free', ['packaging.dieline'])).toBe(false);
    // …và ngược lại: quyền mới không mở tool cũ (kế hoạch 2026-08-26 §8 quy tắc 6).
    expect(hasFeatureAccess('impo.diecut', 'free', ['impo.mixed_nesting'])).toBe(false);
    expect(hasFeatureAccess('packaging.dieline', 'free', ['impo.mixed_nesting'])).toBe(false);
    expect(hasFeatureAccess('impo.nup', 'free', ['impo.mixed_nesting'])).toBe(false);

    // P9 đã đăng ký tool. Quyền này phải thuộc về ĐÚNG MỘT entry — nếu có hai entry cùng
    // capability thì `findToolByUniqueKey` không resolve được và routing sẽ fail-closed.
    const wired = TOOL_REGISTRY.filter((tool) => tool.featureId === 'impo.mixed_nesting');
    expect(wired.length, 'quyền mới phải gắn đúng một tool').toBeLessThanOrEqual(1);
    if (wired.length === 1) {
      expect(wired[0].id).toBe('mixed_nesting');
      expect(wired[0].isEnabled).toBe(true);
    }
  });

  it('chốt Crop là Free, Chữ & Font là Pro và bỏ capability Optimize mồ côi', () => {
    expect(findToolByUniqueKey('crop')?.featureId).toBe('pdf.crop');
    expect(FEATURE_CATALOG['pdf.crop'].minPlan).toBe('free');
    expect(findToolByUniqueKey('font_tools')?.featureId).toBe('prepress.preflight');
    expect(FEATURE_CATALOG['prepress.preflight'].minPlan).toBe('pro');
    expect('pdf.optimize_advanced' in FEATURE_CATALOG).toBe(false);
  });
});
