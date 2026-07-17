import { useAuthStore } from '../../stores/useAuthStore';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ChangeLicenseKeyPanel from './ChangeLicenseKeyPanel';

/**
 * RevocationCountdown: panel NỔI (không che toàn màn, KHÔNG chặn thao tác) hiện khi
 * server báo key bị thu hồi/hết hạn. Cho khách REVOKE_GRACE_MS để lưu file đang làm dở
 * trước khi khóa cứng.
 */
function RevocationCountdown() {
  const { t } = useTranslation();
  const { revokeDeadline, revokeReason } = useAuthStore();
  const [now, setNow] = useState(Date.now());
  const [showChangeKey, setShowChangeKey] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!revokeDeadline) return null;
  const msLeft = Math.max(0, revokeDeadline - now);
  const mm = String(Math.floor(msLeft / 60000)).padStart(2, '0');
  const ss = String(Math.floor((msLeft % 60000) / 1000)).padStart(2, '0');

  return (
    <div style={{
      position: 'fixed',
      top: '20px',
      right: '20px',
      zIndex: 99998,
      maxWidth: '380px',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
      borderRadius: '14px',
      padding: '20px 22px',
      border: '1px solid #f59e0b',
      boxShadow: '0 8px 32px rgba(245,158,11,0.35)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <span style={{ fontSize: '24px' }}>⚠️</span>
        <h3 style={{ color: '#fff', fontSize: '15px', fontWeight: 600, margin: 0 }}>
          {t('misc.licenseLockOverlay:ban_quyen_sap_bi_khoa')}
        </h3>
      </div>
      <p style={{ color: '#a0aec0', fontSize: '13px', lineHeight: 1.55, margin: '0 0 12px 0' }}>
        {revokeReason}
      </p>
      <p style={{ color: '#fbbf24', fontSize: '13px', fontWeight: 600, margin: '0 0 4px 0' }}>
        {t('misc.licenseLockOverlay:vui_long_luu_cong_viec_dang_lam_ngay')}
      </p>
      <div style={{
        fontSize: '32px', fontWeight: 700, color: '#fff',
        fontVariantNumeric: 'tabular-nums', letterSpacing: '2px', textAlign: 'center',
        margin: '6px 0',
      }}>
        {mm}:{ss}
      </div>
      {!showChangeKey ? (
        <button
          type="button"
          onClick={() => setShowChangeKey(true)}
          style={{
            width: '100%', marginTop: '10px',
            background: 'transparent', color: '#93c5fd',
            border: '1px solid rgba(147,197,253,0.4)', borderRadius: '8px',
            padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('misc.licenseLockOverlay:nhap_license_key_khac')}
        </button>
      ) : (
        <div style={{ marginTop: '12px' }}>
          <ChangeLicenseKeyPanel
            variant="dark"
            onCancel={() => setShowChangeKey(false)}
            onSuccess={() => setShowChangeKey(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * LicenseLockOverlay: khóa cứng khi offline > ngưỡng / license thu hồi.
 * P2-B: cho nhập license key khác để recovery mà không gỡ app.
 */
export default function LicenseLockOverlay() {
  const { t } = useTranslation();
  const { isLicenseLocked, lockReason, retryValidation, isRevoking } = useAuthStore();
  const [isRetrying, setIsRetrying] = useState(false);
  const [showChangeKey, setShowChangeKey] = useState(false);

  if (!isLicenseLocked) {
    return isRevoking ? <RevocationCountdown /> : null;
  }

  const handleRetry = async () => {
    setIsRetrying(true);
    await retryValidation();
    setIsRetrying(false);
  };

  const isLicense = lockReason.includes('Bản quyền');
  const isExpired = lockReason.includes('hết hạn');
  const isBlocked = lockReason.includes('bị chặn');
  const isSevere = isLicense || isBlocked;

  const title = isLicense
    ? (isExpired ? t('misc.licenseLockOverlay:ban_quyen_da_het_han') : t('misc.licenseLockOverlay:ban_quyen_da_bi_thu_hoi'))
    : (isBlocked ? t('misc.licenseLockOverlay:phat_hien_su_co_ket_noi') : t('misc.licenseLockOverlay:can_ket_noi_mang'));
  const icon = isLicense ? '⛔' : (isBlocked ? '🚫' : '🔒');

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.85)',
      backdropFilter: 'blur(12px)',
    }}>
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        borderRadius: '16px',
        padding: '40px',
        maxWidth: showChangeKey ? '440px' : '460px',
        width: '90%',
        textAlign: showChangeKey ? 'left' : 'center',
        border: `1px solid ${isSevere ? '#ef4444' : '#f59e0b'}`,
        boxShadow: `0 0 40px ${isSevere ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'}`,
      }}>
        {!showChangeKey ? (
          <>
            <div style={{ fontSize: '48px', marginBottom: '16px', textAlign: 'center' }}>
              {icon}
            </div>
            <h2 style={{
              color: '#fff',
              fontSize: '20px',
              fontWeight: 600,
              margin: '0 0 12px 0',
              textAlign: 'center',
            }}>
              {title}
            </h2>
            <p style={{
              color: '#a0aec0',
              fontSize: '14px',
              lineHeight: '1.6',
              margin: '0 0 24px 0',
              textAlign: 'center',
            }}>
              {lockReason}
            </p>
            <p style={{
              color: '#64748b',
              fontSize: '12px',
              margin: '0 0 20px 0',
              textAlign: 'center',
            }}>
              {isRetrying
                ? t('misc.licenseLockOverlay:dang_kiem_tra')
                : (isLicense
                    ? t('misc.licenseLockOverlay:neu_ban_vua_gia_han_mo_khoa_bam_thu_lai')
                    : t('misc.licenseLockOverlay:he_thong_tu_dong_kiem_tra_dinh_ky'))}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'stretch' }}>
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                style={{
                  background: isRetrying
                    ? '#374151'
                    : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '12px 32px',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: isRetrying ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: isRetrying ? 0.6 : 1,
                }}
              >
                {isRetrying ? t('misc.licenseLockOverlay:dang_thu') : t('misc.licenseLockOverlay:thu_lai_ngay')}
              </button>
              <button
                type="button"
                onClick={() => setShowChangeKey(true)}
                style={{
                  background: 'transparent',
                  color: '#93c5fd',
                  border: '1px solid rgba(147,197,253,0.35)',
                  borderRadius: '10px',
                  padding: '11px 24px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {t('misc.licenseLockOverlay:nhap_license_key_khac')}
              </button>
            </div>
            {isBlocked && (
              <p style={{
                color: '#f87171',
                fontSize: '12px',
                marginTop: '16px',
                lineHeight: '1.5',
                textAlign: 'center',
              }}>
                {t('misc.licenseLockOverlay:kiem_tra_ket_noi_mang_hoac_cai_dat')}
              </p>
            )}
          </>
        ) : (
          <>
            <h2 style={{
              color: '#fff',
              fontSize: '17px',
              fontWeight: 600,
              margin: '0 0 8px 0',
            }}>
              {t('misc.licenseLockOverlay:nhap_license_key_khac')}
            </h2>
            <p style={{
              color: '#94a3b8',
              fontSize: '12px',
              lineHeight: 1.5,
              margin: '0 0 16px 0',
            }}>
              {t('misc.licenseLockOverlay:doi_key_recovery_hint')}
            </p>
            <ChangeLicenseKeyPanel
              variant="dark"
              onCancel={() => setShowChangeKey(false)}
              onSuccess={() => setShowChangeKey(false)}
            />
          </>
        )}
      </div>
    </div>
  );
}
