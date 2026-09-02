import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (file: string) => readFileSync(resolve(process.cwd(), 'src', file), 'utf8');

describe('kích hoạt chỉ bằng key', () => {
  it('mở ứng dụng bằng key đã xác minh, không đòi phiên Google', () => {
    expect(src('App.tsx')).toContain('const isAuthenticated = Boolean(licenseKey && licenseValid);');
    expect(src('stores/useAuthStore.ts')).toContain('if (storedKey) {');
  });

  it('xác minh key trước khi lưu ở màn hình kích hoạt', () => {
    const loginScreen = src('components/auth/LoginScreen.tsx');
    expect(loginScreen).toContain('changeLicenseKey(inputKey.trim())');
    expect(loginScreen).not.toContain('{!user ? (');
  });

  // ĐĂNG NHẬP GOOGLE ĐÃ GỠ (2026-08-28): key đi theo email nên chỉ cần nhập key. Việc gỡ
  // này cũng đóng bề mặt session-injection qua deep link (pentest §ATK.01). Ratchet giữ nó
  // không quay lại — kèm cả luồng OAuth deep link vốn là nơi kẻ tấn công chèn session.
  it('không còn nút/luồng đăng nhập Google', () => {
    const loginScreen = src('components/auth/LoginScreen.tsx');
    for (const dau_vet of [
      'signInWithOAuth',
      'handleGoogleLogin',
      'tiep_tuc_voi_google',
      'useAuthDeepLinkListener',
      'exchangeCodeForSession',
    ]) {
      expect(loginScreen, `LoginScreen không được chứa "${dau_vet}"`).not.toContain(dau_vet);
    }
  });

  it('SystemIntegrations không còn phát sự kiện callback OAuth', () => {
    // Đây là điểm bơm URL vào handler auth cũ; gỡ đi thì deep link auth không có đường vào.
    // Kiểm đúng lời gọi dispatch (không phải chuỗi trong comment giải thích).
    expect(src('components/SystemIntegrations.tsx')).not.toContain(
      "dispatchEvent(new CustomEvent('auth-url-received'",
    );
  });
});
