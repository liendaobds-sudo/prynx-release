import React, { useState, useMemo, useRef, useEffect } from 'react';
import { startVdpJobBackend, pollVdpJob } from '@/lib/api';
import { startVdpDrag } from '../../utils/vdpDrag';
import { useVdpTool } from '@/hooks/useVdpTool';
import {
    deriveJob, generateCoverData, type NumberingJob,
    type InnerMode, type Distribution, type SortMethod,
} from '@/lib/coverNumberingEngine';
import { planCoverLayout, resolveCoverPageIndices, type Cluster } from '@/lib/coverNumberingPlanner';
import { useNumberingJobStore, DEFAULT_SHARED_JOB, type SharedJob } from '@/stores/useNumberingJobStore';
import { useTranslation } from 'react-i18next';

interface Props {
    pdfFile: File | null;
    getWorkingFile?: () => Promise<File>;
    vdpFields?: any[];
    setVdpFields?: React.Dispatch<React.SetStateAction<any[]>>;
    selectedFieldIds?: string[];
    onSelectField?: (ids: string[]) => void;
    onBack?: () => void;
    onSpawnTab?: (blob: Blob, name: string, path?: string) => void;
    onApplyResult?: (blob: Blob, name: string, path?: string) => void;
    isActive?: boolean;
}

const SORT_LABELS: Record<SortMethod, string> = {
    rows: 'Theo hàng (Z)',
    cols: 'Theo cột (N ngược)',
    snake: 'Rắn bò (U)',
    clockwise: 'Theo cạnh (C ngược)',
};

/** Token role của field bìa: {X}/{Y}/{Z}. Suy từ textContent. */
function fieldRole(f: any): 'X' | 'Y' | 'Z' | null {
    const t = (f?.textContent || '').toUpperCase();
    if (t.indexOf('{X}') >= 0) return 'X';
    if (t.indexOf('{Y}') >= 0) return 'Y';
    if (t.indexOf('{Z}') >= 0) return 'Z';
    return null;
}

