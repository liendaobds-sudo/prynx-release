// SEC (audit 2026-09-09 §SEC.LICUX.JOB): quyền đọc/hủy đúng tác vụ đã submit.
// RAM-only; server kiểm token/route/session, registry này không cấp entitlement.
type Receipt = {
  token: string;
  expiresAt: number;
  origin: string;
  owner: string;
  paths: ReadonlySet<string>;
};

const receipts = new Map<string, Receipt>();
let completionGeneration = 0;
const TOKEN = /^[a-f0-9]{64}$/;

export function clearJobCompletionAccess(): void { receipts.clear(); completionGeneration += 1; }
export function getJobCompletionGeneration(): number { return completionGeneration; }
export function hasJobCompletionAccess(owner: string): boolean {
  return [...receipts.values()].some(value => value.owner === owner && value.expiresAt > Date.now());
}

function scopedPath(path: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:GET /api/jobs/${escaped}(?:/results)?|POST /api/jobs/${escaped}/cancel|GET /api/imposition/nup-(?:status|download)/${escaped}|POST /api/imposition/nup-cancel/${escaped}|GET /api/vdp/(?:status|download)/${escaped}|POST /api/vdp/(?:vdp-cancel|cancel)/${escaped}|GET /api/mixed-nesting/jobs/${escaped}(?:/result|/artifact)?|POST /api/mixed-nesting/jobs/${escaped}/cancel)$`).test(path)
    || /^GET \/api\/files\/[a-f0-9-]{36}\/serve$/.test(path);
}

export function rememberJobCompletionAccess(url: string, value: unknown, owner: string): void {
  if (!owner || !value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.job_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.job_id) || typeof raw.job_access_token !== 'string'
    || !TOKEN.test(raw.job_access_token) || typeof raw.job_access_expires_at !== 'number'
    || !Number.isSafeInteger(raw.job_access_expires_at) || !Array.isArray(raw.job_access_paths)) return;
  const now = Date.now();
  const expiresAt = raw.job_access_expires_at * 1000;
  if (expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1000 + 60_000) return;
  const paths = raw.job_access_paths.filter((path): path is string => typeof path === 'string'
    && scopedPath(path, raw.job_id as string));
  if (!paths.length || paths.length !== raw.job_access_paths.length) return;
  for (const [key, receipt] of receipts) if (receipt.expiresAt <= now || receipt.owner !== owner) receipts.delete(key);
  const origin = new URL(url).origin;
  receipts.set(`${origin}/${raw.job_id}`, { token: raw.job_access_token, expiresAt, origin, owner, paths: new Set(paths) });
}

export function jobCompletionHeader(url: string, method: string, owner: string): string | null {
  const target = new URL(url);
  if (target.search || target.hash || !owner) return null;
  const normalizedMethod = method.toUpperCase();
  const path = `${normalizedMethod} ${target.pathname}`;
  for (const [key, receipt] of receipts) {
    if (receipt.expiresAt <= Date.now() || receipt.owner !== owner) { receipts.delete(key); continue; }
    if (receipt.origin === target.origin && receipt.paths.has(path)) return receipt.token;
    const page = /^\/api\/jobs\/([^/]+)\/page\/[1-9][0-9]*$/.exec(target.pathname);
    if (receipt.origin === target.origin && normalizedMethod === 'GET' && page
      && receipt.paths.has(`GET /api/jobs/${page[1]}/results`)) return receipt.token;
  }
  return null;
}
