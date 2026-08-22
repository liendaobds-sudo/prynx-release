/**
 * Cache thumbnail dùng chung cho sidebar.
 *
 * Chỉ đường web/pdfjs ghi vào đây; nhánh Tauri native đi IPC và trả về sớm.
 * Giá trị là data URL JPEG nên không cần gọi URL.revokeObjectURL().
 */
export const thumbCacheRef = { current: new Map<string, string>() };

const THUMBNAIL_OVERSAMPLE = 1.15;
const THUMBNAIL_MAX_PIXEL_WIDTH = 1400;
const DEFAULT_PAGE_WIDTH_PX96 = 595 * 96 / 72;

export interface ThumbnailRenderRequest {
    cacheKey: string;
    pixelWidth: number;
    zoom: number;
    zoomMilli: number;
}

interface ThumbnailRenderRequestInput {
    revision: string;
    pageNum: number;
    pageWidthPx96?: number | null;
    cssWidth: number;
    devicePixelRatio?: number | null;
}

/**
 * Một công thức duy nhất cho cả PDF.js producer và tile consumer.
 * `pixelWidth` là chất lượng bitmap thật; `zoom` chỉ là cách PDFium biểu diễn cùng yêu cầu.
 */
export function createThumbnailRenderRequest({
    revision,
    pageNum,
    pageWidthPx96,
    cssWidth,
    devicePixelRatio,
}: ThumbnailRenderRequestInput): ThumbnailRenderRequest {
    // UIUX (audit 2026-08-22 §UX.TH.01): producer/consumer phải dùng cùng DPR,
    // oversample và đơn vị px@96; lệch một nhánh sẽ làm tile chờ cache vĩnh viễn.
    const safeCssWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 110;
    const safeDpr = Number.isFinite(devicePixelRatio) && Number(devicePixelRatio) > 0
        ? Number(devicePixelRatio)
        : 1;
    const safePageWidthPx96 = Number.isFinite(pageWidthPx96) && Number(pageWidthPx96) > 0
        ? Number(pageWidthPx96)
        : DEFAULT_PAGE_WIDTH_PX96;
    const safePageNum = Number.isFinite(pageNum) && pageNum > 0 ? Math.floor(pageNum) : 0;
    const pixelWidth = Math.min(
        THUMBNAIL_MAX_PIXEL_WIDTH,
        Math.max(1, Math.ceil(safeCssWidth * safeDpr * THUMBNAIL_OVERSAMPLE)),
    );
    const zoom = Math.max(0.1, pixelWidth / safePageWidthPx96);
    const zoomMilli = Math.round(zoom * 1000);

    return {
        cacheKey: `${revision}_${safePageNum}_0_${zoomMilli}`,
        pixelWidth,
        zoom,
        zoomMilli,
    };
}

// BUILD (audit 2026-08-03 §REL.05): tách state khỏi file component để Fast Refresh
// không phải tải lại cả cây Viewer khi cache thay đổi trong lúc phát triển.
const MAX_THUMB_CACHE = 400;
const thumbCacheListeners = new Map<string, Set<() => void>>();

function notifyThumbCache(key: string): void {
    thumbCacheListeners.get(key)?.forEach(listener => listener());
}

export function getThumbCache(key: string): string | undefined {
    return thumbCacheRef.current.get(key);
}

export function subscribeThumbCache(key: string, listener: () => void): () => void {
    let listeners = thumbCacheListeners.get(key);
    if (!listeners) {
        listeners = new Set();
        thumbCacheListeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) thumbCacheListeners.delete(key);
    };
}

export function putThumbCache(key: string, url: string): void {
    const cache = thumbCacheRef.current;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, url);
    notifyThumbCache(key);
    while (cache.size > MAX_THUMB_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}
