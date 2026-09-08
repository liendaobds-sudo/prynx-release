// SEC (audit 2026-09-04 §SEC.16-A1): orchestration client cho device authority v3.
// Module không tự sinh nonce/proof và không có fallback HWID; hai authority đó lần
// lượt thuộc server và CNG trong Tauri (ưu tiên Platform KSP, fallback Software KSP).

export const LICENSE_PROTOCOL_V3 = 3 as const;
/** Lease offline cho app mới; server mặc định 900 giây nếu client cũ không gửi capability. */
export const LICENSE_TOKEN_V3_OFFLINE_LEASE_SECONDS = 72 * 60 * 60;

export type LicenseProtocolV3Action = 'enroll' | 'refresh' | 'rk_grant' | 'release' | 'recover';
export type LicenseProtocolV3EntitlementAction = Exclude<LicenseProtocolV3Action, 'release'>;

export interface RsaPublicJwkV3 {
  e: 'AQAB';
  kty: 'RSA';
  n: string;
}

export interface DevicePublicIdentityV3 {
  protocol_version: 3;
  device_key_id: string;
  proof_alg: 'PS256';
  public_key_jwk: RsaPublicJwkV3;
}

export interface NativeLicenseChallengeV3 {
  protocol_version: 3;
  environment: 'prod';
  action: LicenseProtocolV3Action;
  license_id: string;
  product_id: 'prynx';
  device_key_id: string;
  challenge_id: string;
  challenge: string;
  expires_at: number;
  request_hash: string;
}

export interface DeviceLicenseProofV3 {
  protocol_version: 3;
  device_key_id: string;
  proof_alg: 'PS256';
  proof: string;
  proof_input_hash: string;
}

export interface LicenseChallengeResponseV3 extends NativeLicenseChallengeV3 {
  status: 'CHALLENGE';
  minimum_protocol: 3;
}

export interface LicenseValidResponseV3 {
  status: 'VALID';
  protocol_version: 3;
  minimum_protocol: 3;
  device_key_id: string;
  token: string;
  plan?: string;
  features?: unknown;
  rk_status?: unknown;
  remaining_days?: number | null;
  expires_at?: string | null;
}

/**
 * Kết quả đã hoàn tất đúng một lượt challenge → prove. Trường này do orchestrator
 * chụp từ challenge vừa dùng, không tin giá trị phụ nào trong response cuối của Edge.
 */
export interface LicenseProtocolV3Result extends LicenseValidResponseV3 {
  completed_challenge_id: string;
}

export interface LicenseProtocolV3ReleaseResult {
  status: 'RELEASED';
  protocol_version: 3;
  minimum_protocol: 3;
  device_key_id: string;
  completed_challenge_id: string;
}

type LicenseReleasedResponseV3 = Omit<LicenseProtocolV3ReleaseResult, 'completed_challenge_id'>;

export type NativeInvokeV3 = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type EdgeInvokeV3 = (
  body: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

export interface RunLicenseProtocolV3Options {
  licenseKey: string;
  action: LicenseProtocolV3EntitlementAction;
  appVersion?: string;
  invokeNative: NativeInvokeV3;
  invokeEdge: EdgeInvokeV3;
  nowSeconds?: number;
  /** Hạn chờ cho từng IPC/request; chủ yếu cho test, production dùng mặc định. */
  stepTimeoutMs?: number;
  /** Capability rollout: client mới xin lease 72h, client cũ bỏ qua field này. */
  offlineLeaseSeconds?: number;
}

export type RunLicenseReleaseProtocolV3Options = Omit<
  RunLicenseProtocolV3Options,
  'action'
>;

export class LicenseProtocolV3ClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LicenseProtocolV3ClientError';
    this.code = code;
  }
}

const DEVICE_KEY_ID_RE = /^d3_[A-Za-z0-9_-]{43}$/;
const LOWER_HEX_64_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SERVER_STATUS_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const APP_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_CHALLENGE_FUTURE_SECONDS = 5 * 60;
const CHALLENGE_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_STEP_TIMEOUT_MS = 10_000;

