import { isTransientLicenseOutcome, useAuthStore } from '../../stores/useAuthStore';
import { readLicenseTokenClaims } from '../../stores/licenseToken';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChangeLicenseKeyPanel from './ChangeLicenseKeyPanel';

/**
 * RevocationCountdown: panel nổi (không che toàn màn, không chặn thao tác) hiện khi
 * server báo key bị thu hồi/hết hạn. Cho khách REVOKE_GRACE_MS để lưu file đang làm dở
 * trước khi khóa cứng. UIUX (audit 2026-09-03): theo token sáng/tối chung của app.
 */
function RevocationCountdown() {
  const { t } = useTranslation();
  const { revokeDeadline, revokeReason } = useAuthStore();
  const [now, setNow] = useState(() => Date.now());
  const [showChangeKey, setShowChangeKey] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!revokeDeadline) return null;
  const msLeft = Math.max(0, revokeDeadline - now);
  const mm = String(Math.floor(msLeft / 60000)).padStart(2, '0');
  const ss = String(Math.floor((msLeft % 60000) / 1000)).padStart(2, '0');

  // UIUX (audit 2026-09-03): chừa lane bottom cho ToastViewport/update card.
  return (
    <aside
      role="alert"
      aria-labelledby="license-revoke-title"
      aria-describedby="license-revoke-reason"
      className="fixed bottom-20 right-4 z-modal w-[min(380px,calc(100vw-2rem))] rounded-app-xl border border-amber-200 bg-app-2 p-4 shadow-xl animate-fade-in dark:border-amber-400/40"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-app-md bg-amber-50 text-lg text-amber-700 dark:bg-amber-950/30 dark:text-amber-300" aria-hidden="true">
          ⚠️
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="license-revoke-title" className="text-[14px] font-semibold leading-snug text-app-text-1">
            {t('misc.licenseLockOverlay:ban_quyen_sap_bi_khoa')}
          </h3>
          <p id="license-revoke-reason" className="mt-1 text-[12px] leading-relaxed text-app-text-2">
            {revokeReason}
          </p>
        </div>
      </div>

      <p className="mt-3 text-[12px] font-semibold text-app-warning">
        {t('misc.licenseLockOverlay:vui_long_luu_cong_viec_dang_lam_ngay')}
      </p>
      <div
        className="num my-1.5 text-center text-2xl font-bold tracking-[0.16em] text-app-text-1"
        aria-label={`${mm}:${ss}`}
        aria-live="off"
      >
        {mm}:{ss}
      </div>

      {!showChangeKey ? (
        <button
          type="button"
          onClick={() => setShowChangeKey(true)}
          className="mt-2.5 flex h-9 w-full items-center justify-center rounded-app-md border border-app-line px-3 text-[12px] font-semibold text-app-text-2 transition-colors hover:bg-app-3 hover:text-app-text-1 focus-visible:ring-2 focus-visible:ring-app-accent"
        >
          {t('misc.licenseLockOverlay:nhap_license_key_khac')}
        </button>
      ) : (
        <div className="mt-3 border-t border-app-line-soft pt-3">
          <ChangeLicenseKeyPanel
            variant="light"
            onCancel={() => setShowChangeKey(false)}
            onSuccess={() => setShowChangeKey(false)}
          />
        </div>
      )}
    </aside>
  );
}

/**
 * LicenseLockOverlay: khóa cứng khi offline quá ngưỡng / license bị thu hồi.
 * P2-B: cho nhập license key khác để recovery mà không gỡ app. UIUX (audit 2026-09-03):
 * bỏ palette xanh đậm riêng, giữ modal chặn rõ ràng nhưng đồng bộ bề mặt app.
 */
