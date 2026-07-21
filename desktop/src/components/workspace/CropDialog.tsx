import { useEffect, useState, useCallback, useMemo } from 'react';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { roundMm2, validateRectUnit } from '../preprocess-tools/setPageBoxesUtils';
import { useTranslation } from 'react-i18next';

export interface BoxMm {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    width: number;
    height: number;
}
interface PageBoxesResponse {
    page: number;
    total_pages: number;
    mediabox: BoxMm;
    cropbox: BoxMm;
    trimbox: BoxMm;
    bleedbox: BoxMm;
    artbox: BoxMm;
}
export interface Frac { x0: number; y0: number; x1: number; y1: number }
export interface RectMm { x0: number; y0: number; x1: number; y1: number }
interface CropOpenDetail {
    pageNum: number;
    /** Nhiều vùng: mỗi vùng tạo một trang kết quả. */
    fracs?: Frac[];
    /** Tương thích sự kiện crop cũ chỉ có một vùng. */
    frac?: Frac;
}
interface DetectedRegion {
    rect_mm: RectMm & { width?: number; height?: number };
    changed: boolean;
    method: 'object' | 'pixels' | 'unchanged';
    confidence: 'high' | 'medium' | 'low';
}

interface Props {
    ensureFileId: () => Promise<string>;
    onApplied: (blob: Blob, filename: string) => void;
    onClose: () => void;
}

/** Convert viewer fractions (top-left origin) into PDF millimetres (bottom-left origin). */
export function fracToRectMm(frac: Frac, pageBox: BoxMm): RectMm {
    const leftMm = frac.x0 * pageBox.width;
    const rightMm = (1 - frac.x1) * pageBox.width;
    const topMm = frac.y0 * pageBox.height;
    const bottomMm = (1 - frac.y1) * pageBox.height;
    return {
        x0: roundMm2(pageBox.x0 + leftMm),
        y0: roundMm2(pageBox.y0 + bottomMm),
        x1: roundMm2(pageBox.x1 - rightMm),
        y1: roundMm2(pageBox.y1 - topMm),
    };
}

