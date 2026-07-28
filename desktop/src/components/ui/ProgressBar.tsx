import { useTranslation } from 'react-i18next';

/**
 * UIUX (audit 2026-07-27 §M-3/§D-07): thanh tiến trình dùng chung cho tác vụ dài.
 *
 * Trước đây mỗi luồng một kiểu: Compare có % nhưng không hủy được, VDP hủy được
 * nhưng chỉ một dòng text, Shuffle/Resize là spinner tĩnh. Component này gom về
 * một khuôn: % thật khi biết processed/total, thanh chạy vô định khi không;
 * nút Hủy CHỈ hiện khi luồng đó thực sự hủy được (có onCancel).
 */
export interface ProgressBarProps {
  /** Dòng mô tả bước hiện tại, vd "Đang xử lý dữ liệu: 12 / 200 trang..." */
  message: string;
  /** Số đơn vị đã xong — bỏ trống nếu không biết (thanh sẽ chạy vô định) */
  processed?: number;
  /** Tổng số đơn vị */
  total?: number;
  /** Có thì mới hiện nút Hủy — chỉ truyền khi hủy là HỦY THẬT phía backend */
  onCancel?: () => void;
  className?: string;
}

export function ProgressBar({ message, processed, total, onCancel, className }: ProgressBarProps) {
  const { t } = useTranslation();
  const hasRatio = typeof processed === 'number' && typeof total === 'number' && total > 0;
  const percent = hasRatio ? Math.min(100, Math.round((processed! / total!) * 100)) : null;

  return (
    <div className={`w-full ${className || ''}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[12px] text-app-text-2 truncate" title={message}>{message}</span>
        <span className="flex items-center gap-2 shrink-0">
          {percent !== null && (
            <span className="num text-[12px] font-semibold text-app-text-1">{percent}%</span>
          )}
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-[12px] font-medium text-app-danger hover:underline underline-offset-2"
            >
              {t('shell:huy', 'Hủy')}
            </button>
          )}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-app-3 overflow-hidden" role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        {percent !== null ? (
          <div
            className="h-full rounded-full bg-app-accent transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        ) : (
          /* Vô định: dải 40% chạy qua lại (tắt tự động khi perf-low/reduced-motion) */
          <div className="h-full w-2/5 rounded-full bg-app-accent animate-progress-indeterminate" />
        )}
      </div>
    </div>
  );
}
