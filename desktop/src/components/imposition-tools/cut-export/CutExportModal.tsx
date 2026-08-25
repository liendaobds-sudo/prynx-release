// CutExportModal.tsx — Modal "Gửi máy bế" (spec: gui-may-be, task 12 + UX polish).
//
// UX: nhớ cấu hình (localStorage), đồng bộ tờ với viewer + chuyển tờ + gửi tất cả,
// preview rõ (backend nét đậm + khung), tùy chọn nâng cao thu gọn, ESC để đóng,
// chọn lớp cắt thủ công khi auto-dò fail.

import React, { useEffect, useRef, useState } from "react";
import {
  listCutProfiles,
  listCutPages,
  cutExport,
  cutExportFromFile,
  cutPreviewFromFile,
  type CutProfileInfo,
  type CutExportRequest,
  type CutExportFromFileRequest,
  type CutExportResult,
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
  const didAutoRef = useRef<boolean>(false);
  const [profiles, setProfiles] = useState<CutProfileInfo[]>([]);
  const [profileId, setProfileId] = useState<string>(saved.current.profileId || "");
  const [emitter, setEmitter] = useState<Emitter>(saved.current.emitter || "command_stream");
  const [channel, setChannel] = useState<Channel>(saved.current.channel || "file");
  const [tcpHost, setTcpHost] = useState<string>(saved.current.tcpHost || "");
  const [tcpPort, setTcpPort] = useState<number>(9100);
  const [destDir, setDestDir] = useState<string>(saved.current.destDir || "");
  const [pageIdx, setPageIdx] = useState<number>(0);
  const [cutPages, setCutPages] = useState<number[]>([]);
  const [preview, setPreview] = useState<CutPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [forceLayer, setForceLayer] = useState<string>("");
  const [copies, setCopies] = useState<number>(1);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [result, setResult] = useState<CutExportResult | null>(null);
  const [error, setError] = useState<string>("");
  const [batchMsg, setBatchMsg] = useState<string>("");

  const useFileSource = !!sourcePdfPath;

  // Số "tờ" hiển thị = số TRANG KHUÔN (bỏ trang in). Nếu chưa quét được → fallback num_pages.
  const hasCutPages = cutPages.length > 0;
  const sheetCount = hasCutPages ? cutPages.length : (preview?.num_pages || 1);
  const cutPos = hasCutPages ? Math.max(0, cutPages.indexOf(pageIdx)) : pageIdx;

  const goToSheet = (pos: number) => {
    if (hasCutPages) {
      const c = Math.min(cutPages.length - 1, Math.max(0, pos));
      setPageIdx(cutPages[c]);
    } else {
      setPageIdx(Math.min(sheetCount - 1, Math.max(0, pos)));
    }
  };

  // Tải profile + quét trang khuôn khi mở.
  useEffect(() => {
    if (!open) return;
    didAutoRef.current = false; // mở lại → cho phép tự dò trang khuôn một lần
    const viewerIdx = currentPage && currentPage > 0 ? currentPage - 1 : 0;
    setPageIdx(viewerIdx);
    setCutPages([]);
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
    // Quét toàn file → chỉ giữ các trang khuôn (có đường cắt), bỏ trang in.
    if (sourcePdfPath) {
      listCutPages(sourcePdfPath)
        .then((pages) => {
          if (pages.length > 0) {
            setCutPages(pages);
            const start = pages.includes(viewerIdx) ? viewerIdx : pages[0];
            setPageIdx(start);
            didAutoRef.current = true; // đã chốt trang khuôn → bỏ qua auto_page scan
          }
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- LINT (audit 2026-08-24 LO140): t chỉ định dạng lỗi; đổi ngôn ngữ không được reset modal rồi quét lại profile/trang khuôn.
  }, [open, currentPage, sourcePdfPath]);

  // Đóng bằng ESC.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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

  // Xem trước theo tờ + lớp. Lần đầu mở: tự dò trang khuôn (auto_page).
  useEffect(() => {
    if (!open || !sourcePdfPath) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const useAuto = !didAutoRef.current && !forceLayer;
    setPreviewing(true);
    cutPreviewFromFile(sourcePdfPath, pageIdx, forceLayer || undefined, useAuto)
      .then((p) => {
        if (cancelled) return;
        if (useAuto) {
          didAutoRef.current = true;
          // Backend chốt trang khuôn → đồng bộ thanh chuyển tờ.
          if (p.ok && typeof p.page_idx === "number" && p.page_idx !== pageIdx) {
            setPageIdx(p.page_idx); // re-render: lần sau auto đã tắt, fetch đúng trang
            return;
          }
        }
        setPreview(p);
      })
      .catch((e: unknown) => !cancelled && setPreview({ ok: false, error: String(e) }))
      .finally(() => !cancelled && setPreviewing(false));
    return () => {
      cancelled = true;
    };
  }, [open, sourcePdfPath, pageIdx, forceLayer]);

  if (!open) return null;

  const totalItems = paths.filter((p) => p.length >= 2).length;
  const canSend = !!profileId && (useFileSource ? true : totalItems > 0);

  const previewSvg = preview?.svg
    ? preview.svg
        .replace(/(<svg[^>]*?)\s+width="[^"]*"/, "$1")
        .replace(/(<svg[^>]*?)\s+height="[^"]*"/, "$1")
    : "";

  function fileReqFor(page: number, nameSuffix = ""): CutExportFromFileRequest {
    const req: CutExportFromFileRequest = {
      path: sourcePdfPath as string,
      profile_id: profileId,
      page_idx: page,
      emitter_kind: emitter,
      transport_kind: channel,
      name: (defaultName || "cut") + nameSuffix,
      force_layer: forceLayer || undefined,
      copies: Math.max(1, copies || 1),
    };
    if (channel === "tcp") req.tcp_host = tcpHost;
    if (channel === "tcp" && tcpPort) req.tcp_port = tcpPort;
    if (channel === "file" && destDir) req.dest_dir = destDir;
    return req;
  }

  const handleSend = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    setBatchMsg("");
    try {
      let r: CutExportResult;
      if (useFileSource) {
        r = await cutExportFromFile(fileReqFor(pageIdx, `_t${cutPos + 1}`));
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
    } catch (e: unknown) {
      // UIUX (audit 2026-07-27 §B-23): không đổ String(e) thô ra giao diện
      setError(formatError(e, t('imposition.cutExport:khong_gui_duoc_lenh_cat', 'Không gửi được lệnh cắt')));
    } finally {
      setBusy(false);
    }
  };

  const handleSendAll = async () => {
    if (!useFileSource) return;
    setBusy(true);
    setError("");
    setResult(null);
    let okCount = 0;
    let firstErr = "";
    const pagesToSend = hasCutPages ? cutPages : Array.from({ length: sheetCount }, (_, i) => i);
    const total = pagesToSend.length;
    for (let k = 0; k < total; k++) {
      const p = pagesToSend[k];
      setBatchMsg(t('imposition.cutExport:dang_gui_to_k_total', { k: k + 1, total }));
      try {
        const r = await cutExportFromFile(fileReqFor(p, `_t${k + 1}`));
        if (r.ok) okCount += 1;
        else if (!firstErr) firstErr = r.error || r.detail || t('imposition.cutExport:to_k_loi', { k: k + 1 });
      } catch (e: unknown) {
        // UIUX (audit 2026-07-27 §B-23): không đổ String(e) thô ra giao diện
        if (!firstErr) firstErr = formatError(e, t('imposition.cutExport:khong_gui_duoc_lenh_cat', 'Không gửi được lệnh cắt'));
      }
    }
    setBatchMsg(t('imposition.cutExport:xong_ok_total_to', { ok: okCount, total }));
    if (firstErr) setError(firstErr);
    setBusy(false);
  };

  const selStyle =
    "h-9 px-2 rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-100";

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800 dark:text-white">{t('imposition.cutExport:gui_may_be')}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-500 flex items-center justify-center" title={t('imposition.cutExport:dong_esc')}>✕</button>
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
          {/* UIUX (audit 2026-07-27 §B-23): pre-line để dòng hướng khắc phục của formatError xuống hàng */}
          {error && <p className="text-[13px] text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded p-2 whitespace-pre-line">{error}</p>}
          {result && result.ok && (
            <p className="text-[13px] text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded p-2 break-all">
              {t('imposition.cutExport:da_gui_detail_bytes', { detail: result.detail, bytes: result.bytes_sent })}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-white/10 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-10 px-4 rounded-lg border border-slate-300 dark:border-white/20 text-slate-700 dark:text-zinc-200 text-sm font-medium hover:bg-slate-50 dark:hover:bg-white/5 disabled:opacity-50">{t('imposition.cutExport:dong')}</button>
          {useFileSource && sheetCount > 1 && (
            <button onClick={handleSendAll} disabled={busy || !canSend} className="h-10 px-4 rounded-lg border border-emerald-600 text-emerald-700 dark:text-emerald-400 text-sm font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-900/20 disabled:opacity-50">
              {t('imposition.cutExport:gui_tat_ca_n', { n: sheetCount })}
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
