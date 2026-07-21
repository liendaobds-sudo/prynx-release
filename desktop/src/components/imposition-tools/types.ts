// @ts-nocheck
/**
 * Shared types, interfaces, and constants for the Imposer Dashboard.
 * 
 * Extracted from ImposerDashboard.tsx to reduce file size and
 * allow reuse across ImpositionTab.tsx and other consumers.
 */

// ─── Hợp đồng kiểu SINH từ imposition_core (nguồn chân lý duy nhất) — Task 7/8 ───
// Field client gửi mà lõi Rust không có sẽ thành lỗi biên dịch khi dùng các type này.
// Regenerate: xem ./generated/README.md
export type {
    ImposeSettings,
    LayoutOutput,
    Sheet,
    Placement,
    MarkSeg,
    ToolKind,
    GridStrategy,
    Align as CoreAlign,
    Duplex,
    LayoutType,
    Rotation,
    Margins,
    MarkConfig,
    PontConfig as CorePontConfig,
    ClusterConfig,
    DieCutConfig,
} from './generated';

export interface PontConfig {
    shape: 'circle' | 'l_inverted' | 'l_corner';
    size: number;
    thickness: number;
    isGraphtec?: boolean;
    layerInfoName?: string;
    layerName?: string;
    groupName: string;
    itemName: string;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    guide1Enabled: boolean;
    guide1Pos: string;
    guide1Length: number;
    guide1Thickness: number;
    guide1OffX: number;
    guide1OffY: number;
    guide2Enabled: boolean;
    guide2Pos: string;
    guide2Length: number;
    guide2Thickness: number;
    guide2OffX: number;
    guide2OffY: number;
    disableCollision: boolean;
}
import type { MergeSettings } from '../preprocess-tools/MergeTool';

// ==================== SHARED CONSTANTS ====================

/**
 * Chỉ series ISO A (portrait). Không SRA3/B/Ledger — khổ máy in đặc thù
 * lưu qua preset custom + usages[].
 */
export const PREDEFINED_SIZES: Record<string, { w: number; h: number; classification: 'offset' | 'in_nhanh'; gripperMargin: number }> = {
    A7: { w: 74, h: 105, classification: 'in_nhanh', gripperMargin: 0 },
    A6: { w: 105, h: 148, classification: 'in_nhanh', gripperMargin: 0 },
    A5: { w: 148, h: 210, classification: 'in_nhanh', gripperMargin: 0 },
    A4: { w: 210, h: 297, classification: 'in_nhanh', gripperMargin: 0 },
    A3: { w: 297, h: 420, classification: 'in_nhanh', gripperMargin: 0 },
    A2: { w: 420, h: 594, classification: 'in_nhanh', gripperMargin: 0 },
    A1: { w: 594, h: 841, classification: 'in_nhanh', gripperMargin: 0 },
    A0: { w: 841, h: 1189, classification: 'in_nhanh', gripperMargin: 0 },
};

/** Default formsize + dims khi mount / heal (A3 — khổ in phổ biến). */
export const DEFAULT_FORMSIZE = 'A3';
export const DEFAULT_SHEET_W = PREDEFINED_SIZES.A3.w;
export const DEFAULT_SHEET_H = PREDEFINED_SIZES.A3.h;

// ==================== EXPORTED INTERFACES ====================

export interface BookletSettings {
    /** Phân luồng bắt buộc để không rò thiết lập sơ đồ gấp Offset sang In Nhanh. */
    paperClassification: 'offset' | 'in_nhanh';
    signatureMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    foliosize: number;
    formsize: string;
    customSheetWidth: number;
    customSheetHeight: number;
    bleed: number;
    paperThickness: number;
    markType: 'none' | 'corners' | 'guillotine';
    markOffset?: number;
    markLength?: number;
    markThickness?: number;
    markStyle?: 'default' | 'japanese';
    interleave: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180';
    scaleMode: '100' | 'fit' | 'chain_nup' | 'cut_stack';
    foldPattern?: string;
    gripperMargin?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    marginMode?: 'labels_only' | 'include_marks';
    gapX?: number;
    gapY?: number;
    spreadDistribution?: 'clustered' | 'even';
    gutterMargin?: number;
    separateCover?: boolean;
    coverPageCount?: number;
    blankPlacement?: 'end' | 'center';
    spawnNewTab: boolean;
}

