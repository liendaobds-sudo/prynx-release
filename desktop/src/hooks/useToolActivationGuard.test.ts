import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../lib/toolRegistry';

describe('requestToolActivation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.stubEnv('VITE_FEATURE_GATING_ENABLED', 'true');
    vi.resetModules();
    // Test hàm thuần; không khởi tạo auth store thật (môi trường node không có localStorage).
    vi.doMock('../stores/useAuthStore', () => ({ useAuthStore: vi.fn() }));
    vi.doMock('../components/ui/Toast', () => ({ toast: { info: vi.fn() } }));
    return import('./useToolActivationGuard');
  }

  it('chặn Free mở tool Pro và không chạy callback', async () => {
    const { requestToolActivation } = await load();
    const allowed = vi.fn();
    const denied = vi.fn();
    const tool = { featureId: 'prepress.preflight' } as ToolDefinition;

    expect(requestToolActivation(tool, 'free', null, allowed, denied)).toBe(false);
    expect(allowed).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith('prepress.preflight');
  });

  it('cho phép custom grant đúng capability, không mở nhờ capability khác', async () => {
    const { requestToolActivation } = await load();
    const allowed = vi.fn();
    const tool = { featureId: 'prepress.preflight' } as ToolDefinition;

    expect(requestToolActivation(tool, 'free', ['prepress.convert_colors'], allowed)).toBe(false);
    expect(requestToolActivation(tool, 'free', ['prepress.preflight'], allowed)).toBe(true);
    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it('Crop là capability Free và vẫn mở khi gate bật', async () => {
    const { requestToolActivation } = await load();
    const allowed = vi.fn();
    const tool = { featureId: 'pdf.crop' } as ToolDefinition;

    expect(requestToolActivation(tool, 'free', null, allowed)).toBe(true);
    expect(allowed).toHaveBeenCalledOnce();
  });

  it('workspace chỉ cho hai state nội bộ và chặn fail-closed key không đăng ký', async () => {
    const { requestWorkspaceToolActivation } = await load();
    const allowed = vi.fn();
    const unknown = vi.fn();

    expect(requestWorkspaceToolActivation('none', 'free', null, allowed)).toBe(true);
    expect(requestWorkspaceToolActivation('merge', 'free', null, allowed)).toBe(true);
    expect(requestWorkspaceToolActivation('ocr', 'pro', null, allowed, undefined, unknown)).toBe(false);
    expect(requestWorkspaceToolActivation('key-la', 'dev', null, allowed, undefined, unknown)).toBe(false);
    expect(allowed).toHaveBeenCalledTimes(2);
    expect(unknown).toHaveBeenCalledTimes(2);
  });

  it('không chạy callback nạp preset nếu custom grant không khớp tool đích', async () => {
    const { requestWorkspaceToolActivation } = await load();
    const applyPreset = vi.fn();

    expect(requestWorkspaceToolActivation(
      'booklet',
      'free',
      ['impo.nup'],
      applyPreset,
    )).toBe(false);
    expect(applyPreset).not.toHaveBeenCalled();

    expect(requestWorkspaceToolActivation(
      'nup',
      'free',
      ['impo.nup'],
      applyPreset,
    )).toBe(true);
    expect(applyPreset).toHaveBeenCalledOnce();
  });
});
