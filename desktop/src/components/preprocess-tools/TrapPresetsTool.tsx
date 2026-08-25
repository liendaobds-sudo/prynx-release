import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf, type WorkingPdfRevisionSnapshot } from '../../hooks/useWorkingPdf';
import {
  createRevisionScopedPdfUploadCache,
  type RevisionScopedPdfUploadLease,
} from '../../lib/revisionScopedPdfUpload';
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
  ) => void | boolean | Promise<void | boolean>;
}

const OPTIONS = [
  { key: 'overprint_black', label: 'Overprint text/nét đen (K>95%)', desc: 'Bật overprint cho text và nét đen thuần. Tránh lỗi knockout gây viền trắng quanh chữ đen trên nền màu.' },
  { key: 'preserve_overprint', label: 'Giữ overprint hiện có', desc: 'Không tắt các thiết lập overprint đã có sẵn trong file; chỉ bổ sung cho object đen chưa set.' },
];

interface ActiveTrapRequest {
  generation: number;
  controller: AbortController;
  snapshot: WorkingPdfRevisionSnapshot | null;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export default function TrapPresetsTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [overprintBlack, setOverprintBlack] = useState(true);
  const [preserveOverprint, setPreserveOverprint] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const expectedOutputNameRef = useRef<string | null>(null);

  useEffect(() => {
    // UIUX (audit 2026-07-28 §PF.1): giữ thông báo khi viewer nhận đúng file vừa xử lý.
    const preserveSuccess = expectedOutputNameRef.current === pdfFile?.name;
    expectedOutputNameRef.current = null;
    if (!preserveSuccess) setStatus('');
  }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const uploadCache = useMemo(() => createRevisionScopedPdfUploadCache({
    resolver: getWorkingFile,
    upload: uploadPDF,
    missingFileError: () => new Error(t('preprocess.trapPresets:chua_co_file_pdf')),
  }), [getWorkingFile, t]);
  const requestGenerationRef = useRef(0);
  const activeRequestRef = useRef<ActiveTrapRequest | null>(null);
  const abortActiveRequest = useCallback(() => {
    requestGenerationRef.current += 1;
    const active = activeRequestRef.current;
    activeRequestRef.current = null;
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(createAbortError('Revision PDF đã thay đổi.'));
    }
  }, []);
  const beginRequest = useCallback((): ActiveTrapRequest => {
    abortActiveRequest();
    const request = {
      generation: ++requestGenerationRef.current,
      controller: new AbortController(),
      snapshot: getWorkingFile.capture?.() ?? null,
    };
    activeRequestRef.current = request;
    return request;
  }, [abortActiveRequest, getWorkingFile]);
  const isRequestCurrent = useCallback((request: ActiveTrapRequest): boolean => (
    activeRequestRef.current === request
    && request.generation === requestGenerationRef.current
    && !request.controller.signal.aborted
  ), []);
  const assertRequestCurrent = useCallback((
    request: ActiveTrapRequest,
    lease: RevisionScopedPdfUploadLease,
  ) => {
    if (!isRequestCurrent(request)) {
      throw request.controller.signal.reason ?? createAbortError('Lượt trapping đã hết hiệu lực.');
    }
    lease.assertCurrent();
  }, [isRequestCurrent]);
  const finishRequest = useCallback((request: ActiveTrapRequest): boolean => {
    if (!isRequestCurrent(request)) return false;
    activeRequestRef.current = null;
    return true;
  }, [isRequestCurrent]);
  const renderedRevision = getWorkingFile.capture?.();
  const renderedRevisionFile = renderedRevision?.file ?? pdfFile;
  const renderedPageRevisionKey = JSON.stringify([
    renderedRevision?.viewerPageOrder ?? null,
    renderedRevision?.viewerPageInstanceIds ?? null,
    renderedRevision?.viewerPageRotations ?? null,
    renderedRevision?.editGeneration ?? 0,
  ]);
  const previousRevisionRef = useRef({
    file: renderedRevisionFile,
    key: renderedPageRevisionKey,
  });
  useEffect(() => {
    const previous = previousRevisionRef.current;
    previousRevisionRef.current = { file: renderedRevisionFile, key: renderedPageRevisionKey };
    const active = activeRequestRef.current;
    if (!active?.snapshot || !getWorkingFile.isCurrent(active.snapshot)) {
      uploadCache.invalidate();
      abortActiveRequest();
    }
    setRunning(false);
    // REVISION (audit 2026-08-25 §REV.04): không giữ trạng thái thành công của
    // revision trước khi người dùng vừa xoay/xóa/reorder cùng file.
    if (previous.file === renderedRevisionFile && previous.key !== renderedPageRevisionKey) {
      setStatus('');
    }
  }, [abortActiveRequest, getWorkingFile, renderedPageRevisionKey, renderedRevisionFile, uploadCache]);
  useEffect(() => () => {
    abortActiveRequest();
    uploadCache.dispose();
  }, [abortActiveRequest, uploadCache]);

  const apply = async () => {
    setRunning(true); setStatus('');
    const params = { overprint_black: overprintBlack, preserve_overprint: preserveOverprint };
    try {
      // REVISION (audit 2026-08-25 §REV.01/04): chốt Edit PDF trước khi
      // ghi Recipe để Step và file_id luôn cùng một revision.
      await getWorkingFile.prepare();
    } catch (error: unknown) {
      setStatus(t('preprocess.trapPresets:loi_x', {
        msg: error instanceof Error ? error.message : '',
      }));
      setRunning(false);
      return;
    }
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
    const request = beginRequest();
    try {
      const lease = await uploadCache.ensureLease(request.controller.signal);
      assertRequestCurrent(request, lease);
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/set-overprint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: lease.fileId, action_id: 'SET_BLACK_OVERPRINT', params }),
        signal: request.controller.signal,
      });
      assertRequestCurrent(request, lease);
      const data = await res.json();
      assertRequestCurrent(request, lease);
      if (data.success) {
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(
            `${getApiUrl()}/preflight/download/${data.output_filename}`,
            { signal: request.controller.signal },
          );
          assertRequestCurrent(request, lease);
          if (!dl.ok) throw new Error('Không tải được file trapping.');
          const artifact = await dl.blob();
          assertRequestCurrent(request, lease);
          expectedOutputNameRef.current = data.output_filename;
          const committed = await onFileFixed(artifact, data.output_filename, undefined, recipeTicket);
          // REVISION (audit 2026-08-25 §REV.03/04): chỉ báo thành công khi
          // callback commit không từ chối kết quả cũ.
          if (committed === false) {
            expectedOutputNameRef.current = null;
            return;
          }
          setStatus(t('preprocess.trapPresets:da_ap_dung_overprint_den'));
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
      } else { recipeRecorder.discardPending(recipeTicket); setStatus(t('preprocess.trapPresets:loi_x', { msg: data.error || 'Lỗi' })); }
    } catch (e: unknown) {
      expectedOutputNameRef.current = null;
      recipeRecorder.discardPending(recipeTicket);
      if (!isRequestCurrent(request) || isAbortError(e)) return;
      const message = e instanceof Error
        ? e.message
        : typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string'
          ? e.message
          : '';
      setStatus(t('preprocess.trapPresets:loi_x', { msg: message }));
    }
    finally { if (finishRequest(request)) setRunning(false); }
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
