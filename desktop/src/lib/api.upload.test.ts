// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const authStateMock = vi.hoisted(() => ({
  licenseKey: 'LICENSE-KEY' as string | null,
  licenseToken: 'license-token' as string | null,
  licenseSignOutPending: false,
}));

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => authStateMock,
  },
  getLicenseOperationEpoch: () => 0,
  isLicenseOperationPending: () => false,
  isNativeLicenseGateBlocked: () => false,
}));

import { uploadPDF } from './api';

const DESKTOP_ONLY = 'Chỉ khả dụng trong ứng dụng desktop';
// RELEASE QA (audit 2026-08-03 §REL.05): ngân sách riêng cho hai ca từng timeout khi full suite tranh CPU.
const FULL_SUITE_TIMEOUT_MS = 15_000;
const originalBlobArrayBuffer = Blob.prototype.arrayBuffer;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// jsdom thiếu API `Blob.arrayBuffer()` vốn có trên trình duyệt thật. Lớp ký
// production băm theo chunk, nên fixture bổ sung đúng API thay vì né body binding.
function installBlobArrayBufferForJsdom(): void {
  if (typeof Blob.prototype.arrayBuffer === 'function') return;
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(this);
      });
    },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

describe('uploadPDF local-path fallback', () => {
  beforeEach(() => {
    installBlobArrayBufferForJsdom();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => (
      command === 'sign_api_request'
        ? {
          'X-PrynX-Signature': 'trusted-signature',
          'X-PrynX-Timestamp': '123',
          'X-PrynX-Nonce': 'test-nonce',
          'X-PrynX-Signature-Version': '2',
          'X-PrynX-Body-Mode': 'none',
          'X-PrynX-Body-Commitment': '0'.repeat(64),
        }
        : undefined
    ));
    window.__TAURI_INTERNALS__ = {};
    window.__PRYNX_INVOKE__ = invokeMock as typeof window.__PRYNX_INVOKE__;
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__PRYNX_INVOKE__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    if (originalBlobArrayBuffer) {
      Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value: originalBlobArrayBuffer,
      });
    } else {
      Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
    }
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
    expect(requestUrl(fetchMock.mock.calls[0][0])).toContain('/api/upload/local');
    const fallbackRequest = fetchMock.mock.calls[1][0] as Request;
    // Auth gửi đúng một Request đã serialize; kiểm Content-Type thực tế thay
    // vì đọc khe `init.body` cũ không còn được dùng.
    expect(fallbackRequest.headers.get('content-type')).toMatch(/^multipart\/form-data;\s*boundary=/i);
  }, FULL_SUITE_TIMEOUT_MS);

  it('does not hide unrelated authorization failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(403, {
      detail: 'Invalid request signature',
    }));
    vi.stubGlobal('fetch', fetchMock);

    // The previous test intentionally marks the local endpoint unavailable;
    // use the regular multipart path here so this case remains independent of
    // that module-level capability cache.
    const file = new File(['%PDF-test'], 'card.pdf', { type: 'application/pdf' });

    await expect(uploadPDF(file)).rejects.toThrow('Invalid request signature');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, FULL_SUITE_TIMEOUT_MS);
});
