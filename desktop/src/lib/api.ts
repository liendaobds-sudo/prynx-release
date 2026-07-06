/**
 * API client for the PDF Inspection backend (Python sidecar).
 * 
 * SECURITY: All requests include license credentials via getLicenseHeaders().
 * The backend verifies these before processing any request.
 */
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8321';

export const getApiUrl = () => `${API_BASE}/api`;


/**
 * Get license credential headers for authenticated API calls.
 * 
 * SECURITY: Token and signature are computed INSIDE Rust native code.
 * JS never sees the token or knows the hash algorithm.
 * Rust also gates signing on license validation — if license isn't
 * validated in Rust cache, it refuses to sign.
 */
// Cache hardware ID and Tauri module to avoid repeated IPC calls
let _cachedHwid: string | null = null;
let _cachedTauriCore: any = null;
let _tauriAvailable: boolean | null = null;

async function getLicenseHeaders(url: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const { useAuthStore } = await import('../stores/useAuthStore');
    const licenseKey = useAuthStore.getState().licenseKey || '';
    headers['X-License-Key'] = licenseKey;
    // Token ngắn hạn do server ký — sidecar verify bằng public key (chống client tự phong hợp lệ).
    const licenseToken = useAuthStore.getState().licenseToken || '';
    if (licenseToken) headers['X-License-Token'] = licenseToken;
    
    // Quick check: skip Tauri IPC if not in Tauri environment
    if (_tauriAvailable === false) return headers;
    
    // VECTOR #13: Use captured invoke from main.tsx (immune to ES module patches)
    if (!_cachedTauriCore) {
      try {
        const capturedInvoke = (window as any).__PRYNX_INVOKE__;
        if (capturedInvoke) {
          // Use the pre-captured, frozen invoke from main.tsx
          _cachedTauriCore = { invoke: capturedInvoke };
        } else {
          // Fallback to module import (dev mode / non-Tauri)
          _cachedTauriCore = await import('@tauri-apps/api/core');
        }
        _tauriAvailable = true;
      } catch {
        _tauriAvailable = false;
        return headers;
      }
    }
    
    const { invoke } = _cachedTauriCore;
    
    // Cache hardware ID (never changes during session)
    if (!_cachedHwid) {
      try {
        _cachedHwid = await invoke('get_hardware_id') as string;
      } catch {
        _tauriAvailable = false;
        return headers;
      }
    }
    headers['X-Hardware-Id'] = _cachedHwid;
    
    // Sign request (must be per-request due to timestamp)
    const urlPath = new URL(url).pathname;
    try {
      const signedHeaders = await invoke('sign_api_request', {
        urlPath,
        licenseKey,
      }) as Record<string, string>;
      Object.assign(headers, signedHeaders);
    } catch (signErr) {
      console.debug('[API] Rust signing unavailable:', signErr);
    }
  } catch (e) {
    console.debug('[API] Could not get license headers:', e);
  }
  return headers;
}

/**
 * Enhanced fetch that automatically includes license headers + Rust-signed request.
 */
export async function authenticatedFetch(url: string, init?: RequestInit): Promise<Response> {
  const licenseHeaders = await getLicenseHeaders(url);
  const mergedHeaders = {
    ...licenseHeaders,
    ...(init?.headers || {}),
  };
  return fetch(url, { ...init, headers: mergedHeaders });
}

