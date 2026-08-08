export type AppVisibilityListener = (backgrounded: boolean) => void;

export interface AppVisibilityGate {
    isBackgrounded: () => boolean;
    subscribe: (listener: AppVisibilityListener) => () => void;
}

export const APP_BACKGROUNDED_CLASS = 'prynx-app-backgrounded';

/** Đồng bộ trạng thái foreground ra CSS mà không buộc component React subscribe riêng. */
export function syncAppBackgroundClass(
    backgrounded: boolean,
    root: Element | null = typeof document !== 'undefined' ? document.documentElement : null,
): void {
    root?.classList.toggle(APP_BACKGROUNDED_CLASS, backgrounded);
}

/**
 * PERF (audit 2026-08-05 §PERF.9): một nguồn trạng thái foreground dùng chung.
 * `document.hidden` bắt tab/webview bị ẩn; focus native bắt cả trường hợp WebView2
 * vẫn báo visible khi cửa sổ Tauri bị thu nhỏ hoặc nằm sau ứng dụng khác.
 */
export class AppVisibilityStore implements AppVisibilityGate {
    private readonly listeners = new Set<AppVisibilityListener>();

    constructor(
        private documentHidden: boolean,
        private windowFocused: boolean | null,
    ) {}

    isBackgrounded = (): boolean => this.documentHidden || this.windowFocused === false;

    subscribe = (listener: AppVisibilityListener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    setDocumentHidden(hidden: boolean): void {
        this.updateState(() => {
            this.documentHidden = hidden;
        });
    }

    setWindowFocused(focused: boolean | null): void {
        this.updateState(() => {
            this.windowFocused = focused;
        });
    }

    /**
     * Khi đang foreground, giữ nhịp delay bình thường. Nếu app chuyển nền trong
     * lúc chờ, hủy timer và chỉ tiếp tục ngay khi foreground để đồng bộ trạng thái.
     */
    waitForForegroundDelay(delayMs: number): Promise<void> {
        const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            let paused = this.isBackgrounded();
            let settled = false;
            let unsubscribe = () => {};

            const finish = () => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                timer = null;
                unsubscribe();
                resolve();
            };

            unsubscribe = this.subscribe(backgrounded => {
                if (backgrounded) {
                    paused = true;
                    if (timer !== null) clearTimeout(timer);
                    timer = null;
                    return;
                }
                if (paused) finish();
            });

            if (paused) return;
            timer = setTimeout(finish, safeDelayMs);
        });
    }

    private updateState(update: () => void): void {
        const wasBackgrounded = this.isBackgrounded();
        update();
        const backgrounded = this.isBackgrounded();
        if (backgrounded === wasBackgrounded) return;
        for (const listener of this.listeners) listener(backgrounded);
    }
}

interface AppVisibilityHotData {
    appVisibilityStore?: AppVisibilityStore;
}

const hotData = import.meta.hot?.data as AppVisibilityHotData | undefined;
const initialDocumentHidden = typeof document !== 'undefined'
    ? document.visibilityState === 'hidden'
    : false;
const appVisibilityStore = hotData?.appVisibilityStore
    ?? new AppVisibilityStore(initialDocumentHidden, null);

if (hotData) hotData.appVisibilityStore = appVisibilityStore;

// PERF (audit 2026-08-07 §MOTION.3): WebView2 cố ý không throttle nền để tránh
// hồi quy occlusion; pause animation CSS bằng cổng ứng dụng thay vì gỡ native flags.
const removeBackgroundClassListener = appVisibilityStore.subscribe(syncAppBackgroundClass);
syncAppBackgroundClass(appVisibilityStore.isBackgrounded());

const handleDocumentVisibility = () => {
    appVisibilityStore.setDocumentHidden(document.visibilityState === 'hidden');
};

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleDocumentVisibility);
}

let disposed = false;
let removeWindowFocusListener: (() => void) | null = null;

async function initializeNativeWindowFocus(): Promise<void> {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;

    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (disposed) return;
        const currentWindow = getCurrentWindow();
        let focusEventVersion = 0;

        try {
            const unlisten = await currentWindow.onFocusChanged(({ payload }) => {
                focusEventVersion += 1;
                appVisibilityStore.setWindowFocused(payload);
            });
            if (disposed) {
                unlisten();
                return;
            }
            removeWindowFocusListener = unlisten;
        } catch {
            // Fail-open: document.visibilityState vẫn là tín hiệu an toàn trong web/browser.
        }

        const versionBeforeRead = focusEventVersion;
        try {
            const focused = await currentWindow.isFocused();
            if (!disposed && focusEventVersion === versionBeforeRead) {
                appVisibilityStore.setWindowFocused(focused);
            }
        } catch {
            // Không đoán app đang nền nếu native focus tạm thời chưa đọc được.
        }
    } catch {
        // Bản web/test không có API Tauri: giữ cơ chế visibility của document.
    }
}

void initializeNativeWindowFocus();

export const appVisibilityGate: AppVisibilityGate = {
    isBackgrounded: appVisibilityStore.isBackgrounded,
    subscribe: appVisibilityStore.subscribe,
};

export function isAppBackgrounded(): boolean {
    return appVisibilityStore.isBackgrounded();
}

export function subscribeAppVisibility(listener: AppVisibilityListener): () => void {
    return appVisibilityStore.subscribe(listener);
}

export function waitForAppForegroundDelay(delayMs: number): Promise<void> {
    return appVisibilityStore.waitForForegroundDelay(delayMs);
}

if (import.meta.hot) {
    import.meta.hot.dispose(data => {
        disposed = true;
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', handleDocumentVisibility);
        }
        removeWindowFocusListener?.();
        removeBackgroundClassListener();
        (data as AppVisibilityHotData).appVisibilityStore = appVisibilityStore;
    });
}
