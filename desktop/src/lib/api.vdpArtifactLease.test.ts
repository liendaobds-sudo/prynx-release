// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      licenseSignOutPending: false,
    }),
  },
  getLicenseOperationEpoch: () => 0,
  isLicenseOperationPending: () => false,
  isNativeLicenseGateBlocked: () => false,
}));

import { pollVdpJob } from './api';

const ARTIFACT_LEASE_TOKEN = 'b'.repeat(64);

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

describe('pollVdpJob artifact lease', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      'X-PrynX-Signature': 'trusted-signature',
      'X-PrynX-Timestamp': '123',
    });
    window.__TAURI_INTERNALS__ = {};
    window.__PRYNX_INVOKE__ = invokeMock as typeof window.__PRYNX_INVOKE__;
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__PRYNX_INVOKE__;
    vi.unstubAllGlobals();
  });

  it('trả lease cùng native path khi caller bỏ qua download', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'completed',
      result: 'D:\\results\\vdp-job.pdf',
      artifact_lease: ARTIFACT_LEASE_TOKEN,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollVdpJob('job-native', vi.fn(), true);

    expect(result.path).toBe('D:\\results\\vdp-job.pdf');
    expect(result.artifactLease).toBe(ARTIFACT_LEASE_TOKEN);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob?.size).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('trả cùng lease khi tải Blob kết quả về WebView', async () => {
    const downloadedBlob = new Blob(['vdp-pdf'], { type: 'application/pdf' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/vdp/status/job-download')) {
        return new Response(JSON.stringify({
          status: 'completed',
          result: 'D:\\results\\vdp-downloaded.pdf',
          artifact_lease: ARTIFACT_LEASE_TOKEN,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/vdp/download/job-download')) {
        return {
          ok: true,
          blob: async () => downloadedBlob,
        } as Response;
      }
      throw new Error(`Request ngoài fixture: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pollVdpJob('job-download', vi.fn());

    expect(result.path).toBe('D:\\results\\vdp-downloaded.pdf');
    expect(result.artifactLease).toBe(ARTIFACT_LEASE_TOKEN);
    expect(result.blob).toBe(downloadedBlob);
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      'http://localhost:8321/api/vdp/status/job-download',
      'http://localhost:8321/api/vdp/download/job-download',
    ]);
  });
});
