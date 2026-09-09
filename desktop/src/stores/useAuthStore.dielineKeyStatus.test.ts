// @vitest-environment jsdom
// ═════════════════════════════════════════════════════════════════════════════════════
// useAuthStore.dielineKeyStatus — lý do dạng enum cho việc token có/không mang khoá
// mở bộ máy khuôn bế.
//
// Bối cảnh (spec `.kiro/specs/dieline-engine-unlock-fix` §D/§G, task 8.2/8.4): bản phát
// hành 1.0.0-rc.9 nhận token license hợp lệ NHƯNG thiếu claim `rk`, nên bộ máy khuôn bế
// chết hoàn toàn và người dùng chỉ thấy toast đỏ lúc bấm tạo khuôn. `license-verify` giờ
// trả thêm `rk_status` ở nhánh `status = 'VALID'` để client báo đúng bản chất.
//
// Ba bất biến mà bộ test này gác:
//
//  1. `rk_status` của server được ánh xạ NGUYÊN VẸN vào `dielineKeyStatus` — không suy
//     diễn, không gộp lý do, vì mỗi lý do dẫn tới một hướng xử lý khác nhau cho ops.
//  2. Mọi nhánh KHÔNG có câu trả lời mới từ server phải ra `'unknown'`: lỗi mạng,
//     `RATE_LIMITED`, offline-grace theo `exp` của token, và ca phản hồi THIẾU trường
//     `rk_status` (bundle Edge chưa lên lô 2). Không nhánh nào được crash hay hiện banner
//     sai — banner chỉ dựa trên câu trả lời của backend, `dielineKeyStatus` chỉ để báo lý do.
//  3. `dielineKeyStatus` luôn nằm trong tập enum đã biết. Nó là thứ người dùng copy khi
//     liên hệ hỗ trợ, nên không được là đường vòng cho dữ liệu server chảy ra ngoài.
//
// `saveTokenToDPAPI` và `ensureKeyRegisteredInRust` KHÔNG đổi trong lô này: gate việc ký
// request theo `rk` sẽ khiến người dùng Free và build dev plaintext không ký được request
// nào (vỡ Requirements 3.2 và 3.3).
// ═════════════════════════════════════════════════════════════════════════════════════

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

const edge = vi.hoisted(() => ({ invoke: vi.fn(), getSession: vi.fn(), signOut: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke: edge.invoke },
    auth: { getSession: edge.getSession, signOut: edge.signOut },
  },
}));

// Store tests isolate transaction/state behavior; canonical challenge → prove is
// exercised without mocks in licenseProtocolV3.test.ts.
const licenseV3 = vi.hoisted(() => ({ run: vi.fn(), release: vi.fn() }));
vi.mock('../lib/licenseProtocolV3', async () => {
  const actual = await vi.importActual<typeof import('../lib/licenseProtocolV3')>(
    '../lib/licenseProtocolV3',
  );
  return {
    ...actual,
    runLicenseProtocolV3: licenseV3.run,
    runLicenseReleaseProtocolV3: licenseV3.release,
  };
});

type QueuedSecurityEvent = {
  id: string;
  eventType: string;
  details: Record<string, unknown>;
  occurredAt: number;
  lastOccurredAt: number;
  occurrences: number;
};

const securityQueue = vi.hoisted(() => ({
  clearPendingSecurityEvents: vi.fn(),
  enqueueSecurityEvent: vi.fn(),
  getPendingSecurityEvents: vi.fn((): QueuedSecurityEvent[] => []),
  removePendingSecurityEvent: vi.fn(),
  toSecuritySignalDetails: vi.fn(() => ({})),
}));

vi.mock('../lib/securityEventQueue', () => ({
  ...securityQueue,
}));

import { isTransientLicenseOutcome, useAuthStore, type DielineKeyStatus } from './useAuthStore';

const LICENSE_KEY = 'PRYNX-TEST-KEY';
const NATIVE_HWID = '0123456789ABCDEF';
const DEFAULT_CHALLENGE = 'a'.repeat(64);
const DEVICE_THUMBPRINT = 'A'.repeat(43);
const DEVICE_ID = `d3_${DEVICE_THUMBPRINT}`;
const CHALLENGE_ID = '018f0f5e-8d51-7f77-bbd5-f19db33c4b7a';
const STALE_CHALLENGE_ID = '018f0f5e-8d51-7f77-bbd5-f19db33c4b7b';
const validAnchor = () => ({ status: 'valid', timestampMs: Date.now() - 1_000 });

/** Tập enum hợp lệ — `dielineKeyStatus` không bao giờ được ra ngoài tập này. */
const KNOWN_STATUSES: readonly DielineKeyStatus[] = [
  'granted',
  'not_requested',
  'not_entitled',
  'no_key_for_version',
  'burst_denied',
  'infra_unavailable',
  'legacy_fallback',
  'unknown',
];

/** Bảy giá trị `rk_status` mà `license-verify` có thể trả (thiết kế §D). */
const SERVER_STATUSES: readonly DielineKeyStatus[] = [
  'granted',
  'not_requested',
  'not_entitled',
  'no_key_for_version',
  'burst_denied',
  'infra_unavailable',
  'legacy_fallback',
];

/**
 * Token ký giả "<payload_b64url>.<sig>". Chữ ký do Rust/sidecar xác minh, không phải
 * tầng này, nên phần sig để chuỗi bất kỳ.
 */
