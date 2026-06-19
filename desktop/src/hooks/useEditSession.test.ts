// @vitest-environment jsdom
/**
 * Test cho `useEditSession` — mock module '../lib/api' để giả lập backend phiên.
 *
 * Bao phủ các luồng cốt lõi của hook (task 10.2):
 *  - openSession: /open trả {session_id, page_count} → sessionId set + trả page_count.
 *  - applyOp:     /op   trả SessionOpResp → trả outcome, canUndo/canRedo cập nhật, dirty=true.
 *  - commit:      /commit trả EditResponse → trả result, dirty=false.
 *  - fallback-410: bất kỳ op nào nhận HTTP 410 → trả null, sessionFailed=true, onSessionFailed gọi.
 *
 * _Requirements: 9.5, 11.1_
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { authenticatedFetch } from '../lib/api';
import { useEditSession } from './useEditSession';
import type { EditOp } from '../components/workspace/editTypes';

// Mock toàn bộ lib/api: chỉ cần authenticatedFetch (vi.fn điều khiển từng ca) + getApiUrl cố định.
vi.mock('../lib/api', () => ({
    getApiUrl: () => 'http://test.local/api',
    authenticatedFetch: vi.fn(),
}));

const fetchMock = authenticatedFetch as unknown as Mock;

/** Tạo Response giả thành công kèm body JSON. */
function okJson(body: unknown): Response {
    return {
        status: 200,
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** Tạo Response giả HTTP 410 (phiên không tồn tại) → hook ném SessionGoneError. */
function gone(): Response {
    return {
        status: 410,
        ok: false,
        json: async () => ({}),
        text: async () => 'session gone',
    } as unknown as Response;
}

/** Định tuyến mock theo path của URL `${getApiUrl()}/edit/session<path>`. */
function routeByPath(handler: (path: string) => Response) {
    fetchMock.mockImplementation((url: string) => {
        const marker = '/edit/session';
        const idx = url.indexOf(marker);
        const path = idx >= 0 ? url.slice(idx + marker.length) : url;
        return Promise.resolve(handler(path));
    });
}

const MOVE_OP: EditOp = {
    page: 0,
    kind: 'move',
    targetIds: ['obj-1'],
    delta: { dx: 5, dy: -3 },
};

beforeEach(() => {
    fetchMock.mockReset();
});

describe('useEditSession', () => {
    it('openSession: set sessionId và trả page_count', async () => {
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-abc', page_count: 7 });
            throw new Error(`unexpected path ${path}`);
        });

        const { result } = renderHook(() => useEditSession());

        let pageCount: number | null = null;
        await act(async () => {
            pageCount = await result.current.openSession('fid-123');
        });

        expect(pageCount).toBe(7);
        expect(result.current.sessionId).toBe('sess-abc');
        expect(result.current.sessionFailed).toBe(false);
        expect(result.current.dirty).toBe(false);
        // Body phải chứa fid gửi đi.
        const openCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/open'));
        expect(openCall).toBeDefined();
        expect(JSON.parse(openCall![1].body)).toEqual({ fid: 'fid-123' });
    });

    it('applyOp: trả outcome, cập nhật canUndo/canRedo và đặt dirty=true', async () => {
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-1', page_count: 1 });
            if (path === '/op') {
                return okJson({
                    success: true,
                    preview: 'data:image/png;base64,AAAA',
                    clipRect: [10, 20, 30, 40],
                    full: false,
                    page: 0,
                    opResult: { bbox: [10, 20, 30, 40] },
                    canUndo: true,
                    canRedo: false,
                });
            }
            return okJson({ success: true });
        });

        // debounce lớn để timer auto-commit KHÔNG chen vào trong lúc test op.
        const { result } = renderHook(() => useEditSession({ debounceCommitMs: 1_000_000 }));

        await act(async () => {
            await result.current.openSession('fid-1');
        });

        let outcome: Awaited<ReturnType<typeof result.current.applyOp>> = null;
        await act(async () => {
            outcome = await result.current.applyOp(MOVE_OP, 2.0);
        });

        expect(outcome).not.toBeNull();
        expect(outcome!.success).toBe(true);
        expect(outcome!.preview).toBe('data:image/png;base64,AAAA');
        expect(outcome!.clipRect).toEqual([10, 20, 30, 40]);
        expect(outcome!.opResult).toEqual({ bbox: [10, 20, 30, 40] });

        expect(result.current.canUndo).toBe(true);
        expect(result.current.canRedo).toBe(false);
        expect(result.current.dirty).toBe(true);

        // Op gửi đúng session_id + tham số render.
        const opCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/op'));
        const opBody = JSON.parse(opCall![1].body);
        expect(opBody.session_id).toBe('sess-1');
        expect(opBody.render_scale).toBe(2.0);
        expect(opBody.op).toMatchObject({ kind: 'move', targetIds: ['obj-1'] });
    });

    it('commit: trả result và đặt dirty=false', async () => {
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-2', page_count: 1 });
            if (path === '/op') {
                return okJson({
                    success: true,
                    preview: '',
                    clipRect: null,
                    full: true,
                    page: 0,
                    opResult: {},
                    canUndo: true,
                    canRedo: false,
                });
            }
            if (path === '/commit') {
                return okJson({
                    success: true,
                    output_fid: 'fid-out',
                    output_url: '/files/fid-out/serve',
                    output_path: '/tmp/out.pdf',
                    output_filename: 'out.pdf',
                });
            }
            return okJson({});
        });

        const { result } = renderHook(() => useEditSession({ debounceCommitMs: 1_000_000 }));

        await act(async () => {
            await result.current.openSession('fid-2');
            await result.current.applyOp(MOVE_OP);
        });
        expect(result.current.dirty).toBe(true);

        let committed: Awaited<ReturnType<typeof result.current.commit>> = null;
        await act(async () => {
            committed = await result.current.commit();
        });

        expect(committed).not.toBeNull();
        expect(committed!).toEqual({
            success: true,
            output_fid: 'fid-out',
            output_url: '/files/fid-out/serve',
            output_path: '/tmp/out.pdf',
            output_filename: 'out.pdf',
        });
        expect(result.current.dirty).toBe(false);
    });

    it('fallback-410: applyOp trả null, sessionFailed=true và gọi onSessionFailed (Yêu cầu 9.5, 11.1)', async () => {
        const onSessionFailed = vi.fn();

        // open thành công, nhưng op gặp 410 (phiên đã bị dọn).
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-3', page_count: 1 });
            if (path === '/op') return gone();
            return okJson({});
        });

        const { result } = renderHook(() => useEditSession({ onSessionFailed }));

        await act(async () => {
            await result.current.openSession('fid-3');
        });
        expect(result.current.sessionId).toBe('sess-3');

        let outcome: Awaited<ReturnType<typeof result.current.applyOp>> = 'init' as any;
        await act(async () => {
            outcome = await result.current.applyOp(MOVE_OP);
        });

        expect(outcome).toBeNull();
        expect(result.current.sessionFailed).toBe(true);
        expect(result.current.sessionId).toBeNull();
        expect(result.current.dirty).toBe(false);
        expect(onSessionFailed).toHaveBeenCalledTimes(1);
    });

    it('debounce-commit: auto-commit kích hoạt sau op cuối, gọi onCommit và xóa dirty (Yêu cầu 5.3)', async () => {
        vi.useFakeTimers();
        try {
            const onCommit = vi.fn();
            routeByPath((path) => {
                if (path === '/open') return okJson({ session_id: 'sess-4', page_count: 1 });
                if (path === '/op') {
                    return okJson({
                        success: true, preview: '', clipRect: null, full: true,
                        page: 0, opResult: {}, canUndo: true, canRedo: false,
                    });
                }
                if (path === '/commit') return okJson({ success: true, output_fid: 'fid-auto' });
                return okJson({});
            });

            const { result } = renderHook(() => useEditSession({ debounceCommitMs: 1500, onCommit }));

            await act(async () => {
                await result.current.openSession('fid-4');
                await result.current.applyOp(MOVE_OP);
            });
            expect(result.current.dirty).toBe(true);

            // Đẩy thời gian qua ngưỡng debounce → timer auto-commit chạy (flush cả microtask).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1600);
            });

            expect(onCommit).toHaveBeenCalledTimes(1);
            expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({ success: true, output_fid: 'fid-auto' }));
            expect(result.current.dirty).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
