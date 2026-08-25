import type {
    WorkingPdfResolver,
    WorkingPdfRevisionSnapshot,
} from '../hooks/useWorkingPdf';

export interface RevisionScopedPdfUploadResult {
    id: string;
}

export interface RevisionScopedPdfUploadOptions {
    resolver: WorkingPdfResolver;
    upload: (
        file: File,
        options: { signal: AbortSignal },
    ) => Promise<RevisionScopedPdfUploadResult>;
    publish?: (fileId: string, snapshot: WorkingPdfRevisionSnapshot) => void;
    missingFileError?: () => Error;
}

export interface RevisionScopedPdfUploadLease {
    readonly fileId: string;
    /** Snapshot chỉ đọc của đúng PDF đã tạo ra `fileId`. */
    readonly snapshot: WorkingPdfRevisionSnapshot;
    /**
     * Phải gọi sau mỗi response backend và ngay trước khi công bố UI/artifact.
     * Hàm ném AbortError nếu tài liệu, generation cache hoặc signal đã đổi.
     */
    readonly assertCurrent: () => void;
}

export interface RevisionScopedPdfUploadCache {
    ensure: (signal?: AbortSignal) => Promise<string>;
    ensureLease: (signal?: AbortSignal) => Promise<RevisionScopedPdfUploadLease>;
    invalidate: (reason?: unknown) => void;
    dispose: () => void;
}

interface CachedUpload {
    snapshot: WorkingPdfRevisionSnapshot;
    fileId: string;
    generation: number;
}

interface ActiveUpload {
    snapshot: WorkingPdfRevisionSnapshot;
    generation: number;
    controller: AbortController;
    promise: Promise<CachedUpload>;
}

function createAbortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function sameOptionalArray<T>(
    left: readonly T[] | undefined,
    right: readonly T[] | undefined,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
}

function sameRevision(
    left: WorkingPdfRevisionSnapshot,
    right: WorkingPdfRevisionSnapshot,
): boolean {
    return left.file === right.file
        && left.editGeneration === right.editGeneration
        && sameOptionalArray(left.viewerPageOrder, right.viewerPageOrder)
        && sameOptionalArray(left.viewerPageInstanceIds, right.viewerPageInstanceIds)
        && sameOptionalArray(left.viewerPageRotations, right.viewerPageRotations);
}

function cloneImmutableSnapshot(
    snapshot: WorkingPdfRevisionSnapshot,
): WorkingPdfRevisionSnapshot {
    // REVISION (audit 2026-08-25 §REV.04): consumer nhận một bản clone/freeze,
    // không được có khả năng sửa mảng snapshot đang giữ bên trong cache.
    return Object.freeze({
        ...snapshot,
        viewerPageOrder: snapshot.viewerPageOrder === undefined
            ? undefined
            : Object.freeze([...snapshot.viewerPageOrder]),
        viewerPageInstanceIds: snapshot.viewerPageInstanceIds === undefined
            ? undefined
            : Object.freeze([...snapshot.viewerPageInstanceIds]),
        viewerPageRotations: snapshot.viewerPageRotations === undefined
            ? undefined
            : Object.freeze([...snapshot.viewerPageRotations]),
    });
}

function forwardAbortSignal(
    source: AbortSignal | undefined,
    target: AbortController,
): () => void {
    if (!source) return () => undefined;
    const abort = () => {
        if (!target.signal.aborted) {
            target.abort(source.reason ?? createAbortError('Đã hủy chuẩn bị PDF.'));
        }
    };
    if (source.aborted) {
        abort();
        return () => undefined;
    }
    source.addEventListener('abort', abort, { once: true });
    return () => source.removeEventListener('abort', abort);
}

function abortReason(controller: AbortController, fallback: string): unknown {
    return controller.signal.reason ?? createAbortError(fallback);
}

/**
 * REVISION (audit 2026-08-25 §REV.02): cache chỉ giữ file_id và snapshot nguồn,
 * không giữ Working File đã materialize. Mọi kết quả đều phải chứng minh revision
 * còn hiện hành trước khi được công bố cho consumer.
 */
