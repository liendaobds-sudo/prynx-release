// BUILD (audit 2026-08-03 §REL.05): công thức thuần dùng chung cho view và test,
// tách khỏi component để giữ Fast Refresh ổn định.
export const RENDER_BUDGET_PX = { high: 6000, fast: 3000 } as const;

// PERF (audit 2026-08-07 §ZOOM.1): đủ ngắn để vùng nhìn nét lên gần như ngay
// sau khi dừng tay, nhưng vẫn gom chuỗi Ctrl+Wheel thay đổi mỗi khung hình.
export const VIEWPORT_TILE_SETTLE_MS = 90;

// PERF (audit 2026-08-07 §ZOOM.2): nền chỉ chống trắng trong khi tile viewport
// đảm nhiệm độ nét cuối. Hệ số theo DPR giữ chất lượng đồng đều trên màn HiDPI.
export const VIEWER_BACKGROUND_ZOOM_CAP = 2;

export function computeViewerBackgroundZoom(
    renderZoom: number,
    dpr: number,
    isActiveFrame: boolean,
    hasSharpViewportTile: boolean,
): number {
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    if (isActiveFrame && !hasSharpViewportTile) return renderZoom;
    return Math.min(renderZoom, VIEWER_BACKGROUND_ZOOM_CAP * safeDpr);
}

export function computeRenderZoomPure(
    z: number,
    actualWidth100: number,
    pageDimW?: number,
    pageDimH?: number,
    /**
     * PERF (audit độ nét 2026-07-28 §R.9): ngân sách cạnh dài bitmap nối với
     * `previewQuality`. Mặc định vẫn 6000; chỉ hạ khi người dùng chọn `fast`.
     */
    budgetPx: number = RENDER_BUDGET_PX.high,
): number {
    const dpr = window.devicePixelRatio || 1;
    const target = Math.max(dpr, z * dpr);
    const widthAt100 = actualWidth100 || 800;
    const ratio = pageDimW && pageDimW > 0
        ? Math.max(1, (pageDimH || 0) / pageDimW)
        : 1.414;
    const capByBudget = (budgetPx || RENDER_BUDGET_PX.high) / (widthAt100 * ratio);
    return Math.max(dpr, Math.min(24, target, capByBudget));
}
