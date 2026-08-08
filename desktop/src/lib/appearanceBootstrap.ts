import { invoke } from '@tauri-apps/api/core';

const GIB = 1024 ** 3;

export type AppearancePerformanceTier = 'low' | 'mid' | 'full';
type AppearanceInvoke = (command: string) => Promise<unknown>;

interface SystemMemoryStatus {
  installedBytes?: number;
  totalBytes?: number;
}

export function appearanceTierForTotalMemory(totalBytes: number): AppearancePerformanceTier | null {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  if (totalBytes < 8 * GIB) return 'low';
  if (totalBytes < 16 * GIB) return 'mid';
  return 'full';
}

export function applyAppearancePerformanceTier(root: Element, tier: AppearancePerformanceTier): void {
  root.classList.remove('perf-low', 'perf-mid');
  if (tier === 'low') root.classList.add('perf-low');
  if (tier === 'mid') root.classList.add('perf-mid');
}

/**
 * UIUX (audit 2026-07-27 §A-01/§A-09/§A-15): dựng "vẻ ngoài" của app TRƯỚC khi
 * React render frame đầu tiên.
 *
 *  1. Theme: đọc localStorage/hệ điều hành rồi gắn class light|dark lên <html>
 *     ngay lập tức. Nếu chờ effect của React, người dùng dark mode sẽ thấy một
 *     nháy sáng (splash + shell trắng) mỗi lần mở app — chói mắt trong phòng
 *     chế bản vốn để ánh sáng yếu để soi màu.
 *  2. Máy yếu: heuristic đồng bộ bảo vệ frame đầu; RAM native thật sẽ hiệu chỉnh
 *     bất đồng bộ theo ba tier <8 / 8–15 / >=16 GB sau khi bridge sẵn sàng.
 */
export function bootstrapAppearance(): void {
  const root = document.documentElement;

  // ── 1. Theme ───────────────────────────────────────────────────────────
  let theme: 'light' | 'dark' = 'light';
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      theme = saved;
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
  } catch {
    /* localStorage bị chặn → giữ mặc định light */
  }
  root.classList.remove('light', 'dark');
  root.classList.add(theme);

  // ── 2. Máy yếu ─────────────────────────────────────────────────────────
  try {
    const cores = navigator.hardwareConcurrency || 8;
    // deviceMemory là API riêng của Chromium (WebView2 có), đơn vị GB, làm tròn xuống
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    root.classList.remove('perf-low', 'perf-mid');
    if (cores <= 4 || memory <= 4) {
      root.classList.add('perf-low');
    }
  } catch {
    /* không đọc được cấu hình máy → coi như máy đủ mạnh, giữ hiệu ứng */
  }
}

/**
 * PERF (audit 2026-08-07 §MOTION.4): `deviceMemory` có thể thiếu hoặc bị Chromium
 * làm tròn/cap. Dùng RAM lắp đặt từ native để chốt tier; IPC lỗi thì fail-open và
 * giữ nguyên heuristic frame đầu, không tự đoán một mức giảm mới.
 */
export async function refineAppearanceForHardware(
  invokeCommand: AppearanceInvoke = invoke as AppearanceInvoke,
  root: Element = document.documentElement,
): Promise<void> {
  try {
    const status = await invokeCommand('get_system_memory_status') as SystemMemoryStatus;
    const totalBytes = status.installedBytes ?? status.totalBytes ?? 0;
    const tier = appearanceTierForTotalMemory(totalBytes);
    if (tier) applyAppearancePerformanceTier(root, tier);
  } catch {
    /* Bản web/test hoặc IPC chưa sẵn sàng: giữ heuristic hiện tại. */
  }
}
