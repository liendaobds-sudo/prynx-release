import { useEffect, useRef } from 'react';

/**
 * UIUX (audit 2026-08-22 §UX.MD.01): mọi hộp thoại PDF dùng chung vòng đời
 * focus/ESC để phím tắt của viewer không xuyên qua lớp đang mở.
 */
export function useDialogLifecycle(onClose: () => void, enabled = true) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!enabled) return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const restoreTarget = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');

        const focusInitial = () => {
            const first = getFocusable()[0];
            (first || dialog).focus();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = getFocusable();
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        dialog.addEventListener('keydown', handleKeyDown);
        focusInitial();
        return () => {
            dialog.removeEventListener('keydown', handleKeyDown);
            if (restoreTarget?.isConnected) restoreTarget.focus();
        };
    }, [enabled]);

    return dialogRef;
}
