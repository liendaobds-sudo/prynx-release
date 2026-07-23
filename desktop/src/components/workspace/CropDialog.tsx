import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { roundMm2, validateRectUnit } from '../preprocess-tools/setPageBoxesUtils';
import { useTranslation } from 'react-i18next';
import { fracToRectMm, rectMmToFrac, resizeCropFrac, type BoxMm, type Frac, type HorizontalCropAlign, type RectMm, type VerticalCropAlign } from '../../lib/cropDialogGeometry';

interface PageBoxesResponse {
    page: number;
    total_pages: number;
    mediabox: BoxMm;
    cropbox: BoxMm;
    trimbox: BoxMm;
    bleedbox: BoxMm;
    artbox: BoxMm;
}
interface CropOpenDetail {
    pageNum: number;
    ownerId?: string;
    /** Nhiều vùng: mỗi vùng tạo một trang kết quả. */
    fracs?: Frac[];
    /** Tương thích sự kiện crop cũ chỉ có một vùng. */
    frac?: Frac;
    pageBox?: BoxMm;
    totalPages?: number;
}

interface CropSelectionDetail {
    ownerId?: string;
    pageNum?: number;
    fracs?: Frac[];
    selectedIndex?: number;
}

interface DetectedRegion {
    rect_mm: RectMm & { width?: number; height?: number };
    safe_to_apply?: boolean;
    suggested_rect_mm?: RectMm | null;
    trim_mm?: {
        left: number;
        bottom: number;
        right: number;
        top: number;
    };
    changed: boolean;
    method: 'bleedbox' | 'object' | 'background' | 'pixels' | 'unchanged';
    confidence: 'high' | 'medium' | 'low';
}


interface ApiResult {
    detail?: string;
    success?: boolean;
    output_filename?: string;
    regions?: DetectedRegion[];
}

function isAbortError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'name' in error
        && error.name === 'AbortError';
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    return fallback;
}

const DEFAULT_MAX_TRIM_MM = 10;

export const CROP_PREFERENCES_STORAGE_KEY = 'prynx_crop_preferences_v1';

interface CropPreferences {
    applyScope: ApplyScope;
    outputMode: OutputMode;
    processEdges: boolean;
    maxTrimMm: number;
    horizontalAlignment: HorizontalCropAlign;
    verticalAlignment: VerticalCropAlign;
    openResultInNewTab: boolean;
}

const DEFAULT_CROP_PREFERENCES: CropPreferences = {
    applyScope: 'current',
    outputMode: 'keep_document',
    processEdges: false,
    maxTrimMm: DEFAULT_MAX_TRIM_MM,
    horizontalAlignment: 'center',
    verticalAlignment: 'center',
    openResultInNewTab: true,
};

function loadCropPreferences(): CropPreferences {
    if (typeof window === 'undefined') return DEFAULT_CROP_PREFERENCES;
    try {
        const saved = JSON.parse(window.localStorage.getItem(CROP_PREFERENCES_STORAGE_KEY) || '{}') as Partial<CropPreferences>;
        return {
            applyScope: saved.applyScope === 'range' || saved.applyScope === 'all' ? saved.applyScope : 'current',
            outputMode: saved.outputMode === 'regions_only' ? 'regions_only' : 'keep_document',
            processEdges: saved.processEdges === true,
            maxTrimMm: Number.isFinite(saved.maxTrimMm) ? Math.max(0.5, Math.min(10, Number(saved.maxTrimMm))) : DEFAULT_MAX_TRIM_MM,
            horizontalAlignment: saved.horizontalAlignment === 'left' || saved.horizontalAlignment === 'right' ? saved.horizontalAlignment : 'center',
            verticalAlignment: saved.verticalAlignment === 'top' || saved.verticalAlignment === 'bottom' ? saved.verticalAlignment : 'center',
            openResultInNewTab: saved.openResultInNewTab !== false,
        };
    } catch {
        return DEFAULT_CROP_PREFERENCES;
    }
}

type CropPhase = 'idle' | 'preparing' | 'applying' | 'committing';
type OutputMode = 'keep_document' | 'regions_only';

type ApplyScope = 'current' | 'range' | 'all';
interface RegionAlignment {
    horizontal: HorizontalCropAlign;
    vertical: VerticalCropAlign;
}

interface Props {
    ensureFileId: (signal?: AbortSignal) => Promise<string>;
    onApplied: (blob: Blob, filename: string, openInNewTab: boolean) => void | Promise<void>;
    onClose: () => void;
    embedded?: boolean;
}

