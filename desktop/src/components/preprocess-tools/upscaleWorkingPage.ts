import { getFileArrayBuffer } from '../../lib/utils';

// Raster 1 px/pt = 72 DPI; backend nhân DPI cùng scaleFactor nên PDF kết quả
// giữ nguyên kích thước vật lý sau ×2/×4.
const UPSCALE_WORKING_PAGE_SCALE = 1;

interface PdfJsPage {
    getViewport: (options: { scale: number; rotation?: number }) => {
        width: number;
        height: number;
    };
    render: (options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: unknown;
    }) => {
        promise: Promise<unknown>;
        cancel: () => void;
    };
}

interface PdfJsDocument {
    numPages: number;
    getPage: (pageNumber: number) => Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
    promise: Promise<PdfJsDocument>;
    destroy: () => Promise<void>;
}

function aborted(): DOMException {
    return new DOMException('Đã hủy raster trang PDF.', 'AbortError');
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('Không tạo được ảnh PNG từ trang PDF.'));
        }, 'image/png');
    });
}

/**
 * REVISION (audit 2026-08-25 §REV.06): chỉ raster sau khi người dùng bấm Chạy.
 * PDF đầu vào đã bake order/rotation/edit; pageNumber là vị trí trong Working PDF.
 */
export async function rasterizeUpscaleWorkingPage(
    workingFile: File,
    pageNumber: number,
    signal?: AbortSignal,
    sourcePixelsPerPoint = UPSCALE_WORKING_PAGE_SCALE,
): Promise<File> {
    if (signal?.aborted) throw aborted();
    const bytes = await getFileArrayBuffer(workingFile);
    if (signal?.aborted) throw aborted();

    const [pdfjs, workerModule] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
    }

    const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(bytes),
    }) as unknown as PdfJsLoadingTask;
    let canvas: HTMLCanvasElement | null = null;
    try {
        const pdfDocument = await loadingTask.promise;
        if (signal?.aborted) throw aborted();
        if (pdfDocument.numPages < 1) throw new Error('PDF làm việc không có trang để phóng to.');

        const activePage = Math.max(1, Math.min(pdfDocument.numPages, Math.trunc(pageNumber) || 1));
        const page = await pdfDocument.getPage(activePage);
        if (signal?.aborted) throw aborted();
        // Không ép rotation=0: Working PDF bake quick-rotate vào /Rotate của trang.
        const renderScale = Number.isFinite(sourcePixelsPerPoint) && sourcePixelsPerPoint > 0
            ? sourcePixelsPerPoint
            : UPSCALE_WORKING_PAGE_SCALE;
        const viewport = page.getViewport({ scale: renderScale });
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Không tạo được bộ đệm raster trang PDF.');

        const renderTask = page.render({ canvasContext: context, viewport });
        const cancelRender = () => renderTask.cancel();
        signal?.addEventListener('abort', cancelRender, { once: true });
        try {
            await renderTask.promise;
        } catch (error) {
            if (signal?.aborted) throw aborted();
            throw error;
        } finally {
            signal?.removeEventListener('abort', cancelRender);
        }
        if (signal?.aborted) throw aborted();

        const blob = await canvasToPng(canvas);
        if (signal?.aborted) throw aborted();
        const stem = workingFile.name.replace(/\.pdf$/i, '').replace(/\.[^/.]+$/, '') || 'tai_lieu';
        return new File([blob], `${stem}_trang_${activePage}.png`, {
            type: 'image/png',
            lastModified: Date.now(),
        });
    } finally {
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
        await loadingTask.destroy();
    }
}
