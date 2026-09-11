import type { CSSProperties } from 'react';
import type { ViewerColorStage } from '../../hooks/viewer/useTileRenderer';
import { isViewerFullPageWithinSurfaceBudget } from './renderZoomPolicy';

// UIUX (feedback 2026-08-14 §VIEW.SHARP): WebView2/Edge đã đo trên chính file Standee:
// tăng 24 → 72 → 96 DPI nhưng cùng co về khung Viewer gần như không làm chữ nhỏ rõ hơn.
// Chế độ WebKit này giữ tương phản cạnh khi compositor thu bitmap và không đổi pixel 1:1.
export const VIEWER_RASTER_IMAGE_RENDERING = '-webkit-optimize-contrast' as CSSProperties['imageRendering'];

// UIUX (feedback 2026-08-14 §VIEW.SWAP): underlay ưu tiên đúng mật độ màn hình để
// trang kế bên hiện ngay. Mức 24 DPI chỉ còn là fallback khi bitmap toàn trang
// vượt ngân sách surface; tile viewport vẫn giữ nguyên mật độ đích.
export const VIEWER_ACCURATE_UNDERLAY_SCALE = 0.25;

export function viewerAccurateBaseScaleForRole(
    preferredScale: number,
    screenScale: number,
    isActiveFrame: boolean,
    prefetchPage: boolean,
    hasReadyUnderlay = true,
): number {
    // UIUX (feedback 2026-08-14 §VIEW.PAGE): trang liền kề dựng trước theo mật độ
    // màn hình; khi thành active, LiveTile giữ frame này và nâng nét phía sau.
    if (!isActiveFrame && prefetchPage) return screenScale;
    if (isActiveFrame && !hasReadyUnderlay) return screenScale;
    return preferredScale;
}

export function viewerPageRenderPriority(
    viewerIsActive: boolean,
    isActiveFrame: boolean,
    prefetchPage: boolean,
): number {
    if (!viewerIsActive) return 1000;
    if (isActiveFrame) return 10;
    // PERF (audit 2026-09-11 §PPEBX.C): ngưỡng lane của cả native/HTTP là 100.
    // Priority 20 từng đưa trang tải trước vào mutex tương tác, giữ trang active
    // sau nó dù active có số nhỏ hơn. Dùng lane nền sẵn có, không giảm DPI/worker.
    return prefetchPage ? 100 : 200;
}

export function shouldCompositeViewerTile(
    displayedColorRank: number,
    displayedScale: number,
    nextColorStage: ViewerColorStage | undefined,
    nextScale: number,
): boolean {
    const nextColorRank = nextColorStage === 'accurate' ? 2 : 1;
    return nextColorRank > displayedColorRank
        || (nextColorRank === displayedColorRank && nextScale >= displayedScale);
}

export function isViewportTargetCurrent(
    targetGroup: string | null | undefined,
    currentGroup: string,
): boolean {
    return targetGroup === currentGroup;
}

export function shouldRenderViewerBaseTile(
    shouldRenderBasePage: boolean,
    _accurateColorPage: boolean,
    _needsTiling: boolean,
    _isActiveFrame: boolean,
    fullPageWithinSurfaceBudget = true,
): boolean {
    // COLOR (feedback 2026-08-09 §RENDER.F8): slot nền vẫn theo vòng đời trang;
    // policy pipeline bên dưới mới quyết định slot này có được phép dùng PDFium hay không.
    // Giữ các tham số tương thích với caller cũ; policy hiện tại không dùng chúng.
    void _isActiveFrame;
    return shouldRenderBasePage && fullPageWithinSurfaceBudget;
}

export function shouldRenderViewerAccurateBaseTile(
    shouldRenderBasePage: boolean,
    accurateColorPage: boolean,
    needsTiling: boolean,
    fullPageWithinSurfaceBudget = true,
): boolean {
    // Zoom thường dùng full-page PPE; zoom cao giao cho viewport PPE để không raster
    // hai bitmap lớn cùng lúc. Trang rủi ro không có lớp PDFium nằm dưới.
    return shouldRenderBasePage
        && accurateColorPage
        && !needsTiling
        && fullPageWithinSurfaceBudget;
}

export function shouldRenderViewerAccurateUnderlay(
    shouldRenderBasePage: boolean,
    accurateColorPage: boolean,
    needsTiling: boolean,
    underlayWithinSurfaceBudget: boolean,
): boolean {
    return shouldRenderBasePage
        && accurateColorPage
        && needsTiling
        && underlayWithinSurfaceBudget;
}

export function selectViewerAccurateBaseZoom(
    preferredScale: number,
    pageWidth: number,
    pageHeight: number,
    targetScale: number,
): number | null {
    if (isViewerFullPageWithinSurfaceBudget(
        pageWidth,
        pageHeight,
        preferredScale,
        targetScale,
    )) return preferredScale;
    if (isViewerFullPageWithinSurfaceBudget(
        pageWidth,
        pageHeight,
        VIEWER_ACCURATE_UNDERLAY_SCALE,
        targetScale,
    )) return VIEWER_ACCURATE_UNDERLAY_SCALE;
    return null;
}

