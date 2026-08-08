import { useRef, useEffect, useCallback, useState } from 'react';
import {
    configureTileUrlCacheForHardware,
    type TileUrlSource,
} from '../../lib/tileUrlCache';
import { CancelledTileRenderError, nativeTileRenderScheduler } from './tileRenderScheduler';
import { authenticatedFetch, getApiUrl } from '../../lib/api';

interface UseTileRendererProps {
    file: any;
    pdfRef: any;
    pdfUrl: string | null;
    activePage: number;
    tabId?: string;
    isActive?: boolean;
    accurateColorEnabled?: boolean;
    accurateColorPages?: number[];
}

interface TileRenderRequestOptions {
    ownerId?: string;
    groupKey?: string;
    priority?: number;
    colorStage?: ViewerColorStage;
}

let nextTileRendererId = 1;

export type ViewerColorStage = 'display' | 'accurate';

const DISPLAY_ONLY_STAGES: readonly ViewerColorStage[] = ['display'];
const PROGRESSIVE_COLOR_STAGES: readonly ViewerColorStage[] = ['display', 'accurate'];
export const ACCURATE_VIEWER_DPI_BUCKET = 12;

export function progressiveViewerColorStages(enabled: boolean): readonly ViewerColorStage[] {
    return enabled ? PROGRESSIVE_COLOR_STAGES : DISPLAY_ONLY_STAGES;
}

export function shouldUseAccurateViewerRender(
    enabled: boolean,
    accuratePages: readonly number[],
    pageNum: number,
    isTile: boolean,
    colorStage?: ViewerColorStage,
): boolean {
    return enabled
        && colorStage === 'accurate'
        && !isTile
        && accuratePages.includes(pageNum);
}

export function accurateViewerDpi(zoomScale: number): number {
    // PERF (audit 2026-08-07 §ZOOM.3): Ctrl+Wheel tạo scale thập phân gần nhau;
    // nếu dùng DPI chính xác từng đơn vị, mỗi lần chỉnh nhẹ lại thành một cache miss PPE.
    // Bo LÊN nấc 12 DPI để ảnh cuối chỉ downsample (không phóng mờ), đồng thời các mức
    // chuẩn 100/125/150/200% vẫn khớp đúng 96/120/144/192 DPI, không render dư.
    const requestedDpi = Number.isFinite(zoomScale) && zoomScale > 0
        ? 96 * zoomScale
        : 24;
    const bucketedDpi = Math.ceil(requestedDpi / ACCURATE_VIEWER_DPI_BUCKET)
        * ACCURATE_VIEWER_DPI_BUCKET;
    // Biên 9600 đồng bộ validation API và cao hơn miền renderZoom hợp lệ của Viewer.
    return Math.max(24, Math.min(9600, bucketedDpi));
}

export function adjacentAccuratePages(
    pageNum: number,
    accuratePages: readonly number[],
): number[] {
    const available = new Set(accuratePages);
    return [pageNum + 1, pageNum - 1].filter(page => page > 0 && available.has(page));
}

