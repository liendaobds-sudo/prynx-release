// @ts-nocheck
/**
 * SavePrintFilesModal — Lưu file in ra ổ cứng (spec: binh-tem-be-report, Yêu cầu 8).
 *
 * - Chọn thư mục (Tauri dialog), ghi thẳng ra đĩa (Tauri fs), KHÔNG đóng tab kết quả.
 * - 3 chế độ đặt tên (report/đánh số/giữ gốc), tách file in/bế, cấu trúc thư mục.
 * - Preview cây thư mục/tên file (WYSIWYG) trước khi ghi.
 */
import React, { useState, useMemo, useEffect } from 'react';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { buildSavePlan, type SaveTypeInfo, type SavePlanConfig } from '../../lib/printFileNaming';

interface Props {
    open: boolean;
    onClose: () => void;
    /** PDF kết quả (nhiều trang). */
    resultBlob: Blob | null;
    /** Danh sách loại tem (label + số tờ). Nếu rỗng, modal tự suy từ số trang PDF. */
    types?: SaveTypeInfo[];
    /** Output có cặp [in, bế] mỗi loại không (separateCutPage đã bật khi bình). */
    separateCut: boolean;
    /** Bình Bế Rớt CNC: bố cục bộ 3 trang (Trước/Sau/Khuôn). */
    cncMode?: boolean;
    /** CNC in 2 mặt → 3 trang/đơn vị; tắt → 2 trang/đơn vị. */
    cncTwoSided?: boolean;
    /** Tên file gốc (cho chế độ "giữ gốc"). */
    originalName?: string;
}

