import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import {
    configureTileUrlCacheForHardware,
    type TileUrlSource,
} from '../../lib/tileUrlCache';
import { CancelledTileRenderError } from './tileRenderScheduler';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import {
    nativeRenderCoordinator,
    normalizeRenderRotation,
    renderDocumentIdentity,
    renderPipelineIdentity,
    renderPurpose,
    type RenderColorPipeline,
    type RenderCoordinatorRequestInput,
} from './renderCoordinator';
import type { ViewerEngineMode } from './usePdfLoader';
import {
    outputPreviewProofIdentity,
    type OutputPreviewRenderingIntent,
    type OutputPreviewRgb,
    type OutputPreviewShowFilter,
} from '../../stores/useWorkspaceStore';

interface UseTileRendererProps {
    file: any;
    pdfRef: any;
    pdfUrl: string | null;
    activePage: number;
    tabId?: string;
    isActive?: boolean;
    accurateColorEnabled?: boolean;
    accurateColorPages?: number[];
    accurateColorProfileId?: string;
    accurateColorIntent?: OutputPreviewRenderingIntent;
    outputPreviewFilter?: OutputPreviewShowFilter;
    simulatePaperColor?: boolean;
    simulateBlackInk?: boolean;
    pageBackgroundRgb?: OutputPreviewRgb | null;
    viewerEngineMode?: ViewerEngineMode;
    viewerShadowEnabled?: boolean;
    /** Identity do đúng loader/tab sở hữu; không đọc lại singleton theo path. */
    renderDocumentToken?: string | null;
}

interface TileRenderRequestOptions {
    ownerId?: string;
    groupKey?: string;
    priority?: number;
    colorStage?: ViewerColorStage;
    /** Output Preview buộc Simulation kể cả detector xem trang là RGB an toàn. */
    forceAccurateColor?: boolean;
    /** Một lần hiển thị; coarse/display/accurate dùng chung token này. */
    generationKey?: string;
}

let nextTileRendererId = 1;

export type ViewerColorStage = 'display' | 'accurate';

const DISPLAY_ONLY_STAGES: readonly ViewerColorStage[] = ['display'];
const ACCURATE_ONLY_STAGES: readonly ViewerColorStage[] = ['accurate'];
export const ACCURATE_VIEWER_DPI_BUCKET = 12;
const PPE_NATIVE_FALLBACK_BEFORE_START_PREFIX = 'PPE_NATIVE_FALLBACK_BEFORE_START:';
const PPE_NATIVE_UNSUPPORTED_PREFIX = 'PPE_NATIVE_UNSUPPORTED:';

export interface PpeUnsupportedStatus {
    reason: string;
    detail: string;
    fallbackFontSha256?: string | null;
}

function renderErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function canFallbackPpeToHttp(error: unknown): boolean {
    return renderErrorMessage(error)
        .trimStart()
        .startsWith(PPE_NATIVE_FALLBACK_BEFORE_START_PREFIX);
}

export function parsePpeUnsupportedStatus(error: unknown): PpeUnsupportedStatus | null {
    const message = renderErrorMessage(error).trimStart();
    if (!message.startsWith(PPE_NATIVE_UNSUPPORTED_PREFIX)) return null;
    try {
        const raw = JSON.parse(message.slice(PPE_NATIVE_UNSUPPORTED_PREFIX.length));
        if (!raw || typeof raw.reason !== 'string' || typeof raw.detail !== 'string') return null;
        return {
            reason: raw.reason,
            detail: raw.detail,
            fallbackFontSha256: typeof raw.fallbackFontSha256 === 'string'
                ? raw.fallbackFontSha256
                : null,
        };
    } catch {
        return null;
    }
}

export function shouldAutoDisableAccurateColor(
    error: unknown,
    viewerEngineMode: ViewerEngineMode,
): boolean {
    // UIUX/COLOR (feedback 2026-08-10 §SHEETEXPORT.3): font không nhúng chỉ làm
    // hình học chữ xấp xỉ. Ở mode hiện hành, cho Viewer trở về ảnh display có cảnh
    // báo thay vì khóa trắng cả trang; các lỗi màu/nội dung vẫn fail-closed.
    return viewerEngineMode === 'current'
        && parsePpeUnsupportedStatus(error)?.reason === 'geometry_approximation';
}

