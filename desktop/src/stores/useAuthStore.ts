import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import {
  isLicenseTokenValid,
  isLicenseTokenUnexpired,
  parseAnchorState,
  readLicenseTokenClaims,
  isClockConsistent,
  type AnchorState,
} from './licenseToken';
import { hasFeatureAccess, normalizePlan, type LicensePlan } from '../lib/license/features';
import { normalizeLicenseKey } from '../lib/licenseKey';
import { APP_VERSION } from '../lib/uiErrorDiagnostics';
import {
  LICENSE_PROTOCOL_V3,
  runLicenseReleaseProtocolV3,
  runLicenseProtocolV3,
  type LicenseProtocolV3EntitlementAction,
  type LicenseProtocolV3Result,
} from '../lib/licenseProtocolV3';
import {
  clearPendingSecurityEvents,
  enqueueSecurityEvent,
  getPendingSecurityEvents,
  removePendingSecurityEvent,
  toSecuritySignalDetails,
} from '../lib/securityEventQueue';

const PRODUCT_ID = 'prynx';
const LEGACY_TELEMETRY_PROTOCOL_VERSION = 2;
const LICENSE_CHALLENGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LICENSE_V2_CHALLENGE_RE = /^[0-9a-f]{64}$/;

export type ChangeLicenseKeyReason =
  | 'empty'
  | 'same'
  | 'invalid'
  | 'network'
  | 'token'
  | 'unknown';

export type ChangeLicenseKeyResult = {
  ok: boolean;
  reason?: ChangeLicenseKeyReason;
  /** Message hiển thị (server hoặc local). */
  message?: string;
};

/**
 * Kết quả nội bộ của lần kiểm tra license. Boolean `licenseValid` không đủ để phân biệt
 * server đã thu hồi key với state cục bộ bị hỏng; startup chỉ được xoá key ở nhóm
 * `server_rejected`. `device_limit` phải giữ credential để người dùng còn thử lại.
 *
 * SEC (audit 2026-09-03 §SEC.19): mọi lỗi anchor/native/network giữ credential để recovery,
 * nhưng khóa quyền cho tới khi có lần online thành công.
 */
export type LicenseValidationOutcome =
  | 'unknown'
  | 'no_key'
  | 'valid_online'
  | 'valid_offline'
  | 'rate_limited_offline'
  | 'server_rejected'
  | 'device_limit'
  | 'anchor_missing'
  | 'anchor_corrupt'
  | 'anchor_unavailable'
  | 'clock_rollback'
  | 'token_invalid'
  | 'native_error'
  | 'persistence_error'
  | 'network_error'
  | 'offline_exceeded';

type HardLockOutcome = Extract<
  LicenseValidationOutcome,
  'server_rejected' | 'device_limit'
>;

/**
 * SECURITY PATCHES:
 * - #7+: License key stored via Windows DPAPI (CryptProtectData).
 *   Encrypted with current user's Windows login session — only the same
 *   user on the same machine can decrypt. Native runtime never persists it to localStorage.
 * - #9: Added validateLicense() for periodic heartbeat checks.
 * - #3: checkSession now also validates license key on startup.
 */

const LICENSE_STORAGE_KEY = 'prynx_lk_v2';
const HWID_STORAGE_KEY = 'prynx_hwid_cache';

type PrynXRuntimeGlobal = typeof globalThis & {
  __TAURI_INTERNALS__?: unknown;
  __PRYNX_INVOKE__?: unknown;
};

/**
 * UIUX (audit 2026-08-26 dieline-engine-unlock): trạng thái cấp khoá bộ máy khuôn bế.
 *
 * Bảy giá trị đầu là enum `rk_status` do `license-verify` trả về; `'unknown'` là giá trị
 * của CHÍNH client cho mọi trường hợp không có câu trả lời mới từ server (lỗi mạng,
 * RATE_LIMITED, offline-grace theo `exp`, hoặc bundle Edge chưa có trường này). Không
 * chứa giá trị khoá, license key hay bộ đếm nào — chỉ là lý do dạng enum.
 */
export type DielineKeyStatus =
  | 'granted'
  | 'not_requested'
  | 'not_entitled'
  | 'no_key_for_version'
  | 'burst_denied'
  | 'infra_unavailable'
  | 'legacy_fallback'
  | 'unknown';

const DIELINE_KEY_STATUSES: readonly string[] = [
  'granted',
  'not_requested',
  'not_entitled',
  'no_key_for_version',
  'burst_denied',
  'infra_unavailable',
  'legacy_fallback',
];

/**
 * Chuẩn hoá `rk_status` từ phản hồi server. Fail-safe về `'unknown'`:
 * - bundle Edge chưa lên bản có `rk_status` ⇒ trường thiếu ⇒ không banner sai, không crash;
 * - server mới thêm lý do mà app chưa biết ⇒ cũng `'unknown'` thay vì hiển thị chuỗi lạ.
 */
function normalizeDielineKeyStatus(raw: unknown): DielineKeyStatus {
  return typeof raw === 'string' && DIELINE_KEY_STATUSES.includes(raw)
    ? raw as DielineKeyStatus
    : 'unknown';
}

function isNativeRuntime(): boolean {
  const runtime = globalThis as PrynXRuntimeGlobal;
  return typeof window !== 'undefined'
    && Boolean(runtime.__TAURI_INTERNALS__ || runtime.__PRYNX_INVOKE__);
}

const CANONICAL_HARDWARE_ID = /^[0-9A-F]{16}$/;

class HardwareIdentityError extends Error {
  constructor(message = 'Không xác minh được mã máy từ phần cứng') {
    super(message);
    this.name = 'HardwareIdentityError';
  }
}

/**
 * SEC (audit 2026-09-02 §SEC.16): trong app native, renderer/localStorage không phải
 * nguồn authority cho mã máy. Native lỗi, trả rỗng hoặc sai định dạng đều fail-closed.
 * Browser dev vẫn giữ fallback để UI/test không cần WMI.
 */
async function getAuthoritativeHardwareId(): Promise<string> {
  const native = isNativeRuntime();
  if (native) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const value = await invoke('get_hardware_id');
      const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
      if (!CANONICAL_HARDWARE_ID.test(normalized)) {
        throw new HardwareIdentityError();
      }
      return normalized;
    } catch (error) {
      if (error instanceof HardwareIdentityError) throw error;
      throw new HardwareIdentityError();
    }
  }

  // Chỉ dành cho browser/dev. Server vẫn áp contract production riêng cho PrynX.
  const cached = localStorage.getItem(HWID_STORAGE_KEY)?.trim().toUpperCase() || '';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const value = await invoke('get_hardware_id');
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (normalized) localStorage.setItem(HWID_STORAGE_KEY, normalized);
    return normalized || cached;
  } catch {
    return cached;
  }
}

type LicenseProtocolV3ErrorLike = Error & { code?: unknown; context?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function licenseProtocolV3ErrorCode(error: unknown): string {
  if (!isRecord(error)) return 'UNKNOWN';
  return typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : 'UNKNOWN';
}

/**
 * FunctionsHttpError giữ JSON response trong `context`. Đọc bản clone để mã từ chối
 * đóng của Edge (EXPIRED/DEVICE_LIMIT/...) không bị đánh đồng thành mất mạng; payload
 * vẫn phải qua parser nghiêm ngặt của `runLicenseProtocolV3`.
 */
async function readLicenseEdgeErrorPayload(error: unknown): Promise<unknown | null> {
  const context = (error as LicenseProtocolV3ErrorLike | null)?.context;
  if (!context || typeof (context as { clone?: unknown }).clone !== 'function') return null;
  try {
    return await (context as Response).clone().json();
  } catch {
    return null;
  }
}

async function invokeLicenseEdgeV3(
  body: Record<string, unknown>,
): Promise<{ data: unknown; error: { message?: string } | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('license-verify', { body });
    if (!error) return { data, error: null };
    const payload = await readLicenseEdgeErrorPayload(error);
    if (isRecord(payload) && typeof payload.status === 'string') {
      return { data: payload, error: null };
    }
    return {
      data: null,
      error: { message: error.message || 'Không kết nối được máy chủ bản quyền' },
    };
  } catch {
    return {
      data: null,
      error: { message: 'Không kết nối được máy chủ bản quyền' },
    };
  }
}

type LegacyDrainResult = {
  token: string;
  claims: NonNullable<ReturnType<typeof readLicenseTokenClaims>>;
  rkStatus: DielineKeyStatus;
  remainingDays: number | null;
  expiresAt: string | null;
};

/**
 * SEC (audit 2026-09-05 §SEC.16-DS3): cầu chuyển tiếp v2 chỉ chạy sau khi v3 đã
 * chứng minh CNG nhưng server trả DEVICE_LIMIT vì seat legacy của chính máy vẫn
 * đang chiếm chỗ. Server giữ cửa sổ drain 7 ngày và có thể đóng từ xa; native vẫn
 * buộc token Ed25519 khớp HWID + challenge nên đây không phải đường bỏ license.
 */
