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
    vi.useRealTimers();
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

    it('gom burst vào một IPC và giữ đủ sự kiện cùng clip', async () => {
        vi.useFakeTimers();
        const invoke = installPerfInvoke(true);
        const logger = await loadPerfLogger();
        const writes = Array.from({ length: 100 }, (_, index) => logger.viewerTraceLog('burst', {
            index, clip: { x: index, y: 2, width: 1344, height: 832 },
        }));
        await vi.advanceTimersByTimeAsync(30);
        await Promise.all(writes);
        const batches = invoke.mock.calls.filter(([command]) => command === 'append_render_perf');
        expect(batches).toHaveLength(1);
        const events = String(batches[0][1]?.msg).split('\n')
            .map(line => JSON.parse(line.slice('VIEWER_TRACE '.length)))
            .filter(event => event.event === 'burst');
        expect(events).toHaveLength(100);
        expect(events.map(event => event.index)).toEqual(Array.from({ length: 100 }, (_, i) => i));
        expect(events[99].clip).toEqual({ x: 99, y: 2, width: 1344, height: 832 });
    });

    it('đóng timestamp trước khi IPC bị nghẽn, không đo thời điểm ghi file', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const invoke = installPerfInvoke(true);
        let release!: () => void;
        invoke.mockImplementation(command => command === 'preview_perf_logging_enabled'
            ? Promise.resolve(true) : new Promise<void>(resolve => { release = resolve; }));
        const logger = await loadPerfLogger();
        const first = logger.viewerTraceLog('first');
        await vi.advanceTimersByTimeAsync(30);
        vi.setSystemTime(2000);
        const second = logger.viewerTraceLog('second');
        vi.setSystemTime(9000);
        invoke.mockImplementation(async command => command === 'preview_perf_logging_enabled' ? true : undefined);
        release();
        await Promise.all([first, second]);
        const events = invoke.mock.calls.filter(([command]) => command === 'append_render_perf')
            .flatMap(([, args]) => String(args?.msg).split('\n'))
            .map(line => JSON.parse(line.slice('VIEWER_TRACE '.length)));
        expect(events.find(event => event.event === 'first').event_epoch_ms).toBe(1000);
        expect(events.find(event => event.event === 'second').event_epoch_ms).toBe(2000);
    });

    it('báo số sự kiện mất khi đĩa/IPC lỗi và tiếp tục ghi được', async () => {
        vi.useFakeTimers();
        const invoke = installPerfInvoke(true);
        invoke.mockImplementation(async command => {
            if (command === 'preview_perf_logging_enabled') return true;
            throw new Error('disk full');
        });
        const logger = await loadPerfLogger();
        const failed = logger.viewerTraceLog('failed');
        await vi.advanceTimersByTimeAsync(30);
        await failed;
        invoke.mockImplementation(async () => undefined);
        const recovered = logger.viewerTraceLog('recovered');
        await vi.advanceTimersByTimeAsync(30);
        await recovered;
        const last = String(invoke.mock.calls.at(-1)?.[1]?.msg);
        expect(last).toContain('TRACE_TRANSPORT');
        expect(last).toContain('"failed_events":2');
        expect(last).toContain('"event":"recovered"');
    });
});
