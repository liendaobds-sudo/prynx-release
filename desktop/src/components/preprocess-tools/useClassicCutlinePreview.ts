import { useEffect, useMemo, useRef, useState } from 'react';

import {
    closeStickerSheetSession,
    detectStickerSourceManifest,
    inspectStickerSourceManifest,
    previewStickerCutline,
    type StickerCutlinePreview,
    type StickerDetectionStrategy,
    type StickerSourceDetection,
    type StickerSourceInspection,
} from '../../lib/stickerSheetApi';
import i18n from '../../i18n';
import { computeStickerBleedGeometry } from '../../lib/stickerBleedGeometry';
import {
    useWorkspaceStore,
    type ViewerActivePagePhysical,
} from '../../stores/useWorkspaceStore';


const SOURCE_DEBOUNCE_MS = 220;
const TUNING_DEBOUNCE_MS = 40;
const POINT_TO_MM = 25.4 / 72;
/** Phải khớp `_CUTLINE_ROUND_RADIUS_MAX_MM` phía backend. */
const CUTLINE_ROUND_RADIUS_MAX_MM = 3;
const MINIMUM_STRAIGHT_MM = 0.25;

type CutMode = 'original' | 'alpha' | 'bleed' | 'none';
type CornerStyle = 'preserve' | 'round' | 'miter';

interface PreviewSource {
    sessionId: string;
    manifest: StickerSourceDetection;
}

interface PreviewRequest {
    key: string;
    generation: number;
    source: PreviewSource;
    pageNumber: number;
    cutMode: CutMode;
    cornerStyle: CornerStyle;
    offsetMm: number;
    bleedMm: number;
    fillHoles: boolean;
    curveTension: number;
    cutlineDenoise: number;
}

