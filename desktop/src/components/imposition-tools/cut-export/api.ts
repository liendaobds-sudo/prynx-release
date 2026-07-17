// api.ts — Client gọi backend cut_export (spec: gui-may-be).
// File MỚI, độc lập. Route backend: ${getApiUrl()}/imposition/cut-export (router
// cut_export đăng ký sau — task 11.2, phần chạm file có sẵn cần duyệt).

import { authenticatedFetch, getApiUrl } from "../../../lib/api";
import i18n from "../../../i18n";

export interface CutProfileInfo {
  id: string;
  vendor: string;
  model: string;
  emitter: string;
  dialect: string | null;
  reg_mode: string;
  transport_default: string;
  builtin?: boolean;
}

/** Cấu hình đầy đủ của một máy (để thêm/sửa). Để lỏng kiểu vì có nhiều trường kỹ thuật. */
export type CutMachineProfile = Record<string, unknown> & {
  id: string;
  vendor: string;
  model: string;
  emitter: string;
  resolution_plu_per_mm: number;
  dialect?: string | null;
};

export type Pt = [number, number];

export interface CutExportRequest {
  profile_id: string;
  sheet_w_mm: number;
  sheet_h_mm: number;
  paths: Pt[][];
  marks?: Pt[];
  emitter_kind?: string; // dxf | svg | pdf | command_stream
  transport_kind?: string; // file | tcp | serial
  dest_dir?: string;
  name?: string;
  tcp_host?: string;
  tcp_port?: number;
  serial_port?: string;
  serial_baud?: number;
  reg_mode?: string; // onboard_frame | manual_affine | none
  design_pts?: Pt[];
  measured_pts?: Pt[];
  pont_config?: Record<string, unknown>;
  ignore_limits?: boolean;
  copies?: number;
}

export interface CutExportResult {
  ok: boolean;
  channel?: string;
  detail?: string;
  bytes_sent?: number;
  total_items?: number;
  error?: string;
}

export interface CutConnectionTestResult {
  ok: boolean;
  host?: string;
  port?: number;
  resolved_ip?: string;
  latency_ms?: number;
  detail?: string;
  error?: string;
}

export async function testCutConnection(host: string, port: number): Promise<CutConnectionTestResult> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-connection-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, port, timeout: 3 }),
  });
  if (!res.ok) {
    return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status', { status: res.status }) };
  }
  return (await res.json()) as CutConnectionTestResult;
}

export async function listCutProfiles(): Promise<CutProfileInfo[]> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-profiles`);
  if (!res.ok) throw new Error(i18n.t('cutExport:khong_tai_duoc_danh_sach_may_be', { status: res.status }));
  const data = await res.json();
  return (data.profiles ?? []) as CutProfileInfo[];
}

export async function cutExport(req: CutExportRequest): Promise<CutExportResult> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status_text', { status: res.status, text }) };
  }
  return (await res.json()) as CutExportResult;
}

export interface CutExportFromFileRequest {
  path: string;
  profile_id: string;
  page_idx?: number;
  emitter_kind?: string;
  transport_kind?: string;
  dest_dir?: string;
  name?: string;
  tcp_host?: string;
  tcp_port?: number;
  reg_mode?: string;
  pont_config?: Record<string, unknown>;
  ignore_limits?: boolean;
  force_layer?: string;
  copies?: number;
}

export async function cutExportFromFile(
  req: CutExportFromFileRequest,
): Promise<CutExportResult> {
  const res = await authenticatedFetch(
    `${getApiUrl()}/imposition/cut-export-from-file`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status_text', { status: res.status, text }) };
  }
  return (await res.json()) as CutExportResult;
}

export interface CutLayerCandidates {
  layers: string[];
  spots: string[];
  auto_matched?: string[];
}

export interface CutPreviewResult {
  ok: boolean;
  svg?: string;
  total_items?: number;
  sheet_w_mm?: number;
  sheet_h_mm?: number;
  num_pages?: number;
  page_idx?: number;
  error?: string;
  candidates?: CutLayerCandidates;
}

export async function cutPreviewFromFile(
  path: string,
  pageIdx = 0,
  forceLayer?: string,
  autoPage = false,
): Promise<CutPreviewResult> {
  const res = await authenticatedFetch(
    `${getApiUrl()}/imposition/cut-preview-from-file`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, page_idx: pageIdx, force_layer: forceLayer, auto_page: autoPage }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status_text', { status: res.status, text }) };
  }
  return (await res.json()) as CutPreviewResult;
}

export async function listCutLayers(path: string, pageIdx = 0): Promise<CutLayerCandidates> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-layers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, page_idx: pageIdx }),
  });
  if (!res.ok) return { layers: [], spots: [] };
  const d = await res.json();
  return { layers: d.layers ?? [], spots: d.spots ?? [], auto_matched: d.auto_matched ?? [] };
}

/** Danh sách chỉ số trang KHUÔN (có đường cắt) — bỏ qua trang in. */
export async function listCutPages(path: string): Promise<number[]> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-pages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) return [];
  const d = await res.json();
  return (d.pages ?? []) as number[];
}

/** Lấy cấu hình đầy đủ của một máy (để chỉnh sửa). */
export async function getCutProfile(
  id: string,
): Promise<{ ok: boolean; profile?: CutMachineProfile; builtin?: boolean; error?: string }> {
  const res = await authenticatedFetch(
    `${getApiUrl()}/imposition/cut-profile?id=${encodeURIComponent(id)}`,
  );
  if (!res.ok) return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status', { status: res.status }) };
  return (await res.json()) as { ok: boolean; profile?: CutMachineProfile; builtin?: boolean };
}

/** Tạo mới / cập nhật một máy người dùng. */
export async function saveCutProfile(
  profile: CutMachineProfile,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-profile-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status_text', { status: res.status, text }) };
  }
  return (await res.json()) as { ok: boolean; id?: string; error?: string };
}

/** Xóa một máy người dùng (không xóa được máy có sẵn). */
export async function deleteCutProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await authenticatedFetch(`${getApiUrl()}/imposition/cut-profile-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) return { ok: false, error: i18n.t('cutExport:loi_may_chu_res_status', { status: res.status }) };
  return (await res.json()) as { ok: boolean; error?: string };
}
