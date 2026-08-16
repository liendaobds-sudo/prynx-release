import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import {
  useWorkspaceStore,
  workspaceDocumentIdentity,
} from '../../stores/useWorkspaceStore';
import { useTranslation } from 'react-i18next';

export interface FontIssue {
  rule_id: string;
  severity: string;
  page?: number | null;
  object_ref?: string;
  description: string;
}

export interface FontSummaryItem {
  name: string;
  embedded: boolean;
  pages: number[];
  not_embedded_pages?: number[];
  occurrences: number;
}

export interface FontReport {
  total_pages: number;
  issues: FontIssue[];
  font_summary: {
    // Ba field cũ là occurrence theo trang; các field unique có từ API mới.
    total?: number;
    embedded?: number;
    not_embedded?: number;
    unique_total?: number;
    unique_embedded?: number;
    unique_not_embedded?: number;
    fonts?: FontSummaryItem[];
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
  onFileFixed: (blob: Blob, name: string) => void | boolean | Promise<void | boolean>;
}

interface FontRequest {
  identity: string;
  generation: number;
  controller: AbortController;
}

interface GroupedMissingFont {
  name: string;
  pages: number[];
}

const FONT_RULES = ['FONT_NOT_EMBEDDED', 'TEXT_DETECTED'];
const MAX_VISIBLE_PAGES = 8;

function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError';
}

function normalizeFontName(objectRef?: string): string {
  if (!objectRef) return '';
  const parenthesized = objectRef.match(/\(([^)]+)\)/)?.[1];
  const raw = (parenthesized || objectRef.replace(/^Font\s+\/\S+\s*/i, '')).replace(/^\//, '');
  return raw.replace(/^[A-Z]{6}\+/, '');
}

function uniqueSortedPages(pages: Array<number | null | undefined>): number[] {
  return [...new Set(pages.filter((page): page is number => typeof page === 'number' && page > 0))]
    .sort((a, b) => a - b);
}

