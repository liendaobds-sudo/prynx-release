/**
 * useEditSession — Hook quản lý PHIÊN chỉnh sửa PDF trong bộ nhớ backend
 * (spec `pdf-edit-session`, phương án "C").
 *
 * VÌ SAO: thay cho Legacy_Commit_Flow (mỗi Edit_Op ghi 1 Working_File mới ra đĩa →
 * Rust mở lại file → render cả trang → refetch /edit/objects, ~5s), phiên giữ một
 * `pikepdf.Pdf` SỐNG trong RAM backend. Mỗi op chỉ: áp in-memory → render PNG vùng
 * CLIP → trả về để FE dán overlay tại chỗ (KHÔNG đổi pdfUrl, KHÔNG refetch).
 *
 * Hook này KHÔNG đụng tới DOM/canvas; nó chỉ điều phối vòng đời phiên + gọi API.
 * `LivePageFrame.tsx` (task 11.1) sẽ dùng dữ liệu trả về để dán overlay và cập nhật
 * `editObjects` tại chỗ.
 *
 * Vòng đời & API (design.md → Components/endpoints):
 *   POST   /api/edit/session/open      {fid}                         → {session_id, page_count}
 *   POST   /api/edit/session/op        {session_id, op, render_scale, clip_pad_pt} → SessionOpResp
 *   POST   /api/edit/session/undo      {session_id, render_scale, clip_pad_pt}     → SessionOpResp
 *   POST   /api/edit/session/redo      {session_id, render_scale, clip_pad_pt}     → SessionOpResp
 *   POST   /api/edit/session/commit    {session_id}                  → EditResponse
 *   DELETE /api/edit/session/{sid}                                   → {closed:true}
 *
 * Trọng tâm task 10.1:
 *  - Quản `sessionId`, `openSession/applyOp/undo/redo/commit/closeSession`.
 *  - Timer DEBOUNCE-COMMIT (~1.5s sau op cuối) → mốc bền + cho tile thật (Yêu cầu 5.3, 5.6).
 *  - Cờ `sessionFailed`: bắt HTTP 410 (phiên-không-tồn-tại) → tín hiệu FE fallback Legacy
 *    (Yêu cầu 9.5, 11.1).
 *  - Trả `{preview, clipRect, opResult, canUndo, canRedo}` cho FE (Yêu cầu 12.2, 12.4).
 *
 * _Requirements: 5.1, 5.3, 5.6, 9.5, 11.1, 12.2, 12.4_
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch, getApiUrl } from '../lib/api';
import type { EditOp, BBox } from '../components/workspace/editTypes';

/** Ngưỡng debounce mặc định: commit ~1.5s sau Edit_Op cuối (Yêu cầu 5.3). */
const DEFAULT_DEBOUNCE_COMMIT_MS = 1500;
/** Scale render preview mặc định (px/point ≈ zoom×dpr) — khớp `SessionOpReq.render_scale`. */
const DEFAULT_RENDER_SCALE = 2.0;
/** Lề an toàn quanh Clip_Region (point) — khớp `SessionOpReq.clip_pad_pt`. */
const DEFAULT_CLIP_PAD_PT = 8.0;

/** Kết quả 1 thao tác phiên (op/undo/redo) trả về cho FE dán overlay + cập nhật object. */
export interface SessionOpOutcome {
    success: boolean;
    /** data:image/png;base64,... — ảnh vùng clip (hoặc full nếu `full=true`). */
    preview: string;
    /** [x0,y0,x1,y1] POINT, gốc Page_Box-relative; null = render toàn trang. */
    clipRect: BBox | null;
    /** True nếu render toàn trang (fallback khi không xác định được vùng giới hạn). */
    full: boolean;
    page: number;
    /** Gồm bbox MỚI để FE cập nhật overlay object tại chỗ (KHÔNG refetch). */
    opResult: Record<string, any>;
    canUndo: boolean;
    canRedo: boolean;
}

/** Kết quả Commit — khớp `EditResponse` của Legacy (để FE đổi pdfUrl qua onEditCommit). */
export interface SessionCommitResult {
    success: boolean;
    output_fid?: string;
    output_url?: string;
    output_path?: string;
    output_filename?: string;
}

export interface UseEditSessionOptions {
    /** Override ngưỡng debounce-commit (ms). */
    debounceCommitMs?: number;
    /** Gọi khi 1 lần debounce-commit (tự động) hoàn tất → FE đổi sang tile thật. */
    onCommit?: (result: SessionCommitResult) => void;
    /** Gọi khi phiên hỏng/không tồn tại (410) → FE chuyển sang Legacy_Commit_Flow. */
    onSessionFailed?: () => void;
}

