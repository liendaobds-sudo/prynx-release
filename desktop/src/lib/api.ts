import i18n, { tv } from '../i18n';
import { fetchLocalFileBuffer } from './localFileTransport';
// UIUX (audit 2026-07-27 §D-16): i18nT = t() dùng được ở module non-component, có chuỗi
// mặc định tiếng Việt nên KHÔNG cần thêm key vào vi.json (thiếu key → dùng default).
const i18nT = (key: string, defaultValue: string, opts?: Record<string, unknown>) =>
  i18n.t(key, { defaultValue, ...(opts || {}) });
/**
 * API client for the PDF Inspection backend (Python sidecar).
 * 
 * SECURITY: All requests include license credentials via getLicenseHeaders().
 * The backend verifies these before processing any request.
 */
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8321';

// Cache trạng thái "endpoint /upload/local không khả dụng" (sidecar cũ hoặc backend
// DEV_MODE tách rời tắt path-upload). Lần đầu gặp 403/404/405 → nhớ lại để các lần
// upload sau bỏ qua thẳng, không gửi request chắc-chắn-fail (browser log 403 mỗi lần).
let _localUploadUnavailable = false;

type TauriCoreInvoker = Pick<typeof import('@tauri-apps/api/core'), 'invoke'>;

export function formatApiErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string') return detail || fallback;
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((item): string[] => {
      if (typeof item === 'string') return item ? [item] : [];
      if (item && typeof item === 'object' && 'msg' in item) {
        const message = (item as { msg?: unknown }).msg;
        return message === undefined || message === null || message === ''
          ? []
          : [String(message)];
      }
      return [];
    });
    return messages.join(', ') || fallback;
  }
  if (detail && typeof detail === 'object') {
    try {
      return JSON.stringify(detail) || fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export const getApiUrl = () => `${API_BASE}/api`;


/**
 * Get license credential headers for authenticated API calls.
 * 
 * SECURITY: The sidecar secret and signature are handled inside Rust.
 * JS receives only a short-lived timestamp + HMAC, never the shared secret.
 * Rust also gates signing on license validation — if license isn't
 * validated in Rust cache, it refuses to sign.
 */
// Cache the Tauri module to avoid repeated dynamic imports.
let _cachedTauriCore: TauriCoreInvoker | null = null;
let _tauriAvailable: boolean | null = null;

async function getLicenseHeaders(url: string, method = 'GET'): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const { useAuthStore } = await import('../stores/useAuthStore');
    // SEC (feedback 2026-08-15 §UP.403): chụp key + token cùng một thời điểm để
    // header, cache native và chữ ký HMAC luôn thuộc cùng một phiên license.
    const authState = useAuthStore.getState();
    const licenseKey = authState.licenseKey || '';
    headers['X-License-Key'] = licenseKey;
    // Token ngắn hạn do server ký — sidecar verify bằng public key (chống client tự phong hợp lệ).
    const licenseToken = authState.licenseToken || '';
    if (licenseToken) headers['X-License-Token'] = licenseToken;
    
    // Quick check: skip Tauri IPC if not in Tauri environment
    if (_tauriAvailable === false) return headers;
    
    // VECTOR #13: Use captured invoke from main.tsx (immune to ES module patches)
    if (!_cachedTauriCore) {
      try {
        const capturedInvoke = window.__PRYNX_INVOKE__;
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
    
    
    // Sign request (must be per-request due to timestamp)
    const urlPath = new URL(url).pathname;
    try {
      const signedHeaders = await invoke('sign_api_request', {
        urlPath,
        licenseKey,
        licenseToken,
        method,
      }) as Record<string, string>;
      Object.assign(headers, signedHeaders);
    } catch (signErr) {
      // sign_api_request fail thường do cache Rust hết hạn hoặc token vừa được làm mới
      // nhưng cache native còn giữ binding cũ → re-register rồi thử lại đúng một lần.
      // Nếu vẫn fail thì trả headers thiếu chữ ký → request sẽ bị 403 rõ ràng.
      console.debug('[API] Rust signing failed, attempting re-register:', signErr);
      try {
        if (licenseKey) {
          // Re-register key trong Rust cache
          await invoke('register_validated_key', { licenseKey, token: licenseToken });
          // Thử ký lại
          const retryHeaders = await invoke('sign_api_request', {
            urlPath,
            licenseKey,
            licenseToken,
            method,
          }) as Record<string, string>;
          Object.assign(headers, retryHeaders);
        }
      } catch (retryErr) {
        console.debug('[API] Rust signing retry also failed:', retryErr);
      }
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
  const licenseHeaders = await getLicenseHeaders(url, init?.method || 'GET');
  const mergedHeaders = new Headers(init?.headers as HeadersInit | undefined);
  for (const [name, value] of Object.entries(licenseHeaders)) mergedHeaders.set(name, value);
  return fetch(url, { ...init, headers: mergedHeaders });
}

// ─────────────────────────────────────────────────────────────────────────────
// Global fetch interceptor — TỰ ĐỘNG ký MỌI request tới backend sidecar.
//
// Lý do: nhiều nơi trong app gọi backend bằng `fetch` TRẦN (vd usePdfLoader fallback
// /imposition/pdf-meta, pdfImposer, LayerPanel...) → ở bản release (DEV_MODE=false,
// bắt buộc chữ ký sidecar) sẽ bị 403 nếu gọi fetch thô. Thay vì sửa từng call
// site (dễ sót), interceptor tự đính bộ header ký cho mọi request tới backend
// (qua getLicenseHeaders → Rust sign).
// An toàn: chỉ chạm URL backend; lỗi gì cũng fallback fetch gốc; không ký 2 lần.
// ─────────────────────────────────────────────────────────────────────────────
let _backendFetchPatched = false;
export function installBackendFetchAuth(): void {
  if (_backendFetchPatched || typeof window === 'undefined' || !window.fetch) return;
  _backendFetchPatched = true;
  const origFetch = window.fetch.bind(window);
  const backendOrigins = new Set(
    [API_BASE, 'http://localhost:8321', 'http://127.0.0.1:8321'].map((value) => new URL(value).origin),
  );
  const isBackendUrl = (u: string): boolean => {
    try {
      return backendOrigins.has(new URL(u).origin);
    } catch {
      return false;
    }
  };


  // NET (audit 2026-07-29): hot-reload/sidecar restart ngắt socket khoảng một giây.
  // Chỉ retry request đọc an toàn; tuyệt đối không lặp POST tạo file/job.
  const SAFE_RETRY_POST_PATHS = new Set([
    '/api/imposition/pdf-text',
    '/api/imposition/pdf-meta',
    // NET (audit 2026-08-20): preview chỉ tính toán và trả JSON, không tạo
    // file/job. Cho phép gửi lại khi sidecar vừa khởi động hoặc đổi worker.
    '/api/imposition/preview-layout',
  ]);
  const RETRY_DELAYS_MS = [150, 350, 700];
  // Preview và health thường là request đầu tiên ngay sau khi mở công cụ.
  // Sidecar có thể cần vài giây để sẵn sàng, nên cho hai endpoint idempotent
  // này một cửa sổ hồi phục dài hơn; các API khác vẫn giữ độ trễ cũ.
  const SIDECAR_RECOVERY_PATHS = new Set([
    '/api/imposition/preview-layout',
    '/health',
  ]);
  const SIDECAR_RECOVERY_DELAYS_MS = [150, 350, 700, 1200, 2000];


  const canRetryBackendRequest = (request: Request): boolean => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    return method === 'POST' && SAFE_RETRY_POST_PATHS.has(new URL(request.url).pathname);
  };

  const fetchBackend = async (request: Request): Promise<Response> => {
    const canRetry = canRetryBackendRequest(request);
    const retryDelays = SIDECAR_RECOVERY_PATHS.has(new URL(request.url).pathname)
      ? SIDECAR_RECOVERY_DELAYS_MS
      : RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await origFetch(request.clone());
      } catch (error) {
        const aborted =
          request.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError');
        if (!canRetry || aborted || attempt >= retryDelays.length) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      }
    }
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      let url = '';
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof (input as Request).url === 'string') url = (input as Request).url;

      if (isBackendUrl(url)) {
        if (input instanceof Request) {
          // Build the effective request first so method/body/header overrides in `init`
          // are preserved and the HMAC is bound to the method actually sent.
          const outgoing = new Request(input, init);
          if (!outgoing.headers.has('X-PrynX-Signature')) {
            const auth = await getLicenseHeaders(url, outgoing.method);
            const merged = new Headers(outgoing.headers);
            for (const k in auth) merged.set(k, auth[k]);
            return fetchBackend(new Request(outgoing, { headers: merged }));
          }
          return fetchBackend(outgoing);
        } else {
          const merged = new Headers((init?.headers as HeadersInit) || undefined);
          // SEC (audit 2026-07-26 F10): khong cho caller tu dat header auth. Xoa moi
          // X-License-*/X-Hardware-Id/X-PrynX-* roi moi dinh header native da ky (ghi de
          // vo dieu kien) — chan ca meo preset X-PrynX-Signature de bo ky.
          for (const k of [...merged.keys()]) {
            const lk = k.toLowerCase();
            if (lk.startsWith('x-license-') || lk.startsWith('x-prynx-') || lk === 'x-hardware-id') {
              merged.delete(k);
            }
          }
          const auth = await getLicenseHeaders(url, init?.method || 'GET');
          for (const k in auth) merged.set(k, auth[k]);
          return fetchBackend(new Request(url, { ...init, headers: merged }));
        }
      }
    } catch {
      // Chỉ lỗi chuẩn bị/ký mới tới đây; Promise transport được return nên không fallback unsigned.
    }
    return origFetch(input, init);
  };
}


