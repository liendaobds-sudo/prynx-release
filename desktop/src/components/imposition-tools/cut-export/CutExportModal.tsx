// CutExportModal.tsx — Modal "Gửi máy bế" (spec: gui-may-be, task 12 + UX polish).
//
// UX: nhớ cấu hình (localStorage), đồng bộ tờ với viewer + chuyển tờ + gửi tất cả,
// preview rõ (backend nét đậm + khung), tùy chọn nâng cao thu gọn, ESC để đóng,
// chọn lớp cắt thủ công khi auto-dò fail.

import React, { useEffect, useRef, useState } from "react";
import {
  listCutProfiles,
  cutExport,
  cutExportFromFile,
  inspectCutFile,
  CutInspectUnavailableError,
  listCutPages,
  cutPreviewFromFile,
  type CutProfileInfo,
  type CutExportRequest,
  type CutExportFromFileRequest,
  type CutExportResult,
  type CutInspectResult,
  type CutLayerCandidates,
  type CutPreviewResult,
  type Pt,
} from "./api";
import { getMachineConn } from "./machineSettings";
import { useTranslation } from 'react-i18next';
// UIUX (audit 2026-07-27 §B-23): dịch lỗi kỹ thuật thành câu Việt + hướng khắc phục
import { formatError } from "../../../lib/errorMessages";

export interface CutExportModalProps {
  open: boolean;
  onClose: () => void;
  sheetWmm: number;
  sheetHmm: number;
  paths: Pt[][];
  marks?: Pt[];
  defaultName?: string;
  sourcePdfPath?: string;
  sourceName?: string;
  /** Trang đang xem ở viewer (1-indexed) — modal mặc định gửi đúng tờ này. */
  currentPage?: number;
}

type Emitter = "command_stream" | "dxf" | "svg" | "pdf";
type Channel = "file" | "tcp";

const LS_KEY = "prynx.cutExport.v1";

interface SavedSettings {
  profileId?: string;
  emitter?: Emitter;
  channel?: Channel;
  tcpHost?: string;
  destDir?: string;
}

interface CutInspectionSnapshot {
  /** Trang user yêu cầu inspect (zero-based); không bị đổi khi backend tự chọn trang khác. */
  requestedPageIdx: number;
  /** Trang đã được backend xác nhận có thể preview/xuất (zero-based). */
  selectedPageIdx: number | null;
  cutPages: number[];
  preview: CutPreviewResult | null;
  /** `undefined` = sidecar legacy; `null` = proof đã dùng/chưa có; string = proof mới. */
  inspectProof?: string | null;
  /** Proof cùng fingerprint cho toàn bộ trang CUT; `undefined` = sidecar chưa hỗ trợ batch. */
  inspectProofs?: Record<string, string>;
}

const EMPTY_CANDIDATES: CutLayerCandidates = { layers: [], spots: [] };

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError",
  );
}

function normalisePage(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.max(0, fallback);
  return Math.max(0, Math.trunc(value));
}

function normaliseCutPages(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((page) => (typeof page === "number" && Number.isFinite(page) ? Math.trunc(page) : -1))
    .filter((page) => page >= 0))].sort((a, b) => a - b);
}

function normaliseCandidates(value: unknown): CutLayerCandidates {
  if (!value || typeof value !== "object") return EMPTY_CANDIDATES;
  const raw = value as Partial<CutLayerCandidates>;
  return {
    layers: Array.isArray(raw.layers) ? raw.layers.filter((item): item is string => typeof item === "string") : [],
    spots: Array.isArray(raw.spots) ? raw.spots.filter((item): item is string => typeof item === "string") : [],
    auto_matched: Array.isArray(raw.auto_matched)
      ? raw.auto_matched.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function normaliseInspectProofs(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([page, proof]) => /^\d+$/.test(page) && typeof proof === "string" && proof.length > 0),
  );
}

function formatPageList(pages: number[]): string {
  return pages.map((page) => String(page + 1)).join(", ");
}