export interface NupSettings {
    layoutType: 'repeat' | 'sequential' | 'cut_stacks' | 'ratio_stack';
    formsize: string;
    customSheetWidth: number;
    customSheetHeight: number;
    bleed: number;
    columns: number;
    rows: number;
    targetQuantity?: number;
    targetQuantitiesByPage?: Record<number, number>;
    hiddenOcgLayerIds?: number[];
    gridStrategy: 'manual' | 'simple_auto' | 'optimal_auto' | 'staggered' | 'row_alt' | 'head_to_tail';
    clusterTileW?: number;
    clusterTileH?: number;
    clusterMode: 'none' | 'row' | 'column';
    clusterCount: number;
    clusterGap: number;
    clusterGapMode: 'item' | 'mark';
    clusterDistribution?: 'default' | 'type';
    clusterBorder: boolean;
    clusterSizingMode?: 'dims' | 'split_cols' | 'split_rows';
    clusterCombineMode?: 'replicate_mixed' | 'zone_per_type' | 'zone_ratio';
    clusterCols?: number;
    clusterRows?: number;
    tileGapX?: number;
    tileGapY?: number;
    splitGap?: number;
    clusterNesting?: boolean;
    gapX: number;
    gapY: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    marginMode: 'labels_only' | 'include_marks';
    gripperMargin?: number;
    duplexFlow: 'normal' | 'double';
    align: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
    mirrorAlign: boolean;
    markType: 'none' | 'corners' | 'guillotine';
    markOffset?: number;
    markLength?: number;
    markThickness?: number;
    markStyle?: 'default' | 'japanese';
    cutType?: 'default' | 'one_dao';
    dieSizeMode?: 'die' | 'page';
    dieOffsetMm?: number;
    fillBlockGap?: number;
    pontType?: 'none' | 'corner' | '5mm' | 'custom';
    pontConfig?: PontConfig;
    spawnNewTab: boolean;
    separateCutPage?: boolean;
    pontsOnCutFile?: boolean;
    isDieCutMode?: boolean;
    shapeType?: string | null;
    shapeParams?: string | null;
    detectedShapesByPage?: Record<number, string>;
    detectedShapeParamsByPage?: Record<number, any>;
    groupingStrategy?: 'maximize_area' | 'strict_ratio' | 'cluster_tile';
    // ═══ Report & xuất tờ duy nhất (spec: binh-tem-be-report) ═══
    exportUniqueSheets?: boolean;
    reportDisplay?: ReportDisplayConfig;
    reportMaterial?: string;
    reportLamination?: number;
    reportLaminationSides?: number;
    reportOrderCode?: string;
    saveByReport?: boolean;
    // ═══ Bình Bế Rớt (CNC) — spec: binh-be-rot-cnc ═══
    cncMode?: boolean;
    cncTwoSided?: boolean;
    cncFlipEdge?: 'long' | 'short';
    cncDuplexMarks?: boolean;
    // ═══ Tự động lưu file in (cài trước khi bình) ═══
    autoSavePrint?: boolean;
    savePrintConfig?: {
        folder: string;
        nameMode: 'report' | 'number' | 'original';
        folderMode: 'per_order' | 'flat';
        includeOrderCode: boolean;
        includeDate: boolean;
        orderCode?: string;
        labelName?: string;
    };
}

// ═══ Cấu hình hiển thị Report sản phẩm (Product_Info) ═══
export type ReportFieldKey =
    | 'orderCode' | 'identifier' | 'gangCount' | 'labelName' | 'material' | 'lamination'
    | 'labelsPerSheet' | 'actualQty' | 'sheetCount' | 'dimensions' | 'paperSize'
    | 'cutFileRef' | 'modeLabel';

export interface ReportDisplayConfig {
    enabled: boolean;
    fieldOrder: ReportFieldKey[];
    showIdentifier: boolean;
    showGangCount: boolean;
    showLabelName: boolean;
    showDimensions: boolean;
    showPaperSize: boolean;
    showLabelsPerSheet: boolean;
    showSheetCount: boolean;
    showActualQty: boolean;
    showMaterial: boolean;
    showLamination: boolean;
    showCutFileRef: boolean;
    showModeLabel: boolean;
    labelNameText: string;
    position: 'top' | 'bottom' | 'left' | 'right';
    centered?: boolean;
    offsetX: number;   // mm
    offsetY: number;   // mm
    fontSize: number;  // pt
    removeDiacritics: boolean;
    customText?: string;
}

