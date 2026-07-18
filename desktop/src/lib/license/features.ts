/**
 * Free/Pro feature IDs — Phase D scaffold.
 *
 * FEATURE_GATING_ENABLED = false → mọi tool vẫn dùng được (không chặn user).
 * Khi bật gate: map id → plan tối thiểu; UI gọi canUse() + backend entitlement.
 *
 * KHÔNG gắn pricing / paywall UI ở đây.
 */

export type LicensePlan = 'free' | 'pro' | 'dev';

/** Feature id ổn định (token / docs / backend dùng chung). */
export type FeatureId =
  | 'pdf.encrypt'
  | 'pdf.decrypt'
  | 'pdf.metadata'
  | 'pdf.optimize'
  | 'pdf.watermark'
  | 'pdf.merge'
  | 'pdf.split'
  | 'pdf.pages'
  | 'pdf.office_convert'
  | 'impo.booklet'
  | 'impo.nup'
  | 'impo.diecut'
  | 'impo.cnc'
  | 'impo.dieline'
  | 'vdp.numbering'
  | 'vdp.datamerge'
  | 'print.preflight'
  | 'qc.compare';

/** plan tối thiểu để dùng feature khi gate bật. */
export const FEATURE_MIN_PLAN: Record<FeatureId, LicensePlan> = {
  'pdf.encrypt': 'free',
  'pdf.decrypt': 'free',
  'pdf.metadata': 'free',
  'pdf.optimize': 'free',
  'pdf.watermark': 'free',
  'pdf.merge': 'free',
  'pdf.split': 'free',
  'pdf.pages': 'free',
  'pdf.office_convert': 'free',
  'impo.booklet': 'pro',
  'impo.nup': 'pro',
  'impo.diecut': 'pro',
  'impo.cnc': 'pro',
  'impo.dieline': 'pro',
  'vdp.numbering': 'pro',
  'vdp.datamerge': 'pro',
  'print.preflight': 'pro',
  'qc.compare': 'pro',
};

/**
 * Tắt = ship như hiện tại (mọi license valid dùng full).
 * Bật chỉ khi Phase D go-live + server trả plan.
 */
export const FEATURE_GATING_ENABLED = false;

const PLAN_RANK: Record<LicensePlan, number> = {
  free: 1,
  pro: 2,
  dev: 99,
};

export function normalizePlan(raw: string | null | undefined): LicensePlan {
  const p = (raw || '').toLowerCase();
  if (p === 'pro' || p === 'professional' || p === 'enterprise') return 'pro';
  if (p === 'dev' || p === 'development' || p === 'internal') return 'dev';
  return 'free';
}

/**
 * @param featureId — id trong FEATURE_MIN_PLAN
 * @param plan — plan user (từ token/server). Mặc định 'dev' = full.
 */
export function canUse(featureId: FeatureId, plan: LicensePlan | string = 'dev'): boolean {
  if (!FEATURE_GATING_ENABLED) return true;
  const need = FEATURE_MIN_PLAN[featureId];
  if (!need) return true;
  const have = typeof plan === 'string' ? normalizePlan(plan) : plan;
  return PLAN_RANK[have] >= PLAN_RANK[need];
}

/** Home tool focusFeature / lockedMode → feature id (best-effort). */
export function featureIdForFocus(focusOrMode: string): FeatureId | null {
  const map: Record<string, FeatureId> = {
    encrypt: 'pdf.encrypt',
    metadata: 'pdf.metadata',
    office_convert: 'pdf.office_convert',
    optimize: 'pdf.optimize',
    watermark: 'pdf.watermark',
    split: 'pdf.split',
    pages: 'pdf.pages',
    merge: 'pdf.merge',
    booklet: 'impo.booklet',
    nup: 'impo.nup',
    sticker_imposer: 'impo.diecut',
    cnc_imposer: 'impo.cnc',
    numbering: 'vdp.numbering',
    datamerge: 'vdp.datamerge',
    preflight: 'print.preflight',
  };
  return map[focusOrMode] ?? null;
}
