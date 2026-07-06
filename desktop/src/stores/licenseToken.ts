/**
 * licenseToken.ts — tiện ích thuần cho token license Ed25519 do server ký.
 *
 * Tách khỏi useAuthStore để unit-test được mà KHÔNG phải nạp cả store (vốn kéo theo
 * supabase client + zustand + Tauri). Hàm ở đây không có side-effect, không phụ thuộc
 * môi trường Tauri.
 */

/**
 * Đọc 'exp' (unix giây) từ token "<payload_b64url>.<sig>" và kiểm tra CÒN HẠN.
 *
 * Đệm 60s: coi token là hết hạn SỚM 60s trước exp thật, tránh trường hợp token vừa lọt
 * qua kiểm tra ở client nhưng tới lúc backend nhận thì đã hết hạn (lệch đồng hồ nhẹ + độ trễ).
 *
 * Trả false khi: token rỗng/null, sai định dạng (thiếu '.'), payload không giải mã được,
 * hoặc thiếu/không hợp lệ trường exp. An toàn tuyệt đối — mọi lỗi → false (fail-closed).
 */
export function isLicenseTokenValid(token: string | null): boolean {
  if (!token || token.indexOf('.') < 0) return false;
  try {
    let p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const payload = JSON.parse(decodeURIComponent(escape(atob(p))));
    const exp = Number(payload?.exp || 0);
    if (!exp) return false;
    return exp * 1000 > Date.now() + 60_000;
  } catch {
    return false;
  }
}
