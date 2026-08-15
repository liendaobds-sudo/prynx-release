import { useState, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import {
    ToolSectionLabel, ToolDivider, ToolCheckboxOption, ToolWarning
} from './ToolUI';
import { useTranslation } from 'react-i18next';

interface Props {
  tabId?: string;
  pdfFile: File | null;
  onFileFixed?: (
    blob: Blob,
    name: string,
    path?: string,
    recipeTicket?: RecipeOperationTicket | null,
  ) => void | Promise<void>;
}

const OPTIONS = [
  { key: 'overprint_black', label: 'Overprint text/nét đen (K>95%)', desc: 'Bật overprint cho text và nét đen thuần. Tránh lỗi knockout gây viền trắng quanh chữ đen trên nền màu.' },
  { key: 'preserve_overprint', label: 'Giữ overprint hiện có', desc: 'Không tắt các thiết lập overprint đã có sẵn trong file; chỉ bổ sung cho object đen chưa set.' },
];

export default function TrapPresetsTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState('');
  const [overprintBlack, setOverprintBlack] = useState(true);
  const [preserveOverprint, setPreserveOverprint] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const expectedOutputNameRef = useRef<string | null>(null);

  useEffect(() => {
    // UIUX (audit 2026-07-28 §PF.1): giữ thông báo khi viewer nhận đúng file vừa xử lý.
    const preserveSuccess = expectedOutputNameRef.current === pdfFile?.name;
    expectedOutputNameRef.current = null;
    setFileId('');
    if (!preserveSuccess) setStatus('');
  }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.trapPresets:chua_co_file_pdf'));
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile, t]);

  const apply = async () => {
    setRunning(true); setStatus('');
    const params = { overprint_black: overprintBlack, preserve_overprint: preserveOverprint };
    const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
    const recipeTicket = shouldRecord
      ? recipeRecorder.noteOperation('trapping', {
          action_id: 'SET_BLACK_OVERPRINT',
          params,
        }, undefined, tabId)
      : null;
    if (shouldRecord && !recipeTicket) {
      setStatus(t('preprocess.trapPresets:loi_x', { msg: t('tabs.imposition:dang_xu_ly_file') }));
      setRunning(false);
      return;
    }
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/set-overprint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, action_id: 'SET_BLACK_OVERPRINT', params }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(t('preprocess.trapPresets:da_ap_dung_overprint_den'));
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          expectedOutputNameRef.current = data.output_filename;
          await onFileFixed(await dl.blob(), data.output_filename, undefined, recipeTicket);
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
      } else { recipeRecorder.discardPending(recipeTicket); setStatus(t('preprocess.trapPresets:loi_x', { msg: data.error || 'Lỗi' })); }
    } catch (e: any) { recipeRecorder.discardPending(recipeTicket); setStatus(t('preprocess.trapPresets:loi_x', { msg: e.message })); }
    finally { setRunning(false); }
  };

  const toggleOpt = (key: string) => {
    if (key === 'overprint_black') setOverprintBlack(!overprintBlack);
    if (key === 'preserve_overprint') setPreserveOverprint(!preserveOverprint);
  };
  const getOpt = (key: string) => key === 'overprint_black' ? overprintBlack : preserveOverprint;

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">{t('preprocess.trapPresets:vui_long_mo_file_pdf_truoc')}</div>;

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: CẤU HÌNH OVERPRINT ═══ */}
      <div className="flex flex-col gap-2">
        <ToolSectionLabel>{t('preprocess.trapPresets:cau_hinh_overprint_den')}</ToolSectionLabel>

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
            title={t('preprocess.trapPresets:pham_vi_cong_cu')}
            desc={<>{t('preprocess.trapPresets:cong_cu_nay_bat')} <b>Overprint</b> {t('preprocess.trapPresets:cho_object_mau_den_thuan_chong_vien')} <b>Trapping spread/choke</b> {t('preprocess.trapPresets:bay_muc_hinh_hoc_can_he_thong_rip')}</>}
        />
      </div>

      {/* ═══ SECTION 2: THỰC THI ═══ */}
      <ToolDivider />
      <button onClick={apply} disabled={running}
        className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
        {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
      </button>

      {/* ═══ STATUS ═══ */}
      {status && (
        <div className={`p-3 rounded-lg border ${status.startsWith('✅') ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <span className={`text-[11px] font-bold ${status.startsWith('✅') ? 'text-emerald-600' : 'text-red-600'}`}>{status}</span>
          {status.startsWith('✅') && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.trapPresets:file_da_duoc_cap_nhat_tren_viewer')}</p>}
        </div>
      )}
    </div>
  );
}
