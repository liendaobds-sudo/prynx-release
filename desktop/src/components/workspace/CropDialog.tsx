import { useEffect, useState, useCallback, useMemo } from 'react';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { roundMm2, validateRectUnit } from '../preprocess-tools/setPageBoxesUtils';
import { useTranslation } from 'react-i18next';

interface BoxMm { x0: number; y0: number; x1: number; y1: number; width: number; height: number; }
interface PageBoxesResponse {
    page: number; total_pages: number;
    mediabox: BoxMm; cropbox: BoxMm; trimbox: BoxMm; bleedbox: BoxMm; artbox: BoxMm;
}
interface Frac { x0: number; y0: number; x1: number; y1: number }
interface CropOpenDetail {
    pageNum: number;
    /** Nhiều vùng (cách A: mỗi vùng → 1 trang). */
    fracs?: Frac[];
    /** Tương thích cũ: 1 vùng. */
    frac?: Frac;
}

interface Props {
    ensureFileId: () => Promise<string>;
    onApplied: (blob: Blob, filename: string) => void;
    onClose: () => void;
}

/** frac (top-left, 0..1 trên MediaBox) → rect mm PDF (bottom-left). */
function fracToRectMm(frac: Frac, mb: BoxMm): { x0: number; y0: number; x1: number; y1: number } {
    const leftMm = frac.x0 * mb.width;
    const rightMm = (1 - frac.x1) * mb.width;
    const topMm = frac.y0 * mb.height;
    const bottomMm = (1 - frac.y1) * mb.height;
    return {
        x0: roundMm2(mb.x0 + leftMm),
        y0: roundMm2(mb.y0 + bottomMm),
        x1: roundMm2(mb.x1 - rightMm),
        y1: roundMm2(mb.y1 - topMm),
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

    useEffect(() => {
        const onOpen = async (e: Event) => {
            const detail = (e as CustomEvent<CropOpenDetail>).detail;
            if (!detail) return;
            const list = (detail.fracs && detail.fracs.length > 0)
                ? detail.fracs
                : (detail.frac ? [detail.frac] : []);
            if (list.length === 0) return;

            setError('');
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
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ file_id: fid, page: detail.pageNum, objects: [] }),
                    });
                    const imgData = await imgRes.json();
                    if (imgData?.preview_b64) setPageImg(imgData.preview_b64);
                } catch { /* preview optional */ }
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
    }, []);

    const mb = boxes?.mediabox || boxes?.cropbox || null;

    const rectsMm = useMemo(() => {
        if (!mb || fracs.length === 0) return [];
        return fracs.map((f) => fracToRectMm(f, mb));
    }, [mb, fracs]);

    const selectedRect = rectsMm[selectedIdx] || null;
    const cropW = selectedRect ? roundMm2(selectedRect.x1 - selectedRect.x0) : 0;
    const cropH = selectedRect ? roundMm2(selectedRect.y1 - selectedRect.y0) : 0;

    const handleApply = async () => {
        if (!boxes || rectsMm.length === 0) return;
        for (let i = 0; i < rectsMm.length; i++) {
            const valErr = validateRectUnit(rectsMm[i]);
            if (valErr) {
                setError(t('misc.cropDialog:vung_cat_khong_hop_le', { err: `#${i + 1}: ${valErr}` }));
                return;
            }
        }
        setBusy(true);
        setError('');
        try {
            // 1 vùng: vẫn dùng multipage API (1 trang) — cùng physical crop.
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/crop-regions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: fileId,
                    page: pageNum,
                    rects_mm: rectsMm,
                }),
            });
            const data = await res.json();
            if (!data.success || !data.output_filename) {
                throw new Error(data.detail || t('misc.cropDialog:cat_kho_that_bai'));
            }
            const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
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
        setSelectedIdx((s) => Math.max(0, Math.min(s, fracs.length - 2)));
    };

    if (!open) return null;

    const multi = fracs.length > 1;

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); close(); } }}>
            <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-[720px] max-w-[95vw] border border-black/10 dark:border-white/10 text-slate-800 dark:text-zinc-200">
                <div className="flex items-center justify-between px-5 py-3 border-b border-black/10 dark:border-white/10">
                    <h2 className="text-[15px] font-bold">
                        {t('misc.cropDialog:cat_kho_trang')}
                        {multi && (
                            <span className="ml-2 text-[12px] font-semibold text-orange-600 dark:text-orange-400">
                                {fracs.length} vùng → {fracs.length} trang
                            </span>
                        )}
                    </h2>
                    <button onClick={() => { onClose(); close(); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10" title={t('misc.cropDialog:dong')}>
                        <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l12 12M1 13L13 1" strokeLinecap="round" /></svg>
                    </button>
                </div>

                <div className="p-5 grid grid-cols-2 gap-5">
                    {/* Danh sách vùng */}
                    <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                        <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                            Vùng đã quét (trang {pageNum})
                        </div>
                        {fracs.map((f, i) => {
                            const r = rectsMm[i];
                            const w = r ? roundMm2(r.x1 - r.x0) : 0;
                            const h = r ? roundMm2(r.y1 - r.y0) : 0;
                            const active = i === selectedIdx;
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
                                        <div className="font-semibold">Vùng {i + 1}</div>
                                        <div className="text-slate-500 tabular-nums">{w} × {h} mm</div>
                                    </div>
                                    {fracs.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); removeRegion(i); }}
                                            className="text-[11px] px-2 py-1 rounded border border-black/10 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                                            title="Xóa vùng này"
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                        <p className="text-[10px] text-slate-400 leading-relaxed pt-1">
                            Mỗi vùng → 1 trang PDF. Quét thêm trên viewer rồi Enter lại nếu cần chỉnh.
                        </p>
                    </div>

                    {/* Preview */}
                    <div className="flex flex-col items-center justify-center">
                        <div
                            className="relative bg-slate-100 dark:bg-zinc-900 border border-black/10 dark:border-white/10 overflow-hidden"
                            style={{
                                width: 220,
                                aspectRatio: mb && mb.height > 0 ? `${mb.width} / ${mb.height}` : '3 / 4',
                            }}
                        >
                            {pageImg && (
                                <img src={pageImg} alt="" className="absolute inset-0 w-full h-full object-fill select-none pointer-events-none" />
                            )}
                            {fracs.map((f, i) => (
                                <div
                                    key={i}
                                    className={`absolute border-2 pointer-events-none ${
                                        i === selectedIdx
                                            ? 'border-orange-500 bg-orange-400/15 z-10'
                                            : 'border-orange-400/60 bg-orange-400/5'
                                    }`}
                                    style={{
                                        left: `${f.x0 * 100}%`,
                                        top: `${f.y0 * 100}%`,
                                        width: `${(f.x1 - f.x0) * 100}%`,
                                        height: `${(f.y1 - f.y0) * 100}%`,
                                    }}
                                >
                                    <span className="absolute -top-4 left-0 text-[9px] font-bold bg-orange-500 text-white px-1 rounded">
                                        {i + 1}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-500">
                            {multi
                                ? `${fracs.length} vùng → ${fracs.length} trang`
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
                </div>

                {error && <div className="px-5 pb-2 text-[12px] text-red-600 dark:text-red-400">❌ {error}</div>}

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/10 dark:border-white/10">
                    <button onClick={() => { onClose(); close(); }} className="px-4 h-9 text-[13px] rounded border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10">
                        {t('misc.cropDialog:huy')}
                    </button>
                    <button
                        onClick={handleApply}
                        disabled={busy || !boxes || rectsMm.length === 0}
                        className={`px-5 h-9 text-[13px] font-bold rounded text-white ${
                            busy || !boxes || rectsMm.length === 0
                                ? 'bg-slate-400 cursor-not-allowed'
                                : 'bg-orange-600 hover:bg-orange-700'
                        }`}
                    >
                        {busy
                            ? t('misc.cropDialog:dang_xu_ly')
                            : multi
                                ? `Áp dụng (${fracs.length} trang)`
                                : t('misc.cropDialog:ap_dung')}
                    </button>
                </div>
            </div>
        </div>
    );
}
