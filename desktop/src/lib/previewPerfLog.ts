/**
 * Log timeline FE cho audit preview tem/CNC.
 * Mặc định tắt; PRYNX_PERF=1 mới gửi một beacon về file log backend duy nhất.
 */
import { authenticatedFetch, getApiUrl } from './api';

const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type PrynXWindow = Window & {
  __PRYNX_INVOKE__?: InvokeFn;
  __PRYNX_VERBOSE_TRACE__?: boolean;
};

// PERF (audit 2026-09-30 §LOG.DEBUG): Không in console.debug object trong hot-loop viewer
// (zoom, pan, wheel, visibility...) trừ khi chủ động bật __PRYNX_VERBOSE_TRACE__.
// In console hàng trăm object mỗi giây làm nghẽn devtools và WebView IPC.
function isVerboseTraceEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as PrynXWindow).__PRYNX_VERBOSE_TRACE__ === true;
}

let enabledPromise: Promise<boolean> | null = null;
let enabledValue: boolean | undefined;
let invokePromise: Promise<InvokeFn | null> | null = null;
let viewerTraceSequence = 0;
let latestZoomInputSequence: number | null = null;
// PERF (audit 2026-09-25 §R25.03): giới hạn kích thước gói IPC, không bỏ sự kiện
// hoặc giới hạn render. Một lần ghi đang chạy; sự kiện mới gom cho gói tiếp theo.
const TRACE_BATCH_BYTES = 64 * 1024;
const TRACE_BATCH_DELAY_MS = 25;
type PendingTrace = { line: string; done: () => void };
const pendingTraces: PendingTrace[] = [];
let traceTimer: ReturnType<typeof setTimeout> | null = null;
let traceFlush: Promise<void> | null = null;
let failedTraceEvents = 0;
let diagnosticCleanup: (() => void) | null = null;
const viewerTraceSession = `V${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function elapsedMs(): number {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return Math.round(now - t0);
}

async function isPreviewPerfEnabled(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (enabledValue !== undefined) return enabledValue;
  if (!enabledPromise) {
    enabledPromise = (async () => {
      try {
        const invoke = await getInvoke();
        if (typeof invoke !== 'function') return false;
        return await invoke<boolean>('preview_perf_logging_enabled');
      } catch {
        return false;
      }
    })().then((enabled) => {
      enabledValue = enabled;
      if (enabled) startBrowserDiagnostics();
      return enabled;
    });
  }
  return enabledPromise;
}

async function getInvoke(): Promise<InvokeFn | null> {
  if (typeof window === 'undefined') return null;
  if (!invokePromise) {
    invokePromise = Promise.resolve(
      (window as PrynXWindow).__PRYNX_INVOKE__ || null,
    ).then(async (captured) => {
      if (captured) return captured;
      return import('@tauri-apps/api/core')
        .then((module) => module.invoke as InvokeFn)
        .catch(() => null);
    });
  }
  return invokePromise;
}

/**
 * Mã hóa định danh để trace không ghi đường dẫn PDF hoặc owner ID chứa dữ liệu máy.
 * FNV-1a đủ ổn định cho việc đối chiếu các dòng trong một phiên chạy.
 */
export function viewerTraceHash(value: unknown): string {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function compactTracePayload(extra: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) result[key] = Math.round(value * 1000) / 1000;
    } else if (typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = value.slice(0, 240);
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, 12).map(item => {
        if (item && typeof item === 'object') {
          return depth < 2 ? compactTracePayload(item as Record<string, unknown>, depth + 1) : null;
        }
        if (typeof item === 'string') return item.slice(0, 240);
        return typeof item === 'number' && !Number.isFinite(item) ? null : item;
      });
    } else if (typeof value === 'object' && depth < 2) {
      // Clip raster là object: logger cũ đã bỏ mất toàn bộ x/y/width/height.
      result[key] = compactTracePayload(value as Record<string, unknown>, depth + 1);
    }
  }
  return result;
}

interface ScopedZoomContext {
  seq: number;
  epoch: number;
  target: number;
  page?: number;
  tabId?: string;
}

const scopedZoomContextMap = new Map<string, ScopedZoomContext>();
let latestGlobalZoomContext: ScopedZoomContext | null = null;

export function recordZoomInputContext(params: {
  seq: number;
  epoch: number;
  target: number;
  page?: number;
  tabId?: string;
}): void {
  latestGlobalZoomContext = params;
  if (params.page !== undefined) {
    if (params.tabId) {
      scopedZoomContextMap.set(`${params.tabId}:${params.page}`, params);
    }
    scopedZoomContextMap.set(`page:${params.page}`, params);
    // Giới hạn kích thước cache tránh phình bộ nhớ
    if (scopedZoomContextMap.size > 100) {
      const firstKey = scopedZoomContextMap.keys().next().value;
      if (firstKey) scopedZoomContextMap.delete(firstKey);
    }
  }
}

export function getScopedZoomContext(scope?: { page?: number; tabId?: string }): {
  seq: number | null;
  epoch: number;
  target: number;
} {
  if (scope?.tabId && scope?.page !== undefined) {
    const key = `${scope.tabId}:${scope.page}`;
    const found = scopedZoomContextMap.get(key);
    if (found) return found;
  }
  if (scope?.page !== undefined) {
    const key = `page:${scope.page}`;
    const found = scopedZoomContextMap.get(key);
    if (found) return found;
  }
  if (latestGlobalZoomContext) {
    return latestGlobalZoomContext;
  }
  return { seq: null, epoch: 0, target: 0 };
}

export function getLatestZoomContext(): { seq: number | null; epoch: number; target: number } {
  return getScopedZoomContext();
}

function eventPayload(extra: Record<string, unknown>, existingSeq?: number): Record<string, unknown> {
  const seq = existingSeq ?? ++viewerTraceSequence;
  if (extra.event === 'zoom-input' && existingSeq === undefined) {
    latestZoomInputSequence = seq;
    const epoch = Date.now();
    const target = Number(extra.zoom_target) || 0;
    const tabId = typeof extra.tab_id === 'string' ? extra.tab_id : undefined;
    const page = typeof extra.page === 'number' ? extra.page : undefined;
    recordZoomInputContext({ seq, epoch, target, tabId, page });
  }
  return {
    ...compactTracePayload(extra),
    schema: 2,
    trace_id: viewerTraceSession,
    seq,
    latest_zoom_input_seq: latestZoomInputSequence,
    event_epoch_ms: Date.now(),
    elapsed_ms: elapsedMs(),
  };
}

/** Chỉ bật probe DOM đắt hơn khi người dùng đã bật chẩn đoán native. */
export function viewerTraceEnabled(): boolean { return enabledValue === true; }

async function writeTraceBatch(lines: string[]): Promise<void> {
  const msg = lines.join('\n');
  const invoke = await getInvoke();
  if (typeof invoke === 'function') {
    await invoke('append_render_perf', { msg });
    return;
  }
  const response = await authenticatedFetch(`${getApiUrl()}/imposition/perf-beacon`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg, elapsed_ms: elapsedMs() }),
  });
  if (!response.ok) throw new Error('Không ghi được log chẩn đoán.');
}

/** Chờ ghi các dòng đã gom; lỗi log không được chặn thao tác người dùng. */
export function flushViewerTraceLogs(): Promise<void> {
  if (traceTimer !== null) { clearTimeout(traceTimer); traceTimer = null; }
  if (traceFlush) return traceFlush;
  traceFlush = (async () => {
    while (pendingTraces.length > 0) {
      const batch: PendingTrace[] = [];
      let bytes = 0;
      while (pendingTraces.length && (bytes === 0 || bytes + pendingTraces[0].line.length * 3 <= TRACE_BATCH_BYTES)) {
        const entry = pendingTraces.shift()!;
        batch.push(entry);
        bytes += entry.line.length * 3; // biên trên UTF-8 bảo thủ cho JSON UTF-16
      }
      const failedBefore = failedTraceEvents;
      const lines = batch.map(entry => entry.line);
      if (failedBefore) lines.unshift(`TRACE_TRANSPORT ${JSON.stringify({
        ...eventPayload({}), failed_events: failedBefore,
      })}`);
      try {
        await writeTraceBatch(lines);
        failedTraceEvents -= failedBefore;
      } catch {
        failedTraceEvents += batch.length;
      } finally {
        batch.forEach(entry => entry.done());
      }
    }
  })().finally(() => {
    traceFlush = null;
    if (pendingTraces.length && traceTimer === null) {
      traceTimer = setTimeout(() => { traceTimer = null; void flushViewerTraceLogs(); }, TRACE_BATCH_DELAY_MS);
    }
  });
  return traceFlush;
}

async function enqueueTrace(line: string): Promise<void> {
  if (enabledValue === false) return;
  if (enabledValue !== true && !(await isPreviewPerfEnabled())) return;
  return new Promise<void>(done => {
    pendingTraces.push({ line, done });
    if (traceTimer === null && traceFlush === null) {
      traceTimer = setTimeout(() => { traceTimer = null; void flushViewerTraceLogs(); }, TRACE_BATCH_DELAY_MS);
    }
  });
}

/** Capture thời gian ngay tại lời gọi; thời điểm ghi file không thay thế thời điểm sự kiện. */
export function viewerTraceLog(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  // PERF (audit 2026-09-30 §LOG.DEBUG): Chỉ console.debug khi bật __PRYNX_VERBOSE_TRACE__
  if (import.meta.env.DEV && isVerboseTraceEnabled()) {
    console.debug(`[VIEWER_TRACE] ${event}`, extra);
  }
  let seq: number | undefined;
  if (event === 'zoom-input') {
    seq = ++viewerTraceSequence;
    latestZoomInputSequence = seq;
    const epoch = Date.now();
    const target = Number(extra.zoom_target) || 0;
    const tabId = typeof extra.tab_id === 'string' ? extra.tab_id : undefined;
    const page = typeof extra.page === 'number' ? extra.page : undefined;
    recordZoomInputContext({ seq, epoch, target, tabId, page });
  }
  if (typeof window === 'undefined' || enabledValue === false) return Promise.resolve();
  return enqueueTrace(`VIEWER_TRACE ${JSON.stringify(eventPayload({ ...extra, event: event.slice(0, 80) }, seq))}`);
}

export function previewPerfLog(msg: string, extra: Record<string, unknown> = {}): Promise<void> {
  // PERF (audit 2026-09-30 §LOG.DEBUG): Chỉ console.debug khi bật __PRYNX_VERBOSE_TRACE__
  if (import.meta.env.DEV && isVerboseTraceEnabled()) {
    console.debug(`[PREVIEW_PERF] ${msg}`, extra);
  }
  if (typeof window === 'undefined' || enabledValue === false) return Promise.resolve();
  return enqueueTrace(`PREVIEW_PERF ${msg} ${JSON.stringify(eventPayload(extra))}`);
}

function startBrowserDiagnostics(): void {
  if (diagnosticCleanup) return;
  const onHide = () => { void flushViewerTraceLogs(); };
  const onVisibility = () => {
    void viewerTraceLog('document-visibility', { state: document.visibilityState });
    if (document.visibilityState === 'hidden') onHide();
  };
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        void viewerTraceLog('ui-long-task', {
          start_epoch_ms: performance.timeOrigin + entry.startTime,
          duration_ms: entry.duration,
        });
      }
    });
    try { observer.observe({ type: 'longtask' }); } catch { observer.disconnect(); observer = null; }
  }
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);
  diagnosticCleanup = () => {
    observer?.disconnect();
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
  };
  void viewerTraceLog('telemetry-session', {
    time_origin_ms: performance.timeOrigin, dpr: window.devicePixelRatio,
    viewport_w: window.innerWidth, viewport_h: window.innerHeight,
    logical_cores: navigator.hardwareConcurrency, user_agent: navigator.userAgent,
    paint_measurement: 'DOM va rAF opportunity; khong phai xac nhan pixel man hinh',
  });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  diagnosticCleanup?.();
  void flushViewerTraceLogs();
});

/**
 * Trace kích thước bình bản chỉ dành cho vòng dev. Gửi về sidecar local để marker
 * xuất hiện trong app.log kể cả khi PRYNX_PERF tắt; không gửi dữ liệu ra ngoài.
 */
export async function impositionDimensionTrace(
  stage: string,
  extra: Record<string, unknown>,
): Promise<void> {
  if (typeof window === 'undefined' || !import.meta.env.DEV) return;
  try {
    await authenticatedFetch(`${getApiUrl()}/imposition/perf-beacon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg: `[DIM-DIE-TRACE] stage=${stage}`,
        ...compactTracePayload(extra),
      }),
    });
  } catch {
    /* Trace chẩn đoán không được làm gián đoạn UI. */
  }
}