export async function prepareFileForUpload(file: File): Promise<File | Blob> {
  // CRITICAL BUGFIX: Tauri SystemIntegrations creates fake File objects with 0 bytes of blob data (file.size is spoofed).
  // If the file is actually a fake blob but has a physical path, we MUST read it from disk before uploading.
  if (file.path) {
      // Đọc lại bytes từ đĩa khi blob RỖNG dù file có path. Hai trường hợp:
      //  - Tauri fake File: file.size bị spoof (>0) nhưng slice ra 0 byte.
      //  - File edit-commit: new File([], name) → file.size THẬT = 0 nhưng path có nội dung.
      // Trước đây gate `file.size > 0` bỏ sót case edit-commit (size=0) → upload NGUYÊN
      // File 0 byte → backend ghi file rỗng → PDFium "Data format error" khi mở lại.
      const blobIsEmpty = file.size === 0 || file.slice(0, 1).size === 0;
      if (blobIsEmpty) {
          // FILEIO (audit 2026-07-28 §FL.01): protocol Rust đọc được ổ D/USB/NAS mà
          // không serialize cả file qua IPC và không phụ thuộc scope của asset/plugin-fs.
          try {
              const fileData = await fetchLocalFileBuffer(file.path);
              if (fileData.byteLength === 0) throw new Error('File trên đĩa đang rỗng');
              const realBlob = new Blob([fileData], { type: file.type || 'application/pdf' });
              Object.defineProperty(realBlob, 'name', { value: file.name });
              Object.defineProperty(realBlob, 'path', { value: file.path });
              return realBlob;
          } catch (e) {
              console.error('Không đọc được fake File từ đường dẫn cục bộ', e);
              // Không được gửi tiếp `file`: blob thật của nó rỗng dù `.size` có thể đã bị
              // gắn giả. Dừng tại đây để backend không nhận một PDF 0 byte khó chẩn đoán.
              throw new Error(`Không đọc được file gốc trên đĩa. File có thể đã bị di chuyển hoặc không còn quyền truy cập: ${file.name}`);
          }
      }
  }
  return file;
}

