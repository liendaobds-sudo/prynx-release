import { describe, expect, it, vi } from 'vitest';
import {
    CancelledTileRenderError,
    INITIAL_TILE_LOAD_STATE,
    SupersededTileRenderError,
    TileRenderScheduler,
    TileRenderSchedulerUnavailableError,
    isTileLoadCancellation,
    tileLoadReducer,
} from './tileRenderScheduler';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

describe('TileRenderScheduler', () => {
    it('ưu tiên tile đang xem dù được đưa vào sau render nền', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const order: string[] = [];
        const enqueue = (requestKey: string, priority: number) => scheduler.enqueue({
            requestKey,
            groupKey: requestKey,
            ownerId: 'tab-1',
            priority,
            run: async () => {
                order.push(requestKey);
                return requestKey;
            },
        });

        await Promise.all([
            enqueue('page-8', 108),
            enqueue('page-3', 103),
            enqueue('active-tile', 0),
        ]);

        expect(order).toEqual(['active-tile', 'page-3', 'page-8']);
    });

    it('cho yêu cầu tương tác chen lên ngay sau tác vụ đang chạy', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const gate = deferred<string>();
        const order: string[] = [];
        const running = scheduler.enqueue({
            requestKey: 'running',
            groupKey: 'running',
            ownerId: 'tab-1',
            priority: 100,
            run: async () => {
                order.push('running');
                return gate.promise;
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        const background = scheduler.enqueue({
            requestKey: 'background',
            groupKey: 'background',
            ownerId: 'tab-1',
            priority: 100,
            run: async () => {
                order.push('background');
                return 'background';
            },
        });
        const interactive = scheduler.enqueue({
            requestKey: 'interactive',
            groupKey: 'interactive',
            ownerId: 'tab-1',
            priority: 0,
            run: async () => {
                order.push('interactive');
                return 'interactive';
            },
        });

        gate.resolve('running');
        await Promise.all([running, background, interactive]);
        expect(order).toEqual(['running', 'interactive', 'background']);
    });

    it('loại yêu cầu zoom cũ còn nằm trong cùng nhóm', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const gate = deferred<string>();
        const blocker = scheduler.enqueue({
            requestKey: 'blocker',
            groupKey: 'blocker',
            ownerId: 'tab-1',
            priority: 0,
            run: () => gate.promise,
        });
        await Promise.resolve();
        await Promise.resolve();

        const oldRun = vi.fn(async () => 'old');
        const oldRequest = scheduler.enqueue({
            requestKey: 'page-1@1.0',
            groupKey: 'page-1',
            ownerId: 'tab-1',
            priority: 100,
            run: oldRun,
        });
        const oldOutcome = oldRequest.catch((error) => error);
        const newRequest = scheduler.enqueue({
            requestKey: 'page-1@2.0',
            groupKey: 'page-1',
            ownerId: 'tab-1',
            priority: 10,
            run: async () => 'new',
        });

        gate.resolve('blocker');
        await blocker;
        expect(await oldOutcome).toBeInstanceOf(SupersededTileRenderError);
        await expect(newRequest).resolves.toBe('new');
        expect(oldRun).not.toHaveBeenCalled();
    });

    it('gộp yêu cầu trùng và nâng mức ưu tiên của bản đang chờ', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const run = vi.fn(async () => 'same');
        const first = scheduler.enqueue({
            requestKey: 'same',
            groupKey: 'same',
            ownerId: 'tab-1',
            priority: 100,
            run,
        });
        const duplicate = scheduler.enqueue({
            requestKey: 'same',
            groupKey: 'same',
            ownerId: 'tab-1',
            priority: 0,
            run,
        });

        expect(duplicate).toBe(first);
        await expect(first).resolves.toBe('same');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('hủy toàn bộ công việc nền chưa chạy khi viewer đóng hoặc đổi file', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const gate = deferred<string>();
        const blocker = scheduler.enqueue({
            requestKey: 'blocker',
            groupKey: 'blocker',
            ownerId: 'other-tab',
            priority: 0,
            run: () => gate.promise,
        });
        await Promise.resolve();
        await Promise.resolve();

        const queued = scheduler.enqueue({
            requestKey: 'queued',
            groupKey: 'queued',
            ownerId: 'tab-1',
            priority: 100,
            run: async () => 'queued',
        });
        const outcome = queued.catch((error) => error);
        scheduler.cancelOwner('tab-1');
        expect(await outcome).toBeInstanceOf(CancelledTileRenderError);

        gate.resolve('blocker');
        await blocker;
    });
    it('huy rieng nhom da ra khoi vung lan can', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const gate = deferred<string>();
        const blocker = scheduler.enqueue({
            requestKey: 'blocker',
            groupKey: 'blocker',
            ownerId: 'other-tab',
            priority: 0,
            run: () => gate.promise,
        });
        await Promise.resolve();
        await Promise.resolve();

        const queued = scheduler.enqueue({
            requestKey: 'page-8@0.35',
            groupKey: 'page-8',
            ownerId: 'tab-1',
            priority: 100,
            run: async () => 'page-8',
        });
        const outcome = queued.catch((error) => error);
        scheduler.cancelGroup('tab-1', 'page-8');
        expect(await outcome).toBeInstanceOf(CancelledTileRenderError);

        gate.resolve('blocker');
        await blocker;
    });
    it('giu sharp cua trang active truoc coarse prefetch', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const order: string[] = [];
        const coarse = scheduler.enqueue({
            requestKey: 'active-coarse',
            groupKey: 'active',
            ownerId: 'tab-1',
            priority: 10,
            run: async () => {
                order.push('active-coarse');
                return 'bytes';
            },
        });
        const tileUrl = (async () => {
            const bytes = await coarse;
            await Promise.resolve();
            return bytes;
        })();
        const sharp = tileUrl.then(() => scheduler.enqueue({
            requestKey: 'active-sharp',
            groupKey: 'active',
            ownerId: 'tab-1',
            priority: 10,
            run: async () => {
                order.push('active-sharp');
                return 'sharp';
            },
        }));
        const background = scheduler.enqueue({
            requestKey: 'prefetch-coarse',
            groupKey: 'prefetch',
            ownerId: 'tab-1',
            priority: 100,
            run: async () => {
                order.push('prefetch-coarse');
                return 'prefetch';
            },
        });

        await Promise.all([sharp, background]);
        expect(order).toEqual(['active-coarse', 'active-sharp', 'prefetch-coarse']);
    });
    it('giữ slot vật lý qua hot-reload cho tới khi task cũ thật sự kết thúc', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const oldGate = deferred<string>();
        const nextGate = deferred<string>();
        const nextStarted = deferred<void>();
        const order: string[] = [];

        const oldTask = scheduler.enqueue({
            requestKey: 'old-running',
            groupKey: 'old-running',
            ownerId: 'old-tab',
            priority: 0,
            run: async () => {
                order.push('old-running');
                return oldGate.promise;
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        const staleQueued = scheduler.enqueue({
            requestKey: 'stale-queued',
            groupKey: 'stale-queued',
            ownerId: 'old-tab',
            priority: 100,
            run: async () => 'stale-queued',
        });
        const staleOutcome = staleQueued.catch((error) => error);

        const oldOutcome = oldTask.catch((error) => error);
        scheduler.prepareForHotReload();
        expect(await oldOutcome).toBeInstanceOf(CancelledTileRenderError);
        expect(await staleOutcome).toBeInstanceOf(CancelledTileRenderError);

        const blockedRun = vi.fn(async () => 'blocked');
        const blockedOutcome = scheduler.enqueue({
            requestKey: 'blocked-during-hmr',
            groupKey: 'blocked-during-hmr',
            ownerId: 'new-tab',
            priority: 0,
            run: blockedRun,
        }).catch((error) => error);
        expect(await blockedOutcome).toBeInstanceOf(TileRenderSchedulerUnavailableError);
        expect(blockedRun).not.toHaveBeenCalled();
        expect(order).toEqual(['old-running']);

        oldGate.resolve('old-running');
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const nextTask = scheduler.enqueue({
            requestKey: 'next-running',
            groupKey: 'next-running',
            ownerId: 'new-tab',
            priority: 0,
            run: async () => {
                order.push('next-running');
                nextStarted.resolve();
                return nextGate.promise;
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await nextStarted.promise;
        expect(order).toEqual(['old-running', 'next-running']);

        const afterTask = scheduler.enqueue({
            requestKey: 'after',
            groupKey: 'after',
            ownerId: 'new-tab',
            priority: 10,
            run: async () => {
                order.push('after');
                return 'after';
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(['old-running', 'next-running']);

        nextGate.resolve('next-running');
        await Promise.all([nextTask, afterTask]);
        expect(order).toEqual(['old-running', 'next-running', 'after']);
    });

    it('hủy caller đang chạy nhưng không mở task kế tiếp trước khi nền thật sự kết thúc', async () => {
        const scheduler = new TileRenderScheduler<string>();
        const oldGate = deferred<string>();
        const order: string[] = [];
        const oldTask = scheduler.enqueue({
            requestKey: 'old-running',
            groupKey: 'old-running',
            ownerId: 'old-tab',
            priority: 100,
            run: async () => {
                order.push('old-running');
                return oldGate.promise;
            },
        });
        const oldOutcome = oldTask.catch((error) => error);
        await Promise.resolve();
        await Promise.resolve();

        scheduler.cancelOwner('old-tab');
        expect(await oldOutcome).toBeInstanceOf(CancelledTileRenderError);

        const nextTask = scheduler.enqueue({
            requestKey: 'next',
            groupKey: 'next',
            ownerId: 'new-tab',
            priority: 0,
            run: async () => {
                order.push('next');
                return 'next';
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(['old-running']);

        oldGate.resolve('old-running');
        await expect(nextTask).resolves.toBe('next');
        expect(order).toEqual(['old-running', 'next']);
    });
});

describe('first-tile load state', () => {
    it('không cho callback cũ ghi đè lần retry mới', () => {
        const loadingFirst = tileLoadReducer(INITIAL_TILE_LOAD_STATE, { type: 'start', attempt: 1 });
        const slowFirst = tileLoadReducer(loadingFirst, { type: 'slow', attempt: 1 });
        expect(slowFirst.phase).toBe('slow');

        const loadingRetry = tileLoadReducer(slowFirst, { type: 'start', attempt: 2 });
        const staleReady = tileLoadReducer(loadingRetry, { type: 'ready', attempt: 1 });
        expect(staleReady).toBe(loadingRetry);

        const failedRetry = tileLoadReducer(staleReady, { type: 'error', attempt: 2 });
        expect(failedRetry).toEqual({ phase: 'error', attempt: 2 });
    });

    it('nhận diện cancel cả khi Error đến từ phiên bản module trước HMR', () => {
        expect(isTileLoadCancellation(new CancelledTileRenderError())).toBe(true);
        expect(isTileLoadCancellation({ name: 'SupersededTileRenderError' })).toBe(true);
        expect(isTileLoadCancellation(new TileRenderSchedulerUnavailableError())).toBe(false);
    });
});
