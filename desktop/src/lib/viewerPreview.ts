import { authenticatedFetch, getApiUrl } from './api';

type ThumbnailManifest = {
  cache_key: string;
  pages: number;
  start_page: number;
  end_page: number;
  cache_hit: boolean;
  render_ms: number;
};

const blobUrls = new Map<string, string>();
const pageRequests = new Map<string, Promise<string | null>>();
const manifestRequests = new Map<string, Promise<ThumbnailManifest>>();
const thumbRequests = new Map<string, Promise<string | null>>();
const MAX_BLOB_URLS = 240;
const THUMB_PROFILE = '32dpi-q92-v4';
const THUMB_BATCH_SIZE = 6;

// Đẩy dòng đo (thumbnail GS / main-page preview) vào CÙNG file PrynX_RenderPerf.log
// mà Rust ghi tile → chỉ cần gửi 1 file thay vì copy console. Lệnh Rust tự gate
// perf_enabled(); no-op nếu không phải Tauri. Fire-and-forget, không chặn UI.
function pushPerf(line: string): void {
  (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('append_render_perf', { msg: line });
    } catch { /* ignore */ }
  })();
}

function cacheBlobUrl(key: string, blob: Blob): string {
  const old = blobUrls.get(key);
  if (old) return old;
  const url = URL.createObjectURL(blob);
  blobUrls.set(key, url);
  while (blobUrls.size > MAX_BLOB_URLS) {
    const first = blobUrls.entries().next().value as [string, string] | undefined;
    if (!first) break;
    blobUrls.delete(first[0]);
    URL.revokeObjectURL(first[1]);
  }
  return url;
}

function revisionKey(filePath: string, revision: string | null | undefined): string {
  return `${filePath}\u0000${revision || ''}`;
}

export function fetchViewerPagePreview(
  filePath: string,
  page: number,
  revision?: string | null,
  dpi = 96,
): Promise<string | null> {
  const key = `main:${revisionKey(filePath, revision)}:${page}:${dpi}`;
  const cached = blobUrls.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = pageRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const started = performance.now();
    try {
      const response = await authenticatedFetch(`${getApiUrl()}/imposition/viewer-preview/page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, page, dpi }),
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.size) return null;
      const backendMs = response.headers.get('X-PrynX-Preview-Ms') || '?';
      const _line = `[ViewerPreview] main page ${page}: ${Math.round(performance.now() - started)}ms total, ${backendMs}ms render`;
      console.info(_line);
      pushPerf(_line);
      return cacheBlobUrl(key, blob);
    } catch {
      return null;
    } finally {
      pageRequests.delete(key);
    }
  })();
  pageRequests.set(key, request);
  return request;
}

function prepareViewerThumbnails(
  filePath: string,
  pageCount: number,
  startPage: number,
  revision?: string | null,
): Promise<ThumbnailManifest> {
  const key = `manifest:${THUMB_PROFILE}:${revisionKey(filePath, revision)}:${pageCount}:${startPage}`;
  const pending = manifestRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const started = performance.now();
    try {
      const response = await authenticatedFetch(`${getApiUrl()}/imposition/viewer-preview/thumbnails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, page_count: pageCount, start_page: startPage, batch_size: THUMB_BATCH_SIZE }),
      });
      if (!response.ok) throw new Error(`Thumbnail preview HTTP ${response.status}`);
      const manifest = await response.json() as ThumbnailManifest;
      const _line = `[ViewerPreview] thumbnails ${manifest.start_page}-${manifest.end_page}: ${Math.round(performance.now() - started)}ms total, `
        + `${manifest.render_ms}ms render, cache=${manifest.cache_hit ? 'hit' : 'miss'}`;
      console.info(_line);
      pushPerf(_line);
      return manifest;
    } catch (error) {
      manifestRequests.delete(key);
      throw error;
    }
  })();
  manifestRequests.set(key, request);
  return request;
}

export function fetchViewerThumbnailPreview(
  filePath: string,
  page: number,
  pageCount: number,
  revision?: string | null,
): Promise<string | null> {
  const startPage = Math.floor((Math.max(1, page) - 1) / THUMB_BATCH_SIZE) * THUMB_BATCH_SIZE + 1;
  const key = `thumb:${THUMB_PROFILE}:${revisionKey(filePath, revision)}:${pageCount}:${page}`;
  const cached = blobUrls.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = thumbRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      // Bắn block HIỆN TẠI và block KẾ TIẾP CÙNG LÚC (không await tuần tự). Backend
      // xử song song qua asyncio.to_thread + lock per-block → 2 tiến trình GS chạy
      // đồng thời trên 2 thread. Cuộn tới block kế là ảnh thường đã sẵn thay vì đợi
      // GS parse lại từ đầu ~vài giây. Đường cũ prefetch SAU await block hiện tại →
      // các block nối đuôi (log cho thấy cách nhau đúng thời gian 1 block). Prefetch
      // fire-and-forget, deduped qua manifestRequests → không thundering herd.
      const nextStart = startPage + THUMB_BATCH_SIZE;
      if (nextStart <= pageCount) {
        void prepareViewerThumbnails(filePath, pageCount, nextStart, revision).catch(() => {});
      }
      const manifest = await prepareViewerThumbnails(filePath, pageCount, startPage, revision);
      if (page < 1 || page > manifest.pages) return null;
      const response = await authenticatedFetch(
        `${getApiUrl()}/imposition/viewer-preview/thumbnail/${encodeURIComponent(manifest.cache_key)}/${page}`,
      );
      if (!response.ok) return null;
      const blob = await response.blob();
      return blob.size ? cacheBlobUrl(key, blob) : null;
    } catch {
      return null;
    } finally {
      thumbRequests.delete(key);
    }
  })();
  thumbRequests.set(key, request);
  return request;
}
