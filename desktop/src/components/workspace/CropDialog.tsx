import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { roundMm2, validateRectUnit } from '../preprocess-tools/setPageBoxesUtils';
import { useTranslation } from 'react-i18next';
import { fracToRectMm, rectMmToFrac, type BoxMm, type Frac, type RectMm } from '../../lib/cropDialogGeometry';

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
    /** Nhiều vùng: mỗi vùng tạo một trang kết quả. */
    fracs?: Frac[];
    /** Tương thích sự kiện crop cũ chỉ có một vùng. */
    frac?: Frac;
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

interface PreviewResponse {
    preview_b64?: string;
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

type CropPhase = 'idle' | 'preparing' | 'applying' | 'committing';
type OutputMode = 'keep_document' | 'regions_only';

interface Props {
    ensureFileId: (signal?: AbortSignal) => Promise<string>;
    onApplied: (blob: Blob, filename: string) => void | Promise<void>;
    onClose: () => void;
}

export default function CropDialog({ ensureFileId, onApplied, onClose }: Props) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [pageNum, setPageNum] = useState(1);
    const [fileId, setFileId] = useState('');
    const [boxes, setBoxes] = useState<PageBoxesResponse | null>(null);
    const [pageImg, setPageImg] = useState<string | null>(null);
    const [fracs, setFracs] = useState<Frac[]>([]);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [phase, setPhase] = useState<CropPhase>('idle');
    const [error, setError] = useState('');
    const [processEdges, setProcessEdges] = useState(true);
    const [detectingEdges, setDetectingEdges] = useState(false);
    const [detectedRegions, setDetectedRegions] = useState<DetectedRegion[] | null>(null);
    const [maxTrimMm, setMaxTrimMm] = useState(DEFAULT_MAX_TRIM_MM);
    const [detectError, setDetectError] = useState('');
    const [outputMode, setOutputMode] = useState<OutputMode>('keep_document');

    const dialogRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const loadAbortRef = useRef<AbortController | null>(null);
    const applyAbortRef = useRef<AbortController | null>(null);
    const openRequestIdRef = useRef(0);
    const committingRef = useRef(false);

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
        setOpen(false);
        setBoxes(null);
        setPageImg(null);
        setFracs([]);
        setDetectedRegions(null);
        setDetectError('');
        setProcessEdges(true);
        setMaxTrimMm(DEFAULT_MAX_TRIM_MM);
        setOutputMode('keep_document');
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
            const controller = new AbortController();
            loadAbortRef.current = controller;
            const requestId = ++openRequestIdRef.current;
            previousFocusRef.current = document.activeElement as HTMLElement | null;

            setError('');
            setDetectError('');
            setDetectedRegions(null);
            setProcessEdges(true);
            setOutputMode('keep_document');
            setMaxTrimMm(DEFAULT_MAX_TRIM_MM);
            setPhase('preparing');
            setOpen(true);
            setBoxes(null);
            setPageImg(null);
            setPageNum(detail.pageNum);
            setFracs(list);
            setSelectedIdx(0);