export async function uploadPDF(file: File, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();

  // Desktop sidecar can register a local path directly. This avoids materializing
  // a 100-500 MB PDF as ArrayBuffer/Blob inside the WebView before processing.
  if (
    typeof window !== 'undefined' &&
    window.__TAURI_INTERNALS__ &&
    typeof file?.path === 'string' &&
    file.path &&
    !_localUploadUnavailable
  ) {
    const localRes = await authenticatedFetch(`${API_BASE}/api/upload/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: file.path }),
      signal: options.signal,
    });
    if (localRes.ok) return localRes.json();

    const localErr = await localRes.json().catch(() => ({ detail: 'Upload th\u1ea5t b\u1ea1i' }));
    const desktopEndpointUnavailable = localRes.status === 403
      && localErr?.detail === 'Ch\u1ec9 kh\u1ea3 d\u1ee5ng trong \u1ee9ng d\u1ee5ng desktop';

    // Older sidecars may not expose /upload/local. A Tauri development window
    // can also talk to a separately launched DEV_MODE backend, where the local
    // path endpoint is intentionally disabled. In both cases, safely fall back
    // to multipart bytes instead of surfacing a misleading desktop-only error.
    if (localRes.status !== 404 && localRes.status !== 405 && !desktopEndpointUnavailable) {
      const detail = localErr.detail;
      throw new Error(typeof detail === 'string' ? detail : 'Upload th\u1ea5t b\u1ea1i');
    }
    // Endpoint kh\u00f4ng kh\u1ea3 d\u1ee5ng \u1edf m\u00f4i tr\u01b0\u1eddng n\u00e0y \u2192 nh\u1edb l\u1ea1i, c\u00e1c l\u1ea7n upload sau b\u1ecf qua
    // th\u1eb3ng (kh\u00f4ng g\u1eedi request ch\u1eafc-ch\u1eafn-403 \u2192 browser th\u00f4i log network 403 l\u1eb7p l\u1ea1i).
    _localUploadUnavailable = true;
  }

  const formData = new FormData();
  
  options.signal?.throwIfAborted();
  const realFile = await prepareFileForUpload(file);
  options.signal?.throwIfAborted();
  formData.append('file', realFile, file.name);

  const res = await authenticatedFetch(`${API_BASE}/api/upload`, {
    method: 'POST',
    body: formData,
    signal: options.signal,
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
  format: 'png' | 'jpeg' | 'tiff' | 'webp';
  dpi: number;
  colorMode: 'rgb' | 'gray' | 'cmyk';
  pages?: number[] | null;
  multipageTiff?: boolean;
  jpegQuality?: number;
  baseName?: string;
  includeBleed?: boolean;
  signal?: AbortSignal;
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
      include_bleed: params.includeBleed ?? true,
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Xuất ảnh thất bại' }));
    throw new Error(typeof err.detail === 'string' ? err.detail : 'Xuất ảnh thất bại');
  }
  return res.json();
}

export interface ExportImageBatchJob {
  outputDir: string;
  format: 'png' | 'jpeg' | 'tiff' | 'webp';
  dpi: number;
  multipageTiff?: boolean;
  jpegQuality?: number;
  baseName?: string;
}

/** Xuất nhiều đầu ra trong một request; backend rollback toàn batch khi một job lỗi. */
export async function exportImagesBatch(params: {
  fileId?: string;
  filePath?: string;
  colorMode: 'rgb' | 'gray' | 'cmyk';
  pages?: number[] | null;
  includeBleed?: boolean;
  jobs: ExportImageBatchJob[];
  signal?: AbortSignal;
}): Promise<{ ok: boolean; count: number; output_dir: string; files: string[] }> {
  const res = await authenticatedFetch(`${API_BASE}/api/export/images/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: params.fileId ?? null,
      file_path: params.filePath ?? null,
      color_mode: params.colorMode,
      pages: params.pages ?? null,
      include_bleed: params.includeBleed ?? true,
      jobs: params.jobs.map(job => ({
        output_dir: job.outputDir,
        format: job.format,
        dpi: job.dpi,
        multipage_tiff: job.multipageTiff ?? false,
        jpeg_quality: job.jpegQuality ?? 90,
        base_name: job.baseName ?? null,
      })),
    }),
    signal: params.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Xuất batch ảnh thất bại' }));
    throw new Error(typeof err.detail === 'string' ? err.detail : 'Xuất batch ảnh thất bại');
  }
  return res.json();
}

