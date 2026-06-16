// CutterMachinesPanel.tsx — Quản lý MÁY BẾ trong Preferences (spec: gui-may-be).
//
// - Liệt kê máy có sẵn + máy người dùng tạo.
// - Thêm máy mới (sao chép từ một mẫu rồi chỉnh), sửa, xóa (máy người dùng).
// - Cấu hình KẾT NỐI theo từng máy (kênh/IP/cổng/thư mục) lưu localStorage.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  listCutProfiles,
  getCutProfile,
  saveCutProfile,
  deleteCutProfile,
  type CutProfileInfo,
  type CutMachineProfile,
} from "./api";
import {
  loadAllMachineConns,
  saveMachineConn,
  DEFAULT_CONN,
  type MachineConn,
} from "./machineSettings";

const inp =
  "h-9 px-2 rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-100 text-sm w-full";

export default function CutterMachinesPanel() {
  const [profiles, setProfiles] = useState<CutProfileInfo[]>([]);
  const [conns, setConns] = useState<Record<string, MachineConn>>({});
  const [editing, setEditing] = useState<CutMachineProfile | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = () => {
    setConns(loadAllMachineConns());
    listCutProfiles().then(setProfiles).catch(() => setProfiles([]));
  };
  useEffect(reload, []);

  const updateConn = (id: string, patch: Partial<MachineConn>) => {
    setConns((prev) => {
      const next = { ...(prev[id] || DEFAULT_CONN), ...patch };
      saveMachineConn(id, next);
      return { ...prev, [id]: next };
    });
  };

  const startAdd = async () => {
    setError("");
    // Sao chép từ một mẫu có sẵn để giữ đủ trường kỹ thuật (template/pen/header...).
    const baseId = profiles[0]?.id || "generic_hpgl";
    const r = await getCutProfile(baseId);
    if (!r.ok || !r.profile) {
      setError(r.error || "Không tải được mẫu máy.");
      return;
    }
    setEditing({ ...r.profile, id: "", vendor: r.profile.vendor, model: "" });
    setIsNew(true);
  };

  const startEdit = async (id: string) => {
    setError("");
    const r = await getCutProfile(id);
    if (!r.ok || !r.profile) {
      setError(r.error || "Không tải được cấu hình máy.");
      return;
    }
    setEditing(r.profile);
    setIsNew(false);
  };

  const setField = (k: string, v: unknown) =>
    setEditing((e) => (e ? ({ ...e, [k]: v } as CutMachineProfile) : e));

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError("");
    const id = String(editing.id || "").trim();
    if (!id || !/^[a-z0-9_]+$/i.test(id)) {
      setError("Mã máy (id) chỉ gồm chữ/số/gạch dưới, không dấu cách.");
      setBusy(false);
      return;
    }
    const r = await saveCutProfile(editing);
    setBusy(false);
    if (!r.ok) {
      setError(r.error || "Lưu thất bại.");
      return;
    }
    setEditing(null);
    reload();
  };

  const remove = async (id: string) => {
    if (!confirm(`Xóa máy "${id}"?`)) return;
    const r = await deleteCutProfile(id);
    if (!r.ok) {
      setError(r.error || "Xóa thất bại.");
      return;
    }
    reload();
  };

  return (
    <div className="animate-fade-in flex flex-col h-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xl font-bold text-slate-900 dark:text-white">Kết nối Máy bế</h3>
        <button
          onClick={startAdd}
          className="h-9 px-3 rounded-lg bg-pink-600 hover:bg-pink-700 text-white text-sm font-semibold"
        >
          ➕ Thêm máy bế
        </button>
      </div>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-6 leading-relaxed shrink-0">
        Cấu hình kết nối (kênh gửi / IP / thư mục) cho từng máy. Thêm máy mới cho các dòng máy
        khác nhau (Trung Quốc, HPGL...). Khi bấm "Gửi Máy Bế", chọn máy là tự dùng cấu hình ở đây.
      </p>

      {error && (
        <p className="text-[13px] text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded p-2 mb-3">
          {error}
        </p>
      )}

      {editing && (
        <div className="mb-5 bg-pink-50/60 dark:bg-pink-900/10 border border-pink-200 dark:border-pink-800/40 rounded-xl p-5">
          <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">
            {isNew ? "Thêm máy bế mới" : `Sửa máy: ${editing.model}`}
          </h4>
          <div className="grid grid-cols-2 gap-3">
            {isNew && (
              <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                Mã máy (id)
                <input className={inp} value={String(editing.id || "")} onChange={(e) => setField("id", e.target.value)} placeholder="vd: skycut_d24" />
              </label>
            )}
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Hãng
              <input className={inp} value={String(editing.vendor || "")} onChange={(e) => setField("vendor", e.target.value)} placeholder="vd: Skycut" />
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Model
              <input className={inp} value={String(editing.model || "")} onChange={(e) => setField("model", e.target.value)} placeholder="vd: D24" />
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Định dạng (emitter)
              <select className={inp} value={String(editing.emitter || "command_stream")} onChange={(e) => setField("emitter", e.target.value)}>
                <option value="command_stream">Lệnh máy (command_stream)</option>
                <option value="vector_file">File vector (vector_file)</option>
                <option value="gcode">G-code</option>
              </select>
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Phương ngữ (dialect)
              <select className={inp} value={String(editing.dialect || "")} onChange={(e) => setField("dialect", e.target.value)}>
                <option value="">(không)</option>
                <option value="skycut_ud">skycut_ud (U/D — Yuty/Skycut)</option>
                <option value="hpgl_pupd">hpgl_pupd (PU/PD — HPGL)</option>
                <option value="gpgl">gpgl (Graphtec)</option>
              </select>
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Độ phân giải (PLU/mm)
              <input type="number" step="any" className={inp} value={Number(editing.resolution_plu_per_mm ?? 0)} onChange={(e) => setField("resolution_plu_per_mm", parseFloat(e.target.value) || 0)} />
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Gốc toạ độ
              <select className={inp} value={String(editing.origin || "bottom_left")} onChange={(e) => setField("origin", e.target.value)}>
                <option value="bottom_left">Dưới-trái</option>
                <option value="top_left">Trên-trái</option>
                <option value="blade_current">Vị trí dao hiện tại</option>
              </select>
            </label>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-[13px] text-slate-600 dark:text-zinc-300">
                <input type="checkbox" checked={!!editing.flip_y} onChange={(e) => setField("flip_y", e.target.checked)} /> Lật Y
              </label>
              <label className="flex items-center gap-2 text-[13px] text-slate-600 dark:text-zinc-300">
                <input type="checkbox" checked={!!editing.swap_xy} onChange={(e) => setField("swap_xy", e.target.checked)} /> Đổi X↔Y
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setEditing(null)} disabled={busy} className="h-9 px-4 rounded-lg border border-slate-300 dark:border-white/20 text-sm font-medium disabled:opacity-50">Hủy</button>
            <button onClick={save} disabled={busy} className="h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50">{busy ? "Đang lưu..." : "Lưu máy"}</button>
          </div>
        </div>
      )}

      <div className="space-y-4 flex-1 pr-4 overflow-y-auto custom-scrollbar pb-10">
        {profiles.length === 0 && <div className="text-sm text-slate-500 dark:text-zinc-400">Không tải được danh sách máy bế.</div>}
        {profiles.map((p) => {
          const conn = conns[p.id] || DEFAULT_CONN;
          return (
            <div key={p.id} className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200">{p.vendor} {p.model}</h4>
                  {p.builtin ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400">Có sẵn</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-900/30 text-pink-600 dark:text-pink-400">Của bạn</span>
                  )}
                </div>
                {!p.builtin && (
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(p.id)} className="text-[13px] text-indigo-600 dark:text-indigo-400 hover:underline">Sửa</button>
                    <button onClick={() => remove(p.id)} className="text-[13px] text-red-500 hover:underline">Xóa</button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                  Định dạng gửi
                  <select className={inp} value={conn.emitter} onChange={(e) => updateConn(p.id, { emitter: e.target.value as MachineConn["emitter"] })}>
                    <option value="command_stream">Lệnh máy (PLT)</option>
                    <option value="dxf">DXF</option>
                    <option value="pdf">PDF (CutContour)</option>
                    <option value="svg">SVG</option>
                  </select>
                </label>
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                  Kênh gửi
                  <select className={inp} value={conn.channel} onChange={(e) => updateConn(p.id, { channel: e.target.value as MachineConn["channel"] })}>
                    <option value="file">Lưu file</option>
                    <option value="tcp">Gửi LAN (TCP/IP)</option>
                  </select>
                </label>

                {conn.channel === "tcp" && (
                  <>
                    <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                      IP máy
                      <input className={inp} value={conn.tcpHost || ""} onChange={(e) => updateConn(p.id, { tcpHost: e.target.value })} placeholder="192.168.1.50" />
                    </label>
                    <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                      Cổng
                      <input type="number" className={inp} value={conn.tcpPort ?? 9100} onChange={(e) => updateConn(p.id, { tcpPort: parseInt(e.target.value || "9100", 10) || 9100 })} placeholder="9100" />
                    </label>
                  </>
                )}

                {conn.channel === "file" && (
                  <div className="col-span-2 flex flex-col gap-1">
                    <span className="text-[13px] text-slate-600 dark:text-zinc-300">Thư mục lưu</span>
                    <div className="flex gap-2">
                      <div className="flex-1 h-9 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded px-3 text-sm text-slate-600 dark:text-zinc-300 flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                        {conn.destDir || "(mặc định)"}
                      </div>
                      <button
                        className="h-9 px-3 rounded-lg border border-slate-300 dark:border-white/20 text-sm font-medium"
                        onClick={async () => {
                          const sel = await open({ directory: true, multiple: false, title: "Chọn thư mục lưu file bế" });
                          if (sel && typeof sel === "string") updateConn(p.id, { destDir: sel });
                        }}
                      >
                        Chọn
                      </button>
                      {conn.destDir && (
                        <button className="h-9 px-3 rounded-lg border border-red-300 text-red-500 text-sm" onClick={() => updateConn(p.id, { destDir: "" })} title="Xóa">✕</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
