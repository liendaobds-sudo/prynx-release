import { canUse, isProFeature, type FeatureId } from '../../lib/license/features';
import { useAuthStore } from '../../stores/useAuthStore';

interface ProFeatureBadgeProps {
  featureId: FeatureId;
  className?: string;
}

/** UIUX (audit 2026-08-04 §UI.04): PRO là phân loại; ổ khoá là trạng thái chưa có quyền. */
export default function ProFeatureBadge({ featureId, className = '' }: ProFeatureBadgeProps) {
  const plan = useAuthStore((state) => state.licensePlan);
  const features = useAuthStore((state) => state.licenseFeatures);
  if (!isProFeature(featureId)) return null;

  const locked = !canUse(featureId, plan, features);
  const label = locked ? '🔒 PRO' : 'PRO';
  return (
    <span
      data-feature-id={featureId}
      data-locked={locked ? 'true' : 'false'}
      aria-label={locked ? 'Tính năng PrynX Pro đang bị khóa' : 'Tính năng PrynX Pro'}
      title={locked ? 'Cần key PrynX Pro' : 'Tính năng PrynX Pro'}
      className={`shrink-0 rounded-full bg-amber-100 dark:bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-extrabold text-amber-700 dark:text-amber-300 ${className}`}
    >
      {label}
    </span>
  );
}