            try {
                const fid = await ensureFileId(controller.signal);
                controller.signal.throwIfAborted();
                if (requestId !== openRequestIdRef.current) return;
                setFileId(fid);

                const [boxRes, imgData] = await Promise.all([
                    authenticatedFetch(`${getApiUrl()}/preflight/page-boxes/${fid}/${detail.pageNum}`, {
                        signal: controller.signal,
                    }),
                    authenticatedFetch(`${getApiUrl()}/preflight/preview-hide`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ file_id: fid, page: detail.pageNum, objects: [], preview_dpi: 120, preview_max_pixels: 4_000_000 }),
                        signal: controller.signal,
                    }).then(async (res): Promise<PreviewResponse | null> => res.ok ? res.json() : null).catch((err: unknown) => {
                        if (isAbortError(err)) throw err;
                        return null;
                    }),
                ]);
                const data = await boxRes.json() as PageBoxesResponse & ApiResult;
                if (!boxRes.ok || !data?.cropbox) {
                    throw new Error(data.detail || t('misc.cropDialog:khong_doc_duoc_kho_trang_http', { status: boxRes.status }));
                }
                controller.signal.throwIfAborted();
                if (requestId !== openRequestIdRef.current) return;
                setBoxes(data);
                if (imgData?.preview_b64) setPageImg(imgData.preview_b64);
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
        dialogRef.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            dismiss();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [dismiss, open]);

    // PDF.js displays CropBox. Using MediaBox here shifts and rescales selections on cropped PDFs.
    const pageBox = boxes?.cropbox || boxes?.mediabox || null;

    const rectsMm = useMemo(() => {
        if (!pageBox || fracs.length === 0) return [];
        return fracs.map((frac) => fracToRectMm(frac, pageBox));
    }, [pageBox, fracs]);

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

    const detectedFracs = useMemo(() => {
        if (!pageBox || !detectedRegions || effectiveRects.length !== detectedRegions.length) return [];
        return effectiveRects.map((rect) => rectMmToFrac(rect, pageBox));
    }, [pageBox, detectedRegions, effectiveRects]);

    const selectedRect = effectiveRects[selectedIdx] || null;
    const selectedFrac = fracs[selectedIdx] || null;
    const cropW = selectedRect ? roundMm2(selectedRect.x1 - selectedRect.x0) : 0;
    const cropH = selectedRect ? roundMm2(selectedRect.y1 - selectedRect.y0) : 0;
    // Edge processing is a safe enhancement. If detection fails, keep the
    // user's original rectangles instead of blocking the crop operation.
    const detectionReady = !processEdges || !detectingEdges;

    const previewWidth = useMemo(() => {
        if (!pageBox?.width || !pageBox?.height) return 240;
        return Math.max(80, Math.min(240, 320 * pageBox.width / pageBox.height));
    }, [pageBox]);

    const resultPageCount = boxes
        ? (outputMode === 'keep_document' ? boxes.total_pages - 1 + fracs.length : fracs.length)
        : fracs.length;

    const marginValues = selectedFrac && pageBox ? {
        left: roundMm2(selectedFrac.x0 * pageBox.width),
        top: roundMm2(selectedFrac.y0 * pageBox.height),
        right: roundMm2((1 - selectedFrac.x1) * pageBox.width),
        bottom: roundMm2((1 - selectedFrac.y1) * pageBox.height),
    } : null;

    const updateSelectedMargin = (side: 'left' | 'top' | 'right' | 'bottom', rawValue: string) => {
        if (!pageBox || !selectedFrac || processEdges || phase !== 'idle') return;
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) return;
        const value = Math.max(0, parsed);
        setFracs((prev) => prev.map((frac, index) => {
            if (index !== selectedIdx) return frac;
            const next = { ...frac };
            const minFrac = 0.001;
            if (side === 'left') {
                next.x0 = Math.min(value / pageBox.width, next.x1 - minFrac);
            } else if (side === 'right') {
                next.x1 = Math.max(1 - value / pageBox.width, next.x0 + minFrac);
            } else if (side === 'top') {
                next.y0 = Math.min(value / pageBox.height, next.y1 - minFrac);
            } else {
                next.y1 = Math.max(1 - value / pageBox.height, next.y0 + minFrac);
            }
            next.x0 = Math.max(0, Math.min(1, next.x0));
            next.y0 = Math.max(0, Math.min(1, next.y0));
            next.x1 = Math.max(0, Math.min(1, next.x1));
            next.y1 = Math.max(0, Math.min(1, next.y1));
            return next;
        }));
    };

    const handleApply = async () => {
        if (!boxes || effectiveRects.length === 0 || !detectionReady || phase !== 'idle') return;
        for (let i = 0; i < effectiveRects.length; i++) {
            const valErr = validateRectUnit(effectiveRects[i]);
            if (valErr) {
                setError(t('misc.cropDialog:vung_cat_khong_hop_le', { err: `#${i + 1}: ${valErr}` }));
                return;
            }
        }

        const controller = new AbortController();
        applyAbortRef.current?.abort();
        applyAbortRef.current = controller;
        setPhase('applying');
        setError('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/crop-regions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    page: pageNum,
                    rects_mm: effectiveRects,
                    keep_other_pages: outputMode === 'keep_document',
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
            await onApplied(blob, data.output_filename);
            applyAbortRef.current = null;
            resetDialog();
            onClose();
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

    const removeRegion = (idx: number) => {
        setFracs((prev) => {
            const next = prev.filter((_, i) => i !== idx);
            if (next.length === 0) queueMicrotask(dismiss);
            return next;
        });
        setSelectedIdx((selected) => Math.max(0, Math.min(selected, fracs.length - 2)));
    };

    if (!open) return null;

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
        <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 p-2 sm:p-4"
            onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="crop-dialog-title"
                aria-describedby="crop-dialog-help"
                aria-busy={phase !== 'idle'}
                tabIndex={-1}
                className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-[760px] max-w-[95vw] max-h-[92vh] overflow-hidden border border-black/10 dark:border-white/10 text-slate-800 dark:text-zinc-200 flex flex-col outline-none"
            >
                <div className="flex items-center justify-between px-5 py-3 border-b border-black/10 dark:border-white/10 shrink-0">
                    <h2 id="crop-dialog-title" className="text-[15px] font-bold">
                        {t('misc.cropDialog:cat_kho_trang')}
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
                </div>

                <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5 overflow-y-auto">
                    <div className="space-y-2 max-h-[330px] overflow-y-auto pr-1">
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
                        {marginValues && (
                            <fieldset className="mt-2 rounded-lg border border-black/10 dark:border-white/10 p-2.5">
                                <legend className="px-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{t('misc.cropDialog:precision_margins')}</legend>
                                <div className="grid grid-cols-2 gap-2">
                                    {([
                                        ['left', 'misc.cropDialog:le_trai'],
                                        ['top', 'misc.cropDialog:le_tren'],
                                        ['right', 'misc.cropDialog:le_phai'],
                                        ['bottom', 'misc.cropDialog:le_duoi'],
                                    ] as const).map(([side, label]) => (
                                        <label key={side} className="text-[10px] text-slate-500">
                                            <span className="block mb-0.5">{t(label)}</span>
                                            <span className="flex items-center gap-1">
                                                <input type="number" min="0" step="0.1" value={marginValues[side]} onChange={(event) => updateSelectedMargin(side, event.target.value)} disabled={processEdges || phase !== 'idle'} className="w-full h-7 rounded border border-black/15 dark:border-white/15 bg-white dark:bg-zinc-900 px-2 text-[11px] tabular-nums disabled:opacity-50" />
                                                <span>mm</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                        )}
                        <p id="crop-dialog-help" className="text-[11px] text-slate-500 leading-relaxed pt-1">
                            {t('misc.cropDialog:region_hint')}
                        </p>
                    </div>

                    <div className="flex flex-col items-center justify-center min-w-0">
                        <div
                            className="relative bg-slate-100 dark:bg-zinc-900 border border-black/10 dark:border-white/10 overflow-hidden max-w-full"
                            style={{
                                width: previewWidth,
                                aspectRatio: pageBox && pageBox.height > 0 ? `${pageBox.width} / ${pageBox.height}` : '3 / 4',
                            }}
                        >
                            {pageImg && <img src={pageImg} alt="" className="absolute inset-0 w-full h-full object-fill select-none pointer-events-none" />}
                            {fracs.map((frac, i) => (
                                <div
                                    key={`rough-${i}`}
                                    className={`absolute border-2 border-dashed pointer-events-none ${i === selectedIdx ? 'border-orange-500 bg-orange-400/10 z-10' : 'border-orange-400/60 bg-orange-400/5'}`}
                                    style={{ left: `${frac.x0 * 100}%`, top: `${frac.y0 * 100}%`, width: `${(frac.x1 - frac.x0) * 100}%`, height: `${(frac.y1 - frac.y0) * 100}%` }}
                                >
                                    <span className="absolute -top-4 left-0 text-[9px] font-bold bg-orange-500 text-white px-1 rounded">{i + 1}</span>
                                </div>
                            ))}
                            {processEdges && detectedRegions && detectedFracs.map((frac, i) => detectedRegions[i]?.changed && (
                                <div
                                    key={`detected-${i}`}
                                    className="absolute border-2 border-emerald-500 bg-emerald-400/10 pointer-events-none z-20"
                                    style={{ left: `${frac.x0 * 100}%`, top: `${frac.y0 * 100}%`, width: `${(frac.x1 - frac.x0) * 100}%`, height: `${(frac.y1 - frac.y0) * 100}%` }}
                                />
                            ))}
                            {phase === 'preparing' && (
                                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/80 dark:bg-zinc-900/80 text-[11px] font-semibold">
                                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-orange-600" />
                                    {phaseLabel}
                                </div>
                            )}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-500 text-center">
                            {multi
                                ? t('misc.cropDialog:multi_summary', { count: fracs.length })
                                : <>{t('misc.cropDialog:kho_sau_khi_cat')} <span className="font-semibold text-slate-700 dark:text-zinc-200">{cropW} × {cropH} mm</span></>}
                        </div>
                    </div>

                    <fieldset className="col-span-1 sm:col-span-2 rounded-lg border border-black/10 dark:border-white/10 p-3">
                        <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">{t('misc.cropDialog:output_mode')}</legend>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <label className={`flex gap-2 rounded-md border p-2.5 cursor-pointer ${outputMode === 'keep_document' ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/25' : 'border-black/10 dark:border-white/10'}`}>
                                <input type="radio" name="crop-output-mode" value="keep_document" checked={outputMode === 'keep_document'} onChange={() => setOutputMode('keep_document')} disabled={phase !== 'idle'} className="mt-0.5 accent-orange-600" />
                                <span><span className="block text-[12px] font-bold">{t('misc.cropDialog:keep_document')}</span><span className="block mt-0.5 text-[10px] leading-relaxed text-slate-500">{t('misc.cropDialog:keep_document_desc', { page: pageNum, count: fracs.length })}</span></span>
                            </label>
                            <label className={`flex gap-2 rounded-md border p-2.5 cursor-pointer ${outputMode === 'regions_only' ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/25' : 'border-black/10 dark:border-white/10'}`}>
                                <input type="radio" name="crop-output-mode" value="regions_only" checked={outputMode === 'regions_only'} onChange={() => setOutputMode('regions_only')} disabled={phase !== 'idle'} className="mt-0.5 accent-orange-600" />
                                <span><span className="block text-[12px] font-bold">{t('misc.cropDialog:regions_only')}</span><span className="block mt-0.5 text-[10px] leading-relaxed text-slate-500">{t('misc.cropDialog:regions_only_desc', { count: fracs.length })}</span></span>
                            </label>
                        </div>
                        <p className={`mt-2 text-[11px] font-semibold ${outputMode === 'regions_only' && (boxes?.total_pages || 0) > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'}`}>
                            {outputMode === 'regions_only' && (boxes?.total_pages || 0) > 1
                                ? t('misc.cropDialog:regions_only_warning', { total: boxes?.total_pages })
                                : t('misc.cropDialog:result_summary', { count: resultPageCount })}
                        </p>
                    </fieldset>

                    <div className={`col-span-1 sm:col-span-2 rounded-lg border px-3 py-2.5 transition-colors ${processEdges ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/25' : 'border-black/10 dark:border-white/10'}`}>
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
                </div>

                <div aria-live="polite" className="shrink-0">
                    {phase !== 'idle' && phase !== 'preparing' && <div className="px-5 pb-2 flex items-center gap-2 text-[12px] font-semibold text-orange-700 dark:text-orange-300"><span className="h-4 w-4 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" />{phaseLabel}</div>}
                    {detectError && <div className="px-5 pb-2 text-[12px] text-amber-600 dark:text-amber-400">⚠ {detectError}</div>}
                    {error && <div role="alert" className="px-5 pb-2 text-[12px] text-red-600 dark:text-red-400">❌ {error}</div>}
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/10 dark:border-white/10 shrink-0">
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
