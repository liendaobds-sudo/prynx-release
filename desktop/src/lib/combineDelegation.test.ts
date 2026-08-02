import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { fetchLocalFileBuffer } from './localFileTransport';
import {
  estimateCombineImagePixels,
  getCombineMemoryStatus,
  IMAGE_HEADER_PROBE_BYTES,
  isBackendManifestSourceName,
  LARGE_COMBINE_BYTES,
  LARGE_COMBINE_IMAGE_PIXELS,
  LARGE_COMBINE_PAGES,
  NATIVE_COMBINE_IMAGE_CROSSOVER_PIXELS,
  readImagePixelSize,
  shouldDelegateLargePdfJob,
} from './combineDelegation';

vi.mock('./localFileTransport', () => ({
  fetchLocalFileBuffer: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const mockedFetchLocalFileBuffer = vi.mocked(fetchLocalFileBuffer);
const mockedInvoke = vi.mocked(invoke);
type TauriWindowStub = Window & { __TAURI_INTERNALS__?: Record<string, never> };
const testGlobal = globalThis as unknown as { window?: TauriWindowStub };

function installTauriWindow(): void {
  Object.defineProperty(testGlobal, 'window', {
    configurable: true,
    writable: true,
    value: { __TAURI_INTERNALS__: {} } as TauriWindowStub,
  });
}
const GIB = 1024 * 1024 * 1024;

beforeEach(() => {
  mockedFetchLocalFileBuffer.mockReset();
  mockedInvoke.mockReset();
  delete testGlobal.window;
});

const sourceNode = (name: string, size: number, extra = {}) => ({
  type: 'single',
  file: { name, size },
  rotation: 0,
  ...extra,
});

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function jpegHeader(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, sofMarker, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
  ]);
}

describe('image header workload probe', () => {

  it('reads PNG IHDR and JPEG baseline/progressive SOF dimensions', () => {
    expect(readImagePixelSize(pngHeader(6000, 4000), 'art.PNG')).toEqual({ width: 6000, height: 4000 });
    expect(readImagePixelSize(jpegHeader(3000, 2000), 'photo.jpg')).toEqual({ width: 3000, height: 2000 });
    expect(readImagePixelSize(jpegHeader(2400, 3600, 0xc2), 'photo.JPEG')).toEqual({ width: 2400, height: 3600 });
  });

  it('returns null for a truncated or unsupported header', () => {
    expect(readImagePixelSize(new Uint8Array([0x89, 0x50]), 'broken.png')).toBeNull();
    expect(readImagePixelSize(new Uint8Array([0xff, 0xd8, 0xff]), 'broken.jpg')).toBeNull();
    expect(readImagePixelSize(pngHeader(10, 10), 'image.webp')).toBeNull();
  });

  it('reads only a bounded Range for path-backed files', async () => {
    mockedFetchLocalFileBuffer.mockResolvedValue(pngHeader(8000, 8000).buffer as ArrayBuffer);
    const file = new File([], 'large.png', { type: 'image/png' });
    Object.defineProperty(file, 'path', { value: 'D:\\art\\large.png' });

    await expect(estimateCombineImagePixels([{ type: 'single', file }])).resolves.toBe(64_000_000);
    expect(mockedFetchLocalFileBuffer).toHaveBeenCalledWith(
      'D:\\art\\large.png',
      { start: 0, endExclusive: IMAGE_HEADER_PROBE_BYTES },
    );
  });

  it('fails safe when an image header cannot be read', async () => {
    const file = new File(
      [new Uint8Array([0x89, 0x50]) as unknown as BlobPart],
      'broken.png',
      { type: 'image/png' },
    );

    await expect(estimateCombineImagePixels([{ type: 'single', file }]))
      .resolves.toBe(Number.MAX_SAFE_INTEGER);
    expect(shouldDelegateLargePdfJob([{ type: 'single', file }], {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: Number.MAX_SAFE_INTEGER,
      memoryStatus: { totalBytes: 32 * GIB, availableBytes: 13 * GIB },
    })).toBe(true);
  });
});

describe('getCombineMemoryStatus', () => {
  it('does not invoke Tauri outside the desktop runtime', async () => {
    await expect(getCombineMemoryStatus()).resolves.toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('returns validated memory bytes from Tauri', async () => {
    installTauriWindow();
    mockedInvoke.mockResolvedValue({ totalBytes: 32 * GIB, availableBytes: 13 * GIB });

    await expect(getCombineMemoryStatus()).resolves.toEqual({
      totalBytes: 32 * GIB,
      availableBytes: 13 * GIB,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('get_system_memory_status');
  });

  it.each([
    null,
    { totalBytes: '32 GB', availableBytes: 13 * GIB },
    { totalBytes: 32 * GIB, availableBytes: -1 },
    { totalBytes: 8 * GIB, availableBytes: 9 * GIB },
  ])('returns null for an invalid payload: %j', async (payload) => {
    installTauriWindow();
    mockedInvoke.mockResolvedValue(payload);

    await expect(getCombineMemoryStatus()).resolves.toBeNull();
  });

  it('returns null when the Tauri command is unavailable', async () => {
    installTauriWindow();
    mockedInvoke.mockRejectedValue(new Error('command not found'));

    await expect(getCombineMemoryStatus()).resolves.toBeNull();
  });
});

describe('shouldDelegateLargePdfJob', () => {
  it('delegates a simple PDF job at the byte threshold', () => {
    const sourceSize = LARGE_COMBINE_BYTES / 2;
    const nodes = [sourceNode('a.pdf', sourceSize), sourceNode('b.pdf', sourceSize)];
    const counts = {
      ['a.pdf-' + sourceSize]: 1,
      ['b.pdf-' + sourceSize]: 1,
    };
    expect(shouldDelegateLargePdfJob(nodes, counts, { scaleMode: 'keep' })).toBe(true);
  });

  it('counts repeated pages from one PDF source only once for the byte threshold', () => {
    const file = { name: 'same.pdf', size: LARGE_COMBINE_BYTES / 2 };
    const nodes = [
      { type: 'single', file, pageIndex: 0, rotation: 0 },
      { type: 'single', file, pageIndex: 1, rotation: 0 },
    ];

    expect(shouldDelegateLargePdfJob(nodes, {
      [file.name + '-' + file.size]: 2,
    }, { scaleMode: 'keep', allowManifest: true })).toBe(false);
  });

  it('delegates a simple PDF job at the page threshold', () => {
    const nodes = [sourceNode('a.pdf', 1), sourceNode('b.pdf', 1)];
    const counts = { 'a.pdf-1': LARGE_COMBINE_PAGES - 1, 'b.pdf-1': 1 };
    expect(shouldDelegateLargePdfJob(nodes, counts, { scaleMode: 'keep' })).toBe(true);
  });

  it('keeps a small mixed PDF + PNG job on the fast frontend path', () => {
    const nodes = [sourceNode('a.pdf', 1), sourceNode('b.png', 4 * 1024 * 1024)];
    expect(shouldDelegateLargePdfJob(nodes, { 'a.pdf-1': 1 }, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 2_000_000,
    })).toBe(false);
  });

  it('delegates image jobs at the decoded-pixel fallback threshold', () => {
    const node = sourceNode('large.png', 1024);
    expect(shouldDelegateLargePdfJob([node], {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: LARGE_COMBINE_IMAGE_PIXELS,
    })).toBe(true);
  });

  it('delegates image-only work above the native crossover on a strong machine', () => {
    const node = sourceNode('large.png', 20 * 1024 * 1024);
    expect(shouldDelegateLargePdfJob([node], {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 72_000_000,
      memoryStatus: { totalBytes: 32 * GIB, availableBytes: 13 * GIB },
    })).toBe(true);
  });

  it('delegates the reported eight 3000×3000 PNG files to the faster native path', () => {
    const encodedSizes = [
      11_724_914, 5_941_960, 688_925, 4_086_870,
      1_970_255, 5_812_316, 5_267_451, 3_190_477,
    ];
    const nodes = encodedSizes.map((size, index) => sourceNode(`mockup-${index}.png`, size));

    expect(encodedSizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(LARGE_COMBINE_BYTES);
    expect(shouldDelegateLargePdfJob(nodes, {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 8 * 3000 * 3000,
      memoryStatus: { totalBytes: 32 * GIB, availableBytes: 13 * GIB },
    })).toBe(true);
  });

  it('does not apply the native image crossover to a mixed PDF and image manifest', () => {
    const nodes = [sourceNode('a.pdf', 1), sourceNode('large.png', 20 * 1024 * 1024)];
    expect(shouldDelegateLargePdfJob(nodes, { 'a.pdf-1': 1 }, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: NATIVE_COMBINE_IMAGE_CROSSOVER_PIXELS,
      memoryStatus: { totalBytes: 32 * GIB, availableBytes: 13 * GIB },
    })).toBe(false);
  });

  it.each([
    { totalBytes: 6 * GIB, availableBytes: 5 * GIB },
    { totalBytes: 12 * GIB, availableBytes: 10 * GIB },
  ])('delegates 72 MP on a lower-memory machine: %j', (memoryStatus) => {
    const node = sourceNode('large.png', 20 * 1024 * 1024);
    expect(shouldDelegateLargePdfJob([node], {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 72_000_000,
      memoryStatus,
    })).toBe(true);
  });

  it('keeps an encoded image over 64 MiB on the frontend when pixels and RAM are safe', () => {
    const node = sourceNode('dense.png', 80 * 1024 * 1024);
    expect(shouldDelegateLargePdfJob([node], {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 4_000_000,
      memoryStatus: { totalBytes: 32 * GIB, availableBytes: 13 * GIB },
    })).toBe(false);
  });

  it('delegates when image work would consume at least 25% of available RAM', () => {
    const node = sourceNode('memory-pressure.png', 8 * 1024 * 1024);
    expect(shouldDelegateLargePdfJob([node], {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 10_000_000,
      memoryStatus: { totalBytes: 32 * GIB, availableBytes: 256 * 1024 * 1024 },
    })).toBe(true);
  });

  it('counts an encoded image as one page instead of using the PDF byte heuristic', () => {
    const nodes = [sourceNode('image.png', 4 * 1024 * 1024), { type: 'blank' }];
    expect(shouldDelegateLargePdfJob(nodes, {}, {
      scaleMode: 'keep',
      allowManifest: true,
      totalImagePixels: 1_000_000,
    })).toBe(false);
  });

  it('keeps image jobs out of the PDF-only interleave endpoint', () => {
    const nodes = [sourceNode('a.pdf', 1), sourceNode('b.png', LARGE_COMBINE_BYTES)];
    expect(shouldDelegateLargePdfJob(nodes, {}, {
      scaleMode: 'keep',
      totalImagePixels: LARGE_COMBINE_IMAGE_PIXELS,
    })).toBe(false);
  });

  it.each([
    { nodes: [sourceNode('a.pdf', LARGE_COMBINE_BYTES), sourceNode('b.pdf', 1, { rotation: 90 })], options: { scaleMode: 'keep' } },
    { nodes: [sourceNode('a.pdf', LARGE_COMBINE_BYTES), sourceNode('b.pdf', 1, { pageIndex: 0 })], options: { scaleMode: 'keep' } },
    { nodes: [sourceNode('a.pdf', LARGE_COMBINE_BYTES), sourceNode('b.pdf', 1)], options: { scaleMode: 'fit_a4' } },
    { nodes: [sourceNode('a.pdf', LARGE_COMBINE_BYTES), sourceNode('b.pdf', 1)], options: { scaleMode: 'keep', groupingEnabled: true } },
  ])('keeps transformed or grouped jobs in the frontend path', ({ nodes, options }) => {
    expect(shouldDelegateLargePdfJob(nodes, {}, options)).toBe(false);
  });

  it('delegates transformed PDF nodes through the manifest path', () => {
    const nodes = [
      sourceNode('a.pdf', LARGE_COMBINE_BYTES, { pageIndex: 2, rotation: 90 }),
      { type: 'blank', rotation: 0 },
    ];
    expect(shouldDelegateLargePdfJob(nodes, {}, { scaleMode: 'keep', allowManifest: true })).toBe(true);
  });

  it('shares the backend source whitelist with manifest assembly', () => {
    expect(isBackendManifestSourceName('A.PDF')).toBe(true);
    expect(isBackendManifestSourceName('B.PNG')).toBe(true);
    expect(isBackendManifestSourceName('C.JpEg')).toBe(true);
    expect(isBackendManifestSourceName('D.webp')).toBe(false);
    expect(isBackendManifestSourceName('E.tiff')).toBe(false);
    expect(isBackendManifestSourceName('notpng')).toBe(false);
  });
});
