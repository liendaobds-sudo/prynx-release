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

// Telemetry bảo mật không thuộc phạm vi lô này; giữ hàng đợi rỗng để `validateLicense`
// không gọi thêm một lượt `license-verify` thứ hai làm nhiễu assertion.
vi.mock('../lib/securityEventQueue', () => ({
  clearPendingSecurityEvents: vi.fn(),
  enqueueSecurityEvent: vi.fn(),
  getPendingSecurityEvents: vi.fn(() => []),
  removePendingSecurityEvent: vi.fn(),
  toSecuritySignalDetails: vi.fn(() => ({})),
}));

import { useAuthStore, type DielineKeyStatus } from './useAuthStore';

const LICENSE_KEY = 'PRYNX-TEST-KEY';

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
  const payload = JSON.stringify({
    k: 'abc', m: 'HWID-TEST', p: 'prynx', plan: 'pro', exp: expSeconds, ...extra,
  });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

const validToken = () => makeToken(Math.floor(Date.now() / 1000) + 3600);

/** Phản hồi VALID kèm token ký — dựng riêng từng ca để thêm/bớt `rk_status`. */
function validResponse(extra: Record<string, unknown> = {}) {
  return { data: { status: 'VALID', token: validToken(), plan: 'pro', ...extra }, error: null };
}

beforeEach(() => {
  window.localStorage.clear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_hardware_id': return 'HWID-TEST';
      // lastOnline = 0 ⇒ bỏ qua anti-clockback và forward-jump: các nhánh đó có test riêng.
      case 'load_last_online': return 0;
      case 'load_license_token': return '';
      case 'load_license': return '';
      default: return undefined;
    }
  });
  edge.invoke.mockReset();
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
  });
});

afterEach(() => {
  useAuthStore.getState().stopHeartbeat();
});

describe('validateLicense → dielineKeyStatus', () => {
  it.each(SERVER_STATUSES)('ánh xạ nguyên vẹn rk_status = %s', async (status) => {
    edge.invoke.mockResolvedValue(validResponse({ rk_status: status }));

    await expect(useAuthStore.getState().validateLicense()).resolves.toBe(true);

    expect(useAuthStore.getState().dielineKeyStatus).toBe(status);
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
