import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Page } from 'react-pdf';
import { convertFileSrc } from '@tauri-apps/api/core';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { VdpPreviewImage } from './ViewerHelpers';
import { useViewerHotkeys } from '../../hooks/viewer/useViewerHotkeys';
import { globalPdfObjectCache } from '../../stores/pdfObjectCache';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';

const TILE_SIZE = 512;

// ═══ Frontend Tile URL Cache ═══
// Persists tile image URLs across Virtuoso mount/unmount cycles
// so scrolling back to a previously-loaded page shows it INSTANTLY (no white flash).
const _tileUrlCache = new Map<string, string>();
const TILE_CACHE_MAX = 200; // Max cached tile URLs (LRU eviction)

function cacheTileUrl(key: string, url: string) {
    // LRU eviction: if full, delete the oldest entry
    if (_tileUrlCache.size >= TILE_CACHE_MAX && !_tileUrlCache.has(key)) {
        const oldest = _tileUrlCache.keys().next().value;
        if (oldest) {
            const oldUrl = _tileUrlCache.get(oldest);
            // Don't revoke protocol URLs (http://tile.localhost), only blobs
            if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
            _tileUrlCache.delete(oldest);
        }
    }
    _tileUrlCache.set(key, url);
}

function getCachedTileUrl(key: string): string | undefined {
    const url = _tileUrlCache.get(key);
    if (url) {
        // Move to end (most recently used) for LRU
        _tileUrlCache.delete(key);
        _tileUrlCache.set(key, url);
    }
    return url;
}

// Clear cache when loading a new file (called from parent)
export function clearTileUrlCache() {
    for (const [, url] of _tileUrlCache) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    _tileUrlCache.clear();
}

const LiveTile = ({ fileKey, pageNum, zoom, coarseZoom, rot, clipX, clipY, clipW, clipH, cssW, cssH, getTileUrl, onVisible }: any) => {
    const tileRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const loadedParamsRef = useRef('');
    const preloadRef = useRef<HTMLImageElement|null>(null);
    const hasLoadedOnce = useRef(false);
    
    const currentParams = `${fileKey}_${pageNum}_${zoom}_${rot}_${clipX}_${clipY}_${clipW}_${clipH}`;
    
    // On mount: immediately restore cached image (no white flash!)
    useEffect(() => {
        const cachedUrl = getCachedTileUrl(currentParams);
        if (cachedUrl && imgRef.current) {
            imgRef.current.src = cachedUrl;
            loadedParamsRef.current = currentParams;
            hasLoadedOnce.current = true;
            // Show immediately if cached
            if (tileRef.current) tileRef.current.style.opacity = '1';
            // Trang chính đã hiển thị (từ cache) → mở cổng cho thumbnail tải.
            window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
        }
    }, []); // Only on mount
    
    useEffect(() => {
        const el = tileRef.current;
        if (!el) return;
        
        if (loadedParamsRef.current === currentParams) return;
        
        // Check cache before scheduling network load
        const cachedUrl = getCachedTileUrl(currentParams);
        if (cachedUrl && imgRef.current) {
            imgRef.current.src = cachedUrl;
            loadedParamsRef.current = currentParams;
            hasLoadedOnce.current = true;
            if (tileRef.current) tileRef.current.style.opacity = '1';
            return;
        }
        
        (el as any)._loadTile = () => {
            if (loadedParamsRef.current === currentParams) return;
            if (!getTileUrl) return;
            const paramsAtRequest = currentParams;
            loadedParamsRef.current = paramsAtRequest;
            
            // Cancel previous preload
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current.onerror = null;
                preloadRef.current = null;
            }

            // Tải tile ở 'scale'. cache=true mới lưu cache. onDone gọi sau khi hiện xong
            // (dùng để nối pha sharp sau pha coarse — TUẦN TỰ, tránh tranh chấp mutex pdfium).
            const loadAt = (scale: number, cache: boolean, onDone?: () => void) => {
                getTileUrl(pageNum, rot, scale, clipX, clipY, clipW, clipH)
                    .then((url: string) => {
                        if (loadedParamsRef.current !== paramsAtRequest) {
                            if (url && url.startsWith('blob:') && !url.includes('#keep')) URL.revokeObjectURL(url);
                            return;
                        }
                        const preImg = new Image();
                        preloadRef.current = preImg;
                        preImg.onload = () => {
                            if (loadedParamsRef.current !== paramsAtRequest) return;
                            const imgEl = imgRef.current;
                            if (imgEl) {
                                const oldSrc = imgEl.src;
                                imgEl.src = url;
                                if (cache) cacheTileUrl(paramsAtRequest, url);
                                if (oldSrc && oldSrc.startsWith('blob:') && oldSrc !== url && !oldSrc.includes('#keep')) {
                                    let inCache = false;
                                    for (const [, v] of _tileUrlCache) { if (v === oldSrc) { inCache = true; break; } }
                                    if (!inCache) URL.revokeObjectURL(oldSrc);
                                }
                            }
                            if (!hasLoadedOnce.current) {
                                hasLoadedOnce.current = true;
                                if (tileRef.current) tileRef.current.style.opacity = '1';
                                // Trang chính vừa hiển thị → mở cổng cho thumbnail tải
                                // (tránh thumbnail tranh chấp pdfium handle với trang chính).
                                window.dispatchEvent(new CustomEvent('prynx-main-tile-ready'));
                            }
                            preloadRef.current = null;
                            if (onDone) onDone();
                        };
                        preImg.onerror = () => {
                            preloadRef.current = null;
                            if (onDone) { onDone(); return; }  // coarse lỗi → vẫn thử sharp
                            if (loadedParamsRef.current === paramsAtRequest) loadedParamsRef.current = '';
                        };
                        preImg.src = url;
                    })
                    .catch(() => {
                        if (onDone) { onDone(); return; }
                        if (loadedParamsRef.current === paramsAtRequest) loadedParamsRef.current = '';
                    });
            };

            if (typeof coarseZoom === 'number' && coarseZoom < zoom - 0.05) {
                // Pha 1: coarse (nhanh) hiện trước → Pha 2: sharp nối sau (tuần tự).
                loadAt(coarseZoom, false, () => {
                    if (loadedParamsRef.current === paramsAtRequest) loadAt(zoom, true);
                });
            } else {
                loadAt(zoom, true);
            }
        };
        onVisible(el);
        return () => {
            onVisible(el, true);
        };
    }, [currentParams, getTileUrl, onVisible]);
    
    // Cleanup on unmount — DON'T revoke blob URLs, they're in the cache now!
    useEffect(() => {
        return () => {
            if (preloadRef.current) {
                preloadRef.current.onload = null;
                preloadRef.current = null;
            }
            // Intentionally NOT revoking imgRef.current.src — it's cached for instant re-mount
        };
    }, []);
    // Initialize empty pixel only once (but only if no cached image was restored)
    useEffect(() => {
        if (imgRef.current && !imgRef.current.src) {
            imgRef.current.src = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
        }
    }, []);
    
    return (
        <div ref={tileRef} style={{ position: 'absolute', left: clipX, top: clipY, width: cssW || clipW, height: cssH || clipH, outline: 'none', opacity: hasLoadedOnce.current ? 1 : 0, transition: 'opacity 0.05s ease-in' }} className="tile-container">
            <img ref={imgRef} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none', userSelect: 'none', background: 'white' }} />
        </div>
    );
};