export function createRevisionScopedPdfUploadCache(
    options: RevisionScopedPdfUploadOptions,
): RevisionScopedPdfUploadCache {
    let generation = 0;
    let cachedUpload: CachedUpload | null = null;
    let activeUpload: ActiveUpload | null = null;

    const invalidate = (reason?: unknown) => {
        generation += 1;
        cachedUpload = null;
        const active = activeUpload;
        activeUpload = null;
        if (active && !active.controller.signal.aborted) {
            active.controller.abort(
                reason ?? createAbortError('Revision PDF đã thay đổi.'),
            );
        }
    };

    const createLease = (
        upload: CachedUpload,
        signal?: AbortSignal,
    ): RevisionScopedPdfUploadLease => {
        const assertCurrent = () => {
            if (signal?.aborted) {
                throw signal.reason ?? createAbortError('Đã hủy tác vụ PDF.');
            }
            if (
                upload.generation !== generation
                || !options.resolver.isCurrent(upload.snapshot)
            ) {
                throw createAbortError('Revision PDF đã thay đổi.');
            }
        };

        assertCurrent();
        return Object.freeze({
            fileId: upload.fileId,
            snapshot: cloneImmutableSnapshot(upload.snapshot),
            assertCurrent,
        });
    };

    const attachCaller = (
        active: ActiveUpload,
        signal?: AbortSignal,
    ): Promise<RevisionScopedPdfUploadLease> => {
        const removeAbortForwarder = forwardAbortSignal(signal, active.controller);
        return active.promise
            .then(upload => createLease(upload, signal))
            .finally(removeAbortForwarder);
    };

    const ensureLease = async (
        signal?: AbortSignal,
    ): Promise<RevisionScopedPdfUploadLease> => {
        signal?.throwIfAborted();
        await options.resolver.prepare();
        signal?.throwIfAborted();

        const snapshot = options.resolver.capture();
        if (!snapshot) {
            throw options.missingFileError?.()
                ?? new Error('Không có file PDF để chuẩn bị.');
        }

        if (
            cachedUpload
            && sameRevision(cachedUpload.snapshot, snapshot)
            && options.resolver.isCurrent(cachedUpload.snapshot)
        ) {
            return createLease(cachedUpload, signal);
        }

        if (
            activeUpload
            && !activeUpload.controller.signal.aborted
            && sameRevision(activeUpload.snapshot, snapshot)
            && options.resolver.isCurrent(activeUpload.snapshot)
        ) {
            return attachCaller(activeUpload, signal);
        }

        if (cachedUpload || activeUpload) invalidate();

        const controller = new AbortController();
        const requestGeneration = ++generation;
        const request = {
            snapshot,
            generation: requestGeneration,
            controller,
            promise: Promise.resolve({
                snapshot,
                fileId: '',
                generation: requestGeneration,
            }),
        } satisfies ActiveUpload;

        const assertCurrent = () => {
            if (
                controller.signal.aborted
                || requestGeneration !== generation
                || !options.resolver.isCurrent(snapshot)
            ) {
                if (!controller.signal.aborted) {
                    controller.abort(createAbortError('Revision PDF đã thay đổi.'));
                }
                throw abortReason(controller, 'Revision PDF đã thay đổi.');
            }
        };

        request.promise = (async () => {
            const workingFile = await options.resolver.materialize(snapshot);
            assertCurrent();

            const uploaded = await options.upload(workingFile, {
                signal: controller.signal,
            });
            assertCurrent();
            if (!uploaded.id) throw new Error('Backend không trả về file_id.');

            // Chốt lần cuối ngay sát publish. Mock/test có thể cố tình bỏ qua abort,
            // nên không được dựa riêng vào việc fetch có tuân thủ AbortSignal hay không.
            assertCurrent();
            options.publish?.(uploaded.id, snapshot);
            assertCurrent();
            const completed = {
                snapshot,
                fileId: uploaded.id,
                generation: requestGeneration,
            } satisfies CachedUpload;
            cachedUpload = completed;
            return completed;
        })().finally(() => {
            if (activeUpload === request) activeUpload = null;
        });

        activeUpload = request;
        return attachCaller(request, signal);
    };

    const ensure = async (signal?: AbortSignal): Promise<string> => (
        await ensureLease(signal)
    ).fileId;

    return {
        ensure,
        ensureLease,
        invalidate,
        dispose: () => invalidate(createAbortError('Đã đóng tác vụ chuẩn bị PDF.')),
    };
}
