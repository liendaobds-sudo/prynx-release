export interface OutputPreviewPanelOffset {
    x: number;
    y: number;
}

/** Khoảng hở của panel so với mép vùng làm việc, tính bằng CSS pixel. */
export const OUTPUT_PREVIEW_WORKSPACE_GAP_PX = 10;

/**
 * UIUX (fix panel xem trước 2026-07-28): không cho kéo đầu panel ra phía trên
 * vùng làm việc, nếu không thanh ứng dụng sẽ che tay nắm kéo và nút đóng.
 */
export function clampOutputPreviewPanelOffset(
    offset: OutputPreviewPanelOffset,
): OutputPreviewPanelOffset {
    return {
        x: offset.x,
        y: Math.max(0, offset.y),
    };
}