// ═══ VDP text preview với AUTO-FIT ═══
// Bóp cỡ chữ (xuống tối thiểu) để text vừa CHIỀU CAO khung, khớp với engine backend
// (ReportLab cũng bóp theo chiều cao). Khi autoFit === false thì giữ nguyên cỡ chữ.
const VdpAutoFitText = ({ field, scale, text, onAutoFit }: any) => {
    const ref = useRef<HTMLSpanElement>(null);
    // Backend render fontSize ở pt THẬT, nhưng khung dùng đơn vị CSS (×96/72). Để preview
    // khớp output, cỡ chữ trên màn = fontSize(pt) × scale × (96/72). scale = displayWidth/pageDim.w.
    const maxPx = (field.fontSize || 10) * scale * (96 / 72);
    const [fitPx, setFitPx] = useState<number>(maxPx);

    useLayoutEffect(() => {
        if (field.autoFit === false) { setFitPx(maxPx); return; }
        const el = ref.current;
        const parent = el?.parentElement;
        if (!el || !parent) return;
        let size = maxPx;
        el.style.fontSize = `${size}px`;
        let guard = 0;
        while (guard++ < 300 && size > 1 &&
               (el.scrollHeight > parent.clientHeight + 0.5 || el.scrollWidth > parent.clientWidth + 0.5)) {
            size -= Math.max(0.5, size * 0.06);
            el.style.fontSize = `${size}px`;
        }
        setFitPx(size);
        // Ghi cỡ chữ THỰC TẾ (sau khi bóp) về field.fontSize → ô "Cỡ chữ" trên UI luôn khớp
        // preview & output. Chỉ ghi khi đã bị bóp nhỏ hơn để tránh vòng lặp (đã hội tụ).
        if (onAutoFit && scale > 0 && size < maxPx - 0.5) {
            onAutoFit(size / (scale * (96 / 72)));
        }
    }, [text, maxPx, field.width, field.height, field.autoFit, field.fontName, field.fontStyle, field.lineHeight, field.characterSpacing, field.alignment]);

    const fontPx = field.autoFit === false ? maxPx : fitPx;
    return (
        <span
            ref={ref}
            className="px-1 whitespace-pre-wrap break-words overflow-hidden w-full h-full"
            style={{
                color: field.fontColor || '#1e293b',
                fontSize: `${fontPx}px`,
                fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit'),
                fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                // Backend (ReportLab Paragraph) chưa hỗ trợ tracking → preview cũng bỏ qua để khớp output.
                letterSpacing: 0,
                textAlign: field.alignment || 'left'
            }}
        >
            {text}
        </span>
    );
};