// ─────────────────────────────────────────────────────────────────────────────
// Global fetch interceptor — TỰ ĐỘNG ký MỌI request tới backend sidecar.
//
// Lý do: nhiều nơi trong app gọi backend bằng `fetch` TRẦN (vd usePdfLoader fallback
// /imposition/pdf-meta, pdfImposer, LayerPanel...) → ở bản release (DEV_MODE=false,
// bắt buộc sidecar token) sẽ bị 403 "invalid sidecar token". Thay vì sửa từng call
// site (dễ sót), ta chặn ở 1 chỗ: bất kỳ fetch nào trỏ tới backend host mà CHƯA có
// header X-PrynX-Token thì tự đính header ký (qua getLicenseHeaders → Rust sign).
// An toàn: chỉ chạm URL backend; lỗi gì cũng fallback fetch gốc; không ký 2 lần.
// ─────────────────────────────────────────────────────────────────────────────
let _backendFetchPatched = false;
export function installBackendFetchAuth(): void {
  if (_backendFetchPatched || typeof window === 'undefined' || !window.fetch) return;
  _backendFetchPatched = true;
  const origFetch = window.fetch.bind(window);
  const isBackendUrl = (u: string): boolean =>
    !!u && (u.startsWith(API_BASE) || u.startsWith('http://localhost:8321') || u.startsWith('http://127.0.0.1:8321'));

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      let url = '';
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof (input as Request).url === 'string') url = (input as Request).url;

      if (isBackendUrl(url)) {
        if (input instanceof Request) {
          if (!input.headers.has('X-PrynX-Token')) {
            const auth = await getLicenseHeaders(url);
            const merged = new Headers(input.headers);
            for (const k in auth) if (!merged.has(k)) merged.set(k, auth[k]);
            return origFetch(new Request(input, { headers: merged }));
          }
        } else {
          const merged = new Headers((init?.headers as HeadersInit) || undefined);
          if (!merged.has('X-PrynX-Token')) {
            const auth = await getLicenseHeaders(url);
            for (const k in auth) if (!merged.has(k)) merged.set(k, auth[k]);
            return origFetch(url, { ...init, headers: merged });
          }
        }
      }
    } catch {
      /* bất kỳ lỗi nào → dùng fetch gốc, không chặn request */
    }
    return origFetch(input as any, init);
  };
}


export async function prepareFileForUpload(file: File | any): Promise<File | Blob> {
  // CRITICAL BUGFIX: Tauri SystemIntegrations creates fake File objects with 0 bytes of blob data (file.size is spoofed).
  // If the file is actually a fake blob but has a physical path, we MUST read it from disk before uploading.
  if (file.path && file.size > 0) {
      // Test if the actual blob content is empty despite the spoofed size
      const testSlice = file.slice(0, 1);
      if (testSlice.size === 0) {
          // ⚡ PERF: lấy bytes qua ASSET PROTOCOL (convertFileSrc + fetch) — KÊNH RIÊNG,
          // KHÔNG dùng kênh invoke IPC. Trước đây readFile() (plugin-fs) đọc cả file qua
          // IPC → file lớn (vd 15MB) serialize làm NGHẼN kênh IPC → invoke('get_pdf_metadata')
          // bị trễ 1.7-3.3s → spinner "Đang tải file PDF..." kéo dài. (Xem §15.10.)
          try {
              const { convertFileSrc } = await import('@tauri-apps/api/core');
              const resp = await fetch(convertFileSrc(file.path));
              if (resp.ok) {
                  const realBlob = new Blob([await resp.arrayBuffer()], { type: file.type || 'application/pdf' });
                  Object.defineProperty(realBlob, 'name', { value: file.name });
                  Object.defineProperty(realBlob, 'path', { value: file.path });
                  return realBlob;
              }
          } catch (e) {
              console.warn("asset-fetch upload prep failed, fallback readFile:", e);
          }
          try {
              const { readFile } = await import('@tauri-apps/plugin-fs');
              const fileData = await readFile(file.path);
              const realBlob = new Blob([fileData], { type: file.type || 'application/pdf' });
              // Re-inject properties to make it act like a File
              Object.defineProperty(realBlob, 'name', { value: file.name });
              Object.defineProperty(realBlob, 'path', { value: file.path });
              return realBlob;
          } catch (e) {
              console.error("Failed to read fake file object from disk", e);
              return file; // Fallback
          }
      }
  }
  return file;
}