function snapshotFromInspect(
  data: CutInspectResult,
  requestedPageIdx: number,
): CutInspectionSnapshot {
  const cutPages = normaliseCutPages(data.cut_pages);
  const proofFieldPresent = Object.prototype.hasOwnProperty.call(data, "inspect_proof");
  const proofsFieldPresent = Object.prototype.hasOwnProperty.call(data, "inspect_proofs");
  const inspectProofs = normaliseInspectProofs(data.inspect_proofs);
  const selectedClaim = typeof data.selected_page_idx === "number"
    && Number.isFinite(data.selected_page_idx)
    ? normalisePage(data.selected_page_idx, requestedPageIdx)
    : null;
  const selectedBatchProof = selectedClaim === null ? null : inspectProofs?.[String(selectedClaim)];
  const validInspectProof = typeof data.inspect_proof === "string" && data.inspect_proof
    ? data.inspect_proof
    : (selectedBatchProof || null);
  // PERF/SAFETY (audit 2026-09-02 §PERF-NEST-07): chỉ response thành công và
  // có selected_page_idx tường minh mới được mở nút Gửi. Response lỗi/thiếu field
  // không được ngầm biến requested page thành một trang đã inspect.
  const selectedPageIdx = data.ok && typeof data.selected_page_idx === "number"
    && Number.isFinite(data.selected_page_idx)
    && (!(proofFieldPresent || proofsFieldPresent) || validInspectProof !== null)
    ? normalisePage(data.selected_page_idx, requestedPageIdx)
    : null;
  const previewPageIdx = selectedPageIdx ?? normalisePage(requestedPageIdx);
  const candidates = normaliseCandidates(data.candidates);
  const numPages = typeof data.num_pages === "number" && Number.isFinite(data.num_pages)
    ? Math.max(0, Math.trunc(data.num_pages))
    : undefined;
  const rawPreview = data.preview;
  const preview: CutPreviewResult = data.ok && rawPreview
    ? {
        ok: true,
        svg: rawPreview.svg,
        total_items: rawPreview.total_items,
        sheet_w_mm: rawPreview.sheet_w_mm,
        sheet_h_mm: rawPreview.sheet_h_mm,
        page_idx: normalisePage(rawPreview.page_idx, previewPageIdx),
        num_pages: numPages,
        candidates,
      }
    : {
        ok: false,
        error: data.error || "Không tìm thấy đường cắt trong file PDF.",
        page_idx: previewPageIdx,
        num_pages: numPages,
        candidates,
      };
  return {
    requestedPageIdx: normalisePage(requestedPageIdx),
    selectedPageIdx,
    cutPages,
    preview,
    inspectProof: proofFieldPresent
      ? validInspectProof
      : undefined,
    inspectProofs: proofsFieldPresent ? inspectProofs : undefined,
  };
}

/**
 * Tương thích sidecar cũ chưa có `/cut-inspect`. Chỉ gọi đường legacy sau khi
 * endpoint hợp nhất trả lỗi; sidecar mới luôn đi đúng một request inspect.
 */
async function inspectWithLegacyFallback(
  path: string,
  requestedPageIdx: number,
  forceLayer: string,
  signal: AbortSignal,
): Promise<CutInspectResult> {
  let inspectError: unknown;
  try {
    const unified = await inspectCutFile(
      {
        path,
        page_idx: normalisePage(requestedPageIdx),
        ...(forceLayer ? { force_layer: forceLayer } : {}),
      },
      signal,
    );
    return unified;
  } catch (error: unknown) {
    if (isAbortError(error) || signal.aborted) throw error;
    if (
      !(error instanceof CutInspectUnavailableError)
      || (error.status !== 404 && error.status !== 405)
    ) throw error;
    inspectError = error;
  }

  try {
    const pages = await listCutPages(path, signal);
    const requested = normalisePage(requestedPageIdx);
    const selected = pages.includes(requested) ? requested : (pages[0] ?? requested);
    const legacy = await cutPreviewFromFile(
      path,
      selected,
      forceLayer || undefined,
      pages.length === 0 && !forceLayer,
      signal,
    );
    const resolved = normalisePage(legacy.page_idx, selected);
    const fallbackPages = pages.length > 0
      ? pages
      : (legacy.ok ? [resolved] : []);
    const candidates = normaliseCandidates(legacy.candidates);
    return {
      ok: legacy.ok,
      cut_pages: fallbackPages,
      num_pages: legacy.num_pages,
      selected_page_idx: legacy.ok ? resolved : null,
      candidates,
      preview: legacy.ok
        ? {
            svg: legacy.svg,
            total_items: legacy.total_items,
            sheet_w_mm: legacy.sheet_w_mm,
            sheet_h_mm: legacy.sheet_h_mm,
            page_idx: resolved,
          }
        : null,
      error: legacy.ok
        ? undefined
        : legacy.error || (typeof inspectError === "string" ? inspectError : undefined),
    };
  } catch (fallbackError: unknown) {
    if (isAbortError(fallbackError) || signal.aborted) throw fallbackError;
    if (inspectError instanceof Error) throw inspectError;
    throw fallbackError;
  }
}

