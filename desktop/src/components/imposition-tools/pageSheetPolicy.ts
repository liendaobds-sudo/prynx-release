import type { ActiveToolType } from './types';
import type { ImpositionUnit } from './store/slices/nupSlice';

export interface ImpositionModes {
    pageSheetMode: boolean;
    stickerGeometryMode: boolean;
    dieGeometryMode: boolean;
    pontSettingsMode: boolean;
    stickerToolIdentity: boolean;
}

export function resolveImpositionModes(
    activeTool: ActiveToolType | string,
    impositionUnit: ImpositionUnit | string | undefined,
): ImpositionModes {
    const stickerToolIdentity = activeTool === 'sticker_imposer';
    const pageSheetMode = stickerToolIdentity && impositionUnit === 'page_sheet';
    const stickerGeometryMode = stickerToolIdentity && !pageSheetMode;
    const dieGeometryMode = activeTool === 'cnc_imposer' || stickerGeometryMode;
    // A whole decal sheet keeps rectangular/guillotine layout geometry, but it
    // still needs the existing die registration marks on its dedicated cut page.
    const pontSettingsMode = dieGeometryMode || pageSheetMode;
    return {
        pageSheetMode,
        stickerGeometryMode,
        dieGeometryMode,
        pontSettingsMode,
        stickerToolIdentity,
    };
}

export function resolveEffectiveSeparateCut(
    activeTool: ActiveToolType | string,
    impositionUnit: ImpositionUnit | string | undefined,
    requestedSeparateCut: boolean | undefined,
): boolean {
    return resolveImpositionModes(activeTool, impositionUnit).pageSheetMode
        || requestedSeparateCut === true;
}

export interface ImpositionSplitGapInput {
    dieGeometryMode: boolean;
    gapX?: number;
    gapY?: number;
    clusterGap?: number;
    clusterGapMode?: 'item' | 'mark' | string;
    markType?: 'none' | 'corners' | 'guillotine' | string;
    markLength?: number;
    markOffset?: number;
}

/**
 * Một nguồn duy nhất cho khe giữa các khối ở batch-capacity, preview và export.
 * Hình học bế dùng hở tem; hình học xén chừa đúng không gian cho hai bộ dấu.
 */
export function resolveImpositionSplitGap(input: ImpositionSplitGapInput): number {
    const gapX = Number.isFinite(input.gapX) ? Math.max(0, Number(input.gapX)) : 0;
    const gapY = Number.isFinite(input.gapY) ? Math.max(0, Number(input.gapY)) : 0;
    if (input.dieGeometryMode) return Math.max(gapX, gapY);

    const clusterGap = Number.isFinite(input.clusterGap)
        ? Math.max(0, Number(input.clusterGap))
        : 0;
    let splitGap = clusterGap > 0 ? clusterGap : Math.max(gapX, gapY, 5);
    if (
        (input.markType === 'guillotine' || input.markType === 'corners')
        && (clusterGap <= 0 || input.clusterGapMode === 'mark')
    ) {
        const markLength = Number.isFinite(input.markLength) ? Math.max(0, Number(input.markLength)) : 5;
        const markOffset = Number.isFinite(input.markOffset) ? Math.max(0, Number(input.markOffset)) : 3;
        splitGap = 2 * (markLength + markOffset);
    }
    return splitGap;
}
