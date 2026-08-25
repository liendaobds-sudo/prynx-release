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
  showAnchors: string;
  comparisonWarning: string;
  keyboardHint: string;
}

interface LogoCompareViewportProps {
  crop: { x: number; y: number; width: number; height: number };
  labels: LogoCompareLabels;
  onCropChange: (crop: { x: number; y: number; width: number; height: number }) => void;
  onPerspectiveChange: (points: Array<{ x: number; y: number }>) => void;
  perspective: Array<{ x: number; y: number }>;
  previewSvg?: string | null;
  previewUrl: string;
  selectionMode: 'full' | 'crop' | 'perspective';
  sourceUrl: string;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface OverlayPoint {
  x: number;
  y: number;
}

interface OverlayLink {
  from: OverlayPoint;
  to: OverlayPoint;
}

interface ParsedOverlay {
  width: number;
  height: number;
  anchors: OverlayPoint[];
  handles: OverlayPoint[];
  links: OverlayLink[];
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const MIN_CROP_PERCENT = 1;
const SVG_TOKEN_RE = /[MmLlCcZz]|[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi;

function isCommandToken(token: string): boolean {
  return token.length === 1 && /[MmLlCcZz]/.test(token);
}

function isNumberToken(token: string): boolean {
  return token !== '' && !Number.isNaN(Number(token));
}

function nearlyEqual(left: OverlayPoint, right: OverlayPoint): boolean {
  return Math.abs(left.x - right.x) < 0.0001 && Math.abs(left.y - right.y) < 0.0001;
}

function parseSvgDimension(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseViewBox(value: string | null | undefined): { width: number; height: number } | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return null;
  const [, , width, height] = parts;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function parseSvgOverlay(svgText: string | null | undefined): ParsedOverlay | null {
  if (!svgText || typeof DOMParser === 'undefined') return null;

  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;

  const viewBox = parseViewBox(root.getAttribute('viewBox'));
  const width = parseSvgDimension(root.getAttribute('width')) ?? viewBox?.width ?? null;
  const height = parseSvgDimension(root.getAttribute('height')) ?? viewBox?.height ?? null;
  if (!width || !height) return null;

  const anchors: OverlayPoint[] = [];
  const handles: OverlayPoint[] = [];
  const links: OverlayLink[] = [];

  root.querySelectorAll('path').forEach(path => {
    const d = path.getAttribute('d');
    if (!d) return;
    const tokens = d.match(SVG_TOKEN_RE);
    if (!tokens?.length) return;

    let index = 0;
    let command = '';
    let current: OverlayPoint = { x: 0, y: 0 };
    let subpathStart: OverlayPoint | null = null;
    const seenAnchors = new Set<string>();
    const seenHandles = new Set<string>();

    const pushAnchor = (point: OverlayPoint) => {
      const key = `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
      if (seenAnchors.has(key)) return;
      seenAnchors.add(key);
      anchors.push(point);
    };

    const pushHandle = (point: OverlayPoint) => {
      const key = `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
      if (seenHandles.has(key)) return;
      seenHandles.add(key);
      handles.push(point);
    };

    const readNumber = () => Number(tokens[index++]);
    const readPoint = (relative: boolean): OverlayPoint => {
      const x = readNumber();
      const y = readNumber();
      return relative ? { x: current.x + x, y: current.y + y } : { x, y };
    };

    while (index < tokens.length) {
      const token = tokens[index++];
      if (isCommandToken(token)) {
        command = token;
      } else {
        index -= 1;
      }

      if (!command) {
        break;
      }

      const relative = command === command.toLowerCase();
      switch (command.toLowerCase()) {
        case 'm': {
          let isFirstPoint = true;
          while (index < tokens.length && isNumberToken(tokens[index])) {
            const point = readPoint(relative);
            if (isFirstPoint) {
              pushAnchor(point);
              current = point;
              subpathStart = point;
              isFirstPoint = false;
            } else {
              links.push({ from: current, to: point });
              pushAnchor(point);
              current = point;
            }
          }
          command = relative ? 'l' : 'L';
          break;
        }
        case 'l': {
          while (index < tokens.length && isNumberToken(tokens[index])) {
            const point = readPoint(relative);
            links.push({ from: current, to: point });
            pushAnchor(point);
            current = point;
          }
          break;
        }
        case 'c': {
          while (index < tokens.length && isNumberToken(tokens[index])) {
            const control1 = readPoint(relative);
            const control2 = readPoint(relative);
            const end = readPoint(relative);
            links.push({ from: current, to: control1 });
            links.push({ from: end, to: control2 });
            pushHandle(control1);
            pushHandle(control2);
            pushAnchor(end);
            current = end;
          }
          break;
        }
        case 'z': {
          if (subpathStart && !nearlyEqual(current, subpathStart)) {
            links.push({ from: current, to: subpathStart });
            pushAnchor(subpathStart);
            current = subpathStart;
          }
          break;
        }
        default:
          return null;
      }
    }
  });

  return { width, height, anchors, handles, links };
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export default function LogoCompareViewport({
  crop,
  labels,
  onCropChange,
  onPerspectiveChange,
  perspective,
  previewSvg,
  previewUrl,
  selectionMode,
  sourceUrl,
}: LogoCompareViewportProps) {
  const [mode, setMode] = useState<LogoCompareMode>(previewUrl ? 'split' : 'source');
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [showAnchors, setShowAnchors] = useState(false);
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
      if (event.ctrlKey) {
        const nextZoom = clampZoom(viewRef.current.zoom * (event.deltaY < 0 ? 1.2 : 0.8));
        if (nextZoom === viewRef.current.zoom) return;
        event.preventDefault();
        event.stopPropagation();
        updateZoom(nextZoom);
        return;
      }
      // UIUX (audit 2026-08-24 §LR5.09): ở 100% canvas không có vùng pan hữu
      // ích; để wheel truyền lên panel/trang thay vì tạo scroll trap.
      if (viewRef.current.zoom <= MIN_ZOOM) return;
      event.preventDefault();
      event.stopPropagation();
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

  const nudgeCropHandle = (index: number, dx: number, dy: number) => {
    const x1 = crop.x;
    const y1 = crop.y;
    const x2 = crop.x + crop.width;
    const y2 = crop.y + crop.height;
    const pointX = index === 0 || index === 3 ? x1 + dx : x2 + dx;
    const pointY = index === 0 || index === 1 ? y1 + dy : y2 + dy;
    const left = index === 0 || index === 3
      ? Math.min(x2 - MIN_CROP_PERCENT, Math.max(0, pointX))
      : x1;
    const right = index === 1 || index === 2
      ? Math.max(x1 + MIN_CROP_PERCENT, Math.min(100, pointX))
      : x2;
    const top = index === 0 || index === 1
      ? Math.min(y2 - MIN_CROP_PERCENT, Math.max(0, pointY))
      : y1;
    const bottom = index === 2 || index === 3
      ? Math.max(y1 + MIN_CROP_PERCENT, Math.min(100, pointY))
      : y2;
    onCropChange({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const handleCropKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const step = event.shiftKey ? 5 : 1;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    event.preventDefault();
    event.stopPropagation();
    nudgeCropHandle(index, dx, dy);
  };

  const handlePerspectiveKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const step = (event.shiftKey ? 5 : 1) / 100;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    event.preventDefault();
    event.stopPropagation();
    onPerspectiveChange(perspective.map((current, pointIndex) => (
      pointIndex === index
        ? { x: Math.min(1, Math.max(0, current.x + dx)), y: Math.min(1, Math.max(0, current.y + dy)) }
        : current
    )));
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

  const anchorOverlay = useMemo(() => parseSvgOverlay(previewSvg), [previewSvg]);

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
  const comparableCoordinates = selectionMode === 'full';
  const effectiveMode = !comparableCoordinates && (mode === 'split' || mode === 'overlay')
    ? 'source'
    : mode;



  return (
    <figure className="flex min-h-[320px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 xl:min-h-0">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex flex-wrap gap-1" role="group" aria-label={labels.viewport}>
          {(['source', 'vector', 'split', 'overlay'] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={effectiveMode === value}
              disabled={value !== 'source' && (!hasPreview || !comparableCoordinates)}
              onClick={() => setMode(value)}
              className="rounded border border-slate-200 px-2.5 py-1 text-xs font-semibold disabled:opacity-35 aria-pressed:border-violet-500 aria-pressed:bg-violet-50 aria-pressed:text-violet-700 dark:border-zinc-700 dark:aria-pressed:bg-violet-950/40 dark:aria-pressed:text-violet-200"
            >
              {{ source: labels.source, vector: labels.vector, split: labels.split, overlay: labels.overlay }[value]}
            </button>
          ))}
        </div>
        {!comparableCoordinates && (
          <span role="status" className="basis-full rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            {labels.comparisonWarning}
          </span>
        )}
        <div className="flex items-center gap-1 text-xs">
          <button type="button" aria-label={labels.zoomOut} onClick={() => updateZoom(viewRef.current.zoom - 0.25)} disabled={view.zoom <= MIN_ZOOM} className="h-7 w-7 rounded border border-slate-200 font-bold disabled:opacity-35 dark:border-zinc-700">−</button>
          <input aria-label={labels.zoomLevel} type="range" min={100} max={800} step={25} value={Math.round(view.zoom * 100)} onChange={event => updateZoom(Number(event.target.value) / 100)} className="w-28" />
          <button type="button" aria-label={labels.zoomIn} onClick={() => updateZoom(viewRef.current.zoom + 0.25)} disabled={view.zoom >= MAX_ZOOM} className="h-7 w-7 rounded border border-slate-200 font-bold disabled:opacity-35 dark:border-zinc-700">+</button>
          <button type="button" aria-label={labels.resetZoom} title={labels.resetZoom} onClick={resetView} className="min-w-14 rounded border border-slate-200 px-2 py-1 font-mono dark:border-zinc-700">{Math.round(view.zoom * 100)}%</button>
        </div>
        {effectiveMode === 'overlay' && hasPreview && (
          <label className="flex items-center gap-2 text-xs font-semibold">
            {labels.overlayOpacity}
            <input aria-label={labels.overlayOpacity} type="range" min={0} max={100} value={Math.round(overlayOpacity * 100)} onChange={event => setOverlayOpacity(Number(event.target.value) / 100)} className="w-24" />
          </label>
        )}
        {comparableCoordinates && hasPreview && previewSvg && anchorOverlay && (
          <label className="flex items-center gap-2 text-xs font-semibold">
            <input
              aria-label={labels.showAnchors}
              type="checkbox"
              checked={showAnchors}
              onChange={event => setShowAnchors(event.target.checked)}
            />
            {labels.showAnchors}
          </label>
        )}
      </figcaption>
      <div
        ref={frameRef}
        role="application"
        aria-label={labels.viewport}
        aria-describedby="logo-compare-keyboard-hint"
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
              {(effectiveMode === 'source' || effectiveMode === 'split' || effectiveMode === 'overlay') && <img src={sourceUrl} alt={labels.sourceAlt} draggable={false} className={imageClass} onLoad={event => setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />}
              {effectiveMode === 'vector' && hasPreview && <img src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} />}
              {effectiveMode === 'split' && hasPreview && (
                <div className="absolute inset-0" style={{ clipPath: 'inset(0 50% 0 0)' }}>
                  <img src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} />
                </div>
              )}
              {effectiveMode === 'overlay' && hasPreview && (
                <img data-testid="logo-overlay-layer" src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} style={{ opacity: overlayOpacity }} />
              )}
              {effectiveMode === 'split' && hasPreview && <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-0.5 bg-violet-500 shadow" />}
              {comparableCoordinates && hasPreview && previewSvg && anchorOverlay && showAnchors && (
                <svg
                  data-testid="logo-anchor-overlay"
                  aria-hidden="true"
                  viewBox={`0 0 ${anchorOverlay.width} ${anchorOverlay.height}`}
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 z-10 h-full w-full"
                >
                  <g fill="none" strokeLinecap="round" strokeLinejoin="round">
                    {anchorOverlay.links.map((link, index) => (
                      <line
                        key={`link-${index}`}
                        data-testid="logo-anchor-link"
                        x1={link.from.x}
                        y1={link.from.y}
                        x2={link.to.x}
                        y2={link.to.y}
                        stroke="rgba(148,163,184,0.7)"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                    {anchorOverlay.handles.map((point, index) => (
                      <circle
                        key={`handle-${index}`}
                        data-testid="logo-anchor-handle"
                        cx={point.x}
                        cy={point.y}
                        r={Math.max(1.25, Math.min(anchorOverlay.width, anchorOverlay.height) * 0.008)}
                        fill="rgba(16,185,129,0.9)"
                        stroke="white"
                        strokeWidth="0.8"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                    {anchorOverlay.anchors.map((point, index) => (
                      <circle
                        key={`anchor-${index}`}
                        data-testid="logo-anchor-point"
                        cx={point.x}
                        cy={point.y}
                        r={Math.max(1.6, Math.min(anchorOverlay.width, anchorOverlay.height) * 0.01)}
                        fill="rgba(59,130,246,0.95)"
                        stroke="white"
                        strokeWidth="0.9"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>
                </svg>
              )}
              {selectionMode !== 'full' && effectiveMode !== 'vector' && (
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
                          onKeyDown={event => handleCropKeyDown(event, index)}
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
                          onKeyDown={event => handlePerspectiveKeyDown(event, index)}
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
        <span id="logo-compare-keyboard-hint" className="absolute bottom-3 right-3 rounded bg-black/55 px-2 py-1 text-[11px] text-white">{labels.panHint} · {labels.keyboardHint}</span>
      </div>
    </figure>
  );
}
