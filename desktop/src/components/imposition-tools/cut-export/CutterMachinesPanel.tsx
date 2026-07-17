// CutterMachinesPanel.tsx — Quản lý MÁY BẾ trong Preferences (spec: gui-may-be).
//
// - Liệt kê máy có sẵn + máy người dùng tạo.
// - Thêm máy mới (sao chép từ một mẫu rồi chỉnh), sửa, xóa (máy người dùng).
// - Cấu hình KẾT NỐI theo từng máy (kênh/IP/cổng/thư mục) lưu localStorage.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "../../ui/confirmDialog";
import {
  listCutProfiles,
  getCutProfile,
  saveCutProfile,
  deleteCutProfile,
  testCutConnection,
  type CutProfileInfo,
  type CutMachineProfile,
} from "./api";
import {
  loadAllMachineConns,
  saveMachineConn,
  DEFAULT_CONN,
  type MachineConn,
} from "./machineSettings";
import { useTranslation } from 'react-i18next';

const inp =
  "h-9 px-2 rounded border border-slate-300 dark:border-white/20 bg-white dark:bg-zinc-900 text-slate-800 dark:text-zinc-100 text-sm w-full";

export default function CutterMachinesPanel() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<CutProfileInfo[]>([]);
  const [conns, setConns] = useState<Record<string, MachineConn>>({});
  const [editing, setEditing] = useState<CutMachineProfile | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testingId, setTestingId] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [guideOpen, setGuideOpen] = useState(false);

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

  const testConnection = async (id: string, conn: MachineConn) => {
    const host = String(conn.tcpHost || "").trim();
    const port = Number(conn.tcpPort ?? 9100);
    setTestingId(id);
    setConnectionStatus((prev) => ({ ...prev, [id]: { ok: false, message: t('imposition.cutterMachines:dang_kiem_tra') } }));
    try {
      const r = await testCutConnection(host, port);
      const message = r.ok
        ? t('imposition.cutterMachines:mo_duoc_cong_tcp', { ip: r.resolved_ip || host, port, ms: r.latency_ms ?? 0 })
        : (r.error || t('imposition.cutterMachines:khong_ket_noi_duoc'));
      setConnectionStatus((prev) => ({ ...prev, [id]: { ok: r.ok, message } }));
    } catch (e) {
      setConnectionStatus((prev) => ({ ...prev, [id]: { ok: false, message: String(e) } }));
    } finally {
      setTestingId("");
    }
  };

  const startAdd = async () => {
    setError("");
    // Sao chép từ một mẫu có sẵn để giữ đủ trường kỹ thuật (template/pen/header...).
    const baseId = profiles[0]?.id || "generic_hpgl";
    const r = await getCutProfile(baseId);
    if (!r.ok || !r.profile) {
      setError(r.error || t('imposition.cutterMachines:khong_tai_duoc_mau_may'));
      return;
    }
    setEditing({ ...r.profile, id: "", vendor: r.profile.vendor, model: "" });
    setIsNew(true);
  };

  const startEdit = async (id: string) => {
    setError("");
    const r = await getCutProfile(id);
    if (!r.ok || !r.profile) {
      setError(r.error || t('imposition.cutterMachines:khong_tai_duoc_cau_hinh_may'));
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
      setError(t('imposition.cutterMachines:ma_may_id_chi_gom_chu_so_gach_duoi'));
      setBusy(false);
      return;
    }
    const r = await saveCutProfile(editing);
    setBusy(false);
    if (!r.ok) {
      setError(r.error || t('imposition.cutterMachines:luu_that_bai'));
      return;
    }
    setEditing(null);
    reload();
  };

  const remove = async (id: string) => {
    if (!(await confirmDialog({ title: t('imposition.cutterMachines:xoa_may_be'), message: t('imposition.cutterMachines:xoa_may_x', { id }), danger: true }))) return;
    const r = await deleteCutProfile(id);
    if (!r.ok) {
      setError(r.error || t('imposition.cutterMachines:xoa_that_bai'));
      return;
    }
    reload();
  };

  return (
    <div className="animate-fade-in h-full overflow-y-auto custom-scrollbar pr-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xl font-bold text-slate-900 dark:text-white">{t('imposition.cutterMachines:ket_noi_may_be')}</h3>
        <button
          onClick={startAdd}
          className="h-9 px-3 rounded-lg bg-pink-600 hover:bg-pink-700 text-white text-sm font-semibold"
        >
          {t('imposition.cutterMachines:them_may_be')}
        </button>
      </div>
      <p className="text-sm text-slate-500 dark:text-zinc-400 mb-6 leading-relaxed shrink-0">
        {t('imposition.cutterMachines:cau_hinh_ket_noi_kenh_gui_ip_thu_muc_cho_tung_may')}
      </p>

      <div className="mb-5 rounded-xl border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/60 dark:bg-indigo-950/20">
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          className="w-full px-4 py-3 flex items-center justify-between text-left text-sm font-bold text-indigo-700 dark:text-indigo-300"
        >
          <span>{t('imposition.cutterMachines:huong_dan_ket_noi_chi_tiet')}</span>
          <span aria-hidden>{guideOpen ? "▴" : "▾"}</span>
        </button>
        {guideOpen && (
          <div className="px-4 pb-4 space-y-4 text-[13px] leading-relaxed text-slate-700 dark:text-zinc-300">
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 p-3 text-amber-800 dark:text-amber-300">
              {t('imposition.cutterMachines:guide_scope_warning')}
            </div>
            <div>
              <strong>{t('imposition.cutterMachines:guide_choose_title')}</strong>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/70 dark:bg-emerald-950/20 p-3">
                  <div className="font-semibold text-emerald-700 dark:text-emerald-300">{t('imposition.cutterMachines:guide_choose_lan_title')}</div>
                  <div className="mt-1">{t('imposition.cutterMachines:guide_choose_lan_body')}</div>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-zinc-900/30 p-3">
                  <div className="font-semibold">{t('imposition.cutterMachines:guide_choose_file_title')}</div>
                  <div className="mt-1">{t('imposition.cutterMachines:guide_choose_file_body')}</div>
                </div>
              </div>
            </div>
            <ol className="list-decimal pl-5 space-y-3">
              <li><strong>{t('imposition.cutterMachines:guide_step1_title')}</strong><br />{t('imposition.cutterMachines:guide_step1_body')}</li>
              <li><strong>{t('imposition.cutterMachines:guide_step2_title')}</strong><br />{t('imposition.cutterMachines:guide_step2_body')}</li>
              <li><strong>{t('imposition.cutterMachines:guide_step3_title')}</strong><br />{t('imposition.cutterMachines:guide_step3_body')}</li>
              <li><strong>{t('imposition.cutterMachines:guide_step4_title')}</strong><br />{t('imposition.cutterMachines:guide_step4_body')}</li>
              <li><strong>{t('imposition.cutterMachines:guide_step5_title')}</strong><br />{t('imposition.cutterMachines:guide_step5_body')}</li>
            </ol>
            <div>
              <strong>{t('imposition.cutterMachines:guide_troubleshoot_title')}</strong>
              <ul className="list-disc pl-5 mt-1 space-y-1">
                <li>{t('imposition.cutterMachines:guide_timeout')}</li>
                <li>{t('imposition.cutterMachines:guide_refused')}</li>
                <li>{t('imposition.cutterMachines:guide_open_no_cut')}</li>
                <li>{t('imposition.cutterMachines:guide_usb')}</li>
              </ul>
            </div>
            <div className="rounded-lg bg-white/70 dark:bg-zinc-900/30 border border-slate-200 dark:border-white/10 p-3">
              <strong>{t('imposition.cutterMachines:guide_terms_title')}</strong><br />
              {t('imposition.cutterMachines:guide_terms_body')}
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="text-[13px] text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded p-2 mb-3">
          {error}
        </p>
      )}

      {editing && (
        <div className="mb-5 bg-pink-50/60 dark:bg-pink-900/10 border border-pink-200 dark:border-pink-800/40 rounded-xl p-5">
          <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">
            {isNew ? t('imposition.cutterMachines:them_may_be_moi') : t('imposition.cutterMachines:sua_may', { model: editing.model })}
          </h4>
          <div className="grid grid-cols-2 gap-3">
            {isNew && (
              <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                {t('imposition.cutterMachines:ma_may_id')}
                <input className={inp} value={String(editing.id || "")} onChange={(e) => setField("id", e.target.value)} placeholder="vd: skycut_d24" />
              </label>
            )}
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              {t('imposition.cutterMachines:hang')}
              <input className={inp} value={String(editing.vendor || "")} onChange={(e) => setField("vendor", e.target.value)} placeholder="vd: Skycut" />
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              Model
              <input className={inp} value={String(editing.model || "")} onChange={(e) => setField("model", e.target.value)} placeholder="vd: D24" />
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              {t('imposition.cutterMachines:dinh_dang_emitter')}
              <select className={inp} value={String(editing.emitter || "command_stream")} onChange={(e) => setField("emitter", e.target.value)}>
                <option value="command_stream">{t('imposition.cutterMachines:lenh_may_command_stream')}</option>
                <option value="vector_file">File vector (vector_file)</option>
                <option value="gcode">G-code</option>
              </select>
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              {t('imposition.cutterMachines:phuong_ngu_dialect')}
              <select className={inp} value={String(editing.dialect || "")} onChange={(e) => setField("dialect", e.target.value)}>
                <option value="">{t('imposition.cutterMachines:khong')}</option>
                <option value="skycut_ud">skycut_ud (U/D — Yuty/Skycut)</option>
                <option value="hpgl_pupd">hpgl_pupd (PU/PD — HPGL)</option>
                <option value="gpgl">gpgl (Graphtec)</option>
              </select>
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              {t('imposition.cutterMachines:do_phan_giai_plu_mm')}
              <input type="number" step="any" className={inp} value={Number(editing.resolution_plu_per_mm ?? 0)} onChange={(e) => setField("resolution_plu_per_mm", parseFloat(e.target.value) || 0)} />
            </label>
            <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
              {t('imposition.cutterMachines:goc_toa_do')}
              <select className={inp} value={String(editing.origin || "bottom_left")} onChange={(e) => setField("origin", e.target.value)}>
                <option value="bottom_left">{t('imposition.cutterMachines:duoi_trai')}</option>
                <option value="top_left">{t('imposition.cutterMachines:tren_trai')}</option>
                <option value="blade_current">{t('imposition.cutterMachines:vi_tri_dao_hien_tai')}</option>
              </select>
            </label>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-[13px] text-slate-600 dark:text-zinc-300">
                <input type="checkbox" checked={!!editing.flip_y} onChange={(e) => setField("flip_y", e.target.checked)} /> {t('imposition.cutterMachines:lat_y')}
              </label>
              <label className="flex items-center gap-2 text-[13px] text-slate-600 dark:text-zinc-300">
                <input type="checkbox" checked={!!editing.swap_xy} onChange={(e) => setField("swap_xy", e.target.checked)} /> {t('imposition.cutterMachines:doi_x_y')}
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setEditing(null)} disabled={busy} className="h-9 px-4 rounded-lg border border-slate-300 dark:border-white/20 text-sm font-medium disabled:opacity-50">{t('imposition.cutterMachines:huy')}</button>
            <button onClick={save} disabled={busy} className="h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50">{busy ? t('imposition.cutterMachines:dang_luu') : t('imposition.cutterMachines:luu_may')}</button>
          </div>
        </div>
      )}

      <div className="space-y-4 pb-10">
        {profiles.length === 0 && <div className="text-sm text-slate-500 dark:text-zinc-400">{t('imposition.cutterMachines:khong_tai_duoc_danh_sach_may_be')}</div>}
        {profiles.map((p) => {
          const conn = conns[p.id] || DEFAULT_CONN;
          return (
            <div key={p.id} className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200">{p.vendor} {p.model}</h4>
                  {p.builtin ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400">{t('imposition.cutterMachines:co_san')}</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-900/30 text-pink-600 dark:text-pink-400">{t('imposition.cutterMachines:cua_ban')}</span>
                  )}
                </div>
                {!p.builtin && (
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(p.id)} className="text-[13px] text-indigo-600 dark:text-indigo-400 hover:underline">{t('imposition.cutterMachines:sua')}</button>
                    <button onClick={() => remove(p.id)} className="text-[13px] text-red-500 hover:underline">{t('imposition.cutterMachines:xoa')}</button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                  {t('imposition.cutterMachines:dinh_dang_gui')}
                  <select className={inp} value={conn.emitter} onChange={(e) => updateConn(p.id, { emitter: e.target.value as MachineConn["emitter"] })}>
                    <option value="command_stream">{t('imposition.cutterMachines:lenh_may_plt')}</option>
                    <option value="dxf">DXF</option>
                    <option value="pdf">PDF (CutContour)</option>
                    <option value="svg">SVG</option>
                  </select>
                </label>
                <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                  {t('imposition.cutterMachines:kenh_gui')}
                  <select className={inp} value={conn.channel} onChange={(e) => updateConn(p.id, { channel: e.target.value as MachineConn["channel"] })}>
                    <option value="file">{t('imposition.cutterMachines:luu_file')}</option>
                    <option value="tcp">{t('imposition.cutterMachines:gui_lan_tcp_ip')}</option>
                  </select>
                </label>

                {conn.channel === "tcp" && (
                  <>
                    <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                      {t('imposition.cutterMachines:ip_may')}
                      <input className={inp} value={conn.tcpHost || ""} onChange={(e) => updateConn(p.id, { tcpHost: e.target.value })} placeholder="192.168.1.50" />
                    </label>
                    <label className="text-[13px] text-slate-600 dark:text-zinc-300 flex flex-col gap-1">
                      {t('imposition.cutterMachines:cong')}
                      <input type="number" className={inp} value={conn.tcpPort ?? 9100} onChange={(e) => updateConn(p.id, { tcpPort: parseInt(e.target.value || "9100", 10) || 9100 })} placeholder="9100" />
                    </label>
                    <div className="col-span-2 flex items-center gap-3">
                      <button
                        type="button"
                        disabled={testingId === p.id || !String(conn.tcpHost || "").trim()}
                        onClick={() => testConnection(p.id, conn)}
                        className="h-9 px-3 rounded-lg border border-indigo-300 text-indigo-600 dark:text-indigo-400 text-sm font-semibold disabled:opacity-40"
                      >
                        {testingId === p.id ? t('imposition.cutterMachines:dang_kiem_tra') : t('imposition.cutterMachines:kiem_tra_ket_noi')}
                      </button>
                      {connectionStatus[p.id] && (
                        <span className={`text-[12px] ${connectionStatus[p.id].ok ? "text-emerald-600" : "text-red-500"}`}>
                          {connectionStatus[p.id].message}
                        </span>
                      )}
                    </div>
                    <p className="col-span-2 text-[11px] text-slate-500 dark:text-zinc-400">
                      {t('imposition.cutterMachines:tcp_raw_luu_y')}
                    </p>
                  </>
                )}

                {conn.channel === "file" && (
                  <div className="col-span-2 flex flex-col gap-1">
                    <span className="text-[13px] text-slate-600 dark:text-zinc-300">{t('imposition.cutterMachines:thu_muc_luu')}</span>
                    <div className="flex gap-2">
                      <div className="flex-1 h-9 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded px-3 text-sm text-slate-600 dark:text-zinc-300 flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                        {conn.destDir || t('imposition.cutterMachines:mac_dinh')}
                      </div>
                      <button
                        className="h-9 px-3 rounded-lg border border-slate-300 dark:border-white/20 text-sm font-medium"
                        onClick={async () => {
                          const sel = await open({ directory: true, multiple: false, title: t('imposition.cutterMachines:chon_thu_muc_luu_file_be') });
                          if (sel && typeof sel === "string") updateConn(p.id, { destDir: sel });
                        }}
                      >
                        {t('imposition.cutterMachines:chon')}
                      </button>
                      {conn.destDir && (
                        <button className="h-9 px-3 rounded-lg border border-red-300 text-red-500 text-sm" onClick={() => updateConn(p.id, { destDir: "" })} title={t('imposition.cutterMachines:xoa')}>✕</button>
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
