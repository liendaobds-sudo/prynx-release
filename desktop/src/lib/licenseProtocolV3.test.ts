import { describe, expect, it, vi } from 'vitest';
import {
  LicenseProtocolV3ClientError,
  runLicenseReleaseProtocolV3,
  runLicenseProtocolV3,
  type DeviceLicenseProofV3,
  type DevicePublicIdentityV3,
  type NativeLicenseChallengeV3,
  type NativeInvokeV3,
} from './licenseProtocolV3';

const NOW = 1_788_480_100;
const THUMBPRINT = 'A'.repeat(43);
const DEVICE_ID = `d3_${THUMBPRINT}`;
const IDENTITY: DevicePublicIdentityV3 = {
  protocol_version: 3,
  device_key_id: DEVICE_ID,
  proof_alg: 'PS256',
  public_key_jwk: { e: 'AQAB', kty: 'RSA', n: `g${'A'.repeat(340)}B` },
};
const CHALLENGE: NativeLicenseChallengeV3 = {
  protocol_version: 3,
  environment: 'prod',
  action: 'refresh',
  license_id: '018f0f5e-7b7c-7e24-8a5e-847f567f3341',
  product_id: 'prynx',
  device_key_id: DEVICE_ID,
  challenge_id: '018f0f5e-8d51-7f77-bbd5-f19db33c4b7a',
  challenge: 'ab'.repeat(32),
  expires_at: NOW + 120,
  request_hash: 'cd'.repeat(32),
};
const PROOF: DeviceLicenseProofV3 = {
  protocol_version: 3,
  device_key_id: DEVICE_ID,
  proof_alg: 'PS256',
  proof: 'A'.repeat(342),
  proof_input_hash: 'B'.repeat(43),
};

function challengeResponse() {
  return {
    status: 'CHALLENGE',
    minimum_protocol: 3,
    ...CHALLENGE,
  };
}

function validResponse() {
  return {
    status: 'VALID',
    protocol_version: 3,
    minimum_protocol: 3,
    device_key_id: DEVICE_ID,
    token: 'payload.signature',
    plan: 'pro',
  };
}

function nativeInvoker(expectedChallenge: NativeLicenseChallengeV3 = CHALLENGE) {
  const invoke = vi.fn(async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    if (command === 'get_device_public_identity') return IDENTITY as T;
    if (command === 'sign_device_license_challenge') {
      expect(args).toEqual({ challenge: expectedChallenge });
      return PROOF as T;
    }
    throw new Error(`unexpected command ${command}`);
  });
  // Vitest làm mất call signature generic của implementation khi bọc bằng Mock.
  return invoke as typeof invoke & NativeInvokeV3;
}

