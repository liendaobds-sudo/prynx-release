import { authenticatedFetch, formatApiErrorDetail, getApiUrl } from './api';


export type StickerSheetModel = 'birefnet-lite' | 'birefnet-full' | 'isnet';
export type StickerShadowCleanup = 'off' | 'auto';
export type StickerSourceKind = 'pdf' | 'raster';
export type StickerBoundarySource = 'existing-cut' | 'vector' | 'alpha' | 'simple-bg' | 'ai' | 'manual';
export type StickerDetectionStrategy = 'auto' | 'existing-cut' | 'vector' | 'alpha' | 'simple-bg' | 'ai';

export interface StickerSheetInstance {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    area_px: number;
    confidence: number;
    uncertain_ratio: number;
}

export interface StickerSheetManifest {
    session_id: string;
    original_name: string;
    original_width_px: number;
    original_height_px: number;
    analysis_width_px: number;
    analysis_height_px: number;
    preview_width_px: number;
    preview_height_px: number;
    dpi: [number, number] | null;
    model: StickerSheetModel;
    model_seconds: number;
    postprocess_seconds: number;
    refine_seconds?: number | null;
    mask_revision?: number;
    refinement_available?: boolean;
    alpha_threshold?: number;
    shadow_cleanup?: StickerShadowCleanup;
    instances: StickerSheetInstance[];
    warnings: string[];
    preview_url: string;
    labels_url: string;
    uncertainty_url: string;
}

export interface StickerSourcePage {
    page_number: number;
    width_mm: number | null;
    height_mm: number | null;
    has_existing_cut: boolean;
    has_vector: boolean;
    has_raster: boolean;
    has_alpha: boolean;
    cut_contour_count: number;
}

export interface StickerSourceInspection {
    session_id: string;
    stage: 'inspected';
    original_name: string;
    source_kind: StickerSourceKind;
    mime_type: string;
    boundary_source: StickerBoundarySource;
    strategy_confidence: number;
    needs_review: boolean;
    page_count: number;
    source_width_px: number | null;
    source_height_px: number | null;
    dpi: [number, number] | null;
    physical_width_mm: number | null;
    physical_height_mm: number | null;
    preview_width_px: number;
    preview_height_px: number;
    has_existing_cut: boolean;
    has_vector: boolean;
    has_raster: boolean;
    has_alpha: boolean;
    cut_contour_count: number;
    pages: StickerSourcePage[];
    warnings: string[];
    preview_url: string;
}

export interface StickerSourceDetection extends StickerSheetManifest {
    stage: 'mask-review';
    source_kind: StickerSourceKind;
    boundary_source: StickerBoundarySource;
    strategy_confidence: number;
    needs_review: boolean;
    page_count: number;
    source_page: number;
    vector_geometry_ref: Record<string, unknown> | null;
}

export interface StickerSourceInspectPayload {
    inspection: StickerSourceInspection;
    previewBlob: Blob;
}

export interface StickerSourceDetectionPayload {
    manifest: StickerSourceDetection;
    previewBlob: Blob;
    labelsBlob: Blob;
    uncertaintyBlob: Blob;
}

export class StickerRefineAssetSyncError extends Error {
    readonly manifest: StickerSourceDetection;

    constructor(manifest: StickerSourceDetection) {
        super('Không đồng bộ được ảnh xem trước mới. Hãy phân tích lại ảnh.');
        this.name = 'StickerRefineAssetSyncError';
        this.manifest = manifest;
    }
}

export interface StickerSheetExportPayload {
    blob: Blob;
    filename: string;
    outputPath?: string;
    stickerCount: number;
}

export interface StickerSheetExportEdit {
    kind: 'stroke' | 'merge';
    id: string;
    tool?: 'erase' | 'restore';
    instanceId?: number;
    radius?: number;
    points?: Array<{ x: number; y: number }>;
    sourceId?: number;
    targetId?: number;
}