export function usesNativeAccurateWorker(
    profileId: string,
    intent: string,
    outputPreviewFilter: OutputPreviewShowFilter = 'all',
    simulatePaperColor = false,
    simulateBlackInk = false,
    pageBackgroundRgb: OutputPreviewRgb | null = null,
): boolean {
    return (profileId || 'fogra39').trim().toLowerCase() === 'fogra39'
        && (intent || 'relative').trim().toLowerCase() === 'relative'
        && outputPreviewFilter === 'all'
        && !simulatePaperColor
        && !simulateBlackInk
        && pageBackgroundRgb === null;
}

export function progressiveViewerColorStages(enabled: boolean): readonly ViewerColorStage[] {
    // COLOR (feedback 2026-08-09 §RENDER.F1): PDFium có thể dựng sai transparency/
    // DeviceCMYK rõ tới mức người dùng thấy một thiết kế khác trước khi PPE thay ảnh.
    // Trang đã được detector đánh dấu rủi ro chỉ được phát frame đúng màu.
    return enabled ? ACCURATE_ONLY_STAGES : DISPLAY_ONLY_STAGES;
}

export function shouldUseAccurateViewerRender(
    enabled: boolean,
    accuratePages: readonly number[],
    pageNum: number,
    _isTile: boolean,
    colorStage?: ViewerColorStage,
    viewerEngineMode: ViewerEngineMode = 'current',
): boolean {
    if (colorStage !== 'accurate') return false;
    if (viewerEngineMode !== 'current') return true;
    return enabled && accuratePages.includes(pageNum);
}

export function accurateViewerDpi(zoomScale: number): number {
    // PERF (audit 2026-08-07 §ZOOM.3): Ctrl+Wheel tạo scale thập phân gần nhau;
    // nếu dùng DPI chính xác từng đơn vị, mỗi lần chỉnh nhẹ lại thành một cache miss PPE.
    // Bo LÊN nấc 12 DPI để ảnh cuối chỉ downsample (không phóng mờ), đồng thời các mức
    // chuẩn 100/125/150/200% vẫn khớp đúng 96/120/144/192 DPI, không render dư.
    const requestedDpi = Number.isFinite(zoomScale) && zoomScale > 0
        ? 96 * zoomScale
        : 24;
    const bucketedDpi = Math.ceil(requestedDpi / ACCURATE_VIEWER_DPI_BUCKET)
        * ACCURATE_VIEWER_DPI_BUCKET;
    // Biên 9600 đồng bộ validation API và cao hơn miền renderZoom hợp lệ của Viewer.
    return Math.max(24, Math.min(9600, bucketedDpi));
}

export function accurateViewerRequestScale(zoomScale: number): number {
    // PERF (feedback 2026-08-09 §ZOOM.F2): scale request PPE phải neo theo DPI bucket,
    // không theo zoom thập phân. Nhờ đó hai nấc zoom gần nhau cùng DPI dùng
    // chung identity/cache, và bitmap đã nét không bị thay bằng nền mờ khi thu nhỏ.
    return accurateViewerDpi(zoomScale) / 96;
}

export function accurateViewerRasterDpr(zoom: number, displayDpr: number): number {
    if (!Number.isFinite(zoom) || zoom <= 0) return Math.max(1, displayDpr || 1);
    const renderScale = zoom * Math.max(1, displayDpr || 1);
    // PERF (audit 2026-08-08 §RENDER.3): Viewer quy 1 pt PDF thành 96/72 CSS px,
    // còn PPE quy thành DPI/72 raster px. Tỷ số đúng vì thế là DPI/(96×zoom),
    // không phải DPI/(72×zoom); công thức cũ render clip dư 33% và lệch mép trang.
    // Tỷ số này cho computeViewportTileSpec clip trực tiếp trong hệ PPE, tránh
    // làm tròn rồi đặt tile lệch dưới một pixel ở mép viewport.
    return accurateViewerDpi(renderScale) / (96 * zoom);
}