function makeToken(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const boundedExpiry = expSeconds > now ? Math.min(expSeconds, now + 600) : expSeconds;
  const payload = JSON.stringify({
    v: 3,
    min_v: 3,
    iat: Math.min(now, boundedExpiry - 1),
    exp: boundedExpiry,
    cid: CHALLENGE_ID,
    d: DEVICE_ID,
    cnf: { jkt: DEVICE_THUMBPRINT },
    m: DEVICE_ID,
    k: '90f80031ee7948a3',
    p: 'prynx',
    plan: 'pro',
    rk: 'resource-key',
    ...extra,
  });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

/** Token legacy v1: không có v/iat/challenge, đúng shape Edge cũ đã phát. */
function makeV1Token(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const payload = JSON.stringify({
    k: 'abc', m: NATIVE_HWID, p: 'prynx', plan: 'pro', exp: expSeconds, ...extra,
  });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

function makeV2Token(expSeconds: number, challenge: string, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    v: 2,
    iat: now,
    challenge,
    k: 'abc',
    m: NATIVE_HWID,
    p: 'prynx',
    plan: 'pro',
    exp: expSeconds,
    ...extra,
  });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

const validToken = () => makeToken(Math.floor(Date.now() / 1000) + 3600);

/** Phản hồi VALID kèm token ký — dựng riêng từng ca để thêm/bớt `rk_status`. */
function validResponse(extra: Record<string, unknown> = {}) {
  return {
    data: {
      status: 'VALID',
      protocol_version: 3,
      minimum_protocol: 3,
      device_key_id: DEVICE_ID,
      token: validToken(),
      plan: 'pro',
      ...extra,
    },
    error: null,
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
    value: {}, configurable: true, writable: true,
  });
  window.localStorage.clear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_hardware_id': return NATIVE_HWID;
      case 'begin_license_validation': return DEFAULT_CHALLENGE;
      // lastOnline = 0 ⇒ bỏ qua anti-clockback và forward-jump: các nhánh đó có test riêng.
      case 'load_last_online': return 0;
      case 'load_clock_anchor': return validAnchor();
      case 'load_license_token': return '';
      case 'load_license': return '';
      default: return undefined;
    }
  });
  edge.invoke.mockReset();
  licenseV3.run.mockReset();
  licenseV3.release.mockReset();
  licenseV3.release.mockResolvedValue({
    status: 'RELEASED',
    protocol_version: 3,
    minimum_protocol: 3,
    device_key_id: DEVICE_ID,
    completed_challenge_id: CHALLENGE_ID,
  });
  licenseV3.run.mockImplementation(async (options: {
    licenseKey: string;
    action: string;
  }) => {
    let result: Awaited<ReturnType<typeof edge.invoke>>;
    try {
      result = await edge.invoke('license-verify', {
        body: {
          license_key: options.licenseKey,
          protocol_version: 3,
          action: options.action,
        },
      });
    } catch {
      throw Object.assign(new Error('network'), { code: 'NETWORK_ERROR' });
    }
    if (result.error) {
      throw Object.assign(new Error(result.error.message || 'network'), { code: 'NETWORK_ERROR' });
    }
    if (!result.data || result.data.status !== 'VALID') {
      throw Object.assign(new Error('server rejected'), {
        code: result.data?.status || 'INVALID_RESPONSE',
      });
    }
    return {
      ...(result.data as Record<string, unknown>),
      completed_challenge_id: CHALLENGE_ID,
    };
  });
  securityQueue.clearPendingSecurityEvents.mockReset();
  securityQueue.enqueueSecurityEvent.mockReset();
  securityQueue.getPendingSecurityEvents.mockReset();
  securityQueue.getPendingSecurityEvents.mockReturnValue([]);
  securityQueue.removePendingSecurityEvent.mockReset();
  securityQueue.toSecuritySignalDetails.mockReset();
  securityQueue.toSecuritySignalDetails.mockReturnValue({});
  useAuthStore.setState({
    licenseKey: LICENSE_KEY,
    licenseToken: null,
    licenseValid: false,
    isLicenseLocked: false,
    lockReason: '',
    isRevoking: false,
    revokeDeadline: null,
    revokeReason: '',
    dielineKeyStatus: 'unknown',
    licenseProtocolRecoveryRequired: false,
    isChecking: false,
  });
});

