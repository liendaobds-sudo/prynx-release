import { useState, useRef, useEffect, useCallback, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

// ── Kiểu dữ liệu menu ──────────────────────────────────────────────────────
export interface MenuItem {
    /** Nhãn hiển thị. Bỏ trống + separator=true → đường kẻ ngăn cách. */
    label?: string;
    /** Phím tắt hiển thị bên phải (chỉ trang trí, không tự bắt phím). */
    shortcut?: string;
    /** Hành động khi bấm. */
    onClick?: () => void;
    /** Mờ + không bấm được. */
    disabled?: boolean;
    /** Vẽ đường kẻ ngăn cách thay vì item. */
    separator?: boolean;
    /** Hiện dấu ✓ (cho item bật/tắt như Rulers, chế độ hiển thị). */
    checked?: boolean;
    /** Icon nhỏ bên trái: emoji/ký tự (string) hoặc component icon (lucide…). */
    icon?: ReactNode;
    /** Submenu xổ ngang ra khi rê chuột (VD: Mở gần đây). Bỏ trống → item thường. */
    submenu?: MenuItem[];
    /**
     * Tooltip riêng khi cần nói rõ hơn nhãn — VD item "Mở gần đây" hiển thị TÊN file
     * nhưng tooltip là ĐƯỜNG DẪN đầy đủ (audit menu 2026-07-28 §MB.15: hai file trùng
     * tên khác thư mục trước đây không phân biệt được). Bỏ trống → dùng label.
     */
    title?: string;
}

export interface MenuDef {
    /** Tên menu trên thanh (File, Edit, View...). */
    label: string;
    items: MenuItem[];
}

interface MenuBarProps {
    menus: MenuDef[];
}

/** Các hàng bấm được trong một panel (bỏ separator và item disabled). */
const focusableRows = (panel: HTMLElement | null): HTMLButtonElement[] =>
    panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>('button[data-menu-row]:not([disabled])')) : [];

