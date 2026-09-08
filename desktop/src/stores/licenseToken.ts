/** Tiện ích thuần để đọc token license Ed25519 do server ký. */

export interface LicenseTokenClaims {
  exp: number;
  /** SEC (audit 2026-09-04 §SEC.16-DS1): v1 chỉ được giữ cho token legacy còn hạn. */
  version: 1 | 2 | 3;
  /** Thời điểm server cấp token (giây Unix), bắt buộc với token v2/v3. */
  iat?: number;
  /** Challenge server ký, chỉ có với v2; không dùng làm trust boundary ở UI. */
  challenge?: string;
  /** Challenge một lần đã được server consume; v3 chỉ expose ID, không lặp lại nonce. */
  challengeId?: string;
  /** Device authority v3; giá trị này chỉ là metadata UX, native vẫn là trust boundary. */
  deviceKeyId?: string;
  /** RFC 7638 thumbprint trong `cnf.jkt`, phải khớp tuyệt đối với `deviceKeyId`. */
  confirmationThumbprint?: string;
  /** Protocol floor do server ký; v3 luôn phải bằng 3. */
  minimumVersion?: 3;
  plan?: string;
  features?: string[];
  k?: string;
  m?: string;
  p?: string;
  /**
   * UIUX (audit 2026-08-26 dieline-engine-unlock): token có claim `rk` (khoá mở bộ máy
   * khuôn bế của đúng bản này) hay không — CHỈ trạng thái có/không.
   *
   * Module này cố ý KHÔNG expose giá trị `rk` và không được đổi ranh giới đó: khoá chỉ
   * đi từ payload đã ký Ed25519 vào Rust, không bao giờ qua tầng UI. Ở đây chỉ đọc TÊN
   * claim để công cụ khuôn bế biết trước rằng engine sẽ không mở được, thay vì để người
   * dùng phát hiện bằng cách bấm tạo khuôn rồi nhận 403.
   */
  hasResourceKey: boolean;
}

/**
 * Trạng thái của neo đồng hồ bền vững.
 *
 * `valid` là trạng thái DUY NHẤT cho phép dùng credential offline trong native
 * runtime. `missing`, `corrupt` và `unavailable` đều là lỗi integrity/availability:
 * caller phải yêu cầu online revalidation, tuyệt đối không tự tạo neo mới ở renderer.
 * `not_required` chỉ dành cho browser/dev không có native gate; production không được
 * tự gán trạng thái này.
 *
 * SEC (audit 2026-09-03 §SEC.19): trạng thái này là discriminated union để không còn
 * nhầm giá trị `0`/`undefined` với một neo hợp lệ.
 */
export type AnchorState =
  | { kind: 'valid'; anchorMs: number }
  | { kind: 'missing'; reason?: string }
  | { kind: 'corrupt'; reason?: string }
  | { kind: 'unavailable'; reason?: string }
  | { kind: 'not_required'; reason?: string };

