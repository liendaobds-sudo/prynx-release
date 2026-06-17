import { useState, useCallback, useEffect } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';

// ── Constants ──
const I = {
  Palette: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>,
  Type: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>,
  Image: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>,
  Layers: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>,
  Crop: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>,
  Overprint: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/></svg>,
  Droplet: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>,
  FileText: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>,
  Eraser: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>,
  PenTool: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>,
  Link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  ZoomIn: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>,
  Film: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M20 7.5h-4"/><path d="M20 16.5h-4"/></svg>,
  Signal: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/></svg>,
  MoveOut: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>,
  Hash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>,
};

const RULES = [
  { id: 'COLOR_RGB_DETECTED',    icon: I.Palette, label: 'Hệ màu RGB',      desc: 'Quét toàn bộ tài liệu để tìm các đối tượng hình ảnh, vector hoặc text đang sử dụng hệ màu RGB/Lab. Các hệ màu này có thể gây sai lệch màu sắc nghiêm trọng khi in offset (CMYK).' },
  { id: 'FONT_NOT_EMBEDDED',     icon: I.Type,    label: 'Font chưa nhúng',  desc: 'Kiểm tra xem tất cả font chữ đã được nhúng (embedded) hoàn toàn vào file PDF chưa. Font chưa nhúng có thể bị thay thế bởi font mặc định của máy RIP, gây lỗi nhảy chữ, lỗi dấu.' },
  { id: 'IMAGE_NOT_EMBEDDED',    icon: I.Link,    label: 'Ảnh chưa Embed (Mất Link)', desc: 'Phát hiện file PDF (được xuất từ Illustrator/Corel) đang chứa đường dẫn ảo thay vì nhúng ảnh thật. Mở bằng phần mềm thiết kế sẽ bị rớt ảnh.' },
  { id: 'TEXT_DETECTED',         icon: I.Type,    label: 'Chữ chưa Outline', desc: 'Cảnh báo an toàn: Phát hiện có Text sống (Live Text) trên mặt giấy. Dù đã nhúng font nhưng nếu bấm Khóa Font trên máy không có font gốc vẫn có thể bị lỗi nhảy chữ. Khuyên dùng.' },
  { id: 'IMAGE_LOW_RES',         icon: I.Image,   label: 'Ảnh low-res',      desc: 'Phát hiện các hình ảnh bitmap có độ phân giải thấp (dưới 300 DPI). Hình ảnh low-res sẽ bị vỡ nét, răng cưa và không đạt chất lượng sắc nét khi in ấn thực tế.' },
  { id: 'TRANSPARENCY_DETECTED', icon: I.Layers,  label: 'Transparency',     desc: 'Đánh dấu các trang chứa đối tượng sử dụng hiệu ứng trong suốt (Transparency, Drop Shadow). Một số hệ thống RIP cũ xử lý sai sẽ gây lỗi mất chi tiết hoặc lộ viền trắng.' },
  { id: 'BLEED_MISSING',         icon: I.Crop,    label: 'Bleed',            desc: 'Kiểm tra xem file PDF có được thiết lập TrimBox và BleedBox hợp lệ hay không. Thiếu lề bù xén (Bleed) sẽ dẫn đến việc lộ viền giấy trắng sau khi gia công cắt xén thành phẩm.' },
  { id: 'OVERPRINT_DETECTED',    icon: I.Overprint, label: 'Overprint',      desc: 'Phát hiện các đối tượng cài đặt Overprint sai quy cách (ví dụ: text màu trắng đánh Overprint sẽ bị tàng hình khi in). Cảnh báo các lỗi cơ chế bóc lấp nền (Knockout).' },
  { id: 'COLOR_SPOT_DETECTED',   icon: I.Droplet, label: 'Spot Color',       desc: 'Phân tích và liệt kê các kênh màu pha (Spot Color / Pantone) đang tồn tại. Giúp tránh việc xuất kẽm in dư màu hoặc hệ thống tính sai chi phí in ấn.' },
  { id: 'IMAGE_HIGH_DPI',        icon: I.ZoomIn,   label: 'Ảnh DPI quá cao', desc: 'Phát hiện ảnh có DPI vượt quá 600. Gây tăng dung lượng file không cần thiết, RIP xử lý chậm. Nên giảm xuống 300 DPI bằng tính năng Downscale.' },
  { id: 'GIF_IN_PDF',            icon: I.Film,     label: 'Ảnh GIF/Indexed', desc: 'Phát hiện ảnh dạng Indexed (GIF/palette) chỉ có tối đa 256 màu. Chất lượng in rất kém, banding, mất chi tiết gradient. Nên thay bằng TIFF hoặc JPEG chất lượng cao.' },
  { id: 'PROGRESSIVE_JPEG',      icon: I.Signal,   label: 'JPEG Progressive', desc: 'Phát hiện ảnh JPEG sử dụng Progressive encoding. Một số hệ thống RIP cũ (đặc biệt PostScript Level 2) không xử lý được, gây lỗi in hoặc hình bị trắng.' },
  { id: 'OBJECT_OFF_PAGE',       icon: I.MoveOut,  label: 'Object ngoài trang', desc: 'Phát hiện đối tượng (text, ảnh, vector, nét vẽ) nằm hoàn toàn bên ngoài vùng in (TrimBox/MediaBox). Có thể gây lỗi RIP hoặc tăng thời gian xử lý không cần thiết. Nên xóa.' },
  { id: 'PDF_VERSION_MISMATCH',  icon: I.Hash,     label: 'Phiên bản PDF',   desc: 'Kiểm tra phiên bản PDF có tương thích với tiêu chuẩn in ấn không. PDF quá cũ (<1.3) thiếu hỗ trợ ICC/Transparency. PDF quá mới (>1.7) có thể không tương thích RIP.' },
];

