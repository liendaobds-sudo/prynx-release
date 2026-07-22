import { useCallback, useState, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './ui/Toast';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
      if (!pdfs.length) {
        toast.info(t('misc.pDFUploader:vui_long_chon_hoac_tha_file_pdf'));
        return;
      }
      if (pdfs[0].size > 500 * 1024 * 1024) {
        toast.error(t('misc.pDFUploader:file_qua_lon_toi_da_500mb'));
        return;
      }
      onFileSelected(pdfs[0], pdfs);
    },
    [onFileSelected, t],
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
    if ('__TAURI_INTERNALS__' in window) {
      try {
        const selected = await open({
          multiple: true,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected];
          const filesToProcess: File[] = [];
          let unreadableCount = 0;
          
          const { stat } = await import('@tauri-apps/plugin-fs');
          for (const p of paths) {
            let fileSize: number;
            try {
              const fileStat = await stat(p);
              fileSize = Number(fileStat.size);
            } catch (pluginError) {
              // plugin-fs is capability-scoped and may reject a valid file on a
              // network drive, USB drive or a non-home volume. The native command
              // applies the app's sensitive-path checks without that narrow scope.
              try {
                fileSize = Number(await invoke<number>('get_file_size', { path: p }));
              } catch (nativeError) {
                unreadableCount += 1;
                console.error('Failed to inspect selected file', p, pluginError, nativeError);
                continue;
              }
            }

            try {
              const name = p.split('\\').pop() || p.split('/').pop() || 'unknown';
              const fileObj = typeof File === 'function'
                ? new File([], name, { type: 'application/pdf' })
                : Object.assign(new Blob([], { type: 'application/pdf' }), { name }) as File;
              Object.defineProperty(fileObj, 'path', { value: p, configurable: true });
              Object.defineProperty(fileObj, 'size', { value: fileSize, configurable: true });
              filesToProcess.push(fileObj);
            } catch (err) {
              unreadableCount += 1;
              console.error('Failed to create selected file handle', p, err);
            }
          }
          
          if (filesToProcess.length > 0) {
            handleFiles(filesToProcess);
          }
          if (unreadableCount > 0) {
            if (filesToProcess.length > 0) {
              toast.info(t('misc.pDFUploader:mot_so_file_khong_the_doc'));
            } else {
              toast.info(t('misc.pDFUploader:dang_chuyen_sang_bo_chon_tuong_thich'));
              inputRef.current?.click();
            }
          }
        }
      } catch (err) {
        console.error("Tauri dialog error:", err);
        inputRef.current?.click(); // Fallback to HTML input
      }
    } else {
      inputRef.current?.click();
    }
  }, [handleFiles, t]);

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
          <p className="text-sm text-slate-400 dark:text-zinc-500">{t('misc.pDFUploader:dang_upload')}</p>
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
          <p className="text-xs text-slate-500 dark:text-zinc-400 mt-1">{t('misc.pDFUploader:click_de_chon_file_khac')}</p>
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
            {t('misc.pDFUploader:keo_tha_file_pdf_vao_day_hoac_click_de')}
          </p>
          <p className="text-xs text-slate-500 dark:text-zinc-400">{t('misc.pDFUploader:toi_da_500mb')}</p>
        </div>
      )}
    </div>
  );
}
