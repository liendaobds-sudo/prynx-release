// PERF (audit 2026-08-08 §RENDER.6/7): chính sách viewport tile thuần, dùng chung
// cho component và test để khóa phép xoay/snap trước khi bật tile sắc cho trang xoay.

export interface ViewportRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ViewportTileSpec {
    clipX: number;
    clipY: number;
    clipW: number;
    clipH: number;
    cssLeft: number;
    cssTop: number;
    cssW: number;
    cssH: number;
    key: string;
}

export interface ViewportTileBufferItem {
    key: string;
    bufferGroup: string;
    /** Cùng tài liệu/trang/pipeline/xoay thì tile cũ vẫn là ảnh hợp lệ khi zoom đổi. */
    reuseGroup?: string;
}

export interface ViewportTileCoverageItem {
    cssLeft: number;
    cssTop: number;
    cssW: number;
    cssH: number;
    sourceDisplayWidth: number;
    sourceDisplayHeight: number;
}

export interface ViewportTileBufferState<T extends ViewportTileBufferItem> {
    visible: T | null;
    target: T | null;
}

export type ViewportTileBufferAction<T extends ViewportTileBufferItem> =
    | { type: 'target'; item: T | null }
    | { type: 'ready'; key: string }
    | { type: 'reset' };

export const VIEWPORT_TILE_CROSSFADE_MIN_MS = 80;
export const VIEWPORT_TILE_CROSSFADE_MAX_MS = 160;
// PERF (feedback 2026-08-09 §RENDER.F5): lớp PDFium first-paint đã giữ khung nhìn
// liền mạch, nên PPE chỉ raster đúng viewport. Runway 64 px thử nghiệm làm tăng khoảng
// 18% pixel và khiến đường làm nét chậm hơn mà không còn mang lại lợi ích tương ứng.
export const VIEWPORT_TILE_RUNWAY_PAD = 0;
export const VIEWPORT_TILE_COVERAGE_TOLERANCE_PX = 1;
const VIEWPORT_TILE_PRESENTATION_BLEED_DEVICE_PX = 1;

export type ViewportTilePanPrefetchTier = 'low' | 'mid' | 'full';

export interface DevicePixelSnapOffset {
    x: number;
    y: number;
}

/**
 * UIUX (feedback 2026-08-11 §VIEW.SHARP): bitmap 1:1 vẫn bị WebView2 lọc mềm
 * nếu gốc trang nằm giữa hai device pixel. Trừ offset đang áp để lấy tọa độ layout
 * thật, rồi trả về dịch chuyển ổn định đưa gốc trang lên lưới pixel vật lý.
 */
export function computeDevicePixelSnapOffset(
    transformedLeft: number,
    transformedTop: number,
    devicePixelRatio: number,
    currentX: number,
    currentY: number,
): DevicePixelSnapOffset {
    const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
        ? devicePixelRatio
        : 1;
    const baseLeft = transformedLeft - currentX;
    const baseTop = transformedTop - currentY;
    const normalize = (value: number) => (Math.abs(value) < 1e-9 ? 0 : value);
    return {
        x: normalize(Math.round(baseLeft * safeDpr) / safeDpr - baseLeft),
        y: normalize(Math.round(baseTop * safeDpr) / safeDpr - baseTop),
    };
}

export interface ViewportTilePresentationRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * UIUX (feedback 2026-08-11 §PAN.SEAM): WebView2 có thể làm tròn hai bitmap kề
 * nhau về hai quad compositor khác nhau và lộ nền ở ranh giới dưới một pixel.
 * Chỉ nới cạnh phải/dưới ở lúc trình bày đúng một device pixel; clip raster và
 * key cache giữ nguyên, còn mép ngoài trang luôn bị chặn tại kích thước trang.
 */