afterEach(() => {
  useAuthStore.getState().stopHeartbeat();
  delete (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('validateLicense → dielineKeyStatus', () => {
  it('phân loại lỗi hạ tầng là transient, không phải server terminal', () => {
    expect(isTransientLicenseOutcome('anchor_missing')).toBe(true);
    expect(isTransientLicenseOutcome('network_error')).toBe(true);
    expect(isTransientLicenseOutcome('native_error')).toBe(false);
    expect(isTransientLicenseOutcome('server_rejected')).toBe(false);
    expect(isTransientLicenseOutcome('device_limit')).toBe(false);
  });

  it.each(SERVER_STATUSES)('ánh xạ nguyên vẹn rk_status = %s', async (status) => {
    edge.invoke.mockResolvedValue(validResponse({ rk_status: status }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(useAuthStore.getState().dielineKeyStatus).toBe(status);
  });

  it('online VALID chỉ chạy protocol v3 và chuyển signed receipt cid sang native', async () => {
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({
      licenseKey: LICENSE_KEY,
      action: 'enroll',
    }));
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyToken');
    expect(edge.invoke).toHaveBeenCalledWith('license-verify', expect.objectContaining({
      body: expect.objectContaining({
        protocol_version: 3,
        action: 'enroll',
      }),
    }));
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', expect.objectContaining({
      licenseKey: LICENSE_KEY,
      challengeId: CHALLENGE_ID,
      token: expect.any(String),
    }));
    expect(tauri.invoke).not.toHaveBeenCalledWith('store_clock_anchor', expect.anything());
  });

  it('token v3 của challenge cũ bị từ chối trước native registration', async () => {
    const staleToken = makeToken(Math.floor(Date.now() / 1000) + 600, {
      cid: STALE_CHALLENGE_ID,
    });
    edge.invoke.mockResolvedValue(validResponse({ token: staleToken }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(useAuthStore.getState().licenseValidationOutcome).toBe('token_invalid');
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('store_license_token', expect.anything());
  });

  it.each([
    ['enroll', null, false],
    ['refresh', validToken(), false],
    ['rk_grant', makeToken(Math.floor(Date.now() / 1000) + 600, { rk: undefined }), false],
    ['recover', validToken(), true],
  ] as const)('chọn action v3 %s đúng theo token/native state', async (
    expectedAction,
    cachedToken,
    recoveryRequired,
  ) => {
    useAuthStore.setState({
      licenseToken: cachedToken,
      licenseProtocolRecoveryRequired: recoveryRequired,
    });
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({
      action: expectedAction,
    }));
  });

  it('token v1 chỉ chọn enroll mới; không được dùng làm bearer migration', async () => {
    const cachedV1 = makeV1Token(Math.floor(Date.now() / 1000) + 1_800, { marker: 'cached' });
    const renewedV1 = makeV1Token(Math.floor(Date.now() / 1000) + 3_600, { marker: 'renewed' });
    useAuthStore.setState({ licenseToken: cachedV1 });
    edge.invoke.mockResolvedValue({
      data: { status: 'VALID', token: renewedV1, plan: 'pro' },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(tauri.invoke).not.toHaveBeenCalledWith('begin_license_validation', expect.anything());
    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({
      action: 'enroll',
    }));
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('store_license_token', expect.anything());
    expect(useAuthStore.getState().licenseToken).toBe(cachedV1);
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('token_invalid');
  });

  it('server từ chối protocol v3 thì không đàm phán hạ cấp sang v1/v2', async () => {
    const cachedV1 = makeV1Token(Math.floor(Date.now() / 1000) + 3_600);
    useAuthStore.setState({ licenseToken: cachedV1 });
    edge.invoke.mockResolvedValue({
      data: { status: 'INVALID_PROTOCOL', message: 'Protocol không được hỗ trợ' },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    const verifyCalls = edge.invoke.mock.calls.filter(([name]) => name === 'license-verify');
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]?.[1]?.body).toMatchObject({ protocol_version: 3, action: 'enroll' });
    expect(tauri.invoke).not.toHaveBeenCalledWith('begin_license_validation', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(useAuthStore.getState().lockReason).toBe(
      'Không thể xác minh bản quyền. Vui lòng thử lại.',
    );
    expect(useAuthStore.getState().lockReason).not.toMatch(/challenge|proof|protocol|v3|CNG|native/i);
  });

  it('mất mạng không được dùng token v1 làm offline fallback', async () => {
    const cachedV1 = makeV1Token(Math.floor(Date.now() / 1000) + 3_600);
    useAuthStore.setState({ licenseToken: cachedV1 });
    edge.invoke.mockRejectedValue(new Error('network down'));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(edge.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    // Không có token v3 offline hợp lệ: vẫn giữ key nhưng coi mất mạng là
    // transient để banner/retry phục hồi, không báo nhầm “token hết hạn”.
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('network_error');
  });

  it('server trả token v1 cho request v3 thì bị từ chối, không fallback', async () => {
    const legacyResponseToken = makeV1Token(Math.floor(Date.now() / 1000) + 3_600);
    edge.invoke.mockResolvedValue({
      data: { status: 'VALID', token: legacyResponseToken, plan: 'pro' },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(edge.invoke).toHaveBeenCalledWith('license-verify', expect.objectContaining({
      body: expect.objectContaining({
        protocol_version: 3,
        action: 'enroll',
      }),
    }));
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('store_license_token', expect.anything());
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('token_invalid');
  });

  it.each([
    ['anchor thiếu', { status: 'missing' }, false],
    ['native đã clear', validAnchor(), true],
  ] as const)('%s: token v1 cũ không được chọn làm đường recovery', async (_label, anchor, recoveryRequired) => {
    const cachedV1 = makeV1Token(Math.floor(Date.now() / 1000) + 3_600);
    useAuthStore.setState({
      licenseToken: cachedV1,
      licenseProtocolRecoveryRequired: recoveryRequired,
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return anchor;
      return undefined;
    });
    edge.invoke.mockResolvedValue({
      data: { status: 'VALID', token: cachedV1, plan: 'pro' },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({
      action: recoveryRequired ? 'recover' : 'enroll',
    }));
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(tauri.invoke).not.toHaveBeenCalledWith('begin_license_validation', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
  });

  it('token v1 đã hết hạn chỉ chọn enroll mới, không tham gia authority', async () => {
    const expiredV1 = makeV1Token(Math.floor(Date.now() / 1000) - 10);
    useAuthStore.setState({ licenseToken: expiredV1 });
    edge.invoke.mockResolvedValue({
      data: { status: 'VALID', token: expiredV1, plan: 'pro' },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({
      action: 'enroll',
    }));
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(tauri.invoke).not.toHaveBeenCalledWith('begin_license_validation', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
  });

  it.each([
    makeV1Token(Math.floor(Date.now() / 1000) + 3_600, { v: 3 }),
    makeV1Token(Math.floor(Date.now() / 1000) + 3_600, { challenge: DEFAULT_CHALLENGE }),
  ])('token phiên bản lạ/lai ghép luôn fail-closed', async (invalidToken) => {
    edge.invoke.mockResolvedValue({
      data: { status: 'VALID', token: invalidToken, plan: 'pro' },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('token_invalid');
  });

  it("phản hồi VALID THIẾU rk_status (bundle Edge chưa lên) → 'unknown', không crash", async () => {
    edge.invoke.mockResolvedValue(validResponse());

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
    // Kích hoạt KHÔNG bị chặn bởi bất cứ chuyện gì liên quan khoá engine (Requirement 3.6).
    expect(useAuthStore.getState().licenseValid).toBe(true);
  });

  it("lý do lạ mà app chưa biết → 'unknown' chứ không hiện chuỗi lạ", async () => {
    for (const raw of ['rk_something_new', '', 'GRANTED', 42, null, {}, ['granted']]) {
      useAuthStore.setState({ dielineKeyStatus: 'granted' });
      edge.invoke.mockResolvedValue(validResponse({ rk_status: raw }));

      await useAuthStore.getState().validateLicense();

      expect(useAuthStore.getState().dielineKeyStatus, `rk_status = ${JSON.stringify(raw)}`)
        .toBe('unknown');
    }
  });

  it("lỗi mạng / edge lỗi → 'unknown' (chưa có câu trả lời, không phải đã bị từ chối)", async () => {
    useAuthStore.setState({ dielineKeyStatus: 'granted' });
    edge.invoke.mockResolvedValue({ data: null, error: { message: 'edge unreachable' } });

    await useAuthStore.getState().validateLicense();

    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
  });

  it("RATE_LIMITED → 'unknown' và không phạt người dùng", async () => {
    useAuthStore.setState({ dielineKeyStatus: 'granted' });
    useAuthStore.setState({ licenseToken: validToken() });
    edge.invoke.mockResolvedValue({ data: { status: 'RATE_LIMITED' }, error: null });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
  });

  it("offline-grace theo exp của token → 'unknown', vẫn cho dùng offline", async () => {
    useAuthStore.setState({ dielineKeyStatus: 'granted', licenseToken: validToken() });
    edge.invoke.mockResolvedValue({ data: null, error: { message: 'offline' } });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
    expect(useAuthStore.getState().licenseValid).toBe(true);
  });

  it("ngoại lệ giữa đường (VALID mà thiếu token ký) → 'unknown'", async () => {
    useAuthStore.setState({ dielineKeyStatus: 'granted' });
    edge.invoke.mockResolvedValue({ data: { status: 'VALID', rk_status: 'granted' }, error: null });

    await useAuthStore.getState().validateLicense();

    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
  });

  it('anchor thiếu thì RATE_LIMITED không được mở offline', async () => {
    useAuthStore.setState({ licenseToken: validToken() });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return { status: 'missing' };
      if (command === 'load_last_online') return 0;
      return undefined;
    });
    edge.invoke.mockResolvedValue({ data: { status: 'RATE_LIMITED' }, error: null });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
    expect(useAuthStore.getState().licenseValid).toBe(false);
    expect(useAuthStore.getState().isLicenseLocked).toBe(true);
  });

  it('lỗi mạng/anchor tự retry sau backoff và tự gỡ transient lock', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      licenseV3.run.mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('network'), { code: 'NETWORK_ERROR' });
        }
        return { ...(validResponse().data as Record<string, unknown>), completed_challenge_id: CHALLENGE_ID };
      });
      tauri.invoke.mockImplementation(async (command: string) => {
        if (command === 'load_clock_anchor') return attempts === 0 ? { status: 'missing' } : validAnchor();
        return undefined;
      });

      await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
      expect(useAuthStore.getState().isLicenseLocked).toBe(true);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(attempts).toBe(2);
      expect(useAuthStore.getState().licenseValid).toBe(true);
      expect(useAuthStore.getState().isLicenseLocked).toBe(false);
      expect(useAuthStore.getState().lockReason).toBe('');
    } finally {
      useAuthStore.getState().stopHeartbeat();
      vi.useRealTimers();
    }
  });

  it('rate-limit không có token offline vẫn là transient, không báo nhầm hết hạn', async () => {
    edge.invoke.mockResolvedValue({ data: { status: 'RATE_LIMITED' }, error: null });
    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(useAuthStore.getState().licenseValidationOutcome).toBe('rate_limited');
    expect(useAuthStore.getState().lockReason)
      .toContain('giới hạn lượt xác minh');
  });

  it('offline token hợp lệ tự gỡ lock cũ khi mạng tạm thời mất', async () => {
    useAuthStore.setState({
      licenseToken: validToken(),
      isLicenseLocked: true,
      lockReason: 'Chưa có checkpoint thời gian tin cậy.',
    });
    licenseV3.run.mockRejectedValue(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(useAuthStore.getState().licenseValid).toBe(true);
    expect(useAuthStore.getState().isLicenseLocked).toBe(false);
    expect(useAuthStore.getState().lockReason).toBe('');
  });

  it("status thu hồi cứng → 'unknown' (server không nói gì về khoá engine)", async () => {
    useAuthStore.setState({ dielineKeyStatus: 'granted' });
    edge.invoke.mockResolvedValue({ data: { status: 'EXPIRED', message: 'het han' }, error: null });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
  });

  it("chưa có license key → 'unknown', không gọi server", async () => {
    useAuthStore.setState({ licenseKey: null, dielineKeyStatus: 'granted' });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(edge.invoke).not.toHaveBeenCalled();
    expect(useAuthStore.getState().dielineKeyStatus).toBe('unknown');
  });

  // **Property 4: No-Secret-Leak** - Không giá trị bí mật nào rời khỏi vùng cho phép
  // **Validates: Requirements 2.8, 3.5**
  it('dielineKeyStatus luôn nằm trong tập enum đã biết, không echo dữ liệu server', async () => {
    const rkValue = 'K'.repeat(44);
    const responses: Array<{ data: unknown; error: unknown }> = [
      validResponse({ rk_status: 'granted' }),
      validResponse({ rk_status: rkValue }),
      validResponse({ rk_status: { key: rkValue } }),
      validResponse(),
      { data: { status: 'RATE_LIMITED', rk_status: rkValue }, error: null },
      { data: null, error: { message: 'offline' } },
    ];

    for (const response of responses) {
      edge.invoke.mockResolvedValue(response);

      await useAuthStore.getState().validateLicense();

      const status = useAuthStore.getState().dielineKeyStatus;
      expect(KNOWN_STATUSES).toContain(status);
      // Giá trị khoá không bao giờ chảy qua trường lý do — đây là chuỗi người dùng copy
      // khi liên hệ hỗ trợ.
      expect(status).not.toContain(rkValue);
    }
  });
});

describe('HWID legacy không còn là device authority v3', () => {
  it('enroll không đọc HWID native hoặc cache renderer làm migration tự động', async () => {
    window.localStorage.setItem('prynx_hwid_cache', 'AAAAAAAAAAAAAAAA');
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'enroll' }));
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyToken');
    expect(tauri.invoke).not.toHaveBeenCalledWith('get_hardware_id');
    expect(window.localStorage.getItem('prynx_hwid_cache')).toBe('AAAAAAAAAAAAAAAA');
  });

  it('token v1 cũ chỉ chọn action enroll, không được gửi làm bearer migration', async () => {
    useAuthStore.setState({ licenseToken: makeV1Token(Math.floor(Date.now() / 1000) + 600) });
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyToken');
    expect(tauri.invoke).not.toHaveBeenCalledWith('get_hardware_id');
  });
});

describe('telemetry bảo mật v2 tách khỏi authority license v3', () => {
  const pendingEvent: QueuedSecurityEvent = {
    id: 'security-event-1',
    eventType: 'clock_anchor_unavailable',
    details: { state: 'missing' },
    occurredAt: 1_000,
    lastOccurredAt: 1_000,
    occurrences: 1,
  };

  it('gửi challenge telemetry v2 riêng và giữ queue khi server không ack', async () => {
    securityQueue.getPendingSecurityEvents.mockReturnValue([pendingEvent]);
    edge.invoke
      .mockResolvedValueOnce(validResponse({ rk_status: 'granted' }))
      .mockResolvedValueOnce({ data: { status: 'INVALID_PROTOCOL' }, error: null });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);
    await vi.waitFor(() => expect(edge.invoke).toHaveBeenCalledTimes(2));

    expect(edge.invoke).toHaveBeenNthCalledWith(2, 'license-verify', expect.objectContaining({
      body: expect.objectContaining({
        protocol_version: 2,
        challenge: expect.stringMatching(/^[0-9a-f]{64}$/),
        client_signal: expect.objectContaining({ event_type: pendingEvent.eventType }),
      }),
    }));
    expect(tauri.invoke.mock.calls.filter(([command]) => command === 'begin_license_validation'))
      .toHaveLength(0);
    expect(securityQueue.removePendingSecurityEvent).not.toHaveBeenCalled();
  });

  it('chỉ xoá event sau ack security_signal_processed tường minh', async () => {
    securityQueue.getPendingSecurityEvents.mockReturnValue([pendingEvent]);
    edge.invoke
      .mockResolvedValueOnce(validResponse({ rk_status: 'granted' }))
      .mockResolvedValueOnce({
        data: { status: 'VALID', security_signal_processed: true },
        error: null,
      });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(securityQueue.removePendingSecurityEvent).toHaveBeenCalledWith(pendingEvent.id);
    });
  });
});