describe('license protocol v3 client', () => {
  it.each([1, 300, 3600])('giữ thời gian chờ %is từ server', async retry => {
    await expect(runLicenseProtocolV3({
      licenseKey: 'TEST', action: 'refresh', invokeNative: nativeInvoker(), nowSeconds: NOW,
      invokeEdge: async () => ({ data: { status: 'RATE_LIMITED', retry_after_seconds: retry }, error: null }),
    })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: retry });
  });

  it.each([0, -1, 3601, '300', 1.5])('bỏ qua thời gian chờ sai kiểu/biên %s', async retry => {
    await expect(runLicenseProtocolV3({
      licenseKey: 'TEST', action: 'refresh', invokeNative: nativeInvoker(), nowSeconds: NOW,
      invokeEdge: async () => ({ data: { status: 'RATE_LIMITED', retry_after_seconds: retry }, error: null }),
    })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: undefined });
  });

  it('timeout abort fetch và không gửi prove từ phản hồi muộn', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let late!: (value: { data: unknown; error: null }) => void;
    const edge = vi.fn((_body: unknown, options?: { signal: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<{ data: unknown; error: null }>(resolve => { late = resolve; });
    });
    try {
      const pending = runLicenseProtocolV3({ licenseKey: 'TEST', action: 'refresh',
        invokeNative: nativeInvoker(), invokeEdge: edge, nowSeconds: NOW, stepTimeoutMs: 25 });
      const failure = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      await vi.advanceTimersByTimeAsync(25);
      await failure;
      expect(signal?.aborted).toBe(true);
      late({ data: challengeResponse(), error: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(edge).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('cancel trước lúc chạy không đọc CNG hoặc gọi Edge', async () => {
    const controller = new AbortController();
    controller.abort();
    const native = nativeInvoker();
    const edge = vi.fn();
    await expect(runLicenseProtocolV3({ licenseKey: 'TEST', action: 'refresh',
      invokeNative: native, invokeEdge: edge, nowSeconds: NOW, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(native).not.toHaveBeenCalled();
    expect(edge).not.toHaveBeenCalled();
  });
  it('hết hạn chờ Edge thì dừng fail-closed thay vì treo vô hạn', async () => {
    vi.useFakeTimers();
    try {
      const pendingEdge = new Promise<{ data: unknown; error: null }>(() => {});
      const verification = runLicenseProtocolV3({
        licenseKey: 'PRYNX-TEST-KEY',
        action: 'refresh',
        invokeNative: nativeInvoker(),
        invokeEdge: () => pendingEdge,
        nowSeconds: NOW,
        stepTimeoutMs: 25,
      });
      const rejected = expect(verification).rejects.toMatchObject({ code: 'NETWORK_ERROR' });

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('hết hạn chờ native thì báo lỗi native và chưa gọi Edge', async () => {
    vi.useFakeTimers();
    try {
      const pendingNative = new Promise<unknown>(() => {});
      const invokeEdge = vi.fn();
      const verification = runLicenseProtocolV3({
        licenseKey: 'PRYNX-TEST-KEY',
        action: 'refresh',
        invokeNative: (() => pendingNative) as NativeInvokeV3,
        invokeEdge,
        nowSeconds: NOW,
        stepTimeoutMs: 25,
      });
      const rejected = expect(verification).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' });

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(invokeEdge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('chạy challenge rồi prove, không gửi license key/identity ở bước prove', async () => {
    const invokeNative = nativeInvoker();
    const invokeEdge = vi.fn()
      .mockResolvedValueOnce({ data: challengeResponse(), error: null })
      .mockResolvedValueOnce({
        data: {
          ...validResponse(),
          // Giá trị phụ từ response cuối không được thay authority của challenge hiện tại.
          completed_challenge_id: '018f0f5e-8d51-7f77-bbd5-f19db33c4b7b',
        },
        error: null,
      });

    await expect(runLicenseProtocolV3({
      licenseKey: ' prynx-test-key ',
      action: 'refresh',
      appVersion: '1.2.3',
      invokeNative,
      invokeEdge,
      nowSeconds: NOW,
    })).resolves.toMatchObject({
      status: 'VALID',
      device_key_id: DEVICE_ID,
      completed_challenge_id: CHALLENGE.challenge_id,
    });

    expect(invokeEdge).toHaveBeenNthCalledWith(1, expect.objectContaining({
      step: 'challenge',
      license_key: 'PRYNX-TEST-KEY',
      device_identity: IDENTITY,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const proveBody = invokeEdge.mock.calls[1][0] as Record<string, unknown>;
    expect(proveBody).toEqual({
      step: 'prove',
      protocol_version: 3,
      challenge_id: CHALLENGE.challenge_id,
      challenge: CHALLENGE.challenge,
      proof: PROOF,
      app_version: '1.2.3',
      offline_lease_seconds: 72 * 60 * 60,
    });
    expect(proveBody).not.toHaveProperty('license_key');
    expect(proveBody).not.toHaveProperty('device_identity');
    expect(proveBody).not.toHaveProperty('attestation_verified');
    expect(proveBody).not.toHaveProperty('attestation_token');
  });

  it('giữ nguyên DEVICE_LIMIT khi Edge từ chối cấp challenge, không ký hoặc prove', async () => {
    const invokeNative = nativeInvoker();
    const invokeEdge = vi.fn().mockResolvedValueOnce({
      data: { status: 'DEVICE_LIMIT', message: 'Đã đạt giới hạn thiết bị' },
      error: null,
    });

    await expect(runLicenseProtocolV3({
      licenseKey: 'PRYNX-TEST-KEY',
      action: 'enroll',
      invokeNative,
      invokeEdge,
      nowSeconds: NOW,
    })).rejects.toMatchObject({
      code: 'DEVICE_LIMIT',
      message: 'Đã đạt giới hạn thiết bị',
    });

    expect(invokeNative).toHaveBeenCalledTimes(1);
    expect(invokeNative).toHaveBeenCalledWith('get_device_public_identity');
    expect(invokeEdge).toHaveBeenCalledTimes(1);
    expect(invokeEdge).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'prove' }));
  });

  it('nhả seat bằng challenge/proof v3 và chỉ nhận response RELEASED bind đúng device', async () => {
    const releaseChallenge: NativeLicenseChallengeV3 = { ...CHALLENGE, action: 'release' };
    const invokeEdge = vi.fn()
      .mockResolvedValueOnce({
        data: {
          status: 'CHALLENGE',
          minimum_protocol: 3,
          ...releaseChallenge,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          status: 'RELEASED',
          protocol_version: 3,
          minimum_protocol: 3,
          device_key_id: DEVICE_ID,
        },
        error: null,
      });

    await expect(runLicenseReleaseProtocolV3({
      licenseKey: 'PRYNX-TEST-KEY',
      appVersion: '1.2.3',
      invokeNative: nativeInvoker(releaseChallenge),
      invokeEdge,
      nowSeconds: NOW,
    })).resolves.toEqual({
      status: 'RELEASED',
      protocol_version: 3,
      minimum_protocol: 3,
      device_key_id: DEVICE_ID,
      completed_challenge_id: CHALLENGE.challenge_id,
    });
    expect(invokeEdge).toHaveBeenNthCalledWith(1, expect.objectContaining({
      step: 'challenge',
      action: 'release',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(invokeEdge).toHaveBeenNthCalledWith(2, expect.objectContaining({
      step: 'prove',
      challenge_id: CHALLENGE.challenge_id,
      proof: PROOF,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('không fallback khi challenge sai device/scope hoặc server từ chối proof', async () => {
    for (const response of [
      { ...challengeResponse(), device_key_id: `d3_${'B'.repeat(43)}` },
      { ...challengeResponse(), minimum_protocol: 2 },
      { ...challengeResponse(), challenge: 'AB'.repeat(32) },
    ]) {
      const invokeEdge = vi.fn().mockResolvedValueOnce({ data: response, error: null });
      await expect(runLicenseProtocolV3({
        licenseKey: 'PRYNX-TEST-KEY',
        action: 'refresh',
        invokeNative: nativeInvoker(),
        invokeEdge,
        nowSeconds: NOW,
      })).rejects.toBeInstanceOf(LicenseProtocolV3ClientError);
      expect(invokeEdge).toHaveBeenCalledTimes(1);
    }
  });

  it('enroll không gửi HWID hoặc token legacy có thể clone', async () => {
    const enrollChallenge: NativeLicenseChallengeV3 = { ...CHALLENGE, action: 'enroll' };
    const invokeEdge = vi.fn()
      .mockResolvedValueOnce({
        data: {
          status: 'CHALLENGE',
          minimum_protocol: 3,
          ...enrollChallenge,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: validResponse(), error: null });

    await runLicenseProtocolV3({
      licenseKey: 'PRYNX-TEST-KEY',
      action: 'enroll',
      invokeNative: nativeInvoker(enrollChallenge),
      invokeEdge,
      nowSeconds: NOW,
    });

    const request = invokeEdge.mock.calls[0][0] as Record<string, unknown>;
    expect(request).not.toHaveProperty('legacy_machine_id');
    expect(request).not.toHaveProperty('legacy_token');
  });
});