export default function SavePrintFilesModal({ open, onClose, resultBlob, types: typesProp, separateCut, cncMode, cncTwoSided, originalName }: Props) {
    const savePrint = useImposerSettingsStore(s => s.savePrint);
    const setSavePrint = useImposerSettingsStore(s => s.setSavePrint);
    const orderCode = useImposerSettingsStore(s => s.reportOrderCode);
    const labelNameText = useImposerSettingsStore(s => s.reportDisplay?.labelNameText || '');

    const [folder, setFolder] = useState<string>(savePrint.lastFolder || '');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [derivedTypes, setDerivedTypes] = useState<SaveTypeInfo[] | null>(null);

    // Nếu không được truyền types, tự suy từ số trang PDF khi mở.
    useEffect(() => {
        if (!open || (typesProp && typesProp.length) || !resultBlob) return;
        let active = true;
        (async () => {
            try {
                const { PDFDocument } = await import('pdf-lib');
                const doc = await PDFDocument.load(new Uint8Array(await resultBlob.arrayBuffer()));
                const pageCount = doc.getPageCount();
                const pagesPerType = cncMode ? (cncTwoSided ? 3 : 2) : (separateCut ? 2 : 1);
                const count = Math.floor(pageCount / pagesPerType);
                if (!active) return;
                setDerivedTypes(Array.from({ length: Math.max(1, count) }, (_, i) => ({
                    label: labelNameText || `Trang ${i + 1}`,
                    sheetCount: 0,
                })));
            } catch { if (active) setDerivedTypes([{ label: labelNameText || 'Trang 1', sheetCount: 0 }]); }
        })();
        return () => { active = false; };
    }, [open, resultBlob, separateCut, cncMode, cncTwoSided, typesProp, labelNameText]);

    const types: SaveTypeInfo[] = (typesProp && typesProp.length) ? typesProp : (derivedTypes || []);

    const cfg: SavePlanConfig = {
        nameMode: savePrint.nameMode,
        folderMode: savePrint.folderMode,
        separateCut,
        includeOrderCode: savePrint.includeOrderCode,
        includeDate: savePrint.includeDate,
        orderCode,
        originalName,
        cncMode,
        cncTwoSided,
    };

    const plan = useMemo(() => buildSavePlan(types, cfg), [types, savePrint, separateCut, cncMode, cncTwoSided, orderCode, originalName]);

    if (!open) return null;

    const pickFolder = async () => {
        try {
            const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
            const dir = await openDialog({ directory: true, multiple: false, title: 'Chọn thư mục lưu file in' });
            if (typeof dir === 'string') { setFolder(dir); setSavePrint({ lastFolder: dir }); }
        } catch (e) {
            setStatus('Không mở được hộp thoại chọn thư mục: ' + (e as any)?.message);
        }
    };

    const doSave = async () => {
        if (!folder) { setStatus('Vui lòng chọn thư mục đích.'); return; }
        if (!resultBlob) { setStatus('Không có file kết quả.'); return; }
        setBusy(true); setStatus('Đang tách & ghi file...');
        try {
            const { savePrintFilesToFolder, pagesPerTypeFor } = await import('../../lib/savePrintFiles');
            const { ok } = await savePrintFilesToFolder(resultBlob, folder, cfg, {
                types: (typesProp && typesProp.length) ? typesProp : undefined,
                pagesPerType: pagesPerTypeFor({ cncMode, cncTwoSided, separateCut }),
                labelName: labelNameText,
                onProgress: (done, total) => setStatus(`Đã ghi ${done}/${total} file...`),
            });
            setStatus(`✅ Đã lưu ${ok} file vào: ${folder}`);
        } catch (e) {
            setStatus('Lỗi khi lưu: ' + ((e as any)?.message || e));
        } finally {
            setBusy(false);
        }
    };

    // Gom preview theo thư mục
    const tree: Record<string, string[]> = {};
    for (const it of plan) {
        const k = it.folder || '(thư mục gốc)';
        (tree[k] = tree[k] || []).push(it.filename);
    }
    const totalSheets = types.reduce((s, t) => s + (t.sheetCount || 0), 0);

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-[560px] max-h-[85vh] overflow-hidden flex flex-col border border-black/10 dark:border-white/10">
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-white/10">
                    <h2 className="text-[16px] font-bold text-slate-800 dark:text-white">🖨️ Lưu file in</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-white">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
                    {/* Thư mục */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 uppercase">Thư mục đích</label>
                        <div className="flex gap-2 mt-1">
                            <input readOnly value={folder} placeholder="Chưa chọn..." className="flex-1 h-9 px-2 border border-slate-300 dark:border-white/20 rounded bg-slate-50 dark:bg-zinc-800 text-sm" />
                            <button onClick={pickFolder} className="px-3 h-9 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium">Chọn...</button>
                        </div>
                    </div>

                    {/* Đặt tên */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 uppercase">Đặt tên file</label>
                        <div className="flex gap-3 mt-1 text-sm">
                            {[['report', 'Theo report'], ['number', 'Đánh số'], ['original', 'Giữ tên gốc']].map(([v, lbl]) => (
                                <label key={v} className="flex items-center gap-1.5 cursor-pointer">
                                    <input type="radio" name="nameMode" checked={savePrint.nameMode === v} onChange={() => setSavePrint({ nameMode: v as any })} />
                                    {lbl}
                                </label>
                            ))}
                        </div>
                        {savePrint.nameMode === 'report' && (
                            <div className="flex gap-4 mt-2 text-[13px]">
                                <label className="flex items-center gap-1.5"><input type="checkbox" checked={savePrint.includeOrderCode} onChange={e => setSavePrint({ includeOrderCode: e.target.checked })} />Kèm mã ĐH</label>
                                <label className="flex items-center gap-1.5"><input type="checkbox" checked={savePrint.includeDate} onChange={e => setSavePrint({ includeDate: e.target.checked })} />Kèm ngày</label>
                            </div>
                        )}
                    </div>

                    {/* Cấu trúc thư mục */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 uppercase">Sắp xếp thư mục</label>
                        <div className="flex gap-3 mt-1 text-sm">
                            <label className="flex items-center gap-1.5 cursor-pointer" title="Tạo một thư mục mang tên đơn hàng; bên trong chia thư mục con (In / Bế — hoặc Mặt trước / Mặt sau / Khuôn cho CNC)."><input type="radio" name="folderMode" checked={savePrint.folderMode === 'per_order'} onChange={() => setSavePrint({ folderMode: 'per_order' })} />Gom theo đơn hàng</label>
                            <label className="flex items-center gap-1.5 cursor-pointer" title="Tất cả file nằm thẳng trong thư mục đã chọn, không tạo thư mục con."><input type="radio" name="folderMode" checked={savePrint.folderMode === 'flat'} onChange={() => setSavePrint({ folderMode: 'flat' })} />Để chung một chỗ</label>
                        </div>
                        {cncMode && <p className="text-[11px] text-slate-400 mt-1">CNC: mỗi đơn vị tách {cncTwoSided ? 'Mặt trước / Mặt sau / Khuôn' : 'Mặt trước / Khuôn'} ra file riêng.</p>}
                        {!cncMode && separateCut && <p className="text-[11px] text-slate-400 mt-1">File in & file bế sẽ tách riêng (in trang chẵn, bế trang lẻ).</p>}
                        {!cncMode && !separateCut && <p className="text-[11px] text-amber-500 mt-1">Để tách file bế riêng, bật "Tách trang khuôn bế" ở thiết lập bình bài trước khi chạy.</p>}
                    </div>

                    {/* Preview */}
                    <div>
                        <label className="text-[11px] font-bold text-slate-600 uppercase">Xem trước</label>
                        <div className="mt-1 p-3 bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-white/10 rounded-lg text-[12px] font-mono max-h-48 overflow-y-auto">
                            {Object.entries(tree).map(([dir, files]) => (
                                <div key={dir} className="mb-1">
                                    <div className="text-slate-500">📁 {dir}/</div>
                                    {files.map((f, i) => <div key={i} className="pl-4 text-slate-700 dark:text-zinc-300">📄 {f}</div>)}
                                </div>
                            ))}
                            <div className="mt-2 text-slate-500">⇒ {types.length} loại · tổng {totalSheets} tờ · {plan.length} file</div>
                        </div>
                    </div>

                    {status && <div className="text-[12px] text-slate-600 dark:text-zinc-300">{status}</div>}
                </div>

                <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-white/10">
                    <button onClick={onClose} className="px-4 h-9 rounded border border-slate-300 dark:border-white/20 text-sm">Hủy</button>
                    <button onClick={doSave} disabled={busy || !folder} className="px-5 h-9 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold">
                        {busy ? 'Đang lưu...' : 'Lưu tất cả'}
                    </button>
                </div>
            </div>
        </div>
    );
}
