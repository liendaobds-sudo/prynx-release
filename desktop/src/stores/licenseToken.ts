/** Tiện ích thuần để đọc token license Ed25519 do server ký. */

export interface LicenseTokenClaims {
  exp: number;
  plan?: string;
  features?: string[];
  k?: string;
  m?: string;
  p?: string;
  /**
   * UIUX (audit 2026-08-26 dieline-engine-unlock): token có claim `rk` (khoá mở bộ máy
   * khuôn bế của đúng bản này) hay không — CHỈ trạng thái có/không.
   *
   * Module này cố ý KHÔNG expose giá trị `rk` và không được đổi ranh giới đó: khoá chỉ
   * đi từ payload đã ký Ed25519 vào Rust, không bao giờ qua tầng UI. Ở đây chỉ đọc TÊN
   * claim để công cụ khuôn bế biết trước rằng engine sẽ không mở được, thay vì để người
   * dùng phát hiện bằng cách bấm tạo khuôn rồi nhận 403.
   */
  hasResourceKey: boolean;
}

function decodePayload(token: string): unknown {
  if (!token || token.indexOf('.') < 0) throw new Error('Malformed token');
  let payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4) payload += '=';
  return JSON.parse(decodeURIComponent(escape(atob(payload))));
}

/**
 * Chỉ đọc claims để hiển thị/quyết định UX. Chữ ký vẫn được Rust và sidecar xác minh;
 * frontend không được xem là biên giới bảo mật.
 */
export function readLicenseTokenClaims(token: string | null): LicenseTokenClaims | null {
  if (!token) return null;
  try {
    const raw = decodePayload(token) as Record<string, unknown>;
    const exp = Number(raw.exp || 0);
    if (!exp) return null;
    return {
      exp,
      plan: typeof raw.plan === 'string' ? raw.plan : undefined,
      features: Array.isArray(raw.features)
        ? raw.features.filter((item): item is string => typeof item === 'string')
        : undefined,
      k: typeof raw.k === 'string' ? raw.k : undefined,
      m: typeof raw.m === 'string' ? raw.m : undefined,
      p: typeof raw.p === 'string' ? raw.p : undefined,
      // Chỉ suy ra boolean rồi bỏ `raw.rk` đi — giá trị khoá không bao giờ được sao vào
      // object trả về, không log, không so sánh.
      hasResourceKey: typeof raw.rk === 'string' && raw.rk.length > 0,
    };
  } catch {
    return null;
  }
}

/** Coi token hết hạn sớm 60 giây để tránh hết hạn giữa một request. */
export function isLicenseTokenValid(token: string | null): boolean {
  const claims = readLicenseTokenClaims(token);
  return !!claims && claims.exp * 1000 > Date.now() + 60_000;
}
