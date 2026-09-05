import { createRoot } from 'react-dom/client'
import * as Sentry from "@sentry/react"
import './index.css'
import './i18n'
import { bootstrapAppearance, refineAppearanceForHardware } from './lib/appearanceBootstrap'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { installBackendFetchAuth } from './lib/api'
import { APP_VERSION } from './lib/uiErrorDiagnostics'
import {
  takeDocumentWindowBootstrap,
  type DocumentWindowBootstrap,
} from './lib/documentWindow'

type TauriGlobal = {
  core?: {
    invoke?: typeof import('@tauri-apps/api/core').invoke
  }
}

// ══════════════════════════════════════════════════════════════
// VECTOR #3+#13 FIX: Freeze Tauri IPC bridge AND capture invoke.
// Freezing window.__TAURI__ blocks direct overrides, but ES module
// imports create new references. Solution: capture the REAL invoke
// at startup and expose it via a frozen global that api.ts uses.
// ══════════════════════════════════════════════════════════════
const tauri = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;
if (tauri) {
  try {

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

// UIUX §A-01/§A-09/§A-15: theme + mức hiệu ứng phải có ngay ở frame đầu tiên,
// trước cả splash — nếu để React effect làm thì dark mode bị nháy trắng lúc mở app.
bootstrapAppearance();
// PERF (audit 2026-08-07 §MOTION.4): RAM native hiệu chỉnh tier bất đồng bộ;
// không chặn frame đầu và máy >=16 GB luôn được trả về hiệu ứng đầy đủ.
void refineAppearanceForHardware();

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  // SEC (audit 2026-09-05 §LOG.05): stack/source map và breadcrumb có thể lộ
  // cấu trúc engine. Telemetry chi tiết chỉ dùng trong vòng dev cục bộ.
  enabled: import.meta.env.DEV,
  release: `prynx@${APP_VERSION}`,
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
async function renderApplication(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  let documentWindowBootstrap: DocumentWindowBootstrap | undefined;

  try {
    documentWindowBootstrap = await takeDocumentWindowBootstrap() ?? undefined;
  } catch (error) {
    // UIUX/SEC (audit 2026-08-25 §NW.3): bootstrap không đi qua URL/localStorage.
    // Token one-shot lỗi thì đóng child ẩn; Destroyed dọn pending snapshot native.
    console.error('[DOCUMENT-WINDOW] Bootstrap thất bại:', error);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    } catch {
      // Native sẽ dọn pending theo TTL/startup nếu WebView hỏng trước Destroyed.
    }
    return;
  }

  root.render(
    <ErrorBoundary>
      <App documentWindowBootstrap={documentWindowBootstrap} />
    </ErrorBoundary>,
  );
}

void renderApplication();
