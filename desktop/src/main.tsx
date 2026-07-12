import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react"
import './index.css'
import './i18n'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { installBackendFetchAuth } from './lib/api'

// ══════════════════════════════════════════════════════════════
// VECTOR #3+#13 FIX: Freeze Tauri IPC bridge AND capture invoke.
// Freezing window.__TAURI__ blocks direct overrides, but ES module
// imports create new references. Solution: capture the REAL invoke
// at startup and expose it via a frozen global that api.ts uses.
// ══════════════════════════════════════════════════════════════
if ((window as any).__TAURI__) {
  try {
    const tauri = (window as any).__TAURI__;
    
    // Capture the REAL invoke function before anything can override it
    const realInvoke = tauri.core?.invoke;
    if (realInvoke) {
      // Store in a non-enumerable, non-configurable, frozen property
      Object.defineProperty(window, '__PRYNX_INVOKE__', {
        value: Object.freeze(realInvoke.bind(tauri.core)),
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
    
    if (tauri.core) Object.freeze(tauri.core);
    Object.freeze(tauri);
    Object.defineProperty(window, '__TAURI__', {
      value: tauri,
      writable: false,
      configurable: false,
    });
  } catch { /* ignore in non-Tauri env */ }
}

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  // F8 FIX: KHÔNG gửi PII mặc định (IP, dữ liệu request...) lên Sentry — riêng tư khách hàng.
  sendDefaultPii: false,
  // Add useful tags for desktop apps
  environment: import.meta.env.MODE || 'development',
});

// Ký tự động MỌI request tới backend sidecar (kể cả các nơi gọi fetch trần) —
// tránh 403 "invalid sidecar token" ở bản release. Cài SỚM trước khi render.
installBackendFetchAuth();

// LƯU Ý: Đã BỎ <StrictMode>. Ở DEV, StrictMode chạy MỌI effect/render 2 LẦN
// (doubleInvokeEffectsOnFiber) → nhân đôi mọi fetch metadata/colorspace + tile load
// lúc mở file → góp phần gây "đơ ~7s" trên cây component lớn (đo được trong Performance
// profile: doubleInvoke + jsxDEV). Production vốn KHÔNG double-invoke nên không đổi hành vi.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
