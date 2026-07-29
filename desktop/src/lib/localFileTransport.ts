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

  const response = await fetch(localFileUrl(path), { headers });
  if (!response.ok) {
    throw new Error(`Không đọc được file cục bộ (HTTP ${response.status})`);
  }
  return response.arrayBuffer();
}
