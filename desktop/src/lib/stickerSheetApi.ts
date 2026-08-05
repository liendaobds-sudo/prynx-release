import { authenticatedFetch, formatApiErrorDetail, getApiUrl } from './api';


export type StickerSheetModel = 'birefnet-lite' | 'birefnet-full' | 'isnet';

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
    instances: StickerSheetInstance[];
    warnings: string[];
    preview_url: string;
    labels_url: string;
    uncertainty_url: string;
}

export interface StickerSheetAnalysisPayload {
    manifest: StickerSheetManifest;
    previewBlob: Blob;
    labelsBlob: Blob;
    uncertaintyBlob: Blob;
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

export async function analyzeStickerSheet(
    file: File,
    options: {
        model?: StickerSheetModel;
        alphaThreshold?: number;
        signal?: AbortSignal;
    } = {},
): Promise<StickerSheetAnalysisPayload> {
    const form = new FormData();
    const nativePath = (file as File & { path?: string }).path;
    if (nativePath) form.append('file_path', nativePath);
    else form.append('file', file, file.name);
    form.append('model', options.model || 'birefnet-lite');
    form.append('alpha_threshold', String(options.alphaThreshold ?? 128));

    const response = await authenticatedFetch(`${getApiUrl()}/sticker-sheet/analyze`, {
        method: 'POST',
        body: form,
        signal: options.signal,
    });
    if (!response.ok) throw await apiError(response, 'Không phân tích được ảnh nhiều tem.');
    const manifest = await response.json() as StickerSheetManifest;
    const [previewBlob, labelsBlob, uncertaintyBlob] = await Promise.all([
        fetchAsset(manifest.preview_url, options.signal),
        fetchAsset(manifest.labels_url, options.signal),
        fetchAsset(manifest.uncertainty_url, options.signal),
    ]);
    return { manifest, previewBlob, labelsBlob, uncertaintyBlob };
}

export async function warmupStickerSheet(
    model: StickerSheetModel = 'birefnet-lite',
    signal?: AbortSignal,
): Promise<boolean> {
    const form = new FormData();
    form.append('model', model);
    const response = await authenticatedFetch(`${getApiUrl()}/sticker-sheet/warmup`, {
        method: 'POST',
        body: form,
        signal,
    });
    if (!response.ok) return false;
    const payload = await response.json() as { ok?: boolean };
    return payload.ok === true;
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
        dpi: number;
        dpiY?: number;
        offsetMm: number;
        bleedMm: number;
        outputFormat?: 'pdf' | 'png_zip';
        signal?: AbortSignal;
    },
): Promise<StickerSheetExportPayload> {
    const edits = options.edits.map(edit => edit.kind === 'stroke'
        ? {
            kind: 'stroke', id: edit.id, tool: edit.tool,
            instance_id: edit.instanceId, radius: edit.radius, points: edit.points,
        }
        : {
            kind: 'merge', id: edit.id,
            source_id: edit.sourceId, target_id: edit.targetId,
        });
    const response = await authenticatedFetch(
        `${getApiUrl()}/sticker-sheet/${encodeURIComponent(sessionId)}/export`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                edits,
                dpi: options.dpi,
                dpi_y: options.dpiY ?? options.dpi,
                offset_mm: options.offsetMm,
                bleed_mm: options.bleedMm,
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
