/**
 * Chính sách nhận diện đường dẫn tạm do backend sinh.
 *
 * Các path này chỉ là artifact ngắn hạn trong uploads/results/temp hoặc tên
 * UUID.pdf; không được dùng làm đích lưu lâu dài vì backend có TTL dọn rác.
 */
export function isEphemeralBackendPath(p?: string | null): boolean {
    if (!p) return false;
    const norm = p.replace(/\\/g, '/').toLowerCase();
    if (/\/(uploads|results|temp)\//.test(norm)) return true;
    if (/\/[0-9a-f]{32}\.pdf$/.test(norm)) return true;
    return false;
}
