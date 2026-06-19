import React, { useState, useRef, useCallback, useEffect } from 'react';
import { runMerge, type ProcessContext } from '../lib/processHandlers';
import { PDFDocument, degrees } from 'pdf-lib';
import { Document, Page, pdfjs } from 'react-pdf';
import { getFileArrayBuffer } from '../lib/utils';
import { normalizeImageToPngBytes } from '../lib/imageNormalizer';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { toast } from './ui/Toast';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export type CombineNode = {
  id: string;
  type: 'single' | 'collapsed_group' | 'blank';
  file?: File;
  previewUrl?: string;
  rotation?: number;
  
  // For 'single' nodes that are part of an expanded group
  groupId?: string;
  groupName?: string;
  pageIndex?: number; // Zero-indexed. If present, this node visually and physically represents only this specific page.
  
  // For 'collapsed_group'
  pages?: CombineNode[];
};

interface Props {
  tabId?: string;
  isActive?: boolean;
  onTitleChange?: (title: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  initialFiles?: File[];
  onSpawnTab?: (file: File, extraPayload?: any) => void;
}

class PdfErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, retryCount: number}> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, retryCount: 0 };
  }
  static getDerivedStateFromError(error: any) { return { hasError: true }; }
  componentDidCatch(error: any) {
    if (this.state.retryCount < 5) {
      setTimeout(() => this.setState(prev => ({ hasError: false, retryCount: prev.retryCount + 1 })), 100);
    }
  }
  render() {
    if (this.state.hasError) {
      return <div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-[10px] text-slate-400">Loading...</div>;
    }
    return this.props.children;
  }
}

const PdfThumbnail = React.memo(({ file, pageIndex }: { file: string | File; pageIndex: number }) => {
  const [docFile, setDocFile] = useState<string | File | null>(null);

  useEffect(() => {
    let isActive = true;
    if (typeof file !== 'string' && (window as any).__TAURI_INTERNALS__ && (file as any).path) {
      import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
        if (isActive) setDocFile(convertFileSrc((file as any).path));
      });
    } else {
      setDocFile(file);
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

  useEffect(() => {
    let isActive = true;
    if ((window as any).__TAURI_INTERNALS__ && (file as any).path) {
      import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
        if (isActive) setSrc(convertFileSrc((file as any).path));
      });
    } else {
      setSrc(URL.createObjectURL(file));
    }
    return () => { isActive = false; };
  }, [file]);

  if (!src) return <div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />;

  return (
    <img src={src} alt="" style={{ transform: `rotate(${rotation || 0}deg)` }} className="object-contain w-full h-full transition-transform duration-300" />
  );
});

