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
import { useCallback, useRef, useState } from 'react';
import { authenticatedFetch, getApiUrl } from '../lib/api';
import type { EditOp, BBox } from '../components/workspace/editTypes';
import { useTranslation } from 'react-i18next';

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
    opResult: SessionOpResult;
    canUndo: boolean;
    canRedo: boolean;
}

/** Kiểu chi tiết riêng của event objectVisibility sau khi narrow tại điểm dùng. */
interface ObjectVisibilityDetail {
    target_ids?: string[];
    visible?: boolean;
}

/** Payload động theo loại EditOp; backend có thể trả dict/list lồng nhau. */
interface SessionOpResult {
    [key: string]: unknown;
}

/** Hợp đồng JSON dùng chung cho các endpoint của edit session. */
interface SessionApiResponse {
    session_id?: string;
    page_count?: number;
    success?: boolean;
    preview?: string | null;
    clipRect?: unknown;
    full?: boolean;
    page?: number | null;
    opResult?: SessionOpResult;
    canUndo?: boolean;
    canRedo?: boolean;
    output_fid?: string;
    output_url?: string;
    output_path?: string;
    output_filename?: string;
    artifact_lease?: string;
    warning?: string | null;
    closed?: boolean;
    [key: string]: unknown;
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
    /** Token bí mật giữ Working File backend sống theo owner tab. */
    artifact_lease?: string;
    /**
     * Cảnh báo suy giảm chất lượng dù thao tác THÀNH CÔNG. Hiện có: flatten phải
     * raster hoá nên file ra mất vector/CMYK/màu pha (Pantone, kênh bế). Bắt buộc
     * hiện lên UI — success=true kèm file mất màu pha mà im lặng là fail-open.
     */
    warning?: string | null;
}

export interface UseEditSessionOptions {
    /** Phạm vi tab cho các tín hiệu đồng bộ UI vẫn dùng CustomEvent. */
    eventScopeId?: string;
    /** Override ngưỡng debounce-commit (ms). */
    debounceCommitMs?: number;
    /** Gọi khi 1 lần debounce-commit (tự động) hoàn tất → FE đổi sang tile thật.
     *  RECIPE (audit 2026-08-17 §REC.11A): cho phép trả Promise để lifecycle await
     *  consumer publish xong trước khi kết thúc commit. */
    onCommit?: (result: SessionCommitResult) => void | Promise<void>;
    /**
     * REVISION (audit 2026-08-25 §REV.03): báo trước khi gửi mỗi op/undo/redo
     * để kết quả tool đang chạy trên revision cũ bị vô hiệu ngay lập tức.
     */
    onEditRevisionStart?: () => void;
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
    const commitPromiseRef = useRef<Promise<SessionCommitResult | null> | null>(null);
    const pendingOperationCountRef = useRef(0);
    const operationDrainWaitersRef = useRef<Array<() => void>>([]);
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

