import React, { useState, useRef, useCallback } from 'react';
import { getApiUrl } from '../../lib/api';
import BgRemoverOptions, { BgRemoverOptionsState } from './BgRemoverOptions';
import { useBgRemoverStore, defaultTabState, type BatchItem } from './useBgRemoverStore';

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
    tabId: string;
    pdfFile: File | null;
}

// ─── Helper: Add files ──────────────────────────────────────────────────────
async function normalizeAndAddFiles(files: File[], tabId: string) {
    const store = useBgRemoverStore.getState();
    store.initTab(tabId);
    const newItems: BatchItem[] = [];
    for (const file of files) {
        const isImage = file.type.startsWith('image/') || file.name.match(/\.(jpg|jpeg|png|webp|gif|tiff?|bmp)$/i);
        if (!isImage) continue;
        const path = (file as any).path || '';
        let url = '';
        let fileObj = file;
        if (path && (window as any).__TAURI_INTERNALS__) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const uint8Arr: Uint8Array = await invoke('normalize_image_to_png', { filePath: path });
                const blob = new Blob([uint8Arr as any], { type: 'image/png' });
                url = URL.createObjectURL(blob);
                fileObj = new File([blob], file.name.replace(/\.[^/.]+$/, '.png'), { type: 'image/png' });
                Object.defineProperty(fileObj, 'path', { value: path });
            } catch (e) {
                console.error('Rust normalize failed:', e);
                url = URL.createObjectURL(file);
            }
        } else {
            url = URL.createObjectURL(file);
        }
        newItems.push({
            id: Math.random().toString(36).substring(7),
            path: path || 'browser-file',
            fileName: file.name,
            originalUrl: url,
            status: 'pending',
            fileObj,
        });
    }
    if (newItems.length > 0) store.addItems(tabId, newItems);
}

// ─── Helper: File picker ────────────────────────────────────────────────────
async function openFilePicker(tabId: string) {
    if ((window as any).__TAURI_INTERNALS__) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
            multiple: true,
            title: 'Chọn ảnh (Có thể chọn nhiều)',
            filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp'] }],
        });
        if (selected && Array.isArray(selected)) {
            const files = selected.map(path => {
                const name = path.split('\\').pop()?.split('/').pop() || 'image.png';
                const f = new File([], name);
                Object.defineProperty(f, 'path', { value: path });
                return f;
            });
            normalizeAndAddFiles(files, tabId);
        }
    } else {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
        input.onchange = () => { if (input.files) normalizeAndAddFiles(Array.from(input.files), tabId); };
        input.click();
    }
}

// ─── Helper: Process batch ──────────────────────────────────────────────────
async function processBatch(tabId: string) {
    const store = useBgRemoverStore.getState();
    const tabState = store.getTab(tabId);
    const { options, batchItems } = tabState;
    store.setIsProcessing(tabId, true);
    const items = [...batchItems];
    let processed = 0;
    const apiUrl = getApiUrl();
    // console.log('[BgRemover] Starting batch, API URL:', apiUrl, 'Items:', items.length);
    for (let i = 0; i < items.length; i++) {
        if (items[i].status === 'success') continue;
        processed++;
        store.setProgress(tabId, `Đang tách nền ${processed} / ${items.length}...`);
        items[i] = { ...items[i], status: 'processing', error: undefined };
        store.setBatchItems(tabId, [...items]);
        try {
            const formData = new FormData();
            const item = items[i];
            // Always send file content if available (normalized PNG)
            if (item.fileObj && item.fileObj.size > 0) {
                // console.log(`[BgRemover] Sending file content: ${item.fileName} (${item.fileObj.size} bytes)`);
                formData.append('file', item.fileObj, item.fileName);
            } else if (item.path && item.path !== 'browser-file') {
                // console.log(`[BgRemover] Sending file_path: ${item.path}`);
                formData.append('file_path', item.path);
            } else {
                throw new Error('Không tìm thấy file gốc');
            }
            formData.append('engine', options.aiEngine || 'general');
            formData.append('edge_shift', options.edgeShift.toString());
            formData.append('bg_color', options.bgColor);
            formData.append('custom_hex', options.customHex);
            formData.append('auto_crop', options.autoCrop ? 'true' : 'false');
            // console.log(`[BgRemover] Fetching: ${apiUrl}/pdf-tools/remove-background`);
            const res = await fetch(`${apiUrl}/pdf-tools/remove-background`, { method: 'POST', body: formData });
            // console.log(`[BgRemover] Response status: ${res.status}, type: ${res.headers.get('content-type')}`);
            if (!res.ok) {
                const errorText = await res.text();
                console.error('[BgRemover] Server error:', errorText);
                throw new Error(`Lỗi Server (${res.status}): ${errorText}`);
            }
            const outBlob = await res.blob();
            // console.log(`[BgRemover] Result blob: ${outBlob.size} bytes, type: ${outBlob.type}`);
            const outUrl = URL.createObjectURL(outBlob);
            items[i] = { ...items[i], status: 'success', resultBlob: outBlob, resultUrl: outUrl };
        } catch (e: any) {
            console.error('[BgRemover] Error:', e);
            items[i] = { ...items[i], status: 'error', error: e.message };
        }
        store.setBatchItems(tabId, [...items]);
    }
    store.setProgress(tabId, '');
    store.setIsProcessing(tabId, false);
}