function fail(code: string, message: string): never {
  throw new LicenseProtocolV3ClientError(code, message);
}

async function awaitProtocolStep<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: 'NETWORK_ERROR' | 'NATIVE_TIMEOUT',
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new LicenseProtocolV3ClientError(code, message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseIdentity(value: unknown): DevicePublicIdentityV3 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'protocol_version', 'device_key_id', 'proof_alg', 'public_key_jwk',
  ])) {
    fail('INVALID_IDENTITY', 'Tauri trả định danh thiết bị không hợp lệ');
  }
  const jwk = value.public_key_jwk;
  if (value.protocol_version !== 3
    || value.proof_alg !== 'PS256'
    || typeof value.device_key_id !== 'string'
    || !DEVICE_KEY_ID_RE.test(value.device_key_id)
    || !isRecord(jwk)
    || !hasExactKeys(jwk, ['e', 'kty', 'n'])
    || jwk.e !== 'AQAB'
    || jwk.kty !== 'RSA'
    || typeof jwk.n !== 'string'
    || !/^[A-Za-z0-9_-]{342}$/.test(jwk.n)) {
    fail('INVALID_IDENTITY', 'Khóa thiết bị CNG không đúng hợp đồng v3');
  }
  return value as unknown as DevicePublicIdentityV3;
}

function parseChallengeResponse(
  value: unknown,
  identity: DevicePublicIdentityV3,
  action: LicenseProtocolV3Action,
  nowSeconds: number,
): LicenseChallengeResponseV3 {
  // SEC (audit 2026-09-04 §SEC.16-A1): Edge có thể từ chối ngay ở bước cấp
  // challenge (license hết hạn, vượt số máy...). Giữ nguyên mã đóng để store xử
  // lý thu hồi; tuyệt đối không thử lại bằng giao thức cũ.
  if (isRecord(value) && value.status !== 'CHALLENGE') {
    const status = typeof value.status === 'string' && SERVER_STATUS_RE.test(value.status)
      ? value.status
      : 'INVALID_CHALLENGE';
    fail(status, typeof value.message === 'string'
      ? value.message
      : 'Máy chủ từ chối cấp challenge thiết bị');
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    'status', 'protocol_version', 'minimum_protocol', 'environment', 'action',
    'license_id', 'product_id', 'device_key_id', 'challenge_id', 'challenge',
    'expires_at', 'request_hash',
  ])) {
    fail('INVALID_CHALLENGE', 'Máy chủ trả challenge không đúng hợp đồng v3');
  }
  if (value.status !== 'CHALLENGE'
    || value.protocol_version !== 3
    || value.minimum_protocol !== 3
    || value.environment !== 'prod'
    || value.action !== action
    || value.product_id !== 'prynx'
    || value.device_key_id !== identity.device_key_id
    || typeof value.license_id !== 'string'
    || !UUID_RE.test(value.license_id)
    || typeof value.challenge_id !== 'string'
    || !UUID_RE.test(value.challenge_id)
    || typeof value.challenge !== 'string'
    || !LOWER_HEX_64_RE.test(value.challenge)
    || typeof value.request_hash !== 'string'
    || !LOWER_HEX_64_RE.test(value.request_hash)
    || typeof value.expires_at !== 'number'
    || !Number.isSafeInteger(value.expires_at)
    || value.expires_at + CHALLENGE_CLOCK_SKEW_SECONDS < nowSeconds
    || value.expires_at > nowSeconds + MAX_CHALLENGE_FUTURE_SECONDS) {
    fail('INVALID_CHALLENGE', 'Challenge license hết hạn hoặc sai phạm vi');
  }
  return value as unknown as LicenseChallengeResponseV3;
}