/** Dời focus trong panel theo bước ±1 (vòng lại đầu/cuối như menu desktop). */
const moveFocus = (panel: HTMLElement | null, step: 1 | -1, toEdge?: 'first' | 'last') => {
    const rows = focusableRows(panel);
    if (rows.length === 0) return;
    if (toEdge === 'first') { rows[0].focus(); return; }
    if (toEdge === 'last') { rows[rows.length - 1].focus(); return; }
    const current = rows.findIndex((r) => r === document.activeElement);
    const next = current < 0 ? (step === 1 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
    rows[next].focus();
};

/**
 * MenuBar — thanh menu ngang kiểu Acrobat (Tệp / Sửa / Xem / Công cụ / Cửa sổ / Trợ giúp)
 * cho khách quen dùng chuột. Bản thân component chỉ lo phần HIỂN THỊ + tương tác chuột/bàn
 * phím: click mở menu, di chuột sang menu khác (khi đang mở) tự chuyển, Esc/click ngoài đóng.
 * Mọi HÀNH ĐỘNG do phía gọi truyền vào qua onClick — MenuBar không tự biết logic app.
 *
 * UIUX (audit menu 2026-07-28 §MB.7): bổ sung vai trò ARIA (menubar/menu/menuitem) và
 * điều hướng bàn phím đầy đủ (←→ đổi menu, ↑↓ chạy trong menu, → mở submenu, ← quay ra,
 * Home/End, Esc). Trước đây submenu CHỈ mở bằng hover nên "Mở gần đây" và toàn bộ menu
 * Công cụ không thể tới được bằng bàn phím.
 */
export function MenuBar({ menus }: MenuBarProps) {
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const panelRef = useRef<HTMLDivElement | null>(null);
    /** Mở bằng bàn phím → tự đưa focus vào hàng đầu; mở bằng chuột thì KHÔNG giành focus. */
    const focusOnOpenRef = useRef(false);

    // Click ngoài / Esc → đóng.
    useEffect(() => {
        if (openIndex === null) return;
        const onDocClick = (e: MouseEvent) => {
            if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenIndex(null);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpenIndex(null);
        };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [openIndex]);

    // Mở bằng bàn phím: chờ panel render xong rồi focus hàng đầu tiên bấm được.
    useEffect(() => {
        if (openIndex === null || !focusOnOpenRef.current) return;
        focusOnOpenRef.current = false;
        moveFocus(panelRef.current, 1, 'first');
    }, [openIndex]);

    const runItem = useCallback((item: MenuItem) => {
        if (item.disabled || item.separator || item.submenu || !item.onClick) return;
        item.onClick();
        setOpenIndex(null);
    }, []);

    /** Chuyển sang menu bên cạnh; đang mở thì mở luôn menu mới (giống app desktop). */
    const stepMenu = useCallback((from: number, step: 1 | -1, keepOpen: boolean) => {
        const next = (from + step + menus.length) % menus.length;
        if (keepOpen) {
            focusOnOpenRef.current = true;
            setOpenIndex(next);
        }
        btnRefs.current[next]?.focus();
    }, [menus.length]);

    const onBarButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); stepMenu(i, 1, openIndex !== null); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); stepMenu(i, -1, openIndex !== null); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (openIndex !== i) { focusOnOpenRef.current = true; setOpenIndex(i); }
            else moveFocus(panelRef.current, e.key === 'ArrowDown' ? 1 : -1, e.key === 'ArrowDown' ? 'first' : 'last');
        }
    };

    /** Phím trong panel cấp 1. Submenu tự lo ←→ của nó, ở đây chỉ nhận phần còn lại. */
    const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, i: number) => {
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); moveFocus(panelRef.current, 1); break;
            case 'ArrowUp': e.preventDefault(); moveFocus(panelRef.current, -1); break;
            case 'Home': e.preventDefault(); moveFocus(panelRef.current, 1, 'first'); break;
            case 'End': e.preventDefault(); moveFocus(panelRef.current, -1, 'last'); break;
            case 'Escape': e.preventDefault(); setOpenIndex(null); btnRefs.current[i]?.focus(); break;
            case 'Tab': setOpenIndex(null); break;
            default: break;
        }
    };

    return (
        <div
            ref={barRef}
            role="menubar"
            aria-label="Thanh menu chính"
            className="flex items-center h-full text-[13px] text-slate-700 dark:text-zinc-300 select-none"
        >
            {menus.map((menu, i) => {
                const isOpen = openIndex === i;
                return (
                    <div key={menu.label} className="relative h-full">
                        <button
                            ref={(el) => { btnRefs.current[i] = el; }}
                            role="menuitem"
                            aria-haspopup="menu"
                            aria-expanded={isOpen}
                            // UIUX (audit menu 2026-07-28 §MB.7): outline-none trước đây xóa sạch
                            // vòng focus → dùng bàn phím không biết đang ở menu nào.
                            className={`h-full px-3 flex items-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-accent ${
                                isOpen
                                    ? 'bg-black/10 dark:bg-white/15 text-slate-900 dark:text-white'
                                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                            }`}
                            onClick={() => setOpenIndex(isOpen ? null : i)}
                            onKeyDown={(e) => onBarButtonKeyDown(e, i)}
                            // Khi đã có 1 menu mở, rê chuột sang nút khác tự chuyển (giống desktop app).
                            onMouseEnter={() => { if (openIndex !== null) setOpenIndex(i); }}
                        >
                            {menu.label}
                        </button>

                        {isOpen && (() => {
                            // Hai ô riêng như Acrobat: ô ✓ (mục bật/tắt) và ô ICON. Tách ra để
                            // item toggle (Rulers/Dark) hiện được CẢ dấu ✓ LẪN icon cùng lúc,
                            // không đá nhau. Chỉ chừa ô khi menu THỰC SỰ có dùng (tránh trống thừa).
                            const reserveCheck = menu.items.some((it) => typeof it.checked === 'boolean');
                            const reserveIcon = menu.items.some((it) => it.icon != null);
                            return (
                                // UIUX (audit 2026-07-27 §A-03/§A-08): hex nền/viền → bg-app-2/border-app-line, z-[200] → z-context-menu
                                <div
                                    ref={panelRef}
                                    role="menu"
                                    aria-label={menu.label}
                                    onKeyDown={(e) => onPanelKeyDown(e, i)}
                                    className="absolute top-full left-0 mt-0 min-w-[220px] bg-app-2 border border-app-line shadow-xl rounded-b-md py-1 z-context-menu animate-in fade-in slide-in-from-top-1 duration-100"
                                >
                                    {menu.items.map((item, j) =>
                                        item.separator
                                            ? <div key={`sep-${j}`} role="separator" className="my-1 h-px bg-black/10 dark:bg-white/10" />
                                            : <MenuRow
                                                key={(item.label || '') + j}
                                                item={item}
                                                onRun={runItem}
                                                reserveCheck={reserveCheck}
                                                reserveIcon={reserveIcon}
                                                onExitToBar={() => { setOpenIndex(null); btnRefs.current[i]?.focus(); }}
                                            />
                                    )}
                                </div>
                            );
                        })()}
                    </div>
                );
            })}
        </div>
    );
}

