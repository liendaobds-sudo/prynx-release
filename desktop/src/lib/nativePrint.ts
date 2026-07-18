// In PDF native (Ctrl+P) dùng chung cho mọi tab có file PDF.
//
// Vì sao tách ra đây: đường in native gồm các mảnh lặp lại ở nhiều tab —
//   (1) hộp thoại in kiểu Acrobat (PrintDialog + usePrintDialog, file .tsx cạnh bên),
//   (2) ghi file tạm + gọi lệnh Rust, và
//   (3) liệt kê máy in / đọc khổ giấy cho preview.
// ImpositionTab, Preflight, Combine, Dieline đều dùng chung các mảnh này thay vì
// mỗi tab tự chép. Rust render vào HDC máy in (nét vector như Acrobat) — KHÔNG dùng
// window.print() của WebView2.

export type PrintScaleMode = 'actual' | 'fit' | 'shrink' | 'custom';
export type PrintOrientation = 'auto' | 'portrait' | 'landscape';
export type PrintLayoutMode = 'size' | 'multiple' | 'booklet' | 'poster';
export type PrintPageSubset = 'all' | 'odd' | 'even';
export type PrinterDevmode = number[];

type PathBackedBlob = Blob & { path?: string };

function isTauriRuntime(): boolean {
    return '__TAURI_INTERNALS__' in window;
}

/** Ghi breadcrumb vào %APPDATA%\\PrynX\\logs\\print_debug.log (chẩn đoán crash Ctrl+P). */
export async function logPrintEvent(message: string): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('log_print_event', { message });
    } catch {
        /* best-effort */
    }
}


export interface PrinterInfo {
    name: string;
    is_default: boolean;
}

export interface PrinterGeometry {
    paper_w_mm: number;
    paper_h_mm: number;
    printable_w_mm: number;
    printable_h_mm: number;
    margin_left_mm: number;
    margin_top_mm: number;
}

export interface PrintDirectParams {
    filePath: string;
    printerName: string;
    fromPage?: number | null;
    toPage?: number | null;
    copies?: number;
    collate?: boolean;
    deleteAfter?: boolean;
    scaleMode: PrintScaleMode;
    scalePercent?: number;
    orientation?: PrintOrientation;
    autoRotate?: boolean;
    grayscale?: boolean;
    printAnnotations?: boolean;
    devmode?: PrinterDevmode | null;
    reverse?: boolean;
    pageSubset?: PrintPageSubset;
    layoutMode?: PrintLayoutMode;
    pagesPerSheet?: number;
    posterCols?: number;
    posterRows?: number;
}

export interface PrintPathParams {
    filePath: string;
    fromPage?: number | null;
    toPage?: number | null;
    scaleMode: PrintScaleMode;
    autoRotate?: boolean;
}


// Lấy PATH thật trên đĩa cho một PDF (PDFium cần path, không nhận blob in-memory).
// Nếu source đã có `.path` (File mở từ đĩa) → dùng thẳng, deleteAfter=false. Nếu là
// blob in-memory (kết quả ghép/generate) → ghi temp `prynx_print_*.pdf`, deleteAfter=true
// để hook dọn ở mọi nhánh thành công/lỗi/hủy. Tách riêng để dialog + các tab dùng chung.
export async function resolvePrintableFilePath(
    source: Blob | File,
): Promise<{ filePath: string; deleteAfter: boolean }> {
    const existing: string | null = (source as PathBackedBlob).path || null;
    if (existing) {
        await logPrintEvent(`resolvePath: use disk path (${existing.length} chars)`);
        return { filePath: existing, deleteAfter: false };
    }
    await logPrintEvent(`resolvePath: write temp (size=${source.size})`);
    const { invoke } = await import('@tauri-apps/api/core');
    const { tempDir, join } = await import('@tauri-apps/api/path');
    const buffer = await source.arrayBuffer();
    const tDir = await tempDir();
    const tmpName = `prynx_print_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`;
    const tmpPath = await join(tDir, tmpName);
    await invoke('write_file_atomic', { path: tmpPath, contents: new Uint8Array(buffer) });
    await logPrintEvent('resolvePath: temp written');
    return { filePath: tmpPath, deleteAfter: true };
}

// Liệt kê máy in cho dropdown. Rỗng/lỗi → [] (dialog fallback về PrintDlgW).
export async function listPrinters(): Promise<PrinterInfo[]> {
    if (!isTauriRuntime()) return [];
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<PrinterInfo[]>('list_printers');
    } catch {
        return [];
    }
}

