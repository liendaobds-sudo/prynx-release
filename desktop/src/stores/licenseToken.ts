/** Tiện ích thuần để đọc token license Ed25519 do server ký. */

export interface LicenseTokenClaims {
  exp: number;
  plan?: string;
  features?: string[];
  k?: string;
  m?: string;
  p?: string;
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
