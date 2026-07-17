// @ts-nocheck
import { useState, useCallback, useEffect } from 'react';
import { X } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF, getFileUrl } from '../lib/api';
import { PRESET_RULES } from '../lib/preprocessEngine/ShuffleEngine';
import { getFileArrayBuffer } from '../lib/utils';
import { Button } from './Button';
import PDFUploader from './PDFUploader';
import AcrobatViewer from './AcrobatViewer';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';
import { usePrintDialog } from './shared/usePrintDialog';

// ── Types ──
interface PreflightIssue {
  rule_id: string; severity: 'error' | 'warning' | 'info';
  page: number | null; object_ref: string; description: string; auto_fixable: boolean;
}
interface PreflightReport {
  file_name: string; total_pages: number; issues: PreflightIssue[];
  summary: { errors: number; warnings: number; info: number; total: number; auto_fixable: number };
  color_summary: { has_rgb: boolean; has_cmyk: boolean; has_spot: boolean };
  font_summary: { total: number; embedded: number; not_embedded: number };
  image_summary: { total: number; low_res: number; min_dpi: number };
}
interface ActionLog { action_id: string; status: string; message: string; duration_ms: number; }
interface FixResult { success: boolean; output_filename: string | null; log: ActionLog[]; error: string | null; }

const SEV = {
  error: { label: 'Lỗi', bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', border: 'border-red-500/20', icon: '❌' },
  warning: { label: 'Cảnh báo', bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', border: 'border-amber-500/20', icon: '⚠️' },
  info: { label: 'Thông tin', bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-500/20', icon: 'ℹ️' },
};

const ACTIONS = [
  { id: 'CONVERT_TO_CMYK', icon: '🎨', title: 'Convert CMYK', desc: 'RGB → CMYK + FOGRA39' },
  { id: 'FLATTEN_TRANSPARENCY', icon: '📐', title: 'Flatten Transparency', desc: 'Xóa bóng đổ cho CTP' },
  { id: 'OUTLINE_FONTS', icon: '🖋️', title: 'Khóa Font', desc: 'Chữ → Vector (An toàn 100%)' },
  { id: 'EMBED_FONTS', icon: '🔤', title: 'Nhúng Font', desc: 'Thử nhúng font (Ít an toàn hơn)' },
  { id: 'DOWNSCALE_IMAGES', icon: '🖼️', title: 'Giảm DPI ảnh', desc: '>600 DPI → 300 DPI' },
  { id: 'FIX_METADATA', icon: '🏷️', title: 'Sửa Metadata', desc: 'Xóa metadata nhạy cảm' },
];

const INSPECT_RULES = [
  { id: 'COLOR_RGB_DETECTED', title: 'Hệ màu RGB', desc: 'Cảnh báo khi có ảnh/vector dùng RGB' },
  { id: 'COLOR_SPOT_DETECTED', title: 'Màu Spot', desc: 'Cảnh báo khi có màu pha (Pantone/DeviceN)' },
  { id: 'FONT_NOT_EMBEDDED', title: 'Font chữ', desc: 'Cảnh báo font chưa nhúng' },
  { id: 'TRANSPARENCY_DETECTED', title: 'Độ trong suốt', desc: 'Phát hiện bóng đổ, Transparency Group' },
  { id: 'IMAGE_LOW_RES', title: 'Độ phân giải', desc: 'Kiểm tra ảnh dưới 200 DPI' },
  { id: 'BLEED_MISSING', title: 'Bleed (Tràn lề)', desc: 'Kiểm tra thiếu TrimBox/BleedBox' },
  { id: 'OVERPRINT_DETECTED', title: 'Overprint', desc: 'Cảnh báo chế độ đè màu chồng (Overprint)' },
  { id: 'PAGE_SIZE_MISMATCH', title: 'Khổ trang', desc: 'Kiểm tra kích thước các trang không bằng nhau' },
  { id: 'IMAGE_HIGH_DPI', title: 'Ảnh DPI quá cao', desc: 'Phát hiện ảnh > 600 DPI gây nặng file' },
  { id: 'GIF_IN_PDF', title: 'Ảnh GIF/Indexed', desc: 'Phát hiện ảnh palette 256 màu' },
  { id: 'PROGRESSIVE_JPEG', title: 'JPEG Progressive', desc: 'Ảnh JPEG progressive gây lỗi RIP' },
  { id: 'OBJECT_OFF_PAGE', title: 'Object ngoài trang', desc: 'Phát hiện đối tượng nằm hoàn toàn ngoài vùng in' },
  { id: 'PDF_VERSION_MISMATCH', title: 'Phiên bản PDF', desc: 'Kiểm tra tương thích PDF version' },
  { id: 'TEXT_DETECTED', title: 'Chữ chưa Outline', desc: 'Phát hiện Live Text chưa khóa font' },
  { id: 'IMAGE_NOT_EMBEDDED', title: 'Ảnh chưa Embed', desc: 'Phát hiện OPI link ảo / XMP linked' },
  { id: 'TAC_EXCEEDED', title: 'TAC vượt ngưỡng', desc: 'Tổng mực CMYK+Spot vượt ngưỡng (mặc định 300%)' },
];

type Phase = 'upload' | 'workspace';

export default function PreflightTab({ onDirtyChange, tabId, isActive }: any = {}) {
  const { t } = useTranslation();
  const { openPrintDialog, printDialog } = usePrintDialog();
  const [phase, setPhase] = useState<Phase>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState('');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [fixingAction, setFixingAction] = useState('');
  const [isInspecting, setIsInspecting] = useState(false);
  const [error, setError] = useState('');
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [selectedRules, setSelectedRules] = useState<Set<string>>(new Set(INSPECT_RULES.map(r => r.id)));

  // AN TOÀN DỮ LIỆU: sau khi CHẠY SỬA LỖI, file đã sửa chỉ nằm tạm trên server (sẽ bị
  // dọn) + hiển thị trên viewer; chưa được lưu xuống máy. Báo "dirty" để App cảnh báo
  // khi đóng tab/app (tránh mất kết quả sửa). Xóa cờ khi reset (làm lại từ đầu).
  useEffect(() => {
    onDirtyChange?.(!!(fixResult && (fixResult as any).success));
  }, [fixResult, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  // Async physical path polyfill (non-blocking via HTTP)
  useEffect(() => {
    if (file && !(file as any).path && (window as any).__TAURI_INTERNALS__) {
      let isCancelled = false;
      (async () => {
        try {
          let tempPath = '';
          try {
            // Priority: Tauri local writeFile (instant)
            const { tempDir, join } = await import('@tauri-apps/api/path');
            const { writeFile } = await import('@tauri-apps/plugin-fs');
            const buffer = await getFileArrayBuffer(file);
            const tDir = await tempDir();
            tempPath = await join(tDir, `prynx_input_${Date.now()}_${file.name}`);
            await writeFile(tempPath, new Uint8Array(buffer));
          } catch (tauriErr) {
            console.warn("Tauri writeFile failed, falling back to HTTP upload", tauriErr);
            const { uploadFileForNup } = await import('../lib/api');
            tempPath = await uploadFileForNup(file as File);
          }

          if (!isCancelled && tempPath) {
            Object.defineProperty(file, 'path', { value: tempPath });
            const newFile = new File([file], file.name, { type: file.type });
            Object.defineProperty(newFile, 'path', { value: tempPath });
            setFile(newFile);
          }
        } catch (e) {
          console.error("Path polyfill failed completely", e);
        }
      })();
      return () => { isCancelled = true; };
    }
  }, [file]);

  // Ctrl+P → in ĐÚNG cái viewer đang hiển thị. Viewer bám theo pdfUrl (bản gốc, hoặc
  // bản ĐÃ SỬA sau khi chạy fix — setPdfUrl bằng blob kết quả). Nên in fetch từ pdfUrl
  // để "view sao in vậy"; KHÔNG dùng state `file` (luôn là bản gốc → sau fix sẽ in nhầm
  // bản chưa sửa). Dùng hộp thoại in hợp nhất (usePrintDialog).
  const handlePrint = useCallback(async () => {
    try {
      if (!pdfUrl) { setError(t('preflight.preflight:chua_co_file_de_in')); return; }
      const source = await (await fetch(pdfUrl)).blob();
      await openPrintDialog({ source, numPages: report?.total_pages || 1 });
    } catch (e: any) {
      if (e?.message === 'NOT_TAURI') { setError(t('preflight.preflight:in_chi_ho_tro_trong_ung_dung')); return; }
      setError(t('preflight.preflight:khong_the_in_file') + (e?.message || e));
    }
  }, [pdfUrl, openPrintDialog, report, t]);

  useEffect(() => {
    const onTriggerPrint = (e: any) => {
      if (isActive && e.detail?.tabId === tabId) handlePrint();
    };
    window.addEventListener('app-trigger-print', onTriggerPrint);
    return () => window.removeEventListener('app-trigger-print', onTriggerPrint);
  }, [isActive, tabId, handlePrint]);

  const fileSizeStr = file ? (file.size / (1024 * 1024)).toFixed(2) + ' MB' : '';

  const handleFileSelected = useCallback(async (f: File) => {
    setFile(f);
    setError('');
    setReport(null);
    setFixResult(null);

    // Tạo local blob URL để AcrobatViewer hiển thị ngay lập tức (tránh lỗi CORS)
    setPdfUrl(URL.createObjectURL(f));
    setPhase('workspace');

    try {
      const result = await uploadPDF(f);
      setFileId(result.id);
    } catch (e: any) {
      setError(e.message || t('preflight.preflight:upload_that_bai'));
    }
  }, []);

  // ── Preflight Inspect ──
  const runInspect = useCallback(async () => {
    if (!fileId || selectedRules.size === 0) return;
    setIsInspecting(true); setError(''); setReport(null); setFixResult(null);
    try {
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/inspect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, rules: Array.from(selectedRules), tac_threshold: 300 }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || t('preflight.preflight:loi_kiem_tra'));
      setReport(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setIsInspecting(false); }
  }, [fileId, selectedRules]);

  // ── Fix Action ──
  const runAction = useCallback(async (actionId: string) => {
    if (!fileId) return;
    setFixingAction(actionId); setFixResult(null);
    try {
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, action_id: actionId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || t('preflight.preflight:loi'));
      setFixResult(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setFixingAction(''); }
  }, [fileId]);

  // ── Pipeline ──
  const runPipeline = useCallback(async () => {
    if (!fileId || selectedActions.size === 0) return;
    setFixingAction('PIPELINE'); setFixResult(null);
    try {
      const actions = Array.from(selectedActions).map(id => ({ id, params: {} }));
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/pipeline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, actions }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || t('preflight.preflight:loi'));
      const data = await res.json();
      setFixResult(data);

      // Load fixed PDF into viewer (same pattern as ImpositionTab)
      if (data.success && data.output_filename) {
        const pdfRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          setPdfUrl(URL.createObjectURL(blob));
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setFixingAction(''); }
  }, [fileId, selectedActions]);

  const handleReset = () => {
    setPhase('upload'); setFile(null); setFileId(''); setPdfUrl(null);
    setReport(null); setFixResult(null); setError(''); setSelectedActions(new Set());
  };

  const toggleAction = (id: string) => {
    setSelectedActions(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const toggleRule = (id: string) => {
    setSelectedRules(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  // ════════════════════════════════════════
  // UPLOAD PHASE (same pattern as ImpositionTab)
  // ════════════════════════════════════════
  if (phase === 'upload') {
    return (
      <div className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#1a1a1a]">
        <div className="flex-1 flex flex-col items-center justify-center py-12 px-6">
          <div className="text-center mb-10 animate-fade-in">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">{t('preflight.preflight:preflight_kiem_tra_chuan_in')}</h1>
            <p className="text-slate-600 dark:text-zinc-400 transition-colors max-w-2xl mx-auto leading-relaxed">
              {t('preflight.preflight:phan_tich_cau_truc_pdf_he_mau_rgb_cmyk')}
            </p>
          </div>
          <div className="max-w-xl w-full animate-slide-up">
            <PDFUploader
              label={t('preflight.preflight:keo_tha_pdf_can_kiem_tra')}
              sublabel={t('preflight.preflight:phan_tich_8_quy_tac_chuan_in_offset_tu')}
              onFileSelected={handleFileSelected}
              isUploading={false}
              uploadedName=""
              accentColor="#14b8a6"
            />
          </div>
          {error && <div className="mt-4 px-4 py-3 bg-red-100 dark:bg-red-900 border border-red-400 text-red-700 dark:text-red-200 rounded text-sm max-w-xl w-full">{error}</div>}
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════
  // WORKSPACE PHASE (AcrobatViewer + rightPanel)
  // ════════════════════════════════════════
  return (
    <div className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#1a1a1a]">
      {printDialog}
      <div className="flex-1 flex flex-row overflow-hidden relative animate-fade-in">

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-600 text-red-700 dark:text-red-200 px-4 py-3 rounded shadow-lg z-[100] flex items-center gap-3">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {error}
          </div>
        )}

        {/* Processing Overlay */}
        {(isInspecting || !!fixingAction) && (
          <div className="absolute inset-0 bg-[#525659]/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center text-white">
            <div className="w-16 h-16 border-4 border-teal-500/30 border-t-teal-500 rounded-full animate-spin mb-6" />
            <h3 className="font-bold text-2xl tracking-widest uppercase mb-3">
              {isInspecting ? t('preflight.preflight:dang_kiem_tra') : t('preflight.preflight:dang_sua_loi')}
            </h3>
            <p className="text-teal-300 font-medium text-lg">
              {isInspecting ? t('preflight.preflight:he_thong_dang_phan_tich_cau_truc_pdf') :
                fixingAction === 'PIPELINE' ? t('preflight.preflight:dang_chay_pipeline_sua_loi') :
                  t('preflight.preflight:he_thong_xu_ly', { name: ACTIONS.find(a => a.id === fixingAction)?.title || fixingAction })}
            </p>
            <p className="text-slate-400 mt-4 text-sm">{t('preflight.preflight:xu_ly_tren_server_noi_bo')}</p>
          </div>
        )}

        {/* LEFT: AcrobatViewer */}
        <div className="flex-1 relative z-0">
          {pdfUrl && (
            <AcrobatViewer
              pdfUrl={pdfUrl}
              onToggleSidebar={setIsSidebarOpen}
              rightPanel={(
                <div className={`${isSidebarOpen ? 'w-[340px]' : 'w-[48px]'} shrink-0 bg-[#f8fafc] dark:bg-zinc-900 shadow-[-10px_0_30px_rgba(0,0,0,0.05)] flex flex-col z-20 h-full transition-all duration-300 relative border-l border-slate-200 dark:border-zinc-800`}>

                  {/* Collapsed toggle */}
                  {!isSidebarOpen && (
                    <button
                      onClick={() => setIsSidebarOpen(true)}
                      className="absolute inset-x-0 top-0 w-full h-12 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 transition-colors border-b border-black/5 dark:border-white/10"
                      title={t('preflight.preflight:mo_bang_preflight')}
                    >
                      <span className="text-slate-500 dark:text-zinc-400">🩺</span>
                    </button>
                  )}

                  {isSidebarOpen && (
                    <>
                      {/* Panel Header */}
                      <div className="text-xs font-semibold text-slate-600 dark:text-zinc-400 p-2 bg-slate-100/80 dark:bg-zinc-900/80 border-b border-black/5 dark:border-white/10 shrink-0 flex items-center justify-between transition-colors">
                        <h2 className="flex items-center gap-2"><span>🩺</span> {t('preflight.preflight:preflight_chuan_in')}</h2>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setIsSidebarOpen(false)} className="w-6 h-6 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-800 rounded transition-colors" title={t('preflight.preflight:thu_gon')}>▶</button>
                          <button onClick={handleReset} className="w-6 h-6 flex items-center justify-center hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/20 rounded transition-colors" title={t('preflight.preflight:dong_file')} aria-label={t('preflight.preflight:dong_file')}><X className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>

                      {/* File Info */}
                      <div className="px-3 py-2 bg-slate-50 dark:bg-zinc-950/50 border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-2 overflow-hidden shadow-sm">
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="truncate text-[12px] font-semibold text-slate-800 dark:text-zinc-200 leading-tight" title={file?.name}>{file?.name}</span>
                          <span className="text-[10px] text-slate-500 font-mono leading-tight mt-0.5">{fileSizeStr}</span>
                        </div>
                      </div>

                      {/* Scrollable Content */}
                      <div className="p-4 overflow-y-auto flex-1 flex flex-col text-sm text-slate-800 dark:text-zinc-200 scroller-thin relative bg-[#f8fafc] dark:bg-zinc-900 border-t border-black/5 dark:border-white/5">

                        {/* Run Preflight Button */}
                        {!report && (
                          <div className="py-2">
                            <div className="text-center mb-4">
                              <span className="text-4xl block mb-2">🩺</span>
                              <p className="text-[12px] text-slate-500 dark:text-zinc-400 leading-relaxed">
                                {t('preflight.preflight:chon_cac_quy_tac_kiem_tra_ben_duoi_va')}
                              </p>
                            </div>

                            <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">{t('preflight.preflight:chon_quy_tac_rules')}</h3>
                            <div className="space-y-1 mb-4">
                              {INSPECT_RULES.map(r => {
                                const sel = selectedRules.has(r.id);
                                return (
                                  <button key={r.id} onClick={() => toggleRule(r.id)} disabled={isInspecting}
                                    className={`w-full text-left px-2.5 py-1.5 rounded-lg border transition-all flex items-center gap-2.5
                                      ${sel ? 'border-teal-500/50 bg-teal-500/5' : 'border-transparent hover:bg-slate-100 dark:hover:bg-zinc-800'}`}>
                                    <div className={`w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors
                                      ${sel ? 'bg-teal-500 border-teal-500 text-white' : 'border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800'}`}>
                                      {sel && <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[11px] font-bold text-slate-700 dark:text-white leading-tight">{tv(r.title)}</div>
                                      <div className="text-[9px] text-slate-500 dark:text-zinc-400 truncate mt-0.5">{tv(r.desc)}</div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>

                            <Button variant="primary" className="w-full h-10 text-sm font-bold shadow-lg" onClick={runInspect} disabled={isInspecting || selectedRules.size === 0}>
                              {t('preflight.preflight:chay_preflight_rules', { n: selectedRules.size })}
                            </Button>
                          </div>
                        )}

                        {/* Report */}
                        {report && (
                          <>
                            {/* Re-scan button */}
                            <Button variant="secondary" size="sm" className="w-full mb-4" onClick={runInspect} disabled={isInspecting}>
                              {t('preflight.preflight:quet_lai')}
                            </Button>

                            {/* Summary Cards */}
                            <div className="space-y-1.5 mb-4">
                              <MiniCard icon="🎨" label={t('preflight.preflight:he_mau')} value={
                                [report.color_summary.has_cmyk && 'CMYK', report.color_summary.has_rgb && '⚠️RGB', report.color_summary.has_spot && 'Spot'].filter(Boolean).join(', ') || t('preflight.preflight:khong_ro_vector')
                              } />
                              <MiniCard icon="🔤" label="Font" value={
                                report.font_summary.not_embedded > 0 ? t('preflight.preflight:font_chua_nhung', { n: report.font_summary.not_embedded, total: report.font_summary.total }) : t('preflight.preflight:font_da_nhung', { total: report.font_summary.total })
                              } />
                              <MiniCard icon="🖼️" label={t('preflight.preflight:anh')} value={
                                report.image_summary.total === 0 ? t('preflight.preflight:khong_co') :
                                  report.image_summary.low_res > 0 ? t('preflight.preflight:anh_low_res', { n: report.image_summary.low_res, total: report.image_summary.total }) :
                                    t('preflight.preflight:anh_ok_min_dpi', { total: report.image_summary.total, dpi: report.image_summary.min_dpi })
                              } />
                            </div>

                            {/* Issues */}
                            <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">
                              {t('preflight.preflight:van_de_n', { n: report.issues.length })}
                            </h3>
                            {report.issues.length === 0 ? (
                              <div className="text-center py-6 text-slate-400">
                                <span className="text-3xl block mb-2">🎉</span>
                                <p className="text-[13px] font-semibold">{t('preflight.preflight:khong_co_van_de')}</p>
                                <p className="text-[11px] mt-1">{t('preflight.preflight:file_san_sang_dua_in')}</p>
                              </div>
                            ) : (
                              <div className="space-y-1.5 mb-4">
                                {report.issues.map((issue, idx) => {
                                  const s = SEV[issue.severity];
                                  return (
                                    <div key={idx} className={`${s.bg} border ${s.border} rounded-lg p-2.5`}>
                                      <div className="flex items-center gap-1.5 mb-0.5">
                                        <span className="text-[10px]">{s.icon}</span>
                                        <span className={`text-[10px] font-bold ${s.text}`}>{tv(s.label)}</span>
                                        <span className="text-[9px] font-mono text-slate-400">{issue.rule_id}</span>
                                        {issue.page && <span className="text-[9px] text-slate-400 ml-auto">{t('preflight.preflight:tr_page', { page: issue.page })}</span>}
                                      </div>
                                      <p className={`text-[11px] font-medium ${s.text} leading-snug`}>{issue.description}</p>
                                      {issue.auto_fixable && (
                                        <span className="inline-block mt-1 px-1.5 py-0.5 bg-teal-500/10 text-teal-600 dark:text-teal-400 text-[8px] font-bold rounded border border-teal-500/20">AUTO-FIX</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* Warning Banner if FONT_NOT_EMBEDDED */}
                            {report.issues.some(i => i.rule_id === 'FONT_NOT_EMBEDDED') && (
                              <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
                                <div className="flex gap-2">
                                  <span className="text-sm">⚠️</span>
                                  <div className="flex-1">
                                    <h4 className="text-[11px] font-bold text-red-600 dark:text-red-400 leading-tight">{t('preflight.preflight:canh_bao_rui_ro_sai_font')}</h4>
                                    <p className="text-[10px] text-red-700/80 dark:text-red-300/80 mt-0.5 leading-snug">
                                      {t('preflight.preflight:file_thieu_font_goc_neu_dung_lenh')} <b>{t('preflight.preflight:khoa_font')}</b> {t('preflight.preflight:hoac')} <b>{t('preflight.preflight:nhung_font')}</b> {t('preflight.preflight:ben_duoi_he_thong_co_the_tu_thay_bang')}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Actions */}
                            <div className="border-t border-black/5 dark:border-white/5 pt-3 mt-2">
                              <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-wider mb-2">{t('preflight.preflight:sua_loi_tu_dong')}</h3>
                              <div className="space-y-1.5 mb-3">
                                {ACTIONS.map(a => {
                                  const sel = selectedActions.has(a.id);
                                  return (
                                    <button key={a.id} onClick={() => toggleAction(a.id)} disabled={!!fixingAction}
                                      className={`w-full text-left px-2.5 py-2 rounded-lg border transition-all flex items-center gap-2
                                        ${sel ? 'border-teal-500 bg-teal-500/5' : 'border-transparent hover:bg-slate-100 dark:hover:bg-zinc-800'}`}>
                                      <span className="text-sm">{a.icon}</span>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[11px] font-bold text-slate-700 dark:text-white">{tv(a.title)}</div>
                                        <div className="text-[9px] text-slate-400">{tv(a.desc)}</div>
                                      </div>
                                      <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0
                                        ${sel ? 'bg-teal-500 border-teal-500 text-white' : 'border-slate-300 dark:border-zinc-600'}`}>
                                        {sel && <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                              <Button variant="primary" className="w-full h-10 text-sm font-bold" onClick={runPipeline}
                                disabled={selectedActions.size === 0 || !!fixingAction}>
                                {t('preflight.preflight:thuc_thi_n', { n: selectedActions.size })}
                              </Button>
                            </div>

                            {/* Fix Result */}
                            {fixResult && (
                              <div className={`mt-3 p-3 rounded-lg border ${fixResult.success ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
                                <h4 className={`text-[11px] font-bold mb-1 ${fixResult.success ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {fixResult.success ? t('preflight.preflight:thanh_cong') : t('preflight.preflight:that_bai')}
                                </h4>
                                {fixResult.log.map((e, i) => (
                                  <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">{e.status === 'success' ? '✅' : '❌'} {e.message} ({e.duration_ms}ms)</p>
                                ))}
                                {fixResult.success && fixResult.output_filename && (
                                  <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">
                                    {t('preflight.preflight:file_da_duoc_cap_nhat_tren_viewer_ban')}
                                  </p>
                                )}
                                {fixResult.error && <p className="text-[10px] text-red-500 mt-1">{fixResult.error}</p>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MiniCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
      <span className="text-sm">{icon}</span>
      <span className="text-[10px] font-bold text-slate-500 w-12">{label}</span>
      <span className="text-[11px] text-slate-700 dark:text-zinc-200 font-medium flex-1">{value}</span>
    </div>
  );
}
