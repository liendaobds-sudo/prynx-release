/**
 * warmupPdfjs — Khởi động trước (warm-up) pdfjs worker lúc app rảnh.
 *
 * Cold-start của pdfjs (tải + khởi tạo worker, dựng font/cmap lần đầu) tốn
 * vài giây và chỉ xảy ra ở LẦN getDocument ĐẦU TIÊN. Nếu ta âm thầm chạy một
 * tài liệu trắng tí hon ngay khi app khởi động (trong thời gian idle), worker
 * sẽ "nóng" sẵn → mọi lần mở/tạo PDF sau đó (qua pdfjs) gần như tức thì.
 *
 * pdfjs-dist là ES module singleton: workerSrc set ở đây dùng chung cho cả
 * AcrobatViewer, nên không bị trùng/đụng cấu hình.
 */
let warmed = false;
let pdfiumWarmed = false;
let chunksWarmed = false;

/**
 * Preload các CHUNK workspace nặng lúc app rảnh (màn hình Home).
 *
 * Mở file lần đầu trong phiên phải nạp + (ở DEV mode) vite BIÊN DỊCH ON-DEMAND cả
 * cây component nặng: ImpositionTab → AcrobatViewer → LivePageFrame + react-pdf/pdfjs
 * + tool con → đo được ~7s "treo" lần mở đầu (UI thread bận đánh giá khối JS lớn).
 * Import sẵn lúc idle → vite biên dịch + webview eval TRƯỚC, nên lần mở file đầu tiên
 * không còn phải chờ. (Production: chỉ là prefetch chunk, rẻ.)
 */
export async function warmupWorkspaceChunks(): Promise<void> {
    if (chunksWarmed) return;
    chunksWarmed = true;
    try {
        await Promise.all([
            import('../components/ImpositionTab'),
            import('../components/AcrobatViewer'),
            import('../components/workspace/LivePageFrame'),
        ]);
    } catch (e) {
        chunksWarmed = false;
    }
}

/**
 * Warm-up engine pdfium NATIVE (Tauri) — đây là engine render chính của view.
 * Lần đầu bind thư viện pdfium + nạp doc tốn 1.5–3s; warm sẵn lúc idle để mọi
 * lần mở file sau đều "nóng" (~150ms).
 */
export async function warmupPdfium(): Promise<void> {
    if (pdfiumWarmed) return;
    if (!(window as any).__TAURI_INTERNALS__) return;
    pdfiumWarmed = true;
    try {
        const { createBlankPdfFile } = await import('./createBlankPdf');
        const f = await createBlankPdfFile({ widthMm: 50, heightMm: 50 });
        const path = (f as any).path;
        if (!path) return;
        const { invoke } = await import('@tauri-apps/api/core');
        // get_pdf_metadata vừa bind pdfium vừa nạp doc vào cache → làm nóng engine.
        await invoke('get_pdf_metadata', { filePath: path });
    } catch (e) {
        pdfiumWarmed = false;
    }
}

export async function warmupPdfjs(): Promise<void> {
    if (warmed) return;
    warmed = true;
    try {
        const pdfjs = await import('pdfjs-dist');
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
            pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        }

        // Tạo PDF trắng tí hon trong bộ nhớ để kích hoạt worker.
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.create();
        doc.addPage([200, 200]);
        const bytes = await doc.save();

        const task = pdfjs.getDocument({ data: bytes.slice() });
        const pdf = await task.promise;
        await pdf.getPage(1);
        await pdf.destroy();
    } catch (e) {
        // Warm-up thất bại không sao — chỉ mất lợi ích tối ưu, app vẫn chạy.
        warmed = false;
    }
}

/** Lên lịch warm-up vào thời điểm app rảnh (sau first paint). */
export function scheduleWarmupPdfjs(): () => void {
    const run = () => {
        // ƯU TIÊN #1: nạp + parse khối JS workspace NGAY. Đây là thứ gây "đơ
        // main-thread" 2-3s ở LẦN MỞ FILE ĐẦU TIÊN (dev mode Vite còn biên dịch
        // on-demand cả cây ImpositionTab→AcrobatViewer→LivePageFrame). Làm sớm ở
        // màn hình Home (lúc người dùng chưa thao tác) → mở file đầu tiên hết đơ.
        warmupWorkspaceChunks();
        // pdfium chạy ở luồng Rust (spawn_blocking) → KHÔNG chặn main thread, warm song song.
        warmupPdfium();
        // pdfjs chỉ dùng cho browser-mode/thumbnail → warm sau cùng, tránh đụng tài nguyên.
        setTimeout(() => { warmupPdfjs(); }, 3000);
    };
    const ric = (window as any).requestIdleCallback as
        | ((cb: () => void, opts?: any) => number)
        | undefined;
    if (ric) {
        // timeout NGẮN (300ms) để warmup khởi động sớm, không chờ idle lâu tới 2s.
        const id = ric(run, { timeout: 300 });
        return () => (window as any).cancelIdleCallback?.(id);
    }
    const t = setTimeout(run, 200);
    return () => clearTimeout(t);
}