export async function uploadPDF(file: File | any) {
  const formData = new FormData();
  
  const realFile = await prepareFileForUpload(file);
  formData.append('file', realFile, file.name);

  const res = await authenticatedFetch(`${API_BASE}/api/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Upload thất bại' }));
    let errorMsg = err.detail || 'Upload thất bại';
    if (typeof errorMsg === 'object') {
      errorMsg = Array.isArray(errorMsg) ? errorMsg.map(e => e.msg).join(', ') : JSON.stringify(errorMsg);
    }
    throw new Error(errorMsg);
  }

  return res.json();
}

/**
 * Xuất trang PDF ra ảnh (PNG/JPEG/TIFF). Backend render rồi ghi vào outputDir.
 * Truyền fileId (đã upload) hoặc filePath (file trên đĩa, desktop).
 */
export async function exportImages(params: {
  fileId?: string;
  filePath?: string;
  outputDir: string;
  format: 'png' | 'jpeg' | 'tiff';
  dpi: number;
  colorMode: 'rgb' | 'gray';
  pages?: number[] | null;
  multipageTiff?: boolean;
  jpegQuality?: number;
  baseName?: string;
}): Promise<{ ok: boolean; count: number; output_dir: string; files: string[] }> {
  const res = await authenticatedFetch(`${API_BASE}/api/export/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: params.fileId ?? null,
      file_path: params.filePath ?? null,
      output_dir: params.outputDir,
      format: params.format,
      dpi: params.dpi,
      color_mode: params.colorMode,
      pages: params.pages ?? null,
      multipage_tiff: params.multipageTiff ?? false,
      jpeg_quality: params.jpegQuality ?? 90,
      base_name: params.baseName ?? null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Xuất ảnh thất bại' }));
    throw new Error(typeof err.detail === 'string' ? err.detail : 'Xuất ảnh thất bại');
  }
  return res.json();
}

export async function createCompareJob(data: {
  file_a_id: string;
  file_b_id: string;
  comparison_mode?: string;
  is_packaging_mode?: boolean;
  tolerance?: string;
  dpi?: number;
}) {
  const res = await authenticatedFetch(`${API_BASE}/api/jobs/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_a_id: data.file_a_id,
      file_b_id: data.file_b_id,
      tolerance: data.tolerance || 'NORMAL',
      dpi: data.dpi || 150,
      comparison_mode: data.comparison_mode || 'full',
      is_packaging_mode: data.is_packaging_mode || false,
      highlight_color: '#FF0000',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Tạo job thất bại' }));
    let errorMsg = err.detail || 'Tạo job thất bại';
    if (typeof errorMsg === 'object') {
      errorMsg = Array.isArray(errorMsg) ? errorMsg.map(e => e.msg).join(', ') : JSON.stringify(errorMsg);
    }
    throw new Error(errorMsg);
  }

  return res.json();
}

export async function getJobStatus(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/jobs/${jobId}`);
  if (!res.ok) throw new Error('Không thể lấy trạng thái job');
  return res.json();
}

export async function getJobResults(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/jobs/${jobId}/results`);
  if (!res.ok) throw new Error('Không thể lấy kết quả');
  return res.json();
}

export async function getGpuStatus() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/gpu-status`);
  if (!res.ok) throw new Error('Không thể lấy trạng thái hệ thống');
  return res.json();
}

export async function installGpuPlugin() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/install-gpu-plugin`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Lỗi khi tải Extension GPU');
  return res.json();
}

export function getFileUrl(fileId: string) {
  return `${API_BASE}/api/files/${fileId}/serve`;
}

export function getResultImageUrl(path: string) {
  return `${API_BASE}${path}`;
}

export async function getAiStatus() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/ai/status`);
  if (!res.ok) throw new Error('Không thể lấy trạng thái hệ thống');
  return res.json();
}

export async function installLocalAi() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/ai/install`, { method: 'POST' });
  if (!res.ok) throw new Error('Lỗi khi cài đặt AI Local');
  return res.json();
}

export async function pullAiModel() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/ai/pull`, { method: 'POST' });
  if (!res.ok) throw new Error('Lỗi tải dữ liệu AI');
  return res.json();
}

export async function getPullProgress() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/ai/pull-progress`);
  if (!res.ok) throw new Error('Lỗi lấy tiến trình tải');
  return res.json();
}

export async function startVdpJobBackend(pdfFile: File, vdpFields: any[], csvData: any[]): Promise<string> {
  const formData = new FormData();
  if ((pdfFile as any).path) {
    formData.append('file_path', (pdfFile as any).path);
  } else {
    formData.append('file', pdfFile);
  }
  formData.append('fields', JSON.stringify(vdpFields));
  
  const dataBlob = new Blob([JSON.stringify(csvData)], { type: 'application/json' });
  formData.append('data_file', dataBlob, 'data.json');

  const res = await authenticatedFetch(`${API_BASE}/api/vdp/generate`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi bắt đầu tiến trình VDP' }));
    throw new Error(err.detail || 'Lỗi bắt đầu tiến trình VDP');
  }

  const data = await res.json();
  return data.job_id;
}

export async function getVdpJobStatus(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/status/${jobId}`);
  if (!res.ok) throw new Error('Không thể lấy trạng thái tiến trình VDP');
  return res.json();
}

