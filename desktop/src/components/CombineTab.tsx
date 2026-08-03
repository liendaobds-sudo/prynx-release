import React, { useState, useRef, useCallback, useEffect } from 'react';
import { backendMergeManifestJob, backendMergePdfsJob } from '../lib/api';
import {
  estimateCombineImagePixels,
  getCombineMemoryStatus,
  shouldDelegateLargePdfJob,
} from '../lib/combineDelegation';
import { PDFDocument, degrees } from 'pdf-lib';
import { Document, Page, pdfjs } from 'react-pdf';
import { getFileArrayBuffer } from '../lib/utils';
import { localFileUrl } from '../lib/localFileTransport';
import { appendImagePageToPdfDoc, imageBytesToPdfDoc } from '../lib/imageNormalizer';
import { IMAGE_ACCEPT_ATTR, imageFileExtension, isSupportedImageFileName } from '../lib/imageFileTypes';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { toast } from './ui/Toast';
import { sizeKeyLabel, groupBySizeKey } from '../lib/combineGroupBySize';
import { useTranslation } from 'react-i18next';
import { usePrintDialog } from './shared/usePrintDialog';
import {
  addRotatedBlankPage,
  buildBackendCombineManifest,
  isCompletePdfBytes,
  toExactArrayBuffer,
  visiblePageSize,
} from '../lib/combineAssembly';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

function createPdfBlobFromBytes(bytes: Uint8Array, invalidMessage: string): Blob {
  if (!isCompletePdfBytes(bytes)) throw new Error(invalidMessage);
  // PDF (audit 2026-08-01 §B.1): chỉ đưa đúng byte-window vào Blob, không lấy cả backing buffer.
  return new Blob([toExactArrayBuffer(bytes)], { type: 'application/pdf' });
}

function createPdfFileFromBytes(bytes: Uint8Array, name: string, invalidMessage: string): File {
  if (!isCompletePdfBytes(bytes)) throw new Error(invalidMessage);
  return new File([toExactArrayBuffer(bytes)], name, { type: 'application/pdf' });
}

function createDelegatedResultFile(
  result: { blob?: Blob; path?: string; size?: number },
  name: string,
): File {
  const file = result.path
    ? new File([], name, { type: 'application/pdf' })
    : new File([result.blob as Blob], name, { type: 'application/pdf' });
  if (result.path) {
    Object.defineProperty(file, 'path', { value: result.path });
    // UIUX (audit 2026-08-03 §COMB.SIZE): file path-backed không chứa blob trong
    // WebView; gắn số byte backend đã stat để thanh viewer không hiện 0.00 MB.
    if (Number.isFinite(result.size) && Number(result.size) > 0) {
      Object.defineProperty(file, 'size', { value: Number(result.size) });
    }
  }
  return file;
}

export type CombineNode = {
  id: string;
  type: 'single' | 'collapsed_group' | 'blank';
  file?: File;

  rotation?: number;
  
  // For 'single' nodes that are part of an expanded group
  groupId?: string;
  groupName?: string;
  pageIndex?: number; // Zero-indexed. If present, this node visually and physically represents only this specific page.
  
  // For 'collapsed_group'
  pages?: CombineNode[];

  /** Khóa kích thước hiển thị (vd "50x70") — có khi bật chia nhóm theo size. */
  sizeKey?: string;
};

function backendCompletedNodeIds(
  nodes: CombineNode[],
  sourceFiles: File[],
  completedSourceIndices: number[] | undefined,
): Set<string> {
  const result = new Set<string>();
  const completedFiles = new Set<File>();
  for (const rawIndex of completedSourceIndices ?? []) {
    if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= sourceFiles.length) continue;
    completedFiles.add(sourceFiles[rawIndex]);
  }

  // UIUX (audit 2026-08-02 §COMB.UI.3): backend trả index nguồn thật, vì vậy file
  // hoàn tất lệch thứ tự và một nguồn xuất hiện ở nhiều card đều được tick chính xác.
  nodes.forEach(node => {
    if (node.file && completedFiles.has(node.file)) result.add(node.id);
  });
  return result;
}

interface Props {
  tabId?: string;
  isActive?: boolean;
  onTitleChange?: (title: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  initialFiles?: File[];
  /** Kết quả ghép 1 file → mở tab imposition (hành vi cũ). */
  onSpawnTab?: (file: File, extraPayload?: any) => void;
  /** Mọi kết quả đã được mở; shell có thể đóng tab Combine nguồn. */
  onResultsOpened?: () => void;
  /**
   * Kết quả ghép theo nhóm kích thước → mỗi file mở 1 tab Combine riêng
   * (title + files trong extra).
   */
  onSpawnCombineTabs?: (results: { file: File; title: string }[]) => void;
}

const PDF_PREVIEW_AUTO_RETRIES = 5;

interface PdfErrorBoundaryProps {
  children: React.ReactNode;
  errorLabel: string;
  retryLabel: string;
  resetKey: string;
}

interface PdfErrorBoundaryState {
  hasError: boolean;
  retryCount: number;
}

class PdfErrorBoundary extends React.Component<PdfErrorBoundaryProps, PdfErrorBoundaryState> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: PdfErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, retryCount: 0 };
  }

  static getDerivedStateFromError(): Partial<PdfErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch() {
    if (this.state.retryCount >= PDF_PREVIEW_AUTO_RETRIES) return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState((previous) => ({
        hasError: false,
        retryCount: previous.retryCount + 1,
      }));
    }, 100);
  }

  componentDidUpdate(previousProps: PdfErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey) {
      this.clearRetryTimer();
      if (this.state.hasError || this.state.retryCount > 0) {
        this.setState({ hasError: false, retryCount: 0 });
      }
    }
  }

  componentWillUnmount() {
    this.clearRetryTimer();
  }

  private clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private handleRetry = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    this.clearRetryTimer();
    this.setState({ hasError: false, retryCount: 0 });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex flex-col gap-1 items-center justify-center text-[10px] text-slate-500"
          role="alert"
        >
          <span>{this.props.errorLabel}</span>
          <button
            type="button"
            className="pointer-events-auto rounded border border-slate-300 dark:border-zinc-600 px-2 py-0.5 hover:bg-white dark:hover:bg-zinc-700"
            onClick={this.handleRetry}
          >
            {this.props.retryLabel}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const PdfThumbnail = React.memo(({ file, pageIndex }: { file: string | File; pageIndex: number }) => {
  const [docFile, setDocFile] = useState<string | File | null>(null);

  useEffect(() => {
    let isActive = true;
    if (typeof file !== 'string' && (window as any).__TAURI_INTERNALS__ && (file as any).path) {
      // FILEIO (audit 2026-07-28 §FL.03): preview ngoài scope qua protocol Rust.
      Promise.resolve(localFileUrl((file as any).path)).then((url) => {
        if (isActive) setDocFile(url);
      });
    } else {
      Promise.resolve(file).then((nextFile) => {
        if (isActive) setDocFile(nextFile);
      });
    }
    return () => { isActive = false; };
  }, [file]);

  if (!docFile) return <div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />;

  return (
    <Document file={docFile} loading={<div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />} className="flex items-center justify-center w-full h-full">
      <Page pageNumber={pageIndex + 1} width={160} renderTextLayer={false} renderAnnotationLayer={false} className="shadow-none" />
    </Document>
  );
}, (prev, next) => prev.file === next.file && prev.pageIndex === next.pageIndex);

