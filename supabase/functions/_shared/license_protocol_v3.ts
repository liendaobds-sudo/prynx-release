// SEC (audit 2026-09-04 §SEC.16-A1): primitive thuần dùng chung cho Edge.
// Module này không đọc secret, không gọi database và không cung cấp thao tác ký.

export const LICENSE_PROTOCOL_V3 = 3 as const;
export const LICENSE_PROTOCOL_V3_ENVIRONMENT = "prod" as const;
export const LICENSE_PROTOCOL_V3_PRODUCT = "prynx" as const;
export const LICENSE_PROTOCOL_V3_PROOF_ALGORITHM = "PS256" as const;

const PROOF_DOMAIN = "PRYNX-LICENSE-PROOF-V3";
const REQUEST_INTENT_DOMAIN = "PRYNX-LICENSE-REQUEST-V3";
const DEVICE_KEY_ID_PREFIX = "d3_";
const CHALLENGE_CLOCK_SKEW_SECONDS = 30;
const MAX_CHALLENGE_FUTURE_SECONDS = 5 * 60;
// App mới xin lease offline 72h; server vẫn nhận client cũ không gửi capability
// và cấp 900s ở biên request để rollout không làm bản cũ từ chối token.
export const LICENSE_TOKEN_V3_MAX_TTL_SECONDS = 72 * 60 * 60;
export const LICENSE_TOKEN_V3_LEGACY_TTL_SECONDS = 15 * 60;
export const LICENSE_TOKEN_V3_DEFAULT_LEASE_SECONDS = LICENSE_TOKEN_V3_LEGACY_TTL_SECONDS;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOWER_HEX_RE = /^[0-9a-f]+$/;
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export enum LicenseProtocolV3Action {
  Enroll = "enroll",
  Refresh = "refresh",
  ResourceKeyGrant = "rk_grant",
  Release = "release",
  Recover = "recover",
}

/**
 * Mã lỗi đóng: endpoint chỉ được ánh xạ các giá trị này ra response/log.
 * Không phản chiếu giá trị input hoặc exception WebCrypto cho client.
 */
export enum LicenseProtocolV3ErrorCode {
  InvalidInput = "INVALID_INPUT",
  UnsupportedProtocol = "UNSUPPORTED_PROTOCOL",
  UnsupportedAlgorithm = "UNSUPPORTED_ALGORITHM",
  InvalidScope = "INVALID_SCOPE",
  InvalidAction = "INVALID_ACTION",
  InvalidIdentifier = "INVALID_IDENTIFIER",
  InvalidPublicKey = "INVALID_PUBLIC_KEY",
  KeyMismatch = "KEY_MISMATCH",
  InvalidChallenge = "INVALID_CHALLENGE",
  ChallengeExpired = "CHALLENGE_EXPIRED",
  InvalidProof = "INVALID_PROOF",
  InvalidToken = "INVALID_TOKEN",
  TokenExpired = "TOKEN_EXPIRED",
  CryptoFailure = "CRYPTO_FAILURE",
}

const ERROR_MESSAGES: Readonly<Record<LicenseProtocolV3ErrorCode, string>> = {
  [LicenseProtocolV3ErrorCode.InvalidInput]: "Dữ liệu giao thức license không hợp lệ",
  [LicenseProtocolV3ErrorCode.UnsupportedProtocol]: "Phiên bản giao thức license không được hỗ trợ",
  [LicenseProtocolV3ErrorCode.UnsupportedAlgorithm]: "Thuật toán proof không được hỗ trợ",
  [LicenseProtocolV3ErrorCode.InvalidScope]: "Phạm vi challenge license không hợp lệ",
  [LicenseProtocolV3ErrorCode.InvalidAction]: "Hành động challenge license không hợp lệ",
  [LicenseProtocolV3ErrorCode.InvalidIdentifier]: "Định danh giao thức license không hợp lệ",
  [LicenseProtocolV3ErrorCode.InvalidPublicKey]: "Public key thiết bị không hợp lệ",
  [LicenseProtocolV3ErrorCode.KeyMismatch]: "Public key không khớp định danh thiết bị",
  [LicenseProtocolV3ErrorCode.InvalidChallenge]: "Challenge license không hợp lệ",
  [LicenseProtocolV3ErrorCode.ChallengeExpired]: "Challenge license đã hết hạn",
  [LicenseProtocolV3ErrorCode.InvalidProof]: "Proof thiết bị không hợp lệ",
  [LicenseProtocolV3ErrorCode.InvalidToken]: "Token license không hợp lệ",
  [LicenseProtocolV3ErrorCode.TokenExpired]: "Token license đã hết hạn",
  [LicenseProtocolV3ErrorCode.CryptoFailure]: "Không thể kiểm chứng proof thiết bị",
};

