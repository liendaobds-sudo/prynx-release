// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const operationEpochMock = vi.hoisted(() => ({ value: 0 }));
const operationPendingMock = vi.hoisted(() => ({ value: false }));
const authStateMock = vi.hoisted(() => ({
  licenseKey: 'LICENSE-KEY' as string | null,
  licenseToken: 'license-token' as string | null,
  licenseSignOutPending: false,
}));

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => authStateMock,
  },
  getLicenseOperationEpoch: () => operationEpochMock.value,
  isLicenseOperationPending: () => operationPendingMock.value,
  isNativeLicenseGateBlocked: () => false,
}));

import { authenticatedFetch, installBackendFetchAuth } from './api';

const originalBlobArrayBuffer = Blob.prototype.arrayBuffer;

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

interface NativeSignArgs {
  urlPath: string;
  licenseKey: string;
  licenseToken: string;
  method: string;
  signatureVersion: string;
  bodyMode: string;
  bodyCommitment: string;
  contentType: string;
}

function signedHeaders(args?: Partial<NativeSignArgs>): Record<string, string> {
  return {
    'X-PrynX-Signature': 'trusted-signature',
    'X-PrynX-Timestamp': '123',
    'X-PrynX-Nonce': 'test-nonce',
    'X-PrynX-Signature-Version': args?.signatureVersion || '2',
    'X-PrynX-Body-Mode': args?.bodyMode || 'none',
    'X-PrynX-Body-Commitment': args?.bodyCommitment || '0'.repeat(64),
  };
}

function signArguments(): NativeSignArgs[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'sign_api_request')
    .map(([, args]) => args as NativeSignArgs);
}

