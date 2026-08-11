import { useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { uploadPDF } from '../lib/api';
import { useWorkingPdf } from '../hooks/useWorkingPdf';
import {
    useWorkspaceStore,
    workspaceDocumentIdentity,
} from '../stores/useWorkspaceStore';
import OutputPreviewTab from './OutputPreviewTab';

interface OutputPreviewHostProps {
    onFileFixed?: (blob: Blob, name: string) => void;
}

/**
 * Consumer hẹp cho trạng thái mở Output Preview.
 *
 * PERF (audit 2026-08-10 §OP.6): giữ subscription này ngoài ImpositionTabInner để
 * cú bấm mở panel không render lại shell chứa AcrobatViewer và toàn bộ cây trang.
 */
export default function OutputPreviewHost({ onFileFixed }: OutputPreviewHostProps) {
    const {
        showOutputPreview,
        file,
        selectionFileId,
        selectionDocumentIdentity,
        viewerPageOrder,
        viewerPageRotations,
        viewerPageCount,
        closeOutputPreview,
        setSelectionFileId,
        setSeparationPlates,
        setError,
    } = useWorkspaceStore(useShallow(state => ({
        showOutputPreview: state.showOutputPreview,
        file: state.file,
        selectionFileId: state.selectionFileId,
        selectionDocumentIdentity: state.selectionDocumentIdentity,
        viewerPageOrder: state.viewerPageOrder,
        viewerPageRotations: state.viewerPageRotations,
        viewerPageCount: state.viewerPageOrder?.length || 1,
        closeOutputPreview: state.closeOutputPreview,
        setSelectionFileId: state.setSelectionFileId,
        setSeparationPlates: state.setSeparationPlates,
        setError: state.setError,
    })));
    const getWorkingFile = useWorkingPdf();
    const documentIdentity = workspaceDocumentIdentity(
        file,
        viewerPageOrder,
        viewerPageRotations,
    );
    const reusableFileId = selectionFileId && (
        !selectionDocumentIdentity
        || selectionDocumentIdentity === documentIdentity
    ) ? selectionFileId : '';

    useEffect(() => {
        if (!showOutputPreview || reusableFileId || !file) return;
        if (!file.name.toLowerCase().endsWith('.pdf')) return;

        // UIUX (audit 2026-08-10 §OP.10): file mở bằng Open With/native drop có
        // path nhưng size=0 nên chủ đích bỏ pre-upload. Khi user mở Output Preview,
        // đăng ký/upload đúng lúc ngay trong host hẹp để không render lại shell Viewer.
        const controller = new AbortController();
        let cancelled = false;
        void getWorkingFile(file)
            .then(workingFile => {
                if (!workingFile) throw new Error('Không tạo được tài liệu PDF đang làm việc.');
                return uploadPDF(workingFile, { signal: controller.signal });
            })
            .then(result => {
                if (!cancelled && result?.id) {
                    setSelectionFileId(result.id, documentIdentity);
                }
            })
            .catch(error => {
                if (cancelled || controller.signal.aborted) return;
                setError(error instanceof Error ? error.message : String(error));
                closeOutputPreview();
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [
        closeOutputPreview,
        documentIdentity,
        file,
        getWorkingFile,
        reusableFileId,
        setError,
        setSelectionFileId,
        showOutputPreview,
    ]);

    const handleClose = useCallback(() => {
        closeOutputPreview();
    }, [closeOutputPreview]);

    if (!showOutputPreview) return null;
    if (!reusableFileId) {
        // Panel shell hiện ngay; phần nội dung sẽ stream vào sau khi chỉ tác vụ
        // thật sự cần Working PDF/upload hoàn tất.
        return (
            <div
                data-output-preview-loading="true"
                aria-busy="true"
                className="absolute right-[60px] top-[10px] z-[9999] flex h-28 w-[380px] items-center justify-center rounded-2xl border border-slate-200/80 bg-white shadow-xl dark:border-zinc-700/80 dark:bg-zinc-900"
            >
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                <button
                    type="button"
                    aria-label="Đóng xem trước bản in"
                    onClick={handleClose}
                    className="absolute right-3 top-2 h-7 w-7 rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                    ×
                </button>
            </div>
        );
    }

    return (
        <OutputPreviewTab
            fileId={reusableFileId}
            initialPageNum={1}
            totalPages={viewerPageCount}
            onClose={handleClose}
            onPlatesChange={setSeparationPlates}
            onFileFixed={onFileFixed}
        />
    );
}