export async function downloadVdpJob(jobId: string): Promise<Blob> {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/download/${jobId}`);
  if (!res.ok) throw new Error('Lỗi tải file VDP kết quả');
  return await res.blob();
}

export async function pollVdpJob(jobId: string, onProgress: (msg: string) => void, skipDownload: boolean = false, signal?: AbortSignal): Promise<{ blob: Blob | null, path: string | null }> {
  while (true) {
      if (signal?.aborted) throw new DOMException('VDP polling aborted', 'AbortError');
      const status = await getVdpJobStatus(jobId);
      if (status.status === 'processing') {
          onProgress(`Đang xử lý dữ liệu: ${status.processed} / ${status.total} trang...`);
      } else if (status.status === 'saving') {
          onProgress(`Đang đóng gói file PDF...`);
      } else if (status.status === 'completed') {
          if (skipDownload) {
              onProgress(`Hoàn tất tạo file!`);
              // Return a tiny dummy blob just so the File constructor doesn't fail, 
              // and the absolute path so useTileRenderer can use tile:// native loader.
              return { blob: new Blob(['dummy'], { type: 'application/pdf' }), path: status.result };
          }
          onProgress(`Đang tải file kết quả...`);
          return { blob: await downloadVdpJob(jobId), path: status.result };
      } else if (status.status === 'failed') {
          throw new Error(status.error);
      }
      await new Promise(r => setTimeout(r, 500));
  }
}

// ===== N-Up Backend Engine API =====

export async function startNupJobBackend(sourcePath: string, settings: any): Promise<string> {
  const res = await authenticatedFetch(`${API_BASE}/api/imposition/nup-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_path: sourcePath, settings }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi bắt đầu tiến trình N-Up' }));
    throw new Error(err.detail || 'Lỗi bắt đầu tiến trình N-Up');
  }
  const data = await res.json();
  return data.job_id;
}

export async function getNupJobStatus(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/imposition/nup-status/${jobId}`);
  if (!res.ok) throw new Error('Không thể lấy trạng thái tiến trình N-Up');
  return res.json();
}

export async function downloadNupJob(jobId: string): Promise<Blob> {
  const res = await authenticatedFetch(`${API_BASE}/api/imposition/nup-download/${jobId}`);
  if (!res.ok) throw new Error('Lỗi tải file N-Up kết quả');
  return await res.blob();
}

/** Upload a File to backend and get its server-side path */
export async function uploadFileForNup(pdfFile: File): Promise<string> {
  const formData = new FormData();
  // FIX: Tauri tạo File "giả" 0 byte (file.size bị spoof) → nếu append thẳng sẽ upload
  // file RỖNG khiến server ghi 0 byte và pdf-meta lỗi "unable to find trailer dictionary".
  // prepareFileForUpload đọc lại nội dung thật từ đĩa khi blob rỗng.
  const realFile = await prepareFileForUpload(pdfFile);
  formData.append('file', realFile, pdfFile.name);
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Lỗi upload file lên backend');
  const data = await res.json();
  return data.path;
}

// ===== Backend PDF Tools API (pikepdf + pypdfium2) =====

export async function backendMergePdfs(files: File[], mode: string = 'merge_files'): Promise<Blob> {
  const formData = new FormData();
  for (const f of files) {
    formData.append('files', f);
  }
  formData.append('mode', mode);
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/merge`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Backend merge failed: ' + await res.text());
  return await res.blob();
}

export async function backendSplitPdf(file: File, mode: string, config: any): Promise<Blob> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mode', mode);
  formData.append('config', JSON.stringify(config));
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/split`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Backend split failed: ' + await res.text());
  return await res.blob();
}

export async function backendResizePages(file: File, targetW: number, targetH: number, scaleMode: string, applyTo: string): Promise<Blob> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('target_w', String(targetW));
  formData.append('target_h', String(targetH));
  formData.append('scale_mode', scaleMode);
  formData.append('apply_to', applyTo);
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/resize`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Backend resize failed: ' + await res.text());
  return await res.blob();
}

