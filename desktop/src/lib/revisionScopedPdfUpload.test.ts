import { describe, expect, it, vi } from 'vitest';

import type {
    WorkingPdfResolver,
    WorkingPdfRevisionSnapshot,
} from '../hooks/useWorkingPdf';
import { createRevisionScopedPdfUploadCache } from './revisionScopedPdfUpload';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function cloneSnapshot(
    snapshot: WorkingPdfRevisionSnapshot,
): WorkingPdfRevisionSnapshot {
    return Object.freeze({
        ...snapshot,
        viewerPageOrder: snapshot.viewerPageOrder
            ? Object.freeze([...snapshot.viewerPageOrder])
            : undefined,
        viewerPageInstanceIds: snapshot.viewerPageInstanceIds
            ? Object.freeze([...snapshot.viewerPageInstanceIds])
            : undefined,
        viewerPageRotations: snapshot.viewerPageRotations
            ? Object.freeze([...snapshot.viewerPageRotations])
            : undefined,
    });
}

function sameSnapshot(
    left: WorkingPdfRevisionSnapshot,
    right: WorkingPdfRevisionSnapshot,
): boolean {
    const sameArray = <T>(
        a: readonly T[] | undefined,
        b: readonly T[] | undefined,
    ) => a === b || (
        !!a
        && !!b
        && a.length === b.length
        && a.every((value, index) => Object.is(value, b[index]))
    );
    return left.file === right.file
        && left.editGeneration === right.editGeneration
        && sameArray(left.viewerPageOrder, right.viewerPageOrder)
        && sameArray(left.viewerPageInstanceIds, right.viewerPageInstanceIds)
        && sameArray(left.viewerPageRotations, right.viewerPageRotations);
}

function createResolverHarness() {
    const sourceFile = new File(['source'], 'source.pdf', {
        type: 'application/pdf',
    });
    let current = cloneSnapshot({
        file: sourceFile,
        viewerPageOrder: [1, 2],
        viewerPageInstanceIds: ['page-a', 'page-b'],
        viewerPageRotations: [0, 0],
        editGeneration: 0,
    });

    const resolver = Object.assign(
        vi.fn(async () => current.file),
        {
            prepare: vi.fn(async () => undefined),
            resolveUnprepared: vi.fn(async () => current.file),
            capture: vi.fn(() => cloneSnapshot(current)),
            materialize: vi.fn(async (snapshot: WorkingPdfRevisionSnapshot) => (
                new File(
                    [`working-${snapshot.editGeneration}`],
                    snapshot.file.name,
                    { type: 'application/pdf' },
                )
            )),
            isCurrent: vi.fn((snapshot: WorkingPdfRevisionSnapshot) => (
                sameSnapshot(snapshot, current)
            )),
        },
    ) as WorkingPdfResolver;

    return {
        resolver,
        current: () => current,
        setCurrent: (updates: Partial<WorkingPdfRevisionSnapshot>) => {
            current = cloneSnapshot({ ...current, ...updates });
        },
    };
}

