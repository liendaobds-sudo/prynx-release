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

        const { result } = renderHook(() => useEditSession());

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

    it('OCG-only: layer đi qua op chung để có undo/redo', async () => {
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-layer', page_count: 1 });
            if (path === '/op') return okJson({
                success: true, preview: '', clipRect: null, full: true, page: 0,
                opResult: { kind: 'layerVisibility' }, canUndo: true, canRedo: false,
            });
            return okJson({});
        });

        const refreshLayers = vi.fn();
        const refreshObjects = vi.fn();
        window.addEventListener('refresh-ocg-layers', refreshLayers);
        window.addEventListener('edit-session-objects-changed', refreshObjects);

        const { result } = renderHook(() => useEditSession());
        await act(async () => {
            await result.current.openSession('fid-layer');
            await result.current.applyOp({
                page: 0, kind: 'layerVisibility', targetIds: [], layerId: 42, visible: false,
            });
        });

        expect(result.current.dirty).toBe(true);
        expect(result.current.canUndo).toBe(true);
        expect(refreshLayers).toHaveBeenCalledTimes(1);
        expect(refreshObjects).not.toHaveBeenCalled();
        window.removeEventListener('refresh-ocg-layers', refreshLayers);
        window.removeEventListener('edit-session-objects-changed', refreshObjects);
        const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/op'));
        expect(JSON.parse(call![1].body)).toMatchObject({
            session_id: 'sess-layer',
            op: { kind: 'layerVisibility', layerId: 42, visible: false },
        });
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

        const { result } = renderHook(() => useEditSession());

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

    it('previews: mỗi op đẩy 1 lớp overlay; commit KHÔNG tự chạy giữa lúc sửa (commit-on-exit)', async () => {
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-4', page_count: 1 });
            if (path === '/op') {
                return okJson({
                    success: true, preview: 'data:image/png;base64,BBBB',
                    clipRect: [1, 2, 3, 4], full: false,
                    page: 0, opResult: {}, canUndo: true, canRedo: false,
                });
            }
            if (path === '/commit') return okJson({ success: true, output_fid: 'fid-out' });
            return okJson({});
        });

        const { result } = renderHook(() => useEditSession());

        await act(async () => {
            await result.current.openSession('fid-4');
            await result.current.applyOp(MOVE_OP);
            await result.current.applyOp(MOVE_OP);
        });

        // Hai op → hai lớp preview; KHÔNG commit tự động (không có call /commit nào).
        expect(result.current.previews).toHaveLength(1);
        expect(result.current.previews[0]).toMatchObject({ url: 'data:image/png;base64,BBBB', page: 0, full: false });
        expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/commit'))).toBe(false);
        expect(result.current.dirty).toBe(true);

        // clearPreviews xóa hết (gọi sau khi tile thật vào).
        act(() => { result.current.clearPreviews(); });
        expect(result.current.previews).toHaveLength(0);
    });

    it('flatten: tạo Working File mới, dọn preview và báo onCommit', async () => {
        const onCommit = vi.fn();
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-flat', page_count: 1 });
            if (path === '/op') return okJson({
                success: true, preview: 'data:image/png;base64,CCCC',
                clipRect: null, full: true, page: 0, opResult: {},
                canUndo: true, canRedo: false,
            });
            if (path === '/flatten') return okJson({
                success: true,
                output_fid: 'fid-flat',
                output_url: '/results/edit_output/flat.pdf',
                output_path: '/tmp/flat.pdf',
                output_filename: 'flat.pdf',
            });
            return okJson({});
        });

        const { result } = renderHook(() => useEditSession({ onCommit }));
        await act(async () => {
            await result.current.openSession('fid-source');
            await result.current.applyOp(MOVE_OP);
        });
        expect(result.current.previews).toHaveLength(1);

        await act(async () => {
            await result.current.flatten();
        });

        expect(result.current.dirty).toBe(false);
        expect(result.current.canUndo).toBe(false);
        expect(result.current.previews).toHaveLength(0);
        expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
            success: true, output_fid: 'fid-flat', output_filename: 'flat.pdf',
        }));
    });

    it('phát tín hiệu nạp lại Thành phần sau apply/undo/redo', async () => {
        routeByPath((path) => {
            if (path === '/open') return okJson({ session_id: 'sess-refresh', page_count: 1 });
            return okJson({
                success: true, preview: '', clipRect: null, full: false, page: 0,
                opResult: { kind: path === '/op' ? 'move' : path.slice(1) },
                canUndo: true, canRedo: true,
            });
        });
        const received: Array<{ page: number; path: string }> = [];
        const listener = (event: Event) => received.push((event as CustomEvent).detail);
        window.addEventListener('edit-session-objects-changed', listener);
        try {
            const { result } = renderHook(() => useEditSession());
            await act(async () => {
                await result.current.openSession('fid-refresh');
                await result.current.applyOp(MOVE_OP);
                await result.current.undo();
                await result.current.redo();
            });
            expect(received).toEqual([
                { page: 0, path: '/op' },
                { page: 0, path: '/undo' },
                { page: 0, path: '/redo' },
            ]);
        } finally {
            window.removeEventListener('edit-session-objects-changed', listener);
        }
    });
});
