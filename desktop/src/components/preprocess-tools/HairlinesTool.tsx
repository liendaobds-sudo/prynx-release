import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf, type WorkingPdfRevisionSnapshot } from '../../hooks/useWorkingPdf';
import {
  createRevisionScopedPdfUploadCache,
  type RevisionScopedPdfUploadLease,
} from '../../lib/revisionScopedPdfUpload';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

const I = {
  Scan: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" x2="17" y1="12" y2="12"/></svg>,
  Light: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/></svg>,
  Standard: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>,
  Heavy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>,
};

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

interface HairlineLogEntry {
  message: string;
  duration_ms: number;
}

interface FixHairlinesResponse {
  success: boolean;
  output_filename?: string | null;
  log?: HairlineLogEntry[];
  error?: string | null;
  detail?: string | null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

interface ActiveHairlineRequest {
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

const PRESETS = [
  { key: 'light', icon: I.Light, label: 'Nhẹ', desc: '≤0.05pt → 0.2pt', t: 0.05, r: 0.2 },
  { key: 'standard', icon: I.Standard, label: 'Tiêu chuẩn', desc: '≤0.1pt → 0.25pt', t: 0.1, r: 0.25 },
  { key: 'heavy', icon: I.Heavy, label: 'Mạnh', desc: '≤0.25pt → 0.5pt', t: 0.25, r: 0.5 },
];

export default function HairlinesTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(0.1);
  const [replaceWith, setReplaceWith] = useState(0.25);
  const [selectedPreset, setSelectedPreset] = useState('standard');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FixHairlinesResponse | null>(null);
  const [error, setError] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const expectedOutputNameRef = useRef<string | null>(null);

  useEffect(() => {
    // UIUX (audit 2026-07-28 §PF.1): giữ kết quả khi viewer nhận đúng file vừa xử lý.
    const preserveSuccess = expectedOutputNameRef.current === pdfFile?.name;
    expectedOutputNameRef.current = null;
    if (!preserveSuccess) setResult(null);
    setError('');
  }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const uploadCache = useMemo(() => createRevisionScopedPdfUploadCache({
    resolver: getWorkingFile,
    upload: uploadPDF,
    missingFileError: () => new Error(t('preprocess.hairlines:chua_co_file_pdf')),
  }), [getWorkingFile, t]);
  const requestGenerationRef = useRef(0);
  const activeRequestRef = useRef<ActiveHairlineRequest | null>(null);
  const abortActiveRequest = useCallback(() => {
    requestGenerationRef.current += 1;
    const active = activeRequestRef.current;
    activeRequestRef.current = null;
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(createAbortError('Revision PDF đã thay đổi.'));
    }
  }, []);
  const beginRequest = useCallback((): ActiveHairlineRequest => {
    abortActiveRequest();
    const request = {
      generation: ++requestGenerationRef.current,
      controller: new AbortController(),
      snapshot: getWorkingFile.capture?.() ?? null,
    };
    activeRequestRef.current = request;
    return request;
  }, [abortActiveRequest, getWorkingFile]);
  const isRequestCurrent = useCallback((request: ActiveHairlineRequest): boolean => (
    activeRequestRef.current === request
    && request.generation === requestGenerationRef.current
    && !request.controller.signal.aborted
  ), []);
  const assertRequestCurrent = useCallback((
    request: ActiveHairlineRequest,
    lease: RevisionScopedPdfUploadLease,
  ) => {
    if (!isRequestCurrent(request)) {
      throw request.controller.signal.reason ?? createAbortError('Lượt sửa nét mảnh đã hết hiệu lực.');
    }
    lease.assertCurrent();
  }, [isRequestCurrent]);
  const finishRequest = useCallback((request: ActiveHairlineRequest): boolean => {
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
    // REVISION (audit 2026-08-25 §REV.04): chỉ xóa success khi chính file đang
    // xem bị sửa trang; đổi sang output vừa tạo vẫn theo cơ chế preserve tên cũ.
    if (previous.file === renderedRevisionFile && previous.key !== renderedPageRevisionKey) {
      setResult(null);
      setError('');
    }
  }, [abortActiveRequest, getWorkingFile, renderedPageRevisionKey, renderedRevisionFile, uploadCache]);
  useEffect(() => () => {
    abortActiveRequest();
    uploadCache.dispose();
  }, [abortActiveRequest, uploadCache]);

  const selectPreset = (key: string) => {
    setSelectedPreset(key);
    const p = PRESETS.find(pr => pr.key === key);
    if (p) { setThreshold(p.t); setReplaceWith(p.r); }
  };

  const run = async () => {
    setRunning(true); setResult(null); setError('');
    try {
      // REVISION (audit 2026-08-25 §REV.01/04): không ghi Recipe trước khi
      // Edit PDF pending đã commit thành Working File.
      await getWorkingFile.prepare();
    } catch (error: unknown) {
      setError(getErrorMessage(error, t('preprocess.hairlines:that_bai')));
      setRunning(false);
      return;
    }
    const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
    const recipeTicket = shouldRecord
      ? recipeRecorder.noteOperation(
          'hairlines',
          { threshold_pt: threshold, replace_pt: replaceWith },
          undefined,
          tabId,
        )
      : null;
    if (shouldRecord && !recipeTicket) {
      setError(t('tabs.imposition:dang_xu_ly_file'));
      setRunning(false);
      return;
    }
    const request = beginRequest();
    try {
      const lease = await uploadCache.ensureLease(request.controller.signal);
      assertRequestCurrent(request, lease);
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/fix-hairlines`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: lease.fileId, threshold_pt: threshold, replace_pt: replaceWith }),
        signal: request.controller.signal,
      });
      assertRequestCurrent(request, lease);
      const data = await res.json() as FixHairlinesResponse;
      assertRequestCurrent(request, lease);
      if (data.success) {
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(
            `${getApiUrl()}/preflight/download/${data.output_filename}`,
            { signal: request.controller.signal },
          );
          assertRequestCurrent(request, lease);
          if (!dl.ok) throw new Error(t('preprocess.hairlines:that_bai'));
          const artifact = await dl.blob();
          assertRequestCurrent(request, lease);
          expectedOutputNameRef.current = data.output_filename;
          const committed = await onFileFixed(artifact, data.output_filename, undefined, recipeTicket);
          // REVISION (audit 2026-08-25 §REV.03/04): parent từ chối kết quả stale
          // thì panel không được báo xanh như thể Viewer đã nhận file.
          if (committed === false) {
            expectedOutputNameRef.current = null;
            return;
          }
          setResult(data);
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
      } else { recipeRecorder.discardPending(recipeTicket); setError(data.error || data.detail || t('preprocess.hairlines:that_bai')); }
    } catch (error: unknown) {
      expectedOutputNameRef.current = null;
      recipeRecorder.discardPending(recipeTicket);
      if (isRequestCurrent(request) && !isAbortError(error)) {
        setError(getErrorMessage(error, t('preprocess.hairlines:that_bai')));
      }
    } finally {
      if (finishRequest(request)) setRunning(false);
    }
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
                    <span className="truncate">{tv(p.label)}</span>
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
          {running ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
        </button>
      </div>

      {/* ═══ RESULT ═══ */}
      {result && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <h4 className="text-[11px] font-bold mb-1 text-emerald-600">{t('preprocess.hairlines:thanh_cong')}</h4>
          {result.log?.map((l, i) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">✅ {l.message} ({l.duration_ms}ms)</p>
          ))}
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.hairlines:file_da_duoc_cap_nhat_tren_viewer')}</p>
        </div>
      )}

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}
    </div>
  );
}
