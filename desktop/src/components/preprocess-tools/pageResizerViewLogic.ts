import type { ResizeOptions, ScaleMode } from '../../lib/preprocessEngine/PageResizer';

export type PageSizeMode = 'fixed' | 'fixed_width' | 'fixed_height';

/** Kiểu tỷ lệ engine chấp nhận theo cách đặt khổ.
 *
 * RESIZE (audit 2026-08-06 §G.11): khổ khóa một chiều dùng được CẢ 'center_no_scale'
 * — tem 5×10 đưa về chiều cao 15 ra trang 7.5×15 với tem giữ nguyên 5×10 ở giữa.
 * 'fill'/'stretch' vẫn bị loại vì khổ đích sinh ra đã đúng tỷ lệ nội dung nên
 * không còn phần dư để lấp hay bóp (`resize_background_engine` ném ValueError). */
export function allowedScaleModes(pageSizeMode: PageSizeMode = 'fixed'): ScaleMode[] {
    return pageSizeMode === 'fixed'
        ? ['fit', 'fill', 'stretch', 'center_no_scale']
        : ['fit', 'center_no_scale'];
}

export interface PageResizerSettings extends ResizeOptions {
    sizePresetId: string;
    applyToStr: string;
    pageSizeMode?: PageSizeMode;
    // Giảm dữ liệu theo khổ mới (giống PDF Optimizer). undefined = tự động
    // (downsample 300 DPI khi thu nhỏ khổ), 0 = tắt (giữ nguyên chất lượng),
    // >0 = DPI cụ thể. resizeMode: 'auto' | 'vector' | 'raster'.
    targetDpi?: number;
    resizeMode?: string;
    // Khử viền trắng trước khi resize (auto-trim → resize)
    autoTrimBefore?: boolean;
    autoTrimMarginMm?: number;
    // Chỉ bỏ canvas alpha ngoài nội dung khi người dùng chủ động bật.
    resizeByContent?: boolean;
}

export function shouldShowBackgroundFill(
    _autoTrimBefore: boolean | undefined,
    scaleMode: ScaleMode,
    pageSizeMode: PageSizeMode = 'fixed',
): boolean {
    // Nền chỉ có ý nghĩa khi phép co giãn thật sự tạo vùng trống.
    // RESIZE (audit 2026-08-06 §G.11): khóa một chiều + 'fit' thì khổ đích vừa khít
    // nội dung nên KHÔNG có vùng trống; nhưng + 'center_no_scale' thì có (tem 5×10
    // trong trang 7.5×15) → phải cho chọn nền.
    if (pageSizeMode !== 'fixed') return scaleMode === 'center_no_scale';
    return scaleMode === 'fit' || scaleMode === 'center_no_scale';
}

export function applyPageSizeMode(
    settings: PageResizerSettings,
    mode: PageSizeMode,
): PageResizerSettings {
    // RESIZE (audit 2026-08-06 §G.11): chỉ hạ về 'fit' khi kiểu đang chọn KHÔNG
    // còn hợp lệ ở chế độ mới; 'center_no_scale' được giữ nguyên qua chuyển chế độ.
    return {
        ...settings,
        pageSizeMode: mode,
        sizePresetId: mode === 'fixed' ? settings.sizePresetId : 'custom',
        scaleMode: allowedScaleModes(mode).includes(settings.scaleMode)
            ? settings.scaleMode
            : 'fit',
    };
}
