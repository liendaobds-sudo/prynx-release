import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import type { User, Session } from '@supabase/supabase-js';
import { isLicenseTokenValid, readLicenseTokenClaims } from './licenseToken';
import { normalizePlan, type LicensePlan } from '../lib/license/features';
import { normalizeLicenseKey } from '../lib/licenseKey';
import {
  clearPendingSecurityEvents,
  enqueueSecurityEvent,
  getPendingSecurityEvents,
  removePendingSecurityEvent,
  toSecuritySignalDetails,
} from '../lib/securityEventQueue';

const PRODUCT_ID = 'prynx';

export type ChangeLicenseKeyReason =
  | 'empty'
  | 'same'
  | 'invalid'
  | 'network'
  | 'token'
  | 'unknown';

export type ChangeLicenseKeyResult = {
  ok: boolean;
  reason?: ChangeLicenseKeyReason;
  /** Message hiển thị (server hoặc local). */
  message?: string;
};

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

// ── Nạp license key vào cache VALIDATED_KEYS của Rust ──
// sign_api_request (Rust) CHỈ ký SIDECAR token khi key đã có trong cache này. Phải gọi ở
// MỌI nhánh mà app coi license là dùng được (VALID / RATE_LIMITED / grace offline) — nếu
// không, app vào được nhưng mọi request backend bị 403 "invalid sidecar token".
// Best-effort: không có Tauri (dev/web) thì bỏ qua êm.
async function ensureKeyRegisteredInRust(licenseKey: string): Promise<void> {
  if (!licenseKey) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    let hwid = '';
    try {
      hwid = await invoke('get_hardware_id') as string;
      if (hwid) localStorage.setItem(HWID_STORAGE_KEY, hwid);
    } catch {
      hwid = localStorage.getItem(HWID_STORAGE_KEY) || '';
    }
    const token = useAuthStore.getState().licenseToken || '';
    await invoke('register_validated_key', { licenseKey, hwid, token });
  } catch { /* ignore (dev/web mode) */ }
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

// ── Xoá cache VALIDATED_KEYS phía Rust (chặn ký sidecar token → backend 403) ──
// Gọi khi khóa cứng/thu hồi/đăng xuất. Nếu KHÔNG gọi, dù UI đã khóa, sign_api_request
// (Rust) vẫn ký request hợp lệ tới hết TTL cache (2h) → backend vẫn xử lý PDF.
// Best-effort: không có Tauri (dev/web) thì bỏ qua êm.
async function clearValidatedKeysInRust(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('clear_validated_keys');
  } catch { /* ignore (dev/web mode) */ }
}

// isLicenseTokenValid tách sang ./licenseToken (module thuần, unit-test được).

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
  /** Gói lấy từ token/server. Mặc định Pro để key cũ không bị khóa nhầm khi rollout. */
  licensePlan: LicensePlan;
  /** Quyền cấp riêng; null nghĩa là dùng quyền mặc định theo plan. */
  licenseFeatures: string[] | null;
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
  /** Thu hồi có ân hạn: khi server báo key bị khóa/hết hạn, hiện popup đếm ngược
   *  REVOKE_GRACE_MS để khách kịp lưu file trước khi khóa cứng. Tự huỷ nếu key VALID lại. */
  isRevoking: boolean;
  /** Epoch ms hết giờ đếm ngược thu hồi. null khi không trong trạng thái thu hồi. */
  revokeDeadline: number | null;
  revokeReason: string;

  setUser: (user: User | null, session: Session | null) => void;
  setLicenseKey: (key: string | null) => void;
  setIsChecking: (isChecking: boolean) => void;

  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
  validateLicense: () => Promise<boolean>;
  retryValidation: () => Promise<void>;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
  /**
   * Đổi license key (verify-first).
   * Chỉ ghi đè key local khi server trả VALID. Không logout Google.
   * Key cũ giữ nguyên nếu verify fail / mạng lỗi.
   */
  changeLicenseKey: (rawKey: string) => Promise<ChangeLicenseKeyResult>;
  /** Bắt đầu quy trình thu hồi có ân hạn (idempotent — gọi lại không reset deadline). */
  beginRevocation: (reason: string) => void;
  /** Huỷ thu hồi khi key hợp lệ trở lại (admin mở khóa trong thời gian ân hạn). */
  cancelRevocation: () => void;
  /** Khóa cứng ngay: overlay + xoá cache ký Rust + dọn token. Gọi khi hết giờ ân hạn. */
  enforceHardLock: (reason: string) => Promise<void>;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let retryInterval: ReturnType<typeof setInterval> | null = null;
