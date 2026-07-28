import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { useTranslation } from 'react-i18next';

interface FontIssue {
  rule_id: string;
  severity: string;
  page?: number | null;
  description: string;
}

interface FontReport {
  total_pages: number;
  issues: FontIssue[];
  font_summary: {
    total?: number;
    embedded?: number;
    not_embedded?: number;
  };
}

interface FixLogEntry {
  status: string;
  message: string;
  duration_ms: number;
}

interface FixResult {
  success: boolean;
  output_filename?: string | null;
  log: FixLogEntry[];
  error?: string | null;
}

interface Props {
  pdfFile: File | null;
  onFileFixed: (blob: Blob, name: string) => void;
}

const FONT_RULES = ['FONT_NOT_EMBEDDED', 'TEXT_DETECTED'];

export default function FontToolsTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const getWorkingFile = useWorkingPdf();
  const [fileId, setFileId] = useState('');
  const [report, setReport] = useState<FontReport | null>(null);
  const [result, setResult] = useState<FixResult | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isOutlining, setIsOutlining] = useState(false);
  const [error, setError] = useState('');
  const expectedOutlinedFileNameRef = useRef<string | null>(null);

  useEffect(() => {
    const preserveSuccess = !!pdfFile
      && expectedOutlinedFileNameRef.current === pdfFile.name;
    expectedOutlinedFileNameRef.current = null;
    setFileId('');
    setReport(null);
    // UIUX (audit 2026-07-28 §F.3): commit file outline làm đổi pdfFile ngay lập
    // tức. Giữ thông báo của đúng file kết quả thay vì xóa trước khi user kịp đọc.
    if (!preserveSuccess) setResult(null);
    setError('');
  }, [pdfFile]);

  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error(t('preprocess.fontTools:khong_co_file_pdf'));
    const uploaded = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(uploaded.id);
    return uploaded.id;
  }, [fileId, getWorkingFile, pdfFile, t]);

  const inspectFonts = useCallback(async () => {
    if (!pdfFile) return;
    setIsInspecting(true);
    setResult(null);
    setError('');
    try {
      const id = await ensureUploaded();
      const response = await authenticatedFetch(`${getApiUrl()}/preflight/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: id, rules: FONT_RULES }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || t('preprocess.fontTools:loi_kiem_tra'));
      }
      setReport(await response.json() as FontReport);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('preprocess.fontTools:loi_kiem_tra'));
    } finally {
      setIsInspecting(false);
    }
  }, [pdfFile, ensureUploaded, t]);

  const outlineFonts = useCallback(async () => {
    if (!report || (report.font_summary.not_embedded ?? 0) > 0) return;
    setIsOutlining(true);
    setResult(null);
    setError('');
    try {
      const id = await ensureUploaded();
      const response = await authenticatedFetch(`${getApiUrl()}/preflight/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: id, action_id: 'OUTLINE_FONTS', params: {} }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || t('preprocess.fontTools:loi_xu_ly'));
      }
      const data = await response.json() as FixResult;
      setResult(data);
      if (data.success && data.output_filename) {
        const output = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`);
        if (!output.ok) throw new Error(t('preprocess.fontTools:loi_tai_ket_qua'));
        const outputBlob = await output.blob();
        expectedOutlinedFileNameRef.current = data.output_filename;
        onFileFixed(outputBlob, data.output_filename);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('preprocess.fontTools:loi_xu_ly'));
    } finally {
      setIsOutlining(false);
    }
  }, [report, ensureUploaded, onFileFixed, t]);

  const missingFonts = report?.font_summary.not_embedded ?? 0;
  const liveTextIssues = report?.issues.filter(issue => issue.rule_id === 'TEXT_DETECTED') ?? [];
  const canOutline = !!report && missingFonts === 0 && liveTextIssues.length > 0;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* UIUX (audit 2026-07-28 §F.2): tách thao tác phá huỷ chữ khỏi pipeline Preflight chung. */}
      <div className="rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 p-3">
        <div className="flex items-start gap-2.5">
          <span className="text-xl">🔤</span>
          <div>
            <h3 className="text-[13px] font-bold text-indigo-800 dark:text-indigo-200">
              {t('preprocess.fontTools:muc_tieu_title')}
            </h3>
            <p className="text-[11px] leading-relaxed text-indigo-700/80 dark:text-indigo-300/80 mt-1">
              {t('preprocess.fontTools:muc_tieu_desc')}
            </p>
          </div>
        </div>
      </div>

      <button
        onClick={inspectFonts}
        disabled={!pdfFile || isInspecting || isOutlining}
        className="w-full h-10 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[12px] font-bold disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {isInspecting && <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />}
        {isInspecting ? t('preprocess.fontTools:dang_quet') : t('preprocess.fontTools:quet_chu_font')}
      </button>

      {error && (
        <div className="text-[11px] text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-2.5">
          {error}
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SummaryCard label={t('preprocess.fontTools:tong_font')} value={report.font_summary.total ?? 0} tone="neutral" />
            <SummaryCard label={t('preprocess.fontTools:da_nhung')} value={report.font_summary.embedded ?? 0} tone="good" />
            <SummaryCard label={t('preprocess.fontTools:chua_nhung')} value={missingFonts} tone={missingFonts > 0 ? 'bad' : 'good'} />
            <SummaryCard label={t('preprocess.fontTools:chu_song')} value={liveTextIssues.length} tone={liveTextIssues.length > 0 ? 'warn' : 'good'} />
          </div>

          {report.issues.length > 0 ? (
            <div className="space-y-1.5">
              {report.issues.map((issue, index) => (
                <div key={`${issue.rule_id}-${issue.page ?? 0}-${index}`} className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-2.5">
                  <div className="flex gap-2 text-[11px] font-bold text-amber-800 dark:text-amber-200">
                    <span>{issue.rule_id === 'FONT_NOT_EMBEDDED' ? t('preprocess.fontTools:font_chua_nhung') : t('preprocess.fontTools:chu_chua_outline')}</span>
                    {issue.page && <span className="ml-auto font-medium opacity-70">{t('preprocess.fontTools:trang', { page: issue.page })}</span>}
                  </div>
                  <p className="text-[10px] leading-relaxed text-amber-700/90 dark:text-amber-300/90 mt-1">{issue.description}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-2.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t('preprocess.fontTools:khong_phat_hien_rui_ro')}
            </div>
          )}

          {missingFonts > 0 && (
            <div className="rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 p-3">
              <h4 className="text-[12px] font-bold text-red-700 dark:text-red-300">{t('preprocess.fontTools:can_font_goc_title')}</h4>
              <p className="text-[10px] leading-relaxed text-red-600/90 dark:text-red-300/80 mt-1">{t('preprocess.fontTools:can_font_goc_desc')}</p>
            </div>
          )}

          <div className="border-t border-slate-200 dark:border-white/10 pt-4">
            <h3 className="text-[12px] font-bold text-slate-800 dark:text-white">{t('preprocess.fontTools:khoa_chu_title')}</h3>
            <p className="text-[10px] leading-relaxed text-slate-500 dark:text-zinc-400 mt-1 mb-3">{t('preprocess.fontTools:khoa_chu_desc')}</p>
            <button
              onClick={outlineFonts}
              disabled={!canOutline || isOutlining || isInspecting}
              className="w-full h-10 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[12px] font-bold disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {isOutlining && <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />}
              {isOutlining ? t('preprocess.fontTools:dang_xu_ly') : t('preprocess.fontTools:khoa_chu')}
            </button>
            {!canOutline && missingFonts === 0 && liveTextIssues.length === 0 && (
              <p className="text-[10px] text-center text-slate-400 mt-2">{t('preprocess.fontTools:khong_can_outline')}</p>
            )}
          </div>
        </>
      )}

      {result && (
        <div className={`rounded-lg border p-3 ${result.success ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10' : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10'}`}>
          <h4 className={`text-[12px] font-bold ${result.success ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
            {result.success ? t('preprocess.fontTools:thanh_cong') : t('preprocess.fontTools:that_bai')}
          </h4>
          {result.log.map((entry, index) => (
            <p key={index} className="text-[10px] text-slate-600 dark:text-zinc-300 mt-1">{entry.message}</p>
          ))}
          {result.error && <p className="text-[10px] text-red-600 dark:text-red-300 mt-1">{result.error}</p>}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const colors = {
    neutral: 'border-slate-200 text-slate-700 dark:border-white/10 dark:text-zinc-200',
    good: 'border-emerald-200 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300',
    warn: 'border-amber-200 text-amber-700 dark:border-amber-500/30 dark:text-amber-300',
    bad: 'border-red-200 text-red-700 dark:border-red-500/30 dark:text-red-300',
  };
  return (
    <div className={`rounded-lg border bg-white dark:bg-zinc-900 p-2.5 ${colors[tone]}`}>
      <div className="text-[10px] font-medium opacity-70">{label}</div>
      <div className="text-lg font-black mt-0.5">{value}</div>
    </div>
  );
}