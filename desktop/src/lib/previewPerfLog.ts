/**
 * Log timeline FE cho audit preview tem/CNC.
 * Mặc định tắt; PRYNX_PERF=1 mới gửi một beacon về file log backend duy nhất.
 */
import { authenticatedFetch, getApiUrl } from './api';

const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type PrynXWindow = Window & { __PRYNX_INVOKE__?: InvokeFn };

let enabledPromise: Promise<boolean> | null = null;
let enabledValue: boolean | undefined;
let invokePromise: Promise<InvokeFn | null> | null = null;
let viewerTraceSequence = 0;
let viewerTraceWriteQueue: Promise<void> = Promise.resolve();
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

function compactTracePayload(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) result[key] = Math.round(value * 1000) / 1000;
      continue;
    }
    if (typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value.slice(0, 120);
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.slice(0, 12);
    }
  }
  return result;
}

/**
 * Trace chẩn đoán Viewer/PPE. Ghi trực tiếp qua Tauri vào Desktop log để không
 * phụ thuộc route beacon của backend và không cần mở DevTools.
 */
export function viewerTraceLog(
  event: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (enabledValue === false) return Promise.resolve();

  // Tauri command và worker native cùng ghi chung một file. FE phải tuần tự hóa
  // các dòng của chính nó; nếu fire-and-forget đồng thời, các dòng JSON có thể
  // dính vào nhau và mất thứ tự timeline (đã thấy ở log PPE cũ).
  const write = async (): Promise<void> => {
    try {
      // PERF (audit 2026-08-14 §LOG.1): kể cả Dev cũng phải opt-in bằng PRYNX_PERF;
      // không để mỗi lần chạy run_dev tự tạo PrynX_RenderPerf.log và bơm IPC theo tile.
      if (enabledValue !== true && !(await isPreviewPerfEnabled())) return;
      const payload = {
        event: event.slice(0, 80),
        trace_id: viewerTraceSession,
        seq: ++viewerTraceSequence,
        elapsed_ms: elapsedMs(),
        ...compactTracePayload(extra),
      };
      const line = `VIEWER_TRACE ${JSON.stringify(payload)}`;
      try {
        const invoke = await getInvoke();
        if (typeof invoke === 'function') {
          await invoke('append_render_perf', { msg: line });
          return;
        }
      } catch {
        // Web mode/phiên Tauri cũ không có command này → thử beacon bên dưới.
      }

      try {
        if (!(await isPreviewPerfEnabled())) return;
        await authenticatedFetch(`${getApiUrl()}/imposition/perf-beacon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msg: line, elapsed_ms: elapsedMs() }),
        });
      } catch {
        /* trace không được làm gián đoạn render */
      }
    } catch {
      /* Một lỗi telemetry không được tạo unhandled rejection trong UI. */
    }
  };
  viewerTraceWriteQueue = viewerTraceWriteQueue.then(write, write);
  return viewerTraceWriteQueue;
}

export async function previewPerfLog(msg: string, extra?: Record<string, unknown>): Promise<void> {
  // PERF (audit 2026-08-05 §PERF.3): chỉ tốn một IPC ở lần đầu để đọc cờ;
  // Dev và release đều mặc định không dựng payload, không ghi Desktop và không gửi HTTP.
  if (enabledValue === false) return;
  if (enabledValue !== true && !(await isPreviewPerfEnabled())) return;

  try {
    await authenticatedFetch(`${getApiUrl()}/imposition/perf-beacon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg, elapsed_ms: elapsedMs(), ...extra }),
    });
  } catch {
    /* ignore — không chặn UI */
  }
}

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
