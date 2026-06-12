// ============================================================
// Nesting Types — Cấu hình và kết quả xếp khuôn vào khổ in
// ============================================================

/** Khổ giấy preset phổ biến trong ngành in */
export interface SheetPreset {
    name: string;
    width: number;   // mm
    height: number;  // mm
}

/** Các khổ giấy phổ biến — ngành in offset Việt Nam */
export const SHEET_PRESETS: SheetPreset[] = [
    { name: '43×65 cm', width: 430, height: 650 },
    { name: '65×84 cm', width: 650, height: 840 },
    { name: '65×100 cm', width: 650, height: 1000 },
    { name: '79×109 cm', width: 790, height: 1090 },
    { name: 'A4 (210×297)', width: 210, height: 297 },
    { name: 'A3 (297×420)', width: 297, height: 420 },
];

/** Chế độ xoay khuôn (grid mode) */
export type RotationMode = 'none' | '90' | 'auto';

/** Chế độ xếp khuôn hộp diêm: cùng/khác chất liệu */
export type TrayNestingMode = 'combined' | 'split';

/** Cấu hình xếp khuôn */
export interface NestingConfig {
    /** Kích thước khổ giấy (mm) */
    sheet: { width: number; height: number };
    /** Lề tay kê 3 cạnh (mm) — không bao gồm cạnh cắn nhíp */
    margin: { top: number; right: number; bottom: number; left: number };
    /** Lề cắn nhíp — 1 cạnh dài, máy in offset (mm) */
    gripperMargin: number;
    /** Khoảng hở dao bế — offset polygon ra ngoài mỗi bên (mm) */
    dieGap: number;
    /** Chế độ xoay: none (0°), 90°, auto (tối ưu 0° vs 90°) */
    rotation: RotationMode;
    /** Hướng tờ giấy: auto, portrait, landscape */
    sheetOrientation: 'auto' | 'portrait' | 'landscape';
    /** Chế độ xếp: 'grid' = step & repeat, 'smart' = lồng thông minh */
    nestingMode: 'grid' | 'smart';
    /** Khoảng cách giữa các khuôn trong grid mode (mm) */
    gutter: number;

    // ── Matchbox Tray nesting ──
    /** Chế độ chất liệu: 'combined' = cùng tờ, 'split' = tờ riêng */
    trayNestingMode: TrayNestingMode;
    /** Khổ giấy riêng cho vỏ bao khi split mode (mm) */
    sleeveSheet: { width: number; height: number };
}

/** Giá trị mặc định */
export const DEFAULT_NESTING_CONFIG: NestingConfig = {
    sheet: { width: 790, height: 1090 },
    margin: { top: 10, right: 10, bottom: 10, left: 10 },
    gripperMargin: 12,
    dieGap: 3,
    gutter: 3,
    rotation: 'none',
    sheetOrientation: 'landscape',
    nestingMode: 'grid',
    trayNestingMode: 'combined',
    sleeveSheet: { width: 790, height: 1090 },
};

/** Vị trí 1 khuôn trên tờ giấy */
export interface PlacedDieline {
    x: number;       // mm, tọa độ góc trái-dưới
    y: number;       // mm
    rotation: number; // deg (0, 90, 180, 270)
}

/** Thông tin Super-Tile (cặp khuôn đã lồng) */
export interface SuperTileInfo {
    /** Kích thước Super-Tile (2 khuôn ghép) */
    tileWidth: number;
    tileHeight: number;
    /** Số khuôn trong 1 tile (thường = 2) */
    countPerTile: number;
    /** Chiến lược lồng */
    strategy: string;
    /** Tiết kiệm so với 2× bbox */
    savedMm: number;
}

/** Kết quả xếp khuôn */
export interface NestingResult {
    /** Danh sách vị trí các khuôn */
    positions: PlacedDieline[];
    /** Số khuôn trên 1 tờ */
    countPerSheet: number;
    /** Số hàng × cột (của super-tiles hoặc grid) */
    rows: number;
    cols: number;
    /** % diện tích sử dụng */
    utilization: number;
    /** Kích thước vùng in khả dụng (sau khi trừ lề) */
    usableArea: { width: number; height: number };
    /** Kích thước tờ giấy thực tế (đã xoay nếu cần) */
    actualSheet: { width: number; height: number };
    /** Bounding box khuôn (bao gồm gutter) */
    cellSize: { width: number; height: number };
    /** Mô tả chiến lược đã chọn */
    label: string;
    /** Thông tin Super-Tile (null nếu grid mode) */
    superTile: SuperTileInfo | null;
}
