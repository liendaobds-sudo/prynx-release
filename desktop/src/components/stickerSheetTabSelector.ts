import type {
    StickerSheetPageState,
    StickerSheetTabState,
} from './preprocess-tools/stickerSheetStore';

export interface StickerSheetTabSummary {
    stickerSheetMode: StickerSheetTabState['mode'];
    stickerSheetSourceFile: File | null;
    stickerSheetActiveSourcePage: number;
    stickerSheetPages: Readonly<Record<number, StickerSheetPageState>>;
    stickerSheetPageCount: number;
    stickerSheetSourceImageCount: number;
    stickerSheetBusy: boolean;
}

export function resolveStickerSourceSyncMarker(
    stickerSourceFile: File | null,
    nextSourceImage: File | null,
    keepStickerSource: boolean,
): File | null {
    return keepStickerSource && stickerSourceFile
        ? stickerSourceFile
        : nextSourceImage;
}

export function viewerShowsStickerSource(
    viewerFile: File | null,
    sourceImageFile: File | null,
    stickerSourceFile: File | null,
): boolean {
    return Boolean(
        stickerSourceFile
        && (viewerFile === stickerSourceFile || sourceImageFile === stickerSourceFile),
    );
}

// UIUX (feedback 2026-08-09 §RENDER.F7): useSyncExternalStore yêu cầu snapshot
// không đổi tham chiếu khi state không đổi; object rỗng tạo tại chỗ sẽ làm React lặp vô hạn.
const EMPTY_STICKER_SHEET_PAGES: Readonly<Record<number, StickerSheetPageState>> = Object.freeze({});

export function selectStickerSheetTabSummary(
    state: { tabs: Record<string, StickerSheetTabState> },
    tabId?: string,
): StickerSheetTabSummary {
    const stickerTab = state.tabs[tabId || ''];
    return {
        stickerSheetMode: stickerTab?.mode ?? 'existing',
        stickerSheetSourceFile: stickerTab?.sourceFile ?? null,
        stickerSheetActiveSourcePage: stickerTab?.activeSourcePage ?? 1,
        stickerSheetPages: stickerTab?.pages ?? EMPTY_STICKER_SHEET_PAGES,
        stickerSheetPageCount: stickerTab?.inspection?.page_count ?? 0,
        stickerSheetSourceImageCount: stickerTab?.sourceImageCount ?? 0,
        stickerSheetBusy: stickerTab?.status === 'confirming'
            || stickerTab?.status === 'exporting'
            || stickerTab?.isExporting === true,
    };
}
