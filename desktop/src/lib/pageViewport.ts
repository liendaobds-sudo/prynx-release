export interface PageViewportAnchor {
    xRatio: number;
    yRatio: number;
}

const clampRatio = (value: number): number => Math.max(0, Math.min(1, value));

export function capturePageViewportAnchor(
    scroller: HTMLElement,
    page: HTMLElement,
): PageViewportAnchor | null {
    const scrollRect = scroller.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return null;

    const viewportCenterX = scrollRect.left + scroller.clientWidth / 2;
    const viewportCenterY = scrollRect.top + scroller.clientHeight / 2;
    return {
        xRatio: clampRatio((viewportCenterX - pageRect.left) / pageRect.width),
        yRatio: clampRatio((viewportCenterY - pageRect.top) / pageRect.height),
    };
}

export function restorePageViewportAnchor(
    scroller: HTMLElement,
    page: HTMLElement,
    anchor: PageViewportAnchor,
): boolean {
    const scrollRect = scroller.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return false;

    const viewportCenterX = scrollRect.left + scroller.clientWidth / 2;
    const viewportCenterY = scrollRect.top + scroller.clientHeight / 2;
    const anchoredPageX = pageRect.left + pageRect.width * clampRatio(anchor.xRatio);
    const anchoredPageY = pageRect.top + pageRect.height * clampRatio(anchor.yRatio);

    scroller.scrollLeft += anchoredPageX - viewportCenterX;
    scroller.scrollTop += anchoredPageY - viewportCenterY;
    return true;
}
