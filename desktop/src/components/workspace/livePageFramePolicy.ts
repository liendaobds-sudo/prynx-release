
import type { CSSProperties } from 'react';
import type { ViewerColorStage } from '../../hooks/viewer/useTileRenderer';
import { isViewerFullPageWithinSurfaceBudget } from './renderZoomPolicy';

// NÉT (audit độ nét 2026-09-18): Dùng 'auto' để WebView2/Chromium sử dụng bộ lọc
// nội suy chất lượng cao (bicubic/bilinear area averaging). '-webkit-optimize-contrast'
// từng làm mất lọc mượt khi co/giãn bitmap, dẫn đến nét chữ bị răng cưa và đứt gãy ở zoom nhỏ.
export const VIEWER_RASTER_IMAGE_RENDERING = 'auto' as CSSProperties['imageRendering'];

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
    layoutSettled = true,
): boolean {
    // Zoom thường dùng full-page PPE; zoom cao giao cho viewport PPE để không raster
    // hai bitmap lớn cùng lúc. Trang rủi ro không có lớp PDFium nằm dưới.
    return shouldRenderBasePage
        && accurateColorPage
        && !needsTiling
        && fullPageWithinSurfaceBudget
        && layoutSettled;
}

export function shouldRenderViewerAccurateUnderlay(
    shouldRenderBasePage: boolean,
    accurateColorPage: boolean,
    needsTiling: boolean,
    underlayWithinSurfaceBudget: boolean,
    layoutSettled = true,
    initialFrameVisible = false,
    isActiveFrame = false,
): boolean {
    // UIUX (audit 2026-09-23 §ZOOM.BLUR.1): frame PPE mồi 24 DPI đã phủ toàn
    // trang. Khi active đang chuyển sang viewport, dựng thêm underlay PPE trung
    // gian (96–144 DPI) chỉ tạo một nấc mờ thứ hai trước tile nét; giữ frame mồi
    // tới khi viewport commit để swap một lần.
    if (initialFrameVisible && needsTiling && isActiveFrame) return false;
    return shouldRenderBasePage
        && accurateColorPage
        && needsTiling
        && underlayWithinSurfaceBudget
        && layoutSettled;
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
    targetRasterPending = false,
): { near: boolean; outer: boolean } {
    // PERF (audit 2026-09-23 §ZOOMSHARP.RUNWAY): ready của zoom cũ chỉ đủ để
    // giữ ảnh chờ, không đủ mở hàng loạt job atlas cho zoom mới. Dành lượt CPU
    // đầu cho viewport nét; sau đó mở lại toàn bộ runway, không cap worker/DPI.
    if (targetRasterPending) return { near: false, outer: false };
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
    _zoomSettling: boolean,
    _hasStableUnderlay: boolean,
): boolean {
    // UIUX (feedback 2026-08-14 §VIEW.SWAP / audit 2026-09-27 §PPE.ZOOM_SHARPNESS):
    // Giữ atlas/grid đã phủ kín hiển thị liên tục kể cả trong lúc zoom;
    // không ẩn làm lộ nền mờ khi người dùng đang cuộn chuột.
    return planIsCurrent
        && viewportCovered;
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

/**
 * PERF/UIUX (audit 2026-09-25 §PAN.PREFETCH): khi pan trong cùng DPI bucket,
 * target viewport mới có thể còn đang chờ nhưng các cell PPE kế cận vẫn dùng
 * chung raster identity. Không khóa atlas trong trường hợp này; chỉ khóa khi
 * zoom đổi bucket hoặc chưa có frame accurate đầu tiên. Nhờ vậy vùng sắp đi vào
 * khung được dựng nền song song, không làm chậm request tương tác priority 0.
 */
export function viewerPanGridTargetRasterPending(
    zoomSettling: boolean,
    planIsCurrent: boolean,
    viewportReady: boolean,
    queuedBufferGroup: string | null | undefined,
    targetBufferGroup: string | null | undefined,
    currentBufferGroup: string,
): boolean {
    if (zoomSettling || !planIsCurrent || !viewportReady) return true;
    return Boolean(
        (queuedBufferGroup && queuedBufferGroup !== currentBufferGroup)
        || (targetBufferGroup && targetBufferGroup !== currentBufferGroup),
    );
}

/**
 * UIUX (audit 2026-09-23 §ZOOM.FLASH.1): chỉ được rút tile viewport cũ khi
 * compositor thật sự còn một surface underlay đang mounted. `hasReadyUnderlay`
 * có thể là dấu vết của một lần render trước, nhưng base đã bị tháo khi trang
 * vượt ngân sách surface; dùng nó một mình sẽ để lộ skeleton trắng trong lúc
 * target zoom mới còn đang dựng.
 */
export function isViewerUnderlayStable(
    hasReadyUnderlay: boolean,
    underlayMounted: boolean,
    initialFrameVisible = false,
): boolean {
    return initialFrameVisible || (underlayMounted && hasReadyUnderlay);
}

/**
 * UIUX (audit 2026-09-23 §ZOOM.FLASH.2): giữ bitmap display cũ làm underlay trong
 * lúc chuyển sang viewport ở zoom cao. `renderBaseTile` có thể tắt vì budget, nhưng
 * component đang mounted vẫn giữ canvas đã decode; chỉ giữ fallback cho frame active
 * để không kéo theo surface lớn của các trang nền.
 */
export function shouldKeepViewerDisplayBaseMounted(
    useDisplayBase: boolean,
    renderBaseTile: boolean,
    isActiveFrame: boolean,
    hasDecodedBaseSurface: boolean,
): boolean {
    return useDisplayBase
        && (renderBaseTile || (isActiveFrame && hasDecodedBaseSurface));
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
    hasRendered = false,
): boolean {
    // Cổng prefetch do Viewer chỉ mở sau khi trang active đã hiển thị.
    // Khi trang đã từng render thành công (hasRendered), giữ nguyên surface đã dựng
    // để không bị mất preview / quay spinner khi cuộn qua lại giữa các trang.
    return viewerIsActive && (isActiveFrame || prefetchPage || hasRendered);
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
