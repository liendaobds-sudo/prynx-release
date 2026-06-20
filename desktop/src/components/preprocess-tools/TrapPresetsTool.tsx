import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import { 
    ToolSectionLabel, ToolDivider, ToolCardOption, 
    ToolCheckboxOption, ToolNumberInput, ToolWarning 
} from './ToolUI';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

const PRESETS = [
  { key: 'default', label: 'Mặc định', desc: 'Trap 0.25pt / Black 0.5pt', trap: 0.25, black: 0.5 },
  { key: 'heavy', label: 'Mạnh', desc: 'Trap 0.5pt / Black 1.0pt', trap: 0.5, black: 1.0 },
  { key: 'none', label: 'Chỉ Overprint', desc: 'Không trap, chỉ OPM', trap: 0, black: 0 },
];

const OPTIONS = [
  { key: 'overprint_black', label: 'Overprint text đen (K>95%)', desc: 'Set overprint cho toàn bộ text và nét vector đen. Tránh lỗi knockout gây viền trắng quanh chữ đen trên nền màu.' },
  { key: 'preserve_overprint', label: 'Giữ overprint hiện có', desc: 'Không ghi đè các thiết lập overprint đã có sẵn trong file gốc. Chỉ bổ sung cho các object chưa set.' },
];

export default function TrapPresetsTool({ pdfFile, onFileFixed }: Props) {
  const [fileId, setFileId] = useState('');
  const [preset, setPreset] = useState('default');
  const [trapWidth, setTrapWidth] = useState(0.25);
  const [blackTrapWidth, setBlackTrapWidth] = useState(0.5);
  const [overprintBlack, setOverprintBlack] = useState(true);
  const [preserveOverprint, setPreserveOverprint] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => { setFileId(''); setStatus(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error('Chưa có file PDF');
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile]);

  const selectPreset = (key: string) => {
    setPreset(key);
    const p = PRESETS.find(pr => pr.key === key);
    if (p) { setTrapWidth(p.trap); setBlackTrapWidth(p.black); }
  };

  const apply = async () => {
    setRunning(true); setStatus('');
    try {
      const fid = await ensureUploaded();
      recipeRecorder.noteOperation('trapping', {
        action_id: 'SET_BLACK_OVERPRINT',
        params: { trap_width: trapWidth, black_trap_width: blackTrapWidth, overprint_black: overprintBlack, preserve_overprint: preserveOverprint },
      });
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/set-overprint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: fid, action_id: 'SET_BLACK_OVERPRINT',
          params: { trap_width: trapWidth, black_trap_width: blackTrapWidth, overprint_black: overprintBlack, preserve_overprint: preserveOverprint },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('✅ Đã áp dụng Overprint/Trapping');
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          onFileFixed(await dl.blob(), data.output_filename);
        }
      } else { recipeRecorder.discardPending(); setStatus(`❌ ${data.error || 'Lỗi'}`); }
    } catch (e: any) { recipeRecorder.discardPending(); setStatus(`❌ ${e.message}`); }
    setRunning(false);
  };

  const toggleOpt = (key: string) => {
    if (key === 'overprint_black') setOverprintBlack(!overprintBlack);
    if (key === 'preserve_overprint') setPreserveOverprint(!preserveOverprint);
  };
  const getOpt = (key: string) => key === 'overprint_black' ? overprintBlack : preserveOverprint;

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">Vui lòng mở file PDF trước</div>;

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: CẤU HÌNH ═══ */}
      <div className="flex flex-col gap-2">
        <ToolSectionLabel>Cấu hình Trapping</ToolSectionLabel>

        {/* Presets */}
        <div className="grid grid-cols-3 gap-2">
            {PRESETS.map(p => (
                <ToolCardOption 
                    key={p.key}
                    selected={preset === p.key}
                    onClick={() => selectPreset(p.key)}
                    label={p.label}
                    desc={p.desc}
                    className="items-center text-center"
                />
            ))}
        </div>

        {/* Fine-tune */}
        <div className="p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">Tinh chỉnh</span>
            <div className="grid grid-cols-2 gap-3">
                <ToolNumberInput 
                    label="Trap Width"
                    value={trapWidth}
                    onChange={val => { setTrapWidth(val); setPreset(''); }}
                    suffix="pt" step={0.05}
                />
                <ToolNumberInput 
                    label="Black Trap Width"
                    value={blackTrapWidth}
                    onChange={val => { setBlackTrapWidth(val); setPreset(''); }}
                    suffix="pt" step={0.05}
                />
            </div>
        </div>

        {/* Options */}
        <div className="flex flex-col gap-2 pt-1">
            {OPTIONS.map((opt) => (
                <ToolCheckboxOption 
                    key={opt.key}
                    selected={getOpt(opt.key)}
                    onClick={() => toggleOpt(opt.key)}
                    label={opt.label}
                    desc={opt.desc}
                />
            ))}
        </div>

        {/* Info Note */}
        <ToolWarning 
            title="Lưu ý quan trọng"
            desc={<>Trapping chuyên sâu cần hệ thống RIP chuyên nghiệp trên máy CTP. Tính năng này chủ yếu set <b>Overprint</b> cho text/nét đen.</>}
        />
      </div>

      {/* ═══ SECTION 2: THỰC THI ═══ */}
      <ToolDivider />
      <button onClick={apply} disabled={running}
        className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
        {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang áp dụng...</>) : (<>🚀 Áp dụng Trapping</>)}
      </button>

      {/* ═══ STATUS ═══ */}
      {status && (
        <div className={`p-3 rounded-lg border ${status.startsWith('✅') ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <span className={`text-[11px] font-bold ${status.startsWith('✅') ? 'text-emerald-600' : 'text-red-600'}`}>{status}</span>
          {status.startsWith('✅') && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">✅ File đã được cập nhật trên Viewer.</p>}
        </div>
      )}
    </div>
  );
}