const ACTIONS = [
  { id: 'CONVERT_TO_CMYK',      icon: I.Palette, title: 'Convert CMYK',          desc: 'Tự động chuyển đổi toàn bộ đối tượng RGB/Lab sang hệ màu CMYK chuẩn in ấn. Sử dụng ICC Profile FOGRA39 (Coated) để đảm bảo độ chuẩn xác màu sắc cao nhất.' },
  { id: 'FLATTEN_TRANSPARENCY',  icon: I.Layers,  title: 'Flatten Transparency',  desc: 'Làm phẳng (Flatten) toàn bộ hiệu ứng trong suốt, bóng đổ thành dạng vector/bitmap tĩnh. Đảm bảo file an toàn tuyệt đối khi xuất kẽm CTP trên mọi hệ thống.' },
  { id: 'OUTLINE_FONTS',        icon: I.PenTool, title: 'Khóa Font',             desc: 'Convert toàn bộ text thành đường path vector (Create Outlines). Giải quyết triệt để lỗi thiếu font, đảm bảo an toàn 100% nhưng sẽ không thể sửa chữ được nữa.' },
  { id: 'EMBED_FONTS',          icon: I.Type,    title: 'Nhúng Font',            desc: 'Cố gắng nhúng các font chữ còn thiếu vào trong file PDF. Chỉ thành công nếu font gốc có sẵn trên hệ thống server. Ít thay đổi cấu trúc file hơn so với Khóa Font.' },
  { id: 'DOWNSCALE_IMAGES',     icon: I.Image,   title: 'Giảm DPI ảnh',          desc: 'Tối ưu hóa dung lượng bằng cách giảm độ phân giải (Downsample) của hình ảnh thừa chi tiết (>600 DPI) xuống chuẩn in ấn 300 DPI. Giúp file nhẹ và RIP nhanh hơn.' },
  { id: 'FIX_METADATA',         icon: I.Eraser,  title: 'Sửa Metadata',          desc: 'Xóa bỏ các dữ liệu ẩn, metadata thừa, comments, form, hoặc các thẻ XML không cần thiết trong cấu trúc PDF. Giúp làm sạch file và ngăn ngừa lỗi tương thích.' },
];

interface Props {
  pdfFile: File | null;
  onFileFixed: (blob: Blob, name: string) => void;
  onIssueSelect?: (issue: any) => void;
  onOpenOutputPreview?: () => void;
}

