import { useAuthStore } from '../../stores/useAuthStore';
import { useState } from 'react';

/**
 * LicenseLockOverlay: Shown when the app is soft-locked due to
 * offline > 24h or Supabase blocking. Does NOT sign the user out.
 * Auto-retries every 30s and allows manual retry.
 * When internet returns → auto-unlocks seamlessly.
 */
export default function LicenseLockOverlay() {
  const { isLicenseLocked, lockReason, retryValidation } = useAuthStore();
  const [isRetrying, setIsRetrying] = useState(false);

  if (!isLicenseLocked) return null;

  const handleRetry = async () => {
    setIsRetrying(true);
    await retryValidation();
    setIsRetrying(false);
  };

  const isBlocked = lockReason.includes('bị chặn');

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
        maxWidth: '460px',
        width: '90%',
        textAlign: 'center',
        border: `1px solid ${isBlocked ? '#ef4444' : '#f59e0b'}`,
        boxShadow: `0 0 40px ${isBlocked ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'}`,
      }}>
        {/* Icon */}
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>
          {isBlocked ? '🚫' : '🔒'}
        </div>

        {/* Title */}
        <h2 style={{
          color: '#fff',
          fontSize: '20px',
          fontWeight: 600,
          margin: '0 0 12px 0',
        }}>
          {isBlocked ? 'Phát hiện sự cố kết nối' : 'Cần kết nối mạng'}
        </h2>

        {/* Reason */}
        <p style={{
          color: '#a0aec0',
          fontSize: '14px',
          lineHeight: '1.6',
          margin: '0 0 24px 0',
        }}>
          {lockReason}
        </p>

        {/* Auto-retry indicator */}
        <p style={{
          color: '#64748b',
          fontSize: '12px',
          margin: '0 0 20px 0',
        }}>
          {isRetrying
            ? '⏳ Đang kiểm tra kết nối...'
            : '🔄 Hệ thống tự động kiểm tra mỗi 30 giây'}
        </p>

        {/* Retry button */}
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
          {isRetrying ? 'Đang thử...' : 'Thử lại ngay'}
        </button>

        {/* Help text for blocked case */}
        {isBlocked && (
          <p style={{
            color: '#f87171',
            fontSize: '12px',
            marginTop: '16px',
            lineHeight: '1.5',
          }}>
            💡 Kiểm tra kết nối mạng hoặc cài đặt tường lửa của bạn.
          </p>
        )}
      </div>
    </div>
  );
}
