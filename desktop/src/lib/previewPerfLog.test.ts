// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

type PerfInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function installPerfInvoke(enabled: boolean) {
    const invoke = vi.fn<PerfInvoke>(async (command: string) => (
        command === 'preview_perf_logging_enabled' ? enabled : undefined
    ));
    Object.defineProperty(window, '__PRYNX_INVOKE__', {
        configurable: true,
        value: invoke,
    });
    return invoke;
}

async function loadPerfLogger() {
    vi.resetModules();
    return import('./previewPerfLog');
}

afterEach(() => {
    delete (window as Window & { __PRYNX_INVOKE__?: unknown }).__PRYNX_INVOKE__;
    vi.restoreAllMocks();
});

describe('preview performance logging gate', () => {
    it('không ghi log khi PRYNX_PERF đang tắt, kể cả frontend Dev', async () => {
        const invoke = installPerfInvoke(false);
        const { viewerTraceLog } = await loadPerfLogger();

        await viewerTraceLog('viewer-test');

        expect(invoke).toHaveBeenCalledWith('preview_perf_logging_enabled');
        expect(invoke.mock.calls.some(([command]) => command === 'append_render_perf')).toBe(false);
    });

    it('ghi log khi cờ chẩn đoán được bật', async () => {
        const invoke = installPerfInvoke(true);
        const { viewerTraceLog } = await loadPerfLogger();

        await viewerTraceLog('viewer-test');

        expect(invoke.mock.calls.some(([command]) => command === 'append_render_perf')).toBe(true);
    });
});
