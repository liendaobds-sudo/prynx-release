// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadPDF } from './api';

const DESKTOP_ONLY = 'Chỉ khả dụng trong ứng dụng desktop';
// RELEASE QA (audit 2026-08-03 §REL.05): ngân sách riêng cho hai ca từng timeout khi full suite tranh CPU.
const FULL_SUITE_TIMEOUT_MS = 15_000;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('uploadPDF local-path fallback', () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    (window as any).__PRYNX_INVOKE__ = vi.fn(async () => ({}));
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    delete (window as any).__PRYNX_INVOKE__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('falls back to multipart when a DEV_MODE backend rejects the desktop-only endpoint', async () => {
    const uploaded = { id: 'file-1', filename: 'stored.pdf', original_name: 'card.pdf' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(403, { detail: DESKTOP_ONLY }))
      .mockResolvedValueOnce(jsonResponse(200, uploaded));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['%PDF-test'], 'card.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: 'C:\\tmp\\card.pdf' });

    await expect(uploadPDF(file)).resolves.toEqual(uploaded);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/upload/local');
    expect(fetchMock.mock.calls[1][1]?.body).toBeInstanceOf(FormData);
  }, FULL_SUITE_TIMEOUT_MS);

  it('does not hide unrelated authorization failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(403, {
      detail: 'Invalid request signature',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['%PDF-test'], 'card.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: 'C:\\tmp\\card.pdf' });

    await expect(uploadPDF(file)).rejects.toThrow('Invalid request signature');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, FULL_SUITE_TIMEOUT_MS);
});
