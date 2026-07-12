import { useTranslation } from 'react-i18next';
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
          <div className="text-4xl">✅</div>
        ) : isFailed ? (
          <div className="text-4xl">❌</div>
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
        <span className="text-slate-500">
          {totalPages > 0 ? `Trang ${currentPage}/${totalPages}` : t('misc.progressTracker:chuan_bi')}
        </span>
        <span
          className={`font-semibold ${
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
