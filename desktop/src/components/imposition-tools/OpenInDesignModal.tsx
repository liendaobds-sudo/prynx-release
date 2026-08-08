// OpenInDesignModal.tsx — Mở file kết quả bằng Illustrator/CorelDRAW (spec: thay "gửi máy bế").
//
// Thay cho kênh TCP/serial chưa kiểm chứng: user mở TRANG KHUÔN trong AI/Corel nơi
// PLUGIN MÁY BẾ đã cài sẵn để quét chọn đường cắt + xuất file cắt. Dò .exe qua registry
// (lệnh Rust detect_design_apps); nếu không dò được, user tự trỏ .exe (nhớ localStorage).
//
// Phạm vi mở:
//   - "Chỉ trang khuôn": chọn TỜ nào (mặc định tờ đang xem) hoặc TẤT CẢ. Trích trang
//     kind==='cut' (buildSavePlan) → PDF mới ra temp → mở. Chọn 1 tờ → PDF 1 trang →
//     Illustrator mở THẲNG, không hiện dialog "PDF Import Options" (chọn trang).
//   - "Cả khuôn + in": mở thẳng file kết quả trên đĩa (nhiều trang → có thể qua dialog AI).

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { buildSavePlan, type SaveTypeInfo, type SavePlanConfig } from '../../lib/printFileNaming';
import { fetchLocalFileBuffer } from '../../lib/localFileTransport';
import { useTranslation } from 'react-i18next';

interface Props {
    open: boolean;
    onClose: () => void;
    /** Đường dẫn file kết quả trên đĩa ((file as any).path). */
    resultFilePath?: string;
    /** PDF kết quả (để trích trang khuôn client-side). */
    resultBlob: Blob | null;
    /** Output có cặp [in, bế] mỗi loại không (separateCutPage đã bật khi bình). */
    separateCut: boolean;
    /** Bình Bế Rớt CNC: bố cục bộ 3 trang (Trước/Sau/Khuôn). */
    cncMode?: boolean;
    /** CNC in 2 mặt → 3 trang/đơn vị; tắt → 2 trang/đơn vị. */
    cncTwoSided?: boolean;
    /** Tên file gốc. */
    originalName?: string;
    /** Trang đang xem ở viewer (1-indexed) — dùng để chọn sẵn tờ khuôn tương ứng. */
    currentPage?: number;
}

type Scope = 'cut_only' | 'cut_and_print';

/**
 * FILEIO (audit 2026-08-06): sau khi bình xong theo "đường native", tab chỉ giữ File RỖNG
 * (hoặc sentinel 11 byte 'native-path' từ processHandlers) kèm `.path` — bytes THẬT nằm
 * trên đĩa. Đọc thẳng blob sẽ đưa 11 byte rác cho pdf-lib → "No PDF header found".
 * Ưu tiên đọc từ đĩa qua protocol localfile; chỉ dùng bytes trong RAM khi không có path
 * (web/fallback) hoặc khi đọc đĩa lỗi mà blob có bytes thật.
 */
async function readResultBytes(path: string | undefined, blob: Blob | null): Promise<Uint8Array> {
    const isTauriEnv = typeof window !== 'undefined'
        && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (isTauriEnv && path) {
        try {
            return new Uint8Array(await fetchLocalFileBuffer(path));
        } catch (e) {
            if (!blob || blob.size === 0) throw e;
        }
    }
    if (!blob) throw new Error('missing result bytes');
    return new Uint8Array(await blob.arrayBuffer());
}

interface CustomApps {
    illustrator?: string;
    corel?: string;
}

/** Một trang khuôn: sheetNum = số tờ (1-indexed), pageIndex = chỉ số trang trong PDF kết quả. */
interface CutPage {
    sheetNum: number;
    pageIndex: number;
}

const LS_KEY = 'prynx.designApps.v1';

function loadCustomApps(): CustomApps {
    try {
        return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
        return {};
    }
}
function saveCustomApps(a: CustomApps) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(a));
    } catch {
        /* ignore */
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? '');
}