export function computeViewportTileSeamSafePresentationRect(
    tile: Pick<ViewportTileSpec, 'cssLeft' | 'cssTop' | 'cssW' | 'cssH'>,
    scaleX: number,
    scaleY: number,
    pageWidth: number,
    pageHeight: number,
    devicePixelRatio: number,
): ViewportTilePresentationRect {
    const left = tile.cssLeft * scaleX;
    const top = tile.cssTop * scaleY;
    const rawRight = (tile.cssLeft + tile.cssW) * scaleX;
    const rawBottom = (tile.cssTop + tile.cssH) * scaleY;
    const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
        ? devicePixelRatio
        : 1;
    const bleed = VIEWPORT_TILE_PRESENTATION_BLEED_DEVICE_PX / safeDpr;
    const epsilon = 1e-6;
    const right = Math.min(
        pageWidth,
        rawRight + (rawRight < pageWidth - epsilon ? bleed : 0),
    );
    const bottom = Math.min(
        pageHeight,
        rawBottom + (rawBottom < pageHeight - epsilon ? bleed : 0),
    );
    return {
        left,
        top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
    };
}

/**
 * PERF (audit 2026-08-11 §PAN.TURBO-B): benchmark PDF khách @600 DPI cho thấy
 * pool 7 lane dùng 512 px đạt first-ready/full-cover 264/749 ms, còn lane đơn
 * dùng 768 px phủ xong trong 1.806 ms thay vì 2.853 ms với 512 px.
 */
export function viewportTilePanCellSize(
    tier: ViewportTilePanPrefetchTier | undefined,
): number {
    return tier === 'low' || tier === 'mid' ? 768 : 512;
}

interface ComputeViewportTilePanGridInput {
    rotatedViewport: ViewportRect;
    pageWidth: number;
    pageHeight: number;
    rotation: number;
    dpr: number;
    cellSize: number;
    maxTile: number;
    tier: ViewportTilePanPrefetchTier | undefined,
}

/**
 * PERF/UIUX (feedback 2026-08-11 §PAN.F3): atlas dùng cell neo theo tọa độ trang,
 * không neo theo viewport. Vì vậy pan chỉ bổ sung cell ở rìa; cell đã decode giữ
 * nguyên identity/cache và các cell kế cận có thể raster song song ở lane nền.
 */
export function computeViewportTilePanGridSpecs({
    rotatedViewport,
    pageWidth,
    pageHeight,
    rotation,
    dpr,
    cellSize,
    maxTile,
    tier,
}: ComputeViewportTilePanGridInput): ViewportTileSpec[] {
    const values = [
        rotatedViewport.left,
        rotatedViewport.top,
        rotatedViewport.right,
        rotatedViewport.bottom,
        pageWidth,
        pageHeight,
        rotation,
        dpr,
        cellSize,
        maxTile,
    ];
    if (!values.every(Number.isFinite)
        || pageWidth <= 0
        || pageHeight <= 0
        || dpr <= 0
        || cellSize <= 0
        || maxTile <= 0) return [];

    const visible = mapRotatedViewportToPage(
        rotatedViewport,
        pageWidth,
        pageHeight,
        rotation,
    );
    if (visible.right <= visible.left || visible.bottom <= visible.top) return [];

    const pageDevW = Math.max(1, Math.round(pageWidth * dpr));
    const pageDevH = Math.max(1, Math.round(pageHeight * dpr));
    const cell = Math.max(1, Math.round(Math.min(cellSize, maxTile)));
    const left = visible.left * dpr;
    const top = visible.top * dpr;
    const right = visible.right * dpr;
    const bottom = visible.bottom * dpr;
    const width = right - left;
    const height = bottom - top;
    // Máy mạnh dựng trước một viewport mỗi phía. Tier RAM thấp chỉ giảm vòng
    // dự phòng; kích thước cell, DPI và pixel của viewport hiện tại không đổi.
    const runwayRatio = tier === 'low' ? 0.25 : tier === 'mid' ? 0.5 : 1;
    const startX = Math.floor(Math.max(0, left - width * runwayRatio) / cell) * cell;
    const startY = Math.floor(Math.max(0, top - height * runwayRatio) / cell) * cell;
    const endX = Math.min(
        pageDevW,
        Math.ceil(Math.min(pageDevW, right + width * runwayRatio) / cell) * cell,
    );
    const endY = Math.min(
        pageDevH,
        Math.ceil(Math.min(pageDevH, bottom + height * runwayRatio) / cell) * cell,
    );
    const viewCx = (left + right) / 2;
    const viewCy = (top + bottom) / 2;
    const specs: ViewportTileSpec[] = [];

    for (let clipY = startY; clipY < endY; clipY += cell) {
        const clipH = Math.min(cell, pageDevH - clipY, endY - clipY);
        if (clipH <= 0) continue;
        for (let clipX = startX; clipX < endX; clipX += cell) {
            const clipW = Math.min(cell, pageDevW - clipX, endX - clipX);
            if (clipW <= 0) continue;
            specs.push({
                clipX,
                clipY,
                clipW,
                clipH,
                cssLeft: clipX / dpr,
                cssTop: clipY / dpr,
                cssW: clipW / dpr,
                cssH: clipH / dpr,
                key: `grid:${clipX}:${clipY}:${clipW}:${clipH}`,
            });
        }
    }

    // React mount theo thứ tự này; lane nền vì thế nhận cell gần viewport trước.
    specs.sort((leftSpec, rightSpec) => {
        const leftCx = leftSpec.clipX + leftSpec.clipW / 2;
        const leftCy = leftSpec.clipY + leftSpec.clipH / 2;
        const rightCx = rightSpec.clipX + rightSpec.clipW / 2;
        const rightCy = rightSpec.clipY + rightSpec.clipH / 2;
        return ((leftCx - viewCx) ** 2 + (leftCy - viewCy) ** 2)
            - ((rightCx - viewCx) ** 2 + (rightCy - viewCy) ** 2);
    });
    return specs;
}

