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
      .catch((e: unknown) => setError(String(e)));
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
      if (!r.ok) setError(r.error || r.detail || "Gửi thất bại");
    } catch (e: unknown) {
      setError(String(e));
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
      setBatchMsg(`Đang gửi tờ ${k + 1}/${total}...`);
      try {
        const r = await cutExportFromFile(fileReqFor(p, `_t${k + 1}`));
        if (r.ok) okCount += 1;
        else if (!firstErr) firstErr = r.error || r.detail || `Tờ ${k + 1} lỗi`;
      } catch (e: unknown) {
        if (!firstErr) firstErr = String(e);
      }
    }
    setBatchMsg(`Xong: ${okCount}/${total} tờ.`);
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
          <h3 className="text-base font-bold text-slate-800 dark:text-white">✂️ Gửi Máy Bế</h3>
          <button onClick={onClose} className="w-7 h-7 rounded hover:bg-black/5 dark:hover:bg-white/10 text-slate-500 flex items-center justify-center" title="Đóng (Esc)">✕</button>
        </div>

        <div className="p-5 space-y-3">
          {useFileSource && (
            <p className="text-[13px] text-slate-500 dark:text-zinc-400 truncate">
              Nguồn: <span className="font-medium text-slate-700 dark:text-zinc-200">{sourceName || "(file đã bình)"}</span>
              {hasCutPages ? ` — ${sheetCount} trang khuôn` : ""}
            </p>
          )}

          {useFileSource && (
            <div className="h-[200px] rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-zinc-900/50 flex items-center justify-center overflow-hidden [&>div>svg]:max-w-full [&>div>svg]:max-h-full">
              {previewing && <span className="text-[13px] text-slate-400">Đang dựng xem trước...</span>}
              {!previewing && preview?.ok && previewSvg && (
                <div className="w-full h-full flex items-center justify-center p-2" dangerouslySetInnerHTML={{ __html: previewSvg }} />
              )}
              {!previewing && preview && !preview.ok && (
                <span className="text-[13px] text-red-500 px-3 text-center">{preview.error || "Không xem trước được"}</span>
              )}
            </div>
          )}

          {useFileSource && preview && !preview.ok && preview.candidates &&
            (preview.candidates.layers.length > 0 || preview.candidates.spots.length > 0) && (
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Chọn lớp cắt thủ công
              <select className={`${selStyle} border-amber-400`} value={forceLayer} onChange={(e) => setForceLayer(e.target.value)}>
                <option value="">— Chọn lớp / spot-color —</option>
                {preview.candidates.layers.map((l) => <option key={"L:" + l} value={l}>Lớp: {l}</option>)}
                {preview.candidates.spots.map((s) => <option key={"S:" + s} value={s}>Spot: {s}</option>)}
              </select>
            </label>
          )}

          {/* Máy + chuyển tờ — hàng chính */}
          <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
            Máy
            <select className={selStyle} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.vendor} {p.model}</option>)}
            </select>
          </label>

          {useFileSource && sheetCount > 1 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-slate-600 dark:text-zinc-300">Trang khuôn:</span>
              <div className="flex items-center gap-2">
                <button className="w-8 h-8 rounded border border-slate-300 dark:border-white/20 disabled:opacity-40" disabled={cutPos <= 0} onClick={() => goToSheet(cutPos - 1)}>‹</button>
                <span className="text-[13px] font-semibold min-w-[64px] text-center">Tờ {cutPos + 1} / {sheetCount}</span>
                <button className="w-8 h-8 rounded border border-slate-300 dark:border-white/20 disabled:opacity-40" disabled={cutPos >= sheetCount - 1} onClick={() => goToSheet(cutPos + 1)}>›</button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-slate-600 dark:text-zinc-300">Số con / tờ:</span>
            <span className="text-[13px] font-semibold">{useFileSource ? (preview?.ok ? preview.total_items : "—") : totalItems}</span>
          </div>

          {useFileSource && (
            <div className="flex items-center justify-between gap-2">
              <label className="text-[13px] text-slate-600 dark:text-zinc-300" htmlFor="cut-copies">Số tờ in (số lần cắt):</label>
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
              Tổng: <span className="font-semibold text-slate-700 dark:text-zinc-200">{(preview.total_items || 0) * Math.max(1, copies || 1)}</span> con
              {" "}({preview.total_items} con/tờ × {Math.max(1, copies || 1)} tờ)
            </p>
          )}

          {/* Tùy chọn nâng cao — thu gọn */}
          <button
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-[13px] text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {advancedOpen ? "▾ Ẩn tùy chọn nâng cao" : "▸ Tùy chọn nâng cao (định dạng, kênh, lưu)"}
          </button>

          {advancedOpen && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                Định dạng
                <select className={selStyle} value={emitter} onChange={(e) => setEmitter(e.target.value as Emitter)}>
                  <option value="command_stream">Lệnh máy (PLT)</option>
                  <option value="dxf">DXF</option>
                  <option value="pdf">PDF (CutContour)</option>
                  <option value="svg">SVG</option>
                </select>
              </label>
              <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                Kênh
                <select className={selStyle} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                  <option value="file">Lưu file</option>
                  <option value="tcp">Gửi LAN</option>
                </select>
              </label>
              {channel === "tcp" && (
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1 col-span-2">
                  IP máy
                  <input className={selStyle} value={tcpHost} onChange={(e) => setTcpHost(e.target.value)} placeholder="192.168.1.50" />
                </label>
              )}
              {channel === "file" && (
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1 col-span-2">
                  Thư mục lưu
                  <input className={selStyle} value={destDir} onChange={(e) => setDestDir(e.target.value)} placeholder="(mặc định)" />
                </label>
              )}
            </div>
          )}

          {batchMsg && <p className="text-[13px] text-slate-500">{batchMsg}</p>}
          {error && <p className="text-[13px] text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded p-2">{error}</p>}
          {result && result.ok && (
            <p className="text-[13px] text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 rounded p-2 break-all">
              Đã gửi: {result.detail} ({result.bytes_sent} bytes)
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-white/10 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-10 px-4 rounded-lg border border-slate-300 dark:border-white/20 text-slate-700 dark:text-zinc-200 text-sm font-medium hover:bg-slate-50 dark:hover:bg-white/5 disabled:opacity-50">Đóng</button>
          {useFileSource && sheetCount > 1 && (
            <button onClick={handleSendAll} disabled={busy || !canSend} className="h-10 px-4 rounded-lg border border-emerald-600 text-emerald-700 dark:text-emerald-400 text-sm font-semibold hover:bg-emerald-50 dark:hover:bg-emerald-900/20 disabled:opacity-50">
              Gửi tất cả ({sheetCount})
            </button>
          )}
          <button onClick={handleSend} disabled={busy || !canSend} className="h-10 px-5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50">
            {busy ? "Đang gửi..." : (useFileSource && sheetCount > 1 ? "Gửi tờ này" : "Gửi")}
          </button>
        </div>
      </div>
    </div>
  );
}
