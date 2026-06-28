import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import {
    ToolSectionLabel, ToolDivider, ToolCheckboxOption, ToolWarning
} from './ToolUI';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

const OPTIONS = [
  { key: 'overprint_black', label: 'Overprint text/nét đen (K>95%)', desc: 'Bật overprint cho text và nét đen thuần. Tránh lỗi knockout gây viền trắng quanh chữ đen trên nền màu.' },
  { key: 'preserve_overprint', label: 'Giữ overprint hiện có', desc: 'Không tắt các thiết lập overprint đã có sẵn trong file; chỉ bổ sung cho object đen chưa set.' },
];

export default function TrapPresetsTool({ pdfFile, onFileFixed }: Props) {
  const [fileId, setFileId] = useState('');
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

  const apply = async () => {
    setRunning(true); setStatus('');
    try {
      const fid = await ensureUploaded();
      const params = { overprint_black: overprintBlack, preserve_overprint: preserveOverprint };
      recipeRecorder.noteOperation('trapping', {
        action_id: 'SET_BLACK_OVERPRINT',
        params,
      });
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/set-overprint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, action_id: 'SET_BLACK_OVERPRINT', params }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('✅ Đã áp dụng Overprint đen');
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

      {/* ═══ SECTION 1: CẤU HÌNH OVERPRINT ═══ */}
      <div className="flex flex-col gap-2">
        <ToolSectionLabel>Cấu hình Overprint đen</ToolSectionLabel>

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
            title="Phạm vi công cụ"
            desc={<>Công cụ này bật <b>Overprint</b> cho object màu đen thuần (chống viền trắng quanh chữ/nét đen). <b>Trapping spread/choke</b> (bẫy mực hình học) cần hệ thống RIP chuyên nghiệp trên máy CTP — không thực hiện ở đây.</>}
        />
      </div>

      {/* ═══ SECTION 2: THỰC THI ═══ */}
      <ToolDivider />
      <button onClick={apply} disabled={running}
        className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
        {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang áp dụng...</>) : (<>🚀 Áp dụng Overprint đen</>)}
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