function projectNativeChallenge(value: LicenseChallengeResponseV3): NativeLicenseChallengeV3 {
  return {
    protocol_version: value.protocol_version,
    environment: value.environment,
    action: value.action,
    license_id: value.license_id,
    product_id: value.product_id,
    device_key_id: value.device_key_id,
    challenge_id: value.challenge_id,
    challenge: value.challenge,
    expires_at: value.expires_at,
    request_hash: value.request_hash,
  };
}

function parseProof(value: unknown, deviceKeyId: string): DeviceLicenseProofV3 {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'protocol_version', 'device_key_id', 'proof_alg', 'proof', 'proof_input_hash',
    ])
    || value.protocol_version !== 3
    || value.device_key_id !== deviceKeyId
    || value.proof_alg !== 'PS256'
    || typeof value.proof !== 'string'
    || !/^[A-Za-z0-9_-]{342}$/.test(value.proof)
    || typeof value.proof_input_hash !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.proof_input_hash)) {
    fail('INVALID_PROOF', 'Tauri trả proof thiết bị không hợp lệ');
  }
  return value as unknown as DeviceLicenseProofV3;
}

function parseValidResponse(value: unknown, deviceKeyId: string): LicenseValidResponseV3 {
  if (!isRecord(value)) fail('INVALID_RESPONSE', 'Máy chủ không trả kết quả license');
  if (value.status !== 'VALID') {
    const status = typeof value.status === 'string' && SERVER_STATUS_RE.test(value.status)
      ? value.status
      : 'INVALID_RESPONSE';
    fail(status, typeof value.message === 'string' ? value.message : 'Máy chủ từ chối proof thiết bị');
  }
  if (value.protocol_version !== 3
    || value.minimum_protocol !== 3
    || value.device_key_id !== deviceKeyId
    || typeof value.token !== 'string'
    || value.token.length < 3
    || value.token.length > 16 * 1024) {
    fail('INVALID_RESPONSE', 'Kết quả license không khớp thiết bị v3');
  }
  return value as unknown as LicenseValidResponseV3;
}

function parseReleasedResponse(value: unknown, deviceKeyId: string): LicenseReleasedResponseV3 {
  if (!isRecord(value)) fail('INVALID_RESPONSE', 'Máy chủ không trả kết quả nhả thiết bị');
  if (value.status !== 'RELEASED') {
    const status = typeof value.status === 'string' && SERVER_STATUS_RE.test(value.status)
      ? value.status
      : 'INVALID_RESPONSE';
    fail(status, typeof value.message === 'string' ? value.message : 'Máy chủ từ chối nhả thiết bị');
  }
  if (!hasExactKeys(value, [
    'status', 'protocol_version', 'minimum_protocol', 'device_key_id',
  ])
    || value.protocol_version !== LICENSE_PROTOCOL_V3
    || value.minimum_protocol !== LICENSE_PROTOCOL_V3
    || value.device_key_id !== deviceKeyId) {
    fail('INVALID_RESPONSE', 'Kết quả nhả thiết bị không khớp proof v3');
  }
  return value as unknown as LicenseReleasedResponseV3;
}

interface LicenseProtocolV3Exchange {
  challengeId: string;
  deviceKeyId: string;
  response: unknown;
}