let revokeTimer: ReturnType<typeof setTimeout> | null = null;
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;     // 30 phút — tránh rate limit Supabase (60s cũ = 120 req/giờ → hit limit)
const RETRY_INTERVAL_MS = 30 * 1000;              // 30 seconds (when locked)
// FALLBACK offline grace CHỈ cho client CHƯA có token ký (rollout/token fetch lỗi).
// Với client đã có token Ed25519, "ngân sách offline" THẬT là hạn (exp) của token do
// server ký — xem nhánh token-driven trong validateLicense. KHÔNG rút số này xuống thấp:
// nó KHÔNG giúp thu hồi nhanh (thu hồi chỉ xảy ra khi online) mà chỉ phạt khách offline
// hợp pháp (tắt máy nghỉ cuối tuần, đi công tác không mạng).
const MAX_OFFLINE_MS = 24 * 60 * 60 * 1000;       // 24h — fallback cho client chưa có token
const REVOKE_GRACE_MS = 5 * 60 * 1000;            // 5 phút ân hạn để khách kịp lưu file trước khi khóa cứng
const LAST_ONLINE_KEY = 'prynx_last_online';

/**
 * Durable security telemetry. Events are queued without a license key, then
 * retried after the license server is reachable and has verified the machine.
 */
let telemetryFlushPromise: Promise<void> | null = null;

async function getTelemetryHardwareId(): Promise<string> {
  let hwid = localStorage.getItem(HWID_STORAGE_KEY) || '';
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    hwid = await invoke('get_hardware_id') as string;
    if (hwid) localStorage.setItem(HWID_STORAGE_KEY, hwid);
  } catch {
    // Keep the cached identifier in web/dev mode.
  }
  return hwid;
}

async function flushPendingSecurityEvents(): Promise<void> {
  if (telemetryFlushPromise) return telemetryFlushPromise;

  telemetryFlushPromise = (async () => {
    const licenseKey = useAuthStore.getState().licenseKey;
    if (!licenseKey) return;

    const hwid = await getTelemetryHardwareId();
    if (!hwid) return;

    const pending = getPendingSecurityEvents().slice(0, 10);
    for (const event of pending) {
      try {
        const { data, error } = await supabase.functions.invoke('license-verify', {
          body: {
            license_key: licenseKey,
            machine_id: hwid,
            product_id: PRODUCT_ID,
            client_signal: {
              event_type: event.eventType,
              details: toSecuritySignalDetails(event),
            },
          },
        });

        if (error) break;

        const response = data as Record<string, unknown> | null;
        if (response?.security_signal_processed === true || (response && response.status !== 'VALID')) {
          removePendingSecurityEvent(event.id);
          continue;
        }

        // Server was reachable but did not confirm processing. Keep the event for retry.
        break;
      } catch {
        break;
      }
    }
  })().finally(() => {
    telemetryFlushPromise = null;
  });

  return telemetryFlushPromise;
}