export interface StickerSheetPageExport {
    sourcePage: number;
    expectedRevision: number;
    edits: StickerSheetExportEdit[];
    dpi?: number;
    dpiY?: number;
    cutlineSmoothness?: number;
    cutlineFidelity?: number;
    curveTension?: number;
    minDetailAreaMm2?: number;
}

export interface StickerCutlinePreviewPath {
    instance_id: number;
    d: string;
    segment_count: number;
}

export interface StickerCutlinePreview {
    page_number: number;
    mask_revision: number;
    preview_width_px: number;
    preview_height_px: number;
    paths: StickerCutlinePreviewPath[];
    fingerprint: string;
    segment_count: number;
}

function serializeStickerSheetEdit(edit: StickerSheetExportEdit) {
    return edit.kind === 'stroke'
        ? {
            kind: 'stroke', id: edit.id, tool: edit.tool,
            instance_id: edit.instanceId, radius: edit.radius, points: edit.points,
        }
        : {
            kind: 'merge', id: edit.id,
            source_id: edit.sourceId, target_id: edit.targetId,
        };
}

function absoluteApiUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const apiBase = getApiUrl();
    const origin = new URL(apiBase).origin;
    return new URL(path, `${origin}/`).toString();
}

async function apiError(response: Response, fallback: string): Promise<Error> {
    let detail: unknown = null;
    try {
        detail = (await response.json() as { detail?: unknown }).detail;
    } catch {
        detail = await response.text().catch(() => '');
    }
    return new Error(formatApiErrorDetail(detail, fallback));
}

async function fetchAsset(path: string, signal?: AbortSignal): Promise<Blob> {
    const response = await authenticatedFetch(absoluteApiUrl(path), { signal });
    if (!response.ok) throw await apiError(response, 'Không tải được mask tách tem.');
    return response.blob();
}

async function fetchRefinedAsset(path: string): Promise<Blob> {
    try {
        return await fetchAsset(path);
    } catch {
        // Backend đã tăng revision trước khi trả manifest. Với sidecar localhost,
        // thử lại một lần để lỗi đọc file thoáng qua không làm client kẹt revision cũ.
        return fetchAsset(path);
    }
}

function appendSource(form: FormData, file: File): void {
    const nativePath = (file as File & { path?: string }).path;
    if (nativePath) form.append('file_path', nativePath);
    else form.append('file', file, file.name);
}

export async function inspectStickerSource(
    file: File,
    signal?: AbortSignal,
): Promise<StickerSourceInspectPayload> {
    const form = new FormData();
    appendSource(form, file);
    const response = await authenticatedFetch(`${getApiUrl()}/sticker-sheet/inspect`, {
        method: 'POST',
        body: form,
        signal,
    });
    if (!response.ok) throw await apiError(response, 'Không chuẩn bị được file tem.');
    const inspection = await response.json() as StickerSourceInspection;
    try {
        return {
            inspection,
            previewBlob: await fetchAsset(inspection.preview_url, signal),
        };
    } catch (error) {
        void closeStickerSheetSession(inspection.session_id);
        throw error;
    }
}

export async function detectStickerSource(
    sessionId: string,
    options: {
        strategy?: StickerDetectionStrategy;
        model?: StickerSheetModel;
        alphaThreshold?: number;
        pageNumber?: number;
        signal?: AbortSignal;
    } = {},
): Promise<StickerSourceDetectionPayload> {
    const response = await authenticatedFetch(
        `${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}/detect`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                strategy: options.strategy || 'auto',
                model: options.model || 'birefnet-lite',
                alpha_threshold: options.alphaThreshold ?? 128,
                page_number: options.pageNumber ?? 1,
            }),
            signal: options.signal,
        },
    );
    if (!response.ok) throw await apiError(response, 'Không nhận diện được vùng tem.');
    const manifest = await response.json() as StickerSourceDetection;
    // UIUX (audit 2026-08-09 §MP.10): một trang lỗi tải asset không được đóng
    // session chứa các trang sibling. Retry detect sẽ chỉ phát lại URL đã promote.
    const [previewBlob, labelsBlob, uncertaintyBlob] = await Promise.all([
        fetchAsset(manifest.preview_url, options.signal),
        fetchAsset(manifest.labels_url, options.signal),
        fetchAsset(manifest.uncertainty_url, options.signal),
    ]);
    return { manifest, previewBlob, labelsBlob, uncertaintyBlob };
}

