import { useState } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { useTranslation } from 'react-i18next';

// ĐĂNG NHẬP GOOGLE ĐÃ GỠ (2026-08-28): key đã đi theo email nên khách chỉ cần nhập key.
// Gỡ nút Google + luồng OAuth deep link (prynx://auth/callback) cũng xoá luôn bề mặt
// session-injection (pentest §ATK.01) — không còn callback handler thì không còn chỗ
// để chèn session của kẻ tấn công. Xác minh key vẫn qua Edge Function như cũ.

function getAuthErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export default function LoginScreen() {
  const { t } = useTranslation();
  const { changeLicenseKey } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [inputKey, setInputKey] = useState('');

  // Handle Manual License Verification
  const handleVerifyLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputKey.trim()) return;

    try {
      setLoading(true);
      setErrorMsg('');
      
      // changeLicenseKey xác minh tại Edge Function trước khi lưu key vào DPAPI.
      const result = await changeLicenseKey(inputKey.trim());
      if (!result.ok) throw new Error(result.message || t('misc.login:key_khong_hop_le'));
    } catch (err: unknown) {
      setErrorMsg(getAuthErrorMessage(err, t('misc.login:loi_xac_thuc_ban_quyen')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[99999] overflow-y-auto bg-app-1 text-app-text-1">
      {/* UIUX (audit 2026-09-03): nền kích hoạt dùng token của app, bỏ ảnh nền từ
          CDN và lớp phủ xanh đậm khiến màn hình lệch hẳn khỏi giao diện sáng. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-app-accent-soft blur-3xl" />
        <div className="absolute -bottom-32 -right-20 h-80 w-80 rounded-full bg-slate-200/70 blur-3xl dark:bg-zinc-800/50" />
      </div>

      <div className="relative flex min-h-full items-center justify-center p-4 sm:p-8">
        <main
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-title"
          className="relative z-10 w-full max-w-[440px] overflow-hidden rounded-app-xl border border-app-line bg-app-2 shadow-[0_24px_70px_rgba(15,23,42,0.14)] animate-fade-in dark:shadow-[0_24px_70px_rgba(0,0,0,0.36)]"
        >
          <div className="h-1 w-full bg-app-accent" aria-hidden="true" />

          <div className="p-6 sm:p-8">
            <header className="mb-7 flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-app-lg border border-app-accent/20 bg-app-accent-soft shadow-sm">
                <img src="/logo.png" alt="" className="h-8 w-8 object-contain dark:invert" />
              </div>
              <div className="min-w-0 pt-0.5">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-app-text-3">PrynX</p>
                <h1 id="login-title" className="mt-1 text-xl font-bold tracking-tight text-app-text-1">
                  {t('misc.login:hay_nhap_ma_ban_quyen_license_key_cua')}
                </h1>
              </div>
            </header>

            <div className="mb-6 flex items-start gap-3 rounded-app-lg border border-app-line-soft bg-app-3 px-3.5 py-3">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 shrink-0 text-app-accent" aria-hidden="true">
                <path d="M12 3 4.5 6.5v5.2c0 4.5 3.1 7.6 7.5 9.3 4.4-1.7 7.5-4.8 7.5-9.3V6.5L12 3Z" />
                <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="text-xs leading-relaxed text-app-text-2">
                {t('misc.about:dan_hoac_nhap_key')}
              </p>
            </div>

            {errorMsg && (
              <div
                role="alert"
                aria-live="polite"
                className="mb-5 flex items-start gap-2.5 rounded-app-md border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-950/20 dark:text-red-300"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="leading-relaxed">{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleVerifyLicense} className="space-y-4 animate-fade-in" aria-busy={loading}>
              <div>
                <label htmlFor="prynx-license-key" className="mb-2 block text-sm font-semibold text-app-text-1">
                  {t('misc.about:nhap_license_key')}
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-app-text-3">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                  <input
                    id="prynx-license-key"
                    type="text"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    placeholder={t('misc.login:nhap_ma_ban_quyen')}
                    className="h-12 w-full rounded-app-md border border-app-line bg-app-2 pl-10 pr-3.5 text-sm font-mono tracking-[0.08em] text-app-text-1 shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-app-text-3 focus:border-app-accent focus:ring-2 focus:ring-app-accent-soft"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !inputKey.trim()}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-app-md bg-app-accent px-4 text-[15px] font-semibold text-white shadow-sm transition-[background-color,box-shadow,transform] hover:bg-app-accent-hover hover:shadow-md active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <div role="status" className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-label={t('misc.about:dang_xac_thuc')} />
                ) : (
                  <>
                    {t('misc.login:xac_thuc')}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </>
                )}
              </button>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