export default function PreflightTool({ pdfFile, onFileFixed, onIssueSelect, onOpenOutputPreview }: Props) {
  const [fileId, setFileId] = useState('');
  const [selectedRules, setSelectedRules] = useState<Set<string>>(new Set());
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<any>(null);
  const [fixResult, setFixResult] = useState<any>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [fixingAction, setFixingAction] = useState('');
  const [error, setError] = useState('');
  
  // Section toggle state
  const [isInspectOpen, setIsInspectOpen] = useState(true);
  const [isFixOpen, setIsFixOpen] = useState(true);

  // Whenever a new file is loaded (e.g. after fixing), reset the fileId cache and report
  useEffect(() => {
      setFileId('');
      setReport(null);
  }, [pdfFile]);

  // ── Upload file to backend (if not already) ──
  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error('Chưa có file PDF');
    const result = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(result.id);
    return result.id;
  }, [fileId, pdfFile, getWorkingFile]);

  // ── Inspect ──
  const runInspect = useCallback(async () => {
    if (!pdfFile || selectedRules.size === 0) return;
    setIsInspecting(true); setError(''); setReport(null); setFixResult(null);
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/inspect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, rules: Array.from(selectedRules) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Lỗi kiểm tra');
      setReport(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setIsInspecting(false); }
  }, [pdfFile, selectedRules, ensureUploaded]);

  // ── Pipeline (auto-upload if needed) ──
  const runPipeline = useCallback(async () => {
    if (selectedActions.size === 0) return;
    setFixingAction('PIPELINE'); setFixResult(null); setError('');
    try {
      const fid = await ensureUploaded();
      const actions = Array.from(selectedActions).map(id => ({ id, params: {} }));
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/pipeline`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, actions }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Lỗi');
      const data = await res.json();
      setFixResult(data);

      if (data.success && data.output_filename) {
        const pdfRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          onFileFixed(blob, data.output_filename);
          setSelectedActions(new Set()); // Auto-deselect fixed actions
        }
      }
    } catch (e: any) { setError(e.message); }
    finally { setFixingAction(''); }
  }, [selectedActions, ensureUploaded, onFileFixed]);

  const toggleRule = (id: string) => {
    setSelectedRules(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleAction = (id: string) => {
    setSelectedActions(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ════════════════════════════════════════════════ */}
      {/* SECTION 1: CHẨN ĐOÁN (Tùy chọn)               */}
      {/* ════════════════════════════════════════════════ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
            <button 
                onClick={() => setIsInspectOpen(!isInspectOpen)}
                className="flex items-center gap-2 group"
            >
                <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
                    🔍 CHẨN ĐOÁN (TÙY CHỌN)
                </span>
                <span className={`text-[10px] text-slate-400 transition-transform duration-200 ${isInspectOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>
            <button
                onClick={() => {
                    if (selectedRules.size === RULES.length) {
                        setSelectedRules(new Set());
                    } else {
                        setSelectedRules(new Set(RULES.map(r => r.id)));
                    }
                }}
                className="text-[11px] font-medium text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-500/10 px-2 py-0.5 rounded transition-colors"
            >
                {selectedRules.size === RULES.length ? 'Bỏ chọn hết' : 'Chọn tất cả'}
            </button>
        </div>

        {isInspectOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            <div className="grid grid-cols-2 gap-2">
              {RULES.map((r, i) => {
                const sel = selectedRules.has(r.id);
                const isLeftCol = i % 2 === 0;
                return (
                  <button key={r.id} onClick={() => toggleRule(r.id)}
                    className={`text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="text-sm shrink-0">{r.icon}</span>
                    <span className="truncate flex-1">{r.label}</span>
                    
                    {/* Tooltip Icon */}
                    <div 
                      className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                      onClick={(e) => { e.stopPropagation(); /* Prevent button click */ }}
                    >
                      ?
                      {/* Tooltip Content */}
                      <div className={`absolute bottom-full mb-2 w-max max-w-[220px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words
                        ${isLeftCol ? 'left-1/2 -translate-x-[20%]' : 'right-1/2 translate-x-[20%]'}`}>
                        {r.desc}
                        <div className={`absolute top-full w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1
                          ${isLeftCol ? 'left-[20%] -translate-x-1/2' : 'right-[20%] translate-x-1/2'}`}></div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: '12px' }} className="flex gap-2">
              <button
                onClick={runInspect}
                disabled={isInspecting || selectedRules.size === 0}
                className="flex-1 px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700"
              >
                {isInspecting ? (
                  <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang quét...</>
                ) : (
                  <>🔍 Quét Preflight</>
                )}
              </button>
              
              {onOpenOutputPreview && (
                  <button 
                    onClick={onOpenOutputPreview}
                    title="Mở Output Preview (Phân tách kẽm màu)"
                    className="flex-1 px-2.5 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors flex items-center justify-center gap-2 border border-teal-700"
                  >
                    👁️ Xem trước bản in
                  </button>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <div className="mt-3 text-[11px] text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded border border-red-200 dark:border-red-800/50">{error}</div>}

      {/* ── Report (chỉ hiện khi đã quét) ── */}
      {report && (
        <div className="space-y-2" style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
          <div className="flex gap-1.5">
            <MiniCard className="flex-1" icon="📄" label="Trang" value={String(report.total_pages)} />
            <MiniCard className="flex-1" icon="⚠️" label="Lỗi" value={String(report.issues?.length || 0)} />
            {selectedRules.has('COLOR_RGB_DETECTED') && (
              <MiniCard className="flex-1" icon="🎨" label="Màu" value={report.color_summary?.dominant_space || '—'} />
            )}
          </div>

          {report.issues?.length > 0 && (
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase">Danh sách lỗi</label>
              <div className="max-h-[180px] overflow-y-auto space-y-1 pr-1">
                {report.issues.map((issue: any, i: number) => (
                  <div key={i} 
                    onClick={() => onIssueSelect && onIssueSelect(issue)}
                    className={`p-2 rounded border-l-2 flex flex-col gap-1 cursor-pointer hover:brightness-95 transition-all ${
                    issue.severity === 'error' ? 'border-red-500 bg-red-50 dark:bg-red-900/10 text-red-800 dark:text-red-200'
                    : 'border-amber-400 bg-amber-50 dark:bg-amber-900/10 text-amber-800 dark:text-amber-200'
                  }`}>
                    <div className="flex items-center justify-between font-bold text-[11px]">
                      <span>{RULES.find(r => r.id === issue.rule_id)?.label || issue.rule_id}</span>
                      {issue.page && <span className="opacity-70 text-[9px] px-1.5 py-0.5 bg-black/5 dark:bg-white/10 rounded">Trang {issue.page}</span>}
                    </div>
                    <span className="text-[10px] opacity-90 leading-snug">{issue.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.issues?.length === 0 && (
            <div className="text-center py-2 text-emerald-600 dark:text-emerald-400 text-[12px] font-bold">
              ✅ Không phát hiện lỗi nào trong các mục đã chọn!
            </div>
          )}

          {report.issues?.some((i: any) => i.rule_id === 'FONT_NOT_EMBEDDED') && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
              <div className="flex gap-2">
                <span className="text-sm">⚠️</span>
                <div className="flex-1">
                  <h4 className="text-[11px] font-bold text-red-600 dark:text-red-400 leading-tight">Cảnh báo rủi ro sai Font</h4>
                  <p className="text-[10px] text-red-700/80 dark:text-red-300/80 mt-0.5 leading-snug">
                    File thiếu font gốc. <b>Khóa Font</b> / <b>Nhúng Font</b> có thể thay bằng font mặc định.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════ */}
      {/* SECTION 2: SỬA LỖI (Luôn hiện, chạy trực tiếp) */}
      {/* ════════════════════════════════════════════════ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700 my-6"></div>
      
      <div>
        <button 
          onClick={() => setIsFixOpen(!isFixOpen)}
          className="w-full flex items-center justify-center gap-2 mb-3 group"
        >
          <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
            🛠️ SỬA LỖI (CHẠY TRỰC TIẾP)
          </span>
          <span className={`text-[10px] text-slate-400 transition-transform duration-200 ${isFixOpen ? 'rotate-180' : ''}`}>▼</span>
        </button>

        {isFixOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            <div className="grid grid-cols-2 gap-2 mt-2">
              {ACTIONS.map((a, i) => {
                const sel = selectedActions.has(a.id);
                const isLeftCol = i % 2 === 0;
                return (
                  <button key={a.id} onClick={() => toggleAction(a.id)} disabled={!!fixingAction}
                    className={`text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="text-sm shrink-0">{a.icon}</span>
                    <span className="truncate flex-1">{a.title}</span>

                    {/* Tooltip Icon */}
                    <div 
                      className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                      onClick={(e) => { e.stopPropagation(); }}
                    >
                      ?
                      {/* Tooltip Content */}
                      <div className={`absolute bottom-full mb-2 w-max max-w-[220px] p-3 bg-slate-800 dark:bg-zinc-700 text-white text-[11px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words
                        ${isLeftCol ? 'left-1/2 -translate-x-[20%]' : 'right-1/2 translate-x-[20%]'}`}>
                        {a.desc}
                        <div className={`absolute top-full w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1
                          ${isLeftCol ? 'left-[20%] -translate-x-1/2' : 'right-[20%] translate-x-1/2'}`}></div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Execute Pipeline */}
            {selectedActions.size > 0 && (
              <button
                onClick={runPipeline}
                disabled={!!fixingAction}
                style={{ marginTop: '16px' }}
                className="w-full px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700"
              >
                {fixingAction ? (
                  <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang sửa...</>
                ) : (
                  <>🚀 Thực thi ({selectedActions.size})</>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Fix Result ── */}
      {fixResult && (
        <div className={`p-3 rounded-lg border ${fixResult.success ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <h4 className={`text-[11px] font-bold mb-1 ${fixResult.success ? 'text-emerald-600' : 'text-red-600'}`}>
            {fixResult.success ? '✅ Thành công!' : '❌ Thất bại'}
          </h4>
          {fixResult.log?.map((e: any, i: number) => (
            <p key={i} className="text-[10px] text-slate-600 dark:text-zinc-300">{e.status === 'success' ? '✅' : '❌'} {e.message} ({e.duration_ms}ms)</p>
          ))}
          {fixResult.success && (
            <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">
              ✅ File đã được cập nhật trên Viewer.
            </p>
          )}
          {fixResult.error && <p className="text-[10px] text-red-500 mt-1">{fixResult.error}</p>}
        </div>
      )}
    </div>
  );
}

function MiniCard({ icon, label, value, className = '' }: { icon: string; label: string; value: string; className?: string }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1.5 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5 ${className}`}>
      <span className="text-xs">{icon}</span>
      <span className="text-[9px] font-bold text-slate-500">{label}</span>
      <span className="text-[11px] font-bold text-slate-800 dark:text-white ml-auto">{value}</span>
    </div>
  );
}
