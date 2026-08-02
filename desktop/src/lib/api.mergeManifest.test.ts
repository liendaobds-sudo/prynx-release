// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backendMergeManifest,
  backendMergeManifestJob,
  backendMergePdfs,
  backendMergePdfsJob,
} from './api';

function enableTauriRuntime() {
  window.__TAURI_INTERNALS__ = {};
  window.__PRYNX_INVOKE__ = vi.fn(async () => ({})) as unknown as NonNullable<
    typeof window.__PRYNX_INVOKE__
  >;
}

function pathStub(name: string, path: string, spoofedSize = 10_000): File {
  const file = new File([], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'path', { value: path });
  Object.defineProperty(file, 'size', { value: spoofedSize });
  return file;
}

function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

describe('backend merge native transport', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__PRYNX_INVOKE__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps native manifest inputs and the result out of WebView blobs', async () => {
    enableTauriRuntime();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      expect(body.get('file_paths')).toBe(JSON.stringify(['C:\\docs\\one.pdf']));
      expect(body.get('return_path')).toBe('true');
      expect(body.getAll('files')).toHaveLength(0);
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ path: 'C:\\results\\combined.pdf', filename: 'Combined.pdf' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = pathStub('one.pdf', 'C:\\docs\\one.pdf');

    await expect(backendMergeManifest([file], [{ file_index: 0 }])).resolves.toEqual({
      path: 'C:\\results\\combined.pdf',
      filename: 'Combined.pdf',
    });
  });

  it('reports job progress and returns the native result path in Tauri', async () => {
    enableTauriRuntime();
    const onProgress = vi.fn();
    let statusRequestCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs') && init?.method === 'POST') {
        const body = init.body as FormData;
        expect(body.get('source_paths')).toBe(JSON.stringify(['C:\\docs\\one.pdf']));
        expect(body.get('return_path')).toBe('true');
        expect(body.getAll('files')).toHaveLength(0);
        return new Response(JSON.stringify({ job_id: 'combine-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/combine-1/result')) {
        return new Response(JSON.stringify({
          path: 'C:\\results\\combined.pdf',
          filename: 'Combined.pdf',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/combine-1')) {
        statusRequestCount += 1;
        return new Response(JSON.stringify(statusRequestCount === 1 ? {
          job_id: 'combine-1',
          status: 'running',
          terminal: false,
          cancel_requested: false,
          progress: 0.5,
          completed: 1,
          total: 2,
          message: 'Đang ghép PDF.',
        } : {
          job_id: 'combine-1',
          status: 'completed',
          terminal: true,
          cancel_requested: false,
          progress: 1,
          completed: 2,
          total: 2,
          message: 'Đã ghép PDF.',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = pathStub('one.pdf', 'C:\\docs\\one.pdf');
    await expect(backendMergeManifestJob(
      [file],
      [{ file_index: 0 }],
      { onProgress, pollIntervalMs: 0 },
    )).resolves.toEqual({
      path: 'C:\\results\\combined.pdf',
      filename: 'Combined.pdf',
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ progress: 0.5 }));
    expect(onProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'completed',
      progress: 1,
    }));
  });

  it('keeps mixed source order and uploads only in-memory files', async () => {
    enableTauriRuntime();
    const nativeFile = pathStub('native.pdf', 'D:\\native\\native.pdf');
    const memoryFile = new File(['memory-pdf'], 'memory.pdf', { type: 'application/pdf' });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs') && init?.method === 'POST') {
        const body = init.body as FormData;
        expect(body.get('source_paths')).toBe(JSON.stringify(['D:\\native\\native.pdf', null]));
        expect(body.get('return_path')).toBe('true');
        const uploads = body.getAll('files') as File[];
        expect(uploads).toHaveLength(1);
        expect(uploads[0].name).toBe('memory.pdf');
        expect(uploads[0].size).toBe(memoryFile.size);
        return new Response(JSON.stringify({ job_id: 'combine-mixed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/combine-mixed/result')) {
        return new Response(JSON.stringify({ path: 'D:\\results\\mixed.pdf' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/combine-mixed')) {
        return new Response(JSON.stringify({
          job_id: 'combine-mixed',
          status: 'completed',
          terminal: true,
          cancel_requested: false,
          progress: 1,
          completed: 2,
          total: 2,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(backendMergeManifestJob(
      [nativeFile, memoryFile],
      [{ file_index: 0 }, { file_index: 1 }],
      { pollIntervalMs: 0 },
    )).resolves.toEqual({ path: 'D:\\results\\mixed.pdf', filename: 'Combined.pdf' });

    expect(fetchMock.mock.calls.every(([url]) => (
      !String(url).startsWith('http://localfile.localhost/')
    ))).toBe(true);
  });

  it('sends one cancellation request and rejects with AbortError', async () => {
    enableTauriRuntime();
    const controller = new AbortController();
    let releaseStatus!: (response: Response) => void;
    const statusResponse = new Promise<Response>((resolve) => { releaseStatus = resolve; });
    let markStatusRequested!: () => void;
    const statusRequested = new Promise<void>((resolve) => { markStatusRequested = resolve; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ job_id: 'combine-cancel' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/combine-cancel/cancel')) {
        return new Response(JSON.stringify({ status: 'cancelling' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/combine-cancel')) {
        markStatusRequested();
        return statusResponse;
      }
      throw new Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const operation = backendMergeManifestJob(
      [pathStub('one.pdf', 'C:\\docs\\one.pdf')],
      [{ file_index: 0 }],
      { signal: controller.signal, pollIntervalMs: 0 },
    );
    await statusRequested;
    controller.abort();
    releaseStatus(new Response(JSON.stringify({
      job_id: 'combine-cancel',
      status: 'running',
      terminal: false,
      cancel_requested: true,
      progress: 0.25,
      completed: 0,
      total: 1,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => (
        String(url).endsWith('/api/pdf-tools/merge-manifest/jobs/combine-cancel/cancel')
      ))).toHaveLength(1);
    });
  });

  it('starts legacy Interleave through the same zero-copy job lifecycle', async () => {
    enableTauriRuntime();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs') && init?.method === 'POST') {
        const body = init.body as FormData;
        expect(body.get('mode')).toBe('interleave');
        expect(body.get('manifest')).toBeNull();
        expect(body.get('source_paths')).toBe(JSON.stringify([
          'D:\\odd.pdf',
          'D:\\even.pdf',
        ]));
        expect(body.getAll('files')).toHaveLength(0);
        return new Response(JSON.stringify({ job_id: 'legacy-interleave' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/legacy-interleave')) {
        return new Response(JSON.stringify({
          job_id: 'legacy-interleave',
          status: 'completed',
          terminal: true,
          cancel_requested: false,
          progress: 100,
          completed: 4,
          total: 4,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/pdf-tools/merge-manifest/jobs/legacy-interleave/result')) {
        return new Response(JSON.stringify({ path: 'D:\\result.pdf' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(backendMergePdfsJob([
      pathStub('odd.pdf', 'D:\\odd.pdf'),
      pathStub('even.pdf', 'D:\\even.pdf'),
    ], 'interleave', { pollIntervalMs: 0 })).resolves.toEqual({
      path: 'D:\\result.pdf',
      filename: 'Combined.pdf',
    });
  });
  it('materializes a spoofed-size path-stub before legacy Merge/Interleave upload', async () => {
    enableTauriRuntime();
    const diskBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const uploads: File[] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://localfile.localhost/')) {
        return new Response(diskBytes, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }

      const body = init?.body as FormData;
      uploads.push(body.get('files') as File);
      expect(body.getAll('files')).toHaveLength(1);
      expect(body.get('mode')).toBe('interleave');
      return new Response(new Blob(['merged'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = pathStub('nguon.pdf', 'D:\\viec\\nguon.pdf', 500_000_000);
    await backendMergePdfs([file], 'interleave');

    expect(uploads).toHaveLength(1);
    const [uploaded] = uploads;
    expect(uploaded.name).toBe('nguon.pdf');
    expect(uploaded.size).toBe(diskBytes.byteLength);
    await expect(readBlobBytes(uploaded)).resolves.toEqual(diskBytes.buffer);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/pdf-tools/merge'))).toBe(true);
  });

  it('does not call merge backend when the native path cannot be materialized', async () => {
    enableTauriRuntime();
    let backendCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('http://localfile.localhost/')) {
        return new Response('offline', { status: 403 });
      }
      backendCalls += 1;
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = pathStub('mat-ket-noi.pdf', '\\\\server\\share\\mat-ket-noi.pdf');
    await expect(backendMergePdfs([file])).rejects.toThrow(/Không đọc được file gốc/);
    expect(backendCalls).toBe(0);
  });
});
