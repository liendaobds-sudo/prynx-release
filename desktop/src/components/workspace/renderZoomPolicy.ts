// BUILD (audit 2026-08-03 §REL.05): công thức thuần dùng chung cho view và test,
// tách khỏi component để giữ Fast Refresh ổn định.
export const RENDER_BUDGET_PX = { high: 6000, fast: 3000 } as const;

// PERF (audit 2026-08-09 §ZOOM.7): core PPE đã hủy thật theo scanline. Giữ một khoảng
// trailing ngắn để gom chuỗi wheel trong cùng nhịp tay, nhưng không bắt người dùng chờ 90ms
// trước khi request nét cuối bắt đầu.
export const VIEWPORT_TILE_SETTLE_MS = 48;

// PERF (audit 2026-08-07 §ZOOM.2): nền display chống trắng trong khi tile viewport
// đảm nhiệm độ nét cuối. Hệ số theo DPR giữ chất lượng đồng đều trên màn HiDPI.
export const VIEWER_BACKGROUND_ZOOM_CAP = 2;
export const ACCURATE_VIEWER_BASE_ZOOM_MIN = 1;
// COLOR/PERF (feedback 2026-08-09 §RENDER.F9): nền PPE phải đủ nét để đọc ngay từ
// cold-open. Giữ 96–144 DPI cho full-page; cao hơn chuyển sang viewport PPE để
// không raster cả trang khổng lồ.
export const ACCURATE_VIEWER_BASE_ZOOM_CAP = 1.5;

export function computeAccurateViewerBaseZoom(
    renderZoom: number,
    _zoom: number,
    _dpr: number,
    minimumRenderZoom: number = ACCURATE_VIEWER_BASE_ZOOM_MIN,
): number {
    const safeRenderZoom = Number.isFinite(renderZoom) && renderZoom > 0
        ? renderZoom
        : ACCURATE_VIEWER_BASE_ZOOM_MIN;
    const safeMinimum = Number.isFinite(minimumRenderZoom) && minimumRenderZoom > 0
        ? Math.min(minimumRenderZoom, ACCURATE_VIEWER_BASE_ZOOM_CAP)
        : ACCURATE_VIEWER_BASE_ZOOM_MIN;
    // renderZoom chỉ đổi sau nhịp debounce, vì vậy bitmap PPE nét cũ vẫn được scale
    // tạm trong lúc lăn; khi dừng mới dựng target 96–144 DPI rồi thay thế.
    return Math.max(
        safeMinimum,
        Math.min(safeRenderZoom, ACCURATE_VIEWER_BASE_ZOOM_CAP),
    );
}

export function shouldPrefetchViewerPage(
    pageDistance: number,
    accurateColorPage: boolean,
    accuratePrefetchReady: boolean,
): boolean {
    if (!Number.isFinite(pageDistance) || pageDistance > 1) return false;
    return !accurateColorPage || accuratePrefetchReady;
}

export function shouldUseViewerViewportTiles(
    viewerIsActive: boolean,
    isActiveFrame: boolean,
    isImage: boolean,
    renderZoom: number,
    zoom: number,
    dpr: number,
    accurateColorPage: boolean,
): boolean {
    // PERF (feedback 2026-08-09 §RENDER.F5): fit/100% dùng accurate full-page gần
    // mật độ màn hình; viewport chỉ gánh zoom cao để tránh full-page raster lớn.
    const accurateNeedsViewport = accurateColorPage
        && zoom * dpr > ACCURATE_VIEWER_BASE_ZOOM_CAP;
    return viewerIsActive
        && isActiveFrame
        && !isImage
        && Number.isFinite(renderZoom)
        && Number.isFinite(zoom)
        && Number.isFinite(dpr)
        && (accurateNeedsViewport || renderZoom < zoom * dpr * 0.95);
}

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
    physicalDisplayScale: number = 1,
    devicePixelRatioOverride?: number,
): number {
    const dpr = Number.isFinite(devicePixelRatioOverride) && Number(devicePixelRatioOverride) > 0
        ? Number(devicePixelRatioOverride)
        : (window.devicePixelRatio || 1);
    const safePhysicalScale = Number.isFinite(physicalDisplayScale) && physicalDisplayScale > 0
        ? physicalDisplayScale
        : 1;
    // UIUX (audit 2026-08-11 §AS.2): sàn cũ = DPR luôn tương đương 96 DPI.
    // Trên màn 92 PPI nó buộc WebView2 co bitmap 96 → 92, làm mất ánh xạ pixel 1:1.
    // Sàn vật lý vẫn giữ nguyên mức oversample khi thu nhỏ, chỉ bỏ resampling sai ở 100%.
    const physicalRasterFloor = dpr * safePhysicalScale;
    const target = Math.max(physicalRasterFloor, z * dpr);
    const widthAt100 = actualWidth100 || 800;
    const ratio = pageDimW && pageDimW > 0
        ? Math.max(1, (pageDimH || 0) / pageDimW)
        : 1.414;
    const capByBudget = (budgetPx || RENDER_BUDGET_PX.high) / (widthAt100 * ratio);
    return Math.max(physicalRasterFloor, Math.min(24, target, capByBudget));
}
