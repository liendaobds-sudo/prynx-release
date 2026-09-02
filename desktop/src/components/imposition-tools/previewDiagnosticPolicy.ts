export type PreviewDiagnosticState = 'none' | 'pending' | 'applied' | 'failed';

export interface PreviewDiagnosticSnapshot {
    traceId: string;
    appliedRequestId?: string;
    pendingRequestId?: string;
    capacity?: number;
    forceLegacyGrid?: boolean;
    state: PreviewDiagnosticState;
}

export interface PreviewDiagnosticEventLike {
    traceId: string;
    requestId: string;
    phase: 'pending' | 'applied' | 'failed' | 'aborted' | 'stale';
    capacity?: number;
    forceLegacyGrid?: boolean;
}

/**
 * B10-6: telemetry của probe per-view và quyết định engine là hai trạng thái khác nhau.
 * Probe legacy được phép pending/failed nhưng export vẫn phải giữ engine lưới; pending
 * của identity mới không mang cờ và phải xóa authority cũ ngay.
 */
export function reducePreviewDiagnosticSnapshot(
    current: PreviewDiagnosticSnapshot,
    event: PreviewDiagnosticEventLike,
    traceId: string,
): PreviewDiagnosticSnapshot {
    const scoped = current.traceId === traceId
        ? current
        : { traceId, state: 'none' as const };
    if (event.traceId !== traceId) return scoped;

    if (event.phase === 'pending') {
        const keepLegacyDecision = event.forceLegacyGrid === true;
        return {
            traceId,
            ...(keepLegacyDecision && scoped.appliedRequestId
                ? {
                    appliedRequestId: scoped.appliedRequestId,
                    capacity: scoped.capacity,
                }
                : {}),
            pendingRequestId: event.requestId,
            forceLegacyGrid: keepLegacyDecision,
            state: 'pending',
        };
    }

    if (event.phase === 'applied') {
        return {
            traceId,
            appliedRequestId: event.requestId,
            capacity: event.capacity,
            forceLegacyGrid: event.forceLegacyGrid === true,
            state: 'applied',
        };
    }

    if (scoped.pendingRequestId !== event.requestId) return scoped;
    const keepLegacyDecision = event.forceLegacyGrid === true
        || scoped.forceLegacyGrid === true;
    return {
        ...scoped,
        pendingRequestId: undefined,
        forceLegacyGrid: keepLegacyDecision,
        state: event.phase === 'failed'
            ? (keepLegacyDecision && scoped.appliedRequestId ? 'applied' : 'failed')
            : (scoped.appliedRequestId ? 'applied' : 'none'),
    };
}

/** Quyết định route export không phụ thuộc probe geometry đang pending hay failed. */
export function forceLegacyGridForExport(snapshot: PreviewDiagnosticSnapshot): boolean {
    return snapshot.forceLegacyGrid === true;
}
