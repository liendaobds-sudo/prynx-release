export type VerticalScrollAlignment = 'nearest' | 'center';

interface VerticalScrollGeometry {
    containerTop: number;
    containerHeight: number;
    scrollTop: number;
    elementTop: number;
    elementHeight: number;
}

/**
 * Calculate a vertical-only scroll position. Keeping this separate from
 * Element.scrollIntoView is important: scrollIntoView may also move
 * overflow-hidden ancestors horizontally and shift the whole PDF workspace.
 */
export function getVerticalScrollTop(
    geometry: VerticalScrollGeometry,
    alignment: VerticalScrollAlignment,
): number {
    const {
        containerTop,
        containerHeight,
        scrollTop,
        elementTop,
        elementHeight,
    } = geometry;

    if (alignment === 'center') {
        return scrollTop
            + (elementTop + elementHeight / 2)
            - (containerTop + containerHeight / 2);
    }

    const containerBottom = containerTop + containerHeight;
    const elementBottom = elementTop + elementHeight;
    if (elementTop < containerTop) {
        return scrollTop - (containerTop - elementTop);
    }
    if (elementBottom > containerBottom) {
        return scrollTop + (elementBottom - containerBottom);
    }
    return scrollTop;
}

export function scrollElementVerticallyIntoView(
    element: HTMLElement,
    container: HTMLElement,
    alignment: VerticalScrollAlignment = 'nearest',
): void {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const target = getVerticalScrollTop({
        containerTop: containerRect.top,
        containerHeight: containerRect.height,
        scrollTop: container.scrollTop,
        elementTop: elementRect.top,
        elementHeight: elementRect.height,
    }, alignment);
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const clampedTarget = Math.max(0, Math.min(target, maxScrollTop));

    if (Number.isFinite(clampedTarget) && Math.abs(clampedTarget - container.scrollTop) > 0.5) {
        container.scrollTop = clampedTarget;
    }
}

export function findNearestVerticalScrollContainer(element: HTMLElement): HTMLElement | null {
    let candidate = element.parentElement;
    while (candidate) {
        const overflowY = window.getComputedStyle(candidate).overflowY;
        if (/^(auto|scroll|overlay)$/.test(overflowY)
            && candidate.scrollHeight > candidate.clientHeight + 1) {
            return candidate;
        }
        candidate = candidate.parentElement;
    }
    return null;
}