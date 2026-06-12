import React, { useState, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  path: string;
  name: string;
}

const ThumbnailView = React.memo(({ path, name }: Props) => {
  const [src, setSrc] = useState<string | { data: Uint8Array }>('');
  const [shouldRenderPdf, setShouldRenderPdf] = useState(false);
  const [fileExists, setFileExists] = useState<boolean | null>(null);
  
  useEffect(() => {
    setShouldRenderPdf(false);
    setFileExists(null);
  }, [path]);

  const isPdf = name.toLowerCase().endsWith('.pdf');

  useEffect(() => {
    let isActive = true;
    let timeoutId: NodeJS.Timeout;

    if ((window as any).__TAURI_INTERNALS__) {
      Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/plugin-fs')
      ]).then(([{ convertFileSrc }, { readFile }]) => {
        if (!isActive) return;
        
        if (isPdf) {
          // Use readFile for PDFs to avoid 404 network errors if out of scope
          readFile(path).then((data) => {
            if (!isActive) return;
            setFileExists(true);
            setSrc({ data });
            timeoutId = setTimeout(() => {
              if (isActive) setShouldRenderPdf(true);
            }, 300);
          }).catch(() => {
            if (isActive) {
              setFileExists(false); // Gracefully handle scope/missing file errors
            }
          });
        } else {
          // For images, we still use convertFileSrc
          setSrc(convertFileSrc(path));
          setFileExists(true);
        }
      });
    }
    return () => { 
      isActive = false; 
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [path, isPdf]);

  if (fileExists === false) {
    return (
      <div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center">
        <span className="text-xs text-slate-400 font-medium px-2 text-center">Missing</span>
      </div>
    );
  }

  if (!src || (isPdf && !shouldRenderPdf)) {
    return <div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />;
  }

  if (isPdf) {
    return (
      <Document 
        file={src} 
        loading={<div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />}
        error={<div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center"><span className="text-xs text-slate-400">PDF</span></div>}
        className="flex items-center justify-center w-full h-full overflow-hidden"
      >
        <Page 
          pageNumber={1} 
          width={180} 
          renderTextLayer={false} 
          renderAnnotationLayer={false} 
          className="shadow-none" 
          error={<div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center"><span className="text-xs text-slate-400">Error</span></div>}
        />
      </Document>
    );
  }
  // Fallback for images
  return (
    <img src={typeof src === 'string' ? src : undefined} alt={name} className="object-cover w-full h-full" />
  );
});

class ThumbnailErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean}> {
  constructor(props: any) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) return <div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center"><span className="text-xs text-slate-400">Error</span></div>;
    return this.props.children;
  }
}

export default function ThumbnailViewWrapper(props: Props) {
  return (
    <ThumbnailErrorBoundary>
      <ThumbnailView {...props} />
    </ThumbnailErrorBoundary>
  );
}
