/**
 * useWorkingPdf — Trả về hàm lấy File "kết quả cuối cùng" để các tác vụ xử lý.
 *
 * Quy tắc tuân thủ kết quả cuối cùng: khi người dùng đã sửa trang trong viewer
 * (xóa / xoay / sắp xếp lại — lưu ở viewerPageOrder / viewerPageRotations), MỌI
 * tác vụ tiếp theo (Convert Colors, PDF/X, Trapping, OCR, Optimize, Sticker,
 * Watermark, Preflight...) phải xử lý trên BẢN ĐÃ CHỈNH, không phải file gốc.
 *
 * Dùng chung qua hook này thay vì truyền prop qua nhiều tầng. Nếu không có sửa
 * đổi nào, trả lại file gốc (bảo toàn .path để backend nạp nhanh qua native path).
 *
 * Identity order = [1,2,...,N] với N = số trang FILE GỐC (disk), KHÔNG phải
 * viewerNumPages sau xóa. Xóa đuôi 10→4 còn [1,2,3,4] vẫn phải bake (bug preview
 * ratio_stack/N-Up vẫn thấy 10 loại).
 */
import { useContext, useMemo } from 'react';
import { PDFDocument, degrees } from 'pdf-lib';
import {
    WorkspaceContext,
    captureWorkspaceDocumentRevision,
    isWorkspaceDocumentRevisionCurrent,
    type WorkspaceDocumentRevisionToken,
} from '../stores/useWorkspaceStore';
import { getFileArrayBuffer } from '../lib/utils';
import {
    beginOptionalContentTransfer,
    finishOptionalContentTransfer,
} from '../lib/pdfOptionalContent';

// PERF (audit 2026-08-10 §PPE.REAUDIT.5): các tool dùng hook riêng nhưng cùng
// một File object. WeakMap chia sẻ đúng metadata nhỏ, tự giải phóng theo File và
// không giữ byte PDF trong cache toàn cục.
const sourcePageCountPromises = new WeakMap<File, Promise<number>>();

function resolveSourcePageCount(f: File): Promise<number> {
    const cached = sourcePageCountPromises.get(f);
    if (cached) return cached;
    const pending = getFileArrayBuffer(f)
        .then(ab => PDFDocument.load(ab, { ignoreEncryption: true }))
        .then(doc => doc.getPageCount());
    sourcePageCountPromises.set(f, pending);
    void pending.catch(() => sourcePageCountPromises.delete(f));
    return pending;
}

export interface WorkingPdfRevisionSnapshot extends WorkspaceDocumentRevisionToken {
    readonly file: File;
}

export interface WorkingPdfResolver {
    (sourceFile?: File | null): Promise<File | null>;
    prepare: () => Promise<void>;
    resolveUnprepared: (sourceFile?: File | null) => Promise<File | null>;
    capture: (sourceFile?: File | null) => WorkingPdfRevisionSnapshot | null;
    materialize: (snapshot: WorkingPdfRevisionSnapshot) => Promise<File>;
    isCurrent: (snapshot: WorkingPdfRevisionSnapshot) => boolean;
}