export default function CombineTab({ initialFiles, onSpawnTab, isActive }: Props) {
  const [nodes, setNodes] = useState<CombineNode[]>([]);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [scaleMode, setScaleMode] = useState<'keep' | 'fit_a4' | 'fit_first'>('keep');

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
        previewUrl: URL.createObjectURL(f),
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
            } catch (err) {
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

  // Cleanup object URLs for removed nodes
  const prevNodesRef = useRef<CombineNode[]>([]);
  useEffect(() => {
    const currentUrls = new Set(nodes.map(n => n.previewUrl).filter(Boolean));
    prevNodesRef.current.forEach(prevNode => {
      if (prevNode.previewUrl && !currentUrls.has(prevNode.previewUrl)) {
        URL.revokeObjectURL(prevNode.previewUrl);
      }
    });
    prevNodesRef.current = nodes;
  }, [nodes]);

  const handleAddFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files).filter(f => 
        f.name.toLowerCase().endsWith('.pdf') || 
        f.name.toLowerCase().endsWith('.jpg') || 
        f.name.toLowerCase().endsWith('.jpeg') || 
        f.name.toLowerCase().endsWith('.png')
      );
      const newNodes: CombineNode[] = newFiles.map((f, i) => ({
        id: `added-${Date.now()}-${i}`,
        type: 'single' as const,
        file: f,
        previewUrl: URL.createObjectURL(f),
        rotation: 0
      }));
      setNodes(prev => [...prev, ...newNodes]);
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
        previewUrl: nodeToExpand.previewUrl, // Share the Object URL
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
        previewUrl: groupNodes[0].previewUrl, // Keep representative URL
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

    const onPointerUp = (upEvent: PointerEvent) => {
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

    setIsProcessing(true);
    setStatusMsg('Đang xử lý đan xen...');

    try {
      const finalDoc = await PDFDocument.create();
      const loadedDocs = new Map<File, PDFDocument>();
      
      const topLevelFiles = nodes.filter(n => n.type === 'collapsed_group' || (n.type === 'single' && !n.groupId));
      const pdfsToInterleave: PDFDocument[] = [];
      const rotations: number[] = [];
      
      let firstPageSize: [number, number] | null = null;
      const A4_SIZE: [number, number] = [595.28, 841.89];

      for (const p of topLevelFiles) {
        if (p.type === 'blank') continue;
        let srcDoc = loadedDocs.get(p.file!);
        if (!srcDoc) {
          const bytes = await getFileArrayBuffer(p.file!);
          if (p.file!.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
            srcDoc = await PDFDocument.create();
            const normBytes = await normalizeImageToPngBytes(bytes);
            const img = await srcDoc.embedPng(normBytes);
            const page = srcDoc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          } else {
            srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          }
          loadedDocs.set(p.file!, srcDoc);
        }
        pdfsToInterleave.push(srcDoc);
        rotations.push(p.rotation || 0);
      }

      if (pdfsToInterleave.length === 0) throw new Error("Không có dữ liệu hợp lệ để đan xen.");

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
          }
        }
      }

      let finalBytes = await finalDoc.save();

      if (scaleMode !== 'keep') {
        setStatusMsg('Đang đồng bộ khổ giấy...');
        const targetSize = scaleMode === 'fit_a4' ? A4_SIZE : (firstPageSize || A4_SIZE);
        const targetW = targetSize[0] / 2.83465;
        const targetH = targetSize[1] / 2.83465;
        const { resizePages } = await import('../lib/preprocessEngine/PageResizer');
        finalBytes = await resizePages(finalBytes, { targetW, targetH, scaleMode: 'fit', applyTo: 'all' });
      }

      const finalBlob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const finalFile = new File([finalBlob], 'Interleaved.pdf', { type: 'application/pdf' });
      if (onSpawnTab) onSpawnTab(finalFile);

    } catch (e: any) {
      toast.error("Lỗi khi đan xen: " + (e?.message || e));
    } finally {
      setIsProcessing(false);
      setStatusMsg('');
    }
  };

  const handleCombine = async () => {
    if (nodes.length === 0) return;

    setIsProcessing(true);
    setStatusMsg('Đang xử lý tài liệu...');

    try {
      const finalDoc = await PDFDocument.create();
      const loadedDocs = new Map<File, PDFDocument>();
      
      const flatNodes = nodes.flatMap(n => n.type === 'collapsed_group' && n.pages ? n.pages : [n]);
      
      let firstPageSize: [number, number] | null = null;
      const A4_SIZE: [number, number] = [595.28, 841.89];

      for (let i = 0; i < flatNodes.length; i++) {
        const p = flatNodes[i];
        
        if (p.type === 'blank') {
          const size = scaleMode === 'fit_a4' ? A4_SIZE : (firstPageSize || A4_SIZE);
          finalDoc.addPage(size);
          if (!firstPageSize) firstPageSize = size as [number, number];
          continue;
        }

        let srcDoc = loadedDocs.get(p.file!);
        if (!srcDoc) {
          const bytes = await getFileArrayBuffer(p.file!);
          if (p.file!.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
            srcDoc = await PDFDocument.create();
            const normBytes = await normalizeImageToPngBytes(bytes);
            const img = await srcDoc.embedPng(normBytes);
            const page = srcDoc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          } else {
            srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          }
          loadedDocs.set(p.file!, srcDoc);
        }

        const pageIndices = p.pageIndex !== undefined ? [p.pageIndex] : srcDoc.getPageIndices();
        const copiedPages = await finalDoc.copyPages(srcDoc, pageIndices);

        for (let j = 0; j < copiedPages.length; j++) {
          const page = copiedPages[j];
          if (p.rotation) {
            page.setRotation(degrees(page.getRotation().angle + p.rotation));
          }

          if (!firstPageSize) {
            const angle = page.getRotation().angle % 360;
            if (angle === 90 || angle === 270) {
              firstPageSize = [page.getHeight(), page.getWidth()];
            } else {
              firstPageSize = [page.getWidth(), page.getHeight()];
            }
          }

          finalDoc.addPage(page);
        }
      }

      let finalBytes = await finalDoc.save();

      if (scaleMode !== 'keep') {
        setStatusMsg('Đang đồng bộ khổ giấy...');
        const targetSize = scaleMode === 'fit_a4' ? A4_SIZE : (firstPageSize || A4_SIZE);
        const targetW = targetSize[0] / 2.83465;
        const targetH = targetSize[1] / 2.83465;
        const { resizePages } = await import('../lib/preprocessEngine/PageResizer');
        finalBytes = await resizePages(finalBytes, { targetW, targetH, scaleMode: 'fit', applyTo: 'all' });
      }

      const finalBlob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const finalFile = new File([finalBlob], 'Combined.pdf', { type: 'application/pdf' });
      if (onSpawnTab) onSpawnTab(finalFile);

    } catch (e: any) {
      toast.error("Lỗi khi ghép file: " + (e?.message || e));
    } finally {
      setIsProcessing(false);
      setStatusMsg('');
    }
  };

  // Render loop with grouping (Flattened to prevent flex wrap jumping)
  const renderItems = () => {
    const elements: React.ReactNode[] = [];
    
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let isGroupLeader = false;

      let label = node.type === 'blank' ? 'Trang Trắng' : (node.file?.name || '');
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
              <PdfErrorBoundary>
                <div style={{ transform: `rotate(${node.rotation || 0}deg)`, transition: 'transform 0.3s ease' }} className="w-full h-full flex items-center justify-center">
                  <PdfThumbnail file={node.file!} pageIndex={node.pageIndex ?? 0} />
                </div>
              </PdfErrorBoundary>
            ) : (
              <ImageThumbnail file={node.file!} rotation={node.rotation} />
            )}
          </div>

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
            {node.type === 'collapsed_group' && ` Nhóm ${pCount} trang `}
          </div>
        </div>

        {/* Floating Toolbar */}
        <div className="absolute top-[110px] right-0 translate-x-0 -translate-y-1/2 flex flex-col gap-1 bg-white dark:bg-zinc-800 shadow-[0_4px_20px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.4)] border border-slate-200 dark:border-white/10 rounded-md p-1 invisible opacity-0 group-hover:visible group-hover:opacity-100 group-hover:translate-x-1/2 transition-all duration-200 z-30">
          
          {isGroupLeader ? (
            <button 
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleCollapseGroup(currentGroupId!, currentGroupName!); }}
              className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" 
              title="Thu lại (Collapse)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/>
              </svg>
            </button>
          ) : isMultiPage ? (
            <button 
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleExpandFile(index); }}
              className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-900/30 rounded transition-colors" 
              title="Xổ ra (Expand pages)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
            </button>
          ) : null}

          <button 
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRotateNode(index); }}
            className="w-8 h-8 flex items-center justify-center text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded transition-colors" 
            title="Xoay 90° (Rotate)"
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
      {/* Header Toolbar */}
      <div className="flex items-center justify-between p-4 bg-white dark:bg-[#252526] border-b border-slate-200 dark:border-white/10 shadow-sm shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-zinc-200">Combine Files</h2>
          <div className="h-6 w-px bg-slate-300 dark:bg-white/10 mx-2"></div>
          
          <button
            onClick={() => handleAddBlankPage()}
            className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 rounded-md transition-colors text-sm font-medium"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>
            Trang trắng
          </button>

          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-200 rounded-md transition-colors text-sm font-medium"
          >
            <span className="text-lg leading-none">+</span> Add Files...
          </button>
          <input 
            type="file" 
            multiple 
            accept=".pdf,image/png,image/jpeg,image/jpg" 
            ref={fileInputRef} 
            className="hidden" 
            onChange={handleAddFiles} 
          />
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-600 dark:text-zinc-300">Kích thước trang:</span>
            <select
              value={scaleMode}
              onChange={(e) => setScaleMode(e.target.value as any)}
              className="px-3 py-1.5 text-sm bg-white dark:bg-zinc-800 border border-slate-200 dark:border-white/10 rounded-md outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-zinc-300"
            >
              <option value="keep">Giữ nguyên gốc (Không ép khổ)</option>
              <option value="fit_a4">Chuẩn hoá: Ép tất cả về khổ A4</option>
              <option value="fit_first">Chuẩn hoá: Bằng đúng trang đầu tiên</option>
            </select>
          </div>

          {isProcessing && (
            <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
              {statusMsg || 'Đang xử lý...'}
            </div>
          )}
          
          <button 
            onClick={handleInterleave}
            disabled={nodes.length < 2 || isProcessing}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors font-bold disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex items-center gap-2"
            title="Trộn xen kẽ từng trang của tất cả các file trong danh sách"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
            Trộn đan xen
          </button>

          <button 
            onClick={handleCombine}
            disabled={nodes.length === 0 || isProcessing}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors font-bold disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            Combine
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
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
            <div className="text-6xl mb-4 opacity-50">📄</div>
            <p className="text-lg font-medium">Chưa có file nào được chọn</p>
            <p className="text-sm mt-2 opacity-80">Bấm "Add Files..." để thêm PDF hoặc Ảnh vào danh sách ghép.</p>
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
