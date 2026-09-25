// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: transport.invoke }));
vi.mock('../../lib/api', () => ({ authenticatedFetch: vi.fn(), getApiUrl: () => 'http://localhost:8321/api' }));
import { useTileRenderer } from './useTileRenderer';
import type { TileUrlSource } from '../../lib/tileUrlCache';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('AUDIT: lỗi createImageBitmap trên PXRG phải báo lỗi hoặc fallback raster thật, không cache GIF trắng', async () => {
  const bytes = new ArrayBuffer(16 + 2 * 2 * 4);
  new Uint8Array(bytes).set([0x50, 0x58, 0x52, 0x47]);
  const header = new DataView(bytes);
  header.setUint32(4, 2, true);
  header.setUint32(8, 2, true);
  new Uint8Array(bytes, 16).fill(255);
  transport.invoke.mockImplementation(async (command: string) => command === 'render_pdf_page' ? bytes : true);
  vi.stubGlobal('ImageData', class { constructor(..._args: unknown[]) {} });
  const decoder = vi.fn(async () => { throw new Error('decode allocation failed'); });
  vi.stubGlobal('createImageBitmap', decoder);
  const { result } = renderHook(() => useTileRenderer({
    file: { path: 'D:\\audit\\pxrg.pdf', name: 'pxrg.pdf', type: 'application/pdf' },
    pdfRef: null, pdfUrl: 'localfile://audit-pxrg', activePage: 1, isActive: true,
  }));
  let source: TileUrlSource | undefined;
  await act(async () => { source = await result.current.getTileUrl(1, 0, 1); });
  expect(decoder).toHaveBeenCalledTimes(1);
  expect(source?.cacheable).toBe(true);
  expect(source?.bitmap).toBeUndefined();
  expect(source?.url).not.toMatch(/^data:image\/gif/);
});