// Khổ giấy + vùng in + lề (mm) của máy in theo orientation — cho preview page-on-paper.
export async function getPrinterGeometry(
    printerName: string,
    orientation: PrintOrientation,
    devmode?: PrinterDevmode | null,
): Promise<PrinterGeometry | null> {
    if (!isTauriRuntime()) return null;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<PrinterGeometry>('get_printer_geometry', {
            printerName,
            orientation,
            devmode: devmode ?? null,
        });
    } catch {
        return null;
    }
}

// Mở UI cấu hình do chính driver máy in cung cấp. DEVMODE trả về được giữ lại và
// dùng cho preview lẫn job in kế tiếp, nên thay đổi khổ giấy/khay/độ phân giải có hiệu lực thật.
export async function openPrinterProperties(
    printerName: string,
    currentDevmode?: PrinterDevmode | null,
    advanced = false,
): Promise<PrinterDevmode | null> {
    if (!isTauriRuntime()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<PrinterDevmode | null>('open_printer_properties', {
        printerName,
        currentDevmode: currentDevmode ?? null,
        advanced,
    });
}

// In THẲNG vào máy in đã chọn (KHÔNG bung PrintDlgW). Ném lỗi nếu Rust trả Err (dialog
// bắt để tự fallback về printPdfPath trên cùng file). Trả true nếu đã gửi lệnh in.
export async function printPdfDirect(params: PrintDirectParams): Promise<boolean> {
    if (!isTauriRuntime()) {
        throw new Error('NOT_TAURI');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('print_pdf_direct', {
        filePath: params.filePath,
        printerName: params.printerName,
        fromPage: params.fromPage ?? null,
        toPage: params.toPage ?? null,
        copies: params.copies ?? 1,
        collate: params.collate ?? true,
        deleteAfter: params.deleteAfter ?? false,
        scaleMode: params.scaleMode,
        scalePercent: params.scalePercent ?? null,
        orientation: params.orientation ?? 'auto',
        autoRotate: params.autoRotate ?? false,
        grayscale: params.grayscale ?? false,
        printAnnotations: params.printAnnotations ?? true,
        devmode: params.devmode ?? null,
        reverse: params.reverse ?? false,
        pageSubset: params.pageSubset ?? 'all',
        layoutMode: params.layoutMode ?? 'size',
        pagesPerSheet: params.pagesPerSheet ?? 2,
        posterCols: params.posterCols ?? 2,
        posterRows: params.posterRows ?? 2,
    });
}

/** Hủy job in đang chạy (best-effort). */
export async function cancelPrintJob(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cancel_print_job');
    } catch {
        /* ignore */
    }
}

// Dọn file tạm prynx_print_*.pdf khi user hủy dialog (best-effort, nuốt lỗi).
export async function deletePrintTemp(path: string): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('delete_print_temp', { path });
    } catch {
        /* best-effort */
    }
}

export async function printPdfPath(params: PrintPathParams): Promise<boolean> {
    if (!isTauriRuntime()) {
        throw new Error('NOT_TAURI');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('print_pdf', {
        filePath: params.filePath,
        fromPage: params.fromPage ?? null,
        toPage: params.toPage ?? null,
        deleteAfter: false,
        scaleMode: params.scaleMode === 'custom' ? 'shrink' : params.scaleMode,
        autoRotate: params.autoRotate ?? false,
    });
}

/**
 * FALLBACK: in qua hộp thoại Windows cổ điển (PrintDlgW). Dùng khi máy in rỗng /
 * CreateDCW lỗi / print_pdf_direct ném, hoặc nút "System dialog…" trong PrintDialog.
 *
 * PDFium cần PATH thật. Nếu source có `.path` thì in thẳng; nếu blob in-memory thì ghi
 * temp và dọn ở finally. @returns true nếu gửi lệnh in; false nếu hủy.
 */
export async function printPdfSource(
    source: Blob | File,
    scaleMode: PrintScaleMode,
    opts?: { autoRotate?: boolean },
): Promise<boolean> {
    if (!isTauriRuntime()) {
        throw new Error('NOT_TAURI');
    }
    const { filePath, deleteAfter } = await resolvePrintableFilePath(source);

    try {
        return await printPdfPath({
            filePath,
            scaleMode,
            autoRotate: opts?.autoRotate ?? false,
        });
    } finally {
        if (deleteAfter) await deletePrintTemp(filePath);
    }
}