async function runLicenseProtocolV3Exchange(
  options: RunLicenseProtocolV3Options | (RunLicenseReleaseProtocolV3Options & { action: 'release' }),
): Promise<LicenseProtocolV3Exchange> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    fail('INVALID_CLOCK', 'Đồng hồ hệ thống không hợp lệ');
  }
  const licenseKey = options.licenseKey.trim().toUpperCase();
  if (!licenseKey || licenseKey.length > 256) fail('INVALID_INPUT', 'License key không hợp lệ');
  if (options.appVersion !== undefined && !APP_VERSION_RE.test(options.appVersion)) {
    fail('INVALID_INPUT', 'Phiên bản ứng dụng không hợp lệ');
  }
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  if (!Number.isSafeInteger(stepTimeoutMs) || stepTimeoutMs <= 0 || stepTimeoutMs > 60_000) {
    fail('INVALID_INPUT', 'Hạn chờ xác minh license không hợp lệ');
  }
  const offlineLeaseSeconds = options.offlineLeaseSeconds
    ?? LICENSE_TOKEN_V3_OFFLINE_LEASE_SECONDS;
  if (!Number.isSafeInteger(offlineLeaseSeconds)
    || ![15 * 60, LICENSE_TOKEN_V3_OFFLINE_LEASE_SECONDS].includes(offlineLeaseSeconds)) {
    fail('INVALID_INPUT', 'Lease offline license không hợp lệ');
  }

  const identity = parseIdentity(
    await awaitProtocolStep(
      options.invokeNative<unknown>('get_device_public_identity'),
      stepTimeoutMs,
      'NATIVE_TIMEOUT',
      'Native không trả định danh thiết bị đúng hạn',
    ),
  );
  const challengeCall = await awaitProtocolStep(
    options.invokeEdge({
      step: 'challenge',
      protocol_version: 3,
      license_key: licenseKey,
      product_id: 'prynx',
      action: options.action,
      device_identity: identity,
      offline_lease_seconds: offlineLeaseSeconds,
      ...(options.appVersion ? { app_version: options.appVersion } : {}),
    }),
    stepTimeoutMs,
    'NETWORK_ERROR',
    'Máy chủ không trả challenge license đúng hạn',
  );
  if (challengeCall.error) {
    fail('NETWORK_ERROR', challengeCall.error.message || 'Không lấy được challenge license');
  }
  const challengeResponse = parseChallengeResponse(
    challengeCall.data,
    identity,
    options.action,
    nowSeconds,
  );
  const nativeChallenge = projectNativeChallenge(challengeResponse);
  const proof = parseProof(
    await awaitProtocolStep(
      options.invokeNative<unknown>('sign_device_license_challenge', {
        challenge: nativeChallenge,
      }),
      stepTimeoutMs,
      'NATIVE_TIMEOUT',
      'Native không ký proof thiết bị đúng hạn',
    ),
    identity.device_key_id,
  );

  const proveCall = await awaitProtocolStep(
    options.invokeEdge({
      step: 'prove',
      protocol_version: 3,
      challenge_id: challengeResponse.challenge_id,
      challenge: challengeResponse.challenge,
      proof,
      offline_lease_seconds: offlineLeaseSeconds,
      ...(options.appVersion ? { app_version: options.appVersion } : {}),
    }),
    stepTimeoutMs,
    'NETWORK_ERROR',
    'Máy chủ không trả kết quả proof đúng hạn',
  );
  if (proveCall.error) {
    fail('NETWORK_ERROR', proveCall.error.message || 'Không gửi được proof thiết bị');
  }
  return {
    challengeId: challengeResponse.challenge_id,
    deviceKeyId: identity.device_key_id,
    response: proveCall.data,
  };
}

/** Chạy đúng hai bước challenge → prove; mọi lỗi đều dừng, không hạ cấp về v2/HWID. */
export async function runLicenseProtocolV3(
  options: RunLicenseProtocolV3Options,
): Promise<LicenseProtocolV3Result> {
  const exchange = await runLicenseProtocolV3Exchange(options);
  const response = parseValidResponse(exchange.response, exchange.deviceKeyId);
  return {
    ...response,
    // Ghi đè cả khi Edge chèn field cùng tên: authority là challenge đã parse ở
    // chính lượt này. Store sẽ buộc token `cid` ký phải khớp field này.
    completed_challenge_id: exchange.challengeId,
  };
}

/** Nhả đúng seat của khóa CNG hiện tại; không nhận token mới và không dùng HWID legacy. */
export async function runLicenseReleaseProtocolV3(
  options: RunLicenseReleaseProtocolV3Options,
): Promise<LicenseProtocolV3ReleaseResult> {
  const exchange = await runLicenseProtocolV3Exchange({ ...options, action: 'release' });
  return {
    ...parseReleasedResponse(exchange.response, exchange.deviceKeyId),
    completed_challenge_id: exchange.challengeId,
  };
}
