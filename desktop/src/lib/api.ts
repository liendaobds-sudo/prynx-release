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


export async function prepareFileForUpload(file: File | any): Promise<File | Blob> {
  // CRITICAL BUGFIX: Tauri SystemIntegrations creates fake File objects with 0 bytes of blob data (file.size is spoofed).
  // If the file is actually a fake blob but has a physical path, we MUST read it from disk before uploading.
  if (file.path && file.size > 0) {
      // Test if the actual blob content is empty despite the spoofed size
      const testSlice = file.slice(0, 1);
      if (testSlice.size === 0) {
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

export async function createCompareJob(data: {
  file_a_id: string;
  file_b_id: string;
  comparison_mode?: string;
  is_packaging_mode?: boolean;
  llm_mode?: string;
  llm_api_key?: string;
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
      llm_mode: data.llm_mode || 'off',
      llm_api_key: data.llm_api_key || '',
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
  formData.append('file', pdfFile);
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

export async function getSystemFonts(): Promise<{name: string, path: string}[]> {
  const res = await authenticatedFetch(`${API_BASE}/api/vdp/fonts`);
  if (!res.ok) throw new Error('Không thể lấy danh sách font');
  const data = await res.json();
  return data.fonts;
}
