import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { tv } from '../../i18n';
import { useFeatureActionGuard } from '../../hooks/useToolActivationGuard';
import { buildDielinePdfBlob } from '../../lib/dieline/exportPDF';
import type { DielineModel } from '../../lib/dieline/types';
import { ensurePathBackedPdf, launchDesignApp } from '../../lib/designAppLauncher';

interface Props {
    model: DielineModel;
    disabled?: boolean;
}

// UIUX (2026-10-01 §DIELINE.OPEN-DESIGN): dùng cầu nối ứng dụng sẵn có để mở
// PDF vector 2D từ file tạm, bỏ bước chọn nơi lưu trước khi chỉnh trong AI/Corel.
export default function OpenDielineInDesignButton({ model, disabled = false }: Props) {
    const { t } = useTranslation();
    const requestFeatureAction = useFeatureActionGuard();
    const [isOpen, setIsOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const busyRef = useRef(false);
    const currentRef = useRef({ model, disabled, mounted: true });

    useEffect(() => {
        currentRef.current = { model, disabled, mounted: true };
        return () => { currentRef.current.mounted = false; };
    }, [model, disabled]);

    const menuOpen = isOpen && !disabled && !busy;
    useEffect(() => {
        if (!menuOpen) return;
        menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [menuOpen]);

    const openInApp = async (which: 'illustrator' | 'corel') => {
        setIsOpen(false);
        buttonRef.current?.focus();
        if (disabled || busyRef.current) return;
        if (!requestFeatureAction('packaging.dieline', () => undefined)) return;
        if (!requestFeatureAction('prepress.app_bridge', () => undefined)) return;
        busyRef.current = true;
        setBusy(true);
        try {
            const blob = await buildDielinePdfBlob(model);
            if (!blob) {
                toast.error(tv('Không tạo được PDF 2D. Hãy kiểm tra đường cắt của khuôn rồi thử lại.'));
                return;
            }
            const stillCurrent = () => currentRef.current.mounted
                && !currentRef.current.disabled && currentRef.current.model === model;
            if (!stillCurrent()) return;
            const { L, W, D } = model.params;
            const path = await ensurePathBackedPdf(blob, `${model.standardCode}_${L}x${W}x${D}_2D.pdf`);
            if (!stillCurrent()) return;
            await launchDesignApp(which, path);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(tv('Không thể mở bản 2D: ') + message);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };

    return (
        <div
            className="dt-design-open"
            ref={rootRef}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOpen(false);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setIsOpen(false);
                    buttonRef.current?.focus();
                }
            }}
        >
            <button
                ref={buttonRef}
                type="button"
                className="dt-export-tab"
                disabled={disabled || busy}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-busy={busy}
                title={tv('Mở bản vẽ 2D có kích thước và chú thích bằng Illustrator hoặc CorelDRAW')}
                onClick={() => setIsOpen((value) => !value)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setIsOpen(true);
                    }
                }}
            >
                {busy ? tv('Đang mở bản 2D…') : t('misc.openInDesign:mo_bang_illustrator_corel')}
                <span aria-hidden="true"> ▾</span>
            </button>
            {menuOpen && (
                <div
                    ref={menuRef}
                    className="dt-design-open-menu"
                    role="menu"
                    aria-label={t('misc.openInDesign:mo_bang_illustrator_corel')}
                    onKeyDown={(event) => {
                        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
                        const index = items.indexOf(document.activeElement as HTMLButtonElement);
                        const next = event.key === 'ArrowDown' ? (index + 1) % items.length
                            : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
                                : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
                        if (next >= 0) {
                            event.preventDefault();
                            items[next].focus();
                        }
                    }}
                >
                    <button type="button" role="menuitem" onClick={() => { void openInApp('illustrator'); }}>
                        Adobe Illustrator
                    </button>
                    <button type="button" role="menuitem" onClick={() => { void openInApp('corel'); }}>
                        CorelDRAW
                    </button>
                </div>
            )}
        </div>
    );
}