export const LivePageFrame = (props: any) => {
    //#region Props & State
    const { originalPageNum, actualWidth100, zoom, rotation, bleedView, highlightBoxes, pageDim,
        onObjectDelete, fetchObjectsForPage,
        getTileUrl, textBlocks, isVdpMode, onVdpBoxCreate, onVdpBoxSelect, onVdpFieldsChange,
        setHoveredPdfPosition, detectedDimension, isBlankDoc
    } = props;

    const {
        isSelectionMode, pdfObjectsVersion, selectedObjectIds, selectionFileId, hiddenObjectIds, hiddenOcgLayerIds,
        separationPlates, vdpFields, selectedVdpFieldIds,
        softProofImageUrl, gamutWarningUrl, tacHeatmapUrl, overprintPreviewUrl,
        setSelectedObjectIds, pdfUrl, setSelectedVdpFieldIds
    } = useWorkspaceStore(useShallow(state => ({
        isSelectionMode: state.isSelectionMode,
        pdfObjectsVersion: state.pdfObjectsVersion,
        selectedObjectIds: state.selectedObjectIds,
        selectionFileId: state.selectionFileId,
        hiddenObjectIds: state.hiddenObjectIds,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds,
        separationPlates: state.separationPlates,
        vdpFields: state.vdpFields,
        selectedVdpFieldIds: state.selectedVdpFieldIds,
        softProofImageUrl: state.softProofImageUrl,
        gamutWarningUrl: state.gamutWarningUrl,
        tacHeatmapUrl: state.tacHeatmapUrl,
        overprintPreviewUrl: state.overprintPreviewUrl,
        setSelectedObjectIds: state.setSelectedObjectIds,
        pdfUrl: state.pdfUrl,
        setSelectedVdpFieldIds: state.setSelectedVdpFieldIds
    })));

    const onObjectSelect = setSelectedObjectIds;
    
    const watermarkPreview = useWorkspaceStore(s => s.watermarkPreview);
    const activeDashboardTool = useWorkspaceStore(s => s.activeDashboardTool);
    const containerRef = useRef<HTMLDivElement>(null);
    const marqueeRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; active: boolean; lastHoverTime?: number }>({ startX: 0, startY: 0, active: false });
    
    const { stickPreviewParams } = useWorkspaceStore();

    // VDP Drag/Resize interaction state
    const [vdpInteraction, setVdpInteraction] = useState<{ type: 'move'|'resize', handle?: 'nw'|'ne'|'sw'|'se', fieldIds: string[], startX: number, startY: number, startFields: Record<string, {x: number, y: number, w: number, h: number}> } | null>(null);
    const [editingTextId, setEditingTextId] = useState<string | null>(null);
    const [editTextContent, setEditTextContent] = useState<string>('');
    
    // Preview image state (driven by hiddenObjectIds prop from parent)
    const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);

    const observerRef = useRef<IntersectionObserver | null>(null);

    const handleTileVisibility = React.useCallback((el: HTMLElement, isCleanup?: boolean) => {
        if (!observerRef.current) {
            observerRef.current = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const target = entry.target as any;
                        if (target._loadTile) target._loadTile();
                        observerRef.current?.unobserve(target);
                    }
                });
            }, { rootMargin: '4000px' });
        }
        if (isCleanup) {
            observerRef.current.unobserve(el);
        } else {
            observerRef.current.observe(el);
        }
    }, []);

    // Debounced zoom for crisp rendering without lag.
    // DPR-aware (nét trên màn HiDPI) NHƯNG chặn theo ngân sách pixel để render+encode
    // luôn nhanh — tránh việc zoom cao render nguyên trang thành bitmap khổng lồ
    // (vài chục MP) khiến phải "chờ rất lâu mới nét".
    const computeRenderZoom = (z: number) => {
        const dpr = (window.devicePixelRatio || 1);
        const target = Math.max(dpr, z * dpr);
        // Trần theo ngân sách: giữ cạnh dài bitmap ≲ 5000px (encode ~vài trăm ms).
        const w100 = actualWidth100 || 800;
        const ratio = (pageDim && pageDim.w) ? Math.max(1, pageDim.h / pageDim.w) : 1.414;
        const MAX_LONG_PX = 5000;
        const capByBudget = MAX_LONG_PX / (w100 * ratio);
        return Math.min(8, target, Math.max(dpr, capByBudget));
    };
    const [renderZoom, setRenderZoom] = useState(() => computeRenderZoom(zoom));

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            setRenderZoom(computeRenderZoom(zoom));
        }, 250);
        return () => clearTimeout(timeoutId);
    }, [zoom]);

    useEffect(() => {
        if (isSelectionMode && originalPageNum !== -1) {
            fetchObjectsForPage?.(originalPageNum);
        }
    }, [isSelectionMode, originalPageNum, fetchObjectsForPage]);
    
    if (originalPageNum === -1) {
        return (
            <div className="bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden">
                <div style={{ width: actualWidth100 * zoom, height: actualWidth100 * zoom * 1.414 }} className="bg-white flex items-center justify-center">
                    <span className="text-slate-200 text-3xl font-bold tracking-[0.5em] -rotate-45">DOCUMENT BLANK PAGE</span>
                </div>
            </div>
        );
    }
    
    // Fetch preview image when hidden objects OR hidden OCG layers change
    useEffect(() => {
        if (hiddenObjectIds.length === 0 && hiddenOcgLayerIds.length === 0) {
            setPreviewImageUrl(null);
            setIsPreviewLoading(false);
            return;
        }

        if (!selectionFileId) return;

        let isMounted = true;
        setIsPreviewLoading(true);

        const fetchPreview = async () => {
            try {
                // If there are hidden OCG layers, fetch the layer preview
                if (hiddenOcgLayerIds.length > 0) {
                    const res = await authenticatedFetch(`${getApiUrl()}/preflight/preview-layers`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            file_id: selectionFileId,
                            page: originalPageNum,
                            hidden_layer_numbers: hiddenOcgLayerIds
                        })
                    });
                    if (!res.ok) throw new Error('Preview layer fetch failed');
                    const data = await res.json();
                    if (isMounted && data.success && data.preview_b64) {
                        setPreviewImageUrl(data.preview_b64);
                    }
                    return; // Skip the hidden object fetch if we did OCG
                }

                // Fallback to hidden object preview
                const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);
                const objectsToHide = currentObjects.filter((o: any) => hiddenObjectIds.includes(o.id));
                
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/preview-hide`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: selectionFileId,
                        page: originalPageNum,
                        objects: objectsToHide.map((obj: any) => ({
                            type: obj.type,
                            bbox: obj.bbox,
                            xref: obj.xref
                        }))
                    })
                });

                if (!res.ok) throw new Error('Preview fetch failed');
                const data = await res.json();
                
                if (isMounted && data.success && data.preview_b64) {
                    setPreviewImageUrl(data.preview_b64);
                }
            } catch (err) {
                console.error("Failed to fetch hidden layer preview:", err);
            } finally {
                if (isMounted) setIsPreviewLoading(false);
            }
        };

        // Small debounce to avoid spamming if user clicks rapidly
        const timeoutId = setTimeout(() => {
            fetchPreview();
        }, 300);

        return () => {
            isMounted = false;
            clearTimeout(timeoutId);
        };
    }, [hiddenObjectIds, hiddenOcgLayerIds, selectionFileId, originalPageNum, pdfObjectsVersion]);
    
    //#endregion

    //#region Drag & Interaction Events
    const displayWidth = actualWidth100 * zoom;
    // Native event listeners to bypass WebView2/React synthetic event limitations
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const handleDragEnter = (e: DragEvent) => {
            e.preventDefault();
            if (isVdpMode) {
                el.style.opacity = '0.8';
                e.dataTransfer!.dropEffect = 'copy';
            }
        };

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault(); // MANDATORY for drop
            if (isVdpMode) {
                e.dataTransfer!.dropEffect = 'copy';
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            el.style.opacity = '1';
        };

        const handleDrop = (e: DragEvent) => {
            el.style.opacity = '1';
            if (!isVdpMode) return;
            e.preventDefault();
            
            let vdpType = '';
            try {
                vdpType = e.dataTransfer!.getData('application/vdp-field');
            } catch(err) {}
            if (!vdpType) {
                try {
                    const payload = JSON.parse(e.dataTransfer!.getData('text/plain'));
                    if (payload && payload.source === 'vdp') {
                        vdpType = payload.type;
                    }
                } catch (err) {}
            }
            
            if (vdpType && pageDim) {
                const rect = el.getBoundingClientRect();
                const curX = e.clientX - rect.left;
                const curY = e.clientY - rect.top;
                
                const pageWidthPt = pageDim.w;
                const scale = displayWidth / pageWidthPt;
                
                const boxX = (curX / scale) / 72 * 25.4;
                const boxY = (curY / scale) / 72 * 25.4;
                
                // default sizes — theo loại field để khung khớp mẫu ngay khi thả
                const isSquare = vdpType === 'qrcode' || vdpType === 'image';
                let wMM = isSquare ? 25 : 50;
                let hMM = vdpType === 'qrcode' || vdpType === 'image' ? 25 : (vdpType === 'barcode' ? 15 : 10);
                // Không cho placeholder vượt quá ~90% kích thước trang (quan trọng với trang nhỏ như 15x15mm)
                // pageDim.w là px@96; field dùng đơn vị "CSS-mm" (mm × 96/72) nên dùng × 25.4 / 72.
                const pageWmm = pageDim.w * 25.4 / 72;
                const pageHmm = pageDim.h * 25.4 / 72;
                const maxW = pageWmm * 0.9;
                const maxH = pageHmm * 0.9;
                if (isSquare) {
                    const s = Math.max(5, Math.min(wMM, maxW, maxH));
                    wMM = s; hMM = s;
                } else {
                    wMM = Math.max(5, Math.min(wMM, maxW));
                    hMM = Math.max(5, Math.min(hMM, maxH));
                }
                // Canh để khung nằm gọn trong trang
                const placeX = Math.max(0, Math.min(boxX, pageWmm - wMM));
                const placeY = Math.max(0, Math.min(boxY, pageHmm - hMM));
                const textContent = vdpType === 'text' ? `{Truong_${vdpFields.length + 1}}` : undefined;
                const fieldName = `Truong_${vdpFields.length + 1}`;
                
                onVdpBoxCreate?.({ 
                    x: placeX, y: placeY, width: wMM, height: hMM, 
                    pageNum: originalPageNum, type: vdpType,
                    textContent: textContent || undefined,
                    name: fieldName || undefined
                } as any); 
            }
        };

        const handleVdpDrop = (e: CustomEvent) => {
            if (!isVdpMode) return;
            const targetEl = e.detail.target as HTMLElement;
            if (!el.contains(targetEl) && el !== targetEl) return;
            
            const vdpType = e.detail.type;
            if (vdpType && pageDim) {
                const rect = el.getBoundingClientRect();
                const curX = e.detail.clientX - rect.left;
                const curY = e.detail.clientY - rect.top;
                
                const pageWidthPt = pageDim.w;
                const scale = displayWidth / pageWidthPt;
                
                const boxX = (curX / scale) / 72 * 25.4;
                const boxY = (curY / scale) / 72 * 25.4;
                
                // default sizes — theo loại field để khung khớp mẫu ngay khi thả
                const isSquare = vdpType === 'qrcode' || vdpType === 'image';
                let wMM = isSquare ? 25 : 50;
                let hMM = vdpType === 'qrcode' || vdpType === 'image' ? 25 : (vdpType === 'barcode' ? 15 : 10);
                // Không cho placeholder vượt quá ~90% kích thước trang (quan trọng với trang nhỏ như 15x15mm)
                // pageDim.w là px@96; field dùng đơn vị "CSS-mm" (mm × 96/72) nên dùng × 25.4 / 72.
                const pageWmm = pageDim.w * 25.4 / 72;
                const pageHmm = pageDim.h * 25.4 / 72;
                const maxW = pageWmm * 0.9;
                const maxH = pageHmm * 0.9;
                if (isSquare) {
                    const s = Math.max(5, Math.min(wMM, maxW, maxH));
                    wMM = s; hMM = s;
                } else {
                    wMM = Math.max(5, Math.min(wMM, maxW));
                    hMM = Math.max(5, Math.min(hMM, maxH));
                }
                // Canh để khung nằm gọn trong trang
                const placeX = Math.max(0, Math.min(boxX, pageWmm - wMM));
                const placeY = Math.max(0, Math.min(boxY, pageHmm - hMM));
                const textContent = e.detail.textContent || (vdpType === 'text' ? `{Truong_${vdpFields.length + 1}}` : undefined);
                const fieldName = e.detail.name || `Truong_${vdpFields.length + 1}`;
                
                onVdpBoxCreate?.({ 
                    x: placeX, y: placeY, width: wMM, height: hMM, 
                    pageNum: originalPageNum, type: vdpType,
                    textContent: textContent || undefined,
                    name: fieldName || undefined
                } as any); 
            }
        };

        el.addEventListener('dragenter', handleDragEnter);
        el.addEventListener('dragover', handleDragOver);
        el.addEventListener('dragleave', handleDragLeave);
        el.addEventListener('drop', handleDrop);
        window.addEventListener('vdp-drop', handleVdpDrop as EventListener);

        return () => {
            el.removeEventListener('dragenter', handleDragEnter);
            el.removeEventListener('dragover', handleDragOver);
            el.removeEventListener('dragleave', handleDragLeave);
            el.removeEventListener('drop', handleDrop);
            window.removeEventListener('vdp-drop', handleVdpDrop as EventListener);
        };
    }, [isVdpMode, pageDim, displayWidth, onVdpBoxCreate, vdpFields.length, originalPageNum]);

    const displayHeight = pageDim && pageDim.w ? displayWidth * (pageDim.h / pageDim.w) : displayWidth * 1.414;
    const renderWidth = actualWidth100 * renderZoom;
    
    const isRotated = (rotation || 0) % 180 !== 0;
    const outerWidth = isRotated ? displayHeight : displayWidth;
    const outerHeight = isRotated ? displayWidth : displayHeight;

    const getUnrotatedCoords = (clientX: number, clientY: number, rect: DOMRect) => {
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const x = clientX - rect.left - cx;
        const y = clientY - rect.top - cy;
        
        const angle = -(rotation || 0) * Math.PI / 180;
        const unrotatedX = x * Math.cos(angle) - y * Math.sin(angle);
        const unrotatedY = x * Math.sin(angle) + y * Math.cos(angle);
        
        return { 
            x: unrotatedX + displayWidth / 2, 
            y: unrotatedY + displayHeight / 2 
        };
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        if ((!isSelectionMode && !isVdpMode) || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        dragRef.current = { startX: coords.x, startY: coords.y, active: true };
        if (marqueeRef.current) {
            marqueeRef.current.style.display = 'block';
            marqueeRef.current.style.left = `${coords.x}px`;
            marqueeRef.current.style.top = `${coords.y}px`;
            marqueeRef.current.style.width = '0px';
            marqueeRef.current.style.height = '0px';
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const curX = coords.x;
        const curY = coords.y;

        // Dispatch hover event for OutputPreview (throttled to ~20fps to avoid React spam)
        if (setHoveredPdfPosition) {
            const now = Date.now();
            if (!dragRef.current.lastHoverTime || now - dragRef.current.lastHoverTime > 50) {
                dragRef.current.lastHoverTime = now;
                setHoveredPdfPosition({ pageNum: originalPageNum, x: curX / rect.width, y: curY / rect.height });
            }
        }

        if (vdpInteraction && onVdpFieldsChange && pageDim) {
            const dx = curX - vdpInteraction.startX;
            const dy = curY - vdpInteraction.startY;
            
            const pageWidthPt = pageDim.w;
            const scale = displayWidth / pageWidthPt;
            
            // Convert pixel delta to mm delta
            const dxMM = (dx / scale) / 72 * 25.4;
            const dyMM = (dy / scale) / 72 * 25.4;
            
            onVdpFieldsChange((prev: any[]) => prev.map(f => {
                if (!vdpInteraction.fieldIds.includes(f.id)) return f;
                const startData = vdpInteraction.startFields[f.id];
                if (!startData) return f;
                
                if (vdpInteraction.type === 'move') {
                    return { ...f, x: startData.x + dxMM, y: startData.y + dyMM };
                } else if (vdpInteraction.type === 'resize') {
                    // Resize theo góc đang kéo (nw/ne/sw/se), giữ cạnh đối diện cố định.
                    const handle = vdpInteraction.handle || 'se';
                    let newX = startData.x, newY = startData.y;
                    let newW = startData.w, newH = startData.h;
                    if (handle.includes('e')) newW = startData.w + dxMM;
                    if (handle.includes('w')) newW = startData.w - dxMM;
                    if (handle.includes('s')) newH = startData.h + dyMM;
                    if (handle.includes('n')) newH = startData.h - dyMM;
                    newW = Math.max(5, newW);
                    newH = Math.max(5, newH);
                    if (f.type === 'qrcode') {
                        const size = Math.max(newW, newH);
                        newW = size;
                        newH = size;
                    }
                    // Khi kéo từ cạnh trái/trên, dời gốc để cạnh phải/dưới đứng yên.
                    if (handle.includes('w')) newX = startData.x + (startData.w - newW);
                    if (handle.includes('n')) newY = startData.y + (startData.h - newH);
                    return { ...f, x: newX, y: newY, width: newW, height: newH };
                }
                return f;
            }));
            return;
        }

        if (!dragRef.current.active || !isSelectionMode) return;
        const { startX, startY } = dragRef.current;
        // Direct DOM update â€” no React re-render
        if (marqueeRef.current) {
            marqueeRef.current.style.left = `${Math.min(startX, curX)}px`;
            marqueeRef.current.style.top = `${Math.min(startY, curY)}px`;
            marqueeRef.current.style.width = `${Math.abs(curX - startX)}px`;
            marqueeRef.current.style.height = `${Math.abs(curY - startY)}px`;
        }
    };

    const handleMouseUp = (e: React.MouseEvent) => {
        if (vdpInteraction) {
            setVdpInteraction(null);
            return;
        }
        if (!dragRef.current.active || (!isSelectionMode && !isVdpMode) || !containerRef.current) {
            dragRef.current.active = false;
            if (marqueeRef.current) marqueeRef.current.style.display = 'none';
            return;
        }
        
        const rect = containerRef.current.getBoundingClientRect();
        const coords = getUnrotatedCoords(e.clientX, e.clientY, rect);
        const curX = coords.x;
        const curY = coords.y;
        const { startX, startY } = dragRef.current;
        
        dragRef.current.active = false;
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
        
        // Calculate selection rectangle
        const x1 = Math.min(startX, curX);
        const y1 = Math.min(startY, curY);
        const x2 = Math.max(startX, curX);
        const y2 = Math.max(startY, curY);
        
        // Tiny click = click on empty space => deselect all
        if (x2 - x1 < 5 && y2 - y1 < 5) {
            if (isSelectionMode) onObjectSelect?.([]);
            if (isVdpMode) {
                setSelectedVdpFieldIds([]);
                onVdpBoxSelect?.([]);
            }
            return;
        }

        if (isSelectionMode) {
            if (isVdpMode) {
                // Select VDP fields instead of PDF objects
                const pageWidthPt = pageDim?.w || 595;
                const scale = displayWidth / pageWidthPt;
                const newlySelectedIds = [...selectedVdpFieldIds];
                vdpFields.forEach((field: any) => {
                    if (field.pageNum !== originalPageNum) return;
                    const left = (field.x / 25.4 * 72) * scale;
                    const top = (field.y / 25.4 * 72) * scale;
                    const right = left + (field.width / 25.4 * 72) * scale;
                    const bottom = top + (field.height / 25.4 * 72) * scale;
                    
                    if (left < x2 && right > x1 && top < y2 && bottom > y1 && !newlySelectedIds.includes(field.id)) {
                        newlySelectedIds.push(field.id);
                    }
                });
                setSelectedVdpFieldIds(newlySelectedIds);
                onVdpBoxSelect?.(newlySelectedIds);
            } else {
                const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);
                const pageWidthPt = pageDim?.w || 595;
                const scale = displayWidth / pageWidthPt;
                
                const newlySelectedIds = [...selectedObjectIds];
                
                currentObjects.forEach((obj: any) => {
                    const [ox0, oy0, ox1, oy1] = obj.bbox;
                    const left = ox0 * scale;
                    const top = oy0 * scale;
                    const right = ox1 * scale;
                    const bottom = oy1 * scale;
                    
                    if (left < x2 && right > x1 && top < y2 && bottom > y1 && !newlySelectedIds.includes(obj.id)) {
                        newlySelectedIds.push(obj.id);
                    }
                });
                
                onObjectSelect?.(newlySelectedIds);
            }
        }
    };

    const handleMouseLeave = () => {
        dragRef.current.active = false;
        setVdpInteraction(null);
        if (marqueeRef.current) marqueeRef.current.style.display = 'none';
    };
    //#endregion

    //#region Render
    return (
        <>
        {/* Inject dynamic fonts for VDP */}
        {isVdpMode && (window as any).__TAURI_INTERNALS__ && vdpFields?.map((field: any, idx: number) => 
            field.fontFile && field.fontName ? (
                <style key={`vdp-font-${field.id || idx}`}>{`
                    @font-face {
                        font-family: "${field.fontName}_local";
                        src: url("${convertFileSrc(field.fontFile)}");
                    }
                `}</style>
            ) : null
        )}
        <div className="relative shrink-0" style={{ width: outerWidth }}>
        <div 
            ref={containerRef}
            className="bg-white shadow-[0_4px_30px_rgba(0,0,0,0.15)] ring-1 ring-black/5 relative shrink-0 overflow-hidden group/pdf-frame" 
            style={{ width: outerWidth, height: outerHeight }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
        >
            <div style={{
                position: 'absolute',
                width: displayWidth,
                height: displayHeight,
                left: '50%',
                top: '50%',
                transform: `translate(-50%, -50%) rotate(${rotation || 0}deg)`,
                transformOrigin: 'center center'
            }}>
            {isBlankDoc ? (
                /* Trang trắng mới tạo: kích thước đã biết, không cần render qua engine nào — hiện nền trắng tức thì */
                <div style={{ width: displayWidth, height: displayHeight, background: 'white' }} />
            ) : getTileUrl ? (() => {
                return (
                    <div style={{ width: displayWidth, height: displayHeight, position: 'relative' }}>
                        {/* Loading Skeleton */}
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/50 z-0">
                            <div className="flex flex-col items-center opacity-50">
                                <div className="w-8 h-8 border-4 border-slate-300 border-t-slate-500 rounded-full animate-spin mb-2" />
                                <span className="text-xs font-semibold text-slate-500 tracking-wider">RENDERING</span>
                            </div>
                        </div>
                        <div className="absolute inset-0 z-10">
                            <LiveTile fileKey={pdfUrl || 'unknown'} key="full" pageNum={originalPageNum} zoom={renderZoom} rot={0} clipX={0} clipY={0} clipW={0} clipH={0} cssW={Math.ceil(displayWidth)} cssH={Math.ceil(displayHeight)} getTileUrl={getTileUrl} onVisible={handleTileVisibility} />
                        </div>
                    </div>
                );
            })() : (
                <Page
                    className="gpu-zoom-page block max-w-none origin-top-left"
                    pageNumber={originalPageNum}
                    width={renderWidth}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                />
            )}

             {/* Invisible Text Layer for native mode */}
            {getTileUrl && textBlocks && (
                <div className="absolute inset-0 z-[2] select-text" style={{ pointerEvents: isVdpMode ? 'none' : 'auto' }}>
                    {(Array.isArray(textBlocks) ? textBlocks : (textBlocks.blocks || [])).map((block: any, bi: number) => 
                         block.lines?.map((line: any, li: number) => {
                             const pageWidthPt = pageDim?.w || 595;
                             const scale = displayWidth / pageWidthPt;
                             return (
                                 <span
                                     key={`${bi}_${li}`}
                                     style={{
                                         position: 'absolute',
                                         left: line.bbox.x * scale,
                                         top: line.bbox.y * scale,
                                         width: (line.bbox.w) * scale,
                                         height: (line.bbox.h) * scale,
                                         fontSize: `${(line.bbox.h) * scale * 0.85}px`,
                                         lineHeight: '1',
                                         color: 'transparent',
                                         whiteSpace: 'pre',
                                         overflow: 'hidden',
                                     }}
                                 >
                                     {line.chars?.map((c: any) => c.c).join('') || ''}
                                 </span>
                             );
                         })
                     )}
                 </div>
             )}
             
             {/* Output Preview: Separation plate overlays rendered on the PDF page */}
             {separationPlates.length > 0 && (
                 <div className="absolute inset-0 z-[14] bg-white pointer-events-none">
                     {separationPlates.map((plate: any) => plate.visible ? (
                         <img 
                             key={plate.name}
                             src={plate.dataUrl}
                             alt={plate.name}
                             className="absolute inset-0 w-full h-full mix-blend-multiply"
                             style={{ objectFit: 'fill' }}
                         />
                     ) : null)}
                 </div>
             )}

             {/* ICC Soft-Proof Overlay — simulates print output */}
             {softProofImageUrl && (
                 <img 
                     src={softProofImageUrl}
                     alt="Soft-Proof"
                     className="absolute inset-0 z-[16] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* Gamut Warning Overlay — highlights out-of-gamut pixels */}
             {gamutWarningUrl && (
                 <img 
                     src={gamutWarningUrl}
                     alt="Gamut Warning"
                     className="absolute inset-0 z-[17] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* TAC Heatmap Overlay — highlights areas exceeding total ink coverage threshold */}
             {tacHeatmapUrl && (
                 <img 
                     src={tacHeatmapUrl}
                     alt="TAC Heatmap"
                     className="absolute inset-0 z-[18] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}

             {/* Overprint Preview Overlay — simulates overprint rendering */}
             {overprintPreviewUrl && (
                 <img 
                     src={overprintPreviewUrl}
                     alt="Overprint Preview"
                     className="absolute inset-0 z-[19] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}
             
             {/* Hidden Layers Preview Overlay â€” covers page exactly like Illustrator layer toggle */}
             {previewImageUrl && (
                 <img 
                     src={previewImageUrl} 
                     alt=""
                     className="absolute top-0 left-0 z-[15] pointer-events-none"
                     style={{ width: '100%', height: '100%', objectFit: 'fill' }}
                 />
             )}
             
             {isPreviewLoading && (
                 <div className="absolute top-1.5 left-1.5 z-50 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded-sm backdrop-blur-md flex items-center gap-1.5">
                     <div className="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                     Preview...
                 </div>
             )}
             {bleedView?.show && (
                 <div 
                     className="absolute inset-0 pointer-events-none z-[60]" 
                     style={{ 
                         borderWidth: `${bleedView.mm * (96 / 25.4) * zoom}px`,
                         borderColor: 'rgba(239, 68, 68, 0.4)',
                         borderStyle: 'solid',
                         boxSizing: 'border-box'
                     }}
                 />
             )}
             
             {highlightBoxes && highlightBoxes.map((box: any, idx: number) => {
                 if (!pageDim) return null;
                 
                 // If no bbox, it's a page-level issue (like Transparency or Overprint)
                 if (!box.bbox || box.bbox.length !== 4) {
                     return (
                         <div 
                            key={`page-${idx}`}
                            className="absolute inset-0 z-[70] border-[6px] border-amber-500 bg-amber-500/10 shadow-[inset_0_0_30px_rgba(245,158,11,0.5)] animate-pulse pointer-events-none"
                         />
                     );
                 }

                 // Helper to render a single box
                 const renderBox = (bbox: number[], boxIdx: string | number) => {
                     const [x0, y0, x1, y1] = bbox;
                     const pageWidthPt = pageDim.w;
                     const pageHeightPt = pageDim.h;
                     
                     const left = (x0 / pageWidthPt) * 100;
                     const top = (y0 / pageHeightPt) * 100;
                     const width = ((x1 - x0) / pageWidthPt) * 100;
                     const height = ((y1 - y0) / pageHeightPt) * 100;
                     
                     return (
                         <div 
                             key={`box-${idx}-${boxIdx}`}
                             className="absolute z-[70] border-2 border-red-500 bg-red-500/10 shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse pointer-events-none"
                             style={{
                                 left: `${left}%`,
                                 top: `${top}%`,
                                 width: `${width}%`,
                                 height: `${height}%`,
                             }}
                         />
                     );
                 };

                 // Render multiple boxes if available
                 if (box.bboxes && box.bboxes.length > 0) {
                     return box.bboxes.map((b: number[], bIdx: number) => renderBox(b, bIdx));
                 }
                 
                 // Fallback to single box
                 return renderBox(box.bbox, 'single');
             })}

             {/* Selection Tool Overlay */}
             {isSelectionMode && pdfObjectsVersion !== undefined && pageDim && (() => {
                 const currentObjects = globalPdfObjectCache.getPageObjects(pdfUrl || '', originalPageNum);
                 if (!currentObjects || currentObjects.length === 0) return null;
                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 return (
                     <>
                             {[...currentObjects].sort((a: any, b: any) => {
                                 const areaA = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
                                 const areaB = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
                                 return areaB - areaA; // Largest first (bottom), smallest last (top)
                             }).map((obj: any) => {
                                 const [x0, y0, x1, y1] = obj.bbox;
                                 const isSelected = selectedObjectIds.includes(obj.id);
                                 const isHidden = hiddenObjectIds.includes(obj.id);
                                 const typeColor = obj.type === 'text' ? 'rgb(59,130,246)' : obj.type === 'image' ? 'rgb(168,85,247)' : 'rgb(234,179,8)';
                             return (
                                 <div
                                     key={obj.id}
                                     className={`absolute pointer-events-auto cursor-pointer z-30 transition-colors hover:bg-slate-400/20 hover:border-slate-400 border border-transparent ${isHidden ? 'opacity-30' : ''}`}
                                     style={{ 
                                         left: x0 * scale, top: y0 * scale, 
                                         width: (x1 - x0) * scale, height: (y1 - y0) * scale,
                                         border: isHidden ? `2px dashed rgba(239,68,68,0.6)` : isSelected ? `2px solid ${typeColor}` : undefined,
                                         backgroundColor: isHidden ? 'rgba(239,68,68,0.08)' : isSelected ? `${typeColor}20` : undefined,
                                         boxShadow: isSelected ? `0 0 0 1px ${typeColor}40` : 'none',
                                     }}
                                     title={`${obj.type.toUpperCase()}: ${obj.content || obj.id}`}
                                     onMouseEnter={(e) => {
                                         if (!isSelected && !isHidden) {
                                             (e.currentTarget as HTMLDivElement).style.border = `1.5px solid ${typeColor}`;
                                             (e.currentTarget as HTMLDivElement).style.backgroundColor = `${typeColor}08`;
                                         }
                                     }}
                                     onMouseLeave={(e) => {
                                         if (!isSelected && !isHidden) {
                                             (e.currentTarget as HTMLDivElement).style.border = '1px solid transparent';
                                             (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
                                         }
                                     }}
                                     onClick={(e) => {
                                         e.stopPropagation();
                                         if (e.shiftKey) {
                                             onObjectSelect?.(isSelected ? selectedObjectIds.filter((id: string) => id !== obj.id) : [...selectedObjectIds, obj.id]);
                                         } else {
                                             onObjectSelect?.(isSelected && selectedObjectIds.length === 1 ? [] : [obj.id]);
                                         }
                                     }}
                                 />
                             );
                         })}
                     </>
                 );
             })()}
             
             {/* Watermark Live Preview Overlay */}
             {activeDashboardTool === 'watermark' && watermarkPreview && pageDim && (() => {
                 const {
                     watermarkType, watermarkText, batesStart, batesPadding, watermarkImageUrl,
                     layerZIndex, color, fontSize, opacity, rotation, spacing, isRepeated,
                     scaleMode, imageScale, positionXMode, offsetX, positionYMode, offsetY,
                     targetType, rangeStart, rangeEnd, wmWidth = 100, wmHeight = 100
                 } = watermarkPreview;

                 // Check range
                 const pageIdx = originalPageNum - 1;
                 let shouldRender = true;
                 if (targetType === 'even' && (pageIdx + 1) % 2 !== 0) shouldRender = false;
                 if (targetType === 'odd' && (pageIdx + 1) % 2 !== 1) shouldRender = false;
                 if (targetType === 'range' && ((pageIdx + 1) < rangeStart || (pageIdx + 1) > rangeEnd)) shouldRender = false;
                 
                 if (!shouldRender) return null;

                 const dummyText = watermarkText
                    .replace(/\[PAGE\]/g, (pageIdx + 1).toString())
                    .replace(/\[TOTAL\]/g, '99')
                    .replace(/\[DATE\]/g, new Date().toLocaleDateString('vi-VN'))
                    .replace(/\[TIME\]/g, new Date().toLocaleTimeString('vi-VN'))
                    .replace(/\[BATES\]/g, (batesStart + pageIdx).toString().padStart(batesPadding, '0'));

                 // Need to scale physical units (mm, pt) to CSS pixels on screen
                 // Note: AcrobatViewer CSS is heavily zoomed. We rely on displayWidth and pageDim.w
                 // to scale appropriately. pageDim.w is in pixels at 96 DPI.
                 const pageWidthPt = pageDim.w;
                 const pageHeightPt = pageDim.h;
                 const scale = displayWidth / pageWidthPt;
                 
                 let finalScaleX = imageScale;
                 let finalScaleY = imageScale;

                 if (scaleMode === 'fit_page' && wmWidth > 0 && wmHeight > 0) {
                     const rad = rotation * Math.PI / 180;
                     const rotatedWmWidth = Math.abs(wmWidth * Math.cos(rad)) + Math.abs(wmHeight * Math.sin(rad));
                     const rotatedWmHeight = Math.abs(wmWidth * Math.sin(rad)) + Math.abs(wmHeight * Math.cos(rad));
                     const scaleX = pageWidthPt / rotatedWmWidth;
                     const scaleY = pageHeightPt / rotatedWmHeight;
                     finalScaleX = Math.min(scaleX, scaleY);
                     finalScaleY = finalScaleX;
                 } else if (scaleMode === 'stretch' && wmWidth > 0 && wmHeight > 0) {
                     const rad = rotation * Math.PI / 180;
                     const targetWidth = pageWidthPt * Math.abs(Math.cos(rad)) + pageHeightPt * Math.abs(Math.sin(rad));
                     const targetHeight = pageHeightPt * Math.abs(Math.cos(rad)) + pageWidthPt * Math.abs(Math.sin(rad));
                     finalScaleX = targetWidth / wmWidth;
                     finalScaleY = targetHeight / wmHeight;
                 }
                 
                 const scaledWmWidth = wmWidth * finalScaleX * scale;
                 const scaledWmHeight = wmHeight * finalScaleY * scale;
                 
                 const scaledFontSize = fontSize * scale;
                 const scaledSpacing = spacing * scale;
                 
                 // If repeating, we render a grid. If not, absolute position.
                 return (
                     <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: layerZIndex === 'top' ? 40 : 1 }}>
                         {isRepeated ? (
                             <div style={{
                                 position: 'absolute',
                                 width: '300%',
                                 height: '300%',
                                 left: '-100%',
                                 top: '-100%',
                                 display: 'flex',
                                 flexDirection: 'column',
                                 justifyContent: 'center',
                                 alignItems: 'center',
                                 gap: `${scaledSpacing / 2}px`,
                                 transform: `rotate(${rotation}deg)`,
                                 opacity: opacity,
                                 color: color,
                                 fontSize: `${scaledFontSize}px`,
                                 fontWeight: 'bold',
                             }}>
                                 {Array.from({ length: 15 }).map((_, rowIndex) => (
                                     <div key={rowIndex} style={{
                                         display: 'flex',
                                         gap: `${scaledSpacing}px`,
                                         marginLeft: rowIndex % 2 !== 0 ? `${(watermarkType === 'text' ? scaledFontSize : scaledWmWidth) + scaledSpacing / 2}px` : '0px',
                                         justifyContent: 'center'
                                     }}>
                                         {Array.from({ length: 15 }).map((_, colIndex) => {
                                             return watermarkType === 'image' ? (
                                                 watermarkImageUrl ? (
                                                    <img key={colIndex} src={watermarkImageUrl} alt="wm" style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, objectFit: scaleMode === 'stretch' ? 'fill' : 'contain', flexShrink: 0, maxWidth: 'none', maxHeight: 'none' }} />
                                                 ) : (
                                                    <div key={colIndex} style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, border: '2px dashed #94a3b8', background: 'rgba(241, 245, 249, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, maxWidth: 'none', maxHeight: 'none' }}>
                                                        <span className="text-slate-500 font-bold text-[10px]">Phôi PDF</span>
                                                    </div>
                                                 )
                                             ) : (
                                                 <span key={colIndex} className="whitespace-nowrap" style={{ flexShrink: 0 }}>{watermarkType === 'text' ? dummyText : '[PDF File]'}</span>
                                             )
                                         })}
                                     </div>
                                 ))}
                             </div>
                         ) : (
                             <div style={{
                                 position: 'absolute',
                                 left: positionXMode === 'center' ? '50%' : positionXMode === 'left' ? `${(offsetX / 25.4 * 72) * scale}px` : 'auto',
                                 right: positionXMode === 'right' ? `${(offsetX / 25.4 * 72) * scale}px` : 'auto',
                                 top: positionYMode === 'center' ? '50%' : positionYMode === 'top' ? `${(offsetY / 25.4 * 72) * scale}px` : 'auto',
                                 bottom: positionYMode === 'bottom' ? `${(offsetY / 25.4 * 72) * scale}px` : 'auto',
                                 transform: `translate(${positionXMode === 'center' ? '-50%' : '0'}, ${positionYMode === 'center' ? '-50%' : '0'}) rotate(${rotation}deg)`,
                                 marginLeft: positionXMode === 'center' ? `${(offsetX / 25.4 * 72) * scale}px` : '0',
                                 marginTop: positionYMode === 'center' ? `${(offsetY / 25.4 * 72) * scale}px` : '0',
                                 opacity: opacity,
                                 color: color,
                                 fontSize: `${scaledFontSize}px`,
                                 fontWeight: 'bold',
                             }}>
                                 {watermarkType === 'image' ? (
                                     watermarkImageUrl ? (
                                        <img src={watermarkImageUrl} alt="wm" style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, objectFit: scaleMode === 'stretch' ? 'fill' : 'contain', maxWidth: 'none', maxHeight: 'none' }} />
                                     ) : (
                                        <div style={{ width: `${scaledWmWidth}px`, height: `${scaledWmHeight}px`, border: '2px dashed #94a3b8', background: 'rgba(241, 245, 249, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: 'none', maxHeight: 'none' }}>
                                            <span className="text-slate-500 font-bold text-xs whitespace-nowrap">Phôi PDF</span>
                                        </div>
                                     )
                                 ) : (
                                     <span className="whitespace-nowrap">{watermarkType === 'text' ? dummyText : '[PDF File]'}</span>
                                 )}
                             </div>
                         )}
                     </div>
                 );
             })()}

             {/* VDP Tool Overlay */}
             {vdpFields && vdpFields.length > 0 && pageDim && (() => {
                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 return vdpFields.filter((f: any) => f.pageNum === originalPageNum).map((field: any) => {
                     const x0 = (field.x / 25.4 * 72) * scale;
                     const y0 = (field.y / 25.4 * 72) * scale;
                     const w = (field.width / 25.4 * 72) * scale;
                     const h = (field.height / 25.4 * 72) * scale;
                     const safeSelectedIds = Array.isArray(selectedVdpFieldIds) ? selectedVdpFieldIds : [];
                     const isSelected = safeSelectedIds.includes(field.id);
                     const isInteracting = vdpInteraction && Array.isArray(vdpInteraction.fieldIds) && vdpInteraction.fieldIds.includes(field.id);
                     return (
                         <div
                             key={field.id}
                             className={`absolute group ${isSelected ? 'z-[60]' : 'z-[55] hover:z-[58]'} border-2 ${isSelected ? 'border-solid border-blue-500 bg-blue-500/10' : 'border-dashed border-transparent group-hover:border-slate-400'} ${isVdpMode ? (isInteracting ? 'pointer-events-auto' : 'pointer-events-auto cursor-move') : 'pointer-events-none'}`}
                             style={{
                                 left: x0, top: y0, width: w, height: h
                             }}
                             onDoubleClick={(e) => {
                                 if (field.type === 'text') {
                                     e.stopPropagation();
                                     setEditingTextId(field.id);
                                     setEditTextContent(field.textContent !== undefined ? field.textContent : `{${field.name}}`);
                                 }
                             }}
                             onMouseDown={(e) => e.stopPropagation()}
                             onPointerDown={(e) => {
                                 if (editingTextId === field.id) return;
                                 e.stopPropagation();
                                 let newSelection = [...safeSelectedIds];
                                 
                                 // Handle Group Selection (if this field belongs to a group, select the whole group)
                                 const groupFields = field.groupId ? vdpFields.filter((f: any) => f.groupId === field.groupId).map((f: any) => f.id) : [field.id];
                                 
                                 if (e.shiftKey) {
                                     const allSelected = groupFields.every((id: string) => newSelection.includes(id));
                                     if (allSelected) {
                                         newSelection = newSelection.filter((id: string) => !groupFields.includes(id));
                                     } else {
                                         newSelection = [...new Set([...newSelection, ...groupFields])];
                                     }
                                 } else {
                                     if (!newSelection.includes(field.id)) {
                                         newSelection = groupFields;
                                     }
                                 }
                                 
                                 setSelectedVdpFieldIds(newSelection);
                                 onVdpBoxSelect?.(newSelection);
                                 if (!containerRef.current) return;
                                 const rect = containerRef.current.getBoundingClientRect();
                                 
                                 // Record start positions for ALL selected fields (or group fields if not in current selection)
                                 const fieldsToMove = newSelection.includes(field.id) ? newSelection : groupFields;
                                 
                                 if (e.altKey) {
                                     // DUPLICATE LOGIC
                                     const newGroupId = `group_${Date.now()}`;
                                     const hasMultiple = fieldsToMove.length > 1 || field.groupId;
                                     const newFieldsToMove: string[] = [];
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number}> = {};
                                     
                                     onVdpFieldsChange?.((prev: any[]) => {
                                         const copies: any[] = [];
                                         fieldsToMove.forEach((id: string) => {
                                             const f = prev.find((tf: any) => tf.id === id);
                                             if (!f) return;
                                             
                                             const copyId = `field_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                                             newFieldsToMove.push(copyId);
                                             startFields[copyId] = { x: f.x, y: f.y, w: f.width, h: f.height };
                                             
                                             let newName = f.name;
                                             let newTextContent = f.textContent;
                                             
                                             if (newName) {
                                                 const match = newName.match(/^(.*?)(\d+)$/);
                                                 if (match) {
                                                     const prefix = match[1];
                                                     let maxNum = parseInt(match[2], 10);
                                                     [...prev, ...copies].forEach((pf: any) => {
                                                         if (pf && pf.name && pf.name.startsWith(prefix)) {
                                                             const m = pf.name.match(/^(.*?)(\d+)$/);
                                                             if (m && m[1] === prefix) {
                                                                 maxNum = Math.max(maxNum, parseInt(m[2], 10));
                                                             }
                                                         }
                                                     });
                                                     newName = `${prefix}${maxNum + 1}`;
                                                     if (newTextContent === `{${f.name}}`) {
                                                         newTextContent = `{${newName}}`;
                                                     } else if (newTextContent && newTextContent.includes(`{${f.name}}`)) {
                                                         newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
                                                     }
                                                 } else {
                                                     let maxNum = 0;
                                                     [...prev, ...copies].forEach((pf: any) => {
                                                         if (pf && pf.name && pf.name.startsWith(`${newName}_`)) {
                                                             const m = pf.name.match(/_(\d+)$/);
                                                             if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
                                                         }
                                                     });
                                                     newName = maxNum > 0 ? `${newName}_${maxNum + 1}` : `${newName}_copy`;
                                                     if (newTextContent === `{${f.name}}`) {
                                                         newTextContent = `{${newName}}`;
                                                     } else if (newTextContent && newTextContent.includes(`{${f.name}}`)) {
                                                         newTextContent = newTextContent.replace(new RegExp(`\\{${f.name}\\}`, 'g'), `{${newName}}`);
                                                     }
                                                 }
                                             }

                                             copies.push({
                                                 ...f,
                                                 id: copyId,
                                                 groupId: hasMultiple ? newGroupId : undefined,
                                                 name: newName,
                                                 textContent: newTextContent
                                             });
                                         });
                                         
                                         // Schedule interaction start AFTER state updates
                                         setTimeout(() => {
                                             setSelectedVdpFieldIds(newFieldsToMove);
                                            onVdpBoxSelect?.(newFieldsToMove);
                                             setVdpInteraction({
                                                 type: 'move',
                                                 fieldIds: newFieldsToMove,
                                                 startX: e.clientX - rect.left,
                                                 startY: e.clientY - rect.top,
                                                 startFields
                                             });
                                         }, 0);
                                         
                                         return [...prev, ...copies];
                                     });
                                 } else {
                                     // STANDARD MOVE/RESIZE
                                     const startFields: Record<string, {x: number, y: number, w: number, h: number}> = {};
                                     fieldsToMove.forEach((id: string) => {
                                         const f = vdpFields.find((tf: any) => tf.id === id);
                                         if (f) {
                                             startFields[id] = { x: f.x, y: f.y, w: f.width, h: f.height };
                                         }
                                     });
                                     
                                     setVdpInteraction({
                                         type: 'move',
                                         fieldIds: fieldsToMove,
                                         startX: e.clientX - rect.left,
                                         startY: e.clientY - rect.top,
                                         startFields
                                     });
                                 }
                                 
                                 (e.target as HTMLElement).releasePointerCapture(e.pointerId);
                             }}
                         >
                             <div className={`absolute -top-6 left-0 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded shadow whitespace-nowrap pointer-events-none transition-opacity z-[70] ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                 {field.fieldName || field.name || 'Chưa đặt tên'} ({field.type})
                             </div>
                             
                             {/* Visual Placeholders */}
                             <div className={`absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden ${(field.type === 'qrcode' || field.type === 'barcode') ? 'opacity-100' : 'mix-blend-multiply ' + (field.type === 'image' ? 'opacity-50' : 'opacity-80')} ${field.type === 'text' ? 'p-1' : ''}`}>
                                 {(field.type === 'qrcode' || field.type === 'barcode') && (
                                     <VdpPreviewImage field={field} />
                                 )}
                                 {field.type === 'image' && (
                                     <div 
                                         className="w-full h-full flex items-center justify-center bg-slate-300 dark:bg-zinc-700/80"
                                         style={{
                                             borderRadius: field.imageShape === 'circle' ? '50%' : field.imageShape === 'rounded' ? '16px' : '0',
                                             clipPath: field.imageShape === 'polygon' ? 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' : field.imageShape === 'star' ? 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' : 'none'
                                         }}
                                     >
                                         <svg className="w-full h-full max-w-[50%] max-h-[50%] text-slate-500 opacity-75" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                         </svg>
                                     </div>
                                 )}
                                 {field.type === 'text' && (
                                     editingTextId === field.id ? (
                                         <textarea
                                             autoFocus
                                             value={editTextContent}
                                             onChange={(e) => setEditTextContent(e.target.value)}
                                             onBlur={() => {
                                                 onVdpFieldsChange?.(vdpFields.map((f: any) => f.id === field.id ? { ...f, textContent: editTextContent } : f));
                                                 setEditingTextId(null);
                                             }}
                                             onKeyDown={(e) => {
                                                 if (e.key === 'Enter') {
                                                     if (e.shiftKey) {
                                                         // Allow new line
                                                         return;
                                                     }
                                                     e.preventDefault();
                                                     e.currentTarget.blur();
                                                 }
                                             }}
                                             className="w-full h-full bg-transparent border-none outline-none px-1 resize-none overflow-hidden"
                                             style={{ 
                                                 color: field.fontColor || '#1e293b', 
                                                 fontSize: `${(field.fontSize || 10) * scale}px`,
                                                 fontFamily: field.fontName === 'Helvetica' ? 'Arial, sans-serif' : field.fontName === 'Times-Roman' ? '"Times New Roman", serif' : field.fontName === 'Courier' ? 'Courier, monospace' : (field.fontFile ? `"${field.fontName}_local", sans-serif` : (field.fontName ? `"${field.fontName}", sans-serif` : 'inherit')),
                                                 fontWeight: field.fontStyle === 'bold' || field.fontStyle === 'bolditalic' ? 'bold' : 'normal',
                                                 fontStyle: field.fontStyle === 'italic' || field.fontStyle === 'bolditalic' ? 'italic' : 'normal',
                                                 lineHeight: field.lineHeight ? `${field.lineHeight}em` : 1,
                                                 letterSpacing: field.characterSpacing ? `${field.characterSpacing}pt` : 0,
                                                 pointerEvents: 'auto' 
                                             }}
                                             onPointerDown={(e) => e.stopPropagation()}
                                         />
                                     ) : (
                                         <VdpAutoFitText
                                             field={field}
                                             scale={scale}
                                             text={field.textContent !== undefined ? field.textContent : `{${field.name}}`}
                                             onAutoFit={(pt: number) => {
                                                 const rounded = Math.round(pt * 10) / 10;
                                                 if (onVdpFieldsChange && Math.abs((field.fontSize || 10) - rounded) > 0.2) {
                                                     onVdpFieldsChange((prev: any[]) => prev.map((f: any) => f.id === field.id ? { ...f, fontSize: rounded } : f));
                                                 }
                                             }}
                                         />
                                     )
                                 )}
                             </div>
                             
                             {/* Resize Handles (4 góc) */}
                             {isSelected && (['nw','ne','sw','se'] as const).map((handle) => {
                                 const posCls = handle === 'nw' ? '-left-1.5 -top-1.5 cursor-nw-resize'
                                     : handle === 'ne' ? '-right-1.5 -top-1.5 cursor-ne-resize'
                                     : handle === 'sw' ? '-left-1.5 -bottom-1.5 cursor-sw-resize'
                                     : '-right-1.5 -bottom-1.5 cursor-se-resize';
                                 return (
                                     <div
                                         key={handle}
                                         className={`absolute ${posCls} w-3 h-3 bg-white border-2 border-blue-500 rounded-full shadow-sm hover:scale-150 transition-transform z-[65]`}
                                         onPointerDown={(e) => {
                                             e.stopPropagation();
                                             if (!containerRef.current) return;
                                             const rect = containerRef.current.getBoundingClientRect();
                                             setVdpInteraction({
                                                 type: 'resize',
                                                 handle,
                                                 fieldIds: [field.id],
                                                 startX: e.clientX - rect.left,
                                                 startY: e.clientY - rect.top,
                                                 startFields: {
                                                     [field.id]: { x: field.x, y: field.y, w: field.width, h: field.height }
                                                 }
                                             });
                                             (e.target as HTMLElement).releasePointerCapture(e.pointerId);
                                         }}
                                     />
                                 );
                             })}
                         </div>
                     );
                 });
             })()}



             {/* Preview Stick Text & Numbers Tool */}
             {stickPreviewParams && pageDim && (() => {
                 const { fields, margins, startNumber, increment, padLength, fontName, fontSize, fontColor, rotation, targetType, rangeStart, rangeEnd } = stickPreviewParams;
                 
                 // Check if page should be processed
                 let process = false;
                 if (targetType === 'all') process = true;
                 else if (targetType === 'even') process = originalPageNum % 2 === 0;
                 else if (targetType === 'odd') process = originalPageNum % 2 === 1;
                 else if (targetType === 'range') process = originalPageNum >= rangeStart && originalPageNum <= rangeEnd;
                 
                 if (!process) return null;

                 // Calculate number
                 let currentNumber = startNumber;
                 if (targetType === 'all') {
                     currentNumber += (originalPageNum - 1) * increment;
                 } else {
                     let processedCount = 0;
                     for (let i = 1; i < originalPageNum; i++) {
                         if (targetType === 'even' && i % 2 === 0) processedCount++;
                         else if (targetType === 'odd' && i % 2 === 1) processedCount++;
                         else if (targetType === 'range' && i >= rangeStart && i <= rangeEnd) processedCount++;
                     }
                     currentNumber += processedCount * increment;
                 }

                 const numStr = String(currentNumber).padStart(padLength, '0');
                 const todayStr = new Date().toLocaleDateString('vi-VN');

                 const pageWidthPt = pageDim.w;
                 const scale = displayWidth / pageWidthPt;
                 const MM_TO_PT = 2.83465;

                 const fieldList = [
                     { id: 'topLeft', content: fields?.topLeft, top: margins?.top, bottom: null, left: margins?.left, right: null, align: 'flex-start', valalign: 'flex-start' },
                     { id: 'topCenter', content: fields?.topCenter, top: margins?.top, bottom: null, left: 0, right: 0, align: 'center', valalign: 'flex-start' },
                     { id: 'topRight', content: fields?.topRight, top: margins?.top, bottom: null, left: null, right: margins?.right, align: 'flex-end', valalign: 'flex-start' },
                     { id: 'bottomLeft', content: fields?.bottomLeft, top: null, bottom: margins?.bottom, left: margins?.left, right: null, align: 'flex-start', valalign: 'flex-end' },
                     { id: 'bottomCenter', content: fields?.bottomCenter, top: null, bottom: margins?.bottom, left: 0, right: 0, align: 'center', valalign: 'flex-end' },
                     { id: 'bottomRight', content: fields?.bottomRight, top: null, bottom: margins?.bottom, left: null, right: margins?.right, align: 'flex-end', valalign: 'flex-end' }
                 ];

                 return fieldList.map(f => {
                     if (!f.content) return null;
                     const drawString = f.content.replace(/\[page\]/gi, numStr).replace(/\[date\]/gi, todayStr);
                     if (!drawString) return null;

                     let posStyles: any = { position: 'absolute' };
                     
                     if (f.left !== null && f.right !== null) {
                         posStyles.left = 0;
                         posStyles.width = '100%';
                     } else if (f.left !== null) {
                         posStyles.left = f.left * MM_TO_PT * scale;
                     } else if (f.right !== null) {
                         posStyles.right = f.right * MM_TO_PT * scale;
                     }

                     if (f.top !== null) posStyles.top = f.top * MM_TO_PT * scale;
                     if (f.bottom !== null) posStyles.bottom = f.bottom * MM_TO_PT * scale;

                     posStyles.justifyContent = f.align;
                     posStyles.alignItems = f.valalign;

                     return (
                         <div key={f.id} className="absolute inset-0 pointer-events-none z-[45] flex" style={posStyles}>
                             <div style={{
                                 color: fontColor,
                                 fontSize: `${fontSize * scale}px`,
                                 fontFamily: fontName === 'Times-Roman' ? '"Times New Roman", serif' : fontName === 'Courier' ? 'Courier, monospace' : '"Helvetica Neue", Helvetica, Arial, sans-serif',
                                 transform: `rotate(${rotation}deg)`,
                                 transformOrigin: 'center center',
                                 lineHeight: 1,
                                 whiteSpace: 'nowrap',
                                 textShadow: '0 0 2px rgba(255,255,255,0.8)'
                             }}>
                                 {drawString}
                             </div>
                         </div>
                     );
                 });
             })()}

             {/* Marquee Drag Box — always in DOM, visibility controlled by ref */}
             {isSelectionMode && (
                 <div 
                     ref={marqueeRef}
                     className="absolute border-2 border-blue-500 bg-blue-400/15 z-40 pointer-events-none"
                     style={{ display: 'none' }}
                 />
             )}
            </div>
        </div>

        {/* Dimension Overlay — positioned OUTSIDE the page frame */}
        {detectedDimension && (
            <>
                {/* Width Arrow (Below page) */}
                <div className="flex items-center justify-center gap-2 text-blue-500 mt-1.5 pointer-events-none">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                    </svg>
                    <span className="text-xs font-bold whitespace-nowrap bg-white/90 dark:bg-zinc-800/90 px-2 py-0.5 rounded-md shadow-sm border border-blue-200 dark:border-blue-800">
                        W: {(detectedDimension.w * 0.352778).toFixed(1)} mm
                    </span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                </div>
                {/* Height Arrow (Right of page — absolute positioned) */}
                <div className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 text-blue-500 pointer-events-none"
                     style={{ left: '100%', marginLeft: 8 }}>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                    <span className="text-xs font-bold whitespace-nowrap bg-white/90 dark:bg-zinc-800/90 px-2 py-0.5 rounded-md shadow-sm border border-blue-200 dark:border-blue-800"
                          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                        H: {(detectedDimension.h * 0.352778).toFixed(1)} mm
                    </span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                    </svg>
                </div>
            </>
        )}
        </div>
        </>
    );
    //#endregion
};