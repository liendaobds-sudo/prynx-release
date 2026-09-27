import { previewPerfLog } from './previewPerfLog';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface TileUrlSource {
  url: string;
  bitmap?: ImageBitmap;
  width?: number;
  height?: number;
  byteLength: number;
  /** False khi ảnh chỉ là fallback tạm; không giữ dưới cache key của pipeline khác. */
  cacheable?: boolean;
  /** COLOR (audit 2026-09-27 §V27.04): nguồn pixel thật, không suy từ slot yêu cầu. */
  proof?: Readonly<TilePixelProof>;
  /** Thời gian giải mã bitmap (ms) từ mảng bytes thô / PXRG / PNG. */
  decodeMs?: number;
}

export interface TilePixelProof {
  engine: 'ppe-native' | 'ppe-http' | 'pdfium' | 'pdfjs';
  soundness: 'color-verified' | 'display-preview';
  documentToken: string;
  page: number;
  profileId: string | null;
  intent: string | null;
  proofIdentity: string;
  pipelineIdentity: string;
}

export function tileHasMatchingProof(source: TileUrlSource, expected: Pick<TilePixelProof, 'documentToken' | 'page' | 'profileId' | 'intent' | 'proofIdentity'>): boolean {
  const proof = source.proof;
  return !!proof && (proof.engine === 'ppe-native' || proof.engine === 'ppe-http')
    && proof.soundness === 'color-verified'
    && proof.documentToken === expected.documentToken && proof.page === expected.page
    && proof.profileId === expected.profileId && proof.intent === expected.intent
    && proof.proofIdentity === expected.proofIdentity;
}

type TileUrlCacheEntry = TileUrlSource & { namespace: string };

function closeBitmap(bitmap?: ImageBitmap): void {
  if (bitmap && typeof bitmap.close === 'function') {
    try {
      bitmap.close();
    } catch {
      // ignore
    }
  }
}

export function tileUrlCacheNamespaceForFileKey(fileKey: string): string {
  // PERF (audit 2026-08-08 §RENDER.5): revision/color chỉ phân biệt bitmap;
  // owner sống theo tài liệu nguồn để clearUnowned/release dọn đúng toàn bộ revision.
  const revisionMarker = fileKey.indexOf('|revision:');
  const colorMarker = fileKey.indexOf('|color:');
  const markerPositions = [revisionMarker, colorMarker].filter(position => position >= 0);
  const namespaceEnd = markerPositions.length > 0
    ? Math.min(...markerPositions)
    : fileKey.length;
  return fileKey.slice(0, namespaceEnd);
}

export function tileUrlCacheBudgetForTotalRam(totalBytes: number | null): number | null {
  if (totalBytes === null || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  if (totalBytes < 8 * GIB) return 32 * MIB;
  if (totalBytes < 16 * GIB) return 64 * MIB;
  // PERF (audit 2026-08-05 §PERF.7): máy >=16 GB giữ full cache; máy không
  // đọc được RAM cũng không bị áp cap bảo thủ làm cuộn ngược chậm đi.
  return null;
}

export class TileUrlLruCache {
  private readonly entries = new Map<string, TileUrlCacheEntry>();
  private readonly ownerNamespaces = new Map<string, string>();
  private readonly namespaceOwners = new Map<string, Set<string>>();
  private _currentBytes = 0;

  constructor(
    private maxBytes: number | null,
    private readonly revokeUrl: (url: string) => void,
  ) {}

  get currentBytes(): number {
    return this._currentBytes;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.url;
  }

  getSource(key: string): TileUrlSource | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(
    key: string,
    sourceOrUrl: string | TileUrlSource,
    byteLength?: number,
    namespace = key,
  ): boolean {
    let url: string;
    let safeBytes: number;
    let bitmap: ImageBitmap | undefined;
    let width: number | undefined;
    let height: number | undefined;
    let cacheable: boolean | undefined;
    let proof: Readonly<TilePixelProof> | undefined;

    if (typeof sourceOrUrl === 'string') {
      url = sourceOrUrl;
      safeBytes = Number.isSafeInteger(byteLength) && (byteLength ?? 0) >= 0 ? (byteLength ?? 0) : 0;
    } else {
      url = sourceOrUrl.url;
      safeBytes = Number.isSafeInteger(sourceOrUrl.byteLength) && sourceOrUrl.byteLength >= 0
        ? sourceOrUrl.byteLength
        : 0;
      bitmap = sourceOrUrl.bitmap;
      width = sourceOrUrl.width;
      height = sourceOrUrl.height;
      cacheable = sourceOrUrl.cacheable;
      proof = sourceOrUrl.proof ? Object.freeze({ ...sourceOrUrl.proof }) : undefined;
    }

    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this._currentBytes = Math.max(0, this._currentBytes - previous.byteLength);
      if (previous.url !== url) this.revokeIfUnused(previous.url);
      if (previous.bitmap && previous.bitmap !== bitmap) {
        closeBitmap(previous.bitmap);
      }
    }

    if (this.maxBytes !== null && safeBytes > this.maxBytes) return false;
    this.evictUntilFits(safeBytes);
    this.entries.set(key, { url, bitmap, width, height, byteLength: safeBytes, cacheable, proof, namespace });
    this._currentBytes += safeBytes;
    return true;
  }

  setMaxBytes(maxBytes: number | null): void {
    this.maxBytes = maxBytes;
    this.evictUntilFits(0);
  }

  hasUrl(url: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.url === url) return true;
    }
    return false;
  }

  clear(): void {
    const urls = new Set(Array.from(this.entries.values(), entry => entry.url));
    for (const entry of this.entries.values()) {
      closeBitmap(entry.bitmap);
    }
    this.entries.clear();
    this._currentBytes = 0;
    for (const url of urls) this.revokeUrl(url);
  }

  clearPrefix(prefix: string): void {
    const removedUrls = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this._currentBytes = Math.max(0, this._currentBytes - entry.byteLength);
      closeBitmap(entry.bitmap);
      removedUrls.add(entry.url);
    }
    for (const url of removedUrls) this.revokeIfUnused(url);
  }

  clearNamespace(namespace: string): void {
    if (!namespace) return;
    this.removeWhere(entry => entry.namespace === namespace);
  }

  claimOwner(ownerId: string, namespace: string): void {
    if (!ownerId || !namespace) return;
    const currentNamespace = this.ownerNamespaces.get(ownerId);
    if (currentNamespace === namespace) return;
    if (currentNamespace) this.releaseOwner(ownerId);

    this.ownerNamespaces.set(ownerId, namespace);
    const owners = this.namespaceOwners.get(namespace) ?? new Set<string>();
    owners.add(ownerId);
    this.namespaceOwners.set(namespace, owners);
  }

  releaseOwner(ownerId: string): void {
    const namespace = this.ownerNamespaces.get(ownerId);
    if (!namespace) return;
    this.ownerNamespaces.delete(ownerId);
    const owners = this.namespaceOwners.get(namespace);
    owners?.delete(ownerId);
    if (owners && owners.size > 0) return;
    this.namespaceOwners.delete(namespace);
    this.clearNamespace(namespace);
  }

  clearUnowned(): void {
    this.removeWhere(entry => !this.namespaceOwners.has(entry.namespace));
  }

  private evictUntilFits(incomingBytes: number): void {
    while (
      this.maxBytes !== null
      && this._currentBytes + incomingBytes > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (!oldest) continue;
      this._currentBytes = Math.max(0, this._currentBytes - oldest.byteLength);
      closeBitmap(oldest.bitmap);
      this.revokeIfUnused(oldest.url);
    }
  }

  private revokeIfUnused(url: string): void {
    if (!this.hasUrl(url)) this.revokeUrl(url);
  }

  private removeWhere(predicate: (entry: TileUrlCacheEntry, key: string) => boolean): void {
    const removedUrls = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (!predicate(entry, key)) continue;
      this.entries.delete(key);
      this._currentBytes = Math.max(0, this._currentBytes - entry.byteLength);
      closeBitmap(entry.bitmap);
      removedUrls.add(entry.url);
    }
    for (const url of removedUrls) this.revokeIfUnused(url);
  }
}

