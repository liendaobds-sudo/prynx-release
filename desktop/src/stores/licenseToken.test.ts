import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { isLicenseTokenValid, readLicenseTokenClaims } from './licenseToken';

// Dựng token giả "<payload_b64url>.<sig>" với exp cho trước (giây unix).
// isLicenseTokenValid KHÔNG verify chữ ký (đó là việc của backend/Rust) — chỉ đọc exp,
// nên sig để chuỗi bất kỳ.
function makeToken(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const payload = JSON.stringify({ k: 'abc', m: 'hwid', p: 'prynx', exp: expSeconds, ...extra });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

const NOW = () => Math.floor(Date.now() / 1000);

describe('isLicenseTokenValid', () => {

  it('đọc plan và features từ token mới', () => {
    const claims = readLicenseTokenClaims(makeToken(NOW() + 3600, { plan: 'free', features: ['pdf.merge'] }));
    expect(claims?.plan).toBe('free');
    expect(claims?.features).toEqual(['pdf.merge']);
  });
  it('token còn hạn xa (2 ngày) → hợp lệ', () => {
    expect(isLicenseTokenValid(makeToken(NOW() + 2 * 24 * 3600))).toBe(true);
  });

  it('token đã hết hạn → không hợp lệ', () => {
    expect(isLicenseTokenValid(makeToken(NOW() - 10))).toBe(false);
  });

  it('token còn hạn nhưng TRONG đệm 60s → coi như hết (fail sớm)', () => {
    // exp = now + 30s < now + 60s đệm → phải trả false để backend không nhận token sắp hết.
    expect(isLicenseTokenValid(makeToken(NOW() + 30))).toBe(false);
  });

  it('token còn hạn vừa qua đệm (now + 120s) → hợp lệ', () => {
    expect(isLicenseTokenValid(makeToken(NOW() + 120))).toBe(true);
  });

  it('null / rỗng → không hợp lệ', () => {
    expect(isLicenseTokenValid(null)).toBe(false);
    expect(isLicenseTokenValid('')).toBe(false);
  });

  it('sai định dạng (thiếu dấu chấm) → không hợp lệ', () => {
    expect(isLicenseTokenValid('khongcodaucham')).toBe(false);
  });

  it('payload không giải mã được → không hợp lệ', () => {
    expect(isLicenseTokenValid('@@@notbase64@@@.sig')).toBe(false);
  });

  it('thiếu trường exp → không hợp lệ', () => {
    const payload = JSON.stringify({ k: 'abc', m: 'hwid', p: 'prynx' });
    const b64 = btoa(unescape(encodeURIComponent(payload)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(isLicenseTokenValid(`${b64}.sig`)).toBe(false);
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
const ALLOWED_CLAIM_KEYS = ['exp', 'features', 'hasResourceKey', 'k', 'm', 'p', 'plan'];

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
          // exp ≥ 1: `readLicenseTokenClaims` trả null khi exp falsy, ca đó đã có test riêng.
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
