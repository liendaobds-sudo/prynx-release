import { useState, useEffect, useRef, useCallback } from 'react';
import { pdfjs } from 'react-pdf';
import { thumbCacheRef, putThumbCache } from '../../components/workspace/thumbnailCache';
import { clearTileUrlCache } from '../../components/workspace/LivePageFrame';

export const PDF_LOAD_SLOW_NOTICE_MS = 10_000;
export type PdfLoadStatus = 'idle' | 'loading' | 'slow' | 'ready' | 'error' | 'cancelled';
type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>;
type PdfLoadFileIdentity = { name?: string; size?: number; lastModified?: number; path?: string };

function normalizeLoadError(error: unknown): Error {
    if (error instanceof Error) return error;
    if (typeof error === 'string' && error.trim()) return new Error(error);
    return new Error('Không thể đọc file PDF.');
}

function loadSourceKey(file: PdfLoadFileIdentity | null | undefined, pdfUrl: string | null): string {
    return [pdfUrl || '', file?.path || '', file?.name || '', file?.size || 0, file?.lastModified || 0].join('|');
}

export interface PageDim {
    w: number;
    h: number;
    widthPt?: number;
}

export interface PdfPageColorRisk {
    page: number;
    highRisk: boolean;
    accurateColorRecommended: boolean;
    hasDeviceCmyk: boolean;
    hasDeviceN: boolean;
    hasSeparation: boolean;
    hasTransparency: boolean;
    hasSoftMask: boolean;
    hasBlendMode: boolean;
}

export interface PdfColorRiskSummary {
    highRisk: boolean;
    accurateColorRecommended: boolean;
    hasOutputIntent: boolean;
    riskyPages: number[];
    pages: PdfPageColorRisk[];
    reasonCodes: string[];
}

export interface PdfRenderEngineIdentity {
    libraryPath: string;
    sizeBytes: number | null;
    modifiedMillis: number | null;
    appVersion: string;
    tileCacheVersion: string;
}

// ── Per-instance page id (per-instance rotation) ──
// pageOrder[i] = số trang gốc (nhiều index có thể trùng khi nhân bản). pageInstanceIds[i]
// = mã DUY NHẤT cho từng ô trong danh sách → rotation keyed theo id này thay vì số trang
// → nhân bản 1 trang rồi xoay 1 bản KHÔNG làm bản kia xoay theo. Counter module-level:
// chỉ cần duy nhất trong phiên (không cần deterministic theo nội dung).
let _pageIdSeq = 0;
export function genPageId(): string { return `p${++_pageIdSeq}`; }
export function genPageIds(n: number): string[] {
    return Array.from({ length: n }, () => genPageId());
}

// Flatten rotation (keyed theo instance-id, sống trong viewer) → number[] THEO VỊ TRÍ
// (out[i] = góc của trang ở vị trí i trong pageOrder). Đây là dạng serialize ra store/
// recovery/recipe/backend: khi đã cố định thứ tự mảng thì "góc tại vị trí i" là đủ để
// biểu diễn per-instance, KHÔNG cần mang instance-id ra ngoài. Backend impose + bake đều
// lặp theo vị trí nên nhận number[] này trực tiếp (audit per-instance rotation 2026-07-06).
export function flattenRotations(ids: string[], map: Record<string, number>): number[] {
    return ids.map(id => map[id] || 0);
}

