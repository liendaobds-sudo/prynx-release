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
import { exportImagesBatch, uploadPDF } from '../../lib/api';
import { toast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { buildExportJobs, parsePageRange } from './exportImagePlan';
import type {
    ExportImageFormat as Fmt,
    ExportImageSubFolderMode as SubFolderMode,
    ExportPlanJob,
    ScaleRow,
} from './exportImagePlan';

export type { ExportPlanJob, ScaleRow } from './exportImagePlan';

interface Props {
    open: boolean;
    onClose: () => void;
    /** Mục menu Tệp quyết định mở thẳng chế độ thường hay Export for Screens. */
    initialTab?: ExportImageTab;
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

type RangeMode = 'all' | 'current' | 'custom';
export type ExportImageTab = 'export' | 'screens';

const DEFAULT_SCALE_ROW: ScaleRow = { scale: 1, suffix: '', format: 'png' };
const SCALE_OPTIONS = [1, 2, 3, 4];

const DPI_OPTIONS = [72, 150, 300, 600];

// TYPE (audit 2026-08-23 §P2.68): đọc lỗi ngoài boundary mà không lan any.
function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (message) return String(message);
    }
    return error == null ? '' : String(error);
}

function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error
        && (error as { name?: unknown }).name === 'AbortError';
}