export async function refineStickerSource(
    sessionId: string,
    options: {
        alphaThreshold: number;
        shadowCleanup: StickerShadowCleanup;
        baseRevision: number;
        pageNumber?: number;
    },
): Promise<StickerSourceDetectionPayload> {
    const response = await authenticatedFetch(
        `${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}/refine`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                alpha_threshold: options.alphaThreshold,
                shadow_cleanup: options.shadowCleanup,
                base_revision: options.baseRevision,
                page_number: options.pageNumber ?? 1,
            }),
        },
    );
    if (!response.ok) throw await apiError(response, 'Không cập nhật được bản xem trước.');
    const manifest = await response.json() as StickerSourceDetection;
    try {
        const [previewBlob, labelsBlob, uncertaintyBlob] = await Promise.all([
            fetchRefinedAsset(manifest.preview_url),
            fetchRefinedAsset(manifest.labels_url),
            fetchRefinedAsset(manifest.uncertainty_url),
        ]);
        return { manifest, previewBlob, labelsBlob, uncertaintyBlob };
    } catch {
        // Backend đã commit revision. Báo lỗi có kiểu để store đóng session cũ và
        // quay về bước phân tích, thay vì tiếp tục gửi baseRevision đã lỗi thời.
        throw new StickerRefineAssetSyncError(manifest);
    }
}

export async function previewStickerCutline(
    sessionId: string,
    options: {
        baseRevision: number;
        pageNumber?: number;
        edits: StickerSheetExportEdit[];
        dpi: number;
        dpiY?: number;
        offsetMm: number;
        bleedMm: number;
        cutMode?: 'original' | 'alpha' | 'bleed' | 'none';
        cornerStyle?: 'preserve' | 'round' | 'miter';
        fillHoles?: boolean;
        cutlineSmoothness: number;
        cutlineFidelity: number;
        curveTension: number;
        minDetailAreaMm2: number;
        /** §CUTJAG.3 — thanh "Khử răng cưa" 0–100. */
        cutlineDenoise: number;
    },
): Promise<StickerCutlinePreview> {
    const response = await authenticatedFetch(
        `${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}/cutline-preview`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                base_revision: options.baseRevision,
                page_number: options.pageNumber ?? 1,
                edits: options.edits.map(serializeStickerSheetEdit),
                dpi: options.dpi,
                dpi_y: options.dpiY ?? options.dpi,
                offset_mm: options.offsetMm,
                bleed_mm: options.bleedMm,
                cut_mode: options.cutMode || 'original',
                corner_style: options.cornerStyle || 'preserve',
                fill_holes: options.fillHoles ?? true,
                cutline_smoothness: options.cutlineSmoothness,
                cutline_fidelity: options.cutlineFidelity,
                curve_tension: options.curveTension,
                min_detail_area_mm2: options.minDetailAreaMm2,
                cutline_denoise: options.cutlineDenoise,
            }),
        },
    );
    if (!response.ok) throw await apiError(response, 'Không cập nhật được đường bế xem trước.');
    return response.json() as Promise<StickerCutlinePreview>;
}

export async function confirmStickerSource(
    sessionId: string,
    signalOrOptions?: AbortSignal | { signal?: AbortSignal; pageNumber?: number },
): Promise<boolean> {
    const options = signalOrOptions && 'aborted' in signalOrOptions
        ? { signal: signalOrOptions, pageNumber: 1 }
        : (signalOrOptions || {});
    const response = await authenticatedFetch(
        `${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}/confirm`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page_number: options.pageNumber ?? 1 }),
            signal: options.signal,
        },
    );
    if (!response.ok) throw await apiError(response, 'Không xác nhận được vùng tem.');
    const payload = await response.json() as { stage?: string; mask_confirmed?: boolean };
    return payload.stage === 'mask-ready' && payload.mask_confirmed === true;
}

