// Tool Profiles — chống rò rỉ state thuật toán giữa công cụ (N-up / Bế tem / Booklet / CNC).
// Field "thuật toán" lưu RIÊNG theo từng công cụ; field "vật lý" (khổ giấy, lề) dùng chung.
// (Giữ NGUYÊN danh sách & hành vi so với store monolith trước refactor.)
//
// taskMode: mỗi công cụ nhớ riêng Tác vụ (Bình trang / Dàn nhiều mẫu). Trước đây
// taskMode global → tem bế / bế rớt / cắt xén ghi đè lẫn nhau.

export const ALGO_PROFILE_KEYS: string[] = [
    'taskMode',
    'layoutType', 'columns', 'rows', 'gridStrategy', 'groupingStrategy',
    'duplexFlow', 'align',
    'clusterMode', 'clusterCount', 'clusterGap', 'clusterGapMode',
    'clusterDistribution', 'clusterBorder',
    'clusterTileW', 'clusterTileH', 'clusterSizingMode', 'clusterCols', 'clusterRows',
    'clusterCombineMode', 'tileGapX', 'tileGapY', 'clusterNesting',
    'cutType', 'fillBlockGap', 'pontType', 'pontConfig',
    'gapX', 'gapY', 'targetQuantity', 'targetQuantitiesByPage',
    'markType', 'scaleMode', 'signatureMode', 'foliosize', 'interleave',
    'separateCutPage', 'pontsOnCutFile',
    'cncFlipEdge', 'cncDuplexMarks',
];

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
