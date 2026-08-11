import { previewPerfLog } from '../../lib/previewPerfLog';
import type { TileUrlSource } from '../../lib/tileUrlCache';
import {
    nativeTileRenderScheduler,
    SupersededTileRenderError,
    type TileRenderScheduler,
} from './tileRenderScheduler';

export type RenderPurpose = 'interactive' | 'background' | 'accurate';
export type RenderColorPipeline = 'display' | 'accurate';
export type RenderSoundness = 'display-preview' | 'color-verified';

export interface RenderDocumentIdentity {
    path: string;
    /** Chuỗi để không làm tròn số nanosecond/u64 qua JavaScript Number. */
    sizeBytes: string;
    modifiedNanos: string;
    createdNanos: string;
    token: string;
}

export interface RenderClip {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface RenderCoordinatorRequestInput {
    ownerId: string;
    groupKey: string;
    /** Cùng token cho coarse → sharp → accurate của một lần hiển thị. */
    generationKey: string;
    purpose: RenderPurpose;
    priority: number;
    document: RenderDocumentIdentity;
    page: number;
    rotation: 0 | 90 | 180 | 270;
    raster:
        | { kind: 'scale'; scale: number; clip: RenderClip | null }
        | { kind: 'dpi'; dpi: number; clip: RenderClip | null };
    color: {
        pipeline: RenderColorPipeline;
        profileId: string | null;
        intent: string | null;
    };
    pipelineIdentity: string;
    soundness: RenderSoundness;
}

export interface RenderCoordinatorRequest extends RenderCoordinatorRequestInput {
    protocolVersion: 1;
    requestId: string;
    resultKey: string;
    requestKey: string;
    generation: number;
}

export interface RenderDecodeResult {
    width: number;
    height: number;
    current: boolean;
}

type RenderStatus = 'ready' | 'stale' | 'cancelled' | 'render-error' | 'decode-error';
type Clock = () => number;
type Reporter = (event: string, payload: Record<string, unknown>) => void | Promise<void>;
type PhysicalCanceller = (
    request: RenderCoordinatorRequest,
) => boolean | void | Promise<boolean | void>;

interface GroupState {
    generationKey: string;
    generation: number;
    traces: Set<RenderTrace>;
}

interface RenderTrace {
    request: RenderCoordinatorRequest;
    createdAt: number;
    enqueuedAt: number | null;
    runStartedAt: number | null;
    renderEndedAt: number | null;
    sourceReadyAt: number | null;
    decodeStartedAt: number | null;
    staleAt: number | null;
    queueMs: number;
    waitMs: number;
    sourceMs: number;
    decodeMs: number | null;
    staleMs: number;
    bitmapWidth: number | null;
    bitmapHeight: number | null;
    byteLength: number;
    coalesced: boolean;
    finalReported: boolean;
    staleWorkReported: boolean;
    physicalCancelSent: boolean;
}

export interface RenderPngOptions {
    request: RenderCoordinatorRequestInput;
    render: (request: RenderCoordinatorRequest) => Promise<ArrayBuffer>;
    encode: (bytes: ArrayBuffer, request: RenderCoordinatorRequest) => TileUrlSource;
    /** PPE có lane/process riêng, không được chặn hàng đợi PDFium display. */
    bypassScheduler?: boolean;
}

export interface RenderCoordinatorOptions {
    scheduler?: Pick<TileRenderScheduler<ArrayBuffer>, 'enqueue' | 'cancelOwner' | 'cancelGroup'>;
    now?: Clock;
    report?: Reporter;
    cancelPhysical?: PhysicalCanceller;
}

const DISPLAY_PIPELINE_ID = 'pdfium-display-png-v1';
const ACCURATE_PIPELINE_ID = 'ppe-fogra39-relative-view-knockout-png-v5-native-worker';
const documentIdentityRegistry = new Map<string, RenderDocumentIdentity>();

function nonNegativeIntegerString(value: unknown): string {
    if (typeof value === 'bigint' && value >= 0n) return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    return 'unknown';
}

function millisecondsToNanos(value: unknown): string {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'unknown';
    return (BigInt(value) * 1_000_000n).toString();
}

function resultKey(input: RenderCoordinatorRequestInput): string {
    const rasterValue = input.raster.kind === 'scale'
        ? ['scale', Number(input.raster.scale.toFixed(3))]
        : ['dpi', Math.round(input.raster.dpi)];
    return JSON.stringify([
        input.document.path,
        input.document.token,
        input.page,
        input.rotation,
        rasterValue,
        input.raster.clip
            ? [
                input.raster.clip.x,
                input.raster.clip.y,
                input.raster.clip.width,
                input.raster.clip.height,
            ]
            : null,
        input.color.pipeline,
        input.pipelineIdentity,
        input.color.profileId,
        input.color.intent,
    ]);
}

function nextRequestId(sequence: number): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `viewer-render-${Date.now().toString(36)}-${sequence}`;
}

