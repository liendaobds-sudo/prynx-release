import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import { useTranslation } from 'react-i18next';
import {
  useWorkspaceStore,
  workspaceDocumentIdentity,
} from '../../stores/useWorkspaceStore';

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

interface InkInfo {
  name: string;
  type: 'process' | 'spot';
  cmyk: number[];
  density: number;
  page_count: number;
}

export default function InkManagerTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [inks, setInks] = useState<InkInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [status, setStatus] = useState('');
  const [isInksOpen, setIsInksOpen] = useState(true);
  const selectionFileId = useWorkspaceStore(state => state.selectionFileId);
  const selectionDocumentIdentity = useWorkspaceStore(state => state.selectionDocumentIdentity);
  const viewerPageOrder = useWorkspaceStore(state => state.viewerPageOrder);
  const viewerPageRotations = useWorkspaceStore(state => state.viewerPageRotations);
  const setSelectionFileId = useWorkspaceStore(state => state.setSelectionFileId);
  const documentIdentity = workspaceDocumentIdentity(
    pdfFile,
    viewerPageOrder,
    viewerPageRotations,
  );
  const reusableFileId = selectionFileId && (
    !selectionDocumentIdentity
    || selectionDocumentIdentity === documentIdentity
  ) ? selectionFileId : '';
  const autoFetchIdentityRef = useRef('');
  const documentIdentityRef = useRef(documentIdentity);
  documentIdentityRef.current = documentIdentity;

  useEffect(() => { setInks([]); setStatus(''); }, [documentIdentity]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (reusableFileId) return reusableFileId;
    if (!pdfFile) throw new Error(t('preprocess.inkManager:chua_co_file_pdf'));
    // PERF (audit 2026-08-10 §PPE.REAUDIT.5): chỉ materialize khi page order/
    // rotation thật sự khác. ID mới được chia sẻ lại cho Output Preview và Edit.
    const r = await uploadPDF((await getWorkingFile(pdfFile)) || pdfFile);
    if (documentIdentityRef.current !== documentIdentity) {
      throw new Error('Tài liệu đã thay đổi trong lúc chuẩn bị dữ liệu mực.');
    }
    setSelectionFileId(r.id, documentIdentity);
    return r.id;
  }, [documentIdentity, getWorkingFile, pdfFile, reusableFileId, setSelectionFileId, t]);

  const fetchInks = useCallback(async () => {
    if (!pdfFile) return;
    const requestIdentity = documentIdentity;
    setLoading(true); setStatus('');
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/inks/${fid}`);
      const data = await res.json();
      if (documentIdentityRef.current === requestIdentity) setInks(data.inks || []);
    } catch (e: any) {
      if (documentIdentityRef.current === requestIdentity) setStatus(`❌ ${e.message}`);
    }
    if (documentIdentityRef.current === requestIdentity) setLoading(false);
  }, [documentIdentity, pdfFile, ensureUploaded]);

  useEffect(() => {
    if (!pdfFile || autoFetchIdentityRef.current === documentIdentity) return;
    autoFetchIdentityRef.current = documentIdentity;
    void fetchInks();
  }, [documentIdentity, fetchInks, pdfFile]);

  const convertSpot = async (spotName?: string) => {
    setConverting(true); setStatus('');
    const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
    const recipeTicket = shouldRecord
      ? recipeRecorder.noteOperation(
          'spot_cmyk',
          { spot_name: spotName || null },
          undefined,
          tabId,
        )
      : null;
    if (shouldRecord && !recipeTicket) {
      setStatus(`❌ ${t('tabs.imposition:dang_xu_ly_file')}`);
      setConverting(false);
      return;
    }
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/convert-spot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, spot_name: spotName || null }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(`✅ ${t('preprocess.inkManager:da_chuyen_x_cmyk', { x: spotName || t('preprocess.inkManager:tat_ca_spot') })}`);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          await onFileFixed(await dl.blob(), data.output_filename, undefined, recipeTicket);
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
      } else { recipeRecorder.discardPending(recipeTicket); setStatus(`❌ ${data.detail || t('preprocess.inkManager:loi')}`); }
    } catch (e: any) { recipeRecorder.discardPending(recipeTicket); setStatus(`❌ ${e.message}`); }
    finally { setConverting(false); }
  };

  const processInks = inks.filter(i => i.type === 'process');
  const spotInks = inks.filter(i => i.type === 'spot');

  const cmykToHex = (cmyk: number[]) => {
    const [c, m, y, k] = cmyk.map(v => v / 100);
    const r = Math.round(255 * (1 - c) * (1 - k));
    const g = Math.round(255 * (1 - m) * (1 - k));
    const b = Math.round(255 * (1 - y) * (1 - k));
    return `#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">{t('preprocess.inkManager:vui_long_mo_file_pdf_truoc')}</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: DANH SÁCH MỰC ═══ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setIsInksOpen(!isInksOpen)} className="flex items-center gap-2 group">
            <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
              {t('preprocess.inkManager:kenh_muc_ink_channels')}
            </span>
            <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isInksOpen ? 'rotate-180' : ''}`} />
          </button>
          <div className="flex items-center gap-2">
            {!loading && inks.length > 0 && (
              <div className="flex gap-1.5">
                <MiniCard icon="🔵" label="Process" value={String(processInks.length)} />
                {spotInks.length > 0 && <MiniCard icon="🟡" label="Spot" value={String(spotInks.length)} />}
              </div>
            )}
            <button onClick={fetchInks} disabled={loading} className="text-[10px] text-blue-500 hover:text-blue-600 hover:bg-blue-50 px-2 py-0.5 rounded transition-colors font-medium">
              {loading ? '...' : t('preprocess.inkManager:quet_lai')}
            </button>
          </div>
        </div>

        {isInksOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* Process Inks */}
                {processInks.map(ink => (
                  <div key={ink.name} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-800/30">
                    <div className="w-4 h-4 rounded-sm ring-1 ring-black/10 shrink-0" style={{ backgroundColor: cmykToHex(ink.cmyk) }} />
                    <span className="font-semibold text-[12px] text-slate-700 dark:text-zinc-200 flex-1">{ink.name}</span>
                    <span className="text-[9px] text-slate-400 font-mono">{ink.cmyk.join('/')}</span>
                  </div>
                ))}

                {/* Spot Inks */}
                {spotInks.map(ink => (
                  <div key={ink.name} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-600/30 bg-amber-50/50 dark:bg-amber-900/10">
                    <div className="w-4 h-4 rounded-sm ring-1 ring-black/10 shrink-0" style={{ backgroundColor: cmykToHex(ink.cmyk) }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-[12px] text-slate-700 dark:text-zinc-200 truncate">{ink.name}</span>
                        <span className="text-[8px] px-1 py-0 rounded bg-amber-200 text-amber-800 font-bold shrink-0">SPOT</span>
                      </div>
                      <span className="text-[9px] text-slate-400 font-mono">{ink.cmyk.join('/')}</span>
                    </div>
                    <button onClick={() => convertSpot(ink.name)} disabled={converting}
                      className="text-[10px] px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-bold disabled:opacity-50 transition-colors shrink-0"
                      title={t('preprocess.inkManager:chuyen_x_cmyk', { x: ink.name })}>
                      →CMYK
                    </button>
                  </div>
                ))}

                {inks.length === 0 && <div className="text-center py-4 text-[11px] text-slate-400">{t('preprocess.inkManager:chua_co_du_lieu_muc')}</div>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ SECTION 2: THAO TÁC ═══ */}
      {spotInks.length > 0 && (
        <>
          <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
          <button onClick={() => convertSpot()} disabled={converting}
            className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
            {converting ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
          </button>
        </>
      )}

      {spotInks.length === 0 && !loading && inks.length > 0 && (
        <div className="p-3 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <span className="text-[11px] font-bold text-emerald-600">{t('preprocess.inkManager:file_chi_chua_mau_process_cmyk_khong_co')}</span>
        </div>
      )}

      {/* ═══ STATUS ═══ */}
      {status && (
        <div className={`p-3 rounded-lg border ${status.startsWith('✅') ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <span className={`text-[11px] font-bold ${status.startsWith('✅') ? 'text-emerald-600' : 'text-red-600'}`}>{status}</span>
          {status.startsWith('✅') && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.inkManager:file_da_duoc_cap_nhat_tren_viewer')}</p>}
        </div>
      )}
    </div>
  );
}

function MiniCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
      <span className="text-xs">{icon}</span>
      <span className="text-[9px] font-bold text-slate-500">{label}</span>
      <span className="text-[11px] font-bold text-slate-800 dark:text-white">{value}</span>
    </div>
  );
}
