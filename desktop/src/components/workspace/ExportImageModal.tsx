/**
 * ExportImageModal — Xuất trang PDF ra ảnh (PNG/JPEG/TIFF), tương tự Acrobat "Export To > Image".
 *
 * Chọn định dạng, DPI, dải trang, màu (RGB/Gray), thư mục đích → backend render & ghi ra đĩa.
 * Read-only với file gốc (chỉ render). Lưu qua thư mục người dùng chọn (Tauri dialog).
 *
 * EXPORT (audit 2026-07-30 §IMG-04): dùng getWorkingFile (useWorkingPdf) để bake
 * page-order/rotation/delete trước khi gửi backend — xuất đúng trạng thái viewer.
 * EXPORT (audit 2026-07-30 §IMG-06): AbortController hủy job thật, chặn đóng modal
 * khi busy, hiện progress "trang X/N".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { exportImages, uploadPDF } from '../../lib/api';
import { toast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';

interface Props {
    open: boolean;
    onClose: () => void;
    fileId?: string;
    filePath?: string;
    numPages: number;
    currentPage: number;
    baseName?: string;
    /** EXPORT (audit 2026-07-30 §IMG-04): callback từ useWorkingPdf — bake trạng thái viewer. */
    getWorkingFile: () => Promise<File | null>;
    /** EXPORT (audit 2026-07-30 §IMG-07 lô 3): kích thước trang gốc (pt) để ước lượng output. */
    pageWidthPt?: number;
    pageHeightPt?: number;
}

type Fmt = 'png' | 'jpeg' | 'tiff';
type RangeMode = 'all' | 'current' | 'custom';

/** Parse "1-3, 5, 8-10" → [1,2,3,5,8,9,10] (giới hạn trong [1..max], khử trùng, giữ thứ tự). */
export function parsePageRange(input: string, max: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const partRaw of input.split(',')) {
        const part = partRaw.trim();
        if (!part) continue;
        const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
            let a = parseInt(m[1], 10);
            let b = parseInt(m[2], 10);
            if (a > b) [a, b] = [b, a];
            // EXPORT (audit 2026-07-30 §IMG-08): clamp endpoint trước vòng lặp,
            // tránh "1-999999999" khóa WebView.
            a = Math.max(1, a);
            b = Math.min(max, b);
            for (let p = a; p <= b; p++) {
                if (!seen.has(p)) { seen.add(p); out.push(p); }
            }
        } else if (/^\d+$/.test(part)) {
            const p = parseInt(part, 10);
            if (p >= 1 && p <= max && !seen.has(p)) { seen.add(p); out.push(p); }
        }
    }
    return out;
}

const DPI_OPTIONS = [72, 150, 300, 600];

