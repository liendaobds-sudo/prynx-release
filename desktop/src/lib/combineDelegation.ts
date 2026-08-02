import { fetchLocalFileBuffer } from './localFileTransport';

export const LARGE_COMBINE_BYTES = 64 * 1024 * 1024;
export const LARGE_COMBINE_PAGES = 800;
// PERF (audit 2026-08-01 §B.1): pdf-lib có thể đồng thời giữ RGBA + RGB + alpha,
// nên 64 MP tương đương khoảng 512 MB buffer tạm trước cả finalDoc và bytes kết quả.
export const LARGE_COMBINE_IMAGE_PIXELS = 64_000_000;
// PERF (audit 2026-08-02 §B.2): từ ngưỡng này, native image manifest nhanh hơn
// frontend khoảng 61% trên máy mạnh; đây là chọn engine, không phải hard-cap tài nguyên.
export const NATIVE_COMBINE_IMAGE_CROSSOVER_PIXELS = 64_000_000;
export const IMAGE_HEADER_PROBE_BYTES = 512 * 1024;
const LOW_RAM_COMBINE_IMAGE_PIXELS = 32_000_000;
const IMAGE_WORKING_BYTES_PER_PIXEL = 8;
const IMAGE_AVAILABLE_RAM_FRACTION = 0.25;
const GIB = 1024 * 1024 * 1024;

export type CombineMemoryStatus = {
  totalBytes: number;
  availableBytes: number;
};

export type CombineDelegationNode = {
  type: string;
  file?: { name: string; size: number };
  pageIndex?: number;
  groupId?: string;
  rotation?: number;
};

type DelegationOptions = {
  scaleMode: string;
  groupingEnabled?: boolean;
  requireTopLevel?: boolean;
  allowManifest?: boolean;
  totalImagePixels?: number;
  memoryStatus?: CombineMemoryStatus | null;
};

type ImagePixelSize = {
  width: number;
  height: number;
};

const imagePixelCache = new WeakMap<File, number | null>();

function isValidMemoryByteCount(value: unknown, allowZero: boolean): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && (allowZero ? value >= 0 : value > 0);
}

export async function getCombineMemoryStatus(): Promise<CombineMemoryStatus | null> {
  if (
    typeof window === 'undefined'
    || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  ) {
    return null;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<unknown>('get_system_memory_status');
    if (!raw || typeof raw !== 'object') return null;
    const payload = raw as {
      totalBytes?: unknown;
      availableBytes?: unknown;
      total_bytes?: unknown;
      available_bytes?: unknown;
    };
    const totalBytes = payload.totalBytes ?? payload.total_bytes;
    const availableBytes = payload.availableBytes ?? payload.available_bytes;
    if (
      !isValidMemoryByteCount(totalBytes, false)
      || !isValidMemoryByteCount(availableBytes, true)
      || availableBytes > totalBytes
    ) {
      return null;
    }
    return { totalBytes, availableBytes };
  } catch {
    return null;
  }
}

function isImageSourceName(name: string): boolean {
  const lowerName = (name || '').toLowerCase();
  return lowerName.endsWith('.png')
    || lowerName.endsWith('.jpg')
    || lowerName.endsWith('.jpeg');
}

export function isBackendManifestSourceName(name: string): boolean {
  const lowerName = (name || '').toLowerCase();
  return lowerName.endsWith('.pdf') || isImageSourceName(lowerName);
}

function readPngPixelSize(bytes: Uint8Array): ImagePixelSize | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 24 || !signature.every((value, index) => bytes[index] === value)) {
    return null;
  }
  if (
    bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52
  ) {
    return null;
  }
  const width = (
    bytes[16] * 0x1000000
    + bytes[17] * 0x10000
    + bytes[18] * 0x100
    + bytes[19]
  );
  const height = (
    bytes[20] * 0x1000000
    + bytes[21] * 0x10000
    + bytes[22] * 0x100
    + bytes[23]
  );
  return width > 0 && height > 0 ? { width, height } : null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function readJpegPixelSize(bytes: Uint8Array): ImagePixelSize | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.byteLength) return null;

    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) return null;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 6 >= bytes.byteLength) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

export function readImagePixelSize(
  input: ArrayBuffer | Uint8Array,
  fileName: string,
): ImagePixelSize | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const lowerName = (fileName || '').toLowerCase();
  if (lowerName.endsWith('.png')) return readPngPixelSize(bytes);
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return readJpegPixelSize(bytes);
  }
  return null;
}

async function probeImagePixelCount(file: File): Promise<number | null> {
  const cached = imagePixelCache.get(file);
  if (cached !== undefined) return cached;

  try {
    const localPath = (file as File & { path?: string }).path;
    const buffer = localPath
      ? await fetchLocalFileBuffer(localPath, { start: 0, endExclusive: IMAGE_HEADER_PROBE_BYTES })
      : await file.slice(0, IMAGE_HEADER_PROBE_BYTES).arrayBuffer();
    const size = readImagePixelSize(buffer, file.name);
    const rawPixels = size ? size.width * size.height : 0;
    const pixels = size
      ? (Number.isSafeInteger(rawPixels) ? rawPixels : Number.MAX_SAFE_INTEGER)
      : null;
    imagePixelCache.set(file, pixels);
    return pixels;
  } catch {
    imagePixelCache.set(file, null);
    return null;
  }
}

