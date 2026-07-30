// ============================================================
// textSearch — Chuẩn hoá chuỗi cho tìm kiếm tiếng Việt
// [VARIANT 2026-07-29]
//
// Tách ra khỏi `toolRegistry.ts` (nơi hàm này ở trước đây) để các module
// KHÔNG thuộc app shell dùng được mà không kéo theo React. Cụ thể:
// `lib/dieline/*` được bundle vào sidecar chạy trên Boa (không có DOM),
// import toolRegistry vào đó sẽ kéo React vào bundle và vỡ.
//
// toolRegistry re-export lại hàm này nên mọi chỗ gọi cũ giữ nguyên.
// ============================================================

/** Chuẩn hoá chuỗi để tìm kiếm: thường hoá + BỎ DẤU tiếng Việt (kể cả đ→d). */
export function normalizeSearch(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd');
}

/**
 * Khớp một "kho chữ" với từ khoá: bỏ dấu + tách nhiều từ rời — MỌI từ đều
 * phải xuất hiện, KHÔNG cần đúng thứ tự. VD "binh be rot" / "cnc 2 mat".
 */
export function haystackMatchesQuery(haystack: string, query: string): boolean {
    const q = normalizeSearch(query).trim();
    if (!q) return true;
    const hay = normalizeSearch(haystack);
    return q.split(/\s+/).every(tok => hay.includes(tok));
}
