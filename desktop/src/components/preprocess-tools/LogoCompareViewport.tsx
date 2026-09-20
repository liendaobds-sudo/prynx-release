import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { GripVertical, Trash2 } from 'lucide-react';

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
  emptyTitle?: string;
  emptyHint?: string;
  emptyFormat?: string;
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
  onDeletePath?: (pathIndex: number) => void;
  onUndoDeletePath?: () => void;
  canUndoDeletePath?: boolean;
  onPickFile?: () => void;
  actions?: React.ReactNode;
  className?: string;
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
  canUndoDeletePath = false,
  crop,
  labels,
  onCropChange,
  onDeletePath,
  onPerspectiveChange,
  onUndoDeletePath,
  perspective,
  previewSvg,
  previewUrl,
  selectionMode,
  sourceUrl,
  onPickFile,
  actions,
  className,
}: LogoCompareViewportProps) {
  const [mode, setMode] = useState<LogoCompareMode>(previewUrl ? 'split' : 'source');
  const prevPreviewUrlRef = useRef(previewUrl);
  useEffect(() => {
    if (!prevPreviewUrlRef.current && previewUrl) {
      setMode('split');
    } else if (prevPreviewUrlRef.current && !previewUrl) {
      setMode('source');
    }
    prevPreviewUrlRef.current = previewUrl;
  }, [previewUrl]);
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [showAnchors, setShowAnchors] = useState(false);
  const [isPickDeleteMode, setIsPickDeleteMode] = useState(false);
  const [hoveredPathIndex, setHoveredPathIndex] = useState<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
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

  // UIUX: Thao tác kéo trượt thanh chia đôi (split comparison slider)
  const updateSplitFromPointer = useCallback((clientX: number) => {
    const rect = artboardRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const raw = ((clientX - rect.left) / rect.width) * 100;
    setSplitPercent(Math.min(100, Math.max(0, raw)));
  }, []);

  const beginSplitDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Bỏ qua nếu môi trường không hỗ trợ pointer capture
    }
    setIsDraggingSplit(true);
    if (typeof event.clientX === 'number' && !Number.isNaN(event.clientX)) {
      updateSplitFromPointer(event.clientX);
    }
  }, [updateSplitFromPointer]);

  const moveSplitDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplit) return;
    event.preventDefault();
    event.stopPropagation();
    updateSplitFromPointer(event.clientX);
  }, [isDraggingSplit, updateSplitFromPointer]);

  const endSplitDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplit) return;
    setIsDraggingSplit(false);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Bỏ qua lỗi capture khi unmount / mouse release
    }
    event.stopPropagation();
  }, [isDraggingSplit]);

  useEffect(() => {
    if (!isDraggingSplit) return;
    const handlePointerMove = (event: PointerEvent) => {
      updateSplitFromPointer(event.clientX);
    };
    const handlePointerUp = () => {
      setIsDraggingSplit(false);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isDraggingSplit, updateSplitFromPointer]);

  const handleSplitKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') {
      setSplitPercent(prev => Math.max(0, prev - step));
    } else if (event.key === 'ArrowRight') {
      setSplitPercent(prev => Math.min(100, prev + step));
    } else if (event.key === 'Home') {
      setSplitPercent(0);
    } else if (event.key === 'End') {
      setSplitPercent(100);
    }
  }, []);

  const resetSplit = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    setSplitPercent(50);
  }, []);

  const parsedPaths = useMemo(() => {
    if (!previewSvg || typeof DOMParser === 'undefined') return [];
    try {
      const doc = new DOMParser().parseFromString(previewSvg, 'image/svg+xml');
      const nodes = Array.from(doc.querySelectorAll('path'));
      return nodes
        .map((node, index) => ({
          index,
          d: node.getAttribute('d') ?? '',
        }))
        .filter(item => Boolean(item.d));
    } catch {
      return [];
    }
  }, [previewSvg]);

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
    <figure className={`flex min-h-[320px] flex-col overflow-hidden ${className ?? 'rounded-xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900'} xl:min-h-0`}>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2">
          {Boolean(sourceUrl) ? (
            <>
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
              {comparableCoordinates && hasPreview && previewSvg && onDeletePath && (
                <div className="flex items-center gap-1.5 border-l border-slate-200 pl-2 dark:border-zinc-700">
                  <button
                    type="button"
                    aria-pressed={isPickDeleteMode}
                    onClick={() => setIsPickDeleteMode(prev => !prev)}
                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold transition-colors ${
                      isPickDeleteMode
                        ? 'bg-rose-600 text-white shadow-xs dark:bg-rose-500'
                        : 'border border-slate-200 text-slate-700 hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
                    }`}
                    title="Bật công cụ click trực tiếp vào vết bẩn/mảng rác trên vector để xóa"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>{isPickDeleteMode ? 'Đang nhặt rác' : 'Nhặt rác / Xóa mảng'}</span>
                  </button>
                  {isPickDeleteMode && canUndoDeletePath && onUndoDeletePath && (
                    <button
                      type="button"
                      onClick={onUndoDeletePath}
                      className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      title="Hoàn tác xóa mảng vừa rồi"
                    >
                      Hoàn tác
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-xs font-semibold text-slate-500 dark:text-zinc-400">
              {labels.viewport}
            </div>
          )}
        </div>
        {actions && (
          <div key="viewport-actions" className="flex items-center gap-1.5 ml-auto">
            {actions}
          </div>
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
          <div
            className="flex flex-col items-center justify-center p-8 md:p-12 text-center cursor-pointer select-none max-w-md animate-in fade-in duration-300"
            onClick={onPickFile}
          >
            <div className="w-24 h-24 md:w-28 md:h-28 rounded-3xl bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center text-5xl md:text-6xl mb-5 md:mb-6 shadow-md text-violet-600 hover:scale-105 transition-transform">
              🪄
            </div>
            <h2 className="text-xl md:text-2xl font-bold text-slate-800 dark:text-white mb-2 md:mb-3">
              {labels.emptyTitle ?? 'Vector hóa Logo'}
            </h2>
            <p className="text-slate-500 dark:text-zinc-400 text-xs md:text-sm leading-relaxed">
              {labels.emptyHint ?? 'Kéo thả ảnh logo vào đây hoặc bấm để chọn'}
            </p>
            <span className="mt-2 text-[11px] md:text-xs text-slate-400 dark:text-zinc-500">
              {labels.emptyFormat ?? 'Hỗ trợ PNG, JPEG, WebP (tối đa 500MB)'}
            </span>
            <span className="sr-only">{labels.noImage}</span>
          </div>
        ) : (
          <div data-testid="logo-compare-stage" className="absolute inset-0" style={{ transform, transformOrigin: 'center center' }}>
            <div ref={artboardRef} data-testid="logo-selection-artboard" className="absolute" style={artboardStyle}>
              {(effectiveMode === 'source' || effectiveMode === 'split' || effectiveMode === 'overlay') && <img src={sourceUrl} alt={labels.sourceAlt} draggable={false} className={imageClass} onLoad={event => setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />}
              {effectiveMode === 'vector' && hasPreview && <img src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} />}
              {effectiveMode === 'split' && hasPreview && (
                <div
                  data-testid="logo-split-vector-layer"
                  className="absolute inset-0 pointer-events-none"
                  style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
                >
                  <img src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} />
                </div>
              )}
              {effectiveMode === 'overlay' && hasPreview && (
                <img data-testid="logo-overlay-layer" src={previewUrl} alt={labels.previewAlt} draggable={false} className={imageClass} style={{ opacity: overlayOpacity }} />
              )}
              {effectiveMode === 'split' && hasPreview && (
                <>
                  {/* Nhãn nhận diện 2 bên */}
                  <div className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded bg-violet-600/85 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-xs backdrop-blur-xs select-none">
                    Vector
                  </div>
                  <div className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-xs backdrop-blur-xs select-none">
                    Ảnh gốc
                  </div>

                  {/* Thanh kéo chia đôi tương tác */}
                  <div
                    data-testid="logo-split-divider"
                    role="separator"
                    tabIndex={0}
                    aria-label="Thanh trượt so sánh chia đôi"
                    aria-orientation="vertical"
                    aria-valuenow={Math.round(splitPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    onPointerDown={beginSplitDrag}
                    onPointerMove={moveSplitDrag}
                    onPointerUp={endSplitDrag}
                    onPointerCancel={endSplitDrag}
                    onKeyDown={handleSplitKeyDown}
                    onDoubleClick={resetSplit}
                    className="group absolute inset-y-0 z-30 cursor-col-resize select-none"
                    style={{
                      left: `${splitPercent}%`,
                      transform: 'translateX(-50%)',
                      width: '28px',
                    }}
                    title="Kéo sang trái/phải để so sánh giữa Vector và Ảnh gốc (Nhấp đúp để đặt lại 50%)"
                  >
                    {/* Đường phân cách */}
                    <div
                      className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors ${
                        isDraggingSplit
                          ? 'bg-violet-600 shadow-[0_0_8px_rgba(139,92,246,0.6)]'
                          : 'bg-violet-500 shadow group-hover:bg-violet-600'
                      }`}
                    />
                    {/* Nút cầm kéo ở giữa */}
                    <div
                      className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center h-8 w-5 rounded-full bg-white dark:bg-zinc-800 border shadow-md transition-all ${
                        isDraggingSplit
                          ? 'scale-110 border-violet-500 ring-2 ring-violet-500/40'
                          : 'border-slate-300 dark:border-zinc-600 group-hover:scale-105 group-hover:border-violet-400'
                      }`}
                    >
                      <GripVertical className="h-3.5 w-3.5 text-slate-500 dark:text-zinc-400 group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors" />
                    </div>
                  </div>
                </>
              )}
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
              {comparableCoordinates && hasPreview && previewSvg && isPickDeleteMode && anchorOverlay && (
                <svg
                  data-testid="logo-pick-delete-overlay"
                  aria-label="Lớp nhặt rác trực tiếp trên vector"
                  viewBox={`0 0 ${anchorOverlay.width} ${anchorOverlay.height}`}
                  preserveAspectRatio="none"
                  className="absolute inset-0 z-15 h-full w-full"
                  style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
                >
                  {parsedPaths.map(item => (
                    <path
                      key={`pick-del-${item.index}`}
                      d={item.d}
                      fill={hoveredPathIndex === item.index ? 'rgba(244, 63, 94, 0.45)' : 'transparent'}
                      stroke={hoveredPathIndex === item.index ? '#e11d48' : 'transparent'}
                      strokeWidth={hoveredPathIndex === item.index ? 2 : 0}
                      vectorEffect="non-scaling-stroke"
                      className="cursor-pointer transition-colors"
                      onPointerEnter={e => {
                        e.stopPropagation();
                        setHoveredPathIndex(item.index);
                      }}
                      onPointerLeave={() => {
                        if (hoveredPathIndex === item.index) setHoveredPathIndex(null);
                      }}
                      onClick={e => {
                        e.stopPropagation();
                        onDeletePath?.(item.index);
                        setHoveredPathIndex(null);
                      }}
                    >
                      <title>Click để xóa mảng này khỏi vector</title>
                    </path>
                  ))}
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