describe('API request authentication', () => {
  beforeEach(() => {
    installBlobArrayBufferForJsdom();
    invokeMock.mockReset();
    operationEpochMock.value = 0;
    operationPendingMock.value = false;
    authStateMock.licenseKey = 'LICENSE-KEY';
    authStateMock.licenseToken = 'license-token';
    authStateMock.licenseSignOutPending = false;
    invokeMock.mockImplementation(async (command: string, args?: NativeSignArgs) => {
      if (command === 'sign_api_request') return signedHeaders(args);
      return undefined;
    });
    window.__TAURI_INTERNALS__ = {};
    window.__PRYNX_INVOKE__ = invokeMock as typeof window.__PRYNX_INVOKE__;
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__PRYNX_INVOKE__;
    vi.unstubAllGlobals();
    if (originalBlobArrayBuffer) {
      Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value: originalBlobArrayBuffer,
      });
    } else {
      Reflect.deleteProperty(Blob.prototype, 'arrayBuffer');
    }
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
        'X-PrynX-Signature-Version': '1',
        'X-PrynX-Body-Mode': 'none',
        'X-PrynX-Body-Commitment': 'f'.repeat(64),
        'X-Custom': 'kept',
      },
    });

    const sent = fetchMock.mock.calls[0][0] as Request;
    const headers = sent.headers;
    const [signed] = signArguments();
    expect(headers.get('X-PrynX-Signature')).toBe('trusted-signature');
    expect(headers.get('X-PrynX-Signature-Version')).toBe('2');
    expect(headers.get('X-PrynX-Body-Mode')).toBe(signed.bodyMode);
    expect(headers.get('X-PrynX-Body-Commitment')).toBe(signed.bodyCommitment);
    expect(headers.get('X-PrynX-Body-Commitment')).not.toBe('f'.repeat(64));
    expect(headers.get('X-Custom')).toBe('kept');
    expect(invokeMock).toHaveBeenCalledWith('sign_api_request', expect.objectContaining({
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
    }));
  });

  it('binds the serialized query string when requesting a native signature', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await authenticatedFetch('http://localhost:8321/api/secure?page=2&format=pdf%20x');

    expect(invokeMock).toHaveBeenCalledWith('sign_api_request', expect.objectContaining({
      urlPath: '/api/secure?page=2&format=pdf%20x',
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
        return signedHeaders(args);
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
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'sign_api_request', expect.objectContaining({
      urlPath: '/api/upscale',
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
      signatureVersion: '2',
      bodyMode: 'raw-v1',
    }));
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'register_validated_key', {
      licenseKey: 'LICENSE-KEY',
      token: 'license-token',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'sign_api_request', expect.objectContaining({
      urlPath: '/api/upscale',
      licenseKey: 'LICENSE-KEY',
      licenseToken: 'license-token',
      method: 'POST',
      signatureVersion: '2',
      bodyMode: 'raw-v1',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentHeaders = (fetchMock.mock.calls[0][0] as Request).headers;
    expect(sentHeaders.get('X-License-Token')).toBe('license-token');
    expect(sentHeaders.get('X-PrynX-Signature')).toBe('trusted-signature');
  });

  it('binds JSON bytes and content type into each v2 signature', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const sendJson = async (body: string) => authenticatedFetch(
      'http://localhost:8321/api/secure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    );

    await sendJson('{"page":1}');
    await sendJson('{"page":1}');
    await sendJson('{"page":2}');

    // SEC (audit 2026-09-03 §SEC.21): cùng byte phải cùng commitment; chỉ một
    // byte đổi cũng phải làm proof native đổi trước khi request rời renderer.
    const [first, same, changed] = signArguments();
    expect(first).toEqual(expect.objectContaining({
      signatureVersion: '2',
      bodyMode: 'raw-v1',
      contentType: 'application/json',
    }));
    expect(first.bodyCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(same.bodyCommitment).toBe(first.bodyCommitment);
    expect(changed.bodyCommitment).not.toBe(first.bodyCommitment);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('binds multipart order, file bytes, and filename without buffering the full file', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const makeForm = (bytes: number[], filename: string, fileFirst = false): FormData => {
      const form = new FormData();
      const appendFile = () => form.append(
        'artwork',
        new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
        filename,
      );
      if (fileFirst) appendFile();
      form.append('preset', 'sheet\nA');
      if (!fileFirst) appendFile();
      return form;
    };

    await authenticatedFetch('http://localhost:8321/api/upload', {
      method: 'POST',
      body: makeForm([1, 2, 3], 'artwork-a.pdf'),
    });
    await authenticatedFetch('http://localhost:8321/api/upload', {
      method: 'POST',
      body: makeForm([1, 2, 3], 'artwork-a.pdf'),
    });
    await authenticatedFetch('http://localhost:8321/api/upload', {
      method: 'POST',
      body: makeForm([1, 2, 3], 'artwork-a.pdf', true),
    });
    await authenticatedFetch('http://localhost:8321/api/upload', {
      method: 'POST',
      body: makeForm([1, 2, 4], 'artwork-a.pdf'),
    });
    await authenticatedFetch('http://localhost:8321/api/upload', {
      method: 'POST',
      body: makeForm([1, 2, 3], 'artwork-b.pdf'),
    });

    const [base, same, reordered, changedBytes, changedName] = signArguments();
    expect(base.bodyMode).toBe('form-v1');
    expect(base.contentType).toMatch(/^multipart\/form-data;\s*boundary=/i);
    // Fixture này được kiểm độc lập ở backend để khóa parity canonical JS/Python.
    expect(base.bodyCommitment).toBe(
      '6dd0e364f5e4a20d3d53e816cc5a3b57c1ae253167077df60a2aa4d5ddb46387',
    );
    expect(same.bodyCommitment).toBe(base.bodyCommitment);
    expect(reordered.bodyCommitment).not.toBe(base.bodyCommitment);
    expect(changedBytes.bodyCommitment).not.toBe(base.bodyCommitment);
    expect(changedName.bodyCommitment).not.toBe(base.bodyCommitment);
  });

  it('supports Blob, ArrayBuffer, and typed-array views with identical raw bytes', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const bodies: BodyInit[] = [
      new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }),
      new Uint8Array([1, 2, 3]).buffer,
      view,
    ];

    for (const body of bodies) {
      await authenticatedFetch('http://localhost:8321/api/upload', {
        method: 'POST',
        body,
      });
    }

    const commitments = signArguments().map(args => args.bodyCommitment);
    expect(signArguments().every(args => args.bodyMode === 'raw-v1')).toBe(true);
    expect(new Set(commitments).size).toBe(1);
  });

  it('binds URLSearchParams order and duplicate fields as semantic form data', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const makeParams = (values: string[]): URLSearchParams => {
      const params = new URLSearchParams();
      for (const value of values) params.append('plate', value);
      return params;
    };

    await authenticatedFetch('http://localhost:8321/api/secure', {
      method: 'POST',
      body: makeParams(['cyan', 'magenta']),
    });
    await authenticatedFetch('http://localhost:8321/api/secure', {
      method: 'POST',
      body: makeParams(['cyan', 'magenta']),
    });
    await authenticatedFetch('http://localhost:8321/api/secure', {
      method: 'POST',
      body: makeParams(['magenta', 'cyan']),
    });
    await authenticatedFetch('http://localhost:8321/api/secure', {
      method: 'POST',
      body: makeParams(['cyan']),
    });

    // SEC (audit 2026-09-04 §SEC.21): không được sort hoặc gom duplicate,
    // vì backend tiêu thụ danh sách field theo đúng thứ tự parser nhận được.
    const [base, same, reordered, missingDuplicate] = signArguments();
    expect(base).toEqual(expect.objectContaining({
      bodyMode: 'form-v1',
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    }));
    expect(same.bodyCommitment).toBe(base.bodyCommitment);
    expect(reordered.bodyCommitment).not.toBe(base.bodyCommitment);
    expect(missingDuplicate.bodyCommitment).not.toBe(base.bodyCommitment);
  });

  it('binds multipart field name, file MIME, zero-byte state, and chunk boundary', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const makeFileForm = (
      fieldName: string,
      bytes: Uint8Array,
      mime: string,
    ): FormData => {
      const form = new FormData();
      form.append(
        fieldName,
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }),
        'artwork.pdf',
      );
      return form;
    };
    const oneMiB = new Uint8Array(1024 * 1024);
    const oneMiBPlusOne = new Uint8Array(oneMiB.byteLength + 1);

    for (const form of [
      makeFileForm('artwork', new Uint8Array(), 'application/pdf'),
      makeFileForm('source', new Uint8Array(), 'application/pdf'),
      makeFileForm('artwork', new Uint8Array(), 'application/octet-stream'),
      makeFileForm('artwork', new Uint8Array([0]), 'application/pdf'),
      makeFileForm('artwork', oneMiB, 'application/pdf'),
      makeFileForm('artwork', oneMiBPlusOne, 'application/pdf'),
    ]) {
      await authenticatedFetch('http://localhost:8321/api/upload', {
        method: 'POST',
        body: form,
      });
    }

    const [empty, changedField, changedMime, oneByte, boundary, boundaryPlusOne] =
      signArguments();
    expect(signArguments().every(args => args.bodyMode === 'form-v1')).toBe(true);
    for (const changed of [changedField, changedMime, oneByte, boundary, boundaryPlusOne]) {
      expect(changed.bodyCommitment).not.toBe(empty.bodyCommitment);
    }
    expect(boundaryPlusOne.bodyCommitment).not.toBe(boundary.bodyCommitment);
  });

  it('drops a signature when the license generation changes during IPC', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    invokeMock.mockImplementationOnce(async () => {
      operationEpochMock.value += 1;
      return {
        'X-PrynX-Signature': 'stale-signature',
        'X-PrynX-Timestamp': '123',
      };
    });

    await authenticatedFetch('http://localhost:8321/api/secure');

    const headers = (fetchMock.mock.calls[0][0] as Request).headers;
    expect(headers.get('X-PrynX-Signature')).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-register a token after the state snapshot becomes stale', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    invokeMock.mockImplementationOnce(async () => {
      // Adapter thay token nhưng không bump epoch (để kiểm cả lớp snapshot).
      authStateMock.licenseToken = 'new-token';
      throw new Error('native binding stale');
    });

    await authenticatedFetch('http://localhost:8321/api/secure', {
      headers: {
        'X-PrynX-Signature': 'old-signature',
        'X-License-Token': 'old-token',
      },
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const sent = (fetchMock.mock.calls[0][0] as Request).headers;
    expect(sent.get('X-PrynX-Signature')).toBeNull();
    expect(sent.get('X-License-Token')).toBeNull();
  });

  it('strips all auth headers while a sign-out/license operation is pending', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    operationPendingMock.value = true;
    authStateMock.licenseSignOutPending = true;

    await authenticatedFetch('http://localhost:8321/api/secure', {
      headers: {
        'X-PrynX-Signature': 'forged',
        'X-License-Key': 'old-key',
        'X-License-Token': 'old-token',
        'X-Hardware-Id': 'old-hwid',
      },
    });

    expect(invokeMock).not.toHaveBeenCalled();
    const sent = (fetchMock.mock.calls[0][0] as Request).headers;
    expect(sent.get('X-PrynX-Signature')).toBeNull();
    expect(sent.get('X-License-Key')).toBeNull();
    expect(sent.get('X-License-Token')).toBeNull();
    expect(sent.get('X-Hardware-Id')).toBeNull();
  });

  it('signs effective requests and refreshes proof for each safe retry', async () => {
    const transport = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        void _input;
        void _init;
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal('fetch', transport);
    installBackendFetchAuth();

    // authenticatedFetch phải ủy quyền interceptor đã cài, không hash/ký hai lần.
    await authenticatedFetch('http://localhost:8321/api/no-double-sign', {
      method: 'POST',
      body: 'payload',
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    invokeMock.mockClear();
    transport.mockClear();

    const forgedRequest = new Request('http://localhost:8321/api/secure', {
      headers: { 'X-PrynX-Signature': 'forged-signature' },
    });
    await window.fetch(forgedRequest);
    const forgedSent = transport.mock.calls[0][0] as Request;
    expect(forgedSent.headers.get('X-PrynX-Signature')).toBe('trusted-signature');

    const input = new Request('http://localhost:8321/api/secure', { method: 'GET' });
    await window.fetch(input, { method: 'POST', body: 'payload' });

    const sent = transport.mock.calls[1][0] as Request;
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
    expect(transport.mock.calls[2][0]).toBe('http://localhost:8321@evil.test/steal');

    // SEC (audit 2026-09-04 §SEC.19/§ATK.09-R2): proof phải mới ở từng
    // attempt; mock cố ý cấp signature/nonce khác nhau để bắt tái sử dụng Request đã ký.
    let retryProof = 0;
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string, args?: NativeSignArgs) => {
      if (command !== 'sign_api_request') return undefined;
      retryProof += 1;
      return {
        ...signedHeaders(args),
        'X-PrynX-Signature': `trusted-signature-${retryProof}`,
        'X-PrynX-Nonce': `test-nonce-${retryProof}`,
      };
    });

    // Backend dev hot-reload đóng socket khoảng một giây: request đọc phải tự hồi phục.
    const beforeRetry = transport.mock.calls.length;
    transport
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const recovered = await window.fetch('http://localhost:8321/api/vdp/fonts');
    expect(recovered.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(beforeRetry + 2);
    const readAttempts = transport.mock.calls
      .slice(beforeRetry, beforeRetry + 2)
      .map(([request]) => request as Request);
    const readSignatures = readAttempts.map(request => request.headers.get('X-PrynX-Signature'));
    const readNonces = readAttempts.map(request => request.headers.get('X-PrynX-Nonce'));
    expect(new Set(readSignatures).size).toBe(2);
    expect(new Set(readNonces).size).toBe(2);
    expect(signArguments()).toHaveLength(2);
    expect(signArguments()[1].bodyCommitment).toBe(signArguments()[0].bodyCommitment);

    invokeMock.mockClear();
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
    const readPostAttempts = transport.mock.calls
      .slice(beforeReadPost, beforeReadPost + 2)
      .map(([request]) => request as Request);
    const readPostProofs = signArguments();
    expect(readPostProofs).toHaveLength(2);
    expect(readPostProofs[1].bodyCommitment).toBe(readPostProofs[0].bodyCommitment);
    expect(readPostAttempts[1].headers.get('X-PrynX-Signature'))
      .not.toBe(readPostAttempts[0].headers.get('X-PrynX-Signature'));
    expect(readPostAttempts[1].headers.get('X-PrynX-Nonce'))
      .not.toBe(readPostAttempts[0].headers.get('X-PrynX-Nonce'));
    expect(await Promise.all(readPostAttempts.map(request => request.text()))).toEqual([
      '{"path":"D:/sample.pdf","page":1}',
      '{"path":"D:/sample.pdf","page":1}',
    ]);

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
    invokeMock.mockClear();
    const beforeUnsafePost = transport.mock.calls.length;
    transport.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(window.fetch('http://localhost:8321/api/jobs', {
      method: 'POST',
      body: '{}',
    })).rejects.toThrow('Failed to fetch');
    expect(transport).toHaveBeenCalledTimes(beforeUnsafePost + 1);
    expect(signArguments()).toHaveLength(1);

    // Request đã mang body và ReadableStream đều là one-shot. V2 fail-closed
    // trước transport thay vì gửi body không nằm trong chữ ký hoặc giữ toàn bộ RAM.
    const bodyRequest = new Request('http://localhost:8321/api/secure', {
      method: 'POST',
      body: 'one-shot',
    });
    const beforeOneShot = transport.mock.calls.length;
    await expect(window.fetch(bodyRequest)).rejects.toThrow('Request đã mang body one-shot');
    expect(transport).toHaveBeenCalledTimes(beforeOneShot);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const streamInit = {
      method: 'POST',
      body: stream as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' };
    await expect(window.fetch(
      'http://localhost:8321/api/secure',
      streamInit,
    )).rejects.toThrow('Body streaming one-shot chưa được hỗ trợ');
    expect(transport).toHaveBeenCalledTimes(beforeOneShot);
  });
});