export function shouldCancelAccurateRenderForViewport(
    renderPage: number,
    interactive: boolean,
    viewportPage: number,
): boolean {
    // Viewport mới loại generation tương tác cũ và prefetch trang khác, nhưng giữ
    // nền accurate cùng trang để người dùng không rơi về skeleton trắng.
    return interactive || renderPage !== viewportPage;
}

export function isInteractiveViewportRender(isTile: boolean, priority: number): boolean {
    // PERF/UIUX (feedback 2026-08-11 §PAN.F2): tile runway priority >=100 chạy nền
    // và không được tự hủy target viewport priority 0 đang tạo frame nét đầu tiên.
    return isTile && priority < 100;
}

export function useTileRenderer({ file, pdfRef, pdfUrl, activePage, tabId, isActive, accurateColorEnabled = false, accurateColorPages = [], accurateColorProfileId = 'fogra39', accurateColorIntent = 'relative', outputPreviewFilter = 'all', simulatePaperColor = false, simulateBlackInk = false, pageBackgroundRgb = null, viewerEngineMode = 'current', viewerShadowEnabled = false, renderDocumentToken: loaderDocumentToken }: UseTileRendererProps) {
    const activePageRef = useRef(activePage);
    const accurateRenderAbortRef = useRef(new Map<
        string,
        { controller: AbortController; interactive: boolean; pageNum: number; ownerId: string }
    >());
    const accurateGenerationRef = useRef(0);
    const accurateBackendSessionOwnersRef = useRef(new Set<string>());
    useEffect(() => { activePageRef.current = activePage; }, [activePage]);

    const [rendererInstanceId] = useState(() => {
        // PERF (audit 2026-08-08 §RENDER.5): nonce phiên tránh HMR/WebView reload
        // tái dùng owner cũ trong khi tombstone generation vẫn còn ở sidecar.
        const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${nextTileRendererId++}`;
        return `viewer:${tabId || 'local'}:${nonce}`;
    });
    const nativePath = (file as { path?: string } | null)?.path;
    const nativeDocumentIdentity = useMemo(() => (
        nativePath ? renderDocumentIdentity(nativePath, file, loaderDocumentToken) : null
    ), [file, loaderDocumentToken, nativePath]);
    const documentToken = nativeDocumentIdentity?.token ?? 'memory';
    const fileIdentity = `${nativePath || pdfUrl || 'memory'}|${documentToken}`;
    const normalizedProfileId = (accurateColorProfileId || 'fogra39').trim().toLowerCase();
    const normalizedIntent = (accurateColorIntent || 'relative').trim().toLowerCase();
    const accurateProofIdentity = outputPreviewProofIdentity(
        outputPreviewFilter,
        simulatePaperColor,
        simulateBlackInk,
        pageBackgroundRgb,
    );
    const defaultProofIdentity = outputPreviewProofIdentity('all', false, false, null);
    const accuratePipelineIdentity = `${renderPipelineIdentity(
        'accurate',
        normalizedProfileId,
        normalizedIntent,
    )}${accurateProofIdentity === defaultProofIdentity ? '' : `|${accurateProofIdentity}`}`;
    const accurateRenderIdentity = `${fileIdentity}|simulation:${normalizedProfileId}:${normalizedIntent}|${accurateProofIdentity}`;
    const compatibilityPagesRef = useRef<{ fileIdentity: string; pages: Set<number> }>({
        fileIdentity,
        pages: new Set(),
    });
    if (compatibilityPagesRef.current.fileIdentity !== fileIdentity) {
        compatibilityPagesRef.current = { fileIdentity, pages: new Set() };
    }
    const shadowedPagesRef = useRef<{ fileIdentity: string; keys: Set<string> }>({
        fileIdentity,
        keys: new Set(),
    });
    if (shadowedPagesRef.current.fileIdentity !== fileIdentity) {
        shadowedPagesRef.current = { fileIdentity, keys: new Set() };
    }
    const [accurateColorFailure, setAccurateColorFailure] = useState<{ fileIdentity: string; message: string } | null>(null);
    const accurateColorError = accurateColorFailure?.fileIdentity === accurateRenderIdentity
        ? accurateColorFailure.message
        : null;
    // PERF (audit 2026-08-08 §RENDER.2): owner chỉ nhận diện tab/instance, không nhúng path.
    // Đổi file tạo epoch owner mới để cleanup file A không hủy nhầm request file B vừa mount.
    const renderDocumentOwnerRef = useRef({ fileIdentity: accurateRenderIdentity, epoch: 1 });
    if (renderDocumentOwnerRef.current.fileIdentity !== accurateRenderIdentity) {
        renderDocumentOwnerRef.current = {
            fileIdentity: accurateRenderIdentity,
            epoch: renderDocumentOwnerRef.current.epoch + 1,
        };
    }
    const renderOwnerId = `${rendererInstanceId}:document-${renderDocumentOwnerRef.current.epoch}`;
    const cancelAccurateGroup = useCallback((groupKey: string) => {
        const entry = accurateRenderAbortRef.current.get(groupKey);
        if (!entry) return;
        nativeRenderCoordinator.cancelGroup(entry.ownerId, groupKey);
        entry.controller.abort();
        accurateRenderAbortRef.current.delete(groupKey);
    }, []);
    const cancelAllAccurateRenders = useCallback(() => {
        for (const [groupKey, entry] of accurateRenderAbortRef.current.entries()) {
            nativeRenderCoordinator.cancelGroup(entry.ownerId, groupKey);
            entry.controller.abort();
        }
        accurateRenderAbortRef.current.clear();
    }, []);
    const releaseAccurateSession = useCallback((sessionOwnerId: string) => {
        // PERF (audit 2026-08-09 §L3C): worker giữ ref-count theo owner tab; nhả native
        // ở mọi cleanup. HTTP chỉ cần DELETE nếu request từng fallback trước-start.
        void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('release_ppe_session_owner', { sessionOwnerId }))
            .catch(() => undefined);
        const backendSessionUsed = accurateBackendSessionOwnersRef.current.delete(sessionOwnerId);
        if (!backendSessionUsed) return;
        const query = new URLSearchParams({
            owner_id: sessionOwnerId,
            generation: String(accurateGenerationRef.current),
        });
        // PERF (audit 2026-08-09 §L2C): request render bị abort chỉ nhả waiter;
        // tab/file thật sự đóng mới nhả persistent PPE session. Endpoint
        // idempotent nên cleanup React chạy lặp trong StrictMode vẫn an toàn.
        void Promise.resolve(authenticatedFetch(
            `${getApiUrl()}/preflight/viewer-accurate/session?${query.toString()}`,
            { method: 'DELETE', keepalive: true },
        )).catch(() => undefined);
    }, []);
    const cancelAccurateRendersForViewport = useCallback((viewportPage: number) => {
        for (const [groupKey, entry] of accurateRenderAbortRef.current.entries()) {
            if (!shouldCancelAccurateRenderForViewport(
                entry.pageNum,
                entry.interactive,
                viewportPage,
            )) continue;
            nativeRenderCoordinator.cancelGroup(entry.ownerId, groupKey);
            entry.controller.abort();
            accurateRenderAbortRef.current.delete(groupKey);
        }
    }, []);
    useEffect(() => () => {
        nativeRenderCoordinator.cancelOwner(renderOwnerId);
        cancelAllAccurateRenders();
        releaseAccurateSession(renderOwnerId);
    }, [cancelAllAccurateRenders, releaseAccurateSession, renderOwnerId]);
    useEffect(() => {
        if (isActive === false) {
            nativeRenderCoordinator.cancelOwner(renderOwnerId);
            cancelAllAccurateRenders();
        }
    }, [cancelAllAccurateRenders, isActive, renderOwnerId]);

    useEffect(() => {
        void configureTileUrlCacheForHardware();
    }, []);

    const getTileUrl = useCallback((pageNum: number, rotation: number, zoomScale: number, clipX?: number, clipY?: number, clipW?: number, clipH?: number, requestOptions?: TileRenderRequestOptions): Promise<TileUrlSource> => {
        const isImage = file?.type?.startsWith('image/') || file?.name?.match(/\.(jpg|jpeg|png|webp|gif)$/i);
        if (isImage) {
            return Promise.resolve({ url: pdfUrl ? pdfUrl + '#keep' : '', byteLength: 0 });
        }

        // Native file path. Ở RELEASE, protocol tile.localhost (img declarative / new Image /
        // fetch) ĐỀU không hiển thị được — chỉ cache cũ mới hiện. Cách đáng tin duy nhất:
        // lấy bytes PNG qua IPC `invoke('render_pdf_page')` (giống tách nền dùng invoke→blob,
        // đã chạy ở release) rồi tạo blob:. LiveTile tự cache + revoke blob.
        const nativeFilePath = (file as { path?: string } | null)?.path;
        if (nativeFilePath) {
            // Tile thật khi clipW/clipH > 0. Lúc đó clipX/clipY PHẢI truyền nguyên
            // giá trị (kể cả 0 — ô góc trên-trái) để backend nhận đủ 4 Some → vào
            // nhánh clip. Trước đây `clipX && clipX!==0 ? clipX : null` biến clipX=0
            // thành null → ô góc rơi nhầm vào nhánh render full-page.
            const isTile = !!(clipW && clipW > 0 && clipH && clipH > 0);
            const layer = isTile ? 'tile' : 'page';
            const ownerId = requestOptions?.ownerId || renderOwnerId;
            const groupKey = requestOptions?.groupKey || `${layer}:${pageNum}`;
            const priority = requestOptions?.priority ?? (isTile ? 0 : 100 + Math.abs(pageNum - (activePageRef.current || 1)));
            const requestsAccuratePipeline = requestOptions?.forceAccurateColor === true
                || shouldUseAccurateViewerRender(
                    accurateColorEnabled,
                    accurateColorPages,
                    pageNum,
                    isTile,
                    requestOptions?.colorStage,
                    viewerEngineMode,
                );
            const useAccuratePipeline = requestsAccuratePipeline
                && !(viewerEngineMode === 'hybrid'
                    && compatibilityPagesRef.current.pages.has(pageNum));
            const colorPipeline: RenderColorPipeline = useAccuratePipeline ? 'accurate' : 'display';
            const normalizedRotation = normalizeRenderRotation(rotation || 0);
            const clip = isTile
                ? { x: clipX ?? 0, y: clipY ?? 0, width: clipW!, height: clipH! }
                : null;
            const generationKey = requestOptions?.generationKey ?? JSON.stringify([
                pageNum,
                normalizedRotation,
                Number(zoomScale.toFixed(3)),
                clip,
                useAccuratePipeline ? normalizedProfileId : null,
                useAccuratePipeline ? normalizedIntent : null,
                useAccuratePipeline ? accurateProofIdentity : null,
            ]);
            const coordinatedRequest: RenderCoordinatorRequestInput = {
                ownerId,
                groupKey,
                generationKey,
                purpose: renderPurpose(priority, colorPipeline),
                priority,
                // PERF (audit 2026-08-08 §RENDER.5): request giữ identity của chính tab;
                // tab khác mở revision mới cùng path không được đổi token giữa chừng.
                document: nativeDocumentIdentity!,
                page: pageNum,
                rotation: normalizedRotation,
                raster: useAccuratePipeline
                    ? { kind: 'dpi', dpi: accurateViewerDpi(zoomScale), clip }
                    : { kind: 'scale', scale: zoomScale, clip },
                color: {
                    pipeline: colorPipeline,
                    profileId: useAccuratePipeline ? normalizedProfileId : null,
                    intent: useAccuratePipeline ? normalizedIntent : null,
                },
                pipelineIdentity: useAccuratePipeline
                    ? accuratePipelineIdentity
                    : renderPipelineIdentity('display'),
                // Hybrid chưa biết trước PPE hay compatibility sẽ thắng; giữ nhãn
                // bảo thủ cho tới khi protocol trả được metadata kèm bitmap.
                soundness: useAccuratePipeline && viewerEngineMode !== 'hybrid'
                    ? 'color-verified'
                    : 'display-preview',
            };
            const invokeDisplayPng = async (request: {
                requestId: string;
                ownerId: string;
                groupKey: string;
                generation: number;
                purpose: string;
                priority: number;
            }): Promise<ArrayBuffer> => {
                const { invoke } = await import('@tauri-apps/api/core');
                return invoke<ArrayBuffer>('render_pdf_page', {
                    filePath: nativeFilePath,
                    page: pageNum,
                    zoom: zoomScale,
                    rotation: normalizedRotation,
                    clipX: isTile ? (clipX ?? 0) : null,
                    clipY: isTile ? (clipY ?? 0) : null,
                    clipW: isTile ? clipW : null,
                    clipH: isTile ? clipH : null,
                    requestContext: {
                        requestId: request.requestId,
                        ownerId: request.ownerId,
                        groupKey: request.groupKey,
                        generation: request.generation,
                        purpose: request.purpose,
                        priority: request.priority,
                        pipelineIdentity: renderPipelineIdentity('display'),
                    },
                });
            };
            const renderNativePng = async (): Promise<TileUrlSource> => {
                return nativeRenderCoordinator.renderPng({
                    request: coordinatedRequest,
                    render: invokeDisplayPng,
                    // COLOR (audit 2026-08-07 §GV.1/§GV.4): raw PDFium không được nén
                    // mất dữ liệu lần hai; full-page và tile zoom dùng cùng MIME lossless.
                    encode: (bytes) => {
                        const blob = new Blob([bytes], { type: 'image/png' });
                        return { url: URL.createObjectURL(blob), byteLength: blob.size };
                    },
                });
            };
            const schedulePpeShadow = () => {
                if (
                    !viewerShadowEnabled
                    || viewerEngineMode !== 'current'
                    || isTile
                    || requestsAccuratePipeline
                ) return;
                const shadowKey = `${pageNum}:${normalizedRotation}`;
                if (shadowedPagesRef.current.keys.has(shadowKey)) return;
                shadowedPagesRef.current.keys.add(shadowKey);
                const requestId = typeof crypto !== 'undefined'
                    && typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `ppe-shadow-${Date.now().toString(36)}-${pageNum}`;
                window.setTimeout(() => {
                    void import('@tauri-apps/api/core')
                        .then(({ invoke }) => invoke('shadow_render_ppe_page', {
                            filePath: nativeFilePath,
                            page: pageNum,
                            dpi: 96,
                            rotation: normalizedRotation,
                            sessionOwnerId: renderOwnerId,
                            requestContext: {
                                requestId,
                                ownerId: `${renderOwnerId}:shadow`,
                                groupKey: `shadow:page:${pageNum}`,
                                generation: 1,
                                purpose: 'background',
                                priority: 500,
                                pipelineIdentity: renderPipelineIdentity('accurate'),
                            },
                        }))
                        .catch(() => undefined);
                }, 0);
            };

            if (useAccuratePipeline) {
                // COLOR (audit 2026-08-07 §GV.3): trang CMYK/DeviceN/transparency
                // được dựng trong không gian mực rồi mới quy profile mô phỏng→sRGB. Chỉ xin
                // PPE cho cả nền lẫn viewport; không phủ tile PDFium lên nền PPE.
                // PERF (audit 2026-08-08 §RENDER.3/5): viewport là đường cuối nên
                // hủy mọi accurate request cũ; full-page chỉ hủy đúng group của nó.
                const interactiveViewport = isInteractiveViewportRender(isTile, priority);
                if (interactiveViewport) cancelAccurateRendersForViewport(pageNum);
                else {
                    cancelAccurateGroup(groupKey);
                }
                const abortController = new AbortController();
                accurateRenderAbortRef.current.set(groupKey, {
                    controller: abortController,
                    interactive: interactiveViewport,
                    pageNum,
                    ownerId,
                });
                return nativeRenderCoordinator.renderPng({
                    request: coordinatedRequest,
                    bypassScheduler: true,
                    render: async request => {
                        try {
                            if (usesNativeAccurateWorker(
                                normalizedProfileId,
                                normalizedIntent,
                                outputPreviewFilter,
                                simulatePaperColor,
                                simulateBlackInk,
                                pageBackgroundRgb,
                            )) {
                                const { invoke } = await import('@tauri-apps/api/core');
                                try {
                                    // PERF/COLOR (audit 2026-08-09 §L3C): FOGRA39 +
                                    // Relative giữ đường IPC nhanh, không vòng HTTP/Python/PIL.
                                    const bytes = await invoke<ArrayBuffer>('render_ppe_page', {
                                        filePath: nativeFilePath,
                                        page: pageNum,
                                        dpi: accurateViewerDpi(zoomScale),
                                        rotation: normalizedRotation,
                                        clipX: request.raster.clip?.x ?? null,
                                        clipY: request.raster.clip?.y ?? null,
                                        clipW: request.raster.clip?.width ?? null,
                                        clipH: request.raster.clip?.height ?? null,
                                        sessionOwnerId: renderOwnerId,
                                        requestContext: {
                                            requestId: request.requestId,
                                            ownerId: request.ownerId,
                                            groupKey: request.groupKey,
                                            generation: request.generation,
                                            purpose: request.purpose,
                                            priority: request.priority,
                                            pipelineIdentity: request.pipelineIdentity,
                                        },
                                    });
                                    setAccurateColorFailure(null);
                                    return bytes;
                                } catch (nativeError) {
                                    const unsupported = parsePpeUnsupportedStatus(nativeError);
                                    if (unsupported) {
                                        if (viewerEngineMode !== 'hybrid') throw nativeError;
                                        // CORRECTNESS (audit 2026-08-10 §L7B): chỉ
                                        // capability thiếu mới được lùi PDFium. PPE chưa
                                        // trả byte nào nên một frame chỉ có đúng một engine.
                                        compatibilityPagesRef.current.pages.add(pageNum);
                                        setAccurateColorFailure(null);
                                        console.info('[VIEWER-ENGINE] PPE compatibility lane', {
                                            page: pageNum,
                                            reason: unsupported.reason,
                                        });
                                        return invokeDisplayPng(request);
                                    }
                                    if (!canFallbackPpeToHttp(nativeError)) throw nativeError;
                                }
                            }

                            // Profile/intent chưa được worker native đóng gói đi thẳng route
                            // động; FOGRA39 chỉ về đây khi worker lỗi trước byte đầu tiên.
                            accurateBackendSessionOwnersRef.current.add(renderOwnerId);
                            const accurateGeneration = ++accurateGenerationRef.current;
                            const response = await authenticatedFetch(`${getApiUrl()}/preflight/viewer-accurate`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    file_path: nativeFilePath,
                                    page: pageNum,
                                    dpi: accurateViewerDpi(zoomScale),
                                    profile_id: normalizedProfileId,
                                    intent: normalizedIntent,
                                    output_preview_filter: outputPreviewFilter,
                                    simulate_paper_color: simulatePaperColor,
                                    simulate_black_ink: simulateBlackInk,
                                    page_background_rgb: pageBackgroundRgb,
                                    // Request owner vẫn tách để latest-wins đúng từng
                                    // layer; session_owner_id bên dưới mới là scope dùng
                                    // chung document/profile/cache native.
                                    owner_id: request.ownerId,
                                    // Full-page có owner request riêng, nhưng toàn bộ tab/
                                    // revision chỉ sở hữu một PPE session/cache native.
                                    session_owner_id: renderOwnerId,
                                    request_id: request.requestId,
                                    generation: accurateGeneration,
                                    purpose: request.priority < 100 ? 'interactive' : 'background',
                                    clip_x: request.raster.clip?.x ?? null,
                                    clip_y: request.raster.clip?.y ?? null,
                                    clip_width: request.raster.clip?.width ?? null,
                                    clip_height: request.raster.clip?.height ?? null,
                                }),
                                signal: abortController.signal,
                            });
                            if (!response.ok) {
                                if (response.status === 409) throw new CancelledTileRenderError();
                                const detail = await response.json().catch(() => ({}));
                                throw new Error(detail.detail || `HTTP ${response.status}`);
                            }
                            const bytes = await response.arrayBuffer();
                            setAccurateColorFailure(null);
                            return bytes;
                        } catch (error) {
                            if (
                                abortController.signal.aborted
                                || error instanceof CancelledTileRenderError
                            ) {
                                throw new CancelledTileRenderError();
                            }
                            const message = renderErrorMessage(error);
                            setAccurateColorFailure({ fileIdentity: accurateRenderIdentity, message });
                            // COLOR (feedback 2026-08-09 §RENDER.F1): trang rủi ro phải
                            // fail-closed; không lấy PDFium sai màu làm ảnh dự phòng rồi lại
                            // tạo đúng hiện tượng đổi màu/gãy gradient mà người dùng báo.
                            console.warn('[VIEWER-COLOR] Accurate render failed; refusing display fallback:', message);
                            throw error instanceof Error ? error : new Error(message);
                        } finally {
                            if (
                                accurateRenderAbortRef.current.get(groupKey)?.controller
                                === abortController
                            ) {
                                accurateRenderAbortRef.current.delete(groupKey);
                            }
                        }
                    },
                    encode: (bytes) => {
                        const blob = new Blob([bytes], { type: 'image/png' });
                        return { url: URL.createObjectURL(blob), byteLength: blob.size };
                    },
                });
            }

            return renderNativePng().then(source => {
                schedulePpeShadow();
                return source;
            });
        }

        // Fallback: PDF.js canvas rendering for non-native files
        return new Promise<TileUrlSource>(async (resolve, reject) => {
            if (!pdfRef) return reject("No file and no PDF ref");
            try {
                const page = await pdfRef.getPage(pageNum);
                const viewport = page.getViewport({ scale: zoomScale, rotation });
                const canvas = document.createElement('canvas');

                const tileW = clipW || viewport.width;
                const tileH = clipH || viewport.height;
                canvas.width = tileW;
                canvas.height = tileH;

                const ctx = canvas.getContext('2d');
                if (!ctx) return reject("Failed to get 2d context");

                if (clipX !== undefined && clipY !== undefined) {
                    ctx.translate(-clipX, -clipY);
                }

                await page.render({ canvasContext: ctx, viewport }).promise;
                canvas.toBlob(blob => {
                    if (blob) resolve({ url: URL.createObjectURL(blob), byteLength: blob.size });
                    else reject("Failed to create blob");
                }, 'image/png');
            } catch (e) {
                reject(e);
            }
        });
    }, [activePageRef, accurateColorEnabled, accurateColorPages, accuratePipelineIdentity, accurateProofIdentity, accurateRenderIdentity, cancelAccurateGroup, cancelAccurateRendersForViewport, file, nativeDocumentIdentity, normalizedIntent, normalizedProfileId, outputPreviewFilter, pageBackgroundRgb, pdfRef, pdfUrl, renderOwnerId, simulateBlackInk, simulatePaperColor, viewerEngineMode, viewerShadowEnabled]);

    // Text extraction via pdfjs
    const getTextBlocksForPage = useCallback(async (pageNum: number, existingBlocks: Record<number, any[]>) => {
        if (existingBlocks[pageNum]) return null;
        if (!pdfRef) return null;
        try {
            const page = await pdfRef.getPage(pageNum);
            const content = await page.getTextContent();
            return content.items.map((item: any) => ({
                type: 'text',
                bbox: { x: item.transform[4], y: item.transform[5], w: item.width || 0, h: item.height || 0 },
                lines: [{
                    bbox: { x: item.transform[4], y: item.transform[5], w: item.width || 0, h: item.height || 0 },
                    wmode: 0,
                    dir: { x: 1, y: 0 },
                    chars: item.str ? item.str.split('').map((c: string, i: number) => ({
                        c, origin: { x: item.transform[4] + i * (item.width || 0) / Math.max(1, item.str.length), y: item.transform[5] }, quad: []
                    })) : []
                }]
            }));
        } catch { return null; }
    }, [pdfRef]);

    return {
        getTileUrl,
        getTextBlocksForPage,
        renderOwnerId,
        renderDocumentToken: documentToken,
        accurateColorError,
        cancelAccurateGroup,
    };
}
