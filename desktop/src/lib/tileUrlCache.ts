import { previewPerfLog } from './previewPerfLog';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface TileUrlSource {
  url: string;
  byteLength: number;
}

type TileUrlCacheEntry = TileUrlSource;

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

  set(key: string, url: string, byteLength: number): boolean {
    const safeBytes = Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : 0;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this._currentBytes = Math.max(0, this._currentBytes - previous.byteLength);
      if (previous.url !== url) this.revokeIfUnused(previous.url);
    }

    if (this.maxBytes !== null && safeBytes > this.maxBytes) return false;
    this.evictUntilFits(safeBytes);
    this.entries.set(key, { url, byteLength: safeBytes });
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
      removedUrls.add(entry.url);
    }
    for (const url of removedUrls) this.revokeIfUnused(url);
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
      this.revokeIfUnused(oldest.url);
    }
  }

  private revokeIfUnused(url: string): void {
    if (!this.hasUrl(url)) this.revokeUrl(url);
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

export function cacheTileUrl(key: string, source: TileUrlSource): boolean {
  return tileUrlCache.set(key, source.url, source.byteLength);
}

export function getCachedTileUrl(key: string): string | undefined {
  return tileUrlCache.get(key);
}

export function hasCachedTileUrl(url: string): boolean {
  return tileUrlCache.hasUrl(url);
}

export function clearTileUrlCache(): void {
  tileUrlCache.clear();
}

export function clearTileUrlCacheForFile(fileKeyPrefix: string): void {
  if (!fileKeyPrefix) return;
  tileUrlCache.clearPrefix(`${fileKeyPrefix}_`);
}
