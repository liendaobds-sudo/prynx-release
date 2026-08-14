export interface PageViewportAnchor {
    xRatio: number;
    yRatio: number;
}

export interface PagePointViewportAnchor {
    /** Vị trí con trỏ trong khung cuộn, không phụ thuộc scrollLeft/Top. */
    viewportX: number;
    viewportY: number;
    /** Tọa độ tương đối trên footprint trang; có thể ngoài 0..1 khi con trỏ ở lề xám. */
    pageXRatio: number;
    pageYRatio: number;
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

/**
 * UIUX (feedback 2026-08-14 §VIEW.ZOOM): neo đúng điểm trên trang nằm dưới con trỏ.
 * Không suy tọa độ từ scroll offset vì flex centering/padding có thể đổi origin khi zoom.
 */
export function capturePagePointViewportAnchor(
    scroller: HTMLElement,
    page: HTMLElement,
    clientX: number,
    clientY: number,
): PagePointViewportAnchor | null {
    const scrollRect = scroller.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const values = [
        scrollRect.left,
        scrollRect.top,
        pageRect.left,
        pageRect.top,
        pageRect.width,
        pageRect.height,
        clientX,
        clientY,
    ];
    if (!values.every(Number.isFinite) || pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    return {
        viewportX: clientX - scrollRect.left,
        viewportY: clientY - scrollRect.top,
        pageXRatio: (clientX - pageRect.left) / pageRect.width,
        pageYRatio: (clientY - pageRect.top) / pageRect.height,
    };
}

export function restorePagePointViewportAnchor(
    scroller: HTMLElement,
    page: HTMLElement,
    anchor: PagePointViewportAnchor,
): boolean {
    const scrollRect = scroller.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const values = [
        scrollRect.left,
        scrollRect.top,
        pageRect.left,
        pageRect.top,
        pageRect.width,
        pageRect.height,
        anchor.viewportX,
        anchor.viewportY,
        anchor.pageXRatio,
        anchor.pageYRatio,
    ];
    if (!values.every(Number.isFinite) || pageRect.width <= 0 || pageRect.height <= 0) {
        return false;
    }

    const targetClientX = scrollRect.left + anchor.viewportX;
    const targetClientY = scrollRect.top + anchor.viewportY;
    const anchoredPageX = pageRect.left + pageRect.width * anchor.pageXRatio;
    const anchoredPageY = pageRect.top + pageRect.height * anchor.pageYRatio;
    scroller.scrollLeft += anchoredPageX - targetClientX;
    scroller.scrollTop += anchoredPageY - targetClientY;
    return true;
}
