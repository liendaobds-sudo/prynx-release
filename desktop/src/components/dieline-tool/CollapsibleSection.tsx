// ============================================================
// CollapsibleSection — Section gập/mở được (accordion) cho sidebar mockup
//
// Header bấm để gập/mở phần thân; lưu trạng thái cục bộ (mặc định mở/đóng
// truyền qua `defaultOpen`). Dùng để tổ chức panel mockup dài thành các nhóm
// gọn gàng như các phần mềm thiết kế chuyên nghiệp (Dimension, Pacdora).
// Thuần UI, không phụ thuộc store.
// ============================================================

import React, { useState } from 'react';

export interface CollapsibleSectionProps {
    /** Nhãn tiêu đề nhóm. */
    title: string;
    /** Mở sẵn khi khởi tạo (mặc định false = gập). */
    defaultOpen?: boolean;
    /** Tóm tắt/giá trị hiển thị bên phải header (vd tên finish đang chọn). */
    badge?: React.ReactNode;
    children: React.ReactNode;
}

export default function CollapsibleSection({
    title,
    defaultOpen = false,
    badge,
    children,
}: CollapsibleSectionProps) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className={`dt-collapse ${open ? 'open' : ''}`}>
            <button
                type="button"
                className="dt-collapse-header"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
            >
                <span className="dt-collapse-chevron" aria-hidden>
                    {open ? '▾' : '▸'}
                </span>
                <span className="dt-collapse-title">{title}</span>
                {badge != null && <span className="dt-collapse-badge">{badge}</span>}
            </button>
            {open && <div className="dt-collapse-body">{children}</div>}
        </div>
    );
}
