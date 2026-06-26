import { useState, useCallback, useEffect } from 'react';
import { useComparisonStore } from '../stores/comparisonStore';
import { uploadPDF, createCompareJob, getJobStatus, getJobResults, getFileUrl } from '../lib/api';
import PDFUploader from './PDFUploader';
import ProgressTracker from './ProgressTracker';
import DualPDFViewer from './DualPDFViewer';
import type { DiffRegionData } from './DualPDFViewer';
import DiffSidebar from './DiffSidebar';
import SettingsModal from './SettingsModal';
import ReportModal from './ReportModal';
import { Button } from './Button';
import { ThemeToggle } from './ThemeToggle';

type Phase = 'upload' | 'processing' | 'results';

export default function CompareTab() {
  const store = useComparisonStore();
  const [phase, setPhase] = useState<Phase>('upload');
  const [uploadingA, setUploadingA] = useState(false);
  const [uploadingB, setUploadingB] = useState(false);
  const [error, setError] = useState('');
  const [scrollToPage, setScrollToPage] = useState(0);
  const [activeGif, setActiveGif] = useState<string | null>(null);
  const [gifZoom, setGifZoom] = useState(1);
  const [gifPan, setGifPan] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isGifDragging, setIsGifDragging] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [focusedRegion, setFocusedRegion] = useState<{page: number, nx: number, ny: number} | null>(null);

  // Keyboard globals for GIF Viewer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveGif(null);
        setGifZoom(1);
        setGifPan({ x: 0, y: 0 });
        setIsSettingsOpen(false);
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
  }, [activeGif]);

  const handleUploadB = useCallback(async (file: File) => {
    setUploadingB(true);
    setError('');
    try {
      const result = await uploadPDF(file);
      store.setFileB({ ...result, localFile: file });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload thất bại');
    } finally {
      setUploadingB(false);
    }
  }, [store]);

  const handleUploadA = useCallback(async (file: File, allFiles?: File[]) => {
    setUploadingA(true);
    setError('');
    try {
      const result = await uploadPDF(file);
      store.setFileA({ ...result, localFile: file });
      
      // Auto-fill File B if multiple files were dropped
      if (allFiles && allFiles.length > 1) {
         setTimeout(() => handleUploadB(allFiles[1]), 500);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload thất bại');
    } finally {
      setUploadingA(false);
    }
  }, [store, handleUploadB]);

  // Start comparison
  const handleStartCompare = useCallback(async () => {
    if (!store.fileA || !store.fileB) return;
    setError('');
    setPhase('processing');
    store.setJobStatus('pending');
    store.setProgress(0);

    try {
      const { job_id } = await createCompareJob({
        file_a_id: store.fileA.id,
        file_b_id: store.fileB.id,
        comparison_mode: store.comparisonMode,
        is_packaging_mode: store.isPackagingMode,
        tolerance: store.tolerance,
        dpi: store.dpi,
      });
      store.setJobId(job_id);

      const pollJob = async () => {
        try {
          const job = await getJobStatus(job_id);
          store.setJobStatus(job.status);

          let message = 'Chuẩn bị...';
          if (job.status === 'processing') {
            if (job.status_message) message = job.status_message;
            else if (job.current_page && job.total_pages) message = `Đang so sánh trang ${job.current_page}/${job.total_pages}`;
            else if (job.progress > 0) message = `Đang xử lý... (${job.progress}%)`;
          }

          store.setProgress(job.progress || 0, job.current_page || undefined, job.total_pages || undefined, message);

          if (job.status === 'completed') {
            const results = await getJobResults(job_id);
            store.setResults(results.pages, results.summary);
            setPhase('results');
            return true;
          } else if (job.status === 'failed') {
            setError(job.error_message || 'Có lỗi xảy ra khi so sánh');
            setPhase('upload');
            return true;
          }
        } catch (pollErr) {
          console.warn('Poll error:', pollErr);
        }
        return false;
      };

      const done = await pollJob();
      if (!done) {
        const pollInterval = setInterval(async () => {
          const isDone = await pollJob();
          if (isDone) clearInterval(pollInterval);
        }, 2000);
        // Hết thời gian chờ tối đa (10 phút): dừng poll VÀ báo lỗi rõ ràng thay vì
        // để UI kẹt mãi ở "đang xử lý" (audit so-sánh: poll dừng âm thầm).
        setTimeout(() => {
          clearInterval(pollInterval);
          if (useComparisonStore.getState().jobStatus !== 'completed') {
            setError('Quá thời gian chờ xử lý (10 phút). File có thể quá lớn hoặc máy chủ đang bận — thử lại với DPI thấp hơn hoặc chia nhỏ file PDF.');
            setPhase('upload');
          }
        }, 600000);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Không thể tạo job');
      setPhase('upload');
    }
  }, [store]);

  const handleReset = useCallback(() => {
    store.reset();
    setPhase('upload');
    setError('');
    setScrollToPage(0);
  }, [store]);

  const diffRegions: DiffRegionData[] = store.results.flatMap((page) =>
    page.diff_regions.map((r) => ({
      x: r.x, y: r.y, width: r.width, height: r.height,
      type: r.type, severity: r.severity, page: page.page_number, b_page: r.b_page, description: r.description,
    })),
  );

  // UPLOAD PHASE
  if (phase === 'upload') {
    return (
      <div className="flex-1 overflow-y-auto w-full h-full">
        <div className="max-w-5xl mx-auto px-6 py-12 h-full flex flex-col items-center">
          <div className="text-center mb-10 animate-fade-in">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3 transition-colors">🔍 So sánh PDF</h1>
            <p className="text-slate-600 dark:text-zinc-400 transition-colors">
              Hỗ trợ tự động nhận diện và giám sát lỗi trên tờ in Bình bài (Imposition).
            </p>
          </div>

          <div className="upload-grid w-full">
            <PDFUploader
              label="PDF Gốc / Template"
              sublabel="File trước khi sửa hoặc Bản mẫu"
              onFileSelected={handleUploadA}
              isUploading={uploadingA}
              uploadedName={store.fileA?.original_name}
              pageCount={store.fileA?.page_count}
              accentColor="#3b82f6"
            />
            <PDFUploader
              label="PDF Đã Sửa / Bản in"
              sublabel="File sau khi sửa hoặc Tờ in ghép khổ lớn"
              onFileSelected={handleUploadB}
              isUploading={uploadingB}
              uploadedName={store.fileB?.original_name}
              pageCount={store.fileB?.page_count}
              accentColor="#a855f7"
            />
          </div>

          <div className="glass-card p-6 mb-6 w-full mt-8">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 transition-colors">⚙️ Cài đặt & Khởi chạy</h3>
            <div className="settings-grid">
              <div>
                <label className="text-xs text-slate-500 dark:text-zinc-400 block mb-1.5 transition-colors">Độ chính xác</label>
                <select
                  value={store.tolerance}
                  onChange={(e) => store.setTolerance(e.target.value)}
                  className="select-input"
                >
                  <option value="STRICT">Nghiêm ngặt — Mọi pixel</option>
                  <option value="NORMAL">Bình thường — Bỏ qua nhiễu nhỏ</option>
                  <option value="LOOSE">Rộng — Chỉ thay đổi lớn</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-500 dark:text-zinc-400 block mb-1.5 transition-colors">Độ phân giải</label>
                <select
                  value={store.dpi}
                  onChange={(e) => store.setDpi(Number(e.target.value))}
                  className="select-input"
                >
                  <option value={150}>150 DPI — Nhanh</option>
                  <option value={300}>300 DPI — Chính xác</option>
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  onClick={handleStartCompare}
                  disabled={!store.fileA || !store.fileB || uploadingA || uploadingB}
                  variant="primary"
                  fullWidth
                >
                  🚀 Bắt đầu So sánh
                </Button>
              </div>
            </div>
          </div>

          {error && (
            <div className="error-banner animate-slide-up bg-red-500/10 border border-red-500/20 text-red-600 w-full mt-4 mb-12">❌ {error}</div>
          )}
        </div>
      </div>
    );
  }

  // PROCESSING PHASE
  if (phase === 'processing') {
    return (
      <div className="flex-1 w-full h-full bg-slate-50 dark:bg-zinc-950 transition-colors">
        <div className="max-w-3xl mx-auto px-6 py-20">
          <ProgressTracker
            progress={store.progress}
            status={store.jobStatus}
            currentPage={store.currentPage}
            totalPages={store.totalPages}
            message={store.progressMessage}
          />
          {error && (
            <div className="error-banner mt-6 text-center">
              {error}
              <button onClick={handleReset} className="ml-4 text-blue-400 underline">
                Thử lại
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
          <Button onClick={handleReset} variant="ghost" size="sm">← So sánh mới</Button>
          <span className="w-px h-6 bg-black/10 mx-2 transition-colors dark:bg-white/10"></span>
          <span className="text-xs font-semibold text-slate-800 dark:text-zinc-200">
             {store.fileA?.original_name} ↔ {store.fileB?.original_name}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {store.summary && (
             <div className="flex items-center gap-2 mr-4">
                <span className={`px-2 py-1 text-[11px] font-bold rounded ${
                   (store.summary as any).overall_status === 'PASS' ? 'bg-green-100 text-green-700' : 
                   (store.summary as any).overall_status === 'FAIL' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                }`}>
                   {(store.summary as any).overall_status}
                </span>
                <span className="text-xs text-slate-600 dark:text-zinc-400 ml-2">
                   Tương đồng: {(store.summary as any).average_similarity}%
                </span>
             </div>
          )}
          {store.jobId && (
            <Button onClick={() => setIsReportOpen(true)} variant="secondary" size="sm">📋 Xem Báo cáo</Button>
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
            focusedRegion={focusedRegion}
          />
        )}
        <DiffSidebar
          results={store.results}
          summary={store.summary}
          onPageClick={(pageNum) => setScrollToPage(pageNum)}
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
                title="Đóng (Esc)"
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
                   title="Thu nhỏ"
                 >
                   -
                 </button>
                 <span className="w-16 text-center font-mono text-base font-medium text-white/90 tracking-wide">
                   {Math.round(gifZoom * 100)}%
                 </span>
                 <button 
                   className="w-10 h-10 rounded-lg hover:bg-white/10 flex items-center justify-center text-2xl font-light transition-colors text-white/90" 
                   onClick={() => setGifZoom(z => Math.min(10, z + 0.25))}
                   title="Phóng to"
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

    </div>
  );
}
