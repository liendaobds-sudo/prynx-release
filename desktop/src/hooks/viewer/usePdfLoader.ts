import { useState, useEffect, useRef, useCallback } from 'react';
import { pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    createThumbnailRenderRequest,
    putThumbCache,
    thumbCacheRef,
    type ThumbnailRenderRequest,
} from '../../components/workspace/thumbnailCache';
import {
    claimTileUrlCacheOwner,
    clearTileUrlCache,
    releaseTileUrlCacheOwner,
} from '../../lib/tileUrlCache';
import { viewerTraceHash, viewerTraceLog } from '../../lib/previewPerfLog';

export const PDF_LOAD_SLOW_NOTICE_MS = 10_000;
export type PdfLoadStatus = 'idle' | 'loading' | 'slow' | 'ready' | 'error' | 'cancelled';
export type ViewerEngineMode = 'current' | 'hybrid' | 'ppe-only';
type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>;
type LoaderFile = File & {
    path?: string;
    isInMemory?: boolean;
    isBlank?: boolean;
    blankWidthPt?: number;
    blankHeightPt?: number;
    blankPageCount?: number;
    __editCommit?: boolean;
    __pathRebaseOnly?: boolean;
    __nativePathPending?: boolean;
};
type CrossFilePageOrderPayload = number[] | { pdfUrl?: string; order?: number[]; focusIndex?: number };
type LoaderWindow = Window & {
    __TAURI_INTERNALS__?: unknown;
    __prynx_cross_file_page_order?: CrossFilePageOrderPayload | null;
};
type PdfLoadFileIdentity = { name?: string; size?: number; lastModified?: number; path?: string };
interface PdfMetadataPage { index: number; width_pt?: number; height_pt?: number; }
interface PdfMetadata {
    numPages?: number;
    page_count?: number;
    widthPt?: number;
    heightPt?: number;
    max_width_pt?: number;
    max_height_pt?: number;
    allDims?: Record<string, { widthPt?: number; heightPt?: number }>;
    pages?: PdfMetadataPage[];
    colorRisk?: PdfColorRiskSummary | null;
    renderEngine?: PdfRenderEngineIdentity | null;
    viewerEngineMode?: unknown;
    viewerShadowEnabled?: boolean;
    fileIdentity?: string;
}

interface PdfJsThumbnailViewport {
    width: number;
    height: number;
}

interface PdfJsThumbnailPage {
    getViewport: (options: { scale: number; rotation?: number }) => PdfJsThumbnailViewport;
    render: (options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: unknown;
    }) => { promise: Promise<unknown> };
}

interface PdfJsThumbnailDocument {
    getPage: (pageNum: number) => Promise<unknown>;
}

const pdfJsThumbnailDocuments = new Map<string, PdfJsThumbnailDocument>();
const pdfJsThumbnailJobs = new Map<string, Promise<string | undefined>>();

export function registerPdfJsThumbnailDocument(
    revision: string,
    pdfDocument: PdfJsThumbnailDocument,
): () => void {
    if (!revision) return () => undefined;
    pdfJsThumbnailDocuments.set(revision, pdfDocument);
    return () => {
        if (pdfJsThumbnailDocuments.get(revision) === pdfDocument) {
            pdfJsThumbnailDocuments.delete(revision);
        }
    };
}

export function getPdfJsThumbnailDocument(revision: string): PdfJsThumbnailDocument | undefined {
    return pdfJsThumbnailDocuments.get(revision);
}