// ─── Helper: Save batch ─────────────────────────────────────────────────────
async function saveBatch(tabId: string) {
    const items = useBgRemoverStore.getState().getTab(tabId).batchItems.filter(i => i.status === 'success' && i.resultBlob);
    if (items.length === 0) return;
    try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        const { join } = await import('@tauri-apps/api/path');
        const dir = await open({ directory: true, multiple: false, title: 'Chọn thư mục lưu ảnh' });
        if (!dir || typeof dir !== 'string') return;
        let saved = 0;
        for (const item of items) {
            const outName = `nobg_${item.fileName.replace(/\.[^/.]+$/, '')}.png`;
            const outPath = await join(dir, outName);
            await writeFile(outPath, new Uint8Array(await item.resultBlob!.arrayBuffer()));
            saved++;
        }
        alert(`✅ Đã lưu thành công ${saved} ảnh!`);
    } catch (e) { console.error(e); alert('Lỗi khi lưu file.'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR — Rendered in the right settings panel
// ═══════════════════════════════════════════════════════════════════════════════

export default function BgRemoverTool({ tabId, pdfFile }: Props) {
    const tabState = useBgRemoverStore(state => state.tabs[tabId] || defaultTabState);
    const storeActions = useBgRemoverStore.getState();
    const { batchItems, selectedId, options, isProcessing, progress, error } = tabState;

    // console.log(`[BgRemoverTool] render tabId="${tabId}", batchItems=${batchItems.length}`);

    const hasPending = batchItems.some(i => i.status === 'pending' || i.status === 'error');
    const hasSuccess = batchItems.some(i => i.status === 'success');

    // Auto-add pdfFile
    const addedRef = useRef<Set<string>>(new Set());
    React.useEffect(() => {
        const currentStore = useBgRemoverStore.getState();
        currentStore.initTab(tabId);
        if (!pdfFile) {
            // console.log('[BgRemover] Auto-add: pdfFile is null');
            return;
        }
        const isImage = pdfFile.type.startsWith('image/') || pdfFile.name.match(/\.(jpg|jpeg|png|webp|gif|tiff?|bmp)$/i);
        // console.log('[BgRemover] Auto-add: checking pdfFile', pdfFile.name, 'isImage:', !!isImage);
        if (!isImage) return;
        const key = ((pdfFile as any).path || '') + '|' + pdfFile.name + '|' + pdfFile.size;
        if (addedRef.current.has(key)) {
            // console.log('[BgRemover] Auto-add: already added', key);
            return;
        }
        addedRef.current.add(key);
        // console.log('[BgRemover] Auto-add: calling normalizeAndAddFiles');
        normalizeAndAddFiles([pdfFile], tabId);
    }, [pdfFile, tabId]);

    // Global flag
    React.useEffect(() => {
        (window as any).__isBgRemoverActive = true;
        return () => { (window as any).__isBgRemoverActive = false; };
    }, []);

    // Listen for external file events
    React.useEffect(() => {
        const handleAdd = (e: Event) => {
            const files = (e as CustomEvent).detail?.files as File[];
            if (files?.length) normalizeAndAddFiles(files, tabId);
        };
        const handleTrigger = () => openFilePicker(tabId);
        window.addEventListener('prynx-bgremover-add-files', handleAdd);
        window.addEventListener('prynx-bgremover-trigger-select', handleTrigger);
        return () => {
            window.removeEventListener('prynx-bgremover-add-files', handleAdd);
            window.removeEventListener('prynx-bgremover-trigger-select', handleTrigger);
        };
    }, [tabId]);

    // Removed reset store on unmount to keep state when switching tools


    return (
        <div className="flex flex-col gap-3 animate-in fade-in duration-300">
            {/* Batch Thumbnails */}
            {batchItems.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin flex-wrap">
                    {batchItems.map(item => (
                        <div key={item.id} onClick={() => storeActions.setSelectedId(tabId, item.id)}
                            className={`relative shrink-0 w-14 h-14 rounded-lg overflow-hidden cursor-pointer border-2 transition-all ${
                                selectedId === item.id ? 'border-indigo-500 ring-2 ring-indigo-300'
                                : 'border-slate-200 dark:border-zinc-700 hover:border-slate-400'}`}>
                            <img src={item.resultUrl || item.originalUrl} alt={item.fileName}
                                className="w-full h-full object-cover" draggable={false} />
                            <div className={`absolute bottom-0 left-0 right-0 text-center text-[8px] font-bold py-[1px] ${
                                item.status === 'success' ? 'bg-emerald-500 text-white'
                                : item.status === 'processing' ? 'bg-amber-500 text-white'
                                : item.status === 'error' ? 'bg-red-500 text-white'
                                : 'bg-slate-400/80 text-white'}`}>
                                {item.status === 'success' ? '✓' : item.status === 'processing' ? '⏳' : item.status === 'error' ? '✗' : '•'}
                            </div>
                            <button onClick={e => { e.stopPropagation(); storeActions.removeItem(tabId, item.id); }}
                                className="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white text-[8px] rounded-bl flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">×</button>
                        </div>
                    ))}
                    <div onClick={() => openFilePicker(tabId)}
                        className="shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-slate-300 dark:border-zinc-600 flex items-center justify-center cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
                        <span className="text-lg text-slate-400">+</span>
                    </div>
                </div>
            )}

            <BgRemoverOptions options={options} onChange={(opts) => storeActions.setOptions(tabId, opts)} />

            <div className="flex flex-col gap-2">
                <button onClick={() => processBatch(tabId)} disabled={isProcessing || !hasPending}
                    className={`w-full h-11 rounded-xl text-[13px] font-bold transition-all flex items-center justify-center gap-2 shadow-sm ${
                        isProcessing || !hasPending
                        ? 'bg-slate-300 text-slate-500 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-400'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                    {isProcessing ? '⏳ Đang xử lý...' : '🚀 Bắt Đầu Tách Nền'}
                </button>
                {hasSuccess && (
                    <div className="flex gap-2">
                        <button onClick={() => saveBatch(tabId)}
                            className="flex-1 h-11 rounded-xl text-[13px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm flex items-center justify-center gap-2 transition-all">
                            💾 Lưu tất cả ({batchItems.filter(i => i.status === 'success').length})
                        </button>
                        {batchItems.find(i => i.id === selectedId)?.status === 'success' && (
                            <button onClick={() => selectedId && storeActions.undoItem(tabId, selectedId)} title="Hoàn tác để chỉnh sửa lại"
                                className="px-4 h-11 rounded-xl text-[13px] font-bold bg-amber-500 hover:bg-amber-600 text-white shadow-sm flex items-center justify-center transition-all">
                                ↺ Hoàn tác
                            </button>
                        )}
                    </div>
                )}
            </div>

            {progress && (
                <div className="flex items-center gap-3 bg-indigo-50 dark:bg-indigo-900/20 p-3 rounded-lg border border-indigo-200 dark:border-indigo-800/50">
                    <div className="w-5 h-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-indigo-700 dark:text-indigo-300 font-medium">{progress}</span>
                </div>
            )}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
        </div>
    );
}


// ═══════════════════════════════════════════════════════════════════════════════
// PREVIEW — Rendered in the MAIN content area (replaces AcrobatViewer)
// ═══════════════════════════════════════════════════════════════════════════════

const checkerboardStyle: React.CSSProperties = {
    backgroundImage: `
        linear-gradient(45deg, #d1d5db 25%, transparent 25%),
        linear-gradient(-45deg, #d1d5db 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #d1d5db 75%),
        linear-gradient(-45deg, transparent 75%, #d1d5db 75%)
    `,
    backgroundSize: '20px 20px',
    backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
};

export function BgRemoverPreview({ tabId }: { tabId: string }) {
    const tabState = useBgRemoverStore(state => state.tabs[tabId] || defaultTabState);
    const { batchItems, selectedId, isProcessing } = tabState;
    // console.log(`[BgRemoverPreview] render tabId="${tabId}", batchItems=${batchItems.length}`);
    const [sliderPos, setSliderPos] = useState(50);
    const [isSliderDragging, setIsSliderDragging] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
    const containerRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const spaceHeld = useRef(false);

    const selectedItem = batchItems.find(i => i.id === selectedId) || batchItems[0] || null;
    const hasResult = !!(selectedItem?.resultUrl);

    // Reset on image change
    React.useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setSliderPos(50); }, [selectedId]);

    // Track Space key for hand-tool panning
    React.useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat) { spaceHeld.current = true; e.preventDefault(); } };
        const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeld.current = false; };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
    }, []);

    // Slider drag
    const handleSliderMove = useCallback((clientX: number) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
        setSliderPos((x / rect.width) * 100);
    }, []);

    React.useEffect(() => {
        if (!isSliderDragging) return;
        const onMove = (e: MouseEvent) => handleSliderMove(e.clientX);
        const onUp = () => setIsSliderDragging(false);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [isSliderDragging, handleSliderMove]);

    // Pan drag
    React.useEffect(() => {
        if (!isPanning) return;
        const onMove = (e: MouseEvent) => {
            setPan({
                x: panStart.current.panX + (e.clientX - panStart.current.x),
                y: panStart.current.panY + (e.clientY - panStart.current.y),
            });
        };
        const onUp = () => setIsPanning(false);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    }, [isPanning]);

    // Zoom with wheel
    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.stopPropagation();
        setZoom(prev => Math.max(0.2, Math.min(10, prev * (e.deltaY < 0 ? 1.15 : 0.87))));
    }, []);

    // Space+click, Middle-click, or Ctrl+click to pan
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button === 1 || (e.button === 0 && (e.ctrlKey || spaceHeld.current))) {
            e.preventDefault();
            setIsPanning(true);
            panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        }
    }, [pan]);

    // Double-click to reset zoom
    const handleDoubleClick = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        normalizeAndAddFiles(Array.from(e.dataTransfer.files), tabId);
    };

    const imgTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    const imgClass = "max-w-[90vw] max-h-[85vh] pointer-events-none";
    const imgTransition = isPanning ? 'none' : 'transform 0.1s ease-out';

    return (
        <div
            ref={containerRef}
            className={`w-full h-full flex flex-col items-center justify-center relative select-none transition-colors overflow-hidden ${
                isDragOver ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'bg-slate-100 dark:bg-[#1e2028]'
            }`}
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
        >
            {/* Empty state */}
            {!selectedItem && (
                <div className="flex flex-col items-center justify-center cursor-pointer p-12 max-w-lg text-center"
                    onClick={() => openFilePicker(tabId)}>
                    <div className="w-28 h-28 rounded-3xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-6xl mb-6 shadow-lg">✨</div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-white mb-3">Tách nền AI</h2>
                    <p className="text-slate-500 dark:text-zinc-400 text-[14px] leading-relaxed">
                        Kéo thả ảnh vào đây hoặc bấm để chọn file.<br/>Hỗ trợ JPG, PNG, TIFF, WebP, BMP.
                    </p>
                </div>
            )}

            {/* Image Rendering */}
            {selectedItem && (
                <div className="relative w-full h-full flex items-center justify-center overflow-hidden" style={hasResult ? checkerboardStyle : undefined}>
                    
                    {/* If hasResult -> Show Slider */}
                    {hasResult ? (
                        <>
                            {/* Result layer (full, below) */}
                            <div style={{ transform: imgTransform, transition: imgTransition, transformOrigin: 'center center' }}>
                                <img src={selectedItem.resultUrl!} alt="Đã tách nền" className={imgClass} draggable={false} />
                            </div>

                            {/* Original layer (clipped from the right side of slider) */}
                            <div className="absolute inset-0 flex items-center justify-center overflow-hidden"
                                style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}>
                                <div style={{ transform: imgTransform, transition: imgTransition, transformOrigin: 'center center' }}>
                                    <img src={selectedItem.originalUrl} alt="Ảnh gốc" className={imgClass} draggable={false} />
                                </div>
                            </div>

                            {/* Slider handle */}
                            <div className="absolute top-0 bottom-0 z-20 cursor-ew-resize"
                                style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)', width: 40 }}
                                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setIsSliderDragging(true); }}>
                                <div className="absolute inset-y-0 left-1/2 w-[3px] bg-white/90 shadow-[0_0_12px_rgba(0,0,0,0.4)]" style={{ transform: 'translateX(-50%)' }} />
                                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white shadow-xl border-2 border-indigo-500 flex items-center justify-center text-indigo-600 font-bold text-lg select-none cursor-ew-resize">
                                    ↔
                                </div>
                            </div>

                            {/* Labels */}
                            <span className="absolute top-4 left-4 text-[11px] font-bold bg-indigo-600/80 text-white px-3 py-1.5 rounded-full backdrop-blur-sm z-10">✨ ĐÃ TÁCH NỀN</span>
                            <span className="absolute top-4 right-4 text-[11px] font-bold bg-black/60 text-white px-3 py-1.5 rounded-full backdrop-blur-sm z-10">👁 ẢNH GỐC</span>
                        </>
                    ) : (
                        /* Standard Single Image (No Result yet) */
                        <div style={{ transform: imgTransform, transition: imgTransition, transformOrigin: 'center center', position: 'relative' }}>
                            <img ref={imageRef} src={selectedItem.originalUrl} alt="Preview" className={imgClass} draggable={false} 
                                style={{ cursor: 'default' }} />
                                
                            {/* Error Overlay */}
                            {selectedItem.error && (
                                <div className="absolute bottom-16 left-1/2 -translate-x-1/2 bg-red-600/90 backdrop-blur-sm text-white px-4 py-2 rounded-full z-30 shadow-lg border border-red-400">
                                    <span className="text-[12px] font-bold">❌ {selectedItem.error}</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Processing overlay (Full screen for batch processing) */}
            {isProcessing && (
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex flex-col items-center justify-center z-30">
                    <div className="w-12 h-12 rounded-full border-4 border-white/30 border-t-white animate-spin mb-4" />
                    <p className="text-white font-bold text-sm">Đang tách nền...</p>
                </div>
            )}

            {/* Zoom indicator */}
            {zoom !== 1 && (
                <span className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-sm text-white text-[11px] font-mono px-3 py-1 rounded-full z-10">
                    {Math.round(zoom * 100)}%
                </span>
            )}

            {/* File name */}
            {selectedItem && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-sm text-white text-[11px] font-medium px-4 py-1.5 rounded-lg z-10 max-w-[80%] truncate">
                    {selectedItem.fileName}
                    {selectedItem.status === 'error' && <span className="text-red-300 ml-2">— {selectedItem.error}</span>}
                </div>
            )}
        </div>
    );
}

