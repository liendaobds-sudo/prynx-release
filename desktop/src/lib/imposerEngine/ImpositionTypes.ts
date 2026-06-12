// src/lib/imposerEngine/ImpositionTypes.ts
// =========================================================================
//  Đặc tả Input/Output JSON cho engine bình catalog ghim giữa
//  Theo tài liệu đặc tả kỹ thuật §11
// =========================================================================

// ==================== INPUT ====================

export type CoverMode = 'same_stock' | 'separate_stock' | 'no_cover';
export type NumberingMode = 'includes_cover' | 'interior_only';
export type CoverMergePolicy = 'merge_into_body' | 'separate_cover_form';
export type GripperEdge = 'top' | 'bottom' | 'left' | 'right';
export type TurnPolicy = 'sheetwise' | 'work_and_turn' | 'work_and_tumble' | 'perfecting';
export type PressMode = 'single_sided' | 'perfecting';
export type RemainderPlacement = 'outside' | 'inside';

export interface StockGroupInput {
    id: string;           // 'cover', 'text', 'insert_1'
    type: 'cover' | 'text' | 'insert';
    stock_code: string;   // Mã giấy: 'C300', 'M150'
    pages: number;        // Số trang thuộc nhóm stock này
}

export interface SpoilagePolicy {
    method: 'flat' | 'per_stock_group';
    default_rate: number;
    cover_rate?: number;
    text_rate?: number;
    flat_sheets?: number; // Hao tuyệt đối theo tờ
}

export interface ProductionConstraints {
    max_forms?: number;
    prefer_fewer_forms?: boolean;
    split_teps?: boolean;
}

export interface ImpositionInput {
    total_pages_physical: number;
    numbering_mode: NumberingMode;
    cover_mode: CoverMode;
    cover_pages: number;              // Mặc định 4
    quantity_books: number;
    spoilage_policy: SpoilagePolicy;
    preferred_signature_sizes: number[]; // [16, 8, 4]
    template_profile_id: string;
    stock_groups: StockGroupInput[];
    gripper_edge: GripperEdge;
    turn_policy: TurnPolicy;
    press_mode: PressMode;
    allow_padding_blanks: boolean;
    remainder_placement: RemainderPlacement;
    production_constraints?: ProductionConstraints;
    cover_merge_policy?: CoverMergePolicy;
    source_file_name?: string;
}

// ==================== OUTPUT ====================

export interface NormalizedPublication {
    total_pages_physical: number;
    cover_mode: CoverMode;
    cover_pages: number;
    text_pages: number;
    padding_blanks: number;
}

export interface StockPartition {
    id: string;
    type: 'cover' | 'text' | 'insert';
    pages: number;
    pages_normalized: number; // Sau padding bội 4
    decomposition: number[]; // [16, 16, 16, 16, 8, 4]
}

export type SignatureOrder = 'inner' | 'mid' | 'outer' | 'outer_extra';

export interface SignatureRecord {
    id: string;               // 'sig_text_01'
    size: number;              // 16, 8, 4
    stock_group: string;       // 'text', 'cover'
    order: SignatureOrder;
    page_range_absolute: string;  // '32-47' hoặc '24-31 + 48-55'
    page_indices: number[];       // 0-based PDF page indices
    actual_page_count: number;
    is_cover: boolean;
    work_style: TurnPolicy;
    fold_pattern_id: string;
}

export interface FormRecord {
    id: string;                // '1A/1B', '8p_self_turn', 'cover_self_turn'
    signature_id: string;
    sets_per_sheet: number;
    stock_group: string;
    work_style: TurnPolicy;
    plate_sides: number;       // Sheetwise = 2, self-turn = 1
}

export interface LocalToAbsoluteMap {
    [sigId: string]: { [localPage: number]: number }; // local 1-based → absolute 1-based
}

export interface FormProductionMetrics {
    form_id: string;
    sets_per_sheet: number;
    required_sets: number;
    sheets_required: number;
    passes_per_sheet: number;
    impressions: number;
    plate_sides: number;
    stock_group: string;
}

export interface ValidationStatus {
    ok: boolean;
    page_coverage_valid: boolean;
    no_duplicates_valid: boolean;
    pair_sum_valid: boolean;
    total_pages_check: boolean;
    errors: string[];
}

export interface ImpositionOutput {
    normalized_publication: NormalizedPublication;
    stock_partitions: StockPartition[];
    signatures: SignatureRecord[];
    forms: FormRecord[];
    local_to_absolute_page_map: LocalToAbsoluteMap;
    sheets_required_per_form: FormProductionMetrics[];
    yield_balance: {
        max_deliverable_sets: number;
        bottleneck_form: string;
    };
    warnings: string[];
    validation_status: ValidationStatus;
    report: string;
}