export async function estimateCombineImagePixels(
  nodes: CombineDelegationNode[],
): Promise<number> {
  let total = 0;
  for (const node of nodes) {
    const file = node.file;
    if (!file || !isImageSourceName(file.name) || !(file instanceof File)) continue;
    const pixels = await probeImagePixelCount(file);
    if (pixels === null) return Number.MAX_SAFE_INTEGER;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + pixels);
  }
  return total;
}

function safeFileSize(file: { size: number }): number {
  return Number.isFinite(file.size) && file.size > 0 ? file.size : 0;
}

function estimatedImageWorkingBytes(totalImagePixels: number, encodedBytes: number): number {
  const decodedBytes = totalImagePixels >= Number.MAX_SAFE_INTEGER / IMAGE_WORKING_BYTES_PER_PIXEL
    ? Number.MAX_SAFE_INTEGER
    : totalImagePixels * IMAGE_WORKING_BYTES_PER_PIXEL;
  return Math.min(Number.MAX_SAFE_INTEGER, decodedBytes + encodedBytes);
}

function shouldDelegateImageWorkload(
  totalImagePixels: number,
  encodedBytes: number,
  memoryStatus: CombineMemoryStatus | null | undefined,
): boolean {
  if (totalImagePixels <= 0 && encodedBytes <= 0) return false;

  // PERF (audit 2026-08-02 §B.1): chỉ giảm tải WebView theo RAM thật. Máy
  // >=16 GB không có hard pixel-cap; mọi tier vẫn tránh dùng quá 25% RAM còn trống.
  if (!memoryStatus) return totalImagePixels >= LARGE_COMBINE_IMAGE_PIXELS;

  const hardPixelThreshold = memoryStatus.totalBytes < 8 * GIB
    ? LOW_RAM_COMBINE_IMAGE_PIXELS
    : memoryStatus.totalBytes < 16 * GIB
      ? LARGE_COMBINE_IMAGE_PIXELS
      : null;
  if (hardPixelThreshold !== null && totalImagePixels >= hardPixelThreshold) return true;

  const availableBudget = memoryStatus.availableBytes * IMAGE_AVAILABLE_RAM_FRACTION;
  return estimatedImageWorkingBytes(totalImagePixels, encodedBytes) >= availableBudget;
}

export function shouldDelegateLargePdfJob(
  nodes: CombineDelegationNode[],
  pageCounts: Record<string, number>,
  options: DelegationOptions,
): boolean {
  if (options.scaleMode !== 'keep' || options.groupingEnabled) return false;
  if (!options.allowManifest && nodes.length < 2) return false;

  const eligible = nodes.every(node => {
    if (options.allowManifest) {
      return node.type === 'blank' || (
        node.type === 'single'
        && !!node.file
        && isBackendManifestSourceName(node.file.name)
      );
    }
    return node.type === 'single'
      && node.pageIndex === undefined
      && (!options.requireTopLevel || !node.groupId)
      && !!node.file
      && node.file.name.toLowerCase().endsWith('.pdf')
      && (node.rotation || 0) === 0;
  });
  if (!eligible || !nodes.some(node => !!node.file)) return false;

  const uniquePdfSources = new Set<object>();
  let totalPdfBytes = 0;
  let totalEncodedImageBytes = 0;
  for (const node of nodes) {
    const file = node.file;
    if (!file) continue;
    if (isImageSourceName(file.name)) {
      totalEncodedImageBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        totalEncodedImageBytes + safeFileSize(file),
      );
    } else if (file.name.toLowerCase().endsWith('.pdf') && !uniquePdfSources.has(file)) {
      uniquePdfSources.add(file);
      totalPdfBytes = Math.min(Number.MAX_SAFE_INTEGER, totalPdfBytes + safeFileSize(file));
    }
  }
  const estimatedPages = nodes.reduce((sum, node) => {
    if (!node.file) return sum + 1;
    const file = node.file;
    if (isImageSourceName(file.name)) return sum + 1;
    return sum + (pageCounts[file.name + '-' + file.size]
      ?? Math.max(1, Math.ceil(file.size / 5000)));
  }, 0);

  const rawImagePixels = options.totalImagePixels ?? 0;
  const totalImagePixels = Number.isFinite(rawImagePixels) && rawImagePixels >= 0
    ? rawImagePixels
    : Number.MAX_SAFE_INTEGER;

  const nativeImageOnlyManifest = options.allowManifest === true
    && nodes.every(node => node.type === 'blank' || (
      node.type === 'single'
      && !!node.file
      && isImageSourceName(node.file.name)
    ))
    && nodes.some(node => !!node.file && isImageSourceName(node.file.name));

  return totalPdfBytes >= LARGE_COMBINE_BYTES
    || estimatedPages >= LARGE_COMBINE_PAGES
    || (
      nativeImageOnlyManifest
      && totalImagePixels >= NATIVE_COMBINE_IMAGE_CROSSOVER_PIXELS
    )
    || shouldDelegateImageWorkload(
      totalImagePixels,
      totalEncodedImageBytes,
      options.memoryStatus,
    );
}
