import { useCallback, useState, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';

interface PDFUploaderProps {
  label: string;
  sublabel: string;
  onFileSelected: (file: File, allFiles?: File[]) => void;
  isUploading?: boolean;
  uploadedName?: string;
  pageCount?: number | null;
  accentColor?: string;
}

export default function PDFUploader({
  label,
  sublabel,
  onFileSelected,
  isUploading = false,
  uploadedName,
  pageCount,
  accentColor = '#3b82f6',
}: PDFUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
      if (!pdfs.length) {
        alert('Vui lòng chọn hoặc thả file PDF');
        return;
      }
      if (pdfs[0].size > 500 * 1024 * 1024) {
        alert('File quá lớn. Tối đa 500MB.');
        return;
      }
      onFileSelected(pdfs[0], pdfs);
    },
    [onFileSelected],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(Array.from(e.dataTransfer.files));
      }
    },
    [handleFiles],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragging(false), []);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(Array.from(e.target.files));
      }
    },
    [handleFiles],
  );

  const handleClick = useCallback(async () => {
    if ((window as any).__TAURI_INTERNALS__) {
      try {
        const selected = await open({
          multiple: true,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected];
          const filesToProcess: File[] = [];
          
          const { stat } = await import('@tauri-apps/plugin-fs');
          for (const p of paths) {
            try {
              const fileStat = await stat(p);
              const name = p.split('\\').pop() || p.split('/').pop() || 'unknown';
              const fileObj = new File([], name, { type: 'application/pdf' });
              Object.defineProperty(fileObj, 'path', { value: p }); // CRITICAL: Retain absolute path
              Object.defineProperty(fileObj, 'size', { value: fileStat.size });
              filesToProcess.push(fileObj);
            } catch (err) {
              console.error("Failed to read", p, err);
            }
          }
          
          if (filesToProcess.length > 0) {
            handleFiles(filesToProcess);
          }
        }
      } catch (err) {
        console.error("Tauri dialog error:", err);
        inputRef.current?.click(); // Fallback to HTML input
      }
    } else {
      inputRef.current?.click();
    }
  }, [handleFiles]);

  const uploaded = !!uploadedName;

  return (
    <div
      className={`upload-zone ${isDragging ? 'drag-over' : ''} ${uploaded ? 'has-file' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={handleClick}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        multiple
        onChange={onChange}
        id={`upload-${label.replace(/\s/g, '-')}`}
      />

      {isUploading ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-400 dark:text-zinc-500">Đang upload...</p>
        </div>
      ) : uploaded ? (
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <div className="text-4xl">✅</div>
          <p className="text-sm font-semibold text-green-600">{(uploadedName || '').length > 30 ? uploadedName?.substring(0, 30) + '...' : uploadedName}</p>
          {pageCount && (
            <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full">
              {pageCount} trang
            </span>
          )}
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">Click để chọn file khác</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl"
            style={{ 
              background: `${accentColor}15`,
              boxShadow: `0 0 20px ${accentColor}30, inset 0 0 10px ${accentColor}20`
            }}
          >
            📄
          </div>
          <div>
            <p className="text-sm font-semibold mb-1" style={{ color: accentColor }}>
              {label}
            </p>
            <p className="text-xs text-slate-400 dark:text-zinc-500">{sublabel}</p>
          </div>
          <p className="text-xs text-slate-400 dark:text-zinc-500 mt-2">
            Kéo thả file PDF vào đây hoặc click để chọn
          </p>
          <p className="text-xs text-slate-500 dark:text-zinc-400">Tối đa 500MB</p>
        </div>
      )}
    </div>
  );
}
