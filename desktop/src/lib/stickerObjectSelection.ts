import {
    isWorkspaceDocumentRevisionCurrent,
    workspaceFileIdentity,
    type WorkspaceState,
} from '../stores/useWorkspaceStore';

/** File ID của Edit PDF đọc trang nguồn, không phải working PDF đã đổi thứ tự/xoay. */
export function stickerObjectSourceIdentity(file: File | null | undefined): string {
    return `source:${workspaceFileIdentity(file)}`;
}

/** UIUX (audit 2026-09-06 §CUSTOM.PDF): chỉ dùng ID của đúng trang và phiên PDF. */
export function resolveStickerObjectSelection(
    state: WorkspaceState,
    workingPage: number,
): string[] | null {
    const context = state.objectSelectionContext;
    if (
        !state.file
        || !context?.revision
        || !state.selectionFileId
        || context.fileId !== state.selectionFileId
        || !Number.isInteger(workingPage)
        || workingPage < 1
        || context.viewerPage !== workingPage
        || context.pageInstanceId === undefined
        || context.objectIds.length === 0
        || !isWorkspaceDocumentRevisionCurrent(context.revision, state)
        || state.selectionDocumentIdentity !== stickerObjectSourceIdentity(state.file)
    ) return null;

    const pageOrder = state.viewerPageOrder;
    const sourcePage = pageOrder?.length ? pageOrder[workingPage - 1] : workingPage;
    if (
        !Number.isInteger(sourcePage)
        || sourcePage < 1
        || context.pageIndex !== sourcePage - 1
        || (!pageOrder?.length && state.viewerNumPages > 0 && workingPage > state.viewerNumPages)
    ) return null;

    const pageInstanceId = state.viewerPageInstanceIds?.[workingPage - 1] ?? null;
    if (
        context.pageInstanceId !== pageInstanceId
        || (state.viewerPageInstanceIds !== undefined && !pageInstanceId)
        || (!pageInstanceId && pageOrder && pageOrder.filter(page => page === sourcePage).length > 1)
    ) return null;

    return [...context.objectIds];
}
