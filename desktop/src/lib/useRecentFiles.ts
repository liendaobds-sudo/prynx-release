import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import {
  isGeneratedWorkspaceFile,
  statNativeSystemFile,
  type NativeFileStatResult,
} from './nativeFileAccess';

export interface RecentFile {
  path: string;
  name: string;
  size: number;
  timestamp: number;
  isStarred: boolean;
}

interface RecentFilesState {
  files: RecentFile[];
  /**
   * Đường dẫn đã xác nhận KHÔNG còn trên đĩa (stat lỗi). KHÔNG persist — mỗi lần mở
   * app kiểm lại, vì file có thể được đưa về đúng chỗ giữa hai phiên.
   *
   * UIUX (audit menu 2026-07-28 §RF.1): trước đây mỗi UI tự `stat()` riêng
   * (RecentFilesGrid, ThumbnailView, menu Mở gần đây) và không ai nhớ kết quả — cùng
   * một file mất bị stat lại nhiều lần, và chỗ này báo "Missing" thì chỗ kia vẫn hiện
   * bình thường. Nay tập trung ở đây, ai cũng đọc/ghi cùng một nguồn.
   */
  missingPaths: string[];
  addFile: (file: { path: string; name: string; size: number }) => void;
  removeFile: (path: string) => void;
  removeFiles: (paths: string[]) => void;
  toggleStar: (path: string) => void;
  clearUnstarred: () => void;
  markMissing: (path: string) => void;
  clearMissing: (path: string) => void;
}

const MAX_RECENT_FILES = 50;
const STORAGE_KEY = 'prynx-recent-files';
const RECENT_FILES_FILE = 'recent-files.json';

// ─── Native Persistent Storage & Quota Fallback ───
// STORAGE (fix 2026-09-28 QuotaExceededError):
// 1. localStorage trong WebView2 có quota cứng 5MB dùng chung toàn app. Khi các module khác
//    hoặc tab cũ tích tụ state, setItem('prynx-recent-files') ném QuotaExceededError làm crash
//    luồng mở file (App.tsx: addOpenPayloadToRecent).
// 2. Chuyển lưu danh sách gần đây ra file JSON trong AppData/recent/recent-files.json qua lệnh
//    Rust (write_file_atomic / read_dir_json) tương tự appSettingsStore. Bền qua update, không
//    tốn quota localStorage 5MB, an toàn nguyên tử.
// 3. Khi không ở native Tauri (dev/web) hoặc khi ghi fallback, safeLocalStorageSetItem bọc try-catch
//    xử lý QuotaExceededError, tự dọn các scoped key thừa và tuyệt đối không quăng ngoại lệ ra ngoài.

interface QueuedStorageWrite {
  name: string;
  value: string;
}

let tauriPath: typeof import('@tauri-apps/api/path') | null = null;
let invokeFn: (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function initTauri() {
  if (!isTauriRuntime()) return;
  if (tauriPath && invokeFn) return;
  try {
    tauriPath = await import('@tauri-apps/api/path');
    const core = await import('@tauri-apps/api/core');
    invokeFn = core.invoke as typeof invokeFn;
  } catch {
    /* Tauri không khả dụng → fallback localStorage */
  }
}

async function ensureRecentDir(): Promise<{ dir: string; file: string } | null> {
  if (!isTauriRuntime()) return null;
  await initTauri();
  if (!tauriPath) return null;
  try {
    const appData = await tauriPath.appDataDir();
    const dir = await tauriPath.join(appData, 'recent');
    try {
      const fs = await import('@tauri-apps/plugin-fs');
      await fs.mkdir(dir, { recursive: true });
    } catch {
      /* Thư mục đã tồn tại */
    }
    const file = await tauriPath.join(dir, RECENT_FILES_FILE);
    return { dir, file };
  } catch {
    return null;
  }
}

/**
 * Xóa bớt các key scoped imposer đã mồ côi nếu localStorage chạm trần 5MB.
 */
function cleanStaleLocalStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith('ps_imposer_settings:')) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* Nuốt lỗi */
  }
}

function safeLocalStorageSetItem(name: string, value: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(name, value);
  } catch (err: unknown) {
    const isQuota =
      err instanceof DOMException &&
      (err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 ||
        err.code === 1014);

    if (isQuota) {
      try {
        cleanStaleLocalStorage();
        window.localStorage.setItem(name, value);
        return;
      } catch {
        console.warn('[useRecentFiles] localStorage đã đầy quota 5MB, bỏ qua ghi để không crash app');
      }
    } else {
      console.warn('[useRecentFiles] Ghi localStorage thất bại:', err);
    }
  }
}

