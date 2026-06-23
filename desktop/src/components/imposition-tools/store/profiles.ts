// Tool Profiles — chống rò rỉ state thuật toán giữa công cụ (N-up / Bế tem / Booklet / CNC).
// Field "thuật toán" lưu RIÊNG theo từng công cụ; field "vật lý" (khổ giấy, lề) dùng chung.
// (Giữ NGUYÊN danh sách & hành vi so với store monolith trước refactor.)

export const ALGO_PROFILE_KEYS: string[] = [
    'layoutType', 'columns', 'rows', 'gridStrategy', 'groupingStrategy',
    'duplexFlow', 'align',
    'clusterMode', 'clusterCount', 'clusterGap', 'clusterGapMode',
    'clusterDistribution', 'clusterBorder',
    'clusterTileW', 'clusterTileH', 'clusterSizingMode', 'clusterCols', 'clusterRows',
    'tileGapX', 'tileGapY', 'clusterNesting',
    'cutType', 'fillBlockGap', 'pontType', 'pontConfig',
    'gapX', 'gapY', 'targetQuantity', 'targetQuantitiesByPage',
    'markType', 'scaleMode', 'signatureMode', 'foliosize', 'interleave',
    'separateCutPage', 'pontsOnCutFile',
    'cncFlipEdge', 'cncDuplexMarks',
];

export const PROFILED_TOOLS = ['nup', 'sticker_imposer', 'cnc_imposer', 'booklet'];
