// Hộp thoại in hợp nhất kiểu Acrobat: 1 cửa sổ có máy in / số bản / khoảng trang /
// tỉ lệ (Fit/Actual/Shrink/Custom%) / orientation + preview "trang trên khổ giấy".
// Presentational + state nội bộ; hook usePrintDialog lo promise + in thật + fallback.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, Circle, CircleDot, Printer, X } from 'lucide-react';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getFileArrayBuffer } from '../../lib/utils';
import {
    getPrinterGeometry,
    getPrintPreviewInfo,
    openPrinterProperties,
    renderPrintPreviewPage,
    type PrinterInfo,
    type PrinterGeometry,
    type PrinterDevmode,
    type PrintPreviewPageDim,
    type PrintScaleMode,
    type PrintOrientation,
    type PrintLayoutMode,
    type PrintPageSubset,
} from '../../lib/nativePrint';
import {
    buildPreviewSheets,
    calculateSizePreview,
    collectPageNumbers,
} from '../../lib/printPreviewLayout';
import {
    applyPageSubsetAndReverse,
    parsePageSelection,
    type PageSelectionError,
} from '../../lib/printPageSelection';
import { formatSizeMm } from '../../lib/measurementFormat';

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
}

// Cài đặt in mà dialog trả về khi bấm Print (hook dịch sang tham số print_pdf_direct).
export interface PrintSettings {
    printerName: string;
    copies: number;
    collate: boolean;
    fromPage: number;
    toPage: number;
    /** Danh sách trang 1-based rời rạc; null = dùng khoảng from/to tương thích cũ. */
    pages: number[] | null;
    scaleMode: PrintScaleMode;
    scalePercent: number;
    orientation: PrintOrientation;
    grayscale: boolean;
    printAnnotations: boolean;
    devmode: PrinterDevmode | null;
    reverse: boolean;
    pageSubset: PrintPageSubset;
    layoutMode: PrintLayoutMode;
    pagesPerSheet: number;
    posterCols: number;
    posterRows: number;
}

export interface PrintDialogProps {
    source: Blob | File;
    /** Path thật trên đĩa (hook đã resolve) — preview native cho file lớn (§PRINTWIN.02). */
    filePath?: string;
    numPages: number;
    printers: PrinterInfo[];
    jobId: string;
    autoRotateDefault?: boolean;
    initialPage?: number;
    initialSelectedPages?: number[];
    onPrint: (settings: PrintSettings) => Promise<void>;
    onSystemPrint?: (settings: PrintSettings) => Promise<void>;
    onCancelPrint?: () => Promise<void>;
    onCancel: () => void;
}

type RangeMode = 'all' | 'current' | 'selection' | 'range';

// Khung giấy fallback (A4 dọc) khi chưa lấy được geometry từ máy in.
const FALLBACK_GEO: PrinterGeometry = {
    paper_w_mm: 210,
    paper_h_mm: 297,
    printable_w_mm: 200,
    printable_h_mm: 287,
    margin_left_mm: 5,
    margin_top_mm: 5,
};

function fallbackGeometryFor(orientation: PrintOrientation): PrinterGeometry {
    if (orientation !== 'landscape') return FALLBACK_GEO;
    return {
        paper_w_mm: FALLBACK_GEO.paper_h_mm,
        paper_h_mm: FALLBACK_GEO.paper_w_mm,
        printable_w_mm: FALLBACK_GEO.printable_h_mm,
        printable_h_mm: FALLBACK_GEO.printable_w_mm,
        margin_left_mm: FALLBACK_GEO.margin_top_mm,
        margin_top_mm: FALLBACK_GEO.margin_left_mm,
    };
}

const PREVIEW_MAX = 360; // px, cạnh dài nhất khung giấy trong preview

const MAX_COPIES = 999;
/** PRINTWIN (audit 2026-08-13 §PRINTWIN.02): pdf.js không được nhồi cả PDF lớn vào WebView. */
export const MAX_PRINT_PREVIEW_BYTES = 24 * 1024 * 1024;
const EMPTY_PAGE_SELECTION: number[] = [];

function clampPage(page: number, pageCount: number): number {
    const value = Number.isFinite(page) ? Math.trunc(page) : 1;
    return Math.max(1, Math.min(value, Math.max(1, pageCount)));
}

function RadioMark({ checked }: { checked: boolean }) {
    const className = `w-[18px] h-[18px] shrink-0 ${checked ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}`;
    return checked ? <CircleDot className={className} aria-hidden="true" /> : <Circle className={className} aria-hidden="true" />;
}

