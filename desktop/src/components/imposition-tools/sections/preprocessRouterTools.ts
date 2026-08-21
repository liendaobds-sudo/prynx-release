/**
 * preprocessRouterTools — Danh sách công cụ TIỀN XỬ LÝ mà PreprocessingRouter render nội dung.
 *
 * NGUỒN CHÂN LÝ DUY NHẤT cho tập "preprocess". File CỐ Ý nhẹ (không import component)
 * để cả `types.ts` (map routing) lẫn test đều import được mà không kéo theo cây
 * component nặng. Test `toolPanel.test.ts` chốt: tập 'preprocess' trong
 * WORKSPACE_TOOL_PANEL PHẢI khớp đúng danh sách này → không thể drift (gốc của
 * lỗi merge lòi panel & pageboxes panel trống trước đây).
 */
export const PREPROCESS_ROUTER_TOOLS = [
    'shuffle', 'resize', 'trim_shift', 'split', 'pages',
    'preflight', 'font_tools', 'hairlines', 'inkmanager', 'convertcolors', 'trapping', 'pdfx',
    'ocr', 'optimize', 'sticker', 'bgremover', 'document_cleanup', 'watermark', 'upscale', 'logo_rebuild',
    'encrypt', 'metadata', 'office_convert', 'crop',
] as const;

export type PreprocessRouterTool = (typeof PREPROCESS_ROUTER_TOOLS)[number];

export function isLogoRebuildEnabled(
    isDevelopment: boolean,
    releaseEnabled = false,
): boolean {
    return isDevelopment || releaseEnabled;
}

// LOGO-REBUILD (audit 2026-08-09 §LR3.10): production mặc định HOLD; pipeline
// phát hành phải bật đồng thời cờ Vite này và cờ backend tương ứng.
const LOGO_REBUILD_RELEASE_ENABLED = import.meta.env.VITE_LOGO_REBUILD_ENABLED === 'true';
export const LOGO_REBUILD_ENABLED = isLogoRebuildEnabled(
    import.meta.env.DEV,
    LOGO_REBUILD_RELEASE_ENABLED,
);

/** Các công cụ mở thành tab chuyên dụng và không dùng workspace PDF làm màn hình gốc. */
export const DEDICATED_STANDALONE_TOOLS = ['bgremover', 'document_cleanup', 'upscale', 'logo_rebuild', 'office_convert'] as const;

export type DedicatedStandaloneTool = (typeof DEDICATED_STANDALONE_TOOLS)[number];

export function resolveDedicatedInitialTool(initialFeature?: string): DedicatedStandaloneTool | null {
    if (initialFeature === 'logo_rebuild' && !LOGO_REBUILD_ENABLED) return null;
    return DEDICATED_STANDALONE_TOOLS.includes(initialFeature as DedicatedStandaloneTool)
        ? initialFeature as DedicatedStandaloneTool
        : null;
}

/** Công cụ có thể tự nhận ảnh/Office mà không cần một PDF đang mở trong workspace. */
export function canToolRunWithoutPdf(tool?: string | null): boolean {
    if (tool === 'logo_rebuild' && !LOGO_REBUILD_ENABLED) return false;
    return DEDICATED_STANDALONE_TOOLS.includes(tool as DedicatedStandaloneTool);
}
