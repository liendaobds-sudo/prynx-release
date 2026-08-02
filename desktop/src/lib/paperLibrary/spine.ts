// ============================================================
// ĐỘ DÀY GÁY SÁCH — công thức lấy từ workbook của nhà in
//
// Nguồn: 'Bảng Tra Định Lượng Giấy.xlsm', sheet 'Bảng tra độ dày gáy sách'
// (bóc bằng openpyxl 2026-07-30; công thức Excel đã tái lập lại trong
// hàm dưới đây và verify khớp từng ô).
//
// ⚠ QUAN TRỌNG — hai đường tính độ dày KHÁC NHAU, đừng lẫn:
//
//   1. paperStock.ts  → độ dày ĐO THỰC của một tờ (bảng tra vật tư).
//   2. spine.ts       → độ dày gáy SUY TỪ ĐỊNH LƯỢNG bằng công thức
//                       của xưởng: (gsm / 2) × số trang / 1000, rồi
//                       nhân hệ số bù theo kiểu đóng.
//
// Hai đường cho kết quả LỆCH NHAU (Couche 60.2: bảng đo 0.050mm/tờ,
// công thức quy ra ~0.0602mm/tờ — chênh ~20%). Đây KHÔNG phải lỗi:
// công thức là cách xưởng vẫn báo giá và đặt bìa, gắn với hệ số bù ép
// đã hiệu chỉnh theo máy của họ. Module này giữ NGUYÊN công thức
// workbook để số khớp với giấy tờ xưởng đang dùng.
//
// Chú thích trong workbook (ô V25):
//   - Độ dày cuốn sách tính bằng mm
//   - Độ dày tối thiểu của gáy sách cần > 3 mm
//   - Ví dụ tính được 9,54 hoặc 9,065 (đều > 9) thì có thể làm tròn 10
//   - Ô màu vàng là tham số có thể thay đổi cho phù hợp thực tế
// ============================================================

import type { PaperFamily } from './types';

/** Kiểu đóng sách */
export type BindingMethod =
    | 'thread'   // KHÂU CHỈ — khâu từng tay sách rồi vào bìa
    | 'hotmelt'  // KEO NHIỆT — vào keo PUR/EVA, phay gáy
    | 'mounted'  // BỒI LIÊN KẾT — bồi tay sách lên bìa cứng
    | 'saddle';  // BẤM GHIM GIỮA — gấp đôi + ghim, không có gáy

/** Cán màng lên bìa: không cán, cán 1 mặt, hay cán 2 mặt */
export type LaminationSide = 'none' | '1s' | '2s';

// --- Tham số workbook (ô màu vàng, xưởng được sửa) ---

/** Số trang trên MỘT tờ giấy — ô BA2 = 2 (in 2 mặt, 1 tờ = 2 trang) */
export const PAGES_PER_SHEET = 2;

/** Chia 1000 để đổi g/m² sang mm — ô BI2 */
const MM_DIVISOR = 1000;

/** Hệ số cán màng — ô BK = 0.25; cán 1 mặt lấy nửa, cán 2 mặt lấy trọn */
const LAMINATION_FACTOR = 0.25;

/**
 * Hệ số bù ép theo kiểu đóng, tách theo NHÓM GIẤY.
 *
 * Nhóm tráng phủ (couche/couche matt/duplex/bristol/ivory): hệ số TRỪ —
 * giấy tráng phủ bị ép mỏng lại khi khâu/vào keo.
 * Nhóm không tráng phủ (fort/art/kraft): hệ số CỘNG — giấy xốp nên chồng
 * giấy dày hơn số quy đổi từ định lượng.
 *
 * Số lấy từ ô BC..BH của workbook:
 *   BC=0.05  BD=0.1  BE=0.2  BF=0.3  BG=0.4  BH=0.65
 */
const COATED_FAMILIES: PaperFamily[] = ['couche', 'couche_matt', 'duplex', 'bristol', 'ivory'];

interface BindingCoefficient {
    /** Hệ số bù */
    factor: number;
    /** true = cộng hệ số (giấy xốp), false = trừ hệ số (giấy tráng phủ) */
    add: boolean;
    /** Nhân thêm PAGES_PER_SHEET — chỉ kiểu BỒI LIÊN KẾT, theo đúng workbook */
    timesPagesPerSheet: boolean;
}

