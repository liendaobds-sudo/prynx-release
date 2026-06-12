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
        const hasRotEdits = !!(viewerPageRotations && Object.keys(viewerPageRotations).length > 0);
        if (!hasOrderEdits && !hasRotEdits) return file;

        const rotations = viewerPageRotations || {};
        const arrayBuffer = await getFileArrayBuffer(file);
        const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const newDoc = await PDFDocument.create();

        const order = (viewerPageOrder && viewerPageOrder.length > 0)
            ? viewerPageOrder
            : srcDoc.getPageIndices().map(i => i + 1);

        for (const pIdx of order) {
            if (pIdx === -1) {
                const firstPage = srcDoc.getPages()[0];
                const dim = firstPage
                    ? { w: firstPage.getSize().width, h: firstPage.getSize().height }
                    : { w: 595.28, h: 841.89 };
                newDoc.addPage([dim.w, dim.h]);
            } else {
                const [copiedPage] = await newDoc.copyPages(srcDoc, [pIdx - 1]);
                const rot = rotations[pIdx];
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
