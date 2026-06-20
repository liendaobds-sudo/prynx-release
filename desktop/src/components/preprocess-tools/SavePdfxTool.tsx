import { useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

interface CheckItem {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

const STANDARDS = [
  { key: 'x1a' as const, label: 'PDF/X-1a', desc: 'Tương thích cao, CMYK only, flatten transparency. Phù hợp hầu hết nhà in.' },
  { key: 'x4' as const, label: 'PDF/X-4', desc: 'Hiện đại, giữ transparency & ICC profile. Yêu cầu RIP mới.' },
];

const COMPARE = [
  { feat: 'Transparency', x1a: '❌ Flatten', x4: '✅ Giữ nguyên' },
  { feat: 'Hệ màu', x1a: 'CMYK only', x4: 'CMYK+RGB+ICC' },
  { feat: 'Tương thích', x1a: '⭐⭐⭐⭐⭐', x4: '⭐⭐⭐⭐' },
  { feat: 'PDF Version', x1a: '1.3', x4: '1.6' },
];

export default function SavePdfxTool({ pdfFile, onFileFixed }: Props) {
  const [fileId, setFileId] = useState('');
  const [standard, setStandard] = useState<'x1a' | 'x4'>('x4');
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [compliance, setCompliance] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState('');
  const [isStandardOpen, setIsStandardOpen] = useState(true);

  useEffect(() => { setFileId(''); setChecks([]); setCompliance(null); setStatus(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error('Chưa có file PDF');
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile]);

  const checkCompliance = async () => {
    setChecking(true); setStatus(''); setCompliance(null);
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/check-pdfx/${fid}/${standard}`);
      const data = await res.json();
      setCompliance(data);
      setChecks(data.checks || []);
    } catch (e: any) { setStatus(`❌ ${e.message}`); }
    setChecking(false);
  };

  const exportPdfx = async () => {
    setExporting(true); setStatus('');
    try {
      const fid = await ensureUploaded();
      recipeRecorder.noteOperation('pdfx', { standard });
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/export-pdfx`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, standard }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(`✅ Đã xuất ${standard === 'x1a' ? 'PDF/X-1a' : 'PDF/X-4'} thành công`);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          onFileFixed(await dl.blob(), data.output_filename);
        }
      } else { recipeRecorder.discardPending(); setStatus(`❌ ${data.detail || 'Lỗi xuất PDF/X'}`); }
    } catch (e: any) { recipeRecorder.discardPending(); setStatus(`❌ ${e.message}`); }
    setExporting(false);
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">Vui lòng mở file PDF trước</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: CHỌN CHUẨN ═══ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setIsStandardOpen(!isStandardOpen)} className="flex items-center gap-2 group">
            <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
              📄 CHỌN CHUẨN PDF/X
            </span>
            <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isStandardOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {isStandardOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            {/* Standard selector - grid 2 col like Preflight rules */}
            <div className="grid grid-cols-2 gap-2">
              {STANDARDS.map((s, i) => {
                const sel = standard === s.key;
                const isLeftCol = i % 2 === 0;
                return (
                  <button key={s.key} onClick={() => { setStandard(s.key); setCompliance(null); setChecks([]); }}
                    className={`text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="truncate flex-1 font-bold">{s.label}</span>
                    {/* Tooltip */}
                    <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                      onClick={(e) => e.stopPropagation()}>
                      ?
                      <div className={`absolute bottom-full mb-2 w-max max-w-[220px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words
                        ${isLeftCol ? 'left-1/2 -translate-x-[20%]' : 'right-1/2 translate-x-[20%]'}`}>
                        {s.desc}
                        <div className={`absolute top-full w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1
                          ${isLeftCol ? 'left-[20%] -translate-x-1/2' : 'right-[20%] translate-x-1/2'}`} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Comparison Table */}
            <div className="mt-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">So sánh chuẩn</span>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-100 dark:border-white/5">
                    <th className="text-left font-medium pb-1.5 pr-2">Tính năng</th>
                    <th className="text-center font-medium pb-1.5 px-2">X-1a</th>
                    <th className="text-center font-medium pb-1.5 pl-2">X-4</th>
                  </tr>
                </thead>
                <tbody className="text-slate-600 dark:text-zinc-300">
                  {COMPARE.map(row => (
                    <tr key={row.feat} className="border-b border-slate-50 dark:border-white/5 last:border-0">
                      <td className="py-1 pr-2 font-medium">{row.feat}</td>
                      <td className="py-1 px-2 text-center">{row.x1a}</td>
                      <td className="py-1 pl-2 text-center">{row.x4}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Check Compliance Button */}
            <div style={{ marginTop: '12px' }} className="flex gap-2">
              <button onClick={checkCompliance} disabled={checking}
                className="flex-1 px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
                {checking ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang kiểm tra...</>) : (<>🔍 Kiểm tra Compliance</>)}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══ COMPLIANCE REPORT ═══ */}
      {checks.length > 0 && (
        <div className="space-y-2" style={{ paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
          <label className="text-[10px] font-bold text-slate-500 uppercase">Kết quả kiểm tra</label>
          <div className="space-y-1">
            {checks.map((c) => (
              <div key={c.id} className={`p-2 rounded border-l-2 flex flex-col gap-1 ${
                c.passed ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-800 dark:text-emerald-200'
                : 'border-red-500 bg-red-50 dark:bg-red-900/10 text-red-800 dark:text-red-200'
              }`}>
                <div className="flex items-center justify-between font-bold text-[11px]">
                  <span>{c.passed ? '✅' : '❌'} {c.label}</span>
                </div>
                <span className="text-[10px] opacity-90 leading-snug">{c.detail}</span>
              </div>
            ))}
          </div>

          {compliance && (
            <div className={`text-center py-2 text-[12px] font-bold ${compliance.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
              {compliance.passed
                ? `✅ File đạt chuẩn ${compliance.standard_label}!`
                : `⚠️ ${compliance.passed_checks}/${compliance.total_checks} đạt — Xuất PDF/X sẽ tự động sửa`
              }
            </div>
          )}
        </div>
      )}

      {/* ═══ SECTION 2: XUẤT FILE ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      <button onClick={exportPdfx} disabled={exporting}
        className="w-full px-2.5 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-teal-700">
        {exporting ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang xuất...</>) : (<>🚀 Xuất {standard === 'x1a' ? 'PDF/X-1a' : 'PDF/X-4'}</>)}
      </button>

      {/* ═══ STATUS ═══ */}
      {status && (
        <div className={`p-3 rounded-lg border ${status.startsWith('✅') ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <h4 className={`text-[11px] font-bold ${status.startsWith('✅') ? 'text-emerald-600' : 'text-red-600'}`}>{status}</h4>
          {status.startsWith('✅') && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">✅ File đã được cập nhật trên Viewer.</p>}
        </div>
      )}
    </div>
  );
}
