// src/lib/imposerEngine/FoldPatterns.ts
// =========================================================================
//  Spread-level fold patterns for offset catalog imposition.
//  Merged from OffsetPatterns.ts (Kodak Preps page-level data)
//  into spread-level abstraction compatible with the pipeline.
//
//  spreadIndex = temp PDF page index (interleave normal):
//    0=sheet0F, 1=sheet0B, 2=sheet1F, 3=sheet1B, ...
//
//  Verification rule: For saddle stitch N pages,
//    sum of any two pages sharing a position = N+1.
// =========================================================================

export interface SpreadSlot {
    spreadIndex: number;
    rotation: 0 | 180;
    col: number;
    row: number;
}

export interface SpreadFoldPattern {
    id: string;
    name: string;
    description: string;
    pagesPerSig: number;
    sheetsPerSig: number;
    spreadsPerSig: number;
    cols: number;
    rows: number;
    frontPlate: SpreadSlot[];
    backPlate: SpreadSlot[];
    /** Kiểu in đảo mặt trên máy offset */
    workStyle: 'sheetwise' | 'work_and_turn' | 'work_and_tumble';
}

// =========================================================================
//  4p: 1 sheet × 2 sides = 2 spreads, grid 1×1
//  Gấp đôi đơn giản. 1 tờ = 4 trang.
//  Dùng cho: Tay sách dư cuối cùng khi chia tép (thread binding).
//
//  Spreads (saddle 4p, normal interleave):
//    Spread 0 = Sheet0 Front = [T4 | T1]
//    Spread 1 = Sheet0 Back  = [T2 | T3]
//
//  Mặt Trước kẽm (1×1 grid):
//    [Spread 0 = T4|T1, 0°]
//
//  Mặt Sau kẽm (1×1 grid):
//    [Spread 1 = T2|T3, 0°]
//
//  Verify: T4+T1=5=4+1 ✓, T2+T3=5 ✓
// =========================================================================
const SPREAD_4P_2UP: SpreadFoldPattern = {
    id: 'sig_4p_2up', name: 'Tay 4 Trang (2 Bộ)',
    description: 'Nhân 2 bộ tự trở (Lật ngang / Work and Turn). Dành cho sách khổ nhỏ.',
    pagesPerSig: 4, sheetsPerSig: 1, spreadsPerSig: 2, cols: 2, rows: 2,
    workStyle: 'work_and_turn',
    frontPlate: [
        { spreadIndex: 1, rotation: 180, col: 0, row: 0 },
        { spreadIndex: 0, rotation: 180, col: 1, row: 0 },
        { spreadIndex: 1, rotation: 0,   col: 0, row: 1 },
        { spreadIndex: 0, rotation: 0,   col: 1, row: 1 }
    ],
    backPlate: []
};

// =========================================================================
//  4p (1-Up): 1 sheet × 2 sides = 2 spreads, grid 1×2
//  Dành cho sách khổ lớn (A4, B5) in trên kẽm nhỏ. Chỉ in 1 bộ.
// =========================================================================
const SPREAD_4P_1UP: SpreadFoldPattern = {
    id: 'sig_4p_1up', name: 'Tay 4 Trang (1 Bộ)',
    description: 'In 1 bộ tự trở lật nhíp (Work and Tumble). Dành cho sách khổ lớn.',
    pagesPerSig: 4, sheetsPerSig: 1, spreadsPerSig: 2, cols: 1, rows: 2,
    workStyle: 'work_and_tumble',
    frontPlate: [
        { spreadIndex: 1, rotation: 180, col: 0, row: 0 }, // Back spread upside down
        { spreadIndex: 0, rotation: 0,   col: 0, row: 1 }  // Front spread normal
    ],
    backPlate: []
};

// =========================================================================
//  8p: 2 sheets × 2 sides = 4 spreads, grid 2×2 (tự trở)
//  Gấp chữ thập (right-angle fold). 2 tờ lồng = 8 trang.
//
//  Spreads (saddle 8p, normal interleave):
//    Spread 0 = Sheet0 Front = [T8 | T1]
//    Spread 1 = Sheet0 Back  = [T2 | T7]
//    Spread 2 = Sheet1 Front = [T6 | T3]
//    Spread 3 = Sheet1 Back  = [T4 | T5]
//
//  Mặt kẽm duy nhất (2×2 grid, tự trở lật nhíp):
//    Row 0 (top): [Spread 1 ↻180°][Spread 0 ↻180°] = [T7↻|T2↻] [T1↻|T8↻]
//    Row 1 (bot): [Spread 2   →0°][Spread 3   →0°] = [T6 |T3 ] [T4 |T5 ]
//
//  Verify: T7+T2=9=8+1 ✓, T1+T8=9 ✓, T6+T3=9 ✓, T4+T5=9 ✓
//
//  Verified against factory imposition diagrams (8 trang lẻ tự trở):
//    Case 80p catalog, 8p remainder pages [4,5,6,7,72,73,74,75]:
//    Row 0: [74↻ 05↻ | 04↻ 75↻]
//    Row 1: [73   06  | 07   72 ]
// =========================================================================
const SPREAD_8P: SpreadFoldPattern = {
    id: 'sig_8p', name: 'Tay 8 Trang',
    description: 'Bù 8 trang tự trở (Lật ngang / Work and Turn).',
    pagesPerSig: 8, sheetsPerSig: 2, spreadsPerSig: 4, cols: 2, rows: 2,
    workStyle: 'work_and_turn',
    frontPlate: [
        { spreadIndex: 3, rotation: 180, col: 0, row: 0 },
        { spreadIndex: 2, rotation: 180, col: 1, row: 0 },
        { spreadIndex: 0, rotation: 0,   col: 0, row: 1 },
        { spreadIndex: 1, rotation: 0,   col: 1, row: 1 }
    ],
    backPlate: []
};

