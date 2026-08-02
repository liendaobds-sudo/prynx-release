// ============================================================
// SỐ TỜ TỐI ĐA MAY CHỈ ĐƯỢC cho từng loại giấy
//
// Nguồn: 'Bảng Tra Định Lượng Giấy.xlsm', sheet 'May chi '.
// Bảng nhỏ (8 mã giấy), nhưng là giới hạn CƠ KHÍ của máy khâu: quá số
// tờ này thì kim không xuyên hết chồng giấy, hoặc chỉ bị đứt.
//
// Mã giấy trong sheet viết tắt theo cách xưởng gọi ở máy:
//   C115  = Couche 115      F70  = Fort 70
//   C150  = Couche 150      F80  = Fort 80
//   C200  = Couche 200      F100 = Fort 100
//   Cmatt = Couche Matt     F120 = Fort 120
//
// Cột 'Lamination' = số tờ tối đa khi giấy ĐÃ CÁN MÀNG (màng làm giấy
// trượt và dày thêm nên phải khâu ít tờ hơn). Sheet chỉ ghi cột này cho
// ba mã Couche; các mã Fort và Cmatt để trống — chưa có số của xưởng.
// ============================================================

/** Một dòng giới hạn may chỉ */
export interface ThreadSewingLimit {
    /** Mã giấy như xưởng ghi ở máy khâu */
    code: string;
    /** Tên giấy đầy đủ, khớp với PAPER_STOCKS khi tra được */
    paperName: string;
    /** Số tờ tối đa may chỉ được, giấy KHÔNG cán màng */
    maxSheets: number;
    /** Số tờ tối đa khi giấy ĐÃ cán màng — undefined = sheet để trống */
    maxSheetsLaminated?: number;
}

/** Bảng giới hạn may chỉ — 8 mã giấy, đúng thứ tự sheet gốc */
export const THREAD_SEWING_LIMITS: ThreadSewingLimit[] = [
    { code: 'C115', paperName: 'Couche 115', maxSheets: 4, maxSheetsLaminated: 3 },
    { code: 'C150', paperName: 'Couche 150', maxSheets: 3, maxSheetsLaminated: 2 },
    { code: 'C200', paperName: 'Couche 200', maxSheets: 2, maxSheetsLaminated: 2 },
    { code: 'F70', paperName: 'Fort 70 Indo', maxSheets: 5 },
    { code: 'F80', paperName: 'Fort 80 Indo', maxSheets: 5 },
    { code: 'F100', paperName: 'Fort 100 Indo', maxSheets: 4 },
    { code: 'F120', paperName: 'Fort 120', maxSheets: 3 },
    { code: 'Cmatt', paperName: 'Couche Matt', maxSheets: 2 },
];

/** Tra giới hạn theo mã giấy ở máy (C115, F80…), bỏ qua hoa/thường */
export function findThreadSewingLimit(code: string): ThreadSewingLimit | undefined {
    const target = code.trim().toLowerCase();
    return THREAD_SEWING_LIMITS.find(l => l.code.toLowerCase() === target);
}

/**
 * Số tờ tối đa may chỉ được cho một mã giấy.
 * Trả null khi sheet không có số cho tổ hợp đó (VD Fort đã cán màng).
 */
export function maxSheetsForThreadSewing(code: string, laminated = false): number | null {
    const limit = findThreadSewingLimit(code);
    if (!limit) return null;
    if (!laminated) return limit.maxSheets;
    return limit.maxSheetsLaminated ?? null;
}

/**
 * Kiểm một tay sách có khâu chỉ được không.
 *
 * `sheetsPerSignature` = số tờ trong MỘT tay sách (không phải cả cuốn) —
 * máy khâu xuyên từng tay, nên giới hạn áp cho tay sách.
 */
export function canThreadSew(
    code: string,
    sheetsPerSignature: number,
    laminated = false,
): { ok: boolean; max: number | null; reason?: string } {
    const max = maxSheetsForThreadSewing(code, laminated);
    if (max === null) {
        return {
            ok: false,
            max: null,
            reason: laminated
                ? `Sheet 'May chi' chưa có số tờ tối đa cho ${code} khi đã cán màng`
                : `Không có mã giấy ${code} trong bảng may chỉ`,
        };
    }
    if (sheetsPerSignature > max) {
        return {
            ok: false,
            max,
            reason: `${code}: tay sách ${sheetsPerSignature} tờ vượt giới hạn ${max} tờ`,
        };
    }
    return { ok: true, max };
}
