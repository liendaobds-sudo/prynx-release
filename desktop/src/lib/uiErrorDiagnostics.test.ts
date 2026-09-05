import { describe, expect, it } from 'vitest';

import { buildUiDiagnosticReport } from './uiErrorDiagnostics';

describe('uiErrorDiagnostics — không lộ kỹ thuật ở production', () => {
  const sentinel = new Error(
    'ENGINE_SECRET Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuv.signatureabcdefghijkl',
  );
  sentinel.stack = [
    'Error: ENGINE_SECRET',
    String.raw`at solveSecret (C:\KhachHang\don-hang.pdf:12:3)`,
    'at https://localhost/assets/secret-engine.js:9:1',
  ].join('\n');

  it('production chỉ sao chép allowlist version, mã lỗi và khu vực', () => {
    const report = buildUiDiagnosticReport('sticker-tool', 'STICK-ABC123', sentinel, {
      includeTechnicalDetails: false,
      userAgent: 'ENGINE_USER_AGENT',
    });

    expect(report).toContain('Error ID: STICK-ABC123');
    expect(report).toContain('Area: sticker-tool');
    expect(report).toContain('hidden in production');
    for (const secret of ['ENGINE_SECRET', 'Bearer', 'KhachHang', 'localhost', 'solveSecret', 'ENGINE_USER_AGENT']) {
      expect(report).not.toContain(secret);
    }
  });

  it('dev vẫn có dữ liệu hỗ trợ nhưng redact path, URL và token', () => {
    const report = buildUiDiagnosticReport('root', 'ROOT-ABC123', sentinel, {
      includeTechnicalDetails: true,
      userAgent: 'PrynX-Test-Agent',
    });

    expect(report).toContain('ENGINE_SECRET');
    expect(report).toContain('<local-path>');
    expect(report).toContain('<url>');
    expect(report).toContain('Bearer <redacted>');
    expect(report).not.toContain('KhachHang');
    expect(report).not.toContain('localhost');
  });
});
