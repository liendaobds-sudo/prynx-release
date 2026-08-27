/**
 * Tool "Bình lồng ghép tự do" — vỏ P9, nối đầy đủ ở P13, dựng lại theo bộ khung Bình tem bế.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §6.4, §12, §16.4.
 *
 * **Hình thức.** Bản đầu tự dựng header ngang toàn trang + lưới hai cột bằng CSS riêng, nên
 * nhìn lệch hẳn khỏi phần còn lại của phần mềm. Nay đi theo đúng dáng workspace của Bình tem
 * bế (`ImpositionTab.tsx:3948` trở xuống): vùng xem trước chiếm bên trái, panel thiết lập
 * bên phải với header cao 12, thân cuộn được, nút chạy dán đáy bằng `mt-auto`; tiến độ là
 * overlay phủ vùng xem trước; lỗi là khối đỏ cuối panel. Tool vẫn **standalone** — nó KHÔNG
 * thành biến thể `ImpositionTab` (test `toolRegistry.routing.test.ts` chốt điều đó).
 *
 * Sáu ràng buộc hành vi:
 *
 * 1. **Phân vùng theo `tabId`.** Mọi state nằm trong `useMixedNestingStore` theo tab; đóng
 *    tab thì `destroyTab`. Hai thẻ Mixed Nesting không dùng chung gì.
 * 2. **Không đăng ký receiver toàn cục.** Không có `window.addEventListener` nào, nên Home,
 *    routing PDF mặc định, Combine, Convert, N-Up, Diecut giữ nguyên hành vi.
 * 3. **Chỉ tab đang xem mới gọi API.** Dò năng lực và polling đều dừng khi tab ẩn.
 * 4. **Job cũ không ghi đè tab.** Vòng polling so `jobId` qua store; sửa đầu vào làm kết
 *    quả cũ mất hiệu lực ngay.
 * 5. **Đóng tab thì Cancel đúng một lần** rồi dọn; không để job chạy mồ côi.
 * 6. **Preview chỉ bật sau khi kết quả qua validator** — `hasUsableResult` là điều kiện duy
 *    nhất, và nó đòi cả `validation.valid` (trong `applyManifest`) lẫn đúng revision.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Divider } from './PanelPrimitives';
import {
  MixedNestingApiError,
  cancelJob,
  createJob,
  deleteJob,
  exportJob,
  fetchJobArtifact,
  getCapabilities,
  getJobResult,
  getJobStatus,
  POLL_INTERVAL_MS,
} from '../../lib/mixed-nesting/api';
import { saveBlob } from '../../lib/saveBlob';
import type { PartSource } from '../../lib/mixed-nesting/previewGeometry';
import type { ContourCandidate, EngineCapabilities, SourceRecord } from '../../lib/mixed-nesting/types';
import {
  buildRequestFromTab,
  canRun,
  hasUsableResult,
  isRunning,
  isTabDirty,
  useMixedNestingStore,
} from '../../stores/useMixedNestingStore';
import InputPanel from './InputPanel';
import MixedNestingFileInput from './MixedNestingFileInput';
import NestingPreview from './NestingPreview';
import PartsTable from './PartsTable';
import ResultSummary from './ResultSummary';

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; capabilities: EngineCapabilities }
  | { kind: 'blocked'; reason: BlockedReason; message: string };

type BlockedReason = 'rollout' | 'license' | 'engine' | 'unknown';

function blockedReasonOf(error: unknown): BlockedReason {
  if (error instanceof MixedNestingApiError) {
    if (error.isEngineUnavailable) return 'engine';
    if (error.isForbidden) return 'license';
    if (error.isUnavailable) return 'rollout';
  }
  return 'unknown';
}

/**
 * Trạng thái lệnh xuất, **gắn với `jobId`** thay vì đứng riêng.
 *
 * Buộc mang `jobId` để khỏi phải reset bằng effect: chạy lại là ra job mới, và khi đó
 * thông báo "đã lưu" của job cũ tự hết hiệu lực vì `jobId` không còn khớp.
 */
