import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthStore } from '../../stores/useAuthStore';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';

export default function LoginScreen() {
  const { user, licenseKey, setLicenseKey } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [inputKey, setInputKey] = useState('');
  
  // Note: We need a product ID for Prynx. Ask the user what it is!
  const PRODUCT_ID = 'prynx'; 

  // Deep Link Listener for OAuth Callback
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let pollInterval: NodeJS.Timeout;
    
    async function processUrls(urls: string[]) {
      for (const url of urls) {
          if (url.includes('prynx://auth/callback')) {
            try {
              setLoading(true);
              const urlObj = new URL(url.replace('#', '?')); // Handle implicit flow hash as search params
              const code = urlObj.searchParams.get('code');
              const access_token = urlObj.searchParams.get('access_token');
              const refresh_token = urlObj.searchParams.get('refresh_token');
              
              if (code) {
                  const { error } = await supabase.auth.exchangeCodeForSession(code);
                  if (error) throw error;
              } else if (access_token && refresh_token) {
                  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
                  if (error) throw error;
              }
            } catch (err: any) {
              console.error('Deep link auth error:', err);
              setErrorMsg('Lỗi xử lý đăng nhập từ trình duyệt: ' + err.message);
            } finally {
              setLoading(false);
            }
          }
        }
    }

    const handleCustomEvent = (e: any) => {
        if (e.detail && e.detail.url) {
            // console.log('Deep link received via custom event:', e.detail.url);
            processUrls([e.detail.url]);
        }
    };

    async function setupDeepLink() {
      // 1. Listen via plugin
      unlisten = await onOpenUrl(async (urls) => {
        // console.log('Deep link received via plugin:', urls);
        await processUrls(urls);
      });

      // 2. Listen to custom event from SystemIntegrations
      window.addEventListener('auth-url-received', handleCustomEvent);
    }
    
    setupDeepLink();
    
    return () => {
      if (unlisten) unlisten();
      window.removeEventListener('auth-url-received', handleCustomEvent);
    };
  }, []);

  // Auto Discovery Effect
  useEffect(() => {
    if (user && !licenseKey) {
      autoDiscoverLicense();
    }
  }, [user, licenseKey]);

  const autoDiscoverLicense = async () => {
    if (!user?.email) return;
    try {
      setLoading(true);
      setErrorMsg('');
      
      const hwid = await invoke('get_hardware_id') as string;
      
      // Auto-discover using the custom function we will create
      const { data, error } = await supabase.rpc('auto_discover_license', {
        p_email: user.email,
        p_machine_id: hwid,
        p_product_id: PRODUCT_ID
      });

      if (error) {
        console.warn('[AUTO-DISCOVERY] RPC failed (maybe not created yet):', error);
        return;
      }
      
      if (data && data.success && data.key) {
        // console.log('[AUTO-DISCOVERY] Found license:', data.message);
        
        // Let's actually verify it to complete the activation in the backend
        const verifyResp = await supabase.rpc('verify_license', {
          p_license_key: data.key,
          p_machine_id: hwid,
          p_product_id: PRODUCT_ID
        });
        
        if (verifyResp.data && (verifyResp.data as any).status === 'VALID') {
            setLicenseKey(data.key);
            // Lấy token license server-ký ngay (backend cưỡng chế token) + bật heartbeat.
            const ok = await useAuthStore.getState().validateLicense();
            if (ok) useAuthStore.getState().startHeartbeat();
        }
      } else {
        // console.log('[AUTO-DISCOVERY] No active license found automatically.');
      }
    } catch (err: any) {
      console.error('Auto discovery error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Handle Google Login via Deep Link
  const handleGoogleLogin = async () => {
    try {
      setLoading(true);
      setErrorMsg('');
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          skipBrowserRedirect: true,
          redirectTo: 'prynx://auth/callback'
        }
      });
      if (error) throw error;
      
      if (data?.url) {
        // Open the URL in the system's default browser
        await open(data.url);
      } else {
        throw new Error('Không lấy được URL đăng nhập');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Lỗi đăng nhập Google');
      setLoading(false);
    }
  };

  // Handle Manual License Verification
  const handleVerifyLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputKey.trim()) return;

    try {
      setLoading(true);
      setErrorMsg('');
      
      const hwid = await invoke('get_hardware_id') as string;
      
      // Using PrintSolutions actual `verify_license` signature
      const { data, error } = await supabase.rpc('verify_license', {
        p_license_key: inputKey.trim(),
        p_machine_id: hwid,
        p_product_id: PRODUCT_ID
      });

      if (error) throw error;
      
      const res = data as any;
      if (res && res.status === 'VALID') {
        setLicenseKey(inputKey.trim());
        // Lấy token license server-ký ngay (backend cưỡng chế token) + bật heartbeat.
        const ok = await useAuthStore.getState().validateLicense();
        if (ok) useAuthStore.getState().startHeartbeat();
      } else {
        throw new Error(res?.message || 'Key không hợp lệ.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Lỗi xác thực bản quyền.');
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
          {!user ? (
            // STEP 1: LOGIN
            <div className="space-y-4">
              <div className="text-center text-sm text-slate-300 mb-6">
                Vui lòng đăng nhập để xác thực bản quyền
              </div>
              <button
                onClick={handleGoogleLogin}
                disabled={loading}
                className="w-full relative flex items-center justify-center gap-3 px-6 py-3.5 rounded-xl bg-white text-slate-800 font-semibold text-[15px] transition-all hover:bg-slate-50 hover:scale-[1.02] active:scale-[0.98] shadow-lg disabled:opacity-70 disabled:pointer-events-none"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Tiếp tục với Google
              </button>
            </div>
          ) : (
            // STEP 2: ENTER LICENSE KEY (Only shown if auto-discovery failed)
            <form onSubmit={handleVerifyLicense} className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-3 mb-6 p-3 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
                <img src={user.user_metadata?.avatar_url} alt="Avatar" className="w-10 h-10 rounded-full border border-white/20" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{user.user_metadata?.full_name || 'Người dùng'}</div>
                  <div className="text-xs text-slate-400 truncate">{user.email}</div>
                </div>
                <button type="button" onClick={() => supabase.auth.signOut()} className="p-2 text-slate-400 hover:text-white transition-colors" title="Đăng xuất">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Hãy nhập mã bản quyền (License Key) của Prynx
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                  </div>
                  <input
                    type="text"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    placeholder="Nhập mã bản quyền..."
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
                    Xác Thực <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
