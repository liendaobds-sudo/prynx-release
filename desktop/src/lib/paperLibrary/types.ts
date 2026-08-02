// ============================================================
// Thư viện vật tư in — Kiểu dữ liệu
//
// SSOT cho các bảng tra cứu vật tư của nhà in Việt Nam:
//   1. Định lượng giấy (g/m²) → độ dày một tờ (mm)   → paperStock.ts
//   2. Độ dày gáy sách theo kiểu đóng                 → spine.ts
//   3. Độ dày các loại màng cán                       → laminationFilm.ts
//   4. Số tờ tối đa may chỉ được cho từng loại giấy   → threadSewing.ts
//
// Mọi kích thước trong thư viện này dùng đơn vị MILIMÉT (mm),
// định lượng dùng g/m² — đúng quy ước bảng tra của nhà in.
// ============================================================

/** Họ giấy — nhóm theo cách nhà in gọi khi đặt hàng giấy */
export type PaperFamily =
    | 'couche'       // Couche (tráng phủ bóng)
    | 'couche_matt'  // Couche Matt (tráng phủ mờ)
    | 'duplex'       // Duplex (bìa cứng 1 mặt trắng / 2 mặt trắng)
    | 'bristol'      // Bristol
    | 'ivory'        // Ivory (Ngà, có loại lưng kraft)
    | 'fort'         // Fort (giấy in offset không tráng phủ)
    | 'art'          // Art (EK, Econo, Natural, Elica)
    | 'kraft'        // Kraft (Nhật / Châu Âu / kraft trắng)
    | 'other';       // Cal, Crystal, Bisomi, Pelure, Carbonless…

/** Số mặt tráng phủ ghi trên bảng tra: 1S = tráng 1 mặt, 2S = tráng 2 mặt */
export type CoatingSides = '1S' | '2S';

/** Một dòng trong bảng tra định lượng → độ dày */
export interface PaperStock {
    /** Mã định danh duy nhất, kebab-case — dùng làm key khi lưu preset */
    id: string;
    /** Họ giấy */
    family: PaperFamily;
    /** Tên hiển thị, giữ nguyên cách ghi trong bảng tra của nhà in */
    name: string;
    /** Định lượng (g/m²) */
    gsm: number;
    /** Độ dày MỘT tờ (mm) */
    thicknessMm: number;
    /** Số mặt tráng phủ, nếu bảng tra có phân biệt */
    coating?: CoatingSides;
    /** Xuất xứ / dòng sản phẩm ghi trong bảng (Nhật, Châu Âu, Indo, VN, Thái, BB…) */
    origin?: string;
    /** Ghi chú thêm (VD: lưng kraft, tờ đầu/giữa/cuối của liên carbonless) */
    note?: string;
}

/** Kết quả tra cứu độ dày — có cờ cho biết là số tra thẳng hay nội suy */
export interface ThicknessLookup {
    /** Độ dày một tờ (mm) */
    thicknessMm: number;
    /** true = nội suy giữa hai định lượng lân cận, KHÔNG có trong bảng tra */
    interpolated: boolean;
    /** Dòng bảng tra khớp chính xác (chỉ có khi interpolated = false) */
    stock?: PaperStock;
    /** Hai dòng lân cận đã dùng để nội suy (chỉ có khi interpolated = true) */
    between?: [PaperStock, PaperStock];
}
