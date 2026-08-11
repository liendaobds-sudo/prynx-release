import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from 'react';
import { Hand, Pencil } from 'lucide-react';

import { tv } from '../../i18n';
import type { StickerCutlinePreview } from '../../lib/stickerSheetApi';
import {
    decodeLabelRgb,
    type StickerMaskWorkerResponse,
} from '../../workers/stickerMaskProtocol';
import { useStickerSheetStore, type NormalizedMaskPoint } from './stickerSheetStore';


interface Props {
    tabId: string;
    isActive: boolean;
    /** Chỉ phủ preview/mask lên trang của AcrobatViewer, không dựng viewport riêng. */
    embedded?: boolean;
    /** Viewer đang ở Pointer tool; Hand/Dimension phải nhận thao tác từ Viewer gốc. */
    editingEnabled?: boolean;
    /** Số trang nguồn đang được thumbnail/Viewer chọn (không phải vị trí thumbnail). */
    sourcePage?: number;
}

function CutlineOverlay({
    preview,
    selectedInstanceId,
}: {
    preview: StickerCutlinePreview;
    selectedInstanceId: number | null;
}) {
    return (
        <svg
            data-testid="sticker-cutline-preview"
            viewBox={`0 0 ${preview.preview_width_px} ${preview.preview_height_px}`}
            preserveAspectRatio="none"
            aria-label={tv('Đường bế xem trước', 'preprocess.stickerSheet')}
            className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
        >
            {preview.paths.map(path => (
                <path
                    key={path.instance_id}
                    d={path.d}
                    fill="none"
                    stroke={selectedInstanceId === path.instance_id ? '#d946ef' : '#7c3aed'}
                    strokeWidth={selectedInstanceId === path.instance_id ? 2 : 1.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
            ))}
        </svg>
    );
}

function BrushCursorOverlay({
    cursorRef,
    width,
    height,
    radius,
}: {
    cursorRef: RefObject<SVGGElement | null>;
    width: number;
    height: number;
    radius: number;
}) {
    const radiusPx = Math.max(1, radius * Math.max(width, height));
    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible"
        >
            <g
                ref={cursorRef}
                data-testid="sticker-brush-cursor"
                opacity="0"
            >
                <circle
                    cx="0"
                    cy="0"
                    r={radiusPx}
                    fill="none"
                    stroke="rgba(0,0,0,0.9)"
                    strokeWidth="3"
                    vectorEffect="non-scaling-stroke"
                />
                <circle
                    cx="0"
                    cy="0"
                    r={radiusPx}
                    fill="none"
                    stroke="rgba(255,255,255,0.98)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                />
            </g>
        </svg>
    );
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

function normalizedPoint(event: ReactPointerEvent<HTMLElement>): NormalizedMaskPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ));
}