export interface UsePdfLoaderResult {
    pdfRef: any;
    thumbPdfRef: any;
    pageDim: { w: number; h: number } | null;
    allPageDims: Record<number, { w: number; h: number; widthPt: number }>;
    pageWidthPt: number;
    plateLabels: Record<number, string>;
    colorRisk: PdfColorRiskSummary | null;
    renderEngine: PdfRenderEngineIdentity | null;
    numPages: number;
    pageOrder: number[];
    setPageOrder: React.Dispatch<React.SetStateAction<number[]>>;
    pageInstanceIds: string[];
    setPageInstanceIds: React.Dispatch<React.SetStateAction<string[]>>;
    selectedIndices: Set<number>;
    setSelectedIndices: React.Dispatch<React.SetStateAction<Set<number>>>;
    lastSelectedIndex: number | null;
    setLastSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>;
    loadError: Error | null;
    loadStatus: PdfLoadStatus;
    retryLoad: () => void;
    cancelLoad: () => void;
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
    const [colorRisk, setColorRisk] = useState<PdfColorRiskSummary | null>(null);
    const [renderEngine, setRenderEngine] = useState<PdfRenderEngineIdentity | null>(null);

    const [pageOrder, setPageOrder] = useState<number[]>([]);
    // Song song pageOrder: id duy nhất cho MỖI vị trí trang (kể cả bản nhân bản cùng
    // số trang gốc) → rotation keyed theo id này để xoay độc lập từng bản.
    const [pageInstanceIds, setPageInstanceIds] = useState<string[]>([]);
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0]));
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(0);

    const [pageRotations, setPageRotations] = useState<Record<string, number>>({});

    // -- Undo/Redo stacks live here as they are tightly coupled with page state --
    const [pastStack, setPastStack] = useState<any[]>([]);
    const [futureStack, setFutureStack] = useState<any[]>([]);
    
    const [loadError, setLoadError] = useState<Error | null>(null);
    const [loadStatus, setLoadStatus] = useState<PdfLoadStatus>('idle');
    const [loadRevision, setLoadRevision] = useState(0);

    const prevPdfUrlRef = useRef<string | null>(null);
    const loadingTaskRef = useRef<PdfLoadingTask | null>(null);
    const cancelledSourceRef = useRef<string | null>(null);
    const loadGenerationRef = useRef(0);
    const sourceKey = loadSourceKey(file, pdfUrl);
    const nativeFilePath = typeof file?.path === 'string' && file.path ? file.path : null;

    const retryLoad = useCallback(() => {
        loadGenerationRef.current += 1;
        cancelledSourceRef.current = null;
        const task = loadingTaskRef.current;
        loadingTaskRef.current = null;
        void Promise.resolve(task?.destroy?.()).catch(() => undefined);
        console.info('[PDF-LOAD]', {
            stage: 'retry',
            fileName: file?.name || '',
            fileSize: file?.size || 0,
            source: file?.path ? 'native' : 'memory',
        });
        setLoadRevision(value => value + 1);
    }, [file]);

    const cancelLoad = useCallback(() => {
        loadGenerationRef.current += 1;
        cancelledSourceRef.current = sourceKey;
        const task = loadingTaskRef.current;
        loadingTaskRef.current = null;
        void Promise.resolve(task?.destroy?.()).catch(() => undefined);
        console.info('[PDF-LOAD]', {
            stage: 'cancel',
            fileName: file?.name || '',
            fileSize: file?.size || 0,
            source: file?.path ? 'native' : 'memory',
        });
        setLoadError(null);
        setLoadStatus('cancelled');
        setNumPages(0);
        setLoadRevision(value => value + 1);
    }, [file, setNumPages, sourceKey]);

    useEffect(() => {
        if (!nativeFilePath || !(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
            return;
        }
        const leasedPath = nativeFilePath;
        return () => {
            // PERF (audit 2026-08-02 §LOAD.3): native giữ Arc cho render đang chạy nên
            // close chỉ remove cache entry; handle thật đóng sau terminal callback.
            void import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke<boolean>('close_pdf_document', { filePath: leasedPath }))
                .catch(() => undefined);
        };
    }, [nativeFilePath, sourceKey]);

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
        const generation = ++loadGenerationRef.current;
        const isSameUrl = prevPdfUrlRef.current === pdfUrl;
        prevPdfUrlRef.current = pdfUrl;

        // Edit-commit: cùng cấu trúc trang (số trang/kích thước/thứ tự KHÔNG đổi) →
        // KHÔNG nạp lại metadata, KHÔNG setNumPages(0) (gây unmount toàn viewer +
        // spinner), KHÔNG reset scroll/zoom/selection/undo. Tile tự nạp lại do
        // LiveTile khóa theo pdfUrl (đã đổi); overlay /edit/objects refetch theo fid.
        if ((file as any)?.__editCommit) {
            return;
        }

        // Lưu bằng COPY đĩa→đĩa chỉ đổi .path của `file`, pdfUrl + nội dung GIỮ NGUYÊN.
        // Không có gì để nạp lại → return sớm (như __editCommit) để không setNumPages(0)
        // (unmount viewer + spinner) và không re-render toàn bộ trang/thumbnail vô ích.
        if ((file as any)?.__pathRebaseOnly && isSameUrl) {
            return;
        }

        setPdfRef(null);
        setAllPageDims({});
        setThumbPdfRef(null);
        setColorRisk(null);
        setRenderEngine(null);
        setNumPages(0);

        // UIUX (audit 2026-08-01 §A.1+A.2): mỗi lượt tải thật phải có trạng thái
        // kết thúc rõ ràng; lỗi của file trước không được bám sang file mới.
        if (cancelledSourceRef.current === sourceKey) {
            setLoadError(null);
            setLoadStatus('cancelled');
            return;
        }
        cancelledSourceRef.current = null;
        setLoadError(null);
        setLoadStatus(pdfUrl ? 'loading' : 'idle');

        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);

        let cancelled = false;
        let loadingTask: PdfLoadingTask | null = null;
        let httpAbortController: AbortController | null = null;
        let slowTimer: number | undefined;
        const startedAt = performance.now();
        const logBase = {
            fileName: file?.name || '',
            fileSize: file?.size || 0,
            source: file?.path ? 'native' : 'memory',
            urlKind: pdfUrl?.startsWith('blob:') ? 'blob' : (pdfUrl ? 'other' : 'none'),
            attempt: loadRevision + 1,
        };
        const clearSlowTimer = () => {
            if (slowTimer !== undefined) window.clearTimeout(slowTimer);
        };
        const startSlowWatchdog = () => {
            console.info('[PDF-LOAD]', { ...logBase, stage: 'start' });
            slowTimer = window.setTimeout(() => {
                if (cancelled || generation !== loadGenerationRef.current) return;
                // Chỉ đổi UI để người dùng biết tác vụ còn chạy; KHÔNG timeout/hard-cap.
                setLoadStatus(current => current === 'loading' ? 'slow' : current);
                console.info('[PDF-LOAD]', {
                    ...logBase,
                    stage: 'slow',
                    elapsedMs: Math.round(performance.now() - startedAt),
                });
            }, PDF_LOAD_SLOW_NOTICE_MS);
        };
        const markReady = (pages: number) => {
            if (cancelled || generation !== loadGenerationRef.current) return;
            clearSlowTimer();
            setLoadStatus('ready');
            console.info('[PDF-LOAD]', {
                ...logBase,
                stage: 'ready',
                pages,
                elapsedMs: Math.round(performance.now() - startedAt),
            });
        };
        const markError = (error: unknown, stage: string) => {
            if (cancelled || generation !== loadGenerationRef.current) return;
            clearSlowTimer();
            const normalized = normalizeLoadError(error);
            setLoadError(normalized);
            setLoadStatus('error');
            console.error('[PDF-LOAD]', {
                ...logBase,
                stage,
                elapsedMs: Math.round(performance.now() - startedAt),
                errorName: normalized.name,
                errorMessage: normalized.message,
            });
        };
        const cleanupLoad = () => {
            cancelled = true;
            clearSlowTimer();
            httpAbortController?.abort();
            if (loadingTask && loadingTaskRef.current === loadingTask) {
                loadingTaskRef.current = null;
                void Promise.resolve(loadingTask.destroy?.()).catch(() => undefined);
            }
        };

        // UIUX (audit 2026-08-04 §CROP.LOAD): kết quả Crop/Combine trong RAM đang được
        // materialize sang file tạm để PDFium đọc. Không khởi động PDF.js song song rồi lóe
        // màn lỗi trước khi nguồn native sẵn sàng; nếu materialize thất bại, ImpositionTab
        // bỏ cờ này và đổi File identity để lượt PDF.js dự phòng chạy bình thường.
        if ((file as any)?.__nativePathPending
            && pdfUrl
            && !(file as any)?.path
            && (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
            startSlowWatchdog();
            return cleanupLoad;
        }

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
            setPageInstanceIds(genPageIds(count));
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
            setLoadStatus('ready');
            return;
        }

        if (isImage && pdfUrl) {
            startSlowWatchdog();
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
                setPageInstanceIds(genPageIds(1));
                setSelectedIndices(new Set([0]));
                setLastSelectedIndex(0);
                setActivePage(1);
                markReady(1);
            };
            img.onerror = () => markError(new Error('Không thể đọc dữ liệu ảnh.'), 'image_error');
            img.src = pdfUrl;
            return cleanupLoad;
        }

        if (pdfUrl && (file as any)?.path && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
            startSlowWatchdog();
            (async () => {
                try {
                    const filePath = (file as any).path;
                    let numPagesFromEngine = 0;
                    let widthPt = 0;
                    let heightPt = 0;
                    const allDims: Record<number, { widthPt: number, heightPt: number }> = {};
                    let detectedColorRisk: PdfColorRiskSummary | null = null;
                    let detectedRenderEngine: PdfRenderEngineIdentity | null = null;
                    
                    // Lấy metadata bằng Rust/pdfium CỤC BỘ (nhanh, không qua HTTP Python),
                    // đồng thời NẠP SẴN file vào pdfium cache → tile đầu tiên render tức thì.
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const __t0 = performance.now();
                        const meta: any = await invoke('get_pdf_metadata', { filePath });
                        if (typeof localStorage !== 'undefined' && localStorage.perfDebug === '1') {
                            console.log(`[PERF-META] invoke=${(performance.now()-__t0).toFixed(0)}ms | RUST bind=${meta._dbgBindMs}ms load=${meta._dbgLoadMs}ms internal=${meta._dbgInternalMs}ms | numPages=${meta.numPages}`);
                        }
                        numPagesFromEngine = meta.numPages || 0;
                        widthPt = meta.widthPt || 0;
                        heightPt = meta.heightPt || 0;
                        detectedColorRisk = meta.colorRisk || null;
                        detectedRenderEngine = meta.renderEngine || null;
                        if (meta.allDims) {
                            for (const k of Object.keys(meta.allDims)) {
                                const d = meta.allDims[k];
                                allDims[parseInt(k, 10)] = { widthPt: d.widthPt, heightPt: d.heightPt };
                            }
                        }
                    } catch (rustErr) {
                        if (cancelled || generation !== loadGenerationRef.current) return;
                        // Fallback: backend Python qua HTTP (nếu lệnh Rust lỗi)
                        console.warn('[PERF-META] Rust get_pdf_metadata FAILED → fallback HTTP:', rustErr);
                        const __tf = performance.now();
                        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8321';
                        httpAbortController = new AbortController();
                        const res = await fetch(`${apiUrl}/api/imposition/pdf-meta`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            // PAGEBOX (audit 2026-08-04 §W1.PB2): nhánh lỗi phải
                            // lấy cùng CropBox nhìn thấy như metadata PDFium chính.
                            body: JSON.stringify({ path: filePath, page_box_policy: 'visible' }),
                            signal: httpAbortController.signal,
                        });
                        console.warn(`[PERF-META] HTTP pdf-meta fallback=${(performance.now()-__tf).toFixed(0)}ms ok=${res.ok}`);
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
                            throw new Error(`API Error: ${res.status} - ${errText}`);
                        }
                    }

                    if (cancelled) return;
                    // COLOR (audit 2026-08-07 §GV.3/§GV.5): giữ detector và danh tính
                    // DLL theo đúng lượt tải; đường fallback không được mượn metadata cũ.
                    setColorRisk(detectedColorRisk);
                    setRenderEngine(detectedRenderEngine);
                    if (!Number.isFinite(numPagesFromEngine) || numPagesFromEngine <= 0) {
                        throw new Error('PDF không có trang hợp lệ.');
                    }

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

                    // Cross-file copy/move: order scoped theo pdfUrl đích (tránh tab khác nuốt).
                    const cfPayload = (window as any).__prynx_cross_file_page_order;
                    const cfOrder: number[] | null = Array.isArray(cfPayload)
                        ? cfPayload
                        : (cfPayload && cfPayload.pdfUrl === pdfUrl && Array.isArray(cfPayload.order)
                            ? cfPayload.order
                            : null);
                    const cfFocus: number | null = (!Array.isArray(cfPayload) && cfPayload?.pdfUrl === pdfUrl
                        && typeof cfPayload.focusIndex === 'number')
                        ? cfPayload.focusIndex
                        : null;
                    if (cfOrder) {
                        setPageOrder(cfOrder);
                        setPageInstanceIds(genPageIds(cfOrder.length));
                        setTimeout(() => {
                            const cur = (window as any).__prynx_cross_file_page_order;
                            if (cur && (Array.isArray(cur) || cur.pdfUrl === pdfUrl)) {
                                (window as any).__prynx_cross_file_page_order = null;
                            }
                        }, 100);
                    } else {
                        const keepOrder = isSameUrl && pageOrder.length === numPagesFromEngine;
                        setPageOrder(prev => (isSameUrl && prev.length === numPagesFromEngine) ? prev : Array.from({ length: numPagesFromEngine }, (_, i) => i + 1));
                        setPageInstanceIds(prev => keepOrder ? prev : genPageIds(numPagesFromEngine));
                    }
                    
                    if (!isSameUrl) {
                        const focusIdx = cfFocus != null
                            ? Math.max(0, Math.min(cfFocus, (cfOrder?.length || numPagesFromEngine) - 1))
                            : 0;
                        setSelectedIndices(new Set([focusIdx]));
                        setLastSelectedIndex(focusIdx);
                        setPastStack([]);
                        setFutureStack([]);
                        setPageRotations({});
                        setActivePage(focusIdx + 1);
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

                    markReady(numPagesFromEngine);
                } catch (e) {
                    markError(e, 'native_error');
                }
            })();
            return cleanupLoad;
        } else if (pdfUrl && (!(window as any).__TAURI_INTERNALS__ || (file as any)?.isInMemory || !(file as any)?.path)) {
            startSlowWatchdog();
            (async () => {
                try {
                    loadingTask = pdfjs.getDocument(pdfUrl);
                    loadingTaskRef.current = loadingTask;
                    const doc = await loadingTask.promise;
                    if (cancelled) return;
                    if (!Number.isFinite(doc?.numPages) || doc.numPages <= 0) {
                        throw new Error('PDF không có trang hợp lệ.');
                    }
                    setPdfRef(doc);
                    setThumbPdfRef(doc);
                    setNumPages(doc.numPages);
                    const cfPayload2 = (window as any).__prynx_cross_file_page_order;
                    const cfOrder2: number[] | null = Array.isArray(cfPayload2)
                        ? cfPayload2
                        : (cfPayload2 && cfPayload2.pdfUrl === pdfUrl && Array.isArray(cfPayload2.order)
                            ? cfPayload2.order
                            : null);
                    const cfFocus2: number | null = (!Array.isArray(cfPayload2) && cfPayload2?.pdfUrl === pdfUrl
                        && typeof cfPayload2.focusIndex === 'number')
                        ? cfPayload2.focusIndex
                        : null;
                    if (cfOrder2) {
                        setPageOrder(cfOrder2);
                        setPageInstanceIds(genPageIds(cfOrder2.length));
                        setTimeout(() => {
                            const cur = (window as any).__prynx_cross_file_page_order;
                            if (cur && (Array.isArray(cur) || cur.pdfUrl === pdfUrl)) {
                                (window as any).__prynx_cross_file_page_order = null;
                            }
                        }, 100);
                    } else {
                        const keepOrder = isSameUrl && pageOrder.length === doc.numPages;
                        setPageOrder(prev => (isSameUrl && prev.length === doc.numPages) ? prev : Array.from({ length: doc.numPages }, (_, i) => i + 1));
                        setPageInstanceIds(prev => keepOrder ? prev : genPageIds(doc.numPages));
                    }

                    if (!isSameUrl) {
                        const focusIdx = cfFocus2 != null
                            ? Math.max(0, Math.min(cfFocus2, (cfOrder2?.length || doc.numPages) - 1))
                            : 0;
                        setSelectedIndices(new Set([focusIdx]));
                        setLastSelectedIndex(focusIdx);
                        setPastStack([]);
                        setFutureStack([]);
                        setPageRotations({});
                        setActivePage(focusIdx + 1);
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
                    markReady(doc.numPages);
                } catch (e) {
                    markError(e, 'pdfjs_error');
                }
            })();
            return cleanupLoad;
        }
    }, [pdfUrl, file, loadRevision, sourceKey]);

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

    // Thumbnail generation helper (web/pdfjs only). Tauri dùng IPC render_pdf_page trong ThumbSidebar.
    // Cache key khớp MemoThumbItem: `${pdfUrl}_${page}_0_${zoomMilli}` với zoom suy từ width.
    const generateThumb = useCallback(async (pdf: any, pageNum: number, rotation: number, width: number) => {
        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);
        if (isImage) return;
        if ((file as any)?.path) return; // Tauri: IPC path trong MemoThumbItem, không dùng cache này

        // width prop ≈ thumbBaseWidth; zoom milli khớp công thức oversample 1.3× (baseW mặc định 595).
        const baseW = 595;
        const optimalZoom = Math.max(0.1, Math.min(1.5, (width * 1.3) / baseW));
        const cacheKey = `${pdfUrl}_${pageNum}_0_${Math.round(optimalZoom * 1000)}`;
        if (thumbCacheRef.current.has(cacheKey)) return;

        try {
            const page = await pdf.getPage(pageNum);
            // Bitmap luôn rot=0; CSS rotate ở ThumbSidebar (cùng main viewer).
            const vp = page.getViewport({ scale: 1, rotation: 0 });
            const scale = width / vp.width;
            const scaledVp = page.getViewport({ scale, rotation: 0 });
            const canvas = document.createElement('canvas');
            canvas.width = scaledVp.width;
            canvas.height = scaledVp.height;
            const ctx = canvas.getContext('2d')!;

            await page.render({ canvasContext: ctx, viewport: scaledVp }).promise;
            const url = canvas.toDataURL('image/jpeg', 0.7);
            canvas.width = 0; canvas.height = 0;

            putThumbCache(cacheKey, url);
        } catch (e) { console.warn('Thumb gen err', e); }
    }, [pdfUrl, file]);

    return {
        pdfRef,
        thumbPdfRef,
        pageDim,
        allPageDims,
        pageWidthPt,
        plateLabels,
        colorRisk,
        renderEngine,
        pageOrder, setPageOrder,
        pageInstanceIds, setPageInstanceIds,
        selectedIndices, setSelectedIndices,
        lastSelectedIndex, setLastSelectedIndex,
        pageRotations, setPageRotations,
        pastStack, setPastStack,
        futureStack, setFutureStack,
        updatePageDimForPage,
        generateThumb,
        loadError,
        loadStatus,
        retryLoad,
        cancelLoad,
    };
}