export function useTileRenderer({ file, pdfRef, pdfUrl, activePage, tabId, isActive, accurateColorEnabled = false, accurateColorPages = [] }: UseTileRendererProps) {
    const activePageRef = useRef(activePage);
    const accurateRenderAbortRef = useRef<AbortController | null>(null);
    const accuratePrefetchAbortRef = useRef(new Map<string, AbortController>());
    const accuratePrefetchedKeysRef = useRef(new Set<string>());
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);

    const [rendererInstanceId] = useState(() => `viewer:${tabId || 'local'}:${nextTileRendererId++}`);
    const fileIdentity = (file as { path?: string } | null)?.path || pdfUrl || 'memory';
    const [accurateColorFailure, setAccurateColorFailure] = useState<{ fileIdentity: string; message: string } | null>(null);
    const accurateColorError = accurateColorFailure?.fileIdentity === fileIdentity
        ? accurateColorFailure.message
        : null;
    const renderOwnerId = `${rendererInstanceId}:${fileIdentity}`;
    useEffect(() => () => {
        nativeTileRenderScheduler.cancelOwner(renderOwnerId);
        accurateRenderAbortRef.current?.abort();
        accurateRenderAbortRef.current = null;
        for (const controller of accuratePrefetchAbortRef.current.values()) controller.abort();
        accuratePrefetchAbortRef.current.clear();
        accuratePrefetchedKeysRef.current.clear();
    }, [renderOwnerId]);
    useEffect(() => {
        if (isActive === false) nativeTileRenderScheduler.cancelOwner(renderOwnerId);
    }, [isActive, renderOwnerId]);

    useEffect(() => {
        void configureTileUrlCacheForHardware();
    }, []);

    const getTileUrl = useCallback((pageNum: number, rotation: number, zoomScale: number, clipX?: number, clipY?: number, clipW?: number, clipH?: number, requestOptions?: TileRenderRequestOptions): Promise<TileUrlSource> => {
        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);
        if (isImage) {
            return Promise.resolve({ url: pdfUrl ? pdfUrl + '#keep' : '', byteLength: 0 });
        }

        // Native file path. Ở RELEASE, protocol tile.localhost (img declarative / new Image /
        // fetch) ĐỀU không hiển thị được — chỉ cache cũ mới hiện. Cách đáng tin duy nhất:
        // lấy bytes PNG qua IPC `invoke('render_pdf_page')` (giống tách nền dùng invoke→blob,
        // đã chạy ở release) rồi tạo blob:. LiveTile tự cache + revoke blob.
        const nativeFilePath = (file as { path?: string } | null)?.path;
        if (nativeFilePath) {
            // Tile thật khi clipW/clipH > 0. Lúc đó clipX/clipY PHẢI truyền nguyên
            // giá trị (kể cả 0 — ô góc trên-trái) để backend nhận đủ 4 Some → vào
            // nhánh clip. Trước đây `clipX && clipX!==0 ? clipX : null` biến clipX=0
            // thành null → ô góc rơi nhầm vào nhánh render full-page.
            const isTile = !!(clipW && clipW > 0 && clipH && clipH > 0);
            const layer = isTile ? 'tile' : 'page';
            const ownerId = requestOptions?.ownerId || renderOwnerId;
            const groupKey = requestOptions?.groupKey || `${layer}:${pageNum}`;
            const priority = requestOptions?.priority ?? (isTile ? 0 : 100 + Math.abs(pageNum - (activePageRef.current || 1)));
            const requestKey = [
                ownerId,
                nativeFilePath,
                pageNum,
                zoomScale.toFixed(3),
                rotation || 0,
                isTile ? (clipX ?? 0) : 0,
                isTile ? (clipY ?? 0) : 0,
                isTile ? clipW : 0,
                isTile ? clipH : 0,
            ].join('|');
            const queuedAt = performance.now();
            const renderNativePng = async (): Promise<TileUrlSource> => {
                const bytes = await nativeTileRenderScheduler.enqueue({
                    requestKey,
                    groupKey,
                    ownerId,
                    priority,
                    run: async () => {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const queueMs = Math.round(performance.now() - queuedAt);
                        const invokeStartedAt = performance.now();
                        const renderedBytes = await invoke<ArrayBuffer>('render_pdf_page', {
                            filePath: nativeFilePath,
                            page: pageNum,
                            zoom: zoomScale,
                            rotation: rotation || 0,
                            clipX: isTile ? (clipX ?? 0) : null,
                            clipY: isTile ? (clipY ?? 0) : null,
                            clipW: isTile ? clipW : null,
                            clipH: isTile ? clipH : null,
                        });
                        const invokeMs = Math.round(performance.now() - invokeStartedAt);
                        if (queueMs + invokeMs >= 30) console.info(`[TilePerf] layer=${layer} page=${pageNum} zoom=${zoomScale.toFixed(2)} queue=${queueMs}ms invoke=${invokeMs}ms bytes=${renderedBytes.byteLength}`);
                        return renderedBytes;
                    },
                });
                // COLOR (audit 2026-08-07 §GV.1/§GV.4): raw PDFium không được nén
                // mất dữ liệu lần hai; full-page và tile zoom dùng cùng MIME lossless.
                const blob = new Blob([bytes], { type: 'image/png' });
                return { url: URL.createObjectURL(blob), byteLength: blob.size };
            };

            if (shouldUseAccurateViewerRender(
                accurateColorEnabled,
                accurateColorPages,
                pageNum,
                isTile,
                requestOptions?.colorStage,
            )) {
                // COLOR (audit 2026-08-07 §GV.3): trang CMYK/DeviceN/transparency
                // được dựng trong không gian mực rồi mới quy FOGRA39→sRGB. Chỉ xin
                // full-page; LivePageFrame tắt tile PDFium để hue không đổi theo mảng.
                return (async () => {
                    accurateRenderAbortRef.current?.abort();
                    const abortController = new AbortController();
                    accurateRenderAbortRef.current = abortController;
                    try {
                        // PERF (audit 2026-08-07 §GV.P1): PPE chạy ở sidecar/backend,
                        // không được chiếm scheduler dành riêng cho khóa PDFium native.
                        // Nếu dùng chung, PPE trang trước chặn cả ảnh display trang kế.
                        const response = await authenticatedFetch(`${getApiUrl()}/preflight/viewer-accurate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                file_path: nativeFilePath,
                                page: pageNum,
                                dpi: accurateViewerDpi(zoomScale),
                                profile_id: 'fogra39',
                                intent: 'relative',
                            }),
                            signal: abortController.signal,
                        });
                        if (!response.ok) {
                            const detail = await response.json().catch(() => ({}));
                            throw new Error(detail.detail || `HTTP ${response.status}`);
                        }
                        const bytes = await response.arrayBuffer();
                        setAccurateColorFailure(null);
                        // PERF (audit 2026-08-07 §GV.P3): sau khi trang active đã hoàn
                        // tất, dựng nền đúng hai trang liền kề. Backend single-flight +
                        // cache đĩa ngăn render trùng nếu user chuyển trang giữa chừng.
                        const dpi = accurateViewerDpi(zoomScale);
                        for (const nearbyPage of adjacentAccuratePages(pageNum, accurateColorPages)) {
                            const prefetchKey = `${nativeFilePath}|${nearbyPage}|${dpi}|fogra39|relative`;
                            if (accuratePrefetchedKeysRef.current.has(prefetchKey)) continue;
                            accuratePrefetchedKeysRef.current.add(prefetchKey);
                            const prefetchController = new AbortController();
                            accuratePrefetchAbortRef.current.set(prefetchKey, prefetchController);
                            void authenticatedFetch(`${getApiUrl()}/preflight/viewer-accurate`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    file_path: nativeFilePath,
                                    page: nearbyPage,
                                    dpi,
                                    profile_id: 'fogra39',
                                    intent: 'relative',
                                }),
                                signal: prefetchController.signal,
                            }).then(async prefetchResponse => {
                                if (!prefetchResponse.ok) {
                                    throw new Error(`HTTP ${prefetchResponse.status}`);
                                }
                                await prefetchResponse.arrayBuffer();
                            }).catch(error => {
                                if (prefetchController.signal.aborted) return;
                                accuratePrefetchedKeysRef.current.delete(prefetchKey);
                                console.warn('[VIEWER-COLOR] Không thể dựng trước trang kế:', error);
                            }).finally(() => {
                                accuratePrefetchAbortRef.current.delete(prefetchKey);
                            });
                        }
                        const blob = new Blob([bytes], { type: 'image/png' });
                        return { url: URL.createObjectURL(blob), byteLength: blob.size };
                    } catch (error) {
                        if (abortController.signal.aborted) {
                            throw new CancelledTileRenderError();
                        }
                        const message = error instanceof Error ? error.message : String(error);
                        setAccurateColorFailure({ fileIdentity, message });
                        // PERF (audit 2026-08-07 §GV.P1): PDFium pha display đã hiện
                        // bên dưới; giữ nguyên ảnh đó và báo CMYK! thay vì render PDFium
                        // lần hai rồi vô tình cache nó dưới key accurate.
                        console.warn('[VIEWER-COLOR] Accurate render failed; keeping display preview:', message);
                        throw error instanceof Error ? error : new Error(message);
                    } finally {
                        if (accurateRenderAbortRef.current === abortController) {
                            accurateRenderAbortRef.current = null;
                        }
                    }
                })();
            }

            return renderNativePng();
        }

        // Fallback: PDF.js canvas rendering for non-native files
        return new Promise<TileUrlSource>(async (resolve, reject) => {
            if (!pdfRef) return reject("No file and no PDF ref");
            try {
                const page = await pdfRef.getPage(pageNum);
                const viewport = page.getViewport({ scale: zoomScale, rotation });
                const canvas = document.createElement('canvas');

                const tileW = clipW || viewport.width;
                const tileH = clipH || viewport.height;
                canvas.width = tileW;
                canvas.height = tileH;

                const ctx = canvas.getContext('2d');
                if (!ctx) return reject("Failed to get 2d context");

                if (clipX !== undefined && clipY !== undefined) {
                    ctx.translate(-clipX, -clipY);
                }

                await page.render({ canvasContext: ctx, viewport }).promise;
                canvas.toBlob(blob => {
                    if (blob) resolve({ url: URL.createObjectURL(blob), byteLength: blob.size });
                    else reject("Failed to create blob");
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        });
    }, [activePageRef, accurateColorEnabled, accurateColorPages, file, pdfRef, pdfUrl, renderOwnerId]);

    // Text extraction via pdfjs
    const getTextBlocksForPage = useCallback(async (pageNum: number, existingBlocks: Record<number, any[]>) => {
        if (existingBlocks[pageNum]) return null;
        if (!pdfRef) return null;
        try {
            const page = await pdfRef.getPage(pageNum);
            const content = await page.getTextContent();
            return content.items.map((item: any) => ({
                type: 'text',
                bbox: { x: item.transform[4], y: item.transform[5], w: item.width || 0, h: item.height || 0 },
                lines: [{
                    bbox: { x: item.transform[4], y: item.transform[5], w: item.width || 0, h: item.height || 0 },
                    wmode: 0,
                    dir: { x: 1, y: 0 },
                    chars: item.str ? item.str.split('').map((c: string, i: number) => ({
                        c, origin: { x: item.transform[4] + i * (item.width || 0) / Math.max(1, item.str.length), y: item.transform[5] }, quad: []
                    })) : []
                }]
            }));
        } catch { return null; }
    }, [pdfRef]);

    return { getTileUrl, getTextBlocksForPage, renderOwnerId, accurateColorError };
}