type ExportState =
  | { kind: 'idle' }
  | { kind: 'busy'; jobId: string }
  | { kind: 'saved'; jobId: string; fileName: string; sheetCount: number; file: File }
  | { kind: 'cancelled'; jobId: string }
  | { kind: 'error'; jobId: string; message: string };

export interface MixedNestingToolProps {
  tabId?: string;
  isActive?: boolean;
  onTitleChange?: (title: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
  /**
   * Mở kết quả sang một thẻ mới. Shell nối vào `handleOpenApp`; tool nào không được
   * truyền thì nút "mở kết quả" tự ẩn thay vì bấm không có gì xảy ra.
   */
  onSpawnTab?: (file: File, extraPayload?: Record<string, unknown>) => void;
  /** Khuôn bế nhận từ công cụ khác (Bù xén / Tạo đường cắt) hoặc từ lần mở file. */
  initialFile?: File;
}

export default function MixedNestingTool({
  tabId,
  isActive,
  onTitleChange,
  onDirtyChange,
  onSpawnTab,
  initialFile,
}: MixedNestingToolProps = {}) {
  const { t } = useTranslation();
  // Tab chưa có id (ví dụ render lẻ trong test) vẫn phải chạy được: dùng một khoá cố định.
  const key = tabId ?? 'mixed-nesting-single';
  const store = useMixedNestingStore();
  const tab = store.getTab(key);

  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  // Contour nguồn theo `partId`, để preview dựng lại hình. Không gửi lên server.
  const [sources, setSources] = useState<Record<string, PartSource>>({});
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });

  useEffect(() => {
    store.initTab(key);
  }, [key, store]);

  // ── Dò năng lực engine, chỉ khi tab đang xem ──
  const runProbe = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setProbe({ kind: 'loading' });
    try {
      const capabilities = await getCapabilities(controller.signal);
      if (controller.signal.aborted) return;
      setProbe({ kind: 'ready', capabilities });
    } catch (error) {
      if (controller.signal.aborted) return;
      setProbe({
        kind: 'blocked',
        reason: blockedReasonOf(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    if (probe.kind !== 'idle') return;
    // Đây đúng là trường hợp rule cho phép: đồng bộ với một hệ thống NGOÀI React (sidecar).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dò năng lực sidecar khi tab được kích hoạt.
    void runProbe();
  }, [isActive, probe.kind, runProbe]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [key]);

  useEffect(() => {
    onDirtyChange?.(isTabDirty(tab));
  }, [onDirtyChange, tab]);

  useEffect(() => {
    onTitleChange?.(t('mixedNesting.mixedNestingTool:binh_long_ghep_tu_do'));
  }, [onTitleChange, t]);

  // ── Vòng polling job ──
  const jobId = tab.job?.jobId ?? null;
  const jobTerminal = tab.job?.terminal ?? true;

  useEffect(() => {
    // Tab ẩn thì dừng theo dõi: job vẫn chạy trên máy, mở lại thẻ sẽ đọc tiếp.
    if (!jobId || jobTerminal || !isActive) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped) return;
      void (async () => {
        try {
          const status = await getJobStatus(jobId);
          if (stopped) return;
          // `applyJobStatus` bỏ qua snapshot của job khác — chốt chống job cũ ghi đè.
          store.applyJobStatus(key, status);
          if (status.terminal && status.status === 'completed') {
            const manifest = await getJobResult(jobId);
            if (!stopped) store.applyManifest(key, manifest);
          }
        } catch (error) {
          if (!stopped) {
            store.setError(key, error instanceof Error ? error.message : String(error));
          }
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [isActive, jobId, jobTerminal, key, store]);

  // ── Đóng tab: hủy job đúng một lần rồi dọn state ──
  //
  // Ref được cập nhật trong EFFECT, không trong render: ghi ref lúc render là thứ eslint
  // `react-hooks/refs` chặn, và cũng sai với StrictMode (render hai lần).
  const closingRef = useRef({ key, jobId, terminal: jobTerminal });
  useEffect(() => {
    closingRef.current = { key, jobId, terminal: jobTerminal };
  }, [jobId, jobTerminal, key]);
  useEffect(() => {
    return () => {
      const snapshot = closingRef.current;
      if (snapshot.jobId && !snapshot.terminal) {
        // Không await: unmount không chờ được. Lỗi ở đây vô hại vì job có TTL riêng.
        void cancelJob(snapshot.jobId).catch(() => undefined);
      }
      useMixedNestingStore.getState().destroyTab(snapshot.key);
    };
  }, []);

  // ── Hành động ──
  const addSource = useCallback(
    (source: SourceRecord, candidate: ContourCandidate) => {
      // `partId` lấy từ tên file + mã ứng viên: người dùng nhận ra được, và duy nhất.
      const base = source.fileName.replace(/\.pdf$/i, '').slice(0, 80) || 'khuon';
      const partId = `${base}-${candidate.candidateId}`;
      setSources((current) => ({
        ...current,
        [partId]: { partId, outer: candidate.outer, holes: candidate.holes },
      }));
      store.addPart(key, {
        partId,
        quantity: 1,
        outer: candidate.outer,
        holes: candidate.holes,
        rotationConstraint: { mode: 'inherit' },
        sourceLabel: t('mixedNesting.mixedNestingTool:ten_file_trang_n', {
          file: source.fileName,
          n: candidate.pageNumber,
        }),
      });
    },
    [key, store, t],
  );

  const removePart = useCallback(
    (uiId: string) => {
      const part = store.getTab(key).parts.find((item) => item.uiId === uiId);
      store.removePart(key, uiId);
      if (part) {
        setSources((current) => {
          const rest = { ...current };
          delete rest[part.partId];
          return rest;
        });
      }
    },
    [key, store],
  );

  const run = useCallback(async () => {
    const current = store.getTab(key);
    if (!canRun(current)) return;
    try {
      const accepted = await createJob(buildRequestFromTab(current));
      store.beginRun(key, accepted.jobId);
    } catch (error) {
      store.setError(key, error instanceof Error ? error.message : String(error));
    }
  }, [key, store]);

  const cancel = useCallback(async () => {
    const current = store.getTab(key);
    if (!current.job || current.job.terminal) return;
    store.markCancelRequested(key);
    try {
      await cancelJob(current.job.jobId);
    } catch (error) {
      store.setError(key, error instanceof Error ? error.message : String(error));
    }
  }, [key, store]);

  const discardResult = useCallback(async () => {
    const current = store.getTab(key);
    const id = current.job?.jobId;
    store.clearJob(key);
    setExportState({ kind: 'idle' });
    if (id) await deleteJob(id).catch(() => undefined);
  }, [key, store]);

  /**
   * Xuất PDF đường bế 1:1 rồi cho người dùng chọn nơi lưu.
   *
   * Hai bước tách bạch có lý do: `POST /export` sinh file trong root artifact riêng của tính
   * năng (TTL 2 giờ, quota, owner isolation), `GET /artifact` mới stream bytes. Gộp thành
   * một sẽ mất chỗ để kiểm quyền trước khi tốn công dựng PDF.
   */
  const exportPdf = useCallback(async () => {
    const current = store.getTab(key);
    const id = current.job?.jobId;
    // Không kiểm `hasUsableResult` ở đây nữa: nút chỉ hiện khi đã có kết quả dùng được.
    if (!id) return;
    setExportState({ kind: 'busy', jobId: id });
    try {
      const result = await exportJob(id);
      const blob = await fetchJobArtifact(id);
      const outcome = await saveBlob(blob, result.fileName, {
        title: t('mixedNesting.mixedNestingTool:luu_pdf_to_da_long_ghep'),
        filterName: 'PDF',
        extensions: ['pdf'],
      });
      if (outcome.kind === 'cancelled') {
        setExportState({ kind: 'cancelled', jobId: id });
        return;
      }
      setExportState({
        kind: 'saved',
        jobId: id,
        fileName: result.fileName,
        sheetCount: result.sheetCount,
        // Giữ lại bytes để mở sang thẻ mới mà không phải tải lần hai.
        file: new File([blob], result.fileName, { type: 'application/pdf' }),
      });
    } catch (error) {
      setExportState({
        kind: 'error',
        jobId: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [key, store, t]);

  const sourceList = useMemo(() => Object.values(sources), [sources]);
  const running = isRunning(tab);
  const showResult = hasUsableResult(tab) && tab.manifest !== null;
  const tongSoCon = useMemo(
    () => tab.parts.reduce((sum, part) => sum + part.quantity, 0),
    [tab.parts],
  );
  // Trạng thái xuất của job KHÁC coi như chưa xuất — chống thông báo "đã lưu" sống sót qua
  // một lần chạy lại.
  const exportForJob =
    exportState.kind !== 'idle' && exportState.jobId === jobId ? exportState : { kind: 'idle' as const };

  // ── Render ──
  if (probe.kind === 'blocked') {
    const BLOCKED_TITLE: Record<BlockedReason, string> = {
      rollout: t('mixedNesting.mixedNestingTool:tinh_nang_chua_duoc_mo'),
      license: t('mixedNesting.mixedNestingTool:can_goi_prynx_pro'),
      engine: t('mixedNesting.mixedNestingTool:thieu_phan_loi_tinh_toan'),
      unknown: t('mixedNesting.mixedNestingTool:khong_ket_noi_duoc_phan_loi'),
    };
    const BLOCKED_HINT: Record<BlockedReason, string> = {
      rollout: t('mixedNesting.mixedNestingTool:ban_phat_hanh_dang_tam_khoa'),
      license: t('mixedNesting.mixedNestingTool:quyen_thuoc_goi_pro_tach_rieng'),
      engine: t('mixedNesting.mixedNestingTool:hay_cap_nhat_de_cai_lai_phan_loi'),
      unknown: t('mixedNesting.mixedNestingTool:hay_thu_lai_neu_van_loi_khoi_dong_lai'),
    };
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-start bg-slate-50 dark:bg-[#1a1a1a] p-6">
        <div
          className="max-w-xl w-full rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10"
          role="alert"
          data-testid="mixed-nesting-blocked"
          data-reason={probe.reason}
        >
          <h2 className="text-sm font-bold text-amber-900 dark:text-amber-200 uppercase tracking-wide">
            {BLOCKED_TITLE[probe.reason]}
          </h2>
          <p className="mt-1.5 text-[13px] text-amber-800 dark:text-amber-300">
            {BLOCKED_HINT[probe.reason]}
          </p>
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400/80">{probe.message}</p>
          {probe.reason !== 'license' && probe.reason !== 'rollout' && (
            <button
              type="button"
              onClick={() => void runProbe()}
              className="mt-3 h-8 rounded border border-amber-400 px-3 text-[13px] font-semibold text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/20"
            >
              {t('mixedNesting.mixedNestingTool:thu_lai')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative w-full h-full flex flex-col bg-slate-50 dark:bg-[#1a1a1a]"
      data-testid="mixed-nesting-tool"
      data-tab-id={tabId}
    >
      <div className="flex-1 flex flex-row overflow-hidden">
        {/* ══ TRÁI: vùng xem trước ══ */}
        <div className="flex-1 relative z-0 min-w-0 flex flex-col">
          {/* Overlay tiến độ phủ vùng xem trước — cùng khuôn với ImpositionTab:4061. */}
          {tab.job && !tab.job.terminal && (
            <div
              className="absolute inset-0 bg-[#525659]/70 backdrop-blur-sm z-[120] flex flex-col items-center justify-center text-white"
              data-testid="mn-progress"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-white/25 border-t-white/90 rounded-full animate-spin" />
                <span className="text-sm font-medium text-white/90">
                  {tab.job.cancelRequested
                    ? t('mixedNesting.mixedNestingTool:dang_dung')
                    : t('mixedNesting.mixedNestingTool:dang_xep_trang_thai', { status: tab.job.status })}
                </span>
              </div>
              <div className="mt-4 w-64 h-1.5 rounded-full overflow-hidden bg-white/20">
                <div
                  className="h-full bg-white/80 transition-[width] duration-200 ease-linear"
                  style={{ width: `${Math.round((tab.job.progress?.progress ?? 0) * 100)}%` }}
                />
              </div>
              {!tab.job.cancelRequested && (
                <button
                  type="button"
                  onClick={() => void cancel()}
                  className="mt-5 rounded-md border border-white/20 px-4 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10"
                  data-testid="mn-cancel"
                >
                  {t('mixedNesting.mixedNestingTool:dung_lai')}
                </button>
              )}
            </div>
          )}

          {showResult && tab.manifest ? (
            <div className="flex-1 overflow-auto p-6">
              <NestingPreview
                manifest={tab.manifest}
                sheet={tab.sheet}
                sources={sourceList}
                activeSheetIndex={tab.activeSheetIndex}
                onActiveSheetChange={(index) => store.setActiveSheetIndex(key, index)}
                isActive={isActive}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md text-center" data-testid="mn-empty-state">
                <div className="text-5xl select-none" aria-hidden="true">🧷</div>
                <h2 className="mt-4 text-xl font-bold text-slate-800 dark:text-white">
                  {t('mixedNesting.mixedNestingTool:binh_long_ghep_tu_do')}
                </h2>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-600 dark:text-zinc-400">
                  {t('mixedNesting.mixedNestingTool:mo_ta_dai')}
                </p>
                <p className="mt-4 text-[11px] text-slate-500 dark:text-zinc-500">
                  {t('mixedNesting.mixedNestingTool:them_khuon_o_panel_ben_phai')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ══ PHẢI: panel thiết lập ══ */}
        <aside className="w-[380px] shrink-0 flex flex-col bg-[#f8fafc] dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 shadow-[-10px_0_30px_rgba(0,0,0,0.05)] z-20">
          <div className="px-4 h-12 flex items-center justify-between border-b border-black/5 dark:border-white/5 bg-slate-100 dark:bg-[#1a1a1a] shrink-0 shadow-sm relative z-10">
            <h2 className="text-[13px] font-bold text-slate-800 dark:text-zinc-200 uppercase tracking-wide flex items-center gap-1.5">
              {t('mixedNesting.mixedNestingTool:thiet_lap')}
            </h2>
            {tab.parts.length > 0 && (
              <span className="text-[10px] text-slate-400 dark:text-zinc-500 font-mono normal-case tracking-normal border pl-1.5 pr-1.5 py-0.5 rounded-full border-black/5 dark:border-white/5 tabular-nums">
                {t('mixedNesting.mixedNestingTool:n_khuon_m_con', {
                  n: tab.parts.length,
                  m: tongSoCon,
                })}
              </span>
            )}
          </div>

          <div className="p-4 overflow-y-auto flex-1 flex flex-col gap-5 text-sm text-slate-800 dark:text-zinc-200 scroller-thin">
            <div className="pt-2 text-center pb-2">
              <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                <span aria-hidden="true">🧷</span>
                <span>{t('mixedNesting.mixedNestingTool:binh_long_ghep_tu_do')}</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-1">
                {t('mixedNesting.mixedNestingTool:mo_ta_ngan')}
              </p>
            </div>

            <Divider />

            {probe.kind === 'loading' && (
              <div
                className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-zinc-400"
                role="status"
              >
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                {t('mixedNesting.mixedNestingTool:dang_kiem_tra_phan_loi')}
              </div>
            )}

            <MixedNestingFileInput
              tabId={tabId}
              isActive={isActive}
              disabled={running}
              initialFile={initialFile}
              onSourceReady={addSource}
            />

            <PartsTable
              parts={tab.parts}
              disabled={running}
              onQuantityChange={(uiId, quantity) => store.updatePart(key, uiId, { quantity })}
              onRotationChange={(uiId, constraint) => store.setPartRotation(key, uiId, constraint)}
              onRemove={removePart}
            />

            <Divider />

            <InputPanel
              sheet={tab.sheet}
              gapMm={tab.gapMm}
              profile={tab.profile}
              seed={tab.seed}
              timeBudgetMs={tab.timeBudgetMs}
              defaultRotation={tab.defaultRotation}
              disabled={running}
              onSheetChange={(patch) => store.setSheet(key, patch)}
              onMarginChange={(patch) => store.setMargin(key, patch)}
              onGapChange={(value) => store.setGapMm(key, value)}
              onProfileChange={(value) => store.setProfile(key, value)}
              onSeedChange={(value) => store.setSeed(key, value)}
              onTimeBudgetChange={(value) => store.setTimeBudgetMs(key, value)}
              onDefaultRotationChange={(value) => store.setDefaultRotation(key, value)}
            />

            {showResult && tab.manifest && (
              <>
                <Divider />
                <ResultSummary manifest={tab.manifest} sheet={tab.sheet} sources={sourceList} />
              </>
            )}

            {tab.issues.length > 0 && (
              <div
                className="rounded-lg border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20 p-3 text-[11px]"
                data-testid="mn-issues"
              >
                <p className="font-bold text-red-600 dark:text-red-400">
                  {t('mixedNesting.mixedNestingTool:ket_qua_bi_tu_choi_n_loi', { n: tab.issues.length })}
                </p>
                <ul className="mt-1 space-y-0.5 text-red-600/90 dark:text-red-400/90">
                  {tab.issues.slice(0, 8).map((issue) => (
                    <li key={`${issue.path}-${issue.code}`}>
                      {issue.path || t('mixedNesting.mixedNestingTool:goc')}: {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── Hành động: dán đáy panel như Bình tem bế ── */}
            <div className="pt-4 mt-auto flex flex-col gap-3">
              <Divider />
              {showResult && (
                <button
                  type="button"
                  className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
                  disabled={exportForJob.kind === 'busy'}
                  onClick={() => void exportPdf()}
                  data-testid="mn-export"
                >
                  {exportForJob.kind === 'busy'
                    ? t('mixedNesting.mixedNestingTool:dang_xuat')
                    : t('mixedNesting.mixedNestingTool:xuat_pdf')}
                </button>
              )}

              {!running && (
                <button
                  type="button"
                  className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
                  disabled={!canRun(tab) || probe.kind !== 'ready'}
                  title={
                    tab.parts.length === 0
                      ? t('mixedNesting.mixedNestingTool:them_khuon_truoc_khi_xep')
                      : undefined
                  }
                  onClick={() => void run()}
                  data-testid="mn-run"
                >
                  {t('mixedNesting.mixedNestingTool:xep_khuon')}
                </button>
              )}

              {showResult && (
                <button
                  type="button"
                  className="w-full h-8 rounded border border-slate-300 dark:border-white/20 text-[13px] font-medium text-slate-600 dark:text-zinc-300 hover:border-red-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                  onClick={() => void discardResult()}
                  data-testid="mn-discard"
                >
                  {t('mixedNesting.mixedNestingTool:bo_ket_qua')}
                </button>
              )}
            </div>

            {exportForJob.kind === 'saved' && (
              <div
                className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-[11px] text-emerald-700 dark:text-emerald-400"
                role="status"
                data-testid="mn-export-saved"
              >
                {t('mixedNesting.mixedNestingTool:da_luu_ten_n_to', {
                  name: exportForJob.fileName,
                  n: exportForJob.sheetCount,
                })}
                {onSpawnTab && (
                  <button
                    type="button"
                    className="mt-2 w-full h-8 rounded border border-emerald-300 dark:border-emerald-700 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
                    onClick={() => onSpawnTab(exportForJob.file)}
                    data-testid="mn-open-result"
                  >
                    {t('mixedNesting.mixedNestingTool:mo_ket_qua_sang_the_moi')}
                  </button>
                )}
              </div>
            )}

            {exportForJob.kind === 'error' && (
              <p
                className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/50 rounded text-sm whitespace-pre-line"
                role="alert"
                data-testid="mn-export-error"
              >
                {exportForJob.message}
              </p>
            )}

            {tab.error && (
              <p
                className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/50 rounded text-sm whitespace-pre-line"
                role="alert"
                data-testid="mn-error"
              >
                {tab.error}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
