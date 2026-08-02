// ============================================================
// Tra cứu vật tư giấy
//
// Quy tắc: BẢNG TRA LÀ SỰ THẬT. Khi định lượng cần tra không có
// trong bảng, hàm mới nội suy tuyến tính giữa hai định lượng lân
// cận CÙNG HỌ GIẤY và bật cờ `interpolated` để chỗ gọi biết đây là
// số suy ra — UI phải hiển thị khác (VD dấu ~) để thợ không tưởng
// là số đo thật.
// ============================================================

import { PAPER_STOCKS } from './paperStock';
import type { PaperFamily, PaperStock, ThicknessLookup } from './types';

/** Tìm theo id (kebab-case) */
export function findStockById(id: string): PaperStock | undefined {
    return PAPER_STOCKS.find(s => s.id === id);
}

/**
 * Tìm theo tên nhà in hay gọi, bỏ qua hoa/thường và khoảng trắng thừa.
 * VD "couche  300" khớp "Couche 300".
 */
export function findStockByName(name: string): PaperStock | undefined {
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const target = norm(name);
    return PAPER_STOCKS.find(s => norm(s.name) === target);
}

/** Lọc theo họ giấy, đã sắp theo định lượng tăng dần */
export function listStocksByFamily(family: PaperFamily): PaperStock[] {
    return PAPER_STOCKS
        .filter(s => s.family === family)
        .sort((a, b) => a.gsm - b.gsm);
}

/**
 * Tra độ dày một tờ theo họ giấy + định lượng.
 *
 * - Khớp đúng định lượng → trả số đo trong bảng (`interpolated: false`).
 *   Nếu bảng có nhiều dòng cùng định lượng (VD Duplex 230 có cả 1S và 2S),
 *   dùng `coating` để chọn; không truyền thì lấy dòng đầu theo thứ tự bảng.
 * - Không khớp → nội suy tuyến tính giữa hai dòng kề (`interpolated: true`).
 * - Ngoài khoảng bảng tra → kẹp về đầu/cuối bảng, vẫn tính là nội suy.
 * - Họ giấy rỗng → trả null.
 */
export function lookupThickness(
    family: PaperFamily,
    gsm: number,
    coating?: PaperStock['coating'],
): ThicknessLookup | null {
    const rows = listStocksByFamily(family);
    if (rows.length === 0) return null;

    const exact = rows.filter(s => s.gsm === gsm);
    if (exact.length > 0) {
        const picked = coating ? exact.find(s => s.coating === coating) ?? exact[0] : exact[0];
        return { thicknessMm: picked.thicknessMm, interpolated: false, stock: picked };
    }

    // Khi có nhiều biến thể tráng phủ, nội suy trong đúng nhóm tráng phủ đó
    const pool = coating ? rows.filter(s => s.coating === coating) : rows;
    const usable = pool.length >= 2 ? pool : rows;

    if (gsm < usable[0].gsm) {
        return { thicknessMm: usable[0].thicknessMm, interpolated: true, between: [usable[0], usable[0]] };
    }
    const last = usable[usable.length - 1];
    if (gsm > last.gsm) {
        return { thicknessMm: last.thicknessMm, interpolated: true, between: [last, last] };
    }

    for (let i = 0; i < usable.length - 1; i++) {
        const lo = usable[i];
        const hi = usable[i + 1];
        if (gsm > lo.gsm && gsm < hi.gsm) {
            const ratio = (gsm - lo.gsm) / (hi.gsm - lo.gsm);
            const mm = lo.thicknessMm + ratio * (hi.thicknessMm - lo.thicknessMm);
            // Làm tròn 3 số lẻ — đúng độ chính xác bảng tra (micromet)
            return {
                thicknessMm: Math.round(mm * 1000) / 1000,
                interpolated: true,
                between: [lo, hi],
            };
        }
    }
    return null;
}

/**
 * Độ dày chồng giấy = số tờ × độ dày một tờ (mm).
 * Dùng cho tính gáy sách, chiều cao chồng giấy trên bàn cắt, sức chứa khay máy.
 */
export function stackThicknessMm(sheetCount: number, sheetThicknessMm: number): number {
    if (sheetCount <= 0 || sheetThicknessMm <= 0) return 0;
    return Math.round(sheetCount * sheetThicknessMm * 1000) / 1000;
}
