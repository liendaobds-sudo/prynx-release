import { useState, useEffect, useCallback } from 'react';
import { HelpCircle } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import ToolHelpModal from '../ToolHelpModal';
import type { ToolHelp } from '../../lib/toolHelp';
import { useTranslation } from 'react-i18next';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

// Mặc định ẩn (đã thống nhất): luôn giữ đen 100%K, hồ sơ màu Tự động, quy đổi
// "giữ màu gần nhất". Người dùng không cần chỉnh — đây là lựa chọn an toàn nhất.
const FIXED = { icc_profile: 'auto', rendering_intent: 'relative', preserve_black: true } as const;

const COLOR_HELP: ToolHelp = {
  title: 'Chuyển đổi màu — Hướng dẫn',
  tagline: 'Đưa file về đúng hệ màu để in. Chọn 1 trong 2 chế độ rồi bấm Thực thi.',
  sections: [
    {
      heading: 'Hai chế độ',
      items: [
        'Chuyển sang CMYK: đổi màu RGB sang 4 mực C-M-Y-K để in offset/in 4 màu. Dùng cho hầu hết file gửi nhà in.',
        'Chuyển sang đen trắng: bỏ toàn bộ màu, in một màu đen. Chỉ dùng khi CỐ Ý in trắng đen.',
      ],
    },
    {
      heading: 'Màu pha (Spot / Pantone)',
      items: [
        'Bật "Đổi luôn màu pha → CMYK" nếu muốn gộp Pantone/HKS vào 4 màu (in 4 màu thường).',
        'Tắt nếu cần giữ bản màu pha riêng (in spot).',
      ],
    },
    {
      heading: 'Đã tự tối ưu sẵn',
      items: [
        'Tự giữ chữ & nét đen in 1 màu đen (K) → chống lệch viền khi in offset.',
        'Tự dùng chuẩn màu an toàn — bạn không cần chỉnh thêm gì.',
      ],
    },
  ],
  printNote: 'Chuyển CMYK quan trọng nhất cho IN OFFSET. In nhanh (kỹ thuật số) nhiều máy nhận RGB nên có thể không cần.',
};

export default function ConvertColorsTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState('');
  const [mode, setMode] = useState<'cmyk' | 'grayscale'>('cmyk');
  const [includeSpot, setIncludeSpot] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => { setFileId(''); setResult(null); setError(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.convertColors:chua_co_file_pdf'));
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile, t]);

  const run = async () => {
    setRunning(true); setResult(null); setError('');
    try {
      const fid = await ensureUploaded();
      const conversions = mode === 'grayscale'
        ? ['gray_to_cmyk']
        : ['rgb_to_cmyk', ...(includeSpot ? ['spot_to_cmyk'] : [])];
      const body = {
        file_id: fid,
        conversions,
        icc_profile: FIXED.icc_profile,
        rendering_intent: FIXED.rendering_intent,
        preserve_black: FIXED.preserve_black,
      };
      recipeRecorder.noteOperation('convertcolors', {
        conversions, icc_profile: FIXED.icc_profile,
        rendering_intent: FIXED.rendering_intent, preserve_black: FIXED.preserve_black,
      });
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-colors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          onFileFixed(await dl.blob(), data.output_filename);
        }
      } else { recipeRecorder.discardPending(); setError(data.error || data.detail || t('preprocess.convertColors:that_bai')); }
    } catch (e: any) { recipeRecorder.discardPending(); setError(e.message); }
    setRunning(false);
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">{t('preprocess.convertColors:vui_long_mo_file_pdf_truoc')}</div>;

  const ModeCard = ({ value, icon, label, desc }: { value: 'cmyk' | 'grayscale'; icon: string; label: string; desc: string }) => {
    const sel = mode === value;
    return (
      <button onClick={() => setMode(value)}
        className={`w-full text-left px-3 py-3 rounded-xl border transition-all flex items-center gap-3
          ${sel ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300 shadow-sm' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
        <span className="text-xl shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <span className="font-bold text-[13px] block">{label}</span>
          <span className="text-[11px] text-slate-500 dark:text-zinc-400 block leading-snug mt-0.5">{desc}</span>
        </div>
        <div className={`w-4 h-4 rounded-full border-2 shrink-0 ${sel ? 'border-teal-500 bg-teal-500' : 'border-slate-300 dark:border-zinc-500'}`}>
          {sel && <div className="w-full h-full rounded-full border-2 border-white dark:border-zinc-900" />}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ NÚT HƯỚNG DẪN ═══ */}
      <button onClick={() => setShowHelp(true)}
        className="w-full flex items-center justify-center gap-1.5 text-[12px] font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800/50 transition-colors">
        <HelpCircle className="w-4 h-4" /> {t('preprocess.convertColors:chua_ro_xem_huong_dan_amp_giai_thich')}
      </button>
      {showHelp && <ToolHelpModal help={COLOR_HELP} icon="🎨" onClose={() => setShowHelp(false)} />}

      {/* ═══ CHỌN CHẾ ĐỘ (chọn 1) ═══ */}
      <div className="space-y-2">
        <ModeCard value="cmyk" icon="🟡" label={t('preprocess.convertColors:chuyen_sang_cmyk')} desc={t('preprocess.convertColors:cho_in_offset_in_4_mau_rgb_cmyk')} />
        <ModeCard value="grayscale" icon="⬛" label={t('preprocess.convertColors:chuyen_sang_den_trang')} desc={t('preprocess.convertColors:bo_mau_in_1_mau_den_grayscale')} />
      </div>

      {/* Tùy chọn màu pha — chỉ hiện ở chế độ CMYK */}
      {mode === 'cmyk' && (
        <button onClick={() => setIncludeSpot(!includeSpot)}
          className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-start gap-2.5
            ${includeSpot ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
          <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${includeSpot ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
            {includeSpot && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
          </div>
          <div className="flex-1">
            <span className="font-semibold block">{t('preprocess.convertColors:doi_luon_mau_pha_spot_pantone_cmyk')}</span>
            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block leading-snug mt-0.5">{t('preprocess.convertColors:bat_khi_in_4_mau_tat_neu_giu_ban_mau')}</span>
          </div>
        </button>
      )}

      {/* ═══ THỰC THI ═══ */}
      <button onClick={run} disabled={running}
        className="w-full px-2.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[13px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
        {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
      </button>

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">{t('preprocess.convertColors:thanh_cong')}</h4>
          {result.log?.map((l: any, i: number) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">{l.status === 'success' ? '✅' : '❌'} {l.message} ({l.duration_ms}ms)</p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.convertColors:file_da_duoc_cap_nhat_tren_viewer')}</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
