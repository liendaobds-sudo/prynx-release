import { useEffect, useMemo, useRef, useState } from 'react';

import {
    cancelStickerCutlinePreviewJob,
    closeStickerSheetSession,
    detectStickerSourceManifest,
    inspectStickerSourceManifest,
    readStickerCutlinePreviewJob,
    startStickerCutlinePreviewJob,
    type StickerCutlinePreview,
    type StickerCutlinePreviewJob,
    type StickerCutlinePreviewOptions,
    type StickerDetectionStrategy,
    type StickerSourceDetection,
    type StickerSourceInspection,
} from '../../lib/stickerSheetApi';
import i18n from '../../i18n';
import { computeStickerBleedGeometry } from '../../lib/stickerBleedGeometry';
import {
    DEFAULT_AUTO_CUTLINE_SIMPLIFY_MM,
    resolveStickerCutlineSimplifyMm,
} from './stickerToolPolicy';
import {
    useWorkspaceStore,
    type ViewerActivePagePhysical,
} from '../../stores/useWorkspaceStore';


const SOURCE_DEBOUNCE_MS = 220;
const TUNING_DEBOUNCE_MS = 40;
const PREVIEW_JOB_POLL_MS = 100;
const POINT_TO_MM = 25.4 / 72;
/** Phải khớp `_CUTLINE_ROUND_RADIUS_MAX_MM` phía backend. */
const CUTLINE_ROUND_RADIUS_MAX_MM = 3;
const MINIMUM_STRAIGHT_MM = 0.25;

type CutMode = 'original' | 'alpha' | 'bleed' | 'none';
type CornerStyle = 'preserve' | 'round' | 'miter';

interface PreviewSource {
    sessionId: string;
    manifest: StickerSourceDetection;
    generation: number;
    documentIdentity: string;
    pageNumber: number;
    pageInstanceId: string | null;
    autoSimplifyEligible: boolean;
    /** UIUX (2026-09-10 §MULTI-ALPHA.WHOLE): nhiều mảng alpha → engine toàn trang. */
    classicWholePage: boolean;
    forceContour: boolean;
}

interface PreviewRequest {
    key: string;
    /** Vòng đời tài liệu/tab, khác lượt job tăng theo mỗi lần kéo thanh. */
    generation: number;
    jobGeneration: number;
    source: PreviewSource;
    pageNumber: number;
    cutMode: CutMode;
    cornerStyle: CornerStyle;
    offsetMm: number;
    bleedMm: number;
    fillHoles: boolean;
    curveTension: number;
    cutlineDenoise: number;
    cutlineSimplifyMm: number;
}

interface PreviewSession {
    sessionId: string;
    inspection: StickerSourceInspection;
    generation: number;
}

interface CachedPreviewFrame {
    preview: StickerCutlinePreview;
    canonicalReference: ClassicCutlinePreviewState['canonicalReference'];
}

export interface ClassicCutlinePreviewState {
    canSimplify?: boolean;
    /** Mức đang yêu cầu cho đúng trang; không lấy mức của frame cũ đang hiển thị. */
    effectiveSimplifyMm: number;
    /** PDF Alpha nhiều mảng: áp khi xuất, không có vector canonical để duyệt trước. */
    directSimplifyOnly?: boolean;
    preview: StickerCutlinePreview | null;
    canonicalReference: {
        sessionId: string;
        pageNumber: number;
        maskRevision: number;
        fingerprint: string;
        /** Mức Simplify thật sự đã gửi cho frame này; caller cũ coi thiếu là 0. */
        simplifyMm?: number;
        /** Đã xem lệnh CUT từ writer toàn trang, không phải snapshot một tem. */
        wholePage?: boolean;
    } | null;
    isPreparing: boolean;
    isUpdating: boolean;
    warning: string;
    error: string;
}

interface UseClassicCutlinePreviewOptions {
    enabled: boolean;
    resolveSourceFile: () => Promise<File | null>;
    documentIdentity: string;
    pageNumber: number;
    pageInstanceId: string | null;
    cutMode: string;
    cornerStyle: string;
    offsetMm: number;
    bleedMm: number;
    fillHoles: boolean;
    curveTension: number;
    cutlineDenoise: number;
    cutlineSimplifyMm?: number;
    /** Opt-in riêng của UI mới; false giữ nguyên cả lựa chọn thủ công 0. */
    autoSimplify?: boolean;
    forceContour: boolean;
    removeWhiteBg: boolean;
}