export interface ViewportTilePanGridPhases<T extends ViewportTileSpec = ViewportTileSpec> {
    near: T[];
    outer: T[];
}

function viewportRectsIntersect(
    tile: Pick<ViewportTileSpec, 'cssLeft' | 'cssTop' | 'cssW' | 'cssH'>,
    viewport: ViewportRect,
    tolerancePx = 0,
): boolean {
    const tolerance = Math.max(0, tolerancePx);
    return tile.cssLeft < viewport.right - tolerance
        && tile.cssLeft + tile.cssW > viewport.left + tolerance
        && tile.cssTop < viewport.bottom - tolerance
        && tile.cssTop + tile.cssH > viewport.top + tolerance;
}

/**
 * PERF (audit 2026-08-11 §PAN.TURBO-A): cell đang giao viewport đi pha gần;
 * runway chỉ được mở sau frame tương tác để không tranh lượt raster đầu tiên.
 */
export function splitViewportTilePanGridPhases<T extends ViewportTileSpec>(
    specs: readonly T[],
    viewport: ViewportRect,
): ViewportTilePanGridPhases<T> {
    const near: T[] = [];
    const outer: T[] = [];
    for (const spec of specs) {
        (viewportRectsIntersect(spec, viewport) ? near : outer).push(spec);
    }
    return { near, outer };
}

/** Target đổi phải đóng runway cũ, kể cả vẫn nằm trong cùng tập cell gần. */
export function viewportTilePanPhaseKey(
    bufferGroup: string,
    targetKey: string,
    nearSpecs: readonly Pick<ViewportTileSpec, 'key'>[],
): string {
    if (nearSpecs.length === 0) return '';
    return `${bufferGroup}:target:${targetKey}:near:${nearSpecs.map(spec => spec.key).join('|')}`;
}

/**
 * Chỉ công nhận atlas đã phủ khi hợp các cell ready che kín viewport. Kiểm theo
 * từng lát X để một cell thiếu hoặc một khe giữa grid không thể tạo false-positive.
 */
