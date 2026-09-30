import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
} from 'react';
import { Hand, Pencil } from 'lucide-react';

import { tv } from '../../i18n';
import type { StickerCutlinePreview, StickerCutlineBoundingBox } from '../../lib/stickerSheetApi';
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
    /** Zoom đang hiển thị; Viewer truyền vào khi embedded, workspace dùng zoom nội bộ. */
    cutlineDisplayZoom?: number;
}

/**
 * UIUX (feedback 2026-08-20 §CUTPREVIEW.ZOOM1): zoom nhỏ cần dễ thấy, zoom
 * lớn phải thu mảnh để không che mép tem và vùng bù xén.
 */
function resolveStickerCutlineStrokeWidth(
    displayZoom: number | undefined,
    base: number = 2,
): number {
    const zoom = Number.isFinite(displayZoom) && Number(displayZoom) > 0
        ? Number(displayZoom)
        : 1;
    // UIUX (feedback 2026-09-07 §CUTPREVIEW.PARITY): classic không có selected ID
    // vẫn phải rõ như nhiều tem; phân biệt lựa chọn bằng màu, không làm mờ nét còn lại.
    // base configurable
    const min = 1;
    const max = 3;
    const width = Math.max(min, Math.min(max, base / Math.sqrt(zoom)));
    return Math.round(width * 100) / 100;
}

import type { ClassicCutlineThrucutPreviewConfig } from '../../stores/useWorkspaceStore';