describe('SEC.19 — integrity của clock anchor và persistence', () => {
  it('DEVICE_LIMIT do seat legacy chuyển tạm qua v2 đúng máy, không đá khỏi công việc', async () => {
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      value: { invoke: tauri.invoke }, configurable: true, writable: true,
    });
    const v2Token = makeV2Token(Math.floor(Date.now() / 1000) + 3_600, DEFAULT_CHALLENGE);
    licenseV3.run.mockRejectedValue(Object.assign(new Error('DEVICE_LIMIT'), {
      code: 'DEVICE_LIMIT',
    }));
    edge.invoke.mockResolvedValue({
      data: {
        status: 'VALID',
        token: v2Token,
        plan: 'pro',
        rk_status: 'legacy_fallback',
      },
      error: null,
    });
    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    const state = useAuthStore.getState();
    expect(state.licenseValid).toBe(true);
    expect(state.isLicenseLocked).toBe(false);
    expect(state.licenseValidationOutcome).toBe('valid_online');
    expect(state.dielineKeyStatus).toBe('legacy_fallback');
    expect(tauri.invoke).toHaveBeenCalledWith('begin_license_validation', {
      licenseKey: LICENSE_KEY,
    });
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', {
      licenseKey: LICENSE_KEY,
      token: v2Token,
      challenge: DEFAULT_CHALLENGE,
    });
    expect(tauri.invoke).not.toHaveBeenCalledWith('clear_validated_keys');
  });

  it('DEVICE_LIMIT vẫn khóa khi server đóng cửa sổ drain v2', async () => {
    licenseV3.run.mockRejectedValue(Object.assign(new Error('DEVICE_LIMIT'), {
      code: 'DEVICE_LIMIT',
    }));
    edge.invoke.mockResolvedValue({
      data: { status: 'INVALID_PROTOCOL', minimum_protocol: 3 },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(useAuthStore.getState().licenseValid).toBe(false);
    expect(useAuthStore.getState().isLicenseLocked).toBe(true);
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('device_limit');
  });

  it('Thử lại sau hard-lock vẫn tạo proof v2 mới và mở khóa đúng máy', async () => {
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
      value: { invoke: tauri.invoke }, configurable: true, writable: true,
    });
    const v2Token = makeV2Token(Math.floor(Date.now() / 1000) + 3_600, DEFAULT_CHALLENGE);
    let challengeAttempts = 0;
    tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') {
        expect(args).toEqual({ licenseKey: LICENSE_KEY });
        challengeAttempts += 1;
        if (challengeAttempts === 1) throw new Error('IPC challenge tạm lỗi');
        return DEFAULT_CHALLENGE;
      }
      if (command === 'load_last_online') return 0;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'load_license_token' || command === 'load_license') return '';
      return undefined;
    });
    licenseV3.run
      .mockRejectedValueOnce(Object.assign(new Error('DEVICE_LIMIT'), {
        code: 'DEVICE_LIMIT',
      }))
      .mockRejectedValueOnce(Object.assign(new Error('RATE_LIMITED'), {
        code: 'RATE_LIMITED',
      }));
    edge.invoke.mockResolvedValue({
      data: {
        status: 'VALID',
        token: v2Token,
        plan: 'pro',
        rk_status: 'legacy_fallback',
      },
      error: null,
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
    expect(useAuthStore.getState().licenseProtocolRecoveryRequired).toBe(true);
    expect(useAuthStore.getState().isLicenseLocked).toBe(true);

    await expect(useAuthStore.getState().retryValidation()).resolves.toBeUndefined();

    expect(challengeAttempts).toBe(2);
    expect(useAuthStore.getState().licenseProtocolRecoveryRequired).toBe(false);
    expect(useAuthStore.getState().licenseValid).toBe(true);
    expect(useAuthStore.getState().isLicenseLocked).toBe(false);
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', {
      licenseKey: LICENSE_KEY,
      token: v2Token,
      challenge: DEFAULT_CHALLENGE,
    });
  });

  it('anchor thiếu nhưng proof online v3 hợp lệ thì cho native khôi phục', async () => {
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return { status: 'missing' };
      return undefined;
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', expect.objectContaining({
      challengeId: CHALLENGE_ID,
    }));
  });

  it.each(['INVALID_PROOF', 'KEY_MISMATCH'] as const)(
    '%s từ protocol v3 phải fail-closed, không dùng cache offline',
    async (code) => {
      useAuthStore.setState({ licenseToken: validToken() });
      licenseV3.run.mockRejectedValue(Object.assign(new Error(code), { code }));

      await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

      expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'refresh' }));
      expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
      expect(useAuthStore.getState().licenseValidationOutcome).toBe('native_error');
    },
  );

  it.each(['corrupt', 'unavailable'] as const)(
    'lỗi mạng + anchor %s không được rơi vào offline grace và vẫn giữ key',
    async (status) => {
      useAuthStore.setState({ licenseToken: validToken(), licenseValid: true });
      tauri.invoke.mockImplementation(async (command: string) => {
        if (command === 'get_hardware_id') return NATIVE_HWID;
        if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
        if (command === 'load_clock_anchor') return { status };
        if (command === 'load_last_online') return 0;
        return undefined;
      });
      edge.invoke.mockResolvedValue({ data: null, error: { message: 'offline' } });

      await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

      expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
      expect(useAuthStore.getState().licenseValid).toBe(false);
      expect(useAuthStore.getState().isLicenseLocked).toBe(true);
      expect(useAuthStore.getState().licenseValidationOutcome)
        .toBe(status === 'corrupt' ? 'anchor_corrupt' : 'anchor_unavailable');
      expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    },
  );

  it('VALID nhưng native registration lỗi thì không cấp quyền', async () => {
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'register_validated_key') throw new Error('native anchor write failed');
      return undefined;
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    const state = useAuthStore.getState();
    expect(state.licenseKey).toBe(LICENSE_KEY);
    expect(state.licenseValid).toBe(false);
    expect(state.isLicenseLocked).toBe(true);
    expect(state.licenseValidationOutcome).toBe('native_error');
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', expect.objectContaining({
      licenseKey: LICENSE_KEY,
      challengeId: CHALLENGE_ID,
    }));
  });

  it('VALID nhưng lưu token thất bại thì không commit licenseValid', async () => {
    edge.invoke.mockResolvedValue(validResponse());
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'store_license_token') throw new Error('DPAPI unavailable');
      return undefined;
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);

    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
    expect(useAuthStore.getState().licenseToken).toBeNull();
    expect(useAuthStore.getState().licenseValid).toBe(false);
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('persistence_error');
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', expect.objectContaining({
      licenseKey: LICENSE_KEY,
      challengeId: CHALLENGE_ID,
    }));
    expect(tauri.invoke).toHaveBeenCalledWith('clear_validated_keys');
  });

  it('IPC trả envelope anchor lạ phải fail-closed, không coi là thành công', async () => {
    edge.invoke.mockResolvedValue({ data: null, error: { message: 'offline' } });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return { ok: true };
      return undefined;
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('anchor_corrupt');
    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
  });

  it('catch path chỉ cho offline grace khi anchor hợp lệ', async () => {
    useAuthStore.setState({ licenseToken: validToken() });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'load_last_online') return 0;
      return undefined;
    });
    edge.invoke.mockRejectedValue(new Error('network down'));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);
    expect(useAuthStore.getState().licenseValidationOutcome).toBe('valid_offline');
    expect(tauri.invoke).toHaveBeenCalledWith('register_validated_key', {
      licenseKey: LICENSE_KEY,
      token: expect.any(String),
    });
  });

  it('startup giữ key khi lỗi tạm thời thay vì xoá credential', async () => {
    edge.getSession.mockResolvedValue({ data: { session: null }, error: null });
    edge.invoke.mockRejectedValue(new Error('edge unavailable'));
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_license') return LICENSE_KEY;
      if (command === 'load_license_token') return '';
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return { status: 'unavailable' };
      return undefined;
    });

    await useAuthStore.getState().checkSession();

    const state = useAuthStore.getState();
    expect(state.licenseKey).toBe(LICENSE_KEY);
    expect(state.licenseValid).toBe(false);
    expect(state.isLicenseLocked).toBe(true);
    expect(state.licenseValidationOutcome).toBe('anchor_unavailable');
    expect(tauri.invoke).not.toHaveBeenCalledWith('delete_license', expect.anything());
  });

  it('startup giữ key khi server trả lỗi kỹ thuật, không coi là thu hồi', async () => {
    edge.getSession.mockResolvedValue({ data: { session: null }, error: null });
    edge.invoke.mockResolvedValue({
      data: { status: 'ERROR', message: 'temporary verification failure' },
      error: null,
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_license') return LICENSE_KEY;
      if (command === 'load_license_token') return '';
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      return undefined;
    });

    await useAuthStore.getState().checkSession();

    const state = useAuthStore.getState();
    expect(state.licenseKey).toBe(LICENSE_KEY);
    expect(state.licenseValid).toBe(false);
    expect(state.isLicenseLocked).toBe(true);
    expect(state.licenseValidationOutcome).toBe('network_error');
    expect(tauri.invoke).not.toHaveBeenCalledWith('delete_license', expect.anything());
  });

  it('startup DEVICE_LIMIT giữ key để nút Thử lại còn đường phục hồi', async () => {
    edge.getSession.mockResolvedValue({ data: { session: null }, error: null });
    licenseV3.run.mockRejectedValue(Object.assign(new Error('DEVICE_LIMIT'), {
      code: 'DEVICE_LIMIT',
    }));
    edge.invoke.mockResolvedValue({
      data: { status: 'INVALID_PROTOCOL', minimum_protocol: 3 },
      error: null,
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_license') return LICENSE_KEY;
      if (command === 'load_license_token') return '';
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      return undefined;
    });

    await useAuthStore.getState().checkSession();

    const state = useAuthStore.getState();
    expect(state.licenseKey).toBe(LICENSE_KEY);
    expect(state.licenseValid).toBe(false);
    expect(state.isLicenseLocked).toBe(true);
    expect(state.licenseValidationOutcome).toBe('device_limit');
    expect(state.isChecking).toBe(false);
    expect(tauri.invoke.mock.calls.some(([command]) => command === 'delete_license')).toBe(false);
  });

  it('startup online hợp lệ kết thúc kiểm tra và bật heartbeat', async () => {
    edge.getSession.mockResolvedValue({ data: { session: null }, error: null });
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_license') return LICENSE_KEY;
      if (command === 'load_license_token') return '';
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      return undefined;
    });
    const originalStartHeartbeat = useAuthStore.getState().startHeartbeat;
    const startHeartbeat = vi.fn();
    useAuthStore.setState({ startHeartbeat });

    try {
      await useAuthStore.getState().checkSession();

      const state = useAuthStore.getState();
      expect(state.licenseKey).toBe(LICENSE_KEY);
      expect(state.licenseValid).toBe(true);
      expect(state.licenseValidationOutcome).toBe('valid_online');
      expect(state.isChecking).toBe(false);
      expect(startHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      useAuthStore.setState({ startHeartbeat: originalStartHeartbeat });
    }
  });
});