describe('revisionScopedPdfUpload', () => {
    it('dedupe request đang bay và cache file_id của cùng immutable revision', async () => {
        const harness = createResolverHarness();
        const uploadGate = deferred<{ id: string }>();
        const upload = vi.fn(() => uploadGate.promise);
        const publish = vi.fn();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload,
            publish,
        });

        const first = cache.ensure();
        const second = cache.ensure();
        await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
        uploadGate.resolve({ id: 'revision-a' });

        await expect(Promise.all([first, second])).resolves.toEqual([
            'revision-a',
            'revision-a',
        ]);
        await expect(cache.ensure()).resolves.toBe('revision-a');
        expect(upload).toHaveBeenCalledTimes(1);
        expect(harness.resolver.materialize).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledTimes(1);
    });

    it('upload lại khi order, rotation hoặc edit generation đổi revision', async () => {
        const harness = createResolverHarness();
        const upload = vi.fn()
            .mockResolvedValueOnce({ id: 'revision-a' })
            .mockResolvedValueOnce({ id: 'revision-b' });
        const publish = vi.fn();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload,
            publish,
        });

        await expect(cache.ensure()).resolves.toBe('revision-a');
        harness.setCurrent({
            viewerPageOrder: [2, 1],
            viewerPageInstanceIds: ['page-b', 'page-a'],
            viewerPageRotations: [90, 0],
            editGeneration: 1,
        });
        await expect(cache.ensure()).resolves.toBe('revision-b');

        expect(upload).toHaveBeenCalledTimes(2);
        expect(harness.resolver.materialize).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenNthCalledWith(
            2,
            'revision-b',
            expect.objectContaining({
                viewerPageOrder: [2, 1],
                viewerPageRotations: [90, 0],
                editGeneration: 1,
            }),
        );
    });

    it('invalidate hủy request đang bay, xóa cache và cho phép lượt mới', async () => {
        const harness = createResolverHarness();
        const staleUpload = deferred<{ id: string }>();
        let staleSignal: AbortSignal | undefined;
        const upload = vi.fn()
            .mockImplementationOnce((
                _file: File,
                options: { signal: AbortSignal },
            ) => {
                staleSignal = options.signal;
                return staleUpload.promise;
            })
            .mockResolvedValueOnce({ id: 'revision-fresh' });
        const publish = vi.fn();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload,
            publish,
        });

        const staleRequest = cache.ensure();
        await vi.waitFor(() => expect(staleSignal).toBeDefined());
        cache.invalidate();
        expect(staleSignal?.aborted).toBe(true);

        // Mock cố tình không reject khi signal abort để kiểm generation fence.
        staleUpload.resolve({ id: 'revision-stale' });
        await expect(staleRequest).rejects.toMatchObject({ name: 'AbortError' });
        expect(publish).not.toHaveBeenCalled();

        await expect(cache.ensure()).resolves.toBe('revision-fresh');
        expect(upload).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledOnce();
    });

    it('không publish response cũ khi revision đổi dù uploader bỏ qua AbortSignal', async () => {
        const harness = createResolverHarness();
        const staleUpload = deferred<{ id: string }>();
        const upload = vi.fn()
            .mockImplementationOnce(() => staleUpload.promise)
            .mockResolvedValueOnce({ id: 'revision-b' });
        const publish = vi.fn();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload,
            publish,
        });

        const staleRequest = cache.ensure();
        await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
        harness.setCurrent({
            viewerPageRotations: [0, 180],
            editGeneration: 1,
        });
        staleUpload.resolve({ id: 'revision-a-stale' });

        await expect(staleRequest).rejects.toMatchObject({ name: 'AbortError' });
        expect(publish).not.toHaveBeenCalled();

        await expect(cache.ensure()).resolves.toBe('revision-b');
        expect(publish).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledWith(
            'revision-b',
            expect.objectContaining({
                viewerPageRotations: [0, 180],
                editGeneration: 1,
            }),
        );
    });

    it('cấp lease riêng, bất biến và dùng lại upload cho cùng revision', async () => {
        const harness = createResolverHarness();
        const upload = vi.fn().mockResolvedValue({ id: 'revision-a' });
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload,
        });

        const first = await cache.ensureLease();
        const second = await cache.ensureLease();

        expect(first.fileId).toBe('revision-a');
        expect(second.fileId).toBe('revision-a');
        expect(upload).toHaveBeenCalledOnce();
        expect(first.snapshot).not.toBe(second.snapshot);
        expect(Object.isFrozen(first.snapshot)).toBe(true);
        expect(Object.isFrozen(first.snapshot.viewerPageOrder)).toBe(true);
        expect(() => {
            (first.snapshot.viewerPageOrder as number[])[0] = 99;
        }).toThrow();
        expect(second.snapshot.viewerPageOrder).toEqual([1, 2]);
        expect(() => first.assertCurrent()).not.toThrow();
        expect(() => second.assertCurrent()).not.toThrow();
    });

    it('lease hết hiệu lực khi revision đổi sau ensure', async () => {
        const harness = createResolverHarness();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload: vi.fn().mockResolvedValue({ id: 'revision-a' }),
        });
        const lease = await cache.ensureLease();

        harness.setCurrent({
            viewerPageRotations: [90, 0],
            editGeneration: 1,
        });

        expect(() => lease.assertCurrent()).toThrowError(
            expect.objectContaining({ name: 'AbortError' }),
        );
    });

    it('invalidate làm mọi lease đã cấp hết hiệu lực', async () => {
        const harness = createResolverHarness();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload: vi.fn().mockResolvedValue({ id: 'revision-a' }),
        });
        const lease = await cache.ensureLease();

        cache.invalidate();

        expect(() => lease.assertCurrent()).toThrowError(
            expect.objectContaining({ name: 'AbortError' }),
        );
    });

    it('lease kiểm signal kể cả khi upload đã hoàn tất', async () => {
        const harness = createResolverHarness();
        const cache = createRevisionScopedPdfUploadCache({
            resolver: harness.resolver,
            upload: vi.fn().mockResolvedValue({ id: 'revision-a' }),
        });
        const controller = new AbortController();
        const lease = await cache.ensureLease(controller.signal);
        const reason = new Error('Đã hủy lượt xử lý.');
        reason.name = 'AbortError';

        controller.abort(reason);

        expect(() => lease.assertCurrent()).toThrowError(
            expect.objectContaining({ name: 'AbortError' }),
        );
    });
});
