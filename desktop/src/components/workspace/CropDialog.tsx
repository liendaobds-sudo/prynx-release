import { useEffect, useState, useCallback } from 'react';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import {
    type Unit, type BoxType, type PageScope,
    toMm, fromMm, roundMm2, validateRectUnit, resolvePages,
} from '../preprocess-tools/setPageBoxesUtils';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface BoxMm { x0: number; y0: number; x1: number; y1: number; width: number; height: number; }
interface PageBoxesResponse {
    page: number; total_pages: number;
    mediabox: BoxMm; cropbox: BoxMm; trimbox: BoxMm; bleedbox: BoxMm; artbox: BoxMm;
}
interface CropOpenDetail { pageNum: number; frac: { x0: number; y0: number; x1: number; y1: number }; }

interface Props {
    /** Trả về file_id của Working_File hiện tại (upload nếu cần). */
    ensureFileId: () => Promise<string>;
    /** Áp kết quả crop vào viewer. */
    onApplied: (blob: Blob, filename: string) => void;
    /** Đóng/huỷ chế độ crop. */
    onClose: () => void;
}

const UNIT_LABELS: Record<Unit, string> = { mm: 'Milimét (mm)', cm: 'Xentimét (cm)', inch: 'Inch', pt: 'Point (pt)' };
const BOX_LABELS: Record<BoxType, string> = {
    cropbox: 'CropBox (vùng hiển thị)', mediabox: 'MediaBox (khổ giấy)', trimbox: 'TrimBox (thành phẩm)',
    bleedbox: 'BleedBox (tràn lề)', artbox: 'ArtBox (nội dung)',
};

