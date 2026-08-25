import { stripBytesIfOnDisk } from './utils';

export interface WorkspaceHistoryPageRevision {
    readonly pageOrder: readonly number[];
    readonly pageInstanceIds: readonly string[];
    /** Góc xoay theo vị trí trong pageOrder, không keyed theo số trang nguồn. */
    readonly pageRotations: readonly number[];
}

export interface WorkspaceHistoryEntry {
    readonly file: File;
    readonly pageRevision: WorkspaceHistoryPageRevision | null;
    readonly pageRevisionDirty: boolean;
    readonly sourceImageFile: File | null;
    readonly stickerSourceFile: File | null;
    readonly recipeDraftLen: number | null;
}

export interface CreateWorkspaceHistoryEntryInput {
    file: File;
    pageOrder?: readonly number[];
    pageInstanceIds?: readonly string[];
    pageRotations?: readonly number[];
    pageRevisionDirty?: boolean;
    sourceImageFile?: File | null;
    stickerSourceFile?: File | null;
    recipeDraftLen?: number | null;
}

let workspaceHistoryInstanceSeq = 0;

function createWorkspaceHistoryInstanceId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid
        ? `history-${uuid}`
        : `history-${Date.now().toString(36)}-${++workspaceHistoryInstanceSeq}`;
}

function normalizeRotation(value: number | undefined): number {
    if (!Number.isFinite(value)) return 0;
    return ((Number(value) % 360) + 360) % 360;
}

function validPageInstanceIds(
    ids: readonly string[] | undefined,
    expectedLength: number,
): ids is readonly string[] {
    if (!ids || ids.length !== expectedLength) return false;
    if (ids.some(id => typeof id !== 'string' || id.length === 0)) return false;
    return new Set(ids).size === ids.length;
}

export function normalizeWorkspaceHistoryPageRevision(
    pageOrder: readonly number[] | undefined,
    pageInstanceIds: readonly string[] | undefined,
    pageRotations: readonly number[] | undefined,
    createInstanceId: () => string = createWorkspaceHistoryInstanceId,
): WorkspaceHistoryPageRevision | null {
    if (!pageOrder || pageOrder.length === 0) return null;

    const normalizedOrder = Object.freeze([...pageOrder]);
    const normalizedIds = Object.freeze(
        validPageInstanceIds(pageInstanceIds, normalizedOrder.length)
            ? [...pageInstanceIds]
            : normalizedOrder.map(() => createInstanceId()),
    );
    const normalizedRotations = Object.freeze(
        normalizedOrder.map((_, index) => normalizeRotation(pageRotations?.[index])),
    );

    return Object.freeze({
        pageOrder: normalizedOrder,
        pageInstanceIds: normalizedIds,
        pageRotations: normalizedRotations,
    });
}

/**
 * REVISION (audit 2026-08-25 §REV.08): history phải chụp nguyên khối revision
 * đang thấy; không gắn metadata ẩn lên File rồi phục hồi từng state rời rạc.
 */
export function createWorkspaceHistoryEntry(
    input: CreateWorkspaceHistoryEntryInput,
    createInstanceId?: () => string,
): WorkspaceHistoryEntry {
    const recipeDraftLen = Number.isInteger(input.recipeDraftLen)
        && Number(input.recipeDraftLen) >= 0
        ? Number(input.recipeDraftLen)
        : null;

    return Object.freeze({
        file: stripBytesIfOnDisk(input.file),
        pageRevision: normalizeWorkspaceHistoryPageRevision(
            input.pageOrder,
            input.pageInstanceIds,
            input.pageRotations,
            createInstanceId,
        ),
        pageRevisionDirty: input.pageRevisionDirty === true,
        sourceImageFile: input.sourceImageFile ?? null,
        stickerSourceFile: input.stickerSourceFile ?? null,
        recipeDraftLen,
    });
}
