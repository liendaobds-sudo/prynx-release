import { useRef, useEffect, useCallback, useState } from 'react';
import {
    configureTileUrlCacheForHardware,
    type TileUrlSource,
} from '../../lib/tileUrlCache';
import { nativeTileRenderScheduler } from './tileRenderScheduler';

interface UseTileRendererProps {
    file: any;
    pdfRef: any;
    pdfUrl: string | null;
    activePage: number;
    tabId?: string;
    isActive?: boolean;
}

interface TileRenderRequestOptions {
    ownerId?: string;
    groupKey?: string;
    priority?: number;
}

let nextTileRendererId = 1;

export function useTileRenderer({ file, pdfRef, pdfUrl, activePage, tabId, isActive }: UseTileRendererProps) {
    const activePageRef = useRef(activePage);
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);

    const [rendererInstanceId] = useState(() => `viewer:${tabId || 'local'}:${nextTileRendererId++}`);
    const fileIdentity = (file as { path?: string } | null)?.path || pdfUrl || 'memory';
    const renderOwnerId = `${rendererInstanceId}:${fileIdentity}`;
    useEffect(() => () => {
        nativeTileRenderScheduler.cancelOwner(renderOwnerId);
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
        // lấy bytes JPEG qua IPC `invoke('render_pdf_page')` (giống tách nền dùng invoke→blob,
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
            return (async () => {
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
                const blob = new Blob([bytes], { type: 'image/jpeg' });
                return { url: URL.createObjectURL(blob), byteLength: blob.size };
            })();
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
                }, 'image/jpeg', 0.9);
            } catch (e) {
                reject(e);
            }
        });
    }, [activePageRef, file, pdfRef, pdfUrl, renderOwnerId]);

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

    return { getTileUrl, getTextBlocksForPage, renderOwnerId };
}
