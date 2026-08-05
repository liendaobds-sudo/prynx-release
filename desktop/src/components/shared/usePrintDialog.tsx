// Hook điều phối hộp thoại in hợp nhất kiểu Acrobat: promise-resolve (giống
// usePrintScaleModal cũ nhưng giàu hơn). Lo resolve filePath + liệt kê máy in +
// in thật (print_pdf_direct) + PrintDlgW chủ động trên cùng file tạm. Mỗi tab
// chỉ cần: const { openPrintDialog, printDialog } = usePrintDialog(); rồi
// await openPrintDialog({ source, numPages }). Xem [[nativePrint]] + [[PrintDialog]].
import { useCallback, useEffect, useRef, useState } from 'react';
import PrintDialog, { type PrintSettings } from './PrintDialog';
import {
    listPrinters,
    resolvePrintableFilePath,
    printPdfDirect,
    printPdfPath,
    choosePrinterOutputPath,
    cancelPrintJob,
    deletePrintTemp,
    logPrintEvent,
    type PrinterInfo,
} from '../../lib/nativePrint';

export interface PrintRequest {
    source: Blob | File;
    numPages: number;
    /** Dieline: trang khuôn thường ngang → mặc định orientation Auto cho auto-rotate lọt khổ. */
    autoRotateDefault?: boolean;
}

interface DialogState {
    req: PrintRequest;
    printers: PrinterInfo[];
    filePath: string;
    deleteAfter: boolean;
    jobId: string;
    resolve: (printed: boolean) => void;
    reject: (error: unknown) => void;
}

