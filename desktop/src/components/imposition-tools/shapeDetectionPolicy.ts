export type PageDimension = { w: number; h: number };
export type DieAvailability = boolean | null;
export type StickerDieSizeMode = 'die' | 'page';

function isUsablePageDimension(value: PageDimension | null | undefined): value is PageDimension {
    return !!value
        && Number.isFinite(value.w) && value.w > 0
        && Number.isFinite(value.h) && value.h > 0;
}

/**
 * Guillotine imposition has no die geometry: its item size must come from the
 * live page metadata after resize. Sticker/CNC keeps detected die dimensions,
 * with live page size only as a fallback while detection is unavailable.
 */
export function resolvePreviewItemDimension(
    activeTool: string,
    pageIndex: number,
    detectedByPage: Record<number, PageDimension> | undefined,
    liveByPage: Record<number, PageDimension> | undefined,
    fallback: PageDimension | null | undefined,
): PageDimension | undefined {
    const stickerLike = activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer';
    const candidates = stickerLike
        ? [detectedByPage?.[pageIndex], liveByPage?.[pageIndex], fallback]
        : [liveByPage?.[pageIndex], fallback];
    return candidates.find(isUsablePageDimension);
}

/**
 * Trả master index chỉ khi detect đã đánh dấu rõ đúng một nguồn inheritance và
 * mọi trang còn lại đều kế thừa từ nguồn đó. Không suy "một khuôn" từ shapeType:
 * hai khuôn CIRCLE khác kích thước vẫn là multi-mold.
 */
export function inheritedSingleMoldMaster(
    shapeParamsByPage: Record<number, any> | undefined,
    pageCount: number,
): number | null {
    if (!shapeParamsByPage || pageCount < 2) return null;

    const sources = new Set<number>();
    for (let page = 0; page < pageCount; page += 1) {
        const raw = shapeParamsByPage[page]?.inheritedFromPage;
        if (Number.isInteger(raw)) sources.add(Number(raw));
    }
    if (sources.size !== 1) return null;

    const master = Array.from(sources)[0];
    if (master < 0 || master >= pageCount) return null;
    for (let page = 0; page < pageCount; page += 1) {
        if (page === master) continue;
        const raw = shapeParamsByPage[page]?.inheritedFromPage;
        if (!Number.isInteger(raw) || Number(raw) !== master) return null;
    }
    return master;
}

export function usesPageSizedStickerShape(
    activeTool: string,
    cutType?: string,
    dieSizeMode?: string,
): boolean {
    return activeTool === 'sticker_imposer'
        && cutType === 'one_dao'
        && dieSizeMode === 'page';
}

/**
 * Chỉ cho chọn Nguyên tấm khi backend đã xác nhận file có khuôn bế thật.
 * `null` là đang nhận diện/lỗi đọc file nên chưa được tự ép mode.
 */
export function resolveStickerUnitAvailability(
    activeTool: string,
    hasValidDie: DieAvailability,
): { showSelector: boolean; forceSticker: boolean } {
    if (activeTool !== 'sticker_imposer') {
        return { showSelector: false, forceSticker: false };
    }
    return {
        showSelector: hasValidDie === true,
        forceSticker: hasValidDie === false,
    };
}

export interface StickerCutControlPolicy {
    dieStatus: 'available' | 'page_only' | 'unknown';
    effectiveDieSizeMode: StickerDieSizeMode;
    effectiveFillBlockGap: number;
    showDieSizeSelector: boolean;
    showDieSizeStatus: boolean;
    showDieOffset: boolean;
    showFillBlockGap: boolean;
}

/**
 * UIUX (audit 2026-08-13 §DIE-FALLBACK-02): một nguồn duy nhất cho các điều
 * khiển 1 Dao. Không đưa lựa chọn "khuôn có sẵn" khi detector đã xác nhận file
 * không có khuôn, và không truyền KC cụm phụ cho cách xếp không tạo L-shape.
 */
export function resolveStickerCutControlPolicy(
    activeTool: string,
    hasValidDie: DieAvailability,
    cutType: string | undefined,
    gridStrategy: string | undefined,
    requestedDieSizeMode: string | undefined,
    requestedFillBlockGap: number | undefined,
): StickerCutControlPolicy {
    const stickerTool = activeTool === 'sticker_imposer';
    const oneDao = stickerTool && cutType === 'one_dao';
    const dieStatus = hasValidDie === true
        ? 'available'
        : hasValidDie === false ? 'page_only' : 'unknown';
    const requestedMode: StickerDieSizeMode = requestedDieSizeMode === 'page'
        ? 'page' : 'die';
    const effectiveDieSizeMode: StickerDieSizeMode = oneDao && dieStatus === 'page_only'
        ? 'page' : requestedMode;
    const showFillBlockGap = oneDao && gridStrategy === 'optimal_auto';
    const rawFillBlockGap = Number(requestedFillBlockGap);
    const normalizedFillBlockGap = Number.isFinite(rawFillBlockGap)
        ? Math.max(0, rawFillBlockGap) : 0;

    return {
        dieStatus,
        effectiveDieSizeMode,
        // Chính sách ẩn/đặt 0 chỉ thuộc Bình tem bế. CNC và consumer dùng chung
        // dashboard phải giữ nguyên tham số cũ để không tạo hồi quy âm thầm.
        effectiveFillBlockGap: stickerTool
            ? (showFillBlockGap ? normalizedFillBlockGap : 0)
            : normalizedFillBlockGap,
        showDieSizeSelector: oneDao && dieStatus === 'available',
        showDieSizeStatus: oneDao && dieStatus !== 'available',
        // UIUX (audit 2026-08-14 §DIE-FALLBACK-03): Co/Mở chỉ áp lên khung
        // trang. Mặc định có CutContour thật phải giữ nguyên hình học khuôn.
        showDieOffset: stickerTool && (
            (oneDao && effectiveDieSizeMode === 'page')
            || (cutType === 'default' && dieStatus === 'page_only')
        ),
        showFillBlockGap,
    };
}

