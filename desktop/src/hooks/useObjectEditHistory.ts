import { useCallback, useContext } from 'react';
import { WorkspaceContext, useWorkspaceStore } from '../stores/useWorkspaceStore';
import { authenticatedFetch, getApiUrl } from '../lib/api';

/**
 * useObjectEditHistory — Undo/Redo cho chế độ "Chỉnh sửa đối tượng" (pdf-object-edit).
 *
 * VÌ SAO RIÊNG: thao tác edit object (move/delete/rotate/resize/text/add) commit ra
 * một Working_File MỚI và đổi cả `file`, `pdfUrl`, `selectionFileId`. Undo đúng cần
 * khôi phục CẢ BA (đặc biệt `selectionFileId` — fid để /edit/objects + op kế tiếp trỏ
 * đúng file). `useViewerHotkeys.undo` (pastStack) chỉ lo thao tác TRANG, còn nút Undo
 * cam (`history`) chỉ lưu File nên không đủ. Hook này lưu snapshot {file,pdfUrl,fid}.
 *
 * Khôi phục được đánh dấu `__editCommit` trên File → viewer KHÔNG full-reload (mượt).
 *
 * Store theo CONTEXT (per-tab) → lấy StoreApi qua `WorkspaceContext` để getState().
 */
export interface EditSnap {
    file: File | null;
    pdfUrl: string | null;
    fid: string;
}

// Giới hạn số bước undo để tránh phình RAM (mỗi snapshot giữ 1 File object).
const MAX_EDIT_HISTORY = 30;

/**
 * Dọn các Working_File trung gian không còn cần (best-effort, fire-and-forget).
 * KHÔNG xoá file đang là `currentFid` (đang hiển thị). Backend tự bảo vệ: chỉ
 * xoá file trong thư mục edit_output, không đụng file gốc.
 */
function _discardWorkingFiles(fids: (string | null)[], currentFid: string) {
    const seen = new Set<string>();
    for (const fid of fids) {
        if (!fid || fid === currentFid || seen.has(fid)) continue;
        seen.add(fid);
        void authenticatedFetch(`${getApiUrl()}/edit/working/${fid}`, { method: 'DELETE' }).catch(() => {});
    }
}

function markEditCommit(f: File | null) {
    if (!f) return;
    try {
        if (!(f as any).__editCommit) {
            Object.defineProperty(f, '__editCommit', { value: true, configurable: true });
        }
    } catch {
        /* property đã tồn tại / không cấu hình được — bỏ qua an toàn */
    }
}

export function useObjectEditHistory() {
    const store = useContext(WorkspaceContext);
    // Đếm reactive để bật/tắt nút Undo/Redo.
    const canUndo = useWorkspaceStore(s => s.objectEditPast.length > 0);
    const canRedo = useWorkspaceStore(s => s.objectEditFuture.length > 0);

    const pushSnapshot = useCallback((snap: EditSnap) => {
        if (!store) return;
        const st = store.getState();
        // Cắt bớt đầu stack khi vượt trần; thao tác mới làm mất redo → các snapshot
        // bị loại (cũ quá / redo bị huỷ) sẽ KHÔNG bao giờ khôi phục lại được nữa →
        // dọn Working_File trung gian tương ứng (backend chỉ xoá file trong edit_output).
        const all = [...st.objectEditPast, snap];
        let dropped: EditSnap[] = [];
        let kept = all;
        if (all.length > MAX_EDIT_HISTORY) {
            dropped = all.slice(0, all.length - MAX_EDIT_HISTORY);
            kept = all.slice(all.length - MAX_EDIT_HISTORY);
        }
        const orphanedFuture = st.objectEditFuture;
        st.setObjectEditPast(kept);
        st.setObjectEditFuture([]);
        _discardWorkingFiles(
            [...dropped, ...orphanedFuture].map(s => s.fid),
            st.selectionFileId,
        );
    }, [store]);

    const applySnap = useCallback((snap: EditSnap) => {
        if (!store) return;
        const st = store.getState();
        markEditCommit(snap.file);
        if (snap.file) st.setFile(snap.file);
        st.setPdfUrl(snap.pdfUrl);
        st.setSelectionFileId(snap.fid || '');
        st.setIsSaved(false);
    }, [store]);

    const undo = useCallback(() => {
        if (!store) return false;
        const st = store.getState();
        const p = st.objectEditPast;
        if (p.length === 0) return false;
        const prev = p[p.length - 1];
        const cur: EditSnap = { file: st.file, pdfUrl: st.pdfUrl, fid: st.selectionFileId };
        st.setObjectEditFuture([cur, ...st.objectEditFuture]);
        st.setObjectEditPast(p.slice(0, -1));
        applySnap(prev);
        return true;
    }, [store, applySnap]);

    const redo = useCallback(() => {
        if (!store) return false;
        const st = store.getState();
        const fz = st.objectEditFuture;
        if (fz.length === 0) return false;
        const next = fz[0];
        const cur: EditSnap = { file: st.file, pdfUrl: st.pdfUrl, fid: st.selectionFileId };
        st.setObjectEditPast([...st.objectEditPast, cur]);
        st.setObjectEditFuture(fz.slice(1));
        applySnap(next);
        return true;
    }, [store, applySnap]);

    return { undo, redo, canUndo, canRedo, pushSnapshot };
}
