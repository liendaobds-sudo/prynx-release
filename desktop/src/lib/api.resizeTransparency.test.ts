// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendResizePages, inspectResizeTransparency } from './api';


describe('resize transparency API contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('inspects a native PDF by path and returns 1-based transparent pages', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/pdf-tools/resize/inspect-transparency');
      const body = init?.body as FormData;
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
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
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
});