/**
 * INKING (audit 2026-08-12 §INK-DIE-03): RECTANGLE là mã nhận diện dùng chung
 * cho cả tem vuông và chữ nhật. Chỉ mở Inking khi mọi trang đang còn trong
 * viewer đều là RECTANGLE; one_dao luôn dùng dao thẳng chữ nhật.
 */
export function canUseRectangleStickerInking(
    activeTool: string,
    pageSheetMode: boolean,
    cutType: string | undefined,
    shapesByPage: Record<number, string> | undefined,
    pageCount: number,
): boolean {
    if (activeTool !== 'sticker_imposer' || pageSheetMode) return false;
    if (cutType === 'one_dao') return true;
    if (!shapesByPage || pageCount <= 0) return false;
    for (let page = 0; page < pageCount; page += 1) {
        if (String(shapesByPage[page] || '').trim().toUpperCase() !== 'RECTANGLE') {
            return false;
        }
    }
    return true;
}

export function buildPageSizedShapeState(
    sourcePageDims: PageDimension[],
    fallbackDim: PageDimension | null,
    pageCount: number,
) {
    const count = Math.max(
        0,
        pageCount || 0,
        sourcePageDims.length,
        fallbackDim ? 1 : 0,
    );
    const shapes: Record<number, string> = {};
    const dimensions: Record<number, PageDimension> = {};
    const params: Record<number, Record<string, never>> = {};

    for (let page = 0; page < count; page += 1) {
        shapes[page] = 'RECTANGLE';
        params[page] = {};
        const dim = sourcePageDims[page] || fallbackDim;
        if (dim && Number.isFinite(dim.w) && dim.w > 0 && Number.isFinite(dim.h) && dim.h > 0) {
            dimensions[page] = { w: dim.w, h: dim.h };
        }
    }

    return { shapes, dimensions, params };
}

export function shapeDetectionSourceKey(
    isTauri: boolean,
    localPath: string | undefined,
    fileId: string,
    file: Pick<File, 'name' | 'size' | 'lastModified'> | null,
): string {
    if (isTauri && localPath) return `path:${localPath}`;
    if (fileId) return `file-id:${fileId}`;
    if (!file) return '';
    return `pending:${file.name}:${file.size}:${file.lastModified}`;
}

export function batchCapacityDetectionReady(
    activeTool: string,
    isDetectingShape: boolean,
    pageCount: number,
    shapesByPage: Record<number, string> | undefined,
    detectionCompleted: boolean,
): boolean {
    const stickerLike = activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer';
    if (!stickerLike) return true;
    if (isDetectingShape || !detectionCompleted || pageCount <= 0 || !shapesByPage) return false;
    for (let page = 0; page < pageCount; page += 1) {
        if (!shapesByPage[page]) return false;
    }
    return true;
}

export function projectPageRecordToViewer<T>(
    bySourcePage: Record<number, T> | undefined,
    viewerPageOrder: number[] | null | undefined,
): Record<number, T> {
    if (!bySourcePage) return {};
    if (!viewerPageOrder || viewerPageOrder.length === 0) return { ...bySourcePage };
    const projected: Record<number, T> = {};
    viewerPageOrder.forEach((sourcePageNumber, viewerIndex) => {
        const value = bySourcePage[sourcePageNumber - 1];
        if (value !== undefined) projected[viewerIndex] = value;
    });
    return projected;
}

export function projectShapeParamsToViewer(
    bySourcePage: Record<number, any> | undefined,
    viewerPageOrder: number[] | null | undefined,
): Record<number, any> {
    const projected = projectPageRecordToViewer(bySourcePage, viewerPageOrder);
    if (!viewerPageOrder || viewerPageOrder.length === 0) return projected;

    const firstViewerIndexBySource = new Map<number, number>();
    viewerPageOrder.forEach((sourcePageNumber, viewerIndex) => {
        const sourceIndex = sourcePageNumber - 1;
        if (sourceIndex >= 0 && !firstViewerIndexBySource.has(sourceIndex)) {
            firstViewerIndexBySource.set(sourceIndex, viewerIndex);
        }
    });

    Object.keys(projected).forEach((key) => {
        const viewerIndex = Number(key);
        const props = projected[viewerIndex];
        if (!props || typeof props !== "object" || !Number.isInteger(props.inheritedFromPage)) return;
        const mappedMaster = firstViewerIndexBySource.get(Number(props.inheritedFromPage));
        if (mappedMaster === undefined) return;
        projected[viewerIndex] = { ...props, inheritedFromPage: mappedMaster };
    });
    return projected;
}