/** Bảng hệ số: [nhóm giấy][kiểu đóng] */
const COEFFICIENTS: Record<'coated' | 'uncoated', Record<BindingMethod, BindingCoefficient>> = {
    coated: {
        thread:  { factor: 0.1,  add: false, timesPagesPerSheet: false },  // BD
        hotmelt: { factor: 0.2,  add: false, timesPagesPerSheet: false },  // BE
        mounted: { factor: 0.05, add: true,  timesPagesPerSheet: true },   // BC
        saddle:  { factor: 0,    add: true,  timesPagesPerSheet: false },  // không bù ép — chồng giấy thuần
    },
    uncoated: {
        thread:  { factor: 0.4,  add: true,  timesPagesPerSheet: false },  // BG
        hotmelt: { factor: 0.3,  add: true,  timesPagesPerSheet: false },  // BF
        mounted: { factor: 0.65, add: true,  timesPagesPerSheet: true },   // BH
        saddle:  { factor: 0,    add: true,  timesPagesPerSheet: false },  // không bù ép
    },
};

/**
 * Ngưỡng gáy tối thiểu (mm) theo kiểu đóng — quy cách ngành in:
 *
 * | Kiểu đóng        | Gáy tối thiểu | Lý do                                        |
 * |------------------|---------------|----------------------------------------------|
 * | Keo nhiệt        | 3 mm          | Keo cần diện tích tiếp xúc đủ                |
 * | Khâu chỉ         | —             | Khâu từng tay sách, không yêu cầu ngưỡng    |
 * | Bồi bìa cứng     | 8 mm          | Cần đủ dày cho bìa carton + khớp nối         |
 * | Bấm ghim giữa    | —             | Không có gáy, xem maxThickness thay           |
 */
export const MIN_SPINE_BY_BINDING: Record<BindingMethod, number | null> = {
    hotmelt: 3,
    thread: null,
    mounted: 8,
    saddle: null,    // bấm ghim không có gáy — dùng MAX_SADDLE_MM thay
};

/**
 * Bấm ghim giữa: độ dày cuốn tối đa (mm).
 * Quá dày → ghim không xuyên hết, cuốn phồng gáy.
 * Ngưỡng phổ biến trong ngành: ~6mm (~64 trang giấy thường).
 */
export const MAX_SADDLE_MM = 6;

export interface SpineInput {
    /** Họ giấy ruột */
    family: PaperFamily;
    /** Định lượng giấy ruột (g/m²) */
    gsm: number;
    /** TỔNG SỐ TRANG RUỘT (không tính bìa) — ô AE4 workbook, mặc định 26 */
    totalPages: number;
    /** Kiểu đóng */
    binding: BindingMethod;
    /** Cán màng bìa */
    lamination?: LaminationSide;
    /**
     * Độ dày đo thực của 1 tờ giấy (mm) — từ bảng tra vật tư.
     * Dùng cho BẤM GHIM GIỮA: vì không có hệ số bù ép từ xưởng,
     * độ dày đo thực chính xác hơn công thức gsm.
     */
    measuredPerSheetMm?: number;
}

export interface SpineResult {
    /** Độ dày (mm) — gáy sách hoặc cuốn sách tuỳ kiểu đóng */
    spineMm: number;
    /** Số tờ giấy ruột = totalPages / PAGES_PER_SHEET */
    sheetCount: number;
    /** true nếu kiểu đóng này tạo gáy vuông (thread/hotmelt/mounted), false nếu bấm ghim */
    hasSpine: boolean;
    /** Cảnh báo gáy mỏng — null nếu OK, object nếu dưới ngưỡng tối thiểu */
    thinWarning: { minMm: number } | null;
    /** Cảnh báo cuốn dày — null nếu OK, object nếu vượt ngưỡng (bấm ghim) */
    thickWarning: { maxMm: number } | null;
    /** Hệ số bù đã dùng (để hiện lại cho thợ đối chiếu workbook) */
    factorUsed: number;
}

