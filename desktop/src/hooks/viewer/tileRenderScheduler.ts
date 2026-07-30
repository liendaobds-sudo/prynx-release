export class SupersededTileRenderError extends Error {
    constructor() {
        super('Yêu cầu dựng hình đã được thay bằng yêu cầu mới hơn');
        this.name = 'SupersededTileRenderError';
    }
}

export class CancelledTileRenderError extends Error {
    constructor() {
        super('Yêu cầu dựng hình đã bị hủy');
        this.name = 'CancelledTileRenderError';
    }
}

export interface TileRenderTask<T> {
    requestKey: string;
    groupKey: string;
    ownerId: string;
    priority: number;
    run: () => Promise<T>;
}

interface ScheduledTask<T> extends TileRenderTask<T> {
    sequence: number;
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    state: 'queued' | 'running';
}

/**
 * PERF (audit 2026-07-29 §R.10): sắp hàng ở frontend trước khóa PDFium toàn cục.
 *
 * `maxConcurrent=1` không làm giảm công suất render: native vốn serialize mọi lần
 * PDFium bằng RENDER_LOCK. Nó chỉ ngăn nhiều invoke nền chiếm chỗ trước tile đang xem.
 */
export class TileRenderScheduler<T> {
    private readonly queued: ScheduledTask<T>[] = [];
    private readonly byRequestKey = new Map<string, ScheduledTask<T>>();
    private activeCount = 0;
    private sequence = 0;
    private pumpScheduled = false;
    private pumpTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly maxConcurrent = 1) {
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
            throw new Error('maxConcurrent phải là số nguyên dương');
        }
    }

    enqueue(input: TileRenderTask<T>): Promise<T> {
        const duplicate = this.byRequestKey.get(input.requestKey);
        if (duplicate) {
            duplicate.priority = Math.min(duplicate.priority, input.priority);
            this.schedulePump();
            return duplicate.promise;
        }

        this.rejectQueuedGroup(input.ownerId, input.groupKey, new SupersededTileRenderError());

        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((accept, decline) => {
            resolve = accept;
            reject = decline;
        });
        const task: ScheduledTask<T> = {
            ...input,
            sequence: this.sequence++,
            promise,
            resolve,
            reject,
            state: 'queued',
        };
        this.queued.push(task);
        this.byRequestKey.set(task.requestKey, task);
        this.schedulePump();
        return promise;
    }

    cancelOwner(ownerId: string): void {
        this.rejectQueuedOwner(ownerId, new CancelledTileRenderError());
    }

    cancelGroup(ownerId: string, groupKey: string): void {
        this.rejectQueuedGroup(ownerId, groupKey, new CancelledTileRenderError());
    }

    private rejectQueuedGroup(ownerId: string, groupKey: string, reason: Error): void {
        for (let index = this.queued.length - 1; index >= 0; index -= 1) {
            const task = this.queued[index];
            if (task.ownerId !== ownerId || task.groupKey !== groupKey) continue;
            this.queued.splice(index, 1);
            this.byRequestKey.delete(task.requestKey);
            task.reject(reason);
        }
    }

    private rejectQueuedOwner(ownerId: string, reason: Error): void {
        for (let index = this.queued.length - 1; index >= 0; index -= 1) {
            const task = this.queued[index];
            if (task.ownerId !== ownerId) continue;
            this.queued.splice(index, 1);
            this.byRequestKey.delete(task.requestKey);
            task.reject(reason);
        }
    }

    private schedulePump(): void {
        if (this.pumpTimer !== null) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        if (this.pumpScheduled) return;
        this.pumpScheduled = true;
        queueMicrotask(() => {
            this.pumpScheduled = false;
            this.pump();
        });
    }

    // PERF (audit 2026-07-29 §R.10): sau task foreground, nhường một vòng sự kiện
    // để chuỗi coarse → blob URL → sharp kịp enqueue. Nếu bơm bằng microtask ngay,
    // prefetch đã chờ sẵn sẽ chiếm PDFium trước sharp dù có priority thấp hơn.
    private schedulePumpAfterForeground(): void {
        if (this.pumpScheduled || this.pumpTimer !== null) return;
        this.pumpTimer = setTimeout(() => {
            this.pumpTimer = null;
            this.schedulePump();
        }, 0);
    }

    private pump(): void {
        while (this.activeCount < this.maxConcurrent && this.queued.length > 0) {
            this.queued.sort((left, right) =>
                left.priority - right.priority || left.sequence - right.sequence
            );
            const task = this.queued.shift();
            if (!task) return;

            task.state = 'running';
            this.activeCount += 1;
            Promise.resolve()
                .then(task.run)
                .then(task.resolve, task.reject)
                .finally(() => {
                    this.activeCount -= 1;
                    if (this.byRequestKey.get(task.requestKey) === task) {
                        this.byRequestKey.delete(task.requestKey);
                    }
                    if (task.priority < 100) {
                        this.schedulePumpAfterForeground();
                    } else {
                        this.schedulePump();
                    }
                });
        }
    }
}

export const nativeTileRenderScheduler = new TileRenderScheduler<ArrayBuffer>(1);
