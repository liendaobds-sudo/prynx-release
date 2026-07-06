import { describe, it, expect } from 'vitest';
import { isLicenseTokenValid } from './licenseToken';

// Dựng token giả "<payload_b64url>.<sig>" với exp cho trước (giây unix).
// isLicenseTokenValid KHÔNG verify chữ ký (đó là việc của backend/Rust) — chỉ đọc exp,
// nên sig để chuỗi bất kỳ.
function makeToken(expSeconds: number): string {
  const payload = JSON.stringify({ k: 'abc', m: 'hwid', p: 'prynx', exp: expSeconds });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64}.fakesignature`;
}

const NOW = () => Math.floor(Date.now() / 1000);

describe('isLicenseTokenValid', () => {
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