export class LicenseProtocolV3Error extends Error {
  readonly code: LicenseProtocolV3ErrorCode;

  constructor(code: LicenseProtocolV3ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "LicenseProtocolV3Error";
    this.code = code;
  }
}

export interface RsaPublicJwkV3 {
  e: "AQAB";
  kty: "RSA";
  n: string;
}

export interface DevicePublicIdentityV3 {
  protocol_version: typeof LICENSE_PROTOCOL_V3;
  device_key_id: string;
  proof_alg: typeof LICENSE_PROTOCOL_V3_PROOF_ALGORITHM;
  public_key_jwk: RsaPublicJwkV3;
}

export interface ServerLicenseChallengeV3 {
  protocol_version: typeof LICENSE_PROTOCOL_V3;
  environment: typeof LICENSE_PROTOCOL_V3_ENVIRONMENT;
  action: LicenseProtocolV3Action;
  license_id: string;
  product_id: typeof LICENSE_PROTOCOL_V3_PRODUCT;
  device_key_id: string;
  challenge_id: string;
  challenge: string;
  expires_at: number;
  request_hash: string;
}

export interface DeviceLicenseProofV3 {
  protocol_version: typeof LICENSE_PROTOCOL_V3;
  device_key_id: string;
  proof_alg: typeof LICENSE_PROTOCOL_V3_PROOF_ALGORITHM;
  proof: string;
  proof_input_hash: string;
}

export interface LicenseRequestIntentV3 {
  action: LicenseProtocolV3Action;
  app_version: string | null;
  legacy_machine_id: string | null;
  offline_lease_seconds?: number;
}

export interface PrynXLegacyIssuePolicyInputV3 {
  protocolVersion: number;
  minimumIssueProtocol: number;
  legacyIssueUntilSeconds: number;
  nowSeconds: number;
  v1RolloutOpen: boolean;
}

export interface LicenseTokenConfirmationV3 {
  jkt: string;
}

/**
 * Contract token v3. `m` được giữ để bốn verifier cũ nâng cấp tuần tự, nhưng
 * bắt buộc bằng `d`; authority thật là cặp `d` + `cnf.jkt`.
 */
export interface LicenseTokenClaimsV3 {
  k: string;
  m: string;
  p: typeof LICENSE_PROTOCOL_V3_PRODUCT;
  plan: string;
  features?: string[];
  rk?: string;
  exp: number;
  v: typeof LICENSE_PROTOCOL_V3;
  iat: number;
  d: string;
  cnf: LicenseTokenConfirmationV3;
  min_v: typeof LICENSE_PROTOCOL_V3;
  cid: string;
}

export type DeviceProofVerificationV3 =
  | {
    ok: true;
    deviceKeyId: string;
    proofInputHash: string;
    proofSha256: string;
  }
  | {
    ok: false;
    error: LicenseProtocolV3ErrorCode;
  };

/**
 * Quyết định floor cho đường cấp token legacy trong lúc chuyển sang device authority v3.
 * V1 chỉ là cửa sổ con của giai đoạn drain v2: biến môi trường không được hạ floor=3
 * hoặc kéo dài quá cutoff một chiều `legacy_issue_until` trong database.
 *
 * `null` nghĩa là request được đi tiếp; `2`/`3` là protocol tối thiểu phải trả về.
 * Input sai luôn fail-closed về v3, kể cả khi caller TypeScript bị bypass ở runtime.
 */