export default function CropDialog({ ensureFileId, onApplied, onClose }: Props) {
  const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [pageNum, setPageNum] = useState(1);
    const [fileId, setFileId] = useState('');
    const [boxes, setBoxes] = useState<PageBoxesResponse | null>(null);
    const [pageImg, setPageImg] = useState<string | null>(null);
    const [unit, setUnit] = useState<Unit>('mm');
    // Lề (theo đơn vị đang chọn), gốc theo CropBox hiện tại.
    const [margins, setMargins] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
    const [applyTo, setApplyTo] = useState<BoxType>('cropbox');
    const [scope, setScope] = useState<PageScope>('single');
    const [rangeStart, setRangeStart] = useState(1);
    const [rangeEnd, setRangeEnd] = useState(1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    // Lắng nghe sự kiện mở từ LivePageFrame (Enter sau khi quét vùng).
    useEffect(() => {
        const onOpen = async (e: Event) => {
            const detail = (e as CustomEvent<CropOpenDetail>).detail;
            if (!detail) return;
            setError('');
            setBusy(true);
            setOpen(true);
            setPageImg(null);
            setPageNum(detail.pageNum);
            setRangeStart(detail.pageNum);
            setRangeEnd(detail.pageNum);
            setScope('single');
            try {
                const fid = await ensureFileId();
                setFileId(fid);
                const res = await authenticatedFetch(`${getApiUrl()}/preflight/page-boxes/${fid}/${detail.pageNum}`);
                const data: PageBoxesResponse = await res.json();
                // Backend trả 500 → data = {detail:...} (không có cropbox). Phải báo lỗi thay vì set rồi crash.
                if (!res.ok || !data || !data.cropbox) {
                    throw new Error((data as any)?.detail || t('misc.cropDialog:khong_doc_duoc_kho_trang_http', { status: res.status }));
                }
                setBoxes(data);
                // Lề (mm) từ fractions × kích thước CropBox hiện tại (vùng hiển thị = CropBox).
                const cb = data.cropbox;
                const leftMm = detail.frac.x0 * cb.width;
                const rightMm = (1 - detail.frac.x1) * cb.width;
                const topMm = detail.frac.y0 * cb.height;
                const bottomMm = (1 - detail.frac.y1) * cb.height;
                setUnit('mm');
                setMargins({
                    top: roundMm2(topMm), bottom: roundMm2(bottomMm),
                    left: roundMm2(leftMm), right: roundMm2(rightMm),
                });
                // Ảnh trang thật cho preview (không bắt buộc — lỗi thì bỏ qua).
                try {
                    const imgRes = await authenticatedFetch(`${getApiUrl()}/preflight/preview-hide`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ file_id: fid, page: detail.pageNum, objects: [] }),
                    });
                    const imgData = await imgRes.json();
                    if (imgData?.preview_b64) setPageImg(imgData.preview_b64);
                } catch { /* ảnh preview không bắt buộc */ }
            } catch (err: any) {
                setError(t('misc.cropDialog:khong_doc_duoc_kho_trang', { msg: err?.message || err }));
            } finally {
                setBusy(false);
            }
        };
        window.addEventListener('prynx-crop-open', onOpen as EventListener);
        return () => window.removeEventListener('prynx-crop-open', onOpen as EventListener);
    }, [ensureFileId]);

    const close = useCallback(() => { setOpen(false); setBoxes(null); setPageImg(null); }, []);

    // Đổi đơn vị: giữ nguyên giá trị mm thực, chỉ đổi cách hiển thị.
    const changeUnit = (u: Unit) => {
        setMargins(prev => ({
            top: round4(fromMm(toMm(prev.top, unit), u)),
            bottom: round4(fromMm(toMm(prev.bottom, unit), u)),
            left: round4(fromMm(toMm(prev.left, unit), u)),
            right: round4(fromMm(toMm(prev.right, unit), u)),
        }));
        setUnit(u);
    };

    // Lề (mm) hiện tại + rect tuyệt đối (mm) theo CropBox gốc.
    const computeRectMm = useCallback(() => {
        if (!boxes || !boxes.cropbox) return null;
        const cb = boxes.cropbox;
        const leftMm = toMm(margins.left, unit);
        const rightMm = toMm(margins.right, unit);
        const topMm = toMm(margins.top, unit);
        const bottomMm = toMm(margins.bottom, unit);
        return {
            x0: roundMm2(cb.x0 + leftMm),
            y0: roundMm2(cb.y0 + bottomMm),
            x1: roundMm2(cb.x1 - rightMm),
            y1: roundMm2(cb.y1 - topMm),
        };
    }, [boxes, margins, unit]);

    const rectMm = computeRectMm();
    const cropW = rectMm ? roundMm2(rectMm.x1 - rectMm.x0) : 0;
    const cropH = rectMm ? roundMm2(rectMm.y1 - rectMm.y0) : 0;

    const handleApply = async () => {
        if (!boxes || !rectMm) return;
        const valErr = validateRectUnit(rectMm);
        if (valErr) { setError(t('misc.cropDialog:vung_cat_khong_hop_le', { err: valErr })); return; }
        const pr = resolvePages(scope, rangeStart, rangeEnd, boxes.total_pages);
        if ('error' in pr) { setError(pr.error); return; }
        setBusy(true);
        setError('');
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/preflight/set-page-boxes`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId, box_type: applyTo, rect_mm: rectMm, pages: pr.pages }),
            });
            const data = await res.json();
            if (!data.success || !data.output_filename) throw new Error(data.detail || t('misc.cropDialog:cat_kho_that_bai'));
            const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
            const blob = await dl.blob();
            onApplied(blob, data.output_filename);
            close();
        } catch (err: any) {
            setError(err?.message || t('misc.cropDialog:cat_kho_that_bai'));
        } finally {
            setBusy(false);
        }
    };

    if (!open) return null;

    const total = boxes?.total_pages || 1;
    // Preview fractions (theo CropBox) để vẽ khung.
    const cb = boxes?.cropbox;
    const previewFrac = cb && cb.width > 0 && cb.height > 0 ? {
        left: toMm(margins.left, unit) / cb.width,
        top: toMm(margins.top, unit) / cb.height,
        right: toMm(margins.right, unit) / cb.width,
        bottom: toMm(margins.bottom, unit) / cb.height,
    } : { left: 0, top: 0, right: 0, bottom: 0 };

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) { onClose(); close(); } }}>
            <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-[680px] max-w-[95vw] border border-black/10 dark:border-white/10 text-slate-800 dark:text-zinc-200">
                <div className="flex items-center justify-between px-5 py-3 border-b border-black/10 dark:border-white/10">
                    <h2 className="text-[15px] font-bold">{t('misc.cropDialog:cat_kho_trang')}</h2>
                    <button onClick={() => { onClose(); close(); }} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10" title={t('misc.cropDialog:dong')}>
                        <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.5"><path d="M1 1l12 12M1 13L13 1" strokeLinecap="round" /></svg>
                    </button>
                </div>

                <div className="p-5 grid grid-cols-2 gap-5">
                    {/* CỘT TRÁI: Margin Controls */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <label className="text-[12px] w-20 text-slate-500">{t('misc.cropDialog:don_vi')}</label>
                            <select value={unit} onChange={(e) => changeUnit(e.target.value as Unit)}
                                className="flex-1 h-8 px-2 text-[12px] border border-black/15 dark:border-white/15 rounded bg-white dark:bg-zinc-900">
                                {(Object.keys(UNIT_LABELS) as Unit[]).map(u => <option key={u} value={u}>{tv(UNIT_LABELS[u])}</option>)}
                            </select>
                        </div>
                        <div className="flex items-center gap-2">
                            <label className="text-[12px] w-20 text-slate-500">{t('misc.cropDialog:ap_dung_cho')}</label>
                            <select value={applyTo} onChange={(e) => setApplyTo(e.target.value as BoxType)}
                                className="flex-1 h-8 px-2 text-[12px] border border-black/15 dark:border-white/15 rounded bg-white dark:bg-zinc-900">
                                {(Object.keys(BOX_LABELS) as BoxType[]).map(b => <option key={b} value={b}>{tv(BOX_LABELS[b])}</option>)}
                            </select>
                        </div>

                        <div className="pt-1 grid grid-cols-2 gap-2">
                            {(['top', 'bottom', 'left', 'right'] as const).map(k => (
                                <label key={k} className="flex items-center gap-1.5 text-[12px]">
                                    <span className="w-14 text-slate-500">{
                                        k === 'top' ? t('misc.cropDialog:le_tren') : k === 'bottom' ? t('misc.cropDialog:le_duoi') : k === 'left' ? t('misc.cropDialog:le_trai') : t('misc.cropDialog:le_phai')
                                    }</span>
                                    <input type="number" step={0.1} value={margins[k]}
                                        onChange={(e) => setMargins(m => ({ ...m, [k]: parseFloat(e.target.value) || 0 }))}
                                        className="flex-1 w-0 h-8 px-2 text-[12px] text-right border border-black/15 dark:border-white/15 rounded bg-white dark:bg-zinc-900" />
                                </label>
                            ))}
                        </div>
                        <button onClick={() => setMargins({ top: 0, bottom: 0, left: 0, right: 0 })}
                            className="text-[11px] px-2 py-1 rounded border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10">
                            {t('misc.cropDialog:dat_le_ve_0')}
                        </button>
                    </div>

                    {/* CỘT PHẢI: Preview ảnh trang thật + khung cắt */}
                    <div className="flex flex-col items-center justify-center">
                        <div className="relative bg-slate-100 dark:bg-zinc-900 border border-black/10 dark:border-white/10 overflow-hidden"
                            style={{ width: 190, aspectRatio: cb && cb.height > 0 ? `${cb.width} / ${cb.height}` : '3 / 4' }}>
                            {pageImg && <img src={pageImg} alt="" className="absolute inset-0 w-full h-full object-fill select-none pointer-events-none" />}
                            <div className="absolute border-2 border-orange-500 bg-orange-400/10" style={{
                                left: `${previewFrac.left * 100}%`, top: `${previewFrac.top * 100}%`,
                                right: `${previewFrac.right * 100}%`, bottom: `${previewFrac.bottom * 100}%`,
                            }} />
                        </div>
                        <div className="mt-2 text-[11px] text-slate-500">
                            {t('misc.cropDialog:kho_sau_khi_cat')} <span className="font-semibold text-slate-700 dark:text-zinc-200">{cropW} × {cropH} mm</span>
                        </div>
                    </div>
                </div>

                {/* Page Range */}
                <div className="px-5 pb-2">
                    <div className="text-[12px] font-semibold text-slate-500 mb-1.5">{t('misc.cropDialog:pham_vi_trang')}</div>
                    <div className="flex items-center gap-4 text-[12px]">
                        <label className="flex items-center gap-1.5"><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> {t('misc.cropDialog:tat_ca')}</label>
                        <label className="flex items-center gap-1.5"><input type="radio" checked={scope === 'single'} onChange={() => setScope('single')} /> {t('misc.cropDialog:trang_nay')}</label>
                        <label className="flex items-center gap-1.5">
                            <input type="radio" checked={scope === 'range'} onChange={() => setScope('range')} /> {t('misc.cropDialog:tu')}
                            <input type="number" min={1} max={total} value={rangeStart} onChange={(e) => setRangeStart(parseInt(e.target.value) || 1)}
                                className="w-14 h-7 px-1 text-right border border-black/15 dark:border-white/15 rounded bg-white dark:bg-zinc-900" disabled={scope !== 'range'} />
                            {t('misc.cropDialog:den')}
                            <input type="number" min={1} max={total} value={rangeEnd} onChange={(e) => setRangeEnd(parseInt(e.target.value) || 1)}
                                className="w-14 h-7 px-1 text-right border border-black/15 dark:border-white/15 rounded bg-white dark:bg-zinc-900" disabled={scope !== 'range'} />
                            <span className="text-slate-400">/ {total}</span>
                        </label>
                    </div>
                </div>

                {error && <div className="px-5 pb-2 text-[12px] text-red-600 dark:text-red-400">❌ {error}</div>}

                <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/10 dark:border-white/10">
                    <button onClick={() => { onClose(); close(); }} className="px-4 h-9 text-[13px] rounded border border-black/15 dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10">{t('misc.cropDialog:huy')}</button>
                    <button onClick={handleApply} disabled={busy || !boxes}
                        className={`px-5 h-9 text-[13px] font-bold rounded text-white ${busy || !boxes ? 'bg-slate-400 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-700'}`}>
                        {busy ? t('misc.cropDialog:dang_xu_ly') : t('misc.cropDialog:ap_dung')}
                    </button>
                </div>
            </div>
        </div>
    );
}

function round4(v: number): number { return Math.round(v * 10000) / 10000; }
