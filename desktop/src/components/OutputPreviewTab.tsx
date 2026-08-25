import React, { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl } from '../lib/api';
import {
    buildColorManagedPlateCompositeOverlay,
    type OutputPreviewPageBoxes,
    type OutputPreviewPageBoxKind,
    type PlateOverlay,
} from '../lib/outputPreviewOverlay';
import {
    clampOutputPreviewPanelOffset,
    OUTPUT_PREVIEW_WORKSPACE_GAP_PX,
} from '../lib/outputPreviewPanelLayout';
import type {
    OutputPreviewWorkerRequest,
    OutputPreviewWorkerRequestPayload,
    OutputPreviewWorkerResponse,
} from '../lib/outputPreviewPixels';
import { sampleOutputPreviewInk } from '../lib/outputPreviewSampling';
import { useWorkspaceStore, WorkspaceContext } from '../stores/useWorkspaceStore';
import type {
    OutputPreviewMode,
    OutputPreviewRenderingIntent,
    OutputPreviewRgb,
    OutputPreviewShowFilter,
} from '../stores/useWorkspaceStore';
import { useWorkspaceToolActivationGuard } from '../hooks/useToolActivationGuard';
import { useImposerSettingsStore } from './imposition-tools/useImposerSettingsStore';
import SoftProofPanel from './SoftProofPanel';
import { toast } from './ui/Toast';
import { useTranslation } from 'react-i18next';
import { resolveViewerPageIdentity } from '../lib/viewerPageIdentity';

interface PlateInfo {
    name: string;
    color: number[];
    alpha_data: string;
    is_spot?: boolean;
    alternate_cmyk_lut?: number[][] | null;
}

type PlateListItem = PlateInfo & { dataUrl: string };

interface SpotInkMeta {
    name: string;
    rgb: number[];
    coverage_pct: number;
    is_pantone: boolean;
}

interface SeparationsData {
    width: number;
    height: number;
    render_dpi?: number;
    plates: PlateInfo[];
    spot_inks?: SpotInkMeta[];
    has_spot_colors?: boolean;
    detected_spots?: string[];
    engine?: string;
    accuracy?: string;
    quality_note?: string;
    page_has_transparency?: boolean;
    blending_color_space?: string;
    output_preview_filter?: OutputPreviewShowFilter;
}

export type { PlateOverlay } from '../lib/outputPreviewOverlay';


interface OutputPreviewTabProps {
    fileId: string;
    initialPageNum?: number;
    totalPages?: number;
    onClose: () => void;
    onPlatesChange?: (plates: PlateOverlay[]) => void;
    onFileFixed?: (blob: Blob, name: string) => void;
}

interface IccProfile {
    id: string;
    name: string;
    description: string;
    available: boolean;
}

const PAGE_BOX_LABEL_KEYS: Record<OutputPreviewPageBoxKind, string> = {
    bleedbox: 'misc.cropDialog:bleedbox_tran_le',
    trimbox: 'misc.cropDialog:trimbox_thanh_pham',
    artbox: 'misc.cropDialog:artbox_noi_dung',
};

const PAGE_BOX_LINE_CLASSES: Record<OutputPreviewPageBoxKind, string> = {
    bleedbox: 'border-blue-500',
    trimbox: 'border-emerald-500',
    artbox: 'border-rose-500',
};

function outputPreviewErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return fallback;
}

function isPageBoxMm(value: unknown): value is OutputPreviewPageBoxes['cropbox'] {
    if (!value || typeof value !== 'object') return false;
    const box = value as Record<string, unknown>;
    return ['x0', 'y0', 'x1', 'y1', 'width', 'height']
        .every(key => typeof box[key] === 'number' && Number.isFinite(box[key]));
}

function parseOutputPreviewPageBoxes(
    value: unknown,
    viewerPageNum: number,
    sourcePageNum: number,
): OutputPreviewPageBoxes | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as Record<string, unknown>;
    if (
        Number(response.page) !== sourcePageNum
        || !isPageBoxMm(response.cropbox)
        || !isPageBoxMm(response.trimbox)
        || !isPageBoxMm(response.bleedbox)
        || !isPageBoxMm(response.artbox)
    ) return null;

    const rawRotation = Number(response.rotation);
    const normalizedRotation = Number.isFinite(rawRotation)
        ? ((Math.trunc(rawRotation) % 360) + 360) % 360
        : 0;

    return {
        viewerPageNum,
        sourcePageNum,
        cropbox: response.cropbox,
        trimbox: response.trimbox,
        bleedbox: response.bleedbox,
        artbox: response.artbox,
        has_trimbox: response.has_trimbox === true,
        has_bleedbox: response.has_bleedbox === true,
        has_artbox: response.has_artbox === true,
        rotation: normalizedRotation === 90 || normalizedRotation === 180 || normalizedRotation === 270
            ? normalizedRotation
            : 0,
    };
}

const SIMULATION_INTENTS: OutputPreviewRenderingIntent[] = [
    'perceptual',
    'relative',
    'saturation',
    'absolute',
];

const OUTPUT_PREVIEW_SHOW_FILTERS: OutputPreviewShowFilter[] = [
    'all',
    'device-cmyk',
    'device-rgb',
    'device-gray',
    'spot',
    'text',
    'images',
    'line-art',
    'smooth-shades',
];

const OUTPUT_PREVIEW_MODES: OutputPreviewMode[] = [
    'separations',
    'color-warnings',
];

function rgbToHex(rgb: OutputPreviewRgb | null): string {
    const source = rgb ?? [255, 255, 255];
    return `#${source.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(value: string): OutputPreviewRgb | null {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) return null;
    return [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
    ];
}

const PROCESS_NAMES = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);
const PROCESS_PLATE_LABELS: Record<string, string> = {
    Cyan: 'Process Cyan',
    Magenta: 'Process Magenta',
    Yellow: 'Process Yellow',
    Black: 'Process Black',
};

function OutputPreviewSection({
    id,
    title,
    defaultOpen = false,
    warning = false,
    children,
}: {
    id: string;
    title: string;
    defaultOpen?: boolean;
    warning?: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const contentId = `output-preview-section-${id}`;
    return (
        // UIUX (audit 2026-08-10 §OP.12): mỗi section giữ chiều cao nội dung;
        // vùng cuộn của panel mới là nơi co/scroll khi không đủ chiều cao.
        <section
            data-output-preview-section={id}
            className={`shrink-0 overflow-hidden rounded-lg border ${
                warning
                    ? 'border-amber-200 bg-amber-50/40 dark:border-amber-900/60 dark:bg-amber-950/15'
                    : 'border-slate-200 bg-white dark:border-zinc-700 dark:bg-zinc-900'
            }`}
        >
            <button
                type="button"
                aria-expanded={open}
                aria-controls={contentId}
                onClick={() => setOpen(current => !current)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-bold uppercase tracking-widest ${
                    warning
                        ? 'text-amber-700 hover:bg-amber-100/60 dark:text-amber-300 dark:hover:bg-amber-900/20'
                        : 'text-slate-500 hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                }`}
            >
                <span>{title}</span>
                <svg
                    className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                >
                    <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                </svg>
            </button>
            {open && (
                <div id={contentId} className="border-t border-inherit p-2.5">
                    {children}
                </div>
            )}
        </section>
    );
}

interface PendingWorkerRequest {
    resolve: (response: OutputPreviewWorkerResponse) => void;
    reject: (error: Error) => void;
}