export function requiredPrynXLegacyIssueProtocolV3(
  input: PrynXLegacyIssuePolicyInputV3,
): 2 | 3 | null {
  if (
    (input.protocolVersion !== 1 && input.protocolVersion !== 2) ||
    (input.minimumIssueProtocol !== 2 && input.minimumIssueProtocol !== 3) ||
    !Number.isSafeInteger(input.legacyIssueUntilSeconds) ||
    input.legacyIssueUntilSeconds <= 0 ||
    !Number.isSafeInteger(input.nowSeconds) ||
    input.nowSeconds <= 0 ||
    typeof input.v1RolloutOpen !== "boolean"
  ) {
    return LICENSE_PROTOCOL_V3;
  }

  // Floor=3 và cutoff database là chốt một chiều; env rollout không thể mở lại.
  if (
    input.minimumIssueProtocol === LICENSE_PROTOCOL_V3 ||
    input.nowSeconds >= input.legacyIssueUntilSeconds
  ) {
    return LICENSE_PROTOCOL_V3;
  }

  if (input.protocolVersion === 1 && !input.v1RolloutOpen) return 2;
  return null;
}

function fail(code: LicenseProtocolV3ErrorCode): never {
  throw new LicenseProtocolV3Error(code);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code = LicenseProtocolV3ErrorCode.InvalidInput,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    fail(code);
  }
  return record;
}

function recordWithOptionalKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: LicenseProtocolV3ErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    fail(code);
  }
  return record;
}

function isLowerHex(value: unknown, expectedLength: number): value is string {
  return typeof value === "string" &&
    value.length === expectedLength &&
    LOWER_HEX_RE.test(value);
}

function parseAction(value: unknown): LicenseProtocolV3Action {
  if (!Object.values(LicenseProtocolV3Action).includes(value as LicenseProtocolV3Action)) {
    fail(LicenseProtocolV3ErrorCode.InvalidAction);
  }
  return value as LicenseProtocolV3Action;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const block = (bytes[index] << 16) |
      ((remaining > 1 ? bytes[index + 1] : 0) << 8) |
      (remaining > 2 ? bytes[index + 2] : 0);
    encoded += BASE64URL_ALPHABET[(block >>> 18) & 63];
    encoded += BASE64URL_ALPHABET[(block >>> 12) & 63];
    if (remaining > 1) encoded += BASE64URL_ALPHABET[(block >>> 6) & 63];
    if (remaining > 2) encoded += BASE64URL_ALPHABET[block & 63];
  }
  return encoded;
}

function decodeCanonicalBase64Url(
  value: unknown,
  expectedBytes: number,
  code: LicenseProtocolV3ErrorCode,
): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.includes("=")) fail(code);

  const bytes: number[] = [];
  let accumulator = 0;
  let bitCount = 0;
  for (const char of value) {
    const sextet = BASE64URL_ALPHABET.indexOf(char);
    if (sextet < 0) fail(code);
    accumulator = (accumulator << 6) | sextet;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >>> bitCount) & 0xff);
      accumulator &= (1 << bitCount) - 1;
    }
  }

  // Bit đuôi khác 0 tạo alias encoding cho cùng một chuỗi byte.
  if (bitCount > 0 && accumulator !== 0) fail(code);
  const decoded = Uint8Array.from(bytes);
  if (decoded.length !== expectedBytes || encodeBase64Url(decoded) !== value) fail(code);
  return decoded;
}

function parseDeviceKeyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(DEVICE_KEY_ID_PREFIX) ||
    value.length !== DEVICE_KEY_ID_PREFIX.length + 43
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidIdentifier);
  }
  decodeCanonicalBase64Url(
    value.slice(DEVICE_KEY_ID_PREFIX.length),
    32,
    LicenseProtocolV3ErrorCode.InvalidIdentifier,
  );
  return value;
}

