import { useState, useEffect, useRef, useCallback } from 'react';
import { pdfjs } from 'react-pdf';
import { thumbCacheRef } from '../../components/workspace/ViewerHelpers';
import { clearTileUrlCache } from '../../components/workspace/LivePageFrame';

export interface PageDim {
    w: number;
    h: number;
    widthPt?: number;
}

export interface UsePdfLoaderResult {
    pdfRef: any;
    thumbPdfRef: any;
    pageDim: { w: number; h: number } | null;
    allPageDims: Record<number, { w: number; h: number; widthPt: number }>;
    pageWidthPt: number;
    plateLabels: Record<number, string>;
    numPages: number;
    pageOrder: number[];
    setPageOrder: React.Dispatch<React.SetStateAction<number[]>>;
    selectedIndices: Set<number>;
    setSelectedIndices: React.Dispatch<React.SetStateAction<Set<number>>>;
    lastSelectedIndex: number | null;
    setLastSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>;
    loadError: Error | null;
}

interface UsePdfLoaderProps {
    file: any;
    pdfUrl: string | null;
    setNumPages: (n: number) => void;
    setActivePage: (p: number) => void;
    setZoom: (z: number) => void;
    containerRef: React.RefObject<HTMLDivElement | null>;
}

export function usePdfLoader({
    file, pdfUrl, setNumPages, setActivePage, setZoom, containerRef
}: UsePdfLoaderProps) {
    const [pdfRef, setPdfRef] = useState<any>(null);
    const [thumbPdfRef, setThumbPdfRef] = useState<any>(null);
    const [pageDim, setPageDim] = useState<{ w: number; h: number } | null>(null);
    const [allPageDims, setAllPageDims] = useState<Record<number, { w: number; h: number; widthPt: number }>>({});
    const [pageWidthPt, setPageWidthPt] = useState<number>(595);
    const [plateLabels, setPlateLabels] = useState<Record<number, string>>({});

    const [pageOrder, setPageOrder] = useState<number[]>([]);
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0]));
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(0);

    const [pageRotations, setPageRotations] = useState<Record<number, number>>({});

    // -- Undo/Redo stacks live here as they are tightly coupled with page state --
    const [pastStack, setPastStack] = useState<any[]>([]);
    const [futureStack, setFutureStack] = useState<any[]>([]);
    
    const [loadError, setLoadError] = useState<Error | null>(null);

    const prevPdfUrlRef = useRef<string | null>(null);

    // Clear stale tile cache on new file load
    useEffect(() => {
        // Edit-commit: KHÔNG xóa toàn bộ cache tile (key cũ theo pdfUrl cũ không trùng
        // key mới nên tự vô hiệu) → tránh white-flash các trang khác.
        if ((file as any)?.__editCommit) return;
        if (file || pdfUrl) {
            clearTileUrlCache();
        }
    }, [file, pdfUrl]);

    // Main PDF loading effect
    useEffect(() => {
        const isSameUrl = prevPdfUrlRef.current === pdfUrl;
        prevPdfUrlRef.current = pdfUrl;

        // Edit-commit: cùng cấu trúc trang (số trang/kích thước/thứ tự KHÔNG đổi) →
        // KHÔNG nạp lại metadata, KHÔNG setNumPages(0) (gây unmount toàn viewer +
        // spinner), KHÔNG reset scroll/zoom/selection/undo. Tile tự nạp lại do
        // LiveTile khóa theo pdfUrl (đã đổi); overlay /edit/objects refetch theo fid.
        if ((file as any)?.__editCommit) {
            return;
        }

        setPdfRef(null);
        setAllPageDims({});
        setThumbPdfRef(null);
        setNumPages(0);

        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);

        // Trang trắng mới tạo: kích thước đã biết sẵn → dựng đồng bộ, KHÔNG nạp pdfjs/pdfium.
        // Tránh cold-start "đang tải PDF" + "rendering" cho một trang trắng đơn giản.
        if ((file as any)?.isBlank) {
            const wPt = (file as any).blankWidthPt || 595;
            const hPt = (file as any).blankHeightPt || 842;
            const count = (file as any).blankPageCount || 1;
            const w = wPt * (96 / 72);
            const h = hPt * (96 / 72);
            setPageWidthPt(wPt);
            setPageDim({ w, h });
            setNumPages(count);
            const dims: Record<number, { w: number; h: number; widthPt: number }> = {};
            for (let i = 1; i <= count; i++) dims[i] = { w, h, widthPt: wPt };
            setAllPageDims(dims);
            setPageOrder(Array.from({ length: count }, (_, i) => i + 1));
            if (!isSameUrl) {
                setSelectedIndices(new Set([0]));
                setLastSelectedIndex(0);
                setPastStack([]);
                setFutureStack([]);
                setPageRotations({});
                setActivePage(1);
                setPlateLabels({});
                if (containerRef.current) {
                    const safeContainerWidth = Math.max(100, containerRef.current.clientWidth - 16);
                    setZoom(safeContainerWidth / w);
                }
            }
            return;
        }

        if (isImage && pdfUrl) {
            let cancelled = false;
            const img = new Image();
            img.onload = () => {
                if (cancelled) return;
                const w = img.width;
                const h = img.height;
                setPageWidthPt(w);
                setPageDim({ w, h });
                setNumPages(1);
                setAllPageDims({ 1: { w, h, widthPt: w } });
                setPageOrder([1]);
                setSelectedIndices(new Set([0]));
                setLastSelectedIndex(0);
                setActivePage(1);
            };
            img.src = pdfUrl;
            return () => { cancelled = true; };
        }

        if (pdfUrl && (file as any)?.path && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
            let cancelled = false;
            (async () => {
                try {
                    const filePath = (file as any).path;
                    let numPagesFromEngine = 0;
                    let widthPt = 0;
                    let heightPt = 0;
                    const allDims: Record<number, { widthPt: number, heightPt: number }> = {};
                    
                    // Lấy metadata bằng Rust/pdfium CỤC BỘ (nhanh, không qua HTTP Python),
                    // đồng thời NẠP SẴN file vào pdfium cache → tile đầu tiên render tức thì.
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const meta: any = await invoke('get_pdf_metadata', { filePath });
                        numPagesFromEngine = meta.numPages || 0;
                        widthPt = meta.widthPt || 0;
                        heightPt = meta.heightPt || 0;
                        if (meta.allDims) {
                            for (const k of Object.keys(meta.allDims)) {
                                const d = meta.allDims[k];
                                allDims[parseInt(k, 10)] = { widthPt: d.widthPt, heightPt: d.heightPt };
                            }
                        }
                    } catch (rustErr) {
                        // Fallback: backend Python qua HTTP (nếu lệnh Rust lỗi)
                        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8321';
                        const res = await fetch(`${apiUrl}/api/imposition/pdf-meta`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: filePath })
                        });
                        if (res.ok) {
                            const meta = await res.json();
                            numPagesFromEngine = meta.page_count || 0;
                            widthPt = meta.max_width_pt || 0;
                            heightPt = meta.max_height_pt || 0;
                            if (meta.pages) {
                                for (const p of meta.pages) {
                                    allDims[p.index + 1] = { widthPt: p.width_pt, heightPt: p.height_pt };
                                }
                            }
                        } else {
                            const errText = await res.text();
                            if (!cancelled) {
                                setLoadError(new Error(`API Error: ${res.status} - ${errText}`));
                                return;
                            }
                        }
                    }

                    if (cancelled) return;

                    setPageWidthPt(widthPt);
                    setPageDim({ w: widthPt * (96 / 72), h: heightPt * (96 / 72) });
                    setNumPages(numPagesFromEngine);

                    const dims: Record<number, { w: number; h: number; widthPt: number }> = {};
                    const baseW = widthPt * (96 / 72);
                    const baseH = heightPt * (96 / 72);
                    for (let i = 1; i <= numPagesFromEngine; i++) {
                        if (allDims[i]) {
                            const w = allDims[i].widthPt;
                            const h = allDims[i].heightPt;
                            dims[i] = { w: w * (96 / 72), h: h * (96 / 72), widthPt: w };
                        } else {
                            dims[i] = { w: baseW, h: baseH, widthPt: widthPt };
                        }
                    }
                    setAllPageDims(dims);

                    if ((window as any).__prynx_cross_file_page_order) {
                        setPageOrder((window as any).__prynx_cross_file_page_order);
                        setTimeout(() => { (window as any).__prynx_cross_file_page_order = null; }, 100);
                    } else {
                        setPageOrder(prev => (isSameUrl && prev.length === numPagesFromEngine) ? prev : Array.from({ length: numPagesFromEngine }, (_, i) => i + 1));
                    }
                    
                    if (!isSameUrl) {
                        setSelectedIndices(new Set([0]));
                        setLastSelectedIndex(0);
                        setPastStack([]);
                        setFutureStack([]);
                        setPageRotations({});
                        setActivePage(1);
                        setPlateLabels({});
                    }

                    // Background: detect plate labels (for spot colors)
                    // Skip for large files — fetching cả file vào RAM gây nghẽn main
                    // thread + cấp phát blob lớn (giun.pdf 96MB từng làm "load" treo ~4s).
                    // Dùng KÍCH THƯỚC FILE đã biết (file.size) để bỏ qua TRƯỚC khi fetch,
                    // thay vì tải hết về rồi mới kiểm tra .size (lãng phí toàn bộ băng thông).
                    const knownSize = (file as any)?.size || 0;
                    if (numPagesFromEngine <= 100 && knownSize > 0 && knownSize <= 30 * 1024 * 1024) {
                        setTimeout(async () => {
                            try {
                                const resp = await fetch(pdfUrl);
                                const blob = await resp.blob();
                                if (blob.size > 30 * 1024 * 1024) return;
                                const buf = await blob.arrayBuffer();
                                const worker = new Worker(new URL('../../workers/plateInfoWorker.ts', import.meta.url), { type: 'module' });
                                worker.onmessage = (e) => {
                                    if (e.data.success && Object.keys(e.data.labels).length > 0 && !cancelled) {
                                        setPlateLabels(e.data.labels);
                                    }
                                    worker.terminate();
                                };
                                worker.onerror = () => worker.terminate();
                                worker.postMessage({ buf }, [buf]);
                            } catch (e) { }
                        }, 100);
                    }

                } catch (e) {
                    console.error('[usePdfLoader] Fast Native Load Failed', e);
                }
            })();
            return () => { cancelled = true; };
        } else if (pdfUrl && (!(window as any).__TAURI_INTERNALS__ || (file as any)?.isInMemory || !(file as any)?.path)) {
            let cancelled = false;
            (async () => {
                try {
                    const doc = await pdfjs.getDocument(pdfUrl).promise;
                    if (cancelled) return;
                    setPdfRef(doc);
                    setThumbPdfRef(doc);
                    setNumPages(doc.numPages);
                    if ((window as any).__prynx_cross_file_page_order) {
                        setPageOrder((window as any).__prynx_cross_file_page_order);
                        setTimeout(() => { (window as any).__prynx_cross_file_page_order = null; }, 100);
                    } else {
                        setPageOrder(prev => (isSameUrl && prev.length === doc.numPages) ? prev : Array.from({ length: doc.numPages }, (_, i) => i + 1));
                    }

                    if (!isSameUrl) {
                        setSelectedIndices(new Set([0]));
                        setLastSelectedIndex(0);
                        setPastStack([]);
                        setFutureStack([]);
                        setPageRotations({});
                        setActivePage(1);
                        setPlateLabels({});
                    }

                    const dims: Record<number, { w: number; h: number; widthPt: number }> = {};
                    
                    if (doc.numPages > 100) {
                        // For huge documents (e.g. VDP outputs), avoid 50,000 concurrent promises which causes OOM.
                        // Assume all pages have the same dimensions as Page 1.
                        try {
                            const p1 = await doc.getPage(1);
                            const v = p1.getViewport({ scale: 1 });
                            const dimObj = { w: v.width * (96 / 72), h: v.height * (96 / 72), widthPt: v.width };
                            for (let i = 1; i <= doc.numPages; i++) {
                                dims[i] = dimObj;
                            }
                        } catch (e) { console.error('Failed to get page 1', e); }
                    } else {
                        const promises = [];
                        for (let i = 1; i <= doc.numPages; i++) {
                            promises.push(doc.getPage(i).then((p: any) => {
                                const v = p.getViewport({ scale: 1 });
                                dims[i] = { w: v.width * (96 / 72), h: v.height * (96 / 72), widthPt: v.width };
                            }).catch(() => { }));
                        }
                        await Promise.all(promises);
                    }
                    
                    if (cancelled) return;
                    setAllPageDims(dims);

                    if (dims[1]) {
                        setPageWidthPt(dims[1].widthPt);
                        setPageDim({ w: dims[1].w, h: dims[1].h });
                        const actual100 = dims[1].w;
                        if (containerRef.current) {
                            const safeContainerWidth = Math.max(100, containerRef.current.clientWidth - 16);
                            setZoom(safeContainerWidth / actual100);
                        }
                    }
                } catch (e) { }
            })();
            return () => { cancelled = true; };
        }
    }, [pdfUrl, file]);

    // Update pageDim when active page changes (for multi-size PDFs)
    const updatePageDimForPage = useCallback(async (activePage: number, numPagesCount: number) => {
        if (pdfRef && activePage > 0 && activePage <= numPagesCount) {
            try {
                const page = await pdfRef.getPage(activePage);
                const vp = page.getViewport({ scale: 1 });
                setPageWidthPt(vp.width);
                setPageDim({
                    w: vp.width * (96 / 72),
                    h: vp.height * (96 / 72)
                });
            } catch { }
        }
    }, [pdfRef]);

    // Thumbnail generation helper
    const generateThumb = useCallback(async (pdf: any, pageNum: number, rotation: number, width: number) => {
        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);
        if (isImage) return;
        if ((file as any)?.path) return; // Tauri Mode: use native tile:// protocol

        const cacheKey = `${pdfUrl}_${pageNum}_${rotation}_${width}`;
        if (thumbCacheRef.current.has(cacheKey)) return;

        try {
            const page = await pdf.getPage(pageNum);
            const vp = page.getViewport({ scale: 1, rotation });
            const scale = width / vp.width;
            const scaledVp = page.getViewport({ scale, rotation });
            const canvas = document.createElement('canvas');
            canvas.width = scaledVp.width;
            canvas.height = scaledVp.height;
            const ctx = canvas.getContext('2d')!;

            await page.render({ canvasContext: ctx, viewport: scaledVp }).promise;
            const url = canvas.toDataURL('image/jpeg', 0.7);
            canvas.width = 0; canvas.height = 0;

            thumbCacheRef.current.set(cacheKey, url);
        } catch (e) { console.warn('Thumb gen err', e); }
    }, [pdfUrl, file]);

    return {
        pdfRef,
        thumbPdfRef,
        pageDim,
        allPageDims,
        pageWidthPt,
        plateLabels,
        pageOrder, setPageOrder,
        selectedIndices, setSelectedIndices,
        lastSelectedIndex, setLastSelectedIndex,
        pageRotations, setPageRotations,
        pastStack, setPastStack,
        futureStack, setFutureStack,
        updatePageDimForPage,
        generateThumb,
        loadError,
    };
}
