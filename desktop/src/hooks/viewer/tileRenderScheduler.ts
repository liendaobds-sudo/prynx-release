import { appVisibilityGate, type AppVisibilityGate } from '../../lib/appVisibility';

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

export class TileRenderSchedulerUnavailableError extends Error {
    constructor() {
        super('Bộ dựng hình đang chờ tác vụ cũ kết thúc');
        this.name = 'TileRenderSchedulerUnavailableError';
    }
}

export const FIRST_TILE_SLOW_MS = 8_000;
export type TileLoadPhase = 'idle' | 'loading' | 'slow' | 'ready' | 'error' | 'cancelled';
export interface TileLoadViewState {
    phase: TileLoadPhase;
    attempt: number;
}
export type TileLoadAction =
    | { type: 'start'; attempt: number }
    | { type: 'replace'; attempt: number; phase: TileLoadPhase }
    | { type: 'slow' | 'ready' | 'error' | 'cancelled'; attempt: number };

export const INITIAL_TILE_LOAD_STATE: TileLoadViewState = { phase: 'idle', attempt: 0 };

export function tileLoadReducer(state: TileLoadViewState, action: TileLoadAction): TileLoadViewState {
    if (action.type === 'start') return { phase: 'loading', attempt: action.attempt };
    if (action.type === 'replace') return { phase: action.phase, attempt: action.attempt };
    if (action.attempt !== state.attempt) return state;
    return { phase: action.type, attempt: action.attempt };
}

export function isTileLoadCancellation(error: unknown): boolean {
    if (error instanceof CancelledTileRenderError || error instanceof SupersededTileRenderError) return true;
    if (!error || typeof error !== 'object' || !('name' in error)) return false;
    const name = String((error as { name?: unknown }).name || '');
    // Fast Refresh có thể trả Error được tạo bởi phiên bản module cũ nên không chỉ dựa instanceof.
    return name === 'CancelledTileRenderError' || name === 'SupersededTileRenderError';
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
    lane: 'interactive' | 'background' | null;
}

/**
 * PERF (audit 2026-08-08 §RENDER.2): sắp hàng theo hai lane trước render worker.
 *
 * Native singleton dùng hai slot nhưng chỉ cho một background chạy, luôn chừa một slot để
 * request tương tác tới được worker manager và preempt nền trên máy ít RAM. Instance test/cũ
 * với `maxConcurrent=1` vẫn giữ đúng hành vi tuần tự trước đây.
 */
export class TileRenderScheduler<T> {
    private readonly queued: ScheduledTask<T>[] = [];
    private readonly byRequestKey = new Map<string, ScheduledTask<T>>();
    private activeCount = 0;
    private activeBackgroundCount = 0;
    private sequence = 0;
    private pumpScheduled = false;
    private pumpTimer: ReturnType<typeof setTimeout> | null = null;
    private foregroundUnsubscribe: (() => void) | null = null;
    private quarantined = false;