export default function CoverNumberingTool({
    pdfFile, getWorkingFile, vdpFields = [], setVdpFields,
    selectedFieldIds = [], onSelectField, onBack, onSpawnTab, onApplyResult, isActive = true,
}: Props) {
  const { t } = useTranslation();
    // PA1: job dùng chung xuyên-tab. Khi "linked", ruột & bìa đọc/ghi cùng nguồn → khớp dải.
    const { linked, setLinked, job: sharedJob, setJob: setSharedJob } = useNumberingJobStore();
    const [localJob, setLocalJob] = useState<SharedJob>({ ...DEFAULT_SHARED_JOB });
    const v = linked ? sharedJob : localJob;
    const setV = (patch: Partial<SharedJob>) =>
        linked ? setSharedJob(patch) : setLocalJob(s => ({ ...s, ...patch }));

    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [spawnNewTab, setSpawnNewTab] = useState(true);

    // PA2: 1 file chứa cả bìa & ruột → người dùng GÁN dải trang bìa (không auto-detect).
    const [singleFileMode, setSingleFileMode] = useState(false);
    const [coverPagesStr, setCoverPagesStr] = useState('1');
    const [totalPages, setTotalPages] = useState(0);

    const pollAbortRef = useRef<AbortController | null>(null);
    useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

    // Đọc số trang của file gốc (cho PA2) — load nhẹ bằng pdf-lib, bỏ qua nếu lỗi.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!pdfFile) { setTotalPages(0); return; }
            try {
                const { PDFDocument } = await import('pdf-lib');
                const bytes = new Uint8Array(await pdfFile.arrayBuffer());
                const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
                if (!cancelled) setTotalPages(doc.getPageCount());
            } catch { if (!cancelled) setTotalPages(0); }
        })();
        return () => { cancelled = true; };
    }, [pdfFile]);

    const coverPageIdx = useMemo(
        () => resolveCoverPageIndices(coverPagesStr, totalPages),
        [coverPagesStr, totalPages],
    );

    const { handleGroupFields, handleUngroupFields, deleteSelectedField } =
        useVdpTool(vdpFields, setVdpFields as any, selectedFieldIds, onSelectField, isActive);

    const job: NumberingJob = useMemo(() => ({ ...v }), [v]);

    const derived = useMemo(() => deriveJob(job), [job]);
    const preview = useMemo(() => (derived.valid ? generateCoverData(job) : []), [job, derived.valid]);

    // Gom field thành cụm theo groupId (mỗi cụm = 1 bìa với role X/Y/Z).
    const clusters: Cluster[] = useMemo(() => {
        const groups = new Map<string, any[]>();
        for (const f of vdpFields) {
            const gid = f.groupId || f.id;
            if (!groups.has(gid)) groups.set(gid, []);
            groups.get(gid)!.push(f);
        }
        return [...groups.entries()].map(([id, fs]) => {
            const x = Math.min(...fs.map(f => f.x ?? f.position?.x ?? 0));
            const y = Math.min(...fs.map(f => f.y ?? f.position?.y ?? 0));
            return { id, x, y };
        });
    }, [vdpFields]);

    const validationMsg = useMemo(() => {
        if (derived.error === 'bad_range') return t('preprocess.coverNumbering:dai_so_hoac_so_cuon_khong_hop_le');
        if (derived.error === 'too_large') return t('preprocess.coverNumbering:dai_so_qua_lon_vuot_gioi_han_an_toan');
        if (derived.error === 'not_divisible')
            return `⚠️ ${derived.totalNumbers} số không chia hết cho ${v.bookletCount} cuốn. ` +
                `Gợi ý: dùng ${derived.suggestion} cuốn (chia hết).`;
        const first = preview[0], last = preview[preview.length - 1];
        return `✅ ${derived.totalNumbers} số ÷ ${v.bookletCount} cuốn = ${derived.perBooklet} liên/cuốn.` +
            (first && last ? ` Cuốn 1: ${first.Y}–${first.Z} · Cuốn ${v.bookletCount}: ${last.Y}–${last.Z}.` : '');
    }, [derived, preview, v.bookletCount]);

    const handleGenerate = async () => {
        try {
            if (!derived.valid) throw new Error(t('preprocess.coverNumbering:cau_hinh_chua_hop_le_xem_canh_bao'));
            if (clusters.length === 0) throw new Error(t('preprocess.coverNumbering:hay_keo_it_nhat_1_cum_bia_x_y_z_vao_pdf'));
            if (!pdfFile) throw new Error(t('preprocess.coverNumbering:chua_co_file_pdf_goc'));
            setBusy(true);
            setStatus(t('preprocess.coverNumbering:dang_tinh_ke_hoach_danh_so_bia'));

            const plan = planCoverLayout(job, clusters);

            // Backend VDP (vdp_engine.py) trộn dữ liệu bằng cách thay TOKEN `{key}` bên trong
            // `textContent` của field — KHÔNG theo field.name độc lập. Mọi chip {X} kéo ra đều
            // có textContent giống hệt `{X}`, nên nếu giữ nguyên thì tất cả các cụm trên cùng 1
            // tờ sẽ nhận CÙNG một giá trị. → Clone field, cấp TOKEN DUY NHẤT cho từng (cụm, vai
            // trò) rồi key record theo đúng token đó.
            const cloned = vdpFields.map(f => ({ ...f }));
            const roleOf = new Map<string, 'X' | 'Y' | 'Z'>();
            const fieldsByGroup = new Map<string, any[]>();
            for (const f of cloned) {
                const gid = f.groupId || f.id;
                if (!fieldsByGroup.has(gid)) fieldsByGroup.set(gid, []);
                fieldsByGroup.get(gid)!.push(f);
                const role = fieldRole(f); // suy vai trò TỪ textContent gốc ({X}/{Y}/{Z})
                if (role) {
                    roleOf.set(f.id, role);
                    const token = `cov_${gid}_${role}`;
                    f.name = token;
                    f.textContent = `{${token}}`; // token duy nhất → mỗi cụm 1 giá trị riêng
                }
            }

            // 1 tờ in = 1 record; điền field theo role X/Y/Z trong từng cụm.
            const bySheet = new Map<number, Record<string, string>>();
            for (const it of plan) {
                let row = bySheet.get(it.sheet);
                if (!row) { row = {}; bySheet.set(it.sheet, row); }
                const fields = fieldsByGroup.get(it.clusterId) || [];
                for (const f of fields) {
                    const role = roleOf.get(f.id);
                    if (!role) continue;
                    row[f.name] = it.cover ? it.cover[role] : '';
                }
            }
            const csvData = [...bySheet.keys()].sort((a, b) => a - b).map(k => bySheet.get(k)!);

            if (roleOf.size === 0) throw new Error(t('preprocess.coverNumbering:chua_co_truong_x_y_z_nao_hay_keo_cac'));

            // Template VDP: engine áp DỤNG MỌI field cho TỪNG trang template (cycle theo
            // global_idx % template_page_count). Nên template phải là ĐÚNG (các) tờ bìa.
            // PA2: trích riêng trang bìa người dùng gán ra khỏi file chung trước khi render.
            let template = getWorkingFile ? await getWorkingFile() : pdfFile;
            if (singleFileMode) {
                if (coverPageIdx.length === 0)
                    throw new Error(t('preprocess.coverNumbering:dai_trang_bia_khong_hop_le_nhap_so'));
                setStatus(t('preprocess.coverNumbering:dang_trich_trang_bia_khoi_file'));
                const { PDFDocument } = await import('pdf-lib');
                const srcBytes = new Uint8Array(await template.arrayBuffer());
                const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
                const out = await PDFDocument.create();
                const copied = await out.copyPages(src, coverPageIdx);
                copied.forEach(p => out.addPage(p));
                const outBytes = await out.save();
                template = new File([outBytes as any], `cover_${pdfFile.name}`, { type: 'application/pdf' });
            }

            setStatus(`Đang đẩy lên máy chủ (${csvData.length} tờ in)...`);
            const jobId = await startVdpJobBackend(template, cloned, csvData);
            pollAbortRef.current = new AbortController();
            const result = await pollVdpJob(jobId, setStatus, true, pollAbortRef.current.signal);
            if (!result.blob) throw new Error(t('preprocess.coverNumbering:khong_nhan_duoc_file_ket_qua'));
            const outName = `MecBia_${pdfFile.name}`;
            if (spawnNewTab && onSpawnTab) { onSpawnTab(result.blob, outName, result.path ?? undefined); setStatus(t('preprocess.coverNumbering:hoan_thanh_da_tao_tab_moi')); }
            else if (onApplyResult) { onApplyResult(result.blob, outName, result.path ?? undefined); setStatus(t('preprocess.coverNumbering:hoan_thanh')); }
        } catch (e: any) {
            setStatus('Lỗi: ' + (e?.message || String(e)));
        } finally {
            setBusy(false);
        }
    };

    const numInput = (val: number, set: (n: number) => void, min?: number) => (
        <input type="number" min={min} value={val}
            onChange={e => set(Number(e.target.value))}
            className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
    );

    return (
        <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 p-4 gap-4 overflow-y-auto scroller-thin">
            <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-zinc-700 shrink-0">
                <button onClick={onBack} className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-md text-slate-500" title={t('preprocess.coverNumbering:quay_lai')}>
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                </button>
                <div className="flex-1 text-center pr-8">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2"><span>🔖</span><span>{t('preprocess.coverNumbering:mec_bia_chay_so_bia')}</span></h2>
                    <p className="text-[11px] text-slate-500 mt-1">Booklet Cover Numbering</p>
                </div>
            </div>

            {/* Cấu hình Job */}
            <div className="shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('preprocess.coverNumbering:1_cau_hinh_bia')}</span>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-zinc-300 cursor-pointer" title={t('preprocess.coverNumbering:dung_chung_dai_so_voi_mec_so_ruot_hai')}>
                        <input type="checkbox" checked={linked} onChange={e => setLinked(e.target.checked)} />
                        {t('preprocess.coverNumbering:lien_ket_mec_so')}
                    </label>
                </div>
                <div className="p-3 border border-slate-200 dark:border-zinc-700 rounded-lg space-y-3 bg-slate-50/50 dark:bg-zinc-800/20">
                    <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">Số ruột bắt đầu{numInput(v.startNum, n => setV({ startNum: n }))}</label>
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">Số ruột kết thúc{numInput(v.endNum, n => setV({ endNum: n }))}</label>
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">Tổng số cuốn{numInput(v.bookletCount, n => setV({ bookletCount: n }), 1)}</label>
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">Số cuốn bắt đầu (→{'{X}'}){numInput(v.bookletOffset, n => setV({ bookletOffset: n }))}</label>
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">Đệm 0 (độ dài){numInput(v.padding, n => setV({ padding: n }), 0)}</label>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">{t('preprocess.coverNumbering:kieu_danh_ruot')}
                            <select value={v.innerMode} onChange={e => setV({ innerMode: e.target.value as InnerMode })} className="h-8 px-1 text-xs border border-slate-300 dark:border-zinc-600 rounded">
                                <option value="continuous">{t('preprocess.coverNumbering:lien_tuc')}</option>
                                <option value="reset">{t('preprocess.coverNumbering:reset_moi_cuon')}</option>
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">{t('preprocess.coverNumbering:che_do_chay')}
                            <select value={v.distribution} onChange={e => setV({ distribution: e.target.value as Distribution })} className="h-8 px-1 text-xs border border-slate-300 dark:border-zinc-600 rounded">
                                <option value="stack">{t('preprocess.coverNumbering:cat_chong')}</option>
                                <option value="sequential">{t('preprocess.coverNumbering:tuan_tu')}</option>
                            </select>
                        </label>
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">{t('preprocess.coverNumbering:kieu_xep')}
                            <select value={v.sortMethod} onChange={e => setV({ sortMethod: e.target.value as SortMethod })} className="h-8 px-1 text-xs border border-slate-300 dark:border-zinc-600 rounded">
                                {(Object.keys(SORT_LABELS) as SortMethod[]).map(m => <option key={m} value={m}>{SORT_LABELS[m]}</option>)}
                            </select>
                        </label>
                    </div>
                    <div className={`text-[11px] p-2 rounded ${derived.valid ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>
                        {validationMsg}
                    </div>
                </div>
            </div>

            {/* Kéo cụm field */}
            <div className="shrink-0 space-y-2">
                <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('preprocess.coverNumbering:2_keo_truong_vao_mau_bia')}</span>
                <p className="text-[11px] text-slate-500">{t('preprocess.coverNumbering:keo_3_truong_vao_moi_o_bia_roi_group')}</p>
                <div className="grid grid-cols-3 gap-2">
                    <div onPointerDown={e => startVdpDrag(e, 'text', t('preprocess.coverNumbering:x_so_cuon'), '{X}')} className="bg-indigo-50 border-2 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-800 p-2 rounded cursor-grab text-center text-xs font-bold text-indigo-700 dark:text-indigo-300">{'{X}'} Số cuốn</div>
                    <div onPointerDown={e => startVdpDrag(e, 'text', t('preprocess.coverNumbering:y_ruot_dau'), '{Y}')} className="bg-sky-50 border-2 border-sky-200 dark:bg-sky-900/20 dark:border-sky-800 p-2 rounded cursor-grab text-center text-xs font-bold text-sky-700 dark:text-sky-300">{'{Y}'} Ruột đầu</div>
                    <div onPointerDown={e => startVdpDrag(e, 'text', t('preprocess.coverNumbering:z_ruot_cuoi'), '{Z}')} className="bg-rose-50 border-2 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800 p-2 rounded cursor-grab text-center text-xs font-bold text-rose-700 dark:text-rose-300">{'{Z}'} Ruột cuối</div>
                </div>
                <div className="flex gap-2 items-center text-[11px]">
                    <span className="text-slate-500">{clusters.length} cụm · {vdpFields.length} trường</span>
                    {selectedFieldIds.length > 1 && <button onClick={handleGroupFields} className="bg-slate-100 dark:bg-zinc-800 px-2 py-1 rounded font-medium">Group</button>}
                    {selectedFieldIds.length > 0 && <button onClick={handleUngroupFields} className="bg-slate-100 dark:bg-zinc-800 px-2 py-1 rounded text-red-500 font-medium">Ungroup</button>}
                    {selectedFieldIds.length > 0 && <button onClick={deleteSelectedField} className="text-red-500 px-2 py-1 rounded bg-red-50 dark:bg-red-500/10">{t('preprocess.coverNumbering:xoa')}</button>}
                </div>
            </div>

            {/* Nguồn bìa (PA2: 1 file gán trang) */}
            <div className="shrink-0 space-y-2">
                <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('preprocess.coverNumbering:3_nguon_trang_bia')}</span>
                <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-300 cursor-pointer">
                    <input type="checkbox" checked={singleFileMode} onChange={e => setSingleFileMode(e.target.checked)} />
                    {t('preprocess.coverNumbering:bia_ruot_nam_chung_1_file_gan_trang_bia')}
                </label>
                {singleFileMode && (
                    <div className="p-2 border border-slate-200 dark:border-zinc-700 rounded-lg space-y-1 bg-slate-50/50 dark:bg-zinc-800/20">
                        <label className="flex flex-col gap-1 text-[10px] font-medium text-slate-500">
                            Trang bìa (tờ đã bình){' '}
                            <input type="text" value={coverPagesStr} onChange={e => setCoverPagesStr(e.target.value)}
                                placeholder={t('preprocess.coverNumbering:vd_1_hoac_1_2')}
                                className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </label>
                        <p className={`text-[10px] ${coverPageIdx.length ? 'text-slate-500' : 'text-amber-600 dark:text-amber-400'}`}>
                            {totalPages > 0 ? `File có ${totalPages} trang. ` : ''}
                            {coverPageIdx.length
                                ? `Sẽ dùng ${coverPageIdx.length} trang bìa: ${coverPageIdx.map(i => i + 1).join(', ')}. Trang còn lại là ruột (dùng Mẹc Số).`
                                : t('preprocess.coverNumbering:chua_chon_trang_bia_hop_le')}
                        </p>
                    </div>
                )}
            </div>

            <div className="mt-auto shrink-0 space-y-2">
                <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-300">
                    <input type="checkbox" checked={spawnNewTab} onChange={e => setSpawnNewTab(e.target.checked)} /> {t('preprocess.coverNumbering:mo_ket_qua_o_tab_moi')}
                </label>
                <button onClick={handleGenerate} disabled={busy || !derived.valid || clusters.length === 0 || (singleFileMode && coverPageIdx.length === 0)}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold rounded-lg">
                    {busy ? t('preprocess.coverNumbering:dang_xu_ly') : `Tạo bìa (${derived.valid ? v.bookletCount : 0} cuốn)`}
                </button>
                {status && <p className="text-[11px] text-slate-500 text-center">{status}</p>}
            </div>
        </div>
    );
}
