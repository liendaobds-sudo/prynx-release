import { useRef, useEffect, useCallback } from 'react';

interface UseTileRendererProps {
    file: any;
    pdfRef: any;
    pdfUrl: string | null;
    zoom: number;
    activePage: number;
}

export function useTileRenderer({ file, pdfRef, pdfUrl, zoom, activePage }: UseTileRendererProps) {
    const tileQueueRef = useRef<{ args: any, resolve: any, reject: any }[]>([]);
    const isProcessingTileRef = useRef(false);

    const currentZoomRef = useRef(zoom);
    useEffect(() => { currentZoomRef.current = zoom; }, [zoom]);

    const activePageRef = useRef(activePage);
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);

    const processTileQueue = useCallback(async () => {
        if (isProcessingTileRef.current || tileQueueRef.current.length === 0) return;
        isProcessingTileRef.current = true;
        const { invoke } = await import('@tauri-apps/api/core');

        const MAX_CONCURRENT = 4;

        while (tileQueueRef.current.length > 0) {
            const ap = activePageRef.current || 1;
            tileQueueRef.current.sort((a, b) =>
                Math.abs(a.args.page - ap) - Math.abs(b.args.page - ap)
            );

            const batch = tileQueueRef.current.splice(0, MAX_CONCURRENT);

            await Promise.all(batch.map(async (item) => {
                if (!item) return;

                if (Math.abs(item.args.zoom - currentZoomRef.current) > 0.05) {
                    item.resolve('');
                    return;
                }

                try {
                    const bytes: Uint8Array = await invoke('render_pdf_page', item.args);
                    const blob = new Blob([bytes as any], { type: 'image/jpeg' });
                    const url = URL.createObjectURL(blob);
                    item.resolve(url);
                } catch (err) {
                    console.error(`[Queue] Failed tile:`, err);
                    item.reject(err);
                }
            }));
        }

        isProcessingTileRef.current = false;
    }, []);

    const getTileUrl = useCallback((pageNum: number, rotation: number, zoomScale: number, clipX?: number, clipY?: number, clipW?: number, clipH?: number): Promise<string> => {
        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);
        if (isImage) {
            return Promise.resolve(pdfUrl ? pdfUrl + '#keep' : '');
        }

        // Native file path → use tile:// custom protocol (zero IPC overhead)
        if ((file as any)?.path) {
            const encodedPath = encodeURIComponent((file as any).path);
            const url = `http://tile.localhost/${encodedPath}/${pageNum}/${zoomScale}/${rotation}/${clipX || 0}/${clipY || 0}/${clipW || 0}/${clipH || 0}`;
            return Promise.resolve(url);
        }

        // Fallback: PDF.js canvas rendering for non-native files
        return new Promise(async (resolve, reject) => {
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
                    if (blob) resolve(URL.createObjectURL(blob));
                    else reject("Failed to create blob");
                }, 'image/jpeg', 0.9);
            } catch (e) {
                reject(e);
            }
        });
    }, [file, pdfRef, pdfUrl]);

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

    return { getTileUrl, getTextBlocksForPage, processTileQueue };
}
