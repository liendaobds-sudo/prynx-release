import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';

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
}

export interface MenuDef {
    /** Tên menu trên thanh (File, Edit, View...). */
    label: string;
    items: MenuItem[];
}

interface MenuBarProps {
    menus: MenuDef[];
}

/**
 * MenuBar — thanh menu ngang kiểu Acrobat (File / Edit / View / Tools / Window / Help)
 * cho khách quen dùng chuột. Bản thân component chỉ lo phần HIỂN THỊ + tương tác chuột/bàn
 * phím: click mở menu, di chuột sang menu khác (khi đang mở) tự chuyển, Esc/click ngoài đóng.
 * Mọi HÀNH ĐỘNG do phía gọi truyền vào qua onClick — MenuBar không tự biết logic app.
 */
export function MenuBar({ menus }: MenuBarProps) {
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const barRef = useRef<HTMLDivElement>(null);

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

    const runItem = useCallback((item: MenuItem) => {
        if (item.disabled || item.separator || item.submenu || !item.onClick) return;
        item.onClick();
        setOpenIndex(null);
    }, []);

    return (
        <div ref={barRef} className="flex items-center h-full text-[13px] text-slate-700 dark:text-zinc-300 select-none">
            {menus.map((menu, i) => {
                const isOpen = openIndex === i;
                return (
                    <div key={menu.label} className="relative h-full">
                        <button
                            className={`h-full px-3 flex items-center transition-colors outline-none ${
                                isOpen
                                    ? 'bg-black/10 dark:bg-white/15 text-slate-900 dark:text-white'
                                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                            }`}
                            onClick={() => setOpenIndex(isOpen ? null : i)}
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
                                <div className="absolute top-full left-0 mt-0 min-w-[220px] bg-white dark:bg-[#2d3236] border border-black/10 dark:border-white/10 shadow-xl rounded-b-md py-1 z-[200] animate-in fade-in slide-in-from-top-1 duration-100">
                                    {menu.items.map((item, j) =>
                                        item.separator
                                            ? <div key={`sep-${j}`} className="my-1 h-px bg-black/10 dark:bg-white/10" />
                                            : <MenuRow key={(item.label || '') + j} item={item} onRun={runItem} reserveCheck={reserveCheck} reserveIcon={reserveIcon} />
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
function MenuRow({ item, onRun, reserveCheck, reserveIcon }: { item: MenuItem; onRun: (it: MenuItem) => void; reserveCheck?: boolean; reserveIcon?: boolean }) {
    const [subOpen, setSubOpen] = useState(false);
    const hasSub = !!item.submenu && item.submenu.length > 0;

    const rowClass = `w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${
        item.disabled
            ? 'text-slate-400 dark:text-zinc-600 cursor-default'
            : 'hover:bg-blue-500 hover:text-white text-slate-700 dark:text-zinc-200'
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
                ? <span className="ml-4 shrink-0 text-[11px] opacity-60">▶</span>
                : item.shortcut && (
                    <span className="ml-6 shrink-0 text-[11px] opacity-60 tabular-nums">{item.shortcut}</span>
                )}
        </>
    );

    if (!hasSub) {
        return <button disabled={item.disabled} onClick={() => onRun(item)} className={rowClass}>{content}</button>;
    }

    return (
        <div
            className="relative"
            onMouseEnter={() => setSubOpen(true)}
            onMouseLeave={() => setSubOpen(false)}
        >
            <button disabled={item.disabled} className={rowClass}>{content}</button>
            {subOpen && !item.disabled && (
                <div className="absolute top-0 left-full ml-0.5 min-w-[200px] max-h-[70vh] overflow-y-auto bg-white dark:bg-[#2d3236] border border-black/10 dark:border-white/10 shadow-xl rounded-md py-1 z-[210] animate-in fade-in slide-in-from-left-1 duration-100">
                    {item.submenu!.length === 0
                        ? <div className="px-3 py-1.5 text-[12px] text-slate-400 dark:text-zinc-600">Trống</div>
                        : item.submenu!.map((sub, k) =>
                            sub.separator
                                ? <div key={`ssep-${k}`} className="my-1 h-px bg-black/10 dark:bg-white/10" />
                                : <button
                                    key={(sub.label || '') + k}
                                    disabled={sub.disabled}
                                    onClick={() => onRun(sub)}
                                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${
                                        sub.disabled
                                            ? 'text-slate-400 dark:text-zinc-600 cursor-default'
                                            : 'hover:bg-blue-500 hover:text-white text-slate-700 dark:text-zinc-200'
                                    }`}
                                    title={sub.label}
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
