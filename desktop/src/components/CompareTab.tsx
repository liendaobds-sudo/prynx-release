import { useState, useCallback, useEffect, useRef } from 'react';
import { useComparisonStore } from '../stores/comparisonStore';
import { uploadPDF, createCompareJob, getJobStatus, getJobResults, getFileUrl, cancelCompareJob } from '../lib/api';
import PDFUploader from './PDFUploader';
import ProgressTracker from './ProgressTracker';
import DualPDFViewer from './DualPDFViewer';
import type { DiffRegionData } from './DualPDFViewer';
import DiffSidebar from './DiffSidebar';

import ReportModal from './ReportModal';
import { Button } from './Button';
import { useTranslation } from 'react-i18next';
import { usePrintDialog } from './shared/usePrintDialog';
import { toast } from './ui/Toast';
// UIUX (audit 2026-07-27 §D-15): lỗi kỹ thuật → câu Việt + hướng khắc phục
import { formatError, isCanceled } from '../lib/errorMessages';
import { imageFileToPdfIfNeeded } from '../lib/imageNormalizer';
import { isSupportedImageFileName } from '../lib/imageFileTypes';
import { getFileArrayBuffer } from '../lib/utils';

type Phase = 'upload' | 'processing' | 'results';

// PERF (audit 2026-08-13 §PB-3): watchdog theo TIẾN ĐỘ thay deadline cứng 10 phút.
// Tài liệu dài hợp lệ (trần 1.000 trang; @300 DPI trên máy yếu) dễ chạy quá 10 phút
// trong khi backend vẫn cập nhật tiến độ từng trang — deadline cũ tự hủy oan job
// đang chạy đúng. Chỉ hủy khi KHÔNG có tín hiệu tiến triển nào (status/progress/
// trang/thông điệp đều đứng yên) suốt COMPARE_STALL_TIMEOUT_MS — trường hợp đó
// là job treo hoặc backend mất phản hồi. Nút Hủy vẫn là đường thoát chính.
const COMPARE_STALL_TIMEOUT_MS = 5 * 60_000;
const COMPARE_STALL_CHECK_INTERVAL_MS = 30_000;

interface CompareTabProps {
  tabId?: string;
  isActive?: boolean;
}

