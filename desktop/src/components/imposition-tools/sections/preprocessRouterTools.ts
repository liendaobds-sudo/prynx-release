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
    'preflight', 'hairlines', 'convertcolors', 'trapping', 'pdfx',
    'ocr', 'optimize', 'sticker', 'bgremover', 'watermark', 'upscale',
    'encrypt', 'metadata', 'office_convert',
] as const;

export type PreprocessRouterTool = (typeof PREPROCESS_ROUTER_TOOLS)[number];
