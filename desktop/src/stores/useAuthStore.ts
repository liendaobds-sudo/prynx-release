import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

/**
 * SECURITY PATCHES:
 * - #7+: License key stored via Windows DPAPI (CryptProtectData).
 *   Encrypted with current user's Windows login session — only the same
 *   user on the same machine can decrypt. Falls back to obfuscated localStorage.
 * - #9: Added validateLicense() for periodic heartbeat checks.
 * - #3: checkSession now also validates license key on startup.
 */

const LICENSE_STORAGE_KEY = 'prynx_lk_v2';
const HWID_STORAGE_KEY = 'prynx_hwid_cache';

// ── DPAPI-backed credential storage (primary) ──

async function saveToDPAPI(key: string): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_license', { licenseKey: key });
    return true;
  } catch {
    return false;
  }
}

async function loadFromDPAPI(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('load_license') as string;
  } catch {
    return null;
  }
}

async function deleteFromDPAPI(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_license');
  } catch { /* ignore */ }
}

// ── DPAPI-backed license TOKEN storage (C-1) ──
// Token Ed25519 do server ký được lưu mã hoá (DPAPI) để khi MỞ LẠI app lúc OFFLINE
// vẫn còn token hợp lệ gửi sidecar (backend release ép token). Token đã ràng HWID.

async function saveTokenToDPAPI(token: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_license_token', { token });
  } catch { /* ignore (dev/web) */ }
}

async function loadTokenFromDPAPI(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('load_license_token') as string;
  } catch {
    return null;
  }
}

async function deleteTokenFromDPAPI(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_license_token');
  } catch { /* ignore */ }
}

/** Đọc 'exp' (unix giây) từ token "<payload_b64url>.<sig>" và kiểm tra còn hạn (đệm 60s). */
function isLicenseTokenValid(token: string | null): boolean {
  if (!token || token.indexOf('.') < 0) return false;
  try {
    let p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const payload = JSON.parse(decodeURIComponent(escape(atob(p))));
    const exp = Number(payload?.exp || 0);
    if (!exp) return false;
    return exp * 1000 > Date.now() + 60_000;
  } catch {
    return false;
  }
}

// ── localStorage fallback (for dev mode / web mode) ──

function encodeKey(key: string): string {
  try { return btoa(unescape(encodeURIComponent(key))); } catch { return key; }
}
function decodeKey(encoded: string): string {
  try { return decodeURIComponent(escape(atob(encoded))); } catch { return encoded; }
}

function loadStoredKeySync(): string | null {
  const v2 = localStorage.getItem(LICENSE_STORAGE_KEY);
  if (v2) return decodeKey(v2);
  const v1 = localStorage.getItem('prynx_license_key');
  if (v1) {
    localStorage.setItem(LICENSE_STORAGE_KEY, encodeKey(v1));
    localStorage.removeItem('prynx_license_key');
    return v1;
  }
  return null;
}

/** Load license key: try DPAPI first, fallback to localStorage */
async function loadStoredKeyAsync(): Promise<string | null> {
  // 1. Try DPAPI (Windows encrypted storage)
  const dpapiKey = await loadFromDPAPI();
  if (dpapiKey) return dpapiKey;
  
  // 2. Fallback to localStorage (and migrate to DPAPI if possible)
  const localKey = loadStoredKeySync();
  if (localKey) {
    // Migrate: save to DPAPI and remove from localStorage
    const saved = await saveToDPAPI(localKey);
    if (saved) {
      localStorage.removeItem(LICENSE_STORAGE_KEY);
      localStorage.removeItem('prynx_license_key');
    }
    return localKey;
  }
  
  return null;
}

interface AuthState {
  user: User | null;
  session: Session | null;
  licenseKey: string | null;
  /** Token license ngắn hạn do server (edge function) ký — gắn vào request gửi sidecar. */
  licenseToken: string | null;
  /** Số ngày còn lại tới hạn dùng (do verify_license trả về). null nếu không giới hạn/chưa biết. */
  remainingDays: number | null;
  /** Mốc hết hạn (ISO) do verify_license trả về. */
  licenseExpiresAt: string | null;
  isChecking: boolean;
  licenseValid: boolean;
  lastValidated: number;
  /** Soft lock: blocks UI but does NOT sign out. Auto-unlocks when internet returns. */
  isLicenseLocked: boolean;
  lockReason: string;
  