describe('SEC.19 — giao dịch đổi license key', () => {
  it('replacement luôn yêu cầu recover v3 và không nhận token v1', async () => {
    const previousV1 = makeV1Token(Math.floor(Date.now() / 1000) + 3_600);
    const returnedV1 = makeV1Token(Math.floor(Date.now() / 1000) + 3_600, { marker: 'new' });
    useAuthStore.setState({ licenseToken: previousV1 });
    edge.invoke.mockResolvedValue({
      data: { status: 'VALID', token: returnedV1, plan: 'pro' },
      error: null,
    });

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result).toMatchObject({ ok: false, reason: 'token' });
    expect(licenseV3.run).toHaveBeenCalledWith(expect.objectContaining({
      licenseKey: 'PRYNX-NEW-KEY',
      action: 'recover',
    }));
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyMachineId');
    expect(licenseV3.run.mock.calls[0][0]).not.toHaveProperty('legacyToken');
    expect(tauri.invoke).not.toHaveBeenCalledWith('begin_license_validation', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
    expect(useAuthStore.getState().licenseToken).toBe(previousV1);
  });

  it('server từ chối key mới thì giữ nguyên key hiện tại', async () => {
    edge.invoke.mockResolvedValue({
      data: { status: 'INVALID', message: 'invalid key' },
      error: null,
    });

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result.ok).toBe(false);
    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
    expect(tauri.invoke).not.toHaveBeenCalledWith('clear_validated_keys');
  });

  it('VALID nhưng thiếu token thì không báo thành công giả', async () => {
    edge.invoke.mockResolvedValue({ data: { status: 'VALID' }, error: null });

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('token');
    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
    expect(useAuthStore.getState().licenseValid).toBe(false);
  });

  it('commit thành công giữ binding cũ tới điểm thay native nguyên tử', async () => {
    const previousToken = validToken();
    const freshToken = makeToken(Math.floor(Date.now() / 1000) + 3600, { marker: 'new' });
    useAuthStore.setState({ licenseToken: previousToken });
    edge.invoke.mockImplementation(async (name: string) => {
      if (name === 'license-verify') {
        return validResponse({ token: freshToken });
      }
      return { data: null, error: null };
    });

    let activeBinding: string | null = LICENSE_KEY;
    let persistedKey = LICENSE_KEY;
    let persistedToken = previousToken;
    const events: string[] = [];
    tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'clear_validated_keys') {
        activeBinding = null;
        events.push('clear');
        return undefined;
      }
      if (command === 'store_license') {
        expect(activeBinding).toBe(LICENSE_KEY);
        persistedKey = (args as { licenseKey: string }).licenseKey;
        events.push('store-key');
        return undefined;
      }
      if (command === 'store_license_token') {
        expect(activeBinding).toBe(LICENSE_KEY);
        persistedToken = (args as { token: string }).token;
        events.push('store-token');
        return undefined;
      }
      if (command === 'register_validated_key') {
        expect(activeBinding).toBe(LICENSE_KEY);
        expect(persistedKey).toBe('PRYNX-NEW-KEY');
        expect(persistedToken).toBe(freshToken);
        expect(args).toEqual({
          licenseKey: 'PRYNX-NEW-KEY',
          token: freshToken,
          challengeId: CHALLENGE_ID,
          replaceLicenseKey: LICENSE_KEY,
        });
        activeBinding = 'PRYNX-NEW-KEY';
        events.push('register');
        return undefined;
      }
      return undefined;
    });

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result.ok).toBe(true);
    expect(events).toEqual(['store-key', 'store-token', 'register']);
    expect(activeBinding).toBe('PRYNX-NEW-KEY');
    expect(useAuthStore.getState().licenseKey).toBe('PRYNX-NEW-KEY');
    expect(useAuthStore.getState().licenseToken).toBe(freshToken);
    expect(tauri.invoke).not.toHaveBeenCalledWith('clear_validated_keys');
    expect(licenseV3.release).toHaveBeenCalledWith(expect.objectContaining({
      licenseKey: LICENSE_KEY,
      appVersion: expect.any(String),
      invokeNative: expect.any(Function),
      invokeEdge: expect.any(Function),
    }));
    expect(edge.invoke).not.toHaveBeenCalledWith('license-release', expect.anything());
  });

  it('release v3 lỗi không rollback credential mới đã commit', async () => {
    const previousToken = validToken();
    const freshToken = makeToken(Math.floor(Date.now() / 1000) + 600, { marker: 'new' });
    useAuthStore.setState({ licenseToken: previousToken });
    edge.invoke.mockResolvedValue(validResponse({ token: freshToken }));
    licenseV3.release.mockRejectedValue(Object.assign(new Error('release rejected'), {
      code: 'CHALLENGE_USED',
    }));

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().licenseKey).toBe('PRYNX-NEW-KEY');
    expect(useAuthStore.getState().licenseToken).toBe(freshToken);
    expect(licenseV3.release).toHaveBeenCalledTimes(1);
    expect(edge.invoke).not.toHaveBeenCalledWith('license-release', expect.anything());
  });

  it('native từ chối key mới thì rollback credential, không đăng ký lại token cũ', async () => {
    const previousToken = validToken();
    const freshToken = makeToken(Math.floor(Date.now() / 1000) + 3600, { marker: 'new' });
    useAuthStore.setState({ licenseToken: previousToken });
    edge.invoke.mockResolvedValue(validResponse({ token: freshToken }));

    let activeBinding = LICENSE_KEY;
    let persistedKey = LICENSE_KEY;
    let persistedToken = previousToken;
    const registrations: Array<Record<string, unknown>> = [];
    tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'store_license') {
        persistedKey = (args as { licenseKey: string }).licenseKey;
        return undefined;
      }
      if (command === 'store_license_token') {
        persistedToken = (args as { token: string }).token;
        return undefined;
      }
      if (command === 'register_validated_key') {
        registrations.push(args as Record<string, unknown>);
        expect(activeBinding).toBe(LICENSE_KEY);
        throw new Error('native verify failed');
      }
      if (command === 'clear_validated_keys') {
        activeBinding = '';
        return undefined;
      }
      return undefined;
    });

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result.ok).toBe(false);
    expect(activeBinding).toBe(LICENSE_KEY);
    expect(persistedKey).toBe(LICENSE_KEY);
    expect(persistedToken).toBe(previousToken);
    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
    expect(registrations).toEqual([{
      licenseKey: 'PRYNX-NEW-KEY',
      token: freshToken,
      challengeId: CHALLENGE_ID,
      replaceLicenseKey: LICENSE_KEY,
    }]);
    expect(tauri.invoke).not.toHaveBeenCalledWith('clear_validated_keys');
  });

  it('lỗi lưu token rollback trên đĩa trước khi chạm binding native', async () => {
    const previousToken = validToken();
    const freshToken = makeToken(Math.floor(Date.now() / 1000) + 3600, { marker: 'new' });
    useAuthStore.setState({ licenseToken: previousToken });
    edge.invoke.mockResolvedValue(validResponse({ token: freshToken }));

    let activeBinding = LICENSE_KEY;
    let persistedKey = LICENSE_KEY;
    let persistedToken = previousToken;
    tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'begin_license_validation') return DEFAULT_CHALLENGE;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'store_license') {
        persistedKey = (args as { licenseKey: string }).licenseKey;
        return undefined;
      }
      if (command === 'store_license_token') {
        const token = (args as { token: string }).token;
        if (token === freshToken) throw new Error('DPAPI unavailable');
        persistedToken = token;
        return undefined;
      }
      if (command === 'register_validated_key') {
        activeBinding = 'PRYNX-NEW-KEY';
        return undefined;
      }
      if (command === 'clear_validated_keys') {
        activeBinding = '';
        return undefined;
      }
      return undefined;
    });

    const result = await useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');

    expect(result.ok).toBe(false);
    expect(activeBinding).toBe(LICENSE_KEY);
    expect(persistedKey).toBe(LICENSE_KEY);
    expect(persistedToken).toBe(previousToken);
    expect(useAuthStore.getState().licenseKey).toBe(LICENSE_KEY);
    expect(tauri.invoke).not.toHaveBeenCalledWith('register_validated_key', expect.anything());
    expect(tauri.invoke).not.toHaveBeenCalledWith('clear_validated_keys');
  });

  it('sign-out thắng race sau native commit và callback cũ không dựng lại UI', async () => {
    const previousToken = validToken();
    const freshToken = makeToken(Math.floor(Date.now() / 1000) + 3600, { marker: 'new' });
    useAuthStore.setState({ licenseToken: previousToken });
    let releaseRegister: (() => void) | undefined;
    let markRegisterStarted: (() => void) | undefined;
    const registerStarted = new Promise<void>((resolve) => { markRegisterStarted = resolve; });
    const events: string[] = [];
    let activeBinding: string | null = LICENSE_KEY;

    edge.signOut.mockImplementation(async () => {
      events.push('sign-out');
      return { error: null };
    });
    edge.invoke.mockImplementation(async (name: string) => {
      if (name === 'license-verify') {
        return validResponse({ token: freshToken });
      }
      if (name === 'license-release') return { data: null, error: null };
      return { data: null, error: null };
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_hardware_id') return NATIVE_HWID;
      if (command === 'load_clock_anchor') return validAnchor();
      if (command === 'register_validated_key') {
        events.push('register-start');
        markRegisterStarted?.();
        await new Promise<void>((resolve) => { releaseRegister = resolve; });
        activeBinding = 'PRYNX-NEW-KEY';
        events.push('register-commit');
        return undefined;
      }
      if (command === 'clear_validated_keys') {
        activeBinding = null;
        events.push('clear');
        return undefined;
      }
      return undefined;
    });

    const changePromise = useAuthStore.getState().changeLicenseKey('PRYNX-NEW-KEY');
    await registerStarted;
    const signOutPromise = useAuthStore.getState().signOut();

    releaseRegister?.();
    const [changeResult] = await Promise.all([changePromise, signOutPromise]);

    expect(changeResult.ok).toBe(false);
    expect(changeResult.reason).toBe('unknown');
    expect(events).toEqual(['register-start', 'register-commit', 'clear', 'sign-out', 'clear']);
    expect(activeBinding).toBeNull();
    expect(useAuthStore.getState().licenseKey).toBeNull();
    expect(useAuthStore.getState().licenseToken).toBeNull();
    expect(useAuthStore.getState().licenseValid).toBe(false);
  });

  it('timer thu hồi cũ không được xoá token sau khi đã huỷ thu hồi', async () => {
    vi.useFakeTimers();
    try {
      useAuthStore.setState({ licenseToken: validToken(), isLicenseLocked: false });
      useAuthStore.getState().beginRevocation('tạm thời');
      useAuthStore.getState().cancelRevocation();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      expect(tauri.invoke).not.toHaveBeenCalledWith('clear_validated_keys');
      expect(tauri.invoke).not.toHaveBeenCalledWith('delete_license_token');
      expect(useAuthStore.getState().licenseToken).not.toBeNull();
      expect(useAuthStore.getState().isLicenseLocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('focus liên tiếp không tạo burst xác minh license', async () => {
    // Khi mở/chuyển sang màn CNC, WebView có thể phát nhiều focus event liên tiếp.
    // Mỗi event không được xin một challenge v3 mới; nếu không quota server (8 lượt/giờ
    // cho cùng device/action) sẽ bị tiêu chỉ vì thao tác UI.
    edge.invoke.mockResolvedValue(validResponse({ rk_status: 'granted' }));
    useAuthStore.setState({ licenseToken: validToken(), licenseValid: true, isChecking: false });
    useAuthStore.getState().startHeartbeat();

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => expect(licenseV3.run).toHaveBeenCalledTimes(1));
    expect(useAuthStore.getState().licenseValid).toBe(true);
  });

  it('heartbeat và focus cùng nhịp chỉ thực hiện một lượt xác minh', async () => {
    // Focus thường phát ra ngay khi cửa sổ được mở lại, trùng thời điểm heartbeat
    // định kỳ. Hai trigger này phải dùng chung cooldown để không nhân đôi challenge.
    vi.useFakeTimers();
    const originalValidate = useAuthStore.getState().validateLicense;
    const validateSpy = vi.fn(async () => true);
    useAuthStore.setState({ validateLicense: validateSpy, isChecking: false });
    try {
      useAuthStore.getState().startHeartbeat();
      await vi.advanceTimersToNextTimerAsync();
      window.dispatchEvent(new Event('focus'));

      expect(validateSpy).toHaveBeenCalledTimes(1);
    } finally {
      useAuthStore.getState().stopHeartbeat();
      useAuthStore.setState({ validateLicense: originalValidate });
      vi.useRealTimers();
    }
  });

  it('RATE_LIMITED không cho nút Thử lại tạo thêm challenge trong cooldown', async () => {
    edge.invoke.mockResolvedValue({ data: { status: 'RATE_LIMITED' }, error: null });
    useAuthStore.setState({ licenseToken: validToken() });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_clock_anchor') return { status: 'missing' };
      return undefined;
    });

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
    await expect(useAuthStore.getState().retryValidation()).resolves.toBeUndefined();

    expect(licenseV3.run).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLicenseLocked).toBe(true);
  });

  it('RATE_LIMITED cho phép thử lại sau khi hết cooldown', async () => {
    const token = validToken();
    vi.useFakeTimers();
    edge.invoke.mockResolvedValue({ data: { status: 'RATE_LIMITED' }, error: null });
    useAuthStore.setState({ licenseToken: token });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_clock_anchor') return { status: 'missing' };
      return undefined;
    });

    try {
      await expect(useAuthStore.getState().validateLicense()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await expect(useAuthStore.getState().retryValidation()).resolves.toBeUndefined();

      expect(licenseV3.run).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().isLicenseLocked).toBe(true);
    } finally {
      useAuthStore.getState().stopHeartbeat();
      vi.useRealTimers();
    }
  });
});
