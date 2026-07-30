// src/lib/imposerEngine/SettingsTypes.ts

export enum ImpositionMode {
    Booklet = 'booklet',
    NUp = 'nup'
}

export interface BookReportRenderSettings {
    enabled: boolean;
    text: string;
    position: 'top' | 'bottom' | 'left' | 'right';
    centered: boolean;
    offsetX: number;
    offsetY: number;
    fontSize: number;
}

export interface BaseSettings {
    impositionMode: ImpositionMode;
    /** Phân loại máy in; booklet dùng để cách ly cấu hình Digital/Offset tại engine boundary. */
    paperClassification?: 'offset' | 'in_nhanh';
    sheetWidth: number; // 0 means auto
    sheetHeight: number;
    paperThickness: number;
    bleed: number;
    
    // Layout core
    cols?: number;
    rows?: number;
    gapX?: number;
    gapY?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    marginMode?: 'labels_only' | 'include_marks';
    duplexFlow?: 'normal' | 'double';
    // MIXED-GUILLOTINE (audit 2026-07-30 §MG.8/§MG.9): preset cũ thiếu field sẽ dùng mặc định `long` từ store.
    duplexFlipEdge?: 'long' | 'short';
    align?: 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
    mirrorAlign?: boolean;
    interleave?: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180';
    pageOrder?: number[];
    /** Local-only mode flag; serializer emits page_sheet_mode, never raw UI state. */
    pageSheetMode?: boolean;
    // number[] THEO VỊ TRÍ: pageRotations[i] = góc của trang ở vị trí i trong pageOrder
    // (khớp per-instance rotation — nhân bản 1 trang xoay riêng từng bản). Vòng lặp impose
    // đã theo vị trí nên lookup [i]. (Cũ: Record<pageNum,deg> — xem migrate ở loader.)
    pageRotations?: number[];
    
    bookReport?: BookReportRenderSettings;
    onConfirmScale?: (msg: string) => Promise<boolean>;
}

// ==========================================
// 1. GUILLOTINE SETTINGS (Bình xén)
// ==========================================
export interface GuillotineSettings extends BaseSettings {
    imposerMode: 'guillotine';
    layoutType?: 'repeat' | 'sequential' | 'cut_stacks' | 'mixed_guillotine';
    gridStrategy?: 'manual' | 'simple_auto' | 'optimal_auto' | 'staggered' | 'row_alt' | 'head_to_tail';
    cutStack?: boolean;

    markType?: 'none' | 'corners' | 'guillotine';
    markOffset?: number; // mm
    markLength?: number; // mm
    markThickness?: number; // mm
    markStyle?: 'default' | 'japanese';

    targetQuantity?: number;
    targetQuantitiesByPage?: Record<number, number>;
    
    // N-Up Booklet / Catalog (In nhanh)
    bindingMode?: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    foliosize?: number;
    gutterMargin?: number;
    separateCover?: boolean;
    coverPageCount?: number;
    chainNup?: boolean;
    spreadDistribution?: 'clustered' | 'even';
    foldPattern?: string;
    gripperMargin?: number;
    blankPlacement?: 'end' | 'center';
}

// ==========================================
// 2. DIE-CUT SETTINGS (Bình bế tem)
// ==========================================
export interface DieCutSettings extends BaseSettings {
    imposerMode: 'diecut' | 'cnc';
    isDieCutMode: true; // Bắt buộc true
    
    layoutType?: 'repeat' | 'sequential';
    gridStrategy?: 'manual' | 'simple_auto' | 'optimal_auto' | 'staggered' | 'row_alt' | 'head_to_tail';
    
    cutType?: 'default' | 'one_dao';
    fillBlockGap?: number;
    
    pontType?: 'none' | 'corner' | '5mm' | 'custom';
    pontConfig?: {
        shape: 'circle' | 'l_inverted' | 'l_corner';
        size: number;
        thickness: number;
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
    };
    
    shapeType?: string | null;
    shapeParams?: string | null;
    detectedShapesByPage?: Record<number, string>;
    detectedShapeParamsByPage?: Record<number, any>;
    
    targetQuantity?: number;
    targetQuantitiesByPage?: Record<number, number>;
    groupingStrategy?: 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none';
    
    clusterMode?: 'none' | 'row' | 'column';
    clusterCount?: number;
    clusterGap?: number;
    clusterGapMode?: 'item' | 'mark';
    clusterDistribution?: 'default' | 'type';
    clusterBorder?: boolean;
    clusterCombineMode?: 'replicate_mixed' | 'zone_per_type' | 'zone_ratio';
    clusterTileW?: number;
    clusterTileH?: number;
    clusterSizingMode?: 'dims' | 'split_cols' | 'split_rows';
    clusterCols?: number;
    clusterRows?: number;
    tileGapX?: number;
    tileGapY?: number;
    clusterNesting?: boolean;
    
    separateCutPage?: boolean;
    pontsOnCutFile?: boolean;
    hiddenOcgLayerIds?: number[];

    // ═══ Bình Bế Rớt (CNC) — spec: binh-be-rot-cnc ═══
    cncTwoSided?: boolean;
    cncFlipEdge?: 'long' | 'short';
    cncDuplexMarks?: boolean;
}

// ==========================================
// 3. OFFSET SETTINGS (Bình Offset)
// ==========================================
export interface OffsetSettings extends BaseSettings {
    imposerMode: 'offset';
    
    bindingMode?: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    foliosize?: number;
    chainNup?: boolean;
    
    foldPattern?: string;                  // 'sig_8p' | 'sig_16p'
    isCover?: boolean;                     // Label hint for SpreadPlacer
    gripperMargin?: number;                // mm - Khoảng nhíp máy in
    spreadDistribution?: 'clustered' | 'even';
    isBookletSpread?: boolean;
    separateCover?: boolean;
    coverPageCount?: number;
    gutterMargin?: number;
    blankPlacement?: 'end' | 'center';
    
    markType?: 'none' | 'corners' | 'guillotine';
    markOffset?: number; 
    markLength?: number; 
    markThickness?: number; 
    markStyle?: 'default' | 'japanese';
}

export type ProcessingSettings = GuillotineSettings | DieCutSettings | OffsetSettings;
