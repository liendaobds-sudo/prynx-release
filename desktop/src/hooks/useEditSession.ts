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
import { useTranslation } from 'react-i18next';

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

/** Một lớp overlay xem-trước tích lũy trong phiên (mỗi op/undo/redo đẩy thêm 1 lớp).
 *  clipRect ở POINT (Page_Box-relative, gốc dưới-trái) — FE quy đổi sang px theo zoom
 *  hiện tại + lọc theo `page`. Lớp sau vẽ ĐÈ lớp trước ở vùng trùng → luôn phản ánh
 *  trạng thái mới nhất. `full=true` → phủ cả trang. */
export interface SessionPreview {
    url: string;
    clipRect: BBox | null;
    full: boolean;
    page: number;
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
    /** Các lớp overlay xem-trước tích lũy (op/undo/redo). FE render + quy đổi theo zoom.
     *  Hook SỞ HỮU state này (nguồn sự thật) — LivePageFrame chỉ đọc để render. */
    previews: SessionPreview[];
    /** Mở phiên từ `fid`. Trả số trang nếu thành công, null nếu thất bại. */
    openSession: (fid: string) => Promise<number | null>;
    /** Áp 1 Edit_Op in-memory + render clip. `scale` = px/point. */
    applyOp: (op: EditOp, scale?: number) => Promise<SessionOpOutcome | null>;
    undo: (scale?: number) => Promise<SessionOpOutcome | null>;
    redo: (scale?: number) => Promise<SessionOpOutcome | null>;
    /** Flatten layer hiện tại ra Working File mới và chuyển viewer sang file đó. */
    flatten: () => Promise<SessionCommitResult | null>;
    /** Commit Live_Document ra Working_File mới (ghi đĩa). Gọi KHI THOÁT edit mode. */
    commit: () => Promise<SessionCommitResult | null>;
    /** Xóa mọi lớp preview (gọi khi tile thật đã vào sau commit). */
    clearPreviews: () => void;
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
  const { t } = useTranslation();
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [sessionFailed, setSessionFailed] = useState(false);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const [dirty, setDirty] = useState(false);
    // Các lớp overlay xem-trước tích lũy trong phiên (op/undo/redo). Hook sở hữu để
    // hotkey (AcrobatViewer) và overlay (LivePageFrame — bị virtualized) cùng thấy.
    const [previews, setPreviews] = useState<SessionPreview[]>([]);

    // Refs giữ giá trị "mới nhất" tránh stale-closure trong async.
    const sessionIdRef = useRef<string | null>(null);
    const dirtyRef = useRef(false);
    const committingRef = useRef(false);     // có commit đang chạy? (chặn commit chồng)
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

