import { describe, expect, it, vi } from 'vitest';
import {
    CancelledTileRenderError,
    SupersededTileRenderError,
    TileRenderScheduler,
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
});