/** Convert a detected PDF rectangle back to the viewer's top-left fractions. */
export function rectMmToFrac(rect: RectMm, pageBox: BoxMm): Frac {
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    return {
        x0: clamp((rect.x0 - pageBox.x0) / pageBox.width),
        y0: clamp((pageBox.y1 - rect.y1) / pageBox.height),
        x1: clamp((rect.x1 - pageBox.x0) / pageBox.width),
        y1: clamp((pageBox.y1 - rect.y0) / pageBox.height),
    };
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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [processEdges, setProcessEdges] = useState(false);
    const [detectingEdges, setDetectingEdges] = useState(false);
    const [detectedRegions, setDetectedRegions] = useState<DetectedRegion[] | null>(null);
    const [detectError, setDetectError] = useState('');

    useEffect(() => {
        const onOpen = async (e: Event) => {
            const detail = (e as CustomEvent<CropOpenDetail>).detail;
            if (!detail) return;
            const list = (detail.fracs && detail.fracs.length > 0)
                ? detail.fracs
                : (detail.frac ? [detail.frac] : []);
            if (list.length === 0) return;

            setError('');
            setDetectError('');
            setDetectedRegions(null);
            setProcessEdges(false);
            setBusy(true);
            setOpen(true);
            setPageImg(null);
            setPageNum(detail.pageNum);
            setFracs(list);
            setSelectedIdx(0);
            try {
                const fid = await ensureFileId();
                setFileId(fid);
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/page-boxes/${fid}/${detail.pageNum}`);
                const data: PageBoxesResponse = await res.json();
                if (!res.ok || !data || !data.cropbox) {
                    throw new Error((data as any)?.detail || t('misc.cropDialog:khong_doc_duoc_kho_trang_http', { status: res.status }));
                }
                setBoxes(data);
                try {
                    const imgRes = await authenticatedFetch(`${getApiUrl()}/preflight/preview-hide`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ file_id: fid, page: detail.pageNum, objects: [] }),
                    });
                    const imgData = await imgRes.json();
                    if (imgData?.preview_b64) setPageImg(imgData.preview_b64);
                } catch { /* Preview is optional. */ }
            } catch (err: any) {
                setError(t('misc.cropDialog:khong_doc_duoc_kho_trang', { msg: err?.message || err }));
            } finally {
                setBusy(false);
            }
        };
        window.addEventListener('prynx-crop-open', onOpen as EventListener);
        return () => window.removeEventListener('prynx-crop-open', onOpen as EventListener);
    }, [ensureFileId, t]);

    const close = useCallback(() => {
        setOpen(false);
        setBoxes(null);
        setPageImg(null);
        setFracs([]);
        setDetectedRegions(null);
        setDetectError('');
        setProcessEdges(false);
    }, []);

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
                        max_trim_mm: 5,
                    }),
                    signal: controller.signal,
                });
                const data = await res.json();
                if (!res.ok || !Array.isArray(data?.regions) || data.regions.length !== rectsMm.length) {
                    throw new Error(data?.detail || t('misc.cropDialog:edge_detection_failed'));
                }
                setDetectedRegions(data.regions);
            } catch (err: any) {
                if (err?.name !== 'AbortError') {
                    setDetectError(err?.message || t('misc.cropDialog:edge_detection_failed'));
                }
            } finally {
                if (!controller.signal.aborted) setDetectingEdges(false);
            }
        })();
        return () => controller.abort();
    }, [processEdges, fileId, pageNum, pageBox, rectsMm, t]);

    const effectiveRects = useMemo(() => {
        if (!processEdges || !detectedRegions || detectedRegions.length !== rectsMm.length) return rectsMm;
        return detectedRegions.map((region) => region.rect_mm);
    }, [processEdges, detectedRegions, rectsMm]);

    const detectedFracs = useMemo(() => {
        if (!pageBox || !detectedRegions) return [];
        return detectedRegions.map((region) => rectMmToFrac(region.rect_mm, pageBox));
    }, [pageBox, detectedRegions]);

    const selectedRect = effectiveRects[selectedIdx] || null;
    const cropW = selectedRect ? roundMm2(selectedRect.x1 - selectedRect.x0) : 0;
    const cropH = selectedRect ? roundMm2(selectedRect.y1 - selectedRect.y0) : 0;
    const detectionReady = !processEdges || (
        !detectingEdges && !detectError && detectedRegions?.length === rectsMm.length
    );

    const handleApply = async () => {
        if (!boxes || effectiveRects.length === 0 || !detectionReady) return;
        for (let i = 0; i < effectiveRects.length; i++) {
            const valErr = validateRectUnit(effectiveRects[i]);
            if (valErr) {
                setError(t('misc.cropDialog:vung_cat_khong_hop_le', { err: `#${i + 1}: ${valErr}` }));
                return;
            }
        }
        setBusy(true);
        setError('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/crop-regions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    page: pageNum,
                    rects_mm: effectiveRects,
                }),
            });
            const data = await res.json();
            if (!data.success || !data.output_filename) {
                throw new Error(data.detail || t('misc.cropDialog:cat_kho_that_bai'));
            }
            const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
            if (!dl.ok) throw new Error(t('misc.cropDialog:cat_kho_that_bai'));
            const blob = await dl.blob();
            onApplied(blob, data.output_filename);
            close();
            onClose();
        } catch (err: any) {
            setError(err?.message || t('misc.cropDialog:cat_kho_that_bai'));
        } finally {
            setBusy(false);
        }
    };

    const removeRegion = (idx: number) => {
        setFracs((prev) => {
            const next = prev.filter((_, i) => i !== idx);
            if (next.length === 0) {
                close();
                onClose();
            }
            return next;
        });
        setSelectedIdx((selected) => Math.max(0, Math.min(selected, fracs.length - 2)));
    };

    if (!open) return null;

    const multi = fracs.length > 1;
    const runDisabled = busy || !boxes || effectiveRects.length === 0 || !detectionReady;

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); close(); } }}>
            <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-[760px] max-w-[95vw] border border-black/10 dark:border-white/10 text-slate-800 dark:text-zinc-200">
                <div className="flex items-center justify-between px-5 py-3 border-b border-black/10 dark:border-white/10">
                    <h2 className="text-[15px] font-bold">
                        {t('misc.cropDialog:cat_kho_trang')}
                        {multi && (
                            <span className="ml-2 text-[12px] font-semibold text-orange-600 dark:text-orange-400">
                                {t('misc.cropDialog:multi_summary', { count: fracs.length })}
                            </span>
                        )}
                    </h2>
                    <button onClick={() => { onClose(); close(); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10" title={t('misc.cropDialog:dong')}>
                        <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l12 12M1 13L13 1" strokeLinecap="round" /></svg>
                    </button>
                </div>

                <div className="p-5 grid grid-cols-2 gap-5">
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
                                <div
                                    key={i}
                                    onClick={() => setSelectedIdx(i)}
                                    className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border cursor-pointer transition-colors ${
                                        active
                                            ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30'
                                            : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                                >
                                    <span className="w-6 h-6 shrink-0 flex items-center justify-center rounded bg-orange-500 text-white text-[11px] font-bold">
                                        {i + 1}
                                    </span>
                                    <div className="flex-1 min-w-0 text-[12px]">
                                        <div className="font-semibold">{t('misc.cropDialog:region', { index: i + 1 })}</div>
                                        <div className="text-slate-500 tabular-nums">{width} × {height} mm</div>
                                        {detected?.changed && (
                                            <div className="mt-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                                {t('misc.cropDialog:edges_processed')}
                                            </div>
                                        )}
                                        {detected && !detected.changed && (
                                            <div className="mt-0.5 text-[10px] leading-tight text-amber-600 dark:text-amber-400">
                                                {t('misc.cropDialog:edge_unchanged')}
                                            </div>
                                        )}
                                    </div>
                                    {fracs.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); removeRegion(i); }}
                                            className="text-[11px] px-2 py-1 rounded border border-black/10 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                                            title={t('misc.cropDialog:remove_region')}
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        <p className="text-[10px] text-slate-400 leading-relaxed pt-1">
                            {t('misc.cropDialog:region_hint')}
                        </p>
                    </div>

                    <div className="flex flex-col items-center justify-center">
                        <div
                            className="relative bg-slate-100 dark:bg-zinc-900 border border-black/10 dark:border-white/10 overflow-hidden"
                            style={{
                                width: 240,
                                aspectRatio: pageBox && pageBox.height > 0 ? `${pageBox.width} / ${pageBox.height}` : '3 / 4',
                            }}
                        >
                            {pageImg && (
                                <img src={pageImg} alt="" className="absolute inset-0 w-full h-full object-fill select-none pointer-events-none" />
                            )}
                            {fracs.map((frac, i) => (
                                <div
                                    key={`rough-${i}`}
                                    className={`absolute border-2 border-dashed pointer-events-none ${
                                        i === selectedIdx
                                            ? 'border-orange-500 bg-orange-400/10 z-10'
                                            : 'border-orange-400/60 bg-orange-400/5'
                                    }`}
                                    style={{
                                        left: `${frac.x0 * 100}%`,
                                        top: `${frac.y0 * 100}%`,
                                        width: `${(frac.x1 - frac.x0) * 100}%`,
                                        height: `${(frac.y1 - frac.y0) * 100}%`,
                                    }}
                                >
                                    <span className="absolute -top-4 left-0 text-[9px] font-bold bg-orange-500 text-white px-1 rounded">
                                        {i + 1}
                                    </span>
                                </div>
                            ))}
                            {processEdges && detectedRegions && detectedFracs.map((frac, i) => detectedRegions[i]?.changed && (
                                <div
                                    key={`detected-${i}`}
                                    className="absolute border-2 border-emerald-500 bg-emerald-400/10 pointer-events-none z-20"
                                    style={{
                                        left: `${frac.x0 * 100}%`,
                                        top: `${frac.y0 * 100}%`,
                                        width: `${(frac.x1 - frac.x0) * 100}%`,
                                        height: `${(frac.y1 - frac.y0) * 100}%`,
                                    }}
                                />
                            ))}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-500">
                            {multi
                                ? t('misc.cropDialog:multi_summary', { count: fracs.length })
                                : (
                                    <>
                                        {t('misc.cropDialog:kho_sau_khi_cat')}{' '}
                                        <span className="font-semibold text-slate-700 dark:text-zinc-200">
                                            {cropW} × {cropH} mm
                                        </span>
                                    </>
                                )}
                        </div>
                    </div>

                    <label className={`col-span-2 flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                        processEdges
                            ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/25'
                            : 'border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/5'
                    }`}>
                        <input
                            type="checkbox"
                            checked={processEdges}
                            onChange={(e) => setProcessEdges(e.target.checked)}
                            disabled={busy || !boxes}
                            className="mt-0.5 w-4 h-4 accent-emerald-600"
                        />
                        <span className="min-w-0">
                            <span className="block text-[12px] font-bold">{t('misc.cropDialog:process_excess_edges')}</span>
                            <span className="block mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400">
                                {t('misc.cropDialog:process_excess_edges_desc')}
                            </span>
                            {detectingEdges && (
                                <span className="block mt-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                    {t('misc.cropDialog:detecting_edges')}
                                </span>
                            )}
                        </span>
                    </label>
                </div>

                {detectError && <div className="px-5 pb-2 text-[12px] text-amber-600 dark:text-amber-400">⚠ {detectError}</div>}
                {error && <div className="px-5 pb-2 text-[12px] text-red-600 dark:text-red-400">❌ {error}</div>}

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/10 dark:border-white/10">
                    <button onClick={() => { onClose(); close(); }} className="px-4 h-9 text-[13px] rounded border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10">
                        {t('misc.cropDialog:huy')}
                    </button>
                    <button
                        onClick={handleApply}
                        disabled={runDisabled}
                        className={`min-w-[84px] px-5 h-9 text-[13px] font-bold rounded text-white ${
                            runDisabled ? 'bg-slate-400 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-700'
                        }`}
                    >
                        {busy ? `${t('preprocess.common:run')}…` : t('preprocess.common:run')}
                    </button>
                </div>
            </div>
        </div>
    );
}
