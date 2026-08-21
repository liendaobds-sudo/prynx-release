// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
    }),
  },
}));

import { authenticatedFetch, installBackendFetchAuth } from './api';

describe('API request authentication', () => {
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

  it('does not let caller headers replace native authentication headers', async () => {
    // Khai kiểu tham số cho mock: `vi.fn(async () => …)` suy ra tuple đối số
    // RỖNG nên `calls[0][1]` không tồn tại dưới mắt tsc và build gate đỏ.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch('http://localhost:8321/api/secure', {
      method: 'POST',
      headers: {
        'X-PrynX-Signature': 'forged-signature',
        'X-Custom': 'kept',
      },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-PrynX-Signature')).toBe('trusted-signature');
    expect(headers.get('X-Custom')).toBe('kept');
    expect(invokeMock).toHaveBeenCalledWith('sign_api_request', expect.objectContaining({
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
    }));
  });

  it('re-registers a stale native token binding before sending the request', async () => {
    let nativeToken = 'stale-token';
    invokeMock.mockImplementation(async (
      command: string,
      args?: Record<string, string>,
    ) => {
      if (command === 'register_validated_key') {
        nativeToken = args?.token || '';
        return undefined;
      }
      if (command === 'sign_api_request') {
        if (args?.licenseToken !== nativeToken) {
          throw new Error('Token bản quyền đã thay đổi');
        }
        return {
          'X-PrynX-Signature': 'trusted-signature',
          'X-PrynX-Timestamp': '123',
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch('http://localhost:8321/api/upscale', {
      method: 'POST',
      body: 'image-bytes',
    });

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'sign_api_request',
      'register_validated_key',
      'sign_api_request',
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'sign_api_request', {
      urlPath: '/api/upscale',
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'register_validated_key', {
      licenseKey: 'LICENSE-KEY',
      token: 'license-token',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'sign_api_request', {
      urlPath: '/api/upscale',
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentHeaders = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(sentHeaders.get('X-License-Token')).toBe('license-token');
    expect(sentHeaders.get('X-PrynX-Signature')).toBe('trusted-signature');
  });

  it('signs and sends the effective Request after init overrides', async () => {
    const transport = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', transport);
    installBackendFetchAuth();

    const input = new Request('http://localhost:8321/api/secure', { method: 'GET' });
    await window.fetch(input, { method: 'POST', body: 'payload' });

    const sent = transport.mock.calls[0][0] as Request;
    expect(sent.method).toBe('POST');
    expect(await sent.text()).toBe('payload');
    expect(sent.headers.get('X-PrynX-Signature')).toBe('trusted-signature');
    expect(invokeMock).toHaveBeenCalledWith('sign_api_request', expect.objectContaining({
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
    }));

    invokeMock.mockClear();
    await window.fetch('http://localhost:8321@evil.test/steal');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(transport.mock.calls[1][0]).toBe('http://localhost:8321@evil.test/steal');

    // Backend dev hot-reload đóng socket khoảng một giây: request đọc phải tự hồi phục.
    const beforeRetry = transport.mock.calls.length;
    transport
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const recovered = await window.fetch('http://localhost:8321/api/vdp/fonts');
    expect(recovered.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(beforeRetry + 2);
    const beforeReadPost = transport.mock.calls.length;
    transport
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await window.fetch('http://localhost:8321/api/imposition/pdf-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"path":"D:/sample.pdf","page":1}',
    });
    expect(transport).toHaveBeenCalledTimes(beforeReadPost + 2);

    // Preview là POST nhưng chỉ đọc/tính toán. Khi sidecar vừa đổi worker,
    // request phải tự gửi lại thay vì hiện ngay lỗi "Failed to fetch".
    const beforePreviewPost = transport.mock.calls.length;
    transport
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));
    const preview = await window.fetch('http://localhost:8321/api/imposition/preview-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"usable_w":100,"usable_h":100}',
    });
    expect(preview.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(beforePreviewPost + 2);

    // Health được dùng làm cổng trước tác vụ Upscale nặng và cần chịu được
    // khoảng trống khi sidecar đang đổi tiến trình.
    const beforeHealth = transport.mock.calls.length;
    transport
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    const health = await window.fetch('http://localhost:8321/health');
    expect(health.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(beforeHealth + 2);


    // POST tạo trạng thái không được lặp, tránh tạo hai job/file khi response bị đứt.
    const beforeUnsafePost = transport.mock.calls.length;
    transport.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(window.fetch('http://localhost:8321/api/jobs', {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow('Failed to fetch');
    expect(transport).toHaveBeenCalledTimes(beforeUnsafePost + 1);
  });
});