async function tryLegacyV2DrainAfterDeviceLimit(
  licenseKey: string,
): Promise<LegacyDrainResult | null> {
  let phase = 'hardware';
  try {
    const machineId = await getAuthoritativeHardwareId();
    const { invoke } = await import('@tauri-apps/api/core');
    phase = 'challenge';
    const challengeValue = await invoke<unknown>('begin_license_validation', { licenseKey });
    const challenge = typeof challengeValue === 'string'
      ? challengeValue.trim().toLowerCase()
      : '';
    if (!LICENSE_V2_CHALLENGE_RE.test(challenge)) {
      console.warn('[AUTH] Legacy v2 drain rejected local challenge');
      return null;
    }

    phase = 'edge';
    const { data, error } = await supabase.functions.invoke('license-verify', {
      body: {
        license_key: licenseKey,
        machine_id: machineId,
        product_id: PRODUCT_ID,
        app_version: APP_VERSION,
        protocol_version: LEGACY_TELEMETRY_PROTOCOL_VERSION,
        challenge,
      },
    });
    if (error || !isRecord(data) || data.status !== 'VALID' || typeof data.token !== 'string') {
      console.warn('[AUTH] Legacy v2 drain unavailable:', isRecord(data) ? data.status : 'NO_RESPONSE');
      return null;
    }
    phase = 'claims';
    const claims = readLicenseTokenClaims(data.token);
    if (!claims
      || claims.version !== LEGACY_TELEMETRY_PROTOCOL_VERSION
      || claims.challenge?.toLowerCase() !== challenge
      || claims.m?.trim().toUpperCase() !== machineId
      || claims.p !== PRODUCT_ID
      || !isLicenseTokenUnexpired(data.token)) {
      console.warn('[AUTH] Legacy v2 drain returned mismatched token claims');
      return null;
    }

    // Truyền challenge để native consume đúng biên nhận v2; renderer không thể
    // đăng ký token bearer tùy ý hoặc tự khai HWID.
    phase = 'native-register';
    await invoke('register_validated_key', {
      licenseKey,
      token: data.token,
      challenge,
    });
    return {
      token: data.token,
      claims,
      rkStatus: normalizeDielineKeyStatus(data.rk_status),
      remainingDays: typeof data.remaining_days === 'number' ? data.remaining_days : null,
      expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
    };
  } catch {
    console.warn('[AUTH] Legacy v2 drain failed at phase:', phase);
    return null;
  }
}

async function invokeNativeLicenseV3<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isNativeRuntime()) {
    throw new Error('Device authority v3 chỉ khả dụng trong bản cài PrynX');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function selectLicenseProtocolV3Action(
  cachedToken: string | null,
  recoveryRequired: boolean,
): LicenseProtocolV3EntitlementAction {
  if (recoveryRequired) return 'recover';
  const claims = readLicenseTokenClaims(cachedToken);
  if (claims?.version !== LICENSE_PROTOCOL_V3) return 'enroll';
  if (!claims.hasResourceKey
    && hasFeatureAccess('packaging.dieline', claims.plan || 'free', claims.features ?? null)) {
    return 'rk_grant';
  }
  return 'refresh';
}

function readValidatedV3ResponseClaims(response: LicenseProtocolV3Result) {
  const claims = readLicenseTokenClaims(response.token);
  if (claims?.version !== LICENSE_PROTOCOL_V3
    || claims.minimumVersion !== LICENSE_PROTOCOL_V3
    || claims.deviceKeyId !== response.device_key_id
    || !claims.challengeId
    || claims.challengeId !== response.completed_challenge_id
    || !isLicenseTokenUnexpired(response.token)) {
    return null;
  }
  return claims;
}

function isOfflineV3TokenUsable(
  token: string | null,
  anchorState: AnchorState,
): token is string {
  const claims = readLicenseTokenClaims(token);
  return claims?.version === LICENSE_PROTOCOL_V3
    && claims.minimumVersion === LICENSE_PROTOCOL_V3
    && !!claims.deviceKeyId
    && isLicenseTokenValid(token, anchorState);
}

/**
 * Đọc checkpoint đồng hồ đúng một lần cho mỗi lượt validate. Không còn quy ước `0` là
 * "OK": giá trị thiếu/hỏng/lỗi IPC đều là trạng thái không đủ điều kiện offline.
 * Browser/dev không có native gate được đánh dấu riêng để không làm gãy vòng dev;
 * production Tauri luôn đi qua IPC và không thể rơi vào nhánh này nếu runtime nguyên vẹn.
 */
async function loadClockAnchorState(): Promise<AnchorState> {
  if (!isNativeRuntime()) return { kind: 'not_required', reason: 'browser/dev không có native gate' };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return parseAnchorState(await invoke('load_clock_anchor'));
  } catch (error) {
    // Không đưa message/error tùy ý từ native lên state/UI; chỉ giữ enum an toàn.
    void error;
    return { kind: 'unavailable', reason: 'không đọc được clock anchor từ native' };
  }
}

function anchorOutcome(state: AnchorState): LicenseValidationOutcome {
  switch (state.kind) {
    case 'missing': return 'anchor_missing';
    case 'corrupt': return 'anchor_corrupt';
    case 'unavailable': return 'anchor_unavailable';
    default: return 'unknown';
  }
}

function anchorFailureReason(state: AnchorState): string {
  switch (state.kind) {
    case 'missing':
      return 'Chưa có checkpoint thời gian tin cậy. Vui lòng kết nối internet để xác minh bản quyền.';
    case 'corrupt':
      return 'Trạng thái thời gian bản quyền bị hỏng. Vui lòng kết nối internet để khôi phục.';
    case 'unavailable':
      return 'Không đọc được trạng thái thời gian bản quyền. Vui lòng khởi động lại PrynX và kết nối internet.';
    default:
      return 'Không thể xác minh trạng thái thời gian bản quyền. Vui lòng kết nối internet.';
  }
}

function isOfflineAnchorUsable(state: AnchorState, nowMs = Date.now()): boolean {
  if (state.kind === 'not_required') return true;
  return state.kind === 'valid' && isClockConsistent(state.anchorMs, nowMs);
}

function isTerminalServerStatus(status: string | undefined): boolean {
  return typeof status === 'string' && [
    'INVALID',
    'EXPIRED',
    'BLOCKED',
    'MACHINE_REVOKED',
    'DEVICE_LIMIT',
  ].includes(status);
}

// ── DPAPI-backed credential storage (primary) ──

async function saveToDPAPI(key: string): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_license', { licenseKey: key });
    return true;
  } catch {
    return false;
  }
}

async function loadFromDPAPI(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('load_license') as string;
  } catch {
    return null;
  }
}

async function deleteFromDPAPI(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_license');
  } catch { /* ignore */ }
}

// ── Nạp license key vào cache VALIDATED_KEYS của Rust ──
// sign_api_request (Rust) CHỈ ký request khi key đã có trong cache này. Phải gọi ở
// MỌI nhánh mà app coi license là dùng được (VALID / RATE_LIMITED / grace offline) — nếu
// không, app vào được nhưng mọi request backend production sẽ bị từ chối.
// Web dev không có Tauri thì bỏ qua; native production luôn fail-closed.
async function ensureKeyRegisteredInRust(
  licenseKey: string,
  explicitToken?: string | null,
  challengeId?: string | null,
  replaceLicenseKey?: string | null,
): Promise<void> {
  if (!licenseKey) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // Chụp token cùng key tại call-site. Khi heartbeat/đổi key chạy gần nhau, không được
    // đọc token toàn cục muộn rồi vô tình bind key A với token B.
    const token = explicitToken === undefined
      ? (useAuthStore.getState().licenseToken || '')
      : (explicitToken || '');
    const args: {
      licenseKey: string;
      token: string;
      challengeId?: string;
      replaceLicenseKey?: string;
    } = { licenseKey, token };
    if (challengeId) {
      if (!LICENSE_CHALLENGE_ID_RE.test(challengeId)) {
        throw new Error('Biên nhận challenge v3 không hợp lệ');
      }
      // SEC (audit 2026-09-04 §SEC.16-A1): chỉ chuyển ID đã nằm trong token ký;
      // nonce server không được lưu hay phát lại qua IPC sau bước prove.
      args.challengeId = challengeId;
    }
    if (replaceLicenseKey) args.replaceLicenseKey = replaceLicenseKey;
    await invoke('register_validated_key', args);
    if (args.challengeId && isNativeRuntime()) {
      // Chỉ native commit biên nhận v3 thành công mới mở lại đường offline.
      useAuthStore.setState({ licenseProtocolRecoveryRequired: false });
    }
  } catch (error) {
    if (isNativeRuntime()) {
      // Không đoán loại lỗi IPC/native; lần sau phải dựng proof online v3 mới.
      useAuthStore.setState({ licenseProtocolRecoveryRequired: true });
      throw error;
    }
    // Browser/dev mode has no native gate; its backend runs with DEV_MODE=true.
  }
}

// ── DPAPI-backed license TOKEN storage (C-1) ──
// Token Ed25519 do server ký được lưu mã hoá (DPAPI) để khi MỞ LẠI app lúc OFFLINE
// vẫn còn token hợp lệ gửi sidecar (backend release ép token). Token đã ràng HWID.

async function saveTokenToDPAPI(token: string): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_license_token', { token });
    return true;
  } catch { /* ignore (dev/web) */ }
  return !isNativeRuntime();
}

async function loadTokenFromDPAPI(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('load_license_token') as string;
  } catch {
    return null;
  }
}

async function deleteTokenFromDPAPI(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_license_token');
  } catch { /* ignore */ }
}

/**
 * Các wrapper này serialize cả key và token trên cùng một hàng đợi. `guard` được
 * kiểm tra ngay trước lệnh IPC, nên một thao tác đã bị sign-out/đổi generation sẽ
 * không thể ghi credential cũ sau khi cleanup mới đã được xếp hàng.
 */
function queueSaveLicenseKey(key: string, guard?: () => boolean): Promise<boolean> {
  return serializeCredentialPersistence(async () => {
    if (guard && !guard()) return false;
    return saveToDPAPI(key);
  });
}

function queueDeleteLicenseKey(guard?: () => boolean): Promise<void> {
  return serializeCredentialPersistence(async () => {
    if (guard && !guard()) return;
    await deleteFromDPAPI();
  });
}

function queueSaveLicenseToken(token: string, guard?: () => boolean): Promise<boolean> {
  return serializeCredentialPersistence(async () => {
    if (guard && !guard()) return false;
    return saveTokenToDPAPI(token);
  });
}