export function usePrintDialog() {
    const [state, setState] = useState<DialogState | null>(null);

    const stateRef = useRef<DialogState | null>(null);
    const pendingPromiseRef = useRef<Promise<boolean> | null>(null);
    const mountedRef = useRef(true);
    const createJobId = useCallback((): string => {
        const randomPart = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        return `print-${randomPart}`;
    }, []);
    const openPrintDialog = useCallback((req: PrintRequest): Promise<boolean> => {
        if (pendingPromiseRef.current) return pendingPromiseRef.current;
        const pending = (async (): Promise<boolean> => {
            if (!('__TAURI_INTERNALS__' in window)) {
                throw new Error('NOT_TAURI');
            }
            await logPrintEvent(`openPrintDialog: start pages=${req.numPages} size=${req.source.size}`);
            // Resolve path trước; list máy in sau (tránh crash/driver song song với ghi temp).
            const { filePath, deleteAfter } = await resolvePrintableFilePath(req.source);
            await logPrintEvent('openPrintDialog: path ready, listing printers');
            let printers: PrinterInfo[] = [];
            try {
                printers = await listPrinters();
            } catch (e: unknown) {
                const detail = e instanceof Error ? e.message : String(e);
                await logPrintEvent(`openPrintDialog: listPrinters failed ${detail}`);
                printers = [];
            }
            await logPrintEvent(`openPrintDialog: printers=${printers.length}, show dialog`);
            if (!mountedRef.current) {
                if (deleteAfter) await deletePrintTemp(filePath);
                return false;
            }
            return await new Promise<boolean>((resolve, reject) => {
                const next = { req, printers, filePath, deleteAfter, jobId: createJobId(), resolve, reject };
                stateRef.current = next;
                setState(next);
            });
        })();
        const tracked = pending.finally(() => {
            if (pendingPromiseRef.current === tracked) pendingPromiseRef.current = null;
        });
        pendingPromiseRef.current = tracked;
        return tracked;
    }, [createJobId]);

    // Đóng dialog: gỡ state, dọn file tạm nếu cần rồi resolve promise.
    const takeState = useCallback((): DialogState | null => {
        const current = stateRef.current;
        if (!current) return null;
        stateRef.current = null;
        setState(null);
        return current;
    }, []);

    const cleanupTemp = useCallback(async (current: DialogState): Promise<void> => {
        if (current.deleteAfter) await deletePrintTemp(current.filePath);
    }, []);

    const finish = useCallback((printed: boolean) => {
        const current = takeState();
        if (!current) return;
        void cleanupTemp(current).finally(() => current.resolve(printed));
    }, [cleanupTemp, takeState]);

    const completePrint = useCallback(async (current: DialogState, printed: boolean): Promise<void> => {
        // UIUX (audit 2026-08-05 §PRINT.2): chỉ đóng dialog khi đúng job hiện tại đã kết thúc.
        if (stateRef.current !== current) return;
        const completed = takeState();
        if (!completed) return;
        try {
            await cleanupTemp(completed);
        } finally {
            completed.resolve(printed);
        }
    }, [cleanupTemp, takeState]);

    const handlePrint = useCallback(async (settings: PrintSettings): Promise<void> => {
        const current = stateRef.current;
        if (!current) throw new Error('PRINT_DIALOG_CLOSED');
        const { filePath, req } = current;
        const autoRotate = settings.orientation === 'auto' ? (req.autoRotateDefault ?? false) : false;
        try {
            const selectedPrinter = current.printers.find(p => p.name === settings.printerName);
            let outputPath: string | null = null;
            if (selectedPrinter?.requires_output_path) {
                outputPath = await choosePrinterOutputPath(selectedPrinter);
                // Người dùng hủy hộp thoại lưu: chưa tạo job, giữ nguyên dialog để chọn lại.
                if (!outputPath) return;
            }
            const printed = await printPdfDirect({
                jobId: current.jobId,
                filePath,
                printerName: settings.printerName,
                outputPath,
                fromPage: settings.fromPage,
                toPage: settings.toPage,
                copies: settings.copies,
                collate: settings.collate,
                deleteAfter: false,
                scaleMode: settings.scaleMode,
                scalePercent: settings.scalePercent,
                orientation: settings.orientation,
                autoRotate,
                grayscale: settings.grayscale,
                printAnnotations: settings.printAnnotations,
                devmode: settings.devmode,
                reverse: settings.reverse,
                pageSubset: settings.pageSubset,
                layoutMode: settings.layoutMode,
                pagesPerSheet: settings.pagesPerSheet,
                posterCols: settings.posterCols,
                posterRows: settings.posterRows,
            });
            if (!printed) throw new Error('PRINT_JOB_NOT_COMPLETED');
            await completePrint(current, true);
        } catch (error) {
            // UIUX (audit 2026-08-05 §PRINT.4): giữ lỗi gốc, không âm thầm đổi sang PrintDlgW.
            const detail = error instanceof Error ? error.message : String(error);
            try {
                await logPrintEvent(`printPdfDirect: failed ${detail}`);
            } catch { /* ghi log không được che lỗi in gốc */ }
            throw error;
        }
    }, [completePrint]);

    const handleSystemPrint = useCallback(async (settings: PrintSettings): Promise<void> => {
        const current = stateRef.current;
        if (!current) throw new Error('PRINT_DIALOG_CLOSED');
        const autoRotate = settings.orientation === 'auto' ? (current.req.autoRotateDefault ?? false) : false;
        try {
            const printed = await printPdfPath({
                filePath: current.filePath,
                fromPage: settings.fromPage,
                toPage: settings.toPage,
                scaleMode: settings.scaleMode,
                autoRotate,
            });
            // Người dùng có thể hủy PrintDlgW; khi đó giữ dialog PrynX để họ thử lại.
            if (printed) await completePrint(current, true);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            try {
                await logPrintEvent(`printPdfPath: failed ${detail}`);
            } catch { /* ghi log không được che lỗi in gốc */ }
            throw error;
        }
    }, [completePrint]);

    const handleCancelPrint = useCallback(async (): Promise<void> => {
        const current = stateRef.current;
        if (!current) return;
        await cancelPrintJob(current.jobId);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            const current = stateRef.current;
            stateRef.current = null;
            if (current) {
                void cleanupTemp(current).finally(() => current.resolve(false));
            }
        };
    }, [cleanupTemp]);

    const printDialog = state ? (
        <PrintDialog
            source={state.req.source}
            numPages={state.req.numPages}
            printers={state.printers}
            jobId={state.jobId}
            autoRotateDefault={state.req.autoRotateDefault}
            onPrint={handlePrint}
            onSystemPrint={handleSystemPrint}
            onCancelPrint={handleCancelPrint}
            onCancel={() => finish(false)}
        />
    ) : null;

    return { openPrintDialog, printDialog };
}