  setUser: (user: User | null, session: Session | null) => void;
  setLicenseKey: (key: string | null) => void;
  setIsChecking: (isChecking: boolean) => void;
  
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
  validateLicense: () => Promise<boolean>;
  retryValidation: () => Promise<void>;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let retryInterval: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;    // 30 minutes
const RETRY_INTERVAL_MS = 30 * 1000;              // 30 seconds (when locked)
const MAX_OFFLINE_MS = 24 * 60 * 60 * 1000;       // 24 hours max offline
const LAST_ONLINE_KEY = 'prynx_last_online';

/**
 * Silent telemetry: log suspicious security events to Supabase.
 * This runs in the background and never blocks the UI.
 */
async function logSecurityEvent(eventType: string, details: Record<string, any> = {}) {
  try {
    const { supabase: sb } = await import('../lib/supabase');
    let hwid = localStorage.getItem(HWID_STORAGE_KEY) || 'unknown';
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      hwid = await invoke('get_hardware_id') as string;
    } catch {}

    // Report qua edge function (license-verify ghi security_logs bằng service role).
    // Anon KHÔNG ghi trực tiếp vào bảng được nữa (RLS siết chống giả mạo/flood).
    // Best-effort: nếu offline thì bỏ qua, không ảnh hưởng trải nghiệm.
    await sb.functions.invoke('license-verify', {
      body: {
        license_key: useAuthStore.getState().licenseKey || 'none',
        machine_id: hwid,
        product_id: 'prynx',
        client_signal: { event_type: eventType, details },
      },
    });
  } catch {
    // Silent fail — telemetry must never affect user experience
  }
}

/**
 * Check if the device has general internet connectivity.
 * If we can reach a public endpoint but NOT Supabase,
 * the user is intentionally blocking our license server.
 */
