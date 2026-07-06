import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../stores/useAuthStore';

interface AboutModalProps {
  onClose: () => void;
  /** true → tự chạy kiểm tra cập nhật ngay khi mở (từ menu Help > Kiểm tra cập nhật). */
  autoCheck?: boolean;
}

// Thông tin liên hệ hỗ trợ PrynX (PrintSolutions.vn).
export const SUPPORT = {
  website: 'https://printsolutions.vn',
  product: 'https://printsolutions.vn/product/prynx',
  email: 'khanhpham.print@gmail.com',
  phone: '0862160492',
  zalo: 'https://zalo.me/0862160492',
};

async function openExternal(url: string) {
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (e) {
    console.error('[About] open link failed:', e);
  }
}

/**
 * AboutModal — hộp thoại "Giới thiệu PrynX": logo, phiên bản, tài khoản đang
 * đăng nhập, hạn dùng license và các kênh liên hệ hỗ trợ.
 */
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; version?: string; update: any }
  | { kind: 'downloading'; percent: number }
  | { kind: 'error'; message: string };

export default function AboutModal({ onClose, autoCheck }: AboutModalProps) {
  const { user, remainingDays, licenseExpiresAt } = useAuthStore();
  const [version, setVersion] = useState('');
  const [upd, setUpd] = useState<UpdateState>({ kind: 'idle' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setVersion(await getVersion());
      } catch { /* web/dev: bỏ qua */ }
    })();
  }, []);

  // Mở từ menu Help > Kiểm tra cập nhật → tự chạy kiểm tra ngay.
  useEffect(() => {
    if (autoCheck) checkUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck]);

  const checkUpdate = async () => {
    if (!(window as any).__TAURI_INTERNALS__) {
      setUpd({ kind: 'error', message: 'Chỉ khả dụng trong bản cài đặt.' });
      return;
    }
    setUpd({ kind: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const found = await check();
      if (found) setUpd({ kind: 'available', version: found.version, update: found });
      else setUpd({ kind: 'latest' });
    } catch (e: any) {
      setUpd({ kind: 'error', message: e?.message || String(e) });
    }
  };

  const installUpdate = async (update: any) => {
    try {
      let total = 0, got = 0;
      setUpd({ kind: 'downloading', percent: 0 });
      await update.downloadAndInstall((ev: any) => {
        if (ev.event === 'Started') total = ev.data?.contentLength || 0;
        else if (ev.event === 'Progress') {
          got += ev.data?.chunkLength || 0;
          if (total > 0) setUpd({ kind: 'downloading', percent: Math.min(100, Math.round((got / total) * 100)) });
        } else if (ev.event === 'Finished') setUpd({ kind: 'downloading', percent: 100 });
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e: any) {
      setUpd({ kind: 'error', message: e?.message || String(e) });
    }
  };

  const expiryStr = licenseExpiresAt
    ? new Date(licenseExpiresAt).toLocaleDateString('vi-VN')
    : null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Giới thiệu PrynX"
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-col items-center text-center px-6 pt-7 pb-5 border-b border-slate-100 dark:border-white/10">
          <div className="w-16 h-16 mb-3 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-300 dark:from-zinc-700 dark:to-zinc-800 flex items-center justify-center shadow-inner ring-1 ring-black/5 dark:ring-white/10">
            <img
              src="/logo.png"
              alt="PrynX"
              className="w-10 h-10 object-contain dark:invert"
              onError={(e) => { (e.target as HTMLElement).outerHTML = '<span class="text-3xl">📄</span>'; }}
            />
          </div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">PrynX</h2>
          <p className="text-[12px] text-slate-500 dark:text-zinc-400 mt-0.5">
            {version ? `Phiên bản ${version} · ` : ''}by PrintSolutions.vn
          </p>
        </div>

        {/* Account + license */}
        <div className="px-6 py-4 space-y-2 text-[13px] border-b border-slate-100 dark:border-white/10">
          <Row label="Tài khoản" value={user?.email || 'Chưa đăng nhập'} />
          {remainingDays !== null && (
            <Row
              label="Hạn dùng"
              value={`Còn ${remainingDays} ngày${expiryStr ? ` (đến ${expiryStr})` : ''}`}
            />
          )}
        </div>

        {/* Cập nhật phần mềm */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-white/10">
          {upd.kind === 'available' ? (
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
                  Có bản mới{upd.version ? ` ${upd.version}` : ''}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-zinc-400">Cài đặt rồi khởi động lại.</div>
              </div>
              <button
                onClick={() => installUpdate(upd.update)}
                className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-[13px] font-semibold transition-colors"
              >
                Cập nhật ngay
              </button>
            </div>
          ) : upd.kind === 'downloading' ? (
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium text-slate-700 dark:text-zinc-200">Đang tải & cài đặt… {upd.percent}%</div>
              <div className="h-1.5 rounded-full bg-slate-200 dark:bg-zinc-700 overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all duration-200" style={{ width: `${upd.percent}%` }} />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0 text-[13px]">
                {upd.kind === 'checking' && <span className="text-slate-500 dark:text-zinc-400">Đang kiểm tra cập nhật…</span>}
                {upd.kind === 'latest' && <span className="text-emerald-600 dark:text-emerald-400 font-medium">✓ Bạn đang dùng bản mới nhất.</span>}
                {upd.kind === 'error' && <span className="text-rose-500">Lỗi: {upd.message}</span>}
                {upd.kind === 'idle' && <span className="text-slate-500 dark:text-zinc-400">Kiểm tra phiên bản mới nhất.</span>}
              </div>
              <button
                onClick={checkUpdate}
                disabled={upd.kind === 'checking'}
                className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 text-[13px] font-semibold transition-colors disabled:opacity-50"
              >
                Kiểm tra cập nhật
              </button>
            </div>
          )}
        </div>

        {/* Contact */}
        <div className="px-6 py-4 space-y-2">
          <div className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 uppercase tracking-wider mb-1">
            Liên hệ hỗ trợ
          </div>
          <ContactButton icon="🌐" label="Trang chủ" sub="printsolutions.vn" onClick={() => openExternal(SUPPORT.website)} />
          <ContactButton icon="✉️" label="Email" sub={SUPPORT.email} onClick={() => openExternal(`mailto:${SUPPORT.email}`)} />
          <ContactButton icon="📞" label="Điện thoại" sub={SUPPORT.phone} onClick={() => openExternal(`tel:${SUPPORT.phone}`)} />
          <ContactButton icon="💬" label="Zalo" sub={SUPPORT.phone} onClick={() => openExternal(SUPPORT.zalo)} />
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 pt-1 flex flex-col gap-3">
          <p className="text-[11px] text-slate-400 dark:text-zinc-500 text-center leading-relaxed">
            © {new Date().getFullYear()} PrintSolutions.vn. Mọi quyền được bảo lưu.
          </p>
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 text-[14px] font-semibold transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500 dark:text-zinc-400 shrink-0">{label}</span>
      <span className="text-slate-800 dark:text-zinc-200 font-medium truncate text-right">{value}</span>
    </div>
  );
}

function ContactButton({ icon, label, sub, onClick }: { icon: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors text-left border border-transparent hover:border-slate-200 dark:hover:border-zinc-700"
    >
      <span className="text-[18px] w-6 text-center shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-slate-800 dark:text-zinc-200">{label}</span>
        <span className="block text-[11px] text-slate-500 dark:text-zinc-400 truncate">{sub}</span>
      </span>
    </button>
  );
}
