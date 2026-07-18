// Hook điều phối hộp thoại in hợp nhất kiểu Acrobat: promise-resolve (giống
// usePrintScaleModal cũ nhưng giàu hơn). Lo resolve filePath + liệt kê máy in +
// in thật (print_pdf_direct) + fallback PrintDlgW trên cùng file tạm. Mỗi tab
// chỉ cần: const { openPrintDialog, printDialog } = usePrintDialog(); rồi
// await openPrintDialog({ source, numPages }). Xem [[nativePrint]] + [[PrintDialog]].
import { useCallback, useEffect, useRef, useState } from 'react';
import PrintDialog, { type PrintSettings } from './PrintDialog';
import {
    listPrinters,
    resolvePrintableFilePath,
    printPdfDirect,
    printPdfPath,
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
    resolve: (printed: boolean) => void;
    reject: (error: unknown) => void;
}

export function usePrintDialog() {
    const [state, setState] = useState<DialogState | null>(null);

    const stateRef = useRef<DialogState | null>(null);
    const pendingPromiseRef = useRef<Promise<boolean> | null>(null);
    const mountedRef = useRef(true);
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
            } catch (e: any) {
                await logPrintEvent(`openPrintDialog: listPrinters failed ${e?.message || e}`);
                printers = [];
            }
            await logPrintEvent(`openPrintDialog: printers=${printers.length}, show dialog`);
            if (!mountedRef.current) {
                if (deleteAfter) await deletePrintTemp(filePath);
                return false;
            }
            return await new Promise<boolean>((resolve, reject) => {
                const next = { req, printers, filePath, deleteAfter, resolve, reject };
                stateRef.current = next;
                setState(next);
            });
        })();
        const tracked = pending.finally(() => {
            if (pendingPromiseRef.current === tracked) pendingPromiseRef.current = null;
        });
        pendingPromiseRef.current = tracked;
        return tracked;
    }, []);

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

    const handlePrint = useCallback((settings: PrintSettings) => {
        const current = takeState();
        if (!current) return;
        const { filePath, req } = current;
        const autoRotate = settings.orientation === 'auto' ? (req.autoRotateDefault ?? false) : false;
        void (async () => {
            try {
                let printed: boolean;
                try {
                    printed = await printPdfDirect({
                        filePath,
                        printerName: settings.printerName,
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
                } catch {
                    printed = await printPdfPath({
                        filePath,
                        fromPage: settings.fromPage,
                        toPage: settings.toPage,
                        scaleMode: settings.scaleMode,
                        autoRotate,
                    });
                }
                await cleanupTemp(current);
                current.resolve(printed);
            } catch (error) {
                await cleanupTemp(current);
                current.reject(error);
            }
        })();
    }, [cleanupTemp, takeState]);

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
            autoRotateDefault={state.req.autoRotateDefault}
            onPrint={handlePrint}
            onCancel={() => finish(false)}
        />
    ) : null;

    return { openPrintDialog, printDialog };
}