export default function PrintDialog({
    source,
    filePath,
    numPages,
    printers,
    jobId,
    initialPage = 1,
    initialSelectedPages = EMPTY_PAGE_SELECTION,
    onPrint,
    onSystemPrint,
    onCancelPrint,
    onCancel,
}: PrintDialogProps) {
    const { t } = useTranslation();

    const defaultPrinter = printers.find(p => p.is_default)?.name || printers[0]?.name || '';
    const [printerName, setPrinterName] = useState(defaultPrinter);
    const [copies, setCopies] = useState(1);
    const [collate, setCollate] = useState(true);
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [rangeText, setRangeText] = useState(() => numPages > 1 ? `1-${numPages}` : '1');
    const [scaleMode, setScaleMode] = useState<PrintScaleMode>('shrink');
    const [customPercent, setCustomPercent] = useState(100);
    const [orientation, setOrientation] = useState<PrintOrientation>('auto');
    const [previewPage, setPreviewPage] = useState(() => clampPage(initialPage, numPages));
    const [actualNumPages, setActualNumPages] = useState(Math.max(1, numPages));
    const [grayscale, setGrayscale] = useState(false);
    const [printAnnotations, setPrintAnnotations] = useState(true);
    const [devmode, setDevmode] = useState<PrinterDevmode | null>(null);
    const [propertiesBusy, setPropertiesBusy] = useState(false);
    const [propertiesError, setPropertiesError] = useState(false);
    const [pageSetupOpen, setPageSetupOpen] = useState(false);
    const [pageSetupOrientation, setPageSetupOrientation] = useState<PrintOrientation>('portrait');
    const [layoutMode, setLayoutMode] = useState<PrintLayoutMode>('size');
    const [pagesPerSheet, setPagesPerSheet] = useState(2);
    const [posterCols, setPosterCols] = useState(2);
    const [posterRows, setPosterRows] = useState(2);
    const [pageSubset, setPageSubset] = useState<PrintPageSubset>('all');
    const [reverse, setReverse] = useState(false);
    const [printing, setPrinting] = useState(false);
    const [printProgress, setPrintProgress] = useState<{ current: number; total: number } | null>(null);
    const [printError, setPrintError] = useState<string | null>(null);

    const [geo, setGeo] = useState<PrinterGeometry>(FALLBACK_GEO);
    /** Composite sheet preview (matches multi/booklet/poster layout). */
    const [sheetImg, setSheetImg] = useState<string | null>(null);
    const [sheetIndex, setSheetIndex] = useState(0);
    const [pageDimPt, setPageDimPt] = useState<{ w: number; h: number }>({ w: 595, h: 842 });
    const [previewLoading, setPreviewLoading] = useState(true);
    const [previewError, setPreviewError] = useState(false);
    const [documentReady, setDocumentReady] = useState(false);

    const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
    // PRINTWIN (audit 2026-08-13 §PRINTWIN.02): file lớn hơn MAX_PRINT_PREVIEW_BYTES
    // không vào pdf.js — preview raster từng trang qua engine native theo filePath.
    const nativePreviewRef = useRef(false);
    const nativeDimsRef = useRef<Record<string, PrintPreviewPageDim>>({});
    const sheetUrlRef = useRef<string | null>(null);
    const pageRasterCache = useRef<Map<number, HTMLCanvasElement>>(new Map());
    const pageDimensionCache = useRef<Map<number, { w: number; h: number }>>(new Map());
    const previewRequestRef = useRef(0);
    const dialogRef = useRef<HTMLDivElement>(null);
    const dialogBusy = printing || propertiesBusy;

    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.focus();
        return () => previouslyFocused?.focus();
    }, []);

    const handlePrinterChange = (nextPrinter: string) => {
        setPrinterName(nextPrinter);
        setDevmode(null);
        setPropertiesError(false);
    };

    const handleOpenProperties = async (advanced: boolean) => {
        if (!printerName || propertiesBusy) return;
        setPropertiesBusy(true);
        setPropertiesError(false);
        try {
            const nextDevmode = await openPrinterProperties(printerName, devmode, advanced);
            if (nextDevmode) setDevmode(nextDevmode);
        } catch {
            setPropertiesError(true);
        } finally {
            setPropertiesBusy(false);
        }
    };

    const openPageSetup = () => {
        setPageSetupOrientation(orientation === 'landscape' ? 'landscape' : 'portrait');
        setPageSetupOpen(true);
    };

    const selectedPages = useMemo(() => Array.from(new Set(initialSelectedPages))
        .map(Math.trunc)
        .filter(page => page >= 1 && page <= actualNumPages)
        .sort((a, b) => a - b), [initialSelectedPages, actualNumPages]);
    const parsedRange = useMemo(
        () => parsePageSelection(rangeText, actualNumPages),
        [rangeText, actualNumPages],
    );

    // UIUX (audit 2026-08-11 §PRINTRANGE.1–3): preview và payload cùng lấy từ
    // một danh sách gốc; không nới danh sách rời rạc thành khoảng min/max.
    const basePageList = useMemo(() => {
        if (rangeMode === 'current') return [previewPage];
        if (rangeMode === 'selection') return selectedPages;
        if (rangeMode === 'range') return parsedRange.error ? [] : parsedRange.pages;
        return collectPageNumbers(1, actualNumPages, actualNumPages, 'all', false);
    }, [rangeMode, previewPage, selectedPages, parsedRange, actualNumPages]);

    const printPageList = useMemo(
        () => applyPageSubsetAndReverse(basePageList, pageSubset, reverse),
        [basePageList, pageSubset, reverse],
    );

    const formatSelectionError = (error: PageSelectionError): string => {
        if (error.code === 'empty') return t('print:pages_error_empty');
        if (error.code === 'invalid_token') {
            return t('print:pages_error_invalid', { token: error.token || ',' });
        }
        return t('print:pages_error_out_of_range', { page: error.page, max: error.maxPage });
    };
    const pageSelectionError = rangeMode === 'range' && parsedRange.error
        ? formatSelectionError(parsedRange.error)
        : basePageList.length === 0
            ? t('print:pages_error_empty')
            : printPageList.length === 0
                ? t('print:pages_error_no_pages')
                : null;

    const previewSheets = useMemo(
        () => buildPreviewSheets({
            layoutMode,
            pages: printPageList,
            pagesPerSheet,
            posterCols,
            posterRows,
        }),
        [layoutMode, printPageList, pagesPerSheet, posterCols, posterRows],
    );

    // Clamp sheet index when layout/range changes.
    useEffect(() => {
        setSheetIndex((i) => Math.max(0, Math.min(i, Math.max(0, previewSheets.length - 1))));
    }, [previewSheets.length]);

    const rasterPage = useCallback(async (doc: PDFDocumentProxy | null, pageNum: number): Promise<HTMLCanvasElement | null> => {
        if (pageNum <= 0) return null;
        const cached = pageRasterCache.current.get(pageNum);
        if (cached) return cached;
        if (doc) {
            const page = await doc.getPage(pageNum);
            const vp1 = page.getViewport({ scale: 1 });
            pageDimensionCache.current.set(pageNum, { w: vp1.width, h: vp1.height });
            const rasterScale = Math.min(1.5, 600 / Math.max(vp1.width, vp1.height));
            const vp = page.getViewport({ scale: rasterScale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(vp.width);
            canvas.height = Math.ceil(vp.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            pageRasterCache.current.set(pageNum, canvas);
            return canvas;
        }
        // PRINTWIN (audit 2026-08-13 §PRINTWIN.02): đường native cho file lớn —
        // raster đúng 1 trang theo path, cùng mục tiêu ~600px cạnh dài như pdf.js.
        if (!nativePreviewRef.current || !filePath) return null;
        const dim = nativeDimsRef.current[String(pageNum)];
        const widthPt = dim?.widthPt || 595;
        const heightPt = dim?.heightPt || 842;
        pageDimensionCache.current.set(pageNum, { w: widthPt, h: heightPt });
        // px bitmap = pt × (96/72) × zoom → chọn zoom cho cạnh dài ~600px, trần 1.5.
        const zoom = Math.min(1.5, 600 / (Math.max(widthPt, heightPt) * 96 / 72));
        const blob = await renderPrintPreviewPage(filePath, pageNum, zoom);
        if (!blob) throw new Error('NATIVE_PREVIEW_FAILED');
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            bitmap.close();
            return null;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        pageRasterCache.current.set(pageNum, canvas);
        return canvas;
    }, [filePath]);

    /** Vẽ 1 tờ in composite (size / multi / booklet / poster) — khớp layout Rust. */
    const renderSheetComposite = useCallback(async () => {
        const requestId = ++previewRequestRef.current;
        const doc = pdfDocRef.current;
        if (!documentReady) return;
        // Nguồn trang: pdf.js (file nhỏ) hoặc engine native theo path (§PRINTWIN.02).
        if (!doc && !nativePreviewRef.current) return;
        const sheet = previewSheets[sheetIndex];
        if (!sheet) {
            setSheetImg(null);
            setPreviewLoading(false);
            return;
        }
        setPreviewLoading(true);
        setPreviewError(false);
        try {
            // Geometry in CSS px for display
            const longSide = Math.max(geo.paper_w_mm, geo.paper_h_mm);
            const mmToPx = PREVIEW_MAX / longSide;
            const paperW = Math.max(40, Math.round(geo.paper_w_mm * mmToPx));
            const paperH = Math.max(40, Math.round(geo.paper_h_mm * mmToPx));
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(paperW * dpr);
            canvas.height = Math.round(paperH * dpr);
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('NO_CTX');
            ctx.scale(dpr, dpr);

            // Paper
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, paperW, paperH);
            // Soft shadow edge
            ctx.strokeStyle = 'rgba(15,23,42,0.12)';
            ctx.lineWidth = 1;
            ctx.strokeRect(0.5, 0.5, paperW - 1, paperH - 1);

            const printLeft = geo.margin_left_mm * mmToPx;
            const printTop = geo.margin_top_mm * mmToPx;
            const printW = geo.printable_w_mm * mmToPx;
            const printH = geo.printable_h_mm * mmToPx;

            // Printable area
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(99,102,241,0.45)';
            ctx.strokeRect(printLeft, printTop, printW, printH);
            ctx.setLineDash([]);

            for (const cell of sheet.cells) {
                const cellX = printLeft + cell.x * printW;
                const cellY = printTop + cell.y * printH;
                const cellW = cell.w * printW;
                const cellH = cell.h * printH;

                // Cell guide for multi/booklet
                if (layoutMode === 'multiple' || layoutMode === 'booklet') {
                    ctx.strokeStyle = 'rgba(148,163,184,0.5)';
                    ctx.lineWidth = 0.75;
                    ctx.strokeRect(cellX + 0.5, cellY + 0.5, cellW - 1, cellH - 1);
                }

                if (cell.page <= 0) {
                    // blank booklet slot
                    ctx.fillStyle = 'rgba(241,245,249,0.9)';
                    ctx.fillRect(cellX + 2, cellY + 2, cellW - 4, cellH - 4);
                    ctx.fillStyle = 'rgba(148,163,184,0.8)';
                    ctx.font = '11px system-ui,sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('—', cellX + cellW / 2, cellY + cellH / 2);
                    continue;
                }

                const pageCanvas = await rasterPage(doc, cell.page);
                if (requestId !== previewRequestRef.current) return;
                if (!pageCanvas) continue;

                if (cell.posterTile) {
                    const { col, row, cols, rows } = cell.posterTile;
                    // Draw enlarged page, clip to tile
                    const fullW = printW * cols;
                    const fullH = printH * rows;
                    const sx = pageCanvas.width;
                    const sy = pageCanvas.height;
                    const scale = Math.min(fullW / sx, fullH / sy);
                    const drawW = sx * scale;
                    const drawH = sy * scale;
                    const baseX = printLeft + (fullW - drawW) / 2 - col * printW;
                    const baseY = printTop + (fullH - drawH) / 2 - row * printH;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(printLeft, printTop, printW, printH);
                    ctx.clip();
                    ctx.drawImage(pageCanvas, baseX, baseY, drawW, drawH);
                    ctx.restore();
                    // Tile label
                    ctx.fillStyle = 'rgba(79,70,229,0.85)';
                    ctx.font = 'bold 10px system-ui,sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText(`${col + 1},${row + 1}`, printLeft + 6, printTop + 14);
                } else {
                    // Fit page into cell (shrink-to-fit within cell for multi; global scale for size)
                    const isSize = layoutMode === 'size';
                    const srcW = pageCanvas.width;
                    const srcH = pageCanvas.height;
                    let drawW: number;
                    let drawH: number;
                    if (isSize) {
                        // UIUX (audit 2026-08-05 §PRINT.7): mỗi trang dùng MediaBox riêng;
                        // không lấy kích thước trang 1 áp cho toàn bộ PDF hỗn hợp khổ.
                        const pageDim = pageDimensionCache.current.get(cell.page)
                            ?? { w: pageCanvas.width, h: pageCanvas.height };
                        setPageDimPt(current => (
                            current.w === pageDim.w && current.h === pageDim.h ? current : pageDim
                        ));
                        const preview = calculateSizePreview(pageDim, geo, scaleMode, customPercent);
                        const pageWpx = preview.widthMm * preview.scale * mmToPx;
                        const pageHpx = preview.heightMm * preview.scale * mmToPx;
                        drawW = pageWpx;
                        drawH = pageHpx;
                    } else {
                        // multi / booklet: fit cell
                        const s = Math.min(cellW / srcW, cellH / srcH) * 0.96;
                        drawW = srcW * s;
                        drawH = srcH * s;
                    }
                    const dx = cellX + (cellW - drawW) / 2;
                    const dy = cellY + (cellH - drawH) / 2;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(cellX, cellY, cellW, cellH);
                    ctx.clip();
                    ctx.drawImage(pageCanvas, dx, dy, drawW, drawH);
                    ctx.restore();
                    // Page number badge
                    if (layoutMode !== 'size') {
                        ctx.fillStyle = 'rgba(15,23,42,0.55)';
                        ctx.fillRect(cellX + 4, cellY + 4, 22, 14);
                        ctx.fillStyle = '#fff';
                        ctx.font = 'bold 9px system-ui,sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText(String(cell.page), cellX + 15, cellY + 14);
                    }
                }
            }

            if (requestId !== previewRequestRef.current) return;
            const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
            if (!blob) throw new Error('BLOB');
            if (requestId !== previewRequestRef.current) return;
            if (sheetUrlRef.current) URL.revokeObjectURL(sheetUrlRef.current);
            const url = URL.createObjectURL(blob);
            sheetUrlRef.current = url;
            setSheetImg(url);
        } catch {
            if (requestId === previewRequestRef.current) setPreviewError(true);
        } finally {
            if (requestId === previewRequestRef.current) setPreviewLoading(false);
        }
    }, [
        documentReady, previewSheets, sheetIndex, geo, scaleMode, customPercent,
        layoutMode, rasterPage,
    ]);

    // Load tài liệu pdfjs một lần khi nguồn thay đổi.
    useEffect(() => {
        let cancelled = false;
        previewRequestRef.current += 1;
        setSheetImg(null);
        setPreviewLoading(true);
        const rasterCache = pageRasterCache.current;
        const dimensionCache = pageDimensionCache.current;
        rasterCache.clear();
        dimensionCache.clear();
        nativePreviewRef.current = false;
        nativeDimsRef.current = {};
        if (sheetUrlRef.current) {
            URL.revokeObjectURL(sheetUrlRef.current);
            sheetUrlRef.current = null;
        }
        void (async () => {
            try {
                setDocumentReady(false);
                setPreviewError(false);
                // PRINTWIN (audit 2026-08-13 §PRINTWIN.02): file lớn không đưa vào pdf.js —
                // preview đi engine native theo path; native lỗi thì bỏ preview nhưng
                // nút In vẫn hoạt động (thông báo preview_skipped_large).
                if (source.size > MAX_PRINT_PREVIEW_BYTES) {
                    const info = filePath ? await getPrintPreviewInfo(filePath) : null;
                    if (cancelled) return;
                    if (!info) {
                        setPreviewError(true);
                        setPreviewLoading(false);
                        return;
                    }
                    nativePreviewRef.current = true;
                    nativeDimsRef.current = info.dims;
                    const nativePageCount = Math.max(1, info.numPages);
                    setActualNumPages(nativePageCount);
                    setPreviewPage(clampPage(initialPage, nativePageCount));
                    setSheetIndex(0);
                    setDocumentReady(true);
                    return;
                }
                const buf = await getFileArrayBuffer(source);
                const doc = await pdfjs.getDocument({ data: buf }).promise;
                if (cancelled) {
                    try { await doc.destroy(); } catch { /* noop */ }
                    return;
                }
                pdfDocRef.current = doc;
                const loadedPageCount = Math.max(1, doc.numPages);
                setActualNumPages(loadedPageCount);
                // §PRINTRANGE.2: giữ trang workspace đã truyền vào, không reset về trang 1.
                setPreviewPage(clampPage(initialPage, loadedPageCount));
                setSheetIndex(0);
                setDocumentReady(true);
            } catch {
                if (!cancelled) {
                    setPreviewError(true);
                    setPreviewLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
            previewRequestRef.current += 1;
            const doc = pdfDocRef.current;
            if (doc) {
                pdfDocRef.current = null;
                void doc.destroy().catch(() => undefined);
            }
            nativePreviewRef.current = false;
            nativeDimsRef.current = {};
            rasterCache.clear();
            dimensionCache.clear();
            if (sheetUrlRef.current) { URL.revokeObjectURL(sheetUrlRef.current); sheetUrlRef.current = null; }
        };
    }, [source, initialPage, filePath]);

    // Đọc geometry khi đổi máy in hoặc hướng giấy.
    useEffect(() => {
        let cancelled = false;
        if (!printerName) { setGeo(fallbackGeometryFor(orientation)); return; }
        void (async () => {
            const geometry = await getPrinterGeometry(printerName, orientation, devmode);
            if (cancelled) return;
            if (geometry && geometry.paper_w_mm > 0 && geometry.paper_h_mm > 0) setGeo(geometry);
            else setGeo(fallbackGeometryFor(orientation));
        })();
        return () => { cancelled = true; };
    }, [printerName, orientation, devmode]);

    // Rebuild sheet preview whenever layout / sheet / scale / geo changes.
    useEffect(() => {
        void renderSheetComposite();
    }, [renderSheetComposite]);

    // Esc = hủy; Tab/Shift+Tab luôn ở trong dialog.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (pageSetupOpen) {
                    setPageSetupOpen(false);
                } else if (!dialogBusy) {
                    onCancel();
                }
                return;
            }
            if (e.key !== 'Tab') return;
            const root = dialogRef.current;
            if (!root) return;
            const focusRoot = pageSetupOpen ? root.querySelector<HTMLElement>('[data-page-setup]') || root : root;
            const focusable = Array.from(focusRoot.querySelectorAll<HTMLElement>(
                'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            )).filter(element => element.tabIndex >= 0);
            if (focusable.length === 0) {
                e.preventDefault();
                focusRoot.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === focusRoot)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === focusRoot)) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel, pageSetupOpen, dialogBusy]);

    // ── Hình học preview (mm → px) — composite sheet đã vẽ sẵn, chỉ hiển thị ──
    const paperLandscape = geo.paper_w_mm > geo.paper_h_mm;
    const longSide = Math.max(geo.paper_w_mm, geo.paper_h_mm);
    const mmToPx = PREVIEW_MAX / longSide;
    const paperWpx = geo.paper_w_mm * mmToPx;
    const paperHpx = geo.paper_h_mm * mmToPx;

    const readoutPreview = calculateSizePreview(
        pageDimPt,
        geo,
        layoutMode === 'booklet' || layoutMode === 'poster' ? 'fit' : scaleMode,
        customPercent,
    );
    const scale = readoutPreview.scale;
    const scalePctReadout = Math.round(scale * 100);

    const totalSheets = Math.max(1, previewSheets.length);
    const sheetLabel = layoutMode === 'booklet'
        ? (previewSheets[sheetIndex]?.label === 'back' ? t('print:sheet_back') : t('print:sheet_front'))
        : layoutMode === 'poster'
            ? t('print:sheet_tile')
            : t('print:sheet');

    const setupLandscape = pageSetupOrientation === 'landscape';
    const setupPaperWmm = setupLandscape ? Math.max(geo.paper_w_mm, geo.paper_h_mm) : Math.min(geo.paper_w_mm, geo.paper_h_mm);
    const setupPaperHmm = setupLandscape ? Math.min(geo.paper_w_mm, geo.paper_h_mm) : Math.max(geo.paper_w_mm, geo.paper_h_mm);
    const setupPreviewScale = 140 / Math.max(setupPaperWmm, setupPaperHmm);
    const marginRightMm = Math.max(0, geo.paper_w_mm - geo.margin_left_mm - geo.printable_w_mm);
    const marginBottomMm = Math.max(0, geo.paper_h_mm - geo.margin_top_mm - geo.printable_h_mm);

    // Lắng nghe tiến độ in từ Rust (event print-progress).
    useEffect(() => {
        if (!('__TAURI_INTERNALS__' in window)) return;
        let unlisten: (() => void) | undefined;
        void (async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                unlisten = await listen<{ jobId?: string; current: number; total: number; done?: boolean }>('print-progress', (ev) => {
                    const p = ev.payload;
                    if (p?.jobId && p.jobId !== jobId) return;
                    if (p?.done) {
                        // PRINTWIN (audit 2026-08-13 §PRINTWIN.08): không hạ printing
                        // trước completePrint — tránh bấm In lần hai trên job/path đang dọn.
                        setPrintProgress(null);
                    } else if (p && p.total > 0) {
                        setPrintProgress({ current: p.current, total: p.total });
                        setPrinting(true);
                    }
                });
            } catch { /* ignore */ }
        })();
        return () => { unlisten?.(); };
    }, [jobId]);

    const buildPrintSettings = (): PrintSettings => {
        let from = actualNumPages;
        let to = 1;
        for (const page of basePageList) {
            from = Math.min(from, page);
            to = Math.max(to, page);
        }
        const explicitPages = rangeMode === 'range' || rangeMode === 'selection'
            ? [...basePageList]
            : null;
        return {
            printerName,
            copies: Math.max(1, Math.min(MAX_COPIES, copies)),
            collate,
            fromPage: from,
            toPage: to,
            pages: explicitPages,
            scaleMode,
            scalePercent: customPercent,
            orientation,
            grayscale,
            printAnnotations,
            devmode,
            reverse,
            pageSubset,
            layoutMode,
            pagesPerSheet,
            posterCols,
            posterRows,
        };
    };

    const runPrintAction = async (
        action: (settings: PrintSettings) => Promise<void>,
        options?: { requirePrinter?: boolean },
    ): Promise<void> => {
        const requirePrinter = options?.requirePrinter !== false;
        if ((requirePrinter && !printerName) || printing || pageSelectionError) return;
        setPrinting(true);
        setPrintProgress({ current: 0, total: 0 });
        setPrintError(null);
        try {
            await action(buildPrintSettings());
        } catch (error) {
            // UIUX (audit 2026-08-05 §PRINT.4): lỗi driver phải còn thấy được để chẩn đoán.
            setPrintError(error instanceof Error ? error.message : String(error));
        } finally {
            setPrinting(false);
            setPrintProgress(null);
        }
    };

    const handlePrint = () => {
        // UIUX (audit 2026-08-05 §PRINT.6): preview PDF.js lỗi không được khóa engine in native.
        void runPrintAction(onPrint);
    };

    const handleSystemPrint = () => {
        if (onSystemPrint) void runPrintAction(onSystemPrint, { requirePrinter: false });
    };

    const handleCancelPrint = () => {
        // PRINTWIN (audit 2026-08-13 §PRINTWIN.06): chỉ gửi tín hiệu hủy; giữ dialog
        // và file tạm tới khi worker trả terminal (lỗi hủy / xong).
        void onCancelPrint?.();
    };

    return createPortal(
        <div
            data-testid="print-dialog-overlay"
            className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={dialogBusy ? undefined : onCancel}
        >
            <div
                ref={dialogRef}
                tabIndex={-1}
                className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-6xl max-h-[94vh] overflow-hidden border border-slate-200 dark:border-zinc-700 flex flex-col"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="print-dialog-title"
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-700 flex items-center gap-2 shrink-0">
                    <Printer className="w-5 h-5 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
                    <h3 id="print-dialog-title" className="text-lg font-bold text-slate-800 dark:text-white">{t('print:title')}</h3>
                    <button type="button" onClick={onCancel} disabled={dialogBusy}
                        aria-label={t('print:close')}
                        className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-700 disabled:opacity-40">
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                <div className="flex flex-row min-h-0 flex-1">
                    {/* LEFT: controls */}
                    <div className="w-[540px] shrink-0 overflow-y-auto px-6 py-4 flex flex-col gap-4 border-r border-slate-200 dark:border-zinc-700">
                        {/* Printer */}
                        <section className="flex flex-col gap-2 pb-4 border-b border-slate-200 dark:border-zinc-700">
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:printer')}</span>
                            {printers.length === 0 ? (
                                <span className="text-sm text-amber-600">{t('print:no_printers')}</span>
                            ) : (
                                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                                    <select
                                        value={printerName}
                                        onChange={e => handlePrinterChange(e.target.value)}
                                        className="min-w-0 px-3 py-2 rounded-lg border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm text-slate-800 dark:text-slate-100"
                                    >
                                        {printers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                                    </select>
                                    <button type="button" disabled={propertiesBusy} onClick={() => void handleOpenProperties(false)}
                                        className="px-3 py-2 rounded-lg border border-slate-300 dark:border-zinc-600 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-zinc-700 disabled:opacity-50">
                                        {t('print:properties')}
                                    </button>
                                    <button type="button" disabled={propertiesBusy} onClick={() => void handleOpenProperties(true)}
                                        className="px-3 py-2 rounded-lg border border-slate-300 dark:border-zinc-600 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-zinc-700 disabled:opacity-50">
                                        {t('print:advanced')}
                                    </button>
                                </div>
                            )}
                            {propertiesError && (
                                <span role="alert" className="text-xs text-rose-600 dark:text-rose-400">{t('print:properties_failed')}</span>
                            )}
                        </section>

                        {/* Copies + collate */}
                        <div className="flex items-center gap-5 pb-4 border-b border-slate-200 dark:border-zinc-700">
                            <label className="flex flex-col gap-1.5">
                                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:copies')}</span>
                                <input
                                    type="number" min={1} max={MAX_COPIES} value={copies}
                                    onChange={e => setCopies(Math.max(1, Math.min(MAX_COPIES, parseInt(e.target.value) || 1)))}
                                    className="w-20 px-3 py-2 rounded-lg border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm text-slate-800 dark:text-slate-100"
                                />
                            </label>
                            <label className="flex items-center gap-2 mt-6 cursor-pointer">
                                <input type="checkbox" checked={collate} onChange={e => setCollate(e.target.checked)} className="accent-indigo-600" />
                                <span className="text-sm text-slate-700 dark:text-slate-200">{t('print:collate')}</span>
                            </label>
                            <label className="flex items-center gap-2 mt-6 cursor-pointer">
                                <input type="checkbox" checked={grayscale} onChange={e => setGrayscale(e.target.checked)} className="accent-indigo-600" />
                                <span className="text-sm text-slate-700 dark:text-slate-200">{t('print:grayscale')}</span>
                            </label>
                        </div>

                        {/* Pages */}
                        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t('print:pages')}>
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:pages')}</span>
                            {([
                                'all',
                                'current',
                                ...(selectedPages.length > 0 ? ['selection' as const] : []),
                                'range',
                            ] as RangeMode[]).map(m => (
                                <button type="button" key={m} onClick={() => setRangeMode(m)} className="flex items-center gap-2 text-left" role="radio" aria-checked={rangeMode === m}>
                                    <RadioMark checked={rangeMode === m} />
                                    <span className="text-sm text-slate-700 dark:text-slate-200">
                                        {m === 'all'
                                            ? t('print:pages_all')
                                            : m === 'current'
                                                ? t('print:pages_current')
                                                : m === 'selection'
                                                    ? t('print:pages_selected', { n: selectedPages.length })
                                                    : t('print:pages_range')}
                                    </span>
                                </button>
                            ))}
                            {rangeMode === 'range' && (
                                <div className="flex flex-col gap-1 pl-6 mt-1">
                                    <input
                                        type="text"
                                        inputMode="text"
                                        value={rangeText}
                                        aria-label={t('print:pages_list_label')}
                                        aria-invalid={Boolean(pageSelectionError)}
                                        onChange={event => setRangeText(event.target.value)}
                                        placeholder={t('print:pages_list_hint')}
                                        className={`w-full max-w-xs px-2 py-1 rounded border bg-white dark:bg-zinc-900 text-sm ${pageSelectionError
                                            ? 'border-rose-500 text-rose-700 dark:text-rose-300'
                                            : 'border-slate-300 dark:border-zinc-600'}`}
                                    />
                                    <span
                                        role={pageSelectionError ? 'alert' : undefined}
                                        className={`text-xs ${pageSelectionError ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'}`}
                                    >
                                        {pageSelectionError || t('print:pages_list_hint')}
                                    </span>
                                </div>
                            )}
                            <div className="flex flex-wrap items-center gap-3 pl-0 mt-2">
                                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                                    <span className="text-xs text-slate-500">{t('print:subset')}</span>
                                    <select value={pageSubset} onChange={e => setPageSubset(e.target.value as PrintPageSubset)}
                                        className="px-2 py-1 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm">
                                        <option value="all">{t('print:subset_all')}</option>
                                        <option value="odd">{t('print:subset_odd')}</option>
                                        <option value="even">{t('print:subset_even')}</option>
                                    </select>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700 dark:text-slate-200">
                                    <input type="checkbox" checked={reverse} onChange={e => setReverse(e.target.checked)} className="accent-indigo-600" />
                                    {t('print:reverse_order')}
                                </label>
                            </div>
                        </div>

                        {/* Layout: Size / Multiple / Booklet / Poster */}
                        <div className="flex flex-col gap-2 pt-1 border-t border-slate-200 dark:border-zinc-700" role="radiogroup" aria-label={t('print:sizing')}>
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:sizing')}</span>
                            <div className="grid grid-cols-4 gap-2" aria-label={t('print:sizing_modes')}>
                                {([
                                    ['size', 'size_tab'],
                                    ['multiple', 'multiple_tab'],
                                    ['booklet', 'booklet_tab'],
                                    ['poster', 'poster_tab'],
                                ] as const).map(([mode, labelKey]) => (
                                    <button type="button" key={mode} onClick={() => { setLayoutMode(mode); setSheetIndex(0); }}
                                        aria-pressed={layoutMode === mode}
                                        className={`px-2 py-1.5 rounded-md border text-sm font-medium ${layoutMode === mode
                                            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                                            : 'border-slate-300 dark:border-zinc-600 text-slate-700 dark:text-slate-200'}`}>
                                        {t(`print:${labelKey}`)}
                                    </button>
                                ))}
                            </div>

                            {layoutMode === 'multiple' && (
                                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                                    <span className="text-xs text-slate-500">{t('print:pages_per_sheet')}</span>
                                    <select value={pagesPerSheet} onChange={e => setPagesPerSheet(Number(e.target.value))}
                                        className="px-2 py-1 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm">
                                        {[2, 4, 6, 9, 16].map(n => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                </label>
                            )}
                            {layoutMode === 'booklet' && (
                                <p className="text-xs text-slate-500 dark:text-slate-400">{t('print:booklet_hint')}</p>
                            )}
                            {layoutMode === 'poster' && (
                                <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
                                    <label className="flex items-center gap-1">
                                        <span className="text-xs text-slate-500">{t('print:poster_cols')}</span>
                                        <input type="number" min={1} max={6} value={posterCols}
                                            onChange={e => setPosterCols(Math.max(1, Math.min(6, parseInt(e.target.value) || 2)))}
                                            className="w-14 px-2 py-1 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm" />
                                    </label>
                                    <span className="text-slate-400">×</span>
                                    <label className="flex items-center gap-1">
                                        <span className="text-xs text-slate-500">{t('print:poster_rows')}</span>
                                        <input type="number" min={1} max={6} value={posterRows}
                                            onChange={e => setPosterRows(Math.max(1, Math.min(6, parseInt(e.target.value) || 2)))}
                                            className="w-14 px-2 py-1 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm" />
                                    </label>
                                </div>
                            )}

                            {(layoutMode === 'size' || layoutMode === 'multiple' || layoutMode === 'poster') && (
                                <>
                                    {(['fit', 'actual', 'shrink', 'custom'] as PrintScaleMode[]).map(m => (
                                        <div key={m} className="flex items-center gap-2">
                                            <button type="button" onClick={() => setScaleMode(m)} className="flex items-center gap-2 text-left" role="radio" aria-checked={scaleMode === m}>
                                                <RadioMark checked={scaleMode === m} />
                                                <span className="text-sm text-slate-700 dark:text-slate-200">
                                                    {m === 'fit' ? t('print:size_fit') : m === 'actual' ? t('print:size_actual') : m === 'shrink' ? t('print:size_shrink') : t('print:size_custom')}
                                                </span>
                                            </button>
                                            {m === 'custom' && scaleMode === 'custom' && (
                                                <input type="number" min={1} max={1000} value={customPercent}
                                                    aria-label={t('print:custom_percent')}
                                                    onChange={e => setCustomPercent(Math.max(1, Math.min(1000, parseInt(e.target.value) || 100)))}
                                                    className="w-16 px-2 py-0.5 rounded border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm" />
                                            )}
                                        </div>
                                    ))}
                                </>
                            )}
                            {layoutMode === 'booklet' && (
                                <p className="text-xs text-slate-500">{t('print:booklet_scale_note')}</p>
                            )}
                        </div>

                        {/* Orientation */}
                        <div className="flex flex-col gap-1.5">
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:orientation')}</span>
                            <div className="flex gap-2">
                                {(['auto', 'portrait', 'landscape'] as PrintOrientation[]).map(o => (
                                    <button type="button" key={o} onClick={() => setOrientation(o)} aria-pressed={orientation === o}
                                        className={`px-3 py-1.5 rounded-lg border text-sm ${orientation === o ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' : 'border-slate-300 dark:border-zinc-600 text-slate-700 dark:text-slate-200'}`}>
                                        {o === 'auto' ? t('print:orient_auto') : o === 'portrait' ? t('print:orient_portrait') : t('print:orient_landscape')}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <label className="flex items-center gap-3 pt-3 border-t border-slate-200 dark:border-zinc-700">
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200 shrink-0">{t('print:comments_forms')}</span>
                            <select
                                value={printAnnotations ? 'document_markups' : 'document'}
                                onChange={e => setPrintAnnotations(e.target.value === 'document_markups')}
                                className="min-w-0 flex-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm text-slate-800 dark:text-slate-100"
                            >
                                <option value="document_markups">{t('print:document_markups')}</option>
                                <option value="document">{t('print:document_only')}</option>
                            </select>
                        </label>
                    </div>

                    {/* RIGHT: preview tờ in đúng layout (size / multi / booklet / poster) */}
                    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 p-6 bg-gradient-to-b from-slate-100 to-slate-200/80 dark:from-zinc-900/80 dark:to-zinc-950">
                        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 font-semibold uppercase tracking-wide">
                                {layoutMode === 'size' ? t('print:size_tab')
                                    : layoutMode === 'multiple' ? t('print:multiple_tab')
                                        : layoutMode === 'booklet' ? t('print:booklet_tab')
                                            : t('print:poster_tab')}
                            </span>
                            {/* UIUX (audit 2026-08-04 §DIM.4): nhãn dùng đúng geometry máy in, không làm tròn mm nguyên. */}
                            <span>{formatSizeMm(geo.paper_w_mm, geo.paper_h_mm)}</span>
                            <span>·</span>
                            <span>{paperLandscape ? t('print:orient_landscape') : t('print:orient_portrait')}</span>
                            {printPageList.length > 0 && (
                                <>
                                    <span>·</span>
                                    <span>{t('print:pages_in_job', { n: printPageList.length })}</span>
                                </>
                            )}
                        </div>
                        <div
                            className="relative overflow-hidden rounded-sm bg-white shadow-[0_12px_40px_rgba(15,23,42,0.18)] ring-1 ring-slate-300/80 dark:ring-zinc-600"
                            style={{ width: paperWpx, height: paperHpx }}
                        >
                            {sheetImg && (
                                <img src={sheetImg} alt="" className="absolute inset-0 w-full h-full object-fill select-none" draggable={false} />
                            )}
                            {previewError && !previewLoading && (
                                <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-amber-700 dark:text-amber-300 bg-white/90">
                                    {t(source.size > MAX_PRINT_PREVIEW_BYTES ? 'print:preview_skipped_large' : 'print:preview_failed')}
                                </div>
                            )}
                            {previewLoading && (
                                <div className="absolute inset-0 flex items-center justify-center bg-white/40 backdrop-blur-[1px]">
                                    <div className="w-7 h-7 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                                </div>
                            )}
                        </div>
                        {/* Nav theo TỜ in (không chỉ trang PDF) */}
                        <div className="flex flex-wrap items-center justify-center gap-3">
                            <button type="button" aria-label={t('print:previous_sheet')}
                                disabled={sheetIndex <= 0}
                                onClick={() => setSheetIndex((i) => Math.max(0, i - 1))}
                                className="p-1.5 rounded-lg disabled:opacity-30 hover:bg-white/80 dark:hover:bg-zinc-800 shadow-sm border border-slate-200/80 dark:border-zinc-700">
                                <ChevronLeft className="w-5 h-5 text-slate-600 dark:text-slate-300" aria-hidden="true" />
                            </button>
                            <span className="text-sm font-medium text-slate-700 dark:text-slate-200 tabular-nums min-w-[10rem] text-center">
                                {t('print:sheet_x_of_n', {
                                    sheet: Math.min(sheetIndex + 1, totalSheets),
                                    total: totalSheets,
                                    kind: sheetLabel,
                                })}
                            </span>
                            <button type="button" aria-label={t('print:next_sheet')}
                                disabled={sheetIndex >= totalSheets - 1}
                                onClick={() => setSheetIndex((i) => Math.min(totalSheets - 1, i + 1))}
                                className="p-1.5 rounded-lg disabled:opacity-30 hover:bg-white/80 dark:hover:bg-zinc-800 shadow-sm border border-slate-200/80 dark:border-zinc-700">
                                <ChevronRight className="w-5 h-5 text-slate-600 dark:text-slate-300" aria-hidden="true" />
                            </button>
                            <span className="text-xs text-slate-400">·</span>
                            <span className="text-sm text-slate-500 dark:text-slate-400">{t('print:scale_readout', { pct: scalePctReadout })}</span>
                        </div>
                        {rangeMode === 'current' && layoutMode === 'size' && (
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                <span>{t('print:pages_current')}:</span>
                                <button type="button" disabled={previewPage <= 1}
                                    onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                                    className="px-1.5 py-0.5 rounded border border-slate-300 dark:border-zinc-600 disabled:opacity-30">‹</button>
                                <span className="tabular-nums">{previewPage}/{actualNumPages}</span>
                                <button type="button" disabled={previewPage >= actualNumPages}
                                    onClick={() => setPreviewPage((p) => Math.min(actualNumPages, p + 1))}
                                    className="px-1.5 py-0.5 rounded border border-slate-300 dark:border-zinc-600 disabled:opacity-30">›</button>
                            </div>
                        )}
                    </div>
                </div>

                {printError && (
                    <div role="alert" className="px-6 py-3 border-t border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30">
                        <p className="text-sm font-medium text-rose-700 dark:text-rose-300">
                            {t('print:job_failed', { error: printError })}
                        </p>
                        {onSystemPrint && (
                            <p className="mt-1 text-xs text-rose-600/90 dark:text-rose-300/80">
                                {t('print:system_dialog_hint')}
                            </p>
                        )}
                    </div>
                )}

                {/* Footer */}
                <div className="px-6 py-4 bg-slate-50 dark:bg-zinc-900 border-t border-slate-200 dark:border-zinc-700 flex justify-between items-center shrink-0 gap-3">
                    <button type="button" onClick={openPageSetup} disabled={printing}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-40">
                        {t('print:page_setup')}
                    </button>
                    {printProgress && printProgress.total > 0 && (
                        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                            {t('print:progress', { current: printProgress.current, total: printProgress.total })}
                        </span>
                    )}
                    <div className="flex gap-3 ml-auto">
                        {(printError || printers.length === 0) && onSystemPrint && (
                            <button type="button" onClick={handleSystemPrint} disabled={printing || Boolean(pageSelectionError)}
                                className="px-4 py-2 rounded-lg font-medium border border-amber-400/80 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-40 transition-colors">
                                {t('print:try_system_dialog')}
                            </button>
                        )}
                        <button type="button" onClick={printing ? handleCancelPrint : onCancel} disabled={propertiesBusy && !printing}
                            className="px-4 py-2 rounded-lg font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-40">
                            {printing ? t('print:cancel_job') : t('print:cancel')}
                        </button>
                        <button type="button" onClick={handlePrint} disabled={!printerName || printing || Boolean(pageSelectionError)}
                            className="px-5 py-2 rounded-lg font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                            {printing ? t('print:printing') : t('print:print')}
                        </button>
                    </div>
                </div>
                {pageSetupOpen && (
                    <div
                        className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-900/45 p-4"
                        onClick={() => setPageSetupOpen(false)}
                    >
                        <div
                            data-page-setup
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="page-setup-title"
                            onClick={e => e.stopPropagation()}
                            className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-800"
                        >
                            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-zinc-700">
                                <h4 id="page-setup-title" className="font-semibold text-slate-800 dark:text-white">{t('print:page_setup')}</h4>
                                <button type="button" onClick={() => setPageSetupOpen(false)} aria-label={t('print:cancel')}
                                    className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-700">
                                    <X className="h-5 w-5" aria-hidden="true" />
                                </button>
                            </div>

                            <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-5 p-5">
                                <div className="flex items-center justify-center rounded-lg bg-slate-100 p-3 dark:bg-zinc-900/60">
                                    <div className="relative bg-white shadow-md border border-slate-300"
                                        style={{ width: setupPaperWmm * setupPreviewScale, height: setupPaperHmm * setupPreviewScale }}>
                                        <div className="absolute border border-dashed border-slate-300"
                                            style={{
                                                left: geo.margin_left_mm * setupPreviewScale,
                                                top: geo.margin_top_mm * setupPreviewScale,
                                                width: Math.min(geo.printable_w_mm, setupPaperWmm) * setupPreviewScale,
                                                height: Math.min(geo.printable_h_mm, setupPaperHmm) * setupPreviewScale,
                                            }} />
                                    </div>
                                </div>

                                <div className="flex min-w-0 flex-col gap-4">
                                    <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
                                        <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:paper')}</legend>
                                        <div className="flex items-end gap-2">
                                            <label className="min-w-0 flex-1">
                                                <span className="mb-1 block text-xs text-slate-500">{t('print:paper_size')}</span>
                                                <select disabled className="w-full rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5 text-sm text-slate-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-slate-300">
                                                    <option>{setupPaperWmm.toFixed(1)} × {setupPaperHmm.toFixed(1)} mm</option>
                                                </select>
                                            </label>
                                            <button type="button" disabled={propertiesBusy} onClick={() => void handleOpenProperties(false)}
                                                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-zinc-600 dark:text-slate-200 dark:hover:bg-zinc-700">
                                                {t('print:change')}
                                            </button>
                                        </div>
                                        <p className="mt-2 text-xs text-slate-500">{t('print:paper_driver_hint')}</p>
                                    </fieldset>

                                    <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
                                        <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:orientation')}</legend>
                                        <div className="flex gap-4">
                                            {(['portrait', 'landscape'] as PrintOrientation[]).map(value => (
                                                <button type="button" key={value} role="radio" aria-checked={pageSetupOrientation === value}
                                                    onClick={() => setPageSetupOrientation(value)}
                                                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                                                    <RadioMark checked={pageSetupOrientation === value} />
                                                    {value === 'portrait' ? t('print:orient_portrait') : t('print:orient_landscape')}
                                                </button>
                                            ))}
                                        </div>
                                    </fieldset>

                                    <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-zinc-700">
                                        <legend className="px-1 text-sm font-semibold text-slate-700 dark:text-slate-200">{t('print:margins_mm')}</legend>
                                        <div className="grid grid-cols-2 gap-2">
                                            {[
                                                [t('print:margin_left'), geo.margin_left_mm],
                                                [t('print:margin_right'), marginRightMm],
                                                [t('print:margin_top'), geo.margin_top_mm],
                                                [t('print:margin_bottom'), marginBottomMm],
                                            ].map(([label, value]) => (
                                                <label key={String(label)} className="flex items-center gap-2 text-xs text-slate-500">
                                                    <span className="w-12">{label}</span>
                                                    <input readOnly value={Number(value).toFixed(1)}
                                                        className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                                                </label>
                                            ))}
                                        </div>
                                    </fieldset>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-zinc-700 dark:bg-zinc-900">
                                <button type="button" onClick={() => setPageSetupOpen(false)}
                                    className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-zinc-700">
                                    {t('print:cancel')}
                                </button>
                                <button type="button" onClick={() => { setOrientation(pageSetupOrientation); setPageSetupOpen(false); }}
                                    className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700">
                                    {t('print:ok')}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

            </div>
        </div>,
        document.body,
    );
}