export async function createCompareJob(data: {
  file_a_id: string;
  file_b_id: string;
  comparison_mode?: string;
  page_matching_mode?: 'auto' | 'sequential' | 'imposition';
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
      page_matching_mode: data.page_matching_mode || 'auto',
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
  if (!res.ok) throw new Error(tv('Không thể lấy trạng thái job'));
  return res.json();
}

export async function cancelCompareJob(jobId: string): Promise<{
  job_id: string;
  status: string;
  cancelled: boolean;
  message: string;
}> {
  const res = await authenticatedFetch(`${API_BASE}/api/jobs/${jobId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Không thể hủy job so sánh' }));
    throw new Error(formatApiErrorDetail(err.detail, 'Không thể hủy job so sánh'));
  }
  return res.json();
}

export async function getJobResults(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/jobs/${jobId}/results`);
  if (!res.ok) throw new Error(tv('Không thể lấy kết quả'));
  return res.json();
}

export async function getGpuStatus() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/gpu-status`);
  if (!res.ok) throw new Error(tv('Không thể lấy trạng thái hệ thống'));
  return res.json();
}

export async function installGpuPlugin() {
  const res = await authenticatedFetch(`${API_BASE}/api/system/install-gpu-plugin`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(tv('Lỗi khi tải Extension GPU'));
  return res.json();
}

export function getFileUrl(fileId: string) {
  return `${API_BASE}/api/files/${fileId}/serve`;
}

export function getResultImageUrl(path: string) {
  return `${API_BASE}${path}`;
}

// KIENTRUC (audit 2026-07-29 §A.2): đã XOÁ 4 hàm gọi `/api/system/ai/*`
// (getAiStatus / installLocalAi / pullAiModel / getPullProgress). Backend KHÔNG có
// endpoint nào khớp — grep `system/ai` trong `backend/app` trả 0 kết quả — nên mọi lời
// gọi sẽ là 404 và `!res.ok` ném lỗi. Không component nào import chúng, tức đây là code
// client chết còn lại sau khi endpoint bị bỏ. Đúng minh chứng cho lý do §A.2 tồn tại:
// hai đầu không có codegen chung nên endpoint mất đi mà client không hề biết.
// Cần lại tính năng AI cục bộ thì thêm route ở backend TRƯỚC, rồi mới thêm hàm ở đây.

export const VDP_EXECUTION_FEATURE_IDS = [
  'vdp.datamerge',
  'vdp.numbering',
  'vdp.cover_numbering',
] as const;
export type VdpExecutionFeatureId = typeof VDP_EXECUTION_FEATURE_IDS[number];

/** SEC (audit 2026-08-04 §BE.01): job VDP phải tự khai capability cụ thể để backend cưỡng chế custom grant. */
export function appendVdpExecutionFeature(formData: FormData, featureId: VdpExecutionFeatureId): void {
  formData.append('feature_id', featureId);
}

export async function startVdpJobBackend(
  pdfFile: File,
  vdpFields: readonly unknown[],
  csvData: readonly unknown[],
  featureId: VdpExecutionFeatureId,
  dataFile?: File,
  dataFileHasHeader = true,
): Promise<string> {
  const formData = new FormData();
  if (pdfFile.path) {
    formData.append('file_path', pdfFile.path);
  } else {
    formData.append('file', pdfFile);
  }
  formData.append('fields', JSON.stringify(vdpFields));
  appendVdpExecutionFeature(formData, featureId);
  
  if (dataFile) {
    const realDataFile = await prepareFileForUpload(dataFile);
    formData.append('data_file', realDataFile, dataFile.name);
    formData.append('data_format', 'csv');
    formData.append('has_header', String(dataFileHasHeader));
  } else {
    // Giữ tương thích với manual/multi-up; CSV thuần dùng file transport để
    // tránh tạo chuỗi JSON lớn ở frontend và bản sao json.loads ở backend.
    const dataBlob = new Blob([JSON.stringify(csvData)], { type: 'application/json' });
    formData.append('data_file', dataBlob, 'data.json');
  }
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
  if (!res.ok) throw new Error(tv('Không thể lấy trạng thái tiến trình VDP'));
  return res.json();
}

export async function cancelVdpJobBackend(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/vdp-cancel/${jobId}`, { method: 'POST' });
  if (!res.ok) {
    // UIUX (audit 2026-07-27 §D-10): sửa mojibake 'Kh?ng th? h?y...'
    const err = await res.json().catch(() => ({ detail: 'Không thể hủy tiến trình VDP' }));
    throw new Error(err.detail || 'Không thể hủy tiến trình VDP');
  }
  return res.json();
}

export async function downloadVdpJob(jobId: string): Promise<Blob> {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/download/${jobId}`);
  if (!res.ok) throw new Error(tv('Lỗi tải file VDP kết quả'));
  return await res.blob();
}

