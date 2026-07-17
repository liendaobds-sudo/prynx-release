/**
 * Form đổi license key — dùng chung About + LicenseLockOverlay.
 * Logic verify-first nằm trong useAuthStore.changeLicenseKey.
 */
import { useState } from 'react';
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

  const dark = variant === 'dark';

  const inputCls = dark
    ? 'w-full h-10 px-3 rounded-lg border border-white/15 bg-black/30 text-[13px] font-mono text-white outline-none focus:border-indigo-400 placeholder:text-slate-500'
    : 'w-full h-9 px-3 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-zinc-900 text-[13px] font-mono text-slate-800 dark:text-zinc-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40';

  const labelCls = dark
    ? 'block text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5'
    : 'block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 uppercase tracking-wide mb-1.5';

  const cancelBtn = dark
    ? 'px-3 h-9 rounded-lg text-[13px] font-semibold text-slate-300 hover:bg-white/10 disabled:opacity-50'
    : 'px-3 h-8 rounded-lg text-[12px] font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-200/80 dark:hover:bg-zinc-700 disabled:opacity-50';

  const primaryBtn = dark
    ? 'px-3 h-9 rounded-lg text-[13px] font-semibold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50'
    : 'px-3 h-8 rounded-lg text-[12px] font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50';

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
      <label className={labelCls}>{t('misc.about:license_key_moi')}</label>
      <input
        type="text"
        autoFocus={autoFocus}
        value={input}
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
        <p className="text-[12px] text-rose-400 leading-snug">{error}</p>
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
          className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/50 p-4"
          onClick={() => !busy && setConfirm(false)}
          role="alertdialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-xs rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 shadow-2xl p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[14px] text-slate-800 dark:text-zinc-100 font-medium leading-relaxed">
              {t('misc.about:xac_nhan_doi_key')}
            </p>
            <p className="text-[12px] text-slate-500 dark:text-zinc-400 leading-snug">
              {t('misc.about:xac_nhan_doi_key_hint')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm(false)}
                className="px-3 h-9 rounded-lg text-[13px] font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                {t('misc.about:huy')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runChange()}
                className="px-3 h-9 rounded-lg text-[13px] font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50"
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
