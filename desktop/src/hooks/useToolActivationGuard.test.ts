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

  // ───────────────────────────────────────────────────────────────────────────
  //  Bình lồng ghép tự do — phase P9 (kế hoạch 2026-08-26 §8, §16.4)
  // ───────────────────────────────────────────────────────────────────────────

  it('Free không mở được Bình lồng ghép tự do', async () => {
    const { requestToolActivation } = await load();
    const allowed = vi.fn();
    const denied = vi.fn();
    const tool = { featureId: 'impo.mixed_nesting' } as ToolDefinition;

    expect(requestToolActivation(tool, 'free', null, allowed, denied)).toBe(false);
    expect(allowed).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith('impo.mixed_nesting');
  });

  it('Pro và dev mở được; grant đúng tên cũng mở được', async () => {
    const { requestToolActivation } = await load();
    const allowed = vi.fn();
    const tool = { featureId: 'impo.mixed_nesting' } as ToolDefinition;

    expect(requestToolActivation(tool, 'pro', null, allowed)).toBe(true);
    expect(requestToolActivation(tool, 'dev', null, allowed)).toBe(true);
    expect(requestToolActivation(tool, 'free', ['impo.mixed_nesting'], allowed)).toBe(true);
    expect(allowed).toHaveBeenCalledTimes(3);
  });

  it.each(['impo.diecut', 'packaging.dieline', 'impo.nup', 'impo.cnc'])(
    'grant %s KHÔNG mở được Bình lồng ghép tự do',
    async (grantKhac) => {
      const { requestToolActivation } = await load();
      const allowed = vi.fn();
      const tool = { featureId: 'impo.mixed_nesting' } as ToolDefinition;

      expect(requestToolActivation(tool, 'free', [grantKhac], allowed)).toBe(false);
      expect(allowed).not.toHaveBeenCalled();
    },
  );

  it.each(['impo.diecut', 'packaging.dieline', 'impo.nup'])(
    'grant Bình lồng ghép KHÔNG mở được %s',
    async (tooCu) => {
      const { requestToolActivation } = await load();
      const allowed = vi.fn();
      const tool = { featureId: tooCu } as ToolDefinition;

      expect(requestToolActivation(tool, 'free', ['impo.mixed_nesting'], allowed)).toBe(false);
      expect(allowed).not.toHaveBeenCalled();
    },
  );

  it('mở trực tiếp bằng key lạ gần giống vẫn fail-closed', async () => {
    const { requestWorkspaceToolActivation } = await load();
    const allowed = vi.fn();
    const unknown = vi.fn();

    // Đây là đường "direct launch" mà §16.4 yêu cầu fail-closed: một key gõ sai
    // không được rơi vào tool nào.
    for (const key of ['mixed-nesting', 'mixednesting', 'mixed_nest', 'nesting']) {
      expect(
        requestWorkspaceToolActivation(key, 'dev', null, allowed, undefined, unknown),
        key,
      ).toBe(false);
    }
    expect(allowed).not.toHaveBeenCalled();
    expect(unknown).toHaveBeenCalledTimes(4);
  });

  it('mixed_nesting KHÔNG phải một state của workspace ImpositionTab', async () => {
    const { requestWorkspaceToolActivation } = await load();
    const { MIXED_NESTING_ENABLED } = await import('../lib/mixed-nesting/rollout');
    const allowed = vi.fn();
    const unknown = vi.fn();

    // `requestWorkspaceToolActivation` tra registry theo unique key, nên khi cờ bật thì
    // key này resolve được — nhưng đó chỉ là kiểm quyền. Điều test chốt: nó KHÔNG nằm
    // trong hai state nội bộ `none`/`merge` và không được coi là preset workspace.
    const result = requestWorkspaceToolActivation(
      'mixed_nesting',
      'free',
      null,
      allowed,
      undefined,
      unknown,
    );
    expect(result).toBe(false);
    expect(allowed).not.toHaveBeenCalled();
    if (!MIXED_NESTING_ENABLED) {
      expect(unknown).toHaveBeenCalledWith('mixed_nesting');
    }
  });
});