async function checkConnectivity(): Promise<'online' | 'offline' | 'supabase_blocked'> {
  // Check 1: Can we reach ANY public server?
  let hasInternet = false;
  try {
    const resp = await fetch('https://www.gstatic.com/generate_204', {
      method: 'HEAD', mode: 'no-cors', cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    hasInternet = true;
  } catch {
    // Try another endpoint
    try {
      const resp = await fetch('https://1.1.1.1/cdn-cgi/trace', {
        method: 'HEAD', mode: 'no-cors', cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      hasInternet = true;
    } catch {
      hasInternet = false;
    }
  }
  
  if (!hasInternet) return 'offline';
  
  // Check 2: Can we reach Supabase specifically?
  try {
    const { supabase: _sb } = await import('../lib/supabase');
    // Just check if the Supabase health endpoint responds
    await fetch(`https://ryvyuxjgdcvoxujqmggm.supabase.co/rest/v1/`, {
      method: 'HEAD', mode: 'no-cors', cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return 'online';
  } catch {
    return 'supabase_blocked';
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  licenseKey: loadStoredKeySync(),
  licenseToken: null,
  remainingDays: null,
  licenseExpiresAt: null,
  isChecking: true,
  licenseValid: false,
  lastValidated: 0,
  isLicenseLocked: false,
  lockReason: '',

  setUser: (user, session) => set({ user, session }),
  
  setLicenseKey: (key) => {
    if (key) {
      // Save to DPAPI (async, fire-and-forget) + localStorage fallback
      saveToDPAPI(key).then(saved => {
        if (saved) {
          // DPAPI succeeded — remove localStorage copy for security
          localStorage.removeItem(LICENSE_STORAGE_KEY);
          localStorage.removeItem('prynx_license_key');
        } else {
          // DPAPI failed — fall back to obfuscated localStorage
          localStorage.setItem(LICENSE_STORAGE_KEY, encodeKey(key));
        }
      });
    } else {
      deleteFromDPAPI(); // Fire-and-forget
      localStorage.removeItem(LICENSE_STORAGE_KEY);
      localStorage.removeItem('prynx_license_key');
    }
    set({ licenseKey: key });
  },

  setIsChecking: (isChecking) => set({ isChecking }),

  signOut: async () => {
    get().stopHeartbeat();
    await supabase.auth.signOut();
    get().setLicenseKey(null);
    await deleteFromDPAPI(); // Explicitly clear DPAPI
    await deleteTokenFromDPAPI(); // C-1: dọn token đã lưu
    set({ user: null, session: null, licenseValid: false, lastValidated: 0, remainingDays: null, licenseExpiresAt: null, licenseToken: null });
  },

  checkSession: async () => {
    set({ isChecking: true });
    try {
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      set({ session, user: session?.user || null });

      // PATCH #3: Validate license on startup (not just check if key exists)
      // Load from DPAPI first (async), then validate
      const dpapiKey = await loadStoredKeyAsync();
      if (dpapiKey && dpapiKey !== get().licenseKey) {
        set({ licenseKey: dpapiKey }); // Update store with DPAPI key
      }
      const storedKey = dpapiKey || get().licenseKey;
      if (session?.user && storedKey) {
        // C-1: nạp token đã lưu (DPAPI) trước khi validate — để nếu OFFLINE (RPC lỗi,
        // vào grace) thì vẫn có token hợp lệ gửi sidecar. Chỉ dùng nếu CHƯA hết hạn.
        const persistedToken = await loadTokenFromDPAPI();
        if (isLicenseTokenValid(persistedToken)) {
          set({ licenseToken: persistedToken });
        } else if (persistedToken) {
          await deleteTokenFromDPAPI(); // token cũ đã hết hạn → dọn
        }
        const isValid = await get().validateLicense();
        if (!isValid) {
          console.warn('[AUTH] Stored license key is no longer valid — clearing');
          get().setLicenseKey(null);
          set({ licenseValid: false });
        } else {
          // Start heartbeat after successful validation
          get().startHeartbeat();
        }
      }
    } catch (err) {
      console.error('Session check failed:', err);
      set({ session: null, user: null });
    } finally {
      set({ isChecking: false });
    }
  },

  /**
   * PATCH #9: Validate license key against Supabase RPC.
   * Called on startup and periodically (heartbeat).
   */
  validateLicense: async (): Promise<boolean> => {
    const { licenseKey } = get();
    if (!licenseKey) return false;

    try {
      // Get HWID from Rust backend
      let hwid = localStorage.getItem(HWID_STORAGE_KEY) || '';
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        hwid = await invoke('get_hardware_id') as string;
        localStorage.setItem(HWID_STORAGE_KEY, hwid); // Cache HWID
      } catch {
        // Fallback to cached HWID if Rust is unavailable
      }

      const { data, error } = await supabase.rpc('verify_license', {
        p_license_key: licenseKey,
        p_machine_id: hwid,
        p_product_id: 'prynx'
      });

      if (error) {
        console.warn('[AUTH] License validation RPC error:', error.message);
        const lastOnline = await (async () => {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            return await invoke('load_last_online') as number;
          } catch { return 0; }
        })();
        const now = Date.now();
        const offlineMs = now - lastOnline;
        
        // Anti-clockback: if lastOnline is in the future, clock was set backward
        if (lastOnline > 0 && lastOnline > now + 60_000) {
          logSecurityEvent('clock_manipulation', { lastOnline, now, delta: lastOnline - now });
          set({
            licenseValid: false,
            isLicenseLocked: true,
            lockReason: 'Phát hiện đồng hồ hệ thống bị thay đổi. Vui lòng đặt lại thời gian chính xác và kết nối internet.',
          });
          return false;
        }

        // VECTOR #11: Anti-forward-jump — if time jumped >25h, require online validation
        // Prevents chaining T+23h → T+46h → T+69h while staying in grace window
        const MAX_JUMP_MS = 25 * 60 * 60 * 1000;
        if (lastOnline > 0 && offlineMs > MAX_JUMP_MS) {
          logSecurityEvent('forward_clock_jump', { lastOnline, now, jumpHours: Math.round(offlineMs / 3600000) });
          // Don't grant grace — force online check
          set({
            licenseValid: false,
            isLicenseLocked: true,
            lockReason: 'Phiên hoạt động quá lâu không kết nối. Vui lòng kết nối internet để xác minh bản quyền.',
          });
          return false;
        }

        if (lastOnline > 0 && offlineMs > MAX_OFFLINE_MS) {
          // Offline > 24h: check if it's real offline or intentional blocking
          const connectivity = await checkConnectivity();
          
          if (connectivity === 'supabase_blocked') {
            console.error('[AUTH] Supabase blocked but internet works');
            // Silent telemetry
            logSecurityEvent('supabase_blocked', { offlineHours: Math.round(offlineMs/3600000) });
            set({
              licenseValid: false,
              isLicenseLocked: true,
              lockReason: 'Phát hiện máy chủ xác minh bị chặn. Vui lòng kiểm tra lại.',
            });
            return false;
          }
          
          // Truly offline > 24h → soft lock (NOT sign out)
          console.warn(`[AUTH] Offline for ${Math.round(offlineMs/3600000)}h`);
          logSecurityEvent('offline_exceeded', { offlineHours: Math.round(offlineMs/3600000) });
          set({
            licenseValid: false,
            isLicenseLocked: true,
            lockReason: 'Cần kết nối mạng để tool hoạt động tốt.',
          });
          return false;
        }
        
        // Within 24h grace period
        set({ licenseValid: true, lastValidated: Date.now() });
        return true;
      }

      const isValid = data && data.status === 'VALID';
      
      // VECTOR #7: Device limit exceeded
      if (data && data.status === 'DEVICE_LIMIT') {
        const maxDevices = data.max_devices || 2;
        logSecurityEvent('device_limit', { maxDevices });
        set({
          licenseValid: false,
          isLicenseLocked: true,
          lockReason: `Khóa bản quyền đã được sử dụng trên ${maxDevices} thiết bị khác. Liên hệ support để mở thêm.`,
        });
        return false;
      }
      
      // VECTOR #8: Rate limited
      if (data && data.status === 'RATE_LIMITED') {
        set({ licenseValid: true, lastValidated: Date.now() }); // Grace through, don't punish user
        return true;
      }
      if (isValid) {
        try {
          const { invoke: inv } = await import('@tauri-apps/api/core');
          await inv('store_last_online', { timestampMs: Date.now() });
        } catch { /* ignore */ }
        // Auto-unlock if previously locked
        if (get().isLicenseLocked) {
          set({ isLicenseLocked: false, lockReason: '' });
          // Stop retry interval, restart normal heartbeat
          if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
          get().startHeartbeat();
        }
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('register_validated_key', { licenseKey });
        } catch { /* ignore in dev/web mode */ }

        // Lấy token ngắn hạn do server ký (best-effort). Thất bại không ảnh hưởng xác thực
        // (token=null; sidecar chỉ chặn khi đã bật cưỡng chế).
        try {
          const { data: tokData } = await supabase.functions.invoke('license-verify', {
            body: { license_key: licenseKey, machine_id: hwid, product_id: 'prynx' },
          });
          if ((tokData as any)?.token) {
            const tok = (tokData as any).token as string;
            set({ licenseToken: tok });
            // C-1: lưu token (DPAPI) để mở lại app offline vẫn dùng được tới khi hết hạn.
            void saveTokenToDPAPI(tok);
          }
        } catch { /* ignore — token optional during rollout */ }
      }
      set({
        licenseValid: isValid,
        lastValidated: Date.now(),
        licenseToken: isValid ? get().licenseToken : null,
        remainingDays: (data && typeof data.remaining_days === 'number') ? data.remaining_days : null,
        licenseExpiresAt: (data && data.expires_at) ? data.expires_at : null,
      });
      
      if (!isValid) {
        console.warn('[AUTH] License revoked or invalid:', data?.message);
      }
      
      return isValid;
    } catch (err) {
      console.error('[AUTH] License validation failed:', err);
      const lastOnline = await (async () => {
        try {
          const { invoke: inv2 } = await import('@tauri-apps/api/core');
          return await inv2('load_last_online') as number;
        } catch { return 0; }
      })();
      const now2 = Date.now();
      const offlineMs = now2 - lastOnline;
      // Anti-clockback
      if (lastOnline > 0 && lastOnline > now2 + 60_000) {
        logSecurityEvent('clock_manipulation', { lastOnline, now: now2 });
        set({ licenseValid: false, isLicenseLocked: true, lockReason: 'Phát hiện đồng hồ hệ thống bị thay đổi.' });
        return false;
      }
      if (lastOnline > 0 && offlineMs > MAX_OFFLINE_MS) {
        const connectivity = await checkConnectivity();
        const reason = connectivity === 'supabase_blocked'
          ? 'Phát hiện máy chủ xác minh bị chặn. Vui lòng kiểm tra lại.'
          : 'Cần kết nối mạng để tool hoạt động tốt.';
        logSecurityEvent(connectivity === 'supabase_blocked' ? 'supabase_blocked' : 'offline_exceeded', {
          offlineHours: Math.round(offlineMs/3600000),
        });
        set({ licenseValid: false, isLicenseLocked: true, lockReason: reason });
        return false;
      }
      set({ licenseValid: true, lastValidated: Date.now() });
      return true;
    }
  },

  /**
   * Manual retry: called by user clicking "Thử lại" on lock screen.
   */
  retryValidation: async () => {
    const isValid = await get().validateLicense();
    if (isValid) {
      set({ isLicenseLocked: false, lockReason: '' });
      if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
      get().startHeartbeat();
    }
  },

  startHeartbeat: () => {
    get().stopHeartbeat();
    heartbeatInterval = setInterval(async () => {
      const isValid = await get().validateLicense();
      if (!isValid && !get().isLicenseLocked) {
        // Don't sign out — just lock. validateLicense already sets isLicenseLocked.
        // Start rapid retry interval
        if (!retryInterval) {
          retryInterval = setInterval(async () => {
            await get().retryValidation();
          }, RETRY_INTERVAL_MS);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  },

  stopHeartbeat: () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
  },
}));
