import React, { useState, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { statRecentFile } from '../../lib/useRecentFiles'; // §RF.1 (audit menu 2026-07-28)
import { localFileUrl } from '../../lib/localFileTransport';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  path: string;
  name: string;
  active?: boolean;
}

const ThumbnailView = React.memo(({ path, name, active = true }: Props) => {
  const [src, setSrc] = useState<string | { data: Uint8Array }>('');
  const [fileExists, setFileExists] = useState<boolean | null>(null);
  const [imgError, setImgError] = useState(false);

  const isPdf = name.toLowerCase().endsWith('.pdf');
  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;

  useEffect(() => {
    let isActive = true;

    // CHỈ render thumbnail khi tab Home đang HIỆN (active). Khi mở file (Home ẩn),
    // KHÔNG render thumbnail → tránh hàng loạt tile render pdfium serial hoá cạnh
    // tranh với render trang chính → hết "đơ ~5s lúc mở file". Render khi quay lại Home.
    if (!active) return;

    if (isTauri) {
      // ⚠️ KHÔNG readFile cả PDF để vẽ thumbnail nữa: readFile nạp TOÀN BỘ file qua
      // Tauri IPC (file 96MB → ~323MB serialize) → chặn IPC/host vài giây MỖI file →
      // lưới recnt nhiều file lớn = đơ cả app (đã đo Network: nhiều plugin:fs|read_file
      // 100-323MB). Thay bằng protocol tile:// — Rust render trang 1 ở DPI nhỏ (~chục KB,
      // có disk cache), KHÔNG nạp full file. Ảnh/file non-PDF dùng protocol localfile (lazy).
      //
      // Kiểm tra file CÒN TỒN TẠI trước khi request tile: recent file user đã xóa/di
      // chuyển vẫn nằm trong danh sách → nếu request tile sẽ nổ 500 (FS read error) spam
      // console. stat() throw → hiện "Missing" luôn, KHÔNG request tile.
      (async () => {
        // §RF.1: dùng helper dùng chung — nó ghi cờ "file đã mất" vào store nên lưới
        // Home, menu Mở gần đây và thumbnail này cùng thấy một trạng thái.
        const info = await statRecentFile(path);
        if (!info) {
          if (isActive) setFileExists(false);
          return;
        }
        if (!isActive) return;
        if (isPdf) {
          const enc = encodeURIComponent(path);
          // page=1, zoom nhỏ (~0.3) đủ nét cho thumbnail 180px; object-contain tự vừa khung.
          setSrc(`http://tile.localhost/${enc}/1/0.3/0/0/0/0/0`);
          setFileExists(true);
        } else {
          // FILEIO (audit 2026-07-28 §FL.03): ảnh recent có thể ở ổ ngoài scope.
          setSrc(localFileUrl(path));
          setFileExists(true);
        }
      })();
    }
    return () => {
      isActive = false;
    };
  }, [path, isPdf, isTauri, active]);

  if (fileExists === false) {
    return (
      <div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center">
        <span className="text-xs text-slate-400 font-medium px-2 text-center">Missing</span>
      </div>
    );
  }

  if (!src) {
    return <div className="animate-pulse w-full h-full bg-slate-100 dark:bg-zinc-800" />;
  }

  // Tauri: cả PDF (tile://) lẫn ảnh (asset) đều là <img> — nhẹ, không nạp full file.
  if (isTauri) {
    // Tile render lỗi/timeout → hiện placeholder (icon + đuôi file) thay vì ô trắng trơn.
    if (imgError) {
      const ext = (name.split('.').pop() || '').toUpperCase();
      return (
        <div className="w-full h-full bg-slate-100 dark:bg-zinc-800 flex flex-col items-center justify-center gap-1">
          <span className="text-2xl opacity-40">📄</span>
          {ext && <span className="text-[10px] font-semibold text-slate-400">{ext}</span>}
        </div>
      );
    }
    return (
      <img
        src={typeof src === 'string' ? src : undefined}
        alt={name}
        loading="lazy"
        className={`w-full h-full ${isPdf ? 'object-contain bg-white' : 'object-cover'}`}
        onError={() => setImgError(true)}
      />
    );
  }

  // Web (không Tauri): giữ react-pdf để render thumbnail từ URL/blob.
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
      <ThumbnailView key={props.path} {...props} />
    </ThumbnailErrorBoundary>
  );
}
