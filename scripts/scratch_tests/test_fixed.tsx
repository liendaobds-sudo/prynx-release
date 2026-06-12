import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Virtuoso, VirtuosoGrid } from 'react-virtuoso';
import { PDFDocument, PDFName } from 'pdf-lib';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { getApiUrl } from '../lib/api';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';

import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { VdpPreviewImage, pageBlobCache, thumbCacheRef, renderPageToBlob } from './workspace/ViewerHelpers';
import { LivePageFrame } from './workspace/LivePageFrame';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  onExtractPages?: (indices: number[], deleteAfter: boolean) => void;
  onObjectDelete?: (objs: any[], pageNum: number) => void;
  fetchObjectsForPage?: (pageNum: number) => void;
  onVdpBoxCreate?: (box: { x: number; y: number; width: number; height: number; pageNum: number, type?: string }) => void;
  rightPanel?: React.ReactNode;
}

interface ViewerSnapshot {
    order: number[];
    selection: number[];
    lastSelected: number | null;
    rotations: Record<number, number>;
}




export default function AcrobatViewer({ onExtractPages, onObjectDelete, fetchObjectsForPage, onVdpBoxCreate, rightPanel }: Props) {
  // ═══ Read state from Zustand store ═══
  const {
    pdfUrl, bleedView, highlightedIssue, isSelectionMode, pdfObjectsByPage,
    selectedObjectIds, setSelectedObjectIds, hiddenObjectIds, selectionFileId,
    separationPlates, activeDashboardTool, vdpFields, selectedVdpFieldId,
    setSelectedVdpFieldId, setVdpFields, setIsSidebarOpen,
    setViewerPageOrder, setViewerPageRotations,
  } = useWorkspaceStore();

  const isVdpMode = activeDashboardTool === 'datamerge';
  const highlightBoxes = highlightedIssue ? [highlightedIssue] : undefined;
  const onToggleSidebar = setIsSidebarOpen;
  const onPageOrderChange = setViewerPageOrder;
  const onPageRotationsChange = setViewerPageRotations;
  const onObjectSelect = (ids: string[]) => setSelectedObjectIds(ids);
  const onVdpBoxSelect = (fieldId: string) => setSelectedVdpFieldId(fieldId);
  const onVdpFieldsChange = setVdpFields;
  const [numPages, setNumPages] = useState<number>(0);
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());
  const [cachedPages, setCachedPages] = useState<Map<string, { url: string; w: number; h: number }>>(new Map());
  const [cacheBaseWidth, setCacheBaseWidth] = useState(2500); // HIGH RES caching for ultra crisp zoom
  const [plateLabels, setPlateLabels] = useState<Record<number, string>>({});
  const [activePage, setActivePage] = useState<number>(1);
  const [pdfRef, setPdfRef] = useState<any>(null);
  const [pageDim, setPageDim] = useState<{w: number, h: number} | null>(null);
  const [pageWidthPt, setPageWidthPt] = useState<number>(595); // Default A4 width in points
  const [zoom, setZoom] = useState<number>(1);
  const [isThumbMenuOpen, setIsThumbMenuOpen] = useState(true);
  const [pageInput, setPageInput] = useState<string>('1');
  const [toolMode, setToolMode] = useState<'pointer' | 'hand'>('pointer');
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [isFitMenuOpen, setIsFitMenuOpen] = useState(false);
  const [isZoomMenuOpen, setIsZoomMenuOpen] = useState(false);
  const [isZoomEditing, setIsZoomEditing] = useState(false);
  const [zoomInputVal, setZoomInputVal] = useState('');
  const [fitMode, setFitMode] = useState<'width' | 'page' | 'custom'>('width');
  const [pageDisplayMode, setPageDisplayMode] = useState<'single_fit' | 'single_scroll' | 'two_fit' | 'two_scroll'>('single_scroll');
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const [thumbWidth, setThumbWidth] = useState(256); // Default sidebar width 256px
  const [thumbBaseWidth, setThumbBaseWidth] = useState(110); // Default thumbnail zoom width
  const isThumbResizing = useRef(false);
  
  // DND Page Order State
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set([0]));
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(0);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [hoverTargetIndex, setHoverTargetIndex] = useState<number | null>(null);
  
  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, visible: boolean } | null>(null);

  // Modal States
  const [isInsertModalOpen, setIsInsertModalOpen] = useState(false);
  const [insertLocation, setInsertLocation] = useState<'after' | 'before'>('after');
  const [insertTarget, setInsertTarget] = useState<'first' | 'last' | 'page'>('page');
  const [insertTargetPage, setInsertTargetPage] = useState(1);

  const [isExtractModalOpen, setIsExtractModalOpen] = useState(false);
  const [extractPagesStr, setExtractPagesStr] = useState('');
  const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);

  // Undo / Redo Stacks
  const [pastStack, setPastStack] = useState<ViewerSnapshot[]>([]);
  const [futureStack, setFutureStack] = useState<ViewerSnapshot[]>([]);

  const commitSnapshot = () => {
      setPastStack(prev => [...prev, {
          order: [...pageOrder],
          selection: Array.from(selectedIndices),
          lastSelected: lastSelectedIndex,
          rotations: { ...pageRotations }
      }]);
      setFutureStack([]);
  };

  // Sync callbacks
  useEffect(() => {
     onPageOrderChange?.(pageOrder);
  }, [pageOrder]);

  useEffect(() => {
     onPageRotationsChange?.(pageRotations);
  }, [pageRotations]);

  // Jump to highlighted issue
  useEffect(() => {
      if (highlightBoxes && highlightBoxes.length > 0) {
          const targetPage = highlightBoxes[0].page;
          if (targetPage && pageOrder.length > 0) {
              const index = pageOrder.findIndex(p => p === targetPage);
              if (index !== -1) {
                  // Wait a tick for the UI to settle
                  setTimeout(() => {
                      mainVirtuosoRef.current?.scrollToIndex({ index, behavior: 'auto', align: 'center' });
                      thumbVirtuosoRef.current?.scrollToIndex({ index, align: 'center' });
                      setActivePage(index + 1);
                      setSelectedIndices(new Set([index]));
                      setLastSelectedIndex(index);
                  }, 100);
              }
          }
      }
  }, [highlightBoxes, pageOrder]);

  // Reset pdfRef when URL changes to prevent stale document access during re-load
  useEffect(() => {
     setPdfRef(null);
     setNumPages(0);
  }, [pdfUrl]);

  // Generate cached thumbnail for a specific page+rotation combo
  const generateThumb = useCallback(async (pdf: any, pageNum: number, rotation: number, width: number) => {
      const cacheKey = `${pdfUrl}_${pageNum}_${rotation}_${width}`;
      if (thumbCacheRef.current.has(cacheKey)) {
          // STILL need to populate the local state if it's found in global cache!
          setThumbUrls(prev => new Map(prev).set(cacheKey, thumbCacheRef.current.get(cacheKey)!));
          return;
      }
      try {
          const page = await pdf.getPage(pageNum);
          const vp = page.getViewport({ scale: 1, rotation });
          const scale = width / vp.width;
          const scaledVp = page.getViewport({ scale, rotation });
          const canvas = document.createElement('canvas');
          canvas.width = scaledVp.width;
          canvas.height = scaledVp.height;
          const ctx = canvas.getContext('2d')!;
          await page.render({ canvasContext: ctx, viewport: scaledVp }).promise;
          const url = canvas.toDataURL('image/jpeg', 0.7);
          thumbCacheRef.current.set(cacheKey, url);
          canvas.width = 0; canvas.height = 0; // Free canvas memory immediately
          setThumbUrls(prev => new Map(prev).set(cacheKey, url));
      } catch (e) { /* page may not exist */ }
  }, [pdfUrl]);

  // Pre-generate thumbnails in batches when PDF loads
  useEffect(() => {
      if (isSelectionMode || isVdpMode) setToolMode('pointer');
  }, [isSelectionMode, isVdpMode]);

  useEffect(() => {
      if (!pdfRef || numPages === 0) return;
      let cancelled = false;
      const batchSize = 6;
      const genBatch = async (startIdx: number) => {
          if (cancelled) return;
          const end = Math.min(startIdx + batchSize, numPages);
          for (let i = startIdx; i < end; i++) {
              if (cancelled) return;
              const pageNum = i + 1;
              const rot = pageRotations[pageNum] || 0;
              await generateThumb(pdfRef, pageNum, rot, 400);
          }
          if (end < numPages) {
              requestAnimationFrame(() => genBatch(end));
          }
      };
      genBatch(0);
      return () => { cancelled = true; };
  }, [pdfRef, numPages, generateThumb]);

  // Regenerate thumbnails whose rotation changed
  useEffect(() => {
      if (!pdfRef) return;
      for (const [pageNumStr, rot] of Object.entries(pageRotations)) {
          const pageNum = parseInt(pageNumStr);
          if (pageNum > 0 && pageNum <= numPages) {
              generateThumb(pdfRef, pageNum, rot, 400);
          }
      }
  }, [pdfRef, pageRotations, numPages, generateThumb]);

  // â”€â”€ MAIN VIEWER PAGE CACHE â”€â”€
  // Pre-render all pages at a base resolution for instant display
  useEffect(() => {
      if (!pdfRef || numPages === 0) return;
      let cancelled = false;
      const batchSize = 3; // fewer per batch = less UI blocking
      
      const genBatch = async (startIdx: number) => {
          if (cancelled) return;
          const end = Math.min(startIdx + batchSize, numPages);
          for (let i = startIdx; i < end; i++) {
              if (cancelled) return;
              const pageNum = i + 1;
              const rot = pageRotations[pageNum] || 0;
              const cacheKey = `${pdfUrl}_${pageNum}_${rot}`;
              // Skip if already cached at this rotation
              if (pageBlobCache.has(cacheKey)) {
                  setCachedPages(prev => {
                      if (prev.has(cacheKey)) return prev;
                      const existing = pageBlobCache.get(cacheKey)!;
                      return new Map(prev).set(cacheKey, JSON.parse(existing));
                  });
                  continue;
              }
              const result = await renderPageToBlob(pdfRef, pageNum, rot, cacheBaseWidth);
              if (result && !cancelled) {
                  pageBlobCache.set(cacheKey, JSON.stringify(result));
                  setCachedPages(prev => new Map(prev).set(cacheKey, result));
              }
          }
          if (end < numPages && !cancelled) {
              // Use setTimeout to yield to the event loop
              setTimeout(() => genBatch(end), 16);
          }
      };
      genBatch(0);
      return () => { cancelled = true; };
  }, [pdfRef, numPages, cacheBaseWidth, pdfUrl]);

  // Re-render pages whose rotation changed
  useEffect(() => {
      if (!pdfRef) return;
      let cancelled = false;
      const regenRotated = async () => {
          for (const [pageNumStr, rot] of Object.entries(pageRotations)) {
              if (cancelled) return;
              const pageNum = parseInt(pageNumStr);
              const cacheKey = `${pdfUrl}_${pageNum}_${rot}`;
              if (pageBlobCache.has(cacheKey)) continue;
              // Revoke old blob if exists
              for (const [k, v] of pageBlobCache.entries()) {
                  if (k.startsWith(`${pdfUrl}_${pageNum}_`) && k !== cacheKey) {
                      try { URL.revokeObjectURL(JSON.parse(v).url); } catch {}
                      pageBlobCache.delete(k);
                  }
              }
              const result = await renderPageToBlob(pdfRef, pageNum, rot, cacheBaseWidth);
              if (result && !cancelled) {
                  pageBlobCache.set(cacheKey, JSON.stringify(result));
                  setCachedPages(prev => {
                      const next = new Map(prev);
                      // Remove old rotation entries for this page
                      for (const k of next.keys()) {
                          if (k.startsWith(`${pdfUrl}_${pageNum}_`) && k !== cacheKey) next.delete(k);
                      }
                      return next.set(cacheKey, result);
                  });
              }
          }
      };
      regenRotated();
      return () => { cancelled = true; };
  }, [pdfRef, pageRotations, cacheBaseWidth, pdfUrl]);
  
  // Rotate Modal States
  const [isRotateModalOpen, setIsRotateModalOpen] = useState(false);
  const [rotateDirection, setRotateDirection] = useState('90');
  const [rotateRange, setRotateRange] = useState('selection');
  const [rotateFrom, setRotateFrom] = useState(1);
  const [rotateTo, setRotateTo] = useState(1);
  const [rotateFilter, setRotateFilter] = useState('all');
  const [rotateOrientation, setRotateOrientation] = useState('any');
  const [isRotating, setIsRotating] = useState(false);
  
  // Quick Actions States
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  
  // Advanced Delete Modal States
  const [isAdvDeleteModalOpen, setIsAdvDeleteModalOpen] = useState(false);
  const [advDeleteRange, setAdvDeleteRange] = useState('selection');
  const [advDeleteFrom, setAdvDeleteFrom] = useState(1);
  const [advDeleteTo, setAdvDeleteTo] = useState(1);
  
  // Spacebar panning state
  const prevToolModeRef = useRef<'pointer' | 'hand'>('pointer');
  const isSpacebarHeldRef = useRef(false);

  const undo = () => {
      if (pastStack.length === 0) return;
      const prev = pastStack[pastStack.length - 1];
      const newPast = pastStack.slice(0, -1);
      
      setFutureStack(prevFuture => [{
          order: pageOrder,
          selection: Array.from(selectedIndices),
          lastSelected: lastSelectedIndex,
          rotations: pageRotations
      }, ...prevFuture]);
      
      setPastStack(newPast);
      
      setPageOrder(prev.order);
      setSelectedIndices(new Set(prev.selection));
      setLastSelectedIndex(prev.lastSelected);
      setPageRotations(prev.rotations);
  };
  
  const redo = () => {
      if (futureStack.length === 0) return;
      const next = futureStack[0];
      const newFuture = futureStack.slice(1);
      
      setPastStack(prevPast => [...prevPast, {
          order: pageOrder,
          selection: Array.from(selectedIndices),
          lastSelected: lastSelectedIndex,
          rotations: pageRotations
      }]);
      
      setFutureStack(newFuture);
      
      setPageOrder(next.order);
      setSelectedIndices(new Set(next.selection));
      setLastSelectedIndex(next.lastSelected);
      setPageRotations(next.rotations);
  };

  const handleQuickDeleteConfirm = () => {
      commitSnapshot();
      const newOrder = pageOrder.filter((_, idx) => !selectedIndices.has(idx));
      setPageOrder(newOrder);
      setSelectedIndices(new Set(newOrder.length > 0 ? [0] : []));
      setLastSelectedIndex(0);
      setIsDeleteModalOpen(false);
  };

  const handleAdvDeleteConfirm = () => {
      commitSnapshot();
      let deleteIndices = new Set<number>();
      
      if (advDeleteRange === 'selection') {
          deleteIndices = new Set(selectedIndices);
      } else {
          const start = Math.max(0, advDeleteFrom - 1);
          const end = Math.min(pageOrder.length - 1, advDeleteTo - 1);
          for (let i = start; i <= end; i++) {
              deleteIndices.add(i);
          }
      }

      const newOrder = pageOrder.filter((_, idx) => !deleteIndices.has(idx));
      setPageOrder(newOrder);
      setSelectedIndices(new Set(newOrder.length > 0 ? [0] : []));
      setLastSelectedIndex(0);
      setIsAdvDeleteModalOpen(false);
  };

  const handleDuplicate = () => {
      if (selectedIndices.size === 0) return;
      commitSnapshot();
      const selArray = Array.from(selectedIndices).sort((a,b) => a-b);
      const newOrder = [...pageOrder];
      let offset = 1;
      for (const idx of selArray) {
          newOrder.splice(idx + offset, 0, pageOrder[idx]);
          offset++;
      }
      setPageOrder(newOrder);
      setContextMenu(null);
  };

  const handleInsertBlankPage = () => {
      commitSnapshot();
      let targetIndex = 0;
      if (insertTarget === 'first') {
          targetIndex = insertLocation === 'before' ? 0 : 1;
      } else if (insertTarget === 'last') {
          targetIndex = insertLocation === 'before' ? pageOrder.length - 1 : pageOrder.length;
      } else {
          const p = Math.max(1, Math.min(pageOrder.length, insertTargetPage));
          targetIndex = insertLocation === 'before' ? p - 1 : p;
      }
      const newOrder = [...pageOrder];
      newOrder.splice(targetIndex, 0, -1);
      
      setPageOrder(newOrder);
      setIsInsertModalOpen(false);
      setContextMenu(null);
  };

  const handleExtractPages = () => {
      commitSnapshot();
      const indicesToExtract = new Set<number>();
      const parts = extractPagesStr.split(',');
      for (const p of parts) {
          const trimmed = p.trim();
          if (trimmed.includes('-')) {
              const [s, e] = trimmed.split('-');
              const start = parseInt(s);
              const end = parseInt(e);
              if (!isNaN(start) && !isNaN(end)) {
                  for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                      if (i >= 1 && i <= pageOrder.length) indicesToExtract.add(i - 1);
                  }
              }
          } else {
              const val = parseInt(trimmed);
              if (!isNaN(val) && val >= 1 && val <= pageOrder.length) {
                  indicesToExtract.add(val - 1);
              }
          }
      }
      
      if (indicesToExtract.size > 0 && onExtractPages) {
          const sorted = Array.from(indicesToExtract).sort((a,b) => a-b);
          onExtractPages(sorted.map(idx => pageOrder[idx]), extractDeleteAfter);
          if (extractDeleteAfter) {
              const newOrder = pageOrder.filter((_, idx) => !indicesToExtract.has(idx));
              setPageOrder(newOrder);
              // also adjust selection if needed, simplified: clear it
              setSelectedIndices(new Set());
          }
      }
      setIsExtractModalOpen(false);
      setContextMenu(null);
  };

  const handleQuickRotate = (degreesOffset: number) => {
      commitSnapshot();
      const nextRots = { ...pageRotations };
      selectedIndices.forEach(idx => {
          const originalPageNum = pageOrder[idx];
          if (originalPageNum && originalPageNum !== -1) {
              const current = nextRots[originalPageNum] || 0;
              nextRots[originalPageNum] = current + degreesOffset;
          }
      });
      setPageRotations(nextRots);
  };

  useEffect(() => {
      setPageInput(activePage.toString());
  }, [activePage]);

  useEffect(() => {
      const handleEscape = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
              setIsAdvDeleteModalOpen(false);
              setIsRotateModalOpen(false);
              setIsInsertModalOpen(false);
              setIsExtractModalOpen(false);
              setContextMenu(null);
              if (isRotateModalOpen && !isRotating) setIsRotateModalOpen(false);
          }
      };
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
  }, [isRotateModalOpen, isRotating, isAdvDeleteModalOpen]);

  const navigatePage = (newPage: number) => {
      if (numPages === 0) return;
      const index = Math.max(0, Math.min(numPages - 1, newPage - 1));
      setSelectedIndices(new Set([index]));
      setLastSelectedIndex(index);
      setActivePage(index + 1);
      mainVirtuosoRef.current?.scrollToIndex({ index, behavior: 'auto', align: 'start' });
  };

  const spacePressTimeRef = useRef<number>(0);

  // Global Keyboard Commands
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

        if (e.ctrlKey || e.metaKey) {
            if (e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            } else if (e.key.toLowerCase() === 'y') {
                e.preventDefault();
                redo();
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            // DONT intercept Delete if we are in Selection Mode or VDP Mode (let those tools handle it)
            if (isSelectionMode || isVdpMode) return;
            
            // ONLY intercept Delete if the thumbnail sidebar is focused
            if (!sidebarRef.current?.contains(document.activeElement)) return;
            
            e.preventDefault();
            setIsDeleteModalOpen(true);
        } else if (e.key === 'e') {
            e.preventDefault();
            const sortedSel = Array.from(selectedIndices).sort((a,b) => a-b).map(i => i+1);
            let str = sortedSel.length > 0 ? sortedSel.join(', ') : '';
            setExtractPagesStr(str);
            setIsExtractModalOpen(true);
        } else if (e.code === 'Space') {
            if (!e.repeat) {
                e.preventDefault();
                if (!isSpacebarHeldRef.current) {
                    isSpacebarHeldRef.current = true;
                    spacePressTimeRef.current = Date.now();
                    prevToolModeRef.current = toolMode;
                    setToolMode('hand');
                }
            } else {
                e.preventDefault();
            }
        }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        
        if (e.code === 'Space') {
            e.preventDefault();
            isSpacebarHeldRef.current = false;
            setToolMode(prevToolModeRef.current);
            
            if (Date.now() - spacePressTimeRef.current < 250) {
                if (e.shiftKey) {
                    navigatePage(activePage - 1);
                } else {
                    navigatePage(activePage + 1);
                }
            }
        }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keyup', handleKeyUp);
    };
  }, [pastStack, futureStack, pageOrder, selectedIndices, lastSelectedIndex, pageRotations, toolMode, isThumbMenuOpen, isDeleteModalOpen, activePage, numPages]);

  // 1pt PDF = 96/72 CSS px at 100% zoom
  const actualWidth100 = pageWidthPt * (96 / 72);


  
  const handleRotateConfirm = async () => {
      setIsRotating(true);
      let start = 1;
      let end = numPages;
      if (rotateRange === 'selection') {
          start = activePage;
          end = activePage;
      } else if (rotateRange === 'pages') {
          start = rotateFrom;
          end = rotateTo;
      }

      const deg = parseInt(rotateDirection);
      const nextRots = { ...pageRotations };
      
      commitSnapshot();

      for (let i = start; i <= end; i++) {
          if (rotateFilter === 'even' && i % 2 !== 0) continue;
          if (rotateFilter === 'odd' && i % 2 === 0) continue;
          
          let effectiveRot = nextRots[pageOrder[i - 1]] || 0;

          if (rotateOrientation !== 'any') {
              try {
                  const p = await pdfRef.getPage(i);
                  const vp = p.getViewport({ scale: 1 });
                  const currentR = nextRots[i] || 0;
                  const isLandscape = (currentR % 180 !== 0) ? (vp.width < vp.height) : (vp.width > vp.height);
                  
                  if (rotateOrientation === 'landscape' && !isLandscape) continue;
                  if (rotateOrientation === 'portrait' && isLandscape) continue;
              } catch (e) {
              }
          }
          nextRots[i] = (nextRots[i] || 0) + deg;
      }
      setPageRotations(nextRots);
      setIsRotating(false);
      setIsRotateModalOpen(false);
  };
  
  const thumbVirtuosoRef = useRef<any>(null);
  const mainVirtuosoRef = useRef<any>(null);
  const syncing = useRef(false);
  const scrollTimeout = useRef<any | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [mainWidth, setMainWidth] = useState(800);

  const applyFitWidth = () => {
      let fitW = mainWidth;
      if (internalScrollRef.current) {
          fitW = internalScrollRef.current.clientWidth;
      }
      const fitZoom = fitW / actualWidth100;
      setZoom(fitZoom);
      setFitMode('width');
      setPageDisplayMode('single_scroll');
      setIsFitMenuOpen(false);
  };

  const applyFitPage = () => {
      if (pageDim && containerRef.current) {
           const containerHeight = Math.max(100, containerRef.current.clientHeight - 60);
           const ratio = pageDim.w / pageDim.h;
           const targetWidth = containerHeight * ratio;
           const fitZoom = targetWidth / actualWidth100;
           setZoom(fitZoom);
      }
      setFitMode('page');
      setPageDisplayMode('single_fit');
      setIsFitMenuOpen(false);
  };

  useEffect(() => {
     if (fitMode === 'width' && actualWidth100 > 0) {
         let fitW = mainWidth;
         if (internalScrollRef.current) {
             fitW = internalScrollRef.current.clientWidth;
         }
         setZoom(fitW / actualWidth100);
     } else if (fitMode === 'page' && pageDim && containerRef.current) {
         const containerHeight = Math.max(100, containerRef.current.clientHeight - 60);
         const ratio = pageDim.w / pageDim.h;
         const targetWidth = containerHeight * ratio;
         setZoom(targetWidth / actualWidth100);
     }
  }, [mainWidth, fitMode, actualWidth100, pageDim, pageDisplayMode]);

  useEffect(() => {
    if (!containerRef.current) return;
    let frame: number;
    
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          setMainWidth(entries[0].contentRect.width - 2); 
        });
      }
    });
    
    observer.observe(containerRef.current);
    
    return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
    };
  }, []);

  const jumpCooldown = useRef(false);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            
            if (sidebarRef.current && sidebarRef.current.contains(e.target as Node)) {
                setThumbBaseWidth(w => {
                    const newW = w + e.deltaY * -0.1;
                    return Math.max(50, Math.min(400, newW));
                });
            } else {
                setZoom(z => {
                    const newZ = z + e.deltaY * -0.001; 
                    return Math.max(0.2, Math.min(5, newZ));
                });
                setFitMode('custom');
            }
        } else if (pageDisplayMode.includes('_fit') && containerRef.current && containerRef.current.contains(e.target as Node)) {
            const el = internalScrollRef.current;
            if (el && !jumpCooldown.current && numPages > 0) {
                const isAtBottom = Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 2;
                const isAtTop = el.scrollTop < 2;
                
                let didJump = false;
                if (e.deltaY > 0 && isAtBottom) {
                    const step = pageDisplayMode === 'two_fit' ? 2 : 1;
                    const next = Math.min(numPages, activePage + step);
                    if (next !== activePage) {
                        e.preventDefault();
                        navigatePage(next);
                        didJump = true;
                    }
                } else if (e.deltaY < 0 && isAtTop) {
                    const step = pageDisplayMode === 'two_fit' ? 2 : 1;
                    
                    let prev;
                    if (pageDisplayMode === 'two_fit') {
                       const logicalRowStart = (activePage - 1) % 2 === 0 ? activePage - 1 : activePage - 2;
                       prev = Math.max(1, logicalRowStart + 1 - step);
                    } else {
                       prev = Math.max(1, activePage - 1);
                    }
                    
                    if (prev !== activePage) {
                        e.preventDefault();
                        navigatePage(prev);
                        didJump = true;
                    }
                }

                if (didJump) {
                    jumpCooldown.current = true;
                    setTimeout(() => { jumpCooldown.current = false; }, 400); 
                }
            }
        }
    };
    
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => {
        window.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [pageDisplayMode, activePage, numPages]);

  const handleThumbClick = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    sidebarRef.current?.focus();
    if (e.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(index, lastSelectedIndex);
      const end = Math.max(index, lastSelectedIndex);
      const newSel = new Set(selectedIndices);
      for (let i = start; i <= end; i++) newSel.add(i);
      setSelectedIndices(newSel);
    } else if (e.ctrlKey || e.metaKey) {
      const newSel = new Set(selectedIndices);
      if (newSel.has(index)) newSel.delete(index);
      else newSel.add(index);
      setSelectedIndices(newSel);
      setLastSelectedIndex(index);
    } else {
      setSelectedIndices(new Set([index]));
      setLastSelectedIndex(index);
    }
    
    setActivePage(index + 1);
    mainVirtuosoRef.current?.scrollToIndex({ index, behavior: 'auto', align: 'start' });
  };

  const handleThumbResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      isThumbResizing.current = true;
      document.body.style.cursor = 'col-resize';
      
      const startX = e.clientX;
      const startWidth = thumbWidth;
      
      const sidebarEl = sidebarRef.current;

      const handleMouseMove = (me: MouseEvent) => {
          if (!isThumbResizing.current || !sidebarEl) return;
          const newWidth = Math.max(260, Math.min(800, startWidth + (me.clientX - startX)));
          sidebarEl.style.width = `${newWidth}px`;
      };

      const handleMouseUp = (me: MouseEvent) => {
          isThumbResizing.current = false;
          document.body.style.cursor = '';
          window.removeEventListener('mousemove', handleMouseMove);
          window.removeEventListener('mouseup', handleMouseUp);
          
          const finalWidth = Math.max(260, Math.min(800, startWidth + (me.clientX - startX)));
          setThumbWidth(finalWidth);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
  };

  const handleDragStartItem = (e: React.DragEvent, index: number) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
      
      let currentSelection = new Set(selectedIndices);
      if (!currentSelection.has(index)) {
          currentSelection = new Set([index]);
          setSelectedIndices(currentSelection);
          setLastSelectedIndex(index);
          setActivePage(index + 1);
      }
      setDraggedIndex(index);
  };

  const handleDragOverItem = (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
  };

  const handleDragEnterItem = (index: number) => {
      setHoverTargetIndex(index);
  };

  const handleDragLeaveItem = () => {
  };

  const handleDropItem = (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault();
      if (draggedIndex === null || selectedIndices.has(dropIndex)) {
         setDraggedIndex(null);
         setHoverTargetIndex(null);
         return;
      }

      const newOrder = [...pageOrder];
      const selArray = Array.from(selectedIndices).sort((a, b) => a - b);
      const selectedItems = selArray.map(idx => newOrder[idx]);
      
      commitSnapshot();
      
      const remainder = newOrder.filter((_, idx) => !selectedIndices.has(idx));
      
      let adjustedDropIndex = dropIndex;
      for (const idx of selArray) {
          if (idx < dropIndex) adjustedDropIndex--;
      }
      
      remainder.splice(adjustedDropIndex, 0, ...selectedItems);
      
      setPageOrder(remainder);
      
      const newSel = new Set<number>();
      for (let i = 0; i < selectedItems.length; i++) {
          newSel.add(adjustedDropIndex + i);
      }
      setSelectedIndices(newSel);
      setLastSelectedIndex(adjustedDropIndex + selectedItems.length - 1);
      
      setDraggedIndex(null);
      setHoverTargetIndex(null);
  };

  const handleDragEndItem = () => {
      setDraggedIndex(null);
      setHoverTargetIndex(null);
  };

  const internalScrollRef = useRef<HTMLElement | null>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, sx: 0, sy: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
      if (toolMode !== 'hand' || !internalScrollRef.current) return;
      e.preventDefault(); // Prevent native HTML dragging (like text/images) which swallows mousemove
      isDragging.current = true;
      dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          sx: internalScrollRef.current.scrollLeft,
          sy: internalScrollRef.current.scrollTop
      };
      
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';

      const handleDragMove = (me: MouseEvent) => {
          if (!isDragging.current || !internalScrollRef.current) return;
          const dx = me.clientX - dragStart.current.x;
          const dy = me.clientY - dragStart.current.y;
          internalScrollRef.current.scrollLeft = dragStart.current.sx - dx;
          internalScrollRef.current.scrollTop = dragStart.current.sy - dy;
      };

      const handleDragEnd = () => {
          isDragging.current = false;
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          window.removeEventListener('mousemove', handleDragMove);
          window.removeEventListener('mouseup', handleDragEnd);
      };

      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
  }, [toolMode]);

  const handleMainScroll = useCallback((e: any) => {
    if (syncing.current || pageDisplayMode.includes('_fit')) return;
    
    if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
    scrollTimeout.current = setTimeout(() => {
      const src = e.target || e.currentTarget;
      if (src && numPages > 0) {
        const scrollPercent = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
        const approxPage = Math.min(numPages, Math.max(1, Math.round(scrollPercent * numPages) + 1));
        setActivePage(approxPage);
        thumbVirtuosoRef.current?.scrollToIndex({ index: approxPage - 1, align: 'center' });
      }
    }, 150);
  }, [numPages, pageDisplayMode]);

  useEffect(() => {
    if (pdfRef && activePage > 0 && activePage <= numPages) {
        pdfRef.getPage(activePage).then((page: any) => {
            const vp = page.getViewport({ scale: 1 });
            setPageWidthPt(vp.width);
            setPageDim({ 
                w: vp.width * (25.4 / 72), 
                h: vp.height * (25.4 / 72) 
            });
        }).catch(() => {});
    }
  }, [pdfRef, activePage, numPages]);

  const renderRows = useMemo(() => {
      if (!pageOrder || pageOrder.length === 0) return [];
      const rows = [];
      if (pageDisplayMode === 'single_scroll') {
          return pageOrder.map((p, i) => ({ type: 'single', indices: [i], pages: [p] }));
      } else if (pageDisplayMode === 'two_scroll') {
          for (let i = 0; i < pageOrder.length; i += 2) {
              const row = { type: 'two', indices: [i], pages: [pageOrder[i]] };
              if (i + 1 < pageOrder.length) {
                  row.indices.push(i + 1);
                  row.pages.push(pageOrder[i + 1]);
              }
              rows.push(row);
          }
          return rows;
      } else if (pageDisplayMode === 'single_fit') {
          const idx = Math.max(0, Math.min(activePage - 1, pageOrder.length - 1));
          return [{ type: 'single', indices: [idx], pages: [pageOrder[idx]] }];
      } else if (pageDisplayMode === 'two_fit') {
          const idx = Math.max(0, Math.min(activePage - 1, pageOrder.length - 1));
          const rowStart = idx % 2 === 0 ? idx : idx - 1;
          const row = { type: 'two', indices: [rowStart], pages: [pageOrder[rowStart]] };
          if (rowStart + 1 < pageOrder.length) {
              row.indices.push(rowStart + 1);
              row.pages.push(pageOrder[rowStart + 1]);
          }
          return [row];
      }
      return [];
  }, [pageOrder, pageDisplayMode, activePage]);

  return (
    <div className="flex flex-col h-full w-full bg-[#f3f4f6] dark:bg-[#323639] text-slate-800 dark:text-slate-200 transition-colors overflow-hidden relative font-sans select-none">
      <style>{`
        .acro-scroll::-webkit-scrollbar { width: 14px; height: 14px; }
        .acro-scroll::-webkit-scrollbar-track { background: transparent; }
        .acro-scroll::-webkit-scrollbar-thumb { 
            background: #888888; 
            border: 4px solid #525659;
            border-radius: 8px; 
        }
        .acro-scroll::-webkit-scrollbar-thumb:hover { background: #aaaaaa; }
        .acro-thumb-scroll::-webkit-scrollbar { width: 12px; }
        .acro-thumb-scroll::-webkit-scrollbar-track { background: transparent; }
        .acro-thumb-scroll::-webkit-scrollbar-thumb { 
            background: #cccccc; 
            border: 3px solid #f8fafc;
            border-radius: 6px; 
        }
        .dark .acro-thumb-scroll::-webkit-scrollbar-thumb {
            background: #555;
            border: 3px solid #1f2937;
        }
      `}</style>
      
      <div className="h-12 w-full shrink-0 bg-[#f3f4f6] dark:bg-[#323639] border-b border-black/10 dark:border-white/10 flex items-center px-4 shadow-sm z-50 relative overflow-visible">
          <div className="flex items-center gap-1 mx-auto min-w-max">
              <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors" onClick={() => navigatePage(activePage - 1)} title="Previous Page">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16V8m-3 3l3-3 3 3"/></svg>
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors" onClick={() => navigatePage(activePage + 1)} title="Next Page">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8m-3-3l3 3 3-3"/></svg>
              </button>
              
              <div className="mx-2 flex items-center text-[13px] font-medium text-slate-600 dark:text-slate-300">
                 <input 
                    type="text" className="w-9 h-7 text-center border border-black/20 dark:border-white/20 rounded bg-white dark:bg-[#1e1e1e] mx-1 focus:outline-none focus:border-blue-500" 
                    value={pageInput} 
                    onChange={e => setPageInput(e.target.value)}
                    onBlur={() => navigatePage(parseInt(pageInput) || 1)}
                    onKeyDown={e => e.key === 'Enter' && navigatePage(parseInt(pageInput) || 1)}
                 /> 
                 <span className="mx-1">/</span> 
                 <span className="mr-1">{numPages || '-'}</span>
              </div>
              
              <div className="w-px h-5 bg-black/10 dark:bg-white/10 mx-2"></div>
              
              <button 
                  className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${toolMode === 'pointer' && !isSelectionMode && !isVdpMode ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300'}`} 
                  onClick={() => setToolMode('pointer')} title="Pointer Tool">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86 2.89 4.8 2.58-1.55-2.89-4.8 4.79-.19c.45-.02.66-.56.34-.86L5.5 3.21z"/></svg>
              </button>
              <button 
                  className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${toolMode === 'hand' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300'}`}
                  onClick={() => setToolMode('hand')} title="Pan Tool">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/>
                      <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/>
                      <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/>
                      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
                  </svg>
              </button>

              {isSelectionMode !== undefined && (
                  <button 
                      className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${isSelectionMode ? 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30 ring-1 ring-orange-300 dark:ring-orange-700' : 'hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300'}`}
                      onClick={() => {
                          window.dispatchEvent(new CustomEvent('toggle-selection-mode'));
                      }}
                      title="Selection Tool (Chá»n & Xóa chi tiết PDF)"
                  >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86 2.89 4.8 2.58-1.55-2.89-4.8 4.79-.19c.45-.02.66-.56.34-.86L5.5 3.21z"/></svg>
                  </button>
              )}

              <div className="w-px h-5 bg-black/10 dark:bg-white/10 mx-2"></div>

              <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors" onClick={() => { setZoom(z => Math.max(0.2, z - 0.2)); setFitMode('custom'); }} title="Zoom Out">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors" onClick={() => { setZoom(z => Math.min(5, z + 0.2)); setFitMode('custom'); }} title="Zoom In">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></svg>
              </button>
              
              <div className="relative mx-1 flex items-center">
                  {isZoomEditing ? (
                      <input
                          type="text"
                          autoFocus
                          className="w-16 h-7 text-center text-[13px] border border-blue-400 rounded bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none"
                          value={zoomInputVal}
                          onChange={(e) => setZoomInputVal(e.target.value.replace(/[^0-9]/g, ''))}
                          onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                  const val = parseInt(zoomInputVal);
                                  if (val >= 10 && val <= 500) { setZoom(val / 100); setFitMode('custom'); }
                                  setIsZoomEditing(false);
                              }
                              if (e.key === 'Escape') setIsZoomEditing(false);
                          }}
                          onBlur={() => {
                              const val = parseInt(zoomInputVal);
                              if (val >= 10 && val <= 500) { setZoom(val / 100); setFitMode('custom'); }
                              setIsZoomEditing(false);
                          }}
                      />
                  ) : (
                      <button
                          className="h-7 px-2 text-[13px] text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/10 rounded cursor-text transition-colors tabular-nums"
                          onClick={() => { setZoomInputVal(String(Math.round(zoom * 100))); setIsZoomEditing(true); }}
                          title="Nhấn Ä‘á»ƒ nhập tá»‰ lá»‡"
                      >
                          {Math.round(zoom * 100)}%
                      </button>
                  )}
                  <button
                      className="w-4 h-7 flex items-center justify-center text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 focus:outline-none transition-colors"
                      onClick={() => setIsZoomMenuOpen(!isZoomMenuOpen)}
                  >
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
                  </button>

                  {isZoomMenuOpen && (
                      <div className="absolute top-full right-0 mt-1 w-16 bg-white dark:bg-slate-800 rounded shadow-lg py-1 border border-black/10 dark:border-white/10 z-[100] animate-in fade-in zoom-in-95 duration-100">
                          {[25, 50, 75, 100, 150, 200, 300, 400].map(val => (
                              <button
                                  key={val}
                                  className="w-full text-center px-2 py-1.5 text-[13px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                  onClick={() => {
                                      setZoom(val / 100);
                                      setFitMode('custom');
                                      setIsZoomMenuOpen(false);
                                  }}
                              >
                                  {val}%
                              </button>
                          ))}
                      </div>
                  )}
                  {isZoomMenuOpen && (
                      <div className="fixed inset-0 z-40" onClick={() => setIsZoomMenuOpen(false)} />
                  )}
              </div>

              <div className="relative">
                  <button className={`h-8 px-1 flex items-center justify-center gap-1 rounded transition-colors ${isDisplayMenuOpen ? 'bg-black/10 dark:bg-white/20' : 'hover:bg-black/5 dark:hover:bg-white/10'} text-slate-700 dark:text-slate-300`} onClick={() => setIsDisplayMenuOpen(!isDisplayMenuOpen)} title="Page Display">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          {pageDisplayMode === 'single_fit' && <rect x="5" y="3" width="14" height="18" rx="2" />}
                          {pageDisplayMode === 'single_scroll' && <><rect x="5" y="2" width="14" height="9" rx="2" /><rect x="5" y="13" width="14" height="9" rx="2" /></>}
                          {pageDisplayMode === 'two_fit' && <><rect x="2" y="4" width="9" height="16" rx="2" /><rect x="13" y="4" width="9" height="16" rx="2" /></>}
                          {pageDisplayMode === 'two_scroll' && <><rect x="2" y="2" width="9" height="9" rx="2" /><rect x="13" y="2" width="9" height="9" rx="2" /><rect x="2" y="13" width="9" height="9" rx="2" /><rect x="13" y="13" width="9" height="9" rx="2" /></>}
                      </svg>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  {isDisplayMenuOpen && (
                      <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsDisplayMenuOpen(false)} />
                          <div className="absolute top-10 right-0 w-56 bg-white dark:bg-[#2d3236] border border-black/10 dark:border-white/10 shadow-xl rounded py-1 z-50 text-[13px] text-slate-700 dark:text-slate-200">
                              <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('single_fit'); setIsDisplayMenuOpen(false);}}>
                                  {pageDisplayMode === 'single_fit' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="3" width="14" height="18" rx="2" /></svg>
                                  <span>Xem má»™t trang</span>
                              </button>
                              <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('single_scroll'); setIsDisplayMenuOpen(false);}}>
                                  {pageDisplayMode === 'single_scroll' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="2" width="14" height="9" rx="2" /><rect x="5" y="13" width="14" height="9" rx="2" /></svg>
                                  <span>Bật cuá»™n trang</span>
                              </button>
                              <div className="w-full h-px bg-black/10 dark:bg-white/10 my-1" />
                              <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('two_fit'); setIsDisplayMenuOpen(false);}}>
                                  {pageDisplayMode === 'two_fit' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4" width="9" height="16" rx="2" /><rect x="13" y="4" width="9" height="16" rx="2" /></svg>
                                  <span>Xem hai trang</span>
                              </button>
                              <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={() => {setPageDisplayMode('two_scroll'); setIsDisplayMenuOpen(false);}}>
                                  {pageDisplayMode === 'two_scroll' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="9" height="9" rx="2" /><rect x="13" y="2" width="9" height="9" rx="2" /><rect x="2" y="13" width="9" height="9" rx="2" /><rect x="13" y="13" width="9" height="9" rx="2" /></svg>
                                  <span>Xem hai trang (Cuá»™n)</span>
                              </button>
                          </div>
                      </>
                  )}
              </div>

              <div className="relative mx-1">
                  <button className={`h-8 px-1 flex items-center justify-center gap-1 rounded transition-colors ${isFitMenuOpen ? 'bg-black/10 dark:bg-white/20' : 'hover:bg-black/5 dark:hover:bg-white/10'} text-slate-700 dark:text-slate-300`} onClick={() => setIsFitMenuOpen(!isFitMenuOpen)} title="Page Layout">
                      {fitMode === 'width' ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="4 3 4 8 20 8 20 3" />
                            <path d="M16 11H4v11h16v-8z" />
                            <path d="M16 11v4h4" />
                            <path d="M7 18h10M9 16l-2 2 2 2M15 16l2 2-2 2" />
                          </svg>
                      ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M15 2H5v20h14V8z" />
                            <path d="M15 2v6h6" />
                            <path d="M8.5 11.5l2.5 2.5M8.5 11.5h2M8.5 11.5v2M15.5 11.5l-2.5 2.5M15.5 11.5h-2M15.5 11.5v2M8.5 18.5l2.5-2.5M8.5 18.5h2M8.5 18.5v-2M15.5 18.5l-2.5-2.5M15.5 18.5h-2M15.5 18.5v-2" />
                          </svg>
                      )}
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                  </button>
                  {isFitMenuOpen && (
                      <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsFitMenuOpen(false)} />
                          <div className="absolute top-10 right-0 w-64 bg-white dark:bg-[#2d3236] border border-black/10 dark:border-white/10 shadow-xl rounded py-1 z-50 text-[13px] text-slate-700 dark:text-slate-200">
                              <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={applyFitWidth}>
                                  {fitMode === 'width' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500 dark:text-slate-400">
                                    <polyline points="4 3 4 8 20 8 20 3" />
                                    <path d="M16 11H4v11h16v-8z" />
                                    <path d="M16 11v4h4" />
                                    <path d="M7 18h10M9 16l-2 2 2 2M15 16l2 2-2 2" />
                                  </svg>
                                  <span>Vừa chiá»u rá»™ng (Cuá»™n)</span>
                              </button>
                              <button className="w-full text-left px-4 py-2 hover:bg-black/5 dark:hover:bg-white/10 flex items-center gap-3 transition-colors" onClick={applyFitPage}>
                                  {fitMode === 'page' ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-500"><polyline points="20 6 9 17 4 12"></polyline></svg> : <span className="w-[14px]" />} 
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500 dark:text-slate-400">
                                    <path d="M15 2H5v20h14V8z" />
                                    <path d="M15 2v6h6" />
                                    <path d="M8.5 11.5l2.5 2.5M8.5 11.5h2M8.5 11.5v2M15.5 11.5l-2.5 2.5M15.5 11.5h-2M15.5 11.5v2M8.5 18.5l2.5-2.5M8.5 18.5h2M8.5 18.5v-2M15.5 18.5l-2.5-2.5M15.5 18.5h-2M15.5 18.5v-2" />
                                  </svg>
                                  <span>Vừa thiết bá»‹ (Má»™t trang)</span>
                              </button>
                          </div>
                      </>
                  )}
              </div>
              
              <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors" onClick={() => {
                  setAdvDeleteFrom(activePage);
                  setAdvDeleteTo(activePage);
                  setAdvDeleteRange('selection');
                  setIsAdvDeleteModalOpen(true);
              }} title="Xóa Trang (Delete Pages)">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 transition-colors" onClick={() => {
                  setRotateFrom(activePage);
                  setRotateTo(activePage);
                  setRotateRange('selection');
                  setIsRotateModalOpen(true);
              }} title="Xoay Trang">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                      <path d="M21 3v5h-5" />
                  </svg>
              </button>

          </div>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        <Document
          key={pdfUrl}
          file={pdfUrl}
          onLoadSuccess={(pdf) => {
              setNumPages(pdf.numPages);
              setPageOrder(Array.from({length: pdf.numPages}, (_, i) => i + 1));
              setSelectedIndices(new Set([0]));
              setLastSelectedIndex(0);
              setPastStack([]);
              setFutureStack([]);
              setPageRotations({});
              setActivePage(1);
              setPdfRef(pdf);
              setPlateLabels({});
              // Auto fit-width on first load
              pdf.getPage(1).then((page: any) => {
                  const vp = page.getViewport({ scale: 1 });
                  setPageWidthPt(vp.width);
                  const actual100 = vp.width * (96 / 72);
                  if (containerRef.current) {
                      const cw = containerRef.current.clientWidth - 16;
                      setZoom(cw / actual100);
                  }
              }).catch(() => {});
              // Extract PlateInfo metadata from PDF pages
              (async () => {
                  try {
                      const resp = await fetch(pdfUrl);
                      const buf = await resp.arrayBuffer();
                      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
                      const labels: Record<number, string> = {};
                      const pages = doc.getPages();
                      for (let i = 0; i < pages.length; i++) {
                          const infoUriObj = pages[i].node.get(PDFName.of('PlateInfoURI'));
                          if (infoUriObj) {
                              let rawStr = (infoUriObj as any).decodeText?.() || (infoUriObj as any).value || String(infoUriObj);
                              rawStr = rawStr.replace(/^\(|\)$/g, ''); // Loại bá» ()
                              try {
                                  labels[i + 1] = decodeURIComponent(rawStr);
                              } catch (e) {}
                          } else {
                              const infoObj = pages[i].node.get(PDFName.of('PlateInfo'));
                              if (infoObj) {
                                  labels[i + 1] = (infoObj as any).decodeText?.() || (infoObj as any).value || String(infoObj);
                              }
                          }
                      }
                      if (Object.keys(labels).length > 0) setPlateLabels(labels);
                  } catch { /* non-fatal */ }
              })();
        }}
        loading={<div className="flex w-full h-full justify-center items-center text-slate-400">Äang nạp PDF...</div>}
        error={<div className="flex w-full h-full justify-center items-center text-red-400">Lá»—i không thá»ƒ tải hiá»ƒn thá»‹ PDF</div>}
        className="flex flex-1 h-full min-w-0"
      >
        {numPages > 0 && (
          <>
            <div 
                ref={sidebarRef}
                tabIndex={-1}
                className={`flex flex-col bg-slate-50 dark:bg-[#1f2937] transition-[width] duration-0 relative border-r border-black/20 dark:border-white/5 z-10 shrink-0 focus:outline-none ${isThumbMenuOpen ? '' : 'overflow-hidden'}`}
                style={{ width: isThumbMenuOpen ? thumbWidth : 40 }}
            >
              <div className="w-full h-10 shrink-0 flex items-center justify-between border-b border-black/10 dark:border-white/5 bg-slate-100 dark:bg-[#2d3748] px-2 relative overflow-hidden">
                  {isThumbMenuOpen ? (
                      <>
                          <div className="flex-1 shrink flex items-center min-w-0">
                              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400 pl-1 tracking-wider truncate">THUMBNAILS</span>
                          </div>
                          
                          <div className="shrink-0 flex items-center justify-center gap-1 px-1">
                              <button 
                                 className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${selectedIndices.size > 0 ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-slate-200' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}
                                 title="Xóa trang (Delete)"
                                 onClick={() => selectedIndices.size > 0 && setIsDeleteModalOpen(true)}
                                 disabled={selectedIndices.size === 0}
                              >
                                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                              </button>
                              <div className="w-px h-3 bg-black/10 dark:bg-white/10 mx-0.5"></div>
                              <button 
                                 className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${selectedIndices.size > 0 ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-slate-200' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}
                                 title="Xoay ngược chiá»u kim Ä‘á»“ng há»“"
                                 onClick={() => selectedIndices.size > 0 && handleQuickRotate(-90)}
                                 disabled={selectedIndices.size === 0}
                              >
                                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                              </button>
                              <button 
                                 className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${selectedIndices.size > 0 ? 'hover:bg-black/10 dark:hover:bg-white/10 text-slate-700 dark:text-slate-200' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}
                                 title="Xoay thuận chiá»u kim Ä‘á»“ng há»“"
                                 onClick={() => selectedIndices.size > 0 && handleQuickRotate(90)}
                                 disabled={selectedIndices.size === 0}
                              >
                                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                              </button>
                          </div>

                          <div className="flex-1 shrink-0 flex items-center justify-end min-w-0">
                              <button 
                                onClick={() => setIsThumbMenuOpen(false)}
                                className="w-6 h-6 flex items-center justify-center shrink-0 rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-500"
                              >
                                 â—€
                              </button>
                          </div>
                      </>
                  ) : (
                      <div className="w-full flex justify-center items-center -ml-1">
                          <button 
                            onClick={() => setIsThumbMenuOpen(true)}
                            className="w-6 h-6 flex items-center justify-center shrink-0 rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-500"
                          >
                             â–¶
                          </button>
                      </div>
                  )}
              </div>

              {isThumbMenuOpen && (
                <div className="w-full h-full flex flex-col font-sans transition-colors relative" onClick={() => setContextMenu(null)}>
                  <VirtuosoGrid
                      ref={thumbVirtuosoRef}
                      totalCount={pageOrder.length}
                      context={{ highlightBoxes }}
                      className="acro-thumb-scroll w-full h-full"
                      listClassName="flex flex-wrap gap-4 justify-center py-4 px-2"
                      itemClassName="flex-none flex items-center justify-center"
                      itemContent={(index) => {
                          const originalPageNum = pageOrder[index];
                          const logicalPageLabel = index + 1;
                          return (
                          <div 
                              draggable={true}
                              onDragStart={(e) => handleDragStartItem(e, index)}
                              onDragOver={(e) => handleDragOverItem(e, index)}
                              onDragEnter={() => handleDragEnterItem(index)}
                              onDragLeave={handleDragLeaveItem}
                              onDrop={(e) => handleDropItem(e, index)}
                              onDragEnd={handleDragEndItem}
                              onContextMenu={(e) => {
                                  e.preventDefault();
                                  if (!selectedIndices.has(index)) {
                                      setSelectedIndices(new Set([index]));
                                      setActivePage(logicalPageLabel);
                                      setLastSelectedIndex(index);
                                  }
                                  setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
                              }}
                              className={`flex flex-col items-center py-2 px-3 rounded-md cursor-pointer transition-colors relative 
                                ${selectedIndices.has(index) ? 'bg-blue-500/10 dark:bg-blue-900/40' : 'hover:bg-black/5 dark:hover:bg-white/5'}
                                ${draggedIndex !== null && selectedIndices.has(index) ? 'opacity-30' : 'opacity-100'}
                                ${hoverTargetIndex === index && !selectedIndices.has(index) ? 'border-l-[3px] border-blue-500 bg-blue-50 dark:bg-blue-900/20 shadow-[-4px_0_10px_rgba(59,130,246,0.3)]' : ''}
                              `}
                              onClick={(e) => handleThumbClick(e, index)}
                          >
                              <div className={`
                              bg-white shadow-[0_2px_10px_rgba(0,0,0,0.2)] flex relative items-center justify-center
                              ${selectedIndices.has(index) ? 'outline outline-3 outline-blue-500 shadow-[0_4px_20px_rgba(59,130,246,0.4)] scale-105 transition-[transform,box-shadow]' : 'border border-black/10'}
                              `}
                              style={{ padding: 1 }}>
                              {originalPageNum === -1 ? (
                                  <div style={{ width: thumbBaseWidth, height: thumbBaseWidth * 1.414 }} className="bg-white border-2 border-dashed border-slate-300 flex items-center justify-center">
                                      <span className="text-slate-300 text-xs font-semibold -rotate-45 block">TRANG TRá»NG</span>
                                  </div>
                              ) : (
                                  (() => {
                                      const cacheKey = `${pdfUrl}_${originalPageNum}_${pageRotations[originalPageNum] || 0}_400`;
                                      const cachedUrl = thumbUrls.get(cacheKey);
                                      if (cachedUrl) {
                                          return <img src={cachedUrl} alt={`Page ${originalPageNum}`} style={{ width: thumbBaseWidth, objectFit: 'contain' }} className="pointer-events-none" draggable={false} />;
                                      }
                                      return (
                                          <div style={{ width: thumbBaseWidth, height: thumbBaseWidth * 1.414 }} className="bg-slate-100 dark:bg-slate-800 flex items-center justify-center animate-pulse">
                                              <div className="w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                                          </div>
                                      );
                                  })()
                              )}
                              </div>
                              <span className={`text-[11px] mt-3 font-mono tracking-widest ${activePage === logicalPageLabel ? 'text-blue-600 dark:text-blue-400 font-extrabold' : 'text-slate-500 dark:text-slate-400'}`}>
                              {logicalPageLabel} {originalPageNum !== logicalPageLabel && originalPageNum !== -1 && <span className="text-slate-400 font-normal ml-1 text-[9px]">(T.{originalPageNum})</span>}
                              </span>
                          </div>
                      )}}
                  />
                  <div 
                      className="absolute top-0 -right-2 w-2 h-full cursor-col-resize z-50 hover:bg-blue-500/30 transition-colors"
                      onMouseDown={handleThumbResizeStart}
                  />
                </div>
              )}
            </div>

            <div 
                className={`flex-1 overflow-hidden relative bg-[#525659] flex justify-center select-text ${toolMode === 'hand' ? 'panning-mode cursor-grab active:cursor-grabbing' : ''}`} 
                ref={containerRef}
                onMouseDown={handleDragStart}
            >
              {pageDim && (
                 <div className="absolute bottom-0 left-0 w-32 h-20 z-[50] group flex items-end p-6">
                    <div className="px-3 py-1.5 bg-[#222]/95 backdrop-blur-sm text-[#e0e0e0] font-mono text-[11px] rounded border border-white/10 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none tracking-wider whitespace-nowrap">
                       {Math.round(pageDim.w)} x {Math.round(pageDim.h)} mm
                    </div>
                 </div>
              )}
              {(() => {
                  const renderPdfPage = (originalPageNum: number) => {
                      if (!originalPageNum) return null;
                      const plateLabel = plateLabels[originalPageNum];
                      return (
                          <div className="flex flex-col items-center">
                              {plateLabel && (
                                  <div className="text-[11px] font-semibold text-yellow-400 mb-1 px-2 py-0.5 tracking-wide max-w-full truncate">
                                      {plateLabel}
                                  </div>
                              )}
                              <LivePageFrame 
                                  originalPageNum={originalPageNum}
                                  actualWidth100={actualWidth100}
                                  zoom={zoom}
                                  rotation={pageRotations[originalPageNum] || 0}
                                  bleedView={bleedView}
                                  pageDim={pageDim}
                                  highlightBoxes={highlightBoxes?.filter(h => Number(h.page) === Number(originalPageNum))}
                                  isSelectionMode={isSelectionMode}
                                  pdfObjectsByPage={pdfObjectsByPage}
                                  selectedObjectIds={selectedObjectIds}
                                  onObjectSelect={onObjectSelect}
                                  onObjectDelete={onObjectDelete}
                                  fetchObjectsForPage={fetchObjectsForPage}
                                  selectionFileId={selectionFileId}
                                  hiddenObjectIds={hiddenObjectIds}
                                  separationPlates={separationPlates}
                                  isVdpMode={isVdpMode}
                                  vdpFields={vdpFields}
                                  onVdpBoxCreate={onVdpBoxCreate}
                                  onVdpBoxSelect={onVdpBoxSelect}
                                  selectedVdpFieldId={selectedVdpFieldId}
                                  onVdpFieldsChange={onVdpFieldsChange}
                              />
                          </div>
                      );
                  };

                  if (pageDisplayMode.includes('_fit')) {
                      return (
                          <div 
                              className="w-full h-full overflow-auto acro-scroll flex justify-center py-6"
                              ref={(el) => { if (el) internalScrollRef.current = el; }}
                          >
                              {renderRows.map((row, i) => (
                              <div key={i} className={`flex items-center gap-2 min-w-full w-max px-4 ${toolMode === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-auto'}`} style={{ justifyContent: 'safe center' }}>
                                     {row.pages.map((p, pIdx) => <div key={pIdx}>{renderPdfPage(p)}</div>)}
                                  </div>
                              ))}
                          </div>
                      );
                  }

                  return (
                      <Virtuoso
                        ref={mainVirtuosoRef}
                        context={{ highlightBoxes }}
                        totalCount={renderRows.length}
                        increaseViewportBy={{ top: 8000, bottom: 8000 }}
                        className="acro-scroll w-full h-full flex-1 overflow-x-auto overflow-y-auto"
                        scrollerRef={(el) => { 
                          if (el && el instanceof HTMLElement) {
                            internalScrollRef.current = el;
                            el.addEventListener('scroll', handleMainScroll, { passive: true });
                          }
                        }}
                        itemContent={(index) => {
                          const row = renderRows[index];
                          if (!row) return null;
                          return (
                          <div className={`flex items-center py-6 min-h-[500px] gap-2 min-w-full w-max px-4 ${toolMode === 'hand' ? 'cursor-grab active:cursor-grabbing' : 'cursor-auto'}`} style={{ justifyContent: 'safe center' }}>
                            {row.pages.map((p, pIdx) => <div key={pIdx}>{renderPdfPage(p)}</div>)}
                          </div>
                        )}}
                      />
                  );
              })()}
            </div>
          </>
        )}
      </Document>
      
      {/* INJECTED RIGHT PANEL */}
      {rightPanel}
      </div>

      {/* ROTATE PAGES MODAL */}
      {isRotateModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
              <div className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                  
                  {/* Modern Header */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                      <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100 tracking-wide">Xoay Trang</h3>
                      <button onClick={() => setIsRotateModalOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title="ÄÃ³ng (ESC)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                      </button>
                  </div>
                  
                  {/* Body */}
                  <div className="p-6 flex flex-col gap-6 text-[14px]">
                      
                      {/* Direction */}
                      <div className="flex flex-col gap-2">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">HÆ°á»›ng xoay</label>
                          <select 
                              value={rotateDirection} 
                              onChange={e => setRotateDirection(e.target.value)}
                              className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all cursor-pointer"
                          >
                              <option value="90">90 Ä‘á»™ (Thuận chiá»u kim Ä‘á»“ng há»“)</option>
                              <option value="-90">90 Ä‘á»™ (Ngược chiá»u kim Ä‘á»“ng há»“)</option>
                              <option value="180">180 Ä‘á»™ (Ngược Ä‘ầu)</option>
                          </select>
                      </div>

                      {/* Page Range */}
                      <div className="flex flex-col gap-3">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Phạm vi trang</label>
                          
                          <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                              <label className="flex items-center gap-3 cursor-pointer group">
                                  <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${rotateRange === 'all' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                      {rotateRange === 'all' && <div className="w-2 h-2 bg-white rounded-full" />}
                                  </div>
                                  <input type="radio" name="range" checked={rotateRange === 'all'} onChange={() => setRotateRange('all')} className="hidden" />
                                  <span className="text-slate-700 dark:text-slate-300">Tất cả các trang</span>
                              </label>

                              <label className="flex items-center gap-3 cursor-pointer group">
                                  <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${rotateRange === 'selection' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                      {rotateRange === 'selection' && <div className="w-2 h-2 bg-white rounded-full" />}
                                  </div>
                                  <input type="radio" name="range" checked={rotateRange === 'selection'} onChange={() => setRotateRange('selection')} className="hidden" />
                                  <span className="text-slate-700 dark:text-slate-300">Trang hiá»‡n tại</span>
                              </label>

                              <div className="flex items-center gap-3">
                                  <label className="flex items-center gap-3 cursor-pointer group">
                                      <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${rotateRange === 'pages' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                          {rotateRange === 'pages' && <div className="w-2 h-2 bg-white rounded-full" />}
                                      </div>
                                      <input type="radio" name="range" checked={rotateRange === 'pages'} onChange={() => setRotateRange('pages')} className="hidden" />
                                      <span className="text-slate-700 dark:text-slate-300 whitespace-nowrap">Tùy chá»‰nh:</span>
                                  </label>
                                  
                                  <div className={`flex items-center gap-2 flex-1 transition-opacity ${rotateRange === 'pages' ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                      <input 
                                          type="number" min="1" max={numPages} value={rotateFrom} 
                                          onChange={e => {setRotateFrom(parseInt(e.target.value)); setRotateRange('pages');}} 
                                          className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-slate-200 outline-none focus:border-blue-500" 
                                      />
                                      <span className="text-slate-400">-</span>
                                      <input 
                                          type="number" min="1" max={numPages} value={rotateTo} 
                                          onChange={e => {setRotateTo(parseInt(e.target.value)); setRotateRange('pages');}} 
                                          className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-slate-200 outline-none focus:border-blue-500" 
                                      />
                                      <span className="text-slate-400 text-[13px] ml-auto">/ {numPages}</span>
                                  </div>
                              </div>
                          </div>
                      </div>

                      {/* Filters */}
                      <div className="flex flex-col gap-2">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Bá»™ lá»c nâng cao</label>
                          <div className="grid grid-cols-1 gap-3">
                              <select 
                                  value={rotateFilter} onChange={e => setRotateFilter(e.target.value)} 
                                  className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-[13px] cursor-pointer"
                              >
                                  <option value="all">Tất cả trang (Chẵn và Lẻ)</option>
                                  <option value="even">Chá»‰ trang Chẵn (2, 4, 6...)</option>
                                  <option value="odd">Chá»‰ trang Lẻ (1, 3, 5...)</option>
                              </select>
                              <select 
                                  value={rotateOrientation} onChange={e => setRotateOrientation(e.target.value)} 
                                  className="w-full bg-slate-50 dark:bg-black/20 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 text-[13px] cursor-pointer"
                              >
                                  <option value="any">Trang má»i hÆ°á»›ng kích thÆ°á»›c (Bất kỳ)</option>
                                  <option value="portrait">Chá»‰ trang Dá»c (Portrait)</option>
                                  <option value="landscape">Chá»‰ trang Ngang (Landscape)</option>
                              </select>
                          </div>
                      </div>

                  </div>

                  {/* Footer Buttons */}
                  <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                      <button 
                          className="px-5 py-2 rounded-lg font-medium text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors outline-none focus:ring-2 focus:ring-slate-400" 
                          onClick={() => setIsRotateModalOpen(false)}
                      >
                          Hủy bá»
                      </button>
                      <button 
                          className="px-6 py-2 rounded-lg font-medium text-[13px] bg-blue-600 hover:bg-blue-700 text-white shadow-sm flex items-center justify-center min-w-[100px] transition-colors outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e] disabled:opacity-70 disabled:cursor-not-allowed" 
                          onClick={handleRotateConfirm}
                          disabled={isRotating}
                      >
                          {isRotating ? (
                              <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                          ) : 'Lưu thay Ä‘á»•i'}
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* QUICK DELETE MODAL */}
      {isDeleteModalOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 font-sans">
              <div className="bg-white dark:bg-[#1e1e1e] w-[380px] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                  <div className="flex px-6 pt-6 pb-4">
                      <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0 text-red-600 dark:text-red-500 mr-4 mt-1">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      </div>
                      <div>
                          <h3 className="font-semibold text-lg text-slate-800 dark:text-slate-100 mb-1">Xóa trang?</h3>
                          <p className="text-sm text-slate-600 dark:text-slate-400">
                              Bạn có chắc chắn muá»‘n xóa <span className="font-bold text-red-600 dark:text-red-400">{selectedIndices.size}</span> trang khá»i tài liá»‡u này không? Hành Ä‘á»™ng này có thá»ƒ hoàn tác bằng Ctrl+Z.
                          </p>
                      </div>
                  </div>
                  <div className="flex bg-slate-50 dark:bg-[#151515] px-6 py-4 justify-end gap-3 border-t border-black/5 dark:border-white/5">
                      <button 
                          onClick={() => setIsDeleteModalOpen(false)}
                          className="px-4 py-2 rounded font-medium text-[13px] text-slate-700 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors focus:ring-2 focus:ring-slate-400 outline-none"
                      >
                          Hủy bá»
                      </button>
                      <button 
                          onClick={handleQuickDeleteConfirm}
                          className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-[13px] transition-colors shadow-sm focus:ring-2 focus:ring-red-500 outline-none"
                      >
                          Äá»“ng ý xóa
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* ADVANCED DELETE MODAL */}
      {isAdvDeleteModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
              <div className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                  
                  {/* Modern Header */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                      <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100 tracking-wide">Xóa Trang (Delete Pages)</h3>
                      <button onClick={() => setIsAdvDeleteModalOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title="ÄÃ³ng (ESC)">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                      </button>
                  </div>
                  
                  {/* Body */}
                  <div className="p-6 flex flex-col gap-6 text-[14px]">
                      
                      {/* Page Range */}
                      <div className="flex flex-col gap-3">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Chá»n luá»“ng cần xóa</label>
                          
                          <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                               <label className="flex items-center gap-3 cursor-pointer group">
                                  <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${advDeleteRange === 'selection' ? 'border-red-500 bg-red-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-red-400'}`}>
                                      {advDeleteRange === 'selection' && <div className="w-2 h-2 bg-white rounded-full" />}
                                  </div>
                                  <input type="radio" name="delRange" checked={advDeleteRange === 'selection'} onChange={() => setAdvDeleteRange('selection')} className="hidden" />
                                  <span className="text-slate-700 dark:text-slate-300">Những trang Ä‘ang Ä‘ược chá»n (Selected)</span>
                              </label>

                              <div className="flex items-center gap-3">
                                  <label className="flex items-center gap-3 cursor-pointer group">
                                      <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${advDeleteRange === 'range' ? 'border-red-500 bg-red-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-red-400'}`}>
                                          {advDeleteRange === 'range' && <div className="w-2 h-2 bg-white rounded-full" />}
                                      </div>
                                      <input type="radio" name="delRange" checked={advDeleteRange === 'range'} onChange={() => setAdvDeleteRange('range')} className="hidden" />
                                      <span className="text-slate-700 dark:text-slate-300 whitespace-nowrap">Theo sá»‘ trang:</span>
                                  </label>
                                  
                                  <div className={`flex items-center gap-2 flex-1 transition-opacity ${advDeleteRange === 'range' ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                      <input 
                                          type="number" min="1" max={numPages} value={advDeleteFrom} 
                                          onChange={e => {setAdvDeleteFrom(parseInt(e.target.value)); setAdvDeleteRange('range');}} 
                                          className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-slate-200 outline-none focus:border-red-500" 
                                      />
                                      <span className="text-slate-400">-</span>
                                      <input 
                                          type="number" min="1" max={numPages} value={advDeleteTo} 
                                          onChange={e => {setAdvDeleteTo(parseInt(e.target.value)); setAdvDeleteRange('range');}} 
                                          className="w-14 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-slate-200 outline-none focus:border-red-500" 
                                      />
                                      <span className="text-slate-400 text-[13px] ml-auto">/ {numPages}</span>
                                  </div>
                              </div>
                          </div>
                      </div>

                  </div>

                  {/* Footer Buttons */}
                  <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                      <button 
                          className="px-5 py-2 rounded-lg font-medium text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors outline-none focus:ring-2 focus:ring-slate-400" 
                          onClick={() => setIsAdvDeleteModalOpen(false)}
                      >
                          Hủy bá»
                      </button>
                      <button 
                          className="px-6 py-2 rounded-lg font-medium text-[13px] bg-red-600 hover:bg-red-700 text-white shadow-sm flex items-center justify-center min-w-[100px] transition-colors outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]" 
                          onClick={handleAdvDeleteConfirm}
                      >
                          Äá»“ng ý Xóa
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* EXTRACT PAGES MODAL */}
      {isExtractModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
              <div className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                      <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100 tracking-wide">Trích xuất trang</h3>
                      <button onClick={() => setIsExtractModalOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title="ÄÃ³ng">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                      </button>
                  </div>
                  
                  <div className="p-6 flex flex-col gap-6 text-[14px]">
                      <div className="flex flex-col gap-2">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Trang cần trích xuất</label>
                          <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                              <div className="flex items-center gap-3">
                                  <input 
                                      type="text" 
                                      value={extractPagesStr}
                                      onChange={e => setExtractPagesStr(e.target.value)}
                                      placeholder="VD: 1, 3, 5-7"
                                      className="flex-1 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-2 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all font-mono"
                                  />
                                  <span className="text-slate-500 dark:text-slate-400 text-[13px] whitespace-nowrap">/ {pageOrder.length} trang</span>
                              </div>
                          </div>
                      </div>
                      
                      <div className="flex flex-col gap-2">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Tùy chá»n bá»• sung</label>
                          <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                              <label className="flex items-center gap-3 cursor-pointer group">
                                  <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${extractDeleteAfter ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                      {extractDeleteAfter && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                                  </div>
                                  <input type="checkbox" checked={extractDeleteAfter} onChange={e => setExtractDeleteAfter(e.target.checked)} className="hidden" />
                                  <span className="text-slate-700 dark:text-slate-300">Xóa các trang này khá»i file gá»‘c sau khi trích xuất</span>
                              </label>
                          </div>
                      </div>
                  </div>
                  
                  <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                      <button 
                          className="px-5 py-2 rounded-lg font-medium text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors outline-none focus:ring-2 focus:ring-slate-400" 
                          onClick={() => setIsExtractModalOpen(false)}
                      >
                          Hủy bá»
                      </button>
                      <button 
                          className="px-6 py-2 rounded-lg font-medium text-[13px] bg-blue-600 hover:bg-blue-700 text-white shadow-sm flex items-center justify-center min-w-[100px] transition-colors outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]" 
                          onClick={handleExtractPages}
                      >
                          Trích xuất
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* INSERT BLANK PAGE MODAL */}
      {isInsertModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto font-sans">
              <div className="bg-white dark:bg-[#1e1e1e] w-[420px] rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-black/5 dark:border-white/10">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/5">
                      <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100 tracking-wide">Chèn trang (Insert Pages)</h3>
                      <button onClick={() => setIsInsertModalOpen(false)} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 text-slate-500 transition-colors" title="ÄÃ³ng">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                      </button>
                  </div>
                  
                  <div className="p-6 flex flex-col gap-6 text-[14px]">
                      <div className="flex flex-col gap-2">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Cấu hình chèn</label>
                          <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                              <div className="flex items-center justify-between">
                                  <span className="text-slate-700 dark:text-slate-300">Thá»ƒ loại:</span>
                                  <span className="text-slate-900 dark:text-slate-100 font-semibold bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 px-3 py-1.5 rounded-lg">Trang trắng (Blank Page)</span>
                              </div>
                              <div className="flex items-center justify-between mt-2">
                                  <span className="text-slate-700 dark:text-slate-300">Vá»‹ trí:</span>
                                  <select 
                                      value={insertLocation} 
                                      onChange={e => setInsertLocation(e.target.value as any)}
                                      className="w-[200px] bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all cursor-pointer"
                                  >
                                      <option value="after">Sau (After)</option>
                                      <option value="before">TrÆ°á»›c (Before)</option>
                                  </select>
                              </div>
                          </div>
                      </div>
                      
                      <div className="flex flex-col gap-2">
                          <label className="text-slate-600 dark:text-slate-300 font-medium">Trang Ä‘ích (Target Page)</label>
                          <div className="flex flex-col gap-3 p-4 bg-slate-50 dark:bg-black/20 rounded-xl border border-slate-100 dark:border-white/5">
                              <label className="flex items-center gap-3 cursor-pointer group">
                                  <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${insertTarget === 'first' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                      {insertTarget === 'first' && <div className="w-2 h-2 bg-white rounded-full" />}
                                  </div>
                                  <input type="radio" name="insertTarget" checked={insertTarget === 'first'} onChange={() => setInsertTarget('first')} className="hidden" />
                                  <span className="text-slate-700 dark:text-slate-300">Äáº§u tiên (First)</span>
                              </label>

                              <label className="flex items-center gap-3 cursor-pointer group">
                                  <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${insertTarget === 'last' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                      {insertTarget === 'last' && <div className="w-2 h-2 bg-white rounded-full" />}
                                  </div>
                                  <input type="radio" name="insertTarget" checked={insertTarget === 'last'} onChange={() => setInsertTarget('last')} className="hidden" />
                                  <span className="text-slate-700 dark:text-slate-300">Cuá»‘i cùng (Last)</span>
                              </label>

                              <div className="flex items-center gap-3">
                                  <label className="flex items-center gap-3 cursor-pointer group">
                                      <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${insertTarget === 'page' ? 'border-blue-500 bg-blue-500' : 'border-slate-300 dark:border-slate-600 group-hover:border-blue-400'}`}>
                                          {insertTarget === 'page' && <div className="w-2 h-2 bg-white rounded-full" />}
                                      </div>
                                      <input type="radio" name="insertTarget" checked={insertTarget === 'page'} onChange={() => setInsertTarget('page')} className="hidden" />
                                      <span className="text-slate-700 dark:text-slate-300 whitespace-nowrap">Trang sá»‘:</span>
                                  </label>
                                  
                                  <div className={`flex items-center gap-2 flex-1 transition-opacity ${insertTarget === 'page' ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
                                      <input 
                                          type="number" min="1" max={pageOrder.length} value={insertTargetPage}
                                          onChange={e => { setInsertTargetPage(parseInt(e.target.value)); setInsertTarget('page'); }}
                                          className="w-16 h-8 bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-md text-center text-slate-800 dark:text-slate-200 outline-none focus:border-blue-500"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400 text-[13px] ml-auto">/ {pageOrder.length}</span>
                                  </div>
                              </div>
                          </div>
                      </div>
                  </div>
                  
                  <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 dark:bg-black/20 border-t border-black/5 dark:border-white/5">
                      <button 
                          className="px-5 py-2 rounded-lg font-medium text-[13px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors outline-none focus:ring-2 focus:ring-slate-400" 
                          onClick={() => setIsInsertModalOpen(false)}
                      >
                          Hủy bá»
                      </button>
                      <button 
                          className="px-6 py-2 rounded-lg font-medium text-[13px] bg-blue-600 hover:bg-blue-700 text-white shadow-sm flex items-center justify-center min-w-[100px] transition-colors outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-[#1e1e1e]" 
                          onClick={handleInsertBlankPage}
                      >
                          Lưu thay Ä‘á»•i
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* CONTEXT MENU */}
      {contextMenu && contextMenu.visible && (
          <div 
              className="fixed z-[999] min-w-[220px] bg-white dark:bg-[#1e1e1e] border border-slate-200 dark:border-white/10 shadow-[0_10px_30px_rgb(0,0,0,0.1)] dark:shadow-xl p-2 rounded-xl animate-in fade-in zoom-in-95 duration-100 flex flex-col gap-0.5"
              style={{ left: Math.min(contextMenu.x, window.innerWidth - 220), top: Math.min(contextMenu.y, window.innerHeight - 200) }}
              onClick={e => e.stopPropagation()}
              onContextMenu={e => e.preventDefault()}
          >
              <button 
                  onClick={() => setIsInsertModalOpen(true)}
                  className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
                >
                  Chèn trang trắng (Insert)
              </button>
              
              <button 
                  onClick={() => {
                      const sortedSel = Array.from(selectedIndices).sort((a,b) => a-b).map(i => i+1);
                      setExtractPagesStr(sortedSel.join(', '));
                      setIsExtractModalOpen(true);
                  }}
                  className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
                >
                  Trích xuất trang
              </button>
              
              <button 
                  onClick={handleDuplicate}
                  className="w-full text-left px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg outline-none transition-colors"
                >
                  Nhân bản (Duplicate)
              </button>
              
              <div className="h-px bg-slate-100 dark:bg-white/5 my-1 mx-2"></div>
              
              <button 
                  onClick={() => setIsDeleteModalOpen(true)}
                  className="w-full flex items-center justify-between px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 rounded-lg outline-none transition-colors group"
                >
                  <span>Xóa trang (Delete)</span>
                  <span className="text-[11px] text-slate-400 group-hover:text-red-400 tracking-wider">Del</span>
              </button>
          </div>
      )}

    </div>
  );
}