function groupMissingFonts(report: FontReport): GroupedMissingFont[] {
  const groupedFromSummary = (report.font_summary.fonts ?? [])
    .filter(font => !font.embedded)
    .map(font => ({
      name: font.name,
      pages: uniqueSortedPages(font.not_embedded_pages?.length ? font.not_embedded_pages : font.pages),
    }));
  if (groupedFromSummary.length > 0) return groupedFromSummary;

  const legacyGroups = new Map<string, number[]>();
  report.issues
    .filter(issue => issue.rule_id === 'FONT_NOT_EMBEDDED')
    .forEach(issue => {
      const name = normalizeFontName(issue.object_ref) || issue.description;
      legacyGroups.set(name, [...(legacyGroups.get(name) ?? []), ...(issue.page ? [issue.page] : [])]);
    });
  return [...legacyGroups.entries()]
    .map(([name, pages]) => ({ name, pages: uniqueSortedPages(pages) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatElapsed(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
}

function PageList({ pages }: { pages: number[] }) {
  const { t } = useTranslation();
  if (pages.length === 0) return null;
  const visible = pages.slice(0, MAX_VISIBLE_PAGES).join(', ');
  const remaining = pages.length - MAX_VISIBLE_PAGES;
  return (
    <span>
      {t('preprocess.fontTools:cac_trang', { pages: visible })}
      {remaining > 0 ? ` ${t('preprocess.fontTools:va_them_trang', { count: remaining })}` : ''}
    </span>
  );
}

export default function FontToolsTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
  const getWorkingFile = useWorkingPdf();
  const selectionFileId = useWorkspaceStore(state => state.selectionFileId);
  const selectionDocumentIdentity = useWorkspaceStore(state => state.selectionDocumentIdentity);
  const fontInspectionCache = useWorkspaceStore(state => state.fontInspectionCache);
  const viewerPageOrder = useWorkspaceStore(state => state.viewerPageOrder);
  const viewerPageRotations = useWorkspaceStore(state => state.viewerPageRotations);
  const setSelectionFileId = useWorkspaceStore(state => state.setSelectionFileId);
  const setFontInspectionCache = useWorkspaceStore(state => state.setFontInspectionCache);
  const documentIdentity = workspaceDocumentIdentity(
    pdfFile,
    viewerPageOrder,
    viewerPageRotations,
  );
  const reusableFileId = selectionFileId && (
    !selectionDocumentIdentity
    || selectionDocumentIdentity === documentIdentity
  ) ? selectionFileId : '';
  const [report, setReport] = useState<FontReport | null>(() => (
    fontInspectionCache?.identity === documentIdentity
      ? fontInspectionCache.report as FontReport
      : null
  ));
  const [result, setResult] = useState<FixResult | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isOutlining, setIsOutlining] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState('');
  const expectedOutlinedFileNameRef = useRef<string | null>(null);
  const preserveResultOnNextScanRef = useRef(false);
  const generationRef = useRef(0);
  const requestRef = useRef<FontRequest | null>(null);
  const documentIdentityRef = useRef(documentIdentity);
  const autoScanIdentityRef = useRef('');
  const fontInspectionCacheRef = useRef(fontInspectionCache);
  documentIdentityRef.current = documentIdentity;
  fontInspectionCacheRef.current = fontInspectionCache;

  const abortActiveRequest = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const cancelActiveRequest = useCallback(() => {
    abortActiveRequest();
    setIsInspecting(false);
    setIsOutlining(false);
  }, [abortActiveRequest]);

  const beginRequest = useCallback((identity: string): FontRequest => {
    abortActiveRequest();
    const request: FontRequest = {
      identity,
      generation: generationRef.current,
      controller: new AbortController(),
    };
    requestRef.current = request;
    return request;
  }, [abortActiveRequest]);

  const isRequestCurrent = useCallback((request: FontRequest): boolean => (
    requestRef.current === request
    && request.generation === generationRef.current
    && request.identity === documentIdentityRef.current
    && !request.controller.signal.aborted
  ), []);

  useEffect(() => {
    const preserveSuccess = !!pdfFile
      && expectedOutlinedFileNameRef.current === pdfFile.name;
    expectedOutlinedFileNameRef.current = null;
    // PERF (audit 2026-08-13 §FONT.PERF.3/.4): identity mới hủy request cũ
    // và dùng lại file ID đã bind đúng tài liệu trong workspace.
    const cachedReport = fontInspectionCacheRef.current?.identity === documentIdentity
      ? fontInspectionCacheRef.current.report as FontReport
      : null;
    setIsInspecting(false);
    setIsOutlining(false);
    setReport(cachedReport);
    setElapsedSeconds(0);
    // UIUX (audit 2026-07-28 §F.3): giữ thông báo thành công khi parent vừa
    // commit đúng file output; identity đổi không được xóa trước khi user đọc.
    setResult(currentResult => preserveSuccess ? currentResult : null);
    setError('');
    return abortActiveRequest;
  }, [abortActiveRequest, documentIdentity, pdfFile]);

  useEffect(() => {
    if (!isInspecting && !isOutlining) return undefined;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isInspecting, isOutlining]);

  const ensureUploaded = useCallback(async (request: FontRequest): Promise<string> => {
    if (reusableFileId) {
      if (!isRequestCurrent(request)) {
        throw request.controller.signal.reason || new DOMException('Đã hủy', 'AbortError');
      }
      return reusableFileId;
    }
    if (!pdfFile) throw new Error(t('preprocess.fontTools:khong_co_file_pdf'));
    const uploaded = await uploadPDF((await getWorkingFile(pdfFile)) || pdfFile, {
      signal: request.controller.signal,
    });
    if (!isRequestCurrent(request)) throw request.controller.signal.reason || new DOMException('Đã hủy', 'AbortError');
    setSelectionFileId(uploaded.id, request.identity);
    return uploaded.id;
  }, [getWorkingFile, isRequestCurrent, pdfFile, reusableFileId, setSelectionFileId, t]);

  const inspectFonts = useCallback(async () => {
    if (!pdfFile) return;
    const request = beginRequest(documentIdentity);
    const preservePreviousSuccess = preserveResultOnNextScanRef.current;
    preserveResultOnNextScanRef.current = false;
    setIsInspecting(true);
    if (!preservePreviousSuccess) setResult(null);
    setError('');
    try {
      const id = await ensureUploaded(request);
      const response = await authenticatedFetch(`${getApiUrl()}/preflight/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: id, rules: FONT_RULES }),
        signal: request.controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || t('preprocess.fontTools:loi_kiem_tra'));
      }
      const nextReport = await response.json() as FontReport;
      if (isRequestCurrent(request)) {
        setReport(nextReport);
        setFontInspectionCache({ identity: request.identity, report: nextReport });
      }
    } catch (reason) {
      if (isRequestCurrent(request) && !isAbortError(reason)) {
        setError(reason instanceof Error ? reason.message : t('preprocess.fontTools:loi_kiem_tra'));
      }
    } finally {
      if (isRequestCurrent(request)) {
        requestRef.current = null;
        setIsInspecting(false);
      }
    }
  }, [beginRequest, documentIdentity, ensureUploaded, isRequestCurrent, pdfFile, setFontInspectionCache, t]);

  // UIUX (audit 2026-08-13 §FONT.UI.2): mỗi identity tự quét đúng một lần;
  // Quét lại chỉ là thao tác phụ khi người dùng chủ động yêu cầu.
  useEffect(() => {
    if (!pdfFile || report || autoScanIdentityRef.current === documentIdentity) return;
    autoScanIdentityRef.current = documentIdentity;
    void inspectFonts();
  }, [documentIdentity, inspectFonts, pdfFile, report]);

  const outlineFonts = useCallback(async () => {
    const missingFontCount = report?.font_summary.unique_not_embedded
      ?? report?.font_summary.not_embedded
      ?? 0;
    if (!report || missingFontCount > 0) return;
    const request = beginRequest(documentIdentity);
    setIsOutlining(true);
    setResult(null);
    setError('');
    try {
      const id = await ensureUploaded(request);
      const response = await authenticatedFetch(`${getApiUrl()}/preflight/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: id, action_id: 'OUTLINE_FONTS', params: {} }),
        signal: request.controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || t('preprocess.fontTools:loi_xu_ly'));
      }
      const data = await response.json() as FixResult;
      if (!isRequestCurrent(request)) return;
      if (data.success && data.output_filename) {
        const output = await authenticatedFetch(`${getApiUrl()}/preflight/download/${data.output_filename}`, {
          signal: request.controller.signal,
        });
        if (!output.ok) throw new Error(t('preprocess.fontTools:loi_tai_ket_qua'));
        const outputBlob = await output.blob();
        if (!isRequestCurrent(request)) return;
        expectedOutlinedFileNameRef.current = data.output_filename;
        preserveResultOnNextScanRef.current = true;
        // RECIPE (audit 2026-08-17 §REC.4R): commit bị chặn → không hiện kết quả
        // vì file đang mở chưa đổi.
        const committed = await onFileFixed(outputBlob, data.output_filename);
        if (committed === false) {
          expectedOutlinedFileNameRef.current = null;
          preserveResultOnNextScanRef.current = false;
          return;
        }
      }
      setResult(data);
    } catch (reason) {
      if (isRequestCurrent(request) && !isAbortError(reason)) {
        setError(reason instanceof Error ? reason.message : t('preprocess.fontTools:loi_xu_ly'));
      }
    } finally {
      if (isRequestCurrent(request)) {
        requestRef.current = null;
        setIsOutlining(false);
      }
    }
  }, [beginRequest, documentIdentity, ensureUploaded, isRequestCurrent, onFileFixed, report, t]);

  const missingFonts = report?.font_summary.unique_not_embedded
    ?? report?.font_summary.not_embedded
    ?? 0;
  const totalFonts = report?.font_summary.unique_total
    ?? report?.font_summary.total
    ?? 0;
  const embeddedFonts = report?.font_summary.unique_embedded
    ?? Math.max(0, totalFonts - missingFonts);
  const liveTextIssues = report?.issues.filter(issue => issue.rule_id === 'TEXT_DETECTED') ?? [];
  const liveTextPages = uniqueSortedPages(liveTextIssues.map(issue => issue.page));
  const hasLiveText = liveTextIssues.length > 0;
  const missingFontGroups = useMemo(() => report ? groupMissingFonts(report) : [], [report]);
  const canOutline = !!report && missingFonts === 0 && hasLiveText;
  const isBusy = isInspecting || isOutlining;

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {isBusy && (
        <div className="rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/70 dark:bg-indigo-500/10 p-3" role="status">
          <div className="flex items-center gap-2.5">
            <span className="w-4 h-4 shrink-0 rounded-full border-2 border-indigo-300 border-t-indigo-700 dark:border-indigo-400/30 dark:border-t-indigo-200 animate-spin" />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-bold text-indigo-800 dark:text-indigo-200">
                {isInspecting
                  ? t('preprocess.fontTools:stage_dang_quet', { pages: report?.total_pages ?? '…' })
                  : t('preprocess.fontTools:stage_dang_outline')}
              </div>
              <div className="text-[10px] text-indigo-700/75 dark:text-indigo-300/75 mt-0.5">
                {t('preprocess.fontTools:da_chay', { time: formatElapsed(elapsedSeconds) })}
                {isOutlining ? ` · ${t('preprocess.fontTools:stage_hau_kiem')}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={cancelActiveRequest}
              className="h-8 px-3 rounded-lg border border-indigo-300 dark:border-indigo-400/30 text-[11px] font-bold text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/20"
            >
              {t('preprocess.fontTools:huy')}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="text-[11px] text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-2.5">
          <div>{error}</div>
          <button type="button" onClick={inspectFonts} className="mt-2 font-bold underline underline-offset-2">
            {t('preprocess.fontTools:thu_lai')}
          </button>
        </div>
      )}

      {!report && !isBusy && !error && (
        <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900 p-3 text-[11px] text-slate-500 dark:text-zinc-400">
          {pdfFile ? t('preprocess.fontTools:chuan_bi_quet') : t('preprocess.fontTools:khong_co_file_pdf')}
          {pdfFile && (
            <button
              type="button"
              onClick={inspectFonts}
              className="block mt-2 font-bold text-indigo-600 dark:text-indigo-300 underline underline-offset-2"
            >
              {t('preprocess.fontTools:quet_lai')}
            </button>
          )}
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <SummaryCard label={t('preprocess.fontTools:font_duy_nhat')} value={totalFonts} tone="neutral" />
            <SummaryCard label={t('preprocess.fontTools:da_nhung')} value={embeddedFonts} tone="good" />
            <SummaryCard label={t('preprocess.fontTools:chua_nhung')} value={missingFonts} tone={missingFonts > 0 ? 'bad' : 'good'} />
          </div>

          {missingFonts > 0 ? (
            <DecisionCard tone="bad" title={t('preprocess.fontTools:trang_thai_thieu_font_title')}>
              <p>{t('preprocess.fontTools:trang_thai_thieu_font_desc')}</p>
              {missingFontGroups.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {missingFontGroups.map(font => (
                    <div key={font.name} className="rounded-md bg-white/60 dark:bg-black/10 px-2 py-1.5">
                      <div className="font-bold break-all">{font.name}</div>
                      <div className="mt-0.5 opacity-80"><PageList pages={font.pages} /></div>
                    </div>
                  ))}
                </div>
              )}
            </DecisionCard>
          ) : hasLiveText ? (
            <DecisionCard tone="warn" title={t('preprocess.fontTools:trang_thai_co_chu_title')}>
              <p>{t('preprocess.fontTools:trang_thai_co_chu_desc', { count: liveTextPages.length })}</p>
              <p className="mt-1 font-medium"><PageList pages={liveTextPages} /></p>
              <button
                type="button"
                onClick={outlineFonts}
                disabled={!canOutline || isBusy}
                className="w-full h-10 mt-3 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[12px] font-bold disabled:opacity-40"
              >
                {t('preprocess.fontTools:khoa_chu')}
              </button>
            </DecisionCard>
          ) : (
            <DecisionCard tone="good" title={t('preprocess.fontTools:trang_thai_an_toan_title')}>
              <p>{t('preprocess.fontTools:trang_thai_an_toan_desc')}</p>
            </DecisionCard>
          )}

          <div className="flex items-center justify-between border-t border-slate-200 dark:border-white/10 pt-3">
            <span className="text-[10px] text-slate-400">
              {t('preprocess.fontTools:da_quet_trang', { count: report.total_pages })}
            </span>
            <button
              type="button"
              onClick={inspectFonts}
              disabled={isBusy}
              className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-300 disabled:opacity-40 hover:underline"
            >
              {t('preprocess.fontTools:quet_lai')}
            </button>
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

function DecisionCard({
  tone,
  title,
  children,
}: {
  tone: 'good' | 'warn' | 'bad';
  title: string;
  children: React.ReactNode;
}) {
  const colors = {
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    warn: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    bad: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
  };
  return (
    <div className={`rounded-xl border p-3 ${colors[tone]}`}>
      <h3 className="text-[12px] font-bold">{title}</h3>
      <div className="text-[10px] leading-relaxed mt-1">{children}</div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'good' | 'bad' }) {
  const colors = {
    neutral: 'border-slate-200 text-slate-700 dark:border-white/10 dark:text-zinc-200',
    good: 'border-emerald-200 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300',
    bad: 'border-red-200 text-red-700 dark:border-red-500/30 dark:text-red-300',
  };
  return (
    <div className={`rounded-lg border bg-white dark:bg-zinc-900 p-2.5 ${colors[tone]}`}>
      <div className="text-[10px] font-medium opacity-70">{label}</div>
      <div className="text-lg font-black mt-0.5">{value}</div>
    </div>
  );
}
