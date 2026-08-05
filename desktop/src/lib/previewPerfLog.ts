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
        const invoke =
          (window as PrynXWindow).__PRYNX_INVOKE__ ||
          (await import('@tauri-apps/api/core')
            .then((module) => module.invoke as InvokeFn)
            .catch(() => null));
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

export async function previewPerfLog(msg: string, extra?: Record<string, unknown>): Promise<void> {
  // PERF (audit 2026-08-05 §PERF.3): chỉ tốn một IPC ở lần đầu để đọc cờ.
  // Release mặc định không dựng payload, không ghi Desktop và không gửi HTTP.
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
