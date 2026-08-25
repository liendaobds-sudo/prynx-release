import { useSyncExternalStore } from 'react';

const CSS_REFERENCE_DPI = 96;
const DISPLAY_REFRESH_DEBOUNCE_MS = 120;

export interface NativeDisplayMetrics {
    monitorId: string;
    monitorName: string | null;
    rawDpiX: number | null;
    rawDpiY: number | null;
    scaleFactor: number;
    widthPx: number;
    heightPx: number;
}

export interface PhysicalDisplayScaleSnapshot {
    /** Hệ số đổi từ px@96 của PDF sang CSS px đúng kích thước vật lý. */
    scale: number;
    rawDpi: number | null;
    devicePixelRatio: number;
    monitorId: string | null;
    monitorName: string | null;
    calibrated: boolean;
}

const FALLBACK_SNAPSHOT: PhysicalDisplayScaleSnapshot = Object.freeze({
    scale: 1,
    rawDpi: null,
    devicePixelRatio: 1,
    monitorId: null,
    monitorName: null,
    calibrated: false,
});

const isPlausibleDpi = (value: number | null | undefined): value is number => (
    Number.isFinite(value) && Number(value) >= 20 && Number(value) <= 2000
);

const isPlausibleScale = (value: number | null | undefined): value is number => (
    Number.isFinite(value) && Number(value) >= 0.25 && Number(value) <= 8
);

/**
 * 100% vật lý cần `raw PPI / DPR` CSS pixel cho mỗi inch. PDF/CSS chuẩn dùng 96 px/in,
 * vì vậy chỉ lớp hiển thị nhân tỷ lệ này; tuyệt đối không đổi pageDim hay đơn vị nghiệp vụ.
 */
export function calculatePhysicalDisplayScale(
    metrics: Pick<NativeDisplayMetrics, 'rawDpiX' | 'rawDpiY' | 'scaleFactor'> | null,
    browserDevicePixelRatio: number,
): number {
    if (!metrics) return 1;
    const rawDpi = isPlausibleDpi(metrics.rawDpiX)
        ? metrics.rawDpiX
        : (isPlausibleDpi(metrics.rawDpiY) ? metrics.rawDpiY : null);
    if (rawDpi == null) return 1;

    const dpr = isPlausibleScale(browserDevicePixelRatio)
        ? browserDevicePixelRatio
        : (isPlausibleScale(metrics.scaleFactor) ? metrics.scaleFactor : 1);
    const scale = rawDpi / (CSS_REFERENCE_DPI * dpr);
    return isPlausibleScale(scale) ? scale : 1;
}

export function pdfPointsToPhysicalCssPixels(points: number, physicalScale: number): number {
    return points * (CSS_REFERENCE_DPI / 72) * physicalScale;
}

let snapshot = FALLBACK_SNAPSHOT;
const listeners = new Set<() => void>();
let started = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshGeneration = 0;

const publish = (next: PhysicalDisplayScaleSnapshot) => {
    const unchanged = next.monitorId === snapshot.monitorId
        && next.calibrated === snapshot.calibrated
        && Math.abs(next.scale - snapshot.scale) < 1e-6
        && Math.abs(next.devicePixelRatio - snapshot.devicePixelRatio) < 1e-6
        && next.rawDpi === snapshot.rawDpi;
    if (unchanged) return;
    snapshot = next;
    listeners.forEach(listener => listener());
};

const refreshDisplayMetrics = async () => {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
    const generation = ++refreshGeneration;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const metrics = await invoke<NativeDisplayMetrics>('get_current_display_metrics');
        if (generation !== refreshGeneration) return;
        const browserDpr = window.devicePixelRatio || metrics.scaleFactor || 1;
        const scale = calculatePhysicalDisplayScale(metrics, browserDpr);
        const rawDpi = isPlausibleDpi(metrics.rawDpiX)
            ? metrics.rawDpiX
            : (isPlausibleDpi(metrics.rawDpiY) ? metrics.rawDpiY : null);
        publish({
            scale,
            rawDpi,
            devicePixelRatio: browserDpr,
            monitorId: metrics.monitorId,
            monitorName: metrics.monitorName,
            calibrated: rawDpi != null,
        });
    } catch {
        // Thiếu EDID/API không được làm Viewer hỏng: giữ tỷ lệ cuối đã biết hoặc fallback 96 DPI.
    }
};

const scheduleRefresh = () => {
    if (refreshTimer != null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshDisplayMetrics();
    }, DISPLAY_REFRESH_DEBOUNCE_MS);
};

const startDisplayTracking = () => {
    if (started || typeof window === 'undefined') return;
    started = true;
    void refreshDisplayMetrics();
    if (!window.__TAURI_INTERNALS__) return;

    void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
            const appWindow = getCurrentWindow();
            await Promise.all([
                appWindow.onMoved(scheduleRefresh),
                appWindow.onScaleChanged(scheduleRefresh),
            ]);
        })
        .catch(() => undefined);
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    startDisplayTracking();
    return () => listeners.delete(listener);
};

const getSnapshot = () => snapshot;

/** Một tracker dùng chung cho mọi tab; tránh mỗi Viewer gắn listener native riêng. */
export function usePhysicalDisplayScale(): PhysicalDisplayScaleSnapshot {
    return useSyncExternalStore(subscribe, getSnapshot, () => FALLBACK_SNAPSHOT);
}
