// Tool Profiles — chống rò rỉ state thuật toán giữa công cụ (N-up / Bế tem / Booklet / CNC).
// Field "thuật toán" lưu RIÊNG theo từng công cụ; field "vật lý" (khổ giấy, lề) dùng chung.
// (Giữ NGUYÊN danh sách & hành vi so với store monolith trước refactor.)
//
// taskMode: mỗi công cụ nhớ riêng Tác vụ (Bình trang / Dàn nhiều mẫu). Trước đây
// taskMode global → tem bế / bế rớt / cắt xén ghi đè lẫn nhau.

export const ALGO_PROFILE_KEYS: string[] = [
    'taskMode',
    'impositionUnit',
    'layoutType', 'columns', 'rows', 'gridStrategy', 'groupingStrategy', 'cutBorder',
    // MIXED-GUILLOTINE (audit 2026-07-30 §MG.8/§MG.9): nhớ cạnh lật riêng theo từng công cụ.
    'duplexFlow', 'duplexFlipEdge', 'align',
    'clusterMode', 'clusterCount', 'clusterGap', 'clusterGapMode',
    'clusterDistribution', 'clusterBorder',
    'clusterTileW', 'clusterTileH', 'clusterSizingMode', 'clusterCols', 'clusterRows',
    'clusterCombineMode', 'tileGapX', 'tileGapY', 'clusterNesting',
    // cutType / dieSizeMode / dieOffsetMm: KHÔNG profile — luôn mặc định khi vào tem bế/CNC
    // (user tự chọn 1 Dao nếu cần; không nhớ lần trước).
    'fillBlockGap', 'pontType', 'pontConfig',
    'gapX', 'gapY', 'targetQuantity', 'targetQuantitiesByPage',
    'markType', 'scaleMode', 'signatureMode', 'foliosize', 'interleave',
    'separateCutPage', 'pontsOnCutFile',
    'cncFlipEdge', 'cncDuplexMarks',
];

/** Dao cắt + offset 1 Dao: session-only, reset mỗi lần vào tem bế / CNC. */
export const DIE_CUT_SESSION_DEFAULTS = {
    cutType: 'default' as const,
    dieSizeMode: 'die' as const,
    dieOffsetMm: 0,
    // Chặn rò clusterMode row/column từ N-Up → tem chỉ lấp 1 dải tờ.
    clusterMode: 'none' as const,
};

export const PROFILED_TOOLS = ['nup', 'sticker_imposer', 'cnc_imposer', 'booklet'];

/** Công cụ có dropdown Tác vụ Bình trang / Dàn nhiều mẫu. */
export const LAYOUT_TASK_TOOLS = ['nup', 'sticker_imposer', 'cnc_imposer'] as const;

/**
 * Chuẩn hoá taskMode lưu theo tool:
 * - 'sticker_imposer' / 'cnc_imposer' (legacy: nhầm identity công cụ với tác vụ) → 'nup'
 * - chỉ giữ 'nup' | 'step_repeat' | 'booklet'
 */
export function normalizeProfileTaskMode(mode: unknown, tool: string): string {
    if (mode === 'step_repeat') return 'step_repeat';
    if (mode === 'booklet' || tool === 'booklet') return tool === 'booklet' ? 'booklet' : 'nup';
    // Legacy + multi-design
    if (mode === 'nup' || mode === 'sticker_imposer' || mode === 'cnc_imposer') return 'nup';
    if (tool === 'booklet') return 'booklet';
    return 'nup';
}

/**
 * Đồng bộ layoutType với Tác vụ (Bình trang / Dàn nhiều mẫu).
 *
 * `layoutType === 'repeat'` là cờ nội bộ của Bình trang (S&R). Khi Tác vụ là
 * dàn nhiều mẫu mà layoutType vẫn còn 'repeat' (sót từ session step_repeat /
 * tool khác / profile lệch) thì preview-layout đi nhánh 1 mẫu/tờ — UI hiện
 * "Dàn nhiều mẫu" nhưng lưới vẫn nhìn như Bình trang cho đến khi user toggle.
 */
export function resolveLayoutTypeForTaskMode(
    taskMode: unknown,
    layoutType: unknown,
    tool: string = 'nup',
): 'repeat' | 'sequential' | 'cut_stacks' | 'ratio_stack' | 'mixed_guillotine' {
    const mode = normalizeProfileTaskMode(taskMode, tool);
    if (mode === 'step_repeat') return 'repeat';
    // MIXED-GUILLOTINE (audit 2026-07-30 §MG.8/§MG.9): mode mới chỉ thuộc Bình cắt xén.
    if (layoutType === 'mixed_guillotine' && tool === 'nup') return layoutType;
    if (layoutType === 'cut_stacks' || layoutType === 'ratio_stack' || layoutType === 'sequential') {
        return layoutType;
    }
    // 'repeat' | thiếu | giá trị lạ → sequential (dàn nhiều mẫu mặc định)
    return 'sequential';
}