export function parseRsaPublicJwkV3(value: unknown): RsaPublicJwkV3 {
  const record = exactRecord(
    value,
    ["e", "kty", "n"],
    LicenseProtocolV3ErrorCode.InvalidPublicKey,
  );
  if (record.e !== "AQAB" || record.kty !== "RSA") {
    fail(LicenseProtocolV3ErrorCode.InvalidPublicKey);
  }
  const modulus = decodeCanonicalBase64Url(
    record.n,
    256,
    LicenseProtocolV3ErrorCode.InvalidPublicKey,
  );
  // RSA-2048 phải có bit cao nhất và modulus phải là số lẻ.
  if ((modulus[0] & 0x80) === 0 || (modulus[modulus.length - 1] & 1) === 0) {
    fail(LicenseProtocolV3ErrorCode.InvalidPublicKey);
  }
  return { e: "AQAB", kty: "RSA", n: record.n as string };
}

export function parseDevicePublicIdentityV3(value: unknown): DevicePublicIdentityV3 {
  const record = exactRecord(value, [
    "protocol_version",
    "device_key_id",
    "proof_alg",
    "public_key_jwk",
  ]);
  if (record.protocol_version !== LICENSE_PROTOCOL_V3) {
    fail(LicenseProtocolV3ErrorCode.UnsupportedProtocol);
  }
  if (record.proof_alg !== LICENSE_PROTOCOL_V3_PROOF_ALGORITHM) {
    fail(LicenseProtocolV3ErrorCode.UnsupportedAlgorithm);
  }
  return {
    protocol_version: LICENSE_PROTOCOL_V3,
    device_key_id: parseDeviceKeyId(record.device_key_id),
    proof_alg: LICENSE_PROTOCOL_V3_PROOF_ALGORITHM,
    public_key_jwk: parseRsaPublicJwkV3(record.public_key_jwk),
  };
}

export function parseServerLicenseChallengeV3(value: unknown): ServerLicenseChallengeV3 {
  const record = exactRecord(value, [
    "protocol_version",
    "environment",
    "action",
    "license_id",
    "product_id",
    "device_key_id",
    "challenge_id",
    "challenge",
    "expires_at",
    "request_hash",
  ]);
  if (record.protocol_version !== LICENSE_PROTOCOL_V3) {
    fail(LicenseProtocolV3ErrorCode.UnsupportedProtocol);
  }
  if (
    record.environment !== LICENSE_PROTOCOL_V3_ENVIRONMENT ||
    record.product_id !== LICENSE_PROTOCOL_V3_PRODUCT
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidScope);
  }
  const action = parseAction(record.action);
  if (
    typeof record.license_id !== "string" ||
    typeof record.challenge_id !== "string" ||
    !CANONICAL_UUID_RE.test(record.license_id) ||
    !CANONICAL_UUID_RE.test(record.challenge_id)
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidIdentifier);
  }
  if (
    !isLowerHex(record.challenge, 64) ||
    !isLowerHex(record.request_hash, 64) ||
    typeof record.expires_at !== "number" ||
    !Number.isSafeInteger(record.expires_at) ||
    record.expires_at <= 0
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidChallenge);
  }
  return {
    protocol_version: LICENSE_PROTOCOL_V3,
    environment: LICENSE_PROTOCOL_V3_ENVIRONMENT,
    action,
    license_id: record.license_id,
    product_id: LICENSE_PROTOCOL_V3_PRODUCT,
    device_key_id: parseDeviceKeyId(record.device_key_id),
    challenge_id: record.challenge_id,
    challenge: record.challenge,
    expires_at: record.expires_at,
    request_hash: record.request_hash,
  };
}

export function parseDeviceLicenseProofV3(value: unknown): DeviceLicenseProofV3 {
  const record = exactRecord(value, [
    "protocol_version",
    "device_key_id",
    "proof_alg",
    "proof",
    "proof_input_hash",
  ]);
  if (record.protocol_version !== LICENSE_PROTOCOL_V3) {
    fail(LicenseProtocolV3ErrorCode.UnsupportedProtocol);
  }
  if (record.proof_alg !== LICENSE_PROTOCOL_V3_PROOF_ALGORITHM) {
    fail(LicenseProtocolV3ErrorCode.UnsupportedAlgorithm);
  }
  decodeCanonicalBase64Url(record.proof, 256, LicenseProtocolV3ErrorCode.InvalidProof);
  decodeCanonicalBase64Url(record.proof_input_hash, 32, LicenseProtocolV3ErrorCode.InvalidProof);
  return {
    protocol_version: LICENSE_PROTOCOL_V3,
    device_key_id: parseDeviceKeyId(record.device_key_id),
    proof_alg: LICENSE_PROTOCOL_V3_PROOF_ALGORITHM,
    proof: record.proof as string,
    proof_input_hash: record.proof_input_hash as string,
  };
}