export default function ExportImageModal({ open, onClose, initialTab = 'export', fileId, filePath, numPages, currentPage, baseName, getWorkingFile, pageWidthPt, pageHeightPt }: Props) {
  const { t } = useTranslation();
    const [format, setFormat] = useState<Fmt>('png');
    const formatRef = useRef(format);
    formatRef.current = format;
    const [dpi, setDpi] = useState(150);
    const [colorMode, setColorMode] = useState<'rgb' | 'gray' | 'cmyk'>('rgb');
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [customRange, setCustomRange] = useState('');
    const [multipageTiff, setMultipageTiff] = useState(false);
    const [jpegQuality, setJpegQuality] = useState(90);
    const [outputDir, setOutputDir] = useState('');
    const [busy, setBusy] = useState(false);

    // A2: Multi-scale rows (giống Illustrator "+ Add Scale")
    const [scaleRows, setScaleRows] = useState<ScaleRow[]>([]);
    const [multiScaleEnabled, setMultiScaleEnabled] = useState(false);
    // A3: Prefix tùy chỉnh
    const [prefix, setPrefix] = useState(baseName || '');
    // A4: Sub-folder
    const [subFolderMode, setSubFolderMode] = useState<SubFolderMode>('none');
    // Include Bleed (xuất cả vùng tràn lề)
    const [includeBleed, setIncludeBleed] = useState(true);
    // Mở thư mục sau khi xuất
    const [openAfterExport, setOpenAfterExport] = useState(true);
    // Tab: 'export' = đơn giản (1 format), 'screens' = multi-scale (giống Export for Screens)
    const [exportTab, setExportTab] = useState<ExportImageTab>(initialTab);

    // Cập nhật prefix khi baseName thay đổi (mở file mới)
    useEffect(() => { if (baseName) setPrefix(baseName); }, [baseName]);

    useEffect(() => {
        if (!open) return;
        // UIUX (audit 2026-08-01 §EXPORT.MENU): hai mục menu dùng chung modal,
        // nhưng phải mở đúng workflow ngay từ lần render đầu tiên như Illustrator.
        setExportTab(initialTab);
        setMultiScaleEnabled(initialTab === 'screens');
        if (initialTab === 'screens') {
            setScaleRows(rows => rows.length > 0 ? rows : [{ ...DEFAULT_SCALE_ROW, format: formatRef.current }]);
        }
    }, [open, initialTab]);

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
        let jobs: ExportPlanJob[];
        try {
            jobs = buildExportJobs({
                dpi, format, colorMode, multiScaleEnabled, scaleRows, subFolderMode,
            });
        } catch {
            return null;
        }
        const channels = colorMode === 'gray' ? 1 : colorMode === 'cmyk' ? 4 : 3;
        let totalBytes = 0;
        const dimensions = jobs.map(job => {
            const pw = Math.round(pageWidthPt * job.dpi / 72);
            const ph = Math.round(pageHeightPt * job.dpi / 72);
            let ratio: number;
            if (job.format === 'jpeg' || job.format === 'webp') ratio = jpegQuality / 300;
            else if (job.format === 'tiff') ratio = 0.65;
            else ratio = 0.6;
            totalBytes += pw * ph * channels * ratio * pageCount;
            return `${pw}×${ph}`;
        });
        const sizeStr = totalBytes < 1024 * 1024
            ? `${(totalBytes / 1024).toFixed(0)} KB`
            : totalBytes < 1024 * 1024 * 1024
                ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
                : `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        return { dimensions: dimensions.join(' + '), sizeStr };
    }, [pageWidthPt, pageHeightPt, dpi, colorMode, format, jpegQuality, pageCount, multiScaleEnabled, scaleRows, subFolderMode]);

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
        } catch (error: unknown) {
            toast.error(t('misc.exportImage:khong_mo_duoc_hop_thoai_chon_thu_muc', { msg: getErrorMessage(error) }));
        }
    };

    const doExport = async () => {
        if (!outputDir) { toast.info(t('misc.exportImage:vui_long_chon_thu_muc_dich')); return; }
        if (rangeMode === 'custom' && (!pages || pages.length === 0)) {
            toast.info(t('misc.exportImage:dai_trang_khong_hop_le_vi_du_1_3_5')); return;
        }
        // EXPORT (audit 2026-07-30 §IMG-06): chặn job trùng
        if (abortRef.current) return;
        let exportJobs: ExportPlanJob[];
        try {
            exportJobs = buildExportJobs({
                dpi, format, colorMode, multiScaleEnabled, scaleRows, subFolderMode,
            });
        } catch (e) {
            toast.info((e as Error).message);
            return;
        }


        setBusy(true);
        setProgressText(t('misc.exportImage:dang_chuan_bi'));
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            // EXPORT (audit 2026-07-30 §IMG-04): bake page-order/rotation/delete
            setProgressText(t('misc.exportImage:dang_chuan_bi_trang'));
            let resolvedFileId = fileId;
            let resolvedFilePath = filePath;

            const workingFile = await getWorkingFile();
            if (workingFile && workingFile !== null) {
                if (controller.signal.aborted) return;
                setProgressText(t('misc.exportImage:dang_tai_len_ban_da_chinh'));
                const uploaded = await uploadPDF(workingFile, { signal: controller.signal });

                resolvedFileId = uploaded.id;
                resolvedFilePath = undefined;
            }

            if (controller.signal.aborted) return;

            setProgressText(t('misc.exportImage:dang_xuat'));
            const res = await exportImagesBatch({
                fileId: resolvedFileId,
                filePath: resolvedFilePath,
                colorMode,
                pages,
                includeBleed,
                signal: controller.signal,
                jobs: exportJobs.map(job => ({
                    outputDir: job.subDir ? `${outputDir}\\${job.subDir}` : outputDir,
                    format: job.format,
                    dpi: job.dpi,
                    multipageTiff: job.format === 'tiff' && multipageTiff,
                    jpegQuality,
                    baseName: prefix + job.suffix,
                })),
            });
            const totalExported = res.count;

            toast.success(t('misc.exportImage:da_xuat_file_anh_vao', { count: totalExported, dir: outputDir }));
            // Mở thư mục kết quả
            if (openAfterExport && outputDir) {
                try {
                    const { open: shellOpen } = await import('@tauri-apps/plugin-shell');
                    await shellOpen(outputDir);
                } catch { /* không mở được — bỏ qua */ }
            }
            onClose();
        } catch (error: unknown) {
            if (isAbortError(error) || controller.signal.aborted) {
                // Người dùng chủ động hủy → không hiện lỗi
                toast.info(t('misc.exportImage:da_huy_xuat_anh'));
            } else {
                toast.error(t('misc.exportImage:loi_xuat_anh', { msg: getErrorMessage(error) }));
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

                <div className="flex-1 overflow-y-auto flex flex-col">
                    {/* ── Tab bar ── */}
                    <div role="tablist" className="flex border-b border-slate-200 dark:border-white/10 px-5">
                        {(['export', 'screens'] as const).map(tab => (
                            <button key={tab}
                                role="tab" aria-selected={exportTab === tab}
                                onClick={() => {
                                    setExportTab(tab);
                                    if (tab === 'screens') {
                                        setMultiScaleEnabled(true);
                                        if (scaleRows.length === 0) setScaleRows([{ ...DEFAULT_SCALE_ROW, format }]);
                                    } else {
                                        setMultiScaleEnabled(false);
                                    }
                                }}
                                disabled={busy}
                                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                                    exportTab === tab
                                        ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                                        : 'border-transparent text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'
                                }`}>
                                {tab === 'export' ? t('misc.exportImage:tab_xuat_anh') : t('misc.exportImage:tab_xuat_cho_man_hinh')}
                            </button>
                        ))}
                    </div>

                    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">

                    {/* ══════════ Tab 1: Xuất ảnh (đơn giản) ══════════ */}
                    {exportTab === 'export' && (
                    <>
                        {/* Định dạng */}
                        <div>
                            <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:dinh_dang')}</label>
                            <div className="flex gap-4 mt-1">
                                {(['png', 'jpeg', 'webp', 'tiff'] as Fmt[]).map(f => (
                                    <label key={f} className={`${radioRow} ${(f === 'png' || f === 'webp') && colorMode === 'cmyk' ? 'opacity-40' : ''}`}>
                                        <input type="radio" name="fmt" checked={format === f}
                                            onChange={() => { setFormat(f); if ((f === 'png' || f === 'webp') && colorMode === 'cmyk') setColorMode('rgb'); }}
                                            disabled={busy || ((f === 'png' || f === 'webp') && colorMode === 'cmyk')} />
                                        {f.toUpperCase()}
                                    </label>
                                ))}
                            </div>
                            {(format === 'jpeg' || format === 'webp') && (
                                <div className="mt-2 flex items-center gap-2 text-sm">
                                    <span className="text-slate-500">{format === 'jpeg' ? t('misc.exportImage:chat_luong_jpeg') : t('misc.exportImage:chat_luong_webp')}</span>
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
                    </>
                    )}

                    {/* ══════════ Tab 2: Xuất cho màn hình (multi-scale) ══════════ */}
                    {exportTab === 'screens' && (
                    <>
                        {/* Prefix */}
                        <div>
                            <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:tien_to_ten_file')}</label>
                            <input value={prefix} onChange={e => setPrefix(e.target.value)}
                                placeholder={baseName || 'page'}
                                disabled={busy}
                                className="mt-1 w-full h-8 px-2 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm" />
                            <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">{t('misc.exportImage:vi_du_prefix', { prefix: prefix || baseName || 'page' })}</p>
                        </div>

                        {/* Sub-folder */}
                        <div>
                            <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('misc.exportImage:thu_muc_con')}</label>
                            <div className="flex gap-4 mt-1">
                                <label className={radioRow}><input type="radio" name="subfolder" checked={subFolderMode === 'none'} onChange={() => setSubFolderMode('none')} disabled={busy} />{t('misc.exportImage:khong')}</label>
                                <label className={radioRow}><input type="radio" name="subfolder" checked={subFolderMode === 'scale'} onChange={() => setSubFolderMode('scale')} disabled={busy} />{t('misc.exportImage:theo_scale')}</label>
                                <label className={radioRow}><input type="radio" name="subfolder" checked={subFolderMode === 'format'} onChange={() => setSubFolderMode('format')} disabled={busy} />{t('misc.exportImage:theo_format')}</label>
                            </div>
                        </div>

                        {/* Multi-scale table */}
                        <div>
                            <div className="grid grid-cols-[60px_1fr_90px_28px] gap-1.5 text-[10px] text-slate-400 dark:text-zinc-500 uppercase font-bold">
                                <span>Scale</span><span>Suffix</span><span>Format</span><span></span>
                            </div>
                            {scaleRows.map((row, i) => (
                                <div key={i} className="grid grid-cols-[60px_1fr_90px_28px] gap-1.5 items-center mt-1.5">
                                    <select value={row.scale}
                                        onChange={e => {
                                            const next = [...scaleRows];
                                            next[i] = { ...next[i], scale: Number(e.target.value), suffix: next[i].suffix || `@${e.target.value}x` };
                                            setScaleRows(next);
                                        }}
                                        disabled={busy}
                                        className="h-7 px-1 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm">
                                        {SCALE_OPTIONS.map(s => <option key={s} value={s}>{s}×</option>)}
                                    </select>
                                    <input value={row.suffix}
                                        onChange={e => { const next = [...scaleRows]; next[i] = { ...next[i], suffix: e.target.value }; setScaleRows(next); }}
                                        placeholder={`@${row.scale}x`}
                                        disabled={busy}
                                        className="h-7 px-1.5 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm" />
                                    <select value={row.format}
                                        onChange={e => { const next = [...scaleRows]; next[i] = { ...next[i], format: e.target.value as Fmt }; setScaleRows(next); }}
                                        disabled={busy}
                                        className="h-7 px-1 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm">
                                        {(['png', 'jpeg', 'webp', 'tiff'] as Fmt[]).map(f => (
                                            <option key={f} value={f} disabled={colorMode === 'cmyk' && (f === 'png' || f === 'webp')}>{f.toUpperCase()}</option>
                                        ))}
                                    </select>
                                    <button onClick={() => setScaleRows(scaleRows.filter((_, j) => j !== i))} disabled={busy}
                                        className="h-7 w-7 flex items-center justify-center text-slate-400 hover:text-red-500 dark:hover:text-red-400">
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                            <button onClick={() => setScaleRows([...scaleRows, { ...DEFAULT_SCALE_ROW, format }])}
                                disabled={busy || scaleRows.length >= 8}
                                className="flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 disabled:opacity-40 mt-2">
                                <Plus className="w-3.5 h-3.5" /> {t('misc.exportImage:them_kich_thuoc')}
                            </button>
                        </div>
                    </>
                    )}

                    {/* ══════════ Phần chung (cả 2 tab) ══════════ */}

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
                            <label className={radioRow}><input type="radio" name="color" checked={colorMode === 'cmyk'} onChange={() => { setColorMode('cmyk'); if (format === 'png' || format === 'webp') setFormat('tiff'); setScaleRows(rows => rows.map(row => (row.format === 'png' || row.format === 'webp') ? { ...row, format: 'tiff' } : row)); }} disabled={busy} />CMYK</label>
                        </div>
                        {colorMode === 'cmyk' && (
                            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                                CMYK dùng PPE ink-space (FOGRA39). PNG/WebP không hỗ trợ — chỉ TIFF/JPEG.
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

                    {/* Include Bleed + Open after export */}
                    <div className="flex gap-4">
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input type="checkbox" checked={includeBleed} onChange={e => setIncludeBleed(e.target.checked)} disabled={busy} />
                            {t('misc.exportImage:xuat_ca_vung_bleed')}
                        </label>
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input type="checkbox" checked={openAfterExport} onChange={e => setOpenAfterExport(e.target.checked)} disabled={busy} />
                            {t('misc.exportImage:mo_thu_muc_sau_xuat')}
                        </label>
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
                                {outputEstimate.dimensions} px · ~{outputEstimate.sizeStr}
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