export interface UseEditSession {
    /** Session_Id hiện tại (null nếu chưa mở / đã đóng). */
    sessionId: string | null;
    /** True khi phiên hỏng (410 / mở thất bại) → FE nên fallback Legacy (Yêu cầu 11.1). */
    sessionFailed: boolean;
    canUndo: boolean;
    canRedo: boolean;
    /** Có thay đổi chưa Commit ra đĩa? */
    dirty: boolean;
    /** Mở phiên từ `fid`. Trả số trang nếu thành công, null nếu thất bại. */
    openSession: (fid: string) => Promise<number | null>;
    /** Áp 1 Edit_Op in-memory + render clip. `scale` = px/point. */
    applyOp: (op: EditOp, scale?: number) => Promise<SessionOpOutcome | null>;
    undo: (scale?: number) => Promise<SessionOpOutcome | null>;
    redo: (scale?: number) => Promise<SessionOpOutcome | null>;
    /** Commit Live_Document ra Working_File mới (ghi đĩa). */
    commit: () => Promise<SessionCommitResult | null>;
    /** Đóng phiên, giải phóng RAM backend. */
    closeSession: () => Promise<void>;
}

/** Lỗi nội bộ: phiên không còn (HTTP 410) → kích hoạt fallback. */
class SessionGoneError extends Error {
    constructor() {
        super('edit-session-gone');
        this.name = 'SessionGoneError';
    }
}