export default function StickerSheetWorkspace({
    tabId,
    isActive,
    embedded = false,
    editingEnabled = false,
    sourcePage,
}: Props) {
    const tab = useStickerSheetStore(state => state.tabs[tabId]);
    const tabState = tab || useStickerSheetStore.getState().getTab(tabId);
    const requestedPage = sourcePage || tabState.activeSourcePage;
    const requestedPageState = tabState.pages[requestedPage];
    const state = requestedPageState
        ? { ...tabState, ...requestedPageState, activeSourcePage: requestedPage }
        : tabState;
    const actionsRef = useRef(useStickerSheetStore.getState());
    const actions = actionsRef.current;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const brushCursorRef = useRef<SVGGElement>(null);
    const workspaceRef = useRef<HTMLDivElement>(null);
    const panLayerRef = useRef<HTMLDivElement>(null);
    const zoomLayerRef = useRef<HTMLElement>(null);
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
    const maskVisible = ['mask-review', 'confirming', 'mask-ready', 'exporting'].includes(state.status);
    const canEditMask = (
        state.status === 'mask-review' || state.status === 'mask-ready'
    ) && !state.isRefining;
    const brushToolActive = state.activeTool === 'erase' || state.activeTool === 'restore';
    const brushCursorEnabled = Boolean(
        isActive
        && canEditMask
        && brushToolActive
        && (embedded
            ? editingEnabled
            : interactionMode === 'edit' && !isPanning && !isSpaceHeld),
    );
    const isPdfSource = state.sourceFile?.type === 'application/pdf'
        || /\.pdf$/i.test(state.sourceFile?.name || '');
    const sourcePreviewVisible = Boolean(
        state.sourceFile
        && state.sourcePreviewUrl
        && (state.inspection || !isPdfSource),
    );
    const canNavigateView = !embedded && (maskVisible || sourcePreviewVisible);

    editsRef.current = state.edits;
    selectedRef.current = state.selectedInstanceId;

    useEffect(() => {
        if (!isActive || !sourcePage) return;
        actions.setActivePage(tabId, sourcePage);
    }, [actions, isActive, sourcePage, tabId]);

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
    }, [resetView, state.manifest?.session_id, state.sourcePreviewUrl]);

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
            !maskVisible
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
    }, [maskVisible, requestRender, state.labelsUrl, state.manifest, state.uncertaintyUrl]);

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

    const hideBrushCursor = useCallback(() => {
        brushCursorRef.current?.setAttribute('opacity', '0');
    }, []);

    const syncBrushCursor = (event: ReactPointerEvent<HTMLElement>) => {
        const cursor = brushCursorRef.current;
        const manifest = state.manifest;
        if (!cursor || !manifest || !brushCursorEnabled) {
            hideBrushCursor();
            return;
        }
        const point = normalizedPoint(event);
        cursor.setAttribute(
            'transform',
            `translate(${point.x * manifest.preview_width_px} ${point.y * manifest.preview_height_px})`,
        );
        cursor.setAttribute('opacity', '1');
    };

    useEffect(() => {
        if (!brushCursorEnabled) hideBrushCursor();
    }, [brushCursorEnabled, hideBrushCursor]);

    const beginPan = (event: ReactPointerEvent<HTMLElement>) => {
        hideBrushCursor();
        workspaceRef.current?.focus({ preventScroll: true });
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
    };

    const handleSourcePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (!isActive || (event.button !== 0 && event.button !== 1)) return;
        beginPan(event);
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (!isActive) return;
        if (!embedded) {
            const wantsPan = event.button === 1 || interactionMode === 'pan' || spaceHeldRef.current;
            if (wantsPan) {
                beginPan(event);
                return;
            }
        }
        if (!canEditMask || (embedded && !editingEnabled)) return;
        if (event.button !== 0) return;
        if (embedded) event.stopPropagation();
        syncBrushCursor(event);
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

    const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        if (panningRef.current) {
            hideBrushCursor();
            const start = panStartRef.current;
            viewRef.current.panX = start.panX + event.clientX - start.x;
            viewRef.current.panY = start.panY + event.clientY - start.y;
            applyViewTransform();
            return;
        }
        syncBrushCursor(event);
        if (!drawingRef.current || !isActive) return;
        if (embedded) event.stopPropagation();
        const point = normalizedPoint(event);
        const previous = pointsRef.current[pointsRef.current.length - 1];
        if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.002) {
            pointsRef.current.push(point);
        }
    };

    const finishStroke = (event: ReactPointerEvent<HTMLElement>) => {
        if (panningRef.current) {
            panningRef.current = false;
            setIsPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
            return;
        }
        if (!drawingRef.current) return;
        if (embedded) event.stopPropagation();
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
        if (!canNavigateView || !isActive) return;
        const workspace = workspaceRef.current;
        if (!workspace) return;
        // UIUX (audit 2026-08-05 §AI2.VIEW2): React đăng ký wheel dạng passive trong
        // WebView2 nên preventDefault bị bỏ qua. Listener native non-passive giữ pan/zoom
        // trong vùng xem và không làm cuộn panel bên ngoài.
        workspace.addEventListener('wheel', handleWheel, { passive: false });
        return () => workspace.removeEventListener('wheel', handleWheel);
    }, [canNavigateView, handleWheel, isActive]);

    useEffect(() => {
        if (!isActive) return;
        // UIUX (feedback 2026-08-10 §AI.BRUSH1): bắt lịch sử mask ở capture phase
        // để Ctrl+Z không đồng thời hoàn tác tài liệu trong Viewer nằm phía dưới.
        const handleHistoryShortcut = (event: KeyboardEvent) => {
            if (
                !(event.ctrlKey || event.metaKey)
                || event.altKey
                || event.isComposing
                || isEditableShortcutTarget(event.target)
            ) return;

            const key = event.key.toLowerCase();
            const wantsUndo = key === 'z' && !event.shiftKey;
            const wantsRedo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
            if (!wantsUndo && !wantsRedo) return;

            const before = useStickerSheetStore.getState().getTab(tabId);
            if (wantsUndo) actions.undo(tabId);
            else actions.redo(tabId);
            const after = useStickerSheetStore.getState().getTab(tabId);

            // Không nuốt Undo của Viewer khi lịch sử mask không đổi hoặc đang bị khóa.
            if (
                before.edits.length === after.edits.length
                && before.redoEdits.length === after.redoEdits.length
            ) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        window.addEventListener('keydown', handleHistoryShortcut, true);
        return () => window.removeEventListener('keydown', handleHistoryShortcut, true);
    }, [actions, isActive, tabId]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!isActive || event.code !== 'Space' || event.repeat) return;
        if (isEditableShortcutTarget(event.target)) return;
        event.preventDefault();
        spaceHeldRef.current = true;
        setIsSpaceHeld(true);
        hideBrushCursor();
    };

    const releaseSpace = () => {
        spaceHeldRef.current = false;
        setIsSpaceHeld(false);
    };

    // UIUX (feedback 2026-08-09 §AI.VIEW1): trước khi có mask, AI không được
    // che hay thay thế AcrobatViewer. Sidebar vẫn điều khiển inspect/detect.
    if (embedded && !maskVisible) return null;

    if (state.status === 'idle' || (state.status === 'error' && !state.sourceFile)) {
        return (
            <div className="flex h-full items-center justify-center bg-slate-100 p-6 dark:bg-zinc-950">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                    className="hidden"
                    onChange={event => {
                        const file = event.target.files?.[0];
                        if (file) actions.selectSource(tabId, file);
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
                        if (file) actions.selectSource(tabId, file);
                    }}
                    className="flex max-w-xl flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-violet-300 bg-white px-12 py-14 text-center shadow-sm hover:border-violet-500 hover:bg-violet-50 dark:border-violet-800 dark:bg-zinc-900 dark:hover:bg-violet-950/20"
                >
                    <span className="text-6xl">✂️</span>
                    <span className="text-xl font-black text-slate-800 dark:text-white">{tv('Nhận diện và tạo đường cắt')}</span>
                    <span className="text-[13px] leading-relaxed text-slate-500 dark:text-zinc-400">
                        {tv('Kéo PDF hoặc ảnh tem vào đây. PrynX sẽ ưu tiên CutContour, vector và nền trong suốt trước khi dùng AI.')}
                    </span>
                </button>
            </div>
        );
    }

    if (
        ['source-ready', 'error', 'inspecting', 'detecting'].includes(state.status)
        && state.sourceFile
    ) {
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
                {sourcePreviewVisible && state.sourcePreviewUrl ? (
                    <>
                        <div className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-lg bg-white/90 p-1 shadow dark:bg-zinc-900/90">
                            <button
                                type="button"
                                aria-label={tv('Thu nhỏ')}
                                onClick={() => updateZoom(viewRef.current.zoom / 1.2)}
                                className="h-7 w-8 rounded text-sm font-bold hover:bg-slate-100 dark:hover:bg-zinc-800"
                            >−</button>
                            <button
                                type="button"
                                aria-label={tv('Đặt lại vùng xem')}
                                onClick={resetView}
                                className="h-7 min-w-14 rounded px-2 text-[11px] font-bold hover:bg-slate-100 dark:hover:bg-zinc-800"
                            >{Math.round(zoom * 100)}%</button>
                            <button
                                type="button"
                                aria-label={tv('Phóng to')}
                                onClick={() => updateZoom(viewRef.current.zoom * 1.2)}
                                className="h-7 w-8 rounded text-sm font-bold hover:bg-slate-100 dark:hover:bg-zinc-800"
                            >+</button>
                            <span className="mx-0.5 h-5 w-px bg-slate-200 dark:bg-zinc-700" />
                            <span className="flex h-7 items-center gap-1 rounded bg-violet-100 px-2 text-[10px] font-bold text-violet-700 dark:bg-violet-950/60 dark:text-violet-200">
                                <Hand className="h-3.5 w-3.5" /> {tv('Di chuyển')}
                            </span>
                        </div>
                        <div
                            className={`relative h-full touch-none overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
                            onPointerDown={handleSourcePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={finishStroke}
                            onPointerCancel={finishStroke}
                        >
                            <div
                                ref={panLayerRef}
                                data-testid="sticker-source-pan-layer"
                                className="absolute inset-6 flex items-center justify-center will-change-transform"
                            >
                                <img
                                    ref={element => { zoomLayerRef.current = element; }}
                                    src={state.sourcePreviewUrl}
                                    alt={tv('Ảnh gốc chưa nhận diện')}
                                    draggable={false}
                                    className="max-h-full max-w-full select-none object-contain shadow-2xl will-change-transform"
                                />
                            </div>
                        </div>
                        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
                            {tv('Kéo để di chuyển · Ctrl + cuộn để thu phóng')}
                        </div>
                    </>
                ) : (
                    <div className="m-auto rounded-xl bg-white/90 px-4 py-3 text-sm font-semibold text-slate-700 shadow dark:bg-zinc-900/90 dark:text-zinc-200">
                        {state.sourceFile.name}
                    </div>
                )}
                <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-[11px] font-bold text-white backdrop-blur-sm">
                    {state.status === 'detecting'
                        ? tv('Đang nhận diện · vẫn giữ preview gốc')
                        : state.status === 'inspecting'
                            ? tv('Đang chuẩn bị preview gốc')
                            : tv('File gốc · chưa nhận diện')}
                </div>
                {state.status === 'error' && state.error && (
                    <div className="absolute bottom-10 left-1/2 z-20 max-w-xl -translate-x-1/2 rounded-lg border border-rose-300 bg-rose-50/95 px-3 py-2 text-center text-[11px] text-rose-700 shadow dark:border-rose-800 dark:bg-rose-950/90 dark:text-rose-300">
                        {state.error}
                    </div>
                )}
            </div>
        );
    }

    const manifest = state.manifest;
    if (!manifest) return null;
    const cutlinePreview = (
        state.cutlinePreview?.mask_revision === (manifest.mask_revision ?? 1)
        && state.cutlinePreview.preview_width_px === manifest.preview_width_px
        && state.cutlinePreview.preview_height_px === manifest.preview_height_px
    ) ? state.cutlinePreview : null;
    const hidePixelBoundary = Boolean(cutlinePreview || state.isCutlinePreviewing);
    const editCursorClass = brushToolActive && canEditMask && isActive
        ? 'cursor-none'
        : 'cursor-crosshair';
    const brushCursor = brushToolActive ? (
        <BrushCursorOverlay
            cursorRef={brushCursorRef}
            width={manifest.preview_width_px}
            height={manifest.preview_height_px}
            radius={state.brushRadius}
        />
    ) : null;

    if (embedded) {
        const editMask = isActive && editingEnabled && canEditMask;
        return (
            <div
                data-testid="sticker-sheet-page-overlay"
                className="pointer-events-none absolute inset-0 z-[35] overflow-hidden bg-white"
            >
                <img
                    src={state.previewUrl}
                    alt={tv('Ảnh tem đã khử nền')}
                    draggable={false}
                    className="pointer-events-none absolute inset-0 h-full w-full select-none"
                />
                {cutlinePreview ? (
                    <CutlineOverlay
                        preview={cutlinePreview}
                        selectedInstanceId={state.selectedInstanceId}
                    />
                ) : null}
                <canvas
                    ref={overlayCanvasRef}
                    width={manifest.preview_width_px}
                    height={manifest.preview_height_px}
                    className={`absolute inset-0 z-20 h-full w-full touch-none ${hidePixelBoundary ? 'opacity-0' : ''} ${editMask ? `pointer-events-auto ${editCursorClass}` : 'pointer-events-none'}`}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishStroke}
                    onPointerCancel={finishStroke}
                    onPointerEnter={syncBrushCursor}
                    onPointerLeave={hideBrushCursor}
                />
                {brushCursor}
            </div>
        );
    }

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
                    disabled={!canEditMask}
                    title={tv('Sửa vùng tem bằng công cụ đang chọn')}
                    className={`flex h-7 items-center gap-1 rounded px-2 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${interactionMode === 'edit' ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-200' : 'hover:bg-slate-100 dark:hover:bg-zinc-800'}`}
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
                        ref={element => { zoomLayerRef.current = element; }}
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
                        {cutlinePreview ? (
                            <CutlineOverlay
                                preview={cutlinePreview}
                                selectedInstanceId={state.selectedInstanceId}
                            />
                        ) : null}
                        <canvas
                            ref={overlayCanvasRef}
                            width={manifest.preview_width_px}
                            height={manifest.preview_height_px}
                            className={`absolute inset-0 z-20 h-full w-full touch-none ${hidePixelBoundary ? 'opacity-0' : ''} ${isPanning ? 'cursor-grabbing' : interactionMode === 'pan' || isSpaceHeld ? 'cursor-grab' : editCursorClass}`}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={finishStroke}
                            onPointerCancel={finishStroke}
                            onPointerEnter={syncBrushCursor}
                            onPointerLeave={hideBrushCursor}
                        />
                        {brushCursor}
                    </div>
                </div>
            </div>
        </div>
    );
}