export function viewportTileGridCoversViewport<T extends ViewportTileSpec>(
    specs: readonly T[],
    readyKeys: ReadonlySet<string>,
    viewport: ViewportRect,
    tolerancePx = VIEWPORT_TILE_COVERAGE_TOLERANCE_PX,
): boolean {
    const values = [
        viewport.left,
        viewport.top,
        viewport.right,
        viewport.bottom,
        tolerancePx,
    ];
    if (!values.every(Number.isFinite)
        || viewport.right <= viewport.left
        || viewport.bottom <= viewport.top) {
        return false;
    }
    const tolerance = Math.max(0, tolerancePx);
    const readyRects = specs
        .filter(spec => readyKeys.has(spec.key) && viewportRectsIntersect(spec, viewport))
        .map(spec => ({
            left: Math.max(viewport.left, spec.cssLeft),
            top: Math.max(viewport.top, spec.cssTop),
            right: Math.min(viewport.right, spec.cssLeft + spec.cssW),
            bottom: Math.min(viewport.bottom, spec.cssTop + spec.cssH),
        }))
        .filter(rect => rect.right > rect.left && rect.bottom > rect.top);
    if (readyRects.length === 0) return false;

    const xBreaks = [
        viewport.left,
        viewport.right,
        ...readyRects.flatMap(rect => [rect.left, rect.right]),
    ].sort((left, right) => left - right);
    const uniqueX = xBreaks.filter((value, index) => (
        index === 0 || value - xBreaks[index - 1] > tolerance
    ));

    for (let index = 0; index < uniqueX.length - 1; index += 1) {
        const left = uniqueX[index];
        const right = uniqueX[index + 1];
        if (right - left <= tolerance) continue;
        const midpoint = (left + right) / 2;
        const intervals = readyRects
            .filter(rect => rect.left <= midpoint + tolerance && rect.right >= midpoint - tolerance)
            .map(rect => [rect.top, rect.bottom] as const)
            .sort((first, second) => first[0] - second[0]);
        let coveredBottom = viewport.top;
        for (const [top, bottom] of intervals) {
            if (top > coveredBottom + tolerance) return false;
            coveredBottom = Math.max(coveredBottom, bottom);
            if (coveredBottom >= viewport.bottom - tolerance) break;
        }
        if (coveredBottom < viewport.bottom - tolerance) return false;
    }
    return uniqueX[0] <= viewport.left + tolerance
        && uniqueX[uniqueX.length - 1] >= viewport.right - tolerance;
}

/**
 * UIUX (audit 2026-08-09 §ZOOM.8): chênh lệch mật độ càng lớn thì mắt càng cần
 * một khoảng hòa trộn dài hơn. Không vượt 160ms để hiệu ứng không biến thành độ trễ mới.
 */
export function computeViewportTileCrossfadeMs(
    previousScale: number | null | undefined,
    nextScale: number,
    prefersReducedMotion: boolean,
): number {
    if (prefersReducedMotion) return 0;
    if (!Number.isFinite(previousScale) || !previousScale || previousScale <= 0) {
        return VIEWPORT_TILE_CROSSFADE_MAX_MS;
    }
    if (!Number.isFinite(nextScale) || nextScale <= 0) {
        return VIEWPORT_TILE_CROSSFADE_MIN_MS;
    }
    const ratio = Math.max(previousScale, nextScale) / Math.min(previousScale, nextScale);
    const distance = clamp(Math.log2(ratio), 0, 1);
    return Math.round(
        VIEWPORT_TILE_CROSSFADE_MIN_MS
        + distance * (VIEWPORT_TILE_CROSSFADE_MAX_MS - VIEWPORT_TILE_CROSSFADE_MIN_MS),
    );
}

export interface ViewportTileRetirementScheduler {
    schedule(key: string, delayMs: number, retire: (key: string) => void): void;
    cancelExcept(key: string | null): void;
    cancelAll(): void;
}

/** Giữ callback `onLoad` lặp không tạo nhiều timer và không retire target đã lỗi thời. */
export function createViewportTileRetirementScheduler(): ViewportTileRetirementScheduler {
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const cancel = (key: string) => {
        const timer = pending.get(key);
        if (timer === undefined) return;
        clearTimeout(timer);
        pending.delete(key);
    };
    return {
        schedule(key, delayMs, retire) {
            if (pending.has(key)) return;
            if (delayMs <= 0) {
                retire(key);
                return;
            }
            const timer = setTimeout(() => {
                pending.delete(key);
                retire(key);
            }, delayMs);
            pending.set(key, timer);
        },
        cancelExcept(key) {
            for (const pendingKey of [...pending.keys()]) {
                if (pendingKey !== key) cancel(pendingKey);
            }
        },
        cancelAll() {
            for (const pendingKey of [...pending.keys()]) cancel(pendingKey);
        },
    };
}

