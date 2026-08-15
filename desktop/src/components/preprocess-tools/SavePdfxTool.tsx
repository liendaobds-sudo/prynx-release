import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface Props {
  tabId?: string;
  pdfFile: File | null;
  onFileFixed?: (
    blob: Blob,
    name: string,
    path?: string,
    recipeTicket?: RecipeOperationTicket | null,
  ) => void | Promise<void>;
}

interface CheckItem {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

const STANDARDS = [
  { key: 'x1a' as const, label: 'PDF/X-1a', desc: 'Tương thích cao, CMYK only, flatten transparency. Phù hợp hầu hết nhà in.' },
  { key: 'x4' as const, label: 'PDF/X-4', desc: 'Hiện đại, giữ transparency & ICC profile. Yêu cầu RIP mới.' },
];

const COMPARE = [
  { feat: 'Transparency', x1a: '❌ Flatten', x4: '✅ Giữ nguyên' },
  { feat: 'Hệ màu', x1a: 'CMYK only', x4: 'CMYK+RGB+ICC' },
  { feat: 'Tương thích', x1a: '⭐⭐⭐⭐⭐', x4: '⭐⭐⭐⭐' },
  { feat: 'PDF Version', x1a: '1.3', x4: '1.6' },
];

// Giải thích chi tiết từng mục kiểm tra — click icon "?" để mở modal. Khớp theo
// check.id trả từ backend (pdfx_export.check_compliance).
// autoFix: PrynX Print Engine có thể sửa mục này mà không phải đoán dữ liệu nguồn.
interface CheckHelp { what: string; why: string; fix: string; autoFix: boolean; }
const CHECK_HELP: Record<string, CheckHelp> = {
  FONTS_EMBEDDED: {
    what: 'Kiểm tra mọi phông chữ trong file đã được nhúng (embed) vào PDF hay chưa.',
    why: 'Nếu phông không nhúng, máy RIP của nhà in không có phông đó sẽ thay bằng phông khác — chữ bị nhảy phông, sai khoảng cách, thậm chí mất chữ. Chuẩn PDF/X bắt buộc nhúng toàn bộ phông.',
    fix: 'Nhúng phông ngay từ phần mềm nguồn hoặc dùng Khóa Font. PrynX sẽ dừng an toàn nếu không có đúng dữ liệu phông để bảo toàn chữ.',
    autoFix: false,
  },
  TRIMBOX_EXISTS: {
    what: 'Kiểm tra mỗi trang đã khai báo TrimBox (khung thành phẩm — đường cắt cuối) hay chưa.',
    why: 'TrimBox cho nhà in biết chính xác mép cắt thành phẩm nằm ở đâu, phân biệt với phần bleed (chờm) bị xén bỏ. Thiếu TrimBox, máy bình/cắt không biết cắt ở đâu.',
    fix: 'Đặt TrimBox trước bằng công cụ "Set Page Boxes" trong Preflight. Xuất PDF/X không tự tạo TrimBox nếu file gốc chưa có.',
    autoFix: false,
  },
  CMYK_ONLY: {
    what: 'Kiểm tra file chỉ dùng hệ màu CMYK, không còn màu RGB.',
    why: 'Máy in offset in bằng 4 mực CMYK. Màu RGB (từ ảnh chụp, màn hình) khi in ra sẽ lệch màu khó lường vì phải quy đổi tại máy RIP. PDF/X-1a bắt buộc CMYK để màu in đúng như duyệt.',
    fix: 'Khi xuất PDF/X-1a, hệ thống tự chuyển toàn bộ RGB sang CMYK theo hồ sơ màu (ICC) đã cấu hình.',
    autoFix: true,
  },
  NO_TRANSPARENCY: {
    what: 'Kiểm tra file không còn hiệu ứng trong suốt (transparency) chưa được làm phẳng.',
    why: 'Transparency (đổ bóng, mờ chồng lớp) có thể hiển thị khác nhau trên từng máy RIP cũ, gây sai lệch so với bản duyệt. PDF/X-1a yêu cầu làm phẳng (flatten) để kết quả in ổn định.',
    fix: 'Khi xuất PDF/X-1a, hệ thống tự làm phẳng mọi vùng transparency thành ảnh/vector đặc.',
    autoFix: true,
  },
  OUTPUT_INTENT: {
    what: 'Kiểm tra file đã gắn Output Intent — hồ sơ màu ICC mô tả điều kiện in đích.',
    why: 'Output Intent cho nhà in biết file được chuẩn màu theo tiêu chuẩn nào (vd Coated FOGRA39). Đây là "chứng minh thư màu" của file, bắt buộc trong mọi chuẩn PDF/X để tái tạo màu chính xác.',
    fix: 'Khi xuất PDF/X, hệ thống tự gắn Output Intent (ưu tiên FOGRA39, hoặc CMYK mặc định) vào file.',
    autoFix: true,
  },
  PDF_VERSION: {
    what: 'Kiểm tra phiên bản PDF phù hợp với chuẩn đã chọn (X-1a cần 1.3, X-4 cần 1.6).',
    why: 'Mỗi chuẩn PDF/X gắn với một phiên bản PDF nhất định để đảm bảo chỉ dùng những tính năng máy RIP hỗ trợ. Sai phiên bản có thể chứa tính năng chuẩn không cho phép.',
    fix: 'Khi xuất PDF/X, PrynX Print Engine đặt đúng phiên bản PDF theo chuẩn đã chọn.',
    autoFix: true,
  },
};

export default function SavePdfxTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState('');
  const [standard, setStandard] = useState<'x1a' | 'x4'>('x4');
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [compliance, setCompliance] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState('');
  const [isStandardOpen, setIsStandardOpen] = useState(true);
  const [helpFor, setHelpFor] = useState<CheckItem | null>(null);
  const expectedOutputNameRef = useRef<string | null>(null);

