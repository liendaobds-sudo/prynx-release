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
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-900 bg-[url('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=2564&auto=format&fit=crop')] bg-cover bg-center before:absolute before:inset-0 before:bg-slate-900/80 before:backdrop-blur-sm">
      <div className="relative z-10 w-full max-w-md p-8 overflow-hidden bg-white/10 dark:bg-black/40 border border-white/20 shadow-2xl backdrop-blur-xl rounded-2xl">
        
        {/* Glow Effects */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[150%] h-32 bg-indigo-500/30 blur-[80px] rounded-full pointer-events-none"></div>

        <div className="text-center mb-8 relative z-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 mb-4 shadow-lg shadow-indigo-500/30">
            <span className="text-3xl text-white">📄</span>
          </div>
          <h2 className="text-3xl font-extrabold text-white tracking-tight">PrynX</h2>
          <p className="text-indigo-200 mt-2 text-sm">Professional PDF Imposition & Validation</p>
        </div>

        {errorMsg && (
          <div className="mb-6 p-4 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200 text-sm flex items-start gap-2 relative z-10">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="relative z-10 space-y-6">
          <form onSubmit={handleVerifyLicense} className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  {t('misc.login:hay_nhap_ma_ban_quyen_license_key_cua')}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                  </div>
                  <input
                    type="text"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    placeholder={t('misc.login:nhap_ma_ban_quyen')}
                    className="w-full bg-black/30 border border-white/10 rounded-xl py-3.5 pl-10 pr-4 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all font-mono tracking-wider"
                    autoFocus
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !inputKey.trim()}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-bold text-[15px] transition-all hover:shadow-[0_0_20px_rgba(99,102,241,0.4)] disabled:opacity-50 disabled:pointer-events-none"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                ) : (
                  <>
                    {t('misc.login:xac_thuc')} <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                  </>
                )}
              </button>
            </form>
        </div>
      </div>
    </div>
  );
}
