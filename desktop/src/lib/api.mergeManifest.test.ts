// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendMergeManifest } from './api';

describe('backendMergeManifest native transport', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__PRYNX_INVOKE__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps native PDF inputs and the result out of WebView blobs', async () => {
    window.__TAURI_INTERNALS__ = {};
    window.__PRYNX_INVOKE__ = vi.fn(async () => ({})) as unknown as NonNullable<typeof window.__PRYNX_INVOKE__>;
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

    const file = new File([], 'one.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'path', { value: 'C:\\docs\\one.pdf' });

    await expect(backendMergeManifest([file], [{ file_index: 0 }])).resolves.toEqual({
      path: 'C:\\results\\combined.pdf',
      filename: 'Combined.pdf',
    });
  });
});