function cancellationName(error: unknown): string | null {
    if (!error || typeof error !== 'object' || !('name' in error)) return null;
    const name = String((error as { name?: unknown }).name || '');
    return name === 'CancelledTileRenderError' || name === 'SupersededTileRenderError'
        ? name
        : null;
}

function defaultReporter(event: string, payload: Record<string, unknown>): void {
    void previewPerfLog(`render-coordinator-${event}`, payload);
}

async function defaultPhysicalCanceller(request: RenderCoordinatorRequest): Promise<void> {
    if (
        typeof window === 'undefined'
        || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        for (const delayMs of [0, 16, 50]) {
            if (delayMs > 0) {
                await new Promise(resolve => window.setTimeout(resolve, delayMs));
            }
            const cancelled = await invoke<boolean>('cancel_pdf_render', {
                requestId: request.requestId,
            });
            if (cancelled) return;
        }
    } catch {
        // Worker mode off/đang restart: scheduler vẫn giữ bất biến slot vật lý như trước.
    }
}

export function renderDocumentIdentity(
    path: string,
    file: {
        size?: unknown;
        lastModified?: unknown;
        createdMs?: unknown;
        ctimeMs?: unknown;
        fileIdentity?: unknown;
    } | null | undefined,
    identityToken?: string | null,
): RenderDocumentIdentity {
    const suppliedToken = identityToken
        || (typeof file?.fileIdentity === 'string' && file.fileIdentity ? file.fileIdentity : null);
    const [tokenSize, tokenModified, tokenCreated] = suppliedToken?.split(':') ?? [];
    const sizeBytes = nonNegativeIntegerString(tokenSize ?? file?.size);
    const modifiedNanos = nonNegativeIntegerString(tokenModified);
    const createdNanos = nonNegativeIntegerString(tokenCreated);
    const fallbackModifiedNanos = modifiedNanos === 'unknown'
        ? millisecondsToNanos(file?.lastModified)
        : modifiedNanos;
    const fallbackCreatedNanos = createdNanos === 'unknown'
        ? millisecondsToNanos(file?.createdMs ?? file?.ctimeMs)
        : createdNanos;
    const token = suppliedToken
        ?? `${sizeBytes}:${fallbackModifiedNanos}:${fallbackCreatedNanos}`;
    return {
        path,
        sizeBytes,
        modifiedNanos: fallbackModifiedNanos,
        createdNanos: fallbackCreatedNanos,
        token,
    };
}

export function registerRenderDocumentIdentity(path: string, identityToken: string): void {
    if (!path || !identityToken) return;
    documentIdentityRegistry.set(path, renderDocumentIdentity(path, null, identityToken));
}

export function getRenderDocumentIdentity(
    path: string,
    file: Parameters<typeof renderDocumentIdentity>[1],
): RenderDocumentIdentity {
    return documentIdentityRegistry.get(path) ?? renderDocumentIdentity(path, file);
}

export function renderPurpose(priority: number, colorPipeline: RenderColorPipeline): RenderPurpose {
    if (colorPipeline === 'accurate') return 'accurate';
    return priority < 100 ? 'interactive' : 'background';
}

export function renderPipelineIdentity(
    colorPipeline: RenderColorPipeline,
    profileId = 'fogra39',
    intent = 'relative',
): string {
    if (colorPipeline === 'display') return DISPLAY_PIPELINE_ID;
    const normalizedProfile = (profileId || 'fogra39').trim().toLowerCase();
    const normalizedIntent = (intent || 'relative').trim().toLowerCase();
    if (normalizedProfile === 'fogra39' && normalizedIntent === 'relative') {
        return ACCURATE_PIPELINE_ID;
    }
    // PREFLIGHT (audit 2026-08-10 §OP.8): identity phải mang đủ Simulation;
    // bitmap SWOP/Perceptual không được đồng khóa với FOGRA39/Relative.
    return `ppe-${normalizedProfile}-${normalizedIntent}-view-knockout-png-v5-backend`;
}