export const DEFAULT_MATERIALS: string[] = [
    'Decal PP', 'Decal Đế vàng', 'Decal Nhựa mờ', 'Decal Nhựa trong', 'Decal Bể (Tem vỡ)',
];

export const LAMINATION_OPTIONS: string[] = ['Không cán', 'Cán bóng', 'Cán mờ'];

export const DEFAULT_REPORT_CONFIG: ReportDisplayConfig = {
    enabled: true,
    fieldOrder: ['orderCode', 'identifier', 'gangCount', 'labelName', 'material', 'lamination',
        'labelsPerSheet', 'actualQty', 'sheetCount', 'dimensions', 'paperSize', 'cutFileRef', 'modeLabel'],
    showIdentifier: true, showGangCount: true, showLabelName: true, showDimensions: false, showPaperSize: false,
    showLabelsPerSheet: true, showSheetCount: true, showActualQty: true,
    showMaterial: true, showLamination: true, showCutFileRef: false, showModeLabel: true,
    labelNameText: '',
    position: 'top', offsetX: 5, offsetY: 5, fontSize: 8, removeDiacritics: false,
    centered: true,
};

export type TaskMode = 'booklet' | 'nup' | 'step_repeat' | 'offset' | 'sticker_imposer' | 'cnc_imposer';

export type ActiveToolType = 'none' | 'booklet' | 'nup' | 'shuffle' | 'resize' | 'split' | 'merge' | 'preflight' | 'hairlines' | 'convertcolors' | 'trapping' | 'pdfx' | 'datamerge' | 'numbering' | 'cover_numbering' | 'stick_text_number' | 'ocr' | 'optimize' | 'sticker' | 'sticker_imposer' | 'cnc_imposer' | 'bgremover' | 'watermark' | 'upscale' | 'pages' | 'trim_shift' | 'encrypt' | 'metadata' | 'office_convert';

/**
 * Loại panel mà một công cụ hiển thị trong workspace bình bài.
 *   - 'none'       : chưa chọn tool → hiện ToolMenuList
 *   - 'imposition' : panel bình bài (booklet/nup/sticker/cnc)
 *   - 'merge'      : block Ghép/Trộn riêng (giữ state cục bộ)
 *   - 'preprocess' : render qua PreprocessingRouter
 *   - 'external'   : định tuyến sang component riêng ở ImpositionTab (không vào ImposerDashboard)
 */
export type WorkspacePanelKind = 'none' | 'imposition' | 'merge' | 'preprocess' | 'external';

/**
 * NGUỒN CHÂN LÝ DUY NHẤT cho routing panel của ImposerDashboard.
 * Thay 3 danh sách rời rạc (isPreprocessing / khối merge / isImpositionMode) từng
 * phải tự đồng bộ tay → gốc lỗi rò panel (merge lòi panel bình, pageboxes trống).
 * `Record<ActiveToolType, …>` ép TypeScript kiểm tra ĐỦ KHÓA lúc biên dịch.
 * Tập 'preprocess' được test `toolPanel.test.ts` chốt khớp PREPROCESS_ROUTER_TOOLS.
 */
export const WORKSPACE_TOOL_PANEL: Record<ActiveToolType, WorkspacePanelKind> = {
    none: 'none',
    // Bình bài thật
    booklet: 'imposition',
    nup: 'imposition',
    sticker_imposer: 'imposition',
    cnc_imposer: 'imposition',
    // Ghép/Trộn (block riêng)
    merge: 'merge',
    // Định tuyến sang component riêng ở ImpositionTab (DataMerge/Numbering/CoverNumbering/StickText)
    datamerge: 'external',
    numbering: 'external',
    cover_numbering: 'external',
    stick_text_number: 'external',
    // Tiền xử lý (render qua PreprocessingRouter) — PHẢI khớp PREPROCESS_ROUTER_TOOLS
    shuffle: 'preprocess',
    resize: 'preprocess',
    split: 'preprocess',
    pages: 'preprocess',
    preflight: 'preprocess',
    hairlines: 'preprocess',
    convertcolors: 'preprocess',
    trapping: 'preprocess',
    pdfx: 'preprocess',
    ocr: 'preprocess',
    optimize: 'preprocess',
    sticker: 'preprocess',
    bgremover: 'preprocess',
    watermark: 'preprocess',
    upscale: 'preprocess',
    trim_shift: 'preprocess',
    encrypt: 'preprocess',
    metadata: 'preprocess',
    office_convert: 'preprocess',
};

