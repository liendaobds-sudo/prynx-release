/**
 * Cache thumbnail dùng chung cho sidebar.
 *
 * Chỉ đường web/pdfjs ghi vào đây; nhánh Tauri native đi IPC và trả về sớm.
 * Giá trị là data URL JPEG nên không cần gọi URL.revokeObjectURL().
 */
export const thumbCacheRef = { current: new Map<string, string>() };

// BUILD (audit 2026-08-03 §REL.05): tách state khỏi file component để Fast Refresh
// không phải tải lại cả cây Viewer khi cache thay đổi trong lúc phát triển.
const MAX_THUMB_CACHE = 400;

export function putThumbCache(key: string, url: string): void {
    const cache = thumbCacheRef.current;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, url);
    while (cache.size > MAX_THUMB_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}