function queueDeleteLicenseToken(guard?: () => boolean): Promise<void> {
  return serializeCredentialPersistence(async () => {
    if (guard && !guard()) return;
    await deleteTokenFromDPAPI();
  });
}

/**
 * Khôi phục hai slot credential theo đúng thứ tự của persistence queue. Hàm này
 * cố ý không nhận guard của giao dịch mới: khi một giao dịch đã ghi dở rồi bị
 * thay thế, việc đưa đĩa về snapshot cũ phải hoàn tất trước operation kế tiếp.
 */
async function restoreCredentialSnapshot(
  previousKey: string | null,
  previousToken: string | null,
): Promise<boolean> {
  let restored = true;
  if (previousKey) {
    const saved = await queueSaveLicenseKey(previousKey);
    restored = restored && saved;
    if (saved) {
      localStorage.removeItem(LICENSE_STORAGE_KEY);
      localStorage.removeItem('prynx_license_key');
    }
  } else {
    await queueDeleteLicenseKey();
    localStorage.removeItem(LICENSE_STORAGE_KEY);
    localStorage.removeItem('prynx_license_key');
  }

  if (previousToken) {
    const saved = await queueSaveLicenseToken(previousToken);
    restored = restored && saved;
  } else {
    await queueDeleteLicenseToken();
  }
  return restored;
}

// ── Xoá cache VALIDATED_KEYS phía Rust (chặn ký request → backend 403) ──
// Gọi khi khóa cứng/thu hồi/đăng xuất. Nếu KHÔNG gọi, dù UI đã khóa, sign_api_request
// (Rust) vẫn ký request hợp lệ tới hết TTL cache (8h — security.rs) → backend vẫn xử lý PDF.
// Best-effort: không có Tauri (dev/web) thì bỏ qua êm.
// Nếu native báo lỗi, không được coi UI lock là đủ: cache Rust có thể vẫn còn
// sống. Cờ này giữ mọi request mới ở trạng thái fail-closed cho tới khi một
// lần clear native thành công hoặc process được khởi động lại.
let nativeLicenseGateBlocked = false;

export function isNativeLicenseGateBlocked(): boolean {
  return nativeLicenseGateBlocked;
}

async function clearValidatedKeysInRust(): Promise<boolean> {
  if (isNativeRuntime()) {
    // Native clear bật cùng policy: cache chỉ được dựng lại bằng proof online v3.
    useAuthStore.setState({ licenseProtocolRecoveryRequired: true });
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('clear_validated_keys');
    nativeLicenseGateBlocked = false;
    return true;
  } catch {
    // Browser/dev mode has no native signer. In native production a failed clear
    // is a security failure, not a successful cleanup.
    if (isNativeRuntime()) nativeLicenseGateBlocked = true;
    return !isNativeRuntime();
  }
}

// isLicenseTokenValid tách sang ./licenseToken (module thuần, unit-test được).

// ── localStorage fallback (for dev mode / web mode) ──

function encodeKey(key: string): string {
  try { return btoa(unescape(encodeURIComponent(key))); } catch { return key; }
}
function decodeKey(encoded: string): string {
  try { return decodeURIComponent(escape(atob(encoded))); } catch { return encoded; }
}

function loadStoredKeySync(): string | null {
  const v2 = localStorage.getItem(LICENSE_STORAGE_KEY);
  if (v2) return decodeKey(v2);
  const v1 = localStorage.getItem('prynx_license_key');
  if (v1) {
    localStorage.setItem(LICENSE_STORAGE_KEY, encodeKey(v1));
    localStorage.removeItem('prynx_license_key');
    return v1;
  }
  return null;
}

