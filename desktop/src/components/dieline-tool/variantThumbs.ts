// ============================================================
// [VARIANT 2026-07-29]
// Tra ảnh thumb THAY THỦ CÔNG cho biến thể khuôn bế.
//
// ── Cách thay ảnh ──
// Bỏ tệp ảnh vào `desktop/src/assets/dieline/variants/`, đặt tên đúng MÃ KHUÔN
// hiện trên card:
//
//     src/assets/dieline/variants/PRYNX-SLB-02.png
//
// Xong. Không phải sửa code, không phải khai báo, không phải chạy lệnh nào.
// Đang chạy `run_dev.bat` thì Vite tự nhận ngay (nó theo dõi `src/`).
// Nhận cả .png / .jpg / .jpeg / .webp / .avif.
//
// ── Vì sao đặt trong `src/assets` mà không phải `public/` ──
// `import.meta.glob` cho Vite biết CHÍNH XÁC tệp nào tồn tại ngay lúc build/dev.
// Nhờ vậy card không phải "thử tải rồi bắt lỗi 404": không có request lỗi nào,
// không nháy ảnh. Đặt trong `public/` thì không làm được điều này vì `public/`
// là tệp tĩnh, code không biết trong đó có gì.
//
// ── Vì sao tệp Vite-specific này KHÔNG nằm trong `lib/dieline` ──
// `lib/dieline` được bundle vào sidecar chạy trên Boa (không phải Vite runtime),
// nên phải giữ sạch mọi thứ đặc thù Vite như `import.meta.glob`.
// ============================================================

/** Bản đồ MÃ KHUÔN → URL ảnh, quét từ thư mục assets lúc build/dev.
 *  `eager: true` để tra đồng bộ ngay khi render, không cần state chờ import. */
const modules = import.meta.glob('../../assets/dieline/variants/*.{png,jpg,jpeg,webp,avif}', {
    eager: true,
    query: '?url',
    import: 'default',
}) as Record<string, string>;

const THUMB_BY_CODE: Record<string, string> = {};
for (const [filePath, url] of Object.entries(modules)) {
    // '../../assets/dieline/variants/PRYNX-SLB-02.png' → 'PRYNX-SLB-02'
    const base = filePath.split('/').pop() ?? '';
    const code = base.replace(/\.[^.]+$/, '');
    THUMB_BY_CODE[code.toUpperCase()] = url;
}

/** Ảnh thay thủ công cho mã khuôn này, hoặc undefined nếu chưa có. */
export function variantThumbOverride(code: string): string | undefined {
    return THUMB_BY_CODE[code.toUpperCase()];
}

/** Số ảnh đã thay — dùng cho test và chẩn đoán. */
export function variantThumbOverrideCount(): number {
    return Object.keys(THUMB_BY_CODE).length;
}
