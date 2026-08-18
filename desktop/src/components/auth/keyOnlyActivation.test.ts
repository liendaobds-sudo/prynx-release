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
});