// Đồng bộ với dung sai issued-at của token v2 ở native/backend. Nếu server nhanh
// hơn máy dưới 5 phút, anchor vừa khôi phục không được tự khóa request đầu tiên.
const CLOCK_ANCHOR_SKEW_MS = 5 * 60_000;
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const LICENSE_TOKEN_V1 = 1;
const LICENSE_TOKEN_V2 = 2;
const LICENSE_TOKEN_V3 = 3;
// Token v3 mới có lease offline 72 giờ; verifier vẫn chấp nhận token cũ 15 phút
// trong giai đoạn rollout vì 900 giây nằm dưới cận mới.
const LICENSE_TOKEN_V3_MAX_TTL_SECONDS = 72 * 60 * 60;
const LICENSE_CHALLENGE_RE = /^[0-9a-f]{64}$/i;
const DEVICE_KEY_ID_RE = /^d3_([A-Za-z0-9_-]{43})$/;
const CHALLENGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LICENSE_KEY_HASH_RE = /^[0-9a-f]{16}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Chuẩn hoá giá trị IPC thành AnchorState; dữ liệu lạ luôn rơi về corrupt. */
export function parseAnchorState(raw: unknown): AnchorState {
  // Contract hiện tại của Tauri trả số u64; giữ hỗ trợ để migration không làm vỡ
  // bản cài cũ. Số 0 biểu thị chưa có checkpoint, KHÔNG phải trạng thái hợp lệ.
  if (typeof raw === 'number') {
    if (raw === 0) return { kind: 'missing', reason: 'clock anchor chưa được tạo' };
    if (Number.isSafeInteger(raw) && raw > 0) return { kind: 'valid', anchorMs: raw };
    return { kind: 'corrupt', reason: 'clock anchor không phải số nguyên dương an toàn' };
  }

  // Cho phép native mới trả envelope có mã trạng thái. Không đọc/echo dữ liệu phụ
  // (có thể chứa thông tin nhạy cảm) ra ngoài union này.
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    const kind = value.kind ?? value.status;
    if (kind === 'missing') return { kind: 'missing' };
    if (kind === 'corrupt' || kind === 'invalid') return { kind: 'corrupt' };
    if (kind === 'unavailable') return { kind: 'unavailable' };
    if (kind === 'not_required') return { kind: 'not_required' };
    if (kind === 'valid') {
      const timestamp = value.anchorMs ?? value.timestampMs;
      if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > 0) {
        return { kind: 'valid', anchorMs: timestamp };
      }
      return { kind: 'corrupt', reason: 'envelope anchor thiếu timestamp hợp lệ' };
    }
    // Một số native wrapper trả `{ timestampMs }` không kèm kind.
    const timestamp = value.anchorMs ?? value.timestampMs;
    if (typeof timestamp === 'number') return parseAnchorState(timestamp);
    return { kind: 'corrupt', reason: 'envelope anchor không rõ trạng thái' };
  }

  return { kind: 'corrupt', reason: 'clock anchor không có dữ liệu' };
}

function decodePayload(token: string): unknown {
  if (!token || token.indexOf('.') < 0) throw new Error('Malformed token');
  let payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4) payload += '=';
  return JSON.parse(decodeURIComponent(escape(atob(payload))));
}

/**
 * Chỉ đọc claims để hiển thị/quyết định UX. Chữ ký vẫn được Rust và sidecar xác minh;
 * frontend không được xem là biên giới bảo mật.
 */
