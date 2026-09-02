import { describe, expect, it } from 'vitest';

import {
    forceLegacyGridForExport,
    reducePreviewDiagnosticSnapshot,
    type PreviewDiagnosticSnapshot,
} from './previewDiagnosticPolicy';

const TRACE_ID = 'sr-diagnostic-test';

function emptySnapshot(): PreviewDiagnosticSnapshot {
    return { traceId: TRACE_ID, state: 'none' };
}

describe('previewDiagnosticPolicy — authority engine S&R', () => {
    it('giữ legacy qua pending và failure của probe per-view', () => {
        const applied = reducePreviewDiagnosticSnapshot(emptySnapshot(), {
            traceId: TRACE_ID,
            requestId: 'legacy-applied',
            phase: 'applied',
            capacity: 54,
            forceLegacyGrid: true,
        }, TRACE_ID);
        const pending = reducePreviewDiagnosticSnapshot(applied, {
            traceId: TRACE_ID,
            requestId: 'page-probe',
            phase: 'pending',
            forceLegacyGrid: true,
        }, TRACE_ID);

        expect(pending).toMatchObject({
            appliedRequestId: 'legacy-applied',
            pendingRequestId: 'page-probe',
            capacity: 54,
            forceLegacyGrid: true,
            state: 'pending',
        });
        expect(forceLegacyGridForExport(pending)).toBe(true);

        const failed = reducePreviewDiagnosticSnapshot(pending, {
            traceId: TRACE_ID,
            requestId: 'page-probe',
            phase: 'failed',
            forceLegacyGrid: true,
        }, TRACE_ID);
        expect(failed).toMatchObject({
            appliedRequestId: 'legacy-applied',
            forceLegacyGrid: true,
            state: 'applied',
        });
        expect(failed.pendingRequestId).toBeUndefined();
        expect(forceLegacyGridForExport(failed)).toBe(true);
    });

    it('pending của identity mới xóa legacy authority cũ', () => {
        const applied: PreviewDiagnosticSnapshot = {
            traceId: TRACE_ID,
            appliedRequestId: 'legacy-applied',
            capacity: 54,
            forceLegacyGrid: true,
            state: 'applied',
        };
        const pending = reducePreviewDiagnosticSnapshot(applied, {
            traceId: TRACE_ID,
            requestId: 'new-settings',
            phase: 'pending',
        }, TRACE_ID);

        expect(pending).toEqual({
            traceId: TRACE_ID,
            pendingRequestId: 'new-settings',
            forceLegacyGrid: false,
            state: 'pending',
        });
        expect(forceLegacyGridForExport(pending)).toBe(false);
    });
});