export function shouldEnableViewerAccurateLayer(
    shouldRenderAccurateLayer: boolean,
    _displayLayerReady: boolean,
    _accurateCommitted = false,
): boolean {
    // COLOR (feedback 2026-08-09 §RENDER.F8): PPE phải bắt đầu ngay. Chờ callback
    // của display sẽ vừa phát khung sai màu, vừa đặt PPE sau PDFium trong hàng đợi.
    // Giữ tham số commit để tương thích các caller/fixture cũ.
    void _accurateCommitted;
    return shouldRenderAccurateLayer;
}

export function shouldEnableViewerViewportAccurateTile(
    accurateCommitted: boolean,
    waitForAccurateBase: boolean,
    visibleIsTarget: boolean,
): boolean {
    // PERF/COLOR (audit 2026-08-11 §PAN.TURBO-A): direct high-zoom không có
    // full-page PPE để mở cổng; viewport priority 0 phải tự làm frame accurate đầu tiên.
    return accurateCommitted || !waitForAccurateBase || visibleIsTarget;
}

// Hàm policy thuần được export để khóa hồi quy cold-open bằng unit test.
export function viewerPanGridRenderPolicy(
    accurateCommitted: boolean,
    hasVisibleViewportTile: boolean,
    phaseReady: boolean,
): { near: boolean; outer: boolean } {
    // PERF (audit 2026-08-14 §VIEW.LARGE.4): cold-open chưa có frame PPE không được
    // phát đồng thời pan-grid với target chính. Các cell nhỏ từng hiện trước ở 554 ms
    // và tạo thêm 8 job PPE trước first-frame; sau first-frame vẫn mở đầy đủ runway pan.
    const firstAccurateFrameReady = accurateCommitted || hasVisibleViewportTile || phaseReady;
    return {
        near: firstAccurateFrameReady,
        outer: firstAccurateFrameReady && phaseReady,
    };
}

export function shouldPresentViewerPanGrid(
    planIsCurrent: boolean,
    viewportCovered: boolean,
    zoomSettling: boolean,
    hasStableUnderlay: boolean,
): boolean {
    // UIUX (feedback 2026-08-14 §VIEW.SWAP): các cell vẫn decode ở nền nhưng chỉ
    // được đưa vào compositor cùng lúc khi hợp của chúng đã phủ kín viewport.
    return planIsCurrent
        && viewportCovered
        && !(zoomSettling && hasStableUnderlay);
}

export function shouldUseViewerDisplayLayer(
    accurateColorPage: boolean,
    accurateCommitted: boolean,
    keepDisplayUntilAccurate = false,
): boolean {
    // COLOR (feedback 2026-08-09 §RENDER.F8): trang rủi ro chỉ được phát pixel PPE,
    // kể cả cold-open; PDFium chỉ còn là compatibility lane của trang thông thường.
    if (!accurateColorPage) return true;
    // PREFLIGHT (audit 2026-08-10 §OP.8): trang detector xem là an toàn được giữ
    // bitmap hiện tại khi vừa mở Output Preview; chỉ rút nó sau khi Simulation mới
    // đã decode, tránh quay lại màn Loading/nháy trắng của lỗi §OP.6.
    return keepDisplayUntilAccurate && !accurateCommitted;
}

export function shouldUseViewerAccurateSimulation(
    detectorRequiresAccurate: boolean,
    outputPreviewActive: boolean,
): boolean {
    return detectorRequiresAccurate || outputPreviewActive;
}

export function shouldUseViewerDirectFullPageSurface(
    accurateColorPage: boolean,
    renderScale: number,
    targetScale: number,
    pageWidth: number,
    pageHeight: number,
    viewportWidth: number,
    viewportHeight: number,
): boolean {
    if (!accurateColorPage) return false;
    const values = [
        renderScale,
        targetScale,
        pageWidth,
        pageHeight,
        viewportWidth,
        viewportHeight,
    ];
    if (!values.every(value => Number.isFinite(value) && value > 0)) return false;
    // UIUX (feedback 2026-08-11 §VIEW.SURFACE): trang đang nằm trọn trong viewport chỉ
    // tốn xấp xỉ số pixel màn hình. Dựng thẳng một surface PPE đúng mật độ sẽ nhanh hơn
    // nền 144 DPI + nhiều tile và không tạo pha “mờ → nét” không cần thiết.
    const renderIsTargetDensity = renderScale + 0.001 >= targetScale * 0.95;
    const pageFitsViewport = pageWidth <= viewportWidth + 1
        && pageHeight <= viewportHeight + 1;
    // PERF (audit 2026-08-13 §VIEW.LARGE.1): trước đây chỉ kiểm tra footprint CSS.
    // Standee 800×1750 mm nằm vừa khung nhưng render nền 92 DPI thành khoảng
    // 2.900×6.340 px; decode/ghép ảnh sau IPC có thể làm WebView báo lỗi trang.
    // Tính footprint raster thực tế của surface hiện tại; nếu vượt ngân sách thì
    // chuyển sang viewport PPE, không giảm DPI của frame chính.
    const fullPageWithinSurfaceBudget = isViewerFullPageWithinSurfaceBudget(
        pageWidth,
        pageHeight,
        renderScale,
        targetScale,
    );
    return renderIsTargetDensity && pageFitsViewport && fullPageWithinSurfaceBudget;
}

