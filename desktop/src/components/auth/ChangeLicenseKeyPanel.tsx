/**
 * Form đổi license key — dùng chung About + LicenseLockOverlay.
 * Logic verify-first nằm trong useAuthStore.changeLicenseKey.
 * UIUX (audit 2026-09-03): dùng cùng token bề mặt/nút với app để luồng nhập key
 * không tách thành một modal xanh riêng.
 */
import { useId, useState } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { useTranslation } from 'react-i18next';
import { toast } from '../ui/Toast';

type Props = {
  /** Gọi sau khi đổi thành công (vd. đóng form About). */
  onSuccess?: () => void;
  /** Gọi khi user hủy. */
  onCancel?: () => void;
  /** Variant giao diện: light (About) | dark (lock overlay). */
  variant?: 'light' | 'dark';
  /** Tự focus input khi mount. */
  autoFocus?: boolean;
};

export default function ChangeLicenseKeyPanel({
  onSuccess,
  onCancel,
  variant = 'light',
  autoFocus = true,
}: Props) {
  const { t } = useTranslation();
  const changeLicenseKey = useAuthStore(s => s.changeLicenseKey);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const confirmTitleId = `${inputId}-confirm-title`;
  const confirmHintId = `${inputId}-confirm-hint`;

  const dark = variant === 'dark';

  const inputCls = dark
    ? 'w-full h-10 px-3 rounded-app-md border border-white/15 bg-zinc-900/80 text-[13px] font-mono text-zinc-100 outline-none transition-[border-color,box-shadow] focus:border-app-accent focus:ring-2 focus:ring-app-accent-soft placeholder:text-zinc-500 disabled:cursor-not-allowed disabled:opacity-60'
    : 'w-full h-10 px-3 rounded-app-md border border-app-line bg-app-2 text-[13px] font-mono text-app-text-1 outline-none transition-[border-color,box-shadow] focus:border-app-accent focus:ring-2 focus:ring-app-accent-soft placeholder:text-app-text-3 disabled:cursor-not-allowed disabled:opacity-60';

  const labelCls = dark
    ? 'block text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5'
    : 'block text-[11px] font-semibold text-app-text-2 uppercase tracking-wide mb-1.5';

  const cancelBtn = dark
    ? 'px-3 h-9 rounded-app-md text-[13px] font-semibold text-zinc-300 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-50'
    : 'px-3 h-9 rounded-app-md text-[12px] font-semibold text-app-text-2 hover:bg-app-3 focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-50';

  const primaryBtn = dark
    ? 'px-3 h-9 rounded-app-md text-[13px] font-semibold bg-app-accent hover:bg-app-accent-hover text-white focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-50'
    : 'px-3 h-9 rounded-app-md text-[12px] font-semibold bg-app-accent hover:bg-app-accent-hover text-white focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-50';

  const runChange = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await changeLicenseKey(input);
      if (!result.ok) {
        if (result.reason === 'same') {
          toast.info(result.message || t('misc.about:key_hien_tai'));
          setConfirm(false);
          onSuccess?.();
          return;
        }
        setError(result.message || t('misc.about:doi_key_that_bai'));
        setConfirm(false);
        return;
      }
      toast.success(result.message || t('misc.about:doi_key_thanh_cong'));
      setInput('');
      setConfirm(false);
      onSuccess?.();
    } finally {
      setBusy(false);
    }
  };

  const onConfirmClick = () => {
    if (!input.trim()) {
      setError(t('misc.about:vui_long_nhap_license_key'));
      return;
    }
    setError('');
    setConfirm(true);
  };

  return (
    <div className={dark ? 'space-y-3 text-left' : 'space-y-2.5'}>
      <label htmlFor={inputId} className={labelCls}>{t('misc.about:license_key_moi')}</label>
      <input
        id={inputId}
        type="text"
        autoFocus={autoFocus}
        value={input}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        disabled={busy}
        onChange={(e) => { setInput(e.target.value); setError(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onConfirmClick(); }
        }}
        placeholder={t('misc.about:dan_hoac_nhap_key')}
        className={inputCls}
        autoComplete="off"
        spellCheck={false}
      />
      {error && (
        <p id={errorId} role="alert" className={`text-[12px] leading-snug ${dark ? 'text-rose-300' : 'text-app-danger'}`}>{error}</p>
      )}
      <div className="flex justify-end gap-2 pt-0.5">
        {onCancel && (
          <button type="button" disabled={busy} onClick={onCancel} className={cancelBtn}>
            {t('misc.about:huy')}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !input.trim()}
          onClick={onConfirmClick}
          className={primaryBtn}
        >
          {busy ? t('misc.about:dang_xac_thuc') : t('misc.about:xac_nhan')}
        </button>
      </div>

      {confirm && (
        <div
          className="fixed inset-0 z-confirm flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
          onClick={() => !busy && setConfirm(false)}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={confirmTitleId}
          aria-describedby={confirmHintId}
        >
          <div
            className="w-full max-w-xs space-y-3 rounded-app-xl border border-app-line bg-app-2 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p id={confirmTitleId} className="text-[14px] font-medium leading-relaxed text-app-text-1">
              {t('misc.about:xac_nhan_doi_key')}
            </p>
            <p id={confirmHintId} className="text-[12px] leading-snug text-app-text-2">
              {t('misc.about:xac_nhan_doi_key_hint')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
                className="px-3 h-9 rounded-app-md text-[13px] font-semibold text-app-text-2 hover:bg-app-3 focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-50"
              >
                {t('misc.about:huy')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runChange()}
                className="px-3 h-9 rounded-app-md bg-app-accent text-[13px] font-semibold text-white hover:bg-app-accent-hover focus-visible:ring-2 focus-visible:ring-app-accent disabled:opacity-50"
              >
                {busy ? t('misc.about:dang_xac_thuc') : t('misc.about:dong_y_doi_key')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