export async function ensurePdfJsThumbnail(
    pdfDocument: PdfJsThumbnailDocument,
    pageNum: number,
    request: ThumbnailRenderRequest,
    pageOverride?: PdfJsThumbnailPage,
): Promise<string | undefined> {
    const cached = thumbCacheRef.current.get(request.cacheKey);
    if (cached) return cached;

    const running = pdfJsThumbnailJobs.get(request.cacheKey);
    if (running) return running;

    // UIUX (audit 2026-08-22 §UX.TH.02): render đúng trang nguồn đang cần,
    // không dùng prefetch 30 trang làm đường correctness duy nhất.
    const job = (async () => {
        const page = (pageOverride ?? await pdfDocument.getPage(pageNum)) as PdfJsThumbnailPage;
        const viewport = page.getViewport({ scale: 1, rotation: 0 });
        const scale = request.pixelWidth / Math.max(1, viewport.width);
        const scaledViewport = page.getViewport({ scale, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = request.pixelWidth;
        canvas.height = Math.max(1, Math.ceil(scaledViewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Không thể tạo bộ đệm thumbnail.');

        try {
            await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
            const url = canvas.toDataURL('image/jpeg', 0.7);
            putThumbCache(request.cacheKey, url);
            return url;
        } finally {
            canvas.width = 0;
            canvas.height = 0;
        }
    })();

    pdfJsThumbnailJobs.set(request.cacheKey, job);
    try {
        return await job;
    } finally {
        if (pdfJsThumbnailJobs.get(request.cacheKey) === job) {
            pdfJsThumbnailJobs.delete(request.cacheKey);
        }
    }
}

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

export function normalizeViewerEngineMode(value: unknown): ViewerEngineMode {
    return value === 'hybrid' || value === 'ppe-only' ? value : 'current';
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
let _pdfLoaderCacheOwnerSeq = 0;
// UIUX (audit 2026-08-25 NEW-WINDOW): counter module-level bắt đầu lại ở mỗi
// WebView, nên thêm UUID ổn định theo WebView để owner native không va chạm.
const PDF_LOADER_WINDOW_UUID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

export interface ViewerSnapshot {
    order: number[];
    instanceIds: string[];
    selection: number[];
    lastSelected: number | null;
    rotations: Record<string, number>;
}

export interface UsePdfLoaderResult {
    pdfRef: PDFDocumentProxy | null;
    thumbPdfRef: PDFDocumentProxy | null;
    pageDim: { w: number; h: number } | null;
    allPageDims: Record<number, { w: number; h: number; widthPt: number }>;
    pageWidthPt: number;
    plateLabels: Record<number, string>;
    colorRisk: PdfColorRiskSummary | null;
    renderEngine: PdfRenderEngineIdentity | null;
    viewerEngineMode: ViewerEngineMode;
    viewerShadowEnabled: boolean;
    renderDocumentToken: string | null;
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
    notifyFirstPageRenderReady: () => void;
}

interface UsePdfLoaderProps {
    file: LoaderFile | null;
    pdfUrl: string | null;
    setNumPages: (n: number) => void;
    setActivePage: (p: number) => void;
    setZoom: (z: number) => void;
    containerRef: React.RefObject<HTMLDivElement | null>;
}

export function usePdfLoader({
    file, pdfUrl, setNumPages, setActivePage, setZoom, containerRef
}: UsePdfLoaderProps) {
    const [pdfRef, setPdfRef] = useState<PDFDocumentProxy | null>(null);
    const [thumbPdfRef, setThumbPdfRef] = useState<PDFDocumentProxy | null>(null);
    const [pageDim, setPageDim] = useState<{ w: number; h: number } | null>(null);
    const [allPageDims, setAllPageDims] = useState<Record<number, { w: number; h: number; widthPt: number }>>({});
    const [pageWidthPt, setPageWidthPt] = useState<number>(595);
    const [plateLabels, setPlateLabels] = useState<Record<number, string>>({});
    const [colorRisk, setColorRisk] = useState<PdfColorRiskSummary | null>(null);
    const [renderEngine, setRenderEngine] = useState<PdfRenderEngineIdentity | null>(null);
    const [viewerEngineMode, setViewerEngineMode] = useState<ViewerEngineMode>('current');
    const [viewerShadowEnabled, setViewerShadowEnabled] = useState(false);
    const [nativeRenderIdentity, setNativeRenderIdentity] = useState<{
        sourceKey: string;
        token: string;
    } | null>(null);

    const [pageOrder, setPageOrder] = useState<number[]>([]);
    // Song song pageOrder: id duy nhất cho MỖI vị trí trang (kể cả bản nhân bản cùng
    // số trang gốc) → rotation keyed theo id này để xoay độc lập từng bản.
    const [pageInstanceIds, setPageInstanceIds] = useState<string[]>([]);
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0]));
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(0);

    const [pageRotations, setPageRotations] = useState<Record<string, number>>({});

    // -- Undo/Redo stacks live here as they are tightly coupled with page state --
    const [pastStack, setPastStack] = useState<ViewerSnapshot[]>([]);
    const [futureStack, setFutureStack] = useState<ViewerSnapshot[]>([]);
    
    const [loadError, setLoadError] = useState<Error | null>(null);
    const [loadStatus, setLoadStatus] = useState<PdfLoadStatus>('idle');
    const [loadRevision, setLoadRevision] = useState(0);

    const prevPdfUrlRef = useRef<string | null>(null);
    const loadingTaskRef = useRef<PdfLoadingTask | null>(null);
    const cancelledSourceRef = useRef<string | null>(null);
    const loadGenerationRef = useRef(0);
    const metadataHydrationStartRef = useRef<(() => void) | null>(null);
    const tileCacheOwnerIdRef = useRef<string | null>(null);
    if (tileCacheOwnerIdRef.current === null) {
        tileCacheOwnerIdRef.current = `pdf-loader:${PDF_LOADER_WINDOW_UUID}:${++_pdfLoaderCacheOwnerSeq}`;
    }
    const sourceKey = loadSourceKey(file, pdfUrl);
    const nativeFilePath = typeof file?.path === 'string' && file.path ? file.path : null;
    const tileCacheNamespace = pdfUrl || nativeFilePath;

    const retryLoad = useCallback(() => {
        loadGenerationRef.current += 1;
        cancelledSourceRef.current = null;
        const task = loadingTaskRef.current;
        loadingTaskRef.current = null;
        void Promise.resolve(task?.destroy?.()).catch(() => undefined);
        setLoadRevision(value => value + 1);
    }, []);

    const cancelLoad = useCallback(() => {
        loadGenerationRef.current += 1;
        cancelledSourceRef.current = sourceKey;
        const task = loadingTaskRef.current;
        loadingTaskRef.current = null;
        void Promise.resolve(task?.destroy?.()).catch(() => undefined);
        setLoadError(null);
        setLoadStatus('cancelled');
        setNumPages(0);
        setLoadRevision(value => value + 1);
    }, [setNumPages, sourceKey]);

    const notifyFirstPageRenderReady = useCallback(() => {
        metadataHydrationStartRef.current?.();
    }, []);

    useEffect(() => {
        if (!nativeFilePath || !(window as LoaderWindow).__TAURI_INTERNALS__) {
            return;
        }
        const leasedPath = nativeFilePath;
        const leaseOwnerId = tileCacheOwnerIdRef.current;
        return () => {
            // PERF (audit 2026-08-02 §LOAD.3): native giữ Arc cho render đang chạy nên
            // close chỉ remove cache entry; handle thật đóng sau terminal callback.
            void import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke<boolean>('close_pdf_document', {
                    filePath: leasedPath,
                    ownerId: leaseOwnerId,
                }))
                .catch(() => undefined);
        };
    }, [nativeFilePath, sourceKey]);

    useEffect(() => {
        if (!tileCacheNamespace) return;
        const ownerId = tileCacheOwnerIdRef.current;
        if (!ownerId) return;
        claimTileUrlCacheOwner(ownerId, tileCacheNamespace);
        return () => releaseTileUrlCacheOwner(ownerId);
    }, [tileCacheNamespace]);

    // Clear stale tile cache on new file load
    useEffect(() => {
        // Edit-commit: KHÔNG xóa toàn bộ cache tile (key cũ theo pdfUrl cũ không trùng
        // key mới nên tự vô hiệu) → tránh white-flash các trang khác.
        if (file?.__editCommit) return;
        if (file || pdfUrl) {
            // PERF (audit 2026-08-08 §RENDER.8): chỉ dọn namespace không còn owner;
            // tab khác vẫn mounted/suspend không bị mất Blob cache.
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
        if (file?.__editCommit) {
            return;
        }

        // Lưu bằng COPY đĩa→đĩa chỉ đổi .path của `file`, pdfUrl + nội dung GIỮ NGUYÊN.
        // Không có gì để nạp lại → return sớm (như __editCommit) để không setNumPages(0)
        // (unmount viewer + spinner) và không re-render toàn bộ trang/thumbnail vô ích.
        if (file?.__pathRebaseOnly && isSameUrl) {
            return;
        }

        setPdfRef(null);
        setAllPageDims({});
        setThumbPdfRef(null);
        setColorRisk(null);
        setRenderEngine(null);
        setViewerEngineMode('current');
        setViewerShadowEnabled(false);
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
        let startHydrationForGeneration: (() => void) | null = null;
        let releasePdfJsThumbnailDocument: (() => void) | null = null;
        let slowTimer: number | undefined;
        const startedAt = performance.now();
        const loaderTraceId = viewerTraceHash(`${sourceKey}:${generation}`);
        const traceLoad = (event: string, extra: Record<string, unknown> = {}) => {
            void viewerTraceLog(event, {
                loader_id: loaderTraceId,
                generation,
                source_kind: file?.path ? 'native' : 'memory',
                elapsed_ms: Math.round(performance.now() - startedAt),
                ...extra,
            });
        };
        traceLoad('pdf-load-start', {
            has_pdf_url: Boolean(pdfUrl),
            has_native_path: Boolean(file?.path),
            revision: loadRevision + 1,
        });
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
            slowTimer = window.setTimeout(() => {
                if (cancelled || generation !== loadGenerationRef.current) return;
                // Chỉ đổi UI để người dùng biết tác vụ còn chạy; KHÔNG timeout/hard-cap.
                setLoadStatus(current => current === 'loading' ? 'slow' : current);
            }, PDF_LOAD_SLOW_NOTICE_MS);
        };
        const markReady = () => {
            if (cancelled || generation !== loadGenerationRef.current) return;
            clearSlowTimer();
            setLoadStatus('ready');
            traceLoad('pdf-load-ready');
        };
        const markError = (error: unknown, stage: string) => {
            if (cancelled || generation !== loadGenerationRef.current) return;
            clearSlowTimer();
            const normalized = normalizeLoadError(error);
            setLoadError(normalized);
            setLoadStatus('error');
            traceLoad('pdf-load-error', {
                stage,
                error_name: normalized.name,
            });
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
            traceLoad('pdf-load-cleanup', { cancelled: true });
            clearSlowTimer();
            releasePdfJsThumbnailDocument?.();
            releasePdfJsThumbnailDocument = null;
            if (metadataHydrationStartRef.current === startHydrationForGeneration) {
                metadataHydrationStartRef.current = null;
            }
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
        if (file?.__nativePathPending
            && pdfUrl
            && !file?.path
            && (window as LoaderWindow).__TAURI_INTERNALS__) {
            startSlowWatchdog();
            return cleanupLoad;
        }

        // Trang trắng mới tạo: kích thước đã biết sẵn → dựng đồng bộ, KHÔNG nạp pdfjs/pdfium.
        // Tránh cold-start "đang tải PDF" + "rendering" cho một trang trắng đơn giản.
        if (file?.isBlank) {
            const wPt = file.blankWidthPt || 595;
            const hPt = file.blankHeightPt || 842;
            const count = file.blankPageCount || 1;
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
                markReady();
            };
            img.onerror = () => markError(new Error('Không thể đọc dữ liệu ảnh.'), 'image_error');
            img.src = pdfUrl;
            return cleanupLoad;
        }

        if (pdfUrl && file?.path && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
            startSlowWatchdog();
            (async () => {
                try {
                    const filePath = file.path;
                    const { invoke } = await import('@tauri-apps/api/core');
                    const isCurrentGeneration = () => !cancelled && generation === loadGenerationRef.current;

                    const normalizeHttpMetadata = (meta: PdfMetadata) => ({
                        numPages: meta.page_count || 0,
                        widthPt: meta.max_width_pt || 0,
                        heightPt: meta.max_height_pt || 0,
                        allDims: Object.fromEntries((meta.pages || []).map((page: PdfMetadataPage) => [
                            String(page.index + 1),
                            { widthPt: page.width_pt, heightPt: page.height_pt },
                        ])),
                        colorRisk: null,
                        renderEngine: null,
                    });

                    const fetchHttpMetadata = async () => {
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
                        console.warn(`[PERF-META] HTTP pdf-meta fallback=${(performance.now() - __tf).toFixed(0)}ms ok=${res.ok}`);
                        if (!res.ok) {
                            const errText = await res.text();
                            throw new Error(`API Error: ${res.status} - ${errText}`);
                        }
                        return normalizeHttpMetadata(await res.json());
                    };

                    const loadFullMetadata = async (expectedIdentity?: string) => {
                        const metadataStartedAt = performance.now();
                        traceLoad('pdf-metadata-start', {
                            expected_identity: Boolean(expectedIdentity),
                        });
                        try {
                            const meta = await invoke<PdfMetadata>('get_pdf_metadata', expectedIdentity
                                ? { filePath, expectedIdentity }
                                : { filePath });
                            traceLoad('pdf-metadata-done', {
                                phase: 'full',
                                num_pages: Number(meta.numPages) || 0,
                                metadata_ms: Math.round(performance.now() - metadataStartedAt),
                            });
                            if (typeof localStorage !== 'undefined' && localStorage.perfDebug === '1') {
                                console.log(`[PERF-META] full=${(performance.now() - metadataStartedAt).toFixed(0)}ms | numPages=${meta.numPages}`);
                            }
                            return meta;
                        } catch (rustErr) {
                            if (!isCurrentGeneration()) throw rustErr;
                            // Pha B có token từ bootstrap: lỗi thường là file cùng path đã đổi.
                            // Không được lấy HTTP metadata của file mới để hydrate vào Viewer cũ.
                            if (expectedIdentity) throw rustErr;
                            console.warn('[PERF-META] Rust get_pdf_metadata FAILED → fallback HTTP:', rustErr);
                            const fallback = await fetchHttpMetadata();
                            traceLoad('pdf-metadata-done', {
                                phase: 'http-fallback',
                                num_pages: Number(fallback.numPages) || 0,
                                metadata_ms: Math.round(performance.now() - metadataStartedAt),
                            });
                            return fallback;
                        }
                    };

                    const buildPageDims = (meta: PdfMetadata, numPages: number, widthPt: number, heightPt: number) => {
                        const dims: Record<number, { w: number; h: number; widthPt: number }> = {};
                        const baseW = widthPt * (96 / 72);
                        const baseH = heightPt * (96 / 72);
                        for (let i = 1; i <= numPages; i++) {
                            const source = meta.allDims?.[String(i)] ?? meta.allDims?.[i];
                            const w = Number(source?.widthPt) || widthPt;
                            const h = Number(source?.heightPt) || heightPt;
                            dims[i] = source
                                ? { w: w * (96 / 72), h: h * (96 / 72), widthPt: w }
                                : { w: baseW, h: baseH, widthPt };
                        }
                        return dims;
                    };

                    const schedulePlateLabels = (numPages: number) => {
                        // Không chen đọc blob/worker spot-color vào đường first-pixel.
                        const knownSize = file?.size || 0;
                        if (numPages > 100 || knownSize <= 0 || knownSize > 30 * 1024 * 1024) return;
                        window.setTimeout(async () => {
                            try {
                                const resp = await fetch(pdfUrl);
                                const blob = await resp.blob();
                                if (blob.size > 30 * 1024 * 1024 || !isCurrentGeneration()) return;
                                const buf = await blob.arrayBuffer();
                                const worker = new Worker(new URL('../../workers/plateInfoWorker.ts', import.meta.url), { type: 'module' });
                                worker.onmessage = (e) => {
                                    if (e.data.success && Object.keys(e.data.labels).length > 0 && isCurrentGeneration()) {
                                        setPlateLabels(e.data.labels);
                                    }
                                    worker.terminate();
                                };
                                worker.onerror = () => worker.terminate();
                                worker.postMessage({ buf }, [buf]);
                            } catch {
                                // Không lấy được plate metadata thì vẫn hiển thị trang.
                            }
                        }, 100);
                    };

                    let bootstrap: PdfMetadata = {};
                    let bootstrapContainsFullMetadata = false;
                    try {
                        const __t0 = performance.now();
                        bootstrap = await invoke('get_pdf_viewer_bootstrap', {
                            filePath,
                            ownerId: tileCacheOwnerIdRef.current,
                        });
                        traceLoad('pdf-bootstrap-ready', {
                            num_pages: Number(bootstrap.numPages) || 0,
                            has_color_risk: Boolean(bootstrap.colorRisk),
                            bootstrap_ms: Math.round(performance.now() - __t0),
                        });
                        if (typeof localStorage !== 'undefined' && localStorage.perfDebug === '1') {
                            console.log(`[PERF-META] bootstrap=${(performance.now() - __t0).toFixed(0)}ms | numPages=${bootstrap.numPages}`);
                        }
                    } catch (bootstrapError) {
                        if (!isCurrentGeneration()) return;
                        traceLoad('pdf-bootstrap-error', { fallback_to_full_metadata: true });
                        // Tương thích lỗi command/bản dev cũ: full metadata vẫn giữ đường HTTP fallback.
                        console.warn('[PERF-META] Viewer bootstrap FAILED → dùng metadata đầy đủ:', bootstrapError);
                        bootstrap = await loadFullMetadata();
                        bootstrapContainsFullMetadata = true;
                    }

                    if (!bootstrapContainsFullMetadata && !bootstrap?.colorRisk) {
                        // COLOR (feedback 2026-08-09 §RENDER.F1): binary cũ/response thiếu
                        // detector phải fail-closed. Chờ metadata đầy đủ trước khi mount trang,
                        // thay vì phát PDFium rồi vài giây sau mới đổi hẳn gradient/màu.
                        const expectedIdentity = typeof bootstrap?.fileIdentity === 'string'
                            ? bootstrap.fileIdentity
                            : undefined;
                        bootstrap = await loadFullMetadata(expectedIdentity);
                        bootstrapContainsFullMetadata = true;
                        traceLoad('pdf-metadata-ready', {
                            phase: 'pre-first-pixel',
                            num_pages: Number(bootstrap.numPages) || 0,
                        });
                    }

                    if (!isCurrentGeneration()) return;
                    const numPagesFromEngine = Number(bootstrap.numPages) || 0;
                    const widthPt = Number(bootstrap.widthPt) || 0;
                    const heightPt = Number(bootstrap.heightPt) || 0;
                    if (!Number.isFinite(numPagesFromEngine) || numPagesFromEngine <= 0
                        || !Number.isFinite(widthPt) || widthPt <= 0
                        || !Number.isFinite(heightPt) || heightPt <= 0) {
                        throw new Error('PDF không có trang hoặc kích thước hợp lệ.');
                    }

                    // PERF (audit 2026-08-08 §RENDER.5): identity thuộc loader/tab này.
                    // Registry theo path làm tab B save-over có thể đổi token của tab A dù
                    // metadata A chưa reload; sourceKey giữ revision đúng chủ sở hữu.
                    if (typeof bootstrap.fileIdentity === 'string' && bootstrap.fileIdentity) {
                        setNativeRenderIdentity({
                            sourceKey,
                            token: bootstrap.fileIdentity,
                        });
                    }

                    // PERF (audit 2026-08-08 §RENDER.1): mount Viewer ngay bằng trang 1 đã
                    // kiểm `/UserUnit`; các trang tạm dùng cùng khổ cho tới khi pha nền về.
                    setRenderEngine(bootstrap.renderEngine || null);
                    setViewerEngineMode(normalizeViewerEngineMode(bootstrap.viewerEngineMode));
                    setViewerShadowEnabled(bootstrap.viewerShadowEnabled === true);
                    setColorRisk(bootstrap.colorRisk || null);
                    setPageWidthPt(widthPt);
                    setPageDim({ w: widthPt * (96 / 72), h: heightPt * (96 / 72) });
                    setNumPages(numPagesFromEngine);
                    setAllPageDims(buildPageDims(bootstrap, numPagesFromEngine, widthPt, heightPt));

                    // Cross-file copy/move: order scoped theo pdfUrl đích (tránh tab khác nuốt).
                    const cfPayload = (window as LoaderWindow).__prynx_cross_file_page_order;
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
                        window.setTimeout(() => {
                            const current = (window as LoaderWindow).__prynx_cross_file_page_order;
                            if (current && (Array.isArray(current) || current.pdfUrl === pdfUrl)) {
                                (window as LoaderWindow).__prynx_cross_file_page_order = null;
                            }
                        }, 100);
                    } else {
                        const keepOrder = isSameUrl && pageOrder.length === numPagesFromEngine;
                        setPageOrder(prev => (isSameUrl && prev.length === numPagesFromEngine)
                            ? prev
                            : Array.from({ length: numPagesFromEngine }, (_, i) => i + 1));
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
                    markReady();

                    const applyFullMetadata = (full: PdfMetadata) => {
                        if (!isCurrentGeneration()) return;
                        if (bootstrap.fileIdentity && full.fileIdentity !== bootstrap.fileIdentity) {
                            console.warn('[PERF-META] Bỏ metadata nền vì identity file đã thay đổi.');
                            return;
                        }
                        const fullPages = Number(full.numPages) || 0;
                        if (fullPages !== numPagesFromEngine) {
                            console.warn('[PERF-META] Bỏ metadata nền vì số trang đã thay đổi.', {
                                bootstrapPages: numPagesFromEngine,
                                fullPages,
                            });
                            return;
                        }
                        // Chỉ hydrate dữ liệu nền; tuyệt đối không reset page/order/zoom/scroll.
                        setAllPageDims(buildPageDims(full, numPagesFromEngine, widthPt, heightPt));
                        setColorRisk(full.colorRisk || null);
                        setRenderEngine(full.renderEngine || bootstrap.renderEngine || null);
                        setViewerEngineMode(normalizeViewerEngineMode(
                            full.viewerEngineMode ?? bootstrap.viewerEngineMode,
                        ));
                        setViewerShadowEnabled(
                            (full.viewerShadowEnabled ?? bootstrap.viewerShadowEnabled) === true,
                        );
                        schedulePlateLabels(numPagesFromEngine);
                    };

                    if (bootstrapContainsFullMetadata) {
                        applyFullMetadata(bootstrap);
                    } else {
                        // PERF (audit 2026-08-08 §RENDER.1): LiveTile mở cổng này sau khi
                        // request trang active đã hoàn tất (ảnh hiện hoặc lỗi). Tab nền chưa
                        // render thì hoãn detector; tuyệt đối không tranh đường first-pixel.
                        startHydrationForGeneration = () => {
                            if (!isCurrentGeneration()) return;
                            if (metadataHydrationStartRef.current !== startHydrationForGeneration) return;
                            metadataHydrationStartRef.current = null;
                            void loadFullMetadata(bootstrap.fileIdentity)
                                .then(applyFullMetadata)
                                .catch(error => {
                                    if (isCurrentGeneration()) {
                                        console.warn('[PERF-META] Metadata nền thất bại; giữ Viewer pha nhanh:', error);
                                    }
                                });
                        };
                        metadataHydrationStartRef.current = startHydrationForGeneration;
                    }
                } catch (e) {
                    markError(e, 'native_error');
                }
            })();
            return cleanupLoad;
        } else if (pdfUrl && (!(window as LoaderWindow).__TAURI_INTERNALS__ || file?.isInMemory || !file?.path)) {
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
                    releasePdfJsThumbnailDocument = registerPdfJsThumbnailDocument(pdfUrl, doc);
                    setPdfRef(doc);
                    setThumbPdfRef(doc);
                    setNumPages(doc.numPages);
                    const cfPayload2 = (window as LoaderWindow).__prynx_cross_file_page_order;
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
                            const cur = (window as LoaderWindow).__prynx_cross_file_page_order;
                            if (cur && (Array.isArray(cur) || cur.pdfUrl === pdfUrl)) {
                                (window as LoaderWindow).__prynx_cross_file_page_order = null;
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
                    const readPageDim = async (pageNum: number) => {
                        const page = await doc.getPage(pageNum);
                        const viewport = page.getViewport({ scale: 1 });
                        return {
                            w: viewport.width * (96 / 72),
                            h: viewport.height * (96 / 72),
                            widthPt: viewport.width,
                        };
                    };

                    if (doc.numPages > 100) {
                        // UIUX (audit 2026-08-22 §UX.VIEW.09): không nhân bản khổ trang 1
                        // cho tài liệu dài. Chỉ đọc trang 1 để mở Viewer ngay; phần còn lại
                        // hydrate tuần tự ở nền, publish theo cụm để mixed-size vẫn đúng mà
                        // không tạo hàng chục nghìn Promise cùng lúc.
                        try {
                            dims[1] = await readPageDim(1);
                        } catch (e) {
                            console.error('Không đọc được kích thước trang 1:', e);
                        }
                    } else {
                        const promises = [];
                        for (let i = 1; i <= doc.numPages; i++) {
                            promises.push(readPageDim(i).then(dim => {
                                dims[i] = dim;
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
                    markReady();

                    if (doc.numPages > 100) {
                        const hydrateLongDocument = async () => {
                            const pending: Record<number, { w: number; h: number; widthPt: number }> = {};
                            for (let i = 2; i <= doc.numPages; i += 1) {
                                if (cancelled || generation !== loadGenerationRef.current) return;
                                try {
                                    pending[i] = await readPageDim(i);
                                } catch {
                                    // Một trang lỗi metadata không được làm hỏng cả tài liệu.
                                }
                                if (Object.keys(pending).length >= 16 || i === doc.numPages) {
                                    const batch = { ...pending };
                                    Object.keys(pending).forEach(key => delete pending[Number(key)]);
                                    if (!cancelled && generation === loadGenerationRef.current) {
                                        setAllPageDims(previous => ({ ...previous, ...batch }));
                                    }
                                    // Nhường event loop để thao tác cuộn/zoom luôn có frame.
                                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                                }
                            }
                        };
                        // PERF (audit 2026-08-22 §UX.TH.05): chỉ hydrate sau first
                        // frame của tab đang xem; tab nền giữ metadata trang 1 và
                        // sẽ tự khởi động khi user chuyển sang.
                        const startLongMetadataHydration = () => {
                            if (metadataHydrationStartRef.current !== startLongMetadataHydration) return;
                            metadataHydrationStartRef.current = null;
                            void hydrateLongDocument();
                        };
                        startHydrationForGeneration = startLongMetadataHydration;
                        metadataHydrationStartRef.current = startLongMetadataHydration;
                    }
                } catch (e) {
                    markError(e, 'pdfjs_error');
                }
            })();
            return cleanupLoad;
        }
    // LINT (audit 2026-08-24 LO-PDFLOAD): effect này chỉ được kích bởi revision nguồn.
    // pageOrder/callbacks là state phục hồi trong cùng lượt tải; thêm vào deps sẽ nạp lại
    // PDF khi order vừa được set, gây gọi PDF.js lặp và làm trắng viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- khóa lifecycle theo source revision
    }, [pdfUrl, file, loadRevision, sourceKey]);

    // Update pageDim when active page changes (for multi-size PDFs)
    const updatePageDimForPage = useCallback(async (activePage: number, numPagesCount: number) => {
        if (pdfRef && activePage > 0 && activePage <= numPagesCount) {
            try {
                const page = await pdfRef.getPage(activePage);
                const vp = page.getViewport({ scale: 1 });
                const dim = {
                    w: vp.width * (96 / 72),
                    h: vp.height * (96 / 72),
                    widthPt: vp.width,
                };
                setPageWidthPt(vp.width);
                setPageDim({ w: dim.w, h: dim.h });
                setAllPageDims(previous => (
                    previous[activePage]?.widthPt === dim.widthPt
                        && previous[activePage]?.w === dim.w
                        && previous[activePage]?.h === dim.h
                        ? previous
                        : { ...previous, [activePage]: dim }
                ));
            } catch {
                // Không đọc được kích thước trang hiện tại; giữ dữ liệu trước đó.
            }
        }
    }, [pdfRef]);

    // Thumbnail generation helper (web/pdfjs only). Tauri dùng IPC render_pdf_page trong ThumbSidebar.
    const generateThumb = useCallback(async (pdf: PdfJsThumbnailDocument | null | undefined, pageNum: number, _rotation: number, width: number) => {
        if (!pdf) return;
        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);
        if (isImage) return;
        if (file?.path) return; // Tauri: IPC path trong MemoThumbItem, không dùng cache này

        try {
            const page = await pdf.getPage(pageNum) as PdfJsThumbnailPage;
            const viewport = page.getViewport({ scale: 1, rotation: 0 });
            const request = createThumbnailRenderRequest({
                revision: pdfUrl || '',
                pageNum,
                pageWidthPx96: viewport.width * 96 / 72,
                cssWidth: width,
                devicePixelRatio: window.devicePixelRatio || 1,
            });
            await ensurePdfJsThumbnail(pdf, pageNum, request, page);
        } catch (e) { console.warn('Thumb gen err', e); }
    }, [pdfUrl, file]);

    const renderDocumentToken = nativeRenderIdentity?.sourceKey === sourceKey
        ? nativeRenderIdentity.token
        : null;

    return {
        pdfRef,
        thumbPdfRef,
        pageDim,
        allPageDims,
        pageWidthPt,
        plateLabels,
        colorRisk,
        renderEngine,
        viewerEngineMode,
        viewerShadowEnabled,
        renderDocumentToken,
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
        notifyFirstPageRenderReady,
    };
}
