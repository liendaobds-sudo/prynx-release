// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const authStateMock = vi.hoisted(() => ({
  licenseKey: 'LICENSE-KEY',
  licenseToken: 'license-token',
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

import {
  backendResizePages,
  backendShufflePages,
  backendSplitPdf,
  getPdfPathMetadata,
  inspectResizeTransparency,
} from './api';

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

function requestFrom(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}


describe('resize transparency API contract', () => {
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
        }
        : undefined
    ));
    window.__TAURI_INTERNALS__ = {};
    window.__PRYNX_INVOKE__ = invokeMock as typeof window.__PRYNX_INVOKE__;
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

  it('inspects a native PDF by path and returns 1-based transparent pages', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestFrom(input, init);
      expect(request.url).toContain('/api/pdf-tools/resize/inspect-transparency');
      const body = await request.clone().formData();
      expect(body.get('file_path')).toBe('D:\\alpha.pdf');
      expect(body.getAll('file')).toHaveLength(0);
      return new Response(JSON.stringify({
        has_transparency: true,
        transparent_pages: [1, 3],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([], 'alpha.pdf', { type: 'application/pdf' });
    await expect(
      inspectResizeTransparency(file, 'D:\\alpha.pdf'),
    ).resolves.toEqual({
      has_transparency: true,
      transparent_pages: [1, 3],
    });
  });

  it('forwards resize-by-content explicitly to the resize route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestFrom(input, init).clone().formData();
      expect(body.get('file_path')).toBe('D:\\alpha.pdf');
      expect(body.get('page_size_mode')).toBe('fixed_width');
      expect(body.get('resize_by_content')).toBe('true');
      return new Response(new Blob(['pdf'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([], 'alpha.pdf', { type: 'application/pdf' });
    const result = await backendResizePages(
      file,
      50,
      50,
      'fit',
      'all',
      0,
      'auto',
      'white',
      '#ffffff',
      'D:\\alpha.pdf',
      'fixed_width',
      true,
    );

    expect(result.type).toBe('application/pdf');
  });

  it('nhận native output path trên desktop mà không tải lại PDF', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestFrom(input, init).clone().formData();
      expect(body.get('return_path')).toBe('true');
      return new Response(JSON.stringify({
        path: 'D:\\results\\resized.pdf',
        size: 8_900_000,
        timing: { engine_ms: 133 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await backendResizePages(
      new File([], 'large.pdf', { type: 'application/pdf' }),
      210,
      297,
      'fit',
      'all',
      0,
      'xobject',
      'white',
      '#ffffff',
      'D:\\large.pdf',
    ) as Blob & { path?: string; nativeSize?: number };

    expect(result.size).toBe(0);
    expect(result.path).toBe('D:\\results\\resized.pdf');
    expect(result.nativeSize).toBe(8_900_000);
  });

  it('gửi native path cho shuffle mà không đính kèm carrier file', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestFrom(input, init).clone().formData();
      expect(body.get('file_path')).toBe('D:\\large.pdf');
      expect(body.getAll('file')).toHaveLength(0);
      return new Response(new Blob(['result'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(backendShufflePages(new File([], 'large.pdf', {
      type: 'application/pdf',
    }), 'reverse', [], 'D:\\large.pdf')).resolves.toBeInstanceOf(Blob);
  });

  it('giữ loại và tên PDF đơn do backend Split trả về', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await requestFrom(input, init).clone().formData();
      expect(body.get('file_path')).toBe('D:\\large.pdf');
      expect(body.getAll('file')).toHaveLength(0);
      return new Response(new Blob(['result'], { type: 'application/pdf' }), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="large_01_p1-4.pdf"',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(backendSplitPdf(
      new File([], 'large.pdf', { type: 'application/pdf' }),
      'extract_pages',
      { pageList: [1, 2, 3, 4] },
      'D:\\large.pdf',
    )).resolves.toMatchObject({
      kind: 'pdf',
      filename: 'large_01_p1-4.pdf',
      blob: expect.any(Blob),
    });
  });

  it('giữ loại ZIP và giải mã filename UTF-8 của Split nhiều output', async () => {
    const fetchMock = vi.fn(async () => new Response(
      new Blob(['zip'], { type: 'application/zip' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': "attachment; filename*=UTF-8''bo%20tach.zip",
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(backendSplitPdf(
      new File(['pdf'], 'large.pdf', { type: 'application/pdf' }),
      'by_count',
      { pagesPerFile: 4 },
    )).resolves.toMatchObject({
      kind: 'zip',
      filename: 'bo tach.zip',
      blob: expect.any(Blob),
    });
  });

  it('ưu tiên tín hiệu ZIP dù response khai MIME PDF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['zip']), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="split.zip"',
      },
    })));

    await expect(backendSplitPdf(
      new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
      'by_count',
      { pagesPerFile: 1 },
    )).resolves.toMatchObject({ kind: 'zip', filename: 'split.zip' });
  });

  it('ép đuôi filename khớp loại ZIP thực tế', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['zip']), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="result.pdf"',
      },
    })));

    await expect(backendSplitPdf(
      new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
      'by_count',
      { pagesPerFile: 1 },
    )).resolves.toMatchObject({ kind: 'zip', filename: 'result.zip' });
  });

  it('từ chối định dạng mơ hồ thay vì đoán là PDF', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['unknown']), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })));

    await expect(backendSplitPdf(
      new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
      'extract_pages',
      { pageList: [1] },
    )).rejects.toThrow('định dạng không được hỗ trợ');
  });

  it('đọc page-count nhẹ từ native path qua endpoint metadata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = requestFrom(input, init);
      expect(await request.clone().json()).toEqual({
        path: 'D:\\large.pdf',
        summary_only: true,
      });
      return new Response(JSON.stringify({
        page_count: 8,
        pages: [{ width_pt: 1684, height_pt: 2384, rotation: 0 }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPdfPathMetadata('D:\\large.pdf')).resolves.toMatchObject({
      page_count: 8,
      pages: [expect.objectContaining({ width_pt: 1684, height_pt: 2384 })],
    });
  });
});