export async function closeStickerSheetSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await authenticatedFetch(`${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
    }).catch(() => undefined);
}

export async function exportStickerSheet(
    sessionId: string,
    options: {
        edits: StickerSheetExportEdit[];
        pages?: StickerSheetPageExport[];
        pageOrder?: number[];
        dpi: number;
        dpiY?: number;
        offsetMm: number;
        bleedMm: number;
        cutMode?: 'original' | 'alpha' | 'bleed' | 'none';
        cornerStyle?: 'preserve' | 'round' | 'miter';
        fillHoles?: boolean;
        cropToSticker?: boolean;
        bleedColorType?: 'image' | 'trajectory' | 'inpaint' | 'solid';
        solidBleedCmyk?: readonly [number, number, number, number];
        shapeMode?: 'contour' | 'auto_safe';
        drawCutContour?: boolean;
        preserveExistingCut?: boolean;
        outputFormat?: 'pdf' | 'png_zip';
        cutlineSmoothness?: number;
        cutlineFidelity?: number;
        curveTension?: number;
        minDetailAreaMm2?: number;
        signal?: AbortSignal;
    },
): Promise<StickerSheetExportPayload> {
    const edits = options.edits.map(serializeStickerSheetEdit);
    const pages = options.pages?.map(page => ({
        source_page: page.sourcePage,
        expected_revision: page.expectedRevision,
        edits: page.edits.map(serializeStickerSheetEdit),
        dpi: page.dpi,
        dpi_y: page.dpiY ?? page.dpi,
        cutline_smoothness: page.cutlineSmoothness ?? options.cutlineSmoothness ?? 50,
        cutline_fidelity: page.cutlineFidelity ?? options.cutlineFidelity ?? 50,
        curve_tension: page.curveTension ?? options.curveTension ?? 50,
        min_detail_area_mm2: page.minDetailAreaMm2 ?? options.minDetailAreaMm2 ?? 1,
    }));
    const response = await authenticatedFetch(
        `${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}/export`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                edits,
                pages,
                page_order: options.pageOrder,
                dpi: options.dpi,
                dpi_y: options.dpiY ?? options.dpi,
                cutline_smoothness: options.cutlineSmoothness ?? 50,
                cutline_fidelity: options.cutlineFidelity ?? 50,
                curve_tension: options.curveTension ?? 50,
                min_detail_area_mm2: options.minDetailAreaMm2 ?? 1,
                offset_mm: options.offsetMm,
                bleed_mm: options.bleedMm,
                cut_mode: options.cutMode || 'original',
                corner_style: options.cornerStyle || 'preserve',
                fill_holes: options.fillHoles ?? true,
                crop_to_sticker: options.cropToSticker ?? true,
                bleed_color_type: options.bleedColorType || 'image',
                solid_bleed_cmyk: options.solidBleedCmyk || [0, 0, 0, 0],
                shape_mode: options.shapeMode || 'contour',
                draw_cut_contour: options.drawCutContour ?? true,
                preserve_existing_cut: options.preserveExistingCut ?? true,
                output_format: options.outputFormat || 'pdf',
            }),
            signal: options.signal,
        },
    );
    if (!response.ok) throw await apiError(response, 'Không tạo được file tem.');
    const disposition = response.headers.get('Content-Disposition') || '';
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    const fallback = (options.outputFormat || 'pdf') === 'png_zip'
        ? 'tem_tach.png.zip'
        : 'tem_tach_cutcontour.pdf';
    return {
        blob: await response.blob(),
        filename: encodedName ? decodeURIComponent(encodedName) : (plainName || fallback),
        outputPath: response.headers.get('X-Sticker-Output-Path') || undefined,
        stickerCount: Number(response.headers.get('X-Sticker-Sheet-Count') || 0),
    };
}