export default function CompareTab({ tabId, isActive = true }: CompareTabProps) {
  const { t } = useTranslation();
  const store = useComparisonStore();
  const { openPrintDialog, printDialog } = usePrintDialog();
  const [phase, setPhase] = useState<Phase>('upload');
  const [uploadingA, setUploadingA] = useState(false);
  const [uploadingB, setUploadingB] = useState(false);
  const [error, setError] = useState('');
  const [scrollToPage, setScrollToPage] = useState(0);
  const [scrollToBPage, setScrollToBPage] = useState(0);
  const [activeGif, setActiveGif] = useState<string | null>(null);
  const [gifZoom, setGifZoom] = useState(1);
  const [gifPan, setGifPan] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isGifDragging, setIsGifDragging] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const [isReportOpen, setIsReportOpen] = useState(false);
  const [focusedRegion, setFocusedRegion] = useState<{page: number, nx: number, ny: number} | null>(null);
  const pollingCleanupRef = useRef<(() => void) | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollingCleanupRef.current?.();
      pollingCleanupRef.current = null;
      const activeJobId = activeJobRef.current;
      activeJobRef.current = null;
      if (activeJobId) void cancelCompareJob(activeJobId).catch(() => undefined);
    };
  }, []);

  // Keyboard globals for GIF Viewer
  useEffect(() => {
    if (!isActive) {
      setIsSpacePressed(false);
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveGif(null);
        setGifZoom(1);
        setGifPan({ x: 0, y: 0 });

      }
      if (e.code === 'Space' && activeGif && !e.repeat) {
        setIsSpacePressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
        setIsGifDragging(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => { 
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activeGif, isActive]);

  const handleUploadB = useCallback(async (file: File) => {
    setUploadingB(true);
    setError('');
    try {
      // Ảnh được đóng gói thành PDF một trang để toàn bộ engine đối chiếu,
      // viewer và luồng in tiếp tục dùng chung một hợp đồng PDF ổn định.
      const uploadFile = await imageFileToPdfIfNeeded(file, getFileArrayBuffer);
      const result = await uploadPDF(uploadFile);
      store.setFileB({ ...result, original_name: file.name, localFile: uploadFile });
    } catch (e: unknown) {
      // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
      if (!isCanceled(e)) {
        const fallback = isSupportedImageFileName(file.name)
          ? t('tabs.compare:khong_doc_duoc_file_anh')
          : t('tabs.compare:upload_that_bai');
        setError(formatError(e, fallback));
      }
    } finally {
      setUploadingB(false);
    }
  }, [store, t]);

  const handleUploadA = useCallback(async (file: File, allFiles?: File[]) => {
    setUploadingA(true);
    setError('');
    try {
      const uploadFile = await imageFileToPdfIfNeeded(file, getFileArrayBuffer);
      const result = await uploadPDF(uploadFile);
      store.setFileA({ ...result, original_name: file.name, localFile: uploadFile });
      
      // Auto-fill File B if multiple files were dropped
      if (allFiles && allFiles.length > 1) {
         setTimeout(() => handleUploadB(allFiles[1]), 500);
      }
    } catch (e: unknown) {
      // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
      if (!isCanceled(e)) {
        const fallback = isSupportedImageFileName(file.name)
          ? t('tabs.compare:khong_doc_duoc_file_anh')
          : t('tabs.compare:upload_that_bai');
        setError(formatError(e, fallback));
      }
    } finally {
      setUploadingA(false);
    }
  }, [store, handleUploadB, t]);

  // Ctrl+P / File→In: in bản B (sửa) nếu có, không thì bản A.
  const handlePrint = useCallback(async () => {
    const local = store.fileB?.localFile || store.fileA?.localFile;
    if (!local) {
      toast.info(t('tabs.compare:can_file_de_in') || 'Cần file PDF để in');
      return;
    }
    try {
      await openPrintDialog({
        source: local,
        numPages: store.fileB?.page_count || store.fileA?.page_count || 1,
      });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'NOT_TAURI') {
        toast.error(t('print:only_in_app'));
      } else {
        toast.error((e instanceof Error ? e.message : '') || t('print:cannot_print'));
      }
    }
  }, [store.fileA, store.fileB, openPrintDialog, t]);

  useEffect(() => {
    const onTrigger = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (isActive && (!detail?.tabId || detail.tabId === tabId)) handlePrint();
    };
    window.addEventListener('app-trigger-print', onTrigger);
    return () => window.removeEventListener('app-trigger-print', onTrigger);
  }, [isActive, tabId, handlePrint]);

  // Start comparison
  const handleStartCompare = useCallback(async () => {
    if (!store.fileA || !store.fileB) return;
    setError('');
    setIsCancelling(false);
    setPhase('processing');
    store.setJobStatus('pending');
    store.setProgress(0);

    try {
      const { job_id } = await createCompareJob({
        file_a_id: store.fileA.id,
        file_b_id: store.fileB.id,
        comparison_mode: store.comparisonMode,
        page_matching_mode: store.pageMatchingMode,
        is_packaging_mode: store.isPackagingMode,
        tolerance: store.tolerance,
        dpi: store.dpi,
      });
      if (!mountedRef.current) {
        void cancelCompareJob(job_id).catch(() => undefined);
        return;
      }
      store.setJobId(job_id);
      activeJobRef.current = job_id;

      pollingCleanupRef.current?.();
      pollingCleanupRef.current = null;

      let cancelled = false;
      let pollTimer: number | null = null;
      let stallTimer: number | null = null;
      let lastActivityAt = Date.now();
      let lastActivitySignature = '';
      const cleanupPolling = () => {
        cancelled = true;
        if (pollTimer !== null) {
          window.clearTimeout(pollTimer);
          pollTimer = null;
        }
        if (stallTimer !== null) {
          window.clearInterval(stallTimer);
          stallTimer = null;
        }
        if (pollingCleanupRef.current === cleanupPolling) {
          pollingCleanupRef.current = null;
        }
      };
      pollingCleanupRef.current = cleanupPolling;

      const pollJob = async (): Promise<boolean> => {
        if (cancelled) return true;
        try {
          const job = await getJobStatus(job_id);
          if (cancelled) return true;
          store.setJobStatus(job.status);

          // Mọi thay đổi quan sát được từ backend đều tính là "có tiến triển".
          const activitySignature = `${job.status}|${job.progress ?? 0}|${job.current_page ?? 0}|${job.status_message ?? ''}`;
          if (activitySignature !== lastActivitySignature) {
            lastActivitySignature = activitySignature;
            lastActivityAt = Date.now();
          }

          let message = t('tabs.compare:chuan_bi');
          if (job.status === 'processing') {
            if (job.status_message) message = job.status_message;
            else if (job.current_page && job.total_pages) message = t('tabs.compare:dang_so_sanh_trang_job_current_page_job', { cur: job.current_page, total: job.total_pages });
            else if (job.progress > 0) message = t('tabs.compare:dang_xu_ly_job_progress', { pct: job.progress });
          }

          store.setProgress(job.progress || 0, job.current_page || undefined, job.total_pages || undefined, message);

          if (job.status === 'completed') {
            const results = await getJobResults(job_id);
            if (cancelled) return true;
            store.setResults(results.pages, results.summary);
            activeJobRef.current = null;
            setPhase('results');
            cleanupPolling();
            return true;
          }
          if (job.status === 'failed') {
            setError(job.error_message || t('tabs.compare:co_loi_xay_ra_khi_so_sanh'));
            activeJobRef.current = null;
            setPhase('upload');
            cleanupPolling();
            return true;
          }
          if (job.status === 'cancelled') {
            store.setProgress(
              job.progress || 0,
              job.current_page || undefined,
              job.total_pages || undefined,
              job.status_message || t('tabs.compare:da_huy_so_sanh', 'Đã hủy so sánh.'),
            );
            setPhase('upload');
            setIsCancelling(false);
            activeJobRef.current = null;
            cleanupPolling();
            return true;
          }
        } catch (pollErr) {
          if (!cancelled) console.warn('Poll error:', pollErr);
        }
        return false;
      };

      const runPoll = async () => {
        const done = await pollJob();
        if (!done && !cancelled) {
          pollTimer = window.setTimeout(() => { void runPoll(); }, 2000);
        }
      };

      stallTimer = window.setInterval(() => {
        if (cancelled) return;
        if (Date.now() - lastActivityAt < COMPARE_STALL_TIMEOUT_MS) return;
        cleanupPolling();
        if (useComparisonStore.getState().jobStatus !== 'completed') {
          activeJobRef.current = null;
          void cancelCompareJob(job_id).catch(() => undefined);
          setError(t('tabs.compare:job_khong_co_tien_trien_trong_5_phut'));
          setPhase('upload');
        }
      }, COMPARE_STALL_CHECK_INTERVAL_MS);
      void runPoll();
    } catch (e: unknown) {
      // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
      // (PB-3: deadline cứng 10 phút đã thay bằng watchdog theo tiến độ ở trên)
      if (!isCanceled(e)) setError(formatError(e, t('tabs.compare:khong_the_tao_job')));
      setPhase('upload');
    }
  }, [store, t]);

  const handleCancelCompare = useCallback(async () => {
    const jobId = store.jobId;
    if (!jobId || isCancelling) return;

    setIsCancelling(true);
    setError('');
    store.setProgress(
      store.progress,
      store.currentPage || undefined,
      store.totalPages || undefined,
      'Đang dừng và dọn kết quả dở dang...',
    );
    try {
      const result = await cancelCompareJob(jobId);
      if (!result.cancelled) {
        setError(result.message);
        return;
      }
      pollingCleanupRef.current?.();
      pollingCleanupRef.current = null;
      activeJobRef.current = null;
      store.resetJob();
      setPhase('upload');
      toast.info(t('tabs.compare:da_huy_so_sanh', 'Đã hủy so sánh.'));
    } catch (e: unknown) {
      setError(formatError(e, 'Không thể hủy job so sánh.'));
    } finally {
      setIsCancelling(false);
    }
  }, [isCancelling, store, t]);

  const handleReset = useCallback(() => {
    pollingCleanupRef.current?.();
    pollingCleanupRef.current = null;
    const activeJobId = activeJobRef.current;
    activeJobRef.current = null;
    if (activeJobId) void cancelCompareJob(activeJobId).catch(() => undefined);
    store.reset();
    setPhase('upload');
    setError('');
    setIsCancelling(false);
    setScrollToPage(0);
    setScrollToBPage(0);
  }, [store]);

  const diffRegions: DiffRegionData[] = store.results.flatMap((page) =>
    page.diff_regions.map((r) => ({
      x: r.x, y: r.y, width: r.width, height: r.height,
      type: r.type, severity: r.severity, page: page.page_number, b_page: r.b_page, description: r.description,
    })),
  );
  const overallStatus = store.summary?.overall_status;
  const printVerdict = store.summary?.print_verdict;
  const totalDiffCount = typeof store.summary?.total_diff_count === 'number'
    ? store.summary.total_diff_count
    : 0;
  const visualSimilarity = typeof store.summary?.visual_similarity === 'number'
    ? store.summary.visual_similarity
    : store.summary?.average_similarity;

  // UPLOAD PHASE
  if (phase === 'upload') {
    return (
      <div className="flex-1 overflow-y-auto w-full h-full">
        <div className="max-w-5xl mx-auto px-6 py-12 h-full flex flex-col items-center">
          <div className="text-center mb-10 animate-fade-in">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">{t('tabs.compare:so_sanh_pdf')}</h1>
            <p className="text-slate-600 dark:text-zinc-400 transition-colors">
              {t('tabs.compare:ho_tro_tu_dong_nhan_dien_va_giam_sat')}
            </p>
          </div>

          <div className="upload-grid w-full">
            <PDFUploader
              label={t('tabs.compare:pdf_goc_template')}
              sublabel={t('tabs.compare:file_truoc_khi_sua_hoac_ban_mau')}
              onFileSelected={handleUploadA}
              acceptImages
              isUploading={uploadingA}
              uploadedName={store.fileA?.original_name}
              pageCount={store.fileA?.page_count}
              accentColor="#3b82f6"
            />
            <PDFUploader
              label={t('tabs.compare:pdf_da_sua_ban_in')}
              sublabel={t('tabs.compare:file_sau_khi_sua_hoac_to_in_ghep_kho')}
              onFileSelected={handleUploadB}
              acceptImages
              isUploading={uploadingB}
              uploadedName={store.fileB?.original_name}
              pageCount={store.fileB?.page_count}
              accentColor="#a855f7"
            />
          </div>

          <div className="glass-card p-6 mb-6 w-full mt-8">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-2 transition-colors">{t('tabs.compare:cai_dat_khoi_chay')}</h3>
            <p className="text-[11px] text-slate-500 dark:text-zinc-400 mb-4 leading-relaxed">
              So sánh <strong className="font-semibold text-slate-700 dark:text-zinc-300">pixel</strong>
              {' '}(những gì in ra thấy được) — không OCR.
              Có vùng khác = <strong className="text-red-600 dark:text-red-400">không đạt</strong>.
              % giống hình chỉ tham khảo. Khuyến nghị: Bình thường + 300 DPI.
            </p>
            <div className="settings-grid">
              <div>
                <label className="text-xs text-slate-500 dark:text-zinc-400 block mb-1.5 transition-colors">{t('tabs.compare:do_chinh_xac')}</label>
                <select
                  value={store.tolerance}
                  onChange={(e) => store.setTolerance(e.target.value)}
                  className="select-input"
                >
                  <option value="STRICT">{t('tabs.compare:nghiem_ngat_moi_pixel')}</option>
                  <option value="NORMAL">{t('tabs.compare:binh_thuong_bo_qua_nhieu_nho')}</option>
                  <option value="LOOSE">{t('tabs.compare:rong_chi_thay_doi_lon')}</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 dark:text-zinc-400 block mb-1.5 transition-colors">{t('tabs.compare:do_phan_giai')}</label>
                <select
                  value={store.dpi}
                  onChange={(e) => store.setDpi(Number(e.target.value))}
                  className="select-input"
                >
                  <option value={72}>72 DPI</option>
                  <option value={100}>100 DPI</option>
                  <option value={117}>117 DPI</option>
                  <option value={150}>150 DPI — Nhanh</option>
                  <option value={300}>{t('tabs.compare:300_dpi_chinh_xac')}</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 dark:text-zinc-400 block mb-1.5 transition-colors">
                  {'Gh\u00e9p trang'}
                </label>
                <select
                  value={store.pageMatchingMode}
                  onChange={(e) => store.setPageMatchingMode(e.target.value as 'auto' | 'sequential' | 'imposition')}
                  className="select-input"
                >
                  <option value="auto">{'T\u1ef1 \u0111\u1ed9ng'}</option>
                  <option value="sequential">{'Theo th\u1ee9 t\u1ef1 1:1'}</option>
                  <option value="imposition">{'B\u00ecnh b\u00e0i / Booklet'}</option>
                </select>
              </div>
              <div className="flex flex-col gap-3 justify-end">
                <label className="flex items-center gap-2.5 cursor-pointer group">
                  <div className="relative flex items-center flex-shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={store.comparisonMode === 'cmyk'}
                      onChange={(e) => store.setComparisonMode(e.target.checked ? 'cmyk' : 'full')}
                    />
                    <div className="w-9 h-5 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-md peer-checked:bg-blue-500 peer-checked:border-blue-600 shadow-inner transition-all duration-300"></div>
                    <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-sm h-[14px] w-[14px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[16px]"></div>
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-slate-700 dark:text-zinc-200">CMYK</span>
                    <span className="text-[10px] text-slate-400 dark:text-zinc-500 ml-1.5">{t('tabs.compare:tach_kenh_mau_in')}</span>
                  </div>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer group">
                  <div className="relative flex items-center flex-shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={store.isPackagingMode}
                      onChange={(e) => store.setIsPackagingMode(e.target.checked)}
                    />
                    <div className="w-9 h-5 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-md peer-checked:bg-blue-500 peer-checked:border-blue-600 shadow-inner transition-all duration-300"></div>
                    <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-sm h-[14px] w-[14px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[16px]"></div>
                  </div>
                  <div>
                    <span className="text-xs font-semibold text-slate-700 dark:text-zinc-200">{t('tabs.compare:bao_bi')}</span>
                    <span className="text-[10px] text-slate-400 dark:text-zinc-500 ml-1.5">{t('tabs.compare:xep_long_khop')}</span>
                  </div>
                </label>
              </div>
              <div className="flex items-end">
                <Button
                  onClick={handleStartCompare}
                  disabled={!store.fileA || !store.fileB || uploadingA || uploadingB}
                  variant="primary"
                  fullWidth
                >
                  {t('preprocess.common:run')}
                </Button>
              </div>
            </div>
          </div>

          {error && (
            <div className="error-banner animate-slide-up bg-red-500/10 border border-red-500/20 text-red-600 w-full mt-4 mb-12">❌ {error}</div>
          )}
        </div>
        {printDialog}
      </div>
    );
  }

  // PROCESSING PHASE
  if (phase === 'processing') {
    return (
      <div className="flex-1 w-full h-full bg-slate-50 dark:bg-zinc-950 transition-colors">
        {printDialog}
        <div className="max-w-3xl mx-auto px-6 py-20">
          <ProgressTracker
            progress={store.progress}
            status={store.jobStatus}
            currentPage={store.currentPage}
            totalPages={store.totalPages}
            message={store.progressMessage}
          />
          <div className="mt-6 flex justify-center">
            <Button
              onClick={() => { void handleCancelCompare(); }}
              disabled={!store.jobId || isCancelling}
              variant="secondary"
            >
              {isCancelling ? 'Đang hủy...' : 'Hủy so sánh'}
            </Button>
          </div>
          {error && (
            <div className="error-banner mt-6 text-center">
              {error}
              <button onClick={handleReset} className="ml-4 text-blue-400 underline">
                {t('tabs.compare:thu_lai')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // RESULTS PHASE
  return (
    <div className="results-layout flex flex-col h-full w-full overflow-hidden bg-slate-50 dark:bg-zinc-950 transition-colors">
      <header className="results-header shrink-0 px-4 py-2 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <Button onClick={handleReset} variant="ghost" size="sm">{t('tabs.compare:so_sanh_moi')}</Button>
          <span className="w-px h-6 bg-black/10 mx-2 transition-colors dark:bg-white/10"></span>
          <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200">
             {store.fileA?.original_name} ↔ {store.fileB?.original_name}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {store.summary && (
             <div className="flex items-center gap-3 mr-4">
                <span className={`px-2 py-1 text-[11px] font-bold rounded ${
                   overallStatus === 'PASS' ? 'bg-green-100 text-green-700' :
                   overallStatus === 'FAIL' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                 }`}>
                   {typeof printVerdict === 'string'
                     ? printVerdict
                     : (overallStatus === 'PASS' ? 'ĐẠT' : 'KHÔNG ĐẠT')}
                </span>
                <span className={`text-xs font-semibold ${
                   totalDiffCount === 0
                      ? 'text-green-700 dark:text-green-400'
                      : 'text-red-700 dark:text-red-400'
                 }`}>
                   {totalDiffCount === 0
                      ? '0 lỗi in'
                      : `${totalDiffCount} lỗi in — cần xử lý`}
                </span>
                <span
                  className="text-[11px] text-slate-400 dark:text-zinc-500"
                  title="Độ giống hình toàn trang (SSIM) — chỉ tham khảo. In ấn không chấm theo % pixel."
                >
                   Giống hình (tham khảo): {typeof visualSimilarity === 'number'
                     ? `${visualSimilarity}%`
                     : '—'}
                </span>
             </div>
          )}
          {store.jobId && (
            <Button onClick={() => setIsReportOpen(true)} variant="secondary" size="sm">{t('tabs.compare:xem_bao_cao')}</Button>
          )}
        </div>
      </header>

      <div className="results-content flex flex-1 overflow-hidden">
        {store.fileA && store.fileB && (
          <DualPDFViewer
            leftPdfUrl={getFileUrl(store.fileA.id)}
            rightPdfUrl={getFileUrl(store.fileB.id)}
            diffRegions={diffRegions}
            scrollToPage={scrollToPage}
            scrollToBPage={scrollToBPage}
            focusedRegion={focusedRegion}
          />
        )}
        <DiffSidebar
          results={store.results}
          summary={store.summary}
          onPageClick={(pageNum) => {
            setScrollToPage(pageNum);
            const matched = store.results.find((page) => page.page_number === pageNum)?.matched_b_page;
            setScrollToBPage(matched || pageNum);
          }}
          activePage={scrollToPage}
          onPlayGif={setActiveGif}
          onRegionClick={(page, nx, ny) => {
            setScrollToPage(page);
            setFocusedRegion({ page, nx, ny });
          }}
        />
      </div>

      {isReportOpen && <ReportModal onClose={() => setIsReportOpen(false)} />}
      
      {/* GIF viewer modal omited for brevity or kept here */}
      {/* GIF Modal - Full Screen */}
      {activeGif && (
        <div 
          className="fixed inset-0 z-[100] ohmyshot-grid flex items-center justify-center overflow-hidden"
          onClick={() => { setActiveGif(null); setGifZoom(1); setGifPan({ x: 0, y: 0 }); }}
          onWheel={(e) => {
             const delta = e.deltaY * -0.002;
             setGifZoom(z => Math.min(Math.max(0.2, z + delta), 10));
          }}
        >
          {/* Infinite Canvas Area */}
          <div 
             className={`absolute inset-0 w-full h-full flex items-center justify-center ${isSpacePressed ? (isGifDragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
             onPointerDown={(e) => {
                if (isSpacePressed) {
                   setIsGifDragging(true);
                   e.currentTarget.setPointerCapture(e.pointerId);
                }
             }}
             onPointerMove={(e) => {
                if (isGifDragging) {
                   setGifPan(p => ({ x: p.x + e.movementX, y: p.y + e.movementY }));
                }
             }}
             onPointerUp={(e) => {
                setIsGifDragging(false);
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                   e.currentTarget.releasePointerCapture(e.pointerId);
                }
             }}
             onClick={(e) => { if (isSpacePressed) e.stopPropagation(); }}
          >
             <button 
                className="fixed top-6 right-6 w-12 h-12 rounded-full bg-slate-800 hover:bg-slate-700 border border-white/20 text-white flex items-center justify-center transition-all z-[110] shadow-2xl backdrop-blur-md"
                onClick={() => { setActiveGif(null); setGifZoom(1); setGifPan({ x: 0, y: 0 }); }}
                title={t('tabs.compare:dong_esc')}
              >
                ✕
              </button>
              
              {/* Zoom Controls Bar */}
              <div 
                 className="fixed bottom-8 left-1/2 -translate-x-1/2 flex items-center justify-center gap-2 bg-[#27272a]/90 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10 shadow-[0_20px_40px_rgba(0,0,0,0.8)] z-[110] select-none"
                 onClick={(e) => e.stopPropagation()}
              >
                 <button 
                   className="w-10 h-10 rounded-lg hover:bg-white/10 flex items-center justify-center text-2xl font-light transition-colors text-white/90" 
                   onClick={() => setGifZoom(z => Math.max(0.2, z - 0.25))}
                   title={t('tabs.compare:thu_nho')}
                 >
                   -
                 </button>
                 <span className="w-16 text-center font-mono text-base font-medium text-white/90 tracking-wide">
                   {Math.round(gifZoom * 100)}%
                 </span>
                 <button 
                   className="w-10 h-10 rounded-lg hover:bg-white/10 flex items-center justify-center text-2xl font-light transition-colors text-white/90" 
                   onClick={() => setGifZoom(z => Math.min(10, z + 0.25))}
                   title={t('tabs.compare:phong_to')}
                 >
                   +
                 </button>
                 
                 <div className="w-px h-6 bg-white/20 mx-2"></div>
                 
                 <button 
                   className="px-4 py-2 rounded-lg hover:bg-white/10 text-sm font-semibold uppercase tracking-wider text-slate-300 transition-colors" 
                   onClick={() => { setGifZoom(1); setGifPan({ x: 0, y: 0 }); }}
                   title="Reset"
                 >
                   Reset
                 </button>
              </div>

             {/* printDialog portal lives at end of root */}
             <div 
               className="rounded-xl border border-white/10 shadow-[0_0_80px_rgba(168,85,247,0.15)] flex flex-col bg-[#141418]/60 origin-center select-none"
               style={{ 
                  transform: `translate(${gifPan.x}px, ${gifPan.y}px) scale(${gifZoom})`,
                  willChange: 'transform'
               }}
               onClick={(e) => e.stopPropagation()}
             >
                <img 
                  src={activeGif} 
                  alt="Comparison Animation" 
                  className="rounded-lg object-contain max-w-[90vw] max-h-[90vh] pointer-events-none"
                  draggable={false}
                />
             </div>
          </div>
        </div>
      )}

      {printDialog}
    </div>
  );
}
