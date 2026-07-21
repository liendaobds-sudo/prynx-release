import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Virtuoso } from 'react-virtuoso';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface DiffRegionData {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
  severity: string;
  page: number;
  b_page?: number;
  description?: string;
}

export interface FocusedRegion {
  page: number;
  nx?: number;
  ny?: number;
}

interface Props {
  leftPdfUrl: string;
  rightPdfUrl: string;
  diffRegions: DiffRegionData[];
  scrollToPage?: number;
  scrollToBPage?: number;
  focusedRegion?: FocusedRegion | null;
}

const SEVERITY_STYLES: Record<string, { bg: string; border: string }> = {
  high:   { bg: 'rgba(239, 68, 68, 0.28)', border: '#ef4444' },
  medium: { bg: 'rgba(251, 146, 60, 0.22)', border: '#fb923c' },
  low:    { bg: 'rgba(250, 204, 21, 0.18)', border: '#facc15' },
};

/**
 * A single PDF page with diff overlay.
 * Uses ResizeObserver on the actual <canvas> element rendered by react-pdf
 * to get the exact pixel dimensions, ensuring the overlay matches perfectly.
 */
function PageWithOverlay({
  pageNum,
  pageWidth,
  regions,
  side,
}: {
  pageNum: number;
  pageWidth: number;
  regions: DiffRegionData[];
  side: 'left' | 'right';
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);
  
  // Decoupled region routing
  const pageRegions = regions.filter((r) => side === 'right' && r.b_page ? r.b_page === pageNum : r.page === pageNum);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const measure = () => {
      const canvas = wrapper.querySelector('canvas');
      if (canvas) {
        setCanvasSize({ w: canvas.width, h: canvas.height });
      }
    };

    const timer = setTimeout(measure, 300);
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [pageNum, pageWidth]);

  return (
    <div
      ref={wrapperRef}
      id={`page-${side}-${pageNum}`}
      style={{
        position: 'relative',
        marginBottom: '40px',
        overflow: 'hidden',
        background: 'white',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05)',
        alignSelf: 'center',
        margin: '0 auto 40px auto',
        width: pageWidth,
      }}
    >
      <Page
        pageNumber={pageNum}
        width={pageWidth}
        renderAnnotationLayer={false}
        renderTextLayer={false}
      />

      {/* Dark mask overlay with cutouts for diff regions (spotlight effect) */}
      {side === 'right' && canvasSize && pageRegions.length > 0 && (
        <>
          {/* SVG mask: dark overlay with transparent cutouts */}
          <svg
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: canvasSize.w,
              height: canvasSize.h,
              pointerEvents: 'none',
              zIndex: 10,
            }}
          >
            <defs>
              <mask id={`mask-page-${pageNum}`}>
                <rect width="100%" height="100%" fill="white" />
                {pageRegions.map((region, idx) => {
                  const pad = 8;
                  const rx = Math.max(0, region.x * canvasSize.w - pad);
                  const ry = Math.max(0, region.y * canvasSize.h - pad);
                  const rw = Math.min(canvasSize.w - rx, region.width * canvasSize.w + pad * 2);
                  const rh = Math.min(canvasSize.h - ry, region.height * canvasSize.h + pad * 2);
                  return (
                    <rect key={idx} x={rx} y={ry} width={rw} height={rh} rx="5" fill="black" />
                  );
                })}
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="rgba(0,0,0,0.5)"
              mask={`url(#mask-page-${pageNum})`}
            />
          </svg>

          {/* Colored borders around each diff region */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: canvasSize.w,
              height: canvasSize.h,
              pointerEvents: 'none',
              zIndex: 11,
            }}
          >
            {pageRegions.map((region, idx) => {
              const colors = SEVERITY_STYLES[region.severity] || SEVERITY_STYLES.medium;
              const pad = 8;
              const hasSemanticData = region.type === 'cmyk' || region.type === 'text';
              
              return (
                <div
                  key={idx}
                  title={hasSemanticData ? region.description : undefined}
                  style={{
                    position: 'absolute',
                    left: Math.max(0, region.x * canvasSize.w - pad),
                    top: Math.max(0, region.y * canvasSize.h - pad),
                    width: Math.min(canvasSize.w, region.width * canvasSize.w + pad * 2),
                    height: Math.min(canvasSize.h, region.height * canvasSize.h + pad * 2),
                    border: `2px solid ${colors.border}`,
                    borderRadius: '5px',
                    boxShadow: `0 0 12px ${colors.border}60, inset 0 0 4px ${colors.border}20`,
                    pointerEvents: hasSemanticData ? 'auto' : 'none',
                    cursor: hasSemanticData ? 'help' : 'default',
                  }}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

class DualViewerErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean}> {
  constructor(props: any) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) return <div className="flex-1 w-full h-full bg-slate-100 dark:bg-zinc-900 flex items-center justify-center text-red-500 font-medium">{tv('Lỗi hiển thị PDF (react-pdf). Vui lòng tải lại ứng dụng.')}</div>;
    return this.props.children;
  }
}

export default function DualPDFViewerInnerWrapper(props: Props) {
  return (
    <DualViewerErrorBoundary>
      <DualPDFViewerInner {...props} />
    </DualViewerErrorBoundary>
  );
}

function DualPDFViewerInner({
  leftPdfUrl,
  rightPdfUrl,
  diffRegions,
  scrollToPage,
  scrollToBPage,
  focusedRegion,
}: Props) {
  const { t } = useTranslation();
  const [leftNumPages, setLeftNumPages] = useState(0);
  const [rightNumPages, setRightNumPages] = useState(0);
  
  // Pane Layout and Resizer State
  const [leftPanePercent, setLeftPanePercent] = useState(50);
  const dragSashRef = useRef(false);

  // Right Pane Fullscreen State  
  const [isRightFullscreen, setIsRightFullscreen] = useState(false);
  
  // Virtuoso refs for scroll-to-page
  const leftVirtuosoRef = useRef<any>(null);
  const rightVirtuosoRef = useRef<any>(null);

  // Scroller element refs for proper cleanup
  const leftScrollerRef = useRef<HTMLElement | null>(null);
  const rightScrollerRef = useRef<HTMLElement | null>(null);
  const syncing = useRef(false);

  // Global Keyboard handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Escape') {
        setIsRightFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ref to block manual sync during programmatic scrolling
  const isProgrammaticScroll = useRef(false);
  const programmaticScrollTimer = useRef<any>(null);

  // Scroll to page via Virtuoso API
  useEffect(() => {
    if (scrollToPage && scrollToPage > 0) {
      const leftIndex = scrollToPage - 1;
      const rightIndex = (scrollToBPage && scrollToBPage > 0 ? scrollToBPage : scrollToPage) - 1;
      isProgrammaticScroll.current = true;
      if (programmaticScrollTimer.current) clearTimeout(programmaticScrollTimer.current);
      
      leftVirtuosoRef.current?.scrollToIndex({ index: leftIndex, behavior: 'smooth', align: 'start' });
      rightVirtuosoRef.current?.scrollToIndex({ index: rightIndex, behavior: 'smooth', align: 'start' });
      
      programmaticScrollTimer.current = setTimeout(() => {
        isProgrammaticScroll.current = false;
      }, 800); // Wait for smooth scroll to finish
    }
  }, [scrollToPage, scrollToBPage]);

  // Scroll to precise region coordinates
  useEffect(() => {
    if (focusedRegion && focusedRegion.page > 0) {
      const index = focusedRegion.page - 1;
      isProgrammaticScroll.current = true;
      if (programmaticScrollTimer.current) clearTimeout(programmaticScrollTimer.current);
      
      leftVirtuosoRef.current?.scrollToIndex({ index, behavior: 'smooth', align: 'start' });
      rightVirtuosoRef.current?.scrollToIndex({ index, behavior: 'smooth', align: 'start' });
      
      programmaticScrollTimer.current = setTimeout(() => {
        isProgrammaticScroll.current = false;
      }, 800);
    }
  }, [focusedRegion]);

  // Compute page widths dynamically (using state for reactivity on resize)
  const [winWidth, setWinWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const containerFlexWidth = winWidth - 380;
  const LEFT_RENDER_WIDTH = Math.max(300, Math.floor(containerFlexWidth * (leftPanePercent / 100) - 80));
  const RIGHT_RENDER_WIDTH = isRightFullscreen 
    ? Math.max(300, winWidth - 80) 
    : Math.max(300, Math.floor(containerFlexWidth * ((100 - leftPanePercent) / 100) - 80));

  // Synchronized scroll via scroller ref
  const handleLeftScroll = useCallback((e: any) => {
    if (syncing.current || isRightFullscreen || isProgrammaticScroll.current) return;
    syncing.current = true;
    const src = e.target || e.currentTarget;
    if (src) {
      const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
      const rightEl = document.getElementById('right-virtuoso-scroller');
      if (rightEl) {
        rightEl.scrollTop = ratio * (rightEl.scrollHeight - rightEl.clientHeight);
      }
    }
    requestAnimationFrame(() => { syncing.current = false; });
  }, [isRightFullscreen]);

  const handleRightScroll = useCallback((e: any) => {
    if (syncing.current || isRightFullscreen || isProgrammaticScroll.current) return;
    syncing.current = true;
    const src = e.target || e.currentTarget;
    if (src) {
      const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
      const leftEl = document.getElementById('left-virtuoso-scroller');
      if (leftEl) {
        leftEl.scrollTop = ratio * (leftEl.scrollHeight - leftEl.clientHeight);
      }
    }
    requestAnimationFrame(() => { syncing.current = false; });
  }, [isRightFullscreen]);

  // Cleanup scroll listeners on unmount
  useEffect(() => {
    return () => {
      if (leftScrollerRef.current) {
        leftScrollerRef.current.removeEventListener('scroll', handleLeftScroll);
      }
      if (rightScrollerRef.current) {
        rightScrollerRef.current.removeEventListener('scroll', handleRightScroll);
      }
    };
  }, [handleLeftScroll, handleRightScroll]);

  return (
    <>
      <style>{`
        /* Modern Dark Scrollbar for Virtuoso containers */
        #left-virtuoso-scroller::-webkit-scrollbar,
        #right-virtuoso-scroller::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        #left-virtuoso-scroller::-webkit-scrollbar-track,
        #right-virtuoso-scroller::-webkit-scrollbar-track {
          background: transparent;
        }
        #left-virtuoso-scroller::-webkit-scrollbar-thumb,
        #right-virtuoso-scroller::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.15);
          border-radius: 4px;
        }
        #left-virtuoso-scroller::-webkit-scrollbar-thumb:hover,
        #right-virtuoso-scroller::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.25);
        }
      `}</style>
      <div 
        className="flex flex-1 overflow-hidden h-full bg-slate-50 dark:bg-zinc-950 transition-colors pdf-grid-bg"
      >
        {/* LEFT: PDF Gốc */}
        <div
          className="flex flex-col border-r border-black/5 dark:border-white/10 shadow-[inset_-20px_0_20px_-20px_rgba(0,0,0,0.1)] transition-colors"
          style={{ width: `${leftPanePercent}%` }}
        >
          <div className="text-center text-xs font-semibold text-slate-600 dark:text-zinc-400 p-2 bg-slate-100/80 dark:bg-zinc-900/80 border-b border-black/5 dark:border-white/10 shrink-0 transition-colors">
            {t('misc.dualPDFViewerInner:pdf_goc_truoc_khi_sua')}
          </div>
          <Document
            file={leftPdfUrl}
            onLoadSuccess={({ numPages: n }) => setLeftNumPages(n)}
            loading={<div className="text-center p-8 text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.dualPDFViewerInner:dang_tai_pdf')}</div>}
            error={<div className="text-center p-8 text-red-500 dark:text-red-400 transition-colors">{t('misc.dualPDFViewerInner:khong_the_tai_pdf')}</div>}
            className="flex-1 flex flex-col relative min-h-0"
          >
            {leftNumPages > 0 && (
              <Virtuoso
                ref={leftVirtuosoRef}
                totalCount={leftNumPages}
                overscan={3}
                defaultItemHeight={LEFT_RENDER_WIDTH * 1.414}
                style={{ flex: 1 }}
                scrollerRef={(el) => { 
                  if (el && el instanceof HTMLElement) {
                    if (leftScrollerRef.current && leftScrollerRef.current !== el) {
                      leftScrollerRef.current.removeEventListener('scroll', handleLeftScroll);
                    }
                    el.id = 'left-virtuoso-scroller';
                    el.addEventListener('scroll', handleLeftScroll, { passive: true });
                    leftScrollerRef.current = el;
                  }
                }}
                itemContent={(index) => (
                  <div style={{ padding: '16px 32px' }}>
                    <PageWithOverlay
                      pageNum={index + 1}
                      pageWidth={LEFT_RENDER_WIDTH}
                      regions={[]}
                      side="left"
                    />
                  </div>
                )}
              />
            )}
          </Document>
        </div>

        {/* Draggable Splitter Sash */}
        {!isRightFullscreen && (
          <div 
            className="w-2 md:w-3 bg-slate-200 dark:bg-zinc-800/80 hover:bg-slate-300 dark:hover:bg-zinc-700 cursor-col-resize flex flex-col items-center justify-center border-x border-slate-300 dark:border-white/10 z-20 transition-colors"
            onPointerDown={(e) => {
              dragSashRef.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
            onPointerMove={(e) => {
              if (!dragSashRef.current) return;
              const container = e.currentTarget.parentElement;
              if (container) {
                const rect = container.getBoundingClientRect();
                const newPercent = ((e.clientX - rect.left) / rect.width) * 100;
                setLeftPanePercent(Math.max(20, Math.min(80, newPercent)));
              }
            }}
            onPointerUp={(e) => {
              dragSashRef.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
              document.body.style.cursor = 'default';
              document.body.style.userSelect = 'auto';
            }}
          >
            <div className="w-0.5 h-8 bg-slate-400 dark:bg-zinc-600 rounded-full transition-colors"></div>
          </div>
        )}

        {/* RIGHT: PDF Đã Sửa + Diff Overlay */}
        <div
          className={isRightFullscreen ? 'fixed inset-0 z-[100] ohmyshot-grid' : ''}
          style={{ 
            ...(isRightFullscreen ? {} : { flex: 1 }),
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="text-center relative text-xs font-semibold text-red-600 dark:text-red-400 p-2 bg-red-50/80 dark:bg-red-900/20 border-b border-red-600/10 dark:border-red-500/20 z-30 shrink-0 transition-colors">
            ✏️ PDF ĐÃ SỬA (Sau khi sửa)
            {diffRegions.length > 0 && (
              <span className="ml-2 text-red-500 opacity-80 transition-colors">
                — {diffRegions.length} vùng thay đổi
              </span>
            )}
            
            {/* Fullscreen Toggle Button */}
            {!isRightFullscreen && (
              <button 
                onClick={(e) => { e.stopPropagation(); setIsRightFullscreen(true); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-md border transition-all z-[60] bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 border-red-200 dark:border-red-500/30"
                title={t('misc.dualPDFViewerInner:toan_man_hinh')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
              </button>
            )}
          </div>

          {isRightFullscreen && (
            <button 
              className="fixed top-6 right-6 w-12 h-12 rounded-full bg-white dark:bg-zinc-800 hover:bg-slate-50 dark:hover:bg-zinc-700 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-white flex items-center justify-center transition-all z-[110] shadow-2xl backdrop-blur-md"
              onClick={(e) => { e.stopPropagation(); setIsRightFullscreen(false); }}
              title={t('misc.dualPDFViewerInner:dong_esc')}
            >
              ✕
            </button>
          )}

          <Document
            file={rightPdfUrl}
            onLoadSuccess={({ numPages: n }) => setRightNumPages(n)}
            loading={<div className="text-center p-8 text-slate-500 dark:text-zinc-400 transition-colors">{t('misc.dualPDFViewerInner:dang_tai_pdf')}</div>}
            error={<div className="text-center p-8 text-red-500 dark:text-red-400 transition-colors">{t('misc.dualPDFViewerInner:khong_the_tai_pdf')}</div>}
            className="flex-1 flex flex-col relative min-h-0"
          >
            {rightNumPages > 0 && (
              <Virtuoso
                ref={rightVirtuosoRef}
                totalCount={rightNumPages}
                overscan={3}
                defaultItemHeight={RIGHT_RENDER_WIDTH * 1.414}
                style={{ flex: 1 }}
                scrollerRef={(el) => { 
                  if (el && el instanceof HTMLElement) {
                    if (rightScrollerRef.current && rightScrollerRef.current !== el) {
                      rightScrollerRef.current.removeEventListener('scroll', handleRightScroll);
                    }
                    el.id = 'right-virtuoso-scroller';
                    el.addEventListener('scroll', handleRightScroll, { passive: true });
                    rightScrollerRef.current = el;
                  }
                }}
                itemContent={(index) => (
                  <div style={{ padding: '16px 32px' }}>
                    <PageWithOverlay
                      pageNum={index + 1}
                      pageWidth={RIGHT_RENDER_WIDTH}
                      regions={diffRegions}
                      side="right"
                    />
                  </div>
                )}
              />
            )}
          </Document>
        </div>
      </div>
    </>
  );
}