function loadSettings(): SavedSettings {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveSettings(s: SavedSettings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export default function CutExportModal(props: CutExportModalProps) {
  const { t } = useTranslation();
  const { open, onClose, sheetWmm, sheetHmm, paths, marks, defaultName, sourcePdfPath, sourceName, currentPage } = props;

  const saved = useRef<SavedSettings>(loadSettings());
  const [profiles, setProfiles] = useState<CutProfileInfo[]>([]);
  const [profileId, setProfileId] = useState<string>(saved.current.profileId || "");
  const [emitter, setEmitter] = useState<Emitter>(saved.current.emitter || "command_stream");
  const [channel, setChannel] = useState<Channel>(saved.current.channel || "file");
  const [tcpHost, setTcpHost] = useState<string>(saved.current.tcpHost || "");
  const [tcpPort, setTcpPort] = useState<number>(9100);
  const [destDir, setDestDir] = useState<string>(saved.current.destDir || "");
  const [inspection, setInspection] = useState<CutInspectionSnapshot>({
    requestedPageIdx: 0,
    selectedPageIdx: null,
    cutPages: [],
    preview: null,
    inspectProof: undefined,
    inspectProofs: undefined,
  });
  const [inspectRequestVersion, setInspectRequestVersion] = useState(0);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [forceLayer, setForceLayer] = useState<string>("");
  const [copies, setCopies] = useState<number>(1);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [result, setResult] = useState<CutExportResult | null>(null);
  const [error, setError] = useState<string>("");
  const [batchMsg, setBatchMsg] = useState<string>("");
  // SAFETY (audit 2026-09-02 §PERF-NEST-07): ghi nhận các tờ đã tới máy
  // trong lượt Gửi tất cả hiện tại. TCP/serial không có transaction rollback,
  // nên lượt tiếp theo chỉ được phát các tờ còn thiếu sau lỗi giữa chừng.
  const [sentPages, setSentPages] = useState<number[]>([]);
  const [batchContinuationBlocked, setBatchContinuationBlocked] = useState(false);

  // PERF (audit 2026-09-02 §PERF-NEST-07): mỗi lần inspect có một controller +
  // generation riêng. Callback cũ không được chạm state sau khi đổi tờ/lớp/nguồn.
  const inspectAbortRef = useRef<AbortController | null>(null);
  const inspectGenerationRef = useRef(0);
  const lastInspectKeyRef = useRef<string | null>(null);
  const previousOpenRef = useRef(false);
  const previousSourceRef = useRef<string | undefined>(undefined);
  const previousCurrentPageRef = useRef<number | undefined>(undefined);
  // SAFETY (audit 2026-09-02 §PERF-NEST-07): khóa đồng bộ chặn double-click trước
  // khi React kịp render `busy`; một proof/command máy chỉ được phát một lần.
  const sendInFlightRef = useRef(false);
  const proofRefreshNoticeRef = useRef(false);
  const sendLedgerContextRef = useRef<string | null>(null);

  // Đổi nguồn/lớp hoặc đóng-mở modal tạo một lượt gửi mới; không mang ledger
  // của revision cũ sang revision mới. Đổi tờ trong cùng file vẫn giữ ledger.
  useEffect(() => {
    if (!open) {
      sendLedgerContextRef.current = null;
      setSentPages((pages) => (pages.length > 0 ? [] : pages));
      setBatchContinuationBlocked(false);
      return;
    }
    const context = `${sourcePdfPath || ""}\u0000${forceLayer}`;
    if (sendLedgerContextRef.current === context) return;
    sendLedgerContextRef.current = context;
    setSentPages((pages) => (pages.length > 0 ? [] : pages));
    setBatchContinuationBlocked(false);
  }, [open, sourcePdfPath, forceLayer]);

  const pageIdx = inspection.selectedPageIdx ?? inspection.requestedPageIdx;
  const requestedPageIdx = inspection.requestedPageIdx;
  const cutPages = inspection.cutPages;
  const preview = inspection.preview;

  const useFileSource = !!sourcePdfPath;

  // Số "tờ" hiển thị = số TRANG KHUÔN (bỏ trang in). Nếu chưa quét được → fallback num_pages.
  const hasCutPages = cutPages.length > 0;
  const hasSelectedCutPage = inspection.selectedPageIdx !== null;
  const sheetCount = hasCutPages
    ? cutPages.length
    : (hasSelectedCutPage ? (preview?.num_pages || 1) : 0);
  const cutPos = hasCutPages ? Math.max(0, cutPages.indexOf(pageIdx)) : pageIdx;

  const goToSheet = (pos: number) => {
    if (hasCutPages) {
      const c = Math.min(cutPages.length - 1, Math.max(0, pos));
      const nextPageIdx = cutPages[c];
      setInspection((previous) => ({
        ...previous,
        requestedPageIdx: nextPageIdx,
        selectedPageIdx: null,
        preview: null,
        inspectProof: previous.inspectProof === undefined ? undefined : null,
        inspectProofs: previous.inspectProofs === undefined ? undefined : {},
      }));
      setInspectRequestVersion((version) => version + 1);
    } else {
      const nextPageIdx = Math.min(sheetCount - 1, Math.max(0, pos));
      setInspection((previous) => ({
        ...previous,
        requestedPageIdx: nextPageIdx,
        selectedPageIdx: null,
        preview: null,
        inspectProof: previous.inspectProof === undefined ? undefined : null,
        inspectProofs: previous.inspectProofs === undefined ? undefined : {},
      }));
      setInspectRequestVersion((version) => version + 1);
    }
  };

  // Tải profile khi mở. Inspect PDF được điều phối ở effect bên dưới để dùng
  // đúng một request hợp nhất và có generation fence riêng.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError("");
    setBatchMsg("");
    setForceLayer("");
    setCopies(1);
    listCutProfiles()
      .then((ps) => {
        setProfiles(ps);
        setProfileId((cur) => cur || saved.current.profileId || (ps[0]?.id ?? ""));
      })
      // UIUX (audit 2026-07-27 §B-23): không đổ String(e) thô ra giao diện
      .catch((e: unknown) => setError(formatError(e, t('imposition.cutExport:khong_tai_duoc_cau_hinh_may_cat', 'Không tải được cấu hình máy cắt'))));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- LINT (audit 2026-08-24 LO140): t chỉ định dạng lỗi; đổi ngôn ngữ không được reset modal rồi quét lại profile/trang khuôn.
  }, [open, currentPage, sourcePdfPath]);

  // Đóng bằng ESC.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !sendInFlightRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  // Đổi máy → nạp kết nối đã lưu của máy đó (Preferences → Máy bế).
  useEffect(() => {
    if (!open || !profileId) return;
    const conn = getMachineConn(profileId);
    if (conn) {
      setChannel(conn.channel);
      setEmitter(conn.emitter);
      setTcpHost(conn.tcpHost || "");
      setTcpPort(conn.tcpPort ?? 9100);
      setDestDir(conn.destDir || "");
    }
  }, [open, profileId]);

  // Lưu cấu hình khi đổi.
  useEffect(() => {
    if (!open) return;
    saveSettings({ profileId, emitter, channel, tcpHost, destDir });
  }, [open, profileId, emitter, channel, tcpHost, destDir]);

  // Inspect theo tờ + lớp + nguồn. Backend mới trả cutPages/selected/preview
  // trong cùng payload; state snapshot được commit một lần để UI không ghép nhầm
  // preview cũ với trang mới. `lastInspectKeyRef` chặn lượt lặp do reset state
  // lúc mở và do backend chọn trang khác requested page.
  useEffect(() => {
    if (!open || !sourcePdfPath) {
      const wasOpen = previousOpenRef.current;
      inspectAbortRef.current?.abort();
      inspectAbortRef.current = null;
      if (wasOpen) inspectGenerationRef.current += 1;
      lastInspectKeyRef.current = null;
      previousOpenRef.current = false;
      previousSourceRef.current = sourcePdfPath;
      previousCurrentPageRef.current = currentPage;
      if (!open) {
        setPreviewing(false);
        setInspection((previous) => {
          if (
            previous.requestedPageIdx === 0
            && previous.selectedPageIdx === null
            && previous.cutPages.length === 0
            && previous.preview === null
            && previous.inspectProof === undefined
            && previous.inspectProofs === undefined
          ) return previous;
          return {
            ...previous,
            requestedPageIdx: 0,
            selectedPageIdx: null,
            cutPages: [],
            preview: null,
            inspectProof: undefined,
            inspectProofs: undefined,
          };
        });
      }
      return;
    }

    const viewerIdx = currentPage && currentPage > 0 ? currentPage - 1 : 0;
    const isNewOpen = !previousOpenRef.current;
    const isNewSource = previousSourceRef.current !== sourcePdfPath;
    const previousViewerIdx = previousCurrentPageRef.current && previousCurrentPageRef.current > 0
      ? previousCurrentPageRef.current - 1
      : 0;
    const isExternalPageChange = previousViewerIdx !== viewerIdx;
    const resetInput = isNewOpen || isNewSource || isExternalPageChange;
    const requestPageIdx = resetInput ? normalisePage(viewerIdx) : requestedPageIdx;
    // Reset lớp khi đổi nguồn/mở lại. Dùng effective value ngay trong lượt này
    // để không gửi tên lớp của file/trang cũ. Chưa mở request ở render này vì
    // đổi dependency giữa chừng sẽ hủy request đúng rồi chạy lại trang cũ.
    if (resetInput && forceLayer) {
      setForceLayer("");
      return;
    }
    const effectiveForceLayer = forceLayer;

    previousOpenRef.current = true;
    previousSourceRef.current = sourcePdfPath;
    previousCurrentPageRef.current = currentPage;
    if (resetInput) {
      setInspection((previous) => ({
        ...previous,
        requestedPageIdx: requestPageIdx,
        selectedPageIdx: null,
        cutPages: [],
        preview: null,
        inspectProof: undefined,
        inspectProofs: undefined,
      }));
    }

    const inspectKey = `${sourcePdfPath}\u0000${requestPageIdx}\u0000${effectiveForceLayer}`;
    if (lastInspectKeyRef.current === inspectKey) return;
    lastInspectKeyRef.current = inspectKey;

    inspectAbortRef.current?.abort();
    const generation = ++inspectGenerationRef.current;
    const controller = new AbortController();
    inspectAbortRef.current = controller;
    const isCurrent = () => (
      !controller.signal.aborted
      && generation === inspectGenerationRef.current
      && inspectAbortRef.current === controller
    );
    setPreviewing(true);
    inspectWithLegacyFallback(sourcePdfPath, requestPageIdx, effectiveForceLayer, controller.signal)
      .then((data) => {
        if (!isCurrent()) return;
        const snapshot = snapshotFromInspect(data, requestPageIdx);
        // Atomic commit: selected page + cutPages + preview luôn cùng generation.
        setInspection(snapshot);
        if (!data.ok && data.error) {
          setError(formatError(new Error(data.error), t('imposition.cutExport:khong_xem_truoc_duoc')));
        } else if (!proofRefreshNoticeRef.current) {
          setError("");
        }
        proofRefreshNoticeRef.current = false;
      })
      .catch((e: unknown) => {
        if (!isCurrent() || isAbortError(e) || controller.signal.aborted) return;
        setInspection((previous) => ({
          ...previous,
          selectedPageIdx: null,
          preview: { ok: false, error: formatError(e, t('imposition.cutExport:khong_xem_truoc_duoc')) },
          inspectProof: previous.inspectProof === undefined ? undefined : null,
          inspectProofs: previous.inspectProofs === undefined ? undefined : {},
        }));
        setError(formatError(e, t('imposition.cutExport:khong_xem_truoc_duoc')));
      })
      .finally(() => {
        // Không để finally của lượt cũ tắt spinner của lượt mới.
        if (isCurrent()) {
          setPreviewing(false);
          inspectAbortRef.current = null;
        }
      });
    return () => {
      controller.abort();
      if (inspectAbortRef.current === controller) {
        inspectAbortRef.current = null;
        // React StrictMode chạy setup/cleanup một lượt thăm dò; cho phép
        // setup kế tiếp khởi động lại cùng key thay vì bị dedupe nhầm.
        if (lastInspectKeyRef.current === inspectKey) lastInspectKeyRef.current = null;
      }
    };
  // `requestedPageIdx` không nằm trong deps: response inspect đồng bộ snapshot
  // không được tự phát request lần hai. Chuyển tờ thủ công tăng version tường minh.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- requestedPageIdx được kích bằng inspectRequestVersion; thêm trực tiếp sẽ nhân đôi request sau response.
  }, [open, sourcePdfPath, currentPage, forceLayer, inspectRequestVersion, t]);

  // Hủy request còn sống khi component bị tháo hẳn (ví dụ đóng tab).
  useEffect(() => () => {
    inspectAbortRef.current?.abort();
    inspectAbortRef.current = null;
    inspectGenerationRef.current += 1;
  }, []);

  if (!open) return null;

  const totalItems = paths.filter((p) => p.length >= 2).length;
  const sentPageSet = new Set(sentPages);
  const pendingCutPages = cutPages.filter((page) => !sentPageSet.has(page));
  const canSend = !!profileId && (useFileSource
    ? hasSelectedCutPage
      && !batchContinuationBlocked
      && (!sentPages.length || !sentPageSet.has(pageIdx))
    : totalItems > 0);
  const canSendAll = !!profileId
    && useFileSource
    && cutPages.length > 1
    && !batchContinuationBlocked
    && inspection.inspectProofs !== undefined
    && pendingCutPages.length > 0
    && pendingCutPages.every((page) => Boolean(inspection.inspectProofs?.[String(page)]));

  const previewSvg = preview?.svg
    ? preview.svg
        .replace(/(<svg[^>]*?)\s+width="[^"]*"/, "$1")
        .replace(/(<svg[^>]*?)\s+height="[^"]*"/, "$1")
    : "";

  function fileReqFor(
    page: number,
    nameSuffix = "",
    inspectProof?: string,
  ): CutExportFromFileRequest {
    const req: CutExportFromFileRequest = {
      path: sourcePdfPath as string,
      profile_id: profileId,
      page_idx: page,
      emitter_kind: emitter,
      transport_kind: channel,
      name: (defaultName || "cut") + nameSuffix,
      force_layer: forceLayer || undefined,
      copies: Math.max(1, copies || 1),
      ...(inspectProof ? { inspect_proof: inspectProof } : {}),
    };
    if (channel === "tcp") req.tcp_host = tcpHost;
    if (channel === "tcp" && tcpPort) req.tcp_port = tcpPort;
    if (channel === "file" && destDir) req.dest_dir = destDir;
    return req;
  }

  function acquireInspectProof(page: number): string | undefined {
    const batchProof = inspection.inspectProofs?.[String(page)];
    const selectedProof = inspection.selectedPageIdx === page ? inspection.inspectProof : null;
    const proof = batchProof || selectedProof || undefined;
    const modernProofContract = (
      inspection.inspectProofs !== undefined || inspection.inspectProof !== undefined
    );
    if (!proof) {
      // Sidecar legacy thật sự không có field proof vẫn đi đường parse cũ. Sidecar
      // đã công bố contract mà thiếu proof phải fail-closed, không được hạ cấp.
      if (!modernProofContract) return undefined;
      throw new Error("Backend không cấp bằng chứng inspect cho trang khuôn. Hãy xem trước lại.");
    }

    // Proof one-shot: tước khỏi snapshot trước khi request export bay đi để thao tác
    // kế tiếp không thể vô tình phát lại cùng một lệnh máy.
    setInspection((previous) => {
      const nextProofs = previous.inspectProofs === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(previous.inspectProofs).filter(([key]) => key !== String(page)),
          );
      return {
        ...previous,
        inspectProof: previous.inspectProof === proof ? null : previous.inspectProof,
        inspectProofs: nextProofs,
      };
    });
    return proof;
  }

  function refreshPreviewForNextSend(preserveError: boolean): void {
    proofRefreshNoticeRef.current = preserveError;
    lastInspectKeyRef.current = null;
    setInspection((previous) => ({
      ...previous,
      selectedPageIdx: null,
      preview: null,
      inspectProof: previous.inspectProof === undefined ? undefined : null,
      inspectProofs: previous.inspectProofs === undefined ? undefined : {},
    }));
    setInspectRequestVersion((version) => version + 1);
  }

  async function exportFilePage(
    page: number,
    nameSuffix: string,
  ): Promise<CutExportResult> {
    const proof = acquireInspectProof(page);
    const response = await cutExportFromFile(fileReqFor(page, nameSuffix, proof));
    return response;
  }

  const handleSend = async () => {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setBatchMsg("");
    try {
      let r: CutExportResult;
      if (useFileSource) {
        r = await exportFilePage(pageIdx, `_t${cutPos + 1}`);
      } else {
        const req: CutExportRequest = {
          profile_id: profileId,
          sheet_w_mm: sheetWmm,
          sheet_h_mm: sheetHmm,
          paths,
          marks,
          emitter_kind: emitter,
          transport_kind: channel,
          name: defaultName || "cut",
          copies: Math.max(1, copies || 1),
        };
        if (channel === "tcp") req.tcp_host = tcpHost;
        if (channel === "tcp" && tcpPort) req.tcp_port = tcpPort;
        if (channel === "file" && destDir) req.dest_dir = destDir;
        r = await cutExport(req);
      }
      setResult(r);
      if (!r.ok) setError(r.error || r.detail || t('imposition.cutExport:gui_that_bai'));
      if (useFileSource && !r.ok && r.proof_error && sentPages.length > 0) {
        // SAFETY (audit 2026-09-02 §PERF-NEST-07): đã có tờ tới máy mà proof
        // kế tiếp mất hiệu lực thì không thể tự quyết định gửi lại hay bỏ qua.
        // Giữ nguyên ledger và khóa tiếp tục để tránh vừa trùng lệnh vừa trộn revision.
        setBatchContinuationBlocked(true);
      }
      if (useFileSource && r.ok && sentPages.length > 0 && cutPages.includes(pageIdx)) {
        // Nếu user xử lý thủ công phần còn thiếu sau một batch lỗi, cập nhật
        // ledger để lần Gửi tất cả kế tiếp không phát trùng tờ đó.
        setSentPages((pages) => pages.includes(pageIdx)
          ? pages
          : [...pages, pageIdx].sort((a, b) => a - b));
      }
      if (useFileSource && (
        inspection.inspectProof !== undefined || inspection.inspectProofs !== undefined
      )) {
        // Proof là one-shot; cả thành công lẫn lỗi đều phải lấy snapshot mới cho
        // lần user chủ động gửi kế tiếp. Lỗi hiện tại được giữ để user biết kết quả.
        refreshPreviewForNextSend(!r.ok);
      }
    } catch (e: unknown) {
      // UIUX (audit 2026-07-27 §B-23): không đổ String(e) thô ra giao diện
      setError(formatError(e, t('imposition.cutExport:khong_gui_duoc_lenh_cat', 'Không gửi được lệnh cắt')));
    } finally {
      sendInFlightRef.current = false;
      setBusy(false);
    }
  };

  const handleSendAll = async () => {
    if (!useFileSource || !canSendAll || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    let okCount = 0;
    let firstErr = "";
    // SAFETY/PERF (audit 2026-09-02 §PERF-NEST-07): toàn batch dùng proof được
    // cấp từ MỘT lần inspect/fingerprint. Không re-inspect từng trang (O(P²)) và
    // dừng ngay lỗi đầu tiên để không gửi tiếp một batch máy bị hụt/mixed revision.
    const alreadySent = new Set(sentPages);
    const pagesToSend = cutPages.filter((page) => !alreadySent.has(page));
    const total = pagesToSend.length;
    let proofInvalidated = false;
    try {
      for (let k = 0; k < total; k++) {
        const p = pagesToSend[k];
        setBatchMsg(t('imposition.cutExport:dang_gui_to_k_total', { k: k + 1, total }));
        try {
          const r = await exportFilePage(p, `_t${k + 1}`);
          if (r.ok) {
            okCount += 1;
            setSentPages((pages) => pages.includes(p)
              ? pages
              : [...pages, p].sort((a, b) => a - b));
          } else {
            proofInvalidated = Boolean(r.proof_error);
            firstErr = r.error || r.detail || t('imposition.cutExport:to_k_loi', { k: k + 1 });
            break;
          }
        } catch (e: unknown) {
          // UIUX (audit 2026-07-27 §B-23): không đổ String(e) thô ra giao diện
          firstErr = formatError(e, t('imposition.cutExport:khong_gui_duoc_lenh_cat', 'Không gửi được lệnh cắt'));
          break;
        }
      }
      setBatchMsg(t('imposition.cutExport:xong_ok_total_to', { ok: okCount, total }));
      if (firstErr) setError(firstErr);
      // SAFETY (audit 2026-09-02 §PERF-NEST-07): proof lỗi sau ít nhất một
      // thành công là trạng thái không thể tự phục hồi an toàn. Không xóa ledger
      // rồi phát lại các tờ đã tới máy; operator phải mở một lượt gửi mới.
      if (proofInvalidated && (sentPages.length > 0 || okCount > 0)) {
        setBatchContinuationBlocked(true);
      }
      if (inspection.inspectProofs !== undefined) {
        refreshPreviewForNextSend(Boolean(firstErr));
      }
    } finally {
      sendInFlightRef.current = false;
      setBusy(false);
    }
  };

  const selStyle =
    "h-9 px-2 rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-100";

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={() => { if (!busy && !sendInFlightRef.current) onClose(); }}
    >
      <div
        className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800 dark:text-white">{t('imposition.cutExport:gui_may_be')}</h3>
          <button onClick={() => { if (!sendInFlightRef.current) onClose(); }} disabled={busy} className="w-7 h-7 rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-500 flex items-center justify-center disabled:opacity-50" title={t('imposition.cutExport:dong_esc')}>✕</button>
        </div>

        <div className="p-5 space-y-3">
          {useFileSource && (
            <p className="text-[13px] text-slate-500 dark:text-zinc-400 truncate">
              {t('imposition.cutExport:nguon')} <span className="font-medium text-slate-700 dark:text-zinc-200">{sourceName || t('imposition.cutExport:file_da_binh')}</span>
              {hasCutPages ? t('imposition.cutExport:n_trang_khuon_suffix', { n: sheetCount }) : ""}
            </p>
          )}

          {useFileSource && (
            <div className="h-[200px] rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900/50 flex items-center justify-center overflow-hidden">
              {previewing && <span className="text-[13px] text-slate-400">{t('imposition.cutExport:dang_dung_xem_truoc')}</span>}
              {!previewing && preview?.ok && previewSvg && (
                <img
                  className="w-full h-full object-contain p-2"
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(previewSvg)}`}
                  alt=""
                  draggable={false}
                />
              )}
              {!previewing && preview && !preview.ok && (
                <span className="text-[13px] text-red-500 px-3 text-center">{preview.error || t('imposition.cutExport:khong_xem_truoc_duoc')}</span>
              )}
            </div>
          )}

          {useFileSource && preview && !preview.ok && preview.candidates &&
            (preview.candidates.layers.length > 0 || preview.candidates.spots.length > 0) && (
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              {t('imposition.cutExport:chon_lop_cat_thu_cong')}
              <select className={`${selStyle} border-amber-400`} value={forceLayer} onChange={(e) => setForceLayer(e.target.value)}>
                <option value="">{t('imposition.cutExport:chon_lop_spot_color')}</option>
                {preview.candidates.layers.map((l) => <option key={"L:" + l} value={l}>{t('imposition.cutExport:lop', { l })}</option>)}
                {preview.candidates.spots.map((s) => <option key={"S:" + s} value={s}>Spot: {s}</option>)}
              </select>
            </label>
          )}

          {/* Máy + chuyển tờ — hàng chính */}
          <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
            {t('imposition.cutExport:may')}
            <select className={selStyle} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.vendor} {p.model}</option>)}
            </select>
          </label>

          {useFileSource && sheetCount > 1 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-slate-600 dark:text-zinc-300">{t('imposition.cutExport:trang_khuon')}</span>
              <div className="flex items-center gap-2">
                <button className="w-8 h-8 rounded border border-slate-300 dark:border-white/20 disabled:opacity-40" disabled={cutPos <= 0} onClick={() => goToSheet(cutPos - 1)}>‹</button>
                <span className="text-[13px] font-semibold min-w-[64px] text-center">{t('imposition.cutExport:to_x_y', { x: cutPos + 1, y: sheetCount })}</span>
                <button className="w-8 h-8 rounded border border-slate-300 dark:border-white/20 disabled:opacity-40" disabled={cutPos >= sheetCount - 1} onClick={() => goToSheet(cutPos + 1)}>›</button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-slate-600 dark:text-zinc-300">{t('imposition.cutExport:so_con_to')}</span>
            <span className="text-[13px] font-semibold">{useFileSource ? (preview?.ok ? preview.total_items : "—") : totalItems}</span>
          </div>

          {useFileSource && (
            <div className="flex items-center justify-between gap-2">
              <label className="text-[13px] text-slate-600 dark:text-zinc-300" htmlFor="cut-copies">{t('imposition.cutExport:so_to_in_so_lan_cat')}</label>
              <input
                id="cut-copies"
                type="number"
                min={1}
                value={copies}
                onChange={(e) => setCopies(Math.max(1, parseInt(e.target.value || "1", 10) || 1))}
                className="h-9 w-24 px-2 text-right rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-100"
              />
            </div>
          )}

          {useFileSource && preview?.ok && (
            <p className="text-[13px] text-slate-500 dark:text-zinc-400">
              {t('imposition.cutExport:tong')} <span className="font-semibold text-slate-700 dark:text-zinc-200">{(preview.total_items || 0) * Math.max(1, copies || 1)}</span> {t('imposition.cutExport:con')}
              {" "}{t('imposition.cutExport:con_to_x_to', { perSheet: preview.total_items, sheets: Math.max(1, copies || 1) })}
            </p>
          )}

          {/* Tùy chọn nâng cao — thu gọn */}
          <button
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-[13px] text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {advancedOpen ? t('imposition.cutExport:an_tuy_chon_nang_cao') : t('imposition.cutExport:tuy_chon_nang_cao_dinh_dang_kenh_luu')}
          </button>

          {advancedOpen && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                {t('imposition.cutExport:dinh_dang')}
                <select className={selStyle} value={emitter} onChange={(e) => setEmitter(e.target.value as Emitter)}>
                  <option value="command_stream">{t('imposition.cutExport:lenh_may_plt')}</option>
                  <option value="dxf">DXF</option>
                  <option value="pdf">PDF (CutContour)</option>
                  <option value="svg">SVG</option>
                </select>
              </label>
              <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                {t('imposition.cutExport:kenh')}
                <select className={selStyle} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                  <option value="file">{t('imposition.cutExport:luu_file')}</option>
                  <option value="tcp">{t('imposition.cutExport:gui_lan')}</option>
                </select>
              </label>
              {channel === "tcp" && (
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1 col-span-2">
                  {t('imposition.cutExport:ip_may')}
                  <input className={selStyle} value={tcpHost} onChange={(e) => setTcpHost(e.target.value)} placeholder="192.168.1.50" />
                </label>
              )}
              {channel === "file" && (
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1 col-span-2">
                  {t('imposition.cutExport:thu_muc_luu')}
                  <input className={selStyle} value={destDir} onChange={(e) => setDestDir(e.target.value)} placeholder={t('imposition.cutExport:mac_dinh')} />
                </label>
              )}
            </div>
          )}

          {batchMsg && <p className="text-[13px] text-slate-500">{batchMsg}</p>}
          {useFileSource && sentPages.length > 0 && (
            <p
              data-testid="cut-export-batch-status"
              data-sent-pages={sentPages.join(",")}
              data-pending-pages={pendingCutPages.join(",")}
              className="text-[13px] text-slate-600 dark:text-zinc-300 bg-slate-50 dark:bg-zinc-900/40 border border-slate-200 dark:border-white/10 rounded p-2"
            >
              {t('imposition.cutExport:trang_batch_da_gui_chua_gui', {
                sent: formatPageList(sentPages),
                pending: formatPageList(pendingCutPages) || "—",
              })}
            </p>
          )}
          {useFileSource && batchContinuationBlocked && (
            <p className="text-[13px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded p-2">
              {t('imposition.cutExport:lo_gui_mot_phan_da_doi_revision')}
            </p>
          )}
          {/* UIUX (audit 2026-07-27 §B-23): pre-line để dòng hướng khắc phục của formatError xuống hàng */}
          {error && <p className="text-[13px] text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded p-2 whitespace-pre-line">{error}</p>}
          {result && result.ok && (
            <p className="text-[13px] text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded p-2 break-all">
              {t('imposition.cutExport:da_gui_detail_bytes', { detail: result.detail, bytes: result.bytes_sent })}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-white/10 flex justify-end gap-2">
          <button onClick={() => { if (!sendInFlightRef.current) onClose(); }} disabled={busy} className="h-10 px-4 rounded-lg border border-slate-300 dark:border-white/20 text-slate-700 dark:text-zinc-200 text-sm font-medium hover:bg-slate-50 dark:hover:bg-white/5 disabled:opacity-50">{t('imposition.cutExport:dong')}</button>
          {useFileSource && sheetCount > 1 && (
            <button onClick={handleSendAll} disabled={busy || !canSendAll} className="h-10 px-4 rounded-lg border border-emerald-600 text-emerald-700 dark:text-emerald-400 text-sm font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-900/20 disabled:opacity-50">
              {sentPages.length > 0 && pendingCutPages.length > 0
                ? t('imposition.cutExport:gui_cac_to_con_lai', { n: pendingCutPages.length })
                : t('imposition.cutExport:gui_tat_ca_n', { n: sheetCount })}
            </button>
          )}
          <button onClick={handleSend} disabled={busy || !canSend} className="h-10 px-5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50">
            {busy ? t('imposition.cutExport:dang_gui') : (useFileSource && sheetCount > 1 ? t('imposition.cutExport:gui_to_nay') : t('imposition.cutExport:gui'))}
          </button>
        </div>
      </div>
    </div>
  );
}