export default function CropDialog({ ensureFileId, onApplied, onClose, embedded = false }: Props) {
    const { t } = useTranslation();
    const rememberedPreferencesRef = useRef<CropPreferences | null>(null);
    if (rememberedPreferencesRef.current === null) {
        rememberedPreferencesRef.current = loadCropPreferences();
    }
    const rememberedPreferences = rememberedPreferencesRef.current;
    const [open, setOpen] = useState(false);
    const [pageNum, setPageNum] = useState(1);
    const [ownerId, setOwnerId] = useState('');
    const [fileId, setFileId] = useState('');
    const [boxes, setBoxes] = useState<PageBoxesResponse | null>(null);
    const [boxesVerified, setBoxesVerified] = useState(false);
    const [fracs, setFracs] = useState<Frac[]>([]);
    const [sourceFracs, setSourceFracs] = useState<Frac[]>([]);
    const [regionAlignments, setRegionAlignments] = useState<RegionAlignment[]>([]);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [phase, setPhase] = useState<CropPhase>('idle');
    const [error, setError] = useState('');
    const [processEdges, setProcessEdges] = useState(rememberedPreferences.processEdges);
    const [detectingEdges, setDetectingEdges] = useState(false);
    const [detectedRegions, setDetectedRegions] = useState<DetectedRegion[] | null>(null);
    const [maxTrimMm, setMaxTrimMm] = useState(rememberedPreferences.maxTrimMm);
    const [detectError, setDetectError] = useState('');
    const [outputMode, setOutputMode] = useState<OutputMode>(rememberedPreferences.outputMode);

    const [applyScope, setApplyScope] = useState<ApplyScope>(rememberedPreferences.applyScope);
    const [rangeFrom, setRangeFrom] = useState(1);
    const [rangeTo, setRangeTo] = useState(1);
    const [horizontalAlignment, setHorizontalAlignment] = useState<HorizontalCropAlign>(rememberedPreferences.horizontalAlignment);
    const [verticalAlignment, setVerticalAlignment] = useState<VerticalCropAlign>(rememberedPreferences.verticalAlignment);
    const [openResultInNewTab, setOpenResultInNewTab] = useState(rememberedPreferences.openResultInNewTab);
    const dialogRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const loadAbortRef = useRef<AbortController | null>(null);
    const applyAbortRef = useRef<AbortController | null>(null);
    const openRequestIdRef = useRef(0);
    const committingRef = useRef(false);
    const fracsRef = useRef<Frac[]>([]);
    const selectedIdxRef = useRef(0);
    const suppressPreviewBroadcastRef = useRef(false);
    fracsRef.current = fracs;
    selectedIdxRef.current = selectedIdx;

    useEffect(() => {
        const preferences: CropPreferences = {
            applyScope,
            outputMode,
            processEdges,
            maxTrimMm,
            horizontalAlignment,
            verticalAlignment,
            openResultInNewTab,
        };
        rememberedPreferencesRef.current = preferences;
        if (typeof window === 'undefined') return;
        try {
            window.localStorage.setItem(CROP_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
        } catch { /* preferences remain best effort */ }
    }, [applyScope, outputMode, processEdges, maxTrimMm, horizontalAlignment, verticalAlignment, openResultInNewTab]);

    const handleApplyRef = useRef<() => void>(() => undefined);
    const abortPending = useCallback(() => {
        loadAbortRef.current?.abort();
        applyAbortRef.current?.abort();
        loadAbortRef.current = null;
        applyAbortRef.current = null;
    }, []);

    const resetDialog = useCallback(() => {
        abortPending();
        openRequestIdRef.current += 1;
        committingRef.current = false;
        suppressPreviewBroadcastRef.current = false;
        setOwnerId('');
        setOpen(false);
        setFileId('');
        setBoxes(null);
        setBoxesVerified(false);
        setFracs([]);
        setDetectedRegions(null);
        setSourceFracs([]);
        setRegionAlignments([]);
        setDetectError('');
        setRangeFrom(1);
        setRangeTo(1);
        setPhase('idle');
        const previous = previousFocusRef.current;
        previousFocusRef.current = null;
        queueMicrotask(() => previous?.focus?.());
    }, [abortPending]);

    const dismiss = useCallback(() => {
        if (committingRef.current) return;
        resetDialog();
        onClose();
    }, [onClose, resetDialog]);

    useEffect(() => {
        const onOpen = async (e: Event) => {
            const detail = (e as CustomEvent<CropOpenDetail>).detail;
            if (!detail) return;
            const list = detail.fracs?.length ? detail.fracs : (detail.frac ? [detail.frac] : []);
            if (list.length === 0) return;

            abortPending();
            const scannedFracs = list.map((frac) => ({ ...frac }));
            const requestId = ++openRequestIdRef.current;
            previousFocusRef.current = document.activeElement as HTMLElement | null;

            setError('');
            setDetectError('');
            setDetectedRegions(null);
            const totalPages = Math.max(1, detail.totalPages || 1);
            const reusablePreferences = rememberedPreferencesRef.current || DEFAULT_CROP_PREFERENCES;
            const reusableScope = detail.totalPages !== undefined && totalPages < 2 ? 'current' : reusablePreferences.applyScope;
            setApplyScope(reusableScope);
            setRangeFrom(detail.pageNum);
            setRangeTo(reusableScope === 'range' ? Math.min(totalPages, detail.pageNum + 1) : detail.pageNum);
            const initialPageBox = detail.pageBox || null;
            const initialBoxes: PageBoxesResponse | null = initialPageBox ? {
                page: detail.pageNum,
                total_pages: Math.max(1, detail.totalPages || 1),
                mediabox: initialPageBox,
                cropbox: initialPageBox,
                trimbox: initialPageBox,
                bleedbox: initialPageBox,
                artbox: initialPageBox,
            } : null;
            setPhase(initialBoxes ? 'idle' : 'preparing');
            setOpen(true);
            setBoxes(initialBoxes);
            setBoxesVerified(false);
            setFileId('');
            setPageNum(detail.pageNum);
            setOwnerId(detail.ownerId || '');
            setFracs(scannedFracs);
            setSourceFracs(scannedFracs.map((frac) => ({ ...frac })));
            setRegionAlignments(scannedFracs.map(() => ({ horizontal: reusablePreferences.horizontalAlignment, vertical: reusablePreferences.verticalAlignment })));
            setSelectedIdx(0);

            // The viewer usually supplies the visible page size, so the panel opens
            // immediately. File preparation remains asynchronous and only starts here
            // for legacy callers that do not provide that geometry.
            if (initialBoxes) return;
            const controller = new AbortController();
            loadAbortRef.current = controller;
            try {
                const fid = await ensureFileId(controller.signal);
                controller.signal.throwIfAborted();
                if (requestId !== openRequestIdRef.current) return;
                setFileId(fid);

                const boxRes = await authenticatedFetch(`${getApiUrl()}/preflight/page-boxes/${fid}/${detail.pageNum}`, {
                    signal: controller.signal,
                });
                const data = await boxRes.json() as PageBoxesResponse & ApiResult;
                if (!boxRes.ok || !data?.cropbox) {
                    throw new Error(data.detail || t('misc.cropDialog:khong_doc_duoc_kho_trang_http', { status: boxRes.status }));
                }
                controller.signal.throwIfAborted();
                if (requestId !== openRequestIdRef.current) return;
                setBoxes(data);
                setBoxesVerified(true);
            } catch (err: unknown) {
                if (!isAbortError(err) && requestId === openRequestIdRef.current) {
                    setError(t('misc.cropDialog:khong_doc_duoc_kho_trang', { msg: errorMessage(err, '') }));
                }
            } finally {
                if (loadAbortRef.current === controller) loadAbortRef.current = null;
                if (!controller.signal.aborted && requestId === openRequestIdRef.current) setPhase('idle');
            }
        };
        window.addEventListener('prynx-crop-open', onOpen as EventListener);
        return () => {
            window.removeEventListener('prynx-crop-open', onOpen as EventListener);
            abortPending();
        };
    }, [abortPending, ensureFileId, t]);

    useEffect(() => {
        if (!open) return;
        if (!embedded) dialogRef.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                dismiss();
                return;
            }
            if (event.key !== 'Enter') return;
            const target = event.target as HTMLElement | null;
            if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            handleApplyRef.current();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [dismiss, embedded, open]);

    // The page overlay can change the active region when the user clicks or
    // drags a different crop frame. Keep the compact settings panel focused on
    // that same region instead of leaving it stuck on region 1.
    useEffect(() => {
        if (!open) return;
        const onSelectionChange = (event: Event) => {
            const detail = (event as CustomEvent<CropSelectionDetail>).detail;
            if (!detail || detail.ownerId !== ownerId || detail.pageNum !== pageNum) return;
            if (Array.isArray(detail.fracs) && detail.fracs.length > 0) {
                const nextFracs = detail.fracs.map((frac) => ({ ...frac }));
                const sameFracs = fracsRef.current.length === nextFracs.length
                    && fracsRef.current.every((frac, index) => {
                        const next = nextFracs[index];
                        return frac.x0 === next.x0 && frac.y0 === next.y0
                            && frac.x1 === next.x1 && frac.y1 === next.y1;
                    });
                const nextSelectedIdx = Math.max(0, Math.min(
                    detail.fracs.length - 1,
                    Number.isInteger(detail.selectedIndex) ? Number(detail.selectedIndex) : 0,
                ));
                const geometryChanged = !sameFracs;
                const selectionChanged = nextSelectedIdx !== selectedIdxRef.current;
                if (!geometryChanged && !selectionChanged) return;

                // This event came from the canvas. Updating the panel must not
                // immediately echo the same geometry back to the canvas.
                suppressPreviewBroadcastRef.current = true;
                if (geometryChanged) {
                    setFracs(nextFracs);
                    setSourceFracs(nextFracs.map((frac) => ({ ...frac })));
                }
                if (selectionChanged) setSelectedIdx(nextSelectedIdx);
            }
        };
        window.addEventListener('prynx-crop-selection-change', onSelectionChange as EventListener);
        return () => window.removeEventListener('prynx-crop-selection-change', onSelectionChange as EventListener);
    }, [open, ownerId, pageNum]);

    // PDF.js displays CropBox. Using MediaBox here shifts and rescales selections on cropped PDFs.
    const pageBox = boxes?.cropbox || boxes?.mediabox || null;

    const rectsMm = useMemo(() => {
        if (!pageBox || fracs.length === 0) return [];
        return fracs.map((frac) => fracToRectMm(frac, pageBox));
    }, [pageBox, fracs]);

    // Keep the common path (draw -> size/alignment) local and instant. The
    // potentially expensive file upload starts only when edge processing is
    // explicitly revealed, or later when Apply is pressed.
    useEffect(() => {
        if (!open || !processEdges || boxesVerified || loadAbortRef.current) return;

        const controller = new AbortController();
        const requestId = openRequestIdRef.current;
        loadAbortRef.current = controller;
        setPhase('preparing');
        setDetectError('');

        void (async () => {
            try {
                const fid = fileId || await ensureFileId(controller.signal);
                controller.signal.throwIfAborted();
                const boxRes = await authenticatedFetch(`${getApiUrl()}/preflight/page-boxes/${fid}/${pageNum}`, {
                    signal: controller.signal,
                });
                const data = await boxRes.json() as PageBoxesResponse & ApiResult;
                if (!boxRes.ok || !data?.cropbox) {
                    throw new Error(data.detail || t('misc.cropDialog:khong_doc_duoc_kho_trang_http', { status: boxRes.status }));
                }
                controller.signal.throwIfAborted();
                if (requestId !== openRequestIdRef.current) return;
                setBoxes(data);
                setBoxesVerified(true);
                setFileId(fid);
            } catch (err: unknown) {
                if (!isAbortError(err) && requestId === openRequestIdRef.current) {
                    setDetectError(errorMessage(err, t('misc.cropDialog:edge_detection_failed')));
                }
            } finally {
                if (loadAbortRef.current === controller) loadAbortRef.current = null;
                if (requestId === openRequestIdRef.current) {
                    setPhase((current) => current === 'preparing' ? 'idle' : current);
                }
            }
        })();

        return () => {
            controller.abort();
            if (loadAbortRef.current === controller) loadAbortRef.current = null;
        };
    }, [open, processEdges, boxesVerified, fileId, ensureFileId, pageNum, t]);

    useEffect(() => {
        if (!processEdges || !fileId || !pageBox || rectsMm.length === 0) {
            setDetectedRegions(null);
            setDetectError('');
            setDetectingEdges(false);
            return;
        }

        const controller = new AbortController();
        setDetectingEdges(true);
        setDetectError('');
        setDetectedRegions(null);
        void (async () => {
            try {
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/detect-crop-regions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_id: fileId,
                        page: pageNum,
                        rects_mm: rectsMm,
                        max_trim_mm: maxTrimMm,
                    }),
                    signal: controller.signal,
                });
                const data = await res.json() as ApiResult;
                if (!res.ok || !Array.isArray(data?.regions) || data.regions.length !== rectsMm.length) {
                    throw new Error(data?.detail || t('misc.cropDialog:edge_detection_failed'));
                }
                setDetectedRegions(data.regions);
            } catch (err: unknown) {
                if (!isAbortError(err)) {
                    setDetectError(errorMessage(err, t('misc.cropDialog:edge_detection_failed')));
                }
            } finally {
                if (!controller.signal.aborted) setDetectingEdges(false);
            }
        })();
        return () => controller.abort();
    }, [processEdges, fileId, pageNum, pageBox, rectsMm, maxTrimMm, t]);

    const effectiveRects = useMemo(() => {
        if (!processEdges || !detectedRegions || detectedRegions.length !== rectsMm.length) return rectsMm;
        return detectedRegions.map((region, index) => region.safe_to_apply === false
            ? rectsMm[index]
            : region.rect_mm);
    }, [processEdges, detectedRegions, rectsMm]);

    const selectedFrac = fracs[selectedIdx] || null;

    const visualFracs = useMemo(() => {
        if (!pageBox || effectiveRects.length !== fracs.length) return fracs;
        return effectiveRects.map((rect) => rectMmToFrac(rect, pageBox));
    }, [effectiveRects, fracs, pageBox]);

    useEffect(() => {
        if (!open || visualFracs.length === 0) return;
        if (suppressPreviewBroadcastRef.current) {
            suppressPreviewBroadcastRef.current = false;
            return;
        }
        window.dispatchEvent(new CustomEvent('prynx-crop-preview-change', {
            detail: {
                ownerId, pageNum,
                fracs: visualFracs.map((frac) => ({ ...frac })),
                selectedIndex: selectedIdx,
            },
        }));
    }, [open, ownerId, pageNum, selectedIdx, visualFracs]);
    const selectedSourceFrac = sourceFracs[selectedIdx] || selectedFrac;
    const selectedRect = effectiveRects[selectedIdx] || null;
    const selectedAlignment = regionAlignments[selectedIdx] || { horizontal: horizontalAlignment, vertical: verticalAlignment };
    const exactSizeValues = selectedRect ? {
        width: roundMm2(selectedRect.x1 - selectedRect.x0),
        height: roundMm2(selectedRect.y1 - selectedRect.y0),
    } : null;
    // Edge processing is a safe enhancement. If detection fails, keep the
    // user's original rectangles instead of blocking the crop operation.
    const detectionReady = !processEdges || !detectingEdges;

    const targetPages = useMemo(() => {
        if (!boxes || applyScope === 'current') return [pageNum];
        if (applyScope === 'all') return Array.from({ length: boxes.total_pages }, (_, index) => index + 1);
        const from = Math.max(1, Math.min(boxes.total_pages, Math.min(rangeFrom, rangeTo)));
        const to = Math.max(1, Math.min(boxes.total_pages, Math.max(rangeFrom, rangeTo)));
        return Array.from({ length: to - from + 1 }, (_, index) => from + index);
    }, [applyScope, boxes, pageNum, rangeFrom, rangeTo]);
    const scopePageCount = targetPages.length;
    const outputRegionCount = fracs.length * scopePageCount;
    const resultPageCount = boxes
        ? (outputMode === 'keep_document' ? boxes.total_pages - scopePageCount + outputRegionCount : outputRegionCount)
        : outputRegionCount;

    const applyExactSize = (widthMm: number, heightMm: number, alignment: RegionAlignment) => {
        if (!pageBox || !selectedSourceFrac || phase !== 'idle') return;
        setProcessEdges(false);
        setDetectError('');
        setFracs((prev) => prev.map((frac, index) => index === selectedIdx
            ? resizeCropFrac(selectedSourceFrac, pageBox, widthMm, heightMm, alignment.horizontal, alignment.vertical)
            : frac));
    };

    const updateSelectedSize = (axis: 'width' | 'height', rawValue: string) => {
        if (!exactSizeValues) return;
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed) || parsed <= 0) return;
        applyExactSize(
            axis === 'width' ? parsed : exactSizeValues.width,
            axis === 'height' ? parsed : exactSizeValues.height,
            selectedAlignment,
        );
    };

    const updateSelectedAlignment = (alignment: RegionAlignment) => {
        if (!exactSizeValues || phase !== 'idle') return;
        setRegionAlignments((prev) => prev.map((current, index) => index === selectedIdx ? alignment : current));
        setHorizontalAlignment(alignment.horizontal);
        setVerticalAlignment(alignment.vertical);
        applyExactSize(exactSizeValues.width, exactSizeValues.height, alignment);
    };

    const handleApply = async () => {
        if (!boxes || effectiveRects.length === 0 || !detectionReady || phase !== 'idle') return;

        const controller = new AbortController();
        applyAbortRef.current?.abort();
        applyAbortRef.current = controller;
        setPhase('applying');
        setError('');
        try {
            const currentFileId = fileId || await ensureFileId(controller.signal);
            controller.signal.throwIfAborted();
            setFileId(currentFileId);

            let verifiedBoxes = boxes;
            if (!boxesVerified) {
                const boxRes = await authenticatedFetch(`${getApiUrl()}/preflight/page-boxes/${currentFileId}/${pageNum}`, {
                    signal: controller.signal,
                });
                const boxData = await boxRes.json() as PageBoxesResponse & ApiResult;
                if (!boxRes.ok || !boxData?.cropbox) {
                    throw new Error(boxData.detail || t('misc.cropDialog:khong_doc_duoc_kho_trang_http', { status: boxRes.status }));
                }
                controller.signal.throwIfAborted();
                verifiedBoxes = boxData;
                setBoxes(boxData);
                setBoxesVerified(true);
            }

            const verifiedPageBox = verifiedBoxes.cropbox || verifiedBoxes.mediabox;
            const rectsToApply = visualFracs.map((frac) => fracToRectMm(frac, verifiedPageBox));
            for (let i = 0; i < rectsToApply.length; i++) {
                const valErr = validateRectUnit(rectsToApply[i]);
                if (valErr) {
                    throw new Error(t('misc.cropDialog:vung_cat_khong_hop_le', { err: `#${i + 1}: ${valErr}` }));
                }
            }

            const res = await authenticatedFetch(`${getApiUrl()}/preflight/crop-regions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: currentFileId,
                    page: pageNum,
                    rects_mm: rectsToApply,
                    keep_other_pages: outputMode === 'keep_document',
                    pages: targetPages,
                }),
                signal: controller.signal,
            });
            const data = await res.json() as ApiResult;
            if (!res.ok || !data.success || !data.output_filename) {
                throw new Error(data.detail || t('misc.cropDialog:cat_kho_that_bai'));
            }
            const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`, {
                signal: controller.signal,
            });
            if (!dl.ok) throw new Error(t('misc.cropDialog:cat_kho_that_bai'));
            const blob = await dl.blob();
            controller.signal.throwIfAborted();

            // Từ đây là commit cục bộ ngắn và không thể rollback giữa chừng: khóa đóng dialog.
            committingRef.current = true;
            setPhase('committing');
            await onApplied(blob, data.output_filename, openResultInNewTab);
            applyAbortRef.current = null;
            resetDialog();
            if (!embedded) onClose();
        } catch (err: unknown) {
            committingRef.current = false;
            if (!isAbortError(err)) {
                setError(errorMessage(err, t('misc.cropDialog:cat_kho_that_bai')));
            }
        } finally {
            if (applyAbortRef.current === controller) applyAbortRef.current = null;
            if (!committingRef.current && !controller.signal.aborted) setPhase('idle');
        }
    };
    handleApplyRef.current = () => { void handleApply(); };

    const removeRegion = (idx: number) => {
        setFracs((prev) => {
            const next = prev.filter((_, i) => i !== idx);
            if (next.length === 0) queueMicrotask(dismiss);
            return next;
        });
        setSourceFracs((prev) => prev.filter((_, i) => i !== idx));
        setRegionAlignments((prev) => prev.filter((_, i) => i !== idx));
        setSelectedIdx((selected) => Math.max(0, Math.min(selected, fracs.length - 2)));
    };

    if (!open && !embedded) return null;
    if (!open && embedded) {
        return (
            <div className="w-full rounded-lg border border-dashed border-orange-300 bg-orange-50/60 p-4 text-slate-700 dark:border-orange-700/60 dark:bg-orange-950/20 dark:text-zinc-200">
                <div className="text-sm font-bold">{t('misc.cropDialog:exact_size')}</div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-zinc-400">{t('misc.cropDialog:crop_mode_hint')}</p>
            </div>
        );
    }

    const multi = fracs.length > 1;
    const isCommitting = phase === 'committing';
    const runDisabled = phase !== 'idle' || !boxes || effectiveRects.length === 0 || !detectionReady;
    const phaseLabel = phase === 'preparing'
        ? t('misc.cropDialog:preparing_file')
        : phase === 'applying'
            ? t('misc.cropDialog:creating_pages')
            : phase === 'committing'
                ? t('misc.cropDialog:updating_document')
                : '';

    return (
        <div className={embedded ? 'w-full' : 'pointer-events-none fixed bottom-4 right-4 top-20 z-modal flex max-w-[calc(100vw-2rem)] items-start'}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="false"
                aria-labelledby={embedded ? undefined : 'crop-dialog-title'}
                aria-label={embedded ? t('misc.cropDialog:exact_size') : undefined}
                aria-describedby="crop-dialog-help"
                aria-busy={phase !== 'idle'}
                tabIndex={-1}
                className={`pointer-events-auto text-slate-800 dark:text-zinc-200 flex flex-col outline-none ${embedded ? 'w-full bg-transparent overflow-visible' : 'bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-[360px] max-w-full max-h-full border border-black/10 dark:border-white/10 overflow-hidden'}`}
            >
                {!embedded && <div className="flex items-center justify-between px-5 py-3 border-b border-black/10 dark:border-white/10 shrink-0">
                    <h2 id="crop-dialog-title" className="text-[15px] font-bold">
                        {t('misc.cropDialog:exact_size')}
                        {multi && (
                            <span className="ml-2 text-[12px] font-semibold text-orange-600 dark:text-orange-400">
                                {t('misc.cropDialog:multi_summary', { count: fracs.length })}
                            </span>
                        )}
                    </h2>
                    <button
                        type="button"
                        onClick={dismiss}
                        disabled={isCommitting}
                        className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                        title={t('misc.cropDialog:dong')}
                        aria-label={t('misc.cropDialog:dong')}
                    >
                        <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l12 12M1 13L13 1" strokeLinecap="round" /></svg>
                    </button>
                </div>}

                <div className={embedded ? 'grid grid-cols-1 gap-3 pt-2' : 'p-3 sm:p-4 grid grid-cols-1 gap-3 overflow-y-auto'}>
                    <div className="space-y-2">
                        {multi && (
                            <div className="rounded-lg border border-black/10 p-2 dark:border-white/10">
                                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                                    {t('misc.cropDialog:scanned_regions', { page: pageNum })}
                                </div>
                                <div role="tablist" aria-label={t('misc.cropDialog:scanned_regions', { page: pageNum })} className="flex flex-wrap gap-1.5">
                                    {fracs.map((_, i) => {
                                        const active = i === selectedIdx;
                                        return (
                                            <button
                                                key={`region-tab-${i}`}
                                                type="button"
                                                role="tab"
                                                aria-selected={active}
                                                aria-label={t('misc.cropDialog:region', { index: i + 1 })}
                                                onClick={() => setSelectedIdx(i)}
                                                disabled={phase !== 'idle'}
                                                className={`min-w-8 rounded-md border px-2 py-1 text-[11px] font-bold tabular-nums transition-colors ${
                                                    active
                                                        ? 'border-orange-500 bg-orange-500 text-white'
                                                        : 'border-black/10 bg-white text-slate-600 hover:bg-orange-50 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-orange-950/30'
                                                }`}
                                            >
                                                {i + 1}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        <>
                        <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                            {t('misc.cropDialog:scanned_regions', { page: pageNum })}
                        </div>
                        {fracs.map((_, i) => {
                            const rect = effectiveRects[i];
                            const width = rect ? roundMm2(rect.x1 - rect.x0) : 0;
                            const height = rect ? roundMm2(rect.y1 - rect.y0) : 0;
                            const active = i === selectedIdx;
                            const detected = processEdges ? detectedRegions?.[i] : null;
                            return (
                                <div key={i} className={`flex items-stretch rounded-lg border transition-colors ${
                                    active
                                        ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30'
                                        : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                                }`}>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedIdx(i)}
                                        aria-pressed={active}
                                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left rounded-l-lg"
                                    >
                                        <span className="w-6 h-6 shrink-0 flex items-center justify-center rounded bg-orange-500 text-white text-[11px] font-bold">{i + 1}</span>
                                        <span className="flex-1 min-w-0 text-[12px]">
                                            <span className="block font-semibold">{t('misc.cropDialog:region', { index: i + 1 })}</span>
                                            <span className="block text-slate-500 tabular-nums">{width} × {height} mm</span>
                                            {detected?.changed && (
                                                <span className="block mt-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                                    {detected.method === 'bleedbox' ? t('misc.cropDialog:bleedbox_preserved') : t('misc.cropDialog:edges_processed')}
                                                    {detected.trim_mm && <span className="block font-normal tabular-nums">{t('misc.cropDialog:trim_summary', {
                                                        left: detected.trim_mm.left, top: detected.trim_mm.top,
                                                        right: detected.trim_mm.right, bottom: detected.trim_mm.bottom,
                                                    })}</span>}
                                                </span>
                                            )}
                                            {detected?.method === 'pixels' && !detected.changed && <span className="block mt-0.5 text-[10px] leading-tight text-amber-600 dark:text-amber-400">{t('misc.cropDialog:pixel_edge_preserved')}</span>}
                                            {detected && detected.method !== 'pixels' && !detected.changed && <span className="block mt-0.5 text-[10px] leading-tight text-amber-600 dark:text-amber-400">{t('misc.cropDialog:edge_unchanged')}</span>}
                                        </span>
                                    </button>
                                    {fracs.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => removeRegion(i)}
                                            className="w-10 shrink-0 rounded-r-lg border-l border-black/10 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                                            title={t('misc.cropDialog:remove_region')}
                                            aria-label={`${t('misc.cropDialog:remove_region')} ${i + 1}`}
                                        >×</button>
                                    )}
                                </div>
                            );
                        })}
                        </>
                        {phase === 'preparing' && (
                            <div className="flex items-center justify-center gap-2 rounded-lg border border-black/10 px-3 py-5 text-[11px] font-semibold text-slate-500 dark:border-white/10">
                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-orange-600" /> {t('misc.cropDialog:preparing_file')}
                            </div>
                        )}
                        {exactSizeValues && (
                            <fieldset className="mt-2 rounded-lg border border-black/10 dark:border-white/10 p-2.5">
                                <legend className="px-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t('misc.cropDialog:exact_size')}</legend>
                                <div className="grid grid-cols-2 gap-2">
                                    {([['width', 'misc.cropDialog:width'], ['height', 'misc.cropDialog:height']] as const).map(([axis, label]) => (
                                        <label key={axis} className="text-[10px] text-slate-500">
                                            <span className="block mb-0.5">{t(label)}</span>
                                            <span className="flex items-center gap-1">
                                                <input
                                                    key={`${selectedIdx}-${axis}-${exactSizeValues[axis]}`}
                                                    type="number"
                                                    min="0.1"
                                                    step="0.1"
                                                    defaultValue={exactSizeValues[axis]}
                                                    onBlur={(event) => updateSelectedSize(axis, event.target.value)}
                                                    onKeyDown={(event) => {
                                                        event.stopPropagation();
                                                        if (event.key === 'Enter') event.currentTarget.blur();
                                                    }}
                                                    disabled={phase !== 'idle' || !boxes}
                                                    className="w-full h-8 rounded border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 px-2 text-[11px] tabular-nums disabled:opacity-50"
                                                />
                                                <span>mm</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <div className="mb-1 text-[10px] font-semibold text-slate-500">{t('misc.cropDialog:horizontal_alignment')}</div>
                                        <div className="grid grid-cols-3 overflow-hidden rounded border border-black/10 dark:border-white/10">
                                            {([['left', 'misc.cropDialog:align_left'], ['center', 'misc.cropDialog:align_center'], ['right', 'misc.cropDialog:align_right']] as const).map(([value, label]) => (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    aria-pressed={selectedAlignment.horizontal === value}
                                                    onClick={() => updateSelectedAlignment({ ...selectedAlignment, horizontal: value })}
                                                    disabled={phase !== 'idle' || !boxes}
                                                    className={`h-8 border-r border-black/10 text-[10px] last:border-r-0 dark:border-white/10 ${selectedAlignment.horizontal === value ? 'bg-orange-500 font-bold text-white' : 'bg-white hover:bg-black/5 dark:bg-zinc-900 dark:hover:bg-white/5'}`}
                                                >{t(label)}</button>
                                            ))}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="mb-1 text-[10px] font-semibold text-slate-500">{t('misc.cropDialog:vertical_alignment')}</div>
                                        <div className="grid grid-cols-3 overflow-hidden rounded border border-black/10 dark:border-white/10">
                                            {([['top', 'misc.cropDialog:align_top'], ['center', 'misc.cropDialog:align_middle'], ['bottom', 'misc.cropDialog:align_bottom']] as const).map(([value, label]) => (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    aria-pressed={selectedAlignment.vertical === value}
                                                    onClick={() => updateSelectedAlignment({ ...selectedAlignment, vertical: value })}
                                                    disabled={phase !== 'idle' || !boxes}
                                                    className={`h-8 border-r border-black/10 text-[10px] last:border-r-0 dark:border-white/10 ${selectedAlignment.vertical === value ? 'bg-orange-500 font-bold text-white' : 'bg-white hover:bg-black/5 dark:bg-zinc-900 dark:hover:bg-white/5'}`}
                                                >{t(label)}</button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">{t('misc.cropDialog:exact_size_hint')}</p>
                            </fieldset>
                        )}
                        <p id="crop-dialog-help" className="text-[11px] text-slate-500 leading-relaxed pt-1">
                            {t('misc.cropDialog:region_hint')}
                        </p>
                    </div>

                    <>
                    <fieldset className="rounded-lg border border-black/10 dark:border-white/10 p-3">
                        <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">{t('misc.cropDialog:pham_vi_trang')}</legend>
                        <select
                            aria-label={t('misc.cropDialog:pham_vi_trang')}
                            value={applyScope}
                            onChange={(event) => {
                                const nextScope = event.target.value as ApplyScope;
                                setApplyScope(nextScope);
                                if (nextScope === 'range' && boxes && boxes.total_pages > 1 && rangeFrom === rangeTo) {
                                    if (rangeTo < boxes.total_pages) setRangeTo(rangeTo + 1);
                                    else setRangeFrom(Math.max(1, rangeFrom - 1));
                                }
                            }}
                            disabled={phase !== 'idle'}
                            className="h-9 w-full rounded-md border border-black/15 bg-white px-2.5 text-[12px] font-semibold text-slate-700 outline-none focus:border-orange-500 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200"
                        >
                            <option value="current">{t('misc.cropDialog:trang_nay')}</option>
                            <option value="range" disabled={!boxes || boxes.total_pages < 2}>{t('misc.cropDialog:nhieu_trang')}</option>
                            <option value="all" disabled={!boxes || boxes.total_pages < 2}>{t('misc.cropDialog:tat_ca')}</option>
                        </select>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                            {applyScope === 'current'
                                ? t('misc.cropDialog:scope_current_desc', { page: pageNum })
                                : applyScope === 'range'
                                    ? t('misc.cropDialog:scope_range_desc')
                                    : t('misc.cropDialog:scope_all_desc', { total: boxes?.total_pages || 0 })}
                        </p>
                        {applyScope === 'range' && boxes && (
                            <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-slate-50 px-2.5 py-2 dark:bg-zinc-900/60">
                                <label className="text-[10px] text-slate-500"><span className="mb-0.5 block">{t('misc.cropDialog:tu')}</span><input type="number" min="1" max={boxes.total_pages} value={rangeFrom} onChange={(event) => setRangeFrom(Math.max(1, Math.min(boxes.total_pages, Number(event.target.value) || 1)))} className="h-8 w-20 rounded border border-black/15 bg-white px-2 tabular-nums dark:border-white/15 dark:bg-zinc-900" /></label>
                                <label className="text-[10px] text-slate-500"><span className="mb-0.5 block">{t('misc.cropDialog:den')}</span><input type="number" min="1" max={boxes.total_pages} value={rangeTo} onChange={(event) => setRangeTo(Math.max(1, Math.min(boxes.total_pages, Number(event.target.value) || 1)))} className="h-8 w-20 rounded border border-black/15 bg-white px-2 tabular-nums dark:border-white/15 dark:bg-zinc-900" /></label>
                                <span className="pb-2 text-[10px] font-semibold text-slate-600 dark:text-zinc-300">{t('misc.cropDialog:scope_range_summary', { count: scopePageCount })}</span>
                            </div>
                        )}
                        {applyScope !== 'current' && scopePageCount > 1 && (
                            <p className="mt-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">{t('misc.cropDialog:scope_all_hint')}</p>
                        )}
                    </fieldset>

                    <fieldset className="rounded-lg border border-black/10 dark:border-white/10 p-3">
                        <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">{t('misc.cropDialog:output_mode')}</legend>
                        <select
                            aria-label={t('misc.cropDialog:output_mode')}
                            value={outputMode}
                            onChange={(event) => setOutputMode(event.target.value as OutputMode)}
                            disabled={phase !== 'idle'}
                            className="h-9 w-full rounded-md border border-black/15 bg-white px-2.5 text-[12px] font-semibold text-slate-700 outline-none focus:border-orange-500 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200"
                        >
                            <option value="keep_document">{t('misc.cropDialog:keep_document')}</option>
                            <option value="regions_only">{t('misc.cropDialog:regions_only')}</option>
                        </select>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                            {outputMode === 'keep_document'
                                ? (applyScope !== 'current' ? t('misc.cropDialog:keep_document_all_desc', { total: scopePageCount, count: fracs.length }) : t('misc.cropDialog:keep_document_desc', { page: pageNum, count: fracs.length }))
                                : t('misc.cropDialog:regions_only_desc', { count: outputRegionCount })}
                        </p>
                        <p className={`mt-2 text-[11px] font-semibold ${outputMode === 'regions_only' && (boxes?.total_pages || 0) > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'}`}>
                            {outputMode === 'regions_only' && (boxes?.total_pages || 0) > 1
                                ? t('misc.cropDialog:regions_only_warning', { total: boxes?.total_pages })
                                : t('misc.cropDialog:result_summary', { count: resultPageCount })}
                        </p>
                    </fieldset>

                    <div className="rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                        <label className="flex cursor-pointer items-start gap-3">
                            <input type="checkbox" checked={openResultInNewTab} onChange={(event) => setOpenResultInNewTab(event.target.checked)} disabled={phase !== 'idle'} className="mt-0.5 h-4 w-4 accent-orange-600" />
                            <span className="min-w-0">
                                <span className="block text-[12px] font-bold">{t('misc.cropDialog:open_result_new_tab')}</span>
                                <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400">{t('misc.cropDialog:open_result_new_tab_desc')}</span>
                            </span>
                        </label>
                    </div>

                    <div className={`rounded-lg border px-3 py-2.5 transition-colors ${processEdges ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/25' : 'border-black/10 dark:border-white/10'}`}>
                        <label className="flex items-start gap-3 cursor-pointer">
                            <input type="checkbox" checked={processEdges} onChange={(e) => setProcessEdges(e.target.checked)} disabled={phase !== 'idle' || !boxes} className="mt-0.5 w-4 h-4 accent-emerald-600" />
                            <span className="min-w-0">
                                <span className="block text-[12px] font-bold">{t('misc.cropDialog:process_excess_edges')}</span>
                                <span className="block mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400">{t('misc.cropDialog:process_excess_edges_desc')}</span>
                                {detectingEdges && <span className="block mt-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{t('misc.cropDialog:detecting_edges')}</span>}
                            </span>
                        </label>
                        {processEdges && (
                            <label className="mt-2 ml-7 flex items-center gap-2 text-[10px] text-slate-600 dark:text-zinc-300">
                                <span>{t('misc.cropDialog:max_excess')}</span>
                                <input type="number" min="0.5" max="10" step="0.5" value={maxTrimMm} onChange={(event) => setMaxTrimMm(Math.max(0.5, Math.min(10, Number(event.target.value) || 0.5)))} disabled={phase !== 'idle'} className="h-7 w-16 rounded border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 px-2 tabular-nums" />
                                <span>mm</span>
                            </label>
                        )}
                    </div>
                    </>
                </div>

                <div aria-live="polite" className="shrink-0">
                    {phase !== 'idle' && phase !== 'preparing' && <div className="px-5 pb-2 flex items-center gap-2 text-[12px] font-semibold text-orange-700 dark:text-orange-300"><span className="h-4 w-4 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" />{phaseLabel}</div>}
                    {detectError && <div className="px-5 pb-2 text-[12px] text-amber-600 dark:text-amber-400">⚠ {detectError}</div>}
                    {error && <div role="alert" className="px-5 pb-2 text-[12px] text-red-600 dark:text-red-400">❌ {error}</div>}
                </div>

                <div className={`flex items-center justify-end gap-2 shrink-0 ${embedded ? 'pt-3 border-t border-slate-200 dark:border-white/10' : 'px-5 py-3 border-t border-black/10 dark:border-white/10'}`}>
                    <button type="button" onClick={dismiss} disabled={isCommitting} className="px-4 h-9 text-[13px] rounded border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed">
                        {t('misc.cropDialog:huy')}
                    </button>
                    <button type="button" onClick={handleApply} disabled={runDisabled} className={`min-w-[120px] px-5 h-9 text-[13px] font-bold rounded text-white ${runDisabled ? 'bg-slate-400 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-700'}`}>
                        {phase === 'idle' ? t('misc.cropDialog:apply_crop') : phaseLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