async function writePersistedRecentFiles({ name, value }: QueuedStorageWrite): Promise<void> {
  const paths = await ensureRecentDir();
  if (paths && invokeFn) {
    try {
      await invokeFn('write_file_atomic', {
        path: paths.file,
        contents: new TextEncoder().encode(value),
      });
      return;
    } catch (e) {
      console.warn('[useRecentFiles] write_file_atomic thất bại, fallback sang localStorage:', e);
    }
  }
  safeLocalStorageSetItem(name, value);
}

function createLatestWriteQueue(
  writer: (write: QueuedStorageWrite) => Promise<void>,
): (name: string, value: string) => Promise<void> {
  let pendingWrite: QueuedStorageWrite | null = null;
  let activeFlush: Promise<void> | null = null;
  let lastPersistedValue: string | null = null;

  return (name, value) => {
    // Nếu dữ liệu serialize không đổi (ví dụ missingPaths thay đổi nhưng files giữ nguyên),
    // không ghi lại đĩa/storage để tránh I/O và nghẽn khi probe nhiều card cùng lúc.
    if (value === lastPersistedValue) {
      return Promise.resolve();
    }
    lastPersistedValue = value;
    pendingWrite = { name, value };

    if (!activeFlush) {
      activeFlush = (async () => {
        while (pendingWrite) {
          const nextWrite = pendingWrite;
          pendingWrite = null;
          try {
            await writer(nextWrite);
          } catch (e) {
            console.warn('[useRecentFiles] Tuần tự hóa ghi storage thất bại:', e);
          }
        }
      })().finally(() => {
        activeFlush = null;
      });
    }

    return activeFlush;
  };
}

const enqueuePersistedRecentFilesWrite = createLatestWriteQueue(writePersistedRecentFiles);

