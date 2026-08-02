import { invoke } from '@tauri-apps/api/core';
import { isOfficePathOrName, isPdfOrImagePath, mimeForOfficeName } from './officeFileTypes';
import { mimeForImageName } from './imageFileTypes';

// FILEIO (audit 2026-08-02 §OPEN.1/§OPEN.2): metadata trên NAS/USB/UNC chỉ là
// thông tin hỗ trợ. Quá hạn không được chặn luồng mở file hoặc biến thành "mất file".
export const SYSTEM_FILE_STAT_DEADLINE_MS = 1_500;

export type NativeFileStatStatus = 'available' | 'missing' | 'timeout' | 'inaccessible';

export interface NativeFileStatResult {
  status: NativeFileStatStatus;
  size: number;
}

interface NativeSystemFileStatPayload {
  status: 'available' | 'missing' | 'inaccessible';
  size: number;
}

const STAT_TIMEOUT = Symbol('system-file-stat-timeout');

export async function statNativeSystemFile(
  path: string,
  deadlineMs = SYSTEM_FILE_STAT_DEADLINE_MS,
): Promise<NativeFileStatResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<typeof STAT_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(STAT_TIMEOUT), Math.max(0, deadlineMs));
  });
  // Bắt reject ngay trên promise gốc để callback native trả muộn sau deadline không
  // tạo rejection rơi tự do và cũng không thể ghi đè kết quả timeout đã trả cho UI.
  const nativeProbe = invoke<NativeSystemFileStatPayload>('stat_system_file', { path })
    .catch((): NativeSystemFileStatPayload => ({ status: 'inaccessible', size: 0 }));

  try {
    const result = await Promise.race([nativeProbe, timeout]);
    if (result === STAT_TIMEOUT) return { status: 'timeout', size: 0 };
    return {
      status: result.status,
      size: result.status === 'available' && Number.isFinite(result.size) && result.size >= 0
        ? result.size
        : 0,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function systemFileMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  const imageMime = mimeForImageName(lower);
  if (imageMime) return imageMime;
  if (isOfficePathOrName(name)) return mimeForOfficeName(name);
  return 'application/octet-stream';
}

export async function createPathBackedFile(
  path: string,
  deadlineMs = SYSTEM_FILE_STAT_DEADLINE_MS,
): Promise<{ file: File; stat: NativeFileStatResult }> {
  const name = path.split('\\').pop() || path.split('/').pop() || 'unknown';
  const stat = await statNativeSystemFile(path, deadlineMs);
  const file = new File([], name, { type: systemFileMime(name) });
  Object.defineProperty(file, 'path', { value: path });
  Object.defineProperty(file, 'size', { value: stat.size });
  return { file, stat };
}

export function dispatchSupportedSystemFiles(files: readonly File[], action = ''): number {
  const supported = files.filter(file => (
    isPdfOrImagePath(file.name) || isOfficePathOrName(file.name)
  ));
  if (supported.length > 0) {
    window.dispatchEvent(new CustomEvent('system-files-received', {
      detail: { files: supported, action },
    }));
  }
  return supported.length;
}
