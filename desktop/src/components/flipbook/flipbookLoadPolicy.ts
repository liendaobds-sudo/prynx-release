import type { TileRenderPurpose } from './tileUrl';

/** PERF (audit 2026-08-08 §RENDER.2): spread hiện tại đi lane tương tác, phần nhìn trước đi nền. */
export function flipbookRenderPurpose(
    pageIndex: number,
    visibleStartIndex: number,
    visiblePageCount = 2,
): TileRenderPurpose {
    return pageIndex >= visibleStartIndex && pageIndex < visibleStartIndex + visiblePageCount
        ? 'interactive'
        : 'background';
}

export function shouldPromoteFlipbookUrl(
    currentUrl: unknown,
    purpose: TileRenderPurpose,
): boolean {
    return purpose === 'interactive'
        && typeof currentUrl === 'string'
        && currentUrl.includes('purpose=background');
}