function canonicalTranscript(challenge: ServerLicenseChallengeV3): string {
  return `${PROOF_DOMAIN}\n` +
    `protocol=${challenge.protocol_version}\n` +
    `environment=${challenge.environment}\n` +
    `action=${challenge.action}\n` +
    `license_id=${challenge.license_id}\n` +
    `product=${challenge.product_id}\n` +
    `device_key_id=${challenge.device_key_id}\n` +
    `challenge_id=${challenge.challenge_id}\n` +
    `challenge=${challenge.challenge}\n` +
    `expires_at=${challenge.expires_at}\n` +
    `request_hash=${challenge.request_hash}\n`;
}

/** Canonical transcript byte-for-byte giống `device_identity.rs`, gồm LF cuối. */
export function canonicalProofTranscriptV3(value: unknown): string {
  return canonicalTranscript(parseServerLicenseChallengeV3(value));
}

/** RFC 7638: member theo thứ tự từ điển, UTF-8 và không whitespace. */
export function canonicalJwkThumbprintInputV3(value: unknown): string {
  const jwk = parseRsaPublicJwkV3(value);
  return `{"e":"${jwk.e}","kty":"${jwk.kty}","n":"${jwk.n}"}`;
}

function requireSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail(LicenseProtocolV3ErrorCode.CryptoFailure);
  return subtle;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const digest = await requireSubtleCrypto().digest("SHA-256", bytes);
    return new Uint8Array(digest);
  } catch (error) {
    if (error instanceof LicenseProtocolV3Error) throw error;
    fail(LicenseProtocolV3ErrorCode.CryptoFailure);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export async function deriveDeviceKeyIdV3(value: unknown): Promise<string> {
  const canonical = canonicalJwkThumbprintInputV3(value);
  const digest = await sha256(new TextEncoder().encode(canonical));
  return DEVICE_KEY_ID_PREFIX + encodeBase64Url(digest);
}

export function canonicalLicenseRequestIntentV3(value: unknown): string {
  const record = recordWithOptionalKeys(
    value,
    ["action", "app_version", "legacy_machine_id"],
    ["offline_lease_seconds"],
    LicenseProtocolV3ErrorCode.InvalidInput,
  );
  const action = parseAction(record.action);
  // Không đổi transcript của request cũ đang nằm trong cửa sổ challenge khi
  // deploy Edge. Client cũ không có field capability nên giữ canonical legacy;
  // client mới gửi field và được bind lease 72h vào challenge/proof.
  const hasOfflineLease = Object.prototype.hasOwnProperty.call(
    record,
    "offline_lease_seconds",
  );
  const offlineLeaseSeconds = record.offline_lease_seconds
    ?? LICENSE_TOKEN_V3_DEFAULT_LEASE_SECONDS;
  if (
    record.app_version !== null &&
    (typeof record.app_version !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(record.app_version))
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidInput);
  }
  if (
    !Number.isSafeInteger(offlineLeaseSeconds) ||
    ![LICENSE_TOKEN_V3_LEGACY_TTL_SECONDS, LICENSE_TOKEN_V3_MAX_TTL_SECONDS]
      .includes(offlineLeaseSeconds as number)
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidInput);
  }
  if (
    record.legacy_machine_id !== null &&
    (typeof record.legacy_machine_id !== "string" ||
      !/^[0-9A-F]{16}$/.test(record.legacy_machine_id))
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidInput);
  }
  return `${REQUEST_INTENT_DOMAIN}\n` +
    `action=${action}\n` +
    `app_version=${record.app_version ?? "-"}\n` +
    `legacy_machine_id=${record.legacy_machine_id ?? "-"}\n` +
    (hasOfflineLease ? `offline_lease_seconds=${offlineLeaseSeconds}\n` : "");
}