export default function OutputPreviewTab({ fileId, initialPageNum = 1, totalPages = 1, onClose, onPlatesChange, onFileFixed }: OutputPreviewTabProps) {
  const { t } = useTranslation();
    const workspaceStore = React.useContext(WorkspaceContext)!;
    const setActiveDashboardTool = useImposerSettingsStore(state => state.setActiveDashboardTool);
    const requestWorkspaceToolActivation = useWorkspaceToolActivationGuard();
    const viewerActivePage = useWorkspaceStore(s => s.viewerActivePage);
    const viewerPageOrder = useWorkspaceStore(s => s.viewerPageOrder);
    const setTacHeatmapUrl = useWorkspaceStore(s => s.setTacHeatmapUrl);
    const setSoftProofImageUrl = useWorkspaceStore(s => s.setSoftProofImageUrl);
    const setGamutWarningUrl = useWorkspaceStore(s => s.setGamutWarningUrl);
    const setSoftProofActive = useWorkspaceStore(s => s.setSoftProofActive);
    const setOverprintPreviewUrl = useWorkspaceStore(s => s.setOverprintPreviewUrl);
    const simulationProfileId = useWorkspaceStore(s => s.outputPreviewProfileId);
    const simulationIntent = useWorkspaceStore(s => s.outputPreviewRenderingIntent);
    const showFilter = useWorkspaceStore(s => s.outputPreviewShowFilter);
    const previewMode = useWorkspaceStore(s => s.outputPreviewMode);
    const simulatePaperColor = useWorkspaceStore(s => s.outputPreviewSimulatePaperColor);
    const simulateBlackInk = useWorkspaceStore(s => s.outputPreviewSimulateBlackInk);
    const pageBackgroundRgb = useWorkspaceStore(s => s.outputPreviewPageBackgroundRgb);
    const warningOpacity = useWorkspaceStore(s => s.outputPreviewWarningOpacity);
    const outputPreviewPageBoxes = useWorkspaceStore(s => s.outputPreviewPageBoxes);
    const showPageBoxes = useWorkspaceStore(s => s.outputPreviewShowPageBoxes);
    const setSimulationProfileId = useWorkspaceStore(s => s.setOutputPreviewProfileId);
    const setSimulationIntent = useWorkspaceStore(s => s.setOutputPreviewRenderingIntent);
    const setShowFilter = useWorkspaceStore(s => s.setOutputPreviewShowFilter);
    const setPreviewMode = useWorkspaceStore(s => s.setOutputPreviewMode);
    const setSimulatePaperColor = useWorkspaceStore(s => s.setOutputPreviewSimulatePaperColor);
    const setSimulateBlackInk = useWorkspaceStore(s => s.setOutputPreviewSimulateBlackInk);
    const setPageBackgroundRgb = useWorkspaceStore(s => s.setOutputPreviewPageBackgroundRgb);
    const setWarningOpacity = useWorkspaceStore(s => s.setOutputPreviewWarningOpacity);
    const setOutputPreviewActiveViewerPage = useWorkspaceStore(s => s.setOutputPreviewActiveViewerPage);
    const setOutputPreviewPageBoxes = useWorkspaceStore(s => s.setOutputPreviewPageBoxes);
    const setShowPageBoxes = useWorkspaceStore(s => s.setOutputPreviewShowPageBoxes);
    const initialViewerPage = Math.min(totalPages, Math.max(1, viewerActivePage || initialPageNum));
    const [pageNum, setPageNum] = useState(initialViewerPage);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    // GS-SUNSET (audit 2026-08-08 §GS.4): mode nói theo độ chính xác, không theo engine cũ.
    const [useAccuratePreview, setUseAccuratePreview] = useState(true);
    const filterRequiresPpe = showFilter !== 'all';
    const effectiveAccuratePreview = useAccuratePreview || filterRequiresPpe;
    const [convertingSpot, setConvertingSpot] = useState('');

    const [plateList, setPlateList] = useState<PlateListItem[]>([]);
    const [visiblePlates, setVisiblePlates] = useState<Set<string>>(new Set());
    const [soloPlate, setSoloPlate] = useState<string | null>(null);
    
    const [pageHasTransparency, setPageHasTransparency] = useState(false);
    const [blendingColorSpace, setBlendingColorSpace] = useState('DeviceCMYK');
    const [tacThreshold, setTacThreshold] = useState(280);
    const [showTacWarning, setShowTacWarning] = useState(false);
    const [sampleDiameterMm, setSampleDiameterMm] = useState(0);
    const [spotInksMeta, setSpotInksMeta] = useState<SpotInkMeta[]>([]);
    const [engineUsed, setEngineUsed] = useState('');
    const [accuracyLabel, setAccuracyLabel] = useState('');
    const [qualityNote, setQualityNote] = useState('');
    const [detectedSpots, setDetectedSpots] = useState<string[]>([]);
    const [profiles, setProfiles] = useState<IccProfile[]>([]);
    const [showSoftProof, setShowSoftProof] = useState(false);
    const [showTacHeatmap, setShowTacHeatmap] = useState(false);
    const [simulateOverprint, setSimulateOverprint] = useState(false);
    const [pageBoxesLoading, setPageBoxesLoading] = useState(false);
    const [pageBoxesError, setPageBoxesError] = useState('');
    
    const isRipResult =
        accuracyLabel === 'rip_separations'
        || accuracyLabel === 'rip_separations_approx_geometry';
    const engineDisplayName = engineUsed === 'ppe' ? 'PrynX PPE' : engineUsed;


    const plateDataRef = React.useRef<{
        width: number;
        height: number;
        renderDpi: number;
        outputPreviewFilter: OutputPreviewShowFilter;
        arrays: Record<string, Uint8ClampedArray>;
    } | null>(null);
    const pctRefs = React.useRef<Record<string, HTMLSpanElement | null>>({});
    const tacRef = React.useRef<HTMLSpanElement | null>(null);
    const sampleMetaRef = React.useRef<HTMLSpanElement | null>(null);
    const previewWorkerRef = React.useRef<Worker | null>(null);
    const workerRequestIdRef = React.useRef(0);
    const pendingWorkerRequestsRef = React.useRef(new Map<number, PendingWorkerRequest>());
    const plateObjectUrlsRef = React.useRef<string[]>([]);
    const compositeAbortRef = React.useRef<AbortController | null>(null);
    const compositeGenerationRef = React.useRef(0);
    const compositeObjectUrlRef = React.useRef<string | null>(null);
    const tacObjectUrlRef = React.useRef<string | null>(null);
    const onPlatesChangeRef = React.useRef(onPlatesChange);
    // UIUX (audit 2026-08-22 §UX.VIEW.02): fileId luôn trỏ tới Working PDF đã
    // materialize theo thứ tự Viewer. `pageNum` vì vậy chính là trang của file này;
    // map thêm viewerPageOrder sẽ đảo ngược lần thứ hai sau reorder.
    const sourcePageNum = pageNum;
    const viewerSourcePageNum = resolveViewerPageIdentity({
        viewerPosition: pageNum,
        pageOrder: viewerPageOrder,
    }).sourcePage ?? pageNum;

    const openRelatedTool = useCallback((tool: 'inkmanager' | 'crop') => {
        requestWorkspaceToolActivation(tool, () => {
            // UIUX (audit 2026-08-10 §OP.11): đóng lớp preview trước khi mở
            // công cụ sửa file để hai ngữ cảnh không chồng lên nhau.
            setActiveDashboardTool(tool);
            onClose();
        });
    }, [onClose, requestWorkspaceToolActivation, setActiveDashboardTool]);

    useEffect(() => {
        let cancelled = false;
        void authenticatedFetch(`${getApiUrl()}/preflight/icc-profiles`)
            .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
            .then(data => {
                if (!cancelled) setProfiles(data.profiles || []);
            })
            .catch(() => {
                if (!cancelled) setProfiles([]);
            });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        onPlatesChangeRef.current = onPlatesChange;
    }, [onPlatesChange]);

    const disposePreviewWorker = useCallback(() => {
        const worker = previewWorkerRef.current;
        previewWorkerRef.current = null;
        worker?.terminate();
        const error = new Error('Tác vụ dựng Output Preview đã bị hủy.');
        for (const pending of pendingWorkerRequestsRef.current.values()) {
            pending.reject(error);
        }
        pendingWorkerRequestsRef.current.clear();
    }, []);

    const createPreviewWorker = useCallback(() => {
        disposePreviewWorker();
        const worker = new Worker(
            new URL('../workers/outputPreview.worker.ts', import.meta.url),
            { type: 'module' },
        );
        previewWorkerRef.current = worker;
        worker.onmessage = (event: MessageEvent<OutputPreviewWorkerResponse>) => {
            const response = event.data;
            const pending = pendingWorkerRequestsRef.current.get(response.requestId);
            if (!pending) return;
            pendingWorkerRequestsRef.current.delete(response.requestId);
            if (response.type === 'error') {
                pending.reject(new Error(response.message));
            } else {
                pending.resolve(response);
            }
        };
        worker.onerror = (event) => {
            const error = new Error(event.message || 'Web Worker Output Preview gặp lỗi.');
            for (const pending of pendingWorkerRequestsRef.current.values()) {
                pending.reject(error);
            }
            pendingWorkerRequestsRef.current.clear();
            if (previewWorkerRef.current === worker) previewWorkerRef.current = null;
            worker.terminate();
        };
        return worker;
    }, [disposePreviewWorker]);

    const sendPreviewWorkerRequest = useCallback((
        worker: Worker,
        payload: OutputPreviewWorkerRequestPayload,
    ): Promise<OutputPreviewWorkerResponse> => {
        if (previewWorkerRef.current !== worker) {
            return Promise.reject(new Error('Web Worker Output Preview không còn hoạt động.'));
        }
        const requestId = ++workerRequestIdRef.current;
        const request = { ...payload, requestId } as OutputPreviewWorkerRequest;
        return new Promise((resolve, reject) => {
            pendingWorkerRequestsRef.current.set(requestId, { resolve, reject });
            try {
                worker.postMessage(request);
            } catch (error) {
                pendingWorkerRequestsRef.current.delete(requestId);
                reject(error instanceof Error ? error : new Error('Không gửi được dữ liệu tới worker.'));
            }
        });
    }, []);

    const revokePlateObjectUrls = useCallback(() => {
        for (const url of plateObjectUrlsRef.current) URL.revokeObjectURL(url);
        plateObjectUrlsRef.current = [];
    }, []);

    const clearColorManagedPlateComposite = useCallback(() => {
        compositeGenerationRef.current += 1;
        compositeAbortRef.current?.abort();
        compositeAbortRef.current = null;
        if (compositeObjectUrlRef.current) {
            URL.revokeObjectURL(compositeObjectUrlRef.current);
            compositeObjectUrlRef.current = null;
        }
        onPlatesChangeRef.current?.([]);
    }, []);

    const clearTacHeatmap = useCallback(() => {
        if (tacObjectUrlRef.current) URL.revokeObjectURL(tacObjectUrlRef.current);
        tacObjectUrlRef.current = null;
        setTacHeatmapUrl(null);
    }, [setTacHeatmapUrl]);

    // UIUX (fix preview đa kích thước 2026-07-28): khi đổi trang phải bỏ mọi
    // bitmap của trang cũ trước khi viewer nhận trang mới, tránh một frame nháy sai tỷ lệ.
    const clearPagePreview = useCallback(() => {
        disposePreviewWorker();
        revokePlateObjectUrls();
        clearColorManagedPlateComposite();
        clearTacHeatmap();
        plateDataRef.current = null;
        setPlateList([]);
        setVisiblePlates(new Set());
        setSoftProofImageUrl(null);
        setGamutWarningUrl(null);
        setSoftProofActive(false);
        setOverprintPreviewUrl(null);
        // UIUX (audit 2026-08-10 §OP.E3): PageBox có vòng đời độc lập theo
        // file/trang. Đổi profile/intent chỉ dựng lại bản kẽm, không được xóa box
        // rồi để checkbox bị khóa vì effect PageBox không có dependency màu.
        setSimulateOverprint(false);
    }, [
        clearTacHeatmap,
        clearColorManagedPlateComposite,
        disposePreviewWorker,
        revokePlateObjectUrls,
        setGamutWarningUrl,
        setOverprintPreviewUrl,
        setSoftProofActive,
        setSoftProofImageUrl,
    ]);

    const navigatePreviewPage = useCallback((requestedPage: number) => {
        const nextPage = Math.min(totalPages, Math.max(1, requestedPage));
        if (nextPage === pageNum) return;
        clearPagePreview();
        setPageNum(nextPage);
        window.dispatchEvent(new CustomEvent('prynx-menu-command', {
            detail: { cmd: 'go-to-page', page: nextPage },
        }));
    }, [clearPagePreview, pageNum, totalPages]);

    // Cuộn/chuyển trang từ viewer cũng phải kéo Output Preview theo cùng một trang.
    useEffect(() => {
        const nextPage = Math.min(totalPages, Math.max(1, viewerActivePage));
        if (nextPage === pageNum) return;
        clearPagePreview();
        setPageNum(nextPage);
    }, [clearPagePreview, pageNum, totalPages, viewerActivePage]);

    useEffect(() => {
        setOutputPreviewActiveViewerPage(pageNum);
        return () => setOutputPreviewActiveViewerPage(null);
    }, [pageNum, setOutputPreviewActiveViewerPage]);

    // PAGEBOX (audit 2026-08-10 §OP.E3): đọc box thật của trang nguồn và gắn
    // viewerPageNum để response cũ/khác frame không thể vẽ lên trang hiện tại.
    useEffect(() => {
        let active = true;
        const controller = new AbortController();
        setPageBoxesLoading(true);
        setPageBoxesError('');
        setOutputPreviewPageBoxes(null);

        void authenticatedFetch(
            `${getApiUrl()}/preflight/page-boxes/${fileId}/${sourcePageNum}`,
            { signal: controller.signal },
        ).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const parsed = parseOutputPreviewPageBoxes(
                await response.json(),
                pageNum,
                sourcePageNum,
            );
            if (!parsed) throw new Error('Invalid PageBox response');
            if (!active || controller.signal.aborted) return;
            setOutputPreviewPageBoxes(parsed);
        }).catch(() => {
            if (!active || controller.signal.aborted) return;
            setOutputPreviewPageBoxes(null);
            setPageBoxesError(t('tabs.outputPreview:khong_doc_duoc_hop_trang'));
        }).finally(() => {
            if (active && !controller.signal.aborted) {
                setPageBoxesLoading(false);
            }
        });

        return () => {
            active = false;
            controller.abort();
            setOutputPreviewPageBoxes(null);
        };
    }, [fileId, pageNum, setOutputPreviewPageBoxes, sourcePageNum, t]);

    // ── TAC Heatmap Generation (Web Worker) ──
    useEffect(() => {
        const worker = previewWorkerRef.current;
        if (
            !showTacHeatmap
            || !plateDataRef.current
            || plateDataRef.current.outputPreviewFilter !== showFilter
            || !worker
        ) {
            clearTacHeatmap();
            return;
        }
        let cancelled = false;
        void sendPreviewWorkerRequest(worker, { type: 'tac', threshold: tacThreshold })
            .then((response) => {
                if (
                    cancelled
                    || previewWorkerRef.current !== worker
                    || response.type !== 'tac-rendered'
                ) return;
                const url = URL.createObjectURL(response.png);
                if (tacObjectUrlRef.current) URL.revokeObjectURL(tacObjectUrlRef.current);
                tacObjectUrlRef.current = url;
                setTacHeatmapUrl(url);
            })
            .catch(() => {
                if (!cancelled && previewWorkerRef.current === worker) clearTacHeatmap();
            });
        return () => { cancelled = true; };
    }, [
        clearTacHeatmap,
        plateList,
        sendPreviewWorkerRequest,
        setTacHeatmapUrl,
        showTacHeatmap,
        showFilter,
        tacThreshold,
    ]);

    // --- Drag Logic ---
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const dragRef = React.useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0, isDragging: false });
    const clampPanelOffset = useCallback((offset: { x: number; y: number }) => {
        const panel = panelRef.current;
        const workspace = panel?.parentElement;
        if (!panel || !workspace
            || workspace.clientWidth <= 0 || workspace.clientHeight <= 0
            || panel.offsetWidth <= 0 || panel.offsetHeight <= 0) {
            return clampOutputPreviewPanelOffset(offset);
        }
        return clampOutputPreviewPanelOffset(offset, {
            workspaceWidth: workspace.clientWidth,
            workspaceHeight: workspace.clientHeight,
            panelWidth: panel.offsetWidth,
            panelHeight: panel.offsetHeight,
        });
    }, []);

    const handlePointerDown = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        dragRef.current = { startX: e.clientX, startY: e.clientY, initialX: pos.x, initialY: pos.y, isDragging: true };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragRef.current.isDragging) return;
        setPos(clampPanelOffset({
            x: dragRef.current.initialX + (e.clientX - dragRef.current.startX),
            y: dragRef.current.initialY + (e.clientY - dragRef.current.startY)
        }));
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        dragRef.current.isDragging = false;
        try {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
            // Pointer capture có thể đã được trình duyệt giải phóng trước đó.
        }
    };

    useEffect(() => {
        const panel = panelRef.current;
        const workspace = panel?.parentElement;
        if (!panel || !workspace) return;
        const reclamp = () => setPos(current => clampPanelOffset(current));
        reclamp();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(reclamp);
        observer.observe(workspace);
        observer.observe(panel);
        return () => observer.disconnect();
    }, [clampPanelOffset]);
    // ------------------

    // ESC to close
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            const tabRoot = panelRef.current?.closest<HTMLElement>('[data-prynx-tab-active]');
            if (tabRoot?.dataset.prynxTabActive === 'false') return;
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [onClose]);

    useEffect(() => {
        let isMounted = true;
        const fetchSeparations = async () => {
            // PERF/UIUX (audit 2026-08-10 §PPE.REAUDIT.4): đổi Show/profile
            // không làm panel nhảy về spinner trắng. Giữ danh sách nút cũ trong
            // lúc fetch, nhưng vô hiệu dữ liệu mực/overlay ngay để không lấy mẫu
            // hoặc ghép subset bằng request identity trước.
            const preservePlateSelection = plateDataRef.current !== null;
            plateDataRef.current = null;
            clearColorManagedPlateComposite();
            clearTacHeatmap();
            for (const element of Object.values(pctRefs.current)) {
                if (element) element.textContent = '—';
            }
            if (tacRef.current) tacRef.current.textContent = '—';
            setLoading(true);
            setError('');
            setSoloPlate(null);
            try {
                const renderMode = effectiveAccuratePreview ? 'accurate' : 'approximate';
                const query = new URLSearchParams({
                    dpi: '150',
                    render_mode: renderMode,
                    profile_id: simulationProfileId,
                    intent: simulationIntent,
                    output_preview_filter: showFilter,
                });
                const res = await authenticatedFetch(
                    `${getApiUrl()}/preflight/separations/${fileId}/${sourcePageNum}?${query.toString()}`
                );
                if (!res.ok) throw new Error(t('tabs.outputPreview:khong_the_phan_tach_kem'));
                const result: SeparationsData = await res.json();
                if (!isMounted) return;
                // Request hiện tại đã được khóa bởi vòng đời effect; backend mới
                // echo thêm filter để bắt mismatch. Mock/backend cũ không echo vẫn
                // chỉ được gắn danh tính của chính request đang còn mounted.
                const responseFilter = result.output_preview_filter ?? showFilter;
                if (responseFilter !== showFilter) {
                    throw new Error(t('tabs.outputPreview:khong_the_phan_tach_kem'));
                }
                const renderDpi = Number(result.render_dpi);
                if (!Number.isFinite(renderDpi) || renderDpi <= 0) {
                    throw new Error(t('tabs.outputPreview:backend_khong_tra_dpi'));
                }
                const arrays: Record<string, Uint8ClampedArray> = {};
                let plates: PlateListItem[] = [];
                if (result.plates.length > 0) {
                    const worker = createPreviewWorker();
                    const response = await sendPreviewWorkerRequest(worker, {
                        type: 'reconstruct',
                        width: result.width,
                        height: result.height,
                        plates: result.plates.map((plate) => ({
                            name: plate.name,
                            color: plate.color,
                            alphaData: plate.alpha_data,
                            isSpot: plate.is_spot,
                        })),
                    });
                    if (!isMounted || previewWorkerRef.current !== worker) return;
                    if (response.type !== 'reconstructed') {
                        throw new Error('Worker không trả dữ liệu phân tách kẽm.');
                    }
                    revokePlateObjectUrls();
                    const sourcePlates = new Map(result.plates.map(plate => [plate.name, plate]));
                    plates = response.plates.map((plate) => {
                        const sourcePlate = sourcePlates.get(plate.name);
                        if (!sourcePlate) {
                            throw new Error(t('tabs.outputPreview:khong_the_phan_tach_kem'));
                        }
                        const dataUrl = URL.createObjectURL(plate.png);
                        plateObjectUrlsRef.current.push(dataUrl);
                        arrays[plate.name] = new Uint8ClampedArray(plate.alphaBuffer);
                        return {
                            name: plate.name,
                            color: plate.color,
                            dataUrl,
                            is_spot: plate.isSpot,
                            alpha_data: sourcePlate.alpha_data,
                            alternate_cmyk_lut: sourcePlate.alternate_cmyk_lut,
                        };
                    });
                }
                plateDataRef.current = {
                    width: result.width,
                    height: result.height,
                    renderDpi,
                    outputPreviewFilter: responseFilter,
                    arrays,
                };
                setPlateList(plates);
                setVisiblePlates(previous => {
                    const available = plates.map(plate => plate.name);
                    if (!preservePlateSelection) return new Set(available);
                    return new Set(available.filter(name => previous.has(name)));
                });
                setPageHasTransparency(result.page_has_transparency ?? false);
                setBlendingColorSpace(result.blending_color_space ?? 'DeviceCMYK');
                setSpotInksMeta(result.spot_inks ?? []);
                setEngineUsed(result.engine ?? '');
                setAccuracyLabel(result.accuracy ?? '');
                setQualityNote(result.quality_note ?? '');
                setDetectedSpots(result.detected_spots ?? []);
            } catch (err: unknown) {
                if (isMounted) setError(outputPreviewErrorMessage(err, t('tabs.outputPreview:khong_the_phan_tach_kem')));
            } finally {
                if (isMounted) setLoading(false);
            }
        };
        fetchSeparations();
        return () => { isMounted = false; };
    }, [
        clearColorManagedPlateComposite,
        clearTacHeatmap,
        createPreviewWorker,
        fileId,
        revokePlateObjectUrls,
        sendPreviewWorkerRequest,
        sourcePageNum,
        simulationIntent,
        simulationProfileId,
        effectiveAccuratePreview,
        showFilter,
        t,
    ]);

    useEffect(() => {
        const clearSample = () => {
            for (const element of Object.values(pctRefs.current)) {
                if (element) element.textContent = '—';
            }
            if (tacRef.current) tacRef.current.textContent = '—';
            if (sampleMetaRef.current) {
                sampleMetaRef.current.textContent = t('tabs.outputPreview:di_chuot_de_lay_mau');
            }
        };

        const updateSample = (position: { x: number; y: number; pageNum: number } | null) => {
            const pageData = plateDataRef.current;
            if (
                !position
                || position.pageNum !== viewerSourcePageNum
                || !pageData
                || pageData.outputPreviewFilter !== showFilter
            ) {
                clearSample();
                return;
            }
            const sample = sampleOutputPreviewInk({
                arrays: pageData.arrays,
                width: pageData.width,
                height: pageData.height,
                xRatio: position.x,
                yRatio: position.y,
                renderDpi: pageData.renderDpi,
                sampleDiameterMm,
            });
            for (const [name, percentage] of Object.entries(sample.channelPercentages)) {
                const element = pctRefs.current[name];
                if (element) element.textContent = `${percentage}%`;
            }
            if (tacRef.current) {
                tacRef.current.textContent = `${sample.totalPercent}%`;
                tacRef.current.className = sample.totalPercent > tacThreshold && showTacWarning
                    ? 'font-mono text-[13px] text-red-500 font-bold tabular-nums'
                    : 'font-mono text-[13px] text-slate-500 font-medium tabular-nums';
            }
            if (sampleMetaRef.current) {
                sampleMetaRef.current.textContent = t('tabs.outputPreview:vung_mau_n_px_tai_dpi', {
                    count: sample.sampledPixels,
                    dpi: Math.round(pageData.renderDpi),
                });
            }
        };

        updateSample(workspaceStore.getState().hoveredPdfPosition);
        return workspaceStore.subscribe((state, previous) => {
            if (state.hoveredPdfPosition !== previous.hoveredPdfPosition) {
                updateSample(state.hoveredPdfPosition);
            }
        });
    }, [
        plateList,
        sampleDiameterMm,
        showFilter,
        showTacWarning,
        viewerSourcePageNum,
        t,
        tacThreshold,
        workspaceStore,
    ]);

    useEffect(() => {
        if (!onPlatesChange) return;
        if (previewMode !== 'separations') {
            clearColorManagedPlateComposite();
            return;
        }
        const pageData = plateDataRef.current;
        if (
            !pageData
            || pageData.outputPreviewFilter !== showFilter
            || plateList.length === 0
        ) {
            clearColorManagedPlateComposite();
            return;
        }
        const enabledNames = soloPlate
            ? [soloPlate]
            : plateList.filter(plate => visiblePlates.has(plate.name)).map(plate => plate.name);
        const allVisible = soloPlate === null
            && enabledNames.length === plateList.length;
        if (allVisible) {
            // COLOR (audit 2026-08-10 §OP.1): trạng thái mặc định dùng thẳng bitmap
            // Viewer color-managed đang sẵn có; không dựng hoặc chồng lại một ảnh giống hệt.
            clearColorManagedPlateComposite();
            return;
        }

        const generation = ++compositeGenerationRef.current;
        compositeAbortRef.current?.abort();
        const controller = new AbortController();
        compositeAbortRef.current = controller;
        const timer = window.setTimeout(() => {
            void authenticatedFetch(`${getApiUrl()}/preflight/separation-composite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    width: pageData.width,
                    height: pageData.height,
                    plates: plateList.map(plate => ({
                        name: plate.name,
                        alpha_data: plate.alpha_data,
                        is_spot: Boolean(plate.is_spot),
                        alternate_cmyk_lut: plate.alternate_cmyk_lut ?? null,
                    })),
                    enabled_names: enabledNames,
                    profile_id: simulationProfileId,
                    intent: simulationIntent,
                }),
            }).then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const missingAlternates = Number(
                    response.headers.get('X-PrynX-Missing-Spot-Alternates') || 0,
                );
                if (missingAlternates > 0) {
                    throw new Error('PPE không có tint transform của một bản kẽm spot.');
                }
                const blob = await response.blob();
                if (blob.type && blob.type !== 'image/png') {
                    throw new Error(`MIME composite không hợp lệ: ${blob.type}`);
                }
                if (typeof createImageBitmap === 'function') {
                    const bitmap = await createImageBitmap(blob);
                    bitmap.close();
                }
                if (controller.signal.aborted || generation !== compositeGenerationRef.current) return;

                const nextUrl = URL.createObjectURL(blob);
                if (controller.signal.aborted || generation !== compositeGenerationRef.current) {
                    URL.revokeObjectURL(nextUrl);
                    return;
                }
                const previousUrl = compositeObjectUrlRef.current;
                compositeObjectUrlRef.current = nextUrl;
                onPlatesChange(buildColorManagedPlateCompositeOverlay(nextUrl, {
                    viewerPageNum: pageNum,
                    sourcePageNum,
                    pixelWidth: pageData.width,
                    pixelHeight: pageData.height,
                }));
                // Ảnh mới đã decode trước. Giữ URL cũ thêm một nhịp render để DOM
                // không mất nguồn giữa lúc Zustand phát state và React commit frame mới.
                if (previousUrl && previousUrl !== nextUrl) {
                    window.setTimeout(() => URL.revokeObjectURL(previousUrl), 250);
                }
            }).catch((requestError) => {
                if (controller.signal.aborted || generation !== compositeGenerationRef.current) return;
                console.error('Không ghép được tập bản kẽm Output Preview:', requestError);
                toast.error(t('tabs.outputPreview:khong_the_phan_tach_kem'));
            });
        }, 35);

        return () => {
            window.clearTimeout(timer);
            controller.abort();
            if (compositeAbortRef.current === controller) compositeAbortRef.current = null;
        };
    }, [
        clearColorManagedPlateComposite,
        onPlatesChange,
        pageNum,
        plateList,
        previewMode,
        simulationIntent,
        simulationProfileId,
        showFilter,
        soloPlate,
        sourcePageNum,
        t,
        visiblePlates,
    ]);

    // PREFLIGHT (audit 2026-08-10 §OP.8): Preview là hành vi pixel thật. Chế độ
    // Color Warnings không được giữ plate subset của Separations; quay lại
    // Separations thì gỡ Soft-Proof/Gamut tự động để Viewer trở về composite kẽm.
    useEffect(() => {
        if (previewMode === 'color-warnings') {
            setSoloPlate(null);
            clearColorManagedPlateComposite();
            setSoftProofImageUrl(null);
            setGamutWarningUrl(null);
            setSoftProofActive(false);
            return;
        }
        setSoftProofImageUrl(null);
        setGamutWarningUrl(null);
        setSoftProofActive(false);
    }, [
        clearColorManagedPlateComposite,
        previewMode,
        setGamutWarningUrl,
        setSoftProofActive,
        setSoftProofImageUrl,
    ]);

    useEffect(() => {
        if (previewMode !== 'color-warnings') return;
        setVisiblePlates(new Set(plateList.map(plate => plate.name)));
    }, [plateList, previewMode]);

    useEffect(() => () => {
        disposePreviewWorker();
        revokePlateObjectUrls();
        clearColorManagedPlateComposite();
        clearTacHeatmap();
        setSoftProofImageUrl(null);
        setGamutWarningUrl(null);
        setSoftProofActive(false);
        setOverprintPreviewUrl(null);
    }, [
        clearTacHeatmap,
        clearColorManagedPlateComposite,
        disposePreviewWorker,
        revokePlateObjectUrls,
        setGamutWarningUrl,
        setOverprintPreviewUrl,
        setOutputPreviewPageBoxes,
        setSoftProofActive,
        setSoftProofImageUrl,
    ]);

    const togglePlate = useCallback((name: string) => {
        setSoloPlate(null); // clear solo when toggling
        setVisiblePlates(prev => {
            const n = new Set(prev);
            if (n.has(name)) n.delete(name); else n.add(name);
            return n;
        });
    }, []);

    const handleSoloPlate = useCallback((name: string) => {
        setSoloPlate(prev => prev === name ? null : name);
    }, []);

    const togglePlateGroup = useCallback((names: string[]) => {
        if (names.length === 0) return;
        setSoloPlate(null);
        setVisiblePlates(previous => {
            const next = new Set(previous);
            const allVisible = names.every(name => next.has(name));
            for (const name of names) {
                if (allVisible) next.delete(name);
                else next.add(name);
            }
            return next;
        });
    }, []);

    const convertSpot = useCallback(async (spotName?: string) => {
        setConvertingSpot(spotName || '__all__');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-spot`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId, spot_name: spotName || null }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                toast.error(t('tabs.outputPreview:loi_chuyen_spot_cmyk', { msg: errData.detail || res.statusText }));
                setConvertingSpot('');
                return;
            }
            const data = await res.json();
            if (data.success && data.output_filename && onFileFixed) {
                const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
                onFileFixed(await dl.blob(), data.output_filename);
            } else if (!data.success) {
                toast.error(t('tabs.outputPreview:chuyen_spot_cmyk_khong_thanh_cong', { msg: data.error || 'Unknown' }));
            }
        } catch (e: unknown) {
            console.error('Convert spot failed:', e);
            toast.error(t('tabs.outputPreview:loi_msg', { msg: outputPreviewErrorMessage(e, t('tabs.outputPreview:loi_khong_xac_dinh')) }));
        }
        setConvertingSpot('');
    }, [fileId, onFileFixed, t]);

    const processPlates = plateList.filter(plate => !plate.is_spot && PROCESS_NAMES.has(plate.name));
    const spotPlates = plateList.filter(plate => plate.is_spot || !PROCESS_NAMES.has(plate.name));
    const hasSpotInks = spotPlates.length > 0;
    const currentPageBoxes = outputPreviewPageBoxes?.viewerPageNum === pageNum
        ? outputPreviewPageBoxes
        : null;
    const declaredPageBoxes = currentPageBoxes ? ([
        { kind: 'bleedbox', box: currentPageBoxes.bleedbox, declared: currentPageBoxes.has_bleedbox },
        { kind: 'trimbox', box: currentPageBoxes.trimbox, declared: currentPageBoxes.has_trimbox },
        { kind: 'artbox', box: currentPageBoxes.artbox, declared: currentPageBoxes.has_artbox },
    ] as const).filter(entry => entry.declared) : [];
    const hasDeclaredPageBoxes = declaredPageBoxes.length > 0;

    const renderPlateGroup = (
        groupId: 'process' | 'spot',
        label: string,
        plates: typeof plateList,
    ) => {
        if (plates.length === 0) return null;
        const names = plates.map(plate => plate.name);
        const allVisible = names.every(name => visiblePlates.has(name)) && !soloPlate;
        return (
            <div data-plate-group={groupId} className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-zinc-700 dark:bg-zinc-800">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-2.5 py-1.5 dark:border-zinc-700 dark:bg-zinc-800/80">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-300">
                        {label} · {plates.length}
                    </span>
                    <button
                        type="button"
                        onClick={() => togglePlateGroup(names)}
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-900/30"
                    >
                        {allVisible ? t('tabs.outputPreview:bo_chon_tat_ca') : t('tabs.outputPreview:chon_tat_ca')}
                    </button>
                </div>
                {plates.map((plate, index) => {
                    const isVisible = soloPlate ? soloPlate === plate.name : visiblePlates.has(plate.name);
                    const isSolo = soloPlate === plate.name;
                    const hex = `#${plate.color.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
                    const spotMeta = spotInksMeta.find(spot => spot.name === plate.name);
                    return (
                        <div
                            key={plate.name}
                            className={`flex items-center justify-between transition-all ${
                                index < plates.length - 1 ? 'border-b border-slate-100 dark:border-zinc-700' : ''
                            } ${isSolo ? 'bg-indigo-50 ring-1 ring-inset ring-indigo-300 dark:bg-indigo-900/20 dark:ring-indigo-700' : ''} ${
                                !isVisible && !isSolo ? 'opacity-40' : ''
                            } hover:bg-slate-50 dark:hover:bg-zinc-750`}
                            style={{ padding: '6px 10px' }}
                        >
                            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                                <input
                                    type="checkbox"
                                    checked={isVisible}
                                    onChange={() => togglePlate(plate.name)}
                                    aria-label={`${isVisible ? t('tabs.outputPreview:bo_chon') : t('tabs.outputPreview:chon')} ${plate.name}`}
                                    className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-600 focus:ring-offset-0"
                                />
                                <span
                                    className="h-4 w-4 shrink-0 rounded-sm ring-1 ring-black/10"
                                    style={{ backgroundColor: hex }}
                                    aria-hidden="true"
                                />
                                <span className="flex min-w-0 flex-col">
                                    <span className="flex items-center gap-1.5">
                                        <span className="truncate text-[12px] font-medium text-slate-700 dark:text-zinc-200">
                                            {PROCESS_PLATE_LABELS[plate.name] || plate.name}
                                        </span>
                                        {groupId === 'spot' && (
                                            <span className="shrink-0 rounded bg-amber-200 px-1 text-[8px] font-bold text-amber-800 dark:bg-amber-700/40 dark:text-amber-300">SPOT</span>
                                        )}
                                    </span>
                                    {groupId === 'spot' && spotMeta && (
                                        <span className="font-mono text-[9px] text-slate-400">
                                            {t('tabs.outputPreview:do_phu')}: {spotMeta.coverage_pct}%{spotMeta.is_pantone ? ' · Pantone' : ''}
                                        </span>
                                    )}
                                </span>
                            </label>
                            <div className="flex shrink-0 items-center gap-1.5">
                                <span ref={element => { pctRefs.current[plate.name] = element; }} className="font-mono text-[11px] tabular-nums text-slate-400">—</span>
                                <button
                                    type="button"
                                    onClick={() => handleSoloPlate(plate.name)}
                                    className={`flex h-5 w-5 items-center justify-center rounded text-[11px] transition-colors ${
                                        isSolo
                                            ? 'bg-indigo-500 text-white'
                                            : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-700'
                                    }`}
                                    title={isSolo ? t('tabs.outputPreview:tat_xem_rieng') : t('tabs.outputPreview:xem_rieng_kenh', { name: plate.name })}
                                >
                                    {isSolo ? '◉' : '○'}
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div
            ref={panelRef}
            // UIUX (fix panel xem trước 2026-07-28): bám vào vùng làm việc thay vì viewport;
            // nếu dùng fixed, panel nằm dưới stacking context của tab và bị chrome ứng dụng che.
            className="absolute z-[9999] rounded-2xl overflow-hidden select-none flex flex-col bg-white dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700/80"
            style={{
                top: OUTPUT_PREVIEW_WORKSPACE_GAP_PX,
                right: 60,
                width: 'min(380px, calc(100% - 20px))',
                maxHeight: `calc(100% - ${OUTPUT_PREVIEW_WORKSPACE_GAP_PX * 2}px)`,
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                boxShadow: '0 20px 40px -10px rgba(0,0,0,0.15), 0 0 10px rgba(0,0,0,0.05)',
                fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
            }}
        >
            {/* ─── Header ─── */}
            <div 
                className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 bg-slate-50/80 dark:bg-zinc-900/80 cursor-move"
                style={{ padding: '10px 16px' }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <div className="flex items-center gap-2">
                    <span className="text-[14px]">👁️</span>
                    <span className="font-bold text-[13px] text-slate-700 dark:text-zinc-200 uppercase tracking-wide">{t('tabs.outputPreview:xem_truoc_ban_in')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                    {engineUsed && (
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            isRipResult
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                        }`}>
                            {isRipResult ? 'RIP' : t('tabs.outputPreview:xap_xi')} · {engineDisplayName}
                        </span>
                    )}
                    {detectedSpots.length > 0 && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold dark:bg-amber-900/40 dark:text-amber-300">
                            {detectedSpots.length} SPOT
                        </span>
                    )}
                    <button 
                        onClick={onClose} 
                        className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-50 hover:text-red-600 text-slate-400 transition-colors text-[16px]"
                    >×</button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

                {/* UIUX (audit 2026-08-10 §OP.11): điều hướng trang là ngữ cảnh
                    của toàn panel nên luôn nhìn thấy, không phụ thuộc section. */}
                {totalPages > 1 && (
                    <div data-output-preview-page-nav className="flex items-center justify-center gap-3">
                        <button
                            type="button"
                            onClick={() => navigatePreviewPage(pageNum - 1)}
                            disabled={pageNum <= 1 || loading}
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-[14px] text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >←</button>
                        <span className="text-[12px] font-semibold tabular-nums text-slate-600 dark:text-zinc-300">
                            {t('tabs.outputPreview:trang_x_tren_y', { page: pageNum, total: totalPages })}
                        </span>
                        <button
                            type="button"
                            onClick={() => navigatePreviewPage(pageNum + 1)}
                            disabled={pageNum >= totalPages || loading}
                            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-[14px] text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >→</button>
                    </div>
                )}

                {/* PREFLIGHT (audit 2026-08-10 §OP.8): quyết định Simulation luôn
                    nhìn thấy và là nguồn chung cho Separations/Soft-Proof/Viewer. */}
                <OutputPreviewSection
                    id="simulation"
                    title={t('tabs.outputPreview:mo_phong')}
                    defaultOpen
                >
                    <div className="rounded-lg bg-indigo-50/50 p-2.5 dark:bg-indigo-950/20">
                    <label className="mb-2 block">
                        <span className="mb-1 block text-[10px] font-semibold text-slate-500 dark:text-zinc-400">
                            {t('tabs.outputPreview:ho_so_mo_phong')}
                        </span>
                        <select
                            value={simulationProfileId}
                            onChange={(event) => setSimulationProfileId(event.target.value)}
                            className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                            {profiles.map(profile => (
                                <option key={profile.id} value={profile.id} disabled={!profile.available}>
                                    {profile.name}{profile.available ? '' : ` (${t('tabs.outputPreview:chua_cai')})`}
                                </option>
                            ))}
                            {profiles.length === 0 && (
                                <option value={simulationProfileId}>
                                    {t('tabs.outputPreview:dang_tai_ho_so')}
                                </option>
                            )}
                        </select>
                        {profiles.find(profile => profile.id === simulationProfileId)?.description && (
                            <span className="mt-1 block text-[10px] leading-snug text-slate-400">
                                {profiles.find(profile => profile.id === simulationProfileId)?.description}
                            </span>
                        )}
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-[10px] font-semibold text-slate-500 dark:text-zinc-400">
                            {t('tabs.outputPreview:rendering_intent')}
                        </span>
                        <select
                            value={simulationIntent}
                            onChange={(event) => setSimulationIntent(event.target.value as OutputPreviewRenderingIntent)}
                            className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                            {SIMULATION_INTENTS.map(intent => (
                                <option key={intent} value={intent}>
                                    {t(`tabs.outputPreview:intent_${intent}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="mt-2 grid gap-1.5 border-t border-indigo-100 pt-2 dark:border-indigo-900/50">
                        <label className="flex cursor-pointer items-center gap-2">
                            <input
                                type="checkbox"
                                checked={simulatePaperColor}
                                onChange={(event) => setSimulatePaperColor(event.target.checked)}
                                className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span className="text-[11px] font-medium text-slate-600 dark:text-zinc-300">
                                {t('tabs.outputPreview:paper_color')}
                            </span>
                        </label>
                        <label className="flex cursor-pointer items-center gap-2">
                            <input
                                type="checkbox"
                                checked={simulateBlackInk}
                                onChange={(event) => setSimulateBlackInk(event.target.checked)}
                                className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span className="text-[11px] font-medium text-slate-600 dark:text-zinc-300">
                                {t('tabs.outputPreview:black_ink')}
                            </span>
                        </label>
                        <div className="flex items-center justify-between gap-2">
                            <label className="flex min-w-0 cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={pageBackgroundRgb !== null}
                                    aria-label={t('tabs.outputPreview:background_color')}
                                    onChange={(event) => setPageBackgroundRgb(
                                        event.target.checked ? [255, 255, 255] : null,
                                    )}
                                    className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                                <span className="truncate text-[11px] font-medium text-slate-600 dark:text-zinc-300">
                                    {t('tabs.outputPreview:background_color')}
                                </span>
                            </label>
                            <input
                                type="color"
                                value={rgbToHex(pageBackgroundRgb)}
                                disabled={pageBackgroundRgb === null}
                                aria-label={t('tabs.outputPreview:background_color_picker')}
                                onChange={(event) => {
                                    const rgb = hexToRgb(event.target.value);
                                    if (rgb) setPageBackgroundRgb(rgb);
                                }}
                                className="h-6 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800"
                            />
                        </div>
                    </div>
                    <div className="mt-2 border-t border-indigo-100 pt-2 dark:border-indigo-900/50">
                        <OverprintPreviewToggle
                            fileId={fileId}
                            pageNum={sourcePageNum}
                            profileId={simulationProfileId}
                            intent={simulationIntent}
                            active={simulateOverprint}
                            onActiveChange={setSimulateOverprint}
                        />
                        <button
                            type="button"
                            onClick={() => openRelatedTool('inkmanager')}
                            className="mt-2 flex w-full items-center justify-between rounded-lg border border-indigo-200 bg-white px-2.5 py-2 text-[11px] font-semibold text-indigo-700 transition-colors hover:border-indigo-400 hover:bg-indigo-50 dark:border-indigo-900/70 dark:bg-zinc-900 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
                        >
                            <span>{t('tabs.outputPreview:quan_ly_muc')}</span>
                            <span aria-hidden="true">↗</span>
                        </button>
                    </div>
                    </div>
                </OutputPreviewSection>

                {/* ─── Mode + Engine ─── */}
                <OutputPreviewSection
                    id="display"
                    title={t('tabs.outputPreview:hien_thi')}
                >
                <div className="grid gap-2">
                    <label className="block">
                        <span className="mb-1 block text-[10px] font-semibold text-slate-500 dark:text-zinc-400">
                            {t('tabs.outputPreview:show_label')}
                        </span>
                        <select
                            value={showFilter}
                            aria-label={t('tabs.outputPreview:show_label')}
                            onChange={(event) => setShowFilter(event.target.value as OutputPreviewShowFilter)}
                            className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                            {OUTPUT_PREVIEW_SHOW_FILTERS.map(filter => (
                                <option key={filter} value={filter}>
                                    {t(`tabs.outputPreview:show_${filter.replace(/-/g, '_')}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-[10px] font-semibold text-slate-500 dark:text-zinc-400">
                            {t('tabs.outputPreview:preview_label')}
                        </span>
                        <select
                            value={previewMode}
                            aria-label={t('tabs.outputPreview:preview_label')}
                            onChange={(event) => setPreviewMode(event.target.value as OutputPreviewMode)}
                            className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                            {OUTPUT_PREVIEW_MODES.map(mode => (
                                <option key={mode} value={mode}>
                                    {t(`tabs.outputPreview:preview_${mode.replace(/-/g, '_')}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                    {previewMode === 'color-warnings' && (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/20">
                            <SoftProofPanel
                                fileId={fileId}
                                pageNum={sourcePageNum}
                                profileId={simulationProfileId}
                                intent={simulationIntent}
                                simulateOverprint={simulateOverprint}
                                outputPreviewFilter={showFilter}
                                simulatePaperColor={simulatePaperColor}
                                simulateBlackInk={simulateBlackInk}
                                pageBackgroundRgb={pageBackgroundRgb}
                                forceGamutWarning
                                autoRender
                            />
                        </div>
                    )}
                </div>
                <label className="mt-2 block">
                    <span className="mb-1 flex items-center justify-between text-[10px] font-semibold text-slate-500 dark:text-zinc-400">
                        <span>{t('tabs.outputPreview:do_mo_canh_bao')}</span>
                        <span className="font-mono tabular-nums">{Math.round(warningOpacity * 100)}%</span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={Math.round(warningOpacity * 100)}
                        aria-label={t('tabs.outputPreview:do_mo_canh_bao')}
                        onChange={(event) => setWarningOpacity(Number(event.target.value) / 100)}
                        className="w-full accent-orange-500"
                    />
                    <span className="mt-0.5 block text-[9px] leading-snug text-slate-400">
                        {t('tabs.outputPreview:do_mo_canh_bao_mo_ta')}
                    </span>
                </label>
                <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
                    <label className={`flex items-center gap-2 ${hasDeclaredPageBoxes ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                        <input
                            type="checkbox"
                            checked={showPageBoxes && hasDeclaredPageBoxes}
                            disabled={pageBoxesLoading || Boolean(pageBoxesError) || !hasDeclaredPageBoxes}
                            aria-label={t('tabs.outputPreview:hien_khung_art_trim_bleed')}
                            onChange={(event) => setShowPageBoxes(event.target.checked)}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">
                            {t('tabs.outputPreview:hien_khung_art_trim_bleed')}
                        </span>
                    </label>
                    {pageBoxesLoading && (
                        <span className="mt-1.5 block text-[9px] text-slate-400">
                            {t('tabs.outputPreview:dang_doc_hop_trang')}
                        </span>
                    )}
                    {!pageBoxesLoading && pageBoxesError && (
                        <span className="mt-1.5 block text-[9px] text-amber-600 dark:text-amber-400">
                            {pageBoxesError}
                        </span>
                    )}
                    {!pageBoxesLoading && !pageBoxesError && currentPageBoxes && !hasDeclaredPageBoxes && (
                        <span className="mt-1.5 block text-[9px] leading-snug text-slate-400">
                            {t('tabs.outputPreview:trang_khong_khai_bao_art_trim_bleed')}
                        </span>
                    )}
                    {hasDeclaredPageBoxes && (
                        <div className="mt-2 grid gap-1">
                            {declaredPageBoxes.map(({ kind, box }) => (
                                <div key={kind} className="flex items-center justify-between gap-2 text-[9px] text-slate-500 dark:text-zinc-400">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                        <span className={`inline-block w-4 border-t-2 border-dashed ${PAGE_BOX_LINE_CLASSES[kind]}`} />
                                        <span className="truncate">{t(PAGE_BOX_LABEL_KEYS[kind])}</span>
                                    </span>
                                    <span className="shrink-0 font-mono tabular-nums">
                                        {box.width} × {box.height} mm
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => openRelatedTool('crop')}
                    className="mt-2 flex w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] font-semibold text-slate-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300"
                >
                    <span>{t('tabs.outputPreview:dat_hop_trang')}</span>
                    <span aria-hidden="true">↗</span>
                </button>
                </OutputPreviewSection>

                {/* ─── Plate List ─── */}
                <OutputPreviewSection
                    id="separations"
                    title={t('tabs.outputPreview:ban_kem')}
                    defaultOpen
                >
                    {previewMode !== 'separations' ? (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400">
                            {t('tabs.outputPreview:separations_disabled_for_preview')}
                        </div>
                    ) : loading && plateList.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 py-8 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-100 dark:border-zinc-800">
                            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                            <span className="text-[13px] text-slate-500 font-medium">{t('tabs.outputPreview:dang_phan_tach_kem')}</span>
                        </div>
                    ) : error ? (
                        <div className="py-4 px-4 text-red-600 text-[13px] text-center bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-100 dark:border-red-900/30">
                            {error}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {renderPlateGroup('process', t('tabs.outputPreview:nhom_process_cmyk'), processPlates)}
                            {renderPlateGroup('spot', t('tabs.outputPreview:nhom_spot'), spotPlates)}
                        </div>
                    )}
                </OutputPreviewSection>

                {/* ─── Options ─── */}
                <OutputPreviewSection
                    id="sampling"
                    title={t('tabs.outputPreview:lay_mau_va_tac')}
                >
                <div className="flex flex-col gap-2">
                    <label className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">
                            {t('tabs.outputPreview:co_mau')}
                        </span>
                        <select
                            aria-label={t('tabs.outputPreview:co_mau')}
                            value={sampleDiameterMm}
                            onChange={(event) => setSampleDiameterMm(Number(event.target.value))}
                            className="h-7 rounded border border-slate-200 bg-white px-2 text-[11px] text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                            <option value={0}>{t('tabs.outputPreview:diem_mot_pixel')}</option>
                            {[1, 3, 5].map(diameter => (
                                <option key={diameter} value={diameter}>
                                    {t('tabs.outputPreview:trung_binh_duong_kinh_mm', { diameter })}
                                </option>
                            ))}
                        </select>
                    </label>
                    <span ref={sampleMetaRef} className="text-[10px] leading-snug text-slate-400">
                        {t('tabs.outputPreview:di_chuot_de_lay_mau')}
                    </span>
                    <div className="flex items-center justify-between rounded bg-slate-50 px-2 py-1.5 dark:bg-zinc-800/60">
                        <span className="text-[11px] italic text-slate-500">{t('tabs.outputPreview:tong_phu_muc_tac')}</span>
                        <span ref={tacRef} className="font-mono text-[11px] tabular-nums text-slate-500">—</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showTacWarning}
                                onChange={(e) => setShowTacWarning(e.target.checked)}
                                className="w-3.5 h-3.5 rounded border-slate-300 text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                            />
                            <span className="text-[12px] text-slate-600 dark:text-zinc-300">{t('tabs.outputPreview:canh_bao_tac')}</span>
                        </label>
                        <div className="flex items-center gap-1.5">
                            <div className="w-4 h-4 rounded-sm bg-emerald-500 ring-1 ring-black/10"></div>
                            <div className="flex items-center bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-600 rounded overflow-hidden">
                                <input
                                    type="number"
                                    value={tacThreshold}
                                    onChange={(e) => setTacThreshold(Number(e.target.value))}
                                    className="w-10 text-[12px] text-center bg-transparent text-slate-700 dark:text-zinc-200 border-none outline-none focus:ring-0 p-0"
                                    style={{ padding: '2px 0' }}
                                />
                                <span className="text-[11px] text-slate-400 pr-1.5 select-none">%</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showTacHeatmap}
                                onChange={(e) => setShowTacHeatmap(e.target.checked)}
                                className="w-3.5 h-3.5 rounded border-slate-300 text-red-500 focus:ring-red-500 cursor-pointer"
                            />
                            <span className="text-[12px] text-slate-600 dark:text-zinc-300">{t('tabs.outputPreview:heatmap_vung_qua_muc')}</span>
                        </label>
                        <div className="flex items-center gap-1">
                            <div className="w-3 h-3 rounded-sm bg-gradient-to-r from-yellow-400 to-red-500"></div>
                            <span className="text-[10px] text-slate-400">TAC &gt; {tacThreshold}%</span>
                        </div>
                    </div>
                </div>
                </OutputPreviewSection>

                {/* ─── Page Info ─── */}
                <OutputPreviewSection
                    id="metadata"
                    title={t('tabs.outputPreview:thong_tin_trang')}
                >
                <div className="flex flex-col gap-1 rounded-lg bg-slate-50 px-3 py-2 dark:bg-zinc-800/50">
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:tong_ban_kem')}</span>
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">
                            {plateList.length} ({spotPlates.length} Spot)
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:trong_suot')}</span>
                        <span className={`text-[11px] font-semibold ${pageHasTransparency ? 'text-amber-600' : 'text-slate-600'}`}>
                            {pageHasTransparency ? t('tabs.outputPreview:co') : t('tabs.outputPreview:khong')}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:he_mau_hoa_tron')}</span>
                        <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-300">{blendingColorSpace}</span>
                    </div>
                    {detectedSpots.length > 0 && (
                        <div className="flex items-start justify-between mt-1 pt-1 border-t border-slate-200 dark:border-zinc-700">
                            <span className="text-[11px] text-slate-500">{t('tabs.outputPreview:mau_spot')}</span>
                            <div className="flex flex-wrap gap-1 justify-end max-w-[200px]">
                                {detectedSpots.map(s => (
                                    <span key={s} className="text-[9px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded font-medium">{s}</span>
                                ))}
                            </div>
                        </div>
                    )}
                    {/* C2: chế độ xấp xỉ KHÔNG tách được bản kẽm spot riêng (spot bị trộn vào
                        RGB→CMYK). detected_spots vẫn liệt kê tên → cảnh báo để user không tưởng
                        là đã tách spot. */}
                    {detectedSpots.length > 0 && accuracyLabel && !isRipResult && (
                        <div className="mt-1 pt-1.5 border-t border-slate-200 dark:border-zinc-700 text-[10px] text-amber-700 dark:text-amber-300 leading-snug">
                            ⚠️ {t('tabs.outputPreview:canh_bao_spot_xap_xi')}
                        </div>
                    )}
                </div>
                </OutputPreviewSection>

                {/* ─── ICC Soft-Proof ─── */}
                <OutputPreviewSection
                    id="advanced"
                    title={t('tabs.outputPreview:nang_cao_prynx')}
                >
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                            <input
                                type="checkbox"
                                checked={effectiveAccuratePreview}
                                disabled={filterRequiresPpe}
                                onChange={(event) => setUseAccuratePreview(event.target.checked)}
                                className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                            />
                            <span className="text-[12px] text-slate-600 dark:text-zinc-300">
                                {t('tabs.outputPreview:che_do_ppe_chinh_xac')}
                                {!effectiveAccuratePreview ? ` — ${t('tabs.outputPreview:dang_xap_xi')}` : ''}
                            </span>
                        </label>
                        <div className="group/tooltip relative flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-[10px] text-slate-500 transition-colors hover:bg-slate-200 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700">
                            ?
                            <div className="invisible absolute bottom-full right-0 z-[100] mb-2 w-max max-w-[280px] rounded-lg bg-slate-800 px-3 py-2.5 text-left text-[12px] font-normal leading-relaxed text-white opacity-0 shadow-xl transition-all group-hover/tooltip:visible group-hover/tooltip:opacity-100 dark:bg-zinc-700">
                                <p className="mb-1 text-emerald-300">{t('tabs.outputPreview:ppe_chinh_xac_mo_ta')}</p>
                                <p className="opacity-90">{t('tabs.outputPreview:ppe_xap_xi_mo_ta')}</p>
                            </div>
                        </div>
                    </div>
                    {(engineUsed || accuracyLabel || qualityNote) && (
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                            {engineUsed && (
                                <span className={`rounded px-1.5 py-0.5 font-bold ${
                                    isRipResult
                                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                                        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                                }`}>
                                    {isRipResult ? 'RIP' : t('tabs.outputPreview:xap_xi')} · {engineDisplayName}
                                </span>
                            )}
                            {qualityNote && (
                                <span className="leading-snug text-slate-500 dark:text-zinc-400">{qualityNote}</span>
                            )}
                        </div>
                    )}
                    {effectiveAccuratePreview && accuracyLabel && !isRipResult && (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                            ⚠️ {t('tabs.outputPreview:ppe_khong_tin_cay')}
                        </div>
                    )}
                    {plateList.length > 1 && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10px] leading-snug text-slate-500 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-400">
                            ℹ️ {t('tabs.outputPreview:anh_ghep_chi_la_preview')}
                        </div>
                    )}
                    {previewMode === 'separations' && <button
                        type="button"
                        onClick={() => setShowSoftProof(p => !p)}
                        aria-expanded={showSoftProof}
                        className="flex w-full items-center justify-between rounded border border-slate-200 px-2.5 py-2 text-[11px] font-bold text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    >
                        <span>🔍 ICC Soft-Proof & Gamut</span>
                        <svg className={`w-3 h-3 transition-transform ${showSoftProof ? 'rotate-180' : ''}`} fill="currentColor" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
                    </button>}
                    {previewMode === 'separations' && showSoftProof && (
                        <SoftProofPanel
                            fileId={fileId}
                            pageNum={sourcePageNum}
                            profileId={simulationProfileId}
                            intent={simulationIntent}
                            simulateOverprint={simulateOverprint}
                            outputPreviewFilter={showFilter}
                            simulatePaperColor={simulatePaperColor}
                            simulateBlackInk={simulateBlackInk}
                            pageBackgroundRgb={pageBackgroundRgb}
                        />
                    )}
                </div>
                </OutputPreviewSection>

                <OutputPreviewSection
                    id="actions"
                    title={t('tabs.outputPreview:sua_file')}
                    warning
                >
                    <div className="mb-2 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
                        {t('tabs.outputPreview:sua_file_tao_ban_moi')}
                    </div>
                    {hasSpotInks ? (
                        <div className="flex flex-col gap-1.5">
                            {spotPlates.map(plate => (
                                <button
                                    key={plate.name}
                                    type="button"
                                    onClick={() => convertSpot(plate.name)}
                                    disabled={!!convertingSpot}
                                    className="flex w-full items-center justify-between rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-[11px] font-semibold text-amber-700 transition-colors hover:border-amber-400 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-900/70 dark:bg-zinc-900 dark:text-amber-300 dark:hover:bg-amber-950/30"
                                >
                                    <span>{t('tabs.outputPreview:chuyen_mot_spot_cmyk', { name: plate.name })}</span>
                                    <span>{convertingSpot === plate.name ? '…' : '→'}</span>
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={() => convertSpot()}
                                disabled={!!convertingSpot}
                                className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
                            >
                                {convertingSpot === '__all__' ? (
                                    <><div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> {t('tabs.outputPreview:dang_chuyen')}</>
                                ) : (
                                    <>{t('tabs.outputPreview:chuyen_tat_ca_spot_cmyk')}</>
                                )}
                            </button>
                        </div>
                    ) : (
                        <div className="rounded bg-white/70 px-2 py-1.5 text-[11px] text-slate-500 dark:bg-zinc-900/60 dark:text-zinc-400">
                            {t('tabs.outputPreview:khong_co_spot_de_chuyen')}
                        </div>
                    )}
                </OutputPreviewSection>

            </div>
        </div>
    );
}

export function OverprintPreviewToggle({
    fileId,
    pageNum,
    profileId,
    intent,
    active,
    onActiveChange,
}: {
    fileId: string;
    pageNum: number;
    profileId: string;
    intent: OutputPreviewRenderingIntent;
    active: boolean;
    onActiveChange: (active: boolean) => void;
}) {
  const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    const [diffCount, setDiffCount] = useState<number | null>(null);
    const [showDiff, setShowDiff] = useState(false);
    const [diffOverlayUrl, setDiffOverlayUrl] = useState<string | null>(null);
    const [overprintImageUrl, setOverprintImageUrl] = useState<string | null>(null);
    const [pageHasOverprint, setPageHasOverprint] = useState<boolean | null>(null);
    const [error, setError] = useState('');
    const requestGenerationRef = React.useRef(0);
    const abortRef = React.useRef<AbortController | null>(null);
    const setOverprintPreviewUrl = useWorkspaceStore(s => s.setOverprintPreviewUrl);
    const setOverprintDiagnosticActive = useWorkspaceStore(s => s.setOutputPreviewOverprintDiagnosticActive);

    const clearPreview = useCallback(() => {
        onActiveChange(false);
        setOverprintPreviewUrl(null);
        setOverprintDiagnosticActive(false);
        setDiffCount(null);
        setShowDiff(false);
        setDiffOverlayUrl(null);
        setOverprintImageUrl(null);
        setPageHasOverprint(null);
    }, [onActiveChange, setOverprintDiagnosticActive, setOverprintPreviewUrl]);

    const cancelInFlight = useCallback(() => {
        requestGenerationRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setLoading(false);
    }, []);

    const toggle = useCallback(async () => {
        if (active || loading) {
            cancelInFlight();
            clearPreview();
            return;
        }

        const generation = ++requestGenerationRef.current;
        const controller = new AbortController();
        abortRef.current?.abort();
        abortRef.current = controller;
        setLoading(true);
        setError('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/overprint-preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    page: pageNum,
                    dpi: 150,
                    profile_id: profileId,
                    intent,
                }),
                signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
            if (!res.ok || !data.success) {
                throw new Error(data.error || data.detail || t('tabs.outputPreview:loi_khong_xac_dinh'));
            }
            if (!data.overprint_image) {
                throw new Error(t('tabs.outputPreview:ppe_khong_tra_anh_overprint'));
            }

            setDiffCount(Number(data.diff_pixel_count || 0));
            setDiffOverlayUrl(data.diff_overlay || null);
            setOverprintImageUrl(data.overprint_image);
            setPageHasOverprint(typeof data.page_has_overprint === 'boolean'
                ? data.page_has_overprint
                : null);
            setShowDiff(false);
            setOverprintDiagnosticActive(false);
            onActiveChange(true);
            // PREFLIGHT (audit 2026-08-10 §OP.9): mặc định hiển thị composite
            // color-managed; diff chỉ là chế độ chẩn đoán do người dùng chọn riêng.
            setOverprintPreviewUrl(data.overprint_image);
        } catch (e: unknown) {
            if (!controller.signal.aborted && generation === requestGenerationRef.current) {
                setError(outputPreviewErrorMessage(e, t('tabs.outputPreview:loi_khong_xac_dinh')));
                clearPreview();
            }
        } finally {
            if (generation === requestGenerationRef.current) {
                setLoading(false);
                if (abortRef.current === controller) abortRef.current = null;
            }
        }
    }, [active, cancelInFlight, clearPreview, fileId, intent, loading, onActiveChange, pageNum, profileId, setOverprintDiagnosticActive, setOverprintPreviewUrl, t]);

    const toggleDiff = useCallback(() => {
        if (!active || !overprintImageUrl) return;
        const next = !showDiff;
        setShowDiff(next);
        setOverprintDiagnosticActive(next && Boolean(diffOverlayUrl));
        setOverprintPreviewUrl(next && diffOverlayUrl ? diffOverlayUrl : overprintImageUrl);
    }, [active, diffOverlayUrl, overprintImageUrl, setOverprintDiagnosticActive, setOverprintPreviewUrl, showDiff]);

    useEffect(() => {
        cancelInFlight();
        clearPreview();
        setError('');
        return () => {
            cancelInFlight();
            setOverprintDiagnosticActive(false);
            setOverprintPreviewUrl(null);
        };
    }, [cancelInFlight, clearPreview, fileId, intent, pageNum, profileId, setOverprintDiagnosticActive, setOverprintPreviewUrl]);

    return (
        <div className="flex flex-col gap-1.5">
            <button
                type="button"
                aria-pressed={active}
                onClick={toggle}
                className={`w-full px-3 py-2 rounded-lg text-[12px] font-bold transition-all flex items-center justify-center gap-2 border ${
                    active
                        ? 'bg-violet-500/15 border-violet-500 text-violet-700 dark:text-violet-300'
                        : 'bg-white dark:bg-zinc-800 border-slate-200 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:border-violet-400'
                }`}
            >
                {loading ? (
                    <><div className="w-3.5 h-3.5 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" /> {t('tabs.outputPreview:huy_phan_tich_overprint')}</>
                ) : active ? (
                    <>{t('tabs.outputPreview:tat_overprint_preview')}</>
                ) : (
                    <>🔲 {t('tabs.outputPreview:mo_phong_overprint')}</>
                )}
            </button>
            {active && (
                <>
                    <label className="flex items-center gap-2 px-2 text-[11px] text-slate-600 dark:text-zinc-300">
                        <input
                            type="checkbox"
                            checked={showDiff}
                            disabled={!diffOverlayUrl}
                            onChange={toggleDiff}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-orange-500 focus:ring-orange-500"
                        />
                        {t('tabs.outputPreview:hien_vung_thay_doi_chan_doan')}
                    </label>
                    <div className="flex items-center justify-between px-2 text-[10px] text-slate-500 dark:text-zinc-400">
                        <span>{t('tabs.outputPreview:trang_co_overprint')}</span>
                        <strong className={pageHasOverprint === true ? 'text-amber-600' : 'text-slate-500'}>
                            {pageHasOverprint === null
                                ? t('tabs.outputPreview:chua_xac_dinh')
                                : pageHasOverprint
                                    ? t('tabs.outputPreview:co')
                                    : t('tabs.outputPreview:khong')}
                        </strong>
                    </div>
                </>
            )}
            {active && diffCount !== null && (
                <div className={`text-[10px] px-2 py-1 rounded ${
                    diffCount > 0
                        ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300'
                        : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                }`}>
                    {diffCount > 0
                        ? t('tabs.outputPreview:chan_doan_pixel_thay_doi', {
                            count: diffCount.toLocaleString(),
                        })
                        : t('tabs.outputPreview:khong_co_su_khac_biet_file_khong_bi_anh')}
                </div>
            )}
            {error && <div className="text-[10px] text-red-500 px-2">{error}</div>}
        </div>
    );
}
