import { authenticatedFetch, getApiUrl } from './api';

export const ARTIFACT_LEASE_TOKEN_KEY = '__prynxArtifactLeaseToken' as const;
const ARTIFACT_LEASE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

type LeaseCarrier = Blob & { [ARTIFACT_LEASE_TOKEN_KEY]?: string };
export type ArtifactLeaseAction = 'claim' | 'renew' | 'release';
export type ArtifactLeaseTransport = (
    action: ArtifactLeaseAction,
    tabId: string,
    leaseTokens: readonly string[],
) => Promise<ReadonlySet<string>>;

export function readArtifactLeaseToken(value: Blob | null | undefined): string | undefined {
    const token = (value as LeaseCarrier | null | undefined)?.[ARTIFACT_LEASE_TOKEN_KEY];
    return typeof token === 'string' && ARTIFACT_LEASE_TOKEN_PATTERN.test(token)
        ? token
        : undefined;
}

export function tagArtifactLeaseToken<T extends Blob>(value: T, token?: string | null): T {
    if (!token || !ARTIFACT_LEASE_TOKEN_PATTERN.test(token)) return value;
    Object.defineProperty(value, ARTIFACT_LEASE_TOKEN_KEY, {
        value: token,
        configurable: true,
    });
    return value;
}

export function copyArtifactLeaseToken<T extends Blob>(source: Blob, target: T): T {
    return tagArtifactLeaseToken(target, readArtifactLeaseToken(source));
}

export function collectArtifactLeaseTokens(
    values: readonly (Blob | null | undefined)[],
): string[] {
    return [...new Set(values.map(readArtifactLeaseToken).filter((token): token is string => !!token))];
}

async function defaultArtifactLeaseTransport(
    action: ArtifactLeaseAction,
    tabId: string,
    leaseTokens: readonly string[],
): Promise<ReadonlySet<string>> {
    if (leaseTokens.length === 0) return new Set();
    const response = await authenticatedFetch(
        `${getApiUrl()}/artifacts/${action}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabId, leaseTokens }),
        },
    );
    if (!response.ok) throw new Error(`Không thể ${action} lease artifact (${response.status}).`);
    const payload = await response.json() as {
        results?: Array<{ leaseToken?: string; ok?: boolean }>;
    };
    return new Set(
        (payload.results || [])
            .filter(item => item.ok === true && typeof item.leaseToken === 'string')
            .map(item => item.leaseToken!),
    );
}

interface ArtifactLeaseOwnerOptions {
    transport?: ArtifactLeaseTransport;
    heartbeatMs?: number;
    retryMs?: number;
    onLeaseLost?: (token: string) => void;
}

/**
 * LIFECYCLE (audit 2026-08-25 §REV.11): một owner cho một tab. Sync nhận hợp
 * token của current + history; claim token mới trước khi release token cũ để
 * chuyển revision không tạo khe cleanup. Không dùng cờ global giữa nhiều tab.
 */
export class ArtifactLeaseOwner {
    private desired = new Set<string>();
    private claimed = new Set<string>();
    private queue: Promise<void> = Promise.resolve();
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    private readonly transport: ArtifactLeaseTransport;
    private readonly heartbeatMs: number;
    private readonly retryMs: number;
    private readonly onLeaseLost?: (token: string) => void;
    private readonly resumeHandler = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const pending = this.enqueue(() => this.renewClaimed());
        void pending.catch(() => this.scheduleRetry());
    };

    constructor(
        private readonly tabId: string,
        options: ArtifactLeaseOwnerOptions = {},
    ) {
        this.transport = options.transport ?? defaultArtifactLeaseTransport;
        this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 60_000);
        this.retryMs = Math.max(1_000, options.retryMs ?? 10_000);
        this.onLeaseLost = options.onLeaseLost;
        if (typeof window !== 'undefined') window.addEventListener('focus', this.resumeHandler);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this.resumeHandler);
        }
    }

    sync(tokens: readonly string[]): Promise<void> {
        if (this.disposed) return this.queue;
        this.desired = new Set(tokens.filter(token => ARTIFACT_LEASE_TOKEN_PATTERN.test(token)));
        const pending = this.enqueue(() => this.reconcile());
        // LIFECYCLE (audit 2026-08-25 §REV.11): backend có thể vừa khởi động lại
        // hoặc WebView mất kết nối ngắn. Giữ desired và tự claim lại; không chờ một
        // thay đổi React khác mới vô tình gọi sync lần nữa.
        void pending.catch(() => this.scheduleRetry());
        return pending;
    }

    dispose(): Promise<void> {
        if (this.disposed) return this.queue;
        this.disposed = true;
        this.desired.clear();
        this.stopHeartbeat();
        this.stopRetry();
        if (typeof window !== 'undefined') window.removeEventListener('focus', this.resumeHandler);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.resumeHandler);
        }
        return this.enqueue(async () => {
            const tokens = [...this.claimed];
            this.claimed.clear();
            if (tokens.length) await this.transport('release', this.tabId, tokens).catch(() => new Set());
        });
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const next = this.queue.then(operation, operation);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async reconcile(): Promise<void> {
        if (this.disposed) return;
        const additions = [...this.desired].filter(token => !this.claimed.has(token));
        if (additions.length) {
            const accepted = await this.transport('claim', this.tabId, additions);
            const releaseImmediately: string[] = [];
            for (const token of additions) {
                if (!accepted.has(token)) {
                    this.desired.delete(token);
                    this.onLeaseLost?.(token);
                } else if (this.disposed || !this.desired.has(token)) {
                    releaseImmediately.push(token);
                } else {
                    this.claimed.add(token);
                }
            }
            if (releaseImmediately.length) {
                await this.transport('release', this.tabId, releaseImmediately).catch(() => new Set());
            }
        }

        const removals = [...this.claimed].filter(token => !this.desired.has(token));
        if (removals.length) {
            await this.transport('release', this.tabId, removals).catch(() => new Set());
            for (const token of removals) this.claimed.delete(token);
        }
        this.stopRetry();
        this.updateHeartbeat();
    }

    private scheduleRetry(): void {
        if (this.disposed || this.retryTimer || this.desired.size === 0) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            const pending = this.enqueue(() => this.reconcile());
            void pending.catch(() => this.scheduleRetry());
        }, this.retryMs);
    }

    private stopRetry(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private updateHeartbeat(): void {
        if (this.disposed || this.claimed.size === 0) {
            this.stopHeartbeat();
            return;
        }
        if (this.heartbeat) return;
        this.heartbeat = setInterval(() => {
            const pending = this.enqueue(() => this.renewClaimed());
            void pending.catch(() => this.scheduleRetry());
        }, this.heartbeatMs);
    }

    private async renewClaimed(): Promise<void> {
        if (this.disposed || this.claimed.size === 0) return;
        const tokens = [...this.claimed];
        const renewed = await this.transport('renew', this.tabId, tokens);
        for (const token of tokens) {
            if (renewed.has(token)) continue;
            this.claimed.delete(token);
            this.desired.delete(token);
            this.onLeaseLost?.(token);
        }
        this.updateHeartbeat();
    }

    private stopHeartbeat(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
    }
}