export async function backendShufflePages(file: File, action: string, mapping: number[] = []): Promise<Blob> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('action', action);
  formData.append('mapping', JSON.stringify(mapping));
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/shuffle`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Backend shuffle failed: ' + await res.text());
  return await res.blob();
}

export async function backendTrimShift(file: File, applyTo: string, config: any): Promise<Blob> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('apply_to', applyTo);
  formData.append('config', JSON.stringify(config));

  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/trim-shift`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Backend trim-shift failed: ' + await res.text());
  return await res.blob();
}

export async function getSystemFonts(): Promise<{name: string, path: string}[]> {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/fonts`);
  if (!res.ok) throw new Error('Không thể lấy danh sách font');
  const data = await res.json();
  return data.fonts;
}

// ===== VDP Upgrade: nguồn dữ liệu (xlsx / Google Sheets / csv) =====

export interface VdpDatasourceResult {
  columns: string[];
  record_count: number;
  preview_rows: Record<string, string>[];
}

/**
 * Đọc một nguồn dữ liệu VDP qua backend (`POST /api/vdp/datasource`).
 *
 * - `kind='csv'`: truyền `file` (File .csv) hoặc `text` (nội dung dán tay).
 * - `kind='xlsx'`: truyền `file` (File .xlsx) và tuỳ chọn `sheet` để chọn sheet.
 * - `kind='gsheet'`: truyền `url` là link Google Sheets công khai.
 *
 * Lỗi đọc nguồn (DataSourceError) trả về HTTP 400 với `detail` là thông báo
 * tiếng Việt — được ném thành Error để UI hiển thị.
 */
export async function readVdpDatasource(params: {
  kind: 'csv' | 'xlsx' | 'gsheet';
  file?: File;
  url?: string;
  text?: string;
  sheet?: string;
  hasHeader?: boolean;
}): Promise<VdpDatasourceResult> {
  const formData = new FormData();
  formData.append('kind', params.kind);
  if (params.file) formData.append('file', params.file);
  if (params.url) formData.append('url', params.url);
  if (params.text !== undefined) formData.append('text', params.text);
  if (params.sheet) formData.append('sheet', params.sheet);
  formData.append('has_header', String(params.hasHeader ?? true));

  const res = await authenticatedFetch(`${API_BASE}/api/vdp/datasource`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi đọc nguồn dữ liệu' }));
    let msg = err.detail || 'Lỗi đọc nguồn dữ liệu';
    if (typeof msg === 'object') {
      msg = Array.isArray(msg) ? msg.map((e: any) => e.msg).join(', ') : JSON.stringify(msg);
    }
    throw new Error(msg);
  }
  return res.json();
}

// ===== VDP Upgrade: xem trước một record (task 14.3, Req 4.1–4.6, 4.10) =====

/** Một dấu hiệu lỗi field trong bản xem trước. `rect` theo toạ độ PIXEL ảnh PNG. */
export interface VdpFieldError {
  field: string;
  kind: 'MISSING' | 'ERR' | string;
  rect: { x: number; y: number; w: number; h: number };
  reason: string;
}

/** Kết quả `POST /api/vdp/preview` — render một record thành ảnh PNG + dấu lỗi. */
export interface VdpPreviewResult {
  image_png_base64: string | null;   // null khi nguồn rỗng
  record_index: number;              // chỉ số record (1-based) đã kẹp thực sự render
  clamped: boolean;                  // true nếu chỉ số yêu cầu nằm ngoài khoảng
  empty_source: boolean;             // true nếu nguồn 0 record
  width: number;                     // kích thước ảnh PNG (pixel)
  height: number;
  message: string;                   // thông báo tiếng Việt (đã kẹp / nguồn rỗng)
  field_errors: VdpFieldError[];
}

/**
 * Render bản xem trước record thứ N của một job VDP (`POST /api/vdp/preview`).
 *
 * Template lấy từ `template` (File) hoặc `templatePath` (đường dẫn server).
 * Nguồn dữ liệu: truyền `rows` (+ `columns`) đã nạp sẵn, HOẶC `kind`/`file`/`url`
 * để backend đọc lại nguồn (xlsx/gsheet/csv).
 *
 * `requestedIndex` là 1-based; backend tự kẹp về `[1, total]` và báo qua `clamped`.
 * Truyền `signal` để huỷ request cũ khi người dùng điều hướng nhanh (giữ UI mượt).
 */
export async function previewVdpRecord(params: {
  fields: any[];
  requestedIndex: number;
  template?: File;
  templatePath?: string;
  rows?: Record<string, string>[];
  columns?: string[];
  kind?: 'csv' | 'xlsx' | 'gsheet';
  file?: File;
  url?: string;
  text?: string;
  sheet?: string;
  hasHeader?: boolean;
  scale?: number;
  signal?: AbortSignal;
}): Promise<VdpPreviewResult> {
  const formData = new FormData();
  formData.append('fields', JSON.stringify(params.fields));
  formData.append('requested_index', String(params.requestedIndex));

  if (params.template) {
    const realFile = await prepareFileForUpload(params.template);
    formData.append('template', realFile, params.template.name);
  }
  if (params.templatePath) formData.append('template_path', params.templatePath);

  if (params.kind) formData.append('kind', params.kind);
  if (params.file) formData.append('file', params.file);
  if (params.url) formData.append('url', params.url);
  if (params.text !== undefined) formData.append('text', params.text);
  if (params.sheet) formData.append('sheet', params.sheet);
  if (params.rows) {
    const rowsBlob = new Blob([JSON.stringify(params.rows)], { type: 'application/json' });
    formData.append('rows_file', rowsBlob, 'rows.json');
  }
  if (params.columns) formData.append('columns', JSON.stringify(params.columns));
  formData.append('has_header', String(params.hasHeader ?? true));
  if (params.scale !== undefined) formData.append('scale', String(params.scale));

  const res = await authenticatedFetch(`${API_BASE}/api/vdp/preview`, {
    method: 'POST',
    body: formData,
    signal: params.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi tạo bản xem trước' }));
    let msg = err.detail || 'Lỗi tạo bản xem trước';
    if (typeof msg === 'object') {
      msg = Array.isArray(msg) ? msg.map((e: any) => e.msg).join(', ') : JSON.stringify(msg);
    }
    throw new Error(msg);
  }
  return res.json();
}

// ===== VDP Upgrade: validate trước khi sinh lô + báo cáo lỗi CSV =====
// (task 14.4, Req 4.7/4.8/5.8/5.9/5.10)

/** Trạng thái cổng (gating) quyết định việc sinh lô dựa trên kết quả validate. */
export type VdpGating = 'block' | 'needs_confirmation' | 'allow';

/** Một issue (lỗi/cảnh báo) do Validator backend trả về. */
export interface VdpIssue {
  severity: 'error' | 'warning' | string;
  record_idx: number | null;   // null = lỗi cấu hình toàn cục (không gắn record)
  field: string | null;
  reason: string;
}

/** Kết quả `POST /api/vdp/validate`. */
export interface VdpValidateResult {
  gating: VdpGating;
  issues: VdpIssue[];
}

/**
 * Kiểm tra cấu hình field + dữ liệu TRƯỚC khi sinh lô (`POST /api/vdp/validate`).
 *
 * Nguồn dữ liệu: truyền `rows` (+ `columns`) đã nạp sẵn, HOẶC `kind`/`file`/`url`/
 * `text`/`sheet` để backend đọc lại nguồn (xlsx/gsheet/csv). Backend KHÔNG sinh
 * bất kỳ artifact PDF nào (Req 5.7).
 *
 * Trả `gating` (`block`|`needs_confirmation`|`allow`) và danh sách `issues`.
 * Nguồn chưa nạp/0 record được backend coi là lỗi chặn (Req 5.8, 5.11).
 */
export async function validateVdp(params: {
  fields: any[];
  rows?: Record<string, string>[];
  columns?: string[];
  kind?: 'csv' | 'xlsx' | 'gsheet';
  file?: File;
  url?: string;
  text?: string;
  sheet?: string;
  hasHeader?: boolean;
  signal?: AbortSignal;
}): Promise<VdpValidateResult> {
  const formData = new FormData();
  formData.append('fields', JSON.stringify(params.fields));
  if (params.kind) formData.append('kind', params.kind);
  if (params.file) formData.append('file', params.file);
  if (params.url) formData.append('url', params.url);
  if (params.text !== undefined) formData.append('text', params.text);
  if (params.sheet) formData.append('sheet', params.sheet);
  if (params.rows) {
    const rowsBlob = new Blob([JSON.stringify(params.rows)], { type: 'application/json' });
    formData.append('rows_file', rowsBlob, 'rows.json');
  }
  if (params.columns) formData.append('columns', JSON.stringify(params.columns));
  formData.append('has_header', String(params.hasHeader ?? true));

  const res = await authenticatedFetch(`${API_BASE}/api/vdp/validate`, {
    method: 'POST',
    body: formData,
    signal: params.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi kiểm tra dữ liệu' }));
    let msg = err.detail || 'Lỗi kiểm tra dữ liệu';
    if (typeof msg === 'object') {
      msg = Array.isArray(msg) ? msg.map((e: any) => e.msg).join(', ') : JSON.stringify(msg);
    }
    throw new Error(msg);
  }
  return res.json();
}

/**
 * Tải báo cáo lỗi CSV (`POST /api/vdp/error-report`) rồi kích hoạt lưu file.
 *
 * Truyền `issues` đã có sẵn (vd từ `validateVdp`) HOẶC `fields` + nguồn để backend
 * tính lại. Khi không có lỗi nào, backend vẫn xuất CSV cho biết "không phát hiện
 * lỗi" (Req 4.8). CSV có BOM UTF-8 để Excel mở đúng tiếng Việt có dấu.
 *
 * Lưu file theo cùng cơ chế như `saveVdpTemplate`: trong Tauri dùng hộp thoại
 * lưu file, trên web dùng anchor download.
 */
export async function downloadVdpErrorReport(params: {
  issues?: VdpIssue[];
  fields?: any[];
  rows?: Record<string, string>[];
  columns?: string[];
  kind?: 'csv' | 'xlsx' | 'gsheet';
  file?: File;
  url?: string;
  text?: string;
  sheet?: string;
  hasHeader?: boolean;
  fileName?: string;
}): Promise<void> {
  const formData = new FormData();
  if (params.issues) {
    const issuesBlob = new Blob([JSON.stringify(params.issues)], { type: 'application/json' });
    formData.append('issues_file', issuesBlob, 'issues.json');
  }
  if (params.fields) formData.append('fields', JSON.stringify(params.fields));
  if (params.kind) formData.append('kind', params.kind);
  if (params.file) formData.append('file', params.file);
  if (params.url) formData.append('url', params.url);
  if (params.text !== undefined) formData.append('text', params.text);
  if (params.sheet) formData.append('sheet', params.sheet);
  if (params.rows) {
    const rowsBlob = new Blob([JSON.stringify(params.rows)], { type: 'application/json' });
    formData.append('rows_file', rowsBlob, 'rows.json');
  }
  if (params.columns) formData.append('columns', JSON.stringify(params.columns));
  formData.append('has_header', String(params.hasHeader ?? true));

  const res = await authenticatedFetch(`${API_BASE}/api/vdp/error-report`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi xuất báo cáo lỗi' }));
    let msg = err.detail || 'Lỗi xuất báo cáo lỗi';
    if (typeof msg === 'object') {
      msg = Array.isArray(msg) ? msg.map((e: any) => e.msg).join(', ') : JSON.stringify(msg);
    }
    throw new Error(msg);
  }

  const blob = await res.blob();
  const defaultName = params.fileName || 'vdp_error_report.csv';

  if ((window as any).__TAURI_INTERNALS__) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      title: 'Lưu báo cáo lỗi VDP',
    });
    if (path) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(path, bytes);
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
}

/** Liệt kê tên các sheet của một file Excel `.xlsx` (`POST /api/vdp/datasource/sheets`). */
export async function listVdpSheets(file: File): Promise<string[]> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/datasource/sheets`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi đọc danh sách sheet' }));
    let msg = err.detail || 'Lỗi đọc danh sách sheet';
    if (typeof msg === 'object') {
      msg = Array.isArray(msg) ? msg.map((e: any) => e.msg).join(', ') : JSON.stringify(msg);
    }
    throw new Error(msg);
  }
  const data = await res.json();
  return data.sheets as string[];
}