const ImageThumbnail = React.memo(({ file, rotation }: { file: File; rotation?: number }) => {
  const [src, setSrc] = useState<string>('');
  const extension = imageFileExtension(file.name);
  const usesDarkTransparencySurface = extension === 'png' || extension === 'webp';

  useEffect(() => {
    let isActive = true;
    let ownedObjectUrl: string | null = null;
    const nativePath = (file as File & { path?: string }).path;
    const isTauri = Boolean(
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
    );
    const nextSrc = isTauri && nativePath
      ? localFileUrl(nativePath)
      : URL.createObjectURL(file);
    if (!isTauri || !nativePath) ownedObjectUrl = nextSrc;

    Promise.resolve().then(() => {
      if (isActive) setSrc(nextSrc);
    });

    // FILEIO (audit 2026-08-02 §COMB.2): component tạo URL thì component phải
    // thu hồi khi đổi file/unmount; URL protocol localfile không thuộc ownership này.
    return () => {
      isActive = false;
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
    };
  }, [file]);

  if (!src) return <div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />;

  return (
    <div className={`w-full h-full flex items-center justify-center ${usesDarkTransparencySurface ? 'bg-black' : ''}`}>
      <img src={src} alt="" style={{ transform: `rotate(${rotation || 0}deg)` }} className="object-contain w-full h-full transition-transform duration-300" />
    </div>
  );
});