/**
 * Tính độ dày gáy sách theo đúng công thức workbook.
 *
 * Thứ tự phép tính giữ nguyên như Excel để số khớp từng chữ số:
 *   base = (gsm / PAGES_PER_SHEET) × totalPages
 *   adj  = base ± base × factor
 *   mm   = adj / 1000                      (× PAGES_PER_SHEET nếu bồi liên kết)
 *   mm   = mm + mm × laminationFactor      (nếu có cán màng)
 */
export function calcSpineThickness(input: SpineInput): SpineResult {
    const { family, gsm, totalPages, binding, lamination = 'none', measuredPerSheetMm } = input;

    const sheetCount = Math.ceil(totalPages / PAGES_PER_SHEET);

    // BẤM GHIM GIỮA: dùng độ dày đo thực (nếu có) thay vì công thức gsm,
    // vì không có hệ số bù ép từ xưởng → gsm để lộ sai lệch.
    if (binding === 'saddle' && measuredPerSheetMm != null) {
        const mm = measuredPerSheetMm * sheetCount;
        return {
            spineMm: mm,
            sheetCount,
            hasSpine: false,
            thinWarning: null,
            thickWarning: mm > MAX_SADDLE_MM ? { maxMm: MAX_SADDLE_MM } : null,
            factorUsed: 0,
        };
    }

    // Các kiểu đóng có hệ số bù từ workbook: dùng công thức gsm
    const group = COATED_FAMILIES.includes(family) ? 'coated' : 'uncoated';
    const coef = COEFFICIENTS[group][binding];

    const base = (gsm / PAGES_PER_SHEET) * totalPages;
    const adjusted = coef.add ? base + base * coef.factor : base - base * coef.factor;

    let mm = adjusted / MM_DIVISOR;
    if (coef.timesPagesPerSheet) mm *= PAGES_PER_SHEET;

    if (lamination === '1s') mm = mm + (mm * LAMINATION_FACTOR) / 2;
    else if (lamination === '2s') mm = mm + mm * LAMINATION_FACTOR;

    const minMm = MIN_SPINE_BY_BINDING[binding];
    const thinWarning = minMm !== null && mm < minMm ? { minMm } : null;
    const thickWarning = binding === 'saddle' && mm > MAX_SADDLE_MM
        ? { maxMm: MAX_SADDLE_MM } : null;

    return {
        spineMm: mm,
        sheetCount,
        hasSpine: binding !== 'saddle',
        thinWarning,
        thickWarning,
        factorUsed: coef.factor,
    };
}

/** Nhãn tiếng Việt của kiểu đóng — dùng cho dropdown */
export const BINDING_LABELS: Record<BindingMethod, string> = {
    thread: 'Khâu chỉ',
    hotmelt: 'Keo nhiệt',
    mounted: 'Bồi liên kết (dán đối lưng)',
    saddle: 'Bấm ghim giữa',
};

/** Nhãn cán màng */
export const LAMINATION_LABELS: Record<LaminationSide, string> = {
    none: 'Không cán',
    '1s': 'Cán 1 mặt',
    '2s': 'Cán 2 mặt',
};

/**
 * Kiểu đóng nào workbook có sẵn cột cho họ giấy đó.
 *
 * Workbook KHÔNG tính đủ mọi ô: Duplex và Ivory chỉ có cột BỒI LIÊN KẾT
 * (hai loại này dùng làm bìa, không làm ruột), Kraft cũng vậy. Công thức
 * vẫn chạy được cho mọi tổ hợp, nhưng chỗ nào workbook bỏ trống thì nên
 * để UI cảnh báo là "xưởng không dùng kiểu này cho loại giấy đó".
 */
export const BINDING_AVAILABILITY: Record<PaperFamily, BindingMethod[]> = {
    couche: ['thread', 'hotmelt', 'mounted', 'saddle'],
    couche_matt: ['thread', 'hotmelt', 'mounted', 'saddle'],
    duplex: ['mounted'],
    bristol: ['thread', 'hotmelt', 'mounted', 'saddle'],
    ivory: ['mounted'],
    fort: ['thread', 'hotmelt', 'mounted', 'saddle'],
    art: ['thread', 'hotmelt', 'mounted', 'saddle'],
    kraft: ['mounted'],
    other: [], // Workbook để trống toàn bộ cột KHÁC — chưa có số của xưởng
};
