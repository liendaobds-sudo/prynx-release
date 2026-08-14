import { viewerTraceHash, viewerTraceLog } from './previewPerfLog';
import type { TileUrlSource } from './tileUrlCache';

const CSS_REFERENCE_DPI = 96;
const DPI_BUCKET = 12;
const MIN_VIEWER_DPI = 24;
const MAX_VIEWER_DPI = 9600;
const DEFAULT_PROOF_IDENTITY = 'show:all|paper:0|black:0|background:profile';
const UNUSED_FRAME_TTL_MS = 60_000;

interface ViewerBootstrapPayload {
  numPages?: unknown;
  widthPt?: unknown;
  heightPt?: unknown;
  fileIdentity?: unknown;
  viewerEngineMode?: unknown;
  colorRisk?: unknown;
}

interface CurrentDisplayMetrics {
  rawDpiX?: number | null;
  rawDpiY?: number | null;
  scaleFactor?: number;
}

export interface ViewerFirstFrame extends TileUrlSource {
  nativePath: string;
  documentToken: string;
  page: 1;
  dpi: number;
  renderScale: number;
  width: number;
  height: number;
  profileId: 'fogra39';
  intent: 'relative';
  proofIdentity: typeof DEFAULT_PROOF_IDENTITY;
}

type StoredViewerFirstFrame = ViewerFirstFrame & {
  adopted: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

const requestsByFile = new WeakMap<File, Promise<ViewerFirstFrame | null>>();
const framesByPath = new Map<string, StoredViewerFirstFrame>();

function normalizedPath(path: string): string {
  return path.replaceAll('/', '\\').toLocaleLowerCase();
}

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function plausibleRawDpi(metrics: CurrentDisplayMetrics | null): number {
  const candidate = finitePositive(metrics?.rawDpiX) ?? finitePositive(metrics?.rawDpiY);
  return candidate && candidate >= 20 && candidate <= 2000 ? Math.round(candidate) : CSS_REFERENCE_DPI;
}

/**
 * Giữ đúng policy của AcrobatViewer: mode hybrid/PPE-only luôn dùng PPE; mode current chỉ
 * dùng PPE khi toàn tài liệu rủi ro cao và riêng trang 1 được detector yêu cầu màu chính xác.
 */
export function viewerBootstrapUsesPpeForPageOne(bootstrap: ViewerBootstrapPayload): boolean {
  if (bootstrap.viewerEngineMode === 'hybrid' || bootstrap.viewerEngineMode === 'ppe-only') {
    return true;
  }
  if (bootstrap.viewerEngineMode !== 'current') return false;
  if (!bootstrap.colorRisk || typeof bootstrap.colorRisk !== 'object') return false;

  const colorRisk = bootstrap.colorRisk as {
    highRisk?: unknown;
    pages?: unknown;
  };
  if (colorRisk.highRisk !== true || !Array.isArray(colorRisk.pages)) return false;
  return colorRisk.pages.some((page) => {
    if (!page || typeof page !== 'object') return false;
    const candidate = page as { page?: unknown; accurateColorRecommended?: unknown };
    return Number(candidate.page) === 1 && candidate.accurateColorRecommended === true;
  });
}

/**
 * Ước lượng đúng mật độ của chế độ Smart Fit trước khi Viewer mount. Kết quả dùng
 * cùng lưới 12 DPI với PPE chính; trang cực lớn vẫn giữ sàn 24 DPI hiện hành.
 */
export function viewerFirstFrameDpi(
  widthPt: number,
  heightPt: number,
  viewportWidthCss: number,
  viewportHeightCss: number,
  rawDpi = CSS_REFERENCE_DPI,
): number {
  if (![widthPt, heightPt, viewportWidthCss, viewportHeightCss].every(Number.isFinite)) {
    return MIN_VIEWER_DPI;
  }
  if (widthPt <= 0 || heightPt <= 0 || viewportWidthCss <= 0 || viewportHeightCss <= 0) {
    return MIN_VIEWER_DPI;
  }

  const pageWidthAt100 = widthPt * (CSS_REFERENCE_DPI / 72);
  const pageHeightAt100 = heightPt * (CSS_REFERENCE_DPI / 72);
  const fitZoom = Math.min(
    1,
    viewportWidthCss / pageWidthAt100,
    viewportHeightCss / pageHeightAt100,
  );
  const anchorDpi = Number.isFinite(rawDpi) && rawDpi >= 20 && rawDpi <= 2000
    ? Math.round(rawDpi)
    : CSS_REFERENCE_DPI;
  const requestedDpi = fitZoom * anchorDpi;
  if (requestedDpi <= MIN_VIEWER_DPI + 1e-7) return MIN_VIEWER_DPI;
  const bucketOffset = Math.ceil((requestedDpi - anchorDpi - 1e-7) / DPI_BUCKET);
  return Math.max(
    MIN_VIEWER_DPI,
    Math.min(MAX_VIEWER_DPI, anchorDpi + bucketOffset * DPI_BUCKET),
  );
}

function estimatedViewerViewport(): { width: number; height: number } {
  if (typeof document !== 'undefined') {
    const visibleScroller = Array.from(document.querySelectorAll<HTMLElement>('.acro-scroll'))
      .find(element => element.offsetParent !== null && element.clientWidth > 50 && element.clientHeight > 50);
    if (visibleScroller) {
      return {
        width: Math.max(50, visibleScroller.clientWidth - 60),
        height: Math.max(50, visibleScroller.clientHeight - 76),
      };
    }
  }
  const windowWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const windowHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  // Toolbar + thumbnail + padding trang của Workspace trước khi `.acro-scroll` tồn tại.
  return {
    width: Math.max(320, windowWidth - 280),
    height: Math.max(320, windowHeight - 280),
  };
}

async function decodePngUrl(url: string): Promise<{ width: number; height: number }> {
  if (typeof Image === 'undefined') return { width: 0, height: 0 };
  const image = new Image();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('WebView không giải mã được frame PPE đầu tiên.'));
  });
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('WebView giải mã frame PPE đầu tiên quá thời gian.'));
    }, 15_000);
  });
  image.src = url;
  try {
    if (typeof image.decode === 'function') {
      // WebView2 có bản từng để Image.decode() pending dù sự kiện load đã hoàn tất. Chấp nhận
      // mốc nào tới trước; cả hai đều chỉ phát sau khi bitmap đã sẵn sàng cho thẻ <img>.
      await Promise.race([image.decode().catch(() => loaded), loaded, timedOut]);
    } else {
      await Promise.race([loaded, timedOut]);
    }
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    image.onload = null;
    image.onerror = null;
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function retireUnusedFrame(frame: StoredViewerFirstFrame): void {
  if (frame.expiryTimer !== null) clearTimeout(frame.expiryTimer);
  frame.expiryTimer = setTimeout(() => {
    const key = normalizedPath(frame.nativePath);
    if (framesByPath.get(key) !== frame || frame.adopted) return;
    framesByPath.delete(key);
    URL.revokeObjectURL(frame.url);
  }, UNUSED_FRAME_TTL_MS);
}

/**
 * PERF (audit 2026-08-14 §VIEW.FIRST.1): dựng và decode trang 1 bằng PPE trước khi
 * đổi Workspace. Viewer nhận pixel thật ngay ở lần paint đầu, không mount khung trắng
 * rồi mới bắt đầu render. Hàm chỉ chạy cho PDF path-backed trong Tauri/PPE Viewer.
 */
export function primeViewerFirstFrame(file: File): Promise<ViewerFirstFrame | null> {
  const existingRequest = requestsByFile.get(file);
  if (existingRequest) return existingRequest;

  const nativePath = (file as File & { path?: string }).path;
  const isPdf = file.type === 'application/pdf' || file.name.toLocaleLowerCase().endsWith('.pdf');
  if (
    !nativePath
    || !isPdf
    || typeof window === 'undefined'
    || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  ) {
    return Promise.resolve(null);
  }

  const request = (async (): Promise<ViewerFirstFrame | null> => {
    const tracePath = viewerTraceHash(nativePath);
    const startedAt = performance.now();
    void viewerTraceLog('first-frame-prime-start', { path: tracePath });
    try {
      const [{ invoke }, { renderPipelineIdentity }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('../hooks/viewer/renderCoordinator'),
      ]);
      const [bootstrap, displayMetrics] = await Promise.all([
        invoke<ViewerBootstrapPayload>('get_pdf_viewer_bootstrap', { filePath: nativePath }),
        invoke<CurrentDisplayMetrics>('get_current_display_metrics').catch(() => null),
      ]);
      void viewerTraceLog('first-frame-prime-bootstrap-ready', {
        path: tracePath,
        viewer_engine_mode: typeof bootstrap.viewerEngineMode === 'string'
          ? bootstrap.viewerEngineMode
          : typeof bootstrap.viewerEngineMode,
        total_ms: Math.round(performance.now() - startedAt),
      });
      if (!viewerBootstrapUsesPpeForPageOne(bootstrap)) {
        void viewerTraceLog('first-frame-prime-skipped', {
          path: tracePath,
          reason: 'page-1-uses-display-pipeline',
          viewer_engine_mode: typeof bootstrap.viewerEngineMode === 'string'
            ? bootstrap.viewerEngineMode
            : typeof bootstrap.viewerEngineMode,
          total_ms: Math.round(performance.now() - startedAt),
        });
        return null;
      }
      const widthPt = finitePositive(bootstrap.widthPt);
      const heightPt = finitePositive(bootstrap.heightPt);
      const documentToken = typeof bootstrap.fileIdentity === 'string'
        ? bootstrap.fileIdentity
        : '';
      if (!widthPt || !heightPt || !documentToken || Number(bootstrap.numPages) < 1) {
        void viewerTraceLog('first-frame-prime-skipped', {
          path: tracePath,
          reason: 'invalid-bootstrap',
          total_ms: Math.round(performance.now() - startedAt),
        });
        return null;
      }

      const viewport = estimatedViewerViewport();
      const dpi = viewerFirstFrameDpi(
        widthPt,
        heightPt,
        viewport.width,
        viewport.height,
        plausibleRawDpi(displayMetrics),
      );
      const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `first-frame-${Date.now().toString(36)}`;
      const ownerHash = viewerTraceHash(`${nativePath}:${documentToken}`);
      const bytes = await invoke<ArrayBuffer>('render_ppe_page', {
        filePath: nativePath,
        page: 1,
        dpi,
        rotation: 0,
        clipX: null,
        clipY: null,
        clipW: null,
        clipH: null,
        sessionOwnerId: `viewer:first-frame:${ownerHash}`,
        requestContext: {
          requestId,
          ownerId: `viewer:first-frame:${ownerHash}`,
          groupKey: 'first-frame:page:1',
          generation: 1,
          purpose: 'interactive',
          priority: 0,
          pipelineIdentity: renderPipelineIdentity('accurate'),
        },
      });
      void viewerTraceLog('first-frame-prime-render-ready', {
        path: tracePath,
        dpi,
        bytes: bytes.byteLength,
        total_ms: Math.round(performance.now() - startedAt),
      });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      let decoded: { width: number; height: number };
      try {
        decoded = await decodePngUrl(url);
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      if (decoded.width <= 0 || decoded.height <= 0) {
        URL.revokeObjectURL(url);
        void viewerTraceLog('first-frame-prime-skipped', {
          path: tracePath,
          reason: 'decoded-empty-bitmap',
          total_ms: Math.round(performance.now() - startedAt),
        });
        return null;
      }
      void viewerTraceLog('first-frame-prime-decode-ready', {
        path: tracePath,
        width: decoded.width,
        height: decoded.height,
        total_ms: Math.round(performance.now() - startedAt),
      });

      const stored: StoredViewerFirstFrame = {
        nativePath,
        documentToken,
        page: 1,
        dpi,
        renderScale: dpi / CSS_REFERENCE_DPI,
        width: decoded.width,
        height: decoded.height,
        profileId: 'fogra39',
        intent: 'relative',
        proofIdentity: DEFAULT_PROOF_IDENTITY,
        url,
        byteLength: bytes.byteLength,
        cacheable: true,
        adopted: false,
        expiryTimer: null,
      };
      const key = normalizedPath(nativePath);
      const previous = framesByPath.get(key);
      framesByPath.set(key, stored);
      retireUnusedFrame(stored);
      if (previous && previous !== stored && !previous.adopted) {
        if (previous.expiryTimer !== null) clearTimeout(previous.expiryTimer);
        URL.revokeObjectURL(previous.url);
      }
      void viewerTraceLog('first-frame-prime-ready', {
        path: tracePath,
        dpi,
        width: decoded.width,
        height: decoded.height,
        bytes: bytes.byteLength,
        total_ms: Math.round(performance.now() - startedAt),
      });
      return stored;
    } catch (error) {
      void viewerTraceLog('first-frame-prime-failed', {
        path: tracePath,
        error: error instanceof Error ? error.name : typeof error,
        total_ms: Math.round(performance.now() - startedAt),
      });
      return null;
    }
  })();
  requestsByFile.set(file, request);
  return request;
}

export function peekViewerFirstFrame(
  nativePath: string | null | undefined,
  documentToken: string | null | undefined,
): ViewerFirstFrame | null {
  if (!nativePath || !documentToken) return null;
  const frame = framesByPath.get(normalizedPath(nativePath));
  return frame && frame.documentToken === documentToken ? frame : null;
}

/** Chuyển quyền sống của Blob URL sang LiveTile/tile cache; không revoke ở kho tạm. */
export function adoptViewerFirstFrame(frame: ViewerFirstFrame): void {
  const stored = framesByPath.get(normalizedPath(frame.nativePath));
  if (!stored || stored.url !== frame.url) return;
  stored.adopted = true;
  if (stored.expiryTimer !== null) clearTimeout(stored.expiryTimer);
  stored.expiryTimer = null;
  framesByPath.delete(normalizedPath(frame.nativePath));
}

/** Bỏ underlay tạm sau khi frame chính xác khác đã phủ viewport. */
export function releaseViewerFirstFrame(frame: ViewerFirstFrame): void {
  const key = normalizedPath(frame.nativePath);
  const stored = framesByPath.get(key);
  if (!stored || stored.url !== frame.url) return;
  if (stored.expiryTimer !== null) clearTimeout(stored.expiryTimer);
  framesByPath.delete(key);
  if (!stored.adopted) URL.revokeObjectURL(stored.url);
}

export function viewerFirstFrameMatchesTile(
  frame: ViewerFirstFrame | null | undefined,
  page: number,
  renderScale: number,
  rotation: number,
  clipX: number,
  clipY: number,
  clipW: number,
  clipH: number,
): boolean {
  if (!frame || page !== 1 || rotation % 360 !== 0) return false;
  if (Math.abs(frame.renderScale - renderScale) > 1e-6) return false;
  if (!(clipW > 0 && clipH > 0)) return true;
  return clipX === 0 && clipY === 0 && clipW === frame.width && clipH === frame.height;
}
