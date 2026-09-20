import { invoke } from '@tauri-apps/api/core';
import { isOfficePathOrName, isPdfOrImagePath, mimeForOfficeName } from './officeFileTypes';
import { mimeForImageName } from './imageFileTypes';

// FILEIO (audit 2026-08-02 §OPEN.1/§OPEN.2, audit 2026-09-19 §BURST.72): metadata trên NAS/USB/UNC chỉ là
// thông tin hỗ trợ. Quá hạn không được chặn luồng mở file hoặc biến thành "mất file".
// Tăng lên 10s để khi mở hàng chục file cùng lúc không bị timeout giả tạo do hàng đợi bận.
export const SYSTEM_FILE_STAT_DEADLINE_MS = 10_000;

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

type WorkspaceFileMetadata = File & {
  path?: string;
  isGenerated?: boolean;
  isTempUploadPath?: boolean;
  __nativePathPending?: boolean;
};

export interface SavedSourceFileOptions extends FilePropertyBag {
  path?: string;
  size?: number;
}

/** FILEIO (audit 2026-08-26 §FILE.A4): provenance kết quả không được suy từ tên file. */
export function isGeneratedWorkspaceFile(value: unknown): value is File & { isGenerated: true } {
  return value instanceof File && (value as WorkspaceFileMetadata).isGenerated === true;
}

/** Gắn provenance cho file do công cụ sinh; configurable để vòng đời save rebase được rõ ràng. */
export function markGeneratedWorkspaceFile<T extends File>(file: T): T & { isGenerated: true } {
  if ((file as WorkspaceFileMetadata).isGenerated === true) return file as T & { isGenerated: true };
  Object.defineProperty(file, 'isGenerated', {
    value: true,
    configurable: true,
  });
  return file as T & { isGenerated: true };
}

/**
 * Tạo identity nguồn mới sau Save/đọc theo path. File mới chỉ nhận metadata vật lý,
 * không sao chép cờ generated/temp/pending từ identity làm việc trước đó.
 */
export function createSavedSourceFile(
  parts: BlobPart[],
  name: string,
  options: SavedSourceFileOptions = {},
): File {
  const { path, size, ...fileOptions } = options;
  const file = new File(parts, name, fileOptions);
  if (path) Object.defineProperty(file, 'path', { value: path, configurable: true });
  if (Number.isFinite(size) && Number(size) >= 0) {
    Object.defineProperty(file, 'size', { value: Number(size), configurable: true });
  }
  return file;
}

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

/**
 * PERF/FILEIO (audit 2026-09-19 §BURST.BATCH_STAT): Stat toàn bộ danh sách đường dẫn
 * trong 1 lời gọi IPC duy nhất, tránh nghẽn hàng đợi khi Explorer gửi hàng chục file.
 * Tự động fallback sang probe từng file nếu native trả null/lỗi (tương thích test mock & runtime cũ).
 */
export async function statNativeSystemFiles(
  paths: string[],
  deadlineMs = SYSTEM_FILE_STAT_DEADLINE_MS,
): Promise<NativeFileStatResult[]> {
  if (paths.length === 0) return [];

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<typeof STAT_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(STAT_TIMEOUT), Math.max(0, deadlineMs));
  });

  const runFallbackIndividualProbes = async (_reason: string): Promise<NativeFileStatResult[]> => {
    return Promise.all(paths.map(path => statNativeSystemFile(path, deadlineMs)));
  };

  const nativeProbe = (async (): Promise<NativeFileStatResult[]> => {
    try {
      const response = await invoke<NativeSystemFileStatPayload[]>('stat_system_files', { paths });
      if (!Array.isArray(response)) {
        return await runFallbackIndividualProbes(`invoke trả về non-array: ${typeof response}`);
      }
      return response.map(item => ({
        status: item?.status ?? 'inaccessible',
        size: item?.status === 'available' && Number.isFinite(item?.size) && item.size >= 0
          ? item.size
          : 0,
      }));
    } catch (err) {
      return await runFallbackIndividualProbes(`invoke stat_system_files ném lỗi: ${String(err)}`);
    }
  })();

  try {
    const result = await Promise.race([nativeProbe, timeout]);
    if (result === STAT_TIMEOUT) {
      return paths.map(() => ({ status: 'timeout', size: 0 }));
    }
    return result;
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
  const file = createSavedSourceFile([], name, {
    type: systemFileMime(name),
    path,
    size: stat.size,
  });
  return { file, stat };
}

export async function createPathBackedFiles(
  paths: string[],
  deadlineMs = SYSTEM_FILE_STAT_DEADLINE_MS,
): Promise<Array<{ file: File; stat: NativeFileStatResult }>> {
  if (paths.length === 0) return [];
  const stats = await statNativeSystemFiles(paths, deadlineMs);
  return paths.map((path, idx) => {
    const stat = stats[idx] ?? { status: 'inaccessible' as const, size: 0 };
    const name = path.split('\\').pop() || path.split('/').pop() || 'unknown';
    const file = createSavedSourceFile([], name, {
      type: systemFileMime(name),
      path,
      size: stat.size,
    });
    return { file, stat };
  });
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

/**
 * PERF (audit 2026-09-19 §THUMB.NATIVE_PERSIST):
 * Khi file PDF được tạo từ bộ nhớ (Combine, Resize, Preprocess), lưu nhanh xuống đĩa tạm
 * của hệ điều hành và gán thuộc tính `path`.
 * Nhờ có `file.path`:
 * 1. ThumbSidebar tự động chuyển sang Rust Native PDFium đa luồng siêu tốc thay vì dùng PDF.js trong JS thread.
 * 2. Công cụ Bù xén (StickerTool) gửi đường dẫn đĩa thay vì upload hàng chục MB qua HTTP FormData.
 */
export async function persistTempNativePdfFile(
  bytes: Uint8Array | ArrayBuffer,
  fileName: string,
): Promise<File & { path?: string }> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { tempDir, join } = await import('@tauri-apps/api/path');
      const tDir = await tempDir();
      const sanitizedName = (fileName || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpName = `prynx_cache_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${sanitizedName}`;
      const tmpPath = await join(tDir, tmpName);
      await invoke('write_file_atomic', { path: tmpPath, contents: buf });
      return createSavedSourceFile([buf as unknown as BlobPart], fileName, {
        type: 'application/pdf',
        path: tmpPath,
        size: buf.byteLength,
      });
    } catch (e) {
      console.warn('[persistTempNativePdfFile] Không ghi được file tạm xuống đĩa, fallback in-memory:', e);
    }
  }
  return new File([buf as unknown as BlobPart], fileName, { type: 'application/pdf' });
}
