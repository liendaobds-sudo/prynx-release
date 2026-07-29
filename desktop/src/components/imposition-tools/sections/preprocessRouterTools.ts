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
    'preflight', 'font_tools', 'hairlines', 'convertcolors', 'trapping', 'pdfx',
    'ocr', 'optimize', 'sticker', 'bgremover', 'watermark', 'upscale',
    'encrypt', 'metadata', 'office_convert', 'crop',
] as const;

export type PreprocessRouterTool = (typeof PREPROCESS_ROUTER_TOOLS)[number];

/** Các công cụ mở thành tab chuyên dụng và không dùng workspace PDF làm màn hình gốc. */
export const DEDICATED_STANDALONE_TOOLS = ['bgremover', 'upscale', 'office_convert'] as const;

export type DedicatedStandaloneTool = (typeof DEDICATED_STANDALONE_TOOLS)[number];

export function resolveDedicatedInitialTool(initialFeature?: string): DedicatedStandaloneTool | null {
    return DEDICATED_STANDALONE_TOOLS.includes(initialFeature as DedicatedStandaloneTool)
        ? initialFeature as DedicatedStandaloneTool
        : null;
}

/** Công cụ có thể tự nhận ảnh/Office mà không cần một PDF đang mở trong workspace. */
export function canToolRunWithoutPdf(tool?: string | null): boolean {
    return DEDICATED_STANDALONE_TOOLS.includes(tool as DedicatedStandaloneTool);
}