// ── Một dòng trong menu: item thường, hoặc item có submenu xổ ngang ─────────
function MenuRow({ item, onRun, reserveCheck, reserveIcon, onExitToBar }: {
    item: MenuItem;
    onRun: (it: MenuItem) => void;
    reserveCheck?: boolean;
    reserveIcon?: boolean;
    /** Esc / ← ở hàng cấp 1 → đóng menu và trả focus về nút trên thanh. */
    onExitToBar?: () => void;
}) {
    const { t } = useTranslation();
    const [subOpen, setSubOpen] = useState(false);
    const hasSub = !!item.submenu && item.submenu.length > 0;
    const rowRef = useRef<HTMLButtonElement>(null);
    const subPanelRef = useRef<HTMLDivElement>(null);
    // UIUX (audit menu 2026-07-28 §MB.9): submenu cũ cách hàng cha 2px (ml-0.5) —
    // con trỏ băng qua khe đó là onMouseLeave chạy → submenu đóng giữa đường. Nay bỏ
    // khe (left-full sát mép) VÀ hoãn đóng 200ms để đường chéo chuột vẫn tới kịp.
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelClose = useCallback(() => {
        if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    }, []);
    const scheduleClose = useCallback(() => {
        cancelClose();
        closeTimerRef.current = setTimeout(() => setSubOpen(false), 200);
    }, [cancelClose]);
    useEffect(() => cancelClose, [cancelClose]);

    // UIUX (audit 2026-07-27 §A-02): hover xanh blue-500 lệch tông → token hover:bg-app-accent
    const rowClass = `w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-accent ${
        item.disabled
            ? 'text-slate-400 dark:text-zinc-600 cursor-default'
            : 'hover:bg-app-accent hover:text-white focus-visible:bg-app-accent focus-visible:text-white text-slate-700 dark:text-zinc-200'
    }`;

    const content = (
        <>
            {reserveCheck && (
                <span className="w-3.5 shrink-0 text-center text-[12px]">
                    {item.checked ? '✓' : ''}
                </span>
            )}
            {reserveIcon && (
                <span className="w-4 shrink-0 flex items-center justify-center text-[12px] opacity-80">
                    {item.icon}
                </span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {hasSub
                ? <span className="ml-4 shrink-0 text-[11px] opacity-60" aria-hidden="true">▶</span>
                : item.shortcut && (
                    // UIUX (audit 2026-07-27 §A-14): tabular-nums rời rạc → class num thống nhất
                    <span className="ml-6 shrink-0 text-[11px] opacity-60 num">{item.shortcut}</span>
                )}
        </>
    );

    /** role + aria-checked: item có cờ bật/tắt phải báo trạng thái cho trình đọc màn hình. */
    const ariaRole = typeof item.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem';

    if (!hasSub) {
        return (
            <button
                ref={rowRef}
                data-menu-row
                role={ariaRole}
                aria-checked={typeof item.checked === 'boolean' ? item.checked : undefined}
                aria-disabled={item.disabled || undefined}
                title={item.title || item.label}
                disabled={item.disabled}
                onClick={() => onRun(item)}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onExitToBar?.(); }
                }}
                className={rowClass}
            >
                {content}
            </button>
        );
    }

    return (
        <div
            className="relative"
            onMouseEnter={() => { cancelClose(); setSubOpen(true); }}
            onMouseLeave={scheduleClose}
        >
            <button
                ref={rowRef}
                data-menu-row
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={subOpen}
                aria-disabled={item.disabled || undefined}
                title={item.title || item.label}
                disabled={item.disabled}
                className={rowClass}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelClose();
                        setSubOpen(true);
                        // Panel render ở lần vẽ kế tiếp → focus sau khi commit.
                        requestAnimationFrame(() => moveFocus(subPanelRef.current, 1, 'first'));
                        return;
                    }
                    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onExitToBar?.(); }
                }}
            >
                {content}
            </button>
            {subOpen && !item.disabled && (
                // UIUX (audit 2026-07-27 §A-03/§A-08): hex nền/viền → bg-app-2/border-app-line; z-[210] → z-context-menu
                // (submenu là con trong stacking context của dropdown cha nên vẫn vẽ đè lên trên)
                <div
                    ref={subPanelRef}
                    role="menu"
                    aria-label={item.label}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveFocus(subPanelRef.current, 1); }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveFocus(subPanelRef.current, -1); }
                        else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); moveFocus(subPanelRef.current, 1, 'first'); }
                        else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); moveFocus(subPanelRef.current, -1, 'last'); }
                        else if (e.key === 'ArrowLeft' || e.key === 'Escape') {
                            // Quay ra hàng cha, giữ menu cấp 1 đang mở (chuẩn menu desktop).
                            e.preventDefault();
                            e.stopPropagation();
                            setSubOpen(false);
                            rowRef.current?.focus();
                        }
                    }}
                    className="absolute top-0 left-full min-w-[200px] max-h-[70vh] overflow-y-auto bg-app-2 border border-app-line shadow-xl rounded-md py-1 z-context-menu animate-in fade-in slide-in-from-left-1 duration-100"
                >
                    {item.submenu!.length === 0
                        ? <div className="px-3 py-1.5 text-[12px] text-slate-400 dark:text-zinc-600">{t('misc.menuBar:trong')}</div>
                        : item.submenu!.map((sub, k) =>
                            sub.separator
                                ? <div key={`ssep-${k}`} role="separator" className="my-1 h-px bg-black/10 dark:bg-white/10" />
                                : <button
                                    key={(sub.label || '') + k}
                                    data-menu-row
                                    role={typeof sub.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem'}
                                    aria-checked={typeof sub.checked === 'boolean' ? sub.checked : undefined}
                                    aria-disabled={sub.disabled || undefined}
                                    disabled={sub.disabled}
                                    onClick={() => onRun(sub)}
                                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-accent ${
                                        sub.disabled
                                            ? 'text-slate-400 dark:text-zinc-600 cursor-default'
                                            // UIUX (audit 2026-07-27 §A-02): hover xanh blue-500 → token hover:bg-app-accent
                                            : 'hover:bg-app-accent hover:text-white focus-visible:bg-app-accent focus-visible:text-white text-slate-700 dark:text-zinc-200'
                                    }`}
                                    title={sub.title || sub.label}
                                >
                                    <span className="w-4 shrink-0 text-center text-[12px]">
                                        {sub.checked ? '✓' : sub.icon || ''}
                                    </span>
                                    <span className="flex-1 truncate">{sub.label}</span>
                                </button>
                        )}
                </div>
            )}
        </div>
    );
}
