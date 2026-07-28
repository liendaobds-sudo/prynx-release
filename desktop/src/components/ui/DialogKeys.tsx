// UIUX (audit 2026-07-27 §B-20): phím tắt cho hộp thoại xác nhận.
// Trước đây các dialog bắt Esc bằng onKeyDown trên div + ref tự focus — mong manh
// (mất focus là mất phím). Component này gắn listener ở document trong lúc dialog
// mounted: Escape → onCancel, Enter → onConfirm (bỏ qua khi đang gõ trong
// input/textarea/select). Render null — nhúng cạnh nội dung dialog, GIỮ handler cũ.
import { useEffect } from 'react';

// UIUX (audit 2026-07-27 §B-20) fix-verify: nhiều dialog có thể cùng mounted (các
// tab đều giữ cây render) → mọi instance đều bắt Enter/Escape. Stack module-level:
// chỉ dialog mở SAU CÙNG (đỉnh stack) được xử lý phím.
const stack: symbol[] = [];

export default function DialogKeys({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
    useEffect(() => {
        // UIUX (audit 2026-07-27 §B-20) fix-verify: đăng ký vào stack khi mount
        const id = Symbol();
        stack.push(id);
        const onKeyDown = (e: KeyboardEvent) => {
            // Chỉ dialog trên cùng của stack xử lý phím
            if (stack[stack.length - 1] !== id) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
                return;
            }
            if (e.key === 'Enter') {
                const tag = (e.target as HTMLElement | null)?.tagName;
                // Đang gõ trong field → Enter thuộc về field, không phải nút xác nhận.
                // BUTTON: để nút đang focus tự kích hoạt (vd. Tab tới "Hủy bỏ" rồi Enter
                // phải là Hủy — không được cướp thành Xác nhận).
                if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT' || tag === 'BUTTON') return;
                e.preventDefault();
                onConfirm();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            // UIUX (audit 2026-07-27 §B-20) fix-verify: gỡ khỏi stack khi unmount
            const idx = stack.indexOf(id);
            if (idx !== -1) stack.splice(idx, 1);
        };
    }, [onConfirm, onCancel]);
    return null;
}