// UIUX (audit 2026-07-27 §D-07): onProgress nhận thêm {processed,total} (tùy chọn) để các tool
// VDP vẽ progress bar % thật thay vì chỉ một dòng text. Caller cũ chỉ đọc msg vẫn chạy nguyên.
export type VdpProgressInfo = { processed?: number; total?: number; stage: 'processing' | 'saving' | 'downloading' | 'done' };
export async function pollVdpJob(jobId: string, onProgress: (msg: string, info?: VdpProgressInfo) => void, skipDownload: boolean = false, signal?: AbortSignal): Promise<{ blob: Blob | null, path: string | null }> {
  while (true) {
      if (signal?.aborted) throw new DOMException('VDP polling aborted', 'AbortError');
      const status = await getVdpJobStatus(jobId);
      if (status.status === 'processing') {
          onProgress(i18nT('lib.api:vdp_dang_xu_ly', 'Đang xử lý dữ liệu: {{processed}} / {{total}} trang...', { processed: status.processed, total: status.total }), { processed: status.processed, total: status.total, stage: 'processing' }); // UIUX (audit 2026-07-27 §D-07/§D-16)
      } else if (status.status === 'saving') {
          onProgress(i18nT('lib.api:vdp_dang_dong_goi', 'Đang đóng gói file PDF...'), { stage: 'saving' }); // UIUX §D-16
      } else if (status.status === 'completed') {
          if (skipDownload) {
              onProgress(i18nT('lib.api:vdp_hoan_tat', 'Hoàn tất tạo file!'), { stage: 'done' }); // UIUX §D-16
              // Return a tiny dummy blob just so the File constructor doesn't fail, 
              // and the absolute path so useTileRenderer can use tile:// native loader.
              return { blob: new Blob(['dummy'], { type: 'application/pdf' }), path: status.result };
          }
          onProgress(i18nT('lib.api:vdp_dang_tai', 'Đang tải file kết quả...'), { stage: 'downloading' }); // UIUX §D-16
          return { blob: await downloadVdpJob(jobId), path: status.result };
      } else if (status.status === 'failed') {
          throw new Error(status.error);
      } else if (status.status === 'cancelled') {
          throw new DOMException('VDP job cancelled', 'AbortError');
      }
      await new Promise(r => setTimeout(r, 500));
  }
}

// ===== N-Up Backend Engine API =====

export async function startNupJobBackend(sourcePath: string, settings: unknown): Promise<string> {
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
  if (!res.ok) throw new Error(tv('Không thể lấy trạng thái tiến trình N-Up'));
  return res.json();
}

export async function cancelNupJobBackend(jobId: string) {
  const res = await authenticatedFetch(`${API_BASE}/api/imposition/nup-cancel/${jobId}`, { method: 'POST' });
  if (!res.ok) {
    // UIUX (audit 2026-07-27 §D-10): sửa mojibake 'Kh?ng th? h?y...'
    const err = await res.json().catch(() => ({ detail: 'Không thể hủy tiến trình N-Up' }));
    throw new Error(err.detail || 'Không thể hủy tiến trình N-Up');
  }
  return res.json();
}

export async function downloadNupJob(jobId: string): Promise<Blob> {
  const res = await authenticatedFetch(`${API_BASE}/api/imposition/nup-download/${jobId}`);
  if (!res.ok) throw new Error(tv('Lỗi tải file N-Up kết quả'));
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
  if (!res.ok) throw new Error(tv('Lỗi upload file lên backend'));
  const data = await res.json();
  return data.path;
}

// ===== Backend PDF Tools API (pikepdf + pypdfium2) =====

export async function backendMergePdfs(files: File[], mode: string = 'merge_files'): Promise<Blob> {
  const formData = new FormData();
  for (const file of files) {
    // FILEIO (audit 2026-08-02 §COMB.1): path-stub có size giả nhưng blob thật
    // rỗng; mọi nhánh Merge/Interleave legacy phải materialize trước khi upload.
    formData.append('files', await prepareFileForUpload(file), file.name);
  }
  formData.append('mode', mode);
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/merge`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Ghép file thất bại: ' + await res.text()); // UIUX (audit 2026-07-27 §D-13)
  return await res.blob();
}

export type BackendMergeManifestItem = {
  blank?: boolean;
  file_index?: number;
  page_index?: number;
  rotation?: number;
  width?: number;
  height?: number;
};

export type BackendMergeManifestResult = {
  blob?: Blob;
  path?: string;
  size?: number;
  filename: string;
};

export async function backendMergeManifest(files: File[], manifest: BackendMergeManifestItem[]): Promise<BackendMergeManifestResult> {
  const formData = new FormData();
  const nativePaths = files.map(file => file.path).filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (nativePaths.length === files.length) {
    formData.append('file_paths', JSON.stringify(nativePaths));
    formData.append('return_path', 'true');
  } else {
    for (const file of files) {
      formData.append('files', await prepareFileForUpload(file), file.name);
    }
  }
  formData.append('manifest', JSON.stringify(manifest));
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/merge-manifest`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Ghép file (manifest) thất bại: ' + await res.text()); // UIUX (audit 2026-07-27 §D-13)
  if (res.headers.get('content-type')?.includes('application/json')) {
    const payload = await res.json() as { path: string; filename?: string };
    return { path: payload.path, filename: payload.filename || 'Combined.pdf' };
  }
  return { blob: await res.blob(), filename: 'Combined.pdf' };
}
export type BackendMergeManifestJobStatus = {
  job_id: string;
  status: string;
  terminal: boolean;
  cancel_requested: boolean;
  progress: number;
  completed: number;
  total: number;
  completed_source_indices?: number[];
  message?: string | null;
};

export type BackendMergeManifestJobOptions = {
  signal?: AbortSignal;
  onProgress?: (status: BackendMergeManifestJobStatus) => void;
  pollIntervalMs?: number;
  mode?: 'manifest' | 'merge_files' | 'interleave';
};

function combineAbortError(message = 'Đã hủy ghép PDF.'): DOMException {
  return new DOMException(message, 'AbortError');
}

async function combineJobError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
  return new Error(typeof payload?.detail === 'string' ? payload.detail : fallback);
}

function waitForCombinePoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(combineAbortError());
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(combineAbortError());
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Job Combine dài: mixed path/upload không copy file native qua WebView, có progress + cancel. */
export async function backendMergeManifestJob(
  files: File[],
  manifest: BackendMergeManifestItem[],
  options: BackendMergeManifestJobOptions = {},
): Promise<BackendMergeManifestResult> {
  const formData = new FormData();
  const sourcePaths: Array<string | null> = [];
  for (const file of files) {
    const nativePath = typeof file.path === 'string' && file.path.length > 0 ? file.path : null;
    sourcePaths.push(nativePath);
    if (!nativePath) formData.append('files', await prepareFileForUpload(file), file.name);
  }
  formData.append('source_paths', JSON.stringify(sourcePaths));
  if (options.mode && options.mode !== 'manifest') {
    formData.append('mode', options.mode);
  } else {
    formData.append('manifest', JSON.stringify(manifest));
  }
  if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    formData.append('return_path', 'true');
  }

  let jobId = '';
  let cancelSent = false;
  const cancelJob = async () => {
    if (!jobId || cancelSent) return;
    cancelSent = true;
    await authenticatedFetch(
      `${API_BASE}/api/pdf-tools/merge-manifest/jobs/${jobId}/cancel`,
      { method: 'POST' },
    ).catch(() => undefined);
  };
  const onAbort = () => { void cancelJob(); };

  try {
    const start = await authenticatedFetch(`${API_BASE}/api/pdf-tools/merge-manifest/jobs`, {
      method: 'POST',
      body: formData,
    });
    if (!start.ok) throw await combineJobError(start, 'Không thể bắt đầu ghép PDF.');
    const started = await start.json() as { job_id?: string };
    if (!started.job_id) throw new Error('Backend không trả về mã job ghép PDF.');
    jobId = started.job_id;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      await cancelJob();
      throw combineAbortError();
    }

    while (true) {
      const statusResponse = await authenticatedFetch(
        `${API_BASE}/api/pdf-tools/merge-manifest/jobs/${jobId}`,
      );
      if (!statusResponse.ok) {
        throw await combineJobError(statusResponse, 'Không đọc được tiến độ ghép PDF.');
      }
      const status = await statusResponse.json() as BackendMergeManifestJobStatus;
      options.onProgress?.(status);
      if (options.signal?.aborted) {
        await cancelJob();
        throw combineAbortError();
      }
      if (status.terminal) {
        if (status.status === 'cancelled') throw combineAbortError(status.message || undefined);
        if (status.status !== 'completed') {
          throw new Error(status.message || 'Ghép PDF thất bại.');
        }
        break;
      }
      await waitForCombinePoll(options.pollIntervalMs ?? 250, options.signal);
    }

    const result = await authenticatedFetch(
      `${API_BASE}/api/pdf-tools/merge-manifest/jobs/${jobId}/result`,
      { signal: options.signal },
    );
    if (!result.ok) throw await combineJobError(result, 'Không tải được kết quả ghép PDF.');
    if (result.headers.get('content-type')?.includes('application/json')) {
      const payload = await result.json() as { path: string; filename?: string; size?: number };
      const size = Number(payload.size);
      return {
        path: payload.path,
        filename: payload.filename || 'Combined.pdf',
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      };
    }
    return { blob: await result.blob(), filename: 'Combined.pdf' };
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      await cancelJob();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw combineAbortError();
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Merge/Interleave dài dùng cùng lifecycle job và transport mixed zero-copy. */
export function backendMergePdfsJob(
  files: File[],
  mode: 'merge_files' | 'interleave',
  options: Omit<BackendMergeManifestJobOptions, 'mode'> = {},
): Promise<BackendMergeManifestResult> {
  return backendMergeManifestJob(files, [], { ...options, mode });
}

export interface PdfPathMetadata {
  page_count: number;
  pages?: Array<{
    width_pt: number;
    height_pt: number;
    /** MediaBox vật lý mà engine Resize thực sự xử lý. */
    media_width_pt?: number;
    media_height_pt?: number;
    rotation?: number;
  }>;
}

