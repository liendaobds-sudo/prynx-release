/**
 * ExportImageModal — Xuất trang PDF ra ảnh (PNG/JPEG/TIFF), tương tự Acrobat "Export To > Image".
 *
 * Chọn định dạng, DPI, dải trang, màu (RGB/Gray), thư mục đích → backend render & ghi ra đĩa.
 * Read-only với file gốc (chỉ render). Lưu qua thư mục người dùng chọn (Tauri dialog).
 */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { exportImages } from '../../lib/api';
import { toast } from '../ui/Toast';

interface Props {
    open: boolean;
    onClose: () => void;
    fileId?: string;
    filePath?: string;
    numPages: number;
    currentPage: number;
    baseName?: string;
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
            for (let p = a; p <= b; p++) {
                if (p >= 1 && p <= max && !seen.has(p)) { seen.add(p); out.push(p); }
            }
        } else if (/^\d+$/.test(part)) {
            const p = parseInt(part, 10);
            if (p >= 1 && p <= max && !seen.has(p)) { seen.add(p); out.push(p); }
        }
    }
    return out;
}

const DPI_OPTIONS = [72, 150, 300, 600];

export default function ExportImageModal({ open, onClose, fileId, filePath, numPages, currentPage, baseName }: Props) {
    const [format, setFormat] = useState<Fmt>('png');
    const [dpi, setDpi] = useState(150);
    const [colorMode, setColorMode] = useState<'rgb' | 'gray'>('rgb');
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [customRange, setCustomRange] = useState('');
    const [multipageTiff, setMultipageTiff] = useState(false);
    const [jpegQuality, setJpegQuality] = useState(90);
    const [outputDir, setOutputDir] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const pages = useMemo<number[] | null>(() => {
        if (rangeMode === 'all') return null;
        if (rangeMode === 'current') return [currentPage];
        return parsePageRange(customRange, numPages);
    }, [rangeMode, customRange, currentPage, numPages]);

    const pageCount = rangeMode === 'all' ? numPages : (pages?.length ?? 0);

    if (!open) return null;

    const pickFolder = async () => {
        try {
            const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
            const dir = await openDialog({ directory: true, multiple: false, title: 'Chọn thư mục lưu ảnh' });
            if (typeof dir === 'string') setOutputDir(dir);
        } catch (e) {
            toast.error('Không mở được hộp thoại chọn thư mục: ' + ((e as any)?.message || e));
        }
    };

    const doExport = async () => {
        if (!outputDir) { toast.info('Vui lòng chọn thư mục đích.'); return; }
        if (rangeMode === 'custom' && (!pages || pages.length === 0)) {
            toast.info('Dải trang không hợp lệ. Ví dụ: 1-3, 5'); return;
        }
        setBusy(true);
        try {
            const res = await exportImages({
                fileId, filePath, outputDir, format, dpi, colorMode,
                pages, multipageTiff: format === 'tiff' && multipageTiff,
                jpegQuality, baseName,
            });
            toast.success(`Đã xuất ${res.count} file ảnh vào:\n${res.output_dir}`);
            onClose();
        } catch (e) {
            toast.error('Lỗi xuất ảnh: ' + ((e as any)?.message || e));
        } finally {
            setBusy(false);
        }
    };

    const radioRow = 'flex items-center gap-1.5 cursor-pointer text-sm';

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onMouseDown={onClose}>
            <div
                role="dialog" aria-modal="true" aria-label="Xuất ảnh"
                className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-[480px] max-w-[95vw] max-h-[88vh] overflow-hidden flex flex-col border border-black/10 dark:border-white/10"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-white/10">
                    <h2 className="text-[16px] font-bold text-slate-800 dark:text-white">Xuất ảnh</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-white" title="Đóng" aria-label="Đóng"><X className="w-4 h-4" /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
                    {/* Định dạng */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">Định dạng</label>
                        <div className="flex gap-4 mt-1">
                            {(['png', 'jpeg', 'tiff'] as Fmt[]).map(f => (
                                <label key={f} className={radioRow}>
                                    <input type="radio" name="fmt" checked={format === f} onChange={() => setFormat(f)} />
                                    {f.toUpperCase()}
                                </label>
                            ))}
                        </div>
                        {format === 'jpeg' && (
                            <div className="mt-2 flex items-center gap-2 text-sm">
                                <span className="text-slate-500">Chất lượng JPEG</span>
                                <input type="range" min={1} max={100} value={jpegQuality} onChange={e => setJpegQuality(parseInt(e.target.value))} className="flex-1" />
                                <span className="w-8 text-right tabular-nums">{jpegQuality}</span>
                            </div>
                        )}
                        {format === 'tiff' && (
                            <label className="mt-2 flex items-center gap-1.5 text-sm cursor-pointer">
                                <input type="checkbox" checked={multipageTiff} onChange={e => setMultipageTiff(e.target.checked)} />
                                Gộp tất cả trang vào 1 file TIFF
                            </label>
                        )}
                    </div>

                    {/* DPI */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">Độ phân giải (DPI)</label>
                        <div className="flex gap-2 mt-1">
                            {DPI_OPTIONS.map(d => (
                                <button key={d} onClick={() => setDpi(d)}
                                    className={`px-3 h-8 rounded text-sm font-medium border transition-colors ${dpi === d ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 dark:bg-zinc-800 border-slate-300 dark:border-white/15 text-slate-600 dark:text-zinc-300'}`}>
                                    {d}
                                </button>
                            ))}
                            <input type="number" min={36} max={1200} value={dpi}
                                onChange={e => setDpi(Math.max(36, Math.min(1200, parseInt(e.target.value) || 150)))}
                                className="w-20 h-8 px-2 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm text-right" />
                        </div>
                    </div>

                    {/* Màu */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">Màu</label>
                        <div className="flex gap-4 mt-1">
                            <label className={radioRow}><input type="radio" name="color" checked={colorMode === 'rgb'} onChange={() => setColorMode('rgb')} />RGB</label>
                            <label className={radioRow}><input type="radio" name="color" checked={colorMode === 'gray'} onChange={() => setColorMode('gray')} />Grayscale</label>
                        </div>
                    </div>

                    {/* Dải trang */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">Trang</label>
                        <div className="flex gap-4 mt-1">
                            <label className={radioRow}><input type="radio" name="range" checked={rangeMode === 'all'} onChange={() => setRangeMode('all')} />Tất cả ({numPages})</label>
                            <label className={radioRow}><input type="radio" name="range" checked={rangeMode === 'current'} onChange={() => setRangeMode('current')} />Trang hiện tại ({currentPage})</label>
                            <label className={radioRow}><input type="radio" name="range" checked={rangeMode === 'custom'} onChange={() => setRangeMode('custom')} />Tùy chọn</label>
                        </div>
                        {rangeMode === 'custom' && (
                            <input value={customRange} onChange={e => setCustomRange(e.target.value)}
                                placeholder="Ví dụ: 1-3, 5, 8-10"
                                className="mt-2 w-full h-8 px-2 border border-slate-300 dark:border-white/15 rounded bg-white dark:bg-zinc-800 text-sm" />
                        )}
                    </div>

                    {/* Thư mục đích */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase">Thư mục đích</label>
                        <div className="flex gap-2 mt-1">
                            <input readOnly value={outputDir} placeholder="Chưa chọn..." className="flex-1 h-9 px-2 border border-slate-300 dark:border-white/20 rounded bg-slate-50 dark:bg-zinc-800 text-sm" />
                            <button onClick={pickFolder} className="px-3 h-9 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium">Chọn...</button>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 dark:border-white/10">
                    <span className="text-[12px] text-slate-500 dark:text-zinc-400">
                        {format === 'tiff' && multipageTiff ? `1 file TIFF (${pageCount} trang)` : `${pageCount} file ảnh`}
                    </span>
                    <div className="flex gap-2">
                        <button onClick={onClose} className="px-4 h-9 rounded border border-slate-300 dark:border-white/20 text-sm">Hủy</button>
                        <button onClick={doExport} disabled={busy || !outputDir || pageCount === 0}
                            className="px-5 h-9 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold">
                            {busy ? 'Đang xuất...' : 'Xuất ảnh'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