export interface ClassicCutlinePreviewState {
    preview: StickerCutlinePreview | null;
    canonicalReference: {
        sessionId: string;
        pageNumber: number;
        maskRevision: number;
        fingerprint: string;
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
    forceContour: boolean;
    removeWhiteBg: boolean;
}

const EMPTY_STATE: ClassicCutlinePreviewState = {
    preview: null,
    canonicalReference: null,
    isPreparing: false,
    isUpdating: false,
    warning: '',
    error: '',
};

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
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
    const leftBottomHandle = compactNumber(bottom - radius + handle);
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
    const [state, setState] = useState<ClassicCutlinePreviewState>(EMPTY_STATE);
    const [pumpVersion, setPumpVersion] = useState(0);
    const generationRef = useRef(0);
    const mountedRef = useRef(true);
    const desiredRef = useRef<PreviewRequest | null>(null);
    const latestKeyRef = useRef('');
    const runningRef = useRef(false);
    const previewAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            previewAbortRef.current?.abort();
        };
    }, []);

    // Tạo session theo file/trang đúng một lần. Debounce tránh mở session cho tab
    // vừa lướt qua; cleanup đóng ngay khi đổi file, đổi trang hoặc tab thành nền.
    useEffect(() => {
        const generation = generationRef.current + 1;
        generationRef.current = generation;
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
                    const strategy = previewDetectionStrategy(
                        inspection,
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
                    const manifest = await detectStickerSourceManifest(sessionId, {
                        strategy,
                        pageNumber,
                        // PERF/QUALITY (feedback 2026-08-21 §CUTPREVIEW.GATE2):
                        // nền phẳng sạch đi fast path; mask có răng cưa/halo vẫn
                        // được backend nâng Alpha AI một lần rồi dùng chung cho
                        // preview và xuất file qua canonical reference.
                        previewOnly: true,
                        signal: controller.signal,
                    });
                    if (manifest.instances.length !== 1) {
                        throw new Error(i18n.t(
                            'preprocess.stickerSheet:classic_preview_single_only',
                        ));
                    }
                    if (
                        disposed
                        || generationRef.current !== generation
                        || controller.signal.aborted
                    ) {
                        void closeStickerSheetSession(sessionId);
                        sessionId = null;
                        return;
                    }
                    setSource({ sessionId, manifest });
                    setState(current => ({
                        ...current,
                        canonicalReference: null,
                        isPreparing: false,
                        isUpdating: true,
                        warning: recognitionWarning(manifest),
                        error: '',
                    }));
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
            if (sessionId) void closeStickerSheetSession(sessionId);
            if (generationRef.current === generation) generationRef.current += 1;
        };
    }, [
        documentIdentity,
        detectionCutMode,
        enabled,
        forceContour,
        pageNumber,
        pageInstanceId,
        removeWhiteBg,
        resolveSourceFile,
        usesLocalPageBox,
    ]);

    // Mỗi thay đổi hình học chỉ thay desired request. Timer cũ bị hủy nếu người dùng
    // tiếp tục kéo trong 40 ms; request đang chạy vẫn hoàn tất trước khi chạy frame mới.
    useEffect(() => {
        if (!enabled || usesLocalPageBox || !source) return undefined;
        // Parity với builder xuất: Alpha luôn giữ nguyên góc dù trước đó người dùng
        // từng chọn Góc tròn; thanh lúc này cũng đang ẩn.
        const request: PreviewRequest = {
            key: JSON.stringify({
                sessionId: source.sessionId,
                pageNumber,
                revision: source.manifest.mask_revision ?? 1,
                offsetMm,
                bleedMm,
                cutMode: resolvedCutMode,
                cornerStyle: resolvedCornerStyle,
                fillHoles,
                curveTension: resolvedCornerStyle === 'round' ? curveTension : 50,
                cutlineDenoise,
            }),
            generation: generationRef.current,
            source,
            pageNumber,
            cutMode: resolvedCutMode,
            cornerStyle: resolvedCornerStyle,
            offsetMm,
            bleedMm,
            fillHoles,
            curveTension: resolvedCornerStyle === 'round' ? curveTension : 50,
            cutlineDenoise,
        };
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
        const timer = window.setTimeout(() => {
            desiredRef.current = request;
            setPumpVersion(version => version + 1);
        }, TUNING_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
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
        usesLocalPageBox,
    ]);

    // Pump nối tiếp: không bao giờ có hai fit cùng lúc cho một StickerTool.
    useEffect(() => {
        const requested = desiredRef.current;
        if (!requested || runningRef.current) return;
        desiredRef.current = null;
        runningRef.current = true;
        const controller = new AbortController();
        previewAbortRef.current = controller;

        void previewStickerCutline(requested.source.sessionId, {
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
            signal: controller.signal,
        }).then(payload => {
            const stale = (
                requested.generation !== generationRef.current
                || requested.key !== latestKeyRef.current
                || desiredRef.current !== null
            );
            if (!stale && mountedRef.current) {
                setState(current => ({
                    ...current,
                    preview: payload,
                    canonicalReference: {
                        sessionId: requested.source.sessionId,
                        pageNumber: payload.page_number,
                        maskRevision: payload.mask_revision,
                        fingerprint: payload.fingerprint,
                    },
                    isPreparing: false,
                    isUpdating: false,
                    error: '',
                }));
            }
        }).catch(error => {
            const stale = (
                requested.generation !== generationRef.current
                || requested.key !== latestKeyRef.current
                || desiredRef.current !== null
            );
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
        }).finally(() => {
            if (previewAbortRef.current === controller) previewAbortRef.current = null;
            runningRef.current = false;
            if (mountedRef.current && desiredRef.current) {
                setPumpVersion(version => version + 1);
            }
        });
    }, [pumpVersion]);

    if (usesLocalPageBox) {
        return {
            preview: localPageBoxPreview,
            canonicalReference: null,
            isPreparing: false,
            isUpdating: false,
            warning: '',
            error: '',
        };
    }
    return state;
}