/**
 * Panel-PHẢI mà ImpositionTab render theo công cụ đang chọn (routing tường minh,
 * thuần — test được mà KHÔNG cần render component nặng).
 *   - 'edit'            : chế độ chỉnh sửa đối tượng (EditLayersPanel)
 *   - datamerge/numbering/cover_numbering/stick_text_number : component VDP/đóng dấu riêng
 *   - 'dashboard'       : ImposerDashboard (bình bài + tiền xử lý)
 */
export type RightPanelKind =
    | 'edit' | 'datamerge' | 'numbering' | 'cover_numbering' | 'stick_text_number' | 'dashboard';

export function resolveRightPanel(activeDashboardTool: string, isObjectEditMode: boolean): RightPanelKind {
    if (isObjectEditMode) return 'edit';
    if (activeDashboardTool === 'datamerge') return 'datamerge';
    if (activeDashboardTool === 'numbering') return 'numbering';
    if (activeDashboardTool === 'cover_numbering') return 'cover_numbering';
    if (activeDashboardTool === 'stick_text_number') return 'stick_text_number';
    return 'dashboard';
}

export interface ImposerDashboardProps {
    tabId: string;
    onStartBooklet: (settings: BookletSettings) => void;
    onStartNup: (settings: NupSettings) => void;
    onStartShuffle?: (settings: any) => void;
    onStartResize?: (settings: any) => void;
    onStartTrimShift?: (settings: any) => void;
    onStartSplit?: (settings: any) => void;
    onStartMerge?: (settings: MergeSettings) => void;
    onStartCatalogPlan?: (planConfig: any, sheetSettings: any) => void;
    initialFeature?: string;
    lockedMode?: 'booklet' | 'nup' | 'sticker_imposer' | 'cnc_imposer';
    onBleedUpdate?: (show: boolean, mm: number) => void;
    onFileFixed?: (blob: Blob, name: string) => void;
    systemMergeFiles?: File[];
    /** Office file → PDF (Word/Excel path-stub File). */
    officeSourceFile?: File | null;
    officeSourceFiles?: File[];
    /** PDF đã bake sửa viewer (xoay/xóa/sắp trang) — preview dùng CÙNG nguồn với output. */
    getWorkingFile?: () => Promise<File>;
}

// ═══ Khai báo capability theo profile công cụ (Task 16 / Req 6) ═══
// Việc một chế độ bình bài có hỗ trợ MARK cắt hay PONT định vị được khai báo
// TƯỜNG MINH ở đây — KHÔNG khóa cứng "diecut thì không mark"/"guillotine thì
// không pont" bằng điều kiện rải rác trong code dựng payload (Req 6.1, 6.4).
//   - diecut (bế tem): có pont định vị, không dùng mark cắt (đã có đường bế)
//   - guillotine (cắt xén) / offset: dùng mark cắt, không pont
export interface ImposerCapability {
    supportsMarks: boolean;
    supportsPont: boolean;
    /** Bình 2 mặt (lật gương mặt sau) — chỉ công cụ CNC */
    supportsTwoSided?: boolean;
}

export const IMPOSER_CAPABILITIES: Record<string, ImposerCapability> = {
    diecut: { supportsMarks: false, supportsPont: true },
    guillotine: { supportsMarks: true, supportsPont: false },
    offset: { supportsMarks: true, supportsPont: false },
    // CNC: bình 2 mặt + boong bế (pont) ở Mặt trước; không mark cắt xén.
    cnc: { supportsMarks: false, supportsPont: true, supportsTwoSided: true },
};

export function getImposerCapability(imposerMode?: string): ImposerCapability {
    return IMPOSER_CAPABILITIES[imposerMode || 'guillotine']
        || { supportsMarks: true, supportsPont: false };
}
