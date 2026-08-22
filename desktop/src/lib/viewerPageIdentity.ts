export interface ViewerPageIdentity {
    /** Vị trí một-based trong Viewer sau reorder/delete/duplicate. */
    viewerPosition: number;
    viewerIndex: number;
    /** Trang một-based trong file nguồn; null với trang trắng/identity không hợp lệ. */
    sourcePage: number | null;
    sourceIndex: number | null;
    /** ID ổn định của đúng instance trong Viewer. */
    instanceId: string | null;
    /** Trang trong Working PDF đã materialize theo đúng thứ tự Viewer. */
    materializedPage: number | null;
}

interface ResolveViewerPageIdentityInput {
    viewerPosition: number;
    pageOrder?: readonly number[] | null;
    pageInstanceIds?: readonly string[] | null;
}

export function resolveViewerPageIdentity({
    viewerPosition,
    pageOrder,
    pageInstanceIds,
}: ResolveViewerPageIdentityInput): ViewerPageIdentity {
    // UIUX (audit 2026-08-22 §UX.VIEW.02–04): vị trí Viewer, trang nguồn và
    // trang đã materialize là ba namespace khác nhau; không fallback lẫn nhau.
    const viewerIndex = Number.isInteger(viewerPosition) ? viewerPosition - 1 : -1;
    const hasExplicitOrder = Array.isArray(pageOrder);
    const viewerExists = viewerIndex >= 0
        && (!hasExplicitOrder || viewerIndex < pageOrder.length);
    const orderedSourcePage = viewerExists
        ? (hasExplicitOrder ? pageOrder[viewerIndex] : viewerPosition)
        : null;
    const sourcePage = Number.isInteger(orderedSourcePage) && Number(orderedSourcePage) > 0
        ? Number(orderedSourcePage)
        : null;
    const rawInstanceId = viewerExists ? pageInstanceIds?.[viewerIndex] : null;

    return {
        viewerPosition,
        viewerIndex,
        sourcePage,
        sourceIndex: sourcePage == null ? null : sourcePage - 1,
        instanceId: typeof rawInstanceId === 'string' && rawInstanceId ? rawInstanceId : null,
        materializedPage: viewerExists ? viewerPosition : null,
    };
}

/**
 * Chọn lại vị trí active sau khi xóa một hay nhiều instance.
 * Ưu tiên giữ đúng artwork đang xem; chỉ clamp theo index cũ khi artwork đó
 * đã bị xóa. Nhờ vậy active/thumbnail/selection không trỏ ba trang khác nhau.
 */
export function resolveActiveViewerIndexAfterRemoval(
    currentViewerPosition: number,
    currentInstanceIds: readonly string[],
    nextInstanceIds: readonly string[],
): number {
    if (nextInstanceIds.length === 0) return -1;
    const oldIndex = Math.max(0, Math.min(currentInstanceIds.length - 1, currentViewerPosition - 1));
    const activeId = currentInstanceIds[oldIndex];
    const retainedIndex = activeId ? nextInstanceIds.indexOf(activeId) : -1;
    return retainedIndex >= 0
        ? retainedIndex
        : Math.min(oldIndex, nextInstanceIds.length - 1);
}

/**
 * UIUX (audit 2026-08-22 §UX.VIEW.06): map vị trí trang zero-based sang row
 * của Virtuoso. Ở chế độ hai trang, hai vị trí liên tiếp dùng chung một row;
 * các handler điều hướng phải dùng cùng một phép map này.
 */
export function viewerRowIndexForPosition(viewerIndex: number, pageDisplayMode: string): number {
    const safeIndex = Number.isFinite(viewerIndex) ? Math.max(0, Math.floor(viewerIndex)) : 0;
    return pageDisplayMode.startsWith('two_') ? Math.floor(safeIndex / 2) : safeIndex;
}

export interface ViewerFitPageSize {
    width: number;
    height: number;
}

interface ResolveViewerFitPageSizesInput {
    activeViewerPosition: number;
    pageDisplayMode: string;
    pageOrder: readonly number[];
    pageInstanceIds: readonly string[];
    pageRotations: Readonly<Record<string, number>>;
    pageDims: Readonly<Record<number, { w: number; h: number }>>;
    fallbackDim?: { w: number; h: number } | null;
    displayScale?: number;
}

export function resolveViewerFitPageSizes({
    activeViewerPosition,
    pageDisplayMode,
    pageOrder,
    pageInstanceIds,
    pageRotations,
    pageDims,
    fallbackDim,
    displayScale = 1,
}: ResolveViewerFitPageSizesInput): ViewerFitPageSize[] {
    if (pageOrder.length === 0) return [];
    const activeIndex = Math.max(0, Math.min(pageOrder.length - 1, activeViewerPosition - 1));
    const startIndex = pageDisplayMode.startsWith('two_')
        ? activeIndex - (activeIndex % 2)
        : activeIndex;
    const endIndex = pageDisplayMode.startsWith('two_')
        ? Math.min(pageOrder.length, startIndex + 2)
        : startIndex + 1;
    const safeScale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
    const result: ViewerFitPageSize[] = [];

    for (let index = startIndex; index < endIndex; index += 1) {
        const identity = resolveViewerPageIdentity({
            viewerPosition: index + 1,
            pageOrder,
            pageInstanceIds,
        });
        if (identity.sourcePage == null) continue;
        const dim = pageDims[identity.sourcePage] ?? fallbackDim;
        if (!dim || dim.w <= 0 || dim.h <= 0) continue;
        const rawRotation = identity.instanceId ? pageRotations[identity.instanceId] || 0 : 0;
        const rotation = ((rawRotation % 360) + 360) % 360;
        const rotated = rotation === 90 || rotation === 270;
        result.push({
            width: (rotated ? dim.h : dim.w) * safeScale,
            height: (rotated ? dim.w : dim.h) * safeScale,
        });
    }

    return result;
}