type ClassicCutlinePreviewFrameState = Omit<ClassicCutlinePreviewState, 'effectiveSimplifyMm'>;

const EMPTY_STATE: ClassicCutlinePreviewFrameState = {
    preview: null,
    canonicalReference: null,
    isPreparing: false,
    isUpdating: false,
    warning: '',
    error: '',
};

function isAbortError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && 'name' in error
        && (error as { name?: unknown }).name === 'AbortError',
    );
}

function cancelPreviewJobSilently(sessionId: string, generation: number): void {
    void cancelStickerCutlinePreviewJob(sessionId, generation).catch(() => undefined);
}

function waitForPreviewJobPoll(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException('Preview đường bế đã bị hủy.', 'AbortError'));
            return;
        }
        const abort = () => {
            window.clearTimeout(timer);
            reject(new DOMException('Preview đường bế đã bị hủy.', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, PREVIEW_JOB_POLL_MS);
        signal.addEventListener('abort', abort, { once: true });
    });
}

function pageInspection(
    inspection: StickerSourceInspection,
    pageNumber: number,
) {
    return inspection.pages.find(page => page.page_number === pageNumber) ?? null;
}

function recognitionWarning(manifest: StickerSourceDetection): string {
    const warnings = new Set(manifest.warnings ?? []);
    if (warnings.has('simple-bg-preview-denoise-fallback')) {
        return i18n.t(
            'preprocess.stickerSheet:classic_preview_rough_fallback',
        );
    }
    const confidence = Number(manifest.strategy_confidence);
    if (Number.isFinite(confidence) && confidence < 0.5) {
        return i18n.t(
            'preprocess.stickerSheet:classic_preview_low_confidence',
            { confidence: Math.round(confidence * 100) },
        );
    }
    return '';
}

/**
 * Chọn đúng nguồn mask mà lượt xuất classic sẽ dùng. Khi không bỏ nền trắng,
 * engine coi toàn bộ trang là vùng in; vector/ảnh nằm bên trong không có quyền
 * biến preview thành silhouette đã khử nền.
 */
function previewDetectionStrategy(
    inspection: StickerSourceInspection,
    pageNumber: number,
    cutMode: CutMode,
    forceContour: boolean,
    removeWhiteBg: boolean,
): StickerDetectionStrategy | null {
    const page = pageInspection(inspection, pageNumber);
    if (!page) return null;
    if (cutMode === 'alpha') return page.has_alpha ? 'alpha' : null;
    // QUALITY (feedback 2026-08-19 §CUTPREVIEW.PARITY1): nhánh thực thi
    // `remove_white_bg=false` dựng mask kín toàn trang. Phải chốt điều này trước
    // mọi gợi ý CutContour/vector/Alpha từ inspector, nếu không preview tự bóc
    // nền dù người dùng chưa bật tùy chọn.
    if (!removeWhiteBg) return 'page-box';
    if (forceContour && page.has_existing_cut) return null;
    if (!forceContour && page.has_existing_cut) return 'existing-cut';
    if (page.has_vector) return 'vector';
    if (page.has_alpha) return 'alpha';
    // PERF/STABILITY (feedback 2026-08-20 §CUTPREVIEW.MEM5): auto vẫn nâng một
    // silhouette nền phẳng lên Alpha AI khi đủ bộ nhớ, nên giữ parity với lượt
    // xuất. Khác với ép `ai`, nó còn mask deterministic để trả preview nếu DML
    // vừa dùng hết RAM; không biến một lỗi phụ thành màn hình trống.
    if (page.has_raster && removeWhiteBg && inspection.page_count === 1) return 'auto';
    return null;
}

function normalizedCutMode(value: string): CutMode {
    return ['original', 'alpha', 'bleed', 'none'].includes(value)
        ? value as CutMode
        : 'original';
}

function normalizedCornerStyle(value: string): CornerStyle {
    return ['preserve', 'round', 'miter'].includes(value)
        ? value as CornerStyle
        : 'preserve';
}

function compactNumber(value: number): string {
    const rounded = Math.abs(value) < 0.00005 ? 0 : Number(value.toFixed(4));
    return String(rounded);
}

