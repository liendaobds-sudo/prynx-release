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

export type StickerSheetWorkflowStatus = 'pending' | 'processing' | 'review' | 'ready' | 'error';

export function stickerSheetWorkflowStatusAtViewerPosition(
    statuses: Partial<Record<number, StickerSheetWorkflowStatus>> | undefined,
    zeroBasedViewerIndex: number,
): StickerSheetWorkflowStatus | undefined {
    return statuses?.[zeroBasedViewerIndex + 1];
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

export function stickerSourceOwnerFromHistory(viewerFile: File | null): File | null {
    return (
        viewerFile as (File & { __prynxStickerSourceFile?: File | null }) | null
    )?.__prynxStickerSourceFile ?? null;
}

export function viewerShowsStickerSource(
    viewerFile: File | null,
    sourceImageFile: File | null,
    stickerSourceFile: File | null,
): boolean {
    const historyStickerSource = stickerSourceOwnerFromHistory(viewerFile);
    return Boolean(
        stickerSourceFile
        && (
            viewerFile === stickerSourceFile
            || sourceImageFile === stickerSourceFile
            || historyStickerSource === stickerSourceFile
        ),
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

/**
 * REVISION (audit 2026-08-25 §REV.05): `pages` của AI-sheet được keyed theo
 * VỊ TRÍ trong Working PDF. Không ánh xạ lại qua số trang nguồn vì reorder và
 * hai instance duplicate có thể cùng trỏ một source page nhưng có kết quả riêng.
 */
export function selectStickerSheetPageWorkflowStatuses(
    summary: StickerSheetTabSummary,
    workingPageCount: number,
): Partial<Record<number, StickerSheetWorkflowStatus>> | undefined {
    if (summary.stickerSheetMode !== 'ai-sheet' || !summary.stickerSheetSourceFile) {
        return undefined;
    }

    const count = Math.max(
        1,
        summary.stickerSheetPageCount,
        summary.stickerSheetSourceImageCount,
        workingPageCount,
    );
    const statuses: Partial<Record<number, StickerSheetWorkflowStatus>> = {};
    for (let workingPosition = 1; workingPosition <= count; workingPosition += 1) {
        const page = summary.stickerSheetPages[workingPosition];
        if (page?.status === 'error') statuses[workingPosition] = 'error';
        else if (
            page?.isRefining
            || ['inspecting', 'detecting', 'confirming', 'exporting'].includes(page?.status || '')
        ) statuses[workingPosition] = 'processing';
        else if (page?.status === 'mask-review') statuses[workingPosition] = 'review';
        else if (page?.status === 'mask-ready') statuses[workingPosition] = 'ready';
        else statuses[workingPosition] = 'pending';
    }
    return statuses;
}