/** Load license key: DPAPI in native; localStorage only for web/dev migration. */
async function loadStoredKeyAsync(guard?: () => boolean): Promise<string | null> {
  // 1. Try DPAPI (Windows encrypted storage)
  const dpapiKey = await loadFromDPAPI();
  if (guard && !guard()) return null;
  if (dpapiKey) return dpapiKey;

  // 2. Migrate legacy localStorage once. Native must fail closed if DPAPI is unavailable.
  if (guard && !guard()) return null;
  const localKey = loadStoredKeySync();
  if (guard && !guard()) return null;
  if (localKey) {
    const saved = await queueSaveLicenseKey(localKey, guard);
    if (guard && !guard()) return null;
    if (isNativeRuntime()) {
      localStorage.removeItem(LICENSE_STORAGE_KEY);
      localStorage.removeItem('prynx_license_key');
      return saved ? localKey : null;
    }
    return localKey;
  }
  
  return null;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  licenseKey: string | null;
  /** Token license ngắn hạn do server (edge function) ký — gắn vào request gửi sidecar. */
  licenseToken: string | null;
  /** Gói lấy từ token/server. Thiếu/sai plan luôn rơi về Free (fail-closed). */
  licensePlan: LicensePlan;
  /** Quyền cấp riêng; null nghĩa là dùng quyền mặc định theo plan. */
  licenseFeatures: string[] | null;
  /**
   * UIUX (audit 2026-08-26 dieline-engine-unlock): lý do dạng enum cho việc token có/không
   * mang khoá mở bộ máy khuôn bế. Chỉ dùng để công cụ khuôn bế báo đúng bản chất và để
   * người dùng gửi kèm khi liên hệ hỗ trợ — KHÔNG phải cổng quyền, không chặn gì.
   */
  dielineKeyStatus: DielineKeyStatus;
  /** Số ngày còn lại tới hạn dùng (do verify_license trả về). null nếu không giới hạn/chưa biết. */
  remainingDays: number | null;
  /** Mốc hết hạn (ISO) do verify_license trả về. */
  licenseExpiresAt: string | null;
  isChecking: boolean;
  licenseValid: boolean;
  lastValidated: number;
  /** Phân loại lần validate gần nhất; state lỗi không làm mất key cục bộ. */
  licenseValidationOutcome: LicenseValidationOutcome;
  /** Native cache đã bị xoá/lỗi commit; chỉ proof online v3 mới được dựng lại binding. */
  licenseProtocolRecoveryRequired: boolean;
  /** Soft lock: blocks UI but does NOT sign out. Auto-unlocks when internet returns. */
  isLicenseLocked: boolean;
  lockReason: string;
  /** Thu hồi có ân hạn: khi server báo key bị khóa/hết hạn, hiện popup đếm ngược
   *  REVOKE_GRACE_MS để khách kịp lưu file trước khi khóa cứng. Tự huỷ nếu key VALID lại. */
  isRevoking: boolean;
  /** Epoch ms hết giờ đếm ngược thu hồi. null khi không trong trạng thái thu hồi. */
  revokeDeadline: number | null;
  revokeReason: string;
  /**
   * Generation sống trong process của credential/license session. Mọi lượt async
   * phải chụp generation và bỏ qua commit nếu sign-out/đổi credential đã tiến sang
   * generation khác (SEC (audit 2026-09-03 §SEC.19)).
   */
  licenseSessionEpoch: number;
  /** Sign-out đã được yêu cầu nhưng hàng đợi cleanup chưa hoàn tất. */
  licenseSignOutPending: boolean;

  setUser: (user: User | null, session: Session | null) => void;
  setLicenseKey: (key: string | null) => void;
  setIsChecking: (isChecking: boolean) => void;

  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
  validateLicense: () => Promise<boolean>;
  retryValidation: () => Promise<void>;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
  /**
   * Đổi license key (verify-first).
   * Chỉ ghi đè key local khi server trả VALID. Không logout Google.
   * Key cũ giữ nguyên nếu verify fail / mạng lỗi.
   */
  changeLicenseKey: (rawKey: string) => Promise<ChangeLicenseKeyResult>;
  /** Bắt đầu quy trình thu hồi có ân hạn (idempotent — gọi lại không reset deadline). */
  beginRevocation: (reason: string) => void;
  /** Huỷ thu hồi khi key hợp lệ trở lại (admin mở khóa trong thời gian ân hạn). */
  cancelRevocation: () => void;
  /** Khóa cứng ngay: overlay + xoá cache ký Rust + dọn token. Gọi khi hết giờ ân hạn. */
  enforceHardLock: (
    reason: string,
    expectedRevocationGeneration?: number,
    alreadySerialized?: boolean,
    outcome?: HardLockOutcome,
  ) => Promise<void>;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let retryInterval: ReturnType<typeof setInterval> | null = null;
let revokeTimer: ReturnType<typeof setTimeout> | null = null;
// UIUX (audit 2026-09-05 §AUTH.RATE): RATE_LIMITED là trạng thái tạm thời của
// server. Giữ một khoảng nghỉ để nút Thử lại không tự đốt tiếp quota v3.
let rateLimitedRetryAfterMs = 0;
// Generation riêng cho timer thu hồi. clearTimeout không đủ nếu callback đã
// được đưa vào event loop; callback cũ phải tự chứng minh nó vẫn là lượt hiện
// tại trước khi dọn token mới.
let revokeGeneration = 0;
let focusValidationHandler: (() => void) | null = null;
// SEC (audit 2026-09-03 §SEC.19): heartbeat/focus/retry và đổi key có thể cùng
// chạy. Serialize toàn bộ thao tác license để không đăng ký cặp key A/token B
// hoặc để lượt validate cũ ghi đè kết quả của key mới.
let licenseOperationTail: Promise<void> = Promise.resolve();
// Số lượt license đang chờ hoặc đang chạy. API client dùng cờ này cùng epoch
// để không ký request trong khoảng native binding đang được thay thế; chỉ kiểm
// epoch là chưa đủ vì state key/token vẫn có thể chưa commit ở giữa giao dịch.
let licenseMutationPending = 0;

// Persistence cũng phải có một hàng đợi riêng: setter Zustand là đồng bộ nhưng
// DPAPI là async. Nếu delete của key cũ chạy sau save key mới, sign-out/đổi key có
// thể để lại credential sai trên đĩa dù state trong memory đã đúng.
let credentialPersistenceTail: Promise<void> = Promise.resolve();
let pendingSignOutRequests = 0;
// Mỗi lượt startup có ownership riêng. Epoch license có thể tăng hợp lệ ngay trong
// `validateLicense` khi commit token/hard-lock, nên không thể dùng riêng epoch đó để
// quyết định lượt `checkSession` còn được quyền kết thúc spinner hay không.
let sessionCheckGeneration = 0;

function serializeCredentialPersistence<T>(operation: () => Promise<T>): Promise<T> {
  const run = credentialPersistenceTail.then(operation, operation);
  credentialPersistenceTail = run.then(() => undefined, () => undefined);
  return run;
}

function sessionSnapshotIsCurrent(
  getState: () => Pick<AuthState, 'licenseSessionEpoch' | 'licenseSignOutPending' | 'licenseKey'>,
  epoch: number,
  expectedKey?: string | null,
): boolean {
  const state = getState();
  // `licenseOperationEpoch` là nguồn chân lý module-level mà api.ts cũng đọc được;
  // state Zustand chỉ là bản sao để UI/test quan sát.
  if (getLicenseOperationEpoch() !== epoch) return false;
  if (state.licenseSignOutPending) return false;
  return expectedKey === undefined || state.licenseKey === expectedKey;
}

// SEC (audit 2026-09-03 §SEC.19): tăng ngay khi một thao tác thay đổi credential
// được yêu cầu. Các lời gọi async cũ (đặc biệt API signer) phải bỏ kết quả, không
// được đăng ký lại binding hoặc ghi đè state sau thao tác mới hơn.
let licenseOperationEpoch = 0;
let licenseChangeEpoch = 0;

export function getLicenseOperationEpoch(): number {
  return licenseOperationEpoch;
}

/** API signer phải dừng trong lúc một giao dịch license đang chờ/đang commit. */
export function isLicenseOperationPending(): boolean {
  return licenseMutationPending > 0;
}

function bumpLicenseOperationEpoch(): number {
  licenseOperationEpoch += 1;
  return licenseOperationEpoch;
}

function bumpLicenseChangeEpoch(): { operationEpoch: number; changeEpoch: number } {
  const operationEpoch = bumpLicenseOperationEpoch();
  licenseChangeEpoch += 1;
  return { operationEpoch, changeEpoch: licenseChangeEpoch };
}

function serializeLicenseOperation<T>(operation: () => Promise<T>): Promise<T> {
  licenseMutationPending += 1;
  const run = licenseOperationTail.then(operation, operation);
  const tracked = run.finally(() => {
    licenseMutationPending = Math.max(0, licenseMutationPending - 1);
  });
  licenseOperationTail = tracked.then(() => undefined, () => undefined);
  return tracked;
}

// UIUX (audit 2026-09-05 §AUTH.RATE): challenge v3 giới hạn 8 lượt/device/action
// trong một giờ. Nhịp 5 phút tạo 12 lượt/giờ trước cả focus; 10 phút còn tối đa
// 6 lượt/giờ, vẫn đủ dư địa cho một lượt focus sau khi người dùng quay lại app.
// Token v3 có TTL 15 phút nên nhịp này vẫn refresh trước khi hết hạn.
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const SCHEDULED_VALIDATION_MIN_INTERVAL_MS = 10 * 60 * 1000;
const RATE_LIMIT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const RETRY_INTERVAL_MS = 30 * 1000;              // 30 seconds (when locked)
const REVOKE_GRACE_MS = 5 * 60 * 1000;            // 5 phút ân hạn để khách kịp lưu file trước khi khóa cứng

/**
 * Durable security telemetry. Events are queued without a license key, then
 * retried after the license server is reachable and has verified the machine.
 */
let telemetryFlushPromise: Promise<void> | null = null;

async function getTelemetryHardwareId(): Promise<string> {
  try {
    return await getAuthoritativeHardwareId();
  } catch {
    // Telemetry là best-effort; không gửi nếu native không chứng thực được mã máy.
    return '';
  }
}

function createLicenseProtocolChallenge(): string | null {
  try {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // Luồng license fail-closed; telemetry best-effort giữ queue để lượt sau thử lại.
    return null;
  }
}

/** Ghi credential và chỉ báo thành công khi đã có bản lưu bền vững. */
async function persistLicenseKeySecure(key: string, guard?: () => boolean): Promise<boolean> {
  const saved = await queueSaveLicenseKey(key, guard);
  if (saved) {
    localStorage.removeItem(LICENSE_STORAGE_KEY);
    localStorage.removeItem('prynx_license_key');
    return true;
  }
  // Không hạ cấp sang localStorage sau khi giao dịch đã stale/sign-out. Nếu
  // không có hàng rào này, browser/dev có thể ghi lại key cũ dù queue đã từ
  // chối đúng callback của phiên trước.
  if (guard && !guard()) return false;
  if (!isNativeRuntime()) {
    try {
      localStorage.setItem(LICENSE_STORAGE_KEY, encodeKey(key));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function flushPendingSecurityEvents(): Promise<void> {
  if (telemetryFlushPromise) return telemetryFlushPromise;

  telemetryFlushPromise = (async () => {
    const startEpoch = getLicenseOperationEpoch();
    const startState = useAuthStore.getState();
    const licenseKey = startState.licenseKey;
    const isCurrent = () => {
      const state = useAuthStore.getState();
      return getLicenseOperationEpoch() === startEpoch
        && !state.licenseSignOutPending
        && state.licenseKey === licenseKey;
    };
    if (!isCurrent()) return;
    if (!licenseKey) return;

    const hwid = await getTelemetryHardwareId();
    if (!isCurrent()) return;
    if (!hwid) return;

    const pending = getPendingSecurityEvents().slice(0, 10);
    for (const event of pending) {
      if (!isCurrent()) return;
      // SEC (audit 2026-09-04 §SEC.16-DS2): telemetry luôn dùng v2, không tham gia
      // cửa sổ drain v1. Challenge được sinh riêng trong renderer và KHÔNG gọi
      // `begin_license_validation`, tránh vô hiệu challenge native của một lượt
      // activation/đổi key đang chạy. Token trả về ở request telemetry bị bỏ.
      const telemetryChallenge = createLicenseProtocolChallenge();
      if (!telemetryChallenge) break;
      try {
        const { data, error } = await supabase.functions.invoke('license-verify', {
          body: {
            license_key: licenseKey,
            machine_id: hwid,
            product_id: PRODUCT_ID,
            protocol_version: LEGACY_TELEMETRY_PROTOCOL_VERSION,
            challenge: telemetryChallenge,
            client_signal: {
              event_type: event.eventType,
              details: toSecuritySignalDetails(event),
            },
          },
        });

        if (!isCurrent()) return;
        if (error) break;

        const response = data as Record<string, unknown> | null;
        // Chỉ server ack tường minh mới được dequeue. INVALID_PROTOCOL/ERROR/mã
        // tương lai đều phải giữ lại; trước đây chúng bị xoá dù chưa hề được ghi.
        if (response?.security_signal_processed === true) {
          removePendingSecurityEvent(event.id);
          continue;
        }

        // Server was reachable but did not confirm processing. Keep the event for retry.
        break;
      } catch {
        break;
      }
    }
  })().finally(() => {
    telemetryFlushPromise = null;
  });

  return telemetryFlushPromise;
}

function logSecurityEvent(eventType: string, details: Record<string, unknown> = {}): void {
  enqueueSecurityEvent(eventType, details);
  void flushPendingSecurityEvents();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  licenseKey: isNativeRuntime() ? null : loadStoredKeySync(),
  licenseToken: null,
  licensePlan: 'free',
  licenseFeatures: null,
  // Chưa gọi verify lần nào ⇒ chưa có câu trả lời nào từ server.
  dielineKeyStatus: 'unknown',
  remainingDays: null,
  licenseExpiresAt: null,
  isChecking: true,
  licenseValid: false,
  lastValidated: 0,
  licenseValidationOutcome: 'unknown',
  licenseProtocolRecoveryRequired: false,
  isLicenseLocked: false,
  lockReason: '',
  isRevoking: false,
  revokeDeadline: null,
  revokeReason: '',
  licenseSessionEpoch: 0,
  licenseSignOutPending: false,

  setUser: (user, session) => set({ user, session }),
  
  setLicenseKey: (key) => {
    const previousKey = get().licenseKey;
    const keyChanged = previousKey !== key;
    if (keyChanged) rateLimitedRetryAfterMs = 0;
    const epoch = keyChanged
      // Setter là một đường thay đổi credential thật (startup reject, import
      // legacy, hoặc UI cũ). Invalidate cả change transaction đang chờ, không
      // chỉ API signer, để callback cũ không ghi lại key/token đã bị thay thế.
      ? bumpLicenseChangeEpoch().operationEpoch
      : getLicenseOperationEpoch();
    if (keyChanged && previousKey) {
      // A queued event must never be attributed to a different customer key.
      clearPendingSecurityEvents();
    }

    set({ licenseKey: key, licenseSessionEpoch: epoch });
    if (key) {
      // Setter vẫn giữ API đồng bộ cho caller, nhưng persistence chạy qua hàng đợi
      // và có generation guard để callback cũ không dọn nhầm localStorage của key mới.
      void queueSaveLicenseKey(key, () => sessionSnapshotIsCurrent(get, epoch, key))
        .then(saved => {
          if (!sessionSnapshotIsCurrent(get, epoch, key)) return;
          if (saved) {
            localStorage.removeItem(LICENSE_STORAGE_KEY);
            localStorage.removeItem('prynx_license_key');
          } else if (!isNativeRuntime()) {
            // Browser-only development fallback. Never persist a native credential here.
            localStorage.setItem(LICENSE_STORAGE_KEY, encodeKey(key));
          } else {
            localStorage.removeItem(LICENSE_STORAGE_KEY);
            localStorage.removeItem('prynx_license_key');
            console.error('[SECURITY] DPAPI license storage failed; key kept in memory only');
          }
        });
    } else {
      // Xóa key qua cùng persistence queue; nếu caller đặt key mới ngay sau đó,
      // save mới luôn chạy sau delete cũ và không bị callback fire-and-forget ghi đè.
      void queueDeleteLicenseKey();
      localStorage.removeItem(LICENSE_STORAGE_KEY);
      localStorage.removeItem('prynx_license_key');
    }
  },

  setIsChecking: (isChecking) => set({ isChecking }),

  // SEC (audit 2026-09-03 §SEC.19): sign-out là barrier của mọi giao dịch license.
  // Đổi key/heartbeat có thể đang chờ Edge, DPAPI hoặc native; nếu sign-out chạy
  // ngoài queue, lượt staged đó có thể commit lại key/token sau khi người dùng đã
  // đăng xuất. Serialize cùng hàng đợi để cleanup hoàn tất rồi mới cho operation mới.
  signOut: () => {
    // Đánh dấu barrier NGAY khi caller yêu cầu, trước cả khi lượt này được xếp
    // sau một transaction đang chờ Edge. API signer/checkSession nhìn thấy cờ này
    // và không được đăng ký lại credential cũ trong khoảng cleanup.
    const requestedEpoch = bumpLicenseOperationEpoch();
    pendingSignOutRequests += 1;
    set({ licenseSessionEpoch: requestedEpoch, licenseSignOutPending: true });
    return serializeLicenseOperation(async () => {
      try {
        get().stopHeartbeat();
        const cleared = await clearValidatedKeysInRust();
        if (!cleared && isNativeRuntime()) {
          console.error('[SECURITY] Native license cache could not be cleared during sign-out');
        }
        try {
          await supabase.auth.signOut();
        } catch (error) {
          // Local credential cleanup vẫn phải chạy nếu phiên Google lỗi mạng.
          console.warn('[AUTH] Supabase sign-out failed; local cleanup continues:', error);
        }
      } finally {
        // Không gọi `setLicenseKey(null)`: setter là API đồng bộ và có thể xếp một
        // persistence callback mới. Dùng queue + await để delete luôn đứng đúng thứ
        // tự trước bất kỳ save key/token nào phát sinh sau đó.
        clearPendingSecurityEvents();
        localStorage.removeItem(LICENSE_STORAGE_KEY);
        localStorage.removeItem('prynx_license_key');
        await queueDeleteLicenseKey();
        await queueDeleteLicenseToken();

        // Một generation mới sau khi xóa bền vững chặn mọi callback đã chụp
        // `requestedEpoch`; giữ pending=true cho tới khi native clear lần cuối xong.
        const finalEpoch = bumpLicenseOperationEpoch();
        set({ licenseSessionEpoch: finalEpoch, licenseSignOutPending: true });
        const finalCleared = await clearValidatedKeysInRust();
        if (!finalCleared && isNativeRuntime()) {
          console.error('[SECURITY] Final native license-cache clear failed after sign-out');
        }

        pendingSignOutRequests = Math.max(0, pendingSignOutRequests - 1);
        set({
          user: null, session: null, licenseKey: null, licenseValid: false, lastValidated: 0,
          licenseValidationOutcome: 'unknown',
          remainingDays: null, licenseExpiresAt: null, licenseToken: null,
          licensePlan: 'free', licenseFeatures: null,
          isRevoking: false, revokeDeadline: null, revokeReason: '',
          licenseSessionEpoch: finalEpoch,
          licenseSignOutPending: pendingSignOutRequests > 0,
        });
        rateLimitedRetryAfterMs = 0;
      }
    });
  },

  checkSession: async () => {
    // Snapshot generation trước mọi await. Sign-out có thể được gọi trong lúc
    // Supabase/DPAPI đang chờ; các callback của lượt cũ khi quay lại phải bị bỏ qua.
    const checkGeneration = ++sessionCheckGeneration;
    const ownsCheck = () => checkGeneration === sessionCheckGeneration;
    let sessionEpoch = getLicenseOperationEpoch();
    const isCurrent = () => ownsCheck() && sessionSnapshotIsCurrent(get, sessionEpoch);
    set({ isChecking: true, licenseSessionEpoch: sessionEpoch });
    if (get().licenseSignOutPending) {
      if (ownsCheck()) set({ isChecking: false });
      return;
    }

    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (isCurrent()) set({ session, user: session?.user || null });
    } catch (err) {
      // Google là kênh hỗ trợ tìm lại key, lỗi phiên Google không được chặn kích hoạt bằng key.
      console.error('Session check failed:', err);
      if (isCurrent()) set({ session: null, user: null });
    }

    try {
      if (!isCurrent()) return;
      // PATCH #3: Validate license on startup (not just check if key exists)
      // Load from DPAPI first (async), then validate.
      const dpapiKey = await loadStoredKeyAsync(isCurrent);
      if (!isCurrent()) return;
      if (dpapiKey && dpapiKey !== get().licenseKey) {
        // Nạp credential từ DPAPI là một chuyển generation (không dùng setter vì
        // setter sẽ ghi lại cùng key một lần nữa). Mọi request đã chụp key cũ bị vô hiệu.
        sessionEpoch = bumpLicenseChangeEpoch().operationEpoch;
        set({ licenseKey: dpapiKey, licenseSessionEpoch: sessionEpoch });
      }
      const storedKey = dpapiKey || get().licenseKey;
      if (storedKey) {
        if (!isCurrent()) return;
        // C-1: nạp token đã lưu (DPAPI) trước khi validate — để nếu OFFLINE (RPC lỗi,
        // vào grace) thì vẫn có token hợp lệ gửi sidecar. Chỉ dùng nếu CHƯA hết hạn.
        const persistedToken = await loadTokenFromDPAPI();
        if (!isCurrent()) return;
        // Chỉ nạp token vào bộ nhớ để chuẩn bị validate; quyền offline vẫn phải đi qua
        // `validateLicense`, nơi bắt buộc AnchorState hợp lệ. Không dùng token advisory này
        // để tự mở khóa khi anchor thiếu/hỏng.
        if (isLicenseTokenUnexpired(persistedToken)) {
          const claims = readLicenseTokenClaims(persistedToken);
          if (persistedToken !== get().licenseToken) sessionEpoch = bumpLicenseOperationEpoch();
          set({
            licenseToken: persistedToken,
            licensePlan: claims?.plan ? normalizePlan(claims.plan) : 'free',
            licenseFeatures: claims?.features ?? null,
            licenseSessionEpoch: sessionEpoch,
          });
        } else if (persistedToken) {
          await queueDeleteLicenseToken(isCurrent); // token cũ đã hết hạn → dọn
          if (!isCurrent()) return;
        }
        const isValid = await get().validateLicense();
        // Chính validate có thể tăng operation epoch khi nhận token mới hoặc khóa
        // native. Chỉ nhận epoch mới nếu lượt startup này vẫn sở hữu cùng key và
        // không có sign-out xen vào; như vậy không nuốt nhầm một mutation khác.
        if (!ownsCheck() || get().licenseSignOutPending || get().licenseKey !== storedKey) return;
        sessionEpoch = getLicenseOperationEpoch();
        set({ licenseSessionEpoch: sessionEpoch });
        if (!isCurrent()) return;
        if (!isValid) {
          const outcome = get().licenseValidationOutcome;
          // Chỉ câu trả lời terminal đã được server xác nhận mới được dọn credential.
          // Anchor/DPAPI/network/native lỗi phải giữ key để người dùng recovery và buộc
          // online revalidation; tuyệt đối không biến lỗi tạm thời thành logout âm thầm.
          if (outcome === 'server_rejected') {
            console.warn('[AUTH] Stored license key rejected by server — clearing');
            get().cancelRevocation();
            get().setLicenseKey(null);
            sessionEpoch = getLicenseOperationEpoch();
            if (isCurrent()) set({ licenseValid: false, isLicenseLocked: false, lockReason: '' });
          } else if (get().licenseKey && isCurrent()) {
            set({
              licenseValid: false,
              isLicenseLocked: true,
              lockReason: get().lockReason || 'Cần kết nối mạng để xác minh lại bản quyền.',
            });
          }
        } else if (isCurrent()) {
          // Start heartbeat after successful validation
          get().startHeartbeat();
        }
      }
    } catch (err) {
      if (isCurrent()) console.error('License startup check failed:', err);
    } finally {
      // Epoch có thể đã đổi do chính validate/setLicenseKey ở trên; generation mới
      // là ownership của spinner, còn sign-out vẫn được phép kết thúc startup cũ.
      if (ownsCheck()) set({ isChecking: false });
    }
  },

  /**
   * PATCH #9: Validate license key against Supabase RPC.
   * Called on startup and periodically (heartbeat).
   */
  validateLicense: (): Promise<boolean> => serializeLicenseOperation(async () => {
    let operationEpoch = getLicenseOperationEpoch();
    const { licenseKey } = get();
    const isCurrent = () => sessionSnapshotIsCurrent(get, operationEpoch, licenseKey);
    const failClosed = (outcome: LicenseValidationOutcome, reason: string): false => {
      if (!isCurrent()) return false;
      set({
        licenseValid: false,
        isLicenseLocked: true,
        lockReason: reason,
        licenseValidationOutcome: outcome,
      });
      return false;
    };

    if (get().licenseSignOutPending || !isCurrent()) return false;
    if (!licenseKey) {
      // Chưa có key ⇒ chưa hề gọi server ⇒ không biết gì về khoá engine.
      set({ dielineKeyStatus: 'unknown', licenseValid: false, licenseValidationOutcome: 'no_key' });
      return false;
    }

    // Chụp một AnchorState cho toàn bộ lượt kiểm tra. Không nhánh nào được tự đọc lại
    // rồi diễn giải `0`/lỗi IPC theo cách khác (SEC.19).
    const anchorState = await loadClockAnchorState();
    if (!isCurrent()) return false;
    const now = Date.now();
    const ensureOfflineAnchor = (): boolean => {
      if (isOfflineAnchorUsable(anchorState, now)) return true;
      if (anchorState.kind === 'valid') {
        logSecurityEvent('clock_anchor_rollback', {
          clockAnchor: anchorState.anchorMs,
          now,
          delta: anchorState.anchorMs - now,
        });
        failClosed('clock_rollback', 'Phát hiện đồng hồ hệ thống bị thay đổi. Vui lòng đặt lại thời gian chính xác và kết nối internet.');
      } else {
        logSecurityEvent('clock_anchor_unavailable', { state: anchorState.kind });
        failClosed(anchorOutcome(anchorState), anchorFailureReason(anchorState));
      }
      return false;
    };

    // SEC (audit 2026-09-04 §SEC.16-A1): client mới chỉ xin quyền bằng
    // device authority v3. Token cũ chỉ được dùng làm dữ liệu migration ở request
    // challenge; không có đường refresh/offline v1/v2 và không fallback sau lỗi v3.
    const cachedProtocolToken = get().licenseToken || await loadTokenFromDPAPI();
    if (!isCurrent()) return false;
    const protocolRecoveryRequired = get().licenseProtocolRecoveryRequired;
    const action = selectLicenseProtocolV3Action(
      cachedProtocolToken,
      protocolRecoveryRequired,
    );

    const tryCommitLegacyDrain = async (): Promise<boolean> => {
      const legacyDrain = await tryLegacyV2DrainAfterDeviceLimit(licenseKey);
      if (!isCurrent() || !legacyDrain) return false;
      if (!(await queueSaveLicenseToken(legacyDrain.token, isCurrent))) return false;
      if (!isCurrent()) return false;
      if (legacyDrain.token !== get().licenseToken) {
        operationEpoch = bumpLicenseOperationEpoch();
      }
      set({
        licenseToken: legacyDrain.token,
        licensePlan: normalizePlan(legacyDrain.claims.plan || 'free'),
        licenseFeatures: legacyDrain.claims.features ?? null,
        dielineKeyStatus: legacyDrain.rkStatus,
        licenseSessionEpoch: operationEpoch,
        licenseProtocolRecoveryRequired: false,
        licenseValid: true,
        lastValidated: Date.now(),
        licenseValidationOutcome: 'valid_online',
        remainingDays: legacyDrain.remainingDays,
        licenseExpiresAt: legacyDrain.expiresAt,
        isLicenseLocked: false,
        lockReason: '',
      });
      rateLimitedRetryAfterMs = 0;
      if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
      return true;
    };

    try {
      const response = await runLicenseProtocolV3({
        licenseKey,
        action,
        appVersion: APP_VERSION,
        invokeNative: invokeNativeLicenseV3,
        invokeEdge: invokeLicenseEdgeV3,
      });
      if (!isCurrent()) return false;

      // Một lượt online thành công đã giải phóng mọi cooldown tạm thời trước đó.
      rateLimitedRetryAfterMs = 0;
      const claims = readValidatedV3ResponseClaims(response);
      if (!claims) {
        set({ dielineKeyStatus: 'unknown' });
        return failClosed(
          'token_invalid',
          'Không thể xác minh bản quyền trên thiết bị này. Vui lòng kết nối mạng và thử lại.',
        );
      }

      try {
        await ensureKeyRegisteredInRust(
          licenseKey,
          response.token,
          claims.challengeId,
        );
      } catch {
        set({ dielineKeyStatus: 'unknown' });
        return failClosed(
          'native_error',
          'Không thể xác minh bản quyền trên thiết bị này. Vui lòng thử lại.',
        );
      }
      if (!isCurrent()) return false;

      // Chỉ lưu token sau khi native đã xác minh chữ ký, device binding và private-key
      // presence. Nếu DPAPI lỗi, dọn binding vừa cấp để không có cửa sổ quyền lệch state.
      if (!(await queueSaveLicenseToken(response.token, isCurrent))) {
        if (isCurrent()) await clearValidatedKeysInRust();
        set({ dielineKeyStatus: 'unknown' });
        return failClosed(
          'persistence_error',
          'Không lưu được thông tin bản quyền an toàn. Vui lòng khởi động lại PrynX.',
        );
      }
      if (!isCurrent()) return false;

      if (response.token !== get().licenseToken) operationEpoch = bumpLicenseOperationEpoch();
      set({
        licenseToken: response.token,
        licensePlan: normalizePlan(claims.plan || 'free'),
        licenseFeatures: claims.features ?? null,
        dielineKeyStatus: normalizeDielineKeyStatus(response.rk_status),
        licenseSessionEpoch: operationEpoch,
        licenseValid: true,
        lastValidated: Date.now(),
        licenseValidationOutcome: 'valid_online',
        remainingDays: typeof response.remaining_days === 'number'
          ? response.remaining_days
          : null,
        licenseExpiresAt: response.expires_at || null,
      });

      // Clock anchor vẫn do native quản lý; mốc này chỉ phục vụ chẩn đoán/telemetry.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('store_last_online', { timestampMs: Date.now() });
      } catch { /* best-effort */ }
      if (!isCurrent()) return false;

      if (get().isLicenseLocked) {
        set({ isLicenseLocked: false, lockReason: '' });
        if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
        get().startHeartbeat();
      }
      if (get().isRevoking) get().cancelRevocation();
      void flushPendingSecurityEvents();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      const code = licenseProtocolV3ErrorCode(error);
      console.warn('[AUTH] License protocol v3 failed:', code);
      set({ dielineKeyStatus: 'unknown' });

      if (code === 'RATE_LIMITED') {
        // Server dùng cửa sổ trượt một giờ; retry sớm hơn chỉ làm tình trạng xấu
        // thêm mà không tăng khả năng phục hồi. Không ảnh hưởng các lỗi terminal.
        rateLimitedRetryAfterMs = Math.max(
          rateLimitedRetryAfterMs,
          Date.now() + RATE_LIMIT_RETRY_COOLDOWN_MS,
        );
      }

      if (code === 'DEVICE_LIMIT') {
        logSecurityEvent('device_limit');
        // Máy đang dùng seat HWID cũ không được bị đá khỏi công việc chỉ vì lần
        // nâng binding lên CNG cần admin migration. Kể cả native vừa bị clear,
        // proof v2 MỚI vẫn đủ quyền khôi phục: server giới hạn cửa sổ drain, còn
        // native đối chiếu chữ ký + key + HWID + challenge trước khi hạ cờ recovery.
        if (await tryCommitLegacyDrain()) return true;
        if (!isCurrent()) return false;
        set({ licenseValidationOutcome: 'device_limit' });
        await get().enforceHardLock(
          'Khóa bản quyền đã đạt giới hạn thiết bị. Liên hệ hỗ trợ để mở thêm.',
          undefined,
          true,
          'device_limit',
        );
        return false;
      }

      if (isTerminalServerStatus(code)) {
        const reasonByStatus: Record<string, string> = {
          EXPIRED: 'Bản quyền đã hết hạn. Vui lòng gia hạn để tiếp tục sử dụng.',
          MACHINE_REVOKED: 'Máy này đã bị quản trị viên thu hồi khỏi license.',
          BLOCKED: 'Bản quyền đã bị khóa bởi quản trị viên.',
          INVALID: 'Bản quyền đã bị thu hồi hoặc không còn hợp lệ.',
        };
        set({ licenseValidationOutcome: 'server_rejected' });
        await get().enforceHardLock(
          reasonByStatus[code] || 'Bản quyền không còn hợp lệ.',
          undefined,
          true,
        );
        return false;
      }

      // Chỉ lỗi kết nối/rate-limit được dùng token offline, và token đó bắt buộc
      // là v3 còn hạn + anchor hợp lệ. Challenge/proof sai không được
      // che bằng cache cũ, kể cả cache v3.
      if (code === 'NETWORK_ERROR' || code === 'RATE_LIMITED') {
        // Sau một DEVICE_LIMIT đã clear native, rate-limit v3 không được làm kẹt
        // nút Thử lại: proof v2 mới vẫn qua policy chuyển tiếp hữu hạn của server
        // và native tự đối chiếu chữ ký + HWID + challenge trước khi cấp quyền.
        if (code === 'RATE_LIMITED' && protocolRecoveryRequired) {
          if (await tryCommitLegacyDrain()) return true;
          if (!isCurrent()) return false;
        }
        if (!ensureOfflineAnchor()) return false;
        if (protocolRecoveryRequired) {
          return failClosed(
            'native_error',
            'Cần kết nối mạng để xác minh lại bản quyền.',
          );
        }
        const offlineToken = get().licenseToken || await loadTokenFromDPAPI();
        if (!isCurrent()) return false;
        if (!isOfflineV3TokenUsable(offlineToken, anchorState)) {
          return failClosed(
            'token_invalid',
            'Phiên xác minh bản quyền đã hết hạn. Vui lòng kết nối mạng để xác minh lại.',
          );
        }
        try {
          await ensureKeyRegisteredInRust(licenseKey, offlineToken);
        } catch {
          return failClosed(
            'native_error',
            'Không thể xác minh bản quyền đã lưu trên thiết bị này. Vui lòng kết nối mạng và thử lại.',
          );
        }
        if (!isCurrent()) return false;
        const offlineClaims = readLicenseTokenClaims(offlineToken);
        if (offlineToken !== get().licenseToken) {
          operationEpoch = bumpLicenseOperationEpoch();
        }
        set({
          licenseToken: offlineToken,
          licensePlan: normalizePlan(offlineClaims?.plan || 'free'),
          licenseFeatures: offlineClaims?.features ?? null,
          licenseSessionEpoch: operationEpoch,
          licenseValid: true,
          lastValidated: Date.now(),
          licenseValidationOutcome: code === 'RATE_LIMITED'
            ? 'rate_limited_offline'
            : 'valid_offline',
        });
        return true;
      }

      if (code === 'RECOVERY_REQUIRED') {
        return failClosed(
          'native_error',
          'Không thể khôi phục trạng thái bản quyền trên thiết bị này. Vui lòng liên hệ hỗ trợ.',
        );
      }
      if ([
        'INVALID_IDENTITY',
        'INVALID_PROOF',
        'NATIVE_TIMEOUT',
        'KEY_MISMATCH',
        'INVALID_PUBLIC_KEY',
        'UNSUPPORTED_ALGORITHM',
      ].includes(code)) {
        return failClosed(
          'native_error',
          'Không thể xác minh bản quyền trên thiết bị này. Vui lòng thử lại hoặc liên hệ hỗ trợ.',
        );
      }
      if (code === 'ERROR' || code === 'UNKNOWN') {
        return failClosed(
          'network_error',
          'Không thể xác minh bản quyền. Vui lòng kiểm tra mạng và thử lại.',
        );
      }
      return failClosed(
        'token_invalid',
        'Không thể xác minh bản quyền. Vui lòng thử lại.',
      );
    }
  }),

  /**
   * Manual retry: called by user clicking "Thử lại" on lock screen.
   */
  retryValidation: async () => {
    // UIUX (audit 2026-09-05 §AUTH.RATE): tránh một cú click/automation tạo
    // challenge mới ngay sau khi server vừa trả RATE_LIMITED.
    if (Date.now() < rateLimitedRetryAfterMs) return;
    const isValid = await get().validateLicense();
    if (isValid) {
      set({ isLicenseLocked: false, lockReason: '' });
      if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
      get().startHeartbeat();
    }
  },

  /**
   * Đổi license key khi đã đăng nhập (About / settings).
   *
   * SEC (audit 2026-09-03 §SEC.19): giao dịch staged. Không xoá key/token/cache cũ
   * trước khi key mới có token ký, anchor bền vững, persistence và native registration
   * thành công. Không còn nhánh `ok: true` giả khi validate/token thất bại.
  */
  changeLicenseKey: (rawKey: string): Promise<ChangeLicenseKeyResult> => {
    return serializeLicenseOperation(async () => {
    // Chỉ cấp generation khi transaction thực sự tới lượt chạy. Lời gọi đổi key
    // tiếp theo đã bị hàng đợi serialize và `licenseMutationPending` chặn API signer;
    // không được làm transaction đang commit trở thành stale giữa một IPC native.
    const { changeEpoch, operationEpoch } = bumpLicenseChangeEpoch();
    // Sign-out đặt barrier ngay khi user yêu cầu dù cleanup nằm sau transaction
    // trong queue. Cả epoch chung lẫn epoch đổi-key phải còn nguyên; nếu native
    // vừa commit xong mà một mutation mới đã thắng, callback cũ không được dựng
    // lại UI. Nhánh stale sau native không rollback/clear mù vì sẽ phá operation mới.
    const isStaleOperation = () => changeEpoch !== licenseChangeEpoch
      || operationEpoch !== getLicenseOperationEpoch()
      || get().licenseSignOutPending;
    const isTransactionCurrent = () => !isStaleOperation();
    const newKey = normalizeLicenseKey(rawKey);
    if (!newKey) {
      return { ok: false, reason: 'empty', message: 'Vui lòng nhập license key.' };
    }
    const previousKey = get().licenseKey;
    const current = normalizeLicenseKey(previousKey || '');
    if (current && current === newKey) {
      return { ok: false, reason: 'same', message: 'Đây đã là key đang dùng trên máy này.' };
    }

    // Chụp token cũ trước mọi thao tác persistence để rollback được nếu bước sau lỗi.
    const previousStateToken = get().licenseToken;
    const previousToken = get().licenseToken || await loadTokenFromDPAPI();
    // Nếu một caller khác đã thay state trong lúc Edge/DPAPI đang chờ, giao dịch
    // này không còn sở hữu snapshot cũ. Khi đó rollback của nó phải bỏ qua để
    // không ghi đè credential mới đã được xếp trong persistence queue.
    const ownsInitialSnapshot = () => {
      const state = get();
      return state.licenseKey === previousKey && state.licenseToken === previousStateToken;
    };
    const rollbackCredentials = async () => {
      if (!ownsInitialSnapshot() && !get().licenseSignOutPending) return true;
      return restoreCredentialSnapshot(previousKey, previousToken);
    };
    if (isStaleOperation()) {
      return { ok: false, reason: 'unknown', message: 'Thao tác license đã bị thay thế. Vui lòng thử lại.' };
    }

    try {
      let response: LicenseProtocolV3Result;
      try {
        response = await runLicenseProtocolV3({
          licenseKey: newKey,
          // Thay binding hiện hữu chỉ được consume receipt recovery. Một receipt
          // enroll bình thường không có authority thay khóa đang hoạt động.
          action: 'recover',
          appVersion: APP_VERSION,
          invokeNative: invokeNativeLicenseV3,
          invokeEdge: invokeLicenseEdgeV3,
        });
      } catch (error) {
        const code = licenseProtocolV3ErrorCode(error);
        const networkFailure = code === 'NETWORK_ERROR' || code === 'RATE_LIMITED';
        return {
          ok: false,
          reason: networkFailure ? 'network' : (isTerminalServerStatus(code) ? 'invalid' : 'token'),
          message: networkFailure
            ? 'Không kết nối được máy chủ bản quyền.'
            : 'Không thể xác minh key bản quyền mới. Key hiện tại vẫn được giữ.',
        };
      }

      if (isStaleOperation()) {
        return { ok: false, reason: 'unknown', message: 'Thao tác license đã bị thay thế. Vui lòng thử lại.' };
      }

      const freshToken = response.token;
      const freshClaims = readValidatedV3ResponseClaims(response);
      if (!freshClaims) {
        return {
          ok: false,
          reason: 'token',
          message: 'Phản hồi xác minh key mới không hợp lệ. Key hiện tại vẫn được giữ.',
        };
      }
      // Ghi bền vững key/token mới trong khi binding native cũ vẫn còn nguyên.
      // API signer đã bị `licenseMutationPending` chặn nên không có cửa sổ state cũ
      // đọc credential mới. Nếu persistence lỗi, rollback chỉ đụng hai slot DPAPI.
      const keySaved = await persistLicenseKeySecure(newKey, isTransactionCurrent);
      if (!keySaved) {
        await rollbackCredentials();
        return {
          ok: false,
          reason: 'token',
          message: 'Không lưu được key mới an toàn. Key hiện tại vẫn được giữ.',
        };
      }
      if (isStaleOperation()) {
        await rollbackCredentials();
        return { ok: false, reason: 'unknown', message: 'Thao tác license đã bị thay thế. Vui lòng thử lại.' };
      }
      const tokenSaved = await queueSaveLicenseToken(freshToken, isTransactionCurrent);
      if (!tokenSaved) {
        await rollbackCredentials();
        return {
          ok: false,
          reason: 'token',
          message: 'Không lưu được thông tin bản quyền mới an toàn. Key hiện tại vẫn được giữ.',
        };
      }
      if (isStaleOperation()) {
        await rollbackCredentials();
        return { ok: false, reason: 'unknown', message: 'Thao tác license đã bị thay thế. Vui lòng thử lại.' };
      }

      // Linearization point: native tự verify token/device key và consume biên nhận
      // challenge v3 trước khi thay binding cũ trong một mutex commit.
      try {
        await ensureKeyRegisteredInRust(
          newKey,
          freshToken,
          freshClaims.challengeId,
          current || null,
        );
      } catch {
        const restored = await rollbackCredentials();
        if (!restored && isNativeRuntime()) {
          set({
            licenseValid: false,
            isLicenseLocked: true,
            lockReason: 'Không khôi phục được thông tin bản quyền cũ. Vui lòng kết nối mạng để xác minh lại.',
            licenseValidationOutcome: 'persistence_error',
          });
        }
        return {
          ok: false,
          reason: 'token',
          message: 'Không thể áp dụng key bản quyền mới. Key hiện tại vẫn được giữ.',
        };
      }
      if (isStaleOperation()) {
        return {
          ok: false,
          reason: 'unknown',
          message: 'Thao tác license đã bị thay thế. Vui lòng thử lại.',
        };
      }

      // Commit frontend state chỉ sau khi mọi proof/persistence thành công.
      if (previousKey && previousKey !== newKey) clearPendingSecurityEvents();
      set({
        licenseKey: newKey,
        licenseToken: freshToken,
        licensePlan: normalizePlan(freshClaims.plan || 'free'),
        licenseFeatures: freshClaims.features ?? null,
        dielineKeyStatus: normalizeDielineKeyStatus(response.rk_status),
        remainingDays: response.remaining_days ?? null,
        licenseExpiresAt: response.expires_at || null,
        licenseValid: true,
        lastValidated: Date.now(),
        isLicenseLocked: false,
        lockReason: '',
        licenseValidationOutcome: 'valid_online',
        isRevoking: false,
        revokeDeadline: null,
        revokeReason: '',
      });
      if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
      get().cancelRevocation();
      get().startHeartbeat();

      // Nhả seat cũ chỉ sau khi credential mới đã commit. Token v3 không được gửi
      // vào endpoint legacy: nó phải chứng minh lại quyền giữ private key CNG bằng
      // challenge/proof action=release. Lỗi vẫn non-fatal để không rollback key mới.
      const releaseToken = previousToken || '';
      if (current && releaseToken) {
        try {
          const previousClaims = readLicenseTokenClaims(releaseToken);
          if (previousClaims?.version === LICENSE_PROTOCOL_V3) {
            await runLicenseReleaseProtocolV3({
              licenseKey: current,
              appVersion: APP_VERSION,
              invokeNative: invokeNativeLicenseV3,
              invokeEdge: invokeLicenseEdgeV3,
            });
          } else if (previousClaims?.version === 1 || previousClaims?.version === 2) {
            const hwid = await getAuthoritativeHardwareId();
            const { error: releaseError } = await supabase.functions.invoke('license-release', {
              body: { license_key: current, machine_id: hwid, product_id: PRODUCT_ID },
              headers: { 'X-License-Token': releaseToken },
            });
            if (releaseError) {
              console.warn('[AUTH] license-release legacy rejected (best-effort):', releaseError);
            }
          }
        } catch (releaseErr) {
          console.warn('[AUTH] license-release failed (best-effort):', releaseErr);
        }
      }

      return { ok: true };
    } catch (error: unknown) {
      void error;
      return {
        ok: false,
        reason: 'network',
        message: 'Không cập nhật được bản quyền. Key hiện tại vẫn được giữ.',
      };
    }
    });
  },

  // ── Thu hồi có ân hạn ─────────────────────────────────────────────────────
  // Server báo key bị khóa/hết hạn (INVALID/EXPIRED) → KHÔNG khóa cứng ngay mà cho
  // REVOKE_GRACE_MS để khách lưu file. Idempotent: gọi lại khi đang thu hồi không
  // reset deadline (đồng hồ đếm ngược chạy liên tục qua các nhịp heartbeat).
  beginRevocation: (reason: string) => {
    if (get().isRevoking || get().isLicenseLocked) return;
    const generation = ++revokeGeneration;
    const deadline = Date.now() + REVOKE_GRACE_MS;
    set({ isRevoking: true, revokeDeadline: deadline, revokeReason: reason, licenseValid: false });
    if (revokeTimer) clearTimeout(revokeTimer);
    revokeTimer = setTimeout(() => {
      if (generation !== revokeGeneration) return;
      void get().enforceHardLock(reason, generation);
    }, REVOKE_GRACE_MS);
  },

  // Admin mở khóa lại trong thời gian ân hạn → key VALID trở lại → huỷ đếm ngược.
  cancelRevocation: () => {
    revokeGeneration += 1;
    if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
    if (get().isRevoking) {
      set({ isRevoking: false, revokeDeadline: null, revokeReason: '' });
    }
  },

  // Hết giờ ân hạn → khóa cứng: overlay + XOÁ cache ký Rust (chặn mọi request backend
  // ngay trong phiên, không đợi TTL cache 8h) + dọn token đã lưu.
  enforceHardLock: async (
    reason: string,
    expectedRevocationGeneration?: number,
    alreadySerialized = false,
    outcome: HardLockOutcome = 'server_rejected',
  ) => {
    // Timer/UI có thể gọi đúng lúc một lượt validate/đổi key đang giữ queue.
    // Đưa hard-lock vào cuối queue trong trường hợp đó; chỉ nhánh đang nằm
    // bên trong validate (đã có barrier) mới truyền `alreadySerialized=true`,
    // tránh tự chờ chính mình.
    if (!alreadySerialized && licenseMutationPending > 0) {
      return serializeLicenseOperation(() =>
        get().enforceHardLock(reason, expectedRevocationGeneration, true, outcome),
      );
    }
    // Callback timer có thể đã được đưa vào event loop trước khi người dùng
    // bấm huỷ. Kiểm tra generation ngay tại entry để lượt cũ không bắt đầu
    // cleanup sau khi đã bị thay thế.
    if (
      expectedRevocationGeneration !== undefined
      && expectedRevocationGeneration !== revokeGeneration
    ) return;
    // Invalidate signer/API callbacks và mọi staged đổi key ngay khi bắt đầu,
    // trước cả IPC. Sign-out đang chờ sẽ thắng ở bước commit cuối và tự dọn lại.
    const lockEpoch = bumpLicenseOperationEpoch();
    licenseChangeEpoch += 1;
    const lockGeneration = ++revokeGeneration;
    if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
    if (get().licenseSignOutPending) return;
    set({ licenseSessionEpoch: lockEpoch, licenseValid: false });

    let nativeCleared = await clearValidatedKeysInRust();
    // IPC có thể rơi đúng lúc sidecar/native đổi phiên. Thử lại ngay một lần;
    // nếu cả hai lần thất bại, UI vẫn khóa nhưng trạng thái được giữ rõ ràng
    // để người dùng khởi động lại/revalidate thay vì tưởng đã dọn sạch.
    if (!nativeCleared && isNativeRuntime() && getLicenseOperationEpoch() === lockEpoch) {
      nativeCleared = await clearValidatedKeysInRust();
    }
    if (
      getLicenseOperationEpoch() !== lockEpoch
      || revokeGeneration !== lockGeneration
      || get().licenseSignOutPending
    ) return;

    // Token cleanup phải đi qua cùng queue với mọi lượt save. Guard ngăn timer
    // cũ xóa token vừa được lưu bởi key mới; sign-out pending vẫn được phép
    // dọn vì đó là barrier mạnh hơn và sẽ lặp lại cleanup ở cuối.
    await queueDeleteLicenseToken(() =>
      getLicenseOperationEpoch() === lockEpoch || get().licenseSignOutPending,
    );
    // Nếu huỷ thu hồi xảy ra đúng lúc IPC delete đang chờ, token hiện tại có
    // thể vừa được cấp lại bởi lượt validate mới. Khôi phục snapshot trong
    // memory vào DPAPI trước khi thoát, tránh timer cũ để lại trạng thái lệch.
    if (revokeGeneration !== lockGeneration) {
      const replacementToken = get().licenseToken;
      if (replacementToken && !get().licenseSignOutPending) {
        await queueSaveLicenseToken(
          replacementToken,
          () => !get().licenseSignOutPending && get().licenseToken === replacementToken,
        );
      }
      return;
    }
    if (
      getLicenseOperationEpoch() !== lockEpoch
      || revokeGeneration !== lockGeneration
      || get().licenseSignOutPending
    ) return;

    const lockMessage = nativeCleared
      ? (reason || 'Bản quyền đã bị thu hồi. Vui lòng liên hệ để được hỗ trợ.')
      : `${reason || 'Bản quyền đã bị thu hồi. Vui lòng liên hệ để được hỗ trợ.'} Chưa thể làm mới trạng thái bản quyền; hãy khởi động lại PrynX để xác minh lại.`;
    set({
      isRevoking: false,
      revokeDeadline: null,
      revokeReason: '',
      licenseValid: false,
      licenseToken: null,
      isLicenseLocked: true,
      lockReason: lockMessage,
      licenseValidationOutcome: nativeCleared ? outcome : 'native_error',
    });
  },

  startHeartbeat: () => {
    get().stopHeartbeat();
    // SEC (audit 2026-08-22 §SEC.LIC.3): khi quay lại cửa sổ sau thao tác quản trị,
    // xác minh theo cổng chung với heartbeat, tránh tạo challenge trùng trong cùng
    // một nhịp nhưng vẫn kiểm tra sớm khi đã qua khoảng tối thiểu.
    let claimScheduledValidation: (() => boolean) | null = null;
    if (typeof window !== 'undefined') {
      // WebView có thể phát nhiều focus liên tiếp khi chuyển tab/cửa sổ. Không
      // để mỗi sự kiện tạo một challenge v3; heartbeat định kỳ vẫn là đường chính.
      let lastScheduledValidationAt = get().lastValidated;
      let hasScheduledValidation = lastScheduledValidationAt > 0;
      const claimForWindow = (): boolean => {
        const now = Date.now();
        if (hasScheduledValidation
          && now - lastScheduledValidationAt < SCHEDULED_VALIDATION_MIN_INTERVAL_MS) {
          return false;
        }
        hasScheduledValidation = true;
        lastScheduledValidationAt = now;
        return true;
      };
      claimScheduledValidation = claimForWindow;
      focusValidationHandler = () => {
        if (get().isLicenseLocked || get().isChecking) return;
        if (isLicenseOperationPending() || !claimForWindow()) return;
        void get().validateLicense();
      };
      window.addEventListener('focus', focusValidationHandler);
    }
    heartbeatInterval = setInterval(async () => {
      // Đồng bộ cùng cổng focus để hai timer không xếp đôi challenge khi người
      // dùng quay lại cửa sổ đúng lúc heartbeat nổ.
      // Nếu không có window (SSR) thì heartbeat vẫn giữ nhịp, không cần debounce UI.
      if (isLicenseOperationPending()) return;
      if (claimScheduledValidation && !claimScheduledValidation()) return;
      const isValid = await get().validateLicense();
      if (!isValid && !get().isLicenseLocked) {
        // Don't sign out — just lock. validateLicense already sets isLicenseLocked.
        // Start rapid retry interval
        if (!retryInterval) {
          retryInterval = setInterval(async () => {
            await get().retryValidation();
          }, RETRY_INTERVAL_MS);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  },

  stopHeartbeat: () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
    if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
    rateLimitedRetryAfterMs = 0;
    revokeGeneration += 1;
    if (focusValidationHandler && typeof window !== 'undefined') {
      window.removeEventListener('focus', focusValidationHandler);
      focusValidationHandler = null;
    }
  },
}));