function localPreviewFingerprint(payload: string): string {
    // Fingerprint chỉ dùng để phân biệt frame trong frontend; không phải chữ ký bảo mật.
    let hash = 2166136261;
    for (let index = 0; index < payload.length; index += 1) {
        hash ^= payload.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
}

function roundedPageBoxPath(
    left: number,
    top: number,
    right: number,
    bottom: number,
    radius: number,
): string {
    const x0 = compactNumber(left);
    const y0 = compactNumber(top);
    const x1 = compactNumber(right);
    const y1 = compactNumber(bottom);
    if (radius <= 0.00005) {
        return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
    }

    const handle = radius * 0.5522847498307936;
    const leftRadius = compactNumber(left + radius);
    const rightRadius = compactNumber(right - radius);
    const topRadius = compactNumber(top + radius);
    const bottomRadius = compactNumber(bottom - radius);
    const rightMinusHandle = compactNumber(right - radius + handle);
    const rightTopHandle = compactNumber(top + radius - handle);
    const rightBottomHandle = compactNumber(bottom - radius + handle);
    const rightRadiusMinusHandle = compactNumber(right - radius + handle);
    const leftRadiusMinusHandle = compactNumber(left + radius - handle);
    const bottomMinusHandle = compactNumber(bottom - radius + handle);
    const leftTopHandle = compactNumber(top + radius - handle);

    return [
        `M ${leftRadius} ${y0}`,
        `L ${rightRadius} ${y0}`,
        `C ${rightMinusHandle} ${y0} ${x1} ${rightTopHandle} ${x1} ${topRadius}`,
        `L ${x1} ${bottomRadius}`,
        `C ${x1} ${rightBottomHandle} ${rightRadiusMinusHandle} ${y1} ${rightRadius} ${y1}`,
        `L ${leftRadius} ${y1}`,
        `C ${leftRadiusMinusHandle} ${y1} ${x0} ${bottomMinusHandle} ${x0} ${bottomRadius}`,
        `L ${x0} ${topRadius}`,
        `C ${x0} ${leftTopHandle} ${leftRadiusMinusHandle} ${y0} ${leftRadius} ${y0}`,
        'Z',
    ].join(' ');
}

/**
 * PERF/QUALITY (feedback 2026-08-19 §CUTPREVIEW.INSTANT1): khi giữ nguyên nền,
 * đường cắt chắc chắn là khung trang. Dựng thẳng SVG theo mm đang có trong Viewer;
 * không upload, inspect, render PDF rồi mới nhận lại đúng một hình chữ nhật.
 */
export function buildLocalPageBoxPreview(input: {
    pageNumber: number;
    viewerPagePhysical: Pick<ViewerActivePagePhysical, 'widthPt' | 'heightPt'>;
    cutMode: CutMode;
    cornerStyle: CornerStyle;
    offsetMm: number;
    bleedMm: number;
    curveTension: number;
}): StickerCutlinePreview | null {
    const pageWidthMm = input.viewerPagePhysical.widthPt * POINT_TO_MM;
    const pageHeightMm = input.viewerPagePhysical.heightPt * POINT_TO_MM;
    if (
        !Number.isFinite(pageWidthMm)
        || !Number.isFinite(pageHeightMm)
        || pageWidthMm <= 0
        || pageHeightMm <= 0
    ) return null;

    const geometry = computeStickerBleedGeometry(
        input.cutMode,
        input.offsetMm,
        input.bleedMm,
    );
    if (geometry.cutOffsetMm === null) return null;
    const cutOffsetMm = geometry.cutOffsetMm;
    const left = -cutOffsetMm;
    const top = -cutOffsetMm;
    const right = pageWidthMm + cutOffsetMm;
    const bottom = pageHeightMm + cutOffsetMm;
    const cutWidth = right - left;
    const cutHeight = bottom - top;
    if (cutWidth <= 0 || cutHeight <= 0) return null;

    const roundness = Math.max(0, Math.min(100, input.curveTension)) / 100;
    const shortestEdge = Math.min(cutWidth, cutHeight);
    const radius = input.cornerStyle === 'round'
        ? Math.max(0, Math.min(
            roundness * CUTLINE_ROUND_RADIUS_MAX_MM,
            shortestEdge * 0.45,
            (shortestEdge - MINIMUM_STRAIGHT_MM) / 2,
        ))
        : 0;
    const d = roundedPageBoxPath(left, top, right, bottom, radius);
    const fingerprint = localPreviewFingerprint(JSON.stringify({
        page: input.pageNumber,
        pageWidthMm,
        pageHeightMm,
        cutOffsetMm,
        cornerStyle: input.cornerStyle,
        radius,
    }));
    return {
        page_number: input.pageNumber,
        mask_revision: 1,
        preview_width_px: pageWidthMm,
        preview_height_px: pageHeightMm,
        paths: [{
            instance_id: 1,
            d,
            segment_count: radius > 0 ? 8 : 4,
        }],
        fingerprint,
        segment_count: radius > 0 ? 8 : 4,
    };
}

/**
 * PERF/UIUX (feedback 2026-08-19 §CUTPREVIEW.1): chuẩn bị mask đúng một lần,
 * sau đó serialize tối đa một request fit. Khi kéo liên tục chỉ giữ yêu cầu cuối,
 * không xuất PDF, không tải ảnh preview và không cho response cũ ghi đè.
 */
export function useClassicCutlinePreview({
    enabled,
    resolveSourceFile,
    documentIdentity,
    pageNumber,
    pageInstanceId,
    cutMode,
    cornerStyle,
    offsetMm,
    bleedMm,
    fillHoles,
    curveTension,
    cutlineDenoise,
    cutlineSimplifyMm = 0,
    autoSimplify = false,
    forceContour,
    removeWhiteBg,
}: UseClassicCutlinePreviewOptions): ClassicCutlinePreviewState {
    const viewerPagePhysical = useWorkspaceStore(
        workspace => workspace.viewerActivePagePhysical,
    );
    const detectionCutMode: CutMode = normalizedCutMode(cutMode) === 'alpha'
        ? 'alpha'
        : 'original';
    const resolvedCutMode = normalizedCutMode(cutMode);
    const resolvedCornerStyle = resolvedCutMode === 'alpha'
        ? 'preserve'
        : normalizedCornerStyle(cornerStyle);
    const usesLocalPageBox = Boolean(
        enabled
        && !removeWhiteBg
        && resolvedCutMode !== 'alpha'
        && resolvedCutMode !== 'none'
    );
    const localPageBoxPreview = useMemo(() => {
        if (
            !usesLocalPageBox
            || !viewerPagePhysical
            || viewerPagePhysical.documentIdentity !== documentIdentity
            || viewerPagePhysical.viewerPage !== pageNumber
            || (
                pageInstanceId !== null
                && viewerPagePhysical.pageInstanceId !== pageInstanceId
            )
        ) return null;
        return buildLocalPageBoxPreview({
            pageNumber,
            viewerPagePhysical,
            cutMode: resolvedCutMode,
            cornerStyle: resolvedCornerStyle,
            offsetMm,
            bleedMm,
            curveTension: resolvedCornerStyle === 'round' ? curveTension : 0,
        });
    }, [
        bleedMm,
        curveTension,
        documentIdentity,
        offsetMm,
        pageInstanceId,
        pageNumber,
        resolvedCornerStyle,
        resolvedCutMode,
        usesLocalPageBox,
        viewerPagePhysical,
    ]);
    const [source, setSource] = useState<PreviewSource | null>(null);
    const [sessionVersion, setSessionVersion] = useState(0);
    const [state, setState] = useState<ClassicCutlinePreviewFrameState>(EMPTY_STATE);
    const [pumpVersion, setPumpVersion] = useState(0);
    const generationRef = useRef(0);
    const mountedRef = useRef(true);
    const sessionRef = useRef<PreviewSession | null>(null);
    const pageSourceCacheRef = useRef<Map<string, PreviewSource>>(new Map());
    const previewCacheRef = useRef<Map<string, CachedPreviewFrame>>(new Map());
    const activePageKeyRef = useRef('');
    const desiredRef = useRef<PreviewRequest | null>(null);
    const latestKeyRef = useRef('');
    const jobGenerationRef = useRef(0);
    const activePreviewJobRef = useRef<{
        sessionId: string;
        generation: number;
    } | null>(null);
    const previewAbortRef = useRef<AbortController | null>(null);
    // PERF/QUALITY (2026-09-10 §SIMPLIFY.AUTO): chốt sau detection, TRƯỚC fit đầu
    // tiên; không fit 0 rồi mới bật 0,10. Không suy quyền từ canSimplify (có vector).
    const sourceIsCurrent = Boolean(source
        && source.generation === generationRef.current
        && source.documentIdentity === documentIdentity
        && source.pageNumber === pageNumber
        && source.pageInstanceId === pageInstanceId);
    const resolvedSimplifyMm = autoSimplify
        ? (enabled && !usesLocalPageBox && resolvedCutMode !== 'none'
            && sourceIsCurrent && source?.autoSimplifyEligible
            ? DEFAULT_AUTO_CUTLINE_SIMPLIFY_MM : 0)
        : resolveStickerCutlineSimplifyMm(cutlineSimplifyMm);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            previewAbortRef.current?.abort();
            const active = activePreviewJobRef.current;
            if (active) cancelPreviewJobSilently(active.sessionId, active.generation);
        };
    }, []);

    // Session sống theo tài liệu/tab. Đổi trang chỉ đổi cache entry; không đóng
    // session vì backend đã giữ artifact độc lập cho từng trang.
    useEffect(() => {
        const generation = generationRef.current + 1;
        generationRef.current = generation;
        sessionRef.current = null;
        pageSourceCacheRef.current.clear();
        previewCacheRef.current.clear();
        activePageKeyRef.current = '';
        desiredRef.current = null;
        latestKeyRef.current = '';
        previewAbortRef.current?.abort();
        setSource(null);

        if (!enabled || usesLocalPageBox) {
            setState(EMPTY_STATE);
            return undefined;
        }

        let sessionId: string | null = null;
        let disposed = false;
        const controller = new AbortController();
        setState({
            preview: null,
            canonicalReference: null,
            isPreparing: true,
            isUpdating: false,
            warning: '',
            error: '',
        });

        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    const file = await resolveSourceFile();
                    if (!file) {
                        throw new Error(i18n.t('preprocess.stickerSheet:classic_preview_no_file'));
                    }
                    const inspection = await inspectStickerSourceManifest(file, controller.signal);
                    sessionId = inspection.session_id;
                    if (
                        disposed
                        || generationRef.current !== generation
                        || controller.signal.aborted
                    ) {
                        void closeStickerSheetSession(sessionId);
                        sessionId = null;
                        return;
                    }
                    sessionRef.current = { sessionId, inspection, generation };
                    setSessionVersion(version => version + 1);
                } catch (error) {
                    if (sessionId) {
                        void closeStickerSheetSession(sessionId);
                        sessionId = null;
                    }
                    if (
                        disposed
                        || controller.signal.aborted
                        || isAbortError(error)
                        || generationRef.current !== generation
                    ) return;
                    setState({
                        preview: null,
                        canonicalReference: null,
                        isPreparing: false,
                        isUpdating: false,
                        warning: '',
                        error: error instanceof Error
                            ? error.message
                            : i18n.t('preprocess.stickerSheet:classic_preview_error'),
                    });
                }
            })();
        }, SOURCE_DEBOUNCE_MS);

        return () => {
            disposed = true;
            window.clearTimeout(timer);
            controller.abort();
            desiredRef.current = null;
            latestKeyRef.current = '';
            previewAbortRef.current?.abort();
            if (sessionRef.current?.generation === generation) sessionRef.current = null;
            if (sessionId) {
                cancelPreviewJobSilently(sessionId, jobGenerationRef.current);
                void closeStickerSheetSession(sessionId);
            }
            if (generationRef.current === generation) generationRef.current += 1;
        };
    }, [
        documentIdentity,
        detectionCutMode,
        enabled,
        forceContour,
        removeWhiteBg,
        resolveSourceFile,
        usesLocalPageBox,
    ]);

    // Detect đúng trang khi cần. Kết quả manifest được giữ lại theo page instance
    // để lướt qua lại không chạy nhận diện lần nữa trong cùng tab.
    useEffect(() => {
        const pageKey = `${documentIdentity}|${pageNumber}:${pageInstanceId ?? ''}`;
        activePageKeyRef.current = pageKey;
        desiredRef.current = null;
        latestKeyRef.current = '';
        previewAbortRef.current?.abort();
        setSource(null);

        const session = sessionRef.current;
        if (
            !enabled
            || usesLocalPageBox
            || !session
            || session.generation !== generationRef.current
        ) return undefined;

        const cachedSource = pageSourceCacheRef.current.get(pageKey);
        if (cachedSource) {
            setSource(cachedSource);
            const cachedFrame = [...previewCacheRef.current.entries()]
                .find(([, frame]) => (
                    frame.preview.page_number === pageNumber
                    && frame.canonicalReference?.sessionId === cachedSource.sessionId
                    && frame.canonicalReference?.maskRevision === (cachedSource.manifest.mask_revision ?? 1)
                    && frame.preview.paths.length > 0
                ))?.[1];
            setState(cachedFrame ? {
                canSimplify: !['existing-cut', 'page-box'].includes(cachedSource.manifest.boundary_source),
                preview: cachedFrame.preview,
                canonicalReference: cachedFrame.canonicalReference,
                isPreparing: false,
                isUpdating: false,
                warning: recognitionWarning(cachedSource.manifest),
                error: '',
            } : {
                canSimplify: !['existing-cut', 'page-box'].includes(cachedSource.manifest.boundary_source),
                preview: null,
                canonicalReference: null,
                isPreparing: false,
                isUpdating: true,
                warning: recognitionWarning(cachedSource.manifest),
                error: '',
            });
            return undefined;
        }

        setState({
            preview: null,
            canonicalReference: null,
            isPreparing: true,
            isUpdating: false,
            warning: '',
            error: '',
        });
        let disposed = false;
        const controller = new AbortController();
        void (async () => {
            try {
                const strategy = previewDetectionStrategy(
                    session.inspection,
                    pageNumber,
                    detectionCutMode,
                    forceContour,
                    removeWhiteBg,
                );
                if (!strategy) {
                    throw new Error(i18n.t(
                        'preprocess.stickerSheet:classic_preview_no_boundary',
                    ));
                }
                const manifest = await detectStickerSourceManifest(session.sessionId, {
                    strategy,
                    pageNumber,
                    // PERF/QUALITY (feedback 2026-08-21 §CUTPREVIEW.GATE2):
                    // chỉ detect khi trang chưa có manifest trong cache session.
                    previewOnly: true,
                    signal: controller.signal,
                });
                const current = (
                    !disposed
                    && mountedRef.current
                    && sessionRef.current === session
                    && generationRef.current === session.generation
                    && activePageKeyRef.current === pageKey
                    && !controller.signal.aborted
                );
                if (manifest.instances.length === 0) {
                    throw new Error(i18n.t(
                        'preprocess.stickerSheet:classic_preview_single_only',
                    ));
                }
                // UIUX (2026-09-10 §MULTI-ALPHA.WHOLE): nhiều mảng alpha
                // trên PDF → dùng engine toàn trang như lượt Thực thi.
                const useWholePage = Boolean(
                    manifest.instances.length > 1
                    && session.inspection.source_kind === 'pdf'
                    && manifest.boundary_source === 'alpha'
                    && !pageInspection(session.inspection, pageNumber)?.has_existing_cut
                );
                if (manifest.instances.length !== 1 && !useWholePage) {
                    throw new Error(i18n.t(
                        'preprocess.stickerSheet:classic_preview_single_only',
                    ));
                }
                const nextSource: PreviewSource = {
                    sessionId: session.sessionId,
                    manifest,
                    generation: session.generation,
                    documentIdentity,
                    pageNumber,
                    pageInstanceId,
                    classicWholePage: useWholePage,
                    forceContour,
                    autoSimplifyEligible: ['alpha', 'simple-bg', 'ai'].includes(manifest.boundary_source)
                        && pageInspection(session.inspection, pageNumber)?.has_existing_cut === false,
                };
                pageSourceCacheRef.current.set(pageKey, nextSource);
                if (!current) return;
                setSource(nextSource);
                setState(currentState => ({
                    ...currentState,
                    canSimplify: !['existing-cut', 'page-box'].includes(manifest.boundary_source),
                    canonicalReference: null,
                    isPreparing: false,
                    isUpdating: true,
                    warning: recognitionWarning(manifest),
                    error: '',
                }));
            } catch (error) {
                if (
                    disposed
                    || controller.signal.aborted
                    || isAbortError(error)
                    || sessionRef.current !== session
                    || generationRef.current !== session.generation
                    || activePageKeyRef.current !== pageKey
                ) return;
                setState({
                    preview: null,
                    canonicalReference: null,
                    isPreparing: false,
                    isUpdating: false,
                    warning: '',
                    error: error instanceof Error
                        ? error.message
                        : i18n.t('preprocess.stickerSheet:classic_preview_error'),
                });
            }
        })();
        return () => {
            disposed = true;
            controller.abort();
        };
    }, [
        detectionCutMode,
        documentIdentity,
        enabled,
        forceContour,
        pageInstanceId,
        pageNumber,
        removeWhiteBg,
        sessionVersion,
        usesLocalPageBox,
    ]);

    // Mỗi thay đổi hình học chỉ thay desired request. Timer cũ bị hủy nếu người dùng
    // tiếp tục kéo trong 40 ms; job đang chạy nhận tombstone để worker ưu tiên frame mới.
    useEffect(() => {
        if (!enabled || usesLocalPageBox || !source
            || source.generation !== generationRef.current || !sourceIsCurrent) return undefined;
        // Parity với builder xuất: Alpha luôn giữ nguyên góc dù trước đó người dùng
        // từng chọn Góc tròn; thanh lúc này cũng đang ẩn.
        const request: PreviewRequest = {
            key: JSON.stringify({
                sessionId: source.sessionId,
                pageNumber,
                pageInstanceId,
                revision: source.manifest.mask_revision ?? 1,
                offsetMm,
                bleedMm,
                cutMode: resolvedCutMode,
                cornerStyle: resolvedCornerStyle,
                fillHoles,
                curveTension: resolvedCornerStyle === 'round' ? curveTension : 50,
                cutlineDenoise,
                cutlineSimplifyMm: resolvedSimplifyMm,
            }),
            generation: generationRef.current,
            // PERF (audit 2026-09-11 §PREWARM.CANCEL): mỗi slider tick là một
            // lượt mới cho worker; generation của session không đủ phân biệt.
            jobGeneration: jobGenerationRef.current + 1,
            source,
            pageNumber,
            cutMode: resolvedCutMode,
            cornerStyle: resolvedCornerStyle,
            offsetMm,
            bleedMm,
            fillHoles,
            curveTension: resolvedCornerStyle === 'round' ? curveTension : 50,
            cutlineDenoise,
            cutlineSimplifyMm: resolvedSimplifyMm,
        };
        jobGenerationRef.current = request.jobGeneration;
        latestKeyRef.current = request.key;
        // QUALITY (audit 2026-08-21 §CANONICAL.4): vẫn giữ SVG cũ để Viewer
        // không chớp, nhưng reference phải stale NGAY khi thông số đổi.
        setState(current => ({
            ...current,
            canonicalReference: null,
            isPreparing: false,
            isUpdating: true,
            error: '',
        }));
        const cachedFrame = previewCacheRef.current.get(request.key);
        if (cachedFrame) {
            setState(current => ({
                ...current,
                preview: cachedFrame.preview,
                canonicalReference: cachedFrame.canonicalReference,
                isPreparing: false,
                isUpdating: false,
                error: '',
            }));
            return undefined;
        }
        const timer = window.setTimeout(() => {
            desiredRef.current = request;
            setPumpVersion(version => version + 1);
        }, TUNING_DEBOUNCE_MS);
        return () => {
            window.clearTimeout(timer);
            // Tombstone cả request chưa kịp POST: nếu timer/network cũ tới trễ,
            // backend vẫn từ chối nó và không làm hàng preview mới chậm đi.
            cancelPreviewJobSilently(request.source.sessionId, request.jobGeneration);
            const active = activePreviewJobRef.current;
            if (
                active
                && active.sessionId === request.source.sessionId
                && active.generation <= request.jobGeneration
            ) {
                previewAbortRef.current?.abort();
                activePreviewJobRef.current = null;
            }
        };
    }, [
        bleedMm,
        cornerStyle,
        curveTension,
        cutMode,
        cutlineDenoise,
        enabled,
        fillHoles,
        offsetMm,
        pageNumber,
        source,
        sourceIsCurrent,
        resolvedCornerStyle,
        resolvedCutMode,
        resolvedSimplifyMm,
        usesLocalPageBox,
    ]);

    // Job POST trả nhanh; pool backend hủy/coalesce lượt cũ thay vì để UI chờ
    // toàn bộ fitter. Poll nối tiếp nên mỗi job chỉ có tối đa một GET đang bay.
    useEffect(() => {
        const requested = desiredRef.current;
        if (!requested) return;
        desiredRef.current = null;
        const controller = new AbortController();
        previewAbortRef.current = controller;
        activePreviewJobRef.current = {
            sessionId: requested.source.sessionId,
            generation: requested.jobGeneration,
        };
        const options: StickerCutlinePreviewOptions = {
            baseRevision: requested.source.manifest.mask_revision ?? 1,
            pageNumber: requested.pageNumber,
            edits: [],
            dpi: requested.source.manifest.dpi?.[0] ?? 300,
            dpiY: requested.source.manifest.dpi?.[1] ?? requested.source.manifest.dpi?.[0] ?? 300,
            offsetMm: requested.offsetMm,
            bleedMm: requested.bleedMm,
            cutMode: requested.cutMode,
            cornerStyle: requested.cornerStyle,
            fillHoles: requested.fillHoles,
            cutlineSmoothness: 50,
            cutlineFidelity: 50,
            curveTension: requested.curveTension,
            minDetailAreaMm2: 1,
            cutlineDenoise: requested.cutlineDenoise,
            cutlineSimplifyMm: requested.cutlineSimplifyMm,
            classicWholePage: requested.source.classicWholePage,
            classicForceContour: requested.source.forceContour,
            signal: controller.signal,
        };
        const isStale = () => (
            controller.signal.aborted
            || requested.generation !== generationRef.current
            || requested.key !== latestKeyRef.current
            || desiredRef.current !== null
            || activePreviewJobRef.current?.sessionId !== requested.source.sessionId
            || activePreviewJobRef.current?.generation !== requested.jobGeneration
        );
        const acceptReady = (payload: StickerCutlinePreview) => {
            if (requested.source.classicWholePage && (
                payload.classic_whole_page !== true
                || payload.page_number !== requested.pageNumber
                || payload.mask_revision !== (requested.source.manifest.mask_revision ?? 1)
            )) {
                // Backend cũ không hiểu mode này có thể trả các mảng tách;
                // không được hiển thị chúng như đường bế toàn trang đã duyệt.
                throw new Error(i18n.t('preprocess.stickerSheet:classic_preview_update_error'));
            }
            const stale = isStale();
            if (
                sessionRef.current?.generation === requested.generation
                && sessionRef.current.sessionId === requested.source.sessionId
            ) {
                previewCacheRef.current.set(requested.key, {
                    preview: payload,
                    canonicalReference: {
                        sessionId: requested.source.sessionId,
                        pageNumber: payload.page_number,
                        maskRevision: payload.mask_revision,
                        fingerprint: payload.fingerprint,
                        simplifyMm: requested.cutlineSimplifyMm,
                        ...(requested.source.classicWholePage ? { wholePage: true } : {}),
                    },
                });
            }
            if (!stale && mountedRef.current) {
                setState(current => ({
                    ...current,
                    preview: payload,
                    canonicalReference: {
                        sessionId: requested.source.sessionId,
                        pageNumber: payload.page_number,
                        maskRevision: payload.mask_revision,
                        fingerprint: payload.fingerprint,
                        simplifyMm: requested.cutlineSimplifyMm,
                        ...(requested.source.classicWholePage ? { wholePage: true } : {}),
                    },
                    isPreparing: false,
                    isUpdating: false,
                    error: '',
                }));
            }
        };
        const settleTerminal = (job: StickerCutlinePreviewJob) => {
            if (job.status === 'ready') {
                if (!job.result) {
                    throw new Error(i18n.t('preprocess.stickerSheet:classic_preview_update_error'));
                }
                acceptReady(job.result);
                return;
            }
            if (job.status === 'failed') {
                throw new Error(job.error || i18n.t('preprocess.stickerSheet:classic_preview_update_error'));
            }
            if (!isStale() && mountedRef.current) {
                // Hủy chỉ có nghĩa frame này không còn canonical; giữ SVG cũ
                // để user so sánh, nhưng không mở lại quyền Execute.
                setState(current => ({
                    ...current,
                    canonicalReference: null,
                    isPreparing: false,
                    isUpdating: false,
                    error: '',
                }));
            }
        };

        void (async () => {
            try {
                let job = await startStickerCutlinePreviewJob(
                    requested.source.sessionId,
                    requested.jobGeneration,
                    options,
                );
                while (job.status === 'preparing' || job.status === 'simplifying') {
                    if (isStale()) return;
                    await waitForPreviewJobPoll(controller.signal);
                    if (isStale()) return;
                    job = await readStickerCutlinePreviewJob(
                        requested.source.sessionId,
                        job.job_id,
                        controller.signal,
                    );
                }
                if (isStale()) return;
                settleTerminal(job);
            } catch (error) {
                const stale = isStale();
            if (!stale && mountedRef.current && !isAbortError(error)) {
                setState(current => ({
                    ...current,
                    isPreparing: false,
                    isUpdating: false,
                    error: error instanceof Error
                        ? error.message
                        : i18n.t('preprocess.stickerSheet:classic_preview_update_error'),
                }));
            }
            } finally {
            if (previewAbortRef.current === controller) previewAbortRef.current = null;
            if (
                activePreviewJobRef.current?.sessionId === requested.source.sessionId
                && activePreviewJobRef.current?.generation === requested.jobGeneration
            ) {
                activePreviewJobRef.current = null;
            }
            }
        })();
    }, [pumpVersion]);

    if (usesLocalPageBox) {
        return {
            effectiveSimplifyMm: 0,
            preview: localPageBoxPreview,
            canonicalReference: null,
            isPreparing: false,
            isUpdating: false,
            warning: '',
            error: '',
        };
    }
    return { ...state, effectiveSimplifyMm: resolvedSimplifyMm };
}