export function readLicenseTokenClaims(token: string | null): LicenseTokenClaims | null {
  if (!token) return null;
  try {
    const raw = decodePayload(token) as Record<string, unknown>;
    const exp = raw.exp;
    const iat = raw.iat;
    const challenge = raw.challenge;
    if (typeof exp !== 'number'
      || !Number.isSafeInteger(exp)
      || exp <= 0) {
      return null;
    }

    // SEC (audit 2026-09-04 §SEC.16-DS1): token legacy còn hạn được đọc trong
    // cửa sổ chuyển tiếp, nhưng không được mang metadata v2 lai ghép. Phiên bản
    // không rõ kiểu/giá trị luôn fail-closed.
    let version: 1 | 2 | 3;
    let issuedAt: number | undefined;
    let tokenChallenge: string | undefined;
    let challengeId: string | undefined;
    let deviceKeyId: string | undefined;
    let confirmationThumbprint: string | undefined;
    let minimumVersion: 3 | undefined;
    if (raw.v === undefined || raw.v === LICENSE_TOKEN_V1) {
      if ('iat' in raw || 'challenge' in raw || 'cid' in raw || 'd' in raw
        || 'cnf' in raw || 'min_v' in raw) return null;
      version = LICENSE_TOKEN_V1;
    } else if (raw.v === LICENSE_TOKEN_V2) {
      if (typeof iat !== 'number'
        || !Number.isSafeInteger(iat)
        || iat <= 0
        || iat > exp
        || typeof challenge !== 'string'
        || !LICENSE_CHALLENGE_RE.test(challenge)
        || 'cid' in raw || 'd' in raw || 'cnf' in raw || 'min_v' in raw) {
        return null;
      }
      version = LICENSE_TOKEN_V2;
      issuedAt = iat;
      tokenChallenge = challenge;
    } else if (raw.v === LICENSE_TOKEN_V3) {
      const deviceMatch = typeof raw.d === 'string' ? DEVICE_KEY_ID_RE.exec(raw.d) : null;
      const confirmation = isPlainObject(raw.cnf) ? raw.cnf : null;
      const confirmationKeys = confirmation ? Object.keys(confirmation) : [];
      if (typeof iat !== 'number'
        || !Number.isSafeInteger(iat)
        || iat <= 0
        || iat > exp
        || exp - iat > LICENSE_TOKEN_V3_MAX_TTL_SECONDS
        || raw.min_v !== LICENSE_TOKEN_V3
        || !deviceMatch
        || raw.m !== raw.d
        || raw.p !== 'prynx'
        || typeof raw.k !== 'string'
        || !LICENSE_KEY_HASH_RE.test(raw.k)
        || !confirmation
        || confirmationKeys.length !== 1
        || confirmationKeys[0] !== 'jkt'
        || confirmation.jkt !== deviceMatch[1]
        || typeof raw.cid !== 'string'
        || !CHALLENGE_ID_RE.test(raw.cid)
        || 'challenge' in raw) {
        return null;
      }
      version = LICENSE_TOKEN_V3;
      issuedAt = iat;
      challengeId = raw.cid;
      deviceKeyId = deviceMatch[0];
      confirmationThumbprint = deviceMatch[1];
      minimumVersion = LICENSE_TOKEN_V3;
    } else {
      return null;
    }

    const claims: LicenseTokenClaims = {
      exp,
      version,
      iat: issuedAt,
      challenge: tokenChallenge,
      challengeId,
      deviceKeyId,
      confirmationThumbprint,
      minimumVersion,
      plan: typeof raw.plan === 'string' ? raw.plan : undefined,
      features: Array.isArray(raw.features)
        ? raw.features.filter((item): item is string => typeof item === 'string')
        : undefined,
      k: typeof raw.k === 'string' ? raw.k : undefined,
      m: typeof raw.m === 'string' ? raw.m : undefined,
      p: typeof raw.p === 'string' ? raw.p : undefined,
      // Chỉ suy ra boolean rồi bỏ `raw.rk` đi — giá trị khoá không bao giờ được sao vào
      // object trả về, không log, không so sánh.
      hasResourceKey: typeof raw.rk === 'string' && raw.rk.length > 0,
    };
    return claims;
  } catch {
    return null;
  }
}

/**
 * SEC (audit 2026-09-03 §SEC.19): kiểm tra đồng hồ hệ thống nhất quán với
 * clock anchor đã lưu. Nếu anchor > Date.now() + skew → đồng hồ đã bị lùi.
 * Dung sai 5 phút cho NTP drift bình thường và đồng bộ với native/backend.
 */
export function isClockConsistent(anchorMs: number, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(anchorMs) || anchorMs <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs + CLOCK_ANCHOR_SKEW_MS >= anchorMs;
}

/** Kiểm tra riêng thời hạn token, không phải cổng quyền native. */
export function isLicenseTokenUnexpired(token: string | null, nowMs = Date.now()): boolean {
  const claims = readLicenseTokenClaims(token);
  if (!claims || !Number.isFinite(nowMs)) return false;
  if (claims.version === LICENSE_TOKEN_V3
    && (!claims.iat || claims.iat * 1000 > nowMs + CLOCK_ANCHOR_SKEW_MS)) {
    return false;
  }
  return claims.exp * 1000 > nowMs + TOKEN_EXPIRY_SAFETY_MS;
}

/**
 * Cổng dùng credential offline. Anchor bắt buộc và phải hợp lệ; mọi trạng thái khác
 * đều fail-closed. `not_required` chỉ được tạo bởi browser/dev (không có native gate).
 */
export function isLicenseTokenValid(
  token: string | null,
  anchorState: AnchorState,
  nowMs = Date.now(),
): boolean {
  if (!isLicenseTokenUnexpired(token, nowMs)) return false;
  if (anchorState.kind === 'not_required') return true;
  return anchorState.kind === 'valid' && isClockConsistent(anchorState.anchorMs, nowMs);
}
