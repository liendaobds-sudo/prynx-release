import { useAuthStore } from '../../stores/useAuthStore';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * TrialExpiryBanner: thẻ nhắc nhỏ dạng nổi (không chặn thao tác) khi license sắp
 * hết hạn. Dùng remainingDays do verify_license trả về. Đóng được; nhưng khi <=3
 * ngày thì luôn hiện lại để khách không bỏ lỡ cảnh báo quan trọng.
 * UIUX (audit 2026-09-03): giới hạn kích thước và neo góc phải để không phủ menu
 * công cụ như dải full-width trước đây.
 */
const WARN_THRESHOLD_DAYS = 7; // bắt đầu nhắc khi còn <= 7 ngày
const FORCE_SHOW_DAYS = 3;     // <=3 ngày: không cho ẩn

export default function TrialExpiryBanner() {
  const { t } = useTranslation();
  const { licenseValid, remainingDays } = useAuthStore();
  const [dismissed, setDismissed] = useState(false);

  if (!licenseValid || remainingDays === null) return null;
  if (remainingDays > WARN_THRESHOLD_DAYS) return null;
  if (dismissed && remainingDays > FORCE_SHOW_DAYS) return null;

  const urgent = remainingDays <= FORCE_SHOW_DAYS;
  const dayText =
    remainingDays <= 0 ? t('misc.trialExpiryBanner:hom_nay') : t('misc.trialExpiryBanner:con_n_ngay', { n: remainingDays });

  const openRenew = async () => {
    const url = 'https://printsolutions.vn/product/prynx';
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      try { window.open(url, '_blank'); } catch { /* ignore */ }
    }
  };

  const tone = urgent
    ? {
      border: 'border-red-200 dark:border-red-400/40',
      icon: 'bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300',
      action: 'bg-app-danger hover:bg-red-700',
    }
    : {
      border: 'border-amber-200 dark:border-amber-400/40',
      icon: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
      // Nền amber-700 giữ tương phản đủ rõ cho chữ nhỏ trên nền sáng.
      action: 'bg-amber-700 hover:bg-amber-800',
    };

  // Chừa một lane phía dưới cho ToastViewport (z-toast) để hai loại thông báo
  // không chồng lên nhau; vị trí này cũng nằm ngoài titlebar/menu.
  return (
    <aside
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`fixed bottom-20 right-4 z-modal w-[min(360px,calc(100vw-2rem))] rounded-app-xl border bg-app-2 p-3.5 shadow-lg animate-fade-in ${tone.border}`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-app-md text-lg ${tone.icon}`} aria-hidden="true">
          {urgent ? '⚠️' : '⏳'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-app-text-1">
            {t('misc.trialExpiryBanner:sap_het_han', { dayText })}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={openRenew}
              className={`flex h-8 flex-1 items-center justify-center rounded-app-md px-3 text-[12px] font-semibold text-white transition-colors focus-visible:ring-2 focus-visible:ring-app-accent ${tone.action}`}
            >
              {t('misc.trialExpiryBanner:gia_han_ngay')}
            </button>
            {!urgent && (
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="flex h-8 items-center justify-center rounded-app-md border border-app-line px-3 text-[12px] font-semibold text-app-text-2 transition-colors hover:bg-app-3 hover:text-app-text-1 focus-visible:ring-2 focus-visible:ring-app-accent"
              >
                {t('misc.trialExpiryBanner:de_sau')}
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