function logSecurityEvent(eventType: string, details: Record<string, unknown> = {}): void {
  enqueueSecurityEvent(eventType, details);
  void flushPendingSecurityEvents();
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
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/`, {
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
  licensePlan: 'free',
  licenseFeatures: null,
  remainingDays: null,
  licenseExpiresAt: null,
  isChecking: true,
  licenseValid: false,
  lastValidated: 0,
  isLicenseLocked: false,
  lockReason: '',
  isRevoking: false,
  revokeDeadline: null,
  revokeReason: '',

  setUser: (user, session) => set({ user, session }),
  
  setLicenseKey: (key) => {
    const previousKey = get().licenseKey;
    if (previousKey && previousKey !== key) {
      // A queued event must never be attributed to a different customer key.
      clearPendingSecurityEvents();
    }

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
    await clearValidatedKeysInRust(); // dọn cache ký Rust → backend không còn nhận request
    await supabase.auth.signOut();
    get().setLicenseKey(null);
    await deleteFromDPAPI(); // Explicitly clear DPAPI
    await deleteTokenFromDPAPI(); // C-1: dọn token đã lưu
    set({
      user: null, session: null, licenseValid: false, lastValidated: 0,
      remainingDays: null, licenseExpiresAt: null, licenseToken: null,
      licensePlan: 'free', licenseFeatures: null,
      isRevoking: false, revokeDeadline: null, revokeReason: '',
    });
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
          const claims = readLicenseTokenClaims(persistedToken);
          set({
            licenseToken: persistedToken,
            licensePlan: claims?.plan ? normalizePlan(claims.plan) : 'free',
            licenseFeatures: claims?.features ?? null,
          });
        } else if (persistedToken) {
          await deleteTokenFromDPAPI(); // token cũ đã hết hạn → dọn
        }
        const isValid = await get().validateLicense();
        if (!isValid) {
          console.warn('[AUTH] Stored license key is no longer valid — clearing');
          // Lúc KHỞI ĐỘNG không có việc gì đang làm để lưu → không hiện popup đếm ngược
          // (validateLicense có thể vừa bật beginRevocation). Huỷ thu hồi + xoá key về
          // Login sạch. Chỉ khi key bị thu hồi GIỮA phiên đang dùng mới cần ân hạn 5 phút.
          get().cancelRevocation();
          get().setLicenseKey(null);
          set({ licenseValid: false, isLicenseLocked: false, lockReason: '' });
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
        // ── Token-driven offline grace (ưu tiên hơn heuristic thời gian) ──
        // "Ngân sách offline" THẬT = hạn (exp) của token Ed25519 do server ký. Token chống
        // chỉnh đồng hồ (backend tự verify exp + anti-rollback độc lập), nên còn token hợp lệ
        // thì cho dùng offline BẤT KỂ đã offline bao lâu → khách nghỉ cuối tuần / đi công tác
        // không mạng KHÔNG bị khóa oan. Anti-clockback ở trên vẫn gác (đồng hồ LÙI thì không
        // tin token vì exp so với Date.now() sẽ sai lệch). Muốn khách offline lâu hơn: tăng
        // TOKEN_TTL phía server — 1 knob duy nhất, không cần build lại app.
        const offlineToken = get().licenseToken || await loadTokenFromDPAPI();
        if (isLicenseTokenValid(offlineToken)) {
          if (offlineToken && get().licenseToken !== offlineToken) set({ licenseToken: offlineToken });
          await ensureKeyRegisteredInRust(licenseKey);
          set({ licenseValid: true, lastValidated: Date.now() });
          return true;
        }
        // Không còn token hợp lệ (chưa kịp nhận token, hoặc token đã hết hạn) → dùng fallback
        // thời gian bên dưới (forward-jump + MAX_OFFLINE) để vẫn có giới hạn an toàn.
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
        // Nạp cache Rust để sidecar token được ký kể cả khi offline/grace (dùng token đã
        // lưu DPAPI). Không có cái này → vào app được nhưng backend 403.
        await ensureKeyRegisteredInRust(licenseKey);
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
        // Vẫn nạp cache Rust để không bị 403 backend khi Supabase rate-limit (hay gặp khi
        // chạy dev + release cùng máy cùng license → đập RPC quá nhiều).
        await ensureKeyRegisteredInRust(licenseKey);
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
        // Admin mở khóa lại trong thời gian ân hạn → huỷ đếm ngược thu hồi.
        if (get().isRevoking) {
          get().cancelRevocation();
        }
        try {
          const { invoke } = await import('@tauri-apps/api/core');

          // Lấy token ngắn hạn do server ký TRƯỚC (để Rust verify Ed25519 khi register).
          // Best-effort: thất bại không chặn xác thực (token=null; sidecar chỉ chặn khi enforce).
          let freshToken = '';
          try {
            const { data: tokData } = await supabase.functions.invoke('license-verify', {
              body: { license_key: licenseKey, machine_id: hwid, product_id: 'prynx' },
            });
            if ((tokData as any)?.token) {
              freshToken = (tokData as any).token as string;
              const claims = readLicenseTokenClaims(freshToken);
              set({
                licenseToken: freshToken,
                licensePlan: normalizePlan((tokData as any)?.plan || claims?.plan || 'free'),
                licenseFeatures: Array.isArray((tokData as any)?.features)
                  ? (tokData as any).features
                  : (claims?.features ?? null),
              });
              void saveTokenToDPAPI(freshToken);
            }
          } catch { /* ignore — token optional during rollout */ }

          // F2: register kèm token+hwid → Rust TỰ verify Ed25519 (lớp gate thứ 2, độc lập sidecar).
          await invoke('register_validated_key', { licenseKey, hwid, token: freshToken });
        } catch { /* ignore in dev/web mode */ }
        void flushPendingSecurityEvents();
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
        // Chỉ THU HỒI khi server nói rõ key bị khóa/hết hạn — KHÔNG với 'ERROR'
        // (lỗi server tạm thời) để tránh khóa oan khi RPC trục trặc.
        const st = data?.status;
        if (st === 'INVALID' || st === 'EXPIRED') {
          const reason = st === 'EXPIRED'
            ? 'Bản quyền đã hết hạn. Vui lòng gia hạn để tiếp tục sử dụng.'
            : 'Bản quyền đã bị thu hồi. Vui lòng liên hệ để được hỗ trợ.';
          get().beginRevocation(reason);
        }
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
      // Token-driven offline grace (giống nhánh if(error) ở trên): còn token hợp lệ →
      // cho dùng offline bất kể đã offline bao lâu. Anti-clockback ở trên vẫn gác.
      const offlineToken2 = get().licenseToken || await loadTokenFromDPAPI();
      if (isLicenseTokenValid(offlineToken2)) {
        if (offlineToken2 && get().licenseToken !== offlineToken2) set({ licenseToken: offlineToken2 });
        await ensureKeyRegisteredInRust(licenseKey);
        set({ licenseValid: true, lastValidated: Date.now() });
        return true;
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

  /**
   * Đổi license key khi đã đăng nhập (About / settings).
   * Verify-first: RPC VALID → clear cache key cũ → setLicenseKey → validateLicense → heartbeat.
   */
  changeLicenseKey: async (rawKey: string): Promise<ChangeLicenseKeyResult> => {
    const newKey = normalizeLicenseKey(rawKey);
    if (!newKey) {
      return { ok: false, reason: 'empty', message: 'Vui lòng nhập license key.' };
    }
    const current = normalizeLicenseKey(get().licenseKey || '');
    if (current && current === newKey) {
      return { ok: false, reason: 'same', message: 'Đây đã là key đang dùng trên máy này.' };
    }

    try {
      let hwid = localStorage.getItem(HWID_STORAGE_KEY) || '';
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        hwid = await invoke('get_hardware_id') as string;
        if (hwid) localStorage.setItem(HWID_STORAGE_KEY, hwid);
      } catch {
        // dev/web: dùng cache
      }
      if (!hwid) {
        return {
          ok: false,
          reason: 'network',
          message: 'Không lấy được mã máy. Chạy bản cài đặt PrynX và thử lại.',
        };
      }

      const { data, error } = await supabase.rpc('verify_license', {
        p_license_key: newKey,
        p_machine_id: hwid,
        p_product_id: PRODUCT_ID,
      });

      if (error) {
        return {
          ok: false,
          reason: 'network',
          message: error.message || 'Không kết nối được máy chủ bản quyền.',
        };
      }

      const res = data as {
        status?: string;
        message?: string;
        remaining_days?: number | null;
        expires_at?: string | null;
      } | null;

      if (!res || res.status !== 'VALID') {
        const status = res?.status || 'INVALID';
        const serverMsg = res?.message || 'License key không hợp lệ.';
        // Map status thường gặp → message rõ (giữ server message nếu đủ)
        const byStatus: Record<string, string> = {
          INVALID: serverMsg,
          EXPIRED: res?.message || 'License đã hết hạn.',
          BLOCKED: res?.message || 'License đã bị khóa.',
          DEVICE_LIMIT: res?.message || 'Key đã đạt giới hạn số máy.',
          MAX_ACTIVATIONS_REACHED: res?.message || 'Key đã đạt giới hạn số máy.',
          MACHINE_MISMATCH: res?.message || 'Key đã gắn máy khác. Liên hệ hỗ trợ reset máy.',
          RATE_LIMITED: res?.message || 'Thử quá nhiều lần. Vui lòng đợi rồi thử lại.',
          PRODUCT_MISMATCH: res?.message || 'Key không dành cho PrynX.',
        };
        return {
          ok: false,
          reason: 'invalid',
          message: byStatus[status] || serverMsg,
        };
      }

      // P2-A: gỡ máy khỏi key CŨ (best-effort) — giải phóng seat max_activations.
      // Phải gọi TRƯỚC setLicenseKey; lỗi RPC không chặn đổi key local (key B đã VALID).
      if (current) {
        try {
          await supabase.rpc('release_machine_activation', {
            p_license_key: current,
            p_machine_id: hwid,
            p_product_id: PRODUCT_ID,
          });
        } catch (releaseErr) {
          console.warn('[AUTH] release_machine_activation (best-effort):', releaseErr);
        }
      }

      // VALID — dọn token/cache key cũ rồi ghi key mới (không logout Google).
      await clearValidatedKeysInRust();
      await deleteTokenFromDPAPI();
      set({ licenseToken: null });

      get().setLicenseKey(newKey);

      // Ưu tiên số liệu từ RPC đầu; validateLicense sẽ refresh token + remainingDays.
      if (res.remaining_days !== undefined && res.remaining_days !== null) {
        set({ remainingDays: res.remaining_days });
      }
      if (res.expires_at) {
        set({ licenseExpiresAt: res.expires_at });
      }

      const tokenOk = await get().validateLicense();
      get().cancelRevocation();
      if (tokenOk) {
        set({ isLicenseLocked: false, lockReason: '', licenseValid: true });
        get().startHeartbeat();
        return { ok: true };
      }

      // Key đã VALID + đã lưu; token/sidecar chưa xong — vẫn coi thành công một phần.
      set({ licenseValid: true, isLicenseLocked: false, lockReason: '' });
      get().startHeartbeat();
      return {
        ok: true,
        reason: 'token',
        message: 'Key đã lưu. Nếu API lỗi, thử mở lại app hoặc kiểm tra mạng.',
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        reason: 'network',
        message: msg || 'Không cập nhật được license. Key hiện tại vẫn được giữ.',
      };
    }
  },

  // ── Thu hồi có ân hạn ─────────────────────────────────────────────────────
  // Server báo key bị khóa/hết hạn (INVALID/EXPIRED) → KHÔNG khóa cứng ngay mà cho
  // REVOKE_GRACE_MS để khách lưu file. Idempotent: gọi lại khi đang thu hồi không
  // reset deadline (đồng hồ đếm ngược chạy liên tục qua các nhịp heartbeat).
  beginRevocation: (reason: string) => {
    if (get().isRevoking || get().isLicenseLocked) return;
    const deadline = Date.now() + REVOKE_GRACE_MS;
    set({ isRevoking: true, revokeDeadline: deadline, revokeReason: reason, licenseValid: false });
    if (revokeTimer) clearTimeout(revokeTimer);
    revokeTimer = setTimeout(() => {
      void get().enforceHardLock(reason);
    }, REVOKE_GRACE_MS);
  },

  // Admin mở khóa lại trong thời gian ân hạn → key VALID trở lại → huỷ đếm ngược.
  cancelRevocation: () => {
    if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
    if (get().isRevoking) {
      set({ isRevoking: false, revokeDeadline: null, revokeReason: '' });
    }
  },

  // Hết giờ ân hạn → khóa cứng: overlay + XOÁ cache ký Rust (chặn mọi request backend
  // ngay trong phiên, không đợi TTL 2h) + dọn token đã lưu.
  enforceHardLock: async (reason: string) => {
    if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
    await clearValidatedKeysInRust();
    await deleteTokenFromDPAPI();
    set({
      isRevoking: false,
      revokeDeadline: null,
      revokeReason: '',
      licenseValid: false,
      licenseToken: null,
      isLicenseLocked: true,
      lockReason: reason || 'Bản quyền đã bị thu hồi. Vui lòng liên hệ để được hỗ trợ.',
    });
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
    if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
  },
}));
