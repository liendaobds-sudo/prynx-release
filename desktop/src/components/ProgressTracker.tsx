import { useTranslation } from 'react-i18next';
// UIUX (audit 2026-07-27 §D-12): icon lucide thay emoji ✅/❌
import { Check, X } from 'lucide-react';
interface ProgressTrackerProps {
  progress: number;
  status: string;
  currentPage: number;
  totalPages: number;
  message: string;
}

export default function ProgressTracker({
  progress,
  status,
  currentPage,
  totalPages,
  message,
}: ProgressTrackerProps) {
  const { t } = useTranslation();
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';

  return (
    <div className="glass-card p-8 max-w-2xl mx-auto animate-slide-up">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        {isCompleted ? (
          // UIUX (audit 2026-07-27 §D-12): icon lucide + token màu thay emoji
          <Check className="w-10 h-10 text-app-success" />
        ) : isFailed ? (
          <X className="w-10 h-10 text-app-danger" />
        ) : (
          <div className="w-10 h-10 border-3 border-blue-400 border-t-transparent rounded-full animate-spin" />
        )}
        <div>
          <h3 className="text-lg font-bold text-white">
            {isCompleted
              ? t('misc.progressTracker:hoan_thanh')
              : isFailed
              ? t('misc.progressTracker:co_loi_xay_ra')
              : t('misc.progressTracker:dang_so_sanh')}
          </h3>
          <p className="text-sm text-slate-400">{message}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="progress-bar mb-3">
        <div
          className="progress-fill"
          style={{
            width: `${progress}%`,
            background: isFailed
              ? '#ef4444'
              : isCompleted
              ? '#22c55e'
              : undefined,
          }}
        />
      </div>

      {/* Stats */}
      <div className="flex justify-between text-sm">
        <span className="text-slate-500 num">
          {/* UIUX (audit 2026-07-27 §D-12): i18n hoá chuỗi hardcode */}
          {totalPages > 0
            ? t('misc.progressTracker:trang_x_y', 'Trang {{current}}/{{total}}', { current: currentPage, total: totalPages })
            : t('misc.progressTracker:chuan_bi')}
        </span>
        {/* UIUX (audit 2026-07-27 §D-12): class num cho con số % */}
        <span
          className={`font-semibold num ${
            isCompleted
              ? 'text-green-400'
              : isFailed
              ? 'text-red-400'
              : 'text-blue-400'
          }`}
        >
          {progress}%
        </span>
      </div>
    </div>
  );
}