const recentFilesStorage: StateStorage = {
  getItem: async (name) => {
    const paths = await ensureRecentDir();
    if (paths && invokeFn) {
      try {
        const contents = await invokeFn<string[]>('read_dir_json', { dir: paths.dir });
        if (contents && contents.length > 0) {
          return contents[0];
        }
      } catch {
        /* fall through → thử migrate từ localStorage */
      }
      // Chưa có file trên đĩa → migrate dữ liệu cũ từ localStorage
      try {
        const legacy = localStorage.getItem(name);
        if (legacy) {
          await recentFilesStorage.setItem(name, legacy);
          try {
            localStorage.removeItem(name);
          } catch {
            /* bỏ qua */
          }
          return legacy;
        }
      } catch {
        /* bỏ qua */
      }
      return null;
    }
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => enqueuePersistedRecentFilesWrite(name, value),
  removeItem: async (name) => {
    const paths = await ensureRecentDir();
    if (paths && invokeFn) {
      try {
        await invokeFn('write_file_atomic', {
          path: paths.file,
          contents: new TextEncoder().encode(JSON.stringify({ state: { files: [] }, version: 0 })),
        });
      } catch {
        /* bỏ qua */
      }
    }
    try {
      localStorage.removeItem(name);
    } catch {
      /* bỏ qua */
    }
  },
};

export const useRecentFiles = create<RecentFilesState>()(
  persist(
    (set) => ({
      files: [],
      missingPaths: [],

      addFile: (newFile) => set((state) => {
        const existingIndex = state.files.findIndex(f => f.path === newFile.path);
        let updatedFiles = [...state.files];

        if (existingIndex >= 0) {
          // If it exists, update timestamp and keep star status, then move to top
          const existing = updatedFiles[existingIndex];
          updatedFiles.splice(existingIndex, 1);
          updatedFiles.unshift({
            ...existing,
            size: newFile.size, // update size just in case it changed
            timestamp: Date.now(),
          });
        } else {
          // Add new file at top
          updatedFiles.unshift({
            path: newFile.path,
            name: newFile.name,
            size: newFile.size,
            timestamp: Date.now(),
            isStarred: false,
          });
        }

        // Enforce max size but keep all starred files
        const unstarred = updatedFiles.filter(f => !f.isStarred);
        const starred = updatedFiles.filter(f => f.isStarred);

        if (unstarred.length > MAX_RECENT_FILES) {
          const keptUnstarred = unstarred.slice(0, MAX_RECENT_FILES);
          updatedFiles = [...starred, ...keptUnstarred].sort((a, b) => b.timestamp - a.timestamp);
        }

        // Mở lại được = file đã có mặt → bỏ cờ mất.
        return {
          files: updatedFiles,
          missingPaths: state.missingPaths.filter(p => p !== newFile.path),
        };
      }),

      removeFile: (path) => set((state) => ({
        files: state.files.filter(f => f.path !== path),
        missingPaths: state.missingPaths.filter(p => p !== path),
      })),

      removeFiles: (paths) => set((state) => ({
        files: state.files.filter(f => !paths.includes(f.path)),
        missingPaths: state.missingPaths.filter(p => !paths.includes(p)),
      })),

      toggleStar: (path) => set((state) => ({
        files: state.files.map(f =>
          f.path === path ? { ...f, isStarred: !f.isStarred } : f
        )
      })),

      clearUnstarred: () => set((state) => {
        const kept = state.files.filter(f => f.isStarred);
        const keptPaths = new Set(kept.map(f => f.path));
        return {
          files: kept,
          missingPaths: state.missingPaths.filter(p => keptPaths.has(p)),
        };
      }),

      markMissing: (path) => set((state) => (
        state.missingPaths.includes(path)
          ? state
          : { missingPaths: [...state.missingPaths, path] }
      )),

      clearMissing: (path) => set((state) => (
        state.missingPaths.includes(path)
          ? { missingPaths: state.missingPaths.filter(p => p !== path) }
          : state
      )),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => recentFilesStorage),
      // CHỈ persist danh sách file. `missingPaths` là trạng thái của phiên hiện tại —
      // nếu lưu lại thì lần sau mở app file đã đưa về chỗ cũ vẫn bị đánh dấu mất.
      partialize: (state) => ({ files: state.files }) as unknown as RecentFilesState,
    }
  )
);

interface OpenPayloadWithSources {
  file?: File | null;
  officeSourceFile?: File | null;
  officeSourceFiles?: File[];
}

/** Ghi mọi file nguồn vật lý của một lần mở, gồm cả batch Office, vào Recent. */
export function addOpenPayloadToRecent(payload?: OpenPayloadWithSources | null): number {
  if (!payload) return 0;
  const candidates = [
    payload.file,
    payload.officeSourceFile,
    ...(payload.officeSourceFiles || []),
  ];
  const seenPaths = new Set<string>();
  let added = 0;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = (candidate as File & { path?: string }).path;
    if (!path || seenPaths.has(path)) continue;
    seenPaths.add(path);
    // FILEIO (audit 2026-08-26 §FILE.A4): chỉ metadata producer mới loại
    // khỏi Recent; chuỗi trong tên file khách không phải provenance.
    if ((candidate as File & { isBlank?: boolean }).isBlank || isGeneratedWorkspaceFile(candidate)) {
      continue;
    }
    try {
      useRecentFiles.getState().addFile({
        path,
        name: candidate.name,
        size: candidate.size || 0,
      });
      added += 1;
    } catch (err) {
      console.warn('[useRecentFiles] addFile thất bại (bỏ qua để không chặn mở file):', err);
    }
  }
  return added;
}

/**
 * Probe giữ nguyên trạng thái native để thumbnail không biến timeout/NAS offline
 * thành một request tile chắc chắn lỗi. Chỉ `missing` mới cập nhật cờ mất file.
 */
export async function probeRecentFile(path: string): Promise<NativeFileStatResult> {
  if (!('__TAURI_INTERNALS__' in window)) {
    return { status: 'available', size: 0 };
  }
  // FILEIO (audit 2026-08-02 §OPEN.2): plugin-fs mất scope sau restart và từ chối
  // ổ D/USB/UNC; dùng cùng contract native với Open With/Home.
  const info = await statNativeSystemFile(path);
  try {
    if (info.status === 'available') {
      useRecentFiles.getState().clearMissing(path);
      return info;
    }
    if (info.status === 'missing') {
      useRecentFiles.getState().markMissing(path);
    }
  } catch (err) {
    console.warn('[useRecentFiles] Cập nhật missing trạng thái thất bại:', err);
  }
  return info;
}

/**
 * Contract cho thao tác Mở: timeout/quyền/NAS offline vẫn được thử bằng native path
 * và không bị xóa nhầm khỏi Recent; chỉ `missing` chắc chắn mới trả `null`.
 */
export async function statRecentFile(path: string): Promise<{ size: number } | null> {
  try {
    const info = await probeRecentFile(path);
    if (info.status === 'missing') return null;
    return { size: info.status === 'available' ? info.size : 0 };
  } catch {
    return { size: 0 };
  }
}
