import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { isLicenseTokenValid, readLicenseTokenClaims, type AnchorState } from './licenseToken';

const NOW = () => Math.floor(Date.now() / 1000);
const V2_CHALLENGE = 'ab'.repeat(32);
const V3_THUMBPRINT = 'A'.repeat(43);
const V3_DEVICE_KEY_ID = `d3_${V3_THUMBPRINT}`;
const V3_CHALLENGE_ID = '018f0f5e-8d51-7f77-bbd5-f19db33c4b7a';

// Dựng token v2 giả "<payload_b64url>.<sig>" với exp cho trước (giây unix).
// isLicenseTokenValid KHÔNG verify chữ ký (đó là việc của backend/Rust) — chỉ đọc exp,
// nên sig để chuỗi bất kỳ.
function makeToken(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const issuedAt = Math.max(1, Math.min(NOW(), expSeconds - 1));
  const payload = JSON.stringify({
    v: 2,
    iat: issuedAt,
    challenge: V2_CHALLENGE,
    k: 'abc',
    m: 'hwid',
    p: 'prynx',
    exp: expSeconds,
    ...extra,
  });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

/** Dựng token device-authority v3; chữ ký giả vì module này chỉ đọc metadata UX. */
function makeV3Token(
  expSeconds = NOW() + 10 * 60,
  extra: Record<string, unknown> = {},
): string {
  const issuedAt = Math.max(1, Math.min(NOW(), expSeconds - 1));
  return encodeClaims({
    v: 3,
    min_v: 3,
    iat: issuedAt,
    exp: expSeconds,
    cid: V3_CHALLENGE_ID,
    d: V3_DEVICE_KEY_ID,
    cnf: { jkt: V3_THUMBPRINT },
    m: V3_DEVICE_KEY_ID,
    k: '0123456789abcdef',
    p: 'prynx',
    plan: 'pro',
    ...extra,
  });
}

/** Dựng token legacy, có thể mang `v: 1` tường minh nhưng không mang metadata v2. */
function makeV1Token(
  expSeconds: unknown,
  explicitVersion = false,
  extra: Record<string, unknown> = {},
): string {
  return encodeClaims({
    ...(explicitVersion ? { v: 1 } : {}),
    k: 'abc',
    m: 'hwid',
    p: 'prynx',
    exp: expSeconds,
    ...extra,
  });
}

const VALID_ANCHOR = (): AnchorState => ({ kind: 'valid', anchorMs: Date.now() - 1_000 });

describe('isLicenseTokenValid', () => {

  it('đọc plan và features từ token mới', () => {
    const claims = readLicenseTokenClaims(makeToken(NOW() + 3600, { plan: 'free', features: ['pdf.merge'] }));
    expect(claims?.plan).toBe('free');
    expect(claims?.features).toEqual(['pdf.merge']);
  });
  it('token còn hạn xa (2 ngày) → hợp lệ', () => {
    expect(isLicenseTokenValid(makeToken(NOW() + 2 * 24 * 3600), VALID_ANCHOR())).toBe(true);
  });

  it('token đã hết hạn → không hợp lệ', () => {
    expect(isLicenseTokenValid(makeToken(NOW() - 10), VALID_ANCHOR())).toBe(false);
  });

  it('token còn hạn nhưng TRONG đệm 60s → coi như hết (fail sớm)', () => {
    // exp = now + 30s < now + 60s đệm → phải trả false để backend không nhận token sắp hết.
    expect(isLicenseTokenValid(makeToken(NOW() + 30), VALID_ANCHOR())).toBe(false);
  });

  it('token còn hạn vừa qua đệm (now + 120s) → hợp lệ', () => {
    expect(isLicenseTokenValid(makeToken(NOW() + 120), VALID_ANCHOR())).toBe(true);
  });

  it('null / rỗng → không hợp lệ', () => {
    expect(isLicenseTokenValid(null, VALID_ANCHOR())).toBe(false);
    expect(isLicenseTokenValid('', VALID_ANCHOR())).toBe(false);
  });

  it('sai định dạng (thiếu dấu chấm) → không hợp lệ', () => {
    expect(isLicenseTokenValid('khongcodaucham', VALID_ANCHOR())).toBe(false);
  });

  it('payload không giải mã được → không hợp lệ', () => {
    expect(isLicenseTokenValid('@@@notbase64@@@.sig', VALID_ANCHOR())).toBe(false);
  });

  it('thiếu trường exp → không hợp lệ', () => {
    const token = encodeClaims({
      v: 2,
      iat: NOW(),
      challenge: V2_CHALLENGE,
      k: 'abc',
      m: 'hwid',
      p: 'prynx',
    });
    expect(isLicenseTokenValid(token, VALID_ANCHOR())).toBe(false);
  });

  it('token v1 thiếu v hoặc khai báo v=1 đều được đọc trong cửa sổ chuyển tiếp', () => {
    const exp = NOW() + 3600;
    for (const explicitVersion of [false, true]) {
      const claims = readLicenseTokenClaims(makeV1Token(exp, explicitVersion));
      expect(claims?.version, `explicitVersion=${explicitVersion}`).toBe(1);
      expect(claims?.iat).toBeUndefined();
      expect(claims?.challenge).toBeUndefined();
    }
  });

  it('token v1 tuân thời hạn và chỉ hợp lệ khi anchor valid', () => {
    const token = makeV1Token(NOW() + 3600);
    expect(isLicenseTokenValid(token, VALID_ANCHOR())).toBe(true);
    expect(isLicenseTokenValid(makeV1Token(NOW() - 10), VALID_ANCHOR())).toBe(false);
    expect(isLicenseTokenValid(makeV1Token(NOW() + 30), VALID_ANCHOR())).toBe(false);

    for (const state of [
      { kind: 'missing' },
      { kind: 'corrupt' },
      { kind: 'unavailable' },
    ] as const) {
      expect(isLicenseTokenValid(token, state), state.kind).toBe(false);
    }
  });

  it('token v1 chỉ nhận exp là số nguyên dương an toàn', () => {
    for (const exp of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123', null]) {
      expect(readLicenseTokenClaims(makeV1Token(exp)), `exp=${String(exp)}`).toBeNull();
    }
  });

  it('phiên bản không hỗ trợ, sai kiểu hoặc boolean đều fail-closed', () => {
    const exp = NOW() + 3600;
    for (const version of [0, 4, -1, true, false, '1', '2', '3', null, {}, []]) {
      expect(readLicenseTokenClaims(makeToken(exp, { v: version })), `v=${JSON.stringify(version)}`).toBeNull();
    }
  });

  it('token v1 mang iat/challenge lai ghép v2 bị từ chối', () => {
    const exp = NOW() + 3600;
    for (const explicitVersion of [false, true]) {
      for (const extra of [
        { iat: NOW() },
        { challenge: V2_CHALLENGE },
        { iat: NOW(), challenge: V2_CHALLENGE },
      ]) {
        expect(readLicenseTokenClaims(makeV1Token(exp, explicitVersion, extra))).toBeNull();
      }
    }
  });

  it('token v2 thiếu hoặc sai iat/challenge đều bị từ chối', () => {
    const exp = NOW() + 3600;
    for (const extra of [
      { iat: undefined },
      { iat: 0 },
      { iat: 1.5 },
      { iat: exp + 1 },
      { challenge: undefined },
      { challenge: 'ab'.repeat(31) },
      { challenge: 'z'.repeat(64) },
    ]) {
      expect(readLicenseTokenClaims(makeToken(exp, extra)), JSON.stringify(extra)).toBeNull();
    }
  });

  it('token v3 hợp lệ chỉ expose binding, không expose nonce challenge', () => {
    const claims = readLicenseTokenClaims(makeV3Token());
    expect(claims).toMatchObject({
      version: 3,
      minimumVersion: 3,
      challengeId: V3_CHALLENGE_ID,
      deviceKeyId: V3_DEVICE_KEY_ID,
      confirmationThumbprint: V3_THUMBPRINT,
      m: V3_DEVICE_KEY_ID,
      p: 'prynx',
    });
    expect(claims?.challenge).toBeUndefined();
    expect(isLicenseTokenValid(makeV3Token(), VALID_ANCHOR())).toBe(true);
  });

  it('token v3 quá 900 giây hoặc issued-at quá xa tương lai bị từ chối', () => {
    const now = NOW();
    expect(readLicenseTokenClaims(makeV3Token(now + 901, { iat: now }))).toBeNull();
    const future = makeV3Token(now + 10 * 60, { iat: now + 5 * 60 + 1 });
    expect(isLicenseTokenValid(future, VALID_ANCHOR(), now * 1000)).toBe(false);
  });

  it('token v3 sai device binding, protocol floor hoặc challenge id bị từ chối', () => {
    for (const extra of [
      { min_v: 2 },
      { d: `d3_${'B'.repeat(43)}` },
      { m: 'HWID-LEGACY' },
      { cnf: { jkt: 'B'.repeat(43) } },
      { cnf: { jkt: V3_THUMBPRINT, alg: 'PS256' } },
      { cid: V3_CHALLENGE_ID.toUpperCase() },
      { cid: 'khong-phai-uuid' },
      { challenge: V2_CHALLENGE },
      { k: 'ABCDEF0123456789' },
      { p: 'other-product' },
    ]) {
      expect(readLicenseTokenClaims(makeV3Token(undefined, extra)), JSON.stringify(extra)).toBeNull();
    }
  });

  it('anchor thiếu/hỏng/unavailable → token còn hạn vẫn bị từ chối', () => {
    const token = makeToken(NOW() + 3600);
    for (const state of [
      { kind: 'missing' },
      { kind: 'corrupt' },
      { kind: 'unavailable' },
    ] as const) {
      expect(isLicenseTokenValid(token, state), state.kind).toBe(false);
    }
  });

  it('anchor lệch trong dung sai NTP 5 phút → vẫn nhất quán', () => {
    const token = makeToken(NOW() + 3600);
    expect(isLicenseTokenValid(token, { kind: 'valid', anchorMs: Date.now() + 4 * 60_000 })).toBe(true);
  });

  it('anchor vượt dung sai NTP → phát hiện rollback', () => {
    const token = makeToken(NOW() + 3600);
    expect(isLicenseTokenValid(token, { kind: 'valid', anchorMs: Date.now() + 5 * 60_000 + 1_000 })).toBe(false);
  });
});

describe('parseAnchorState', () => {
  it('không coi 0/undefined là anchor hợp lệ', async () => {
    const { parseAnchorState } = await import('./licenseToken');
    expect(parseAnchorState(0).kind).toBe('missing');
    expect(parseAnchorState(undefined).kind).toBe('corrupt');
    expect(parseAnchorState({ status: 'missing' }).kind).toBe('missing');
    expect(parseAnchorState({ status: 'corrupt' }).kind).toBe('corrupt');
  });

  it('đọc envelope native hợp lệ nhưng không làm lộ trường phụ', async () => {
    const { parseAnchorState } = await import('./licenseToken');
    const parsed = parseAnchorState({ status: 'valid', timestampMs: 1234, secret: 'do-not-copy' });
    expect(parsed).toEqual({ kind: 'valid', anchorMs: 1234 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
// hasResourceKey — chỉ trạng thái có/không của claim `rk`
//
// Bối cảnh (spec `.kiro/specs/dieline-engine-unlock-fix` §G, task 8.1/8.4): bộ máy khuôn
// bế ở bản phát hành được mã hoá theo từng phiên bản, khoá mở nằm ở claim `rk` của token
// license. Công cụ khuôn bế cần biết TRƯỚC là token có khoá hay không để hiện banner đúng
// bản chất, thay vì để người dùng phát hiện bằng cách bấm tạo khuôn rồi nhận 403.
//
// Ranh giới sống còn: module này CỐ Ý không expose giá trị `rk`. Bộ test dưới đây gác đúng
// ranh giới đó — thêm một trường mang giá trị khoá sẽ làm property test đỏ ngay.
// ═════════════════════════════════════════════════════════════════════════════════════

/** Ký tự base64 — dựng khoá `rk` mô phỏng đủ dài để không trùng ngẫu nhiên với claim khác. */
const SECRET_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');

/** Mã hoá một payload bất kỳ thành token "<payload_b64url>.<sig>". */
function encodeClaims(payload: Record<string, unknown>): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

/** Hợp đồng khoá của `LicenseTokenClaims` — `rk` KHÔNG được có mặt ở đây. */
const ALLOWED_CLAIM_KEYS = [
  'challenge', 'challengeId', 'confirmationThumbprint', 'deviceKeyId', 'exp', 'features',
  'hasResourceKey', 'iat', 'k', 'm', 'minimumVersion', 'p', 'plan', 'version',
];

describe('readLicenseTokenClaims — hasResourceKey', () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 3600;

  it('token CÓ claim rk → hasResourceKey = true', () => {
    const claims = readLicenseTokenClaims(makeToken(FUTURE, { rk: 'a'.repeat(44) }));
    expect(claims?.hasResourceKey).toBe(true);
  });

  it('token KHÔNG có claim rk → hasResourceKey = false', () => {
    // Đây chính là ca đã đo trên bản 1.0.0-rc.9: claim = exp, k, m, p, plan.
    const claims = readLicenseTokenClaims(makeToken(FUTURE, { plan: 'pro' }));
    expect(claims?.hasResourceKey).toBe(false);
  });

  it('rk rỗng hoặc không phải chuỗi → hasResourceKey = false (không đoán bừa là có khoá)', () => {
    for (const rk of ['', 0, 1, true, null, [], {}, ['a'.repeat(44)]]) {
      const claims = readLicenseTokenClaims(makeToken(FUTURE, { rk }));
      expect(claims?.hasResourceKey, `rk = ${JSON.stringify(rk)}`).toBe(false);
    }
  });

  it('object trả về không có trường nào tên rk, kể cả khi token mang khoá', () => {
    const claims = readLicenseTokenClaims(makeToken(FUTURE, { rk: 'b'.repeat(44) }));
    expect(claims).not.toBeNull();
    expect(Object.keys(claims!).sort()).toEqual(ALLOWED_CLAIM_KEYS);
    expect('rk' in (claims as object)).toBe(false);
  });

  // **Property 4: No-Secret-Leak** - Không giá trị bí mật nào rời khỏi vùng cho phép
  // **Validates: Requirements 2.8, 3.5**
  it('không khoá nào rò ra object trả về, với payload token bất kỳ', () => {
    const arbSecret = fc
      .array(fc.constantFrom(...SECRET_CHARS), { minLength: 40, maxLength: 48 })
      .map((chars) => chars.join(''));
    const arbOptionalSecret = fc.oneof(fc.constant<string | undefined>(undefined), arbSecret);

    fc.assert(
      fc.property(
        fc.record({
          // SEC (audit 2026-09-04 §SEC.16-A0.1): mọi fixture hợp lệ đều là v2;
          // các ca v1/metadata sai được khóa riêng ở test âm phía trên.
          v: fc.constant(2),
          iat: fc.constant(1),
          challenge: fc.constant(V2_CHALLENGE),
          exp: fc.integer({ min: 1, max: 4_000_000_000 }),
          plan: fc.constantFrom('free', 'pro', 'dev', '', 'rác'),
          features: fc.oneof(
            fc.constant<unknown>(undefined),
            fc.constant<unknown>(null),
            fc.array(fc.constantFrom('pdf.merge', 'packaging.dieline', 'imposition.pro'), { maxLength: 3 }),
          ),
          k: fc.constantFrom('abc', 'KEY-1234', ''),
          m: fc.constantFrom('hwid-1', 'HWID-DAI-HON', ''),
          p: fc.constantFrom('prynx', 'other'),
          /** Khoá mở engine — thứ tuyệt đối không được rời module này. */
          rk: arbOptionalSecret,
          /** Claim lạ mà server tương lai có thể thêm; cũng không được lọt ra. */
          srk: arbOptionalSecret,
        }),
        (payload) => {
          const claims = readLicenseTokenClaims(encodeClaims(payload));
          expect(claims).not.toBeNull();

          // 1. Hợp đồng khoá cố định — không claim lạ nào lọt qua, không có `rk`.
          expect(Object.keys(claims!).sort()).toEqual(ALLOWED_CLAIM_KEYS);

          // 2. Chỉ trạng thái có/không, đúng theo định nghĩa.
          expect(claims!.hasResourceKey).toBe(
            typeof payload.rk === 'string' && payload.rk.length > 0,
          );

          // 3. Không giá trị bí mật nào xuất hiện ở BẤT KỲ đâu trong object trả về.
          const serialized = JSON.stringify(claims);
          for (const secret of [payload.rk, payload.srk]) {
            if (secret) expect(serialized).not.toContain(secret);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