/** Số trang mỗi đơn vị (tờ) theo chế độ. */
function pagesPerUnit(cncMode?: boolean, cncTwoSided?: boolean, separateCut?: boolean): number {
    if (cncMode) return cncTwoSided ? 3 : 2;
    return separateCut ? 2 : 1;
}

export default function OpenInDesignModal({
    open, onClose, resultFilePath, resultBlob, separateCut, cncMode, cncTwoSided, originalName, currentPage,
}: Props) {
    const { t } = useTranslation();
    const [detected, setDetected] = useState<CustomApps>({});
    const [custom, setCustom] = useState<CustomApps>(loadCustomApps());
    const [detectingApps, setDetectingApps] = useState(false);
    const [detectionFailed, setDetectionFailed] = useState(false);
    const [scope, setScope] = useState<Scope>('cut_only');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    // Danh sách trang khuôn (mỗi tờ 1 mục) — tính từ số trang PDF khi mở.
    const [cutPages, setCutPages] = useState<CutPage[]>([]);
    // Tập tờ khuôn đang chọn (theo pageIndex). Chọn 1 tờ → PDF 1 trang (né dialog AI);
    // chọn nhiều → PDF nhiều trang (AI sẽ hiện dialog chọn trang).
    const [selected, setSelected] = useState<Set<number>>(new Set());
    // Neo cho Shift-chọn dải (pageIndex của lần click gần nhất không giữ Shift).
    const [anchor, setAnchor] = useState<number | null>(null);

    // Dò app khi mở modal.
    useEffect(() => {
        if (!open) return;
        let active = true;
        setStatus('');
        setDetected({});
        setDetectingApps(true);
        setDetectionFailed(false);
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const apps = await invoke<{ illustrator: string | null; corel: string | null }>('detect_design_apps');
                if (!active) return;
                setDetected({ illustrator: apps.illustrator || undefined, corel: apps.corel || undefined });
            } catch {
                if (active) setDetectionFailed(true);
            } finally {
                if (active) setDetectingApps(false);
            }
        })();
        return () => { active = false; };
    }, [open]);

    // Tính danh sách trang khuôn từ PDF kết quả + chọn sẵn tờ chứa trang đang xem.
    useEffect(() => {
        if (!open || (!resultBlob && !resultFilePath)) { setCutPages([]); return; }
        let active = true;
        (async () => {
            try {
                const { PDFDocument } = await import('pdf-lib');
                const doc = await PDFDocument.load(await readResultBytes(resultFilePath, resultBlob));
                const pageCount = doc.getPageCount();
                const per = pagesPerUnit(cncMode, cncTwoSided, separateCut);
                const count = Math.max(1, Math.floor(pageCount / per));
                const types: SaveTypeInfo[] = Array.from({ length: count }, (_, i) => ({
                    label: `Trang ${i + 1}`, sheetCount: 0,
                }));
                const cfg: SavePlanConfig = {
                    nameMode: 'number', folderMode: 'flat', separateCut,
                    includeOrderCode: false, includeDate: false, originalName, cncMode, cncTwoSided,
                };
                const plan = buildSavePlan(types, cfg);
                const pages: CutPage[] = plan
                    .filter(it => it.kind === 'cut' && it.pageIndex < pageCount)
                    .map((it, i) => ({ sheetNum: i + 1, pageIndex: it.pageIndex }));
                if (!active) return;
                setCutPages(pages);
                // Chọn sẵn tờ chứa trang đang xem (viewer 1-indexed → pageIndex 0-indexed).
                const curIdx = (currentPage || 1) - 1;
                const hit = pages.find(p => p.pageIndex === curIdx)
                    // Không trúng đúng trang khuôn (đang xem trang in) → lấy tờ cùng đơn vị.
                    || pages.find(p => Math.floor(p.pageIndex / per) === Math.floor(curIdx / per))
                    || pages[0];
                setSelected(hit ? new Set([hit.pageIndex]) : new Set());
                setAnchor(hit ? hit.pageIndex : null);
            } catch (e) {
                // Không đọc được PDF kết quả → báo ngay thay vì im lặng mất lưới tờ khuôn.
                if (active) {
                    setCutPages([]); setSelected(new Set()); setAnchor(null);
                    setStatus(t('misc.openInDesign:loi_khi_mo', { msg: errorMessage(e) }));
                }
            }
        })();
        return () => { active = false; };
    }, [open, resultBlob, resultFilePath, cncMode, cncTwoSided, separateCut, originalName, currentPage]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const illustratorPath = detected.illustrator || custom.illustrator;
    const corelPath = detected.corel || custom.corel;
    const multiSheet = cutPages.length > 1;
    const allSelected = cutPages.length > 0 && selected.size === cutPages.length;
    const isTauri = typeof window !== 'undefined'
        && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    // Preview 1 trang khuôn qua protocol tile:// (Rust render, nhẹ + có disk cache — như
    // ThumbnailView). page 1-indexed = pageIndex + 1. Không có path trên đĩa → không preview.
    const thumbSrc = (pageIndex: number): string | null => {
        if (!isTauri || !resultFilePath) return null;
        const enc = encodeURIComponent(resultFilePath);
        return `http://tile.localhost/${enc}/${pageIndex + 1}/0.3/0/0/0/0/0`;
    };

    // Click tờ: thường = chọn riêng tờ này; Ctrl/Cmd = bật/tắt; Shift = chọn cả dải từ neo.
    const toggleSheet = (pageIndex: number, mods: { ctrl: boolean; shift: boolean }) => {
        setSelected(prev => {
            if (mods.shift && anchor !== null) {
                const order = cutPages.map(p => p.pageIndex);
                const a = order.indexOf(anchor);
                const b = order.indexOf(pageIndex);
                if (a >= 0 && b >= 0) {
                    const [lo, hi] = a <= b ? [a, b] : [b, a];
                    const next = new Set(mods.ctrl ? prev : []);
                    for (let i = lo; i <= hi; i++) next.add(order[i]);
                    return next;
                }
            }
            if (mods.ctrl) {
                const next = new Set(prev);
                if (next.has(pageIndex)) next.delete(pageIndex); else next.add(pageIndex);
                return next;
            }
            return new Set([pageIndex]);
        });
        if (!mods.shift) setAnchor(pageIndex);
    };

    const pickExe = async (which: 'illustrator' | 'corel') => {
        try {
            const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
            const picked = await openDialog({
                multiple: false,
                title: t('misc.openInDesign:chon_file_exe'),
                filters: [{ name: 'Application', extensions: ['exe'] }],
            });
            if (typeof picked === 'string') {
                const next = { ...custom, [which]: picked };
                setCustom(next);
                saveCustomApps(next);
            }
        } catch (e) {
            setStatus(t('misc.openInDesign:khong_mo_duoc_hop_thoai', { msg: errorMessage(e) }));
        }
    };

    // Trích trang khuôn (theo lựa chọn) ra PDF tạm, trả đường dẫn temp.
    const buildCutOnlyFile = async (): Promise<string> => {
        if (!resultBlob && !resultFilePath) throw new Error(t('misc.openInDesign:khong_co_file_ket_qua'));
        const { PDFDocument } = await import('pdf-lib');
        const {
            beginOptionalContentTransfer,
            finishOptionalContentTransfer,
        } = await import('../../lib/pdfOptionalContent');
        const { invoke } = await import('@tauri-apps/api/core');
        const { tempDir, join } = await import('@tauri-apps/api/path');

        const srcBytes = await readResultBytes(resultFilePath, resultBlob);
        const srcDoc = await PDFDocument.load(srcBytes);
        const pageCount = srcDoc.getPageCount();

        // Trang khuôn cần trích: các tờ đã chọn, theo đúng thứ tự tờ.
        const cutIdxs = cutPages
            .filter(p => selected.has(p.pageIndex) && p.pageIndex < pageCount)
            .map(p => p.pageIndex);
        if (cutIdxs.length === 0) throw new Error(t('misc.openInDesign:khong_tim_thay_trang_khuon'));

        const out = await PDFDocument.create();
        // OCG FIX (audit 2026-08-07 §PONTLAYER.1): `copyPages()` bỏ catalog layer.
        // Giữ cả OCG rỗng vì Graphtec info/layer cha dùng tên làm metadata cho plugin.
        const ocTransfer = beginOptionalContentTransfer(
            [srcDoc],
            { preserveUnreferencedOcgs: true },
        );
        try {
            const copied = await out.copyPages(srcDoc, cutIdxs);
            copied.forEach(p => out.addPage(p));
        } finally {
            finishOptionalContentTransfer(ocTransfer, out);
        }
        const bytes = await out.save();

        const base = (originalName || 'khuon').replace(/\.pdf$/i, '');
        const selSheets = cutPages.filter(p => selected.has(p.pageIndex)).map(p => p.sheetNum);
        const suffix = selSheets.length === cutPages.length
            ? 'tatca'
            : `to${selSheets.join('-')}`;
        const ts = Date.now();
        const dir = await tempDir();
        const full = await join(dir, `prynx_khuon_${base}_${suffix}_${ts}.pdf`);
        await invoke('write_file_atomic', { path: full, contents: bytes });
        return full;
    };

    const doOpen = async (appPath?: string) => {
        if (!appPath) { setStatus(t('misc.openInDesign:chua_co_duong_dan_app')); return; }
        setBusy(true);
        setStatus(t('misc.openInDesign:dang_mo'));
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            let filePath = resultFilePath;
            if (scope === 'cut_only') {
                filePath = await buildCutOnlyFile();
            }
            if (!filePath) throw new Error(t('misc.openInDesign:khong_co_file_ket_qua'));
            await invoke('launch_external_app', { appPath, filePath });
            setStatus(t('misc.openInDesign:da_mo'));
            onClose();
        } catch (e) {
            setStatus(t('misc.openInDesign:loi_khi_mo', { msg: errorMessage(e) }));
        } finally {
            setBusy(false);
        }
    };

    const appRow = (
        label: string,
        path: string | undefined,
        which: 'illustrator' | 'corel',
    ) => {
        const availability = path
            ? path
            : detectingApps
                ? t('misc.openInDesign:dang_tim_ung_dung')
                : t('misc.openInDesign:khong_tim_thay_tren_may');
        return (
            <div className="flex items-center gap-2" data-app={which}>
                <button
                    onClick={() => doOpen(path)}
                    disabled={busy || !path}
                    className="flex-1 flex items-center justify-between px-3 h-11 rounded-lg border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-800 hover:border-indigo-500 disabled:opacity-40 disabled:hover:border-slate-300 text-left"
                >
                    <span className="text-sm font-semibold text-slate-800 dark:text-white">{label}</span>
                    <span className="text-[11px] text-slate-400 truncate max-w-[220px]" title={path}>
                        {availability}
                    </span>
                </button>
                {!detectingApps && <button
                    onClick={() => pickExe(which)}
                    className="px-2.5 h-11 rounded-lg border border-slate-300 dark:border-white/20 text-[11px] text-slate-600 dark:text-zinc-300 hover:border-indigo-500"
                    title={t('misc.openInDesign:chon_file_exe')}
                >
                    {path ? t('misc.openInDesign:chon_lai') : t('misc.openInDesign:chon_thu_cong')}
                </button>}
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div role="dialog" aria-modal="true" aria-label={t('misc.openInDesign:mo_bang_illustrator_corel')} className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-[520px] max-h-[85vh] overflow-hidden flex flex-col border border-black/10 dark:border-white/10">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-white/10">
                    <h2 className="text-[16px] font-bold text-slate-800 dark:text-white">{t('misc.openInDesign:mo_bang_illustrator_corel')}</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-white" title={t('misc.openInDesign:dong')} aria-label={t('misc.openInDesign:dong')}><X className="w-4 h-4" /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
                    {/* Phạm vi mở */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 uppercase">{t('misc.openInDesign:pham_vi')}</label>
                        <div className="flex flex-col gap-1.5 mt-1.5 text-sm">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="radio" name="scope" checked={scope === 'cut_only'} onChange={() => setScope('cut_only')} />
                                {t('misc.openInDesign:chi_trang_khuon')}
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="radio" name="scope" checked={scope === 'cut_and_print'} onChange={() => setScope('cut_and_print')} />
                                {t('misc.openInDesign:ca_khuon_va_in')}
                            </label>
                        </div>
                    </div>

                    {/* Chọn tờ khuôn — lưới thumbnail trực quan (chỉ khi phạm vi = chỉ trang khuôn VÀ nhiều tờ) */}
                    {scope === 'cut_only' && multiSheet && (
                        <div>
                            <div className="flex items-center justify-between">
                                <label className="text-[11px] font-bold text-slate-600 uppercase">{t('misc.openInDesign:chon_to_khuon')}</label>
                                <button
                                    onClick={() => setSelected(allSelected ? new Set() : new Set(cutPages.map(p => p.pageIndex)))}
                                    className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                                >
                                    {allSelected ? t('misc.openInDesign:bo_chon_het') : t('misc.openInDesign:chon_het')}
                                </button>
                            </div>
                            <div className="mt-1.5 grid grid-cols-4 gap-2 max-h-64 overflow-y-auto p-1">
                                {cutPages.map(p => {
                                    const isSel = selected.has(p.pageIndex);
                                    return (
                                        <button
                                            key={p.pageIndex}
                                            onClick={(e) => toggleSheet(p.pageIndex, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                                            title={t('misc.openInDesign:to_so', { n: p.sheetNum })}
                                            className={`group relative flex flex-col items-center rounded-lg border-2 overflow-hidden transition-colors ${isSel ? 'border-indigo-500 ring-2 ring-indigo-500/30' : 'border-slate-200 dark:border-white/10 hover:border-indigo-400'}`}
                                        >
                                            {isSel && (
                                                <span className="absolute top-1 right-1 z-10 w-4 h-4 rounded-full bg-indigo-500 text-white text-[9px] font-bold flex items-center justify-center shadow">✓</span>
                                            )}
                                            <div className="w-full aspect-[3/4] bg-white flex items-center justify-center overflow-hidden">
                                                {thumbSrc(p.pageIndex) ? (
                                                    <img src={thumbSrc(p.pageIndex) || undefined} alt={`Tờ ${p.sheetNum}`} loading="lazy" className="w-full h-full object-contain" />
                                                ) : (
                                                    <span className="text-[10px] text-slate-400">{p.sheetNum}</span>
                                                )}
                                            </div>
                                            <span className={`w-full text-center text-[11px] py-0.5 font-semibold ${isSel ? 'bg-indigo-500 text-white' : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300'}`}>
                                                {t('misc.openInDesign:to_so', { n: p.sheetNum })}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            {selected.size > 1
                                ? <p className="text-[11px] text-amber-500 mt-1">{t('misc.openInDesign:canh_bao_nhieu_to', { n: selected.size })}</p>
                                : selected.size === 1
                                    ? <p className="text-[11px] text-slate-400 mt-1">{t('misc.openInDesign:goi_y_mot_to')}</p>
                                    : <p className="text-[11px] text-slate-400 mt-1">{t('misc.openInDesign:goi_y_ctrl_shift')}</p>}
                        </div>
                    )}

                    {/* Chọn app */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 uppercase">{t('misc.openInDesign:mo_bang')}</label>
                        {detectingApps && (
                            <p className="text-[11px] text-indigo-600 dark:text-indigo-400 mt-1">
                                {t('misc.openInDesign:dang_tim_ung_dung')}
                            </p>
                        )}
                        {!detectingApps && detectionFailed && (
                            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                                {t('misc.openInDesign:khong_the_tu_dong_do')}
                            </p>
                        )}
                        <div className="flex flex-col gap-2 mt-1.5">
                            {appRow('Adobe Illustrator', illustratorPath, 'illustrator')}
                            {appRow('CorelDRAW', corelPath, 'corel')}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-2">{t('misc.openInDesign:goi_y_plugin')}</p>
                    </div>

                    {status && <div className="text-[12px] text-slate-600 dark:text-zinc-300">{status}</div>}
                </div>

                <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-white/10">
                    <button onClick={onClose} className="px-4 h-9 rounded border border-slate-300 dark:border-white/20 text-sm">{t('misc.openInDesign:dong')}</button>
                </div>
            </div>
        </div>
    );
}
