import React, { useState, useRef, useCallback } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ImageBatchStore } from './store';
import { normalizeAndAddFiles, openFilePicker } from './helpers';
import { useTranslation } from 'react-i18next';

// Preview dùng chung cho các công cụ batch ảnh (tách nền, upscale). Toàn bộ
// zoom (lăn chuột), pan (Space/Ctrl/chuột-giữa + kéo), double-click reset, và
// thanh trượt so sánh trước/sau — giống hệt nhau, chỉ khác nhãn hiển thị.

type BatchStore<O> = UseBoundStore<StoreApi<ImageBatchStore<O>>>;

export interface PreviewLabels {
    resultBadge: string;
    originalBadge: string;
    emptyTitle: string;
    emptyHint: React.ReactNode;
    emptyIcon: string;
    processingText: string;
}

interface Props<O> {
    tabId: string;
    store: BatchStore<O>;
    labels: PreviewLabels;
}

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

export function ImageBatchPreview<O>({ tabId, store, labels }: Props<O>) {
  const { t } = useTranslation();
    const tabState = store(state => state.tabs[tabId]);
    const batchItems = tabState?.batchItems ?? [];
    const selectedId = tabState?.selectedId ?? null;
    const isProcessing = tabState?.isProcessing ?? false;

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
        normalizeAndAddFiles(Array.from(e.dataTransfer.files), tabId, store);
    };

    const imgTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    const imgClass = "max-w-[90vw] max-h-[85vh] pointer-events-none";
    const imgTransition = isPanning ? 'none' : 'transform 0.1s ease-out';

    return (
        <div
            ref={containerRef}
            className={`w-full h-full flex flex-col items-center justify-center relative select-none transition-colors overflow-hidden ${
                isDragOver ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'bg-slate-100 dark:bg-[#1e1e1e]'
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
                    onClick={() => openFilePicker(tabId, store)}>
                    <div className="w-28 h-28 rounded-3xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-6xl mb-6 shadow-lg">{labels.emptyIcon}</div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-white mb-3">{labels.emptyTitle}</h2>
                    <p className="text-slate-500 dark:text-zinc-400 text-[14px] leading-relaxed">
                        {labels.emptyHint}
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
                                <img src={selectedItem.resultUrl!} alt={t('preprocess.imageBatchPreview:ket_qua')} className={imgClass} draggable={false} />
                            </div>

                            {/* Original layer (clipped from the right side of slider) */}
                            <div className="absolute inset-0 flex items-center justify-center overflow-hidden"
                                style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}>
                                <div style={{ transform: imgTransform, transition: imgTransition, transformOrigin: 'center center' }}>
                                    <img src={selectedItem.originalUrl} alt={t('preprocess.imageBatchPreview:anh_goc')} className={imgClass} draggable={false} />
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
                            <span className="absolute top-4 left-4 text-[11px] font-bold bg-indigo-600/80 text-white px-3 py-1.5 rounded-full backdrop-blur-sm z-10">{labels.resultBadge}</span>
                            <span className="absolute top-4 right-4 text-[11px] font-bold bg-black/60 text-white px-3 py-1.5 rounded-full backdrop-blur-sm z-10">{labels.originalBadge}</span>
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
                    <p className="text-white font-bold text-sm">{labels.processingText}</p>
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
