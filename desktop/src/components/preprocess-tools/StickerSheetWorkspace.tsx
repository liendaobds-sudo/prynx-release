import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Hand, Pencil } from 'lucide-react';

import { tv } from '../../i18n';
import {
    decodeLabelRgb,
    type StickerMaskWorkerResponse,
} from '../../workers/stickerMaskProtocol';
import { useStickerSheetStore, type NormalizedMaskPoint } from './stickerSheetStore';


interface Props {
    tabId: string;
    isActive: boolean;
}

async function loadImageData(url: string, width: number, height: number): Promise<ImageData> {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Không khởi tạo được Canvas mask.');
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
}

function normalizedPoint(event: ReactPointerEvent<HTMLCanvasElement>): NormalizedMaskPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
}

export default function StickerSheetWorkspace({ tabId, isActive }: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const state = tab || useStickerSheetStore.getState().getTab(tabId);
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const panLayerRef = useRef<HTMLDivElement>(null);
    const zoomLayerRef = useRef<HTMLDivElement>(null);
    const workerRef = useRef<Worker | null>(null);
    const workerReadyRef = useRef(false);
    const labelIdsRef = useRef<Uint32Array | null>(null);
    const requestRef = useRef(0);
    const renderedRequestRef = useRef(0);
    const pointsRef = useRef<NormalizedMaskPoint[]>([]);
    const drawingRef = useRef(false);
    const mergeSourceRef = useRef<number | null>(null);
    const editsRef = useRef(state.edits);
    const selectedRef = useRef(state.selectedInstanceId);
    const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
    const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
    const frameRef = useRef<number | null>(null);
    const panningRef = useRef(false);
    const spaceHeldRef = useRef(false);
    const [zoom, setZoom] = useState(1);
    const [interactionMode, setInteractionMode] = useState<'edit' | 'pan'>('edit');
    const [isPanning, setIsPanning] = useState(false);
    const [isSpaceHeld, setIsSpaceHeld] = useState(false);

    editsRef.current = state.edits;
    selectedRef.current = state.selectedInstanceId;

    const applyViewTransform = useCallback(() => {
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            const view = viewRef.current;
            if (panLayerRef.current) {
                panLayerRef.current.style.transform = `translate3d(${view.panX}px, ${view.panY}px, 0)`;
            }
            if (zoomLayerRef.current) {
                zoomLayerRef.current.style.transform = `scale(${view.zoom})`;
            }
        });
    }, []);

    const resetView = useCallback(() => {
        viewRef.current = { zoom: 1, panX: 0, panY: 0 };
        setZoom(1);
        applyViewTransform();
    }, [applyViewTransform]);

    const updateZoom = useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
        const view = viewRef.current;
        const clamped = Math.max(0.25, Math.min(8, nextZoom));
        if (Math.abs(clamped - view.zoom) < 1e-6) return;
        const rect = workspaceRef.current?.getBoundingClientRect();
        if (rect && clientX !== undefined && clientY !== undefined) {
            const cursorX = clientX - (rect.left + rect.width / 2);
            const cursorY = clientY - (rect.top + rect.height / 2);
            const worldX = (cursorX - view.panX) / view.zoom;
            const worldY = (cursorY - view.panY) / view.zoom;
            view.panX = cursorX - worldX * clamped;
            view.panY = cursorY - worldY * clamped;
        }
        view.zoom = clamped;
        setZoom(clamped);
        applyViewTransform();
    }, [applyViewTransform]);

    useEffect(() => () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    }, []);

    useEffect(() => {
        resetView();
    }, [resetView, state.manifest?.session_id]);

    const requestRender = useCallback(() => {
        if (!workerReadyRef.current || !workerRef.current) return;
        const requestId = ++requestRef.current;
        workerRef.current.postMessage({
            type: 'render',
            requestId,
            edits: editsRef.current,
            selectedInstanceId: selectedRef.current,
        });
    }, []);

    useEffect(() => {
        if (
            state.status !== 'ready'
            || !state.manifest
            || !state.labelsUrl
            || !state.uncertaintyUrl
        ) return;
        let cancelled = false;
        const worker = new Worker(
            new URL('../../workers/stickerMask.worker.ts', import.meta.url),
            { type: 'module' },
        );
        workerRef.current = worker;
        workerReadyRef.current = false;
        const width = state.manifest.preview_width_px;
        const height = state.manifest.preview_height_px;

        worker.onmessage = (event: MessageEvent<StickerMaskWorkerResponse>) => {
            if (cancelled) return;
            const message = event.data;
            if (message.type === 'ready') {
                workerReadyRef.current = true;
                requestRender();
                return;
            }
            if (message.type === 'error') return;
            if (message.requestId < renderedRequestRef.current) return;
            renderedRequestRef.current = message.requestId;
            const canvas = overlayCanvasRef.current;
            const context = canvas?.getContext('2d');
            if (!canvas || !context) return;
            canvas.width = message.width;
            canvas.height = message.height;
            context.putImageData(
                new ImageData(
                    new Uint8ClampedArray(message.overlay),
                    message.width,
                    message.height,
                ),
                0,
                0,
            );
        };

        void Promise.all([
            loadImageData(state.labelsUrl, width, height),
            loadImageData(state.uncertaintyUrl, width, height),
        ]).then(([labels, uncertainty]) => {
            if (cancelled) return;
            labelIdsRef.current = decodeLabelRgb(labels.data);
            worker.postMessage(
                {
                    type: 'init', width, height,
                    labelsRgba: labels.data,
                    uncertaintyRgba: uncertainty.data,
                },
                [labels.data.buffer, uncertainty.data.buffer],
            );
        }).catch(() => {
            if (!cancelled) worker.terminate();
        });

        return () => {
            cancelled = true;
            workerReadyRef.current = false;
            labelIdsRef.current = null;
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
        };
    }, [requestRender, state.labelsUrl, state.manifest, state.status, state.uncertaintyUrl]);

    useEffect(() => {
        requestRender();
    }, [requestRender, state.edits, state.selectedInstanceId]);

    const instanceAt = (point: NormalizedMaskPoint): number => {
        const manifest = state.manifest;
        const labels = labelIdsRef.current;
        if (!manifest || !labels) return 0;
        const width = manifest.preview_width_px;
        const height = manifest.preview_height_px;
        const x = Math.max(0, Math.min(width - 1, Math.floor(point.x * width)));
        const y = Math.max(0, Math.min(height - 1, Math.floor(point.y * height)));
        return labels[y * width + x] || 0;
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!isActive || state.status !== 'ready') return;
        workspaceRef.current?.focus({ preventScroll: true });
        const wantsPan = event.button === 1 || interactionMode === 'pan' || spaceHeldRef.current;
        if (wantsPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panningRef.current = true;
            setIsPanning(true);
            panStartRef.current = {
                x: event.clientX,
                y: event.clientY,
                panX: viewRef.current.panX,
                panY: viewRef.current.panY,
            };
            return;
        }
        if (event.button !== 0) return;
        const point = normalizedPoint(event);
        const hit = instanceAt(point);
        if (state.activeTool === 'merge') {
            if (hit <= 0) return;
            if (mergeSourceRef.current === null) {
                mergeSourceRef.current = hit;
                actions.setSelectedInstance(tabId, hit);
            } else if (mergeSourceRef.current !== hit) {
                actions.mergeInstance(tabId, mergeSourceRef.current, hit);
                actions.setSelectedInstance(tabId, hit);
                mergeSourceRef.current = null;
            }
            return;
        }
        const instanceId = state.selectedInstanceId || hit;
        if (state.activeTool === 'restore' && !instanceId) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = true;
        pointsRef.current = [point];
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (panningRef.current) {
            const start = panStartRef.current;
            viewRef.current.panX = start.panX + event.clientX - start.x;
            viewRef.current.panY = start.panY + event.clientY - start.y;
            applyViewTransform();
            return;
        }
        if (!drawingRef.current || !isActive) return;
        const point = normalizedPoint(event);
        const previous = pointsRef.current[pointsRef.current.length - 1];
        if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.002) {
            pointsRef.current.push(point);
        }
    };

    const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (panningRef.current) {
            panningRef.current = false;
            setIsPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
            return;
        }
        if (!drawingRef.current) return;
        drawingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const points = pointsRef.current;
        pointsRef.current = [];
        if (points.length === 0 || (state.activeTool !== 'erase' && state.activeTool !== 'restore')) return;
        const instanceId = state.selectedInstanceId || instanceAt(points[0]) || 1;
        actions.addStroke(tabId, {
            tool: state.activeTool,
            instanceId,
            radius: state.brushRadius,
            points,
        });
    };

    const handleWheel = useCallback((event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey) {
            updateZoom(
                viewRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1),
                event.clientX,
                event.clientY,
            );
            return;
        }
        viewRef.current.panX -= event.deltaX;
        viewRef.current.panY -= event.deltaY;
        applyViewTransform();
    }, [applyViewTransform, updateZoom]);

    useEffect(() => {
        if (state.status !== 'ready') return;
        const workspace = workspaceRef.current;
        if (!workspace) return;
        // UIUX (audit 2026-08-05 §AI2.VIEW2): React đăng ký wheel dạng passive trong
        // WebView2 nên preventDefault bị bỏ qua. Listener native non-passive giữ pan/zoom
        // trong vùng xem và không làm cuộn panel bên ngoài.
        workspace.addEventListener('wheel', handleWheel, { passive: false });
        return () => workspace.removeEventListener('wheel', handleWheel);
    }, [handleWheel, state.status]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!isActive || event.code !== 'Space' || event.repeat) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        spaceHeldRef.current = true;
        setIsSpaceHeld(true);
    };

    const releaseSpace = () => {
        spaceHeldRef.current = false;
        setIsSpaceHeld(false);
    };

    if (state.status === 'idle' || state.status === 'error') {
        return (
            <div className="flex h-full items-center justify-center bg-slate-100 p-6 dark:bg-zinc-950">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                    className="hidden"
                    onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) void actions.analyze(tabId, file);
                        event.currentTarget.value = '';
                    }}
                />
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={event => event.preventDefault()}
                    onDrop={event => {
                        event.preventDefault();
                        const file = event.dataTransfer.files?.[0];
                        if (file) void actions.analyze(tabId, file);
                    }}
                    className="flex max-w-xl flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-violet-300 bg-white px-12 py-14 text-center shadow-sm hover:border-violet-500 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:hover:bg-violet-950/20"
                >
                    <span className="text-6xl">✂️</span>
                    <span className="text-xl font-black text-slate-800 dark:text-white">{tv('Tách tem từ ảnh AI')}</span>
                    <span className="text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
                        {tv('Kéo ảnh JPG/PNG chứa nhiều tem vào đây. PrynX sẽ loại nền và bóng, sau đó tạo từng đường cắt.')}
                    </span>
                </button>
            </div>
        );
    }

    if (state.status === 'analyzing') {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-4 bg-slate-100 dark:bg-zinc-950">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-violet-500 border-t-transparent" />
                <div className="text-sm font-bold text-slate-700 dark:text-zinc-200">{tv('Đang nhận diện từng tem…')}</div>
            </div>
        );
    }

    const manifest = state.manifest;
    if (!manifest) return null;

    return (
        <div
            ref={workspaceRef}
            data-testid="sticker-sheet-workspace"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onKeyUp={event => { if (event.code === 'Space') releaseSpace(); }}
            onBlur={releaseSpace}
            className="relative flex h-full flex-col overflow-hidden bg-[#d9d9d9] outline-none dark:bg-[#181818]"
        >
            <div className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-lg bg-white/90 p-1 shadow dark:bg-zinc-900/90">
                <button type="button" onClick={() => updateZoom(viewRef.current.zoom / 1.2)} className="h-7 w-8 rounded text-sm font-bold hover:bg-slate-100 dark:hover:bg-zinc-800">−</button>
                <button type="button" onClick={resetView} className="h-7 min-w-14 rounded px-2 text-[11px] font-bold hover:bg-slate-100 dark:hover:bg-zinc-800">{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => updateZoom(viewRef.current.zoom * 1.2)} className="h-7 w-8 rounded text-sm font-bold hover:bg-slate-100 dark:hover:bg-zinc-800">+</button>
                <span className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-zinc-700" />
                <button
                    type="button"
                    aria-pressed={interactionMode === 'pan'}
                    onClick={() => setInteractionMode('pan')}
                    title={tv('Di chuyển vùng xem')}
                    className={`flex h-7 items-center gap-1 rounded px-2 text-[10px] font-bold ${interactionMode === 'pan' ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-200' : 'hover:bg-slate-100 dark:hover:bg-zinc-800'}`}
                >
                    <Hand className="h-3.5 w-3.5" /> {tv('Di chuyển')}
                </button>
                <button
                    type="button"
                    aria-pressed={interactionMode === 'edit'}
                    onClick={() => setInteractionMode('edit')}
                    title={tv('Sửa vùng tem bằng công cụ đang chọn')}
                    className={`flex h-7 items-center gap-1 rounded px-2 text-[10px] font-bold ${interactionMode === 'edit' ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-200' : 'hover:bg-slate-100 dark:hover:bg-zinc-800'}`}
                >
                    <Pencil className="h-3.5 w-3.5" /> {tv('Sửa vùng tem')}
                </button>
            </div>
            <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
                {tv('Giữ Space hoặc dùng chuột giữa để di chuyển · Ctrl + cuộn để thu phóng')}
            </div>
            <div className="relative h-full overflow-hidden">
                <div
                    ref={panLayerRef}
                    className="absolute inset-0 flex items-center justify-center will-change-transform"
                >
                    <div
                        ref={zoomLayerRef}
                        className="relative shrink-0 shadow-2xl will-change-transform"
                        style={{
                            width: `${manifest.preview_width_px}px`,
                            height: `${manifest.preview_height_px}px`,
                            transformOrigin: 'center center',
                        }}
                    >
                        <div
                            className="absolute inset-0"
                            style={{
                                backgroundColor: '#fff',
                                backgroundImage: 'linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%)',
                                backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
                                backgroundSize: '16px 16px',
                            }}
                        />
                        <img src={state.previewUrl} alt={tv('Ảnh tách tem')} draggable={false} className="absolute inset-0 h-full w-full select-none" />
                        <canvas
                            ref={overlayCanvasRef}
                            width={manifest.preview_width_px}
                            height={manifest.preview_height_px}
                            className={`absolute inset-0 h-full w-full touch-none ${isPanning ? 'cursor-grabbing' : interactionMode === 'pan' || isSpaceHeld ? 'cursor-grab' : 'cursor-crosshair'}`}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={finishStroke}
                            onPointerCancel={finishStroke}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
