import { useAuthStore } from '../../stores/useAuthStore';
import { useState } from 'react';

/**
 * TrialExpiryBanner: dải nhắc nhẹ (KHÔNG chặn) khi license sắp hết hạn.
 * Dùng remainingDays do verify_license trả về. Đóng được; nhưng khi <=3 ngày
 * thì luôn hiện lại để khách không bỏ lỡ (tránh gián đoạn công việc khi hết hạn).
 */
const WARN_THRESHOLD_DAYS = 7; // bắt đầu nhắc khi còn <= 7 ngày
const FORCE_SHOW_DAYS = 3;     // <=3 ngày: không cho ẩn

export default function TrialExpiryBanner() {
  const { licenseValid, remainingDays } = useAuthStore();
  const [dismissed, setDismissed] = useState(false);

  if (!licenseValid || remainingDays === null) return null;
  if (remainingDays > WARN_THRESHOLD_DAYS) return null;
  if (dismissed && remainingDays > FORCE_SHOW_DAYS) return null;

  const urgent = remainingDays <= FORCE_SHOW_DAYS;
  const dayText =
    remainingDays <= 0 ? 'hôm nay' : `còn ${remainingDays} ngày`;

  const openRenew = async () => {
    const url = 'https://printsolutions.vn/product/prynx';
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      try { window.open(url, '_blank'); } catch { /* ignore */ }
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: '40px', left: 0, right: 0,
      zIndex: 9000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '14px',
      padding: '8px 16px',
      fontSize: '13px',
      fontWeight: 500,
      color: '#fff',
      background: urgent
        ? 'linear-gradient(90deg, #b91c1c 0%, #dc2626 100%)'
        : 'linear-gradient(90deg, #b45309 0%, #d97706 100%)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
    }}>
      <span>
        {urgent ? '⚠️' : '⏳'} Bản quyền của bạn sắp hết hạn ({dayText}). Gia hạn sớm để không gián đoạn công việc.
      </span>
      <button
        onClick={openRenew}
        style={{
          background: '#fff',
          color: urgent ? '#b91c1c' : '#b45309',
          border: 'none',
          borderRadius: '6px',
          padding: '4px 14px',
          fontSize: '12px',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        Gia hạn ngay
      </button>
      {!urgent && (
        <button
          onClick={() => setDismissed(true)}
          style={{
            background: 'rgba(255,255,255,0.2)',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            padding: '3px 10px',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          Để sau
        </button>
      )}
    </div>
  );
}
