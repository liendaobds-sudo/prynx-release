export type PageDimension = { w: number; h: number };

export function usesPageSizedStickerShape(
    activeTool: string,
    cutType?: string,
    dieSizeMode?: string,
): boolean {
    return activeTool === 'sticker_imposer'
        && cutType === 'one_dao'
        && dieSizeMode === 'page';
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