export function normalizeRenderRotation(rotation: number): 0 | 90 | 180 | 270 {
    const normalized = ((Math.round(rotation) % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/**
 * PERF (audit 2026-08-08 §RENDER.2): nguồn sự thật duy nhất cho identity/generation/timing
 * của Viewer. Lô này vẫn dùng transport in-process; contract giữ nguyên khi chuyển sang
 * display worker ở Lô 6, nên có thể so parity trước/sau mà không đổi compositor.
 */
export class RenderCoordinator {
    private readonly scheduler: Pick<
        TileRenderScheduler<ArrayBuffer>,
        'enqueue' | 'cancelOwner' | 'cancelGroup'
    >;
    private readonly now: Clock;
    private readonly report: Reporter;
    private readonly cancelPhysical: PhysicalCanceller;
    private readonly groups = new Map<string, GroupState>();
    private readonly sourceTraces = new WeakMap<object, RenderTrace>();
    private sequence = 0;

    constructor(options: RenderCoordinatorOptions = {}) {
        this.scheduler = options.scheduler ?? nativeTileRenderScheduler;
        this.now = options.now ?? (() => performance.now());
        this.report = options.report ?? defaultReporter;
        this.cancelPhysical = options.cancelPhysical ?? defaultPhysicalCanceller;
    }

    async renderPng(options: RenderPngOptions): Promise<TileUrlSource> {
        const trace = this.begin(options.request);
        const run = async (): Promise<ArrayBuffer> => {
            const runStartedAt = this.now();
            trace.runStartedAt = runStartedAt;
            trace.queueMs = Math.max(0, runStartedAt - trace.createdAt);
            try {
                return await options.render(trace.request);
            } finally {
                const renderEndedAt = this.now();
                trace.renderEndedAt = renderEndedAt;
                // Adapter raw hiện tại chỉ biết round-trip tới khi nhận đủ PNG bytes.
                // render_ms/encode_ms thật vẫn do Rust log; không suy diễn số giả ở đây.
                trace.waitMs = Math.max(0, renderEndedAt - runStartedAt);
                this.reportStalePhysicalWork(trace);
            }
        };

        trace.enqueuedAt = this.now();

        let bytes: ArrayBuffer;
        try {
            if (options.bypassScheduler) {
                bytes = await run();
            } else {
                bytes = await this.scheduler.enqueue({
                    requestKey: trace.request.requestKey,
                    groupKey: trace.request.groupKey,
                    ownerId: trace.request.ownerId,
                    priority: trace.request.priority,
                    run,
                });
                // Cùng request vật lý có thể được nhiều caller chờ. Caller được gộp không
                // chạy closure `run`, nhưng vẫn nhận đúng bytes và được đánh dấu rõ khi đo.
                if (trace.runStartedAt === null) {
                    trace.coalesced = true;
                    trace.queueMs = Math.max(0, this.now() - trace.createdAt);
                }
            }
        } catch (error) {
            const cancelled = cancellationName(error);
            this.reportFinal(trace, cancelled ? 'cancelled' : 'render-error', {
                error_name: cancelled ?? (error instanceof Error ? error.name : typeof error),
            });
            throw error;
        }

        // Generation cũ tuyệt đối không được tạo Blob/decode/composite, kể cả khi transport
        // không hủy vật lý và vẫn trả PNG sau request mới.
        if (!this.isLatest(trace)) {
            if (trace.staleAt === null) trace.staleAt = this.now();
            this.reportFinal(trace, 'stale');
            throw new SupersededTileRenderError();
        }

        const sourceStartedAt = this.now();
        let source: TileUrlSource;
        try {
            source = options.encode(bytes, trace.request);
        } catch (error) {
            trace.sourceMs = Math.max(0, this.now() - sourceStartedAt);
            this.reportFinal(trace, 'render-error', {
                error_name: error instanceof Error ? error.name : typeof error,
                error_stage: 'source',
            });
            throw error;
        }
        trace.sourceMs = Math.max(0, this.now() - sourceStartedAt);
        trace.sourceReadyAt = this.now();
        trace.byteLength = source.byteLength;
        this.sourceTraces.set(source, trace);
        return source;
    }

    markDecodeStarted(source: TileUrlSource): void {
        const trace = this.sourceTraces.get(source);
        if (!trace || trace.finalReported) return;
        trace.decodeStartedAt = this.now();
    }

    isSourceCurrent(source: TileUrlSource): boolean {
        const trace = this.sourceTraces.get(source);
        return !trace || (!trace.finalReported && this.isLatest(trace));
    }

    markDecoded(source: TileUrlSource, result: RenderDecodeResult): void {
        const trace = this.sourceTraces.get(source);
        if (!trace || trace.finalReported) return;
        const endedAt = this.now();
        const startedAt = trace.decodeStartedAt ?? trace.sourceReadyAt ?? endedAt;
        trace.decodeMs = Math.max(0, endedAt - startedAt);
        trace.bitmapWidth = Number.isFinite(result.width) && result.width >= 0 ? result.width : null;
        trace.bitmapHeight = Number.isFinite(result.height) && result.height >= 0 ? result.height : null;
        const current = result.current && this.isLatest(trace);
        this.reportFinal(trace, current ? 'ready' : 'stale');
    }

    markDecodeFailed(source: TileUrlSource): void {
        const trace = this.sourceTraces.get(source);
        if (!trace || trace.finalReported) return;
        const endedAt = this.now();
        const startedAt = trace.decodeStartedAt ?? trace.sourceReadyAt ?? endedAt;
        trace.decodeMs = Math.max(0, endedAt - startedAt);
        this.reportFinal(trace, 'decode-error');
    }

    markDiscarded(source: TileUrlSource): void {
        const trace = this.sourceTraces.get(source);
        if (!trace || trace.finalReported) return;
        if (trace.staleAt === null) trace.staleAt = trace.sourceReadyAt ?? this.now();
        this.reportFinal(trace, 'stale');
    }

    cancelOwner(ownerId: string): void {
        this.scheduler.cancelOwner(ownerId);
        const prefix = `${ownerId}\u0000`;
        const cancelledAt = this.now();
        for (const [scopeKey, group] of this.groups) {
            if (!scopeKey.startsWith(prefix)) continue;
            for (const trace of group.traces) {
                if (!trace.finalReported && trace.staleAt === null) {
                    trace.staleAt = cancelledAt;
                    this.cancelStalePhysicalWork(trace);
                }
            }
            this.groups.delete(scopeKey);
        }
    }

    cancelGroup(ownerId: string, groupKey: string): void {
        this.scheduler.cancelGroup(ownerId, groupKey);
        const scopeKey = `${ownerId}\u0000${groupKey}`;
        const group = this.groups.get(scopeKey);
        if (!group) return;
        const cancelledAt = this.now();
        for (const trace of group.traces) {
            if (!trace.finalReported && trace.staleAt === null) {
                trace.staleAt = cancelledAt;
                this.cancelStalePhysicalWork(trace);
            }
        }
        group.traces.clear();
        // Giữ tombstone để generation kế tiếp tiếp tục tăng, không quay về 1 sau retry/unmount.
        group.generationKey = `__cancelled__:${++this.sequence}`;
    }

    private begin(input: RenderCoordinatorRequestInput): RenderTrace {
        const createdAt = this.now();
        const scopeKey = `${input.ownerId}\u0000${input.groupKey}`;
        const previous = this.groups.get(scopeKey);
        const resolvedResultKey = resultKey(input);
        let generation = previous?.generation ?? 0;
        let group = previous;

        if (!previous || previous.generationKey !== input.generationKey) {
            generation += 1;
            if (previous) {
                for (const oldTrace of previous.traces) {
                    if (oldTrace.finalReported || oldTrace.staleAt !== null) continue;
                    oldTrace.staleAt = createdAt;
                    // Request mới cần đúng cùng pixel thì để render cũ hoàn tất và coalesce;
                    // chỉ terminate worker khi kết quả vật lý đã thật sự lỗi thời.
                    if (oldTrace.request.resultKey !== resolvedResultKey) {
                        this.cancelStalePhysicalWork(oldTrace);
                    }
                }
            }
            group = {
                generationKey: input.generationKey,
                generation,
                traces: new Set<RenderTrace>(),
            };
            this.groups.set(scopeKey, group);
        }

        const requestId = nextRequestId(++this.sequence);
        const request: RenderCoordinatorRequest = {
            ...input,
            protocolVersion: 1,
            requestId,
            resultKey: resolvedResultKey,
            generation,
            // resultKey không chứa owner/generation/purpose/priority để cache/dedupe đúng
            // theo pixel; khóa scheduler thêm owner + slot để hai tab không triệt nhau.
            requestKey: `${input.ownerId}|${input.groupKey}|${resolvedResultKey}`,
        };
        const trace: RenderTrace = {
            request,
            createdAt,
            enqueuedAt: null,
            runStartedAt: null,
            renderEndedAt: null,
            sourceReadyAt: null,
            decodeStartedAt: null,
            staleAt: null,
            queueMs: 0,
            waitMs: 0,
            sourceMs: 0,
            decodeMs: null,
            staleMs: 0,
            bitmapWidth: null,
            bitmapHeight: null,
            byteLength: 0,
            coalesced: false,
            finalReported: false,
            staleWorkReported: false,
            physicalCancelSent: false,
        };
        group?.traces.add(trace);
        return trace;
    }

    private isLatest(trace: RenderTrace): boolean {
        const scopeKey = `${trace.request.ownerId}\u0000${trace.request.groupKey}`;
        const group = this.groups.get(scopeKey);
        return group?.generation === trace.request.generation
            && group.generationKey === trace.request.generationKey;
    }

    private reportStalePhysicalWork(trace: RenderTrace): void {
        if (trace.staleAt === null || trace.staleWorkReported) return;
        trace.staleWorkReported = true;
        trace.staleMs = Math.max(0, this.now() - trace.staleAt);
        void this.report('stale-work', this.payload(trace, 'stale'));
    }

    private cancelStalePhysicalWork(trace: RenderTrace): void {
        if (
            trace.physicalCancelSent
            || trace.runStartedAt === null
            || trace.renderEndedAt !== null
        ) return;
        trace.physicalCancelSent = true;
        void this.cancelPhysical(trace.request);
    }

    private reportFinal(
        trace: RenderTrace,
        status: RenderStatus,
        extra: Record<string, unknown> = {},
    ): void {
        if (trace.finalReported) return;
        trace.finalReported = true;
        const now = this.now();
        if (trace.staleAt !== null) trace.staleMs = Math.max(0, now - trace.staleAt);
        void this.report('result', {
            ...this.payload(trace, status),
            ...extra,
        });
        const scopeKey = `${trace.request.ownerId}\u0000${trace.request.groupKey}`;
        this.groups.get(scopeKey)?.traces.delete(trace);
    }

    private payload(trace: RenderTrace, status: RenderStatus): Record<string, unknown> {
        const request = trace.request;
        const totalMs = Math.max(0, this.now() - trace.createdAt);
        return {
            request_id: request.requestId,
            owner_id: request.ownerId,
            group_key: request.groupKey,
            generation: request.generation,
            purpose: request.purpose,
            priority: request.priority,
            document_identity: request.document.token,
            document_size_bytes: request.document.sizeBytes,
            document_modified_nanos: request.document.modifiedNanos,
            document_created_nanos: request.document.createdNanos,
            page: request.page,
            rotation: request.rotation,
            raster_kind: request.raster.kind,
            scale: request.raster.kind === 'scale'
                ? Number(request.raster.scale.toFixed(3))
                : null,
            dpi: request.raster.kind === 'dpi' ? Math.round(request.raster.dpi) : null,
            clip: request.raster.clip,
            color_pipeline: request.color.pipeline,
            pipeline_identity: request.pipelineIdentity,
            profile: request.color.profileId,
            intent: request.color.intent,
            cache_tier: trace.coalesced ? 'coalesced' : 'unknown',
            timing_mode: 'raw-in-process',
            soundness: request.soundness,
            bitmap_width: trace.bitmapWidth,
            bitmap_height: trace.bitmapHeight,
            bytes: trace.byteLength,
            queue_ms: Math.round(trace.queueMs),
            wait_ms: Math.round(trace.waitMs),
            render_ms: null,
            encode_ms: null,
            source_ms: Math.round(trace.sourceMs),
            decode_ms: trace.decodeMs === null ? null : Math.round(trace.decodeMs),
            stale_ms: Math.round(trace.staleMs),
            total_ms: Math.round(totalMs),
            status,
        };
    }
}

export const nativeRenderCoordinator = new RenderCoordinator();