    /** Đánh dấu phiên hỏng → FE báo lỗi (không fallback — người dùng đã chọn). */
    const markFailed = useCallback(() => {
        setSession(null);
        setDirtyFlag(false);
        setSessionFailed(true);
        setPreviews([]);
        try { optsRef.current.onSessionFailed?.(); } catch { /* nuốt lỗi callback */ }
    }, [setSession, setDirtyFlag]);

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
    // COMMIT-ON-EXIT: chỉ gọi khi THOÁT edit mode / Lưu (KHÔNG debounce giữa lúc sửa).
    // Lý do: mỗi commit sinh fid mới → nếu commit giữa phiên thì phải reopen session
    // (reset op_log → mất undo) + swap tile (reload → lag). Nên session sống suốt phiên
    // sửa; commit gộp TẤT CẢ op thành MỘT Working_File khi kết thúc. Trả kết quả cho
    // caller (ImpositionTab) đổi pdfUrl sang tile thật — reload DUY NHẤT, ở điểm tự nhiên.
    const doCommit = useCallback(async (): Promise<SessionCommitResult | null> => {
        const sid = sessionIdRef.current;
        if (!sid) return null;
        // Chặn commit chồng: nếu đang commit thì bỏ qua lần gọi này (commit-on-exit
        // chỉ gọi 1 lần, guard này chỉ phòng double-invoke hiếm).
        if (committingRef.current) return null;
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
            // Báo caller (ImpositionTab.onCommit → handleEditCommit) đổi pdfUrl sang
            // tile thật. Đây là RELOAD DUY NHẤT của cả phiên sửa — tại điểm thoát/Lưu.
            try { optsRef.current.onCommit?.(result); } catch { /* nuốt lỗi callback */ }
            return result;
        } catch (e) {
            if (e instanceof SessionGoneError) { markFailed(); return null; }
            // Commit thất bại → GIỮ NGUYÊN trạng thái phiên trong RAM để thử lại
            // (Yêu cầu 10.5); không xóa dirty.
            throw e;
        } finally {
            committingRef.current = false;
        }
    }, [request, jsonPost, setDirtyFlag, markFailed]);

    // ── Mở phiên ──────────────────────────────────────────────────────────────
    const openSession = useCallback(async (fid: string): Promise<number | null> => {
        if (!fid) return null;
        try {
            const data = await request('/open', jsonPost({ fid }));
            const sid: string = data?.session_id;
            if (!sid) throw new Error(t('hooks.useEditSession:open_thieu_session_id'));
            setSession(sid);
            setSessionFailed(false);
            setCanUndo(false);
            setCanRedo(false);
            setDirtyFlag(false);
            setPreviews([]); // phiên mới → không còn overlay của phiên trước.
            return typeof data?.page_count === 'number' ? data.page_count : 0;
        } catch (e) {
            // Mở thất bại (kể cả 410/404) → tín hiệu fallback Legacy (Yêu cầu 11.1).
            markFailed();
            return null;
        }
    }, [request, jsonPost, setSession, setDirtyFlag, markFailed]);

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
            setDirtyFlag(true);
            const outcomeKind = String(outcome.opResult?.kind || outcome.opResult?.action || "");
            const isLayerOp = outcomeKind.startsWith("layer");
            if (isLayerOp) {
                window.dispatchEvent(new CustomEvent("refresh-ocg-layers"));
            }
            if (outcomeKind === "objectVisibility") {
                const detail = outcome.opResult?.detail || {};
                window.dispatchEvent(new CustomEvent("edit-object-visibility-changed", {
                    detail: {
                        page: outcome.page,
                        targetIds: detail.target_ids || [],
                        visible: !!detail.visible,
                    },
                }));
            } else if (!isLayerOp || outcomeKind === "layerDelete") {
                // Hình học và xóa layer làm object/ID/membership đổi. Các thao tác layer khác chỉ refresh cây OCG.
                window.dispatchEvent(new CustomEvent("edit-session-objects-changed", {
                    detail: { page: outcome.page, path },
                }));
            }            // Đẩy lớp overlay: op áp trong RAM → render vùng clip. KHÔNG auto-commit ở
            // đây (trước kia debounce-commit sinh fid mới GIỮA lúc sửa → reopen session
            // reset op_log + swap tile reload → chính cái lag ta gỡ). Commit CHỈ khi
            // THOÁT edit mode / Lưu (commit-on-exit). Session sống suốt phiên sửa.
            if (outcome.preview) {
                setPreviews(prev => {
                    // Full-page mới thay thế toàn bộ overlay cũ của trang; clip trùng nhau
                    // cũng thay thế thay vì tích lũy ảnh Base64/DOM vô hạn.
                    const sameClip = (a: BBox | null, b: BBox | null) =>
                        a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.01));
                    const kept = prev.filter(p => outcome.full
                        ? p.page !== outcome.page
                        : p.page !== outcome.page || p.full || !sameClip(p.clipRect, outcome.clipRect));
                    return [...kept, {
                        url: outcome.preview, clipRect: outcome.clipRect,
                        full: outcome.full, page: outcome.page,
                    }];
                });
            }
            return outcome;
        } catch (e) {
            if (e instanceof SessionGoneError) { markFailed(); return null; }
            // Lỗi op (409/422/504...) → GIỮ NGUYÊN phiên + Op_Log (Yêu cầu 10.2, 10.3);
            // ném lại để caller hiển thị lỗi mà KHÔNG fallback.
            throw e;
        }
    }, [request, jsonPost, setDirtyFlag, markFailed]);

    const applyOp = useCallback((op: EditOp, scale: number = DEFAULT_RENDER_SCALE) =>
        runOp('/op', { op, render_scale: scale, clip_pad_pt: DEFAULT_CLIP_PAD_PT }),
        [runOp]);

    const undo = useCallback((scale: number = DEFAULT_RENDER_SCALE) =>
        runOp('/undo', { render_scale: scale, clip_pad_pt: DEFAULT_CLIP_PAD_PT }),
        [runOp]);

    const redo = useCallback((scale: number = DEFAULT_RENDER_SCALE) =>
        runOp('/redo', { render_scale: scale, clip_pad_pt: DEFAULT_CLIP_PAD_PT }),
        [runOp]);

    // ── Commit thủ công (người dùng Lưu / thoát edit mode — commit-on-exit) ─────
    const flatten = useCallback(async (): Promise<SessionCommitResult | null> => {
        const sid = sessionIdRef.current;
        if (!sid || committingRef.current) return null;
        committingRef.current = true;
        try {
            const data = await request('/flatten', jsonPost({ session_id: sid }));
            const result: SessionCommitResult = {
                success: !!data?.success,
                output_fid: data?.output_fid,
                output_url: data?.output_url,
                output_path: data?.output_path,
                output_filename: data?.output_filename,
            };
            setDirtyFlag(false);
            setCanUndo(false);
            setCanRedo(false);
            setPreviews([]);
            try { optsRef.current.onCommit?.(result); } catch { /* callback best-effort */ }
            return result;
        } catch (e) {
            if (e instanceof SessionGoneError) { markFailed(); return null; }
            throw e;
        } finally {
            committingRef.current = false;
        }
    }, [request, jsonPost, setDirtyFlag, markFailed]);

    const commit = useCallback(async (): Promise<SessionCommitResult | null> => {
        if (!sessionIdRef.current) return null;
        return doCommit();
    }, [doCommit]);

    /** Xóa mọi overlay xem-trước (gọi sau khi tile thật đã vào — pdfUrl đổi). */
    const clearPreviews = useCallback(() => setPreviews([]), []);

    // ── Đóng phiên ─────────────────────────────────────────────────────────────
    const closeSession = useCallback(async (): Promise<void> => {
        const sid = sessionIdRef.current;
        setSession(null);
        setCanUndo(false);
        setCanRedo(false);
        setDirtyFlag(false);
        setPreviews([]);
        if (!sid) return;
        try {
            await authenticatedFetch(`${getApiUrl()}/edit/session/${sid}`, { method: 'DELETE' });
        } catch {
            // Đóng best-effort: TTL backend sẽ tự dọn nếu DELETE thất bại (Yêu cầu 9.2).
        }
    }, [setSession, setDirtyFlag]);

    return {
        sessionId,
        sessionFailed,
        canUndo,
        canRedo,
        dirty,
        previews,
        openSession,
        applyOp,
        undo,
        redo,
        flatten,
        commit,
        clearPreviews,
        closeSession,
    };
}
