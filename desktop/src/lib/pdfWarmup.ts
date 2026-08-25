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
let workspaceWarmLevel = 0;

const GIB = 1024 ** 3;

export type WorkspaceWarmupMode = 'none' | 'primary' | 'full';

export interface WarmupPlan {
    workspace: WorkspaceWarmupMode;
    pdfium: boolean;
    pdfjs: boolean;
}

const FULL_WARMUP_PLAN: WarmupPlan = {
    workspace: 'full',
    pdfium: true,
    pdfjs: true,
};

/** PERF (audit 2026-08-06 §PERF.5): máy mạnh giữ nguyên full warm-up. */
export function warmupPlanForTotalRam(totalBytes: number | null): WarmupPlan {
    if (totalBytes === null || !Number.isFinite(totalBytes) || totalBytes <= 0) {
        return FULL_WARMUP_PLAN;
    }
    if (totalBytes < 8 * GIB) {
        return { workspace: 'none', pdfium: true, pdfjs: false };
    }
    if (totalBytes < 16 * GIB) {
        return { workspace: 'primary', pdfium: true, pdfjs: false };
    }
    return FULL_WARMUP_PLAN;
}

function validRamByteCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function warmupRamBytesFromMemoryStatus(raw: unknown): number | null {
    if (!raw || typeof raw !== 'object') return null;
    const payload = raw as {
        installedBytes?: unknown;
        installed_bytes?: unknown;
        totalBytes?: unknown;
        total_bytes?: unknown;
    };
    const installedBytes = payload.installedBytes ?? payload.installed_bytes;
    const totalBytes = payload.totalBytes ?? payload.total_bytes;

    if (
        validRamByteCount(installedBytes)
        && (!validRamByteCount(totalBytes) || installedBytes >= totalBytes)
    ) return installedBytes;
    return validRamByteCount(totalBytes) ? totalBytes : null;
}

async function readWarmupRamBytes(): Promise<number | null> {
    if (
        typeof window === 'undefined'
        || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ) return null;

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke<unknown>('get_system_memory_status');
        return warmupRamBytesFromMemoryStatus(raw);
    } catch {
        return null;
    }
}

/**
 * Preload các CHUNK workspace nặng lúc app rảnh (màn hình Home).
 *
 * Mở file lần đầu trong phiên phải nạp + (ở DEV mode) vite BIÊN DỊCH ON-DEMAND cả
 * cây component nặng: ImpositionTab → AcrobatViewer → LivePageFrame + react-pdf/pdfjs
 * + tool con → đo được ~7s "treo" lần mở đầu (UI thread bận đánh giá khối JS lớn).
 * Import sẵn lúc idle → vite biên dịch + webview eval TRƯỚC, nên lần mở file đầu tiên
 * không còn phải chờ. (Production: chỉ là prefetch chunk, rẻ.)
 */
export async function warmupWorkspaceChunks(
    mode: Exclude<WorkspaceWarmupMode, 'none'> = 'full',
): Promise<void> {
    const targetLevel = mode === 'full' ? 2 : 1;
    if (workspaceWarmLevel >= targetLevel) return;
    try {
        const imports: Promise<unknown>[] = [import('../components/ImpositionTab')];
        if (mode === 'full') {
            imports.push(
                import('../components/AcrobatViewer'),
                import('../components/workspace/LivePageFrame'),
            );
        }
        await Promise.all(imports);
        workspaceWarmLevel = Math.max(workspaceWarmLevel, targetLevel);
    } catch {
        // Import đã thành công vẫn nằm trong module cache; giữ level cũ để lần sau thử lại.
    }
}

/**
 * Warm-up engine pdfium NATIVE (Tauri) — đây là engine render chính của view.
 * Lần đầu bind thư viện pdfium + nạp doc tốn 1.5–3s; warm sẵn lúc idle để mọi
 * lần mở file sau đều "nóng" (~150ms).
 */
export async function warmupPdfium(): Promise<void> {
    if (pdfiumWarmed) return;
    if (!window.__TAURI_INTERNALS__) return;
    pdfiumWarmed = true;
    try {
        const { createBlankPdfFile } = await import('./createBlankPdf');
        const f = await createBlankPdfFile({ widthMm: 50, heightMm: 50 });
        const path = f.path;
        if (!path) return;
        const { invoke } = await import('@tauri-apps/api/core');
        // PERF (audit 2026-08-08 §RENDER.2): bootstrap đi lane tương tác; metadata đi
        // background pool nên không làm nóng đúng worker phục vụ lần mở trang đầu tiên.
        await invoke('get_pdf_viewer_bootstrap', { filePath: path });
    } catch {
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
    } catch {
        // Warm-up thất bại không sao — chỉ mất lợi ích tối ưu, app vẫn chạy.
        warmed = false;
    }
}

/** Lên lịch warm-up vào thời điểm app rảnh (sau first paint). */
export function scheduleWarmupPdfjs(): () => void {
    let cancelled = false;
    let pdfjsTimer: ReturnType<typeof setTimeout> | null = null;

    const run = () => {
        void (async () => {
            const totalRamBytes = await readWarmupRamBytes();
            if (cancelled) return;
            const plan = warmupPlanForTotalRam(totalRamBytes);

            // PERF (audit 2026-08-06 §PERF.5): chỉ máy yếu mới giảm preload.
            // Máy >=16 GB và máy không đọc được RAM giữ nguyên toàn bộ đường warm cũ.
            if (plan.workspace !== 'none') {
                void warmupWorkspaceChunks(plan.workspace);
            }
            if (plan.pdfium) {
                // pdfium chạy ở luồng Rust nên không chặn main thread.
                void warmupPdfium();
            }
            if (plan.pdfjs) {
                // pdfjs chỉ dùng cho browser-mode/thumbnail → warm sau cùng.
                pdfjsTimer = setTimeout(() => {
                    if (!cancelled) void warmupPdfjs();
                }, 3000);
            }
        })();
    };
    const ric = window.requestIdleCallback;
    if (ric) {
        // timeout NGẮN (300ms) để warmup khởi động sớm, không chờ idle lâu tới 2s.
        const id = ric(run, { timeout: 300 });
        return () => {
            cancelled = true;
            window.cancelIdleCallback?.(id);
            if (pdfjsTimer !== null) clearTimeout(pdfjsTimer);
        };
    }
    const t = setTimeout(run, 200);
    return () => {
        cancelled = true;
        clearTimeout(t);
        if (pdfjsTimer !== null) clearTimeout(pdfjsTimer);
    };
}