export function useEditSession(options: UseEditSessionOptions = {}): UseEditSession {
    const debounceMs = options.debounceCommitMs ?? DEFAULT_DEBOUNCE_COMMIT_MS;

    const [sessionId, setSessionId] = useState<string | null>(null);
    const [sessionFailed, setSessionFailed] = useState(false);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const [dirty, setDirty] = useState(false);

    // Refs giữ giá trị "mới nhất" tránh stale-closure trong timer/async.
    const sessionIdRef = useRef<string | null>(null);
    const dirtyRef = useRef(false);
    const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const committingRef = useRef(false);     // có commit đang chạy?
    const pendingCommitRef = useRef(false);  // có op mới trong lúc đang commit? (gộp — Yêu cầu 5.6)
    const optsRef = useRef(options);
    optsRef.current = options;

    const setSession = useCallback((id: string | null) => {
        sessionIdRef.current = id;
        setSessionId(id);
    }, []);

    const setDirtyFlag = useCallback((v: boolean) => {
        dirtyRef.current = v;
        setDirty(v);
    }, []);

    const clearCommitTimer = useCallback(() => {
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
        }
    }, []);

    /** Đánh dấu phiên hỏng → FE fallback Legacy (Yêu cầu 9.5, 11.1). */
    const markFailed = useCallback(() => {
        clearCommitTimer();
        setSession(null);
        setDirtyFlag(false);
        setSessionFailed(true);
        try { optsRef.current.onSessionFailed?.(); } catch { /* nuốt lỗi callback */ }
    }, [clearCommitTimer, setSession, setDirtyFlag]);

    /**
     * Gọi API phiên. Ném `SessionGoneError` khi 410 (FE fallback); ném Error thường
     * cho các lỗi khác (409/422/504/404...) để caller xử lý mà KHÔNG hủy phiên.
     */
    const request = useCallback(async (
        path: string,
        init: RequestInit,
    ): Promise<any> => {
        const res = await authenticatedFetch(`${getApiUrl()}/edit/session${path}`, init);
        if (res.status === 410) throw new SessionGoneError();
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`/edit/session${path} HTTP ${res.status} ${detail}`);
        }
        // DELETE có thể trả body rỗng.
        return res.json().catch(() => ({}));
    }, []);

    const jsonPost = useCallback((body: unknown): RequestInit => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }), []);

    // ── Commit (ghi đĩa) ──────────────────────────────────────────────────────
    // Gộp các yêu cầu commit dồn lại trong cửa sổ debounce thành 1 lần ghi phản
    // ánh trạng thái mới nhất (Yêu cầu 5.6). `auto`=true khi do debounce kích hoạt.
    const doCommit = useCallback(async (auto: boolean): Promise<SessionCommitResult | null> => {
        const sid = sessionIdRef.current;
        if (!sid) return null;
        // Đang có commit chạy → đánh dấu cần commit lại sau (gộp), không chạy song song.
        if (committingRef.current) {
            pendingCommitRef.current = true;
            return null;
        }
        committingRef.current = true;
        try {
            const data = await request('/commit', jsonPost({ session_id: sid }));
            // Commit thành công → không còn thay đổi chưa ghi.
            setDirtyFlag(false);
            const result: SessionCommitResult = {
                success: !!data?.success,
                output_fid: data?.output_fid,
                output_url: data?.output_url,
                output_path: data?.output_path,
                output_filename: data?.output_filename,
            };
            if (auto) {
                try { optsRef.current.onCommit?.(result); } catch { /* nuốt lỗi callback */ }
            }
            return result;
        } catch (e) {
            if (e instanceof SessionGoneError) { markFailed(); return null; }
            // Commit thất bại → GIỮ NGUYÊN trạng thái phiên trong RAM để thử lại
            // (Yêu cầu 10.5); không xóa dirty.
            throw e;
        } finally {
            committingRef.current = false;
            // Có op mới chen vào lúc đang commit → commit lại cho mốc mới nhất.
            if (pendingCommitRef.current) {
                pendingCommitRef.current = false;
                void doCommit(true).catch(() => { /* best-effort auto-commit */ });
            }
        }
    }, [request, jsonPost, setDirtyFlag, markFailed]);

    /** Hẹn debounce-commit ~debounceMs sau op cuối (Yêu cầu 5.3, 5.6). */
    const scheduleCommit = useCallback(() => {
        clearCommitTimer();
        commitTimerRef.current = setTimeout(() => {
            commitTimerRef.current = null;
            if (!sessionIdRef.current || !dirtyRef.current) return;
            void doCommit(true).catch(() => { /* best-effort: lần lưu thủ công sẽ thử lại */ });
        }, debounceMs);
    }, [clearCommitTimer, doCommit, debounceMs]);

    // ── Mở phiên ──────────────────────────────────────────────────────────────
    const openSession = useCallback(async (fid: string): Promise<number | null> => {
        if (!fid) return null;
        clearCommitTimer();
        try {
            const data = await request('/open', jsonPost({ fid }));
            const sid: string = data?.session_id;
            if (!sid) throw new Error('open: thiếu session_id');
            setSession(sid);
            setSessionFailed(false);
            setCanUndo(false);
            setCanRedo(false);
            setDirtyFlag(false);
            return typeof data?.page_count === 'number' ? data.page_count : 0;
        } catch (e) {
            // Mở thất bại (kể cả 410/404) → tín hiệu fallback Legacy (Yêu cầu 11.1).
            markFailed();
            return null;
        }
    }, [request, jsonPost, clearCommitTimer, setSession, setDirtyFlag, markFailed]);

    // ── Áp Edit_Op / Undo / Redo ───────────────────────────────────────────────
    const runOp = useCallback(async (
        path: '/op' | '/undo' | '/redo',
        body: Record<string, unknown>,
    ): Promise<SessionOpOutcome | null> => {
        const sid = sessionIdRef.current;
        if (!sid) return null;
        try {
            const data = await request(path, jsonPost({ session_id: sid, ...body }));
            const outcome: SessionOpOutcome = {
                success: !!data?.success,
                preview: data?.preview ?? '',
                clipRect: Array.isArray(data?.clipRect) ? (data.clipRect as BBox) : null,
                full: !!data?.full,
                page: typeof data?.page === 'number' ? data.page : 0,
                opResult: data?.opResult ?? {},
                canUndo: !!data?.canUndo,
                canRedo: !!data?.canRedo,
            };
            setCanUndo(outcome.canUndo);
            setCanRedo(outcome.canRedo);
            // Thao tác thành công → trạng thái thay đổi, hẹn commit bền (Yêu cầu 5.1, 5.3).
            setDirtyFlag(true);
            scheduleCommit();
            return outcome;
        } catch (e) {
            if (e instanceof SessionGoneError) { markFailed(); return null; }
            // Lỗi op (409/422/504...) → GIỮ NGUYÊN phiên + Op_Log (Yêu cầu 10.2, 10.3);
            // ném lại để caller hiển thị lỗi mà KHÔNG fallback.
            throw e;
        }
    }, [request, jsonPost, setDirtyFlag, scheduleCommit, markFailed]);

    const applyOp = useCallback((op: EditOp, scale: number = DEFAULT_RENDER_SCALE) =>
        runOp('/op', { op, render_scale: scale, clip_pad_pt: DEFAULT_CLIP_PAD_PT }),
        [runOp]);

    const undo = useCallback((scale: number = DEFAULT_RENDER_SCALE) =>
        runOp('/undo', { render_scale: scale, clip_pad_pt: DEFAULT_CLIP_PAD_PT }),
        [runOp]);

    const redo = useCallback((scale: number = DEFAULT_RENDER_SCALE) =>
        runOp('/redo', { render_scale: scale, clip_pad_pt: DEFAULT_CLIP_PAD_PT }),
        [runOp]);

    // ── Commit thủ công (người dùng Lưu — Yêu cầu 5.2) ─────────────────────────
    const commit = useCallback(async (): Promise<SessionCommitResult | null> => {
        clearCommitTimer();
        if (!sessionIdRef.current) return null;
        return doCommit(false);
    }, [clearCommitTimer, doCommit]);

    // ── Đóng phiên ─────────────────────────────────────────────────────────────
    const closeSession = useCallback(async (): Promise<void> => {
        clearCommitTimer();
        const sid = sessionIdRef.current;
        setSession(null);
        setCanUndo(false);
        setCanRedo(false);
        setDirtyFlag(false);
        if (!sid) return;
        try {
            await authenticatedFetch(`${getApiUrl()}/edit/session/${sid}`, { method: 'DELETE' });
        } catch {
            // Đóng best-effort: TTL backend sẽ tự dọn nếu DELETE thất bại (Yêu cầu 9.2).
        }
    }, [clearCommitTimer, setSession, setDirtyFlag]);

    // Dọn timer khi unmount để tránh commit "mồ côi".
    useEffect(() => () => clearCommitTimer(), [clearCommitTimer]);

    return {
        sessionId,
        sessionFailed,
        canUndo,
        canRedo,
        dirty,
        openSession,
        applyOp,
        undo,
        redo,
        commit,
        closeSession,
    };
}