export default function LicenseLockOverlay() {
  const { t } = useTranslation();
  const {
    isLicenseLocked,
    lockReason,
    retryValidation,
    isRevoking,
    licenseValid,
    licenseToken,
    licenseValidationOutcome,
  } = useAuthStore();
  const [isRetrying, setIsRetrying] = useState(false);
  const [showChangeKey, setShowChangeKey] = useState(false);
  const [offlineNow, setOfflineNow] = useState(() => Date.now());
  const isOfflineSession = licenseValid
    && (licenseValidationOutcome === 'valid_offline'
      || licenseValidationOutcome === 'rate_limited_offline');
  const offlineClaims = isOfflineSession ? readLicenseTokenClaims(licenseToken) : null;

  useEffect(() => {
    if (!isOfflineSession) return;
    const timer = setInterval(() => setOfflineNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [isOfflineSession]);

  const offlineMsLeft = offlineClaims
    ? Math.max(0, offlineClaims.exp * 1000 - offlineNow)
    : null;
  const offlineHoursLeft = offlineMsLeft === null
    ? null
    : Math.floor(offlineMsLeft / (60 * 60 * 1000));
  const offlineMinutesLeft = offlineMsLeft === null
    ? null
    : Math.floor((offlineMsLeft % (60 * 60 * 1000)) / (60 * 1000));

  if (!isLicenseLocked) {
    if (isRevoking) return <RevocationCountdown />;
    if (isOfflineSession) {
      return (
        <aside
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-20 right-4 z-modal w-[min(400px,calc(100vw-2rem))] rounded-app-xl border border-sky-200 bg-app-2 p-3.5 shadow-lg animate-fade-in dark:border-sky-400/40"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-app-md bg-sky-50 text-lg text-sky-700 dark:bg-sky-950/30 dark:text-sky-300" aria-hidden="true">
              ☁️
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-semibold leading-snug text-app-text-1">
                {t('misc.licenseLockOverlay:dang_dung_phien_offline')}
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-app-text-2">
                {offlineHoursLeft === null
                  ? t('misc.licenseLockOverlay:offline_dang_cho_xac_minh')
                  : offlineHoursLeft === 0 && offlineMinutesLeft === 0
                    ? t('misc.licenseLockOverlay:offline_duoi_mot_phut')
                    : t('misc.licenseLockOverlay:offline_con_thoi_gian', {
                      hours: offlineHoursLeft,
                      minutes: offlineMinutesLeft,
                    })}
              </p>
            </div>
          </div>
        </aside>
      );
    }
    return null;
  }

  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      await retryValidation();
    } catch {
      // Retry là đường phục hồi; lỗi bất ngờ không được làm rơi unhandled
      // rejection hoặc kẹt nút loading. Native/license gate vẫn giữ nguyên.
      console.warn('[AUTH] License retry failed unexpectedly');
    } finally {
      setIsRetrying(false);
    }
  };

  // SEC (audit 2026-09-05 startup): outcome là enum authority; không suy loại lỗi
  // từ chữ hoa/thường trong câu hiển thị (DEVICE_LIMIT từng bị ghi nhầm là lỗi mạng).
  const isDeviceLimit = licenseValidationOutcome === 'device_limit';
  const isServerRejected = licenseValidationOutcome === 'server_rejected';
  const isTransientValidation = isTransientLicenseOutcome(licenseValidationOutcome);

  // Lỗi mạng/anchor tạm thời không phải license bị thu hồi. Giữ native
  // gate fail-closed nhưng chỉ hiện banner không chặn để workspace không bị
  // phủ toàn màn hình trong lúc retry tự động (SEC (audit 2026-09-08 §SEC.LICUX.1–2)).
  if (isTransientValidation) {
    return (
      <aside
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="fixed bottom-20 right-4 z-modal w-[min(420px,calc(100vw-2rem))] rounded-app-xl border border-amber-200 bg-app-2 p-4 shadow-xl animate-fade-in dark:border-amber-400/40"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-app-md bg-amber-50 text-lg text-amber-700 dark:bg-amber-950/30 dark:text-amber-300" aria-hidden="true">
            🔄
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold leading-snug text-app-text-1">
              {t('misc.licenseLockOverlay:khong_the_xac_minh_ban_quyen')}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-app-text-2">{lockReason}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-app-text-3">
              {isRetrying
                ? t('misc.licenseLockOverlay:dang_kiem_tra')
                : t('misc.licenseLockOverlay:he_thong_tu_dong_kiem_tra_dinh_ky')}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              disabled={isRetrying}
              className="mt-3 flex h-9 w-full items-center justify-center rounded-app-md bg-app-accent px-4 text-[12px] font-semibold text-white transition-colors hover:bg-app-accent-hover disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-app-accent"
            >
              {isRetrying
                ? t('misc.licenseLockOverlay:dang_thu')
                : t('misc.licenseLockOverlay:thu_lai_ngay')}
            </button>
          </div>
        </div>
      </aside>
    );
  }

  const isLicense = isDeviceLimit || isServerRejected;
  // `server_rejected` hiện gộp thu hồi và hết hạn; chỉ phân biệt hai tiêu đề
  // trong đúng nhóm terminal này, tuyệt đối không suy từ câu lỗi tạm thời.
  const isExpired = isServerRejected
    && lockReason.toLocaleLowerCase('vi').includes('hết hạn');
  const isBlocked = lockReason.toLocaleLowerCase('vi').includes('bị chặn');
  const isSevere = isLicense || isBlocked;

  const title = isDeviceLimit
    ? t('misc.licenseLockOverlay:dat_gioi_han_thiet_bi')
    : isServerRejected
      ? (isExpired ? t('misc.licenseLockOverlay:ban_quyen_da_het_han') : t('misc.licenseLockOverlay:ban_quyen_da_bi_thu_hoi'))
      : isBlocked
        ? t('misc.licenseLockOverlay:phat_hien_su_co_ket_noi')
        : t('misc.licenseLockOverlay:khong_the_xac_minh_ban_quyen');
  const icon = isLicense ? '⛔' : (isBlocked ? '🚫' : '🔒');
  const tone = isSevere
    ? {
      icon: 'bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300',
    }
    : {
      icon: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300',
    };

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-900/25 p-4 backdrop-blur-sm dark:bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="license-lock-title"
        aria-describedby="license-lock-description"
        aria-busy={isRetrying}
        className={`relative w-full ${showChangeKey ? 'max-w-[440px]' : 'max-w-[460px]'} overflow-hidden rounded-app-xl border border-app-line bg-app-2 shadow-2xl animate-fade-in`}
      >
        <div className={`p-6 sm:p-8 ${showChangeKey ? 'text-left' : 'text-center'}`}>
          {!showChangeKey ? (
            <>
              <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl ${tone.icon}`} aria-hidden="true">
                {icon}
              </div>
              <h2 id="license-lock-title" className="mb-2 text-xl font-bold tracking-tight text-app-text-1">
                {title}
              </h2>
              <p id="license-lock-description" className="mb-5 text-sm leading-relaxed text-app-text-2">
                {lockReason}
              </p>
              <p
                className="mb-5 text-xs leading-relaxed text-app-text-3"
                aria-live="polite"
              >
                {isRetrying
                  ? t('misc.licenseLockOverlay:dang_kiem_tra')
                  : (isLicense
                    ? t('misc.licenseLockOverlay:neu_ban_vua_gia_han_mo_khoa_bam_thu_lai')
                    : t('misc.licenseLockOverlay:he_thong_tu_dong_kiem_tra_dinh_ky'))}
              </p>
              <div className="flex flex-col gap-2.5">
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className={`flex h-11 items-center justify-center rounded-app-md px-6 text-sm font-semibold text-white transition-colors focus-visible:ring-2 focus-visible:ring-app-accent ${isRetrying ? 'cursor-not-allowed bg-app-3 text-app-text-3' : 'bg-app-accent hover:bg-app-accent-hover'}`}
                >
                  {isRetrying ? t('misc.licenseLockOverlay:dang_thu') : t('misc.licenseLockOverlay:thu_lai_ngay')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowChangeKey(true)}
                  className="flex h-11 items-center justify-center rounded-app-md border border-app-line px-6 text-sm font-semibold text-app-text-2 transition-colors hover:bg-app-3 hover:text-app-text-1 focus-visible:ring-2 focus-visible:ring-app-accent"
                >
                  {t('misc.licenseLockOverlay:nhap_license_key_khac')}
                </button>
              </div>
              {isBlocked && (
                <p className="mt-4 text-xs leading-relaxed text-app-danger">
                  {t('misc.licenseLockOverlay:kiem_tra_ket_noi_mang_hoac_cai_dat')}
                </p>
              )}
            </>
          ) : (
            <>
              <h2 id="license-lock-title" className="mb-2 text-lg font-bold tracking-tight text-app-text-1">
                {t('misc.licenseLockOverlay:nhap_license_key_khac')}
              </h2>
              <p id="license-lock-description" className="mb-5 text-xs leading-relaxed text-app-text-2">
                {t('misc.licenseLockOverlay:doi_key_recovery_hint')}
              </p>
              <ChangeLicenseKeyPanel
                variant="light"
                onCancel={() => setShowChangeKey(false)}
                onSuccess={() => setShowChangeKey(false)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