export async function deriveLicenseRequestHashV3(value: unknown): Promise<string> {
  const canonical = canonicalLicenseRequestIntentV3(value);
  return bytesToHex(await sha256(new TextEncoder().encode(canonical)));
}

export function validateChallengeFreshnessV3(
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): ServerLicenseChallengeV3 {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    fail(LicenseProtocolV3ErrorCode.InvalidInput);
  }
  const challenge = parseServerLicenseChallengeV3(value);
  if (
    challenge.expires_at + CHALLENGE_CLOCK_SKEW_SECONDS < nowSeconds ||
    challenge.expires_at > nowSeconds + MAX_CHALLENGE_FUTURE_SECONDS
  ) {
    fail(LicenseProtocolV3ErrorCode.ChallengeExpired);
  }
  return challenge;
}

/**
 * Parse contract token v3 đã verify chữ ký Ed25519 ở tầng gọi.
 * Hàm này khóa binding/TTL và chủ ý từ chối raw `challenge` hoặc cờ
 * `attestation_verified` vì chúng không thuộc token do server ký.
 */
export function parseLicenseTokenClaimsV3(
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): LicenseTokenClaimsV3 {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    fail(LicenseProtocolV3ErrorCode.InvalidInput);
  }
  const record = recordWithOptionalKeys(
    value,
    ["k", "m", "p", "plan", "exp", "v", "iat", "d", "cnf", "min_v", "cid"],
    ["features", "rk"],
    LicenseProtocolV3ErrorCode.InvalidToken,
  );
  if (record.v !== LICENSE_PROTOCOL_V3 || record.min_v !== LICENSE_PROTOCOL_V3) {
    fail(LicenseProtocolV3ErrorCode.UnsupportedProtocol);
  }
  if (record.p !== LICENSE_PROTOCOL_V3_PRODUCT) {
    fail(LicenseProtocolV3ErrorCode.InvalidScope);
  }
  if (
    !isLowerHex(record.k, 16) ||
    typeof record.plan !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(record.plan) ||
    typeof record.cid !== "string" ||
    !CANONICAL_UUID_RE.test(record.cid)
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidToken);
  }

  const deviceKeyId = parseDeviceKeyId(record.d);
  const legacyMachineBinding = parseDeviceKeyId(record.m);
  const confirmation = exactRecord(
    record.cnf,
    ["jkt"],
    LicenseProtocolV3ErrorCode.InvalidToken,
  );
  const jkt = confirmation.jkt;
  decodeCanonicalBase64Url(jkt, 32, LicenseProtocolV3ErrorCode.InvalidToken);
  if (
    legacyMachineBinding !== deviceKeyId ||
    typeof jkt !== "string" ||
    deviceKeyId !== DEVICE_KEY_ID_PREFIX + jkt
  ) {
    fail(LicenseProtocolV3ErrorCode.KeyMismatch);
  }

  if (
    typeof record.iat !== "number" ||
    typeof record.exp !== "number" ||
    !Number.isSafeInteger(record.iat) ||
    !Number.isSafeInteger(record.exp) ||
    record.iat <= 0 ||
    record.exp <= record.iat ||
    record.exp - record.iat > LICENSE_TOKEN_V3_MAX_TTL_SECONDS ||
    record.iat > nowSeconds + CHALLENGE_CLOCK_SKEW_SECONDS
  ) {
    fail(LicenseProtocolV3ErrorCode.InvalidToken);
  }
  if (record.exp + CHALLENGE_CLOCK_SKEW_SECONDS < nowSeconds) {
    fail(LicenseProtocolV3ErrorCode.TokenExpired);
  }

  let features: string[] | undefined;
  if (record.features !== undefined) {
    if (
      !Array.isArray(record.features) ||
      record.features.length > 128 ||
      record.features.some((feature) =>
        typeof feature !== "string" || !/^[A-Za-z0-9.*:_-]{1,128}$/.test(feature)
      ) ||
      new Set(record.features).size !== record.features.length
    ) {
      fail(LicenseProtocolV3ErrorCode.InvalidToken);
    }
    features = [...record.features] as string[];
  }

  let resourceKey: string | undefined;
  if (record.rk !== undefined) {
    if (
      typeof record.rk !== "string" ||
      record.rk.length === 0 ||
      record.rk.length > 4096 ||
      containsAsciiControl(record.rk)
    ) {
      fail(LicenseProtocolV3ErrorCode.InvalidToken);
    }
    resourceKey = record.rk;
  }

  return {
    k: record.k,
    m: deviceKeyId,
    p: LICENSE_PROTOCOL_V3_PRODUCT,
    plan: record.plan,
    ...(features ? { features } : {}),
    ...(resourceKey ? { rk: resourceKey } : {}),
    exp: record.exp,
    v: LICENSE_PROTOCOL_V3,
    iat: record.iat,
    d: deviceKeyId,
    cnf: { jkt },
    min_v: LICENSE_PROTOCOL_V3,
    cid: record.cid,
  };
}