export function viewportTileBufferGroup(
    reuseGroup: string,
    renderScale: number,
    displayWidth: number,
    displayHeight: number,
    rasterDpr: number,
): string {
    // CSS size thay đổi theo zoom còn rasterDpr accurate đổi nghịch đảo; tích của
    // chúng là kích thước raster thật và phải ổn định trong cùng DPI bucket.
    return `${reuseGroup}:${renderScale}:${Math.round(displayWidth * rasterDpr)}:${Math.round(displayHeight * rasterDpr)}`;
}

interface ComputeViewportTileSpecInput {
    /** Khung nhìn theo bounding box màn hình của trang đã xoay, đơn vị CSS px. */
    rotatedViewport: ViewportRect;
    /** Khổ trang chưa xoay, đơn vị CSS px. */
    pageWidth: number;
    pageHeight: number;
    rotation: number;
    dpr: number;
    pad: number;
    snap: number;
    maxTile: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function normalizeQuarterTurn(rotation: number): 0 | 90 | 180 | 270 {
    const normalized = ((Math.round(rotation) % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

export function mapRotatedViewportToPage(
    viewport: ViewportRect,
    pageWidth: number,
    pageHeight: number,
    rotation: number,
): ViewportRect {
    const turn = normalizeQuarterTurn(rotation);
    const outerWidth = turn === 90 || turn === 270 ? pageHeight : pageWidth;
    const outerHeight = turn === 90 || turn === 270 ? pageWidth : pageHeight;
    const left = clamp(viewport.left, 0, outerWidth);
    const right = clamp(viewport.right, 0, outerWidth);
    const top = clamp(viewport.top, 0, outerHeight);
    const bottom = clamp(viewport.bottom, 0, outerHeight);

    switch (turn) {
        case 90:
            // CSS rotate(90deg): screen(u, v) = (H - y, x).
            return { left: top, top: pageHeight - right, right: bottom, bottom: pageHeight - left };
        case 180:
            return {
                left: pageWidth - right,
                top: pageHeight - bottom,
                right: pageWidth - left,
                bottom: pageHeight - top,
            };
        case 270:
            // CSS rotate(270deg): screen(u, v) = (y, W - x).
            return { left: pageWidth - bottom, top: left, right: pageWidth - top, bottom: right };
        default:
            return { left, top, right, bottom };
    }
}

export function computeViewportTileSpec({
    rotatedViewport,
    pageWidth,
    pageHeight,
    rotation,
    dpr,
    pad,
    snap,
    maxTile,
}: ComputeViewportTileSpecInput): ViewportTileSpec | null {
    if (![pageWidth, pageHeight, dpr, snap, maxTile].every(Number.isFinite)
        || pageWidth <= 0 || pageHeight <= 0 || dpr <= 0 || snap <= 0 || maxTile <= 0) {
        return null;
    }
    const visible = mapRotatedViewportToPage(rotatedViewport, pageWidth, pageHeight, rotation);
    if (visible.right <= visible.left || visible.bottom <= visible.top) return null;

    // PERF (audit 2026-08-08 §RENDER.3): PPE dùng DPI bucket nên dpr raster có
    // thể là 4/3, 8/3... Rust làm tròn kích thước full-page; policy phải làm
    // giống hệt để clip luôn là số nguyên và mép phải/dưới không vượt một pixel.
    const pageDevW = Math.max(1, Math.round(pageWidth * dpr));
    const pageDevH = Math.max(1, Math.round(pageHeight * dpr));
    const safePad = Number.isFinite(pad) ? Math.max(0, pad) : 0;
    const snapDown = (value: number) => Math.floor(value / snap) * snap;
    const snapUp = (value: number) => Math.ceil(value / snap) * snap;

    let clipX = snapDown(Math.max(0, visible.left * dpr - safePad));
    let clipY = snapDown(Math.max(0, visible.top * dpr - safePad));
    const rawRight = Math.min(pageDevW, snapUp(Math.min(pageDevW, visible.right * dpr + safePad)));
    const rawBottom = Math.min(pageDevH, snapUp(Math.min(pageDevH, visible.bottom * dpr + safePad)));
    let clipW = Math.min(maxTile, rawRight - clipX);
    let clipH = Math.min(maxTile, rawBottom - clipY);
    if (clipW <= 0 || clipH <= 0) return null;

    const viewCxDev = (visible.left + visible.right) * dpr / 2;
    const viewCyDev = (visible.top + visible.bottom) * dpr / 2;
    if (clipW === maxTile) {
        clipX = snapDown(clamp(viewCxDev - maxTile / 2, 0, pageDevW - maxTile));
    }
    if (clipH === maxTile) {
        clipY = snapDown(clamp(viewCyDev - maxTile / 2, 0, pageDevH - maxTile));
    }
    // Snap có thể đặt origin lùi lại; kẹp chiều dài lần cuối để không vượt mép trang.
    clipW = Math.min(clipW, pageDevW - clipX);
    clipH = Math.min(clipH, pageDevH - clipY);
    if (clipW <= 0 || clipH <= 0) return null;

    return {
        clipX,
        clipY,
        clipW,
        clipH,
        cssLeft: clipX / dpr,
        cssTop: clipY / dpr,
        cssW: clipW / dpr,
        cssH: clipH / dpr,
        key: `${clipX}:${clipY}:${clipW}:${clipH}`,
    };
}

export function sameViewportTileSpec(
    left: ViewportTileSpec | null,
    right: ViewportTileSpec | null,
): boolean {
    return left === right || left?.key === right?.key;
}

/**
 * UIUX (feedback 2026-08-09 §ZOOM.F3): đo riêng việc tile cũ sau khi scale còn phủ
 * đủ bốn cạnh khung nhìn mới hay không. Compositor chỉ được rút “đảo nét” này khi đã
 * có underlay toàn trang; nếu chưa có thì vẫn phải giữ nó để không rơi xuống nền trắng.
 */
export function viewportTileCoversViewport(
    tile: ViewportTileCoverageItem,
    viewport: ViewportRect,
    viewportSourceDisplayWidth: number,
    viewportSourceDisplayHeight: number,
    currentDisplayWidth: number,
    currentDisplayHeight: number,
    tolerancePx = VIEWPORT_TILE_COVERAGE_TOLERANCE_PX,
): boolean {
    const values = [
        tile.cssLeft,
        tile.cssTop,
        tile.cssW,
        tile.cssH,
        tile.sourceDisplayWidth,
        tile.sourceDisplayHeight,
        viewport.left,
        viewport.top,
        viewport.right,
        viewport.bottom,
        viewportSourceDisplayWidth,
        viewportSourceDisplayHeight,
        currentDisplayWidth,
        currentDisplayHeight,
        tolerancePx,
    ];
    if (!values.every(Number.isFinite)
        || tile.cssW <= 0
        || tile.cssH <= 0
        || tile.sourceDisplayWidth <= 0
        || tile.sourceDisplayHeight <= 0
        || viewport.right <= viewport.left
        || viewport.bottom <= viewport.top
        || viewportSourceDisplayWidth <= 0
        || viewportSourceDisplayHeight <= 0
        || currentDisplayWidth <= 0
        || currentDisplayHeight <= 0) {
        return false;
    }

    const tileScaleX = currentDisplayWidth / tile.sourceDisplayWidth;
    const tileScaleY = currentDisplayHeight / tile.sourceDisplayHeight;
    const viewportScaleX = currentDisplayWidth / viewportSourceDisplayWidth;
    const viewportScaleY = currentDisplayHeight / viewportSourceDisplayHeight;
    const tileLeft = tile.cssLeft * tileScaleX;
    const tileTop = tile.cssTop * tileScaleY;
    const tileRight = (tile.cssLeft + tile.cssW) * tileScaleX;
    const tileBottom = (tile.cssTop + tile.cssH) * tileScaleY;
    const viewportLeft = viewport.left * viewportScaleX;
    const viewportTop = viewport.top * viewportScaleY;
    const viewportRight = viewport.right * viewportScaleX;
    const viewportBottom = viewport.bottom * viewportScaleY;
    const safeTolerance = Math.max(0, tolerancePx);

    return tileLeft <= viewportLeft + safeTolerance
        && tileTop <= viewportTop + safeTolerance
        && tileRight >= viewportRight - safeTolerance
        && tileBottom >= viewportBottom - safeTolerance;
}

export function createRafCoalescer(
    requestFrame: (callback: FrameRequestCallback) => number,
    cancelFrame: (handle: number) => void,
    callback: FrameRequestCallback,
) {
    let frameHandle: number | null = null;
    return {
        schedule() {
            if (frameHandle !== null) return;
            frameHandle = requestFrame(time => {
                frameHandle = null;
                callback(time);
            });
        },
        cancel() {
            if (frameHandle === null) return;
            cancelFrame(frameHandle);
            frameHandle = null;
        },
    };
}

export function reduceViewportTileBuffer<T extends ViewportTileBufferItem>(
    state: ViewportTileBufferState<T>,
    action: ViewportTileBufferAction<T>,
): ViewportTileBufferState<T> {
    if (action.type === 'reset') {
        return state.visible === null && state.target === null
            ? state
            : { visible: null, target: null };
    }
    if (action.type === 'ready') {
        if (!state.target || state.target.key !== action.key) return state;
        if (state.visible?.key === state.target.key) return state;
        return { visible: state.target, target: state.target };
    }
    const nextTarget = action.item;
    if (state.target?.key === nextTarget?.key) return state;
    if (!nextTarget) return { visible: state.visible, target: null };
    // Zoom/khổ/xoay/file khác không dùng lại tile cũ; double-buffer chỉ dành cho pan
    // trong cùng hệ hình học để tránh stretch/lệch khung.
    const canReuseVisible = state.visible?.bufferGroup === nextTarget.bufferGroup
        || Boolean(
            state.visible?.reuseGroup
            && nextTarget.reuseGroup
            && state.visible.reuseGroup === nextTarget.reuseGroup,
        );
    const visible = canReuseVisible
        ? state.visible
        : null;
    return { visible, target: nextTarget };
}

export function viewportTileBufferItems<T extends ViewportTileBufferItem>(
    state: ViewportTileBufferState<T>,
): T[] {
    if (!state.target) return [];
    if (!state.visible || state.visible.key === state.target.key) return [state.target];
    return [state.visible, state.target];
}

export function viewportTilePresentationItems<T extends ViewportTileBufferItem>(
    state: ViewportTileBufferState<T>,
    currentBufferGroup: string,
    currentReuseGroup: string,
    zoomSettling: boolean,
    visibleCoversCurrentViewport = true,
    hasStableUnderlay = false,
): T[] {
    const targetIsCurrent = state.target?.bufferGroup === currentBufferGroup;
    // UIUX (feedback 2026-08-14 §VIEW.SWAP): underlay toàn trang mới là surface liên tục
    // trong lúc wheel zoom. Tile viewport cũ chỉ phủ clip của khung trước; co nó theo trang
    // sẽ tạo một “đảo ảnh” giữa nền. Khi underlay đã sẵn sàng, để compositor hiện thẳng
    // surface đó cho tới khi target của generation mới decode xong.
    if (hasStableUnderlay && (zoomSettling || !targetIsCurrent)) return [];
    if (!zoomSettling && targetIsCurrent) {
        const items = viewportTileBufferItems(state);
        const visibleUsesCurrentRaster = state.visible?.bufferGroup === currentBufferGroup;
        // UIUX (feedback 2026-08-11 §PAN.F1): pan cùng mật độ chỉ làm clip dịch chuyển.
        // Giữ phần tile cũ đã decode trong lúc target mới tải; nếu tháo nó sớm thì toàn
        // viewport rơi xuống nền mờ. Chỉ chặn “đảo nét” khi zoom/khổ raster thật sự đổi.
        if (!visibleCoversCurrentViewport
            && !visibleUsesCurrentRaster
            && state.target
            && state.visible
            && state.visible.key !== state.target.key) {
            // Không có underlay thì giữ tile cũ tới khi target thật sự commit; rút cả hai
            // surface nhìn thấy trước thời điểm đó sẽ làm trang chớp trắng.
            return hasStableUnderlay ? [state.target] : items;
        }
        return items;
    }

    // PERF (feedback 2026-08-09 §ZOOM.F2): khi live zoom hoặc rAF chưa tạo target
    // mới, tiếp tục trình bày bitmap đã decode của đúng tài liệu/trang/pipeline.
    // Parent sẽ scale lại rect theo khổ sống; zoom-out vì thế giữ nguyên độ nét.
    return state.visible?.reuseGroup === currentReuseGroup ? [state.visible] : [];
}
