import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

const CONVERSIONS = [
  { id: 'rgb_to_cmyk', icon: '🔵→🟡', label: 'RGB → CMYK', desc: 'Chuyển toàn bộ object RGB sang không gian màu CMYK. Bắt buộc cho in offset truyền thống.' },
  { id: 'gray_to_cmyk', icon: '⬜→🟡', label: 'Grayscale → CMYK K', desc: 'Chuyển Grayscale thành CMYK chỉ dùng kênh K (Black). Tránh lỗi gray build 4 màu gây moire.' },
  { id: 'spot_to_cmyk', icon: '🟣→🟡', label: 'Spot Color → CMYK', desc: 'Chuyển tất cả màu pha (Pantone, HKS, custom spot) sang CMYK tương đương. Cần cho in 4 màu.' },
];

const ICC_PROFILES = [
  { value: 'auto', label: 'Tự động (theo file)', desc: 'Dùng ICC profile đã nhúng trong file' },
  { value: 'fogra39', label: 'FOGRA39 (Coated)', desc: 'Tiêu chuẩn EU cho giấy couché' },
  { value: 'swop', label: 'SWOP v2', desc: 'Tiêu chuẩn Mỹ cho offset sheetfed' },
  { value: 'japan_color', label: 'Japan Color 2001', desc: 'Tiêu chuẩn Nhật Bản' },
];

const RENDERING_INTENTS = [
  { value: 'relative', label: 'Relative Colorimetric', desc: 'Giữ màu gần nhất, phù hợp hầu hết ấn phẩm' },
  { value: 'perceptual', label: 'Perceptual', desc: 'Duy trì mối quan hệ giữa các màu, tốt cho ảnh' },
  { value: 'saturation', label: 'Saturation', desc: 'Ưu tiên độ bão hòa, tốt cho biểu đồ/đồ họa' },
  { value: 'absolute', label: 'Absolute Colorimetric', desc: 'Giữ nguyên giá trị màu tuyệt đối (proofing)' },
];

export default function ConvertColorsTool({ pdfFile, onFileFixed }: Props) {
  const [fileId, setFileId] = useState('');
  const [selectedConversions, setSelectedConversions] = useState<Set<string>>(new Set(['rgb_to_cmyk']));
  const [profile, setProfile] = useState('auto');
  const [intent, setIntent] = useState('relative');
  const [preserveBlack, setPreserveBlack] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [isConversionsOpen, setIsConversionsOpen] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(true);

  useEffect(() => { setFileId(''); setResult(null); setError(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error('Chưa có file PDF');
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile]);

  const toggleConversion = (id: string) => {
    setSelectedConversions(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const run = async () => {
    if (selectedConversions.size === 0) return;
    setRunning(true); setResult(null); setError('');
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-colors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fid,
          conversions: Array.from(selectedConversions),
          icc_profile: profile,
          rendering_intent: intent,
          preserve_black: preserveBlack,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          onFileFixed(await dl.blob(), data.output_filename);
        }
      } else setError(data.error || data.detail || 'Thất bại');
    } catch (e: any) { setError(e.message); }
    setRunning(false);
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">Vui lòng mở file PDF trước</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: CHỌN CHUYỂN ĐỔI ═══ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setIsConversionsOpen(!isConversionsOpen)} className="flex items-center gap-2 group">
            <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
              🎨 CHUYỂN ĐỔI MÀU
            </span>
            <span className={`text-[10px] text-slate-400 transition-transform duration-200 ${isConversionsOpen ? 'rotate-180' : ''}`}>▼</span>
          </button>
          <button onClick={() => {
            if (selectedConversions.size === CONVERSIONS.length) setSelectedConversions(new Set());
            else setSelectedConversions(new Set(CONVERSIONS.map(c => c.id)));
          }} className="text-[11px] font-medium text-blue-500 hover:text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 px-2 py-0.5 rounded transition-colors">
            {selectedConversions.size === CONVERSIONS.length ? 'Bỏ chọn hết' : 'Chọn tất cả'}
          </button>
        </div>

        {isConversionsOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            <div className="space-y-1.5">
              {CONVERSIONS.map((c, i) => {
                const sel = selectedConversions.has(c.id);
                return (
                  <button key={c.id} onClick={() => toggleConversion(c.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="text-sm shrink-0">{c.icon}</span>
                    <span className="truncate flex-1">{c.label}</span>

                    {/* Tooltip */}
                    <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                      onClick={(e) => e.stopPropagation()}>
                      ?
                      <div className="absolute bottom-full mb-2 right-0 w-max max-w-[220px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words">
                        {c.desc}
                        <div className="absolute top-full right-3 w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1" />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ═══ SECTION 2: ICC & RENDERING ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      <div className="space-y-2">
        <button onClick={() => setIsProfileOpen(!isProfileOpen)} className="w-full flex items-center justify-center gap-2 group">
          <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
            🛠️ CẤU HÌNH ICC & RENDERING
          </span>
          <span className={`text-[10px] text-slate-400 transition-transform duration-200 ${isProfileOpen ? 'rotate-180' : ''}`}>▼</span>
        </button>

        {isProfileOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200 space-y-3">
            {/* ICC Profile */}
            <div className="p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">ICC Profile đích</span>
              <div className="grid grid-cols-2 gap-1.5">
                {ICC_PROFILES.map((p, i) => {
                  const sel = profile === p.value;
                  const isLeftCol = i % 2 === 0;
                  return (
                    <button key={p.value} onClick={() => setProfile(p.value)}
                      className={`text-left px-2.5 py-1.5 rounded-lg border text-[11px] transition-all
                        ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                      <span className="block font-medium truncate">{p.label}</span>
                      <span className="text-[8px] text-slate-400 block">{p.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Rendering Intent */}
            <div className="p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">Rendering Intent</span>
              <div className="grid grid-cols-2 gap-1.5">
                {RENDERING_INTENTS.map((ri, i) => {
                  const sel = intent === ri.value;
                  const isLeftCol = i % 2 === 0;
                  return (
                    <button key={ri.value} onClick={() => setIntent(ri.value)}
                      className={`text-left px-2.5 py-1.5 rounded-lg border text-[11px] transition-all
                        ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                      <span className="block font-medium truncate">{ri.label}</span>
                      <span className="text-[8px] text-slate-400 block">{ri.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Options */}
            <button onClick={() => setPreserveBlack(!preserveBlack)}
              className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                ${preserveBlack ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
              <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${preserveBlack ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
                {preserveBlack && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
              </div>
              <span className="flex-1">Giữ nguyên Black tinh (Preserve Pure K)</span>
              <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                onClick={(e) => e.stopPropagation()}>
                ?
                <div className="absolute bottom-full mb-2 right-0 w-max max-w-[220px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words">
                  Khi chuyển RGB→CMYK, giữ nguyên vùng 100%K thay vì build lại từ 4 kênh. Tránh lỗi registration trên text đen.
                  <div className="absolute top-full right-3 w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1" />
                </div>
              </div>
            </button>
          </div>
        )}
      </div>

      {/* ═══ EXECUTE ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      {selectedConversions.size > 0 && (
        <button onClick={run} disabled={running}
          className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
          {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang chuyển đổi...</>) : (<>🚀 Thực thi ({selectedConversions.size})</>)}
        </button>
      )}

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">✅ Thành công!</h4>
          {result.log?.map((l: any, i: number) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">{l.status === 'success' ? '✅' : '❌'} {l.message} ({l.duration_ms}ms)</p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">✅ File đã được cập nhật trên Viewer.</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