// =========================================================================
//  16p: 4 sheets × 2 sides = 8 spreads, grid 2×2
//  Tiêu chuẩn công nghiệp. Gấp chữ thập 3 lần. 4 tờ lồng = 16 trang.
//
//  Spreads (saddle 16p, normal interleave):
//    Spread 0 = Sheet0 Front = [T16| T1]
//    Spread 1 = Sheet0 Back  = [T2 | T15]
//    Spread 2 = Sheet1 Front = [T14| T3]
//    Spread 3 = Sheet1 Back  = [T4 | T13]
//    Spread 4 = Sheet2 Front = [T12| T5]
//    Spread 5 = Sheet2 Back  = [T6 | T11]
//    Spread 6 = Sheet3 Front = [T10| T7]
//    Spread 7 = Sheet3 Back  = [T8 | T9]
//
//  Mặt Trước kẽm (2×2 grid) — THEO ĐÚNG CODE bên dưới:
//    Row 0: [Spread1 ↻180°][Spread5 ↻180°] = [T2|T15]↻ [T6|T11]↻
//    Row 1: [Spread2   →0°][Spread6   →0°] = [T14|T3]  [T10|T7]
//
//  Mặt Sau kẽm (2×2 grid):
//    Row 0: [Spread4 ↻180°][Spread0 ↻180°] = [T12|T5]↻ [T16|T1]↻
//    Row 1: [Spread7   →0°][Spread3   →0°] = [T8|T9]   [T4|T13]
//
//  LƯU Ý: thứ tự Mặt Trước/Sau ở đây chỉ là NHÃN (sheetwise in cả 2 kẽm); điều
//  quan trọng là mỗi kẽm gồm đúng tập spread {1,5,2,6} và {4,0,7,3}.
//  Placements + xoay 0/180 đã được raster-verify (ink lật đúng nửa trên/dưới).
//  CHƯA raster-verify "backup registration" (mặt trước úp khít mặt sau khi gấp
//  tay 16 thật) — cần gấp mẫu/đối chiếu sơ đồ xưởng trước khi tin tuyệt đối.
// =========================================================================
const SPREAD_16P: SpreadFoldPattern = {
    id: 'sig_16p', name: 'Tay 16 Trang',
    description: 'Tiêu chuẩn xưởng. 4 tờ lồng = 16 trang. Kẽm A/B.',
    pagesPerSig: 16, sheetsPerSig: 4, spreadsPerSig: 8, cols: 2, rows: 2,
    workStyle: 'sheetwise',
    frontPlate: [
        { spreadIndex: 1, rotation: 180, col: 0, row: 0 },
        { spreadIndex: 5, rotation: 180, col: 1, row: 0 },
        { spreadIndex: 2, rotation: 0,   col: 0, row: 1 },
        { spreadIndex: 6, rotation: 0,   col: 1, row: 1 }
    ],
    backPlate: [
        { spreadIndex: 4, rotation: 180, col: 0, row: 0 },
        { spreadIndex: 0, rotation: 180, col: 1, row: 0 },
        { spreadIndex: 7, rotation: 0,   col: 0, row: 1 },
        { spreadIndex: 3, rotation: 0,   col: 1, row: 1 }
    ]
};

// =========================================================================
//  REGISTRY
// =========================================================================

export const SPREAD_FOLD_REGISTRY: SpreadFoldPattern[] = [SPREAD_4P_1UP, SPREAD_4P_2UP, SPREAD_8P, SPREAD_16P];

export const getSpreadPatternById = (id: string): SpreadFoldPattern | undefined =>
    SPREAD_FOLD_REGISTRY.find(p => p.id === id);

/** Chỉ trả pattern khớp tuyệt đối. Dùng ở đường xuất để không ép tay 28p vào mẫu 16p. */
export const getExactPatternForPageCount = (pagesPerSig: number): SpreadFoldPattern | undefined =>
    SPREAD_FOLD_REGISTRY.find(p => p.pagesPerSig === pagesPerSig);

/** Tự động chọn pattern phù hợp nhất dựa trên số trang tay sách */
export const getPatternForPageCount = (pagesPerSig: number): SpreadFoldPattern | undefined => {
    // Ưu tiên match chính xác
    const exact = getExactPatternForPageCount(pagesPerSig);
    if (exact) return exact;
    // Fallback: pattern lớn nhất chứa được
    return [...SPREAD_FOLD_REGISTRY]
        .sort((a, b) => b.pagesPerSig - a.pagesPerSig)
        .find(p => p.pagesPerSig <= pagesPerSig);
};
