/**
 * Helpers license key — pure, unit-test được (không phụ thuộc Tauri/Zustand).
 */

/** Chuẩn hoá key trước khi verify/lưu (khớp server: upper + trim). */
export function normalizeLicenseKey(raw: string): string {
    return String(raw || '').trim().toUpperCase();
}

/**
 * Mask hiển thị: chỉ lộ 4 ký tự cuối (giảm rủi ro screenshot).
 * Key ngắn hơn 4 → full bullet.
 */
export function maskLicenseKey(key: string | null | undefined): string {
    const k = String(key || '').trim();
    if (!k) return '—';
    if (k.length <= 4) return '••••';
    return `••••${k.slice(-4)}`;
}
