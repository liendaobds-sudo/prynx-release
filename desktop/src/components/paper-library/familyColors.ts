// ============================================================
// Màu phân họ giấy — mượn tông từ file Excel gốc của xưởng
//
// Bảng tra của xưởng mã màu từng khối giấy (Couche cam đào, Couche
// Matt xanh lá, Duplex hồng, Fort xanh dương…). Giữ đúng hệ màu đó
// để thợ nhìn màu là biết đang ở khối nào, không phải đọc chữ.
//
// Dùng thang màu Tailwind có sẵn (không thêm hex mới, theo §A-02).
// Mỗi họ khai 3 lớp: vệt bên sidebar, chấm tròn, và nền tiêu đề bảng.
// ============================================================

import type { PaperFamily } from '../../lib/paperLibrary';

export interface FamilyTone {
    /** Vệt dọc đánh dấu mục đang chọn ở sidebar */
    bar: string;
    /** Chấm tròn cạnh tên họ giấy */
    dot: string;
    /** Nền dải tiêu đề khối bảng */
    band: string;
    /** Chữ trên dải tiêu đề */
    bandText: string;
}

/**
 * Tông màu từng họ giấy, đối chiếu ảnh bảng Excel:
 *   COUCHE cam đào · COUCHE MATT xanh lá · DUPLEX hồng đất
 *   BRISTOL cam nhạt · IVORY nâu ngà · FORT xanh dương
 *   ART hồng · KRAFT cam · KHÁC xám trung tính
 */
export const FAMILY_TONES: Record<PaperFamily, FamilyTone> = {
    couche: {
        bar: 'bg-orange-400',
        dot: 'bg-orange-400',
        band: 'bg-orange-100 dark:bg-orange-500/15',
        bandText: 'text-orange-900 dark:text-orange-200',
    },
    couche_matt: {
        bar: 'bg-emerald-500',
        dot: 'bg-emerald-500',
        band: 'bg-emerald-100 dark:bg-emerald-500/15',
        bandText: 'text-emerald-900 dark:text-emerald-200',
    },
    duplex: {
        bar: 'bg-rose-400',
        dot: 'bg-rose-400',
        band: 'bg-rose-100 dark:bg-rose-500/15',
        bandText: 'text-rose-900 dark:text-rose-200',
    },
    bristol: {
        bar: 'bg-amber-400',
        dot: 'bg-amber-400',
        band: 'bg-amber-100 dark:bg-amber-500/15',
        bandText: 'text-amber-900 dark:text-amber-200',
    },
    ivory: {
        bar: 'bg-yellow-600',
        dot: 'bg-yellow-600',
        band: 'bg-yellow-100 dark:bg-yellow-600/15',
        bandText: 'text-yellow-900 dark:text-yellow-200',
    },
    fort: {
        bar: 'bg-sky-500',
        dot: 'bg-sky-500',
        band: 'bg-sky-100 dark:bg-sky-500/15',
        bandText: 'text-sky-900 dark:text-sky-200',
    },
    art: {
        bar: 'bg-pink-400',
        dot: 'bg-pink-400',
        band: 'bg-pink-100 dark:bg-pink-500/15',
        bandText: 'text-pink-900 dark:text-pink-200',
    },
    kraft: {
        bar: 'bg-orange-600',
        dot: 'bg-orange-600',
        band: 'bg-orange-100 dark:bg-orange-600/15',
        bandText: 'text-orange-900 dark:text-orange-200',
    },
    other: {
        bar: 'bg-slate-400',
        dot: 'bg-slate-400',
        band: 'bg-slate-200 dark:bg-slate-500/20',
        bandText: 'text-slate-900 dark:text-slate-200',
    },
};
