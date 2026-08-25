import type { ReactNode } from 'react';

export interface PageOverlayRenderContext {
    /** Số trang trong tài liệu nguồn, một-based. */
    originalPageNum: number;
    /** Vị trí trang hiện tại trong Viewer sau reorder/xóa/nhân bản, một-based. */
    viewerPagePosition: number;
    /** ID ổn định của đúng instance trang trong Viewer. */
    pageInstanceId: string;
    /** Chỉ đúng với khung trang đang active; các trang còn lại vẫn được phép preview. */
    isActivePage: boolean;
}

export type PageOverlayRenderer = (context: PageOverlayRenderContext) => ReactNode;

export function renderPageOverlayForFrame(
    renderer: PageOverlayRenderer | undefined,
    context: PageOverlayRenderContext,
): ReactNode {
    return renderer?.(context) ?? null;
}

export function createViewerVirtualizationContext(
    highlightBoxes: unknown,
    pageOverlay: ReactNode,
    pageOverlayRenderer: PageOverlayRenderer | undefined,
    presentationRevision: unknown = null,
) {
    return {
        highlightBoxes,
        pageOverlay,
        pageOverlayRenderer,
        presentationRevision,
    };
}

export function matchesPageOverlayTarget(input: {
    originalPageNum: number;
    viewerPagePosition: number;
    pageInstanceId: string;
    targetSourcePage: number;
    targetViewerPage?: number;
    targetInstanceId?: string | null;
}): boolean {
    if (input.targetInstanceId) return input.pageInstanceId === input.targetInstanceId;
    if (input.targetViewerPage !== undefined) {
        return input.viewerPagePosition === input.targetViewerPage;
    }
    return input.originalPageNum === input.targetSourcePage;
}

export function selectionAfterViewerScroll(
    current: Set<number>,
    viewerPage: number,
    pageCount: number,
): Set<number> {
    const index = viewerPage - 1;
    if (index < 0 || index >= pageCount || current.size > 1) return current;
    return current.size === 1 && current.has(index) ? current : new Set([index]);
}

export function shouldCenterVirtuosoList(pageDisplayMode: string, rowCount: number): boolean {
    return pageDisplayMode.includes('scroll') && rowCount === 1;
}

export function shouldRemovePagesAfterExtract(
    extractedSuccessfully: boolean,
    deleteAfter: boolean,
): boolean {
    return extractedSuccessfully && deleteAfter;
}