    const waitForPendingOperations = useCallback((): Promise<void> => {
        if (pendingOperationCountRef.current === 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            operationDrainWaitersRef.current.push(resolve);
        });
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
    ): Promise<SessionApiResponse> => {
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
        // REVISION (audit 2026-08-25 §REV.01-02): mọi consumer cùng await đúng
        // commit đang bay. Trả null ở đây từng làm Crop/tool đọc backing PDF cũ.
        if (commitPromiseRef.current) return commitPromiseRef.current;
        const sid = sessionIdRef.current;
        if (!sid) return null;

        const pending = (async (): Promise<SessionCommitResult | null> => {
            // Op cuối có thể chưa kịp đặt dirty=true. Chờ response và publish
            // overlay/state trước khi quyết định phiên có cần commit hay không.
            await waitForPendingOperations();
            if (sessionIdRef.current !== sid) {
                throw new Error(t('hooks.useEditSession:phien_chinh_sua_da_het_han', {
                    defaultValue: 'Phiên chỉnh sửa PDF đã hết hạn. Thay đổi chưa được chốt; vui lòng thử lại.',
                }));
            }
            if (!dirtyRef.current) return null;
            // committingRef không có commitPromise chỉ có thể là luồng Flatten.
            if (committingRef.current) return null;
            committingRef.current = true;
            try {
                const data = await request('/commit', jsonPost({ session_id: sid }));
                const result: SessionCommitResult = {
                    success: !!data?.success,
                    output_fid: data?.output_fid,
                    output_url: data?.output_url,
                    output_path: data?.output_path,
                    output_filename: data?.output_filename,
                    artifact_lease: data?.artifact_lease,
                };
                if (
                    !result.success
                    || !result.output_fid
                    || !result.output_url
                    || !result.output_path
                    || !result.output_filename
                    || !result.artifact_lease
                ) {
                    throw new Error(t('hooks.useEditSession:commit_thieu_artifact', {
                        defaultValue: 'Edit PDF không trả đủ Working File mới. Phiên được giữ lại để thử lại.',
                    }));
                }
                // Await consumer publish Working File; barrier chỉ mở sau khi file mới
                // đã vào store, không chỉ sau khi backend trả response.
                await optsRef.current.onCommit?.(result);
                setDirtyFlag(false);
                return result;
            } catch (e) {
                if (e instanceof SessionGoneError) {
                    markFailed();
                    throw new Error(t('hooks.useEditSession:phien_chinh_sua_da_het_han', {
                        defaultValue: 'Phiên chỉnh sửa PDF đã hết hạn. Thay đổi chưa được chốt; vui lòng thử lại.',
                    }));
                }
                // Commit thất bại → GIỮ NGUYÊN trạng thái phiên trong RAM để thử lại.
                throw e;
            } finally {
                committingRef.current = false;
            }
        })();
        commitPromiseRef.current = pending;
        try {
            return await pending;
        } finally {
            if (commitPromiseRef.current === pending) commitPromiseRef.current = null;
        }
    }, [request, jsonPost, setDirtyFlag, markFailed, waitForPendingOperations, t]);

    // ── Mở phiên ──────────────────────────────────────────────────────────────
    const openSession = useCallback(async (fid: string): Promise<number | null> => {
        if (!fid) return null;
        try {
            const data = await request('/open', jsonPost({ fid }));
            const sid = data?.session_id;
            if (!sid) throw new Error(t('hooks.useEditSession:open_thieu_session_id'));
            setSession(sid);
            setSessionFailed(false);
            setCanUndo(false);
            setCanRedo(false);
            setDirtyFlag(false);
            setPreviews([]); // phiên mới → không còn overlay của phiên trước.
            return typeof data?.page_count === 'number' ? data.page_count : 0;
        } catch {
            // Mở thất bại (kể cả 410/404) → tín hiệu fallback Legacy (Yêu cầu 11.1).
            markFailed();
            return null;
        }
    }, [request, jsonPost, setSession, setDirtyFlag, markFailed, t]);

    // ── Áp Edit_Op / Undo / Redo ───────────────────────────────────────────────
    const runOp = useCallback(async (
        path: '/op' | '/undo' | '/redo',
        body: Record<string, unknown>,
    ): Promise<SessionOpOutcome | null> => {
        const sid = sessionIdRef.current;
        if (!sid || commitPromiseRef.current) return null;
        pendingOperationCountRef.current += 1;
        try {
            optsRef.current.onEditRevisionStart?.();
        } catch {
            // Fence revision là bảo vệ phụ; callback UI không được làm mất thao tác edit.
        }
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
                window.dispatchEvent(new CustomEvent("refresh-ocg-layers", { detail: { tabId: optsRef.current.eventScopeId } }));
            }
            if (outcomeKind === "objectVisibility") {
                const detail = (outcome.opResult?.detail ?? {}) as ObjectVisibilityDetail;
                window.dispatchEvent(new CustomEvent("edit-object-visibility-changed", {
                    detail: {
                        ...(optsRef.current.eventScopeId ? { tabId: optsRef.current.eventScopeId } : {}),
                        page: outcome.page,
                        targetIds: detail.target_ids || [],
                        visible: !!detail.visible,
                    },
                }));
            } else if (!isLayerOp || outcomeKind === "layerDelete") {
                // Hình học và xóa layer làm object/ID/membership đổi. Các thao tác layer khác chỉ refresh cây OCG.
                window.dispatchEvent(new CustomEvent("edit-session-objects-changed", {
                    detail: {
                        ...(optsRef.current.eventScopeId ? { tabId: optsRef.current.eventScopeId } : {}),
                        page: outcome.page,
                        path,
                        kind: String((body.op as EditOp | undefined)?.kind || ''),
                        targetIds: (body.op as EditOp | undefined)?.targetIds || [],
                    },
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
        } finally {
            pendingOperationCountRef.current = Math.max(0, pendingOperationCountRef.current - 1);
            if (pendingOperationCountRef.current === 0) {
                const waiters = operationDrainWaitersRef.current.splice(0);
                waiters.forEach(resolve => resolve());
            }
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
        if (commitPromiseRef.current) return commitPromiseRef.current;
        const sid = sessionIdRef.current;
        if (!sid) return null;
        const pending = (async (): Promise<SessionCommitResult | null> => {
            // REVISION (audit 2026-08-25 §REV.01-02): Flatten cũng là một lần
            // publish Working File; commit/chuyển tool phải join cùng Promise này.
            await waitForPendingOperations();
            if (sessionIdRef.current !== sid) {
                throw new Error(t('hooks.useEditSession:phien_chinh_sua_da_het_han', {
                    defaultValue: 'Phiên chỉnh sửa PDF đã hết hạn. Thay đổi chưa được chốt; vui lòng thử lại.',
                }));
            }
            if (committingRef.current) return null;
            committingRef.current = true;
        try {
            const data = await request('/flatten', jsonPost({ session_id: sid }));
            const result: SessionCommitResult = {
                success: !!data?.success,
                output_fid: data?.output_fid,
                output_url: data?.output_url,
                output_path: data?.output_path,
                output_filename: data?.output_filename,
                artifact_lease: data?.artifact_lease,
                warning: data?.warning ?? null,
            };
            if (
                !result.success
                || !result.output_fid
                || !result.output_url
                || !result.output_path
                || !result.output_filename
                || !result.artifact_lease
            ) {
                throw new Error(t('hooks.useEditSession:commit_thieu_artifact', {
                    defaultValue: 'Edit PDF không trả đủ Working File mới. Phiên được giữ lại để thử lại.',
                }));
            }
            await optsRef.current.onCommit?.(result);
            setDirtyFlag(false);
            setCanUndo(false);
            setCanRedo(false);
            setPreviews([]);
            return result;
        } catch (e) {
            if (e instanceof SessionGoneError) {
                markFailed();
                throw new Error(t('hooks.useEditSession:phien_chinh_sua_da_het_han', {
                    defaultValue: 'Phiên chỉnh sửa PDF đã hết hạn. Thay đổi chưa được chốt; vui lòng thử lại.',
                }));
            }
            throw e;
        } finally {
            committingRef.current = false;
        }
        })();
        commitPromiseRef.current = pending;
        try {
            return await pending;
        } finally {
            if (commitPromiseRef.current === pending) commitPromiseRef.current = null;
        }
    }, [request, jsonPost, setDirtyFlag, markFailed, waitForPendingOperations, t]);

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