function revokeOwnedBlobUrl(url: string): void {
  if (
    url.startsWith('blob:')
    && !url.includes('#keep')
    && typeof URL !== 'undefined'
    && typeof URL.revokeObjectURL === 'function'
  ) {
    URL.revokeObjectURL(url);
  }
}

const tileUrlCache = new TileUrlLruCache(null, revokeOwnedBlobUrl);
let hardwarePolicyPromise: Promise<void> | null = null;

export function configureTileUrlCacheForHardware(): Promise<void> {
  if (hardwarePolicyPromise) return hardwarePolicyPromise;
  hardwarePolicyPromise = (async () => {
    if (
      typeof window === 'undefined'
      || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<unknown>('get_system_memory_status');
      if (!raw || typeof raw !== 'object') return;
      const payload = raw as { totalBytes?: unknown; total_bytes?: unknown };
      const totalBytes = payload.totalBytes ?? payload.total_bytes;
      const budget = tileUrlCacheBudgetForTotalRam(
        typeof totalBytes === 'number' ? totalBytes : null,
      );
      tileUrlCache.setMaxBytes(budget);
      void previewPerfLog('tile-url-cache-policy', {
        budgetBytes: budget ?? 'unbounded',
        totalBytes,
      });
    } catch {
      // Không đọc được RAM thì giữ full cache; viewer vẫn hoạt động bình thường.
    }
  })();
  return hardwarePolicyPromise;
}

export function cacheTileUrl(key: string, source: TileUrlSource, fileKey = key): boolean {
  return tileUrlCache.set(
    key,
    source,
    source.byteLength,
    tileUrlCacheNamespaceForFileKey(fileKey),
  );
}

export function getCachedTileUrl(key: string): string | undefined {
  return tileUrlCache.get(key);
}

export function getCachedTileSource(key: string): TileUrlSource | undefined {
  return tileUrlCache.getSource(key);
}

export function hasCachedTileUrl(url: string): boolean {
  return tileUrlCache.hasUrl(url);
}

export function clearTileUrlCache(): void {
  // PERF (audit 2026-08-08 §RENDER.8): mở file ở tab B chỉ dọn cache mồ côi;
  // owner của tab A còn sống qua suspend nên Blob của A không bị revoke.
  tileUrlCache.clearUnowned();
}

export function clearTileUrlCacheForFile(fileKeyPrefix: string): void {
  if (!fileKeyPrefix) return;
  tileUrlCache.clearNamespace(tileUrlCacheNamespaceForFileKey(fileKeyPrefix));
}

export function claimTileUrlCacheOwner(ownerId: string, fileKey: string): void {
  tileUrlCache.claimOwner(ownerId, tileUrlCacheNamespaceForFileKey(fileKey));
}

export function releaseTileUrlCacheOwner(ownerId: string): void {
  tileUrlCache.releaseOwner(ownerId);
}