  useEffect(() => {
    // UIUX (audit 2026-07-28 §PF.1): giữ thông báo khi viewer nhận đúng file vừa xuất.
    const preserveSuccess = expectedOutputNameRef.current === pdfFile?.name;
    expectedOutputNameRef.current = null;
    setFileId('');
    setChecks([]);
    setCompliance(null);
    if (!preserveSuccess) setStatus('');
  }, [pdfFile]);

  // Esc đóng modal giải thích (chỉ gắn listener khi modal đang mở).
  useEffect(() => {
    if (!helpFor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelpFor(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpFor]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.savePdfx:chua_co_file_pdf'));
    const r = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(r.id);
    return r.id;
  }, [fileId, pdfFile, getWorkingFile, t]);

  const checkCompliance = async () => {
    setChecking(true); setStatus(''); setCompliance(null);
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/check-pdfx/${fid}/${standard}`);
      const data = await res.json();
      setCompliance(data);
      setChecks(data.checks || []);
    } catch (e: any) { setStatus(`❌ ${e.message}`); }
    setChecking(false);
  };

  const exportPdfx = async () => {
    setExporting(true); setStatus('');
    const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
    const recipeTicket = shouldRecord
      ? recipeRecorder.noteOperation('pdfx', { standard }, undefined, tabId)
      : null;
    if (shouldRecord && !recipeTicket) {
      setStatus(`❌ ${t('tabs.imposition:dang_xu_ly_file')}`);
      setExporting(false);
      return;
    }
    try {
      const fid = await ensureUploaded();
      const res = await authenticatedFetch(`${getApiUrl()}/preflight/export-pdfx`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fid, standard }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus(`✅ ${t('preprocess.savePdfx:da_xuat_x_thanh_cong', { x: standard === 'x1a' ? 'PDF/X-1a' : 'PDF/X-4' })}`);
        if (data.output_filename && onFileFixed) {
          const dl = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
          expectedOutputNameRef.current = data.output_filename;
          await onFileFixed(await dl.blob(), data.output_filename, undefined, recipeTicket);
        } else {
          recipeRecorder.discardPending(recipeTicket);
        }
      } else { recipeRecorder.discardPending(recipeTicket); setStatus(`❌ ${data.detail || t('preprocess.savePdfx:loi_xuat_pdf_x')}`); }
    } catch (e: any) { recipeRecorder.discardPending(recipeTicket); setStatus(`❌ ${e.message}`); }
    finally { setExporting(false); }
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">{t('preprocess.savePdfx:vui_long_mo_file_pdf_truoc')}</div>;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">

      {/* ═══ SECTION 1: CHỌN CHUẨN ═══ */}
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setIsStandardOpen(!isStandardOpen)} className="flex items-center gap-2 group">
            <span className="text-[11px] font-bold text-slate-600 tracking-wide group-hover:text-slate-800 dark:group-hover:text-zinc-300 transition-colors">
              {t('preprocess.savePdfx:chon_chuan_pdf_x')}
            </span>
            <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform duration-200 ${isStandardOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {isStandardOpen && (
          <div className="animate-in slide-in-from-top-2 fade-in duration-200">
            {/* Standard selector - grid 2 col like Preflight rules */}
            <div className="grid grid-cols-2 gap-2">
              {STANDARDS.map((s, i) => {
                const sel = standard === s.key;
                const isLeftCol = i % 2 === 0;
                return (
                  <button key={s.key} onClick={() => { setStandard(s.key); setCompliance(null); setChecks([]); }}
                    className={`text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-center gap-2
                      ${sel ? 'border-teal-500 bg-teal-500/10 font-semibold text-teal-700 dark:text-teal-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                    <span className="truncate flex-1 font-bold">{s.label}</span>
                    {/* Tooltip */}
                    <div className="relative group/tooltip flex items-center justify-center w-4 h-4 rounded-full bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-[10px] text-slate-500 shrink-0 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                      onClick={(e) => e.stopPropagation()}>
                      ?
                      <div className={`absolute bottom-full mb-2 w-max max-w-[280px] px-3 py-2.5 bg-slate-800 dark:bg-zinc-700 text-white text-[12px] font-normal leading-relaxed rounded-lg shadow-xl opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all z-[100] pointer-events-none text-left whitespace-normal break-words
                        ${isLeftCol ? 'left-1/2 -translate-x-[20%]' : 'right-1/2 translate-x-[20%]'}`}>
                        {tv(s.desc)}
                        <div className={`absolute top-full w-2 h-2 bg-slate-800 dark:bg-zinc-700 transform rotate-45 -mt-1
                          ${isLeftCol ? 'left-[20%] -translate-x-1/2' : 'right-[20%] translate-x-1/2'}`} />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Comparison Table */}
            <div className="mt-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2">{t('preprocess.savePdfx:so_sanh_chuan')}</span>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-100 dark:border-white/5">
                    <th className="text-left font-medium pb-1.5 pr-2">{t('preprocess.savePdfx:tinh_nang')}</th>
                    <th className="text-center font-medium pb-1.5 px-2">X-1a</th>
                    <th className="text-center font-medium pb-1.5 pl-2">X-4</th>
                  </tr>
                </thead>
                <tbody className="text-slate-600 dark:text-zinc-300">
                  {COMPARE.map(row => (
                    <tr key={row.feat} className="border-b border-slate-50 dark:border-white/5 last:border-0">
                      <td className="py-1 pr-2 font-medium">{tv(row.feat)}</td>
                      <td className="py-1 px-2 text-center">{tv(row.x1a)}</td>
                      <td className="py-1 pl-2 text-center">{tv(row.x4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Check Compliance Button */}
            <div style={{ marginTop: '12px' }} className="flex gap-2">
              <button onClick={checkCompliance} disabled={checking}
                className="flex-1 px-2.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-indigo-700">
                {checking ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.savePdfx:dang_kiem_tra')}</>) : (<>{t('preprocess.savePdfx:kiem_tra_compliance')}</>)}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══ COMPLIANCE REPORT ═══ */}
      {checks.length > 0 && (
        <div className="space-y-2" style={{ paddingTop: '12px', borderTop: '1px solid #e2e8f0' }}>
          <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.savePdfx:ket_qua_kiem_tra')}</label>
          <div className="space-y-1">
            {checks.map((c) => (
              <div key={c.id} className={`p-2 rounded border-l-2 flex flex-col gap-1 ${
                c.passed ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-800 dark:text-emerald-200'
                : 'border-red-500 bg-red-50 dark:bg-red-900/10 text-red-800 dark:text-red-200'
              }`}>
                <div className="flex items-center justify-between font-bold text-[11px] gap-2">
                  <span>{c.passed ? '✅' : '❌'} {c.label}</span>
                  {CHECK_HELP[c.id] && (
                    <button
                      onClick={() => setHelpFor(c)}
                      title={t('preprocess.savePdfx:giai_thich_loi_nay')}
                      className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-[10px] font-bold opacity-70 hover:opacity-100 transition-opacity">
                      ?
                    </button>
                  )}
                </div>
                <span className="text-[10px] opacity-90 leading-snug">{c.detail}</span>
              </div>
            ))}
          </div>

          {compliance && (() => {
            // Mục engine nội bộ không thể sửa chắc chắn phải được xử lý ở file
            // nguồn trước; không hứa tự sửa nếu có nguy cơ đổi bản in.
            const manualFixes = checks.filter(c => !c.passed && CHECK_HELP[c.id]?.autoFix === false);
            const allAutoFixable = manualFixes.length === 0;
            return (
              <div className={`text-center py-2 text-[12px] font-bold ${compliance.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {compliance.passed
                  ? `✅ ${t('preprocess.savePdfx:file_dat_chuan_x', { x: compliance.standard_label })}`
                  : allAutoFixable
                    ? `⚠️ ${t('preprocess.savePdfx:x_dat_xuat_pdfx_se_tu_dong_sua', { p: compliance.passed_checks, tot: compliance.total_checks })}`
                    : `⚠️ ${t('preprocess.savePdfx:x_dat_can_xu_ly_thu_cong_truoc', { p: compliance.passed_checks, tot: compliance.total_checks, list: manualFixes.map(c => c.label).join(', ') })}`
                }
              </div>
            );
          })()}
        </div>
      )}

      {/* ═══ SECTION 2: XUẤT FILE ═══ */}
      <div className="h-px w-full bg-slate-200 dark:bg-zinc-700" />
      <button onClick={exportPdfx} disabled={exporting}
        className="w-full px-2.5 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[12px] font-bold shadow-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-teal-700">
        {exporting ? (<><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {t('preprocess.common:run')}…</>) : (<>{t('preprocess.common:run')}</>)}
      </button>

      {/* ═══ STATUS ═══ */}
      {status && (
        <div className={`p-3 rounded-lg border ${status.startsWith('✅') ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
          <h4 className={`text-[11px] font-bold ${status.startsWith('✅') ? 'text-emerald-600' : 'text-red-600'}`}>{status}</h4>
          {status.startsWith('✅') && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 font-medium">{t('preprocess.savePdfx:file_da_duoc_cap_nhat_tren_viewer')}</p>}
        </div>
      )}

      {/* ═══ MODAL GIẢI THÍCH MỤC KIỂM TRA ═══ */}
      {helpFor && CHECK_HELP[helpFor.id] && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setHelpFor(null)}>
          <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl max-w-md w-full max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-100 dark:border-white/10">
              <h3 className="text-[14px] font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <span>{helpFor.passed ? '✅' : '❌'}</span> {helpFor.label}
              </h3>
              <button onClick={() => setHelpFor(null)}
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-700 hover:text-slate-600 transition-colors">✕</button>
            </div>
            <div className="p-4 space-y-3 text-[12px] leading-relaxed text-slate-600 dark:text-zinc-300">
              <div>
                <h4 className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.savePdfx:kiem_tra_gi')}</h4>
                <p>{tv(CHECK_HELP[helpFor.id].what)}</p>
              </div>
              <div>
                <h4 className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.savePdfx:vi_sao_quan_trong')}</h4>
                <p>{tv(CHECK_HELP[helpFor.id].why)}</p>
              </div>
              <div className="rounded-lg bg-teal-50 dark:bg-teal-500/10 border border-teal-100 dark:border-teal-500/20 p-3">
                <h4 className="font-bold text-teal-700 dark:text-teal-300 mb-1">{t('preprocess.savePdfx:cach_khac_phuc')}</h4>
                <p className="text-teal-800 dark:text-teal-200">{tv(CHECK_HELP[helpFor.id].fix)}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
