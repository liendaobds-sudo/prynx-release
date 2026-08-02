/** Danh mục quyền Free/Pro duy nhất của PrynX. */
export type LicensePlan = 'free' | 'pro' | 'dev';

export const FEATURE_CATALOG = {
  'pdf.shuffle': { minPlan: 'free', label: 'Xáo trộn trang' },
  'pdf.resize': { minPlan: 'free', label: 'Co giãn trang' },
  'pdf.split': { minPlan: 'free', label: 'Tách PDF' },
  'pdf.pages': { minPlan: 'free', label: 'Quản lý trang' },
  'pdf.merge': { minPlan: 'free', label: 'Ghép PDF' },
  'pdf.encrypt': { minPlan: 'free', label: 'Khóa PDF' },
  'pdf.decrypt': { minPlan: 'free', label: 'Mở khóa PDF' },
  'pdf.metadata': { minPlan: 'free', label: 'Metadata PDF' },
  'pdf.optimize': { minPlan: 'free', label: 'Tối ưu PDF cơ bản' },
  'pdf.watermark': { minPlan: 'free', label: 'Watermark' },
  'pdf.header_footer': { minPlan: 'free', label: 'Header & Footer' },
  'pdf.office_convert': { minPlan: 'free', label: 'Office sang PDF một file' },
  'qc.compare_text': { minPlan: 'free', label: 'So sánh văn bản' },
  'pdf.resize_batch': { minPlan: 'pro', label: 'Resize hàng loạt' },
  'pdf.office_batch': { minPlan: 'pro', label: 'Office sang PDF hàng loạt' },
  'pdf.optimize_advanced': { minPlan: 'pro', label: 'Tối ưu PDF nâng cao' },
  'pdf.trim_shift': { minPlan: 'pro', label: 'Trim & Shift' },
  'prepress.preflight': { minPlan: 'pro', label: 'Preflight chuẩn in' },
  'prepress.convert_colors': { minPlan: 'pro', label: 'Chuyển hệ màu' },
  'prepress.hairlines': { minPlan: 'pro', label: 'Sửa nét mảnh' },
  'prepress.trapping': { minPlan: 'pro', label: 'Trapping' },
  'prepress.cutline': { minPlan: 'pro', label: 'Bù xén và đường cắt' },
  'prepress.pdfx': { minPlan: 'pro', label: 'Xuất PDF/X' },
  'prepress.paper_library': { minPlan: 'pro', label: 'Thư viện vật tư in' },
  'vdp.datamerge': { minPlan: 'pro', label: 'Trộn dữ liệu VDP' },
  'vdp.numbering': { minPlan: 'pro', label: 'Nhảy số tự động' },
  'vdp.cover_numbering': { minPlan: 'pro', label: 'Chạy số bìa' },
  'impo.booklet': { minPlan: 'pro', label: 'Bình sách và tạp chí' },
  'impo.nup': { minPlan: 'pro', label: 'Bình cắt xén N-Up' },
  'impo.diecut': { minPlan: 'pro', label: 'Bình tem bế' },
  'impo.cnc': { minPlan: 'pro', label: 'Bình bế rớt/CNC' },
  'packaging.dieline': { minPlan: 'pro', label: 'Khuôn bế bao bì' },
  'util.bgremover': { minPlan: 'pro', label: 'Tách nền' },
  'util.upscale': { minPlan: 'pro', label: 'AI Upscale' },
  'util.logo_rebuild': { minPlan: 'pro', label: 'Phục hồi & Vector hóa Logo' },
  'qc.compare_pdf': { minPlan: 'pro', label: 'So sánh PDF in ấn' },
} as const satisfies Record<string, { minPlan: LicensePlan; label: string }>;

export type FeatureId = keyof typeof FEATURE_CATALOG;
export const FEATURE_MIN_PLAN: Record<FeatureId, LicensePlan> = Object.fromEntries(
  Object.entries(FEATURE_CATALOG).map(([id, value]) => [id, value.minPlan]),
) as Record<FeatureId, LicensePlan>;

/** Bật sau khi server đã phát plan/features cho key Free. */
export const FEATURE_GATING_ENABLED = import.meta.env.VITE_FEATURE_GATING_ENABLED === 'true';
const PLAN_RANK: Record<LicensePlan, number> = { free: 1, pro: 2, dev: 99 };

export function normalizePlan(raw: string | null | undefined): LicensePlan {
  const plan = (raw || '').trim().toLowerCase();
  if (['pro', 'professional', 'enterprise', 'paid'].includes(plan)) return 'pro';
  if (['dev', 'development', 'internal', 'admin'].includes(plan)) return 'dev';
  return 'free';
}

export function isProFeature(featureId: FeatureId): boolean {
  return FEATURE_MIN_PLAN[featureId] === 'pro';
}

/** features=null là key kiểu cũ: xét theo plan để giữ tương thích ngược. */
export function hasFeatureAccess(featureId: FeatureId, plan: LicensePlan | string, features: readonly string[] | null = null): boolean {
  const have = normalizePlan(plan);
  if (have === 'dev' || have === 'pro') return true;
  if (features?.includes('*') || features?.includes(featureId)) return true;
  return PLAN_RANK[have] >= PLAN_RANK[FEATURE_MIN_PLAN[featureId]];
}

export function canUse(featureId: FeatureId, plan: LicensePlan | string = 'free', features: readonly string[] | null = null): boolean {
  return !FEATURE_GATING_ENABLED || hasFeatureAccess(featureId, plan, features);
}

/** toolRegistry focusFeature/lockedMode/id -> feature id ổn định. */
export function featureIdForFocus(key: string): FeatureId | null {
  const map: Record<string, FeatureId> = {
    shuffle: 'pdf.shuffle', resize: 'pdf.resize', trim_shift: 'pdf.trim_shift',
    split: 'pdf.split', pages: 'pdf.pages', combine_pdf: 'pdf.merge', merge: 'pdf.merge',
    encrypt: 'pdf.encrypt', metadata: 'pdf.metadata', optimize: 'pdf.optimize',
    watermark: 'pdf.watermark', stick_text_number: 'pdf.header_footer', office_convert: 'pdf.office_convert',
    preflight: 'prepress.preflight', convertcolors: 'prepress.convert_colors', hairlines: 'prepress.hairlines',
    trapping: 'prepress.trapping', sticker: 'prepress.cutline', pdfx: 'prepress.pdfx',
    datamerge: 'vdp.datamerge', numbering: 'vdp.numbering', cover_numbering: 'vdp.cover_numbering',
    booklet: 'impo.booklet', nup: 'impo.nup', sticker_imposer: 'impo.diecut', cnc_imposer: 'impo.cnc',
    dieline: 'packaging.dieline', paper_library: 'prepress.paper_library',
    bgremover: 'util.bgremover', upscale: 'util.upscale', logo_rebuild: 'util.logo_rebuild',
    compare_pdf: 'qc.compare_pdf', compare_text: 'qc.compare_text',
  };
  return map[key] ?? null;
}
