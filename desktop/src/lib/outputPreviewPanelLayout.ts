export interface OutputPreviewPanelOffset {
    x: number;
    y: number;
}

export interface OutputPreviewPanelBounds {
    workspaceWidth: number;
    workspaceHeight: number;
    panelWidth: number;
    panelHeight: number;
    baseRight?: number;
}

/** Khoảng hở của panel so với mép vùng làm việc, tính bằng CSS pixel. */
export const OUTPUT_PREVIEW_WORKSPACE_GAP_PX = 10;

/**
 * Không cho panel rời khỏi bốn cạnh vùng làm việc. Offset được tính từ vị trí
 * CSS gốc `top=gap, right=baseRight` của panel.
 */
export function clampOutputPreviewPanelOffset(
    offset: OutputPreviewPanelOffset,
    bounds?: OutputPreviewPanelBounds,
): OutputPreviewPanelOffset {
    if (!bounds) {
        return { x: offset.x, y: Math.max(0, offset.y) };
    }

    const baseRight = bounds.baseRight ?? 60;
    const baseLeft = bounds.workspaceWidth - baseRight - bounds.panelWidth;
    const minX = Math.min(baseRight - OUTPUT_PREVIEW_WORKSPACE_GAP_PX,
        OUTPUT_PREVIEW_WORKSPACE_GAP_PX - baseLeft);
    const maxX = baseRight - OUTPUT_PREVIEW_WORKSPACE_GAP_PX;
    const maxY = Math.max(
        0,
        bounds.workspaceHeight - bounds.panelHeight - OUTPUT_PREVIEW_WORKSPACE_GAP_PX * 2,
    );
    return {
        x: Math.min(maxX, Math.max(minX, offset.x)),
        y: Math.min(maxY, Math.max(0, offset.y)),
    };
}