export default function ExportImageModal({ open, onClose, fileId, filePath, numPages, currentPage, baseName, getWorkingFile, pageWidthPt, pageHeightPt }: Props) {
  const { t } = useTranslation();
    const [format, setFormat] = useState<Fmt>('png');
    const [dpi, setDpi] = useState(150);
    const [colorMode, setColorMode] = useState<'rgb' | 'gray' | 'cmyk'>('rgb');
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [customRange, setCustomRange] = useState('');
    const [multipageTiff, setMultipageTiff] = useState(false);
    const [jpegQuality, setJpegQuality] = useState(90);
    const [outputDir, setOutputDir] = useState('');
    const [busy, setBusy] = useState(false);

    // EXPORT (audit 2026-07-30 §IMG-06): progress + cancel
    const [progressText, setProgressText] = useState('');
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            // EXPORT (audit 2026-07-30 §IMG-06): chặn Escape khi đang xuất
            if (e.key === 'Escape' && !busy) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, busy]);

    // Cleanup abort controller khi modal đóng
    useEffect(() => {
        if (!open && abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
    }, [open]);

    const pages = useMemo<number[] | null>(() => {
        if (rangeMode === 'all') return null;
        if (rangeMode === 'current') return [currentPage];
        return parsePageRange(customRange, numPages);
    }, [rangeMode, customRange, currentPage, numPages]);

    const pageCount = rangeMode === 'all' ? numPages : (pages?.length ?? 0);

    // EXPORT (audit 2026-07-30 §IMG-07 lô 3): ước lượng kích thước pixel + dung lượng
    const outputEstimate = useMemo(() => {
        if (!pageWidthPt || !pageHeightPt || pageCount === 0) return null;
        const pw = Math.round(pageWidthPt * dpi / 72);
        const ph = Math.round(pageHeightPt * dpi / 72);
        const channels = colorMode === 'gray' ? 1 : 3;
        const rawPerPage = pw * ph * channels;
        let ratio: number;
        if (format === 'jpeg') ratio = jpegQuality / 300;
        else if (format === 'tiff') ratio = 0.65;
        else ratio = 0.6; // PNG
        const totalBytes = rawPerPage * ratio * pageCount;
        const sizeStr = totalBytes < 1024 * 1024
            ? `${(totalBytes / 1024).toFixed(0)} KB`
            : totalBytes < 1024 * 1024 * 1024
                ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
                : `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        return { pw, ph, sizeStr };
    }, [pageWidthPt, pageHeightPt, dpi, colorMode, format, jpegQuality, pageCount]);

    // EXPORT (audit 2026-07-30 §IMG-06): hủy job đang chạy
    // Hooks phải gọi TRƯỚC mọi early return (rules of hooks).
    const handleCancel = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setBusy(false);
        setProgressText('');
    }, []);

    // EXPORT (audit 2026-07-30 §IMG-06): chặn click nền khi busy
    const handleBackdropClick = useCallback(() => {
        if (!busy) onClose();
    }, [busy, onClose]);

    if (!open) return null;

    const pickFolder = async () => {
        try {
            const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
            const dir = await openDialog({ directory: true, multiple: false, title: t('misc.exportImage:chon_thu_muc_luu_anh') });
            if (typeof dir === 'string') setOutputDir(dir);
        } catch (e) {
            toast.error(t('misc.exportImage:khong_mo_duoc_hop_thoai_chon_thu_muc', { msg: (e as any)?.message || e }));
        }
    };

    const doExport = async () => {
        if (!outputDir) { toast.info(t('misc.exportImage:vui_long_chon_thu_muc_dich')); return; }
        if (rangeMode === 'custom' && (!pages || pages.length === 0)) {
            toast.info(t('misc.exportImage:dai_trang_khong_hop_le_vi_du_1_3_5')); return;
        }
        // EXPORT (audit 2026-07-30 §IMG-06): chặn job trùng
        if (abortRef.current) return;

        setBusy(true);
        setProgressText(t('misc.exportImage:dang_chuan_bi'));
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            // EXPORT (audit 2026-07-30 §IMG-04): bake page-order/rotation/delete
            // theo pattern useWorkingPdf chuẩn dự án trước khi gửi backend render.
            setProgressText(t('misc.exportImage:dang_chuan_bi_trang'));
            let resolvedFileId = fileId;
            let resolvedFilePath = filePath;

            const workingFile = await getWorkingFile();
            if (workingFile && workingFile !== null) {
                // workingFile khác file gốc → có sửa đổi → upload bản bake
                // Kiểm tra abort sau bước tốn thời gian
                if (controller.signal.aborted) return;

                setProgressText(t('misc.exportImage:dang_tai_len_ban_da_chinh'));
                const uploaded = await uploadPDF(workingFile, { signal: controller.signal });
                resolvedFileId = uploaded.id;
                resolvedFilePath = undefined;
            }

            if (controller.signal.aborted) return;

            const total = pageCount;
            setProgressText(t('misc.exportImage:dang_xuat_trang_x_y', { x: 1, y: total }));

            const res = await exportImages({
                fileId: resolvedFileId, filePath: resolvedFilePath, outputDir, format, dpi, colorMode,
                pages, multipageTiff: format === 'tiff' && multipageTiff,
                jpegQuality, baseName,
                signal: controller.signal,
            });
            toast.success(t('misc.exportImage:da_xuat_file_anh_vao', { count: res.count, dir: res.output_dir }));
            onClose();
        } catch (e) {
            if ((e as any)?.name === 'AbortError' || controller.signal.aborted) {
                // Người dùng chủ động hủy → không hiện lỗi
                toast.info(t('misc.exportImage:da_huy_xuat_anh'));
            } else {
                toast.error(t('misc.exportImage:loi_xuat_anh', { msg: (e as any)?.message || e }));
            }
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(false);
            setProgressText('');
        }
    };

    const radioRow = 'flex items-center gap-1.5 cursor-pointer text-sm';

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onMouseDown={handleBackdropClick}>
            <div
                role="dialog" aria-modal="true" aria-label={t('misc.exportImage:xuat_anh')}
                className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-[480px] max-w-[95vw] max-h-[88vh] overflow-hidden flex flex-col border border-black/10 dark:border-white/10"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-white/10">
                    <h2 className="text-[16px] font-bold text-slate-800 dark:text-white">{t('misc.exportImage:xuat_anh')}</h2>
                    <button onClick={busy ? undefined : onClose} disabled={busy} className="text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-30" title={t('misc.exportImage:dong')} aria-label={t('misc.exportImage:dong')}><X className="w-4 h-4" /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
                    {/* Định dạng */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:dinh_dang')}</label>
                        <div className="flex gap-4 mt-1">
                            {(['png', 'jpeg', 'tiff'] as Fmt[]).map(f => (
                                <label key={f} className={`${radioRow} ${f === 'png' && colorMode === 'cmyk' ? 'opacity-40' : ''}`}>
                                    <input type="radio" name="fmt" checked={format === f}
                                        onChange={() => { setFormat(f); if (f === 'png' && colorMode === 'cmyk') setColorMode('rgb'); }}
                                        disabled={busy || (f === 'png' && colorMode === 'cmyk')} />
                                    {f.toUpperCase()}
                                </label>
                            ))}
                        </div>
                        {format === 'jpeg' && (
                            <div className="mt-2 flex items-center gap-2 text-sm">
                                <span className="text-slate-500">{t('misc.exportImage:chat_luong_jpeg')}</span>
                                <input type="range" min={1} max={100} value={jpegQuality} onChange={e => setJpegQuality(parseInt(e.target.value))} className="flex-1" disabled={busy} />
                                <span className="w-8 text-right tabular-nums">{jpegQuality}</span>
                            </div>
                        )}
                        {format === 'tiff' && (
                            <label className="mt-2 flex items-center gap-1.5 text-sm cursor-pointer">
                                <input type="checkbox" checked={multipageTiff} onChange={e => setMultipageTiff(e.target.checked)} disabled={busy} />
                                {t('misc.exportImage:gop_tat_ca_trang_vao_1_file_tiff')}
                            </label>
                        )}
                    </div>

                    {/* DPI */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:do_phan_giai_dpi')}</label>
                        <div className="flex gap-2 mt-1">
                            {DPI_OPTIONS.map(d => (
                                <button key={d} onClick={() => setDpi(d)} disabled={busy}
                                    className={`px-3 h-8 rounded text-sm font-medium border transition-colors ${dpi === d ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 dark:bg-zinc-800 border-slate-300 dark:border-white/15 text-slate-600 dark:text-zinc-300'}`}>
                                    {d}
                                </button>
                            ))}
                            <input type="number" min={36} max={1200} value={dpi}
                                onChange={e => setDpi(Math.max(36, Math.min(1200, parseInt(e.target.value) || 150)))}
                                disabled={busy}
                                className="w-20 h-8 px-2 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm text-right" />
                        </div>
                    </div>

                    {/* Màu */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:mau')}</label>
                        <div className="flex gap-4 mt-1">
                            <label className={radioRow}><input type="radio" name="color" checked={colorMode === 'rgb'} onChange={() => setColorMode('rgb')} disabled={busy} />RGB</label>
                            <label className={radioRow}><input type="radio" name="color" checked={colorMode === 'gray'} onChange={() => setColorMode('gray')} disabled={busy} />Grayscale</label>
                            <label className={radioRow}><input type="radio" name="color" checked={colorMode === 'cmyk'} onChange={() => { setColorMode('cmyk'); if (format === 'png') setFormat('tiff'); }} disabled={busy} />CMYK</label>
                        </div>
                        {colorMode === 'cmyk' && (
                            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                                CMYK dùng PPE ink-space (FOGRA39). PNG không hỗ trợ — chỉ TIFF/JPEG.
                            </p>
                        )}
                    </div>

                    {/* Dải trang */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">Trang</label>
                        <div className="flex gap-4 mt-1">
                            <label className={radioRow}><input type="radio" name="range" checked={rangeMode === 'all'} onChange={() => setRangeMode('all')} disabled={busy} />{t('misc.exportImage:tat_ca_n', { n: numPages })}</label>
                            <label className={radioRow}><input type="radio" name="range" checked={rangeMode === 'current'} onChange={() => setRangeMode('current')} disabled={busy} />{t('misc.exportImage:trang_hien_tai_n', { n: currentPage })}</label>
                            <label className={radioRow}><input type="radio" name="range" checked={rangeMode === 'custom'} onChange={() => setRangeMode('custom')} disabled={busy} />{t('misc.exportImage:tuy_chon')}</label>
                        </div>
                        {rangeMode === 'custom' && (
                            <input value={customRange} onChange={e => setCustomRange(e.target.value)}
                                placeholder={t('misc.exportImage:vi_du_1_3_5_8_10')}
                                disabled={busy}
                                className="mt-2 w-full h-8 px-2 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm" />
                        )}
                    </div>

                    {/* Thư mục đích */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:thu_muc_dich')}</label>
                        <div className="flex gap-2 mt-1">
                            <input readOnly value={outputDir} placeholder={t('misc.exportImage:chua_chon')} className="flex-1 h-9 px-2 border border-slate-300 dark:border-white/20 rounded bg-slate-50 dark:bg-zinc-800 text-sm" />
                            <button onClick={pickFolder} disabled={busy} className="px-3 h-9 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-50">{t('misc.exportImage:chon')}</button>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 dark:border-white/10">
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[12px] text-slate-500 dark:text-zinc-400">
                            {busy && progressText
                                ? progressText
                                : format === 'tiff' && multipageTiff ? t('misc.exportImage:1_file_tiff_n_trang', { n: pageCount }) : t('misc.exportImage:n_file_anh', { n: pageCount })}
                        </span>
                        {!busy && outputEstimate && (
                            <span className="text-[11px] text-slate-400 dark:text-zinc-500 tabular-nums">
                                {outputEstimate.pw}×{outputEstimate.ph} px · ~{outputEstimate.sizeStr}
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        {busy ? (
                            <button onClick={handleCancel} className="px-4 h-9 rounded border border-red-300 dark:border-red-500/40 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20">
                                {t('misc.exportImage:huy_xuat')}
                            </button>
                        ) : (
                            <button onClick={onClose} className="px-4 h-9 rounded border border-slate-300 dark:border-white/20 text-sm">{t('misc.exportImage:huy')}</button>
                        )}
                        <button onClick={doExport} disabled={busy || !outputDir || pageCount === 0}
                            className="px-5 h-9 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold">
                            {busy ? t('misc.exportImage:dang_xuat') : t('misc.exportImage:xuat_anh')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