export function viewerSurfaceSwapMs(
    accurateColorPage: boolean,
    requestedMs: number,
): number {
    // UIUX (feedback 2026-08-11 §VIEW.SURFACE): PPE mới chỉ xuất hiện sau khi đã
    // decode hoàn chỉnh; hòa trộn với surface cũ làm mắt thấy một pha mềm trung gian.
    return accurateColorPage ? 0 : Math.max(0, requestedMs);
}

export function shouldShowOutputPreviewBitmap(
    outputPreviewActive: boolean,
    activeViewerPage: number | null,
    framePage: number,
): boolean {
    return outputPreviewActive && activeViewerPage === framePage;
}

export function isViewerTargetScaleReady(displayedScale: number, targetScale: number): boolean {
    return Number.isFinite(displayedScale)
        && Number.isFinite(targetScale)
        && displayedScale + 0.001 >= targetScale;
}

export function shouldKeepViewerAccurateBaseMounted(
    accurateColorPage: boolean,
    renderAccurateBaseTile: boolean,
    accurateCommitted: boolean,
    fullPageWithinSurfaceBudget = true,
): boolean {
    // Giữ bitmap accurate full-page cũ làm fallback đúng màu khi chuyển qua viewport.
    return accurateColorPage
        && fullPageWithinSurfaceBudget
        && (renderAccurateBaseTile || accurateCommitted);
}

export function shouldRequestViewerAccurateBase(
    renderAccurateBaseTile: boolean,
    accurateCommitted: boolean,
    accurateBaseReady: boolean,
    fullPageWithinSurfaceBudget = true,
): boolean {
    // Nếu frame accurate đầu tiên đến từ viewport, warm một full-page PPE ở nền để
    // lần zoom-out sau luôn có fallback đúng màu.
    if (!fullPageWithinSurfaceBudget) return false;
    return renderAccurateBaseTile || (accurateCommitted && !accurateBaseReady);
}

export function shouldRenderViewerBasePage(
    viewerIsActive: boolean,
    isActiveFrame: boolean,
    prefetchPage: boolean,
): boolean {
    // Cổng prefetch do Viewer chỉ mở sau khi trang active đã hiển thị.
    return viewerIsActive && (isActiveFrame || prefetchPage);
}

export function viewerBackgroundRenderOwnerId(
    ownerId: string,
    pageInstanceId: string | undefined,
    accurateColorPage: boolean,
    _isActiveFrame: boolean,
): string {
    // Scope của nền PPE ổn định khi trang đổi prefetch → active; viewport dùng owner
    // tương tác gốc nên không restart/hủy ảnh nền chỉ vì đổi vai trò hiển thị.
    void _isActiveFrame;
    if (!accurateColorPage) return ownerId;
    return `${ownerId}:accurate-base:${pageInstanceId || 'unknown-page'}`;
}

export function shouldMountViewerViewportLayer(
    needsTiling: boolean,
    accurateColorPage: boolean,
    isActiveFrame: boolean,
    accurateCommitted = false,
    accurateBaseReady = true,
): boolean {
    // UIUX (feedback 2026-08-11 §VIEW.SURFACE): khi zoom-out, giữ surface viewport
    // nét cũ tới lúc full-page PPE mới đã decode. Rút lớp này sớm sẽ lộ nền thấp DPI.
    return needsTiling
        || (accurateColorPage && isActiveFrame && accurateCommitted && !accurateBaseReady);
}

export function viewerRenderGroupKey(
    pageNum: number,
    pageInstanceId: string | undefined,
    isViewport: boolean,
): string {
    // PERF (audit 2026-08-08 §RENDER.5): mỗi bản sao trang là một slot riêng;
    // cleanup của instance này không được hủy render instance khác cùng source page.
    const instanceId = pageInstanceId || `source-${pageNum}`;
    return `page:${pageNum}:instance:${instanceId}:${isViewport ? 'viewport' : 'page'}`;
}

export function viewerTileFileKey(
    source: string,
    accurateColor: boolean,
    documentToken?: string,
    previewRevision?: string,
    profileId = 'fogra39',
    intent = 'relative',
    proofIdentity = '',
): string {
    // PERF (audit 2026-08-08 §RENDER.5): cache hiển thị phải mang revision;
    // save-over cùng path không được lấy lại Blob của phiên tài liệu trước.
    const revision = documentToken || previewRevision || 'unknown-revision';
    const simulation = accurateColor
        ? `|profile:${(profileId || 'fogra39').trim().toLowerCase()}|intent:${(intent || 'relative').trim().toLowerCase()}|proof:${proofIdentity || 'default'}`
        : '';
    return `${source}|revision:${revision}|color:${accurateColor ? 'accurate' : 'display'}${simulation}`;
}
