/**
 * URL đọc file cục bộ qua protocol Rust của PrynX.
 *
 * Khác asset protocol, kênh này không bị giới hạn vào Documents/Downloads/Temp;
 * phía Rust tự kiểm đuôi file và chặn các vị trí nhạy cảm trước khi trả dữ liệu.
 */
export function localFileUrl(path: string): string {
  return `http://localfile.localhost/${encodeURIComponent(path)}`;
}

export interface LocalFileRange {
  start: number;
  endExclusive: number;
}

/**
 * FILEIO (audit 2026-07-28 §FL.01/§FL.04): đọc thẳng qua custom protocol để
 * không phải phát một request asset chắc chắn-403 rồi mới fallback IPC.
 */
export async function fetchLocalFileBuffer(
  path: string,
  range?: LocalFileRange,
): Promise<ArrayBuffer> {
  const headers = new Headers();
  if (range && range.endExclusive > range.start) {
    headers.set('Range', `bytes=${range.start}-${range.endExclusive - 1}`);
  }

  const url = localFileUrl(path);
  const response = await fetch(url, { headers });
  if (!response.ok) {
    console.warn(`[fetchLocalFileBuffer] HTTP error ${response.status} cho file ${path}`);
    throw new Error(`Không đọc được file cục bộ (HTTP ${response.status})`);
  }
  return await response.arrayBuffer();
}

/**
 * Phân giải URL nạp font cho @font-face:
 * - Ưu tiên fontDataUrl (base64 data URL): hoạt động 100% không phụ thuộc mạng/giao thức.
 * - Trong Tauri: qua localFileUrl (custom URI scheme).
 * - Trong môi trường web dev: qua FastAPI sidecar http://127.0.0.1:8321/api/vdp/font-file.
 */
export function resolveFontUrl(fontFile?: string, fontDataUrl?: string): string | null {
  if (fontDataUrl) return fontDataUrl;
  if (!fontFile) return null;
  const isTauri = typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (isTauri) {
    return localFileUrl(fontFile);
  }
  const apiBase = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || 'http://localhost:8321';
  return `${apiBase}/api/vdp/font-file?path=${encodeURIComponent(fontFile)}`;
}