    constructor(
        private readonly maxConcurrent = 1,
        private readonly visibility: AppVisibilityGate = appVisibilityGate,
        private readonly maxBackgroundConcurrent = maxConcurrent === 1 ? 1 : maxConcurrent - 1,
    ) {
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
            throw new Error('maxConcurrent phải là số nguyên dương');
        }
        if (!Number.isInteger(maxBackgroundConcurrent)
            || maxBackgroundConcurrent < 1
            || maxBackgroundConcurrent > maxConcurrent) {
            throw new Error('maxBackgroundConcurrent phải nằm trong 1..maxConcurrent');
        }
    }

    enqueue(input: TileRenderTask<T>): Promise<T> {
        if (this.quarantined) {
            return Promise.reject(new TileRenderSchedulerUnavailableError());
        }
        const duplicate = this.byRequestKey.get(input.requestKey);
        if (duplicate) {
            if (input.priority < duplicate.priority) {
                duplicate.priority = input.priority;
                // PERF (audit 2026-08-08 §RENDER.2): preload và trang đang nhìn có thể
                // cùng pixel/resultKey. Nếu task còn chờ, phải thay cả closure để context
                // native thật sự đổi background → interactive, không chỉ đổi thứ tự JS.
                if (duplicate.state === 'queued') duplicate.run = input.run;
            }
            this.schedulePump();
            return duplicate.promise;
        }

        const superseded = new SupersededTileRenderError();
        this.rejectQueuedGroup(input.ownerId, input.groupKey, superseded);
        this.rejectRunningGroup(input.ownerId, input.groupKey, superseded);

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
            lane: null,
        };
        this.queued.push(task);
        this.byRequestKey.set(task.requestKey, task);
        this.schedulePump();
        return promise;
    }

    cancelOwner(ownerId: string): void {
        const reason = new CancelledTileRenderError();
        this.rejectQueuedOwner(ownerId, reason);
        this.rejectRunningOwner(ownerId, reason);
    }

    cancelGroup(ownerId: string, groupKey: string): void {
        const reason = new CancelledTileRenderError();
        this.rejectQueuedGroup(ownerId, groupKey, reason);
        this.rejectRunningGroup(ownerId, groupKey, reason);
    }

    /**
     * DEV (2026-08-02): dọn caller cũ trước HMR nhưng KHÔNG nhả slot của task đang chạy.
     * Lệnh native cũ vẫn có thể đang chạm PDFium; chỉ `finally` của chính lệnh đó mới được
     * giảm activeCount. Scheduler được giữ qua `import.meta.hot.data`, nên module mới không
     * tạo một hàng đợi thứ hai chạy song song với hàng đợi cũ.
     */
    prepareForHotReload(): void {
        const reason = new CancelledTileRenderError();
        this.quarantined = this.activeCount > 0;
        for (let index = this.queued.length - 1; index >= 0; index -= 1) {
            const task = this.queued[index];
            this.queued.splice(index, 1);
            this.byRequestKey.delete(task.requestKey);
            task.reject(reason);
        }
        for (const task of this.byRequestKey.values()) {
            if (task.state !== 'running') continue;
            this.byRequestKey.delete(task.requestKey);
            task.reject(reason);
        }
        if (this.pumpTimer !== null) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        this.foregroundUnsubscribe?.();
        this.foregroundUnsubscribe = null;
        this.pumpScheduled = false;
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

    /**
     * Chỉ kết thúc promise phía caller. Task vật lý vẫn giữ activeCount cho tới `finally`,
     * nên cancel/đổi zoom không bao giờ mở thêm một lời gọi PDFium song song.
     */
    private rejectRunningGroup(ownerId: string, groupKey: string, reason: Error): void {
        for (const task of this.byRequestKey.values()) {
            if (task.state !== 'running' || task.ownerId !== ownerId || task.groupKey !== groupKey) continue;
            this.byRequestKey.delete(task.requestKey);
            task.reject(reason);
        }
    }

    private rejectRunningOwner(ownerId: string, reason: Error): void {
        for (const task of this.byRequestKey.values()) {
            if (task.state !== 'running' || task.ownerId !== ownerId) continue;
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
        if (this.visibility.isBackgrounded()) {
            this.pauseUntilForeground();
            return;
        }
        while (this.activeCount < this.maxConcurrent && this.queued.length > 0) {
            this.queued.sort((left, right) =>
                left.priority - right.priority || left.sequence - right.sequence
            );
            const runnableIndex = this.queued.findIndex(task =>
                task.priority < 100 || this.activeBackgroundCount < this.maxBackgroundConcurrent
            );
            if (runnableIndex < 0) return;
            const [task] = this.queued.splice(runnableIndex, 1);
            if (!task) return;

            task.state = 'running';
            task.lane = task.priority < 100 ? 'interactive' : 'background';
            this.activeCount += 1;
            if (task.lane === 'background') this.activeBackgroundCount += 1;
            Promise.resolve()
                .then(task.run)
                .then(task.resolve, task.reject)
                .finally(() => {
                    this.activeCount -= 1;
                    if (task.lane === 'background') this.activeBackgroundCount -= 1;
                    if (this.activeCount === 0) this.quarantined = false;
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

    private pauseUntilForeground(): void {
        if (this.foregroundUnsubscribe !== null) return;

        const resume = () => {
            if (this.visibility.isBackgrounded()) return;
            const unsubscribe = this.foregroundUnsubscribe;
            this.foregroundUnsubscribe = null;
            unsubscribe?.();
            this.schedulePump();
        };
        this.foregroundUnsubscribe = this.visibility.subscribe(backgrounded => {
            if (!backgrounded) resume();
        });
        // Đóng race nếu foreground xảy ra giữa lần kiểm tra trong pump và lúc subscribe.
        resume();
    }
}

interface TileSchedulerHotData {
    nativeTileRenderScheduler?: TileRenderScheduler<ArrayBuffer>;
}

const schedulerHotData = import.meta.hot?.data as TileSchedulerHotData | undefined;
export const nativeTileRenderScheduler = schedulerHotData?.nativeTileRenderScheduler
    ?? new TileRenderScheduler<ArrayBuffer>(2);

if (schedulerHotData) schedulerHotData.nativeTileRenderScheduler = nativeTileRenderScheduler;

// DEV (2026-08-02): giữ MỘT scheduler qua Fast Refresh. Tạo singleton mới trong khi
// singleton cũ còn invoke native sẽ tạo hai hàng đợi cạnh tranh cùng worker manager.
if (import.meta.hot) {
    const prepareSchedulerForHotReload = () => nativeTileRenderScheduler.prepareForHotReload();
    import.meta.hot.on('vite:beforeUpdate', prepareSchedulerForHotReload);
    import.meta.hot.dispose((data) => {
        prepareSchedulerForHotReload();
        import.meta.hot?.off('vite:beforeUpdate', prepareSchedulerForHotReload);
        (data as TileSchedulerHotData).nativeTileRenderScheduler = nativeTileRenderScheduler;
    });
}
