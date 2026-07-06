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
 */
import { useCallback } from 'react';
import { PDFDocument, degrees } from 'pdf-lib';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { getFileArrayBuffer } from '../lib/utils';

export function useWorkingPdf(): () => Promise<File | null> {
    const file = useWorkspaceStore(state => state.file);
    const viewerPageOrder = useWorkspaceStore(state => state.viewerPageOrder);
    const viewerPageRotations = useWorkspaceStore(state => state.viewerPageRotations);

    return useCallback(async (): Promise<File | null> => {
        if (!file) return null;

        const hasOrderEdits = !!(viewerPageOrder && viewerPageOrder.length > 0);
        // viewerPageRotations là number[] THEO VỊ TRÍ (luôn đầy độ dài, kể cả toàn 0 khi
        // chưa xoay gì) → KHÔNG dùng .length/keys để đoán "có sửa" (sẽ bật oan → bake thừa).
        // Kiểm CÓ GÓC KHÁC 0. Dữ liệu cũ Record<pageNum,deg> thì Object.values cũng chạy.
        const hasRotEdits = !!(viewerPageRotations && Object.values(viewerPageRotations).some((r: any) => (((r as number) % 360) + 360) % 360 !== 0));
        if (!hasOrderEdits && !hasRotEdits) return file;

        const rotations = viewerPageRotations || {};
        const arrayBuffer = await getFileArrayBuffer(file);
        const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const newDoc = await PDFDocument.create();

        const order = (viewerPageOrder && viewerPageOrder.length > 0)
            ? viewerPageOrder
            : srcDoc.getPageIndices().map(i => i + 1);

        // rotations là number[] THEO VỊ TRÍ (out[i] = góc trang ở vị trí i) — khớp
        // per-instance rotation (bản nhân bản xoay độc lập). Đọc theo index vòng lặp,
        // KHÔNG theo số trang gốc pIdx (nhiều vị trí có thể cùng pIdx). Fallback: nếu
        // dữ liệu cũ là Record<pageNum,deg> thì rotations[pIdx] vẫn hoạt động do JS
        // index bằng key số/chuỗi — nhưng bản mới luôn là mảng.
        const rotAt = (i: number, pIdx: number): number => {
            if (Array.isArray(rotations)) return rotations[i] || 0;
            return (rotations as Record<number, number>)[pIdx] || 0;
        };
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
                const rot = rotAt(i, pIdx);
                if (rot) {
                    const currentRot = copiedPage.getRotation().angle;
                    copiedPage.setRotation(degrees(currentRot + rot));
                }
                newDoc.addPage(copiedPage);
            }
        }

        const pdfBytes = await newDoc.save();
        return new File([pdfBytes as any], file.name, { type: 'application/pdf' });
    }, [file, viewerPageOrder, viewerPageRotations]);
}
