/**
 * Log timeline FE cho audit preview tem/CNC.
 * - Desktop: Desktop/PrynX_Performance.log (Tauri append_perf_log)
 * - Backend: POST /imposition/perf-beacon → logs/preview_perf.log (agent đọc được)
 */
import { authenticatedFetch, getApiUrl } from './api';

const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

function elapsedMs(): number {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return Math.round(now - t0);
}

export async function previewPerfLog(msg: string, extra?: Record<string, unknown>): Promise<void> {
  const line = extra
    ? `[FE +${elapsedMs()}ms] ${msg} ${JSON.stringify(extra)}`
    : `[FE +${elapsedMs()}ms] ${msg}`;

  // 1) Tauri desktop log
  try {
    const invoke =
      (window as any).__PRYNX_INVOKE__ ||
      (await import('@tauri-apps/api/core').then((m) => m.invoke).catch(() => null));
    if (typeof invoke === 'function') {
      await invoke('append_perf_log', { msg: line });
    }
  } catch {
    /* ignore */
  }

  // 2) Backend file (workspace logs/preview_perf.log)
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
