import { useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import { useTranslation } from 'react-i18next';

const I = {
  Scan: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>,
  Light: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/></svg>,
  Standard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>,
  Heavy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>,
};

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

const PRESETS = [
  { key: 'light', icon: I.Light, label: 'Nhẹ', desc: '≤0.05pt → 0.2pt', t: 0.05, r: 0.2 },
  { key: 'standard', icon: I.Standard, label: 'Tiêu chuẩn', desc: '≤0.1pt → 0.25pt', t: 0.1, r: 0.25 },
  { key: 'heavy', icon: I.Heavy, label: 'Mạnh', desc: '≤0.25pt → 0.5pt', t: 0.25, r: 0.5 },
];

export default function HairlinesTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState('');
  const [threshold, setThreshold] = useState(0.1);
  const [replaceWith, setReplaceWith] = useState(0.25);
  const [selectedPreset, setSelectedPreset] = useState('standard');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);

  useEffect(() => { setFileId(''); setResult(null); setError(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.hairlines:chua_co_file_pdf'));
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile]);

  const selectPreset = (key: string) => {
    setSelectedPreset(key);
    const p = PRESETS.find(pr => pr.key === key);
    if (p) { setThreshold(p.t); setReplaceWith(p.r); }
  };

  const run = async () => {
    setRunning(true); setResult(null); setError('');
    try {
      const fid = await ensureUploaded();
      recipeRecorder.noteOperation('hairlines', { threshold_pt: threshold, replace_pt: replaceWith });
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/fix-hairlines`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, threshold_pt: threshold, replace_pt: replaceWith }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          onFileFixed(await dl.blob(), data.output_filename);
        }
      } else { recipeRecorder.discardPending(); setError(data.error || data.detail || t('preprocess.hairlines:that_bai')); }
    } catch (e: any) { recipeRecorder.discardPending(); setError(e.message); }
    setRunning(false);
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">{t('preprocess.hairlines:vui_long_mo_file_pdf_truoc')}</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: CẤU HÌNH ═══ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setIsSettingsOpen(!isSettingsOpen)} className="flex items-center gap-2 group">
            <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
              {t('preprocess.hairlines:cau_hinh_net_manh')}
            </span>
            <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isSettingsOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {isSettingsOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            {/* Presets - grid 2 col like Preflight rules */}
            <div className="grid grid-cols-3 gap-2">
              {PRESETS.map((p) => {
                const sel = selectedPreset === p.key;
                return (
                  <button key={p.key} onClick={() => selectPreset(p.key)}
                    className={`text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex flex-col items-center gap-1
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="text-sm shrink-0">{p.icon}</span>
                    <span className="truncate">{p.label}</span>
                    <span className="text-[9px] text-slate-400 font-mono">{p.desc}</span>
                  </button>
                );
              })}
            </div>

            {/* Fine-tune inputs */}
            <div className="mt-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">{t('preprocess.hairlines:tinh_chinh_thu_cong')}</span>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[9px] text-slate-400 block mb-0.5">{t('preprocess.hairlines:nguong_phat_hien')}</span>
                  <div className="flex items-center gap-1">
                    <input type="number" step="0.01" value={threshold}
                      onChange={e => { setThreshold(Number(e.target.value)); setSelectedPreset(''); }}
                      className="w-full h-7 px-2 text-[11px] text-center bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded focus:outline-none focus:border-indigo-500" />
                    <span className="text-[9px] text-slate-400 shrink-0">pt</span>
                  </div>
                </div>
                <div>
                  <span className="text-[9px] text-slate-400 block mb-0.5">{t('preprocess.hairlines:thay_the_bang')}</span>
                  <div className="flex items-center gap-1">
                    <input type="number" step="0.01" value={replaceWith}
                      onChange={e => { setReplaceWith(Number(e.target.value)); setSelectedPreset(''); }}
                      className="w-full h-7 px-2 text-[11px] text-center bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded focus:outline-none focus:border-indigo-500" />
                    <span className="text-[9px] text-slate-400 shrink-0">pt</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══ SECTION 2: THỰC THI ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      <div>
        <button onClick={run} disabled={running}
          className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
          {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.hairlines:dang_quet_sua')}</>) : (<>{t('preprocess.hairlines:quet_sua_net_manh')}</>)}
        </button>
      </div>

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">{t('preprocess.hairlines:thanh_cong')}</h4>
          {result.log?.map((l: any, i: number) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">✅ {l.message} ({l.duration_ms}ms)</p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.hairlines:file_da_duoc_cap_nhat_tren_viewer')}</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
