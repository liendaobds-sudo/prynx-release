/**
 * UIUX (audit 2026-07-27 §A-01/§A-09/§A-15): dựng "vẻ ngoài" của app TRƯỚC khi
 * React render frame đầu tiên.
 *
 *  1. Theme: đọc localStorage/hệ điều hành rồi gắn class light|dark lên <html>
 *     ngay lập tức. Nếu chờ effect của React, người dùng dark mode sẽ thấy một
 *     nháy sáng (splash + shell trắng) mỗi lần mở app — chói mắt trong phòng
 *     chế bản vốn để ánh sáng yếu để soi màu.
 *  2. Máy yếu: ít nhân CPU hoặc ít RAM → gắn class `perf-low` để CSS tự tắt
 *     animation/blur (xem cuối index.css). Máy mạnh giữ nguyên hiệu ứng đầy đủ.
 *     Ngưỡng chọn theo cấu hình máy văn phòng phổ biến ở nhà in: 4 nhân / 4GB.
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
    if (cores <= 4 || memory <= 4) {
      root.classList.add('perf-low');
    }
  } catch {
    /* không đọc được cấu hình máy → coi như máy đủ mạnh, giữ hiệu ứng */
  }
}