export default function CombineTab({ initialFiles, onSpawnTab, onResultsOpened, onSpawnCombineTabs, onTitleChange, isActive, tabId }: Props) {
  const { t } = useTranslation();
  const { openPrintDialog, printDialog } = usePrintDialog();
  const [nodes, setNodes] = useState<CombineNode[]>([]);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDelegatedCombineRunning, setIsDelegatedCombineRunning] = useState(false);
  const [delegatedCombineProgress, setDelegatedCombineProgress] = useState(0);
  const [completedCombineNodeIds, setCompletedCombineNodeIds] = useState<Set<string>>(new Set());
  const [isCancellingCombine, setIsCancellingCombine] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const combineJobAbortRef = useRef<AbortController | null>(null);
  const combineJobGenerationRef = useRef(0);

  // PDF (audit 2026-08-02 §6F/§UI.1): tab đã đóng không được nhận tiến độ/kết quả
  // của job cũ; abort đồng thời yêu cầu backend dừng công việc đang chạy.
  useEffect(() => () => {
    combineJobGenerationRef.current += 1;
    combineJobAbortRef.current?.abort();
    combineJobAbortRef.current = null;
  }, []);

  const [scaleMode, setScaleMode] = useState<'keep' | 'fit_a4' | 'fit_first'>('keep');
  /** Chia nhóm theo kích thước trang (như viewer hiển thị) — tick là sắp view ngay. */
  const [groupByPageSize, setGroupByPageSize] = useState(false);
  const [isGrouping, setIsGrouping] = useState(false);
  /** Chống re-group lặp khi chính setNodes từ regroup. */
  const skipNextRegroupRef = useRef(false);

  const markCombineNodeCompleted = useCallback((node: CombineNode) => {
    setCompletedCombineNodeIds(previous => {
      if (previous.has(node.id)) return previous;
      const next = new Set(previous);
      next.add(node.id);
      return next;
    });
  }, []);

  const handleAddBlankPage = () => {
    setNodes(prev => {
      if (selectedIndices.size === 0) {
        return [...prev, { id: `blank-${Date.now()}`, type: 'blank', rotation: 0 }];
      }

      const newNodes = [...prev];
      // Sắp xếp giảm dần để khi chèn splice không làm sai lệch index của các phần tử phía trước
      const sortedSelected = Array.from(selectedIndices).sort((a, b) => b - a);
      
      sortedSelected.forEach((index, i) => {
        const targetNode = newNodes[index];

        if (targetNode.type === 'collapsed_group') {
          // Chèn vào cuối mảng pages của group đang gộp
          const updatedGroup = { ...targetNode, pages: [...(targetNode.pages || [])] };
          updatedGroup.pages.push({
            id: `blank-${Date.now()}-${i}`,
            type: 'blank',
            rotation: 0,
            groupId: targetNode.groupId,
            groupName: targetNode.groupName,
          });
          newNodes[index] = updatedGroup;
        } else {
          // Chèn ngay sau lưng node hiện tại, kế thừa groupId nếu nó thuộc một group đã Xổ ra
          newNodes.splice(index + 1, 0, {
            id: `blank-${Date.now()}-${i}`,
            type: 'blank',
            rotation: 0,
            groupId: targetNode.groupId,
            groupName: targetNode.groupName,
          });
        }
      });
      
      return newNodes;
    });
    setSelectedIndices(new Set());
  };

  const handleRotateNode = (index: number) => {
    setNodes(prev => {
      const copy = [...prev];
      copy[index] = { ...copy[index], rotation: ((copy[index].rotation || 0) + 90) % 360 };
      return copy;
    });
  };

  const draggedIndexRef = useRef<number | null>(null);
  const [draggedIndexState, setDraggedIndexState] = useState<number | null>(null);
  const [hoverTargetIndex, setHoverTargetIndex] = useState<number | null>(null);
  const [animationParent] = useAutoAnimate();
  
  const pointerDragContext = useRef<{ draggedIndex: number | null, hoverIndex: number | null }>({ draggedIndex: null, hoverIndex: null });

  // Initialize nodes from files
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0 && nodes.length === 0) {
      const initNodes: CombineNode[] = initialFiles.map((f, i) => ({
        id: `init-${i}-${Date.now()}`,
        type: 'single' as const,
        file: f,

        rotation: 0
      }));
      setNodes(initNodes);
    }
  }, [initialFiles]);

  // Async update page counts
  useEffect(() => {
    const fetchPageCounts = async () => {
      const updates: Record<string, number> = {};
      let hasUpdates = false;
      
      for (const node of nodes) {
        if (node.type === 'single' && !node.groupId && node.file) {
          const id = `${node.file.name}-${node.file.size}`;
          if (pageCounts[id] === undefined && node.file.name.toLowerCase().endsWith('.pdf')) {
            try {
              const bytes = await getFileArrayBuffer(node.file);
              const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
              updates[id] = doc.getPageCount();
              hasUpdates = true;
            } catch {
              updates[id] = 1;
              hasUpdates = true;
            }
          }
        }
      }
      
      if (hasUpdates) {
        setPageCounts(prev => ({ ...prev, ...updates }));
      }
    };
    
    fetchPageCounts();
  }, [nodes, pageCounts]);

  const handleAddFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files).filter(f =>
        f.name.toLowerCase().endsWith('.pdf') || isSupportedImageFileName(f.name)
      );
      const newNodes: CombineNode[] = newFiles.map((f, i) => ({
        id: `added-${Date.now()}-${i}`,
        type: 'single' as const,
        file: f,

        rotation: 0
      }));
      setNodes(prev => [...prev, ...newNodes]);
      // groupByPageSize bật → useEffect sẽ đo + sắp lại view
    }
  };

  const handleExpandFile = async (index: number) => {
    const nodeToExpand = nodes[index];
    if ((nodeToExpand.type !== 'single' && nodeToExpand.type !== 'collapsed_group') || !nodeToExpand.file) return;
    
    let pCount = 1;
    if (nodeToExpand.type === 'collapsed_group') pCount = nodeToExpand.pages?.length || 1;
    else pCount = pageCounts[`${nodeToExpand.file.name}-${nodeToExpand.file.size}`] || 1;
    
    if (pCount <= 1) return;

    // If it's a collapsed group, just restore its children
    if (nodeToExpand.type === 'collapsed_group' && nodeToExpand.pages) {
      setNodes(prev => {
        const copy = [...prev];
        copy.splice(index, 1, ...nodeToExpand.pages!);
        return copy;
      });
      return;
    }

    // Lazy extraction: Instant Expand!
    const extractedNodes: CombineNode[] = [];
    const groupId = `grp-${Date.now()}`;
    const groupName = nodeToExpand.file.name;
    
    for (let i = 0; i < pCount; i++) {
      extractedNodes.push({
        id: `extracted-${groupId}-${i}`,
        type: 'single',
        file: nodeToExpand.file, // Keep reference to original file

        rotation: nodeToExpand.rotation,
        pageIndex: i, // We use this at Combine time to extract the specific page
        groupId,
        groupName
      });
    }
    
    setNodes(prev => {
      const copy = [...prev];
      copy.splice(index, 1, ...extractedNodes);
      return copy;
    });
  };

  const handleCollapseGroup = (groupId: string, groupName: string) => {
    setNodes(prev => {
      const groupNodes = prev.filter(n => n.groupId === groupId);
      if (groupNodes.length === 0) return prev;
      
      const firstIndex = prev.findIndex(n => n.groupId === groupId);
      const remainingNodes = prev.filter(n => n.groupId !== groupId);
      
      const collapsedNode: CombineNode = {
        id: `collapsed-${groupId}`,
        type: 'collapsed_group',
        file: groupNodes[0].file, // Representative thumbnail

        pages: groupNodes,
        groupName
      };
      
      remainingNodes.splice(firstIndex, 0, collapsedNode);
      return remainingNodes;
    });
    setSelectedIndices(new Set());
  };

  const handleRemoveNodes = (indicesToRemove: number[]) => {
    setNodes(prev => prev.filter((_, i) => !indicesToRemove.includes(i)));
    setSelectedIndices(new Set());
  };

  const handleCardClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (e.ctrlKey || e.metaKey) {
        if (next.has(index)) next.delete(index);
        else next.add(index);
      } else if (e.shiftKey && next.size > 0) {
        const lastSelected = Array.from(next).pop()!;
        const start = Math.min(lastSelected, index);
        const end = Math.max(lastSelected, index);
        for (let i = start; i <= end; i++) next.add(i);
      } else {
        next.clear();
        next.add(index);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIndices.size > 0) {
          handleRemoveNodes(Array.from(selectedIndices));
        }
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
        e.preventDefault();
        setSelectedIndices(new Set(nodes.map((_, i) => i)));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, selectedIndices, nodes]);

  // Pointer Events Drag and Drop
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return; // Only left click

    const target = e.currentTarget;

    // Handle selection if not holding modifiers
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (!selectedIndices.has(index)) {
        setSelectedIndices(new Set([index]));
      }
    }

    pointerDragContext.current.draggedIndex = index;
    pointerDragContext.current.hoverIndex = index;
    draggedIndexRef.current = index;
    
    setDraggedIndexState(index);
    setHoverTargetIndex(index);

    const pointerId = e.pointerId;
    target.setPointerCapture(pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const overElement = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const cardEl = overElement?.closest('[data-combine-index]');

      if (cardEl) {
        const hoverIdxStr = cardEl.getAttribute('data-combine-index');
        if (hoverIdxStr) {
          const hIdx = parseInt(hoverIdxStr, 10);
          if (pointerDragContext.current.hoverIndex !== hIdx) {
            pointerDragContext.current.hoverIndex = hIdx;
            setHoverTargetIndex(hIdx);
          }
        }
      } else {
        if (pointerDragContext.current.hoverIndex !== null) {
          pointerDragContext.current.hoverIndex = null;
          setHoverTargetIndex(null);
        }
      }
    };

    const onPointerUp = () => {
      target.releasePointerCapture(pointerId);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerUp);

      const dropIndex = pointerDragContext.current.hoverIndex;
      const draggedIdx = pointerDragContext.current.draggedIndex;

      if (draggedIdx !== null && dropIndex !== null && draggedIdx !== dropIndex) {
        setNodes(prev => {
          const newNodes = [...prev];
          const [draggedItem] = newNodes.splice(draggedIdx, 1);
          newNodes.splice(dropIndex, 0, draggedItem);
          return newNodes;
        });
      }

      pointerDragContext.current.draggedIndex = null;
      pointerDragContext.current.hoverIndex = null;
      draggedIndexRef.current = null;
      setDraggedIndexState(null);
      setHoverTargetIndex(null);
    };

    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
  };

  const handleInterleave = async () => {
    if (nodes.length < 2) return;

    const requestGeneration = combineJobGenerationRef.current + 1;
    combineJobGenerationRef.current = requestGeneration;
    combineJobAbortRef.current?.abort();
    combineJobAbortRef.current = null;
    let delegatedController: AbortController | null = null;

    setIsProcessing(true);
    setIsDelegatedCombineRunning(false);
    setDelegatedCombineProgress(0);
    setCompletedCombineNodeIds(new Set());
    setIsCancellingCombine(false);
    setStatusMsg(t('tabs.combine:dang_xu_ly_dan_xen'));

    try {
      const topLevelFiles = nodes.filter(n => n.type === 'collapsed_group' || (n.type === 'single' && !n.groupId));
      const progressNodes = topLevelFiles;
      const canDelegateInterleave = topLevelFiles.length === nodes.length
        && shouldDelegateLargePdfJob(topLevelFiles, pageCounts, {
          scaleMode,
          requireTopLevel: true,
        });
      if (canDelegateInterleave) {
        delegatedController = new AbortController();
        combineJobAbortRef.current = delegatedController;
        setIsDelegatedCombineRunning(true);
        setStatusMsg(t('tabs.combine:dang_ghep_backend_progress', { progress: 0 }));
        const interleaveSourceFiles = topLevelFiles.map(n => n.file!);
        const result = await backendMergePdfsJob(
          interleaveSourceFiles,
          'interleave',
          {
            signal: delegatedController.signal,
            onProgress: (status) => {
              if (
                delegatedController?.signal.aborted
                || combineJobGenerationRef.current !== requestGeneration
              ) return;
              const progress = Math.min(100, Math.max(0, Math.round(status.progress || 0)));
              setDelegatedCombineProgress(progress);
              setCompletedCombineNodeIds(backendCompletedNodeIds(
                progressNodes,
                interleaveSourceFiles,
                status.completed_source_indices,
              ));
              setStatusMsg(t('tabs.combine:dang_ghep_backend_progress', { progress }));
            },
          },
        );
        if (
          delegatedController.signal.aborted
          || combineJobGenerationRef.current !== requestGeneration
        ) return;
        const finalFile = createDelegatedResultFile(result, 'Interleaved.pdf');
        if (onSpawnTab) {
          onSpawnTab(finalFile);
          onResultsOpened?.();
        }
        return;
      }
      const finalDoc = await PDFDocument.create();
      const loadedDocs = new Map<File, PDFDocument>();
      
      const pdfsToInterleave: PDFDocument[] = [];
      const interleaveNodes: CombineNode[] = [];
      const rotations: number[] = [];
      
      let firstPageSize: [number, number] | null = null;
      const A4_SIZE: [number, number] = [595.28, 841.89];

      for (const p of topLevelFiles) {
        if (p.type === 'blank') continue;
        let srcDoc = loadedDocs.get(p.file!);
        if (!srcDoc) {
          const bytes = await getFileArrayBuffer(p.file!);
          if (p.file!.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
            srcDoc = await imageBytesToPdfDoc(bytes, p.file!.name);
          } else {
            srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          }
          loadedDocs.set(p.file!, srcDoc);
        }
        pdfsToInterleave.push(srcDoc);
        interleaveNodes.push(p);
        rotations.push(p.rotation || 0);
      }

      if (pdfsToInterleave.length === 0) throw new Error(t('tabs.combine:khong_co_du_lieu_hop_le_de_dan_xen'));

      const maxPages = Math.max(...pdfsToInterleave.map(d => d.getPageCount()));

      // Tối ưu hoá tốc độ (Super Fast Batch Copy): Copy toàn bộ trang 1 lần thay vì gọi copyPages trong vòng lặp (gây thắt nút cổ chai)
      const copiedPagesByDoc: any[][] = [];
      for (let j = 0; j < pdfsToInterleave.length; j++) {
        const doc = pdfsToInterleave[j];
        const indices = Array.from({ length: doc.getPageCount() }, (_, i) => i);
        const copied = await finalDoc.copyPages(doc, indices);
        copiedPagesByDoc.push(copied);
      }

      for (let i = 0; i < maxPages; i++) {
        for (let j = 0; j < pdfsToInterleave.length; j++) {
          if (i < copiedPagesByDoc[j].length) {
            const copiedPage = copiedPagesByDoc[j][i];
            
            if (rotations[j]) {
              copiedPage.setRotation(degrees(copiedPage.getRotation().angle + rotations[j]));
            }

            if (!firstPageSize) {
              const angle = copiedPage.getRotation().angle % 360;
              if (angle === 90 || angle === 270) {
                firstPageSize = [copiedPage.getHeight(), copiedPage.getWidth()];
              } else {
                firstPageSize = [copiedPage.getWidth(), copiedPage.getHeight()];
              }
            }

            finalDoc.addPage(copiedPage);
            if (i === copiedPagesByDoc[j].length - 1) {
              markCombineNodeCompleted(interleaveNodes[j]);
            }
          }
        }
      }

      if (finalDoc.getPageCount() === 0) {
        throw new Error(t('tabs.combine:khong_co_trang_hop_le_de_ghep'));
      }
      let finalBytes = await finalDoc.save();

      if (scaleMode !== 'keep') {
        setStatusMsg(t('tabs.combine:dang_dong_bo_kho_giay'));
        const targetSize = scaleMode === 'fit_a4' ? A4_SIZE : (firstPageSize || A4_SIZE);
        const targetW = targetSize[0] / 2.83465;
        const targetH = targetSize[1] / 2.83465;
        const { resizePages } = await import('../lib/preprocessEngine/PageResizer');
        finalBytes = await resizePages(finalBytes, { targetW, targetH, scaleMode: 'fit', applyTo: 'all' });
      }

      const finalFile = createPdfFileFromBytes(finalBytes, 'Interleaved.pdf', t('lib.processHandlers:khong_ghep_duoc_pdf'));
      if (onSpawnTab) {
        onSpawnTab(finalFile);
        onResultsOpened?.();
      }

    } catch (e: unknown) {
      const isStale = combineJobGenerationRef.current !== requestGeneration;
      const isCancelled = delegatedController?.signal.aborted
        || (e instanceof DOMException && e.name === 'AbortError');
      if (!isStale && !isCancelled) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error(t('tabs.combine:loi_khi_dan_xen', { msg: message }));
      }
    } finally {
      if (combineJobGenerationRef.current === requestGeneration) {
        if (combineJobAbortRef.current === delegatedController) {
          combineJobAbortRef.current = null;
        }
        setIsProcessing(false);
        setIsDelegatedCombineRunning(false);
        setDelegatedCombineProgress(0);
        setIsCancellingCombine(false);
        setStatusMsg('');
      }
    }
  };

  /** Load PDF/ảnh vào cache (dùng chung combine 1 nhóm / nhiều nhóm). */
  const loadSrcDoc = async (
    file: File,
    loadedDocs: Map<File, PDFDocument>,
  ): Promise<PDFDocument> => {
    let srcDoc = loadedDocs.get(file);
    if (srcDoc) return srcDoc;
    const bytes = await getFileArrayBuffer(file);
    if (file.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
      srcDoc = await imageBytesToPdfDoc(bytes, file.name);
    } else {
      srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    }
    loadedDocs.set(file, srcDoc);
    return srcDoc;
  };

  /**
   * Ghép 1 dãy node phẳng → bytes PDF.
   * Trả thêm firstPageSize (pt) để scaleMode fit_first.
   */
  const combineFlatNodes = async (
    flatNodes: CombineNode[],
    loadedDocs: Map<File, PDFDocument>,
    statusPrefix = '',
    onNodeComplete?: (node: CombineNode) => void,
  ): Promise<Uint8Array> => {
    const finalDoc = await PDFDocument.create();
    let firstPageSize: [number, number] | null = null;
    const A4_SIZE: [number, number] = [595.28, 841.89];

    for (let i = 0; i < flatNodes.length; i++) {
      const p = flatNodes[i];

      if (p.type === 'blank') {
        const size = scaleMode === 'fit_a4' ? A4_SIZE : (firstPageSize || A4_SIZE);
        const page = addRotatedBlankPage(finalDoc, size as [number, number], p.rotation || 0);
        if (!firstPageSize) firstPageSize = visiblePageSize(page);
        onNodeComplete?.(p);
        continue;
      }

      if (!p.file) continue;
      if (p.file.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
        // PERF (audit 2026-08-02 §B.1): nhúng thẳng vào finalDoc; tạo PDF ảnh tạm rồi
        // copyPages làm đúng kết quả nhưng chiếm phần lớn thời gian của ca nhiều PNG.
        const bytes = await getFileArrayBuffer(p.file);
        const page = await appendImagePageToPdfDoc(finalDoc, bytes, p.file.name);
        if (p.rotation) {
          page.setRotation(degrees(page.getRotation().angle + p.rotation));
        }
        if (!firstPageSize) firstPageSize = visiblePageSize(page);
        onNodeComplete?.(p);
        continue;
      }
      const srcDoc = await loadSrcDoc(p.file, loadedDocs);
      const pageIndices = p.pageIndex !== undefined ? [p.pageIndex] : srcDoc.getPageIndices();
      const copiedPages = await finalDoc.copyPages(srcDoc, pageIndices);

      for (let j = 0; j < copiedPages.length; j++) {
        const page = copiedPages[j];
        if (p.rotation) {
          page.setRotation(degrees(page.getRotation().angle + p.rotation));
        }

        if (!firstPageSize) {
          firstPageSize = visiblePageSize(page);
        }

        finalDoc.addPage(page);
      }
      onNodeComplete?.(p);
    }

    if (finalDoc.getPageCount() === 0) {
      throw new Error(t('tabs.combine:khong_co_trang_hop_le_de_ghep'));
    }
    let finalBytes = await finalDoc.save();

    if (scaleMode !== 'keep') {
      setStatusMsg(`${statusPrefix}${t('tabs.combine:dang_dong_bo_kho_giay')}`);
      const targetSize = scaleMode === 'fit_a4' ? A4_SIZE : (firstPageSize || A4_SIZE);
      const targetW = targetSize[0] / 2.83465;
      const targetH = targetSize[1] / 2.83465;
      const { resizePages } = await import('../lib/preprocessEngine/PageResizer');
      finalBytes = await resizePages(finalBytes, { targetW, targetH, scaleMode: 'fit', applyTo: 'all' });
    }
    return finalBytes;
  };

  // Ctrl+P → ghép các node ĐANG THẤY thành 1 PDF (bỏ qua chia-nhóm-theo-size, in
  // toàn bộ đúng thứ tự đang xem) rồi in native. Combine là editor ghép, không có
  // "1 file thường trực" nên phải build blob tại thời điểm in. Dùng hạ tầng chung.
  const handlePrint = useCallback(async () => {
    const flatNodes = nodes.flatMap(n => n.type === 'collapsed_group' && n.pages ? n.pages : [n]);
    if (flatNodes.length === 0) { toast.info(t('tabs.combine:chua_co_trang_de_in')); return; }
    setIsProcessing(true);
    setCompletedCombineNodeIds(new Set());
    setStatusMsg(t('tabs.combine:dang_chuan_bi_in'));
    try {
      const bytes = await combineFlatNodes(flatNodes, new Map());
      const blob = createPdfBlobFromBytes(bytes, t('lib.processHandlers:khong_ghep_duoc_pdf'));
      await openPrintDialog({ source: blob, numPages: flatNodes.length });
    } catch (e: any) {
      toast.error(t('tabs.combine:khong_the_in_file') + (e?.message || e));
    } finally {
      setIsProcessing(false);
      setStatusMsg('');
    }
  }, [nodes, openPrintDialog, t]);

  useEffect(() => {
    const onTriggerPrint = (e: any) => {
      if (isActive && e.detail?.tabId === tabId) handlePrint();
    };
    window.addEventListener('app-trigger-print', onTriggerPrint);
    return () => window.removeEventListener('app-trigger-print', onTriggerPrint);
  }, [isActive, tabId, handlePrint]);

  /** Đo sizeKey (mm) của 1 node — cùng quy ước kích thước hiển thị viewer. */
  const measureNodeSizeKey = async (
    node: CombineNode,
    loadedDocs: Map<File, PDFDocument>,
    prevKey: string | null,
  ): Promise<string> => {
    const { pageSizeKeyMm } = await import('../lib/combineGroupBySize');
    if (node.type === 'blank') {
      if (prevKey) return prevKey;
      return pageSizeKeyMm(595.28, 841.89, 0);
    }
    // collapsed_group: đo trang đầu của group (hoặc file)
    if (node.type === 'collapsed_group' && node.pages && node.pages.length > 0) {
      return measureNodeSizeKey(node.pages[0], loadedDocs, prevKey);
    }
    if (!node.file) return prevKey || pageSizeKeyMm(595.28, 841.89, 0);
    const srcDoc = await loadSrcDoc(node.file, loadedDocs);
    const idx = node.pageIndex !== undefined ? node.pageIndex : 0;
    const page = srcDoc.getPage(Math.min(idx, Math.max(0, srcDoc.getPageCount() - 1)));
    const baseAngle = page.getRotation().angle || 0;
    const angle = (baseAngle + (node.rotation || 0)) % 360;
    return pageSizeKeyMm(page.getWidth(), page.getHeight(), angle);
  };

  /**
   * Đo + gán sizeKey + sắp nodes theo nhóm kích thước (giữ thứ tự trong cùng size).
   * Gọi ngay khi tick "Chia nhóm" hoặc khi thêm file lúc đang bật chia nhóm.
   */
  const regroupNodesBySize = useCallback(async (source: CombineNode[]): Promise<CombineNode[]> => {
    if (source.length === 0) return source;
    const loadedDocs = new Map<File, PDFDocument>();
    const measured: CombineNode[] = [];
    let prevKey: string | null = null;
    for (const n of source) {
      const sizeKey = await measureNodeSizeKey(n, loadedDocs, prevKey);
      prevKey = sizeKey;
      measured.push({ ...n, sizeKey });
    }
    // Sắp theo sizeKey; cùng key giữ thứ tự tương đối (stable)
    const indexed = measured.map((n, i) => ({ n, i }));
    indexed.sort((a, b) => {
      const c = (a.n.sizeKey || '').localeCompare(b.n.sizeKey || '', undefined, { numeric: true });
      return c !== 0 ? c : a.i - b.i;
    });
    return indexed.map(x => x.n);
  }, []);

  /** Chạy đo + sắp nhóm; force=true khi user tick lại (bỏ qua cache sizeKey). */
  const runRegroup = useCallback(async (source: CombineNode[], opts?: { toast?: boolean }) => {
    if (source.length === 0) return;
    setIsGrouping(true);
    setStatusMsg(t('tabs.combine:dang_chia_nhom_theo_kich_thuoc'));
    try {
      const next = await regroupNodesBySize(source);
      // Chặn useEffect re-entry sau setNodes
      skipNextRegroupRef.current = true;
      setNodes(next);
      setSelectedIndices(new Set());
      const nGroups = new Set(next.map(n => n.sizeKey).filter(Boolean)).size;
      if (opts?.toast && nGroups > 0) {
        toast.success(t('tabs.combine:da_chia_nhom_tren_view_bam_combine', { n: nGroups }));
      }
    } catch (e: any) {
      toast.error(t('tabs.combine:khong_do_duoc_kich_thuoc', { msg: e?.message || e }));
    } finally {
      setIsGrouping(false);
      setStatusMsg('');
    }
  }, [regroupNodesBySize]);

  // Thêm file khi đang bật chia nhóm → sắp lại (không dùng cho tick ON — tick gọi runRegroup trực tiếp)
  useEffect(() => {
    if (!groupByPageSize) return;
    if (nodes.length === 0) return;
    if (skipNextRegroupRef.current) {
      skipNextRegroupRef.current = false;
      return;
    }
    // Chỉ re-group khi có node CHƯA có sizeKey (file mới thêm)
    const needsMeasure = nodes.some(n => !n.sizeKey);
    if (!needsMeasure) return;

    let cancelled = false;
    (async () => {
      await runRegroup(nodes, { toast: false });
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [groupByPageSize, nodes, runRegroup]);

  const handleToggleGroupBySize = (checked: boolean) => {
    if (!checked) {
      // Tắt: gỡ sizeKey. skipNext=false để lần tick sau không bị nuốt.
      skipNextRegroupRef.current = false;
      setGroupByPageSize(false);
      setNodes(prev => prev.map(n => {
        const rest = { ...n };
        delete rest.sizeKey;
        return rest;
      }));
      return;
    }
    // Bật / tick lại: LUÔN đo + sắp (không dựa useEffect — tránh skipNext kẹt).
    // skipNext=true chặn useEffect do setGroupByPageSize(true) chạy song song.
    skipNextRegroupRef.current = true;
    setGroupByPageSize(true);
    void runRegroup(nodes, { toast: true });
  };

  const handleCancelCombine = useCallback(() => {
    const controller = combineJobAbortRef.current;
    if (!controller || controller.signal.aborted) return;
    setIsCancellingCombine(true);
    setStatusMsg(t('tabs.combine:dang_huy'));
    controller.abort();
  }, [t]);

  const handleCombine = async () => {
    if (nodes.length === 0) return;

    const requestGeneration = combineJobGenerationRef.current + 1;
    combineJobGenerationRef.current = requestGeneration;
    combineJobAbortRef.current?.abort();
    combineJobAbortRef.current = null;
    let delegatedController: AbortController | null = null;

    setIsProcessing(true);
    setIsDelegatedCombineRunning(false);
    setDelegatedCombineProgress(0);
    setCompletedCombineNodeIds(new Set());
    setIsCancellingCombine(false);
    setStatusMsg(t('tabs.combine:dang_xu_ly_tai_lieu'));

    try {
      const loadedDocs = new Map<File, PDFDocument>();
      const flatNodes = nodes.flatMap(n => n.type === 'collapsed_group' && n.pages ? n.pages : [n]);
      const progressNodes = flatNodes;

      if (!groupByPageSize) {
        // PERF (audit 2026-08-01 §B.1): chỉ đọc header ảnh có giới hạn để chọn
        // tầng xử lý; không giải mã bitmap trong WebView chỉ để ước lượng tải.
        const totalImagePixels = await estimateCombineImagePixels(flatNodes);
        const memoryStatus = totalImagePixels > 0
          ? await getCombineMemoryStatus()
          : null;
        const canDelegateMerge = shouldDelegateLargePdfJob(flatNodes, pageCounts, {
          scaleMode,
          groupingEnabled: groupByPageSize,
          allowManifest: true,
          totalImagePixels,
          memoryStatus,
        });
        const sourceFiles = [
          ...new Set(flatNodes.flatMap(node => node.file ? [node.file] : [])),
        ];
        console.info('[COMBINE]', {
          stage: 'delegation_decision',
          nodeCount: flatNodes.length,
          sourceCount: sourceFiles.length,
          imageNodeCount: flatNodes.filter(node =>
            isSupportedImageFileName(node.file?.name || '')
          ).length,
          totalEncodedBytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
          totalImagePixels,
          systemTotalMemoryBytes: memoryStatus?.totalBytes ?? null,
          systemAvailableMemoryBytes: memoryStatus?.availableBytes ?? null,
          path: canDelegateMerge ? 'backend_manifest' : 'frontend',
        });
        if (canDelegateMerge) {
          delegatedController = new AbortController();
          combineJobAbortRef.current = delegatedController;
          setIsDelegatedCombineRunning(true);
          setStatusMsg(t('tabs.combine:dang_ghep_backend_progress', { progress: 0 }));
          const { files, manifest } = buildBackendCombineManifest(flatNodes);
          const result = await backendMergeManifestJob(files, manifest, {
            signal: delegatedController.signal,
            onProgress: (status) => {
              if (
                delegatedController?.signal.aborted
                || combineJobGenerationRef.current !== requestGeneration
              ) return;
              const progress = Math.min(100, Math.max(0, Math.round(status.progress || 0)));
              setDelegatedCombineProgress(progress);
              setCompletedCombineNodeIds(backendCompletedNodeIds(
                progressNodes,
                files,
                status.completed_source_indices,
              ));
              setStatusMsg(t('tabs.combine:dang_ghep_backend_progress', { progress }));
            },
          });
          if (
            delegatedController.signal.aborted
            || combineJobGenerationRef.current !== requestGeneration
          ) return;
          const finalFile = createDelegatedResultFile(result, result.filename);
          if (onSpawnTab) {
            onSpawnTab(finalFile);
            onResultsOpened?.();
          }
          return;
        }
      }


      // ── Không chia nhóm: 1 file → tab imposition (hành vi cũ) ──
      if (!groupByPageSize) {
        const finalBytes = await combineFlatNodes(flatNodes, loadedDocs, '', markCombineNodeCompleted);
        const finalFile = createPdfFileFromBytes(finalBytes, 'Combined.pdf', t('lib.processHandlers:khong_ghep_duoc_pdf'));
        if (onSpawnTab) {
          onSpawnTab(finalFile);
          onResultsOpened?.();
        }
        return;
      }

      // ── Đã chia nhóm trên view → ghép từng nhóm, tab hiện tại = nhóm 1, còn lại tab mới ──
      // (sizeKeyLabel / groupBySizeKey import tĩnh ở đầu file — không dùng require)

      // Ưu tiên sizeKey đã gán trên view; thiếu thì đo lại
      type SizedNode = CombineNode & { sizeKey: string };
      const sized: SizedNode[] = [];
      let prevKey: string | null = null;
      for (const n of flatNodes) {
        let sizeKey = n.sizeKey;
        if (!sizeKey) {
          sizeKey = await measureNodeSizeKey(n, loadedDocs, prevKey);
        }
        prevKey = sizeKey;
        sized.push({ ...n, sizeKey });
      }

      const groups = groupBySizeKey(sized);
      if (groups.size === 0) throw new Error(t('tabs.combine:khong_co_trang_hop_le_de_ghep'));

      const results: { file: File; title: string; sizeKey: string }[] = [];
      let gi = 0;
      for (const [key, groupNodes] of groups) {
        gi++;
        const label = sizeKeyLabel(key);
        setStatusMsg(t('tabs.combine:dang_ghep_label_progress', { label, cur: gi, total: groups.size }));
        const bytes = await combineFlatNodes(groupNodes, loadedDocs, `[${label}] `, markCombineNodeCompleted);
        const safeName = key.replace(/[^\d.x×]/gi, '_');
        const file = createPdfFileFromBytes(
          bytes,
          `Combined_${safeName}mm.pdf`,
          t('lib.processHandlers:khong_ghep_duoc_pdf'),
        );
        results.push({
          file,
          title: t('tabs.combine:ghep_label_n_trang', { label, n: groupNodes.length }),
          sizeKey: key,
        });
      }

      // Tab hiện tại ← nhóm đầu (kết quả ngay, không thêm bước)
      const [first, ...rest] = results;

      // UIUX (audit 2026-08-02 §COMB.UI): trong shell thật, kết quả thuộc viewer;
      // không biến tab nguồn thành một màn Combine chỉ chứa file đã ghép.
      if (onSpawnTab && onResultsOpened) {
        for (const result of results) onSpawnTab(result.file);
        toast.success(
          results.length === 1
            ? t('tabs.combine:da_ghep_label', { label: sizeKeyLabel(first.sizeKey) })
            : t('tabs.combine:da_ghep_n_nhom_tab_combine', { n: results.length, rest: rest.length }),
        );
        onResultsOpened();
        return;
      }

      skipNextRegroupRef.current = true;
      setGroupByPageSize(false);
      setNodes([{
        id: `combined-${Date.now()}`,
        type: 'single',
        file: first.file,

        rotation: 0,
      }]);
      setSelectedIndices(new Set());
      onTitleChange?.(first.title);

      if (rest.length > 0 && onSpawnCombineTabs) {
        onSpawnCombineTabs(rest.map(r => ({ file: r.file, title: r.title })));
      } else if (rest.length > 0 && onSpawnTab) {
        for (const r of rest) onSpawnTab(r.file);
      }

      toast.success(
        results.length === 1
          ? t('tabs.combine:da_ghep_label', { label: sizeKeyLabel(first.sizeKey) })
          : t('tabs.combine:da_ghep_n_nhom_tab_combine', { n: results.length, rest: rest.length }),
      );

    } catch (e: unknown) {
      const isStale = combineJobGenerationRef.current !== requestGeneration;
      const isCancelled = delegatedController?.signal.aborted
        || (e instanceof DOMException && e.name === 'AbortError');
      if (!isStale && !isCancelled) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error(t('tabs.combine:loi_khi_ghep_file', { msg: message }));
      }
    } finally {
      if (combineJobGenerationRef.current === requestGeneration) {
        if (combineJobAbortRef.current === delegatedController) {
          combineJobAbortRef.current = null;
        }
        setIsProcessing(false);
        setIsDelegatedCombineRunning(false);
        setDelegatedCombineProgress(0);
        setIsCancellingCombine(false);
        setStatusMsg('');
      }
    }
  };

  // Render loop with grouping (Flattened to prevent flex wrap jumping)
  const renderItems = () => {
    const elements: React.ReactNode[] = [];
    
    let lastSizeKey: string | null = null;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let isGroupLeader = false;

      // Banner nhóm kích thước (khi đang chia nhóm trên view)
      if (groupByPageSize && node.sizeKey && node.sizeKey !== lastSizeKey) {
        lastSizeKey = node.sizeKey;
        const count = nodes.filter(n => n.sizeKey === node.sizeKey).length;
        elements.push(
          <div
            key={`size-hdr-${node.sizeKey}`}
            className="w-full basis-full flex items-center gap-3 mt-2 mb-1 first:mt-0"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30">
              <span className="text-xs font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {sizeKeyLabel(node.sizeKey)}
              </span>
              <span className="text-[11px] text-blue-600/80 dark:text-blue-300/70 font-medium">
                {count} mục
              </span>
            </div>
            <div className="flex-1 h-px bg-blue-200/60 dark:bg-blue-500/20" />
          </div>
        );
      }

      let label = node.type === 'blank' ? t('tabs.combine:trang_trang') : (node.file?.name || '');
      if (node.type === 'single' && node.groupId) {
        const leaderIndex = nodes.findIndex(n => n.groupId === node.groupId);
        isGroupLeader = i === leaderIndex;
        label = isGroupLeader ? (node.groupName || label) : ((node.pageIndex ?? 0) + 1).toString();
      } else if (node.type === 'collapsed_group') {
        label = node.groupName || label;
      }

      elements.push(renderCard(node, i, label, isGroupLeader, node.groupId, node.groupName));
    }
    
    return elements;
  };

  const renderCard = (node: CombineNode, index: number, label: string, isGroupLeader?: boolean, currentGroupId?: string, currentGroupName?: string) => {
    let pCount = 1;
    if (node.type === 'collapsed_group') {
      pCount = node.pages?.length || 1;
    } else if (node.type === 'single' && node.file) {
      pCount = pageCounts[`${node.file.name}-${node.file.size}`] || 1;
    }
    
    // Extracted pages inside a group are strictly single pages
    if (node.groupId) {
      pCount = 1;
    }

    const isMultiPage = pCount > 1;
    const isSelected = selectedIndices.has(index);
    const isCombineComplete = isProcessing && (
      completedCombineNodeIds.has(node.id)
      || Boolean(
        node.type === 'collapsed_group'
        && node.pages?.length
        && node.pages.every(page => completedCombineNodeIds.has(page.id))
      )
    );

    return (
      <div
        key={node.id}
        className="relative group flex flex-col items-center w-[160px]"
      >
        {/* Continuous Solid Background for Expanded Group Items */}
        {node.groupId && (
          <div 
            className="absolute -inset-[20px] bg-slate-200/80 dark:bg-zinc-800/80 -z-10 pointer-events-none"
            style={{
              borderRadius: isGroupLeader ? '8px 0 0 8px' : '0px'
            }}
          ></div>
        )}

        {/* Visual Drop Indicator */}
        {hoverTargetIndex === index && draggedIndexRef.current !== index && (
          <div className={`absolute top-0 h-[220px] w-1.5 bg-blue-500 rounded-full z-50 ${draggedIndexRef.current !== null && draggedIndexRef.current > index ? '-left-6' : '-right-6'}`} />
        )}

        {/* The main card */}
        <div
          data-combine-index={index}
          onPointerDown={(e) => handlePointerDown(e, index)}
          onClick={(e) => handleCardClick(e, index)}
          className={`
            relative flex flex-col items-center justify-center w-full h-[220px] 
            bg-white dark:bg-zinc-800 rounded-lg shadow-sm border 
            cursor-pointer select-none touch-none
            ${isSelected ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20 ring-4 ring-blue-500/20 shadow-md scale-[1.02]' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20 hover:shadow-md'}
            ${draggedIndexState === index ? 'opacity-50 scale-95 ring-2 ring-blue-500/50 shadow-xl z-50' : 'opacity-100 z-10'}
          `}
        >
          {/* Full size thumbnail wrapper with overflow-hidden */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-slate-50 dark:bg-zinc-900/50 rounded-lg overflow-hidden">
            {node.type === 'blank' ? (
              <div className="w-full h-full bg-white dark:bg-zinc-800 shadow-inner flex flex-col items-center justify-center gap-2">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-slate-300 dark:text-zinc-600" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                <span className="text-[10px] font-medium text-slate-400">Blank Page</span>
              </div>
            ) : node.file?.name.toLowerCase().endsWith('.pdf') ? (
              <PdfErrorBoundary
                errorLabel={t('imposition.cutExport:khong_xem_truoc_duoc')}
                retryLabel={t('dieline.dieline:thu_lai')}
                resetKey={[
                  node.id,
                  node.pageIndex ?? 0,
                  node.file?.name ?? '',
                  node.file?.size ?? 0,
                ].join(':')}
              >
                <div style={{ transform: `rotate(${node.rotation || 0}deg)`, transition: 'transform 0.3s ease' }} className="w-full h-full flex items-center justify-center">
                  <PdfThumbnail file={node.file!} pageIndex={node.pageIndex ?? 0} />
                </div>
              </PdfErrorBoundary>
            ) : (
              <ImageThumbnail file={node.file!} rotation={node.rotation} />
            )}
          </div>

          {isCombineComplete && (
            <div
              data-combine-complete="true"
              aria-hidden="true"
              className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none"
            >
              <div className="w-8 h-8 rounded-full bg-emerald-500 text-white shadow-lg ring-2 ring-white/90 flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4 4L19 7" />
                </svg>
              </div>
            </div>
          )}

          {/* Visual Stack Layers for Multi-page (Now visible because parent has no overflow-hidden) */}
          {isMultiPage && (
            <>
              <div className="absolute top-1 -right-1 w-full h-full bg-white dark:bg-zinc-800 border border-slate-200 dark:border-white/10 rounded-lg -z-10 shadow-sm pointer-events-none"></div>
              <div className="absolute top-2 -right-2 w-full h-full bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-white/10 rounded-lg -z-20 shadow-sm pointer-events-none"></div>
            </>
          )}
          {/* Index badge */}
          <div className="absolute top-2 left-2 w-5 h-5 bg-white/90 dark:bg-zinc-700/90 text-slate-600 dark:text-zinc-300 rounded-full flex items-center justify-center text-[10px] font-bold z-20 shadow-sm border border-slate-200 dark:border-white/10">
            {index + 1}
          </div>




          {/* Page Count Badge */}
          {isMultiPage && (
            <div className="absolute top-2 right-2 bg-blue-100/90 dark:bg-blue-900/80 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-bold z-20 border border-blue-200/50 dark:border-blue-700/50 backdrop-blur-sm shadow-sm">
              {pCount} pages
            </div>
          )}
        </div>

        {/* Filename/Label below the card */}
        <div className="w-full text-center px-1 relative z-20" style={{ marginTop: '20px' }}>
          <div className="text-sm font-semibold text-slate-700 dark:text-zinc-200 truncate w-full" title={label}>
            {label}
          </div>
          <div className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 font-medium">
            {node.type === 'single' && !node.groupId && node.file && ` ${(node.file.size / 1024 / 1024).toFixed(2)} MB `}
            {node.type === 'collapsed_group' && ` ${t('tabs.combine:nhom_n_trang', { n: pCount })} `}
          </div>
        </div>

        {/* Floating Toolbar */}
        <div className="absolute top-[110px] right-0 translate-x-0 -translate-y-1/2 flex flex-col gap-1 bg-white dark:bg-zinc-800 shadow-[0_4px_20px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.4)] border border-slate-200 dark:border-white/10 rounded-md p-1 invisible opacity-0 group-hover:visible group-hover:opacity-100 group-hover:translate-x-1/2 transition-all duration-200 z-30">
          
          {isGroupLeader ? (
            <button 
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleCollapseGroup(currentGroupId!, currentGroupName!); }}
              className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" 
              title={t('tabs.combine:thu_lai_collapse')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/>
              </svg>
            </button>
          ) : isMultiPage ? (
            <button 
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleExpandFile(index); }}
              className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/30 rounded transition-colors" 
              title={t('tabs.combine:xo_ra_expand_pages')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
            </button>
          ) : null}

          <button 
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRotateNode(index); }}
            className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" 
            title={t('tabs.combine:xoay_90_rotate')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            </svg>
          </button>
          <button 
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemoveNodes([index]); }} 
            className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 rounded transition-colors" 
            title="Remove"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/>
            </svg>
          </button>

          {node.file && (
            <button 
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (onSpawnTab) onSpawnTab(node.file!, { initialFeature: 'view' }); }}
              className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" 
              title="Zoom / Preview"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/>
              </svg>
            </button>
          )}
        </div>

      </div>
    );
  };

  return (
    <div 
      className="flex flex-col h-full bg-slate-50 dark:bg-[#1e1e1e]"
      onDragEnter={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()}
    >
      {printDialog}
      {/* Header Toolbar */}
      <div className="flex items-center justify-between p-4 bg-white dark:bg-[#252526] border-b border-slate-200 dark:border-white/10 shadow-sm shrink-0">
        <div className="flex items-center gap-4">

          <button
            onClick={() => handleAddBlankPage()}
            className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 rounded-md transition-colors text-sm font-medium"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>
            {t('tabs.combine:trang_trang_2')}
          </button>

          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 rounded-md transition-colors text-sm font-medium"
          >
            {/* UIUX (audit 2026-07-27 §D-18): nhãn tiếng Anh → i18n tiếng Việt */}
            {t('tabs.combine:them_file', '+ Thêm file...')}
          </button>
          <input 
            type="file" 
            multiple 
            accept={`.pdf,${IMAGE_ACCEPT_ATTR}`}
            ref={fileInputRef} 
            className="hidden" 
            onChange={handleAddFiles} 
          />
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-600 dark:text-zinc-300">{t('tabs.combine:kich_thuoc_trang')}</span>
            <select
              value={scaleMode}
              onChange={(e) => setScaleMode(e.target.value as any)}
              className="px-3 py-1.5 text-sm bg-white dark:bg-zinc-800 border border-slate-200 dark:border-white/10 rounded-md outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-zinc-300"
            >
              <option value="keep">{t('tabs.combine:giu_nguyen_goc_khong_ep_kho')}</option>
              <option value="fit_a4">{t('tabs.combine:chuan_hoa_ep_tat_ca_ve_kho_a4')}</option>
              <option value="fit_first">{t('tabs.combine:chuan_hoa_bang_dung_trang_dau_tien')}</option>
            </select>
          </div>

          <label
            className="flex items-center gap-2 cursor-pointer select-none px-2 py-1 rounded-md hover:bg-slate-50 dark:hover:bg-zinc-800/80"
            title={t('tabs.combine:do_kich_thuoc_trang_nhu_vung_view')}
          >
            <input
              type="checkbox"
              checked={groupByPageSize}
              onChange={(e) => handleToggleGroupBySize(e.target.checked)}
              disabled={isGrouping || isProcessing}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-slate-700 dark:text-zinc-200 whitespace-nowrap">
              {t('tabs.combine:chia_nhom_theo_kich_thuoc')}
            </span>
          </label>

          {(isProcessing || isGrouping) && (
            <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
              {isDelegatedCombineRunning
                ? `${delegatedCombineProgress}%`
                : statusMsg || (isGrouping ? t('tabs.combine:dang_chia_nhom') : t('tabs.combine:dang_xu_ly'))}
            </div>
          )}

          {isDelegatedCombineRunning && (
            <button
              type="button"
              onClick={handleCancelCombine}
              disabled={isCancellingCombine}
              className="px-3 py-2 border border-rose-300 dark:border-rose-500/50 text-rose-700 dark:text-rose-300 rounded-md transition-colors font-semibold hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCancellingCombine ? t('tabs.combine:dang_huy') : t('tabs.combine:dung')}
            </button>
          )}
          
          <button 
            onClick={handleInterleave}
            disabled={nodes.length < 2 || isProcessing || isGrouping}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors font-bold disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex items-center gap-2"
            title={t('tabs.combine:tron_xen_ke_tung_trang_cua_tat_ca_cac')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
            {t('tabs.combine:tron_dan_xen')}
          </button>

          <button 
            onClick={handleCombine}
            disabled={nodes.length === 0 || isProcessing || isGrouping}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors font-bold disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            title={groupByPageSize
              ? t('tabs.combine:ghep_tung_nhom_tab_nay_nhom_1_cac_nhom')
              : t('tabs.combine:ghep_tat_ca_thanh_1_file')}
          >
            {/* UIUX (audit 2026-07-27 §D-18): nhãn tiếng Anh → i18n tiếng Việt */}
            {groupByPageSize ? t('tabs.combine:combine_theo_nhom') : t('tabs.combine:ghep_file', 'Ghép file')}
          </button>
        </div>
      </div>

      {/* Main Grid Area */}
      <div 
        className="flex-1 overflow-auto p-8 relative"
        onDragEnter={(e) => e.preventDefault()}
        onDragOver={(e) => e.preventDefault()}
      >
        {nodes.length === 0 ? (
          <div
            // UIUX (audit 2026-07-27 §D-18): empty-state click mở dialog thêm file (cùng handler nút '+ Thêm file...')
            onClick={() => fileInputRef.current?.click()}
            className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 cursor-pointer"
          >
            <div className="text-6xl mb-4 opacity-50">📄</div>
            <p className="text-lg font-medium">{t('tabs.combine:chua_co_file_nao_duoc_chon')}</p>
            <p className="text-sm mt-2 opacity-80">{t('tabs.combine:bam_add_files_de_them_pdf_hoac_anh')}</p>
            {/* UIUX (audit 2026-07-27 §D-18): bổ sung hướng dẫn kéo-thả */}
            <p className="text-sm mt-1 opacity-80">{t('tabs.combine:hoac_keo_tha_file_pdf_vao_day', 'hoặc kéo-thả file PDF vào đây')}</p>
          </div>
        ) : (
          <div 
            ref={animationParent}
            className="flex flex-wrap gap-10 items-start max-w-7xl mx-auto pb-12 pt-4 min-h-[400px] relative z-0"
            onClick={() => setSelectedIndices(new Set())}
          >
            {renderItems()}
          </div>
        )}
      </div>
    </div>
  );
}