/** Đọc metadata nhẹ từ native path, không materialize toàn bộ PDF trong WebView. */
export async function getPdfPathMetadata(sourcePath: string): Promise<PdfPathMetadata> {
  const res = await authenticatedFetch(`${API_BASE}/api/imposition/pdf-meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sourcePath, summary_only: true }),
  });
  if (!res.ok) throw new Error('Không đọc được thông tin PDF: ' + await res.text());
  const payload = await res.json() as Partial<PdfPathMetadata>;
  if (!Number.isInteger(payload.page_count) || Number(payload.page_count) < 1) {
    throw new Error('File PDF không có trang hợp lệ.');
  }
  return {
    page_count: Number(payload.page_count),
    pages: Array.isArray(payload.pages) ? payload.pages : [],
  };
}

export interface BackendSplitPdfResult {
  kind: 'pdf' | 'zip';
  blob: Blob;
  filename: string;
}

function splitResponseFilename(disposition: string, fallback: string): string {
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = encodedName || plainName || fallback;
  if (encodedName) {
    try { candidate = decodeURIComponent(encodedName); }
    catch { candidate = encodedName; }
  }
  // Không cho header từ server biến thành đường dẫn khi đưa vào Save dialog/File.
  return candidate.split(/[\\/]/).pop()?.trim() || fallback;
}

function normalizeSplitFilenameExtension(
  filename: string,
  kind: BackendSplitPdfResult['kind'],
  fallbackBase: string,
): string {
  const extension = kind === 'zip' ? '.zip' : '.pdf';
  if (filename.toLowerCase().endsWith(extension)) return filename;
  const stem = filename.replace(/\.[^./\\]+$/u, '').trim() || `${fallbackBase}_split`;
  return `${stem}${extension}`;
}

export async function backendSplitPdf(
  file: File,
  mode: string,
  config: unknown,
  sourcePath?: string,
): Promise<BackendSplitPdfResult> {
  const formData = new FormData();
  if (sourcePath) formData.append('file_path', sourcePath);
  else formData.append('file', file);
  formData.append('mode', mode);
  formData.append('config', JSON.stringify(config));
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/split`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Tách file thất bại: ' + await res.text()); // UIUX (audit 2026-07-27 §D-13)
  const blob = await res.blob();
  const contentType = (res.headers.get('content-type') || blob.type || '').toLowerCase();
  const disposition = res.headers.get('content-disposition') || '';
  const fallbackBase = file.name.replace(/\.pdf$/i, '') || 'split';
  const headerFilename = splitResponseFilename(disposition, '');
  const signalsZip = contentType.includes('zip') || /\.zip$/i.test(headerFilename);
  const signalsPdf = contentType.includes('application/pdf');
  if (!signalsZip && !signalsPdf) {
    throw new Error('Backend Tách trả về định dạng không được hỗ trợ.');
  }
  // Fail-closed: chỉ cần một tín hiệu ZIP thì tuyệt đối không đưa Blob vào Viewer PDF.
  const kind: BackendSplitPdfResult['kind'] = signalsZip ? 'zip' : 'pdf';
  const rawFilename = splitResponseFilename(
    disposition,
    kind === 'zip' ? `${fallbackBase}_split.zip` : `${fallbackBase}_split.pdf`,
  );
  const filename = normalizeSplitFilenameExtension(rawFilename, kind, fallbackBase);
  return { kind, blob, filename };
}

export interface ResizeTransparencyInspection {
  has_transparency: boolean;
  transparent_pages: number[];
}

export async function inspectResizeTransparency(
  file: File,
  sourcePath?: string,
  signal?: AbortSignal,
): Promise<ResizeTransparencyInspection> {
  const formData = new FormData();
  if (sourcePath) {
    formData.append('file_path', sourcePath);
  } else {
    formData.append('file', await prepareFileForUpload(file), file.name);
  }
  const res = await authenticatedFetch(
    `${API_BASE}/api/pdf-tools/resize/inspect-transparency`,
    { method: 'POST', body: formData, signal },
  );
  if (!res.ok) {
    throw new Error('Không kiểm tra được vùng trong suốt: ' + await res.text());
  }
  const payload = await res.json() as Partial<ResizeTransparencyInspection>;
  const transparentPages = Array.isArray(payload.transparent_pages)
    ? payload.transparent_pages.filter(
      (page): page is number => Number.isInteger(page) && page > 0,
    )
    : [];
  return {
    has_transparency: payload.has_transparency === true && transparentPages.length > 0,
    transparent_pages: transparentPages,
  };
}

export async function backendResizePages(
  file: File, targetW: number, targetH: number, scaleMode: string, applyTo: string,
  targetDpi: number = 0, mode: string = 'auto',
  bgFillMode: string = 'white', bgFillColor: string = '#ffffff',
  sourcePath?: string,
  pageSizeMode: string = 'fixed',
  resizeByContent: boolean = false,
): Promise<Blob> {
  // PERF (audit 2026-08-01 §RT.12): mốc end-to-end để tách chuẩn bị payload,
  // chờ backend và tải response; không đổi nội dung request.
  const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
  const perfStarted = perfNow();
  const logResizePerf = (payload: Record<string, unknown>) =>
    console.info(`[ResizePerf] ${JSON.stringify(payload)}`);
  const formData = new FormData();
  const useNativeResultPath = typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  // File lớn: đọc lại bytes từ ĐĨA qua path (asset protocol) thay vì giữ blob
  // trong JS heap — tránh "Array buffer allocation failed" khi resize file nặng.
  if (sourcePath) {
    // PERF (audit 2026-08-01 §RT.10): sidecar đọc thẳng file sạch trên đĩa.
    formData.append('file_path', sourcePath);
  } else {
    const realFile = await prepareFileForUpload(file);
    formData.append('file', realFile, file.name);
  }
  formData.append('target_w', String(targetW));
  formData.append('target_h', String(targetH));
  formData.append('scale_mode', scaleMode);
  formData.append('apply_to', applyTo);
  // target_dpi > 0 bật giảm dữ liệu theo khổ mới (giống PDF Optimizer của Acrobat).
  formData.append('target_dpi', String(targetDpi));
  formData.append('mode', mode);
  formData.append('bg_fill_mode', bgFillMode);
  formData.append('bg_fill_color', bgFillColor);
  formData.append('page_size_mode', pageSizeMode);
  formData.append('resize_by_content', String(resizeByContent));
  if (useNativeResultPath) formData.append('return_path', 'true');

  const payloadReady = perfNow();
  const roundMs = (value: number) => Math.round(value * 10) / 10;
  logResizePerf({
    stage: 'api_request',
    source: sourcePath ? 'path' : 'upload',
    payloadMs: roundMs(payloadReady - perfStarted),
    inputBytes: file.size,
    targetW,
    targetH,
    scaleMode,
    bgFillMode,
    pageSizeMode,
    resizeByContent,
    targetDpi,
  });

  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/resize`, {
    method: 'POST',
    body: formData,
  });
  const headersReady = perfNow();
  if (!res.ok) throw new Error('Đổi khổ trang thất bại: ' + await res.text()); // UIUX (audit 2026-07-27 §D-13)

  const backendTimingRaw = res.headers.get('X-PrynX-Resize-Timing');
  let backendTiming: unknown = null;
  if (backendTimingRaw) {
    try { backendTiming = JSON.parse(backendTimingRaw); }
    catch { backendTiming = backendTimingRaw; }
  }
  const downloadStarted = perfNow();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (useNativeResultPath && contentType.includes('application/json')) {
    const payload = await res.json() as {
      path?: unknown;
      size?: unknown;
      timing?: unknown;
    };
    if (typeof payload.path !== 'string' || !payload.path.trim()) {
      throw new Error('Backend Resize không trả về đường dẫn file kết quả hợp lệ.');
    }
    const nativeSize = Number(payload.size);
    const blob = new Blob([], { type: 'application/pdf' });
    Object.defineProperties(blob, {
      path: { value: payload.path, configurable: true },
      nativeSize: {
        value: Number.isFinite(nativeSize) && nativeSize >= 0 ? nativeSize : 0,
        configurable: true,
      },
    });
    const finished = perfNow();
    logResizePerf({
      stage: 'api_done',
      source: sourcePath ? 'path' : 'upload',
      transport: 'native_path',
      payloadMs: roundMs(payloadReady - perfStarted),
      waitHeadersMs: roundMs(headersReady - payloadReady),
      downloadMs: roundMs(finished - downloadStarted),
      totalMs: roundMs(finished - perfStarted),
      inputBytes: file.size,
      outputBytes: Number.isFinite(nativeSize) ? nativeSize : 0,
      backend: payload.timing ?? backendTiming,
    });
    return blob;
  }
  const blob = await res.blob();
  const finished = perfNow();
  logResizePerf({
    stage: 'api_done',
    source: sourcePath ? 'path' : 'upload',
    payloadMs: roundMs(payloadReady - perfStarted),
    waitHeadersMs: roundMs(headersReady - payloadReady),
    downloadMs: roundMs(finished - downloadStarted),
    totalMs: roundMs(finished - perfStarted),
    inputBytes: file.size,
    outputBytes: blob.size,
    backend: backendTiming,
  });
  return blob;
}

export async function backendShufflePages(
  file: File,
  action: string,
  mapping: number[] = [],
  sourcePath?: string,
): Promise<Blob> {
  const formData = new FormData();
  if (sourcePath) formData.append('file_path', sourcePath);
  else formData.append('file', file);
  formData.append('action', action);
  formData.append('mapping', JSON.stringify(mapping));
  
  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/shuffle`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Xáo trộn trang thất bại: ' + await res.text()); // UIUX (audit 2026-07-27 §D-13)
  return await res.blob();
}

export async function backendTrimShift(file: File, applyTo: string, config: unknown): Promise<Blob> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('apply_to', applyTo);
  formData.append('config', JSON.stringify(config));

  const res = await authenticatedFetch(`${API_BASE}/api/pdf-tools/trim-shift`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Dịch lề xén thất bại: ' + await res.text()); // UIUX (audit 2026-07-27 §D-13)
  return await res.blob();
}

export async function getSystemFonts(): Promise<{name: string, path: string}[]> {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/fonts`);
  if (!res.ok) throw new Error(tv('Không thể lấy danh sách font'));
  const data = await res.json();
  return data.fonts;
}

// ===== VDP Upgrade: nguồn dữ liệu (xlsx / Google Sheets / csv) =====

export interface VdpDatasourceResult {
  columns: string[];
  record_count: number;
  preview_rows: Record<string, string>[];
  rows?: Record<string, string>[];   // chỉ có khi gọi với includeAllRows=true
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
  includeAllRows?: boolean;   // true → backend trả TOÀN BỘ rows (dùng cho generate)
}): Promise<VdpDatasourceResult> {
  const formData = new FormData();
  formData.append('kind', params.kind);
  if (params.file) formData.append('file', params.file);
  if (params.url) formData.append('url', params.url);
  if (params.text !== undefined) formData.append('text', params.text);
  if (params.sheet) formData.append('sheet', params.sheet);
  formData.append('has_header', String(params.hasHeader ?? true));
  if (params.includeAllRows) formData.append('include_all_rows', 'true');

  const res = await authenticatedFetch(`${API_BASE}/api/vdp/datasource`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Lỗi đọc nguồn dữ liệu' }));
    throw new Error(formatApiErrorDetail(err.detail, 'Lỗi đọc nguồn dữ liệu'));
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
  fields: readonly unknown[];
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
    throw new Error(formatApiErrorDetail(err.detail, 'Lỗi tạo bản xem trước'));
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
  fields: readonly unknown[];
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
    throw new Error(formatApiErrorDetail(err.detail, 'Lỗi kiểm tra dữ liệu'));
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
  fields?: readonly unknown[];
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
    throw new Error(formatApiErrorDetail(err.detail, 'Lỗi xuất báo cáo lỗi'));
  }

  const blob = await res.blob();
  const defaultName = params.fileName || 'vdp_error_report.csv';

  if (window.__TAURI_INTERNALS__) {
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
    throw new Error(formatApiErrorDetail(err.detail, 'Lỗi đọc danh sách sheet'));
  }
  const data = await res.json();
  return data.sheets as string[];
}