export async function materializeWorkingPdfRevision(
    snapshot: WorkingPdfRevisionSnapshot,
): Promise<File> {
        const activeFile = snapshot.file;
        const viewerPageOrder = snapshot.viewerPageOrder;
        const viewerPageRotations = snapshot.viewerPageRotations;

        // Góc xoay khác 0 đã đủ chứng minh cần Working PDF; không đọc cả file chỉ
        // để đếm trang trước khi làm một việc chắc chắn phải materialize.
        const hasRotEdits = !!(
            viewerPageRotations
            && Object.values(viewerPageRotations).some(
                r => ((r % 360) + 360) % 360 !== 0,
            )
        );
        let hasOrderEdits = false;
        if (viewerPageOrder && viewerPageOrder.length > 0) {
            const isIdentityPrefix = viewerPageOrder.every(
                (p: number, i: number) => p === i + 1,
            );
            if (!isIdentityPrefix) {
                // Reorder/duplicate/trang trắng (-1) nhìn thấy ngay từ state.
                hasOrderEdits = true;
            } else if (!hasRotEdits) {
                // Chỉ ca xóa các trang cuối mới cần đọc source count để phân biệt
                // [1..N] thật với một prefix đã bị cắt ngắn.
                const srcCount = await resolveSourcePageCount(activeFile);
                hasOrderEdits = viewerPageOrder.length !== srcCount;
            }
        }

        // viewerPageRotations là number[] THEO VỊ TRÍ (luôn đầy độ dài, kể cả toàn 0 khi
        // chưa xoay gì) → KHÔNG dùng .length/keys để đoán "có sửa" (sẽ bật oan → bake thừa).
        // Kiểm CÓ GÓC KHÁC 0. Dữ liệu cũ Record<pageNum,deg> thì Object.values cũng chạy.
        if (!hasOrderEdits && !hasRotEdits) return activeFile;

        const rotations = viewerPageRotations || [];
        const arrayBuffer = await getFileArrayBuffer(activeFile);
        const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const newDoc = await PDFDocument.create();

        // [OCG FIX 2026-07-28] copyPages bỏ /OCProperties ở catalog trong khi content vẫn
        // còn /OC … BDC → layer thợ đã ẩn trong Illustrator hiện lại hết ngay trên khung xem
        // và lọt vào bản in. srcDoc là bản load cục bộ nên không cần try/finally dọn dấu.
        const ocTransfer = beginOptionalContentTransfer([srcDoc]);

        const order = (viewerPageOrder && viewerPageOrder.length > 0)
            ? viewerPageOrder
            : srcDoc.getPageIndices().map(i => i + 1);

        // rotations là number[] THEO VỊ TRÍ (out[i] = góc trang ở vị trí i) — khớp
        // per-instance rotation (bản nhân bản xoay độc lập). Đọc theo index vòng lặp,
        // KHÔNG theo số trang gốc pIdx (nhiều vị trí có thể cùng pIdx). Fallback: nếu
        // Snapshot mới luôn lưu rotation theo vị trí/instance.
        const rotAt = (i: number): number => rotations[i] || 0;
        for (let i = 0; i < order.length; i++) {
            const pIdx = order[i];
            if (pIdx === -1) {
                const firstPage = srcDoc.getPages()[0];
                const dim = firstPage
                    ? { w: firstPage.getSize().width, h: firstPage.getSize().height }
                    : { w: 595.28, h: 841.89 };
                newDoc.addPage([dim.w, dim.h]);
            } else {
                const [copiedPage] = await newDoc.copyPages(srcDoc, [pIdx - 1]);
                const rot = rotAt(i);
                if (rot) {
                    const currentRot = copiedPage.getRotation().angle;
                    copiedPage.setRotation(degrees(currentRot + rot));
                }
                newDoc.addPage(copiedPage);
            }
        }

        finishOptionalContentTransfer(ocTransfer, newDoc);
        const pdfBytes = await newDoc.save();
        return new File([new Uint8Array(pdfBytes)], activeFile.name, { type: 'application/pdf' });
}

export function useWorkingPdf(): WorkingPdfResolver {
    const store = useContext(WorkspaceContext);
    if (!store) throw new Error('Missing WorkspaceContext.Provider in the tree');

    return useMemo(() => {
        const prepare = async (): Promise<void> => {
            // REVISION (audit 2026-08-25 §REV.01): resolve Working PDF chỉ bắt
            // đầu sau khi edit-object pending đã commit và publish vào store.
            await store.getState().documentPreparationBarrier?.();
        };
        const capture = (sourceFile?: File | null): WorkingPdfRevisionSnapshot | null => {
            const state = store.getState();
            const activeFile = sourceFile === undefined ? state.file : sourceFile;
            if (!activeFile) return null;
            return captureWorkspaceDocumentRevision(
                state,
                activeFile,
            ) as WorkingPdfRevisionSnapshot;
        };

        const resolve = async (sourceFile?: File | null): Promise<File | null> => {
            // REVISION (audit 2026-08-25 §REV.01-03): barrier có thể publish một
            // File mới. Nếu caller truyền đúng File đang mở trước barrier thì phải
            // rebase sang File mới; chỉ giữ sourceFile khi đó là nguồn ngoài độc lập.
            const beforeFile = store.getState().file;
            await prepare();
            const rebasedSource = sourceFile === undefined || sourceFile === beforeFile
                ? store.getState().file
                : sourceFile;
            const snapshot = capture(rebasedSource);
            return snapshot ? materializeWorkingPdfRevision(snapshot) : null;
        };

        const resolveUnprepared = async (sourceFile?: File | null): Promise<File | null> => {
            // Preview chỉ đọc revision đã publish; tuyệt đối không tự chốt Edit PDF
            // vì render xem trước không phải hành động chạy công cụ.
            const snapshot = capture(sourceFile);
            return snapshot ? materializeWorkingPdfRevision(snapshot) : null;
        };

        return Object.assign(resolve, {
            prepare,
            resolveUnprepared,
            capture,
            materialize: materializeWorkingPdfRevision,
            isCurrent: (snapshot: WorkingPdfRevisionSnapshot) => (
                isWorkspaceDocumentRevisionCurrent(snapshot, store.getState())
            ),
        });
    }, [store]);
}
