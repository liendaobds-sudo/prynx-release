import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export type LogoCompareMode = 'source' | 'vector' | 'split' | 'overlay';

interface LogoCompareLabels {
  viewport: string;
  source: string;
  vector: string;
  split: string;
  overlay: string;
  zoomOut: string;
  zoomIn: string;
  zoomLevel: string;
  resetZoom: string;
  overlayOpacity: string;
  noImage: string;
  noPreview: string;
  panHint: string;
  sourceAlt: string;
  previewAlt: string;
  selection: string;
  point: string;
}

interface LogoCompareViewportProps {
  crop: { x: number; y: number; width: number; height: number };
  labels: LogoCompareLabels;
  onCropChange: (crop: { x: number; y: number; width: number; height: number }) => void;
  onPerspectiveChange: (points: Array<{ x: number; y: number }>) => void;
  perspective: Array<{ x: number; y: number }>;
  previewUrl: string;
  selectionMode: 'full' | 'crop' | 'perspective';
  sourceUrl: string;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const MIN_CROP_PERCENT = 1;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export default function LogoCompareViewport({
  crop,
  labels,
  onCropChange,
  onPerspectiveChange,
  perspective,
  previewUrl,
  selectionMode,
  sourceUrl,
}: LogoCompareViewportProps) {
  const [mode, setMode] = useState<LogoCompareMode>(previewUrl ? 'split' : 'source');
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [isPanning, setIsPanning] = useState(false);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  const panStartRef = useRef({ clientX: 0, clientY: 0, panX: 0, panY: 0 });
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const selectionDragRef = useRef<
    | { kind: 'crop-corner'; index: number; start: typeof crop }
    | { kind: 'crop-move'; clientX: number; clientY: number; start: typeof crop }
    | { kind: 'perspective'; index: number }
    | null
  >(null);

  const updateView = useCallback((next: ViewState) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const resetView = useCallback(() => {
    updateView({ zoom: 1, panX: 0, panY: 0 });
  }, [updateView]);

  const updateZoom = useCallback((value: number) => {
    const nextZoom = clampZoom(value);
    updateView({
      ...viewRef.current,
      zoom: nextZoom,
      ...(nextZoom === 1 ? { panX: 0, panY: 0 } : {}),
    });
  }, [updateView]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey) {
        updateZoom(viewRef.current.zoom * (event.deltaY < 0 ? 1.2 : 0.8));
        return;
      }
      updateView({
        ...viewRef.current,
        panX: viewRef.current.panX - event.deltaX,
        panY: viewRef.current.panY - event.deltaY,
      });
    };
    frame.addEventListener('wheel', handleWheel, { passive: false });
    return () => frame.removeEventListener('wheel', handleWheel);
  }, [updateView, updateZoom]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setFrameSize({ width: rect.width, height: rect.height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
    };
    setIsPanning(true);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    const start = panStartRef.current;
    updateView({
      ...viewRef.current,
      panX: start.panX + event.clientX - start.clientX,
      panY: start.panY + event.clientY - start.clientY,
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panStep = event.shiftKey ? 40 : 12;
    if (event.key === '+' || event.key === '=') updateZoom(viewRef.current.zoom + 0.25);
    else if (event.key === '-') updateZoom(viewRef.current.zoom - 0.25);
    else if (event.key === '0') resetView();
    else if (event.key === 'ArrowLeft') updateView({ ...viewRef.current, panX: viewRef.current.panX - panStep });
    else if (event.key === 'ArrowRight') updateView({ ...viewRef.current, panX: viewRef.current.panX + panStep });
    else if (event.key === 'ArrowUp') updateView({ ...viewRef.current, panY: viewRef.current.panY - panStep });
    else if (event.key === 'ArrowDown') updateView({ ...viewRef.current, panY: viewRef.current.panY + panStep });
    else return;
    event.preventDefault();
  };

  const normalizedSelectionPoint = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = artboardRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const beginSelectionDrag = (
    event: ReactPointerEvent<HTMLButtonElement | HTMLDivElement>,
    target: NonNullable<typeof selectionDragRef.current>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    selectionDragRef.current = target;
  };

  const moveSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const point = normalizedSelectionPoint(event);
    if (!point) return;

    if (drag.kind === 'perspective') {
      onPerspectiveChange(perspective.map((current, index) => (
        index === drag.index ? point : current
      )));
      return;
    }

    if (drag.kind === 'crop-move') {
      const rect = artboardRef.current?.getBoundingClientRect();
      if (!rect) return;
      const deltaX = ((event.clientX - drag.clientX) / rect.width) * 100;
      const deltaY = ((event.clientY - drag.clientY) / rect.height) * 100;
      onCropChange({
        ...drag.start,
        x: Math.min(100 - drag.start.width, Math.max(0, drag.start.x + deltaX)),
        y: Math.min(100 - drag.start.height, Math.max(0, drag.start.y + deltaY)),
      });
      return;
    }

    const x1 = drag.start.x;
    const y1 = drag.start.y;
    const x2 = drag.start.x + drag.start.width;
    const y2 = drag.start.y + drag.start.height;
    const pointX = point.x * 100;
    const pointY = point.y * 100;
    const left = drag.index === 0 || drag.index === 3
      ? Math.min(x2 - MIN_CROP_PERCENT, pointX)
      : x1;
    const right = drag.index === 1 || drag.index === 2
      ? Math.max(x1 + MIN_CROP_PERCENT, pointX)
      : x2;
    const top = drag.index === 0 || drag.index === 1
      ? Math.min(y2 - MIN_CROP_PERCENT, pointY)
      : y1;
    const bottom = drag.index === 2 || drag.index === 3
      ? Math.max(y1 + MIN_CROP_PERCENT, pointY)
      : y2;
    onCropChange({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const endSelectionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!selectionDragRef.current) return;
    selectionDragRef.current = null;
    event.stopPropagation();
  };

  const cropHandles = useMemo(() => [
    { left: crop.x, top: crop.y },
    { left: crop.x + crop.width, top: crop.y },
    { left: crop.x + crop.width, top: crop.y + crop.height },
    { left: crop.x, top: crop.y + crop.height },
  ], [crop]);

  const artboardStyle = useMemo(() => {
    if (!frameSize || !sourceSize || sourceSize.width <= 0 || sourceSize.height <= 0) {
      return { inset: '1rem' };
    }
    const availableWidth = Math.max(1, frameSize.width - 32);
    const availableHeight = Math.max(1, frameSize.height - 32);
    const scale = Math.min(
      availableWidth / sourceSize.width,
      availableHeight / sourceSize.height,
    );
    return {
      left: '50%',
      top: '50%',
      width: `${sourceSize.width * scale}px`,
      height: `${sourceSize.height * scale}px`,
      transform: 'translate(-50%, -50%)',
    };
  }, [frameSize, sourceSize]);

  const imageClass = 'pointer-events-none absolute inset-0 h-full w-full object-contain';
  const transform = `translate3d(${view.panX}px, ${view.panY}px, 0) scale(${view.zoom})`;
  const hasPreview = Boolean(previewUrl);

  return (
    <figure className="flex min-h-[320px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 xl:min-h-0">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex flex-wrap gap-1" role="group" aria-label={labels.viewport}>
          {(['source', 'vector', 'split', 'overlay'] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={value !== 'source' && !hasPreview}
              onClick={() => setMode(value)}
              className="rounded border border-slate-200 px-2.5 py-1 text-xs font-semibold disabled:opacity-35 aria-pressed:border-violet-500 aria-pressed:bg-violet-50 aria-pressed:text-violet-700 dark:border-zinc-700 dark:aria-pressed:bg-violet-950/40 dark:aria-pressed:text-violet-200"
            >
              {{ source: labels.source, vector: labels.vector, split: labels.split, overlay: labels.overlay }[value]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button type="button" aria-label={labels.zoomOut} onClick={() => updateZoom(viewRef.current.zoom - 0.25)} disabled={view.zoom <= MIN_ZOOM} className="h-7 w-7 rounded border border-slate-200 font-bold disabled:opacity-35 dark:border-zinc-700">−</button>
          <input aria-label={labels.zoomLevel} type="range" min={100} max={800} step={25} value={Math.round(view.zoom * 100)} onChange={event => updateZoom(Number(event.target.value) / 100)} className="w-28" />
          <button type="button" aria-label={labels.zoomIn} onClick={() => updateZoom(viewRef.current.zoom + 0.25)} disabled={view.zoom >= MAX_ZOOM} className="h-7 w-7 rounded border border-slate-200 font-bold disabled:opacity-35 dark:border-zinc-700">+</button>
          <button type="button" title={labels.resetZoom} onClick={resetView} className="min-w-14 rounded border border-slate-200 px-2 py-1 font-mono dark:border-zinc-700">{Math.round(view.zoom * 100)}%</button>
        </div>
        {mode === 'overlay' && hasPreview && (
          <label className="flex items-center gap-2 text-xs font-semibold">
            {labels.overlayOpacity}
            <input aria-label={labels.overlayOpacity} type="range" min={0} max={100} value={Math.round(overlayOpacity * 100)} onChange={event => setOverlayOpacity(Number(event.target.value) / 100)} className="w-24" />
          </label>
        )}
      </figcaption>
      <div
        ref={frameRef}
        role="application"
        aria-label={labels.viewport}
        tabIndex={0}
        data-testid="logo-compare-viewport"
        onKeyDown={handleKeyDown}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={resetView}
        className={`relative flex flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(45deg,#eee_25%,transparent_25%),linear-gradient(-45deg,#eee_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#eee_75%),linear-gradient(-45deg,transparent_75%,#eee_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:bg-zinc-950 ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
      >
        {!sourceUrl ? (
          <p className="text-sm text-slate-400">{labels.noImage}</p>
        ) : (
          <div data-testid="logo-compare-stage" className="absolute inset-0" style={{ transform, transformOrigin: 'center center' }}>
            <div ref={artboardRef} data-testid="logo-selection-artboard" className="absolute" style={artboardStyle}>
              {(mode === 'source' || mode === 'split' || mode === 'overlay') && <img src={sourceUrl} alt={labels.sourceAlt} draggable={false} className={imageClass} onLoad={event => setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />}
              {mode === 'vector' && hasPreview && <img src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} />}
              {mode === 'split' && hasPreview && (
                <div className="absolute inset-0" style={{ clipPath: 'inset(0 50% 0 0)' }}>
                  <img src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} />
                </div>
              )}
              {mode === 'overlay' && hasPreview && (
                <img data-testid="logo-overlay-layer" src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} style={{ opacity: overlayOpacity }} />
              )}
              {mode === 'split' && hasPreview && <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-0.5 bg-violet-500 shadow" />}
              {selectionMode !== 'full' && mode !== 'vector' && (
                <div
                  data-testid="logo-selection-overlay"
                  className="absolute inset-0 z-20"
                  onPointerMove={moveSelection}
                  onPointerUp={endSelectionDrag}
                  onPointerCancel={endSelectionDrag}
                >
                  <span className="absolute left-2 top-2 rounded bg-violet-600/90 px-2 py-1 text-[11px] font-bold text-white">{labels.selection}</span>
                  {selectionMode === 'crop' && (
                    <>
                      <div
                        role="presentation"
                        onPointerDown={event => beginSelectionDrag(event, {
                          kind: 'crop-move',
                          clientX: event.clientX,
                          clientY: event.clientY,
                          start: crop,
                        })}
                        className="absolute cursor-move border-2 border-violet-500 bg-violet-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]"
                        style={{ left: `${crop.x}%`, top: `${crop.y}%`, width: `${crop.width}%`, height: `${crop.height}%` }}
                      />
                      {cropHandles.map((handle, index) => (
                        <button
                          key={index}
                          type="button"
                          aria-label={`${labels.point} crop ${index + 1}`}
                          onPointerDown={event => beginSelectionDrag(event, { kind: 'crop-corner', index, start: crop })}
                          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet-600 shadow"
                          style={{ left: `${handle.left}%`, top: `${handle.top}%` }}
                        />
                      ))}
                    </>
                  )}
                  {selectionMode === 'perspective' && (
                    <>
                      <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
                        <polygon points={perspective.map(point => `${point.x * 100},${point.y * 100}`).join(' ')} fill="rgba(139,92,246,0.12)" stroke="rgb(124,58,237)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
                      </svg>
                      {perspective.map((point, index) => (
                        <button
                          key={index}
                          type="button"
                          aria-label={`${labels.point} ${index + 1}`}
                          onPointerDown={event => beginSelectionDrag(event, { kind: 'perspective', index })}
                          className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-violet-600 text-[10px] font-bold text-white shadow"
                          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                        >
                          {index + 1}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {sourceUrl && !hasPreview && <span className="absolute bottom-3 rounded bg-black/55 px-3 py-1 text-xs text-white">{labels.noPreview}</span>}
        <span className="absolute bottom-3 right-3 rounded bg-black/55 px-2 py-1 text-[11px] text-white">{labels.panHint}</span>
      </div>
    </figure>
  );
}