/**
 * Xác minh proof PS256 trên transcript, đồng thời tự tính device ID từ JWK.
 * Caller vẫn phải consume challenge một lần trong transaction và xác minh MAA
 * trước khi cấp token/rk hoặc thay đổi activation.
 */
export async function verifyDeviceLicenseProofV3(
  identityValue: unknown,
  challengeValue: unknown,
  proofValue: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<DeviceProofVerificationV3> {
  try {
    const identity = parseDevicePublicIdentityV3(identityValue);
    const challenge = validateChallengeFreshnessV3(challengeValue, nowSeconds);
    const proof = parseDeviceLicenseProofV3(proofValue);
    const derivedDeviceKeyId = await deriveDeviceKeyIdV3(identity.public_key_jwk);
    if (
      identity.device_key_id !== derivedDeviceKeyId ||
      challenge.device_key_id !== derivedDeviceKeyId ||
      proof.device_key_id !== derivedDeviceKeyId
    ) {
      fail(LicenseProtocolV3ErrorCode.KeyMismatch);
    }

    const transcriptBytes = new TextEncoder().encode(canonicalTranscript(challenge));
    const transcriptHash = await sha256(transcriptBytes);
    const claimedHash = decodeCanonicalBase64Url(
      proof.proof_input_hash,
      32,
      LicenseProtocolV3ErrorCode.InvalidProof,
    );
    if (!equalBytes(transcriptHash, claimedHash)) {
      fail(LicenseProtocolV3ErrorCode.InvalidProof);
    }

    const signature = decodeCanonicalBase64Url(
      proof.proof,
      256,
      LicenseProtocolV3ErrorCode.InvalidProof,
    );
    let publicKey: CryptoKey;
    try {
      publicKey = await requireSubtleCrypto().importKey(
        "jwk",
        {
          alg: LICENSE_PROTOCOL_V3_PROOF_ALGORITHM,
          e: identity.public_key_jwk.e,
          ext: true,
          key_ops: ["verify"],
          kty: identity.public_key_jwk.kty,
          n: identity.public_key_jwk.n,
        },
        { name: "RSA-PSS", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      fail(LicenseProtocolV3ErrorCode.InvalidPublicKey);
    }

    let valid: boolean;
    try {
      valid = await requireSubtleCrypto().verify(
        { name: "RSA-PSS", saltLength: 32 },
        publicKey,
        signature,
        transcriptBytes,
      );
    } catch {
      fail(LicenseProtocolV3ErrorCode.CryptoFailure);
    }
    if (!valid) fail(LicenseProtocolV3ErrorCode.InvalidProof);

    return {
      ok: true,
      deviceKeyId: derivedDeviceKeyId,
      proofInputHash: encodeBase64Url(transcriptHash),
      proofSha256: bytesToHex(await sha256(signature)),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof LicenseProtocolV3Error
        ? error.code
        : LicenseProtocolV3ErrorCode.CryptoFailure,
    };
  }
}