function computePathsBoundingBox(paths: Array<{ d: string }>): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let found = false;

    for (const p of paths) {
        const matches = p.d.match(/-?\d+(?:\.\d+)?/g);
        if (!matches || matches.length < 2) continue;
        for (let i = 0; i < matches.length - 1; i += 2) {
            const x = Number(matches[i]);
            const y = Number(matches[i + 1]);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                found = true;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    return found ? { minX, minY, maxX, maxY } : null;
}

function buildSvgRoundedRect(
    left: number,
    top: number,
    right: number,
    bottom: number,
    radius: number,
): string {
    const x0 = left;
    const y0 = top;
    const x1 = right;
    const y1 = bottom;
    const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
    if (r <= 0.05) {
        return `M ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x0.toFixed(2)} ${y1.toFixed(2)} Z`;
    }
    const k = r * 0.5522847498307936;
    return [
        `M ${(x0 + r).toFixed(2)} ${y0.toFixed(2)}`,
        `L ${(x1 - r).toFixed(2)} ${y0.toFixed(2)}`,
        `C ${(x1 - r + k).toFixed(2)} ${y0.toFixed(2)} ${x1.toFixed(2)} ${(y0 + r - k).toFixed(2)} ${x1.toFixed(2)} ${(y0 + r).toFixed(2)}`,
        `L ${x1.toFixed(2)} ${(y1 - r).toFixed(2)}`,
        `C ${x1.toFixed(2)} ${(y1 - r + k).toFixed(2)} ${(x1 - r + k).toFixed(2)} ${y1.toFixed(2)} ${(x1 - r).toFixed(2)} ${y1.toFixed(2)}`,
        `L ${(x0 + r).toFixed(2)} ${y1.toFixed(2)}`,
        `C ${(x0 + r - k).toFixed(2)} ${y1.toFixed(2)} ${x0.toFixed(2)} ${(y1 - r + k).toFixed(2)} ${x0.toFixed(2)} ${(y1 - r).toFixed(2)}`,
        `L ${x0.toFixed(2)} ${(y0 + r).toFixed(2)}`,
        `C ${x0.toFixed(2)} ${(y0 + r - k).toFixed(2)} ${(x0 + r - k).toFixed(2)} ${y0.toFixed(2)} ${(x0 + r).toFixed(2)} ${y0.toFixed(2)}`,
        'Z',
    ].join(' ');
}

function buildThrucutSvgPath(
    preview: StickerCutlinePreview,
    thrucut: ClassicCutlineThrucutPreviewConfig,
): string | null {
    if (!thrucut.enabled || !preview.paths || preview.paths.length === 0) return null;
    const bbox = computePathsBoundingBox(preview.paths);
    const box = bbox || {
        minX: 0,
        minY: 0,
        maxX: preview.preview_width_px,
        maxY: preview.preview_height_px,
    };

    const scaleMmToPx = preview.preview_width_px / 100;
    const defaultMarginPx = thrucut.marginPx !== undefined
        ? thrucut.marginPx
        : thrucut.marginMm * scaleMmToPx;

    const mTop = thrucut.marginTopPx !== undefined
        ? thrucut.marginTopPx
        : (thrucut.marginTopMm !== undefined ? thrucut.marginTopMm * scaleMmToPx : defaultMarginPx);

    const mBottom = thrucut.marginBottomPx !== undefined
        ? thrucut.marginBottomPx
        : (thrucut.marginBottomMm !== undefined ? thrucut.marginBottomMm * scaleMmToPx : defaultMarginPx);

    const mLeft = thrucut.marginLeftPx !== undefined
        ? thrucut.marginLeftPx
        : (thrucut.marginLeftMm !== undefined ? thrucut.marginLeftMm * scaleMmToPx : defaultMarginPx);

    const mRight = thrucut.marginRightPx !== undefined
        ? thrucut.marginRightPx
        : (thrucut.marginRightMm !== undefined ? thrucut.marginRightMm * scaleMmToPx : defaultMarginPx);

    const radius = thrucut.radiusPx !== undefined
        ? thrucut.radiusPx
        : thrucut.radiusMm * scaleMmToPx;

    const x0 = box.minX - mLeft;
    const y0 = box.minY - mTop;
    const x1 = box.maxX + mRight;
    const y1 = box.maxY + mBottom;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return null;

    if (thrucut.shape === 'ellipse') {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rx = w / 2;
        const ry = h / 2;
        return `M ${(cx - rx).toFixed(2)} ${cy.toFixed(2)} a ${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 0 ${(2 * rx).toFixed(2)} 0 a ${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 0 ${(-2 * rx).toFixed(2)} 0 Z`;
    }

    return buildSvgRoundedRect(x0, y0, x1, y1, radius);
}

/** SVG đường bế dùng chung cho workspace AI và overlay classic trên Viewer. */
export function resolveCutlineBoundingBoxes(
    preview: StickerCutlinePreview,
    pageWidthMm?: number,
): StickerCutlineBoundingBox[] {
    if (preview.bounding_boxes && preview.bounding_boxes.length > 0) {
        return preview.bounding_boxes;
    }

    if (!preview.paths || preview.paths.length === 0) return [];

    const scale = (pageWidthMm && pageWidthMm > 0 && preview.preview_width_px > 0)
        ? preview.preview_width_px / pageWidthMm
        : (preview.preview_width_px > 0 ? preview.preview_width_px / 100 : 1);

    const boxes: StickerCutlineBoundingBox[] = [];
    let boxIndex = 1;

    for (const path of preview.paths) {
        const subpaths = path.d.split(/(?=[Mm])/g).filter(s => s.trim().length > 0);
        for (const sub of subpaths) {
            const matches = sub.match(/-?\d+(?:\.\d+)?/g);
            if (!matches || matches.length < 2) continue;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < matches.length - 1; i += 2) {
                const x = Number(matches[i]);
                const y = Number(matches[i + 1]);
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
            const width_px = maxX - minX;
            const height_px = maxY - minY;
            if (width_px < 3 || height_px < 3) continue;

            const width_mm = scale > 0 ? Number((width_px / scale).toFixed(1)) : 0;
            const height_mm = scale > 0 ? Number((height_px / scale).toFixed(1)) : 0;

            boxes.push({
                id: boxIndex++,
                x_px: Number(minX.toFixed(1)),
                y_px: Number(minY.toFixed(1)),
                width_px: Number(width_px.toFixed(1)),
                height_px: Number(height_px.toFixed(1)),
                width_mm,
                height_mm,
            });
        }
    }

    const nonHoles = boxes.filter((b1, i) => {
        return !boxes.some((b2, j) => {
            if (i === j) return false;
            const isInside = (
                b1.x_px >= b2.x_px - 0.5 &&
                b1.x_px + b1.width_px <= b2.x_px + b2.width_px + 0.5 &&
                b1.y_px >= b2.y_px - 0.5 &&
                b1.y_px + b1.height_px <= b2.y_px + b2.height_px + 0.5
            );
            return isInside && (b1.width_px * b1.height_px < b2.width_px * b2.height_px);
        });
    });

    return nonHoles.map((box, idx) => ({ ...box, id: idx + 1 }));
}

export function StickerCutlineOverlay({
    preview,
    selectedInstanceId,
    displayZoom = 1,
    thrucut,
    showDimensions = true,
}: {
    preview: StickerCutlinePreview;
    selectedInstanceId: number | null;
    displayZoom?: number;
    thrucut?: ClassicCutlineThrucutPreviewConfig | null;
    showDimensions?: boolean;
}) {
    const thrucutPath = thrucut?.enabled ? buildThrucutSvgPath(preview, thrucut) : null;
    const boundingBoxes = useMemo(() => resolveCutlineBoundingBoxes(preview), [preview]);

    return (
        <>
            <svg
                data-testid="sticker-cutline-preview"
                viewBox={`0 0 ${preview.preview_width_px} ${preview.preview_height_px}`}
                preserveAspectRatio="none"
                aria-label={tv('Đường bế xem trước', 'preprocess.stickerSheet')}
                className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
            >
                {/* Dao 1: KissCut viền tem */}
                {preview.paths.map(path => {
                    const selected = selectedInstanceId === path.instance_id;
                    return (
                        <path
                            key={path.instance_id}
                            data-cutline-layer="main"
                            d={path.d}
                            fill="none"
                            stroke={selected ? '#d946ef' : '#7c3aed'}
                            strokeWidth={resolveStickerCutlineStrokeWidth(displayZoom)}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    );
                })}

                {/* Dao 2: ThruCut ngoài cùng (nét liền) */}
                {thrucutPath && (
                    <path
                        key="thrucut-path"
                        data-testid="sticker-thrucut-preview-path"
                        data-cutline-layer="thrucut"
                        d={thrucutPath}
                        fill="none"
                        stroke={thrucut?.color || '#00e5ff'}
                        strokeWidth={resolveStickerCutlineStrokeWidth(displayZoom)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                    />
                )}

            </svg>

            {/* Nhãn kích thước hiển thị rõ cho từng loại đường bế (HTML Overlay) */}
            {showDimensions && boundingBoxes.map((box) => {
                const leftPct = ((box.x_px + box.width_px / 2) / preview.preview_width_px) * 100;
                const baseTopPct = ((box.y_px + box.height_px) / preview.preview_height_px) * 100;
                const isNearBottom = baseTopPct > 93;
                const topPct = isNearBottom
                    ? (box.y_px / preview.preview_height_px) * 100
                    : baseTopPct;

                const mTopMm = thrucut?.enabled ? (thrucut.marginTopMm ?? thrucut.marginMm ?? 0) : 0;
                const mBottomMm = thrucut?.enabled ? (thrucut.marginBottomMm ?? thrucut.marginMm ?? 0) : 0;
                const mLeftMm = thrucut?.enabled ? (thrucut.marginLeftMm ?? thrucut.marginMm ?? 0) : 0;
                const mRightMm = thrucut?.enabled ? (thrucut.marginRightMm ?? thrucut.marginMm ?? 0) : 0;

                const thrucutW = thrucut?.enabled ? (box.width_mm + mLeftMm + mRightMm) : 0;
                const thrucutH = thrucut?.enabled ? (box.height_mm + mTopMm + mBottomMm) : 0;

                return (
                    <div
                        key={`badge-${box.id}`}
                        data-testid={`sticker-bbox-badge-${box.id}`}
                        className="pointer-events-none absolute select-none z-20 flex items-center justify-center"
                        style={{
                            left: `${leftPct}%`,
                            top: `${topPct}%`,
                            transform: isNearBottom ? 'translate(-50%, -100%)' : 'translate(-50%, 6px)',
                        }}
                    >
                        <div className="inline-flex flex-col gap-0.5 px-2 py-1 rounded text-[11px] font-mono font-medium tracking-tight bg-slate-950/90 border border-slate-700/80 shadow-md backdrop-blur-[2px] whitespace-nowrap text-left">
                            <div className="flex items-center gap-1.5 text-fuchsia-300">
                                <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400 shrink-0 inline-block" />
                                <span className="text-[10px] text-slate-400 font-sans">{boundingBoxes.length > 1 ? `K${box.id} Bế trong:` : 'Bế trong:'}</span>
                                <span className="font-semibold">{box.width_mm.toFixed(1)} × {box.height_mm.toFixed(1)} mm</span>
                            </div>
                            {thrucut?.enabled && (
                                <div className="flex items-center gap-1.5 text-cyan-300 border-t border-slate-800 pt-0.5">
                                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shrink-0 inline-block" />
                                    <span className="text-[10px] text-slate-400 font-sans">{boundingBoxes.length > 1 ? `K${box.id} Dao ngoài:` : 'Dao ngoài:'}</span>
                                    <span className="font-semibold">{thrucutW.toFixed(1)} × {thrucutH.toFixed(1)} mm</span>
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
        </>
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
    cutlineDisplayZoom,
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
    const sourcePreviewLoading = Boolean(state.inspection && !state.sourcePreviewReady);
    const sourcePreviewVisible = Boolean(
        state.sourceFile
        && state.sourcePreviewReady
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
                        : state.status === 'inspecting' || sourcePreviewLoading
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
                    <StickerCutlineOverlay
                        preview={cutlinePreview}
                        selectedInstanceId={state.selectedInstanceId}
                        displayZoom={cutlineDisplayZoom}
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
                            <StickerCutlineOverlay
                                preview={cutlinePreview}
                                selectedInstanceId={state.selectedInstanceId}
                                displayZoom={cutlineDisplayZoom ?? zoom}
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
