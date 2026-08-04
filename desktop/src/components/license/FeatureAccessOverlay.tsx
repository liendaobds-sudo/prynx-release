import { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { FEATURE_CATALOG, type FeatureId } from '../../lib/license/features';
import ProFeatureBadge from './ProFeatureBadge';

interface FeatureAccessOverlayProps {
  featureId: FeatureId;
  onLeave?: () => void;
}

/** SEC/UIUX (audit 2026-08-04 §UI.03/§BE.02): khóa tương tác nhưng giữ component mounted để không mất dữ liệu. */
export default function FeatureAccessOverlay({ featureId, onLeave }: FeatureAccessOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // SEC (audit 2026-08-04 §UI.03): modal công cụ được portal lên body với z-index rất cao.
  // Overlay quyền cũng phải portal lên body và nhận focus ngay, nếu không modal đang mở vẫn bấm/Enter được.
  useLayoutEffect(() => {
    dialogRef.current?.focus();
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-slate-950/55 p-6 backdrop-blur-sm"
      onKeyDownCapture={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && onLeave) {
          event.preventDefault();
          onLeave();
          return;
        }
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const button = overlayRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])');
        (button ?? dialogRef.current)?.focus();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-live="assertive"
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-amber-300/60 bg-white p-6 text-center shadow-2xl outline-none dark:border-amber-500/40 dark:bg-zinc-900"
      >
        <div className="mb-3 flex justify-center"><ProFeatureBadge featureId={featureId} /></div>
        <h2 id={titleId} className="text-lg font-bold text-slate-900 dark:text-white">Cần quyền PrynX Pro</h2>
        <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-zinc-300">
          Quyền dùng <span className="font-semibold">{FEATURE_CATALOG[featureId].label}</span> đã thay đổi.
          Dữ liệu đang làm vẫn được giữ nguyên; hãy kích hoạt lại key Pro để tiếp tục.
        </p>
        {onLeave && (
          <button type="button" onClick={onLeave} className="mt-5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800">
            Về trang chính
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
