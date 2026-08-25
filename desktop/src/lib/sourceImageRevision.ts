import type { WorkspaceDocumentRevisionToken } from '../stores/useWorkspaceStore';

/** Owner của ảnh gốc được giữ cạnh PDF một trang đã chuẩn hóa cho Viewer. */
export interface SourceImageRevisionOwner {
    readonly pdfFile: File;
    readonly editGeneration: number;
}

export function createSourceImageRevisionOwner(
    pdfFile: File,
    editGeneration: number,
): SourceImageRevisionOwner {
    return Object.freeze({ pdfFile, editGeneration });
}

/**
 * REVISION (audit 2026-08-25 §REV.06): ảnh shadow chỉ tương đương tài liệu khi
 * Viewer vẫn ở đúng PDF một trang ban đầu, chưa nhân bản/xóa/xoay/edit.
 */
export function isSourceImageRevisionCurrent(
    owner: SourceImageRevisionOwner | null | undefined,
    revision: WorkspaceDocumentRevisionToken,
): boolean {
    if (
        !owner
        || revision.file !== owner.pdfFile
        || revision.editGeneration !== owner.editGeneration
    ) return false;

    const order = revision.viewerPageOrder;
    if (order !== undefined && (order.length !== 1 || order[0] !== 1)) return false;

    const instanceIds = revision.viewerPageInstanceIds;
    if (instanceIds !== undefined && instanceIds.length !== 1) return false;

    const rotations = revision.viewerPageRotations;
    return rotations === undefined || (
        rotations.length <= 1
        && rotations.every(value => ((value % 360) + 360) % 360 === 0)
    );
}
